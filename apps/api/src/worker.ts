import 'reflect-metadata';
import { ConsoleLogger, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Queue, UnrecoverableError, Worker } from 'bullmq';
import Redis from 'ioredis';
import { ConfigError, loadConfig } from './config/config';
import { MediaJobs, VideoBusy, type MediaJob } from './media/jobs';
import { MediaError } from './media/probe';
import { MEDIA_QUEUE, jobOptions } from './media/queue';
import { createStorage } from './media/storage';
import { Billing } from './billing/billing';
import { Emitter } from '@socket.io/redis-emitter';
import { setRealtimeSink } from './realtime/publish';
import { finishLive, LiveSync } from './live/sync';
import { join } from 'node:path';

/**
 * The media worker (server 4): transcodes uploads, moves media on visibility changes, deletes removed videos and
 * writes view counts to the database every 15 seconds. Run several copies (WORKER_CONCURRENCY each) to go faster.
 */
async function main() {
  let config;
  try { config = loadConfig(); } catch (e) { if (e instanceof ConfigError) { console.error(e.message); process.exit(1); } throw e; }
  if (!config.redisUrl) { console.error('The worker needs REDIS_URL.'); process.exit(1); }
  if (config.logFormat === 'json') Logger.overrideLogger(new ConsoleLogger({ json: true }));
  const log = new Logger('Worker');
  const prisma = new PrismaClient();
  const connection = () => new Redis(config.redisUrl!, { maxRetriesPerRequest: null });
  // Instant updates from the worker (processing progress, notifications, payments) reach browsers through Redis.
  const emitter = new Emitter(new Redis(config.redisUrl));
  setRealtimeSink((r, event, data) => emitter.to(r).emit(event, data));
  // Follow-up jobs (higher qualities) go back on the queue, behind every waiting upload's first job.
  const jobs = new MediaJobs(prisma, createStorage(config), config, new Redis(config.redisUrl), async (next) => { await media.add(next.name, next, jobOptions(next)); });

  const worker = new Worker<MediaJob>(MEDIA_QUEUE, async (job, _token, signal) => {
    if (job.data.name === 'transcode' || job.data.name === 'upgrade') {
      log.log({ event: job.data.name === 'upgrade' ? 'upgrade_started' : 'transcode_started', videoId: job.data.videoId, attempt: job.attemptsMade + 1, queueWaitMs: Math.max(0, (job.processedOn ?? Date.now()) - job.timestamp) });
    }
    try { await jobs.run(job.data, job.attemptsMade + 1 >= (job.opts.attempts ?? 1), signal); }
    catch (e) {
      if (e instanceof MediaError) throw new UnrecoverableError(e.message); // a bad file: retrying will not help
      if (e instanceof VideoBusy) throw e; // retried with backoff
      throw e;
    }
  }, { connection: connection(), prefix: config.media.queuePrefix, concurrency: config.media.workerConcurrency, lockDuration: 60_000 });
  worker.on('completed', (j) => log.log(`${j.name} ${j.data.videoId} done`));
  worker.on('failed', (j, e) => log.warn(`${j?.name} ${j?.data.videoId} attempt ${j?.attemptsMade}: ${e.message}`));

  const maintenance = new Queue('maintenance', { connection: connection(), prefix: config.media.queuePrefix });
  await maintenance.upsertJobScheduler('flush-views', { every: 15_000 }, { name: 'flush-views' });
  await maintenance.upsertJobScheduler('stale-uploads', { every: 3600_000 }, { name: 'stale-uploads' });
  await maintenance.upsertJobScheduler('recover-stuck', { every: 5 * 60_000 }, { name: 'recover-stuck' });
  // Money: check pending payments every minute; end memberships and share yesterday's ad revenue every 15 minutes.
  const billing = new Billing(prisma, config);
  await maintenance.upsertJobScheduler('billing-payments', { every: 60_000 }, { name: 'billing-payments' });
  await maintenance.upsertJobScheduler('billing-daily', { every: 15 * 60_000 }, { name: 'billing-daily' });
  const media = new Queue(MEDIA_QUEUE, { connection: connection(), prefix: config.media.queuePrefix });
  const maint = new Worker('maintenance', async (job) => {
    if (job.name === 'stale-uploads') await jobs.cleanupStaleUploads();
    else if (job.name === 'billing-payments') await billing.reconcile();
    else if (job.name === 'billing-daily') { await billing.expirePremium(); const n = await billing.settleAds(); if (n) log.log(`Settled ${n} day(s) of ad revenue`); }
    else if (job.name === 'recover-stuck') {
      // A playable video that stopped before its higher qualities only needs the second job.
      for (const { id: videoId, playable } of await jobs.stuckVideos()) {
        const job = { name: playable ? 'upgrade' : 'transcode', videoId } as const;
        await media.add(job.name, job, jobOptions(job));
      }
    } else await jobs.views.flush();
  }, { connection: connection(), prefix: config.media.queuePrefix, concurrency: 1 });

  // Live from OBS and TV encoders: nginx-rtmp (on this server) writes HLS to LIVE_RTMP_HLS_DIR; copy it to storage
  // while the stream runs, and save the recording as a video when it ends.
  const liveDir = config.live.rtmpHlsDir;
  const syncs = new Map<string, LiveSync>();
  const liveStorage = createStorage(config);
  let liveBusy = false;
  const liveTimer = liveDir ? setInterval(async () => {
    if (liveBusy) return; liveBusy = true;
    try {
      const streams = await prisma.liveStream.findMany({ where: { source: 'rtmp', OR: [{ status: 'LIVE' }, { status: 'ENDED', replayVideoId: null, endedAt: { gt: new Date(Date.now() - 86_400_000) } }] } });
      for (const s of streams) {
        let sync = syncs.get(s.id);
        if (!sync) { sync = new LiveSync(liveStorage, s.id, join(liveDir, s.id)); syncs.set(s.id, sync); }
        if (s.status === 'LIVE') await sync.tick().catch((e) => log.warn(`live ${s.id}: ${(e as Error).message}`));
        else { syncs.delete(s.id); await finishLive(prisma, liveStorage, sync, async (videoId) => {
          const transcode = { name: 'transcode', videoId } as const;
          await media.add(transcode.name, transcode, jobOptions(transcode));
        }, log, config.media.ffmpegPath); }
      }
    } catch (e) { log.warn(`live: ${(e as Error).message}`); } finally { liveBusy = false; }
  }, 1500) : null;

  log.log(`Media worker running (concurrency ${config.media.workerConcurrency}, storage ${config.media.driver}, preset ${config.media.preset})`);
  const stop = async () => { log.log('Stopping…'); if (liveTimer) clearInterval(liveTimer); await Promise.allSettled([worker.close(), maint.close(), maintenance.close(), media.close()]); await prisma.$disconnect(); process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}

main().catch((e) => { console.error(e); process.exit(1); });

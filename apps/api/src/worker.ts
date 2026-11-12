import { MailService } from './mail/mail.service';
import 'reflect-metadata';
import { ConsoleLogger, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Queue, QueueEvents, UnrecoverableError, Worker, type Processor } from 'bullmq';
import { chunkQueueName, QueueChunks, runChunk, type ChunkResult, type ChunkTask } from './media/chunks';
import Redis from 'ioredis';
import { ConfigError, loadConfig } from './config/config';
import { MediaJobs, VideoBusy, type MediaJob } from './media/jobs';
import { MediaError } from './media/probe';
import { MEDIA_QUEUE, MEDIA_UPGRADE_QUEUE, jobOptions } from './media/queue';
import { createStorage } from './media/storage';
import { Billing } from './billing/billing';
import { Emitter } from '@socket.io/redis-emitter';
import { setRealtimeSink } from './realtime/publish';
import { createPushSender, setPushSender } from './push/push';
import { finishLive, LiveSync } from './live/sync';
import { join } from 'node:path';
import { verifyEncoder } from './media/encoder-health';
import { createServer } from 'node:http';
import { Counter, Histogram } from 'prom-client';
import { createRegistry, tokenMatches } from './metrics/metrics';
import { forgetFeedKeys, setFeedCacheSink } from './catalog/feed-cache';

/**
 * The media worker (server 4): transcodes uploads, moves media on visibility changes, deletes removed videos and
 * writes view counts to the database every 15 seconds. Run several copies (WORKER_CONCURRENCY each) to go faster.
 */
async function main() {
  let config;
  try { config = loadConfig(); } catch (e) { if (e instanceof ConfigError) { console.error(e.message); process.exit(1); } throw e; }
  if (!config.redisUrl) { console.error('The worker needs REDIS_URL.'); process.exit(1); }
  await verifyEncoder(config.media.ffmpegPath, config.media.encoder);
  if (config.logFormat === 'json') Logger.overrideLogger(new ConsoleLogger({ json: true }));
  const log = new Logger('Worker');
  const prisma = new PrismaClient();
  const connection = () => new Redis(config.redisUrl!, { maxRetriesPerRequest: null });
  // Instant updates from the worker (processing progress, notifications, payments) reach browsers through Redis.
  const emitter = new Emitter(new Redis(config.redisUrl));
  setRealtimeSink((r, event, data) => emitter.to(r).emit(event, data));
  // A video the worker publishes shows on the home page at once (the API's cached feeds are forgotten).
  const feedRedis = new Redis(config.redisUrl);
  setFeedCacheSink(() => forgetFeedKeys(feedRedis));
  // Phone notifications for videos the worker finishes (followers hear about a new video when it is ready).
  setPushSender(createPushSender(prisma, config));
  // Higher qualities and caption backfill use separate worker slots so they cannot occupy the first-playable queue.
  // Long videos are encoded in pieces: every worker (this one included) takes pieces from the chunk queue.
  const storage = createStorage(config);
  const chunkDestinations = Object.fromEntries((['libx264', 'nvenc', 'qsv'] as const).map((encoder) => [encoder, {
    queue: new Queue<ChunkTask>(chunkQueueName(encoder), { connection: connection(), prefix: config.media.queuePrefix }),
    events: new QueueEvents(chunkQueueName(encoder), { connection: connection(), prefix: config.media.queuePrefix }),
  }])) as Record<'libx264' | 'nvenc' | 'qsv', { queue: Queue<ChunkTask>; events: QueueEvents }>;
  const { queue: chunkQueue, events: chunkEvents } = chunkDestinations.libx264;
  const media = new Queue<MediaJob>(MEDIA_QUEUE, { connection: connection(), prefix: config.media.queuePrefix });
  const upgrades = new Queue<MediaJob>(MEDIA_UPGRADE_QUEUE, { connection: connection(), prefix: config.media.queuePrefix });
  const enqueue = async (job: MediaJob) => {
    const queue = job.name === 'upgrade' || job.name === 'caption' ? upgrades : media;
    await queue.add(job.name, job, jobOptions(job));
  };
  const jobs = new MediaJobs(prisma, storage, config, new Redis(config.redisUrl), enqueue, new QueueChunks(chunkQueue, chunkEvents, chunkDestinations));
  // Every node handles CPU fallback. Hardware queues are consumed only by a verified compatible node.
  const encoders = config.media.encoder === 'libx264' ? ['libx264'] as const : ['libx264', config.media.encoder] as const;
  const chunkWorkers = encoders.map((encoder) => {
    const worker = new Worker<ChunkTask, ChunkResult>(chunkQueueName(encoder), (job, _token, signal) => runChunk(job.data, { ffmpegPath: config.media.ffmpegPath, storage, scratchDir: config.media.scratchDir }, signal),
      { connection: connection(), prefix: config.media.queuePrefix, concurrency: config.media.chunkConcurrency, lockDuration: 60_000 });
    worker.on('failed', (j, e) => log.warn(`piece ${j?.data.index} of ${j?.data.videoId} (${encoder}) attempt ${j?.attemptsMade}: ${e.message.slice(0, 300)}`));
    return worker;
  });

  // Metrics (see MONITORING.md): jobs by result and how long they take; served on WORKER_METRICS_PORT.
  const registry = createRegistry('worker');
  const jobsDone = new Counter({ name: 'freeme_worker_jobs_total', help: 'Media jobs finished', labelNames: ['job', 'result'] as const, registers: [registry] });
  const jobTime = new Histogram({ name: 'freeme_worker_job_duration_seconds', help: 'Media job duration', labelNames: ['job'] as const,
    buckets: [1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600], registers: [registry] });
  const metricsServer = config.workerMetricsPort ? createServer(async (req, res) => {
    if (req.url !== '/metrics' || !tokenMatches(req.headers.authorization, config.metricsToken)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': registry.contentType }).end(await registry.metrics());
  }).listen(config.workerMetricsPort, config.workerMetricsHost) : null;

  const processMedia: Processor<MediaJob> = async (job, _token, signal) => {
    if (job.data.name === 'transcode' || job.data.name === 'upgrade') {
      log.log({ event: job.data.name === 'upgrade' ? 'upgrade_started' : 'transcode_started', videoId: job.data.videoId, attempt: job.attemptsMade + 1, queueWaitMs: Math.max(0, (job.processedOn ?? Date.now()) - job.timestamp) });
    }
    const end = jobTime.startTimer({ job: job.data.name });
    try { await jobs.run(job.data, job.attemptsMade + 1 >= (job.opts.attempts ?? 1), signal); end(); jobsDone.inc({ job: job.data.name, result: 'done' }); }
    catch (e) {
      jobsDone.inc({ job: job.data.name, result: e instanceof VideoBusy ? 'busy' : 'failed' });
      if (e instanceof MediaError) throw new UnrecoverableError(e.message); // a bad file: retrying will not help
      if (e instanceof VideoBusy) throw e; // retried with backoff
      throw e;
    }
  };
  const consume = (name: string, concurrency: number) => {
    const worker = new Worker<MediaJob>(name, processMedia, { connection: connection(), prefix: config.media.queuePrefix, concurrency, lockDuration: 60_000 });
    worker.on('completed', (j) => log.log(`${j.name} ${j.data.videoId} done`));
    worker.on('failed', (j, e) => log.warn(`${j?.name} ${j?.data.videoId} attempt ${j?.attemptsMade}: ${e.message}`));
    return worker;
  };
  const worker = consume(MEDIA_QUEUE, config.media.workerConcurrency);
  const upgradeWorker = consume(MEDIA_UPGRADE_QUEUE, config.media.upgradeConcurrency);

  const maintenance = new Queue('maintenance', { connection: connection(), prefix: config.media.queuePrefix });
  await maintenance.upsertJobScheduler('flush-views', { every: 15_000 }, { name: 'flush-views' });
  await maintenance.upsertJobScheduler('stale-uploads', { every: 3600_000 }, { name: 'stale-uploads' });
  await maintenance.upsertJobScheduler('recover-stuck', { every: 5 * 60_000 }, { name: 'recover-stuck' });
  // Popularity-based encoding: videos that reached HD_MIN_VIEWS get their 1080p and above.
  await maintenance.upsertJobScheduler('hd-upgrades', { every: 60_000 }, { name: 'hd-upgrades' });
  // Storage saving: originals of ready videos older than SOURCE_RETENTION_DAYS (off by default).
  if (config.media.sourceRetentionDays) await maintenance.upsertJobScheduler('expire-sources', { every: 3600_000 }, { name: 'expire-sources' });
  // Money: check pending payments every minute; end memberships and share yesterday's ad revenue every 15 minutes.
  const billing = new Billing(prisma, config);
  const mail = new MailService(config);
  await maintenance.upsertJobScheduler('billing-receipts', { every: 60_000 }, { name: 'billing-receipts' });
  await maintenance.upsertJobScheduler('billing-payments', { every: 60_000 }, { name: 'billing-payments' });
  await maintenance.upsertJobScheduler('billing-daily', { every: 15 * 60_000 }, { name: 'billing-daily' });
  // Plans are paid ahead (mobile money does not renew by itself): a reminder three days before one ends.
  await maintenance.upsertJobScheduler('renewal-reminders', { every: 3600_000 }, { name: 'renewal-reminders' });
  const reminders = new Redis(config.redisUrl);
  if (config.media.whisper) await maintenance.upsertJobScheduler('caption-backfill', { every: 5 * 60_000 }, { name: 'caption-backfill' });
  const maint = new Worker('maintenance', async (job) => {
    if (job.name === 'stale-uploads') await jobs.cleanupStaleUploads();
    else if (job.name === 'caption-backfill') {
      for (const { id } of await jobs.captionBackfillCandidates()) {
        await upgrades.add('caption', { name: 'caption', videoId: id }, { ...jobOptions({ name: 'caption', videoId: id }), jobId: `caption-${id}`, priority: 100, attempts: 3 });
      }
    }
    else if (job.name === 'billing-receipts') await billing.sendReceipts(mail);
    else if (job.name === 'renewal-reminders') {
      const n = await billing.sendRenewalReminders(mail, async (key) => (await reminders.set(key, '1', 'EX', 10 * 86_400, 'NX')) === 'OK');
      if (n) log.log({ event: 'renewal_reminders_sent', count: n });
    }
    else if (job.name === 'billing-payments') await billing.reconcile();
    else if (job.name === 'billing-daily') { await billing.expirePremium(); const n = await billing.settleAds(); if (n) log.log(`Settled ${n} day(s) of ad revenue`); }
    else if (job.name === 'expire-sources') await jobs.expireSources();
    else if (job.name === 'hd-upgrades') {
      const ids = await jobs.popularUpgrades();
      for (const videoId of ids) {
        // Not queued: put the flag back so the next run tries again.
        try { await enqueue({ name: 'upgrade', videoId }); }
        catch (e) { await prisma.video.updateMany({ where: { id: videoId }, data: { hdPending: true } }); throw e; }
      }
      if (ids.length) log.log({ event: 'hd_upgrades_queued', count: ids.length });
    }
    else if (job.name === 'recover-stuck') {
      // A playable video that stopped before its higher qualities only needs the second job.
      for (const { id: videoId, playable } of await jobs.stuckVideos()) {
        const job = { name: playable ? 'upgrade' : 'transcode', videoId } as const;
        await enqueue(job);
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
          await enqueue(transcode);
        }, log, config.media.ffmpegPath); }
      }
    } catch (e) { log.warn(`live: ${(e as Error).message}`); } finally { liveBusy = false; }
  }, 1500) : null;

  log.log(`Media worker running (concurrency ${config.media.workerConcurrency} foreground / ${config.media.upgradeConcurrency} background, storage ${config.media.driver}, preset ${config.media.preset})`);
  const stop = async () => { log.log('Stopping…'); if (liveTimer) clearInterval(liveTimer); metricsServer?.close(); await Promise.allSettled([worker.close(), upgradeWorker.close(), maint.close(), maintenance.close(), media.close(), upgrades.close(), ...chunkWorkers.map((w) => w.close()), ...Object.values(chunkDestinations).flatMap((d) => [d.queue.close(), d.events.close()])]); await prisma.$disconnect(); process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}

main().catch((e) => { console.error(e); process.exit(1); });

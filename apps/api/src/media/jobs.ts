import { Logger } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type Redis from 'ioredis';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config/config';
import { mediaPrefix, wantedLocation } from './keys';
import { LATE_FOLDERS } from './captions';
import { autoCaptions, extractSpeech } from './autocaptions';
import { AudioOnly, probe } from './probe';
import { MediaError, VideoProcessor } from './process';
import type { Storage } from './storage';
import type { ChunkRunner } from './chunks';
import { ViewCounter } from './views';

/**
 * `transcode` makes a video playable (360p, thumbnails, seek previews); `upgrade` adds the higher qualities. Upgrades
 * have a lower priority, so a new upload never waits for another video's 1080p or 4K.
 */
export type MediaJob = { name: 'transcode'; videoId: string } | { name: 'upgrade'; videoId: string } | { name: 'relocate'; videoId: string } | { name: 'purge'; videoId: string } | { name: 'caption'; videoId: string };

/** Thrown when a video is busy with another job; the queue retries later. */
export class VideoBusy extends Error {}

/** The work the media node does. Jobs on one video never run at the same time (Redis lock). */
export class MediaJobs {
  private readonly log = new Logger('MediaJobs');
  readonly processor: VideoProcessor;
  readonly views: ViewCounter;
  private readonly localLocks = new Set<string>();

  constructor(private readonly prisma: PrismaClient, private readonly storage: Storage, private readonly config: AppConfig, private readonly redis: Redis | null,
    /** Queues a follow-up job (the higher qualities after a video becomes playable). */
    private readonly enqueue: ((job: MediaJob) => Promise<void>) | null = null,
    /** Where long videos' pieces are encoded (every worker through the queue, or this process). */
    chunks: ChunkRunner | null = null) {
    this.processor = new VideoProcessor(prisma, storage, config, chunks);
    this.views = new ViewCounter(prisma, redis);
  }

  private async withLock<T>(videoId: string, fn: (lease?: AbortSignal) => Promise<T>): Promise<T> {
    const key = `fm:lock:video:${videoId}`;
    const token = randomUUID();
    if (this.redis) {
      const redis = this.redis;
      const leaseMs = 60_000;
      if ((await redis.set(key, token, 'PX', leaseMs, 'NX')) !== 'OK') throw new VideoBusy(`Video ${videoId} is busy.`);
      const lease = new AbortController();
      let renewedAt = performance.now();
      let pending = false;
      const heartbeat = setInterval(async () => {
        if (performance.now() - renewedAt >= leaseMs * 0.75) lease.abort(new VideoBusy(`Video ${videoId} lost its lock.`));
        if (pending || lease.signal.aborted) return;
        pending = true;
        try {
          const renewalStarted = performance.now();
          const ok = await redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end", 1, key, token, leaseMs);
          if (ok === 1) renewedAt = renewalStarted;
          else lease.abort(new VideoBusy(`Video ${videoId} lost its lock.`));
        } catch (e) {
          this.log.warn(`Could not renew video ${videoId} lock: ${(e as Error).message}`);
        } finally { pending = false; }
      }, leaseMs / 4);
      heartbeat.unref();
      try { return await fn(lease.signal); } finally {
        clearInterval(heartbeat);
        await redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, key, token);
      }
    }
    if (this.localLocks.has(videoId)) throw new VideoBusy(`Video ${videoId} is busy.`);
    this.localLocks.add(videoId);
    try { return await fn(); } finally { this.localLocks.delete(videoId); }
  }

  /** `final` = no retries left: a failure becomes visible to the creator. */
  async transcode(videoId: string, final: boolean, signal?: AbortSignal, part: 'playable' | 'rest' = 'playable'): Promise<void> {
    const done = await this.withLock(videoId, async (lease) => {
      const processingSignal = lease && signal ? AbortSignal.any([lease, signal]) : lease ?? signal;
      try {
        return await this.processor.process(videoId, processingSignal, part);
      } catch (e) {
        if (processingSignal?.aborted) throw processingSignal.reason;
        const known = e instanceof MediaError;
        this.log.error(`${videoId}: ${(e as Error).message}`);
        if (known || final) {
          const message = known ? (e as Error).message : 'Processing failed. Try uploading the video again.';
          await this.prisma.video.updateMany({
            where: { id: videoId, status: 'PROCESSING', hlsMasterKey: null },
            data: { status: 'FAILED', processingStage: 'Failed', processingError: message },
          });
          if (part === 'rest') await this.prisma.video.updateMany({
            where: { id: videoId, status: 'READY', hlsMasterKey: { not: null } },
            data: { processingStage: 'Ready', processingError: 'Some higher qualities could not be generated.' },
          });
        }
        throw e;
      }
    });
    // The higher qualities run in the background queue (or right away in inline development).
    if (done.more) {
      if (this.enqueue) await this.enqueue({ name: 'upgrade', videoId });
      else return this.transcode(videoId, final, signal, 'rest');
    }
    // Automatic captions after the video is ready and unlocked: publishing or moving it never waits for them.
    if (done.speech) {
      await autoCaptions(this.prisma, this.storage, this.config, videoId, done.speech, signal);
      if (!signal?.aborted) await this.prisma.video.updateMany({ where: { id: videoId }, data: { captionAttemptedAt: new Date() } });
    }
  }

  async captionBackfillCandidates() {
    if (!this.config.media.whisper) return [];
    return this.prisma.video.findMany({
      where: { status: 'READY', processingStage: 'Ready', takenDownAt: null, sourceFileS3Key: { not: null }, captionAttemptedAt: null, updatedAt: { lt: new Date(Date.now() - 15 * 60_000) }, captions: { none: {} } },
      orderBy: { createdAt: 'asc' }, take: 2, select: { id: true },
    });
  }

  private async backfillCaption(videoId: string, signal?: AbortSignal) {
    if (!this.config.media.whisper) return;
    const video = await this.prisma.video.findFirst({
      where: { id: videoId, status: 'READY', takenDownAt: null, captionAttemptedAt: null, captions: { none: {} } },
      select: { sourceFileS3Key: true },
    });
    if (!video?.sourceFileS3Key) return;
    await mkdir(this.config.media.scratchDir, { recursive: true });
    const work = await mkdtemp(join(this.config.media.scratchDir, 'captions-'));
    try {
      const source = join(work, `source${extname(video.sourceFileS3Key)}`);
      const speech = join(work, 'speech.wav');
      await this.storage.download(video.sourceFileS3Key, source);
      const info = await probe(this.config.media.ffprobePath, source).catch((error: unknown) => {
        if (error instanceof AudioOnly) return { hasAudio: true };
        throw error;
      });
      if (info.hasAudio) {
        await extractSpeech(this.config.media.ffmpegPath, source, speech, signal);
        await autoCaptions(this.prisma, this.storage, this.config, videoId, speech, signal);
      }
      signal?.throwIfAborted();
      await this.prisma.video.updateMany({ where: { id: videoId }, data: { captionAttemptedAt: new Date() } });
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  /** Moves media between the public (CDN) and private (signed links) prefixes after a visibility change or a removal. */
  async relocate(videoId: string) {
    await this.withLock(videoId, async () => {
      const v = await this.prisma.video.findUnique({ where: { id: videoId } });
      if (!v?.hlsMasterKey) return;
      const want = wantedLocation(v);
      if (v.mediaLocation === want) return;
      const from = mediaPrefix(videoId, v.mediaLocation);
      const to = mediaPrefix(videoId, want);
      const n = await this.storage.copyPrefix(from, to);
      await this.prisma.video.update({ where: { id: videoId }, data: { mediaLocation: want } });
      // Files written to the old place during the copy (custom thumbnail, captions) are moved too.
      for (const dir of LATE_FOLDERS) await this.storage.copyPrefix(from + dir, to + dir);
      await this.storage.deletePrefix(from);
      this.log.log(`${videoId}: moved ${n} files to ${want.toLowerCase()} storage`);
    });
  }

  /**
   * Finds a ready video's files left in the other storage place (public vs private) and, with `apply`, copies the
   * ones missing where the video lives, then removes the leftovers. Before November 2026, publishing while the HD
   * pass ran could leave thumbnails and SD files behind this way. Never overwrites a file that is already in place.
   */
  async repair(videoId: string, apply: boolean) {
    const check = async () => {
      const v = await this.prisma.video.findUnique({ where: { id: videoId }, include: { renditions: { select: { playlistKey: true } } } });
      if (!v?.hlsMasterKey) return null;
      const here = mediaPrefix(videoId, v.mediaLocation);
      const there = mediaPrefix(videoId, v.mediaLocation === 'PUBLIC' ? 'PRIVATE' : 'PUBLIC');
      const [hereKeys, thereKeys] = await Promise.all([this.storage.list(here).then((k) => new Set(k)), this.storage.list(there)]);
      const needed = [v.hlsMasterKey, ...v.renditions.map((r) => `hls/${r.playlistKey.replace(/^hls\//, '')}`), ...(v.thumbnailKey ? [v.thumbnailKey] : []), ...v.thumbnailCandidates,
        ...((v.storyboard as { key?: string } | null)?.key ? [(v.storyboard as { key: string }).key] : [])];
      const missing = [...new Set(needed)].filter((k) => !hereKeys.has(here + k));
      const toCopy = thereKeys.filter((k) => !hereKeys.has(here + k.slice(there.length)));
      let copied = 0;
      if (apply && thereKeys.length) {
        for (const k of toCopy) { await this.storage.copyObject(k, here + k.slice(there.length)); copied++; }
        await this.storage.deletePrefix(there);
      }
      return { videoId, location: v.mediaLocation, missing, leftovers: thereKeys.length, toCopy: toCopy.length, copied };
    };
    return apply ? this.withLock(videoId, check) : check();
  }

  /** Deletes every file of a removed video (source, public and private media). */
  async purge(videoId: string) {
    for (const p of [`src/${videoId}/`, `pub/${videoId}/`, `prv/${videoId}/`]) await this.storage.deletePrefix(p);
  }

  /** Cancels uploads nobody finished within 3 days (their parts would otherwise use storage forever). */
  async cleanupStaleUploads(): Promise<number> {
    const before = new Date(Date.now() - 3 * 86_400_000);
    const stale = await this.prisma.video.findMany({ where: { status: 'UPLOADING', updatedAt: { lt: before } }, take: 500 });
    let removed = 0;
    for (const v of stale) {
      const deleted = await this.prisma.video.deleteMany({ where: { id: v.id, status: 'UPLOADING', updatedAt: { lt: before } } });
      if (!deleted.count) continue;
      if (v.uploadId && v.sourceFileS3Key) await this.storage.abortMultipart(v.sourceFileS3Key, v.uploadId);
      await this.storage.deletePrefix(`src/${v.id}/`);
      removed++;
    }
    if (removed) this.log.log(`Removed ${removed} abandoned uploads`);
    return removed;
  }

  /**
   * Videos whose processing stopped without finishing (server restart, lost queue): still PROCESSING, or SD ready
   * with more qualities pending. Unqueued uploads become eligible in five minutes, active stages in thirty.
   */
  async stuckVideos(): Promise<Array<{ id: string; playable: boolean }>> {
    const before = new Date(Date.now() - 30 * 60_000);
    const rows = await this.prisma.video.findMany({
      where: { OR: [
        { status: 'PROCESSING', sourceFileS3Key: { not: null }, processingStage: 'Waiting to process', updatedAt: { lt: new Date(Date.now() - 5 * 60_000) } },
        { status: 'PROCESSING', updatedAt: { lt: before } },
        { status: 'READY', processingStage: { not: 'Ready' }, updatedAt: { lt: before } },
      ] },
      select: { id: true, status: true, hlsMasterKey: true }, take: 200,
    });
    return rows.map((r) => ({ id: r.id, playable: r.status === 'READY' && !!r.hlsMasterKey }));
  }

  async run(job: MediaJob, final: boolean, signal?: AbortSignal) {
    if (job.name === 'transcode') return this.transcode(job.videoId, final, signal);
    if (job.name === 'upgrade') return this.transcode(job.videoId, final, signal, 'rest');
    if (job.name === 'caption') {
      try { return await this.backfillCaption(job.videoId, signal); }
      catch (error) {
        if (final && !signal?.aborted) await this.prisma.video.updateMany({ where: { id: job.videoId }, data: { captionAttemptedAt: new Date() } });
        throw error;
      }
    }
    if (job.name === 'relocate') return this.relocate(job.videoId);
    return this.purge(job.videoId);
  }
}

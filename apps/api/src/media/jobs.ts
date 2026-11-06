import { Logger } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config/config';
import { mediaPrefix, wantedLocation } from './keys';
import { LATE_FOLDERS } from './captions';
import { autoCaptions } from './autocaptions';
import { MediaError, VideoProcessor } from './process';
import type { Storage } from './storage';
import { ViewCounter } from './views';

export type MediaJob = { name: 'transcode'; videoId: string } | { name: 'relocate'; videoId: string } | { name: 'purge'; videoId: string };

/** Thrown when a video is busy with another job; the queue retries later. */
export class VideoBusy extends Error {}

/** The work the media node does. Jobs on one video never run at the same time (Redis lock). */
export class MediaJobs {
  private readonly log = new Logger('MediaJobs');
  readonly processor: VideoProcessor;
  readonly views: ViewCounter;
  private readonly localLocks = new Set<string>();

  constructor(private readonly prisma: PrismaClient, private readonly storage: Storage, private readonly config: AppConfig, private readonly redis: Redis | null) {
    this.processor = new VideoProcessor(prisma, storage, config);
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
  async transcode(videoId: string, final: boolean, signal?: AbortSignal) {
    const done = await this.withLock(videoId, async (lease) => {
      const processingSignal = lease && signal ? AbortSignal.any([lease, signal]) : lease ?? signal;
      try {
        return await this.processor.process(videoId, processingSignal);
      } catch (e) {
        if (processingSignal?.aborted) throw processingSignal.reason;
        const known = e instanceof MediaError;
        this.log.error(`${videoId}: ${(e as Error).message}`);
        if (known || final) {
          await this.prisma.video.updateMany({ where: { id: videoId }, data: { status: 'FAILED', processingStage: 'Failed', processingError: known ? (e as Error).message : 'Processing failed. Try uploading the video again.' } });
        }
        throw e;
      }
    });
    // Automatic captions after the video is ready and unlocked: publishing or moving it never waits for them.
    if (done.speech) await autoCaptions(this.prisma, this.storage, this.config, videoId, done.speech, signal);
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
    const stale = await this.prisma.video.findMany({ where: { status: 'UPLOADING', createdAt: { lt: new Date(Date.now() - 3 * 86_400_000) } }, take: 500 });
    for (const v of stale) {
      if (v.uploadId && v.sourceFileS3Key) await this.storage.abortMultipart(v.sourceFileS3Key, v.uploadId);
      await this.prisma.video.delete({ where: { id: v.id } }).catch(() => undefined);
    }
    if (stale.length) this.log.log(`Removed ${stale.length} abandoned uploads`);
    return stale.length;
  }

  /**
   * Videos whose processing stopped without finishing (server restart, lost queue): still PROCESSING, or SD ready
   * with more qualities pending. Unqueued uploads become eligible in five minutes, active stages in thirty.
   */
  async stuckVideos(): Promise<string[]> {
    const before = new Date(Date.now() - 30 * 60_000);
    const rows = await this.prisma.video.findMany({
      where: { OR: [
        { status: 'PROCESSING', sourceFileS3Key: { not: null }, processingStage: 'Waiting to process', updatedAt: { lt: new Date(Date.now() - 5 * 60_000) } },
        { status: 'PROCESSING', updatedAt: { lt: before } },
        { status: 'READY', processingStage: { not: 'Ready' }, updatedAt: { lt: before } },
      ] },
      select: { id: true }, take: 200,
    });
    return rows.map((r) => r.id);
  }

  async run(job: MediaJob, final: boolean, signal?: AbortSignal) {
    if (job.name === 'transcode') return this.transcode(job.videoId, final, signal);
    if (job.name === 'relocate') return this.relocate(job.videoId);
    return this.purge(job.videoId);
  }
}

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
import { ViewCounter } from './views';

export type MediaJob = { name: 'transcode'; videoId: string } | { name: 'relocate'; videoId: string } | { name: 'purge'; videoId: string } | { name: 'caption'; videoId: string };

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

  private async withLock<T>(videoId: string, fn: () => Promise<T>): Promise<T> {
    const key = `fm:lock:video:${videoId}`;
    const token = randomUUID();
    if (this.redis) {
      if ((await this.redis.set(key, token, 'PX', 4 * 3600_000, 'NX')) !== 'OK') throw new VideoBusy(`Video ${videoId} is busy.`);
      try { return await fn(); } finally {
        await this.redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, key, token);
      }
    }
    if (this.localLocks.has(videoId)) throw new VideoBusy(`Video ${videoId} is busy.`);
    this.localLocks.add(videoId);
    try { return await fn(); } finally { this.localLocks.delete(videoId); }
  }

  /** `final` = no retries left: a failure becomes visible to the creator. */
  async transcode(videoId: string, final: boolean, signal?: AbortSignal) {
    const done = await this.withLock(videoId, async () => {
      try {
        return await this.processor.process(videoId, signal);
      } catch (e) {
        const known = e instanceof MediaError;
        this.log.error(`${videoId}: ${(e as Error).message}`);
        if (known || final) {
          await this.prisma.video.updateMany({ where: { id: videoId }, data: { status: 'FAILED', processingStage: 'Failed', processingError: known ? (e as Error).message : 'Processing failed. Try uploading the video again.' } });
        }
        throw e;
      }
    });
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
   * without HD, and untouched for 30 minutes. The caller queues them again; the per-video lock prevents overlap.
   */
  async stuckVideos(): Promise<string[]> {
    const before = new Date(Date.now() - 30 * 60_000);
    const rows = await this.prisma.video.findMany({
      where: { updatedAt: { lt: before }, OR: [{ status: 'PROCESSING' }, { status: 'READY', processingStage: { not: 'Ready' } }] },
      select: { id: true }, take: 200,
    });
    return rows.map((r) => r.id);
  }

  async run(job: MediaJob, final: boolean, signal?: AbortSignal) {
    if (job.name === 'transcode') return this.transcode(job.videoId, final, signal);
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

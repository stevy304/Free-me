import { Logger } from '@nestjs/common';
import { aiModerator } from '../safety/ai';
import { recordAutomatic } from '../safety/check';
import { frames, AUTOMATED_MATCH } from './screening';
import { feedsChanged } from '../catalog/feed-cache';
import { announceVideo } from '../notifications/notify';
import { readFile } from 'node:fs/promises';
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
import { ffmpegEncoders } from './filters';
import { MediaError, VideoProcessor } from './process';
import type { Storage } from './storage';
import type { ChunkRunner } from './chunks';
import { ViewCounter } from './views';
import { ProgressBuffer } from './progress';
import { fingerprintFile, saveFingerprint } from './content-id';

/**
 * `transcode` makes a video playable (360p, thumbnails, seek previews); `upgrade` adds the higher qualities. Upgrades
 * have a lower priority, so a new upload never waits for another video's 1080p or 4K.
 */
export type MediaJob = { name: 'transcode'; videoId: string } | { name: 'upgrade'; videoId: string } | { name: 'av1'; videoId: string } | { name: 'appeal'; videoId: string } | { name: 'relocate'; videoId: string } | { name: 'purge'; videoId: string } | { name: 'caption'; videoId: string };

/** Thrown when a video is busy with another job; the queue retries later. */
export class VideoBusy extends Error {}

/** The work the media node does. Jobs on one video never run at the same time (Redis lock). */
export class MediaJobs {
  private readonly log = new Logger('MediaJobs');
  readonly processor: VideoProcessor;
  readonly views: ViewCounter;
  /** Resume positions saved by players, written to the database in batches with the views (see progress.ts). */
  readonly progress: ProgressBuffer;
  private readonly localLocks = new Set<string>();

  constructor(private readonly prisma: PrismaClient, private readonly storage: Storage, private readonly config: AppConfig, private readonly redis: Redis | null,
    /** Queues a follow-up job (the higher qualities after a video becomes playable). */
    private readonly enqueue: ((job: MediaJob) => Promise<void>) | null = null,
    /** Where long videos' pieces are encoded (every worker through the queue, or this process). */
    chunks: ChunkRunner | null = null) {
    this.processor = new VideoProcessor(prisma, storage, config, chunks);
    this.views = new ViewCounter(prisma, redis);
    this.progress = new ProgressBuffer(prisma, redis);
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
      const needed = [v.hlsMasterKey, ...(v.hlsFullMasterKey ? [v.hlsFullMasterKey] : []), ...v.renditions.map((r) => `hls/${r.playlistKey.replace(/^hls\//, '')}`), ...(v.thumbnailKey ? [v.thumbnailKey] : []), ...v.thumbnailCandidates,
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

  /**
   * Videos whose 1080p and above waited for viewers (`hdPending`) and are now watched enough, or whose creator has
   * since become a Premium member. Each is claimed (the flag cleared) before it is returned, so it is queued once.
   */
  async popularUpgrades(limit = 50, now = new Date()): Promise<string[]> {
    const min = this.config.media.hdMinViews;
    const rows = await this.prisma.video.findMany({
      where: { hdPending: true, status: 'READY', takenDownAt: null, OR: [
        { viewCount: { gte: BigInt(min) } },
        { channel: { user: { OR: [{ premiumUntil: { gt: now } }, { roles: { has: 'ADMIN' } }] } } },
      ] },
      orderBy: { viewCount: 'desc' }, take: limit, select: { id: true },
    });
    const claimed: string[] = [];
    for (const { id } of rows) {
      const r = await this.prisma.video.updateMany({ where: { id, hdPending: true }, data: { hdPending: false } });
      if (r.count) claimed.push(id);
    }
    return claimed;
  }

  /**
   * Popular videos that get AV1 renditions (AV1_MIN_VIEWS, see av1.ts): ready, complete (no HD waiting, nothing
   * processing), not removed, watched enough, never queued for AV1. Most watched first. Each is claimed before it is
   * returned (av1QueuedAt), so it is queued once; nothing when AV1 is off or this ffmpeg cannot encode it.
   */
  async popularAv1(limit = 20, now = new Date()): Promise<string[]> {
    const min = this.config.media.av1.minViews;
    if (!min || !(await ffmpegEncoders(this.config.media.ffmpegPath)).has('libsvtav1')) return [];
    const rows = await this.prisma.video.findMany({
      where: { av1QueuedAt: null, status: 'READY', processingStage: 'Ready', hdPending: false, takenDownAt: null, hlsMasterKey: { not: null }, viewCount: { gte: BigInt(min) } },
      orderBy: { viewCount: 'desc' }, take: limit, select: { id: true },
    });
    const claimed: string[] = [];
    for (const { id } of rows) {
      const r = await this.prisma.video.updateMany({ where: { id, av1QueuedAt: null }, data: { av1QueuedAt: now } });
      if (r.count) claimed.push(id);
    }
    return claimed;
  }

  /** AV1 renditions of a popular video; the lock is held only while publishing them (see VideoProcessor.processAv1). */
  async av1(videoId: string, signal?: AbortSignal) {
    const added = await this.processor.processAv1(videoId, (fn) => this.withLock(videoId, fn), signal);
    if (added.length) this.log.log(`${videoId}: AV1 ${added.join(', ')}`);
  }

  /**
   * A creator's appeal against an automatic decision (safety/ai.ts): Claude Opus 5.5 looks again at frames and words.
   * Accepted: the video is published (or released from "limited"), as if a moderator had cleared it. Rejected again:
   * the decision stands and the creator sees the new reason. Without the AI moderator, a person is asked instead.
   */
  async appeal(videoId: string, signal?: AbortSignal) {
    const v = await this.prisma.video.findUnique({ where: { id: videoId }, include: { tags: { select: { tag: { select: { name: true } } } } } });
    if (!v || v.takenDownAt || !v.safetyDecision || v.safetyDecision === 'publish') return;
    const ai = await aiModerator(this.prisma, this.config);
    if (!ai) {
      const open = await this.prisma.report.findFirst({ where: { videoId, reason: AUTOMATED_MATCH, status: { in: ['PENDING', 'INVESTIGATING'] } } });
      if (!open) await this.prisma.report.create({ data: { videoId, reason: AUTOMATED_MATCH, details: `The creator appeals: ${v.safetyReason ?? v.safetyDecision}`, priority: 50 } });
      return;
    }
    const work = await mkdtemp(join(this.config.media.scratchDir, `${videoId}-appeal-`));
    try {
      const frameList = await this.appealFrames(v, work, signal);
      const verdict = await ai.decide({ kind: 'appeal', text: `${[v.title, v.description ?? '', ...v.tags.map((t) => t.tag.name)].join('\n')}\n\nEarlier decision: ${v.safetyDecision} — ${v.safetyReason ?? ''}`, frames: frameList }, signal);
      const base = { safetyDecision: verdict.decision, safetyReason: verdict.reason, safetyModel: verdict.model };
      this.log.log({ event: 'video_appeal_decided', videoId, from: v.safetyDecision, to: verdict.decision, model: verdict.model });
      if (verdict.decision === 'reject') {
        await this.prisma.video.update({ where: { id: videoId }, data: base });
        await recordAutomatic(this.prisma, videoId, `Appeal not accepted by ${verdict.model}: ${verdict.reason}`, verdict.category === 'none' ? null : verdict.category);
        return;
      }
      const limited = verdict.decision === 'limit' ? new Date() : null;
      if (v.status === 'FLAGGED') {
        // Rejected before it was ever published: processed and published now, as its creator chose.
        await this.prisma.video.update({ where: { id: videoId }, data: { ...base, status: 'PROCESSING', processingStage: 'Queued', screeningClearedAt: new Date(), safetyCheckedAt: new Date(), safetyLimitedAt: limited } });
        if (this.enqueue) await this.enqueue({ name: 'transcode', videoId }); else {
          // Without a queue (development): the job that rejected it may still be letting go of the video; wait for it.
          const run = async (): Promise<void> => {
            for (let i = 0; ; i++) {
              try { return await this.transcode(videoId, true, signal); }
              catch (e) { if (!(e instanceof VideoBusy) || i >= 20) throw e; await new Promise((r) => setTimeout(r, 500)); }
            }
          };
          void run().catch((e) => this.log.error(`${videoId}: ${(e as Error).message}`));
        }
      } else {
        await this.prisma.video.update({ where: { id: videoId }, data: { ...base, reviewHoldAt: null, safetyLimitedAt: limited } });
        await feedsChanged();
        if (!limited) await announceVideo(this.prisma, videoId);
      }
      await recordAutomatic(this.prisma, videoId, `Appeal accepted by ${verdict.model} (${verdict.decision}): ${verdict.reason}`, null);
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Frames for an appeal: from the original when it is kept, else the thumbnail choices made from the video. */
  private async appealFrames(v: { id: string; sourceFileS3Key: string | null; mediaLocation: 'PUBLIC' | 'PRIVATE'; thumbnailCandidates: string[] }, work: string, signal?: AbortSignal): Promise<string[]> {
    if (v.sourceFileS3Key) {
      const file = join(work, `source${extname(v.sourceFileS3Key) || '.bin'}`);
      await this.storage.download(v.sourceFileS3Key, file, signal);
      try { return await frames(this.config.media.ffmpegPath, file, await probe(this.config.media.ffprobePath, file), join(work, 'frames')); }
      catch (e) { if (e instanceof AudioOnly) return []; throw e; }
    }
    const out: string[] = [];
    for (const key of v.thumbnailCandidates) {
      const file = join(work, key.replace(/\//g, '_'));
      try { await this.storage.download(mediaPrefix(v.id, v.mediaLocation) + key, file, signal); out.push((await readFile(file)).toString('base64')); } catch { /* missing: skip */ }
    }
    return out;
  }

  /**
   * Limited videos (safety/ai.ts) are released after 3 days unless people reported them: reported by 2 or more,
   * they are hidden and a moderator is asked; otherwise they join feeds, search and recommendations.
   */
  async releaseLimited(now = Date.now()): Promise<{ released: number; hidden: number }> {
    const rows = await this.prisma.video.findMany({ where: { safetyLimitedAt: { lt: new Date(now - 3 * 86_400_000) }, takenDownAt: null }, select: { id: true }, take: 500 });
    let released = 0; let hidden = 0;
    for (const { id } of rows) {
      const reports = await this.prisma.report.count({ where: { videoId: id, reporterId: { not: null }, status: { in: ['PENDING', 'INVESTIGATING'] } } });
      if (reports >= 2) {
        const r = await this.prisma.video.updateMany({ where: { id, reviewHoldAt: null }, data: { reviewHoldAt: new Date(now) } });
        if (r.count) hidden++;
        await this.prisma.video.update({ where: { id }, data: { safetyLimitedAt: null } });
      } else {
        await this.prisma.video.update({ where: { id }, data: { safetyLimitedAt: null, safetyDecision: 'publish' } });
        await announceVideo(this.prisma, id);
        released++;
      }
    }
    if (released || hidden) await feedsChanged();
    return { released, hidden };
  }

  /**
   * Storage saving (SOURCE_RETENTION_DAYS): deletes the original upload of ready videos older than that, once nothing
   * still needs it: automatic captions were tried (when they are on), no job is running on the video (lock), and a
   * video still waiting for its HD qualities gives that up (it keeps up to 720p). Returns how many were removed.
   */
  /**
   * Content ID for videos published before it existed: fingerprints them from their original (while it is kept), so
   * they are protected works too. It never claims or blocks a video that is already out. Returns how many were done.
   */
  async backfillFingerprints(limit = 10): Promise<number> {
    const rows = await this.prisma.video.findMany({
      where: { status: 'READY', publishedAt: { not: null }, sourceFileS3Key: { not: null }, contentFingerprint: null, isAd: false },
      orderBy: { viewCount: 'desc' }, take: limit, select: { id: true, sourceFileS3Key: true },
    });
    let done = 0;
    for (const v of rows) {
      const work = await mkdtemp(join(this.config.media.scratchDir, `${v.id}-fp-`));
      try {
        const file = join(work, `source${extname(v.sourceFileS3Key!) || '.bin'}`);
        await this.storage.download(v.sourceFileS3Key!, file);
        const info = await probe(this.config.media.ffprobePath, file);
        await saveFingerprint(this.prisma, v.id, await fingerprintFile(this.config.media.ffmpegPath, file, info.hasAudio));
        done++;
      } catch (e) {
        this.log.warn(`${v.id}: no fingerprint: ${(e as Error).message.slice(0, 200)}`);
        // Unreadable: an empty fingerprint, so it is not tried again every run.
        await this.prisma.contentFingerprint.upsert({ where: { videoId: v.id }, create: { videoId: v.id, frames: Buffer.alloc(0), audio: Buffer.alloc(0) }, update: {} }).catch(() => undefined);
      } finally { await rm(work, { recursive: true, force: true }).catch(() => undefined); }
    }
    if (done) this.log.log({ event: 'fingerprints_backfilled', count: done });
    return done;
  }

  async expireSources(limit = 100, now = new Date()): Promise<number> {
    const days = this.config.media.sourceRetentionDays;
    if (!days) return 0;
    const rows = await this.prisma.video.findMany({
      where: { status: 'READY', processingStage: 'Ready', sourceFileS3Key: { not: null }, createdAt: { lt: new Date(now.getTime() - days * 86_400_000) },
        ...(this.config.media.whisper ? { captionAttemptedAt: { not: null } } : {}) },
      orderBy: { createdAt: 'asc' }, take: limit, select: { id: true },
    });
    let removed = 0;
    for (const { id } of rows) {
      try {
        await this.withLock(id, async () => {
          const v = await this.prisma.video.findUnique({ where: { id }, select: { sourceFileS3Key: true, status: true, processingStage: true } });
          if (!v?.sourceFileS3Key || v.status !== 'READY' || v.processingStage !== 'Ready') return;
          await this.storage.deletePrefix(`src/${id}/`);
          await this.prisma.video.update({ where: { id }, data: { sourceFileS3Key: null, hdPending: false } });
          removed++;
        });
      } catch (e) { if (!(e instanceof VideoBusy)) throw e; } // busy now: next run
    }
    if (removed) this.log.log({ event: 'sources_expired', count: removed, days });
    return removed;
  }

  async run(job: MediaJob, final: boolean, signal?: AbortSignal) {
    if (job.name === 'transcode') return this.transcode(job.videoId, final, signal);
    if (job.name === 'upgrade') return this.transcode(job.videoId, final, signal, 'rest');
    if (job.name === 'av1') return this.av1(job.videoId, signal);
    if (job.name === 'appeal') return this.appeal(job.videoId, signal);
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

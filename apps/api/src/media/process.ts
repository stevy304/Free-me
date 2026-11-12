import { Logger } from '@nestjs/common';
import type { Prisma, PrismaClient, Video } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import type { AppConfig } from '../config/config';
import { AUDIO, HD_RUNGS, codecsFor, isHighRung, masterPlaylist, planLadder, type MasterEntry, type PlannedRung } from './ladder';
import { BT709_H264, ffmpegFilters, loudnessFilter, measureLoudness, toneMap, type Hdr, type Loudness } from './filters';
import { AudioOnly, MediaError, keyframeGap, probe, run, type ProbeResult } from './probe';
import { mediaPrefix, wantedLocation } from './keys';
import { LATE_FOLDERS } from './captions';
import { extractSpeech } from './autocaptions';
import { hold, screen } from './screening';
import { announceVideo } from '../notifications/notify';
import type { Storage } from './storage';
import { publish, room } from '../realtime/publish';
import { hasPremiumAccess } from '../billing/billing';
import { feedsChanged } from '../catalog/feed-cache';
import { FIRST_KEYFRAMES, NEXT_KEYFRAMES, nodeName, chunkFile, chunkKey, videoChunksPrefix, type ChunkRunner, type ChunkTask } from './chunks';

const TYPES: Record<string, string> = { '.m3u8': 'application/vnd.apple.mpegurl', '.m4s': 'video/iso.segment', '.mp4': 'video/mp4', '.jpg': 'image/jpeg' };
const IMMUTABLE = 'public, max-age=31536000, immutable';
/** Playlists change when HD renditions are added, so they are cached briefly. */
const SHORT = 'public, max-age=30';
/** Every quality, for Premium viewers and the owner, when the free playlist is limited (FREE_MAX_QUALITY). */
export const FULL_MASTER = 'hls/master-full.m3u8';

/** Where seek-bar previews are: one sprite sheet of small frames, `interval` seconds apart, in rows of `cols`. */
export interface Storyboard { key: string; interval: number; count: number; cols: number; rows: number; width: number; height: number }
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
/** HLS output: 4 s fMP4 segments, the first 1 s so playback starts sooner (keyframes at 0, 1, 2, 4, 6 … s). */
const hlsArgs = (dir: string) => ['-f', 'hls', '-hls_time', '4', '-hls_init_time', '1', '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4', '-hls_flags', 'independent_segments',
  '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', join(dir, 'seg_%05d.m4s'), join(dir, 'index.m3u8')];
/** Which video a pass belongs to, for encoding in pieces (no source key: a podcast, made here, stays in one run). */
interface EncodeContext { videoId: string; sourceKey: string | null; background: boolean }

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p))); else out.push(p);
  }
  return out;
}

/**
 * Turns an uploaded source into adaptive HLS: probe → thumbnails → fast pass (up to 360p, the video becomes watchable)
 * → remaining rungs through 720p → 1080p and above. One decode feeds every rung of a pass. Re-running is safe: every
 * output overwrites the same keys and rendition rows are upserted.
 */
export class VideoProcessor {
  private readonly log = new Logger('Transcode');
  constructor(private readonly prisma: PrismaClient, private readonly storage: Storage, private readonly config: AppConfig,
    /** Encodes long videos in pieces (on every worker server through the queue); null: always in one run. */
    private readonly chunks: ChunkRunner | null = null) {}

  private async setProgress(id: string, progress: number, stage: string, extra: Partial<Video> = {}) {
    const p = Math.max(0, Math.min(100, Math.round(progress)));
    await this.prisma.video.update({ where: { id }, data: { processingProgress: p, processingStage: stage, ...extra } as never });
    publish(room.video(id), 'processing', { progress: p, stage });
  }

  /** Returns the extracted speech track (outside the work folder) when automatic captions should be made from it. */
  /**
   * `playable` (the first job): checks, thumbnails, the 360p rendition and seek previews, so the video can be watched
   * in seconds. It answers `more: true` when higher qualities remain: they are a second, lower-priority job
   * (`rest`), so every new upload becomes watchable before any video gets its 1080p. Podcasts and videos of 360p or
   * less finish in the first job.
   *
   * Popularity-based encoding: unless the video already has HD_MIN_VIEWS views or its creator is a Premium member,
   * 1080p and above are left out and the video is marked `hdPending`; the worker queues another `rest` job once it
   * is watched enough (see MediaJobs.popularUpgrades). A `rest` job only encodes rungs that are not published yet.
   */
  async process(videoId: string, signal?: AbortSignal, part: 'playable' | 'rest' = 'playable'): Promise<{ speech: string | null; more: boolean }> {
    const video = await this.prisma.video.findUnique({ where: { id: videoId }, include: { channel: { select: { user: { select: { premiumUntil: true, roles: true } } } } } });
    if (!video?.sourceFileS3Key) return { speech: null, more: false }; // deleted, or never uploaded
    if (part === 'rest' && !video.hlsMasterKey) part = 'playable'; // nothing playable yet: start from the beginning
    const started = performance.now();
    const timings: Record<string, number> = {};
    const timed = async <T>(name: string, operation: () => Promise<T>): Promise<T> => {
      const start = performance.now();
      try { return await operation(); }
      finally { timings[name] = Math.round(performance.now() - start); }
    };
    const work = join(this.config.media.scratchDir, videoId);
    await rm(work, { recursive: true, force: true });
    await mkdir(work, { recursive: true });
    try {
      const source = join(work, `source${extname(video.sourceFileS3Key) || '.bin'}`);
      if (part === 'playable') await this.setProgress(videoId, 1, 'Preparing');
      await timed('downloadMs', () => this.storage.download(video.sourceFileS3Key!, source, signal));
      signal?.throwIfAborted();
      let source2 = source;
      let podcast = false;
      let info: ProbeResult;
      try { info = await timed('probeMs', () => probe(this.config.media.ffprobePath, source)); }
      catch (e) {
        if (!(e instanceof AudioOnly)) throw e;
        // A podcast: the cover (if the creator gave one) with a moving waveform, 1280x720.
        await this.setProgress(videoId, 2, 'Making the podcast video');
        const seconds = e.durationSeconds;
        source2 = await timed('podcastMs', () => this.podcastVideo(video, source, work, seconds, signal));
        podcast = true;
        info = await probe(this.config.media.ffprobePath, source2);
      }
      const isShort = info.durationSeconds <= 180 && info.height >= info.width;
      const ladder = planLadder(info.width, info.height, info.fps);
      const first = ladder.filter((r) => r.short <= 360).at(-1) ?? ladder[0];
      const fast = [first];
      const remaining = ladder.filter((r) => r !== first);
      // The most expensive rungs wait until people actually watch the video (most uploads are rarely watched).
      const minViews = this.config.media.hdMinViews;
      const deferred = !podcast && minViews > 0 && video.viewCount < BigInt(minViews) && !hasPremiumAccess(video.channel.user) ? ladder.filter(isHighRung) : [];
      let passes = [remaining.filter((r) => r.short < first.short || HD_RUNGS.has(r.name)), remaining.filter(isHighRung)]
        .map((rungs) => rungs.filter((r) => !deferred.includes(r))).filter((rungs) => rungs.length);

      // HDR phone videos are converted to normal colour; without the filters they would play washed out and grey.
      const filters = await ffmpegFilters(this.config.media.ffmpegPath);
      const hdr: Hdr = info.hdr && filters.has('zscale') && filters.has('tonemap') ? info.hdr : null;
      if (info.hdr && !hdr) this.log.warn(`${videoId}: HDR source but this ffmpeg lacks zscale/tonemap; colours will look flat`);
      const done: MasterEntry[] = [];
      const fastWeight = passes.length ? 40 : 90;

      if (part === 'playable') {
        await this.setProgress(videoId, 4, 'Processing SD', { durationSeconds: Math.round(info.durationSeconds), width: info.width, height: info.height, isShort: isShort && !podcast, isPodcast: podcast } as Partial<Video>);
        // Nothing is published before the safety check: a match holds the video for a moderator.
        // The uploaded file itself is fingerprinted (for a podcast, the sound file).
        const held = await timed('screeningMs', () => screen(this.prisma, this.config, video, source, info, work));
        signal?.throwIfAborted();
        if (held) { await hold(this.prisma, videoId, held); this.log.warn(`${videoId}: held for review: ${held}`); return { speech: null, more: false }; }
        // These steps use independent video and audio streams. Keep the two-pass loudness target.
        const [thumbs, loud] = await Promise.all([
          timed('thumbnailsMs', () => this.thumbnails(source2, work, info, hdr, signal)),
          info.hasAudio ? timed('loudnessMs', () => measureLoudness(this.config.media.ffmpegPath, source2, signal)) : null,
        ]);
        signal?.throwIfAborted();
        await timed('sdEncodeMs', () => this.encode(source2, work, fast, info, hdr, info.hasAudio ? { loudness: loud } : null, (f) => this.setProgress(videoId, 5 + f * fastWeight, 'Processing SD').catch(() => undefined), signal, { videoId, sourceKey: podcast ? null : video.sourceFileS3Key!, background: false }));
        signal?.throwIfAborted();
        const playable = await timed('sdPublishMs', () => this.publish(videoId, work, fast, info, done, thumbs, passes.length ? 'Playable · adding qualities' : 'Playable · preparing seek previews', 5 + fastWeight));
        if (playable !== null && !video.hlsMasterKey) this.log.log({ event: 'video_first_playable', videoId, processingToPlayableMs: Math.round(playable - started), ...timings });
        // Seek previews from the 360p rendition just made: cheap, so they come with the first job.
        try {
          const board = await timed('storyboardMs', () => this.storyboard(join(work, 'out', 'hls', first.name, 'index.m3u8'), work, info, null, signal));
          const current = await this.prisma.video.findUniqueOrThrow({ where: { id: videoId }, select: { mediaLocation: true } });
          await this.storage.putFile(mediaPrefix(videoId, current.mediaLocation) + board.meta.key, board.file, { contentType: TYPES['.jpg'], cacheControl: IMMUTABLE });
          await this.prisma.video.update({ where: { id: videoId }, data: { storyboard: board.meta as unknown as Prisma.InputJsonValue } });
        } catch (e) {
          if (signal?.aborted) throw e;
          this.log.warn(`${videoId}: no seek previews: ${(e as Error).message.slice(0, 200)}`);
        }
        // Higher qualities run on a separate worker queue (a podcast's work dir holds its video: finish here).
        if (passes.length && !podcast) {
          await this.setProgress(videoId, 5 + fastWeight, 'Playable · adding qualities');
          this.log.log({ event: 'video_playable_job_done', videoId, ...timings });
          return { speech: null, more: true };
        }
      } else {
        // Second job: the renditions already published stay in the master playlist and are not encoded again.
        done.push(...await this.publishedEntries(videoId, ladder));
        const have = new Set(done.map((d) => d.name));
        passes = passes.map((rungs) => rungs.filter((r) => !have.has(r.name))).filter((rungs) => rungs.length);
      }

      // Higher qualities. The top rung is copied from the upload when it is already suitable H.264.
      const copyTop = await timed('copyCheckMs', () => this.copyPlan(ladder, info, hdr, source2, signal));
      const weight = (rungs: PlannedRung[]) => rungs.reduce((sum, rung) => sum + (rung === copyTop?.rung ? 0 : rung.width * rung.height), 400_000);
      const total = passes.reduce((sum, rungs) => sum + weight(rungs), 0);
      let progress = 5 + fastWeight;
      for (const [index, base] of passes.entries()) {
        const rungs = base.map((r) => (r === copyTop?.rung ? { ...r, copy: copyTop.copy } : r));
        const stage = 'Playable · adding qualities';
        const from = progress;
        const span = (95 - (5 + fastWeight)) * weight(base) / total;
        const quality = rungs.at(-1)!.name;
        await timed(`encode_${quality}Ms`, () => this.encode(source2, work, rungs, info, hdr, null, (f) => this.setProgress(videoId, from + f * span, stage).catch(() => undefined), signal, { videoId, sourceKey: podcast ? null : video.sourceFileS3Key!, background: true }));
        signal?.throwIfAborted();
        progress += span;
        await timed(`publish_${quality}Ms`, () => this.publish(videoId, work, rungs, info, done, null, index === passes.length - 1 ? 'Ready' : stage, Math.round(progress)));
      }
      signal?.throwIfAborted();
      await this.setProgress(videoId, 100, 'Ready', { hdPending: deferred.length > 0 } as Partial<Video>);
      this.log.log({ event: 'video_processing_complete', videoId, qualities: ladder.filter((r) => !deferred.includes(r)).map((r) => r.name), deferred: deferred.map((r) => r.name), copied: copyTop?.rung.name ?? null, ...timings });
      if (this.config.media.whisper && !info.hasAudio) {
        await this.prisma.video.updateMany({ where: { id: videoId }, data: { captionAttemptedAt: new Date() } });
      }
      if (!this.config.media.whisper || !info.hasAudio) return { speech: null, more: false };
      // The speech track for automatic captions, kept after the work folder goes; captioning runs after the lock.
      const speech = join(this.config.media.scratchDir, `${videoId}.speech.wav`);
      try { await extractSpeech(this.config.media.ffmpegPath, source2, speech, signal); return { speech, more: false }; }
      catch (e) { this.log.warn(`${videoId}: could not extract speech: ${(e as Error).message.slice(0, 200)}`); return { speech: null, more: false }; }
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Copying instead of encoding the top rung (often 1080p, the most expensive): only when the upload is H.264 8-bit
   * 4:2:0, normal colour, not rotated, exactly that size, at most 60 fps, at a bitrate viewers can stream, with a
   * keyframe at least every 4.5 s (segments are cut at keyframes). Otherwise it is encoded as usual.
   */
  private async copyPlan(ladder: PlannedRung[], info: ProbeResult, hdr: Hdr, source: string, signal?: AbortSignal): Promise<{ rung: PlannedRung; copy: { codecs: string; kbps: number } } | null> {
    const top = ladder.at(-1)!;
    if (!this.config.media.copyTopRung || ladder.length < 2 || !isHighRung(top)) return null;
    const profiles: Record<string, string> = { High: '6400', Main: '4d40', 'Constrained Baseline': '42e0', Baseline: '4200' };
    const ok = info.videoCodec === 'h264' && !info.hdr && !hdr && info.pixFmt === 'yuv420p' && !info.rotated && info.fps <= 60
      && top.width === info.width && top.height === info.height && !!info.profile && !!profiles[info.profile] && !!info.level && info.level <= 52
      && !!info.videoKbps && info.videoKbps <= top.maxKbps * 1.25;
    if (!ok) return null;
    const gap = await keyframeGap(this.config.media.ffprobePath, source, signal).catch(() => Infinity);
    if (gap > 4.5) return null;
    return { rung: top, copy: { codecs: `avc1.${profiles[info.profile!]}${info.level!.toString(16).padStart(2, '0')}`, kbps: info.videoKbps! } };
  }

  /** Master playlist entries of the renditions a video already has (for the second job). */
  private async publishedEntries(videoId: string, ladder: PlannedRung[]): Promise<MasterEntry[]> {
    const rows = await this.prisma.videoRendition.findMany({ where: { videoId } });
    return rows.map((r) => {
      const planned = ladder.find((p) => p.name === r.resolution);
      return { name: r.resolution, width: r.width, height: r.height, bandwidth: Math.max(planned?.maxKbps ?? 0, Math.round(r.bitrateKbps * 1.3)) * 1000, codecs: r.codecs, frameRate: r.frameRate, playlist: r.playlistKey.replace(/^hls\//, '') };
    });
  }


  /** Turns a sound file into a video: the creator's cover (or a plain dark picture) with a waveform along the bottom. */
  private async podcastVideo(video: Video, audio: string, work: string, seconds: number, signal?: AbortSignal): Promise<string> {
    const out = join(work, 'podcast.mp4');
    let cover: string | null = null;
    if (video.customThumbnail && video.thumbnailKey) {
      cover = join(work, `cover${extname(video.thumbnailKey) || '.jpg'}`);
      try { await this.storage.download(mediaPrefix(video.id, video.mediaLocation) + video.thumbnailKey, cover); } catch { cover = null; }
    }
    const fps = 15;
    const bg = cover ? ['-loop', '1', '-framerate', String(fps), '-i', cover] : ['-f', 'lavfi', '-i', `color=c=0x071312:s=1280x720:r=${fps}`];
    const graph = `[0:v]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,setsar=1,format=yuv420p[bg];`
      + `[1:a]showwaves=s=1280x120:mode=cline:colors=0x2bc4b8|0xffffff:rate=${fps},format=yuva420p[w];`
      + `[bg][w]overlay=0:H-h-36:shortest=1,format=yuv420p[v]`;
    await run(this.config.media.ffmpegPath, ['-hide_banner', '-y', ...bg, '-i', audio, '-filter_complex', graph, '-map', '[v]', '-map', '1:a', '-c:v', 'libx264', '-preset', this.config.media.preset, '-tune', 'stillimage', '-crf', '22', '-r', String(fps), '-c:a', 'aac', '-b:a', '192k', '-shortest', ...(seconds > 0 ? ['-t', seconds.toFixed(2)] : []), out], undefined, signal);
    return out;
  }

  /** Three frames (25%, 50%, 75%) the creator can choose from; the middle one is the default. */
  private async thumbnails(source: string, work: string, info: ProbeResult, hdr: Hdr, signal?: AbortSignal): Promise<string[]> {
    const dir = join(work, 'out', 'thumbs');
    await mkdir(dir, { recursive: true });
    const k = 1280 / Math.max(info.width, info.height);
    const scale = hdr ? toneMap(hdr, even(info.width * k), even(info.height * k)) : info.height > info.width ? 'scale=-2:1280' : 'scale=1280:-2';
    const files: string[] = [];
    for (const [i, at] of [0.25, 0.5, 0.75].entries()) {
      if (signal?.aborted) break;
      const out = join(dir, `${i + 1}.jpg`);
      try {
        await run(this.config.media.ffmpegPath, ['-hide_banner', '-y', '-ss', (info.durationSeconds * at).toFixed(2), '-i', source, '-frames:v', '1', '-vf', `${scale},format=yuvj420p`, '-q:v', '3', out], undefined, signal);
        files.push(out);
      } catch { /* a frame that cannot be read near the end is skipped */ }
    }
    return files;
  }

  /**
   * Seek-bar previews: up to 100 small frames (long side 160 px) on one JPEG sheet; videos over 10 minutes use
   * keyframes only, so it stays quick. The API turns the layout into a WebVTT track for the player.
   */
  private async storyboard(source: string, work: string, info: ProbeResult, hdr: Hdr, signal?: AbortSignal): Promise<{ file: string; meta: Storyboard }> {
    const interval = Math.max(2, Math.ceil(info.durationSeconds / 100));
    const count = Math.max(1, Math.min(100, Math.ceil(info.durationSeconds / interval)));
    const cols = Math.min(10, count);
    const rows = Math.ceil(count / cols);
    const landscape = info.width >= info.height;
    const width = landscape ? 160 : even((160 * info.width) / info.height);
    const height = landscape ? even((160 * info.height) / info.width) : 160;
    const dir = join(work, 'out', 'thumbs');
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'storyboard.jpg');
    const look = hdr ? toneMap(hdr, width, height) : `scale=${width}:${height}`;
    const sheet = (keyframesOnly: boolean) => run(this.config.media.ffmpegPath, ['-hide_banner', '-y', ...(keyframesOnly ? ['-skip_frame', 'nokey'] : []), '-i', source, '-an', '-vf', `fps=1/${interval},${look},format=yuvj420p,tile=${cols}x${rows}`, '-frames:v', '1', '-q:v', '5', file], undefined, signal);
    // Long videos: keyframes only (fast). If the source has too few keyframes that yields nothing: decode it all.
    if (info.durationSeconds > 3600) await sheet(true).catch(() => undefined);
    signal?.throwIfAborted();
    if (!(await stat(file).catch(() => null))) await sheet(false);
    return { file, meta: { key: 'thumbs/storyboard.jpg', interval, count, cols, rows, width, height } };
  }

  /**
   * One ffmpeg run: decode once, scale for each rung, H.264 HLS with 4 s fMP4 segments and 2 s keyframes. With
   * `audio`, also the one shared AAC rendition, loudness-normalised. HDR is tone mapped once, at the pass's top size.
   */
  private async encode(source: string, work: string, rungs: PlannedRung[], info: ProbeResult, hdr: Hdr, audio: { loudness: Loudness | null } | null, onProgress: (f: number) => void, signal?: AbortSignal, ctx?: EncodeContext) {
    const enc = this.config.media.encoder;
    if (enc === 'libx264') return this.encodeWith('libx264', source, work, rungs, info, hdr, audio, onProgress, signal, ctx);
    try { return await this.encodeWith(enc, source, work, rungs, info, hdr, audio, onProgress, signal, ctx); }
    catch (e) {
      if (signal?.aborted) throw e;
      // No usable GPU on this server (driver missing, out of sessions): the CPU does it instead.
      this.log.warn(`${enc} failed, using libx264: ${(e as Error).message.slice(-300)}`);
      return this.encodeWith('libx264', source, work, rungs, info, hdr, audio, onProgress, signal, ctx);
    }
  }

  /** H.264 settings for one rung: x264 (CPU) with a faster preset for 1080p and above, or a GPU encoder. */
  private videoArgs(enc: AppConfig['media']['encoder'], r: PlannedRung): string[] {
    const rate = ['-maxrate', `${r.maxKbps}k`, '-bufsize', `${r.maxKbps * 2}k`];
    if (enc === 'nvenc') return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'hq', '-profile:v', 'high', '-rc', 'vbr', '-cq', '23', '-b:v', `${r.videoKbps}k`, ...rate, '-forced-idr', '1'];
    if (enc === 'qsv') return ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-profile:v', 'high', '-global_quality', '23', '-b:v', `${r.videoKbps}k`, ...rate, '-forced_idr', '1'];
    return ['-c:v', 'libx264', '-preset', isHighRung(r) ? this.config.media.presetHigh : this.config.media.preset, '-profile:v', 'high', '-crf', '21', ...rate];
  }

  /**
   * The filter graph for a pass's encoded rungs, outputs [o0], [o1] …: the source is scaled once, to the pass's
   * largest rung, and the smaller rungs are made from that (much less work than scaling each from 1080p or 4K).
   */
  private videoFilter(enc: AppConfig['media']['encoder'], encoded: PlannedRung[], info: ProbeResult, hdr: Hdr): string | null {
    if (!encoded.length) return null;
    const fmt = `format=${enc === 'qsv' ? 'nv12' : 'yuv420p'}`;
    const top = encoded.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
    const pre = `${info.fps > 60 ? `fps=${Math.min(60, info.fps)},` : ''}${hdr ? `${toneMap(hdr, top.width, top.height)},` : ''}`;
    const scale = (r: PlannedRung) => `scale=${r.width}:${r.height}:flags=bicubic,${fmt}`;
    if (encoded.length === 1) return `[0:v]${pre}${scale(encoded[0])}[o0]`;
    const ti = encoded.indexOf(top);
    return `[0:v]${pre}scale=${top.width}:${top.height}:flags=bicubic,split=${encoded.length}${encoded.map((_, i) => `[s${i}]`).join('')};${encoded.map((r, i) => `[s${i}]${i === ti ? fmt : scale(r)}[o${i}]`).join(';')}`;
  }

  /**
   * A long video's encoded rungs in pieces of CHUNK_SECONDS: each piece is its own job that any worker can take
   * (on the 2-second keyframe grid), then each rung's pieces are joined without re-encoding and cut into HLS.
   * Same settings as one run, so viewers cannot tell the difference.
   */
  private async encodeChunked(enc: AppConfig['media']['encoder'], source: string, work: string, encoded: PlannedRung[], info: ProbeResult, hdr: Hdr, onProgress: (f: number) => void, signal: AbortSignal | undefined, ctx: EncodeContext & { sourceKey: string }) {
    const filter = this.videoFilter(enc, encoded, info, hdr)!;
    const length = this.config.media.chunkSeconds;
    // A short tail (under 2 s) joins the piece before it: a sliver could hold no frame at all. The last piece runs to the end.
    let count = Math.ceil(info.durationSeconds / length);
    if (count > 1 && info.durationSeconds - (count - 1) * length < 2) count -= 1;
    const runId = randomUUID().slice(0, 8);
    const dir = join(work, `chunks-${runId}`);
    await mkdir(dir, { recursive: true });
    const tasks: ChunkTask[] = Array.from({ length: count }, (_, index) => {
      const args = ['-hide_banner', '-y', '-nostats', '-ss', String(index * length), ...(index < count - 1 ? ['-t', String(length)] : []), '-i', '{IN}', '-filter_complex', filter];
      encoded.forEach((r, i) => args.push('-map', `[o${i}]`, ...(hdr ? BT709_H264 : []), ...this.videoArgs(enc, r),
        '-force_key_frames', index === 0 ? FIRST_KEYFRAMES : NEXT_KEYFRAMES, '-sc_threshold', '0', '-an', `{OUT:${r.name}}`));
      return { videoId: ctx.videoId, run: runId, index, args, rungs: encoded.map((r) => r.name), source: { host: nodeName(), path: source, key: ctx.sourceKey }, out: { host: nodeName(), dir }, niceness: ctx.background ? 10 : 0 };
    });
    try {
      const results = await this.chunks!.runAll(tasks, (n) => onProgress((n / count) * 0.95), signal);
      // Pieces made on other servers come through storage.
      await Promise.all(results.filter((r) => r.remote).flatMap((r) => encoded.map((rung) => this.storage.download(chunkKey(ctx.videoId, runId, r.index, rung.name), chunkFile(dir, r.index, rung.name), signal))));
      signal?.throwIfAborted();
      await Promise.all(encoded.map(async (r) => {
        const list = join(dir, `${r.name}.txt`);
        await writeFile(list, results.map((x) => `file '${chunkFile(dir, x.index, r.name).replace(/'/g, "'\\''")}'`).join('\n'));
        const out = join(work, 'out', 'hls', r.name);
        await mkdir(out, { recursive: true });
        await run(this.config.media.ffmpegPath, ['-hide_banner', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-map', '0:v:0', '-c:v', 'copy', ...hlsArgs(out)], undefined, signal);
      }));
      onProgress(1);
      this.log.log({ event: 'video_encoded_in_pieces', videoId: ctx.videoId, pieces: count, qualities: encoded.map((r) => r.name), remote: results.filter((r) => r.remote).length });
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      // The whole video's folder: also what an interrupted earlier attempt left (one job per video at a time).
      await this.storage.deletePrefix(videoChunksPrefix(ctx.videoId)).catch(() => undefined);
    }
  }

  private async encodeWith(enc: AppConfig['media']['encoder'], source: string, work: string, rungs: PlannedRung[], info: ProbeResult, hdr: Hdr, audio: { loudness: Loudness | null } | null, onProgress: (f: number) => void, signal?: AbortSignal, ctx?: EncodeContext) {
    if (!rungs.length && !audio) return;
    // A rung copied from the upload needs no filter; the others are scaled and encoded.
    const encoded = rungs.filter((r) => !r.copy);
    // A long video: the encoded rungs are made in pieces on every worker; the copied rungs and the sound meanwhile here.
    if (ctx?.sourceKey && this.chunks && this.config.media.chunked && encoded.length && info.durationSeconds >= this.config.media.chunkMinSeconds) {
      const others = rungs.filter((r) => r.copy);
      await Promise.all([
        this.encodeChunked(enc, source, work, encoded, info, hdr, onProgress, signal, ctx as EncodeContext & { sourceKey: string }),
        others.length || audio ? this.encodeWith(enc, source, work, others, info, hdr, audio, () => undefined, signal) : null,
      ]);
      return;
    }
    const filter = this.videoFilter(enc, encoded, info, hdr);
    const args = ['-hide_banner', '-y', '-nostats', '-progress', 'pipe:1', '-i', source, ...(filter ? ['-filter_complex', filter] : [])];
    for (const r of rungs) {
      const dir = join(work, 'out', 'hls', r.name);
      await mkdir(dir, { recursive: true });
      if (r.copy) { args.push('-map', '0:v:0', '-c:v', 'copy', ...hlsArgs(dir)); continue; }
      args.push('-map', `[o${encoded.indexOf(r)}]`, ...(hdr ? BT709_H264 : []));
      args.push(
        ...this.videoArgs(enc, r),
        '-force_key_frames', FIRST_KEYFRAMES, '-sc_threshold', '0', '-movflags', '+faststart',
        ...hlsArgs(dir),
      );
    }
    if (audio) {
      const dir = join(work, 'out', 'hls', 'audio');
      await mkdir(dir, { recursive: true });
      args.push('-map', '0:a:0', '-af', loudnessFilter(audio.loudness), '-c:a', 'aac', '-b:a', `${AUDIO.kbps}k`, '-ac', '2', '-ar', '48000', ...hlsArgs(dir));
    }
    let last = 0;
    await run(this.config.media.ffmpegPath, args, (chunk) => {
      const m = /out_time_us=(\d+)/.exec(chunk);
      if (!m) return;
      const f = Math.min(1, Number(m[1]) / 1e6 / info.durationSeconds);
      if (Date.now() - last > 2000) { last = Date.now(); onProgress(f); }
    }, signal);
  }

  /** Uploads a pass's files, records the renditions and rewrites the master playlist so players see the new rungs. */
  private async publish(videoId: string, work: string, rungs: PlannedRung[], info: ProbeResult, done: MasterEntry[], thumbs: string[] | null, stage: string, progress: number) {
    const video = await this.prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    const location = wantedLocation(video);
    const prefix = mediaPrefix(videoId, location);
    // Published (or made private) while processing: the earlier pass's files (SD, thumbnails) live in the other
    // place. Bring them along first, so nothing is left behind; this pass's playlists overwrite the old ones.
    const moveFrom = video.hlsMasterKey && video.mediaLocation !== location ? mediaPrefix(videoId, video.mediaLocation) : null;
    if (moveFrom) await this.storage.copyPrefix(moveFrom, prefix);
    const out = join(work, 'out');
    // The shared audio is encoded with the first pass and uploaded with it.
    const audioFiles = thumbs && info.hasAudio ? await walk(join(out, 'hls', 'audio')) : [];
    const files = [...(await Promise.all(rungs.map((r) => walk(join(out, 'hls', r.name))))).flat(), ...audioFiles, ...(thumbs ?? [])];
    let i = 0;
    await Promise.all(Array.from({ length: 16 }, async () => {
      while (i < files.length) {
        const f = files[i++];
        const key = prefix + relative(out, f).split(sep).join('/');
        const ext = extname(f);
        await this.storage.putFile(key, f, { contentType: TYPES[ext] ?? 'application/octet-stream', cacheControl: ext === '.m3u8' ? SHORT : IMMUTABLE });
      }
    }));
    for (const r of rungs) {
      const sizes = await Promise.all((await walk(join(out, 'hls', r.name))).map((f) => stat(f).then((s) => s.size)));
      const codecs = (r.copy?.codecs ?? codecsFor(r)) + (info.hasAudio ? `,${AUDIO.codecs}` : '');
      // Video only (the master playlist adds the shared audio); a copied rung at its own peak, with room.
      const bandwidth = r.copy ? Math.max(r.maxKbps, Math.round(r.copy.kbps * 1.3)) * 1000 : r.maxKbps * 1000;
      const data = { width: r.width, height: r.height, bitrateKbps: r.copy?.kbps ?? r.videoKbps, playlistKey: `hls/${r.name}/index.m3u8`, fileSizeBytes: BigInt(sizes.reduce((a, b) => a + b, 0)), codecs, frameRate: Math.min(60, info.fps) };
      await this.prisma.videoRendition.upsert({ where: { videoId_resolution: { videoId, resolution: r.name } }, create: { videoId, resolution: r.name, ...data }, update: data });
      // Replaces the entry an earlier, interrupted attempt left (the second job starts from what is published).
      const at = done.findIndex((d) => d.name === r.name);
      if (at >= 0) done.splice(at, 1);
      done.push({ name: r.name, width: r.width, height: r.height, bandwidth, codecs, frameRate: data.frameRate, playlist: `${r.name}/index.m3u8` });
    }
    // Free viewers get a master playlist up to FREE_MAX_QUALITY (what costs the most to deliver); Premium viewers and
    // the owner get every quality from master-full.m3u8. Without a limit (or nothing above it) there is one playlist.
    const cap = this.config.media.freeMaxShort;
    const free = cap ? done.filter((e) => Math.min(e.width, e.height) <= cap) : done;
    const limited = free.length > 0 && free.length < done.length;
    await this.storage.putBuffer(`${prefix}hls/master.m3u8`, Buffer.from(masterPlaylist(limited ? free : done, info.hasAudio)), { contentType: TYPES['.m3u8'], cacheControl: SHORT });
    if (limited) await this.storage.putBuffer(`${prefix}${FULL_MASTER}`, Buffer.from(masterPlaylist(done, info.hasAudio)), { contentType: TYPES['.m3u8'], cacheControl: SHORT });
    const thumbKeys = thumbs?.map((t) => `thumbs/${relative(join(out, 'thumbs'), t)}`);
    // Read again now: uploading takes a while, and in the meantime moderators may have removed the video
    // or the creator may have chosen a thumbnail, which the default frame must not replace.
    const now = await this.prisma.video.findUnique({ where: { id: videoId }, select: { takenDownAt: true, thumbnailKey: true } });
    await this.prisma.video.update({ where: { id: videoId }, data: {
      status: now?.takenDownAt ? 'SUSPENDED' : 'READY', mediaLocation: location, hlsMasterKey: 'hls/master.m3u8', hlsFullMasterKey: limited ? FULL_MASTER : null, processingProgress: progress, processingStage: stage, processingError: null,
      ...(thumbKeys?.length ? { thumbnailCandidates: thumbKeys, ...(now?.thumbnailKey ? {} : { thumbnailKey: thumbKeys[Math.min(1, thumbKeys.length - 1)] }) } : {}),
    } });
    const playable = now?.takenDownAt ? null : performance.now();
    await feedsChanged();
    await announceVideo(this.prisma, videoId);
    if (moveFrom) {
      // A custom thumbnail saved to the old place while this pass ran is picked up here (see the thumbnail upload).
      for (const dir of LATE_FOLDERS) await this.storage.copyPrefix(moveFrom + dir, prefix + dir);
      await this.storage.deletePrefix(moveFrom);
    }
    return playable;
  }
}

export { MediaError };

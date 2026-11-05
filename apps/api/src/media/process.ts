import { Logger } from '@nestjs/common';
import type { PrismaClient, Video } from '@prisma/client';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import type { AppConfig } from '../config/config';
import { FAST_RUNGS, codecsFor, masterPlaylist, planLadder, type MasterEntry, type PlannedRung } from './ladder';
import { MediaError, probe, run, type ProbeResult } from './probe';
import { mediaPrefix } from './keys';
import type { Storage } from './storage';

const TYPES: Record<string, string> = { '.m3u8': 'application/vnd.apple.mpegurl', '.m4s': 'video/iso.segment', '.mp4': 'video/mp4', '.jpg': 'image/jpeg' };
const IMMUTABLE = 'public, max-age=31536000, immutable';
/** Playlists change when HD renditions are added, so they are cached briefly. */
const SHORT = 'public, max-age=30';

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p))); else out.push(p);
  }
  return out;
}

/**
 * Turns an uploaded source into adaptive HLS: probe → thumbnails → fast pass (144p–360p, the video becomes watchable)
 * → full pass (480p up to the source's resolution). One decode feeds every rung of a pass. Re-running is safe: every
 * output overwrites the same keys and rendition rows are upserted.
 */
export class VideoProcessor {
  private readonly log = new Logger('Transcode');
  constructor(private readonly prisma: PrismaClient, private readonly storage: Storage, private readonly config: AppConfig) {}

  private async setProgress(id: string, progress: number, stage: string, extra: Partial<Video> = {}) {
    await this.prisma.video.update({ where: { id }, data: { processingProgress: Math.max(0, Math.min(100, Math.round(progress))), processingStage: stage, ...extra } as never });
  }

  async process(videoId: string, signal?: AbortSignal): Promise<void> {
    const video = await this.prisma.video.findUnique({ where: { id: videoId } });
    if (!video?.sourceFileS3Key) return; // deleted, or never uploaded
    const work = join(this.config.media.scratchDir, videoId);
    await rm(work, { recursive: true, force: true });
    await mkdir(work, { recursive: true });
    try {
      const source = join(work, `source${extname(video.sourceFileS3Key) || '.bin'}`);
      await this.setProgress(videoId, 1, 'Preparing');
      await this.storage.download(video.sourceFileS3Key, source);
      const info = await probe(this.config.media.ffprobePath, source);
      const isShort = info.durationSeconds <= 180 && info.height >= info.width;
      const ladder = planLadder(info.width, info.height, info.fps);
      const fast = ladder.filter((r) => FAST_RUNGS.has(r.name));
      const full = ladder.filter((r) => !FAST_RUNGS.has(r.name));
      await this.setProgress(videoId, 4, 'Processing SD', { durationSeconds: Math.round(info.durationSeconds), width: info.width, height: info.height, isShort } as Partial<Video>);

      const thumbs = await this.thumbnails(source, work, info);
      const done: MasterEntry[] = [];
      const fastWeight = full.length ? 40 : 90;
      await this.encode(source, work, fast, info, (f) => this.setProgress(videoId, 5 + f * fastWeight, 'Processing SD').catch(() => undefined), signal);
      await this.publish(videoId, work, fast, info, done, thumbs, full.length ? 'SD ready · processing HD' : 'Ready', 5 + fastWeight);
      if (full.length) {
        await this.encode(source, work, full, info, (f) => this.setProgress(videoId, 50 + f * 45, 'SD ready · processing HD').catch(() => undefined), signal);
        await this.publish(videoId, work, full, info, done, null, 'Ready', 100);
      }
      this.log.log(`${videoId}: ${ladder.map((r) => r.name).join(', ')} from ${info.width}x${info.height} ${info.durationSeconds.toFixed(1)}s`);
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Three frames (25%, 50%, 75%) the creator can choose from; the middle one is the default. */
  private async thumbnails(source: string, work: string, info: ProbeResult): Promise<string[]> {
    const dir = join(work, 'out', 'thumbs');
    await mkdir(dir, { recursive: true });
    const scale = info.height > info.width ? 'scale=-2:1280' : 'scale=1280:-2';
    const files: string[] = [];
    for (const [i, at] of [0.25, 0.5, 0.75].entries()) {
      const out = join(dir, `${i + 1}.jpg`);
      try {
        await run(this.config.media.ffmpegPath, ['-hide_banner', '-y', '-ss', (info.durationSeconds * at).toFixed(2), '-i', source, '-frames:v', '1', '-vf', `${scale},format=yuvj420p`, '-q:v', '3', out]);
        files.push(out);
      } catch { /* a frame that cannot be read near the end is skipped */ }
    }
    return files;
  }

  /** One ffmpeg run: decode once, scale for each rung, H.264/AAC HLS with 4 s fMP4 segments and 2 s keyframes. */
  private async encode(source: string, work: string, rungs: PlannedRung[], info: ProbeResult, onProgress: (f: number) => void, signal?: AbortSignal) {
    if (!rungs.length) return;
    const fps = Math.min(60, info.fps);
    const pre = info.fps > 60 ? `fps=${fps},` : '';
    const scale = (r: PlannedRung) => `scale=${r.width}:${r.height}:flags=bicubic,format=yuv420p`;
    const filter = rungs.length === 1
      ? `[0:v]${pre}${scale(rungs[0])}[o0]`
      : `[0:v]${pre}split=${rungs.length}${rungs.map((_, i) => `[s${i}]`).join('')};${rungs.map((r, i) => `[s${i}]${scale(r)}[o${i}]`).join(';')}`;
    const args = ['-hide_banner', '-y', '-nostats', '-progress', 'pipe:1', '-i', source, '-filter_complex', filter];
    for (const [i, r] of rungs.entries()) {
      const dir = join(work, 'out', 'hls', r.name);
      await mkdir(dir, { recursive: true });
      args.push('-map', `[o${i}]`);
      if (info.hasAudio) args.push('-map', '0:a:0', '-c:a', 'aac', '-b:a', `${r.audioKbps}k`, '-ac', '2', '-ar', '48000');
      args.push(
        '-c:v', 'libx264', '-preset', this.config.media.preset, '-profile:v', 'high', '-crf', '21', '-maxrate', `${r.maxKbps}k`, '-bufsize', `${r.maxKbps * 2}k`,
        '-force_key_frames', 'expr:gte(t,n_forced*2)', '-sc_threshold', '0', '-movflags', '+faststart',
        '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4', '-hls_flags', 'independent_segments',
        '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', join(dir, 'seg_%05d.m4s'), join(dir, 'index.m3u8'),
      );
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
    const location = video.visibility === 'PRIVATE' ? 'PRIVATE' : 'PUBLIC';
    const prefix = mediaPrefix(videoId, location);
    const out = join(work, 'out');
    const files = [...(await Promise.all(rungs.map((r) => walk(join(out, 'hls', r.name))))).flat(), ...(thumbs ?? [])];
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
      const codecs = codecsFor(r, info.hasAudio);
      const bandwidth = (r.maxKbps + (info.hasAudio ? r.audioKbps : 0)) * 1000;
      const data = { width: r.width, height: r.height, bitrateKbps: r.videoKbps, playlistKey: `hls/${r.name}/index.m3u8`, fileSizeBytes: BigInt(sizes.reduce((a, b) => a + b, 0)), codecs, frameRate: Math.min(60, info.fps) };
      await this.prisma.videoRendition.upsert({ where: { videoId_resolution: { videoId, resolution: r.name } }, create: { videoId, resolution: r.name, ...data }, update: data });
      done.push({ name: r.name, width: r.width, height: r.height, bandwidth, codecs, frameRate: data.frameRate, playlist: `${r.name}/index.m3u8` });
    }
    await this.storage.putBuffer(`${prefix}hls/master.m3u8`, Buffer.from(masterPlaylist(done)), { contentType: TYPES['.m3u8'], cacheControl: SHORT });
    const thumbKeys = thumbs?.map((t) => `thumbs/${relative(join(out, 'thumbs'), t)}`);
    await this.prisma.video.update({ where: { id: videoId }, data: {
      status: 'READY', mediaLocation: location, hlsMasterKey: 'hls/master.m3u8', processingProgress: progress, processingStage: stage, processingError: null,
      ...(thumbKeys?.length ? { thumbnailCandidates: thumbKeys, ...(video.customThumbnail ? {} : { thumbnailKey: thumbKeys[Math.min(1, thumbKeys.length - 1)] }) } : {}),
    } });
  }
}

export { MediaError };

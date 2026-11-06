import { Logger } from '@nestjs/common';
import type { Prisma, PrismaClient, Video } from '@prisma/client';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import type { AppConfig } from '../config/config';
import { AUDIO, FAST_RUNGS, HD_RUNGS, codecsFor, isHighRung, masterPlaylist, planLadder, type MasterEntry, type PlannedRung } from './ladder';
import { BT709_TAGS, ffmpegFilters, loudnessFilter, measureLoudness, toneMap, type Hdr, type Loudness } from './filters';
import { AudioOnly, MediaError, probe, run, type ProbeResult } from './probe';
import { mediaPrefix, wantedLocation } from './keys';
import { LATE_FOLDERS } from './captions';
import { extractSpeech } from './autocaptions';
import { hold, screen } from './screening';
import { announceVideo } from '../notifications/notify';
import type { Storage } from './storage';
import { publish, room } from '../realtime/publish';

const TYPES: Record<string, string> = { '.m3u8': 'application/vnd.apple.mpegurl', '.m4s': 'video/iso.segment', '.mp4': 'video/mp4', '.jpg': 'image/jpeg' };
const IMMUTABLE = 'public, max-age=31536000, immutable';
/** Playlists change when HD renditions are added, so they are cached briefly. */
const SHORT = 'public, max-age=30';

/** Where seek-bar previews are: one sprite sheet of small frames, `interval` seconds apart, in rows of `cols`. */
export interface Storyboard { key: string; interval: number; count: number; cols: number; rows: number; width: number; height: number }
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p))); else out.push(p);
  }
  return out;
}

/**
 * Turns an uploaded source into adaptive HLS: probe → thumbnails → SD pass (144p–360p, the video becomes watchable)
 * → HD pass (480p, 720p) → full HD pass (1080p up to the source's resolution). One decode feeds every rung of a pass. Re-running is safe: every
 * output overwrites the same keys and rendition rows are upserted.
 */
export class VideoProcessor {
  private readonly log = new Logger('Transcode');
  constructor(private readonly prisma: PrismaClient, private readonly storage: Storage, private readonly config: AppConfig) {}

  private async setProgress(id: string, progress: number, stage: string, extra: Partial<Video> = {}) {
    const p = Math.max(0, Math.min(100, Math.round(progress)));
    await this.prisma.video.update({ where: { id }, data: { processingProgress: p, processingStage: stage, ...extra } as never });
    publish(room.video(id), 'processing', { progress: p, stage });
  }

  /** Returns the extracted speech track (outside the work folder) when automatic captions should be made from it. */
  async process(videoId: string, signal?: AbortSignal): Promise<{ speech: string | null }> {
    const video = await this.prisma.video.findUnique({ where: { id: videoId } });
    if (!video?.sourceFileS3Key) return { speech: null }; // deleted, or never uploaded
    const work = join(this.config.media.scratchDir, videoId);
    await rm(work, { recursive: true, force: true });
    await mkdir(work, { recursive: true });
    try {
      const source = join(work, `source${extname(video.sourceFileS3Key) || '.bin'}`);
      await this.setProgress(videoId, 1, 'Preparing');
      // How long each step takes, in the log line at the end (for operators sizing media servers).
      const times: string[] = []; let tick = Date.now();
      const mark = (what: string) => { const now = Date.now(); times.push(`${what} ${((now - tick) / 1000).toFixed(1)}s`); tick = now; };
      await this.storage.download(video.sourceFileS3Key, source);
      mark('download');
      let source2 = source;
      let podcast = false;
      let info: ProbeResult;
      try { info = await probe(this.config.media.ffprobePath, source); }
      catch (e) {
        if (!(e instanceof AudioOnly)) throw e;
        // A podcast: the cover (if the creator gave one) with a moving waveform, 1280x720.
        await this.setProgress(videoId, 2, 'Making the podcast video');
        source2 = await this.podcastVideo(video, source, work, e.durationSeconds, signal);
        podcast = true;
        info = await probe(this.config.media.ffprobePath, source2);
      }
      const isShort = info.durationSeconds <= 180 && info.height >= info.width;
      const ladder = planLadder(info.width, info.height, info.fps);
      const fast = ladder.filter((r) => FAST_RUNGS.has(r.name));
      const hd = ladder.filter((r) => HD_RUNGS.has(r.name));
      const full = ladder.filter((r) => !FAST_RUNGS.has(r.name) && !HD_RUNGS.has(r.name));
      await this.setProgress(videoId, 4, 'Processing SD', { durationSeconds: Math.round(info.durationSeconds), width: info.width, height: info.height, isShort: isShort && !podcast, isPodcast: podcast } as Partial<Video>);

      // HDR phone videos are converted to normal colour; without the filters they would play washed out and grey.
      const filters = await ffmpegFilters(this.config.media.ffmpegPath);
      const hdr: Hdr = info.hdr && filters.has('zscale') && filters.has('tonemap') ? info.hdr : null;
      if (info.hdr && !hdr) this.log.warn(`${videoId}: HDR source but this ffmpeg lacks zscale/tonemap; colours will look flat`);
      // Nothing is published before the safety check: a match holds the video for a moderator.
      // The uploaded file itself is fingerprinted (for a podcast, the sound file).
      const held = await screen(this.prisma, this.config, video, source, info, work);
      if (held) { await hold(this.prisma, videoId, held); this.log.warn(`${videoId}: held for review: ${held}`); return { speech: null }; }
      mark('checks');
      // Thumbnails, seek-bar previews and the loudness measurement are independent: all at once.
      // Audio once, at the same loudness as every other video (measured first, then one linear gain).
      const [thumbs, loud] = await Promise.all([
        this.thumbnails(source2, work, info, hdr),
        info.hasAudio ? measureLoudness(this.config.media.ffmpegPath, source2, signal) : Promise.resolve(null),
      ]);
      mark('thumbnails, loudness');
      const done: MasterEntry[] = [];
      // Progress shares by the work each pass does (pixels): SD is quick, the top rungs are most of it.
      const passes = [fast, hd, full].filter((p) => p.length);
      const weight = (p: PlannedRung[]) => p.reduce((a, r) => a + r.width * r.height, 0) + 400_000; // + decoding
      const total = passes.reduce((a, p) => a + weight(p), 0);
      let at = 5;
      const span = (p: PlannedRung[]) => (90 * weight(p)) / total;
      const stageAfter = (i: number) => (i === passes.length - 1 ? 'Ready' : passes[i + 1] === hd ? 'SD ready · processing HD' : `${passes[i] === hd ? 'HD' : 'SD'} ready · processing ${passes[i + 1][0].name}`);
      for (const [i, p] of passes.entries()) {
        const label = i === 0 ? 'Processing SD' : stageAfter(i - 1);
        const from = at; const width = span(p);
        await this.encode(source2, work, p, info, hdr, i === 0 && info.hasAudio ? { loudness: loud } : null, (f) => this.setProgress(videoId, from + f * width, label).catch(() => undefined), signal);
        at += width;
        // Seek-bar previews come from the small rendition just made (decoding 360p is a fraction of the source's
        // cost, and its colours are already converted from HDR).
        const small = p.reduce((a, r) => (r.width * r.height > a.width * a.height ? r : a));
        const board = i === 0 ? await this.storyboard(join(work, 'out', 'hls', small.name, 'index.m3u8'), work, info, null).catch((e) => { this.log.warn(`${videoId}: no seek previews: ${(e as Error).message.slice(0, 200)}`); return null; }) : null;
        await this.publish(videoId, work, p, info, done, i === 0 ? { thumbs, board } : null, stageAfter(i), i === passes.length - 1 ? 100 : at);
        mark(p.map((r) => r.name).join('+'));
      }
      this.log.log(`${videoId}: ${ladder.map((r) => r.name).join(', ')} from ${info.width}x${info.height} ${info.durationSeconds.toFixed(1)}s (${times.join(', ')})`);
      if (!this.config.media.whisper || !info.hasAudio) return { speech: null };
      // The speech track for automatic captions, kept after the work folder goes; captioning runs after the lock.
      const speech = join(this.config.media.scratchDir, `${videoId}.speech.wav`);
      try { await extractSpeech(this.config.media.ffmpegPath, source2, speech, signal); return { speech }; }
      catch (e) { this.log.warn(`${videoId}: could not extract speech: ${(e as Error).message.slice(0, 200)}`); return { speech: null }; }
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => undefined);
    }
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
  private async thumbnails(source: string, work: string, info: ProbeResult, hdr: Hdr): Promise<string[]> {
    const dir = join(work, 'out', 'thumbs');
    await mkdir(dir, { recursive: true });
    const k = 1280 / Math.max(info.width, info.height);
    const scale = hdr ? toneMap(hdr, even(info.width * k), even(info.height * k)) : info.height > info.width ? 'scale=-2:1280' : 'scale=1280:-2';
    // The three frames at once (each is a seek and a single decoded frame).
    const files = await Promise.all([0.25, 0.5, 0.75].map(async (at, i) => {
      const out = join(dir, `${i + 1}.jpg`);
      try {
        await run(this.config.media.ffmpegPath, ['-hide_banner', '-y', '-ss', (info.durationSeconds * at).toFixed(2), '-i', source, '-frames:v', '1', '-vf', `${scale},format=yuvj420p`, '-q:v', '3', out]);
        return out;
      } catch { return null; /* a frame that cannot be read near the end is skipped */ }
    }));
    return files.filter((f): f is string => !!f);
  }

  /**
   * Seek-bar previews: up to 100 small frames (long side 160 px) on one JPEG sheet; videos over 10 minutes use
   * keyframes only, so it stays quick. The API turns the layout into a WebVTT track for the player.
   */
  private async storyboard(source: string, work: string, info: ProbeResult, hdr: Hdr): Promise<{ file: string; meta: Storyboard }> {
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
    const sheet = (keyframesOnly: boolean) => run(this.config.media.ffmpegPath, ['-hide_banner', '-y', ...(keyframesOnly ? ['-skip_frame', 'nokey'] : []), '-i', source, '-an', '-vf', `fps=1/${interval},${look},format=yuvj420p,tile=${cols}x${rows}`, '-frames:v', '1', '-q:v', '5', file]);
    // From a small rendition every frame is cheap to decode. Very long videos: keyframes only (one every 2 s).
    if (info.durationSeconds > 3600) await sheet(true).catch(() => undefined);
    if (!(await stat(file).catch(() => null))) await sheet(false);
    return { file, meta: { key: 'thumbs/storyboard.jpg', interval, count, cols, rows, width, height } };
  }

  /**
   * One ffmpeg run: decode once, scale for each rung, H.264 HLS with 4 s fMP4 segments and 2 s keyframes. With
   * `audio`, also the one shared AAC rendition, loudness-normalised. HDR is tone mapped once, at the pass's top size.
   */
  private async encode(source: string, work: string, rungs: PlannedRung[], info: ProbeResult, hdr: Hdr, audio: { loudness: Loudness | null } | null, onProgress: (f: number) => void, signal?: AbortSignal) {
    const enc = this.config.media.encoder;
    if (enc === 'libx264') return this.encodeWith('libx264', source, work, rungs, info, hdr, audio, onProgress, signal);
    try { return await this.encodeWith(enc, source, work, rungs, info, hdr, audio, onProgress, signal); }
    catch (e) {
      if (signal?.aborted) throw e;
      // No usable GPU on this server (driver missing, out of sessions): the CPU does it instead.
      this.log.warn(`${enc} failed, using libx264: ${(e as Error).message.slice(-300)}`);
      return this.encodeWith('libx264', source, work, rungs, info, hdr, audio, onProgress, signal);
    }
  }

  /** H.264 settings for one rung: x264 (CPU) with a faster preset for 1080p and above, or a GPU encoder. */
  private videoArgs(enc: AppConfig['media']['encoder'], r: PlannedRung): string[] {
    const rate = ['-maxrate', `${r.maxKbps}k`, '-bufsize', `${r.maxKbps * 2}k`];
    if (enc === 'nvenc') return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'hq', '-profile:v', 'high', '-rc', 'vbr', '-cq', '23', '-b:v', `${r.videoKbps}k`, ...rate, '-forced-idr', '1'];
    if (enc === 'qsv') return ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-profile:v', 'high', '-global_quality', '23', '-b:v', `${r.videoKbps}k`, ...rate, '-forced_idr', '1'];
    return ['-c:v', 'libx264', '-preset', isHighRung(r) ? this.config.media.presetHigh : this.config.media.preset, '-profile:v', 'high', '-crf', '21', ...rate];
  }

  private async encodeWith(enc: AppConfig['media']['encoder'], source: string, work: string, rungs: PlannedRung[], info: ProbeResult, hdr: Hdr, audio: { loudness: Loudness | null } | null, onProgress: (f: number) => void, signal?: AbortSignal) {
    if (!rungs.length) return;
    const fps = Math.min(60, info.fps);
    const top = rungs.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
    const pre = `${info.fps > 60 ? `fps=${fps},` : ''}${hdr ? `${toneMap(hdr, top.width, top.height)},` : ''}`;
    const scale = (r: PlannedRung) => `scale=${r.width}:${r.height}:flags=bicubic,format=${enc === 'qsv' ? 'nv12' : 'yuv420p'}`;
    // Scale the source once, to the pass's largest rung; the smaller rungs are made from that (much less work
    // than scaling each one from a 1080p or 4K source).
    const ti = rungs.indexOf(top);
    const toTop = `scale=${top.width}:${top.height}:flags=bicubic`;
    const filter = rungs.length === 1
      ? `[0:v]${pre}${scale(rungs[0])}[o0]`
      : `[0:v]${pre}${toTop},split=${rungs.length}${rungs.map((_, i) => `[s${i}]`).join('')};${rungs.map((r, i) => `[s${i}]${i === ti ? `format=${enc === 'qsv' ? 'nv12' : 'yuv420p'}` : scale(r)}[o${i}]`).join(';')}`;
    const args = ['-hide_banner', '-y', '-nostats', '-progress', 'pipe:1', '-i', source, '-filter_complex', filter];
    for (const [i, r] of rungs.entries()) {
      const dir = join(work, 'out', 'hls', r.name);
      await mkdir(dir, { recursive: true });
      args.push('-map', `[o${i}]`, ...(hdr ? BT709_TAGS : []));
      args.push(
        ...this.videoArgs(enc, r),
        '-force_key_frames', 'expr:gte(t,n_forced*2)', '-sc_threshold', '0', '-movflags', '+faststart',
        '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4', '-hls_flags', 'independent_segments',
        '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', join(dir, 'seg_%05d.m4s'), join(dir, 'index.m3u8'),
      );
    }
    if (audio) {
      const dir = join(work, 'out', 'hls', 'audio');
      await mkdir(dir, { recursive: true });
      args.push('-map', '0:a:0', '-af', loudnessFilter(audio.loudness), '-c:a', 'aac', '-b:a', `${AUDIO.kbps}k`, '-ac', '2', '-ar', '48000',
        '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4', '-hls_flags', 'independent_segments',
        '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', join(dir, 'seg_%05d.m4s'), join(dir, 'index.m3u8'));
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
  private async publish(videoId: string, work: string, rungs: PlannedRung[], info: ProbeResult, done: MasterEntry[], first: { thumbs: string[]; board: { file: string; meta: Storyboard } | null } | null, stage: string, progress: number) {
    const thumbs = first?.thumbs ?? null;
    const video = await this.prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    const location = wantedLocation(video);
    const prefix = mediaPrefix(videoId, location);
    // Published (or made private) while processing: the earlier pass's files (SD, thumbnails) live in the other
    // place. Bring them along first, so nothing is left behind; this pass's playlists overwrite the old ones.
    const moveFrom = video.hlsMasterKey && video.mediaLocation !== location ? mediaPrefix(videoId, video.mediaLocation) : null;
    if (moveFrom) await this.storage.copyPrefix(moveFrom, prefix);
    const out = join(work, 'out');
    // The shared audio is encoded with the first pass and uploaded with it.
    const audioFiles = first && info.hasAudio ? await walk(join(out, 'hls', 'audio')) : [];
    const files = [...(await Promise.all(rungs.map((r) => walk(join(out, 'hls', r.name))))).flat(), ...audioFiles, ...(thumbs ?? []), ...(first?.board ? [first.board.file] : [])];
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
      const codecs = codecsFor(r) + (info.hasAudio ? `,${AUDIO.codecs}` : '');
      const bandwidth = r.maxKbps * 1000; // video only; the master playlist adds the shared audio
      const data = { width: r.width, height: r.height, bitrateKbps: r.videoKbps, playlistKey: `hls/${r.name}/index.m3u8`, fileSizeBytes: BigInt(sizes.reduce((a, b) => a + b, 0)), codecs, frameRate: Math.min(60, info.fps) };
      await this.prisma.videoRendition.upsert({ where: { videoId_resolution: { videoId, resolution: r.name } }, create: { videoId, resolution: r.name, ...data }, update: data });
      done.push({ name: r.name, width: r.width, height: r.height, bandwidth, codecs, frameRate: data.frameRate, playlist: `${r.name}/index.m3u8` });
    }
    await this.storage.putBuffer(`${prefix}hls/master.m3u8`, Buffer.from(masterPlaylist(done, info.hasAudio)), { contentType: TYPES['.m3u8'], cacheControl: SHORT });
    const thumbKeys = thumbs?.map((t) => `thumbs/${relative(join(out, 'thumbs'), t)}`);
    // Read again now: uploading takes a while, and in the meantime moderators may have removed the video
    // or the creator may have chosen a thumbnail, which the default frame must not replace.
    const now = await this.prisma.video.findUnique({ where: { id: videoId }, select: { takenDownAt: true, thumbnailKey: true } });
    await this.prisma.video.update({ where: { id: videoId }, data: {
      status: now?.takenDownAt ? 'SUSPENDED' : 'READY', mediaLocation: location, hlsMasterKey: 'hls/master.m3u8', processingProgress: progress, processingStage: stage, processingError: null,
      ...(first?.board ? { storyboard: first.board.meta as unknown as Prisma.InputJsonValue } : {}),
      ...(thumbKeys?.length ? { thumbnailCandidates: thumbKeys, ...(now?.thumbnailKey ? {} : { thumbnailKey: thumbKeys[Math.min(1, thumbKeys.length - 1)] }) } : {}),
    } });
    await announceVideo(this.prisma, videoId);
    if (moveFrom) {
      // A custom thumbnail saved to the old place while this pass ran is picked up here (see the thumbnail upload).
      for (const dir of LATE_FOLDERS) await this.storage.copyPrefix(moveFrom + dir, prefix + dir);
      await this.storage.deletePrefix(moveFrom);
    }
  }
}

export { MediaError };

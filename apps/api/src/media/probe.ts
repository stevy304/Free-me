import { spawn } from 'node:child_process';
import { setPriority } from 'node:os';
import { hdrOf, type Hdr } from './filters';

/**
 * Video apps whose downloads carry their marks inside the file. TikTok (and Douyin) write a `vid:` comment and other
 * tags into every video saved from the app; the others name themselves in a tag. A screen recording carries none:
 * the AI moderator looks for the watermark in the pictures instead (safety/ai.ts).
 */
const APP_MARKS: Array<[RegExp, string]> = [
  [/^vid:v[0-9a-z]{6,}/i, 'TikTok'], [/aigc_info|tiktok|musical\.ly|bytedance/i, 'TikTok'], [/douyin/i, 'Douyin'],
  [/\bkwai\b|kuaishou/i, 'Kwai'], [/\blikee\b/i, 'Likee'], [/snapchat/i, 'Snapchat'], [/\btriller\b/i, 'Triller'],
  // Download tools write the page they took the video from (e.g. a "comment" or "purl" tag).
  [/(?:youtube\.com|youtu\.be)\//i, 'YouTube'], [/instagram\.com\//i, 'Instagram'], [/(?:facebook\.com|fb\.watch)\//i, 'Facebook'], [/(?:twitter\.com|x\.com)\/\w+\/status/i, 'X'],
  [/vimeo\.com\//i, 'Vimeo'], [/dailymotion\.com\/|dai\.ly\//i, 'Dailymotion'], [/twitch\.tv\//i, 'Twitch'], [/pinterest\.\w+\/|pin\.it\//i, 'Pinterest'],
  [/threads\.net\//i, 'Threads'], [/(?:^|\/\/)t\.me\//i, 'Telegram'], [/snackvideo\.com\//i, 'Snack Video'], [/bigo\.tv\//i, 'Bigo Live'], [/kick\.com\//i, 'Kick'],
  [/netflix\.com\//i, 'Netflix'], [/showmax\.com\//i, 'Showmax'],
];
/** The app a downloaded video came from, by the marks in its file (container and stream tags), or null. */
export function madeByApp(tags: Array<Record<string, unknown> | undefined>): string | null {
  for (const t of tags) {
    for (const [key, value] of Object.entries(t ?? {})) {
      for (const [re, app] of APP_MARKS) if (re.test(key) || re.test(String(value))) return app;
    }
  }
  return null;
}

export interface ProbeResult {
  /** Downloaded from another video app (its marks are in the file), e.g. 'TikTok'; null otherwise. */
  madeBy?: string | null;
  durationSeconds: number; width: number; height: number; fps: number; hasAudio: boolean; videoCodec: string; hdr: Hdr;
  /** For copying the video as it is (no re-encoding): its pixel format, H.264 profile and level, bitrate and rotation. */
  pixFmt?: string; profile?: string; level?: number; videoKbps?: number; rotated?: boolean;
}

export class MediaError extends Error {
  /** A problem with the file itself: retrying will not help, and the message is shown to the creator. */
  constructor(message: string) { super(message); }
}

export function run(cmd: string, args: string[], onStdout?: (chunk: string) => void, signal?: AbortSignal, niceness = 0): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    // Wait for the child to exit before callers remove its scratch files or release a video lease.
    // Some encoders ignore SIGTERM; bound cancellation with a forced kill.
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let aborted = false;
    const onAbort = () => {
      if (aborted) return;
      aborted = true;
      p.kill('SIGTERM');
      killTimer = setTimeout(() => p.kill('SIGKILL'), 5_000);
      killTimer.unref();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    // Background work (higher qualities) yields the CPU to work a viewer is waiting for.
    if (niceness && p.pid) { try { setPriority(p.pid, niceness); } catch { /* not allowed here: run at normal priority */ } }
    let stdout = ''; let stderr = '';
    p.stdout.on('data', (d: Buffer) => { const s = d.toString(); if (onStdout) onStdout(s); else stdout += s; });
    p.stderr.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-20_000); });
    let spawnError: Error | undefined;
    p.on('error', (error) => { spawnError = error; });
    p.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (killTimer) clearTimeout(killTimer);
      if (aborted) reject(signal?.reason ?? new Error('Processing canceled'));
      else if (spawnError) reject(spawnError);
      else if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited with ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

/** The file is sound only (a podcast or a song): it is turned into a video before processing. */
export class AudioOnly extends Error { constructor(readonly durationSeconds: number) { super('audio only'); } }

/** Reads what the file really is (never trusting its name). Throws MediaError for files that are not usable video. */
export async function probe(ffprobe: string, path: string): Promise<ProbeResult> {
  let out: string;
  try { out = (await run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path])).stdout; }
  catch { throw new MediaError('This file could not be read as a video. Upload an MP4, MOV, MKV, WebM or another common video format.'); }
  const data = JSON.parse(out) as { format?: { duration?: string; tags?: Record<string, unknown> }; streams?: Array<Record<string, any>> };
  const v = data.streams?.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  if (!v || !v.width || !v.height) {
    if (data.streams?.some((s) => s.codec_type === 'audio')) throw new AudioOnly(Number(data.format?.duration ?? 0));
    throw new MediaError('This file has no video picture. Upload a video file.');
  }
  const duration = Number(data.format?.duration ?? v.duration ?? 0);
  if (!(duration > 0)) throw new MediaError('This video has no length. The file may be damaged.');
  const rotation = Math.abs(Number(v.tags?.rotate ?? v.side_data_list?.find((d: any) => d.rotation !== undefined)?.rotation ?? 0)) % 180;
  const [w, h] = rotation === 90 ? [v.height, v.width] : [v.width, v.height];
  const [num, den] = String(v.avg_frame_rate || v.r_frame_rate || '30/1').split('/').map(Number);
  const fps = den ? num / den : 30;
  const fmt = data.format as { duration?: string; bit_rate?: string } | undefined;
  // The video's own bitrate, or (when the container does not say) the file's, which includes the audio.
  const bps = Number(v.bit_rate) || Number(fmt?.bit_rate) || 0;
  return {
    madeBy: madeByApp([data.format?.tags, ...(data.streams ?? []).map((st) => st.tags as Record<string, unknown> | undefined)]),
    durationSeconds: duration, width: w, height: h, fps: Number.isFinite(fps) && fps > 0 && fps < 241 ? fps : 30, hasAudio: !!data.streams?.some((s) => s.codec_type === 'audio'), videoCodec: v.codec_name, hdr: hdrOf(v),
    pixFmt: v.pix_fmt, profile: v.profile, level: Number(v.level) || undefined, videoKbps: bps ? Math.round(bps / 1000) : undefined, rotated: rotation !== 0 || Math.abs(Number(v.tags?.rotate ?? v.side_data_list?.find((d: any) => d.rotation !== undefined)?.rotation ?? 0)) % 360 !== 0,
  };
}

/** Largest gap between keyframes (seconds) in the first two minutes: copied video is cut into segments at keyframes. */
export async function keyframeGap(ffprobe: string, path: string, signal?: AbortSignal): Promise<number> {
  const { stdout } = await run(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-skip_frame', 'nokey', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', '-read_intervals', '%+120', path], undefined, signal);
  const t = stdout.split(/[\n,]/).map((x) => x.trim()).filter(Boolean).map(Number).filter((x) => Number.isFinite(x));
  if (t.length < 2) return Infinity;
  let gap = 0;
  for (let i = 1; i < t.length; i++) gap = Math.max(gap, t[i] - t[i - 1]);
  return gap;
}

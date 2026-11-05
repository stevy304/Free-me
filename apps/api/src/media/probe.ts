import { spawn } from 'node:child_process';
import { hdrOf, type Hdr } from './filters';

export interface ProbeResult { durationSeconds: number; width: number; height: number; fps: number; hasAudio: boolean; videoCodec: string; hdr: Hdr }

export class MediaError extends Error {
  /** A problem with the file itself: retrying will not help, and the message is shown to the creator. */
  constructor(message: string) { super(message); }
}

export function run(cmd: string, args: string[], onStdout?: (chunk: string) => void, signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], signal });
    let stdout = ''; let stderr = '';
    p.stdout.on('data', (d: Buffer) => { const s = d.toString(); if (onStdout) onStdout(s); else stdout += s; });
    p.stderr.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-20_000); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${cmd} exited with ${code}: ${stderr.slice(-2000)}`))));
  });
}

/** Reads what the file really is (never trusting its name). Throws MediaError for files that are not usable video. */
export async function probe(ffprobe: string, path: string): Promise<ProbeResult> {
  let out: string;
  try { out = (await run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path])).stdout; }
  catch { throw new MediaError('This file could not be read as a video. Upload an MP4, MOV, MKV, WebM or another common video format.'); }
  const data = JSON.parse(out) as { format?: { duration?: string }; streams?: Array<Record<string, any>> };
  const v = data.streams?.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  if (!v || !v.width || !v.height) throw new MediaError('This file has no video picture. Upload a video file.');
  const duration = Number(data.format?.duration ?? v.duration ?? 0);
  if (!(duration > 0)) throw new MediaError('This video has no length. The file may be damaged.');
  const rotation = Math.abs(Number(v.tags?.rotate ?? v.side_data_list?.find((d: any) => d.rotation !== undefined)?.rotation ?? 0)) % 180;
  const [w, h] = rotation === 90 ? [v.height, v.width] : [v.width, v.height];
  const [num, den] = String(v.avg_frame_rate || v.r_frame_rate || '30/1').split('/').map(Number);
  const fps = den ? num / den : 30;
  return { durationSeconds: duration, width: w, height: h, fps: Number.isFinite(fps) && fps > 0 && fps < 241 ? fps : 30, hasAudio: !!data.streams?.some((s) => s.codec_type === 'audio'), videoCodec: v.codec_name, hdr: hdrOf(v) };
}

import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { run } from './probe';
import type { Hdr } from './filters';
import { toneMap } from './filters';
import type { PlannedRung } from './ladder';

/**
 * Per-title encoding: how much compression this video's content takes before it looks worse.
 *
 * Every video used to get the same quality setting (x264 CRF 21). A talk, a slideshow or a screen recording looks
 * the same at a higher CRF (fewer bytes), while sport or nature needs every bit. Before encoding, short samples of
 * the video (three 2-second windows at a quarter, half and three quarters of it, at the 720p rung or the largest one
 * below) are encoded at CRF 21, 23 and 25 and compared with the original (SSIM). The highest CRF whose picture stays
 * within SSIM_TOLERANCE of CRF 21 is used for the whole video, every rung, and later passes (HD, AV1).
 *
 * SSIM only tells quality apart when the picture is clean: for grainy or noisy videos it stays low whatever the
 * setting, and choosing from it would over-compress. Those (SSIM at CRF 21 under MIN_BASE_SSIM) keep CRF 21, as do
 * videos too short to sample. The result is never worse than before on the measure, and never above CRF 25.
 */
export const BASE_CRF = 21;
const CANDIDATES = [21, 23, 25];
const SSIM_TOLERANCE = 0.004;
const MIN_BASE_SSIM = 0.95;
const WINDOW_S = 2;

export interface PerTitle { crf: number; samples: number; ssim: Record<number, number>; kbps: Record<number, number>; reason: 'chosen' | 'grainy' | 'short' | 'failed' }

/** Pure: the CRF to use from measured SSIM per CRF (see above). */
export function chooseCrf(ssim: Record<number, number>): { crf: number; reason: PerTitle['reason'] } {
  const base = ssim[BASE_CRF];
  if (base === undefined || !Number.isFinite(base)) return { crf: BASE_CRF, reason: 'failed' };
  if (base < MIN_BASE_SSIM) return { crf: BASE_CRF, reason: 'grainy' };
  const ok = CANDIDATES.filter((c) => ssim[c] !== undefined && ssim[c] >= base - SSIM_TOLERANCE);
  return { crf: Math.max(BASE_CRF, ...ok), reason: 'chosen' };
}

export async function perTitleCrf(ffmpeg: string, source: string, work: string, durationSeconds: number, rung: PlannedRung, hdr: Hdr, preset: string, signal?: AbortSignal): Promise<PerTitle> {
  if (durationSeconds < 3 * WINDOW_S) return { crf: BASE_CRF, samples: 0, ssim: {}, kbps: {}, reason: 'short' };
  const starts = durationSeconds >= 12 ? [0.25, 0.5, 0.75].map((f) => Math.max(0, durationSeconds * f - WINDOW_S / 2)) : [0];
  const look = hdr ? toneMap(hdr, rung.width, rung.height) : `scale=${rung.width}:${rung.height}:flags=bicubic,format=yuv420p`;
  const totals: Record<number, { ssim: number; bytes: number }> = {};
  try {
    for (const [i, at] of starts.entries()) {
      // A lossless copy of the window at the rung's size: what every candidate is compared with, frame for frame.
      const ref = join(work, `pt-ref-${i}.mkv`);
      await run(ffmpeg, ['-hide_banner', '-y', '-ss', at.toFixed(2), '-t', String(WINDOW_S), '-i', source, '-an', '-vf', look, '-c:v', 'ffv1', ref], undefined, signal);
      for (const crf of CANDIDATES) {
        const out = join(work, `pt-${i}-${crf}.mp4`);
        await run(ffmpeg, ['-hide_banner', '-y', '-i', ref, '-c:v', 'libx264', '-preset', preset, '-profile:v', 'high', '-crf', String(crf),
          '-maxrate', `${rung.maxKbps}k`, '-bufsize', `${rung.maxKbps * 2}k`, '-an', out], undefined, signal);
        const { stderr } = await run(ffmpeg, ['-hide_banner', '-i', out, '-i', ref, '-lavfi', 'ssim', '-f', 'null', '-'], undefined, signal);
        const value = Number(/All:([\d.]+)/.exec(stderr)?.[1]);
        const t = (totals[crf] ??= { ssim: 0, bytes: 0 });
        t.ssim += value; t.bytes += (await stat(out)).size;
        // Clearly grainy from the first sample: SSIM cannot guide it, so stop measuring (keeps CRF 21).
        if (i === 0 && crf === BASE_CRF && value < MIN_BASE_SSIM - 0.02) return { crf: BASE_CRF, samples: 1, ssim: { [BASE_CRF]: Math.round(value * 100_000) / 100_000 }, kbps: {}, reason: 'grainy' };
      }
    }
  } catch (e) {
    if (signal?.aborted) throw e;
    return { crf: BASE_CRF, samples: 0, ssim: {}, kbps: {}, reason: 'failed' };
  }
  const n = starts.length;
  const ssim = Object.fromEntries(Object.entries(totals).map(([c, t]) => [c, Math.round((t.ssim / n) * 100_000) / 100_000]));
  const kbps = Object.fromEntries(Object.entries(totals).map(([c, t]) => [c, Math.round((t.bytes * 8) / (n * WINDOW_S) / 1000)]));
  const { crf, reason } = chooseCrf(ssim);
  return { crf, samples: n, ssim, kbps, reason };
}

/**
 * A rendition's real bitrate from its HLS files (video only): the busiest segment (what a player must sustain) and
 * the average. Declared in the master playlist instead of the rung's ceiling.
 */
export async function measureRendition(dir: string): Promise<{ peakKbps: number; averageKbps: number } | null> {
  const playlist = await readFile(join(dir, 'index.m3u8'), 'utf8').catch(() => null);
  if (!playlist) return null;
  const lines = playlist.split('\n').map((l) => l.trim());
  const files = new Set(await readdir(dir));
  let peak = 0; let bytes = 0; let seconds = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^#EXTINF:([\d.]+)/.exec(lines[i]);
    if (!m) continue;
    const seg = lines.slice(i + 1).find((l) => l && !l.startsWith('#'));
    if (!seg || !files.has(seg)) continue;
    const size = (await stat(join(dir, seg))).size;
    const d = Number(m[1]);
    bytes += size; seconds += d;
    // A very short last segment says little about the rate a player needs: counted with at least 1 s.
    peak = Math.max(peak, (size * 8) / Math.max(1, d));
  }
  if (!seconds) return null;
  return { peakKbps: Math.ceil(peak / 1000), averageKbps: Math.ceil((bytes * 8) / seconds / 1000) };
}

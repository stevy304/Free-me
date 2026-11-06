import { run } from './probe';

/** HDR transfer of a source: PQ (HDR10, Dolby Vision 8.1) or HLG (most phones). Anything else is treated as SDR. */
export type Hdr = 'pq' | 'hlg' | null;

export function hdrOf(stream: { color_transfer?: string }): Hdr {
  if (stream.color_transfer === 'smpte2084') return 'pq';
  if (stream.color_transfer === 'arib-std-b67') return 'hlg';
  return null;
}

/**
 * Filter that turns HDR into normal (BT.709) colour at the given size, so phone videos do not play washed out and
 * grey on ordinary screens. Linear light, Hable curve, then back to 8-bit 4:2:0. Ends in yuv420p like the SDR path.
 */
export function toneMap(hdr: Exclude<Hdr, null>, width: number, height: number): string {
  const tin = hdr === 'pq' ? 'smpte2084' : 'arib-std-b67';
  return [
    `zscale=w=${width}:h=${height}:tin=${tin}:pin=bt2020:min=bt2020nc:t=linear:npl=100`,
    'format=gbrpf32le', 'zscale=p=bt709', 'tonemap=tonemap=hable:desat=0', 'zscale=t=bt709:m=bt709:r=tv', 'format=yuv420p',
  ].join(',');
}

/** Output colour tags after tone mapping, so players do not guess. */
export const BT709_TAGS = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'];

let filters: Promise<Set<string>> | null = null;
/** Filters this ffmpeg has (Ubuntu's ffmpeg has zscale and tonemap; minimal builds may not). */
export function ffmpegFilters(ffmpeg: string): Promise<Set<string>> {
  filters ??= run(ffmpeg, ['-hide_banner', '-filters']).then(({ stdout }) => new Set(stdout.split('\n').map((l) => l.trim().split(/\s+/)[1]).filter(Boolean))).catch(() => new Set<string>());
  return filters;
}

/** Same loudness for every video: -14 LUFS integrated, -1.5 dBTP peak, as most streaming services. */
export const LOUDNESS = { I: -14, TP: -1.5, LRA: 11 } as const;
export interface Loudness { input_i: string; input_tp: string; input_lra: string; input_thresh: string; target_offset: string }

/** First pass: measure the source's loudness (audio only, fast). null for silence or a measurement that failed. */
export async function measureLoudness(ffmpeg: string, source: string, signal?: AbortSignal): Promise<Loudness | null> {
  try {
    const { stderr } = await run(ffmpeg, ['-hide_banner', '-nostats', '-i', source, '-vn', '-map', '0:a:0', '-af', `loudnorm=I=${LOUDNESS.I}:TP=${LOUDNESS.TP}:LRA=${LOUDNESS.LRA}:print_format=json`, '-f', 'null', '-'], undefined, signal);
    const json = stderr.slice(stderr.lastIndexOf('{'), stderr.lastIndexOf('}') + 1);
    const m = JSON.parse(json) as Loudness;
    return [m.input_i, m.input_tp, m.input_lra, m.input_thresh, m.target_offset].every((v) => Number.isFinite(Number(v))) ? m : null;
  } catch { return null; }
}

/** Second pass: one linear gain to the target (no pumping), then back to 48 kHz (loudnorm works at 192 kHz). */
export function loudnessFilter(m: Loudness | null): string {
  if (!m) return 'aresample=48000';
  return `loudnorm=I=${LOUDNESS.I}:TP=${LOUDNESS.TP}:LRA=${LOUDNESS.LRA}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true,aresample=48000`;
}

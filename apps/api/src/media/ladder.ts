/**
 * The rendition ladder. A rung is named by the video's short side (so a vertical 1080x1920 video is "1080p"),
 * never upscaled. H.264 High + AAC in fMP4 HLS segments plays in every current browser and phone.
 */
export interface Rung { name: string; short: number; kbps: number; audioKbps: number }

export const LADDER: Rung[] = [
  { name: '144p', short: 144, kbps: 160, audioKbps: 64 },
  { name: '240p', short: 240, kbps: 400, audioKbps: 64 },
  { name: '360p', short: 360, kbps: 800, audioKbps: 96 },
  { name: '480p', short: 480, kbps: 1400, audioKbps: 128 },
  { name: '720p', short: 720, kbps: 2800, audioKbps: 128 },
  { name: '1080p', short: 1080, kbps: 5000, audioKbps: 192 },
  { name: '1440p', short: 1440, kbps: 9000, audioKbps: 192 },
  { name: '2160p', short: 2160, kbps: 16000, audioKbps: 192 },
];
/** Rungs done in the first, fast pass, so a video is watchable quickly; the rest follow. */
export const FAST_RUNGS = new Set(['144p', '240p', '360p']);

export interface PlannedRung extends Rung { width: number; height: number; videoKbps: number; maxKbps: number }

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** Rungs for a source: every rung up to the source's short side (the smallest always, even for tiny sources). */
export function planLadder(width: number, height: number, fps: number): PlannedRung[] {
  const short = Math.min(width, height);
  const portrait = height > width;
  const fit = LADDER.filter((r) => r.short <= short);
  const rungs = fit.length ? fit : [LADDER[0]];
  const fpsFactor = fps > 40 ? 1.5 : 1;
  return rungs.map((r) => {
    const s = Math.min(r.short, even(short));
    const long = even((Math.max(width, height) * s) / short);
    const videoKbps = Math.round(r.kbps * fpsFactor);
    return { ...r, width: portrait ? s : long, height: portrait ? long : s, videoKbps, maxKbps: Math.round(videoKbps * 1.5) };
  });
}

/** H.264 level for a rung (RFC 6381 codec string in the master playlist). */
export function codecsFor(r: PlannedRung, hasAudio: boolean): string {
  const pixels = r.width * r.height;
  const level = pixels > 2_073_600 ? '33' : pixels > 921_600 ? '2a' : pixels > 414_720 ? '1f' : '1e';
  return `avc1.6400${level}${hasAudio ? ',mp4a.40.2' : ''}`;
}

export interface MasterEntry { name: string; width: number; height: number; bandwidth: number; codecs: string; frameRate: number; playlist: string }

/** The master playlist: one line per rendition, lowest first (players start low and climb). */
export function masterPlaylist(entries: MasterEntry[]): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS'];
  for (const e of [...entries].sort((a, b) => a.bandwidth - b.bandwidth)) {
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${e.bandwidth},AVERAGE-BANDWIDTH=${Math.round(e.bandwidth * 0.75)},RESOLUTION=${e.width}x${e.height},CODECS="${e.codecs}",FRAME-RATE=${e.frameRate.toFixed(3)},NAME="${e.name}"`);
    lines.push(e.playlist);
  }
  return `${lines.join('\n')}\n`;
}

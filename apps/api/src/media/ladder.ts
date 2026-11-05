/**
 * The rendition ladder. A rung is named by the video's short side (so a vertical 1080x1920 video is "1080p"),
 * never upscaled. H.264 High in fMP4 HLS segments plays in every current browser and phone. Audio is one separate
 * AAC rendition shared by every rung (stored once, and room for more languages later).
 */
export interface Rung { name: string; short: number; kbps: number }

/** The shared audio rendition: AAC-LC stereo 48 kHz. */
export const AUDIO = { kbps: 128, codecs: 'mp4a.40.2', group: 'aud', playlist: 'audio/index.m3u8' } as const;

export const LADDER: Rung[] = [
  { name: '144p', short: 144, kbps: 160 },
  { name: '240p', short: 240, kbps: 400 },
  { name: '360p', short: 360, kbps: 800 },
  { name: '480p', short: 480, kbps: 1400 },
  { name: '720p', short: 720, kbps: 2800 },
  { name: '1080p', short: 1080, kbps: 5000 },
  { name: '1440p', short: 1440, kbps: 9000 },
  { name: '2160p', short: 2160, kbps: 16000 },
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

/** H.264 level for a rung (RFC 6381 codec string of the video alone). */
export function codecsFor(r: PlannedRung): string {
  const pixels = r.width * r.height;
  const level = pixels > 2_073_600 ? '33' : pixels > 921_600 ? '2a' : pixels > 414_720 ? '1f' : '1e';
  return `avc1.6400${level}`;
}

export interface MasterEntry { name: string; width: number; height: number; bandwidth: number; codecs: string; frameRate: number; playlist: string }

/**
 * The master playlist: one line per rendition, lowest first (players start low and climb). With `audio`, the
 * renditions are video only and all point to the one audio rendition (EXT-X-MEDIA); bandwidth then includes it.
 * Without it (videos processed before shared audio), each rendition carries its own audio.
 */
export function masterPlaylist(entries: MasterEntry[], audio = false): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS'];
  if (audio) lines.push(`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="${AUDIO.group}",NAME="Original",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2",URI="${AUDIO.playlist}"`);
  for (const e of [...entries].sort((a, b) => a.bandwidth - b.bandwidth)) {
    const bandwidth = e.bandwidth + (audio ? AUDIO.kbps * 1000 : 0);
    const codecs = audio ? `${e.codecs},${AUDIO.codecs}` : e.codecs;
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},AVERAGE-BANDWIDTH=${Math.round(bandwidth * 0.75)},RESOLUTION=${e.width}x${e.height},CODECS="${codecs}",FRAME-RATE=${e.frameRate.toFixed(3)},NAME="${e.name}"${audio ? `,AUDIO="${AUDIO.group}"` : ''}`);
    lines.push(e.playlist);
  }
  return `${lines.join('\n')}\n`;
}

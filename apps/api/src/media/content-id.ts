import { spawn } from 'node:child_process';
import type { PrismaClient } from '@prisma/client';

/**
 * Content ID fingerprints (RIGHTS.md). Every upload gets two:
 *
 * - picture: one 64-bit difference hash (dHash) per second, from a 9x8 grey thumbnail of that second. It survives
 *   re-encoding, resizing, a new bitrate or light colour changes, which an exact file hash (screening.ts) does not;
 * - sound: Chromaprint (the AcoustID algorithm, built into FFmpeg), about 8 values a second. It recognises a song or
 *   a recorded broadcast even when the picture is different.
 *
 * Short keys taken from both go into a search index (FingerprintKey). A new upload looks its keys up, votes for
 * (video, time offset) pairs that line up, and checks the best candidates second by second.
 */

/** At most this much of a video is fingerprinted (the first hour). */
const MAX_SECONDS = 3600;
/** Chromaprint values per second (its frames are 4096 samples at 11,025 Hz, a third overlapping). */
export const AUDIO_PER_SECOND = 11025 / 1365;
const PICTURE = 1n << 40n;
const SOUND = 2n << 40n;

/** frames: one 64-bit hash a second; coarse: one 8-bit brightness layout a second (for the search keys); audio: Chromaprint. */
export interface Fingerprint { frames: bigint[]; coarse: number[]; audio: number[] }
export interface MatchPart { seconds: number; uploadStart: number; referenceStart: number; /** Matched seconds that look different from the previous one (the picture really moves). */ distinct?: number }
export interface Match { videoId: string; picture: MatchPart | null; sound: MatchPart | null }

function capture(bin: string, args: string[], signal?: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], signal });
    const out: Buffer[] = []; let err = '';
    p.stdout.on('data', (c: Buffer) => out.push(c));
    p.stderr.on('data', (c: Buffer) => { err += c.toString(); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-300)}`))));
  });
}

/** The difference hash of one 9x8 grey frame; 0 for a nearly flat frame (black, white, one colour: it says nothing). */
export function dHash(px: Uint8Array | Buffer): bigint {
  let min = 255; let max = 0;
  for (const v of px) { if (v < min) min = v; if (v > max) max = v; }
  if (max - min < 10) return 0n;
  let h = 0n;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) h = (h << 1n) | (px[r * 9 + c] > px[r * 9 + c + 1] ? 1n : 0n);
  return h;
}

/** Which of 8 areas (2 rows x 4 columns) of a 9x8 grey frame are brighter than the whole frame: stable under re-encoding and small timing shifts. */
export function layout(px: Uint8Array | Buffer): number {
  let total = 0; for (const v of px) total += v;
  const mean = total / px.length;
  let bits = 0;
  for (let br = 0; br < 2; br++) for (let bc = 0; bc < 4; bc++) {
    let sum = 0; let n = 0;
    for (let r = br * 4; r < br * 4 + 4; r++) for (let c = bc * 2; c < bc * 2 + 3 && c < 9; c++) { sum += px[r * 9 + c]; n++; }
    bits = (bits << 1) | (sum / n > mean ? 1 : 0);
  }
  return bits;
}

const popcount64 = (x: bigint) => { let n = 0; while (x) { x &= x - 1n; n++; } return n; };
const popcount32 = (x: number) => { x -= (x >>> 1) & 0x55555555; x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; };
/** A picture hash worth matching on: not a flat frame, not nearly all one way. */
const usable = (h: bigint) => { if (!h) return false; const n = popcount64(h); return n >= 6 && n <= 58; };

/** Both fingerprints of a file (the picture always; the sound when it has one). */
export async function fingerprintFile(ffmpeg: string, path: string, hasAudio: boolean, signal?: AbortSignal): Promise<Fingerprint> {
  const raw = await capture(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', path, '-an', '-t', String(MAX_SECONDS), '-vf', 'fps=1,scale=9:8:flags=area,format=gray', '-f', 'rawvideo', '-'], signal);
  const frames: bigint[] = []; const coarse: number[] = [];
  for (let i = 0; i + 72 <= raw.length; i += 72) { const px = raw.subarray(i, i + 72); frames.push(dHash(px)); coarse.push(layout(px)); }
  let audio: number[] = [];
  if (hasAudio) {
    try {
      const a = await capture(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', path, '-vn', '-ac', '1', '-t', String(MAX_SECONDS), '-f', 'chromaprint', '-fp_format', 'raw', '-'], signal);
      audio = Array.from({ length: Math.floor(a.length / 4) }, (_, i) => a.readUInt32LE(i * 4));
    } catch (e) { if (signal?.aborted) throw e; /* no usable sound: the picture alone */ }
  }
  return { frames, coarse, audio };
}

/** Stored as 9 bytes a second (the 64-bit hash, then the layout byte) and 4 bytes per sound value. */
export const encode = (fp: Fingerprint) => {
  const frames = Buffer.alloc(fp.frames.length * 9);
  fp.frames.forEach((h, i) => { frames.writeBigUInt64BE(h, i * 9); frames.writeUInt8(fp.coarse[i] ?? 0, i * 9 + 8); });
  const audio = Buffer.alloc(fp.audio.length * 4); fp.audio.forEach((v, i) => audio.writeUInt32LE(v >>> 0, i * 4));
  return { frames, audio };
};
export const decode = (row: { frames: Uint8Array; audio: Uint8Array }): Fingerprint => {
  const f = Buffer.from(row.frames); const a = Buffer.from(row.audio); const n = Math.floor(f.length / 9);
  return { frames: Array.from({ length: n }, (_, i) => f.readBigUInt64BE(i * 9)), coarse: Array.from({ length: n }, (_, i) => f.readUInt8(i * 9 + 8)),
    audio: Array.from({ length: Math.floor(a.length / 4) }, (_, i) => a.readUInt32LE(i * 4)) };
};

/**
 * The search keys of a fingerprint, with where each occurs: for the picture, the brightness layouts of three seconds in
 * a row (24 bits: they survive re-encoding and small timing shifts, and a sequence says much more than one frame);
 * for the sound, the top 24 bits of every second Chromaprint value.
 */
export function keysOf(fp: Fingerprint): Array<{ key: bigint; at: number }> {
  const out: Array<{ key: bigint; at: number }> = [];
  for (let s = 0; s + 2 < fp.coarse.length; s++) {
    // Flat frames have no layout worth keying on.
    if (!fp.frames[s] || !fp.frames[s + 1] || !fp.frames[s + 2]) continue;
    out.push({ key: PICTURE | BigInt((fp.coarse[s] << 16) | (fp.coarse[s + 1] << 8) | fp.coarse[s + 2]), at: s });
  }
  for (let i = 0; i < fp.audio.length; i += 2) out.push({ key: SOUND | BigInt(fp.audio[i] >>> 8), at: i });
  return out;
}

/** Stores a video's fingerprint and its search keys (replacing any older ones). */
export async function saveFingerprint(prisma: PrismaClient, videoId: string, fp: Fingerprint) {
  const data = encode(fp);
  await prisma.contentFingerprint.upsert({ where: { videoId }, create: { videoId, ...data }, update: data });
  await prisma.fingerprintKey.deleteMany({ where: { videoId } });
  const keys = keysOf(fp);
  for (let i = 0; i < keys.length; i += 5000) await prisma.fingerprintKey.createMany({ data: keys.slice(i, i + 5000).map((k) => ({ ...k, videoId })), skipDuplicates: true });
}

/** How much two fingerprints agree once lined up: matching seconds, and where the agreement starts in each. */
function comparePicture(q: bigint[], r: bigint[], delta: number): MatchPart {
  let seconds = 0; let start = -1; let distinct = 0; let last: bigint | null = null;
  for (let s = 0; s < q.length; s++) {
    const t = s + delta;
    if (t < 0 || t >= r.length || !usable(q[s]) || !usable(r[t])) continue;
    // The same second: close, or (fast-moving video, sampled at a slightly different instant) clearly closer than the
    // seconds just before and after it.
    const d = popcount64(q[s] ^ r[t]);
    const around = Math.min(t > 0 && usable(r[t - 1]) ? popcount64(q[s] ^ r[t - 1]) : 64, t + 1 < r.length && usable(r[t + 1]) ? popcount64(q[s] ^ r[t + 1]) : 64);
    if (d <= 10 || (d <= 20 && d * 1.5 <= around)) {
      seconds++; if (start < 0) start = s;
      if (last === null || popcount64(r[t] ^ last) > 6) { distinct++; last = r[t]; }
    }
  }
  return { seconds, uploadStart: Math.max(0, start), referenceStart: Math.max(0, start + delta), distinct };
}
function compareSound(q: number[], r: number[], delta: number): MatchPart {
  // Second by second: the share of differing bits between lined-up values (the same audio stays well under 35%).
  const step = Math.round(AUDIO_PER_SECOND);
  let seconds = 0; let start = -1;
  for (let i = 0; i + step <= q.length; i += step) {
    let bits = 0; let n = 0;
    for (let k = i; k < i + step; k++) { const j = k + delta; if (j < 0 || j >= r.length) continue; bits += popcount32((q[k] ^ r[j]) >>> 0); n++; }
    if (n >= step / 2 && bits / (n * 32) <= 0.35) { seconds++; if (start < 0) start = i; }
  }
  return { seconds, uploadStart: Math.max(0, Math.floor(start / AUDIO_PER_SECOND)), referenceStart: Math.max(0, Math.floor((start + delta) / AUDIO_PER_SECOND)) };
}

/**
 * Other videos this fingerprint matches: at least `minSeconds` of the same picture or the same sound, lined up.
 * `exclude` leaves out videos (the upload itself). Keys found in many videos (a common logo, silence) are ignored.
 */
export async function findMatches(prisma: PrismaClient, fp: Fingerprint, minSeconds: number, exclude: string[] = []): Promise<Match[]> {
  const keys = keysOf(fp);
  if (!keys.length) return [];
  const where = new Map<string, number[]>();
  for (const k of keys) { const s = k.key.toString(); const l = where.get(s); if (l) l.push(k.at); else where.set(s, [k.at]); }
  const rows = await prisma.$queryRaw<Array<{ key: bigint; videoId: string; at: number }>>`
    SELECT "key", "videoId", "at" FROM "FingerprintKey" WHERE "key" = ANY(${[...where.keys()]}::bigint[]) AND NOT ("videoId" = ANY(${exclude}::text[])) LIMIT 400000`;
  // Keys shared by many videos say little: drop them.
  const spread = new Map<string, Set<string>>();
  for (const r of rows) { const k = r.key.toString(); (spread.get(k) ?? spread.set(k, new Set()).get(k)!).add(r.videoId); }
  const votes = new Map<string, number>();
  for (const r of rows) {
    const k = r.key.toString();
    if ((spread.get(k)?.size ?? 0) > 50) continue;
    const sound = (r.key >> 40n) === 2n;
    for (const at of where.get(k) ?? []) {
      // Sound offsets are counted in steps of 4 values (half a second), so a small shift still adds up.
      const delta = sound ? Math.round((r.at - at) / 4) : r.at - at;
      const v = `${r.videoId}|${sound ? 's' : 'p'}|${delta}`;
      votes.set(v, (votes.get(v) ?? 0) + 1);
    }
  }
  const candidates = [...votes.entries()].filter(([v, n]) => n >= (v.includes('|s|') ? 6 : 3)).sort((a, b) => b[1] - a[1]).slice(0, 30);
  if (!candidates.length) return [];
  const ids = [...new Set(candidates.map(([v]) => v.split('|')[0]))];
  const prints = new Map((await prisma.contentFingerprint.findMany({ where: { videoId: { in: ids } } })).map((r) => [r.videoId, decode(r)]));
  const best = new Map<string, Match>();
  for (const [v] of candidates) {
    const [videoId, kind, d] = v.split('|');
    const ref = prints.get(videoId);
    if (!ref) continue;
    const m = best.get(videoId) ?? { videoId, picture: null, sound: null };
    if (kind === 'p') {
      const part = comparePicture(fp.frames, ref.frames, Number(d));
      // A still or nearly still picture (a slide, a plain talking head) proves little by itself: the matched stretch
      // must keep changing. Such videos are matched by their sound.
      if (part.seconds >= minSeconds && (part.distinct ?? 0) >= Math.ceil(minSeconds / 2) && (!m.picture || part.seconds > m.picture.seconds)) m.picture = { ...part, distinct: undefined };
    } else {
      // Try the exact sound offsets around the vote (it was counted in steps of 4).
      for (let delta = Number(d) * 4 - 3; delta <= Number(d) * 4 + 3; delta++) {
        const part = compareSound(fp.audio, ref.audio, delta);
        if (part.seconds >= minSeconds && (!m.sound || part.seconds > m.sound.seconds)) m.sound = part;
      }
    }
    if (m.picture || m.sound) best.set(videoId, m);
  }
  return [...best.values()];
}

/** The shortest match that counts: 10 seconds, or half of a short upload (at least 5 seconds). */
export const minimumMatch = (durationSeconds: number) => Math.max(5, Math.min(10, Math.floor(durationSeconds / 2)));

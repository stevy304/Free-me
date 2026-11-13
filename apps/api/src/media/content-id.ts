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
 * The edits re-uploaders use to get past such checks are undone before comparing:
 * - black bars (letterbox, pillarbox) are found and cut off before fingerprinting;
 * - a landscape video also gets a fingerprint of its centre (the 9:16 part a vertical repost keeps), and pictures are
 *   compared in both directions (a vertical copy of a landscape original, a landscape post of a vertical one);
 * - a mirrored copy is compared mirrored back;
 * - short uploads (Moments, clips: where speed tricks are common) are also compared as if played at 0.8x to 1.25x.
 *
 * Short keys taken from the fingerprints go into a search index (FingerprintKey). A new upload looks its keys up,
 * votes for (video, variant, time offset) combinations that line up, and checks the best ones second by second.
 */

/** At most this much of a video is fingerprinted (the first hour). */
const MAX_SECONDS = 3600;
/** Uploads up to this long are also compared at other speeds. */
const SPEED_CHECK_SECONDS = 180;
const SPEEDS = [1.1, 1.25, 0.9, 0.8];
/** Chromaprint values per second (its frames are 4096 samples at 11,025 Hz, a third overlapping). */
export const AUDIO_PER_SECOND = 11025 / 1365;
const PICTURE = 1n << 40n;
const SOUND = 2n << 40n;

/** One way of seeing a video's picture: a 64-bit hash and an 8-bit brightness layout per second. */
export interface Picture { frames: bigint[]; coarse: number[] }
/**
 * What is stored for every video: its picture, its centre (landscape videos only) and its sound. `speeds` exists only
 * for an upload being checked: its picture and sound as if undone from another playback speed.
 */
export interface Fingerprint extends Picture {
  center: Picture | null; audio: number[];
  /** Only for an upload being checked: its picture mirrored, and as if undone from other playback speeds. */
  mirrored?: Picture; speeds?: Array<{ rate: number; picture: Picture; audio: number[] }>;
  /**
   * Only for an upload being checked: its picture (and centre) sampled a quarter, half and three quarters of a second
   * later. A copy cut at 2.4 s is sampled half a second away from the original's samples; in fast-moving video that
   * half second changes the hash too much, so the closest of these is compared.
   */
  shifts?: Array<{ picture: Picture; center: Picture | null }>;
}
export interface MatchPart { seconds: number; uploadStart: number; referenceStart: number; /** Matched seconds that look different from the previous one (the picture really moves). */ distinct?: number }
export interface Match { videoId: string; picture: MatchPart | null; sound: MatchPart | null; /** How the copy was changed, when it was: "mirrored", "cropped", "at 1.25x speed"… */ edits?: string[] }

function capture(bin: string, args: string[], signal?: AbortSignal, want: 'stdout' | 'stderr' = 'stdout'): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], signal });
    const out: Buffer[] = []; const err: Buffer[] = [];
    p.stdout.on('data', (c: Buffer) => out.push(c));
    p.stderr.on('data', (c: Buffer) => err.push(c));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(want === 'stdout' ? out : err)) : reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(err).toString().slice(-300)}`))));
  });
}

/** Runs FFmpeg with a second raw output on file descriptor 3 (`pipe:3`). */
function captureTwo(bin: string, args: string[], signal?: AbortSignal): Promise<{ full: Buffer; mid: Buffer }> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe', 'pipe'], signal });
    const out: Buffer[] = []; const mid: Buffer[] = []; const err: Buffer[] = [];
    p.stdout!.on('data', (c: Buffer) => out.push(c));
    (p.stdio[3] as NodeJS.ReadableStream).on('data', (c: Buffer) => mid.push(c));
    p.stderr!.on('data', (c: Buffer) => err.push(c));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve({ full: Buffer.concat(out), mid: Buffer.concat(mid) }) : reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(err).toString().slice(-300)}`))));
  });
}

/** The difference hash of one 9x8 grey grid; 0 for a nearly flat frame (black, white, one colour: it says nothing). */
export function dHash(px: ArrayLike<number>): bigint {
  let min = 255; let max = 0;
  for (let i = 0; i < 72; i++) { const v = px[i]; if (v < min) min = v; if (v > max) max = v; }
  if (max - min < 10) return 0n;
  let h = 0n;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) h = (h << 1n) | (px[r * 9 + c] > px[r * 9 + c + 1] ? 1n : 0n);
  return h;
}

/** Which of 8 areas (2 rows x 4 columns) of a 9x8 grey grid are brighter than the whole: stable under re-encoding and small timing shifts. */
export function layout(px: ArrayLike<number>): number {
  let total = 0; for (let i = 0; i < 72; i++) total += px[i];
  const mean = total / 72;
  let bits = 0;
  for (let br = 0; br < 2; br++) for (let bc = 0; bc < 4; bc++) {
    let sum = 0; let n = 0;
    for (let r = br * 4; r < br * 4 + 4; r++) for (let c = bc * 2; c < bc * 2 + 3 && c < 9; c++) { sum += px[r * 9 + c]; n++; }
    bits = (bits << 1) | (sum / n > mean ? 1 : 0);
  }
  return bits;
}

/** The 9x8 grid of a region of a grey image (area average). */
function grid(img: Uint8Array | Buffer, w: number, x0: number, x1: number, y0: number, y1: number): Uint8Array {
  const out = new Uint8Array(72);
  for (let r = 0; r < 8; r++) for (let c = 0; c < 9; c++) {
    const xa = Math.floor(x0 + ((x1 - x0) * c) / 9); const xb = Math.max(xa + 1, Math.floor(x0 + ((x1 - x0) * (c + 1)) / 9));
    const ya = Math.floor(y0 + ((y1 - y0) * r) / 8); const yb = Math.max(ya + 1, Math.floor(y0 + ((y1 - y0) * (r + 1)) / 8));
    let sum = 0; let n = 0;
    for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) { sum += img[y * w + x]; n++; }
    out[r * 9 + c] = Math.round(sum / n);
  }
  return out;
}
const mirror = (g: Uint8Array) => { const m = new Uint8Array(72); for (let r = 0; r < 8; r++) for (let c = 0; c < 9; c++) m[r * 9 + c] = g[r * 9 + 8 - c]; return m; };
const picture = (grids: Uint8Array[]): Picture => ({ frames: grids.map(dHash), coarse: grids.map(layout) });

const popcount64 = (x: bigint) => { let n = 0; while (x) { x &= x - 1n; n++; } return n; };
const popcount32 = (x: number) => { x -= (x >>> 1) & 0x55555555; x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; };
/** A picture hash worth matching on: not a flat frame, not nearly all one way. */
const usable = (h: bigint) => { if (!h) return false; const n = popcount64(h); return n >= 6 && n <= 58; };

/** Black bars around the picture (letterbox, pillarbox), found over the first minute: the crop that removes them, or null. */
export async function detectBars(ffmpeg: string, path: string, size: { width: number; height: number }, signal?: AbortSignal): Promise<{ w: number; h: number; x: number; y: number } | null> {
  const log = (await capture(ffmpeg, ['-hide_banner', '-i', path, '-an', '-t', '60', '-vf', 'fps=2,cropdetect=limit=24:round=2:reset=0', '-f', 'null', '-'], signal, 'stderr')).toString();
  const all = [...log.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
  const last = all.at(-1);
  if (!last) return null;
  const [w, h, x, y] = last.slice(1).map(Number);
  // Only real bars (at least 4% of a side), and never more than 3/4 of the picture.
  if (w < size.width * 0.25 || h < size.height * 0.25) return null;
  if (w > size.width * 0.96 && h > size.height * 0.96) return null;
  return { w, h, x, y };
}

/**
 * Both fingerprints of a file (the picture always; the sound when it has one). `check`: this is an upload being checked,
 * so short ones also get their speed variants.
 */
export async function fingerprintFile(ffmpeg: string, path: string, info: { hasAudio: boolean; width: number; height: number; durationSeconds: number }, signal?: AbortSignal, check = false): Promise<Fingerprint> {
  const bars = await detectBars(ffmpeg, path, info, signal).catch((e) => { if (signal?.aborted) throw e; return null; });
  const w0 = bars?.w ?? info.width; const h0 = bars?.h ?? info.height;
  // A small grey copy in the picture's own shape (up to 48 px a side) to take every grid from. Always 4 samples a
  // second, for stored videos and checked uploads alike, so "second n" is the very same instant on both sides (FFmpeg's
  // fps filter picks different instants at different rates); the extra samples serve the speed variants.
  const gw = Math.max(16, Math.round(48 * Math.min(1, w0 / h0))); const gh = Math.max(16, Math.round(48 * Math.min(1, h0 / w0)));
  const speeds = check && info.durationSeconds <= SPEED_CHECK_SECONDS;
  const fps = 4;
  const landscape = w0 / h0 > 1.2;
  // The centre a vertical (9:16) repost keeps of a landscape picture: cut from the full frame in the same pass, as a
  // second output, so it is as sharp as the whole picture's grid.
  const cw = Math.max(16, Math.round((48 * 9) / 16)); const ch = 48;
  const pre = [...(bars ? [`crop=${bars.w}:${bars.h}:${bars.x}:${bars.y}`] : []), `fps=${fps}`].join(',');
  const graph = landscape
    ? `[0:v]${pre},split=2[a][b];[a]scale=${gw}:${gh}:flags=area,format=gray[full];[b]crop=ih*9/16:ih,scale=${cw}:${ch}:flags=area,format=gray[mid]`
    : `[0:v]${pre},scale=${gw}:${gh}:flags=area,format=gray[full]`;
  const { full: raw, mid } = await captureTwo(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', path, '-an', '-t', String(MAX_SECONDS), '-filter_complex', graph,
    '-map', '[full]', '-f', 'rawvideo', 'pipe:1', ...(landscape ? ['-map', '[mid]', '-f', 'rawvideo', 'pipe:3'] : [])], signal);
  const size = gw * gh; const midSize = cw * ch;
  const full: Uint8Array[] = []; const centre: Uint8Array[] = [];
  for (let i = 0; i + size <= raw.length; i += size) full.push(grid(raw.subarray(i, i + size), gw, 0, gw, 0, gh));
  for (let i = 0; i + midSize <= mid.length; i += midSize) centre.push(grid(mid.subarray(i, i + midSize), cw, 0, cw, 0, ch));
  // One grid a second is what is compared and stored.
  const perSecond = <T,>(list: T[]) => list.filter((_, i) => i % fps === 0);
  const audio = info.hasAudio ? await chromaprint(ffmpeg, path, null, signal) : [];
  const fp: Fingerprint = { ...picture(perSecond(full)), center: landscape ? picture(perSecond(centre)) : null, audio };
  if (check) {
    fp.mirrored = picture(perSecond(full).map(mirror));
    const phase = <T,>(list: T[], p: number) => list.filter((_, i) => i % fps === p);
    fp.shifts = [1, 2, 3].map((p) => ({ picture: picture(phase(full, p)), center: landscape ? picture(phase(centre, p)) : null }));
  }
  if (speeds) {
    fp.speeds = [];
    for (const rate of SPEEDS) {
      // A copy sped up by `rate` shows the original's second k at k / rate.
      const n = Math.floor((full.length / fps) * rate);
      const pick = Array.from({ length: n }, (_, k) => full[Math.min(full.length - 1, Math.round((k / rate) * fps))]);
      fp.speeds.push({ rate, picture: picture(pick), audio: info.hasAudio ? await chromaprint(ffmpeg, path, 1 / rate, signal) : [] });
    }
  }
  return fp;
}

/** Chromaprint values of the sound, optionally played at another tempo first (`tempo`: 1 / the copy's speed). */
async function chromaprint(ffmpeg: string, path: string, tempo: number | null, signal?: AbortSignal): Promise<number[]> {
  try {
    const a = await capture(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', path, '-vn', '-ac', '1', '-t', String(MAX_SECONDS), ...(tempo ? ['-af', `atempo=${tempo.toFixed(4)}`] : []), '-f', 'chromaprint', '-fp_format', 'raw', '-'], signal);
    return Array.from({ length: Math.floor(a.length / 4) }, (_, i) => a.readUInt32LE(i * 4));
  } catch (e) { if (signal?.aborted) throw e; return []; /* no usable sound: the picture alone */ }
}

/** Stored as 9 bytes a second (the 64-bit hash, then the layout byte), the same for the centre, and 4 bytes per sound value. */
const packPicture = (p: Picture) => { const b = Buffer.alloc(p.frames.length * 9); p.frames.forEach((h, i) => { b.writeBigUInt64BE(h, i * 9); b.writeUInt8(p.coarse[i] ?? 0, i * 9 + 8); }); return b; };
const unpackPicture = (raw: Uint8Array | null | undefined): Picture => {
  const f = Buffer.from(raw ?? []); const n = Math.floor(f.length / 9);
  return { frames: Array.from({ length: n }, (_, i) => f.readBigUInt64BE(i * 9)), coarse: Array.from({ length: n }, (_, i) => f.readUInt8(i * 9 + 8)) };
};
export const encode = (fp: Fingerprint) => {
  const audio = Buffer.alloc(fp.audio.length * 4); fp.audio.forEach((v, i) => audio.writeUInt32LE(v >>> 0, i * 4));
  return { frames: packPicture(fp), center: fp.center ? packPicture(fp.center) : null, audio };
};
export const decode = (row: { frames: Uint8Array; center: Uint8Array | null; audio: Uint8Array }): Fingerprint => {
  const a = Buffer.from(row.audio);
  return { ...unpackPicture(row.frames), center: row.center?.length ? unpackPicture(row.center) : null, audio: Array.from({ length: Math.floor(a.length / 4) }, (_, i) => a.readUInt32LE(i * 4)) };
};

/**
 * Search keys, with where each occurs: for a picture, the brightness layouts of three seconds in a row (24 bits: they
 * survive re-encoding and small timing shifts, and a sequence says much more than one frame); for the sound, the top
 * 24 bits of every second Chromaprint value.
 */
const pictureKeys = (p: Picture) => {
  const out: Array<{ key: bigint; at: number }> = [];
  for (let s = 0; s + 2 < p.coarse.length; s++) {
    if (!p.frames[s] || !p.frames[s + 1] || !p.frames[s + 2]) continue; // flat frames have no layout worth keying on
    out.push({ key: PICTURE | BigInt((p.coarse[s] << 16) | (p.coarse[s + 1] << 8) | p.coarse[s + 2]), at: s });
  }
  return out;
};
const soundKeys = (audio: number[]) => { const out: Array<{ key: bigint; at: number }> = []; for (let i = 0; i < audio.length; i += 2) out.push({ key: SOUND | BigInt(audio[i] >>> 8), at: i }); return out; };
/** The keys stored for a video: its picture, its centre and its sound. */
export const keysOf = (fp: Fingerprint) => [...pictureKeys(fp), ...(fp.center ? pictureKeys(fp.center) : []), ...soundKeys(fp.audio)];

/** Stores a video's fingerprint and its search keys (replacing any older ones). */
export async function saveFingerprint(prisma: PrismaClient, videoId: string, fp: Fingerprint) {
  const data = encode(fp);
  await prisma.contentFingerprint.upsert({ where: { videoId }, create: { videoId, ...data }, update: data });
  await prisma.fingerprintKey.deleteMany({ where: { videoId } });
  const keys = keysOf(fp);
  for (let i = 0; i < keys.length; i += 5000) await prisma.fingerprintKey.createMany({ data: keys.slice(i, i + 5000).map((k) => ({ ...k, videoId })), skipDuplicates: true });
}

/** How much two pictures agree once lined up: matching seconds, and where the agreement starts in each. */
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
/**
 * Second by second: the share of differing bits between lined-up values. The same recording, re-encoded and cut,
 * stays under 5%; different songs are near 50%, but two simple melodies in the same key can come within 10% for a
 * few seconds (Chromaprint hears pitch classes, not octaves). So sound alone needs 12% or less; where the picture
 * already matched at that place (a sped-up copy, whose sound FFmpeg's tempo change alters), 30% is enough.
 */
export const SOUND_ALONE = 0.12;
export const SOUND_WITH_PICTURE = 0.3;
function compareSound(q: number[], r: number[], delta: number, limit = SOUND_ALONE): MatchPart {
  const step = Math.round(AUDIO_PER_SECOND);
  let seconds = 0; let start = -1;
  for (let i = 0; i + step <= q.length; i += step) {
    let bits = 0; let n = 0;
    for (let k = i; k < i + step; k++) { const j = k + delta; if (j < 0 || j >= r.length) continue; bits += popcount32((q[k] ^ r[j]) >>> 0); n++; }
    if (n >= step / 2 && bits / (n * 32) <= limit) { seconds++; if (start < 0) start = i; }
  }
  return { seconds, uploadStart: Math.max(0, Math.floor(start / AUDIO_PER_SECOND)), referenceStart: Math.max(0, Math.floor((start + delta) / AUDIO_PER_SECOND)) };
}

/** The ways an upload is looked at when it is checked: as it is, mirrored, its centre, and at other speeds. */
function views(fp: Fingerprint) {
  const out: Array<{ edits: string[]; picture: Picture | null; audio: number[] | null; rate: number }> = [{ edits: [], picture: fp, audio: fp.audio, rate: 1 }];
  if (fp.mirrored) out.push({ edits: ['mirrored'], picture: fp.mirrored, audio: null, rate: 1 });
  if (fp.center) out.push({ edits: ['reframed'], picture: fp.center, audio: null, rate: 1 });
  for (const s of fp.shifts ?? []) {
    out.push({ edits: [], picture: s.picture, audio: null, rate: 1 });
    if (s.center) out.push({ edits: ['reframed'], picture: s.center, audio: null, rate: 1 });
  }
  for (const s of fp.speeds ?? []) out.push({ edits: [`at ${s.rate}x speed`], picture: s.picture, audio: s.audio.length ? s.audio : null, rate: s.rate });
  return out;
}

/**
 * Other videos this fingerprint matches: at least `minSeconds` of the same picture or the same sound, lined up.
 * `exclude` leaves out videos (the upload itself). Keys found in many videos (a common logo, silence) are ignored.
 */
export async function findMatches(prisma: PrismaClient, fp: Fingerprint, minSeconds: number, exclude: string[] = []): Promise<Match[]> {
  const looks = views(fp);
  // Where each key occurs in each view of the upload.
  const where = new Map<string, Array<{ view: number; at: number; sound: boolean }>>();
  const add = (key: bigint, view: number, at: number, sound: boolean) => { const s = key.toString(); const l = where.get(s); if (l) l.push({ view, at, sound }); else where.set(s, [{ view, at, sound }]); };
  looks.forEach((l, i) => {
    if (l.picture) for (const k of pictureKeys(l.picture)) add(k.key, i, k.at, false);
    if (l.audio) for (const k of soundKeys(l.audio)) add(k.key, i, k.at, true);
  });
  if (!where.size) return [];
  const rows = await prisma.$queryRaw<Array<{ key: bigint; videoId: string; at: number }>>`
    SELECT "key", "videoId", "at" FROM "FingerprintKey" WHERE "key" = ANY(${[...where.keys()]}::bigint[]) AND NOT ("videoId" = ANY(${exclude}::text[])) LIMIT 400000`;
  // Keys shared by many videos say little: drop them.
  const spread = new Map<string, Set<string>>();
  for (const r of rows) { const k = r.key.toString(); (spread.get(k) ?? spread.set(k, new Set()).get(k)!).add(r.videoId); }
  const votes = new Map<string, number>();
  for (const r of rows) {
    const k = r.key.toString();
    if ((spread.get(k)?.size ?? 0) > 50) continue;
    for (const q of where.get(k) ?? []) {
      // Sound offsets are counted in steps of 4 values (half a second), so a small shift still adds up.
      const delta = q.sound ? Math.round((r.at - q.at) / 4) : r.at - q.at;
      const v = `${r.videoId}|${q.sound ? 's' : 'p'}|${q.view}|${delta}`;
      votes.set(v, (votes.get(v) ?? 0) + 1);
    }
  }
  const candidates = [...votes.entries()].filter(([v, n]) => n >= (v.includes('|s|') ? 6 : 3)).sort((a, b) => b[1] - a[1]).slice(0, 40);
  if (!candidates.length) return [];
  const ids = [...new Set(candidates.map(([v]) => v.split('|')[0]))];
  const prints = new Map((await prisma.contentFingerprint.findMany({ where: { videoId: { in: ids } } })).map((r) => [r.videoId, decode(r)]));
  const best = new Map<string, Match & { pictureEdits?: string[]; soundEdits?: string[]; pictureScore?: number }>();
  for (const [v] of candidates) {
    const [videoId, kind, viewIndex, d] = v.split('|');
    const ref = prints.get(videoId);
    const look = looks[Number(viewIndex)];
    if (!ref || !look) continue;
    const m = best.get(videoId) ?? { videoId, picture: null, sound: null };
    if (kind === 'p' && look.picture) {
      // The upload's view against the original as it is, and against the original's centre (a landscape video reposted vertical).
      for (const [target, extra] of [[ref, [] as string[]], ...(ref.center ? [[ref.center, ['reframed']] as const] : [])] as Array<[Picture, string[]]>) {
        const part = comparePicture(look.picture.frames, target.frames, Number(d));
        // A still or nearly still picture (a slide, a plain talking head) proves little by itself: the matched stretch
        // must keep changing. Such videos are matched by their sound.
        // An edited view (mirrored, sped up…) must beat the plain one clearly, so a plain copy is not labelled edited.
        const edits = [...new Set([...look.edits, ...extra])];
        const score = part.seconds - (edits.length ? 2 : 0);
        if (part.seconds >= minSeconds && (part.distinct ?? 0) >= Math.ceil(minSeconds / 2) && (!m.picture || score > (m.pictureScore ?? 0))) {
          m.picture = { ...part, distinct: undefined }; m.pictureEdits = edits; m.pictureScore = score;
        }
      }
      // The sound at the place the picture says: catches a copy whose sound changed too much for its search keys (a
      // sped-up copy, a re-recorded soundtrack) but still lines up with the original's.
      if (m.picture && look.audio?.length && ref.audio.length) {
        const at = Math.round(Number(d) * AUDIO_PER_SECOND);
        for (let delta = at - 10; delta <= at + 10; delta++) {
          const part = compareSound(look.audio, ref.audio, delta, SOUND_WITH_PICTURE);
          if (part.seconds >= minSeconds && (!m.sound || part.seconds > m.sound.seconds)) { m.sound = part; m.soundEdits = look.edits; }
        }
      }
    } else if (kind === 's' && look.audio) {
      // Try the exact sound offsets around the vote (it was counted in steps of 4).
      for (let delta = Number(d) * 4 - 3; delta <= Number(d) * 4 + 3; delta++) {
        const part = compareSound(look.audio, ref.audio, delta);
        if (part.seconds >= minSeconds && (!m.sound || part.seconds > m.sound.seconds)) { m.sound = part; m.soundEdits = look.edits; }
      }
    }
    if (m.picture || m.sound) best.set(videoId, m);
  }
  return [...best.values()].map(({ pictureEdits, soundEdits, pictureScore: _score, ...m }) => ({ ...m, edits: [...new Set([...(pictureEdits ?? []), ...(soundEdits ?? [])])] }));
}

/** The shortest match that counts: 10 seconds, or half of a short upload (at least 5 seconds). */
export const minimumMatch = (durationSeconds: number) => Math.max(5, Math.min(10, Math.floor(durationSeconds / 2)));

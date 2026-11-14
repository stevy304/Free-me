import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { dHash, layout, fingerprintFile, findMatches, minimumMatch, saveFingerprint } from '../src/media/content-id';
import { probe } from '../src/media/probe';

/** A file's fingerprint: as stored (a reference) or as an upload being checked (with its mirrored and speed views). */
const fpOf = async (file: string, check = false) => fingerprintFile('ffmpeg', file, await probe('ffprobe', file), undefined, check);

// Content ID fingerprints against real edits made with FFmpeg: re-encoded and resized copies, trimmed copies and the
// same soundtrack under another picture match; an unrelated video does not.
const dir = mkdtempSync(join(tmpdir(), 'freeme-content-id-'));
const prisma = new PrismaClient();
afterAll(async () => { rmSync(dir, { recursive: true, force: true }); await prisma.$disconnect(); });

const ff = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
/** A 40 s original: a picture that keeps changing (a Mandelbrot zoom) and a melody that keeps changing pitch. */
const original = join(dir, 'original.mp4');
const tune = "sin(2*PI*t*(330+220*sin(2*PI*t/3)+110*sin(2*PI*t/7)))*0.6";
beforeAll(async () => {
  ff(['-f', 'lavfi', '-i', 'mandelbrot=size=960x540:rate=25:end_scale=0.01', '-f', 'lavfi', '-i', `aevalsrc=${tune}:s=44100:d=40`, '-t', '40', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', original]);
  // Users and videos for the index.
  await prisma.$executeRawUnsafe('TRUNCATE "FingerprintKey", "ContentFingerprint" CASCADE');
}, 60_000);

async function video(title: string) {
  const u = await prisma.user.create({ data: { email: `cid-${Math.random()}@example.com` } });
  const ch = await prisma.channel.create({ data: { userId: u.id, handle: `cid${Math.floor(Math.random() * 1e9)}`, name: title } });
  return prisma.video.create({ data: { channelId: ch.id, title, durationSeconds: 40 } });
}

test('a frame hash ignores flat frames', () => {
  expect(dHash(new Uint8Array(72).fill(20))).toBe(0n);
  expect(layout(Uint8Array.from({ length: 72 }, (_, i) => (i < 36 ? 200 : 20)))).toBe(0b11110000);
  const ramp = Uint8Array.from({ length: 72 }, (_, i) => (i % 9) * 20);
  expect(dHash(ramp)).toBe(0n); // brighter to the right everywhere: every bit 0
  expect(dHash(Uint8Array.from({ length: 72 }, (_, i) => 200 - (i % 9) * 20))).toBe(0xffffffffffffffffn);
});

test('a still picture is not matched by its picture alone', async () => {
  const still = join(dir, 'still.mp4');
  ff(['-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=30', '-vf', 'trim=end_frame=1,loop=loop=-1:size=1', '-t', '30', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', still]);
  const a = await video('Still A');
  await saveFingerprint(prisma, a.id, await fpOf(still));
  expect(await findMatches(prisma, await fpOf(still, true), minimumMatch(30))).toEqual([]);
  await prisma.fingerprintKey.deleteMany({ where: { videoId: a.id } });
}, 60_000);

test('re-encoded, resized and trimmed copies match the original; the same song under another picture matches by sound; an unrelated video does not', async () => {
  const ref = await video('Original');
  const fp = await fpOf(original);
  expect(fp.frames.length).toBe(40);
  expect(fp.audio.length).toBeGreaterThan(300);
  await saveFingerprint(prisma, ref.id, fp);

  // 1. Smaller and much lower quality.
  const small = join(dir, 'small.mp4');
  ff(['-i', original, '-vf', 'scale=640:360', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '38', '-c:a', 'aac', '-b:a', '64k', small]);
  const m1 = await findMatches(prisma, await fpOf(small, true), minimumMatch(40));
  expect(m1).toHaveLength(1);
  expect(m1[0].videoId).toBe(ref.id);
  expect(m1[0].picture!.seconds).toBeGreaterThanOrEqual(35);
  expect(m1[0].sound!.seconds).toBeGreaterThanOrEqual(30);

  // 2. The first 7.3 seconds cut off: still found, at the right place in the original.
  const cut = join(dir, 'cut.mp4');
  ff(['-ss', '7.3', '-i', original, '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', cut]);
  const m2 = await findMatches(prisma, await fpOf(cut, true), minimumMatch(32));
  expect(m2.map((m) => m.videoId)).toEqual([ref.id]);
  // (A zooming fractal changes fast: sampled 0.3 s apart, not every second is close enough, but well over the minimum.)
  expect(m2[0].picture!.seconds).toBeGreaterThanOrEqual(15);
  expect(Math.abs(m2[0].picture!.referenceStart - m2[0].picture!.uploadStart - 7)).toBeLessThanOrEqual(1);
  expect(m2[0].sound!.seconds).toBeGreaterThanOrEqual(20);

  // 3. The same soundtrack under a completely different picture: matched by sound only.
  const remix = join(dir, 'remix.mp4');
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-i', original, '-map', '0:v', '-map', '1:a', '-t', '40', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', remix]);
  const m3 = await findMatches(prisma, await fpOf(remix, true), minimumMatch(40));
  expect(m3.map((m) => m.videoId)).toEqual([ref.id]);
  expect(m3[0].picture).toBeNull();
  expect(m3[0].sound!.seconds).toBeGreaterThanOrEqual(30);

  // 4. Unrelated picture and sound: nothing.
  const other = join(dir, 'other.mp4');
  ff(['-f', 'lavfi', '-i', 'life=size=640x360:rate=25:mold=10:ratio=0.4', '-f', 'lavfi', '-i', 'aevalsrc=sin(2*PI*t*(600+300*sin(2*PI*t/5)))*0.5:s=44100', '-t', '40', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', other]);
  expect(await findMatches(prisma, await fpOf(other, true), minimumMatch(40))).toEqual([]);
}, 120_000);

test('the edits re-uploaders use: black bars, a vertical crop, a mirror image, a faster or slower copy', async () => {
  const ref = await video('Original for edits');
  await saveFingerprint(prisma, ref.id, await fpOf(original));
  const check = async (name: string, args: string[]) => {
    const f = join(dir, name);
    ff(['-i', original, ...args, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', f]);
    const m = (await findMatches(prisma, await fpOf(f, true), minimumMatch(30))).find((x) => x.videoId === ref.id);
    return m ?? null;
  };
  // Black bars all round (the picture made smaller inside a 1280x720 frame).
  const bars = await check('bars.mp4', ['-vf', 'scale=960:540,pad=1280:720:160:90:black']);
  expect(bars?.picture?.seconds).toBeGreaterThanOrEqual(30);
  // Reposted vertical: the centre 9:16 of the landscape original.
  const vertical = await check('vertical.mp4', ['-vf', 'crop=ih*9/16:ih,scale=720:1280']);
  expect(vertical?.picture?.seconds).toBeGreaterThanOrEqual(30);
  expect(vertical?.edits).toContain('reframed');
  // Mirrored.
  const mirrored = await check('mirrored.mp4', ['-vf', 'hflip']);
  expect(mirrored?.picture?.seconds).toBeGreaterThanOrEqual(30);
  expect(mirrored?.edits).toContain('mirrored');
  // 1.25x faster, picture and sound (the sound keeps its pitch, as editing apps do).
  const fast = await check('fast.mp4', ['-vf', 'setpts=PTS/1.25', '-af', 'atempo=1.25']);
  expect(fast?.picture?.seconds ?? 0).toBeGreaterThanOrEqual(20);
  expect(fast?.sound?.seconds ?? 0).toBeGreaterThanOrEqual(15);
  expect(fast?.edits).toContain('at 1.25x speed');
  // 0.9x slower.
  const slow = await check('slow.mp4', ['-vf', 'setpts=PTS/0.9', '-af', 'atempo=0.9']);
  expect(Math.max(slow?.picture?.seconds ?? 0, slow?.sound?.seconds ?? 0)).toBeGreaterThanOrEqual(20);
}, 240_000);

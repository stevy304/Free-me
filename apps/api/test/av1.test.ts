import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { makeApp, resetDb, signIn, WEB } from './helpers';
import { loadConfig } from '../src/config/config';
import { MediaJobs } from '../src/media/jobs';
import { createStorage } from '../src/media/storage';
import { av1Codecs, av1LevelFor, av1Rung } from '../src/media/av1';
import { planLadder } from '../src/media/ladder';

// AV1 for popular videos: once a ready video reaches AV1_MIN_VIEWS, every H.264 rung gets an AV1 version beside it
// (hls/av1-<rung>/), listed in the same master playlists under the same free-quality limit.
const dir = mkdtempSync(join(tmpdir(), 'freeme-av1-'));
let ctx: Awaited<ReturnType<typeof makeApp>>;
let clip: string;
beforeAll(async () => {
  // Every quality straight away (HD_MIN_VIEWS 0), so the H.264 ladder is complete; the fastest AV1 preset for speed.
  ctx = await makeApp({ redis: false, storageDir: join(dir, 'storage'), env: { HD_MIN_VIEWS: '0', AV1_MIN_VIEWS: '50', AV1_PRESET: '12' } });
  clip = join(dir, 'camera.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-b:v', '4M', '-g', '60', '-c:a', 'aac', '-shortest', clip]);
}, 60_000);
beforeEach(async () => { await resetDb(ctx.prisma); ctx.mail.outbox.length = 0; await ctx.clearLimits(); });
afterAll(async () => { await ctx.app.close(); rmSync(dir, { recursive: true, force: true }); });

async function uploadAndWait(agent: any, file: string) {
  const data = readFileSync(file);
  const start = (await agent.post('/api/uploads').set('Origin', WEB).send({ fileName: 'clip.mp4', sizeBytes: data.length }).expect(201)).body;
  const urls = (await agent.post(`/api/uploads/${start.videoId}/parts`).set('Origin', WEB).send({ partNumbers: [1] }).expect(200)).body.urls;
  const etag = (await agent.put(urls[1].replace(WEB, '')).set('Origin', WEB).set('Content-Type', 'application/octet-stream').send(data).expect(200)).headers.etag;
  await agent.post(`/api/uploads/${start.videoId}/complete`).set('Origin', WEB).send({ parts: [{ partNumber: 1, etag }] }).expect(200);
  for (let i = 0; i < 600; i++) {
    const v = (await agent.get(`/api/hub/videos/${start.videoId}`)).body.video;
    if (v.status === 'FAILED' || (v.status === 'READY' && v.processingStage === 'Ready')) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('not ready');
}

const streams = (m: string, codec: string) => m.split('\n').filter((l) => l.startsWith('#EXT-X-STREAM-INF') && l.includes(`"${codec}`)).length;

test('settings: AV1 is on from 500 views by default; 0 turns it off; presets and quality stay in range', () => {
  const base = { NODE_ENV: 'test', DATABASE_URL: 'postgresql://x', SESSION_SECRET: 'test-session-secret-0123456789-abcdefghijklmnop' };
  expect(loadConfig(base).media.av1).toEqual({ minViews: 500, preset: 8, crf: 32 });
  expect(loadConfig({ ...base, AV1_MIN_VIEWS: '0' }).media.av1.minViews).toBe(0);
  expect(() => loadConfig({ ...base, AV1_PRESET: '14' })).toThrow(/AV1_PRESET/);
  expect(() => loadConfig({ ...base, AV1_CRF: '70' })).toThrow(/AV1_CRF/);
});

test('codec strings and bitrates', () => {
  expect(av1Codecs(8)).toBe('av01.0.08M.08');
  expect(av1Codecs(13)).toBe('av01.0.13M.08');
  expect(av1LevelFor(426, 240, 30)).toBe(0);
  expect(av1LevelFor(1920, 1080, 30)).toBe(8);
  expect(av1LevelFor(1920, 1080, 60)).toBe(9);
  expect(av1LevelFor(3840, 2160, 30)).toBe(12);
  const r720 = planLadder(1920, 1080, 30).find((r) => r.name === '720p')!;
  expect(av1Rung(r720)).toMatchObject({ name: '720p', width: 1280, height: 720, videoKbps: Math.round(r720.videoKbps * 0.65), maxKbps: Math.round(r720.maxKbps * 0.65) });
});

test('a popular video gets AV1 at every quality, listed beside H.264 under the same free limit; only once', async () => {
  const c = await signIn(ctx.http, ctx.mail, 'maker@example.com');
  await c.agent.post('/api/channels').set('Origin', WEB).send({ handle: 'maker', name: 'Maker' }).expect(201);
  const v = await uploadAndWait(c.agent, clip);
  expect(v.renditions).toEqual(['144p', '240p', '360p', '480p', '720p', '1080p']);

  const jobs = new MediaJobs(ctx.prisma as never, createStorage(ctx.config), ctx.config, null);
  expect(await jobs.popularAv1()).toEqual([]); // not watched enough yet
  await ctx.prisma.video.update({ where: { id: v.id }, data: { viewCount: 50 } });
  expect(await jobs.popularAv1()).toEqual([v.id]);
  expect(await jobs.popularAv1()).toEqual([]); // claimed once

  const h264 = join(dir, 'storage', 'prv', v.id, 'hls', '720p', 'init.mp4');
  const before = statSync(h264).mtimeMs;
  await jobs.av1(v.id);
  expect(statSync(h264).mtimeMs).toBe(before); // the H.264 renditions are left as they are

  const rows = await ctx.prisma.videoRendition.findMany({ where: { videoId: v.id, codec: 'av1' }, orderBy: { height: 'asc' } });
  expect(rows.map((r) => r.resolution)).toEqual(['144p', '240p', '360p', '480p', '720p', '1080p']);
  for (const r of rows) {
    expect(r.codecs).toMatch(/^av01\.0\.\d\dM\.08,mp4a\.40\.2$/);
    expect(r.playlistKey).toBe(`hls/av1-${r.resolution}/index.m3u8`);
    expect(existsSync(join(dir, 'storage', 'prv', v.id, 'hls', `av1-${r.resolution}`, 'index.m3u8'))).toBe(true);
  }
  // The AV1 files really are AV1, with a keyframe every 2 seconds (every rung cuts its segments at the same times).
  const probe = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=codec_name,width,height', '-of', 'csv=p=0', join(dir, 'storage', 'prv', v.id, 'hls', 'av1-720p', 'index.m3u8')]).toString().trim().split('\n')[0];
  expect(probe).toBe('av1,1280,720');
  const keys = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'frame=key_frame,pts_time', '-of', 'csv=p=0', join(dir, 'storage', 'prv', v.id, 'hls', 'av1-360p', 'index.m3u8')]).toString()
    .trim().split('\n').map((l) => l.split(',')).filter(([k]) => k === '1').map(([, t]) => Math.round(Number(t)));
  expect(keys).toEqual([0, 2]);

  // Free viewers: H.264 and AV1 up to 720p. Premium and the owner: both up to 1080p.
  await ctx.prisma.video.update({ where: { id: v.id }, data: { visibility: 'UNLISTED' } });
  const anon = request(ctx.http);
  const free = (await anon.get(`/api/videos/${v.id}/hls/master.m3u8`).expect(200)).text;
  expect([streams(free, 'avc1'), streams(free, 'av01')]).toEqual([5, 5]);
  expect(free).toContain('av1-720p/index.m3u8');
  expect(free).not.toContain('1080p');
  const full = (await c.agent.get(`/api/videos/${v.id}/hls/master-full.m3u8`).expect(200)).text;
  expect([streams(full, 'avc1'), streams(full, 'av01')]).toEqual([6, 6]);
  // The AV1 variant playlist through the API, with signed segment links.
  const variant = (await anon.get(`/api/videos/${v.id}/hls/av1-720p/index.m3u8`).expect(200)).text;
  const signed = /#EXT-X-MAP:URI="[^"]*\/file\/([\w-]+)\./.exec(variant)![1];
  expect(JSON.parse(Buffer.from(signed, 'base64url').toString()).k).toBe(`prv/${v.id}/hls/av1-720p/init.mp4`);
  // Creator Hub lists each quality once.
  expect((await c.agent.get(`/api/hub/videos/${v.id}`).expect(200)).body.video.renditions).toEqual(['144p', '240p', '360p', '480p', '720p', '1080p']);

  // Running again (a retried job) adds nothing and changes nothing.
  const av1File = join(dir, 'storage', 'prv', v.id, 'hls', 'av1-720p', 'init.mp4');
  const at = statSync(av1File).mtimeMs;
  await jobs.av1(v.id);
  expect(statSync(av1File).mtimeMs).toBe(at);
}, 240_000);

test('after the original was deleted to save storage, AV1 is made from the best H.264 rendition', async () => {
  const c = await signIn(ctx.http, ctx.mail, 'old@example.com');
  await c.agent.post('/api/channels').set('Origin', WEB).send({ handle: 'oldone', name: 'Old' }).expect(201);
  const v = await uploadAndWait(c.agent, clip);
  const row = await ctx.prisma.video.findUniqueOrThrow({ where: { id: v.id } });
  rmSync(join(dir, 'storage', 'src', v.id), { recursive: true, force: true });
  await ctx.prisma.video.update({ where: { id: v.id }, data: { sourceFileS3Key: null, viewCount: 80 } });
  expect(row.sourceFileS3Key).toBeTruthy();
  const jobs = new MediaJobs(ctx.prisma as never, createStorage(ctx.config), ctx.config, null);
  expect(await jobs.popularAv1()).toEqual([v.id]);
  await jobs.av1(v.id);
  const rows = await ctx.prisma.videoRendition.findMany({ where: { videoId: v.id, codec: 'av1' } });
  expect(rows.map((r) => r.resolution).sort()).toEqual(['1080p', '144p', '240p', '360p', '480p', '720p']);
}, 240_000);

test('removed, still-processing and HD-waiting videos are not picked, and AV1 off picks nothing', async () => {
  const c = await signIn(ctx.http, ctx.mail, 'skip@example.com');
  await c.agent.post('/api/channels').set('Origin', WEB).send({ handle: 'skipper', name: 'Skip' }).expect(201);
  const v = await uploadAndWait(c.agent, clip);
  const jobs = new MediaJobs(ctx.prisma as never, createStorage(ctx.config), ctx.config, null);
  for (const data of [{ takenDownAt: new Date() }, { processingStage: 'Playable · adding qualities' }, { hdPending: true }]) {
    await ctx.prisma.video.update({ where: { id: v.id }, data: { viewCount: 1000, takenDownAt: null, processingStage: 'Ready', hdPending: false, ...data } });
    expect(await jobs.popularAv1()).toEqual([]);
  }
  await ctx.prisma.video.update({ where: { id: v.id }, data: { takenDownAt: null, processingStage: 'Ready', hdPending: false } });
  const off = { ...ctx.config, media: { ...ctx.config.media, av1: { ...ctx.config.media.av1, minViews: 0 } } };
  expect(await new MediaJobs(ctx.prisma as never, createStorage(off), off, null).popularAv1()).toEqual([]);
  expect(await jobs.popularAv1()).toEqual([v.id]);
}, 180_000);

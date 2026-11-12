import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { makeApp, resetDb, signIn, WEB } from './helpers';
import { loadConfig } from '../src/config/config';
import { MediaJobs } from '../src/media/jobs';
import { createStorage } from '../src/media/storage';
import { Billing } from '../src/billing/billing';

// Delivery cost controls: 1080p and above wait until a video is watched (HD_MIN_VIEWS, default 100), and free
// viewers get qualities up to FREE_MAX_QUALITY (default 720p) while Premium members and the owner get every one.
const dir = mkdtempSync(join(tmpdir(), 'freeme-cost-'));
let ctx: Awaited<ReturnType<typeof makeApp>>;
let clip: string;
beforeAll(async () => {
  ctx = await makeApp({ redis: false, storageDir: join(dir, 'storage') });
  clip = join(dir, 'camera.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-b:v', '4M', '-maxrate', '4M', '-bufsize', '8M', '-g', '60', '-c:a', 'aac', '-shortest', clip]);
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

const streams = (m: string) => (m.match(/#EXT-X-STREAM-INF/g) ?? []).length;

test('settings: defaults, 0 turns a limit off, and only real qualities are accepted', () => {
  const base = { NODE_ENV: 'test', DATABASE_URL: 'postgresql://x', SESSION_SECRET: 'test-session-secret-0123456789-abcdefghijklmnop' };
  expect(loadConfig(base).media).toMatchObject({ hdMinViews: 100, freeMaxShort: 720 });
  expect(loadConfig({ ...base, HD_MIN_VIEWS: '0', FREE_MAX_QUALITY: '0' }).media).toMatchObject({ hdMinViews: 0, freeMaxShort: 0 });
  expect(loadConfig(base).billing.adCpmUsdCents).toBe(100);
  expect(() => loadConfig({ ...base, FREE_MAX_QUALITY: '700' })).toThrow(/FREE_MAX_QUALITY/);
  expect(() => loadConfig({ ...base, HD_MIN_VIEWS: '-1' })).toThrow(/HD_MIN_VIEWS/);
});

test('1080p waits for viewers; once the video is popular only the missing qualities are encoded; free viewers stay at 720p', async () => {
  const c = await signIn(ctx.http, ctx.mail, 'maker@example.com');
  await c.agent.post('/api/channels').set('Origin', WEB).send({ handle: 'maker', name: 'Maker' }).expect(201);
  const v = await uploadAndWait(c.agent, clip);
  expect(v.renditions).toEqual(['144p', '240p', '360p', '480p', '720p']);
  expect(await ctx.prisma.video.findUniqueOrThrow({ where: { id: v.id } })).toMatchObject({ hdPending: true, hlsFullMasterKey: null });

  const jobs = new MediaJobs(ctx.prisma as never, createStorage(ctx.config), ctx.config, null);
  expect(await jobs.popularUpgrades()).toEqual([]); // not watched enough yet
  await ctx.prisma.video.update({ where: { id: v.id }, data: { viewCount: 100 } });
  expect(await jobs.popularUpgrades()).toEqual([v.id]);
  expect(await jobs.popularUpgrades()).toEqual([]); // claimed once

  const sd = join(dir, 'storage', 'prv', v.id, 'hls', '720p', 'init.mp4');
  const before = statSync(sd).mtimeMs;
  await jobs.transcode(v.id, true, undefined, 'rest');
  expect(statSync(sd).mtimeMs).toBe(before); // 720p was not encoded again
  const row = await ctx.prisma.video.findUniqueOrThrow({ where: { id: v.id }, include: { renditions: true } });
  expect(row.renditions.map((r) => r.resolution).sort()).toContain('1080p');
  expect(row).toMatchObject({ hdPending: false, hlsFullMasterKey: 'hls/master-full.m3u8', processingStage: 'Ready' });

  // Unlisted: anyone with the link can watch, through the API's playlist route (media still private here).
  await ctx.prisma.video.update({ where: { id: v.id }, data: { visibility: 'UNLISTED' } });
  const anon = request(ctx.http);
  expect(streams((await anon.get(`/api/videos/${v.id}/hls/master.m3u8`).expect(200)).text)).toBe(5);
  await anon.get(`/api/videos/${v.id}/hls/master-full.m3u8`).expect(404);
  expect((await anon.get(`/api/videos/${v.id}`).expect(200)).body.video).toMatchObject({ playbackUrl: `/api/videos/${v.id}/hls/master.m3u8`, qualityLimit: 720 });

  // The owner and Premium members get every quality.
  expect((await c.agent.get(`/api/videos/${v.id}`).expect(200)).body.video).toMatchObject({ playbackUrl: `/api/videos/${v.id}/hls/master-full.m3u8`, qualityLimit: null });
  const fan = await signIn(ctx.http, ctx.mail, 'fan@example.com');
  await fan.agent.get(`/api/videos/${v.id}/hls/master-full.m3u8`).expect(404);
  await new Billing(ctx.prisma as never, ctx.config).grantPremium((await ctx.prisma.user.findUniqueOrThrow({ where: { email: 'fan@example.com' } })).id, 1);
  expect(streams((await fan.agent.get(`/api/videos/${v.id}/hls/master-full.m3u8`).expect(200)).text)).toBe(6);
  expect((await fan.agent.get(`/api/videos/${v.id}`).expect(200)).body.video.qualityLimit).toBeNull();
}, 180_000);

test('a Premium creator\'s upload gets every quality at once', async () => {
  const c = await signIn(ctx.http, ctx.mail, 'pro@example.com');
  await c.agent.post('/api/channels').set('Origin', WEB).send({ handle: 'pro', name: 'Pro' }).expect(201);
  await new Billing(ctx.prisma as never, ctx.config).grantPremium((await ctx.prisma.user.findUniqueOrThrow({ where: { email: 'pro@example.com' } })).id, 1);
  const v = await uploadAndWait(c.agent, clip);
  expect(v.renditions).toContain('1080p');
  expect(await ctx.prisma.video.findUniqueOrThrow({ where: { id: v.id } })).toMatchObject({ hdPending: false, hlsFullMasterKey: 'hls/master-full.m3u8' });
}, 180_000);

test('SOURCE_RETENTION_DAYS: an old video\'s original is deleted; it keeps its qualities and gives up waiting for HD', async () => {
  const c = await signIn(ctx.http, ctx.mail, 'old@example.com');
  await c.agent.post('/api/channels').set('Origin', WEB).send({ handle: 'oldone', name: 'Old' }).expect(201);
  const v = await uploadAndWait(c.agent, clip);
  const before = await ctx.prisma.video.findUniqueOrThrow({ where: { id: v.id } });
  expect(before).toMatchObject({ hdPending: true, sourceFileS3Key: expect.any(String) });
  const config = { ...ctx.config, media: { ...ctx.config.media, sourceRetentionDays: 30 } };
  const jobs = new MediaJobs(ctx.prisma as never, createStorage(config), config, null);
  expect(await jobs.expireSources()).toBe(0); // too new
  await ctx.prisma.video.update({ where: { id: v.id }, data: { createdAt: new Date(Date.now() - 31 * 86_400_000) } });
  expect(await jobs.expireSources()).toBe(1);
  const after = await ctx.prisma.video.findUniqueOrThrow({ where: { id: v.id }, include: { renditions: true } });
  expect(after).toMatchObject({ sourceFileS3Key: null, hdPending: false, status: 'READY' });
  expect(after.renditions.map((r) => r.resolution).sort()).toEqual(['144p', '240p', '360p', '480p', '720p']);
  expect(existsSync(join(dir, 'storage', before.sourceFileS3Key!))).toBe(false);
  expect(existsSync(join(dir, 'storage', 'prv', v.id, 'hls', '720p', 'index.m3u8'))).toBe(true);
  // Without retention set, nothing is ever deleted.
  expect(await new MediaJobs(ctx.prisma as never, createStorage(ctx.config), ctx.config, null).expireSources()).toBe(0);
}, 180_000);

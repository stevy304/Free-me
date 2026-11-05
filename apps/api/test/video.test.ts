import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import Redis from 'ioredis';
import { makeApp, resetDb, signIn, WEB } from './helpers';
import { ViewCounter } from '../src/media/views';
import { planLadder, masterPlaylist } from '../src/media/ladder';

// Uploads, processing and playback with real ffmpeg and the local storage driver (no Redis: jobs run in the API).
const dir = mkdtempSync(join(tmpdir(), 'freeme-video-'));
const storageDir = join(dir, 'storage');
let ctx: Awaited<ReturnType<typeof makeApp>>;

const ff = (...args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
const landscape = join(dir, 'Holiday_in_Musanze.mp4');
const vertical = join(dir, 'dance.mov');
const fake = join(dir, 'not-a-video.mp4');

beforeAll(async () => {
  // ~10 MB (lossless) so the upload has several 5 MB parts.
  ff('-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-c:a', 'aac', '-shortest', landscape);
  ff('-f', 'lavfi', '-i', 'testsrc2=size=720x1280:rate=30:duration=3', '-c:v', 'libx264', '-preset', 'ultrafast', vertical);
  writeFileSync(fake, 'this is text, not video');
  ctx = await makeApp({ redis: false, storageDir });
}, 60_000);
beforeEach(async () => { await resetDb(ctx.prisma); ctx.mail.outbox.length = 0; await ctx.clearLimits(); });
afterAll(async () => { await ctx.app.close(); rmSync(dir, { recursive: true, force: true }); });

const path = (url: string) => url.replace(WEB, '');

async function creator(email = 'maker@example.com', handle = 'maker.films') {
  const { agent } = await signIn(ctx.http, ctx.mail, email);
  await agent.post('/api/channels').set('Origin', WEB).send({ handle, name: 'Maker Films' }).expect(201);
  return agent;
}

async function upload(agent: ReturnType<typeof request.agent>, file: string, opts: { stopAfterFirst?: boolean } = {}) {
  const data = readFileSync(file);
  const start = await agent.post('/api/uploads').set('Origin', WEB).send({ fileName: file.split('/').pop(), sizeBytes: data.length }).expect(201);
  const { videoId, partSize, partCount } = start.body;
  const numbers = Array.from({ length: partCount }, (_, i) => i + 1);
  const urls = (await agent.post(`/api/uploads/${videoId}/parts`).set('Origin', WEB).send({ partNumbers: numbers }).expect(200)).body.urls;
  const parts: Array<{ partNumber: number; etag: string }> = [];
  for (const n of numbers) {
    const res = await agent.put(path(urls[n])).set('Origin', WEB).set('Content-Type', 'application/octet-stream').send(data.subarray((n - 1) * partSize, n * partSize)).expect(200);
    parts.push({ partNumber: n, etag: res.headers.etag });
    if (opts.stopAfterFirst) return { videoId, parts, partCount };
  }
  await agent.post(`/api/uploads/${videoId}/complete`).set('Origin', WEB).send({ parts }).expect(200, { videoId, status: 'PROCESSING' });
  return { videoId, parts, partCount };
}

async function until(agent: ReturnType<typeof request.agent>, id: string, ok: (v: any) => boolean, ms = 90_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = (await agent.get(`/api/hub/videos/${id}`).expect(200)).body.video;
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

test('rendition ladder: never upscales, names rungs by the short side, portrait keeps its shape', () => {
  expect(planLadder(1920, 1080, 30).map((r) => r.name)).toEqual(['144p', '240p', '360p', '480p', '720p', '1080p']);
  expect(planLadder(3840, 2160, 60).map((r) => `${r.name}:${r.width}x${r.height}`).slice(-2)).toEqual(['1440p:2560x1440', '2160p:3840x2160']);
  expect(planLadder(1080, 1920, 30).at(-1)).toMatchObject({ name: '1080p', width: 1080, height: 1920 });
  expect(planLadder(100, 80, 30).map((r) => `${r.width}x${r.height}`)).toEqual(['100x80']);
  expect(planLadder(3840, 2160, 60).at(-1)!.videoKbps).toBe(24000);
  expect(masterPlaylist([{ name: '720p', width: 1280, height: 720, bandwidth: 3_000_000, codecs: 'avc1.64001f,mp4a.40.2', frameRate: 30, playlist: '720p/index.m3u8' }]))
    .toContain('#EXT-X-STREAM-INF:BANDWIDTH=3000000,AVERAGE-BANDWIDTH=2250000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",FRAME-RATE=30.000,NAME="720p"\n720p/index.m3u8');
});

test('upload in parts, resume, process to adaptive HLS, play privately, publish to the CDN prefix, count views, delete', async () => {
  const agent = await creator();
  // Resumable: after one part, the API reports what is stored; the rest is sent and the upload completes.
  const first = await upload(agent, landscape, { stopAfterFirst: true });
  expect(first.partCount).toBeGreaterThanOrEqual(2);
  const rest = Array.from({ length: first.partCount - 1 }, (_, i) => i + 2);
  const state = (await agent.get(`/api/uploads/${first.videoId}`).expect(200)).body;
  expect(state.parts.map((p: any) => p.partNumber)).toEqual([1]);
  const data = readFileSync(landscape);
  const urls = (await agent.post(`/api/uploads/${first.videoId}/parts`).set('Origin', WEB).send({ partNumbers: rest }).expect(200)).body.urls;
  const parts = [...state.parts.map((p: any) => ({ partNumber: p.partNumber, etag: p.etag }))];
  for (const n of rest) parts.push({ partNumber: n, etag: (await agent.put(path(urls[n])).set('Origin', WEB).send(data.subarray((n - 1) * state.partSize, n * state.partSize)).expect(200)).headers.etag });
  await agent.post(`/api/uploads/${first.videoId}/complete`).set('Origin', WEB).send({ parts: parts.slice(0, -1) }).expect(400);
  await agent.post(`/api/uploads/${first.videoId}/complete`).set('Origin', WEB).send({ parts }).expect(200);
  const id = first.videoId;

  const v = await until(agent, id, (x) => x.status === 'READY' && x.processingStage === 'Ready');
  expect(v).toMatchObject({ title: 'Holiday in Musanze', visibility: 'PRIVATE', durationSeconds: 4, width: 1280, height: 720, isShort: false, processingProgress: 100 });
  expect(v.renditions).toEqual(['144p', '240p', '360p', '480p', '720p']);
  expect(v.thumbnailCandidates).toHaveLength(3);
  expect(v.playbackUrl).toBe(`/api/videos/${id}/hls/master.m3u8`);
  expect(existsSync(join(storageDir, 'prv', id, 'hls', '720p', 'init.mp4'))).toBe(true);

  // Private: only the owner can play; segments are short-lived signed links.
  const master = (await agent.get(v.playbackUrl).expect(200)).text;
  expect(master.match(/#EXT-X-STREAM-INF/g)).toHaveLength(5);
  expect(master).toContain('RESOLUTION=1280x720');
  const variant = (await agent.get(`/api/videos/${id}/hls/720p/index.m3u8`).expect(200)).text;
  expect(variant).toMatch(/#EXT-X-MAP:URI="http:\/\/localhost:3000\/api\/storage\/local\/file\/[\w.-]+"/);
  const seg = variant.split('\n').find((l) => l.startsWith('http'))!;
  const segRes = await agent.get(path(seg)).expect(200);
  expect(segRes.body.length).toBeGreaterThan(1000);
  await request(ctx.http).get(v.playbackUrl).expect(404);
  await request(ctx.http).get(`/api/videos/${id}`).expect(404);
  await request(ctx.http).get(`/api/videos/${id}/hls/../../etc/passwd`).expect(404);
  expect((await request(ctx.http).get('/api/videos')).body.videos).toEqual([]);

  // Publish: details saved, media moves to the public (CDN) prefix, the video appears in the feed.
  const saved = await agent.patch(`/api/hub/videos/${id}`).set('Origin', WEB).send({ title: 'Gorillas of Musanze', description: 'A morning in the park.', category: 'travel-events', tags: ['Rwanda', '#travel', 'rwanda'], visibility: 'PUBLIC', thumbnail: 2, language: 'rw' }).expect(200);
  expect(saved.body.video).toMatchObject({ title: 'Gorillas of Musanze', visibility: 'PUBLIC', category: { slug: 'travel-events' }, tags: ['rwanda', 'travel'], language: 'rw' });
  await agent.patch(`/api/hub/videos/${id}`).set('Origin', WEB).send({ category: 'not-a-category' }).expect(400);
  await until(agent, id, (x) => x.playbackUrl?.startsWith(WEB));
  // The old private copy is deleted after the switch (so playback never breaks mid-move).
  for (let i = 0; i < 50 && existsSync(join(storageDir, 'prv', id)); i++) await new Promise((r) => setTimeout(r, 100));
  expect(existsSync(join(storageDir, 'prv', id))).toBe(false);
  const feed = (await request(ctx.http).get('/api/videos').expect(200)).body.videos;
  expect(feed).toHaveLength(1);
  expect(feed[0]).toMatchObject({ id, title: 'Gorillas of Musanze', durationSeconds: 4, thumbnailUrl: `${WEB}/api/storage/local/pub/${id}/thumbs/3.jpg` });
  const watch = (await request(ctx.http).get(`/api/videos/${id}`).expect(200)).body.video;
  expect(watch.playbackUrl).toBe(`${WEB}/api/storage/local/pub/${id}/hls/master.m3u8`);
  expect((await request(ctx.http).get(path(watch.playbackUrl)).expect(200)).text).toContain('720p/index.m3u8');
  expect((await request(ctx.http).get(`/api/search?q=gorillas`)).body.videos.map((x: any) => x.id)).toEqual([id]);

  // Views: only after real watching; the owner's own views do not count.
  await request(ctx.http).post(`/api/videos/${id}/views`).set('Origin', WEB).send({ watchedSeconds: 0.5 }).expect(400);
  expect((await request(ctx.http).post(`/api/videos/${id}/views`).set('Origin', WEB).send({ watchedSeconds: 3 }).expect(200)).body).toEqual({ counted: true });
  expect((await agent.post(`/api/videos/${id}/views`).set('Origin', WEB).send({ watchedSeconds: 4 }).expect(200)).body).toEqual({ counted: false });
  expect((await request(ctx.http).get(`/api/videos/${id}`)).body.video.viewCount).toBe('1');

  // Custom thumbnail: images only, by their bytes.
  await agent.put(`/api/hub/videos/${id}/thumbnail`).set('Origin', WEB).set('Content-Type', 'image/jpeg').send(Buffer.from('not an image')).expect(400);
  const jpg = readFileSync(join(storageDir, 'pub', id, 'thumbs', '1.jpg'));
  const custom = await agent.put(`/api/hub/videos/${id}/thumbnail`).set('Origin', WEB).set('Content-Type', 'image/jpeg').send(jpg).expect(200);
  expect(custom.body.video.customThumbnail).toBe(true);

  // Someone else cannot touch it; deleting removes every file.
  const other = await creator('other@example.com', 'other.channel');
  await other.patch(`/api/hub/videos/${id}`).set('Origin', WEB).send({ title: 'Mine now' }).expect(404);
  await other.delete(`/api/hub/videos/${id}`).set('Origin', WEB).expect(404);
  await agent.delete(`/api/hub/videos/${id}`).set('Origin', WEB).expect(200);
  for (let i = 0; i < 50 && existsSync(join(storageDir, 'pub', id)); i++) await new Promise((r) => setTimeout(r, 100));
  expect(existsSync(join(storageDir, 'pub', id))).toBe(false);
  expect(existsSync(join(storageDir, 'src', id))).toBe(false);
}, 180_000);

test('a vertical clip becomes a Short; a file that is not a video fails with a clear reason; bad uploads are refused', async () => {
  const agent = await creator();
  const short = await upload(agent, vertical);
  const s = await until(agent, short.videoId, (x) => x.status === 'READY' && x.processingStage === 'Ready');
  expect(s).toMatchObject({ isShort: true, width: 720, height: 1280 });
  expect(s.renditions).toEqual(['144p', '240p', '360p', '480p', '720p']);

  const bad = await upload(agent, fake);
  const b = await until(agent, bad.videoId, (x) => x.status === 'FAILED');
  expect(b.processingError).toMatch(/could not be read as a video/);

  await agent.post('/api/uploads').set('Origin', WEB).send({ fileName: 'setup.exe', sizeBytes: 100 }).expect(400);
  await agent.post('/api/uploads').set('Origin', WEB).send({ fileName: 'huge.mp4', sizeBytes: 1e15 }).expect(400);
  const cancel = (await agent.post('/api/uploads').set('Origin', WEB).send({ fileName: 'later.mp4', sizeBytes: 1000 }).expect(201)).body.videoId;
  await agent.delete(`/api/uploads/${cancel}`).set('Origin', WEB).expect(200);
  await agent.get(`/api/hub/videos/${cancel}`).expect(404);

  const viewer = (await signIn(ctx.http, ctx.mail, 'just.watching@example.com')).agent;
  await viewer.post('/api/uploads').set('Origin', WEB).send({ fileName: 'a.mp4', sizeBytes: 100 }).expect(403);
}, 120_000);

const redisTest = process.env.REDIS_URL ? test : test.skip;
redisTest('views are de-duplicated in Redis and written to the database in batches', async () => {
  const agent = await creator();
  const ch = (await agent.get('/api/me')).body.channel;
  const video = await ctx.prisma.video.create({ data: { channelId: ch.id, title: 'Counted', status: 'READY', visibility: 'PUBLIC', durationSeconds: 60 } });
  const redis = new Redis(process.env.REDIS_URL!);
  await redis.del('fm:views:pending', 'fm:watch:pending', `fm:view:${video.id}:viewer-a`, `fm:view:${video.id}:viewer-b`);
  const counter = new ViewCounter(ctx.prisma, redis);
  expect(await counter.record(video.id, 'viewer-a', 40)).toBe(true);
  expect(await counter.record(video.id, 'viewer-a', 20)).toBe(false);
  expect(await counter.record(video.id, 'viewer-b', 30)).toBe(true);
  expect((await ctx.prisma.video.findUniqueOrThrow({ where: { id: video.id } })).viewCount).toBe(0n);
  expect(await counter.flush()).toBe(1);
  const after = await ctx.prisma.video.findUniqueOrThrow({ where: { id: video.id }, include: { channel: true } });
  expect([after.viewCount, after.watchTimeSeconds, after.channel.totalViews]).toEqual([2n, 90n, 2n]);
  expect(await counter.flush()).toBe(0);
  await redis.quit();
});

test('uploads abandoned for more than three days are removed', async () => {
  const agent = await creator();
  const fresh = (await agent.post('/api/uploads').set('Origin', WEB).send({ fileName: 'new.mp4', sizeBytes: 1000 }).expect(201)).body.videoId;
  const old = (await agent.post('/api/uploads').set('Origin', WEB).send({ fileName: 'old.mp4', sizeBytes: 1000 }).expect(201)).body.videoId;
  await ctx.prisma.video.update({ where: { id: old }, data: { createdAt: new Date(Date.now() - 4 * 86_400_000) } });
  const { MediaJobs } = await import('../src/media/jobs');
  const { STORAGE } = await import('../src/media/queue');
  const jobs = new MediaJobs(ctx.prisma, ctx.app.get(STORAGE), ctx.config, null);
  expect(await jobs.cleanupStaleUploads()).toBe(1);
  expect(await ctx.prisma.video.findUnique({ where: { id: old } })).toBeNull();
  expect(await ctx.prisma.video.findUnique({ where: { id: fresh } })).not.toBeNull();
});

test('videos whose processing stopped are found for re-processing; finished ones are left alone', async () => {
  const agent = await creator();
  const ch = (await agent.get('/api/me')).body.channel;
  const old = new Date(Date.now() - 2 * 3600_000);
  const stuck = await ctx.prisma.video.create({ data: { channelId: ch.id, title: 'Stuck', status: 'PROCESSING' } });
  const halfway = await ctx.prisma.video.create({ data: { channelId: ch.id, title: 'SD only', status: 'READY', processingStage: 'SD ready · processing HD' } });
  await ctx.prisma.video.create({ data: { channelId: ch.id, title: 'Done', status: 'READY', processingStage: 'Ready' } });
  await ctx.prisma.video.create({ data: { channelId: ch.id, title: 'Just started', status: 'PROCESSING' } });
  await ctx.prisma.$executeRaw`UPDATE "Video" SET "updatedAt" = ${old} WHERE title IN ('Stuck', 'SD only', 'Done')`;
  const { MediaJobs } = await import('../src/media/jobs');
  const { STORAGE } = await import('../src/media/queue');
  const jobs = new MediaJobs(ctx.prisma, ctx.app.get(STORAGE), ctx.config, null);
  expect((await jobs.stuckVideos()).sort()).toEqual([stuck.id, halfway.id].sort());
});

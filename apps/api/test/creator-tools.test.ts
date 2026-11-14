import Redis from 'ioredis';
import request from 'supertest';
import { makeApp, resetDb, signIn, WEB } from './helpers';
import { Billing } from '../src/billing/billing';
import { ViewCounter } from '../src/media/views';

let ctx: Awaited<ReturnType<typeof makeApp>>;
// A 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

beforeAll(async () => { ctx = await makeApp({ env: { MONETISE_MIN_WATCH_HOURS: '2', MONETISE_MIN_FOLLOWERS: '1' } }); });
beforeEach(async () => { await resetDb(ctx.prisma); ctx.mail.outbox.length = 0; await ctx.clearLimits(); });
afterAll(async () => { await ctx.app.close(); });

async function creator(email: string, handle: string) {
  const c = await signIn(ctx.http, ctx.mail, email);
  await c.agent.post('/api/channels').set('Origin', WEB).send({ handle, name: handle }).expect(201);
  return c.agent;
}

test('profile picture, Space picture and banner: images only, served publicly, replaced and removed', async () => {
  const me = await creator('pics@example.com', 'pics');
  await me.put('/api/me/avatar').set('Origin', WEB).set('Content-Type', 'image/png').send(Buffer.from('not an image')).expect(400);
  const first = (await me.put('/api/me/avatar').set('Origin', WEB).set('Content-Type', 'image/png').send(PNG).expect(200)).body.avatarUrl;
  expect(first).toMatch(/\/profiles\/[0-9a-f-]{36}\/avatar\/\d+\.png$/);
  const path = (url: string) => url.replace(/^https?:\/\/[^/]+/, '');
  expect((await request(ctx.http).get(path(first)).expect(200)).headers['content-type']).toBe('image/png');
  expect((await me.get('/api/me').expect(200)).body.profile.avatarUrl).toBe(first);
  // A new picture replaces the old file.
  await new Promise((r) => setTimeout(r, 5));
  const second = (await me.put('/api/me/avatar').set('Origin', WEB).set('Content-Type', 'image/png').send(PNG).expect(200)).body.avatarUrl;
  expect(second).not.toBe(first);
  await request(ctx.http).get(path(first)).expect(404);
  await me.delete('/api/me/avatar').set('Origin', WEB).expect(200);
  expect((await me.get('/api/me').expect(200)).body.profile.avatarUrl).toBeNull();

  const avatar = (await me.put('/api/channels/mine/avatar').set('Origin', WEB).set('Content-Type', 'image/png').send(PNG).expect(200)).body.avatarUrl;
  const banner = (await me.put('/api/channels/mine/banner').set('Origin', WEB).set('Content-Type', 'image/png').send(PNG).expect(200)).body.bannerUrl;
  expect((await request(ctx.http).get('/api/channels/pics').expect(200)).body.channel).toMatchObject({ avatarUrl: avatar, bannerUrl: banner });
  await me.delete('/api/channels/mine/banner').set('Origin', WEB).expect(200);
  expect((await request(ctx.http).get('/api/channels/pics').expect(200)).body.channel.bannerUrl).toBeNull();
  // Without a Space, there is nothing to put a banner on.
  const viewer = (await signIn(ctx.http, ctx.mail, 'nospace@example.com')).agent;
  await viewer.put('/api/channels/mine/banner').set('Origin', WEB).set('Content-Type', 'image/png').send(PNG).expect(404);
});

test('one picture follows a person: a Space without its own picture shows the profile picture, in its videos and comments too', async () => {
  const me = await creator('face@example.com', 'face');
  const space = async () => (await request(ctx.http).get('/api/channels/face').expect(200)).body.channel;
  expect((await space()).avatarUrl).toBeNull();
  // The profile picture becomes the Space's picture...
  const profile = (await me.put('/api/me/avatar').set('Origin', WEB).set('Content-Type', 'image/png').send(PNG).expect(200)).body.avatarUrl;
  expect(await space()).toMatchObject({ avatarUrl: profile, avatarFromProfile: true });
  // ...so it is next to the creator's videos and comments.
  const ch = await ctx.prisma.channel.findUniqueOrThrow({ where: { handle: 'face' } });
  const video = await ctx.prisma.video.create({ data: { channelId: ch.id, title: 'Hello', durationSeconds: 60, status: 'READY', visibility: 'PUBLIC', mediaLocation: 'PUBLIC', hlsMasterKey: 'hls/master.m3u8', publishedAt: new Date(), safetyCheckedAt: new Date() } });
  expect((await request(ctx.http).get(`/api/videos/${video.id}`).expect(200)).body.video.channel.avatarUrl).toBe(profile);
  await me.post(`/api/videos/${video.id}/comments`).set('Origin', WEB).send({ content: 'Thanks for watching!' }).expect(201);
  expect((await request(ctx.http).get(`/api/videos/${video.id}/comments`).expect(200)).body.comments[0].author.avatarUrl).toBe(profile);
  // A picture of the Space's own wins, and stays when the profile picture changes.
  const own = (await me.put('/api/channels/mine/avatar').set('Origin', WEB).set('Content-Type', 'image/png').send(PNG).expect(200)).body.avatarUrl;
  expect(await space()).toMatchObject({ avatarUrl: own, avatarFromProfile: false });
  await new Promise((r) => setTimeout(r, 5));
  const newer = (await me.put('/api/me/avatar').set('Origin', WEB).set('Content-Type', 'image/png').send(PNG).expect(200)).body.avatarUrl;
  expect((await space()).avatarUrl).toBe(own);
  // Removing the Space's own picture brings the profile picture back; removing that leaves the first letter.
  expect((await me.delete('/api/channels/mine/avatar').set('Origin', WEB).expect(200)).body.avatarUrl).toBe(newer);
  expect(await space()).toMatchObject({ avatarUrl: newer, avatarFromProfile: true });
  await me.delete('/api/me/avatar').set('Origin', WEB).expect(200);
  expect(await space()).toMatchObject({ avatarUrl: null, avatarFromProfile: false });
});

const redisTest = process.env.REDIS_URL ? test : test.skip;
redisTest('a viewer coming back within 6 hours is told at once, so the player counts their watch time from the first second', async () => {
  await creator('back@example.com', 'back');
  const ch = await ctx.prisma.channel.findUniqueOrThrow({ where: { handle: 'back' } });
  const video = await ctx.prisma.video.create({ data: { channelId: ch.id, title: 'Come back', durationSeconds: 600, status: 'READY', visibility: 'PUBLIC', mediaLocation: 'PUBLIC', hlsMasterKey: 'hls/master.m3u8', publishedAt: new Date(), safetyCheckedAt: new Date() } });
  const viewer = await signIn(ctx.http, ctx.mail, 'returning@example.com');
  const me = await ctx.prisma.user.findUniqueOrThrow({ where: { email: 'returning@example.com' } });
  const redis = new Redis(process.env.REDIS_URL!);
  try {
    await redis.del(`fm:beat:${video.id}:u:${me.id}`, `fm:view:${video.id}:u:${me.id}`);
    expect((await viewer.agent.post(`/api/videos/${video.id}/play`).set('Origin', WEB).expect(200)).body).toMatchObject({ viewed: false });
    // Their view is counted…
    expect(await new ViewCounter(ctx.prisma as never, redis).record(video.id, `u:${me.id}`, 40)).toBe(true);
    // …so when they come back (resume, rewatch the end) the player is told, and short watching still adds time.
    expect((await viewer.agent.post(`/api/videos/${video.id}/play`).set('Origin', WEB).expect(200)).body).toMatchObject({ viewed: true });
    await redis.hset(`fm:beat:${video.id}:u:${me.id}`, 'at', Date.now() - 20_000);
    expect((await viewer.agent.post(`/api/videos/${video.id}/watch`).set('Origin', WEB).send({ watchedSeconds: 14 }).expect(200)).body.seconds).toBe(14);
  } finally { await redis.quit(); }
});

redisTest('watch time: heartbeats after the view count real time only, at most 2x speed and the length of the video', async () => {
  await creator('watched@example.com', 'watched');
  const ch = await ctx.prisma.channel.findUniqueOrThrow({ where: { handle: 'watched' } });
  const video = await ctx.prisma.video.create({ data: { channelId: ch.id, title: 'Ten minutes', durationSeconds: 600, status: 'READY', visibility: 'PUBLIC', mediaLocation: 'PUBLIC', hlsMasterKey: 'hls/master.m3u8', publishedAt: new Date() } });
  const redis = new Redis(process.env.REDIS_URL!);
  await redis.del('fm:views:pending', 'fm:watch:pending', 'fm:pluswatch:pending', `fm:view:${video.id}:viewer-a`, `fm:beat:${video.id}:viewer-a`, `fm:beat:${video.id}:viewer-b`);
  const counter = new ViewCounter(ctx.prisma as never, redis);
  const back = async (seconds: number) => redis.hset(`fm:beat:${video.id}:viewer-a`, 'at', Date.now() - seconds * 1000);

  // No counted view yet: a heartbeat adds nothing.
  expect(await counter.addWatch(video.id, 'viewer-b', 60, 600)).toBe(0);
  expect(await counter.record(video.id, 'viewer-a', 30)).toBe(true);
  // Right after the view, claiming a minute counts only what real time allows.
  expect(await counter.addWatch(video.id, 'viewer-a', 60, 600)).toBeLessThanOrEqual(3);
  await back(60);
  expect(await counter.addWatch(video.id, 'viewer-a', 60, 600)).toBe(60);
  await back(30);
  expect(await counter.addWatch(video.id, 'viewer-a', 60, 600)).toBe(60); // 2x speed: 60 s of video in 30 s
  await back(10);
  expect(await counter.addWatch(video.id, 'viewer-a', 120, 600)).toBe(20); // 10 s at 2x; repeated requests cannot each claim extra slack
  // Never more than the video's length (plus a minute) per viewer.
  for (let i = 0; i < 8; i++) { await back(150); await counter.addWatch(video.id, 'viewer-a', 150, 600); }
  expect(Number(await redis.hget(`fm:beat:${video.id}:viewer-a`, 'total'))).toBe(660);
  await back(150);
  expect(await counter.addWatch(video.id, 'viewer-a', 150, 600)).toBe(0);

  await counter.flush();
  const after = await ctx.prisma.video.findUniqueOrThrow({ where: { id: video.id } });
  expect(Number(after.watchTimeSeconds)).toBe(660);
  const day = await ctx.prisma.videoDailyStat.findFirstOrThrow({ where: { videoId: video.id } });
  expect({ views: day.views, watch: Number(day.watchSeconds) }).toEqual({ views: 1, watch: 660 });
  await redis.quit();
});

test('watch hours on the monetisation page; joining needs the configured watch hours and followers', async () => {
  const me = await creator('hours@example.com', 'hours');
  const user = await ctx.prisma.user.findUniqueOrThrow({ where: { email: 'hours@example.com' } });
  await new Billing(ctx.prisma as never, ctx.config).grantPremium(user.id, 1);
  const ch = await ctx.prisma.channel.findUniqueOrThrow({ where: { handle: 'hours' } });
  const video = await ctx.prisma.video.create({ data: { channelId: ch.id, title: 'Hours', durationSeconds: 3600, status: 'READY', visibility: 'PUBLIC', mediaLocation: 'PUBLIC', hlsMasterKey: 'hls/master.m3u8', publishedAt: new Date() } });
  const day = (ago: number) => new Date(new Date(new Date().toISOString().slice(0, 10)).getTime() - ago * 86_400_000);
  await ctx.prisma.videoDailyStat.createMany({ data: [
    { videoId: video.id, day: day(0), views: 3, watchSeconds: 1800n },
    { videoId: video.id, day: day(40), views: 5, watchSeconds: 3600n },
    { videoId: video.id, day: day(400), views: 9, watchSeconds: 36_000n }, // older than a year: not counted
  ] });
  const status = (await me.get('/api/hub/monetisation').expect(200)).body;
  expect(status.audience).toMatchObject({ watchHours365: 1.5, watchHours28: 0.5, watchHoursToday: 0.5, views365: 8, views28: 3, followers: 0, required: { watchHours: 2, followers: 1 }, meetsRequirements: false });
  expect((await me.post('/api/hub/monetisation/join').set('Origin', WEB).send({}).expect(403)).body.message).toBe('To join, a Space needs 2 watch hours in the last 12 months (you have 1.5) and 1 followers (you have 0).');

  await ctx.prisma.videoDailyStat.create({ data: { videoId: video.id, day: day(1), views: 1, watchSeconds: 1800n } });
  await ctx.prisma.channel.update({ where: { id: ch.id }, data: { subscriberCount: 1 } });
  const joined = (await me.post('/api/hub/monetisation/join').set('Origin', WEB).send({}).expect(200)).body;
  expect(joined).toMatchObject({ joined: true, audience: { watchHours365: 2, meetsRequirements: true } });
});

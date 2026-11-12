import request from 'supertest';
import { makeApp, resetDb, signIn, WEB } from './helpers';
import { RedisService } from '../src/database/redis.service';

// The home page's shared parts are computed once per FEED_CACHE_SECONDS for everyone; the viewer's own parts never are.
let ctx: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => { ctx = await makeApp({ env: { FEED_CACHE_SECONDS: '60' } }); });
beforeEach(async () => { await resetDb(ctx.prisma); await ctx.clearLimits(); });
afterAll(async () => { await ctx.app.close(); });

test('cached: computed once, shared, and a 0 TTL always computes', async () => {
  const redis = ctx.app.get(RedisService);
  let n = 0;
  const f = async () => ({ n: ++n });
  const [a, b] = await Promise.all([redis.cached('test:x', 60, f), redis.cached('test:x', 60, f)]);
  expect([a.n, b.n, n]).toEqual([1, 1, 1]);
  expect((await redis.cached('test:x', 60, f)).n).toBe(1);
  expect((await redis.cached('test:y', 0, f)).n).toBe(2);
  expect((await redis.cached('test:y', 0, f)).n).toBe(3);
});

test('home: newest videos are reused for a minute, continue watching is always the viewer\'s own', async () => {
  const s = await signIn(ctx.http, ctx.mail, 'maker@example.com');
  const ch = (await s.agent.post('/api/channels').set('Origin', WEB).send({ handle: 'cachemaker', name: 'Maker' }).expect(201)).body.channel;
  const mk = (title: string) => ctx.prisma.video.create({ data: { channelId: ch.id, title, durationSeconds: 300, status: 'READY', visibility: 'PUBLIC', mediaLocation: 'PUBLIC', hlsMasterKey: 'hls/master.m3u8', publishedAt: new Date() } });
  const first = await mk('First');
  await ctx.app.get(RedisService).client?.del('fm:cache:home:latest', 'fm:cache:home:spot:');
  expect((await request(ctx.http).get('/api/feed/home').expect(200)).body.spotlight.title).toBe('First');
  await mk('Second');
  const again = (await request(ctx.http).get('/api/feed/home').expect(200)).body;
  expect(again.spotlight.title).toBe('First'); // shared answer, reused
  await ctx.prisma.watchHistory.create({ data: { userId: (await ctx.prisma.user.findUniqueOrThrow({ where: { email: 'maker@example.com' } })).id, videoId: first.id, progressSeconds: 60 } });
  expect((await s.agent.get('/api/feed/home').expect(200)).body.continueWatching.map((c: any) => c.video.id)).toEqual([first.id]);
});

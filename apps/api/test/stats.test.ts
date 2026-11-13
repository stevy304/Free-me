import Redis from 'ioredis';
import request from 'supertest';
import { makeApp, resetDb, signIn, WEB } from './helpers';
import { ViewCounter } from '../src/media/views';

let ctx: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => { ctx = await makeApp(); });
beforeEach(async () => { await resetDb(ctx.prisma); ctx.mail.outbox.length = 0; await ctx.clearLimits(); });
afterAll(async () => { await ctx.app.close(); });

const DAY = 86_400_000;
const day = (ago: number) => new Date(`${new Date(Date.now() - ago * DAY).toISOString().slice(0, 10)}T00:00:00Z`);

test('views are written per day by the counter\'s batches', async () => {
  const c = await signIn(ctx.http, ctx.mail, 'maker@example.com');
  const ch = (await c.agent.post('/api/channels').set('Origin', WEB).send({ handle: 'maker', name: 'Maker' }).expect(201)).body.channel;
  const v = await ctx.prisma.video.create({ data: { channelId: ch.id, title: 'A', durationSeconds: 120, status: 'READY', visibility: 'PUBLIC', mediaLocation: 'PUBLIC', publishedAt: new Date() } });
  const redis = new Redis(process.env.REDIS_URL!);
  const counter = new ViewCounter(ctx.prisma as never, redis);
  await counter.record(v.id, 'a:1', 40);
  await counter.record(v.id, 'a:2', 60);
  await counter.record(v.id, 'a:1', 30); // same viewer: duplicate initial claim is ignored
  await counter.flush();
  const row = await ctx.prisma.videoDailyStat.findUniqueOrThrow({ where: { videoId_day: { videoId: v.id, day: day(0) } } });
  expect(row).toMatchObject({ views: 2, watchSeconds: 100n });
  expect((await ctx.prisma.video.findUniqueOrThrow({ where: { id: v.id } })).viewCount).toBe(2n);
  await redis.quit();
});

test('Creator Hub stats: daily views, watch time and follows, comparison, top videos, retention from signed-in viewers', async () => {
  const c = await signIn(ctx.http, ctx.mail, 'maker@example.com');
  const ch = (await c.agent.post('/api/channels').set('Origin', WEB).send({ handle: 'maker', name: 'Maker' }).expect(201)).body.channel;
  const mk = (title: string) => ctx.prisma.video.create({ data: { channelId: ch.id, title, durationSeconds: 100, status: 'READY', visibility: 'PUBLIC', mediaLocation: 'PUBLIC', publishedAt: new Date(), viewCount: 30n, watchTimeSeconds: 1500n } });
  const a = await mk('Lake'); const b = await mk('Drums');
  await ctx.prisma.videoDailyStat.createMany({ data: [
    { videoId: a.id, day: day(0), views: 5, watchSeconds: 300n },
    { videoId: b.id, day: day(0), views: 2, watchSeconds: 60n },
    { videoId: a.id, day: day(3), views: 10, watchSeconds: 600n },
    { videoId: a.id, day: day(10), views: 99, watchSeconds: 0n }, // outside 7 days, inside the previous 7
  ] });
  for (const e of ['f1', 'f2']) { const f = await signIn(ctx.http, ctx.mail, `${e}@example.com`); await f.agent.post('/api/channels/maker/follow').set('Origin', WEB).expect(200); }

  // Store both follows late on the same UTC day, when a positive database offset would roll them into tomorrow.
  await ctx.prisma.subscription.updateMany({
    where: { channelId: ch.id },
    data: { createdAt: new Date(day(0).getTime() + DAY - 30 * 60_000) },
  });
  await request(ctx.http).get('/api/hub/stats').expect(401);
  await c.agent.get('/api/hub/stats?days=5').expect(400);
  const s = (await c.agent.get('/api/hub/stats?days=7').expect(200)).body;
  expect(s.series).toHaveLength(7);
  expect(s.series.at(-1)).toEqual({ day: day(0).toISOString().slice(0, 10), views: 7, watchSeconds: 360, newFollowers: 2 });
  expect(s.series[3]).toMatchObject({ views: 10, watchSeconds: 600 });
  expect(s.totals).toMatchObject({ views: 17, watchSeconds: 960, newFollowers: 2, followers: 2, previous: { views: 99, watchSeconds: 0, newFollowers: 0 } });
  expect(s.topVideos.map((t: any) => [t.title, t.views, t.averageViewSeconds])).toEqual([['Lake', 15, 60], ['Drums', 2, 30]]);

  // Retention: 5 signed-in viewers got to 10%, 50%, 50%, 90% and the end.
  const users = await Promise.all(['r1', 'r2', 'r3', 'r4', 'r5'].map((n) => ctx.prisma.user.create({ data: { email: `${n}@example.com` } })));
  await ctx.prisma.watchHistory.createMany({ data: [10, 50, 50, 90, 100].map((p, i) => ({ userId: users[i].id, videoId: a.id, progressSeconds: p, completed: p === 100 })) });
  const one = (await c.agent.get(`/api/hub/videos/${a.id}/stats?days=28`).expect(200)).body;
  expect(one.series).toHaveLength(28);
  expect(one.period).toEqual({ views: 114, watchSeconds: 900 });
  expect(one.lifetime).toMatchObject({ views: 30, averageViewSeconds: 50 });
  expect(one.retention.viewers).toBe(5);
  expect(one.retention.points).toHaveLength(21);
  expect(one.retention.points[0]).toEqual({ at: 0, percent: 100 });
  expect(one.retention.points[10]).toEqual({ at: 50, percent: 80 });
  expect(one.retention.points[20]).toEqual({ at: 100, percent: 20 });
  // Too few viewers: no curve. Someone else's video: not found.
  expect((await c.agent.get(`/api/hub/videos/${b.id}/stats`).expect(200)).body.retention).toEqual({ viewers: 0, points: null });
  const other = await signIn(ctx.http, ctx.mail, 'other@example.com');
  await other.agent.post('/api/channels').set('Origin', WEB).send({ handle: 'other', name: 'Other' }).expect(201);
  await other.agent.get(`/api/hub/videos/${a.id}/stats`).expect(404);
});

import Redis from 'ioredis';
import { makeApp, resetDb, signIn, WEB } from './helpers';
import { ViewCounter } from '../src/media/views';
import { ProgressBuffer } from '../src/media/progress';
import { clearHotVideos, forgetHotVideo, hotVideo } from '../src/engagement/hot-video';

// What every playing video sends (views, watch time, resume positions) must not cost a database write per request:
// it is gathered in Redis and written in a few multi-row statements, exactly once even when a worker crashes.
let ctx: Awaited<ReturnType<typeof makeApp>>;
let redis: Redis;
beforeAll(async () => { ctx = await makeApp(); redis = new Redis(process.env.REDIS_URL!); });
beforeEach(async () => { await resetDb(ctx.prisma); ctx.mail.outbox.length = 0; await ctx.clearLimits(); clearHotVideos(); });
afterAll(async () => { await redis.quit(); await ctx.app.close(); });

async function channel(handle = 'maker') {
  const c = await signIn(ctx.http, ctx.mail, `${handle}@example.com`);
  const ch = (await c.agent.post('/api/channels').set('Origin', WEB).send({ handle, name: handle }).expect(201)).body.channel;
  return { c, ch };
}
const video = (channelId: string, title = 'V') => ctx.prisma.video.create({ data: { channelId, title, durationSeconds: 600, status: 'READY', visibility: 'PUBLIC', mediaLocation: 'PUBLIC', publishedAt: new Date(), hlsMasterKey: 'hls/master.m3u8' } });
const users = (n: number) => Promise.all(Array.from({ length: n }, (_, i) => ctx.prisma.user.create({ data: { email: `viewer${i}-${Math.random()}@example.com` } })));

describe('resume positions', () => {
  test('saves stay in Redis until the flush, which writes thousands of them in a few statements', async () => {
    const { ch } = await channel();
    const [a, b] = [await video(ch.id, 'A'), await video(ch.id, 'B')];
    const viewers = await users(2600);
    const buf = new ProgressBuffer(ctx.prisma as never, redis);
    for (const [i, u] of viewers.entries()) await buf.save(u.id, i % 2 ? a.id : b.id, 10 + (i % 50), false);
    await buf.save(viewers[0].id, b.id, 333, false); // the latest save of a viewer wins
    expect(await ctx.prisma.watchHistory.count()).toBe(0);
    expect(await buf.pending(viewers[0].id, b.id)).toMatchObject({ seconds: 333, completed: false });
    expect(await buf.flush()).toBe(2600); // more than one statement's worth (2,000 rows)
    expect(await ctx.prisma.watchHistory.count()).toBe(2600);
    expect((await ctx.prisma.watchHistory.findUniqueOrThrow({ where: { userId_videoId: { userId: viewers[0].id, videoId: b.id } } })).progressSeconds).toBe(333);
    expect(await buf.flush()).toBe(0);
  }, 60_000);

  test('an older save never replaces a newer one; deleted videos and accounts are skipped', async () => {
    const { ch } = await channel();
    const v = await video(ch.id); const gone = await video(ch.id, 'Gone');
    const [u] = await users(1);
    const buf = new ProgressBuffer(ctx.prisma as never, redis);
    await ctx.prisma.watchHistory.create({ data: { userId: u.id, videoId: v.id, progressSeconds: 500, lastWatchedAt: new Date(Date.now() + 60_000) } });
    await buf.save(u.id, v.id, 20, false);
    await buf.save(u.id, gone.id, 40, false);
    await ctx.prisma.video.delete({ where: { id: gone.id } });
    await buf.flush();
    expect((await ctx.prisma.watchHistory.findMany({ where: { userId: u.id } })).map((h) => [h.videoId, h.progressSeconds])).toEqual([[v.id, 500]]);
  });

  test('a batch a worker claimed and never finished is written by the next flush', async () => {
    const { ch } = await channel();
    const v = await video(ch.id);
    const [u] = await users(1);
    const old = Date.now() - 5 * 60_000;
    await redis.hset(`fm:progress:pending:flushing:${old}:x`, `${u.id}|${v.id}`, `77|0|${old}`);
    await new ProgressBuffer(ctx.prisma as never, redis).flush();
    expect((await ctx.prisma.watchHistory.findFirstOrThrow({ where: { userId: u.id } })).progressSeconds).toBe(77);
    expect(await redis.keys('fm:progress:pending:flushing:*')).toEqual([]);
  });

  test('through the API: resume and history see a position before it is written; removing it keeps it removed', async () => {
    const { ch } = await channel();
    const v = await video(ch.id, 'Sunrise');
    const fan = await signIn(ctx.http, ctx.mail, 'fan@example.com');
    await fan.agent.post(`/api/videos/${v.id}/progress`).set('Origin', WEB).send({ seconds: 184 }).expect(200);
    expect(await ctx.prisma.watchHistory.count()).toBe(0);
    expect((await fan.agent.get(`/api/videos/${v.id}`).expect(200)).body.viewer.resumeAt).toBe(184);
    expect((await fan.agent.get('/api/me/history').expect(200)).body.items.map((i: any) => [i.video.id, i.progressSeconds])).toEqual([[v.id, 184]]);
    expect((await fan.agent.delete(`/api/me/history/${v.id}`).set('Origin', WEB).expect(200)).body.removed).toBe(1);
    // A worker that had already claimed the save (before the removal) must not bring it back.
    const fanId = (await ctx.prisma.user.findUniqueOrThrow({ where: { email: 'fan@example.com' } })).id;
    await redis.hset(`fm:progress:pending:flushing:${Date.now() - 5 * 60_000}:y`, `${fanId}|${v.id}`, `184|0|${Date.now() - 1000}`);
    await new ProgressBuffer(ctx.prisma as never, redis).flush();
    expect(await ctx.prisma.watchHistory.count()).toBe(0);
    expect((await fan.agent.get('/api/me/history').expect(200)).body.items).toEqual([]);
    // Watching again later is saved as usual.
    await fan.agent.post(`/api/videos/${v.id}/progress`).set('Origin', WEB).send({ seconds: 30 }).expect(200);
    await new ProgressBuffer(ctx.prisma as never, redis).flush();
    expect(await ctx.prisma.watchHistory.count()).toBe(1);
  });
});

describe('view counts', () => {
  test('hundreds of videos are written in one transaction, with per-day rows and Space totals', async () => {
    const { ch } = await channel();
    const { ch: other } = await channel('other');
    const vids = await Promise.all(Array.from({ length: 300 }, (_, i) => video(i % 3 ? ch.id : other.id, `V${i}`)));
    const counter = new ViewCounter(ctx.prisma as never, redis);
    for (const [i, v] of vids.entries()) for (let k = 0; k <= i % 3; k++) await counter.record(v.id, `viewer-${k}`, 40);
    expect(await counter.flush()).toBe(300);
    const expected = vids.reduce((sum, _, i) => sum + (i % 3) + 1, 0);
    const total = await ctx.prisma.video.aggregate({ _sum: { viewCount: true, watchTimeSeconds: true } });
    expect(total._sum.viewCount).toBe(BigInt(expected));
    expect(total._sum.watchTimeSeconds).toBe(BigInt(expected * 40));
    const spaces = await ctx.prisma.channel.findMany({ select: { id: true, totalViews: true } });
    const by = (id: string) => vids.reduce((s, v, i) => s + (v.channelId === id ? (i % 3) + 1 : 0), 0);
    for (const s of spaces) expect(s.totalViews).toBe(BigInt(by(s.id)));
    expect(await ctx.prisma.videoDailyStat.aggregate({ _sum: { views: true } })).toMatchObject({ _sum: { views: expected } });
  }, 60_000);

  test('after a crash: an unfinished batch is written once, and a batch already written is never added again', async () => {
    const { ch } = await channel();
    const v = await video(ch.id);
    const day = new Date().toISOString().slice(0, 10);
    const old = `${Date.now() - 5 * 60_000}-abc`;
    // Claimed, not written: picked up.
    await redis.hset(`fm:views:pending:flushing:${old}`, `${v.id}|${day}`, 3);
    await redis.hset(`fm:watch:pending:flushing:${old}`, `${v.id}|${day}`, 90);
    // Written, but the worker stopped before removing it: only removed.
    const done = `${Date.now() - 5 * 60_000}-def`;
    await redis.hset(`fm:views:pending:flushing:${done}`, `${v.id}|${day}`, 50);
    await ctx.prisma.counterFlush.create({ data: { stamp: done } });
    // Claimed a moment ago by another worker that is still writing it: left alone.
    const busy = `${Date.now()}-ghi`;
    await redis.hset(`fm:views:pending:flushing:${busy}`, `${v.id}|${day}`, 7);
    const counter = new ViewCounter(ctx.prisma as never, redis);
    await counter.flush();
    expect(await ctx.prisma.video.findUniqueOrThrow({ where: { id: v.id } })).toMatchObject({ viewCount: 3n, watchTimeSeconds: 90n });
    expect(await redis.keys('fm:views:pending:flushing:*')).toEqual([`fm:views:pending:flushing:${busy}`]);
    await counter.flush();
    expect((await ctx.prisma.video.findUniqueOrThrow({ where: { id: v.id } })).viewCount).toBe(3n);
    await redis.del(`fm:views:pending:flushing:${busy}`);
  });
});

describe('hot video lookups', () => {
  test('concurrent lookups of one video share one query; it is asked again after a few seconds or when forgotten', async () => {
    let queries = 0;
    const row = { id: 'v1', status: 'READY', visibility: 'PUBLIC', takenDownAt: null, reviewHoldAt: null, hlsMasterKey: 'hls/master.m3u8', durationSeconds: 60, channel: { userId: 'u1' } };
    const prisma = { video: { findUnique: async () => { queries++; await new Promise((r) => setTimeout(r, 20)); return row; } } } as never;
    const now = Date.now();
    const all = await Promise.all(Array.from({ length: 500 }, () => hotVideo(prisma, 'v1', now)));
    expect(queries).toBe(1);
    expect(all[0]).toMatchObject({ id: 'v1', ownerId: 'u1', durationSeconds: 60 });
    await hotVideo(prisma, 'v1', now + 5_000);
    expect(queries).toBe(1);
    await hotVideo(prisma, 'v1', now + 11_000);
    expect(queries).toBe(2);
    forgetHotVideo('v1');
    await hotVideo(prisma, 'v1', now + 11_500);
    expect(queries).toBe(3);
  });

  test('made private through Creator Hub: counting stops at once on this server', async () => {
    const { c, ch } = await channel();
    const v = await video(ch.id);
    const fan = await signIn(ctx.http, ctx.mail, 'fan2@example.com');
    await fan.agent.post(`/api/videos/${v.id}/progress`).set('Origin', WEB).send({ seconds: 40 }).expect(200);
    await c.agent.patch(`/api/hub/videos/${v.id}`).set('Origin', WEB).send({ visibility: 'PRIVATE' }).expect(200);
    await fan.agent.post(`/api/videos/${v.id}/progress`).set('Origin', WEB).send({ seconds: 50 }).expect(404);
  });
});

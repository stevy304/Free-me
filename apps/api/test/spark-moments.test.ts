import request from 'supertest';
import { makeApp, resetDb, signIn, WEB } from './helpers';

// The most Sparked moments (the gold marks on the progress bar): where in the video each Spark was given.
let ctx: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => { ctx = await makeApp(); });
beforeEach(async () => { await resetDb(ctx.prisma); ctx.mail.outbox.length = 0; await ctx.clearLimits(); });
afterAll(async () => { await ctx.app.close(); });

test('a Spark keeps its moment; moments Sparked by at least 2 people are returned, at most 3, in order', async () => {
  const u = await ctx.prisma.user.create({ data: { email: 'maker@example.com' } });
  const ch = await ctx.prisma.channel.create({ data: { userId: u.id, handle: 'maker', name: 'Maker' } });
  const v = await ctx.prisma.video.create({ data: { channelId: ch.id, title: 'Final', durationSeconds: 400, status: 'READY', visibility: 'PUBLIC', mediaLocation: 'PUBLIC', publishedAt: new Date(), safetyCheckedAt: new Date(), hlsMasterKey: 'hls/master.m3u8' } });
  // Spans of 400 / 40 = 10 s: moments around 0:15 (3 people), 2:05 (2), 5:45 (2), 3:00 (1, not enough).
  const at = [12, 14, 17, 121, 125, 341, 348, 180];
  for (const [i, s] of at.entries()) {
    const fan = await signIn(ctx.http, ctx.mail, `fan${i}@example.com`);
    await fan.agent.put(`/api/videos/${v.id}/reaction`).set('Origin', WEB).send({ value: 'like', at: s + 0.6 }).expect(200);
  }
  expect((await ctx.prisma.like.findMany({ where: { videoId: v.id }, orderBy: { atSeconds: 'asc' } })).map((l) => l.atSeconds)).toEqual([12, 14, 17, 121, 125, 180, 341, 348]);
  const r = await request(ctx.http).get(`/api/videos/${v.id}/sparked-moments`).expect(200);
  expect(r.headers['cache-control']).toBe('public, max-age=300');
  expect(r.body.moments).toEqual([{ at: 15, sparks: 3 }, { at: 125, sparks: 2 }, { at: 345, sparks: 2 }]);
  // A dislike never marks a moment; a Spark without a moment (an older app) still counts as a Spark.
  const other = await signIn(ctx.http, ctx.mail, 'grump@example.com');
  await other.agent.put(`/api/videos/${v.id}/reaction`).set('Origin', WEB).send({ value: 'dislike', at: 180 }).expect(200);
  const plain = await signIn(ctx.http, ctx.mail, 'plain@example.com');
  expect((await plain.agent.put(`/api/videos/${v.id}/reaction`).set('Origin', WEB).send({ value: 'like' }).expect(200)).body.likeCount).toBe(9);
  expect((await request(ctx.http).get(`/api/videos/${v.id}/sparked-moments`).expect(200)).body.moments).toHaveLength(3);
});

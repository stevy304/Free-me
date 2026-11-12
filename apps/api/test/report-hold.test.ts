import request from 'supertest';
import { makeApp, resetDb, signIn, WEB } from './helpers';

// Many reports hide a video until a moderator decides; new accounts cannot do it; child safety needs only two.
let ctx: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => { ctx = await makeApp({ adminEmails: ['mod@example.com'] }); });
beforeEach(async () => { await resetDb(ctx.prisma); ctx.mail.outbox.length = 0; await ctx.clearLimits(); });
afterAll(async () => { await ctx.app.close(); });

async function setup() {
  const maker = await signIn(ctx.http, ctx.mail, 'maker@example.com');
  const ch = (await maker.agent.post('/api/channels').set('Origin', WEB).send({ handle: 'maker', name: 'Maker' }).expect(201)).body.channel;
  const video = await ctx.prisma.video.create({ data: { channelId: ch.id, title: 'Reported', durationSeconds: 60, status: 'READY', visibility: 'PUBLIC', mediaLocation: 'PUBLIC', hlsMasterKey: 'hls/master.m3u8', publishedAt: new Date() } });
  return { maker, video };
}
async function reporter(n: string, established = true) {
  const r = await signIn(ctx.http, ctx.mail, `${n}@example.com`);
  if (established) await ctx.prisma.user.update({ where: { email: `${n}@example.com` }, data: { createdAt: new Date(Date.now() - 3 * 86_400_000) } });
  return r.agent;
}
const report = (agent: any, id: string, reason = 'SPAM_OR_SCAM') => agent.post(`/api/videos/${id}/reports`).set('Origin', WEB).send({ reason }).expect(201);
const inFeed = async (id: string) => (await request(ctx.http).get('/api/videos').expect(200)).body.videos.some((v: any) => v.id === id);

test('five reports from established accounts hide the video until a moderator keeps it; new accounts do not count', async () => {
  const { maker, video } = await setup();
  for (const n of ['new1', 'new2', 'new3', 'new4', 'new5']) await report(await reporter(n, false), video.id);
  for (const n of ['r1', 'r2', 'r3', 'r4']) await report(await reporter(n), video.id);
  expect(await inFeed(video.id)).toBe(true); // 4 established reporters: not yet
  await report(await reporter('r5'), video.id);
  expect(await inFeed(video.id)).toBe(false);
  expect((await request(ctx.http).get(`/api/videos/${video.id}`).expect(404)).body.message).toBe('This video is being reviewed by our moderators.');
  await maker.agent.get(`/api/videos/${video.id}`).expect(200); // the owner still sees it
  expect(await ctx.prisma.auditLog.count({ where: { action: 'VIDEO_HELD_BY_REPORTS', entityId: video.id } })).toBe(1);

  const mod = (await signIn(ctx.http, ctx.mail, 'mod@example.com')).agent;
  const queue = (await mod.get('/api/moderation/reports').expect(200)).body.reports;
  expect(queue[0].video).toMatchObject({ id: video.id, heldForReviewAt: expect.any(String) });
  await mod.post(`/api/moderation/reports/${queue[0].id}/decision`).set('Origin', WEB).send({ action: 'dismiss', notes: 'Not spam.' }).expect(200);
  expect(await inFeed(video.id)).toBe(true);
  await request(ctx.http).get(`/api/videos/${video.id}`).expect(200);
});

test('two child-safety reports are enough', async () => {
  const { video } = await setup();
  await report(await reporter('c1'), video.id, 'CHILD_SAFETY');
  expect(await inFeed(video.id)).toBe(true);
  await report(await reporter('c2'), video.id, 'CHILD_SAFETY');
  expect(await inFeed(video.id)).toBe(false);
  await request(ctx.http).get(`/api/videos/${video.id}/hls/master.m3u8`).expect(404);
});

import request from 'supertest';
import { makeApp, resetDb, signIn, WEB } from './helpers';

let ctx: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => { ctx = await makeApp({ redis: false, adminEmails: ['health-admin@example.com'] }); });
beforeEach(async () => { await resetDb(ctx.prisma); ctx.mail.outbox.length = 0; await ctx.clearLimits(); });
afterAll(async () => { await ctx.app.close(); });

test('accepts valid accessible-video samples and restricts diagnostics to administrators', async () => {
  const creator = await signIn(ctx.http, ctx.mail, 'health-creator@example.com');
  const channel = (await creator.agent.post('/api/channels').set('Origin', WEB).send({ handle: 'health', name: 'Health' }).expect(201)).body.channel;
  const video = await ctx.prisma.video.create({ data: { channelId: channel.id, title: 'Sample', status: 'READY', visibility: 'PUBLIC', durationSeconds: 60 } });
  await request(ctx.http).post(`/api/videos/${video.id}/playback-health`).set('Origin', WEB).send({ kind: 'startup', durationMs: 1250 }).expect(200);
  await request(ctx.http).post(`/api/videos/${video.id}/playback-health`).set('Origin', WEB).send({ kind: 'invalid', durationMs: -1 }).expect(400);
  await request(ctx.http).get('/api/admin/playback-health').expect(401);
  await creator.agent.get('/api/admin/playback-health').expect(403);
  const admin = await signIn(ctx.http, ctx.mail, 'health-admin@example.com');
  const data = (await admin.agent.get('/api/admin/playback-health').expect(200)).body;
  expect(data.metrics[0]).toEqual({ kind: 'startup', count: 1, medianMs: 1250, p95Ms: 1250 });
  await ctx.prisma.video.update({ where: { id: video.id }, data: { visibility: 'PRIVATE' } });
  await request(ctx.http).post(`/api/videos/${video.id}/playback-health`).set('Origin', WEB).send({ kind: 'buffer', durationMs: 100 }).expect(404);
});

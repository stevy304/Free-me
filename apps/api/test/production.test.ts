import express from 'express';
import request from 'supertest';
import { makeApp, resetDb, signIn, WEB } from './helpers';
import { requestLog } from '../src/common/request-log';

let ctx: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => { ctx = await makeApp({ adminEmails: ['boss@example.com'] }); });
beforeEach(async () => { await resetDb(ctx.prisma); ctx.mail.outbox.length = 0; await ctx.clearLimits(); });
afterAll(async () => { await ctx.app.close(); });

test('every answer carries a request id: the edge\'s when it looks valid, a new one otherwise', async () => {
  const own = await request(ctx.http).get('/api/categories').expect(200);
  expect(own.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  expect((await request(ctx.http).get('/api/categories').set('X-Request-Id', 'edge-1234-abcd')).headers['x-request-id']).toBe('edge-1234-abcd');
  expect((await request(ctx.http).get('/api/categories').set('X-Request-Id', '<script>')).headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
});

test('JSON request log: one line per request with id, status and time; health checks are not logged', async () => {
  const lines: string[] = [];
  const app = express();
  app.use(requestLog({ json: true, write: (l) => lines.push(l) }));
  app.get('/api/health', (_q, r) => { r.send('ok'); });
  app.get('/api/thing', (_q, r) => { r.status(404).json({}); });
  await request(app).get('/api/health').expect(200);
  const res = await request(app).get('/api/thing?secret=1').expect(404);
  expect(lines).toHaveLength(1);
  const line = JSON.parse(lines[0]);
  expect(line).toMatchObject({ level: 'warn', msg: 'request', method: 'GET', path: '/api/thing', status: 404, requestId: res.headers['x-request-id'] });
  expect(typeof line.ms).toBe('number');
  expect(lines[0]).not.toContain('secret');
});

test('system status: administrators only; reports services, processing, videos, storage and accounts', async () => {
  const viewer = await signIn(ctx.http, ctx.mail, 'viewer@example.com');
  await viewer.agent.get('/api/admin/system').expect(403);
  await request(ctx.http).get('/api/admin/system').expect(401);
  const admin = await signIn(ctx.http, ctx.mail, 'boss@example.com');
  const s = (await admin.agent.get('/api/admin/system').expect(200)).body;
  expect(s.services).toMatchObject({ database: 'ok', storage: 'local', email: 'memory', googleSignIn: false });
  expect(s.accounts).toMatchObject({ users: 2, newLast24h: 2, spaces: 0 });
  expect(s.processing).toMatchObject({ stuckOver2h: 0, failedLast24h: 0 });
  expect(s.storage).toEqual({ sourceBytes: '0', mediaBytes: '0' });
  expect(s.warnings).toContain('Google sign-in is not configured.');
  expect(s.ok).toBe(false);
});

test('sitemap lists public videos and Spaces only; older videos can be re-processed in batches by administrators', async () => {
  const c = await signIn(ctx.http, ctx.mail, 'maker@example.com');
  const ch = (await c.agent.post('/api/channels').set('Origin', WEB).send({ handle: 'maker', name: 'Maker' }).expect(201)).body.channel;
  const base = { channelId: ch.id, durationSeconds: 60, status: 'READY' as const, mediaLocation: 'PUBLIC' as const, publishedAt: new Date(), hlsMasterKey: 'hls/master.m3u8', sourceFileS3Key: 'src/x/source.mp4' };
  const pub = await ctx.prisma.video.create({ data: { ...base, title: 'Public', visibility: 'PUBLIC' } });
  await ctx.prisma.video.create({ data: { ...base, title: 'Unlisted', visibility: 'UNLISTED' } });
  await ctx.prisma.video.create({ data: { ...base, title: 'Upgraded', visibility: 'PUBLIC', storyboard: { key: 'thumbs/storyboard.jpg' } } });
  const map = (await request(ctx.http).get('/api/site/sitemap').expect(200)).body;
  expect(map.videos.map((v: any) => v.id)).toContain(pub.id);
  expect(map.videos).toHaveLength(2);
  expect(map.channels).toEqual([expect.objectContaining({ handle: 'maker' })]);

  await c.agent.post('/api/admin/system/reprocess').set('Origin', WEB).send({}).expect(403);
  const admin = await signIn(ctx.http, ctx.mail, 'boss@example.com');
  expect((await admin.agent.get('/api/admin/system')).body.processing.videosNeedingUpgrade).toBe(2);
  expect((await admin.agent.post('/api/admin/system/reprocess').set('Origin', WEB).send({ dryRun: true }).expect(200)).body).toEqual({ queued: 0, wouldQueue: 2, remaining: 2 });
  await admin.agent.post('/api/admin/system/reprocess').set('Origin', WEB).send({ limit: 0 }).expect(400);
});

test('repair media: administrators only; reports videos whose files are in the wrong place', async () => {
  const c = await signIn(ctx.http, ctx.mail, 'maker@example.com');
  const ch = (await c.agent.post('/api/channels').set('Origin', WEB).send({ handle: 'maker', name: 'Maker' }).expect(201)).body.channel;
  await ctx.prisma.video.create({ data: { channelId: ch.id, title: 'Lost', durationSeconds: 5, status: 'READY', visibility: 'PUBLIC', mediaLocation: 'PUBLIC', publishedAt: new Date(), hlsMasterKey: 'hls/master.m3u8', thumbnailKey: 'thumbs/2.jpg' } });
  await c.agent.post('/api/admin/system/repair-media').set('Origin', WEB).send({}).expect(403);
  const admin = await signIn(ctx.http, ctx.mail, 'boss@example.com');
  const r = (await admin.agent.post('/api/admin/system/repair-media').set('Origin', WEB).send({}).expect(200)).body;
  expect(r).toMatchObject({ checked: 1, needingRepair: 1, applied: false, busy: 0 });
  expect(r.videos[0]).toMatchObject({ title: 'Lost', missing: ['hls/master.m3u8', 'thumbs/2.jpg'], leftovers: 0, repaired: false });
});

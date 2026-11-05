import express from 'express';
import request from 'supertest';
import { makeApp, resetDb, signIn } from './helpers';
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

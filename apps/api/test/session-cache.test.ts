import Redis from 'ioredis';
import { makeApp, resetDb, signIn, WEB } from './helpers';
import { SessionCache, authChanged } from '../src/auth/session-cache';
import { Billing } from '../src/billing/billing';

// Each API process keeps signed-in sessions for a few seconds (no database read per request), and forgets an
// account the moment it changes or signs out, on every process.
let ctx: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => { ctx = await makeApp({ env: { SESSION_CACHE_SECONDS: '15' } }); });
beforeEach(async () => { await resetDb(ctx.prisma); ctx.mail.outbox.length = 0; await ctx.clearLimits(); });
afterAll(async () => { await ctx.app.close(); });

test('a cached session is used without the database; changes made through the app are seen at once', async () => {
  const c = await signIn(ctx.http, ctx.mail, 'boss@example.com');
  const id = (await ctx.prisma.user.findUniqueOrThrow({ where: { email: 'boss@example.com' } })).id;
  await c.agent.get('/api/admin/playback-health').expect(403);
  // Changed behind the app's back: this process still uses what it read (that is the point of the cache)…
  await ctx.prisma.user.update({ where: { id }, data: { roles: { set: ['VIEWER', 'ADMIN'] } } });
  await c.agent.get('/api/admin/playback-health').expect(403);
  // …and an announced change is seen immediately.
  authChanged(id);
  await c.agent.get('/api/admin/playback-health').expect(200);
});

test('signing out and suspension take effect on the next request', async () => {
  const admin = await signIn(ctx.http, ctx.mail, 'admin@example.com');
  await ctx.prisma.user.update({ where: { email: 'admin@example.com' }, data: { roles: { set: ['VIEWER', 'ADMIN'] } } });
  authChanged((await ctx.prisma.user.findUniqueOrThrow({ where: { email: 'admin@example.com' } })).id);
  const fan = await signIn(ctx.http, ctx.mail, 'fan@example.com');
  await fan.agent.get('/api/me').expect(200);
  const fanId = (await ctx.prisma.user.findUniqueOrThrow({ where: { email: 'fan@example.com' } })).id;
  await admin.agent.patch(`/api/admin/users/${fanId}/status`).set('Origin', WEB).send({ status: 'SUSPENDED' }).expect(200);
  await fan.agent.get('/api/me').expect(401);

  const other = await signIn(ctx.http, ctx.mail, 'other@example.com');
  await other.agent.get('/api/me').expect(200);
  await other.agent.post('/api/auth/logout').set('Origin', WEB).expect((r) => { if (r.status >= 300) throw new Error(String(r.status)); });
  await other.agent.get('/api/me').expect(401);
});

test('a plan bought or granted is seen on the next request', async () => {
  const c = await signIn(ctx.http, ctx.mail, 'pro@example.com');
  const id = (await ctx.prisma.user.findUniqueOrThrow({ where: { email: 'pro@example.com' } })).id;
  expect((await c.agent.get('/api/billing/plans').expect(200)).status).toBe(200);
  await c.agent.get('/api/me').expect(200);
  await new Billing(ctx.prisma as never, ctx.config).grantPremium(id, 1);
  const me = (await c.agent.get('/api/me').expect(200)).body;
  expect(JSON.stringify(me)).toMatch(/premium/i);
});

test('every process forgets an account when any process announces a change', async () => {
  const user = { id: 'u-1' } as never;
  const ctxFor = (expiresIn: number) => ({ user, session: { id: 's', expiresAt: new Date(Date.now() + expiresIn) } }) as never;
  const ra = new Redis(process.env.REDIS_URL!); const rb = new Redis(process.env.REDIS_URL!);
  const a = new SessionCache(15_000, ra);
  const b = new SessionCache(15_000, rb);
  await new Promise((r) => setTimeout(r, 200)); // subscriptions ready
  a.set('t1', ctxFor(60_000)); b.set('t1', ctxFor(60_000)); b.set('t2', ctxFor(60_000));
  expect(a.get('t1')).not.toBeNull();
  // Another process (here: a publisher only) announces it.
  const pub = new Redis(process.env.REDIS_URL!);
  await pub.publish('fm:auth:changed', 'u-1');
  for (let i = 0; i < 50 && (a.get('t1') || b.get('t2')); i++) await new Promise((r) => setTimeout(r, 20));
  expect([a.get('t1'), b.get('t1'), b.get('t2')]).toEqual([null, null, null]);
  // Entries also expire on their own.
  a.set('t3', ctxFor(60_000), Date.now() - 16_000);
  expect(a.get('t3')).toBeNull();
  await Promise.all([a.close(), b.close(), pub.quit(), ra.quit(), rb.quit()]);
});

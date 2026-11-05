import request from 'supertest';
import { makeApp, resetDb, signIn, WEB, FakeGoogle } from './helpers';

let ctx: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => { ctx = await makeApp({ adminEmails: ['root@example.com'] }); });
beforeEach(async () => { await resetDb(ctx.prisma); ctx.mail.outbox.length = 0; await ctx.clearLimits(); });
afterAll(async () => { await ctx.app.close(); });

const lastCode = (email: string) => /(\d{6})/.exec([...ctx.mail.outbox].reverse().find((m) => m.to === email)!.subject)![1];

describe('email code sign-in', () => {
  test('first sign-in creates the account, sets a secure session cookie and reads the language from the browser', async () => {
    const agent = request.agent(ctx.http);
    await agent.post('/api/auth/email/request').set('Origin', WEB).send({ email: ' Aline@Example.com ' }).expect(200, { sent: true, email: 'aline@example.com' });
    const code = lastCode('aline@example.com');
    const stored = await ctx.prisma.emailOtp.findFirstOrThrow({ where: { email: 'aline@example.com' } });
    expect(stored.codeHash).not.toContain(code);
    const res = await agent.post('/api/auth/email/verify').set('Origin', WEB).set('Accept-Language', 'fr-FR,fr;q=0.9,en;q=0.8').send({ email: 'aline@example.com', code }).expect(200);
    expect(res.body).toEqual({ signedIn: true, newAccount: true });
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/fm_session=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    const me = await agent.get('/api/me').expect(200);
    expect(me.body.user).toMatchObject({ email: 'aline@example.com', roles: ['VIEWER'], status: 'ACTIVE' });
    expect(me.body.profile).toMatchObject({ displayName: 'aline', preferredLanguage: 'fr', country: null });
    expect(me.body.channel).toBeNull();
    // Same address again (after the one-code-a-minute limit): same account, not a new one.
    await ctx.clearLimits();
    const again = await signIn(ctx.http, ctx.mail, 'aline@example.com');
    expect(again.res.body.newAccount).toBe(false);
    expect(await ctx.prisma.user.count()).toBe(1);
  });

  test('a code works once, wrong codes count down, and five wrong codes end it', async () => {
    const agent = request.agent(ctx.http);
    await agent.post('/api/auth/email/request').set('Origin', WEB).send({ email: 'eric@example.com' }).expect(200);
    const code = lastCode('eric@example.com');
    const wrong = code === '000000' ? '111111' : '000000';
    const r1 = await agent.post('/api/auth/email/verify').set('Origin', WEB).send({ email: 'eric@example.com', code: wrong }).expect(400);
    expect(r1.body.message).toMatch(/4 tries left/);
    for (let i = 0; i < 3; i++) await agent.post('/api/auth/email/verify').set('Origin', WEB).send({ email: 'eric@example.com', code: wrong }).expect(400);
    const r5 = await agent.post('/api/auth/email/verify').set('Origin', WEB).send({ email: 'eric@example.com', code: wrong }).expect(400);
    expect(r5.body.message).toMatch(/Too many wrong codes/);
    const late = await agent.post('/api/auth/email/verify').set('Origin', WEB).send({ email: 'eric@example.com', code }).expect(400);
    expect(late.body.message).toMatch(/expired or was already used/);
    expect(await ctx.prisma.user.count()).toBe(0);
  });

  test('used and expired codes are refused; a new request is rate limited for a minute', async () => {
    const { code } = await signIn(ctx.http, ctx.mail, 'keza@example.com');
    await request(ctx.http).post('/api/auth/email/verify').set('Origin', WEB).send({ email: 'keza@example.com', code }).expect(400);
    const limited = await request(ctx.http).post('/api/auth/email/request').set('Origin', WEB).send({ email: 'keza@example.com' }).expect(429);
    expect(limited.body.retryAfterSeconds).toBeGreaterThan(0);
    await request(ctx.http).post('/api/auth/email/request').set('Origin', WEB).send({ email: 'old@example.com' }).expect(200);
    await ctx.prisma.emailOtp.updateMany({ where: { email: 'old@example.com' }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await request(ctx.http).post('/api/auth/email/verify').set('Origin', WEB).send({ email: 'old@example.com', code: lastCode('old@example.com') }).expect(400);
  });

  test('bad input is refused clearly', async () => {
    await request(ctx.http).post('/api/auth/email/request').set('Origin', WEB).send({ email: 'not-an-email' }).expect(400);
    await request(ctx.http).post('/api/auth/email/request').set('Origin', WEB).send({ email: 'a@b.co', extra: 1 }).expect(400);
    await request(ctx.http).post('/api/auth/email/verify').set('Origin', WEB).send({ email: 'a@b.co', code: '12ab56' }).expect(400);
  });
});

describe('sessions and security', () => {
  test('requests that change things must come from the web app (CSRF)', async () => {
    await request(ctx.http).post('/api/auth/email/request').send({ email: 'x@example.com' }).expect(403);
    await request(ctx.http).post('/api/auth/email/request').set('Origin', 'https://evil.example').send({ email: 'x@example.com' }).expect(403);
    await request(ctx.http).post('/api/auth/email/request').set('Referer', `${WEB}/login`).send({ email: 'x@example.com' }).expect(200);
  });

  test('sign out ends the session on the server; other devices can be signed out', async () => {
    const a = await signIn(ctx.http, ctx.mail, 'multi@example.com');
    await ctx.clearLimits();
    const b = await signIn(ctx.http, ctx.mail, 'multi@example.com');
    const sessions = await a.agent.get('/api/me/sessions').expect(200);
    expect(sessions.body.sessions).toHaveLength(2);
    expect(sessions.body.sessions.filter((s: any) => s.current)).toHaveLength(1);
    await a.agent.delete('/api/me/sessions').set('Origin', WEB).expect(200, { revoked: 1 });
    await b.agent.get('/api/me').expect(401);
    await a.agent.get('/api/me').expect(200);
    await a.agent.post('/api/auth/logout').set('Origin', WEB).expect(200);
    await a.agent.get('/api/me').expect(401);
    expect(await ctx.prisma.session.count({ where: { revokedAt: null } })).toBe(0);
  });

  test('anonymous requests to private routes get 401', async () => {
    await request(ctx.http).get('/api/me').expect(401);
    await request(ctx.http).get('/api/me/sessions').expect(401);
    await request(ctx.http).get('/api/feed/subscriptions').expect(401);
  });

  test('health reports the database', async () => {
    const r = await request(ctx.http).get('/api/health').expect(200);
    expect(r.body).toMatchObject({ status: 'ok', database: 'ok' });
  });
});

describe('administrators and roles', () => {
  test('ADMIN_EMAILS makes an administrator; others are refused; changes are audited; suspension signs out', async () => {
    const admin = await signIn(ctx.http, ctx.mail, 'root@example.com');
    const viewer = await signIn(ctx.http, ctx.mail, 'viewer@example.com');
    expect((await admin.agent.get('/api/me')).body.user.roles).toEqual(['VIEWER', 'ADMIN']);
    await viewer.agent.get('/api/admin/users').expect(403);
    await request(ctx.http).get('/api/admin/users').expect(401);

    const list = await admin.agent.get('/api/admin/users?q=viewer').expect(200);
    const target = list.body.users[0];
    expect(target.email).toBe('viewer@example.com');
    const roles = await admin.agent.patch(`/api/admin/users/${target.id}/roles`).set('Origin', WEB).send({ roles: ['MODERATOR'] }).expect(200);
    expect(roles.body.roles.sort()).toEqual(['MODERATOR', 'VIEWER']);
    await admin.agent.patch(`/api/admin/users/${target.id}/roles`).set('Origin', WEB).send({ roles: ['SUPERUSER'] }).expect(400);
    const me = (await admin.agent.get('/api/me')).body.user.id;
    await admin.agent.patch(`/api/admin/users/${me}/roles`).set('Origin', WEB).send({ roles: [] }).expect(400);

    await admin.agent.patch(`/api/admin/users/${target.id}/status`).set('Origin', WEB).send({ status: 'SUSPENDED' }).expect(200);
    await viewer.agent.get('/api/me').expect(401);
    await request(ctx.http).post('/api/auth/email/request').set('Origin', WEB).send({ email: 'viewer2@example.com' }).expect(200);
    const audit = await admin.agent.get('/api/admin/audit').expect(200);
    const actions = audit.body.entries.map((e: any) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['ROLES_CHANGED', 'ACCOUNT_SUSPENDED', 'ADMIN_GRANTED_BY_CONFIG', 'SIGN_IN', 'ACCOUNT_CREATED']));
  });

  test('a suspended account cannot sign in again', async () => {
    await signIn(ctx.http, ctx.mail, 'gone@example.com');
    await ctx.prisma.user.update({ where: { email: 'gone@example.com' }, data: { status: 'SUSPENDED' } });
    await ctx.prisma.emailOtp.deleteMany({});
    const agent = request.agent(ctx.http);
    await agent.post('/api/auth/email/request').set('Origin', WEB).send({ email: 'gone2@example.com' }).expect(200);
    await ctx.prisma.user.create({ data: { email: 'blocked@example.com', status: 'SUSPENDED' } });
    await agent.post('/api/auth/email/request').set('Origin', WEB).send({ email: 'blocked@example.com' }).expect(200);
    await agent.post('/api/auth/email/verify').set('Origin', WEB).send({ email: 'blocked@example.com', code: lastCode('blocked@example.com') }).expect(403);
  });
});

describe('Google sign-in', () => {
  let g: Awaited<ReturnType<typeof makeApp>>;
  let google: FakeGoogle;
  beforeAll(async () => { google = new FakeGoogle(); g = await makeApp({ google }); });
  afterAll(async () => { await g.app.close(); });
  beforeEach(async () => { await resetDb(g.prisma); await g.clearLimits(); google.nonceOverride = null; google.profile = { sub: 'google-sub-1', email: 'aline@example.com', emailVerified: true, name: 'Aline Uwase', picture: 'https://lh3.googleusercontent.com/a/test' }; });

  async function startAndReturn(agent: ReturnType<typeof request.agent>, returnTo = '/') {
    const start = await agent.get(`/api/auth/google?returnTo=${encodeURIComponent(returnTo)}`).expect(303);
    expect(start.headers.location).toMatch(/^https:\/\/accounts\.google\.test\//);
    expect(google.last!.redirectUri).toBe(`${WEB}/api/auth/google/callback`);
    expect(google.last!.codeChallenge).toMatch(/^[\w-]{43}$/);
    return google.last!.state;
  }

  test('creates the account from Google, links it, and returns to the page the person was on', async () => {
    expect((await request(g.http).get('/api/auth/providers')).body).toEqual({ google: true, emailCode: true });
    const agent = request.agent(g.http);
    const state = await startAndReturn(agent, '/@someone?tab=videos');
    const cb = await agent.get(`/api/auth/google/callback?code=ok&state=${state}`).expect(303);
    expect(cb.headers.location).toBe('/@someone?tab=videos');
    const me = await agent.get('/api/me').expect(200);
    expect(me.body.profile).toMatchObject({ displayName: 'Aline Uwase', avatarUrl: 'https://lh3.googleusercontent.com/a/test' });
    expect(await g.prisma.oAuthAccount.count({ where: { provider: 'google', providerAccountId: 'google-sub-1' } })).toBe(1);

    // The same person with an email code lands in the same account.
    await g.clearLimits();
    const otp = await signIn(g.http, g.mail, 'aline@example.com');
    expect(otp.res.body.newAccount).toBe(false);
    // Google account renamed its address: still the same Free Me account (linked by Google's id).
    google.profile = { ...google.profile, email: 'aline.new@example.com' };
    const agent2 = request.agent(g.http);
    const s2 = await startAndReturn(agent2);
    await agent2.get(`/api/auth/google/callback?code=ok&state=${s2}`).expect(303);
    expect((await agent2.get('/api/me')).body.user.email).toBe('aline@example.com');
    expect(await g.prisma.user.count()).toBe(1);
  });

  test('refuses a wrong state, a replayed nonce, an unverified email and unsafe return paths', async () => {
    const agent = request.agent(g.http);
    await startAndReturn(agent);
    expect((await agent.get('/api/auth/google/callback?code=ok&state=forged').expect(303)).headers.location).toBe('/login?error=google_expired');

    const s = await startAndReturn(agent);
    google.nonceOverride = 'another-nonce';
    expect((await agent.get(`/api/auth/google/callback?code=ok&state=${s}`).expect(303)).headers.location).toBe('/login?error=google_failed');

    google.nonceOverride = null;
    google.profile = { ...google.profile, emailVerified: false };
    const s3 = await startAndReturn(agent);
    expect((await agent.get(`/api/auth/google/callback?code=ok&state=${s3}`).expect(303)).headers.location).toBe('/login?error=google_unverified');

    google.profile = { ...google.profile, emailVerified: true };
    const s4 = await startAndReturn(agent, '//evil.example/x');
    expect((await agent.get(`/api/auth/google/callback?code=ok&state=${s4}`).expect(303)).headers.location).toBe('/');

    const s5 = await startAndReturn(agent);
    expect((await agent.get(`/api/auth/google/callback?code=bad&state=${s5}`).expect(303)).headers.location).toBe('/login?error=google_failed');
    // Without the state cookie (another browser), the callback is refused.
    expect((await request(g.http).get(`/api/auth/google/callback?code=ok&state=${s5}`).expect(303)).headers.location).toBe('/login?error=google_expired');
    expect((await agent.get('/api/auth/google/callback?error=access_denied').expect(303)).headers.location).toBe('/login?error=google_cancelled');
  });
});

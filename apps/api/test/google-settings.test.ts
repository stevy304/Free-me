import { makeApp, resetDb, signIn, WEB } from './helpers';

// Google sign-in switched on from Administration → Sign-in: keys checked, the secret stored encrypted and never
// shown again, the login page offers Google at once and the start link goes to Google with this client id.
let ctx: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => { ctx = await makeApp({ adminEmails: ['admin@example.com'], google: 'real' }); }, 60_000);
beforeEach(async () => { await resetDb(ctx.prisma); ctx.mail.outbox.length = 0; await ctx.clearLimits(); });
afterAll(async () => { await ctx.app.close(); });

const ID = '123456789012-abcdefghijklmnopqrstuvwxyz012345.apps.googleusercontent.com';
const SECRET = 'GOCSPX-test-secret-0123456789';

test('an administrator switches Google sign-in on and off in the app', async () => {
  const { agent: admin } = await signIn(ctx.http, ctx.mail, 'admin@example.com');
  const { agent: user } = await signIn(ctx.http, ctx.mail, 'viewer@example.com');
  expect((await admin.get('/api/auth/providers').expect(200)).body.google).toBe(false);
  const before = (await admin.get('/api/admin/auth/google').expect(200)).body;
  expect(before).toMatchObject({ source: 'none', active: false, redirectUri: `${WEB}/api/auth/google/callback`, origin: WEB });

  await user.put('/api/admin/auth/google').set('Origin', WEB).send({ enabled: true, clientId: ID, clientSecret: SECRET }).expect(403);
  await admin.put('/api/admin/auth/google').set('Origin', WEB).send({ enabled: true, clientId: 'not-a-client-id', clientSecret: SECRET }).expect(400);
  const saved = (await admin.put('/api/admin/auth/google').set('Origin', WEB).send({ enabled: true, clientId: ID, clientSecret: SECRET }).expect(200)).body;
  expect(saved).toMatchObject({ source: 'app', active: true, enabled: true, clientId: ID, clientSecret: '••••6789' });
  const row = await ctx.prisma.appSetting.findUniqueOrThrow({ where: { key: 'google' } });
  expect(JSON.stringify(row.value)).not.toContain(SECRET); // encrypted at rest

  expect((await user.get('/api/auth/providers').expect(200)).body.google).toBe(true);
  const start = await user.get('/api/auth/google?returnTo=/hub').expect(303);
  const url = new URL(start.headers.location);
  expect(url.hostname).toBe('accounts.google.com');
  expect(url.searchParams.get('client_id')).toBe(ID);
  expect(url.searchParams.get('redirect_uri')).toBe(`${WEB}/api/auth/google/callback`);
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');

  // Saving again without the secret keeps it; switching off hides Google at once.
  await admin.put('/api/admin/auth/google').set('Origin', WEB).send({ enabled: false }).expect(200);
  expect((await user.get('/api/auth/providers').expect(200)).body.google).toBe(false);
  expect((await user.get('/api/auth/google').expect(303)).headers.location).toBe('/login?error=google_unavailable');
  const on = (await admin.put('/api/admin/auth/google').set('Origin', WEB).send({ enabled: true }).expect(200)).body;
  expect(on).toMatchObject({ active: true, clientSecret: '••••6789' });
});

test('the launch checklist says what is missing and how to fix it', async () => {
  const { agent: admin } = await signIn(ctx.http, ctx.mail, 'admin@example.com');
  const { agent: user } = await signIn(ctx.http, ctx.mail, 'viewer@example.com');
  await user.get('/api/admin/system/launch').expect(403);
  const r = (await admin.get('/api/admin/system/launch').expect(200)).body;
  const by = Object.fromEntries(r.checks.map((c: any) => [c.id, c]));
  expect(r.ready).toBe(false); // the test server is http and writes emails to memory
  expect(by.https).toMatchObject({ ok: false, required: true });
  expect(by.email).toMatchObject({ ok: false, required: true });
  expect(by.admin).toMatchObject({ ok: true });
  expect(by.google).toMatchObject({ ok: false, required: false });
  await admin.put('/api/admin/auth/google').set('Origin', WEB).send({ enabled: true, clientId: ID, clientSecret: SECRET }).expect(200);
  expect((await admin.get('/api/admin/system/launch').expect(200)).body.checks.find((c: any) => c.id === 'google').ok).toBe(true);
  for (const c of r.checks) expect(c.fix.length).toBeGreaterThan(10);
});

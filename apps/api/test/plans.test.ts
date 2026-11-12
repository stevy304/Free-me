import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { makeApp, resetDb, signIn, WEB } from './helpers';
import { Billing, uploadAccess } from '../src/billing/billing';
import { BillingService } from '../src/billing/billing.controller';
import { ViewCounter } from '../src/media/views';
import { RedisService } from '../src/database/redis.service';

// The plans: Plus (no ads, every quality), Family & TV (Plus for up to 4 people), the yearly Creator pass, paid with
// MTN MoMo or Airtel Money; members' watch time shares their money with creators; reminders before a plan ends.
let provider: Server;
const momo = new Map<string, { body: any; status: string }>();
const airtel = new Map<string, { body: any; status: string; headers: any }>();
let ctx: Awaited<ReturnType<typeof makeApp>>;
const DAY = 86_400_000;

beforeAll(async () => {
  provider = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const send = (code: number, body?: object) => { res.writeHead(code, { 'content-type': 'application/json' }).end(body ? JSON.stringify(body) : undefined); };
      const url = req.url ?? '';
      // MTN MoMo Collections
      if (url === '/collection/token/') return send(200, { access_token: 'tok', expires_in: 3600 });
      if (url === '/collection/v1_0/requesttopay' && req.method === 'POST') { momo.set(String(req.headers['x-reference-id']), { body: JSON.parse(raw), status: 'PENDING' }); return send(202); }
      const m = /^\/collection\/v1_0\/requesttopay\/(.+)$/.exec(url);
      if (m) { const p = momo.get(m[1]); return p ? send(200, { status: p.status, amount: p.body.amount, currency: p.body.currency }) : send(404); }
      // Airtel Money (Airtel Africa Open API)
      if (url === '/auth/oauth2/token' && req.method === 'POST') {
        const b = JSON.parse(raw);
        return b.client_id === 'air-id' && b.client_secret === 'air-secret' && b.grant_type === 'client_credentials' ? send(200, { access_token: 'atok', expires_in: '3600' }) : send(401);
      }
      if (url === '/merchant/v1/payments/' && req.method === 'POST') {
        if (req.headers.authorization !== 'Bearer atok') return send(401);
        const b = JSON.parse(raw);
        airtel.set(b.transaction.id, { body: b, status: 'TIP', headers: req.headers });
        return send(200, { status: { success: true, message: 'SUCCESS' } });
      }
      const a = /^\/standard\/v1\/payments\/(.+)$/.exec(url);
      if (a) { const p = airtel.get(decodeURIComponent(a[1])); return p ? send(200, { data: { transaction: { id: a[1], status: p.status } }, status: { success: true } }) : send(404); }
      send(404);
    });
  });
  await new Promise<void>((r) => provider.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  ctx = await makeApp({ adminEmails: ['admin@example.com'], env: {
    MOMO_BASE_URL: base, MOMO_SUBSCRIPTION_KEY: 'sub-1', MOMO_API_USER: 'user-1', MOMO_API_KEY: 'key-1', MOMO_CURRENCY: 'RWF', MOMO_RATE_PER_USD: '1450',
    AIRTEL_BASE_URL: base, AIRTEL_CLIENT_ID: 'air-id', AIRTEL_CLIENT_SECRET: 'air-secret',
  } });
});
beforeEach(async () => { await resetDb(ctx.prisma); ctx.mail.outbox.length = 0; await ctx.clearLimits(); momo.clear(); airtel.clear(); ctx.app.get(BillingService).invalidate(); });
afterAll(async () => { await ctx.app.close(); await new Promise((r) => provider.close(r)); });

async function person(email: string, country?: string) {
  const s = await signIn(ctx.http, ctx.mail, email);
  const user = await ctx.prisma.user.findUniqueOrThrow({ where: { email } });
  if (country) await ctx.prisma.profile.update({ where: { userId: user.id }, data: { country } });
  return { agent: s.agent, user };
}
async function monetisedVideo(handle: string, extra: object = {}) {
  const s = await signIn(ctx.http, ctx.mail, `${handle}@example.com`);
  const ch = (await s.agent.post('/api/channels').set('Origin', WEB).send({ handle, name: handle }).expect(201)).body.channel;
  await ctx.prisma.creatorEligibility.create({ data: { channelId: ch.id, isEligible: true } });
  await new Billing(ctx.prisma as never, ctx.config).grantPremium((await ctx.prisma.user.findUniqueOrThrow({ where: { email: `${handle}@example.com` } })).id, 1);
  const video = await ctx.prisma.video.create({ data: { channelId: ch.id, title: 'Video', durationSeconds: 600, status: 'READY', visibility: 'PUBLIC', mediaLocation: 'PUBLIC', hlsMasterKey: 'hls/master.m3u8', hlsFullMasterKey: 'hls/master-full.m3u8', publishedAt: new Date(), ...extra } });
  return { channel: ch, video };
}

test('prices: Rwanda pays its own prices, everyone else the standard ones; Airtel Money is offered', async () => {
  const plans = (await request(ctx.http).get('/api/billing/plans').expect(200)).body;
  expect(plans.plus).toMatchObject({ usdCents: 300, months: [1, 3, 6, 12], country: null });
  expect(plans.family).toMatchObject({ usdCents: 1200, seats: 4 });
  expect(plans.creatorPass).toMatchObject({ usdCents: 200, months: [12, 24], freeVideos: 1000, videosPerYear: 50 });
  expect(plans.methods.map((m: any) => m.name).sort()).toEqual(['airtel_money', 'mtn_momo']);
  const rw = await person('rw@example.com', 'RW');
  const mine = (await rw.agent.get('/api/billing/plans').expect(200)).body;
  // RWF 2,500 / 9,000 / 6,000 at about RWF 1,450 a dollar.
  expect([mine.plus.usdCents, mine.family.usdCents, mine.premium.usdCents]).toEqual([172, 621, 414]);
  expect(mine.plus).toMatchObject({ standardUsdCents: 300, country: 'RW' });
});

test('Plus by Airtel Money: no ads, every quality; it ends with its time', async () => {
  const { video } = await monetisedVideo('maker');
  await ctx.prisma.campaign.deleteMany();
  const viewer = await person('viewer@example.com', 'RW');
  await viewer.agent.post('/api/billing/plans/plus').set('Origin', WEB).send({ method: 'airtel_money', phone: '0731234567', months: 5 }).expect(400);
  const pay = (await viewer.agent.post('/api/billing/plans/plus').set('Origin', WEB).send({ method: 'airtel_money', phone: '0731234567', months: 3 }).expect(201)).body.payment;
  expect(pay).toMatchObject({ purpose: 'PLUS', method: 'airtel_money', usdCents: 516, amount: String(Math.ceil(5.16 * 1450)), currency: 'RWF', months: 3 });
  const sent = [...airtel.values()][0];
  expect(sent.body).toMatchObject({ subscriber: { country: 'RW', currency: 'RWF', msisdn: '731234567' }, transaction: { amount: Math.ceil(5.16 * 1450), country: 'RW', currency: 'RWF' } });
  expect(sent.headers).toMatchObject({ 'x-country': 'RW', 'x-currency': 'RWF' });
  expect((await viewer.agent.get(`/api/billing/payments/${pay.id}`).expect(200)).body.payment.status).toBe('PENDING');
  sent.status = 'TS';
  expect((await viewer.agent.get(`/api/billing/payments/${pay.id}`).expect(200)).body.payment.status).toBe('SUCCEEDED');
  const me = (await viewer.agent.get('/api/billing/me').expect(200)).body.plans.plus;
  expect(me).toMatchObject({ active: true, via: 'plus' });
  expect(new Date(me.until).getTime()).toBeGreaterThan(Date.now() + 89 * DAY);

  // Every quality, and no ad slots or counted ad views.
  expect((await viewer.agent.get(`/api/videos/${video.id}`).expect(200)).body.video).toMatchObject({ qualityLimit: null, playbackUrl: expect.stringContaining('master-full.m3u8') });
  expect((await viewer.agent.get(`/api/videos/${video.id}/ads`).expect(200)).body.slots).toEqual([]);
  const free = await person('free@example.com');
  expect((await free.agent.get(`/api/videos/${video.id}`).expect(200)).body.video.qualityLimit).toBe(720);

  // A failed Airtel payment does not give anything.
  const second = (await free.agent.post('/api/billing/plans/plus').set('Origin', WEB).send({ method: 'airtel_money', phone: '+250 731 000 000', months: 1 }).expect(201)).body.payment;
  [...airtel.values()].at(-1)!.status = 'TF';
  expect((await free.agent.get(`/api/billing/payments/${second.id}`).expect(200)).body.payment).toMatchObject({ status: 'FAILED', failureReason: 'The Airtel Money payment did not go through.' });
  expect((await free.agent.get('/api/billing/me').expect(200)).body.plans.plus.active).toBe(false);

  await ctx.prisma.user.update({ where: { id: viewer.user.id }, data: { plusUntil: new Date(Date.now() - 1000) } });
  expect((await viewer.agent.get(`/api/videos/${video.id}`).expect(200)).body.video.qualityLimit).toBe(720);
});

test('Family & TV: the holder adds up to 3 people; they get Plus while the plan lasts; they can be removed or leave', async () => {
  const holder = await person('holder@example.com', 'RW');
  const pay = (await holder.agent.post('/api/billing/plans/family').set('Origin', WEB).send({ method: 'mtn_momo', phone: '0788111222', months: 1 }).expect(201)).body.payment;
  expect(pay).toMatchObject({ purpose: 'FAMILY', usdCents: 621, amount: String(Math.ceil(6.21 * 1450)) });
  await holder.agent.post('/api/billing/family/members').set('Origin', WEB).send({ email: 'kid1@example.com' }).expect(400); // not paid yet
  [...momo.values()][0].status = 'SUCCESSFUL';
  await holder.agent.get(`/api/billing/payments/${pay.id}`).expect(200);

  const kids = await Promise.all(['kid1', 'kid2', 'kid3', 'kid4'].map((k) => person(`${k}@example.com`)));
  await holder.agent.post('/api/billing/family/members').set('Origin', WEB).send({ email: 'nobody@example.com' }).expect(404);
  for (const k of ['kid1', 'kid2', 'kid3']) await holder.agent.post('/api/billing/family/members').set('Origin', WEB).send({ email: `${k}@example.com` }).expect(201);
  expect((await holder.agent.post('/api/billing/family/members').set('Origin', WEB).send({ email: 'kid4@example.com' }).expect(400)).body.message).toContain('up to 4 people');
  const fam = (await holder.agent.get('/api/billing/family').expect(200)).body;
  expect(fam.holder).toMatchObject({ active: true, seats: 4 });
  expect(fam.holder.members.map((m: any) => m.email)).toEqual(['kid1@example.com', 'kid2@example.com', 'kid3@example.com']);

  expect((await kids[0].agent.get('/api/billing/me').expect(200)).body.plans).toMatchObject({ plus: { active: true, via: 'family_member' }, family: { memberOf: { email: 'holder@example.com' } } });
  // Someone already in a plan cannot be added to another one.
  const other = await person('other@example.com');
  await ctx.prisma.user.update({ where: { id: other.user.id }, data: { familyUntil: new Date(Date.now() + 10 * DAY) } });
  expect((await other.agent.post('/api/billing/family/members').set('Origin', WEB).send({ email: 'kid1@example.com' }).expect(400)).body.message).toBe('They are already in another Family & TV plan.');

  await holder.agent.delete(`/api/billing/family/members/${kids[1].user.id}`).set('Origin', WEB).expect(200);
  expect((await kids[1].agent.get('/api/billing/me').expect(200)).body.plans.plus.active).toBe(false);
  await kids[2].agent.delete('/api/billing/family/membership').set('Origin', WEB).expect(200);
  expect((await kids[2].agent.get('/api/billing/me').expect(200)).body.plans.plus.active).toBe(false);
  // When the holder's plan ends, the members' perks end with it.
  await ctx.prisma.user.update({ where: { id: holder.user.id }, data: { familyUntil: new Date(Date.now() - 1000) } });
  expect((await kids[0].agent.get('/api/billing/me').expect(200)).body.plans.plus.active).toBe(false);
});

test('creators get half of members\' money by members\' watch time, day by day', async () => {
  const a = await monetisedVideo('alpha');
  const b = await monetisedVideo('beta');
  const notMonetised = await ctx.prisma.video.create({ data: { channelId: (await signIn(ctx.http, ctx.mail, 'gamma@example.com').then(async (s) => (await s.agent.post('/api/channels').set('Origin', WEB).send({ handle: 'gamma', name: 'gamma' }).expect(201)).body.channel)).id,
    title: 'x', durationSeconds: 600, status: 'READY', visibility: 'PUBLIC', mediaLocation: 'PUBLIC', hlsMasterKey: 'hls/master.m3u8', publishedAt: new Date() } });
  const member = await person('member@example.com');
  await ctx.prisma.user.update({ where: { id: member.user.id }, data: { plusUntil: new Date(Date.now() + 30 * DAY) } });

  // Watch time counted through the view endpoint (Redis batching, then the worker's flush).
  await member.agent.post(`/api/videos/${a.video.id}/views`).set('Origin', WEB).send({ watchedSeconds: 300 }).expect(200);
  const anon = request(ctx.http);
  await anon.post(`/api/videos/${b.video.id}/views`).set('Origin', WEB).send({ watchedSeconds: 300 }).expect(200);
  await new ViewCounter(ctx.prisma as never, ctx.app.get(RedisService).client).flush();
  const stats = await ctx.prisma.videoDailyStat.findMany();
  expect(stats.find((s) => s.videoId === a.video.id)).toMatchObject({ watchSeconds: 300n, plusWatchSeconds: 300n });
  expect(stats.find((s) => s.videoId === b.video.id)).toMatchObject({ watchSeconds: 300n, plusWatchSeconds: 0n });

  // Yesterday: a $30, 1-month Plus payment counts $1 that day; 50c is shared 4:1 by members' watch time.
  const yesterday = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z').getTime() - DAY;
  await ctx.prisma.payment.create({ data: { userId: member.user.id, purpose: 'PLUS', provider: 'manual', providerRef: 'x', amountMinor: 3000n, currency: 'USD', usdCents: 3000, months: 1, status: 'SUCCEEDED', paidAt: new Date(yesterday) } });
  await ctx.prisma.videoDailyStat.deleteMany();
  await ctx.prisma.videoDailyStat.createMany({ data: [
    { videoId: a.video.id, day: new Date(yesterday), views: 1, plusWatchSeconds: 1200n },
    { videoId: b.video.id, day: new Date(yesterday), views: 1, plusWatchSeconds: 300n },
    { videoId: notMonetised.id, day: new Date(yesterday), views: 1, plusWatchSeconds: 6000n },
  ] });
  const billing = new Billing(ctx.prisma as never, ctx.config);
  expect(await billing.settleAds()).toBe(1);
  const day = await ctx.prisma.adDaySettlement.findFirstOrThrow();
  expect(day).toMatchObject({ subscriptionPoolCents: 50n, subscriptionAllocatedCents: 50n });
  const ledger = await ctx.prisma.revenueLedger.findMany({ where: { sourceType: 'SUBSCRIPTION_SHARE' }, orderBy: { creatorShareCents: 'desc' } });
  expect(ledger.map((l) => [l.channelId, Number(l.creatorShareCents)])).toEqual([[a.channel.id, 40], [b.channel.id, 10]]);
  expect(ledger[0].description).toContain('20 minutes watched');
});

test('the Creator pass allows 50 uploads in a year; Premium has no limit', () => {
  const now = new Date();
  const b = { creatorFreeVideos: 3, creatorPassVideosPerYear: 50 };
  const pass = { premiumUntil: null, roles: [], creatorPassUntil: new Date(now.getTime() + DAY) } as never;
  expect(uploadAccess(pass, 60, 49, b, now)).toMatchObject({ allowed: true, passLeft: 1 });
  expect(uploadAccess(pass, 60, 50, b, now)).toMatchObject({ allowed: false, reason: 'PASS_LIMIT', passLeft: 0 });
  expect(uploadAccess({ premiumUntil: null, roles: [], creatorPassUntil: null } as never, 3, 3, b, now)).toMatchObject({ allowed: false, reason: 'PASS_REQUIRED' });
  expect(uploadAccess({ premiumUntil: new Date(now.getTime() + DAY), roles: [], creatorPassUntil: null } as never, 500, 400, b, now)).toMatchObject({ allowed: true, pro: true, passLeft: null });
});

test('one renewal reminder, three days before a plan ends', async () => {
  const u = await person('renew@example.com');
  const until = new Date(Date.now() + 2.5 * DAY);
  await ctx.prisma.user.update({ where: { id: u.user.id }, data: { plusUntil: until, creatorPassUntil: new Date(Date.now() + 20 * DAY) } });
  const seen = new Set<string>();
  const remember = async (k: string) => { if (seen.has(k)) return false; seen.add(k); return true; };
  const billing = new Billing(ctx.prisma as never, ctx.config);
  ctx.mail.outbox.length = 0;
  expect(await billing.sendRenewalReminders(ctx.mail as never, remember)).toBe(1);
  expect(await billing.sendRenewalReminders(ctx.mail as never, remember)).toBe(0);
  const mail = ctx.mail.outbox.at(-1)!;
  expect(mail).toMatchObject({ to: 'renew@example.com', subject: `Your Free Me Plus ends on ${until.toISOString().slice(0, 10)}` });
});

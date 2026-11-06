import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { makeApp, resetDb, signIn, WEB } from './helpers';
import { Billing } from '../src/billing/billing';

// Stand-ins for MTN MoMo (Collections) and Flutterwave, speaking their HTTP APIs.
let provider: Server;
const momo = new Map<string, { body: any; status: string }>();
const flw = new Map<string, { body: any; status: string }>();
let ctx: Awaited<ReturnType<typeof makeApp>>;

beforeAll(async () => {
  provider = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const send = (code: number, body?: object) => { res.writeHead(code, { 'content-type': 'application/json' }).end(body ? JSON.stringify(body) : undefined); };
      const url = req.url ?? '';
      if (url === '/collection/token/') return req.headers.authorization === `Basic ${Buffer.from('user-1:key-1').toString('base64')}` ? send(200, { access_token: 'tok', expires_in: 3600 }) : send(401);
      if (url === '/collection/v1_0/requesttopay' && req.method === 'POST') {
        if (req.headers.authorization !== 'Bearer tok' || req.headers['ocp-apim-subscription-key'] !== 'sub-1') return send(401);
        momo.set(String(req.headers['x-reference-id']), { body: JSON.parse(raw), status: 'PENDING' });
        return send(202);
      }
      const m = /^\/collection\/v1_0\/requesttopay\/(.+)$/.exec(url);
      if (m) { const p = momo.get(m[1]); return p ? send(200, { status: p.status, amount: p.body.amount, currency: p.body.currency, reason: p.status === 'FAILED' ? 'APPROVAL_REJECTED' : undefined }) : send(404); }
      if (url === '/v3/payments' && req.method === 'POST') {
        if (req.headers.authorization !== 'Bearer flw-secret') return send(401);
        const b = JSON.parse(raw); flw.set(b.tx_ref, { body: b, status: 'pending' });
        return send(200, { status: 'success', data: { link: `https://checkout.flutterwave.test/pay/${b.tx_ref}` } });
      }
      const v = /^\/v3\/transactions\/verify_by_reference\?tx_ref=(.+)$/.exec(url);
      if (v) { const p = flw.get(decodeURIComponent(v[1])); return p && p.status !== 'pending' ? send(200, { status: 'success', data: { status: p.status, amount: Number(p.body.amount), currency: p.body.currency } }) : send(404, { status: 'error', message: 'No transaction was found' }); }
      send(404);
    });
  });
  await new Promise<void>((r) => provider.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  ctx = await makeApp({ adminEmails: ['admin@example.com'], env: {
    MOMO_BASE_URL: base, MOMO_SUBSCRIPTION_KEY: 'sub-1', MOMO_API_USER: 'user-1', MOMO_API_KEY: 'key-1', MOMO_CURRENCY: 'RWF', MOMO_RATE_PER_USD: '1450',
    FLW_BASE_URL: base, FLW_SECRET_KEY: 'flw-secret', FLW_WEBHOOK_HASH: 'hook-secret', PAYOUT_MINIMUM_USD_CENTS: '100',
  } });
});
beforeEach(async () => { await resetDb(ctx.prisma); ctx.mail.outbox.length = 0; await ctx.clearLimits(); momo.clear(); flw.clear(); });
afterAll(async () => { await ctx.app.close(); provider.close(); });

async function creator(email: string, handle: string) {
  const c = await signIn(ctx.http, ctx.mail, email);
  await c.agent.post('/api/channels').set('Origin', WEB).send({ handle, name: handle }).expect(201);
  return c.agent;
}

test('Premium by MTN MoMo: $10 a month charged in RWF, verified badge while it lasts, paid once even if checked twice', async () => {
  const plans = (await request(ctx.http).get('/api/billing/plans').expect(200)).body;
  expect(plans).toMatchObject({ premium: { usdCents: 1000, months: [1, 3, 6, 12] }, ads: { usdCentsPerDay: 300, maxAdsPerVideo: 2 } });
  expect(plans.methods).toEqual([{ name: 'mtn_momo', currency: 'RWF', perUsd: 1450 }, { name: 'flutterwave', currency: 'USD', perUsd: 1 }]);

  const a = await creator('maker@example.com', 'maker');
  await a.post('/api/billing/premium').set('Origin', WEB).send({ method: 'mtn_momo', months: 1, phone: '12' }).expect(400);
  const pay = (await a.post('/api/billing/premium').set('Origin', WEB).send({ method: 'mtn_momo', months: 1, phone: '0788 123 456' }).expect(201)).body.payment;
  expect(pay).toMatchObject({ status: 'PENDING', amount: '14500', currency: 'RWF', usdCents: 1000 });
  const sent = [...momo.values()][0].body;
  expect(sent).toMatchObject({ amount: '14500', currency: 'RWF', payer: { partyIdType: 'MSISDN', partyId: '250788123456' }, externalId: pay.id });

  // Not approved on the phone yet.
  expect((await a.get(`/api/billing/payments/${pay.id}`).expect(200)).body.payment.status).toBe('PENDING');
  [...momo.values()][0].status = 'SUCCESSFUL';
  const done = (await a.get(`/api/billing/payments/${pay.id}`).expect(200)).body;
  expect(done.payment.status).toBe('SUCCEEDED');
  expect(done.premium.active).toBe(true);
  const until = done.premium.until;
  // The worker checking again does not extend it twice.
  await new Billing(ctx.prisma as never, ctx.config).reconcile();
  expect((await a.get('/api/me').expect(200)).body).toMatchObject({ premium: { active: true, until }, channel: { isVerified: true } });

  const receipts = new Billing(ctx.prisma as never, ctx.config);
  await Promise.all([receipts.sendReceipts(ctx.mail), receipts.sendReceipts(ctx.mail)]);
  await receipts.sendReceipts(ctx.mail);
  const delivered = ctx.mail.outbox.filter((m) => m.subject === 'Your Free Me payment receipt');
  expect(delivered).toHaveLength(1);
  expect(delivered[0]).toMatchObject({ to: 'maker@example.com', text: expect.stringContaining('RWF 14500') });

  // Membership ends: the badge goes; a badge given by administrators would stay.
  await ctx.prisma.user.update({ where: { email: 'maker@example.com' }, data: { premiumUntil: new Date(Date.now() - 1000) } });
  await new Billing(ctx.prisma as never, ctx.config).expirePremium();
  expect((await a.get('/api/me').expect(200)).body).toMatchObject({ premium: { active: false }, channel: { isVerified: false } });

  const admin = await signIn(ctx.http, ctx.mail, 'admin@example.com');
  const verify = (verified: boolean) => admin.agent.post('/api/admin/billing/verification').set('Origin', WEB).send({ handle: '@maker', verified });
  await a.post('/api/admin/billing/verification').set('Origin', WEB).send({ handle: 'maker', verified: true }).expect(403);
  await verify(true).expect(200, { badge: { isVerified: true, verificationSource: 'ADMIN' } });
  await receipts.expirePremium();
  expect((await a.get('/api/me').expect(200)).body.channel.isVerified).toBe(true);
  await verify(false).expect(200, { badge: { isVerified: false, verificationSource: null } });

  // A declined prompt fails with a reason people understand.
  const p2 = (await a.post('/api/billing/premium').set('Origin', WEB).send({ method: 'mtn_momo', months: 3, phone: '+250788123456' }).expect(201)).body.payment;
  expect(p2.amount).toBe('43500');
  [...momo.values()].at(-1)!.status = 'FAILED';
  expect((await a.get(`/api/billing/payments/${p2.id}`).expect(200)).body.payment).toMatchObject({ status: 'FAILED', failureReason: 'The payment was declined on the phone.' });
});

test('Premium by card (Flutterwave): checkout link, verified with Flutterwave; the webhook needs its secret', async () => {
  const a = await creator('card@example.com', 'card');
  const pay = (await a.post('/api/billing/premium').set('Origin', WEB).send({ method: 'flutterwave', months: 12 }).expect(201)).body.payment;
  expect(pay).toMatchObject({ amount: '12000', currency: 'USD', checkoutUrl: `https://checkout.flutterwave.test/pay/fm-${pay.id}` });
  expect(flw.get(`fm-${pay.id}`)!.body).toMatchObject({ amount: '120.00', currency: 'USD', redirect_url: `${WEB}/premium?payment=${pay.id}`, customer: { email: 'card@example.com' } });

  await request(ctx.http).post('/api/billing/webhooks/flutterwave').send({ data: { tx_ref: `fm-${pay.id}` } }).expect(403);
  flw.get(`fm-${pay.id}`)!.status = 'successful';
  await request(ctx.http).post('/api/billing/webhooks/flutterwave').set('verif-hash', 'hook-secret').send({ data: { tx_ref: `fm-${pay.id}` } }).expect(200);
  const me = (await a.get('/api/billing/me').expect(200)).body;
  expect(me.payments[0]).toMatchObject({ status: 'SUCCEEDED', months: 12 });
  expect(new Date(me.premium.until).getTime()).toBeGreaterThan(Date.now() + 359 * 86_400_000);
});

test('ads: a business pays $3 a day, an administrator approves, monetised Premium creators show at most two per video and share 60% of the day', async () => {
  // A creator joins the monetisation programme: Premium first.
  const maker = await creator('maker@example.com', 'maker');
  await maker.post('/api/hub/monetisation/join').set('Origin', WEB).expect(403);
  const makerUser = await ctx.prisma.user.findUniqueOrThrow({ where: { email: 'maker@example.com' } });
  await new Billing(ctx.prisma as never, ctx.config).grantPremium(makerUser.id, 1);
  expect((await maker.post('/api/hub/monetisation/join').set('Origin', WEB).expect(200)).body).toMatchObject({ joined: true, earning: true });
  const makerCh = await ctx.prisma.channel.findUniqueOrThrow({ where: { handle: 'maker' } });
  const video = (mins: number, extra: object = {}) => ctx.prisma.video.create({ data: { channelId: makerCh.id, title: `v${mins}`, durationSeconds: mins * 60, status: 'READY', visibility: 'PUBLIC', mediaLocation: 'PUBLIC', hlsMasterKey: 'hls/master.m3u8', publishedAt: new Date(), ...extra } });
  const short = await video(3); const long = await video(20); const moment = await video(1, { isShort: true });

  // A business: its ad is one of its own short videos.
  const biz = await creator('shop@example.com', 'shop');
  // Ad Studio is part of Premium.
  await biz.post('/api/ads/campaigns').set('Origin', WEB).send({}).expect(400);
  await new Billing(ctx.prisma as never, ctx.config).grantPremium((await ctx.prisma.user.findUniqueOrThrow({ where: { email: 'shop@example.com' } })).id, 1);
  const shopCh = await ctx.prisma.channel.findUniqueOrThrow({ where: { handle: 'shop' } });
  const adVideo = await ctx.prisma.video.create({ data: { channelId: shopCh.id, title: 'Our shop', durationSeconds: 20, status: 'READY', visibility: 'UNLISTED', mediaLocation: 'PUBLIC', hlsMasterKey: 'hls/master.m3u8' } });
  const tooLong = await ctx.prisma.video.create({ data: { channelId: shopCh.id, title: 'Long', durationSeconds: 300, status: 'READY', visibility: 'UNLISTED', mediaLocation: 'PUBLIC', hlsMasterKey: 'hls/master.m3u8' } });
  const form = { businessName: 'Kigali Shop', country: 'RW', headline: 'Fresh coffee in Kigali', destinationUrl: 'https://shop.example.com', days: 7 };
  expect((await biz.post('/api/ads/campaigns').set('Origin', WEB).send({ ...form, videoId: tooLong.id }).expect(400)).body.message).toBe('An ad must be between 5 and 90 seconds long.');
  await biz.post('/api/ads/campaigns').set('Origin', WEB).send({ ...form, videoId: short.id }).expect(400); // not theirs
  const camp = (await biz.post('/api/ads/campaigns').set('Origin', WEB).send({ ...form, videoId: adVideo.id }).expect(201)).body.campaign;
  expect(camp).toMatchObject({ status: 'DRAFT', days: 7, dailyRateCents: 300, totalCents: 2100 });

  // Paid by MoMo (21 USD → 30,450 RWF), then waits for review.
  const pay = (await biz.post(`/api/ads/campaigns/${camp.id}/pay`).set('Origin', WEB).send({ method: 'mtn_momo', phone: '0788000111' }).expect(201)).body.payment;
  expect(pay).toMatchObject({ amount: '30450', usdCents: 2100 });
  [...momo.values()][0].status = 'SUCCESSFUL';
  await biz.get(`/api/billing/payments/${pay.id}`).expect(200);
  expect((await biz.get('/api/ads/campaigns').expect(200)).body.campaigns[0].status).toBe('PENDING_REVIEW');
  expect((await request(ctx.http).get(`/api/videos/${short.id}/ads`).expect(200)).body.slots).toEqual([]);

  const admin = (await signIn(ctx.http, ctx.mail, 'admin@example.com')).agent;
  expect((await admin.get('/api/admin/billing').expect(200)).body).toMatchObject({ premiumMembers: 2, waiting: { adReviews: 1 }, last30Days: { adsUsdCents: 2100 } });
  await maker.post(`/api/admin/billing/campaigns/${camp.id}/review`).set('Origin', WEB).send({ approve: true }).expect(403);
  await admin.post(`/api/admin/billing/campaigns/${camp.id}/review`).set('Origin', WEB).send({ approve: true }).expect(200);

  // Serving: one before a short video, two on a long one, none on Moments.
  const slots = (await request(ctx.http).get(`/api/videos/${short.id}/ads`).expect(200)).body.slots;
  expect(slots).toEqual([{ at: 0, ad: expect.objectContaining({ campaignId: camp.id, businessName: 'Kigali Shop', headline: 'Fresh coffee in Kigali', skipAfterSeconds: 5, playbackUrl: expect.stringContaining(`${adVideo.id}/hls/master.m3u8`) }) }]);
  expect((await request(ctx.http).get(`/api/videos/${moment.id}/ads`).expect(200)).body.slots).toEqual([]);
  // Only one campaign runs, so the long video gets one; a second campaign fills the halfway slot.
  expect((await request(ctx.http).get(`/api/videos/${long.id}/ads`).expect(200)).body.slots.map((s: any) => s.at)).toEqual([0]);

  // Impressions count once per viewer, campaign and video; a click is counted once.
  const viewer = request.agent(ctx.http);
  const imp = (await viewer.post('/api/ads/impressions').set('Origin', WEB).send({ campaignId: camp.id, videoId: short.id }).expect(201)).body.impressionId;
  expect(imp).toBeTruthy();
  expect((await viewer.post('/api/ads/impressions').set('Origin', WEB).send({ campaignId: camp.id, videoId: short.id }).expect(201)).body.impressionId).toBeNull();
  await viewer.post(`/api/ads/impressions/${imp}/events`).set('Origin', WEB).send({ type: 'CLICK', ms: 3000 }).expect(200);
  await viewer.post(`/api/ads/impressions/${imp}/events`).set('Origin', WEB).send({ type: 'CLICK', ms: 3500 }).expect(200);
  expect((await biz.get('/api/ads/campaigns').expect(200)).body.campaigns[0]).toMatchObject({ status: 'ACTIVE', impressions: 1, clicks: 1 });

  // Settlement: yesterday, the campaign ran all day ($3); the creator pool (60%) goes to the channel that showed it.
  const DAY = 86_400_000;
  const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
  await ctx.prisma.campaign.update({ where: { id: camp.id }, data: { startDate: new Date(today.getTime() - DAY), endDate: new Date(today.getTime() + 6 * DAY) } });
  await ctx.prisma.adImpression.update({ where: { id: imp }, data: { createdAt: new Date(today.getTime() - DAY / 2) } });
  const billing = new Billing(ctx.prisma as never, ctx.config);
  expect(await billing.settleAds()).toBe(1);
  expect(await billing.settleAds()).toBe(0); // safe to run again
  const money = (await maker.get('/api/hub/monetisation').expect(200)).body;
  expect(money.balance).toMatchObject({ currency: 'USD', availableCents: 180, lifetimeCents: 180 });
  expect(money.earnings[0]).toMatchObject({ kind: 'AD_SHARE_PRE_ROLL', amountCents: 180 });

  // Withdraw to MoMo; an administrator rejects it and the money comes back, or marks it paid.
  const out = (await maker.post('/api/hub/monetisation/payouts').set('Origin', WEB).send({ phone: '0788 555 444', accountHolderName: 'Maker' }).expect(201)).body.payout;
  expect(out).toMatchObject({ amountCents: 180, account: '250788555444', status: 'REQUESTED' });
  await maker.post('/api/hub/monetisation/payouts').set('Origin', WEB).send({ phone: '0788555444', accountHolderName: 'Maker' }).expect(400);
  await admin.post(`/api/admin/billing/payouts/${out.id}`).set('Origin', WEB).send({ action: 'reject', reason: 'Name does not match the number.' }).expect(200);
  expect((await maker.get('/api/hub/monetisation').expect(200)).body.balance.availableCents).toBe(180);
  const again = (await maker.post('/api/hub/monetisation/payouts').set('Origin', WEB).send({ phone: '0788555444', accountHolderName: 'Maker Name' }).expect(201)).body.payout;
  expect((await admin.post(`/api/admin/billing/payouts/${again.id}`).set('Origin', WEB).send({ action: 'paid', reference: 'MOMO-778899' }).expect(200)).body.payout).toMatchObject({ status: 'PAID', reference: 'MOMO-778899' });
});

test('payment settings in the app: manual payments confirmed by an administrator; secrets stored encrypted; administrators have every Premium feature', async () => {
  const admin = (await signIn(ctx.http, ctx.mail, 'admin@example.com')).agent;
  const buyer = await creator('buyer@example.com', 'buyer');
  await buyer.get('/api/admin/billing/settings').expect(403);

  // Administrators can use Premium features (Live Studio) without a membership.
  expect((await admin.get('/api/me').expect(200)).body.premium).toMatchObject({ active: true, admin: true });
  await admin.post('/api/channels').set('Origin', WEB).send({ handle: 'boss', name: 'Boss' }).expect(201);
  expect((await admin.get('/api/hub/live').expect(200)).body.premium).toBe(true);

  // Manual payments: needs at least one complete account.
  await admin.put('/api/admin/billing/settings').set('Origin', WEB).send({ manual: { enabled: true, currency: 'RWF', perUsd: 1450, accounts: [] } }).expect(400);
  const saved = (await admin.put('/api/admin/billing/settings').set('Origin', WEB).send({
    prices: { premiumUsdCents: 800 },
    manual: { enabled: true, currency: 'RWF', perUsd: 1450, accounts: [{ label: 'MTN MoMo', number: '0788 000 111', name: 'Free Me Ltd' }], instructions: 'Confirmed within 2 hours.' },
  }).expect(200)).body;
  expect(saved).toMatchObject({ prices: { premiumUsdCents: 800 }, manual: { active: true, accounts: [{ label: 'MTN MoMo' }] } });
  const plans = (await request(ctx.http).get('/api/billing/plans').expect(200)).body;
  expect(plans.premium.usdCents).toBe(800);
  expect(plans.methods).toContainEqual({ name: 'manual', currency: 'RWF', perUsd: 1450, accounts: [{ label: 'MTN MoMo', number: '0788 000 111', name: 'Free Me Ltd' }], instructions: 'Confirmed within 2 hours.' });

  // The buyer pays by hand: a reference code, then the transaction id; an administrator confirms.
  const pay = (await buyer.post('/api/billing/premium').set('Origin', WEB).send({ method: 'manual', months: 1 }).expect(201)).body.payment;
  expect(pay).toMatchObject({ method: 'manual', status: 'PENDING', amount: '11600', currency: 'RWF', usdCents: 800, reference: expect.stringMatching(/^FM-[A-Z2-9]{6}$/) });
  await buyer.post(`/api/billing/payments/${pay.id}/proof`).set('Origin', WEB).send({ reference: '1' }).expect(400);
  expect((await buyer.post(`/api/billing/payments/${pay.id}/proof`).set('Origin', WEB).send({ reference: 'MP231106.1234.A56789' }).expect(200)).body.payment.payerReference).toBe('MP231106.1234.A56789');
  // The worker does not decide manual payments.
  await new Billing(ctx.prisma as never, ctx.config).reconcile();
  expect((await buyer.get(`/api/billing/payments/${pay.id}`).expect(200)).body.payment.status).toBe('PENDING');
  const queue = (await admin.get('/api/admin/billing/manual').expect(200)).body.payments;
  expect(queue).toEqual([expect.objectContaining({ id: pay.id, email: 'buyer@example.com', payerReference: 'MP231106.1234.A56789' })]);
  await admin.post(`/api/admin/billing/payments/${pay.id}/confirm`).set('Origin', WEB).send({ approve: false }).expect(400);
  expect((await admin.post(`/api/admin/billing/payments/${pay.id}/confirm`).set('Origin', WEB).send({ approve: true }).expect(200)).body.payment.status).toBe('SUCCEEDED');
  expect((await buyer.get('/api/me').expect(200)).body).toMatchObject({ premium: { active: true }, channel: { isVerified: true } });
  await admin.post(`/api/admin/billing/payments/${pay.id}/confirm`).set('Origin', WEB).send({ approve: true }).expect(400);

  // MoMo keys entered in the app (live address), checked with the provider, stored encrypted, shown masked.
  const base = ctx.config.billing.momo!.baseUrl;
  const mo = (await admin.put('/api/admin/billing/settings').set('Origin', WEB).send({ momo: { enabled: true, sandbox: false, baseUrl: base, targetEnvironment: 'mtnrwanda', subscriptionKey: 'sub-1', apiUser: 'user-1', apiKey: 'key-1', currency: 'RWF', perUsd: 1400 } }).expect(200)).body.momo;
  expect(mo).toMatchObject({ source: 'app', active: true, subscriptionKey: '••••ub-1', apiKey: '••••ey-1', perUsd: 1400 });
  const row = await ctx.prisma.appSetting.findUniqueOrThrow({ where: { key: 'billing' } });
  expect(JSON.stringify(row.value)).not.toContain('key-1');
  expect((await admin.post('/api/admin/billing/settings/test').set('Origin', WEB).send({}).expect(200)).body.momo).toEqual({ ok: true, message: 'Connected.' });
  // Leaving secrets empty keeps them.
  await admin.put('/api/admin/billing/settings').set('Origin', WEB).send({ momo: { enabled: true, sandbox: false, baseUrl: base, currency: 'RWF', perUsd: 1500 } }).expect(200);
  expect((await request(ctx.http).get('/api/billing/plans').expect(200)).body.methods.find((m: any) => m.name === 'mtn_momo')).toMatchObject({ currency: 'RWF', perUsd: 1500 });
});

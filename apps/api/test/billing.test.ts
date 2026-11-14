import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { makeApp, resetDb, signIn, WEB } from './helpers';
import { Billing } from '../src/billing/billing';
import { BillingService } from '../src/billing/billing.controller';

// Stand-ins for MTN MoMo (Collections) and Flutterwave, speaking their HTTP APIs.
let provider: Server;
let dropMomoResponse = false;
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
        if (dropMomoResponse) { dropMomoResponse = false; req.socket.destroy(); return; }
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
      if (v) { const p = flw.get(decodeURIComponent(v[1])); return p && p.status !== 'pending' ? send(200, { status: 'success', data: { status: p.status, amount: Number(p.body.amount), currency: p.body.currency, tx_ref: p.body.tx_ref } }) : send(404, { status: 'error', message: 'No transaction was found' }); }
      send(404);
    });
  });
  await new Promise<void>((r) => provider.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  ctx = await makeApp({ adminEmails: ['admin@example.com'], env: {
    MOMO_BASE_URL: base, MOMO_SUBSCRIPTION_KEY: 'sub-1', MOMO_API_USER: 'user-1', MOMO_API_KEY: 'key-1', MOMO_CURRENCY: 'RWF', MOMO_RATE_PER_USD: '1450',
    FLW_BASE_URL: base, FLW_SECRET_KEY: 'flw-secret', FLW_WEBHOOK_HASH: 'hook-secret', PAYOUT_MINIMUM_USD_CENTS: '100', PAYOUT_RWF_PER_USD: '1450',
  } });
});
beforeEach(async () => { await resetDb(ctx.prisma); ctx.mail.outbox.length = 0; await ctx.clearLimits(); momo.clear(); flw.clear(); dropMomoResponse = false; });
afterAll(async () => { await ctx.app.close(); provider.close(); });

async function creator(email: string, handle: string) {
  const c = await signIn(ctx.http, ctx.mail, email);
  await c.agent.post('/api/channels').set('Origin', WEB).send({ handle, name: handle }).expect(201);
  return c.agent;
}

test('Premium by MTN MoMo: $10 a month charged in RWF, verified badge while it lasts, paid once even if checked twice', async () => {
  const plans = (await request(ctx.http).get('/api/billing/plans').expect(200)).body;
  expect(plans).toMatchObject({ premium: { usdCents: 1000, months: [1, 3, 6, 12] }, ads: { usdCentsPer1000Views: 100, minBudgetUsdCents: 200, maxAdsPerVideo: 2 } });
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
  // $21 of funds spread over 7 days: $1 per 1,000 views, so 21,000 views, 3,000 a day.
  const form = { businessName: 'Kigali Shop', country: 'RW', headline: 'Fresh coffee in Kigali', destinationUrl: 'https://shop.example.com', budgetUsdCents: 2100, days: 7 };
  expect((await biz.post('/api/ads/campaigns').set('Origin', WEB).send({ ...form, videoId: tooLong.id }).expect(400)).body.message).toBe('An ad must be between 5 and 90 seconds long.');
  await biz.post('/api/ads/campaigns').set('Origin', WEB).send({ ...form, videoId: short.id }).expect(400); // not theirs
  const camp = (await biz.post('/api/ads/campaigns').set('Origin', WEB).send({ ...form, videoId: adVideo.id, targetVideoIds: [short.id] }).expect(201)).body.campaign;
  // $3 a day at $1 per 1,000 views: up to 3,000 views a day, 21,000 in all.
  expect(camp).toMatchObject({ status: 'DRAFT', days: 7, dailyRateCents: 300, totalCents: 2100, cpmCents: 100, viewsBought: 21000, viewsPerDay: 3000, spentCents: 0 });
  expect((await request(ctx.http).get('/api/billing/plans').expect(200)).body.ads).toMatchObject({ usdCentsPer1000Views: 100, minBudgetUsdCents: 200 });

  // Paid by MoMo (21 USD → RWF 30,450, rounded to the nearest 100: 30,500), then waits for review.
  const pay = (await biz.post(`/api/ads/campaigns/${camp.id}/pay`).set('Origin', WEB).send({ method: 'mtn_momo', phone: '0788000111' }).expect(201)).body.payment;
  expect(pay).toMatchObject({ amount: '30500', usdCents: 2100 });
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
  // A targeted campaign cannot serve or count impressions outside its selected placements.
  expect((await request(ctx.http).get(`/api/videos/${long.id}/ads`).expect(200)).body.slots).toEqual([]);
  expect((await request(ctx.http).post('/api/ads/impressions').set('Origin', WEB).send({ campaignId: camp.id, videoId: long.id }).expect(201)).body.impressionId).toBeNull();

  // Impressions count once per viewer, campaign and video; a click is counted once.
  const viewer = request.agent(ctx.http);
  const imp = (await viewer.post('/api/ads/impressions').set('Origin', WEB).send({ campaignId: camp.id, videoId: short.id }).expect(201)).body.impressionId;
  expect(imp).toBeTruthy();
  expect((await viewer.post('/api/ads/impressions').set('Origin', WEB).send({ campaignId: camp.id, videoId: short.id }).expect(201)).body.impressionId).toBeNull();
  await viewer.post(`/api/ads/impressions/${imp}/events`).set('Origin', WEB).send({ type: 'CLICK', ms: 3000 }).expect(200);
  await viewer.post(`/api/ads/impressions/${imp}/events`).set('Origin', WEB).send({ type: 'CLICK', ms: 3500 }).expect(200);
  expect((await biz.get('/api/ads/campaigns').expect(200)).body.campaigns[0]).toMatchObject({ status: 'ACTIVE', impressions: 1, clicks: 1 });

  const live = (await maker.get('/api/hub/monetisation/earn').expect(200)).body;
  expect(live).toMatchObject({ impressions: 1, activity: [{ campaignId: camp.id, videoId: short.id, impressions: 1 }] });

  // Settlement of a campaign priced per day (as before per-view pricing): yesterday it ran all day ($3); the
  // creator pool (60%) goes to the channel that showed it. Per-view settlement has its own test below.
  const DAY = 86_400_000;
  const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
  await ctx.prisma.campaign.update({ where: { id: camp.id }, data: { cpmRateCents: 0, deliverUntil: null, startDate: new Date(today.getTime() - DAY), endDate: new Date(today.getTime() + 6 * DAY) } });
  await ctx.prisma.adImpression.update({ where: { id: imp }, data: { createdAt: new Date(today.getTime() - DAY / 2) } });
  const billing = new Billing(ctx.prisma as never, ctx.config);
  expect(await billing.settleAds()).toBe(1);
  expect(await billing.settleAds()).toBe(0); // safe to run again
  const money = (await maker.get('/api/hub/monetisation').expect(200)).body;
  expect(money.balance).toMatchObject({ currency: 'USD', availableCents: 180, lifetimeCents: 180 });
  expect(money.earnings[0]).toMatchObject({ kind: 'AD_SHARE_PRE_ROLL', amountCents: 180 });

  // A reviewed wallet and confirmed quote are required before reserving earnings.
  const wallet = (await maker.put('/api/hub/monetisation/payout-account').set('Origin', WEB).send({ country: 'RW', phone: '0788555444', accountHolderName: 'Maker' }).expect(200)).body.account;
  await admin.post(`/api/admin/billing/payout-accounts/${wallet.id}`).set('Origin', WEB).send({ version: wallet.version, approve: true, note: 'Wallet ownership checked with creator.' }).expect(200);
  const quote = (await maker.get('/api/hub/monetisation/payout-quote').expect(200)).body.quote;
  const out = (await maker.post('/api/hub/monetisation/payouts').set('Origin', WEB).send({ quoteToken: quote.token }).expect(201)).body.payout;
  expect(out).toMatchObject({ amountCents: 180, account: '250788555444', status: 'REQUESTED', destinationAmount: '2610' });
  const retried = (await maker.post('/api/hub/monetisation/payouts').set('Origin', WEB).send({ quoteToken: quote.token }).expect(201)).body.payout;
  expect(retried.id).toBe(out.id);
  await admin.post(`/api/admin/billing/payouts/${out.id}`).set('Origin', WEB).send({ action: 'reject', reason: 'Creator requested a new payout.' }).expect(200);
  expect((await maker.get('/api/hub/monetisation').expect(200)).body.balance.availableCents).toBe(180);
  const next = (await maker.get('/api/hub/monetisation/payout-quote').expect(200)).body.quote;
  const again = (await maker.post('/api/hub/monetisation/payouts').set('Origin', WEB).send({ quoteToken: next.token }).expect(201)).body.payout;
  expect((await admin.post(`/api/admin/billing/payouts/${again.id}`).set('Origin', WEB).send({ action: 'paid', reference: 'MOMO-778899' }).expect(200)).body.payout).toMatchObject({ status: 'PAID', reference: 'MOMO-778899' });
  expect((await maker.get('/api/hub/monetisation')).body.balance).toMatchObject({ availableCents: 0, reservedCents: 0, paidCents: 180 });

});

test('ads priced per 1,000 views: a daily view cap, a budget that is never exceeded, and revenue that follows the views delivered', async () => {
  const DAY = 86_400_000;
  const maker = await creator('pace@example.com', 'pace');
  const makerUser = await ctx.prisma.user.findUniqueOrThrow({ where: { email: 'pace@example.com' } });
  await new Billing(ctx.prisma as never, ctx.config).grantPremium(makerUser.id, 1);
  await maker.post('/api/hub/monetisation/join').set('Origin', WEB).expect(200);
  const makerCh = await ctx.prisma.channel.findUniqueOrThrow({ where: { handle: 'pace' } });
  const videos = await Promise.all(Array.from({ length: 8 }, (_, i) => ctx.prisma.video.create({ data: { channelId: makerCh.id, title: `p${i}`, durationSeconds: 120, status: 'READY', visibility: 'PUBLIC', mediaLocation: 'PUBLIC', hlsMasterKey: 'hls/master.m3u8', publishedAt: new Date() } })));

  const biz = await creator('pacer@example.com', 'pacer');
  await new Billing(ctx.prisma as never, ctx.config).grantPremium((await ctx.prisma.user.findUniqueOrThrow({ where: { email: 'pacer@example.com' } })).id, 1);
  const shopCh = await ctx.prisma.channel.findUniqueOrThrow({ where: { handle: 'pacer' } });
  const adVideo = await ctx.prisma.video.create({ data: { channelId: shopCh.id, title: 'Ad', durationSeconds: 15, status: 'READY', visibility: 'UNLISTED', mediaLocation: 'PUBLIC', hlsMasterKey: 'hls/master.m3u8' } });
  const camp = (await biz.post('/api/ads/campaigns').set('Origin', WEB).send({ businessName: 'Pacer', country: 'RW', headline: 'Paced ad', destinationUrl: 'https://pacer.example.com', budgetUsdCents: 700, days: 2, videoId: adVideo.id }).expect(201)).body.campaign;
  // A high price per view keeps the numbers small: $6 buys 6 views, 3 a day.
  await ctx.prisma.campaign.update({ where: { id: camp.id }, data: { cpmRateCents: 100_000, budgetAmountCents: 600n } });
  const admin = (await signIn(ctx.http, ctx.mail, 'admin@example.com')).agent;
  await ctx.prisma.campaign.update({ where: { id: camp.id }, data: { status: 'PENDING_REVIEW' } }); // as if paid
  await admin.post(`/api/admin/billing/campaigns/${camp.id}/review`).set('Origin', WEB).send({ approve: true }).expect(200);
  const approved = await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: camp.id } });
  // Funds left after the 2 days keep being spent, here until 30 days after the start.
  expect(approved.deliverUntil!.getTime() - approved.startDate.getTime()).toBe(30 * DAY);

  const viewer = request.agent(ctx.http);
  const show = async (v: { id: string }) => (await viewer.post('/api/ads/impressions').set('Origin', WEB).send({ campaignId: camp.id, videoId: v.id }).expect(201)).body.impressionId as string | null;
  const shown: string[] = [];
  for (const v of videos.slice(0, 3)) shown.push((await show(v))!);
  expect(shown.every(Boolean)).toBe(true);
  // Today's 3 views are delivered: no more slots and no more counted views today.
  expect((await request(ctx.http).get(`/api/videos/${videos[3].id}/ads`).expect(200)).body.slots).toEqual([]);
  expect(await show(videos[3])).toBeNull();

  // The next day (the daily counter is gone): 3 more, then the budget is spent and nothing more is counted.
  await ctx.clearLimits();
  for (const v of videos.slice(3, 6)) shown.push((await show(v))!);
  expect(shown.filter(Boolean)).toHaveLength(6);
  await ctx.clearLimits();
  expect(await show(videos[6])).toBeNull();
  expect((await biz.get('/api/ads/campaigns').expect(200)).body.campaigns[0]).toMatchObject({ impressions: 6, viewsBought: 6, viewsPerDay: 3, spentCents: 600 });
  const billing = new Billing(ctx.prisma as never, ctx.config);
  await billing.expirePremium();
  expect((await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: camp.id } })).status).toBe('COMPLETED');

  // Settlement: 2 views two days ago ($2) and 4 views yesterday ($4); creators get 60% of each day.
  const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
  await ctx.prisma.campaign.update({ where: { id: camp.id }, data: { startDate: new Date(today.getTime() - 2 * DAY), endDate: today, deliverUntil: new Date(today.getTime() + 2 * DAY) } });
  for (const [i, id] of shown.entries()) await ctx.prisma.adImpression.update({ where: { id }, data: { createdAt: new Date(today.getTime() - (i < 2 ? 1.5 : 0.5) * DAY) } });
  expect(await billing.settleAds()).toBe(2);
  const days = await ctx.prisma.adDaySettlement.findMany({ orderBy: { day: 'asc' } });
  expect(days.map((d) => [Number(d.grossCents), Number(d.creatorPoolCents), d.impressions])).toEqual([[200, 120, 2], [400, 240, 4]]);
  expect((await maker.get('/api/hub/monetisation').expect(200)).body.balance).toMatchObject({ availableCents: 360, lifetimeCents: 360 });
});

test('ads priced per 1,000 views: undelivered budget remains a liability after the make-good period', async () => {
  const DAY = 86_400_000;
  const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
  const user = await ctx.prisma.user.create({ data: { email: 'left@example.com' } });
  const adv = await ctx.prisma.advertiser.create({ data: { userId: user.id, businessName: 'Leftover', country: 'RW', businessType: 'business', currency: 'USD' } });
  // $3 for 3,000 views; none delivered; its make-good period ended yesterday.
  await ctx.prisma.campaign.create({ data: { advertiserId: adv.id, name: 'x', headline: 'x', destinationUrl: 'https://x.example.com', currency: 'USD', days: 1, dailyRateCents: 300, cpmRateCents: 100, budgetAmountCents: 300n,
    status: 'COMPLETED', reviewedAt: new Date(today.getTime() - 3 * DAY), startDate: new Date(today.getTime() - 3 * DAY), endDate: new Date(today.getTime() - 2 * DAY), deliverUntil: new Date(today.getTime() - DAY / 2) } });
  const billing = new Billing(ctx.prisma as never, ctx.config);
  expect(await billing.settleAds()).toBe(3);
  const days = await ctx.prisma.adDaySettlement.findMany({ orderBy: { day: 'asc' } });
  expect(days.map((d) => Number(d.grossCents))).toEqual([0, 0, 0]);
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

test('audience support: opt-in, verified destination, payment replay and concurrent clearance preserve balances', async () => {
  const owner = await creator('support-maker@example.com', 'support-maker');
  const viewer = await creator('support-viewer@example.com', 'support-viewer');
  const admin = await signIn(ctx.http, ctx.mail, 'admin@example.com');
  const ch = await ctx.prisma.channel.findUniqueOrThrow({ where: { handle: 'support-maker' } });
  const body = { method: 'mtn_momo', phone: '0788123456', usdCents: 300, requestId: 'b177f509-f2ae-4b5d-bacd-7fba39d04ee1' };
  await viewer.post('/api/support/support-maker').set('Origin', WEB).send(body).expect(400);
  await owner.put('/api/support/support-maker').set('Origin', WEB).send({ enabled: true }).expect(400);
  await ctx.prisma.payoutAccount.create({ data: { channelId: ch.id, country: 'RW', provider: 'mtn_momo', accountIdentifier: '250788123456', accountHolderName: 'Creator Name', status: 'VERIFIED' } });
  await viewer.put('/api/support/support-maker').set('Origin', WEB).send({ enabled: true }).expect(404);
  await owner.put('/api/support/support-maker').set('Origin', WEB).send({ enabled: true }).expect(200);
  await owner.post('/api/support/support-maker').set('Origin', WEB).send(body).expect(400);
  const attempts = await Promise.all([1, 2].map(() => viewer.post('/api/support/support-maker').set('Origin', WEB).send(body).expect(201)));
  const pay = attempts[0].body.payment;
  expect(attempts[1].body.payment.id).toBe(pay.id);
  expect(momo.size).toBe(1);
  expect(await ctx.prisma.creatorBalance.findUnique({ where: { channelId: ch.id } })).toBeNull();
  await viewer.post('/api/support/support-maker').set('Origin', WEB).send({ ...body, usdCents: 500 }).expect(400);
  [...momo.values()][0].status = 'SUCCESSFUL';
  await Promise.all([1, 2].map(() => viewer.get(`/api/billing/payments/${pay.id}`).expect(200)));
  let balance = await ctx.prisma.creatorBalance.findUniqueOrThrow({ where: { channelId: ch.id } });
  expect(balance).toMatchObject({ pendingBalanceCents: 300n, confirmedBalanceCents: 0n, lifetimeEarningsCents: 300n });
  await owner.get('/api/hub/monetisation/payout-quote').expect(400);
  await viewer.post(`/api/admin/billing/support/${pay.id}/clear`).set('Origin', WEB).send({}).expect(403);
  await Promise.all([1, 2].map(() => admin.agent.post(`/api/admin/billing/support/${pay.id}/clear`).set('Origin', WEB).send({}).expect(201)));
  balance = await ctx.prisma.creatorBalance.findUniqueOrThrow({ where: { channelId: ch.id } });
  expect(balance).toMatchObject({ pendingBalanceCents: 0n, confirmedBalanceCents: 300n, lifetimeEarningsCents: 300n });
  expect(await ctx.prisma.revenueLedger.count({ where: { channelId: ch.id } })).toBe(2);
  await owner.get('/api/hub/monetisation/payout-quote').expect(200);
  expect((await owner.get('/api/me').expect(200)).body.premium.active).toBe(false);
  await owner.put('/api/support/support-maker').set('Origin', WEB).send({ enabled: false }).expect(200);
  expect((await viewer.post('/api/support/support-maker').set('Origin', WEB).send(body).expect(201)).body.payment.id).toBe(pay.id);
  await viewer.post('/api/support/support-maker').set('Origin', WEB).send({ ...body, requestId: '01b643e5-a67b-4d73-99a7-a39d813b5415' }).expect(400);
});

test('declined support never earns funds and changed payout details suspend new contributions', async () => {
  await creator('decline-maker@example.com', 'decline-maker');
  const viewer = await creator('decline-viewer@example.com', 'decline-viewer');
  const ch = await ctx.prisma.channel.update({ where: { handle: 'decline-maker' }, data: { supportEnabled: true } });
  await ctx.prisma.payoutAccount.create({ data: { channelId: ch.id, country: 'RW', provider: 'mtn_momo', accountIdentifier: '250788123456', accountHolderName: 'Creator Name', status: 'VERIFIED' } });
  const body = { method: 'mtn_momo', phone: '0788123456', usdCents: 100, requestId: '5d6b433f-ff12-43f0-bce7-65a65521aa14' };
  const pay = (await viewer.post('/api/support/decline-maker').set('Origin', WEB).send(body).expect(201)).body.payment;
  [...momo.values()][0].status = 'FAILED';
  expect((await viewer.get(`/api/billing/payments/${pay.id}`).expect(200)).body.payment.status).toBe('FAILED');
  expect(await ctx.prisma.creatorBalance.findUnique({ where: { channelId: ch.id } })).toBeNull();
  expect(await ctx.prisma.revenueLedger.count()).toBe(0);
  await ctx.prisma.payoutAccount.update({ where: { channelId: ch.id }, data: { status: 'PENDING', version: { increment: 1 } } });
  expect((await request(ctx.http).get('/api/support/decline-maker').expect(200)).body.enabled).toBe(false);
  await viewer.post('/api/support/decline-maker').set('Origin', WEB).send({ ...body, requestId: 'ce014238-8564-479d-8b42-f1d5f472b366' }).expect(400);
});


test('a lost collection response retains its provider reference and never starts a second prompt on retry', async () => {
  await creator('uncertain-maker@example.com', 'uncertain-maker');
  const viewer = await creator('uncertain-viewer@example.com', 'uncertain-viewer');
  const ch = await ctx.prisma.channel.update({ where: { handle: 'uncertain-maker' }, data: { supportEnabled: true } });
  await ctx.prisma.payoutAccount.create({ data: { channelId: ch.id, country: 'RW', provider: 'mtn_momo', accountIdentifier: '250788123456', accountHolderName: 'Creator Name', status: 'VERIFIED' } });
  dropMomoResponse = true;
  const body = { method: 'mtn_momo', phone: '0788123456', usdCents: 100, requestId: '8c0640f4-a131-4c46-b20a-0c445a023cc5' };
  const pay = (await viewer.post('/api/support/uncertain-maker').set('Origin', WEB).send(body).expect(201)).body.payment;
  expect(pay.status).toBe('PENDING');
  expect(pay.failureReason).toContain('Do not send another');
  const saved = await ctx.prisma.payment.findUniqueOrThrow({ where: { id: pay.id } });
  expect(momo.has(saved.providerRef)).toBe(true);
  expect((await viewer.post('/api/support/uncertain-maker').set('Origin', WEB).send(body).expect(201)).body.payment.id).toBe(pay.id);
  expect(momo.size).toBe(1);
  [...momo.values()][0].status = 'SUCCESSFUL';
  expect((await viewer.get(`/api/billing/payments/${pay.id}`).expect(200)).body.payment.status).toBe('SUCCEEDED');
  expect((await ctx.prisma.creatorBalance.findUniqueOrThrow({ where: { channelId: ch.id } })).pendingBalanceCents).toBe(100n);
});

test('Premium priced per country: the viewer\'s profile country sets the price shown and charged; administrators can change it', async () => {
  const rw = await creator('price-rw@example.com', 'pricerw');
  await ctx.prisma.profile.update({ where: { userId: (await ctx.prisma.user.findUniqueOrThrow({ where: { email: 'price-rw@example.com' } })).id }, data: { country: 'RW' } });
  const admin = (await signIn(ctx.http, ctx.mail, 'admin@example.com')).agent;
  ctx.app.get(BillingService).invalidate(); // prices saved by an earlier test are cached for 15 s
  // By default Rwanda pays about RWF 6,000 (414 US cents); elsewhere the standard $10.
  expect((await rw.get('/api/billing/plans').expect(200)).body.premium).toMatchObject({ usdCents: 414, standardUsdCents: 1000, country: 'RW' });
  await admin.put('/api/admin/billing/settings').set('Origin', WEB).send({ prices: { premiumByCountry: 'RW=bad' } }).expect(400);
  await admin.put('/api/admin/billing/settings').set('Origin', WEB).send({ prices: { premiumByCountry: 'rw=300, KE=500' } }).expect(200);
  expect((await admin.get('/api/admin/billing/settings').expect(200)).body.prices.premiumByCountry).toEqual({ RW: 300, KE: 500 });
  ctx.app.get(BillingService).invalidate();
  expect((await rw.get('/api/billing/plans').expect(200)).body.premium).toMatchObject({ usdCents: 300, standardUsdCents: 1000, country: 'RW' });
  expect((await request(ctx.http).get('/api/billing/plans').expect(200)).body.premium.usdCents).toBe(1000); // visitors
  const pay = (await rw.post('/api/billing/premium').set('Origin', WEB).send({ method: 'mtn_momo', phone: '0788000222', months: 3 }).expect(201)).body.payment;
  expect(pay).toMatchObject({ usdCents: 900, amount: '13100' }); // RWF 13,050 rounded to the nearest 100
});

test('Creator pass: free uploads, then the pass (paid, given or with Premium); videos stay; badges tell Premium from verified', async () => {
  const maker = await creator('passmaker@example.com', 'passmaker');
  // An account older than a week (new accounts also have a daily upload limit, tested elsewhere).
  const makerUser = await ctx.prisma.user.update({ where: { email: 'passmaker@example.com' }, data: { createdAt: new Date(Date.now() - 30 * 86_400_000) } });
  const admin = (await signIn(ctx.http, ctx.mail, 'admin@example.com')).agent;
  ctx.app.get(BillingService).invalidate();
  await admin.put('/api/admin/billing/settings').set('Origin', WEB).send({ prices: { creatorFreeVideos: 'x' } }).expect(400);
  await admin.put('/api/admin/billing/settings').set('Origin', WEB).send({ prices: { creatorFreeVideos: 2, creatorPassUsdCents: 200 } }).expect(200);
  const start = () => maker.post('/api/uploads').set('Origin', WEB).send({ fileName: 'clip.mp4', sizeBytes: 1000 });

  expect((await maker.get('/api/billing/creator-pass').expect(200)).body).toMatchObject({ canUpload: true, freeVideos: 2, freeLeft: 2, usdCents: 200, pass: { active: false } });
  const first = (await start().expect(201)).body.videoId;
  await start().expect(201);
  // Deleting a draft does not give a free upload back.
  await maker.delete(`/api/uploads/${first}`).set('Origin', WEB).send({}).expect(200);
  const refused = (await start().expect(402)).body;
  expect(refused).toMatchObject({ code: 'CREATOR_PASS_REQUIRED', message: expect.stringContaining('Creator pass ($2 a year)') });
  expect((await maker.get('/api/billing/creator-pass').expect(200)).body).toMatchObject({ canUpload: false, freeLeft: 0, uploads: 2 });

  // Paid by MoMo, a year at a time: $2 (RWF 2,900).
  await maker.post('/api/billing/creator-pass').set('Origin', WEB).send({ method: 'mtn_momo', phone: '0788000333', months: 3 }).expect(400);
  const pay = (await maker.post('/api/billing/creator-pass').set('Origin', WEB).send({ method: 'mtn_momo', phone: '0788000333', months: 12 }).expect(201)).body.payment;
  expect(pay).toMatchObject({ usdCents: 200, amount: String(2 * 1450), months: 12 });
  [...momo.values()].at(-1)!.status = 'SUCCESSFUL';
  await maker.get(`/api/billing/payments/${pay.id}`).expect(200);
  const status = (await maker.get('/api/billing/creator-pass').expect(200)).body;
  expect(status).toMatchObject({ canUpload: true, pass: { active: true, includedWithPremium: false } });
  expect(new Date(status.pass.until).getTime()).toBeGreaterThan(Date.now() + 359 * 86_400_000);
  await start().expect(201);

  // When the pass ends, new uploads stop; an administrator can give it (creators invited at launch).
  await ctx.prisma.user.update({ where: { id: makerUser.id }, data: { creatorPassUntil: new Date(Date.now() - 1000) } });
  await start().expect(402);
  await admin.post('/api/admin/billing/creator-pass').set('Origin', WEB).send({ email: 'passmaker@example.com', months: 1 }).expect(200);
  await start().expect(201);

  // Premium includes the pass, and its badge says Premium; a Space checked by Free Me says verified.
  await ctx.prisma.user.update({ where: { id: makerUser.id }, data: { creatorPassUntil: null } });
  await new Billing(ctx.prisma as never, ctx.config).grantPremium(makerUser.id, 1);
  expect((await maker.get('/api/billing/creator-pass').expect(200)).body.pass).toMatchObject({ active: true, includedWithPremium: true });
  await start().expect(201);
  expect((await request(ctx.http).get('/api/channels/passmaker').expect(200)).body.channel).toMatchObject({ isVerified: true, badge: 'premium' });
  await ctx.prisma.channel.update({ where: { handle: 'passmaker' }, data: { verificationSource: 'ADMIN' } });
  expect((await request(ctx.http).get('/api/channels/passmaker').expect(200)).body.channel.badge).toBe('verified');
});

test('ad funds start at $2; a business is checked, then pays for the Verified badge, which protects its name for a year', async () => {
  const biz = await creator('bank@example.com', 'bankrw');
  const ch = await ctx.prisma.channel.findUniqueOrThrow({ where: { handle: 'bankrw' } });
  const adVideo = await ctx.prisma.video.create({ data: { channelId: ch.id, title: 'Ad', durationSeconds: 15, status: 'READY', visibility: 'UNLISTED', mediaLocation: 'PUBLIC', hlsMasterKey: 'hls/master.m3u8', isAd: true } });
  const ad = { businessName: 'Bank RW', country: 'RW', headline: 'Open an account', destinationUrl: 'https://bank.example.com', videoId: adVideo.id };
  ctx.app.get(BillingService).invalidate();
  expect((await biz.post('/api/ads/campaigns').set('Origin', WEB).send({ ...ad, budgetUsdCents: 199 }).expect(400)).body.message).toBe('Add at least $2 of funds.');
  expect((await biz.post('/api/ads/campaigns').set('Origin', WEB).send({ ...ad, budgetUsdCents: 700 }).expect(201)).body.campaign).toMatchObject({ totalCents: 700, viewsBought: 7000, days: 7, viewsPerDay: 1000 });

  // Creators see the current revenue policy before joining.
  expect((await biz.get('/api/hub/monetisation').expect(200)).body.programme).toMatchObject({ creatorShareBps: 7000, momentsCreatorShareBps: 6000 });

  // Verification: request (free), review, then pay.
  expect((await biz.get('/api/ads/verification').expect(200)).body).toMatchObject({ priceUsdCents: 1000, request: null });
  await biz.post('/api/ads/verification/pay').set('Origin', WEB).send({ method: 'mtn_momo', phone: '0788000444' }).expect(400); // not checked yet
  const details = { businessName: 'Bank of Rwanda Ltd', registrationNumber: '100123456', phone: '0788000444', website: 'https://bank.example.com' };
  expect((await biz.post('/api/ads/verification').set('Origin', WEB).send(details).expect(201)).body.request).toMatchObject({ status: 'PENDING', businessName: 'Bank of Rwanda Ltd' });
  await biz.post('/api/ads/verification').set('Origin', WEB).send(details).expect(400); // already waiting
  const admin = (await signIn(ctx.http, ctx.mail, 'admin@example.com')).agent;
  const queue = (await admin.get('/api/admin/billing/verifications').expect(200)).body.requests;
  expect(queue).toEqual([expect.objectContaining({ businessName: 'Bank of Rwanda Ltd', channel: expect.objectContaining({ handle: 'bankrw', email: 'bank@example.com' }) })]);
  await admin.post(`/api/admin/billing/verifications/${queue[0].id}`).set('Origin', WEB).send({ approve: false }).expect(400); // a rejection needs a reason
  await admin.post(`/api/admin/billing/verifications/${queue[0].id}`).set('Origin', WEB).send({ approve: true }).expect(200);

  const pay = (await biz.post('/api/ads/verification/pay').set('Origin', WEB).send({ method: 'mtn_momo', phone: '0788000444' }).expect(201)).body.payment;
  expect(pay).toMatchObject({ purpose: 'VERIFICATION', usdCents: 1000, amount: '14500' });
  [...momo.values()].at(-1)!.status = 'SUCCESSFUL';
  await biz.get(`/api/billing/payments/${pay.id}`).expect(200);
  const v = (await biz.get('/api/ads/verification').expect(200)).body.request;
  expect(v.status).toBe('ACTIVE');
  expect(new Date(v.verifiedUntil).getTime()).toBeGreaterThan(Date.now() + 359 * 86_400_000);
  expect((await request(ctx.http).get('/api/channels/bankrw').expect(200)).body.channel).toMatchObject({ isVerified: true, badge: 'verified' });

  // Its name is protected: nobody else can take it, and it can only be changed through Free Me.
  await ctx.prisma.channel.update({ where: { handle: 'bankrw' }, data: { name: 'Bank of Rwanda Ltd' } });
  expect((await biz.patch('/api/channels/mine').set('Origin', WEB).send({ name: 'Another Name' }).expect(400)).body.message).toContain('verified under this name');
  const copycat = (await signIn(ctx.http, ctx.mail, 'copycat@example.com')).agent;
  expect((await copycat.post('/api/channels').set('Origin', WEB).send({ handle: 'fakebank', name: 'bank of rwanda ltd' }).expect(409)).body.message).toContain('belongs to a verified Space');

  // A year later the badge goes (the check stays valid, so renewing needs no new review).
  await ctx.prisma.businessVerification.updateMany({ data: { verifiedUntil: new Date(Date.now() - 1000) } });
  await new Billing(ctx.prisma as never, ctx.config).expirePremium();
  expect((await ctx.prisma.businessVerification.findFirstOrThrow()).status).toBe('APPROVED');
  expect((await request(ctx.http).get('/api/channels/bankrw').expect(200)).body.channel).toMatchObject({ isVerified: false, badge: null });
});

test('Add funds to a paid ad: more views at the same pace, over more days; a finished ad runs again', async () => {
  const biz = await creator('topup@example.com', 'topup');
  const ch = await ctx.prisma.channel.findUniqueOrThrow({ where: { handle: 'topup' } });
  const adVideo = await ctx.prisma.video.create({ data: { channelId: ch.id, title: 'Ad', durationSeconds: 15, status: 'READY', visibility: 'UNLISTED', mediaLocation: 'PUBLIC', hlsMasterKey: 'hls/master.m3u8', isAd: true } });
  ctx.app.get(BillingService).invalidate();
  const created = (await biz.post('/api/ads/campaigns').set('Origin', WEB).send({ businessName: 'Top Up Ltd', country: 'RW', headline: 'More views', destinationUrl: 'https://topup.example.com', videoId: adVideo.id, budgetUsdCents: 700 }).expect(201)).body.campaign;
  const pay = { method: 'mtn_momo', phone: '0788000555' };
  // Funds are added to a paid ad; a draft is paid first.
  expect((await biz.post(`/api/ads/campaigns/${created.id}/funds`).set('Origin', WEB).send({ ...pay, usdCents: 1400 }).expect(400)).body.message).toContain('Pay for this ad first');
  const first = (await biz.post(`/api/ads/campaigns/${created.id}/pay`).set('Origin', WEB).send(pay).expect(201)).body.payment;
  [...momo.values()].at(-1)!.status = 'SUCCESSFUL';
  await biz.get(`/api/billing/payments/${first.id}`).expect(200);
  const admin = (await signIn(ctx.http, ctx.mail, 'admin@example.com')).agent;
  await admin.post(`/api/admin/billing/campaigns/${created.id}/review`).set("Origin", WEB).send({ approve: true }).expect(200);
  const before = await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: created.id } });

  expect((await biz.post(`/api/ads/campaigns/${created.id}/funds`).set('Origin', WEB).send({ ...pay, usdCents: 199 }).expect(400)).body.message).toBe('Add at least $2.');
  const more = (await biz.post(`/api/ads/campaigns/${created.id}/funds`).set('Origin', WEB).send({ ...pay, usdCents: 1400 }).expect(200)).body.payment;
  expect(more).toMatchObject({ purpose: 'AD_CAMPAIGN', usdCents: 1400 });
  // Nothing changes until the payment succeeds.
  expect(Number((await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: created.id } })).budgetAmountCents)).toBe(700);
  [...momo.values()].at(-1)!.status = 'SUCCESSFUL';
  await biz.get(`/api/billing/payments/${more.id}`).expect(200);
  await biz.get(`/api/billing/payments/${more.id}`).expect(200); // checked twice, added once
  const view = (await biz.get('/api/ads/campaigns').expect(200)).body.campaigns.find((c: { id: string }) => c.id === created.id);
  expect(view).toMatchObject({ status: 'ACTIVE', totalCents: 2100, days: 21, viewsBought: 21_000, viewsPerDay: 1000 });
  const after = await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: created.id } });
  expect(after.endDate.getTime() - before.endDate.getTime()).toBe(14 * 86_400_000);
  expect(after.deliverUntil!.getTime()).toBeGreaterThan(after.endDate.getTime());

  // A finished ad starts again when funds are added.
  await ctx.prisma.campaign.update({ where: { id: created.id }, data: { status: 'COMPLETED', endDate: new Date(Date.now() - 86_400_000), deliverUntil: new Date(Date.now() - 1000) } });
  const again = (await biz.post(`/api/ads/campaigns/${created.id}/funds`).set('Origin', WEB).send({ ...pay, usdCents: 700 }).expect(200)).body.payment;
  [...momo.values()].at(-1)!.status = 'SUCCESSFUL';
  await biz.get(`/api/billing/payments/${again.id}`).expect(200);
  const restarted = await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: created.id } });
  expect(restarted).toMatchObject({ status: 'ACTIVE', budgetAmountCents: 2800n, days: 28 });
  expect(restarted.endDate.getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
  expect(restarted.deliverUntil!.getTime()).toBeGreaterThan(restarted.endDate.getTime());
});

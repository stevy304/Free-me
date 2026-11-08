import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeApp, resetDb, signIn, WEB } from './helpers';
import { Billing } from '../src/billing/billing';
import { sendDueMail } from '../src/mail/outbox';

// Ad Studio: ad videos are a Premium upload, kept apart from the Space's videos and out of every public list.
const dir = mkdtempSync(join(tmpdir(), 'freeme-adstudio-'));
let ctx: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => { ctx = await makeApp({ redis: false, storageDir: join(dir, 'storage'), adminEmails: ['admin@example.com'] }); }, 60_000);
beforeEach(async () => { await resetDb(ctx.prisma); ctx.mail.outbox.length = 0; await ctx.clearLimits(); });
afterAll(async () => { await ctx.app.close(); rmSync(dir, { recursive: true, force: true }); });

test('an ad video needs Premium, starts unlisted, lives only in Ad Studio and can never be made public', async () => {
  const shop = await signIn(ctx.http, ctx.mail, 'shop@example.com');
  await shop.agent.post('/api/channels').set('Origin', WEB).send({ handle: 'shop', name: 'Shop' }).expect(201);

  await shop.agent.post('/api/uploads').set('Origin', WEB).send({ fileName: 'ad.mp4', sizeBytes: 1000, ad: true }).expect(403);
  await ctx.prisma.user.update({ where: { email: 'shop@example.com' }, data: { premiumUntil: new Date(Date.now() + 86_400_000) } });

  const ad = (await shop.agent.post('/api/uploads').set('Origin', WEB).send({ fileName: 'Summer sale.mp4', sizeBytes: 1000, ad: true }).expect(201)).body;
  const normal = (await shop.agent.post('/api/uploads').set('Origin', WEB).send({ fileName: 'vlog.mp4', sizeBytes: 1000 }).expect(201)).body;
  expect(await ctx.prisma.video.findUnique({ where: { id: ad.videoId }, select: { isAd: true, visibility: true } })).toEqual({ isAd: true, visibility: 'UNLISTED' });

  const space = (await shop.agent.get('/api/hub/videos').expect(200)).body.videos.map((v: { id: string }) => v.id);
  const ads = (await shop.agent.get('/api/hub/videos?ads=true').expect(200)).body.videos;
  expect(space).toEqual([normal.videoId]);
  expect(ads.map((v: { id: string; isAd: boolean }) => [v.id, v.isAd])).toEqual([[ad.videoId, true]]);

  await shop.agent.patch(`/api/hub/videos/${ad.videoId}`).set('Origin', WEB).send({ visibility: 'PUBLIC' }).expect(400);
  await shop.agent.patch(`/api/hub/videos/${ad.videoId}`).set('Origin', WEB).send({ title: 'Summer sale, 20% off' }).expect(200);

  // Even if it were marked public and ready, no public list shows an ad.
  await ctx.prisma.video.update({ where: { id: ad.videoId }, data: { visibility: 'PUBLIC', status: 'READY', publishedAt: new Date(), durationSeconds: 15 } });
  const feed = (await shop.agent.get('/api/videos').expect(200)).body;
  expect(JSON.stringify(feed)).not.toContain(ad.videoId);
});

test('before payments are switched on, an administrator approves an ad without payment: it plays, and counts no revenue', async () => {
  const shop = await signIn(ctx.http, ctx.mail, 'shop@example.com');
  const shopCh = (await shop.agent.post('/api/channels').set('Origin', WEB).send({ handle: 'shop', name: 'Shop' }).expect(201)).body.channel;
  await ctx.prisma.user.update({ where: { email: 'shop@example.com' }, data: { premiumUntil: new Date(Date.now() + 86_400_000) } });
  const ad = await ctx.prisma.video.create({ data: { channelId: shopCh.id, title: 'Summer sale', isAd: true, durationSeconds: 15, status: 'READY', visibility: 'UNLISTED', mediaLocation: 'PUBLIC', hlsMasterKey: 'hls/master.m3u8', publishedAt: new Date() } });
  await ctx.prisma.channel.update({ where: { id: shopCh.id }, data: { isVerified: true } });
  const camp = (await shop.agent.post('/api/ads/campaigns').set('Origin', WEB).send({ businessName: 'Shop', registrationNumber: 'RW-123456', country: 'RW', headline: 'Summer sale', destinationUrl: 'https://shop.example.com', videoId: ad.id, days: 3, targetCountries: [] }).expect(201)).body.campaign;
  const pdf = Buffer.from('%PDF-1.7\n%%EOF');
  await shop.agent.post(`/api/ads/campaigns/${camp.id}/business-certificate`).set('Origin', WEB)
    .attach('certificate', pdf, { filename: 'rdb.pdf', contentType: 'application/pdf' }).expect(201);
  await shop.agent.get(`/api/admin/billing/campaigns/${camp.id}/business-certificate`).expect(403);
  expect(camp.status).toBe('DRAFT');

  // A creator in the monetisation programme, with a video.
  const maker = await signIn(ctx.http, ctx.mail, 'maker@example.com');
  const makerCh = (await maker.agent.post('/api/channels').set('Origin', WEB).send({ handle: 'maker', name: 'Maker' }).expect(201)).body.channel;
  await ctx.prisma.user.update({ where: { email: 'maker@example.com' }, data: { premiumUntil: new Date(Date.now() + 86_400_000) } });
  await ctx.prisma.creatorEligibility.create({ data: { channelId: makerCh.id, isEligible: true } });
  const v = await ctx.prisma.video.create({ data: { channelId: makerCh.id, title: 'Hills', durationSeconds: 480, status: 'READY', visibility: 'PUBLIC', mediaLocation: 'PUBLIC', hlsMasterKey: 'hls/master.m3u8', publishedAt: new Date() } });
  expect((await maker.agent.get(`/api/videos/${v.id}/ads`).expect(200)).body.slots).toEqual([]); // not approved yet

  const admin = (await signIn(ctx.http, ctx.mail, 'admin@example.com')).agent;
  await admin.get(`/api/admin/billing/campaigns/${camp.id}/business-certificate`).expect('Content-Type', /application\/pdf/).expect(200);
  await shop.agent.post(`/api/admin/billing/campaigns/${camp.id}/review`).set('Origin', WEB).send({ approve: true, free: true }).expect(403);
  await admin.post(`/api/admin/billing/campaigns/${camp.id}/review`).set('Origin', WEB).send({ approve: true }).expect(400); // unpaid: only "without payment"
  expect((await admin.get('/api/admin/billing/campaigns?status=DRAFT').expect(200)).body.campaigns.map((c: any) => c.id)).toEqual([camp.id]);
  await admin.post(`/api/admin/billing/campaigns/${camp.id}/review`).set('Origin', WEB).send({ approve: true, free: true, verifyBusiness: true }).expect(200);
  await Promise.all([sendDueMail(ctx.prisma, ctx.mail, WEB), sendDueMail(ctx.prisma, ctx.mail, WEB)]);
  expect(ctx.mail.outbox.filter((mail) => mail.subject === 'Your ad campaign is approved')).toHaveLength(1);
  const row = await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: camp.id } });
  expect(row).toMatchObject({ status: 'ACTIVE', dailyRateCents: 0, days: 3, reviewNote: 'Approved without payment by Free Me' });

  const slots = (await maker.agent.get(`/api/videos/${v.id}/ads`).expect(200)).body.slots;
  expect(slots).toEqual([expect.objectContaining({ at: 240, ad: expect.objectContaining({ campaignId: camp.id, headline: 'Summer sale' }) })]);
  await admin.post(`/api/admin/billing/campaigns/${camp.id}/review`).set('Origin', WEB).send({ approve: true, free: true }).expect(400); // already running

  // The day it ran is settled with $0: creators are not paid for money that never came in.
  await ctx.prisma.campaign.update({ where: { id: camp.id }, data: { startDate: new Date(Date.now() - 2 * 86_400_000) } });
  await new Billing(ctx.prisma as never, ctx.config).settleAds();
  const days = await ctx.prisma.adDaySettlement.findMany();
  expect(days.length).toBeGreaterThan(0);
  expect(days.every((d) => d.grossCents === 0n && d.creatorPoolCents === 0n)).toBe(true);
});

import { adRevenuePolicy } from '@free-me/shared';
import request from 'supertest';
import { makeApp, resetDb, signIn, WEB } from './helpers';
import { Billing } from '../src/billing/billing';

// Earning like on YouTube (MONETISATION.md): joining needs followers and either watch hours or Moments views; ads also
// play between Moments, and 45% of their money is shared by monetised creators' Moments views.
let ctx: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => { ctx = await makeApp({ env: { MONETISE_MIN_FOLLOWERS: '2', MONETISE_MIN_WATCH_HOURS: '100', MONETISE_MIN_MOMENT_VIEWS: '50' } }); });
beforeEach(async () => { await resetDb(ctx.prisma); ctx.mail.outbox.length = 0; await ctx.clearLimits(); });
afterAll(async () => { await ctx.app.close(); });

const DAY = 86_400_000;
const today = () => new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
const PREMIUM = () => new Date(Date.now() + 30 * DAY);

async function space(email: string, handle: string, premium = true) {
  const c = await signIn(ctx.http, ctx.mail, email);
  const ch = (await c.agent.post('/api/channels').set('Origin', WEB).send({ handle, name: handle }).expect(201)).body.channel;
  if (premium) await ctx.prisma.user.update({ where: { email }, data: { premiumUntil: PREMIUM() } });
  return { agent: c.agent, channelId: ch.id as string };
}
const video = (channelId: string, data: object = {}) => ctx.prisma.video.create({ data: {
  channelId, title: 'A video', durationSeconds: 30, status: 'READY', visibility: 'PUBLIC', mediaLocation: 'PUBLIC', publishedAt: new Date(), safetyCheckedAt: new Date(),
  hlsMasterKey: 'hls/master.m3u8', ...data } });

test('joining needs the followers and either the watch hours (12 months) or the Moments views (90 days)', async () => {
  const s = await space('maker@example.com', 'maker');
  const m = await video(s.channelId, { isShort: true });
  const fail = (await s.agent.post('/api/hub/monetisation/join').set('Origin', WEB).send({}).expect(403)).body.message;
  expect(fail).toBe('To join, a Space needs 100 watch hours in the last 12 months (you have 0) or 50 Moments views in the last 90 days (you have 0) and 2 followers (you have 0).');

  await ctx.prisma.channel.update({ where: { id: s.channelId }, data: { subscriberCount: 2 } });
  // 60 Moments views 10 days ago: enough without any watch hours.
  await ctx.prisma.videoDailyStat.create({ data: { videoId: m.id, day: new Date(today().getTime() - 10 * DAY), views: 60, watchSeconds: 600 } });
  const status = (await s.agent.get('/api/hub/monetisation').expect(200)).body.audience;
  expect(status).toMatchObject({ momentViews90: 60, required: { followers: 2, watchHours: 100, momentViews: 50 }, meetsRequirements: true });
  await s.agent.post('/api/hub/monetisation/join').set('Origin', WEB).send({}).expect(200);
  expect((await ctx.prisma.creatorEligibility.findUniqueOrThrow({ where: { channelId: s.channelId } })).isEligible).toBe(true);

  // Moments views older than 90 days do not count.
  const other = await space('old@example.com', 'old');
  await ctx.prisma.channel.update({ where: { id: other.channelId }, data: { subscriberCount: 5 } });
  const om = await video(other.channelId, { isShort: true });
  await ctx.prisma.videoDailyStat.create({ data: { videoId: om.id, day: new Date(today().getTime() - 120 * DAY), views: 500, watchSeconds: 0 } });
  await other.agent.post('/api/hub/monetisation/join').set('Origin', WEB).send({}).expect(403);
});

test('ads between Moments: served and counted on any public Moment; the day\'s Moments pool goes to monetised Premium creators by Moments views', async () => {
  const rich = await space('rich@example.com', 'rich');          // monetised, Premium: paid
  const lapsed = await space('lapsed@example.com', 'lapsed', false); // monetised, no Premium: not paid
  const fresh = await space('fresh@example.com', 'fresh');       // Premium, not monetised: not paid
  for (const s of [rich, lapsed]) await ctx.prisma.creatorEligibility.create({ data: { channelId: s.channelId, isEligible: true, appliedForMonetization: true, approvedAt: new Date() } });
  const [rm, lm, fm] = await Promise.all([rich, lapsed, fresh].map((s) => video(s.channelId, { isShort: true })));
  const long = await video(rich.channelId, { durationSeconds: 600 });

  // A business's ad, $3 a day for a week, not aimed at particular videos; and one aimed at a Space (never between Moments).
  const user = await ctx.prisma.user.create({ data: { email: 'shop@example.com' } });
  const adv = await ctx.prisma.advertiser.create({ data: { userId: user.id, businessName: 'Kigali Shop', country: 'RW', businessType: 'business', currency: 'USD' } });
  const adClip = await video((await space('shopspace@example.com', 'shopspace', false)).channelId, { isAd: true, durationSeconds: 15 });
  const start = new Date(today().getTime() - DAY);
  const camp = await ctx.prisma.campaign.create({ data: { advertiserId: adv.id, name: 'c', headline: 'Fresh coffee', destinationUrl: 'https://shop.example.com', currency: 'USD', days: 7, dailyRateCents: 300, cpmRateCents: 0,
    budgetAmountCents: 2100n, status: 'ACTIVE', reviewedAt: start, startDate: start, endDate: new Date(start.getTime() + 7 * DAY), videoId: adClip.id, targetCountries: [], targetVideoIds: [], targetChannelIds: [] } });
  await ctx.prisma.campaign.create({ data: { advertiserId: adv.id, name: 't', headline: 'Targeted', destinationUrl: 'https://shop.example.com', currency: 'USD', days: 7, dailyRateCents: 300, cpmRateCents: 0,
    budgetAmountCents: 2100n, status: 'ACTIVE', reviewedAt: start, startDate: start, endDate: new Date(start.getTime() + 7 * DAY), videoId: adClip.id, targetCountries: [], targetVideoIds: [], targetChannelIds: [rich.channelId] } });

  for (let i = 0; i < 5; i++) {
    const ad = (await request(ctx.http).get('/api/moments/ads').expect(200)).body.ad;
    expect(ad).toMatchObject({ campaignId: camp.id, businessName: 'Kigali Shop', headline: 'Fresh coffee', playbackUrl: expect.stringContaining(`${adClip.id}/hls/master.m3u8`) });
  }

  // Counted after any public Moment (even of a Space that does not earn), once per viewer and campaign every 30 minutes.
  const viewers = await Promise.all(['v1', 'v2', 'v3'].map(async (n) => (await signIn(ctx.http, ctx.mail, `${n}@example.com`)).agent));
  const imps: string[] = [];
  for (const [i, v] of viewers.entries()) {
    const id = (await v.post('/api/ads/impressions').set('Origin', WEB).send({ campaignId: camp.id, videoId: [fm, lm, rm][i].id, placement: 'MOMENTS' }).expect(201)).body.impressionId;
    expect(id).toBeTruthy(); imps.push(id);
  }
  expect((await viewers[0].post('/api/ads/impressions').set('Origin', WEB).send({ campaignId: camp.id, videoId: rm.id, placement: 'MOMENTS' }).expect(201)).body.impressionId).toBeNull();
  // "Between Moments" must be next to a Moment; a long video's ads go through its creator's share.
  expect((await request(ctx.http).post('/api/ads/impressions').set('Origin', WEB).send({ campaignId: camp.id, videoId: long.id, placement: 'MOMENTS' }).expect(201)).body.impressionId).toBeNull();
  const pre = (await viewers[0].post('/api/ads/impressions').set('Origin', WEB).send({ campaignId: camp.id, videoId: long.id }).expect(201)).body.impressionId;
  expect(pre).toBeTruthy();
  expect(await ctx.prisma.adImpression.count({ where: { placement: 'MOMENTS' } })).toBe(3);

  // Both legacy campaigns earn $3 for their day, but only the first delivered ads: 3 Moments, 1 long.
  // Its 300 cents splits 225 Moments / 75 long. The other campaign's creator pool remains unallocated;
  // its funds must not inflate earnings of creators who never hosted that campaign.
  const noon = new Date(today().getTime() - DAY / 2);
  await ctx.prisma.adImpression.updateMany({ data: { createdAt: noon } });
  const yesterday = new Date(today().getTime() - DAY);
  await ctx.prisma.videoDailyStat.createMany({ data: [
    { videoId: rm.id, day: yesterday, views: 300, watchSeconds: 3000 },
    { videoId: lm.id, day: yesterday, views: 100, watchSeconds: 1000 }, // monetised but not Premium: no share
    { videoId: fm.id, day: yesterday, views: 900, watchSeconds: 9000 }, // not monetised: no share
  ] });
  const billing = new Billing(ctx.prisma as never, ctx.config);
  await billing.settleAds();
  const day = await ctx.prisma.adDaySettlement.findUniqueOrThrow({ where: { day: yesterday } });
  const policy = adRevenuePolicy(yesterday);
  const momentsPool = 225n * BigInt(policy.momentsCreatorBps) / 10000n;
  const longPaid = 75n * BigInt(policy.split.creatorPoolBps) / 10000n;
  const longUnallocated = 300n * BigInt(policy.split.creatorPoolBps) / 10000n;
  expect(day).toMatchObject({ grossCents: 600n, momentsGrossCents: 225n, momentsPoolCents: momentsPool, momentsAllocatedCents: momentsPool, creatorPoolCents: longPaid + longUnallocated, allocatedCents: longPaid });
  const ledger = await ctx.prisma.revenueLedger.findMany({ where: { channelId: rich.channelId }, orderBy: { sourceType: 'asc' } });
  expect(ledger.map((l) => [l.sourceType, Number(l.creatorShareCents)])).toEqual([['AD_SHARE_MOMENTS', Number(momentsPool)], ['AD_SHARE_PRE_ROLL', Number(longPaid)]]);
  expect(ledger[0].description).toBe(`Moments ad earnings for ${yesterday.toISOString().slice(0, 10)} (300 Moments views)`);
  expect(await ctx.prisma.revenueLedger.count({ where: { channelId: { in: [lapsed.channelId, fresh.channelId] } } })).toBe(0);
});

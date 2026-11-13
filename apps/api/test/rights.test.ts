import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { makeApp, resetDb, signIn, WEB } from './helpers';
import { Billing } from '../src/billing/billing';

// Content ID through real uploads (RIGHTS.md): a copy of a published video is blocked and its uploader reads why; a
// dispute, then the owner's release, publishes it; a verified rights holder can let copies through and earn from them.
const dir = mkdtempSync(join(tmpdir(), 'freeme-rights-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const ff = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
const tune = 'sin(2*PI*t*(330+220*sin(2*PI*t/3)+110*sin(2*PI*t/7)))*0.6';
const original = join(dir, 'original.mp4');
const copy = join(dir, 'copy.mp4');
const own = join(dir, 'own.mp4');

let ctx: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => {
  ff(['-f', 'lavfi', '-i', 'mandelbrot=size=640x360:rate=25:end_scale=0.01', '-f', 'lavfi', '-i', `aevalsrc=${tune}:s=44100:d=20`, '-t', '20', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', original]);
  // The copy: smaller and lower quality, the first 2.4 s cut.
  ff(['-ss', '2.4', '-i', original, '-vf', 'scale=480:270', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '34', '-c:a', 'aac', '-b:a', '64k', copy]);
  ff(['-f', 'lavfi', '-i', 'life=size=320x180:rate=25:mold=10:ratio=0.4', '-f', 'lavfi', '-i', 'aevalsrc=sin(2*PI*t*(600+300*sin(2*PI*t/5)))*0.5:s=44100', '-t', '16', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', own]);
  ctx = await makeApp({ redis: false, storageDir: join(dir, 'storage'), adminEmails: ['admin@example.com'], env: { SAFETY_UNSCANNED_REVIEW: 'none' } });
}, 120_000);
beforeEach(async () => { await resetDb(ctx.prisma); ctx.mail.outbox.length = 0; await ctx.clearLimits(); });
afterAll(async () => { await ctx.app.close(); });

async function creator(handle: string) {
  const c = await signIn(ctx.http, ctx.mail, `${handle}@example.com`);
  await c.agent.post('/api/channels').set('Origin', WEB).send({ handle, name: handle }).expect(201);
  return c.agent;
}
async function upload(agent: any, file: string, title: string) {
  const data = readFileSync(file);
  const start = (await agent.post('/api/uploads').set('Origin', WEB).send({ fileName: 'v.mp4', sizeBytes: data.length }).expect(201)).body;
  const urls = (await agent.post(`/api/uploads/${start.videoId}/parts`).set('Origin', WEB).send({ partNumbers: [1] }).expect(200)).body.urls;
  const etag = (await agent.put(urls[1].replace(WEB, '')).set('Origin', WEB).set('Content-Type', 'application/octet-stream').send(data).expect(200)).headers.etag;
  await agent.patch(`/api/hub/videos/${start.videoId}`).set('Origin', WEB).send({ title, visibility: 'PUBLIC' }).expect(200);
  await agent.post(`/api/uploads/${start.videoId}/complete`).set('Origin', WEB).send({ parts: [{ partNumber: 1, etag }] }).expect(200);
  return settle(agent, start.videoId);
}
async function settle(agent: any, id: string) {
  for (let i = 0; i < 400; i++) {
    const v = (await agent.get(`/api/hub/videos/${id}`)).body.video;
    if (v.status === 'FLAGGED' || (v.status === 'READY' && v.processingStage === 'Ready')) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('not settled');
}

test('a copy of a published video is blocked; the uploader disputes; the owner releases it and it is published', async () => {
  const owner = await creator('original.maker');
  const work = await upload(owner, original, 'Fractal dreams');
  expect(work.status).toBe('READY');
  const copier = await creator('copier');
  const blocked = await upload(copier, copy, 'Totally mine');
  expect(blocked).toMatchObject({ status: 'FLAGGED', processingStage: 'Not published' });
  expect(blocked.safety).toMatchObject({ decision: 'reject', rightsClaim: true, canAppeal: false });
  expect(blocked.safety.reason).toMatch(/of “Fractal dreams” by @original\.maker, who does not allow it to be used/);
  await request(ctx.http).get(`/api/videos/${blocked.id}`).expect(404);
  // Not the safety appeal: the owner decides.
  expect((await copier.post(`/api/hub/videos/${blocked.id}/appeal`).set('Origin', WEB).send({}).expect(400)).body.message).toMatch(/Rights/);

  // Both sides see the claim.
  const mine = (await copier.get('/api/rights').expect(200)).body;
  expect(mine.claimsOnMyUploads).toEqual([expect.objectContaining({ policy: 'BLOCK', status: 'ACTIVE', matched: 'picture and sound', upload: expect.objectContaining({ id: blocked.id }), work: expect.objectContaining({ id: work.id, title: 'Fractal dreams' }) })]);
  expect(mine.claimsOnMyUploads[0].seconds).toBeGreaterThanOrEqual(10);
  const theirs = (await owner.get('/api/rights').expect(200)).body;
  expect(theirs.works).toEqual([expect.objectContaining({ id: work.id, protected: true, fingerprinted: true, policy: 'BLOCK' })]);
  expect(theirs.matchesOfMyWorks).toHaveLength(1);
  const claimId = theirs.matchesOfMyWorks[0].id;

  // Only the uploader disputes; only the owner (or an administrator) releases.
  await owner.post(`/api/rights/claims/${claimId}/dispute`).set('Origin', WEB).send({ reason: 'This is not mine to dispute.' }).expect(404);
  await copier.post(`/api/rights/claims/${claimId}/dispute`).set('Origin', WEB).send({ reason: 'I filmed this myself at the planetarium.' }).expect(200);
  expect((await owner.get('/api/rights').expect(200)).body.matchesOfMyWorks[0]).toMatchObject({ status: 'DISPUTED', disputeReason: 'I filmed this myself at the planetarium.' });
  await copier.post(`/api/rights/claims/${claimId}/release`).set('Origin', WEB).send({}).expect(404);
  await owner.post(`/api/rights/claims/${claimId}/release`).set('Origin', WEB).send({}).expect(200);
  const published = await settle(copier, blocked.id);
  expect(published.status).toBe('READY');
  await request(ctx.http).get(`/api/videos/${blocked.id}`).expect(200);

  // The uploader's own different video is not claimed.
  expect((await upload(copier, own, 'Game of life')).status).toBe('READY');
  expect((await copier.get('/api/rights').expect(200)).body.claimsOnMyUploads).toHaveLength(1);
}, 180_000);

test('a verified rights holder lets copies through and earns from them; others can only block; protection can be turned off', async () => {
  const label = await creator('label');
  const work = await upload(label, original, 'Fractal anthem');
  // Not verified: only "block".
  expect((await label.put(`/api/rights/works/${work.id}`).set('Origin', WEB).send({ policy: 'MONETIZE' }).expect(403)).body.message).toMatch(/verified rights holders/);
  const admin = (await signIn(ctx.http, ctx.mail, 'admin@example.com')).agent;
  await label.post('/api/admin/rights/label').set('Origin', WEB).send({ verified: true }).expect(403);
  await admin.post('/api/admin/rights/label').set('Origin', WEB).send({ verified: true }).expect(200);
  await label.put(`/api/rights/works/${work.id}`).set('Origin', WEB).send({ policy: 'MONETIZE' }).expect(200);

  const fan = await creator('fan.uploader');
  const v = await upload(fan, copy, 'Fan edit');
  expect(v.status).toBe('READY');
  await request(ctx.http).get(`/api/videos/${v.id}`).expect(200);
  const claim = (await fan.get('/api/rights').expect(200)).body.claimsOnMyUploads[0];
  expect(claim).toMatchObject({ policy: 'MONETIZE', status: 'ACTIVE' });
  // The copy gets ads although its uploader does not earn: the money goes to the label.
  expect(await ctx.prisma.contentClaim.count({ where: { videoId: v.id, policy: 'MONETIZE', status: 'ACTIVE' } })).toBe(1);

  // Settlement: a day of ads on the copy pays the creators' share to the label, not to the uploader.
  const DAY = 86_400_000;
  const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
  const start = new Date(today.getTime() - DAY);
  const u = await ctx.prisma.user.create({ data: { email: 'shop@example.com' } });
  const adv = await ctx.prisma.advertiser.create({ data: { userId: u.id, businessName: 'Shop', country: 'RW', businessType: 'business', currency: 'USD' } });
  const camp = await ctx.prisma.campaign.create({ data: { advertiserId: adv.id, name: 'c', headline: 'h', destinationUrl: 'https://shop.example.com', currency: 'USD', days: 7, dailyRateCents: 300, cpmRateCents: 0,
    budgetAmountCents: 2100n, status: 'ACTIVE', reviewedAt: start, startDate: start, endDate: new Date(start.getTime() + 7 * DAY), targetCountries: [], targetVideoIds: [], targetChannelIds: [] } });
  await ctx.prisma.adImpression.create({ data: { campaignId: camp.id, videoId: v.id, watchedDurationMs: 0, currency: 'USD', costChargedCents: 0, creatorShareCents: 0, platformShareCents: 0, reinvestShareCents: 0, createdAt: new Date(today.getTime() - DAY / 2) } });
  await new Billing(ctx.prisma as never, ctx.config).settleAds();
  const labelChannel = await ctx.prisma.channel.findUniqueOrThrow({ where: { handle: 'label' } });
  const fanChannel = await ctx.prisma.channel.findUniqueOrThrow({ where: { handle: 'fan.uploader' } });
  expect((await ctx.prisma.revenueLedger.findMany({ where: { channelId: labelChannel.id } })).map((l) => [l.sourceType, Number(l.creatorShareCents)])).toEqual([['AD_SHARE_PRE_ROLL', 180]]);
  expect(await ctx.prisma.revenueLedger.count({ where: { channelId: fanChannel.id } })).toBe(0);

  // Protection off: the claim is released.
  await label.put(`/api/rights/works/${work.id}`).set('Origin', WEB).send({ active: false }).expect(200);
  expect((await fan.get('/api/rights').expect(200)).body.claimsOnMyUploads[0].status).toBe('RELEASED');
}, 180_000);

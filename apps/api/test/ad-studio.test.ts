import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeApp, resetDb, signIn, WEB } from './helpers';

// Ad Studio: ad videos are a Premium upload, kept apart from the Space's videos and out of every public list.
const dir = mkdtempSync(join(tmpdir(), 'freeme-adstudio-'));
let ctx: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => { ctx = await makeApp({ redis: false, storageDir: join(dir, 'storage') }); }, 60_000);
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

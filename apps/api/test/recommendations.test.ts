import request from 'supertest';
import { makeApp, resetDb, signIn, WEB } from './helpers';

// Discovery: "people who watched this also watched" (only when at least 3 people share it) and trending by the last
// two days of views, everywhere or among creators of one country.
let ctx: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => { ctx = await makeApp(); });
beforeEach(async () => { await resetDb(ctx.prisma); ctx.mail.outbox.length = 0; await ctx.clearLimits(); });
afterAll(async () => { await ctx.app.close(); });

const DAY = 86_400_000;
async function space(email: string, handle: string, country?: string) {
  const s = await signIn(ctx.http, ctx.mail, email);
  const channel = (await s.agent.post('/api/channels').set('Origin', WEB).send({ handle, name: handle }).expect(201)).body.channel;
  if (country) await ctx.prisma.profile.update({ where: { userId: channel.userId ?? (await ctx.prisma.channel.findUniqueOrThrow({ where: { id: channel.id } })).userId }, data: { country } });
  return { ...s, channel };
}
const mk = (channelId: string, title: string, extra: object = {}) => ctx.prisma.video.create({ data: { channelId, title, durationSeconds: 300, status: 'READY', visibility: 'PUBLIC', mediaLocation: 'PUBLIC', publishedAt: new Date(Date.now() - 3 * DAY), ...extra } });

test('Next: videos watched by the same people come first, but only once at least 3 people share them', async () => {
  const a = await space('a@example.com', 'aspace');
  const b = await space('b@example.com', 'bspace');
  const current = await mk(a.channel.id, 'Current');
  const together = await mk(b.channel.id, 'Watched together');
  const pair = await mk(b.channel.id, 'Watched by two');
  await mk(b.channel.id, 'Unrelated but popular', { viewCount: 50_000n });
  const viewers = await Promise.all(['v1', 'v2', 'v3'].map((n) => ctx.prisma.user.create({ data: { email: `${n}@example.com` } })));
  for (const [i, u] of viewers.entries()) {
    await ctx.prisma.watchHistory.create({ data: { userId: u.id, videoId: current.id, progressSeconds: 100 } });
    await ctx.prisma.watchHistory.create({ data: { userId: u.id, videoId: together.id, progressSeconds: 100 } });
    if (i < 2) await ctx.prisma.watchHistory.create({ data: { userId: u.id, videoId: pair.id, progressSeconds: 100 } });
  }
  const titles = (await request(ctx.http).get(`/api/videos/${current.id}/next`).expect(200)).body.videos.map((v: any) => v.title);
  expect(titles[0]).toBe('Watched together');
  // Shared by only two people: not used, so it ranks like any other video of that Space.
  expect(titles.indexOf('Watched by two')).toBeGreaterThan(titles.indexOf('Unrelated but popular'));
});

test('Rising and the home page: views of the last two days count, and Trending in the viewer\'s country shows local creators', async () => {
  const rw = await space('rw@example.com', 'kigali', 'RW');
  const ke = await space('ke@example.com', 'nairobi', 'KE');
  const today = new Date(new Date().toISOString().slice(0, 10));
  const stat = (videoId: string, daysAgo: number, views: number) => ctx.prisma.videoDailyStat.create({ data: { videoId, day: new Date(today.getTime() - daysAgo * DAY), views } });
  const oldHit = await mk(ke.channel.id, 'Big last week', { viewCount: 10_000n });
  await stat(oldHit.id, 6, 10_000);
  const risingNow = await mk(ke.channel.id, 'Rising now', { viewCount: 300n });
  await stat(risingNow.id, 0, 200); await stat(risingNow.id, 1, 100);
  const local = await Promise.all([1, 2, 3, 4].map(async (i) => { const v = await mk(rw.channel.id, `Kigali ${i}`); await stat(v.id, 0, 10 * i); return v; }));
  await mk(ke.channel.id, 'Old video', { publishedAt: new Date(Date.now() - 60 * DAY) });

  const rising = (await request(ctx.http).get('/api/feed/rising').expect(200)).body.videos.map((v: any) => v.title);
  expect(rising.slice(0, 2)).toEqual(['Rising now', 'Kigali 4']);
  expect(rising).toContain('Big last week'); // filled in after the videos with recent views
  expect(rising).not.toContain('Old video');
  const inRwanda = (await request(ctx.http).get('/api/feed/rising?country=RW').expect(200)).body.videos.map((v: any) => v.title);
  expect(inRwanda).toEqual(['Kigali 4', 'Kigali 3', 'Kigali 2', 'Kigali 1']);

  // A visitor sees what trends everywhere; a viewer in Rwanda sees Rwanda's creators.
  expect((await request(ctx.http).get('/api/feed/home').expect(200)).body.trending).toMatchObject({ country: null, videos: expect.arrayContaining([expect.objectContaining({ title: 'Rising now' })]) });
  const home = (await rw.agent.get('/api/feed/home').expect(200)).body.trending;
  expect(home.country).toBe('RW');
  expect(home.videos.map((v: any) => v.id)).toEqual(local.map((v) => v.id).reverse());
});

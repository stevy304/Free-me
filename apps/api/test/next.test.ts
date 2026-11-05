import request from 'supertest';
import { makeApp, resetDb, signIn, WEB } from './helpers';
import { arrangeNext } from '../src/catalog/next.controller';

let ctx: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => { ctx = await makeApp(); });
beforeEach(async () => { await resetDb(ctx.prisma); ctx.mail.outbox.length = 0; await ctx.clearLimits(); });
afterAll(async () => { await ctx.app.close(); });

test('Next keeps a mix of Spaces: no more than two from one Space in any four in a row', () => {
  const rows = [
    ...['a1', 'a2', 'a3', 'a4'].map((id, i) => ({ id, channelId: 'A', score: 10 - i })),
    { id: 'b1', channelId: 'B', score: 5 }, { id: 'c1', channelId: 'C', score: 4 },
  ];
  expect(arrangeNext(rows, 6).map((r) => r.id)).toEqual(['a1', 'a2', 'b1', 'c1', 'a3', 'a4']);
});

test('Next: same Space, shared tags and topic first; finished videos last; Moments, private and the video itself never', async () => {
  const c = await signIn(ctx.http, ctx.mail, 'maker@example.com');
  const maker = (await c.agent.post('/api/channels').set('Origin', WEB).send({ handle: 'maker', name: 'Maker' }).expect(201)).body.channel;
  const o = await signIn(ctx.http, ctx.mail, 'other@example.com');
  const other = (await o.agent.post('/api/channels').set('Origin', WEB).send({ handle: 'other', name: 'Other' }).expect(201)).body.channel;
  const cats = await ctx.prisma.category.findMany();
  const travel = cats.find((x) => x.slug === 'travel-events')!;
  const music = cats.find((x) => x.slug === 'music')!;
  const old = new Date(Date.now() - 90 * 86_400_000);
  const mk = (channelId: string, title: string, extra: object = {}) => ctx.prisma.video.create({ data: { channelId, title, durationSeconds: 60, status: 'READY', visibility: 'PUBLIC', mediaLocation: 'PUBLIC', publishedAt: old, ...extra } });
  const gorillas = await ctx.prisma.tag.create({ data: { name: 'gorillas' } });

  const current = await mk(maker.id, 'Gorillas of Musanze', { categoryId: travel.id, tags: { create: [{ tagId: gorillas.id }] } });
  const sameSpace = await mk(maker.id, 'Lake Kivu', { categoryId: music.id });
  const sameTag = await mk(other.id, 'More gorillas', { categoryId: music.id, tags: { create: [{ tagId: gorillas.id }] } });
  const sameTopic = await mk(other.id, 'Nyungwe walk', { categoryId: travel.id });
  const popular = await mk(other.id, 'Drum solo', { categoryId: music.id, viewCount: 100_000n });
  const finished = await mk(other.id, 'Volcano hike', { categoryId: travel.id, tags: { create: [{ tagId: gorillas.id }] } });
  await mk(other.id, 'Short clip', { isShort: true, categoryId: travel.id });
  await mk(other.id, 'Private one', { visibility: 'PRIVATE', categoryId: travel.id });

  const anon = (await request(ctx.http).get(`/api/videos/${current.id}/next`).expect(200)).body.videos.map((v: any) => v.title);
  expect(anon).not.toContain('Gorillas of Musanze');
  expect(anon).not.toContain('Short clip');
  expect(anon).not.toContain('Private one');
  // Shared tag and topic (4) > same Space (3) > shared tag only (2) > same topic only (2, older) > merely popular.
  expect(anon.slice(0, 3)).toEqual([finished.title, sameSpace.title, sameTag.title]);
  expect(anon.indexOf(sameSpace.title)).toBeLessThan(anon.indexOf(popular.title));
  expect(anon.indexOf(sameTopic.title)).toBeLessThan(anon.indexOf(popular.title));

  // A viewer who already finished one sees it last.
  const fan = await signIn(ctx.http, ctx.mail, 'fan@example.com');
  const me = await ctx.prisma.user.findUniqueOrThrow({ where: { email: 'fan@example.com' } });
  await ctx.prisma.watchHistory.create({ data: { userId: me.id, videoId: finished.id, progressSeconds: 60, completed: true } });
  const mine = (await fan.agent.get(`/api/videos/${current.id}/next`).expect(200)).body.videos.map((v: any) => v.title);
  expect(mine.at(-1)).toBe(finished.title);
  expect(mine.slice(0, 2)).toEqual([sameSpace.title, sameTag.title]);

  // Unknown video: the latest videos instead of an error.
  expect((await request(ctx.http).get('/api/videos/00000000-0000-4000-8000-000000000000/next').expect(200)).body.videos.length).toBeGreaterThan(0);
  expect((await request(ctx.http).get(`/api/videos/${current.id}/next?limit=2`)).body.videos).toHaveLength(2);
});

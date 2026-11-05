import request from 'supertest';
import { makeApp, resetDb, signIn, WEB } from './helpers';

let ctx: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => { ctx = await makeApp(); });
beforeEach(async () => { await resetDb(ctx.prisma); ctx.mail.outbox.length = 0; await ctx.clearLimits(); });
afterAll(async () => { await ctx.app.close(); });

test('search ranks title matches first, forgives typos, uses tags and Space names, pages, and lists only public videos', async () => {
  const c = await signIn(ctx.http, ctx.mail, 'maker@example.com');
  const ch = (await c.agent.post('/api/channels').set('Origin', WEB).send({ handle: 'kigali.mornings', name: 'Kigali Mornings' }).expect(201)).body.channel;
  const mk = (title: string, extra: object = {}) => ctx.prisma.video.create({ data: { channelId: ch.id, title, durationSeconds: 60, status: 'READY', visibility: 'PUBLIC', mediaLocation: 'PUBLIC', publishedAt: new Date(), ...extra } });
  const tag = await ctx.prisma.tag.create({ data: { name: 'wildlife' } });
  await mk('A walk in the park', { description: 'We met gorillas on the way.', viewCount: 1_000_000n });
  await mk('Gorillas of Musanze');
  await mk('Volcano morning', { tags: { create: [{ tagId: tag.id }] } });
  await mk('Gorillas, private', { visibility: 'PRIVATE' });
  await mk('Gorillas removed', { takenDownAt: new Date() });

  const titles = async (q: string) => (await request(ctx.http).get(`/api/search?q=${encodeURIComponent(q)}`).expect(200)).body.videos.map((v: any) => v.title);
  // In the title beats only in the description, even against a million views.
  expect(await titles('gorillas')).toEqual(['Gorillas of Musanze', 'A walk in the park']);
  // A typo still finds it.
  expect(await titles('gorrilas')).toContain('Gorillas of Musanze');
  // Tags and the Space's name count.
  expect(await titles('wildlife')).toEqual(['Volcano morning']);
  expect((await titles('kigali mornings')).length).toBe(3);
  expect((await request(ctx.http).get('/api/search?q=kigali')).body.channels.map((x: any) => x.handle)).toEqual(['kigali.mornings']);
  expect(await titles('zebra')).toEqual([]);

  // Pages of 24, Spaces only on the first.
  for (let i = 0; i < 25; i++) await mk(`Market day ${i}`);
  const p1 = (await request(ctx.http).get('/api/search?q=market').expect(200)).body;
  expect(p1.videos).toHaveLength(24);
  expect(p1.nextCursor).toBe('o:24');
  const p2 = (await request(ctx.http).get(`/api/search?q=market&cursor=${p1.nextCursor}`).expect(200)).body;
  expect(p2.videos).toHaveLength(1);
  expect(p2.nextCursor).toBeNull();
  expect(new Set([...p1.videos, ...p2.videos].map((v: any) => v.id)).size).toBe(25);
});

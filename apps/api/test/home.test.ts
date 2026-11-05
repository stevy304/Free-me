import request from 'supertest';
import { makeApp, resetDb, signIn, WEB } from './helpers';

let ctx: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => { ctx = await makeApp(); });
beforeEach(async () => { await resetDb(ctx.prisma); ctx.mail.outbox.length = 0; await ctx.clearLimits(); });
afterAll(async () => { await ctx.app.close(); });

describe('For you home and interests', () => {
  test('home is built from picked topics, followed creators and recency only', async () => {
    const empty = (await request(ctx.http).get('/api/feed/home').expect(200)).body;
    expect(empty).toMatchObject({ spotlight: null, shelves: [], moments: [], hasPicked: false });

    const c = await signIn(ctx.http, ctx.mail, 'maker@example.com');
    const ch = (await c.agent.post('/api/channels').set('Origin', WEB).send({ handle: 'maker', name: 'Maker' }).expect(201)).body.channel;
    const cats = await ctx.prisma.category.findMany();
    const music = cats.find((x) => x.slug === 'music')!;
    const travel = cats.find((x) => x.slug === 'travel-events')!;
    const mk = (title: string, categoryId: string, extra: object = {}) => ctx.prisma.video.create({ data: { channelId: ch.id, title, durationSeconds: 60, status: 'READY', visibility: 'PUBLIC', mediaLocation: 'PUBLIC', publishedAt: new Date(), categoryId, ...extra } });
    await mk('Drums', music.id, { viewCount: 50n });
    await mk('Guitar', music.id, { viewCount: 5n });
    const lake = await mk('Lake', travel.id, { viewCount: 10n });
    await mk('Short clip', travel.id, { isShort: true });

    // Visitors: busiest topics, the most watched of the week as spotlight, Moments separately.
    const anon = (await request(ctx.http).get('/api/feed/home')).body;
    expect(anon.spotlight.title).toBe('Drums');
    expect(anon.shelves.map((s: any) => [s.category.slug, s.reason])).toEqual([['music', 'popular'], ['travel-events', 'popular']]);
    expect(anon.moments.map((v: any) => v.title)).toEqual(['Short clip']);

    const fan = await signIn(ctx.http, ctx.mail, 'fan@example.com');
    await fan.agent.put('/api/me/interests').set('Origin', WEB).send({ categories: ['nope'] }).expect(400);
    await request(ctx.http).put('/api/me/interests').set('Origin', WEB).send({ categories: ['music'] }).expect(401);
    expect((await fan.agent.put('/api/me/interests').set('Origin', WEB).send({ categories: ['travel-events'] }).expect(200)).body.categories).toEqual(['travel-events']);
    expect((await fan.agent.get('/api/me/interests')).body.categories).toEqual(['travel-events']);
    await fan.agent.post('/api/channels/maker/follow').set('Origin', WEB).expect(200);

    const mine = (await fan.agent.get('/api/feed/home')).body;
    expect(mine.hasPicked).toBe(true);
    expect(mine.spotlight.id).toBe(lake.id);
    expect(mine.shelves[0]).toMatchObject({ category: { slug: 'travel-events' }, reason: 'picked' });
    expect(mine.interests.find((i: any) => i.slug === 'travel-events').picked).toBe(true);
    expect(mine.fromCreators.length).toBe(4);
    expect((await request(ctx.http).get('/api/feed/rising')).body.videos.map((v: any) => v.title)).toEqual(['Drums', 'Lake', 'Guitar']);
  });
});

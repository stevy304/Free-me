import request from 'supertest';
import { makeApp, resetDb, signIn, WEB } from './helpers';

let ctx: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => { ctx = await makeApp(); });
beforeEach(async () => { await resetDb(ctx.prisma); ctx.mail.outbox.length = 0; await ctx.clearLimits(); });
afterAll(async () => { await ctx.app.close(); });

describe('profiles', () => {
  test('anyone in the world can set their country, language and time zone; bad values are refused', async () => {
    const { agent } = await signIn(ctx.http, ctx.mail, 'kenji@example.jp');
    const ok = await agent.patch('/api/me/profile').set('Origin', WEB).send({ displayName: '  Kenji  ', country: 'jp', preferredLanguage: 'ja', timezone: 'Asia/Tokyo', city: 'Osaka', bio: 'Travel films' }).expect(200);
    expect(ok.body.profile).toEqual({ displayName: 'Kenji', avatarUrl: null, bio: 'Travel films', country: 'JP', city: 'Osaka', preferredLanguage: 'ja', timezone: 'Asia/Tokyo', personalizedRecommendations: true });
    await agent.patch('/api/me/profile').set('Origin', WEB).send({ country: 'XX' }).expect(400);
    await agent.patch('/api/me/profile').set('Origin', WEB).send({ preferredLanguage: 'klingon' }).expect(400);
    await agent.patch('/api/me/profile').set('Origin', WEB).send({ timezone: 'Mars/Olympus' }).expect(400);
    await agent.patch('/api/me/profile').set('Origin', WEB).send({ displayName: '   ' }).expect(400);
    await agent.patch('/api/me/profile').set('Origin', WEB).send({ roles: ['ADMIN'] }).expect(400);
    const cleared = await agent.patch('/api/me/profile').set('Origin', WEB).send({ country: null }).expect(200);
    expect(cleared.body.profile.country).toBeNull();
    expect((await agent.get('/api/me')).body.user.roles).toEqual(['VIEWER']);
  });
});

describe('channels and following', () => {
  test('create a channel, become a creator; handles are unique, valid and not reserved', async () => {
    const { agent } = await signIn(ctx.http, ctx.mail, 'uwase@example.com');
    expect((await request(ctx.http).get('/api/channels/handle-available?handle=@Uwase.Music')).body).toEqual({ available: true, handle: 'uwase.music' });
    expect((await request(ctx.http).get('/api/channels/handle-available?handle=admin')).body.available).toBe(false);
    await agent.post('/api/channels').set('Origin', WEB).send({ handle: 'admin', name: 'X' }).expect(400);
    await agent.post('/api/channels').set('Origin', WEB).send({ handle: 'uw', name: 'X' }).expect(400);
    await agent.post('/api/channels').set('Origin', WEB).send({ handle: 'uwase.music', name: 'Uwase Music', country: 'XX' }).expect(400);
    const created = await agent.post('/api/channels').set('Origin', WEB).send({ handle: '@Uwase.Music', name: 'Uwase Music', description: 'Songs', country: 'rw', defaultLanguage: 'rw' }).expect(201);
    expect(created.body.channel).toMatchObject({ handle: 'uwase.music', name: 'Uwase Music', country: 'RW', defaultLanguage: 'rw', followerCount: 0, totalViews: '0' });
    expect((await agent.get('/api/me')).body.user.roles).toEqual(['VIEWER', 'CREATOR']);
    await agent.post('/api/channels').set('Origin', WEB).send({ handle: 'second', name: 'Second' }).expect(409);
    expect((await request(ctx.http).get('/api/channels/handle-available?handle=uwase.music')).body).toEqual({ available: false, reason: 'This handle is taken.' });

    const other = await signIn(ctx.http, ctx.mail, 'other@example.com');
    await other.agent.post('/api/channels').set('Origin', WEB).send({ handle: 'UWASE.MUSIC', name: 'Copy' }).expect(409);
    const updated = await agent.patch('/api/channels/mine').set('Origin', WEB).send({ name: 'Uwase', description: '' }).expect(200);
    expect(updated.body.channel).toMatchObject({ name: 'Uwase', description: null });
    await other.agent.patch('/api/channels/mine').set('Origin', WEB).send({ name: 'Nope' }).expect(404);
    await request(ctx.http).post('/api/channels').set('Origin', WEB).send({ handle: 'anon', name: 'Anon' }).expect(401);
  });

  test('public channel page, follow and unfollow keep an exact count; no self-following', async () => {
    const owner = await signIn(ctx.http, ctx.mail, 'owner@example.com');
    await owner.agent.post('/api/channels').set('Origin', WEB).send({ handle: 'daily.news', name: 'Daily News' }).expect(201);
    const fan = await signIn(ctx.http, ctx.mail, 'fan@example.com');

    const anon = await request(ctx.http).get('/api/channels/@daily.news').expect(200);
    expect(anon.body).toMatchObject({ channel: { handle: 'daily.news', followerCount: 0 }, videoCount: 0, videos: [], viewer: { following: false, isOwner: false } });
    await request(ctx.http).get('/api/channels/nobody-here').expect(404);

    await owner.agent.post('/api/channels/daily.news/follow').set('Origin', WEB).expect(400);
    expect((await fan.agent.post('/api/channels/daily.news/follow').set('Origin', WEB).expect(200)).body).toEqual({ following: true, followerCount: 1 });
    expect((await fan.agent.post('/api/channels/daily.news/follow').set('Origin', WEB).expect(200)).body.followerCount).toBe(1);
    expect((await fan.agent.get('/api/channels/daily.news')).body.viewer).toEqual({ following: true, isOwner: false });
    expect((await owner.agent.get('/api/channels/daily.news')).body.viewer.isOwner).toBe(true);
    const feed = await fan.agent.get('/api/feed/following').expect(200);
    expect(feed.body.channels.map((c: any) => c.handle)).toEqual(['daily.news']);
    expect((await fan.agent.delete('/api/channels/daily.news/follow').set('Origin', WEB).expect(200)).body).toEqual({ following: false, followerCount: 0 });
    expect((await fan.agent.delete('/api/channels/daily.news/follow').set('Origin', WEB).expect(200)).body.followerCount).toBe(0);
  });
});

describe('catalog', () => {
  test('categories come from the database; only public, ready videos are listed, newest first, with cursor pages', async () => {
    const cats = (await request(ctx.http).get('/api/categories').expect(200)).body.categories;
    expect(cats.length).toBeGreaterThan(10);
    expect(cats.map((c: any) => c.slug)).toContain('music');
    expect((await request(ctx.http).get('/api/videos').expect(200)).body).toEqual({ videos: [], nextCursor: null });

    const { agent } = await signIn(ctx.http, ctx.mail, 'maker@example.com');
    const ch = (await agent.post('/api/channels').set('Origin', WEB).send({ handle: 'maker', name: 'Maker' }).expect(201)).body.channel;
    const music = cats.find((c: any) => c.slug === 'music');
    const base = { channelId: ch.id, durationSeconds: 60 };
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) await ctx.prisma.video.create({ data: { ...base, title: `Public ${i}`, status: 'READY', visibility: 'PUBLIC', mediaLocation: 'PUBLIC', publishedAt: new Date(t0 - i * 60_000), categoryId: i % 2 ? music.id : null, isShort: i === 4 } });
    await ctx.prisma.video.create({ data: { ...base, title: 'Private', status: 'READY', visibility: 'PRIVATE', publishedAt: new Date(t0) } });
    await ctx.prisma.video.create({ data: { ...base, title: 'Unlisted', status: 'READY', visibility: 'UNLISTED', publishedAt: new Date(t0) } });
    await ctx.prisma.video.create({ data: { ...base, title: 'Processing', status: 'PROCESSING', visibility: 'PUBLIC' } });

    const p1 = (await request(ctx.http).get('/api/videos?limit=2').expect(200)).body;
    expect(p1.videos.map((v: any) => v.title)).toEqual(['Public 0', 'Public 1']);
    expect(p1.videos[0].channel).toEqual({ handle: 'maker', name: 'Maker', avatarUrl: null, isVerified: false, badge: null });
    const p2 = (await request(ctx.http).get(`/api/videos?limit=2&cursor=${encodeURIComponent(p1.nextCursor)}`)).body;
    const p3 = (await request(ctx.http).get(`/api/videos?limit=2&cursor=${encodeURIComponent(p2.nextCursor)}`)).body;
    expect([...p2.videos, ...p3.videos].map((v: any) => v.title)).toEqual(['Public 2', 'Public 3', 'Public 4']);
    expect(p3.nextCursor).toBeNull();
    expect((await request(ctx.http).get('/api/videos?category=music')).body.videos.map((v: any) => v.title)).toEqual(['Public 1', 'Public 3']);
    expect((await request(ctx.http).get('/api/videos?moments=true')).body.videos.map((v: any) => v.title)).toEqual(['Public 4']);
    expect((await request(ctx.http).get('/api/channels/maker')).body.videoCount).toBe(5);
    await request(ctx.http).get('/api/videos?cursor=garbage').expect(400);
  });
});

describe('watch page and search', () => {
  test('a video is visible when public or unlisted and ready; private only to its owner; search finds videos and channels', async () => {
    const owner = await signIn(ctx.http, ctx.mail, 'chef@example.com');
    const ch = (await owner.agent.post('/api/channels').set('Origin', WEB).send({ handle: 'chef.amara', name: 'Chef Amara' }).expect(201)).body.channel;
    const mk = (title: string, extra: object) => ctx.prisma.video.create({ data: { channelId: ch.id, title, description: 'Recipes from home', durationSeconds: 300, ...extra } });
    const pub = await mk('Jollof rice in 20 minutes', { status: 'READY', visibility: 'PUBLIC', mediaLocation: 'PUBLIC', publishedAt: new Date(), hlsMasterKey: 'hls/master.m3u8' });
    const unl = await mk('Unlisted dinner', { status: 'READY', visibility: 'UNLISTED', mediaLocation: 'PUBLIC', publishedAt: new Date() });
    const priv = await mk('Private draft', { status: 'READY', visibility: 'PRIVATE', publishedAt: new Date() });
    const proc = await mk('Still processing', { status: 'PROCESSING', visibility: 'PUBLIC' });

    const v = (await request(ctx.http).get(`/api/videos/${pub.id}`).expect(200)).body.video;
    expect(v).toMatchObject({ title: 'Jollof rice in 20 minutes', playbackUrl: `${WEB}/api/storage/local/pub/${pub.id}/hls/master.m3u8`, channel: { handle: 'chef.amara', followerCount: 0 } });
    await request(ctx.http).get(`/api/videos/${unl.id}`).expect(200);
    await request(ctx.http).get(`/api/videos/${priv.id}`).expect(404);
    await request(ctx.http).get(`/api/videos/${proc.id}`).expect(404);
    expect((await owner.agent.get(`/api/videos/${priv.id}`).expect(200)).body.video.visibility).toBe('PRIVATE');
    expect((await owner.agent.get(`/api/videos/${proc.id}`).expect(200)).body.video.playbackUrl).toBeNull();
    await request(ctx.http).get('/api/videos/not-a-uuid').expect(400);

    const s = (await request(ctx.http).get('/api/search?q=jollof rice').expect(200)).body;
    expect(s.videos.map((x: any) => x.title)).toEqual(['Jollof rice in 20 minutes']);
    expect((await request(ctx.http).get('/api/search?q=dinner')).body.videos).toEqual([]);
    expect((await request(ctx.http).get('/api/search?q=amara')).body.channels.map((c: any) => c.handle)).toEqual(['chef.amara']);
    expect((await request(ctx.http).get('/api/search/suggest?q=jol')).body.suggestions).toEqual(['Jollof rice in 20 minutes']);
    expect((await request(ctx.http).get('/api/search/suggest?q=j')).body.suggestions).toEqual([]);
  });
});

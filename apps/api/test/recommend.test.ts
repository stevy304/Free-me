import Redis from 'ioredis';
import { makeApp, resetDb, signIn, WEB } from './helpers';
import { arrange, jitter, score, type Candidate, type Taste } from '../src/recommend/rank';
import { KEY, quality, refreshSignals } from '../src/recommend/signals';
import { refreshRelated } from '../src/recommend/related';
import { emptyTaste, rankForYou } from '../src/recommend/for-you';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 13, 12);

describe('ranking rules (pure)', () => {
  const cand = (id: string, over: Partial<Candidate> = {}): Candidate => ({
    id, channelId: `ch-${id}`, categoryId: 'music', tagIds: [], language: null, country: null, publishedAt: NOW - 60 * DAY, durationSeconds: 300, isShort: false,
    quality: 0.5, recentViews: 0, views: 1000, sources: new Set(['quality']), related: 0, relatedTo: null, ...over,
  });
  const taste = (over: Partial<Taste> = {}): Taste => ({ ...emptyTaste(), ...over });

  test('quality: a few views cannot make a video look perfect or terrible; many views can', () => {
    expect(quality({ views: 1, watchSeconds: 300, durationSeconds: 300, likes: 1, dislikes: 0 })).toBeLessThan(0.6);
    expect(quality({ views: 1, watchSeconds: 0, durationSeconds: 300, likes: 0, dislikes: 1 })).toBeGreaterThan(0.25);
    expect(quality({ views: 1000, watchSeconds: 1000 * 270, durationSeconds: 300, likes: 200, dislikes: 2 })).toBeGreaterThan(0.9);
    expect(quality({ views: 1000, watchSeconds: 1000 * 15, durationSeconds: 300, likes: 1, dislikes: 80 })).toBeLessThan(0.1);
  });

  test('what the viewer watched and follows lifts a video, and the reason says so', () => {
    const t = taste({ topics: { music: 1 }, channels: { 'ch-b': 1 }, follows: ['ch-b'] });
    const plain = score(cand('a', { categoryId: 'news' }), t, { now: NOW });
    const related = score(cand('r', { categoryId: 'news', related: 1, relatedTo: 'seed' }), t, { now: NOW });
    const followed = score(cand('b', { channelId: 'ch-b', categoryId: 'news' }), t, { now: NOW });
    const topic = score(cand('m'), t, { now: NOW });
    expect(related.score).toBeGreaterThan(plain.score + 2);
    expect(related.reason).toEqual({ kind: 'related', videoId: 'seed' });
    expect(followed.reason).toEqual({ kind: 'following' });
    expect(topic.reason).toEqual({ kind: 'topic', categoryId: 'music' });
    expect(plain.reason.kind).toBe('popular');
  });

  test('finished, "Not for me" Spaces and videos shown but not opened go down', () => {
    const base = score(cand('x'), taste(), { now: NOW }).score;
    expect(score(cand('x'), taste({ finished: ['x'] }), { now: NOW }).score).toBeLessThan(base - 4);
    expect(score(cand('x'), taste({ avoidChannels: { 'ch-x': 1 } }), { now: NOW }).score).toBeLessThan(base - 2);
    expect(score(cand('x'), taste(), { now: NOW, seen: { x: 2 } }).score).toBeLessThan(base - 1);
  });

  test('a huge view count only helps a little: no signal can take over', () => {
    const t = taste({ topics: { music: 1 } });
    const viral = score(cand('v', { categoryId: 'news', recentViews: 10_000_000, views: 50_000_000, quality: 0.6 }), t, { now: NOW });
    const mine = score(cand('m', { quality: 0.6 }), t, { now: NOW });
    expect(mine.score).toBeGreaterThan(viral.score);
  });

  test('the order keeps a mix of Spaces and topics, keeps places for new creators, and leaves hidden videos out', () => {
    const t = taste();
    const many = [
      ...Array.from({ length: 10 }, (_, i) => score(cand(`a${i}`, { channelId: 'ch-a', quality: 0.9 }), t, { now: NOW })),
      ...Array.from({ length: 10 }, (_, i) => score(cand(`b${i}`, { channelId: `ch-b${i}`, categoryId: `topic${i % 3}`, quality: 0.6 }), t, { now: NOW })),
      // New and still unproven: scores below everything else, so only the reserved place brings it up.
      score(cand('new', { channelId: 'ch-new', publishedAt: NOW - 6.5 * DAY, views: 3, quality: 0.05, sources: new Set(['fresh']) }), t, { now: NOW }),
      score(cand('gone', { channelId: 'ch-gone', quality: 1 }), t, { now: NOW }),
    ];
    const out = arrange(many, { hidden: ['gone'] }, { limit: 12, now: NOW });
    expect(out.map((c) => c.id)).not.toContain('gone');
    for (let i = 0; i < out.length; i++) expect(out.slice(Math.max(0, i - 3), i).some((o) => o.channelId === out[i].channelId)).toBe(false);
    expect(out[5].id).toBe('new'); // the 6th place is for a new creator
    expect(out[5].reason.kind).toBe('new');
  });

  test('variety is stable within the hour', () => {
    expect(jitter('abc', 7)).toBe(jitter('abc', 7));
    expect(jitter('abc', 7)).not.toBe(jitter('abc', 8));
  });
});

describe('For you, end to end', () => {
  let ctx: Awaited<ReturnType<typeof makeApp>>;
  let redis: Redis;
  beforeAll(async () => { ctx = await makeApp(); redis = new Redis(process.env.REDIS_URL!); });
  beforeEach(async () => { await resetDb(ctx.prisma); ctx.mail.outbox.length = 0; await ctx.clearLimits(); for (const k of await redis.keys('rec:*')) await redis.del(k); });
  afterAll(async () => { await redis.quit(); await ctx.app.close(); });

  async function world() {
    const cat = async (slug: string) => (await ctx.prisma.category.findUniqueOrThrow({ where: { slug } })).id;
    const [music, sports, news] = [await cat('music'), await cat('sports'), await cat('news')];
    const space = async (handle: string) => {
      const c = await signIn(ctx.http, ctx.mail, `${handle}@example.com`);
      return (await c.agent.post('/api/channels').set('Origin', WEB).send({ handle, name: handle }).expect(201)).body.channel.id as string;
    };
    const [drums, goals, daily, newbie] = [await space('drums'), await space('goals'), await space('daily'), await space('newbie')];
    const mk = (channelId: string, categoryId: string, title: string, days: number, views: number) => ctx.prisma.video.create({ data: {
      channelId, categoryId, title, durationSeconds: 300, status: 'READY', visibility: 'PUBLIC', mediaLocation: 'PUBLIC', hlsMasterKey: 'hls/master.m3u8',
      publishedAt: new Date(Date.now() - days * DAY), viewCount: BigInt(views), watchTimeSeconds: BigInt(views * 150), likeCount: Math.floor(views / 20) } });
    const songs = await Promise.all(Array.from({ length: 12 }, (_, i) => mk(drums, music, `Song ${i}`, 10 + i, 500 + i)));
    const matches = await Promise.all(Array.from({ length: 12 }, (_, i) => mk(goals, sports, `Match ${i}`, 10 + i, 5000 + i)));
    const bulletins = await Promise.all(Array.from({ length: 12 }, (_, i) => mk(daily, news, `Bulletin ${i}`, 10 + i, 3000 + i)));
    const debut = await mk(newbie, sports, 'My first video', 1, 2);
    return { music, sports, news, songs, matches, bulletins, debut };
  }

  test('learns from watching, likes and "Not for me"; explains itself; keeps a place for a new creator', async () => {
    const w = await world();
    const fan = await signIn(ctx.http, ctx.mail, 'fan@example.com');
    const fanId = (await ctx.prisma.user.findUniqueOrThrow({ where: { email: 'fan@example.com' } })).id;
    // Finished three songs, liked one; said "Not for me" to a match.
    for (const s of w.songs.slice(0, 3)) await ctx.prisma.watchHistory.create({ data: { userId: fanId, videoId: s.id, progressSeconds: 300, completed: true } });
    await fan.agent.put(`/api/videos/${w.songs[0].id}/reaction`).set('Origin', WEB).send({ value: 'like' }).expect(200);
    await fan.agent.put(`/api/videos/${w.matches[0].id}/reaction`).set('Origin', WEB).send({ value: 'dislike' }).expect(200);
    expect(await refreshSignals(ctx.prisma as never, redis)).toBe(37);
    expect(await redis.zcard(KEY.topic(w.music))).toBe(12);

    const page = (await fan.agent.get('/api/feed/for-you').expect(200)).body;
    const ids: string[] = page.videos.map((v: any) => v.id);
    const titles: string[] = page.videos.map((v: any) => v.title);
    expect(ids).not.toContain(w.matches[0].id); // "Not for me"
    expect(ids.slice(0, 3)).not.toEqual(expect.arrayContaining(w.songs.slice(0, 3).map((s) => s.id))); // finished ones are not first
    // Music leads (the Space they watch and like), but other Spaces are mixed in.
    expect(titles.slice(0, 8).filter((t) => t.startsWith('Song')).length).toBeGreaterThanOrEqual(2);
    expect(new Set(page.videos.slice(0, 4).map((v: any) => v.channel.handle)).size).toBeGreaterThan(1);
    expect(page.videos.find((v: any) => v.title.startsWith('Song'))?.reason).toMatchObject({ kind: expect.stringMatching(/topic|following/) });
    // The new creator's first video has a place near the top.
    expect(ids.slice(0, 6)).toContain(w.debut.id);
    expect(page.videos.find((v: any) => v.id === w.debut.id).reason).toEqual({ kind: 'new' });
    // Pages do not repeat each other; what was shown is remembered.
    expect(page.nextPage).toBe(1);
    const next = (await fan.agent.get('/api/feed/for-you?page=1').expect(200)).body.videos.map((v: any) => v.id);
    expect(next.filter((id: string) => ids.includes(id))).toEqual([]);
    expect(await redis.zscore(KEY.seen(fanId), ids[0])).toBe('1');
  });

  test('"people who watched this also watched" is used, prepared ahead for popular videos', async () => {
    const w = await world();
    const users = await Promise.all(Array.from({ length: 4 }, (_, i) => ctx.prisma.user.create({ data: { email: `co${i}@example.com` } })));
    // Four people watched Song 0 and Bulletin 5 together.
    for (const u of users) for (const v of [w.songs[0], w.bulletins[5]]) await ctx.prisma.watchHistory.create({ data: { userId: u.id, videoId: v.id, progressSeconds: 300, completed: true } });
    await ctx.prisma.videoDailyStat.create({ data: { videoId: w.songs[0].id, day: new Date(new Date().toISOString().slice(0, 10)), views: 40, watchSeconds: 4000n } });
    await refreshSignals(ctx.prisma as never, redis);
    expect(await refreshRelated(ctx.prisma as never, redis)).toBeGreaterThan(0);
    expect(await redis.zscore(KEY.related(w.songs[0].id), w.bulletins[5].id)).toBe('4');

    const fan = await signIn(ctx.http, ctx.mail, 'fan@example.com');
    const fanId = (await ctx.prisma.user.findUniqueOrThrow({ where: { email: 'fan@example.com' } })).id;
    await ctx.prisma.watchHistory.create({ data: { userId: fanId, videoId: w.songs[0].id, progressSeconds: 300, completed: true } });
    const videos = (await fan.agent.get('/api/feed/for-you').expect(200)).body.videos;
    const bulletin = videos.find((v: any) => v.id === w.bulletins[5].id);
    expect(videos.indexOf(bulletin)).toBeLessThan(4);
    expect(bulletin.reason).toEqual({ kind: 'related', title: 'Song 0' });
    // Up next reads the same prepared list (same-Space videos still come first there).
    const next = (await fan.agent.get(`/api/videos/${w.songs[0].id}/next`).expect(200)).body.videos.map((v: any) => v.id);
    expect(next.slice(0, 10)).toContain(w.bulletins[5].id);
  });

  test('with personalisation off, only picked topics and followed Spaces count; visitors get a feed too', async () => {
    const w = await world();
    const fan = await signIn(ctx.http, ctx.mail, 'fan@example.com');
    const fanId = (await ctx.prisma.user.findUniqueOrThrow({ where: { email: 'fan@example.com' } })).id;
    for (const s of w.songs.slice(0, 5)) await ctx.prisma.watchHistory.create({ data: { userId: fanId, videoId: s.id, progressSeconds: 300, completed: true } });
    await refreshSignals(ctx.prisma as never, redis);
    const on = (await fan.agent.get('/api/feed/for-you').expect(200)).body.videos;
    expect(on.some((v: any) => v.reason.kind === 'topic' && v.reason.topic?.slug === 'music')).toBe(true);
    expect((await fan.agent.patch('/api/me/profile').set('Origin', WEB).send({ personalizedRecommendations: false }).expect(200)).body.profile.personalizedRecommendations).toBe(false);
    const off = (await fan.agent.get('/api/feed/for-you').expect(200)).body.videos;
    expect(off.some((v: any) => v.reason.kind === 'topic' && v.reason.topic?.slug === 'music')).toBe(false);
    // Picking a topic still works with it off.
    await fan.agent.put('/api/me/interests').set('Origin', WEB).send({ categories: ['news'] }).expect(200);
    const picked = (await fan.agent.get('/api/feed/for-you').expect(200)).body.videos;
    expect(picked.slice(0, 6).filter((v: any) => v.title.startsWith('Bulletin')).length).toBeGreaterThanOrEqual(2);

    const visitor = (await fan.agent.get('/api/feed/for-you').expect(200)).body; // (signed in, kept)
    expect(visitor.videos.length).toBeGreaterThan(20);
    const anon = (await (await import('supertest')).default(ctx.http).get('/api/feed/for-you').expect(200)).body;
    expect(anon.videos.length).toBe(24);
  });

  test('a removed or private video never shows, even from a feed worked out before', async () => {
    const w = await world();
    await refreshSignals(ctx.prisma as never, redis);
    const fan = await signIn(ctx.http, ctx.mail, 'fan@example.com');
    const first = (await fan.agent.get('/api/feed/for-you').expect(200)).body.videos[0].id;
    await ctx.prisma.video.update({ where: { id: first }, data: { visibility: 'PRIVATE' } });
    expect((await fan.agent.get('/api/feed/for-you').expect(200)).body.videos.map((v: any) => v.id)).not.toContain(first);
    expect(w).toBeTruthy();
  });

  test('without Redis or before the worker built the pools, it still ranks from the database', async () => {
    await world();
    const ranked = await rankForYou(ctx.prisma as never, null, null);
    expect(ranked.length).toBe(37);
  });
});

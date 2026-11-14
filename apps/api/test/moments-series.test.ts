import request from 'supertest';
import { makeApp, resetDb, signIn, WEB } from './helpers';

let ctx: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => { ctx = await makeApp(); });
beforeEach(async () => { await resetDb(ctx.prisma); ctx.mail.outbox.length = 0; await ctx.clearLimits(); });
afterAll(async () => { await ctx.app.close(); });

async function creator(handle: string) {
  const c = await signIn(ctx.http, ctx.mail, `${handle}@example.com`);
  await c.agent.post('/api/channels').set('Origin', WEB).send({ handle, name: handle }).expect(201);
  return c.agent;
}
let minute = 0;
const moment = async (handle: string, title: string, extra: Record<string, unknown> = {}) => {
  const ch = await ctx.prisma.channel.findUniqueOrThrow({ where: { handle } });
  return ctx.prisma.video.create({ data: { channelId: ch.id, title, durationSeconds: 20, isShort: true, status: 'READY', visibility: 'PUBLIC', mediaLocation: 'PUBLIC', hlsMasterKey: 'hls/master.m3u8', publishedAt: new Date(Date.now() - 60_000 * ++minute), safetyCheckedAt: new Date(), ...extra } });
};
const feed = async (q = '') => (await request(ctx.http).get(`/api/videos?moments=true${q}`).expect(200)).body.videos as any[];

test('Moments carry their description, tags and sound: original, named by the creator, or a licensed work', async () => {
  const me = await creator('dancer');
  const a = await moment('dancer', 'Dance one', { description: 'Kigali moves #dance' });
  const b = await moment('dancer', 'Dance two');
  await me.patch(`/api/hub/videos/${b.id}`).set('Origin', WEB).send({ soundTitle: 'Inanga Night Mix', tags: ['dance', 'kigali'] }).expect(200);

  const list = await feed();
  expect(list.find((v) => v.id === a.id).moment).toMatchObject({ description: 'Kigali moves #dance', tags: [], sound: { kind: 'original' }, series: null });
  expect(list.find((v) => v.id === b.id).moment).toMatchObject({ tags: ['dance', 'kigali'], sound: { kind: 'named', title: 'Inanga Night Mix' } });

  // A verified label's song, matched by Content ID and allowed (earn): its title is the sound.
  await creator('label');
  const song = await moment('label', 'Amahoro (official audio)');
  const label = await ctx.prisma.channel.findUniqueOrThrow({ where: { handle: 'label' } });
  await ctx.prisma.contentClaim.create({ data: { videoId: a.id, referenceVideoId: song.id, ownerChannelId: label.id, policy: 'MONETIZE', matched: 'sound', matchedSeconds: 15, uploadStart: 0, referenceStart: 0 } });
  expect((await feed()).find((v) => v.id === a.id).moment.sound).toEqual({ kind: 'licensed', title: 'Amahoro (official audio)', owner: 'label' });
  // Other feeds stay as they were.
  expect((await request(ctx.http).get('/api/videos').expect(200)).body.videos[0].moment).toBeUndefined();
});

test('series: episodes in order, "Episode 2 of 3", the next one, and opening the feed at an episode', async () => {
  const me = await creator('storyteller');
  const other = await creator('someone');
  const s = (await me.post('/api/hub/series').set('Origin', WEB).send({ title: 'The Lake House' }).expect(201)).body.series;
  const e1 = await moment('storyteller', 'Part one');
  const e2 = await moment('storyteller', 'Part two');
  const e3 = await moment('storyteller', 'Part three');
  // Episode numbers follow the order they are added, unless given.
  for (const e of [e1, e2]) await me.patch(`/api/hub/videos/${e.id}`).set('Origin', WEB).send({ seriesId: s.id }).expect(200);
  expect((await me.patch(`/api/hub/videos/${e3.id}`).set('Origin', WEB).send({ seriesId: s.id, episodeNumber: 3 }).expect(200)).body.video).toMatchObject({ seriesId: s.id, episodeNumber: 3 });
  // Only my own series.
  const theirs = (await other.post('/api/hub/series').set('Origin', WEB).send({ title: 'Not yours' }).expect(201)).body.series;
  await me.patch(`/api/hub/videos/${e1.id}`).set('Origin', WEB).send({ seriesId: theirs.id }).expect(400);

  const list = await feed();
  expect(list.find((v) => v.id === e2.id).moment.series).toEqual({ id: s.id, title: 'The Lake House', episode: 2, count: 3, nextId: e3.id });
  expect(list.find((v) => v.id === e3.id).moment.series).toMatchObject({ episode: 3, nextId: null });

  const page = (await request(ctx.http).get(`/api/series/${s.id}`).expect(200)).body;
  expect(page.series).toMatchObject({ title: 'The Lake House', channel: { handle: 'storyteller' } });
  expect(page.episodes.map((v: any) => [v.title, v.episode])).toEqual([['Part one', 1], ['Part two', 2], ['Part three', 3]]);

  // A shared episode link opens the feed at that episode.
  expect((await feed(`&first=${e1.id}`))[0].id).toBe(e1.id);

  // Deleting the series keeps the Moments.
  expect((await me.get('/api/hub/series').expect(200)).body.series).toEqual([expect.objectContaining({ title: 'The Lake House', episodes: 3 })]);
  await me.delete(`/api/hub/series/${s.id}`).set('Origin', WEB).expect(200);
  expect((await feed()).find((v) => v.id === e2.id).moment.series).toBeNull();
});

import request from 'supertest';
import { makeApp, resetDb, signIn, WEB } from './helpers';
import { playTicket, ticketHolder } from '../src/media/view-quality';
import { ViewCounter } from '../src/media/views';
import { RedisService } from '../src/database/redis.service';

// Which views count (media/view-quality.ts): a play ticket and real watching time by the server's clock; automated
// and abusive traffic recorded as not valid, never counted.
let ctx: Awaited<ReturnType<typeof makeApp>>;
const CHROME = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
beforeAll(async () => {
  ctx = await makeApp({ env: { VIEW_CHECKS: 'full', VIEWS_ALLOW_AUTOMATED: 'false', VIEW_MAX_PER_NETWORK_PER_VIDEO: '2', VIEW_MAX_PER_ACCOUNT_PER_DAY: '3' } });
});
beforeEach(async () => { await resetDb(ctx.prisma); ctx.mail.outbox.length = 0; await ctx.clearLimits(); await ctx.app.get(RedisService).client!.flushdb(); });
afterAll(async () => { await ctx.app.close(); });

async function videos(n: number, durationSeconds = 300) {
  const u = await ctx.prisma.user.create({ data: { email: `maker${Math.random()}@example.com` } });
  const ch = await ctx.prisma.channel.create({ data: { userId: u.id, handle: `maker${Math.floor(Math.random() * 1e6)}`, name: 'Maker' } });
  return Promise.all(Array.from({ length: n }, () => ctx.prisma.video.create({ data: { channelId: ch.id, title: 'Video', durationSeconds, status: 'READY', visibility: 'PUBLIC', mediaLocation: 'PUBLIC', publishedAt: new Date(), safetyCheckedAt: new Date(), hlsMasterKey: 'hls/master.m3u8' } })));
}
/** A ticket issued `ago` ms before now, as if playback had started then. */
const ticketFrom = (videoId: string, ua: string, userId: string | null = null, ago = 40_000) => playTicket(ctx.config.sessionSecret, videoId, ticketHolder(userId, ua), Date.now() - ago);
const view = (agent: any, videoId: string, body: object, ua = CHROME) => agent.post(`/api/videos/${videoId}/views`).set('Origin', WEB).set('User-Agent', ua).send({ watchedSeconds: 35, ...body }).expect(200).then((r: any) => r.body);
const flush = () => new ViewCounter(ctx.prisma as never, ctx.app.get(RedisService).client).flush();

test('a view needs a genuine play ticket, real watching time since it, and counts once; watched seconds are capped by the real time', async () => {
  const [v, other] = await videos(2);
  const anon = request.agent(ctx.http);
  expect(await view(anon, v.id, {})).toEqual({ counted: false, reason: 'ticket' });
  expect(await view(anon, v.id, { ticket: 'forged.ticket.value' })).toEqual({ counted: false, reason: 'ticket' });

  // A ticket just issued: a script cannot count the view before the time a person would need to watch it.
  const fresh = (await anon.post(`/api/videos/${v.id}/play`).set('Origin', WEB).set('User-Agent', CHROME).expect(200)).body.ticket;
  expect(fresh).toMatch(/^\d{13}\.[\w-]{12}\.[\w-]{43}$/);
  expect(await view(anon, v.id, { ticket: fresh })).toEqual({ counted: false, reason: 'too-soon' });

  // For another video, or another browser: refused.
  expect(await view(anon, v.id, { ticket: ticketFrom(other.id, CHROME) })).toEqual({ counted: false, reason: 'ticket' });
  expect(await view(anon, v.id, { ticket: ticketFrom(v.id, 'Mozilla/5.0 Firefox/130.0') })).toEqual({ counted: false, reason: 'ticket' });

  // 40 s after playback started, claiming 290 s watched: counted, with at most 2 x 40 s + 2 s.
  const t = ticketFrom(v.id, CHROME);
  expect(await view(anon, v.id, { ticket: t, watchedSeconds: 290 })).toEqual({ counted: true });
  expect(await view(anon, v.id, { ticket: t })).toEqual({ counted: false, reason: 'ticket-used' });
  await flush();
  const row = await ctx.prisma.video.findUniqueOrThrow({ where: { id: v.id } });
  expect(Number(row.viewCount)).toBe(1);
  expect(Number(row.watchTimeSeconds)).toBeLessThanOrEqual(82);
});

test('automated browsers, and floods from one network or one account, are recorded as not valid and shown to the creator', async () => {
  const vs = await videos(5);
  const v = vs[0];
  // Headless and scripted browsers: not valid.
  for (const ua of ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 HeadlessChrome/130.0 Safari/537.36', 'python-requests/2.32', 'curl/8.5.0']) {
    expect(await view(request.agent(ctx.http), v.id, { ticket: ticketFrom(v.id, ua) }, ua)).toEqual({ counted: false, reason: 'invalid' });
  }
  // Signed out, one network: the first 2 views of the video count, more are not valid (each "browser" different).
  const results = [];
  for (let i = 0; i < 4; i++) { const ua = `${CHROME} build/${i}`; results.push(await view(request.agent(ctx.http), v.id, { ticket: ticketFrom(v.id, ua) }, ua)); }
  expect(results).toEqual([{ counted: true }, { counted: true }, { counted: false, reason: 'invalid' }, { counted: false, reason: 'invalid' }]);

  // Signed in: 3 views a day count; the 4th video's view does not.
  const me = await signIn(ctx.http, ctx.mail, 'fan@example.com');
  const fan = await ctx.prisma.user.findUniqueOrThrow({ where: { email: 'fan@example.com' } });
  const mine = [];
  for (const x of vs.slice(1, 5)) mine.push(await view(me.agent, x.id, { ticket: ticketFrom(x.id, CHROME, fan.id) }));
  expect(mine).toEqual([{ counted: true }, { counted: true }, { counted: true }, { counted: false, reason: 'invalid' }]);

  await flush();
  const stat = await ctx.prisma.videoDailyStat.findFirstOrThrow({ where: { videoId: v.id } });
  expect(stat).toMatchObject({ views: 2, invalidViews: 5 });
  expect(Number((await ctx.prisma.video.findUniqueOrThrow({ where: { id: v.id } })).viewCount)).toBe(2);
  // No watch time can be added to a view that was not valid.
  const bot = 'curl/8.5.0';
  await request(ctx.http).post(`/api/videos/${v.id}/watch`).set('Origin', WEB).set('User-Agent', bot).send({ watchedSeconds: 60 }).expect(200, { seconds: 0 });

  // The creator sees how many views were not counted, for the whole Space: on the first video 2 counted and 5 not
  // valid; on the others the fan's 3 counted and 1 not valid.
  const owner = await ctx.prisma.channel.findFirstOrThrow({ where: { id: v.channelId } });
  await ctx.prisma.user.update({ where: { id: owner.userId }, data: { email: 'owner@example.com', roles: { push: 'CREATOR' } } });
  const creator = await signIn(ctx.http, ctx.mail, 'owner@example.com');
  expect((await creator.agent.get('/api/hub/stats?days=7').expect(200)).body.totals).toMatchObject({ views: 5, invalidViews: 6 });
});

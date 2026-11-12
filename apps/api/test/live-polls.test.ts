import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { io, type Socket } from 'socket.io-client';
import { makeApp, resetDb, signIn, WEB } from './helpers';
import { browserLiveArgs } from '../src/live/browser-hls';

// Live polls and latency, with Redis (as in production: every API server sees the same votes).
let ctx: Awaited<ReturnType<typeof makeApp>>;
let base = '';
const sockets: Socket[] = [];

beforeAll(async () => {
  ctx = await makeApp();
  await new Promise<void>((r) => ctx.http.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(ctx.http.address() as AddressInfo).port}`;
}, 60_000);
beforeEach(async () => { await resetDb(ctx.prisma); ctx.mail.outbox.length = 0; await ctx.clearLimits(); });
afterEach(() => { for (const s of sockets.splice(0)) s.close(); });
afterAll(async () => { await ctx.app.close(); });

async function connect(cookie?: string) {
  const s = io(base, { path: '/api/socket', addTrailingSlash: false, transports: ['websocket'], extraHeaders: { origin: WEB, ...(cookie ? { cookie } : {}) }, forceNew: true });
  sockets.push(s);
  await new Promise<void>((ok, fail) => { s.once('connect', () => ok()); s.once('connect_error', fail); });
  await new Promise((r) => setTimeout(r, 100));
  return s;
}
const cookieOf = (res: request.Response) => (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
const next = <T = any>(s: Socket, event: string, ms = 5000) => new Promise<T>((ok, fail) => { const t = setTimeout(() => fail(new Error(`no ${event}`)), ms); s.once(event, (d: T) => { clearTimeout(t); ok(d); }); });

const redisTest = process.env.REDIS_URL ? test : test.skip;

redisTest('live polls: only the host asks; one vote per account; everyone sees the results; closing stops voting', async () => {
  const host = await signIn(ctx.http, ctx.mail, 'poll-host@example.com');
  await host.agent.post('/api/channels').set('Origin', WEB).send({ handle: 'pollhost', name: 'Poll Host' }).expect(201);
  const id = (await host.agent.get('/api/hub/live').expect(200)).body.stream.id as string;
  const hostSocket = await connect(cookieOf(host.res));
  const ask = { streamId: id, question: 'Next song?', options: ['Afrobeats', 'Gospel', 'Hip hop'] };
  // Not live yet: no poll.
  expect(await hostSocket.emitWithAck('live:poll-start', ask)).toMatchObject({ ok: false });
  await ctx.prisma.liveStream.update({ where: { id }, data: { status: 'LIVE', startedAt: new Date() } });

  const fans = await Promise.all([1, 2, 3].map(async (n) => {
    const f = await signIn(ctx.http, ctx.mail, `poll-fan${n}@example.com`);
    const s = await connect(cookieOf(f.res));
    await s.emitWithAck('join', `live:${id}`);
    return s;
  }));
  // Viewers cannot start polls; questions need 2 to 4 different answers.
  expect(await fans[0].emitWithAck('live:poll-start', ask)).toMatchObject({ ok: false });
  expect(await hostSocket.emitWithAck('live:poll-start', { ...ask, options: ['Only one'] })).toMatchObject({ ok: false, error: expect.stringContaining('2 to 4') });
  expect(await hostSocket.emitWithAck('live:poll-start', { ...ask, options: ['Same', 'same'] })).toMatchObject({ ok: false });

  const shown = next(fans[1], 'poll');
  const started = await hostSocket.emitWithAck('live:poll-start', { ...ask, question: '  Next\nsong?  ' });
  expect(started).toMatchObject({ ok: true, poll: { question: 'Next song?', options: ['Afrobeats', 'Gospel', 'Hip hop'], votes: [0, 0, 0], total: 0, open: true } });
  const pollId = started.poll.id;
  expect((await shown).poll.id).toBe(pollId);

  // Each account votes once; a second vote (even for another answer) is not counted.
  expect(await fans[0].emitWithAck('live:poll-vote', { streamId: id, pollId, option: 0 })).toMatchObject({ ok: true, counted: true });
  expect(await fans[0].emitWithAck('live:poll-vote', { streamId: id, pollId, option: 2 })).toMatchObject({ ok: true, counted: false, poll: { votes: [1, 0, 0] } });
  expect(await fans[1].emitWithAck('live:poll-vote', { streamId: id, pollId, option: 0 })).toMatchObject({ counted: true });
  const results = next(fans[2], 'poll');
  expect(await fans[2].emitWithAck('live:poll-vote', { streamId: id, pollId, option: 1 })).toMatchObject({ ok: true, poll: { votes: [2, 1, 0], total: 3 } });
  expect((await results).poll).toMatchObject({ votes: [2, 1, 0], total: 3 });
  expect(await fans[2].emitWithAck('live:poll-vote', { streamId: id, pollId, option: 9 })).toMatchObject({ ok: false });
  const visitor = await connect();
  expect(await visitor.emitWithAck('live:poll-vote', { streamId: id, pollId, option: 0 })).toMatchObject({ ok: false, error: 'Sign in to vote.' });

  // People who arrive later see the poll with the stream.
  expect((await request(ctx.http).get(`/api/live/${id}`).expect(200)).body.stream.poll).toMatchObject({ id: pollId, total: 3, open: true });
  expect(await hostSocket.emitWithAck('live:poll-close', { streamId: id })).toMatchObject({ ok: true, poll: { open: false, votes: [2, 1, 0] } });
  const late = await signIn(ctx.http, ctx.mail, 'poll-late@example.com');
  const lateSocket = await connect(cookieOf(late.res));
  expect(await lateSocket.emitWithAck('live:poll-vote', { streamId: id, pollId, option: 1 })).toMatchObject({ ok: false, error: 'Voting has closed.' });

  // A new poll replaces the old one, with fresh votes.
  const second = await hostSocket.emitWithAck('live:poll-start', { streamId: id, question: 'Louder?', options: ['Yes', 'No'] });
  expect(second.poll).toMatchObject({ votes: [0, 0], open: true });
  expect(await fans[0].emitWithAck('live:poll-vote', { streamId: id, pollId: second.poll.id, option: 0 })).toMatchObject({ counted: true });
});

test('latency: the host chooses normal or low; viewers are told; low latency cuts browser streams into 1-second pieces', async () => {
  const host = await signIn(ctx.http, ctx.mail, 'latency-host@example.com');
  await host.agent.post('/api/channels').set('Origin', WEB).send({ handle: 'latencyhost', name: 'Latency Host' }).expect(201);
  const stream = (await host.agent.get('/api/hub/live').expect(200)).body.stream;
  expect(stream.latencyMode).toBe('normal');
  await host.agent.patch('/api/hub/live').set('Origin', WEB).send({ latencyMode: 'instant' }).expect(400);
  expect((await host.agent.patch('/api/hub/live').set('Origin', WEB).send({ latencyMode: 'low' }).expect(200)).body.stream.latencyMode).toBe('low');
  expect((await request(ctx.http).get(`/api/live/${stream.id}`).expect(200)).body.stream.latencyMode).toBe('low');

  const at = (args: string[], flag: string) => args.filter((_, i) => args[i - 1] === flag);
  const normal = browserLiveArgs('/tmp/x');
  const low = browserLiveArgs('/tmp/x', 1);
  expect(at(normal, '-hls_time')).toEqual(['2', '2']);
  expect(at(normal, '-g')).toEqual(['60', '60']);
  expect(at(low, '-hls_time')).toEqual(['1', '1']);
  expect(at(low, '-g')).toEqual(['30', '30']);
});

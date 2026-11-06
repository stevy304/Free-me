import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { io, type Socket } from 'socket.io-client';
import { makeApp, resetDb, signIn, WEB } from './helpers';
import { Billing } from '../src/billing/billing';

// Instant updates and live streams over a real socket, with real encoding (local storage, jobs inside the API).
const dir = mkdtempSync(join(tmpdir(), 'freeme-live-'));
let ctx: Awaited<ReturnType<typeof makeApp>>;
let base = '';
const sockets: Socket[] = [];

beforeAll(async () => {
  ctx = await makeApp({ redis: false, storageDir: join(dir, 'storage'), env: { LIVE_RTMP_URL: 'rtmp://live.freeme.test/live', LIVE_RTMP_SECRET: 'rtmp-secret-0123456789abcdef' } });
  await new Promise<void>((r) => ctx.http.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(ctx.http.address() as AddressInfo).port}`;
}, 60_000);
beforeEach(async () => { await resetDb(ctx.prisma); ctx.mail.outbox.length = 0; await ctx.clearLimits(); });
afterEach(() => { for (const s of sockets.splice(0)) s.close(); });
afterAll(async () => { await ctx.app.close(); rmSync(dir, { recursive: true, force: true }); });

/** A socket like the web app's: WebSocket only, with the page's cookie and origin. */
async function connect(cookie?: string) {
  const s = io(base, { path: '/api/socket', addTrailingSlash: false, transports: ['websocket'], extraHeaders: { origin: WEB, ...(cookie ? { cookie } : {}) }, forceNew: true });
  sockets.push(s);
  await new Promise<void>((ok, fail) => { s.once('connect', () => ok()); s.once('connect_error', fail); });
  await new Promise((r) => setTimeout(r, 100)); // the server signs the socket in
  return s;
}
const cookieOf = (res: request.Response) => (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
const next = <T = any>(s: Socket, event: string, ms = 10_000) => new Promise<T>((ok, fail) => { const t = setTimeout(() => fail(new Error(`no ${event}`)), ms); s.once(event, (d: T) => { clearTimeout(t); ok(d); }); });

test('instant updates: the creator hears about a comment at once; viewers of the video hear about new comments and Sparks', async () => {
  const maker = await signIn(ctx.http, ctx.mail, 'maker@example.com');
  const ch = (await maker.agent.post('/api/channels').set('Origin', WEB).send({ handle: 'maker', name: 'Maker' }).expect(201)).body.channel;
  const v = await ctx.prisma.video.create({ data: { channelId: ch.id, title: 'Lake', durationSeconds: 60, status: 'READY', visibility: 'PUBLIC', mediaLocation: 'PUBLIC', publishedAt: new Date() } });
  const fan = await signIn(ctx.http, ctx.mail, 'fan@example.com');

  const makerSocket = await connect(cookieOf(maker.res));
  const viewer = await connect();
  expect(await viewer.emitWithAck('join', `video:${v.id}`)).toEqual({ ok: true });
  expect(await viewer.emitWithAck('join', 'user:someone-else')).toEqual({ ok: false });

  const heard = Promise.all([next(makerSocket, 'notifications'), next(viewer, 'comments')]);
  await fan.agent.post(`/api/videos/${v.id}/comments`).set('Origin', WEB).send({ content: 'Lovely' }).expect(201);
  const [, c] = await heard;
  expect(c).toMatchObject({ videoId: v.id });
  const spark = next(viewer, 'reactions');
  await fan.agent.put(`/api/videos/${v.id}/reaction`).set('Origin', WEB).send({ value: 'like' }).expect(200);
  expect(await spark).toEqual({ likeCount: 1 });

  // Another site cannot connect with a viewer's cookie.
  const evil = io(base, { path: '/api/socket', addTrailingSlash: false, transports: ['websocket'], extraHeaders: { origin: 'https://evil.example', cookie: cookieOf(maker.res) }, forceNew: true });
  sockets.push(evil);
  await next(evil, 'disconnect');
}, 30_000);

test('Live Studio from the browser: Premium only; recording pieces become HLS for viewers, with chat and a "live" notice; the recording becomes a video', async () => {
  const host = await signIn(ctx.http, ctx.mail, 'host@example.com');
  await host.agent.post('/api/channels').set('Origin', WEB).send({ handle: 'host', name: 'Host' }).expect(201);
  const fan = await signIn(ctx.http, ctx.mail, 'fan@example.com');
  await fan.agent.post('/api/channels/host/follow').set('Origin', WEB).expect(200);

  let studio = (await host.agent.get('/api/hub/live').expect(200)).body;
  expect(studio).toMatchObject({ premium: false, encoder: null, stream: { status: 'IDLE' } });
  const hostSocket = await connect(cookieOf(host.res));
  expect(await hostSocket.emitWithAck('live:start', studio.stream.id)).toEqual({ ok: false, error: 'Live Studio is part of Premium.' });

  const hostUser = await ctx.prisma.user.findUniqueOrThrow({ where: { email: 'host@example.com' } });
  await new Billing(ctx.prisma as never, ctx.config).grantPremium(hostUser.id, 1);
  await host.agent.patch('/api/hub/live').set('Origin', WEB).send({ title: 'Morning show' }).expect(200);
  studio = (await host.agent.get('/api/hub/live').expect(200)).body;
  expect(studio.encoder).toEqual({ server: 'rtmp://live.freeme.test/live', streamKey: expect.stringMatching(/^fm_/) });
  const id = studio.stream.id;

  const viewer = await connect(cookieOf(fan.res));
  await viewer.emitWithAck('join', `live:${id}`);
  const started = next(viewer, 'started');
  expect(await hostSocket.emitWithAck('live:start', id)).toEqual({ ok: true, id });
  await started;
  expect((await fan.agent.get('/api/me/notifications').expect(200)).body.notifications[0]).toMatchObject({ type: 'LIVE', text: 'Host is live: "Morning show"', href: `/live/${id}` });

  // The browser's recording (WebM, as MediaRecorder makes it), sent in pieces.
  const webm = join(dir, 'cam.webm');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '6', '-c:v', 'libvpx', '-deadline', 'realtime', '-b:v', '1M', '-c:a', 'libopus', webm]);
  const data = readFileSync(webm);
  for (let i = 0; i < data.length; i += 64 * 1024) expect(await hostSocket.emitWithAck('live:chunk', [id, data.subarray(i, i + 64 * 1024)])).toEqual({ ok: true });

  // Viewers find it live and play HLS from storage.
  let pl = '';
  for (let i = 0; i < 100 && !pl.includes('.ts'); i++) { pl = (await request(ctx.http).get(`/api/storage/local/pub/live/${id}/index.m3u8`)).text ?? ''; await new Promise((r) => setTimeout(r, 200)); }
  expect(pl).toContain('#EXTM3U');
  const seg = pl.split('\n').find((l) => l.endsWith('.ts'))!;
  expect((await request(ctx.http).get(`/api/storage/local/pub/live/${id}/${seg}`).expect(200)).body.length).toBeGreaterThan(1000);
  const now = (await request(ctx.http).get('/api/live').expect(200)).body.streams;
  expect(now).toEqual([expect.objectContaining({ id, title: 'Morning show', status: 'LIVE', playbackUrl: expect.stringContaining(`/live/${id}/index.m3u8`), channel: expect.objectContaining({ handle: 'host', isVerified: true }) })]);

  // Chat: signed-in viewers only, heard by everyone in the room, kept for latecomers.
  const line = next(hostSocket, 'chat');
  await hostSocket.emitWithAck('join', `live:${id}`);
  expect(await viewer.emitWithAck('live:chat', { streamId: id, text: 'Hello from Kigali!' })).toEqual({ ok: true });
  expect(await line).toMatchObject({ text: 'Hello from Kigali!', author: { name: expect.any(String), host: false } });
  expect((await request(ctx.http).get(`/api/live/${id}`).expect(200)).body.chat).toHaveLength(1);
  const anon = await connect();
  expect(await anon.emitWithAck('live:chat', { streamId: id, text: 'hi' })).toEqual({ ok: false, error: 'Sign in to chat.' });

  // End: viewers are told; the recording becomes a private video that is processed like an upload.
  const ended = next(viewer, 'ended', 30_000);
  expect(await hostSocket.emitWithAck('live:stop', id)).toEqual({ ok: true });
  await ended;
  const s = await ctx.prisma.liveStream.findUniqueOrThrow({ where: { id } });
  expect(s).toMatchObject({ status: 'ENDED', source: 'browser' });
  expect(s.replayVideoId).toBeTruthy();
  let replay: any;
  for (let i = 0; i < 300; i++) { replay = (await host.agent.get(`/api/hub/videos/${s.replayVideoId}`)).body.video; if (replay.status === 'READY' && replay.processingStage === 'Ready') break; await new Promise((r) => setTimeout(r, 200)); }
  expect(replay).toMatchObject({ title: 'Morning show (live)', visibility: 'PRIVATE', status: 'READY' });
  expect(replay.durationSeconds).toBeGreaterThanOrEqual(4);
  await request(ctx.http).get(`/api/storage/local/pub/live/${id}/index.m3u8`).expect(404);
  // The next stream is a new one; the encoder key stays the same.
  const again = (await host.agent.get('/api/hub/live').expect(200)).body;
  expect(again.stream).toMatchObject({ status: 'IDLE' });
  expect(again.stream.id).not.toBe(id);
  expect(again.encoder.streamKey).toBe(studio.encoder.streamKey);
}, 120_000);

test('OBS and TV encoders: nginx-rtmp asks the API; a valid key goes live under the stream id, never the key', async () => {
  const host = await signIn(ctx.http, ctx.mail, 'host@example.com');
  await host.agent.post('/api/channels').set('Origin', WEB).send({ handle: 'host', name: 'Host' }).expect(201);
  const u = await ctx.prisma.user.findUniqueOrThrow({ where: { email: 'host@example.com' } });
  await new Billing(ctx.prisma as never, ctx.config).grantPremium(u.id, 1);
  const { encoder, stream } = (await host.agent.get('/api/hub/live').expect(200)).body;

  await request(ctx.http).post('/api/live/rtmp/publish?secret=wrong').type('form').send({ name: encoder.streamKey }).expect(403);
  await request(ctx.http).post('/api/live/rtmp/publish?secret=rtmp-secret-0123456789abcdef').type('form').send({ name: 'fm_guess' }).expect(403);
  const ok = await request(ctx.http).post('/api/live/rtmp/publish?secret=rtmp-secret-0123456789abcdef').type('form').send({ app: 'live', name: encoder.streamKey }).expect(302);
  expect(ok.headers.location).toBe(stream.id);
  expect(await ctx.prisma.liveStream.findUniqueOrThrow({ where: { id: stream.id } })).toMatchObject({ status: 'LIVE', source: 'rtmp' });
  await request(ctx.http).post('/api/live/rtmp/done?secret=rtmp-secret-0123456789abcdef').type('form').send({ name: stream.id }).expect(200);
  expect((await ctx.prisma.liveStream.findUniqueOrThrow({ where: { id: stream.id } })).status).toBe('ENDED');

  // A new key stops the old one.
  const fresh = (await host.agent.post('/api/hub/live/key').set('Origin', WEB).expect(200)).body.streamKey;
  expect(fresh).not.toBe(encoder.streamKey);
  await request(ctx.http).post('/api/live/rtmp/publish?secret=rtmp-secret-0123456789abcdef').type('form').send({ name: encoder.streamKey }).expect(403);
});

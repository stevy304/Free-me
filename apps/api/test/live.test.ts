import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

test('Free browser streaming; recording pieces become HLS for viewers, with chat and a "live" notice; the recording becomes a video', async () => {
  const host = await signIn(ctx.http, ctx.mail, 'host@example.com');
  await host.agent.post('/api/channels').set('Origin', WEB).send({ handle: 'host', name: 'Host' }).expect(201);
  const fan = await signIn(ctx.http, ctx.mail, 'fan@example.com');
  await fan.agent.post('/api/channels/host/follow').set('Origin', WEB).expect(200);

  const studio = (await host.agent.get('/api/hub/live').expect(200)).body;
  expect(studio).toMatchObject({ premium: false, encoder: null, stream: { status: 'IDLE' } });
  const hostSocket = await connect(cookieOf(host.res));
  await host.agent.post('/api/hub/live/key').set('Origin', WEB).send({}).expect(403);
  await host.agent.patch('/api/hub/live').set('Origin', WEB).send({ title: 'Morning show' }).expect(200);
  const id = studio.stream.id;

  const viewer = await connect(cookieOf(fan.res));
  await viewer.emitWithAck('join', `live:${id}`);
  const started = next(viewer, 'started');
  const session = await hostSocket.emitWithAck('live:start', id);
  expect(session).toEqual({ ok: true, id, resumeKey: expect.any(String), reconnectMs: 30_000 });
  await started;
  expect((await fan.agent.get('/api/me/notifications').expect(200)).body.notifications[0]).toMatchObject({ type: 'LIVE', text: 'Host is live: "Morning show"', href: `/live/${id}` });

  // The browser's recording (WebM, as MediaRecorder makes it), sent in pieces.
  const webm = join(dir, 'cam.webm');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '6', '-c:v', 'libvpx', '-deadline', 'realtime', '-b:v', '1M', '-c:a', 'libopus', webm]);
  const data = readFileSync(webm);
  const size = 64 * 1024;
  const firstChunk = data.subarray(0, size);
  expect(await hostSocket.emitWithAck('live:chunk', [id, 0, firstChunk])).toEqual({ ok: true });
  const interrupted = next(viewer, 'live:signal');
  hostSocket.disconnect();
  expect(await interrupted).toEqual({ reconnectUntil: expect.any(Number) });
  expect((await request(ctx.http).get(`/api/live/${id}`).expect(200)).body.stream.status).toBe('LIVE');
  expect(await viewer.emitWithAck('live:resume', [id, session.resumeKey])).toEqual({ ok: false });

  const resumedHost = await connect(cookieOf(host.res));
  expect(await resumedHost.emitWithAck('live:resume', [id, 'x'.repeat(32)])).toEqual({ ok: false });
  const restored = next(viewer, 'live:signal');
  expect(await resumedHost.emitWithAck('live:resume', [id, session.resumeKey])).toEqual({ ok: true });
  expect(await restored).toEqual({ reconnectUntil: null });
  // A lost acknowledgement must not cause a WebM chunk to be written twice.
  expect(await resumedHost.emitWithAck('live:chunk', [id, 0, firstChunk])).toEqual({ ok: true });
  for (let i = size; i < data.length; i += size) {
    expect(await resumedHost.emitWithAck('live:chunk', [id, i / size, data.subarray(i, i + size)])).toEqual({ ok: true });
  }

  // The master is published only after both variants have playable, aligned segments.
  const livePath = `/api/storage/local/pub/live/${id}`;
  let master = '';
  for (let i = 0; i < 100 && !master.includes('720p.m3u8'); i++) {
    master = (await request(ctx.http).get(`${livePath}/index.m3u8`)).text ?? '';
    await new Promise((r) => setTimeout(r, 200));
  }
  expect(master).toContain('#EXTM3U');
  expect(master).toMatch(/RESOLUTION=640x360[^\n]*\n360p.m3u8/);
  expect(master).toMatch(/RESOLUTION=1280x720[^\n]*\n720p.m3u8/);
  const variants = await Promise.all([360, 720].map(async (height) => {
    const variant = (await request(ctx.http).get(`${livePath}/${height}p.m3u8`).expect(200)).text;
    const seg = variant.split('\n').find((l: string) => l.endsWith('.ts'))!;
    const { body } = await request(ctx.http).get(`${livePath}/${seg}`).expect(200);
    const file = join(dir, `${height}p.ts`);
    writeFileSync(file, body);
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,start_time', '-of', 'json', file], { encoding: 'utf8' })).streams[0];
    expect(probe).toMatchObject({ width: height === 360 ? 640 : 1280, height });
    return { start: probe.start_time, durations: variant.match(/^#EXTINF:.+/gm) };
  }));
  expect(variants[0]).toEqual(variants[1]);
  const now = (await request(ctx.http).get('/api/live').expect(200)).body.streams;
  expect(now).toEqual([expect.objectContaining({ id, title: 'Morning show', status: 'LIVE', playbackUrl: expect.stringContaining(`/live/${id}/index.m3u8`), channel: expect.objectContaining({ handle: 'host', isVerified: false }) })]);

  // Chat: signed-in viewers only, heard by everyone in the room, kept for latecomers.
  const line = next(resumedHost, 'chat');
  await resumedHost.emitWithAck('join', `live:${id}`);
  expect(await viewer.emitWithAck('live:chat', { streamId: id, text: 'Hello from Kigali!' })).toEqual({ ok: true });
  expect(await line).toMatchObject({ text: 'Hello from Kigali!', author: { name: expect.any(String), host: false } });
  expect((await request(ctx.http).get(`/api/live/${id}`).expect(200)).body.chat).toHaveLength(1);
  const anon = await connect();
  expect(await anon.emitWithAck('live:chat', { streamId: id, text: 'hi' })).toEqual({ ok: false, error: 'Sign in to chat.' });

  // End: viewers are told; the recording becomes a video processed like an upload, as the stream's settings say.
  await ctx.prisma.liveStream.update({ where: { id }, data: { replayVisibility: 'UNLISTED', description: 'Recorded live' } });
  const ended = next(viewer, 'ended', 30_000);
  expect(await resumedHost.emitWithAck('live:stop', id)).toEqual({ ok: true });
  await ended;
  const s = await ctx.prisma.liveStream.findUniqueOrThrow({ where: { id } });
  expect(s).toMatchObject({ status: 'ENDED', source: 'browser' });
  expect(s.replayVideoId).toBeTruthy();
  let replay: any;
  for (let i = 0; i < 300; i++) { replay = (await host.agent.get(`/api/hub/videos/${s.replayVideoId}`)).body.video; if (replay.status === 'READY' && replay.processingStage === 'Ready') break; await new Promise((r) => setTimeout(r, 200)); }
  expect(replay).toMatchObject({ title: 'Morning show (live)', visibility: 'UNLISTED', description: 'Recorded live', status: 'READY' });
  expect(replay.durationSeconds).toBeGreaterThanOrEqual(4);
  await request(ctx.http).get(`/api/storage/local/pub/live/${id}/index.m3u8`).expect(404);
  // The next stream is a new one; the encoder key stays the same.
  const again = (await host.agent.get('/api/hub/live').expect(200)).body;
  expect(again.stream).toMatchObject({ status: 'IDLE' });
  expect(again.stream.id).not.toBe(id);
  expect(again.encoder).toBeNull();
}, 120_000);

test('OBS and TV encoders: nginx-rtmp asks the API; a valid key goes live under the stream id, never the key', async () => {
  const host = await signIn(ctx.http, ctx.mail, 'host@example.com');
  await host.agent.post('/api/channels').set('Origin', WEB).send({ handle: 'host', name: 'Host' }).expect(201);
  const u = await ctx.prisma.user.findUniqueOrThrow({ where: { email: 'host@example.com' } });
  await new Billing(ctx.prisma as never, ctx.config).grantPremium(u.id, 1);
  const studioResponse = await host.agent.get('/api/hub/live').expect(200);
  expect(studioResponse.headers['cache-control']).toBe('private, no-store');
  const { encoder, stream } = studioResponse.body;

  await request(ctx.http).post('/api/live/rtmp/publish?secret=wrong').type('form').send({ name: encoder.streamKey }).expect(403);
  await request(ctx.http).post('/api/live/rtmp/publish?secret=rtmp-secret-0123456789abcdef').type('form').send({ name: 'fm_guess' }).expect(403);
  const ok = await request(ctx.http).post('/api/live/rtmp/publish?secret=rtmp-secret-0123456789abcdef').type('form').send({ app: 'live', name: encoder.streamKey, call: 'publish', flashver: 'FMLE/3.0', tcurl: encoder.server, pageurl: '', swfurl: '', clientid: '12' }).expect(302);
  expect(ok.headers.location).toBe(stream.id);
  expect(await ctx.prisma.liveStream.findUniqueOrThrow({ where: { id: stream.id } })).toMatchObject({ status: 'LIVE', source: 'rtmp' });
  await host.agent.post('/api/hub/live/key').set('Origin', WEB).send({}).expect(400);
  await request(ctx.http).post('/api/live/rtmp/update?secret=wrong').type('form').send({ name: stream.id }).expect(403);
  await request(ctx.http).post('/api/live/rtmp/update?secret=rtmp-secret-0123456789abcdef').type('form').send({ name: stream.id, call: 'update_publish', time: '10', timestamp: '10000', clientid: '12' }).expect(200);
  await request(ctx.http).post('/api/live/rtmp/update?secret=rtmp-secret-0123456789abcdef').type('form').send({ name: encoder.streamKey }).expect(200);
  await host.agent.post('/api/hub/live/end').set('Origin', WEB).send({}).expect(200);
  await request(ctx.http).post('/api/live/rtmp/publish?secret=rtmp-secret-0123456789abcdef').type('form').send({ name: encoder.streamKey }).expect(403);
  await request(ctx.http).post('/api/live/rtmp/update?secret=rtmp-secret-0123456789abcdef').type('form').send({ name: stream.id }).expect(403);
  await request(ctx.http).post('/api/live/rtmp/done?secret=rtmp-secret-0123456789abcdef').type('form').send({ name: stream.id }).expect(200);
  expect((await ctx.prisma.liveStream.findUniqueOrThrow({ where: { id: stream.id } })).status).toBe('ENDED');

  // A new key stops the old one.
  const fresh = (await host.agent.post('/api/hub/live/key').set('Origin', WEB).expect(200)).body.streamKey;
  expect(fresh).not.toBe(encoder.streamKey);
  await request(ctx.http).post('/api/live/rtmp/publish?secret=rtmp-secret-0123456789abcdef').type('form').send({ name: encoder.streamKey }).expect(403);
});

test('free guest rooms admit two guests and only relay signals between members and their host', async () => {
  const owner = await signIn(ctx.http, ctx.mail, 'studio-owner@example.com');
  await owner.agent.post('/api/channels').set('Origin', WEB).send({ handle: 'studio.owner', name: 'Studio owner' }).expect(201);
  const { stream } = (await owner.agent.get('/api/hub/live').expect(200)).body;
  await request(ctx.http).get('/api/live/ice').expect(401);
  await owner.agent.get('/api/live/ice').expect(200, { iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }] });
  const host = await connect(cookieOf(owner.res));
  const invite = await host.emitWithAck('live:guest-open', { streamId: stream.id, basic: false });
  expect(invite).toMatchObject({ ok: true, limit: 2, token: expect.any(String) });
  const guest = async (i: number) => {
    const account = await signIn(ctx.http, ctx.mail, `studio-guest-${i}@example.com`);
    return connect(cookieOf(account.res));
  };
  const first = await guest(1), second = await guest(2), third = await guest(3);
  expect(await first.emitWithAck('live:guest-join', invite.token)).toEqual({ ok: true, host: host.id });
  expect(await second.emitWithAck('live:guest-join', invite.token)).toEqual({ ok: true, host: host.id });
  expect(await third.emitWithAck('live:guest-join', invite.token)).toMatchObject({ ok: false, error: 'The guest seats are full.' });
  expect(await first.emitWithAck('live:guest-signal', { target: second.id, payload: { candidate: {} } })).toEqual({ ok: false });
  const heard = next(host, 'live:guest-signal');
  expect(await first.emitWithAck('live:guest-signal', { target: host.id, payload: { candidate: {} } })).toEqual({ ok: true });
  await expect(heard).resolves.toMatchObject({ from: first.id, payload: { candidate: {} } });
  const removed = next(first, 'live:guest-closed');
  expect(await host.emitWithAck('live:guest-remove', first.id)).toEqual({ ok: true });
  await removed;
  expect(await third.emitWithAck('live:guest-join', invite.token)).toEqual({ ok: true, host: host.id });
});

test('stream settings: description, schedule, who can find it; chat off, followers only, slow mode; live captions only from the host', async () => {
  const host = await signIn(ctx.http, ctx.mail, 'settings-host@example.com');
  const ch = (await host.agent.post('/api/channels').set('Origin', WEB).send({ handle: 'setshost', name: 'Host' }).expect(201)).body.channel;
  await new Billing(ctx.prisma as never, ctx.config).grantPremium((await ctx.prisma.user.findUniqueOrThrow({ where: { email: 'settings-host@example.com' } })).id, 1);
  const studio = (await host.agent.get('/api/hub/live').expect(200)).body;
  const id = studio.stream.id as string;
  expect(studio.stream).toMatchObject({ visibility: 'PUBLIC', chat: { mode: 'everyone', slowModeSeconds: 0 }, captionsEnabled: true, saveReplay: true, replayVisibility: 'PRIVATE' });

  const soon = new Date(Date.now() + 2 * 3600_000).toISOString();
  await host.agent.patch('/api/hub/live').set('Origin', WEB).send({ slowModeSeconds: 7 }).expect(400);
  await host.agent.patch('/api/hub/live').set('Origin', WEB).send({ scheduledFor: new Date(Date.now() - 3600_000).toISOString() }).expect(400);
  const saved = (await host.agent.patch('/api/hub/live').set('Origin', WEB).send({ title: 'Morning show', description: 'News and music from Kigali', scheduledFor: soon, replayVisibility: 'UNLISTED' }).expect(200)).body.stream;
  expect(saved).toMatchObject({ title: 'Morning show', description: 'News and music from Kigali', scheduledFor: soon, replayVisibility: 'UNLISTED' });
  // Planned public streams are listed as upcoming; unlisted ones are not.
  expect((await request(ctx.http).get('/api/live').expect(200)).body.upcoming.map((s: any) => s.id)).toEqual([id]);
  await host.agent.patch('/api/hub/live').set('Origin', WEB).send({ visibility: 'UNLISTED' }).expect(200);
  expect((await request(ctx.http).get('/api/live').expect(200)).body.upcoming).toEqual([]);

  // Live (set directly: encoding is covered by the test above).
  await ctx.prisma.liveStream.update({ where: { id }, data: { status: 'LIVE', startedAt: new Date() } });
  const fan = await signIn(ctx.http, ctx.mail, 'settings-fan@example.com');
  const fanSocket = await connect(cookieOf(fan.res));
  const hostSocket = await connect(cookieOf(host.res));
  await fanSocket.emitWithAck('join', `live:${id}`);
  const say = (s: Socket, text: string) => s.emitWithAck('live:chat', { streamId: id, text });

  await host.agent.patch('/api/hub/live').set('Origin', WEB).send({ chatMode: 'off' }).expect(200);
  expect(await say(fanSocket, 'hello')).toEqual({ ok: false, error: 'Chat is turned off for this stream.' });
  expect(await say(hostSocket, 'Welcome!')).toEqual({ ok: true }); // the host can always write
  await host.agent.patch('/api/hub/live').set('Origin', WEB).send({ chatMode: 'followers' }).expect(200);
  expect((await say(fanSocket, 'hello')).error).toContain('Only followers can chat');
  await fan.agent.post('/api/channels/setshost/follow').set('Origin', WEB).expect(200);
  expect(await say(fanSocket, 'hello')).toEqual({ ok: true });
  await host.agent.patch('/api/hub/live').set('Origin', WEB).send({ chatMode: 'everyone', slowModeSeconds: 30 }).expect(200);
  expect(await say(fanSocket, 'one')).toEqual({ ok: true });
  expect(await say(fanSocket, 'two')).toEqual({ ok: false, error: 'Slow mode: one message every 30 seconds.' });

  // Live captions: the host's lines reach viewers; nobody else can send them; off when the host turns them off.
  const heard = next<{ text: string; final: boolean }>(fanSocket, 'caption');
  expect(await hostSocket.emitWithAck('live:caption', { streamId: id, text: '  Good morning,\nKigali ', final: true })).toEqual({ ok: true });
  expect(await heard).toMatchObject({ text: 'Good morning, Kigali', final: true });
  expect(await fanSocket.emitWithAck('live:caption', { streamId: id, text: 'fake caption' })).toEqual({ ok: false });
  await host.agent.patch('/api/hub/live').set('Origin', WEB).send({ captionsEnabled: false }).expect(200);
  expect(await hostSocket.emitWithAck('live:caption', { streamId: id, text: 'not shown' })).toEqual({ ok: false });
  expect((await request(ctx.http).get(`/api/live/${id}`).expect(200)).body.stream).toMatchObject({ description: 'News and music from Kigali', chat: { mode: 'everyone', slowModeSeconds: 30 }, captionsEnabled: false });
  expect(ch.handle).toBe('setshost');
});


test('unlisted streams do not notify followers and old scheduled times do not block live settings', async () => {
  const host = await signIn(ctx.http, ctx.mail, 'private-host@example.com');
  await host.agent.post('/api/channels').set('Origin', WEB).send({ handle: 'private-host', name: 'Private Host' }).expect(201);
  const fan = await signIn(ctx.http, ctx.mail, 'private-fan@example.com');
  await fan.agent.post('/api/channels/private-host/follow').set('Origin', WEB).expect(200);
  const user = await ctx.prisma.user.findUniqueOrThrow({ where: { email: 'private-host@example.com' } });
  await new Billing(ctx.prisma as never, ctx.config).grantPremium(user.id, 1);
  const { encoder, stream } = (await host.agent.get('/api/hub/live').expect(200)).body;
  const scheduledFor = new Date(Date.now() - 3600_000);
  await ctx.prisma.liveStream.update({ where: { id: stream.id }, data: { visibility: 'UNLISTED', scheduledFor } });
  await request(ctx.http).post('/api/live/rtmp/publish?secret=rtmp-secret-0123456789abcdef').type('form').send({ name: encoder.streamKey }).expect(302);
  expect(await ctx.prisma.notification.count({ where: { liveStreamId: stream.id } })).toBe(0);
  await host.agent.patch('/api/hub/live').set('Origin', WEB).send({ scheduledFor: scheduledFor.toISOString(), description: 'Updated while live' }).expect(200);
  await host.agent.patch('/api/hub/live').set('Origin', WEB).send({ title: '   ' }).expect(400);
  for (const field of ['title', 'description', 'visibility', 'chatMode', 'saveReplay', 'captionsEnabled', 'slowModeSeconds', 'replayVisibility']) {
    await host.agent.patch('/api/hub/live').set('Origin', WEB).send({ [field]: null }).expect(400);
  }
  await host.agent.post('/api/hub/live/end').set('Origin', WEB).send({}).expect(200);
});

test('concurrent first key requests receive one working key', async () => {
  const host = await signIn(ctx.http, ctx.mail, 'keys-host@example.com');
  await host.agent.post('/api/channels').set('Origin', WEB).send({ handle: 'keys-host', name: 'Keys Host' }).expect(201);
  const { LiveService } = await import('../src/live/live.service');
  const user = await ctx.prisma.user.findUniqueOrThrow({ where: { email: 'keys-host@example.com' } });
  const keys = await Promise.all(Array.from({ length: 8 }, () => ctx.app.get(LiveService).streamKey(user.id)));
  expect(new Set(keys).size).toBe(1);
  expect((await ctx.prisma.channel.findUniqueOrThrow({ where: { userId: user.id } })).liveStreamKey).toBe(keys[0]);
});


test('concurrent studio requests share one current broadcast', async () => {
  const host = await signIn(ctx.http, ctx.mail, 'tabs-host@example.com');
  await host.agent.post('/api/channels').set('Origin', WEB).send({ handle: 'tabs-host', name: 'Tabs Host' }).expect(201);
  const { LiveService } = await import('../src/live/live.service');
  const user = await ctx.prisma.user.findUniqueOrThrow({ where: { email: 'tabs-host@example.com' } });
  const streams = await Promise.all(Array.from({ length: 8 }, () => ctx.app.get(LiveService).mine(user.id)));
  expect(new Set(streams.map((s) => s.id)).size).toBe(1);
});

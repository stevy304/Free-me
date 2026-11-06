import request from 'supertest';
import webpush, { WebPushError } from 'web-push';
import { makeApp, resetDb, signIn, WEB } from './helpers';
import { createPushSender, setPushSender, type PushMessage } from '../src/push/push';

// Phone notifications (Web Push): the server's key is made once, devices subscribe and unsubscribe, new videos and
// replies go out as pushes, and devices the push service no longer knows are removed.
let ctx: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => { ctx = await makeApp(); });
beforeEach(async () => { await resetDb(ctx.prisma); ctx.mail.outbox.length = 0; await ctx.clearLimits(); });
afterAll(async () => { setPushSender(null); await ctx.app.close(); });

const device = (n: number) => ({ endpoint: `https://push.example.test/send/device-${n}`, keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' } });

test('devices subscribe; new videos and replies are pushed with words and a link', async () => {
  const key = (await request(ctx.http).get('/api/push/key').expect(200)).body.publicKey;
  expect(key).toMatch(/^[A-Za-z0-9_-]{80,}$/);
  expect((await request(ctx.http).get('/api/push/key').expect(200)).body.publicKey).toBe(key); // made once
  const row = await ctx.prisma.appSetting.findUniqueOrThrow({ where: { key: 'push' } });
  expect(JSON.stringify(row.value)).toContain('enc:'); // private key encrypted

  const maker = await signIn(ctx.http, ctx.mail, 'maker@example.com');
  const ch = (await maker.agent.post('/api/channels').set('Origin', WEB).send({ handle: 'maker', name: 'Maker Films' }).expect(201)).body.channel;
  const fan = await signIn(ctx.http, ctx.mail, 'fan@example.com');
  await request(ctx.http).post('/api/push/subscriptions').set('Origin', WEB).send(device(1)).expect(401);
  await fan.agent.post('/api/push/subscriptions').set('Origin', WEB).send({ endpoint: 'http://insecure.test/x', keys: device(1).keys }).expect(400);
  await fan.agent.post('/api/push/subscriptions').set('Origin', WEB).send(device(1)).expect(200);
  await fan.agent.post('/api/push/subscriptions').set('Origin', WEB).send(device(1)).expect(200); // again: still one
  await maker.agent.post('/api/push/subscriptions').set('Origin', WEB).send(device(2)).expect(200);
  expect(await ctx.prisma.pushSubscription.count()).toBe(2);
  await fan.agent.post('/api/channels/maker/follow').set('Origin', WEB).expect(200);

  const sent: Array<{ to: string[]; msg: PushMessage }> = [];
  setPushSender(async (to, msg) => { sent.push({ to, msg }); });
  const fanId = (await ctx.prisma.user.findUniqueOrThrow({ where: { email: 'fan@example.com' } })).id;
  const makerId = (await ctx.prisma.user.findUniqueOrThrow({ where: { email: 'maker@example.com' } })).id;

  const v = await ctx.prisma.video.create({ data: { channelId: ch.id, title: 'Gorillas of Musanze', durationSeconds: 60, status: 'READY', visibility: 'PRIVATE', mediaLocation: 'PRIVATE', hlsMasterKey: 'hls/master.m3u8' } });
  await maker.agent.patch(`/api/hub/videos/${v.id}`).set('Origin', WEB).send({ visibility: 'PUBLIC' }).expect(200);
  const c = (await fan.agent.post(`/api/videos/${v.id}/comments`).set('Origin', WEB).send({ content: 'Beautiful   light!' }).expect(201)).body.comment;
  await maker.agent.post(`/api/videos/${v.id}/comments`).set('Origin', WEB).send({ content: 'Thank you, it was 6am.', parentId: c.id }).expect(201);
  await new Promise((r) => setTimeout(r, 300));
  expect(sent).toEqual([
    { to: [fanId], msg: { title: 'Maker Films posted a new video', body: 'Gorillas of Musanze', url: `/watch?v=${v.id}`, tag: `video-${v.id}` } },
    { to: [makerId], msg: expect.objectContaining({ title: expect.stringMatching(/ on Gorillas of Musanze$/), body: 'Beautiful light!', url: `/watch?v=${v.id}&c=${c.id}` }) },
    { to: [fanId], msg: expect.objectContaining({ title: 'Maker Films replied to you', body: 'Thank you, it was 6am.', url: expect.stringMatching(new RegExp(`^/watch\\?v=${v.id}&c=`)) }) },
  ]);

  // Turning it off on a device removes only that device (and only the owner can).
  await maker.agent.delete('/api/push/subscriptions').set('Origin', WEB).send({ endpoint: device(1).endpoint }).expect(200);
  expect(await ctx.prisma.pushSubscription.count()).toBe(2);
  await fan.agent.delete('/api/push/subscriptions').set('Origin', WEB).send({ endpoint: device(1).endpoint }).expect(200);
  expect(await ctx.prisma.pushSubscription.count()).toBe(1);
});

test('the sender encrypts for each device and removes devices the push service has forgotten', async () => {
  const fan = await signIn(ctx.http, ctx.mail, 'fan@example.com');
  for (const n of [1, 2, 3]) await fan.agent.post('/api/push/subscriptions').set('Origin', WEB).send(device(n)).expect(200);
  const fanId = (await ctx.prisma.user.findUniqueOrThrow({ where: { email: 'fan@example.com' } })).id;
  const calls: string[] = [];
  const spy = jest.spyOn(webpush, 'sendNotification').mockImplementation(async (sub, payload, opts) => {
    calls.push(sub.endpoint);
    expect(JSON.parse(String(payload))).toMatchObject({ title: 'Hello', url: '/x', icon: '/icons/icon-192.png' });
    expect(opts?.vapidDetails?.publicKey).toBeTruthy();
    if (sub.endpoint.endsWith('device-2')) throw new WebPushError('Gone', 410, {}, '', sub.endpoint);
    if (sub.endpoint.endsWith('device-3')) throw new WebPushError('Busy', 503, {}, '', sub.endpoint);
    return { statusCode: 201, body: '', headers: {} };
  });
  try {
    await createPushSender(ctx.prisma, ctx.config)([fanId], { title: 'Hello', body: 'World', url: '/x' });
  } finally { spy.mockRestore(); }
  expect(calls.sort()).toEqual([1, 2, 3].map((n) => device(n).endpoint));
  const left = await ctx.prisma.pushSubscription.findMany({ orderBy: { endpoint: 'asc' } });
  expect(left.map((s) => [s.endpoint.slice(-8), s.failures, !!s.lastSentAt])).toEqual([['device-1', 0, true], ['device-3', 1, false]]);
});

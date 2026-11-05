import request from 'supertest';
import { makeApp, resetDb, signIn, WEB } from './helpers';

let ctx: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => { ctx = await makeApp(); });
beforeEach(async () => { await resetDb(ctx.prisma); ctx.mail.outbox.length = 0; await ctx.clearLimits(); });
afterAll(async () => { await ctx.app.close(); });

test('the bell: new videos for followers (once), comments, replies and grouped Sparks; read state; removed videos disappear', async () => {
  const maker = await signIn(ctx.http, ctx.mail, 'maker@example.com');
  const ch = (await maker.agent.post('/api/channels').set('Origin', WEB).send({ handle: 'maker', name: 'Maker Films' }).expect(201)).body.channel;
  const fan = await signIn(ctx.http, ctx.mail, 'fan@example.com');
  const other = await signIn(ctx.http, ctx.mail, 'other@example.com');
  await fan.agent.post('/api/channels/maker/follow').set('Origin', WEB).expect(200);
  await request(ctx.http).get('/api/me/notifications').expect(401);

  // Published by its creator once processing is done: followers hear about it once, the creator does not.
  const v = await ctx.prisma.video.create({ data: { channelId: ch.id, title: 'Gorillas', durationSeconds: 60, status: 'READY', visibility: 'PRIVATE', mediaLocation: 'PRIVATE', hlsMasterKey: 'hls/master.m3u8' } });
  await maker.agent.patch(`/api/hub/videos/${v.id}`).set('Origin', WEB).send({ visibility: 'PUBLIC' }).expect(200);
  await maker.agent.patch(`/api/hub/videos/${v.id}`).set('Origin', WEB).send({ title: 'Gorillas of Musanze' }).expect(200);
  let fanList = (await fan.agent.get('/api/me/notifications').expect(200)).body;
  expect(fanList.unread).toBe(1);
  expect(fanList.notifications).toEqual([expect.objectContaining({ type: 'NEW_VIDEO', read: false, text: 'Maker Films posted a new video: "Gorillas of Musanze"' /* always the current title */, href: `/watch?v=${v.id}`, actor: expect.objectContaining({ name: 'Maker Films', handle: 'maker' }) })]);
  expect((await other.agent.get('/api/me/notifications/unread')).body.unread).toBe(0);

  // A comment tells the creator; a reply tells the person answered; nobody is told about their own words.
  const c = (await fan.agent.post(`/api/videos/${v.id}/comments`).set('Origin', WEB).send({ content: 'Beautiful!' }).expect(201)).body.comment;
  await maker.agent.post(`/api/videos/${v.id}/comments`).set('Origin', WEB).send({ content: 'Thank you!', parentId: c.id }).expect(201);
  await fan.agent.post(`/api/videos/${v.id}/comments`).set('Origin', WEB).send({ content: 'Any time.', parentId: c.id }).expect(201);
  fanList = (await fan.agent.get('/api/me/notifications')).body;
  expect(fanList.notifications.map((n: any) => n.type)).toEqual(['REPLY', 'NEW_VIDEO']);
  expect(fanList.notifications[0].href).toMatch(new RegExp(`^/watch\\?v=${v.id}&c=`));

  // Sparks: one unread entry per video, counting different people.
  await fan.agent.put(`/api/videos/${v.id}/reaction`).set('Origin', WEB).send({ value: 'like' }).expect(200);
  await other.agent.put(`/api/videos/${v.id}/reaction`).set('Origin', WEB).send({ value: 'like' }).expect(200);
  await other.agent.put(`/api/videos/${v.id}/reaction`).set('Origin', WEB).send({ value: 'none' }).expect(200);
  await other.agent.put(`/api/videos/${v.id}/reaction`).set('Origin', WEB).send({ value: 'like' }).expect(200);
  await maker.agent.put(`/api/videos/${v.id}/reaction`).set('Origin', WEB).send({ value: 'like' }).expect(200);
  const mine = (await maker.agent.get('/api/me/notifications')).body;
  expect(mine.notifications.map((n: any) => n.type)).toEqual(['SPARK', 'COMMENT']);
  expect(mine.notifications[0]).toMatchObject({ count: 2, text: expect.stringMatching(/ and 1 other sparked "Gorillas of Musanze"$/) });
  expect(mine.unread).toBe(2);

  // Read some, then all; a Spark after reading starts a new entry.
  expect((await maker.agent.post('/api/me/notifications/read').set('Origin', WEB).send({ ids: [mine.notifications[1].id] }).expect(200)).body.unread).toBe(1);
  expect((await maker.agent.post('/api/me/notifications/read').set('Origin', WEB).send({}).expect(200)).body.unread).toBe(0);
  await fan.agent.put(`/api/videos/${v.id}/reaction`).set('Origin', WEB).send({ value: 'none' }).expect(200);
  await fan.agent.put(`/api/videos/${v.id}/reaction`).set('Origin', WEB).send({ value: 'like' }).expect(200);
  expect((await maker.agent.get('/api/me/notifications')).body.notifications.filter((n: any) => n.type === 'SPARK').map((n: any) => n.read)).toEqual([false, true]);

  // A removed video takes its notifications with it.
  await ctx.prisma.video.update({ where: { id: v.id }, data: { takenDownAt: new Date(), status: 'SUSPENDED' } });
  expect((await fan.agent.get('/api/me/notifications')).body).toMatchObject({ notifications: [], unread: 0 });
});

test('processing that finishes after publishing announces the video; private, unlisted or removed videos are never announced', async () => {
  const maker = await signIn(ctx.http, ctx.mail, 'maker@example.com');
  const ch = (await maker.agent.post('/api/channels').set('Origin', WEB).send({ handle: 'maker', name: 'Maker' }).expect(201)).body.channel;
  const fan = await signIn(ctx.http, ctx.mail, 'fan@example.com');
  await fan.agent.post('/api/channels/maker/follow').set('Origin', WEB).expect(200);
  const { announceVideo } = await import('../src/notifications/notify');
  const mk = (data: object) => ctx.prisma.video.create({ data: { channelId: ch.id, title: 'x', durationSeconds: 1, mediaLocation: 'PUBLIC', ...data } });
  const processing = await mk({ status: 'PROCESSING', visibility: 'PUBLIC', publishedAt: new Date() });
  const unlisted = await mk({ status: 'READY', visibility: 'UNLISTED', publishedAt: new Date() });
  const removed = await mk({ status: 'SUSPENDED', visibility: 'PUBLIC', publishedAt: new Date(), takenDownAt: new Date() });
  for (const v of [processing, unlisted, removed]) await announceVideo(ctx.prisma as never, v.id);
  expect((await fan.agent.get('/api/me/notifications/unread')).body.unread).toBe(0);
  await ctx.prisma.video.update({ where: { id: processing.id }, data: { status: 'READY' } });
  await announceVideo(ctx.prisma as never, processing.id);
  await announceVideo(ctx.prisma as never, processing.id);
  expect((await fan.agent.get('/api/me/notifications/unread')).body.unread).toBe(1);
});

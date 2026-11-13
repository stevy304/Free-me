import { makeApp, resetDb, signIn, WEB } from './helpers';

// Direct messages: any signed-in account can message a Space's owner; messages pass the safety check; a block stops
// them both ways; only the two people in a conversation can read it.
let ctx: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => { ctx = await makeApp(); });
beforeEach(async () => { await resetDb(ctx.prisma); ctx.mail.outbox.length = 0; await ctx.clearLimits(); });
afterAll(async () => { await ctx.app.close(); });

test('message a creator, read, unread counts, safety check, block, privacy', async () => {
  const creator = (await signIn(ctx.http, ctx.mail, 'creator@example.com')).agent;
  await creator.post('/api/channels').set('Origin', WEB).send({ handle: 'kivu', name: 'Kivu Moments' }).expect(201);
  const fan = (await signIn(ctx.http, ctx.mail, 'fan@example.com')).agent;
  const stranger = (await signIn(ctx.http, ctx.mail, 'stranger@example.com')).agent;

  // Signed out: no messages.
  await (await import('supertest')).default(ctx.http).get('/api/messages').expect(401);
  await creator.post('/api/messages/with/kivu').set('Origin', WEB).send({}).expect(400); // own Space
  await fan.post('/api/messages/with/nobody').set('Origin', WEB).send({}).expect(404);

  const { id } = (await fan.post('/api/messages/with/@Kivu').set('Origin', WEB).send({}).expect(200)).body;
  expect((await fan.post('/api/messages/with/kivu').set('Origin', WEB).send({}).expect(200)).body.id).toBe(id); // one per pair
  // Opened but empty: not in either list yet.
  expect((await creator.get('/api/messages').expect(200)).body.conversations).toEqual([]);

  const sent = (await fan.post(`/api/messages/${id}`).set('Origin', WEB).send({ body: '  Muraho! Your Lake Kivu Moment is beautiful.  ' }).expect(201)).body.message;
  expect(sent).toMatchObject({ body: 'Muraho! Your Lake Kivu Moment is beautiful.', mine: true });
  expect((await creator.get('/api/messages/unread').expect(200)).body.count).toBe(1);
  const list = (await creator.get('/api/messages').expect(200)).body.conversations;
  expect(list).toEqual([expect.objectContaining({ id, unread: true, other: expect.objectContaining({ name: expect.any(String), handle: null }), last: expect.objectContaining({ body: 'Muraho! Your Lake Kivu Moment is beautiful.', mine: false }) })]);
  const thread = (await creator.get(`/api/messages/${id}`).expect(200)).body;
  expect(thread.messages.map((m: any) => [m.body, m.mine])).toEqual([['Muraho! Your Lake Kivu Moment is beautiful.', false]]);
  await creator.post(`/api/messages/${id}/read`).set('Origin', WEB).send({}).expect(200);
  expect((await creator.get('/api/messages/unread').expect(200)).body.count).toBe(0);
  await creator.post(`/api/messages/${id}`).set('Origin', WEB).send({ body: 'Murakoze cyane!' }).expect(201);
  expect((await fan.get(`/api/messages/${id}`).expect(200)).body.messages.map((m: any) => m.body)).toEqual(['Murakoze cyane!', 'Muraho! Your Lake Kivu Moment is beautiful.']);

  // Only the two of them can read or write in it.
  await stranger.get(`/api/messages/${id}`).expect(404);
  await stranger.post(`/api/messages/${id}`).set('Origin', WEB).send({ body: 'hi' }).expect(404);

  // The safety check: refused messages are not delivered.
  expect((await fan.post(`/api/messages/${id}`).set('Origin', WEB).send({ body: 'p o r n video for you' }).expect(400)).body.message).toMatch(/^Your message was not posted/);
  await fan.post(`/api/messages/${id}`).set('Origin', WEB).send({ body: '   ' }).expect(400);
  expect((await creator.get(`/api/messages/${id}`).expect(200)).body.messages).toHaveLength(2);

  // A block stops messages both ways, and is shown to both sides.
  await creator.post(`/api/messages/${id}/block`).set('Origin', WEB).send({}).expect(200);
  expect((await fan.post(`/api/messages/${id}`).set('Origin', WEB).send({ body: 'Hello?' }).expect(403)).body.message).toBe('You cannot send messages to this account.');
  expect((await creator.post(`/api/messages/${id}`).set('Origin', WEB).send({ body: 'Hello' }).expect(403)).body.message).toMatch(/You blocked this account/);
  expect((await fan.get(`/api/messages/${id}`).expect(200)).body.blocked).toEqual({ byMe: false, byThem: true });
  await creator.delete(`/api/messages/${id}/block`).set('Origin', WEB).expect(200);
  await fan.post(`/api/messages/${id}`).set('Origin', WEB).send({ body: 'Hello again' }).expect(201);
});

test('starting new conversations is limited per day', async () => {
  const fan = (await signIn(ctx.http, ctx.mail, 'spammer@example.com')).agent;
  for (let i = 0; i < 21; i++) {
    const u = await ctx.prisma.user.create({ data: { email: `c${i}@example.com` } });
    await ctx.prisma.channel.create({ data: { userId: u.id, handle: `space${i}`, name: `Space ${i}` } });
  }
  for (let i = 0; i < 20; i++) await fan.post(`/api/messages/with/space${i}`).set('Origin', WEB).send({}).expect(200);
  expect((await fan.post('/api/messages/with/space20').set('Origin', WEB).send({}).expect(429)).body.message).toMatch(/many new conversations/);
});

import request from 'supertest';
import { makeApp, resetDb, signIn, WEB } from './helpers';

let ctx: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => { ctx = await makeApp({ adminEmails: ['mod@example.com'] }); });
beforeEach(async () => { await resetDb(ctx.prisma); ctx.mail.outbox.length = 0; await ctx.clearLimits(); });
afterAll(async () => { await ctx.app.close(); });

/** A creator with one public, ready video (no real media needed for these routes). */
async function creatorWithVideo(email = 'creator@example.com', handle = 'the.creator', extra: object = {}) {
  const c = await signIn(ctx.http, ctx.mail, email);
  const ch = (await c.agent.post('/api/channels').set('Origin', WEB).send({ handle, name: 'The Creator' }).expect(201)).body.channel;
  const video = await ctx.prisma.video.create({ data: { channelId: ch.id, title: 'Sunrise over Kivu', durationSeconds: 600, status: 'READY', visibility: 'PUBLIC', mediaLocation: 'PUBLIC', publishedAt: new Date(), hlsMasterKey: 'hls/master.m3u8', ...extra } });
  return { ...c, channel: ch, video };
}

describe('reactions', () => {
  test('like, switch to dislike, clear; counts stay exact even with many taps at once; dislikes are never public', async () => {
    const { video } = await creatorWithVideo();
    const fan = await signIn(ctx.http, ctx.mail, 'fan@example.com');
    const put = (value: string, agent = fan.agent) => agent.put(`/api/videos/${video.id}/reaction`).set('Origin', WEB).send({ value });

    expect((await put('like').expect(200)).body).toEqual({ reaction: 'like', likeCount: 1 });
    expect((await put('like').expect(200)).body.likeCount).toBe(1);
    expect((await put('dislike').expect(200)).body.likeCount).toBe(0);
    let row = await ctx.prisma.video.findUniqueOrThrow({ where: { id: video.id } });
    expect([row.likeCount, row.dislikeCount]).toEqual([0, 1]);
    expect((await put('none').expect(200)).body.likeCount).toBe(0);
    await put('love').expect(400);
    await request(ctx.http).put(`/api/videos/${video.id}/reaction`).set('Origin', WEB).send({ value: 'like' }).expect(401);

    await Promise.all(Array.from({ length: 12 }, (_, i) => put(i % 3 === 0 ? 'dislike' : i % 3 === 1 ? 'like' : 'none')));
    row = await ctx.prisma.video.findUniqueOrThrow({ where: { id: video.id } });
    const actual = await ctx.prisma.like.findMany({ where: { videoId: video.id } });
    expect(row.likeCount).toBe(actual.filter((l) => l.isLike).length);
    expect(row.dislikeCount).toBe(actual.filter((l) => !l.isLike).length);

    await put('like');
    const watch = (await fan.agent.get(`/api/videos/${video.id}`).expect(200)).body;
    expect(watch.viewer).toMatchObject({ signedIn: true, reaction: 'like', following: false, saved: false, isOwner: false });
    expect(JSON.stringify(watch)).not.toContain('dislike":');
  });
});

describe('comments', () => {
  test('comment, reply (replies to replies join the thread), edit, pin, and removal rules', async () => {
    const owner = await creatorWithVideo();
    const vid = owner.video.id;
    const ana = await signIn(ctx.http, ctx.mail, 'ana@example.com');
    const ben = await signIn(ctx.http, ctx.mail, 'ben@example.com');
    const post = (agent: any, content: string, parentId?: string) => agent.post(`/api/videos/${vid}/comments`).set('Origin', WEB).send({ content, parentId });

    const first = (await post(ana.agent, '  Beautiful colours!\n\n\n\nWhere is this?  ').expect(201)).body.comment;
    expect(first).toMatchObject({ content: 'Beautiful colours!\n\nWhere is this?', author: { name: 'ana', isCreator: false }, can: { edit: true, delete: true, pin: false } });
    await post(ana.agent, '   ').expect(400);
    await request(ctx.http).post(`/api/videos/${vid}/comments`).set('Origin', WEB).send({ content: 'anon' }).expect(401);

    const reply = (await post(owner.agent, 'Lake Kivu, at dawn.', first.id).expect(201)).body.comment;
    expect(reply).toMatchObject({ parentId: first.id, author: { name: 'The Creator', handle: 'the.creator', isCreator: true } });
    const nested = (await post(ben.agent, 'Thanks!', reply.id).expect(201)).body.comment;
    expect(nested.parentId).toBe(first.id);
    const second = (await post(ben.agent, 'Second comment').expect(201)).body.comment;

    let list = (await request(ctx.http).get(`/api/videos/${vid}/comments`).expect(200)).body;
    expect(list.count).toBe(4);
    expect(list.comments.map((c: any) => c.id)).toEqual([second.id, first.id]);
    expect(list.comments[1].replyCount).toBe(2);
    expect((await request(ctx.http).get(`/api/comments/${first.id}/replies`)).body.replies.map((r: any) => r.content)).toEqual(['Lake Kivu, at dawn.', 'Thanks!']);

    await ben.agent.patch(`/api/comments/${first.id}`).set('Origin', WEB).send({ content: 'hijack' }).expect(403);
    const edited = (await ana.agent.patch(`/api/comments/${first.id}`).set('Origin', WEB).send({ content: 'Beautiful colours!' }).expect(200)).body.comment;
    expect(edited.editedAt).not.toBeNull();

    await ana.agent.post(`/api/comments/${second.id}/pin`).set('Origin', WEB).expect(403);
    await owner.agent.post(`/api/comments/${reply.id}/pin`).set('Origin', WEB).expect(400);
    await owner.agent.post(`/api/comments/${second.id}/pin`).set('Origin', WEB).expect(200);
    list = (await request(ctx.http).get(`/api/videos/${vid}/comments?sort=oldest`)).body;
    expect(list.comments.map((c: any) => [c.id, c.isPinned])).toEqual([[second.id, true], [first.id, false]]);

    // Ben cannot remove Ana's comment; the creator can. With replies it stays as a removed placeholder.
    await ben.agent.delete(`/api/comments/${first.id}`).set('Origin', WEB).expect(403);
    await owner.agent.delete(`/api/comments/${first.id}`).set('Origin', WEB).expect(200);
    list = (await request(ctx.http).get(`/api/videos/${vid}/comments`)).body;
    expect(list.count).toBe(3);
    expect(list.comments.find((c: any) => c.id === first.id)).toMatchObject({ deleted: true, content: '', author: null });
    await post(ben.agent, 'reply to removed', first.id).expect(400);
    // Removing the last replies removes the placeholder too.
    await owner.agent.delete(`/api/comments/${reply.id}`).set('Origin', WEB).expect(200);
    await ben.agent.delete(`/api/comments/${nested.id}`).set('Origin', WEB).expect(200);
    expect(await ctx.prisma.comment.findUnique({ where: { id: first.id } })).toBeNull();
    expect((await ctx.prisma.video.findUniqueOrThrow({ where: { id: vid } })).commentCount).toBe(1);
  });

  test('comments are closed on videos made for kids and when the creator turns them off', async () => {
    const { video, agent } = await creatorWithVideo('kids@example.com', 'kids.songs', { madeForKids: true });
    const fan = await signIn(ctx.http, ctx.mail, 'parent@example.com');
    expect((await request(ctx.http).get(`/api/videos/${video.id}/comments`)).body).toMatchObject({ open: false, comments: [] });
    await fan.agent.post(`/api/videos/${video.id}/comments`).set('Origin', WEB).send({ content: 'hi' }).expect(403);
    await agent.patch(`/api/hub/videos/${video.id}`).set('Origin', WEB).send({ madeForKids: false, commentsEnabled: false }).expect(200);
    await fan.agent.post(`/api/videos/${video.id}/comments`).set('Origin', WEB).send({ content: 'hi' }).expect(403);
    await agent.patch(`/api/hub/videos/${video.id}`).set('Origin', WEB).send({ commentsEnabled: true }).expect(200);
    await fan.agent.post(`/api/videos/${video.id}/comments`).set('Origin', WEB).send({ content: 'hi' }).expect(201);
    expect((await request(ctx.http).get(`/api/videos/${video.id}`)).body.video.commentsOpen).toBe(true);
  });
});

describe('history and resume', () => {
  test('progress is remembered for resuming, finished videos start over, and history can be cleared', async () => {
    const { video } = await creatorWithVideo();
    const fan = await signIn(ctx.http, ctx.mail, 'viewer@example.com');
    const progress = (seconds: number, ended?: boolean) => fan.agent.post(`/api/videos/${video.id}/progress`).set('Origin', WEB).send({ seconds, ended }).expect(200);

    await progress(5);
    expect((await fan.agent.get(`/api/videos/${video.id}`)).body.viewer.resumeAt).toBe(0);
    await progress(184.6);
    expect((await fan.agent.get(`/api/videos/${video.id}`)).body.viewer.resumeAt).toBe(184);
    let h = (await fan.agent.get('/api/me/history').expect(200)).body;
    expect(h.items).toHaveLength(1);
    expect(h.items[0]).toMatchObject({ progressSeconds: 184, completed: false, video: { id: video.id, title: 'Sunrise over Kivu' } });
    expect((await progress(595)).body.completed).toBe(true);
    expect((await fan.agent.get(`/api/videos/${video.id}`)).body.viewer.resumeAt).toBe(0);

    await request(ctx.http).get('/api/me/history').expect(401);
    expect((await fan.agent.delete(`/api/me/history/${video.id}`).set('Origin', WEB).expect(200)).body.removed).toBe(1);
    await progress(30);
    expect((await fan.agent.delete('/api/me/history').set('Origin', WEB).expect(200)).body.removed).toBe(1);
    h = (await fan.agent.get('/api/me/history')).body;
    expect(h.items).toEqual([]);
  });
});

describe('collections', () => {
  test('Saved always exists and stays private; named collections can be shared; private ones stay hidden', async () => {
    const { video } = await creatorWithVideo();
    const fan = await signIn(ctx.http, ctx.mail, 'collector@example.com');
    const other = await signIn(ctx.http, ctx.mail, 'nosy@example.com');

    let mine = (await fan.agent.get('/api/me/collections').expect(200)).body.collections;
    expect(mine).toEqual([expect.objectContaining({ kind: 'SAVED', title: 'Kept', visibility: 'PRIVATE', videoCount: 0 })]);
    const saved = mine[0].id;
    await fan.agent.put(`/api/me/collections/saved/videos/${video.id}`).set('Origin', WEB).expect(200);
    await fan.agent.put(`/api/me/collections/saved/videos/${video.id}`).set('Origin', WEB).expect(200);
    expect((await fan.agent.get(`/api/videos/${video.id}`)).body.viewer.saved).toBe(true);
    await fan.agent.patch('/api/me/collections/saved').set('Origin', WEB).send({ visibility: 'PUBLIC' }).expect(400);
    await fan.agent.delete('/api/me/collections/saved').set('Origin', WEB).expect(400);
    await other.agent.get(`/api/collections/${saved}`).expect(404);

    const trip = (await fan.agent.post('/api/me/collections').set('Origin', WEB).send({ title: '  Rwanda trip ' }).expect(201)).body.collection;
    expect(trip).toMatchObject({ kind: 'CUSTOM', title: 'Rwanda trip', visibility: 'PRIVATE' });
    await fan.agent.post('/api/me/collections').set('Origin', WEB).send({ title: '' }).expect(400);
    await fan.agent.put(`/api/me/collections/${trip.id}/videos/${video.id}`).set('Origin', WEB).expect(200);
    await other.agent.put(`/api/me/collections/${trip.id}/videos/${video.id}`).set('Origin', WEB).expect(404);
    expect((await fan.agent.get(`/api/me/collections/containing/${video.id}`)).body.collectionIds.sort()).toEqual([saved, trip.id].sort());

    await other.agent.get(`/api/collections/${trip.id}`).expect(404);
    await fan.agent.patch(`/api/me/collections/${trip.id}`).set('Origin', WEB).send({ visibility: 'PUBLIC' }).expect(200);
    const shared = (await request(ctx.http).get(`/api/collections/${trip.id}`).expect(200)).body;
    expect(shared).toMatchObject({ collection: { title: 'Rwanda trip', videoCount: 1 }, isOwner: false, owner: { name: 'collector' } });
    expect(shared.videos.map((v: any) => v.id)).toEqual([video.id]);

    // A video that becomes private disappears from everyone's collections.
    await ctx.prisma.video.update({ where: { id: video.id }, data: { visibility: 'PRIVATE' } });
    expect((await request(ctx.http).get(`/api/collections/${trip.id}`)).body.videos).toEqual([]);
    await ctx.prisma.video.update({ where: { id: video.id }, data: { visibility: 'PUBLIC' } });

    expect((await fan.agent.delete(`/api/me/collections/${trip.id}/videos/${video.id}`).set('Origin', WEB).expect(200)).body.removed).toBe(true);
    await fan.agent.delete(`/api/me/collections/${trip.id}`).set('Origin', WEB).expect(200);
    mine = (await fan.agent.get('/api/me/collections')).body.collections;
    expect(mine.map((c: any) => c.title)).toEqual(['Kept']);
  });
});

describe('reports, copyright notices and takedowns', () => {
  test('reporting a video: reasons are checked, no duplicates, not your own video', async () => {
    const { video, agent } = await creatorWithVideo();
    const fan = await signIn(ctx.http, ctx.mail, 'reporter@example.com');
    const send = (body: object, a = fan.agent) => a.post(`/api/videos/${video.id}/reports`).set('Origin', WEB).send(body);
    await send({ reason: 'COPYRIGHT' }).expect(400);
    await send({ reason: 'MADE_UP' }).expect(400);
    await send({ reason: 'SPAM_OR_SCAM' }, agent).expect(400);
    const r = (await send({ reason: 'SPAM_OR_SCAM', details: 'Fake giveaway link', timestampSeconds: 9999 }).expect(201)).body;
    expect(r.alreadyReported).toBe(false);
    expect((await send({ reason: 'HATE_OR_HARASSMENT' }).expect(201)).body.alreadyReported).toBe(true);
    expect((await ctx.prisma.report.findUniqueOrThrow({ where: { id: r.report.id } })).timestampSeconds).toBe(600);
    expect((await fan.agent.get('/api/me/reports')).body.reports).toEqual([expect.objectContaining({ reason: 'SPAM_OR_SCAM', reasonLabel: 'Spam or scam', status: 'PENDING' })]);
  });

  test('copyright notice → moderator removes → video gone everywhere → counter-notice → restored', async () => {
    const creator = await creatorWithVideo();
    const vid = creator.video.id;
    const claimant = await signIn(ctx.http, ctx.mail, 'label@example.com');
    const mod = await signIn(ctx.http, ctx.mail, 'mod@example.com');
    const notice = { videoId: vid, claimantName: 'Grace Mukamana', claimantEmail: 'rights@label.example', claimantAddress: 'KG 7 Ave, Kigali, Rwanda', originalWork: 'Song "Inkingi" (2025), https://label.example/inkingi', details: 'The whole soundtrack from 0:00 is my song.', goodFaith: true, accurate: true, signature: 'grace  mukamana' };

    await claimant.agent.post('/api/copyright/notices').set('Origin', WEB).send({ ...notice, goodFaith: false }).expect(400);
    await claimant.agent.post('/api/copyright/notices').set('Origin', WEB).send({ ...notice, signature: 'G.M.' }).expect(400);
    await creator.agent.post('/api/copyright/notices').set('Origin', WEB).send(notice).expect(400);
    const sent = (await claimant.agent.post('/api/copyright/notices').set('Origin', WEB).send(notice).expect(201)).body.report;
    expect(ctx.mail.outbox.at(-1)).toMatchObject({ to: 'rights@label.example', subject: 'We received your copyright notice' });

    // Only moderators and administrators see the queue.
    await claimant.agent.get('/api/moderation/reports').expect(403);
    const queue = (await mod.agent.get('/api/moderation/reports').expect(200)).body;
    expect(queue.open).toBe(1);
    expect(queue.reports[0]).toMatchObject({ id: sent.id, reason: 'COPYRIGHT', notice: { claimantName: 'Grace Mukamana' }, channel: { handle: 'the.creator', strikes: { copyright: 0 } } });

    const decide = (body: object) => mod.agent.post(`/api/moderation/reports/${sent.id}/decision`).set('Origin', WEB).send(body);
    await decide({ action: 'remove' }).expect(400);
    await decide({ action: 'remove', notes: 'The notice is complete; the soundtrack matches the work.' }).expect(200);

    const gone = await request(ctx.http).get(`/api/videos/${vid}`).expect(410);
    expect(gone.body.message).toContain('copyright notice');
    expect((await request(ctx.http).get('/api/videos')).body.videos).toEqual([]);
    expect((await creator.agent.get(`/api/videos/${vid}`).expect(200)).body.video.takenDownAt).not.toBeNull();
    expect(ctx.mail.outbox.some((m) => m.to === 'creator@example.com' && m.subject.includes('was removed') && m.text.includes('Grace Mukamana'))).toBe(true);

    const hub = (await creator.agent.get('/api/hub/notices').expect(200)).body;
    expect(hub.strikes).toMatchObject({ copyright: 1, guidelines: 0 });
    expect(hub.removals[0]).toMatchObject({ reason: 'COPYRIGHT', canCounter: true, notice: { id: sent.id, claimantName: 'Grace Mukamana' } });
    expect(JSON.stringify(hub)).not.toContain('rights@label.example');

    const counter = { statement: 'I composed and recorded this soundtrack myself in 2024.', name: 'Eric Habimana', address: 'KN 3 Rd, Kigali, Rwanda', goodFaith: true, consent: true, signature: 'Eric Habimana' };
    await claimant.agent.post(`/api/hub/notices/${sent.id}/counter`).set('Origin', WEB).send(counter).expect(403);
    await creator.agent.post(`/api/hub/notices/${sent.id}/counter`).set('Origin', WEB).send({ ...counter, consent: false }).expect(400);
    await creator.agent.post(`/api/hub/notices/${sent.id}/counter`).set('Origin', WEB).send(counter).expect(200);
    await creator.agent.post(`/api/hub/notices/${sent.id}/counter`).set('Origin', WEB).send(counter).expect(400);
    expect(ctx.mail.outbox.some((m) => m.to === 'rights@label.example' && m.text.includes('Eric Habimana') && m.text.includes('KN 3 Rd'))).toBe(true);
    expect((await mod.agent.get('/api/moderation/reports?state=counter')).body.reports[0].counter).toMatchObject({ name: 'Eric Habimana' });

    await decide({ action: 'restore', notes: 'No court action was filed within 14 business days.' }).expect(200);
    expect((await request(ctx.http).get(`/api/videos/${vid}`).expect(200)).body.video.title).toBe('Sunrise over Kivu');
    expect((await creator.agent.get('/api/hub/notices')).body.strikes.copyright).toBe(0);
    expect((await claimant.agent.get('/api/me/reports')).body.reports[0]).toMatchObject({ status: 'RESOLVED', resolution: expect.stringContaining('restored') });
    const actions = await ctx.prisma.moderationAction.findMany({ where: { videoId: vid }, orderBy: { createdAt: 'asc' } });
    expect(actions.map((a) => a.action)).toEqual(['VIDEO_TAKEDOWN', 'VIDEO_RESTORED']);
  });

  test('a dismissed report changes nothing; removal for a guideline closes every open report on the video', async () => {
    const { video } = await creatorWithVideo();
    const a = await signIn(ctx.http, ctx.mail, 'a@example.com');
    const b = await signIn(ctx.http, ctx.mail, 'b@example.com');
    const mod = await signIn(ctx.http, ctx.mail, 'mod@example.com');
    const ra = (await a.agent.post(`/api/videos/${video.id}/reports`).set('Origin', WEB).send({ reason: 'OTHER', details: 'I do not like it' }).expect(201)).body.report;
    await mod.agent.post(`/api/moderation/reports/${ra.id}/decision`).set('Origin', WEB).send({ action: 'dismiss' }).expect(200);
    await mod.agent.post(`/api/moderation/reports/${ra.id}/decision`).set('Origin', WEB).send({ action: 'dismiss' }).expect(400);
    await request(ctx.http).get(`/api/videos/${video.id}`).expect(200);

    const rb = (await b.agent.post(`/api/videos/${video.id}/reports`).set('Origin', WEB).send({ reason: 'VIOLENT_OR_GRAPHIC' }).expect(201)).body.report;
    const rc = (await a.agent.post(`/api/videos/${video.id}/reports`).set('Origin', WEB).send({ reason: 'DANGEROUS_ACTS' }).expect(201)).body.report;
    await mod.agent.post(`/api/moderation/reports/${rb.id}/decision`).set('Origin', WEB).send({ action: 'remove', notes: 'Graphic violence without context.' }).expect(200);
    expect((await request(ctx.http).get(`/api/videos/${video.id}`).expect(410)).body.message).toContain('Community Guidelines');
    expect((await ctx.prisma.report.findUniqueOrThrow({ where: { id: rc.id } })).status).toBe('RESOLVED');
    expect((await mod.agent.get('/api/moderation/reports')).body.open).toBe(0);
    // Interactions with a removed video are refused.
    await a.agent.put(`/api/videos/${video.id}/reaction`).set('Origin', WEB).send({ value: 'like' }).expect(404);
    await a.agent.post(`/api/videos/${video.id}/comments`).set('Origin', WEB).send({ content: 'x' }).expect(404);
  });

  test('the site endpoint publishes the operator and contact details from configuration only', async () => {
    const site = (await request(ctx.http).get('/api/site').expect(200)).body;
    expect(site).toMatchObject({ operatorName: 'Free Me', contactEmail: null, copyrightEmail: null, jurisdiction: null });
    expect(site.reportReasons.map((r: any) => r.code)).toContain('SPAM_OR_SCAM');
  });
});

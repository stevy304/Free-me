import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { makeApp, resetDb, signIn, WEB } from './helpers';
import { checkTranscript } from '../src/safety/check';
import { forgetSecrets } from '../src/settings/secrets';
import { sweepComments } from '../src/engagement/comment-check';
import { MediaQueue } from '../src/media/queue';
import type { MediaJobs } from '../src/media/jobs';

// The AI moderator (safety/ai.ts, TRUST_AND_SAFETY.md) against a stand-in for Anthropic's Messages API, with its
// key entered in Administration → Secrets: it decides publish, limit or reject with a reason, and creators appeal.
const dir = mkdtempSync(join(tmpdir(), 'freeme-ai-moderation-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const KEY = 'sk-ant-api03-test0123456789abcdefghijklmnop';

type Answer = { decision: 'publish' | 'limit' | 'reject'; category?: string; confidence?: number; reason?: string } | 'refuse';
interface Call { model: string; effort: string; images: number; text: string; cached: boolean; key: string | undefined; system: string }

describe('AI moderator', () => {
  let claude: Server;
  let calls: Call[] = [];
  // How each model answers; by default everything is fine.
  let answer: (model: string, text: string) => Answer = () => ({ decision: 'publish' });
  let wordsToo = false; // the answer applies to words too (comments, titles, transcripts), not only videos
  let wait: Promise<void> | null = null; // Claude takes its time over videos until this settles
  let ctx: Awaited<ReturnType<typeof makeApp>>;
  let clip: string;

  beforeAll(async () => {
    clip = join(dir, 'clip.mp4');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=500:duration=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', clip]);
    claude = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', async () => {
        const j = JSON.parse(body);
        if (wait && /A new video/.test(body)) await wait;
        const content = j.messages[0].content as Array<{ type: string; text?: string }>;
        const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
        calls.push({ model: j.model, effort: j.output_config?.effort, images: content.filter((b) => b.type === 'image').length, text, cached: !!j.system?.[0]?.cache_control, system: String(j.system?.[0]?.text ?? ''), key: (req.headers['x-api-key'] ?? req.headers.authorization) as string | undefined });
        const a = /^(A new video|The creator appeals)/.test(text) || wordsToo ? answer(j.model, text) : { decision: 'publish' as const };
        const base = { id: 'msg_test', type: 'message', role: 'assistant', model: j.model, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 20 } };
        res.writeHead(200, { 'content-type': 'application/json' });
        if (a === 'refuse') return res.end(JSON.stringify({ ...base, content: [], stop_reason: 'refusal' }));
        res.end(JSON.stringify({ ...base, stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ category: 'none', confidence: 0.95, reason: 'Nothing breaks the guidelines.', ...a }) }] }));
      });
    });
    await new Promise<void>((r) => claude.listen(0, '127.0.0.1', r));
    ctx = await makeApp({ redis: false, storageDir: join(dir, 'storage'), adminEmails: ['admin@example.com'],
      env: { SAFETY_ANTHROPIC_URL: `http://127.0.0.1:${(claude.address() as AddressInfo).port}` } });
  }, 60_000);
  beforeEach(async () => {
    await resetDb(ctx.prisma); forgetSecrets(); ctx.mail.outbox.length = 0; await ctx.clearLimits();
    calls = []; wordsToo = false; wait = null; answer = () => ({ decision: 'publish' });
  });
  afterAll(async () => { await ctx.app.close(); claude.close(); });

  async function admin() {
    const a = (await signIn(ctx.http, ctx.mail, 'admin@example.com')).agent;
    await a.put('/api/admin/secrets').set('Origin', WEB).send({ values: { ANTHROPIC_API_KEY: KEY } }).expect(200);
    return a;
  }
  async function upload(handle: string, title = 'Lake Kivu at dawn') {
    const c = await signIn(ctx.http, ctx.mail, `${handle}@example.com`);
    await c.agent.post('/api/channels').set('Origin', WEB).send({ handle, name: handle }).expect(201);
    const data = readFileSync(clip);
    const start = (await c.agent.post('/api/uploads').set('Origin', WEB).send({ fileName: 'clip.mp4', sizeBytes: data.length }).expect(201)).body;
    const urls = (await c.agent.post(`/api/uploads/${start.videoId}/parts`).set('Origin', WEB).send({ partNumbers: [1] }).expect(200)).body.urls;
    const etag = (await c.agent.put(urls[1].replace(WEB, '')).set('Origin', WEB).set('Content-Type', 'application/octet-stream').send(data).expect(200)).headers.etag;
    await c.agent.patch(`/api/hub/videos/${start.videoId}`).set('Origin', WEB).send({ title, visibility: 'PUBLIC' }).expect(200);
    await c.agent.post(`/api/uploads/${start.videoId}/complete`).set('Origin', WEB).send({ parts: [{ partNumber: 1, etag }] }).expect(200);
    return { agent: c.agent, id: start.videoId as string };
  }
  const settle = async (agent: any, id: string) => {
    for (let i = 0; i < 300; i++) { const v = (await agent.get(`/api/hub/videos/${id}`)).body.video; if (v.status === 'FLAGGED' || v.processingStage === 'Not published' || (v.status === 'READY' && v.processingStage === 'Ready')) return v; await new Promise((r) => setTimeout(r, 100)); }
    throw new Error('not settled');
  };
  const listed = async () => (await request(ctx.http).get('/api/videos?limit=24').expect(200)).body.videos.map((x: any) => x.id);

  test('Administration → Secrets: admins only, values checked, stored encrypted and never sent back', async () => {
    const someone = (await signIn(ctx.http, ctx.mail, 'someone@example.com')).agent;
    await someone.get('/api/admin/secrets').expect(403);
    await someone.put('/api/admin/secrets').set('Origin', WEB).send({ values: { ANTHROPIC_API_KEY: KEY } }).expect(403);
    const a = (await signIn(ctx.http, ctx.mail, 'admin@example.com')).agent;
    const before = (await a.get('/api/admin/secrets').expect(200)).body.secrets;
    expect(before.find((s: any) => s.name === 'ANTHROPIC_API_KEY')).toMatchObject({ set: false, source: null });
    expect((await a.put('/api/admin/secrets').set('Origin', WEB).send({ values: { ANTHROPIC_API_KEY: 'not-a-key' } }).expect(400)).body.message).toMatch(/does not look right/);
    await a.put('/api/admin/secrets').set('Origin', WEB).send({ values: { SOMETHING_ELSE: 'x' } }).expect(400);

    const res = await a.put('/api/admin/secrets').set('Origin', WEB).send({ values: { ANTHROPIC_API_KEY: KEY } }).expect(200);
    expect(res.body.saved).toEqual(['ANTHROPIC_API_KEY']);
    expect(JSON.stringify(res.body)).not.toContain(KEY);
    const after = (await a.get('/api/admin/secrets').expect(200)).body;
    expect(JSON.stringify(after)).not.toContain(KEY);
    expect(after.secrets.find((s: any) => s.name === 'ANTHROPIC_API_KEY')).toMatchObject({ set: true, source: 'app' });
    const row = await ctx.prisma.appSetting.findUniqueOrThrow({ where: { key: 'secrets' } });
    expect(JSON.stringify(row.value)).not.toContain(KEY);
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: 'SECRETS_SAVED' } });
    expect(JSON.stringify(audit)).not.toContain(KEY);

    // An empty value removes it.
    await a.put('/api/admin/secrets').set('Origin', WEB).send({ values: { ANTHROPIC_API_KEY: '' } }).expect(200);
    expect((await a.get('/api/admin/secrets').expect(200)).body.secrets.find((s: any) => s.name === 'ANTHROPIC_API_KEY').set).toBe(false);
  });

  test('without a key nothing is sent to Claude', async () => {
    const { agent, id } = await upload('nokey');
    await settle(agent, id);
    expect(calls).toHaveLength(0);
  });

  test('a clean video: Haiku looks at its frames and words and publishes it, alone', async () => {
    await admin();
    const { agent, id } = await upload('clean');
    const v = await settle(agent, id);
    expect(v.status).toBe('READY');
    const video = calls.filter((c) => c.images > 0);
    expect(video).toHaveLength(1);
    expect(video[0]).toMatchObject({ model: 'claude-haiku-5-5', effort: 'low', cached: true, key: `Bearer ${KEY}` });
    expect(video[0].text).toContain('Lake Kivu at dawn');
    expect(calls.find((c) => c.images === 0)!.text).toContain('New words a creator wants'); // the title, when it was set
    expect(await ctx.prisma.video.findUniqueOrThrow({ where: { id } })).toMatchObject({ safetyDecision: 'publish', safetyModel: 'claude-haiku-5-5', safetyLimitedAt: null });
    expect(await listed()).toContain(id);
  });

  test('published at once: people can watch while Claude looks; a rejection hides it and the creator reads why', async () => {
    await admin();
    let answerNow!: () => void;
    wait = new Promise((r) => { answerNow = r; });
    answer = () => ({ decision: 'reject', category: 'hate', confidence: 0.96, reason: 'It calls for violence against an ethnic group.' });
    const { agent, id } = await upload('quick', 'Market day');
    let v: any;
    for (let i = 0; i < 300; i++) { v = (await agent.get(`/api/hub/videos/${id}`)).body.video; if (v.status === 'READY') break; await new Promise((r) => setTimeout(r, 100)); }
    expect(v.status).toBe('READY');
    await request(ctx.http).get(`/api/videos/${id}`).expect(200);
    expect(await listed()).toContain(id);
    // Only a few small frames go to Claude (tokens), and only Haiku looks while it is sure.
    answerNow();
    v = await settle(agent, id);
    expect(calls.filter((c) => c.images > 0).map((c) => [c.model, c.images])).toEqual([['claude-haiku-5-5', 2]]);
    expect(v).toMatchObject({ processingStage: 'Not published' });
    expect(v.safety).toMatchObject({ decision: 'reject', reason: 'It calls for violence against an ethnic group.', canAppeal: true });
    await request(ctx.http).get(`/api/videos/${id}`).expect(404);
    expect(await listed()).not.toContain(id);
  });

  test('Haiku unsure: Opus decides; a rejected video is never shown, the creator reads why and can appeal once', async () => {
    await admin();
    answer = (model) => (model === 'claude-haiku-5-5' ? { decision: 'reject', category: 'violence/graphic', confidence: 0.5 }
      : { decision: 'reject', category: 'violence/graphic', confidence: 0.9, reason: 'Real injuries are shown in close-up to shock.' });
    const { agent, id } = await upload('gore', 'Accident');
    const v = await settle(agent, id);
    expect(calls.filter((c) => c.images > 0).map((c) => [c.model, c.effort])).toEqual([['claude-haiku-5-5', 'low'], ['claude-opus-5-5', 'medium']]);
    expect(v).toMatchObject({ processingStage: 'Not published' });
    expect(v.safety).toMatchObject({ decision: 'reject', reason: 'Real injuries are shown in close-up to shock.', canAppeal: true, appealedAt: null });
    await request(ctx.http).get(`/api/videos/${id}`).expect(404);
    expect(await ctx.prisma.report.findFirstOrThrow({ where: { videoId: id } })).toMatchObject({ reason: 'AUTOMATED_MATCH', status: 'RESOLVED' });

    // Appeal: Opus looks again and accepts; the video is processed and published as its creator chose.
    calls = [];
    answer = () => ({ decision: 'publish', reason: 'A road-safety news report; the injuries are not lingered on.' });
    await agent.post(`/api/hub/videos/${id}/appeal`).set('Origin', WEB).send({}).expect(200);
    expect((await agent.post(`/api/hub/videos/${id}/appeal`).set('Origin', WEB).send({}).expect(409)).body.message).toMatch(/already/);
    let after: any;
    for (let i = 0; i < 300; i++) { after = (await agent.get(`/api/hub/videos/${id}`)).body.video; if (after.status === 'READY' && after.processingStage === 'Ready') break; await new Promise((r) => setTimeout(r, 100)); }
    expect(after.status).toBe('READY');
    expect(calls[0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' });
    expect(calls[0].images).toBeGreaterThan(0);
    expect(calls[0].text).toContain('appeals');
    expect(after.safety).toMatchObject({ decision: 'publish', canAppeal: false });
    await request(ctx.http).get(`/api/videos/${id}`).expect(200);
  }, 90_000);

  test('an appeal Opus does not accept: still not shown, with the new reason', async () => {
    await admin();
    answer = () => ({ decision: 'reject', category: 'sexual', confidence: 0.97, reason: 'Sexually explicit.' });
    const { agent, id } = await upload('explicit', 'Night');
    await settle(agent, id);
    answer = () => ({ decision: 'reject', category: 'sexual', confidence: 0.98, reason: 'Looked again: explicit sexual activity is shown.' });
    await agent.post(`/api/hub/videos/${id}/appeal`).set('Origin', WEB).send({}).expect(200);
    for (let i = 0; i < 200 && !(await ctx.prisma.video.findUniqueOrThrow({ where: { id } })).safetyReason?.startsWith('Looked again'); i++) await new Promise((r) => setTimeout(r, 100));
    const v = (await agent.get(`/api/hub/videos/${id}`)).body.video;
    expect(v).toMatchObject({ processingStage: 'Not published' });
    expect(v.safety).toMatchObject({ decision: 'reject', reason: 'Looked again: explicit sexual activity is shown.', canAppeal: false });
    await request(ctx.http).get(`/api/videos/${id}`).expect(404);
  });

  test('limited: watchable by its link, out of feeds and search; released after 3 days unless people report it', async () => {
    await admin();
    answer = (model) => (model === 'claude-haiku-5-5' ? { decision: 'limit', confidence: 0.9 } : { decision: 'limit', category: 'violence/graphic', confidence: 0.8, reason: 'Shocking news footage.' });
    const a = await upload('borderline', 'Protest footage');
    const b = await upload('borderline2', 'Protest footage 2');
    await settle(a.agent, a.id); await settle(b.agent, b.id);
    expect(calls.filter((c) => c.model === 'claude-opus-5-5')).toHaveLength(0); // Haiku's "limit" stands: no Opus tokens
    expect((await a.agent.get(`/api/hub/videos/${a.id}`)).body.video.safety).toMatchObject({ decision: 'limit', limited: true, canAppeal: true });
    await request(ctx.http).get(`/api/videos/${a.id}`).expect(200);
    expect(await listed()).not.toContain(a.id);
    expect((await request(ctx.http).get('/api/search?q=protest').expect(200)).body.videos?.map((x: any) => x.id) ?? []).not.toContain(a.id);

    // Two people report b.
    for (const who of ['r1', 'r2']) {
      await signIn(ctx.http, ctx.mail, `${who}@example.com`);
      const u = await ctx.prisma.user.findUniqueOrThrow({ where: { email: `${who}@example.com` } });
      await ctx.prisma.report.create({ data: { videoId: b.id, reporterId: u.id, reason: 'VIOLENCE' } as any });
    }
    const jobs = (ctx.app.get(MediaQueue) as unknown as { inline: MediaJobs }).inline;
    expect(await jobs.releaseLimited()).toEqual({ released: 0, hidden: 0 }); // not yet 3 days
    expect(await jobs.releaseLimited(Date.now() + 4 * 86_400_000)).toEqual({ released: 1, hidden: 1 });
    expect(await listed()).toContain(a.id);
    expect((await ctx.prisma.video.findUniqueOrThrow({ where: { id: b.id } })).reviewHoldAt).not.toBeNull();
  });

  test('if both models decline to look, the video is rejected, with a reason the creator can appeal', async () => {
    await admin();
    answer = () => 'refuse';
    const { agent, id } = await upload('refused', 'Untitled');
    const v = await settle(agent, id);
    expect(calls.filter((c) => c.images > 0).map((c) => c.model)).toEqual(['claude-haiku-5-5', 'claude-opus-5-5']);
    expect(v.processingStage).toBe('Not published');
    expect(v.safety).toMatchObject({ decision: 'reject', canAppeal: true });
    expect(v.safety.reason).toMatch(/declined/);
  });

  test('comments and edited titles: the writer reads the AI\'s reason; transcripts can hide a published video', async () => {
    await admin();
    const { agent, id } = await upload('words');
    await settle(agent, id);
    wordsToo = true;
    answer = (_m, text) => (/idiot/.test(text) ? { decision: 'reject', category: 'harassment', confidence: 0.95, reason: 'It insults another person.' } : { decision: 'publish' });
    const viewer = (await signIn(ctx.http, ctx.mail, 'viewer@example.com')).agent;
    expect((await viewer.post(`/api/videos/${id}/comments`).set('Origin', WEB).send({ content: 'You are an idiot' }).expect(400)).body.message).toBe('Your comment was not posted: It insults another person.');
    await viewer.post(`/api/videos/${id}/comments`).set('Origin', WEB).send({ content: 'Beautiful place' }).expect(201);
    expect(calls.at(-1)!.text).toContain('A comment someone wants to post');
    expect((await agent.patch(`/api/hub/videos/${id}`).set('Origin', WEB).send({ title: 'My neighbour is an idiot' }).expect(400)).body.message).toMatch(/^Your title was not saved: It insults another person\./);

    answer = () => ({ decision: 'reject', category: 'hate', confidence: 0.95, reason: 'It calls for violence against an ethnic group.' });
    expect(await checkTranscript(ctx.prisma, ctx.config, id, 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nsome words\n')).toBe(true);
    expect(calls.at(-1)!.text).toContain('What is said in a published video');
    await request(ctx.http).get(`/api/videos/${id}`).expect(404);
    expect((await agent.get(`/api/hub/videos/${id}`)).body.video.safety).toMatchObject({ decision: 'reject', reason: 'It calls for violence against an ethnic group.', canAppeal: true });
  });
  test('comments from established accounts are shown at once and checked just after; edits are checked before they are saved', async () => {
    await admin();
    const { agent: creator, id } = await upload('talk');
    await settle(creator, id);
    const viewer = (await signIn(ctx.http, ctx.mail, 'regular@example.com')).agent;
    await ctx.prisma.user.update({ where: { email: 'regular@example.com' }, data: { createdAt: new Date(Date.now() - 30 * 86_400_000) } });
    wordsToo = true;
    answer = (_m, text) => (/idiot/.test(text) ? { decision: 'reject', category: 'harassment', confidence: 0.95, reason: 'It insults another person.' } : { decision: 'publish' });
    const before = calls.length;

    // Posted without waiting for the AI; checked right after, and removed.
    const bad = (await viewer.post(`/api/videos/${id}/comments`).set('Origin', WEB).send({ content: 'What an idiot' }).expect(201)).body.comment;
    const good = (await viewer.post(`/api/videos/${id}/comments`).set('Origin', WEB).send({ content: 'Lovely place, thank you' }).expect(201)).body.comment;
    for (let i = 0; i < 100 && (await ctx.prisma.comment.count({ where: { checkedAt: null } })) > 0; i++) await new Promise((r) => setTimeout(r, 100));
    expect(calls.length - before).toBe(2);
    expect(await ctx.prisma.comment.findUnique({ where: { id: bad.id } })).toBeNull();
    expect((await ctx.prisma.comment.findUniqueOrThrow({ where: { id: good.id } })).checkedAt).not.toBeNull();
    expect((await ctx.prisma.video.findUniqueOrThrow({ where: { id } })).commentCount).toBe(1);
    // The creator hears only about the comment that stayed.
    const told = await ctx.prisma.notification.findMany({ where: { type: 'COMMENT', videoId: id } });
    expect(told.map((n) => n.commentId)).toEqual([good.id]);

    // An edit into an insult is refused before it is saved.
    expect((await viewer.patch(`/api/comments/${good.id}`).set('Origin', WEB).send({ content: 'You are an idiot' }).expect(400)).body.message).toBe('Your comment was not saved: It insults another person.');
    expect((await ctx.prisma.comment.findUniqueOrThrow({ where: { id: good.id } })).content).toBe('Lovely place, thank you');

    // Comments the API did not get to (it stopped): the worker's sweep checks them.
    const missed = await ctx.prisma.comment.create({ data: { videoId: id, userId: (await ctx.prisma.user.findUniqueOrThrow({ where: { email: 'regular@example.com' } })).id, content: 'idiot again', checkedAt: null, createdAt: new Date(Date.now() - 5 * 60_000) } });
    await ctx.prisma.video.update({ where: { id }, data: { commentCount: { increment: 1 } } });
    expect(await sweepComments(ctx.prisma, ctx.config)).toEqual({ checked: 1, removed: 1 });
    expect(await ctx.prisma.comment.findUnique({ where: { id: missed.id } })).toBeNull();

    // Words the rules notice still wait for the AI (and over the day's budget, low-risk ones get the rules only).
    const sync = calls.length;
    const flagged = (await viewer.post(`/api/videos/${id}/comments`).set('Origin', WEB).send({ content: 'sexy dance tonight' }).expect(201)).body.comment;
    expect(calls.length).toBe(sync + 1); // asked before posting: the AI judges what the rules noticed
    expect(calls.at(-1)!.text).toMatch(/Automatic word checks noticed/);
    expect((await ctx.prisma.comment.findUniqueOrThrow({ where: { id: flagged.id } })).checkedAt).not.toBeNull();
    ctx.config.safety.aiCommentsPerDay = 1;
    await viewer.post(`/api/videos/${id}/comments`).set('Origin', WEB).send({ content: 'Nice one' }).expect(201);
    await viewer.post(`/api/videos/${id}/comments`).set('Origin', WEB).send({ content: 'Another nice one' }).expect(201);
    for (let i = 0; i < 50 && (await ctx.prisma.comment.count({ where: { checkedAt: null } })) > 0; i++) await new Promise((r) => setTimeout(r, 100));
    expect(calls.length - sync).toBe(2);
    ctx.config.safety.aiCommentsPerDay = 0;
  }, 60_000);

  test('a re-upload from another app (its watermark in the pictures) is not published, with the reason', async () => {
    await admin();
    const reason = 'A TikTok watermark and another account\'s @name are visible: this video was downloaded from TikTok. Upload your original video without its logo.';
    answer = () => ({ decision: 'reject', category: 'reupload', confidence: 0.95, reason });
    const { agent, id } = await upload('screenrec', 'Funny dance');
    const v = await settle(agent, id);
    // The moderator is told to look for other apps' watermarks in every corner.
    expect(calls[0].system).toMatch(/Videos from other apps, platforms, streaming services or TV/);
    expect(calls[0].system).toMatch(/YouTube or YouTube Shorts.*Netflix.*TV channels/s);
    expect(calls[0].system).toMatch(/Graphic injuries and gore.*always rejected/);
    expect(calls[0].system).toMatch(/TikTok/);
    expect(v).toMatchObject({ processingStage: 'Not published' });
    expect(v.safety).toMatchObject({ decision: 'reject', reason, canAppeal: true });
    await request(ctx.http).get(`/api/videos/${id}`).expect(404);
  });

});

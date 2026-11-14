import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { makeApp, resetDb, signIn, WEB } from './helpers';
import { decide } from '../src/safety/policy';
import { normalise, scoreText } from '../src/safety/rules';
import { checkTranscript, vttText } from '../src/safety/check';

// Automatic content safety (TRUST_AND_SAFETY.md): every new video is checked while it is transcoded, and nothing
// but its owner can see it, nor are its files on the public CDN, until the check passes. Words are checked wherever
// people write them.
const dir = mkdtempSync(join(tmpdir(), 'freeme-content-safety-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const clip = (() => {
  let f: string | null = null;
  return () => {
    if (f) return f;
    f = join(dir, 'clip.mp4');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=500:duration=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', f]);
    return f;
  };
})();

describe('rules and policy', () => {
  test('the most serious category over its line decides; child safety first', () => {
    expect(decide({ sexual: 0.5, hate: 0.3 })).toMatchObject({ hold: false });
    expect(decide({ violence: 0.9, hate: 0.7 })).toMatchObject({ hold: true, category: 'hate', priority: 60 });
    expect(decide({ sexual: 0.95 }, { 'sexual/minors': 0.3 })).toMatchObject({ hold: true, category: 'sexual/minors', priority: 100 });
  });

  test('disguised words, threats against groups in Kinyarwanda, French and English; harmless lookalikes pass', () => {
    expect(normalise('S3XY  n.u.d.e  viiiideo')).toBe('sexy nude video');
    expect(scoreText('Tubamare abatutsi bose').scores.hate).toBe(1);
    expect(scoreText('Les musulmans doivent mourir').scores.hate).toBe(1);
    expect(scoreText('kill all the refugees').scores.hate).toBe(1);
    expect(scoreText('p o r n tonight').scores.sexual).toBe(1);
    expect(scoreText('A cockroach in my kitchen').scores).toEqual({});
    expect(scoreText('Inyenzi').scores.hate).toBe(0.5); // a hint on its own, under the line
    expect(scoreText('Beautiful sunrise over Lake Kivu').scores).toEqual({});
    expect(vttText('WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\n<v Speaker>Hello there</v>\n')).toBe('Hello there');
  });
});

describe('with an AI engine looking at pictures', () => {
  let ai: Server;
  let verdict: Record<string, number> = {};
  let delayMs = 0;
  let images = 0;
  let ctx: Awaited<ReturnType<typeof makeApp>>;
  beforeAll(async () => {
    // A stand-in for OpenAI's moderation endpoint: answers every input with `verdict` (after `delayMs`).
    ai = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const j = JSON.parse(body);
        if (Array.isArray(j.input) && j.input[0]?.type === 'image_url') images++;
        setTimeout(() => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ results: [{ category_scores: verdict }] })), delayMs);
      });
    });
    await new Promise<void>((r) => ai.listen(0, '127.0.0.1', r));
    ctx = await makeApp({ redis: false, storageDir: join(dir, 'storage'), adminEmails: ['mod@example.com'],
      env: { SAFETY_ENGINE: 'openai', SAFETY_OPENAI_KEY: 'test-key', SAFETY_OPENAI_URL: `http://127.0.0.1:${(ai.address() as AddressInfo).port}/v1/moderations` } });
  }, 60_000);
  beforeEach(async () => { await resetDb(ctx.prisma); ctx.mail.outbox.length = 0; await ctx.clearLimits(); verdict = {}; delayMs = 0; images = 0; });
  afterAll(async () => { await ctx.app.close(); ai.close(); });

  async function upload(handle: string) {
    const c = await signIn(ctx.http, ctx.mail, `${handle}@example.com`);
    await c.agent.post('/api/channels').set('Origin', WEB).send({ handle, name: handle }).expect(201);
    const data = readFileSync(clip());
    const start = (await c.agent.post('/api/uploads').set('Origin', WEB).send({ fileName: 'clip.mp4', sizeBytes: data.length }).expect(201)).body;
    const urls = (await c.agent.post(`/api/uploads/${start.videoId}/parts`).set('Origin', WEB).send({ partNumbers: [1] }).expect(200)).body.urls;
    const etag = (await c.agent.put(urls[1].replace(WEB, '')).set('Origin', WEB).set('Content-Type', 'application/octet-stream').send(data).expect(200)).headers.etag;
    // Published straight away by its creator, before processing even starts.
    await c.agent.patch(`/api/hub/videos/${start.videoId}`).set('Origin', WEB).send({ title: 'Lake Kivu at dawn', visibility: 'PUBLIC' }).expect(200);
    await c.agent.post(`/api/uploads/${start.videoId}/complete`).set('Origin', WEB).send({ parts: [{ partNumber: 1, etag }] }).expect(200);
    return { agent: c.agent, id: start.videoId as string };
  }
  const settle = async (agent: any, id: string) => {
    for (let i = 0; i < 300; i++) { const v = (await agent.get(`/api/hub/videos/${id}`)).body.video; if (v.status === 'FLAGGED' || (v.status === 'READY' && v.processingStage === 'Ready')) return v; await new Promise((r) => setTimeout(r, 100)); }
    throw new Error('not settled');
  };

  test('a clean video is checked while it is transcoded, then shown; its pictures were looked at', async () => {
    const { agent, id } = await upload('clean');
    const v = await settle(agent, id);
    expect(v.status).toBe('READY');
    expect(images).toBeGreaterThan(0);
    const row = await ctx.prisma.video.findUniqueOrThrow({ where: { id } });
    expect(row.safetyCheckedAt).not.toBeNull();
    expect(row.mediaLocation).toBe('PUBLIC');
    await request(ctx.http).get(`/api/videos/${id}`).expect(200);
  });

  test('while the check is still running nobody else can see it and its files are not on the public CDN', async () => {
    delayMs = 2500;
    const { agent, id } = await upload('slowcheck');
    // Wait until the first version is encoded and the check is the only thing left.
    for (let i = 0; i < 100 && images === 0; i++) await new Promise((r) => setTimeout(r, 100));
    const row = await ctx.prisma.video.findUniqueOrThrow({ where: { id } });
    expect(row.safetyCheckedAt).toBeNull();
    await request(ctx.http).get(`/api/videos/${id}`).expect(404);
    expect((await request(ctx.http).get('/api/videos?limit=24').expect(200)).body.videos.map((x: any) => x.id)).not.toContain(id);
    expect(existsSync(join(dir, 'storage', 'pub', id))).toBe(false);
    await agent.get(`/api/videos/${id}`).expect(200); // the owner can preview it
    await settle(agent, id);
    await request(ctx.http).get(`/api/videos/${id}`).expect(200);
  });

  test('graphic injuries the classifier is sure of are not published, at once, and the creator reads why', async () => {
    verdict = { 'violence/graphic': 0.96 };
    const { agent, id } = await upload('bloody');
    const v = await settle(agent, id);
    expect(v).toMatchObject({ status: 'FLAGGED', processingStage: 'Not published' });
    expect(v.safety).toMatchObject({ decision: 'reject', canAppeal: true });
    expect(v.safety.reason).toMatch(/graphic injuries, blood or gore/);
    // Kept on record (resolved). (This stand-in classifier also scores the title as gore, so the title check opened a report too.)
    expect(await ctx.prisma.report.findFirstOrThrow({ where: { videoId: id, status: 'RESOLVED' } })).toMatchObject({ priority: 80, details: expect.stringMatching(/^Rejected automatically/) });
    await request(ctx.http).get(`/api/videos/${id}`).expect(404);
    expect(existsSync(join(dir, 'storage', 'pub', id))).toBe(false);
  });

  test('sexual content over the line but not certain is held before anyone sees it, first in the moderators\' queue', async () => {
    verdict = { sexual: 0.75, violence: 0.1 };
    const { agent, id } = await upload('flagged');
    const v = await settle(agent, id);
    expect(v.status).toBe('FLAGGED');
    const row = await ctx.prisma.video.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ safetyCheckedAt: null, mediaLocation: 'PRIVATE', hlsMasterKey: null });
    const report = await ctx.prisma.report.findFirstOrThrow({ where: { videoId: id } });
    expect(report).toMatchObject({ reason: 'AUTOMATED_MATCH', priority: 80 });
    expect(report.details).toMatch(/Sexual content/);
    await request(ctx.http).get(`/api/videos/${id}`).expect(404);
    expect(existsSync(join(dir, 'storage', 'pub', id))).toBe(false);
  });
});

describe('without an engine, and where people write', () => {
  let ctx: Awaited<ReturnType<typeof makeApp>>;
  beforeAll(async () => { ctx = await makeApp({ redis: false, storageDir: join(dir, 'storage2'), adminEmails: ['mod@example.com'], env: { SAFETY_UNSCANNED_REVIEW: 'new' } }); }, 60_000);
  beforeEach(async () => { await resetDb(ctx.prisma); ctx.mail.outbox.length = 0; await ctx.clearLimits(); });
  afterAll(async () => { await ctx.app.close(); });

  async function space(handle: string) {
    const c = await signIn(ctx.http, ctx.mail, `${handle}@example.com`);
    const ch = (await c.agent.post('/api/channels').set('Origin', WEB).send({ handle, name: handle }).expect(201)).body.channel;
    return { agent: c.agent, channelId: ch.id as string };
  }
  async function upload(agent: any) {
    const data = readFileSync(clip());
    const start = (await agent.post('/api/uploads').set('Origin', WEB).send({ fileName: 'clip.mp4', sizeBytes: data.length }).expect(201)).body;
    const urls = (await agent.post(`/api/uploads/${start.videoId}/parts`).set('Origin', WEB).send({ partNumbers: [1] }).expect(200)).body.urls;
    const etag = (await agent.put(urls[1].replace(WEB, '')).set('Origin', WEB).set('Content-Type', 'application/octet-stream').send(data).expect(200)).headers.etag;
    await agent.post(`/api/uploads/${start.videoId}/complete`).set('Origin', WEB).send({ parts: [{ partNumber: 1, etag }] }).expect(200);
    for (let i = 0; i < 300; i++) { const v = (await agent.get(`/api/hub/videos/${start.videoId}`)).body.video; if (v.status === 'FLAGGED' || (v.status === 'READY' && v.processingStage === 'Ready')) return v; await new Promise((r) => setTimeout(r, 100)); }
    throw new Error('not settled');
  }

  test('a new Space\'s videos wait for a person; an established one\'s go through on the text check', async () => {
    const fresh = await space('newcomer');
    expect((await upload(fresh.agent)).status).toBe('FLAGGED');
    expect(await ctx.prisma.report.findFirstOrThrow({ where: { reason: 'AUTOMATED_MATCH' } })).toMatchObject({ priority: 30 });

    const known = await space('regular');
    await ctx.prisma.channel.update({ where: { id: known.channelId }, data: { createdAt: new Date(Date.now() - 30 * 86_400_000) } });
    for (let i = 0; i < 3; i++) await ctx.prisma.video.create({ data: { channelId: known.channelId, title: `Old ${i}`, status: 'READY', visibility: 'PUBLIC', mediaLocation: 'PUBLIC', publishedAt: new Date() } });
    expect((await upload(known.agent)).status).toBe('READY');
  });

  test('with the rule off (the default), videos it held are released and processed again; other holds stay', async () => {
    const fresh = await space('waiting');
    const held = await upload(fresh.agent);
    expect(held.status).toBe('FLAGGED');
    // Another video held for a different reason stays held.
    const other = await ctx.prisma.video.create({ data: { channelId: fresh.channelId, title: 'Other', status: 'FLAGGED', visibility: 'PUBLIC', mediaLocation: 'PUBLIC' } });
    await ctx.prisma.report.create({ data: { videoId: other.id, reason: 'AUTOMATED_MATCH', details: 'Same file as a video moderators removed', priority: 40 } });

    const { releaseUnscannedHolds } = await import('../src/safety/check');
    const queued: string[] = [];
    const off = { ...ctx.config, safety: { ...ctx.config.safety, unscannedReview: 'none' as const } };
    expect(await releaseUnscannedHolds(ctx.prisma, ctx.config, async (id) => { queued.push(id); })).toBe(0);
    expect(await releaseUnscannedHolds(ctx.prisma, off, async (id) => { queued.push(id); })).toBe(1);
    expect(queued).toEqual([held.id]);
    expect(await ctx.prisma.video.findUniqueOrThrow({ where: { id: held.id } })).toMatchObject({ status: 'PROCESSING' });
    expect(await ctx.prisma.report.findFirstOrThrow({ where: { videoId: held.id } })).toMatchObject({ status: 'DISMISSED' });
    expect(await ctx.prisma.video.findUniqueOrThrow({ where: { id: other.id } })).toMatchObject({ status: 'FLAGGED' });
  });

  test('a title changed to hate speech hides a published video at once and asks a moderator', async () => {
    const { agent, channelId } = await space('editor');
    const v = await ctx.prisma.video.create({ data: { channelId, title: 'Market day', status: 'READY', visibility: 'PUBLIC', mediaLocation: 'PUBLIC', publishedAt: new Date(), hlsMasterKey: 'hls/master.m3u8' } });
    await request(ctx.http).get(`/api/videos/${v.id}`).expect(200);
    await agent.patch(`/api/hub/videos/${v.id}`).set('Origin', WEB).send({ title: 'Tubamare abatutsi bose' }).expect(200);
    await request(ctx.http).get(`/api/videos/${v.id}`).expect(404);
    expect(await ctx.prisma.report.findFirstOrThrow({ where: { videoId: v.id } })).toMatchObject({ reason: 'AUTOMATED_MATCH', priority: 60 });
    // A harmless edit of another video changes nothing.
    const w = await ctx.prisma.video.create({ data: { channelId, title: 'Drums', status: 'READY', visibility: 'PUBLIC', mediaLocation: 'PUBLIC', publishedAt: new Date(), hlsMasterKey: 'hls/master.m3u8' } });
    await agent.patch(`/api/hub/videos/${w.id}`).set('Origin', WEB).send({ title: 'Drums of Rwanda', description: 'Intore dancers in Huye' }).expect(200);
    await request(ctx.http).get(`/api/videos/${w.id}`).expect(200);
  });

  test('comments over the line are refused with the reason; moderators add their own terms and try wording', async () => {
    const { channelId } = await space('host');
    const v = await ctx.prisma.video.create({ data: { channelId, title: 'Football', status: 'READY', visibility: 'PUBLIC', mediaLocation: 'PUBLIC', publishedAt: new Date(), hlsMasterKey: 'hls/master.m3u8' } });
    const fan = await signIn(ctx.http, ctx.mail, 'fan@example.com');
    await fan.agent.post(`/api/videos/${v.id}/comments`).set('Origin', WEB).send({ content: 'What a goal!' }).expect(201);
    const bad = await fan.agent.post(`/api/videos/${v.id}/comments`).set('Origin', WEB).send({ content: 'all the immigrants should be killed' }).expect(400);
    expect(bad.body.message).toMatch(/not posted.*hate/i);

    const mod = await signIn(ctx.http, ctx.mail, 'mod@example.com');
    await fan.agent.post('/api/moderation/safety/terms').set('Origin', WEB).send({ term: 'x', language: 'rw', category: 'hate', weight: 1 }).expect(403);
    await mod.agent.post('/api/moderation/safety/terms').set('Origin', WEB).send({ term: 'Ijambo Ribi', language: 'rw', category: 'harassment', weight: 1 }).expect(201);
    expect((await mod.agent.post('/api/moderation/safety/try').set('Origin', WEB).send({ text: 'uri ijambo ribi' }).expect(200)).body).toMatchObject({ hold: true, category: 'harassment' });
    await fan.agent.post(`/api/videos/${v.id}/comments`).set('Origin', WEB).send({ content: 'Uri IJAMBO   ribi' }).expect(400);
    expect((await mod.agent.get('/api/moderation/safety').expect(200)).body.terms).toEqual([expect.objectContaining({ term: 'ijambo ribi', language: 'rw', category: 'harassment' })]);
  });

  test('what is said: a hateful transcript hides the video and asks a moderator', async () => {
    const { channelId } = await space('speaker');
    const v = await ctx.prisma.video.create({ data: { channelId, title: 'Talk', status: 'READY', visibility: 'PUBLIC', mediaLocation: 'PUBLIC', publishedAt: new Date(), hlsMasterKey: 'hls/master.m3u8' } });
    expect(await checkTranscript(ctx.prisma as never, ctx.config, v.id, 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\nGood evening everyone\n')).toBe(false);
    expect(await checkTranscript(ctx.prisma as never, ctx.config, v.id, 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\nAbatutsi bose nibapfe\n')).toBe(true);
    await request(ctx.http).get(`/api/videos/${v.id}`).expect(404);
    expect((await ctx.prisma.report.findFirstOrThrow({ where: { videoId: v.id } })).details).toMatch(/automatic transcript/);
  });
});

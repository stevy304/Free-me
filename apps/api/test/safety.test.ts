import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { makeApp, resetDb, signIn, WEB } from './helpers';

// The safety check with real processing (local storage, jobs inside the API) and a stand-in outside scanner.
const dir = mkdtempSync(join(tmpdir(), 'freeme-safety-'));
let scanner: Server;
const seen: Array<{ token: string | undefined; frames: number; sha256: string }> = [];
let scannerReply: { status: number; body: object } = { status: 200, body: { match: false } };
let ctx: Awaited<ReturnType<typeof makeApp>>;

const clip = (name: string, freq: number) => {
  const f = join(dir, name);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=3', '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=3`, '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', f]);
  return f;
};

beforeAll(async () => {
  scanner = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const j = JSON.parse(body);
      seen.push({ token: req.headers.authorization, frames: j.frames.length, sha256: j.sha256 });
      res.writeHead(scannerReply.status, { 'content-type': 'application/json' }).end(JSON.stringify(scannerReply.body));
    });
  });
  await new Promise<void>((r) => scanner.listen(0, '127.0.0.1', r));
  ctx = await makeApp({
    redis: false, storageDir: join(dir, 'storage'), adminEmails: ['mod@example.com'],
    env: { SAFETY_SCAN_URL: `http://127.0.0.1:${(scanner.address() as AddressInfo).port}/check`, SAFETY_SCAN_TOKEN: 'scan-secret', NEW_ACCOUNT_DAILY_UPLOADS: '2' },
  });
}, 60_000);
beforeEach(async () => { await resetDb(ctx.prisma); ctx.mail.outbox.length = 0; await ctx.clearLimits(); seen.length = 0; scannerReply = { status: 200, body: { match: false } }; });
afterAll(async () => { await ctx.app.close(); scanner.close(); rmSync(dir, { recursive: true, force: true }); });

async function creator(email: string, handle: string) {
  const c = await signIn(ctx.http, ctx.mail, email);
  await c.agent.post('/api/channels').set('Origin', WEB).send({ handle, name: handle }).expect(201);
  return c.agent;
}
async function upload(agent: ReturnType<typeof request.agent>, file: string) {
  const data = readFileSync(file);
  const start = (await agent.post('/api/uploads').set('Origin', WEB).send({ fileName: 'clip.mp4', sizeBytes: data.length }).expect(201)).body;
  const urls = (await agent.post(`/api/uploads/${start.videoId}/parts`).set('Origin', WEB).send({ partNumbers: [1] }).expect(200)).body.urls;
  const etag = (await agent.put(urls[1].replace(WEB, '')).set('Origin', WEB).set('Content-Type', 'application/octet-stream').send(data).expect(200)).headers.etag;
  await agent.post(`/api/uploads/${start.videoId}/complete`).set('Origin', WEB).send({ parts: [{ partNumber: 1, etag }] }).expect(200);
  return start.videoId as string;
}
async function settled(agent: ReturnType<typeof request.agent>, id: string) {
  for (let i = 0; i < 300; i++) {
    const v = (await agent.get(`/api/hub/videos/${id}`)).body.video;
    if (v.status === 'FLAGGED' || (v.status === 'READY' && v.processingStage === 'Ready')) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('not settled');
}

test('a removed video cannot come back: the same file is held for review, a moderator can release it; the scanner sees every upload', async () => {
  const a = await creator('first@example.com', 'first');
  const fileA = clip('a.mp4', 300);
  const original = await upload(a, fileA);
  expect(await settled(a, original)).toMatchObject({ status: 'READY' });
  // Every upload went to the outside scanner, with its token and frames.
  expect(seen).toEqual([expect.objectContaining({ token: 'Bearer scan-secret', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) })]);
  expect(seen[0].frames).toBeGreaterThan(0);

  // A viewer reports it; a moderator removes it.
  const viewer = await signIn(ctx.http, ctx.mail, 'viewer@example.com');
  const me = await ctx.prisma.user.findUniqueOrThrow({ where: { email: 'viewer@example.com' } });
  const rep = await ctx.prisma.report.create({ data: { reporterId: me.id, videoId: original, reason: 'VIOLENT' } });
  void viewer;
  const mod = await signIn(ctx.http, ctx.mail, 'mod@example.com');
  await mod.agent.post(`/api/moderation/reports/${rep.id}/decision`).set('Origin', WEB).send({ action: 'remove', notes: 'Graphic violence.' }).expect(200);
  expect(await ctx.prisma.blockedHash.count({ where: { videoId: original, source: 'TAKEDOWN' } })).toBe(2);

  // Someone else uploads the same file: held, never public, in the moderators' queue as an automatic report.
  const b = await creator('second@example.com', 'second');
  const again = await upload(b, fileA);
  const held = await settled(b, again);
  expect(held).toMatchObject({ status: 'FLAGGED', processingStage: 'Held for review', renditions: [] });
  await request(ctx.http).get(`/api/videos/${again}`).expect(404);
  const queue = (await mod.agent.get('/api/moderation/reports').expect(200)).body.reports;
  const auto = queue.find((r: any) => r.video.id === again);
  expect(auto).toMatchObject({ automatic: true, reporterEmail: null, reasonLabel: 'Automatic upload check', details: 'Same file as a video moderators removed' });

  // Released by a moderator: processed and published, and not checked again.
  expect((await mod.agent.post(`/api/moderation/reports/${auto.id}/decision`).set('Origin', WEB).send({ action: 'dismiss', notes: 'News report, allowed.' }).expect(200)).body.video).toEqual({ id: again, released: true });
  expect(await settled(b, again)).toMatchObject({ status: 'READY', processingStage: 'Ready' });
  expect((await ctx.prisma.video.findUniqueOrThrow({ where: { id: again } })).screeningClearedAt).not.toBeNull();
}, 180_000);

test('the outside scanner can hold an upload; when it fails, uploads go through unless told to fail closed', async () => {
  const a = await creator('maker@example.com', 'maker');
  scannerReply = { status: 200, body: { match: true, label: 'known image' } };
  const flagged = await upload(a, clip('b.mp4', 500));
  expect(await settled(a, flagged)).toMatchObject({ status: 'FLAGGED' });
  expect((await ctx.prisma.report.findFirstOrThrow({ where: { videoId: flagged } })).details).toBe('Flagged by the automatic scan: known image');

  scannerReply = { status: 500, body: {} };
  const passes = await upload(a, clip('c.mp4', 700));
  expect(await settled(a, passes)).toMatchObject({ status: 'READY' });
}, 180_000);

test('new accounts upload a few videos a day in their first week; older accounts are not limited this way', async () => {
  const a = await creator('new@example.com', 'newbie');
  const start = () => a.post('/api/uploads').set('Origin', WEB).send({ fileName: 'x.mp4', sizeBytes: 1000 });
  await start().expect(201);
  await start().expect(201);
  const third = await start().expect(429);
  expect(third.body.message).toBe('New accounts can upload up to 2 videos a day during their first week.');
  await ctx.prisma.user.update({ where: { email: 'new@example.com' }, data: { createdAt: new Date(Date.now() - 8 * 86_400_000) } });
  await start().expect(201);
});

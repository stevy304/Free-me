import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { makeApp, resetDb, signIn, WEB } from './helpers';
import { madeByApp, probe } from '../src/media/probe';

// Videos downloaded from another app (TikTok and others) are not published (TRUST_AND_SAFETY.md, "Re-uploads"):
// the marks the app writes into the file decide at once; the AI moderator also looks for watermarks in the pictures.
const dir = mkdtempSync(join(tmpdir(), 'freeme-reupload-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const clip = (name: string, metadata: string[] = []) => {
  const f = join(dir, name);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=180x320:rate=25:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=500:duration=4',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', ...metadata.flatMap((m) => ['-metadata', m]), f]);
  return f;
};

test('the app a video was downloaded from, by the marks in its file', async () => {
  expect(madeByApp([{ comment: 'vid:v0d044g50000cqk3abcdeflmn', encoder: 'Lavf58.76.100' }])).toBe('TikTok');
  expect(madeByApp([{ aigc_info: '{"aigc_label_type":0}' }])).toBe('TikTok');
  expect(madeByApp([{ major_brand: 'isom' }, { handler_name: 'VideoHandler', vendor_id: '[0][0][0][0]' }])).toBeNull();
  expect(madeByApp([{ comment: 'My holiday in Musanze' }])).toBeNull();
  // Download tools write the page they took it from.
  expect(madeByApp([{ comment: 'https://www.youtube.com/watch?v=abc123' }])).toBe('YouTube');
  expect(madeByApp([{ purl: 'https://www.instagram.com/reel/Cxyz/' }])).toBe('Instagram');
  expect(madeByApp([{ comment: 'https://x.com/someone/status/123' }])).toBe('X');
  expect(madeByApp([{ purl: 'https://vimeo.com/123456' }])).toBe('Vimeo');
  expect(madeByApp([{ comment: 'https://t.me/somechannel/42' }])).toBe('Telegram');
  // Read from a real file.
  expect((await probe('ffprobe', clip('tiktok-probe.mp4', ['comment=vid:v0d044g50000cqk3abcdeflmn']))).madeBy).toBe('TikTok');
  expect((await probe('ffprobe', clip('own-probe.mp4'))).madeBy).toBeNull();
});

describe('at upload', () => {
  let ctx: Awaited<ReturnType<typeof makeApp>>;
  beforeAll(async () => { ctx = await makeApp({ redis: false, storageDir: join(dir, 'storage'), env: { SAFETY_UNSCANNED_REVIEW: 'none' } }); }, 60_000);
  beforeEach(async () => { await resetDb(ctx.prisma); ctx.mail.outbox.length = 0; await ctx.clearLimits(); });
  afterAll(async () => { await ctx.app.close(); });

  async function upload(handle: string, file: string) {
    const c = await signIn(ctx.http, ctx.mail, `${handle}@example.com`);
    await c.agent.post('/api/channels').set('Origin', WEB).send({ handle, name: handle }).expect(201);
    const data = readFileSync(file);
    const start = (await c.agent.post('/api/uploads').set('Origin', WEB).send({ fileName: 'moment.mp4', sizeBytes: data.length }).expect(201)).body;
    const urls = (await c.agent.post(`/api/uploads/${start.videoId}/parts`).set('Origin', WEB).send({ partNumbers: [1] }).expect(200)).body.urls;
    const etag = (await c.agent.put(urls[1].replace(WEB, '')).set('Origin', WEB).set('Content-Type', 'application/octet-stream').send(data).expect(200)).headers.etag;
    await c.agent.patch(`/api/hub/videos/${start.videoId}`).set('Origin', WEB).send({ title: 'Test video', visibility: 'PUBLIC' }).expect(200);
    await c.agent.post(`/api/uploads/${start.videoId}/complete`).set('Origin', WEB).send({ parts: [{ partNumber: 1, etag }] }).expect(200);
    for (let i = 0; i < 300; i++) {
      const v = (await c.agent.get(`/api/hub/videos/${start.videoId}`)).body.video;
      if (v.status === 'FLAGGED' || (v.status === 'READY' && v.processingStage === 'Ready')) return { agent: c.agent, id: start.videoId as string, video: v };
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('not settled');
  }

  test('a TikTok download is not published; the creator reads why and can appeal; their own video is published', async () => {
    const tiktok = await upload('copier', clip('tiktok.mp4', ['comment=vid:v0d044g50000cqk3abcdeflmn']));
    expect(tiktok.video).toMatchObject({ status: 'FLAGGED', processingStage: 'Not published' });
    expect(tiktok.video.safety).toMatchObject({ decision: 'reject', canAppeal: true });
    expect(tiktok.video.safety.reason).toMatch(/downloaded from TikTok.*upload the original/s);
    await request(ctx.http).get(`/api/videos/${tiktok.id}`).expect(404);
    expect((await request(ctx.http).get('/api/videos?limit=24&moments=true').expect(200)).body.videos.map((v: any) => v.id)).not.toContain(tiktok.id);
    expect(await ctx.prisma.report.findFirstOrThrow({ where: { videoId: tiktok.id } })).toMatchObject({ reason: 'AUTOMATED_MATCH', status: 'RESOLVED' });
    // Without the AI moderator, an appeal goes to a moderator.
    await tiktok.agent.post(`/api/hub/videos/${tiktok.id}/appeal`).set('Origin', WEB).send({}).expect(200);
    for (let i = 0; i < 50 && !(await ctx.prisma.report.count({ where: { videoId: tiktok.id, status: 'PENDING' } })); i++) await new Promise((r) => setTimeout(r, 100));
    expect(await ctx.prisma.report.findFirstOrThrow({ where: { videoId: tiktok.id, status: 'PENDING' } })).toMatchObject({ priority: 50 });

    const own = await upload('maker', clip('own.mp4'));
    expect(own.video.status).toBe('READY');
    await request(ctx.http).get(`/api/videos/${own.id}`).expect(200);
  }, 90_000);
});

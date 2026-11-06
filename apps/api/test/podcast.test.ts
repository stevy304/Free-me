import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { makeApp, resetDb, signIn, WEB } from './helpers';

// A podcast: a sound file and a cover image become a video (cover + waveform), processed like any other.
const dir = mkdtempSync(join(tmpdir(), 'freeme-podcast-'));
let ctx: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => { ctx = await makeApp({ redis: false, storageDir: join(dir, 'storage') }); }, 60_000);
beforeEach(async () => { await resetDb(ctx.prisma); ctx.mail.outbox.length = 0; await ctx.clearLimits(); });
afterAll(async () => { await ctx.app.close(); rmSync(dir, { recursive: true, force: true }); });

test('a sound file with a cover becomes a podcast video: playable, landscape, the cover as its thumbnail', async () => {
  const c = await signIn(ctx.http, ctx.mail, 'host@example.com');
  await c.agent.post('/api/channels').set('Origin', WEB).send({ handle: 'host', name: 'Host' }).expect(201);
  const audio = join(dir, 'episode.m4a');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=4', '-c:a', 'aac', audio]);
  const cover = join(dir, 'cover.jpg');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=800x800', '-frames:v', '1', cover]);
  const data = readFileSync(audio);

  const start = (await c.agent.post('/api/uploads').set('Origin', WEB).send({ fileName: 'Episode 1.m4a', sizeBytes: data.length }).expect(201)).body;
  // The cover goes up while the sound uploads.
  await c.agent.put(`/api/hub/videos/${start.videoId}/thumbnail`).set('Origin', WEB).set('Content-Type', 'image/jpeg').send(readFileSync(cover)).expect(200);
  const urls = (await c.agent.post(`/api/uploads/${start.videoId}/parts`).set('Origin', WEB).send({ partNumbers: [1] }).expect(200)).body.urls;
  const etag = (await c.agent.put(urls[1].replace(WEB, '')).set('Origin', WEB).set('Content-Type', 'application/octet-stream').send(data).expect(200)).headers.etag;
  await c.agent.post(`/api/uploads/${start.videoId}/complete`).set('Origin', WEB).send({ parts: [{ partNumber: 1, etag }] }).expect(200);

  let v: any;
  for (let i = 0; i < 300; i++) {
    v = (await c.agent.get(`/api/hub/videos/${start.videoId}`)).body.video;
    if (v.status === 'FAILED' || (v.status === 'READY' && v.processingStage === 'Ready')) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  expect(v).toMatchObject({ status: 'READY', processingStage: 'Ready', isPodcast: true, isShort: false, width: 1280, height: 720, customThumbnail: true, title: 'Episode 1' });
  expect(v.durationSeconds).toBeGreaterThanOrEqual(3);
  expect((await ctx.prisma.video.findUniqueOrThrow({ where: { id: start.videoId } })).thumbnailKey).toMatch(/^thumbs\/custom-\d+\.jpg$/);
  expect(v.renditions.length).toBeGreaterThan(0);
  const master = (await c.agent.get(`/api/videos/${start.videoId}/hls/master.m3u8`).expect(200)).text;
  expect(master).toContain('#EXT-X-STREAM-INF');
  void request;
}, 180_000);

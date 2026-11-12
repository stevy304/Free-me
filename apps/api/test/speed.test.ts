import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeApp, resetDb, signIn, WEB } from './helpers';
import { jobOptions } from '../src/media/queue';

// Speed: a suitable H.264 upload keeps its own top rung (no re-encoding); playback starts with 1-second segments;
// the higher qualities are a second, lower-priority job.
const dir = mkdtempSync(join(tmpdir(), 'freeme-speed-'));
let ctx: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => { // Every quality at once and for everyone: these tests are about copying the top rung (cost-controls.test.ts covers the limits).
  ctx = await makeApp({ redis: false, storageDir: join(dir, 'storage'), env: { HD_MIN_VIEWS: '0', FREE_MAX_QUALITY: '0' } }); }, 60_000);
beforeEach(async () => { await resetDb(ctx.prisma); ctx.mail.outbox.length = 0; await ctx.clearLimits(); });
afterAll(async () => { await ctx.app.close(); rmSync(dir, { recursive: true, force: true }); });

async function uploadAndWait(agent: any, file: string) {
  const data = readFileSync(file);
  const start = (await agent.post('/api/uploads').set('Origin', WEB).send({ fileName: 'clip.mp4', sizeBytes: data.length }).expect(201)).body;
  const urls = (await agent.post(`/api/uploads/${start.videoId}/parts`).set('Origin', WEB).send({ partNumbers: [1] }).expect(200)).body.urls;
  const etag = (await agent.put(urls[1].replace(WEB, '')).set('Origin', WEB).set('Content-Type', 'application/octet-stream').send(data).expect(200)).headers.etag;
  await agent.post(`/api/uploads/${start.videoId}/complete`).set('Origin', WEB).send({ parts: [{ partNumber: 1, etag }] }).expect(200);
  for (let i = 0; i < 600; i++) {
    const v = (await agent.get(`/api/hub/videos/${start.videoId}`)).body.video;
    if (v.status === 'FAILED' || (v.status === 'READY' && v.processingStage === 'Ready')) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('not ready');
}

test('upgrades run after every waiting first job', () => {
  expect(jobOptions({ name: 'upgrade', videoId: 'v' })).toMatchObject({ priority: 10, deduplication: { id: 'upgrade:v' } });
  expect(jobOptions({ name: 'transcode', videoId: 'v' })).not.toHaveProperty('priority');
});

test('a 1080p H.264 upload with regular keyframes keeps its own 1080p (copied, not re-encoded); playback starts with 1-second segments', async () => {
  const c = await signIn(ctx.http, ctx.mail, 'fast@example.com');
  await c.agent.post('/api/channels').set('Origin', WEB).send({ handle: 'fast', name: 'Fast' }).expect(201);
  const clip = join(dir, 'camera.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
    '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-b:v', '4M', '-maxrate', '4M', '-bufsize', '8M', '-g', '60', '-c:a', 'aac', '-shortest', clip]);
  const v = await uploadAndWait(c.agent, clip);
  expect(v.renditions).toEqual(['144p', '240p', '360p', '480p', '720p', '1080p']);
  const top = await ctx.prisma.videoRendition.findUniqueOrThrow({ where: { videoId_resolution: { videoId: v.id, resolution: '1080p' } } });
  expect(top.codecs).toBe('avc1.640028,mp4a.40.2'); // the upload's own profile and level
  expect(top.bitrateKbps).toBeGreaterThan(2000);
  const master = (await c.agent.get(`/api/videos/${v.id}/hls/master.m3u8`).expect(200)).text;
  expect(master.match(/#EXT-X-STREAM-INF/g)).toHaveLength(6);
  const sd = readFileSync(join(dir, 'storage', 'prv', v.id, 'hls', '360p', 'index.m3u8'), 'utf8');
  expect(sd.match(/#EXTINF:([\d.]+)/)![1]).toBe('1.000000');
}, 180_000);

test('an upload that is not suitable (too high a bitrate for viewers) is encoded as usual', async () => {
  const c = await signIn(ctx.http, ctx.mail, 'heavy@example.com');
  await c.agent.post('/api/channels').set('Origin', WEB).send({ handle: 'heavy', name: 'Heavy' }).expect(201);
  const clip = join(dir, 'heavy.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=2,noise=alls=30:allf=t', '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '14M', '-maxrate', '14M', '-bufsize', '14M', '-g', '60', clip]);
  const v = await uploadAndWait(c.agent, clip);
  const top = await ctx.prisma.videoRendition.findUniqueOrThrow({ where: { videoId_resolution: { videoId: v.id, resolution: '1080p' } } });
  expect(top.codecs).toBe('avc1.64002a'); // the ladder's own encode (no audio), not the upload's
  expect(top.bitrateKbps).toBeLessThan(10_000);
}, 180_000);

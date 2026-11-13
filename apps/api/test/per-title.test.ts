import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeApp, resetDb, signIn, WEB } from './helpers';
import { chooseCrf, measureRendition, perTitleCrf } from '../src/media/per-title';
import { planLadder } from '../src/media/ladder';

// Per-title encoding: each video gets the highest CRF that still looks like CRF 21 (by SSIM on samples), never
// above 25; grainy content, where SSIM cannot tell, keeps 21. Players are told each rendition's measured bitrate.
const dir = mkdtempSync(join(tmpdir(), 'freeme-pertitle-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const clip = (name: string, source: string, seconds: number, crf = 12) => {
  const out = join(dir, `${name}.mp4`);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', source, '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-t', String(seconds), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out]);
  return out;
};

test('the rule: the highest CRF within 0.004 SSIM of CRF 21; grainy or unmeasured keeps 21', () => {
  expect(chooseCrf({ 21: 0.9957, 23: 0.9938, 25: 0.9911 })).toEqual({ crf: 23, reason: 'chosen' });
  expect(chooseCrf({ 21: 0.99, 23: 0.989, 25: 0.987 })).toEqual({ crf: 25, reason: 'chosen' });
  expect(chooseCrf({ 21: 0.99, 23: 0.98, 25: 0.989 })).toEqual({ crf: 25, reason: 'chosen' });
  expect(chooseCrf({ 21: 0.87, 23: 0.873, 25: 0.874 })).toEqual({ crf: 21, reason: 'grainy' });
  expect(chooseCrf({})).toEqual({ crf: 21, reason: 'failed' });
});

test('measured on real encodes: clean content takes more compression, grainy content keeps CRF 21, short clips are not sampled', async () => {
  const rung = planLadder(1280, 720, 30).find((r) => r.name === '720p')!;
  const clean = await perTitleCrf('ffmpeg', clip('clean', 'testsrc2=size=1280x720:rate=30:duration=13', 13), dir, 13, rung, null, 'veryfast');
  expect(clean.samples).toBe(3);
  expect(clean.reason).toBe('chosen');
  expect(clean.crf).toBeGreaterThan(21);
  expect(clean.kbps[clean.crf]).toBeLessThan(clean.kbps[21] * 0.9); // at least 10% fewer bits
  const grain = await perTitleCrf('ffmpeg', clip('grain', 'color=c=0x223344:size=1280x720:rate=30:duration=13,noise=alls=12:allf=t+u', 13), dir, 13, rung, null, 'veryfast');
  expect(grain).toMatchObject({ crf: 21, reason: 'grainy' });
  expect((await perTitleCrf('ffmpeg', clip('short', 'testsrc2=size=1280x720:rate=30:duration=4', 4), dir, 4, rung, null, 'veryfast')).reason).toBe('short');
}, 120_000);

test('a rendition\'s peak and average bitrate are measured from its segments', async () => {
  const hls = join(dir, 'hls');
  execFileSync('mkdir', ['-p', hls]);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=9', '-c:v', 'libx264', '-preset', 'veryfast', '-g', '60', '-an',
    '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', join(hls, 'seg_%05d.m4s'), join(hls, 'index.m3u8')]);
  const m = (await measureRendition(hls))!;
  expect(m.averageKbps).toBeGreaterThan(50);
  expect(m.peakKbps).toBeGreaterThanOrEqual(m.averageKbps);
  expect(await measureRendition(join(dir, 'nowhere'))).toBeNull();
});

describe('in the pipeline', () => {
  let ctx: Awaited<ReturnType<typeof makeApp>>;
  beforeAll(async () => { ctx = await makeApp({ redis: false, storageDir: join(dir, 'storage'), env: { HD_MIN_VIEWS: '0' } }); }, 60_000);
  beforeEach(async () => { await resetDb(ctx.prisma); await ctx.clearLimits(); });
  afterAll(async () => { await ctx.app.close(); });

  test('a clean video gets its CRF once, every rendition declares its measured bitrate, and the master playlist says so', async () => {
    const c = await signIn(ctx.http, ctx.mail, 'maker@example.com');
    await c.agent.post('/api/channels').set('Origin', WEB).send({ handle: 'maker', name: 'Maker' }).expect(201);
    const data = readFileSync(clip('upload', 'testsrc2=size=1280x720:rate=30:duration=13', 13, 30)) // under one 5 MB upload part;
    const start = (await c.agent.post('/api/uploads').set('Origin', WEB).send({ fileName: 'clip.mp4', sizeBytes: data.length }).expect(201)).body;
    const urls = (await c.agent.post(`/api/uploads/${start.videoId}/parts`).set('Origin', WEB).send({ partNumbers: [1] }).expect(200)).body.urls;
    const put = await c.agent.put(urls[1].replace(WEB, '')).set('Origin', WEB).set('Content-Type', 'application/octet-stream').send(data);
    if (put.status !== 200) throw new Error(`${put.status} ${JSON.stringify(put.body)} size ${data.length}`);
    const etag = put.headers.etag;
    await c.agent.post(`/api/uploads/${start.videoId}/complete`).set('Origin', WEB).send({ parts: [{ partNumber: 1, etag }] }).expect(200);
    let v: any;
    for (let i = 0; i < 900; i++) { v = (await c.agent.get(`/api/hub/videos/${start.videoId}`)).body.video; if (v.status === 'READY' && v.processingStage === 'Ready') break; await new Promise((r) => setTimeout(r, 200)); }
    const row = await ctx.prisma.video.findUniqueOrThrow({ where: { id: v.id }, include: { renditions: true } });
    expect(row.encodeCrf).toBeGreaterThan(21);
    for (const r of row.renditions) {
      expect(r.peakKbps).toBeGreaterThan(0);
      expect(r.averageKbps).toBeGreaterThan(0);
      expect(r.peakKbps!).toBeGreaterThanOrEqual(r.averageKbps!);
    }
    const master = readFileSync(join(dir, 'storage', 'prv', v.id, 'hls', 'master.m3u8'), 'utf8');
    const top = row.renditions.find((r) => r.resolution === '720p')!;
    // Declared: measured video peak and average, plus the shared audio (128 kb/s).
    expect(master).toContain(`BANDWIDTH=${(top.peakKbps! + 128) * 1000},AVERAGE-BANDWIDTH=${(top.averageKbps! + 128) * 1000},RESOLUTION=1280x720`);
  }, 240_000);
});

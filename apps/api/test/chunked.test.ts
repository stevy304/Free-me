import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeApp, resetDb, signIn, WEB } from './helpers';
import { MediaJobs } from '../src/media/jobs';
import { LocalChunks } from '../src/media/chunks';
import { createStorage } from '../src/media/storage';

// Long videos are encoded in pieces (here: anything of 10 s or more, 4-second pieces, two at a time) and joined
// without re-encoding. The result must be the same video: every frame, the keyframe grid, 1-second first segment.
const dir = mkdtempSync(join(tmpdir(), 'freeme-chunked-'));
let ctx: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => {
  ctx = await makeApp({ redis: false, storageDir: join(dir, 'storage'), env: { CHUNK_MIN_SECONDS: '10', CHUNK_SECONDS: '4', CHUNK_CONCURRENCY: '2', COPY_TOP_RUNG: 'false', SCRATCH_DIR: join(dir, 'scratch'), AV1_PRESET: '12' } });
}, 60_000);
beforeEach(async () => { await resetDb(ctx.prisma); ctx.mail.outbox.length = 0; await ctx.clearLimits(); });
afterAll(async () => { await ctx.app.close(); rmSync(dir, { recursive: true, force: true }); });

const frames = (file: string) => Number(execFileSync('ffprobe', ['-v', 'error', '-count_packets', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', file]).toString().trim());

test('a long video is encoded in pieces and joined: every frame there, 2-second keyframes, playable from a 1-second first segment', async () => {
  const c = await signIn(ctx.http, ctx.mail, 'long@example.com');
  await c.agent.post('/api/channels').set('Origin', WEB).send({ handle: 'long', name: 'Long' }).expect(201);
  const clip = join(dir, 'long.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=13.5', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=13.5',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '45', '-g', '300', '-c:a', 'aac', '-shortest', clip]);
  const data = readFileSync(clip);
  const start = (await c.agent.post('/api/uploads').set('Origin', WEB).send({ fileName: 'long.mp4', sizeBytes: data.length }).expect(201)).body;
  const urls = (await c.agent.post(`/api/uploads/${start.videoId}/parts`).set('Origin', WEB).send({ partNumbers: [1] }).expect(200)).body.urls;
  const etag = (await c.agent.put(urls[1].replace(WEB, '')).set('Origin', WEB).set('Content-Type', 'application/octet-stream').send(data).expect(200)).headers.etag;
  await c.agent.post(`/api/uploads/${start.videoId}/complete`).set('Origin', WEB).send({ parts: [{ partNumber: 1, etag }] }).expect(200);
  let v: any;
  for (let i = 0; i < 900; i++) {
    v = (await c.agent.get(`/api/hub/videos/${start.videoId}`)).body.video;
    if (v.status === 'FAILED' || (v.status === 'READY' && v.processingStage === 'Ready')) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  expect(v.status).toBe('READY');
  expect(v.renditions).toEqual(['144p', '240p', '360p', '480p', '720p']);

  for (const q of ['360p', '720p']) {
    const hls = join(dir, 'storage', 'prv', v.id, 'hls', q);
    const playlist = readFileSync(join(hls, 'index.m3u8'), 'utf8');
    const durations = [...playlist.matchAll(/#EXTINF:([\d.]+)/g)].map((m) => Number(m[1]));
    expect(durations[0]).toBeCloseTo(1, 3);
    expect(durations.slice(2, -1).every((d) => d >= 1.99 && Math.abs(d / 2 - Math.round(d / 2)) < 0.01)).toBe(true); // cut on the 2-second keyframe grid
    expect(durations.reduce((a, b) => a + b, 0)).toBeCloseTo(13.5, 1);
    // Joined back into one file, the rendition has every frame of the 13.5-second, 30 fps upload.
    const joined = join(dir, `${q}.mp4`);
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', join(hls, 'index.m3u8'), '-c', 'copy', joined]);
    expect(frames(joined)).toBe(405);
  }
  // The pieces are cleaned up.
  expect(existsSync(join(dir, 'storage', 'tmp', 'chunks', v.id))).toBe(false);
  // The work folder is removed just after the video is marked ready: give that a moment on a busy machine.
  const leftovers = () => readdirSync(join(dir, 'scratch')).filter((f) => f.startsWith(v.id));
  for (let i = 0; i < 50 && leftovers().length; i++) await new Promise((r) => setTimeout(r, 100));
  expect(leftovers()).toEqual([]);

  // A popular long video's AV1 renditions are made in pieces too, joined into the same 2-second keyframe grid.
  const storage = createStorage(ctx.config);
  const jobs = new MediaJobs(ctx.prisma as never, storage, ctx.config, null, null, new LocalChunks(2, { ffmpegPath: 'ffmpeg', storage, scratchDir: join(dir, 'scratch') }));
  await jobs.av1(v.id);
  const av1 = join(dir, 'storage', 'prv', v.id, 'hls', 'av1-720p');
  const durations = [...readFileSync(join(av1, 'index.m3u8'), 'utf8').matchAll(/#EXTINF:([\d.]+)/g)].map((m) => Number(m[1]));
  expect(durations.reduce((a, b) => a + b, 0)).toBeCloseTo(13.5, 1);
  const keyframes = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'frame=key_frame,pts_time', '-of', 'csv=p=0', join(av1, 'index.m3u8')]).toString()
    .trim().split('\n').map((l) => l.split(',')).filter(([k]) => k === '1').map(([, t]) => Number(t));
  expect(keyframes.length).toBeGreaterThanOrEqual(7);
  expect(keyframes.every((t) => Math.abs(t / 2 - Math.round(t / 2)) < 0.02)).toBe(true);
  const joinedAv1 = join(dir, 'av1.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', join(av1, 'index.m3u8'), '-c', 'copy', joinedAv1]);
  expect(frames(joinedAv1)).toBe(405);
  expect(existsSync(join(dir, 'storage', 'tmp', 'chunks', v.id))).toBe(false);
}, 300_000);

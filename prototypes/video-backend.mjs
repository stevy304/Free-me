// Node 24 and FFmpeg required. Run: node prototypes/video-backend.mjs
// POST a raw MP4 to /videos, then poll the returned statusUrl.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, writeFile, unlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';

const run = promisify(execFile);
const root = resolve(process.env.FREEME_DATA_DIR || join(tmpdir(), 'free-me-video-prototype'));
const port = Number(process.env.PORT || 4400);
const maxBytes = 25 * 1024 * 1024;
await run('ffmpeg', ['-version']);
await mkdir(root, { recursive: true });
const db = new DatabaseSync(join(root, 'videos.sqlite'));
db.exec(`
  CREATE TABLE IF NOT EXISTS videos (id TEXT PRIMARY KEY, status TEXT NOT NULL);
  UPDATE videos SET status = 'failed' WHERE status = 'processing';
`);
const insert = db.prepare("INSERT INTO videos VALUES (?, 'processing')");
const update = db.prepare('UPDATE videos SET status = ? WHERE id = ?');
const find = db.prepare('SELECT status FROM videos WHERE id = ?');
let busy = false;

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function transcode(id, directory, source) {
  try {
    await run('ffmpeg', [
      '-nostdin', '-loglevel', 'error', '-protocol_whitelist', 'file',
      '-f', 'mov', '-i', source, '-map', '0:v:0', '-map', '0:a:0?',
      '-t', '60', '-vf', 'scale=-2:min(360\\,ih)', '-threads', '2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
      '-force_key_frames', 'expr:gte(t,n_forced*4)', '-f', 'hls',
      '-hls_time', '4', '-hls_playlist_type', 'vod',
      '-hls_segment_filename', join(directory, 'segment-%03d.ts'),
      join(directory, 'index.m3u8'),
    ], { timeout: 120_000 });
    update.run('ready', id);
  } catch (error) {
    console.error('Transcode failed', id, error.message);
    update.run('failed', id);
  } finally {
    await unlink(source).catch(console.error);
    busy = false;
  }
}

async function upload(request, response) {
  if (request.headers['content-type'] !== 'video/mp4') {
    return json(response, 415, { error: 'Send a raw video/mp4 body' });
  }
  const length = Number(request.headers['content-length']);
  if (!Number.isSafeInteger(length) || length < 1) {
    return json(response, 411, { error: 'A positive Content-Length is required' });
  }
  if (length > maxBytes) return json(response, 413, { error: 'Upload limit is 25 MiB' });
  if (busy) return json(response, 503, { error: 'A video is already being processed' });

  busy = true;
  try {
    const body = [];
    for await (const chunk of request) body.push(chunk);
    const id = randomUUID();
    const directory = join(root, id);
    const source = join(directory, 'source.mp4');
    await mkdir(directory);
    await writeFile(source, Buffer.concat(body));
    insert.run(id);
    json(response, 202, { id, status: 'processing', statusUrl: '/videos/' + id });
    void transcode(id, directory, source);
  } catch (error) {
    busy = false;
    throw error;
  }
}

async function handle(request, response) {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (request.method === 'POST' && path === '/videos') return upload(request, response);
  if (request.method === 'GET' && path === '/health') return json(response, 200, { status: 'ok' });
  const status = /^\/videos\/([a-f0-9-]{36})$/.exec(path);
  const media = /^\/media\/([a-f0-9-]{36})\/(index\.m3u8|segment-\d{3}\.ts)$/.exec(path);
  const match = status || media;
  const video = match && find.get(match[1]);
  if (request.method !== 'GET' || !video) return json(response, 404, { error: 'Not found' });
  const id = match[1];
  const playlistUrl = '/media/' + id + '/index.m3u8';
  if (status) {
    return json(response, 200, { id, status: video.status, playlistUrl: video.status === 'ready' ? playlistUrl : null });
  }
  if (video.status !== 'ready') return json(response, 404, { error: 'Video unavailable' });
  const file = join(root, id, media[2]);
  const { size } = await stat(file);
  response.writeHead(200, {
    'Content-Type': file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
    'Content-Length': size,
  });
  await pipeline(createReadStream(file), response);
}

createServer({ requestTimeout: 120_000 }, (request, response) => {
  handle(request, response).catch((error) => {
    if (response.headersSent || response.destroyed) return response.destroy();
    console.error(error.message);
    json(response, error.code === 'ENOENT' ? 404 : 500, { error: 'Request failed' });
  });
}).listen(port, '127.0.0.1', () => console.log('Free Me prototype at http://localhost:' + port));

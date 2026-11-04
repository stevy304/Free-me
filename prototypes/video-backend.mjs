// Node 24 and FFmpeg required. Run: node prototypes/video-backend.mjs
// POST a raw MP4 to /videos, then poll the returned statusUrl.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, unlink, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';

const run = promisify(execFile);
const root = resolve(process.env.FREEME_DATA_DIR || join(homedir(), '.free-me-video'));
const port = Number(process.env.PORT || 4400);
const maxBytes = 25 * 1024 * 1024;
await run('ffmpeg', ['-version']);
await mkdir(root, { recursive: true });
const db = new DatabaseSync(join(root, 'videos.sqlite'));
db.exec(`
  CREATE TABLE IF NOT EXISTS videos (id TEXT PRIMARY KEY, status TEXT NOT NULL);
`);
const columns = new Set(db.prepare('PRAGMA table_info(videos)').all().map((column) => column.name));
if (!columns.has('metadata')) db.exec("ALTER TABLE videos ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'");
if (!columns.has('duration_seconds')) db.exec('ALTER TABLE videos ADD COLUMN duration_seconds REAL');
db.exec('CREATE INDEX IF NOT EXISTS videos_status ON videos (status)');
const insert = db.prepare("INSERT INTO videos (id, status, metadata) VALUES (?, 'processing', ?)");
const update = db.prepare('UPDATE videos SET status = ?, duration_seconds = ? WHERE id = ?');
const find = db.prepare('SELECT * FROM videos WHERE id = ?');
const catalog = db.prepare("SELECT * FROM videos WHERE status = 'ready' ORDER BY rowid DESC LIMIT 100");
const categories = new Set(['Kigali Life', 'Tech & Innovation', 'Wildlife & Safari', 'Music & Performance', 'Culinary & Coffee']);
let busy = false;

function describe(video) {
  const metadata = JSON.parse(video.metadata);
  const ready = video.status === 'ready';
  const base = '/media/' + video.id + '/';
  return {
    id: video.id, status: video.status,
    title: metadata.title || 'Untitled video',
    description: metadata.description || '',
    category: metadata.category || 'Kigali Life',
    uploadedAt: metadata.uploadedAt || null,
    durationSeconds: video.duration_seconds,
    playlistUrl: ready ? base + 'index.m3u8' : null,
    thumbnailUrl: ready && video.duration_seconds !== null ? base + 'poster.jpg' : null,
  };
}

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function transcode(id, directory, source) {
  try {
    await run('ffmpeg', [
      '-nostdin', '-y', '-loglevel', 'error', '-protocol_whitelist', 'file',
      '-f', 'mov', '-i', source, '-map', '0:v:0', '-map', '0:a:0?',
      '-t', '60', '-vf', 'scale=-2:min(360\\,ih)', '-threads', '2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
      '-force_key_frames', 'expr:gte(t,n_forced*4)', '-f', 'hls',
      '-hls_time', '4', '-hls_playlist_type', 'vod',
      '-hls_segment_filename', join(directory, 'segment-%03d.ts'),
      join(directory, 'index.m3u8'),
    ], { timeout: 120_000 });
    await run('ffmpeg', [
      '-nostdin', '-y', '-loglevel', 'error', '-protocol_whitelist', 'file',
      '-f', 'mov', '-i', source, '-map', '0:v:0', '-frames:v', '1',
      '-vf', 'scale=-2:min(360\\,ih)', '-threads', '1', '-update', '1', join(directory, 'poster.jpg'),
    ], { timeout: 30_000 });
    const playlist = await readFile(join(directory, 'index.m3u8'), 'utf8');
    const duration = [...playlist.matchAll(/^#EXTINF:([\d.]+),/gm)]
      .reduce((seconds, match) => seconds + Number(match[1]), 0);
    if (!(duration > 0)) throw new Error('HLS playlist contains no playable segments');
    update.run('ready', duration, id);
  } catch (error) {
    console.error('Transcode failed', id, error.message);
    update.run('failed', null, id);
  } finally {
    await unlink(source).catch((error) => { if (error.code !== 'ENOENT') console.error(error.message); });
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

  let metadata;
  try {
    const title = decodeURIComponent(request.headers['x-video-title'] || '').trim();
    const description = decodeURIComponent(request.headers['x-video-description'] || '').trim();
    const category = decodeURIComponent(request.headers['x-video-category'] || 'Kigali Life');
    if (title.length > 120 || description.length > 1000 || !categories.has(category)) throw new Error('Invalid metadata');
    metadata = { title, description, category, uploadedAt: new Date().toISOString() };
  } catch {
    return json(response, 400, { error: 'Invalid title, description or category' });
  }

  busy = true;
  const id = randomUUID();
  const directory = join(root, id);
  const source = join(directory, 'source.mp4');
  try {
    await mkdir(directory);
    await pipeline(request, createWriteStream(source, { flags: 'wx' }));
    insert.run(id, JSON.stringify(metadata));
  } catch (error) {
    await unlink(source).catch(() => {});
    busy = false;
    throw error;
  }
  json(response, 202, { id, status: 'processing', statusUrl: '/videos/' + id });
  void transcode(id, directory, source).finally(() => { busy = false; });
}

async function handle(request, response) {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (request.method === 'POST' && path === '/videos') return upload(request, response);
  if (request.method === 'GET' && path === '/videos') return json(response, 200, { videos: catalog.all().map(describe) });
  if (request.method === 'GET' && path === '/health') return json(response, 200, { status: 'ok' });
  const status = /^\/videos\/([a-f0-9-]{36})$/.exec(path);
  const media = /^\/media\/([a-f0-9-]{36})\/(index\.m3u8|poster\.jpg|segment-\d{3}\.ts)$/.exec(path);
  const match = status || media;
  const video = match && find.get(match[1]);
  if (request.method !== 'GET' || !video) return json(response, 404, { error: 'Not found' });
  const id = match[1];
  if (status) return json(response, 200, describe(video));
  if (video.status !== 'ready') return json(response, 404, { error: 'Video unavailable' });
  const file = join(root, id, media[2]);
  const { size } = await stat(file);
  response.writeHead(200, {
    'Content-Type': file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : file.endsWith('.jpg') ? 'image/jpeg' : 'video/mp2t',
    'Content-Length': size,
  });
  await pipeline(createReadStream(file), response);
}

const interrupted = db.prepare("SELECT id FROM videos WHERE status = 'processing' ORDER BY rowid").all();
if (interrupted.length) {
  busy = true;
  void (async () => {
    try {
      for (const { id } of interrupted) {
        const directory = join(root, id);
        await transcode(id, directory, join(directory, 'source.mp4'));
      }
    } finally {
      busy = false;
    }
  })();
}

createServer({ requestTimeout: 120_000 }, (request, response) => {
  handle(request, response).catch((error) => {
    if (response.headersSent || response.destroyed) return response.destroy();
    console.error(error.message);
    json(response, error.code === 'ENOENT' ? 404 : 500, { error: 'Request failed' });
  });
}).listen(port, '127.0.0.1', () => console.log('Free Me prototype at http://localhost:' + port));

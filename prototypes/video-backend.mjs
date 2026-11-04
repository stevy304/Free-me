// Node 24 and FFmpeg required. Run: node prototypes/video-backend.mjs
// POST a raw MP4 to /videos, then poll the returned statusUrl.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, rename, unlink, stat, statfs, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { defaultUploadLimit, formatUploadLimit } from '../src/services/uploadLimits.mjs';
import { createUploadSessions, uploadChunkBytes } from './upload-sessions.mjs';
import { openDatabase } from './database.mjs';
import { boundedBody } from './request-body.mjs';
import { createAccounts, readJson } from './accounts.mjs';

const run = promisify(execFile);
const root = resolve(process.env.FREEME_DATA_DIR || join(homedir(), '.free-me-video'));
const port = Number(process.env.PORT || 4400);
const maxBytes = Number(process.env.FREEME_MAX_UPLOAD_BYTES ?? defaultUploadLimit);
if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > defaultUploadLimit) {
  throw new Error('FREEME_MAX_UPLOAD_BYTES must be a positive integer up to 100000000000.');
}
const limitMessage = 'Upload limit is ' + formatUploadLimit(maxBytes);
const storageReserve = 512 * 1024 * 1024;
const day = 24 * 60 * 60 * 1000;

async function checkStorage(bytes = 0) {
  const { bavail, bsize } = await statfs(root);
  if (bavail * bsize < bytes + storageReserve) {
    throw Object.assign(new Error('The server does not have enough free media storage for this upload.'), { status: 507 });
  }
}

async function* uploadBody(request) {
  let unchecked = 0;
  for await (const chunk of boundedBody(request, maxBytes, limitMessage)) {
    unchecked += chunk.length;
    if (unchecked >= 64 * 1024 * 1024) {
      await checkStorage(chunk.length);
      unchecked = 0;
    }
    yield chunk;
  }
}
await Promise.all([run('ffmpeg', ['-version']), run('ffprobe', ['-version'])]);
await mkdir(root, { recursive: true });
const db = await openDatabase(join(root, 'videos.sqlite'));
const accounts = createAccounts(db, json);
const insert = db.prepare("INSERT INTO videos (id, status, metadata, owner_id, visibility) VALUES (?, 'processing', ?, ?, ?)");
const update = db.prepare('UPDATE videos SET status = ?, duration_seconds = ? WHERE id = ?');
const find = db.prepare('SELECT * FROM videos WHERE id = ?');
const catalog = db.prepare(`SELECT * FROM videos WHERE status = 'ready' AND visibility = 'public' ORDER BY ${db.orderColumn} DESC LIMIT 100`);
const owned = db.prepare(`SELECT * FROM videos WHERE owner_id = ? ORDER BY ${db.orderColumn} DESC LIMIT 100`);
const edit = db.prepare('UPDATE videos SET metadata = ?, visibility = ? WHERE id = ? AND owner_id = ?');
const categories = new Set(['Kigali Life', 'Tech & Innovation', 'Wildlife & Safari', 'Music & Performance', 'Culinary & Coffee']);
let busy = false;

function metadataFor(video) {
  return typeof video.metadata === 'string' ? JSON.parse(video.metadata) : video.metadata;
}

function describe(video) {
  const metadata = metadataFor(video);
  const ready = video.status === 'ready';
  const base = '/media/' + video.id + '/';
  return {
    id: video.id, status: video.status, visibility: video.visibility,
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

const playbackProfiles = [
  { height: 240, bitrate: 320 },
  { height: 360, bitrate: 720 },
  { height: 720, bitrate: 2100 },
];

async function encodeRendition(source, directory, { height, bitrate }) {
  const name = String(height) + 'p';
  const manifest = name + '.m3u8';
  await run('ffmpeg', [
    '-nostdin', '-y', '-loglevel', 'error', '-protocol_whitelist', 'file',
    '-f', 'mov', '-i', source, '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', `scale=-2:min(${height}\\,ih)`, '-threads', '2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast',
    '-b:v', bitrate + 'k', '-maxrate', bitrate + 'k', '-bufsize', (bitrate * 2) + 'k',
    '-c:a', 'aac', '-b:a', '96k', '-flags', '+cgop',
    '-force_key_frames', 'expr:gte(t,n_forced*4)', '-f', 'hls',
    '-hls_time', '4', '-hls_playlist_type', 'vod', '-hls_flags', 'independent_segments+temp_file',
    '-hls_segment_filename', join(directory, name + '-%03d.ts'),
    join(directory, manifest),
  ], { timeout: day });

  const playlist = await readFile(join(directory, manifest), 'utf8');
  let duration = 0;
  let totalBits = 0;
  let bandwidth = 0;
  for (const [, seconds, filename] of playlist.matchAll(/^#EXTINF:([\d.]+),\r?\n([^\r\n]+)/gm)) {
    const segmentDuration = Number(seconds);
    const bits = (await stat(join(directory, filename))).size * 8;
    if (segmentDuration <= 0 || bits <= 0) throw new Error('HLS playlist contains an invalid segment');
    duration += segmentDuration;
    totalBits += bits;
    bandwidth = Math.max(bandwidth, Math.ceil(bits / segmentDuration));
  }
  if (!(duration > 0)) throw new Error('HLS playlist contains no segments');
  const average = Math.ceil(totalBits / duration);
  return { manifest, bandwidth, average, duration };
}

async function transcode(id, directory, source) {
  try {
    const { stdout } = await run('ffprobe', [
      '-v', 'error', '-protocol_whitelist', 'file', '-f', 'mov', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height:stream_side_data=rotation', '-of', 'json', source,
    ], { timeout: 15_000 });
    const [video] = JSON.parse(stdout).streams;
    if (!video?.height || !video.width) throw new Error('Missing video stream dimensions');
    const rotation = video.side_data_list?.[0]?.rotation ?? 0;
    const sourceHeight = Math.abs(rotation % 180) === 90 ? video.width : video.height;
    const profiles = playbackProfiles.filter((profile) => profile.height <= sourceHeight);
    if (profiles.length === 0) profiles.push(playbackProfiles[0]);
    const renditions = [];
    for (const profile of profiles) {
      renditions.push(await encodeRendition(source, directory, profile));
    }
    await run('ffmpeg', [
      '-nostdin', '-y', '-loglevel', 'error', '-protocol_whitelist', 'file',
      '-f', 'mov', '-i', source, '-map', '0:v:0', '-frames:v', '1',
      '-vf', 'scale=-2:min(360\\,ih)', '-threads', '1', '-update', '1', join(directory, 'poster.jpg'),
    ], { timeout: 30_000 });
    const master = [
      '#EXTM3U',
      '#EXT-X-VERSION:6',
      '#EXT-X-INDEPENDENT-SEGMENTS',
      ...renditions.flatMap(({ manifest, bandwidth, average }) => [
        `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},AVERAGE-BANDWIDTH=${average}`,
        manifest,
      ]),
      '',
    ].join('\n');
    await writeFile(join(directory, 'index.m3u8.tmp'), master);
    await rename(join(directory, 'index.m3u8.tmp'), join(directory, 'index.m3u8'));
    await update.run('ready', renditions[0].duration, id);
    await unlink(source).catch((error) => console.error('Source cleanup failed:', error.code));
  } catch (error) {
    console.error('Transcode failed', id, error.message);
    await update.run('failed', null, id);
    await rm(directory, { recursive: true, force: true }).catch((failure) => console.error('Failed upload cleanup:', failure.code));
  }
}

async function upload(request, response, account) {
  if (!account) return json(response, 401, { error: 'Sign in to upload.' });
  const visibility = request.headers['x-video-visibility'] || 'private';
  if (!['public', 'private'].includes(visibility)) return json(response, 400, { error: 'Invalid visibility' });
  if (request.headers['content-type'] !== 'video/mp4') {
    return json(response, 415, { error: 'Send a raw video/mp4 body' });
  }
  if (Number(request.headers['content-length']) > maxBytes) {
    return json(response, 413, { error: limitMessage });
  }
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
    await checkStorage(Number(request.headers['content-length']) || 0);
    await mkdir(directory);
    await pipeline(uploadBody(request), createWriteStream(source, { flags: 'wx' }));
    await insert.run(id, JSON.stringify(metadata), account.id, visibility);
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    busy = false;
    throw error;
  }
  json(response, 202, { id, status: 'processing', statusUrl: '/videos/' + id });
  void transcode(id, directory, source).catch((error) => console.error('Could not persist processing state:', error.code || error.message)).finally(() => { busy = false; });
}

const uploads = createUploadSessions({
  root, maxBytes, limitMessage, categories, json, checkStorage, find: (id) => find.get(id),
  async complete(response, id, directory, source, { metadata, owner, visibility }) {
    if (busy) return json(response, 503, { error: 'A video is already being processed. Your file is saved. Retry shortly.' });
    busy = true;
    try {
      await insert.run(id, JSON.stringify(metadata), owner, visibility);
    } catch (error) {
      busy = false;
      throw error;
    }
    json(response, 202, { id, statusUrl: '/videos/' + id });
    void transcode(id, directory, source).catch((error) => console.error('Could not persist processing state:', error.code || error.message)).finally(() => { busy = false; });
  },
});

async function handle(request, response) {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (['POST', 'PATCH'].includes(request.method) && ['cross-site', 'same-site'].includes(request.headers['sec-fetch-site'])) {
    return json(response, 403, { error: 'Cross-origin request denied' });
  }
  if (path.startsWith('/account/')) return accounts.handle(request, response, path);
  if (request.method === 'GET' && path === '/videos/upload-limits') return json(response, 200, { maxBytes, chunkBytes: uploadChunkBytes });
  const account = await accounts.viewer(request);
  if (path === '/uploads' || path.startsWith('/uploads/')) return uploads.handle(request, response, path, account);
  if (request.method === 'POST' && path === '/videos') return upload(request, response, account);
  if (request.method === 'GET' && path === '/videos/mine') {
    if (!account) return json(response, 401, { error: 'Sign in to manage uploads.' });
    return json(response, 200, { videos: (await owned.all(account.id)).map(describe) });
  }
  if (request.method === 'GET' && path === '/videos') return json(response, 200, { videos: (await catalog.all()).map(describe) });
  if (request.method === 'GET' && path === '/health') {
    try {
      await db.health();
      return json(response, 200, { status: 'ok' });
    } catch {
      return json(response, 503, { error: 'Database unavailable' });
    }
  }
  const status = /^\/videos\/([a-f0-9-]{36})$/.exec(path);
  const media = /^\/media\/([a-f0-9-]{36})\/(index\.m3u8|poster\.jpg|segment-\d{3,}\.ts|(?:240|360|720)p(?:\.m3u8|-\d{3,}\.ts))$/.exec(path);
  const match = status || media;
  const video = match && await find.get(match[1]);
  if (!video || (video.visibility === 'private' && (!account || account.id !== video.owner_id))) {
    return json(response, 404, { error: 'Not found' });
  }
  const id = match[1];
  if (status && request.method === 'PATCH') {
    if (!account || account.id !== video.owner_id) return json(response, 404, { error: 'Not found' });
    const { title, visibility } = await readJson(request);
    if (typeof title !== 'string' || !title.trim() || title.trim().length > 120 || !['public', 'private'].includes(visibility)) {
      return json(response, 400, { error: 'Enter a title and valid visibility.' });
    }
    await edit.run(JSON.stringify({ ...metadataFor(video), title: title.trim() }), visibility, id, account.id);
    return json(response, 200, describe(await find.get(id)));
  }
  if (status && request.method === 'GET') return json(response, 200, describe(video));
  if (!media || !['GET', 'HEAD'].includes(request.method)) return json(response, 404, { error: 'Not found' });
  if (video.status !== 'ready') return json(response, 404, { error: 'Video unavailable' });
  const file = join(root, id, media[2]);
  const { size } = await stat(file);
  response.writeHead(200, {
    'Content-Type': file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : file.endsWith('.jpg') ? 'image/jpeg' : 'video/mp2t',
    'Content-Length': size,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  if (request.method === 'HEAD') return response.end();
  await pipeline(createReadStream(file), response);
}


const server = createServer({ requestTimeout: day, headersTimeout: 60_000 }, (request, response) => {
  handle(request, response).catch((error) => {
    if (response.headersSent || response.destroyed) return response.destroy();
    if (error.status === 413 || error.status === 507 || error.code === 'ENOSPC') response.setHeader('Connection', 'close');
    console.error(error.message);
    json(response, error.status || (error.code === 'ENOSPC' ? 507 : error.code === 'ENOENT' ? 404 : 500), { error: error.status ? error.message : error.code === 'ENOSPC' ? 'The server ran out of media storage.' : 'Request failed' });
  });
});
server.on('error', async (error) => {
  console.error(error.code === 'EADDRINUSE'
    ? `Video backend port ${port} is already in use. Stop the old Free Me server or run npm run dev with a different PORT.`
    : error.message);
  process.exitCode = 1;
  await db.close?.();
});
const pending = db.prepare(`SELECT id FROM videos WHERE status = 'processing' ORDER BY ${db.orderColumn}`);
server.listen(port, '127.0.0.1', () => {
  busy = true;
  void (async () => {
    try {
      const interrupted = await pending.all();
      console.log('Free Me prototype at http://127.0.0.1:' + server.address().port);
      for (const { id } of interrupted) {
        const directory = join(root, id);
        await transcode(id, directory, join(directory, 'source.mp4'));
      }
    } catch (error) {
      console.error('Video recovery failed:', error.code || error.message);
      process.exit(1);
    } finally {
      busy = false;
    }
  })();
});

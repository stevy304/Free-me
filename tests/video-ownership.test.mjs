import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);

test('private playback and editing require the owning account', { timeout: 30_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'free-me-ownership-'));
  const child = spawn(process.execPath, ['prototypes/video-backend.mjs'], {
    env: { ...process.env, PORT: '0', FREEME_DATA_DIR: directory, FREEME_MAX_UPLOAD_BYTES: String(25 * 1024 * 1024) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const exited = once(child, 'exit');
  t.after(async () => {
    child.kill();
    await exited;
    await rm(directory, { recursive: true, force: true });
  });
  const origin = await Promise.race([
    (async () => {
      let output = '';
      for await (const chunk of child.stdout) {
        output += chunk;
        const address = output.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (address) return address[0];
      }
      throw Error('Video API did not start');
    })(),
    exited.then(() => { throw Error('Video API stopped'); }),
  ]);
  function request(path, { method = 'GET', cookie, data, headers = {}, body, streaming = false } = {}) {
    return fetch(origin + path, {
      method,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(data ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: data ? JSON.stringify(data) : body,
      ...(streaming ? { duplex: 'half' } : {}),
    });
  }
  async function register(email) {
    const response = await request('/account/register', { method: 'POST', data: { email, password: 'local-test-password-123' } });
    assert.equal(response.status, 201);
    const cookie = response.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly; SameSite=Lax/);
    return cookie.split(';')[0];
  }

  const owner = await register('owner@example.test');
  const outsider = await register('outsider@example.test');
  const file = join(directory, 'clip.mp4');
  await run('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=s=320x240:r=2:d=64', '-c:v', 'libx264', file]);
  const uploadOptions = {
    method: 'POST', body: await readFile(file),
    headers: { 'Content-Type': 'video/mp4', 'X-Video-Title': 'Owner clip' },
  };
  assert.equal((await request('/videos', uploadOptions)).status, 401);
  async function* oversized() {
    for (let i = 0; i < 26; i++) yield Buffer.alloc(1024 * 1024);
  }
  const rejected = await request('/videos', { ...uploadOptions, cookie: owner, body: oversized(), streaming: true });
  assert.equal(rejected.status, 413);
  assert.match((await rejected.json()).error, /25 MiB/);
  const details = { title: 'Owner clip', description: '', category: 'Kigali Life', visibility: 'private' };
  const created = await request('/uploads', { method: 'POST', cookie: owner, data: { ...details, size: uploadOptions.body.length } });
  assert.equal(created.status, 201);
  const { id } = await created.json();
  const path = '/uploads/' + id;
  function sendChunk(offset, body) {
    return request(path, { method: 'PATCH', cookie: owner, body, headers: {
      'Content-Type': 'application/octet-stream', 'X-Upload-Offset': String(offset), 'X-Upload-Length': String(body.length),
    } });
  }
  assert.equal((await request(path, { cookie: outsider })).status, 404);
  assert.equal((await request(path + '/complete', { method: 'POST', cookie: owner, data: details })).status, 409);
  assert.equal((await sendChunk(0, uploadOptions.body.subarray(0, 100))).status, 200);
  assert.equal((await sendChunk(0, uploadOptions.body.subarray(0, 100))).status, 409);
  const resumed = await (await request(path, { cookie: owner })).json();
  assert.equal(resumed.offset, 100);
  assert.equal((await sendChunk(resumed.offset, uploadOptions.body.subarray(resumed.offset))).status, 200);
  const finalize = () => request(path + '/complete', { method: 'POST', cookie: owner, data: details });
  const upload = await finalize();
  assert.equal(upload.status, 202);
  const { statusUrl } = await upload.json();
  assert.equal((await (await finalize()).json()).statusUrl, statusUrl);
  let video;
  for (let attempt = 0; attempt < 80; attempt++) {
    video = await (await request(statusUrl, { cookie: owner })).json();
    if (video.status !== 'processing') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(video.status, 'ready');
  assert.ok(video.durationSeconds >= 64, 'full video is transcoded');
  assert.equal(video.visibility, 'private');
  const prefix = video.playlistUrl.replace(/index\.m3u8$/, '');
  for (const path of [statusUrl, video.thumbnailUrl, video.playlistUrl, prefix + '240p.m3u8', prefix + '240p-000.ts']) {
    assert.equal((await request(path, { cookie: owner })).status, 200, path);
    assert.equal((await request(path, { cookie: outsider })).status, 404, path);
    assert.equal((await request(path)).status, 404, path);
  }
  assert.equal((await request(prefix + '240p-000.ts', { method: 'HEAD', cookie: outsider })).status, 404);
  assert.deepEqual((await (await request('/videos')).json()).videos, []);
  const options = { method: 'PATCH', data: { title: 'Published', visibility: 'public' } };
  assert.equal((await request(statusUrl, { ...options, cookie: outsider })).status, 404);
  assert.equal((await request(statusUrl, { ...options, cookie: owner, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await request(statusUrl, { ...options, cookie: owner })).status, 200);
  assert.equal((await request(video.playlistUrl)).status, 200);
  assert.equal((await request(statusUrl, { ...options, cookie: owner, data: { ...options.data, visibility: 'private' } })).status, 200);
  assert.equal((await request(video.playlistUrl)).status, 404);
  assert.equal((await request('/account/logout', { method: 'POST', cookie: owner, data: {} })).status, 200);
  assert.equal((await request(video.playlistUrl, { cookie: owner })).status, 404);
  const login = await request('/account/login', { method: 'POST', data: { email: 'owner@example.test', password: 'local-test-password-123' } });
  assert.equal(login.status, 200);
  assert.equal((await request(video.playlistUrl, { cookie: login.headers.get('set-cookie').split(';')[0] })).status, 200);
});

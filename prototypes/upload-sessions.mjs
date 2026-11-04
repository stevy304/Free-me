import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { readJson } from './accounts.mjs';
import { boundedBody } from './request-body.mjs';

export const uploadChunkBytes = 1024 * 1024;
const route = /^\/uploads(?:\/([a-f0-9-]{36})(\/complete)?)?$/;

function status(id) {
  return { id, statusUrl: '/videos/' + id };
}

export function createUploadSessions({ root, maxBytes, limitMessage, categories, json, checkStorage, find, complete }) {
  const active = new Set();

  function details({ title, description, category, visibility }) {
    if (typeof title !== 'string' || !title.trim() || title.length > 120 ||
        typeof description !== 'string' || description.length > 1000 || !categories.has(category) ||
        !['private', 'public'].includes(visibility)) {
      throw Object.assign(new Error('Invalid video details.'), { status: 400 });
    }
    return { visibility, metadata: { title: title.trim(), description, category, uploadedAt: new Date().toISOString() } };
  }

  async function handle(request, response, path, account) {
    const match = route.exec(path);
    if (!match) return json(response, 404, { error: 'Upload not found.' });
    if (!account) return json(response, 401, { error: 'Sign in to upload.' });
    const [, id, finalize] = match;
    if (!id) {
      if (request.method !== 'POST') return json(response, 405, { error: 'Method not allowed.' });
      const body = await readJson(request);
      const { size } = body;
      if (!Number.isSafeInteger(size) || size < 1) return json(response, 400, { error: 'Invalid file size.' });
      if (size > maxBytes) return json(response, 413, { error: limitMessage });
      details(body);
      await checkStorage(size);
      const newId = randomUUID();
      const directory = join(root, newId);
      await mkdir(directory);
      try {
        await writeFile(join(directory, 'upload.json'), JSON.stringify({
          owner: account.id, size,
        }), { flag: 'wx' });
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
      return json(response, 201, { id: newId, offset: 0 });
    }

    if (active.has(id)) return json(response, 409, { error: 'An upload request is already in progress. Retry shortly.' });
    active.add(id);
    try {
      const video = await find(id);
      if (video) {
        if (video.owner_id !== account.id) return json(response, 404, { error: 'Upload not found.' });
        if (video.status === 'failed') return json(response, 410, { error: 'Processing failed. Start a new upload.' });
        return json(response, finalize ? 202 : 200, status(id));
      }
      const directory = join(root, id);
      const manifest = JSON.parse(await readFile(join(directory, 'upload.json'), 'utf8'));
      if (manifest.owner !== account.id) return json(response, 404, { error: 'Upload not found.' });
      if (manifest.size > maxBytes) return json(response, 413, { error: limitMessage });
      const source = join(directory, 'source.mp4');
      const offset = await stat(source).then((file) => file.size, (error) => {
        if (error.code === 'ENOENT') return 0;
        throw error;
      });
      if (request.method === 'GET' && !finalize) return json(response, 200, { id, offset });
      if (request.method === 'POST' && finalize) {
        if (offset !== manifest.size) return json(response, 409, { error: 'The video has not finished uploading.', offset });
        return await complete(response, id, directory, source, { ...details(await readJson(request)), owner: manifest.owner });
      }
      if (request.method !== 'PATCH' || finalize) return json(response, 405, { error: 'Method not allowed.' });
      if (request.headers['content-type'] !== 'application/octet-stream') {
        return json(response, 415, { error: 'Send application/octet-stream.' });
      }
      if (String(offset) !== request.headers['x-upload-offset']) {
        return json(response, 409, { error: 'Upload offset changed.', offset });
      }
      const length = Number(request.headers['x-upload-length']);
      if (!Number.isSafeInteger(length) || length < 1 || length > uploadChunkBytes || offset + length > manifest.size) {
        return json(response, 400, { error: 'Invalid upload chunk length.' });
      }
      await checkStorage(length);
      try {
        await pipeline(boundedBody(request, length, 'Chunk exceeds declared length.'), createWriteStream(source, { flags: 'a' }));
        if ((await stat(source)).size !== offset + length) throw Object.assign(new Error('Upload chunk was incomplete.'), { status: 400 });
      } catch (error) {
        await truncate(source, offset).catch((failure) => {
          if (failure.code !== 'ENOENT') throw failure;
        });
        throw error;
      }
      return json(response, 200, { id, offset: offset + length });
    } finally {
      active.delete(id);
    }
  }
  return { handle };
}

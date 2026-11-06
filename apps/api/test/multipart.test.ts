import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStorage } from '../src/media/storage';

test('local multipart completion leaves no source on a bad part and allows retry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fm-multipart-'));
  try {
    const storage = new LocalStorage(dir, 'http://localhost', 'test-secret');
    const key = 'src/test/source.mp4';
    const id = await storage.createMultipart(key);
    await storage.writePart(id, 2, Buffer.from('world'));
    await storage.writePart(id, 1, Buffer.from('hello '));
    const parts = await storage.listParts(key, id);
    expect(parts.map(({ partNumber, size }) => [partNumber, size])).toEqual([[1, 6], [2, 5]]);
    await expect(storage.completeMultipart(key, id, [parts[0], { ...parts[1], etag: 'wrong' }])).rejects.toThrow('Part 2');
    expect(await storage.head(key)).toBeNull();
    expect(await storage.listParts(key, id)).toEqual(parts);

    await storage.completeMultipart(key, id, [...parts].reverse());
    expect(await readFile(storage.path(key), 'utf8')).toBe('hello world');
    expect(await storage.listParts(key, id)).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

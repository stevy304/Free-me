import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { STORAGE } from '../src/media/queue';
import type { Storage } from '../src/media/storage';
import { makeApp } from './helpers';

/** The default LOCAL_STORAGE_DIR is ./.data/storage: files under a dot-folder must still be served. */
describe('local storage under a dot-folder', () => {
  let ctx: Awaited<ReturnType<typeof makeApp>>;
  const dir = join(mkdtempSync(join(tmpdir(), 'fm-dot-')), '.data', 'storage');
  beforeAll(async () => { ctx = await makeApp({ storageDir: dir }); });
  afterAll(async () => { await ctx.app.close(); });

  test('public and signed private files are served; dot-file keys and escapes are not', async () => {
    const storage = ctx.app.get<Storage>(STORAGE);
    const id = '7510c0f1-eb8f-4b59-8ce5-3ceaa750014f';
    await storage.putBuffer(`pub/${id}/hls/master.m3u8`, Buffer.from('#EXTM3U\n'), { contentType: 'application/vnd.apple.mpegurl' });
    await storage.putBuffer(`prv/${id}/thumbs/1.jpg`, Buffer.from([0xff, 0xd8, 0xff, 0xe0]), { contentType: 'image/jpeg' });
    await storage.putBuffer(`pub/${id}/.secret`, Buffer.from('x'), { contentType: 'text/plain' });

    const pub = await request(ctx.http).get(`/api/storage/local/pub/${id}/hls/master.m3u8`).expect(200);
    expect(pub.text).toBe('#EXTM3U\n');
    const signed = new URL(await storage.signedGetUrl(`prv/${id}/thumbs/1.jpg`, 3600));
    await request(ctx.http).get(signed.pathname).expect(200).expect('Content-Type', /image\/jpeg/);
    await request(ctx.http).get(`/api/storage/local/pub/${id}/.secret`).expect(404);
    await request(ctx.http).get(`/api/storage/local/pub/${id}/../../src/x`).expect(404);
  });
});

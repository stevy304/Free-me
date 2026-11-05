import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { S3Storage } from '../src/media/storage';

/**
 * The production storage driver against a real S3-compatible server (moto or MinIO).
 * Runs when S3_TEST_ENDPOINT is set, e.g. S3_TEST_ENDPOINT=http://127.0.0.1:5055 (CI starts one).
 */
const endpoint = process.env.S3_TEST_ENDPOINT;
const run = endpoint ? test : test.skip;

run('S3 driver: browser-style multipart upload with presigned part links, resume listing, copy, delete, signed download', async () => {
  const cfg = { endpoint: endpoint!, region: 'us-east-1', bucket: `freeme-test-${Date.now()}`, accessKeyId: 'test', secretAccessKey: 'test', forcePathStyle: true };
  await new S3Client({ endpoint: cfg.endpoint, region: cfg.region, forcePathStyle: true, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } }).send(new CreateBucketCommand({ Bucket: cfg.bucket }));
  const s = new S3Storage(cfg);
  const dir = mkdtempSync(join(tmpdir(), 's3-'));
  try {
    const part1 = Buffer.alloc(5 * 1024 * 1024, 7);
    const part2 = Buffer.from('the end');
    const key = 'src/video-1/source.mp4';
    const uploadId = await s.createMultipart(key, 'video/mp4');
    // The browser PUTs to presigned links and reads the ETag header.
    const put = async (n: number, body: Buffer) => {
      const res = await fetch(await s.partUrl(key, uploadId, n, 600), { method: 'PUT', body: new Uint8Array(body) });
      expect(res.status).toBe(200);
      return res.headers.get('etag')!;
    };
    const e1 = await put(1, part1);
    expect((await s.listParts(key, uploadId)).map((p) => [p.partNumber, p.size])).toEqual([[1, part1.length]]);
    const e2 = await put(2, part2);
    await s.completeMultipart(key, uploadId, [{ partNumber: 2, etag: e2 }, { partNumber: 1, etag: e1 }]);
    expect(await s.head(key)).toEqual({ size: part1.length + part2.length });
    expect(await s.head('src/missing')).toBeNull();

    const local = join(dir, 'down.mp4');
    await s.download(key, local);
    expect(readFileSync(local).subarray(-7).toString()).toBe('the end');

    writeFileSync(join(dir, 'a.m3u8'), '#EXTM3U\n');
    await s.putFile('prv/video-1/hls/master.m3u8', join(dir, 'a.m3u8'), { contentType: 'application/vnd.apple.mpegurl', cacheControl: 'public, max-age=30' });
    await s.putBuffer('prv/video-1/thumbs/1.jpg', Buffer.from('jpg'), { contentType: 'image/jpeg' });
    expect(await s.getText('prv/video-1/hls/master.m3u8')).toBe('#EXTM3U\n');
    expect(await s.getText('prv/video-1/nothing')).toBeNull();
    const signed = await s.signedGetUrl('prv/video-1/thumbs/1.jpg', 60);
    expect(await (await fetch(signed)).text()).toBe('jpg');

    expect(await s.copyPrefix('prv/video-1/', 'pub/video-1/')).toBe(2);
    expect(await s.getText('pub/video-1/hls/master.m3u8')).toBe('#EXTM3U\n');
    expect(await s.deletePrefix('prv/video-1/')).toBe(2);
    expect(await s.getText('prv/video-1/hls/master.m3u8')).toBeNull();

    const abandoned = await s.createMultipart('src/video-2/source.mp4', 'video/mp4');
    await s.abortMultipart('src/video-2/source.mp4', abandoned);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

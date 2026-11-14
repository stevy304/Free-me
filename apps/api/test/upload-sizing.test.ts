import { loadConfig, type AppConfig } from '../src/config/config';
import type { AppRequest, AuthContext } from '../src/common/request';
import { UploadsController } from '../src/videos/uploads.controller';

test('large S3 uploads keep the negotiated part size when the server configuration changes', async () => {
  const MiB = 1024 ** 2;
  const sizeBytes = 100 * 1024 * MiB;
  // Use validated defaults: upload access reads the complete effective billing configuration,
  // including the ad cost model, even though this test only exercises multipart sizing.
  const config = loadConfig({
    NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/upload_sizing',
    SESSION_SECRET: 'test-session-secret-0123456789-abcdefghijklmnop',
  });
  config.media = { ...config.media, driver: 's3', maxUploadBytes: sizeBytes, partBytes: 16 * MiB };
  const video = { id: 'video', updatedAt: new Date(), uploadId: 'multipart', sourceFileS3Key: 'source' };
  const create = jest.fn(async ({ data }) => Object.assign(video, data));
  const prisma = {
    channel: { findUnique: async () => ({ id: 'channel', uploadCount: 0 }), update: jest.fn() },
    appSetting: { findUnique: async () => null },
    video: { count: async () => 0, create, update: jest.fn(), findFirst: async () => video },
  };
  const storage = {
    createMultipart: async () => 'multipart',
    listParts: async () => [],
    head: async () => null,
    partUrl: async () => 'https://storage.test/part',
  };
  const uploads = new UploadsController(prisma as never, { record: jest.fn() } as never, { consume: jest.fn() } as never, {} as never, storage as never, config);
  const auth = { user: { id: 'creator', createdAt: new Date(0), roles: [] } } as unknown as AuthContext;
  const start = await uploads.start(auth, { fileName: 'video.mp4', sizeBytes }, {} as AppRequest);
  expect(start).toMatchObject({ partSize: 64 * MiB, partCount: 1600 });

  config.media.partBytes = 128 * MiB;
  await expect(uploads.state(auth, start.videoId)).resolves.toMatchObject({ partSize: 64 * MiB });
  await expect(uploads.parts(auth, start.videoId, { partNumbers: [1600] })).resolves.toMatchObject({ urls: { 1600: expect.any(String) } });
  await expect(uploads.parts(auth, start.videoId, { partNumbers: [1601] })).rejects.toThrow('Part number out of range.');
});

test('finalization leaves incorrectly sized parts available for retry', async () => {
  const video = {
    id: 'video', status: 'UPLOADING', sourceSizeBytes: 9n, uploadPartBytes: 5n,
    sourceFileS3Key: 'source', uploadId: 'multipart',
  };
  const prisma = { video: { findFirst: async () => video }, $transaction: jest.fn() };
  const storage = {
    head: async () => null,
    listParts: async () => [{ partNumber: 1, size: 4, etag: 'first' }, { partNumber: 2, size: 5, etag: 'second' }],
    completeMultipart: jest.fn(),
  };
  const uploads = new UploadsController(prisma as never, {} as never, {} as never, {} as never, storage as never, {} as AppConfig);
  const auth = { user: { id: 'creator' } } as AuthContext;
  await expect(uploads.complete(auth, video.id, {}, {} as AppRequest)).rejects.toThrow('Upload all 2 parts first.');
  expect(storage.completeMultipart).not.toHaveBeenCalled();
  expect(prisma.$transaction).not.toHaveBeenCalled();
});

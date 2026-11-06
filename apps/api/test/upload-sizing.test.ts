import type { AppConfig } from '../src/config/config';
import type { AppRequest, AuthContext } from '../src/common/request';
import { UploadsController } from '../src/videos/uploads.controller';

test('large S3 uploads keep the negotiated part size when the server configuration changes', async () => {
  const MiB = 1024 ** 2;
  const sizeBytes = 100 * 1024 * MiB;
  const config = { media: { driver: 's3', maxUploadBytes: sizeBytes, partBytes: 16 * MiB } } as AppConfig;
  const video = { id: 'video', uploadId: 'multipart', sourceFileS3Key: 'source' };
  const create = jest.fn(async ({ data }) => Object.assign(video, data));
  const prisma = {
    channel: { findUnique: async () => ({ id: 'channel' }) },
    video: { count: async () => 0, create, update: jest.fn(), findFirst: async () => video },
  };
  const storage = {
    createMultipart: async () => 'multipart',
    listParts: async () => [],
    head: async () => null,
    partUrl: async () => 'https://storage.test/part',
  };
  const uploads = new UploadsController(prisma as never, { record: jest.fn() } as never, { consume: jest.fn() } as never, {} as never, storage as never, config);
  const auth = { user: { id: 'creator', createdAt: new Date(0) } } as AuthContext;
  const start = await uploads.start(auth, { fileName: 'video.mp4', sizeBytes }, {} as AppRequest);
  expect(start).toMatchObject({ partSize: 64 * MiB, partCount: 1600 });

  config.media.partBytes = 128 * MiB;
  await expect(uploads.state(auth, start.videoId)).resolves.toMatchObject({ partSize: 64 * MiB });
  await expect(uploads.parts(auth, start.videoId, { partNumbers: [1600] })).resolves.toMatchObject({ urls: { 1600: expect.any(String) } });
  await expect(uploads.parts(auth, start.videoId, { partNumbers: [1601] })).rejects.toThrow('Part number out of range.');
});

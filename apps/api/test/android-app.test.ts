import request from 'supertest';
import { makeApp, resetDb, signIn, WEB } from './helpers';

let ctx: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => { ctx = await makeApp({ adminEmails: ['admin@example.com'] }); });
beforeEach(async () => { await resetDb(ctx.prisma); await ctx.prisma.appSetting.deleteMany({ where: { key: 'androidApp' } }); ctx.mail.outbox.length = 0; await ctx.clearLimits(); });
afterAll(async () => { await ctx.app.close(); });

// What the upload checks: a ZIP archive (PK\3\4) naming AndroidManifest.xml in its directory at the end.
const apk = (size = 4096) => {
  const b = Buffer.alloc(size, 0x20);
  b.writeUInt32LE(0x04034b50, 0);
  b.write('AndroidManifest.xml', 30);
  b.write('AndroidManifest.xml', size - 200);
  return b;
};
const path = (url: string) => url.replace(/^https?:\/\/[^/]+/, '');

test('an administrator uploads the Android app; anyone downloads the latest from one link', async () => {
  expect((await request(ctx.http).get('/api/app/android').expect(200)).body).toEqual({ available: false });
  await request(ctx.http).get('/api/app/android/download').expect(404);

  const admin = (await signIn(ctx.http, ctx.mail, 'admin@example.com')).agent;
  const someone = (await signIn(ctx.http, ctx.mail, 'someone@example.com')).agent;
  await someone.put('/api/admin/app/android?version=1.0.0').set('Origin', WEB).set('Content-Type', 'application/vnd.android.package-archive').send(apk()).expect(403);
  // Only APKs, with a version.
  await admin.put('/api/admin/app/android?version=1.0.0').set('Origin', WEB).set('Content-Type', 'application/vnd.android.package-archive').send(Buffer.alloc(4096, 1)).expect(400);
  await admin.put('/api/admin/app/android').set('Origin', WEB).set('Content-Type', 'application/vnd.android.package-archive').send(apk()).expect(400);

  const first = (await admin.put('/api/admin/app/android?version=1.0.0').set('Origin', WEB).set('Content-Type', 'application/vnd.android.package-archive').send(apk()).expect(200)).body.file;
  expect((await request(ctx.http).get('/api/app/android').expect(200)).body).toMatchObject({ available: true, version: '1.0.0', sizeBytes: 4096, downloadUrl: '/api/app/android/download' });
  expect((await request(ctx.http).get('/api/app/android/download').expect(302)).headers.location).toBe(first.url);
  const file = await request(ctx.http).get(path(first.url)).expect(200);
  expect(file.headers['content-type']).toBe('application/vnd.android.package-archive');

  // A new version replaces the old file; the link follows.
  const second = (await admin.put('/api/admin/app/android?version=1.1.0').set('Origin', WEB).set('Content-Type', 'application/vnd.android.package-archive').send(apk(8192)).expect(200)).body.file;
  expect((await request(ctx.http).get('/api/app/android/download').expect(302)).headers.location).toBe(second.url);
  await request(ctx.http).get(path(first.url)).expect(404);

  await admin.delete('/api/admin/app/android').set('Origin', WEB).expect(200);
  expect((await request(ctx.http).get('/api/app/android').expect(200)).body.available).toBe(false);
});

test('Digital Asset Links: the package and signing fingerprints an administrator saves', async () => {
  expect((await request(ctx.http).get('/api/app/android/assetlinks').expect(200)).body).toEqual([]);
  const admin = (await signIn(ctx.http, ctx.mail, 'admin@example.com')).agent;
  const print = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0')).join(':');
  await admin.put('/api/admin/app/android/link').set('Origin', WEB).send({ packageName: 'rw.freeme.app', fingerprints: ['not-a-fingerprint'] }).expect(400);
  await admin.put('/api/admin/app/android/link').set('Origin', WEB).send({ packageName: 'Free Me', fingerprints: [print] }).expect(400);
  await admin.put('/api/admin/app/android/link').set('Origin', WEB).send({ packageName: 'rw.freeme.app', fingerprints: [print] }).expect(200);
  expect((await request(ctx.http).get('/api/app/android/assetlinks').expect(200)).body).toEqual([{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: { namespace: 'android_app', package_name: 'rw.freeme.app', sha256_cert_fingerprints: [print.toUpperCase()] },
  }]);
});

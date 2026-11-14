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

test('without an upload, the latest published build (the GitHub release) is offered, once it exists', async () => {
  const http = await import('node:http');
  let exists = true;
  const server = http.createServer((req, res) => { if (!exists) { res.statusCode = 404; res.end(); return; } res.setHeader('Content-Length', '407078'); res.setHeader('Last-Modified', 'Sat, 14 Nov 2026 07:12:00 GMT'); res.end(req.method === 'HEAD' ? undefined : 'apk'); });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/free-me.apk`;
  const app = await makeApp({ env: { ANDROID_APK_URL: url } });
  try {
    await app.prisma.appSetting.deleteMany({ where: { key: 'androidApp' } });
    expect((await request(app.http).get('/api/app/android').expect(200)).body).toEqual({ available: true, version: 'latest', sizeBytes: 407078, updatedAt: '2026-11-14T07:12:00.000Z', downloadUrl: '/api/app/android/download' });
    expect((await request(app.http).get('/api/app/android/download').expect(302)).headers.location).toBe(url);
  } finally {
    await app.app.close();
    server.close();
  }
  // Nothing published (yet): no download offered.
  exists = false;
  const none = await makeApp({ env: { ANDROID_APK_URL: url } });
  try { expect((await request(none.http).get('/api/app/android').expect(200)).body).toEqual({ available: false }); } finally { await none.app.close(); }
});

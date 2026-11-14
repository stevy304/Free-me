import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Put, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsArray, IsString, Matches } from 'class-validator';
import type { Response } from 'express';
import { createWriteStream } from 'node:fs';
import { mkdir, open, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { AuditService } from '../common/audit.service';
import { CurrentAuth, RequireAuth } from '../common/auth.guard';
import type { AppRequest, AuthContext } from '../common/request';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { PrismaService } from '../database/prisma.service';
import { STORAGE } from '../media/queue';
import type { Storage } from '../media/storage';

/**
 * The Android app (ANDROID.md): an APK an administrator uploads (Administration → Android app), built by the
 * "Android app" GitHub workflow from android/. People download it from the app (account menu, You page, /app).
 * The settings also give Android the proof that the app and the site belong together (/.well-known/assetlinks.json),
 * so the app opens full screen, without a browser address bar.
 */
const KEY = 'androidApp';
const MAX_BYTES = 100 * 1024 * 1024;
const FOLDER = 'app/android/';
export const APK_TYPE = 'application/vnd.android.package-archive';
const PACKAGE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

interface AndroidApp {
  file?: { name: string; url: string; sizeBytes: number; version: string; uploadedAt: string; uploadedBy: string };
  packageName?: string;
  fingerprints?: string[];
}

class AndroidLinkDto {
  @IsString() @Matches(PACKAGE, { message: 'Package name: lower-case words joined by dots, such as rw.freeme.app.' }) packageName!: string;
  @IsArray() @IsString({ each: true }) fingerprints!: string[];
}

@ApiTags('app')
@Controller()
export class AndroidAppController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, @Inject(STORAGE) private readonly storage: Storage, @Inject(APP_CONFIG) private readonly config: AppConfig) {}

  private async load(): Promise<AndroidApp> {
    return ((await this.prisma.appSetting.findUnique({ where: { key: KEY } }))?.value as AndroidApp | undefined) ?? {};
  }
  private async save(value: AndroidApp, by: string) {
    await this.prisma.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: value as object, updatedBy: by }, update: { value: value as object, updatedBy: by } });
  }

  /**
   * The published build (config androidApkUrl, normally the GitHub release the workflow updates), when there is no
   * upload: checked to exist, remembered for 10 minutes so the page never waits on GitHub.
   */
  private published: { at: number; ok: boolean; sizeBytes: number | null; updatedAt: string | null } | null = null;
  private async publishedBuild() {
    const url = this.config.androidApkUrl;
    if (!url) return null;
    if (!this.published || Date.now() - this.published.at > 10 * 60_000) {
      try {
        const r = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(5000) });
        this.published = { at: Date.now(), ok: r.ok, sizeBytes: Number(r.headers.get('content-length')) || null, updatedAt: r.headers.get('last-modified') ? new Date(r.headers.get('last-modified')!).toISOString() : null };
      } catch { this.published = { at: Date.now(), ok: false, sizeBytes: null, updatedAt: null }; }
    }
    return this.published.ok ? { url, ...this.published } : null;
  }

  @Get('app/android')
  @ApiOperation({ summary: 'The Android app: an uploaded APK, else the latest published build; its size and the download link' })
  async info() {
    const a = await this.load();
    if (a.file) return { available: true, version: a.file.version, sizeBytes: a.file.sizeBytes, updatedAt: a.file.uploadedAt, downloadUrl: '/api/app/android/download' };
    const p = await this.publishedBuild();
    return p ? { available: true, version: 'latest', sizeBytes: p.sizeBytes, updatedAt: p.updatedAt, downloadUrl: '/api/app/android/download' } : { available: false };
  }

  @Get('app/android/download')
  @ApiOperation({ summary: 'Download the Android app (APK): a stable link to the uploaded APK, else the latest published build' })
  async download(@Res() res: Response) {
    const a = await this.load();
    const url = a.file?.url ?? (await this.publishedBuild())?.url;
    if (!url) throw new NotFoundException('The Android app is not available yet.');
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, url);
  }

  @Get('app/android/assetlinks')
  @ApiOperation({ summary: 'Digital Asset Links for the Android app (served at /.well-known/assetlinks.json)' })
  async assetLinks() {
    const a = await this.load();
    if (!a.packageName || !a.fingerprints?.length) return [];
    return [{ relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: a.packageName, sha256_cert_fingerprints: a.fingerprints } }];
  }

  @Get('admin/app/android')
  @RequireAuth('ADMIN')
  @ApiOperation({ summary: 'The uploaded Android app and its link settings' })
  async adminInfo() {
    const a = await this.load();
    return { file: a.file ?? null, packageName: a.packageName ?? null, fingerprints: a.fingerprints ?? [] };
  }

  @Put('admin/app/android')
  @HttpCode(200)
  @RequireAuth('ADMIN')
  @ApiOperation({ summary: 'Upload the Android app: the APK as the request body (up to 100 MB), ?version=1.0.0' })
  async upload(@Query('version') version: string | undefined, @CurrentAuth() auth: AuthContext, @Req() req: AppRequest) {
    const v = (version ?? '').trim();
    if (!/^\d+(\.\d+){0,3}$/.test(v)) throw new BadRequestException('Give the version, such as 1.0.0.');
    const dir = join(this.config.media.scratchDir, 'android');
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `${Date.now()}-${Math.random().toString(36).slice(2)}.apk`);
    try {
      let size = 0;
      const limit = new Transform({ transform(chunk: Buffer, _e, done) { size += chunk.length; if (size > MAX_BYTES) done(new BadRequestException('The APK must be 100 MB or smaller.')); else done(null, chunk); } });
      await pipeline(req as unknown as NodeJS.ReadableStream, limit, createWriteStream(tmp));
      await this.checkApk(tmp);
      const before = await this.load();
      const name = `free-me-${v}-${Date.now()}.apk`;
      await this.storage.putFile(`pub/${FOLDER}${name}`, tmp, { contentType: APK_TYPE, cacheControl: 'public, max-age=31536000, immutable' });
      if (before.file) await this.storage.deletePrefix(`pub/${FOLDER}${before.file.name}`).catch(() => undefined);
      const file = { name, url: `${this.config.media.publicBaseUrl}/${FOLDER}${name}`, sizeBytes: (await stat(tmp)).size, version: v, uploadedAt: new Date().toISOString(), uploadedBy: auth.user.id };
      await this.save({ ...before, file }, auth.user.id);
      await this.audit.record({ userId: auth.user.id, action: 'ANDROID_APP_UPLOADED', entityType: 'AppSetting', entityId: KEY, req, details: { version: v, sizeBytes: file.sizeBytes } });
      return { file };
    } finally {
      await rm(tmp, { force: true });
    }
  }

  /** An APK is a ZIP archive holding AndroidManifest.xml (named in the central directory at the end of the file). */
  private async checkApk(path: string) {
    const f = await open(path, 'r');
    try {
      const { size } = await f.stat();
      const head = Buffer.alloc(4);
      await f.read(head, 0, 4, 0);
      const tailSize = Math.min(size, 256 * 1024);
      const tail = Buffer.alloc(tailSize);
      await f.read(tail, 0, tailSize, size - tailSize);
      if (size < 1024 || head.readUInt32LE(0) !== 0x04034b50 || !tail.includes('AndroidManifest.xml')) throw new BadRequestException('That is not an Android app (APK) file.');
    } finally { await f.close(); }
  }

  @Delete('admin/app/android')
  @HttpCode(200)
  @RequireAuth('ADMIN')
  @ApiOperation({ summary: 'Remove the Android app download' })
  async remove(@CurrentAuth() auth: AuthContext) {
    const a = await this.load();
    if (a.file) await this.storage.deletePrefix(`pub/${FOLDER}${a.file.name}`).catch(() => undefined);
    await this.save({ packageName: a.packageName, fingerprints: a.fingerprints }, auth.user.id);
    return { file: null };
  }

  @Put('admin/app/android/link')
  @RequireAuth('ADMIN')
  @ApiOperation({ summary: "The app's package name and signing-certificate SHA-256 fingerprints, for Digital Asset Links" })
  async link(@Body() body: AndroidLinkDto, @CurrentAuth() auth: AuthContext, @Req() req: AppRequest) {
    const fingerprints = [...new Set(body.fingerprints.map((x) => x.trim().toUpperCase()).filter(Boolean))];
    const bad = fingerprints.find((x) => !FINGERPRINT.test(x));
    if (bad) throw new BadRequestException(`Not a SHA-256 fingerprint: ${bad.slice(0, 40)} (32 pairs like AB:CD:…).`);
    const a = await this.load();
    await this.save({ ...a, packageName: body.packageName, fingerprints }, auth.user.id);
    await this.audit.record({ userId: auth.user.id, action: 'ANDROID_APP_LINKED', entityType: 'AppSetting', entityId: KEY, req, details: { packageName: body.packageName, fingerprints: fingerprints.length } });
    return { packageName: body.packageName, fingerprints };
  }
}

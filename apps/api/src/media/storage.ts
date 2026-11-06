import {
  AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CopyObjectCommand, CreateMultipartUploadCommand, DeleteObjectsCommand,
  GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, ListPartsCommand, PutObjectCommand, S3Client, UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, relative, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import type { AppConfig } from '../config/config';

export interface PutOptions { contentType: string; cacheControl?: string }
export interface UploadedPart { partNumber: number; size: number; etag: string }

/**
 * Object storage for sources, renditions and thumbnails. Keys:
 *   src/<videoId>/source<ext>      the uploaded file (private, kept for re-processing)
 *   pub/<videoId>/...              media of public and unlisted videos (served by the CDN)
 *   prv/<videoId>/...              media of private videos (served only through signed links)
 */
export interface Storage {
  createMultipart(key: string, contentType: string): Promise<string>;
  /** Where the browser PUTs one part (presigned, expires). */
  partUrl(key: string, uploadId: string, partNumber: number, ttlSec: number): Promise<string>;
  listParts(key: string, uploadId: string): Promise<UploadedPart[]>;
  completeMultipart(key: string, uploadId: string, parts: Array<{ partNumber: number; etag: string }>): Promise<void>;
  abortMultipart(key: string, uploadId: string): Promise<void>;
  head(key: string): Promise<{ size: number } | null>;
  download(key: string, toPath: string, signal?: AbortSignal): Promise<void>;
  putFile(key: string, fromPath: string, opts: PutOptions): Promise<void>;
  putBuffer(key: string, body: Buffer, opts: PutOptions): Promise<void>;
  getText(key: string): Promise<string | null>;
  /** Every key under a prefix. */
  list(prefix: string): Promise<string[]>;
  copyObject(from: string, to: string): Promise<void>;
  copyPrefix(from: string, to: string): Promise<number>;
  deletePrefix(prefix: string): Promise<number>;
  signedGetUrl(key: string, ttlSec: number): Promise<string>;
}

async function mapLimit<T>(items: T[], limit: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}

/** Any S3-compatible service (Hetzner Object Storage, MinIO, Wasabi, AWS). */
export class S3Storage implements Storage {
  private readonly s3: S3Client;
  private readonly bucket: string;
  constructor(cfg: NonNullable<AppConfig['media']['s3']>) {
    this.bucket = cfg.bucket;
    this.s3 = new S3Client({ endpoint: cfg.endpoint, region: cfg.region, forcePathStyle: cfg.forcePathStyle, credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey }, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
  }

  async createMultipart(key: string, contentType: string) {
    const r = await this.s3.send(new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }));
    return r.UploadId!;
  }
  partUrl(key: string, uploadId: string, partNumber: number, ttlSec: number) {
    return getSignedUrl(this.s3, new UploadPartCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }), { expiresIn: ttlSec });
  }
  async listParts(key: string, uploadId: string) {
    const out: UploadedPart[] = [];
    let marker: string | undefined;
    do {
      const r = await this.s3.send(new ListPartsCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId, PartNumberMarker: marker }));
      for (const p of r.Parts ?? []) out.push({ partNumber: p.PartNumber!, size: p.Size ?? 0, etag: p.ETag ?? '' });
      marker = r.IsTruncated ? String(r.NextPartNumberMarker) : undefined;
    } while (marker);
    return out;
  }
  async completeMultipart(key: string, uploadId: string, parts: Array<{ partNumber: number; etag: string }>) {
    await this.s3.send(new CompleteMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts: [...parts].sort((a, b) => a.partNumber - b.partNumber).map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) } }));
  }
  async abortMultipart(key: string, uploadId: string) {
    await this.s3.send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId })).catch(() => undefined);
  }
  async head(key: string) {
    try { const r = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key })); return { size: r.ContentLength ?? 0 }; }
    catch (e) { if ((e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null; throw e; }
  }
  async download(key: string, toPath: string, signal?: AbortSignal) {
    await mkdir(dirname(toPath), { recursive: true });
    const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }), { abortSignal: signal });
    await pipeline(r.Body as Readable, createWriteStream(toPath), { signal });
  }
  async putFile(key: string, fromPath: string, opts: PutOptions) {
    const { size } = await stat(fromPath);
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: createReadStream(fromPath), ContentLength: size, ContentType: opts.contentType, CacheControl: opts.cacheControl }));
  }
  async putBuffer(key: string, body: Buffer, opts: PutOptions) {
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: opts.contentType, CacheControl: opts.cacheControl }));
  }
  async getText(key: string) {
    try { const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key })); return await r.Body!.transformToString(); }
    catch (e) { if ((e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null; throw e; }
  }
  async list(prefix: string) {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const r = await this.s3.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
      for (const o of r.Contents ?? []) if (o.Key) keys.push(o.Key);
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return keys;
  }
  async copyObject(from: string, to: string) {
    await this.s3.send(new CopyObjectCommand({ Bucket: this.bucket, Key: to, CopySource: `${this.bucket}/${encodeURI(from)}` }));
  }
  async copyPrefix(from: string, to: string) {
    const keys = await this.list(from);
    await mapLimit(keys, 16, async (k) => {
      await this.s3.send(new CopyObjectCommand({ Bucket: this.bucket, Key: to + k.slice(from.length), CopySource: `${this.bucket}/${encodeURI(k)}` }));
    });
    return keys.length;
  }
  async deletePrefix(prefix: string) {
    const keys = await this.list(prefix);
    for (let i = 0; i < keys.length; i += 1000) {
      await this.s3.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true } }));
    }
    return keys.length;
  }
  signedGetUrl(key: string, ttlSec: number) {
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: ttlSec });
  }
}

/**
 * A folder standing in for object storage (development and tests). Presigned URLs become HMAC-signed links to the
 * API's /api/storage/local routes, so the browser uploads and plays exactly as it would against S3.
 */
export class LocalStorage implements Storage {
  constructor(private readonly root: string, private readonly appUrl: string, private readonly secret: string) {}

  /** The folder that holds every stored file. */
  get rootDir() { return this.root; }

  /** Resolves a key inside the root; refuses anything that would escape it. */
  path(key: string): string {
    const p = normalize(join(this.root, key));
    const rel = relative(this.root, p);
    if (!key || rel.startsWith('..') || rel.includes(`..${sep}`) || key.includes('\0')) throw new Error('Invalid storage key.');
    return p;
  }
  private partsDir(uploadId: string) {
    if (!/^[0-9a-f-]{36}$/.test(uploadId)) throw new Error('Invalid upload id.');
    return join(this.root, '.multipart', uploadId);
  }

  sign(payload: Record<string, unknown>): string {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${createHmac('sha256', this.secret).update(`local-storage:${body}`).digest('base64url')}`;
  }
  verify<T extends { exp: number }>(token: string): T | null {
    const [body, sig] = token.split('.');
    if (!body || !sig) return null;
    const want = createHmac('sha256', this.secret).update(`local-storage:${body}`).digest('base64url');
    if (want.length !== sig.length || !timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return null;
    try { const p = JSON.parse(Buffer.from(body, 'base64url').toString()) as T; return p.exp > Date.now() ? p : null; } catch { return null; }
  }

  async createMultipart(key: string) {
    this.path(key);
    const id = randomUUID();
    await mkdir(this.partsDir(id), { recursive: true });
    await writeFile(join(this.partsDir(id), 'key'), key);
    return id;
  }
  async partUrl(key: string, uploadId: string, partNumber: number, ttlSec: number) {
    return `${this.appUrl}/api/storage/local/part/${this.sign({ k: key, u: uploadId, n: partNumber, exp: Date.now() + ttlSec * 1000 })}`;
  }
  /** Stores one part sent to a partUrl; returns its ETag (MD5, as S3 does). */
  async writePart(uploadId: string, partNumber: number, body: Buffer) {
    const dir = this.partsDir(uploadId);
    const temporary = join(dir, `writing-${randomUUID()}`);
    try {
      await writeFile(temporary, body);
      await rename(temporary, join(dir, String(partNumber)));
    } finally {
      await rm(temporary, { force: true });
    }
    return `"${createHash('md5').update(body).digest('hex')}"`;
  }
  async listParts(_key: string, uploadId: string) {
    const dir = this.partsDir(uploadId);
    const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => /^\d+$/.test(n)).map(Number).sort((a, b) => a - b);
    const parts: UploadedPart[] = [];
    await mapLimit(names, 4, async (partNumber) => {
      const hash = createHash('md5');
      let size = 0;
      for await (const chunk of createReadStream(join(dir, String(partNumber)))) {
        hash.update(chunk);
        size += chunk.length;
      }
      parts.push({ partNumber, size, etag: `"${hash.digest('hex')}"` });
    });
    return parts.sort((a, b) => a.partNumber - b.partNumber);
  }
  async completeMultipart(key: string, uploadId: string, parts: Array<{ partNumber: number; etag: string }>) {
    const dir = this.partsDir(uploadId);
    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    const target = this.path(key);
    const temporary = join(dir, `assembling-${randomUUID()}`);
    await mkdir(dirname(target), { recursive: true });

    async function* checkedParts() {
      for (const part of sorted) {
        const hash = createHash('md5');
        for await (const chunk of createReadStream(join(dir, String(part.partNumber)))) {
          hash.update(chunk);
          yield chunk;
        }
        if (`"${hash.digest('hex')}"` !== part.etag) throw new Error(`Part ${part.partNumber} is different.`);
      }
    }

    try {
      await pipeline(checkedParts(), createWriteStream(temporary));
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
    await rm(dir, { recursive: true, force: true });
  }

  async abortMultipart(_key: string, uploadId: string) { await rm(this.partsDir(uploadId), { recursive: true, force: true }); }
  async head(key: string) { try { return { size: (await stat(this.path(key))).size }; } catch { return null; } }
  async download(key: string, toPath: string, signal?: AbortSignal) {
    await mkdir(dirname(toPath), { recursive: true });
    if (signal) await pipeline(createReadStream(this.path(key)), createWriteStream(toPath), { signal });
    else await copyFile(this.path(key), toPath);
  }
  async putFile(key: string, fromPath: string) { const p = this.path(key); await mkdir(dirname(p), { recursive: true }); await copyFile(fromPath, p); }
  async putBuffer(key: string, body: Buffer) { const p = this.path(key); await mkdir(dirname(p), { recursive: true }); await writeFile(p, body); }
  async getText(key: string) { try { return await readFile(this.path(key), 'utf8'); } catch { return null; } }
  async list(prefix: string): Promise<string[]> {
    const base = this.path(prefix);
    const out: string[] = [];
    const walk = async (dir: string) => {
      for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const p = join(dir, e.name);
        if (e.isDirectory()) await walk(p); else out.push(relative(this.root, p).split(sep).join('/'));
      }
    };
    await walk(base);
    return out;
  }
  async copyObject(from: string, to: string) { const dst = this.path(to); await mkdir(dirname(dst), { recursive: true }); await copyFile(this.path(from), dst); }
  async copyPrefix(from: string, to: string) {
    const keys = await this.list(from);
    for (const k of keys) { const dst = this.path(to + k.slice(from.length)); await mkdir(dirname(dst), { recursive: true }); await copyFile(this.path(k), dst); }
    return keys.length;
  }
  async deletePrefix(prefix: string) {
    const keys = await this.list(prefix);
    await rm(this.path(prefix), { recursive: true, force: true });
    return keys.length;
  }
  async signedGetUrl(key: string, ttlSec: number) {
    return `${this.appUrl}/api/storage/local/file/${this.sign({ k: key, exp: Date.now() + ttlSec * 1000 })}`;
  }
}

export function createStorage(config: AppConfig): Storage {
  return config.media.driver === 's3' ? new S3Storage(config.media.s3!) : new LocalStorage(config.media.localDir, config.appUrl, config.sessionSecret);
}

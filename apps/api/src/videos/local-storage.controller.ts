import { BadRequestException, Controller, Get, HttpCode, Inject, NotFoundException, Param, Put, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { extname, relative, resolve } from 'node:path';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { STORAGE } from '../media/queue';
import { LocalStorage, type Storage } from '../media/storage';

const TYPES: Record<string, string> = { '.m3u8': 'application/vnd.apple.mpegurl', '.m4s': 'video/iso.segment', '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

/**
 * Development stand-in for object storage and the CDN (STORAGE_DRIVER=local only): receives upload parts at their
 * signed addresses and serves public and signed files. Refuses to work with any other driver.
 */
@ApiExcludeController()
@Controller('storage/local')
export class LocalStorageController {
  constructor(@Inject(STORAGE) private readonly storage: Storage, @Inject(APP_CONFIG) private readonly config: AppConfig) {}

  private local(): LocalStorage {
    if (!(this.storage instanceof LocalStorage)) throw new NotFoundException();
    return this.storage;
  }

  @Put('part/:token')
  @HttpCode(200)
  async part(@Param('token') token: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const s = this.local();
    const p = s.verify<{ k: string; u: string; n: number; exp: number }>(token);
    if (!p) throw new BadRequestException('This upload link has expired.');
    const chunks: Buffer[] = []; let size = 0;
    for await (const c of req as AsyncIterable<Buffer>) { size += c.length; if (size > this.config.media.partBytes) throw new BadRequestException('Part too large.'); chunks.push(c); }
    const etag = await s.writePart(p.u, p.n, Buffer.concat(chunks));
    res.setHeader('ETag', etag);
    res.setHeader('Access-Control-Expose-Headers', 'ETag');
    return {};
  }

  private send(res: Response, key: string, cache: string) {
    const s = this.local();
    let path: string;
    try { path = resolve(s.path(key)); } catch { throw new NotFoundException(); }
    // Send relative to the storage folder: the dot-file check then covers only the key, not the folder itself
    // (the default LOCAL_STORAGE_DIR is ./.data/storage, which a check on the full path would refuse).
    const root = resolve(s.rootDir);
    res.setHeader('Cache-Control', cache);
    const type = TYPES[extname(key)];
    if (type) res.type(type);
    res.sendFile(relative(root, path), { root, dotfiles: 'deny' }, (e) => { if (e && !res.headersSent) res.status(404).end(); });
  }

  @Get('file/:token')
  file(@Param('token') token: string, @Res() res: Response) {
    const p = this.local().verify<{ k: string; exp: number }>(token);
    if (!p) throw new NotFoundException();
    this.send(res, p.k, 'private, max-age=3600');
  }

  /** Stand-in CDN for the pub/ prefix: videos, live streams, and profile and Space pictures. */
  @Get('pub/*key')
  pub(@Param('key') key: string | string[], @Res() res: Response) {
    const rel = Array.isArray(key) ? key.join('/') : key;
    if (!/^((live|profiles|channels)\/)?[0-9a-f-]{36}\/[\w./-]+$/.test(rel) || rel.includes('..')) throw new NotFoundException();
    // A live playlist changes every two seconds.
    this.send(res, `pub/${rel}`, rel.endsWith('.m3u8') ? (rel.startsWith('live/') ? 'no-cache, max-age=1' : 'public, max-age=30') : 'public, max-age=31536000, immutable');
  }
}

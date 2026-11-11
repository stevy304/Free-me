import { Logger } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { run } from '../media/probe';
import { sourceKey } from '../media/keys';
import type { Storage } from '../media/storage';
import { publish, room } from '../realtime/publish';
import { browserLiveMaster, browserRenditions } from './browser-hls';

/** Where a live stream's HLS lives in storage (served by the CDN like any public media). */
export const livePrefix = (id: string) => `pub/live/${id}/`;
export const LIVE_PLAYLIST = 'index.m3u8';

/**
 * Copies a live stream's HLS from the folder an encoder writes (ffmpeg for browser streams, nginx-rtmp for OBS and
 * TV encoders) to storage, as it grows: each segment once it is listed in the playlist, then the playlist itself
 * (so a player never sees a segment that is not there yet).
 */
export class LiveSync {
  private readonly sent = new Set<string>();
  private readonly playlists = new Map<string, string>();
  private pending: Promise<void> | null = null;
  private masterPublished = false;
  constructor(private readonly storage: Storage, readonly streamId: string, readonly dir: string, private readonly source: 'browser' | 'rtmp' = 'rtmp') {}

  get replayPlaylist() {
    return this.source === 'browser' ? browserRenditions.at(-1)!.playlist : LIVE_PLAYLIST;
  }

  tick() {
    this.pending ??= this.sync().finally(() => { this.pending = null; });
    return this.pending;
  }

  private async sync() {
    if (this.source === 'rtmp') { await this.syncPlaylist(LIVE_PLAYLIST); return; }
    for (const { playlist } of browserRenditions) await this.syncPlaylist(playlist);
    if (!this.masterPublished && browserRenditions.every(({ playlist }) => this.playlists.has(playlist))) {
      await this.putPlaylist(LIVE_PLAYLIST, browserLiveMaster());
      this.masterPublished = true;
    }
  }

  private async syncPlaylist(playlist: string) {
    let text: string;
    try { text = await readFile(join(this.dir, playlist), 'utf8'); } catch { return; }
    if (text === this.playlists.get(playlist)) return;
    const segments = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    if (!segments.length) return;
    const init = /#EXT-X-MAP:URI="([^"]+)"/.exec(text)?.[1];
    for (const name of [...(init ? [init] : []), ...segments]) {
      if (this.sent.has(name) || name.includes('/') || name.includes('..')) continue;
      await this.storage.putFile(livePrefix(this.streamId) + name, join(this.dir, name), { contentType: name.endsWith('.ts') ? 'video/mp2t' : 'video/mp4', cacheControl: 'public, max-age=31536000, immutable' });
      this.sent.add(name);
    }
    await this.putPlaylist(playlist, text);
    this.playlists.set(playlist, text);
  }

  private putPlaylist(playlist: string, text: string) {
    return this.storage.putBuffer(livePrefix(this.streamId) + playlist, Buffer.from(text), { contentType: 'application/vnd.apple.mpegurl', cacheControl: 'no-cache, max-age=1' });
  }
}

/**
 * After a stream: the whole recording becomes an ordinary private video (processed like an upload, so it gets every
 * quality, thumbnails and captions); the creator publishes it from Creator Hub if they want a replay. The live copy
 * in storage is then removed.
 */
export async function finishLive(prisma: PrismaClient, storage: Storage, sync: LiveSync, queue: (videoId: string) => Promise<void>, log: Logger, ffmpeg = 'ffmpeg') {
  const id = sync.streamId;
  try { await sync.tick(); } catch (e) { log.warn(`live ${id}: last sync failed: ${(e as Error).message}`); }
  const s = await prisma.liveStream.findUnique({ where: { id } });
  if (!s || s.replayVideoId) return;
  const recording = join(sync.dir, 'replay.mp4');
  try {
    await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-allowed_extensions', 'ALL', '-i', join(sync.dir, sync.replayPlaylist), '-c', 'copy', '-movflags', '+faststart', recording]);
    const size = (await stat(recording)).size;
    const v = await prisma.video.create({ data: { channelId: s.channelId, title: `${s.title} (live)`.slice(0, 100), status: 'PROCESSING', visibility: 'PRIVATE', processingStage: 'Waiting to process', sourceSizeBytes: BigInt(size) } });
    const key = sourceKey(v.id, '.mp4');
    await storage.putFile(key, recording, { contentType: 'video/mp4' });
    await prisma.video.update({ where: { id: v.id }, data: { sourceFileS3Key: key } });
    await prisma.liveStream.update({ where: { id }, data: { replayVideoId: v.id } });
    await queue(v.id);
    await storage.deletePrefix(livePrefix(id));
    log.log(`live ${id}: recording saved as video ${v.id}`);
  } catch (e) {
    log.warn(`live ${id}: no recording: ${(e as Error).message.slice(0, 300)}`);
  } finally {
    await rm(sync.dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Marks a stream as ended and tells its viewers. */
export async function endLive(prisma: PrismaClient, id: string) {
  const r = await prisma.liveStream.updateMany({ where: { id, status: 'LIVE' }, data: { status: 'ENDED', endedAt: new Date() } });
  if (r.count) publish(room.live(id), 'ended', { id });
  return r.count > 0;
}

/** Folders of streams in the nginx-rtmp HLS directory (one per stream id). */
export async function rtmpFolders(dir: string) { try { return (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; } }

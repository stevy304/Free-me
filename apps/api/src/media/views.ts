import type { PrismaClient } from '@prisma/client';
import type Redis from 'ioredis';

const PENDING_VIEWS = 'fm:views:pending';
const PENDING_WATCH = 'fm:watch:pending';
/** The same viewer counts once per video in this window. */
const DEDUPE_SECONDS = 6 * 3600;

/**
 * View and watch-time counting without a database write per view: views are de-duplicated and added up in Redis,
 * then written to PostgreSQL in one batch every few seconds (flush). Without Redis (development) they are written directly.
 */
export class ViewCounter {
  constructor(private readonly prisma: PrismaClient, private readonly redis: Redis | null) {}

  /** Returns true when this counted as a new view. */
  async record(videoId: string, viewerKey: string, watchedSeconds: number): Promise<boolean> {
    const seconds = Math.max(0, Math.min(6 * 3600, Math.round(watchedSeconds)));
    if (!this.redis) {
      await this.prisma.video.update({ where: { id: videoId }, data: { viewCount: { increment: 1 }, watchTimeSeconds: { increment: seconds } } });
      return true;
    }
    const fresh = await this.redis.set(`fm:view:${videoId}:${viewerKey}`, '1', 'EX', DEDUPE_SECONDS, 'NX');
    const m = this.redis.multi();
    if (fresh) m.hincrby(PENDING_VIEWS, videoId, 1);
    if (seconds) m.hincrby(PENDING_WATCH, videoId, seconds);
    await m.exec();
    return fresh === 'OK';
  }

  /** Writes counted views and watch time to the database. Safe to run on several workers at once. */
  async flush(): Promise<number> {
    if (!this.redis) return 0;
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const take = async (key: string) => {
      const tmp = `${key}:flushing:${stamp}`;
      try { await this.redis!.rename(key, tmp); } catch { return {} as Record<string, string>; } // nothing pending
      const all = await this.redis!.hgetall(tmp);
      return Object.assign(all, { __tmp: tmp });
    };
    const views = await take(PENDING_VIEWS);
    const watch = await take(PENDING_WATCH);
    const ids = new Set([...Object.keys(views), ...Object.keys(watch)].filter((k) => k !== '__tmp'));
    for (const id of ids) {
      const v = Number(views[id] ?? 0); const w = Number(watch[id] ?? 0);
      const video = await this.prisma.video.updateMany({ where: { id }, data: { viewCount: { increment: v }, monetizedViewCount: { increment: 0 }, watchTimeSeconds: { increment: w } } });
      if (video.count && v) {
        const row = await this.prisma.video.findUnique({ where: { id }, select: { channelId: true } });
        if (row) await this.prisma.channel.update({ where: { id: row.channelId }, data: { totalViews: { increment: v } } });
      }
    }
    for (const t of [views.__tmp, watch.__tmp]) if (t) await this.redis.del(t);
    return ids.size;
  }
}

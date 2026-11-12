import type { PrismaClient } from '@prisma/client';
import type Redis from 'ioredis';

const PENDING_VIEWS = 'fm:views:pending';
const PENDING_WATCH = 'fm:watch:pending';
const PENDING_PLUS = 'fm:pluswatch:pending';
/** The same viewer counts once per video in this window. */
const DEDUPE_SECONDS = 6 * 3600;
const today = () => new Date().toISOString().slice(0, 10);

/** Adds views and watch time to one video's row for one day (UTC). */
async function addDaily(prisma: PrismaClient, videoId: string, day: string, views: number, seconds: number, plusSeconds = 0) {
  if (!views && !seconds && !plusSeconds) return;
  await prisma.$executeRaw`
    INSERT INTO "VideoDailyStat" ("videoId", "day", "views", "watchSeconds", "plusWatchSeconds") SELECT ${videoId}, ${day}::date, ${views}, ${seconds}, ${plusSeconds}
    WHERE EXISTS (SELECT 1 FROM "Video" WHERE "id" = ${videoId})
    ON CONFLICT ("videoId", "day") DO UPDATE SET "views" = "VideoDailyStat"."views" + EXCLUDED."views", "watchSeconds" = "VideoDailyStat"."watchSeconds" + EXCLUDED."watchSeconds",
      "plusWatchSeconds" = "VideoDailyStat"."plusWatchSeconds" + EXCLUDED."plusWatchSeconds"`;
}

/**
 * View and watch-time counting without a database write per view: views are de-duplicated and added up in Redis,
 * then written to PostgreSQL in one batch every few seconds (flush). Without Redis (development) they are written directly.
 */
export class ViewCounter {
  constructor(private readonly prisma: PrismaClient, private readonly redis: Redis | null) {}

  /** Returns true when this counted as a new view. */
  /** `plus`: the viewer has Plus perks; their watch time also counts for sharing subscription money with creators. */
  async record(videoId: string, viewerKey: string, watchedSeconds: number, plus = false): Promise<boolean> {
    const seconds = Math.max(0, Math.min(6 * 3600, Math.round(watchedSeconds)));
    if (!this.redis) {
      await this.prisma.video.update({ where: { id: videoId }, data: { viewCount: { increment: 1 }, watchTimeSeconds: { increment: seconds } } });
      await addDaily(this.prisma, videoId, today(), 1, seconds, plus ? seconds : 0);
      return true;
    }
    const fresh = await this.redis.set(`fm:view:${videoId}:${viewerKey}`, '1', 'EX', DEDUPE_SECONDS, 'NX');
    const m = this.redis.multi();
    // Fields are "<video>|<day>", so a batch also knows which day each view belongs to.
    const field = `${videoId}|${today()}`;
    if (fresh) m.hincrby(PENDING_VIEWS, field, 1);
    if (seconds) m.hincrby(PENDING_WATCH, field, seconds);
    if (seconds && plus) m.hincrby(PENDING_PLUS, field, seconds);
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
    const plusWatch = await take(PENDING_PLUS);
    const fields = new Set([...Object.keys(views), ...Object.keys(watch), ...Object.keys(plusWatch)].filter((k) => k !== '__tmp'));
    // Per day for the charts; per video for the totals. (Fields from before days were recorded count as today.)
    const totals = new Map<string, { v: number; w: number }>();
    for (const f of fields) {
      const [id, day = today()] = f.split('|');
      const v = Number(views[f] ?? 0); const w = Number(watch[f] ?? 0);
      await addDaily(this.prisma, id, day, v, w, Number(plusWatch[f] ?? 0));
      const t = totals.get(id) ?? { v: 0, w: 0 };
      totals.set(id, { v: t.v + v, w: t.w + w });
    }
    const ids = new Set(totals.keys());
    for (const id of ids) {
      const { v, w } = totals.get(id)!;
      const video = await this.prisma.video.updateMany({ where: { id }, data: { viewCount: { increment: v }, monetizedViewCount: { increment: 0 }, watchTimeSeconds: { increment: w } } });
      if (video.count && v) {
        const row = await this.prisma.video.findUnique({ where: { id }, select: { channelId: true } });
        if (row) await this.prisma.channel.update({ where: { id: row.channelId }, data: { totalViews: { increment: v } } });
      }
    }
    for (const t of [views.__tmp, watch.__tmp, plusWatch.__tmp]) if (t) await this.redis.del(t);
    return ids.size;
  }
}

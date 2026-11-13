import type { PrismaClient } from '@prisma/client';
import type Redis from 'ioredis';

const PENDING_VIEWS = 'fm:views:pending';
const PENDING_WATCH = 'fm:watch:pending';
const PENDING_PLUS = 'fm:pluswatch:pending';
/** The same viewer counts once per video in this window. */
const DEDUPE_SECONDS = 6 * 3600;
/** Seconds one heartbeat may report (the player sends one about every minute). */
const MAX_BEAT_SECONDS = 150;
const beatKey = (videoId: string, viewerKey: string) => `fm:beat:${videoId}:${viewerKey}`;
/** A batch claimed by a worker that then stopped is taken again after this long. */
const ABANDONED_MS = 2 * 60_000;
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
    // Start this viewer's watch-time account for the video: later heartbeats (addWatch) are checked against it.
    if (fresh) m.hset(beatKey(videoId, viewerKey), 'at', Date.now(), 'total', seconds).expire(beatKey(videoId, viewerKey), DEDUPE_SECONDS);
    // Fields are "<video>|<day>", so a batch also knows which day each view belongs to.
    const field = `${videoId}|${today()}`;
    if (fresh) m.hincrby(PENDING_VIEWS, field, 1);
    if (seconds) m.hincrby(PENDING_WATCH, field, seconds);
    if (seconds && plus) m.hincrby(PENDING_PLUS, field, seconds);
    await m.exec();
    return fresh === 'OK';
  }

  /**
   * Watch time after the view was counted: the player reports the seconds it played (about once a minute, and on
   * pause or leave). Each report is checked against the real time since the last one (at most 2x speed), and a viewer
   * adds at most the video's length (plus a minute) per video every 6 hours, so time cannot be inflated by sending
   * reports faster or replaying. Returns the seconds counted.
   */
  async addWatch(videoId: string, viewerKey: string, watchedSeconds: number, durationSeconds: number, plus = false): Promise<number> {
    const claimed = Math.max(0, Math.min(MAX_BEAT_SECONDS, Math.round(watchedSeconds)));
    if (!claimed) return 0;
    if (!this.redis) {
      await this.prisma.video.update({ where: { id: videoId }, data: { watchTimeSeconds: { increment: claimed } } });
      await addDaily(this.prisma, videoId, today(), 0, claimed, plus ? claimed : 0);
      return claimed;
    }
    const key = beatKey(videoId, viewerKey);
    const [at, total] = await this.redis.hmget(key, 'at', 'total');
    if (!at) return 0; // no counted view in the last 6 hours: nothing to add to
    const now = Date.now();
    const elapsed = Math.max(0, (now - Number(at)) / 1000);
    const room = Math.max(0, durationSeconds + 60 - Number(total ?? 0));
    const seconds = Math.floor(Math.min(claimed, elapsed * 2 + 2, room));
    const m = this.redis.multi().hset(key, 'at', now);
    if (seconds > 0) {
      const field = `${videoId}|${today()}`;
      m.hincrby(key, 'total', seconds).hincrby(PENDING_WATCH, field, seconds);
      if (plus) m.hincrby(PENDING_PLUS, field, seconds);
    }
    await m.exec();
    return Math.max(0, seconds);
  }

  /**
   * Writes counted views and watch time to the database: three statements whatever the number of videos (per-day
   * rows for the charts, video totals, Space totals), in one transaction that also records the batch, so it is all
   * or nothing. Safe on several workers at once (each claims what is pending by renaming it) and after a crash: a
   * claimed batch nobody finished is taken again after two minutes, and one already written is only removed.
   */
  async flush(now = Date.now()): Promise<number> {
    if (!this.redis) return 0;
    const redis = this.redis;
    const stamp = `${now}-${Math.random().toString(36).slice(2)}`;
    const claim = async (key: string) => { try { await redis.rename(key, `${key}:flushing:${stamp}`); return true; } catch { return false; } };
    const stamps = new Set<string>();
    if ((await Promise.all([claim(PENDING_VIEWS), claim(PENDING_WATCH), claim(PENDING_PLUS)])).some(Boolean)) stamps.add(stamp);
    // Batches another worker claimed and never finished.
    for (const base of [PENDING_VIEWS, PENDING_WATCH, PENDING_PLUS]) {
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', `${base}:flushing:*`, 'COUNT', 100);
        cursor = next;
        for (const k of keys) { const s = k.slice(`${base}:flushing:`.length); if (now - Number(s.split('-')[0]) > ABANDONED_MS) stamps.add(s); }
      } while (cursor !== '0');
    }
    let videos = 0;
    for (const s of stamps) videos += await this.write(s);
    if (stamps.size) await this.prisma.counterFlush.deleteMany({ where: { createdAt: { lt: new Date(now - 7 * 86_400_000) } } });
    return videos;
  }

  private async write(stamp: string): Promise<number> {
    const redis = this.redis!;
    const keys = [PENDING_VIEWS, PENDING_WATCH, PENDING_PLUS].map((k) => `${k}:flushing:${stamp}`);
    const [views, watch, plusWatch] = await Promise.all(keys.map((k) => redis.hgetall(k)));
    const fields = [...new Set([...Object.keys(views), ...Object.keys(watch), ...Object.keys(plusWatch)])];
    // Per day for the charts; per video for the totals. (Fields from before days were recorded count as today.)
    const daily = fields.map((f) => { const [id, day = today()] = f.split('|'); return { id, day, v: Number(views[f] ?? 0), w: Number(watch[f] ?? 0), p: Number(plusWatch[f] ?? 0) }; })
      .filter((d) => d.id && /^\d{4}-\d{2}-\d{2}$/.test(d.day) && (d.v || d.w || d.p));
    const totals = new Map<string, { v: number; w: number }>();
    for (const d of daily) { const t = totals.get(d.id) ?? { v: 0, w: 0 }; totals.set(d.id, { v: t.v + d.v, w: t.w + d.w }); }
    const ids = [...totals.keys()];
    if (ids.length) {
      await this.prisma.$transaction(async (tx) => {
        // Already written by a worker that stopped before removing the batch: nothing to add.
        const fresh = await tx.$executeRaw`INSERT INTO "CounterFlush" ("stamp") VALUES (${stamp}) ON CONFLICT DO NOTHING`;
        if (!fresh) return;
        await tx.$executeRaw`
          INSERT INTO "VideoDailyStat" ("videoId", "day", "views", "watchSeconds", "plusWatchSeconds")
          SELECT d."id", d."day", d."v", d."w", d."p"
          FROM unnest(${daily.map((d) => d.id)}::text[], ${daily.map((d) => d.day)}::date[], ${daily.map((d) => d.v)}::int[], ${daily.map((d) => d.w)}::bigint[], ${daily.map((d) => d.p)}::bigint[]) AS d("id", "day", "v", "w", "p")
          WHERE EXISTS (SELECT 1 FROM "Video" x WHERE x."id" = d."id")
          ON CONFLICT ("videoId", "day") DO UPDATE SET "views" = "VideoDailyStat"."views" + EXCLUDED."views", "watchSeconds" = "VideoDailyStat"."watchSeconds" + EXCLUDED."watchSeconds",
            "plusWatchSeconds" = "VideoDailyStat"."plusWatchSeconds" + EXCLUDED."plusWatchSeconds"`;
        await tx.$executeRaw`
          UPDATE "Video" x SET "viewCount" = x."viewCount" + d."v", "watchTimeSeconds" = x."watchTimeSeconds" + d."w"
          FROM unnest(${ids}::text[], ${ids.map((id) => totals.get(id)!.v)}::bigint[], ${ids.map((id) => totals.get(id)!.w)}::bigint[]) AS d("id", "v", "w")
          WHERE x."id" = d."id"`;
        await tx.$executeRaw`
          UPDATE "Channel" c SET "totalViews" = c."totalViews" + s."v"
          FROM (SELECT x."channelId", SUM(d."v") AS "v" FROM unnest(${ids}::text[], ${ids.map((id) => totals.get(id)!.v)}::bigint[]) AS d("id", "v")
                JOIN "Video" x ON x."id" = d."id" GROUP BY x."channelId" HAVING SUM(d."v") > 0) s
          WHERE c."id" = s."channelId"`;
      }, { timeout: 60_000 });
    }
    await redis.del(...keys);
    return ids.length;
  }
}

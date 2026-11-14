import type { PrismaClient } from '@prisma/client';
import type Redis from 'ioredis';

const PENDING_VIEWS = 'fm:views:pending';
const PENDING_WATCH = 'fm:watch:pending';
const PENDING_PLUS = 'fm:pluswatch:pending';
/** Views judged not valid (media/view-quality.ts), per video and day: kept for creators and moderators, never counted. */
const PENDING_INVALID = 'fm:views:invalid:pending';
/** The same viewer counts once per video in this window. */
const DEDUPE_SECONDS = 6 * 3600;
/** Seconds one heartbeat may report (the player sends one about every minute). */
const MAX_BEAT_SECONDS = 150;
const beatKey = (videoId: string, viewerKey: string) => `fm:beat:${videoId}:${viewerKey}`;
/** A batch claimed by a worker that then stopped is taken again after this long. */
const ABANDONED_MS = 2 * 60_000;
const today = () => new Date().toISOString().slice(0, 10);

/** Adds views and watch time to one video's row for one day (UTC). */
async function addDaily(prisma: PrismaClient, videoId: string, day: string, views: number, seconds: number, plusSeconds = 0, invalid = 0) {
  if (!views && !seconds && !plusSeconds && !invalid) return;
  await prisma.$executeRaw`
    INSERT INTO "VideoDailyStat" ("videoId", "day", "views", "watchSeconds", "plusWatchSeconds", "invalidViews") SELECT ${videoId}, ${day}::date, ${views}, ${seconds}, ${plusSeconds}, ${invalid}
    WHERE EXISTS (SELECT 1 FROM "Video" WHERE "id" = ${videoId})
    ON CONFLICT ("videoId", "day") DO UPDATE SET "views" = "VideoDailyStat"."views" + EXCLUDED."views", "watchSeconds" = "VideoDailyStat"."watchSeconds" + EXCLUDED."watchSeconds",
      "plusWatchSeconds" = "VideoDailyStat"."plusWatchSeconds" + EXCLUDED."plusWatchSeconds", "invalidViews" = "VideoDailyStat"."invalidViews" + EXCLUDED."invalidViews"`;
}

/**
 * View and watch-time counting without a database write per view: views are de-duplicated and added up in Redis,
 * then written to PostgreSQL in one batch every few seconds (flush). Without Redis (development) they are written directly.
 */
export class ViewCounter {
  private readonly local = new Map<string, { at: number; total: number; expires: number }>();
  constructor(private readonly prisma: PrismaClient, private readonly redis: Redis | null) {}

  /**
   * Returns true when this counted as a new view. `plus`: the viewer has Plus perks; their watch time also counts for
   * sharing subscription money with creators. `invalid`: why the view is not valid (view-quality.ts), or null: an
   * invalid view is recorded for the creator's statistics (once per viewer every 6 hours) and adds nothing else.
   */
  async record(videoId: string, viewerKey: string, watchedSeconds: number, plus = false, invalid: string | null = null): Promise<boolean> {
    const seconds = Math.max(0, Math.min(6 * 3600, (Number.isFinite(watchedSeconds) ? Math.round(watchedSeconds) : 0)));
    if (invalid) {
      if (!this.redis) { await addDaily(this.prisma, videoId, today(), 0, 0, 0, 1); return false; }
      const first = await this.redis.set(`fm:view:invalid:${videoId}:${viewerKey}`, '1', 'EX', DEDUPE_SECONDS, 'NX');
      if (first) await this.redis.hincrby(PENDING_INVALID, `${videoId}|${today()}`, 1);
      return false;
    }
    if (!this.redis) {
      const now = Date.now();
      for (const [key, value] of this.local) if (value.expires <= now) this.local.delete(key);
      const key = beatKey(videoId, viewerKey);
      if (this.local.has(key)) return false;
      this.local.set(key, { at: now, total: seconds, expires: now + DEDUPE_SECONDS * 1000 });
      try {
        await this.prisma.$transaction(async (tx) => {
          const v = await tx.video.update({ where: { id: videoId }, data: { viewCount: { increment: 1 }, watchTimeSeconds: { increment: seconds } } });
          await tx.channel.update({ where: { id: v.channelId }, data: { totalViews: { increment: 1 } } });
          await addDaily(tx as unknown as PrismaClient, videoId, today(), 1, seconds, plus ? seconds : 0);
        });
      } catch (error) { this.local.delete(key); throw error; }
      return true;
    }
    // Dedupe, initial watch account and pending counters move together, including across workers.
    const fresh = await this.redis.eval(`
      if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
      redis.call('SET', KEYS[1], '1', 'EX', ARGV[1])
      redis.call('HSET', KEYS[2], 'at', ARGV[2], 'total', ARGV[3])
      redis.call('EXPIRE', KEYS[2], ARGV[1])
      redis.call('HINCRBY', KEYS[3], ARGV[4], 1)
      redis.call('HINCRBY', KEYS[4], ARGV[4], ARGV[3])
      redis.call('HINCRBY', KEYS[5], ARGV[4], ARGV[5])
      return 1`, 5, `fm:view:${videoId}:${viewerKey}`, beatKey(videoId, viewerKey), PENDING_VIEWS, PENDING_WATCH, PENDING_PLUS,
      DEDUPE_SECONDS, Date.now(), seconds, `${videoId}|${today()}`, plus ? seconds : 0);
    return fresh === 1;
  }

  /**
   * Watch time after the view was counted: the player reports the seconds it played (about once a minute, and on
   * pause or leave). Each report is checked against the real time since the last one (at most 2x speed), and a viewer
   * adds at most the video's length (plus a minute) per video every 6 hours, so time cannot be inflated by sending
   * reports faster or replaying. Returns the seconds counted.
   */
  /** Whether this viewer's view of the video was already counted (in the last 6 hours): their watching now adds watch time from the first second. */
  async hasView(videoId: string, viewerKey: string): Promise<boolean> {
    if (!this.redis) { const e = this.local.get(beatKey(videoId, viewerKey)); return !!e && e.expires > Date.now(); }
    return (await this.redis.exists(beatKey(videoId, viewerKey))) === 1;
  }

  async addWatch(videoId: string, viewerKey: string, watchedSeconds: number, durationSeconds: number, plus = false): Promise<number> {
    const claimed = Math.max(0, Math.min(MAX_BEAT_SECONDS, (Number.isFinite(watchedSeconds) ? Math.round(watchedSeconds) : 0)));
    if (!claimed) return 0;
    if (!this.redis) {
      const entry = this.local.get(beatKey(videoId, viewerKey));
      const now = Date.now();
      if (!entry || entry.expires <= now) return 0;
      const seconds = Math.max(0, Math.floor(Math.min(claimed, (now - entry.at) / 1000 * 2, durationSeconds + 60 - entry.total)));
      entry.at = now; entry.total += seconds;
      try {
        await this.prisma.$transaction(async (tx) => {
          await tx.video.update({ where: { id: videoId }, data: { watchTimeSeconds: { increment: seconds } } });
          await addDaily(tx as unknown as PrismaClient, videoId, today(), 0, seconds, plus ? seconds : 0);
        });
      } catch (error) { entry.total -= seconds; throw error; }
      return seconds;
    }
    // Read/check/increment atomically so simultaneous tabs cannot spend the same elapsed time.
    return Number(await this.redis.eval(`
      local at = redis.call('HGET', KEYS[1], 'at')
      if not at then return 0 end
      local total = tonumber(redis.call('HGET', KEYS[1], 'total') or '0')
      local elapsed = math.max(0, (tonumber(ARGV[1]) - tonumber(at)) / 1000)
      local seconds = math.max(0, math.floor(math.min(tonumber(ARGV[2]), elapsed * 2, tonumber(ARGV[3]) + 60 - total)))
      redis.call('HSET', KEYS[1], 'at', ARGV[1])
      if seconds > 0 then
        redis.call('HINCRBY', KEYS[1], 'total', seconds)
        redis.call('HINCRBY', KEYS[2], ARGV[4], seconds)
        if ARGV[5] == '1' then redis.call('HINCRBY', KEYS[3], ARGV[4], seconds) end
      end
      return seconds`, 3, beatKey(videoId, viewerKey), PENDING_WATCH, PENDING_PLUS,
      Date.now(), claimed, durationSeconds, `${videoId}|${today()}`, plus ? 1 : 0));
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
    if ((await Promise.all([claim(PENDING_VIEWS), claim(PENDING_WATCH), claim(PENDING_PLUS), claim(PENDING_INVALID)])).some(Boolean)) stamps.add(stamp);
    // Batches another worker claimed and never finished.
    for (const base of [PENDING_VIEWS, PENDING_WATCH, PENDING_PLUS, PENDING_INVALID]) {
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
    const keys = [PENDING_VIEWS, PENDING_WATCH, PENDING_PLUS, PENDING_INVALID].map((k) => `${k}:flushing:${stamp}`);
    const [views, watch, plusWatch, invalid] = await Promise.all(keys.map((k) => redis.hgetall(k)));
    const fields = [...new Set([...Object.keys(views), ...Object.keys(watch), ...Object.keys(plusWatch), ...Object.keys(invalid)])];
    // Per day for the charts; per video for the totals. (Fields from before days were recorded count as today.)
    const daily = fields.map((f) => { const [id, day = today()] = f.split('|'); return { id, day, v: Number(views[f] ?? 0), w: Number(watch[f] ?? 0), p: Number(plusWatch[f] ?? 0), i: Number(invalid[f] ?? 0) }; })
      .filter((d) => d.id && /^\d{4}-\d{2}-\d{2}$/.test(d.day) && (d.v || d.w || d.p || d.i));
    const totals = new Map<string, { v: number; w: number }>();
    for (const d of daily) { const t = totals.get(d.id) ?? { v: 0, w: 0 }; totals.set(d.id, { v: t.v + d.v, w: t.w + d.w }); }
    const ids = [...totals.keys()];
    if (ids.length) {
      await this.prisma.$transaction(async (tx) => {
        // Already written by a worker that stopped before removing the batch: nothing to add.
        const fresh = await tx.$executeRaw`INSERT INTO "CounterFlush" ("stamp") VALUES (${stamp}) ON CONFLICT DO NOTHING`;
        if (!fresh) return;
        await tx.$executeRaw`
          INSERT INTO "VideoDailyStat" ("videoId", "day", "views", "watchSeconds", "plusWatchSeconds", "invalidViews")
          SELECT d."id", d."day", d."v", d."w", d."p", d."i"
          FROM unnest(${daily.map((d) => d.id)}::text[], ${daily.map((d) => d.day)}::date[], ${daily.map((d) => d.v)}::int[], ${daily.map((d) => d.w)}::bigint[], ${daily.map((d) => d.p)}::bigint[], ${daily.map((d) => d.i)}::int[]) AS d("id", "day", "v", "w", "p", "i")
          WHERE EXISTS (SELECT 1 FROM "Video" x WHERE x."id" = d."id")
          ON CONFLICT ("videoId", "day") DO UPDATE SET "views" = "VideoDailyStat"."views" + EXCLUDED."views", "watchSeconds" = "VideoDailyStat"."watchSeconds" + EXCLUDED."watchSeconds",
            "plusWatchSeconds" = "VideoDailyStat"."plusWatchSeconds" + EXCLUDED."plusWatchSeconds", "invalidViews" = "VideoDailyStat"."invalidViews" + EXCLUDED."invalidViews"`;
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

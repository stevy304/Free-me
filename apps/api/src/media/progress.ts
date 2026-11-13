import type { PrismaClient } from '@prisma/client';
import type Redis from 'ioredis';

/**
 * Resume positions without a database write per save. A signed-in viewer's player saves where they are every
 * 15 seconds; at a million people watching that is ~66,000 writes a second, more than one PostgreSQL server should
 * take for something this small. Saves go to one Redis hash instead (the latest one per viewer and video wins) and
 * the worker writes everything pending in a few multi-row statements every 15 seconds (flush). Until then, reads of
 * one viewer's position look in Redis first (`pending`), so resuming on another device stays exact.
 *
 * Without Redis (development) each save is written directly.
 */
const PENDING = 'fm:progress:pending';
/** The same saves per viewer (video → position), for reading one person's recent positions; kept a few minutes. */
const mine = (userId: string) => `fm:progress:u:${userId}`;
/** History removed (one video, or "*" for all) and when: a pending save made before that is not written. */
const forgotten = (userId: string) => `fm:progress:forgot:${userId}`;
const RECENT_SECONDS = 300;
/** Rows per statement: large enough to be efficient, small enough to keep each statement short. */
const BATCH = 2000;
/** A batch claimed by a worker that then stopped is picked up again after this long. */
const ABANDONED_MS = 2 * 60_000;

export interface Progress { seconds: number; completed: boolean; at: Date }
const encode = (p: Progress) => `${p.seconds}|${p.completed ? 1 : 0}|${p.at.getTime()}`;
const decode = (raw: string | null | undefined): Progress | null => {
  if (!raw) return null;
  const [s, c, t] = raw.split('|');
  const seconds = Number(s); const at = Number(t);
  return Number.isFinite(seconds) && Number.isFinite(at) ? { seconds, completed: c === '1', at: new Date(at) } : null;
};

export class ProgressBuffer {
  constructor(private readonly prisma: PrismaClient, private readonly redis: Redis | null) {}

  async save(userId: string, videoId: string, seconds: number, completed: boolean, at = new Date()) {
    if (!this.redis) {
      await this.prisma.watchHistory.upsert({
        where: { userId_videoId: { userId, videoId } },
        create: { userId, videoId, progressSeconds: seconds, completed, lastWatchedAt: at },
        update: { progressSeconds: seconds, completed, lastWatchedAt: at },
      });
      return;
    }
    const value = encode({ seconds, completed, at });
    await this.redis.multi().hset(PENDING, `${userId}|${videoId}`, value).hset(mine(userId), videoId, value).expire(mine(userId), RECENT_SECONDS).exec();
  }

  /** Positions this viewer saved in the last few minutes (video id → position), newest data first. */
  async recent(userId: string): Promise<Map<string, Progress>> {
    if (!this.redis) return new Map();
    const all = await this.redis.hgetall(mine(userId));
    return new Map(Object.entries(all).flatMap(([videoId, raw]) => { const p = decode(raw); return p ? [[videoId, p] as const] : []; }));
  }

  /**
   * History removed (one video, or all of it): pending saves made before now are dropped, including a batch a
   * worker is writing at this moment, so a removed video does not come back a few seconds later.
   */
  async forget(userId: string, videoId?: string) {
    if (!this.redis) return;
    const now = Date.now();
    const videos = videoId ? [videoId] : await this.redis.hkeys(mine(userId));
    const m = this.redis.multi().hset(forgotten(userId), videoId ?? '*', now).expire(forgotten(userId), 3600);
    if (videos.length) m.hdel(PENDING, ...videos.map((v) => `${userId}|${v}`)).hdel(mine(userId), ...videos);
    await m.exec();
  }

  /** A position saved but not written to the database yet (null when there is none). */
  async pending(userId: string, videoId: string): Promise<Progress | null> {
    if (!this.redis) return null;
    return decode(await this.redis.hget(mine(userId), videoId));
  }

  /**
   * Writes pending positions to the database. Safe on several workers at once (each claims what is pending by
   * renaming it) and after a crash (a claimed batch nobody finished is taken again; writing it twice changes
   * nothing, and an older position never replaces a newer one). Rows of deleted accounts or videos are skipped.
   */
  async flush(now = Date.now()): Promise<number> {
    if (!this.redis) return 0;
    const claimed = `${PENDING}:flushing:${now}:${Math.random().toString(36).slice(2)}`;
    const batches: string[] = [];
    try { await this.redis.rename(PENDING, claimed); batches.push(claimed); } catch { /* nothing pending */ }
    // Batches another worker claimed and never finished.
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', `${PENDING}:flushing:*`, 'COUNT', 100);
      cursor = next;
      for (const k of keys) if (k !== claimed && now - Number(k.split(':')[4]) > ABANDONED_MS) batches.push(k);
    } while (cursor !== '0');
    let written = 0;
    for (const key of batches) {
      const all = await this.redis.hgetall(key);
      const rows = Object.entries(all).flatMap(([field, raw]) => {
        const [userId, videoId] = field.split('|'); const p = decode(raw);
        return userId && videoId && p ? [{ userId, videoId, ...p }] : [];
      });
      const kept = await this.withoutForgotten(rows);
      for (let i = 0; i < kept.length; i += BATCH) written += await this.write(kept.slice(i, i + BATCH));
      await this.redis.del(key);
    }
    return written;
  }

  /** Drops saves made before their viewer removed that video (or all) from their history. */
  private async withoutForgotten<T extends { userId: string; videoId: string; at: Date }>(rows: T[]): Promise<T[]> {
    const users = [...new Set(rows.map((r) => r.userId))];
    const p = this.redis!.pipeline();
    for (const u of users) p.hgetall(forgotten(u));
    const res = (await p.exec()) ?? [];
    const marks = new Map(users.map((u, i) => [u, (res[i]?.[1] ?? {}) as Record<string, string>]));
    return rows.filter((r) => {
      const m = marks.get(r.userId)!;
      const at = Math.max(Number(m['*'] ?? 0), Number(m[r.videoId] ?? 0));
      return r.at.getTime() > at;
    });
  }

  private async write(rows: Array<{ userId: string; videoId: string } & Progress>): Promise<number> {
    if (!rows.length) return 0;
    return this.prisma.$executeRaw`
      INSERT INTO "WatchHistory" ("id", "userId", "videoId", "progressSeconds", "completed", "lastWatchedAt")
      SELECT gen_random_uuid()::text, d."userId", d."videoId", d."seconds", d."completed", d."at"
      FROM unnest(${rows.map((r) => r.userId)}::text[], ${rows.map((r) => r.videoId)}::text[], ${rows.map((r) => Math.round(r.seconds))}::int[],
                  ${rows.map((r) => r.completed)}::boolean[], ${rows.map((r) => r.at)}::timestamp[]) AS d("userId", "videoId", "seconds", "completed", "at")
      WHERE EXISTS (SELECT 1 FROM "User" u WHERE u."id" = d."userId") AND EXISTS (SELECT 1 FROM "Video" v WHERE v."id" = d."videoId")
      ON CONFLICT ("userId", "videoId") DO UPDATE SET "progressSeconds" = EXCLUDED."progressSeconds", "completed" = EXCLUDED."completed", "lastWatchedAt" = EXCLUDED."lastWatchedAt"
      WHERE "WatchHistory"."lastWatchedAt" <= EXCLUDED."lastWatchedAt"`;
  }
}

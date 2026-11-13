import type { PrismaClient } from '@prisma/client';
import type Redis from 'ioredis';
import { PUBLIC_VIDEO } from '../catalog/serialize';
import type { Features } from './rank';

/**
 * The feature store and candidate pools of "For you" (see ALGORITHM.md), rebuilt by the worker every few minutes.
 *
 * Requests never scan the catalogue: they read a few ready-made lists (pools) and the features of a few hundred
 * videos from Redis. Only the *active* part of the catalogue is kept there (published in the last 90 days, or
 * watched in the last 7, up to REC_ACTIVE_MAX videos, most watched first): at 100 million viewers that is what
 * people actually watch, and old videos stay reachable through search, Spaces and "related".
 */
export const KEY = {
  // "2": the compact string format; a new deploy ranks from the database until its worker has built this.
  features: (id: string) => `rec:f2:${id}`,
  topic: (categoryId: string) => `rec:pool:topic:${categoryId}`,
  moments: (categoryId: string | 'all') => `rec:pool:moments:${categoryId}`,
  trending: (country: string | 'all') => `rec:pool:trend:${country}`,
  fresh: 'rec:pool:fresh',
  quality: 'rec:pool:quality',
  related: (id: string) => `rec:rel:${id}`,
  /** Videos whose related list someone needed and nobody had prepared: the worker does these first. */
  relatedWanted: 'rec:rel:wanted',
  profile: (userId: string) => `rec:prof:${userId}`,
  feed: (who: string) => `rec:feed:${who}`,
  seen: (userId: string) => `rec:seen:${userId}`,
  builtAt: 'rec:built:2',
};
const POOL = 500;
const FEATURE_TTL = 3 * 86_400;
const DAY = 86_400_000;

/**
 * 0..1. Mostly how much of the video people watch (watch time ÷ (views × length)), the rest how they react (likes
 * vs "Not for me"). Both start from a prior (35% watched, an even like ratio) worth a few views, so one viewer
 * cannot make a new video look perfect or terrible.
 */
export function quality(v: { views: number; watchSeconds: number; durationSeconds: number; likes: number; dislikes: number }): number {
  const d = Math.max(1, v.durationSeconds);
  const watched = Math.min(1, Math.max(0, (v.watchSeconds + 5 * 0.35 * d) / ((v.views + 5) * d)));
  const liked = (v.likes + 1) / (v.likes + v.dislikes + 2);
  return Math.round((0.65 * watched + 0.35 * liked) * 1000) / 1000;
}

/**
 * One short string per video ("channel|topic|tag,tag|language|country|published|length|short|quality|recent|views"):
 * a request reads a few hundred of them with one MGET, about 13 times less work than as many Redis hashes.
 */
export const encodeFeatures = (f: Features): string => [f.channelId, f.categoryId ?? '', f.tagIds.join(','), f.language ?? '', f.country ?? '',
  f.publishedAt, f.durationSeconds, f.isShort ? 1 : '', f.quality, f.recentViews, f.views].join('|');
export const decodeFeatures = (id: string, raw: string | null): Features | null => {
  if (!raw) return null;
  const [c, k, t, l, o, p, d, s, q, r, v] = raw.split('|');
  return c ? { id, channelId: c, categoryId: k || null, tagIds: t ? t.split(',') : [], language: l || null, country: o || null,
    publishedAt: Number(p), durationSeconds: Number(d), isShort: s === '1', quality: Number(q), recentViews: Number(r), views: Number(v) } : null;
};

/** Features of these videos, from the store (missing ones are left out). */
export async function readFeatures(redis: Redis, ids: string[]): Promise<Map<string, Features>> {
  const out = new Map<string, Features>();
  for (let i = 0; i < ids.length; i += 1000) {
    const chunk = ids.slice(i, i + 1000);
    const values = await redis.mget(...chunk.map((id) => KEY.features(id)));
    chunk.forEach((id, j) => { const f = decodeFeatures(id, values[j]); if (f) out.set(id, f); });
  }
  return out;
}

/** Top ids of a pool, best first. */
export const poolIds = async (redis: Redis, key: string, n: number) => redis.zrevrange(key, 0, n - 1);

/**
 * Rebuilds the feature store and every pool. Pools are written to a temporary key and renamed, so a request never
 * sees a half-built list. Returns how many videos are in the store.
 */
export async function refreshSignals(prisma: PrismaClient, redis: Redis, opts: { maxActive?: number; now?: number } = {}): Promise<number> {
  const now = opts.now ?? Date.now();
  const max = opts.maxActive ?? 200_000;
  const day = (ago: number) => new Date(new Date(now - ago * DAY).toISOString().slice(0, 10));
  // Views per video in the last 2 days (momentum) and 7 days (is it active at all).
  const [recent, week] = await Promise.all([
    prisma.videoDailyStat.groupBy({ by: ['videoId'], where: { day: { gte: day(1) } }, _sum: { views: true } }),
    prisma.videoDailyStat.groupBy({ by: ['videoId'], where: { day: { gte: day(7) }, views: { gt: 0 } }, _sum: { views: true }, orderBy: { _sum: { views: 'desc' } }, take: max }),
  ]);
  const recentViews = new Map(recent.map((r) => [r.videoId, r._sum.views ?? 0]));
  const ids = new Set(week.map((w) => w.videoId));
  const newer = await prisma.video.findMany({ where: { ...PUBLIC_VIDEO, publishedAt: { gte: new Date(now - 90 * DAY) } }, orderBy: { publishedAt: 'desc' }, take: max, select: { id: true } });
  for (const v of newer) if (ids.size < max) ids.add(v.id);
  // A young or quiet platform: the most watched videos of all time too, so pools are never empty.
  if (ids.size < 2000) for (const v of await prisma.video.findMany({ where: PUBLIC_VIDEO, orderBy: { viewCount: 'desc' }, take: 2000, select: { id: true } })) ids.add(v.id);

  const pools = new Map<string, Array<[number, string]>>();
  const push = (key: string, s: number, id: string) => { let l = pools.get(key); if (!l) pools.set(key, (l = [])); l.push([s, id]); };
  const all = [...ids];
  let stored = 0;
  for (let i = 0; i < all.length; i += 1000) {
    const rows = await prisma.video.findMany({
      where: { ...PUBLIC_VIDEO, id: { in: all.slice(i, i + 1000) } },
      select: { id: true, channelId: true, categoryId: true, language: true, publishedAt: true, durationSeconds: true, isShort: true, viewCount: true, watchTimeSeconds: true, likeCount: true, dislikeCount: true,
        tags: { select: { tagId: true }, take: 10 }, channel: { select: { country: true } } },
    });
    const p = redis.pipeline();
    for (const v of rows) {
      const f: Features = {
        id: v.id, channelId: v.channelId, categoryId: v.categoryId, tagIds: v.tags.map((t) => t.tagId), language: v.language, country: v.channel.country,
        publishedAt: v.publishedAt!.getTime(), durationSeconds: v.durationSeconds, isShort: v.isShort, recentViews: recentViews.get(v.id) ?? 0, views: Number(v.viewCount),
        quality: quality({ views: Number(v.viewCount), watchSeconds: Number(v.watchTimeSeconds), durationSeconds: v.durationSeconds, likes: v.likeCount, dislikes: v.dislikeCount }),
      };
      p.set(KEY.features(v.id), encodeFeatures(f), 'EX', FEATURE_TTL);
      const ageDays = (now - f.publishedAt) / DAY;
      const momentum = Math.log10(1 + f.recentViews);
      // A pool score: good, watched now, recent. Each pool then takes its best POOL.
      const base = 2 * f.quality + 0.8 * momentum + Math.exp(-ageDays / 14);
      if (f.isShort) { push(KEY.moments('all'), base, v.id); if (f.categoryId) push(KEY.moments(f.categoryId), base, v.id); continue; }
      if (f.categoryId) push(KEY.topic(f.categoryId), base, v.id);
      if (f.recentViews > 0) { push(KEY.trending('all'), f.recentViews, v.id); if (f.country) push(KEY.trending(f.country), f.recentViews, v.id); }
      // New uploads, the least seen first among equally new ones: where new creators are found.
      if (ageDays <= 7) push(KEY.fresh, Math.exp(-ageDays / 3) + (f.views < 100 ? 0.5 : 0), v.id);
      push(KEY.quality, f.quality * Math.log10(10 + f.views), v.id);
      stored++;
    }
    await p.exec();
  }
  // Swap every pool in at once; pools that are now empty are removed.
  const old = await scanKeys(redis, 'rec:pool:*');
  const p = redis.pipeline();
  for (const [key, list] of pools) {
    const top = list.sort((a, b) => b[0] - a[0]).slice(0, POOL);
    const tmp = `${key}:building`;
    p.del(tmp).zadd(tmp, ...top.flatMap(([s, id]) => [s, id])).rename(tmp, key).expire(key, 86_400);
  }
  for (const key of old) if (!pools.has(key) && !key.endsWith(':building')) p.del(key);
  p.set(KEY.builtAt, String(now));
  await p.exec();
  return stored;
}

export async function scanKeys(redis: Redis, pattern: string): Promise<string[]> {
  const out: string[] = [];
  let cursor = '0';
  do { const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500); cursor = next; out.push(...keys); } while (cursor !== '0');
  return out;
}

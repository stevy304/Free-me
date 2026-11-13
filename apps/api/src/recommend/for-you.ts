import type { PrismaClient } from '@prisma/client';
import type Redis from 'ioredis';
import { PUBLIC_VIDEO } from '../catalog/serialize';
import { arrange, score, tasteSets, type Candidate, type Features, type Reason, type Scored, type Source, type Taste } from './rank';
import { related } from './related';
import { tasteFor } from './profile';
import { KEY, poolIds, quality, readFeatures } from './signals';

/** How many ranked videos one "For you" holds (5 pages of 24); worked out again after FEED_TTL. */
export const FEED_SIZE = 120;
export const PAGE = 24;
const FEED_TTL = { signedIn: 600, visitor: 120 };
const DAY = 86_400_000;

export const emptyTaste = (): Taste => ({ topics: {}, channels: {}, tags: {}, picked: [], follows: [], avoidChannels: {}, avoidTopics: {}, hidden: [], finished: [], started: [], seeds: [], language: null, country: null });

export interface Ranked { id: string; reason: Reason }

/**
 * Candidates (a few hundred) from every source, scored against the viewer's taste and arranged.
 * Reads Redis and a few small indexed queries; never the whole catalogue.
 */
export async function rankForYou(prisma: PrismaClient, redis: Redis | null, userId: string | null, now = Date.now()): Promise<Ranked[]> {
  const taste = userId ? await tasteFor(prisma, redis, userId) : emptyTaste();
  const cands = new Map<string, { sources: Set<Source>; related: number; relatedTo: string | null }>();
  const want = (id: string, source: Source) => { let c = cands.get(id); if (!c) cands.set(id, (c = { sources: new Set(), related: 0, relatedTo: null })); c.sources.add(source); return c; };

  const built = redis ? await redis.get(KEY.builtAt) : null;
  let features: Map<string, Features>;
  if (redis && built) {
    // Related to what the viewer watched: the most recent count most.
    // Only lists the worker prepared: computing eight of them during a request would cost more than everything else.
    const rel = await Promise.all(taste.seeds.slice(0, 8).map((seed) => related(prisma, redis, seed, { prepared: true })));
    rel.forEach((map, i) => {
      const max = Math.max(1, ...map.values());
      for (const [id, n] of map) {
        const c = want(id, 'related'); const strength = (n / max) * (1 - i * 0.08);
        if (strength > c.related) { c.related = strength; c.relatedTo = taste.seeds[i]; }
      }
    });
    const topics = [...new Set([...Object.entries(taste.topics).sort((a, b) => b[1] - a[1]).map(([k]) => k), ...taste.picked])].slice(0, 6);
    const [byTopic, trending, local, fresh, best] = await Promise.all([
      Promise.all(topics.map((t) => poolIds(redis, KEY.topic(t), 40))),
      poolIds(redis, KEY.trending('all'), 80),
      taste.country ? poolIds(redis, KEY.trending(taste.country), 40) : [],
      poolIds(redis, KEY.fresh, 60),
      poolIds(redis, KEY.quality, 60),
    ]);
    byTopic.flat().forEach((id) => want(id, 'topic'));
    [...trending, ...local].forEach((id) => want(id, 'trending'));
    fresh.forEach((id) => want(id, 'fresh'));
    best.forEach((id) => want(id, 'quality'));
    await followed(prisma, taste, now).then((ids) => ids.forEach((id) => want(id, 'following')));
    features = await readFeatures(redis, [...cands.keys()]);
    // Followed Spaces' videos may be older than the feature store keeps: read those few from the database.
    const missing = [...cands.keys()].filter((id) => !features.has(id) && cands.get(id)!.sources.has('following'));
    for (const [id, f] of await databaseFeatures(prisma, { ids: missing })) features.set(id, f);
  } else {
    // No Redis, or the worker has not built the pools yet: the newest and most watched videos, scored the same way.
    features = await databaseFeatures(prisma, { recent: 200, now });
    for (const [id, f] of features) want(id, now - f.publishedAt < 7 * DAY ? 'fresh' : 'quality');
    await followed(prisma, taste, now).then((ids) => ids.forEach((id) => want(id, 'following')));
    for (const [id, f] of await databaseFeatures(prisma, { ids: [...cands.keys()].filter((id) => !features.has(id)) })) features.set(id, f);
  }

  const seen = userId && redis ? await readSeen(redis, userId) : {};
  const seed = Math.floor(now / 3_600_000); // variety that changes every hour, not every page
  const sets = tasteSets(taste);
  const scored: Scored[] = [];
  for (const [id, c] of cands) {
    const f = features.get(id);
    if (!f || f.isShort) continue;
    const candidate: Candidate = { ...f, ...c };
    scored.push(score(candidate, taste, { now, seen, seed, sets }));
  }
  return arrange(scored, taste, { limit: FEED_SIZE, now }).map((s) => ({ id: s.id, reason: s.reason }));
}

/** The viewer's ranked "For you", kept for a few minutes so pages stay in the same order. */
export async function forYouFeed(prisma: PrismaClient, redis: Redis | null, userId: string | null): Promise<Ranked[]> {
  if (!redis) return rankForYou(prisma, null, userId);
  const key = KEY.feed(userId ? `u:${userId}` : 'visitor');
  const cached = await redis.get(key);
  if (cached) return JSON.parse(cached) as Ranked[];
  const ranked = await rankForYou(prisma, redis, userId);
  await redis.set(key, JSON.stringify(ranked), 'EX', userId ? FEED_TTL.signedIn : FEED_TTL.visitor);
  return ranked;
}

/** Shown on a page: counted, so what was shown and not opened moves down next time. */
export async function recordShown(redis: Redis | null, userId: string, ids: string[]) {
  if (!redis || !ids.length) return;
  const p = redis.pipeline();
  for (const id of ids) p.zincrby(KEY.seen(userId), 1, id);
  await p.expire(KEY.seen(userId), 2 * 86_400).exec();
}

/** Opened (watched): no longer counts as shown and ignored. */
export async function recordOpened(redis: Redis | null, userId: string, videoId: string) {
  if (redis) await redis.zrem(KEY.seen(userId), videoId);
}

async function readSeen(redis: Redis, userId: string): Promise<Record<string, number>> {
  const rows = await redis.zrange(KEY.seen(userId), 0, -1, 'WITHSCORES');
  const out: Record<string, number> = {};
  for (let i = 0; i < rows.length; i += 2) out[rows[i]] = Number(rows[i + 1]);
  return out;
}

async function followed(prisma: PrismaClient, taste: Taste, now: number): Promise<string[]> {
  if (!taste.follows.length) return [];
  const rows = await prisma.video.findMany({ where: { ...PUBLIC_VIDEO, isShort: false, channelId: { in: taste.follows }, publishedAt: { gte: new Date(now - 30 * DAY) } }, orderBy: { publishedAt: 'desc' }, take: 40, select: { id: true } });
  return rows.map((r) => r.id);
}

/** Features read straight from the database: for a few ids, or the newest and most watched videos. */
export async function databaseFeatures(prisma: PrismaClient, q: { ids?: string[]; recent?: number; now?: number }): Promise<Map<string, Features>> {
  if (q.ids && !q.ids.length) return new Map();
  const select = { id: true, channelId: true, categoryId: true, language: true, publishedAt: true, durationSeconds: true, isShort: true, viewCount: true, watchTimeSeconds: true, likeCount: true, dislikeCount: true,
    tags: { select: { tagId: true }, take: 10 }, channel: { select: { country: true } } } as const;
  const rows = q.ids
    ? await prisma.video.findMany({ where: { ...PUBLIC_VIDEO, id: { in: q.ids } }, select })
    : [...await prisma.video.findMany({ where: { ...PUBLIC_VIDEO, isShort: false }, orderBy: { publishedAt: 'desc' }, take: q.recent, select }),
       ...await prisma.video.findMany({ where: { ...PUBLIC_VIDEO, isShort: false }, orderBy: { viewCount: 'desc' }, take: q.recent, select })];
  return new Map(rows.map((v) => [v.id, {
    id: v.id, channelId: v.channelId, categoryId: v.categoryId, tagIds: v.tags.map((t) => t.tagId), language: v.language, country: v.channel.country,
    publishedAt: v.publishedAt!.getTime(), durationSeconds: v.durationSeconds, isShort: v.isShort, recentViews: 0, views: Number(v.viewCount),
    quality: quality({ views: Number(v.viewCount), watchSeconds: Number(v.watchTimeSeconds), durationSeconds: v.durationSeconds, likes: v.likeCount, dislikes: v.dislikeCount }),
  }]));
}

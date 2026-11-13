import type { PrismaClient } from '@prisma/client';
import type Redis from 'ioredis';
import { coWatched } from '../catalog/trending';
import { KEY, poolIds } from './signals';

/**
 * "People who watched this also watched", stored per video in Redis for 12 hours.
 *
 * Counting it means joining the latest 500 viewers of a video with everything they watched: fine once, far too
 * much for every request of a popular video at scale. The worker computes it ahead for the most watched videos
 * (refreshRelated), and a video nobody prepared is computed once on first use and kept, with concurrent requests
 * waiting for the same computation. Only counts shared by at least 3 people are kept (see coWatched), so nobody's own
 * history can be read from it.
 */
const TTL = 12 * 3600;
const inFlight = new Map<string, Promise<Map<string, number>>>();

async function compute(prisma: PrismaClient, redis: Redis, videoId: string): Promise<Map<string, number>> {
  const map = await coWatched(prisma, videoId, 50);
  const key = KEY.related(videoId);
  const p = redis.multi().del(key);
  // An empty list is remembered too (a marker), so a video with no co-viewers is not recomputed on every request.
  p.zadd(key, ...(map.size ? [...map].flatMap(([id, n]) => [n, id]) : [0, '-']));
  await p.expire(key, TTL).exec();
  return map;
}

/**
 * `prepared: true` (For you, which asks for up to 8 videos at once): only lists the worker already made; a missing one
 * is put on the worker's list instead of being computed during the request.
 */
export async function related(prisma: PrismaClient, redis: Redis | null, videoId: string, opts: { prepared?: boolean } = {}): Promise<Map<string, number>> {
  if (!redis) return opts.prepared ? new Map() : coWatched(prisma, videoId);
  const rows = await redis.zrevrange(KEY.related(videoId), 0, (opts.prepared ? 30 : 50) - 1, 'WITHSCORES');
  if (rows.length) {
    const out = new Map<string, number>();
    for (let i = 0; i < rows.length; i += 2) if (rows[i] !== '-') out.set(rows[i], Number(rows[i + 1]));
    return out;
  }
  if (opts.prepared) { await redis.multi().sadd(KEY.relatedWanted, videoId).expire(KEY.relatedWanted, 86_400).exec(); return new Map(); }
  let p = inFlight.get(videoId);
  if (!p) {
    p = compute(prisma, redis, videoId).finally(() => inFlight.delete(videoId));
    inFlight.set(videoId, p);
  }
  return p;
}

/**
 * Prepares related lists for the most watched videos right now (the trending pool, then the best per quality),
 * oldest list first, up to `limit` per run, so popular videos always have one ready.
 */
export async function refreshRelated(prisma: PrismaClient, redis: Redis, limit = 300): Promise<number> {
  // First the lists viewers needed (For you seeds), then the most watched videos'.
  const wanted = await redis.spop(KEY.relatedWanted, limit);
  for (const id of wanted) await compute(prisma, redis, id);
  limit -= wanted.length;
  const ids = [...new Set([...await poolIds(redis, KEY.trending('all'), 1000), ...await poolIds(redis, KEY.quality, 1000)])];
  if (!ids.length || limit <= 0) return wanted.length;
  const p = redis.pipeline();
  for (const id of ids) p.ttl(KEY.related(id));
  const ttl = ((await p.exec()) ?? []).map((r) => Number(r[1]));
  // Missing first (-2), then the ones closest to expiring; skip lists made in the last 6 hours.
  const due = ids.map((id, i) => ({ id, ttl: ttl[i] })).filter((x) => x.ttl < TTL - 6 * 3600).sort((a, b) => a.ttl - b.ttl).slice(0, limit);
  for (const { id } of due) await compute(prisma, redis, id);
  return wanted.length + due.length;
}

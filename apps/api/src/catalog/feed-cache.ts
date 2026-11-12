import type Redis from 'ioredis';

/**
 * The home page and Rising reuse answers for FEED_CACHE_SECONDS (RedisService.cached). When a video appears or
 * disappears for the public (published, visibility changed, removed, held, deleted), those answers are forgotten
 * at once, so a creator sees their new video on the home page right away. Each process (API, worker) registers how
 * to forget at start-up; code that changes a video only calls `feedsChanged()`.
 */
let sink: (() => Promise<void>) | null = null;

export function setFeedCacheSink(fn: (() => Promise<void>) | null) { sink = fn; }

/** Forgets the cached feeds. Never fails the change that called it: the cache expires on its own anyway. */
export async function feedsChanged() {
  try { await sink?.(); } catch { /* the entries expire within FEED_CACHE_SECONDS */ }
}

/** Deletes the shared feed entries in Redis (home page parts and Rising). */
export async function forgetFeedKeys(redis: Redis) {
  for (const pattern of ['fm:cache:home:*', 'fm:cache:rising:*']) {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
      cursor = next;
      if (keys.length) await redis.del(...keys);
    } while (cursor !== '0');
  }
}

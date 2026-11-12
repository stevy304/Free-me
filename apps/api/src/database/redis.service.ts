import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { APP_CONFIG, type AppConfig } from '../config/config';

/**
 * Redis for counters shared by every API instance (rate limits). Without REDIS_URL (local development, tests)
 * counters live in this process only, which is fine for one instance and refused in production by the health check.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly log = new Logger('Redis');
  readonly client: Redis | null;
  private readonly local = new Map<string, { n: number; until: number }>();

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.client = config.redisUrl ? new Redis(config.redisUrl, { maxRetriesPerRequest: 2, enableOfflineQueue: false, lazyConnect: false }) : null;
    this.client?.on('error', (e) => this.log.warn(`Redis: ${e.message}`));
  }

  /** Adds one to a counter that resets after `windowSec`; returns the new count and seconds until reset. */
  async hit(key: string, windowSec: number): Promise<{ count: number; ttl: number }> {
    if (this.client) {
      const k = `fm:rl:${key}`;
      const [[, count], [, ttl]] = (await this.client.multi().incr(k).ttl(k).exec()) as [[null, number], [null, number]];
      if (ttl < 0) { await this.client.expire(k, windowSec); return { count, ttl: windowSec }; }
      return { count, ttl };
    }
    const now = Date.now();
    const cur = this.local.get(key);
    if (!cur || cur.until <= now) { this.local.set(key, { n: 1, until: now + windowSec * 1000 }); return { count: 1, ttl: windowSec }; }
    cur.n++;
    return { count: cur.n, ttl: Math.ceil((cur.until - now) / 1000) };
  }

  private readonly memo = new Map<string, { until: number; value: unknown }>();
  private readonly inflight = new Map<string, Promise<unknown>>();

  /**
   * A value computed once and shared for `ttlSec` by every API instance (in this process only without Redis): for
   * answers that are the same for everyone, such as the home page's topic shelves and trending. Concurrent misses
   * in one process share one computation. The value must survive JSON (no BigInt, Date becomes a string).
   */
  async cached<T>(key: string, ttlSec: number, compute: () => Promise<T>): Promise<T> {
    if (ttlSec <= 0) return compute();
    const k = `fm:cache:${key}`;
    const local = this.memo.get(k);
    if (local && local.until > Date.now()) return local.value as T;
    const running = this.inflight.get(k);
    if (running) return running as Promise<T>;
    const job = (async () => {
      if (this.client) {
        const hit = await this.client.get(k).catch(() => null);
        if (hit !== null) return JSON.parse(hit) as T;
      }
      const value = await compute();
      const text = JSON.stringify(value);
      if (this.client) await this.client.set(k, text, 'EX', ttlSec).catch(() => undefined);
      return JSON.parse(text) as T;
    })();
    this.inflight.set(k, job);
    try {
      const value = await job;
      // A short local copy saves the Redis round trip on busy pages (a few seconds, well inside the TTL).
      this.memo.set(k, { until: Date.now() + Math.min(5, ttlSec) * 1000, value });
      if (this.memo.size > 5000) this.memo.clear();
      return value;
    } finally { this.inflight.delete(k); }
  }

  /** Current values of several `hit` counters (0 when missing or expired), without changing them. */
  async peek(keys: string[]): Promise<number[]> {
    if (!keys.length) return [];
    if (this.client) return (await this.client.mget(keys.map((k) => `fm:rl:${k}`))).map((v) => Number(v ?? 0));
    const now = Date.now();
    return keys.map((k) => { const cur = this.local.get(k); return cur && cur.until > now ? cur.n : 0; });
  }

  async ping(): Promise<'ok' | 'not configured' | 'down'> {
    if (!this.client) return 'not configured';
    try { return (await this.client.ping()) === 'PONG' ? 'ok' : 'down'; } catch { return 'down'; }
  }

  async onModuleDestroy() { await this.client?.quit().catch(() => undefined); }
}

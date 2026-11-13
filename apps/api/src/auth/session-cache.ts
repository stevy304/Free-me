import { Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import type { AuthContext } from '../common/request';

/**
 * Signed-in requests without a database read each. Every request of a signed-in viewer (a playing video sends one
 * every few seconds) needs its session and account; at millions of viewers that is the largest read load on
 * PostgreSQL, for rows that almost never change. Each API process keeps them for a few seconds.
 *
 * Anything that changes an account or ends a session calls `authChanged(userId)`: this process forgets that
 * account's sessions at once and tells every other process (Redis pub/sub), once now and once two seconds later
 * (a change made inside a transaction may not be committed yet the first time). If a message is lost, the entry
 * still expires after the cache time (SESSION_CACHE_SECONDS, 15 by default): the most a change can lag.
 */
const CHANNEL = 'fm:auth:changed';
const MAX = 200_000;
const caches = new Set<SessionCache>();
let publisher: Redis | null = null;
const log = new Logger('SessionCache');

export class SessionCache {
  private readonly byToken = new Map<string, { at: number; ctx: AuthContext }>();
  private readonly byUser = new Map<string, Set<string>>();
  private subscriber: Redis | null = null;

  constructor(private readonly ttlMs: number, redis: Redis | null) {
    caches.add(this);
    if (redis && ttlMs > 0) {
      publisher ??= redis;
      this.subscriber = redis.duplicate();
      this.subscriber.subscribe(CHANNEL).catch((e) => log.warn(`Could not subscribe to account changes: ${(e as Error).message}`));
      this.subscriber.on('message', (_channel, userId: string) => this.drop(userId));
      // Without the subscription, changes made on other servers would only be seen after the cache time: forget everything.
      this.subscriber.on('error', () => this.clear());
    }
  }

  get(tokenHash: string, now = Date.now()): AuthContext | null {
    const hit = this.byToken.get(tokenHash);
    if (!hit) return null;
    if (now - hit.at >= this.ttlMs) { this.remove(tokenHash, hit.ctx.user.id); return null; }
    return hit.ctx;
  }

  set(tokenHash: string, ctx: AuthContext, now = Date.now()) {
    if (this.ttlMs <= 0) return;
    this.byToken.set(tokenHash, { at: now, ctx });
    let mine = this.byUser.get(ctx.user.id);
    if (!mine) this.byUser.set(ctx.user.id, (mine = new Set()));
    mine.add(tokenHash);
    if (this.byToken.size > MAX) for (const [k, v] of this.byToken) { this.remove(k, v.ctx.user.id); if (this.byToken.size <= MAX * 0.9) break; }
  }

  drop(userId: string) {
    for (const t of this.byUser.get(userId) ?? []) this.byToken.delete(t);
    this.byUser.delete(userId);
  }

  clear() { this.byToken.clear(); this.byUser.clear(); }

  private remove(tokenHash: string, userId: string) {
    this.byToken.delete(tokenHash);
    const mine = this.byUser.get(userId);
    mine?.delete(tokenHash);
    if (mine && !mine.size) this.byUser.delete(userId);
  }

  async close() { caches.delete(this); await this.subscriber?.quit().catch(() => undefined); }
}

/** Processes without a session cache (the worker) still tell the API processes about account changes. */
export function setAuthPublisher(redis: Redis | null) { publisher ??= redis; }

/** An account changed (roles, status, plans, family) or its sessions were ended: every process forgets it. */
export function authChanged(userId: string) {
  for (const c of caches) c.drop(userId);
  if (!publisher) return;
  const send = () => publisher?.publish(CHANNEL, userId).catch((e) => log.warn(`Could not announce an account change: ${(e as Error).message}`));
  void send();
  setTimeout(() => { for (const c of caches) c.drop(userId); void send(); }, 2_000).unref();
}

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type Redis from 'ioredis';

/**
 * Which views count (MONETISATION.md, "Valid views"). Views decide ad money, the Moments pool and who may join
 * monetisation, so a view must come from someone actually playing the video:
 *
 * 1. Play ticket: when playback starts the player asks for a signed ticket. A view is accepted only with a ticket for
 *    the same video and viewer, at least the minimum watching time (30 s, or half of a shorter video) after it was
 *    issued, by the server's clock, and each ticket counts once. A script cannot count a view faster than a person
 *    watching it, and the watched seconds a player reports are capped by the real time since its ticket.
 * 2. Invalid traffic: views from automated browsers and scripts, or far more than a network or an account could
 *    watch, are recorded as "not valid" (shown to the creator) instead of counted.
 *
 * Ideas from YouTube's published approach: views are validated before they count, and spam views are removed from
 * counts and earnings.
 */

const TICKET_MAX_AGE_MS = 6 * 3600_000;

/** Browsers driven by programs, crawlers and HTTP libraries. */
const AUTOMATED = /bot\b|bot\/|crawl|spider|slurp|headless|phantomjs|puppeteer|playwright|selenium|webdriver|python-requests|python-urllib|aiohttp|curl\/|wget\/|httpclient|okhttp|go-http-client|java\/|scrapy|axios\/|node-fetch|undici|libwww|postman/i;

const hmac = (secret: string, data: string) => createHmac('sha256', `${secret}:play-ticket`).update(data).digest('base64url');
/** Anonymous viewers are bound to their browser (not their address, which changes when a phone switches network). */
export const ticketHolder = (userId: string | null, userAgent: string | null) => userId ? `u:${userId}` : `b:${createHash('sha256').update(userAgent ?? '').digest('hex').slice(0, 16)}`;

/** A ticket for one playback: `<issued ms>.<nonce>.<signature>`. */
export function playTicket(secret: string, videoId: string, holder: string, now = Date.now()): string {
  const nonce = randomBytes(9).toString('base64url');
  return `${now}.${nonce}.${hmac(secret, `${videoId}|${holder}|${now}|${nonce}`)}`;
}

/** The ticket's issue time and nonce when it is genuine, for this video and viewer, and not too old; else null. */
export function readTicket(secret: string, ticket: string | undefined, videoId: string, holder: string, now = Date.now()): { issuedAt: number; nonce: string } | null {
  const m = /^(\d{13})\.([A-Za-z0-9_-]{12})\.([A-Za-z0-9_-]{43})$/.exec(ticket ?? '');
  if (!m) return null;
  const issuedAt = Number(m[1]);
  const expected = Buffer.from(hmac(secret, `${videoId}|${holder}|${issuedAt}|${m[2]}`));
  const given = Buffer.from(m[3]);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  if (issuedAt > now + 5_000 || now - issuedAt > TICKET_MAX_AGE_MS) return null;
  return { issuedAt, nonce: m[2] };
}

/** Each ticket counts one view: false when it was used already. */
export async function spendTicket(redis: Redis | null, nonce: string): Promise<boolean> {
  if (!redis) return true;
  return (await redis.set(`fm:ticket:${nonce}`, '1', 'PX', TICKET_MAX_AGE_MS, 'NX')) === 'OK';
}

export interface QualityLimits { maxPerNetworkPerVideo: number; maxPerAccountPerDay: number; allowAutomated: boolean }

/**
 * Why a view (with a genuine ticket) is not valid, or null when it counts. Counts every attempt, so a flood is caught
 * however it is spread over viewer keys:
 * - an automated browser or script (by its user agent);
 * - signed out, more than `maxPerNetworkPerVideo` views of one video from one network address in a day (generous,
 *   because many people in Rwanda share an address through their mobile operator);
 * - signed in, more than `maxPerAccountPerDay` views by one account in a day.
 */
export async function invalidReason(redis: Redis | null, v: { videoId: string; userId: string | null; ip: string | null; userAgent: string | null }, limits: QualityLimits, now = Date.now()): Promise<string | null> {
  if (!limits.allowAutomated && (!v.userAgent || AUTOMATED.test(v.userAgent))) return 'automated';
  if (!redis) return null;
  const day = new Date(now).toISOString().slice(0, 10);
  const key = v.userId ? `fm:vq:acct:${v.userId}:${day}` : `fm:vq:net:${v.videoId}:${v.ip ?? 'unknown'}:${day}`;
  const n = await redis.multi().incr(key).expire(key, 2 * 86_400).exec();
  const count = Number(n?.[0]?.[1] ?? 0);
  if (v.userId) return count > limits.maxPerAccountPerDay ? 'account' : null;
  return count > limits.maxPerNetworkPerVideo ? 'network' : null;
}

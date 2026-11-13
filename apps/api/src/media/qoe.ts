import type { PrismaClient } from '@prisma/client';
import type Redis from 'ioredis';

/**
 * What viewers experience while playing (quality of experience), counted so it can be read per country, codec,
 * device and connection at any scale:
 *
 * - each playback sends one small summary when the viewer leaves (and every 5 minutes of a long one): time to the
 *   first frame, seconds played, how often and how long it stopped to load, the picture size shown, errors;
 * - the API only adds it to counters in one Redis hash per hour (no account, video or address is kept);
 * - the worker writes each finished hour to PostgreSQL (QoeHourly) in one statement, exactly once.
 *
 * Read back as: sessions, time to first frame (median and 90th percentile, from the histogram), rebuffering ratio
 * (time spent loading ÷ time watching), share of sessions that stopped at least once, average picture size,
 * error rate. These are the numbers that say whether a change (AV1, a new CDN, a bitrate ladder) helped viewers.
 */
export const STARTUP_BOUNDS_MS = [500, 1000, 2000, 3000, 5000, 8000, 15000];
export const CODECS = ['av1', 'h264', 'native', 'other'] as const;
export const DEVICES = ['phone', 'tablet', 'desktop', 'tv', 'other'] as const;
export const NETWORKS = ['slow-2g', '2g', '3g', '4g', 'unknown'] as const;
export const DIMENSIONS = ['country', 'codec', 'device', 'network'] as const;
export type Dimension = typeof DIMENSIONS[number];

export interface QoeSample {
  country: string; codec: typeof CODECS[number]; device: typeof DEVICES[number]; network: typeof NETWORKS[number];
  startupMs: number | null; playedSeconds: number; stalls: number; stallMs: number; shortSide: number; error: boolean;
  /** This report holds the session's first stall (a long session reports several times; it counts as stalled once). */
  firstStall: boolean;
}

const KEY = 'fm:qoe:';
const hourOf = (t: number) => new Date(Math.floor(t / 3_600_000) * 3_600_000);
const keyFor = (hour: Date) => `${KEY}${hour.toISOString()}`;
const FIELDS = ['n', 'b0', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'p', 'sc', 'sm', 'ss', 'q', 'e'] as const;

export function startupBucket(ms: number): number {
  const i = STARTUP_BOUNDS_MS.findIndex((b) => ms < b);
  return i < 0 ? STARTUP_BOUNDS_MS.length : i;
}

/** The counters one sample adds. `n` (sessions) only for a session's first report, so long plays count once. */
export function increments(s: QoeSample, first: boolean): Record<string, number> {
  const out: Record<string, number> = {};
  if (first) out.n = 1;
  if (s.startupMs !== null) out[`b${startupBucket(s.startupMs)}`] = 1;
  const played = Math.round(s.playedSeconds);
  if (played) { out.p = played; out.q = Math.round(played * s.shortSide); }
  if (s.stalls) { out.sc = s.stalls; out.sm = Math.round(s.stallMs); }
  if (s.firstStall) out.ss = 1;
  if (s.error) out.e = 1;
  return out;
}

export class QoeCounter {
  constructor(private readonly prisma: PrismaClient, private readonly redis: Redis | null) {}

  async record(s: QoeSample, first: boolean, now = Date.now()) {
    const add = increments(s, first);
    const dims = `${s.country}|${s.codec}|${s.device}|${s.network}`;
    if (!this.redis) { await this.write(hourOf(now), new Map([[dims, add]])); return; }
    const key = keyFor(hourOf(now));
    const m = this.redis.multi();
    for (const [f, v] of Object.entries(add)) m.hincrby(key, `${dims}|${f}`, v);
    await m.expire(key, 3 * 86_400).exec();
  }

  /**
   * Writes every finished hour to the database (the current hour stays in Redis and is read from there). Claimed by
   * renaming, written in one transaction recorded in CounterFlush, so a retry after a crash never adds twice.
   */
  async flush(now = Date.now()): Promise<number> {
    if (!this.redis) return 0;
    const current = keyFor(hourOf(now));
    const keys: string[] = [];
    let cursor = '0';
    do { const [next, found] = await this.redis.scan(cursor, 'MATCH', `${KEY}*`, 'COUNT', 200); cursor = next; keys.push(...found); } while (cursor !== '0');
    let hours = 0;
    for (const key of keys) {
      if (key === current) continue;
      let claimed = key;
      if (!key.includes(':flushing:')) {
        claimed = `${key}:flushing:${now}`;
        try { await this.redis.rename(key, claimed); } catch { continue; }
      } else if (now - Number(key.split(':flushing:')[1]) < 120_000) continue; // another worker is on it
      const hour = new Date(claimed.slice(KEY.length).split(':flushing:')[0]);
      const rows = parse(await this.redis.hgetall(claimed));
      await this.write(hour, rows, claimed);
      await this.redis.del(claimed);
      hours++;
    }
    return hours;
  }

  /** Counters per hour and dimensions, from the database and (for the current hour) Redis. */
  async read(since: Date, now = Date.now()) {
    const stored = await this.prisma.qoeHourly.findMany({ where: { hour: { gte: since } } });
    const rows: Array<{ hour: Date; country: string; codec: string; device: string; network: string; c: Record<string, number> }> = stored.map((r) => ({
      hour: r.hour, country: r.country, codec: r.codec, device: r.device, network: r.network,
      c: { n: r.sessions, ...Object.fromEntries(r.startupBuckets.map((v, i) => [`b${i}`, v])), p: Number(r.playedSeconds), sc: r.stalls, sm: Number(r.stallMs), ss: r.stalledSessions, q: Number(r.qualitySeconds), e: r.errors },
    }));
    if (this.redis) {
      const hour = hourOf(now);
      for (const [dims, c] of parse(await this.redis.hgetall(keyFor(hour)))) {
        const [country, codec, device, network] = dims.split('|');
        rows.push({ hour, country, codec, device, network, c });
      }
    }
    return rows;
  }

  private async write(hour: Date, rows: Map<string, Record<string, number>>, stamp?: string) {
    if (!rows.size) return;
    const list = [...rows].map(([dims, c]) => { const [country, codec, device, network] = dims.split('|'); return { country, codec, device, network, c }; });
    const col = (f: string) => list.map((r) => r.c[f] ?? 0);
    const buckets = list.map((r) => `{${[0, 1, 2, 3, 4, 5, 6, 7].map((i) => r.c[`b${i}`] ?? 0).join(',')}}`);
    await this.prisma.$transaction(async (tx) => {
      if (stamp && !(await tx.$executeRaw`INSERT INTO "CounterFlush" ("stamp") VALUES (${stamp}) ON CONFLICT DO NOTHING`)) return;
      await tx.$executeRaw`
        INSERT INTO "QoeHourly" ("hour", "country", "codec", "device", "network", "sessions", "startupBuckets", "playedSeconds", "stalls", "stallMs", "stalledSessions", "qualitySeconds", "errors")
        SELECT ${hour}, d.country, d.codec, d.device, d.network, d.n, d.b::int[], d.p, d.sc, d.sm, d.ss, d.q, d.e
        FROM unnest(${list.map((r) => r.country)}::text[], ${list.map((r) => r.codec)}::text[], ${list.map((r) => r.device)}::text[], ${list.map((r) => r.network)}::text[],
                    ${col('n')}::int[], ${buckets}::text[], ${col('p')}::bigint[], ${col('sc')}::int[], ${col('sm')}::bigint[], ${col('ss')}::int[], ${col('q')}::bigint[], ${col('e')}::int[])
          AS d(country, codec, device, network, n, b, p, sc, sm, ss, q, e)
        ON CONFLICT ("hour", "country", "codec", "device", "network") DO UPDATE SET
          "sessions" = "QoeHourly"."sessions" + EXCLUDED."sessions",
          "startupBuckets" = ARRAY(SELECT coalesce(a, 0) + coalesce(b, 0) FROM unnest("QoeHourly"."startupBuckets", EXCLUDED."startupBuckets") AS t(a, b)),
          "playedSeconds" = "QoeHourly"."playedSeconds" + EXCLUDED."playedSeconds", "stalls" = "QoeHourly"."stalls" + EXCLUDED."stalls",
          "stallMs" = "QoeHourly"."stallMs" + EXCLUDED."stallMs", "stalledSessions" = "QoeHourly"."stalledSessions" + EXCLUDED."stalledSessions",
          "qualitySeconds" = "QoeHourly"."qualitySeconds" + EXCLUDED."qualitySeconds", "errors" = "QoeHourly"."errors" + EXCLUDED."errors"`;
    });
  }
}

function parse(hash: Record<string, string>): Map<string, Record<string, number>> {
  const rows = new Map<string, Record<string, number>>();
  for (const [field, value] of Object.entries(hash)) {
    const i = field.lastIndexOf('|');
    const dims = field.slice(0, i); const f = field.slice(i + 1);
    if (!(FIELDS as readonly string[]).includes(f)) continue;
    const r = rows.get(dims) ?? {};
    r[f] = (r[f] ?? 0) + Number(value);
    rows.set(dims, r);
  }
  return rows;
}

/** The value below which a share `p` of sessions started, from the histogram (upper bound of that bucket, in ms). */
export function percentile(buckets: number[], p: number): number | null {
  const total = buckets.reduce((a, b) => a + b, 0);
  if (!total) return null;
  let seen = 0;
  for (let i = 0; i < buckets.length; i++) { seen += buckets[i]; if (seen >= total * p) return STARTUP_BOUNDS_MS[i] ?? 30_000; }
  return 30_000;
}

/** Adds up counters by one dimension (or all) and turns them into the numbers people read. */
export function summarise(rows: Array<{ country: string; codec: string; device: string; network: string; c: Record<string, number> }>, by: Dimension | null) {
  const groups = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const k = by ? r[by] : 'all';
    const g = groups.get(k) ?? {};
    for (const [f, v] of Object.entries(r.c)) g[f] = (g[f] ?? 0) + v;
    groups.set(k, g);
  }
  return [...groups].map(([key, c]) => {
    const buckets = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => c[`b${i}`] ?? 0);
    const playedMs = (c.p ?? 0) * 1000;
    return {
      key, sessions: c.n ?? 0,
      startupMedianMs: percentile(buckets, 0.5), startupP90Ms: percentile(buckets, 0.9),
      rebufferRatio: playedMs + (c.sm ?? 0) ? Math.round(((c.sm ?? 0) / (playedMs + (c.sm ?? 0))) * 10_000) / 10_000 : 0,
      stalledShare: c.n ? Math.round(((c.ss ?? 0) / c.n) * 1000) / 1000 : 0,
      averageShortSide: c.p ? Math.round((c.q ?? 0) / c.p) : null,
      errorRate: c.n ? Math.round(((c.e ?? 0) / c.n) * 10_000) / 10_000 : 0,
      hoursWatched: Math.round(((c.p ?? 0) / 3600) * 10) / 10,
    };
  }).sort((a, b) => b.sessions - a.sessions);
}

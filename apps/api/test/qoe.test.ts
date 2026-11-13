import Redis from 'ioredis';
import request from 'supertest';
import { makeApp, resetDb, signIn, WEB } from './helpers';
import { QoeCounter, increments, percentile, startupBucket, summarise } from '../src/media/qoe';

// Playback quality as viewers experience it: reported once per playback, counted per hour and per country, codec,
// device and connection, written to the database once an hour is over, readable by administrators.
describe('counting rules', () => {
  test('time to first frame goes into histogram buckets; percentiles come back from them', () => {
    expect([100, 600, 1500, 2500, 4000, 6000, 10_000, 40_000].map(startupBucket)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(percentile([0, 9, 0, 0, 0, 0, 1, 0], 0.5)).toBe(1000);
    expect(percentile([0, 9, 0, 0, 0, 0, 1, 0], 0.95)).toBe(15_000);
    expect(percentile([0, 0, 0, 0, 0, 0, 0, 0], 0.5)).toBeNull();
  });

  test('a long playback counts as one session and stalls once, however many times it reports', () => {
    const base = { country: 'RW', codec: 'h264' as const, device: 'phone' as const, network: '3g' as const, stallMs: 0, stalls: 0, shortSide: 360, error: false, firstStall: false };
    expect(increments({ ...base, startupMs: 900, playedSeconds: 300 }, true)).toEqual({ n: 1, b1: 1, p: 300, q: 108_000 });
    expect(increments({ ...base, startupMs: null, playedSeconds: 120, stalls: 2, stallMs: 3000, firstStall: true }, false)).toEqual({ p: 120, q: 43_200, sc: 2, sm: 3000, ss: 1 });
    expect(increments({ ...base, startupMs: null, playedSeconds: 60, stalls: 1, stallMs: 500 }, false)).toEqual({ p: 60, q: 21_600, sc: 1, sm: 500 });
  });

  test('the summary: rebuffering is loading time over watching time', () => {
    const [all] = summarise([{ country: 'RW', codec: 'av1', device: 'phone', network: '4g', c: { n: 4, b0: 2, b2: 2, p: 1000, sm: 10_000, ss: 1, q: 720_000, e: 1 } }], null);
    expect(all).toMatchObject({ sessions: 4, startupMedianMs: 500, startupP90Ms: 2000, rebufferRatio: 0.0099, stalledShare: 0.25, averageShortSide: 720, errorRate: 0.25 });
  });
});

describe('through the API', () => {
  let ctx: Awaited<ReturnType<typeof makeApp>>;
  let redis: Redis;
  beforeAll(async () => { ctx = await makeApp({ adminEmails: ['admin@example.com'] }); redis = new Redis(process.env.REDIS_URL!); });
  beforeEach(async () => { await resetDb(ctx.prisma); ctx.mail.outbox.length = 0; await ctx.clearLimits(); for (const k of await redis.keys('fm:qoe:*')) await redis.del(k); });
  afterAll(async () => { await redis.quit(); await ctx.app.close(); });

  async function video(visibility: 'PUBLIC' | 'PRIVATE' = 'PUBLIC') {
    const c = await signIn(ctx.http, ctx.mail, `maker-${visibility.toLowerCase()}@example.com`);
    const ch = (await c.agent.post('/api/channels').set('Origin', WEB).send({ handle: `maker${visibility.toLowerCase()}`, name: 'Maker' }).expect(201)).body.channel;
    return ctx.prisma.video.create({ data: { channelId: ch.id, title: 'V', durationSeconds: 600, status: 'READY', visibility, mediaLocation: 'PUBLIC', publishedAt: new Date(), hlsMasterKey: 'hls/master.m3u8' } });
  }
  const report = (id: string, body: Record<string, unknown>, country?: string) => {
    const r = request(ctx.http).post(`/api/videos/${id}/qoe`).set('Origin', WEB);
    if (country) r.set('cf-ipcountry', country);
    return r.send({ playedSeconds: 60, stalls: 0, stallMs: 0, shortSide: 360, codec: 'h264', device: 'phone', network: '3g', error: false, first: true, firstStall: false, ...body });
  };

  test('playbacks are counted per country and codec, and administrators read them back', async () => {
    const v = await video();
    await report(v.id, { startupMs: 800, codec: 'av1', shortSide: 720 }, 'RW').expect(200);
    await report(v.id, { startupMs: 6000, stalls: 3, stallMs: 6000, firstStall: true }, 'RW').expect(200);
    await report(v.id, { startupMs: 1200, error: true, playedSeconds: 0 }, 'KE').expect(200);
    await report(v.id, { codec: 'quicktime' }).expect(400);
    await report(v.id, { playedSeconds: 99_999 }).expect(400);
    const priv = await video('PRIVATE');
    await report(priv.id, {}).expect(404);

    const admin = await signIn(ctx.http, ctx.mail, 'admin@example.com');
    const byCountry = (await admin.agent.get('/api/admin/qoe?hours=24&by=country').expect(200)).body;
    expect(byCountry.total).toMatchObject({ sessions: 3, errorRate: 0.3333 });
    expect(byCountry.groups.map((g: any) => [g.key, g.sessions])).toEqual([['RW', 2], ['KE', 1]]);
    expect(byCountry.groups[0]).toMatchObject({ stalledShare: 0.5, startupP90Ms: 8000, averageShortSide: 540 });
    const byCodec = (await admin.agent.get('/api/admin/qoe?by=codec').expect(200)).body.groups;
    expect(byCodec.find((g: any) => g.key === 'av1')).toMatchObject({ sessions: 1, rebufferRatio: 0, averageShortSide: 720 });
    const fan = await signIn(ctx.http, ctx.mail, 'fan@example.com');
    await fan.agent.get('/api/admin/qoe').expect(403);
  });

  test('a finished hour is written to the database once, even when a worker stopped half-way', async () => {
    const counter = new QoeCounter(ctx.prisma as never, redis);
    const sample = { country: 'RW', codec: 'h264' as const, device: 'phone' as const, network: '4g' as const, startupMs: 700, playedSeconds: 100, stalls: 1, stallMs: 2000, shortSide: 480, error: false, firstStall: true };
    const twoHoursAgo = Date.now() - 2 * 3_600_000;
    await counter.record(sample, true, twoHoursAgo);
    await counter.record(sample, true, twoHoursAgo);
    await counter.record(sample, true); // this hour: stays in Redis
    expect(await counter.flush()).toBe(1);
    const rows = await ctx.prisma.qoeHourly.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ country: 'RW', sessions: 2, startupBuckets: [0, 2, 0, 0, 0, 0, 0, 0], playedSeconds: 200n, stalls: 2, stallMs: 4000n, stalledSessions: 2, qualitySeconds: 96_000n });
    // A batch claimed by a worker that stopped: taken again after two minutes, and only once.
    const hour = new Date(Math.floor(twoHoursAgo / 3_600_000) * 3_600_000).toISOString();
    const stale = `fm:qoe:${hour}:flushing:${Date.now() - 5 * 60_000}`;
    await redis.hset(stale, 'RW|h264|phone|4g|n', 3);
    await counter.flush();
    await redis.hset(stale, 'RW|h264|phone|4g|n', 3); // the same batch again (already written): only removed
    await counter.flush();
    expect((await ctx.prisma.qoeHourly.findFirstOrThrow()).sessions).toBe(5);
    // Reading merges the database with the current hour in Redis.
    const all = await counter.read(new Date(Date.now() - 24 * 3_600_000));
    expect(summarise(all, null)[0].sessions).toBe(6);
  });
});

import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { makeApp } from './helpers';

// Monitoring: /api/metrics speaks Prometheus to whoever holds METRICS_TOKEN, and is invisible to everyone else.
const TOKEN = 'metrics-token-0123456789-abcdefghij';
let ctx: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => { ctx = await makeApp({ env: { METRICS_TOKEN: TOKEN } }); }, 60_000);
afterAll(async () => { await ctx.app.close(); });

test('requires the token, and counts requests by route pattern (not by id)', async () => {
  await request(ctx.http).get('/api/metrics').expect(404);
  await request(ctx.http).get('/api/metrics').set('Authorization', 'Bearer wrong-token-0123456789-abcdefgh').expect(404);
  await request(ctx.http).get(`/api/videos/${randomUUID()}`).expect(404);
  const res = await request(ctx.http).get('/api/metrics').set('Authorization', `Bearer ${TOKEN}`).expect(200);
  expect(res.headers['content-type']).toContain('text/plain');
  expect(res.text).toMatch(/freeme_http_requests_total\{method="GET",route="\/api\/videos\/:id",status="404",service="api"\} 1/);
  expect(res.text).toContain('freeme_http_request_duration_seconds_bucket');
  expect(res.text).toContain('freeme_process_resident_memory_bytes');
  expect(res.text).toMatch(/freeme_videos_processing\{measure="count",service="api"\} \d+/);
  expect(res.text).toMatch(/freeme_videos_hd_pending\{service="api"\} \d+/);
  if (ctx.config.redisUrl) expect(res.text).toMatch(/freeme_media_queue_jobs\{queue="media",state="waiting",service="api"\} \d+/);
  expect(res.text).not.toContain('route="/api/metrics"');
});

test('turned off without a token; a short token is refused at start-up', async () => {
  const off = await makeApp();
  await request(off.http).get('/api/metrics').set('Authorization', 'Bearer anything-at-all-0123456789').expect(404);
  await off.app.close();
  await expect(makeApp({ env: { METRICS_TOKEN: 'short' } })).rejects.toThrow(/METRICS_TOKEN/);
});

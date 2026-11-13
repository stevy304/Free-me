import { PlaybackCounts } from '../../web/src/lib/playback-counts';

const settle = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
let now = 100;
let calls: Array<{ url: string; body: any }>;
let refuse = false;
beforeEach(() => {
  now = 100; calls = []; refuse = false;
  jest.spyOn(performance, 'now').mockImplementation(() => now);
  (global as any).window = { dispatchEvent: jest.fn() };
  (global as any).CustomEvent = class { constructor(public type: string, public options: unknown) {} };
  global.fetch = jest.fn(async (url: any, options: any) => {
    calls.push({ url, body: options.body ? JSON.parse(options.body) : null });
    return { ok: true, json: async () => url.endsWith('/play') ? { ticket: 'signed' } : url.endsWith('/views') ? refuse ? { counted: false, reason: 'too-soon' } : { counted: true } : { seconds: 30 } } as Response;
  });
});
afterEach(() => { jest.restoreAllMocks(); delete (global as any).window; delete (global as any).CustomEvent; });
async function advance(t: PlaybackCounts, from: number, to: number) {
  for (let i = from; i <= to; i++) { now += 1000; t.sample(i, 120, true); await settle(); }
}
test('accepted views continue sending watch time and flush the final partial interval', async () => {
  const t = new PlaybackCounts('video');
  await advance(t, 0, 70); await t.flush();
  expect(calls.filter((c) => c.url.endsWith('/views'))).toHaveLength(1);
  const initial = calls.find((c) => c.url.endsWith('/views'))!.body.watchedSeconds;
  const extra = calls.filter((c) => c.url.endsWith('/watch')).reduce((s, c) => s + c.body.watchedSeconds, 0);
  expect(initial + extra).toBe(70);
});
test('a rejected view retries instead of disabling counting for the playback', async () => {
  refuse = true; const t = new PlaybackCounts('video');
  await advance(t, 0, 32);
  expect(calls.some((c) => c.url.endsWith('/watch'))).toBe(false);
  refuse = false; await advance(t, 33, 38);
  expect(calls.filter((c) => c.url.endsWith('/views')).length).toBeGreaterThan(1);
  expect(calls.some((c) => c.url.endsWith('/watch'))).toBe(true);
});
test('seeking and paused positions cannot satisfy the view threshold', async () => {
  const t = new PlaybackCounts('video');
  t.sample(0, 120, true); now += 1000; t.sample(100, 120, true);
  for (let i = 0; i < 40; i++) { now += 1000; t.sample(100, 120, false); }
  await settle();
  expect(calls.filter((c) => c.url.endsWith('/views'))).toHaveLength(0);
});

import { PlaybackHealthController } from '../src/engagement/playback-health.controller';

const make = () => new PlaybackHealthController(
  { video: { findUnique: jest.fn().mockResolvedValue({ status: 'READY', visibility: 'PUBLIC', takenDownAt: null, channel: {} }) } } as never,
  { client: null } as never,
  { consume: jest.fn().mockResolvedValue(undefined) } as never,
);
const req = { ip: '127.0.0.1' } as never;

test('summarises observed durations and leaves unobserved metrics empty', async () => {
  const c = make();
  await c.record('video', { kind: 'startup', durationMs: 6000 }, null, req);
  await c.record('video', { kind: 'startup', durationMs: 2000 }, null, req);
  const result = await c.summary();
  expect(result.metrics).toEqual([
    { kind: 'startup', count: 2, medianMs: 2000, p95Ms: 6000 },
    { kind: 'buffer', count: 0, medianMs: null, p95Ms: null },
    { kind: 'recovery', count: 0, medianMs: null, p95Ms: null },
  ]);
  expect(result.storage).toBe('this server');
});

test('bounds memory and expires old samples', async () => {
  const c = make();
  const clock = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
  try {
    for (let i = 0; i < 1005; i++) await c.record('video', { kind: 'buffer', durationMs: i }, null, req);
    expect((await c.summary()).metrics[1].count).toBe(1000);
    clock.mockReturnValue(1_000_000 + 86_400_001);
    expect((await c.summary()).metrics.every((m) => m.count === 0)).toBe(true);
  } finally { clock.mockRestore(); }
});

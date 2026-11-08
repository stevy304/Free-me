import { midRollAt } from '../src/billing/ads.controller';

test.each([
  [false, 600, null, null],
  [true, 479, null, null],
  [true, 480, null, 240],
  [true, 600, 180, 180],
  [true, 480, 430, 240],
] as const)('resolves the mid-roll for ads=%s, duration=%s and manual=%s', (adsEnabled, durationSeconds, adBreakSeconds, expected) => {
  expect(midRollAt({ adsEnabled, durationSeconds, adBreakSeconds })).toBe(expected);
});

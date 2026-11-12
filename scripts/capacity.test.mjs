import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { estimateCapacity } from './capacity.mjs';

const pilot = JSON.parse(await readFile(new URL('../deploy/capacity.pilot.json', import.meta.url)));
test('100M users at 10 hours and 2 Mbps produce 900 PB per month', () => {
  const result = estimateCapacity({ ...pilot, monthlyUsers: 100_000_000 });
  assert.equal(result.traffic.deliveryGB, 900_000_000);
  assert.equal(result.monthlyUsd.delivery, 4_500_000);
});
test('pilot includes contingency and returns an exact total', () => {
  const result = estimateCapacity(pilot);
  assert.equal(result.monthlyUsd.subtotal, 454);
  assert.equal(result.monthlyUsd.total, 567.5);
});
test('zero viewing avoids division by zero', () => {
  assert.equal(estimateCapacity({ ...pilot, monthlyUsers: 0 }).costPerWatchedHourUsd, null);
});
test('rejects missing, negative, infinite, and nonnumeric assumptions', () => {
  for (const value of [undefined, -1, Infinity, '1000', NaN]) {
    assert.throws(() => estimateCapacity({ ...pilot, monthlyUsers: value }));
  }
  assert.throws(() => estimateCapacity({ ...pilot, peakMultiplier: 0.5 }));
});

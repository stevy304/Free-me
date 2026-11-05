import test from 'node:test';
import assert from 'node:assert/strict';
import { allocatePool, splitRevenue, splitProblem, PROPOSED_SPLIT, formatMoney } from '../src/revenue.ts';
import { handleProblem, normalizeHandle, normalizeEmail } from '../src/identity.ts';
import { COUNTRY_CODES, isCountryCode, countryName, currencyMinorDigits, isLanguageCode } from '../src/regions.ts';

test('revenue split: parts always add up to the gross amount, in any currency unit', () => {
  for (const gross of [0n, 1n, 7n, 99n, 1_000n, 123_456_789n, 10n ** 20n]) {
    const s = splitRevenue(gross);
    assert.equal(s.creatorPool + s.platform + s.reinvestment, gross);
  }
  assert.deepEqual(splitRevenue(1000n), { gross: 1000n, creatorPool: 600n, platform: 300n, reinvestment: 100n });
  assert.deepEqual(splitRevenue(7n), { gross: 7n, creatorPool: 4n, platform: 2n, reinvestment: 1n });
});

test('revenue split: configurable, and invalid splits are refused', () => {
  assert.deepEqual(splitRevenue(1000n, { creatorPoolBps: 7000, platformBps: 2500, reinvestmentBps: 500 }), { gross: 1000n, creatorPool: 700n, platform: 250n, reinvestment: 50n });
  assert.match(splitProblem({ creatorPoolBps: 6000, platformBps: 3000, reinvestmentBps: 500 })!, /100%/);
  assert.throws(() => splitRevenue(-1n), /negative/);
  assert.equal(splitProblem(PROPOSED_SPLIT), null);
});

test('pool allocation: proportional, every unit allocated, none created', () => {
  const out = allocatePool(100n, { a: 1n, b: 1n, c: 1n, idle: 0n });
  assert.equal(out.a + out.b + out.c + out.idle, 100n);
  assert.equal(out.idle, 0n);
  assert.deepEqual(Object.values(out).sort(), [0n, 33n, 33n, 34n].sort());
  assert.deepEqual(allocatePool(0n, { a: 5n }), { a: 0n });
  assert.deepEqual(allocatePool(10n, { a: 0n }), { a: 0n });
  const big = allocatePool(1_000_003n, { x: 600n, y: 300n, z: 100n });
  assert.equal(big.x + big.y + big.z, 1_000_003n);
});

test('money formatting respects each currency', () => {
  assert.equal(formatMoney(1250n, 'RWF', 'en'), 'RWF 1,250');
  assert.equal(formatMoney(1250n, 'USD', 'en'), '$12.50');
  assert.equal(currencyMinorDigits('KWD'), 3);
});

test('handles and emails', () => {
  assert.equal(normalizeHandle(' @Uwase.Music '), 'uwase.music');
  assert.equal(handleProblem('uwase.music'), null);
  assert.match(handleProblem('ab')!, /3 to 30/);
  assert.match(handleProblem('admin')!, /reserved/);
  assert.match(handleProblem('a..b')!, /next to each other/);
  assert.match(handleProblem('-abc')!, /starting and ending/);
  assert.equal(normalizeEmail(' Aline@Example.COM '), 'aline@example.com');
  assert.equal(normalizeEmail('not-an-email'), null);
});

test('countries and languages cover the world', () => {
  assert.equal(COUNTRY_CODES.length, 249);
  assert.ok(isCountryCode('RW') && isCountryCode('us') && isCountryCode('JP') && !isCountryCode('XX'));
  assert.equal(countryName('RW'), 'Rwanda');
  assert.ok(isLanguageCode('rw') && isLanguageCode('sw') && isLanguageCode('ja') && !isLanguageCode('xx'));
});

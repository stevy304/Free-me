import { adEconomics, adRevenuePolicy, splitRevenue } from '@free-me/shared';
import { loadConfig } from '../src/config/config';
import { effective } from '../src/billing/settings';
import { Billing } from '../src/billing/billing';

const config = (env: Record<string, string> = {}) => loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/test', SESSION_SECRET: 'test-session-secret-0123456789-abcdefghijklmnop', ...env });

test('new earning days pay 70% long-video and 60% Moments; earlier days keep their rates', () => {
  expect(adRevenuePolicy(new Date('2026-11-13T23:59:59.999Z'))).toMatchObject({ split: { creatorPoolBps: 6000 }, momentsCreatorBps: 4500 });
  const policy = adRevenuePolicy(new Date('2026-11-14T00:00:00Z'));
  expect(policy).toMatchObject({ split: { creatorPoolBps: 7000 }, momentsCreatorBps: 6000 });
  for (const gross of [0n, 1n, 7n, 100n, 100001n]) {
    const s = splitRevenue(gross, policy.split);
    expect(s.creatorPool + s.platform + s.reinvestment).toBe(gross);
  }
  expect(splitRevenue(10000n, policy.split)).toEqual({ gross: 10000n, creatorPool: 7000n, platform: 2000n, reinvestment: 1000n });
});

test('unknown costs remain explicitly unverified, with no invented profit', () => {
  expect(adEconomics(100)).toMatchObject({ status: 'UNVERIFIED_COSTS', effectiveCpmUsdCents: 100, minimumCpmUsdCents: null, estimatedMarginUsdCents: null });
  expect(effective(config(), {})).toMatchObject({ adCpmUsdCents: 100, adMinBudgetUsdCents: 200 });
});

test('price floor includes collection costs, all allocated costs and the target remainder; stored prices cannot bypass it', () => {
  const cfg = config({ AD_COST_PER_1000_USD_CENTS: '50', AD_PAYMENT_FEE_BPS: '600', AD_TARGET_MARGIN_BPS: '1000' });
  const b = effective(cfg, { adCpmUsdCents: 1 });
  expect(b.adCpmUsdCents).toBe(358); // 50 cents / (30% - 6% - 10%), rounded up.
  const economics = adEconomics(1, b.adEconomics);
  expect(economics.estimatedMarginUsdCents).toBeGreaterThanOrEqual(358 * 0.10);
  expect(effective(cfg, { adCpmUsdCents: 500 }).adCpmUsdCents).toBe(500);
  expect(effective(cfg, { adMinBudgetUsdCents: 300 }).adMinBudgetUsdCents).toBe(300);
});

test('invalid costs and impossible margin configurations are refused', () => {
  for (const value of ['-1', 'NaN', '1.5', 'Infinity', '10000001']) expect(() => config({ AD_COST_PER_1000_USD_CENTS: value })).toThrow();
  expect(() => config({ AD_PAYMENT_FEE_BPS: '2000', AD_TARGET_MARGIN_BPS: '1000' })).toThrow(/below 3000/);
  expect(() => adEconomics(0)).toThrow();
  expect(() => adEconomics(100, { costPer1000UsdCents: NaN, paymentFeeBps: 0, targetMarginBps: 0 })).toThrow();
  expect(() => adEconomics(100, { costPer1000UsdCents: 10_000_000, paymentFeeBps: 2999, targetMarginBps: 0 })).toThrow(/price limit/);
});

const day = new Date('2026-11-14T00:00:00Z');
const campaign = (id: string, cpmRateCents = 100, dailyRateCents = 100) => ({ id, cpmRateCents, dailyRateCents, budgetAmountCents: 10000n, startDate: day, endDate: new Date('2026-11-15T00:00:00Z') });

test('settlement pays each campaign’s own hosts at its rate; free house ads never enter the paid pool', async () => {
  const query = jest.fn()
    .mockResolvedValueOnce([{ campaignId: 'cheap', before: 0n, today: 1000n }, { campaignId: 'premium', before: 0n, today: 1000n }])
    .mockResolvedValueOnce([{ campaignId: 'cheap', all: 1000n, moments: 0n }, { campaignId: 'premium', all: 1000n, moments: 0n }])
    .mockResolvedValueOnce([{ campaignId: 'cheap', channelId: 'alice', n: 1000n }, { campaignId: 'premium', channelId: 'bob', n: 1000n }]);
  const prisma = { campaign: { findMany: jest.fn().mockResolvedValue([campaign('cheap'), campaign('premium', 200), campaign('house', 0, 0)]) }, $queryRaw: query };
  const result = await new Billing(prisma as never, config()).adDayShares(day);
  expect(result.gross).toBe(300n);
  expect(result.shares).toEqual({ alice: 70n, bob: 140n });
  expect(result.split).toEqual({ gross: 300n, creatorPool: 210n, platform: 60n, reinvestment: 30n });
  expect(query.mock.calls.flat(2)).not.toContain('house');
});

test('Moments gets 60% of its own campaign revenue, rather than a share diluted by other CPMs', async () => {
  const query = jest.fn()
    .mockResolvedValueOnce([{ campaignId: 'long', before: 0n, today: 1000n }, { campaignId: 'moments', before: 0n, today: 1000n }])
    .mockResolvedValueOnce([{ campaignId: 'long', all: 1000n, moments: 0n }, { campaignId: 'moments', all: 1000n, moments: 1000n }])
    .mockResolvedValueOnce([{ campaignId: 'long', channelId: 'alice', n: 1000n }])
    .mockResolvedValueOnce([{ channelId: 'bob', views: 3n }, { channelId: 'carol', views: 1n }]);
  const prisma = { campaign: { findMany: jest.fn().mockResolvedValue([campaign('long'), campaign('moments', 200)]) }, $queryRaw: query };
  const r = await new Billing(prisma as never, config()).adDayShares(day);
  expect(r.gross).toBe(300n);
  expect(r.shares).toEqual({ alice: 70n });
  expect(r.moments).toMatchObject({ gross: 200n, pool: 120n, shares: { bob: 90n, carol: 30n } });
});

test('expired undelivered funds never become revenue, and actual revenue cannot exceed the campaign budget', async () => {
  const c = { ...campaign('expired'), budgetAmountCents: 100n, endDate: new Date('2026-11-14T12:00:00Z'), deliverUntil: new Date('2026-11-14T12:00:00Z') };
  for (const [today, expected] of [[0n, 0n], [2000n, 100n]]) {
    const query = jest.fn().mockResolvedValueOnce([{ campaignId: c.id, before: 0n, today }]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const prisma = { campaign: { findMany: jest.fn().mockResolvedValue([c]) }, $queryRaw: query };
    const r = await new Billing(prisma as never, config()).adDayShares(day);
    expect(r.gross).toBe(expected);
    expect(r.shares).toEqual({});
  }
});

import { PROPOSED_SPLIT, type RevenueSplitConfig } from './revenue.js';

/** UTC earning-day boundary: historical days keep their original policy. */
export const CREATOR_FIRST_FROM = '2026-11-14';
export const CREATOR_FIRST_SPLIT: RevenueSplitConfig = { creatorPoolBps: 7000, platformBps: 2000, reinvestmentBps: 1000 };
export function adRevenuePolicy(day = new Date()) {
  if (!Number.isFinite(day.getTime())) throw new Error('Invalid earning day.');
  const current = day.toISOString().slice(0, 10) >= CREATOR_FIRST_FROM;
  return { split: current ? CREATOR_FIRST_SPLIT : PROPOSED_SPLIT, momentsCreatorBps: current ? 6000 : 4500 };
}

export interface AdCostModel {
  /** All non-percentage costs per 1,000 PAID impressions: include unfilled viewing, storage,
   * encoding, delivery, payout fees, moderation, support and allocated fixed overhead. Null = unknown. */
  costPer1000UsdCents: number | null;
  /** Conservative effective collection fee, including applicable fee taxes. */
  paymentFeeBps: number;
  /** Desired remaining margin as a fraction of gross media revenue. An estimate, never a guarantee. */
  targetMarginBps: number;
}

export const DEFAULT_AD_COST_MODEL: AdCostModel = { costPer1000UsdCents: null, paymentFeeBps: 600, targetMarginBps: 1000 };

/** Keeps starter budgets small; raises the unit price only when supplied costs require it.
 * Use the larger creator share (long video), so the floor also covers Moments. */
export function adEconomics(requestedCpmUsdCents: number, model: AdCostModel = DEFAULT_AD_COST_MODEL) {
  const { costPer1000UsdCents: cost, paymentFeeBps, targetMarginBps } = model;
  const parts = [requestedCpmUsdCents, paymentFeeBps, targetMarginBps];
  if (parts.some((n) => !Number.isSafeInteger(n)) || requestedCpmUsdCents < 1 || requestedCpmUsdCents > 10_000_000
    || paymentFeeBps < 0 || targetMarginBps < 0 || (cost !== null && (!Number.isSafeInteger(cost) || cost < 0 || cost > 10_000_000))) {
    throw new Error('Ad prices and costs must be whole, nonnegative cents or basis points.');
  }
  const retainedBps = 10_000 - CREATOR_FIRST_SPLIT.creatorPoolBps;
  const roomBps = retainedBps - paymentFeeBps - targetMarginBps;
  if (roomBps <= 0) throw new Error('Collection fees and target margin must leave room within Free Me’s 30% share.');
  const floor = cost === null ? null : Math.ceil(cost * 10_000 / roomBps);
  if (floor !== null && floor > 10_000_000) throw new Error('The cost model requires a CPM above the supported price limit.');
  const cpm = Math.max(requestedCpmUsdCents, floor ?? 0);
  return {
    status: cost === null ? 'UNVERIFIED_COSTS' as const : 'MODELLED' as const,
    requestedCpmUsdCents, effectiveCpmUsdCents: cpm, minimumCpmUsdCents: floor,
    costPer1000UsdCents: cost, paymentFeeBps, targetMarginBps,
    retainedBeforeCostsUsdCents: cpm * retainedBps / 10_000,
    estimatedMarginUsdCents: cost === null ? null : cpm * (retainedBps - paymentFeeBps) / 10_000 - cost,
    // The reinvestment allocation is inside Free Me's retained share, not an additional creator deduction.
    includesReinvestment: true,
  };
}

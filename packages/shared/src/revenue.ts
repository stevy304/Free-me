/**
 * Advertising revenue split. Amounts are integers in a currency's minor unit (cents, or whole francs for RWF) as
 * bigint, so nothing is lost to floating point. Shares are basis points (10,000 = 100%), set by administrators and
 * disclosed to creators. The parts always add up to the gross amount exactly: the last share takes the remainder.
 */

export interface RevenueSplitConfig {
  /** Basis points of eligible ad revenue that go to the creator pool (6,000 = 60%). */
  creatorPoolBps: number;
  /** Basis points for platform operations. */
  platformBps: number;
  /** Basis points for reinvestment; creatorPoolBps + platformBps + reinvestmentBps must equal 10,000. */
  reinvestmentBps: number;
}

/** Historical launch split (60 / 30 / 10). Current advertising uses adRevenuePolicy(day); each ledger entry records its earning-day split. */
export const PROPOSED_SPLIT: RevenueSplitConfig = { creatorPoolBps: 6000, platformBps: 3000, reinvestmentBps: 1000 };

export function splitProblem(c: RevenueSplitConfig): string | null {
  const parts = [c.creatorPoolBps, c.platformBps, c.reinvestmentBps];
  if (parts.some((p) => !Number.isInteger(p) || p < 0 || p > 10_000)) return 'Each share is a whole number of basis points between 0 and 10,000.';
  if (parts.reduce((a, b) => a + b, 0) !== 10_000) return 'The three shares must add up to 100%.';
  return null;
}

export interface RevenueSplit { gross: bigint; creatorPool: bigint; platform: bigint; reinvestment: bigint }

/** Splits a gross amount (minor units). Rounds the first two shares down; reinvestment takes the remainder. */
export function splitRevenue(gross: bigint, config: RevenueSplitConfig = PROPOSED_SPLIT): RevenueSplit {
  const problem = splitProblem(config);
  if (problem) throw new Error(problem);
  if (gross < 0n) throw new Error('A gross amount cannot be negative.');
  const creatorPool = (gross * BigInt(config.creatorPoolBps)) / 10_000n;
  const platform = (gross * BigInt(config.platformBps)) / 10_000n;
  return { gross, creatorPool, platform, reinvestment: gross - creatorPool - platform };
}

/**
 * Shares a creator pool between channels in proportion to their weights (e.g. valid monetized watch seconds),
 * largest-remainder method: every minor unit is allocated, none created. Weights of 0 get nothing.
 */
export function allocatePool(pool: bigint, weights: Record<string, bigint>): Record<string, bigint> {
  if (pool < 0n) throw new Error('A pool cannot be negative.');
  const entries = Object.entries(weights).filter(([, w]) => w > 0n);
  const total = entries.reduce((a, [, w]) => a + w, 0n);
  const out: Record<string, bigint> = Object.fromEntries(Object.keys(weights).map((k) => [k, 0n]));
  if (!total || !pool) return out;
  let given = 0n;
  const rest: Array<[string, bigint]> = [];
  for (const [k, w] of entries) {
    const share = (pool * w) / total;
    out[k] = share;
    given += share;
    rest.push([k, (pool * w) % total]);
  }
  rest.sort((a, b) => (a[1] === b[1] ? a[0].localeCompare(b[0]) : a[1] > b[1] ? -1 : 1));
  for (let i = 0; given < pool; i++, given++) out[rest[i % rest.length][0]] += 1n;
  return out;
}

/** Formats minor units for display in the reader's locale ("1,250 RWF", "$12.50"). */
export function formatMoney(minor: bigint, currency: string, locale = 'en'): string {
  const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  const neg = minor < 0n;
  const abs = neg ? -minor : minor;
  const unit = 10n ** BigInt(digits);
  const whole = abs / unit;
  const frac = abs % unit;
  const value = `${neg ? '-' : ''}${whole}${digits ? `.${frac.toString().padStart(digits, '0')}` : ''}`;
  return new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value as unknown as number);
}

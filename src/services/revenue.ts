/**
 * Free Me — Creator Revenue Sharing & Financial Ledger Engine
 * Enforces strict auditable invariants:
 * - 60% Creator Pool
 * - 30% Platform Operations
 * - 10% Reinvestment Fund
 */

import { PlatformSettings, RevenueLedgerEntry, CreatorBalance, PayoutRequest } from '../types';

export const DEFAULT_PLATFORM_SETTINGS: PlatformSettings = {
  creatorPoolPercent: 60,
  platformOpsPercent: 30,
  reinvestmentPercent: 10,
  minPayoutThresholdRwf: 10000, // 10,000 RWF (~$7.60 USD)
  exchangeRateRwfPerUsd: 1320,  // 1 USD = 1,320 RWF
  monetizationSubsRequired: 1000,
  monetizationHoursRequired: 4000,
};

export interface RevenueSplitResult {
  grossAmountRwf: number;
  creatorShareRwf: number;
  platformShareRwf: number;
  reinvestShareRwf: number;
  isValid: boolean;
}

/**
 * Calculates and validates the 60/30/10 split on gross ad revenue.
 * Ensures the sum of parts exactly equals the gross amount with integer rounding discipline.
 */
export function calculateRevenueSplit(
  grossAmountRwf: number,
  settings: PlatformSettings = DEFAULT_PLATFORM_SETTINGS
): RevenueSplitResult {
  if (grossAmountRwf <= 0) {
    return {
      grossAmountRwf: 0,
      creatorShareRwf: 0,
      platformShareRwf: 0,
      reinvestShareRwf: 0,
      isValid: true,
    };
  }

  const creatorShareRwf = Math.round((grossAmountRwf * settings.creatorPoolPercent) / 100);
  const platformShareRwf = Math.round((grossAmountRwf * settings.platformOpsPercent) / 100);
  // Reinvestment takes the remainder to eliminate rounding drift
  const reinvestShareRwf = grossAmountRwf - creatorShareRwf - platformShareRwf;

  const isValid = (creatorShareRwf + platformShareRwf + reinvestShareRwf) === grossAmountRwf;

  return {
    grossAmountRwf,
    creatorShareRwf,
    platformShareRwf,
    reinvestShareRwf,
    isValid,
  };
}

/**
 * Calculates earnings for a given count of monetized video views based on Campaign CPM.
 * Formula: (Views / 1000) * CPM * CreatorSharePercent
 */
export function calculateEstimatedCreatorEarnings(
  monetizedViews: number,
  cpmRateRwf: number,
  settings: PlatformSettings = DEFAULT_PLATFORM_SETTINGS
): number {
  if (monetizedViews <= 0 || cpmRateRwf <= 0) return 0;
  const gross = (monetizedViews / 1000) * cpmRateRwf;
  return Math.round((gross * settings.creatorPoolPercent) / 100);
}

/**
 * Converts Rwandan Francs (RWF) to United States Dollars (USD)
 */
export function rwfToUsd(amountRwf: number, rate: number = DEFAULT_PLATFORM_SETTINGS.exchangeRateRwfPerUsd): number {
  return amountRwf / rate;
}

/**
 * Formats currency values cleanly with tabular figures
 */
export function formatCurrency(
  amountRwf: number,
  currency: 'RWF' | 'USD' = 'RWF',
  rate: number = DEFAULT_PLATFORM_SETTINGS.exchangeRateRwfPerUsd
): string {
  if (currency === 'USD') {
    const usd = rwfToUsd(amountRwf, rate);
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(usd);
  }

  return `${new Intl.NumberFormat('en-RW', {
    maximumFractionDigits: 0,
  }).format(amountRwf)} RWF`;
}

/**
 * Validates payout request eligibility against minimum threshold and confirmed balance.
 */
export function validatePayoutRequest(
  amountRwf: number,
  balance: CreatorBalance,
  settings: PlatformSettings = DEFAULT_PLATFORM_SETTINGS
): { allowed: boolean; reason?: string } {
  if (amountRwf < settings.minPayoutThresholdRwf) {
    return {
      allowed: false,
      reason: `Minimum payout threshold is ${formatCurrency(settings.minPayoutThresholdRwf, 'RWF')}.`,
    };
  }

  if (amountRwf > balance.confirmedBalanceRwf) {
    return {
      allowed: false,
      reason: `Insufficient confirmed balance. You have ${formatCurrency(balance.confirmedBalanceRwf, 'RWF')} available.`,
    };
  }

  return { allowed: true };
}

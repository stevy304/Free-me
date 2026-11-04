/**
 * Free Me — Unit Tests for Revenue Sharing & Payout Invariants
 * Verifies exact 60% Creator / 30% Platform / 10% Reinvestment distribution
 */

import {
  calculateRevenueSplit,
  calculateEstimatedCreatorEarnings,
  validatePayoutRequest,
  DEFAULT_PLATFORM_SETTINGS,
  formatCurrency,
} from '../services/revenue';
import { CreatorBalance } from '../types';

export function runRevenueTests() {
  const results: { name: string; passed: boolean; message?: string }[] = [];

  function assert(condition: boolean, name: string, message?: string) {
    results.push({
      name,
      passed: condition,
      message: condition ? undefined : message || 'Assertion failed',
    });
  }

  // Test 1: Standard 60/30/10 split on RWF 100,000
  const split100k = calculateRevenueSplit(100000, DEFAULT_PLATFORM_SETTINGS);
  assert(
    split100k.creatorShareRwf === 60000,
    'Creator Share 60% of 100,000 RWF',
    `Expected 60000, got ${split100k.creatorShareRwf}`
  );
  assert(
    split100k.platformShareRwf === 30000,
    'Platform Share 30% of 100,000 RWF',
    `Expected 30000, got ${split100k.platformShareRwf}`
  );
  assert(
    split100k.reinvestShareRwf === 10000,
    'Reinvestment Share 10% of 100,000 RWF',
    `Expected 10000, got ${split100k.reinvestShareRwf}`
  );
  assert(
    split100k.isValid,
    'Zero-Leakage Invariant: Sum of shares strictly equals gross amount',
    'Sum of shares did not match gross amount'
  );

  // Test 2: Odd amount rounding discipline (e.g. 12,345 RWF)
  const splitOdd = calculateRevenueSplit(12345, DEFAULT_PLATFORM_SETTINGS);
  const sumOdd = splitOdd.creatorShareRwf + splitOdd.platformShareRwf + splitOdd.reinvestShareRwf;
  assert(
    sumOdd === 12345,
    'Odd Amount Invariant: Sum of integer allocations equals gross with zero drift',
    `Sum ${sumOdd} != 12345`
  );

  // Test 3: Estimated creator earnings from CPM (10,000 views at 6,500 RWF CPM)
  // Gross: (10,000 / 1,000) * 6,500 = 65,000 RWF. Creator (60%): 39,000 RWF.
  const creatorEarnings = calculateEstimatedCreatorEarnings(10000, 6500, DEFAULT_PLATFORM_SETTINGS);
  assert(
    creatorEarnings === 39000,
    'Creator CPM Earnings Calculation',
    `Expected 39000, got ${creatorEarnings}`
  );

  // Test 4: Payout validation below minimum threshold (10,000 RWF)
  const mockBalance: CreatorBalance = {
    channelId: 'chan_test',
    pendingBalanceRwf: 20000,
    confirmedBalanceRwf: 50000,
    lifetimeEarningsRwf: 70000,
    withdrawnRwf: 0,
  };

  const belowMinCheck = validatePayoutRequest(5000, mockBalance, DEFAULT_PLATFORM_SETTINGS);
  assert(
    belowMinCheck.allowed === false,
    'Reject Payout Below Minimum Threshold (5,000 RWF < 10,000 RWF)',
    'Should have rejected payout below threshold'
  );

  // Test 5: Payout validation above confirmed balance
  const aboveBalanceCheck = validatePayoutRequest(60000, mockBalance, DEFAULT_PLATFORM_SETTINGS);
  assert(
    aboveBalanceCheck.allowed === false,
    'Reject Payout Exceeding Confirmed Balance (60,000 RWF > 50,000 RWF)',
    'Should have rejected payout exceeding confirmed balance'
  );

  // Test 6: Valid payout
  const validCheck = validatePayoutRequest(25000, mockBalance, DEFAULT_PLATFORM_SETTINGS);
  assert(
    validCheck.allowed === true,
    'Allow Valid Payout (25,000 RWF)',
    'Should have allowed valid payout request'
  );

  return results;
}

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runRevenueTests } from '../src/tests/revenue.test';

for (const result of runRevenueTests()) {
  test(result.name, () => {
    assert.equal(result.passed, true, result.message);
  });
}

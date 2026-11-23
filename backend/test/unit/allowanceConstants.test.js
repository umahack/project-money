import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LARGE_ENTRY_FLOOR_MINOR,
  LARGE_ENTRY_PERCENT,
} from '../../src/domain/allowance.js';
import { divideHalfUp } from '../../src/domain/money.js';

test('the Large_Entry constants are 25 percent and a floor of one thousand rupees in paise', () => {
  assert.equal(LARGE_ENTRY_PERCENT, 25);
  assert.equal(LARGE_ENTRY_FLOOR_MINOR, 1000 * 100);
  assert.equal(Number.isSafeInteger(LARGE_ENTRY_FLOOR_MINOR), true);
});

test('the constants combine with the existing half-up division for a threshold', () => {
  // 25 percent of 10,000.01 rupees is 2,500.0025 rupees, which rounds to 250,000 paise.
  assert.equal(divideHalfUp(1_000_001 * LARGE_ENTRY_PERCENT, 100), 250_000);
  // Half a paise rounds upward: 25 percent of 0.02 rupees is 0.5 paise.
  assert.equal(divideHalfUp(2 * LARGE_ENTRY_PERCENT, 100), 1);
});

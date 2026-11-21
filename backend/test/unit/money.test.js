import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MONEY_FORMAT_METADATA,
  adjustRemainder,
  assertSafePaise,
  createRoundingMetadata,
  divideCeil,
  divideCeilWithMetadata,
  divideHalfUp,
  divideHalfUpWithMetadata,
  legacyNumberToPaise,
  parseDecimalToPaise,
  sumPaise,
} from '../../src/domain/money.js';

test('money formatting metadata identifies INR paise precision', () => {
  assert.deepEqual(MONEY_FORMAT_METADATA, {
    currency: 'INR',
    minorUnit: 'paise',
    minorUnitsPerMajor: 100,
    fractionDigits: 2,
    precisionMinor: 1,
  });
  assert.equal(Object.isFrozen(MONEY_FORMAT_METADATA), true);
});

test('parseDecimalToPaise parses plain decimal strings without floating-point arithmetic', () => {
  assert.equal(parseDecimalToPaise('0'), 0);
  assert.equal(parseDecimalToPaise('12'), 1_200);
  assert.equal(parseDecimalToPaise('12.3'), 1_230);
  assert.equal(parseDecimalToPaise('0012.34'), 1_234);
  assert.equal(parseDecimalToPaise('90071992547409.91'), Number.MAX_SAFE_INTEGER);
  assert.equal(parseDecimalToPaise('-12.34', { allowNegative: true }), -1_234);
});

test('parseDecimalToPaise rejects ambiguous, over-precise, negative, and unsafe inputs', () => {
  for (const invalid of ['', ' 1.00', '1.00 ', '.50', '1.', '1.001', '1e2', '1,000']) {
    assert.throws(() => parseDecimalToPaise(invalid), /plain decimal notation/);
  }

  assert.throws(() => parseDecimalToPaise(12.34), /decimal string/);
  assert.throws(() => parseDecimalToPaise('-0.01'), /must not be negative/);
  assert.throws(
    () => parseDecimalToPaise('90071992547409.92'),
    /safe integer number of paise/
  );
});

test('legacyNumberToPaise normalizes one representable source value and rejects unsafe values', () => {
  assert.equal(legacyNumberToPaise(12), 1_200);
  assert.equal(legacyNumberToPaise(12.3), 1_230);
  assert.equal(legacyNumberToPaise(12.34), 1_234);
  assert.equal(legacyNumberToPaise(-0.01, { allowNegative: true }), -1);

  for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => legacyNumberToPaise(invalid));
  }
  assert.throws(() => legacyNumberToPaise(1.234), /at most two fraction digits/);
  assert.throws(() => legacyNumberToPaise(-1), /must not be negative/);
});

test('safe paise validation and summation reject fractional or unsafe canonical values', () => {
  assert.equal(assertSafePaise(-1), -1);
  assert.equal(sumPaise([Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER, 15]), 15);
  assert.equal(sumPaise([]), 0);

  assert.throws(() => assertSafePaise(1.5), /safe integer/);
  assert.throws(() => assertSafePaise(-1, { allowNegative: false }), /must not be negative/);
  assert.throws(() => sumPaise([Number.MAX_SAFE_INTEGER, 1]), /safe integer/);
  assert.throws(() => sumPaise([1, -1], { allowNegative: false }), /must not be negative/);
});

test('divideHalfUp rounds exact integer ratios and half units deterministically', () => {
  assert.equal(divideHalfUp(4, 2), 2);
  assert.equal(divideHalfUp(4, 3), 1);
  assert.equal(divideHalfUp(5, 3), 2);
  assert.equal(divideHalfUp(1, 2), 1);
  assert.equal(divideHalfUp(-1, 2), -1);
  assert.equal(divideHalfUp(-4, 3), -1);

  assert.throws(() => divideHalfUp(1, 0), /positive safe integer/);
  assert.throws(() => divideHalfUp(1, 1.5), /positive safe integer/);
});

test('divideCeil rounds positive fractional paise upward', () => {
  assert.equal(divideCeil(0, 3), 0);
  assert.equal(divideCeil(4, 2), 2);
  assert.equal(divideCeil(5, 2), 3);

  assert.throws(() => divideCeil(-1, 2), /must not be negative/);
  assert.throws(() => divideCeil(1, 0), /positive safe integer/);
});

test('division helpers provide explanation-ready rounding metadata', () => {
  assert.deepEqual(divideHalfUpWithMetadata(5, 2), {
    amountMinor: 3,
    rounding: { precisionMinor: 1, direction: 'half_up', adjustmentMinor: 0 },
  });
  assert.deepEqual(divideHalfUpWithMetadata(4, 2), {
    amountMinor: 2,
    rounding: { precisionMinor: 1, direction: 'exact', adjustmentMinor: 0 },
  });
  assert.deepEqual(divideCeilWithMetadata(5, 2), {
    amountMinor: 3,
    rounding: { precisionMinor: 1, direction: 'up', adjustmentMinor: 0 },
  });
  assert.deepEqual(createRoundingMetadata({
    direction: 'half_up',
    adjustmentMinor: -1,
    adjustmentTarget: 'savingsTarget',
  }), {
    precisionMinor: 1,
    direction: 'half_up',
    adjustmentMinor: -1,
    adjustmentTarget: 'savingsTarget',
  });
});

test('adjustRemainder conserves totals in deterministic order without mutating inputs', () => {
  const amounts = [1, 1, 1];
  const increased = adjustRemainder(amounts, 5, {
    adjustmentTarget: 'tripAllocation',
  });

  assert.deepEqual(amounts, [1, 1, 1]);
  assert.deepEqual(increased, {
    amounts: [2, 2, 1],
    adjustments: [1, 1, 0],
    rounding: {
      precisionMinor: 1,
      direction: 'half_up',
      adjustmentMinor: 2,
      adjustmentTarget: 'tripAllocation',
    },
  });

  assert.deepEqual(adjustRemainder([1, 1, 1], 1).amounts, [0, 0, 1]);
  assert.deepEqual(adjustRemainder([0, 3], 1).amounts, [0, 1]);
  assert.deepEqual(
    adjustRemainder([1, 1, 1], 5, { order: [2, 0, 1] }).amounts,
    [2, 1, 2]
  );
});

test('adjustRemainder validates totals, order, and explanation metadata', () => {
  assert.deepEqual(adjustRemainder([], 0), {
    amounts: [],
    adjustments: [],
    rounding: { precisionMinor: 1, direction: 'exact', adjustmentMinor: 0 },
  });
  assert.throws(() => adjustRemainder([], 1), /empty amount list/);
  assert.throws(() => adjustRemainder([1, -1], 0), /must not be negative/);
  assert.throws(() => adjustRemainder([1, 1], 2, { order: [0, 0] }), /exactly once/);
  assert.throws(
    () => createRoundingMetadata({ direction: 'nearest' }),
    /exact, half_up, or up/
  );
});

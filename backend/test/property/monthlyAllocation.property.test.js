import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {
  FINANCIAL_CLARITY_TIME_ZONE,
  calculateMonthlyPlan,
} from '../../src/domain/monthlyPlan.js';

const MONTH = '2026-06';
const LOCAL_DATE = '2026-06-15';
const NUM_RUNS = 150;

function roundRatioHalfUp(amountMinor, numerator, denominator) {
  const scaledTwice = BigInt(amountMinor) * BigInt(numerator) * 2n;
  return Number((scaledTwice + BigInt(denominator)) / (BigInt(denominator) * 2n));
}

function referenceAllocation(salaryMinor, activeBillAmounts) {
  const activeBillsTotalMinor = activeBillAmounts.reduce(
    (total, amountMinor) => total + amountMinor,
    0
  );
  const disposableIncomeMinor = Math.max(0, salaryMinor - activeBillsTotalMinor);
  const shortfallMinor = Math.max(0, activeBillsTotalMinor - salaryMinor);
  const needsBudgetMinor = roundRatioHalfUp(disposableIncomeMinor, 1, 2);
  const wantsBudgetMinor = roundRatioHalfUp(disposableIncomeMinor, 3, 10);
  const independentlyRoundedSavingsMinor = roundRatioHalfUp(
    disposableIncomeMinor,
    1,
    5
  );
  const savingsTargetMinor = disposableIncomeMinor - needsBudgetMinor - wantsBudgetMinor;

  return {
    activeBillsTotalMinor,
    disposableIncomeMinor,
    shortfallMinor,
    needsBudgetMinor,
    wantsBudgetMinor,
    independentlyRoundedSavingsMinor,
    savingsTargetMinor,
    spendableBudgetMinor: needsBudgetMinor + wantsBudgetMinor,
  };
}

function expectedRatioDirection(amountMinor, numerator, denominator) {
  return (BigInt(amountMinor) * BigInt(numerator)) % BigInt(denominator) === 0n
    ? 'exact'
    : 'half_up';
}

function assertScenario({ salaryMinor, bills, activeBillIds, activeBillAmounts }) {
  const result = calculateMonthlyPlan({
    month: MONTH,
    localDate: LOCAL_DATE,
    timeZone: FINANCIAL_CLARITY_TIME_ZONE,
    salaryEntries: [{ id: 1, month: MONTH, amountMinor: salaryMinor }],
    bills,
    expenses: [],
    categoryTreatments: [],
  });
  const expected = referenceAllocation(salaryMinor, activeBillAmounts);
  const savingsAdjustmentMinor =
    expected.savingsTargetMinor - expected.independentlyRoundedSavingsMinor;

  assert.equal(result.activeBillsTotalMinor, expected.activeBillsTotalMinor);
  assert.deepEqual(result.activeBillIds, activeBillIds);
  assert.equal(result.disposableIncomeMinor, expected.disposableIncomeMinor);
  assert.equal(result.shortfallMinor, expected.shortfallMinor);
  assert.equal(result.needsBudgetMinor, expected.needsBudgetMinor);
  assert.equal(result.wantsBudgetMinor, expected.wantsBudgetMinor);
  assert.equal(result.savingsTargetMinor, expected.savingsTargetMinor);
  assert.equal(result.spendableBudgetMinor, expected.spendableBudgetMinor);

  for (const amountMinor of [
    result.needsBudgetMinor,
    result.wantsBudgetMinor,
    result.savingsTargetMinor,
    result.spendableBudgetMinor,
  ]) {
    assert.equal(Number.isSafeInteger(amountMinor), true);
    assert.ok(amountMinor >= 0);
    assert.ok(amountMinor <= result.disposableIncomeMinor);
  }

  assert.equal(
    result.needsBudgetMinor + result.wantsBudgetMinor + result.savingsTargetMinor,
    result.disposableIncomeMinor
  );
  assert.equal(
    result.spendableBudgetMinor,
    result.needsBudgetMinor + result.wantsBudgetMinor
  );
  assert.deepEqual(result.rounding.needsBudget, {
    precisionMinor: 1,
    direction: expectedRatioDirection(expected.disposableIncomeMinor, 1, 2),
    adjustmentMinor: 0,
  });
  assert.deepEqual(result.rounding.wantsBudget, {
    precisionMinor: 1,
    direction: expectedRatioDirection(expected.disposableIncomeMinor, 3, 10),
    adjustmentMinor: 0,
  });
  assert.deepEqual(result.rounding.savingsTarget, {
    precisionMinor: 1,
    direction:
      expectedRatioDirection(expected.disposableIncomeMinor, 1, 5) === 'exact'
        && savingsAdjustmentMinor === 0
        ? 'exact'
        : 'half_up',
    adjustmentMinor: savingsAdjustmentMinor,
    adjustmentTarget: 'savingsTarget',
  });
}

const allocationCaseArbitrary = fc.record({
  salaryMinor: fc.integer({ min: 0, max: 1_000_000_000_000 }),
  activeBillAmounts: fc.array(
    fc.integer({ min: 0, max: 125_000_000_000 }),
    { maxLength: 8 }
  ),
  inactiveBillAmounts: fc.array(
    fc.integer({ min: 0, max: 1_000_000_000_000 }),
    { minLength: 1, maxLength: 4 }
  ),
  futureBillAmount: fc.integer({ min: 0, max: 1_000_000_000_000 }),
  expiredBillAmount: fc.integer({ min: 0, max: 1_000_000_000_000 }),
  excessMinor: fc.integer({ min: 1, max: 1_000_000 }),
});

// Feature: financial-clarity-experience, Property 1: Monthly allocation is bounded and conserved
// **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.6, 4.7, 4.8, 4.9**
test('Property 1: monthly allocation is bounded and conserved', () => {
  fc.assert(
    fc.property(allocationCaseArbitrary, ({
      salaryMinor,
      activeBillAmounts,
      inactiveBillAmounts,
      futureBillAmount,
      expiredBillAmount,
      excessMinor,
    }) => {
      const activeBills = activeBillAmounts.map((amountMinor, index) => ({
        id: 100 + index,
        amountMinor,
        active: index % 2 === 0 ? true : 1,
        ...(index % 3 === 1 ? { effectiveFromMonth: '2026-05' } : {}),
        ...(index % 3 === 2
          ? { effectiveFromMonth: MONTH, effectiveToMonth: MONTH }
          : {}),
      }));
      const inactiveBills = inactiveBillAmounts.map((amountMinor, index) => ({
        id: 1_000 + index,
        amountMinor,
        active: index % 2 === 0 ? false : 0,
      }));
      const excludedBills = [
        {
          id: 2_000,
          amountMinor: futureBillAmount,
          active: true,
          effectiveFromMonth: '2026-07',
        },
        {
          id: 2_001,
          amountMinor: expiredBillAmount,
          active: 1,
          effectiveToMonth: '2026-05',
        },
      ];

      assertScenario({
        salaryMinor,
        bills: [],
        activeBillIds: [],
        activeBillAmounts: [],
      });
      assertScenario({
        salaryMinor,
        bills: [...activeBills, ...inactiveBills, ...excludedBills],
        activeBillIds: activeBills.map(({ id }) => id),
        activeBillAmounts,
      });
      assertScenario({
        salaryMinor,
        bills: [
          { id: 3_000, amountMinor: salaryMinor, active: true },
          { id: 3_001, amountMinor: inactiveBillAmounts[0], active: false },
        ],
        activeBillIds: [3_000],
        activeBillAmounts: [salaryMinor],
      });
      assertScenario({
        salaryMinor,
        bills: [
          { id: 4_000, amountMinor: salaryMinor + excessMinor, active: 1 },
          { id: 4_001, amountMinor: inactiveBillAmounts[0], active: 0 },
        ],
        activeBillIds: [4_000],
        activeBillAmounts: [salaryMinor + excessMinor],
      });
    }),
    { numRuns: NUM_RUNS }
  );
});

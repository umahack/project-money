import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {
  FINANCIAL_CLARITY_TIME_ZONE,
  calculateMonthlyPlanTransition,
} from '../../src/domain/monthlyPlan.js';

const MONTH = '2026-02';
const MAX_AMOUNT_MINOR = 1_000_000_000;
const EXPECTED_CALCULATION_ORDER = [
  'salary',
  'active_bills',
  'disposable_income',
  'allocation',
  'expenses',
  'daily_guide',
];
const EXPECTED_EXPLANATION_KEYS = [
  'monthly_plan.salary',
  'monthly_plan.active_bills',
  'monthly_plan.disposable_income',
  'monthly_plan.allocation_50_30_20',
  'monthly_plan.expenses',
  'monthly_plan.daily_guide',
];

const billStateArbitrary = fc.record({
  amountMinor: fc.integer({ min: 0, max: MAX_AMOUNT_MINOR }),
  active: fc.boolean(),
});

const planStateArbitrary = fc.record({
  salaryMinor: fc.integer({ min: 0, max: MAX_AMOUNT_MINOR }),
  bills: fc.array(billStateArbitrary, { maxLength: 6 }),
});

const transitionArbitrary = fc.record({
  day: fc.integer({ min: 1, max: 28 }),
  preceding: planStateArbitrary,
  resulting: planStateArbitrary,
  expenses: fc.array(
    fc.integer({ min: 0, max: MAX_AMOUNT_MINOR }),
    { maxLength: 4 }
  ),
}).filter(({ preceding, resulting }) => (
  preceding.salaryMinor !== resulting.salaryMinor
  || JSON.stringify(preceding.bills) !== JSON.stringify(resulting.bills)
));

function canonicalAmountMinor(value) {
  return value === 0 ? 0 : value;
}

function subtractAmountMinor(minuend, subtrahend) {
  return canonicalAmountMinor(minuend - subtrahend);
}

function roundRatioHalfUp(amountMinor, numerator, denominator) {
  const scaled = BigInt(amountMinor) * BigInt(numerator);
  const rounded = (scaled * 2n + BigInt(denominator)) / (BigInt(denominator) * 2n);
  return Number(rounded);
}

function divideSignedHalfUp(dividend, divisor) {
  const canonicalDividend = canonicalAmountMinor(dividend);
  if (canonicalDividend === 0) return 0;

  const magnitude = BigInt(Math.abs(canonicalDividend));
  const rounded = (magnitude * 2n + BigInt(divisor)) / (BigInt(divisor) * 2n);
  if (rounded === 0n) return 0;

  return canonicalDividend < 0 ? -Number(rounded) : Number(rounded);
}

function referencePlan(state, expenseAmounts, daysRemainingInclusive) {
  const activeBillsTotalMinor = state.bills
    .filter((bill) => bill.active)
    .reduce((total, bill) => total + bill.amountMinor, 0);
  const disposableIncomeMinor = canonicalAmountMinor(Math.max(
    0,
    subtractAmountMinor(state.salaryMinor, activeBillsTotalMinor)
  ));
  const needsBudgetMinor = roundRatioHalfUp(disposableIncomeMinor, 1, 2);
  const wantsBudgetMinor = roundRatioHalfUp(disposableIncomeMinor, 3, 10);
  const spendableBudgetMinor = needsBudgetMinor + wantsBudgetMinor;
  const expensesTotalMinor = expenseAmounts.reduce(
    (total, amountMinor) => total + amountMinor,
    0
  );
  const remainingSpendableMinor = subtractAmountMinor(
    spendableBudgetMinor,
    expensesTotalMinor
  );

  return {
    disposableIncomeMinor,
    dailySpendingGuideMinor: divideSignedHalfUp(
      remainingSpendableMinor,
      daysRemainingInclusive
    ),
  };
}

function buildInput(state, expenseAmounts, day) {
  const localDate = `${MONTH}-${String(day).padStart(2, '0')}`;
  return {
    month: MONTH,
    localDate,
    timeZone: FINANCIAL_CLARITY_TIME_ZONE,
    salaryEntries: [{
      id: 1,
      month: MONTH,
      amountMinor: state.salaryMinor,
      confirmedAt: `${localDate}T00:00:00.000Z`,
    }],
    bills: state.bills.map((bill, index) => ({
      id: index + 2,
      label: `Bill ${index + 1}`,
      amountMinor: bill.amountMinor,
      active: bill.active,
    })),
    expenses: expenseAmounts.map((amountMinor, index) => ({
      id: index + 100,
      month: MONTH,
      category: index % 2 === 0 ? 'Food' : 'Other',
      amountMinor,
    })),
    categoryTreatments: [],
  };
}

function assertExplanationOrder(plan) {
  assert.deepEqual(
    plan.operations.map(({ order, stage, explanationKey }) => ({
      order,
      stage,
      explanationKey,
    })),
    EXPECTED_CALCULATION_ORDER.map((stage, index) => ({
      order: index + 1,
      stage,
      explanationKey: EXPECTED_EXPLANATION_KEYS[index],
    }))
  );
}

// Feature: financial-clarity-experience, Property 4: Plan transitions report exact outcome deltas
// **Validates: Requirements 4.12, 4.13, 4.17**
test('plan transitions report exact outcome deltas and calculation-step order', () => {
  fc.assert(
    fc.property(
      transitionArbitrary,
      ({ day, preceding, resulting, expenses }) => {
        const daysRemainingInclusive = 29 - day;
        const precedingReference = referencePlan(
          preceding,
          expenses,
          daysRemainingInclusive
        );
        const resultingReference = referencePlan(
          resulting,
          expenses,
          daysRemainingInclusive
        );

        const transition = calculateMonthlyPlanTransition({
          preceding: buildInput(preceding, expenses, day),
          resulting: buildInput(resulting, expenses, day),
        });

        assert.equal(
          transition.preceding.disposableIncomeMinor,
          precedingReference.disposableIncomeMinor
        );
        assert.equal(
          transition.preceding.dailySpendingGuideMinor,
          precedingReference.dailySpendingGuideMinor
        );
        assert.equal(
          transition.resulting.disposableIncomeMinor,
          resultingReference.disposableIncomeMinor
        );
        assert.equal(
          transition.resulting.dailySpendingGuideMinor,
          resultingReference.dailySpendingGuideMinor
        );
        assert.deepEqual(transition.deltas, {
          disposableIncomeMinor: subtractAmountMinor(
            resultingReference.disposableIncomeMinor,
            precedingReference.disposableIncomeMinor
          ),
          dailySpendingGuideMinor: subtractAmountMinor(
            resultingReference.dailySpendingGuideMinor,
            precedingReference.dailySpendingGuideMinor
          ),
        });
        assertExplanationOrder(transition.preceding);
        assertExplanationOrder(transition.resulting);
      }
    ),
    { numRuns: 100 }
  );
});

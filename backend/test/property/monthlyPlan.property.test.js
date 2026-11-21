import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {
  FINANCIAL_CLARITY_TIME_ZONE,
  calculateMonthlyPlan,
} from '../../src/domain/monthlyPlan.js';

const CATEGORIES = Object.freeze([
  'Food',
  'Groceries',
  'Transport',
  'Bills',
  'Health',
  'Entertainment',
  'Shopping',
  'Travel',
  'Other',
]);
const DEFAULT_NEEDS_CATEGORIES = new Set([
  'Food',
  'Groceries',
  'Transport',
  'Bills',
  'Health',
]);

function formatPart(value) {
  return String(value).padStart(2, '0');
}

function referenceDaysInMonth(year, monthNumber) {
  return new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
}

function referenceHalfUp(dividend, divisor) {
  const negative = dividend < 0;
  const magnitude = BigInt(Math.abs(dividend));
  const integerDivisor = BigInt(divisor);
  let quotient = magnitude / integerDivisor;
  if ((magnitude % integerDivisor) * 2n >= integerDivisor) quotient += 1n;
  return Number(negative ? -quotient : quotient);
}

function referenceRatioHalfUp(amountMinor, numerator, denominator) {
  return referenceHalfUp(amountMinor * numerator, denominator);
}

function buildCategoryTreatments(selections) {
  return selections.flatMap((treatment, index) => (
    treatment === null
      ? []
      : [{ id: 1_000 + index, category: CATEGORIES[index], treatment }]
  ));
}

function referenceTreatment(category, categoryTreatments) {
  const override = categoryTreatments.find((entry) => entry.category === category);
  if (override) return override.treatment;
  return DEFAULT_NEEDS_CATEGORIES.has(category) ? 'needs' : 'wants';
}

const calendarArbitrary = fc
  .record({
    year: fc.integer({ min: 2024, max: 2035 }),
    monthNumber: fc.integer({ min: 1, max: 12 }),
  })
  .chain(({ year, monthNumber }) => fc
    .integer({ min: 1, max: referenceDaysInMonth(year, monthNumber) })
    .map((day) => ({ year, monthNumber, day })));

const scenarioArbitrary = fc.record({
  calendar: calendarArbitrary,
  salaryMinor: fc.integer({ min: 0, max: 2_000_000_000 }),
  billAmounts: fc.array(
    fc.integer({ min: 0, max: 300_000_000 }),
    { minLength: 0, maxLength: 8 }
  ),
  expenseDrafts: fc.array(
    fc.record({
      amountMinor: fc.integer({ min: 0, max: 300_000_000 }),
      category: fc.constantFrom(...CATEGORIES),
    }),
    { minLength: 0, maxLength: 12 }
  ),
  treatmentSelections: fc.array(
    fc.option(fc.constantFrom('needs', 'wants'), { nil: null }),
    { minLength: CATEGORIES.length, maxLength: CATEGORIES.length }
  ),
});

test('Property 3: spending guidance follows the canonical formulas', () => {
  // Feature: financial-clarity-experience, Property 3: Spending guidance follows the canonical formulas
  // **Validates: Requirements 4.10, 4.11, 5.6, 5.7, 5.8**
  fc.assert(
    fc.property(scenarioArbitrary, (scenario) => {
      const { year, monthNumber, day } = scenario.calendar;
      const month = `${year}-${formatPart(monthNumber)}`;
      const localDate = `${month}-${formatPart(day)}`;
      const categoryTreatments = buildCategoryTreatments(scenario.treatmentSelections);
      const expenses = scenario.expenseDrafts.map((expense, index) => ({
        id: 200 + index,
        month,
        ...expense,
      }));
      const bills = scenario.billAmounts.map((amountMinor, index) => ({
        id: 100 + index,
        amountMinor,
        active: true,
        effectiveFromMonth: month,
        effectiveToMonth: month,
      }));

      const actual = calculateMonthlyPlan({
        month,
        localDate,
        timeZone: FINANCIAL_CLARITY_TIME_ZONE,
        salaryEntries: [{ id: 1, month, amountMinor: scenario.salaryMinor }],
        bills,
        expenses,
        categoryTreatments,
      });

      const billTotal = scenario.billAmounts.reduce((total, amount) => total + amount, 0);
      const disposableIncome = Math.max(0, scenario.salaryMinor - billTotal);
      const needsBudget = referenceRatioHalfUp(disposableIncome, 1, 2);
      const wantsBudget = referenceRatioHalfUp(disposableIncome, 3, 10);
      const spendableBudget = needsBudget + wantsBudget;
      const needsSpent = expenses
        .filter((expense) => referenceTreatment(expense.category, categoryTreatments) === 'needs')
        .reduce((total, expense) => total + expense.amountMinor, 0);
      const wantsSpent = expenses
        .filter((expense) => referenceTreatment(expense.category, categoryTreatments) === 'wants')
        .reduce((total, expense) => total + expense.amountMinor, 0);
      const allExpenses = needsSpent + wantsSpent;
      const remainingSpendable = spendableBudget - allExpenses;
      const daysRemainingInclusive = referenceDaysInMonth(year, monthNumber) - day + 1;
      const dailySpendingGuide = referenceHalfUp(
        remainingSpendable,
        daysRemainingInclusive
      );
      const projectedSavings = Math.max(
        0,
        scenario.salaryMinor - billTotal - allExpenses
      );

      assert.equal(actual.period.daysRemainingInclusive, daysRemainingInclusive);
      assert.equal(actual.needsSpentMinor, needsSpent);
      assert.equal(actual.wantsSpentMinor, wantsSpent);
      assert.equal(actual.spendableBudgetMinor, spendableBudget);
      assert.equal(actual.remainingSpendableMinor, remainingSpendable);
      assert.equal(actual.dailySpendingGuideMinor, dailySpendingGuide);
      assert.equal(actual.projectedSavingsMinor, projectedSavings);
    }),
    { numRuns: 100 }
  );
});

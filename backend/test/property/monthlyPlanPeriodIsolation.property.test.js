import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {
  FINANCIAL_CLARITY_TIME_ZONE,
  calculateMonthlyPlan,
} from '../../src/domain/monthlyPlan.js';

const NUM_RUNS = 200;
const NEEDS_CATEGORIES = new Set(['Food', 'Groceries', 'Transport', 'Bills', 'Health']);
const CATEGORY_ARBITRARY = fc.constantFrom('Food', 'Groceries', 'Health', 'Shopping', 'Entertainment');
const EXPENSE_RECORD_ARBITRARY = fc.record({
  amountMinor: fc.integer({ min: 1, max: 30_000_000 }),
  category: CATEGORY_ARBITRARY,
});

const SCENARIO_ARBITRARY = fc.record({
  targetMonthIndex: fc.integer({
    min: 2024 * 12 + 1,
    max: 2030 * 12 + 10,
  }),
  sourceBeforeTarget: fc.boolean(),
  localDay: fc.integer({ min: 1, max: 28 }),
  targetSalaryMinor: fc.integer({ min: 0, max: 400_000_000 }),
  copiedSalaryIncreaseMinor: fc.integer({ min: 1, max: 400_000_000 }),
  thirdMonthSalaryMinor: fc.integer({ min: 0, max: 800_000_000 }),
  billAmounts: fc.array(fc.integer({ min: 0, max: 50_000_000 }), {
    minLength: 0,
    maxLength: 3,
  }),
  targetExpenses: fc.array(EXPENSE_RECORD_ARBITRARY, {
    minLength: 1,
    maxLength: 4,
  }),
  sourceExpenses: fc.array(EXPENSE_RECORD_ARBITRARY, {
    minLength: 1,
    maxLength: 4,
  }),
  thirdMonthExpenses: fc.array(EXPENSE_RECORD_ARBITRARY, {
    minLength: 0,
    maxLength: 3,
  }),
  addedNonTargetExpense: EXPENSE_RECORD_ARBITRARY,
});

function monthFromIndex(index) {
  const year = Math.floor(index / 12);
  const monthNumber = (index % 12) + 1;
  return `${String(year).padStart(4, '0')}-${String(monthNumber).padStart(2, '0')}`;
}

function localDate(month, day) {
  return `${month}-${String(day).padStart(2, '0')}`;
}

function daysInMonth(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  return new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
}

function canonicalMinor(amountMinor) {
  return amountMinor === 0 ? 0 : amountMinor;
}

function roundHalfUpSigned(dividend, divisor) {
  const sign = dividend < 0 ? -1 : 1;
  const magnitude = Math.abs(dividend);
  let quotient = Math.floor(magnitude / divisor);
  if ((magnitude % divisor) * 2 >= divisor) quotient += 1;
  return canonicalMinor(sign * quotient);
}

function roundRatioHalfUp(amountMinor, numerator, denominator) {
  return roundHalfUpSigned(amountMinor * numerator, denominator);
}

function billAppliesToMonth(bill, month) {
  return Boolean(bill.active ?? true)
    && (bill.effectiveFromMonth == null || bill.effectiveFromMonth <= month)
    && (bill.effectiveToMonth == null || bill.effectiveToMonth >= month);
}

function referenceProjection({ month, day, salaryEntries, bills, expenses }) {
  const salary = salaryEntries.find((entry) => entry.month === month);
  const activeBills = bills
    .filter((bill) => billAppliesToMonth(bill, month))
    .sort((left, right) => left.id - right.id);
  const applicableExpenses = expenses
    .filter((expense) => expense.month === month)
    .sort((left, right) => left.id - right.id);

  const activeBillsTotalMinor = activeBills.reduce(
    (total, bill) => total + bill.amountMinor,
    0
  );
  const disposableIncomeMinor = Math.max(0, salary.amountMinor - activeBillsTotalMinor);
  const shortfallMinor = Math.max(0, activeBillsTotalMinor - salary.amountMinor);
  const needsBudgetMinor = roundRatioHalfUp(disposableIncomeMinor, 1, 2);
  const wantsBudgetMinor = roundRatioHalfUp(disposableIncomeMinor, 3, 10);
  const savingsTargetMinor = disposableIncomeMinor - needsBudgetMinor - wantsBudgetMinor;
  const spendableBudgetMinor = needsBudgetMinor + wantsBudgetMinor;
  const needsSpentMinor = applicableExpenses
    .filter((expense) => NEEDS_CATEGORIES.has(expense.category))
    .reduce((total, expense) => total + expense.amountMinor, 0);
  const wantsSpentMinor = applicableExpenses
    .filter((expense) => !NEEDS_CATEGORIES.has(expense.category))
    .reduce((total, expense) => total + expense.amountMinor, 0);
  const applicableExpensesTotalMinor = needsSpentMinor + wantsSpentMinor;
  const remainingSpendableMinor = spendableBudgetMinor - applicableExpensesTotalMinor;
  const daysRemainingInclusive = daysInMonth(month) - day + 1;

  return {
    periodMonth: month,
    salaryMinor: salary.amountMinor,
    activeBillsTotalMinor,
    shortfallMinor,
    disposableIncomeMinor,
    needsBudgetMinor,
    wantsBudgetMinor,
    savingsTargetMinor,
    spendableBudgetMinor,
    needsSpentMinor,
    wantsSpentMinor,
    applicableExpensesTotalMinor,
    remainingSpendableMinor,
    dailySpendingGuideMinor: roundHalfUpSigned(
      remainingSpendableMinor,
      daysRemainingInclusive
    ),
    projectedSavingsMinor: Math.max(
      0,
      salary.amountMinor - activeBillsTotalMinor - applicableExpensesTotalMinor
    ),
    activeBillIds: activeBills.map((bill) => bill.id),
    applicableExpenseIds: applicableExpenses.map((expense) => expense.id),
  };
}

function resultProjection(result) {
  return {
    periodMonth: result.period.month,
    salaryMinor: result.salaryMinor,
    activeBillsTotalMinor: result.activeBillsTotalMinor,
    shortfallMinor: result.shortfallMinor,
    disposableIncomeMinor: result.disposableIncomeMinor,
    needsBudgetMinor: result.needsBudgetMinor,
    wantsBudgetMinor: result.wantsBudgetMinor,
    savingsTargetMinor: result.savingsTargetMinor,
    spendableBudgetMinor: result.spendableBudgetMinor,
    needsSpentMinor: result.needsSpentMinor,
    wantsSpentMinor: result.wantsSpentMinor,
    applicableExpensesTotalMinor: result.applicableExpensesTotalMinor,
    remainingSpendableMinor: result.remainingSpendableMinor,
    dailySpendingGuideMinor: result.dailySpendingGuideMinor,
    projectedSavingsMinor: result.projectedSavingsMinor,
    activeBillIds: result.activeBillIds,
    applicableExpenseIds: result.applicableExpenseIds,
  };
}

function calculateForMonth({ month, day, salaryEntries, bills, expenses }) {
  return calculateMonthlyPlan({
    month,
    localDate: localDate(month, day),
    timeZone: FINANCIAL_CLARITY_TIME_ZONE,
    salaryEntries,
    bills,
    expenses,
    categoryTreatments: [],
  });
}

function buildExpenses(records, month, idBase) {
  return records.map((record, index) => ({
    id: idBase + index,
    month,
    category: record.category,
    amountMinor: record.amountMinor,
  }));
}

function applySalaryCopy(salaryEntries, sourceMonth, targetMonth) {
  const source = salaryEntries.find((entry) => entry.month === sourceMonth);
  return [
    ...salaryEntries.filter((entry) => entry.month !== targetMonth),
    { id: 5, month: targetMonth, amountMinor: source.amountMinor },
  ];
}

test('Property 2: Monthly records are period-isolated', () => {
  // Feature: financial-clarity-experience, Property 2: Monthly records are period-isolated
  // **Validates: Requirements 4.14, 4.15, 4.16, 5.12, 5.13, 5.14**
  fc.assert(
    fc.property(SCENARIO_ARBITRARY, (scenario) => {
      const sourceOffset = scenario.sourceBeforeTarget ? -1 : 1;
      const targetMonth = monthFromIndex(scenario.targetMonthIndex);
      const sourceMonth = monthFromIndex(scenario.targetMonthIndex + sourceOffset);
      const thirdMonth = monthFromIndex(scenario.targetMonthIndex - sourceOffset);
      const copiedSalaryMinor =
        scenario.targetSalaryMinor + scenario.copiedSalaryIncreaseMinor;

      const targetSalary = {
        id: 1,
        month: targetMonth,
        amountMinor: scenario.targetSalaryMinor,
      };
      const sourceSalary = {
        id: 2,
        month: sourceMonth,
        amountMinor: copiedSalaryMinor,
      };
      const thirdMonthSalary = {
        id: 3,
        month: thirdMonth,
        amountMinor: scenario.thirdMonthSalaryMinor,
      };
      const salaryEntries = [targetSalary, sourceSalary, thirdMonthSalary];
      const bills = scenario.billAmounts.map((amountMinor, index) => ({
        id: 10 + index,
        amountMinor,
        active: true,
      }));
      const targetExpenses = buildExpenses(
        scenario.targetExpenses,
        targetMonth,
        1_000
      );
      const sourceExpenses = buildExpenses(
        scenario.sourceExpenses,
        sourceMonth,
        2_000
      );
      const thirdMonthExpenses = buildExpenses(
        scenario.thirdMonthExpenses,
        thirdMonth,
        3_000
      );
      const expenses = [...targetExpenses, ...sourceExpenses, ...thirdMonthExpenses];
      const baselineInput = {
        month: targetMonth,
        day: scenario.localDay,
        salaryEntries,
        bills,
        expenses,
      };
      const baselineTarget = calculateForMonth(baselineInput);

      assert.deepEqual(
        resultProjection(baselineTarget),
        referenceProjection(baselineInput)
      );
      assert.equal(baselineTarget.period.month, targetMonth);

      const changedNonTargetSalaries = [
        targetSalary,
        { ...sourceSalary, amountMinor: sourceSalary.amountMinor + 1 },
        thirdMonthSalary,
        { id: 4, month: sourceMonth, amountMinor: 1 },
      ];
      const changedNonTargetExpenses = [
        ...targetExpenses,
        ...sourceExpenses.slice(1).map((expense) => ({
          ...expense,
          amountMinor: expense.amountMinor + 1,
          category: expense.category === 'Food' ? 'Shopping' : 'Food',
        })),
        ...thirdMonthExpenses,
        {
          id: 4_000,
          month: sourceMonth,
          ...scenario.addedNonTargetExpense,
        },
      ];
      const changedNonTargetTarget = calculateForMonth({
        ...baselineInput,
        salaryEntries: changedNonTargetSalaries,
        expenses: changedNonTargetExpenses,
      });
      assert.deepEqual(changedNonTargetTarget, baselineTarget);

      const removedNonTargetTarget = calculateForMonth({
        ...baselineInput,
        salaryEntries: [targetSalary, thirdMonthSalary],
        expenses: [...targetExpenses, ...thirdMonthExpenses],
      });
      assert.deepEqual(removedNonTargetTarget, baselineTarget);

      const movedAwayExpense = targetExpenses[0];
      const movedAwayExpenses = expenses.map((expense) => (
        expense.id === movedAwayExpense.id
          ? { ...expense, month: sourceMonth }
          : expense
      ));
      const movedAwayInput = { ...baselineInput, expenses: movedAwayExpenses };
      const movedAwayTarget = calculateForMonth(movedAwayInput);
      assert.deepEqual(
        resultProjection(movedAwayTarget),
        referenceProjection(movedAwayInput)
      );
      assert.equal(
        movedAwayTarget.applicableExpensesTotalMinor,
        baselineTarget.applicableExpensesTotalMinor - movedAwayExpense.amountMinor
      );
      assert.equal(
        movedAwayTarget.applicableExpenseIds.includes(movedAwayExpense.id),
        false
      );

      const movedIntoTargetExpense = sourceExpenses[0];
      const movedIntoTargetExpenses = expenses.map((expense) => (
        expense.id === movedIntoTargetExpense.id
          ? { ...expense, month: targetMonth }
          : expense
      ));
      const movedIntoTargetInput = { ...baselineInput, expenses: movedIntoTargetExpenses };
      const movedIntoTarget = calculateForMonth(movedIntoTargetInput);
      assert.deepEqual(
        resultProjection(movedIntoTarget),
        referenceProjection(movedIntoTargetInput)
      );
      assert.equal(
        movedIntoTarget.applicableExpensesTotalMinor,
        baselineTarget.applicableExpensesTotalMinor + movedIntoTargetExpense.amountMinor
      );
      assert.equal(
        movedIntoTarget.applicableExpenseIds.filter(
          (expenseId) => expenseId === movedIntoTargetExpense.id
        ).length,
        1
      );

      const sourceBeforeCopy = calculateForMonth({
        month: sourceMonth,
        day: scenario.localDay,
        salaryEntries,
        bills,
        expenses,
      });
      const thirdMonthBeforeCopy = calculateForMonth({
        month: thirdMonth,
        day: scenario.localDay,
        salaryEntries,
        bills,
        expenses,
      });
      const copiedSalaryEntries = applySalaryCopy(
        salaryEntries,
        sourceMonth,
        targetMonth
      );
      const targetAfterCopyInput = {
        ...baselineInput,
        salaryEntries: copiedSalaryEntries,
      };
      const targetAfterCopy = calculateForMonth(targetAfterCopyInput);
      const sourceAfterCopy = calculateForMonth({
        month: sourceMonth,
        day: scenario.localDay,
        salaryEntries: copiedSalaryEntries,
        bills,
        expenses,
      });
      const thirdMonthAfterCopy = calculateForMonth({
        month: thirdMonth,
        day: scenario.localDay,
        salaryEntries: copiedSalaryEntries,
        bills,
        expenses,
      });

      assert.deepEqual(
        resultProjection(targetAfterCopy),
        referenceProjection(targetAfterCopyInput)
      );
      assert.equal(targetAfterCopy.period.month, targetMonth);
      assert.equal(targetAfterCopy.salaryMinor, copiedSalaryMinor);
      assert.notEqual(targetAfterCopy.salaryMinor, baselineTarget.salaryMinor);
      assert.deepEqual(sourceAfterCopy, sourceBeforeCopy);
      assert.deepEqual(thirdMonthAfterCopy, thirdMonthBeforeCopy);
    }),
    { numRuns: NUM_RUNS }
  );
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {
  applyExpenseTransition,
  createExpenseState,
} from '../../src/domain/expenses.js';

const NUM_RUNS = 200;
const MONTHS = ['2025-12', '2026-01', '2026-02', '2026-03'];
const CATEGORIES = [
  'Food',
  'Groceries',
  'Health',
  'Shopping',
  'Entertainment',
  'Travel',
];

const EXPENSE_DRAFT_ARBITRARY = fc.record({
  month: fc.constantFrom(...MONTHS),
  category: fc.constantFrom(...CATEGORIES),
  amountMinor: fc.integer({ min: 1, max: 50_000_000 }),
});

const TREATMENT_SELECTION_ARBITRARY = fc.array(
  fc.option(fc.constantFrom('needs', 'wants'), { nil: null }),
  { minLength: CATEGORIES.length, maxLength: CATEGORIES.length }
);

const SCENARIO_ARBITRARY = fc
  .record({
    currentMonthIndex: fc.integer({ min: 0, max: MONTHS.length - 1 }),
    selectedIsCurrentMonth: fc.boolean(),
    selectedOtherMonthOffset: fc.integer({ min: 1, max: MONTHS.length - 1 }),
    expenseDrafts: fc.array(EXPENSE_DRAFT_ARBITRARY, {
      minLength: 1,
      maxLength: 12,
    }),
    treatmentSelections: TREATMENT_SELECTION_ARBITRARY,
    needsBudgetMinor: fc.integer({ min: 0, max: 1_000_000_000 }),
    wantsBudgetMinor: fc.integer({ min: 0, max: 1_000_000_000 }),
    salaryMinor: fc.integer({ min: 0, max: 2_000_000_000 }),
    activeBillsTotalMinor: fc.integer({ min: 0, max: 1_000_000_000 }),
    createdExpense: EXPENSE_DRAFT_ARBITRARY,
  })
  .chain((scenario) => fc.record({
    scenario: fc.constant(scenario),
    selectedIndex: fc.integer({ min: 0, max: scenario.expenseDrafts.length - 1 }),
  }));

function canonicalState(state) {
  return {
    month: state.month,
    expenses: state.expenses,
    categoryTreatments: state.categoryTreatments,
    needsBudgetMinor: state.needsBudgetMinor,
    wantsBudgetMinor: state.wantsBudgetMinor,
    salaryMinor: state.salaryMinor,
    activeBillsTotalMinor: state.activeBillsTotalMinor,
    summary: state.summary,
  };
}

function partitionTotal(expenses, { month, category }) {
  return expenses
    .filter((expense) => expense.month === month && expense.category === category)
    .reduce((total, expense) => total + expense.amountMinor, 0);
}

function buildCategoryTreatments(selections) {
  return selections.flatMap((treatment, index) => (
    treatment === null
      ? []
      : [{ id: index + 1, category: CATEGORIES[index], treatment }]
  ));
}

function buildLedger({
  currentMonthIndex,
  selectedIsCurrentMonth,
  selectedOtherMonthOffset,
  expenseDrafts,
}, selectedIndex) {
  const currentMonth = MONTHS[currentMonthIndex];
  const selectedMonth = selectedIsCurrentMonth
    ? currentMonth
    : MONTHS[(currentMonthIndex + selectedOtherMonthOffset) % MONTHS.length];
  const expenses = expenseDrafts.map((draft, index) => ({
    id: index + 1,
    ...draft,
    ...(index === selectedIndex ? { month: selectedMonth } : {}),
  }));
  return { currentMonth, expenses };
}

test('Property 6: expense deletion is an idempotent inverse', () => {
  // Feature: financial-clarity-experience, Property 6: Expense deletion is an idempotent inverse
  // **Validates: Requirements 5.4, 5.13, 5.14**
  fc.assert(
    fc.property(SCENARIO_ARBITRARY, ({ scenario, selectedIndex }) => {
      const { currentMonth, expenses } = buildLedger(scenario, selectedIndex);
      const categoryTreatments = buildCategoryTreatments(
        scenario.treatmentSelections
      );
      const initial = createExpenseState({
        month: currentMonth,
        expenses,
        categoryTreatments,
        needsBudgetMinor: scenario.needsBudgetMinor,
        wantsBudgetMinor: scenario.wantsBudgetMinor,
        salaryMinor: scenario.salaryMinor,
        activeBillsTotalMinor: scenario.activeBillsTotalMinor,
      });
      const unchangedInitial = structuredClone(initial);
      const selectedExpense = initial.expenses[selectedIndex];
      const deleteTransition = {
        type: 'delete',
        expenseId: selectedExpense.id,
      };
      const referenceExpenses = initial.expenses.filter(
        (expense) => expense.id !== selectedExpense.id
      );
      const referenceAfterDelete = createExpenseState({
        ...canonicalState(initial),
        expenses: referenceExpenses,
      });
      const originalPartitionTotal = partitionTotal(initial.expenses, selectedExpense);
      const resultingPartitionTotal = partitionTotal(
        referenceExpenses,
        selectedExpense
      );

      const deleted = applyExpenseTransition(initial, deleteTransition);

      assert.deepEqual(initial, unchangedInitial);
      assert.deepEqual(canonicalState(deleted), canonicalState(referenceAfterDelete));
      assert.equal(deleted.expenses.length, initial.expenses.length - 1);
      assert.equal(
        deleted.expenses.some((expense) => expense.id === selectedExpense.id),
        false
      );
      assert.equal(
        originalPartitionTotal - resultingPartitionTotal,
        selectedExpense.amountMinor
      );
      assert.deepEqual(deleted.lastTransition, {
        type: 'delete',
        status: 'confirmed',
        expenseId: selectedExpense.id,
        removedExpense: selectedExpense,
        insertedExpense: null,
        affectedPartitions: [{
          month: selectedExpense.month,
          category: selectedExpense.category,
          precedingTotalMinor: originalPartitionTotal,
          resultingTotalMinor: resultingPartitionTotal,
        }],
      });

      if (selectedExpense.month === currentMonth) {
        const appliedTreatment = initial.summary.appliedTreatments.find(
          (record) => record.expenseId === selectedExpense.id
        ).treatment;
        assert.equal(
          deleted.summary.totalSpendingMinor,
          initial.summary.totalSpendingMinor - selectedExpense.amountMinor
        );
        assert.equal(
          deleted.summary.needsSpentMinor,
          initial.summary.needsSpentMinor
            - (appliedTreatment === 'needs' ? selectedExpense.amountMinor : 0)
        );
        assert.equal(
          deleted.summary.wantsSpentMinor,
          initial.summary.wantsSpentMinor
            - (appliedTreatment === 'wants' ? selectedExpense.amountMinor : 0)
        );
        assert.equal(
          deleted.summary.remainingSpendableMinor,
          initial.summary.remainingSpendableMinor + selectedExpense.amountMinor
        );
        assert.equal(
          deleted.summary.projectedSavingsMinor,
          Math.max(
            0,
            scenario.salaryMinor
              - scenario.activeBillsTotalMinor
              - deleted.summary.totalSpendingMinor
          )
        );
      } else {
        assert.deepEqual(deleted.summary, initial.summary);
      }

      const replayed = applyExpenseTransition(deleted, deleteTransition);
      assert.equal(replayed.lastTransition.status, 'unchanged');
      assert.deepEqual(replayed.lastTransition.affectedPartitions, []);
      assert.deepEqual(canonicalState(replayed), canonicalState(deleted));

      const createdExpense = {
        id: initial.expenses.length + 1,
        ...scenario.createdExpense,
      };
      const created = applyExpenseTransition(initial, {
        type: 'create',
        expense: createdExpense,
      });
      const restored = applyExpenseTransition(created, {
        type: 'delete',
        expenseId: createdExpense.id,
      });

      assert.equal(
        created.expenses.filter((expense) => expense.id === createdExpense.id).length,
        1
      );
      assert.deepEqual(canonicalState(restored), canonicalState(initial));
    }),
    { numRuns: NUM_RUNS }
  );
});

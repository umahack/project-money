import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {
  applyExpenseTransition,
  createExpenseState,
} from '../../src/domain/expenses.js';

const NUM_RUNS = 150;
const MAX_AMOUNT_MINOR = 5_000_000;
const NEW_EXPENSE_ID = 10_000;
const MONTHS = Object.freeze(['2026-01', '2026-02', '2026-03']);
const CATEGORIES = Object.freeze(['Food', 'Groceries', 'Shopping', 'Travel']);
const NEEDS_CATEGORIES = new Set(['Food', 'Groceries']);

const expenseDraftArbitrary = fc.record({
  month: fc.constantFrom(...MONTHS),
  category: fc.constantFrom(...CATEGORIES),
  amountMinor: fc.integer({ min: 0, max: MAX_AMOUNT_MINOR }),
});

const scenarioArbitrary = fc.record({
  initialDrafts: fc.array(expenseDraftArbitrary, { minLength: 1, maxLength: 8 }),
  createdDraft: expenseDraftArbitrary,
  updateSelector: fc.nat(),
  updateAmountDelta: fc.integer({ min: 1, max: MAX_AMOUNT_MINOR }),
  monthMoveSelector: fc.nat(),
  monthOffset: fc.integer({ min: 1, max: MONTHS.length - 1 }),
  categoryMoveSelector: fc.nat(),
  categoryOffset: fc.integer({ min: 1, max: CATEGORIES.length - 1 }),
  needsBudgetMinor: fc.integer({ min: 0, max: 20_000_000 }),
  wantsBudgetMinor: fc.integer({ min: 0, max: 20_000_000 }),
  salaryMinor: fc.integer({ min: 0, max: 50_000_000 }),
  activeBillsTotalMinor: fc.integer({ min: 0, max: 50_000_000 }),
});

function sortedLedgerRecords(ledger) {
  return [...ledger.values()]
    .map((expense) => ({ ...expense }))
    .sort((left, right) => left.id - right.id);
}

function selectExpense(ledger, selector) {
  const records = sortedLedgerRecords(ledger);
  return records[selector % records.length];
}

function differentAmount(amountMinor, delta) {
  return (amountMinor + delta) % (MAX_AMOUNT_MINOR + 1);
}

function shiftedValue(values, current, offset) {
  const currentIndex = values.indexOf(current);
  return values[(currentIndex + offset) % values.length];
}

function applyReferenceTransition(precedingLedger, transition) {
  const resultingLedger = new Map(
    sortedLedgerRecords(precedingLedger).map((expense) => [expense.id, expense])
  );
  let removedExpense = null;
  let insertedExpense = null;

  if (transition.type === 'create') {
    insertedExpense = { ...transition.expense };
  } else {
    removedExpense = { ...resultingLedger.get(transition.expenseId) };
    resultingLedger.delete(transition.expenseId);
    insertedExpense = { ...transition.expense };
  }

  resultingLedger.set(insertedExpense.id, insertedExpense);
  return { resultingLedger, removedExpense, insertedExpense };
}

function partitionTotal(ledger, partition) {
  let totalMinor = 0;
  for (const expense of ledger.values()) {
    if (expense.month === partition.month && expense.category === partition.category) {
      totalMinor += expense.amountMinor;
    }
  }
  return totalMinor;
}

function comparePartitions(left, right) {
  if (left.month !== right.month) return left.month < right.month ? -1 : 1;
  if (left.category !== right.category) return left.category < right.category ? -1 : 1;
  return 0;
}

function referenceAffectedPartitions(
  precedingLedger,
  resultingLedger,
  removedExpense,
  insertedExpense
) {
  const partitions = new Map();
  for (const expense of [removedExpense, insertedExpense].filter(Boolean)) {
    const key = JSON.stringify([expense.month, expense.category]);
    partitions.set(key, { month: expense.month, category: expense.category });
  }

  return [...partitions.values()]
    .map((partition) => ({
      ...partition,
      precedingTotalMinor: partitionTotal(precedingLedger, partition),
      resultingTotalMinor: partitionTotal(resultingLedger, partition),
    }))
    .sort(comparePartitions);
}

function referenceMonthlySummary(ledger, month, finances) {
  const applicableExpenses = sortedLedgerRecords(ledger)
    .filter((expense) => expense.month === month);
  const categoryTotalsByName = new Map();
  let needsSpentMinor = 0;
  let wantsSpentMinor = 0;

  for (const expense of applicableExpenses) {
    const categoryTotal = categoryTotalsByName.get(expense.category) ?? {
      month,
      category: expense.category,
      totalMinor: 0,
      expenseIds: [],
    };
    categoryTotal.totalMinor += expense.amountMinor;
    categoryTotal.expenseIds.push(expense.id);
    categoryTotalsByName.set(expense.category, categoryTotal);

    if (NEEDS_CATEGORIES.has(expense.category)) {
      needsSpentMinor += expense.amountMinor;
    } else {
      wantsSpentMinor += expense.amountMinor;
    }
  }

  const totalSpendingMinor = needsSpentMinor + wantsSpentMinor;
  const spendableBudgetMinor =
    finances.needsBudgetMinor + finances.wantsBudgetMinor;

  return {
    month,
    categoryTotals: [...categoryTotalsByName.values()].sort(comparePartitions),
    applicableExpenseIds: applicableExpenses.map((expense) => expense.id),
    needsSpentMinor,
    wantsSpentMinor,
    totalSpendingMinor,
    spendableBudgetMinor,
    remainingSpendableMinor: spendableBudgetMinor - totalSpendingMinor,
    projectedSavingsMinor: Math.max(
      0,
      finances.salaryMinor
        - finances.activeBillsTotalMinor
        - totalSpendingMinor
    ),
  };
}

function actualMonthlySummary(summary) {
  return {
    month: summary.month,
    categoryTotals: summary.categoryTotals.map((total) => ({ ...total })),
    applicableExpenseIds: [...summary.applicableExpenseIds],
    needsSpentMinor: summary.needsSpentMinor,
    wantsSpentMinor: summary.wantsSpentMinor,
    totalSpendingMinor: summary.totalSpendingMinor,
    spendableBudgetMinor: summary.spendableBudgetMinor,
    remainingSpendableMinor: summary.remainingSpendableMinor,
    projectedSavingsMinor: summary.projectedSavingsMinor,
  };
}

function stateInput(month, ledger, finances) {
  return {
    month,
    expenses: sortedLedgerRecords(ledger),
    categoryTreatments: [],
    ...finances,
  };
}

function assertTransitionMatchesReference(precedingLedger, transition, finances) {
  const {
    resultingLedger,
    removedExpense,
    insertedExpense,
  } = applyReferenceTransition(precedingLedger, transition);
  const expectedPartitions = referenceAffectedPartitions(
    precedingLedger,
    resultingLedger,
    removedExpense,
    insertedExpense
  );
  const affectedMonths = [...new Set(
    expectedPartitions.map((partition) => partition.month)
  )];

  for (const month of affectedMonths) {
    const precedingState = createExpenseState(
      stateInput(month, precedingLedger, finances)
    );
    assert.deepEqual(
      actualMonthlySummary(precedingState.summary),
      referenceMonthlySummary(precedingLedger, month, finances)
    );

    const actual = applyExpenseTransition(precedingState, transition);
    assert.deepEqual(actual.expenses, sortedLedgerRecords(resultingLedger));
    assert.deepEqual(
      actualMonthlySummary(actual.summary),
      referenceMonthlySummary(resultingLedger, month, finances)
    );
    assert.deepEqual(
      actual.lastTransition.affectedPartitions
        .map((partition) => ({ ...partition }))
        .sort(comparePartitions),
      expectedPartitions
    );
  }

  return resultingLedger;
}

// Feature: financial-clarity-experience, Property 5: Expense transitions match a simple reference ledger
// **Validates: Requirements 5.1, 5.2, 5.3, 5.5**
test('Property 5: expense transitions match a simple reference ledger', () => {
  fc.assert(
    fc.property(scenarioArbitrary, (scenario) => {
      const finances = {
        needsBudgetMinor: scenario.needsBudgetMinor,
        wantsBudgetMinor: scenario.wantsBudgetMinor,
        salaryMinor: scenario.salaryMinor,
        activeBillsTotalMinor: scenario.activeBillsTotalMinor,
      };
      let referenceLedger = new Map(
        scenario.initialDrafts.map((draft, index) => [
          index + 1,
          { id: index + 1, ...draft },
        ])
      );

      referenceLedger = assertTransitionMatchesReference(
        referenceLedger,
        {
          type: 'create',
          expense: { id: NEW_EXPENSE_ID, ...scenario.createdDraft },
        },
        finances
      );

      const updateTarget = selectExpense(referenceLedger, scenario.updateSelector);
      referenceLedger = assertTransitionMatchesReference(
        referenceLedger,
        {
          type: 'update',
          expenseId: updateTarget.id,
          expense: {
            ...updateTarget,
            amountMinor: differentAmount(
              updateTarget.amountMinor,
              scenario.updateAmountDelta
            ),
          },
        },
        finances
      );

      const monthMoveTarget = selectExpense(
        referenceLedger,
        scenario.monthMoveSelector
      );
      referenceLedger = assertTransitionMatchesReference(
        referenceLedger,
        {
          type: 'move',
          expenseId: monthMoveTarget.id,
          expense: {
            ...monthMoveTarget,
            month: shiftedValue(
              MONTHS,
              monthMoveTarget.month,
              scenario.monthOffset
            ),
          },
        },
        finances
      );

      const categoryMoveTarget = selectExpense(
        referenceLedger,
        scenario.categoryMoveSelector
      );
      assertTransitionMatchesReference(
        referenceLedger,
        {
          type: 'move',
          expenseId: categoryMoveTarget.id,
          expense: {
            ...categoryMoveTarget,
            category: shiftedValue(
              CATEGORIES,
              categoryMoveTarget.category,
              scenario.categoryOffset
            ),
          },
        },
        finances
      );
    }),
    { numRuns: NUM_RUNS }
  );
});

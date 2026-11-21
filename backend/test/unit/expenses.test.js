import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_NEEDS_CATEGORIES,
  applyCategoryTreatmentTransition,
  applyExpenseTransition,
  calculateCategoryTotals,
  calculateExpenseSummary,
  createExpenseState,
  resolveCategoryTreatment,
} from '../../src/domain/expenses.js';

function expense(id, month, category, amountMinor) {
  return { id, month, category, amountMinor };
}

function stateInput(overrides = {}) {
  return {
    month: '2026-01',
    expenses: [],
    categoryTreatments: [],
    needsBudgetMinor: 20_000,
    wantsBudgetMinor: 10_000,
    salaryMinor: 100_000,
    activeBillsTotalMinor: 10_000,
    ...overrides,
  };
}

test('expense summary totals exact categories once and applies override-first treatment', () => {
  const input = stateInput({
    expenses: [
      expense(3, '2026-01', 'Entertainment', 5_000),
      expense(1, '2026-01', 'Groceries', 12_500),
      expense(2, '2026-01', 'Shopping', 8_000),
      expense(4, '2026-02', 'Food', 99_900),
    ],
    categoryTreatments: [
      { id: 11, category: ' shopping ', treatment: 'needs' },
    ],
  });
  const unchangedInput = structuredClone(input);

  const result = calculateExpenseSummary(input);

  assert.deepEqual(input, unchangedInput);
  assert.deepEqual(DEFAULT_NEEDS_CATEGORIES, [
    'Food', 'Groceries', 'Transport', 'Bills', 'Health',
  ]);
  assert.deepEqual(result.categoryTotals, [
    { month: '2026-01', category: 'Entertainment', totalMinor: 5_000, expenseIds: [3] },
    { month: '2026-01', category: 'Groceries', totalMinor: 12_500, expenseIds: [1] },
    { month: '2026-01', category: 'Shopping', totalMinor: 8_000, expenseIds: [2] },
  ]);
  assert.deepEqual(calculateCategoryTotals(input.expenses, '2026-02'), [
    { month: '2026-02', category: 'Food', totalMinor: 99_900, expenseIds: [4] },
  ]);
  assert.deepEqual(result.appliedTreatments, [
    { expenseId: 1, category: 'Groceries', treatment: 'needs', source: 'default' },
    {
      expenseId: 2,
      category: 'Shopping',
      treatment: 'needs',
      source: 'override',
      treatmentRecordId: 11,
    },
    { expenseId: 3, category: 'Entertainment', treatment: 'wants', source: 'default' },
  ]);
  assert.equal(result.needsSpentMinor, 20_500);
  assert.equal(result.wantsSpentMinor, 5_000);
  assert.equal(result.totalSpendingMinor, 25_500);
  assert.equal(result.spendableBudgetMinor, 30_000);
  assert.equal(result.remainingSpendableMinor, 4_500);
  assert.equal(result.projectedSavingsMinor, 64_500);
  assert.deepEqual(result.exceededBucketActions, [
    {
      conditionCode: 'needs_budget_exceeded',
      bucket: 'needs',
      budgetMinor: 20_000,
      spentMinor: 20_500,
      excessMinor: 500,
      actionKey: 'address_needs_budget_excess',
      actionLabel: 'Review Needs spending',
      correctiveAction: 'Reduce Needs spending or reclassify an incorrectly treated expense.',
    },
  ]);
  assert.equal(resolveCategoryTreatment(' health ').treatment, 'needs');
  assert.equal(resolveCategoryTreatment('Education').treatment, 'wants');
});

test('create, update, and move rebuild immutable partitions by record ID', () => {
  const initial = createExpenseState(stateInput({
    expenses: [
      expense(1, '2026-01', 'Food', 10_000),
      expense(2, '2026-01', 'Shopping', 4_000),
      expense(3, '2026-02', 'Food', 30_000),
    ],
  }));
  const unchangedInitial = structuredClone(initial);

  const created = applyExpenseTransition(initial, {
    type: 'create',
    expense: expense(4, '2026-01', 'Shopping', 1_000),
  });
  assert.deepEqual(initial, unchangedInitial);
  assert.equal(created.summary.totalSpendingMinor, 15_000);
  assert.deepEqual(created.lastTransition.affectedPartitions, [
    {
      month: '2026-01',
      category: 'Shopping',
      precedingTotalMinor: 4_000,
      resultingTotalMinor: 5_000,
    },
  ]);

  const updated = applyExpenseTransition(created, {
    type: 'update',
    expenseId: 4,
    expense: expense(4, '2026-01', 'Shopping', 2_500),
  });
  assert.equal(updated.summary.totalSpendingMinor, 16_500);
  assert.deepEqual(updated.lastTransition.affectedPartitions, [
    {
      month: '2026-01',
      category: 'Shopping',
      precedingTotalMinor: 5_000,
      resultingTotalMinor: 6_500,
    },
  ]);

  const moved = applyExpenseTransition(updated, {
    type: 'move',
    expenseId: 1,
    expense: expense(1, '2026-02', 'Travel', 8_000),
  });
  assert.deepEqual(moved.expenses.map(({ id, month, category, amountMinor }) => ({
    id, month, category, amountMinor,
  })), [
    expense(1, '2026-02', 'Travel', 8_000),
    expense(2, '2026-01', 'Shopping', 4_000),
    expense(3, '2026-02', 'Food', 30_000),
    expense(4, '2026-01', 'Shopping', 2_500),
  ]);
  assert.equal(moved.summary.totalSpendingMinor, 6_500);
  assert.deepEqual(moved.lastTransition.affectedPartitions, [
    {
      month: '2026-01',
      category: 'Food',
      precedingTotalMinor: 10_000,
      resultingTotalMinor: 0,
    },
    {
      month: '2026-02',
      category: 'Travel',
      precedingTotalMinor: 0,
      resultingTotalMinor: 8_000,
    },
  ]);
});

test('delete removes one record once and replay preserves the already-deleted state', () => {
  const initial = createExpenseState(stateInput({
    expenses: [
      expense(1, '2026-01', 'Food', 10_000),
      expense(2, '2026-01', 'Food', 4_000),
    ],
  }));

  const deleted = applyExpenseTransition(initial, { type: 'delete', expenseId: 1 });
  assert.equal(deleted.summary.totalSpendingMinor, 4_000);
  assert.deepEqual(deleted.lastTransition.affectedPartitions, [
    {
      month: '2026-01',
      category: 'Food',
      precedingTotalMinor: 14_000,
      resultingTotalMinor: 4_000,
    },
  ]);

  const replayed = applyExpenseTransition(deleted, { type: 'delete', expenseId: 1 });
  assert.equal(replayed.lastTransition.status, 'unchanged');
  assert.deepEqual(replayed.lastTransition.affectedPartitions, []);
  assert.deepEqual(replayed.expenses, deleted.expenses);
  assert.deepEqual(replayed.summary, deleted.summary);
});

test('category reclassification moves only bucket totals and emits exact exceeded actions', () => {
  const initial = createExpenseState(stateInput({
    expenses: [
      expense(1, '2026-01', 'Groceries', 12_000),
      expense(2, '2026-01', 'Shopping', 6_000),
      expense(3, '2026-02', 'Groceries', 50_000),
    ],
    needsBudgetMinor: 10_000,
    wantsBudgetMinor: 5_000,
    salaryMinor: 50_000,
    activeBillsTotalMinor: 5_000,
  }));
  assert.deepEqual(initial.summary.exceededBucketActions.map((action) => ({
    bucket: action.bucket,
    excessMinor: action.excessMinor,
  })), [
    { bucket: 'needs', excessMinor: 2_000 },
    { bucket: 'wants', excessMinor: 1_000 },
  ]);

  const reclassified = applyCategoryTreatmentTransition(initial, {
    type: 'set',
    treatment: { id: 21, category: ' groceries ', treatment: 'wants' },
  });

  assert.equal(reclassified.summary.needsSpentMinor, 0);
  assert.equal(reclassified.summary.wantsSpentMinor, 18_000);
  assert.equal(reclassified.summary.totalSpendingMinor, initial.summary.totalSpendingMinor);
  assert.equal(reclassified.summary.projectedSavingsMinor, initial.summary.projectedSavingsMinor);
  assert.deepEqual(reclassified.summary.exceededBucketActions.map((action) => ({
    bucket: action.bucket,
    excessMinor: action.excessMinor,
  })), [{ bucket: 'wants', excessMinor: 13_000 }]);
  assert.deepEqual(reclassified.lastTreatmentTransition, {
    type: 'set',
    status: 'confirmed',
    category: ' groceries ',
    precedingTreatment: null,
    resultingTreatment: { id: 21, category: ' groceries ', treatment: 'wants' },
    affectedExpenseIds: [1],
    needsSpentDeltaMinor: -12_000,
    wantsSpentDeltaMinor: 12_000,
    totalSpendingDeltaMinor: 0,
    projectedSavingsDeltaMinor: 0,
  });

  const restored = applyCategoryTreatmentTransition(reclassified, {
    type: 'remove',
    category: 'GROCERIES',
  });
  assert.equal(restored.summary.needsSpentMinor, initial.summary.needsSpentMinor);
  assert.equal(restored.summary.wantsSpentMinor, initial.summary.wantsSpentMinor);
  assert.equal(restored.summary.totalSpendingMinor, initial.summary.totalSpendingMinor);
  assert.equal(restored.summary.projectedSavingsMinor, initial.summary.projectedSavingsMinor);
});

test('expense states reject ambiguous IDs, amounts, months, and overrides', () => {
  assert.throws(
    () => createExpenseState(stateInput({
      expenses: [
        expense(1, '2026-01', 'Food', 100),
        expense(1, '2026-02', 'Food', 100),
      ],
    })),
    /duplicate record IDs/
  );
  assert.throws(
    () => createExpenseState(stateInput({
      expenses: [expense(1, '2026-13', 'Food', 100)],
    })),
    /YYYY-MM/
  );
  assert.throws(
    () => createExpenseState(stateInput({
      expenses: [expense(1, '2026-01', 'Food', -1)],
    })),
    /must not be negative/
  );
  assert.throws(
    () => createExpenseState(stateInput({
      categoryTreatments: [
        { id: 1, category: 'Shopping', treatment: 'needs' },
        { id: 2, category: ' shopping ', treatment: 'wants' },
      ],
    })),
    /duplicate categories/
  );

  const initial = createExpenseState(stateInput({
    expenses: [expense(1, '2026-01', 'Food', 100)],
  }));
  assert.throws(
    () => applyExpenseTransition(initial, {
      type: 'update',
      expenseId: 1,
      expense: expense(2, '2026-01', 'Food', 200),
    }),
    /retain the original expense ID/
  );
  assert.throws(
    () => applyExpenseTransition(initial, {
      type: 'create',
      expense: expense(1, '2026-01', 'Food', 100),
    }),
    /already exists/
  );
});

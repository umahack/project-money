import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {
  applyCategoryTreatmentTransition,
  createExpenseState,
} from '../../src/domain/expenses.js';

const MONTH = '2026-06';
const OTHER_MONTH = '2026-07';
const NUM_RUNS = 150;
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
const REFERENCE_NEEDS_CATEGORIES = new Set([
  'food',
  'groceries',
  'transport',
  'bills',
  'health',
]);

function referenceCategoryKey(category) {
  return category.normalize('NFKC').trim().toLocaleLowerCase('en-IN');
}

function canonicalReferenceMinor(amountMinor) {
  return amountMinor === 0 ? 0 : amountMinor;
}

function referenceSubtractMinor(minuend, ...subtrahends) {
  return canonicalReferenceMinor(
    subtrahends.reduce((difference, subtrahend) => difference - subtrahend, minuend)
  );
}

function referenceTreatment(category, categoryTreatments) {
  const categoryKey = referenceCategoryKey(category);
  const override = categoryTreatments.find(
    (record) => referenceCategoryKey(record.category) === categoryKey
  );
  if (override) return override.treatment;
  return REFERENCE_NEEDS_CATEGORIES.has(categoryKey) ? 'needs' : 'wants';
}

function referenceSummary({
  expenses,
  categoryTreatments,
  needsBudgetMinor,
  wantsBudgetMinor,
  salaryMinor,
  activeBillsTotalMinor,
}) {
  const applicableExpenses = expenses.filter((expense) => expense.month === MONTH);
  const totals = applicableExpenses.reduce(
    (result, expense) => {
      const treatment = referenceTreatment(expense.category, categoryTreatments);
      result[treatment] += expense.amountMinor;
      result.total += expense.amountMinor;
      return result;
    },
    { needs: 0, wants: 0, total: 0 }
  );

  const spendableBudgetMinor = canonicalReferenceMinor(
    needsBudgetMinor + wantsBudgetMinor
  );
  const projectedSavingsDifferenceMinor = referenceSubtractMinor(
    salaryMinor,
    activeBillsTotalMinor,
    totals.total
  );

  return {
    needsSpentMinor: canonicalReferenceMinor(totals.needs),
    wantsSpentMinor: canonicalReferenceMinor(totals.wants),
    totalSpendingMinor: canonicalReferenceMinor(totals.total),
    spendableBudgetMinor,
    remainingSpendableMinor: referenceSubtractMinor(
      spendableBudgetMinor,
      totals.total
    ),
    projectedSavingsMinor: canonicalReferenceMinor(
      Math.max(0, projectedSavingsDifferenceMinor)
    ),
  };
}

function referenceExceededBuckets(summary, needsBudgetMinor, wantsBudgetMinor) {
  return [
    {
      bucket: 'needs',
      budgetMinor: needsBudgetMinor,
      spentMinor: summary.needsSpentMinor,
    },
    {
      bucket: 'wants',
      budgetMinor: wantsBudgetMinor,
      spentMinor: summary.wantsSpentMinor,
    },
  ]
    .filter(({ spentMinor, budgetMinor }) => spentMinor > budgetMinor)
    .map(({ bucket, budgetMinor, spentMinor }) => ({
      bucket,
      budgetMinor,
      spentMinor,
      excessMinor: referenceSubtractMinor(spentMinor, budgetMinor),
      conditionCode: `${bucket}_budget_exceeded`,
      actionKey: `address_${bucket}_budget_excess`,
    }));
}

function assertExceededActions(summary, needsBudgetMinor, wantsBudgetMinor) {
  const expected = referenceExceededBuckets(
    summary,
    needsBudgetMinor,
    wantsBudgetMinor
  );
  assert.equal(summary.exceededBucketActions.length, expected.length);

  for (const expectedAction of expected) {
    const matchingActions = summary.exceededBucketActions.filter(
      (action) => action.bucket === expectedAction.bucket
    );
    assert.equal(matchingActions.length, 1);
    const [actualAction] = matchingActions;
    assert.deepEqual(
      {
        bucket: actualAction.bucket,
        budgetMinor: actualAction.budgetMinor,
        spentMinor: actualAction.spentMinor,
        excessMinor: actualAction.excessMinor,
        conditionCode: actualAction.conditionCode,
        actionKey: actualAction.actionKey,
      },
      expectedAction
    );
    assert.equal(typeof actualAction.actionLabel, 'string');
    assert.ok(actualAction.actionLabel.length > 0);
    assert.equal(typeof actualAction.correctiveAction, 'string');
    assert.match(actualAction.correctiveAction, /reduce|reclassif/i);
  }
}

const scenarioArbitrary = fc.constantFrom(...CATEGORIES).chain((targetCategory) => {
  const otherCategories = CATEGORIES.filter((category) => category !== targetCategory);
  return fc.record({
    targetCategory: fc.constant(targetCategory),
    initialTreatment: fc.constantFrom('needs', 'wants'),
    targetAmounts: fc.oneof(
      fc.constant([]),
      fc.array(fc.integer({ min: 0, max: 50_000_000 }), {
        minLength: 1,
        maxLength: 6,
      })
    ),
    otherExpenses: fc.array(
      fc.record({
        category: fc.constantFrom(...otherCategories),
        amountMinor: fc.integer({ min: 0, max: 50_000_000 }),
      }),
      { maxLength: 12 }
    ),
    otherMonthTargetAmounts: fc.array(
      fc.integer({ min: 0, max: 50_000_000 }),
      { maxLength: 4 }
    ),
    otherTreatmentSelections: fc.array(
      fc.option(fc.constantFrom('needs', 'wants'), { nil: null }),
      { minLength: otherCategories.length, maxLength: otherCategories.length }
    ),
    needsBudgetMinor: fc.integer({ min: 0, max: 500_000_000 }),
    wantsBudgetMinor: fc.integer({ min: 0, max: 500_000_000 }),
    salaryMinor: fc.integer({ min: 0, max: 1_000_000_000 }),
    activeBillsTotalMinor: fc.integer({ min: 0, max: 1_000_000_000 }),
  }).map((scenario) => ({ ...scenario, otherCategories }));
});

// Feature: financial-clarity-experience, Property 7: Category reclassification conserves total spending
// **Validates: Requirements 5.9, 5.10, 5.11**
test('Property 7: category reclassification conserves total spending', () => {
  fc.assert(
    fc.property(scenarioArbitrary, (scenario) => {
      const resultingTreatment = scenario.initialTreatment === 'needs' ? 'wants' : 'needs';
      const targetExpenses = scenario.targetAmounts.map((amountMinor, index) => ({
        id: 100 + index,
        month: MONTH,
        category: scenario.targetCategory,
        amountMinor,
      }));
      const otherExpenses = scenario.otherExpenses.map((expense, index) => ({
        id: 1_000 + index,
        month: MONTH,
        ...expense,
      }));
      const otherMonthExpenses = scenario.otherMonthTargetAmounts.map(
        (amountMinor, index) => ({
          id: 2_000 + index,
          month: OTHER_MONTH,
          category: scenario.targetCategory,
          amountMinor,
        })
      );
      const expenses = [...targetExpenses, ...otherExpenses, ...otherMonthExpenses];
      const otherTreatments = scenario.otherTreatmentSelections.flatMap(
        (treatment, index) => treatment === null
          ? []
          : [{
              id: 10_000 + index,
              category: scenario.otherCategories[index],
              treatment,
            }]
      );
      const initialTreatments = [
        {
          id: 20_000,
          category: scenario.targetCategory,
          treatment: scenario.initialTreatment,
        },
        ...otherTreatments,
      ];
      const resultingTreatments = [
        {
          id: 30_000,
          category: scenario.targetCategory,
          treatment: resultingTreatment,
        },
        ...otherTreatments,
      ];
      const commonInput = {
        month: MONTH,
        expenses,
        needsBudgetMinor: scenario.needsBudgetMinor,
        wantsBudgetMinor: scenario.wantsBudgetMinor,
        salaryMinor: scenario.salaryMinor,
        activeBillsTotalMinor: scenario.activeBillsTotalMinor,
      };
      const initial = createExpenseState({
        ...commonInput,
        categoryTreatments: initialTreatments,
      });
      const reclassified = applyCategoryTreatmentTransition(initial, {
        type: 'set',
        treatment: resultingTreatments[0],
      });
      const expectedInitial = referenceSummary({
        ...commonInput,
        categoryTreatments: initialTreatments,
      });
      const expectedResult = referenceSummary({
        ...commonInput,
        categoryTreatments: resultingTreatments,
      });
      const targetCategoryTotal = canonicalReferenceMinor(
        scenario.targetAmounts.reduce(
          (total, amountMinor) => total + amountMinor,
          0
        )
      );
      const needsDelta = scenario.initialTreatment === 'needs'
        ? referenceSubtractMinor(0, targetCategoryTotal)
        : targetCategoryTotal;
      const wantsDelta = scenario.initialTreatment === 'wants'
        ? referenceSubtractMinor(0, targetCategoryTotal)
        : targetCategoryTotal;
      const totalSpendingDelta = referenceSubtractMinor(
        expectedResult.totalSpendingMinor,
        expectedInitial.totalSpendingMinor
      );
      const projectedSavingsDelta = referenceSubtractMinor(
        expectedResult.projectedSavingsMinor,
        expectedInitial.projectedSavingsMinor
      );

      assert.equal(
        needsDelta,
        referenceSubtractMinor(
          expectedResult.needsSpentMinor,
          expectedInitial.needsSpentMinor
        )
      );
      assert.equal(
        wantsDelta,
        referenceSubtractMinor(
          expectedResult.wantsSpentMinor,
          expectedInitial.wantsSpentMinor
        )
      );

      assert.deepEqual(
        {
          needsSpentMinor: initial.summary.needsSpentMinor,
          wantsSpentMinor: initial.summary.wantsSpentMinor,
          totalSpendingMinor: initial.summary.totalSpendingMinor,
          spendableBudgetMinor: initial.summary.spendableBudgetMinor,
          remainingSpendableMinor: initial.summary.remainingSpendableMinor,
          projectedSavingsMinor: initial.summary.projectedSavingsMinor,
        },
        expectedInitial
      );
      assert.deepEqual(
        {
          needsSpentMinor: reclassified.summary.needsSpentMinor,
          wantsSpentMinor: reclassified.summary.wantsSpentMinor,
          totalSpendingMinor: reclassified.summary.totalSpendingMinor,
          spendableBudgetMinor: reclassified.summary.spendableBudgetMinor,
          remainingSpendableMinor: reclassified.summary.remainingSpendableMinor,
          projectedSavingsMinor: reclassified.summary.projectedSavingsMinor,
        },
        expectedResult
      );

      assert.equal(
        reclassified.summary.needsSpentMinor,
        initial.summary.needsSpentMinor + needsDelta
      );
      assert.equal(
        reclassified.summary.wantsSpentMinor,
        initial.summary.wantsSpentMinor + wantsDelta
      );
      assert.equal(reclassified.summary.totalSpendingMinor, initial.summary.totalSpendingMinor);
      assert.equal(
        reclassified.summary.projectedSavingsMinor,
        initial.summary.projectedSavingsMinor
      );
      assert.equal(
        reclassified.summary.remainingSpendableMinor,
        initial.summary.remainingSpendableMinor
      );
      assert.deepEqual(reclassified.summary.categoryTotals, initial.summary.categoryTotals);
      assert.deepEqual(
        reclassified.summary.applicableExpenseIds,
        initial.summary.applicableExpenseIds
      );

      assert.deepEqual(reclassified.lastTreatmentTransition.affectedExpenseIds, [
        ...targetExpenses.map((expense) => expense.id),
      ]);
      assert.equal(reclassified.lastTreatmentTransition.needsSpentDeltaMinor, needsDelta);
      assert.equal(reclassified.lastTreatmentTransition.wantsSpentDeltaMinor, wantsDelta);
      assert.equal(
        reclassified.lastTreatmentTransition.totalSpendingDeltaMinor,
        totalSpendingDelta
      );
      assert.equal(totalSpendingDelta, 0);
      assert.equal(
        reclassified.lastTreatmentTransition.projectedSavingsDeltaMinor,
        projectedSavingsDelta
      );
      assert.equal(projectedSavingsDelta, 0);

      assertExceededActions(
        initial.summary,
        scenario.needsBudgetMinor,
        scenario.wantsBudgetMinor
      );
      assertExceededActions(
        reclassified.summary,
        scenario.needsBudgetMinor,
        scenario.wantsBudgetMinor
      );
    }),
    { numRuns: NUM_RUNS }
  );
});

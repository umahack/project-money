import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FINANCIAL_CLARITY_TIME_ZONE,
  MONTHLY_PLAN_CALCULATION_ORDER,
  calculateMonthlyPlan,
  calculateMonthlyPlanDeltas,
  calculateMonthlyPlanTransition,
} from '../../src/domain/monthlyPlan.js';

function salary(id, month, amountMinor) {
  return { id, month, amountMinor, confirmedAt: `${month}-01T00:00:00.000Z` };
}

function planInput(overrides = {}) {
  return {
    month: '2026-01',
    localDate: '2026-01-15',
    timeZone: FINANCIAL_CLARITY_TIME_ZONE,
    salaryEntries: [salary(1, '2026-01', 100_000)],
    bills: [],
    expenses: [],
    categoryTreatments: [],
    ...overrides,
  };
}

test('monthly plan filters exact-period records and calculates canonical spending guidance', () => {
  const input = planInput({
    salaryEntries: [
      salary(2, '2025-12', 900_000),
      salary(1, '2026-01', 100_000),
    ],
    bills: [
      { id: 9, label: 'Open bill', amountMinor: 10_000 },
      {
        id: 6,
        label: 'January bill',
        amountMinor: 5_000,
        active: 1,
        effectiveFromMonth: '2026-01',
        effectiveToMonth: '2026-01',
      },
      { id: 7, label: 'Inactive', amountMinor: 80_000, active: 0 },
      {
        id: 8,
        label: 'Future',
        amountMinor: 80_000,
        effectiveFromMonth: '2026-02',
      },
      {
        id: 10,
        label: 'Expired',
        amountMinor: 80_000,
        effectiveToMonth: '2025-12',
      },
    ],
    expenses: [
      { id: 40, month: '2026-01', category: 'Shopping', amountMinor: 2_000 },
      { id: 30, month: '2026-01', category: 'Entertainment', amountMinor: 5_000 },
      { id: 20, month: '2026-01', category: 'Groceries', amountMinor: 10_000 },
      { id: 50, month: '2025-12', category: 'Groceries', amountMinor: 500_000 },
    ],
    categoryTreatments: [
      { id: 51, category: 'shopping', treatment: 'needs' },
    ],
  });
  const unchangedInput = structuredClone(input);

  const result = calculateMonthlyPlan(input);

  assert.deepEqual(input, unchangedInput);
  assert.deepEqual(result.period, {
    month: '2026-01',
    timeZone: 'Asia/Kolkata',
    start: '2026-01-01',
    endExclusive: '2026-02-01',
    asOfDate: '2026-01-15',
    daysRemainingInclusive: 17,
  });
  assert.deepEqual(result.activeBillIds, [6, 9]);
  assert.deepEqual(result.applicableExpenseIds, [20, 30, 40]);
  assert.equal(result.salaryMinor, 100_000);
  assert.equal(result.activeBillsTotalMinor, 15_000);
  assert.equal(result.shortfallMinor, 0);
  assert.equal(result.disposableIncomeMinor, 85_000);
  assert.equal(result.needsBudgetMinor, 42_500);
  assert.equal(result.wantsBudgetMinor, 25_500);
  assert.equal(result.savingsTargetMinor, 17_000);
  assert.equal(result.spendableBudgetMinor, 68_000);
  assert.equal(result.needsSpentMinor, 12_000);
  assert.equal(result.wantsSpentMinor, 5_000);
  assert.equal(result.applicableExpensesTotalMinor, 17_000);
  assert.equal(result.remainingSpendableMinor, 51_000);
  assert.equal(result.dailySpendingGuideMinor, 3_000);
  assert.equal(result.projectedSavingsMinor, 68_000);

  assert.deepEqual(
    result.sourceRefs.map(({ order, sourceType, recordId }) => ({ order, sourceType, recordId })),
    [
      { order: 1, sourceType: 'salary', recordId: 1 },
      { order: 2, sourceType: 'bill', recordId: 6 },
      { order: 3, sourceType: 'bill', recordId: 9 },
      { order: 4, sourceType: 'expense', recordId: 20 },
      { order: 5, sourceType: 'expense', recordId: 30 },
      { order: 6, sourceType: 'expense', recordId: 40 },
      { order: 7, sourceType: 'category_treatment', recordId: 51 },
    ]
  );
  assert.deepEqual(
    result.operations.map((operation) => operation.stage),
    MONTHLY_PLAN_CALCULATION_ORDER
  );
  assert.deepEqual(result.operations[4].appliedTreatments, [
    { expenseId: 20, category: 'Groceries', treatment: 'needs', source: 'default' },
    { expenseId: 30, category: 'Entertainment', treatment: 'wants', source: 'default' },
    { expenseId: 40, category: 'Shopping', treatment: 'needs', source: 'override' },
  ]);
});

test('monthly allocation conserves paise for empty, equal, and excess bill sets', () => {
  const emptyBills = calculateMonthlyPlan(planInput({
    salaryEntries: [salary(1, '2026-01', 3)],
  }));
  assert.deepEqual(
    [emptyBills.needsBudgetMinor, emptyBills.wantsBudgetMinor, emptyBills.savingsTargetMinor],
    [2, 1, 0]
  );
  assert.equal(
    emptyBills.needsBudgetMinor
      + emptyBills.wantsBudgetMinor
      + emptyBills.savingsTargetMinor,
    emptyBills.disposableIncomeMinor
  );
  assert.deepEqual(emptyBills.rounding.savingsTarget, {
    precisionMinor: 1,
    direction: 'half_up',
    adjustmentMinor: -1,
    adjustmentTarget: 'savingsTarget',
  });

  const equalBills = calculateMonthlyPlan(planInput({
    salaryEntries: [salary(1, '2026-01', 100)],
    bills: [{ id: 2, amountMinor: 100 }],
  }));
  assert.equal(equalBills.disposableIncomeMinor, 0);
  assert.equal(equalBills.shortfallMinor, 0);
  assert.deepEqual(
    [
      equalBills.needsBudgetMinor,
      equalBills.wantsBudgetMinor,
      equalBills.savingsTargetMinor,
      equalBills.spendableBudgetMinor,
    ],
    [0, 0, 0, 0]
  );

  const excessBills = calculateMonthlyPlan(planInput({
    salaryEntries: [salary(1, '2026-01', 100)],
    bills: [{ id: 2, amountMinor: 125 }],
  }));
  assert.equal(excessBills.disposableIncomeMinor, 0);
  assert.equal(excessBills.shortfallMinor, 25);
  assert.equal(excessBills.projectedSavingsMinor, 0);
});

test('daily guide uses the injected inclusive local date and half-up signed rounding', () => {
  const leapMonthEnd = calculateMonthlyPlan(planInput({
    month: '2028-02',
    localDate: '2028-02-29',
    salaryEntries: [salary(1, '2028-02', 10)],
  }));
  assert.equal(leapMonthEnd.period.daysRemainingInclusive, 1);
  assert.equal(leapMonthEnd.spendableBudgetMinor, 8);
  assert.equal(leapMonthEnd.dailySpendingGuideMinor, 8);

  const overPace = calculateMonthlyPlan(planInput({
    localDate: '2026-01-30',
    salaryEntries: [salary(1, '2026-01', 100)],
    expenses: [{ id: 2, month: '2026-01', category: 'Other', amountMinor: 81 }],
  }));
  assert.equal(overPace.remainingSpendableMinor, -1);
  assert.equal(overPace.period.daysRemainingInclusive, 2);
  assert.equal(overPace.dailySpendingGuideMinor, -1);
  assert.deepEqual(overPace.rounding.dailySpendingGuide, {
    precisionMinor: 1,
    direction: 'half_up',
    adjustmentMinor: 0,
  });
});

test('monthly plan transition reports exact disposable and daily-guide deltas', () => {
  const preceding = planInput({
    localDate: '2026-01-31',
    salaryEntries: [salary(1, '2026-01', 1_000)],
  });
  const resulting = planInput({
    localDate: '2026-01-31',
    salaryEntries: [salary(1, '2026-01', 1_000)],
    bills: [{ id: 2, label: 'New bill', amountMinor: 100 }],
  });

  const transition = calculateMonthlyPlanTransition({ preceding, resulting });

  assert.equal(transition.preceding.disposableIncomeMinor, 1_000);
  assert.equal(transition.resulting.disposableIncomeMinor, 900);
  assert.deepEqual(transition.deltas, {
    disposableIncomeMinor: -100,
    dailySpendingGuideMinor: -80,
  });
  assert.deepEqual(
    transition.resulting.operations.map(({ order, stage }) => ({ order, stage })),
    MONTHLY_PLAN_CALCULATION_ORDER.map((stage, index) => ({ order: index + 1, stage }))
  );
  assert.deepEqual(
    calculateMonthlyPlanDeltas(transition.preceding, transition.resulting),
    transition.deltas
  );
});

test('monthly plan rejects ambiguous period, zone, source, and amount inputs', () => {
  assert.throws(
    () => calculateMonthlyPlan(planInput({ timeZone: 'UTC' })),
    /timeZone must be Asia\/Kolkata/
  );
  assert.throws(
    () => calculateMonthlyPlan(planInput({ localDate: '2026-02-01' })),
    /localDate must fall within the calculated month/
  );
  assert.throws(
    () => calculateMonthlyPlan(planInput({ localDate: '2026-01-32' })),
    /valid YYYY-MM-DD/
  );
  assert.throws(
    () => calculateMonthlyPlan(planInput({
      salaryEntries: [salary(1, '2026-01', 100), salary(2, '2026-01', 200)],
    })),
    /exactly one confirmed salary/
  );
  assert.throws(
    () => calculateMonthlyPlan(planInput({
      bills: [{ id: 2, amountMinor: 1.5 }],
    })),
    /safe integer/
  );
  assert.throws(
    () => calculateMonthlyPlan(planInput({
      expenses: [
        { id: 2, month: '2026-01', category: 'Food', amountMinor: 1 },
        { id: 2, month: '2025-12', category: 'Food', amountMinor: 1 },
      ],
    })),
    /duplicate record IDs/
  );

  const january = calculateMonthlyPlan(planInput());
  const february = calculateMonthlyPlan(planInput({
    month: '2026-02',
    localDate: '2026-02-15',
    salaryEntries: [salary(1, '2026-02', 100_000)],
  }));
  assert.throws(
    () => calculateMonthlyPlanDeltas(january, february),
    /same month, time zone, and local date/
  );
});

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createIsolatedTestDatabase } from '../helpers/testDatabase.js';

const NOW = new Date('2026-01-15T06:30:00.000Z');

let testDatabase;
let expenseMutations;

before(async () => {
  testDatabase = await createIsolatedTestDatabase();
  expenseMutations = await import('../../src/services/expenseMutations.js');
});

after(async () => {
  await testDatabase?.cleanup();
});

test('normalizes expense create and patch commands to exact paise and derived periods', () => {
  const created = expenseMutations.normalizeExpenseCreateCommand({
    amount: '1250.50',
    category: ' Groceries ',
    note: ' Weekly shop ',
    spentOn: '2026-01-10',
    expectedRecordVersion: 0,
  }, NOW);
  assert.deepEqual(created, {
    command: {
      amountMinor: 125_050,
      category: 'Groceries',
      note: 'Weekly shop',
      spentOn: '2026-01-10',
      month: '2026-01',
    },
    expectedRecordVersion: 0,
  });

  const updated = expenseMutations.normalizeExpenseUpdateCommand({
    amountMinor: 50_025,
    category: 'Entertainment',
    note: '',
    spentOn: '2026-02-01',
    expectedRecordVersion: 3,
  }, '42', NOW);
  assert.deepEqual(updated, {
    command: {
      id: 42,
      patch: {
        amountMinor: 50_025,
        category: 'Entertainment',
        note: null,
        spentOn: '2026-02-01',
        month: '2026-02',
      },
    },
    expectedRecordVersion: 3,
  });
});

test('returns structured field constraints without accepting ambiguous or invalid drafts', () => {
  assert.throws(
    () => expenseMutations.normalizeExpenseCreateCommand({
      amount: '10.00',
      amountMinor: 999,
      category: 'Food',
    }, NOW),
    (error) => (
      error.code === 'AMBIGUOUS_EXPENSE_AMOUNT'
      && error.httpStatus === 400
      && error.field === 'amountMinor'
      && error.constraint.integer === true
    )
  );

  assert.throws(
    () => expenseMutations.normalizeExpenseUpdateCommand({
      spentOn: '2026-02-30',
    }, 42, NOW),
    (error) => (
      error.code === 'INVALID_EXPENSE_DATE'
      && error.httpStatus === 422
      && error.field === 'spentOn'
      && error.constraint.format === 'YYYY-MM-DD'
    )
  );

  assert.throws(
    () => expenseMutations.normalizeExpenseUpdateCommand({
      expectedRecordVersion: 0,
    }, 42, NOW),
    (error) => error.code === 'EMPTY_EXPENSE_UPDATE' && error.httpStatus === 400
  );

  assert.throws(
    () => expenseMutations.normalizeCategoryTreatmentSetCommand(
      { treatment: 'savings' },
      'Food'
    ),
    (error) => (
      error.code === 'INVALID_CATEGORY_TREATMENT'
      && error.httpStatus === 422
      && error.field === 'treatment'
      && error.constraint.allowedValues.includes('needs')
    )
  );
});

test('converts confirmed legacy expense and treatment rows without changing legacy fields', () => {
  assert.deepEqual(expenseMutations.expenseRecordFromRow({
    id: 7,
    month: '2026-01',
    category: 'Food',
    amount: 12.5,
    note: null,
    spent_on: '2026-01-02',
  }), {
    id: 7,
    month: '2026-01',
    category: 'Food',
    amountMinor: 1_250,
    note: null,
    spentOn: '2026-01-02',
    excludeFromDailyAllowance: false,
  });
  assert.deepEqual(expenseMutations.categoryTreatmentRecordFromRow({
    id: 8,
    category: 'Food',
    treatment: 'wants',
  }), {
    id: 8,
    category: 'Food',
    treatment: 'wants',
  });
});

test('normalizes the optional daily allowance exclusion without changing omitted create fingerprints', () => {
  const base = {
    amountMinor: 1_250,
    category: 'Food',
    note: 'Lunch',
    spentOn: '2026-01-10',
  };

  const omitted = expenseMutations.normalizeExpenseCreateCommand(base, NOW);
  const explicitlyCounted = expenseMutations.normalizeExpenseCreateCommand({
    ...base,
    excludeFromDailyAllowance: false,
  }, NOW);
  const excluded = expenseMutations.normalizeExpenseCreateCommand({
    ...base,
    excludeFromDailyAllowance: true,
  }, NOW);

  assert.deepEqual(explicitlyCounted, omitted);
  assert.equal(Object.hasOwn(omitted.command, 'excludeFromDailyAllowance'), false);
  assert.equal(excluded.command.excludeFromDailyAllowance, true);
  assert.deepEqual(
    expenseMutations.normalizeExpenseUpdateCommand({
      excludeFromDailyAllowance: false,
    }, 42, NOW),
    {
      command: { id: 42, patch: { excludeFromDailyAllowance: false } },
      expectedRecordVersion: undefined,
    }
  );
  assert.deepEqual(
    expenseMutations.EXPENSE_ACCEPTED_CONSTRAINTS.excludeFromDailyAllowance,
    { type: 'boolean', optional: true }
  );
});

test('rejects every non-boolean daily allowance exclusion with the fixed field constraint', () => {
  for (const value of [null, 0, 1, 'true', [], {}]) {
    for (const normalize of [
      () => expenseMutations.normalizeExpenseCreateCommand({
        amountMinor: 1_250,
        category: 'Food',
        spentOn: '2026-01-10',
        excludeFromDailyAllowance: value,
      }, NOW),
      () => expenseMutations.normalizeExpenseUpdateCommand({
        excludeFromDailyAllowance: value,
      }, 42, NOW),
    ]) {
      assert.throws(normalize, (error) => (
        error.code === 'INVALID_EXPENSE_EXCLUSION'
        && error.httpStatus === 400
        && error.field === 'excludeFromDailyAllowance'
        && error.message === 'excludeFromDailyAllowance must be a boolean.'
        && error.constraint === expenseMutations.EXPENSE_ACCEPTED_CONSTRAINTS.excludeFromDailyAllowance
      ));
    }
  }
});

test('marks todayAllowance as affected only for current-month expense mutations', async () => {
  const handlers = expenseMutations.createExpenseOperationHandlers({ database: testDatabase.db });
  const current = await handlers['expense.create'].getContext({
    command: { month: '2026-01' },
    idempotencyKey: 'unit-current',
    receipt: null,
    userId: 42,
    now: NOW,
  });
  const past = await handlers['expense.create'].getContext({
    command: { month: '2025-12' },
    idempotencyKey: 'unit-past',
    receipt: null,
    userId: 42,
    now: NOW,
  });

  assert.deepEqual(current.affectedOutcomes.map(({ key }) => key), [
    'monthlyPlan',
    'spending',
    'todayAllowance',
  ]);
  assert.deepEqual(current.affectedOutcomes.at(-1), {
    key: 'todayAllowance',
    id: 'today-allowance:2026-01',
    kind: 'today_allowance',
  });
  assert.deepEqual(past.affectedOutcomes.map(({ key }) => key), [
    'monthlyPlan',
    'spending',
  ]);
});
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createIsolatedTestDatabase } from '../helpers/testDatabase.js';

let testDatabase;
let FinancialMutationError;
let createGoalOperationHandlers;
let goalRecordFromRow;
let normalizeGoalContributionCommand;
let normalizeGoalCreateCommand;
let normalizeGoalUpdateCommand;
let resolveGoalChange;

before(async () => {
  testDatabase = await createIsolatedTestDatabase();
  ({ FinancialMutationError } = await import('../../src/services/financialMutation.js'));
  ({
    createGoalOperationHandlers,
    goalRecordFromRow,
    normalizeGoalContributionCommand,
    normalizeGoalCreateCommand,
    normalizeGoalUpdateCommand,
    resolveGoalChange,
  } = await import('../../src/services/goalMutations.js'));
});

after(async () => {
  await testDatabase?.cleanup();
});

// 2026-03-10 12:00 in Asia/Kolkata.
const NOW = new Date('2026-03-10T06:30:00.000Z');

function assertMutationError(fn, expected) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof FinancialMutationError, 'expected FinancialMutationError');
    for (const [key, value] of Object.entries(expected)) {
      assert.deepEqual(error[key], value, key);
    }
    return true;
  });
}

function fakeDatabase(row) {
  return {
    prepare() {
      return { get: async () => row };
    },
  };
}

function goalRow(overrides = {}) {
  return {
    id: 7,
    name: 'Emergency fund',
    target_amount: 1000,
    saved_amount: 250,
    target_date: '2026-09-30',
    created_at: '2026-01-01 00:00:00',
    updated_at: '2026-01-01 00:00:00',
    ...overrides,
  };
}

test('create normalization accepts paise or decimal aliases and rejects ambiguity', () => {
  const { command } = normalizeGoalCreateCommand({
    name: '  Laptop ',
    targetAmount: '1250.50',
    savedAmount: 10,
    targetDate: '2026-12-31',
  });
  assert.deepEqual(command, {
    name: 'Laptop',
    targetAmountMinor: 125_050,
    savedAmountMinor: 1_000,
    targetDate: '2026-12-31',
  });

  assertMutationError(
    () => normalizeGoalCreateCommand({ targetAmountMinor: 100, targetAmount: '2.00' }),
    { code: 'AMBIGUOUS_GOAL_AMOUNT', httpStatus: 400, field: 'targetAmountMinor' }
  );
  assertMutationError(
    () => normalizeGoalCreateCommand({ targetAmountMinor: 1.5 }),
    { code: 'INVALID_GOAL_AMOUNT_FORMAT', httpStatus: 400 }
  );
  assertMutationError(
    () => normalizeGoalCreateCommand({ name: 'x'.repeat(61) }),
    { code: 'INVALID_GOAL_NAME', httpStatus: 422, field: 'name' }
  );
});

test('update normalization rejects add-to-saved, empty patches, and bad identifiers', () => {
  assertMutationError(
    () => normalizeGoalUpdateCommand({ addToSaved: -5 }, '7'),
    { code: 'GOAL_ADD_TO_SAVED_NOT_SUPPORTED', httpStatus: 400 }
  );
  assertMutationError(
    () => normalizeGoalUpdateCommand({}, '7'),
    { code: 'EMPTY_GOAL_UPDATE', httpStatus: 400 }
  );
  assertMutationError(
    () => normalizeGoalUpdateCommand({ name: 'x' }, '0'),
    { code: 'INVALID_RECORD_ID', httpStatus: 400 }
  );
  const { command } = normalizeGoalUpdateCommand({ setSaved: '12.00' }, '7');
  assert.deepEqual(command, { id: 7, patch: { savedAmountMinor: 1_200 } });
});

test('contribution normalization requires an amount and passes negatives to the domain', () => {
  assertMutationError(
    () => normalizeGoalContributionCommand({}, '7'),
    { code: 'GOAL_CONTRIBUTION_REQUIRED', httpStatus: 400 }
  );
  assertMutationError(
    () => normalizeGoalContributionCommand({ contributionMinor: 1.5 }, '7'),
    { code: 'INVALID_GOAL_CONTRIBUTION', httpStatus: 400 }
  );
  const { command, expectedRecordVersion } = normalizeGoalContributionCommand(
    { contributionMinor: -100, expectedRecordVersion: 2 },
    '7'
  );
  assert.deepEqual(command, { id: 7, contributionMinor: -100 });
  assert.equal(expectedRecordVersion, 2);
});

test('strict create validation names the field and bound for each invalid draft', () => {
  const valid = {
    name: 'Trip',
    targetAmountMinor: 100_000,
    savedAmountMinor: 0,
    targetDate: '2026-03-10',
  };
  assert.equal(resolveGoalChange({ draft: valid, now: NOW }).targetDate, '2026-03-10');

  const cases = [
    [{ name: '   ' }, 'INVALID_GOAL_NAME', 'name'],
    [{ targetAmountMinor: 0 }, 'INVALID_GOAL_TARGET_AMOUNT', 'targetAmountMinor'],
    [{ savedAmountMinor: -1 }, 'INVALID_GOAL_SAVED_AMOUNT', 'savedAmountMinor'],
    [{ savedAmountMinor: 100_001 }, 'GOAL_SAVED_AMOUNT_EXCEEDS_TARGET', 'savedAmountMinor'],
    [{ targetDate: '2026-03-09' }, 'GOAL_TARGET_DATE_IN_PAST', 'targetDate'],
    [{ targetDate: '2026-02-30' }, 'INVALID_GOAL_TARGET_DATE', 'targetDate'],
    [{ targetDate: null }, 'INVALID_GOAL_TARGET_DATE', 'targetDate'],
  ];
  for (const [change, code, field] of cases) {
    assertMutationError(
      () => resolveGoalChange({ draft: { ...valid, ...change }, now: NOW }),
      { code, field, httpStatus: 422 }
    );
  }
  assert.equal(
    resolveGoalChange({ draft: { ...valid, savedAmountMinor: 100_000 }, now: NOW })
      .savedAmountMinor,
    100_000
  );
});

test('legacy-invalid fields do not block correcting a different field', () => {
  const overfundedUndated = {
    id: 9,
    name: 'Legacy',
    targetAmountMinor: 100_000,
    savedAmountMinor: 125_000,
    targetDate: null,
  };
  // Renaming leaves the legacy overfunded amount and missing date untouched.
  const renamed = resolveGoalChange({
    preceding: overfundedUndated,
    draft: { name: 'Renamed' },
    now: NOW,
  });
  assert.equal(renamed.name, 'Renamed');
  assert.equal(renamed.savedAmountMinor, 125_000);

  // Changing an amount re-checks the saved/target relation.
  assertMutationError(
    () => resolveGoalChange({
      preceding: overfundedUndated,
      draft: { targetAmountMinor: 110_000 },
      now: NOW,
    }),
    { code: 'GOAL_SAVED_AMOUNT_EXCEEDS_TARGET' }
  );
  const corrected = resolveGoalChange({
    preceding: overfundedUndated,
    draft: { savedAmountMinor: 100_000 },
    now: NOW,
  });
  assert.equal(corrected.savedAmountMinor, 100_000);

  // A changed date is still validated; the contract flow cannot clear it.
  assertMutationError(
    () => resolveGoalChange({
      preceding: overfundedUndated,
      draft: { targetDate: '2026-01-01' },
      now: NOW,
    }),
    { code: 'GOAL_TARGET_DATE_IN_PAST', field: 'targetDate' }
  );
});

test('legacy requests may keep a goal undated, but contract requests may not', () => {
  const draft = {
    name: 'Open ended',
    targetAmountMinor: 5_000,
    savedAmountMinor: 0,
    targetDate: null,
  };
  const legacy = resolveGoalChange({ draft, now: NOW, legacyUndated: true });
  assert.equal(legacy.targetDate, null);
  assertMutationError(
    () => resolveGoalChange({ draft, now: NOW }),
    { code: 'INVALID_GOAL_TARGET_DATE' }
  );
});

test('an unchanged past date on a valid goal does not block other edits', () => {
  const overdue = {
    id: 3,
    name: 'Overdue',
    targetAmountMinor: 10_000,
    savedAmountMinor: 1_000,
    targetDate: '2026-01-01',
  };
  const result = resolveGoalChange({
    preceding: overdue,
    draft: { name: 'Still overdue' },
    now: NOW,
  });
  assert.equal(result.targetDate, '2026-01-01');
  assertMutationError(
    () => resolveGoalChange({
      preceding: overdue,
      draft: { targetDate: '2026-02-01' },
      now: NOW,
    }),
    { code: 'GOAL_TARGET_DATE_IN_PAST' }
  );
});

test('contribution bounds are exact at the current funding gap', async () => {
  const handlers = createGoalOperationHandlers({ database: fakeDatabase(goalRow()) });
  const base = {
    userId: 1,
    idempotencyKey: '11111111-1111-4111-8111-111111111111',
    now: NOW,
  };
  const gapMinor = 75_000; // 1000.00 target minus 250.00 saved

  const atGap = await handlers['goal.contribute'].prepare({
    ...base,
    command: { id: 7, contributionMinor: gapMinor },
  });
  assert.equal(atGap.result.goal.savedAmountMinor, 100_000);
  assert.equal(atGap.result.outcome.status, 'funded');
  assert.equal(atGap.result.outcome.fundingGapMinor, 0);
  assert.equal(atGap.sourceStatement.args[0], 250);
  assert.equal(atGap.sourceStatement.args[1], 1000);

  const atOne = await handlers['goal.contribute'].prepare({
    ...base,
    command: { id: 7, contributionMinor: 1 },
  });
  assert.equal(atOne.result.goal.savedAmountMinor, 25_001);

  for (const contributionMinor of [gapMinor + 1, 0, -1, -gapMinor]) {
    await assert.rejects(
      handlers['goal.contribute'].prepare({
        ...base,
        command: { id: 7, contributionMinor },
      }),
      (error) => {
        assert.equal(error.httpStatus, 422);
        assert.equal(error.code, 'GOAL_CONTRIBUTION_OUT_OF_RANGE');
        assert.equal(error.field, 'contributionMinor');
        assert.deepEqual(error.constraint, {
          minMinor: 1,
          maxMinor: gapMinor,
          integer: true,
        });
        return true;
      }
    );
  }
});

test('a funded goal accepts no contribution and a legacy-invalid goal must be corrected first', async () => {
  const funded = createGoalOperationHandlers({
    database: fakeDatabase(goalRow({ saved_amount: 1000 })),
  });
  await assert.rejects(
    funded['goal.contribute'].prepare({
      userId: 1,
      idempotencyKey: '22222222-2222-4222-8222-222222222222',
      now: NOW,
      command: { id: 7, contributionMinor: 1 },
    }),
    (error) => {
      assert.equal(error.code, 'GOAL_CONTRIBUTION_OUT_OF_RANGE');
      assert.equal(error.constraint.maxMinor, 0);
      return true;
    }
  );

  const legacy = createGoalOperationHandlers({
    database: fakeDatabase(goalRow({ saved_amount: 1250, target_date: null })),
  });
  await assert.rejects(
    legacy['goal.contribute'].prepare({
      userId: 1,
      idempotencyKey: '33333333-3333-4333-8333-333333333333',
      now: NOW,
      command: { id: 7, contributionMinor: 100 },
    }),
    (error) => {
      assert.equal(error.code, 'GOAL_REQUIRES_CORRECTION');
      assert.equal(error.httpStatus, 422);
      return true;
    }
  );
});

test('a missing or unowned goal yields a placeholder plan for the uniform 404', async () => {
  const handlers = createGoalOperationHandlers({ database: fakeDatabase(undefined) });
  const plan = await handlers['goal.contribute'].prepare({
    userId: 1,
    idempotencyKey: '44444444-4444-4444-8444-444444444444',
    now: NOW,
    command: { id: 99, contributionMinor: -5 },
  });
  assert.equal(plan.recordType, 'goal');
  assert.equal(plan.recordId, 99);
});

test('goal records tolerate sub-paise legacy amounts without throwing', () => {
  const record = goalRecordFromRow(goalRow({ target_amount: 10.005 }));
  assert.equal(record.targetAmountMinor, null);
  assert.equal(record.savedAmountMinor, 25_000);
});

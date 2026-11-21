import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createIsolatedTestDatabase } from '../helpers/testDatabase.js';

const NOW = new Date('2026-01-15T06:30:00.000Z');
const MONTH = '2026-01';

let testDatabase;
let db;
let FinancialMutationService;
let FinancialRepository;
let ClarityService;

before(async () => {
  testDatabase = await createIsolatedTestDatabase();
  db = testDatabase.db;
  ({ FinancialMutationService } = await import('../../src/services/financialMutation.js'));
  ({ FinancialRepository } = await import('../../src/repositories/financialRepository.js'));
  ({ ClarityService } = await import('../../src/services/clarityService.js'));
  await db.prepare(`CREATE TABLE injected_financial_mutation_failures (
    id INTEGER PRIMARY KEY,
    allowed INTEGER NOT NULL CHECK (allowed = 1)
  )`).run();
});

beforeEach(async () => {
  await testDatabase.reset();
});

after(async () => {
  await testDatabase?.cleanup();
});

async function insertUser(id, email = `financial-mutation-${id}@example.test`) {
  await db.prepare(
    'INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)'
  ).run(id, email, `Mutation User ${id}`, 'test-password-hash');
}

function affectedExpenseOutcomes(month) {
  return [
    {
      key: 'monthlyPlan',
      id: `monthly-plan:${month}`,
      kind: 'monthly_plan',
    },
    {
      key: 'spending',
      id: `spending:${month}`,
      kind: 'spending',
    },
  ];
}

function expenseContext({ command, idempotencyKey, receipt }) {
  const recordId = receipt?.recordId ?? command.id ?? null;
  return {
    snapshotMonth: command.month,
    scopeKey: recordId === null
      ? `new-expense:${idempotencyKey}`
      : `expense:${recordId}`,
    affectedOutcomes: affectedExpenseOutcomes(command.month),
  };
}

function operationHandlers() {
  return {
    'expense.create': {
      getContext: expenseContext,
      async prepare({ command, userId }) {
        const sourceStatement = command.failAt === 'source'
          ? {
              sql: 'INSERT INTO injected_financial_mutation_failures (id, allowed) VALUES (?, ?)',
              args: [command.failureId, 0],
            }
          : {
              sql: `INSERT INTO expense_log
                (user_id, month, category, amount, note, spent_on, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
              args: [
                userId,
                command.month,
                command.category,
                command.amountMinor / 100,
                command.note ?? null,
                command.spentOn,
              ],
            };
        const linkedStatements = [];
        if (command.treatment) {
          linkedStatements.push({
            sql: `INSERT INTO expense_category_treatments
              (user_id, category, treatment)
              VALUES (?, ?, ?)
              ON CONFLICT(user_id, category) DO UPDATE SET
                treatment = excluded.treatment,
                updated_at = CURRENT_TIMESTAMP`,
            args: [userId, command.category, command.treatment],
          });
        }
        if (command.failAt === 'linked') {
          linkedStatements.push({
            sql: 'INSERT INTO injected_financial_mutation_failures (id, allowed) VALUES (?, ?)',
            args: [command.failureId, 0],
          });
        }
        return {
          action: 'create',
          recordType: 'expense',
          recordId: null,
          sourceStatement,
          linkedStatements,
        };
      },
    },
    'expense.update': {
      getContext: expenseContext,
      async prepare({ command, userId }) {
        return {
          action: 'update',
          recordType: 'expense',
          recordId: command.id,
          sourceStatement: {
            sql: `UPDATE expense_log
                     SET amount = ?, updated_at = CURRENT_TIMESTAMP
                   WHERE id = ? AND user_id = ?`,
            args: [command.amountMinor / 100, command.id, userId],
          },
        };
      },
    },
    'expense.delete': {
      getContext: expenseContext,
      async prepare({ command, userId }) {
        return {
          action: 'delete',
          recordType: 'expense',
          recordId: command.id,
          sourceStatement: {
            sql: 'DELETE FROM expense_log WHERE id = ? AND user_id = ?',
            args: [command.id, userId],
          },
        };
      },
    },
  };
}

function createService({ snapshotService } = {}) {
  const repository = new FinancialRepository(db);
  return new FinancialMutationService({
    database: db,
    snapshotService: snapshotService ?? new ClarityService({ repository }),
    operationHandlers: operationHandlers(),
    fingerprintKey: randomBytes(32),
    clock: () => new Date(NOW),
  });
}

function createExpenseCommand(overrides = {}) {
  return {
    amountMinor: 1_250,
    category: 'Groceries',
    month: MONTH,
    note: null,
    spentOn: '2026-01-10',
    ...overrides,
  };
}

async function count(sql, ...args) {
  const row = await db.prepare(sql).get(...args);
  return Number(row.count);
}

async function dataVersion(userId) {
  const row = await db.prepare(
    'SELECT data_version FROM user_financial_state WHERE user_id = ?'
  ).get(userId);
  return row ? Number(row.data_version) : null;
}

async function seedExpense({ userId, expenseId, amount = 10 }) {
  await db.prepare(
    `INSERT INTO expense_log
      (id, user_id, month, category, amount, spent_on)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(expenseId, userId, MONTH, 'Groceries', amount, '2026-01-10');
}

test('claims a UUID key, commits source/link/receipt/version, and replays canonical bodies once', async () => {
  const userId = 101;
  const idempotencyKey = '10000000-0000-4000-8000-000000000001';
  await insertUser(userId);
  const service = createService();
  const command = createExpenseCommand({ treatment: 'needs' });

  const first = await service.execute({
    userId,
    idempotencyKey,
    operation: 'expense.create',
    command,
    expectedRecordVersion: 0,
  });
  const replay = await service.execute({
    userId,
    idempotencyKey: idempotencyKey.toUpperCase(),
    operation: 'expense.create',
    command: {
      spentOn: command.spentOn,
      treatment: command.treatment,
      note: command.note,
      month: command.month,
      category: command.category,
      amountMinor: command.amountMinor,
    },
    expectedRecordVersion: 0,
  });

  assert.equal(first.mutation.replayed, false);
  assert.equal(replay.mutation.replayed, true);
  assert.equal(replay.mutation.changeId, first.mutation.changeId);
  assert.equal(replay.mutation.recordId, first.mutation.recordId);
  assert.equal(replay.mutation.recordVersion, 1);
  assert.equal(first.clarity.dataVersion, 1);
  assert.equal(replay.clarity.dataVersion, 1);
  assert.equal(await count('SELECT COUNT(*) AS count FROM expense_log WHERE user_id = ?', userId), 1);
  assert.equal(await count('SELECT COUNT(*) AS count FROM expense_category_treatments WHERE user_id = ?', userId), 1);
  assert.equal(await count('SELECT COUNT(*) AS count FROM financial_record_changes WHERE user_id = ?', userId), 1);
  assert.equal(await dataVersion(userId), 1);

  const receipt = await db.prepare(
    `SELECT request_fingerprint_hmac
       FROM financial_record_changes
      WHERE user_id = ? AND idempotency_key = ?`
  ).get(userId, idempotencyKey);
  assert.match(receipt.request_fingerprint_hmac, /^[0-9a-f]{64}$/);
  assert.equal(receipt.request_fingerprint_hmac.includes(String(command.amountMinor)), false);

  await assert.rejects(
    service.execute({
      userId,
      idempotencyKey,
      operation: 'expense.create',
      command: createExpenseCommand({ amountMinor: command.amountMinor + 1 }),
      expectedRecordVersion: 0,
    }),
    (error) => error?.code === 'IDEMPOTENCY_KEY_REUSED' && error?.httpStatus === 409
  );
  assert.equal(await count('SELECT COUNT(*) AS count FROM expense_log WHERE user_id = ?', userId), 1);
  assert.equal(await dataVersion(userId), 1);
});

test('rolls back receipt, source, linked rows, and data version when a linked write fails', async () => {
  const userId = 102;
  await insertUser(userId);
  const service = createService();

  await assert.rejects(
    service.execute({
      userId,
      idempotencyKey: '20000000-0000-4000-8000-000000000002',
      operation: 'expense.create',
      command: createExpenseCommand({
        treatment: 'wants',
        failAt: 'linked',
        failureId: 1,
      }),
      expectedRecordVersion: 0,
    }),
    (error) => error?.code === 'MUTATION_FAILED'
  );

  assert.equal(await count('SELECT COUNT(*) AS count FROM expense_log WHERE user_id = ?', userId), 0);
  assert.equal(await count('SELECT COUNT(*) AS count FROM expense_category_treatments WHERE user_id = ?', userId), 0);
  assert.equal(await count('SELECT COUNT(*) AS count FROM financial_record_changes WHERE user_id = ?', userId), 0);
  assert.equal(await dataVersion(userId), null);
});

test('rejects wrong-owner updates without revealing or changing the record', async () => {
  const ownerId = 103;
  const otherUserId = 104;
  const expenseId = 1_003;
  await insertUser(ownerId);
  await insertUser(otherUserId);
  await seedExpense({ userId: ownerId, expenseId, amount: 10 });
  const service = createService();

  await assert.rejects(
    service.execute({
      userId: otherUserId,
      idempotencyKey: '30000000-0000-4000-8000-000000000003',
      operation: 'expense.update',
      command: createExpenseCommand({ id: expenseId, amountMinor: 9_999 }),
      expectedRecordVersion: 0,
    }),
    (error) => (
      error?.code === 'FINANCIAL_RECORD_NOT_FOUND'
      && error?.httpStatus === 404
      && !Object.hasOwn(error, 'ownerId')
    )
  );

  const expense = await db.prepare(
    'SELECT user_id, amount FROM expense_log WHERE id = ?'
  ).get(expenseId);
  assert.equal(Number(expense.user_id), ownerId);
  assert.equal(Number(expense.amount), 10);
  assert.equal(await count('SELECT COUNT(*) AS count FROM financial_record_changes'), 0);
  assert.equal(await dataVersion(otherUserId), null);
});

test('enforces expected versions and allows only one concurrent next record version', async () => {
  const userId = 105;
  const expenseId = 1_005;
  await insertUser(userId);
  await seedExpense({ userId, expenseId, amount: 10 });
  const service = createService();

  const initial = await service.execute({
    userId,
    idempotencyKey: '40000000-0000-4000-8000-000000000004',
    operation: 'expense.update',
    command: createExpenseCommand({ id: expenseId, amountMinor: 2_000 }),
    expectedRecordVersion: 0,
  });
  assert.equal(initial.mutation.recordVersion, 1);

  await assert.rejects(
    service.execute({
      userId,
      idempotencyKey: '40000000-0000-4000-8000-000000000005',
      operation: 'expense.update',
      command: createExpenseCommand({ id: expenseId, amountMinor: 2_500 }),
      expectedRecordVersion: 0,
    }),
    (error) => error?.code === 'RECORD_VERSION_CONFLICT'
      && error?.currentRecordVersion === 1
  );

  const concurrent = await Promise.allSettled([
    service.execute({
      userId,
      idempotencyKey: '40000000-0000-4000-8000-000000000006',
      operation: 'expense.update',
      command: createExpenseCommand({ id: expenseId, amountMinor: 3_000 }),
      expectedRecordVersion: 1,
    }),
    service.execute({
      userId,
      idempotencyKey: '40000000-0000-4000-8000-000000000007',
      operation: 'expense.update',
      command: createExpenseCommand({ id: expenseId, amountMinor: 4_000 }),
      expectedRecordVersion: 1,
    }),
  ]);

  const fulfilled = concurrent.filter(({ status }) => status === 'fulfilled');
  const rejected = concurrent.filter(({ status }) => status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(fulfilled[0].value.mutation.recordVersion, 2);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, 'RECORD_VERSION_CONFLICT');
  assert.equal(rejected[0].reason.currentRecordVersion, 2);
  assert.equal(await count('SELECT COUNT(*) AS count FROM financial_record_changes WHERE user_id = ?', userId), 2);
  assert.equal(await dataVersion(userId), 2);

  const finalExpense = await db.prepare(
    'SELECT amount FROM expense_log WHERE id = ? AND user_id = ?'
  ).get(expenseId, userId);
  assert.ok([30, 40].includes(Number(finalExpense.amount)));
});

test('delete replay removes a confirmed expense exactly once', async () => {
  const userId = 106;
  const expenseId = 1_006;
  const idempotencyKey = '50000000-0000-4000-8000-000000000008';
  await insertUser(userId);
  await seedExpense({ userId, expenseId, amount: 10 });
  const service = createService();
  const input = {
    userId,
    idempotencyKey,
    operation: 'expense.delete',
    command: createExpenseCommand({ id: expenseId }),
    expectedRecordVersion: 0,
  };

  const first = await service.execute(input);
  const replay = await service.execute(input);

  assert.equal(first.mutation.status, 'reversed');
  assert.equal(replay.mutation.replayed, true);
  assert.equal(replay.mutation.changeId, first.mutation.changeId);
  assert.equal(await count('SELECT COUNT(*) AS count FROM expense_log WHERE id = ?', expenseId), 0);
  assert.equal(await count('SELECT COUNT(*) AS count FROM financial_record_changes WHERE user_id = ?', userId), 1);
  assert.equal(await dataVersion(userId), 1);
});

test('calculates after commit and keeps only a failed dependent outcome unavailable', async () => {
  const userId = 107;
  await insertUser(userId);
  await db.prepare(
    'INSERT INTO salary_entries (user_id, month, amount) VALUES (?, ?, ?)'
  ).run(userId, MONTH, 1_000);
  const repository = new FinancialRepository(db);
  const snapshotService = new ClarityService({
    repository,
    expenseSummaryCalculator() {
      throw new Error('injected dependent calculation failure');
    },
  });
  const service = createService({ snapshotService });

  const result = await service.execute({
    userId,
    idempotencyKey: '60000000-0000-4000-8000-000000000009',
    operation: 'expense.create',
    command: createExpenseCommand({ amountMinor: 5_000 }),
    expectedRecordVersion: 0,
  });

  assert.equal(result.mutation.status, 'confirmed');
  assert.equal(result.clarity.dataVersion, 1);
  assert.equal(result.clarity.outcomes.monthlyPlan.status, 'available');
  assert.equal(result.clarity.outcomes.spending.status, 'calculation_failed');
  assert.equal(result.clarity.outcomes.spending.confirmedInputsRetained, true);
  assert.equal(result.clarity.outcomes.spending.retry.action, 'recalculate');
  assert.ok(result.clarity.facts.some(({ source }) => (
    source.sourceType === 'expense' && source.recordId === result.mutation.recordId
  )));
  assert.equal(await count('SELECT COUNT(*) AS count FROM expense_log WHERE user_id = ?', userId), 1);
  assert.equal(await count('SELECT COUNT(*) AS count FROM financial_record_changes WHERE user_id = ?', userId), 1);
  assert.equal(await dataVersion(userId), 1);
});

test('returns a confirmed mutation with minimal failure outcomes if snapshot assembly throws', async () => {
  const userId = 108;
  await insertUser(userId);
  const service = createService({
    snapshotService: {
      async getSnapshot() {
        throw new Error('injected snapshot assembly failure');
      },
    },
  });

  const result = await service.execute({
    userId,
    idempotencyKey: '70000000-0000-4000-8000-000000000010',
    operation: 'expense.create',
    command: createExpenseCommand(),
    expectedRecordVersion: 0,
  });

  assert.equal(result.mutation.status, 'confirmed');
  assert.equal(result.clarity.partial, true);
  assert.equal(result.clarity.dataVersion, 1);
  assert.deepEqual(Object.keys(result.clarity.outcomes).sort(), ['monthlyPlan', 'spending']);
  assert.ok(Object.values(result.clarity.outcomes).every((outcome) => (
    outcome.status === 'calculation_failed'
    && outcome.confirmedInputsRetained === true
    && outcome.retry.action === 'recalculate'
  )));
  assert.equal(await count('SELECT COUNT(*) AS count FROM expense_log WHERE user_id = ?', userId), 1);
  assert.equal(await count('SELECT COUNT(*) AS count FROM financial_record_changes WHERE user_id = ?', userId), 1);
  assert.equal(await dataVersion(userId), 1);
});

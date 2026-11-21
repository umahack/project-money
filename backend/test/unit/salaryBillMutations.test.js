import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createIsolatedTestDatabase } from '../helpers/testDatabase.js';

const NOW = new Date('2026-01-15T06:30:00.000Z');
const MONTH = '2026-01';

let testDatabase;
let db;
let createSalaryBillMutationService;
let FinancialRepository;
let ClarityService;

before(async () => {
  testDatabase = await createIsolatedTestDatabase();
  db = testDatabase.db;
  ({ createSalaryBillMutationService } = await import(
    '../../src/services/salaryBillMutations.js'
  ));
  ({ FinancialRepository } = await import('../../src/repositories/financialRepository.js'));
  ({ ClarityService } = await import('../../src/services/clarityService.js'));
});

beforeEach(async () => {
  await testDatabase.reset();
});

after(async () => {
  await testDatabase?.cleanup();
});

async function insertUser(id) {
  await db.prepare(
    'INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)'
  ).run(id, `salary-bill-${id}@example.test`, `Salary Bill ${id}`, 'test-password-hash');
}

function createService() {
  const repository = new FinancialRepository(db);
  return createSalaryBillMutationService({
    database: db,
    snapshotService: new ClarityService({ repository }),
    fingerprintKey: Buffer.from('unit-test-salary-bill-hmac-key-at-least-32-bytes'),
    clock: () => new Date(NOW),
  });
}

async function count(sql, ...args) {
  const row = await db.prepare(sql).get(...args);
  return Number(row.count);
}

test('salary and bill handlers commit source rows, receipts, and versions through the mutation service', async () => {
  const userId = 701;
  await insertUser(userId);
  const service = createService();

  const salary = await service.execute({
    userId,
    idempotencyKey: '91000000-0000-4000-8000-000000000001',
    operation: 'salary.upsert',
    command: { month: MONTH, amountMinor: 5_000_000 },
    expectedRecordVersion: 0,
  });
  const bill = await service.execute({
    userId,
    idempotencyKey: '91000000-0000-4000-8000-000000000002',
    operation: 'bill.create',
    command: {
      label: 'January rent',
      amountMinor: 2_000_000,
      category: 'Rent',
      active: true,
      effectiveFromMonth: MONTH,
      effectiveToMonth: MONTH,
      snapshotMonth: MONTH,
    },
    expectedRecordVersion: 0,
  });

  assert.equal(salary.mutation.recordType, 'salary');
  assert.equal(salary.mutation.recordVersion, 1);
  assert.equal(bill.mutation.recordType, 'bill');
  assert.equal(bill.mutation.recordVersion, 1);
  assert.equal(bill.clarity.dataVersion, 2);
  assert.equal(
    bill.clarity.outcomes.monthlyPlan.value.disposableIncome.amountMinor,
    3_000_000
  );
  assert.equal(await count(
    'SELECT COUNT(*) AS count FROM financial_record_changes WHERE user_id = ?',
    userId
  ), 2);
  assert.equal(await count(
    'SELECT COUNT(*) AS count FROM user_financial_state WHERE user_id = ? AND data_version = 2',
    userId
  ), 1);
});

test('salary apply copies a valid prior amount once and leaves the source record unchanged', async () => {
  const userId = 702;
  const sourceMonth = '2025-12';
  const key = '92000000-0000-4000-8000-000000000003';
  await insertUser(userId);
  await db.prepare(
    'INSERT INTO salary_entries (user_id, month, amount) VALUES (?, ?, ?)'
  ).run(userId, sourceMonth, 12_345.67);
  const service = createService();
  const input = {
    userId,
    idempotencyKey: key,
    operation: 'salary.apply',
    command: { sourceMonth, targetMonth: MONTH },
    expectedRecordVersion: 0,
  };

  const first = await service.execute(input);
  const replay = await service.execute(input);

  assert.equal(first.mutation.replayed, false);
  assert.equal(replay.mutation.replayed, true);
  assert.equal(replay.mutation.changeId, first.mutation.changeId);
  const rows = await db.prepare(
    `SELECT month, amount FROM salary_entries
      WHERE user_id = ? ORDER BY month`
  ).all(userId);
  assert.deepEqual(rows.map((row) => [row.month, Number(row.amount)]), [
    [sourceMonth, 12_345.67],
    [MONTH, 12_345.67],
  ]);
  assert.equal(await count(
    'SELECT COUNT(*) AS count FROM financial_record_changes WHERE user_id = ?',
    userId
  ), 1);
});

test('bill handler rejects an invalid merged effective range without a receipt or source rewrite', async () => {
  const userId = 703;
  await insertUser(userId);
  const inserted = await db.prepare(
    `INSERT INTO emis
      (user_id, label, amount, category, active, effective_from_month, effective_to_month)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(userId, 'Bounded utility', 1_500, 'Utility', 1, '2026-01', '2026-03');
  const service = createService();

  await assert.rejects(
    service.execute({
      userId,
      idempotencyKey: '93000000-0000-4000-8000-000000000004',
      operation: 'bill.update',
      command: {
        id: inserted.lastInsertRowid,
        patch: { effectiveToMonth: '2025-12' },
        snapshotMonth: MONTH,
      },
      expectedRecordVersion: 0,
    }),
    (error) => (
      error?.code === 'INVALID_BILL_EFFECTIVE_RANGE'
      && error?.httpStatus === 422
    )
  );

  const retained = await db.prepare(
    `SELECT effective_from_month, effective_to_month
       FROM emis WHERE id = ? AND user_id = ?`
  ).get(inserted.lastInsertRowid, userId);
  assert.equal(retained.effective_from_month, '2026-01');
  assert.equal(retained.effective_to_month, '2026-03');
  assert.equal(await count(
    'SELECT COUNT(*) AS count FROM financial_record_changes WHERE user_id = ?',
    userId
  ), 0);
  assert.equal(await count(
    'SELECT COUNT(*) AS count FROM user_financial_state WHERE user_id = ?',
    userId
  ), 0);
});

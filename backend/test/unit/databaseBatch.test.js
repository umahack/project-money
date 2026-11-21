import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createIsolatedTestDatabase } from '../helpers/testDatabase.js';

let testDatabase;
let db;

before(async () => {
  testDatabase = await createIsolatedTestDatabase();
  db = testDatabase.db;
  await db.prepare(`CREATE TABLE injected_batch_failures (
    id INTEGER PRIMARY KEY,
    allowed INTEGER NOT NULL CHECK (allowed = 1)
  )`).run();
});

after(async () => {
  await testDatabase?.cleanup();
});

async function insertUser(id, email) {
  await db.prepare(
    'INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)'
  ).run(id, email, `User ${id}`, 'test-password-hash');
}

function linkedFinancialWrites({ userId, expenseId, changeId, idempotencyKey }) {
  return [
    {
      sql: `INSERT INTO expense_log
        (id, user_id, month, category, amount, note, spent_on)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [expenseId, userId, '2026-01', 'Groceries', 125.5, null, '2026-01-15'],
    },
    [
      `INSERT INTO financial_record_changes
        (id, user_id, idempotency_key, request_fingerprint_hmac, operation,
         record_type, record_id, record_version, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        changeId,
        userId,
        idempotencyKey,
        `test-hmac-${changeId}`,
        'expense.create',
        'expense',
        expenseId,
        1,
        'confirmed',
      ],
    ],
    {
      sql: `INSERT INTO user_financial_state (user_id, data_version)
        VALUES (?, 1)
        ON CONFLICT(user_id) DO UPDATE SET
          data_version = user_financial_state.data_version + 1,
          updated_at = CURRENT_TIMESTAMP`,
      args: [userId],
    },
  ];
}

test('write batch commits linked source, receipt, and version rows atomically', async () => {
  const userId = 3101;
  const expenseId = 4101;
  const changeId = 5101;
  await insertUser(userId, 'batch-success@example.test');

  const results = await db.batch(linkedFinancialWrites({
    userId,
    expenseId,
    changeId,
    idempotencyKey: '00000000-0000-4000-8000-000000000101',
  }));

  assert.deepEqual(results.map(({ changes }) => changes), [1, 1, 1]);
  assert.deepEqual(
    Object.keys(results[0]).sort(),
    ['changes', 'lastInsertRowid'],
    'batch results should preserve the prepare(...).run() result shape'
  );

  const expense = await db.prepare(
    'SELECT id, user_id, amount FROM expense_log WHERE id = ?'
  ).get(expenseId);
  const receipt = await db.prepare(
    'SELECT id, record_id, record_version FROM financial_record_changes WHERE id = ?'
  ).get(changeId);
  const state = await db.prepare(
    'SELECT data_version FROM user_financial_state WHERE user_id = ?'
  ).get(userId);

  assert.deepEqual(
    { id: Number(expense.id), userId: Number(expense.user_id), amount: Number(expense.amount) },
    { id: expenseId, userId, amount: 125.5 }
  );
  assert.deepEqual(
    { id: Number(receipt.id), recordId: Number(receipt.record_id), version: Number(receipt.record_version) },
    { id: changeId, recordId: expenseId, version: 1 }
  );
  assert.equal(Number(state.data_version), 1);
});

test('an injected failure at any batch position rolls back every linked write', async (t) => {
  for (let failureIndex = 0; failureIndex <= 3; failureIndex += 1) {
    await t.test(`failure at position ${failureIndex}`, async () => {
      const userId = 3200 + failureIndex;
      const expenseId = 4200 + failureIndex;
      const changeId = 5200 + failureIndex;
      await insertUser(userId, `batch-rollback-${failureIndex}@example.test`);

      const statements = linkedFinancialWrites({
        userId,
        expenseId,
        changeId,
        idempotencyKey: `00000000-0000-4000-8000-00000000020${failureIndex}`,
      });
      statements.splice(failureIndex, 0, {
        sql: 'INSERT INTO injected_batch_failures (id, allowed) VALUES (?, ?)',
        args: [failureIndex + 1, 0],
      });

      await assert.rejects(
        db.batch(statements),
        (error) => error?.code === 'SQLITE_CONSTRAINT_CHECK'
      );

      const counts = await Promise.all([
        db.prepare('SELECT COUNT(*) AS count FROM expense_log WHERE id = ?').get(expenseId),
        db.prepare('SELECT COUNT(*) AS count FROM financial_record_changes WHERE id = ?').get(changeId),
        db.prepare('SELECT COUNT(*) AS count FROM user_financial_state WHERE user_id = ?').get(userId),
        db.prepare('SELECT COUNT(*) AS count FROM injected_batch_failures WHERE id = ?').get(failureIndex + 1),
      ]);
      assert.deepEqual(counts.map((row) => Number(row.count)), [0, 0, 0, 0]);
    });
  }
});

test('prepare run and write batch normalize constraint failures consistently', async () => {
  await insertUser(3301, 'constraint-normalization@example.test');

  await assert.rejects(
    db.prepare(
      'INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)'
    ).run(3302, 'constraint-normalization@example.test', 'Duplicate', 'test-password-hash'),
    (error) => error?.code === 'SQLITE_CONSTRAINT_UNIQUE'
  );

  await assert.rejects(
    db.batch([{
      sql: 'INSERT INTO injected_batch_failures (id, allowed) VALUES (?, ?)',
      args: [99, 0],
    }]),
    (error) => error?.code === 'SQLITE_CONSTRAINT_CHECK'
  );
});

test('batch rejects non-write modes and malformed statement collections', async () => {
  await assert.rejects(
    db.batch([], 'read'),
    /support write mode only/
  );
  await assert.rejects(
    db.batch('DELETE FROM users'),
    /statements must be an array/
  );
  await assert.rejects(
    db.batch([['', []]]),
    /must contain non-empty SQL/
  );
});

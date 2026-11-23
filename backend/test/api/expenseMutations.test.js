import { after, afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createIsolatedTestDatabase } from '../helpers/testDatabase.js';
import { buildSessionFixture, buildUserFixture } from '../helpers/fixtures.js';

let testDatabase;
let db;
let app;
let owner;
let ownerSession;
let otherUser;
let otherSession;
let authorization;
let otherAuthorization;

function localDateAtOffset(offsetMonths = 0, day = 1) {
  const date = new Date();
  date.setDate(1);
  date.setMonth(date.getMonth() + offsetMonths);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function monthAtOffset(offsetMonths = 0) {
  return localDateAtOffset(offsetMonths).slice(0, 7);
}

function tokenFor(user, session) {
  return jwt.sign(
    { sub: String(user.id), tv: user.token_version, sid: session.id },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '5m' }
  );
}

async function insertAccount(user, session) {
  await db.prepare(
    `INSERT INTO users
      (id, email, name, password_hash, is_admin, token_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    user.id,
    user.email,
    user.name,
    user.password_hash,
    user.is_admin,
    user.token_version,
    user.created_at
  );
  await db.prepare(
    `INSERT INTO sessions
      (id, user_id, device_label, ip_hash, user_agent, created_at, last_seen_at, revoked_at, revoked_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    session.id,
    session.user_id,
    session.device_label,
    session.ip_hash,
    session.user_agent,
    session.created_at,
    session.last_seen_at,
    session.revoked_at,
    session.revoked_reason
  );
}

function canonical(requestBuilder, key, token = authorization) {
  return requestBuilder
    .set('Authorization', token)
    .set('X-Clarity-Contract', '1')
    .set('Idempotency-Key', key);
}

async function count(sql, ...args) {
  const row = await db.prepare(sql).get(...args);
  return Number(row.count);
}

function monthlyOutcomesSnapshot(snapshot) {
  const monthlyOutcomes = Object.fromEntries(
    Object.entries(snapshot.outcomes).filter(([key]) => key !== 'todayAllowance')
  );
  // A confirmed mutation advances freshness metadata even when calculated values stay equal.
  return JSON.stringify(monthlyOutcomes, (key, value) => (
    key === 'dataVersion' ? undefined : value
  ));
}

before(async () => {
  testDatabase = await createIsolatedTestDatabase();
  db = testDatabase.db;
  process.env.FINANCIAL_MUTATION_HMAC_KEY =
    'test-only-financial-mutation-hmac-key-32-bytes-minimum';
  const { createApp } = await import('../../src/app.js');
  app = createApp();
});

beforeEach(async () => {
  await testDatabase.reset();
  owner = buildUserFixture({ id: 701, email: 'expense-owner@example.test' });
  ownerSession = buildSessionFixture({ userId: owner.id, id: 801 });
  otherUser = buildUserFixture({ id: 702, email: 'expense-other@example.test' });
  otherSession = buildSessionFixture({ userId: otherUser.id, id: 802 });
  await insertAccount(owner, ownerSession);
  await insertAccount(otherUser, otherSession);
  await db.batch([
    [`INSERT INTO user_financial_state
      (user_id, data_use_notice_version, data_use_acknowledged_at)
     VALUES (?, 1, CURRENT_TIMESTAMP)`, [owner.id]],
    [`INSERT INTO user_financial_state
      (user_id, data_use_notice_version, data_use_acknowledged_at)
     VALUES (?, 1, CURRENT_TIMESTAMP)`, [otherUser.id]],
  ]);
  authorization = `Bearer ${tokenFor(owner, ownerSession)}`;
  otherAuthorization = `Bearer ${tokenFor(otherUser, otherSession)}`;
});

afterEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
});

after(async () => {
  await testDatabase?.cleanup();
});

test('canonical expense create preserves legacy fields and replays without duplicate accounting', async () => {
  const month = monthAtOffset(0);
  const spentOn = localDateAtOffset(0);
  await db.prepare(
    'INSERT INTO salary_entries (user_id, month, amount) VALUES (?, ?, ?)'
  ).run(owner.id, month, 10_000);

  const key = '91000000-0000-4000-8000-000000000001';
  const first = await canonical(
    request(app).post('/api/finance/expenses'),
    key
  ).send({
    amount: '125.50',
    category: 'Food',
    note: 'Lunch',
    spentOn,
    expectedRecordVersion: 0,
  });

  assert.equal(first.status, 200);
  assert.ok(Number.isInteger(first.body.id));
  assert.equal(first.body.month, month);
  assert.equal(first.body.schemaVersion, 1);
  assert.equal(first.body.mutation.operation, 'expense.create');
  assert.equal(first.body.mutation.scopeKey, `expense:${first.body.id}`);
  assert.equal(first.body.mutation.record.amountMinor, 12_550);
  assert.equal(first.body.mutation.originalPeriod, null);
  assert.equal(first.body.mutation.resultingPeriod, month);
  assert.equal(first.body.mutation.originalCategory, null);
  assert.equal(first.body.mutation.resultingCategory, 'Food');
  assert.equal(first.body.mutation.expenseTransition.affectedPartitions.length, 1);
  assert.equal(first.body.clarity.dataVersion, 1);
  assert.equal(first.body.clarity.period.month, month);
  assert.equal(
    first.body.clarity.outcomes.spending.value.totalSpending.amountMinor,
    12_550
  );

  const replay = await canonical(
    request(app).post('/api/finance/expenses'),
    key.toUpperCase()
  ).send({
    amountMinor: 12_550,
    category: 'Food',
    note: 'Lunch',
    spentOn,
    expectedRecordVersion: 0,
  });

  assert.equal(replay.status, 200);
  assert.equal(replay.body.mutation.replayed, true);
  assert.equal(replay.body.mutation.changeId, first.body.mutation.changeId);
  assert.equal(replay.body.mutation.recordId, first.body.id);
  assert.equal(replay.body.mutation.resultingPeriod, month);
  assert.equal(
    await count('SELECT COUNT(*) AS count FROM expense_log WHERE user_id = ?', owner.id),
    1
  );
  assert.equal(
    await count('SELECT COUNT(*) AS count FROM financial_record_changes WHERE user_id = ?', owner.id),
    1
  );
});

test('expense correction removes the original partition before adding the resulting partition', async () => {
  const originalMonth = monthAtOffset(-1);
  const resultingMonth = monthAtOffset(0);
  await db.prepare(
    'INSERT INTO salary_entries (user_id, month, amount) VALUES (?, ?, ?)'
  ).run(owner.id, resultingMonth, 10_000);
  const info = await db.prepare(
    `INSERT INTO expense_log
      (user_id, month, category, amount, note, spent_on)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(owner.id, originalMonth, 'Food', 100, 'Original', `${originalMonth}-01`);

  const response = await canonical(
    request(app).patch(`/api/finance/expenses/${info.lastInsertRowid}`),
    '92000000-0000-4000-8000-000000000002'
  ).send({
    amount: '125.25',
    category: 'Entertainment',
    note: 'Corrected',
    spentOn: `${resultingMonth}-01`,
    expectedRecordVersion: 0,
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.deepEqual(Object.keys(response.body.expense).sort(), [
    'amount',
    'category',
    'id',
    'month',
    'note',
    'spent_on',
  ]);
  assert.equal(response.body.mutation.expenseTransition.type, 'move');
  assert.equal(response.body.mutation.originalPeriod, originalMonth);
  assert.equal(response.body.mutation.resultingPeriod, resultingMonth);
  assert.equal(response.body.mutation.originalCategory, 'Food');
  assert.equal(response.body.mutation.resultingCategory, 'Entertainment');
  assert.deepEqual(response.body.mutation.affectedPeriods, [
    originalMonth,
    resultingMonth,
  ]);
  assert.equal(response.body.clarity.period.month, resultingMonth);
  assert.equal(response.body.clarity.dataVersion, 1);
  assert.equal(
    response.body.clarity.outcomes.spending.value.totalSpending.amountMinor,
    12_525
  );

  assert.equal(
    await count(
      'SELECT COUNT(*) AS count FROM expense_log WHERE user_id = ? AND month = ?',
      owner.id,
      originalMonth
    ),
    0
  );
  const resulting = await db.prepare(
    `SELECT month, category, amount, note, spent_on
       FROM expense_log
      WHERE id = ? AND user_id = ?`
  ).get(info.lastInsertRowid, owner.id);
  assert.deepEqual({
    month: resulting.month,
    category: resulting.category,
    amount: Number(resulting.amount),
    note: resulting.note,
    spentOn: resulting.spent_on,
  }, {
    month: resultingMonth,
    category: 'Entertainment',
    amount: 125.25,
    note: 'Corrected',
    spentOn: `${resultingMonth}-01`,
  });
});

test('category treatment PUT and DELETE reclassify current spending without changing its total', async () => {
  const month = monthAtOffset(0);
  await db.prepare(
    'INSERT INTO salary_entries (user_id, month, amount) VALUES (?, ?, ?)'
  ).run(owner.id, month, 10_000);
  await db.prepare(
    `INSERT INTO expense_log
      (user_id, month, category, amount, note, spent_on)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(owner.id, month, 'Food', 100, null, `${month}-01`);

  const set = await canonical(
    request(app).put('/api/finance/category-treatments/Food'),
    '93000000-0000-4000-8000-000000000003'
  ).send({ treatment: 'wants', expectedRecordVersion: 0 });

  assert.equal(set.status, 200);
  assert.equal(set.body.ok, true);
  assert.equal(set.body.category, 'Food');
  assert.equal(set.body.treatment, 'wants');
  assert.equal(set.body.mutation.scopeKey, 'category-treatment:food');
  assert.equal(set.body.mutation.categoryTreatmentTransition.originalTreatment, 'needs');
  assert.equal(set.body.mutation.categoryTreatmentTransition.originalTreatmentSource, 'default');
  assert.equal(set.body.mutation.categoryTreatmentTransition.resultingTreatment, 'wants');
  assert.equal(set.body.mutation.categoryTreatmentTransition.needsSpentDeltaMinor, -10_000);
  assert.equal(set.body.mutation.categoryTreatmentTransition.wantsSpentDeltaMinor, 10_000);
  assert.equal(set.body.mutation.categoryTreatmentTransition.totalSpendingDeltaMinor, 0);
  assert.equal(set.body.clarity.outcomes.spending.value.needsSpent.amountMinor, 0);
  assert.equal(set.body.clarity.outcomes.spending.value.wantsSpent.amountMinor, 10_000);
  assert.equal(set.body.clarity.outcomes.spending.value.totalSpending.amountMinor, 10_000);
  const projectedAfterSet = set.body.clarity.outcomes.spending.value.projectedSavings.amountMinor;

  const removed = await canonical(
    request(app).delete('/api/finance/category-treatments/Food'),
    '93000000-0000-4000-8000-000000000004'
  ).send({ expectedRecordVersion: 1 });

  assert.equal(removed.status, 200);
  assert.equal(removed.body.ok, true);
  assert.equal(removed.body.treatment, 'needs');
  assert.equal(removed.body.mutation.status, 'reversed');
  assert.equal(removed.body.mutation.categoryTreatmentTransition.originalTreatment, 'wants');
  assert.equal(removed.body.mutation.categoryTreatmentTransition.resultingTreatment, 'needs');
  assert.equal(removed.body.mutation.categoryTreatmentTransition.resultingTreatmentSource, 'default');
  assert.equal(removed.body.clarity.outcomes.spending.value.needsSpent.amountMinor, 10_000);
  assert.equal(removed.body.clarity.outcomes.spending.value.wantsSpent.amountMinor, 0);
  assert.equal(
    removed.body.clarity.outcomes.spending.value.projectedSavings.amountMinor,
    projectedAfterSet
  );
  assert.equal(
    await count(
      'SELECT COUNT(*) AS count FROM expense_category_treatments WHERE user_id = ?',
      owner.id
    ),
    0
  );
});

test('expense mutations require authentication, enforce ownership, and retain rows on field errors', async () => {
  const month = monthAtOffset(0);
  const info = await db.prepare(
    `INSERT INTO expense_log
      (user_id, month, category, amount, note, spent_on)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(owner.id, month, 'Food', 100, 'Retain me', `${month}-01`);

  const anonymous = await request(app)
    .patch(`/api/finance/expenses/${info.lastInsertRowid}`)
    .set('Idempotency-Key', '94000000-0000-4000-8000-000000000005')
    .send({ amount: 50 });
  assert.equal(anonymous.status, 401);

  const wrongOwner = await canonical(
    request(app).patch(`/api/finance/expenses/${info.lastInsertRowid}`),
    '94000000-0000-4000-8000-000000000006',
    otherAuthorization
  ).send({ excludeFromDailyAllowance: true, expectedRecordVersion: 0 });
  assert.equal(wrongOwner.status, 404);
  assert.equal(wrongOwner.body.error.code, 'FINANCIAL_RECORD_NOT_FOUND');
  assert.equal(JSON.stringify(wrongOwner.body).includes(String(owner.id)), false);

  const invalid = await canonical(
    request(app).patch(`/api/finance/expenses/${info.lastInsertRowid}`),
    '94000000-0000-4000-8000-000000000007'
  ).send({ spentOn: `${month}-32`, expectedRecordVersion: 0 });
  assert.equal(invalid.status, 422);
  assert.equal(invalid.body.error.code, 'INVALID_EXPENSE_DATE');
  assert.equal(invalid.body.error.field, 'spentOn');
  assert.equal(invalid.body.error.constraint.format, 'YYYY-MM-DD');

  const unknownCategory = await canonical(
    request(app).patch(`/api/finance/expenses/${info.lastInsertRowid}`),
    '94000000-0000-4000-8000-000000000008'
  ).send({ category: 'NotConfigured', expectedRecordVersion: 0 });
  assert.equal(unknownCategory.status, 422);
  assert.equal(unknownCategory.body.error.code, 'UNKNOWN_EXPENSE_CATEGORY');
  assert.equal(unknownCategory.body.error.field, 'category');

  const retained = await db.prepare(
    'SELECT amount, category, note, spent_on FROM expense_log WHERE id = ? AND user_id = ?'
  ).get(info.lastInsertRowid, owner.id);
  assert.deepEqual({
    amount: Number(retained.amount),
    category: retained.category,
    note: retained.note,
    spentOn: retained.spent_on,
  }, {
    amount: 100,
    category: 'Food',
    note: 'Retain me',
    spentOn: `${month}-01`,
  });
  assert.equal(await count('SELECT COUNT(*) AS count FROM financial_record_changes'), 0);
});

test('correcting and deleting a materialized recurring expense cannot materialize it twice', async () => {
  const month = monthAtOffset(0);
  await db.prepare(
    `INSERT INTO recurring_expenses
      (user_id, label, amount, category, day_of_month, active)
     VALUES (?, ?, ?, ?, ?, 1)`
  ).run(owner.id, 'Monthly rent', 1_000, 'Bills', 1);

  const materialized = await request(app)
    .get(`/api/finance/expenses?month=${month}`)
    .set('Authorization', authorization);
  assert.equal(materialized.status, 200);
  assert.equal(materialized.body.expenses.length, 1);
  const expenseId = materialized.body.expenses[0].id;

  const corrected = await canonical(
    request(app).patch(`/api/finance/expenses/${expenseId}`),
    '95000000-0000-4000-8000-000000000009'
  ).send({ amount: '900.00', expectedRecordVersion: 0 });
  assert.equal(corrected.status, 200);
  assert.equal(corrected.body.mutation.originalPeriod, month);
  assert.equal(corrected.body.mutation.resultingPeriod, month);

  const afterCorrection = await request(app)
    .get(`/api/finance/expenses?month=${month}`)
    .set('Authorization', authorization);
  assert.equal(afterCorrection.body.expenses.length, 1);
  assert.equal(Number(afterCorrection.body.expenses[0].amount), 900);

  const deleteKey = '95000000-0000-4000-8000-000000000010';
  const deleted = await canonical(
    request(app).delete(`/api/finance/expenses/${expenseId}`),
    deleteKey
  ).send({ expectedRecordVersion: 1 });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.ok, true);
  assert.equal(deleted.body.mutation.status, 'reversed');
  assert.equal(deleted.body.mutation.originalPeriod, month);
  assert.equal(deleted.body.mutation.resultingPeriod, null);

  const replay = await canonical(
    request(app).delete(`/api/finance/expenses/${expenseId}`),
    deleteKey.toUpperCase()
  ).send({ expectedRecordVersion: 1 });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.mutation.replayed, true);
  assert.equal(replay.body.mutation.changeId, deleted.body.mutation.changeId);

  const afterDelete = await request(app)
    .get(`/api/finance/expenses?month=${month}`)
    .set('Authorization', authorization);
  assert.equal(afterDelete.status, 200);
  assert.equal(afterDelete.body.expenses.length, 0);
  assert.equal(
    await count('SELECT COUNT(*) AS count FROM expense_log WHERE user_id = ?', owner.id),
    0
  );
  assert.equal(
    await count(
      'SELECT COUNT(*) AS count FROM financial_record_changes WHERE user_id = ?',
      owner.id
    ),
    2
  );
  const recurring = await db.prepare(
    'SELECT last_logged_month FROM recurring_expenses WHERE user_id = ?'
  ).get(owner.id);
  assert.equal(recurring.last_logged_month, month);
});

test('contract expense create stores true or NULL, reports a boolean, and fingerprints the mark', async () => {
  const month = monthAtOffset(0);
  const spentOn = localDateAtOffset(0, 3);
  const body = {
    amountMinor: 12_500,
    category: 'Food',
    note: 'Allowance create',
    spentOn,
    expectedRecordVersion: 0,
  };
  const markedKey = '97000000-0000-4000-8000-000000000001';

  const marked = await canonical(
    request(app).post('/api/finance/expenses'),
    markedKey
  ).send({ ...body, excludeFromDailyAllowance: true });
  assert.equal(marked.status, 200);
  assert.equal(marked.body.mutation.record.excludeFromDailyAllowance, true);
  assert.deepEqual(marked.body.mutation.acceptedConstraints.excludeFromDailyAllowance, {
    type: 'boolean',
    optional: true,
  });
  const markedRow = await db.prepare(
    'SELECT exclude_from_daily_allowance FROM expense_log WHERE id = ? AND user_id = ?'
  ).get(marked.body.id, owner.id);
  assert.equal(markedRow.exclude_from_daily_allowance, 1);

  const replay = await canonical(
    request(app).post('/api/finance/expenses'),
    markedKey.toUpperCase()
  ).send({ ...body, excludeFromDailyAllowance: true });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.mutation.replayed, true);
  assert.equal(replay.body.mutation.changeId, marked.body.mutation.changeId);
  assert.equal(replay.body.mutation.record.excludeFromDailyAllowance, true);

  const conflict = await canonical(
    request(app).post('/api/finance/expenses'),
    markedKey
  ).send({ ...body, excludeFromDailyAllowance: false });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'IDEMPOTENCY_KEY_REUSED');

  const explicitlyCounted = await canonical(
    request(app).post('/api/finance/expenses'),
    '97000000-0000-4000-8000-000000000002'
  ).send({ ...body, note: 'Explicit false', excludeFromDailyAllowance: false });
  const omitted = await canonical(
    request(app).post('/api/finance/expenses'),
    '97000000-0000-4000-8000-000000000003'
  ).send({ ...body, note: 'Omitted' });
  assert.equal(explicitlyCounted.status, 200);
  assert.equal(omitted.status, 200);
  assert.equal(explicitlyCounted.body.mutation.record.excludeFromDailyAllowance, false);
  assert.equal(omitted.body.mutation.record.excludeFromDailyAllowance, false);

  const stored = await db.prepare(
    `SELECT id, exclude_from_daily_allowance
       FROM expense_log
      WHERE user_id = ? AND month = ?
      ORDER BY id`
  ).all(owner.id, month);
  assert.deepEqual(stored.map((row) => [
    Number(row.id),
    row.exclude_from_daily_allowance,
  ]), [
    [marked.body.id, 1],
    [explicitlyCounted.body.id, null],
    [omitted.body.id, null],
  ]);
  assert.equal(
    await count('SELECT COUNT(*) AS count FROM expense_log WHERE user_id = ?', owner.id),
    3
  );
});

test('contract expense updates set, preserve, clear, and move the allowance mark', async () => {
  const originalMonth = monthAtOffset(0);
  const resultingMonth = monthAtOffset(1);
  const [target, untouched] = await db.batch([
    [`INSERT INTO expense_log
      (user_id, month, category, amount, note, spent_on)
     VALUES (?, ?, ?, ?, ?, ?)`, [owner.id, originalMonth, 'Food', 100, 'Target legacy NULL', `${originalMonth}-01`]],
    [`INSERT INTO expense_log
      (user_id, month, category, amount, note, spent_on)
     VALUES (?, ?, ?, ?, ?, ?)`, [owner.id, originalMonth, 'Food', 200, 'Untouched legacy NULL', `${originalMonth}-02`]],
  ]);
  const targetId = Number(target.lastInsertRowid);
  const untouchedId = Number(untouched.lastInsertRowid);

  const marked = await canonical(
    request(app).patch(`/api/finance/expenses/${targetId}`),
    '98000000-0000-4000-8000-000000000001'
  ).send({ excludeFromDailyAllowance: true, expectedRecordVersion: 0 });
  assert.equal(marked.status, 200);
  assert.equal(marked.body.mutation.record.excludeFromDailyAllowance, true);
  assert.deepEqual(Object.keys(marked.body.expense).sort(), [
    'amount',
    'category',
    'id',
    'month',
    'note',
    'spent_on',
  ]);

  const markedReplay = await canonical(
    request(app).patch(`/api/finance/expenses/${targetId}`),
    '98000000-0000-4000-8000-000000000001'.toUpperCase()
  ).send({ excludeFromDailyAllowance: true, expectedRecordVersion: 0 });
  assert.equal(markedReplay.status, 200);
  assert.equal(markedReplay.body.mutation.replayed, true);
  assert.equal(markedReplay.body.mutation.changeId, marked.body.mutation.changeId);
  assert.equal(markedReplay.body.mutation.record.excludeFromDailyAllowance, true);

  const markedConflict = await canonical(
    request(app).patch(`/api/finance/expenses/${targetId}`),
    '98000000-0000-4000-8000-000000000001'
  ).send({ excludeFromDailyAllowance: false, expectedRecordVersion: 0 });
  assert.equal(markedConflict.status, 409);
  assert.equal(markedConflict.body.error.code, 'IDEMPOTENCY_KEY_REUSED');

  const amountOnly = await canonical(
    request(app).patch(`/api/finance/expenses/${targetId}`),
    '98000000-0000-4000-8000-000000000002'
  ).send({ amountMinor: 15_000, expectedRecordVersion: 1 });
  assert.equal(amountOnly.status, 200);
  assert.equal(amountOnly.body.mutation.record.amountMinor, 15_000);
  assert.equal(amountOnly.body.mutation.record.excludeFromDailyAllowance, true);

  const movedAndCleared = await canonical(
    request(app).patch(`/api/finance/expenses/${targetId}`),
    '98000000-0000-4000-8000-000000000003'
  ).send({
    spentOn: `${resultingMonth}-01`,
    excludeFromDailyAllowance: false,
    expectedRecordVersion: 2,
  });
  assert.equal(movedAndCleared.status, 200);
  assert.equal(movedAndCleared.body.mutation.expenseTransition.type, 'move');
  assert.equal(movedAndCleared.body.mutation.originalPeriod, originalMonth);
  assert.equal(movedAndCleared.body.mutation.resultingPeriod, resultingMonth);
  assert.equal(movedAndCleared.body.mutation.record.month, resultingMonth);
  assert.equal(movedAndCleared.body.mutation.record.excludeFromDailyAllowance, false);

  const rows = await db.prepare(
    `SELECT id, month, amount, exclude_from_daily_allowance
       FROM expense_log
      WHERE id IN (?, ?)
      ORDER BY id`
  ).all(targetId, untouchedId);
  assert.deepEqual(rows.map((row) => ({
    id: Number(row.id),
    month: row.month,
    amount: Number(row.amount),
    exclusion: row.exclude_from_daily_allowance,
  })), [
    { id: targetId, month: resultingMonth, amount: 150, exclusion: null },
    { id: untouchedId, month: originalMonth, amount: 200, exclusion: null },
  ]);
});

test('setting and clearing the allowance mark leaves every monthly outcome byte-equal', async () => {
  const month = monthAtOffset(0);
  const spentOn = localDateAtOffset(0, new Date().getDate());
  const [, expense] = await db.batch([
    ['INSERT INTO salary_entries (user_id, month, amount) VALUES (?, ?, ?)', [owner.id, month, 10_000]],
    [`INSERT INTO expense_log
      (user_id, month, category, amount, note, spent_on)
     VALUES (?, ?, ?, ?, ?, ?)`, [owner.id, month, 'Food', 100, 'Monthly outcomes stay fixed', spentOn]],
  ]);
  const expenseId = Number(expense.lastInsertRowid);

  const before = await request(app)
    .get(`/api/finance/clarity?month=${month}`)
    .set('Authorization', authorization);
  assert.equal(before.status, 200);
  const expectedMonthlyOutcomes = monthlyOutcomesSnapshot(before.body.snapshot);

  const marked = await canonical(
    request(app).patch(`/api/finance/expenses/${expenseId}`),
    '98000000-0000-4000-8000-000000000004'
  ).send({ excludeFromDailyAllowance: true, expectedRecordVersion: 0 });
  assert.equal(marked.status, 200);
  assert.equal(marked.body.mutation.record.excludeFromDailyAllowance, true);
  assert.equal(monthlyOutcomesSnapshot(marked.body.clarity), expectedMonthlyOutcomes);

  const cleared = await canonical(
    request(app).patch(`/api/finance/expenses/${expenseId}`),
    '98000000-0000-4000-8000-000000000005'
  ).send({ excludeFromDailyAllowance: false, expectedRecordVersion: 1 });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.mutation.record.excludeFromDailyAllowance, false);
  assert.equal(monthlyOutcomesSnapshot(cleared.body.clarity), expectedMonthlyOutcomes);
});

test('contract expense create and update reject non-boolean allowance marks before writing', async () => {
  const month = monthAtOffset(0);
  const spentOn = localDateAtOffset(0, 4);
  const info = await db.prepare(
    `INSERT INTO expense_log
      (user_id, month, category, amount, note, spent_on)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(owner.id, month, 'Food', 100, 'Validation target', spentOn);
  const invalidValues = [null, 0, 1, 'true', [], {}];
  let sequence = 1;

  for (const value of invalidValues) {
    const suffix = String(sequence).padStart(12, '0');
    sequence += 1;
    const created = await canonical(
      request(app).post('/api/finance/expenses'),
      `99000000-0000-4000-8000-${suffix}`
    ).send({
      amountMinor: 10_000,
      category: 'Food',
      spentOn,
      excludeFromDailyAllowance: value,
    });
    assert.equal(created.status, 400, `create rejects ${JSON.stringify(value)}`);
    assert.deepEqual(created.body.error, {
      code: 'INVALID_EXPENSE_EXCLUSION',
      message: 'excludeFromDailyAllowance must be a boolean.',
      field: 'excludeFromDailyAllowance',
      constraint: { type: 'boolean', optional: true },
    });

    const updateSuffix = String(sequence).padStart(12, '0');
    sequence += 1;
    const updated = await canonical(
      request(app).patch(`/api/finance/expenses/${info.lastInsertRowid}`),
      `99000000-0000-4000-8000-${updateSuffix}`
    ).send({ excludeFromDailyAllowance: value, expectedRecordVersion: 0 });
    assert.equal(updated.status, 400, `update rejects ${JSON.stringify(value)}`);
    assert.deepEqual(updated.body.error, created.body.error);
  }

  const row = await db.prepare(
    'SELECT exclude_from_daily_allowance FROM expense_log WHERE id = ? AND user_id = ?'
  ).get(info.lastInsertRowid, owner.id);
  assert.equal(row.exclude_from_daily_allowance, null);
  assert.equal(await count('SELECT COUNT(*) AS count FROM financial_record_changes'), 0);
});
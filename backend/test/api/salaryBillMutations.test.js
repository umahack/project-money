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
let authorization;

function monthAtOffset(offset) {
  const date = new Date();
  date.setDate(1);
  date.setMonth(date.getMonth() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
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

async function receiptCount() {
  const row = await db.prepare(
    'SELECT COUNT(*) AS count FROM financial_record_changes WHERE user_id = ?'
  ).get(owner.id);
  return Number(row.count);
}

function canonical(requestBuilder, key) {
  return requestBuilder
    .set('Authorization', authorization)
    .set('X-Clarity-Contract', '1')
    .set('Idempotency-Key', key);
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
  owner = buildUserFixture({ id: 501, email: 'salary-bill-owner@example.test' });
  ownerSession = buildSessionFixture({ userId: owner.id, id: 601 });
  await insertAccount(owner, ownerSession);
  await db.prepare(
    `INSERT INTO user_financial_state
      (user_id, data_use_notice_version, data_use_acknowledged_at)
     VALUES (?, 1, CURRENT_TIMESTAMP)`
  ).run(owner.id);
  authorization = `Bearer ${tokenFor(owner, ownerSession)}`;
});

afterEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
});

after(async () => {
  await testDatabase?.cleanup();
});

test('negotiated salary writes retain legacy fields and add one idempotent canonical envelope', async () => {
  const month = monthAtOffset(0);
  await db.prepare(
    `INSERT INTO emis (user_id, label, amount, category)
     VALUES (?, ?, ?, ?)`
  ).run(owner.id, 'Legacy open bill', 5_000, 'Rent');

  const key = '81000000-0000-4000-8000-000000000001';
  const first = await canonical(
    request(app).post('/api/finance/salary'),
    key
  ).send({ amountMinor: 7_500_050, month, expectedRecordVersion: 0 });

  assert.equal(first.status, 200);
  assert.equal(first.body.ok, true);
  assert.equal(first.body.month, month);
  assert.equal(first.body.amount, 75_000.5);
  assert.equal(first.body.schemaVersion, 1);
  assert.equal(first.body.mutation.operation, 'salary.upsert');
  assert.equal(first.body.mutation.recordType, 'salary');
  assert.equal(first.body.mutation.recordVersion, 1);
  assert.equal(first.body.mutation.replayed, false);
  assert.equal(first.body.mutation.scopeKey, `salary:${month}`);
  assert.equal(first.body.mutation.record.amountMinor, 7_500_050);
  assert.equal(first.body.mutation.acceptedConstraints.amountMinor.minMinor, 0);
  assert.equal(first.body.mutation.planDeltas.status, 'available');
  assert.equal(first.body.mutation.planDeltas.disposableIncomeMinor, 7_000_050);
  assert.equal(first.body.clarity.dataVersion, 1);
  assert.equal(first.body.clarity.period.month, month);
  assert.equal(first.body.clarity.outcomes.monthlyPlan.status, 'available');
  assert.equal(
    first.body.clarity.outcomes.monthlyPlan.value.disposableIncome.amountMinor,
    7_000_050
  );
  assert.equal(await receiptCount(), 1);

  const replay = await canonical(
    request(app).post('/api/finance/salary'),
    key.toUpperCase()
  ).send({ month, amount: '75000.50', expectedRecordVersion: 0 });

  assert.equal(replay.status, 200);
  assert.equal(replay.body.mutation.replayed, true);
  assert.equal(replay.body.mutation.changeId, first.body.mutation.changeId);
  assert.equal(replay.body.mutation.recordVersion, 1);
  assert.equal(await receiptCount(), 1);

  const legacyBill = await db.prepare(
    `SELECT active, effective_from_month, effective_to_month
       FROM emis
      WHERE user_id = ? AND label = ?`
  ).get(owner.id, 'Legacy open bill');
  assert.equal(Number(legacyBill.active), 1);
  assert.equal(legacyBill.effective_from_month, null);
  assert.equal(legacyBill.effective_to_month, null);

  const legacyWrite = await request(app)
    .post('/api/finance/salary')
    .set('Authorization', authorization)
    .send({ amount: 76_000, month });
  assert.equal(legacyWrite.status, 200);
  assert.deepEqual(Object.keys(legacyWrite.body).sort(), ['amount', 'month', 'ok']);
  assert.equal(await receiptCount(), 1);
});

test('negotiated bill create, edit, and delete persist activity and effective months', async () => {
  const month = monthAtOffset(0);
  await db.prepare(
    'INSERT INTO salary_entries (user_id, month, amount) VALUES (?, ?, ?)'
  ).run(owner.id, month, 50_000);

  const created = await canonical(
    request(app).post('/api/finance/emis'),
    '82000000-0000-4000-8000-000000000002'
  ).send({
    label: 'Current insurance',
    amountMinor: 1_000_000,
    category: 'Insurance',
    active: true,
    effectiveFromMonth: month,
    effectiveToMonth: month,
    applicableMonth: month,
    expectedRecordVersion: 0,
  });

  assert.equal(created.status, 200);
  assert.ok(Number.isInteger(created.body.id));
  assert.equal(created.body.mutation.scopeKey, `bill:${created.body.id}`);
  assert.equal(created.body.mutation.recordVersion, 1);
  assert.deepEqual(created.body.mutation.record, {
    id: created.body.id,
    label: 'Current insurance',
    amountMinor: 1_000_000,
    category: 'Insurance',
    active: true,
    effectiveFromMonth: month,
    effectiveToMonth: month,
  });
  assert.equal(created.body.mutation.planDeltas.disposableIncomeMinor, -1_000_000);
  assert.equal(
    created.body.clarity.outcomes.monthlyPlan.value.activeBillsTotal.amountMinor,
    1_000_000
  );

  const updated = await canonical(
    request(app).patch(`/api/finance/emis/${created.body.id}`),
    '82000000-0000-4000-8000-000000000003'
  ).send({
    active: false,
    effectiveToMonth: null,
    applicableMonth: month,
    expectedRecordVersion: 1,
  });

  assert.equal(updated.status, 200);
  assert.equal(updated.body.ok, true);
  assert.deepEqual(Object.keys(updated.body.emi).sort(), ['amount', 'category', 'id', 'label']);
  assert.equal(updated.body.mutation.record.active, false);
  assert.equal(updated.body.mutation.record.effectiveFromMonth, month);
  assert.equal(updated.body.mutation.record.effectiveToMonth, null);
  assert.equal(updated.body.mutation.recordVersion, 2);
  assert.equal(updated.body.mutation.planDeltas.disposableIncomeMinor, 1_000_000);
  assert.equal(
    updated.body.clarity.outcomes.monthlyPlan.value.activeBillsTotal.amountMinor,
    0
  );

  const deleted = await canonical(
    request(app).delete(`/api/finance/emis/${created.body.id}`),
    '82000000-0000-4000-8000-000000000004'
  ).send({ applicableMonth: month, expectedRecordVersion: 2 });

  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.ok, true);
  assert.equal(deleted.body.mutation.status, 'reversed');
  assert.equal(deleted.body.mutation.recordVersion, 3);
  assert.equal(deleted.body.mutation.record, null);
  assert.equal(
    await db.prepare('SELECT id FROM emis WHERE id = ?').get(created.body.id),
    undefined
  );
  assert.equal(await receiptCount(), 3);
});

test('salary apply copies a confirmed prior month only after an explicit idempotent request', async () => {
  const sourceMonth = monthAtOffset(-1);
  const targetMonth = monthAtOffset(0);
  await db.prepare(
    'INSERT INTO salary_entries (user_id, month, amount) VALUES (?, ?, ?)'
  ).run(owner.id, sourceMonth, 42_345.67);

  const before = await db.prepare(
    'SELECT id FROM salary_entries WHERE user_id = ? AND month = ?'
  ).get(owner.id, targetMonth);
  assert.equal(before, undefined);

  const applied = await canonical(
    request(app).post('/api/finance/salary/apply'),
    '83000000-0000-4000-8000-000000000005'
  ).send({ sourceMonth, targetMonth, expectedRecordVersion: 0 });

  assert.equal(applied.status, 200);
  assert.equal(applied.body.ok, true);
  assert.equal(applied.body.sourceMonth, sourceMonth);
  assert.equal(applied.body.targetMonth, targetMonth);
  assert.equal(applied.body.amount, 42_345.67);
  assert.equal(applied.body.mutation.operation, 'salary.apply');
  assert.equal(applied.body.mutation.record.amountMinor, 4_234_567);
  assert.equal(applied.body.mutation.planDeltas.disposableIncomeMinor, 4_234_567);
  assert.equal(applied.body.clarity.period.month, targetMonth);

  const rows = await db.prepare(
    `SELECT month, amount
       FROM salary_entries
      WHERE user_id = ?
      ORDER BY month`
  ).all(owner.id);
  assert.deepEqual(rows.map((row) => [row.month, Number(row.amount)]), [
    [sourceMonth, 42_345.67],
    [targetMonth, 42_345.67],
  ]);

  const invalid = await canonical(
    request(app).post('/api/finance/salary/apply'),
    '83000000-0000-4000-8000-000000000006'
  ).send({ sourceMonth: targetMonth, targetMonth });
  assert.equal(invalid.status, 422);
  assert.equal(invalid.body.error.code, 'SOURCE_MONTH_NOT_PRIOR');
  assert.deepEqual(invalid.body.error.constraint, { relation: 'sourceMonth < targetMonth' });
  assert.equal(await receiptCount(), 1);
});

test('canonical bill validation retains the confirmed row and returns accepted bounds', async () => {
  const month = monthAtOffset(0);
  const nextMonth = monthAtOffset(1);
  const info = await db.prepare(
    `INSERT INTO emis
      (user_id, label, amount, category, active, effective_from_month, effective_to_month)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(owner.id, 'Bounded bill', 1_000, 'Utility', 1, month, nextMonth);

  const response = await canonical(
    request(app).patch(`/api/finance/emis/${info.lastInsertRowid}`),
    '84000000-0000-4000-8000-000000000007'
  ).send({ effectiveToMonth: monthAtOffset(-1), applicableMonth: month });

  assert.equal(response.status, 422);
  assert.equal(response.body.error.code, 'INVALID_BILL_EFFECTIVE_RANGE');
  assert.equal(response.body.error.field, 'effectiveToMonth');
  assert.deepEqual(response.body.error.constraint, {
    relation: 'effectiveFromMonth <= effectiveToMonth',
  });
  const retained = await db.prepare(
    `SELECT effective_from_month, effective_to_month
       FROM emis
      WHERE id = ? AND user_id = ?`
  ).get(info.lastInsertRowid, owner.id);
  assert.equal(retained.effective_from_month, month);
  assert.equal(retained.effective_to_month, nextMonth);
  assert.equal(await receiptCount(), 0);
});

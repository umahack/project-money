import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createIsolatedTestDatabase } from '../helpers/testDatabase.js';
import {
  buildSessionFixture,
  buildUserFixture,
} from '../helpers/fixtures.js';

let testDatabase;
let server;
let fixedClockApp;
let ownerToken;
let revokedToken;
let noPlanToken;

const OWNER_ID = 101;
const OTHER_USER_ID = 102;
const NO_PLAN_USER_ID = 103;
const OWNER_SESSION_ID = 201;
const REVOKED_SESSION_ID = 202;
const OTHER_SESSION_ID = 203;
const NO_PLAN_SESSION_ID = 204;
const JANUARY = '2026-01';
const FEBRUARY = '2026-02';

function signToken(userId, sessionId, tokenVersion = 1) {
  return jwt.sign(
    { sub: String(userId), tv: tokenVersion, sid: sessionId },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '5m' }
  );
}

async function insertUser(db, user) {
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
}

async function insertSession(db, session) {
  await db.prepare(
    `INSERT INTO sessions
      (id, user_id, device_label, ip_hash, user_agent, created_at, last_seen_at,
       revoked_at, revoked_reason)
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

before(async () => {
  testDatabase = await createIsolatedTestDatabase();
  const { db } = testDatabase;
  const owner = buildUserFixture({ id: OWNER_ID, email: 'clarity-owner@example.test' });
  const otherUser = buildUserFixture({ id: OTHER_USER_ID, email: 'clarity-other@example.test' });
  const noPlanUser = buildUserFixture({ id: NO_PLAN_USER_ID, email: 'clarity-no-plan@example.test' });
  await insertUser(db, owner);
  await insertUser(db, otherUser);
  await insertUser(db, noPlanUser);

  await insertSession(db, buildSessionFixture({
    id: OWNER_SESSION_ID,
    userId: OWNER_ID,
    ip_hash: 'clarity-owner-session',
  }));
  await insertSession(db, buildSessionFixture({
    id: REVOKED_SESSION_ID,
    userId: OWNER_ID,
    ip_hash: 'clarity-revoked-session',
    revoked_at: '2026-01-15T07:00:00.000Z',
    revoked_reason: 'logout',
  }));
  await insertSession(db, buildSessionFixture({
    id: OTHER_SESSION_ID,
    userId: OTHER_USER_ID,
    ip_hash: 'clarity-other-session',
  }));
  await insertSession(db, buildSessionFixture({
    id: NO_PLAN_SESSION_ID,
    userId: NO_PLAN_USER_ID,
    ip_hash: 'clarity-no-plan-session',
  }));

  await db.prepare(
    'INSERT INTO user_financial_state (user_id, data_version) VALUES (?, ?)'
  ).run(OWNER_ID, 3);
  await db.prepare(
    'INSERT INTO user_financial_state (user_id, data_version) VALUES (?, ?)'
  ).run(OTHER_USER_ID, 6);
  await db.prepare(
    'INSERT INTO user_financial_state (user_id, data_version) VALUES (?, ?)'
  ).run(NO_PLAN_USER_ID, 4);

  await db.prepare(
    `INSERT INTO salary_entries (id, user_id, month, amount, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(301, OWNER_ID, JANUARY, 120_000, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  await db.prepare(
    `INSERT INTO salary_entries (id, user_id, month, amount, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(302, OWNER_ID, FEBRUARY, 80_000, '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z');
  await db.prepare(
    `INSERT INTO salary_entries (id, user_id, month, amount, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(303, OTHER_USER_ID, JANUARY, 999_999, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

  await db.prepare(
    `INSERT INTO emis
      (id, user_id, label, amount, category, active, effective_from_month,
       effective_to_month, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(311, OWNER_ID, 'January rent', 20_000, 'Rent', 1, JANUARY, JANUARY, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  await db.prepare(
    `INSERT INTO emis
      (id, user_id, label, amount, category, active, effective_from_month,
       effective_to_month, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(312, OTHER_USER_ID, 'Other user rent', 777_777, 'Rent', 1, null, null, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

  await db.prepare(
    `INSERT INTO expense_log
      (id, user_id, month, category, amount, note, spent_on, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(321, OWNER_ID, JANUARY, 'Groceries', 1_250.5, 'Owner expense', '2026-01-10', '2026-01-10T00:00:00.000Z', '2026-01-10T00:00:00.000Z');
  await db.prepare(
    `INSERT INTO expense_log
      (id, user_id, month, category, amount, note, spent_on, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(322, OTHER_USER_ID, JANUARY, 'Groceries', 99_999, 'Other expense', '2026-01-10', '2026-01-10T00:00:00.000Z', '2026-01-10T00:00:00.000Z');

  await db.prepare(
    `INSERT INTO savings_goals
      (id, user_id, name, target_amount, saved_amount, target_date, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(331, OWNER_ID, 'Owner goal', 120_000, 30_000, '2099-12-31', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  await db.prepare(
    `INSERT INTO savings_goals
      (id, user_id, name, target_amount, saved_amount, target_date, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(332, OTHER_USER_ID, 'Other goal', 1_000_000, 0, '2099-12-31', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

  ownerToken = signToken(OWNER_ID, OWNER_SESSION_ID);
  revokedToken = signToken(OWNER_ID, REVOKED_SESSION_ID);
  noPlanToken = signToken(NO_PLAN_USER_ID, NO_PLAN_SESSION_ID);

  const { createApp } = await import('../../src/app.js');
  server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');

  const { createClarityRouter } = await import('../../src/routes/clarity.js');
  fixedClockApp = express();
  fixedClockApp.use(express.json());
  fixedClockApp.use('/api/finance', createClarityRouter({
    clock: () => new Date('2026-01-15T06:30:00.000Z'),
  }));
});

after(async () => {
  if (server?.listening) {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
  }
  await testDatabase?.cleanup();
});

test('clarity reads require a live authenticated session', async () => {
  const missing = await request(server).get(`/api/finance/clarity?month=${JANUARY}`);
  assert.equal(missing.status, 401);
  assert.equal(missing.body.error, 'Missing token');

  const revoked = await request(server)
    .get(`/api/finance/clarity?month=${JANUARY}`)
    .set('Authorization', `Bearer ${revokedToken}`);
  assert.equal(revoked.status, 401);
  assert.equal(revoked.body.code, 'SESSION_REVOKED');

  const authenticated = await request(server)
    .get(`/api/finance/clarity?month=${JANUARY}`)
    .set('Authorization', `Bearer ${ownerToken}`);
  assert.equal(authenticated.status, 200);
  assert.equal(authenticated.body.schemaVersion, 1);
});

test('clarity reads validate exact periods and return only owner-scoped records', async () => {
  const january = await request(server)
    .get(`/api/finance/clarity?month=${JANUARY}`)
    .set('Authorization', `Bearer ${ownerToken}`);
  assert.equal(january.status, 200);
  assert.equal(january.body.snapshot.period.month, JANUARY);
  assert.equal(january.body.snapshot.dataVersion, 3);
  assert.equal(
    january.body.snapshot.outcomes.monthlyPlan.value.salary.amountMinor,
    12_000_000
  );
  assert.equal(
    january.body.snapshot.outcomes.monthlyPlan.value.activeBillsTotal.amountMinor,
    2_000_000
  );
  assert.deepEqual(
    january.body.snapshot.outcomes.goals.map(({ id }) => id),
    ['goal:331']
  );
  assert.ok(january.body.snapshot.facts.every(({ source }) => (
    source.recordId !== 303 && source.recordId !== 312 && source.recordId !== 322
  )));

  const february = await request(server)
    .get(`/api/finance/clarity?month=${FEBRUARY}`)
    .set('Authorization', `Bearer ${ownerToken}`);
  assert.equal(february.status, 200);
  assert.equal(february.body.snapshot.period.month, FEBRUARY);
  assert.equal(
    february.body.snapshot.outcomes.monthlyPlan.value.salary.amountMinor,
    8_000_000
  );
  assert.equal(
    february.body.snapshot.outcomes.monthlyPlan.value.activeBillsTotal.amountMinor,
    0
  );
  assert.deepEqual(february.body.snapshot.outcomes.spending.value.categoryTotals, []);

  for (const query of ['', '?month=2026-1', '?month=2026-13', '?month=2026-01-01', '?month=9999-12']) {
    const response = await request(server)
      .get(`/api/finance/clarity${query}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    assert.equal(response.status, 400, query);
    assert.equal(response.body.error.code, 'INVALID_MONTH', query);
  }
});

test('explanation reads enforce outcome ownership and validate identifiers', async () => {
  const owned = await request(server)
    .get('/api/finance/explanations/goal:331')
    .set('Authorization', `Bearer ${ownerToken}`);
  assert.equal(owned.status, 200);
  assert.equal(owned.body.schemaVersion, 1);
  assert.equal(owned.body.explanation.outcomeId, 'goal:331');
  assert.ok(owned.body.explanation.sourceRefs.every(({ recordId }) => recordId !== 332));

  const wrongOwner = await request(server)
    .get('/api/finance/explanations/goal:332')
    .set('Authorization', `Bearer ${ownerToken}`);
  assert.equal(wrongOwner.status, 404);
  assert.equal(wrongOwner.body.error.code, 'OUTCOME_NOT_FOUND');

  const invalidId = await request(server)
    .get('/api/finance/explanations/goal:0')
    .set('Authorization', `Bearer ${ownerToken}`);
  assert.equal(invalidId.status, 400);
  assert.equal(invalidId.body.error.code, 'INVALID_OUTCOME_ID');

  const invalidVersion = await request(server)
    .get('/api/finance/explanations/monthly-plan:2026-01?version=03')
    .set('Authorization', `Bearer ${ownerToken}`);
  assert.equal(invalidVersion.status, 400);
  assert.equal(invalidVersion.body.error.code, 'INVALID_VERSION');
});

test('today allowance is current-date explainable, non-current unavailable, and malformed IDs are rejected', async () => {
  const snapshotResponse = await request(fixedClockApp)
    .get(`/api/finance/clarity?month=${JANUARY}`)
    .set('Authorization', `Bearer ${ownerToken}`);
  assert.equal(snapshotResponse.status, 200);
  const outcome = snapshotResponse.body.snapshot.outcomes.todayAllowance;
  assert.equal(outcome.id, `today-allowance:${JANUARY}`);
  assert.equal(outcome.kind, 'today_allowance');
  assert.equal(outcome.status, 'available');
  assert.equal(outcome.dataVersion, 3);
  assert.deepEqual(outcome.period, snapshotResponse.body.snapshot.period);
  assert.deepEqual(outcome.value, {
    applicable: true,
    date: '2026-01-15',
    daysRemainingInclusive: 17,
    todayAllowance: { currency: 'INR', amountMinor: 463_232 },
    todaySpent: { currency: 'INR', amountMinor: 0 },
    leftToday: { currency: 'INR', amountMinor: 463_232 },
    overToday: { currency: 'INR', amountMinor: 0 },
    allowanceBasis: { currency: 'INR', amountMinor: 7_874_950 },
    usedPermille: 0,
    zeroReason: null,
    usedBeyondBudget: { currency: 'INR', amountMinor: 0 },
    excludedToday: {
      count: 0,
      total: { currency: 'INR', amountMinor: 0 },
    },
    largeEntryThreshold: { currency: 'INR', amountMinor: 2_000_000 },
  });

  const explanation = await request(fixedClockApp)
    .get(`/api/finance/explanations/today-allowance:${JANUARY}?version=3`)
    .set('Authorization', `Bearer ${ownerToken}`);
  assert.equal(explanation.status, 200);
  assert.equal(explanation.body.schemaVersion, 1);
  assert.equal(explanation.body.explanation.outcomeId, `today-allowance:${JANUARY}`);
  assert.equal(explanation.body.explanation.kind, 'today_allowance');
  assert.equal(explanation.body.explanation.dataVersion, 3);
  assert.deepEqual(explanation.body.explanation.period, outcome.period);
  assert.deepEqual(explanation.body.explanation.result.value, outcome.value);
  assert.deepEqual(
    explanation.body.explanation.operations.map(({ stage }) => stage),
    [
      'spendable_budget',
      'expenses_used',
      'remaining_spendable',
      'add_today_spent',
      'divide_days',
      'floor_zero',
      'subtract_today_spent',
      'versus_guide',
    ]
  );
  assert.ok(explanation.body.explanation.sourceRefs.every(({ recordId }) => recordId !== 322));

  const notOwned = await request(fixedClockApp)
    .get(`/api/finance/explanations/today-allowance:${JANUARY}?version=3`)
    .set('Authorization', `Bearer ${noPlanToken}`);
  assert.equal(notOwned.status, 404);
  assert.equal(notOwned.body.error.code, 'OUTCOME_NOT_FOUND');

  const nonCurrent = await request(fixedClockApp)
    .get(`/api/finance/explanations/today-allowance:${FEBRUARY}`)
    .set('Authorization', `Bearer ${ownerToken}`);
  assert.equal(nonCurrent.status, 404);
  assert.equal(nonCurrent.body.error.code, 'OUTCOME_NOT_FOUND');

  for (const malformed of [
    'today-allowance:2026-1',
    'today-allowance:2026-13',
    'today-allowance:2026-01-extra',
  ]) {
    const response = await request(fixedClockApp)
      .get(`/api/finance/explanations/${malformed}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    assert.equal(response.status, 400, malformed);
    assert.equal(response.body.error.code, 'INVALID_OUTCOME_ID', malformed);
  }
});

test('superseded explanation responses contain one coherent current version', async () => {
  const current = await request(server)
    .get('/api/finance/explanations/monthly-plan:2026-01?version=3')
    .set('Authorization', `Bearer ${ownerToken}`);
  assert.equal(current.status, 200);
  assert.equal(current.body.supersededByVersion, undefined);
  assert.equal(current.body.explanation.dataVersion, 3);
  assert.equal(current.body.explanation.result.value.salary.amountMinor, 12_000_000);

  await testDatabase.db.prepare(
    'UPDATE salary_entries SET amount = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?'
  ).run(130_000, 301, OWNER_ID);
  await testDatabase.db.prepare(
    'UPDATE user_financial_state SET data_version = ? WHERE user_id = ?'
  ).run(4, OWNER_ID);

  const superseded = await request(server)
    .get('/api/finance/explanations/monthly-plan:2026-01?version=3')
    .set('Authorization', `Bearer ${ownerToken}`);
  assert.equal(superseded.status, 200);
  assert.equal(superseded.body.schemaVersion, 1);
  assert.equal(superseded.body.supersededByVersion, 4);
  assert.equal(superseded.body.explanation.dataVersion, 4);
  assert.equal(
    superseded.body.explanation.sourceRefs.find(({ sourceType }) => sourceType === 'salary').value.amountMinor,
    13_000_000
  );
  assert.equal(
    superseded.body.explanation.result.value.salary.amountMinor,
    13_000_000
  );
  assert.ok(superseded.body.explanation.operations.length > 0);

  const future = await request(server)
    .get('/api/finance/explanations/monthly-plan:2026-01?version=5')
    .set('Authorization', `Bearer ${ownerToken}`);
  assert.equal(future.status, 409);
  assert.equal(future.body.error.code, 'DATA_VERSION_NOT_AVAILABLE');
  assert.equal(future.body.error.currentVersion, 4);
});

test('the clarity router does not shadow legacy authenticated finance fields', async () => {
  const plan = await request(server)
    .get('/api/finance/plan')
    .set('Authorization', `Bearer ${ownerToken}`);
  assert.equal(plan.status, 200);
  assert.ok(Object.hasOwn(plan.body, 'income'));
  assert.ok(Object.hasOwn(plan.body, 'emiTotal'));
  assert.ok(Object.hasOwn(plan.body, 'afterFixed'));
  assert.ok(Object.hasOwn(plan.body, 'breakdown'));
  assert.ok(Object.hasOwn(plan.body, 'spentThisMonth'));
  assert.ok(Object.hasOwn(plan.body, 'byCategory'));
  assert.ok(Object.hasOwn(plan.body, 'tips'));
});

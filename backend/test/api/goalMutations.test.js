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

function dateAtOffset(offsetMonths, day = 15) {
  const date = new Date();
  date.setDate(1);
  date.setMonth(date.getMonth() + offsetMonths);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
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

function legacy(requestBuilder, token = authorization) {
  return requestBuilder.set('Authorization', token);
}

async function count(sql, ...args) {
  const row = await db.prepare(sql).get(...args);
  return Number(row.count);
}

async function insertGoal(userId, overrides = {}) {
  const goal = {
    name: 'Emergency fund',
    target: 1000,
    saved: 250,
    date: dateAtOffset(6),
    ...overrides,
  };
  const info = await db.prepare(
    `INSERT INTO savings_goals (user_id, name, target_amount, saved_amount, target_date)
     VALUES (?, ?, ?, ?, ?)`
  ).run(userId, goal.name, goal.target, goal.saved, goal.date);
  return Number(info.lastInsertRowid);
}

async function readGoal(id) {
  const row = await db.prepare(
    `SELECT name, target_amount, saved_amount, target_date
       FROM savings_goals WHERE id = ?`
  ).get(id);
  return row ? Object.fromEntries(Object.entries(row)) : null;
}

const receiptCount = () => count('SELECT COUNT(*) AS count FROM financial_record_changes');

let keyCounter = 0;
function key() {
  keyCounter += 1;
  return `a1000000-0000-4000-8000-${String(keyCounter).padStart(12, '0')}`;
}

// Funding gap for the default goal: (1000.00 - 250.00) rupees.
const GAP_MINOR = 75_000;

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
  owner = buildUserFixture({ id: 901, email: 'goal-owner@example.test' });
  ownerSession = buildSessionFixture({ userId: owner.id, id: 951 });
  otherUser = buildUserFixture({ id: 902, email: 'goal-other@example.test' });
  otherSession = buildSessionFixture({ userId: otherUser.id, id: 952 });
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

test('goal mutation routes fail closed without a valid session', async () => {
  const id = await insertGoal(owner.id);
  const before = await readGoal(id);
  const attempts = [
    request(app).post(`/api/finance/goals/${id}/contributions`).send({ contributionMinor: 100 }),
    request(app).post('/api/finance/goals').send({ name: 'x', targetAmount: 10 }),
    request(app).patch(`/api/finance/goals/${id}`).send({ name: 'Renamed' }),
    request(app).delete(`/api/finance/goals/${id}`),
  ];
  for (const attempt of attempts) {
    const response = await attempt
      .set('X-Clarity-Contract', '1')
      .set('Idempotency-Key', key());
    assert.equal(response.status, 401);
  }
  const forged = await request(app)
    .post(`/api/finance/goals/${id}/contributions`)
    .set('Authorization', 'Bearer not-a-token')
    .set('Idempotency-Key', key())
    .send({ contributionMinor: 100 });
  assert.equal(forged.status, 401);
  assert.deepEqual(await readGoal(id), before);
  assert.equal(await receiptCount(), 0);
});

test('another user cannot contribute to, edit, or delete a goal and learns nothing about it', async () => {
  const id = await insertGoal(owner.id);
  const before = await readGoal(id);

  // Even an out-of-range amount yields the uniform 404, not a bounds error.
  for (const contributionMinor of [100, GAP_MINOR + 1, -5]) {
    const response = await canonical(
      request(app).post(`/api/finance/goals/${id}/contributions`),
      key(),
      otherAuthorization
    ).send({ contributionMinor });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'FINANCIAL_RECORD_NOT_FOUND');
    assert.equal(JSON.stringify(response.body).includes('Emergency'), false);
    assert.equal(response.body.error.constraint, undefined);
  }
  const patch = await canonical(
    request(app).patch(`/api/finance/goals/${id}`),
    key(),
    otherAuthorization
  ).send({ name: 'Hijacked', savedAmountMinor: 0 });
  assert.equal(patch.status, 404);
  const del = await canonical(
    request(app).delete(`/api/finance/goals/${id}`),
    key(),
    otherAuthorization
  ).send({});
  assert.equal(del.status, 404);
  const legacyPatch = await legacy(
    request(app).patch(`/api/finance/goals/${id}`),
    otherAuthorization
  ).send({ name: 'Hijacked' });
  assert.equal(legacyPatch.status, 404);
  assert.deepEqual(legacyPatch.body, { error: 'Not found' });

  assert.deepEqual(await readGoal(id), before);
  assert.equal(await receiptCount(), 0);
});

test('contribution bounds are exact at the funding gap and track the current gap', async () => {
  const id = await insertGoal(owner.id);

  const over = await canonical(
    request(app).post(`/api/finance/goals/${id}/contributions`),
    key()
  ).send({ contributionMinor: GAP_MINOR + 1 });
  assert.equal(over.status, 422);
  assert.equal(over.body.error.code, 'GOAL_CONTRIBUTION_OUT_OF_RANGE');
  assert.equal(over.body.error.field, 'contributionMinor');
  assert.deepEqual(over.body.error.constraint, {
    minMinor: 1,
    maxMinor: GAP_MINOR,
    integer: true,
  });
  assert.equal((await readGoal(id)).saved_amount, 250);
  assert.equal(await receiptCount(), 0);

  const first = await canonical(
    request(app).post(`/api/finance/goals/${id}/contributions`),
    key()
  ).send({ contributionMinor: 50_000, expectedRecordVersion: 0 });
  assert.equal(first.status, 200);
  assert.equal(first.body.ok, true);
  assert.equal(first.body.schemaVersion, 1);
  assert.equal(first.body.goal.saved_amount, 750);
  assert.deepEqual(Object.keys(first.body.goal).sort(), [
    'created_at', 'id', 'name', 'saved_amount', 'target_amount', 'target_date', 'updated_at',
  ]);
  assert.equal(first.body.mutation.operation, 'goal.contribute');
  assert.equal(first.body.mutation.scopeKey, `goal:${id}`);
  assert.equal(first.body.mutation.recordVersion, 1);
  assert.equal(first.body.mutation.record.savedAmountMinor, 75_000);
  assert.equal(first.body.mutation.goalTransition.outcome.fundingGapMinor, 25_000);
  assert.equal(first.body.mutation.acceptedConstraints.contributionMinor.minMinor, 1);
  assert.equal(first.body.clarity.dataVersion, 1);

  // The gap shrank, so the former maximum is now out of range.
  const stale = await canonical(
    request(app).post(`/api/finance/goals/${id}/contributions`),
    key()
  ).send({ contributionMinor: GAP_MINOR });
  assert.equal(stale.status, 422);
  assert.equal(stale.body.error.constraint.maxMinor, 25_000);

  const exact = await canonical(
    request(app).post(`/api/finance/goals/${id}/contributions`),
    key()
  ).send({ contributionAmount: '250.00', expectedRecordVersion: 1 });
  assert.equal(exact.status, 200);
  assert.equal(exact.body.goal.saved_amount, 1000);
  assert.equal(exact.body.mutation.goalTransition.outcome.status, 'funded');
  assert.equal(exact.body.mutation.goalTransition.outcome.requiredContributionMinor, 0);

  const funded = await canonical(
    request(app).post(`/api/finance/goals/${id}/contributions`),
    key()
  ).send({ contributionMinor: 1 });
  assert.equal(funded.status, 422);
  assert.equal(funded.body.error.constraint.maxMinor, 0);
  assert.equal((await readGoal(id)).saved_amount, 1000);
  assert.equal(await receiptCount(), 2);
});

test('negative and zero contributions are rejected and never withdraw funds', async () => {
  const id = await insertGoal(owner.id);
  for (const body of [
    { contributionMinor: -1 },
    { contributionMinor: -GAP_MINOR },
    { contributionMinor: -250_000 },
    { contributionMinor: 0 },
    { contributionAmount: '-5.00' },
  ]) {
    const response = await canonical(
      request(app).post(`/api/finance/goals/${id}/contributions`),
      key()
    ).send(body);
    assert.equal(response.status, 422, JSON.stringify(body));
    assert.equal(response.body.error.code, 'GOAL_CONTRIBUTION_OUT_OF_RANGE');
    assert.equal(response.body.error.constraint.minMinor, 1);
  }
  const malformed = await canonical(
    request(app).post(`/api/finance/goals/${id}/contributions`),
    key()
  ).send({ contributionMinor: 1.5 });
  assert.equal(malformed.status, 400);
  const missing = await canonical(
    request(app).post(`/api/finance/goals/${id}/contributions`),
    key()
  ).send({});
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.code, 'GOAL_CONTRIBUTION_REQUIRED');

  // The contract PATCH also refuses withdrawal-style increments.
  const addNegative = await canonical(
    request(app).patch(`/api/finance/goals/${id}`),
    key()
  ).send({ addToSaved: -100 });
  assert.equal(addNegative.status, 400);
  assert.equal(addNegative.body.error.code, 'GOAL_ADD_TO_SAVED_NOT_SUPPORTED');

  assert.equal((await readGoal(id)).saved_amount, 250);
  assert.equal(await receiptCount(), 0);
});

test('an idempotent replay applies the contribution exactly once', async () => {
  const id = await insertGoal(owner.id);
  const replayKey = key();
  const first = await canonical(
    request(app).post(`/api/finance/goals/${id}/contributions`),
    replayKey
  ).send({ contributionMinor: 10_000 });
  assert.equal(first.status, 200);
  assert.equal(first.body.mutation.replayed, false);

  const replay = await canonical(
    request(app).post(`/api/finance/goals/${id}/contributions`),
    replayKey.toUpperCase()
  ).send({ contributionAmount: '100.00' });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.mutation.replayed, true);
  assert.equal(replay.body.mutation.changeId, first.body.mutation.changeId);
  assert.equal(replay.body.mutation.recordVersion, 1);
  assert.equal(replay.body.goal.saved_amount, 350);

  assert.equal((await readGoal(id)).saved_amount, 350);
  assert.equal(await receiptCount(), 1);
});

test('reusing a key for a different command conflicts and changes nothing', async () => {
  const id = await insertGoal(owner.id);
  const otherId = await insertGoal(owner.id, { name: 'Second goal' });
  const reusedKey = key();
  const first = await canonical(
    request(app).post(`/api/finance/goals/${id}/contributions`),
    reusedKey
  ).send({ contributionMinor: 10_000 });
  assert.equal(first.status, 200);

  const differentAmount = await canonical(
    request(app).post(`/api/finance/goals/${id}/contributions`),
    reusedKey
  ).send({ contributionMinor: 10_001 });
  assert.equal(differentAmount.status, 409);
  assert.equal(differentAmount.body.error.code, 'IDEMPOTENCY_KEY_REUSED');

  const differentGoal = await canonical(
    request(app).post(`/api/finance/goals/${otherId}/contributions`),
    reusedKey
  ).send({ contributionMinor: 10_000 });
  assert.equal(differentGoal.status, 409);
  assert.equal(differentGoal.body.error.code, 'IDEMPOTENCY_KEY_REUSED');

  assert.equal((await readGoal(id)).saved_amount, 350);
  assert.equal((await readGoal(otherId)).saved_amount, 250);
  assert.equal(await receiptCount(), 1);
});

test('an idempotency key is required and a stale expected version is rejected', async () => {
  const id = await insertGoal(owner.id);
  const noKey = await request(app)
    .post(`/api/finance/goals/${id}/contributions`)
    .set('Authorization', authorization)
    .send({ contributionMinor: 100 });
  assert.equal(noKey.status, 400);
  assert.equal(noKey.body.error.code, 'INVALID_IDEMPOTENCY_KEY');

  const first = await canonical(
    request(app).post(`/api/finance/goals/${id}/contributions`),
    key()
  ).send({ contributionMinor: 100, expectedRecordVersion: 0 });
  assert.equal(first.status, 200);

  const conflict = await canonical(
    request(app).post(`/api/finance/goals/${id}/contributions`),
    key()
  ).send({ contributionMinor: 100, expectedRecordVersion: 0 });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'RECORD_VERSION_CONFLICT');
  assert.equal(conflict.body.error.currentRecordVersion, 1);

  // A contract edit advances the same record version.
  const edit = await canonical(
    request(app).patch(`/api/finance/goals/${id}`),
    key()
  ).send({ name: 'Renamed', expectedRecordVersion: 1 });
  assert.equal(edit.status, 200);
  assert.equal(edit.body.mutation.recordVersion, 2);

  assert.equal((await readGoal(id)).saved_amount, 251);
  assert.equal(await receiptCount(), 2);
});

test('invalid goal drafts retain the preceding confirmed row and write no receipt', async () => {
  const id = await insertGoal(owner.id);
  const before = await readGoal(id);

  const invalid = await canonical(
    request(app).patch(`/api/finance/goals/${id}`),
    key()
  ).send({
    name: '   ',
    targetAmountMinor: 0,
    targetDate: dateAtOffset(-1),
  });
  assert.equal(invalid.status, 422);
  assert.equal(invalid.body.error.field, 'name');
  const fields = invalid.body.error.errors.map((error) => error.field).sort();
  assert.deepEqual(fields, ['name', 'targetAmountMinor', 'targetDate']);
  for (const error of invalid.body.error.errors) {
    assert.ok(error.constraint, `${error.field} reports its accepted bound`);
  }
  assert.deepEqual(await readGoal(id), before);

  const overTarget = await canonical(
    request(app).patch(`/api/finance/goals/${id}`),
    key()
  ).send({ savedAmountMinor: 100_001 });
  assert.equal(overTarget.status, 422);
  assert.equal(overTarget.body.error.code, 'GOAL_SAVED_AMOUNT_EXCEEDS_TARGET');
  assert.equal(overTarget.body.error.field, 'savedAmountMinor');

  const negativeSaved = await canonical(
    request(app).patch(`/api/finance/goals/${id}`),
    key()
  ).send({ savedAmount: '-1' });
  assert.equal(negativeSaved.status, 422);
  assert.equal(negativeSaved.body.error.code, 'INVALID_GOAL_SAVED_AMOUNT');

  const badCreate = await canonical(
    request(app).post('/api/finance/goals'),
    key()
  ).send({ name: 'Past', targetAmount: '100.00', targetDate: dateAtOffset(-2) });
  assert.equal(badCreate.status, 422);
  assert.equal(badCreate.body.error.code, 'GOAL_TARGET_DATE_IN_PAST');
  const undatedCreate = await canonical(
    request(app).post('/api/finance/goals'),
    key()
  ).send({ name: 'Undated', targetAmount: '100.00' });
  assert.equal(undatedCreate.status, 422);
  assert.equal(undatedCreate.body.error.field, 'targetDate');

  assert.deepEqual(await readGoal(id), before);
  assert.equal(await count('SELECT COUNT(*) AS count FROM savings_goals'), 1);
  assert.equal(await receiptCount(), 0);
});

test('contract create, edit, and delete keep legacy top-level fields and add the envelope', async () => {
  const created = await canonical(request(app).post('/api/finance/goals'), key()).send({
    name: 'Laptop',
    targetAmount: '1500.50',
    savedAmount: '100',
    targetDate: dateAtOffset(3),
  });
  assert.equal(created.status, 200);
  assert.ok(Number.isInteger(created.body.id));
  assert.equal(created.body.schemaVersion, 1);
  assert.equal(created.body.mutation.operation, 'goal.create');
  assert.equal(created.body.mutation.scopeKey, `goal:${created.body.id}`);
  assert.equal(created.body.mutation.record.targetAmountMinor, 150_050);
  assert.equal(created.body.mutation.goalTransition.outcome.fundingGapMinor, 140_050);
  assert.ok(created.body.mutation.goalTransition.outcome.requiredContributionMinor > 0);
  assert.ok(created.body.clarity);
  const id = created.body.id;

  const edited = await canonical(request(app).patch(`/api/finance/goals/${id}`), key()).send({
    name: 'Laptop pro',
    savedAmountMinor: 20_000,
    expectedRecordVersion: 1,
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.ok, true);
  assert.equal(edited.body.mutation.recordVersion, 2);
  assert.equal((await readGoal(id)).name, 'Laptop pro');
  assert.equal((await readGoal(id)).saved_amount, 200);

  const deleteKey = key();
  const deleted = await canonical(request(app).delete(`/api/finance/goals/${id}`), deleteKey)
    .send({ expectedRecordVersion: 2 });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.ok, true);
  assert.equal(deleted.body.mutation.status, 'reversed');
  assert.equal(await readGoal(id), null);

  const replay = await canonical(
    request(app).delete(`/api/finance/goals/${id}`),
    deleteKey
  ).send({ expectedRecordVersion: 2 });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.mutation.replayed, true);
  assert.equal(replay.body.mutation.changeId, deleted.body.mutation.changeId);
  assert.equal(await receiptCount(), 3);
});

test('legacy requests keep their response shapes while being strictly validated', async () => {
  const created = await legacy(request(app).post('/api/finance/goals')).send({
    name: 'Phone',
    targetAmount: 500,
    savedAmount: 50,
    targetDate: dateAtOffset(2),
  });
  assert.equal(created.status, 200);
  assert.deepEqual(Object.keys(created.body), ['id']);
  const id = created.body.id;

  const added = await legacy(request(app).patch(`/api/finance/goals/${id}`))
    .send({ addToSaved: 100 });
  assert.equal(added.status, 200);
  assert.deepEqual(added.body, { ok: true });
  assert.equal((await readGoal(id)).saved_amount, 150);

  // Over the gap, past the target, or blank: strict 400 with the legacy shape.
  const attempts = [
    { addToSaved: 350.01 },
    { setSaved: 501 },
    { targetDate: dateAtOffset(-1) },
    { targetDate: 'not-a-date' },
    { targetAmount: 100 },
  ];
  for (const body of attempts) {
    const response = await legacy(request(app).patch(`/api/finance/goals/${id}`)).send(body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.deepEqual(Object.keys(response.body), ['error']);
    assert.equal(typeof response.body.error, 'string');
  }
  assert.deepEqual(await readGoal(id), {
    name: 'Phone',
    target_amount: 500,
    saved_amount: 150,
    target_date: dateAtOffset(2),
  });

  const emptyPatch = await legacy(request(app).patch(`/api/finance/goals/${id}`)).send({});
  assert.deepEqual(emptyPatch.body, { error: 'Nothing to update' });

  const badCreates = [
    { name: 'Late', targetAmount: 10, targetDate: dateAtOffset(-1) },
    { name: 'Over', targetAmount: 10, savedAmount: 11 },
    { name: 'Fraction', targetAmount: 10.001 },
    { name: 'Impossible', targetAmount: 10, targetDate: `${dateAtOffset(1).slice(0, 7)}-31`.replace(/-31$/, '-32') },
  ];
  for (const body of badCreates) {
    const response = await legacy(request(app).post('/api/finance/goals')).send(body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.deepEqual(Object.keys(response.body), ['error']);
  }
  assert.equal(await count('SELECT COUNT(*) AS count FROM savings_goals'), 1);

  // Undated goals created by the legacy UI remain supported.
  const undated = await legacy(request(app).post('/api/finance/goals'))
    .send({ name: 'Open ended', targetAmount: 40 });
  assert.equal(undated.status, 200);
  assert.equal((await readGoal(undated.body.id)).target_date, null);

  const listed = await legacy(request(app).get('/api/finance/goals'));
  assert.deepEqual(Object.keys(listed.body.goals[0]).sort(), [
    'created_at', 'id', 'name', 'saved_amount', 'target_amount', 'target_date', 'updated_at',
  ]);

  const deleted = await legacy(request(app).delete(`/api/finance/goals/${id}`));
  assert.deepEqual(deleted.body, { ok: true });
  const missing = await legacy(request(app).delete(`/api/finance/goals/${id}`));
  assert.equal(missing.status, 404);
  assert.equal(await receiptCount(), 0);
});

test('legacy-invalid goals stay exportable and correctable without silent normalization', async () => {
  const id = await insertGoal(owner.id, {
    name: 'Legacy overfunded',
    target: 1000,
    saved: 1250,
    date: null,
  });

  // Renaming leaves the overfunded amount and missing date exactly as stored.
  const renamed = await canonical(request(app).patch(`/api/finance/goals/${id}`), key())
    .send({ name: 'Renamed legacy' });
  assert.equal(renamed.status, 200);
  assert.deepEqual(await readGoal(id), {
    name: 'Renamed legacy',
    target_amount: 1000,
    saved_amount: 1250,
    target_date: null,
  });

  // New contributions are refused until the data is corrected; nothing changes.
  const blocked = await canonical(
    request(app).post(`/api/finance/goals/${id}/contributions`),
    key()
  ).send({ contributionMinor: 100 });
  assert.equal(blocked.status, 422);
  assert.equal(blocked.body.error.code, 'GOAL_REQUIRES_CORRECTION');
  assert.equal((await readGoal(id)).saved_amount, 1250);

  // Correction via PATCH: the amount must satisfy the strict relation.
  const stillOver = await canonical(request(app).patch(`/api/finance/goals/${id}`), key())
    .send({ savedAmountMinor: 100_001 });
  assert.equal(stillOver.status, 422);
  const fixedAmount = await canonical(request(app).patch(`/api/finance/goals/${id}`), key())
    .send({ savedAmountMinor: 90_000 });
  assert.equal(fixedAmount.status, 200);
  const fixedDate = await canonical(request(app).patch(`/api/finance/goals/${id}`), key())
    .send({ targetDate: dateAtOffset(4) });
  assert.equal(fixedDate.status, 200);

  const contribution = await canonical(
    request(app).post(`/api/finance/goals/${id}/contributions`),
    key()
  ).send({ contributionMinor: 10_000 });
  assert.equal(contribution.status, 200);
  assert.equal(contribution.body.goal.saved_amount, 1000);

  // The unversioned legacy correction path also still works on legacy data.
  const legacyId = await insertGoal(owner.id, { target: 1000, saved: 1250, date: null });
  const legacyFix = await legacy(request(app).patch(`/api/finance/goals/${legacyId}`))
    .send({ setSaved: 1000 });
  assert.equal(legacyFix.status, 200);
  assert.equal((await readGoal(legacyId)).saved_amount, 1000);
  assert.equal((await readGoal(legacyId)).target_date, null);
});

test('the data-use notice gates new contribution submissions but not correction or deletion', async () => {
  const id = await insertGoal(owner.id);
  await db.prepare('DELETE FROM user_financial_state WHERE user_id = ?').run(owner.id);

  const blocked = await canonical(
    request(app).post(`/api/finance/goals/${id}/contributions`),
    key()
  ).send({ contributionMinor: 100 });
  assert.equal(blocked.status, 428);
  assert.equal(blocked.body.error.code, 'DATA_NOTICE_REQUIRED');
  assert.equal((await readGoal(id)).saved_amount, 250);

  const blockedCreate = await canonical(request(app).post('/api/finance/goals'), key()).send({
    name: 'New use',
    targetAmount: '10.00',
    targetDate: dateAtOffset(2),
  });
  assert.equal(blockedCreate.status, 428);
  assert.equal(await count('SELECT COUNT(*) AS count FROM savings_goals'), 1);

  const correction = await canonical(request(app).patch(`/api/finance/goals/${id}`), key())
    .send({ savedAmountMinor: 10_000 });
  assert.equal(correction.status, 200);
  const removal = await canonical(request(app).delete(`/api/finance/goals/${id}`), key())
    .send({});
  assert.equal(removal.status, 200);
  assert.equal(await readGoal(id), null);
});

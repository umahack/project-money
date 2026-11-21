import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createIsolatedTestDatabase } from '../helpers/testDatabase.js';
import { buildSessionFixture, buildUserFixture } from '../helpers/fixtures.js';

const BASE = '/api/clarity/journeys';

let testDatabase;
let db;
let app;
let modules;
let owner;
let ownerSession;
let otherUser;
let otherSession;
let freshUser;
let freshSession;
let authorization;
let otherAuthorization;
let freshAuthorization;
let keyCounter = 0;

function tokenFor(user, session) {
  return `Bearer ${jwt.sign(
    { sub: String(user.id), tv: user.token_version, sid: session.id },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '5m' }
  )}`;
}

async function insertAccount(user, session) {
  await db.prepare(
    `INSERT INTO users (id, email, name, password_hash, is_admin, token_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(user.id, user.email, user.name, user.password_hash, user.is_admin, user.token_version, user.created_at);
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

function key() {
  keyCounter += 1;
  return `b1000000-0000-4000-8000-${String(keyCounter).padStart(12, '0')}`;
}

function canonical(builder, token = authorization) {
  return builder
    .set('Authorization', token)
    .set('X-Clarity-Contract', '1')
    .set('Idempotency-Key', key());
}

function authed(builder, token = authorization) {
  return builder.set('Authorization', token);
}

function localDate(offsetMonths = 0, day = null) {
  const date = new Date();
  date.setDate(1);
  date.setMonth(date.getMonth() + offsetMonths);
  const dayOfMonth = day ?? Math.min(new Date().getDate(), 28);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(dayOfMonth).padStart(2, '0')}`;
}

function currentMonth() {
  return localDate(0).slice(0, 7);
}

async function createSalary(token = authorization) {
  const response = await canonical(request(app).post('/api/finance/salary'), token)
    .send({ amountMinor: 5_000_000, month: currentMonth(), expectedRecordVersion: 0 });
  assert.equal(response.status, 200);
  return response.body.mutation.changeId;
}

async function createExpense(token = authorization) {
  const response = await canonical(request(app).post('/api/finance/expenses'), token)
    .send({ amount: '125.50', category: 'Food', note: 'Lunch', spentOn: localDate(0), expectedRecordVersion: 0 });
  assert.equal(response.status, 200);
  return response.body.mutation.changeId;
}

async function createGoal(token = authorization) {
  const response = await canonical(request(app).post('/api/finance/goals'), token)
    .send({ name: 'Laptop', targetAmount: '1000.00', savedAmount: '250.00', targetDate: localDate(6, 15) });
  assert.equal(response.status, 200);
  return response.body.mutation.changeId;
}

async function createTripWithSplit(token = authorization) {
  const trip = await authed(request(app).post('/api/trips'), token)
    .send({ name: 'Goa', budget: 20000 });
  assert.equal(trip.status, 200);
  const tripId = trip.body.id;
  const ledger = await authed(request(app).get(`/api/trips/${tripId}`), token);
  const ownerName = ledger.body.members[0].name;
  const member = await authed(request(app).post(`/api/trips/${tripId}/members`), token)
    .send({ name: 'Ben' });
  assert.equal(member.status, 200);
  const expense = await authed(request(app).post(`/api/trips/${tripId}/expenses`), token)
    .send({
      payer: ownerName,
      description: 'Hotel',
      amount: 6000,
      split: [{ name: ownerName, share: 1 }, { name: 'Ben', share: 1 }],
    });
  assert.equal(expense.status, 200);
  return { tripId, memberChangeId: member.body.mutation.changeId, splitChangeId: expense.body.mutation.changeId };
}

async function start(desiredOutcome, token = authorization) {
  return authed(request(app).post(BASE), token).send({ desiredOutcome });
}

async function patch(id, body, token = authorization) {
  return authed(request(app).patch(`${BASE}/${id}`), token).send(body);
}

async function stored(journeyId) {
  const row = await db.prepare(
    'SELECT status, completed_step_keys, started_session_id, measurement_eligible FROM guided_journeys WHERE id = ?'
  ).get(journeyId);
  return {
    status: row.status,
    steps: JSON.parse(row.completed_step_keys),
    startedSessionId: row.started_session_id,
    measurementEligible: Number(row.measurement_eligible),
  };
}

async function financialSnapshot() {
  const rows = await Promise.all([
    db.prepare('SELECT COUNT(*) AS n FROM salary_entries').get(),
    db.prepare('SELECT COUNT(*) AS n FROM expense_log').get(),
    db.prepare('SELECT COUNT(*) AS n FROM emis').get(),
    db.prepare('SELECT COUNT(*) AS n FROM savings_goals').get(),
    db.prepare('SELECT COUNT(*) AS n FROM financial_record_changes').get(),
    db.prepare('SELECT COALESCE(SUM(data_version), 0) AS n FROM user_financial_state').get(),
  ]);
  return rows.map((row) => Number(row.n));
}

before(async () => {
  testDatabase = await createIsolatedTestDatabase();
  db = testDatabase.db;
  process.env.FINANCIAL_MUTATION_HMAC_KEY =
    'test-only-journey-routes-hmac-key-32-bytes-minimum';
  const [{ createApp }, journeyService, journeyRepo, financialRepo, settings, journeyRouter] =
    await Promise.all([
      import('../../src/app.js'),
      import('../../src/services/journeyService.js'),
      import('../../src/repositories/journeyRepository.js'),
      import('../../src/repositories/financialRepository.js'),
      import('../../src/services/claritySettings.js'),
      import('../../src/routes/journeys.js'),
    ]);
  modules = {
    JourneyService: journeyService.JourneyService,
    journeyRepository: journeyRepo.default,
    JOURNEY_DEFINITIONS: journeyRepo.JOURNEY_DEFINITIONS,
    financialRepository: financialRepo.default,
    claritySettingsService: settings.default,
    createJourneysRouter: journeyRouter.createJourneysRouter,
  };
  app = createApp();
});

beforeEach(async () => {
  await testDatabase.reset();
  owner = buildUserFixture({ id: 15_001, email: 'journey-owner@example.test' });
  ownerSession = buildSessionFixture({ userId: owner.id, id: 15_101 });
  otherUser = buildUserFixture({ id: 15_002, email: 'journey-other@example.test' });
  otherSession = buildSessionFixture({ userId: otherUser.id, id: 15_102 });
  freshUser = buildUserFixture({ id: 15_003, email: 'journey-fresh@example.test' });
  freshSession = buildSessionFixture({ userId: freshUser.id, id: 15_103 });
  await insertAccount(owner, ownerSession);
  await insertAccount(otherUser, otherSession);
  await insertAccount(freshUser, freshSession);
  for (const user of [owner, otherUser]) {
    await db.prepare(
      `INSERT INTO user_financial_state
        (user_id, data_use_notice_version, data_use_acknowledged_at)
       VALUES (?, 1, CURRENT_TIMESTAMP)`
    ).run(user.id);
  }
  authorization = tokenFor(owner, ownerSession);
  otherAuthorization = tokenFor(otherUser, otherSession);
  freshAuthorization = tokenFor(freshUser, freshSession);
});

afterEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
});

after(async () => {
  await testDatabase?.cleanup();
});

test('journey routes require a live authenticated session', async () => {
  const attempts = [
    request(app).get(`${BASE}/active`),
    request(app).post(BASE).send({ desiredOutcome: 'plan_month' }),
    request(app).patch(`${BASE}/1`).send({ action: 'pause' }),
  ];
  for (const attempt of attempts) {
    const response = await attempt;
    assert.equal(response.status, 401);
  }
  const badToken = await request(app)
    .get(`${BASE}/active`)
    .set('Authorization', 'Bearer not-a-token');
  assert.equal(badToken.status, 401);
});

test('server-owned definitions stay within three required steps and categories', () => {
  assert.deepEqual(Object.keys(modules.JOURNEY_DEFINITIONS), [
    'plan_month',
    'control_spending',
    'fund_goal',
    'settle_trip',
  ]);
  assert.deepEqual(modules.JOURNEY_DEFINITIONS.settle_trip.requiredStepKeys, [
    'trip',
    'trip_members',
    'trip_split',
  ]);
  for (const definition of Object.values(modules.JOURNEY_DEFINITIONS)) {
    assert.ok(definition.requiredStepKeys.length <= 3);
  }
});

test('active journey is null until one starts, then start is idempotent per outcome', async () => {
  const empty = await authed(request(app).get(`${BASE}/active`));
  assert.equal(empty.status, 200);
  assert.equal(empty.body.journey, null);

  const first = await start('plan_month');
  assert.equal(first.status, 201);
  assert.equal(first.body.journey.desiredOutcome, 'plan_month');
  assert.deepEqual(first.body.journey.requiredStepKeys, ['salary']);
  assert.equal(first.body.journey.nextIncompleteStepKey, 'salary');
  assert.equal(first.body.journey.firstOutcome.available, false);
  assert.equal(first.body.journey.status, 'active');

  const again = await start('plan_month');
  assert.equal(again.status, 200);
  assert.equal(again.body.journey.id, first.body.journey.id);
  const count = await db.prepare('SELECT COUNT(*) AS n FROM guided_journeys WHERE user_id = ?').get(owner.id);
  assert.equal(Number(count.n), 1);

  const different = await start('fund_goal');
  assert.equal(different.status, 409);
  assert.equal(different.body.error.code, 'JOURNEY_ALREADY_ACTIVE');
  assert.equal(different.body.error.activeJourneyId, first.body.journey.id);

  const active = await authed(request(app).get(`${BASE}/active`));
  assert.equal(active.body.journey.id, first.body.journey.id);
});

test('start snapshots the session and measurement eligibility without emitting events', async () => {
  const defaultStart = await start('plan_month');
  assert.deepEqual(await stored(defaultStart.body.journey.id), {
    status: 'active',
    steps: [],
    startedSessionId: ownerSession.id,
    measurementEligible: 0,
  });

  await db.prepare('DELETE FROM guided_journeys WHERE user_id = ?').run(owner.id);
  await db.prepare(
    `UPDATE user_financial_state
        SET analytics_enabled = 1, analytics_consent_version = 1
      WHERE user_id = ?`
  ).run(owner.id);
  const eligible = await start('plan_month');
  const row = await stored(eligible.body.journey.id);
  assert.equal(row.measurementEligible, 1);

  await createSalary();
  const advanced = await patch(eligible.body.journey.id, { action: 'complete_step', stepKey: 'salary' });
  assert.equal(advanced.status, 200);
  const events = await db.prepare('SELECT COUNT(*) AS n FROM product_measurement_events').get();
  assert.equal(Number(events.n), 0);
});

test('only the four fixed outcomes and fixed step keys are accepted', async () => {
  for (const body of [
    {},
    { desiredOutcome: 'invest' },
    { desiredOutcome: 7 },
    { desiredOutcome: 'plan_month', steps: ['salary'] },
    { desiredOutcome: 'plan_month', requiredStepKeys: ['salary', 'bills'] },
    { desiredOutcome: 'plan_month', id: 5 },
    JSON.parse('{"desiredOutcome":"plan_month","__proto__":{"x":1}}'),
  ]) {
    const response = await authed(request(app).post(BASE)).send(body);
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  const array = await authed(request(app).post(BASE)).send([{ desiredOutcome: 'plan_month' }]);
  assert.equal(array.status, 400);
  const count = await db.prepare('SELECT COUNT(*) AS n FROM guided_journeys').get();
  assert.equal(Number(count.n), 0);

  const created = await start('control_spending');
  const id = created.body.journey.id;
  for (const body of [
    { action: 'complete_step', stepKey: 'crypto' },
    { action: 'complete_step', stepKey: 'trip' },
    { action: 'complete_step', stepKey: 'salary', steps: ['x'] },
    { action: 'complete_step', stepKey: 'salary', amount: 5000 },
    { action: 'complete_step', stepKey: 'salary', changeId: 'abc' },
    { action: 'complete_step', stepKey: 'salary', changeId: -1 },
    { action: 'complete_step' },
    { action: 'skip_step', stepKey: 'bills', note: 'x' },
    { action: 'pause', stepKey: 'salary' },
    { action: 'delete' },
    { stepKey: 'salary' },
  ]) {
    const response = await patch(id, body);
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  assert.deepEqual((await stored(id)).steps, []);
  assert.deepEqual(await financialSnapshot(), [0, 0, 0, 0, 0, 0]);
});

test('mutating routes require the current data-use notice except pause and resume', async () => {
  const blocked = await start('plan_month', freshAuthorization);
  assert.equal(blocked.status, 428);
  assert.equal(blocked.body.error.code, 'DATA_NOTICE_REQUIRED');
  const count = await db.prepare('SELECT COUNT(*) AS n FROM guided_journeys WHERE user_id = ?').get(freshUser.id);
  assert.equal(Number(count.n), 0);

  const read = await authed(request(app).get(`${BASE}/active`), freshAuthorization);
  assert.equal(read.status, 200);

  const created = await start('plan_month');
  await db.prepare('UPDATE user_financial_state SET data_use_notice_version = 0 WHERE user_id = ?').run(owner.id);
  const gatedStep = await patch(created.body.journey.id, { action: 'complete_step', stepKey: 'salary' });
  assert.equal(gatedStep.status, 428);
  const paused = await patch(created.body.journey.id, { action: 'pause' });
  assert.equal(paused.status, 200);
  assert.equal(paused.body.journey.status, 'paused');
});

test('existing confirmed records skip a new journey ahead', async () => {
  await createSalary();
  const created = await start('control_spending');
  const { journey } = created.body;
  assert.equal(created.status, 201);
  assert.deepEqual(journey.completedRequiredStepKeys, ['salary']);
  assert.deepEqual(journey.remainingRequiredStepKeys, ['expense']);
  assert.equal(journey.nextIncompleteStepKey, 'expense');
  assert.equal(journey.currentStepKey, 'expense');
  assert.equal(journey.progress.currentStepNumber, 2);
  assert.equal(journey.steps.find(({ key }) => key === 'salary').status, 'satisfied');
  assert.deepEqual((await stored(journey.id)).steps, ['salary']);
  assert.equal(journey.firstOutcome.available, false);
});

test('a step advances only after the server confirms its financial change', async () => {
  const created = await start('control_spending');
  const id = created.body.journey.id;
  const before = await financialSnapshot();

  const unconfirmed = await patch(id, { action: 'complete_step', stepKey: 'salary' });
  assert.equal(unconfirmed.status, 409);
  assert.equal(unconfirmed.body.error.code, 'STEP_NOT_CONFIRMED');
  assert.equal(unconfirmed.body.error.stepKey, 'salary');
  assert.equal(unconfirmed.body.error.retryScopeKey, `journey:${id}:salary`);
  assert.equal(unconfirmed.body.journey.nextIncompleteStepKey, 'salary');
  assert.deepEqual((await stored(id)).steps, []);
  assert.deepEqual(await financialSnapshot(), before);

  const salaryChange = await createSalary();
  const expenseChange = await createExpense();

  const mismatch = await patch(id, { action: 'complete_step', stepKey: 'salary', changeId: expenseChange });
  assert.equal(mismatch.status, 422);
  assert.equal(mismatch.body.error.code, 'CHANGE_STEP_MISMATCH');
  const missing = await patch(id, { action: 'complete_step', stepKey: 'salary', changeId: 999_999 });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'CHANGE_NOT_FOUND');
  assert.deepEqual((await stored(id)).steps, []);

  const salary = await patch(id, { action: 'complete_step', stepKey: 'salary', changeId: salaryChange });
  assert.equal(salary.status, 200);
  assert.equal(salary.body.transition.stepKey, 'salary');
  assert.equal(salary.body.transition.unlocks, 'disposable_income_and_allocation');
  assert.equal(salary.body.transition.confirmedChangeId, salaryChange);
  assert.equal(
    salary.body.journey.steps.find(({ key }) => key === 'salary').confirmedChangeId,
    salaryChange
  );

  const expense = await patch(id, { action: 'complete_step', stepKey: 'expense', changeId: expenseChange });
  assert.equal(expense.status, 200);
  assert.deepEqual(expense.body.journey.remainingRequiredStepKeys, []);
  assert.equal(expense.body.journey.firstOutcome.available, true);
  assert.equal(expense.body.journey.firstOutcome.kind, 'spending');
  assert.equal(expense.body.journey.firstOutcome.outcomeId, `spending:${currentMonth()}`);
  assert.deepEqual((await stored(id)).steps.sort(), ['expense', 'salary']);

  const replay = await patch(id, { action: 'complete_step', stepKey: 'expense', changeId: expenseChange });
  assert.equal(replay.status, 200);
  assert.deepEqual((await stored(id)).steps.sort(), ['expense', 'salary']);
  const journeyBody = JSON.stringify(expense.body);
  for (const forbidden of ['Lunch', '125.5', '12550', '5000000']) {
    assert.ok(!journeyBody.includes(forbidden), `${forbidden} must not be copied into journey state`);
  }
});

test('a change receipt from another user or a reversed change is rejected', async () => {
  const created = await start('control_spending');
  const id = created.body.journey.id;
  const otherSalary = await createSalary(otherAuthorization);
  const foreign = await patch(id, { action: 'complete_step', stepKey: 'salary', changeId: otherSalary });
  assert.equal(foreign.status, 404);
  assert.equal(foreign.body.error.code, 'CHANGE_NOT_FOUND');

  await createSalary();
  const own = await db.prepare(
    "SELECT id FROM financial_record_changes WHERE user_id = ? AND record_type = 'salary'"
  ).get(owner.id);
  await db.prepare("UPDATE financial_record_changes SET status = 'reversed' WHERE id = ?").run(own.id);
  const reversed = await patch(id, { action: 'complete_step', stepKey: 'salary', changeId: Number(own.id) });
  assert.equal(reversed.status, 422);
  assert.equal(reversed.body.error.code, 'CHANGE_NOT_CONFIRMED');
});

test('pause preserves progress and resume continues at the next incomplete step', async () => {
  await createSalary();
  const created = await start('control_spending');
  const id = created.body.journey.id;

  const paused = await patch(id, { action: 'pause' });
  assert.equal(paused.status, 200);
  assert.equal(paused.body.journey.status, 'paused');
  assert.deepEqual((await stored(id)).steps, ['salary']);
  const pausedAgain = await patch(id, { action: 'pause' });
  assert.equal(pausedAgain.status, 200);

  const whilePaused = await patch(id, { action: 'complete_step', stepKey: 'expense' });
  assert.equal(whilePaused.status, 409);
  assert.equal(whilePaused.body.error.code, 'JOURNEY_PAUSED');

  const active = await authed(request(app).get(`${BASE}/active`));
  assert.equal(active.body.journey.id, id);
  assert.equal(active.body.journey.status, 'paused');

  await createExpense();
  const resumed = await patch(id, { action: 'resume' });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.journey.status, 'active');
  assert.deepEqual(resumed.body.journey.remainingRequiredStepKeys, []);
  assert.equal(resumed.body.journey.firstOutcome.available, true);
  assert.deepEqual((await stored(id)).steps.sort(), ['expense', 'salary']);
  assert.equal(resumed.body.journey.nextChoice.stepKey, 'bills');
});

test('resume re-evaluates records and does not request completed data again', async () => {
  const created = await start('control_spending');
  const id = created.body.journey.id;
  await patch(id, { action: 'pause' });
  await createSalary();
  const resumed = await patch(id, { action: 'resume' });
  assert.equal(resumed.body.journey.nextIncompleteStepKey, 'expense');
  assert.deepEqual(resumed.body.journey.completedRequiredStepKeys, ['salary']);
});

test('optional steps are skipped as financial no-ops after the first outcome', async () => {
  const created = await start('plan_month');
  const id = created.body.journey.id;

  const early = await patch(id, { action: 'skip_step', stepKey: 'bills' });
  assert.equal(early.status, 409);
  assert.equal(early.body.error.code, 'FIRST_OUTCOME_PENDING');

  await createSalary();
  const ready = await patch(id, { action: 'complete_step', stepKey: 'salary' });
  assert.equal(ready.body.journey.nextChoice.stepKey, 'bills');
  assert.equal(ready.body.journey.nextChoice.skippable, true);
  const billStep = ready.body.journey.steps.find(({ key }) => key === 'bills');
  assert.equal(billStep.skip.financialWrite, false);
  assert.equal(billStep.skip.availableOutcomeKind, 'monthly_plan');

  const required = await patch(id, { action: 'skip_step', stepKey: 'salary' });
  assert.equal(required.status, 422);
  assert.equal(required.body.error.code, 'STEP_NOT_OPTIONAL');

  const before = await financialSnapshot();
  const skipped = await patch(id, { action: 'skip_step', stepKey: 'bills' });
  assert.equal(skipped.status, 200);
  assert.equal(skipped.body.journey.steps.find(({ key }) => key === 'bills').status, 'skipped');
  assert.equal(skipped.body.journey.nextChoice, null);
  assert.equal(skipped.body.journey.firstOutcome.available, true);
  assert.deepEqual(await financialSnapshot(), before);
  assert.deepEqual((await stored(id)).steps.sort(), ['bills', 'salary']);

  const replay = await patch(id, { action: 'skip_step', stepKey: 'bills' });
  assert.equal(replay.status, 200);
  assert.deepEqual(await financialSnapshot(), before);
});

test('clarity confirmation completes only once the first outcome exists', async () => {
  const created = await start('plan_month');
  const id = created.body.journey.id;
  const early = await patch(id, { action: 'complete' });
  assert.equal(early.status, 409);
  assert.equal(early.body.error.code, 'FIRST_OUTCOME_PENDING');
  assert.equal((await stored(id)).status, 'active');

  await createSalary();
  const done = await patch(id, { action: 'complete' });
  assert.equal(done.status, 200);
  assert.equal(done.body.journey.status, 'completed');
  assert.equal(done.body.journey.clarityConfirmation.completed, true);
  assert.equal(done.body.journey.currentStepKey, null);
  assert.equal((await stored(id)).status, 'completed');

  const replay = await patch(id, { action: 'complete' });
  assert.equal(replay.status, 200);
  const blocked = await patch(id, { action: 'skip_step', stepKey: 'bills' });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, 'JOURNEY_NOT_ACTIVE');
  const active = await authed(request(app).get(`${BASE}/active`));
  assert.equal(active.body.journey, null);

  const next = await start('fund_goal');
  assert.equal(next.status, 201);
});

test('fund_goal and settle_trip reach their first outcome from confirmed records', async () => {
  await createGoal();
  const goal = await start('fund_goal');
  assert.equal(goal.body.journey.firstOutcome.available, true);
  assert.match(goal.body.journey.firstOutcome.outcomeId, /^goal:\d+$/);
  assert.equal(goal.body.journey.nextChoice.stepKey, 'monthly_plan');
  await patch(goal.body.journey.id, { action: 'complete' });

  const { tripId, memberChangeId, splitChangeId } = await createTripWithSplit();
  const trip = await start('settle_trip');
  assert.equal(trip.status, 201);
  assert.deepEqual(trip.body.journey.remainingRequiredStepKeys, []);
  assert.equal(trip.body.journey.firstOutcome.outcomeId, `trip:${tripId}`);
  const salaryRows = await db.prepare('SELECT COUNT(*) AS n FROM salary_entries WHERE user_id = ?').get(owner.id);
  assert.equal(Number(salaryRows.n), 0);

  const members = await patch(trip.body.journey.id, {
    action: 'complete_step',
    stepKey: 'trip_members',
    changeId: memberChangeId,
  });
  assert.equal(members.status, 200);
  const split = await patch(trip.body.journey.id, {
    action: 'complete_step',
    stepKey: 'trip_split',
    changeId: splitChangeId,
  });
  assert.equal(split.status, 200);
  const tripStep = await patch(trip.body.journey.id, {
    action: 'complete_step',
    stepKey: 'trip',
    changeId: splitChangeId,
  });
  assert.equal(tripStep.status, 422);
  assert.equal(tripStep.body.error.code, 'CHANGE_STEP_MISMATCH');
});

test('journeys are scoped to the authenticated user', async () => {
  const created = await start('plan_month');
  const id = created.body.journey.id;

  const otherActive = await authed(request(app).get(`${BASE}/active`), otherAuthorization);
  assert.equal(otherActive.body.journey, null);
  for (const body of [
    { action: 'pause' },
    { action: 'resume' },
    { action: 'complete' },
    { action: 'complete_step', stepKey: 'salary' },
    { action: 'skip_step', stepKey: 'bills' },
  ]) {
    const response = await patch(id, body, otherAuthorization);
    assert.equal(response.status, 404, JSON.stringify(body));
    assert.equal(response.body.error.code, 'JOURNEY_NOT_FOUND');
  }
  assert.equal((await stored(id)).status, 'active');

  for (const badId of ['abc', '0', '-1', '1.5', '9007199254740993999']) {
    const response = await patch(badId, { action: 'pause' });
    assert.equal(response.status, 404, badId);
  }
  const unknown = await patch(987_654, { action: 'pause' });
  assert.equal(unknown.status, 404);
});

test('a failed journey write leaves progress and records intact and a scoped retry succeeds', async () => {
  await createSalary();
  const created = await start('control_spending');
  const id = created.body.journey.id;
  await createExpense();

  const state = { failSave: false, failRead: false };
  const real = modules.journeyRepository;
  const flakyJourneys = {
    create: (...args) => real.create(...args),
    getById: (...args) => real.getById(...args),
    getResumable: (...args) => real.getResumable(...args),
    pause: (...args) => real.pause(...args),
    getOwnedChangeReceipt: (...args) => real.getOwnedChangeReceipt(...args),
    getLatestConfirmedChangeId: (...args) => real.getLatestConfirmedChangeId(...args),
    listPersonalLinkTripIds: (...args) => real.listPersonalLinkTripIds(...args),
    saveProgress: (...args) => {
      if (state.failSave) {
        state.failSave = false;
        throw new Error('simulated journey write failure');
      }
      return real.saveProgress(...args);
    },
  };
  const realFinancial = modules.financialRepository;
  const flakyFinancial = {
    loadGoals: (...args) => realFinancial.loadGoals(...args),
    listAccessibleTrips: (...args) => realFinancial.listAccessibleTrips(...args),
    loadAccessibleTripLedger: (...args) => realFinancial.loadAccessibleTripLedger(...args),
    loadPeriod: (...args) => {
      if (state.failRead) {
        state.failRead = false;
        throw new Error('simulated record read failure');
      }
      return realFinancial.loadPeriod(...args);
    },
  };
  const flakyApp = express();
  flakyApp.use(express.json());
  flakyApp.use(BASE, modules.createJourneysRouter({
    service: new modules.JourneyService({
      journeys: flakyJourneys,
      financial: flakyFinancial,
      consent: modules.claritySettingsService,
    }),
  }));
  const flakyPatch = (body) => authed(request(flakyApp).patch(`${BASE}/${id}`)).send(body);

  const before = await financialSnapshot();
  assert.deepEqual((await stored(id)).steps, ['salary']);

  state.failSave = true;
  const failedWrite = await flakyPatch({ action: 'complete_step', stepKey: 'expense' });
  assert.equal(failedWrite.status, 500);
  assert.equal(failedWrite.body.error.code, 'JOURNEY_OPERATION_FAILED');
  assert.equal(failedWrite.body.error.retryable, true);
  assert.equal(failedWrite.body.error.retryScopeKey, `journey:${id}:expense`);
  assert.ok(!JSON.stringify(failedWrite.body).includes('simulated'));
  assert.deepEqual((await stored(id)).steps, ['salary']);
  assert.deepEqual(await financialSnapshot(), before);

  state.failRead = true;
  const failedRead = await flakyPatch({ action: 'complete_step', stepKey: 'expense' });
  assert.equal(failedRead.status, 500);
  assert.deepEqual((await stored(id)).steps, ['salary']);
  assert.deepEqual(await financialSnapshot(), before);

  const retried = await flakyPatch({ action: 'complete_step', stepKey: 'expense' });
  assert.equal(retried.status, 200);
  assert.deepEqual((await stored(id)).steps.sort(), ['expense', 'salary']);
  assert.deepEqual(await financialSnapshot(), before);
  const retriedAgain = await flakyPatch({ action: 'complete_step', stepKey: 'expense' });
  assert.equal(retriedAgain.status, 200);
  assert.deepEqual(await financialSnapshot(), before);
});

test('failed start leaves no duplicate journey and a retry reuses the created one', async () => {
  const real = modules.journeyRepository;
  let failSave = true;
  const journeys = {
    create: (...args) => real.create(...args),
    getById: (...args) => real.getById(...args),
    getResumable: (...args) => real.getResumable(...args),
    pause: (...args) => real.pause(...args),
    getOwnedChangeReceipt: (...args) => real.getOwnedChangeReceipt(...args),
    getLatestConfirmedChangeId: (...args) => real.getLatestConfirmedChangeId(...args),
    listPersonalLinkTripIds: (...args) => real.listPersonalLinkTripIds(...args),
    saveProgress: (...args) => {
      if (failSave) {
        failSave = false;
        throw new Error('simulated journey write failure');
      }
      return real.saveProgress(...args);
    },
  };
  await createSalary();
  const flakyApp = express();
  flakyApp.use(express.json());
  flakyApp.use(BASE, modules.createJourneysRouter({
    service: new modules.JourneyService({
      journeys,
      financial: modules.financialRepository,
      consent: modules.claritySettingsService,
    }),
  }));
  const failed = await authed(request(flakyApp).post(BASE)).send({ desiredOutcome: 'plan_month' });
  assert.equal(failed.status, 500);
  assert.equal(failed.body.error.retryScopeKey, 'journey:start');
  const retried = await authed(request(flakyApp).post(BASE)).send({ desiredOutcome: 'plan_month' });
  assert.equal(retried.status, 200);
  assert.equal(retried.body.journey.firstOutcome.available, true);
  const count = await db.prepare('SELECT COUNT(*) AS n FROM guided_journeys WHERE user_id = ?').get(owner.id);
  assert.equal(Number(count.n), 1);
  assert.deepEqual((await stored(retried.body.journey.id)).steps, ['salary']);
});

import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, test } from 'node:test';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createIsolatedTestDatabase } from '../helpers/testDatabase.js';
import { buildSessionFixture, buildUserFixture } from '../helpers/fixtures.js';

/**
 * Task 15.6. Drives the real journey, finance, trips, settings, and events routes
 * against an isolated database for all four desired outcomes, starting from empty
 * and from partially satisfied records. Records are created only through the real
 * mutation routes, and every step is advanced with the confirmed change id.
 */

const BASE = '/api/clarity/journeys';
/** First-value bound per outcome, from the design table "First-session Guided Journey". */
const SPEC_REQUIRED_STEPS = {
  plan_month: 1,
  control_spending: 2,
  fund_goal: 1,
  settle_trip: 3,
};
const FIRST_OUTCOME = {
  plan_month: { kind: 'monthly_plan', id: /^monthly-plan:\d{4}-\d{2}$/ },
  control_spending: { kind: 'spending', id: /^spending:\d{4}-\d{2}$/ },
  fund_goal: { kind: 'goal', id: /^goal:\d+$/ },
  settle_trip: { kind: 'trip', id: /^trip:\d+$/ },
};

const testDatabase = await createIsolatedTestDatabase();
const db = testDatabase.db;
process.env.FINANCIAL_MUTATION_HMAC_KEY = 'test-only-journey-all-outcomes-hmac-key-32-bytes';
const { createApp } = await import('../../src/app.js');
const { JOURNEY_DEFINITIONS } = await import('../../src/repositories/journeyRepository.js');
let app;
const OUTCOMES = Object.keys(JOURNEY_DEFINITIONS);

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

async function insertUser(user) {
  await db.prepare(
    `INSERT INTO users (id, email, name, password_hash, is_admin, token_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(user.id, user.email, user.name, user.password_hash, user.is_admin, user.token_version, user.created_at);
}

async function insertSession(session) {
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
  return `c1000000-0000-4000-8000-${String(keyCounter).padStart(12, '0')}`;
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

const currentMonth = () => localDate(0).slice(0, 7);

/* ----------------------- Records, created through the real routes ----------------------- */

async function createSalary(token = authorization) {
  const response = await canonical(request(app).post('/api/finance/salary'), token)
    .send({ amountMinor: 5_000_000, month: currentMonth(), expectedRecordVersion: 0 });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.mutation.changeId;
}

async function createExpense(token = authorization) {
  const response = await canonical(request(app).post('/api/finance/expenses'), token)
    .send({ amount: '125.50', category: 'Food', note: 'Lunch', spentOn: localDate(0), expectedRecordVersion: 0 });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.mutation.changeId;
}

async function createGoal(token = authorization) {
  const response = await canonical(request(app).post('/api/finance/goals'), token)
    .send({ name: 'Laptop', targetAmount: '1000.00', savedAmount: '250.00', targetDate: localDate(6, 15) });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.mutation.changeId;
}

async function createTrip(token = authorization) {
  const response = await authed(request(app).post('/api/trips'), token).send({ name: 'Goa', budget: 20000 });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.id;
}

async function addTripMember(tripId, token = authorization) {
  const response = await authed(request(app).post(`/api/trips/${tripId}/members`), token).send({ name: 'Ben' });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.mutation.changeId;
}

async function addTripSplit(tripId, token = authorization) {
  const ledger = await authed(request(app).get(`/api/trips/${tripId}`), token);
  const ownerName = ledger.body.members.find((member) => member.name !== 'Ben').name;
  const response = await authed(request(app).post(`/api/trips/${tripId}/expenses`), token).send({
    payer: ownerName,
    description: 'Hotel',
    amount: 6000,
    split: [{ name: ownerName, share: 1 }, { name: 'Ben', share: 1 }],
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.mutation.changeId;
}

/** Creates the record that satisfies one required step. Resolves to its confirmed change id, if the step has one. */
const CREATORS = {
  salary: () => createSalary(),
  expense: () => createExpense(),
  goal: () => createGoal(),
  trip: async (context) => {
    context.tripId = await createTrip();
    return undefined;
  },
  trip_members: (context) => addTripMember(context.tripId),
  trip_split: (context) => addTripSplit(context.tripId),
};

/* ------------------------------------- Journey calls ------------------------------------- */

const start = (desiredOutcome, token = authorization) => authed(request(app).post(BASE), token).send({ desiredOutcome });
const patch = (id, body, token = authorization) => authed(request(app).patch(`${BASE}/${id}`), token).send(body);
const active = async (token = authorization) => (await authed(request(app).get(`${BASE}/active`), token)).body.journey;

async function stored(journeyId) {
  const row = await db.prepare(
    'SELECT status, completed_step_keys FROM guided_journeys WHERE id = ?'
  ).get(journeyId);
  return { status: row.status, steps: JSON.parse(row.completed_step_keys) };
}

const TABLES = [
  'salary_entries',
  'expense_log',
  'emis',
  'savings_goals',
  'trips',
  'trip_members',
  'trip_expenses',
  'financial_record_changes',
];

/** Row counts for every record table the journeys read, so "no duplicate source record" is exact. */
async function recordCounts() {
  const counts = {};
  for (const table of TABLES) {
    counts[table] = Number((await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).n);
  }
  return counts;
}

const eventCount = async () => Number((await db.prepare('SELECT COUNT(*) AS n FROM product_measurement_events').get()).n);

beforeEach(async () => {
  await testDatabase.reset();
  // A new app per test gives each one its own request-rate window.
  app = createApp();
  owner = buildUserFixture({ id: 16_001, email: 'all-owner@example.test' });
  ownerSession = buildSessionFixture({ userId: owner.id, id: 16_101 });
  otherUser = buildUserFixture({ id: 16_002, email: 'all-other@example.test' });
  otherSession = buildSessionFixture({ userId: otherUser.id, id: 16_102 });
  freshUser = buildUserFixture({ id: 16_003, email: 'all-fresh@example.test' });
  freshSession = buildSessionFixture({ userId: freshUser.id, id: 16_103 });
  for (const [user, session] of [[owner, ownerSession], [otherUser, otherSession], [freshUser, freshSession]]) {
    await insertUser(user);
    await insertSession(session);
  }
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
  await testDatabase.cleanup();
});

/* ------------------------------------------ Scenarios ------------------------------------------ */

const SCENARIOS = OUTCOMES.flatMap((outcome) => {
  const required = JOURNEY_DEFINITIONS[outcome].requiredStepKeys;
  const scenarios = [];
  for (let saved = 0; saved <= required.length; saved += 1) {
    scenarios.push({
      label: saved === 0
        ? 'empty records'
        : saved === required.length
          ? 'every required record already saved'
          : `${saved} of ${required.length} required records already saved`,
      outcome,
      records: required.slice(0, saved),
    });
  }
  // A later record can exist without the earlier one, for example an expense without pay.
  if (outcome === 'control_spending') scenarios.push({ label: 'expense saved, pay missing', outcome, records: ['expense'] });
  return scenarios;
});

test('the journeys cover exactly the four outcomes, each within the first-value bound', () => {
  assert.deepEqual(OUTCOMES, ['plan_month', 'control_spending', 'fund_goal', 'settle_trip']);
  for (const outcome of OUTCOMES) {
    const { requiredStepKeys, optionalStepKeys } = JOURNEY_DEFINITIONS[outcome];
    assert.equal(requiredStepKeys.length, SPEC_REQUIRED_STEPS[outcome], outcome);
    assert.ok(requiredStepKeys.length <= 3);
    assert.ok(optionalStepKeys.length >= 1);
  }
});

for (const { label, outcome, records } of SCENARIOS) {
  test(`${outcome} from ${label}: steps advance only after confirmation, then optional skips are no-ops`, async () => {
    const { requiredStepKeys: required, optionalStepKeys: optional } = JOURNEY_DEFINITIONS[outcome];
    const context = {};
    for (const stepKey of records) await CREATORS[stepKey](context);
    const beforeStart = await recordCounts();

    const created = await start(outcome);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const { journey } = created.body;
    const id = journey.id;
    assert.deepEqual(journey.requiredStepKeys, required);
    assert.ok(journey.requiredStepKeys.length <= SPEC_REQUIRED_STEPS[outcome]);
    assert.equal(journey.progress.requiredTotal, SPEC_REQUIRED_STEPS[outcome]);
    assert.deepEqual(await recordCounts(), beforeStart, 'starting a journey writes no financial record');

    // Satisfied steps are skipped ahead and shown as satisfied; the rest are still to do.
    const satisfied = required.filter((stepKey) => records.includes(stepKey));
    const remaining = required.filter((stepKey) => !records.includes(stepKey));
    assert.deepEqual(journey.completedRequiredStepKeys, satisfied);
    assert.deepEqual(journey.remainingRequiredStepKeys, remaining);
    assert.equal(journey.nextIncompleteStepKey, remaining[0] ?? null);
    assert.equal(journey.firstOutcome.available, remaining.length === 0);
    assert.equal((await stored(id)).status, 'active');
    assert.deepEqual((await stored(id)).steps, satisfied);

    // Optional steps are not offered, or skippable, before the first outcome.
    if (remaining.length > 0) {
      assert.ok(journey.steps.filter((step) => !step.required).every((step) => step.offered === false));
      const early = await patch(id, { action: 'skip_step', stepKey: optional[0] });
      assert.equal(early.status, 409);
      assert.equal(early.body.error.code, 'FIRST_OUTCOME_PENDING');
      const earlyFinish = await patch(id, { action: 'complete' });
      assert.equal(earlyFinish.status, 409);
      assert.equal(earlyFinish.body.error.code, 'FIRST_OUTCOME_PENDING');
    }

    let completed = [...satisfied];
    for (const stepKey of remaining) {
      const current = await active();
      assert.equal(current.nextIncompleteStepKey, stepKey);
      assert.equal(current.currentStepKey, stepKey);
      assert.equal(current.progress.currentStepNumber, required.indexOf(stepKey) + 1);
      assert.equal(current.progress.requiredCompleted, completed.length);

      // Without a record there is nothing to confirm, and nothing moves.
      const counts = await recordCounts();
      const unconfirmed = await patch(id, { action: 'complete_step', stepKey });
      assert.equal(unconfirmed.status, 409, `${stepKey}: ${JSON.stringify(unconfirmed.body)}`);
      assert.equal(unconfirmed.body.error.code, 'STEP_NOT_CONFIRMED');
      assert.deepEqual((await stored(id)).steps, completed);
      assert.deepEqual(await recordCounts(), counts);

      // Saving the record through the real route does not advance the journey by itself.
      const changeId = await CREATORS[stepKey](context);
      assert.deepEqual((await stored(id)).steps, completed, `${stepKey}: saving alone does not complete the step`);
      const saved = await recordCounts();

      const confirmed = await patch(
        id,
        changeId === undefined
          ? { action: 'complete_step', stepKey }
          : { action: 'complete_step', stepKey, changeId },
      );
      assert.equal(confirmed.status, 200, `${stepKey}: ${JSON.stringify(confirmed.body)}`);
      completed = required.filter((item) => completed.includes(item) || item === stepKey);
      assert.deepEqual((await stored(id)).steps, completed);
      assert.equal(confirmed.body.journey.progress.requiredCompleted, completed.length);
      const isLast = completed.length === required.length;
      assert.equal(confirmed.body.journey.firstOutcome.available, isLast);
      if (changeId !== undefined) {
        assert.equal(confirmed.body.journey.steps.find((step) => step.key === stepKey).confirmedChangeId, changeId);
      }

      // A repeated confirmation changes nothing and creates no second record.
      const replay = await patch(
        id,
        changeId === undefined
          ? { action: 'complete_step', stepKey }
          : { action: 'complete_step', stepKey, changeId },
      );
      assert.equal(replay.status, 200);
      assert.deepEqual((await stored(id)).steps, completed);
      assert.deepEqual(await recordCounts(), saved);
    }

    // The first outcome exists, from the confirmed records only.
    const ready = await active();
    assert.equal(ready.firstOutcome.available, true);
    assert.equal(ready.firstOutcome.kind, FIRST_OUTCOME[outcome].kind);
    assert.match(ready.firstOutcome.outcomeId, FIRST_OUTCOME[outcome].id);
    assert.equal(ready.progress.requiredRemaining, 0);
    assert.equal(ready.nextChoice.stepKey, optional[0]);
    assert.equal(ready.nextChoice.skippable, true);
    if (outcome === 'settle_trip') {
      const salary = await db.prepare('SELECT COUNT(*) AS n FROM salary_entries').get();
      assert.equal(Number(salary.n), 0, 'a trip settles without salary');
    }

    // Skipping each optional step writes nothing and leaves every confirmed value as it was.
    for (const stepKey of optional) {
      const counts = await recordCounts();
      const skipped = await patch(id, { action: 'skip_step', stepKey });
      assert.equal(skipped.status, 200, `${stepKey}: ${JSON.stringify(skipped.body)}`);
      assert.equal(skipped.body.journey.steps.find((step) => step.key === stepKey).status, 'skipped');
      assert.equal(skipped.body.journey.firstOutcome.available, true);
      assert.deepEqual(await recordCounts(), counts);
    }
    assert.equal((await active()).nextChoice, null);
    assert.deepEqual((await stored(id)).steps, [...required, ...optional]);

    // Analytics is off by default, so even valid event posts store nothing.
    for (const body of [
      { event: 'journey_started', journeyId: id, desiredOutcome: outcome, occurredAt: new Date().toISOString() },
      { event: 'first_outcome_displayed', journeyId: id, outcomeKind: FIRST_OUTCOME[outcome].kind, occurredAt: new Date().toISOString() },
    ]) {
      const response = await authed(request(app).post('/api/clarity/events')).send(body);
      assert.equal(response.status, 204);
    }
    assert.equal(await eventCount(), 0);

    const finished = await patch(id, { action: 'complete' });
    assert.equal(finished.status, 200);
    assert.equal(finished.body.journey.status, 'completed');
    assert.equal(await active(), null);
    assert.equal(await eventCount(), 0);
  });
}

test('a record deleted while the journey is paused reopens its step on resume', async () => {
  const created = await start('control_spending');
  const id = created.body.journey.id;
  const salaryChange = await createSalary();
  await patch(id, { action: 'complete_step', stepKey: 'salary', changeId: salaryChange });
  const expense = await canonical(request(app).post('/api/finance/expenses'))
    .send({ amount: '10.00', category: 'Food', note: '', spentOn: localDate(0), expectedRecordVersion: 0 });
  assert.equal(expense.status, 200, JSON.stringify(expense.body));
  const ready = await patch(id, { action: 'complete_step', stepKey: 'expense', changeId: expense.body.mutation.changeId });
  assert.equal(ready.body.journey.firstOutcome.available, true);
  assert.equal((await patch(id, { action: 'pause' })).body.journey.status, 'paused');

  const removed = await canonical(request(app).delete(`/api/finance/expenses/${expense.body.mutation.recordId}`))
    .send({ expectedRecordVersion: expense.body.mutation.recordVersion });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  const resumed = await patch(id, { action: 'resume' });
  assert.equal(resumed.status, 200);
  assert.deepEqual(resumed.body.journey.completedRequiredStepKeys, ['salary']);
  assert.equal(resumed.body.journey.nextIncompleteStepKey, 'expense');
  assert.equal(resumed.body.journey.currentStepKey, 'expense');
  assert.equal(resumed.body.journey.firstOutcome.available, false);
  assert.equal(resumed.body.journey.progress.currentStepNumber, 2);
  assert.ok(resumed.body.journey.steps.filter((step) => !step.required).every((step) => step.offered === false));
});

test('the data-use notice gates starting a journey and saving records, and reading stays available', async () => {
  const startBlocked = await start('plan_month', freshAuthorization);
  assert.equal(startBlocked.status, 428);
  assert.equal(startBlocked.body.error.code, 'DATA_NOTICE_REQUIRED');
  const saveBlocked = await canonical(request(app).post('/api/finance/salary'), freshAuthorization)
    .send({ amountMinor: 5_000_000, month: currentMonth(), expectedRecordVersion: 0 });
  assert.equal(saveBlocked.status, 428);
  assert.equal(saveBlocked.body.error.code, 'DATA_NOTICE_REQUIRED');
  assert.equal(await active(freshAuthorization), null);
  const counts = await recordCounts();
  assert.equal(counts.salary_entries, 0);
  assert.equal(Number((await db.prepare('SELECT COUNT(*) AS n FROM guided_journeys').get()).n), 0);

  const acknowledged = await authed(request(app).patch('/api/clarity/settings'), freshAuthorization)
    .send({ acknowledgedNoticeVersion: 1 });
  assert.equal(acknowledged.status, 200, JSON.stringify(acknowledged.body));
  const created = await start('plan_month', freshAuthorization);
  assert.equal(created.status, 201);
  const changeId = await createSalary(freshAuthorization);
  const advanced = await patch(created.body.journey.id, { action: 'complete_step', stepKey: 'salary', changeId }, freshAuthorization);
  assert.equal(advanced.status, 200);
  assert.equal(advanced.body.journey.firstOutcome.available, true);
});

test('another user\'s journey and change receipts answer exactly like missing ones', async () => {
  const bodies = [
    { action: 'pause' },
    { action: 'resume' },
    { action: 'complete' },
    { action: 'skip_step', stepKey: 'bills' },
    { action: 'complete_step', stepKey: 'salary' },
    { action: 'complete_step', stepKey: 'salary', changeId: 1 },
  ];
  for (const outcome of OUTCOMES) {
    const created = await start(outcome);
    assert.equal(created.status, 201);
    const id = created.body.journey.id;
    const before = await stored(id);
    for (const body of bodies) {
      const foreign = await patch(id, body, otherAuthorization);
      const missing = await patch(9_999_000 + id, body, otherAuthorization);
      assert.equal(foreign.status, 404, `${outcome} ${JSON.stringify(body)}`);
      assert.deepEqual(foreign.body, missing.body, `${outcome} ${JSON.stringify(body)} must not reveal that the journey exists`);
    }
    assert.deepEqual(await stored(id), before);
    assert.equal(await active(otherAuthorization), null);
    const done = await patch(id, { action: 'pause' });
    assert.equal(done.status, 200);
    await db.prepare("UPDATE guided_journeys SET status = 'abandoned' WHERE id = ?").run(id);
  }

  // A change receipt that belongs to another user looks the same as one that does not exist.
  const created = await start('plan_month');
  const otherChange = await createSalary(otherAuthorization);
  const foreignChange = await patch(created.body.journey.id, { action: 'complete_step', stepKey: 'salary', changeId: otherChange });
  const missingChange = await patch(created.body.journey.id, { action: 'complete_step', stepKey: 'salary', changeId: 9_999_999 });
  assert.equal(foreignChange.status, 404);
  assert.deepEqual(foreignChange.body, missingChange.body);
  assert.deepEqual((await stored(created.body.journey.id)).steps, []);
});

test('with analytics on, only the starting session records the start and first-outcome events, once', async () => {
  const enabled = await authed(request(app).patch('/api/clarity/settings'))
    .send({ acknowledgedNoticeVersion: 1, analyticsEnabled: true });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
  const secondSession = buildSessionFixture({ userId: owner.id, id: 16_201 });
  await insertSession(secondSession);
  const secondAuthorization = tokenFor(owner, secondSession);

  const created = await start('plan_month');
  const id = created.body.journey.id;
  const changeId = await createSalary();
  await patch(id, { action: 'complete_step', stepKey: 'salary', changeId });
  const send = (body, token = authorization) => authed(request(app).post('/api/clarity/events'), token)
    .send({ occurredAt: new Date().toISOString(), ...body });

  assert.equal((await send({ event: 'first_outcome_displayed', journeyId: id, outcomeKind: 'monthly_plan' }, secondAuthorization)).status, 204);
  assert.equal(await eventCount(), 0, 'a different session does not record the first outcome');

  assert.equal((await send({ event: 'journey_started', journeyId: id, desiredOutcome: 'plan_month' })).status, 204);
  assert.equal((await send({ event: 'first_outcome_displayed', journeyId: id, outcomeKind: 'monthly_plan' })).status, 204);
  assert.equal((await send({ event: 'first_outcome_displayed', journeyId: id, outcomeKind: 'monthly_plan' })).status, 204);
  assert.equal(await eventCount(), 2);
  const rows = await db.prepare(
    'SELECT event_name, journey_id, outcome_kind, desired_outcome FROM product_measurement_events ORDER BY id'
  ).all();
  assert.deepEqual(rows.map((row) => row.event_name), ['journey_started', 'first_outcome_displayed']);
  assert.ok(rows.every((row) => Number(row.journey_id) === id));
  assert.equal(rows[1].outcome_kind, 'monthly_plan');

  // Turning analytics off stops recording at once, and the journey is unaffected.
  const disabled = await authed(request(app).patch('/api/clarity/settings')).send({ analyticsEnabled: false });
  assert.equal(disabled.status, 200);
  assert.equal((await send({ event: 'clarity_response', journeyId: id, response: 'yes' })).status, 204);
  assert.equal(await eventCount(), 2);
  assert.equal((await patch(id, { action: 'complete' })).status, 200);
});

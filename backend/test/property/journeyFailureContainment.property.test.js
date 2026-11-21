import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import express from 'express';
import fc from 'fast-check';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createIsolatedTestDatabase } from '../helpers/testDatabase.js';
import { buildSessionFixture, buildUserFixture } from '../helpers/fixtures.js';

/**
 * Property 20: Failed journey operations preserve confirmed progress.
 *
 * Validates: Requirements 1.13, 3.12, 3.13, 3.14, 3.15, 3.16
 *
 * Each generated case resets the isolated database once, creates an owner and
 * a foreign user, then drives the real HTTP stack with a sequence of journey
 * commands, record writes, invalid commands and cross-user commands. A
 * reference model written from the design table (not from the planner or the
 * service) predicts every response and every stored journey. Failures are
 * injected three ways:
 *   - write-all:    SQLite triggers abort INSERT and UPDATE on guided_journeys;
 *   - write-update: a trigger aborts UPDATE only (the start-then-persist gap);
 *   - read:         an injected financial repository throws before any write.
 * After every failed operation the test compares byte-for-byte snapshots of
 * the journey rows, financial rows, data_version and receipts, retries with
 * the failure removed, and replays the retry to prove it applied exactly once.
 */

const BASE = '/api/clarity/journeys';
const RUNS = 120;
const MIN_CASES = 100;
const OWNER_ID_BASE = 40_000;
const SESSION_ID_OFFSET = 500_000;
const MISSING_CHANGE_ID = 900_000_000;
const MISSING_JOURNEY_ID = 2_000_000_000;

// ---------------------------------------------------------------------------
// Reference tables, written from the design (not imported from the planner)
// ---------------------------------------------------------------------------

const SPEC = Object.freeze({
  plan_month: { required: ['salary'], optional: ['bills'] },
  control_spending: { required: ['salary', 'expense'], optional: ['bills', 'category_treatment'] },
  fund_goal: { required: ['goal'], optional: ['monthly_plan'] },
  settle_trip: { required: ['trip', 'trip_members', 'trip_split'], optional: ['personal_expense'] },
});
const OUTCOMES = Object.keys(SPEC);
const STEP_KEYS = [
  'salary', 'expense', 'goal', 'trip', 'trip_members', 'trip_split',
  'bills', 'category_treatment', 'monthly_plan', 'personal_expense',
];
const STEP_RECORD_TYPES = {
  salary: ['salary'],
  expense: ['expense'],
  goal: ['goal'],
  trip: [],
  trip_members: ['trip_member'],
  trip_split: ['trip_expense'],
  bills: ['bill'],
  category_treatment: ['category_treatment'],
  monthly_plan: ['salary', 'bill'],
  personal_expense: ['trip_personal_link'],
};
const RECORD_CAPS = { salary: 1, expense: 2, goal: 1, bills: 1, trip: 3 };

const INVALID_PATCH_BODIES = [
  { body: {}, code: 'INVALID_JOURNEY_ACTION', field: 'action' },
  { body: { action: 'delete' }, code: 'INVALID_JOURNEY_ACTION', field: 'action' },
  { body: { action: 7 }, code: 'INVALID_JOURNEY_ACTION', field: 'action' },
  { body: { action: 'pause', stepKey: 'salary' }, code: 'UNKNOWN_JOURNEY_FIELD', field: 'stepKey' },
  { body: { action: 'complete_step' }, code: 'INVALID_STEP_KEY', field: 'stepKey' },
  { body: { action: 'complete_step', stepKey: 'crypto' }, code: 'INVALID_STEP_KEY', field: 'stepKey' },
  { body: { action: 'skip_step', stepKey: 'bills', note: 'x' }, code: 'UNKNOWN_JOURNEY_FIELD', field: 'note' },
  { body: { action: 'complete_step', stepKey: 'salary', changeId: -1 }, code: 'INVALID_CHANGE_ID', field: 'changeId' },
  { body: { action: 'complete_step', stepKey: 'salary', changeId: 'abc' }, code: 'INVALID_CHANGE_ID', field: 'changeId' },
  { body: { action: 'complete_step', stepKey: 'salary', amount: 5000 }, code: 'UNKNOWN_JOURNEY_FIELD', field: 'amount' },
  { body: [], code: 'INVALID_JOURNEY_BODY', field: undefined },
];
const INVALID_START_BODIES = [
  { body: {}, code: 'INVALID_DESIRED_OUTCOME', field: 'desiredOutcome' },
  { body: { desiredOutcome: 'invest' }, code: 'INVALID_DESIRED_OUTCOME', field: 'desiredOutcome' },
  { body: { desiredOutcome: 7 }, code: 'INVALID_DESIRED_OUTCOME', field: 'desiredOutcome' },
  { body: { desiredOutcome: 'plan_month', steps: ['salary'] }, code: 'UNKNOWN_JOURNEY_FIELD', field: 'steps' },
  { body: [], code: 'INVALID_JOURNEY_BODY', field: undefined },
];

const FINANCIAL_TABLES = [
  'salary_entries',
  'expense_log',
  'emis',
  'savings_goals',
  'category_budgets',
  'recurring_expenses',
  'expense_category_treatments',
  'trips',
  'trip_members',
  'trip_invites',
  'trip_expenses',
  'trip_expense_personal_links',
  'financial_record_changes',
  'user_financial_state',
  'product_measurement_events',
];

const INTERNAL_DETAIL_PATTERN =
  /simulated|SQLITE|libsql|RAISE|node_modules|\.js\b|\bat\s+\S+\s+\(|stack|\bSELECT\b|\bINSERT\b|\bUPDATE\b|\/Users\//i;

// ---------------------------------------------------------------------------
// Harness state
// ---------------------------------------------------------------------------

let testDatabase;
let db;
let app;
let flakyApp;
let originalConsoleError;
let caseCounter = 0;
let keyCounter = 0;
const flaky = { armed: false, fired: 0 };
const stats = {
  cases: 0,
  operations: 0,
  writeFailures: 0,
  readFailures: 0,
  partialStarts: 0,
  unconfirmed: 0,
  validation: 0,
  foreign: 0,
  retries: 0,
  fixedRetries: 0,
  recordWrites: 0,
  successes: 0,
  suppressedLogs: 0,
};

function nextKey() {
  keyCounter += 1;
  return `c2000000-0000-4000-8000-${String(keyCounter).padStart(12, '0')}`;
}

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
  await db.prepare(
    `INSERT INTO user_financial_state
      (user_id, data_use_notice_version, data_use_acknowledged_at)
     VALUES (?, 1, CURRENT_TIMESTAMP)`
  ).run(user.id);
}

function kolkataToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day) };
}

function currentMonth() {
  const { year, month } = kolkataToday();
  return `${year}-${String(month).padStart(2, '0')}`;
}

function todayDate() {
  const { year, month, day } = kolkataToday();
  return `${year}-${String(month).padStart(2, '0')}-${String(Math.min(day, 28)).padStart(2, '0')}`;
}

function futureDate() {
  const { year, month } = kolkataToday();
  const index = year * 12 + (month - 1) + 6;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}-15`;
}

// ---------------------------------------------------------------------------
// Snapshots (byte-for-byte comparisons)
// ---------------------------------------------------------------------------

function plainRows(rows) {
  return rows.map((row) => JSON.parse(JSON.stringify(row)));
}

async function journeyRows() {
  return plainRows(await db.prepare('SELECT * FROM guided_journeys ORDER BY id').all());
}

async function financialSnapshot() {
  const results = await Promise.all(
    FINANCIAL_TABLES.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
  );
  return Object.fromEntries(FINANCIAL_TABLES.map((table, index) => [table, plainRows(results[index])]));
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

// ---------------------------------------------------------------------------
// Failure injection
// ---------------------------------------------------------------------------

async function armTriggers({ insert, update }) {
  if (insert) {
    await db.prepare(
      `CREATE TRIGGER jfc_fail_insert BEFORE INSERT ON guided_journeys
       BEGIN SELECT RAISE(ABORT, 'simulated journey insert failure'); END`
    ).run();
  }
  if (update) {
    await db.prepare(
      `CREATE TRIGGER jfc_fail_update BEFORE UPDATE ON guided_journeys
       BEGIN SELECT RAISE(ABORT, 'simulated journey write failure'); END`
    ).run();
  }
}

async function disarmTriggers() {
  await db.prepare('DROP TRIGGER IF EXISTS jfc_fail_insert').run();
  await db.prepare('DROP TRIGGER IF EXISTS jfc_fail_update').run();
}

// ---------------------------------------------------------------------------
// Reference model
// ---------------------------------------------------------------------------

function allowedKeys(outcome) {
  return [...SPEC[outcome].required, ...SPEC[outcome].optional];
}

function canonical(outcome, keys) {
  const set = new Set(keys);
  return allowedKeys(outcome).filter((key) => set.has(key));
}

/** Steps current confirmed records satisfy, from raw record counts. */
function satisfiedSet(records) {
  const satisfied = new Set();
  if (records.salary) {
    satisfied.add('salary');
    satisfied.add('monthly_plan');
  }
  if (records.bills > 0) satisfied.add('bills');
  if (records.expenses > 0) satisfied.add('expense');
  if (records.goal) satisfied.add('goal');
  if (records.trip >= 1) satisfied.add('trip');
  if (records.trip >= 2) satisfied.add('trip_members');
  if (records.trip >= 3) satisfied.add('trip_split');
  return satisfied;
}

function unionSteps(journey, records, extra = []) {
  const satisfied = satisfiedSet(records);
  return canonical(journey.outcome, [
    ...journey.steps,
    ...allowedKeys(journey.outcome).filter((key) => satisfied.has(key)),
    ...extra,
  ]);
}

function viewFacts(model, outcome) {
  const satisfied = satisfiedSet(model.records);
  const remaining = SPEC[outcome].required.filter((key) => !satisfied.has(key));
  return { remaining, first: remaining.length === 0, satisfied };
}

function sameSteps(left, right) {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

function openJourney(model) {
  return [...model.journeys].reverse().find((entry) => (
    entry.status === 'active' || entry.status === 'paused'
  )) ?? null;
}

function clientError(status, code, extra = {}) {
  return {
    status,
    code,
    inserts: false,
    updates: false,
    planFirst: false,
    next: null,
    ...extra,
  };
}

function expectStart(model, outcome) {
  const open = openJourney(model);
  const facts = viewFacts(model, outcome);
  if (open) {
    if (open.outcome !== outcome) {
      return {
        ...clientError(409, 'JOURNEY_ALREADY_ACTIVE'),
        scope: 'journey:start',
        journey: null,
      };
    }
    const steps = unionSteps(open, model.records);
    return {
      status: 200,
      created: false,
      journey: open,
      scope: 'journey:start',
      inserts: false,
      updates: open.status !== 'active' || !sameSteps(steps, open.steps),
      planFirst: true,
      next: { status: 'active', steps },
      view: { status: 'active', remaining: facts.remaining, first: facts.first },
    };
  }
  const steps = canonical(outcome, [...facts.satisfied].filter((key) => allowedKeys(outcome).includes(key)));
  return {
    status: 201,
    created: true,
    journey: null,
    scope: 'journey:start',
    inserts: true,
    updates: steps.length > 0,
    planFirst: false,
    next: { status: 'active', steps },
    view: { status: 'active', remaining: facts.remaining, first: facts.first },
  };
}

/** Predict a valid-shaped PATCH against one owned journey, in service order. */
function expectTransition(model, journey, body) {
  const facts = viewFacts(model, journey.outcome);
  const { required } = SPEC[journey.outcome];
  const target = typeof body.stepKey === 'string' ? body.stepKey : body.action;
  const scope = `journey:${journey.id}:${target}`;
  const reject = (status, code, extra = {}) => clientError(status, code, { scope, journey, ...extra });
  const done = (status, steps, extra = {}) => ({
    status: 200,
    scope,
    journey,
    inserts: false,
    updates: status !== journey.status || !sameSteps(steps, journey.steps),
    planFirst: true,
    next: { status, steps },
    view: { status, remaining: facts.remaining, first: facts.first },
    ...extra,
  });
  const stepAction = body.action === 'complete_step' || body.action === 'skip_step';
  const requireOpen = () => (journey.status === 'completed'
    ? reject(409, 'JOURNEY_NOT_ACTIVE')
    : null);
  const requireActive = () => requireOpen()
    ?? (journey.status === 'paused' ? reject(409, 'JOURNEY_PAUSED') : null);
  const requireBelongs = () => (!allowedKeys(journey.outcome).includes(body.stepKey)
    ? reject(400, 'INVALID_STEP_KEY', { field: 'stepKey' })
    : null);

  if (stepAction && !STEP_KEYS.includes(body.stepKey)) {
    return reject(400, 'INVALID_STEP_KEY', { field: 'stepKey' });
  }

  switch (body.action) {
    case 'complete_step': {
      const early = requireActive() ?? requireBelongs();
      if (early) return early;
      if (body.changeId !== undefined) {
        const type = model.receipts.get(body.changeId);
        if (type === undefined) return reject(404, 'CHANGE_NOT_FOUND', { field: 'changeId' });
        if (!STEP_RECORD_TYPES[body.stepKey].includes(type)) {
          return reject(422, 'CHANGE_STEP_MISMATCH', { field: 'changeId' });
        }
      }
      if (!facts.satisfied.has(body.stepKey)) {
        return reject(409, 'STEP_NOT_CONFIRMED', {
          planFirst: true,
          errView: true,
          stepKey: body.stepKey,
        });
      }
      return done(journey.status, unionSteps(journey, model.records));
    }
    case 'skip_step': {
      const early = requireActive() ?? requireBelongs();
      if (early) return early;
      if (required.includes(body.stepKey)) {
        return reject(422, 'STEP_NOT_OPTIONAL', { field: 'stepKey' });
      }
      const pending = !facts.satisfied.has(body.stepKey) && !journey.steps.includes(body.stepKey);
      if (pending && !facts.first) {
        return reject(409, 'FIRST_OUTCOME_PENDING', { planFirst: true });
      }
      return done(journey.status, unionSteps(journey, model.records, pending ? [body.stepKey] : []));
    }
    case 'pause': {
      const early = requireOpen();
      if (early) return early;
      return journey.status === 'paused'
        ? done('paused', journey.steps)
        : done('paused', journey.steps, { planFirst: false });
    }
    case 'resume': {
      const early = requireOpen();
      if (early) return early;
      return done('active', unionSteps(journey, model.records));
    }
    default: {
      if (journey.status === 'completed') return done('completed', journey.steps);
      if (journey.status === 'paused') return reject(409, 'JOURNEY_PAUSED', { planFirst: true });
      if (!facts.first) {
        return reject(409, 'FIRST_OUTCOME_PENDING', {
          planFirst: true,
          errView: true,
          scope: `journey:${journey.id}:${facts.remaining[0] ?? 'complete'}`,
        });
      }
      return done('completed', unionSteps(journey, model.records));
    }
  }
}

function effectiveFailure(requested, exp) {
  if (requested === 'read') return exp.planFirst ? 'read' : 'none';
  if (requested === 'write-all') {
    return exp.status < 400 && (exp.inserts || exp.updates) ? 'write-all' : 'none';
  }
  if (requested === 'write-update') {
    return exp.status < 400 && exp.updates ? 'write-update' : 'none';
  }
  return 'none';
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function stamp(builder, ctx, token = ctx.ownerToken) {
  return builder.set('Authorization', token).set('X-Forwarded-For', ctx.ip);
}

function financeRequest(ctx, path, body, key, token = ctx.ownerToken) {
  return stamp(request(app).post(path), ctx, token)
    .set('X-Clarity-Contract', '1')
    .set('Idempotency-Key', key)
    .send(body);
}

async function sendJourney(ctx, req, failure) {
  const target = failure === 'read' ? flakyApp : app;
  if (failure === 'write-all') await armTriggers({ insert: true, update: true });
  if (failure === 'write-update') await armTriggers({ insert: false, update: true });
  if (failure === 'read') {
    flaky.armed = true;
    flaky.fired = 0;
  }
  try {
    const builder = req.method === 'post'
      ? request(target).post(BASE)
      : request(target).patch(`${BASE}/${req.journeyId}`);
    return await stamp(builder, ctx).send(req.body);
  } finally {
    flaky.armed = false;
    if (failure === 'write-all' || failure === 'write-update') await disarmTriggers();
  }
}

// ---------------------------------------------------------------------------
// Record creation (real finance routes for receipts, SQL for the rest)
// ---------------------------------------------------------------------------

const FINANCE_ROUTES = {
  salary: { path: '/api/finance/salary', table: 'salary_entries', type: 'salary' },
  expense: { path: '/api/finance/expenses', table: 'expense_log', type: 'expense' },
  goal: { path: '/api/finance/goals', table: 'savings_goals', type: 'goal' },
};

function financeBody(kind) {
  switch (kind) {
    case 'salary':
      return { amountMinor: 5_000_000, month: currentMonth(), expectedRecordVersion: 0 };
    case 'expense':
      return {
        amount: '125.50',
        category: 'Food',
        note: 'Lunch',
        spentOn: todayDate(),
        expectedRecordVersion: 0,
      };
    default:
      return { name: 'Laptop', targetAmount: '1000.00', savedAmount: '250.00', targetDate: futureDate() };
  }
}

function recordCount(model, kind) {
  switch (kind) {
    case 'salary': return model.records.salary ? 1 : 0;
    case 'expense': return model.records.expenses;
    case 'goal': return model.records.goal ? 1 : 0;
    case 'bills': return model.records.bills;
    default: return model.records.trip;
  }
}

/**
 * Create one record. Finance-route records also get a receipt, a replayed
 * request with the same key must return the same receipt and write nothing.
 */
async function createRecord(ctx, model, kind) {
  if (recordCount(model, kind) >= RECORD_CAPS[kind]) return null;
  stats.recordWrites += 1;
  const route = FINANCE_ROUTES[kind];
  if (route) {
    const body = financeBody(kind);
    const key = nextKey();
    const before = await financialSnapshot();
    const response = await financeRequest(ctx, route.path, body, key);
    assert.equal(response.status, 200, `create ${kind}: ${JSON.stringify(response.body)}`);
    const changeId = response.body.mutation.changeId;
    const afterCreate = await financialSnapshot();
    assert.equal(afterCreate[route.table].length, before[route.table].length + 1, `${kind} rows`);
    assert.equal(
      afterCreate.financial_record_changes.length,
      before.financial_record_changes.length + 1,
      `${kind} receipts`
    );
    const receipt = afterCreate.financial_record_changes.find((row) => row.id === changeId);
    assert.equal(receipt.record_type, route.type);
    assert.equal(receipt.status, 'confirmed');

    const replay = await financeRequest(ctx, route.path, body, key);
    assert.equal(replay.status, 200, `replay ${kind}: ${JSON.stringify(replay.body)}`);
    assert.equal(replay.body.mutation.changeId, changeId);
    assert.ok(same(await financialSnapshot(), afterCreate), `${kind} replay created a duplicate`);

    if (kind === 'salary') model.records.salary = true;
    else if (kind === 'expense') model.records.expenses += 1;
    else model.records.goal = true;
    model.receipts.set(changeId, route.type);
    return changeId;
  }

  if (kind === 'bills') {
    await db.prepare(
      'INSERT INTO emis (user_id, label, amount, category, active) VALUES (?, ?, ?, ?, 1)'
    ).run(ctx.ownerId, 'Rent', 1_000, 'Rent');
    model.records.bills += 1;
    return null;
  }

  if (model.records.trip === 0) {
    const trip = await db.prepare('INSERT INTO trips (user_id, name, budget) VALUES (?, ?, ?) RETURNING id')
      .get(ctx.ownerId, 'Goa', 20_000);
    model.tripId = Number(trip.id);
    await db.prepare('INSERT INTO trip_members (trip_id, user_id, name) VALUES (?, ?, ?)')
      .run(model.tripId, ctx.ownerId, 'Asha');
  } else if (model.records.trip === 1) {
    await db.prepare('INSERT INTO trip_members (trip_id, name) VALUES (?, ?)').run(model.tripId, 'Ben');
  } else {
    await db.prepare(
      'INSERT INTO trip_expenses (trip_id, payer, description, amount, split_json) VALUES (?, ?, ?, ?, ?)'
    ).run(
      model.tripId,
      'Asha',
      'Hotel',
      6_000,
      JSON.stringify([{ name: 'Asha', share: 1 }, { name: 'Ben', share: 1 }])
    );
  }
  model.records.trip += 1;
  return null;
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

function assertNoInternalDetail(body, label) {
  const text = JSON.stringify(body);
  assert.doesNotMatch(text, INTERNAL_DETAIL_PATTERN, `${label}: internal detail leaked: ${text}`);
}

function assertView(view, expected, label) {
  assert.equal(view.status, expected.status, `${label}: view status`);
  assert.deepEqual(view.remainingRequiredStepKeys, expected.remaining, `${label}: remaining`);
  assert.equal(view.firstOutcome.available, expected.first, `${label}: first outcome`);
}

function assertResponse(response, exp, label, { failed = false, scope500 } = {}) {
  assert.equal(response.status, exp.status, `${label}: status ${JSON.stringify(response.body)}`);
  if (response.status >= 400) {
    assertNoInternalDetail(response.body, label);
    const { error } = response.body;
    assert.equal(error.code, exp.code, `${label}: code`);
    if (exp.code === 'JOURNEY_OPERATION_FAILED') {
      assert.deepEqual(Object.keys(response.body), ['error'], `${label}: 500 envelope`);
      // Task 17.1: when the app assigns request IDs, the envelope also carries
      // the response's own server-generated ID as its correlation ID.
      const { correlationId, ...contractFields } = error;
      assert.deepEqual(
        Object.keys(contractFields).sort(),
        ['code', 'message', 'retryScopeKey', 'retryable'],
        `${label}: 500 fields`
      );
      if (correlationId !== undefined) {
        assert.equal(correlationId, response.headers['x-request-id'], `${label}: correlation id`);
      }
      assert.equal(error.retryable, true, `${label}: retryable`);
      assert.equal(error.retryScopeKey, scope500, `${label}: scoped retry key`);
      return;
    }
    if (exp.field !== undefined) assert.equal(error.field, exp.field, `${label}: field`);
    if (exp.code === 'STEP_NOT_CONFIRMED' || exp.errView) {
      assert.equal(error.retryScopeKey, exp.scope, `${label}: retry scope`);
    }
    if (exp.code === 'STEP_NOT_CONFIRMED') {
      assert.equal(error.stepKey, exp.stepKey, `${label}: names only the unconfirmed step`);
    }
    if (exp.errView) {
      const facts = viewFacts(modelForView, exp.journey.outcome);
      assert.deepEqual(
        response.body.journey.remainingRequiredStepKeys,
        facts.remaining,
        `${label}: error journey remaining`
      );
      assert.equal(response.body.journey.status, exp.journey.status, `${label}: error journey status`);
    } else {
      assert.equal(response.body.journey, undefined, `${label}: no journey body`);
    }
    return;
  }
  assert.equal(failed, false);
  assertView(response.body.journey, exp.view, label);
}

// The error view check needs the model that produced `exp`.
let modelForView = null;

function ownerRows(rows, ctx) {
  return rows.filter((row) => row.user_id === ctx.ownerId);
}

function otherRows(rows, ctx) {
  return rows.filter((row) => row.user_id !== ctx.ownerId);
}

async function assertDatabaseMatchesModel(model, ctx, label) {
  const rows = ownerRows(await journeyRows(), ctx);
  assert.equal(rows.length, model.journeys.length, `${label}: owner journey count`);
  model.journeys.forEach((journey) => {
    const row = rows.find((entry) => entry.id === journey.id);
    assert.ok(row, `${label}: journey ${journey.id} missing`);
    assert.equal(row.status, journey.status, `${label}: stored status`);
    assert.deepEqual(JSON.parse(row.completed_step_keys), journey.steps, `${label}: stored steps`);
    assert.equal(row.desired_outcome, journey.outcome);
  });
}

// ---------------------------------------------------------------------------
// One journey request: expectation, optional failure, retry, replay
// ---------------------------------------------------------------------------

function applySuccess(model, req, exp, response) {
  if (exp.created) {
    const id = response.body.journey.id;
    assert.ok(model.journeys.every((entry) => entry.id < id), 'new journey id is fresh');
    model.journeys.push({ id, outcome: req.outcome, status: 'active', steps: exp.next.steps });
  } else if (exp.next && exp.journey) {
    exp.journey.status = exp.next.status;
    exp.journey.steps = exp.next.steps;
  }
}

async function runJourneyRequest(ctx, model, req, requestedFailure, label) {
  const exp = req.expect(model);
  const failure = effectiveFailure(requestedFailure, exp);
  const armed = requestedFailure === 'read' ? failure : requestedFailure;
  const armedFailure = armed === 'read' && failure !== 'read' ? 'none' : armed;

  const beforeJourneys = await journeyRows();
  const beforeFinancial = await financialSnapshot();
  modelForView = model;
  const response = await sendJourney(ctx, req, armedFailure);
  stats.operations += 1;

  const afterJourneys = await journeyRows();
  const afterFinancial = await financialSnapshot();

  // Journey operations never write financial state, whatever the outcome.
  assert.ok(same(afterFinancial, beforeFinancial), `${label}: financial rows, data_version or receipts changed`);
  // Foreign users' journeys are never touched.
  assert.ok(same(otherRows(afterJourneys, ctx), otherRows(beforeJourneys, ctx)), `${label}: foreign journey changed`);

  if (failure === 'none') {
    assertResponse(response, exp, label);
    if (response.status >= 400) {
      stats.validation += 1;
      assert.ok(same(afterJourneys, beforeJourneys), `${label}: rejected command changed a journey row`);
      if (exp.code === 'STEP_NOT_CONFIRMED') stats.unconfirmed += 1;
    } else {
      stats.successes += 1;
      applySuccess(model, req, exp, response);
      const prior = exp.journey;
      if (prior && !exp.created) {
        const before = beforeJourneys.find((row) => row.id === prior.id);
        for (const key of JSON.parse(before.completed_step_keys)) {
          assert.ok(exp.next.steps.includes(key), `${label}: prior progress lost: ${key}`);
        }
      }
    }
    await assertDatabaseMatchesModel(model, ctx, label);
    return { response, exp, failed: false };
  }

  // Injected failure: the failed operation must be contained.
  const scope500 = req.scope500(exp);
  assertResponse(response, { status: 500, code: 'JOURNEY_OPERATION_FAILED' }, label, { scope500 });
  if (failure === 'read') {
    assert.equal(flaky.fired, 1, `${label}: injected read failure fired once`);
    stats.readFailures += 1;
  } else {
    stats.writeFailures += 1;
  }

  const partialStart = failure === 'write-update' && exp.inserts && exp.updates;
  if (partialStart) {
    // The documented start gap: the row was created, its progress write failed.
    stats.partialStarts += 1;
    const created = afterJourneys.filter((row) => !beforeJourneys.some((entry) => entry.id === row.id));
    assert.equal(created.length, 1, `${label}: exactly one journey row from a failed start`);
    assert.equal(created[0].user_id, ctx.ownerId);
    assert.equal(created[0].status, 'active');
    assert.equal(created[0].completed_step_keys, '[]');
    assert.ok(same(afterJourneys.filter((row) => row.id !== created[0].id), beforeJourneys));
    model.journeys.push({ id: created[0].id, outcome: req.outcome, status: 'active', steps: [] });
  } else {
    assert.ok(same(afterJourneys, beforeJourneys), `${label}: failed operation changed a journey row`);
  }
  await assertDatabaseMatchesModel(model, ctx, label);

  // Immediate retry with the failure removed succeeds exactly once.
  stats.retries += 1;
  const retryExp = req.expect(model);
  const beforeRetry = await journeyRows();
  const retried = await sendJourney(ctx, req, 'none');
  assertResponse(retried, retryExp, `${label} [retry]`);
  // A failure can preempt a rejection; the retry then repeats that rejection and changes nothing.
  if (retryExp.status < 400) applySuccess(model, req, retryExp, retried);
  else assert.ok(same(await journeyRows(), beforeRetry), `${label}: rejected retry changed a journey row`);
  await assertDatabaseMatchesModel(model, ctx, `${label} [retry]`);
  const afterRetry = await journeyRows();
  assert.ok(same(otherRows(afterRetry, ctx), otherRows(beforeJourneys, ctx)), `${label}: foreign changed on retry`);
  assert.ok(same(await financialSnapshot(), beforeFinancial), `${label}: retry changed financial state`);
  const changed = afterRetry.filter((row) => (
    !same(row, beforeRetry.find((entry) => entry.id === row.id))
  ));
  assert.ok(changed.length <= 1, `${label}: retry touched more than one journey row`);

  // Replaying the succeeded retry is a no-op, so nothing is applied twice.
  const replay = await sendJourney(ctx, req, 'none');
  const replayExp = req.expect(model);
  assertResponse(replay, replayExp, `${label} [replay]`);
  assert.ok(same(await journeyRows(), afterRetry), `${label}: replay changed a journey row`);
  assert.ok(same(await financialSnapshot(), beforeFinancial), `${label}: replay changed financial state`);
  return { response: retried, exp: retryExp, failed: true };
}

// ---------------------------------------------------------------------------
// Request builders
// ---------------------------------------------------------------------------

function resolveStepKey(selector, outcome) {
  const { required, optional } = SPEC[outcome];
  switch (selector) {
    case 'r0': return required[0];
    case 'r1': return required[1] ?? required[0];
    case 'r2': return required[2] ?? required[required.length - 1];
    case 'o0': return optional[0];
    case 'o1': return optional[1] ?? optional[0];
    case 'x': return STEP_KEYS.find((key) => !allowedKeys(outcome).includes(key));
    default: return 'crypto';
  }
}

function resolveChangeId(kind, stepKey, model, ctx) {
  const types = STEP_RECORD_TYPES[stepKey] ?? [];
  const receipts = [...model.receipts.entries()];
  const matching = receipts.filter(([, type]) => types.includes(type));
  const other = receipts.filter(([, type]) => !types.includes(type));
  switch (kind) {
    case 'none': return undefined;
    case 'own': return (matching[0] ?? other[0])?.[0] ?? MISSING_CHANGE_ID;
    case 'ownOther': return (other[0] ?? matching[0])?.[0] ?? MISSING_CHANGE_ID;
    case 'foreign': return ctx.foreignChangeId;
    default: return MISSING_CHANGE_ID;
  }
}

function startRequest(outcome) {
  return {
    method: 'post',
    body: { desiredOutcome: outcome },
    outcome,
    expect: (model) => expectStart(model, outcome),
    scope500: () => 'journey:start',
  };
}

function transitionRequest({ body, journey, ctx, foreign }) {
  if (foreign) {
    return {
      method: 'patch',
      journeyId: ctx.foreignJourneyId,
      body,
      foreign: true,
      expect: () => {
        const stepAction = body.action === 'complete_step' || body.action === 'skip_step';
        return stepAction && !STEP_KEYS.includes(body.stepKey)
          ? clientError(400, 'INVALID_STEP_KEY', { field: 'stepKey' })
          : clientError(404, 'JOURNEY_NOT_FOUND');
      },
      scope500: () => null,
    };
  }
  return {
    method: 'patch',
    journeyId: journey.id,
    body,
    expect: (model) => expectTransition(model, journey, body),
    // An unexpected failure is keyed by the requested step, else by the action.
    scope500: () => `journey:${journey.id}:${typeof body.stepKey === 'string' ? body.stepKey : body.action}`,
  };
}

function buildCommandBody(op, outcome, model, ctx) {
  if (op.action === 'pause' || op.action === 'resume' || op.action === 'complete') {
    return { action: op.action };
  }
  const stepKey = resolveStepKey(op.sel, outcome);
  if (op.action === 'skip_step') return { action: 'skip_step', stepKey };
  const changeId = resolveChangeId(op.change, stepKey, model, ctx);
  return changeId === undefined
    ? { action: 'complete_step', stepKey }
    : { action: 'complete_step', stepKey, changeId };
}

// ---------------------------------------------------------------------------
// One generated case
// ---------------------------------------------------------------------------

async function setupCase(number) {
  await disarmTriggers();
  await testDatabase.reset();
  const ownerId = OWNER_ID_BASE + number * 2;
  const foreignId = ownerId + 1;
  const owner = buildUserFixture({ id: ownerId, email: `jfc-owner-${number}@example.test` });
  const ownerSession = buildSessionFixture({ userId: ownerId, id: ownerId + SESSION_ID_OFFSET });
  const foreign = buildUserFixture({ id: foreignId, email: `jfc-foreign-${number}@example.test` });
  const foreignSession = buildSessionFixture({ userId: foreignId, id: foreignId + SESSION_ID_OFFSET });
  await insertAccount(owner, ownerSession);
  await insertAccount(foreign, foreignSession);

  const index = number + 1;
  const ctx = {
    ownerId,
    foreignId,
    ownerToken: tokenFor(owner, ownerSession),
    foreignToken: tokenFor(foreign, foreignSession),
    ip: `10.${(index >> 16) & 255}.${(index >> 8) & 255}.${index & 255}`,
  };

  // The foreign user has real progress that no owner operation may touch.
  const salary = await financeRequest(ctx, FINANCE_ROUTES.salary.path, financeBody('salary'), nextKey(), ctx.foreignToken);
  assert.equal(salary.status, 200, JSON.stringify(salary.body));
  ctx.foreignChangeId = salary.body.mutation.changeId;
  const started = await stamp(request(app).post(BASE), ctx, ctx.foreignToken)
    .send({ desiredOutcome: 'plan_month' });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  ctx.foreignJourneyId = started.body.journey.id;
  return ctx;
}

async function runCase(spec) {
  caseCounter += 1;
  const number = caseCounter;
  const ctx = await setupCase(number);
  const model = {
    records: { salary: false, expenses: 0, goal: false, bills: 0, trip: 0 },
    receipts: new Map(),
    journeys: [],
    tripId: null,
  };

  for (const kind of spec.seed) await createRecord(ctx, model, kind);

  await runJourneyRequest(ctx, model, startRequest(spec.outcome), spec.startFail, `case ${number} start`);

  for (const [index, op] of spec.ops.entries()) {
    const label = `case ${number} op ${index} ${JSON.stringify(op)}`;
    const latest = model.journeys[model.journeys.length - 1];
    const targetJourney = op.target === 'old' ? model.journeys[0] : latest;

    if (op.t === 'record') {
      await createRecord(ctx, model, op.kind);
    } else if (op.t === 'start') {
      await runJourneyRequest(ctx, model, startRequest(op.outcome), op.fail, label);
    } else if (op.t === 'invalid') {
      const useStart = op.idx % 2 === 0;
      const table = useStart ? INVALID_START_BODIES : INVALID_PATCH_BODIES;
      const entry = table[Math.floor(op.idx / 2) % table.length];
      const req = useStart
        ? { method: 'post', body: entry.body, expect: () => clientError(400, entry.code, { field: entry.field }), scope500: () => null }
        : { method: 'patch', journeyId: latest.id, body: entry.body, expect: () => clientError(400, entry.code, { field: entry.field }), scope500: () => null };
      const before = await journeyRows();
      await runJourneyRequest(ctx, model, req, op.fail === 'read' ? 'write-all' : op.fail, label);
      assert.ok(same(await journeyRows(), before), `${label}: invalid command changed a journey`);
    } else if (op.target === 'foreign') {
      stats.foreign += 1;
      const body = buildCommandBody(op, targetJourney.outcome, model, ctx);
      const req = transitionRequest({ body, ctx, foreign: true });
      const result = await runJourneyRequest(ctx, model, req, op.fail === 'read' ? 'write-all' : op.fail, label);
      if (result.response.status === 404) {
        // A foreign id and a missing id are indistinguishable.
        const missing = await stamp(request(app).patch(`${BASE}/${MISSING_JOURNEY_ID}`), ctx).send(body);
        assert.equal(missing.status, 404);
        assert.deepEqual(missing.body, result.response.body, `${label}: uniform 404`);
      }
    } else {
      const body = buildCommandBody(op, targetJourney.outcome, model, ctx);
      const req = transitionRequest({ body, journey: targetJourney, ctx });
      const result = await runJourneyRequest(ctx, model, req, op.fail, label);

      // A step that failed to confirm is fixed by saving its record once, then retried.
      if (result.exp.code === 'STEP_NOT_CONFIRMED' && op.fix && !result.failed) {
        const fixKind = { salary: 'salary', monthly_plan: 'salary', expense: 'expense', goal: 'goal' }[body.stepKey];
        if (fixKind) {
          const changeId = await createRecord(ctx, model, fixKind);
          if (changeId !== null) {
            stats.fixedRetries += 1;
            const retryBody = { action: 'complete_step', stepKey: body.stepKey, changeId };
            const retryReq = transitionRequest({ body: retryBody, journey: targetJourney, ctx });
            const afterFix = await runJourneyRequest(ctx, model, retryReq, 'none', `${label} [after save]`);
            assert.equal(afterFix.response.status, 200, `${label}: retry after the record was saved`);
            const confirmed = afterFix.response.body.transition.confirmedChangeId;
            assert.equal(confirmed, changeId, `${label}: continues from the failed step`);
          }
        }
      }
    }
  }

  // The resumable journey the API reports matches the model.
  const active = await stamp(request(app).get(`${BASE}/active`), ctx);
  assert.equal(active.status, 200);
  const open = openJourney(model);
  if (open) {
    assert.equal(active.body.journey.id, open.id);
    assert.equal(active.body.journey.status, open.status);
  } else {
    assert.equal(active.body.journey, null);
  }
  const foreignActive = await stamp(request(app).get(`${BASE}/active`), ctx, ctx.foreignToken);
  assert.equal(foreignActive.body.journey.id, ctx.foreignJourneyId);
  stats.cases += 1;
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const failureArb = fc.oneof(
  { weight: 4, arbitrary: fc.constant('none') },
  { weight: 3, arbitrary: fc.constant('write-all') },
  { weight: 2, arbitrary: fc.constant('write-update') },
  { weight: 3, arbitrary: fc.constant('read') }
);

const opArb = fc.record({
  t: fc.oneof(
    { weight: 10, arbitrary: fc.constant('cmd') },
    { weight: 3, arbitrary: fc.constant('record') },
    { weight: 2, arbitrary: fc.constant('invalid') },
    { weight: 2, arbitrary: fc.constant('start') }
  ),
  action: fc.oneof(
    { weight: 5, arbitrary: fc.constant('complete_step') },
    { weight: 2, arbitrary: fc.constant('skip_step') },
    { weight: 1, arbitrary: fc.constant('pause') },
    { weight: 1, arbitrary: fc.constant('resume') },
    { weight: 1, arbitrary: fc.constant('complete') }
  ),
  sel: fc.constantFrom('r0', 'r0', 'r1', 'r2', 'o0', 'o1', 'x', 'z'),
  change: fc.constantFrom('none', 'none', 'none', 'own', 'ownOther', 'foreign', 'missing'),
  target: fc.oneof(
    { weight: 8, arbitrary: fc.constant('latest') },
    { weight: 1, arbitrary: fc.constant('old') },
    { weight: 2, arbitrary: fc.constant('foreign') }
  ),
  fail: failureArb,
  fix: fc.boolean(),
  outcome: fc.constantFrom(...OUTCOMES),
  kind: fc.constantFrom('salary', 'expense', 'goal', 'bills', 'trip'),
  idx: fc.nat({ max: 200 }),
});

const caseArb = fc.record({
  outcome: fc.constantFrom(...OUTCOMES),
  startFail: failureArb,
  seed: fc.subarray(['salary', 'expense', 'goal', 'bills', 'trip', 'trip', 'trip'], { maxLength: 4 }),
  ops: fc.array(opArb, { minLength: 3, maxLength: 9 }),
});

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

before(async () => {
  testDatabase = await createIsolatedTestDatabase();
  db = testDatabase.db;
  process.env.FINANCIAL_MUTATION_HMAC_KEY =
    'test-only-journey-containment-hmac-key-32-bytes-minimum';
  const [{ createApp }, serviceModule, journeyRepo, financialRepo, settings, routerModule] =
    await Promise.all([
      import('../../src/app.js'),
      import('../../src/services/journeyService.js'),
      import('../../src/repositories/journeyRepository.js'),
      import('../../src/repositories/financialRepository.js'),
      import('../../src/services/claritySettings.js'),
      import('../../src/routes/journeys.js'),
    ]);
  app = createApp();

  const realFinancial = financialRepo.default;
  const readFailure = (name) => (...args) => {
    if (flaky.armed) {
      flaky.armed = false;
      flaky.fired += 1;
      throw new Error('simulated record read failure: SELECT amount FROM salary_entries');
    }
    return realFinancial[name](...args);
  };
  flakyApp = express();
  flakyApp.use(express.json());
  flakyApp.use(BASE, routerModule.createJourneysRouter({
    service: new serviceModule.JourneyService({
      journeys: journeyRepo.default,
      financial: {
        loadPeriod: readFailure('loadPeriod'),
        loadGoals: readFailure('loadGoals'),
        listAccessibleTrips: readFailure('listAccessibleTrips'),
        loadAccessibleTripLedger: (...args) => realFinancial.loadAccessibleTripLedger(...args),
      },
      consent: settings.default,
    }),
  }));

  // The routes log one line per contained failure. Keep that out of the report.
  originalConsoleError = console.error;
  console.error = (...args) => {
    if (typeof args[0] === 'string' && args[0].includes('"event":"JOURNEY_OPERATION_FAILED"')) {
      stats.suppressedLogs += 1;
      return;
    }
    originalConsoleError(...args);
  };
});

after(async () => {
  if (originalConsoleError) console.error = originalConsoleError;
  try {
    if (db) await disarmTriggers();
  } finally {
    await testDatabase?.cleanup();
  }
});

let lastFailure = null;

test('Property 20: failed journey operations preserve confirmed progress', { timeout: 1_200_000 }, async () => {
  // fast-check reports the shrunk counterexample; keep the last failure's message with it.
  try {
    await fc.assert(
      fc.asyncProperty(caseArb, async (spec) => {
        try {
          await runCase(spec);
        } catch (error) {
          lastFailure = error;
          throw error;
        }
      }),
      { numRuns: RUNS }
    );
  } catch (error) {
    if (lastFailure) {
      error.message += `\nLast assertion failure: ${lastFailure.stack ?? lastFailure.message}`;
    }
    throw error;
  }

  assert.ok(stats.cases >= MIN_CASES, `generated cases: ${stats.cases}`);
  // The generator must actually exercise every failure path.
  assert.ok(stats.writeFailures > 0, 'repository write failures were injected');
  assert.ok(stats.readFailures > 0, 'record read failures were injected');
  assert.ok(stats.unconfirmed > 0, 'unconfirmed steps were exercised');
  assert.ok(stats.validation > 0, 'rejected commands were exercised');
  assert.ok(stats.foreign > 0, 'cross-user commands were exercised');
  assert.ok(stats.retries > 0, 'retries after failure were exercised');
  assert.ok(stats.recordWrites > 0, 'record writes were exercised');
  console.log(`Property 20 stats: ${JSON.stringify(stats)}`);
});

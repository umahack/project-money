/**
 * Final rollout and rollback safety acceptance (task 17.5).
 *
 * The feature-by-feature suites already prove each route. This file proves the
 * rollout contract across them, on one isolated database and one realistic
 * mixed session (canonical writes with the clarity contract header, then legacy
 * writes without it):
 *
 * - the rollout flags default off and are read per request, never at startup;
 * - with CLARITY_SHADOW_COMPARE and MONTHLY_REVIEW_CALCULATION_MODE toggled
 *   through every combination, the legacy routes answer with the same pinned
 *   shapes and values, and no clarity record (receipts, versions, journeys,
 *   treatments, personal links, measurement rows) is created, changed, or
 *   removed, while the clarity routes stay readable;
 * - legacy writes after clarity writes leave every receipt and version intact,
 *   and clarity writes and replays continue from the same base;
 * - export after a mixed session carries every clarity collection;
 * - account deletion is atomic, revokes public links, and keeps other accounts;
 * - session revocation and CORS behave the same in every mode;
 * - no mode changes the route inventory, adds a listener, or changes how
 *   requests authenticate.
 *
 * Nothing here reaches a remote database, mail service, or non-loopback port.
 */
import { after, afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createIsolatedTestDatabase } from '../helpers/testDatabase.js';
import { buildSessionFixture, buildUserFixture } from '../helpers/fixtures.js';
import {
  ANONYMOUS_ROUTE_ALLOWLIST,
  CRON_ROUTE_ALLOWLIST,
  collectRoutes,
  listSourceFiles,
  routeKey,
} from '../helpers/routeInventory.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE_ROOT = join(HERE, '..', '..', 'src');
const PROJECT_ROOT = join(HERE, '..', '..', '..');

const PASSWORD = 'Rollback-acceptance-123!';
const OWNER_ID = 17_501;
const MEMBER_ID = 17_502;
const OWNER_SESSION_ID = 17_511;
const OWNER_SECOND_SESSION_ID = 17_520;
const MEMBER_SESSION_ID = 17_513;
const TRIP_ID = 17_601;
const TRIP_EXPENSE_ID = 17_701;
const PUBLIC_TOKEN = '17a117b217c317d417e517f617a717b8';

/** Every combination of the two server rollout switches, in the order a rollback would pass through them. */
const MODES = Object.freeze([
  { name: 'clarity enabled', shadow: 'false', review: undefined },
  { name: 'shadow comparison', shadow: 'true', review: 'canonical' },
  { name: 'rollback to legacy review, shadow on', shadow: 'true', review: 'legacy' },
  { name: 'rollback to legacy review, shadow off', shadow: 'false', review: 'legacy' },
]);

const CLARITY_TABLES = Object.freeze([
  'financial_record_changes',
  'user_financial_state',
  'guided_journeys',
  'expense_category_treatments',
  'trip_expense_personal_links',
  'product_measurement_events',
]);
const SOURCE_TABLES = Object.freeze([
  'salary_entries',
  'emis',
  'expense_log',
  'savings_goals',
  'trips',
  'trip_members',
  'trip_expenses',
]);

let testDatabase;
let db;
let createApp;
let app;
let passwordHash;
let originalCorsOrigin;
const previousEnvironment = {};

// ---------------------------------------------------------------- utilities

function monthAtOffset(offset) {
  const date = new Date();
  date.setDate(1);
  date.setMonth(date.getMonth() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

const MONTH = () => monthAtOffset(0);
const PREVIOUS_MONTH = () => monthAtOffset(-1);

function tokenFor(userId, sessionId) {
  return `Bearer ${jwt.sign(
    { sub: String(userId), tv: 1, sid: sessionId },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '5m' }
  )}`;
}

const ownerToken = () => tokenFor(OWNER_ID, OWNER_SESSION_ID);
const memberToken = () => tokenFor(MEMBER_ID, MEMBER_SESSION_ID);

function applyMode(mode) {
  process.env.CLARITY_SHADOW_COMPARE = mode.shadow;
  if (mode.review === undefined) delete process.env.MONTHLY_REVIEW_CALCULATION_MODE;
  else process.env.MONTHLY_REVIEW_CALCULATION_MODE = mode.review;
}

/** Clarity-contract call: contract header plus a fresh idempotency key unless one is supplied. */
function canonical(method, path, token, body, key = randomUUID()) {
  let builder = request(app)[method](path)
    .set('Authorization', token)
    .set('X-Clarity-Contract', '1')
    .set('Idempotency-Key', key);
  if (body !== undefined) builder = builder.send(body);
  return builder;
}

/** Legacy call: no contract header and no idempotency key, as an old client sends it. */
function legacy(method, path, token, body) {
  let builder = request(app)[method](path);
  if (token) builder = builder.set('Authorization', token);
  if (body !== undefined) builder = builder.send(body);
  return builder;
}

function assertKeys(value, expected, label = 'object') {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), label);
}

async function scalar(sql, ...args) {
  const row = await db.prepare(sql).get(...args);
  return row ? Number(Object.values(row)[0]) : null;
}

async function rowsOf(table) {
  const rows = await db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all();
  return rows.map((row) => Object.fromEntries(Object.entries(row)));
}

/** Every source and clarity table. `sessions` is excluded: authentication legitimately touches last_seen_at. */
async function fullState() {
  const state = {};
  for (const table of [...SOURCE_TABLES, ...CLARITY_TABLES]) state[table] = await rowsOf(table);
  return state;
}

function withoutGeneratedAt(snapshot) {
  const { generatedAt: _generatedAt, ...rest } = snapshot;
  return rest;
}

// ------------------------------------------------------------------ seeding

async function insertAccount(user, session) {
  await db.prepare(
    `INSERT INTO users (id, email, name, password_hash, is_admin, token_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(user.id, user.email, user.name, user.password_hash, user.is_admin, user.token_version, user.created_at);
  await db.prepare(
    `INSERT INTO sessions (id, user_id, device_label, ip_hash, user_agent, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(session.id, session.user_id, session.device_label, session.ip_hash, session.user_agent, session.created_at, session.last_seen_at);
  await db.prepare(
    `INSERT INTO user_financial_state (user_id, data_use_notice_version, data_use_acknowledged_at)
     VALUES (?, 1, CURRENT_TIMESTAMP)`
  ).run(user.id);
}

async function seedAccountsAndTrip() {
  const owner = buildUserFixture({ id: OWNER_ID, email: 'rollback-owner@example.test', name: 'Rollback Owner', password_hash: passwordHash });
  const member = buildUserFixture({ id: MEMBER_ID, email: 'rollback-member@example.test', name: 'Rollback Member', password_hash: passwordHash });
  await insertAccount(owner, buildSessionFixture({ id: OWNER_SESSION_ID, userId: OWNER_ID }));
  await insertAccount(member, buildSessionFixture({ id: MEMBER_SESSION_ID, userId: MEMBER_ID }));
  await db.prepare(
    `INSERT INTO trips (id, user_id, name, destination, budget, public_token, public_enabled)
     VALUES (?, ?, 'Rollback trip', 'Pune', 5000, ?, 1)`
  ).run(TRIP_ID, OWNER_ID, PUBLIC_TOKEN);
  await db.prepare('INSERT INTO trip_members (trip_id, user_id, name, email) VALUES (?, ?, ?, ?)')
    .run(TRIP_ID, OWNER_ID, 'Owner', owner.email);
  await db.prepare('INSERT INTO trip_members (trip_id, user_id, name, email) VALUES (?, ?, ?, ?)')
    .run(TRIP_ID, MEMBER_ID, 'Member', member.email);
  await db.prepare(
    `INSERT INTO trip_expenses (id, trip_id, payer, description, amount, split_json)
     VALUES (?, ?, 'Owner', 'Hotel', 100, ?)`
  ).run(TRIP_EXPENSE_ID, TRIP_ID, JSON.stringify([{ name: 'Owner', share: 1 }, { name: 'Member', share: 1 }]));
}

/**
 * One realistic first session written through the clarity contract: analytics opt-in, a guided journey,
 * pay and bills for this and the previous month, expenses, a category treatment, a goal and a contribution,
 * personal trip links for two accounts, and measurement events.
 */
async function seedClaritySession() {
  const month = MONTH();
  const previous = PREVIOUS_MONTH();
  const ids = { commands: {} };
  const expectOk = (response, label) => {
    assert.equal(response.status, 200, `${label}: ${JSON.stringify(response.body)}`);
    return response;
  };

  const settings = await legacy('patch', '/api/clarity/settings', ownerToken(), { analyticsEnabled: true });
  assert.equal(settings.status, 200, JSON.stringify(settings.body));

  const journey = await legacy('post', '/api/clarity/journeys', ownerToken(), { desiredOutcome: 'plan_month' });
  assert.ok([200, 201].includes(journey.status), JSON.stringify(journey.body));
  ids.journeyId = journey.body.journey.id;

  const salary = expectOk(await canonical('post', '/api/finance/salary', ownerToken(), { amountMinor: 8_000_000, month, expectedRecordVersion: 0 }), 'salary');
  ids.salaryChangeId = salary.body.mutation.changeId;
  expectOk(await canonical('post', '/api/finance/salary', ownerToken(), { amountMinor: 6_000_000, month: previous, expectedRecordVersion: 0 }), 'previous salary');
  const step = await legacy('patch', `/api/clarity/journeys/${ids.journeyId}`, ownerToken(), {
    action: 'complete_step', stepKey: 'salary', changeId: ids.salaryChangeId,
  });
  assert.equal(step.status, 200, JSON.stringify(step.body));

  for (const bill of [
    { label: 'Rollback rent', amountMinor: 2_000_000, category: 'Rent' },
    { label: 'Rollback insurance', amountMinor: 250_000, category: 'Insurance' },
  ]) expectOk(await canonical('post', '/api/finance/emis', ownerToken(), bill), `bill ${bill.label}`);

  const expenseKey = randomUUID();
  const expenseBody = { amount: '1250.50', category: 'Food', note: 'Rollback lunch', spentOn: `${month}-01` };
  const expense = expectOk(await canonical('post', '/api/finance/expenses', ownerToken(), expenseBody, expenseKey), 'expense');
  ids.expenseId = expense.body.mutation.recordId;
  ids.expenseVersion = expense.body.mutation.recordVersion;
  ids.commands.expense = { key: expenseKey, body: expenseBody, changeId: expense.body.mutation.changeId };
  expectOk(await canonical('post', '/api/finance/expenses', ownerToken(), { amount: '1250.50', category: 'Groceries', spentOn: `${previous}-03` }), 'previous groceries');
  expectOk(await canonical('post', '/api/finance/expenses', ownerToken(), { amount: '800.00', category: 'Entertainment', spentOn: `${previous}-12` }), 'previous entertainment');
  expectOk(await canonical('put', '/api/finance/category-treatments/Food', ownerToken(), { treatment: 'wants' }), 'treatment');

  const goal = expectOk(await canonical('post', '/api/finance/goals', ownerToken(), {
    name: 'Rollback laptop', targetAmount: '1000.00', savedAmount: '250.00', targetDate: `${monthAtOffset(6)}-15`,
  }), 'goal');
  ids.goalId = goal.body.mutation.recordId;
  expectOk(await canonical('post', `/api/finance/goals/${ids.goalId}/contributions`, ownerToken(), { contributionMinor: 10_000 }), 'contribution');

  // The second account also has a previous month, so the monthly review finds data for both accounts.
  expectOk(await canonical('post', '/api/finance/salary', memberToken(), { amountMinor: 5_000_000, month: previous, expectedRecordVersion: 0 }), 'member salary');
  expectOk(await canonical('post', '/api/finance/expenses', memberToken(), { amount: '500.00', category: 'Food', spentOn: `${previous}-05` }), 'member expense');
  for (const token of [ownerToken(), memberToken()]) {
    expectOk(await canonical('put', `/api/trips/${TRIP_ID}/expenses/${TRIP_EXPENSE_ID}/personal-link`, token, {
      category: 'Travel', spentOn: `${month}-01`,
    }), 'personal link');
  }

  const occurredAt = new Date().toISOString();
  for (const event of [
    { event: 'journey_started', journeyId: ids.journeyId, desiredOutcome: 'plan_month', occurredAt },
    { event: 'financial_change_ui', changeId: ids.salaryChangeId, causedReload: false, causedPageWideLoading: false, occurredAt },
  ]) {
    const response = await legacy('post', '/api/clarity/events', ownerToken(), event);
    assert.equal(response.status, 204, `${event.event}: ${JSON.stringify(response.body)}`);
  }
  return ids;
}

// ------------------------------------------------------------------ lifecycle

before(async () => {
  testDatabase = await createIsolatedTestDatabase();
  db = testDatabase.db;
  passwordHash = await bcrypt.hash(PASSWORD, 4);
  originalCorsOrigin = process.env.CORS_ORIGIN;
  process.env.FINANCIAL_MUTATION_HMAC_KEY = 'test-only-rollout-rollback-hmac-key-32-bytes-min';
  for (const key of ['CLARITY_SHADOW_COMPARE', 'MONTHLY_REVIEW_CALCULATION_MODE']) previousEnvironment[key] = process.env[key];
  ({ createApp } = await import('../../src/app.js'));
  app = createApp();
});

/** The app limits each instance to 120 requests a minute, so long scenarios take a fresh instance per mode. */
function freshApp() {
  app = createApp();
}

beforeEach(async () => {
  freshApp();
  await testDatabase.reset();
  await db.prepare('DROP TABLE IF EXISTS monthly_review_log').run();
  applyMode(MODES[0]);
  await seedAccountsAndTrip();
});

afterEach(async () => {
  // authRequired updates last_seen_at without awaiting it.
  await new Promise((resolve) => setImmediate(resolve));
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  process.env.CORS_ORIGIN = originalCorsOrigin;
});

after(async () => {
  await testDatabase?.cleanup();
});

// ======================================================================
// Defaults
// ======================================================================

test('rollout flags default off, fail closed on unsupported values, and are read per request', async () => {
  const { readServerFeatureFlags, readBooleanFeatureFlag } = await import('../../src/rollout/featureFlags.js');
  assert.deepEqual({ ...readServerFeatureFlags({}) }, {
    clarityShadowCompare: false,
    quickAddEnabled: false,
  });
  for (const value of [undefined, null, '', ' ', '0', 'false', 'no', 'off', 'yes', 'enabled', 'truee', 2, true]) {
    assert.equal(readBooleanFeatureFlag(value), false, `${String(value)} must not enable shadow comparison`);
  }
  for (const value of ['1', 'true', ' TRUE ']) assert.equal(readBooleanFeatureFlag(value), true);

  // The shipped examples keep both generations of the switch off.
  const backendExample = await readFile(join(PROJECT_ROOT, 'backend', '.env.example'), 'utf8');
  assert.match(backendExample, /^CLARITY_SHADOW_COMPARE=false$/m);
  assert.doesNotMatch(backendExample, /^MONTHLY_REVIEW_CALCULATION_MODE=legacy/m);
  const frontendExample = await readFile(join(PROJECT_ROOT, 'frontend', '.env.production.example'), 'utf8');
  assert.match(frontendExample, /^VITE_FINANCIAL_CLARITY_ENABLED=false$/m);

  // The flag is not captured when the app is built: flipping it takes effect on the next request.
  const seeded = await seedClaritySession();
  assert.ok(seeded.journeyId > 0);
  const month = MONTH();
  const before = await legacy('get', '/api/finance/plan', ownerToken());
  assert.equal(before.status, 200);
  applyMode(MODES[1]);
  const shadow = await legacy('get', '/api/finance/plan', ownerToken());
  applyMode(MODES[0]);
  const after = await legacy('get', '/api/finance/plan', ownerToken());
  assert.deepEqual(shadow.body, before.body);
  assert.deepEqual(after.body, before.body);
  assert.equal(before.body.month, month);

  // An unsupported review mode is refused instead of silently choosing a path.
  const { runMonthlyReview } = await import('../../src/jobs/monthlyReview.js');
  await assert.rejects(runMonthlyReview({ dry: true, calculationMode: 'both', log: () => {} }), RangeError);
  const defaulted = await runMonthlyReview({ dry: true, calculationMode: undefined, shadowCompare: false, log: () => {} });
  assert.equal(defaulted.failed, 0);
});

// ======================================================================
// Rollback modes: legacy shapes unchanged, clarity data untouched and readable
// ======================================================================

async function readLegacyAndClarity() {
  const month = MONTH();
  const token = ownerToken();
  const plan = await legacy('get', '/api/finance/plan', token);
  const salary = await legacy('get', '/api/finance/salary', token);
  const bills = await legacy('get', '/api/finance/emis', token);
  const expenses = await legacy('get', `/api/finance/expenses?month=${month}`, token);
  const goals = await legacy('get', '/api/finance/goals', token);
  const trips = await legacy('get', '/api/trips', token);
  const trip = await legacy('get', `/api/trips/${TRIP_ID}`, token);
  const publicTrip = await legacy('get', `/api/public/trips/${PUBLIC_TOKEN}`);
  const negotiatedPlan = await canonical('get', '/api/finance/plan', token);
  const clarity = await canonical('get', `/api/finance/clarity?month=${month}`, token);
  const explanation = await canonical('get', `/api/finance/explanations/monthly-plan:${month}`, token);
  const settings = await legacy('get', '/api/clarity/settings', token);
  const journey = await legacy('get', '/api/clarity/journeys/active', token);
  return { plan, salary, bills, expenses, goals, trips, trip, publicTrip, negotiatedPlan, clarity, explanation, settings, journey };
}

function assertPinnedLegacyShapes(reads) {
  for (const [name, response] of Object.entries(reads)) assert.equal(response.status, 200, `${name}: ${JSON.stringify(response.body)}`);
  assertKeys(reads.plan.body, ['income', 'emiTotal', 'afterFixed', 'breakdown', 'month', 'spentThisMonth', 'byCategory', 'tips'], 'plan');
  assertKeys(reads.plan.body.breakdown, ['needs', 'wants', 'save'], 'plan breakdown');
  assertKeys(reads.salary.body, ['salary'], 'salary');
  assertKeys(reads.salary.body.salary, ['month', 'amount'], 'salary row');
  assertKeys(reads.bills.body, ['emis'], 'bills');
  assertKeys(reads.bills.body.emis[0], ['id', 'label', 'amount', 'category'], 'bill row');
  assertKeys(reads.expenses.body, ['month', 'categories', 'expenses'], 'expenses');
  assertKeys(reads.expenses.body.expenses[0], ['id', 'month', 'category', 'amount', 'note', 'spent_on', 'created_at'], 'expense row');
  assertKeys(reads.goals.body, ['goals'], 'goals');
  assertKeys(reads.goals.body.goals[0], ['id', 'name', 'target_amount', 'saved_amount', 'target_date', 'created_at', 'updated_at'], 'goal row');
  assertKeys(reads.trips.body, ['trips'], 'trips');
  assertKeys(reads.trip.body, ['trip', 'role', 'members', 'expenses', 'settlement'], 'trip detail');
  assertKeys(reads.publicTrip.body, ['trip', 'members', 'expenses', 'settlement'], 'public trip');
  assertKeys(reads.publicTrip.body.trip, ['name', 'destination', 'budget', 'start_date', 'end_date'], 'public trip header');
  // The negotiated plan adds only the envelope; every legacy field is identical.
  assertKeys(reads.negotiatedPlan.body, [...Object.keys(reads.plan.body), 'schemaVersion', 'clarity'], 'negotiated plan');
  for (const key of Object.keys(reads.plan.body)) assert.deepEqual(reads.negotiatedPlan.body[key], reads.plan.body[key], key);
  assert.equal(reads.clarity.body.schemaVersion, 1);
}

test('every rollout mode serves identical legacy responses, leaves all clarity data untouched, and keeps clarity readable', async () => {
  await seedClaritySession();
  const month = MONTH();
  const before = await fullState();
  for (const table of CLARITY_TABLES) assert.ok(before[table].length > 0, `${table} must hold seeded feature data`);

  const { runMonthlyReview } = await import('../../src/jobs/monthlyReview.js');
  let baseline = null;
  const reviewResults = [];
  for (const mode of MODES) {
    applyMode(mode);
    freshApp();
    const reads = await readLegacyAndClarity();
    assertPinnedLegacyShapes(reads);
    // The bodies, not just the shapes, are mode independent (the review's timestamps are not in these reads).
    const comparable = {
      plan: reads.plan.body,
      salary: reads.salary.body,
      bills: reads.bills.body,
      expenses: reads.expenses.body,
      goals: reads.goals.body,
      trips: reads.trips.body,
      trip: reads.trip.body,
      publicTrip: reads.publicTrip.body,
      clarity: withoutGeneratedAt(reads.clarity.body.snapshot),
      explanation: reads.explanation.body,
      settings: reads.settings.body,
      journey: reads.journey.body,
    };
    baseline ??= comparable;
    assert.deepEqual(comparable, baseline, `${mode.name}: responses changed with the rollout mode`);

    const logs = [];
    reviewResults.push(await runMonthlyReview({
      dry: true,
      calculationMode: mode.review,
      shadowCompare: mode.shadow === 'true',
      log: (line) => logs.push(String(line)),
    }));
    assert.equal(
      logs.some((line) => /\d{4,}\.\d{2}|example\.test|Rollback/.test(line)),
      false,
      `${mode.name}: job logs must not contain amounts, names, or emails`
    );
    assert.deepEqual(logs.filter((line) => /SHADOW_/.test(line)), [], `${mode.name}: no mismatch for this fixture`);
    assert.deepEqual(logs.filter((line) => /CANONICAL_FALLBACK/.test(line)), [], `${mode.name}: no fallback needed`);
    assert.equal(
      await scalar("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'monthly_review_log'"),
      1
    );
    assert.equal(await scalar('SELECT COUNT(*) FROM monthly_review_log'), 0, 'a dry run records nothing');
  }

  // The review picks the same users and finds the same data on either calculation path.
  assert.equal(reviewResults.length, MODES.length);
  for (const result of reviewResults) assert.deepEqual(result, reviewResults[0]);
  assert.deepEqual(
    { month: reviewResults[0].month, sent: reviewResults[0].sent, failed: reviewResults[0].failed, dry: reviewResults[0].dry },
    { month: PREVIOUS_MONTH(), sent: 2, failed: 0, dry: true }
  );

  // Nothing moved: not a source row, a receipt, a version, a journey, a treatment, a link, or a measurement row.
  assert.deepEqual(await fullState(), before);
  assert.equal(baseline.clarity.period.month, month);
});

// ======================================================================
// Legacy writes after clarity writes
// ======================================================================

test('legacy writes after clarity writes keep receipts and versions intact and clarity continues from the same base', async () => {
  const seeded = await seedClaritySession();
  const month = MONTH();
  const receiptsBefore = await rowsOf('financial_record_changes');
  const versionBefore = await scalar('SELECT data_version FROM user_financial_state WHERE user_id = ?', OWNER_ID);
  const journeysBefore = await rowsOf('guided_journeys');
  const treatmentsBefore = await rowsOf('expense_category_treatments');
  const linksBefore = await rowsOf('trip_expense_personal_links');
  const measurementBefore = await rowsOf('product_measurement_events');
  assert.ok(receiptsBefore.length >= 10);

  // An old client writes with the legacy contract, with shadow comparison on and then in rollback mode.
  applyMode(MODES[1]);
  const token = ownerToken();
  const salary = await legacy('post', '/api/finance/salary', token, { amount: 85_000, month });
  assert.equal(salary.status, 200, JSON.stringify(salary.body));
  assertKeys(salary.body, ['ok', 'month', 'amount']);
  const bill = await legacy('post', '/api/finance/emis', token, { label: 'Legacy bill', amount: 1_000, category: 'Rent' });
  assertKeys(bill.body, ['id']);
  applyMode(MODES[2]);
  const billUpdate = await legacy('patch', `/api/finance/emis/${bill.body.id}`, token, { category: 'Utility' });
  assert.equal(billUpdate.status, 200);
  assertKeys(billUpdate.body, ['ok', 'emi']);
  const expense = await legacy('post', '/api/finance/expenses', token, { amount: 99.5, category: 'Transport', note: 'Legacy fare', spentOn: `${month}-02` });
  assert.equal(expense.status, 200);
  assertKeys(expense.body, ['id', 'month']);
  const goal = await legacy('post', '/api/finance/goals', token, {
    name: 'Legacy goal', targetAmount: 500, savedAmount: 0, targetDate: `${monthAtOffset(5)}-10`,
  });
  assertKeys(goal.body, ['id']);
  const goalTopUp = await legacy('patch', `/api/finance/goals/${goal.body.id}`, token, { addToSaved: 50 });
  assert.equal(goalTopUp.status, 200);
  for (const path of [`/api/finance/emis/${bill.body.id}`, `/api/finance/expenses/${expense.body.id}`, `/api/finance/goals/${goal.body.id}`]) {
    const removed = await legacy('delete', path, token);
    assert.equal(removed.status, 200, path);
    assertKeys(removed.body, ['ok']);
  }

  // Receipts, journeys, treatments, links, and measurement rows are exactly as the clarity writes left them.
  const receiptsAfter = await rowsOf('financial_record_changes');
  for (const receipt of receiptsBefore) {
    assert.deepEqual(receiptsAfter.find((row) => row.id === receipt.id), receipt, `receipt ${receipt.id} changed`);
  }
  assert.equal(receiptsAfter.length, receiptsBefore.length, 'legacy writes must not write receipts');
  assert.deepEqual(await rowsOf('guided_journeys'), journeysBefore);
  assert.deepEqual(await rowsOf('expense_category_treatments'), treatmentsBefore);
  assert.deepEqual(await rowsOf('trip_expense_personal_links'), linksBefore);
  assert.deepEqual(await rowsOf('product_measurement_events'), measurementBefore);
  assert.equal(await scalar('SELECT data_version FROM user_financial_state WHERE user_id = ?', OWNER_ID), versionBefore);
  const duplicates = await scalar(
    `SELECT COUNT(*) FROM (SELECT 1 FROM financial_record_changes
      GROUP BY user_id, record_type, record_id, record_version HAVING COUNT(*) > 1)`
  );
  assert.equal(duplicates, 0);

  // The clarity read sees the legacy pay, calculated from the same rows, at the unchanged version.
  const read = await canonical('get', `/api/finance/clarity?month=${month}`, token);
  assert.equal(read.status, 200);
  assert.equal(read.body.snapshot.dataVersion, versionBefore);
  assert.equal(read.body.snapshot.outcomes.monthlyPlan.value.salary.amountMinor, 8_500_000);

  // A clarity command replays exactly once, and a new clarity command advances version and receipts by one.
  const replay = await canonical('post', '/api/finance/expenses', token, seeded.commands.expense.body, seeded.commands.expense.key);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.mutation.replayed, true);
  assert.equal(replay.body.mutation.changeId, seeded.commands.expense.changeId);
  assert.equal((await rowsOf('financial_record_changes')).length, receiptsBefore.length);

  applyMode(MODES[0]);
  const edit = await canonical('patch', `/api/finance/expenses/${seeded.expenseId}`, token, {
    amount: '1300.00', expectedRecordVersion: seeded.expenseVersion,
  });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  assert.equal(edit.body.mutation.recordVersion, seeded.expenseVersion + 1);
  assert.equal(await scalar('SELECT data_version FROM user_financial_state WHERE user_id = ?', OWNER_ID), versionBefore + 1);
  assert.equal((await rowsOf('financial_record_changes')).length, receiptsBefore.length + 1);
  const stale = await canonical('patch', `/api/finance/expenses/${seeded.expenseId}`, token, {
    amount: '1400.00', expectedRecordVersion: seeded.expenseVersion,
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'RECORD_VERSION_CONFLICT');
  assert.equal(await scalar('SELECT data_version FROM user_financial_state WHERE user_id = ?', OWNER_ID), versionBefore + 1);
});

// ======================================================================
// Export and deletion after a mixed session
// ======================================================================

test('export carries every clarity collection after a mixed session, and deletion is atomic and revokes public links', async () => {
  await seedClaritySession();
  const month = MONTH();
  const token = ownerToken();
  // The legacy half of the mixed session.
  assert.equal((await legacy('post', '/api/finance/expenses', token, { amount: 42, category: 'Food', note: 'Legacy export row', spentOn: `${month}-02` })).status, 200);
  assert.equal((await legacy('post', '/api/finance/salary', token, { amount: 81_000, month })).status, 200);

  const exported = await legacy('get', '/api/auth/export', token);
  assert.equal(exported.status, 200);
  const required = [
    'salary_entries', 'emis', 'expenses', 'savings_goals', 'sessions', 'trips_owned', 'trip_memberships',
    'trip_members', 'trip_expenses', 'user_financial_state', 'product_analytics_settings', 'guided_journeys',
    'expense_category_treatments', 'trip_expense_personal_links', 'financial_record_changes',
    'public_sharing_settings', 'product_measurement_events',
  ];
  for (const collection of required) {
    assert.ok(Array.isArray(exported.body.data[collection]) && exported.body.data[collection].length > 0, `${collection} missing from the export`);
    assert.equal(typeof exported.body.schema.tables[collection], 'string', `${collection} is undocumented`);
  }
  assert.ok(exported.body.data.expenses.some((row) => row.note === 'Legacy export row'));
  assert.ok(exported.body.data.expenses.some((row) => row.note === 'Rollback lunch'));
  assert.equal(exported.body.data.product_analytics_settings[0].analytics_enabled, 1);
  assert.equal(exported.body.data.public_sharing_settings[0].public_token, PUBLIC_TOKEN);
  assert.equal(JSON.stringify(exported.body).includes('request_fingerprint_hmac'), false);
  assert.equal(JSON.stringify(exported.body).includes(passwordHash), false);

  // A failing deletion changes nothing, labels itself incomplete, and leaves the public link on.
  const before = await fullState();
  await db.prepare(
    `CREATE TRIGGER reject_rollout_deletion BEFORE DELETE ON trip_expense_personal_links
     BEGIN SELECT RAISE(ABORT, 'injected personal-link deletion failure'); END`
  ).run();
  let failed;
  try {
    failed = await legacy('delete', '/api/auth/account', token, { currentPassword: PASSWORD });
  } finally {
    await db.prepare('DROP TRIGGER reject_rollout_deletion').run();
  }
  assert.equal(failed.status, 500);
  assert.equal(failed.body.code, 'ACCOUNT_DELETION_INCOMPLETE');
  assert.equal(failed.body.status, 'incomplete');
  assert.ok(failed.body.undeleted_record_categories.length > 0);
  assert.deepEqual(await fullState(), before);
  assert.equal((await legacy('get', `/api/public/trips/${PUBLIC_TOKEN}`)).status, 200, 'a rolled-back deletion must not revoke the link');
  assert.equal((await legacy('get', '/api/finance/plan', token)).status, 200, 'the account still works after a failed deletion');

  // The retry removes everything in the account's scope, revokes the link, and keeps the other account.
  const deleted = await legacy('delete', '/api/auth/account', token, { currentPassword: PASSWORD });
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.body, { ok: true });
  for (const [table, column] of [
    ['users', 'id'], ['sessions', 'user_id'], ['salary_entries', 'user_id'], ['emis', 'user_id'], ['expense_log', 'user_id'],
    ['savings_goals', 'user_id'], ['trips', 'user_id'], ['trip_members', 'user_id'], ['user_financial_state', 'user_id'],
    ['guided_journeys', 'user_id'], ['expense_category_treatments', 'user_id'], ['trip_expense_personal_links', 'user_id'],
    ['financial_record_changes', 'user_id'], ['product_measurement_events', 'user_id'],
  ]) {
    assert.equal(await scalar(`SELECT COUNT(*) FROM ${table} WHERE ${column} = ?`, OWNER_ID), 0, `${table} still holds the deleted account`);
  }
  assert.equal(await scalar('SELECT COUNT(*) FROM trips WHERE public_token = ? AND public_enabled = 1', PUBLIC_TOKEN), 0);
  const publicAfter = await legacy('get', `/api/public/trips/${PUBLIC_TOKEN}`);
  assert.equal(publicAfter.status, 404);
  assert.deepEqual(publicAfter.body, { error: 'Not found' });
  assert.equal((await legacy('get', '/api/finance/plan', token)).status, 401, 'the deleted account cannot authenticate');
  assert.equal(await scalar('SELECT COUNT(*) FROM users WHERE id = ?', MEMBER_ID), 1);
  // The deleted account owned the trip, so links that point into it go with it; the member's own expense stays.
  assert.equal(await scalar('SELECT COUNT(*) FROM trip_expense_personal_links WHERE user_id = ?', MEMBER_ID), 0);
  assert.equal(await scalar('SELECT COUNT(*) FROM expense_log WHERE user_id = ?', MEMBER_ID), 2, 'the other account keeps its own expenses');
});

// ======================================================================
// Sessions and CORS
// ======================================================================

test('session revocation and CORS answer the same in every rollout mode', async () => {
  await seedClaritySession();
  const allowedOrigin = process.env.CORS_ORIGIN;
  for (const [index, mode] of MODES.entries()) {
    applyMode(mode);
    freshApp();
    const secondSessionId = OWNER_SECOND_SESSION_ID + index;
    await db.prepare(
      `INSERT INTO sessions (id, user_id, device_label, ip_hash, user_agent)
       VALUES (?, ?, 'Second device', ?, 'RollbackTest/1.0')`
    ).run(secondSessionId, OWNER_ID, `rollback-second-hash-${index}`);
    const second = tokenFor(OWNER_ID, secondSessionId);
    const probes = [
      ['get', '/api/finance/plan'],
      ['get', `/api/finance/clarity?month=${MONTH()}`],
      ['get', '/api/clarity/settings'],
      ['get', '/api/clarity/journeys/active'],
    ];
    for (const [method, path] of probes) {
      assert.equal((await legacy(method, path, second)).status, 200, `${mode.name}: ${path} with a live session`);
    }

    const revoke = await legacy('delete', `/api/auth/sessions/${secondSessionId}`, ownerToken());
    assert.equal(revoke.status, 200);
    for (const [method, path] of probes) {
      const response = await legacy(method, path, second);
      assert.equal(response.status, 401, `${mode.name}: ${path} must reject a revoked session`);
      assert.equal(response.body.code, 'SESSION_REVOKED');
    }
    assert.equal((await legacy('get', '/api/finance/plan', ownerToken())).status, 200, 'the other session is unaffected');

    const allowed = await request(app).get('/api/health').set('Origin', allowedOrigin);
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers['access-control-allow-origin'], allowedOrigin);
    const denied = await request(app).get('/api/health').set('Origin', 'https://not-allowed.example.test');
    assert.equal(denied.status, 403);
    assert.notEqual(denied.headers['access-control-allow-origin'], '*');
    const preflight = await request(app)
      .options('/api/finance/clarity')
      .set('Origin', 'https://not-allowed.example.test')
      .set('Access-Control-Request-Method', 'GET');
    assert.notEqual(preflight.headers['access-control-allow-origin'], '*');
  }
});

// ======================================================================
// Routes, listeners, and authentication paths
// ======================================================================

test('no rollout mode changes the route inventory, opens a listener, or adds an authentication path', async () => {
  const inventories = [];
  for (const mode of MODES) {
    applyMode(mode);
    const listenersBefore = process.getActiveResourcesInfo().filter((name) => name === 'TCPServerWrap').length;
    const routes = collectRoutes(createApp()._router.stack);
    const listenersAfter = process.getActiveResourcesInfo().filter((name) => name === 'TCPServerWrap').length;
    assert.equal(listenersAfter, listenersBefore, `${mode.name}: creating the app must not open a listener`);
    inventories.push(routes.map((route) => `${routeKey(route)} [${route.guards.includes('authRequired') ? 'private' : 'open'}]`).sort());

    const cron = routes.filter((route) => route.guards.includes('requireCronSecret'));
    assert.deepEqual(cron.map(routeKey).sort(), [...CRON_ROUTE_ALLOWLIST]);
    const open = routes.filter((route) => !route.guards.includes('authRequired') && !cron.includes(route));
    assert.deepEqual(open.map(routeKey).sort(), [...ANONYMOUS_ROUTE_ALLOWLIST].sort(), `${mode.name}: the anonymous routes changed`);
    for (const route of routes.filter((entry) => /^\/api\/(finance|trips|clarity)(\/|$)/.test(entry.path))) {
      assert.ok(route.guards.includes('authRequired'), `${routeKey(route)} must require a session in ${mode.name}`);
    }
  }
  for (const inventory of inventories) assert.deepEqual(inventory, inventories[0]);
  assert.ok(inventories[0].length >= 80);

  const texts = new Map();
  for (const file of await listSourceFiles(SOURCE_ROOT)) texts.set(relative(SOURCE_ROOT, file), await readFile(file, 'utf8'));
  const filesMatching = (pattern) => [...texts].filter(([, text]) => pattern.test(text)).map(([name]) => name);
  assert.deepEqual(filesMatching(/\.listen\(/), ['server.js'], 'server.js must stay the only listener');
  assert.deepEqual(filesMatching(/createServer|WebSocket|net\.connect|dgram/), []);
  assert.deepEqual(filesMatching(/0\.0\.0\.0|'::'|"::"/), []);
  assert.match(texts.get('server.js'), /\|\|\s*'127\.0\.0\.1'/, 'HOST must default to loopback');
  assert.deepEqual(filesMatching(/jwt\.verify\(/).sort(), ['middleware/auth.js', 'routes/visits.js']);
  assert.deepEqual(filesMatching(/cookie/i), []);
  // The two rollout switches are read in exactly the places that document them.
  assert.deepEqual(filesMatching(/CLARITY_SHADOW_COMPARE/).sort(), ['jobs/monthlyReview.js', 'rollout/featureFlags.js']);
  assert.deepEqual(filesMatching(/MONTHLY_REVIEW_CALCULATION_MODE/), ['jobs/monthlyReview.js']);
});

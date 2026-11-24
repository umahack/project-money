import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createIsolatedTestDatabase } from '../helpers/testDatabase.js';
import { buildSessionFixture, buildUserFixture } from '../helpers/fixtures.js';
import {
  BASELINE_MONTH,
  BASELINE_NOW_ISO,
  BASELINE_USER_ID,
  compareWithBaseline,
  fingerprintClaritySnapshot,
  loadBaselineFingerprint,
  seedClarityBaseline,
} from '../helpers/clarityBaseline.js';

/**
 * Characterization of the expense surface before Quick Add changes it
 * (spec: quick-add-daily-answer, task 1.1; requirements 16.4, 16.5, 16.6,
 * 17.28, 18.20, 18.22, 18.25).
 *
 * The assertions pin shapes, key sets, column lists, and fixed descriptions.
 * They use synthetic data only and never print or store account values. The
 * clarity baseline is compared by digest, so a failure names key paths only.
 *
 * When a later task intentionally changes one of these surfaces (for example
 * the added expense column or export table), it updates the matching constant
 * below in the same change.
 */

const PASSWORD = 'Characterization-123!';
const OWNER_ID = 8701;
const OWNER_SESSION_ID = 8801;
const DELETE_USER_ID = 8711;
const DELETE_SESSION_ID = 8811;

let testDatabase;
let db;
let app;
let accountDeletion;
let passwordHash;
let authorization;

function tokenFor(userId, sessionId) {
  return `Bearer ${jwt.sign(
    { sub: String(userId), tv: 1, sid: sessionId },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '5m' }
  )}`;
}

function localMonthAndDay(day) {
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  return { month, spentOn: `${month}-${String(day).padStart(2, '0')}` };
}

async function insertAccount({ id, sessionId, email, hash = null }) {
  const user = buildUserFixture({ id, email, ...(hash ? { password_hash: hash } : {}) });
  const session = buildSessionFixture({ userId: id, id: sessionId, ip_hash: `characterization-${sessionId}` });
  await db.prepare(
    `INSERT INTO users (id, email, name, password_hash, is_admin, token_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(user.id, user.email, user.name, user.password_hash, user.is_admin, user.token_version, user.created_at);
  await db.prepare(
    `INSERT INTO sessions
      (id, user_id, device_label, ip_hash, user_agent, created_at, last_seen_at, revoked_at, revoked_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    session.id, session.user_id, session.device_label, session.ip_hash, session.user_agent,
    session.created_at, session.last_seen_at, session.revoked_at, session.revoked_reason
  );
}

function contract(requestBuilder, key) {
  return requestBuilder
    .set('Authorization', authorization)
    .set('X-Clarity-Contract', '1')
    .set('Idempotency-Key', key);
}

function sortedKeys(value) {
  return Object.keys(value).sort();
}

async function tableColumns(table) {
  const rows = await db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.map((row) => row.name);
}

before(async () => {
  testDatabase = await createIsolatedTestDatabase();
  db = testDatabase.db;
  process.env.FINANCIAL_MUTATION_HMAC_KEY =
    'test-only-financial-mutation-hmac-key-32-bytes-minimum';
  passwordHash = await bcrypt.hash(PASSWORD, 4);
  const { createApp } = await import('../../src/app.js');
  app = createApp();
  accountDeletion = await import('../../src/db/accountDeletion.js');
});

beforeEach(async () => {
  await testDatabase.reset();
  await insertAccount({ id: OWNER_ID, sessionId: OWNER_SESSION_ID, email: 'characterization-owner@example.test' });
  await db.prepare(
    `INSERT INTO user_financial_state (user_id, data_use_notice_version, data_use_acknowledged_at)
     VALUES (?, 1, CURRENT_TIMESTAMP)`
  ).run(OWNER_ID);
  authorization = tokenFor(OWNER_ID, OWNER_SESSION_ID);
});

after(async () => {
  await testDatabase?.cleanup();
});

// ---------------------------------------------------------------------------
// Expense record shape: create, update, delete, and the legacy list
// ---------------------------------------------------------------------------

// Task 5.1 appended `exclude_from_daily_allowance` (nullable, no default) to the
// pre-feature column list. Every other column and its order is unchanged.
const EXPENSE_LOG_COLUMNS = [
  'id', 'user_id', 'month', 'category', 'amount', 'note', 'spent_on', 'created_at', 'updated_at',
  'exclude_from_daily_allowance',
];
const CONTRACT_RECORD_KEYS = [
  'amountMinor', 'category', 'excludeFromDailyAllowance', 'id', 'month', 'note', 'spentOn',
];
const LEGACY_EXPENSE_KEYS = ['amount', 'category', 'id', 'month', 'note', 'spent_on'];
const LEGACY_LIST_ROW_KEYS = ['amount', 'category', 'created_at', 'id', 'month', 'note', 'spent_on'];

test('the expense_log table has exactly the pre-feature columns plus the exclusion column', async () => {
  assert.deepEqual(await tableColumns('expense_log'), EXPENSE_LOG_COLUMNS);
});

test('contract create, update, and delete return the additive expense record shape', async () => {
  const { month, spentOn } = localMonthAndDay(1);
  await db.prepare('INSERT INTO salary_entries (user_id, month, amount) VALUES (?, ?, ?)').run(OWNER_ID, month, 10_000);

  const created = await contract(
    request(app).post('/api/finance/expenses'),
    '96000000-0000-4000-8000-000000000001'
  ).send({ amount: '10.50', category: 'Food', note: 'Shape check', spentOn, expectedRecordVersion: 0 });
  assert.equal(created.status, 200);
  assert.deepEqual(sortedKeys(created.body), ['clarity', 'id', 'month', 'mutation', 'schemaVersion']);
  assert.equal(created.body.schemaVersion, 1);
  assert.equal(typeof created.body.id, 'number');
  assert.equal(typeof created.body.month, 'string');
  assert.deepEqual(sortedKeys(created.body.mutation.record), CONTRACT_RECORD_KEYS);
  assert.deepEqual(
    Object.fromEntries(CONTRACT_RECORD_KEYS.map((key) => [key, typeof created.body.mutation.record[key]])),
    {
      amountMinor: 'number', category: 'string', excludeFromDailyAllowance: 'boolean', id: 'number',
      month: 'string', note: 'string', spentOn: 'string',
    }
  );
  const createdMutationKeys = sortedKeys(created.body.mutation);
  assert.ok(createdMutationKeys.includes('acceptedConstraints'));
  assert.deepEqual(sortedKeys(created.body.mutation.acceptedConstraints), [
    'amount', 'amountMinor', 'category', 'excludeFromDailyAllowance', 'expectedRecordVersion',
    'note', 'spentOn',
  ]);
  const expenseId = created.body.id;

  const updated = await contract(
    request(app).patch(`/api/finance/expenses/${expenseId}`),
    '96000000-0000-4000-8000-000000000002'
  ).send({ amount: '11.25', expectedRecordVersion: 1 });
  assert.equal(updated.status, 200);
  assert.deepEqual(sortedKeys(updated.body), [
    'clarity', 'expense', 'mutation', 'ok', 'schemaVersion',
  ]);
  assert.deepEqual(sortedKeys(updated.body.expense), LEGACY_EXPENSE_KEYS);
  assert.deepEqual(sortedKeys(updated.body.mutation.record), CONTRACT_RECORD_KEYS);
  assert.equal(updated.body.mutation.record.id, expenseId);
  assert.deepEqual(sortedKeys(updated.body.mutation), createdMutationKeys);

  const deleted = await contract(
    request(app).delete(`/api/finance/expenses/${expenseId}`),
    '96000000-0000-4000-8000-000000000003'
  ).send({ expectedRecordVersion: 2 });
  assert.equal(deleted.status, 200);
  assert.deepEqual(sortedKeys(deleted.body), ['clarity', 'mutation', 'ok', 'schemaVersion']);
  assert.equal(deleted.body.ok, true);
  assert.equal(deleted.body.mutation.record, null);
  assert.equal(deleted.body.mutation.status, 'reversed');
});

test('legacy create, list, and delete keep their pre-feature response shapes', async () => {
  const { month, spentOn } = localMonthAndDay(2);

  const created = await request(app)
    .post('/api/finance/expenses')
    .set('Authorization', authorization)
    .send({
      amount: 42.5,
      category: 'Food',
      note: 'Legacy shape',
      spentOn,
      excludeFromDailyAllowance: true,
    });
  assert.equal(created.status, 200);
  assert.deepEqual(sortedKeys(created.body), ['id', 'month']);
  assert.equal(created.body.month, month);
  const storedLegacy = await db.prepare(
    'SELECT exclude_from_daily_allowance FROM expense_log WHERE id = ? AND user_id = ?'
  ).get(created.body.id, OWNER_ID);
  assert.equal(storedLegacy.exclude_from_daily_allowance, null);

  const listed = await request(app)
    .get(`/api/finance/expenses?month=${month}`)
    .set('Authorization', authorization);
  assert.equal(listed.status, 200);
  assert.deepEqual(sortedKeys(listed.body), ['categories', 'expenses', 'month']);
  assert.equal(Array.isArray(listed.body.categories), true);
  assert.equal(listed.body.expenses.length, 1);
  assert.deepEqual(sortedKeys(listed.body.expenses[0]), LEGACY_LIST_ROW_KEYS);
  assert.deepEqual(
    Object.fromEntries(LEGACY_LIST_ROW_KEYS.map((key) => [key, typeof listed.body.expenses[0][key]])),
    {
      amount: 'number', category: 'string', created_at: 'string', id: 'number', month: 'string', note: 'string', spent_on: 'string',
    }
  );

  const removed = await request(app)
    .delete(`/api/finance/expenses/${created.body.id}`)
    .set('Authorization', authorization);
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body, { ok: true });
  const missing = await request(app)
    .delete(`/api/finance/expenses/${created.body.id}`)
    .set('Authorization', authorization);
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, { error: 'Not found' });
});

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

test('expense CSV keeps its first five columns, ordering, quoting, and formula guard and ends with the allowance column', async () => {
  await db.batch([
    [`INSERT INTO expense_log (user_id, month, category, amount, note, spent_on, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, [OWNER_ID, '2026-01', 'Food', 10, '=cmd', '2026-01-10', '2026-01-10 01:00:00']],
    [`INSERT INTO expense_log (user_id, month, category, amount, note, spent_on, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, [OWNER_ID, '2026-01', 'Bills', 20.5, 'plain', null, '2026-01-14 20:00:00']],
    [`INSERT INTO expense_log (user_id, month, category, amount, note, spent_on, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, [OWNER_ID, '2026-01', 'Other', 30, 'a, "b"', '2026-01-20', '2026-01-20 01:00:00']],
    [`INSERT INTO expense_log (user_id, month, category, amount, note, spent_on, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, [OWNER_ID, '2026-01', 'Other', 40, null, '2026-01-21', '2026-01-21 01:00:00']],
  ]);

  const response = await request(app)
    .get('/api/finance/export.csv')
    .set('Authorization', authorization);
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /^text\/csv; charset=utf-8/);
  assert.match(
    response.headers['content-disposition'],
    /^attachment; filename="project-money-expenses-\d{4}-\d{2}-\d{2}\.csv"$/
  );

  const lines = response.text.split('\n');
  // Task 5.6 appended `counted_in_daily_allowance`; the first five columns are unchanged.
  assert.equal(lines[0], 'date,month,category,amount,note,counted_in_daily_allowance');
  assert.equal(lines.at(-1), '', 'the file ends with one newline');
  assert.deepEqual(lines.slice(1, 5), [
    "2026-01-10,2026-01,Food,10,'=cmd,yes",
    '2026-01-15,2026-01,Bills,20.5,plain,yes',
    '2026-01-20,2026-01,Other,30,"a, ""b""",yes',
    '2026-01-21,2026-01,Other,40,,yes',
  ]);
  assert.equal(lines.length, 6);
});

// ---------------------------------------------------------------------------
// Account export: tables, descriptions, collections, expense columns
// ---------------------------------------------------------------------------

const EXPORT_TABLE_DESCRIPTIONS = Object.freeze({
  salary_entries: 'Confirmed take-home income records by applicable month.',
  emis: 'Confirmed bills and fixed obligations used by monthly plans.',
  expenses: 'Confirmed personal expenses, including expenses created from trip shares and whether each expense is counted in the daily allowance.',
  category_budgets: 'Personal expense-category budget settings.',
  recurring_expenses: 'Recurring personal expense definitions and materialization state.',
  savings_goals: 'Confirmed savings goals, progress, and target dates.',
  user_categories: 'Personal expense categories added by the account holder.',
  sessions: 'Device sessions, including revocation and last-seen state; network fingerprints are omitted.',
  trips_owned: 'Private trip records owned by the account, including public-sharing columns.',
  trips_shared: 'Private trip records the account can access through a linked membership.',
  trip_memberships: 'Trip-member rows linked directly to the account.',
  trip_members: 'Member rows for trips the account owns or can access.',
  trip_expenses: 'Shared expenses for trips the account owns or can access.',
  feedback: 'Feedback submitted while linked to the account.',
  user_financial_state: 'Financial data version, data-use acknowledgement, and Product Analytics consent state.',
  product_analytics_settings: 'A focused view of the Product Analytics consent setting and version.',
  guided_journeys: 'Guided Journey intent, progress, and completion state.',
  expense_category_treatments: 'Needs or Wants treatment choices for expense categories.',
  trip_expense_personal_links: 'Links between an allocated trip share and a confirmed personal expense.',
  financial_record_changes: 'Confirmed change receipts. The internal request-fingerprint HMAC is omitted.',
  public_sharing_settings: 'Public-link enabled state and token for each owned trip.',
  product_measurement_events: 'Consent-gated Product Analytics events linked to the account.',
  visits: 'Visit records that remain linked to the account.',
  category_memory: 'Remembered category choices used to suggest a category for notes you type in Quick Add.',
});

const EXPORT_DATA_COLLECTIONS = [
  'salary_entries', 'emis', 'expenses', 'category_budgets', 'recurring_expenses', 'savings_goals',
  'user_categories', 'sessions', 'trips_owned', 'trips_shared', 'trip_memberships', 'trip_members',
  'trip_expenses', 'feedback', 'user_financial_state', 'product_analytics_settings', 'guided_journeys',
  'expense_category_treatments', 'trip_expense_personal_links', 'financial_record_changes',
  'public_sharing_settings', 'product_measurement_events', 'visits', 'category_memory',
];

test('GET /api/auth/export keeps its table list, descriptions, collections, and expense columns', async () => {
  await db.prepare(
    `INSERT INTO expense_log (user_id, month, category, amount, note, spent_on)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(OWNER_ID, '2026-01', 'Food', 10, 'Export shape', '2026-01-10');

  const response = await request(app).get('/api/auth/export').set('Authorization', authorization);
  assert.equal(response.status, 200);
  assert.deepEqual(sortedKeys(response.body), ['data', 'exported_at', 'schema', 'user']);
  assert.deepEqual(sortedKeys(response.body.schema), ['account', 'description', 'tables', 'version']);
  assert.equal(response.body.schema.version, 1);
  assert.deepEqual(response.body.schema.tables, EXPORT_TABLE_DESCRIPTIONS);
  assert.deepEqual(sortedKeys(response.body.data), [...EXPORT_DATA_COLLECTIONS].sort());
  assert.equal(response.body.data.expenses.length, 1);
  assert.deepEqual(sortedKeys(response.body.data.expenses[0]), [...EXPENSE_LOG_COLUMNS].sort());
});

// ---------------------------------------------------------------------------
// Account deletion: statement list, descriptions, and probes
// ---------------------------------------------------------------------------

const DELETION_DESCRIPTIONS = Object.freeze({
  account_profile: 'Account profile and sign-in identity.',
  sessions: 'Device sessions for the account.',
  salary_entries: 'Confirmed monthly salary records.',
  emis: 'Confirmed bill and fixed-obligation records.',
  expense_log: 'Confirmed personal expenses, including linked trip expenses.',
  category_budgets: 'Personal expense-category budgets.',
  recurring_expenses: 'Recurring personal expense definitions.',
  savings_goals: 'Savings goals and their confirmed progress.',
  user_categories: 'Personal expense categories.',
  category_memory: 'Remembered category choices used to suggest categories in Quick Add.',
  user_aliases: 'Email aliases linked to the account.',
  trip_data: 'Owned trips, memberships, invitations, members, and shared expenses.',
  public_sharing_settings: 'Public links and sharing state for owned trips.',
  user_financial_state: 'Financial data version and Financial Clarity settings.',
  product_analytics_settings: 'The account Product Analytics consent setting and version.',
  guided_journeys: 'Guided Journey progress and completion state.',
  expense_category_treatments: 'Needs or Wants treatment choices for expense categories.',
  trip_expense_personal_links: 'Links between trip shares and personal expense records.',
  financial_record_changes: 'Confirmed financial change receipts.',
  product_measurement_events: 'User-linked Product Analytics events.',
  visits: 'User-linked visit records.',
  pending_account_requests: 'Pending email, registration, and password-reset requests.',
  feedback_link: 'The account link on retained feedback.',
  audit_link: 'The account link on retained security audit records.',
});

const DELETION_STATEMENT_TARGETS = [
  'DELETE product_measurement_events',
  'DELETE expense_log',
  'DELETE trip_expense_personal_links',
  'DELETE trip_expense_personal_links',
  'DELETE financial_record_changes',
  'DELETE expense_category_treatments',
  'DELETE guided_journeys',
  'DELETE user_financial_state',
  'DELETE trip_expenses',
  'DELETE trip_members',
  'DELETE trip_invites',
  'UPDATE trips',
  'DELETE trips',
  'DELETE salary_entries',
  'DELETE emis',
  'DELETE expense_log',
  'DELETE category_budgets',
  'DELETE recurring_expenses',
  'DELETE savings_goals',
  'DELETE category_memory',
  'DELETE user_categories',
  'DELETE user_aliases',
  'DELETE sessions',
  'DELETE pending_email_changes',
  'DELETE pending_registrations',
  'DELETE pending_password_resets',
  'UPDATE feedback',
  'UPDATE audit_log',
  'DELETE visits',
  'DELETE users',
];

async function seedEveryProbeCategory(userId, email) {
  const ids = { expense: userId + 1, trip: userId + 2, tripExpense: userId + 3, change: userId + 4, journey: userId + 5 };
  await db.batch([
    ['INSERT INTO salary_entries (user_id, month, amount) VALUES (?, ?, ?)', [userId, '2026-01', 100_000]],
    ['INSERT INTO emis (user_id, label, amount, category) VALUES (?, ?, ?, ?)', [userId, 'Rent', 20_000, 'Rent']],
    ['INSERT INTO expense_log (id, user_id, month, category, amount, note, spent_on) VALUES (?, ?, ?, ?, ?, ?, ?)', [ids.expense, userId, '2026-01', 'Travel', 25, 'Linked share', '2026-01-15']],
    ['INSERT INTO category_budgets (user_id, category, amount) VALUES (?, ?, ?)', [userId, 'Food', 10_000]],
    ['INSERT INTO recurring_expenses (user_id, label, amount, category, day_of_month) VALUES (?, ?, ?, ?, ?)', [userId, 'Subscription', 500, 'Bills', 1]],
    ['INSERT INTO savings_goals (user_id, name, target_amount, saved_amount, target_date) VALUES (?, ?, ?, ?, ?)', [userId, 'Goal', 200_000, 50_000, '2026-12-31']],
    ['INSERT INTO user_categories (user_id, name) VALUES (?, ?)', [userId, 'Family']],
    [`INSERT INTO category_memory (user_id, note_key, category, revision, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?)`, [userId, 'family dinner', 'Family', '2026-01-15T06:30:00.000Z', '2026-01-15T06:30:00.000Z']],
    ['INSERT INTO user_aliases (user_id, email) VALUES (?, ?)', [userId, `alias-${email}`]],
    ['INSERT INTO trips (id, user_id, name, budget, public_token, public_enabled) VALUES (?, ?, ?, ?, ?, 1)', [ids.trip, userId, 'Trip', 50_000, String(ids.trip).padStart(32, '0')]],
    ['INSERT INTO trip_members (trip_id, user_id, name, email) VALUES (?, ?, ?, ?)', [ids.trip, userId, 'Owner', email]],
    ['INSERT INTO trip_expenses (id, trip_id, payer, description, amount, split_json) VALUES (?, ?, ?, ?, ?, ?)', [ids.tripExpense, ids.trip, 'Owner', 'Cost', 25, '[{"name":"Owner","share":1}]']],
    [`INSERT INTO user_financial_state
       (user_id, data_version, data_use_notice_version, data_use_acknowledged_at,
        analytics_enabled, analytics_consent_version, analytics_changed_at)
      VALUES (?, 7, 2, CURRENT_TIMESTAMP, 1, 2, CURRENT_TIMESTAMP)`, [userId]],
    [`INSERT INTO guided_journeys
       (id, user_id, desired_outcome, status, current_step_key, started_session_id,
        measurement_eligible, measurement_consent_version)
      VALUES (?, ?, 'plan_month', 'active', 'salary', ?, 1, 2)`, [ids.journey, userId, DELETE_SESSION_ID]],
    ['INSERT INTO expense_category_treatments (user_id, category, treatment) VALUES (?, ?, ?)', [userId, 'Travel', 'wants']],
    [`INSERT INTO financial_record_changes
       (id, user_id, idempotency_key, request_fingerprint_hmac, operation, record_type, record_id, record_version, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'confirmed')`, [ids.change, userId, `characterization-${ids.change}`, 'test-only-hmac', 'trip.personal_link.include', 'expense', ids.expense]],
    [`INSERT INTO trip_expense_personal_links
       (user_id, trip_id, trip_expense_id, expense_log_id, included_amount_minor)
      VALUES (?, ?, ?, ?, ?)`, [userId, ids.trip, ids.tripExpense, ids.expense, 2_500]],
    [`INSERT INTO product_measurement_events
       (event_id, user_id, event_name, journey_id, change_id, consent_version, occurred_at, local_date, local_week_start)
      VALUES (?, ?, 'financial_change_ui', ?, ?, 2, ?, '2026-01-15', '2026-01-12')`, [`characterization-event-${userId}`, userId, ids.journey, ids.change, '2026-01-15T06:30:00.000Z']],
    ['INSERT INTO pending_email_changes (user_id, new_email, verify_code_hash, verify_expires_at) VALUES (?, ?, ?, ?)', [userId, `new-${email}`, 'test-hash', '2026-01-16T00:00:00.000Z']],
    ['INSERT INTO feedback (user_id, email, rating, message) VALUES (?, ?, ?, ?)', [userId, email, 5, 'Synthetic feedback']],
    ['INSERT INTO audit_log (actor_id, actor_email, action) VALUES (?, ?, ?)', [userId, email, 'test.characterization']],
    ['INSERT INTO visits (user_id, path, ip_hash, user_agent) VALUES (?, ?, ?, ?)', [userId, '/plan', 'test-visit-hash', 'CharacterizationTest/1.0']],
  ]);
}

test('account deletion keeps its descriptions, ordered statement targets, and probe list', async () => {
  assert.deepEqual(accountDeletion.ACCOUNT_DELETION_CATEGORY_DESCRIPTIONS, DELETION_DESCRIPTIONS);

  const statements = accountDeletion.buildAccountDeletionStatements({
    userId: DELETE_USER_ID,
    email: 'characterization-delete@example.test',
  });
  const targets = statements.map(([sql]) => {
    const match = /^\s*(DELETE FROM|UPDATE)\s+(\w+)/.exec(sql);
    assert.ok(match, 'every statement is a DELETE FROM or UPDATE');
    return `${match[1] === 'UPDATE' ? 'UPDATE' : 'DELETE'} ${match[2]}`;
  });
  assert.deepEqual(targets, DELETION_STATEMENT_TARGETS);

  const email = 'characterization-delete@example.test';
  await insertAccount({ id: DELETE_USER_ID, sessionId: DELETE_SESSION_ID, email, hash: passwordHash });
  await seedEveryProbeCategory(DELETE_USER_ID, email);
  const present = await accountDeletion.findUndeletedAccountRecordCategories({ userId: DELETE_USER_ID, email });
  assert.deepEqual(present.map((category) => category.key), Object.keys(DELETION_DESCRIPTIONS));
  for (const category of present) {
    assert.equal(category.description, DELETION_DESCRIPTIONS[category.key]);
  }
});

test('self-service account deletion removes every probed category and leaves other accounts alone', async () => {
  const email = 'characterization-delete@example.test';
  await insertAccount({ id: DELETE_USER_ID, sessionId: DELETE_SESSION_ID, email, hash: passwordHash });
  await seedEveryProbeCategory(DELETE_USER_ID, email);

  const response = await request(app)
    .delete('/api/auth/account')
    .set('Authorization', tokenFor(DELETE_USER_ID, DELETE_SESSION_ID))
    .send({ currentPassword: PASSWORD });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true });

  assert.deepEqual(
    await accountDeletion.findUndeletedAccountRecordCategories({ userId: DELETE_USER_ID, email }),
    []
  );
  const survivor = await db.prepare('SELECT COUNT(*) AS count FROM users WHERE id = ?').get(OWNER_ID);
  assert.equal(Number(survivor.count), 1);
});

// ---------------------------------------------------------------------------
// materializeRecurring: the exact columns it writes
// ---------------------------------------------------------------------------

test('materializeRecurring writes exactly user, month, category, amount, note, and spent_on', async () => {
  const { month, spentOn } = localMonthAndDay(1);
  await db.prepare(
    `INSERT INTO recurring_expenses (user_id, label, amount, category, day_of_month, active)
     VALUES (?, ?, ?, ?, ?, 1)`
  ).run(OWNER_ID, 'Characterized rent', 1_000, 'Bills', 1);

  const response = await request(app)
    .get(`/api/finance/expenses?month=${month}`)
    .set('Authorization', authorization);
  assert.equal(response.status, 200);
  assert.equal(response.body.expenses.length, 1);

  const rows = await db.prepare('SELECT * FROM expense_log WHERE user_id = ?').all(OWNER_ID);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.deepEqual(
    Object.entries(row).filter(([, value]) => value !== null).map(([key]) => key).sort(),
    // Task 9.1 adds the Allowance_Exclusion mark to the recurring insert; it is
    // the only column added to what materializeRecurring writes.
    ['amount', 'category', 'created_at', 'exclude_from_daily_allowance', 'id', 'month', 'note', 'spent_on', 'user_id']
  );
  assert.equal(Number(row.exclude_from_daily_allowance), 1);
  assert.equal(row.updated_at, null);
  assert.equal(row.month, month);
  assert.equal(row.category, 'Bills');
  assert.equal(Number(row.amount), 1_000);
  assert.equal(row.note, 'Characterized rent (recurring)');
  assert.equal(row.spent_on, spentOn);
  assert.deepEqual(await tableColumns('expense_log'), EXPENSE_LOG_COLUMNS);

  const definition = await db.prepare(
    'SELECT last_logged_month FROM recurring_expenses WHERE user_id = ?'
  ).get(OWNER_ID);
  assert.equal(definition.last_logged_month, month);

  // A second read claims nothing and posts nothing.
  await request(app).get(`/api/finance/expenses?month=${month}`).set('Authorization', authorization);
  const count = await db.prepare('SELECT COUNT(*) AS count FROM expense_log WHERE user_id = ?').get(OWNER_ID);
  assert.equal(Number(count.count), 1);
});

// ---------------------------------------------------------------------------
// Clarity snapshot baseline
// ---------------------------------------------------------------------------

test('every pre-feature clarity snapshot field remains byte-equal after adding todayAllowance', async () => {
  await seedClarityBaseline(db);
  const { default: clarityService } = await import('../../src/services/clarityService.js');
  const snapshot = await clarityService.getSnapshot({
    userId: BASELINE_USER_ID,
    month: BASELINE_MONTH,
    now: new Date(BASELINE_NOW_ISO),
  });
  const baseline = await loadBaselineFingerprint();
  assert.deepEqual(compareWithBaseline(
    fingerprintClaritySnapshot(snapshot),
    baseline,
    { ignoreOutcomes: ['todayAllowance'] }
  ), []);
});

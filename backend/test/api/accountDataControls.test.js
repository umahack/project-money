import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createIsolatedTestDatabase } from '../helpers/testDatabase.js';

const PASSWORD = 'Account-controls-123!';
const INTERNAL_HMAC = 'internal-hmac-must-not-be-exported';

let testDatabase;
let db;
let app;
let passwordHash;

before(async () => {
  testDatabase = await createIsolatedTestDatabase();
  db = testDatabase.db;
  passwordHash = await bcrypt.hash(PASSWORD, 4);
  const { createApp } = await import('../../src/app.js');
  app = createApp();
});

beforeEach(async () => {
  await testDatabase.reset();
});

after(async () => {
  await testDatabase?.cleanup();
});

async function insertUser({ id, email, isAdmin = 0 }) {
  await db.prepare(
    `INSERT INTO users
      (id, email, name, password_hash, is_admin, token_version)
     VALUES (?, ?, ?, ?, ?, 1)`
  ).run(id, email, `Account User ${id}`, passwordHash, isAdmin);
}

async function insertSession(userId, sessionId) {
  await db.prepare(
    `INSERT INTO sessions
      (id, user_id, device_label, ip_hash, user_agent)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    sessionId,
    userId,
    `Test device ${sessionId}`,
    `test-session-hash-${sessionId}`,
    'AccountControlsTest/1.0'
  );
}

function authorizationFor(userId, sessionId) {
  const token = jwt.sign(
    { sub: String(userId), tv: 1, sid: sessionId },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '5m' }
  );
  return `Bearer ${token}`;
}

async function seedAccountGraph(base, { isAdmin = 0 } = {}) {
  const graph = {
    userId: base + 1,
    peerId: base + 2,
    sessionId: base + 3,
    expenseId: base + 4,
    peerExpenseId: base + 5,
    tripId: base + 6,
    tripExpenseId: base + 7,
    peerTripExpenseId: base + 8,
    sharedTripId: base + 9,
    sharedTripExpenseId: base + 10,
    changeId: base + 11,
    journeyId: base + 12,
    feedbackId: base + 13,
    auditId: base + 14,
    visitId: base + 15,
    countedExpenseId: base + 16,
    email: `account-${base + 1}@example.test`,
    peerEmail: `account-${base + 2}@example.test`,
    publicToken: (base + 6).toString(16).padStart(32, '0'),
  };

  await insertUser({ id: graph.userId, email: graph.email, isAdmin });
  await insertUser({ id: graph.peerId, email: graph.peerEmail });
  await insertSession(graph.userId, graph.sessionId);

  await db.batch([
    ['INSERT INTO salary_entries (user_id, month, amount) VALUES (?, ?, ?)', [graph.userId, '2026-01', 100_000]],
    ['INSERT INTO emis (user_id, label, amount, category) VALUES (?, ?, ?, ?)', [graph.userId, 'Rent', 20_000, 'Rent']],
    ['INSERT INTO expense_log (id, user_id, month, category, amount, note, spent_on) VALUES (?, ?, ?, ?, ?, ?, ?)', [graph.expenseId, graph.userId, '2026-01', 'Travel', 25, 'Linked personal share', '2026-01-15']],
    ['INSERT INTO expense_log (id, user_id, month, category, amount, note, spent_on) VALUES (?, ?, ?, ?, ?, ?, ?)', [graph.peerExpenseId, graph.peerId, '2026-01', 'Travel', 15, 'Peer personal share', '2026-01-15']],
    ['INSERT INTO category_budgets (user_id, category, amount) VALUES (?, ?, ?)', [graph.userId, 'Food', 10_000]],
    ['INSERT INTO recurring_expenses (user_id, label, amount, category, day_of_month) VALUES (?, ?, ?, ?, ?)', [graph.userId, 'Subscription', 500, 'Bills', 1]],
    ['INSERT INTO savings_goals (user_id, name, target_amount, saved_amount, target_date) VALUES (?, ?, ?, ?, ?)', [graph.userId, 'Emergency fund', 200_000, 50_000, '2026-12-31']],
    ['INSERT INTO user_categories (user_id, name) VALUES (?, ?)', [graph.userId, 'Family']],
    ['INSERT INTO user_categories (user_id, name) VALUES (?, ?)', [graph.peerId, 'Family']],
    // The expense the account marked as not counted in the daily allowance, and one that is counted.
    ['UPDATE expense_log SET exclude_from_daily_allowance = 1 WHERE id = ?', [graph.expenseId]],
    ['INSERT INTO expense_log (id, user_id, month, category, amount, note, spent_on) VALUES (?, ?, ?, ?, ?, ?, ?)', [graph.countedExpenseId, graph.userId, '2026-01', 'Food', 12.5, 'Counted lunch', '2026-01-16']],
    // Remembered category choices: two for the account (one with a different letter case than the custom category),
    // two for the peer that must never reach the account's export or be touched by its deletion.
    [`INSERT INTO category_memory (user_id, note_key, category, revision, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?)`, [graph.userId, 'family dinner', 'Family', '2026-01-15T06:30:00.000Z', '2026-01-15T06:30:00.000Z']],
    [`INSERT INTO category_memory (user_id, note_key, category, revision, created_at, updated_at)
      VALUES (?, ?, ?, 2, ?, ?)`, [graph.userId, 'family trip', 'FAMILY', '2026-01-15T06:31:00.000Z', '2026-01-15T06:32:00.000Z']],
    [`INSERT INTO category_memory (user_id, note_key, category, revision, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?)`, [graph.userId, 'taxi to airport', 'Travel', '2026-01-15T06:33:00.000Z', '2026-01-15T06:33:00.000Z']],
    [`INSERT INTO category_memory (user_id, note_key, category, revision, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?)`, [graph.peerId, 'family dinner', 'Family', '2026-01-15T06:34:00.000Z', '2026-01-15T06:34:00.000Z']],
    [`INSERT INTO category_memory (user_id, note_key, category, revision, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?)`, [graph.peerId, 'peer private note', 'Travel', '2026-01-15T06:35:00.000Z', '2026-01-15T06:35:00.000Z']],
    ['INSERT INTO user_aliases (user_id, email) VALUES (?, ?)', [graph.userId, `alias-${graph.email}`]],
    ['INSERT INTO trips (id, user_id, name, budget, public_token, public_enabled) VALUES (?, ?, ?, ?, ?, 1)', [graph.tripId, graph.userId, 'Owned trip', 50_000, graph.publicToken]],
    ['INSERT INTO trip_members (trip_id, user_id, name, email) VALUES (?, ?, ?, ?)', [graph.tripId, graph.userId, 'Account owner', graph.email]],
    ['INSERT INTO trip_members (trip_id, user_id, name, email) VALUES (?, ?, ?, ?)', [graph.tripId, graph.peerId, 'Peer member', graph.peerEmail]],
    ['INSERT INTO trip_invites (trip_id, inviter_id, invitee_id, status) VALUES (?, ?, ?, ?)', [graph.tripId, graph.userId, graph.peerId, 'accepted']],
    ['INSERT INTO trip_expenses (id, trip_id, payer, description, amount, split_json) VALUES (?, ?, ?, ?, ?, ?)', [graph.tripExpenseId, graph.tripId, 'Account owner', 'Owner-linked cost', 25, '[{"name":"Account owner","share":1}]']],
    ['INSERT INTO trip_expenses (id, trip_id, payer, description, amount, split_json) VALUES (?, ?, ?, ?, ?, ?)', [graph.peerTripExpenseId, graph.tripId, 'Peer member', 'Peer-linked cost', 15, '[{"name":"Peer member","share":1}]']],
    ['INSERT INTO trips (id, user_id, name, budget) VALUES (?, ?, ?, ?)', [graph.sharedTripId, graph.peerId, 'Shared trip', 20_000]],
    ['INSERT INTO trip_members (trip_id, user_id, name, email) VALUES (?, ?, ?, ?)', [graph.sharedTripId, graph.userId, 'Shared account member', graph.email]],
    ['INSERT INTO trip_members (trip_id, user_id, name, email) VALUES (?, ?, ?, ?)', [graph.sharedTripId, graph.peerId, 'Shared trip owner', graph.peerEmail]],
    ['INSERT INTO trip_expenses (id, trip_id, payer, description, amount, split_json) VALUES (?, ?, ?, ?, ?, ?)', [graph.sharedTripExpenseId, graph.sharedTripId, 'Shared trip owner', 'Shared cost', 10, '[{"name":"Shared account member","share":1},{"name":"Shared trip owner","share":1}]']],
    [`INSERT INTO user_financial_state
       (user_id, data_version, data_use_notice_version, data_use_acknowledged_at,
        analytics_enabled, analytics_consent_version, analytics_changed_at)
      VALUES (?, 7, 2, CURRENT_TIMESTAMP, 1, 2, CURRENT_TIMESTAMP)`, [graph.userId]],
    [`INSERT INTO guided_journeys
       (id, user_id, desired_outcome, status, current_step_key, started_session_id,
        measurement_eligible, measurement_consent_version)
      VALUES (?, ?, 'plan_month', 'active', 'salary', ?, 1, 2)`, [graph.journeyId, graph.userId, graph.sessionId]],
    ['INSERT INTO expense_category_treatments (user_id, category, treatment) VALUES (?, ?, ?)', [graph.userId, 'Travel', 'wants']],
    [`INSERT INTO financial_record_changes
       (id, user_id, idempotency_key, request_fingerprint_hmac, operation,
        record_type, record_id, record_version, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'confirmed')`, [
      graph.changeId,
      graph.userId,
      `account-controls-${graph.changeId}`,
      INTERNAL_HMAC,
      'trip.personal_link.include',
      'expense',
      graph.expenseId,
    ]],
    [`INSERT INTO trip_expense_personal_links
       (user_id, trip_id, trip_expense_id, expense_log_id, included_amount_minor)
      VALUES (?, ?, ?, ?, ?)`, [graph.userId, graph.tripId, graph.tripExpenseId, graph.expenseId, 2_500]],
    [`INSERT INTO trip_expense_personal_links
       (user_id, trip_id, trip_expense_id, expense_log_id, included_amount_minor)
      VALUES (?, ?, ?, ?, ?)`, [graph.peerId, graph.tripId, graph.peerTripExpenseId, graph.peerExpenseId, 1_500]],
    [`INSERT INTO product_measurement_events
       (event_id, user_id, event_name, journey_id, change_id, consent_version,
        occurred_at, local_date, local_week_start)
      VALUES (?, ?, 'financial_change_ui', ?, ?, 2, ?, '2026-01-15', '2026-01-12')`, [
      `account-event-${graph.userId}`,
      graph.userId,
      graph.journeyId,
      graph.changeId,
      '2026-01-15T06:30:00.000Z',
    ]],
    ['INSERT INTO pending_email_changes (user_id, new_email, verify_code_hash, verify_expires_at) VALUES (?, ?, ?, ?)', [graph.userId, `new-${graph.email}`, 'test-hash', '2026-01-16T00:00:00.000Z']],
    ['INSERT INTO pending_registrations (email, name, password_hash, verify_code_hash, verify_expires_at) VALUES (?, ?, ?, ?, ?)', [graph.email, 'Pending account', passwordHash, 'test-hash', '2026-01-16T00:00:00.000Z']],
    ['INSERT INTO pending_password_resets (email, verify_code_hash, verify_expires_at) VALUES (?, ?, ?)', [graph.email, 'test-hash', '2026-01-16T00:00:00.000Z']],
    ['INSERT INTO feedback (id, user_id, email, rating, message) VALUES (?, ?, ?, ?, ?)', [graph.feedbackId, graph.userId, graph.email, 5, 'Synthetic account-control feedback']],
    ['INSERT INTO audit_log (id, actor_id, actor_email, action) VALUES (?, ?, ?, ?)', [graph.auditId, graph.userId, graph.email, 'test.account_controls']],
    ['INSERT INTO visits (id, user_id, path, ip_hash, user_agent) VALUES (?, ?, ?, ?, ?)', [graph.visitId, graph.userId, '/plan', 'test-visit-hash', 'AccountControlsTest/1.0']],
  ]);

  return graph;
}

async function assertEveryInScopeTableSeeded(graph) {
  const checks = [
    ['users', 'SELECT COUNT(*) AS count FROM users WHERE id = ?', [graph.userId]],
    ['sessions', 'SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?', [graph.userId]],
    ['salary_entries', 'SELECT COUNT(*) AS count FROM salary_entries WHERE user_id = ?', [graph.userId]],
    ['emis', 'SELECT COUNT(*) AS count FROM emis WHERE user_id = ?', [graph.userId]],
    ['expense_log', 'SELECT COUNT(*) AS count FROM expense_log WHERE user_id = ?', [graph.userId]],
    ['category_budgets', 'SELECT COUNT(*) AS count FROM category_budgets WHERE user_id = ?', [graph.userId]],
    ['recurring_expenses', 'SELECT COUNT(*) AS count FROM recurring_expenses WHERE user_id = ?', [graph.userId]],
    ['savings_goals', 'SELECT COUNT(*) AS count FROM savings_goals WHERE user_id = ?', [graph.userId]],
    ['user_categories', 'SELECT COUNT(*) AS count FROM user_categories WHERE user_id = ?', [graph.userId]],
    ['category_memory', 'SELECT COUNT(*) AS count FROM category_memory WHERE user_id = ?', [graph.userId]],
    ['user_aliases', 'SELECT COUNT(*) AS count FROM user_aliases WHERE user_id = ?', [graph.userId]],
    ['trips', 'SELECT COUNT(*) AS count FROM trips WHERE user_id = ?', [graph.userId]],
    ['trip_members', 'SELECT COUNT(*) AS count FROM trip_members WHERE user_id = ?', [graph.userId]],
    ['trip_invites', 'SELECT COUNT(*) AS count FROM trip_invites WHERE inviter_id = ? OR invitee_id = ?', [graph.userId, graph.userId]],
    ['trip_expenses', 'SELECT COUNT(*) AS count FROM trip_expenses WHERE trip_id = ?', [graph.tripId]],
    ['user_financial_state', 'SELECT COUNT(*) AS count FROM user_financial_state WHERE user_id = ?', [graph.userId]],
    ['guided_journeys', 'SELECT COUNT(*) AS count FROM guided_journeys WHERE user_id = ?', [graph.userId]],
    ['expense_category_treatments', 'SELECT COUNT(*) AS count FROM expense_category_treatments WHERE user_id = ?', [graph.userId]],
    ['trip_expense_personal_links', 'SELECT COUNT(*) AS count FROM trip_expense_personal_links WHERE user_id = ?', [graph.userId]],
    ['financial_record_changes', 'SELECT COUNT(*) AS count FROM financial_record_changes WHERE user_id = ?', [graph.userId]],
    ['product_measurement_events', 'SELECT COUNT(*) AS count FROM product_measurement_events WHERE user_id = ?', [graph.userId]],
    ['pending_email_changes', 'SELECT COUNT(*) AS count FROM pending_email_changes WHERE user_id = ?', [graph.userId]],
    ['pending_registrations', 'SELECT COUNT(*) AS count FROM pending_registrations WHERE email = ?', [graph.email]],
    ['pending_password_resets', 'SELECT COUNT(*) AS count FROM pending_password_resets WHERE email = ?', [graph.email]],
    ['feedback', 'SELECT COUNT(*) AS count FROM feedback WHERE user_id = ?', [graph.userId]],
    ['audit_log', 'SELECT COUNT(*) AS count FROM audit_log WHERE actor_id = ?', [graph.userId]],
    ['visits', 'SELECT COUNT(*) AS count FROM visits WHERE user_id = ?', [graph.userId]],
  ];

  for (const [table, sql, args] of checks) {
    const row = await db.prepare(sql).get(...args);
    assert.ok(Number(row.count) > 0, `${table} must contain an account-linked fixture row`);
  }
}

async function count(sql, ...args) {
  const row = await db.prepare(sql).get(...args);
  return Number(row.count);
}

async function deletionSnapshot(graph) {
  const [
    account,
    sessions,
    salary,
    bills,
    expenses,
    ownedTrips,
    memberships,
    financialState,
    journeys,
    treatments,
    personalLinks,
    changes,
    events,
    visits,
    pendingEmail,
    pendingRegistration,
    pendingReset,
    feedbackLink,
    auditLink,
    publicLink,
    peerExpense,
    peerTrip,
    categoryMemory,
    peerMemory,
  ] = await Promise.all([
    count('SELECT COUNT(*) AS count FROM users WHERE id = ?', graph.userId),
    count('SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?', graph.userId),
    count('SELECT COUNT(*) AS count FROM salary_entries WHERE user_id = ?', graph.userId),
    count('SELECT COUNT(*) AS count FROM emis WHERE user_id = ?', graph.userId),
    count('SELECT COUNT(*) AS count FROM expense_log WHERE user_id = ?', graph.userId),
    count('SELECT COUNT(*) AS count FROM trips WHERE user_id = ?', graph.userId),
    count('SELECT COUNT(*) AS count FROM trip_members WHERE user_id = ?', graph.userId),
    count('SELECT COUNT(*) AS count FROM user_financial_state WHERE user_id = ?', graph.userId),
    count('SELECT COUNT(*) AS count FROM guided_journeys WHERE user_id = ?', graph.userId),
    count('SELECT COUNT(*) AS count FROM expense_category_treatments WHERE user_id = ?', graph.userId),
    count('SELECT COUNT(*) AS count FROM trip_expense_personal_links WHERE user_id = ?', graph.userId),
    count('SELECT COUNT(*) AS count FROM financial_record_changes WHERE user_id = ?', graph.userId),
    count('SELECT COUNT(*) AS count FROM product_measurement_events WHERE user_id = ?', graph.userId),
    count('SELECT COUNT(*) AS count FROM visits WHERE user_id = ?', graph.userId),
    count('SELECT COUNT(*) AS count FROM pending_email_changes WHERE user_id = ?', graph.userId),
    count('SELECT COUNT(*) AS count FROM pending_registrations WHERE email = ?', graph.email),
    count('SELECT COUNT(*) AS count FROM pending_password_resets WHERE email = ?', graph.email),
    count('SELECT COUNT(*) AS count FROM feedback WHERE user_id = ?', graph.userId),
    count('SELECT COUNT(*) AS count FROM audit_log WHERE actor_id = ?', graph.userId),
    count('SELECT COUNT(*) AS count FROM trips WHERE public_token = ? AND public_enabled = 1', graph.publicToken),
    count('SELECT COUNT(*) AS count FROM expense_log WHERE id = ? AND user_id = ?', graph.peerExpenseId, graph.peerId),
    count('SELECT COUNT(*) AS count FROM trips WHERE id = ? AND user_id = ?', graph.sharedTripId, graph.peerId),
    count('SELECT COUNT(*) AS count FROM category_memory WHERE user_id = ?', graph.userId),
    count('SELECT COUNT(*) AS count FROM category_memory WHERE user_id = ?', graph.peerId),
  ]);

  return {
    account,
    sessions,
    salary,
    bills,
    expenses,
    ownedTrips,
    memberships,
    financialState,
    journeys,
    treatments,
    personalLinks,
    changes,
    events,
    visits,
    pendingEmail,
    pendingRegistration,
    pendingReset,
    feedbackLink,
    auditLink,
    publicLink,
    peerExpense,
    peerTrip,
    categoryMemory,
    peerMemory,
  };
}

function assertDeletedSnapshot(snapshot) {
  for (const [category, value] of Object.entries(snapshot)) {
    if (category === 'peerExpense' || category === 'peerTrip') {
      assert.equal(value, 1, `${category} must be preserved`);
    } else if (category === 'peerMemory') {
      assert.equal(value, 2, `${category} must be preserved`);
    } else {
      assert.equal(value, 0, `${category} must be removed or unlinked`);
    }
  }
}

function failureShape(body) {
  return {
    error: body.error,
    code: body.code,
    status: body.status,
    undeleted_record_categories: body.undeleted_record_categories,
    support: body.support,
  };
}

test('authenticated export covers every Financial Clarity record and omits the HMAC fingerprint', async () => {
  const graph = await seedAccountGraph(30_000);
  await assertEveryInScopeTableSeeded(graph);
  const response = await request(app)
    .get('/api/auth/export')
    .set('Authorization', authorizationFor(graph.userId, graph.sessionId));

  assert.equal(response.status, 200);
  assert.equal(response.body.schema.version, 1);
  assert.match(response.body.schema.description, /confirmed source records/i);

  const requiredCollections = [
    'salary_entries',
    'emis',
    'expenses',
    'category_budgets',
    'recurring_expenses',
    'savings_goals',
    'user_categories',
    'sessions',
    'trips_owned',
    'trips_shared',
    'trip_memberships',
    'trip_members',
    'trip_expenses',
    'feedback',
    'user_financial_state',
    'product_analytics_settings',
    'guided_journeys',
    'expense_category_treatments',
    'trip_expense_personal_links',
    'financial_record_changes',
    'public_sharing_settings',
    'product_measurement_events',
    'visits',
    'category_memory',
  ];

  for (const collection of requiredCollections) {
    assert.equal(Array.isArray(response.body.data[collection]), true, collection);
    assert.ok(response.body.data[collection].length > 0, collection);
    assert.equal(typeof response.body.schema.tables[collection], 'string', collection);
    assert.ok(response.body.schema.tables[collection].length > 10, collection);
  }

  assert.equal(response.body.data.user_financial_state[0].analytics_enabled, 1);
  assert.equal(response.body.data.product_analytics_settings[0].analytics_enabled, 1);
  assert.equal(response.body.data.public_sharing_settings[0].public_token, graph.publicToken);
  assert.equal(response.body.data.product_measurement_events[0].user_id, graph.userId);
  assert.equal(response.body.data.visits[0].user_id, graph.userId);
  assert.equal(
    Object.hasOwn(response.body.data.financial_record_changes[0], 'request_fingerprint_hmac'),
    false
  );
  assert.equal(JSON.stringify(response.body).includes(INTERNAL_HMAC), false);
});

test('export describes and carries category memory and the exclusion without another account\'s rows', async () => {
  const graph = await seedAccountGraph(30_500);
  const response = await request(app)
    .get('/api/auth/export')
    .set('Authorization', authorizationFor(graph.userId, graph.sessionId));

  assert.equal(response.status, 200);
  assert.equal(
    response.body.schema.tables.category_memory,
    'Remembered category choices used to suggest a category for notes you type in Quick Add.'
  );
  assert.match(response.body.schema.tables.expenses, /counted in the daily allowance/);

  const memory = response.body.data.category_memory;
  assert.deepEqual(
    memory.map((entry) => [entry.note_key, entry.category, entry.revision]).sort(),
    [['family dinner', 'Family', 1], ['family trip', 'FAMILY', 2], ['taxi to airport', 'Travel', 1]]
  );
  for (const entry of memory) {
    assert.deepEqual(
      Object.keys(entry).sort(),
      ['category', 'created_at', 'id', 'note_key', 'revision', 'updated_at']
    );
  }
  assert.equal(JSON.stringify(response.body).includes('peer private note'), false);

  const marks = Object.fromEntries(
    response.body.data.expenses.map((expense) => [expense.id, expense.exclude_from_daily_allowance])
  );
  assert.equal(marks[graph.expenseId], 1);
  assert.equal(marks[graph.countedExpenseId], null);
});

test('an empty category memory exports as an empty described collection', async () => {
  const graph = await seedAccountGraph(30_700);
  await db.prepare('DELETE FROM category_memory WHERE user_id = ?').run(graph.userId);
  const response = await request(app)
    .get('/api/auth/export')
    .set('Authorization', authorizationFor(graph.userId, graph.sessionId));

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.data.category_memory, []);
  assert.equal(typeof response.body.schema.tables.category_memory, 'string');
});

test('CSV export ends with counted_in_daily_allowance and keeps the first five columns and the formula guard', async () => {
  const graph = await seedAccountGraph(30_800);
  await db.batch([
    ['UPDATE expense_log SET note = ? WHERE id = ?', ['=marked, "quoted"', graph.expenseId]],
    [`INSERT INTO expense_log (user_id, month, category, amount, note, spent_on, exclude_from_daily_allowance)
      VALUES (?, ?, ?, ?, ?, ?, 0)`, [graph.userId, '2026-01', 'Other', 7, 'stored zero', '2026-01-17']],
  ]);

  const response = await request(app)
    .get('/api/finance/export.csv')
    .set('Authorization', authorizationFor(graph.userId, graph.sessionId));

  assert.equal(response.status, 200);
  const lines = response.text.split('\n');
  assert.equal(lines[0], 'date,month,category,amount,note,counted_in_daily_allowance');
  assert.equal(lines.at(-1), '');
  assert.deepEqual(lines.slice(1, -1), [
    '2026-01-15,2026-01,Travel,25,"\'=marked, ""quoted""",no',
    '2026-01-16,2026-01,Food,12.5,Counted lunch,yes',
    '2026-01-17,2026-01,Other,7,stored zero,yes',
  ]);
  assert.equal(response.text.includes('Peer personal share'), false);
});

test('export failure reports category memory when only that table is unreadable', async () => {
  const graph = await seedAccountGraph(30_900);
  const before = await deletionSnapshot(graph);

  await db.prepare('ALTER TABLE category_memory RENAME TO unavailable_category_memory').run();
  let response;
  try {
    response = await request(app)
      .get('/api/auth/export')
      .set('Authorization', authorizationFor(graph.userId, graph.sessionId));
  } finally {
    await db.prepare('ALTER TABLE unavailable_category_memory RENAME TO category_memory').run();
  }

  assert.equal(response.status, 500);
  assert.equal(response.body.code, 'EXPORT_FAILED');
  assert.deepEqual(response.body.failed_record_categories, [{
    key: 'category_memory',
    description: 'Remembered category choices used to suggest a category for notes you type in Quick Add.',
  }]);
  assert.equal(response.body.retry.path, '/api/auth/export');
  assert.deepEqual(await deletionSnapshot(graph), before);
});

test('export failure is structured, retryable, and leaves account records unchanged', async () => {
  const graph = await seedAccountGraph(31_000);
  const before = await deletionSnapshot(graph);

  await db.prepare(
    'ALTER TABLE product_measurement_events RENAME TO unavailable_product_measurement_events'
  ).run();
  let response;
  try {
    response = await request(app)
      .get('/api/auth/export')
      .set('Authorization', authorizationFor(graph.userId, graph.sessionId));
  } finally {
    await db.prepare(
      'ALTER TABLE unavailable_product_measurement_events RENAME TO product_measurement_events'
    ).run();
  }

  assert.equal(response.status, 500);
  assert.deepEqual(response.body, {
    error: 'Account export was unsuccessful. Your records are unchanged.',
    code: 'EXPORT_FAILED',
    status: 'unsuccessful',
    failed_record_categories: [{
      key: 'product_measurement_events',
      description: 'Consent-gated Product Analytics events linked to the account.',
    }],
    retry: { method: 'GET', path: '/api/auth/export' },
    support: {
      email: 'hello@project-money.online',
      path: 'mailto:hello@project-money.online',
    },
  });
  assert.deepEqual(await deletionSnapshot(graph), before);
});

test('self-service and admin deletion use the same complete transactional scope', async () => {
  const selfGraph = await seedAccountGraph(32_000);
  const adminId = 33_001;
  const adminSessionId = 33_002;
  await insertUser({ id: adminId, email: 'admin-delete@example.test', isAdmin: 1 });
  await insertSession(adminId, adminSessionId);
  const adminGraph = await seedAccountGraph(34_000);

  const selfResponse = await request(app)
    .delete('/api/auth/account')
    .set('Authorization', authorizationFor(selfGraph.userId, selfGraph.sessionId))
    .send({ currentPassword: PASSWORD });
  const adminResponse = await request(app)
    .delete(`/api/admin/users/${adminGraph.userId}`)
    .set('Authorization', authorizationFor(adminId, adminSessionId));

  assert.equal(selfResponse.status, 200);
  assert.deepEqual(selfResponse.body, { ok: true });
  assert.equal(adminResponse.status, 200);
  assert.deepEqual(adminResponse.body, { ok: true });

  assertDeletedSnapshot(await deletionSnapshot(selfGraph));
  assertDeletedSnapshot(await deletionSnapshot(adminGraph));

  for (const graph of [selfGraph, adminGraph]) {
    const publicResponse = await request(app).get(`/api/public/trips/${graph.publicToken}`);
    assert.equal(publicResponse.status, 404);
  }
});

const DELETION_FAILURE_GROUPS = Object.freeze([
  {
    name: 'Product Analytics events',
    trigger: `CREATE TRIGGER reject_account_dependency_group
      BEFORE DELETE ON product_measurement_events
      BEGIN SELECT RAISE(ABORT, 'injected Product Analytics deletion failure'); END`,
  },
  {
    name: 'trip personal links',
    trigger: `CREATE TRIGGER reject_account_dependency_group
      BEFORE DELETE ON trip_expense_personal_links
      BEGIN SELECT RAISE(ABORT, 'injected personal-link deletion failure'); END`,
  },
  {
    name: 'financial change receipts',
    trigger: `CREATE TRIGGER reject_account_dependency_group
      BEFORE DELETE ON financial_record_changes
      BEGIN SELECT RAISE(ABORT, 'injected financial-change deletion failure'); END`,
  },
  {
    name: 'Financial Clarity settings',
    trigger: `CREATE TRIGGER reject_account_dependency_group
      BEFORE DELETE ON user_financial_state
      BEGIN SELECT RAISE(ABORT, 'injected clarity-settings deletion failure'); END`,
  },
  {
    name: 'trip dependent records',
    trigger: `CREATE TRIGGER reject_account_dependency_group
      BEFORE DELETE ON trip_expenses
      BEGIN SELECT RAISE(ABORT, 'injected trip deletion failure'); END`,
  },
  {
    name: 'public-sharing revocation',
    trigger: `CREATE TRIGGER reject_account_dependency_group
      BEFORE UPDATE OF public_token, public_enabled ON trips
      BEGIN SELECT RAISE(ABORT, 'injected public-sharing revocation failure'); END`,
  },
  {
    name: 'core financial records',
    trigger: `CREATE TRIGGER reject_account_dependency_group
      BEFORE DELETE ON salary_entries
      BEGIN SELECT RAISE(ABORT, 'injected salary deletion failure'); END`,
  },
  {
    name: 'category memory',
    trigger: `CREATE TRIGGER reject_account_dependency_group
      BEFORE DELETE ON category_memory
      BEGIN SELECT RAISE(ABORT, 'injected category-memory deletion failure'); END`,
    reportedCategory: 'category_memory',
  },
  {
    name: 'device sessions',
    trigger: `CREATE TRIGGER reject_account_dependency_group
      BEFORE DELETE ON sessions
      BEGIN SELECT RAISE(ABORT, 'injected session deletion failure'); END`,
  },
  {
    name: 'pending account requests',
    trigger: `CREATE TRIGGER reject_account_dependency_group
      BEFORE DELETE ON pending_email_changes
      BEGIN SELECT RAISE(ABORT, 'injected pending-request deletion failure'); END`,
  },
  {
    name: 'retained feedback links',
    trigger: `CREATE TRIGGER reject_account_dependency_group
      BEFORE UPDATE OF user_id ON feedback
      BEGIN SELECT RAISE(ABORT, 'injected feedback-unlink failure'); END`,
  },
  {
    name: 'user-linked visits',
    trigger: `CREATE TRIGGER reject_account_dependency_group
      BEFORE DELETE ON visits
      BEGIN SELECT RAISE(ABORT, 'injected visit deletion failure'); END`,
  },
  {
    name: 'account profile',
    trigger: `CREATE TRIGGER reject_account_dependency_group
      BEFORE DELETE ON users
      BEGIN SELECT RAISE(ABORT, 'injected account-profile deletion failure'); END`,
  },
]);

test('self-service and admin deletion failures stay aligned at every dependency group', async (t) => {
  const adminId = 39_001;
  const adminSessionId = 39_002;

  for (const [index, failureGroup] of DELETION_FAILURE_GROUPS.entries()) {
    await t.test(failureGroup.name, async () => {
      // The file-level beforeEach reset also runs before every subtest, so the
      // admin identity must be created inside the subtest rather than the parent.
      await insertUser({ id: adminId, email: 'admin-rollback@example.test', isAdmin: 1 });
      await insertSession(adminId, adminSessionId);
      const base = 40_000 + index * 1_000;
      const selfGraph = await seedAccountGraph(base);
      const adminGraph = await seedAccountGraph(base + 400);
      const selfBefore = await deletionSnapshot(selfGraph);
      const adminBefore = await deletionSnapshot(adminGraph);

      await db.prepare(failureGroup.trigger).run();
      let selfResponse;
      let adminResponse;
      try {
        selfResponse = await request(app)
          .delete('/api/auth/account')
          .set('Authorization', authorizationFor(selfGraph.userId, selfGraph.sessionId))
          .send({ currentPassword: PASSWORD });
        adminResponse = await request(app)
          .delete(`/api/admin/users/${adminGraph.userId}`)
          .set('Authorization', authorizationFor(adminId, adminSessionId));
      } finally {
        await db.prepare('DROP TRIGGER reject_account_dependency_group').run();
      }

      assert.equal(selfResponse.status, 500);
      assert.equal(adminResponse.status, 500);
      assert.deepEqual(failureShape(selfResponse.body), failureShape(adminResponse.body));
      assert.equal(selfResponse.body.code, 'ACCOUNT_DELETION_INCOMPLETE');
      assert.equal(selfResponse.body.status, 'incomplete');
      assert.equal(selfResponse.body.retry.path, '/api/auth/account');
      assert.equal(adminResponse.body.retry.path, `/api/admin/users/${adminGraph.userId}`);
      assert.ok(selfResponse.body.undeleted_record_categories.length > 0);
      for (const category of selfResponse.body.undeleted_record_categories) {
        assert.equal(typeof category.key, 'string');
        assert.ok(category.description.length > 10, category.key);
      }
      if (failureGroup.reportedCategory) {
        for (const body of [selfResponse.body, adminResponse.body]) {
          const reported = body.undeleted_record_categories.find(
            (category) => category.key === failureGroup.reportedCategory
          );
          assert.ok(reported, `${failureGroup.reportedCategory} must be reported as undeleted`);
          assert.equal(
            reported.description,
            'Remembered category choices used to suggest categories in Quick Add.'
          );
        }
      }

      assert.deepEqual(await deletionSnapshot(selfGraph), selfBefore);
      assert.deepEqual(await deletionSnapshot(adminGraph), adminBefore);

      for (const graph of [selfGraph, adminGraph]) {
        const publicResponse = await request(app).get(`/api/public/trips/${graph.publicToken}`);
        assert.equal(publicResponse.status, 200, 'public link must survive a rolled-back deletion');
      }
    });
  }
});

async function memoryRows(userId) {
  const rows = await db.prepare(
    'SELECT note_key, category FROM category_memory WHERE user_id = ? ORDER BY note_key'
  ).all(userId);
  return rows.map((row) => [row.note_key, row.category]);
}

async function customCategoryId(userId, name) {
  const row = await db.prepare('SELECT id FROM user_categories WHERE user_id = ? AND name = ?').get(userId, name);
  return Number(row.id);
}

test('deleting a custom category removes only that category\'s memory for that account', async () => {
  const graph = await seedAccountGraph(60_000);
  const familyId = await customCategoryId(graph.userId, 'Family');
  const peerFamilyId = await customCategoryId(graph.peerId, 'Family');
  const expensesBefore = await count('SELECT COUNT(*) AS count FROM expense_log WHERE user_id = ?', graph.userId);

  const response = await request(app)
    .delete(`/api/finance/categories/${familyId}`)
    .set('Authorization', authorizationFor(graph.userId, graph.sessionId));

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true });
  assert.equal(await count('SELECT COUNT(*) AS count FROM user_categories WHERE id = ?', familyId), 0);
  // Both letter cases of the removed category are gone. The built-in Travel choice stays.
  assert.deepEqual(await memoryRows(graph.userId), [['taxi to airport', 'Travel']]);
  // The peer's category with the same name, and the peer's memory, are untouched.
  assert.equal(await count('SELECT COUNT(*) AS count FROM user_categories WHERE id = ?', peerFamilyId), 1);
  assert.deepEqual(await memoryRows(graph.peerId), [
    ['family dinner', 'Family'],
    ['peer private note', 'Travel'],
  ]);
  assert.equal(
    await count('SELECT COUNT(*) AS count FROM expense_log WHERE user_id = ?', graph.userId),
    expensesBefore
  );
});

test('deleting a category the account does not own answers 404 and removes no memory', async () => {
  const graph = await seedAccountGraph(61_000);
  const peerFamilyId = await customCategoryId(graph.peerId, 'Family');
  const memoryBefore = await memoryRows(graph.peerId);

  const foreign = await request(app)
    .delete(`/api/finance/categories/${peerFamilyId}`)
    .set('Authorization', authorizationFor(graph.userId, graph.sessionId));
  const missing = await request(app)
    .delete('/api/finance/categories/999999')
    .set('Authorization', authorizationFor(graph.userId, graph.sessionId));

  assert.equal(foreign.status, 404);
  assert.deepEqual(foreign.body, { error: 'Not found' });
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, { error: 'Not found' });
  assert.deepEqual(await memoryRows(graph.peerId), memoryBefore);
  assert.equal(await count('SELECT COUNT(*) AS count FROM user_categories WHERE id = ?', peerFamilyId), 1);
  assert.equal((await memoryRows(graph.userId)).length, 3);
});

test('a failed memory delete keeps the custom category and its memory together', async () => {
  const graph = await seedAccountGraph(62_000);
  const familyId = await customCategoryId(graph.userId, 'Family');
  const memoryBefore = await memoryRows(graph.userId);

  await db.prepare(
    `CREATE TRIGGER reject_category_memory_delete
       BEFORE DELETE ON category_memory
       BEGIN SELECT RAISE(ABORT, 'injected category-memory deletion failure'); END`
  ).run();
  let response;
  try {
    response = await request(app)
      .delete(`/api/finance/categories/${familyId}`)
      .set('Authorization', authorizationFor(graph.userId, graph.sessionId));
  } finally {
    await db.prepare('DROP TRIGGER reject_category_memory_delete').run();
  }

  assert.equal(response.status, 500);
  assert.equal(await count('SELECT COUNT(*) AS count FROM user_categories WHERE id = ?', familyId), 1);
  assert.deepEqual(await memoryRows(graph.userId), memoryBefore);
});

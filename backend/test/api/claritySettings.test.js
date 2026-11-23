import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createIsolatedTestDatabase } from '../helpers/testDatabase.js';
import { buildSessionFixture, buildUserFixture } from '../helpers/fixtures.js';

const OWNER_ID = 11_001;
const OTHER_USER_ID = 11_002;
const OWNER_SESSION_ID = 11_101;
const REVOKED_SESSION_ID = 11_102;
const OTHER_SESSION_ID = 11_103;

let testDatabase;
let db;
let app;
let owner;
let ownerAuthorization;
let revokedAuthorization;

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

function currentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

before(async () => {
  testDatabase = await createIsolatedTestDatabase();
  db = testDatabase.db;
  process.env.FINANCIAL_MUTATION_HMAC_KEY =
    'test-only-clarity-settings-hmac-key-32-bytes-minimum';
  const { createApp } = await import('../../src/app.js');
  app = createApp();
});

beforeEach(async () => {
  await testDatabase.reset();
  process.env.QUICK_ADD_ENABLED = 'false';
  owner = buildUserFixture({ id: OWNER_ID, email: 'settings-owner@example.test' });
  const other = buildUserFixture({ id: OTHER_USER_ID, email: 'settings-other@example.test' });
  const ownerSession = buildSessionFixture({ id: OWNER_SESSION_ID, userId: OWNER_ID });
  const revokedSession = buildSessionFixture({
    id: REVOKED_SESSION_ID,
    userId: OWNER_ID,
    revoked_at: '2026-01-15T07:00:00.000Z',
    revoked_reason: 'logout',
  });
  const otherSession = buildSessionFixture({ id: OTHER_SESSION_ID, userId: OTHER_USER_ID });

  await insertAccount(owner, ownerSession);
  await insertAccount(other, otherSession);
  await db.prepare(
    `INSERT INTO sessions
      (id, user_id, device_label, ip_hash, user_agent, created_at, last_seen_at,
       revoked_at, revoked_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    revokedSession.id,
    revokedSession.user_id,
    revokedSession.device_label,
    revokedSession.ip_hash,
    revokedSession.user_agent,
    revokedSession.created_at,
    revokedSession.last_seen_at,
    revokedSession.revoked_at,
    revokedSession.revoked_reason
  );

  ownerAuthorization = `Bearer ${tokenFor(owner, ownerSession)}`;
  revokedAuthorization = `Bearer ${tokenFor(owner, revokedSession)}`;
});

afterEach(async () => {
  process.env.QUICK_ADD_ENABLED = 'false';
  await new Promise((resolve) => setImmediate(resolve));
});

after(async () => {
  await testDatabase?.cleanup();
});

test('settings reads and updates require a live authenticated session', async () => {
  const missingRead = await request(app).get('/api/clarity/settings');
  assert.equal(missingRead.status, 401);
  assert.deepEqual(missingRead.body, { error: 'Missing token' });

  const missingUpdate = await request(app)
    .patch('/api/clarity/settings')
    .send({ analyticsEnabled: false });
  assert.equal(missingUpdate.status, 401);

  const revoked = await request(app)
    .get('/api/clarity/settings')
    .set('Authorization', revokedAuthorization);
  assert.equal(revoked.status, 401);
  assert.equal(revoked.body.code, 'SESSION_REVOKED');
});

test('settings read returns the versioned notice, configured time zone, and disabled analytics default', async () => {
  const response = await request(app)
    .get('/api/clarity/settings')
    .set('Authorization', ownerAuthorization);

  assert.equal(response.status, 200);
  assert.equal(response.body.schemaVersion, 1);
  assert.deepEqual(response.body.schemaVersions, {
    settings: 1,
    dataUseNotice: 1,
    productAnalyticsConsent: 1,
  });
  assert.equal(response.body.timeZone, 'Asia/Kolkata');
  assert.equal(response.body.dataUseNotice.version, 1);
  assert.equal(response.body.dataUseNotice.acknowledgedVersion, 0);
  assert.equal(response.body.dataUseNotice.acknowledgedAt, null);
  assert.equal(response.body.dataUseNotice.acknowledgementRequired, true);
  assert.deepEqual(
    response.body.dataUseNotice.categories.map(({ key }) => key),
    [
      'salary',
      'bills',
      'expenses',
      'goals',
      'trips',
      'journey_state',
      'change_receipts',
      'sharing_settings',
      'product_analytics',
    ]
  );
  const versionOneExpenses = response.body.dataUseNotice.categories.find(
    ({ key }) => key === 'expenses'
  );
  assert.deepEqual(versionOneExpenses.purposes, [
    'calculate and explain category spending and remaining monthly capacity',
  ]);
  assert.deepEqual(versionOneExpenses.outcomes, [
    'category_total',
    'remaining_spendable_budget',
    'daily_spending_guide',
    'projected_savings',
  ]);
  assert.equal(response.body.dataUseNotice.sharingDefaults.financialData, 'private');
  assert.equal(response.body.dataUseNotice.sharingDefaults.publicTripLinks, 'disabled');
  assert.equal(response.body.dataUseNotice.controls.correction.available, true);
  assert.equal(response.body.dataUseNotice.controls.export.path, '/api/auth/export');
  assert.equal(response.body.dataUseNotice.controls.deletion.path, '/api/auth/account');
  assert.equal(response.body.dataUseNotice.controls.productAnalytics.enabledByDefault, false);
  assert.deepEqual(response.body.productAnalytics, {
    available: true,
    enabledByDefault: false,
    enabled: false,
    consentVersion: null,
    changedAt: null,
  });

  const stateCount = await db.prepare(
    'SELECT COUNT(*) AS count FROM user_financial_state WHERE user_id = ?'
  ).get(OWNER_ID);
  assert.equal(Number(stateCount.count), 0, 'a read must not create consent state');
});

test('settings read returns notice version 2 with fixed category-memory and daily-allowance uses when enabled', async () => {
  process.env.QUICK_ADD_ENABLED = 'TrUe';

  const response = await request(app)
    .get('/api/clarity/settings')
    .set('Authorization', ownerAuthorization);

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.schemaVersions, {
    settings: 1,
    dataUseNotice: 2,
    productAnalyticsConsent: 1,
  });
  assert.equal(response.body.dataUseNotice.version, 2);
  assert.equal(response.body.dataUseNotice.acknowledgementRequired, true);
  assert.deepEqual(
    response.body.dataUseNotice.categories.map(({ key }) => key),
    [
      'salary',
      'bills',
      'expenses',
      'goals',
      'trips',
      'journey_state',
      'change_receipts',
      'sharing_settings',
      'product_analytics',
      'category_memory',
    ]
  );

  const expenses = response.body.dataUseNotice.categories.find(({ key }) => key === 'expenses');
  assert.deepEqual(expenses.purposes, [
    'calculate and explain category spending and remaining monthly capacity',
    'calculate and explain today\'s spending allowance, including whether an expense is counted against it',
  ]);
  assert.deepEqual(expenses.outcomes, [
    'category_total',
    'remaining_spendable_budget',
    'daily_spending_guide',
    'projected_savings',
    'today_allowance',
  ]);

  const categoryMemory = response.body.dataUseNotice.categories.at(-1);
  assert.deepEqual(categoryMemory, {
    key: 'category_memory',
    purposes: ['suggest a category for notes you have typed before'],
    outcomes: ['category_suggestion'],
    accessRoles: [
      'account_user',
      'authorized_administrators',
      'service_operators_and_processors',
    ],
    sharing: 'private',
    retention: 'until_account_deletion',
    controls: ['view', 'delete_one', 'delete_all', 'export', 'account_deletion'],
  });
});

test('settings updates accept only fixed writable fields and reject future acknowledgements', async () => {
  const unknown = await request(app)
    .patch('/api/clarity/settings')
    .set('Authorization', ownerAuthorization)
    .send({ analyticsEnabled: false, timeZone: 'UTC' });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error.code, 'UNKNOWN_SETTINGS_FIELD');
  assert.equal(unknown.body.error.field, 'timeZone');
  assert.deepEqual(unknown.body.error.allowedFields, [
    'acknowledgedNoticeVersion',
    'analyticsEnabled',
  ]);

  const clientTimestamp = await request(app)
    .patch('/api/clarity/settings')
    .set('Authorization', ownerAuthorization)
    .send({ acknowledgedNoticeVersion: 1, acknowledgedAt: '2099-01-01T00:00:00.000Z' });
  assert.equal(clientTimestamp.status, 400);
  assert.equal(clientTimestamp.body.error.code, 'UNKNOWN_SETTINGS_FIELD');
  assert.equal(clientTimestamp.body.error.field, 'acknowledgedAt');

  const futureVersion = await request(app)
    .patch('/api/clarity/settings')
    .set('Authorization', ownerAuthorization)
    .send({ acknowledgedNoticeVersion: 2 });
  assert.equal(futureVersion.status, 400);
  assert.equal(futureVersion.body.error.code, 'INVALID_NOTICE_VERSION');
  assert.equal(futureVersion.body.error.currentNoticeVersion, 1);

  const wrongType = await request(app)
    .patch('/api/clarity/settings')
    .set('Authorization', ownerAuthorization)
    .send({ analyticsEnabled: 'false' });
  assert.equal(wrongType.status, 400);
  assert.equal(wrongType.body.error.code, 'INVALID_ANALYTICS_SETTING');

  const stateCount = await db.prepare(
    'SELECT COUNT(*) AS count FROM user_financial_state WHERE user_id = ?'
  ).get(OWNER_ID);
  assert.equal(Number(stateCount.count), 0, 'rejected patches must not change settings');
});

test('analytics enablement requires acknowledgement and disablement is committed before response', async () => {
  await db.prepare(
    'INSERT INTO salary_entries (user_id, month, amount) VALUES (?, ?, ?)'
  ).run(OWNER_ID, currentMonth(), 80_000);

  const blockedEnable = await request(app)
    .patch('/api/clarity/settings')
    .set('Authorization', ownerAuthorization)
    .send({ analyticsEnabled: true });
  assert.equal(blockedEnable.status, 428);
  assert.equal(blockedEnable.body.error.code, 'DATA_NOTICE_REQUIRED');
  assert.equal(blockedEnable.body.error.acknowledgedNoticeVersion, 0);

  const enabled = await request(app)
    .patch('/api/clarity/settings')
    .set('Authorization', ownerAuthorization)
    .send({ acknowledgedNoticeVersion: 1, analyticsEnabled: true });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.body.dataUseNotice.acknowledgedVersion, 1);
  assert.match(enabled.body.dataUseNotice.acknowledgedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(enabled.body.dataUseNotice.acknowledgementRequired, false);
  assert.equal(enabled.body.productAnalytics.enabled, true);
  assert.equal(enabled.body.productAnalytics.enabledByDefault, false);
  assert.equal(enabled.body.productAnalytics.consentVersion, 1);
  assert.match(enabled.body.productAnalytics.changedAt, /^\d{4}-\d{2}-\d{2}T/);

  const disabled = await request(app)
    .patch('/api/clarity/settings')
    .set('Authorization', ownerAuthorization)
    .send({ analyticsEnabled: false });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.body.productAnalytics.enabled, false);

  const persisted = await db.prepare(
    `SELECT analytics_enabled, data_use_notice_version, data_use_acknowledged_at
       FROM user_financial_state
      WHERE user_id = ?`
  ).get(OWNER_ID);
  assert.equal(Number(persisted.analytics_enabled), 0);
  assert.equal(Number(persisted.data_use_notice_version), 1);
  assert.ok(persisted.data_use_acknowledged_at);

  const salary = await db.prepare(
    'SELECT amount FROM salary_entries WHERE user_id = ? AND month = ?'
  ).get(OWNER_ID, currentMonth());
  assert.equal(Number(salary.amount), 80_000, 'analytics changes must preserve financial records');

  const otherState = await db.prepare(
    'SELECT user_id FROM user_financial_state WHERE user_id = ?'
  ).get(OTHER_USER_ID);
  assert.equal(otherState, undefined, 'settings updates must remain owner-scoped');
});

test('428 applies only to declared new-use submissions and preserves read, export, correction, and deletion', async () => {
  const month = currentMonth();
  const blockedCreate = await request(app)
    .post('/api/finance/salary')
    .set('Authorization', ownerAuthorization)
    .set('X-Clarity-Contract', '1')
    .set('Idempotency-Key', 'b1000000-0000-4000-8000-000000000001')
    .send({ month, amountMinor: 5_000_000, expectedRecordVersion: 0 });
  assert.equal(blockedCreate.status, 428);
  assert.equal(blockedCreate.body.error.code, 'DATA_NOTICE_REQUIRED');
  assert.equal(blockedCreate.body.error.requiredNoticeVersion, 1);
  assert.equal(blockedCreate.body.error.acknowledgedNoticeVersion, 0);
  assert.equal(blockedCreate.body.error.settingsPath, '/api/clarity/settings');
  assert.equal(
    await db.prepare('SELECT id FROM salary_entries WHERE user_id = ? AND month = ?').get(OWNER_ID, month),
    undefined,
    'the rejected command must not be processed'
  );

  const clarityRead = await request(app)
    .get(`/api/finance/clarity?month=${month}`)
    .set('Authorization', ownerAuthorization);
  assert.equal(clarityRead.status, 200);

  const exportRead = await request(app)
    .get('/api/auth/export')
    .set('Authorization', ownerAuthorization);
  assert.equal(exportRead.status, 200);

  await db.prepare(
    'INSERT INTO salary_entries (user_id, month, amount) VALUES (?, ?, ?)'
  ).run(OWNER_ID, month, 40_000);
  const correction = await request(app)
    .post('/api/finance/salary')
    .set('Authorization', ownerAuthorization)
    .set('X-Clarity-Contract', '1')
    .set('Idempotency-Key', 'b1000000-0000-4000-8000-000000000002')
    .send({ month, amountMinor: 4_500_000, expectedRecordVersion: 0 });
  assert.equal(correction.status, 200);
  assert.equal(correction.body.amount, 45_000);

  const expense = await db.prepare(
    `INSERT INTO expense_log (user_id, month, category, amount, spent_on)
     VALUES (?, ?, 'Food', 100, ?)`
  ).run(OWNER_ID, month, `${month}-01`);
  const deletion = await request(app)
    .delete(`/api/finance/expenses/${expense.lastInsertRowid}`)
    .set('Authorization', ownerAuthorization);
  assert.equal(deletion.status, 200);
  assert.deepEqual(deletion.body, { ok: true });

  const acknowledged = await request(app)
    .patch('/api/clarity/settings')
    .set('Authorization', ownerAuthorization)
    .send({ acknowledgedNoticeVersion: 1 });
  assert.equal(acknowledged.status, 200);

  const acceptedCreate = await request(app)
    .post('/api/finance/emis')
    .set('Authorization', ownerAuthorization)
    .set('X-Clarity-Contract', '1')
    .set('Idempotency-Key', 'b1000000-0000-4000-8000-000000000003')
    .send({
      label: 'Current rent',
      amountMinor: 1_500_000,
      category: 'Rent',
      applicableMonth: month,
      expectedRecordVersion: 0,
    });
  assert.equal(acceptedCreate.status, 200);
  assert.ok(Number.isSafeInteger(acceptedCreate.body.id));
});

test('flag transitions re-gate only new inputs and rollback preserves feature data and analytics', async () => {
  const month = currentMonth();
  const spentOn = `${month}-02`;

  const versionOne = await request(app)
    .patch('/api/clarity/settings')
    .set('Authorization', ownerAuthorization)
    .send({ acknowledgedNoticeVersion: 1, analyticsEnabled: true });
  assert.equal(versionOne.status, 200);

  await db.prepare(
    'INSERT INTO salary_entries (user_id, month, amount) VALUES (?, ?, ?)'
  ).run(OWNER_ID, month, 40_000);
  const markedExpense = await db.prepare(
    `INSERT INTO expense_log
      (user_id, month, category, amount, note, spent_on, exclude_from_daily_allowance)
     VALUES (?, ?, 'Food', 100, 'kept through rollback', ?, 1)`
  ).run(OWNER_ID, month, spentOn);
  const deletableExpense = await db.prepare(
    `INSERT INTO expense_log (user_id, month, category, amount, note, spent_on)
     VALUES (?, ?, 'Travel', 200, 'delete while gated', ?)`
  ).run(OWNER_ID, month, spentOn);
  await db.prepare(
    `INSERT INTO category_memory
      (user_id, note_key, category, revision, created_at, updated_at)
     VALUES (?, 'morning coffee', 'Food', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
  ).run(OWNER_ID);

  process.env.QUICK_ADD_ENABLED = '1';

  const enabledSettings = await request(app)
    .get('/api/clarity/settings')
    .set('Authorization', ownerAuthorization);
  assert.equal(enabledSettings.status, 200);
  assert.equal(enabledSettings.body.dataUseNotice.version, 2);
  assert.equal(enabledSettings.body.dataUseNotice.acknowledgedVersion, 1);
  assert.equal(enabledSettings.body.dataUseNotice.acknowledgementRequired, true);
  assert.equal(enabledSettings.body.productAnalytics.enabled, true);
  assert.equal(enabledSettings.body.productAnalytics.consentVersion, 1);

  const blockedInput = await request(app)
    .post('/api/finance/emis')
    .set('Authorization', ownerAuthorization)
    .set('X-Clarity-Contract', '1')
    .set('Idempotency-Key', 'b2000000-0000-4000-8000-000000000001')
    .send({
      label: 'Blocked new rent',
      amountMinor: 1_500_000,
      category: 'Rent',
      applicableMonth: month,
      expectedRecordVersion: 0,
    });
  assert.equal(blockedInput.status, 428);
  assert.equal(blockedInput.body.error.code, 'DATA_NOTICE_REQUIRED');
  assert.equal(blockedInput.body.error.requiredNoticeVersion, 2);
  assert.equal(blockedInput.body.error.currentNoticeVersion, 2);
  assert.equal(blockedInput.body.error.acknowledgedNoticeVersion, 1);

  const read = await request(app)
    .get(`/api/finance/expenses?month=${month}`)
    .set('Authorization', ownerAuthorization);
  assert.equal(read.status, 200);
  assert.equal(read.body.expenses.length, 2);

  const exported = await request(app)
    .get('/api/auth/export')
    .set('Authorization', ownerAuthorization);
  assert.equal(exported.status, 200);
  assert.equal(exported.body.data.category_memory.length, 1);

  const correction = await request(app)
    .post('/api/finance/salary')
    .set('Authorization', ownerAuthorization)
    .set('X-Clarity-Contract', '1')
    .set('Idempotency-Key', 'b2000000-0000-4000-8000-000000000002')
    .send({ month, amountMinor: 4_500_000, expectedRecordVersion: 0 });
  assert.equal(correction.status, 200);
  assert.equal(correction.body.amount, 45_000);

  const deletion = await request(app)
    .delete(`/api/finance/expenses/${deletableExpense.lastInsertRowid}`)
    .set('Authorization', ownerAuthorization);
  assert.equal(deletion.status, 200);
  assert.deepEqual(deletion.body, { ok: true });

  process.env.QUICK_ADD_ENABLED = 'false';

  const rolledBackSettings = await request(app)
    .get('/api/clarity/settings')
    .set('Authorization', ownerAuthorization);
  assert.equal(rolledBackSettings.status, 200);
  assert.equal(rolledBackSettings.body.dataUseNotice.version, 1);
  assert.equal(rolledBackSettings.body.dataUseNotice.acknowledgedVersion, 1);
  assert.equal(rolledBackSettings.body.dataUseNotice.acknowledgementRequired, false);
  assert.equal(rolledBackSettings.body.productAnalytics.enabled, true);

  const acceptedAfterRollback = await request(app)
    .post('/api/finance/emis')
    .set('Authorization', ownerAuthorization)
    .set('X-Clarity-Contract', '1')
    .set('Idempotency-Key', 'b2000000-0000-4000-8000-000000000003')
    .send({
      label: 'Accepted after rollback',
      amountMinor: 1_500_000,
      category: 'Rent',
      applicableMonth: month,
      expectedRecordVersion: 0,
    });
  assert.equal(acceptedAfterRollback.status, 200, JSON.stringify(acceptedAfterRollback.body));

  const preservedAfterRollback = await db.prepare(
    `SELECT exclude_from_daily_allowance
       FROM expense_log
      WHERE id = ? AND user_id = ?`
  ).get(markedExpense.lastInsertRowid, OWNER_ID);
  assert.equal(Number(preservedAfterRollback.exclude_from_daily_allowance), 1);
  assert.equal(
    Number((await db.prepare(
      'SELECT COUNT(*) AS count FROM category_memory WHERE user_id = ?'
    ).get(OWNER_ID)).count),
    1
  );

  process.env.QUICK_ADD_ENABLED = 'true';
  const versionTwo = await request(app)
    .patch('/api/clarity/settings')
    .set('Authorization', ownerAuthorization)
    .send({ acknowledgedNoticeVersion: 2 });
  assert.equal(versionTwo.status, 200);
  assert.equal(versionTwo.body.dataUseNotice.acknowledgedVersion, 2);
  assert.equal(versionTwo.body.dataUseNotice.acknowledgementRequired, false);
  assert.equal(versionTwo.body.productAnalytics.enabled, true);

  process.env.QUICK_ADD_ENABLED = 'false';
  const afterSecondRollback = await request(app)
    .get('/api/clarity/settings')
    .set('Authorization', ownerAuthorization);
  assert.equal(afterSecondRollback.status, 200);
  assert.equal(afterSecondRollback.body.dataUseNotice.version, 1);
  assert.equal(afterSecondRollback.body.dataUseNotice.acknowledgedVersion, 2);
  assert.equal(afterSecondRollback.body.dataUseNotice.acknowledgementRequired, false);
  assert.equal(afterSecondRollback.body.productAnalytics.enabled, true);
});
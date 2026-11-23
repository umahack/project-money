import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createIsolatedTestDatabase } from '../helpers/testDatabase.js';
import { buildSessionFixture, buildUserFixture } from '../helpers/fixtures.js';

/**
 * Focused check of the Recurring_Auto_Post mark (spec: quick-add-daily-answer,
 * task 9.1; requirements 18.15, 18.23, 18.25). Synthetic data only.
 */

const OWNER_ID = 9101;
const OWNER_SESSION_ID = 9111;

let testDatabase;
let db;
let app;
let authorization;

function currentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

before(async () => {
  // Every server flag off: the mark must be written regardless of flags.
  delete process.env.QUICK_ADD_ENABLED;
  delete process.env.CLARITY_SHADOW_COMPARE;
  testDatabase = await createIsolatedTestDatabase();
  db = testDatabase.db;
  process.env.FINANCIAL_MUTATION_HMAC_KEY =
    'test-only-financial-mutation-hmac-key-32-bytes-minimum';
  const { createApp } = await import('../../src/app.js');
  app = createApp();
});

beforeEach(async () => {
  await testDatabase.reset();
  const user = buildUserFixture({ id: OWNER_ID, email: 'recurring-mark@example.test' });
  const session = buildSessionFixture({ userId: OWNER_ID, id: OWNER_SESSION_ID, ip_hash: 'recurring-mark' });
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
  await db.prepare(
    `INSERT INTO user_financial_state (user_id, data_use_notice_version, data_use_acknowledged_at)
     VALUES (?, 1, CURRENT_TIMESTAMP)`
  ).run(OWNER_ID);
  authorization = `Bearer ${jwt.sign(
    { sub: String(OWNER_ID), tv: 1, sid: OWNER_SESSION_ID },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '5m' }
  )}`;
});

after(async () => {
  await testDatabase?.cleanup();
});

test('a newly posted recurring expense carries the mark and earlier posts stay unmarked', async () => {
  const month = currentMonth();
  // A definition already posted this month before the feature: its row has no mark.
  await db.prepare(
    `INSERT INTO recurring_expenses (user_id, label, amount, category, day_of_month, active, last_logged_month)
     VALUES (?, ?, ?, ?, ?, 1, ?)`
  ).run(OWNER_ID, 'Earlier rent', 700, 'Bills', 1, month);
  await db.prepare(
    `INSERT INTO expense_log (user_id, month, category, amount, note, spent_on)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(OWNER_ID, month, 'Bills', 700, 'Earlier rent (recurring)', `${month}-01`);
  // A definition due today that has not posted yet.
  await db.prepare(
    `INSERT INTO recurring_expenses (user_id, label, amount, category, day_of_month, active)
     VALUES (?, ?, ?, ?, ?, 1)`
  ).run(OWNER_ID, 'New gym', 300, 'Wants', 1);

  const response = await request(app)
    .get(`/api/finance/expenses?month=${month}`)
    .set('Authorization', authorization);
  assert.equal(response.status, 200);

  const rows = await db.prepare(
    'SELECT note, amount, exclude_from_daily_allowance FROM expense_log WHERE user_id = ? ORDER BY id'
  ).all(OWNER_ID);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].note, 'Earlier rent (recurring)');
  assert.equal(rows[0].exclude_from_daily_allowance, null);
  assert.equal(rows[1].note, 'New gym (recurring)');
  assert.equal(Number(rows[1].amount), 300);
  assert.equal(Number(rows[1].exclude_from_daily_allowance), 1);
});

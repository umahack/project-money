import { after, afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createIsolatedTestDatabase } from '../helpers/testDatabase.js';
import { buildSessionFixture, buildUserFixture } from '../helpers/fixtures.js';

const OWNER_ID = 9101;
const MEMBER_ID = 9102;
const OUTSIDER_ID = 9103;
const TRIP_ID = 9201;
const TRIP_EXPENSE_ID = 9401;
const PUBLIC_TOKEN = '1234567890abcdef1234567890abcdef';

let testDatabase;
let db;
let app;
let accounts;

before(async () => {
  testDatabase = await createIsolatedTestDatabase();
  db = testDatabase.db;
  process.env.FINANCIAL_MUTATION_HMAC_KEY = 'test-only-trip-mutation-hmac-key-32-bytes-minimum';
  const appModule = await import('../../src/app.js');
  app = appModule.createApp();
});

beforeEach(async () => {
  await testDatabase.reset();
  accounts = await seedScenario();
});

afterEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
});

after(async () => {
  await testDatabase?.cleanup();
});

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
      (id, user_id, device_label, ip_hash, user_agent, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    session.id,
    session.user_id,
    session.device_label,
    session.ip_hash,
    session.user_agent,
    session.created_at,
    session.last_seen_at
  );
}

async function seedScenario() {
  const owner = buildUserFixture({ id: OWNER_ID, email: 'trip-owner@example.test', name: 'Owner' });
  const member = buildUserFixture({ id: MEMBER_ID, email: 'trip-member@example.test', name: 'Member' });
  const outsider = buildUserFixture({ id: OUTSIDER_ID, email: 'trip-outsider@example.test', name: 'Outsider' });
  const ownerSession = buildSessionFixture({ id: 9501, userId: OWNER_ID });
  const memberSession = buildSessionFixture({ id: 9502, userId: MEMBER_ID });
  const outsiderSession = buildSessionFixture({ id: 9503, userId: OUTSIDER_ID });
  for (const [user, session] of [
    [owner, ownerSession],
    [member, memberSession],
    [outsider, outsiderSession],
  ]) {
    await insertAccount(user, session);
    await db.prepare(
      `INSERT INTO user_financial_state
        (user_id, data_use_notice_version, data_use_acknowledged_at)
       VALUES (?, 1, CURRENT_TIMESTAMP)`
    ).run(user.id);
  }

  await db.prepare(
    `INSERT INTO trips
      (id, user_id, name, destination, budget, start_date, end_date, public_token, public_enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    TRIP_ID,
    OWNER_ID,
    'API trip',
    'Pune',
    5000,
    '2026-01-10',
    '2026-01-20',
    PUBLIC_TOKEN,
    1
  );
  await db.prepare(
    'INSERT INTO trip_members (id, trip_id, user_id, name, email) VALUES (?, ?, ?, ?, ?)'
  ).run(9301, TRIP_ID, OWNER_ID, 'Owner', owner.email);
  await db.prepare(
    'INSERT INTO trip_members (id, trip_id, user_id, name, email) VALUES (?, ?, ?, ?, ?)'
  ).run(9302, TRIP_ID, MEMBER_ID, 'Member', member.email);
  await db.prepare(
    `INSERT INTO trip_expenses
      (id, trip_id, payer, description, amount, split_json)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    TRIP_EXPENSE_ID,
    TRIP_ID,
    'Owner',
    'Hotel',
    100,
    JSON.stringify([{ name: 'Owner', share: 1 }, { name: 'Member', share: 1 }])
  );

  return { owner, member, outsider, ownerSession, memberSession, outsiderSession };
}

function authFor(user, session) {
  const token = jwt.sign(
    { sub: String(user.id), tv: user.token_version, sid: session.id },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '5m' }
  );
  return `Bearer ${token}`;
}

function currentDate() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

async function count(sql, ...args) {
  const row = await db.prepare(sql).get(...args);
  return Number(row.count);
}

test('member, expense, and settlement routes keep legacy fields and fail-closed role checks', async () => {
  const ownerAuth = authFor(accounts.owner, accounts.ownerSession);
  const memberAuth = authFor(accounts.member, accounts.memberSession);
  const memberKey = '91000000-0000-4000-8000-000000000001';

  const deniedMember = await request(app)
    .post(`/api/trips/${TRIP_ID}/members`)
    .set('Authorization', memberAuth)
    .set('Idempotency-Key', '91000000-0000-4000-8000-000000000002')
    .send({ name: 'Denied' });
  assert.equal(deniedMember.status, 404);
  assert.deepEqual(deniedMember.body, { error: 'Not found' });

  const memberWrite = await request(app)
    .post(`/api/trips/${TRIP_ID}/members`)
    .set('Authorization', ownerAuth)
    .set('Idempotency-Key', memberKey)
    .send({ name: 'Friend', expectedTripVersion: 0 });
  const memberReplay = await request(app)
    .post(`/api/trips/${TRIP_ID}/members`)
    .set('Authorization', ownerAuth)
    .set('Idempotency-Key', memberKey)
    .send({ name: 'Friend', expectedTripVersion: 0 });
  assert.equal(memberWrite.status, 200);
  assert.ok(Number.isSafeInteger(memberWrite.body.id));
  assert.equal(memberWrite.body.tripVersion, 1);
  assert.equal(memberWrite.body.dataVersion, 1);
  assert.equal(memberWrite.body.tripOutcome.status, 'available');
  assert.equal(memberReplay.body.id, memberWrite.body.id);
  assert.equal(memberReplay.body.mutation.replayed, true);
  assert.equal(await count('SELECT COUNT(*) AS count FROM trip_members WHERE trip_id = ? AND name = ?', TRIP_ID, 'Friend'), 1);

  const expenseWrite = await request(app)
    .post(`/api/trips/${TRIP_ID}/expenses`)
    .set('Authorization', memberAuth)
    .set('Idempotency-Key', '91000000-0000-4000-8000-000000000003')
    .send({
      payer: 'Owner',
      description: 'Taxi',
      amount: 30,
      split: [{ name: 'Owner', share: 1 }, { name: 'Member', share: 2 }],
      expectedTripVersion: 1,
    });
  assert.equal(expenseWrite.status, 200);
  assert.ok(Number.isSafeInteger(expenseWrite.body.id));
  assert.equal(expenseWrite.body.tripVersion, 2);
  assert.equal(expenseWrite.body.tripOutcome.status, 'available');

  const forgedSettlement = await request(app)
    .post(`/api/trips/${TRIP_ID}/expenses`)
    .set('Authorization', memberAuth)
    .set('Idempotency-Key', '91000000-0000-4000-8000-000000000004')
    .send({
      payer: 'Owner',
      description: '↔ Settlement: Owner → Member',
      amount: 1,
      split: [{ name: 'Member', share: 1 }],
    });
  assert.equal(forgedSettlement.status, 403);
  assert.equal(forgedSettlement.body.error, 'Only the payer or the trip owner can mark a settlement.');
  assert.equal(await count('SELECT COUNT(*) AS count FROM trip_expenses WHERE trip_id = ?', TRIP_ID), 2);
});

test('personal-link routes create and remove one allocated expense without public linkage', async () => {
  const memberAuth = authFor(accounts.member, accounts.memberSession);
  const outsiderAuth = authFor(accounts.outsider, accounts.outsiderSession);
  const spentOn = currentDate();
  const path = `/api/trips/${TRIP_ID}/expenses/${TRIP_EXPENSE_ID}/personal-link`;

  const missingKey = await request(app)
    .put(path)
    .set('Authorization', memberAuth)
    .send({ category: 'Travel', spentOn });
  assert.equal(missingKey.status, 400);
  assert.equal(missingKey.body.code, 'INVALID_IDEMPOTENCY_KEY');

  const outsider = await request(app)
    .put(path)
    .set('Authorization', outsiderAuth)
    .set('Idempotency-Key', '92000000-0000-4000-8000-000000000001')
    .send({ category: 'Travel', spentOn });
  assert.equal(outsider.status, 404);
  assert.deepEqual(outsider.body, { error: 'Not found' });

  const includeKey = '92000000-0000-4000-8000-000000000002';
  const included = await request(app)
    .put(path)
    .set('Authorization', memberAuth)
    .set('Idempotency-Key', includeKey)
    .send({ category: 'Travel', spentOn });
  const replay = await request(app)
    .put(path)
    .set('Authorization', memberAuth)
    .set('Idempotency-Key', includeKey)
    .send({ category: 'Travel', spentOn });

  assert.equal(included.status, 200);
  assert.equal(included.body.ok, true);
  assert.ok(Number.isSafeInteger(included.body.id));
  assert.equal(included.body.tripVersion, 0);
  assert.equal(included.body.dataVersion, 1);
  assert.equal(replay.body.id, included.body.id);
  assert.equal(replay.body.dataVersion, 1);
  assert.equal(replay.body.mutation.replayed, true);
  assert.equal(await count('SELECT COUNT(*) AS count FROM trip_expense_personal_links'), 1);
  assert.equal(await count('SELECT COUNT(*) AS count FROM expense_log WHERE user_id = ?', MEMBER_ID), 1);

  const publicResponse = await request(app).get(`/api/public/trips/${PUBLIC_TOKEN}`);
  assert.equal(publicResponse.status, 200);
  const serializedPublic = JSON.stringify(publicResponse.body);
  assert.equal(serializedPublic.includes('personal-link'), false);
  assert.equal(serializedPublic.includes('personalLink'), false);
  assert.equal('dataVersion' in publicResponse.body, false);
  assert.equal('tripOutcome' in publicResponse.body, false);

  const removeKey = '92000000-0000-4000-8000-000000000003';
  const removed = await request(app)
    .delete(path)
    .set('Authorization', memberAuth)
    .set('Idempotency-Key', removeKey);
  const removeReplay = await request(app)
    .delete(path)
    .set('Authorization', memberAuth)
    .set('Idempotency-Key', removeKey);
  assert.equal(removed.status, 200);
  assert.equal(removed.body.ok, true);
  assert.equal(removed.body.tripVersion, 0);
  assert.equal(removed.body.dataVersion, 2);
  assert.equal(removeReplay.body.dataVersion, 2);
  assert.equal(removeReplay.body.mutation.replayed, true);
  assert.equal(await count('SELECT COUNT(*) AS count FROM trip_expense_personal_links'), 0);
  assert.equal(await count('SELECT COUNT(*) AS count FROM expense_log WHERE user_id = ?', MEMBER_ID), 0);
  assert.equal(await count('SELECT COUNT(*) AS count FROM trip_expenses WHERE trip_id = ?', TRIP_ID), 1);
});

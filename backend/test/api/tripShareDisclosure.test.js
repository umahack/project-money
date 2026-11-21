import { after, afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createIsolatedTestDatabase } from '../helpers/testDatabase.js';
import { buildSessionFixture, buildUserFixture } from '../helpers/fixtures.js';
import { PUBLIC_TRIP_DISCLOSURE } from '../../src/serializers/publicTrip.js';

const OWNER_ID = 9701;
const MEMBER_ID = 9702;
const OUTSIDER_ID = 9703;
const TRIP_ID = 9801;

let testDatabase;
let db;
let app;
let accounts;

before(async () => {
  testDatabase = await createIsolatedTestDatabase();
  db = testDatabase.db;
  process.env.FINANCIAL_MUTATION_HMAC_KEY = 'test-only-trip-share-hmac-key-32-bytes-minimum';
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
  ).run(user.id, user.email, user.name, user.password_hash, user.is_admin, user.token_version, user.created_at);
  await db.prepare(
    `INSERT INTO sessions
      (id, user_id, device_label, ip_hash, user_agent, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(session.id, session.user_id, session.device_label, session.ip_hash, session.user_agent, session.created_at, session.last_seen_at);
}

async function seedScenario() {
  const owner = buildUserFixture({ id: OWNER_ID, email: 'share-owner@example.test', name: 'Owner' });
  const member = buildUserFixture({ id: MEMBER_ID, email: 'share-member@example.test', name: 'Member' });
  const outsider = buildUserFixture({ id: OUTSIDER_ID, email: 'share-outsider@example.test', name: 'Outsider' });
  const ownerSession = buildSessionFixture({ id: 9751, userId: OWNER_ID });
  const memberSession = buildSessionFixture({ id: 9752, userId: MEMBER_ID });
  const outsiderSession = buildSessionFixture({ id: 9753, userId: OUTSIDER_ID });
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
    `INSERT INTO trips (id, user_id, name, destination, budget, start_date, end_date)
     VALUES (?, ?, 'Share trip', 'Goa', 4000, '2026-02-01', '2026-02-05')`
  ).run(TRIP_ID, OWNER_ID);
  await db.prepare(
    'INSERT INTO trip_members (id, trip_id, user_id, name, email) VALUES (?, ?, ?, ?, ?)'
  ).run(9811, TRIP_ID, OWNER_ID, 'Owner', owner.email);
  await db.prepare(
    'INSERT INTO trip_members (id, trip_id, user_id, name, email) VALUES (?, ?, ?, ?, ?)'
  ).run(9812, TRIP_ID, MEMBER_ID, 'Member', member.email);
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

test('share disclosure is owner-only, authenticated, uncached, and equals the serializer description', async () => {
  const ownerAuth = authFor(accounts.owner, accounts.ownerSession);
  const path = `/api/trips/${TRIP_ID}/share/disclosure`;

  const anonymous = await request(app).get(path);
  assert.equal(anonymous.status, 401);

  const member = await request(app)
    .get(path)
    .set('Authorization', authFor(accounts.member, accounts.memberSession));
  assert.equal(member.status, 404);
  assert.deepEqual(member.body, { error: 'Not found' });

  const outsider = await request(app)
    .get(path)
    .set('Authorization', authFor(accounts.outsider, accounts.outsiderSession));
  assert.equal(outsider.status, 404);

  const unknownTrip = await request(app)
    .get('/api/trips/999999/share/disclosure')
    .set('Authorization', ownerAuth);
  assert.equal(unknownTrip.status, 404);

  const owner = await request(app).get(path).set('Authorization', ownerAuth);
  assert.equal(owner.status, 200);
  assert.match(owner.headers['cache-control'], /no-store/);
  assert.deepEqual(owner.body, JSON.parse(JSON.stringify(PUBLIC_TRIP_DISCLOSURE)));

  // Reading the disclosure never enables or changes sharing.
  const row = await db.prepare('SELECT public_token, public_enabled FROM trips WHERE id = ?').get(TRIP_ID);
  assert.equal(row.public_enabled, 0);
  assert.equal(row.public_token, null);
});

test('creating or rotating a link needs the current data-use notice only under the clarity contract; revoking never does', async () => {
  const ownerAuth = authFor(accounts.owner, accounts.ownerSession);
  await db.prepare('UPDATE user_financial_state SET data_use_notice_version = 0 WHERE user_id = ?').run(OWNER_ID);

  const blocked = await request(app)
    .post(`/api/trips/${TRIP_ID}/share`)
    .set('Authorization', ownerAuth)
    .set('X-Clarity-Contract', '1')
    .send({});
  assert.equal(blocked.status, 428);
  assert.equal(blocked.body.error.code, 'DATA_NOTICE_REQUIRED');
  let row = await db.prepare('SELECT public_token, public_enabled FROM trips WHERE id = ?').get(TRIP_ID);
  assert.equal(row.public_enabled, 0, 'the rejected command must not enable sharing');
  assert.equal(row.public_token, null);

  // The legacy contract is unchanged.
  const legacy = await request(app)
    .post(`/api/trips/${TRIP_ID}/share`)
    .set('Authorization', ownerAuth)
    .send({});
  assert.equal(legacy.status, 200);
  assert.match(legacy.body.token, /^[a-f0-9]{32}$/);

  // Revoking is never gated.
  const revoked = await request(app)
    .delete(`/api/trips/${TRIP_ID}/share`)
    .set('Authorization', ownerAuth)
    .set('X-Clarity-Contract', '1');
  assert.equal(revoked.status, 200);
  row = await db.prepare('SELECT public_token, public_enabled FROM trips WHERE id = ?').get(TRIP_ID);
  assert.equal(row.public_enabled, 0);

  await db.prepare('UPDATE user_financial_state SET data_use_notice_version = 1 WHERE user_id = ?').run(OWNER_ID);
  const allowed = await request(app)
    .post(`/api/trips/${TRIP_ID}/share`)
    .set('Authorization', ownerAuth)
    .set('X-Clarity-Contract', '1')
    .send({});
  assert.equal(allowed.status, 200);
  assert.match(allowed.body.token, /^[a-f0-9]{32}$/);
});

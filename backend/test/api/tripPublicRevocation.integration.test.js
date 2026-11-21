// Public trip projection, share-link revocation and rotation, and the authorization of
// share commands, against the real Express app and an isolated file-backed database.
//
// - The anonymous response is exactly the fixed allowlist (PUBLIC_TRIP_DISCLOSURE), before
//   and after authenticated writes (members with emails, shared expenses, settlement payments,
//   personal-share links), and never carries a personal link, version, id, email, or token.
// - Rotating or revoking a link answers the old token with the same constant 404 at once,
//   while the private trip, members, expenses, and personal links remain.
// - Only the trip owner can read the disclosure or the status, or create, rotate, or revoke.
// - Deleting the owner's account makes the owner's token a 404.
import { after, afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createIsolatedTestDatabase } from '../helpers/testDatabase.js';
import { buildSessionFixture, buildUserFixture } from '../helpers/fixtures.js';
import { PUBLIC_TRIP_DISCLOSURE } from '../../src/serializers/publicTrip.js';

const PASSWORD = 'Public-revocation-123!';
const OWNER_ID = 9901;
const MEMBER_ID = 9902;
const OUTSIDER_ID = 9903;
const OTHER_OWNER_ID = 9904;
const TRIP_ID = 9801;
const OTHER_TRIP_ID = 9802;
const OWNER_MEMBER_ID = 9811;
const MEMBER_MEMBER_ID = 9812;
const DINNER_ID = 9821;
const TOKEN_FORMAT = /^[a-f0-9]{32}$/;
const NOT_FOUND = Object.freeze({ error: 'Not found' });

let testDatabase;
let db;
let app;
let accounts;
let passwordHash;

before(async () => {
  testDatabase = await createIsolatedTestDatabase();
  db = testDatabase.db;
  passwordHash = await bcrypt.hash(PASSWORD, 4);
  process.env.FINANCIAL_MUTATION_HMAC_KEY = 'test-only-public-revocation-hmac-key-32-bytes';
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
  ).run(user.id, user.email, user.name, passwordHash, user.is_admin, user.token_version, user.created_at);
  await db.prepare(
    `INSERT INTO sessions
      (id, user_id, device_label, ip_hash, user_agent, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(session.id, session.user_id, session.device_label, session.ip_hash, session.user_agent, session.created_at, session.last_seen_at);
  await db.prepare(
    `INSERT INTO user_financial_state
      (user_id, data_use_notice_version, data_use_acknowledged_at)
     VALUES (?, 1, CURRENT_TIMESTAMP)`
  ).run(user.id);
}

async function seedScenario() {
  const people = [
    ['owner', OWNER_ID, 9951, 'Owner'],
    ['member', MEMBER_ID, 9952, 'Member'],
    ['outsider', OUTSIDER_ID, 9953, 'Outsider'],
    ['otherOwner', OTHER_OWNER_ID, 9954, 'Other owner'],
  ];
  const result = {};
  for (const [key, id, sessionId, name] of people) {
    const user = buildUserFixture({ id, email: `${key.toLowerCase()}-public@example.test`, name });
    const session = buildSessionFixture({ id: sessionId, userId: id });
    await insertAccount(user, session);
    result[key] = { user, session };
  }
  await db.prepare(
    `INSERT INTO trips (id, user_id, name, destination, budget, start_date, end_date)
     VALUES (?, ?, 'Public trip', 'Goa', 4000, '2026-02-01', '2026-02-05')`
  ).run(TRIP_ID, OWNER_ID);
  await db.prepare('INSERT INTO trip_members (id, trip_id, user_id, name, email) VALUES (?, ?, ?, ?, ?)')
    .run(OWNER_MEMBER_ID, TRIP_ID, OWNER_ID, 'Owner', result.owner.user.email);
  await db.prepare('INSERT INTO trip_members (id, trip_id, user_id, name, email) VALUES (?, ?, ?, ?, ?)')
    .run(MEMBER_MEMBER_ID, TRIP_ID, MEMBER_ID, 'Member', result.member.user.email);
  await db.prepare(
    `INSERT INTO trip_expenses (id, trip_id, payer, description, amount, split_json)
     VALUES (?, ?, 'Owner', 'Dinner', 100, ?)`
  ).run(DINNER_ID, TRIP_ID, JSON.stringify([{ name: 'Owner', share: 1 }, { name: 'Member', share: 1 }]));
  // A second owner with a shared link of their own, to show that one owner's changes never reach another's.
  await db.prepare(
    `INSERT INTO trips (id, user_id, name, destination, budget, public_token, public_enabled)
     VALUES (?, ?, 'Other trip', 'Pune', 1000, ?, 1)`
  ).run(OTHER_TRIP_ID, OTHER_OWNER_ID, 'abcdefabcdefabcdefabcdefabcdefab');
  await db.prepare('INSERT INTO trip_members (id, trip_id, user_id, name, email) VALUES (?, ?, ?, ?, ?)')
    .run(9813, OTHER_TRIP_ID, OTHER_OWNER_ID, 'Other owner', result.otherOwner.user.email);
  return result;
}

function authFor({ user, session }) {
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

async function privateCounts(tripId = TRIP_ID) {
  return {
    members: await count('SELECT COUNT(*) AS count FROM trip_members WHERE trip_id = ?', tripId),
    expenses: await count('SELECT COUNT(*) AS count FROM trip_expenses WHERE trip_id = ?', tripId),
    links: await count('SELECT COUNT(*) AS count FROM trip_expense_personal_links WHERE trip_id = ?', tripId),
  };
}

const shareState = (tripId = TRIP_ID) => db.prepare('SELECT public_token, public_enabled FROM trips WHERE id = ?').get(tripId);

const publicGet = (token) => request(app).get(`/api/public/trips/${token}`);

async function createLink(who = accounts.owner, tripId = TRIP_ID) {
  const response = await request(app)
    .post(`/api/trips/${tripId}/share`)
    .set('Authorization', authFor(who))
    .set('X-Clarity-Contract', '1')
    .send({});
  assert.equal(response.status, 200);
  assert.match(response.body.token, TOKEN_FORMAT);
  return response.body.token;
}

/** Dotted paths of every key: `[]` marks an array element and `*` a member display name under settlement.balances. */
function pathsOf(value, prefix = '') {
  if (Array.isArray(value)) return value.flatMap((item) => pathsOf(item, `${prefix}[]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, child]) => {
      const segment = prefix === 'settlement.balances' ? '*' : key;
      return pathsOf(child, prefix ? `${prefix}.${segment}` : segment);
    });
  }
  return [prefix];
}

const ALLOWLIST = [...new Set(PUBLIC_TRIP_DISCLOSURE.groups.flatMap((group) => group.fields.map((field) => field.path)))].sort();

function assertExactProjection(body, secrets) {
  assert.deepEqual([...new Set(pathsOf(body))].sort(), ALLOWLIST);
  assert.deepEqual(Object.keys(body).sort(), ['expenses', 'members', 'settlement', 'trip']);
  assert.deepEqual(Object.keys(body.trip).sort(), ['budget', 'destination', 'end_date', 'name', 'start_date']);
  assert.deepEqual(Object.keys(body.settlement).sort(), ['balances', 'transactions']);
  for (const member of body.members) assert.deepEqual(Object.keys(member), ['name']);
  for (const expense of body.expenses) {
    assert.deepEqual(Object.keys(expense).sort(), ['amount', 'created_at', 'description', 'payer', 'split']);
    for (const entry of expense.split) assert.deepEqual(Object.keys(entry).sort(), ['name', 'share']);
  }
  for (const transaction of body.settlement.transactions) {
    assert.deepEqual(Object.keys(transaction).sort(), ['amount', 'from', 'to']);
  }
  const serialized = JSON.stringify(body);
  for (const secret of [
    ...secrets,
    '@example.test',
    'personal',
    'expense_log',
    'tripVersion',
    'trip_version',
    'dataVersion',
    'user_id',
    'public_token',
    'public_enabled',
    '"id"',
    '"email"',
    '"note"',
  ]) {
    assert.equal(serialized.includes(secret), false, `public response must not contain ${secret}`);
  }
}

test('the public projection is exactly the allowlisted fields before and after authenticated writes', async () => {
  const token = await createLink();
  const memberAuth = authFor(accounts.member);
  const ownerAuth = authFor(accounts.owner);

  const initial = await publicGet(token);
  assert.equal(initial.status, 200);
  assertExactProjection(initial.body, [token]);
  assert.deepEqual(initial.body.settlement.balances, { Owner: 50, Member: -50 });
  assert.deepEqual(initial.body.settlement.transactions, [{ from: 'Member', to: 'Owner', amount: 50 }]);

  // A member with an email, a shared expense with a weighted split, and a recorded settlement payment.
  const added = await request(app)
    .post(`/api/trips/${TRIP_ID}/members`)
    .set('Authorization', ownerAuth)
    .set('Idempotency-Key', '99000000-0000-4000-8000-000000000001')
    .send({ name: 'Friend', email: 'friend-public@example.test' });
  assert.equal(added.status, 200);
  const expense = await request(app)
    .post(`/api/trips/${TRIP_ID}/expenses`)
    .set('Authorization', memberAuth)
    .set('Idempotency-Key', '99000000-0000-4000-8000-000000000002')
    .send({
      payer: 'Member',
      description: 'Taxi',
      amount: 30,
      split: [{ name: 'Owner', share: 1 }, { name: 'Member', share: 1 }, { name: 'Friend', share: 1 }],
    });
  assert.equal(expense.status, 200);
  const payment = await request(app)
    .post(`/api/trips/${TRIP_ID}/expenses`)
    .set('Authorization', memberAuth)
    .set('Idempotency-Key', '99000000-0000-4000-8000-000000000003')
    .send({
      payer: 'Member',
      description: '↔ Settlement: Member → Owner',
      amount: 10,
      split: [{ name: 'Owner', share: 1 }],
    });
  assert.equal(payment.status, 200);

  const afterWrites = await publicGet(token);
  assert.equal(afterWrites.status, 200);
  assertExactProjection(afterWrites.body, [token, 'friend-public']);
  assert.deepEqual(afterWrites.body.members.map(({ name }) => name).sort(), ['Friend', 'Member', 'Owner']);
  assert.equal(afterWrites.body.expenses.length, 3);
  // Balances come from the canonical calculator and stay zero-sum.
  const balances = Object.values(afterWrites.body.settlement.balances);
  assert.equal(Math.round(balances.reduce((total, value) => total + value * 100, 0)), 0);

  // A personal-share link is private: including it changes nothing public, and withdrawing changes nothing either.
  const include = await request(app)
    .put(`/api/trips/${TRIP_ID}/expenses/${DINNER_ID}/personal-link`)
    .set('Authorization', memberAuth)
    .set('Idempotency-Key', '99000000-0000-4000-8000-000000000004')
    .send({ category: 'Travel', spentOn: currentDate() });
  assert.equal(include.status, 200);
  assert.equal(await count('SELECT COUNT(*) AS count FROM trip_expense_personal_links WHERE trip_id = ?', TRIP_ID), 1);
  const afterInclude = await publicGet(token);
  assert.equal(afterInclude.status, 200);
  assert.deepEqual(afterInclude.body, afterWrites.body);
  assertExactProjection(afterInclude.body, [token, 'friend-public']);

  const withdraw = await request(app)
    .delete(`/api/trips/${TRIP_ID}/expenses/${DINNER_ID}/personal-link`)
    .set('Authorization', memberAuth)
    .set('Idempotency-Key', '99000000-0000-4000-8000-000000000005');
  assert.equal(withdraw.status, 200);
  const afterWithdraw = await publicGet(token);
  assert.deepEqual(afterWithdraw.body, afterWrites.body);

  // The anonymous response is not cacheable by the authenticated routes' headers, and sets no cookie.
  assert.equal(afterWithdraw.headers['set-cookie'], undefined);
});

test('disabled, rotated, and revoked tokens answer with the same constant 404, at once, and keep every private record', async () => {
  const unknownToken = 'f'.repeat(32);
  const baseline = await publicGet(unknownToken);
  assert.equal(baseline.status, 404);
  assert.deepEqual(baseline.body, NOT_FOUND);

  // Sharing is off by default: nothing is served and the owner's status says so.
  const ownerAuth = authFor(accounts.owner);
  const status = await request(app).get(`/api/trips/${TRIP_ID}/share`).set('Authorization', ownerAuth);
  assert.deepEqual(status.body, { enabled: false, token: null });
  let row = await shareState();
  assert.equal(row.public_enabled, 0);
  assert.equal(row.public_token, null);

  const first = await createLink();
  assert.equal((await publicGet(first)).status, 200);
  // Add a personal link before rotating, to show that links survive rotation and revocation.
  const include = await request(app)
    .put(`/api/trips/${TRIP_ID}/expenses/${DINNER_ID}/personal-link`)
    .set('Authorization', authFor(accounts.member))
    .set('Idempotency-Key', '99100000-0000-4000-8000-000000000001')
    .send({ category: 'Travel', spentOn: currentDate() });
  assert.equal(include.status, 200);
  const privateBefore = await privateCounts();
  assert.deepEqual(privateBefore, { members: 2, expenses: 1, links: 1 });
  const detailBefore = await request(app).get(`/api/trips/${TRIP_ID}`).set('Authorization', ownerAuth);
  assert.equal(detailBefore.status, 200);

  // Rotate: the previous token stops working immediately, the new one works.
  const second = await createLink();
  assert.notEqual(second, first);
  const rotated = await publicGet(first);
  assert.equal(rotated.status, 404);
  assert.deepEqual(rotated.body, baseline.body);
  assert.equal(rotated.headers['content-type'], baseline.headers['content-type']);
  assert.equal((await publicGet(second)).status, 200);
  assert.deepEqual(await privateCounts(), privateBefore);
  const statusAfterRotate = await request(app).get(`/api/trips/${TRIP_ID}/share`).set('Authorization', ownerAuth);
  assert.deepEqual(statusAfterRotate.body, { enabled: true, token: second });

  // Revoke: the current token stops at once. Nothing private is removed.
  const revoked = await request(app)
    .delete(`/api/trips/${TRIP_ID}/share`)
    .set('Authorization', ownerAuth)
    .set('X-Clarity-Contract', '1');
  assert.equal(revoked.status, 200);
  assert.deepEqual(revoked.body, { ok: true });
  for (const token of [first, second]) {
    const response = await publicGet(token);
    assert.equal(response.status, 404);
    assert.deepEqual(response.body, baseline.body);
    assert.equal(response.headers['content-type'], baseline.headers['content-type']);
  }
  row = await shareState();
  assert.equal(row.public_enabled, 0);
  assert.equal(row.public_token, null);
  assert.deepEqual(await privateCounts(), privateBefore);
  const detailAfter = await request(app).get(`/api/trips/${TRIP_ID}`).set('Authorization', ownerAuth);
  assert.equal(detailAfter.status, 200);
  assert.deepEqual(detailAfter.body.members, detailBefore.body.members);
  assert.deepEqual(detailAfter.body.expenses, detailBefore.body.expenses);
  const statusAfterRevoke = await request(app).get(`/api/trips/${TRIP_ID}/share`).set('Authorization', ownerAuth);
  assert.deepEqual(statusAfterRevoke.body, { enabled: false, token: null });

  // Enabling again makes a new token. The earlier ones stay dead.
  const third = await createLink();
  assert.ok(![first, second].includes(third));
  assert.equal((await publicGet(third)).status, 200);
  for (const token of [first, second]) assert.equal((await publicGet(token)).status, 404);

  // A token that is stored but switched off is not served, and neither is a malformed one.
  await db.prepare('UPDATE trips SET public_enabled = 0 WHERE id = ?').run(TRIP_ID);
  assert.deepEqual((await publicGet(third)).body, baseline.body);
  await db.prepare('UPDATE trips SET public_enabled = 1 WHERE id = ?').run(TRIP_ID);
  assert.equal((await publicGet(third)).status, 200);
  for (const malformed of [third.toUpperCase(), third.slice(1), `${third}0`, 'g'.repeat(32), '%20', 'null']) {
    const response = await publicGet(encodeURIComponent(malformed));
    assert.equal(response.status, 404, malformed);
    assert.deepEqual(response.body, baseline.body, malformed);
  }
});

test('only the trip owner can read the disclosure or status, or create, rotate, or revoke a link', async () => {
  const token = await createLink();
  const before = await shareState();
  const attempts = [
    ['get', `/api/trips/${TRIP_ID}/share`],
    ['get', `/api/trips/${TRIP_ID}/share/disclosure`],
    ['post', `/api/trips/${TRIP_ID}/share`],
    ['delete', `/api/trips/${TRIP_ID}/share`],
  ];

  for (const [method, path] of attempts) {
    const anonymous = await request(app)[method](path).send({});
    assert.equal(anonymous.status, 401, `anonymous ${method} ${path}`);
  }

  const others = [
    ['accepted member', accounts.member],
    ['outsider', accounts.outsider],
    ['owner of another trip', accounts.otherOwner],
  ];
  for (const [label, who] of others) {
    for (const [method, path] of attempts) {
      const response = await request(app)[method](path)
        .set('Authorization', authFor(who))
        .set('X-Clarity-Contract', '1')
        .send({});
      assert.equal(response.status, 404, `${label} ${method} ${path}`);
      assert.deepEqual(response.body, NOT_FOUND, `${label} ${method} ${path}`);
    }
  }

  // Nothing changed: the link is the same, still served, and the other owner's link is untouched.
  assert.deepEqual(await shareState(), before);
  assert.equal((await publicGet(token)).status, 200);
  assert.equal((await publicGet('abcdefabcdefabcdefabcdefabcdefab')).status, 200);
  assert.equal(
    (await db.prepare('SELECT public_enabled FROM trips WHERE id = ?').get(OTHER_TRIP_ID)).public_enabled,
    1
  );

  // The member can still read the private trip and list it, as a member, and never receives the owner's token or sharing state.
  const detail = await request(app).get(`/api/trips/${TRIP_ID}`).set('Authorization', authFor(accounts.member));
  assert.equal(detail.status, 200);
  assert.equal(detail.body.role, 'member');
  assert.equal(detail.body.members.length, 2);
  assert.equal('public_token' in detail.body.trip, false);
  assert.equal('public_enabled' in detail.body.trip, false);
  assert.equal(JSON.stringify(detail.body).includes(token), false);
  const list = await request(app).get('/api/trips').set('Authorization', authFor(accounts.member));
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.trips.map(({ id, role }) => [id, role]), [[TRIP_ID, 'member']]);
  assert.equal(JSON.stringify(list.body).includes(token), false);
  assert.equal('public_enabled' in list.body.trips[0], false);

  // The owner's reads keep the legacy fields.
  const ownerDetail = await request(app).get(`/api/trips/${TRIP_ID}`).set('Authorization', authFor(accounts.owner));
  assert.equal(ownerDetail.body.trip.public_token, token);
  assert.equal(ownerDetail.body.trip.public_enabled, 1);
  const ownerList = await request(app).get('/api/trips').set('Authorization', authFor(accounts.owner));
  assert.equal(ownerList.body.trips[0].public_token, token);
});

test('deleting the owner’s account makes the owner’s token a 404 and leaves another owner’s link alone', async () => {
  const token = await createLink();
  const otherToken = 'abcdefabcdefabcdefabcdefabcdefab';
  const include = await request(app)
    .put(`/api/trips/${TRIP_ID}/expenses/${DINNER_ID}/personal-link`)
    .set('Authorization', authFor(accounts.member))
    .set('Idempotency-Key', '99200000-0000-4000-8000-000000000001')
    .send({ category: 'Travel', spentOn: currentDate() });
  assert.equal(include.status, 200);
  assert.equal((await publicGet(token)).status, 200);
  const baseline = await publicGet('f'.repeat(32));

  const wrongPassword = await request(app)
    .delete('/api/auth/account')
    .set('Authorization', authFor(accounts.owner))
    .send({ currentPassword: 'not-the-password' });
  assert.equal(wrongPassword.status, 401);
  // A refused deletion changes nothing.
  assert.equal((await publicGet(token)).status, 200);

  const deleted = await request(app)
    .delete('/api/auth/account')
    .set('Authorization', authFor(accounts.owner))
    .send({ currentPassword: PASSWORD });
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.body, { ok: true });

  const gone = await publicGet(token);
  assert.equal(gone.status, 404);
  assert.deepEqual(gone.body, baseline.body);
  assert.equal(await count('SELECT COUNT(*) AS count FROM trips WHERE id = ?', TRIP_ID), 0);
  assert.deepEqual(await privateCounts(), { members: 0, expenses: 0, links: 0 });
  assert.equal(await count('SELECT COUNT(*) AS count FROM users WHERE id = ?', OWNER_ID), 0);

  // The other accounts and the other owner's link are unaffected.
  assert.equal(await count('SELECT COUNT(*) AS count FROM users WHERE id IN (?, ?)', MEMBER_ID, OTHER_OWNER_ID), 2);
  assert.equal((await publicGet(otherToken)).status, 200);
  // The deleted owner's session no longer reaches any route.
  const stale = await request(app).get(`/api/trips/${TRIP_ID}/share`).set('Authorization', authFor(accounts.owner));
  assert.equal(stale.status, 401);
});

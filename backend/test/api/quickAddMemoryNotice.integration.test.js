import '../helpers/blockingStdout.js';
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { buildSessionFixture, buildUserFixture } from '../helpers/fixtures.js';
import {
  ANONYMOUS_ROUTE_ALLOWLIST,
  CRON_ROUTE_ALLOWLIST,
  collectRoutes,
  routeKey,
} from '../helpers/routeInventory.js';
import { createIsolatedTestDatabase } from '../helpers/testDatabase.js';

/**
 * Memory API and data-use notice integration (task 8.4), against the real app and an isolated file database.
 *
 * quickAddRoutes.test.js (task 8.2), claritySettings.test.js, rolloutRollback.integration.test.js,
 * canonicalRoutes.integration.test.js, and quickAddDataLifecycle.integration.test.js already cover the basic
 * authentication, isolation, 404, 428, revision, replay, cap, delete-all, hints, and notice-version behavior. This file
 * adds only what they leave implicit: every session check on every new route, a hard-coded anonymous allowlist,
 * cross-user writes, identical 404/409 answers that cannot reveal another user, the gate answered in the right order,
 * the cap with a second user present, live flag changes through the settings route, and the shared rate limit.
 *
 * Requirements: 6.9, 6.13, 14.7, 15.1, 15.2, 15.3, 15.4, 15.9, 15.10, 15.13, 15.14, 16.19, 16.20, 16.21, 16.22.
 */

const OWNER_ID = 84_101;
const PEER_ID = 84_102;
const OWNER_SESSION_ID = 84_201;
const PEER_SESSION_ID = 84_202;
const MEMORY_LIMIT = 500;

// Anonymous routes owned by unrelated work (Sign in with Google). Quick Add adds no anonymous
// route; this only keeps the check below from pinning another feature's route list.
const UNRELATED_ANONYMOUS_ROUTES = Object.freeze(['POST /api/auth/google']);
const withoutUnrelated = (keys) => keys.filter((key) => !UNRELATED_ANONYMOUS_ROUTES.includes(key));
// Hard-coded on purpose: the helper's list must not be able to grow without this test noticing.
const EXPECTED_ANONYMOUS_ROUTES = Object.freeze([
  'GET /api/health',
  'GET /api/public/announcement',
  'GET /api/public/trips/:token',
  'POST /api/auth/login',
  'POST /api/auth/password-reset-finish',
  'POST /api/auth/password-reset-start',
  'POST /api/auth/register-finish',
  'POST /api/auth/register-resend',
  'POST /api/auth/register-start',
  'POST /api/track',
]);

const NEW_ROUTES = Object.freeze([
  'GET /api/finance/quick-add/hints',
  'PUT /api/finance/category-memory',
  'DELETE /api/finance/category-memory/:id',
  'DELETE /api/finance/category-memory',
]);

let testDatabase;
let db;
let createApp;
let app;
let ownerAuthorization;
let peerAuthorization;
let today;
let month;
let idempotencySequence;

function tokenFor(user, session, claims = {}, options = {}) {
  return jwt.sign(
    { sub: String(user.id), tv: user.token_version, sid: session.id, ...claims },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '5m', ...options }
  );
}

async function insertAccount(user, session, noticeVersion = 1) {
  await db.prepare(
    `INSERT INTO users (id, email, name, password_hash, is_admin, token_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(user.id, user.email, user.name, user.password_hash, user.is_admin, user.token_version, user.created_at);
  await db.prepare(
    `INSERT INTO sessions
      (id, user_id, device_label, ip_hash, user_agent, created_at, last_seen_at, revoked_at, revoked_reason)
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
    `INSERT INTO user_financial_state (user_id, data_use_notice_version, data_use_acknowledged_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)`
  ).run(user.id, noticeVersion);
}

async function setNoticeVersion(userId, version) {
  await db.prepare(
    'UPDATE user_financial_state SET data_use_notice_version = ? WHERE user_id = ?'
  ).run(version, userId);
}

async function insertMemory(userId, noteKey, category, revision = 1, timestamp = '2026-01-01T00:00:00.000Z') {
  const result = await db.prepare(
    `INSERT INTO category_memory (user_id, note_key, category, revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(userId, noteKey, category, revision, timestamp, timestamp);
  return Number(result.lastInsertRowid);
}

async function insertExpense(userId, { category = 'Food', amount = 100, note, spentOn = today }) {
  const result = await db.prepare(
    `INSERT INTO expense_log (user_id, month, category, amount, note, spent_on)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(userId, spentOn.slice(0, 7), category, amount, note, spentOn);
  return Number(result.lastInsertRowid);
}

async function memoryRows(userId) {
  return db.prepare(
    `SELECT id, note_key, category, revision, created_at, updated_at
       FROM category_memory WHERE user_id = ? ORDER BY id`
  ).all(userId);
}

async function memoryCount(userId) {
  const row = await db.prepare('SELECT COUNT(*) AS count FROM category_memory WHERE user_id = ?').get(userId);
  return Number(row.count);
}

async function expenseCount(userId) {
  const row = await db.prepare('SELECT COUNT(*) AS count FROM expense_log WHERE user_id = ?').get(userId);
  return Number(row.count);
}

function plain(rows) {
  return JSON.parse(JSON.stringify(rows));
}

function setFlag(on) {
  process.env.QUICK_ADD_ENABLED = on ? 'true' : 'false';
}

function as(method, path, authorization = ownerAuthorization) {
  return request(app)[method](path).set('Authorization', authorization);
}

function nextKey() {
  idempotencySequence += 1;
  return `84000000-0000-4000-8000-${String(idempotencySequence).padStart(12, '0')}`;
}

function canonical(method, path, authorization = ownerAuthorization) {
  return as(method, path, authorization)
    .set('X-Clarity-Contract', '1')
    .set('Idempotency-Key', nextKey());
}

function createExpense(authorization, overrides = {}) {
  return canonical('post', '/api/finance/expenses', authorization).send({
    amountMinor: 12_500,
    category: 'Food',
    note: 'notice scenario',
    spentOn: today,
    expectedRecordVersion: 0,
    ...overrides,
  });
}

function acknowledge(version, authorization = ownerAuthorization) {
  return as('patch', '/api/clarity/settings', authorization).send({ acknowledgedNoticeVersion: version });
}

function daysBefore(date, days) {
  const time = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
  return new Date(time - days * 86_400_000).toISOString().slice(0, 10);
}

function assertNoLeak(body, forbidden) {
  const serialized = JSON.stringify(body);
  assert.equal(Object.hasOwn(body?.error ?? {}, 'stack'), false, 'no stack trace in an error body');
  assert.equal(serialized.includes('node_modules'), false, 'no file path in an error body');
  for (const value of forbidden) {
    assert.equal(serialized.includes(String(value)), false, `response reveals ${value}`);
  }
}

before(async () => {
  testDatabase = await createIsolatedTestDatabase();
  db = testDatabase.db;
  process.env.FINANCIAL_MUTATION_HMAC_KEY = 'test-only-memory-notice-hmac-key-32-bytes-minimum';
  const [{ createApp: loadedCreateApp }, { kolkataDateOf }] = await Promise.all([
    import('../../src/app.js'),
    import('../../src/domain/kolkataTime.js'),
  ]);
  createApp = loadedCreateApp;
  today = kolkataDateOf(new Date());
  month = today.slice(0, 7);
});

beforeEach(async () => {
  await testDatabase.reset();
  setFlag(false);
  idempotencySequence = 0;
  // A new app per test gives each test its own 120 requests/minute allowance.
  const silent = () => {};
  app = createApp({ operationalLogger: { debug: silent, info: silent, warn: silent, error: silent } });

  const owner = buildUserFixture({ id: OWNER_ID, email: 'memory-notice-owner@example.test' });
  const peer = buildUserFixture({ id: PEER_ID, email: 'memory-notice-peer@example.test' });
  const ownerSession = buildSessionFixture({ id: OWNER_SESSION_ID, userId: OWNER_ID });
  const peerSession = buildSessionFixture({ id: PEER_SESSION_ID, userId: PEER_ID });
  await insertAccount(owner, ownerSession);
  await insertAccount(peer, peerSession);
  ownerAuthorization = `Bearer ${tokenFor(owner, ownerSession)}`;
  peerAuthorization = `Bearer ${tokenFor(peer, peerSession)}`;
});

afterEach(async () => {
  setFlag(false);
  // authRequired updates last_seen_at without awaiting it.
  await new Promise((resolve) => setImmediate(resolve));
});

after(async () => {
  await testDatabase?.cleanup();
});

// ---------------------------------------------------------------------------------------------------------------
// Authentication and the anonymous allowlist (15.1, 15.2)
// ---------------------------------------------------------------------------------------------------------------

test('the four new routes are session-gated and the anonymous allowlist is exactly the pre-feature list', () => {
  const routes = collectRoutes(app._router.stack);
  const keys = routes.map(routeKey);

  for (const key of NEW_ROUTES) {
    assert.equal(keys.filter((candidate) => candidate === key).length, 1, `${key} is registered once`);
    const route = routes.find((candidate) => routeKey(candidate) === key);
    assert.ok(route.guards.includes('authRequired'), `${key} requires authRequired`);
    assert.equal(route.guards.includes('requireCronSecret'), false, `${key} is not a scheduler route`);
  }

  const cronRoutes = routes.filter((route) => route.guards.includes('requireCronSecret'));
  const anonymous = routes
    .filter((route) => !route.guards.includes('authRequired') && !cronRoutes.includes(route))
    .map(routeKey)
    .sort();
  assert.deepEqual(withoutUnrelated(anonymous), [...EXPECTED_ANONYMOUS_ROUTES].sort());
  assert.deepEqual(
    withoutUnrelated([...ANONYMOUS_ROUTE_ALLOWLIST]).sort(),
    [...EXPECTED_ANONYMOUS_ROUTES].sort()
  );
  assert.deepEqual(cronRoutes.map(routeKey).sort(), [...CRON_ROUTE_ALLOWLIST].sort());
  for (const key of NEW_ROUTES) assert.equal(anonymous.includes(key), false, `${key} must not be anonymous`);
});

test('every new route applies the existing session, token-version, and revocation checks', async () => {
  setFlag(true);
  const owner = buildUserFixture({ id: OWNER_ID, email: 'memory-notice-owner@example.test' });
  const ownerSession = buildSessionFixture({ id: OWNER_SESSION_ID, userId: OWNER_ID });
  const peerSession = buildSessionFixture({ id: PEER_SESSION_ID, userId: PEER_ID });
  const revokedUser = buildUserFixture({ id: 84_103, email: 'memory-notice-revoked@example.test' });
  const revokedSession = buildSessionFixture({
    id: 84_203,
    userId: revokedUser.id,
    revoked_at: '2026-01-15T07:00:00.000Z',
    revoked_reason: 'logout',
  });
  await insertAccount(revokedUser, revokedSession, 2);
  await setNoticeVersion(OWNER_ID, 2);
  await setNoticeVersion(revokedUser.id, 2);
  const ownerEntryId = await insertMemory(OWNER_ID, 'kept entry', 'Food');
  const revokedEntryId = await insertMemory(revokedUser.id, 'revoked entry', 'Food');

  const credentials = [
    ['no Authorization header', null, 'Missing token'],
    ['an empty bearer token', 'Bearer ', 'Missing token'],
    ['a non-bearer scheme', 'Basic b3duZXI6cGFzc3dvcmQ=', 'Missing token'],
    ['a malformed token', 'Bearer not-a-jwt', 'Invalid token'],
    [
      'a token signed with another secret',
      `Bearer ${jwt.sign({ sub: String(OWNER_ID), tv: 1, sid: OWNER_SESSION_ID }, 'another-secret-of-24-characters!!', { algorithm: 'HS256' })}`,
      'Invalid token',
    ],
    ['an expired token', `Bearer ${tokenFor(owner, ownerSession, {}, { expiresIn: -60 })}`, 'Invalid token'],
    ['a token for an unsigned algorithm', `Bearer ${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(`{"sub":"${OWNER_ID}","tv":1,"sid":${OWNER_SESSION_ID}}`).toString('base64url')}.`, 'Invalid token'],
    ['a stale token version', `Bearer ${tokenFor(owner, ownerSession, { tv: 99 })}`, 'Session was invalidated. Please sign in again.'],
    ['a token with no session', `Bearer ${tokenFor(owner, ownerSession, { sid: undefined })}`, 'Session expired. Please sign in again.'],
    ["a session that belongs to another user", `Bearer ${tokenFor(owner, peerSession)}`, 'Session expired. Please sign in again.'],
    ['an unknown user', `Bearer ${tokenFor({ id: 999_999, token_version: 1 }, ownerSession)}`, 'Session expired. Please sign in again.'],
    [
      'a revoked session',
      `Bearer ${tokenFor(revokedUser, revokedSession)}`,
      'This session was signed out.',
    ],
  ];

  const routes = [
    ['get', '/api/finance/quick-add/hints', undefined],
    ['put', '/api/finance/category-memory', { noteKey: 'new entry', category: 'Food' }],
    ['delete', `/api/finance/category-memory/${ownerEntryId}`, undefined],
    ['delete', `/api/finance/category-memory/${revokedEntryId}`, undefined],
    ['delete', '/api/finance/category-memory', undefined],
  ];

  for (const [label, header, message] of credentials) {
    for (const [method, path, body] of routes) {
      let pending = request(app)[method](path);
      if (header !== null) pending = pending.set('Authorization', header);
      const response = await (body === undefined ? pending : pending.send(body));
      assert.equal(response.status, 401, `${method.toUpperCase()} ${path} with ${label} answered ${response.status}`);
      assert.equal(response.body.error, message, `${method.toUpperCase()} ${path} with ${label}`);
      assert.equal(response.headers['access-control-allow-origin'], undefined);
    }
  }

  // No rejected request read, wrote, or deleted anything.
  assert.deepEqual((await memoryRows(OWNER_ID)).map((row) => row.note_key), ['kept entry']);
  assert.deepEqual((await memoryRows(revokedUser.id)).map((row) => row.note_key), ['revoked entry']);

  // A live session on the same app still works, so the failures above are credential failures.
  const live = await as('get', '/api/finance/quick-add/hints');
  assert.equal(live.status, 200);
});

// ---------------------------------------------------------------------------------------------------------------
// Cross-user read, write, and delete (15.3, 15.4, 15.9)
// ---------------------------------------------------------------------------------------------------------------

test('another user cannot read, overwrite, or delete an entry, and every answer is the same as for a missing entry', async () => {
  setFlag(true);
  await setNoticeVersion(OWNER_ID, 2);
  await setNoticeVersion(PEER_ID, 2);
  await db.prepare('INSERT INTO user_categories (user_id, name) VALUES (?, ?)').run(PEER_ID, 'Peer Garden');
  const peerSharedId = await insertMemory(PEER_ID, 'shared note', 'Peer Garden', 3, '2026-02-02T00:00:00.000Z');
  const peerOnlyId = await insertMemory(PEER_ID, 'peer only note', 'Health', 2, '2026-02-03T00:00:00.000Z');
  const peerBefore = plain(await memoryRows(PEER_ID));
  // Row IDs are small integers that match unrelated text, so ID secrecy is asserted by the byte-identical
  // foreign-versus-missing comparison below, not by a substring search.
  const peerSecrets = ['peer only note', 'Peer Garden', 'Health', 'memory-notice-peer'];
  const responses = [];

  // Write: the owner's expected revision matches the PEER's stored revision for the same key.
  const probeBody = { noteKey: 'shared note', category: 'Food', expectedRevision: 3 };
  const foreignProbe = await as('put', '/api/finance/category-memory').send(probeBody);
  const missingProbe = await as('put', '/api/finance/category-memory')
    .send({ ...probeBody, noteKey: 'nobody has this note' });
  assert.equal(foreignProbe.status, 409);
  assert.equal(foreignProbe.body.error.code, 'MEMORY_REVISION_CONFLICT');
  assert.deepEqual(foreignProbe.body, missingProbe.body, 'a foreign key answers as a missing key');
  assert.equal(await memoryCount(OWNER_ID), 0, 'a conflict creates nothing for the owner');
  responses.push(foreignProbe.body, missingProbe.body);

  // Write: the owner saves the same Note_Key without a revision and gets a separate entry.
  const ownerWrite = await as('put', '/api/finance/category-memory')
    .send({ noteKey: 'shared note', category: 'Food' });
  assert.equal(ownerWrite.status, 200);
  assert.equal(ownerWrite.body.created, true);
  assert.equal(ownerWrite.body.entry.revision, 1);
  assert.notEqual(ownerWrite.body.entry.id, peerSharedId);
  assert.equal(JSON.stringify(ownerWrite.body).includes('Peer Garden'), false);
  assert.deepEqual(plain(await memoryRows(PEER_ID)), peerBefore, 'the owner write never touches the peer entry');

  // Write: a category that exists only for the peer is not available to the owner.
  const peerCategory = await as('put', '/api/finance/category-memory')
    .send({ noteKey: 'garden', category: 'Peer Garden' });
  assert.equal(peerCategory.status, 422);
  assert.equal(peerCategory.body.error.code, 'UNKNOWN_EXPENSE_CATEGORY');
  responses.push(peerCategory.body);

  // Delete: foreign and missing identifiers, with and without a matching revision, answer identically.
  const deleteAttempts = [
    [`/api/finance/category-memory/${peerSharedId}`, `/api/finance/category-memory/987654321`],
    [
      `/api/finance/category-memory/${peerSharedId}?expectedRevision=3`,
      `/api/finance/category-memory/987654321?expectedRevision=3`,
    ],
    [
      `/api/finance/category-memory/${peerOnlyId}?expectedRevision=2`,
      `/api/finance/category-memory/987654322?expectedRevision=2`,
    ],
  ];
  for (const [foreignPath, missingPath] of deleteAttempts) {
    const foreign = await as('delete', foreignPath);
    const missing = await as('delete', missingPath);
    assert.equal(foreign.status, 404, foreignPath);
    assert.equal(missing.status, 404, missingPath);
    assert.deepEqual(foreign.body, missing.body);
    assert.equal(foreign.body.error.code, 'MEMORY_NOT_FOUND');
    assert.equal(foreign.headers['content-type'], missing.headers['content-type']);
    assert.equal(foreign.headers['content-length'], missing.headers['content-length']);
    responses.push(foreign.body, missing.body);
  }
  const unparseableIds = ['0', '-1', '1.5', '1e3', 'abc', '9007199254740993', '%20'];
  const reference = await as('delete', '/api/finance/category-memory/987654321');
  for (const id of unparseableIds) {
    const response = await as('delete', `/api/finance/category-memory/${id}`);
    assert.equal(response.status, 404, `id ${id}`);
    assert.deepEqual(response.body, reference.body, `id ${id}`);
  }
  assert.deepEqual(plain(await memoryRows(PEER_ID)), peerBefore, 'no delete attempt touches the peer entries');

  // Read: each user's hints contain only that user's memory and history.
  const ownerExpense = await insertExpense(OWNER_ID, { category: 'Food', note: 'Shared Note', amount: 41_234.56 });
  await insertExpense(PEER_ID, { category: 'Peer Garden', note: 'Peer History Secret', amount: 98_765.43 });
  await insertExpense(OWNER_ID, {
    category: 'Shopping',
    note: 'Too Old Owner Note',
    spentOn: daysBefore(today, 120),
  });
  const ownerHints = await as('get', '/api/finance/quick-add/hints');
  const peerHints = await as('get', '/api/finance/quick-add/hints', peerAuthorization);
  assert.equal(ownerHints.status, 200);
  assert.equal(peerHints.status, 200);
  assert.deepEqual(ownerHints.body.memory.map((entry) => [entry.noteKey, entry.category, entry.revision]), [
    ['shared note', 'Food', 1],
  ]);
  assert.deepEqual(ownerHints.body.history, [{ noteKey: 'shared note', category: 'Food', lastSpentOn: today }]);
  assert.deepEqual(
    peerHints.body.memory.map((entry) => [entry.noteKey, entry.category, entry.revision]).sort(),
    [['peer only note', 'Health', 2], ['shared note', 'Peer Garden', 3]].sort()
  );
  assert.deepEqual(peerHints.body.history, [{
    noteKey: 'peer history secret',
    category: 'Peer Garden',
    lastSpentOn: today,
  }]);
  assertNoLeak(ownerHints.body, ['peer only note', 'Peer Garden', 'Health', 'Peer History', '98765', '41234']);
  assertNoLeak(peerHints.body, ['Too Old', 'Shopping', '41234', '98765']);
  assert.ok(ownerExpense > 0);

  // Delete-all by the owner removes only the owner's entries.
  const deletedAll = await as('delete', '/api/finance/category-memory');
  assert.deepEqual(deletedAll.body, { schemaVersion: 1, deleted: 1 });
  assert.deepEqual(plain(await memoryRows(PEER_ID)), peerBefore);
  const peerDeletedAll = await as('delete', '/api/finance/category-memory', peerAuthorization);
  assert.deepEqual(peerDeletedAll.body, { schemaVersion: 1, deleted: 2 });
  assert.equal(await memoryCount(OWNER_ID), 0);

  for (const body of responses) assertNoLeak(body, peerSecrets);
});

// ---------------------------------------------------------------------------------------------------------------
// Disabled answer and the 428 gate (15.13, 16.19)
// ---------------------------------------------------------------------------------------------------------------

test('with the server flag off every write answers 404 QUICK_ADD_DISABLED whatever the body or acknowledgement', async () => {
  const disabled = {
    error: { code: 'QUICK_ADD_DISABLED', message: 'Quick Add category memory is unavailable.' },
  };
  const entryId = await insertMemory(OWNER_ID, 'existing entry', 'Food');

  const flagValues = [undefined, '', 'false', '0', 'off', 'yes', 'enabled'];
  for (const flag of flagValues) {
    if (flag === undefined) delete process.env.QUICK_ADD_ENABLED;
    else process.env.QUICK_ADD_ENABLED = flag;
    for (const version of [0, 1, 2]) {
      await setNoticeVersion(OWNER_ID, version);
      for (const body of [
        { noteKey: 'tea', category: 'Food' },
        { noteKey: ' Not Normalized ', category: 'Unknown category', extra: true },
        { noteKey: 'tea', category: 'Food', expectedRevision: 7 },
      ]) {
        const response = await as('put', '/api/finance/category-memory').send(body);
        assert.equal(response.status, 404, `flag ${String(flag)} acknowledged ${version}`);
        assert.deepEqual(response.body, disabled);
      }
    }
  }
  assert.deepEqual((await memoryRows(OWNER_ID)).map((row) => row.note_key), ['existing entry']);

  // Reads and both deletes stay available, whatever the acknowledged version.
  await setNoticeVersion(OWNER_ID, 0);
  const hints = await as('get', '/api/finance/quick-add/hints');
  assert.equal(hints.status, 200);
  assert.equal(hints.body.memory.length, 1);
  assert.deepEqual((await as('delete', `/api/finance/category-memory/${entryId}`)).body, {
    schemaVersion: 1,
    deleted: true,
  });
  await insertMemory(OWNER_ID, 'another', 'Food');
  assert.deepEqual((await as('delete', '/api/finance/category-memory')).body, { schemaVersion: 1, deleted: 1 });
});

test('the 428 gate names both versions, protects only the write, and is satisfied by the real acknowledgement route', async () => {
  setFlag(true);
  const entryId = await insertMemory(OWNER_ID, 'existing entry', 'Food');
  const gateBody = (acknowledged) => ({
    error: {
      code: 'DATA_NOTICE_REQUIRED',
      message: 'Review and acknowledge the current data-use notice before submitting this financial command.',
      requiredNoticeVersion: 2,
      currentNoticeVersion: 2,
      acknowledgedNoticeVersion: acknowledged,
      settingsPath: '/api/clarity/settings',
    },
  });

  for (const acknowledged of [0, 1]) {
    await setNoticeVersion(OWNER_ID, acknowledged);
    const blocked = await as('put', '/api/finance/category-memory')
      .send({ noteKey: 'new entry', category: 'Food' });
    assert.equal(blocked.status, 428);
    assert.deepEqual(blocked.body, gateBody(acknowledged));
    const blockedReplace = await as('put', '/api/finance/category-memory')
      .send({ noteKey: 'existing entry', category: 'Transport', expectedRevision: 1 });
    assert.equal(blockedReplace.status, 428);
    assert.equal(blockedReplace.body.error.code, 'DATA_NOTICE_REQUIRED');
  }
  assert.deepEqual(plain(await memoryRows(OWNER_ID)).map((row) => [row.note_key, row.category, row.revision]), [
    ['existing entry', 'Food', 1],
  ]);

  // The same acknowledgement level reads, but a gate is per user: the peer is already at version 2.
  assert.equal((await as('get', '/api/finance/quick-add/hints')).status, 200);
  await setNoticeVersion(PEER_ID, 2);
  const peerWrite = await as('put', '/api/finance/category-memory', peerAuthorization)
    .send({ noteKey: 'peer entry', category: 'Food' });
  assert.equal(peerWrite.status, 200);
  assert.equal((await as('put', '/api/finance/category-memory').send({ noteKey: 'x', category: 'Food' })).status, 428);

  // An out-of-date acknowledgement is refused by the settings route; the current one opens the gate.
  const staleAck = await acknowledge(1);
  assert.equal(staleAck.status, 400);
  assert.equal(staleAck.body.error.code, 'INVALID_NOTICE_VERSION');
  assert.equal(staleAck.body.error.currentNoticeVersion, 2);
  assert.equal((await as('put', '/api/finance/category-memory').send({ noteKey: 'x', category: 'Food' })).status, 428);

  const ack = await acknowledge(2);
  assert.equal(ack.status, 200);
  assert.equal(ack.body.dataUseNotice.acknowledgementRequired, false);
  const opened = await as('put', '/api/finance/category-memory').send({ noteKey: 'x', category: 'Food' });
  assert.equal(opened.status, 200);
  assert.equal(opened.body.created, true);

  // The existing entry could be deleted at every level.
  assert.deepEqual((await as('delete', `/api/finance/category-memory/${entryId}`)).body, {
    schemaVersion: 1,
    deleted: true,
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Revision, replay, cap, delete-all (6.9, 15.14)
// ---------------------------------------------------------------------------------------------------------------

test('revision checks never recreate a deleted entry, replays are stable, and a stale write loses to a concurrent winner', async () => {
  setFlag(true);
  await setNoticeVersion(OWNER_ID, 2);

  const missing = await as('put', '/api/finance/category-memory')
    .send({ noteKey: 'never saved', category: 'Food', expectedRevision: 1 });
  assert.equal(missing.status, 409);
  assert.equal(missing.body.error.code, 'MEMORY_REVISION_CONFLICT');
  assert.equal(await memoryCount(OWNER_ID), 0, 'an expected revision never creates an entry');

  const created = await as('put', '/api/finance/category-memory').send({ noteKey: 'coffee', category: 'Food' });
  assert.equal(created.status, 200);
  const stored = plain(await memoryRows(OWNER_ID));
  for (const category of ['Food', 'food', ' FOOD ']) {
    const replay = await as('put', '/api/finance/category-memory').send({ noteKey: 'coffee', category });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.created, false);
    assert.equal(replay.body.evicted, false);
    assert.deepEqual(replay.body.entry, created.body.entry);
  }
  assert.deepEqual(plain(await memoryRows(OWNER_ID)), stored, 'replays change no stored value');

  const parallelReplays = await Promise.all(
    Array.from({ length: 5 }, () => as('put', '/api/finance/category-memory').send({ noteKey: 'tea', category: 'Food' }))
  );
  assert.deepEqual(parallelReplays.map((response) => response.status), [200, 200, 200, 200, 200]);
  const teaRows = (await memoryRows(OWNER_ID)).filter((row) => row.note_key === 'tea');
  assert.equal(teaRows.length, 1);
  assert.equal(Number(teaRows[0].revision), 1);

  const racers = await Promise.all([
    as('put', '/api/finance/category-memory').send({ noteKey: 'coffee', category: 'Transport', expectedRevision: 1 }),
    as('put', '/api/finance/category-memory').send({ noteKey: 'coffee', category: 'Shopping', expectedRevision: 1 }),
  ]);
  assert.deepEqual(racers.map((response) => response.status).sort(), [200, 409]);
  const coffee = (await memoryRows(OWNER_ID)).find((row) => row.note_key === 'coffee');
  assert.equal(Number(coffee.revision), 2, 'exactly one writer won');

  // Delete: a stale revision loses, the current one wins, and a replayed delete is a plain 404.
  const stale = await as('delete', `/api/finance/category-memory/${coffee.id}?expectedRevision=1`);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'MEMORY_REVISION_CONFLICT');
  assert.equal(await memoryCount(OWNER_ID), 2);
  const deleted = await as('delete', `/api/finance/category-memory/${coffee.id}?expectedRevision=2`);
  assert.deepEqual(deleted.body, { schemaVersion: 1, deleted: true });
  const replayedDelete = await as('delete', `/api/finance/category-memory/${coffee.id}?expectedRevision=2`);
  assert.equal(replayedDelete.status, 404);
  assert.equal(replayedDelete.body.error.code, 'MEMORY_NOT_FOUND');

  // An undo after a delete cannot bring the entry back.
  const undoAfterDelete = await as('put', '/api/finance/category-memory')
    .send({ noteKey: 'coffee', category: 'Food', expectedRevision: 2 });
  assert.equal(undoAfterDelete.status, 409);
  assert.equal((await memoryRows(OWNER_ID)).some((row) => row.note_key === 'coffee'), false);
});

test('the 500-entry cap is per user, evicts only the least recent entry, and never evicts on a replay or a change', async () => {
  setFlag(true);
  await setNoticeVersion(OWNER_ID, 2);
  await setNoticeVersion(PEER_ID, 2);
  const seeds = [];
  for (let index = 0; index < MEMORY_LIMIT - 1; index += 1) {
    const stamp = new Date(Date.UTC(2025, 0, 1, 0, 0, index)).toISOString();
    seeds.push({
      sql: `INSERT INTO category_memory (user_id, note_key, category, revision, created_at, updated_at)
            VALUES (?, ?, 'Food', 1, ?, ?)`,
      args: [OWNER_ID, `seed ${String(index).padStart(3, '0')}`, stamp, stamp],
    });
  }
  // The peer's entries are older than every owner entry, so a user-blind eviction would take them first.
  for (let index = 0; index < 3; index += 1) {
    seeds.push({
      sql: `INSERT INTO category_memory (user_id, note_key, category, revision, created_at, updated_at)
            VALUES (?, ?, 'Food', 1, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')`,
      args: [PEER_ID, `peer seed ${index}`],
    });
  }
  await db.batch(seeds);
  const peerBefore = plain(await memoryRows(PEER_ID));
  assert.equal(await memoryCount(OWNER_ID), MEMORY_LIMIT - 1);

  // The 500th entry fits without eviction.
  const fiveHundredth = await as('put', '/api/finance/category-memory')
    .send({ noteKey: 'entry 500', category: 'Food' });
  assert.equal(fiveHundredth.status, 200);
  assert.equal(fiveHundredth.body.created, true);
  assert.equal(fiveHundredth.body.evicted, false);
  assert.equal(await memoryCount(OWNER_ID), MEMORY_LIMIT);

  // A replay and a category change of an existing key at the cap evict nothing.
  const replay = await as('put', '/api/finance/category-memory').send({ noteKey: 'entry 500', category: 'Food' });
  assert.equal(replay.body.evicted, false);
  const changed = await as('put', '/api/finance/category-memory')
    .send({ noteKey: 'seed 250', category: 'Transport', expectedRevision: 1 });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.created, false);
  assert.equal(changed.body.evicted, false);
  assert.equal(await memoryCount(OWNER_ID), MEMORY_LIMIT);

  // Two new keys evict the two least recently updated owner entries, in order.
  for (const [noteKey, gone] of [['entry 501', 'seed 000'], ['entry 502', 'seed 001']]) {
    const response = await as('put', '/api/finance/category-memory').send({ noteKey, category: 'Food' });
    assert.equal(response.status, 200);
    assert.equal(response.body.created, true);
    assert.equal(response.body.evicted, true);
    assert.equal(await memoryCount(OWNER_ID), MEMORY_LIMIT);
    assert.equal(
      await db.prepare('SELECT 1 AS present FROM category_memory WHERE user_id = ? AND note_key = ?').get(OWNER_ID, gone),
      undefined,
      `${gone} was the least recent`
    );
    assert.ok(
      await db.prepare('SELECT 1 AS present FROM category_memory WHERE user_id = ? AND note_key = ?').get(OWNER_ID, noteKey),
      `${noteKey} was kept`
    );
  }
  assert.ok(
    await db.prepare('SELECT 1 AS present FROM category_memory WHERE user_id = ? AND note_key = ?').get(OWNER_ID, 'seed 250'),
    'a recently changed entry is not the least recent'
  );
  assert.deepEqual(plain(await memoryRows(PEER_ID)), peerBefore, 'the cap never evicts another user\'s entry');

  const hints = await as('get', '/api/finance/quick-add/hints');
  assert.equal(hints.body.memory.length, MEMORY_LIMIT);
  assert.equal(hints.body.limits.memoryEntries, MEMORY_LIMIT);
  assert.equal(hints.body.memory[0].noteKey, 'entry 502', 'the newest entry is listed first');

  // Delete-all frees the whole allowance, and the peer keeps its entries.
  const deletedAll = await as('delete', '/api/finance/category-memory');
  assert.deepEqual(deletedAll.body, { schemaVersion: 1, deleted: MEMORY_LIMIT });
  assert.equal(await memoryCount(OWNER_ID), 0);
  assert.deepEqual(plain(await memoryRows(PEER_ID)), peerBefore);
  const afterDeleteAll = await as('put', '/api/finance/category-memory').send({ noteKey: 'fresh', category: 'Food' });
  assert.equal(afterDeleteAll.body.evicted, false);
});

test('delete-all works at every notice level, is repeatable, and rejects a body or query without deleting', async () => {
  await insertMemory(OWNER_ID, 'coffee', 'Food');
  await insertMemory(OWNER_ID, 'tea', 'Food');
  await insertMemory(PEER_ID, 'peer coffee', 'Food');

  const withQuery = await as('delete', '/api/finance/category-memory?all=true');
  assert.equal(withQuery.status, 400);
  assert.equal(withQuery.body.error.code, 'INVALID_MEMORY_REQUEST');
  const withBody = await as('delete', '/api/finance/category-memory').send({ userId: PEER_ID });
  assert.equal(withBody.status, 400);
  assert.equal(await memoryCount(OWNER_ID), 2);
  assert.equal(await memoryCount(PEER_ID), 1);

  await setNoticeVersion(OWNER_ID, 0);
  const first = await as('delete', '/api/finance/category-memory');
  assert.deepEqual(first.body, { schemaVersion: 1, deleted: 2 });
  const second = await as('delete', '/api/finance/category-memory');
  assert.equal(second.status, 200);
  assert.deepEqual(second.body, { schemaVersion: 1, deleted: 0 });
  assert.equal(await memoryCount(PEER_ID), 1);
});

test('the Memory API shares the app-wide request limit with the finance routes', async () => {
  await insertMemory(OWNER_ID, 'coffee', 'Food');
  for (let index = 0; index < 120; index += 1) {
    const path = index % 2 === 0
      ? '/api/finance/quick-add/hints'
      : `/api/finance/expenses?month=${month}`;
    const response = await as('get', path);
    assert.equal(response.status, 200, `request ${index + 1}`);
  }
  const limited = await as('delete', '/api/finance/category-memory');
  assert.equal(limited.status, 429);
  assert.equal(await memoryCount(OWNER_ID), 1, 'a rate-limited delete-all deletes nothing');
});

// ---------------------------------------------------------------------------------------------------------------
// Notice version and acknowledgement across flag changes (16.20, 16.21, 16.22)
// ---------------------------------------------------------------------------------------------------------------

test('the notice is version 1 with the flag off and version 2 with it on, switching on the running app', async () => {
  const read = async () => (await as('get', '/api/clarity/settings')).body;

  setFlag(false);
  const off = await read();
  assert.equal(off.dataUseNotice.version, 1);
  assert.equal(off.schemaVersions.dataUseNotice, 1);
  assert.equal(off.dataUseNotice.acknowledgedVersion, 1);
  assert.equal(off.dataUseNotice.acknowledgementRequired, false);
  assert.equal(off.dataUseNotice.categories.some((category) => category.key === 'category_memory'), false);

  setFlag(true);
  const on = await read();
  assert.equal(on.dataUseNotice.version, 2);
  assert.equal(on.schemaVersions.dataUseNotice, 2);
  assert.equal(on.dataUseNotice.acknowledgedVersion, 1);
  assert.equal(on.dataUseNotice.acknowledgementRequired, true, 'each user who has not reviewed version 2 is asked once');
  assert.ok(on.dataUseNotice.categories.some((category) => category.key === 'category_memory'));

  setFlag(false);
  const offAgain = await read();
  assert.equal(offAgain.dataUseNotice.version, 1);
  assert.equal(offAgain.dataUseNotice.acknowledgementRequired, false);
});

test('a user who acknowledged only version 1 keeps reading, exporting, correcting, and deleting, and is blocked only from new inputs', async () => {
  const expenseId = await insertExpense(OWNER_ID, { category: 'Food', note: 'Morning Coffee', amount: 120 });
  const deletableId = await insertExpense(OWNER_ID, { category: 'Shopping', note: 'Delete me', amount: 80 });
  const memoryId = await insertMemory(OWNER_ID, 'morning coffee', 'Food');
  await insertMemory(OWNER_ID, 'delete me', 'Shopping');
  setFlag(true);

  const settings = await as('get', '/api/clarity/settings');
  assert.equal(settings.body.dataUseNotice.acknowledgedVersion, 1);
  assert.equal(settings.body.dataUseNotice.acknowledgementRequired, true);

  // Reading and export.
  const hints = await as('get', '/api/finance/quick-add/hints');
  assert.equal(hints.status, 200);
  assert.equal(hints.body.memory.length, 2);
  assert.equal(hints.body.history.length, 2);
  const list = await as('get', `/api/finance/expenses?month=${month}`);
  assert.equal(list.status, 200);
  assert.equal(list.body.expenses.length, 2);
  const exported = await as('get', '/api/auth/export');
  assert.equal(exported.status, 200);
  assert.deepEqual(exported.body.data.category_memory.map((entry) => entry.note_key).sort(), ['delete me', 'morning coffee']);
  assert.equal(exported.body.data.expenses.length, 2);

  // Correction of an existing expense.
  const corrected = await canonical('patch', `/api/finance/expenses/${expenseId}`)
    .send({ note: 'Morning Coffee Corrected', excludeFromDailyAllowance: true, expectedRecordVersion: 0 });
  assert.equal(corrected.status, 200, JSON.stringify(corrected.body));
  assert.equal(corrected.body.mutation.record.excludeFromDailyAllowance, true);

  // New inputs are blocked and write nothing.
  const expensesBefore = await expenseCount(OWNER_ID);
  const memoryBefore = plain(await memoryRows(OWNER_ID));
  const blockedExpense = await createExpense(ownerAuthorization);
  assert.equal(blockedExpense.status, 428);
  assert.equal(blockedExpense.body.error.code, 'DATA_NOTICE_REQUIRED');
  assert.equal(blockedExpense.body.error.requiredNoticeVersion, 2);
  assert.equal(blockedExpense.body.error.acknowledgedNoticeVersion, 1);
  const blockedMemory = await as('put', '/api/finance/category-memory')
    .send({ noteKey: 'new note', category: 'Food' });
  assert.equal(blockedMemory.status, 428);
  assert.equal(blockedMemory.body.error.requiredNoticeVersion, 2);
  assert.equal(await expenseCount(OWNER_ID), expensesBefore);
  assert.deepEqual(plain(await memoryRows(OWNER_ID)), memoryBefore);

  // Deletion of existing records.
  const deletedExpense = await as('delete', `/api/finance/expenses/${deletableId}`);
  assert.deepEqual(deletedExpense.body, { ok: true });
  const deletedMemory = await as('delete', `/api/finance/category-memory/${memoryId}?expectedRevision=1`);
  assert.deepEqual(deletedMemory.body, { schemaVersion: 1, deleted: true });
  const deletedRest = await as('delete', '/api/finance/category-memory');
  assert.deepEqual(deletedRest.body, { schemaVersion: 1, deleted: 1 });
  assert.equal(await expenseCount(OWNER_ID), 1);

  // The one acknowledgement opens both new inputs.
  assert.equal((await acknowledge(2)).status, 200);
  assert.equal((await createExpense(ownerAuthorization)).status, 200);
  assert.equal(
    (await as('put', '/api/finance/category-memory').send({ noteKey: 'new note', category: 'Food' })).status,
    200
  );
});

test('turning the flag off or on again never re-prompts a user who acknowledged version 2', async () => {
  const statuses = [];
  const tracked = (response) => {
    statuses.push(response.status);
    return response;
  };

  setFlag(true);
  const ack = tracked(await acknowledge(2));
  assert.equal(ack.status, 200);
  assert.equal(ack.body.dataUseNotice.acknowledgementRequired, false);
  const savedMemory = tracked(await as('put', '/api/finance/category-memory').send({ noteKey: 'coffee', category: 'Food' }));
  assert.equal(savedMemory.status, 200);

  // Flag off: version 1 notice, no prompt, new financial inputs still accepted, memory writes disabled.
  setFlag(false);
  const settingsOff = tracked(await as('get', '/api/clarity/settings'));
  assert.equal(settingsOff.body.dataUseNotice.version, 1);
  assert.equal(settingsOff.body.dataUseNotice.acknowledgedVersion, 2);
  assert.equal(settingsOff.body.dataUseNotice.acknowledgementRequired, false);
  const expenseOff = tracked(await createExpense(ownerAuthorization, { note: 'while off' }));
  assert.equal(expenseOff.status, 200, JSON.stringify(expenseOff.body));
  const writeOff = tracked(await as('put', '/api/finance/category-memory').send({ noteKey: 'tea', category: 'Food' }));
  assert.equal(writeOff.status, 404);
  assert.equal(writeOff.body.error.code, 'QUICK_ADD_DISABLED');
  const hintsOff = tracked(await as('get', '/api/finance/quick-add/hints'));
  assert.equal(hintsOff.body.memory.length, 1, 'the entry survives the flag change');

  // Acknowledging version 1 while the flag is off cannot lower the stored acknowledgement.
  const ackOne = tracked(await acknowledge(1));
  assert.equal(ackOne.status, 200);
  assert.equal(ackOne.body.dataUseNotice.acknowledgedVersion, 2);
  const analytics = tracked(await as('patch', '/api/clarity/settings').send({ analyticsEnabled: true }));
  assert.equal(analytics.status, 200);

  // Flag on again: the same acknowledgement still satisfies version 2.
  setFlag(true);
  const settingsOn = tracked(await as('get', '/api/clarity/settings'));
  assert.equal(settingsOn.body.dataUseNotice.version, 2);
  assert.equal(settingsOn.body.dataUseNotice.acknowledgedVersion, 2);
  assert.equal(settingsOn.body.dataUseNotice.acknowledgementRequired, false);
  const expenseOn = tracked(await createExpense(ownerAuthorization, { note: 'while on again' }));
  assert.equal(expenseOn.status, 200, JSON.stringify(expenseOn.body));
  const writeOn = tracked(await as('put', '/api/finance/category-memory').send({ noteKey: 'tea', category: 'Food' }));
  assert.equal(writeOn.status, 200);

  assert.equal(statuses.includes(428), false, 'no response asked the user to review the notice again');

  // A user who never reached version 2 is asked only while the flag is on; the answer depends on the flag, not on history.
  setFlag(false);
  assert.equal((await as('get', '/api/clarity/settings', peerAuthorization)).body.dataUseNotice.acknowledgementRequired, false);
  setFlag(true);
  assert.equal((await as('get', '/api/clarity/settings', peerAuthorization)).body.dataUseNotice.acknowledgementRequired, true);
});

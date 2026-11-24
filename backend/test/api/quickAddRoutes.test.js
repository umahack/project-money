import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { buildSessionFixture, buildUserFixture } from '../helpers/fixtures.js';
import { collectRoutes, routeKey } from '../helpers/routeInventory.js';
import { createIsolatedTestDatabase } from '../helpers/testDatabase.js';

const OWNER_ID = 82_101;
const PEER_ID = 82_102;
const OWNER_SESSION_ID = 82_201;
const PEER_SESSION_ID = 82_202;
const MEMORY_LIMIT = 500;

let testDatabase;
let db;
let app;
let ownerAuthorization;
let peerAuthorization;
let today;
let capturedLogs;

function tokenFor(user, session) {
  return jwt.sign(
    { sub: String(user.id), tv: user.token_version, sid: session.id },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '5m' }
  );
}

async function insertAccount(user, session, noticeVersion = 1) {
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
  await db.prepare(
    `INSERT INTO user_financial_state
      (user_id, data_use_notice_version, data_use_acknowledged_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)`
  ).run(user.id, noticeVersion);
}

async function setNoticeVersion(userId, version) {
  await db.prepare(
    `UPDATE user_financial_state
        SET data_use_notice_version = ?, data_use_acknowledged_at = CURRENT_TIMESTAMP
      WHERE user_id = ?`
  ).run(version, userId);
}

async function insertMemory(userId, noteKey, category, revision = 1, timestamp = '2026-01-01T00:00:00.000Z') {
  const result = await db.prepare(
    `INSERT INTO category_memory
      (user_id, note_key, category, revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(userId, noteKey, category, revision, timestamp, timestamp);
  return Number(result.lastInsertRowid);
}

async function memoryCount(userId) {
  const row = await db.prepare('SELECT COUNT(*) AS count FROM category_memory WHERE user_id = ?').get(userId);
  return Number(row.count);
}

function authenticated(method, path, authorization = ownerAuthorization) {
  return request(app)[method](path).set('Authorization', authorization);
}

async function enableWrites(userId = OWNER_ID) {
  process.env.QUICK_ADD_ENABLED = 'true';
  await setNoticeVersion(userId, 2);
}

before(async () => {
  testDatabase = await createIsolatedTestDatabase();
  db = testDatabase.db;
  const [{ createApp }, { kolkataDateOf }] = await Promise.all([
    import('../../src/app.js'),
    import('../../src/domain/kolkataTime.js'),
  ]);
  capturedLogs = [];
  const capture = (level) => (fields) => capturedLogs.push(JSON.stringify({ level, ...fields }));
  app = createApp({
    operationalLogger: {
      debug: capture('debug'),
      info: capture('info'),
      warn: capture('warn'),
      error: capture('error'),
    },
  });
  today = kolkataDateOf(new Date());
});

beforeEach(async () => {
  await testDatabase.reset();
  process.env.QUICK_ADD_ENABLED = 'false';
  capturedLogs.length = 0;

  const owner = buildUserFixture({ id: OWNER_ID, email: 'quick-add-owner@example.test' });
  const peer = buildUserFixture({ id: PEER_ID, email: 'quick-add-peer@example.test' });
  const ownerSession = buildSessionFixture({ id: OWNER_SESSION_ID, userId: OWNER_ID });
  const peerSession = buildSessionFixture({ id: PEER_SESSION_ID, userId: PEER_ID });
  await insertAccount(owner, ownerSession);
  await insertAccount(peer, peerSession);
  ownerAuthorization = `Bearer ${tokenFor(owner, ownerSession)}`;
  peerAuthorization = `Bearer ${tokenFor(peer, peerSession)}`;
});

afterEach(async () => {
  process.env.QUICK_ADD_ENABLED = 'false';
  await new Promise((resolve) => setImmediate(resolve));
});

after(async () => {
  await testDatabase?.cleanup();
});

test('all Memory API routes are inventoried behind the existing session gate', async () => {
  const routes = collectRoutes(app._router.stack);
  const expected = [
    'GET /api/finance/quick-add/hints',
    'PUT /api/finance/category-memory',
    'DELETE /api/finance/category-memory/:id',
    'DELETE /api/finance/category-memory',
  ];
  for (const key of expected) {
    const route = routes.find((candidate) => routeKey(candidate) === key);
    assert.ok(route, `${key} is registered`);
    assert.ok(route.guards.includes('authRequired'), `${key} requires authRequired`);
  }

  const anonymousResponses = await Promise.all([
    request(app).get('/api/finance/quick-add/hints'),
    request(app).put('/api/finance/category-memory').send({ noteKey: 'coffee', category: 'Food' }),
    request(app).delete('/api/finance/category-memory/1'),
    request(app).delete('/api/finance/category-memory'),
  ]);
  for (const response of anonymousResponses) assert.equal(response.status, 401);
});

test('hints, category availability, and record deletion stay isolated to the caller', async () => {
  await enableWrites();
  await db.prepare('INSERT INTO user_categories (user_id, name) VALUES (?, ?)').run(OWNER_ID, 'Pet Care');
  await db.prepare('INSERT INTO user_categories (user_id, name) VALUES (?, ?)').run(PEER_ID, 'Peer Only');

  const ownerMemoryId = await insertMemory(OWNER_ID, 'owner memory', 'Food');
  const peerMemoryId = await insertMemory(PEER_ID, 'peer memory secret', 'Peer Only');
  await db.prepare(
    `INSERT INTO expense_log (user_id, month, category, amount, note, spent_on)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(OWNER_ID, today.slice(0, 7), 'Food', 987654.32, 'Owner History Note', today);
  await db.prepare(
    `INSERT INTO expense_log (user_id, month, category, amount, note, spent_on)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(PEER_ID, today.slice(0, 7), 'Peer Only', 123456.78, 'Peer History Secret', today);

  const hints = await authenticated('get', '/api/finance/quick-add/hints');
  assert.equal(hints.status, 200);
  assert.deepEqual(Object.keys(hints.body).sort(), ['history', 'limits', 'memory', 'schemaVersion']);
  assert.deepEqual(hints.body.limits, {
    memoryEntries: 500,
    historyDays: 90,
    historyKeys: 500,
  });
  assert.deepEqual(hints.body.memory, [{
    id: ownerMemoryId,
    noteKey: 'owner memory',
    category: 'Food',
    revision: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
  }]);
  assert.deepEqual(hints.body.history, [{
    noteKey: 'owner history note',
    category: 'Food',
    lastSpentOn: today,
  }]);
  assert.equal(JSON.stringify(hints.body).includes('987654'), false, 'history exposes no amount');
  assert.equal(JSON.stringify(hints.body).includes('peer'), false, 'peer data stays private');

  const customCategory = await authenticated('put', '/api/finance/category-memory')
    .send({ noteKey: 'dog walk', category: 'pet care' });
  assert.equal(customCategory.status, 200);
  assert.equal(customCategory.body.entry.category, 'Pet Care');

  const peerOnlyCategory = await authenticated('put', '/api/finance/category-memory')
    .send({ noteKey: 'private category probe', category: 'Peer Only' });
  assert.equal(peerOnlyCategory.status, 422);
  assert.equal(peerOnlyCategory.body.error.code, 'UNKNOWN_EXPENSE_CATEGORY');
  assert.equal(Object.hasOwn(peerOnlyCategory.body.error, 'stack'), false);

  const foreignDelete = await authenticated('delete', `/api/finance/category-memory/${peerMemoryId}`);
  const missingDelete = await authenticated('delete', '/api/finance/category-memory/999999999');
  assert.equal(foreignDelete.status, 404);
  assert.equal(missingDelete.status, 404);
  assert.deepEqual(foreignDelete.body, missingDelete.body);
  assert.equal(foreignDelete.body.error.code, 'MEMORY_NOT_FOUND');
  assert.equal(await memoryCount(PEER_ID), 1);
});

test('the server flag disables only PUT while hints and both deletion routes remain available', async () => {
  const firstId = await insertMemory(OWNER_ID, 'coffee', 'Food');

  const hints = await authenticated('get', '/api/finance/quick-add/hints');
  assert.equal(hints.status, 200);
  assert.equal(hints.body.memory.length, 1);

  const disabled = await authenticated('put', '/api/finance/category-memory')
    .send({ noteKey: 'tea', category: 'Food' });
  assert.equal(disabled.status, 404);
  assert.deepEqual(disabled.body, {
    error: {
      code: 'QUICK_ADD_DISABLED',
      message: 'Quick Add category memory is unavailable.',
    },
  });
  assert.equal(await memoryCount(OWNER_ID), 1);

  const deletedOne = await authenticated('delete', `/api/finance/category-memory/${firstId}`);
  assert.deepEqual(deletedOne.body, { schemaVersion: 1, deleted: true });
  await insertMemory(OWNER_ID, 'tea', 'Food');
  await insertMemory(PEER_ID, 'peer tea', 'Food');
  const deletedAll = await authenticated('delete', '/api/finance/category-memory');
  assert.deepEqual(deletedAll.body, { schemaVersion: 1, deleted: 1 });
  assert.equal(await memoryCount(OWNER_ID), 0);
  assert.equal(await memoryCount(PEER_ID), 1);
});

test('notice version 2 gates PUT only and leaves reads and deletes available', async () => {
  process.env.QUICK_ADD_ENABLED = 'true';
  const memoryId = await insertMemory(OWNER_ID, 'coffee', 'Food');

  const write = await authenticated('put', '/api/finance/category-memory')
    .send({ noteKey: 'tea', category: 'Food' });
  assert.equal(write.status, 428);
  assert.equal(write.body.error.code, 'DATA_NOTICE_REQUIRED');
  assert.equal(write.body.error.requiredNoticeVersion, 2);
  assert.equal(write.body.error.acknowledgedNoticeVersion, 1);
  assert.equal(await memoryCount(OWNER_ID), 1);

  assert.equal((await authenticated('get', '/api/finance/quick-add/hints')).status, 200);
  assert.equal(
    (await authenticated('delete', `/api/finance/category-memory/${memoryId}`)).status,
    200
  );
});

test('closed schemas, normalized keys, prototype-like fields, and the 1 KB limit fail before writes', async () => {
  await enableWrites();

  const cases = [
    [{ noteKey: 'coffee', category: 'Food', unknown: true }, 'INVALID_MEMORY_REQUEST'],
    [{ noteKey: 'coffee', category: { name: 'Food' } }, 'INVALID_MEMORY_REQUEST'],
    [[{ noteKey: 'coffee', category: 'Food' }], 'INVALID_MEMORY_REQUEST'],
    [{ noteKey: ' Coffee ', category: 'Food' }, 'INVALID_NOTE_KEY'],
    [{ noteKey: 'coffee', category: 'Food', expectedRevision: null }, 'INVALID_MEMORY_REQUEST'],
  ];
  for (const [body, code] of cases) {
    const response = await authenticated('put', '/api/finance/category-memory').send(body);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, code);
  }

  const prototypeLike = await authenticated('put', '/api/finance/category-memory')
    .set('Content-Type', 'application/json')
    .send('{"noteKey":"coffee","category":"Food","__proto__":{"polluted":true}}');
  assert.equal(prototypeLike.status, 400);
  assert.equal(prototypeLike.body.error.code, 'INVALID_MEMORY_REQUEST');

  const oversized = await authenticated('put', '/api/finance/category-memory')
    .send({ noteKey: 'coffee', category: 'Food', padding: 'x'.repeat(1100) });
  assert.equal(oversized.status, 413);
  assert.equal(oversized.body.error.code, 'PAYLOAD_TOO_LARGE');
  assert.equal(await memoryCount(OWNER_ID), 0);

  const memoryId = await insertMemory(OWNER_ID, 'kept', 'Food');
  const deleteBody = await authenticated('delete', `/api/finance/category-memory/${memoryId}`)
    .send({ expectedRevision: 1 });
  assert.equal(deleteBody.status, 400);
  const deleteQuery = await authenticated(
    'delete',
    `/api/finance/category-memory/${memoryId}?unexpected=1`
  );
  assert.equal(deleteQuery.status, 400);
  const hintsQuery = await authenticated('get', '/api/finance/quick-add/hints?userId=1');
  assert.equal(hintsQuery.status, 400);
  assert.equal(await memoryCount(OWNER_ID), 1);
});

test('upserts are replay-safe and enforce revisions for changes and deletes', async () => {
  await enableWrites();

  const created = await authenticated('put', '/api/finance/category-memory')
    .send({ noteKey: 'coffee', category: 'food' });
  assert.equal(created.status, 200);
  assert.equal(created.body.created, true);
  assert.equal(created.body.entry.category, 'Food');
  assert.equal(created.body.entry.revision, 1);

  const replay = await authenticated('put', '/api/finance/category-memory')
    .send({ noteKey: 'coffee', category: 'FOOD' });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.created, false);
  assert.deepEqual(replay.body.entry, created.body.entry);

  const changed = await authenticated('put', '/api/finance/category-memory')
    .send({ noteKey: 'coffee', category: 'Transport', expectedRevision: 1 });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.entry.revision, 2);

  const stale = await authenticated('put', '/api/finance/category-memory')
    .send({ noteKey: 'coffee', category: 'Shopping', expectedRevision: 1 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'MEMORY_REVISION_CONFLICT');

  const staleDelete = await authenticated(
    'delete',
    `/api/finance/category-memory/${created.body.entry.id}?expectedRevision=1`
  );
  assert.equal(staleDelete.status, 409);
  assert.equal(staleDelete.body.error.code, 'MEMORY_REVISION_CONFLICT');

  const deleted = await authenticated(
    'delete',
    `/api/finance/category-memory/${created.body.entry.id}?expectedRevision=2`
  );
  assert.deepEqual(deleted.body, { schemaVersion: 1, deleted: true });
  assert.equal(await memoryCount(OWNER_ID), 0);
});

test('the 501st caller entry is saved while the least-recent entry is evicted', async () => {
  await enableWrites();
  const statements = [];
  for (let index = 0; index < MEMORY_LIMIT; index += 1) {
    const stamp = new Date(Date.UTC(2025, 0, 1, 0, 0, index)).toISOString();
    statements.push({
      sql: `INSERT INTO category_memory
        (user_id, note_key, category, revision, created_at, updated_at)
        VALUES (?, ?, 'Food', 1, ?, ?)`,
      args: [OWNER_ID, `seed ${String(index).padStart(3, '0')}`, stamp, stamp],
    });
  }
  await db.batch(statements);

  const response = await authenticated('put', '/api/finance/category-memory')
    .send({ noteKey: 'newest memory', category: 'Food' });
  assert.equal(response.status, 200);
  assert.equal(response.body.created, true);
  assert.equal(response.body.evicted, true);
  assert.equal(await memoryCount(OWNER_ID), MEMORY_LIMIT);
  assert.equal(
    await db.prepare('SELECT 1 AS present FROM category_memory WHERE user_id = ? AND note_key = ?')
      .get(OWNER_ID, 'seed 000'),
    undefined
  );
});

test('delete-all removes every caller entry and no peer entry', async () => {
  await insertMemory(OWNER_ID, 'coffee', 'Food');
  await insertMemory(OWNER_ID, 'tea', 'Food');
  await insertMemory(PEER_ID, 'peer coffee', 'Food');

  const response = await authenticated('delete', '/api/finance/category-memory');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { schemaVersion: 1, deleted: 2 });
  assert.equal(await memoryCount(OWNER_ID), 0);
  assert.equal(await memoryCount(PEER_ID), 1);
});

test('successful and failing Memory API logs contain no notes, keys, categories, or amounts', async () => {
  await enableWrites();
  const noteKeySecret = 'private-note-key-qa82';
  const categorySecret = 'Private Vault';
  const expenseNoteSecret = 'Private Expense Note QA82';
  const amountSecret = '731942.17';
  await db.prepare('INSERT INTO user_categories (user_id, name) VALUES (?, ?)')
    .run(OWNER_ID, categorySecret);

  const created = await authenticated('put', '/api/finance/category-memory')
    .send({ noteKey: noteKeySecret, category: categorySecret.toLowerCase() });
  assert.equal(created.status, 200);
  await db.prepare(
    `INSERT INTO expense_log (user_id, month, category, amount, note, spent_on)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(OWNER_ID, today.slice(0, 7), categorySecret, Number(amountSecret), expenseNoteSecret, today);
  assert.equal((await authenticated('get', '/api/finance/quick-add/hints')).status, 200);

  const conflict = await authenticated('put', '/api/finance/category-memory')
    .send({ noteKey: noteKeySecret, category: 'Food', expectedRevision: 99 });
  assert.equal(conflict.status, 409);
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(capturedLogs.length >= 3, 'the Memory API emits value-free operational records');
  const output = capturedLogs.join('\n');
  for (const sensitive of [
    noteKeySecret,
    categorySecret,
    categorySecret.toLowerCase(),
    expenseNoteSecret,
    amountSecret,
  ]) {
    assert.equal(output.includes(sensitive), false, `logs contain sensitive value: ${sensitive}`);
  }
});

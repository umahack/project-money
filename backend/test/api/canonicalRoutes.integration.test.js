/**
 * Cross-cutting integration coverage for the canonical Financial Clarity
 * routes. Route-specific behavior (goal bounds, salary apply, expense moves,
 * personal-link replay, settings, events, export/deletion) already has its own
 * suites; this file covers what only shows up across routes: the registered
 * route inventory, authentication/session handling, CORS, body limits, wrong
 * owners and trip roles, database-level atomicity, idempotency across commands,
 * public serializer stability, and monthly-review/clarity parity.
 *
 * Everything runs against one isolated file-backed database and loopback-only
 * listeners. No production credentials, remote database, or mail service is
 * reachable from here (see createIsolatedTestDatabase).
 */
import { after, afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createIsolatedTestDatabase } from '../helpers/testDatabase.js';
import { buildSessionFixture, buildUserFixture } from '../helpers/fixtures.js';
import {
  ANONYMOUS_ROUTE_ALLOWLIST,
  CRON_ROUTE_ALLOWLIST,
  collectRoutes,
  concretePath,
  listSourceFiles,
  routeKey,
} from '../helpers/routeInventory.js';

const SOURCE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

const OWNER_ID = 7101;
const MEMBER_ID = 7102;
const OUTSIDER_ID = 7103;
const PARITY_USER_ID = 7104;
const OWNER_SESSION_ID = 7201;
const OWNER_REVOKED_SESSION_ID = 7202;
const MEMBER_SESSION_ID = 7203;
const OUTSIDER_SESSION_ID = 7204;
const PARITY_SESSION_ID = 7205;
const TRIP_ID = 7301;
const OWNER_TRIP_MEMBER_ID = 7311;
const MEMBER_TRIP_MEMBER_ID = 7312;
const TRIP_EXPENSE_ID = 7401;
const PUBLIC_TOKEN = '7a7b7c7d7e7f70717273747576777879';
const OWNER_PRIVATE_BILL_LABEL = 'ZZ-owner-private-bill';
const OWNER_PRIVATE_GOAL_NAME = 'ZZ-owner-private-goal';
const CRON_SECRET = 'test-only-cron-secret-0123456789';

const CANONICAL_ROUTES_THAT_MUST_BE_REGISTERED = Object.freeze([
  'GET /api/finance/clarity',
  'GET /api/finance/explanations/:outcomeId',
  'POST /api/finance/salary',
  'POST /api/finance/salary/apply',
  'POST /api/finance/emis',
  'PATCH /api/finance/emis/:id',
  'DELETE /api/finance/emis/:id',
  'POST /api/finance/expenses',
  'PATCH /api/finance/expenses/:id',
  'DELETE /api/finance/expenses/:id',
  'GET /api/finance/quick-add/hints',
  'PUT /api/finance/category-memory',
  'DELETE /api/finance/category-memory/:id',
  'DELETE /api/finance/category-memory',
  'PUT /api/finance/category-treatments/:category',
  'DELETE /api/finance/category-treatments/:category',
  'POST /api/finance/goals',
  'PATCH /api/finance/goals/:id',
  'DELETE /api/finance/goals/:id',
  'POST /api/finance/goals/:id/contributions',
  'POST /api/trips/:id/members',
  'POST /api/trips/:id/expenses',
  'PUT /api/trips/:id/expenses/:expenseId/personal-link',
  'DELETE /api/trips/:id/expenses/:expenseId/personal-link',
  'GET /api/clarity/settings',
  'PATCH /api/clarity/settings',
  'POST /api/clarity/events',
  'GET /api/admin/clarity-reports',
]);

let testDatabase;
let db;
let createApp;
let defaultCorsOrigin;
let seeded;
const servers = [];

// ---------------------------------------------------------------- utilities

function monthAtOffset(offset) {
  const date = new Date();
  date.setDate(1);
  date.setMonth(date.getMonth() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function tokenFor(userId, sessionId, claims = {}, options = {}) {
  return jwt.sign(
    { sub: String(userId), tv: 1, sid: sessionId, ...claims },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '5m', ...options }
  );
}

const bearer = (userId, sessionId) => `Bearer ${tokenFor(userId, sessionId)}`;

function authFor(role) {
  if (role === 'owner') return bearer(OWNER_ID, OWNER_SESSION_ID);
  if (role === 'member') return bearer(MEMBER_ID, MEMBER_SESSION_ID);
  if (role === 'outsider') return bearer(OUTSIDER_ID, OUTSIDER_SESSION_ID);
  throw new Error(`Unknown role ${role}`);
}

/** Start the app on an explicit loopback address, never the wildcard address. */
async function startApp({ corsOrigin } = {}) {
  process.env.CORS_ORIGIN = corsOrigin ?? defaultCorsOrigin;
  const app = createApp();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  assert.equal(server.address().address, '127.0.0.1', 'test listeners must bind loopback only');
  servers.push(server);
  return server;
}

async function stopServer(server) {
  if (!server.listening) return;
  const closed = once(server, 'close');
  server.close();
  server.closeAllConnections();
  await closed;
}

function call(server, method, path, {
  auth,
  body,
  key,
  contract = false,
  origin,
  headers = {},
} = {}) {
  let builder = request(server)[method](path);
  if (auth) builder = builder.set('Authorization', auth);
  if (contract) builder = builder.set('X-Clarity-Contract', '1');
  if (key) builder = builder.set('Idempotency-Key', key);
  if (origin) builder = builder.set('Origin', origin);
  for (const [name, value] of Object.entries(headers)) builder = builder.set(name, value);
  return body === undefined ? builder : builder.send(body);
}

/** Canonical-contract call: contract header plus a fresh UUID unless supplied. */
function canonical(server, method, path, auth, body, key = randomUUID()) {
  return call(server, method, path, { auth, body, key, contract: true });
}

function assertNoWildcardOrigin(response, label = 'response') {
  assert.notEqual(
    response.headers['access-control-allow-origin'],
    '*',
    `${label} must never allow the wildcard origin`
  );
}

async function scalar(sql, ...args) {
  const row = await db.prepare(sql).get(...args);
  return row ? Number(Object.values(Object.fromEntries(Object.entries(row)))[0]) : null;
}

const FINGERPRINT_TABLES = Object.freeze([
  'users',
  'salary_entries',
  'emis',
  'expense_log',
  'savings_goals',
  'expense_category_treatments',
  'trips',
  'trip_members',
  'trip_expenses',
  'trip_expense_personal_links',
  'financial_record_changes',
  'user_financial_state',
  'product_measurement_events',
]);

/**
 * Serialized copy of every private table. `sessions` is excluded on purpose:
 * authRequired legitimately touches last_seen_at on each authenticated call.
 */
async function fingerprint() {
  const snapshot = {};
  for (const table of FINGERPRINT_TABLES) {
    const rows = await db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all();
    snapshot[table] = rows.map((row) => Object.fromEntries(Object.entries(row)));
  }
  return JSON.stringify(snapshot);
}

// ------------------------------------------------------------------ seeding

async function insertAccount(user, session) {
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
    `INSERT INTO user_financial_state
      (user_id, data_use_notice_version, data_use_acknowledged_at)
     VALUES (?, 1, CURRENT_TIMESTAMP)`
  ).run(user.id);
}

async function seedScenario() {
  const month = monthAtOffset(0);
  const previousMonth = monthAtOffset(-1);
  const owner = buildUserFixture({ id: OWNER_ID, email: 'canonical-owner@example.test', name: 'Owner' });
  const member = buildUserFixture({ id: MEMBER_ID, email: 'canonical-member@example.test', name: 'Member' });
  const outsider = buildUserFixture({ id: OUTSIDER_ID, email: 'canonical-outsider@example.test', name: 'Outsider' });
  const parity = buildUserFixture({ id: PARITY_USER_ID, email: 'canonical-parity@example.test', name: 'Parity' });
  await insertAccount(owner, buildSessionFixture({ id: OWNER_SESSION_ID, userId: OWNER_ID }));
  await db.prepare(
    `INSERT INTO sessions (id, user_id, device_label, ip_hash, user_agent, created_at, last_seen_at, revoked_at, revoked_reason)
     VALUES (?, ?, 'Revoked device', 'revoked-ip-hash-0001', 'ProjectMoneyTest/1.0', ?, ?, CURRENT_TIMESTAMP, 'user_logout')`
  ).run(OWNER_REVOKED_SESSION_ID, OWNER_ID, owner.created_at, owner.created_at);
  await insertAccount(member, buildSessionFixture({ id: MEMBER_SESSION_ID, userId: MEMBER_ID }));
  await insertAccount(outsider, buildSessionFixture({ id: OUTSIDER_SESSION_ID, userId: OUTSIDER_ID }));
  await insertAccount(parity, buildSessionFixture({ id: PARITY_SESSION_ID, userId: PARITY_USER_ID }));

  await db.prepare('INSERT INTO salary_entries (user_id, month, amount) VALUES (?, ?, ?)')
    .run(OWNER_ID, previousMonth, 40_000);
  const bill = await db.prepare(
    'INSERT INTO emis (user_id, label, amount, category) VALUES (?, ?, ?, ?)'
  ).run(OWNER_ID, OWNER_PRIVATE_BILL_LABEL, 9_876, 'Rent');
  const expense = await db.prepare(
    `INSERT INTO expense_log (user_id, month, category, amount, note, spent_on)
     VALUES (?, ?, 'Food', 123.45, 'owner expense', ?)`
  ).run(OWNER_ID, month, `${month}-02`);
  const goal = await db.prepare(
    `INSERT INTO savings_goals (user_id, name, target_amount, saved_amount, target_date)
     VALUES (?, ?, 1000, 250, ?)`
  ).run(OWNER_ID, OWNER_PRIVATE_GOAL_NAME, `${monthAtOffset(6)}-15`);

  await db.prepare(
    `INSERT INTO trips (id, user_id, name, destination, budget, start_date, end_date, public_token, public_enabled)
     VALUES (?, ?, 'Canonical trip', 'Pune', 5000, '2026-01-10', '2026-01-20', ?, 1)`
  ).run(TRIP_ID, OWNER_ID, PUBLIC_TOKEN);
  await db.prepare('INSERT INTO trip_members (id, trip_id, user_id, name, email) VALUES (?, ?, ?, ?, ?)')
    .run(OWNER_TRIP_MEMBER_ID, TRIP_ID, OWNER_ID, 'Owner', owner.email);
  await db.prepare('INSERT INTO trip_members (id, trip_id, user_id, name, email) VALUES (?, ?, ?, ?, ?)')
    .run(MEMBER_TRIP_MEMBER_ID, TRIP_ID, MEMBER_ID, 'Member', member.email);
  await db.prepare(
    `INSERT INTO trip_expenses (id, trip_id, payer, description, amount, split_json)
     VALUES (?, ?, 'Owner', 'Hotel', 100, ?)`
  ).run(
    TRIP_EXPENSE_ID,
    TRIP_ID,
    JSON.stringify([{ name: 'Owner', share: 1 }, { name: 'Member', share: 1 }])
  );

  return {
    month,
    previousMonth,
    nextMonth: monthAtOffset(1),
    billId: Number(bill.lastInsertRowid),
    expenseId: Number(expense.lastInsertRowid),
    goalId: Number(goal.lastInsertRowid),
  };
}

// --------------------------------------------------------------- route table

/** Every canonical and clarity route, addressed with the owner's real record IDs. */
function canonicalRouteTable() {
  const { month, previousMonth, billId, expenseId, goalId } = seeded;
  const spentOn = `${month}-03`;
  return [
    { name: 'clarity read', method: 'get', path: `/api/finance/clarity?month=${month}` },
    { name: 'explanation read', method: 'get', path: `/api/finance/explanations/monthly-plan:${month}` },
    { name: 'salary write', method: 'post', path: '/api/finance/salary', body: { amountMinor: 100, month } },
    { name: 'salary apply', method: 'post', path: '/api/finance/salary/apply', body: { sourceMonth: previousMonth, targetMonth: month } },
    { name: 'bill create', method: 'post', path: '/api/finance/emis', body: { label: 'New bill', amountMinor: 100, category: 'Rent' } },
    { name: 'bill edit', method: 'patch', path: `/api/finance/emis/${billId}`, body: { amountMinor: 100 } },
    { name: 'bill delete', method: 'delete', path: `/api/finance/emis/${billId}`, body: {} },
    { name: 'expense create', method: 'post', path: '/api/finance/expenses', body: { amountMinor: 100, category: 'Food', spentOn } },
    { name: 'expense edit', method: 'patch', path: `/api/finance/expenses/${expenseId}`, body: { amountMinor: 100 } },
    { name: 'expense delete', method: 'delete', path: `/api/finance/expenses/${expenseId}`, body: {} },
    { name: 'treatment set', method: 'put', path: '/api/finance/category-treatments/Food', body: { treatment: 'wants' } },
    { name: 'treatment clear', method: 'delete', path: '/api/finance/category-treatments/Food', body: {} },
    { name: 'goal create', method: 'post', path: '/api/finance/goals', body: { name: 'New goal', targetAmount: 100, targetDate: `${monthAtOffset(6)}-15` } },
    { name: 'goal edit', method: 'patch', path: `/api/finance/goals/${goalId}`, body: { name: 'Renamed' } },
    { name: 'goal delete', method: 'delete', path: `/api/finance/goals/${goalId}`, body: {} },
    { name: 'goal contribution', method: 'post', path: `/api/finance/goals/${goalId}/contributions`, body: { contributionMinor: 100 } },
    { name: 'trip member add', method: 'post', path: `/api/trips/${TRIP_ID}/members`, body: { name: 'Guest' } },
    {
      name: 'trip expense add',
      method: 'post',
      path: `/api/trips/${TRIP_ID}/expenses`,
      body: { payer: 'Owner', description: 'Taxi', amount: 10, split: [{ name: 'Owner', share: 1 }] },
    },
    { name: 'personal link include', method: 'put', path: `/api/trips/${TRIP_ID}/expenses/${TRIP_EXPENSE_ID}/personal-link`, body: { category: 'Travel', spentOn } },
    { name: 'personal link remove', method: 'delete', path: `/api/trips/${TRIP_ID}/expenses/${TRIP_EXPENSE_ID}/personal-link`, body: {} },
    { name: 'settings read', method: 'get', path: '/api/clarity/settings' },
    { name: 'settings update', method: 'patch', path: '/api/clarity/settings', body: { analyticsEnabled: false } },
    { name: 'event ingest', method: 'post', path: '/api/clarity/events', body: { type: 'journey_start' } },
  ];
}

// ------------------------------------------------------------------ lifecycle

before(async () => {
  testDatabase = await createIsolatedTestDatabase();
  db = testDatabase.db;
  defaultCorsOrigin = process.env.CORS_ORIGIN;
  process.env.FINANCIAL_MUTATION_HMAC_KEY =
    'test-only-canonical-integration-hmac-key-32-bytes';
  ({ createApp } = await import('../../src/app.js'));
});

beforeEach(async () => {
  await testDatabase.reset();
  seeded = await seedScenario();
});

afterEach(async () => {
  // authRequired updates last_seen_at without awaiting it.
  await new Promise((resolve) => setImmediate(resolve));
});

after(async () => {
  for (const server of servers) await stopServer(server);
  await testDatabase?.cleanup();
});

// ======================================================================
// Route inventory, listener, and alternate-authentication guards
// ======================================================================

test('every registered route is behind authRequired except a documented anonymous allowlist', () => {
  const routes = collectRoutes(createApp()._router.stack);
  const keys = routes.map(routeKey);
  assert.equal(new Set(keys).size, keys.length, 'a route is registered twice');

  for (const expected of CANONICAL_ROUTES_THAT_MUST_BE_REGISTERED) {
    assert.ok(keys.includes(expected), `inventory walker did not find ${expected}`);
  }
  assert.ok(routes.length >= 80, `inventory unexpectedly small (${routes.length})`);

  const cronRoutes = routes.filter((route) => route.guards.includes('requireCronSecret'));
  assert.deepEqual(cronRoutes.map(routeKey).sort(), [...CRON_ROUTE_ALLOWLIST]);
  for (const route of cronRoutes) {
    assert.equal(route.guards.includes('authRequired'), false, 'cron routes must not accept user sessions');
  }

  const unguarded = routes.filter(
    (route) => !route.guards.includes('authRequired') && !cronRoutes.includes(route)
  );
  assert.deepEqual(unguarded.map(routeKey).sort(), [...ANONYMOUS_ROUTE_ALLOWLIST].sort());

  for (const route of routes.filter((entry) => entry.path.startsWith('/api/admin'))) {
    assert.ok(route.guards.includes('authRequired'), `${routeKey(route)} lacks authRequired`);
    assert.ok(route.guards.includes('adminRequired'), `${routeKey(route)} lacks adminRequired`);
  }

  for (const route of routes) {
    assert.ok(route.path.startsWith('/api/'), `${routeKey(route)} is outside /api`);
    assert.equal(route.path.includes('*'), false, `${routeKey(route)} is a wildcard route`);
  }
  for (const route of routes.filter((entry) => /^\/api\/(finance|trips|clarity)(\/|$)/.test(entry.path))) {
    assert.ok(route.guards.includes('authRequired'), `${routeKey(route)} is private and must require a session`);
  }
});

test('every authenticated route rejects anonymous requests and the scheduler route rejects user sessions', async () => {
  const routes = collectRoutes(createApp()._router.stack);
  const guarded = routes.filter((route) => route.guards.includes('authRequired'));
  assert.ok(guarded.length > 60);
  process.env.CRON_SECRET = CRON_SECRET;

  // The app applies a 120 requests/minute limiter per instance, so probe in slices.
  const slices = [];
  for (let index = 0; index < guarded.length; index += 40) slices.push(guarded.slice(index, index + 40));
  for (const slice of slices) {
    const server = await startApp();
    for (const route of slice) {
      const response = await call(server, route.method.toLowerCase(), concretePath(route.path), { body: route.method === 'GET' ? undefined : {} });
      assert.equal(response.status, 401, `${routeKey(route)} answered ${response.status} without a session`);
      assert.equal(response.headers['access-control-allow-origin'], undefined);
    }
    await stopServer(server);
  }

  const server = await startApp();
  const noSecret = await call(server, 'post', '/api/internal/cron/monthly-review', { body: {} });
  assert.equal(noSecret.status, 401);
  const userSession = await call(server, 'post', '/api/internal/cron/monthly-review', {
    auth: authFor('owner'),
    body: {},
  });
  assert.equal(userSession.status, 401, 'a user session must not open the scheduler endpoint');
  const wrongSecret = await call(server, 'post', '/api/internal/cron/monthly-review', {
    headers: { 'X-Cron-Secret': `${CRON_SECRET}-wrong` },
    body: {},
  });
  assert.equal(wrongSecret.status, 401);

  // Unknown API paths do not reveal existence to anonymous callers.
  const unknown = await call(server, 'get', '/api/finance/does-not-exist');
  assert.equal(unknown.status, 401);
  const unknownSignedIn = await call(server, 'get', '/api/finance/does-not-exist', { auth: authFor('owner') });
  assert.equal(unknownSignedIn.status, 404);
  await stopServer(server);
  process.env.CRON_SECRET = '';
});

test('anonymous endpoints expose only their documented public data', async () => {
  const server = await startApp();
  const health = await call(server, 'get', '/api/health');
  assert.equal(health.status, 200);
  assert.deepEqual(Object.keys(health.body).sort(), ['ok', 'ts']);

  const announcement = await call(server, 'get', '/api/public/announcement');
  assert.equal(announcement.status, 200);
  assert.deepEqual(Object.keys(announcement.body), ['announcement']);

  const publicTrip = await call(server, 'get', `/api/public/trips/${PUBLIC_TOKEN}`);
  assert.equal(publicTrip.status, 200);
  const serialized = JSON.stringify(publicTrip.body);
  for (const forbidden of [
    OWNER_PRIVATE_BILL_LABEL,
    OWNER_PRIVATE_GOAL_NAME,
    'canonical-owner@example.test',
    'canonical-member@example.test',
    PUBLIC_TOKEN,
  ]) {
    assert.equal(serialized.includes(forbidden), false, `public trip leaked ${forbidden}`);
  }

  // Anonymous visit tracking accepts no private route key.
  const privateVisit = await call(server, 'post', '/api/track', { body: { route: 'plan' } });
  assert.equal(privateVisit.status, 204);
  assert.equal(await scalar('SELECT COUNT(*) FROM visits'), 0);
});

test('the source tree opens one loopback listener, no wildcard bind, and a single session authentication path', async () => {
  const files = await listSourceFiles(SOURCE_ROOT);
  const texts = new Map();
  for (const file of files) texts.set(relative(SOURCE_ROOT, file), await readFile(file, 'utf8'));
  const filesMatching = (pattern) => [...texts].filter(([, text]) => pattern.test(text)).map(([name]) => name);

  assert.deepEqual(filesMatching(/\.listen\(/), ['server.js']);
  assert.deepEqual(filesMatching(/createServer|WebSocket|net\.connect|dgram/), []);
  assert.deepEqual(filesMatching(/0\.0\.0\.0|'::'|"::"/), []);
  assert.match(texts.get('server.js'), /\|\|\s*'127\.0\.0\.1'/, 'HOST must default to loopback');

  // Session JWTs are verified by the auth middleware; visits only attributes
  // already-valid sessions and never grants access.
  assert.deepEqual(filesMatching(/jwt\.verify\(/).sort(), ['middleware/auth.js', 'routes/visits.js']);
  assert.deepEqual(filesMatching(/cookie/i), []);
  assert.deepEqual(filesMatching(/x-api-key|access_token|req\.query\.token|req\.query\.api/i), []);
  assert.deepEqual(filesMatching(/'basic |"basic |Basic /), []);
  assert.deepEqual(filesMatching(/headers\[['"]x-(?!cron-secret)/i), []);
  assert.deepEqual(filesMatching(/x-cron-secret/i), ['routes/internal.js']);

  // CORS headers come only from the cors package; nothing sets them by hand.
  assert.deepEqual(filesMatching(/access-control-allow/i), []);
});

test('creating the app opens no listener and credentials sent in alternate places never authenticate', async () => {
  const listenersBefore = process.getActiveResourcesInfo().filter((name) => name === 'TCPServerWrap').length;
  const app = createApp();
  const listenersAfter = process.getActiveResourcesInfo().filter((name) => name === 'TCPServerWrap').length;
  assert.equal(typeof app.listen, 'function');
  assert.equal(listenersAfter, listenersBefore, 'createApp() must not open a listening socket');

  const server = await startApp();
  const validToken = tokenFor(OWNER_ID, OWNER_SESSION_ID);
  const month = seeded.month;
  const attempts = [
    { path: `/api/finance/clarity?month=${month}&token=${validToken}`, headers: {} },
    { path: `/api/finance/clarity?month=${month}&access_token=${validToken}`, headers: {} },
    { path: `/api/finance/clarity?month=${month}`, headers: { Cookie: `token=${validToken}; session=${validToken}` } },
    { path: `/api/finance/clarity?month=${month}`, headers: { 'X-Api-Key': validToken } },
    { path: `/api/finance/clarity?month=${month}`, headers: { 'X-User-Id': String(OWNER_ID) } },
    { path: `/api/finance/clarity?month=${month}`, headers: { 'X-Cron-Secret': CRON_SECRET } },
    { path: `/api/finance/clarity?month=${month}`, headers: { Authorization: `Basic ${Buffer.from(`${OWNER_ID}:x`).toString('base64')}` } },
    { path: `/api/finance/clarity?month=${month}`, headers: { Authorization: validToken } },
  ];
  process.env.CRON_SECRET = CRON_SECRET;
  for (const attempt of attempts) {
    const response = await call(server, 'get', attempt.path, { headers: attempt.headers });
    assert.equal(response.status, 401, JSON.stringify(Object.keys(attempt.headers)));
  }
  process.env.CRON_SECRET = '';

  const control = await call(server, 'get', `/api/finance/clarity?month=${month}`, { auth: authFor('owner') });
  assert.equal(control.status, 200);
});

// ======================================================================
// Sessions: valid and revoked
// ======================================================================

test('canonical routes reject every invalid or revoked credential without touching stored data', async () => {
  const forgedAlgNone = [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ sub: String(OWNER_ID), tv: 1, sid: OWNER_SESSION_ID })).toString('base64url'),
    '',
  ].join('.');
  const credentials = [
    ['no credential', undefined],
    ['empty bearer', 'Bearer '],
    ['malformed bearer', 'Bearer not-a-token'],
    ['wrong signing secret', `Bearer ${jwt.sign({ sub: String(OWNER_ID), tv: 1, sid: OWNER_SESSION_ID }, 'x'.repeat(40), { algorithm: 'HS256' })}`],
    ['algorithm none', `Bearer ${forgedAlgNone}`],
    ['HS512 signature', `Bearer ${tokenFor(OWNER_ID, OWNER_SESSION_ID, {}, { algorithm: 'HS512' })}`],
    ['expired token', `Bearer ${tokenFor(OWNER_ID, OWNER_SESSION_ID, {}, { expiresIn: -30 })}`],
    ['token version mismatch', `Bearer ${tokenFor(OWNER_ID, OWNER_SESSION_ID, { tv: 99 })}`],
    ['unknown user', `Bearer ${tokenFor(999_999, OWNER_SESSION_ID)}`],
    ['missing session id', `Bearer ${tokenFor(OWNER_ID, undefined)}`],
    ['unknown session', `Bearer ${tokenFor(OWNER_ID, 999_999)}`],
    ["another user's session", `Bearer ${tokenFor(OWNER_ID, MEMBER_SESSION_ID)}`],
    ['revoked session', `Bearer ${tokenFor(OWNER_ID, OWNER_REVOKED_SESSION_ID)}`],
  ];
  const before = await fingerprint();

  for (const [label, authorization] of credentials) {
    const server = await startApp();
    for (const route of canonicalRouteTable()) {
      const response = await call(server, route.method, route.path, {
        auth: authorization,
        body: route.body,
        key: randomUUID(),
        contract: true,
      });
      assert.equal(response.status, 401, `${label}: ${route.name} answered ${response.status}`);
      if (label === 'revoked session') assert.equal(response.body.code, 'SESSION_REVOKED');
      assertNoWildcardOrigin(response, `${label}: ${route.name}`);
    }
    await stopServer(server);
  }

  assert.equal(await fingerprint(), before, 'rejected requests must not change stored data');
  assert.equal(await scalar('SELECT COUNT(*) FROM financial_record_changes'), 0);
});

test('a live session works, and revocation or a token-version bump ends it on the next request', async () => {
  const server = await startApp();
  const url = `/api/finance/clarity?month=${seeded.month}`;
  const owner = authFor('owner');

  const live = await call(server, 'get', url, { auth: owner });
  assert.equal(live.status, 200);
  assert.equal(live.body.schemaVersion, 1);

  await db.prepare(
    "UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP, revoked_reason = 'user_logout' WHERE id = ?"
  ).run(OWNER_SESSION_ID);
  const revoked = await call(server, 'get', url, { auth: owner });
  assert.equal(revoked.status, 401);
  assert.equal(revoked.body.code, 'SESSION_REVOKED');
  const writeAfterRevoke = await canonical(server, 'post', '/api/finance/salary', owner, {
    amountMinor: 100,
    month: seeded.month,
  });
  assert.equal(writeAfterRevoke.status, 401);
  assert.equal(await scalar('SELECT COUNT(*) FROM financial_record_changes'), 0);

  // The member's session is independent of the owner's revocation.
  const member = await call(server, 'get', url, { auth: authFor('member') });
  assert.equal(member.status, 200);

  await db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(MEMBER_ID);
  const invalidated = await call(server, 'get', url, { auth: authFor('member') });
  assert.equal(invalidated.status, 401);
});

// ======================================================================
// CORS and body limits
// ======================================================================

test('CORS echoes only an exact allowlisted origin and never the wildcard', async () => {
  const allowed = ['https://app.example.test', 'https://admin.example.test'];
  const server = await startApp({ corsOrigin: allowed.join(', ') });

  for (const origin of allowed) {
    const health = await call(server, 'get', '/api/health', { origin });
    assert.equal(health.status, 200);
    assert.equal(health.headers['access-control-allow-origin'], origin);
    assert.match(String(health.headers.vary), /Origin/i);
    assert.equal(health.headers['access-control-allow-credentials'], undefined);

    const preflight = await call(server, 'options', '/api/finance/salary', {
      origin,
      headers: {
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type,idempotency-key,x-clarity-contract',
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers['access-control-allow-origin'], origin);
    assert.match(String(preflight.headers['access-control-allow-headers']), /idempotency-key/i);

    const unauthenticated = await call(server, 'get', `/api/finance/clarity?month=${seeded.month}`, { origin });
    assert.equal(unauthenticated.status, 401);
    assert.equal(unauthenticated.headers['access-control-allow-origin'], origin);

    const publicTrip = await call(server, 'get', `/api/public/trips/${PUBLIC_TOKEN}`, { origin });
    assert.equal(publicTrip.status, 200);
    assert.equal(publicTrip.headers['access-control-allow-origin'], origin);
  }

  const lookalikes = [
    'https://app.example.test.evil.test',
    'https://evilapp.example.test',
    'https://sub.app.example.test',
    'http://app.example.test',
    'https://app.example.test:8443',
    'https://APP.example.test',
    'https://app.example.test/',
    'null',
    '*',
  ];
  for (const origin of lookalikes) {
    for (const attempt of [
      call(server, 'get', '/api/health', { origin }),
      call(server, 'get', `/api/public/trips/${PUBLIC_TOKEN}`, { origin }),
      call(server, 'options', '/api/finance/salary', { origin, headers: { 'Access-Control-Request-Method': 'POST' } }),
      call(server, 'post', '/api/finance/salary', { origin, auth: authFor('owner'), body: { amountMinor: 1, month: seeded.month }, key: randomUUID(), contract: true }),
    ]) {
      const response = await attempt;
      assert.equal(response.status, 403, `origin ${JSON.stringify(origin)} was not rejected`);
      assert.deepEqual(response.body, { error: 'CORS: origin not allowed' });
      assert.equal(response.headers['access-control-allow-origin'], undefined);
    }
  }
  assert.equal(await scalar('SELECT COUNT(*) FROM financial_record_changes'), 0, 'a disallowed origin must not reach a handler');

  // Requests without an Origin header (server-to-server) never receive the wildcard.
  const noOrigin = await call(server, 'get', '/api/health');
  assert.equal(noOrigin.status, 200);
  assertNoWildcardOrigin(noOrigin, 'no-Origin response');
});

test('CORS configuration refuses a wildcard or missing allowlist in production and never emits it elsewhere', async () => {
  const previousEnv = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    for (const value of ['*', '', '   ']) {
      process.env.CORS_ORIGIN = value;
      assert.throws(() => createApp(), /CORS_ORIGIN must be set to a specific allowlist/, `value ${JSON.stringify(value)}`);
    }
    delete process.env.CORS_ORIGIN;
    assert.throws(() => createApp(), /CORS_ORIGIN must be set/);
  } finally {
    process.env.NODE_ENV = previousEnv;
  }

  // Outside production a wildcard setting falls back to reflecting the request
  // origin; the response still never carries the literal wildcard.
  const wildcardServer = await startApp({ corsOrigin: '*' });
  const reflected = await call(wildcardServer, 'get', '/api/health', { origin: 'https://dev.example.test' });
  assertNoWildcardOrigin(reflected, 'non-production wildcard setting');

  // A stray "*" entry in an allowlist is a literal string, not a pattern.
  const listServer = await startApp({ corsOrigin: 'https://app.example.test,*' });
  const stranger = await call(listServer, 'get', '/api/health', { origin: 'https://stranger.example.test' });
  assert.equal(stranger.status, 403);
  assert.equal(stranger.headers['access-control-allow-origin'], undefined);
});

test('request bodies over 64 KB are rejected before any handler runs and malformed JSON is a 400', async () => {
  const server = await startApp();
  const owner = authFor('owner');
  const oversized = 'x'.repeat(70_000);
  const before = await fingerprint();

  const targets = [
    ['post', '/api/finance/salary', { amountMinor: 100, month: seeded.month, note: oversized }],
    ['post', '/api/finance/expenses', { amountMinor: 100, category: 'Food', spentOn: `${seeded.month}-03`, note: oversized }],
    ['post', `/api/finance/goals/${seeded.goalId}/contributions`, { contributionMinor: 100, note: oversized }],
    ['post', `/api/trips/${TRIP_ID}/expenses`, { payer: 'Owner', description: oversized, amount: 1, split: [{ name: 'Owner', share: 1 }] }],
    ['put', `/api/trips/${TRIP_ID}/expenses/${TRIP_EXPENSE_ID}/personal-link`, { category: 'Travel', spentOn: `${seeded.month}-03`, note: oversized }],
    ['patch', '/api/clarity/settings', { analyticsEnabled: false, note: oversized }],
    ['post', '/api/clarity/events', { type: 'journey_start', note: oversized }],
  ];
  for (const [method, path, body] of targets) {
    const response = await call(server, method, path, { auth: owner, body, key: randomUUID(), contract: true });
    assert.equal(response.status, 413, `${method} ${path}`);
    assert.deepEqual(response.body, { error: 'Payload too large' });
  }
  const anonymous = await call(server, 'post', '/api/auth/login', { body: { email: 'a@example.test', password: oversized } });
  assert.equal(anonymous.status, 413);

  // A body just under the limit is parsed, then judged by the route's own validation.
  const underLimit = await call(server, 'post', '/api/finance/expenses', {
    auth: owner,
    body: { amountMinor: 100, category: 'Food', spentOn: `${seeded.month}-03`, note: 'y'.repeat(60_000) },
    key: randomUUID(),
    contract: true,
  });
  assert.notEqual(underLimit.status, 413);
  assert.ok(underLimit.status < 500, `under-limit body produced ${underLimit.status}`);

  const malformed = await request(server)
    .post('/api/finance/salary')
    .set('Authorization', owner)
    .set('Idempotency-Key', randomUUID())
    .set('X-Clarity-Contract', '1')
    .set('Content-Type', 'application/json')
    .send('{"amountMinor": 100,');
  assert.equal(malformed.status, 400);
  assert.deepEqual(malformed.body, { error: 'Invalid JSON' });

  if (underLimit.status >= 400) {
    assert.equal(await fingerprint(), before, 'rejected bodies must not change stored data');
  }
});

// ======================================================================
// Wrong owners and trip roles
// ======================================================================

test('another account cannot read or change the owner’s finance records and learns nothing about them', async () => {
  const server = await startApp();
  const { billId, expenseId, goalId, month } = seeded;
  const before = await fingerprint();
  const attempts = [
    ['patch', `/api/finance/emis/${billId}`, { amountMinor: 1, expectedRecordVersion: 0 }],
    ['delete', `/api/finance/emis/${billId}`, {}],
    ['patch', `/api/finance/expenses/${expenseId}`, { amountMinor: 1, expectedRecordVersion: 0 }],
    ['delete', `/api/finance/expenses/${expenseId}`, {}],
    ['patch', `/api/finance/goals/${goalId}`, { name: 'Taken over' }],
    ['delete', `/api/finance/goals/${goalId}`, {}],
    ['post', `/api/finance/goals/${goalId}/contributions`, { contributionMinor: 100 }],
    ['post', `/api/finance/goals/${goalId}/contributions`, { contributionMinor: 99_999_999 }],
  ];
  for (const role of ['member', 'outsider']) {
    for (const [method, path, body] of attempts) {
      const response = await canonical(server, method, path, authFor(role), body);
      assert.equal(response.status, 404, `${role} ${method} ${path} answered ${response.status}`);
      const text = JSON.stringify(response.body);
      for (const secret of [OWNER_PRIVATE_BILL_LABEL, OWNER_PRIVATE_GOAL_NAME, String(OWNER_ID)]) {
        assert.equal(text.includes(secret), false, `${role} response leaked ${secret}`);
      }
    }
    const explanation = await call(server, 'get', `/api/finance/explanations/goal:${goalId}`, { auth: authFor(role) });
    assert.equal(explanation.status, 404);
    assert.equal(explanation.body.error.code, 'OUTCOME_NOT_FOUND');
  }
  assert.equal(await fingerprint(), before);

  // The clarity read is scoped to the caller; the owner's records never appear.
  const snapshot = await call(server, 'get', `/api/finance/clarity?month=${month}`, { auth: authFor('outsider') });
  assert.equal(snapshot.status, 200);
  const text = JSON.stringify(snapshot.body);
  for (const secret of [OWNER_PRIVATE_BILL_LABEL, OWNER_PRIVATE_GOAL_NAME, 'owner expense']) {
    assert.equal(text.includes(secret), false);
  }
  assert.deepEqual(snapshot.body.snapshot.outcomes.goals, []);
});

test('trip routes enforce owner, accepted-member, and outsider roles and leave private state intact on denial', async () => {
  const server = await startApp();
  const tripPath = `/api/trips/${TRIP_ID}`;
  const linkPath = `${tripPath}/expenses/${TRIP_EXPENSE_ID}/personal-link`;
  const spentOn = `${seeded.month}-03`;
  const before = await fingerprint();

  // Outsider: every route is a uniform 404.
  const outsider = authFor('outsider');
  const outsiderAttempts = [
    ['get', tripPath],
    ['post', `${tripPath}/members`, { name: 'Guest' }],
    ['post', `${tripPath}/expenses`, { payer: 'Owner', description: 'Taxi', amount: 10, split: [{ name: 'Owner', share: 1 }] }],
    ['put', linkPath, { category: 'Travel', spentOn }],
    ['delete', linkPath, {}],
    ['get', `${tripPath}/share`],
    ['post', `${tripPath}/share`, {}],
    ['delete', `${tripPath}/share`, {}],
  ];
  for (const [method, path, body] of outsiderAttempts) {
    const response = await canonical(server, method, path, outsider, body);
    assert.equal(response.status, 404, `outsider ${method} ${path}`);
    assert.deepEqual(response.body, { error: 'Not found' });
  }
  const outsiderList = await call(server, 'get', '/api/trips', { auth: outsider });
  assert.deepEqual(outsiderList.body.trips, []);
  const outsiderExplanation = await call(server, 'get', `/api/finance/explanations/trip:${TRIP_ID}`, { auth: outsider });
  assert.equal(outsiderExplanation.status, 404);

  // Accepted member: may read and add expenses, but not manage members or sharing.
  const member = authFor('member');
  const memberDenied = [
    ['post', `${tripPath}/members`, { name: 'Guest' }],
    ['get', `${tripPath}/share`],
    ['post', `${tripPath}/share`, {}],
    ['delete', `${tripPath}/share`, {}],
  ];
  for (const [method, path, body] of memberDenied) {
    const response = await canonical(server, method, path, member, body);
    assert.equal(response.status, 404, `member ${method} ${path}`);
    assert.deepEqual(response.body, { error: 'Not found' });
  }
  assert.equal(await fingerprint(), before, 'denied trip requests must not change stored data');
  assert.equal((await call(server, 'get', tripPath, { auth: member })).body.role, 'member');
  assert.equal((await call(server, 'get', tripPath, { auth: authFor('owner') })).body.role, 'owner');

  // A personal link belongs to the member who created it; no other account can remove it.
  const linked = await canonical(server, 'put', linkPath, member, { category: 'Travel', spentOn });
  assert.equal(linked.status, 200);
  const linkCount = () => scalar('SELECT COUNT(*) FROM trip_expense_personal_links');
  assert.equal(await linkCount(), 1);
  for (const role of ['owner', 'outsider']) {
    const removal = await canonical(server, 'delete', linkPath, authFor(role));
    assert.ok([200, 404].includes(removal.status), `${role} removal answered ${removal.status}`);
    assert.equal(await linkCount(), 1, `${role} must not remove the member's personal link`);
    assert.equal(await scalar('SELECT COUNT(*) FROM expense_log WHERE user_id = ?', MEMBER_ID), 1);
  }
  const removed = await canonical(server, 'delete', linkPath, member);
  assert.equal(removed.status, 200);
  assert.equal(await linkCount(), 0);
});

// ======================================================================
// Mutation atomicity against the real database
// ======================================================================

test('a database failure at any point in a canonical mutation rolls back source rows, receipts, and versions together', async (t) => {
  t.mock.method(console, 'error', () => {});
  const server = await startApp();
  const owner = authFor('owner');
  const member = authFor('member');
  const buildCases = () => {
    const { month, goalId } = seeded;
    return [
    { name: 'salary', auth: owner, method: 'post', path: '/api/finance/salary', body: { amountMinor: 6_000_000, month, expectedRecordVersion: 0 }, rows: 'SELECT COUNT(*) FROM salary_entries WHERE user_id = ?', args: [OWNER_ID], expectedRows: 2 },
    { name: 'expense', auth: owner, method: 'post', path: '/api/finance/expenses', body: { amountMinor: 5_000, category: 'Food', spentOn: `${month}-04`, expectedRecordVersion: 0 }, rows: 'SELECT COUNT(*) FROM expense_log WHERE user_id = ?', args: [OWNER_ID], expectedRows: 2 },
    { name: 'goal contribution', auth: owner, method: 'post', path: `/api/finance/goals/${goalId}/contributions`, body: { contributionMinor: 10_000, expectedRecordVersion: 0 }, rows: 'SELECT saved_amount FROM savings_goals WHERE id = ?', args: [goalId], expectedRows: 250 },
    { name: 'trip expense', auth: member, method: 'post', path: `/api/trips/${TRIP_ID}/expenses`, body: { payer: 'Owner', description: 'Taxi', amount: 30, split: [{ name: 'Owner', share: 1 }, { name: 'Member', share: 2 }], expectedTripVersion: 0 }, rows: 'SELECT COUNT(*) FROM trip_expenses WHERE trip_id = ?', args: [TRIP_ID], expectedRows: 2 },
    { name: 'personal link', auth: member, method: 'put', path: `/api/trips/${TRIP_ID}/expenses/${TRIP_EXPENSE_ID}/personal-link`, body: { category: 'Travel', spentOn: `${month}-03` }, rows: 'SELECT COUNT(*) FROM expense_log WHERE user_id = ?', args: [MEMBER_ID], expectedRows: 1 },
    ];
  };
  const triggers = [
    ['receipt insert', 'CREATE TRIGGER canonical_abort_receipt BEFORE INSERT ON financial_record_changes BEGIN SELECT RAISE(ABORT, \'injected receipt failure\'); END', 'canonical_abort_receipt'],
    ['version increment', 'CREATE TRIGGER canonical_abort_version BEFORE UPDATE ON user_financial_state BEGIN SELECT RAISE(ABORT, \'injected version failure\'); END', 'canonical_abort_version'],
  ];

  for (const [position, createSql, triggerName] of triggers) {
    for (let caseIndex = 0; caseIndex < buildCases().length; caseIndex += 1) {
      const mutationCase = buildCases()[caseIndex];
      const key = randomUUID();
      const before = await fingerprint();
      await db.prepare(createSql).run();
      let failed;
      try {
        failed = await canonical(server, mutationCase.method, mutationCase.path, mutationCase.auth, mutationCase.body, key);
      } finally {
        await db.prepare(`DROP TRIGGER ${triggerName}`).run();
      }
      assert.ok(failed.status >= 500, `${mutationCase.name} at ${position} answered ${failed.status}, expected a server failure`);
      assert.equal(JSON.stringify(failed.body).includes('injected'), false, 'internal failure text must not reach the client');
      assert.equal(await fingerprint(), before, `${mutationCase.name} at ${position} left partial state`);

      // The same key and body then succeeds exactly once: the failed attempt never claimed it.
      const retried = await canonical(server, mutationCase.method, mutationCase.path, mutationCase.auth, mutationCase.body, key);
      assert.equal(retried.status, 200, `${mutationCase.name} retry at ${position}: ${JSON.stringify(retried.body)}`);
      assert.equal(retried.body.mutation?.replayed ?? false, false);
      const replay = await canonical(server, mutationCase.method, mutationCase.path, mutationCase.auth, mutationCase.body, key);
      assert.equal(replay.status, 200);
      assert.equal(replay.body.mutation.replayed, true);
      assert.equal(await scalar('SELECT COUNT(*) FROM financial_record_changes WHERE idempotency_key = ?', key), 1);

      // Restore the baseline for the next case.
      await testDatabase.reset();
      seeded = await seedScenario();
    }
  }
});

test('a rejected or replayed command never advances the user data version; each accepted command advances it once', async () => {
  const server = await startApp();
  const owner = authFor('owner');
  const version = async () => (await call(server, 'get', `/api/finance/clarity?month=${seeded.month}`, { auth: owner })).body.snapshot.dataVersion;
  const start = await version();

  const key = randomUUID();
  const body = { amountMinor: 5_500_000, month: seeded.month, expectedRecordVersion: 0 };
  const first = await canonical(server, 'post', '/api/finance/salary', owner, body, key);
  assert.equal(first.status, 200);
  assert.equal(await version(), start + 1);
  const replay = await canonical(server, 'post', '/api/finance/salary', owner, body, key);
  assert.equal(replay.body.mutation.replayed, true);
  assert.equal(await version(), start + 1);

  const rejected = await canonical(server, 'post', '/api/finance/salary', owner, { amountMinor: -1, month: seeded.month });
  assert.ok(rejected.status >= 400 && rejected.status < 500);
  assert.equal(await version(), start + 1);

  const second = await canonical(server, 'post', '/api/finance/expenses', owner, {
    amountMinor: 1_000,
    category: 'Food',
    spentOn: `${seeded.month}-05`,
  });
  assert.equal(second.status, 200);
  assert.equal(await version(), start + 2);
});

// ======================================================================
// Idempotent replay and conflict across commands
// ======================================================================

test('one idempotency key identifies one command per account across salary, expense, goal, and trip routes', async () => {
  const server = await startApp();
  const owner = authFor('owner');
  const member = authFor('member');
  const { month, goalId } = seeded;
  const receipts = () => scalar('SELECT COUNT(*) FROM financial_record_changes');

  const key = randomUUID();
  const salary = { amountMinor: 6_100_000, month, expectedRecordVersion: 0 };
  const created = await canonical(server, 'post', '/api/finance/salary', owner, salary, key);
  assert.equal(created.status, 200);
  assert.equal(await receipts(), 1);

  // Same key, different body or different command: a conflict that changes nothing.
  const differentBody = await canonical(server, 'post', '/api/finance/salary', owner, { ...salary, amountMinor: 6_100_001 }, key);
  assert.equal(differentBody.status, 409);
  assert.equal(differentBody.body.error.code, 'IDEMPOTENCY_KEY_REUSED');
  const differentCommand = await canonical(server, 'post', '/api/finance/expenses', owner, { amountMinor: 100, category: 'Food', spentOn: `${month}-04` }, key);
  assert.equal(differentCommand.status, 409);
  assert.equal(differentCommand.body.error.code, 'IDEMPOTENCY_KEY_REUSED');
  const differentRecord = await canonical(server, 'post', `/api/finance/goals/${goalId}/contributions`, owner, { contributionMinor: 100 }, key);
  assert.equal(differentRecord.status, 409);
  assert.equal(await receipts(), 1);
  assert.equal(await scalar('SELECT amount FROM salary_entries WHERE user_id = ? AND month = ?', OWNER_ID, month), 61_000);
  assert.equal(await scalar('SELECT COUNT(*) FROM expense_log WHERE user_id = ?', OWNER_ID), 1);

  // The same key is independent for another account.
  const otherAccount = await canonical(server, 'post', '/api/finance/salary', member, { amountMinor: 100, month }, key);
  assert.equal(otherAccount.status, 200);
  assert.equal(otherAccount.body.mutation.replayed, false);
  assert.equal(await receipts(), 2);

  // Expense replays create one row; trip commands conflict the same way.
  const expenseKey = randomUUID();
  const expense = { amountMinor: 2_500, category: 'Food', spentOn: `${month}-06`, expectedRecordVersion: 0 };
  const firstExpense = await canonical(server, 'post', '/api/finance/expenses', owner, expense, expenseKey);
  const replayExpense = await canonical(server, 'post', '/api/finance/expenses', owner, expense, expenseKey);
  assert.equal(firstExpense.status, 200);
  assert.equal(replayExpense.body.mutation.replayed, true);
  assert.equal(replayExpense.body.id, firstExpense.body.id);
  assert.equal(await scalar('SELECT COUNT(*) FROM expense_log WHERE user_id = ?', OWNER_ID), 2);
  const conflictExpense = await canonical(server, 'post', '/api/finance/expenses', owner, { ...expense, amountMinor: 2_501 }, expenseKey);
  assert.equal(conflictExpense.status, 409);

  const tripKey = randomUUID();
  const tripExpense = { payer: 'Owner', description: 'Taxi', amount: 30, split: [{ name: 'Owner', share: 1 }, { name: 'Member', share: 2 }], expectedTripVersion: 0 };
  const tripFirst = await canonical(server, 'post', `/api/trips/${TRIP_ID}/expenses`, member, tripExpense, tripKey);
  const tripReplay = await canonical(server, 'post', `/api/trips/${TRIP_ID}/expenses`, member, tripExpense, tripKey);
  assert.equal(tripFirst.status, 200);
  assert.equal(tripReplay.body.mutation.replayed, true);
  assert.equal(await scalar('SELECT COUNT(*) FROM trip_expenses WHERE trip_id = ?', TRIP_ID), 2);
  const tripConflict = await canonical(server, 'post', `/api/trips/${TRIP_ID}/expenses`, member, { ...tripExpense, amount: 31 }, tripKey);
  assert.equal(tripConflict.status, 409);
  assert.equal(tripConflict.body.code, 'IDEMPOTENCY_KEY_REUSED');

  const linkPath = `/api/trips/${TRIP_ID}/expenses/${TRIP_EXPENSE_ID}/personal-link`;
  const linkKey = randomUUID();
  const link = { category: 'Travel', spentOn: `${month}-03` };
  assert.equal((await canonical(server, 'put', linkPath, member, link, linkKey)).status, 200);
  const linkConflict = await canonical(server, 'put', linkPath, member, { ...link, category: 'Food' }, linkKey);
  assert.equal(linkConflict.status, 409);
  assert.equal(linkConflict.body.code, 'IDEMPOTENCY_KEY_REUSED');
  assert.equal(await scalar('SELECT COUNT(*) FROM trip_expense_personal_links'), 1);
  assert.equal(await scalar('SELECT COUNT(*) FROM expense_log WHERE user_id = ?', MEMBER_ID), 1);
});

// ======================================================================
// Exact-month salary and expense moves, observed through the clarity read
// ======================================================================

test('salary and expense writes affect only their exact month in subsequent clarity reads', async () => {
  const server = await startApp();
  const owner = authFor('owner');
  const { month, previousMonth, nextMonth } = seeded;
  const read = async (target) => (await call(server, 'get', `/api/finance/clarity?month=${target}`, { auth: owner })).body.snapshot;
  const planOf = (snapshot) => snapshot.outcomes.monthlyPlan;
  const spendingTotal = (snapshot) => snapshot.outcomes.spending.value.totalSpending.amountMinor;

  const previousBefore = await read(previousMonth);
  assert.equal(planOf(previousBefore).value.salary.amountMinor, 4_000_000);
  const nextBefore = await read(nextMonth);
  assert.notEqual(planOf(nextBefore).status, 'available', 'an unset month must not borrow another month’s salary');

  const written = await canonical(server, 'post', '/api/finance/salary', owner, { amountMinor: 5_000_000, month, expectedRecordVersion: 0 });
  assert.equal(written.status, 200);
  assert.equal(planOf((await read(month))).value.salary.amountMinor, 5_000_000);
  assert.equal(planOf((await read(previousMonth))).value.salary.amountMinor, 4_000_000);
  assert.notEqual(planOf((await read(nextMonth))).status, 'available');
  assert.equal(await scalar('SELECT COUNT(*) FROM salary_entries WHERE user_id = ? AND month = ?', OWNER_ID, nextMonth), 0);

  // Moving an expense between months recalculates both partitions exactly once.
  const createdExpense = await canonical(server, 'post', '/api/finance/expenses', owner, {
    amountMinor: 7_500,
    category: 'Food',
    spentOn: `${previousMonth}-10`,
  });
  assert.equal(createdExpense.status, 200);
  const previousSpendWith = spendingTotal(await read(previousMonth));
  const currentSpendWith = spendingTotal(await read(month));
  assert.equal(previousSpendWith, 7_500);
  assert.equal(currentSpendWith, 12_345);

  const moved = await canonical(server, 'patch', `/api/finance/expenses/${createdExpense.body.id}`, owner, {
    spentOn: `${month}-10`,
    expectedRecordVersion: 1,
  });
  assert.equal(moved.status, 200);
  assert.equal(spendingTotal(await read(previousMonth)), 0);
  assert.equal(spendingTotal(await read(month)), 12_345 + 7_500);
  assert.equal(await scalar('SELECT COUNT(*) FROM expense_log WHERE user_id = ?', OWNER_ID), 2);
});

// ======================================================================
// Public serializer compatibility
// ======================================================================

test('the public trip response is unchanged by private activity and revocation keeps private data', async () => {
  const server = await startApp();
  const owner = authFor('owner');
  const member = authFor('member');
  const publicPath = `/api/public/trips/${PUBLIC_TOKEN}`;

  const before = await call(server, 'get', publicPath);
  assert.equal(before.status, 200);
  assert.deepEqual(Object.keys(before.body).sort(), ['expenses', 'members', 'settlement', 'trip']);
  assert.deepEqual(Object.keys(before.body.trip).sort(), ['budget', 'destination', 'end_date', 'name', 'start_date']);
  assert.deepEqual(Object.keys(before.body.members[0]), ['name']);
  assert.deepEqual(Object.keys(before.body.expenses[0]).sort(), ['amount', 'created_at', 'description', 'payer', 'split']);
  assert.deepEqual(Object.keys(before.body.settlement).sort(), ['balances', 'transactions']);

  // Private activity: salary, bill, expense, goal, contract header, and a personal link.
  const month = seeded.month;
  for (const [method, path, auth, body] of [
    ['post', '/api/finance/salary', owner, { amountMinor: 9_999_999, month }],
    ['post', '/api/finance/emis', owner, { label: 'Public leak probe bill', amountMinor: 12_345, category: 'Rent' }],
    ['post', '/api/finance/goals', owner, { name: 'Public leak probe goal', targetAmount: 5_000, targetDate: `${monthAtOffset(6)}-15` }],
    ['post', '/api/finance/expenses', owner, { amountMinor: 4_321, category: 'Food', spentOn: `${month}-07` }],
    ['put', `/api/trips/${TRIP_ID}/expenses/${TRIP_EXPENSE_ID}/personal-link`, member, { category: 'Travel', spentOn: `${month}-03` }],
  ]) {
    const response = await canonical(server, method, path, auth, body);
    assert.equal(response.status, 200, `${path}: ${JSON.stringify(response.body)}`);
  }
  const after = await call(server, 'get', publicPath, { headers: { 'X-Clarity-Contract': '1' } });
  assert.equal(after.status, 200);
  assert.deepEqual(after.body, before.body);
  const serialized = JSON.stringify(after.body);
  for (const forbidden of ['Public leak probe', '99999.99', 'canonical-owner@', 'canonical-member@', 'personal', 'dataVersion']) {
    assert.equal(serialized.includes(forbidden), false, `public body leaked ${forbidden}`);
  }
  assertNoWildcardOrigin(after, 'public trip');

  // Revoking the link is a constant 404 for the public route; private records survive.
  const revoke = await call(server, 'delete', `/api/trips/${TRIP_ID}/share`, { auth: owner });
  assert.equal(revoke.status, 200);
  for (const path of [publicPath, '/api/public/trips/11111111111111111111111111111111', '/api/public/trips/short']) {
    const response = await call(server, 'get', path);
    assert.equal(response.status, 404);
    assert.deepEqual(response.body, { error: 'Not found' });
  }
  const privateTrip = await call(server, 'get', `/api/trips/${TRIP_ID}`, { auth: owner });
  assert.equal(privateTrip.status, 200);
  assert.equal(await scalar('SELECT COUNT(*) FROM trip_expense_personal_links'), 1);
  assert.equal(await scalar('SELECT COUNT(*) FROM expense_log WHERE user_id = ?', MEMBER_ID), 1);
});

// ======================================================================
// Monthly review and clarity parity
// ======================================================================

test('the monthly review and the clarity read produce the same figures for one fixture', async () => {
  const { reviewDataFromClaritySnapshot, loadLegacyReviewData, runMonthlyReview } = await import('../../src/jobs/monthlyReview.js');
  const { ClarityService } = await import('../../src/services/clarityService.js');
  const reviewMonth = '2026-01';
  const now = new Date(2026, 1, 15, 12, 0, 0);

  // Only the parity account exists, so the job's shadow codes describe this fixture alone.
  await testDatabase.reset();
  await insertAccount(
    buildUserFixture({ id: PARITY_USER_ID, email: 'canonical-parity@example.test', name: 'Parity' }),
    buildSessionFixture({ id: PARITY_SESSION_ID, userId: PARITY_USER_ID })
  );

  // Every amount is a multiple of 0.25 and the 20% target is whole, so the
  // legacy floating-point and canonical integer-paise paths must agree exactly.
  await db.prepare('INSERT INTO salary_entries (user_id, month, amount) VALUES (?, ?, ?)')
    .run(PARITY_USER_ID, reviewMonth, 82_500);
  for (const [label, amount, category] of [['Parity rent', 20_000, 'Rent'], ['Parity insurance', 2_500, 'Insurance']]) {
    await db.prepare('INSERT INTO emis (user_id, label, amount, category) VALUES (?, ?, ?, ?)')
      .run(PARITY_USER_ID, label, amount, category);
  }
  const spending = [
    ['Groceries', 1250.5, 3],
    ['Groceries', 99.25, 9],
    ['Entertainment', 800, 12],
    ['Shopping', 450.75, 15],
    ['Food', 300, 18],
    ['Transport', 120, 21],
  ];
  for (const [category, amount, day] of spending) {
    await db.prepare(
      `INSERT INTO expense_log (user_id, month, category, amount, note, spent_on)
       VALUES (?, ?, ?, ?, NULL, ?)`
    ).run(PARITY_USER_ID, reviewMonth, category, amount, `${reviewMonth}-${String(day).padStart(2, '0')}`);
  }

  const server = await startApp();
  const apiResponse = await call(server, 'get', `/api/finance/clarity?month=${reviewMonth}`, {
    auth: bearer(PARITY_USER_ID, PARITY_SESSION_ID),
  });
  assert.equal(apiResponse.status, 200);
  const fromApi = reviewDataFromClaritySnapshot(apiResponse.body.snapshot);
  const fromJobService = reviewDataFromClaritySnapshot(await new ClarityService().getSnapshot({
    userId: PARITY_USER_ID,
    month: reviewMonth,
    now,
    timeZone: 'Asia/Kolkata',
  }));
  assert.deepEqual(fromApi, fromJobService);

  const legacy = await loadLegacyReviewData({ database: db, userId: PARITY_USER_ID, month: reviewMonth });
  // The legacy query orders categories by total; the canonical outcome orders them by name.
  const byCategory = (left, right) => left.category.localeCompare(right.category);
  const normalized = (review) => ({ ...review, categoryTotals: review.categoryTotals.toSorted(byCategory) });
  assert.deepEqual(normalized(fromApi), normalized(legacy));
  assert.equal(fromApi.income, 82_500);
  assert.equal(fromApi.needs, 1_769.75);
  assert.equal(fromApi.wants, 1_250.75);
  assert.equal(fromApi.totalSpent, 3_020.5);
  assert.equal(fromApi.saveTarget, 12_000);
  assert.deepEqual(fromApi.top3.map((entry) => entry.category), ['Groceries', 'Entertainment', 'Shopping']);

  // The job itself compares both paths in shadow mode and must report no mismatch.
  const logs = [];
  const result = await runMonthlyReview({
    dry: true,
    now,
    shadowCompare: true,
    calculationMode: 'canonical',
    log: (message) => logs.push(message),
  });
  assert.equal(result.month, reviewMonth);
  assert.equal(result.failed, 0);
  assert.equal(result.sent, 1);
  assert.ok(logs.includes(`[dry] would send user_id=${PARITY_USER_ID}`));
  assert.deepEqual(logs.filter((line) => /SHADOW_|CANONICAL_FALLBACK/.test(line)), []);
  assert.equal(
    logs.some((line) => /\d{3,}\.\d{2}|example\.test|Parity/.test(line)),
    false,
    'job logs must not contain amounts, names, or email addresses'
  );
});

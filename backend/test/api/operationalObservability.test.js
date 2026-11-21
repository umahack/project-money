import { after, afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createIsolatedTestDatabase } from '../helpers/testDatabase.js';
import { buildSessionFixture, buildUserFixture } from '../helpers/fixtures.js';

// Requirements 1.11-1.13, 9.6, 9.11, 10.11, 11.12, 13.30, 13.31 (task 17.1).
// Every request here runs through the real app and its default console logger.
// The console is captured, so each assertion covers what an operator would see.

const PASSWORD = 'Observability-123!';
const HMAC_KEY = 'SENTINEL-hmac-key-material-32-bytes-minimum';
const CRON_SECRET = 'SENTINEL-cron-secret-value-0123456789';
const PUBLIC_TOKEN_PATH = '/api/public/trips/SENTINELPUBLICTOKEN0123456789abcdef';
const GOAL_NAME = 'SENTINEL-GOAL-Priya-Emergency';
const NOTE = 'SENTINEL-NOTE-lunch-with-Priya';
const AMOUNT_TEXT = '87654.32';
const AMOUNT_MINOR = 8765432;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let testDatabase;
let db;
let app;
let owner;
let ownerSession;
let noticeless;
let noticelessSession;
let authorization;
let noticelessAuthorization;
let goalId;
let passwordHash;
const consoleLines = [];
let restoreConsole = () => {};

function captureConsole() {
  const original = {};
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
    original[method] = console[method];
    console[method] = (...args) => {
      consoleLines.push(args.map((arg) => {
        if (typeof arg === 'string') return arg;
        if (arg instanceof Error) return `${arg.name}: ${arg.message}\n${arg.stack ?? ''}`;
        try { return JSON.stringify(arg); } catch { return String(arg); }
      }).join(' '));
    };
  }
  restoreConsole = () => {
    for (const [method, fn] of Object.entries(original)) console[method] = fn;
  };
}

function events(since = 0) {
  return consoleLines.slice(since).flatMap((line) => {
    try {
      const parsed = JSON.parse(line);
      return parsed && typeof parsed === 'object' && typeof parsed.event === 'string' ? [parsed] : [];
    } catch {
      return [];
    }
  });
}

function tokenFor(user, session) {
  return jwt.sign(
    { sub: String(user.id), tv: user.token_version, sid: session.id },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '5m' }
  );
}

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
    session.id, session.user_id, session.device_label, session.ip_hash, session.user_agent,
    session.created_at, session.last_seen_at, session.revoked_at, session.revoked_reason
  );
}

let keyCounter = 0;
function key() {
  keyCounter += 1;
  return `c1000000-0000-4000-8000-${String(keyCounter).padStart(12, '0')}`;
}

function contract(builder, token = authorization) {
  return builder
    .set('Authorization', token)
    .set('X-Clarity-Contract', '1')
    .set('Idempotency-Key', key());
}

function currentMonth() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function sensitiveValues() {
  return [
    owner.email,
    owner.name,
    tokenFor(owner, ownerSession),
    authorization.replace('Bearer ', ''),
    PASSWORD,
    HMAC_KEY,
    CRON_SECRET,
    GOAL_NAME,
    NOTE,
    AMOUNT_TEXT,
    String(AMOUNT_MINOR),
    'SENTINELPUBLICTOKEN',
    'Mozilla/5.0 SENTINEL-UA',
  ];
}

// Logs may carry a stable driver code such as SQLITE_ERROR in the `code` field.
// That is an enum-like identifier, not SQL text, so only responses must also be
// free of it.
function assertNoSensitive(text, label, { allowDriverCodes = false } = {}) {
  for (const value of sensitiveValues()) {
    assert.ok(!text.includes(value), `${label} contains ${value.slice(0, 24)}`);
  }
  const markers = ['SELECT ', 'INSERT ', 'UPDATE ', 'no such table', 'node_modules', '    at ', 'unavailable_'];
  if (!allowDriverCodes) markers.push('SQLITE_');
  for (const marker of markers) {
    assert.ok(!text.includes(marker), `${label} contains ${marker.trim()}`);
  }
}

before(async () => {
  testDatabase = await createIsolatedTestDatabase();
  db = testDatabase.db;
  process.env.FINANCIAL_MUTATION_HMAC_KEY = HMAC_KEY;
  process.env.CRON_SECRET = CRON_SECRET;
  process.env.OPERATIONAL_LOG_LEVEL = 'debug';
  passwordHash = await bcrypt.hash(PASSWORD, 4);
  const { createApp } = await import('../../src/app.js');
  app = createApp();
  captureConsole();
});

beforeEach(async () => {
  await testDatabase.reset();
  consoleLines.length = 0;
  owner = buildUserFixture({
    id: 701,
    email: 'sentinel.owner@example.test',
    name: 'Priya Sentinel Kumar',
    password_hash: passwordHash,
  });
  ownerSession = buildSessionFixture({ userId: owner.id, id: 751 });
  noticeless = buildUserFixture({ id: 702, email: 'sentinel.noticeless@example.test', name: 'No Notice' });
  noticelessSession = buildSessionFixture({ userId: noticeless.id, id: 752 });
  await insertAccount(owner, ownerSession);
  await insertAccount(noticeless, noticelessSession);
  await db.prepare(
    `INSERT INTO user_financial_state (user_id, data_use_notice_version, data_use_acknowledged_at)
     VALUES (?, 1, CURRENT_TIMESTAMP)`
  ).run(owner.id);
  authorization = `Bearer ${tokenFor(owner, ownerSession)}`;
  noticelessAuthorization = `Bearer ${tokenFor(noticeless, noticelessSession)}`;
  const info = await db.prepare(
    `INSERT INTO savings_goals (user_id, name, target_amount, saved_amount, target_date)
     VALUES (?, ?, ?, ?, ?)`
  ).run(owner.id, GOAL_NAME, 1000, 250, `${new Date().getFullYear() + 1}-06-15`);
  goalId = Number(info.lastInsertRowid);
  await db.prepare(
    'INSERT INTO salary_entries (user_id, month, amount) VALUES (?, ?, ?)'
  ).run(owner.id, currentMonth(), Number(AMOUNT_TEXT));
  consoleLines.length = 0;
});

afterEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
});

after(async () => {
  restoreConsole();
  await testDatabase?.cleanup();
});

test('successful snapshot and explanation reads log one redacted event with the response request ID', async () => {
  const snapshot = await request(app)
    .get(`/api/finance/clarity?month=${currentMonth()}`)
    .set('Authorization', authorization)
    .set('User-Agent', 'Mozilla/5.0 SENTINEL-UA');
  assert.equal(snapshot.status, 200);
  assert.ok(JSON.stringify(snapshot.body).includes(AMOUNT_MINOR.toString()), 'the authorized response carries the value');

  const explanation = await request(app)
    .get(`/api/finance/explanations/goal:${goalId}`)
    .set('Authorization', authorization);
  assert.equal(explanation.status, 200);

  const completed = events().filter((event) => event.event === 'REQUEST_COMPLETED');
  assert.equal(completed.length, 2);
  const [first, second] = completed;
  assert.equal(first.requestId, snapshot.headers['x-request-id']);
  assert.match(first.requestId, UUID);
  assert.deepEqual(
    [first.route, first.method, first.status, first.outcome, first.level],
    ['/api/finance/clarity', 'GET', 200, 'success', 'info']
  );
  assert.deepEqual(
    [second.route, second.recordType, second.recordId, second.outcome],
    ['/api/finance/explanations/:outcomeId', 'goal', goalId, 'success']
  );
  assert.match(first.durationBucket, /^(lt_\d+(ms|s)|gte_5s)$/);
  assert.equal(first.droppedFields, undefined);
  assertNoSensitive(consoleLines.join('\n'), 'success logs');
});

test('handled failures log the stable error code and outcome kind only', async () => {
  const invalidMonth = await request(app)
    .get('/api/finance/clarity?month=2026-13&email=sentinel.owner@example.test')
    .set('Authorization', authorization);
  assert.equal(invalidMonth.status, 400);
  const unknown = await request(app)
    .get('/api/finance/explanations/goal:999999')
    .set('Authorization', authorization);
  assert.equal(unknown.status, 404);
  const badEvent = await request(app)
    .post('/api/clarity/events')
    .set('Authorization', authorization)
    .send({ type: 'SENTINEL', amount: AMOUNT_TEXT, note: NOTE });
  assert.ok(badEvent.status >= 400 && badEvent.status < 500);

  const completed = events().filter((event) => event.event === 'REQUEST_COMPLETED');
  assert.deepEqual(completed.map((event) => [event.route, event.status, event.code, event.outcome]), [
    ['/api/finance/clarity', 400, 'INVALID_MONTH', 'client_error'],
    ['/api/finance/explanations/:outcomeId', 404, 'OUTCOME_NOT_FOUND', 'client_error'],
    ['/api/clarity/events', badEvent.status, badEvent.body.error?.code, 'client_error'],
  ]);
  assertNoSensitive(consoleLines.join('\n'), 'handled failure logs');
  assertNoSensitive(JSON.stringify([invalidMonth.body, unknown.body, badEvent.body]), 'handled failure responses');
});

test('a version conflict logs the conflict code, record type, and record id without the amount', async () => {
  const first = await contract(request(app).post(`/api/finance/goals/${goalId}/contributions`))
    .send({ contributionMinor: AMOUNT_MINOR % 1000 + 100, expectedRecordVersion: 0 });
  assert.equal(first.status, 200);
  const conflict = await contract(request(app).post(`/api/finance/goals/${goalId}/contributions`))
    .send({ contributionMinor: AMOUNT_MINOR % 1000 + 100, expectedRecordVersion: 0 });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'RECORD_VERSION_CONFLICT');

  const logged = events().filter((event) => event.outcome === 'conflict');
  assert.equal(logged.length, 1);
  assert.deepEqual(
    [logged[0].route, logged[0].status, logged[0].code, logged[0].recordType, logged[0].recordId, logged[0].level],
    ['/api/finance/goals/:id/contributions', 409, 'RECORD_VERSION_CONFLICT', 'goal', goalId, 'warn']
  );
  assert.equal(logged[0].requestId, conflict.headers['x-request-id']);
  assertNoSensitive(consoleLines.join('\n'), 'conflict logs');
});

test('a missing data-use acknowledgement logs the notice-required outcome', async () => {
  const response = await contract(
    request(app).post(`/api/finance/goals/${goalId}/contributions`),
    noticelessAuthorization
  ).send({ contributionMinor: 500 });
  assert.equal(response.status, 428);
  const logged = events().filter((event) => event.outcome === 'notice_required');
  assert.equal(logged.length, 1);
  assert.equal(logged[0].code, 'DATA_NOTICE_REQUIRED');
  assertNoSensitive(consoleLines.join('\n'), 'notice logs');
});

test('a contained calculation failure is logged by outcome family only', async () => {
  const { ClarityService } = await import('../../src/services/clarityService.js');
  const { createClarityRouter } = await import('../../src/routes/clarity.js');
  const { createRequestContext } = await import('../../src/middleware/requestContext.js');
  const { createErrorBoundary } = await import('../../src/middleware/errorBoundary.js');
  const service = new ClarityService({
    goalCalculator: () => {
      throw new Error(`SELECT amount FROM savings_goals WHERE name = '${GOAL_NAME}' amount=${AMOUNT_TEXT}`);
    },
  });
  const mini = express();
  mini.use(createRequestContext());
  mini.use('/api/finance', createClarityRouter({ service }));
  mini.use(createErrorBoundary());

  const response = await request(mini)
    .get(`/api/finance/clarity?month=${currentMonth()}`)
    .set('Authorization', authorization);
  assert.equal(response.status, 200, 'the failed goal does not fail the snapshot');
  const goal = response.body.snapshot.outcomes.goals.find((item) => item.status === 'calculation_failed');
  assert.ok(goal, 'the goal outcome is marked calculation_failed');
  assert.equal(goal.retry.scopeKey, `outcome:goal:${goalId}`);
  assert.equal(goal.confirmedInputsRetained, true);
  // The committed salary is still reported as an available outcome.
  assert.equal(response.body.snapshot.outcomes.monthlyPlan.status, 'available');

  const failures = events().filter((event) => event.event === 'OUTCOME_CALCULATION_FAILED');
  assert.equal(failures.length, 1);
  assert.deepEqual(
    [failures[0].outcomeKind, failures[0].code, failures[0].recordType, failures[0].recordId],
    ['goal', 'CALCULATION_FAILED', 'goal', goalId]
  );
  assert.equal(failures[0].level, 'warn');
  assert.ok(Number.isSafeInteger(failures[0].dataVersion));
  assertNoSensitive(consoleLines.join('\n'), 'calculation failure logs');
});

test('hostile payloads never reach logs or error responses on the new routers', async () => {
  const hostile = {
    desiredOutcome: `SENTINEL-${NOTE}`,
    amount: AMOUNT_TEXT,
    email: owner.email,
    name: owner.name,
    note: NOTE,
    token: authorization,
    splitJson: JSON.stringify([{ memberId: 1, shareMinor: AMOUNT_MINOR }]),
    nested: { description: NOTE, amountMinor: AMOUNT_MINOR },
  };
  const requests = [
    request(app).post('/api/clarity/journeys').set('Authorization', authorization).send(hostile),
    request(app).patch('/api/clarity/journeys/1').set('Authorization', authorization).send(hostile),
    request(app).patch('/api/clarity/journeys/SENTINEL-NOTE').set('Authorization', authorization).send(hostile),
    request(app).post('/api/clarity/events').set('Authorization', authorization).send(hostile),
    request(app).patch('/api/clarity/settings').set('Authorization', authorization).send(hostile),
    request(app).post(`/api/finance/goals/${goalId}/contributions`)
      .set('Authorization', authorization).set('X-Clarity-Contract', '1')
      .set('Idempotency-Key', 'SENTINEL-NOTE-not-a-uuid').send(hostile),
    request(app).get(`/api/finance/clarity?month=${encodeURIComponent(NOTE)}`).set('Authorization', authorization),
    request(app).get(`/api/finance/explanations/${encodeURIComponent(NOTE)}?version=${AMOUNT_TEXT}`)
      .set('Authorization', authorization),
    request(app).post('/api/clarity/events').set('Authorization', authorization)
      .set('Content-Type', 'application/json').send(`{"note":"${NOTE}", "amount": ${AMOUNT_TEXT},`),
    request(app).get(PUBLIC_TOKEN_PATH),
    request(app).get('/api/clarity/journeys/active').set('Authorization', 'Bearer SENTINEL-forged-session-token'),
    request(app).post('/api/internal/cron/clarity-reports').set('x-cron-secret', 'SENTINEL-wrong-cron-secret'),
  ];
  const responses = await Promise.all(requests.map((pending) => pending.then((value) => value)));

  for (const response of responses) {
    assert.ok(response.status >= 400, `unexpected success ${response.status}`);
    const serialized = JSON.stringify(response.body);
    for (const value of [owner.email, owner.name, NOTE, AMOUNT_TEXT, String(AMOUNT_MINOR), HMAC_KEY, CRON_SECRET]) {
      assert.ok(!serialized.includes(value), `response echoed ${value.slice(0, 20)}`);
    }
    assert.match(response.headers['x-request-id'], UUID);
  }
  assertNoSensitive(consoleLines.join('\n'), 'hostile request logs');
  assert.ok(!consoleLines.join('\n').includes('SENTINEL-wrong-cron-secret'));
  assert.ok(!consoleLines.join('\n').includes('SENTINEL-forged-session-token'));
  assert.ok(!consoleLines.join('\n').includes(PUBLIC_TOKEN_PATH.split('/').pop()));
});

test('an unexpected database failure returns a fixed envelope on contract requests and the legacy body otherwise', async () => {
  await db.prepare('ALTER TABLE savings_goals RENAME TO unavailable_savings_goals').run();
  let legacy;
  let negotiated;
  let mutation;
  try {
    legacy = await request(app).get('/api/finance/goals').set('Authorization', authorization);
    negotiated = await request(app)
      .get('/api/finance/goals')
      .set('Authorization', authorization)
      .set('X-Clarity-Contract', '1');
    mutation = await contract(request(app).post('/api/finance/goals'))
      .send({ name: GOAL_NAME, targetAmount: AMOUNT_TEXT, savedAmount: '0' });
  } finally {
    await db.prepare('ALTER TABLE unavailable_savings_goals RENAME TO savings_goals').run();
  }

  assert.equal(legacy.status, 500);
  assert.deepEqual(legacy.body, { error: 'Server error' });

  assert.equal(negotiated.status, 500);
  assert.deepEqual(negotiated.body, {
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong on our side. Your confirmed records were not changed. Try again.',
      retryable: true,
      correlationId: negotiated.headers['x-request-id'],
    },
  });

  assert.ok(mutation.status >= 400);
  assert.equal(typeof mutation.body.error, 'object');
  assert.equal(typeof mutation.body.error.code, 'string');
  for (const response of [legacy, negotiated, mutation]) {
    assertNoSensitive(JSON.stringify(response.body) + JSON.stringify(response.headers), 'failure response');
  }

  const unexpected = events().filter((event) => event.event === 'REQUEST_UNEXPECTED_ERROR');
  assert.ok(unexpected.length >= 2);
  const forLegacy = unexpected.find((event) => event.requestId === legacy.headers['x-request-id']);
  assert.deepEqual(
    [forLegacy.route, forLegacy.method, forLegacy.status, forLegacy.userId],
    ['/api/finance/goals', 'GET', 500, owner.id]
  );
  assert.match(forLegacy.errorName, /^[A-Z][A-Za-z0-9]*$/);
  assert.ok(!Object.hasOwn(forLegacy, 'message'));
  assert.ok(!Object.hasOwn(forLegacy, 'stack'));
  assertNoSensitive(consoleLines.join('\n'), 'unexpected failure logs', { allowDriverCodes: true });
  // The failed write left no goal behind and the committed goal is intact.
  const goals = await db.prepare('SELECT COUNT(*) AS count FROM savings_goals WHERE user_id = ?').get(owner.id);
  assert.equal(Number(goals.count), 1);
});

test('a contained journey failure returns its scoped envelope with a correlation ID', async () => {
  await db.prepare('ALTER TABLE guided_journeys RENAME TO unavailable_guided_journeys').run();
  let response;
  try {
    response = await contract(request(app).post('/api/clarity/journeys'))
      .send({ desiredOutcome: 'plan_month' });
  } finally {
    await db.prepare('ALTER TABLE unavailable_guided_journeys RENAME TO guided_journeys').run();
  }
  assert.equal(response.status, 500);
  assert.equal(response.body.error.code, 'JOURNEY_OPERATION_FAILED');
  assert.equal(response.body.error.retryable, true);
  assert.equal(response.body.error.retryScopeKey, 'journey:start');
  assert.equal(response.body.error.correlationId, response.headers['x-request-id']);
  assertNoSensitive(JSON.stringify(response.body), 'journey failure response');

  const failure = events().find((event) => event.event === 'JOURNEY_OPERATION_FAILED');
  assert.equal(failure.requestId, response.headers['x-request-id']);
  assert.equal(failure.operation, 'journey.start');
  assert.equal(failure.userId, owner.id);
  assertNoSensitive(consoleLines.join('\n'), 'journey failure logs', { allowDriverCodes: true });
});

test('export and deletion failures keep their response shapes and log fixed codes', async () => {
  await db.prepare('ALTER TABLE savings_goals RENAME TO unavailable_savings_goals').run();
  let exportResponse;
  try {
    exportResponse = await request(app).get('/api/auth/export').set('Authorization', authorization);
  } finally {
    await db.prepare('ALTER TABLE unavailable_savings_goals RENAME TO savings_goals').run();
  }
  assert.equal(exportResponse.status, 500);
  assert.equal(exportResponse.body.code, 'EXPORT_FAILED');
  assert.equal(exportResponse.body.status, 'unsuccessful');
  assert.deepEqual(Object.keys(exportResponse.body).sort(), [
    'code', 'error', 'failed_record_categories', 'retry', 'status', 'support',
  ]);

  await db.prepare(
    `CREATE TRIGGER reject_observability_user_delete BEFORE DELETE ON users
     BEGIN SELECT RAISE(ABORT, 'injected deletion failure for sentinel.owner@example.test'); END`
  ).run();
  let deletion;
  try {
    deletion = await request(app)
      .delete('/api/auth/account')
      .set('Authorization', authorization)
      .send({ currentPassword: PASSWORD });
  } finally {
    await db.prepare('DROP TRIGGER reject_observability_user_delete').run();
  }
  assert.equal(deletion.status, 500);
  assert.equal(deletion.body.code, 'ACCOUNT_DELETION_INCOMPLETE');
  assert.equal(deletion.body.status, 'incomplete');
  const stillThere = await db.prepare('SELECT COUNT(*) AS count FROM users WHERE id = ?').get(owner.id);
  assert.equal(Number(stillThere.count), 1);

  const exportEvent = events().find((event) => event.event === 'ACCOUNT_EXPORT_FAILED');
  assert.equal(exportEvent.code, 'EXPORT_FAILED');
  assert.equal(exportEvent.category, exportResponse.body.failed_record_categories[0].key);
  assert.equal(exportEvent.userId, owner.id);
  const deletionEvent = events().find((event) => event.event === 'ACCOUNT_DELETION_INCOMPLETE');
  assert.equal(deletionEvent.code, 'ACCOUNT_DELETION_INCOMPLETE');
  assert.equal(deletionEvent.userId, owner.id);
  assertNoSensitive(consoleLines.join('\n'), 'export/deletion logs');
  assertNoSensitive(JSON.stringify([exportResponse.body, deletion.body]), 'export/deletion responses');
});

test('legacy route error shapes are unchanged', async () => {
  const unauthorized = await request(app).get('/api/finance/plan');
  assert.equal(unauthorized.status, 401);
  assert.equal(typeof unauthorized.body.error, 'string');

  const notFound = await request(app).get('/api/not-a-route').set('Authorization', authorization);
  assert.equal(notFound.status, 404);
  assert.deepEqual(notFound.body, { error: 'Not found' });

  const invalidJson = await request(app)
    .post('/api/finance/goals')
    .set('Authorization', authorization)
    .set('Content-Type', 'application/json')
    .send('{"name": ');
  assert.equal(invalidJson.status, 400);
  assert.deepEqual(invalidJson.body, { error: 'Invalid JSON' });

  const tooLarge = await request(app)
    .post('/api/finance/goals')
    .set('Authorization', authorization)
    .set('Content-Type', 'application/json')
    .send(JSON.stringify({ name: 'x'.repeat(70_000) }));
  assert.equal(tooLarge.status, 413);
  assert.deepEqual(tooLarge.body, { error: 'Payload too large' });

  const corsDenied = await request(app).get('/api/health').set('Origin', 'https://not-allowed.example.test');
  assert.equal(corsDenied.status, 403);
  assert.deepEqual(corsDenied.body, { error: 'CORS: origin not allowed' });
  assert.match(corsDenied.headers['x-request-id'], UUID);

  const invalidGoal = await request(app)
    .post('/api/finance/goals')
    .set('Authorization', authorization)
    .send({ name: '' });
  assert.equal(invalidGoal.status, 400);
  assert.equal(typeof invalidGoal.body.error, 'string');
});

test('the console carries only structured events from the new code paths', async () => {
  await request(app).get(`/api/finance/clarity?month=${currentMonth()}`).set('Authorization', authorization);
  await request(app).get('/api/clarity/journeys/active').set('Authorization', authorization);
  await request(app).get('/api/finance/explanations/goal:999999').set('Authorization', authorization);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(consoleLines.length > 0);
  for (const line of consoleLines) {
    const parsed = JSON.parse(line);
    assert.equal(typeof parsed.event, 'string');
    assert.equal(parsed.droppedFields, undefined);
  }
});

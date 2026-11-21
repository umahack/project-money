import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { createErrorBoundary, UNEXPECTED_ERROR_ENVELOPES } from '../../src/middleware/errorBoundary.js';
import {
  createRequestContext,
  recordReference,
  routeLabel,
} from '../../src/middleware/requestContext.js';
import { createOperationalLogger } from '../../src/observability/operationalLog.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const HOSTILE_ERROR_TEXT = 'SELECT amount, note FROM salary_entries WHERE email = \'sentinel.person@example.test\' amount=87654.32';
const PUBLIC_TOKEN = 'SENTINELPUBLICTOKEN0123456789abcdef';
const SESSION_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.SENTINEL-session-token.sig';

function hostileError() {
  const error = new Error(HOSTILE_ERROR_TEXT);
  error.name = 'LibsqlError';
  error.code = 'SQLITE_ERROR';
  error.stack = `LibsqlError: ${HOSTILE_ERROR_TEXT}\n    at SENTINEL (/srv/app/src/db.js:10:5)`;
  error.sql = HOSTILE_ERROR_TEXT;
  error.args = ['sentinel.person@example.test', 8765432];
  return error;
}

function build({ logAllRequests = false } = {}) {
  const events = [];
  const logger = createOperationalLogger({
    level: 'debug',
    sink: (level, line) => events.push(JSON.parse(line)),
  });
  const app = express();
  app.use(createRequestContext({ logger, logAllRequests }));
  app.use(express.json({ limit: '1kb' }));

  const clarity = express.Router();
  clarity.get('/boom', () => { throw hostileError(); });
  clarity.get('/ok', (_req, res) => res.json({ ok: true }));
  clarity.post('/mutate', () => { throw hostileError(); });
  clarity.get('/conflict', (_req, res) => res.status(409).json({
    error: { code: 'RECORD_VERSION_CONFLICT', message: 'Version conflict.', currentRecordVersion: 3 },
  }));
  clarity.get('/missing', (_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use('/api/clarity/journeys', clarity);

  const finance = express.Router();
  finance.get('/boom', () => { throw hostileError(); });
  finance.post('/goals/:id/contributions', (_req, res) => res.status(409).json({
    error: { code: 'RECORD_VERSION_CONFLICT', message: 'Version conflict.' },
  }));
  finance.get('/explanations/:outcomeId', (_req, res) => res.json({ ok: true }));
  finance.get('/clarity', (_req, res) => res.json({ ok: true }));
  finance.get('/goals/:id', (_req, res) => res.json({ ok: true }));
  app.use('/api/finance', finance);

  const publicRoutes = express.Router();
  publicRoutes.get('/trips/:token', (_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use('/api/public', publicRoutes);

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use(createErrorBoundary({ logger }));
  return { app, events };
}

function assertNoLeak(text, label) {
  for (const secret of [
    'SELECT', 'salary_entries', 'sentinel.person', '87654', '8765432', 'SENTINEL',
    'at /srv', 'db.js', 'LibsqlError:', PUBLIC_TOKEN, SESSION_TOKEN,
  ]) {
    assert.ok(!text.includes(secret), `${label} leaked ${secret}`);
  }
}

test('every response carries a server-generated request ID that a client cannot choose', async () => {
  const { app } = build();
  const forged = '00000000-0000-4000-8000-000000000000';
  const response = await request(app).get('/api/health').set('X-Request-Id', forged);
  assert.match(response.headers['x-request-id'], UUID);
  assert.notEqual(response.headers['x-request-id'], forged);

  const second = await request(app).get('/api/health');
  assert.notEqual(second.headers['x-request-id'], response.headers['x-request-id']);
});

test('unexpected errors on new-contract routes return the fixed envelope with a correlation ID', async () => {
  const { app, events } = build();
  const read = await request(app)
    .get('/api/clarity/journeys/boom')
    .set('Authorization', `Bearer ${SESSION_TOKEN}`);

  assert.equal(read.status, 500);
  assert.deepEqual(read.body, {
    error: {
      code: 'INTERNAL_ERROR',
      message: UNEXPECTED_ERROR_ENVELOPES.INTERNAL_ERROR,
      retryable: true,
      correlationId: read.headers['x-request-id'],
    },
  });
  assertNoLeak(JSON.stringify(read.body) + JSON.stringify(read.headers), 'envelope');

  const write = await request(app)
    .post('/api/clarity/journeys/mutate')
    .set('Authorization', `Bearer ${SESSION_TOKEN}`)
    .send({ amount: '87654.32', note: 'SENTINEL-NOTE' });
  assert.equal(write.status, 500);
  assert.equal(write.body.error.code, 'MUTATION_FAILED');
  assert.equal(write.body.error.retryable, true);
  assert.equal(write.body.error.correlationId, write.headers['x-request-id']);
  assertNoLeak(JSON.stringify(write.body), 'mutation envelope');

  const unexpected = events.filter((event) => event.event === 'REQUEST_UNEXPECTED_ERROR');
  assert.equal(unexpected.length, 2);
  assert.deepEqual(Object.keys(unexpected[0]).sort(), [
    'code', 'errorName', 'event', 'level', 'method', 'requestId', 'route', 'status', 'ts',
  ]);
  assert.equal(unexpected[0].route, '/api/clarity/journeys/boom');
  assert.equal(unexpected[0].errorName, 'LibsqlError');
  assert.equal(unexpected[0].code, 'SQLITE_ERROR');
  assert.equal(unexpected[0].requestId, read.headers['x-request-id']);
  assertNoLeak(JSON.stringify(events), 'events');
  assert.ok(!JSON.stringify(events).includes('Bearer'));
});

test('a request that negotiated contract version 1 gets the envelope; a legacy request keeps its body', async () => {
  const { app } = build();
  const negotiated = await request(app)
    .get('/api/finance/boom')
    .set('X-Clarity-Contract', '1');
  assert.equal(negotiated.status, 500);
  assert.equal(negotiated.body.error.code, 'INTERNAL_ERROR');
  assert.equal(negotiated.body.error.retryable, true);
  assert.equal(negotiated.body.error.correlationId, negotiated.headers['x-request-id']);

  const legacy = await request(app).get('/api/finance/boom');
  assert.equal(legacy.status, 500);
  assert.deepEqual(legacy.body, { error: 'Server error' });
  assertNoLeak(JSON.stringify(legacy.body), 'legacy body');
});

test('legacy transport errors keep their existing responses', async () => {
  const { app } = build();
  const invalidJson = await request(app)
    .post('/api/clarity/journeys/mutate')
    .set('Content-Type', 'application/json')
    .send('{"amount": 87654.32, ');
  assert.equal(invalidJson.status, 400);
  assert.deepEqual(invalidJson.body, { error: 'Invalid JSON' });

  const tooLarge = await request(app)
    .post('/api/clarity/journeys/mutate')
    .set('Content-Type', 'application/json')
    .send(JSON.stringify({ note: 'x'.repeat(4096) }));
  assert.equal(tooLarge.status, 413);
  assert.deepEqual(tooLarge.body, { error: 'Payload too large' });

  const notFound = await request(app).get('/api/nothing-here');
  assert.equal(notFound.status, 404);
  assert.deepEqual(notFound.body, { error: 'Not found' });
});

test('completed requests log route pattern, status, duration bucket, outcome, and code only', async () => {
  const { app, events } = build();
  await request(app).get('/api/clarity/journeys/ok').set('Authorization', `Bearer ${SESSION_TOKEN}`);
  await request(app).get('/api/clarity/journeys/conflict?amount=87654.32&email=sentinel.person@example.test');
  await request(app).get('/api/clarity/journeys/missing');

  const completed = events.filter((event) => event.event === 'REQUEST_COMPLETED');
  assert.equal(completed.length, 3);
  const [success, conflict, missing] = completed;
  assert.deepEqual(
    [success.route, success.status, success.outcome, success.level],
    ['/api/clarity/journeys/ok', 200, 'success', 'info']
  );
  assert.deepEqual(
    [conflict.status, conflict.outcome, conflict.code, conflict.level],
    [409, 'conflict', 'RECORD_VERSION_CONFLICT', 'warn']
  );
  assert.equal(missing.outcome, 'client_error');
  for (const entry of completed) {
    assert.match(entry.requestId, UUID);
    assert.match(entry.durationBucket, /^(lt_\d+(ms|s)|gte_5s)$/);
    assert.deepEqual(Object.keys(entry).sort(), [
      'durationBucket', 'event', 'level', 'method', 'outcome', 'requestId', 'route', 'status', 'ts',
      ...(entry.code ? ['code'] : []),
    ].sort());
  }
  const serialized = JSON.stringify(events);
  for (const secret of ['87654', 'sentinel.person', 'amount=', SESSION_TOKEN, 'Authorization']) {
    assert.ok(!serialized.includes(secret), `events leaked ${secret}`);
  }
});

test('record type and numeric id come from the route pattern, never from other path text', async () => {
  const { app, events } = build();
  await request(app).post('/api/finance/goals/17/contributions').send({ contributionMinor: 8765432 });
  await request(app).get('/api/finance/explanations/goal:17');
  await request(app).get('/api/finance/explanations/trip:9?version=3');
  await request(app).get('/api/finance/explanations/monthly-plan:2026-01');

  const completed = events.filter((event) => event.event === 'REQUEST_COMPLETED');
  const goal = completed.find((entry) => entry.route === '/api/finance/goals/:id/contributions');
  assert.equal(goal.recordType, 'goal');
  assert.equal(goal.recordId, 17);
  assert.equal(goal.outcome, 'conflict');
  const explanations = completed.filter((entry) => entry.route === '/api/finance/explanations/:outcomeId');
  assert.deepEqual(explanations.map((entry) => [entry.recordType, entry.recordId]), [
    ['goal', 17], ['trip', 9], [undefined, undefined],
  ]);
  assert.ok(!JSON.stringify(events).includes('8765432'));

  const fakeReq = (path, route) => ({ originalUrl: path, route: { path: route }, method: 'GET' });
  assert.deepEqual(recordReference(fakeReq('/api/finance/goals/00017', '/goals/:id'), '/api/finance/goals/:id'), {});
  assert.deepEqual(
    recordReference(fakeReq('/api/finance/goals/9999999999999999999', '/goals/:id'), '/api/finance/goals/:id'),
    {}
  );
  assert.deepEqual(recordReference(fakeReq('/api/finance/clarity', '/clarity'), '/api/finance/clarity'), {});
});

test('unmatched routes and public token paths are logged by pattern, never by raw path', async () => {
  const { app, events } = build({ logAllRequests: true });
  await request(app).get(`/api/public/trips/${PUBLIC_TOKEN}`);
  await request(app).get('/api/this/path/has/sentinel.person@example.test/87654');
  await request(app).get('/api/health');

  const completed = events.filter((event) => event.event === 'REQUEST_COMPLETED');
  assert.deepEqual(completed.map((entry) => entry.route), ['/api/public/trips/:token', 'unmatched']);
  assert.ok(!JSON.stringify(events).includes(PUBLIC_TOKEN));
  assert.ok(!JSON.stringify(events).includes('sentinel.person'));
  assert.equal(
    routeLabel({ originalUrl: '/api/x/1?y=2', route: { path: '/x/:id' } }),
    '/api/x/:id'
  );
  assert.equal(routeLabel({ originalUrl: '/anything', route: undefined }), 'unmatched');
  // A route label that is not a safe pattern is replaced rather than logged.
  assert.equal(routeLabel({ originalUrl: '/api/x/1', route: { path: '/x/:id(\\d+)' } }), 'unmatched');
});

test('successful reads outside the clarity families are not logged unless every request is logged', async () => {
  const { app, events } = build();
  await request(app).get('/api/finance/goals/5');
  assert.equal(events.length, 0);

  await request(app).get('/api/finance/clarity');
  assert.equal(events.length, 1);
  assert.equal(events[0].route, '/api/finance/clarity');
});

test('an error after headers were sent closes the response without printing the error', async () => {
  const events = [];
  const logger = createOperationalLogger({
    level: 'debug',
    sink: (level, line) => events.push(JSON.parse(line)),
  });
  const originalConsoleError = console.error;
  const printed = [];
  console.error = (...args) => printed.push(args.map(String).join(' '));
  const app = express();
  app.use(createRequestContext({ logger }));
  app.get('/api/clarity/partial', (_req, res) => {
    res.write('{"partial":');
    throw hostileError();
  });
  app.use(createErrorBoundary({ logger }));
  try {
    await request(app).get('/api/clarity/partial').catch(() => {});
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(printed.length, 0);
  assertNoLeak(JSON.stringify(events), 'events');
});

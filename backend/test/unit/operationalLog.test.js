import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOWED_LOG_FIELDS,
  LOG_EVENTS,
  createOperationalLogger,
  durationBucket,
  isRoutePattern,
  logBackgroundFailure,
  logJobLine,
  outcomeKindForStatus,
  reportCalculationFailures,
  safeErrorCode,
  safeErrorName,
  sanitizeLogFields,
} from '../../src/observability/operationalLog.js';

const REQUEST_ID = '3f0c8a52-6d0e-4b8a-9c3f-2f2f5a7d1b11';

const SENSITIVE = Object.freeze({
  amount: 'SENTINEL-amount-87654.32',
  amountMinor: 8765432,
  email: 'sentinel.person@example.test',
  name: 'Priya Sentinel Kumar',
  note: 'SENTINEL-NOTE-lunch-with-Priya',
  splitJson: '{"splits":[{"memberId":1,"shareMinor":123456}]}',
  token: 'eyJhbGciOiJIUzI1NiJ9.SENTINEL-session-token.sig',
  publicToken: 'SENTINELPUBLICTOKEN0123456789abcdef',
  cronSecret: 'SENTINEL-cron-secret-value',
  hmac: 'SENTINEL-hmac-key-material',
  body: { description: 'SENTINEL-body-description', amount: '12,345.00' },
  userAgent: 'Mozilla/5.0 SENTINEL-UA',
  path: '/api/finance/goals/17?email=sentinel.person@example.test',
  stack: 'Error: SQLITE_ERROR: no such table\n    at SENTINEL (/srv/app.js:1:1)',
  message: 'SELECT amount FROM salary_entries WHERE user_id = 7',
});

function capture(options = {}) {
  const lines = [];
  const logger = createOperationalLogger({
    level: 'debug',
    clock: () => new Date('2026-02-03T04:05:06.000Z'),
    sink: (level, line) => lines.push({ level, line }),
    ...options,
  });
  return { logger, lines };
}

const originalLevel = process.env.OPERATIONAL_LOG_LEVEL;
afterEach(() => {
  if (originalLevel === undefined) delete process.env.OPERATIONAL_LOG_LEVEL;
  else process.env.OPERATIONAL_LOG_LEVEL = originalLevel;
});

test('unknown and sensitive fields are dropped and only counted', () => {
  const { logger, lines } = capture();
  const entry = logger.warn({
    event: 'REQUEST_COMPLETED',
    requestId: REQUEST_ID,
    status: 409,
    ...SENSITIVE,
  });

  assert.equal(lines.length, 1);
  const serialized = lines[0].line;
  for (const value of Object.values(SENSITIVE)) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    assert.ok(!serialized.includes(text), `leaked ${text}`);
  }
  for (const key of Object.keys(SENSITIVE)) {
    assert.ok(!Object.hasOwn(entry, key), `field name ${key} was kept`);
  }
  assert.equal(entry.requestId, REQUEST_ID);
  assert.equal(entry.status, 409);
  assert.equal(entry.droppedFields, Object.keys(SENSITIVE).length);
  assert.deepEqual(Object.keys(JSON.parse(serialized)).sort(), [
    'droppedFields', 'event', 'level', 'requestId', 'status', 'ts',
  ]);
});

test('allowlisted field names with out-of-contract values are dropped', () => {
  const hostile = {
    requestId: 'not-a-uuid SENTINEL',
    route: '/api/finance/goals/17',
    method: 'GET /secret',
    status: 99,
    durationBucket: '12.5ms',
    outcome: 'amount=8765432',
    code: 'sentinel_lower_case',
    operation: 'Goal Contribute',
    recordType: 'salary-amount',
    recordId: -4,
    userId: 'alice@example.test',
    outcomeKind: 'secret',
    periodType: 'daily',
    sourceStatus: 'ok',
    category: 'Has Spaces',
    errorName: 'Error: message with SELECT',
    dataVersion: 1.5,
    count: -1,
    retryable: 'yes',
    jobLine: '[job] sent to sentinel.person@example.test',
  };
  assert.deepEqual(Object.keys(hostile).sort(), [...ALLOWED_LOG_FIELDS].sort());
  const { record, dropped } = sanitizeLogFields(hostile);
  assert.deepEqual(record, {});
  assert.equal(dropped, ALLOWED_LOG_FIELDS.length);
});

test('valid fixed fields are kept unchanged', () => {
  const fields = {
    requestId: REQUEST_ID,
    route: '/api/finance/goals/:id/contributions',
    method: 'POST',
    status: 200,
    durationBucket: 'lt_250ms',
    outcome: 'success',
    code: 'RECORD_VERSION_CONFLICT',
    operation: 'goal.contribute',
    recordType: 'goal',
    recordId: 17,
    userId: 4,
    outcomeKind: 'goal',
    periodType: '28_day',
    sourceStatus: 'unavailable',
    category: 'account_profile',
    errorName: 'LibsqlError',
    dataVersion: 12,
    count: 3,
    retryable: true,
    jobLine: '[monthly-review] done · sent=1 skipped=2 failed=0',
  };
  const { record, dropped } = sanitizeLogFields(fields);
  assert.deepEqual(record, fields);
  assert.equal(dropped, 0);
});

test('route labels accept patterns and reject concrete values', () => {
  for (const ok of [
    'unmatched',
    '/',
    '/api/health',
    '/api/finance/clarity',
    '/api/finance/explanations/:outcomeId',
    '/api/public/trips/:token',
    '/api/finance/export.csv',
    '/api/trips/:id/expenses/:expenseId/personal-link',
  ]) {
    assert.equal(isRoutePattern(ok), true, ok);
  }
  for (const bad of [
    '/api/finance/goals/17',
    '/api/public/trips/SENTINELPUBLICTOKEN0123456789abcdef',
    '/api/auth/users/sentinel.person@example.test',
    '/api/finance/explanations/goal:17',
    '/api/x?month=2026-01',
    'api/finance',
    '/a/b/c/d/e/f/g/h/i/j',
    `/api/${'a'.repeat(130)}`,
    42,
    null,
  ]) {
    assert.equal(isRoutePattern(bad), false, String(bad));
  }
});

test('an unknown event code is replaced by a fixed rejection event', () => {
  const { logger } = capture();
  const entry = logger.info({ event: 'USER_ALICE_PAID_5000', requestId: REQUEST_ID });
  assert.equal(entry.event, 'LOG_EVENT_REJECTED');
  assert.ok(LOG_EVENTS.includes('LOG_EVENT_REJECTED'));
  assert.ok(!JSON.stringify(entry).includes('ALICE'));
  const missing = logger.info({ requestId: REQUEST_ID });
  assert.equal(missing.event, 'LOG_EVENT_REJECTED');
  assert.equal(logger.info('not an object').event, 'LOG_EVENT_REJECTED');
});

test('the logger honors levels and is silent by default under NODE_ENV=test', () => {
  const originalEnvironment = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  try {
    delete process.env.OPERATIONAL_LOG_LEVEL;
    const quiet = capture({ level: undefined });
    assert.equal(quiet.logger.error({ event: 'JOB_FAILED' }), null);
    assert.equal(quiet.lines.length, 0);

    process.env.NODE_ENV = 'production';
    const production = capture({ level: undefined });
    assert.ok(production.logger.info({ event: 'JOB_LINE', jobLine: '[job] ok' }));
    assert.equal(production.lines.length, 1);

    process.env.NODE_ENV = 'test';
    process.env.OPERATIONAL_LOG_LEVEL = 'warn';
    const warnOnly = capture({ level: undefined });
    assert.equal(warnOnly.logger.info({ event: 'JOB_LINE' }), null);
    assert.ok(warnOnly.logger.warn({ event: 'JOB_FAILED' }));
    assert.deepEqual(warnOnly.lines.map((entry) => entry.level), ['warn']);

    // An unrecognized level falls back to the environment default.
    process.env.OPERATIONAL_LOG_LEVEL = 'not-a-level';
    assert.equal(capture({ level: undefined }).logger.error({ event: 'JOB_FAILED' }), null);
  } finally {
    if (originalEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalEnvironment;
  }
});

test('a throwing sink, getter, or clock never propagates', () => {
  const throwingSink = capture({ sink: () => { throw new Error('sink failed'); } });
  assert.doesNotThrow(() => throwingSink.logger.error({ event: 'JOB_FAILED' }));

  const hostile = {};
  Object.defineProperty(hostile, 'event', { enumerable: true, get() { throw new Error('getter'); } });
  Object.defineProperty(hostile, 'status', { enumerable: true, get() { throw new Error('getter'); } });
  const { logger } = capture();
  assert.doesNotThrow(() => logger.error(hostile));

  const brokenClock = capture({ clock: () => { throw new Error('clock'); } });
  assert.equal(brokenClock.logger.error({ event: 'JOB_FAILED' }), null);
});

test('only the default console sink writes, resolved at call time', () => {
  const calls = [];
  const original = { warn: console.warn, error: console.error, log: console.log };
  console.warn = (...args) => calls.push(['warn', ...args]);
  console.error = (...args) => calls.push(['error', ...args]);
  console.log = (...args) => calls.push(['log', ...args]);
  try {
    const logger = createOperationalLogger({ level: 'debug' });
    logger.debug({ event: 'JOB_LINE', jobLine: '[job] ok' });
    logger.warn({ event: 'JOB_FAILED', email: SENSITIVE.email });
    logger.error({ event: 'JOB_FAILED', operation: 'monthly_review' });
  } finally {
    Object.assign(console, original);
  }
  assert.deepEqual(calls.map((call) => call[0]), ['log', 'warn', 'error']);
  for (const call of calls) {
    assert.equal(call.length, 2, 'one JSON string per call');
    assert.equal(typeof call[1], 'string');
    assert.doesNotThrow(() => JSON.parse(call[1]));
    assert.ok(!call[1].includes(SENSITIVE.email));
  }
});

test('job progress lines pass only when they match the fixed line shape', () => {
  const { logger, lines } = capture();
  assert.equal(logJobLine('[monthly-review] month=2026-01 dry=false', logger).event, 'JOB_LINE');
  assert.equal(logJobLine('[clarity-shadow] code=PLAN_INCOME_MISMATCH', logger).event, 'JOB_LINE');
  assert.equal(logJobLine('[dry] would send user_id=12', logger).event, 'JOB_LINE');

  for (const rejected of [
    '[monthly-review] sent to sentinel.person@example.test',
    '[monthly-review] income=₹87,654.32',
    '[monthly-review] path=/api/finance/goals/17',
    '[monthly-review] "quoted"',
    'no tag at all',
    `[monthly-review] ${'x'.repeat(200)}`,
    null,
  ]) {
    assert.equal(logJobLine(rejected, logger).event, 'LOG_EVENT_REJECTED', String(rejected));
  }
  assert.equal(lines.length, 10);
  assert.ok(lines.filter((entry) => entry.line.includes('sentinel.person')).length === 0);
});

test('error helpers expose only a class name and a stable code', () => {
  const sqlError = Object.assign(new Error(SENSITIVE.message), {
    name: 'LibsqlError',
    code: 'SQLITE_BUSY',
    stack: SENSITIVE.stack,
  });
  assert.equal(safeErrorName(sqlError), 'LibsqlError');
  assert.equal(safeErrorCode(sqlError), 'SQLITE_BUSY');
  assert.equal(safeErrorName({ name: 'has spaces and SELECT * FROM x' }), undefined);
  assert.equal(safeErrorCode({ code: 'lowercase' }), undefined);
  assert.equal(safeErrorCode({ code: 42 }), undefined);

  const { logger, lines } = capture();
  logBackgroundFailure('audit_write', sqlError, {}, logger);
  assert.deepEqual(JSON.parse(lines[0].line), {
    ts: '2026-02-03T04:05:06.000Z',
    level: 'warn',
    event: 'BACKGROUND_TASK_FAILED',
    operation: 'audit_write',
    errorName: 'LibsqlError',
    code: 'SQLITE_BUSY',
  });
  assert.ok(!lines[0].line.includes('SELECT'));
  assert.ok(!lines[0].line.includes('SENTINEL'));
});

test('duration buckets and outcome kinds are fixed enums', () => {
  assert.deepEqual(
    [0, 49.9, 50, 99, 100, 249, 250, 499, 500, 999, 1000, 4999, 5000, 1e9, Number.NaN, -1].map(durationBucket),
    [
      'lt_50ms', 'lt_50ms', 'lt_100ms', 'lt_100ms', 'lt_250ms', 'lt_250ms', 'lt_500ms', 'lt_500ms',
      'lt_1s', 'lt_1s', 'lt_5s', 'lt_5s', 'gte_5s', 'gte_5s', 'gte_5s', 'gte_5s',
    ]
  );
  assert.equal(outcomeKindForStatus(200), 'success');
  assert.equal(outcomeKindForStatus(204), 'success');
  assert.equal(outcomeKindForStatus(400), 'client_error');
  assert.equal(outcomeKindForStatus(404), 'client_error');
  assert.equal(outcomeKindForStatus(409), 'conflict');
  assert.equal(outcomeKindForStatus(422, 'RECORD_VERSION_CONFLICT'), 'conflict');
  assert.equal(outcomeKindForStatus(428), 'notice_required');
  assert.equal(outcomeKindForStatus(429), 'rate_limited');
  assert.equal(outcomeKindForStatus(500), 'server_error');
  assert.equal(outcomeKindForStatus(503), 'server_error');
});

test('calculation failures are reported by family and record id only', () => {
  const failed = (id, kind) => ({
    id,
    kind,
    status: 'calculation_failed',
    // Hostile content that must never be logged.
    value: { name: SENSITIVE.name, amount: SENSITIVE.amount },
    sourceRefs: [{ note: SENSITIVE.note }],
    failure: { code: 'CALCULATION_FAILED', message: SENSITIVE.message },
  });
  const snapshot = {
    dataVersion: 12,
    outcomes: {
      monthlyPlan: failed('monthly-plan:2026-01', 'monthly_plan'),
      spending: { id: 'spending:2026-01', kind: 'spending', status: 'available' },
      goals: [failed('goal:17', 'goal'), { id: 'goal:18', kind: 'goal', status: 'available' }],
      tripSummary: {
        id: 'trip-summary:2026-01',
        kind: 'trip_summary',
        status: 'available',
        items: [failed('trip:9', 'trip')],
      },
    },
  };
  const { logger, lines } = capture();
  const entries = reportCalculationFailures(snapshot, logger);

  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map((entry) => [entry.outcomeKind, entry.recordType, entry.recordId]), [
    ['monthly_plan', undefined, undefined],
    ['goal', 'goal', 17],
    ['trip', 'trip', 9],
  ]);
  for (const { line } of lines) {
    const parsed = JSON.parse(line);
    assert.equal(parsed.event, 'OUTCOME_CALCULATION_FAILED');
    assert.equal(parsed.code, 'CALCULATION_FAILED');
    assert.equal(parsed.dataVersion, 12);
    assert.equal(parsed.droppedFields, undefined);
    for (const secret of [SENSITIVE.name, SENSITIVE.amount, SENSITIVE.note, SENSITIVE.message]) {
      assert.ok(!line.includes(secret));
    }
  }
  assert.deepEqual(reportCalculationFailures(null, logger), []);
  assert.deepEqual(reportCalculationFailures({ outcomes: 'x' }, logger), []);
});

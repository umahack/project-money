import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, mock, test } from 'node:test';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createIsolatedTestDatabase } from '../helpers/testDatabase.js';
import { buildSessionFixture, buildUserFixture } from '../helpers/fixtures.js';

/**
 * End-to-end measurement pipeline (task 16.7, Requirements 11.12, 11.14, 11.15
 * and 13.x). One scenario runs through the real HTTP routes against an isolated
 * database, and the tests below assert different facets of it IN ORDER (later
 * tests build on earlier state; the clock only moves forward).
 *
 * The Date global is frozen and advanced by the test. SQLite's CURRENT_TIMESTAMP
 * cannot be injected, so after each route call that stamps a row with it
 * (journey start, consent change, change receipt) the stamp is rewritten to the
 * frozen instant. Everything else (ingestion, bounding, cohorts, periods,
 * outages, generation, retention, admin reads) is the production code path.
 *
 * Local zone is Asia/Kolkata (UTC+05:30, no DST). Week 1 is Mon 2026-01-05
 * 00:00 IST = 2026-01-04T18:30Z through Mon 2026-01-12 00:00 IST = 2026-01-11T18:30Z.
 *
 * Users (all journeys are `plan_month`, started 2026-01-06 UTC):
 *   U1 05:00  consented. first outcome +60 s, Yes, completes an action on 01-08.
 *   U2 05:10  consented. first outcome +100 s, No.
 *   U3 05:20  consented. first outcome sent from a second session (dropped:
 *             not the starting session), Partly (not session-bound).
 *   U4 05:30  consented, first outcome +50 s, Yes, then OPTS OUT on 01-07
 *             (inside week 1). Later events are dropped at receipt.
 *   U5 05:40  never consented; the journey is not measurement-eligible and
 *             every event is a no-op.
 *   U6 05:50  consented, first outcome +30 s, no clarity answer, OPTS OUT on
 *             01-12 04:00Z (after week 1 ended, before the first report run).
 *
 * Hand-computed week 1 (cohort = U1, U2, U3, U6; U4 is excluded because the
 * opt-out is before the period end, U5 because it was never eligible):
 *   first outcome rate        3 / 4   -> 75.0
 *   median time to outcome    {30 s, 60 s, 100 s} -> 60 s
 *   clarity confirmation      1 / 3   -> 33.3   (U1 Yes; U2 No; U3 Partly)
 *   action completion         1 / 3   -> 33.3   (U1 only; windows run to 01-13)
 *   reload rate               1 / 4   -> 25.0   (four consented changes)
 *   page-wide loading rate    1 / 4   -> 25.0
 *
 * The first 28-day period is generated after U6's opt-out, which is before ITS
 * end, so U6 is excluded there (cohort U1, U2, U3):
 *   first outcome rate        2 / 3   -> 66.7
 *   median                    {60 s, 100 s} -> 80 s
 *   clarity confirmation      1 / 3   -> 33.3
 *   action completion         1 / 2   -> 50.0
 * and its two financial-change metrics are unavailable because an outage of the
 * financial_record_changes source was recorded on 2026-01-13.
 */

const CRON_SECRET = 'pipeline-cron-secret-0123456789';
const WEEK_1 = {
  periodType: 'weekly',
  periodStart: '2026-01-04T18:30:00.000Z',
  periodEndExclusive: '2026-01-11T18:30:00.000Z',
};
const WEEK_2_START = '2026-01-11T18:30:00.000Z';
const WEEK_3_START = '2026-01-18T18:30:00.000Z';
const FIRST_28_DAY = {
  periodType: '28_day',
  periodStart: '2026-01-05T18:30:00.000Z',
  periodEndExclusive: '2026-02-02T18:30:00.000Z',
};
const OUTAGE = {
  sourceName: 'financial_record_changes',
  unavailableStart: '2026-01-13T00:00:00.000Z',
  unavailableEndExclusive: '2026-01-14T00:00:00.000Z',
};
const ACTION = 'recommended_action_completion_rate';
const COHORT_METRICS = [
  'first_meaningful_outcome_rate',
  'median_time_to_first_meaningful_outcome',
  'clarity_confirmation_rate',
  ACTION,
];
const CHANGE_METRICS = ['financial_change_reload_rate', 'financial_change_page_wide_loading_rate'];

// Values that must never appear in any stored event, visit, report, response, or log.
const SENTINEL_AMOUNTS = ['8765432', '87654.32', '87,654', '4321.09'];
const SENTINEL_NOTE = 'SENTINEL-NOTE-lunch-with-Priya';
const SENTINEL_PATH = '/trips/42?email=sentinel-path@example.test&amount=987654';
const SENTINEL_FREE_TEXT = 'Priya Sentinel Kumar';

let testDatabase;
let db;
let app;
let reportRepository;
let measurementRepository;
let MeasurementReportService;
let modules;
const users = {};
const tokens = [];
const consoleLines = [];
let restoreConsole = () => {};
let keyCounter = 0;

const sqliteTime = (iso) => iso.slice(0, 19).replace('T', ' ');
const clockAt = (iso) => mock.timers.setTime(Date.parse(iso));

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

function tokenFor(user, session) {
  const token = jwt.sign(
    { sub: String(user.id), tv: user.token_version, sid: session.id },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '3650d' }
  );
  tokens.push(token);
  return `Bearer ${token}`;
}

async function insertAccount(user, sessions) {
  await db.prepare(
    `INSERT INTO users (id, email, name, password_hash, is_admin, token_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(user.id, user.email, user.name, user.password_hash, user.is_admin, user.token_version, user.created_at);
  for (const session of sessions) {
    await db.prepare(
      `INSERT INTO sessions (id, user_id, device_label, ip_hash, user_agent, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(session.id, session.user_id, session.device_label, session.ip_hash, session.user_agent,
      session.created_at, session.last_seen_at);
  }
}

async function createUser(key, number, { admin = false, secondSession = false } = {}) {
  const id = 17_000 + number;
  const user = buildUserFixture({
    id,
    email: `sentinel-user-${id}@example.test`,
    name: `Sentinel Person ${id}`,
    is_admin: admin ? 1 : 0,
  });
  const session = buildSessionFixture({ id: 17_100 + number, userId: id });
  const sessions = [session];
  let second = null;
  if (secondSession) {
    second = buildSessionFixture({ id: 17_200 + number, userId: id });
    sessions.push(second);
  }
  await insertAccount(user, sessions);
  users[key] = {
    id,
    email: user.email,
    name: user.name,
    sessionId: session.id,
    auth: tokenFor(user, session),
    secondAuth: second ? tokenFor(user, second) : null,
    record: user,
  };
}

async function setAnalytics(user, enabled, iso, { acknowledge = enabled } = {}) {
  clockAt(iso);
  const body = {
    ...(acknowledge ? { acknowledgedNoticeVersion: 1 } : {}),
    ...(enabled === null ? {} : { analyticsEnabled: enabled }),
  };
  const response = await request(app)
    .patch('/api/clarity/settings')
    .set('Authorization', user.auth)
    .send(body);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  if (enabled !== null) {
    await db.prepare('UPDATE user_financial_state SET analytics_changed_at = ? WHERE user_id = ?')
      .run(sqliteTime(iso), user.id);
  }
}

async function startJourney(user, iso) {
  clockAt(iso);
  const response = await request(app)
    .post('/api/clarity/journeys')
    .set('Authorization', user.auth)
    .send({ desiredOutcome: 'plan_month' });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  user.journeyId = response.body.journey.id;
  await db.prepare('UPDATE guided_journeys SET started_at = ?, updated_at = ? WHERE id = ?')
    .run(sqliteTime(iso), sqliteTime(iso), user.journeyId);
}

async function sendEvent(user, iso, fields, { auth = user.auth } = {}) {
  clockAt(iso);
  const response = await request(app)
    .post('/api/clarity/events')
    .set('Authorization', auth)
    .send({ occurredAt: iso, ...fields });
  assert.equal(response.status, 204, `${fields.event}: ${JSON.stringify(response.body)}`);
}

const journeyEvent = (user, event, extra = {}) => ({ event, journeyId: user.journeyId, ...extra });

async function createChange(user, iso, path, body) {
  clockAt(iso);
  keyCounter += 1;
  const response = await request(app)
    .post(path)
    .set('Authorization', user.auth)
    .set('X-Clarity-Contract', '1')
    .set('Idempotency-Key', `c2000000-0000-4000-8000-${String(keyCounter).padStart(12, '0')}`)
    .send(body);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const changeId = response.body.mutation.changeId;
  await db.prepare('UPDATE financial_record_changes SET occurred_at = ? WHERE id = ?')
    .run(sqliteTime(iso), changeId);
  return changeId;
}

const changeEvent = (changeId, causedReload, causedPageWideLoading) => ({
  event: 'financial_change_ui',
  changeId,
  causedReload,
  causedPageWideLoading,
});

const cronCall = (query = '') => request(app)
  .post(`/api/internal/cron/clarity-reports${query}`)
  .set('x-cron-secret', CRON_SECRET);

const adminGet = (query = '') => request(app)
  .get(`/api/admin/clarity-reports${query}`)
  .set('Authorization', users.admin.auth);

async function count(sql, ...args) {
  return Number((await db.prepare(sql).get(...args)).count);
}

const eventCount = (userId) => count(
  'SELECT COUNT(*) AS count FROM product_measurement_events WHERE user_id = ?', userId
);

async function reportSnapshot({ withGeneratedAt = true } = {}) {
  const rows = await db.prepare(
    'SELECT * FROM success_metric_reports ORDER BY period_type, period_start, metric_name'
  ).all();
  return rows.map((row) => {
    const { id: _id, generated_at: generatedAt, ...rest } = { ...row };
    return withGeneratedAt ? { ...rest, generated_at: generatedAt } : rest;
  });
}

async function adminReport(periodType, periodStart) {
  const response = await adminGet(`?periodType=${periodType}&limit=100`);
  assert.equal(response.status, 200);
  const report = response.body.reports.find((entry) => entry.periodStart === periodStart);
  assert.ok(report, `${periodType} report starting ${periodStart} should exist`);
  return {
    report,
    metrics: Object.fromEntries(report.metrics.map((metric) => [metric.metricName, metric])),
  };
}

function pick(metric, fields) {
  return Object.fromEntries(fields.map((field) => [field, metric[field]]));
}

function assertNoSentinels(text, label) {
  const needles = [
    ...Object.values(users).flatMap((user) => [user.email, user.name]),
    ...SENTINEL_AMOUNTS,
    SENTINEL_NOTE,
    SENTINEL_PATH,
    'sentinel-path@example.test',
    SENTINEL_FREE_TEXT,
    CRON_SECRET,
    ...tokens,
  ];
  for (const needle of needles) {
    assert.ok(!text.includes(needle), `${label} must not contain a prohibited value (${needle.slice(0, 18)}…)`);
  }
  assert.doesNotMatch(text, /@example\.test/i, `${label} must not contain an email address`);
  assert.doesNotMatch(text, /eyJ[A-Za-z0-9_-]{10,}\./, `${label} must not contain a bearer token`);
}

before(async () => {
  testDatabase = await createIsolatedTestDatabase();
  db = testDatabase.db;
  process.env.FINANCIAL_MUTATION_HMAC_KEY =
    'test-only-measurement-pipeline-hmac-key-32-bytes-minimum';
  process.env.CRON_SECRET = CRON_SECRET;
  // Operational logging is silent under NODE_ENV=test; this suite asserts on it.
  process.env.OPERATIONAL_LOG_LEVEL = 'info';
  captureConsole();
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-06T04:00:00.000Z') });

  const [{ createApp }, report, measurement, reportRepo, measurementRepo, visits, domain] =
    await Promise.all([
      import('../../src/app.js'),
      import('../../src/services/measurementReportService.js'),
      import('../../src/services/measurementService.js'),
      import('../../src/repositories/measurementReportRepository.js'),
      import('../../src/repositories/measurementRepository.js'),
      import('../../src/routes/visits.js'),
      import('../../src/domain/measurement.js'),
    ]);
  reportRepository = reportRepo.default;
  measurementRepository = measurementRepo.default;
  MeasurementReportService = report.MeasurementReportService;
  modules = { measurement, visits, domain };
  app = createApp();
});

after(async () => {
  mock.timers.reset();
  restoreConsole();
  await testDatabase?.cleanup();
});

// ---------------------------------------------------------------------------
// 1. Pipeline: journeys, consent, events, change receipts
// ---------------------------------------------------------------------------

test('journeys, consent changes, events, and change receipts flow through the API with consent decided at receipt', async () => {
  await createUser('admin', 0, { admin: true });
  await createUser('member', 9);
  for (const [key, number] of [['u1', 1], ['u2', 2], ['u4', 4], ['u5', 5], ['u6', 6]]) {
    await createUser(key, number);
  }
  await createUser('u3', 3, { secondSession: true });
  const { u1, u2, u3, u4, u5, u6 } = users;

  // Consent. U5 acknowledges the data-use notice but never enables analytics.
  for (const user of [u1, u2, u3, u4, u6]) await setAnalytics(user, true, '2026-01-06T04:30:00.000Z');
  await setAnalytics(u5, null, '2026-01-06T04:30:00.000Z', { acknowledge: true });
  await setAnalytics(users.member, null, '2026-01-06T04:30:00.000Z', { acknowledge: true });

  // Journeys start through the route; eligibility is copied from consent at start.
  await startJourney(u1, '2026-01-06T05:00:00.000Z');
  await startJourney(u2, '2026-01-06T05:10:00.000Z');
  await startJourney(u3, '2026-01-06T05:20:00.000Z');
  await startJourney(u4, '2026-01-06T05:30:00.000Z');
  await startJourney(u5, '2026-01-06T05:40:00.000Z');
  await startJourney(u6, '2026-01-06T05:50:00.000Z');
  const eligible = await db.prepare(
    'SELECT user_id, measurement_eligible FROM guided_journeys ORDER BY user_id'
  ).all();
  assert.deepEqual(
    eligible.map((row) => [Number(row.user_id), Number(row.measurement_eligible)]),
    [[17_001, 1], [17_002, 1], [17_003, 1], [17_004, 1], [17_005, 0], [17_006, 1]]
  );

  // U1: start, first outcome after 60 s, Yes.
  await sendEvent(u1, '2026-01-06T05:00:30.000Z', journeyEvent(u1, 'journey_started', { desiredOutcome: 'plan_month' }));
  await sendEvent(u1, '2026-01-06T05:01:00.000Z', journeyEvent(u1, 'first_outcome_displayed', { outcomeKind: 'monthly_plan' }));
  await sendEvent(u1, '2026-01-06T05:02:00.000Z', journeyEvent(u1, 'clarity_response', { response: 'yes' }));
  // U2: first outcome after 100 s, No.
  await sendEvent(u2, '2026-01-06T05:10:30.000Z', journeyEvent(u2, 'journey_started', { desiredOutcome: 'plan_month' }));
  await sendEvent(u2, '2026-01-06T05:11:40.000Z', journeyEvent(u2, 'first_outcome_displayed', { outcomeKind: 'monthly_plan' }));
  await sendEvent(u2, '2026-01-06T05:12:00.000Z', journeyEvent(u2, 'clarity_response', { response: 'no' }));
  // U3: the first outcome comes from another session and is dropped; Partly is accepted.
  await sendEvent(u3, '2026-01-06T05:20:30.000Z',
    journeyEvent(u3, 'first_outcome_displayed', { outcomeKind: 'monthly_plan' }), { auth: u3.secondAuth });
  assert.equal(await eventCount(u3.id), 0, 'a non-starting session cannot record a first outcome');
  await sendEvent(u3, '2026-01-06T05:21:00.000Z',
    journeyEvent(u3, 'clarity_response', { response: 'partly' }), { auth: u3.secondAuth });
  // U4: events while opted in.
  await sendEvent(u4, '2026-01-06T05:30:50.000Z', journeyEvent(u4, 'first_outcome_displayed', { outcomeKind: 'monthly_plan' }));
  await sendEvent(u4, '2026-01-06T05:31:00.000Z', journeyEvent(u4, 'clarity_response', { response: 'yes' }));
  // U5 is never consented: every event is a no-op.
  await sendEvent(u5, '2026-01-06T05:40:30.000Z', journeyEvent(u5, 'first_outcome_displayed', { outcomeKind: 'monthly_plan' }));
  // U6: first outcome after 30 s, no clarity answer.
  await sendEvent(u6, '2026-01-06T05:50:30.000Z', journeyEvent(u6, 'first_outcome_displayed', { outcomeKind: 'monthly_plan' }));

  // Opt-out wins at receipt: U4 turns analytics off, later events are dropped, records stay.
  await setAnalytics(u4, false, '2026-01-07T04:00:00.000Z', { acknowledge: false });
  const u4Before = await eventCount(u4.id);
  assert.equal(u4Before, 2);
  await sendEvent(u4, '2026-01-07T04:01:00.000Z', journeyEvent(u4, 'recommended_action_completed', {
    recommendationInstanceId: crypto.randomUUID(),
    actionKey: 'review_bills',
  }));
  assert.equal(await eventCount(u4.id), u4Before, 'no event is stored after opt-out');
  const u4Journey = await db.prepare('SELECT status, measurement_eligible FROM guided_journeys WHERE id = ?').get(u4.journeyId);
  assert.equal(u4Journey.status, 'active', 'opting out preserves the journey');

  // Financial changes. Week 1 has four consented changes and one from the non-consenting user.
  const change = {};
  change.c1 = await createChange(u1, '2026-01-07T05:00:00.000Z', '/api/finance/salary',
    { amountMinor: 8_765_432, month: '2026-01', expectedRecordVersion: 0 });
  await sendEvent(u1, '2026-01-07T05:00:10.000Z', changeEvent(change.c1, false, false));
  await sendEvent(u1, '2026-01-07T05:00:11.000Z', changeEvent(change.c1, false, false));
  change.c2 = await createChange(u1, '2026-01-07T05:05:00.000Z', '/api/finance/salary',
    { amountMinor: 8_765_432, month: '2026-01', expectedRecordVersion: 1 });
  await sendEvent(u1, '2026-01-07T05:05:10.000Z', changeEvent(change.c2, true, false));
  change.c3 = await createChange(u2, '2026-01-07T05:10:00.000Z', '/api/finance/salary',
    { amountMinor: 8_765_432, month: '2026-01', expectedRecordVersion: 0 });
  await sendEvent(u2, '2026-01-07T05:10:10.000Z', changeEvent(change.c3, false, true));
  change.c4 = await createChange(u1, '2026-01-07T05:15:00.000Z', '/api/finance/expenses', {
    amount: '4321.09', category: 'Food', note: SENTINEL_NOTE, spentOn: '2026-01-07', expectedRecordVersion: 0,
  });
  await sendEvent(u1, '2026-01-07T05:15:10.000Z', changeEvent(change.c4, false, false));
  change.c0 = await createChange(u5, '2026-01-07T05:20:00.000Z', '/api/finance/salary',
    { amountMinor: 8_765_432, month: '2026-01', expectedRecordVersion: 0 });
  await sendEvent(u5, '2026-01-07T05:20:10.000Z', changeEvent(change.c0, true, true));
  assert.equal(await eventCount(u5.id), 0, 'a non-consenting user stores no event, including change events');
  assert.equal(await count('SELECT COUNT(*) AS count FROM financial_record_changes'), 5, 'receipts exist for every change');

  // U1 completes a recommended action two days later.
  await sendEvent(u1, '2026-01-08T05:00:00.000Z', journeyEvent(u1, 'recommended_action_completed', {
    recommendationInstanceId: crypto.randomUUID(),
    actionKey: 'review_bills',
  }));

  // U6 opts out after week 1 ended and before the first report run.
  await setAnalytics(u6, false, '2026-01-12T04:00:00.000Z', { acknowledge: false });

  // Per-user stored events: U1 start/outcome/clarity/3 changes/action = 7, U2 = 4, U3 = 1, U4 = 2, U6 = 1.
  assert.deepEqual(
    await Promise.all([u1, u2, u3, u4, u5, u6].map((user) => eventCount(user.id))),
    [7, 4, 1, 2, 0, 1]
  );
  assert.equal(await count('SELECT COUNT(*) AS count FROM product_measurement_events'), 15);
  assert.equal(
    await count("SELECT COUNT(*) AS count FROM product_measurement_events WHERE event_name = 'financial_change_ui'"),
    4,
    'a repeated change event is stored once'
  );
});

// ---------------------------------------------------------------------------
// 2. First run: week 1 only, action metric deferred while windows are open
// ---------------------------------------------------------------------------

test('the first cron run materializes only completed week 1 and defers the open-window action metric', async () => {
  clockAt('2026-01-12T06:30:00.000Z'); // Mon 12:00 IST: week 1 is complete, week 2 is open.

  const dry = await cronCall('?dry=1');
  assert.equal(dry.status, 200);
  assert.equal(dry.body.dry, true);
  assert.equal(dry.body.periods.weekly.generated, 1);
  assert.equal(dry.body.periods['28_day'].generated, 0, 'the first 28-day period ends 2026-02-03');
  assert.equal(await count('SELECT COUNT(*) AS count FROM success_metric_reports'), 0);
  assert.equal(await count('SELECT COUNT(*) AS count FROM measurement_report_checkpoints'), 0);

  const run = await cronCall();
  assert.equal(run.status, 200);
  assert.equal(run.body.ok, true);
  assert.deepEqual(run.body.failures, []);
  assert.equal(run.body.periods.weekly.generated, 1);
  assert.equal(run.body.actionMetric.deferred, 1);
  assert.equal(run.body.actionMetric.finalized, 0);
  assert.equal(run.body.retention.purgedEvents, 0);
  assert.equal(await count('SELECT COUNT(*) AS count FROM success_metric_reports'), 5);

  const { report, metrics } = await adminReport('weekly', WEEK_1.periodStart);
  assert.deepEqual(report.deferredMetrics, [ACTION]);
  assert.equal(metrics[ACTION], undefined, 'no provisional action rate is written');
  assert.equal(metrics.first_meaningful_outcome_rate.percentageDisplay, '75.0');
  const checkpoint = await measurementRepository.getReportCheckpoint('weekly');
  assert.equal(checkpoint.record.lastPeriodEndExclusive, WEEK_1.periodEndExclusive);
});

// ---------------------------------------------------------------------------
// 3. Later run: hand-computed numbers, outage isolation, opt-out handling
// ---------------------------------------------------------------------------

test('later runs backfill completed periods, finish the action metric, and match hand-computed numbers', async () => {
  const { u1, u2 } = users;

  // Week 2 activity: two more consented changes, then an outage of the change-receipt source.
  const c5 = await createChange(u1, '2026-01-14T05:00:00.000Z', '/api/finance/expenses', {
    amount: '4321.09', category: 'Food', note: SENTINEL_NOTE, spentOn: '2026-01-14', expectedRecordVersion: 0,
  });
  await sendEvent(u1, '2026-01-14T05:00:10.000Z', changeEvent(c5, true, false));
  const c6 = await createChange(u2, '2026-01-14T05:05:00.000Z', '/api/finance/salary',
    { amountMinor: 8_765_432, month: '2026-01', expectedRecordVersion: 1 });
  await sendEvent(u2, '2026-01-14T05:05:10.000Z', changeEvent(c6, false, false));
  clockAt('2026-01-14T06:00:00.000Z');
  await measurementRepository.recordSourceOutage(OUTAGE);

  clockAt('2026-02-10T06:30:00.000Z'); // Tue 12:00 IST
  const run = await cronCall();
  assert.equal(run.status, 200);
  assert.deepEqual(run.body.failures, []);
  assert.equal(run.body.periods.weekly.generated, 4, 'weeks ending 01-19, 01-26, 02-02, 02-09');
  assert.equal(run.body.periods['28_day'].generated, 8, 'periods ending 02-03 through 02-10');
  assert.equal(run.body.actionMetric.finalized, 1, 'week 1 action metric is finished once its windows closed');
  assert.equal(run.body.actionMetric.pending, 0);
  assert.equal(await count('SELECT COUNT(*) AS count FROM success_metric_reports'), (5 + 8) * 6);

  // Week 1: U6 opted out after the period ended, so U6 is still in the cohort.
  const week1 = await adminReport('weekly', WEEK_1.periodStart);
  assert.equal(week1.report.periodEndExclusive, WEEK_1.periodEndExclusive);
  assert.equal(week1.report.timeZone, 'Asia/Kolkata');
  assert.deepEqual(week1.report.deferredMetrics, []);
  const fields = ['numerator', 'denominator', 'percentageTenths', 'percentageDisplay', 'durationMs', 'targetStatus', 'sourceStatus'];
  assert.deepEqual(pick(week1.metrics.first_meaningful_outcome_rate, fields), {
    numerator: 3, denominator: 4, percentageTenths: 750, percentageDisplay: '75.0',
    durationMs: null, targetStatus: null, sourceStatus: 'complete',
  });
  assert.deepEqual(pick(week1.metrics.median_time_to_first_meaningful_outcome, fields), {
    numerator: null, denominator: 3, percentageTenths: null, percentageDisplay: null,
    durationMs: 60_000, targetStatus: null, sourceStatus: 'complete',
  });
  assert.deepEqual(pick(week1.metrics.clarity_confirmation_rate, fields), {
    numerator: 1, denominator: 3, percentageTenths: 333, percentageDisplay: '33.3',
    durationMs: null, targetStatus: null, sourceStatus: 'complete',
  });
  assert.deepEqual(pick(week1.metrics[ACTION], fields), {
    numerator: 1, denominator: 3, percentageTenths: 333, percentageDisplay: '33.3',
    durationMs: null, targetStatus: null, sourceStatus: 'complete',
  });
  for (const name of CHANGE_METRICS) {
    assert.deepEqual(pick(week1.metrics[name], fields), {
      numerator: 1, denominator: 4, percentageTenths: 250, percentageDisplay: '25.0',
      durationMs: null, targetStatus: 'not_met', sourceStatus: 'complete',
    }, name);
  }
  for (const metric of week1.report.metrics) {
    assert.ok(metric.populationDefinition.length > 0);
    assert.equal(metric.unavailableSource, null);
  }

  // First 28-day period: U6 opted out before this period's end, so the cohort is U1, U2, U3.
  const month = await adminReport('28_day', FIRST_28_DAY.periodStart);
  assert.equal(month.report.periodEndExclusive, FIRST_28_DAY.periodEndExclusive);
  assert.deepEqual(month.report.deferredMetrics, []);
  assert.deepEqual(pick(month.metrics.first_meaningful_outcome_rate, fields), {
    numerator: 2, denominator: 3, percentageTenths: 667, percentageDisplay: '66.7',
    durationMs: null, targetStatus: 'insufficient_data', sourceStatus: 'complete',
  });
  assert.deepEqual(pick(month.metrics.median_time_to_first_meaningful_outcome, fields), {
    numerator: null, denominator: 2, percentageTenths: null, percentageDisplay: null,
    durationMs: 80_000, targetStatus: 'insufficient_data', sourceStatus: 'complete',
  });
  assert.deepEqual(pick(month.metrics.clarity_confirmation_rate, fields), {
    numerator: 1, denominator: 3, percentageTenths: 333, percentageDisplay: '33.3',
    durationMs: null, targetStatus: 'insufficient_data', sourceStatus: 'complete',
  });
  assert.deepEqual(pick(month.metrics[ACTION], fields), {
    numerator: 1, denominator: 2, percentageTenths: 500, percentageDisplay: '50.0',
    durationMs: null, targetStatus: 'insufficient_data', sourceStatus: 'complete',
  });
});

// ---------------------------------------------------------------------------
// 4. Opt-out race at pipeline level
// ---------------------------------------------------------------------------

test('opt-out between event receipt and report generation follows the documented consent handling', async () => {
  const { u4, u5, u6 } = users;
  const week1 = (await adminReport('weekly', WEEK_1.periodStart)).metrics;
  const month = (await adminReport('28_day', FIRST_28_DAY.periodStart)).metrics;

  // U4 opted out inside week 1 and U5 was never eligible: excluded from both populations
  // (including them would make the first-outcome denominators 5 and 6).
  assert.equal(week1.first_meaningful_outcome_rate.denominator, 4);
  assert.equal(month.first_meaningful_outcome_rate.denominator, 3);

  // U6 opted out after week 1 ended: counted there (analytics was on through the period)...
  assert.equal(week1.first_meaningful_outcome_rate.numerator, 3);
  // ...but not in the 28-day period that ends after the opt-out (consent is a current-state snapshot).
  assert.equal(month.first_meaningful_outcome_rate.numerator, 2);

  // Consent stays what the user chose, and nothing new was recorded for opted-out users.
  const consent = await db.prepare(
    'SELECT user_id, analytics_enabled FROM user_financial_state WHERE user_id IN (?, ?, ?) ORDER BY user_id'
  ).all(u4.id, u5.id, u6.id);
  assert.deepEqual(consent.map((row) => Number(row.analytics_enabled)), [0, 0, 0]);
  await sendEvent(u6, '2026-02-10T06:31:00.000Z', journeyEvent(u6, 'clarity_response', { response: 'yes' }));
  assert.equal(await eventCount(u6.id), 1, 'a late retry after opt-out is dropped');
});

// ---------------------------------------------------------------------------
// 5. Source outage: unavailable, not zero
// ---------------------------------------------------------------------------

test('an outage of one source makes only its metrics unavailable (null), never zero', async () => {
  const outageFields = ['numerator', 'denominator', 'percentageTenths', 'percentageDisplay', 'durationMs', 'targetStatus', 'sourceStatus'];

  const week2 = await adminReport('weekly', WEEK_2_START);
  for (const name of CHANGE_METRICS) {
    const metric = week2.metrics[name];
    assert.deepEqual(pick(metric, outageFields), {
      numerator: null, denominator: null, percentageTenths: null, percentageDisplay: null,
      durationMs: null, targetStatus: null, sourceStatus: 'unavailable',
    }, name);
    assert.deepEqual(metric.unavailableSources, ['financial_record_changes']);
    assert.equal(metric.unavailableStart, OUTAGE.unavailableStart);
    assert.equal(metric.unavailableEndExclusive, OUTAGE.unavailableEndExclusive);
  }
  // Unaffected metrics in the same period are real measurements of an empty cohort: 0 / 0, not null counts.
  for (const name of COHORT_METRICS) {
    const metric = week2.metrics[name];
    assert.equal(metric.sourceStatus, 'complete', name);
    assert.equal(metric.denominator, 0, name);
    assert.equal(metric.percentageTenths, null);
    assert.equal(metric.unavailableSource, null);
  }

  // A period without an overlapping outage reports zero changes, not unavailable.
  const week3 = await adminReport('weekly', WEEK_3_START);
  for (const name of CHANGE_METRICS) {
    assert.equal(week3.metrics[name].sourceStatus, 'complete', name);
    assert.deepEqual([week3.metrics[name].numerator, week3.metrics[name].denominator], [0, 0]);
  }

  // The outage also reaches every 28-day period that overlaps it, and still isolates the other metrics.
  const monthly = await adminGet('?periodType=28_day&limit=100');
  assert.equal(monthly.body.reports.length, 8);
  for (const period of monthly.body.reports) {
    for (const metric of period.metrics) {
      if (CHANGE_METRICS.includes(metric.metricName)) {
        assert.equal(metric.sourceStatus, 'unavailable', `${period.periodStart} ${metric.metricName}`);
        assert.equal(metric.percentageTenths, null);
        assert.equal(metric.targetStatus, null);
      } else {
        assert.equal(metric.sourceStatus, 'complete', `${period.periodStart} ${metric.metricName}`);
      }
    }
  }

  // Week 1 ended before the outage and is untouched.
  const week1 = await adminReport('weekly', WEEK_1.periodStart);
  assert.ok(week1.report.metrics.every((metric) => metric.sourceStatus === 'complete'));
});

// ---------------------------------------------------------------------------
// 6. Idempotency and determinism
// ---------------------------------------------------------------------------

test('repeated cron runs are idempotent and a from-scratch replay reproduces every aggregate', async () => {
  const stored = await reportSnapshot();
  assert.equal(stored.length, 78);
  const checkpoints = await db.prepare('SELECT * FROM measurement_report_checkpoints ORDER BY period_type').all();

  clockAt('2026-02-10T06:45:00.000Z'); // later the same local day: nothing new is complete
  for (let run = 0; run < 2; run += 1) {
    const repeat = await cronCall();
    assert.equal(repeat.status, 200);
    assert.equal(repeat.body.periods.weekly.generated, 0);
    assert.equal(repeat.body.periods['28_day'].generated, 0);
    assert.deepEqual(repeat.body.actionMetric, { deferred: 0, finalized: 0, pending: 0 });
    assert.equal(repeat.body.retention.purgedEvents, 0);
  }
  assert.deepEqual(await reportSnapshot(), stored, 'rows (including generated_at) are untouched by repeat runs');
  assert.deepEqual(
    await db.prepare('SELECT * FROM measurement_report_checkpoints ORDER BY period_type').all(),
    checkpoints
  );

  // Replay: erase every aggregate and checkpoint, then generate everything in one run.
  const incremental = await reportSnapshot({ withGeneratedAt: false });
  await db.prepare('DELETE FROM success_metric_reports').run();
  await db.prepare('DELETE FROM measurement_report_checkpoints').run();
  const replay = await cronCall();
  assert.equal(replay.status, 200);
  assert.equal(replay.body.periods.weekly.generated, 5);
  assert.equal(replay.body.periods['28_day'].generated, 8);
  assert.deepEqual(
    await reportSnapshot({ withGeneratedAt: false }),
    incremental,
    'an incremental history and a single-run replay store identical aggregates'
  );
  const again = await cronCall();
  assert.equal(again.body.periods.weekly.generated, 0);
});

// ---------------------------------------------------------------------------
// 7. Admin and cron access
// ---------------------------------------------------------------------------

test('admin report reads are 401/403/200 with aggregate-only bodies, and cron needs its secret', async () => {
  const { admin, member } = users;
  const anonymous = await request(app).get('/api/admin/clarity-reports');
  assert.equal(anonymous.status, 401);
  const forged = await request(app).get('/api/admin/clarity-reports').set('Authorization', 'Bearer not-a-token');
  assert.equal(forged.status, 401);
  const asMember = await request(app).get('/api/admin/clarity-reports').set('Authorization', member.auth);
  assert.equal(asMember.status, 403);

  // Authorization is re-read per request: demotion and session revocation take effect immediately.
  await db.prepare('UPDATE users SET is_admin = 0 WHERE id = ?').run(admin.id);
  assert.equal((await adminGet()).status, 403);
  await db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(admin.id);
  await db.prepare("UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP, revoked_reason = 'logout' WHERE id = ?").run(admin.sessionId);
  assert.equal((await adminGet()).status, 401);
  await db.prepare('UPDATE sessions SET revoked_at = NULL, revoked_reason = NULL WHERE id = ?').run(admin.sessionId);

  for (const denied of [anonymous, forged, asMember]) {
    assert.equal(denied.body.reports, undefined);
    assertNoSentinels(JSON.stringify(denied.body), 'denied admin response');
  }

  const ok = await adminGet('?limit=100');
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['cache-control'], 'no-store');
  assert.deepEqual(Object.keys(ok.body).sort(), ['reports', 'timeZone']);
  const metricKeys = [
    'denominator', 'durationMs', 'generatedAt', 'metricName', 'numerator', 'percentageDisplay',
    'percentageTenths', 'populationDefinition', 'sourceStatus', 'targetStatus',
    'unavailableEndExclusive', 'unavailableSource', 'unavailableSources', 'unavailableStart',
  ];
  assert.ok(ok.body.reports.length > 0);
  for (const report of ok.body.reports) {
    assert.deepEqual(
      Object.keys(report).sort(),
      ['deferredMetrics', 'metrics', 'periodEndExclusive', 'periodStart', 'periodType', 'timeZone']
    );
    for (const metric of report.metrics) assert.deepEqual(Object.keys(metric).sort(), metricKeys);
  }
  const serialized = JSON.stringify(ok.body);
  assertNoSentinels(serialized, 'admin response');
  for (const user of Object.values(users)) {
    assert.ok(!serialized.includes(String(user.id)), 'no user id appears in an admin response');
  }
  assert.doesNotMatch(serialized, /"(user_?id|journey_?id|email|name|amount|token|session)\w*"/i);

  const noSecret = await request(app).post('/api/internal/cron/clarity-reports').set('Authorization', admin.auth);
  assert.equal(noSecret.status, 401, 'a user token is not a cron credential');
  const wrongSecret = await request(app)
    .post('/api/internal/cron/clarity-reports')
    .set('x-cron-secret', `${CRON_SECRET}-wrong`);
  assert.equal(wrongSecret.status, 401);
  const cron = await cronCall('?dry=1');
  assert.equal(cron.status, 200);
  assertNoSentinels(JSON.stringify(cron.body), 'cron response');
  assert.ok(!/userId|journeyId/i.test(JSON.stringify(cron.body)), 'cron output holds counts and instants only');
});

// ---------------------------------------------------------------------------
// 8. Redaction in stored rows and responses
// ---------------------------------------------------------------------------

test('events, visits, and report rows hold only fixed values and no identity, amount, path, or free text', async () => {
  const { u1 } = users;
  clockAt('2026-02-10T07:00:00.000Z');

  // Hostile payloads carrying every prohibited kind of value are rejected without echo.
  const hostile = [
    { event: 'clarity_response', journeyId: u1.journeyId, response: SENTINEL_FREE_TEXT, occurredAt: '2026-02-10T07:00:00.000Z' },
    { event: 'clarity_response', journeyId: u1.journeyId, response: 'yes', note: SENTINEL_NOTE, occurredAt: '2026-02-10T07:00:00.000Z' },
    { event: 'clarity_response', journeyId: u1.journeyId, response: 'yes', amountMinor: 8_765_432, occurredAt: '2026-02-10T07:00:00.000Z' },
    { event: 'recommended_action_completed', journeyId: u1.journeyId, recommendationInstanceId: users.u1.email,
      actionKey: SENTINEL_PATH, occurredAt: '2026-02-10T07:00:00.000Z' },
    { event: 'financial_change_ui', changeId: 1, causedReload: false, causedPageWideLoading: false,
      email: users.u1.email, occurredAt: '2026-02-10T07:00:00.000Z' },
  ];
  const rejected = [];
  for (const body of hostile) {
    const response = await request(app).post('/api/clarity/events').set('Authorization', u1.auth).send(body);
    assert.equal(response.status, 400);
    rejected.push(response.text);
  }
  assertNoSentinels(rejected.join('\n'), 'event rejection bodies');

  // Visits: a consented user's free-form path is reduced to a fixed route key.
  const track = await request(app).post('/api/track').set('Authorization', u1.auth).send({ path: SENTINEL_PATH });
  assert.equal(track.status, 204);
  const routes = new Set([...modules.visits.PUBLIC_VISIT_ROUTES, ...modules.visits.PRIVATE_VISIT_ROUTES]);
  const visits = await db.prepare('SELECT * FROM visits').all();
  assert.ok(visits.length >= 1);
  for (const visit of visits) assert.ok(routes.has(visit.path), `visit path ${visit.path} is a fixed route key`);
  assert.equal(
    (await db.prepare('SELECT path FROM visits WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(u1.id)).path,
    'other'
  );
  assertNoSentinels(JSON.stringify(visits), 'visit rows');

  // Event rows: exact column set, and every cell is null or an allowed fixed value.
  const { MEASUREMENT_EVENT_NAMES, OUTCOME_KINDS, DESIRED_OUTCOMES, CLARITY_RESPONSES, ACTION_KEYS } = modules.measurement;
  const eventColumns = (await db.prepare('PRAGMA table_info(product_measurement_events)').all()).map((column) => column.name);
  assert.deepEqual(eventColumns.sort(), [
    'action_key', 'caused_page_wide_loading', 'caused_reload', 'change_id', 'consent_version',
    'desired_outcome', 'event_id', 'event_name', 'id', 'journey_id', 'local_date', 'local_week_start',
    'occurred_at', 'outcome_kind', 'received_at', 'recommendation_instance_id', 'response', 'user_id',
  ]);
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  const day = /^\d{4}-\d{2}-\d{2}$/;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const inSet = (values) => (value) => value === null || values.includes(value);
  const rules = {
    event_id: (value) => /^[a-z_]+:\d+:\d+(?::[0-9a-f-]{36})?$/.test(value),
    event_name: inSet(MEASUREMENT_EVENT_NAMES),
    outcome_kind: inSet(OUTCOME_KINDS),
    desired_outcome: inSet(DESIRED_OUTCOMES),
    response: inSet(CLARITY_RESPONSES),
    action_key: inSet(ACTION_KEYS),
    recommendation_instance_id: (value) => value === null || uuid.test(value),
    occurred_at: (value) => iso.test(value),
    received_at: (value) => iso.test(value),
    local_date: (value) => day.test(value),
    local_week_start: (value) => day.test(value),
  };
  const events = await db.prepare('SELECT * FROM product_measurement_events').all();
  assert.equal(events.length, 17, 'seven for U1 + four for U2 + U3/U4/U6, plus the two week-2 change events');
  for (const event of events) {
    for (const [column, valid] of Object.entries(rules)) {
      assert.ok(valid(event[column]), `event.${column}=${event[column]} must be a fixed value`);
    }
    for (const column of ['id', 'user_id', 'journey_id', 'change_id', 'caused_reload', 'caused_page_wide_loading', 'consent_version']) {
      assert.ok(event[column] === null || Number.isSafeInteger(Number(event[column])), `${column} is numeric`);
    }
  }
  assertNoSentinels(JSON.stringify(events), 'event rows');

  // Report rows: exact column set, fixed metric/status vocabularies, no user linkage.
  const reportColumns = (await db.prepare('PRAGMA table_info(success_metric_reports)').all()).map((column) => column.name);
  assert.deepEqual(reportColumns.sort(), [
    'denominator', 'duration_ms', 'generated_at', 'id', 'metric_name', 'numerator', 'percentage_tenths',
    'period_end_exclusive', 'period_start', 'period_type', 'population_definition', 'source_status',
    'target_status', 'time_zone', 'unavailable_end_exclusive', 'unavailable_source', 'unavailable_start',
  ]);
  const definitions = new Set(Object.values(modules.domain.METRIC_DEFINITIONS).map((entry) => entry.populationDefinition));
  const sources = new Set(['guided_journeys', 'product_measurement_events', 'financial_record_changes']);
  const reports = await db.prepare('SELECT * FROM success_metric_reports').all();
  assert.ok(reports.length >= 78);
  for (const row of reports) {
    assert.ok(modules.domain.METRIC_NAMES.includes(row.metric_name));
    assert.ok(definitions.has(row.population_definition), 'population definitions are the fixed catalogue text');
    assert.equal(row.time_zone, 'Asia/Kolkata');
    assert.ok(row.unavailable_source === null || row.unavailable_source.split(',').every((source) => sources.has(source)));
  }
  assertNoSentinels(JSON.stringify(reports), 'report rows');
  assertNoSentinels(JSON.stringify(await db.prepare('SELECT * FROM measurement_source_outages').all()), 'outage rows');
});

// ---------------------------------------------------------------------------
// 9. Retention never outruns reporting
// ---------------------------------------------------------------------------

test('retention waits for every unreported period, then purges only events older than 13 months', async () => {
  const { u1 } = users;
  const weekOneBefore = (await adminReport('weekly', WEEK_1.periodStart)).report;
  // The admin list is capped at 100 periods, so the oldest 28-day period is compared from storage.
  const storedMonth = () => db.prepare(
    'SELECT * FROM success_metric_reports WHERE period_type = ? AND period_start = ? ORDER BY metric_name'
  ).all(FIRST_28_DAY.periodType, FIRST_28_DAY.periodStart);
  const monthBefore = await storedMonth();
  assert.equal(monthBefore.length, 6);

  clockAt('2027-03-01T06:30:00.000Z'); // Mon 12:00 IST; the 13-month cutoff is 2026-01-31T18:30Z.
  // A current event that must survive the purge.
  await sendEvent(u1, '2027-03-01T06:00:00.000Z', journeyEvent(u1, 'recommended_action_completed', {
    recommendationInstanceId: crypto.randomUUID(),
    actionKey: 'review_bills',
  }));
  const eventsBefore = await count('SELECT COUNT(*) AS count FROM product_measurement_events');
  assert.equal(eventsBefore, 18);

  // 55 weeks and 384 daily 28-day periods are pending; at most 60 are generated per run.
  const first = await cronCall();
  assert.equal(first.status, 200);
  assert.equal(first.body.periods.weekly.generated, 55);
  assert.equal(first.body.periods['28_day'].generated, 60);
  assert.equal(first.body.periods['28_day'].hasMore, true);
  assert.equal(first.body.retention.cutoff, '2026-01-31T18:30:00.000Z');
  assert.equal(first.body.retention.skipped, true, 'no purge while periods remain unreported');
  assert.equal(await count('SELECT COUNT(*) AS count FROM product_measurement_events'), eventsBefore);

  let runs = 1;
  let last = first;
  while (last.body.retention.skipped && runs < 10) {
    last = await cronCall();
    runs += 1;
    assert.equal(last.status, 200);
    if (last.body.retention.skipped) {
      assert.equal(await count('SELECT COUNT(*) AS count FROM product_measurement_events'), eventsBefore,
        `run ${runs}: events are intact while a backlog remains`);
    }
  }
  assert.equal(runs, 7, '384 periods at 60 per run need seven runs');
  assert.equal(last.body.periods['28_day'].generated, 24);
  assert.equal(last.body.retention.skipped, false);
  assert.equal(last.body.retention.purgedEvents, 17, 'every January 2026 event is older than the cutoff');
  assert.equal(await count('SELECT COUNT(*) AS count FROM product_measurement_events'), 1);
  const remaining = await db.prepare('SELECT occurred_at FROM product_measurement_events').get();
  assert.equal(remaining.occurred_at, '2027-03-01T06:00:00.000Z');

  // Aggregates outlive the events they were computed from and are not recomputed from missing data.
  assert.deepEqual((await adminReport('weekly', WEEK_1.periodStart)).report, weekOneBefore);
  assert.deepEqual(await storedMonth(), monthBefore);
  assert.equal(await count("SELECT COUNT(*) AS count FROM success_metric_reports WHERE period_type = 'weekly'"), (5 + 55) * 6);
  assert.equal(await count("SELECT COUNT(*) AS count FROM success_metric_reports WHERE period_type = '28_day'"), (8 + 384) * 6);

  const settled = await cronCall();
  assert.equal(settled.body.periods.weekly.generated, 0);
  assert.equal(settled.body.periods['28_day'].generated, 0);
  assert.equal(settled.body.retention.purgedEvents, 0);
});

// ---------------------------------------------------------------------------
// 10. Application logs
// ---------------------------------------------------------------------------

test('logs captured across the whole run, including a generation failure, hold no prohibited values', async () => {
  // Force the generation-failure path with an error message that echoes every kind of sensitive value.
  clockAt('2027-03-02T06:30:00.000Z');
  const leaky = `person ${users.u1.email} ${users.u1.name} 8765432 ${SENTINEL_NOTE} ${SENTINEL_PATH}`;
  const failing = new MeasurementReportService({
    clock: () => new Date(),
    reports: new Proxy(reportRepository, {
      get(target, property) {
        if (property === 'loadCohortJourneys') {
          return async () => { throw new Error(leaky); };
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }),
  });
  const summary = await failing.generateCompletedReports();
  assert.ok(summary.failures.length >= 1);
  for (const failure of summary.failures) {
    assert.deepEqual(Object.keys(failure).sort(), ['code', 'periodType']);
  }
  assertNoSentinels(JSON.stringify(summary), 'failed generation summary');
  assert.ok(
    consoleLines.some((line) => line.includes('"event":"REPORT_GENERATION_FAILED"')),
    'the failure is logged'
  );

  const output = consoleLines.join('\n');
  assertNoSentinels(output, 'application logs');
  assert.ok(!output.includes('8765432'));
  assert.doesNotMatch(output, /Bearer\s+\S+/i);
});

import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createIsolatedTestDatabase } from '../helpers/testDatabase.js';
import { buildSessionFixture, buildUserFixture } from '../helpers/fixtures.js';

const ADMIN_ID = 15_001;
const MEMBER_ID = 15_002;
const SUBJECT_ID = 15_003;
const ADMIN_SESSION_ID = 15_101;
const MEMBER_SESSION_ID = 15_102;
const CRON_SECRET = 'test-cron-secret-0123456789';
const SUBJECT_EMAIL = 'report-subject-15003@example.test';
const METRICS = [
  'first_meaningful_outcome_rate',
  'median_time_to_first_meaningful_outcome',
  'clarity_confirmation_rate',
  'recommended_action_completion_rate',
  'financial_change_reload_rate',
  'financial_change_page_wide_loading_rate',
];

let testDatabase;
let db;
let app;
let reportRepository;
let adminAuthorization;
let memberAuthorization;

function tokenFor(user, session) {
  return `Bearer ${jwt.sign(
    { sub: String(user.id), tv: user.token_version, sid: session.id },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '5m' }
  )}`;
}

async function insertAccount(user, session) {
  await db.prepare(
    `INSERT INTO users (id, email, name, password_hash, is_admin, token_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(user.id, user.email, user.name, user.password_hash, user.is_admin, user.token_version, user.created_at);
  if (!session) return;
  await db.prepare(
    `INSERT INTO sessions (id, user_id, device_label, ip_hash, user_agent, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(session.id, session.user_id, session.device_label, session.ip_hash, session.user_agent,
    session.created_at, session.last_seen_at);
}

function storedRow(overrides = {}) {
  return {
    periodType: 'weekly',
    periodStart: '2026-01-04T18:30:00.000Z',
    periodEndExclusive: '2026-01-11T18:30:00.000Z',
    timeZone: 'Asia/Kolkata',
    metricName: 'first_meaningful_outcome_rate',
    numerator: 1,
    denominator: 2,
    percentageTenths: 500,
    durationMs: null,
    targetStatus: null,
    sourceStatus: 'complete',
    unavailableSource: null,
    unavailableStart: null,
    unavailableEndExclusive: null,
    populationDefinition: 'Test population definition.',
    generatedAt: '2026-02-10T06:30:00.000Z',
    ...overrides,
  };
}

function seedPeriod(overrides = {}, skip = []) {
  return reportRepository.upsertMetricReports(
    METRICS.filter((name) => !skip.includes(name)).map((metricName) => storedRow({ metricName, ...overrides }))
  );
}

function adminGet(path = '/api/admin/clarity-reports') {
  return request(app).get(path).set('Authorization', adminAuthorization);
}

function cron(path = '/api/internal/cron/clarity-reports', secret = CRON_SECRET) {
  const call = request(app).post(path);
  return secret === null ? call : call.set('x-cron-secret', secret);
}

before(async () => {
  testDatabase = await createIsolatedTestDatabase();
  db = testDatabase.db;
  ({ default: reportRepository } = await import('../../src/repositories/measurementReportRepository.js'));
  const { createApp } = await import('../../src/app.js');
  app = createApp();
});

beforeEach(async () => {
  await testDatabase.reset();
  process.env.CRON_SECRET = CRON_SECRET;
  const admin = buildUserFixture({ id: ADMIN_ID, email: 'admin-15001@example.test', is_admin: 1 });
  const adminSession = buildSessionFixture({ id: ADMIN_SESSION_ID, userId: ADMIN_ID });
  const member = buildUserFixture({ id: MEMBER_ID, email: 'member-15002@example.test' });
  const memberSession = buildSessionFixture({ id: MEMBER_SESSION_ID, userId: MEMBER_ID });
  await insertAccount(admin, adminSession);
  await insertAccount(member, memberSession);
  adminAuthorization = tokenFor(admin, adminSession);
  memberAuthorization = tokenFor(member, memberSession);
});

after(async () => {
  await testDatabase?.cleanup();
});

test('admin report reads require authentication and the admin role', async () => {
  await seedPeriod();

  const anonymous = await request(app).get('/api/admin/clarity-reports');
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.body.reports, undefined);

  const invalid = await request(app)
    .get('/api/admin/clarity-reports')
    .set('Authorization', 'Bearer not-a-token');
  assert.equal(invalid.status, 401);

  const member = await request(app)
    .get('/api/admin/clarity-reports')
    .set('Authorization', memberAuthorization);
  assert.equal(member.status, 403);
  assert.equal(member.body.reports, undefined);

  const admin = await adminGet();
  assert.equal(admin.status, 200);
  assert.equal(admin.headers['cache-control'], 'no-store');
});

test('admin report response is aggregate-only with fixed fields', async () => {
  await insertAccount(
    buildUserFixture({ id: SUBJECT_ID, email: SUBJECT_EMAIL, name: 'Subject Person' }),
    null
  );
  await db.prepare(
    `INSERT INTO guided_journeys (user_id, desired_outcome, status, completed_step_keys, measurement_eligible)
     VALUES (?, 'plan_month', 'active', '[]', 1)`
  ).run(SUBJECT_ID);
  await seedPeriod();
  await seedPeriod({
    periodType: '28_day',
    periodStart: '2026-01-05T18:30:00.000Z',
    periodEndExclusive: '2026-02-02T18:30:00.000Z',
  }, ['recommended_action_completion_rate']);
  await seedPeriod({
    periodStart: '2026-01-11T18:30:00.000Z',
    periodEndExclusive: '2026-01-18T18:30:00.000Z',
  }, ['recommended_action_completion_rate']);
  await reportRepository.upsertMetricReports([
    storedRow({
      periodStart: '2026-01-11T18:30:00.000Z',
      periodEndExclusive: '2026-01-18T18:30:00.000Z',
      metricName: 'clarity_confirmation_rate',
      numerator: null,
      denominator: null,
      percentageTenths: null,
      sourceStatus: 'unavailable',
      unavailableSource: 'guided_journeys,product_measurement_events',
      unavailableStart: '2026-01-12T00:00:00.000Z',
      unavailableEndExclusive: '2026-01-13T00:00:00.000Z',
    }),
  ]);

  const response = await adminGet();
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.body).sort(), ['reports', 'timeZone']);
  assert.equal(response.body.timeZone, 'Asia/Kolkata');

  const periodKeys = ['deferredMetrics', 'metrics', 'periodEndExclusive', 'periodStart', 'periodType', 'timeZone'];
  const metricKeys = [
    'denominator', 'durationMs', 'generatedAt', 'metricName', 'numerator', 'percentageDisplay',
    'percentageTenths', 'populationDefinition', 'sourceStatus', 'targetStatus',
    'unavailableEndExclusive', 'unavailableSource', 'unavailableSources', 'unavailableStart',
  ];
  assert.equal(response.body.reports.length, 3);
  for (const report of response.body.reports) {
    assert.deepEqual(Object.keys(report).sort(), periodKeys);
    for (const metric of report.metrics) {
      assert.deepEqual(Object.keys(metric).sort(), metricKeys);
    }
  }

  // Newest period first; deferred and outage states are explicit.
  assert.equal(response.body.reports[0].periodEndExclusive, '2026-02-02T18:30:00.000Z');
  assert.equal(response.body.reports[0].periodType, '28_day');
  assert.deepEqual(response.body.reports[0].deferredMetrics, ['recommended_action_completion_rate']);
  const outageWeek = response.body.reports.find((r) => r.periodStart === '2026-01-11T18:30:00.000Z');
  const clarity = outageWeek.metrics.find((m) => m.metricName === 'clarity_confirmation_rate');
  assert.deepEqual(clarity.unavailableSources, ['guided_journeys', 'product_measurement_events']);
  assert.equal(clarity.targetStatus, null);
  const complete = response.body.reports.find((r) => r.periodStart === '2026-01-04T18:30:00.000Z');
  assert.deepEqual(complete.deferredMetrics, []);
  assert.equal(complete.metrics[0].percentageDisplay, '50.0');

  const serialized = JSON.stringify(response.body);
  for (const forbidden of [SUBJECT_EMAIL, 'Subject Person', 'admin-15001', 'member-15002', String(SUBJECT_ID)]) {
    assert.ok(!serialized.includes(forbidden), `response must not contain ${forbidden}`);
  }
  assert.doesNotMatch(serialized, /"(user_?id|email|name|amount|salary|token)"/i);
});

test('admin report filters and validates its query parameters', async () => {
  await seedPeriod();
  await seedPeriod({
    periodType: '28_day',
    periodStart: '2026-01-05T18:30:00.000Z',
    periodEndExclusive: '2026-02-02T18:30:00.000Z',
  });

  const weekly = await adminGet('/api/admin/clarity-reports?periodType=weekly');
  assert.equal(weekly.status, 200);
  assert.equal(weekly.body.reports.length, 1);
  assert.equal(weekly.body.reports[0].periodType, 'weekly');

  const limited = await adminGet('/api/admin/clarity-reports?limit=1');
  assert.equal(limited.body.reports.length, 1);

  for (const query of ['periodType=monthly', 'limit=0', 'limit=abc', 'limit=101', 'limit=1&limit=2', 'periodType[]=weekly']) {
    const response = await adminGet(`/api/admin/clarity-reports?${query}`);
    assert.equal(response.status, 400, query);
    assert.equal(response.body.reports, undefined, query);
    assert.ok(response.body.error.code, query);
  }
});

test('the cron route rejects missing and wrong secrets and ignores user tokens', async () => {
  const missing = await cron('/api/internal/cron/clarity-reports', null);
  assert.equal(missing.status, 401);
  const wrong = await cron('/api/internal/cron/clarity-reports', 'wrong-secret-0123456789');
  assert.equal(wrong.status, 401);
  const adminToken = await request(app)
    .post('/api/internal/cron/clarity-reports')
    .set('Authorization', adminAuthorization);
  assert.equal(adminToken.status, 401);
  assert.equal(Number((await db.prepare('SELECT COUNT(*) AS count FROM success_metric_reports').get()).count), 0);

  process.env.CRON_SECRET = '';
  const disabled = await cron('/api/internal/cron/clarity-reports', CRON_SECRET);
  assert.equal(disabled.status, 503);
});

test('the cron route generates completed reports once and exposes counts only', async () => {
  await insertAccount(
    buildUserFixture({ id: SUBJECT_ID, email: SUBJECT_EMAIL, name: 'Subject Person' }),
    null
  );
  await db.prepare(
    'INSERT INTO user_financial_state (user_id, analytics_enabled, analytics_consent_version) VALUES (?, 1, 1)'
  ).run(SUBJECT_ID);
  const startedAt = new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 19).replace('T', ' ');
  await db.prepare(
    `INSERT INTO guided_journeys
      (user_id, desired_outcome, status, completed_step_keys, measurement_eligible,
       measurement_consent_version, started_at)
     VALUES (?, 'plan_month', 'active', '[]', 1, 1, ?)`
  ).run(SUBJECT_ID, startedAt);

  const dry = await cron('/api/internal/cron/clarity-reports?dry=1');
  assert.equal(dry.status, 200);
  assert.equal(dry.body.dry, true);
  assert.ok(dry.body.periods.weekly.generated > 0);
  assert.equal(Number((await db.prepare('SELECT COUNT(*) AS count FROM success_metric_reports').get()).count), 0);

  const first = await cron();
  assert.equal(first.status, 200);
  assert.equal(first.body.ok, true);
  assert.deepEqual(first.body.failures, []);
  assert.ok(first.body.periods.weekly.generated >= 5);
  assert.ok(first.body.periods['28_day'].generated >= 12);
  assert.equal(first.body.retention.skipped, false);
  const afterFirst = Number((await db.prepare('SELECT COUNT(*) AS count FROM success_metric_reports').get()).count);
  assert.equal(afterFirst, (first.body.periods.weekly.generated + first.body.periods['28_day'].generated) * 6);
  assert.ok(!JSON.stringify(first.body).includes(SUBJECT_EMAIL));

  const second = await cron();
  assert.equal(second.status, 200);
  assert.equal(second.body.periods.weekly.generated, 0);
  assert.equal(second.body.periods['28_day'].generated, 0);
  assert.equal(Number((await db.prepare('SELECT COUNT(*) AS count FROM success_metric_reports').get()).count), afterFirst);

  const read = await adminGet('/api/admin/clarity-reports?periodType=28_day&limit=1');
  assert.equal(read.status, 200);
  assert.equal(read.body.reports[0].metrics.length, 6);
  const firstOutcome = read.body.reports[0].metrics.find((m) => m.metricName === 'first_meaningful_outcome_rate');
  assert.equal(firstOutcome.targetStatus, 'insufficient_data');
});

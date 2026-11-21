import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { createIsolatedTestDatabase } from '../helpers/testDatabase.js';

// 2026-02-10 12:00 IST (Tuesday). Completed weeks end on Mondays; completed
// 28-day periods end on each local midnight.
const NOW = new Date('2026-02-10T06:30:00.000Z');
const LATER = new Date('2026-02-16T06:30:00.000Z');
const ACTION = 'recommended_action_completion_rate';

let testDatabase;
let db;
let MeasurementReportService;
let eventRetentionCutoff;
let measurementRepository;
let reportRepository;

before(async () => {
  testDatabase = await createIsolatedTestDatabase();
  db = testDatabase.db;
  ({ MeasurementReportService, eventRetentionCutoff } = await import(
    '../../src/services/measurementReportService.js'
  ));
  ({ default: measurementRepository } = await import('../../src/repositories/measurementRepository.js'));
  ({ default: reportRepository } = await import('../../src/repositories/measurementReportRepository.js'));
});

beforeEach(async () => {
  await testDatabase.reset();
});

after(async () => {
  await testDatabase?.cleanup();
});

function service(clockValue = NOW, overrides = {}) {
  let current = clockValue;
  const instance = new MeasurementReportService({ clock: () => current, ...overrides });
  instance.setNow = (value) => { current = value; };
  return instance;
}

async function insertUser(id, { consent = true } = {}) {
  await db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)')
    .run(id, `report-user-${id}@example.test`, `Report User ${id}`, 'test-password-hash');
  if (consent) {
    await db.prepare(
      `INSERT INTO user_financial_state
        (user_id, analytics_enabled, analytics_consent_version) VALUES (?, 1, 1)`
    ).run(id);
  }
}

async function insertJourney(userId, startedAt, eligible = 1) {
  const result = await db.prepare(
    `INSERT INTO guided_journeys
      (user_id, desired_outcome, status, current_step_key, completed_step_keys,
       measurement_eligible, measurement_consent_version, started_at)
     VALUES (?, 'plan_month', 'active', 'salary', '[]', ?, ?, ?)`
  ).run(userId, eligible, eligible ? 1 : null, startedAt);
  return Number(result.lastInsertRowid);
}

async function insertEvent(userId, eventName, occurredAt, fields = {}) {
  const local = new Date(new Date(occurredAt).getTime() + 330 * 60_000).toISOString().slice(0, 10);
  await db.prepare(
    `INSERT INTO product_measurement_events
      (event_id, user_id, event_name, journey_id, response, change_id, caused_reload,
       caused_page_wide_loading, consent_version, occurred_at, received_at,
       local_date, local_week_start)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`
  ).run(
    `${eventName}:${userId}:${occurredAt}:${fields.changeId ?? ''}`,
    userId,
    eventName,
    fields.journeyId ?? null,
    fields.response ?? null,
    fields.changeId ?? null,
    fields.causedReload ?? null,
    fields.causedPageWideLoading ?? null,
    occurredAt,
    occurredAt,
    local,
    local
  );
}

let nextRecordId = 1;
async function insertChange(userId, key) {
  const result = await db.prepare(
    `INSERT INTO financial_record_changes
      (user_id, idempotency_key, request_fingerprint_hmac, operation, record_type,
       record_id, record_version, status, occurred_at)
     VALUES (?, ?, 'test-hmac', 'create', 'salary', ?, 1, 'confirmed', '2026-01-07 00:00:00')`
  ).run(userId, key, nextRecordId++);
  return Number(result.lastInsertRowid);
}

async function countRows(sql = 'SELECT COUNT(*) AS count FROM success_metric_reports') {
  return Number((await db.prepare(sql).get()).count);
}

/**
 * Two measurable new users start on Tue 2026-01-06 (IST). User 1 sees the first
 * outcome after 60 s, answers Yes, and completes an action two days later.
 */
async function seedJanuaryCohort() {
  await insertUser(14_001);
  await insertUser(14_002);
  const first = await insertJourney(14_001, '2026-01-06T05:00:00.000Z');
  await insertJourney(14_002, '2026-01-06T06:00:00.000Z');
  await insertEvent(14_001, 'first_outcome_displayed', '2026-01-06T05:01:00.000Z', { journeyId: first });
  await insertEvent(14_001, 'clarity_response', '2026-01-06T05:02:00.000Z', {
    journeyId: first,
    response: 'yes',
  });
  await insertEvent(14_001, 'recommended_action_completed', '2026-01-08T05:00:00.000Z', {
    journeyId: first,
  });
}

async function reportsFor(periodType) {
  return (await service().listReports({ periodType, limit: 100 })).reports;
}

test('generates every completed weekly and 28-day period once and never an open one', async () => {
  await seedJanuaryCohort();
  const summary = await service().generateCompletedReports();

  assert.deepEqual(summary.failures, []);
  assert.equal(summary.periods.weekly.generated, 5);
  assert.equal(summary.periods['28_day'].generated, 8);
  assert.equal(await countRows(), (5 + 8) * 6);

  const latest = await countRows(
    `SELECT COUNT(*) AS count FROM success_metric_reports WHERE period_end_exclusive > '${NOW.toISOString()}'`
  );
  assert.equal(latest, 0, 'no period may end after the generation instant');

  const weekly = await reportsFor('weekly');
  assert.equal(weekly[0].periodEndExclusive, '2026-02-08T18:30:00.000Z');
  assert.equal(weekly.at(-1).periodStart, '2026-01-04T18:30:00.000Z');
  assert.equal((await measurementRepository.getReportCheckpoint('weekly')).record.lastPeriodEndExclusive,
    '2026-02-08T18:30:00.000Z');
  assert.equal((await measurementRepository.getReportCheckpoint('28_day')).record.lastPeriodEndExclusive,
    '2026-02-09T18:30:00.000Z');
});

test('persists numerator, denominator, duration, status, and metadata per metric', async () => {
  await seedJanuaryCohort();
  await service().generateCompletedReports();

  const firstWeek = (await reportsFor('weekly')).at(-1);
  const byName = Object.fromEntries(firstWeek.metrics.map((metric) => [metric.metricName, metric]));
  assert.equal(firstWeek.timeZone, 'Asia/Kolkata');
  assert.deepEqual(firstWeek.deferredMetrics, []);
  assert.deepEqual(
    [byName.first_meaningful_outcome_rate.numerator, byName.first_meaningful_outcome_rate.denominator],
    [1, 2]
  );
  assert.equal(byName.first_meaningful_outcome_rate.percentageDisplay, '50.0');
  assert.equal(byName.median_time_to_first_meaningful_outcome.durationMs, 60_000);
  assert.equal(byName.clarity_confirmation_rate.percentageTenths, 1000);
  assert.equal(byName[ACTION].numerator, 1);
  assert.equal(byName.financial_change_reload_rate.denominator, 0);
  assert.equal(byName.financial_change_reload_rate.percentageTenths, null);
  for (const metric of firstWeek.metrics) {
    assert.equal(metric.sourceStatus, 'complete');
    assert.ok(metric.populationDefinition.length > 0);
    assert.match(metric.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  }
});

test('re-running is idempotent and the checkpoint never regresses', async () => {
  await seedJanuaryCohort();
  const generator = service();
  await generator.generateCompletedReports();
  const before = await countRows();
  const checkpoint = (await measurementRepository.getReportCheckpoint('28_day')).record;

  const second = await generator.generateCompletedReports();
  assert.equal(second.periods.weekly.generated, 0);
  assert.equal(second.periods['28_day'].generated, 0);
  assert.equal(await countRows(), before);

  // An advance to an earlier boundary is ignored (monotonic).
  const regressed = await measurementRepository.advanceReportCheckpoint({
    periodType: '28_day',
    periodEndExclusive: '2026-02-01T18:30:00.000Z',
  });
  assert.equal(regressed.lastPeriodEndExclusive, checkpoint.lastPeriodEndExclusive);

  // Replaying stored rows through the upsert path updates them in place.
  await db.prepare('DELETE FROM measurement_report_checkpoints').run();
  const replay = await generator.generateCompletedReports();
  assert.equal(replay.periods.weekly.generated, 5);
  assert.equal(await countRows(), before, 'replaying a period updates rows instead of duplicating');
});

test('backfills only newly completed periods after the checkpoint', async () => {
  await seedJanuaryCohort();
  const generator = service();
  await generator.generateCompletedReports();
  generator.setNow(LATER);
  const next = await generator.generateCompletedReports();
  assert.equal(next.periods.weekly.generated, 1);
  assert.equal(next.periods['28_day'].generated, 6);
});

test('defers the action metric while seven-day windows are open, then finalizes it', async () => {
  await insertUser(14_010);
  const journeyId = await insertJourney(14_010, '2026-02-02T05:00:00.000Z');
  await insertEvent(14_010, 'first_outcome_displayed', '2026-02-08T05:00:00.000Z', { journeyId });
  await insertEvent(14_010, 'recommended_action_completed', '2026-02-09T05:00:00.000Z', { journeyId });

  const generator = service();
  const first = await generator.generateCompletedReports();
  assert.equal(first.periods.weekly.generated, 1);
  assert.equal(first.actionMetric.deferred, 1);
  let week = (await reportsFor('weekly'))[0];
  assert.deepEqual(week.deferredMetrics, [ACTION]);
  assert.equal(week.metrics.length, 5);

  // Window runs to 2026-02-15 12:30 IST; still open on the next day.
  generator.setNow(new Date('2026-02-11T06:30:00.000Z'));
  const stillOpen = await generator.generateCompletedReports();
  assert.equal(stillOpen.actionMetric.finalized, 0);
  assert.equal(stillOpen.actionMetric.pending, 1);

  generator.setNow(LATER);
  const closed = await generator.generateCompletedReports();
  assert.equal(closed.actionMetric.finalized, 1);
  week = (await reportsFor('weekly')).find((period) => period.periodStart === '2026-02-01T18:30:00.000Z');
  assert.deepEqual(week.deferredMetrics, []);
  const action = week.metrics.find((metric) => metric.metricName === ACTION);
  assert.deepEqual([action.numerator, action.denominator], [1, 1]);

  const again = await generator.generateCompletedReports();
  assert.equal(again.actionMetric.finalized, 0);
});

test('a source outage makes only the affected metrics unavailable', async () => {
  await seedJanuaryCohort();
  await measurementRepository.recordSourceOutage({
    sourceName: 'guided_journeys',
    unavailableStart: '2026-01-20T00:00:00.000Z',
    unavailableEndExclusive: '2026-01-21T00:00:00.000Z',
  });
  await service().generateCompletedReports();

  const week = (await reportsFor('weekly')).find((period) => period.periodStart === '2026-01-18T18:30:00.000Z');
  const byName = Object.fromEntries(week.metrics.map((metric) => [metric.metricName, metric]));
  for (const name of [
    'first_meaningful_outcome_rate',
    'median_time_to_first_meaningful_outcome',
    'clarity_confirmation_rate',
    ACTION,
  ]) {
    assert.equal(byName[name].sourceStatus, 'unavailable', name);
    assert.equal(byName[name].unavailableSource, 'guided_journeys');
    assert.deepEqual(byName[name].unavailableSources, ['guided_journeys']);
    assert.equal(byName[name].unavailableStart, '2026-01-20T00:00:00.000Z');
    assert.equal(byName[name].unavailableEndExclusive, '2026-01-21T00:00:00.000Z');
    assert.equal(byName[name].targetStatus, null);
    assert.equal(byName[name].numerator, null);
  }
  for (const name of ['financial_change_reload_rate', 'financial_change_page_wide_loading_rate']) {
    assert.equal(byName[name].sourceStatus, 'complete', name);
  }
  const firstWeek = (await reportsFor('weekly')).at(-1);
  assert.ok(firstWeek.metrics.every((metric) => metric.sourceStatus === 'complete'));
});

test('financial change metrics count only changes reported inside the period', async () => {
  await insertUser(14_020);
  const inside = await insertChange(14_020, 'inside');
  const outside = await insertChange(14_020, 'outside');
  await insertEvent(14_020, 'financial_change_ui', '2026-01-07T05:00:00.000Z', {
    changeId: inside,
    causedReload: 1,
    causedPageWideLoading: 0,
  });
  await insertEvent(14_020, 'financial_change_ui', '2026-01-14T05:00:00.000Z', {
    changeId: outside,
    causedReload: 0,
    causedPageWideLoading: 0,
  });
  await service().generateCompletedReports();

  const reports = await reportsFor('weekly');
  const week = (index) => Object.fromEntries(
    reports.at(index).metrics.map((metric) => [metric.metricName, metric])
  );
  assert.deepEqual(
    [week(-1).financial_change_reload_rate.numerator, week(-1).financial_change_reload_rate.denominator],
    [1, 1]
  );
  assert.equal(week(-1).financial_change_reload_rate.targetStatus, 'not_met');
  assert.equal(week(-1).financial_change_page_wide_loading_rate.targetStatus, 'met');
  assert.deepEqual(
    [week(-2).financial_change_reload_rate.numerator, week(-2).financial_change_reload_rate.denominator],
    [0, 1]
  );
});

test('retention purges events older than 13 months and keeps newer events and reports', async () => {
  assert.equal(eventRetentionCutoff(NOW), '2025-01-09T18:30:00.000Z');
  assert.equal(eventRetentionCutoff(new Date('2026-03-31T06:30:00.000Z')), '2025-02-27T18:30:00.000Z');

  await seedJanuaryCohort();
  const generator = service();
  await generator.generateCompletedReports();
  await insertEvent(14_001, 'clarity_response', '2024-12-01T00:00:00.000Z', { response: 'no' });
  await insertEvent(14_001, 'clarity_response', '2025-01-09T18:29:59.000Z', { response: 'no' });
  await insertEvent(14_001, 'clarity_response', '2025-01-09T18:30:00.000Z', { response: 'no' });
  const reportCount = await countRows();
  const eventCount = await countRows('SELECT COUNT(*) AS count FROM product_measurement_events');

  const dry = await generator.generateCompletedReports({ dry: true });
  assert.equal(dry.retention.skipped, true);
  assert.equal(await countRows('SELECT COUNT(*) AS count FROM product_measurement_events'), eventCount);

  const run = await generator.generateCompletedReports();
  assert.equal(run.retention.skipped, false);
  assert.equal(run.retention.cutoff, '2025-01-09T18:30:00.000Z');
  assert.equal(run.retention.purgedEvents, 2);
  assert.equal(await countRows('SELECT COUNT(*) AS count FROM product_measurement_events'), eventCount - 2);
  assert.equal(await countRows(), reportCount, 'aggregate reports are not purged');
});

test('retention is skipped while a backlog or a failure leaves periods ungenerated', async () => {
  await seedJanuaryCohort();
  await insertEvent(14_001, 'clarity_response', '2024-12-01T00:00:00.000Z', { response: 'no' });
  const limited = service(NOW, { maxPeriodsPerRun: 2 });
  const first = await limited.generateCompletedReports();
  assert.equal(first.periods.weekly.hasMore, true);
  assert.equal(first.retention.skipped, true);
  assert.equal(first.periods.weekly.generated, 2);
  assert.equal(await countRows('SELECT COUNT(*) AS count FROM product_measurement_events'), 4);

  const failing = new MeasurementReportService({
    clock: () => NOW,
    reports: new Proxy(reportRepository, {
      get(target, property) {
        if (property === 'loadCohortJourneys') {
          return async () => { throw new Error('forced failure'); };
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }),
  });
  const originalError = console.error;
  console.error = () => {};
  let failed;
  try {
    failed = await failing.generateCompletedReports();
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(failed.failures.map((failure) => failure.code), [
    'REPORT_GENERATION_FAILED',
    'REPORT_GENERATION_FAILED',
  ]);
  assert.equal(failed.retention.skipped, true);
  assert.equal(await countRows('SELECT COUNT(*) AS count FROM product_measurement_events'), 4);
});

test('first run never backfills periods that start before the retention cutoff', async () => {
  await insertUser(14_030);
  await insertEvent(14_030, 'clarity_response', '2023-01-01T00:00:00.000Z', { response: 'no' });
  const summary = await service(NOW, { maxPeriodsPerRun: 1000 }).generateCompletedReports({ dry: true });
  assert.ok(summary.periods.weekly.generated <= 58);
  assert.ok(summary.periods['28_day'].generated <= 400);
});

test('a dry run reports work without writing rows or checkpoints', async () => {
  await seedJanuaryCohort();
  const dry = await service().generateCompletedReports({ dry: true });
  assert.equal(dry.dry, true);
  assert.equal(dry.periods.weekly.generated, 5);
  assert.equal(await countRows(), 0);
  assert.equal(await countRows('SELECT COUNT(*) AS count FROM measurement_report_checkpoints'), 0);
});

test('with no source data nothing is generated and no checkpoint is written', async () => {
  const summary = await service().generateCompletedReports();
  assert.equal(summary.periods.weekly.generated, 0);
  assert.equal(summary.periods['28_day'].generated, 0);
  assert.equal(await countRows('SELECT COUNT(*) AS count FROM measurement_report_checkpoints'), 0);
});

test('reads are aggregate-only and validate their inputs', async () => {
  await seedJanuaryCohort();
  await service().generateCompletedReports();
  const result = await service().listReports({ limit: 3 });

  assert.deepEqual(Object.keys(result).sort(), ['reports', 'timeZone']);
  const periodKeys = new Set(['periodType', 'periodStart', 'periodEndExclusive', 'timeZone', 'metrics', 'deferredMetrics']);
  const metricKeys = new Set([
    'metricName', 'numerator', 'denominator', 'percentageTenths', 'percentageDisplay',
    'durationMs', 'targetStatus', 'sourceStatus', 'unavailableSource', 'unavailableSources',
    'unavailableStart', 'unavailableEndExclusive', 'populationDefinition', 'generatedAt',
  ]);
  assert.equal(result.reports.length, 3);
  for (const report of result.reports) {
    assert.deepEqual(Object.keys(report).filter((key) => !periodKeys.has(key)), []);
    for (const metric of report.metrics) {
      assert.deepEqual(Object.keys(metric).filter((key) => !metricKeys.has(key)), []);
    }
  }
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /report-user|example\.test|user_?id|email/i);

  assert.equal((await service().listReports({ periodType: 'weekly', limit: 100 }))
    .reports.every((report) => report.periodType === 'weekly'), true);
  await assert.rejects(() => service().listReports({ periodType: 'monthly' }), { code: 'INVALID_PERIOD_TYPE' });
  await assert.rejects(() => service().listReports({ limit: 0 }), { code: 'INVALID_LIMIT' });
  await assert.rejects(() => service().listReports({ limit: 101 }), { code: 'INVALID_LIMIT' });
});

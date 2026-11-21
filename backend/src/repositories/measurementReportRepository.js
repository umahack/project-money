import db from '../db/index.js';
import {
  assertIsoInstant,
  assertPositiveId,
  confirmedCollection,
  requireDatabase,
  toSafeInteger,
} from './repositorySupport.js';

/**
 * Report-generation reads and aggregate report storage (Requirement 13).
 *
 * The user-level readers here (`loadCohortJourneys`, `loadConsentSnapshots`,
 * `loadReportEvents`) exist only for the in-process report service, which feeds
 * them to the pure calculator and persists aggregates. No route handler imports
 * this module. The only readers a route may reach are `listMetricReports`
 * (aggregate rows with no user column) through the report service.
 */

export const REPORT_METRIC_PERIOD_TYPES = Object.freeze(['weekly', '28_day']);
const PERIOD_TYPE_SET = new Set(REPORT_METRIC_PERIOD_TYPES);

const CHUNK_SIZE = 400;
const MAX_LIST_LIMIT = 200;

// Normalizes both SQLite `YYYY-MM-DD HH:MM:SS` and ISO values to the ISO form
// used by every other measurement timestamp so range comparisons are textual.
const NORMALIZED_STARTED_AT = "strftime('%Y-%m-%dT%H:%M:%fZ', started_at)";

const REPORT_EVENT_NAMES = Object.freeze({
  firstOutcome: 'first_outcome_displayed',
  clarityResponse: 'clarity_response',
  actionCompleted: 'recommended_action_completed',
  financialChange: 'financial_change_ui',
});

function assertPeriodType(periodType) {
  if (!PERIOD_TYPE_SET.has(periodType)) {
    throw new TypeError('periodType must be weekly or 28_day.');
  }
  return periodType;
}

function chunk(values, size = CHUNK_SIZE) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function nullableInteger(value, label) {
  return value == null ? null : toSafeInteger(value, label);
}

function mapReportRow(row) {
  return {
    periodType: row.period_type,
    periodStart: row.period_start,
    periodEndExclusive: row.period_end_exclusive,
    timeZone: row.time_zone,
    metricName: row.metric_name,
    numerator: nullableInteger(row.numerator, 'report numerator'),
    denominator: nullableInteger(row.denominator, 'report denominator'),
    percentageTenths: nullableInteger(row.percentage_tenths, 'report percentage'),
    durationMs: nullableInteger(row.duration_ms, 'report duration'),
    targetStatus: row.target_status ?? null,
    sourceStatus: row.source_status,
    unavailableSource: row.unavailable_source ?? null,
    unavailableStart: row.unavailable_start ?? null,
    unavailableEndExclusive: row.unavailable_end_exclusive ?? null,
    populationDefinition: row.population_definition,
    generatedAt: row.generated_at,
  };
}

const UPSERT_REPORT_SQL = `INSERT INTO success_metric_reports
  (period_type, period_start, period_end_exclusive, time_zone, metric_name,
   numerator, denominator, percentage_tenths, duration_ms, target_status,
   source_status, unavailable_source, unavailable_start, unavailable_end_exclusive,
   population_definition, generated_at)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
 ON CONFLICT(period_type, period_start, period_end_exclusive, metric_name) DO UPDATE SET
   time_zone = excluded.time_zone,
   numerator = excluded.numerator,
   denominator = excluded.denominator,
   percentage_tenths = excluded.percentage_tenths,
   duration_ms = excluded.duration_ms,
   target_status = excluded.target_status,
   source_status = excluded.source_status,
   unavailable_source = excluded.unavailable_source,
   unavailable_start = excluded.unavailable_start,
   unavailable_end_exclusive = excluded.unavailable_end_exclusive,
   population_definition = excluded.population_definition,
   generated_at = excluded.generated_at`;

function reportArgs(row) {
  assertPeriodType(row.periodType);
  assertIsoInstant(row.periodStart, 'periodStart');
  assertIsoInstant(row.periodEndExclusive, 'periodEndExclusive');
  assertIsoInstant(row.generatedAt, 'generatedAt');
  return [
    row.periodType,
    row.periodStart,
    row.periodEndExclusive,
    row.timeZone,
    row.metricName,
    row.numerator ?? null,
    row.denominator ?? null,
    row.percentageTenths ?? null,
    row.durationMs ?? null,
    row.targetStatus ?? null,
    row.sourceStatus,
    row.unavailableSource ?? null,
    row.unavailableStart ?? null,
    row.unavailableEndExclusive ?? null,
    row.populationDefinition,
    row.generatedAt,
  ];
}

export class MeasurementReportRepository {
  #database;

  constructor(database) {
    this.#database = requireDatabase(database);
  }

  /** Earliest journey start or product event instant, as an ISO instant, or null. */
  async getEarliestSourceInstant() {
    const row = await this.#database.prepare(
      `SELECT MIN(instant) AS earliest FROM (
         SELECT MIN(${NORMALIZED_STARTED_AT}) AS instant FROM guided_journeys
         UNION ALL
         SELECT MIN(occurred_at) AS instant FROM product_measurement_events
       )`
    ).get();
    return row?.earliest ?? null;
  }

  /**
   * Every journey (eligible or not) of each user whose earliest journey start
   * falls in the period, so earlier ineligible journeys keep a returning user
   * out of the new-user cohort.
   */
  async loadCohortJourneys({ startInclusive, endExclusive }) {
    assertIsoInstant(startInclusive, 'startInclusive');
    assertIsoInstant(endExclusive, 'endExclusive');
    const rows = await this.#database.prepare(
      `SELECT id, user_id, ${NORMALIZED_STARTED_AT} AS started_at, measurement_eligible
         FROM guided_journeys
        WHERE user_id IN (
          SELECT user_id FROM guided_journeys
           GROUP BY user_id
          HAVING MIN(${NORMALIZED_STARTED_AT}) >= ?
             AND MIN(${NORMALIZED_STARTED_AT}) < ?
        )
        ORDER BY user_id, id`
    ).all(startInclusive, endExclusive);
    return confirmedCollection(rows.map((row) => ({
      id: toSafeInteger(row.id, 'journey id'),
      userId: toSafeInteger(row.user_id, 'journey user id'),
      startedAt: row.started_at,
      measurementEligible: Number(row.measurement_eligible) === 1,
    })));
  }

  /** Current analytics state for users that have a state row. */
  async loadConsentSnapshots(userIds) {
    if (!Array.isArray(userIds)) throw new TypeError('userIds must be an array.');
    userIds.forEach((userId) => assertPositiveId(userId, 'userId'));
    const records = [];
    for (const ids of chunk([...new Set(userIds)])) {
      const placeholders = ids.map(() => '?').join(', ');
      const rows = await this.#database.prepare(
        `SELECT user_id, analytics_enabled, analytics_changed_at
           FROM user_financial_state
          WHERE user_id IN (${placeholders})`
      ).all(...ids);
      for (const row of rows) {
        records.push({
          userId: toSafeInteger(row.user_id, 'consent user id'),
          analyticsEnabled: Number(row.analytics_enabled) === 1,
          analyticsChangedAt: row.analytics_changed_at ?? null,
        });
      }
    }
    return confirmedCollection(records);
  }

  /**
   * Events needed to calculate one period: cohort-user journey events from the
   * period start onward, plus every financial-change event inside the period.
   */
  async loadReportEvents({ userIds, startInclusive, endExclusive }) {
    if (!Array.isArray(userIds)) throw new TypeError('userIds must be an array.');
    userIds.forEach((userId) => assertPositiveId(userId, 'userId'));
    assertIsoInstant(startInclusive, 'startInclusive');
    assertIsoInstant(endExclusive, 'endExclusive');

    const columns = `id, user_id, event_name, journey_id, response, change_id,
                     caused_reload, caused_page_wide_loading, occurred_at`;
    const records = [];
    const push = (row) => records.push({
      id: toSafeInteger(row.id, 'event id'),
      userId: toSafeInteger(row.user_id, 'event user id'),
      eventName: row.event_name,
      journeyId: nullableInteger(row.journey_id, 'event journey id'),
      response: row.response ?? null,
      changeId: nullableInteger(row.change_id, 'event change id'),
      causedReload: row.caused_reload == null ? null : Number(row.caused_reload) === 1,
      causedPageWideLoading: row.caused_page_wide_loading == null
        ? null
        : Number(row.caused_page_wide_loading) === 1,
      occurredAt: row.occurred_at,
    });

    for (const ids of chunk([...new Set(userIds)])) {
      const placeholders = ids.map(() => '?').join(', ');
      const rows = await this.#database.prepare(
        `SELECT ${columns}
           FROM product_measurement_events
          WHERE user_id IN (${placeholders})
            AND event_name IN (?, ?, ?)
            AND occurred_at >= ?
          ORDER BY occurred_at, id`
      ).all(
        ...ids,
        REPORT_EVENT_NAMES.firstOutcome,
        REPORT_EVENT_NAMES.clarityResponse,
        REPORT_EVENT_NAMES.actionCompleted,
        startInclusive
      );
      rows.forEach(push);
    }

    const changeRows = await this.#database.prepare(
      `SELECT ${columns}
         FROM product_measurement_events
        WHERE event_name = ?
          AND occurred_at >= ?
          AND occurred_at < ?
        ORDER BY occurred_at, id`
    ).all(REPORT_EVENT_NAMES.financialChange, startInclusive, endExclusive);
    changeRows.forEach(push);

    return confirmedCollection(records);
  }

  /**
   * Insert or update aggregate rows by their unique period/metric key, in one
   * atomic batch when the adapter supports it. Re-running a period therefore
   * updates the same rows and cannot duplicate them.
   */
  async upsertMetricReports(rows) {
    if (!Array.isArray(rows)) throw new TypeError('rows must be an array.');
    if (rows.length === 0) return 0;
    const statements = rows.map((row) => ({ sql: UPSERT_REPORT_SQL, args: reportArgs(row) }));
    if (typeof this.#database.batch === 'function') {
      await this.#database.batch(statements, 'write');
    } else {
      for (const statement of statements) {
        await this.#database.prepare(statement.sql).run(...statement.args);
      }
    }
    return rows.length;
  }

  /**
   * Periods that have at least one stored metric row but no row for
   * `metricName` (a metric deferred until its inputs are final).
   */
  async listPeriodsMissingMetric({ periodType, metricName, limit = 100 }) {
    assertPeriodType(periodType);
    if (typeof metricName !== 'string' || metricName.length === 0) {
      throw new TypeError('metricName must be a non-empty string.');
    }
    assertPositiveId(limit, 'limit');
    const rows = await this.#database.prepare(
      `SELECT DISTINCT r.period_start, r.period_end_exclusive
         FROM success_metric_reports r
        WHERE r.period_type = ?
          AND NOT EXISTS (
            SELECT 1 FROM success_metric_reports m
             WHERE m.period_type = r.period_type
               AND m.period_start = r.period_start
               AND m.period_end_exclusive = r.period_end_exclusive
               AND m.metric_name = ?
          )
        ORDER BY r.period_start
        LIMIT ?`
    ).all(periodType, metricName, limit);
    return confirmedCollection(rows.map((row) => ({
      periodStart: row.period_start,
      periodEndExclusive: row.period_end_exclusive,
    })));
  }

  /**
   * Aggregate rows for the most recent `limit` periods, newest first. The
   * table has no user or financial-value columns; this is the only read an
   * admin route reaches.
   */
  async listMetricReports({ periodType = null, limit = 20 } = {}) {
    if (periodType != null) assertPeriodType(periodType);
    assertPositiveId(limit, 'limit');
    if (limit > MAX_LIST_LIMIT) throw new RangeError(`limit must not exceed ${MAX_LIST_LIMIT}.`);

    const rows = await this.#database.prepare(
      `SELECT period_type, period_start, period_end_exclusive, time_zone, metric_name,
              numerator, denominator, percentage_tenths, duration_ms, target_status,
              source_status, unavailable_source, unavailable_start,
              unavailable_end_exclusive, population_definition, generated_at
         FROM success_metric_reports
        WHERE (period_type, period_start, period_end_exclusive) IN (
          SELECT period_type, period_start, period_end_exclusive
            FROM success_metric_reports
           WHERE (? IS NULL OR period_type = ?)
           GROUP BY period_type, period_start, period_end_exclusive
           ORDER BY period_end_exclusive DESC, period_type
           LIMIT ?
        )
        ORDER BY period_end_exclusive DESC, period_type, metric_name`
    ).all(periodType, periodType, limit);
    return confirmedCollection(rows.map(mapReportRow));
  }

  /** Delete user-level measurement events that occurred before the cutoff. */
  async purgeEventsBefore(cutoffInstant) {
    assertIsoInstant(cutoffInstant, 'cutoffInstant');
    const result = await this.#database.prepare(
      'DELETE FROM product_measurement_events WHERE occurred_at < ?'
    ).run(cutoffInstant);
    return toSafeInteger(result.changes ?? 0, 'purged event count');
  }
}

const measurementReportRepository = new MeasurementReportRepository(db);
export default measurementReportRepository;

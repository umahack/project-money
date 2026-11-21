import {
  MEASUREMENT_TIME_ZONE,
  METRIC_NAMES,
  REPORT_PERIOD_TYPES,
  calculateMetricReport,
  createPeriod,
  listCompletedPeriods,
  toEpochMs,
  toIsoInstant,
  toLocalDate,
} from '../domain/measurement.js';
import {
  operationalLogger,
  safeErrorCode,
  safeErrorName,
} from '../observability/operationalLog.js';
import measurementReportRepository from '../repositories/measurementReportRepository.js';
import measurementRepository from '../repositories/measurementRepository.js';

/**
 * Completed-period report generation, retention, and aggregate reads
 * (Requirement 13, tasks 16.6).
 *
 * Decisions
 * - Completed periods only. Weekly periods are consecutive Monday weeks and
 *   28-day periods are rolling (one per completed local date). A period is
 *   materialized only when its local end has passed (`listCompletedPeriods`).
 * - Idempotent and monotonic. Rows are upserted by the unique
 *   (period type, start, end, metric) key and the per-type checkpoint only
 *   moves forward after a period's rows are stored, so a crash or a repeated
 *   run neither duplicates nor skips a period.
 * - Open seven-day action windows: the recommended-action completion metric is
 *   DEFERRED until every cohort user's window has closed. Requirement 13.14 and
 *   13.15 define the metric over the full seven-day window, and the stored row
 *   has no column to mark a value as provisional, so writing an early value
 *   would persist an understated rate that looks final. The other five metrics
 *   are written at period completion (Requirement 13.32). Each later run
 *   finishes any period that has stored rows but no action row; until then the
 *   admin read lists the metric under `deferredMetrics`.
 * - Retention. Product events older than 13 local calendar months are deleted
 *   after generation. Purging is skipped when generation failed or a backlog
 *   remains, so no unreported period loses its source events. First-run
 *   backfill starts no earlier than the retention cutoff for the same reason.
 *   Aggregate report rows hold no user data and are not purged.
 * - Aggregate-only reads. `listReports` copies an explicit allowlist of
 *   aggregate fields; the report table has no user or financial-value column.
 */

export const EVENT_RETENTION_MONTHS = 13;
export const DEFAULT_MAX_PERIODS_PER_RUN = 60;
export const DEFAULT_LIST_LIMIT = 20;
export const MAX_LIST_LIMIT = 100;
export const DEFERRED_ACTION_METRIC = 'recommended_action_completion_rate';

const UNBOUNDED_PERIODS = 5000;

/** Local midnight (ISO instant) of the date `months` calendar months before today. */
export function eventRetentionCutoff(now, months = EVENT_RETENTION_MONTHS) {
  const [year, month, day] = toLocalDate(now).split('-').map(Number);
  const monthIndex = year * 12 + (month - 1) - months;
  const targetYear = Math.floor(monthIndex / 12);
  const targetMonth = monthIndex - targetYear * 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const date = [
    String(targetYear).padStart(4, '0'),
    String(targetMonth + 1).padStart(2, '0'),
    String(Math.min(day, lastDay)).padStart(2, '0'),
  ].join('-');
  return createPeriod('28_day', date).start;
}

function toStorageRow(row) {
  return {
    periodType: row.periodType,
    periodStart: row.periodStart,
    periodEndExclusive: row.periodEndExclusive,
    timeZone: row.timeZone,
    metricName: row.metricName,
    numerator: row.numerator,
    denominator: row.denominator,
    percentageTenths: row.percentageTenths,
    durationMs: row.durationMs,
    targetStatus: row.targetStatus,
    sourceStatus: row.sourceStatus,
    unavailableSource: row.unavailableSource,
    unavailableStart: row.unavailableStart,
    unavailableEndExclusive: row.unavailableEndExclusive,
    populationDefinition: row.populationDefinition,
    generatedAt: row.generatedAt,
  };
}

const isDeferredAction = (row) => row.metricName === DEFERRED_ACTION_METRIC
  && (row.population?.openActionWindows ?? 0) > 0;

function percentageDisplay(tenths) {
  return tenths == null ? null : `${Math.floor(tenths / 10)}.${tenths % 10}`;
}

/** Explicit allowlist: nothing outside these fields can reach an admin response. */
function serializeMetric(row) {
  return {
    metricName: row.metricName,
    numerator: row.numerator,
    denominator: row.denominator,
    percentageTenths: row.percentageTenths,
    percentageDisplay: percentageDisplay(row.percentageTenths),
    durationMs: row.durationMs,
    targetStatus: row.targetStatus,
    sourceStatus: row.sourceStatus,
    unavailableSource: row.unavailableSource,
    unavailableSources: row.unavailableSource ? row.unavailableSource.split(',') : [],
    unavailableStart: row.unavailableStart,
    unavailableEndExclusive: row.unavailableEndExclusive,
    populationDefinition: row.populationDefinition,
    generatedAt: row.generatedAt,
  };
}

export class MeasurementReportError extends Error {
  constructor({ code, message, httpStatus = 400 }) {
    super(message);
    this.name = 'MeasurementReportError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export class MeasurementReportService {
  #reports;
  #measurement;
  #clock;
  #maxPeriodsPerRun;

  constructor({
    reports = measurementReportRepository,
    measurement = measurementRepository,
    clock = () => new Date(),
    maxPeriodsPerRun = DEFAULT_MAX_PERIODS_PER_RUN,
  } = {}) {
    if (!reports || typeof reports.upsertMetricReports !== 'function') {
      throw new TypeError('A measurement report repository is required.');
    }
    if (!measurement || typeof measurement.getReportCheckpoint !== 'function') {
      throw new TypeError('A measurement repository with checkpoints is required.');
    }
    if (typeof clock !== 'function') throw new TypeError('clock must be a function.');
    if (!Number.isSafeInteger(maxPeriodsPerRun) || maxPeriodsPerRun <= 0) {
      throw new TypeError('maxPeriodsPerRun must be a positive safe integer.');
    }
    this.#reports = reports;
    this.#measurement = measurement;
    this.#clock = clock;
    this.#maxPeriodsPerRun = maxPeriodsPerRun;
  }

  async #calculate(period, now) {
    const generatedAt = toIsoInstant(now.getTime());
    const { records: journeys } = await this.#reports.loadCohortJourneys({
      startInclusive: period.start,
      endExclusive: period.endExclusive,
    });
    const userIds = [...new Set(journeys.map((journey) => journey.userId))];
    const { records: consents } = userIds.length === 0
      ? { records: [] }
      : await this.#reports.loadConsentSnapshots(userIds);
    const { records: events } = await this.#reports.loadReportEvents({
      userIds,
      startInclusive: period.start,
      endExclusive: period.endExclusive,
    });
    const { records: outages } = await this.#measurement.loadSourceOutages({
      startInclusive: period.start,
      endExclusive: generatedAt,
    });
    return calculateMetricReport({ period, generatedAt, journeys, events, consents, outages });
  }

  async #pendingPeriods(periodType, now, cutoff) {
    const checkpoint = (await this.#measurement.getReportCheckpoint(periodType)).record;
    let periods;
    if (checkpoint) {
      periods = listCompletedPeriods({
        periodType,
        now,
        checkpointEndExclusive: checkpoint.lastPeriodEndExclusive,
        maxPeriods: UNBOUNDED_PERIODS,
      });
    } else {
      const earliest = await this.#reports.getEarliestSourceInstant();
      if (earliest == null) return [];
      const seed = toEpochMs(earliest) < toEpochMs(cutoff) ? cutoff : earliest;
      periods = listCompletedPeriods({
        periodType,
        now,
        earliestInstant: seed,
        maxPeriods: UNBOUNDED_PERIODS,
      });
    }
    return periods;
  }

  async #generateType(periodType, now, cutoff, dry, summary) {
    const periods = await this.#pendingPeriods(periodType, now, cutoff);
    const selected = periods.slice(0, this.#maxPeriodsPerRun);
    const counters = summary.periods[periodType];
    counters.hasMore = periods.length > selected.length;
    if (dry) {
      counters.generated = selected.length;
      return;
    }
    for (const period of selected) {
      const rows = await this.#calculate(period, now);
      const deferred = rows.filter(isDeferredAction);
      await this.#reports.upsertMetricReports(
        rows.filter((row) => !isDeferredAction(row)).map(toStorageRow)
      );
      await this.#measurement.advanceReportCheckpoint({
        periodType,
        periodEndExclusive: period.endExclusive,
      });
      counters.generated += 1;
      summary.actionMetric.deferred += deferred.length;
      // Source status per metric: how many metrics in this period had an
      // unavailable source. No period dates, counts of users, or values.
      const unavailable = rows.filter((row) => row.sourceStatus === 'unavailable').length;
      operationalLogger.info({
        event: 'REPORT_PERIOD_GENERATED',
        periodType,
        sourceStatus: unavailable > 0 ? 'unavailable' : 'complete',
        count: unavailable,
      });
    }
  }

  async #finalizeDeferred(periodType, now, dry, summary) {
    const { records } = await this.#reports.listPeriodsMissingMetric({
      periodType,
      metricName: DEFERRED_ACTION_METRIC,
      limit: this.#maxPeriodsPerRun,
    });
    for (const pending of records) {
      if (dry) {
        summary.actionMetric.pending += 1;
        continue;
      }
      const period = createPeriod(periodType, toLocalDate(pending.periodStart));
      if (period.start !== pending.periodStart || period.endExclusive !== pending.periodEndExclusive) {
        continue;
      }
      const rows = await this.#calculate(period, now);
      const action = rows.find((row) => row.metricName === DEFERRED_ACTION_METRIC);
      if (!action || isDeferredAction(action)) {
        summary.actionMetric.pending += 1;
        continue;
      }
      await this.#reports.upsertMetricReports([toStorageRow(action)]);
      summary.actionMetric.finalized += 1;
    }
  }

  /**
   * Materialize every newly completed weekly and 28-day period (bounded per
   * run; `hasMore` reports a remaining backlog), finish deferred action
   * metrics whose windows have closed, then apply retention. The summary holds
   * counts and instants only.
   */
  async generateCompletedReports({ dry = false } = {}) {
    const now = this.#clock();
    const cutoff = eventRetentionCutoff(now);
    const summary = {
      dry,
      generatedAt: toIsoInstant(now.getTime()),
      timeZone: MEASUREMENT_TIME_ZONE,
      periods: Object.fromEntries(
        REPORT_PERIOD_TYPES.map((type) => [type, { generated: 0, hasMore: false }])
      ),
      actionMetric: { deferred: 0, finalized: 0, pending: 0 },
      retention: { cutoff, purgedEvents: 0, skipped: true },
      failures: [],
    };

    for (const periodType of REPORT_PERIOD_TYPES) {
      try {
        await this.#generateType(periodType, now, cutoff, dry, summary);
        await this.#finalizeDeferred(periodType, now, dry, summary);
      } catch (error) {
        // Log the operation and error class only; messages can echo query text.
        operationalLogger.error({
          event: 'REPORT_GENERATION_FAILED',
          periodType,
          errorName: safeErrorName(error),
          code: safeErrorCode(error),
        });
        summary.failures.push({ periodType, code: 'REPORT_GENERATION_FAILED' });
      }
    }

    const backlog = REPORT_PERIOD_TYPES.some((type) => summary.periods[type].hasMore);
    if (!dry && summary.failures.length === 0 && !backlog) {
      try {
        summary.retention.purgedEvents = await this.#reports.purgeEventsBefore(cutoff);
        summary.retention.skipped = false;
      } catch (error) {
        operationalLogger.error({
          event: 'REPORT_RETENTION_PURGE_FAILED',
          errorName: safeErrorName(error),
          code: safeErrorCode(error),
        });
        summary.failures.push({ periodType: null, code: 'RETENTION_PURGE_FAILED' });
      }
    }
    return summary;
  }

  /** Aggregate-only report read, newest periods first. */
  async listReports({ periodType = null, limit = DEFAULT_LIST_LIMIT } = {}) {
    if (periodType != null && !REPORT_PERIOD_TYPES.includes(periodType)) {
      throw new MeasurementReportError({
        code: 'INVALID_PERIOD_TYPE',
        message: 'periodType must be weekly or 28_day.',
      });
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
      throw new MeasurementReportError({
        code: 'INVALID_LIMIT',
        message: `limit must be an integer from 1 to ${MAX_LIST_LIMIT}.`,
      });
    }

    const { records } = await this.#reports.listMetricReports({ periodType, limit });
    const periods = new Map();
    for (const row of records) {
      const key = `${row.periodType}|${row.periodStart}|${row.periodEndExclusive}`;
      if (!periods.has(key)) {
        periods.set(key, {
          periodType: row.periodType,
          periodStart: row.periodStart,
          periodEndExclusive: row.periodEndExclusive,
          timeZone: row.timeZone,
          metrics: [],
        });
      }
      periods.get(key).metrics.push(serializeMetric(row));
    }

    const reports = [...periods.values()].map((period) => {
      period.metrics.sort(
        (a, b) => METRIC_NAMES.indexOf(a.metricName) - METRIC_NAMES.indexOf(b.metricName)
      );
      const present = new Set(period.metrics.map((metric) => metric.metricName));
      return {
        ...period,
        deferredMetrics: METRIC_NAMES.filter((name) => !present.has(name)),
      };
    });
    return { timeZone: MEASUREMENT_TIME_ZONE, reports };
  }
}

const measurementReportService = new MeasurementReportService();
export default measurementReportService;

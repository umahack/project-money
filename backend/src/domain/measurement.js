import { FINANCIAL_CLARITY_TIME_ZONE } from './monthlyPlan.js';

/**
 * Pure success-measurement calculations (Requirement 13).
 *
 * This module performs no I/O and never reads the process clock: every caller
 * injects `now` / `generatedAt`. The configured time zone is Asia/Kolkata, which
 * has had a fixed +05:30 offset with no daylight-saving transitions since 1945,
 * so local-time conversion is exact integer arithmetic on that offset instead of
 * a dependence on the host's ICU data. Instants before 1945 are not supported.
 *
 * Conventions
 * - Instants are accepted as Date objects, ISO-8601 `...Z` strings, or SQLite
 *   `YYYY-MM-DD HH:MM:SS` strings (interpreted as UTC) and are emitted as
 *   ISO strings.
 * - Local dates are `YYYY-MM-DD` strings. Periods are half-open
 *   `[start, endExclusive)` and are aligned to local midnight.
 * - Rates are `numerator / denominator` over non-negative integers. The
 *   unrounded ratio is used for every target comparison (BigInt cross-multiply).
 *   The displayed value is the ratio times 100, rounded half up to one decimal
 *   and stored as integer tenths: `floor((2000 * n + d) / (2 * d))`.
 * - Durations are integer milliseconds. An even-count median is the mean of the
 *   two middle values, which can be a half millisecond. It is carried exactly as
 *   `numerator / divisor` (divisor 1 or 2); `durationMs` is that value rounded
 *   half up. Target comparison uses the exact fraction.
 * - A value that cannot be computed (empty population or unavailable source) is
 *   `null`, never zero.
 */

export const MEASUREMENT_TIME_ZONE = FINANCIAL_CLARITY_TIME_ZONE;
export const MEASUREMENT_CALCULATION_VERSION = 1;
export const REPORT_PERIOD_TYPES = Object.freeze(['weekly', '28_day']);

/** Mirrors the fixed source enum in repositories/measurementRepository.js. */
export const MEASUREMENT_SOURCES = Object.freeze([
  'guided_journeys',
  'product_measurement_events',
  'financial_record_changes',
]);

export const MEASUREMENT_EVENT_NAMES = Object.freeze({
  firstOutcome: 'first_outcome_displayed',
  clarityResponse: 'clarity_response',
  actionCompleted: 'recommended_action_completed',
  financialChange: 'financial_change_ui',
});

export const METRIC_NAMES = Object.freeze([
  'first_meaningful_outcome_rate',
  'median_time_to_first_meaningful_outcome',
  'clarity_confirmation_rate',
  'recommended_action_completion_rate',
  'financial_change_reload_rate',
  'financial_change_page_wide_loading_rate',
]);

export const TARGET_STATUSES = Object.freeze(['met', 'not_met', 'insufficient_data']);

const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 86_400_000;
const WEEK_DAYS = 7;
const WINDOW_28_DAYS = 28;
const ACTION_WINDOW_DAYS = 7;
const CLARITY_RESPONSE_VALUES = new Set(['yes', 'partly', 'no']);
const SOURCE_SET = new Set(MEASUREMENT_SOURCES);
const PERIOD_TYPE_SET = new Set(REPORT_PERIOD_TYPES);
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;
const SQLITE_INSTANT = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Metric definitions. `targets` is keyed by period type; a period type without
 * an entry has no target (cohort targets apply to 28-day periods only).
 * - `at_least`: unrounded percentage >= `percent`.
 * - `at_most`: unrounded percentage <= `percent` (zero means no event may match).
 * - `at_most_ms`: exact median duration <= `maxMs`.
 * `minimumSample` is compared to the metric's sample size (its denominator).
 */
export const METRIC_DEFINITIONS = Object.freeze({
  first_meaningful_outcome_rate: Object.freeze({
    kind: 'rate',
    sources: Object.freeze(['guided_journeys', 'product_measurement_events']),
    populationDefinition:
      'New users whose earliest guided journey started in the period with analytics enabled; '
      + 'numerator counts those who displayed a first meaningful outcome during the starting journey session.',
    targets: Object.freeze({
      '28_day': Object.freeze({ comparator: 'at_least', percent: 75, minimumSample: 100 }),
    }),
  }),
  median_time_to_first_meaningful_outcome: Object.freeze({
    kind: 'duration',
    sources: Object.freeze(['guided_journeys', 'product_measurement_events']),
    populationDefinition:
      'New users in the cohort who displayed a first meaningful outcome during the starting journey session; '
      + 'duration runs from journey start to first display.',
    targets: Object.freeze({
      '28_day': Object.freeze({ comparator: 'at_most_ms', maxMs: 120_000, minimumSample: 100 }),
    }),
  }),
  clarity_confirmation_rate: Object.freeze({
    kind: 'rate',
    sources: Object.freeze(['guided_journeys', 'product_measurement_events']),
    populationDefinition:
      'Submitted Yes, Partly, and No clarity responses on the starting journey from cohort users; '
      + 'numerator counts Yes responses.',
    targets: Object.freeze({
      '28_day': Object.freeze({ comparator: 'at_least', percent: 80, minimumSample: 50 }),
    }),
  }),
  recommended_action_completion_rate: Object.freeze({
    kind: 'rate',
    sources: Object.freeze(['guided_journeys', 'product_measurement_events']),
    populationDefinition:
      'Cohort users who displayed a first meaningful outcome during the starting journey session; '
      + 'numerator counts users with at least one recommended action completion in the seven-day action window.',
    targets: Object.freeze({
      '28_day': Object.freeze({ comparator: 'at_least', percent: 40, minimumSample: 100 }),
    }),
  }),
  financial_change_reload_rate: Object.freeze({
    kind: 'rate',
    sources: Object.freeze(['product_measurement_events', 'financial_record_changes']),
    populationDefinition:
      'Valid financial record changes reported during the period; numerator counts those that triggered a page reload.',
    targets: Object.freeze({
      weekly: Object.freeze({ comparator: 'at_most', percent: 0, minimumSample: 1 }),
      '28_day': Object.freeze({ comparator: 'at_most', percent: 0, minimumSample: 1 }),
    }),
  }),
  financial_change_page_wide_loading_rate: Object.freeze({
    kind: 'rate',
    sources: Object.freeze(['product_measurement_events', 'financial_record_changes']),
    populationDefinition:
      'Valid financial record changes reported during the period; numerator counts those that triggered a page-wide loading state.',
    targets: Object.freeze({
      weekly: Object.freeze({ comparator: 'at_most', percent: 0, minimumSample: 1 }),
      '28_day': Object.freeze({ comparator: 'at_most', percent: 0, minimumSample: 1 }),
    }),
  }),
});

// ---------------------------------------------------------------------------
// Validation and instant / local-date primitives
// ---------------------------------------------------------------------------

function assertTimeZone(timeZone) {
  if (timeZone !== MEASUREMENT_TIME_ZONE) {
    throw new RangeError(`timeZone must be ${MEASUREMENT_TIME_ZONE}.`);
  }
  return timeZone;
}

function assertPeriodType(periodType) {
  if (!PERIOD_TYPE_SET.has(periodType)) {
    throw new TypeError('periodType must be weekly or 28_day.');
  }
  return periodType;
}

function assertPositiveId(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

function assertNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

/** Parse an instant to epoch milliseconds, rejecting impossible calendar values. */
export function toEpochMs(value, label = 'instant') {
  if (value instanceof Date) {
    const ms = value.getTime();
    if (!Number.isFinite(ms)) throw new TypeError(`${label} must be a valid instant.`);
    return ms;
  }
  if (typeof value !== 'string') throw new TypeError(`${label} must be a Date or timestamp string.`);
  const match = ISO_INSTANT.exec(value) ?? SQLITE_INSTANT.exec(value);
  if (!match) throw new TypeError(`${label} must be an ISO-8601 UTC or SQLite timestamp.`);
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const millis = match[7] ? Number(match[7].padEnd(3, '0')) : 0;
  const ms = Date.UTC(year, month - 1, day, hour, minute, second, millis);
  const roundTrip = new Date(ms);
  if (
    hour > 23
    || roundTrip.getUTCFullYear() !== year
    || roundTrip.getUTCMonth() !== month - 1
    || roundTrip.getUTCDate() !== day
    || roundTrip.getUTCHours() !== hour
    || roundTrip.getUTCMinutes() !== minute
    || roundTrip.getUTCSeconds() !== second
  ) {
    throw new TypeError(`${label} must be a valid calendar instant.`);
  }
  return ms;
}

export function toIsoInstant(ms) {
  if (!Number.isFinite(ms)) throw new TypeError('Instant must be finite.');
  return new Date(ms).toISOString();
}

/** Whole local days since 1970-01-01 for a `YYYY-MM-DD` string (validated). */
function parseLocalDate(value, label = 'localDate') {
  const match = typeof value === 'string' ? LOCAL_DATE.exec(value) : null;
  if (!match) throw new TypeError(`${label} must use YYYY-MM-DD format.`);
  const [year, month, day] = match.slice(1).map(Number);
  const ms = Date.UTC(year, month - 1, day);
  const roundTrip = new Date(ms);
  if (
    roundTrip.getUTCFullYear() !== year
    || roundTrip.getUTCMonth() !== month - 1
    || roundTrip.getUTCDate() !== day
  ) {
    throw new TypeError(`${label} must be a valid calendar date.`);
  }
  return Math.round(ms / DAY_MS);
}

function formatLocalDate(dayNumber) {
  return new Date(dayNumber * DAY_MS).toISOString().slice(0, 10);
}

/** Floor division that is correct for negative numerators. */
function floorDiv(value, divisor) {
  return Math.floor(value / divisor);
}

function localDayNumberOf(ms) {
  return floorDiv(ms + IST_OFFSET_MS, DAY_MS);
}

function localMidnightMs(dayNumber) {
  return dayNumber * DAY_MS - IST_OFFSET_MS;
}

/** Monday-based weekday index: Monday = 0 ... Sunday = 6. 1970-01-01 was a Thursday. */
function weekdayIndex(dayNumber) {
  return (((dayNumber + 3) % 7) + 7) % 7;
}

/** Local calendar date (`YYYY-MM-DD`) of an instant in the configured zone. */
export function toLocalDate(instant, { timeZone = MEASUREMENT_TIME_ZONE } = {}) {
  assertTimeZone(timeZone);
  return formatLocalDate(localDayNumberOf(toEpochMs(instant)));
}

/** Monday (`YYYY-MM-DD`) of the local week containing an instant. */
export function toLocalWeekStart(instant, { timeZone = MEASUREMENT_TIME_ZONE } = {}) {
  assertTimeZone(timeZone);
  const day = localDayNumberOf(toEpochMs(instant));
  return formatLocalDate(day - weekdayIndex(day));
}

/**
 * The same local wall-clock time `days` calendar dates later. IST has no offset
 * transitions, so this is exact; it is written in local terms so the intent
 * ("same local time on the seventh following date") is explicit.
 */
function addLocalCalendarDays(ms, days) {
  const localMs = ms + IST_OFFSET_MS;
  const day = floorDiv(localMs, DAY_MS);
  const msOfDay = localMs - day * DAY_MS;
  return (day + days) * DAY_MS + msOfDay - IST_OFFSET_MS;
}

// ---------------------------------------------------------------------------
// Reporting periods
// ---------------------------------------------------------------------------

function buildPeriod(periodType, startDay, lengthDays) {
  const endDay = startDay + lengthDays;
  const start = toIsoInstant(localMidnightMs(startDay));
  const endExclusive = toIsoInstant(localMidnightMs(endDay));
  return Object.freeze({
    periodType,
    timeZone: MEASUREMENT_TIME_ZONE,
    startDate: formatLocalDate(startDay),
    endDateInclusive: formatLocalDate(endDay - 1),
    endDateExclusive: formatLocalDate(endDay),
    start,
    endExclusive,
  });
}

/**
 * Create a period beginning at local midnight of `startDate`. Weekly periods
 * must start on a Monday and span 7 local dates; 28-day periods may start on any
 * date and span exactly 28 local dates.
 */
export function createPeriod(periodType, startDate, { timeZone = MEASUREMENT_TIME_ZONE } = {}) {
  assertTimeZone(timeZone);
  assertPeriodType(periodType);
  const startDay = parseLocalDate(startDate, 'startDate');
  if (periodType === 'weekly') {
    if (weekdayIndex(startDay) !== 0) throw new RangeError('A weekly period must start on a Monday.');
    return buildPeriod('weekly', startDay, WEEK_DAYS);
  }
  return buildPeriod('28_day', startDay, WINDOW_28_DAYS);
}

/** The Monday-to-Monday local week containing `instant`. */
export function weeklyPeriodContaining(instant, options = {}) {
  return createPeriod('weekly', toLocalWeekStart(instant, options), options);
}

/** The 28 consecutive local dates ending on (and including) `reportEndDate`. */
export function twentyEightDayPeriodEndingOn(reportEndDate, { timeZone = MEASUREMENT_TIME_ZONE } = {}) {
  assertTimeZone(timeZone);
  const endDay = parseLocalDate(reportEndDate, 'reportEndDate');
  return buildPeriod('28_day', endDay - (WINDOW_28_DAYS - 1), WINDOW_28_DAYS);
}

/** True when the half-open period has fully elapsed at `now`. */
export function isPeriodCompleted(period, now) {
  return toEpochMs(period.endExclusive, 'period.endExclusive') <= toEpochMs(now, 'now');
}

/** True when `instant` lies in `[period.start, period.endExclusive)`. */
export function isInstantInPeriod(period, instant) {
  const ms = toEpochMs(instant);
  return ms >= toEpochMs(period.start) && ms < toEpochMs(period.endExclusive);
}

/**
 * Seven-day action window: from the display instant inclusive to the same local
 * time on the seventh following calendar date exclusive.
 */
export function actionWindowFor(displayInstant, { timeZone = MEASUREMENT_TIME_ZONE } = {}) {
  assertTimeZone(timeZone);
  const startMs = toEpochMs(displayInstant, 'displayInstant');
  return Object.freeze({
    start: toIsoInstant(startMs),
    endExclusive: toIsoInstant(addLocalCalendarDays(startMs, ACTION_WINDOW_DAYS)),
  });
}

/**
 * Completed periods of one type, oldest first, that end after the stored
 * checkpoint and at or before `now`.
 *
 * Weekly periods are consecutive Monday weeks. 28-day periods are rolling: one
 * period ends on each local date, so each new local day completes one more.
 * With no checkpoint, `earliestInstant` (the earliest source data) seeds the
 * first period: its week for weekly, or the 28 dates starting on its local date.
 * `maxPeriods` bounds a runaway backfill.
 */
export function listCompletedPeriods({
  periodType,
  now,
  checkpointEndExclusive = null,
  earliestInstant = null,
  maxPeriods = 400,
  timeZone = MEASUREMENT_TIME_ZONE,
}) {
  assertTimeZone(timeZone);
  assertPeriodType(periodType);
  assertPositiveId(maxPeriods, 'maxPeriods');
  const nowMs = toEpochMs(now, 'now');
  const stepDays = periodType === 'weekly' ? WEEK_DAYS : 1;
  const lengthDays = periodType === 'weekly' ? WEEK_DAYS : WINDOW_28_DAYS;

  let nextEndDay;
  if (checkpointEndExclusive != null) {
    const checkpointMs = toEpochMs(checkpointEndExclusive, 'checkpointEndExclusive');
    const checkpointDay = localDayNumberOf(checkpointMs);
    if (localMidnightMs(checkpointDay) !== checkpointMs) {
      throw new RangeError('checkpointEndExclusive must be local midnight.');
    }
    if (periodType === 'weekly' && weekdayIndex(checkpointDay) !== 0) {
      throw new RangeError('A weekly checkpoint must be a Monday.');
    }
    nextEndDay = checkpointDay + stepDays;
  } else {
    if (earliestInstant == null) {
      throw new TypeError('earliestInstant is required when there is no checkpoint.');
    }
    const earliestDay = localDayNumberOf(toEpochMs(earliestInstant, 'earliestInstant'));
    const firstStartDay = periodType === 'weekly' ? earliestDay - weekdayIndex(earliestDay) : earliestDay;
    nextEndDay = firstStartDay + lengthDays;
  }

  const periods = [];
  while (localMidnightMs(nextEndDay) <= nowMs) {
    if (periods.length >= maxPeriods) {
      throw new RangeError('More completed periods than maxPeriods; advance the checkpoint first.');
    }
    periods.push(buildPeriod(periodType, nextEndDay - lengthDays, lengthDays));
    nextEndDay += stepDays;
  }
  return periods;
}

// ---------------------------------------------------------------------------
// Rates, medians, and targets
// ---------------------------------------------------------------------------

/**
 * Rate with exact integer rounding. Returns `percentageTenths` (percentage x 10,
 * rounded half up) and a one-decimal display string. An empty denominator yields
 * null values rather than zero.
 */
export function calculateRate(numerator, denominator) {
  assertNonNegativeInteger(numerator, 'numerator');
  assertNonNegativeInteger(denominator, 'denominator');
  if (numerator > denominator) throw new RangeError('numerator must not exceed denominator.');
  if (denominator === 0) {
    return Object.freeze({ numerator, denominator, percentageTenths: null, percentageDisplay: null });
  }
  const n = BigInt(numerator);
  const d = BigInt(denominator);
  const percentageTenths = Number((2000n * n + d) / (2n * d));
  return Object.freeze({
    numerator,
    denominator,
    percentageTenths,
    percentageDisplay: `${Math.floor(percentageTenths / 10)}.${percentageTenths % 10}`,
  });
}

/** Exact test of `numerator / denominator * 100 >= percent` without rounding. */
export function rateAtLeast(numerator, denominator, percent) {
  assertNonNegativeInteger(percent, 'percent');
  return denominator > 0 && BigInt(numerator) * 100n >= BigInt(percent) * BigInt(denominator);
}

/** Exact test of `numerator / denominator * 100 <= percent` without rounding. */
export function rateAtMost(numerator, denominator, percent) {
  assertNonNegativeInteger(percent, 'percent');
  return denominator > 0 && BigInt(numerator) * 100n <= BigInt(percent) * BigInt(denominator);
}

/**
 * Median of non-negative integer durations. An odd count returns the middle
 * value; an even count returns the mean of the two middle values. The result is
 * exact (`numerator / divisor`) with a half-up integer `value`. Empty input
 * returns `null` values. The input is not mutated.
 */
export function calculateMedian(values) {
  if (!Array.isArray(values)) throw new TypeError('values must be an array.');
  values.forEach((value, index) => assertNonNegativeInteger(value, `values[${index}]`));
  const count = values.length;
  if (count === 0) {
    return Object.freeze({ count: 0, numerator: null, divisor: null, value: null });
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = count >> 1;
  if (count % 2 === 1) {
    return Object.freeze({ count, numerator: sorted[middle], divisor: 1, value: sorted[middle] });
  }
  const sum = sorted[middle - 1] + sorted[middle];
  if (!Number.isSafeInteger(sum)) throw new RangeError('Median sum must be a safe integer.');
  return Object.freeze({ count, numerator: sum, divisor: 2, value: Math.floor((sum + 1) / 2) });
}

/**
 * Combine sample size and target result: below the minimum sample is
 * `insufficient_data`; otherwise `met` or `not_met`.
 */
export function classifyTarget({ sampleSize, minimumSample, meetsTarget }) {
  assertNonNegativeInteger(sampleSize, 'sampleSize');
  assertPositiveId(minimumSample, 'minimumSample');
  if (sampleSize < minimumSample) return 'insufficient_data';
  return meetsTarget ? 'met' : 'not_met';
}

/** The target definition that applies to a metric in a period type, or null. */
export function targetFor(metricName, periodType) {
  assertPeriodType(periodType);
  const definition = METRIC_DEFINITIONS[metricName];
  if (!definition) throw new RangeError('Unknown metric name.');
  return definition.targets[periodType] ?? null;
}

function evaluateRateTarget(target, rate) {
  if (!target) return null;
  const meetsTarget = target.comparator === 'at_least'
    ? rateAtLeast(rate.numerator, rate.denominator, target.percent)
    : rateAtMost(rate.numerator, rate.denominator, target.percent);
  return classifyTarget({
    sampleSize: rate.denominator,
    minimumSample: target.minimumSample,
    meetsTarget,
  });
}

function evaluateMedianTarget(target, median) {
  if (!target) return null;
  const meetsTarget = median.count > 0 && median.numerator <= target.maxMs * median.divisor;
  return classifyTarget({
    sampleSize: median.count,
    minimumSample: target.minimumSample,
    meetsTarget,
  });
}

// ---------------------------------------------------------------------------
// Source-failure classification
// ---------------------------------------------------------------------------

/**
 * Decide whether the sources a metric requires were available for
 * `[rangeStart, rangeEndExclusive)`. Any overlapping outage of a required source
 * makes the metric unavailable. Outages of other sources are ignored. Outage
 * intervals are clipped to the range and merged per source, and the result
 * names each unavailable source with its affected time range.
 *
 * `outages` items: `{ sourceName, unavailableStart, unavailableEndExclusive }`.
 */
export function classifySourceAvailability({ outages = [], requiredSources, rangeStart, rangeEndExclusive }) {
  if (!Array.isArray(outages)) throw new TypeError('outages must be an array.');
  if (!Array.isArray(requiredSources) || requiredSources.length === 0) {
    throw new TypeError('requiredSources must be a non-empty array.');
  }
  requiredSources.forEach((source) => {
    if (!SOURCE_SET.has(source)) throw new RangeError('requiredSources must be fixed measurement sources.');
  });
  const startMs = toEpochMs(rangeStart, 'rangeStart');
  const endMs = toEpochMs(rangeEndExclusive, 'rangeEndExclusive');
  if (startMs >= endMs) throw new RangeError('rangeStart must be earlier than rangeEndExclusive.');

  const required = new Set(requiredSources);
  const bySource = new Map();
  for (const outage of outages) {
    if (!SOURCE_SET.has(outage?.sourceName)) {
      throw new RangeError('Outage sourceName must be a fixed measurement source.');
    }
    const outageStart = toEpochMs(outage.unavailableStart, 'unavailableStart');
    const outageEnd = toEpochMs(outage.unavailableEndExclusive, 'unavailableEndExclusive');
    if (outageStart >= outageEnd) throw new RangeError('Outage start must be earlier than its end.');
    if (!required.has(outage.sourceName) || outageStart >= endMs || outageEnd <= startMs) continue;
    const clipped = [Math.max(outageStart, startMs), Math.min(outageEnd, endMs)];
    if (!bySource.has(outage.sourceName)) bySource.set(outage.sourceName, []);
    bySource.get(outage.sourceName).push(clipped);
  }

  const unavailableSources = [];
  for (const sourceName of [...bySource.keys()].sort()) {
    const intervals = bySource.get(sourceName).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let [mergedStart, mergedEnd] = intervals[0];
    for (const [intervalStart, intervalEnd] of intervals.slice(1)) {
      if (intervalStart <= mergedEnd) {
        mergedEnd = Math.max(mergedEnd, intervalEnd);
      } else {
        unavailableSources.push({ sourceName, start: toIsoInstant(mergedStart), endExclusive: toIsoInstant(mergedEnd) });
        [mergedStart, mergedEnd] = [intervalStart, intervalEnd];
      }
    }
    unavailableSources.push({ sourceName, start: toIsoInstant(mergedStart), endExclusive: toIsoInstant(mergedEnd) });
  }

  if (unavailableSources.length === 0) {
    return Object.freeze({
      sourceStatus: 'complete',
      unavailableSources: Object.freeze([]),
      unavailableSource: null,
      unavailableStart: null,
      unavailableEndExclusive: null,
    });
  }
  const starts = unavailableSources.map((entry) => entry.start).sort();
  const ends = unavailableSources.map((entry) => entry.endExclusive).sort();
  return Object.freeze({
    sourceStatus: 'unavailable',
    unavailableSources: Object.freeze(unavailableSources.map((entry) => Object.freeze(entry))),
    unavailableSource: [...new Set(unavailableSources.map((entry) => entry.sourceName))].join(','),
    unavailableStart: starts[0],
    unavailableEndExclusive: ends[ends.length - 1],
  });
}

// ---------------------------------------------------------------------------
// Cohorts
// ---------------------------------------------------------------------------

function normalizeJourney(journey, index) {
  if (!journey || typeof journey !== 'object') throw new TypeError(`journeys[${index}] must be an object.`);
  const eligible = journey.measurementEligible;
  if (typeof eligible !== 'boolean' && eligible !== 0 && eligible !== 1) {
    throw new TypeError(`journeys[${index}].measurementEligible must be a boolean.`);
  }
  return {
    id: assertPositiveId(journey.id, `journeys[${index}].id`),
    userId: assertPositiveId(journey.userId, `journeys[${index}].userId`),
    startedAtMs: toEpochMs(journey.startedAt, `journeys[${index}].startedAt`),
    measurementEligible: eligible === true || eligible === 1,
  };
}

/**
 * Earliest journey per user across the complete history (measurement-eligible
 * or not), ordered by start instant then journey id. Returns a Map by user id.
 */
export function resolveEarliestJourneys(journeys) {
  if (!Array.isArray(journeys)) throw new TypeError('journeys must be an array.');
  const seenIds = new Set();
  const earliest = new Map();
  journeys.forEach((raw, index) => {
    const journey = normalizeJourney(raw, index);
    if (seenIds.has(journey.id)) throw new RangeError(`Duplicate journey id ${journey.id}.`);
    seenIds.add(journey.id);
    const current = earliest.get(journey.userId);
    if (
      !current
      || journey.startedAtMs < current.startedAtMs
      || (journey.startedAtMs === current.startedAtMs && journey.id < current.id)
    ) {
      earliest.set(journey.userId, journey);
    }
  });
  return earliest;
}

function normalizeConsents(consents) {
  if (!Array.isArray(consents)) throw new TypeError('consents must be an array.');
  const byUser = new Map();
  consents.forEach((consent, index) => {
    const userId = assertPositiveId(consent?.userId, `consents[${index}].userId`);
    if (typeof consent.analyticsEnabled !== 'boolean') {
      throw new TypeError(`consents[${index}].analyticsEnabled must be a boolean.`);
    }
    if (byUser.has(userId)) throw new RangeError(`Duplicate consent for user ${userId}.`);
    byUser.set(userId, {
      analyticsEnabled: consent.analyticsEnabled,
      analyticsChangedAtMs: consent.analyticsChangedAt == null
        ? null
        : toEpochMs(consent.analyticsChangedAt, `consents[${index}].analyticsChangedAt`),
    });
  });
  return byUser;
}

/**
 * New-user cohort for a period.
 *
 * A user is new in the period when their earliest guided-journey start over the
 * complete history falls in `[period.start, period.endExclusive)`; each user
 * appears at most once. Pass every journey of every candidate user, including
 * journeys that were not measurement-eligible, so an earlier ineligible journey
 * keeps a returning user from being relabelled as new.
 *
 * A new user is measurable when the earliest journey was measurement-eligible
 * and, if a consent record is supplied, analytics was not turned off at or
 * before the period end (`analyticsEnabled` false with a change time before the
 * period end, or with an unknown change time). Consent is a current-state
 * snapshot, so a disable-then-re-enable inside the window cannot be detected.
 */
export function assignNewUserCohort({ journeys, period, consents = [] }) {
  const startMs = toEpochMs(period.start, 'period.start');
  const endMs = toEpochMs(period.endExclusive, 'period.endExclusive');
  const consentByUser = normalizeConsents(consents);
  const users = [];
  let excludedNotMeasurementEligible = 0;
  let excludedOptedOut = 0;

  const earliest = resolveEarliestJourneys(journeys);
  const candidates = [...earliest.values()]
    .filter((journey) => journey.startedAtMs >= startMs && journey.startedAtMs < endMs)
    .sort((a, b) => a.userId - b.userId);

  for (const journey of candidates) {
    if (!journey.measurementEligible) {
      excludedNotMeasurementEligible += 1;
      continue;
    }
    const consent = consentByUser.get(journey.userId);
    const optedOut = consent
      && !consent.analyticsEnabled
      && (consent.analyticsChangedAtMs == null || consent.analyticsChangedAtMs < endMs);
    if (optedOut) {
      excludedOptedOut += 1;
      continue;
    }
    users.push(Object.freeze({
      userId: journey.userId,
      journeyId: journey.id,
      startedAt: toIsoInstant(journey.startedAtMs),
      startedAtMs: journey.startedAtMs,
    }));
  }

  return Object.freeze({
    users: Object.freeze(users),
    population: Object.freeze({
      newUsers: candidates.length,
      measurableUsers: users.length,
      excludedNotMeasurementEligible,
      excludedOptedOut,
    }),
  });
}

// ---------------------------------------------------------------------------
// Event handling
// ---------------------------------------------------------------------------

function normalizeEvents(events) {
  if (!Array.isArray(events)) throw new TypeError('events must be an array.');
  return events.map((event, index) => {
    if (!event || typeof event !== 'object' || typeof event.eventName !== 'string') {
      throw new TypeError(`events[${index}] must have an eventName.`);
    }
    return {
      order: index,
      id: Number.isSafeInteger(event.id) ? event.id : 0,
      userId: assertPositiveId(event.userId, `events[${index}].userId`),
      eventName: event.eventName,
      journeyId: event.journeyId ?? null,
      response: event.response ?? null,
      changeId: event.changeId ?? null,
      causedReload: event.causedReload ?? null,
      causedPageWideLoading: event.causedPageWideLoading ?? null,
      occurredAtMs: toEpochMs(event.occurredAt, `events[${index}].occurredAt`),
    };
  });
}

const compareEvents = (a, b) => a.occurredAtMs - b.occurredAtMs || a.id - b.id || a.order - b.order;

function groupByUser(events, eventName) {
  const grouped = new Map();
  for (const event of events) {
    if (event.eventName !== eventName) continue;
    if (!grouped.has(event.userId)) grouped.set(event.userId, []);
    grouped.get(event.userId).push(event);
  }
  for (const list of grouped.values()) list.sort(compareEvents);
  return grouped;
}

/**
 * For each cohort user, the earliest first-outcome display on the starting
 * journey. The ingestion service only stores this event when the authenticated
 * session is the journey's starting session, so presence of the event is the
 * same-session condition. A display before the journey start is invalid and is
 * ignored.
 */
function resolveFirstOutcomes(cohortUsers, events) {
  const byUser = groupByUser(events, MEASUREMENT_EVENT_NAMES.firstOutcome);
  const displays = [];
  for (const user of cohortUsers) {
    const display = (byUser.get(user.userId) ?? []).find(
      (event) => event.journeyId === user.journeyId && event.occurredAtMs >= user.startedAtMs
    );
    if (display) {
      displays.push({
        userId: user.userId,
        journeyId: user.journeyId,
        displayedAtMs: display.occurredAtMs,
        durationMs: display.occurredAtMs - user.startedAtMs,
      });
    }
  }
  return displays;
}

// ---------------------------------------------------------------------------
// Report assembly
// ---------------------------------------------------------------------------

function baseRow({ metricName, period, generatedAtMs, availability, population }) {
  const definition = METRIC_DEFINITIONS[metricName];
  const target = definition.targets[period.periodType] ?? null;
  return {
    metricName,
    periodType: period.periodType,
    periodStart: period.start,
    periodEndExclusive: period.endExclusive,
    periodStartDate: period.startDate,
    periodEndDateInclusive: period.endDateInclusive,
    timeZone: period.timeZone,
    populationDefinition: definition.populationDefinition,
    population,
    target: target ? { ...target } : null,
    sourceStatus: availability.sourceStatus,
    unavailableSource: availability.unavailableSource,
    unavailableStart: availability.unavailableStart,
    unavailableEndExclusive: availability.unavailableEndExclusive,
    unavailableSources: availability.unavailableSources,
    generatedAt: toIsoInstant(generatedAtMs),
    calculationVersion: MEASUREMENT_CALCULATION_VERSION,
  };
}

function rateRow(base, rate, targetStatus) {
  return Object.freeze({
    ...base,
    numerator: rate.numerator,
    denominator: rate.denominator,
    percentageTenths: rate.percentageTenths,
    percentageDisplay: rate.percentageDisplay,
    durationMs: null,
    durationExact: null,
    targetStatus,
  });
}

function unavailableRow(base) {
  return Object.freeze({
    ...base,
    numerator: null,
    denominator: null,
    percentageTenths: null,
    percentageDisplay: null,
    durationMs: null,
    durationExact: null,
    targetStatus: null,
  });
}

/**
 * Calculate all six success metrics for one completed period.
 *
 * Inputs (all plain data; repository row shapes are accepted as-is):
 * - `period`: from `createPeriod` / `weeklyPeriodContaining` / etc.
 * - `generatedAt`: injected instant; must be at or after the period end.
 * - `journeys`: complete journey history of candidate users (see assignNewUserCohort).
 * - `events`: product measurement events for cohort users, covering at least the
 *   starting-journey activity and seven-day action windows, plus change events
 *   for the period.
 * - `consents`: optional `{ userId, analyticsEnabled, analyticsChangedAt }`.
 * - `outages`: `{ sourceName, unavailableStart, unavailableEndExclusive }` records.
 *
 * Cohort metrics count the cohort's starting-journey events with no upper time
 * bound (a display or response that arrives after the period end still counts).
 * The action metric extends its source-availability range to the latest action
 * window end, capped at `generatedAt`, and reports how many windows were still
 * open at `generatedAt` in `population.openActionWindows`.
 *
 * Each metric is evaluated independently: an overlapping outage of one of its
 * required sources makes only that metric `unavailable` (null values, no target
 * status); every other metric is unaffected.
 */
export function calculateMetricReport({
  period,
  generatedAt,
  journeys = [],
  events = [],
  consents = [],
  outages = [],
}) {
  assertPeriodType(period?.periodType);
  assertTimeZone(period.timeZone);
  const generatedAtMs = toEpochMs(generatedAt, 'generatedAt');
  const periodStartMs = toEpochMs(period.start, 'period.start');
  const periodEndMs = toEpochMs(period.endExclusive, 'period.endExclusive');
  if (generatedAtMs < periodEndMs) {
    throw new RangeError('Metrics are calculated only for completed periods.');
  }

  const normalizedEvents = normalizeEvents(events);
  const cohort = assignNewUserCohort({ journeys, period, consents });
  const displays = resolveFirstOutcomes(cohort.users, normalizedEvents);

  // Seven-day action windows: one completion per user, however many occur.
  const actionsByUser = groupByUser(normalizedEvents, MEASUREMENT_EVENT_NAMES.actionCompleted);
  let completedUsers = 0;
  let openActionWindows = 0;
  let latestActionWindowEndMs = periodEndMs;
  for (const display of displays) {
    const window = actionWindowFor(toIsoInstant(display.displayedAtMs));
    const windowEndMs = toEpochMs(window.endExclusive);
    if (windowEndMs > generatedAtMs) openActionWindows += 1;
    latestActionWindowEndMs = Math.max(latestActionWindowEndMs, Math.min(windowEndMs, generatedAtMs));
    const completed = (actionsByUser.get(display.userId) ?? []).some(
      (event) => event.occurredAtMs >= display.displayedAtMs && event.occurredAtMs < windowEndMs
    );
    if (completed) completedUsers += 1;
  }

  // Clarity responses: starting-journey responses from cohort users.
  const responsesByUser = groupByUser(normalizedEvents, MEASUREMENT_EVENT_NAMES.clarityResponse);
  let totalResponses = 0;
  let yesResponses = 0;
  for (const user of cohort.users) {
    for (const event of responsesByUser.get(user.userId) ?? []) {
      if (
        event.journeyId !== user.journeyId
        || event.occurredAtMs < user.startedAtMs
        || !CLARITY_RESPONSE_VALUES.has(event.response)
      ) {
        continue;
      }
      totalResponses += 1;
      if (event.response === 'yes') yesResponses += 1;
    }
  }

  // Financial changes: one row per change id reported inside the period.
  const changes = new Map();
  for (const event of [...normalizedEvents].sort(compareEvents)) {
    if (
      event.eventName !== MEASUREMENT_EVENT_NAMES.financialChange
      || event.occurredAtMs < periodStartMs
      || event.occurredAtMs >= periodEndMs
      || !Number.isSafeInteger(event.changeId)
      || typeof event.causedReload !== 'boolean'
      || typeof event.causedPageWideLoading !== 'boolean'
      || changes.has(event.changeId)
    ) {
      continue;
    }
    changes.set(event.changeId, event);
  }
  const changeList = [...changes.values()];
  const reloads = changeList.filter((change) => change.causedReload).length;
  const pageWide = changeList.filter((change) => change.causedPageWideLoading).length;

  const cohortPopulation = (extra = {}) => Object.freeze({ ...cohort.population, ...extra });
  const changePopulation = Object.freeze({ validFinancialChanges: changeList.length });

  const availabilityFor = (metricName, endExclusiveMs = periodEndMs) => classifySourceAvailability({
    outages,
    requiredSources: [...METRIC_DEFINITIONS[metricName].sources],
    rangeStart: period.start,
    rangeEndExclusive: toIsoInstant(endExclusiveMs),
  });

  const rows = [];
  const emit = (metricName, population, endExclusiveMs, build) => {
    const availability = availabilityFor(metricName, endExclusiveMs);
    const base = baseRow({ metricName, period, generatedAtMs, availability, population });
    rows.push(availability.sourceStatus === 'unavailable' ? unavailableRow(base) : build(base));
  };

  emit('first_meaningful_outcome_rate', cohortPopulation(), periodEndMs, (base) => {
    const rate = calculateRate(displays.length, cohort.users.length);
    return rateRow(base, rate, evaluateRateTarget(base.target, rate));
  });

  emit('median_time_to_first_meaningful_outcome', cohortPopulation(), periodEndMs, (base) => {
    const median = calculateMedian(displays.map((display) => display.durationMs));
    return Object.freeze({
      ...base,
      numerator: null,
      denominator: median.count,
      percentageTenths: null,
      percentageDisplay: null,
      durationMs: median.value,
      durationExact: median.count === 0 ? null : { numerator: median.numerator, divisor: median.divisor },
      targetStatus: evaluateMedianTarget(base.target, median),
    });
  });

  emit('clarity_confirmation_rate', cohortPopulation(), periodEndMs, (base) => {
    const rate = calculateRate(yesResponses, totalResponses);
    return rateRow(base, rate, evaluateRateTarget(base.target, rate));
  });

  emit(
    'recommended_action_completion_rate',
    cohortPopulation({ openActionWindows }),
    latestActionWindowEndMs,
    (base) => {
      const rate = calculateRate(completedUsers, displays.length);
      return rateRow(base, rate, evaluateRateTarget(base.target, rate));
    }
  );

  emit('financial_change_reload_rate', changePopulation, periodEndMs, (base) => {
    const rate = calculateRate(reloads, changeList.length);
    return rateRow(base, rate, evaluateRateTarget(base.target, rate));
  });

  emit('financial_change_page_wide_loading_rate', changePopulation, periodEndMs, (base) => {
    const rate = calculateRate(pageWide, changeList.length);
    return rateRow(base, rate, evaluateRateTarget(base.target, rate));
  });

  return Object.freeze(rows);
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import '../helpers/blockingStdout.js';
import {
  METRIC_NAMES,
  actionWindowFor,
  assignNewUserCohort,
  calculateMedian,
  calculateMetricReport,
  calculateRate,
  classifySourceAvailability,
  classifyTarget,
  createPeriod,
  isInstantInPeriod,
  isPeriodCompleted,
  listCompletedPeriods,
  rateAtLeast,
  resolveEarliestJourneys,
  targetFor,
  toLocalDate,
  toLocalWeekStart,
  twentyEightDayPeriodEndingOn,
  weeklyPeriodContaining,
} from '../../src/domain/measurement.js';

// IST is UTC+05:30, so local midnight is 18:30:00Z on the previous UTC date.
const SEC = 1000;

// ---------------------------------------------------------------------------
// Local dates, weeks, and periods
// ---------------------------------------------------------------------------

test('local date flips exactly at IST midnight and matches Intl for the fixed offset', () => {
  assert.equal(toLocalDate('2026-01-11T18:29:59.999Z'), '2026-01-11');
  assert.equal(toLocalDate('2026-01-11T18:30:00.000Z'), '2026-01-12');
  assert.equal(toLocalDate(new Date('2026-06-15T00:00:00.000Z')), '2026-06-15');

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  for (const instant of [
    '2026-03-08T18:29:59.999Z', '2026-03-08T18:30:00.000Z', '2026-10-25T20:00:00.000Z',
    '2027-12-31T18:30:00.000Z', '2028-02-28T18:30:00.000Z', '2028-02-29T18:29:59.999Z',
  ]) {
    assert.equal(toLocalDate(instant), formatter.format(new Date(instant)), instant);
  }
});

test('SQLite timestamps are read as UTC and invalid instants are rejected', () => {
  assert.equal(toLocalDate('2026-01-11 18:30:00'), '2026-01-12');
  assert.throws(() => toLocalDate('2026-02-30T00:00:00.000Z'), TypeError);
  assert.throws(() => toLocalDate('2026-01-11'), TypeError);
  assert.throws(() => toLocalDate(new Date('nope')), TypeError);
  assert.throws(() => toLocalDate(1_700_000_000_000), TypeError);
});

test('weeks start on Monday at IST midnight and end at the next Monday exclusive', () => {
  // 2026-01-12 is a Monday.
  assert.equal(toLocalWeekStart('2026-01-11T18:29:59.999Z'), '2026-01-05');
  assert.equal(toLocalWeekStart('2026-01-11T18:30:00.000Z'), '2026-01-12');

  const sunday = weeklyPeriodContaining('2026-01-11T18:29:59.999Z');
  assert.deepEqual(
    { start: sunday.start, end: sunday.endExclusive, startDate: sunday.startDate, endDate: sunday.endDateInclusive },
    {
      start: '2026-01-04T18:30:00.000Z',
      end: '2026-01-11T18:30:00.000Z',
      startDate: '2026-01-05',
      endDate: '2026-01-11',
    }
  );
  assert.equal(sunday.timeZone, 'Asia/Kolkata');
  assert.equal(sunday.periodType, 'weekly');

  assert.equal(isInstantInPeriod(sunday, '2026-01-04T18:30:00.000Z'), true);
  assert.equal(isInstantInPeriod(sunday, '2026-01-04T18:29:59.999Z'), false);
  assert.equal(isInstantInPeriod(sunday, '2026-01-11T18:29:59.999Z'), true);
  assert.equal(isInstantInPeriod(sunday, '2026-01-11T18:30:00.000Z'), false);
});

test('weekly periods cross month ends, year ends, and the leap day', () => {
  assert.equal(weeklyPeriodContaining('2026-01-31T10:00:00.000Z').startDate, '2026-01-26');
  assert.equal(weeklyPeriodContaining('2026-01-31T10:00:00.000Z').endDateExclusive, '2026-02-02');
  // 2026-12-31 is a Thursday.
  const yearEnd = weeklyPeriodContaining('2026-12-31T10:00:00.000Z');
  assert.deepEqual([yearEnd.startDate, yearEnd.endDateInclusive], ['2026-12-28', '2027-01-03']);
  // 2028-02-29 is a Tuesday in a leap year.
  const leap = weeklyPeriodContaining('2028-02-29T10:00:00.000Z');
  assert.deepEqual([leap.startDate, leap.endDateInclusive], ['2028-02-28', '2028-03-05']);
});

test('createPeriod validates period type, Monday start, calendar date, and time zone', () => {
  assert.equal(createPeriod('weekly', '2026-01-12').startDate, '2026-01-12');
  assert.throws(() => createPeriod('weekly', '2026-01-13'), RangeError);
  assert.throws(() => createPeriod('monthly', '2026-01-12'), TypeError);
  assert.throws(() => createPeriod('28_day', '2026-02-30'), TypeError);
  assert.throws(() => createPeriod('28_day', '2026-01-01', { timeZone: 'UTC' }), RangeError);
});

test('28-day periods contain exactly 28 local dates across month, year, and leap boundaries', () => {
  const ending = (date) => twentyEightDayPeriodEndingOn(date);
  assert.equal(ending('2026-01-10').startDate, '2025-12-14');
  assert.equal(ending('2026-03-01').startDate, '2026-02-02');
  assert.equal(ending('2028-02-29').startDate, '2028-02-02');
  assert.equal(ending('2028-03-01').startDate, '2028-02-03');

  for (const date of ['2026-01-10', '2026-03-01', '2028-02-29', '2026-12-31']) {
    const period = ending(date);
    const dayCount = (Date.parse(period.endExclusive) - Date.parse(period.start)) / 86_400_000;
    assert.equal(dayCount, 28, date);
    assert.equal(period.endDateInclusive, date);
    assert.equal(period.start.endsWith('T18:30:00.000Z'), true);
  }

  const period = ending('2026-03-01');
  assert.equal(period.endExclusive, '2026-03-01T18:30:00.000Z');
  assert.equal(isInstantInPeriod(period, '2026-03-01T18:29:59.999Z'), true);
  assert.equal(isInstantInPeriod(period, '2026-03-01T18:30:00.000Z'), false);
  assert.equal(isInstantInPeriod(period, '2026-02-01T18:29:59.999Z'), false);
  assert.equal(isInstantInPeriod(period, '2026-02-01T18:30:00.000Z'), true);
});

test('isPeriodCompleted is true only at or after the exclusive end', () => {
  const period = createPeriod('weekly', '2026-01-05');
  assert.equal(isPeriodCompleted(period, '2026-01-11T18:29:59.999Z'), false);
  assert.equal(isPeriodCompleted(period, '2026-01-11T18:30:00.000Z'), true);
});

test('seven-day action window ends at the same local time on the seventh following date', () => {
  assert.deepEqual(actionWindowFor('2026-02-24T10:15:30.250Z'), {
    start: '2026-02-24T10:15:30.250Z',
    endExclusive: '2026-03-03T10:15:30.250Z',
  });
  // Leap year: Feb 25 + 7 dates is Mar 3 because Feb 29 exists.
  assert.equal(actionWindowFor('2028-02-25T00:00:00.000Z').endExclusive, '2028-03-03T00:00:00.000Z');
  // One millisecond before IST midnight stays on the same local time.
  assert.equal(actionWindowFor('2026-01-11T18:29:59.999Z').endExclusive, '2026-01-18T18:29:59.999Z');
});

test('listCompletedPeriods returns only completed weekly periods after the checkpoint', () => {
  // The checkpoint is the end of the last stored week (local Monday 2026-01-05 00:00).
  const checkpoint = '2026-01-04T18:30:00.000Z';
  const starts = (now, checkpointEndExclusive = checkpoint) => listCompletedPeriods({
    periodType: 'weekly', now, checkpointEndExclusive,
  }).map((period) => period.startDate);

  assert.deepEqual(starts('2026-01-26T00:00:00.000Z'), ['2026-01-05', '2026-01-12', '2026-01-19']);
  // The week starting 2026-01-12 ends at 2026-01-18T18:30Z: complete at that instant, not a millisecond before.
  assert.deepEqual(starts('2026-01-18T18:30:00.000Z'), ['2026-01-05', '2026-01-12']);
  assert.deepEqual(starts('2026-01-18T18:29:59.999Z'), ['2026-01-05']);
  assert.deepEqual(starts('2026-01-20T00:00:00.000Z', '2026-01-18T18:30:00.000Z'), []);
});

test('listCompletedPeriods rolls 28-day periods daily and seeds from the earliest instant', () => {
  const periods = listCompletedPeriods({
    periodType: '28_day',
    now: '2026-02-01T00:00:00.000Z',
    earliestInstant: '2026-01-01T03:00:00.000Z',
  });
  // First period is 2026-01-01..2026-01-28; its end instant is 2026-01-28 18:30Z.
  assert.deepEqual(
    periods.map((period) => period.endDateInclusive),
    ['2026-01-28', '2026-01-29', '2026-01-30', '2026-01-31']
  );
  assert.equal(periods[0].startDate, '2026-01-01');

  const weekly = listCompletedPeriods({
    periodType: 'weekly',
    now: '2026-01-20T00:00:00.000Z',
    earliestInstant: '2026-01-07T00:00:00.000Z',
  });
  assert.deepEqual(weekly.map((period) => period.startDate), ['2026-01-05', '2026-01-12']);
});

test('listCompletedPeriods validates its seed, checkpoint alignment, and backfill bound', () => {
  const now = '2026-06-01T00:00:00.000Z';
  assert.throws(() => listCompletedPeriods({ periodType: 'weekly', now }), TypeError);
  assert.throws(
    () => listCompletedPeriods({ periodType: 'weekly', now, checkpointEndExclusive: '2026-01-05T00:00:00.000Z' }),
    RangeError
  );
  // 2026-01-06 local midnight is a Tuesday, so it cannot be a weekly checkpoint.
  assert.throws(
    () => listCompletedPeriods({ periodType: 'weekly', now, checkpointEndExclusive: '2026-01-05T18:30:00.000Z' }),
    RangeError
  );
  assert.throws(
    () => listCompletedPeriods({ periodType: '28_day', now, earliestInstant: '2026-01-01T00:00:00.000Z', maxPeriods: 10 }),
    RangeError
  );
});

// ---------------------------------------------------------------------------
// Rates and rounding
// ---------------------------------------------------------------------------

test('calculateRate rounds the unrounded ratio half up to one decimal', () => {
  const display = (n, d) => calculateRate(n, d).percentageDisplay;
  assert.equal(display(1, 3), '33.3');
  assert.equal(display(2, 3), '66.7');
  assert.equal(display(1, 8), '12.5');
  assert.equal(display(1, 16), '6.3'); // 6.25% is exactly halfway between 6.2 and 6.3
  assert.equal(display(1, 2000), '0.1'); // 0.05% is exactly halfway between 0.0 and 0.1
  assert.equal(display(1, 4000), '0.0'); // 0.025% rounds down
  assert.equal(display(0, 5), '0.0');
  assert.equal(display(5, 5), '100.0');
  assert.equal(calculateRate(1, 16).percentageTenths, 63);
});

test('calculateRate reports an empty population as null rather than zero and validates input', () => {
  assert.deepEqual(calculateRate(0, 0), {
    numerator: 0, denominator: 0, percentageTenths: null, percentageDisplay: null,
  });
  assert.throws(() => calculateRate(3, 2), RangeError);
  assert.throws(() => calculateRate(-1, 2), TypeError);
  assert.throws(() => calculateRate(1.5, 2), TypeError);
});

test('rounded display never changes a target comparison', () => {
  // 7496 / 10000 = 74.96%: displays as 75.0 but is below a 75% target.
  const rate = calculateRate(7496, 10_000);
  assert.equal(rate.percentageDisplay, '75.0');
  assert.equal(rateAtLeast(7496, 10_000, 75), false);
  assert.equal(rateAtLeast(7500, 10_000, 75), true);
  assert.equal(rateAtLeast(0, 0, 0), false);
});

test('calculateRate and target comparison stay exact for large safe integers', () => {
  const big = 9_007_199_254_740_990;
  assert.equal(calculateRate(big, big).percentageDisplay, '100.0');
  assert.equal(rateAtLeast(big - 1, big, 100), false);
});

// ---------------------------------------------------------------------------
// Medians
// ---------------------------------------------------------------------------

test('calculateMedian picks the middle of an odd sorted sample', () => {
  const median = calculateMedian([90, 10, 50]);
  assert.deepEqual(median, { count: 3, numerator: 50, divisor: 1, value: 50 });
});

test('calculateMedian averages the two middle values of an even sample', () => {
  assert.deepEqual(calculateMedian([40, 10, 30, 20]), { count: 4, numerator: 50, divisor: 2, value: 25 });
  // The mean of 10 and 21 is 15.5 ms: kept exactly, displayed half up.
  assert.deepEqual(calculateMedian([21, 10]), { count: 2, numerator: 31, divisor: 2, value: 16 });
  assert.deepEqual(calculateMedian([7]), { count: 1, numerator: 7, divisor: 1, value: 7 });
});

test('calculateMedian handles empty samples without mutating the input', () => {
  assert.deepEqual(calculateMedian([]), { count: 0, numerator: null, divisor: null, value: null });
  const input = [3, 1, 2];
  calculateMedian(input);
  assert.deepEqual(input, [3, 1, 2]);
  assert.throws(() => calculateMedian([1, -1]), TypeError);
  assert.throws(() => calculateMedian([1.5]), TypeError);
});

// ---------------------------------------------------------------------------
// Target classification
// ---------------------------------------------------------------------------

test('classifyTarget separates insufficient data from met and not met', () => {
  assert.equal(classifyTarget({ sampleSize: 99, minimumSample: 100, meetsTarget: true }), 'insufficient_data');
  assert.equal(classifyTarget({ sampleSize: 100, minimumSample: 100, meetsTarget: true }), 'met');
  assert.equal(classifyTarget({ sampleSize: 100, minimumSample: 100, meetsTarget: false }), 'not_met');
  assert.equal(classifyTarget({ sampleSize: 0, minimumSample: 1, meetsTarget: false }), 'insufficient_data');
});

test('targets apply to 28-day cohort metrics only and to change metrics in both period types', () => {
  assert.equal(targetFor('first_meaningful_outcome_rate', 'weekly'), null);
  assert.deepEqual(targetFor('first_meaningful_outcome_rate', '28_day'), {
    comparator: 'at_least', percent: 75, minimumSample: 100,
  });
  assert.deepEqual(targetFor('median_time_to_first_meaningful_outcome', '28_day'), {
    comparator: 'at_most_ms', maxMs: 120_000, minimumSample: 100,
  });
  assert.deepEqual(targetFor('clarity_confirmation_rate', '28_day'), {
    comparator: 'at_least', percent: 80, minimumSample: 50,
  });
  assert.deepEqual(targetFor('recommended_action_completion_rate', '28_day'), {
    comparator: 'at_least', percent: 40, minimumSample: 100,
  });
  for (const metric of ['financial_change_reload_rate', 'financial_change_page_wide_loading_rate']) {
    for (const periodType of ['weekly', '28_day']) {
      assert.deepEqual(targetFor(metric, periodType), { comparator: 'at_most', percent: 0, minimumSample: 1 });
    }
  }
  assert.throws(() => targetFor('unknown', 'weekly'), RangeError);
});

// ---------------------------------------------------------------------------
// Source-failure classification
// ---------------------------------------------------------------------------

const RANGE = Object.freeze({ rangeStart: '2026-01-10T00:00:00.000Z', rangeEndExclusive: '2026-01-20T00:00:00.000Z' });
const outage = (sourceName, unavailableStart, unavailableEndExclusive) => ({ sourceName, unavailableStart, unavailableEndExclusive });

test('source availability is complete when no required source overlaps the range', () => {
  const result = classifySourceAvailability({
    ...RANGE,
    requiredSources: ['guided_journeys'],
    outages: [
      outage('guided_journeys', '2026-01-09T00:00:00.000Z', '2026-01-10T00:00:00.000Z'), // ends at range start
      outage('guided_journeys', '2026-01-20T00:00:00.000Z', '2026-01-21T00:00:00.000Z'), // starts at range end
      outage('financial_record_changes', '2026-01-12T00:00:00.000Z', '2026-01-13T00:00:00.000Z'), // not required
    ],
  });
  assert.equal(result.sourceStatus, 'complete');
  assert.deepEqual(result.unavailableSources, []);
  assert.equal(result.unavailableSource, null);
});

test('any overlapping outage marks the metric unavailable with the clipped, merged range', () => {
  const result = classifySourceAvailability({
    ...RANGE,
    requiredSources: ['guided_journeys', 'product_measurement_events'],
    outages: [
      outage('guided_journeys', '2026-01-08T00:00:00.000Z', '2026-01-11T00:00:00.000Z'),
      outage('guided_journeys', '2026-01-10T12:00:00.000Z', '2026-01-12T00:00:00.000Z'),
      outage('guided_journeys', '2026-01-15T00:00:00.000Z', '2026-01-25T00:00:00.000Z'),
      outage('product_measurement_events', '2026-01-14T00:00:00.000Z', '2026-01-14T00:00:00.001Z'),
    ],
  });
  assert.equal(result.sourceStatus, 'unavailable');
  assert.deepEqual(result.unavailableSources, [
    { sourceName: 'guided_journeys', start: '2026-01-10T00:00:00.000Z', endExclusive: '2026-01-12T00:00:00.000Z' },
    { sourceName: 'guided_journeys', start: '2026-01-15T00:00:00.000Z', endExclusive: '2026-01-20T00:00:00.000Z' },
    { sourceName: 'product_measurement_events', start: '2026-01-14T00:00:00.000Z', endExclusive: '2026-01-14T00:00:00.001Z' },
  ]);
  assert.equal(result.unavailableSource, 'guided_journeys,product_measurement_events');
  assert.equal(result.unavailableStart, '2026-01-10T00:00:00.000Z');
  assert.equal(result.unavailableEndExclusive, '2026-01-20T00:00:00.000Z');
});

test('source availability rejects unknown sources and malformed outage ranges', () => {
  assert.throws(() => classifySourceAvailability({ ...RANGE, requiredSources: ['payments'] }), RangeError);
  assert.throws(() => classifySourceAvailability({ ...RANGE, requiredSources: [] }), TypeError);
  assert.throws(
    () => classifySourceAvailability({
      ...RANGE, requiredSources: ['guided_journeys'], outages: [outage('payments', RANGE.rangeStart, RANGE.rangeEndExclusive)],
    }),
    RangeError
  );
  assert.throws(
    () => classifySourceAvailability({
      ...RANGE, requiredSources: ['guided_journeys'], outages: [outage('guided_journeys', RANGE.rangeEndExclusive, RANGE.rangeStart)],
    }),
    RangeError
  );
});

// ---------------------------------------------------------------------------
// Cohort assignment
// ---------------------------------------------------------------------------

const journey = (id, userId, startedAt, measurementEligible = true) => ({ id, userId, startedAt, measurementEligible });
const JAN = createPeriod('28_day', '2026-01-01'); // 2025-12-31T18:30Z .. 2026-01-28T18:30Z

test('a user appears once, in the period of their earliest journey start', () => {
  const journeys = [
    journey(3, 1, '2026-01-20T05:00:00.000Z'),
    journey(1, 1, '2026-01-05T05:00:00.000Z'),
    journey(2, 1, '2026-01-06T05:00:00.000Z'),
    journey(4, 2, '2026-02-02T05:00:00.000Z'),
  ];
  const cohort = assignNewUserCohort({ journeys, period: JAN });
  assert.deepEqual(cohort.users.map((user) => [user.userId, user.journeyId]), [[1, 1]]);
  assert.equal(cohort.population.newUsers, 1);
  assert.equal(resolveEarliestJourneys(journeys).get(2).id, 4);
});

test('cohort period edges are inclusive at the start and exclusive at the end', () => {
  const cohort = assignNewUserCohort({
    period: JAN,
    journeys: [
      journey(1, 1, '2025-12-31T18:29:59.999Z'),
      journey(2, 2, '2025-12-31T18:30:00.000Z'),
      journey(3, 3, '2026-01-28T18:29:59.999Z'),
      journey(4, 4, '2026-01-28T18:30:00.000Z'),
    ],
  });
  assert.deepEqual(cohort.users.map((user) => user.userId), [2, 3]);
});

test('an earlier non-eligible journey keeps a returning user out of the cohort', () => {
  const cohort = assignNewUserCohort({
    period: JAN,
    journeys: [
      journey(1, 7, '2025-11-01T05:00:00.000Z', false),
      journey(2, 7, '2026-01-10T05:00:00.000Z', true),
    ],
  });
  assert.equal(cohort.users.length, 0);
  assert.equal(cohort.population.newUsers, 0);
});

test('a non-eligible earliest journey is counted as excluded, not as a measurable user', () => {
  const cohort = assignNewUserCohort({
    period: JAN,
    journeys: [
      journey(1, 7, '2026-01-10T05:00:00.000Z', false),
      journey(2, 7, '2026-01-12T05:00:00.000Z', true),
    ],
  });
  assert.equal(cohort.users.length, 0);
  assert.deepEqual(cohort.population, {
    newUsers: 1, measurableUsers: 0, excludedNotMeasurementEligible: 1, excludedOptedOut: 0,
  });
});

test('identical start instants resolve to the lowest journey id', () => {
  const same = '2026-01-10T05:00:00.000Z';
  const cohort = assignNewUserCohort({ period: JAN, journeys: [journey(9, 1, same), journey(4, 1, same)] });
  assert.equal(cohort.users[0].journeyId, 4);
});

test('users who opted out at or before the period end are excluded; later opt-outs are not', () => {
  const journeys = [
    journey(1, 1, '2026-01-05T05:00:00.000Z'),
    journey(2, 2, '2026-01-05T05:00:00.000Z'),
    journey(3, 3, '2026-01-05T05:00:00.000Z'),
    journey(4, 4, '2026-01-05T05:00:00.000Z'),
  ];
  const consents = [
    { userId: 1, analyticsEnabled: false, analyticsChangedAt: '2026-01-10T00:00:00.000Z' },
    { userId: 2, analyticsEnabled: false, analyticsChangedAt: '2026-02-10T00:00:00.000Z' },
    { userId: 3, analyticsEnabled: false, analyticsChangedAt: null },
    { userId: 4, analyticsEnabled: true, analyticsChangedAt: '2026-01-06T00:00:00.000Z' },
  ];
  const cohort = assignNewUserCohort({ journeys, period: JAN, consents });
  assert.deepEqual(cohort.users.map((user) => user.userId), [2, 4]);
  assert.equal(cohort.population.excludedOptedOut, 2);
});

test('an empty cohort is empty rather than an error', () => {
  const cohort = assignNewUserCohort({ journeys: [], period: JAN });
  assert.deepEqual(cohort.users, []);
  assert.equal(cohort.population.newUsers, 0);
});

test('cohort assignment rejects duplicate journey ids and malformed input', () => {
  assert.throws(
    () => assignNewUserCohort({ period: JAN, journeys: [journey(1, 1, '2026-01-05T05:00:00.000Z'), journey(1, 2, '2026-01-05T05:00:00.000Z')] }),
    RangeError
  );
  assert.throws(() => assignNewUserCohort({ period: JAN, journeys: [{ id: 1, userId: 1, startedAt: 'bad', measurementEligible: true }] }), TypeError);
  assert.throws(() => assignNewUserCohort({ period: JAN, journeys: [{ id: 1, userId: 1, startedAt: '2026-01-05T05:00:00.000Z' }] }), TypeError);
});

// ---------------------------------------------------------------------------
// Metric report
// ---------------------------------------------------------------------------

const START = Date.parse('2026-01-05T04:00:00.000Z');
const GENERATED_AT = '2026-02-10T00:00:00.000Z';
let eventSequence = 0;
const event = (userId, eventName, occurredAtMs, extra = {}) => ({
  id: ++eventSequence, userId, eventName, occurredAt: new Date(occurredAtMs).toISOString(), ...extra,
});

/** Users 1..count start journeys at START; `displayDurations[i]` (ms) displays the first outcome for user i+1. */
function buildCohort(count, displayDurations = []) {
  const journeys = [];
  const events = [];
  for (let userId = 1; userId <= count; userId += 1) {
    journeys.push(journey(userId, userId, new Date(START).toISOString()));
    const duration = displayDurations[userId - 1];
    if (duration != null) {
      events.push(event(userId, 'first_outcome_displayed', START + duration, { journeyId: userId }));
    }
  }
  return { journeys, events };
}

const metricsOf = (report) => Object.fromEntries(report.map((row) => [row.metricName, row]));
const report28 = (input) => metricsOf(calculateMetricReport({ period: JAN, generatedAt: GENERATED_AT, ...input }));

test('a report has one row per metric with full required metadata', () => {
  const { journeys, events } = buildCohort(4, [60 * SEC, 60 * SEC, null, null]);
  const report = calculateMetricReport({ period: JAN, generatedAt: GENERATED_AT, journeys, events });
  assert.deepEqual(report.map((row) => row.metricName), [...METRIC_NAMES]);
  for (const row of report) {
    assert.equal(row.periodType, '28_day');
    assert.equal(row.periodStart, JAN.start);
    assert.equal(row.periodEndExclusive, JAN.endExclusive);
    assert.equal(row.periodStartDate, '2026-01-01');
    assert.equal(row.periodEndDateInclusive, '2026-01-28');
    assert.equal(row.timeZone, 'Asia/Kolkata');
    assert.equal(row.generatedAt, GENERATED_AT);
    assert.equal(row.sourceStatus, 'complete');
    assert.equal(typeof row.populationDefinition, 'string');
    assert.equal(row.populationDefinition.length > 0, true);
    for (const field of ['numerator', 'denominator', 'percentageTenths', 'durationMs', 'targetStatus', 'target', 'population']) {
      assert.equal(field in row, true, `${row.metricName}.${field}`);
    }
  }
  const outcome = metricsOf(report).first_meaningful_outcome_rate;
  assert.deepEqual([outcome.numerator, outcome.denominator, outcome.percentageDisplay], [2, 4, '50.0']);
  assert.deepEqual(outcome.population, {
    newUsers: 4, measurableUsers: 4, excludedNotMeasurementEligible: 0, excludedOptedOut: 0,
  });
});

test('metrics are calculated only for completed periods', () => {
  assert.throws(
    () => calculateMetricReport({ period: JAN, generatedAt: '2026-01-28T18:29:59.999Z' }),
    RangeError
  );
  assert.doesNotThrow(() => calculateMetricReport({ period: JAN, generatedAt: '2026-01-28T18:30:00.000Z' }));
});

test('the module reads no process clock', () => {
  const source = readFileSync(new URL('../../src/domain/measurement.js', import.meta.url), 'utf8');
  assert.equal(/Date\.now\(/.test(source), false);
  assert.equal(/new Date\(\s*\)/.test(source), false);
  assert.equal(/\bimport\b[^;]*(db|repositor)/i.test(source), false);
});

test('first meaningful outcome rate: boundary at exactly 75 percent of 100 users is met', () => {
  const durations = Array.from({ length: 100 }, (_, index) => (index < 75 ? 60 * SEC : null));
  const { journeys, events } = buildCohort(100, durations);
  const row = report28({ journeys, events }).first_meaningful_outcome_rate;
  assert.deepEqual([row.numerator, row.denominator, row.percentageDisplay, row.targetStatus], [75, 100, '75.0', 'met']);
});

test('first meaningful outcome rate: 74 of 100 is not met and 99 users is insufficient data', () => {
  const missed = buildCohort(100, Array.from({ length: 100 }, (_, index) => (index < 74 ? 1 : null)));
  assert.equal(report28(missed).first_meaningful_outcome_rate.targetStatus, 'not_met');

  const small = buildCohort(99, Array.from({ length: 99 }, () => 1));
  const row = report28(small).first_meaningful_outcome_rate;
  assert.deepEqual([row.numerator, row.denominator, row.targetStatus], [99, 99, 'insufficient_data']);
});

test('outcome displays only count for the starting journey and not before it began', () => {
  const journeys = [journey(10, 1, '2026-01-05T04:00:00.000Z'), journey(11, 1, '2026-01-06T04:00:00.000Z')];
  const events = [
    event(1, 'first_outcome_displayed', START + 1000, { journeyId: 11 }), // later journey
    event(1, 'first_outcome_displayed', START - 1000, { journeyId: 10 }), // before start
  ];
  const row = report28({ journeys, events }).first_meaningful_outcome_rate;
  assert.deepEqual([row.numerator, row.denominator], [0, 1]);
});

test('an empty cohort yields null percentages and insufficient data, not zero', () => {
  const rows = report28({});
  const outcome = rows.first_meaningful_outcome_rate;
  assert.deepEqual(
    [outcome.numerator, outcome.denominator, outcome.percentageTenths, outcome.percentageDisplay, outcome.targetStatus],
    [0, 0, null, null, 'insufficient_data']
  );
  const median = rows.median_time_to_first_meaningful_outcome;
  assert.deepEqual([median.durationMs, median.durationExact, median.denominator, median.targetStatus], [null, null, 0, 'insufficient_data']);
});

test('median time: exact boundary at 120 seconds is met; a half millisecond above is not met', () => {
  const at120 = buildCohort(100, Array.from({ length: 100 }, (_, index) => (index < 50 ? 100_000 : 140_000)));
  const met = report28(at120).median_time_to_first_meaningful_outcome;
  assert.deepEqual([met.durationMs, met.denominator, met.targetStatus], [120_000, 100, 'met']);
  assert.deepEqual(met.durationExact, { numerator: 240_000, divisor: 2 });

  const above = buildCohort(100, Array.from({ length: 100 }, (_, index) => (index < 50 ? 100_000 : 140_001)));
  const missed = report28(above).median_time_to_first_meaningful_outcome;
  assert.deepEqual([missed.durationMs, missed.targetStatus], [120_001, 'not_met']);
  assert.deepEqual(missed.durationExact, { numerator: 240_001, divisor: 2 });
});

test('median time: odd count uses the middle duration and fewer than 100 durations is insufficient', () => {
  const odd = buildCohort(101, Array.from({ length: 101 }, (_, index) => (index + 1) * SEC));
  const row = report28(odd).median_time_to_first_meaningful_outcome;
  assert.deepEqual([row.durationMs, row.denominator, row.targetStatus], [51 * SEC, 101, 'met']);

  const small = buildCohort(99, Array.from({ length: 99 }, () => SEC));
  assert.equal(report28(small).median_time_to_first_meaningful_outcome.targetStatus, 'insufficient_data');
});

test('median time is measured from the journey start to the earliest display', () => {
  const journeys = [journey(1, 1, '2026-01-05 04:00:00')];
  const events = [
    event(1, 'first_outcome_displayed', START + 90_500, { journeyId: 1 }),
    event(1, 'first_outcome_displayed', START + 30_250, { journeyId: 1 }),
  ];
  assert.equal(report28({ journeys, events }).median_time_to_first_meaningful_outcome.durationMs, 30_250);
});

test('clarity rate: 40 of 50 submitted responses is met, 39 of 50 is not met, 49 is insufficient', () => {
  const build = (yes, total) => {
    const { journeys, events } = buildCohort(total);
    for (let userId = 1; userId <= total; userId += 1) {
      events.push(event(userId, 'clarity_response', START + SEC, {
        journeyId: userId, response: userId <= yes ? 'yes' : (userId % 2 ? 'partly' : 'no'),
      }));
    }
    return report28({ journeys, events }).clarity_confirmation_rate;
  };
  const met = build(40, 50);
  assert.deepEqual([met.numerator, met.denominator, met.percentageDisplay, met.targetStatus], [40, 50, '80.0', 'met']);
  assert.equal(build(39, 50).targetStatus, 'not_met');
  const small = build(49, 49);
  assert.deepEqual([small.numerator, small.denominator, small.targetStatus], [49, 49, 'insufficient_data']);
});

test('clarity responses count per submission from the starting journey and ignore invalid values', () => {
  const journeys = [journey(1, 1, '2026-01-05T04:00:00.000Z'), journey(2, 1, '2026-01-06T04:00:00.000Z')];
  const events = [
    event(1, 'clarity_response', START + SEC, { journeyId: 1, response: 'yes' }),
    event(1, 'clarity_response', START + 2 * SEC, { journeyId: 1, response: 'no' }),
    event(1, 'clarity_response', START + 3 * SEC, { journeyId: 1, response: 'maybe' }),
    event(1, 'clarity_response', START + 4 * SEC, { journeyId: 2, response: 'yes' }),
    event(99, 'clarity_response', START + SEC, { journeyId: 5, response: 'yes' }), // not a cohort user
  ];
  const row = report28({ journeys, events }).clarity_confirmation_rate;
  assert.deepEqual([row.numerator, row.denominator], [1, 2]);
});

test('action completion counts one per user inside the seven-day window only', () => {
  const display = START + 10 * SEC;
  const windowEnd = Date.parse('2026-01-12T04:00:10.000Z');
  const { journeys, events } = buildCohort(6, [10 * SEC, 10 * SEC, 10 * SEC, 10 * SEC, 10 * SEC, null]);
  const action = (userId, at, extra = {}) => event(userId, 'recommended_action_completed', at, { journeyId: userId, ...extra });
  events.push(
    action(1, display + SEC), action(1, display + 2 * SEC), action(1, display + 3 * SEC), // one user, three actions
    action(2, display), // exactly at the display instant: inside
    action(3, windowEnd - 1), // last millisecond: inside
    action(4, windowEnd), // window end is exclusive
    action(5, display - 1), // before the display
    action(6, display + SEC) // user 6 never displayed an outcome, so is not in the denominator
  );
  const row = report28({ journeys, events }).recommended_action_completion_rate;
  assert.deepEqual([row.numerator, row.denominator], [3, 5]);
  assert.equal(row.population.openActionWindows, 0);
});

test('action completion target: 40 of 100 is met and 39 of 100 is not met', () => {
  const build = (completed) => {
    const { journeys, events } = buildCohort(100, Array.from({ length: 100 }, () => SEC));
    for (let userId = 1; userId <= completed; userId += 1) {
      events.push(event(userId, 'recommended_action_completed', START + 2 * SEC, { journeyId: userId }));
    }
    return report28({ journeys, events }).recommended_action_completion_rate;
  };
  assert.equal(build(40).targetStatus, 'met');
  assert.equal(build(39).targetStatus, 'not_met');
});

test('open action windows at generation time are counted in the population', () => {
  const { journeys, events } = buildCohort(1, [SEC]);
  const row = metricsOf(calculateMetricReport({
    period: JAN, generatedAt: '2026-01-28T18:30:00.000Z', journeys, events,
  })).recommended_action_completion_rate;
  assert.equal(row.population.openActionWindows, 0); // window ended 2026-01-12
  const late = createPeriod('weekly', '2026-01-05');
  const lateJourney = [journey(1, 1, '2026-01-11T10:00:00.000Z')];
  const lateEvents = [event(1, 'first_outcome_displayed', Date.parse('2026-01-11T10:00:05.000Z'), { journeyId: 1 })];
  const open = metricsOf(calculateMetricReport({
    period: late, generatedAt: '2026-01-11T18:30:00.000Z', journeys: lateJourney, events: lateEvents,
  })).recommended_action_completion_rate;
  assert.equal(open.population.openActionWindows, 1);
});

const WEEK = createPeriod('weekly', '2026-01-05'); // 2026-01-04T18:30Z .. 2026-01-11T18:30Z
const WEEK_GENERATED = '2026-01-12T00:00:00.000Z';
const change = (changeId, causedReload, causedPageWideLoading, at = '2026-01-06T05:00:00.000Z') => event(
  1, 'financial_change_ui', Date.parse(at), { changeId, causedReload, causedPageWideLoading }
);
const weekReport = (events, extra = {}) => metricsOf(calculateMetricReport({
  period: WEEK, generatedAt: WEEK_GENERATED, events, ...extra,
}));

test('financial change rates: zero reloads meets the zero target and any reload misses it', () => {
  const clean = weekReport([change(1, false, false), change(2, false, false)]);
  assert.deepEqual(
    [clean.financial_change_reload_rate.numerator, clean.financial_change_reload_rate.denominator, clean.financial_change_reload_rate.targetStatus],
    [0, 2, 'met']
  );
  assert.equal(clean.financial_change_page_wide_loading_rate.targetStatus, 'met');

  const dirty = weekReport([change(1, true, false), change(2, false, true), change(3, false, false), change(4, false, false)]);
  assert.deepEqual(
    [dirty.financial_change_reload_rate.percentageDisplay, dirty.financial_change_reload_rate.targetStatus],
    ['25.0', 'not_met']
  );
  assert.deepEqual(
    [dirty.financial_change_page_wide_loading_rate.numerator, dirty.financial_change_page_wide_loading_rate.targetStatus],
    [1, 'not_met']
  );
});

test('financial change rates have no target status without a valid change', () => {
  const row = weekReport([]).financial_change_reload_rate;
  assert.deepEqual([row.numerator, row.denominator, row.percentageTenths, row.targetStatus], [0, 0, null, 'insufficient_data']);
});

test('financial changes are deduplicated by change id and limited to the period', () => {
  const rows = weekReport([
    change(1, true, false),
    change(1, false, false, '2026-01-07T05:00:00.000Z'), // duplicate id: earliest report wins
    change(2, false, false, '2026-01-04T18:29:59.999Z'), // before the period
    change(3, false, false, '2026-01-11T18:30:00.000Z'), // at the exclusive end
    change(4, false, false, '2026-01-11T18:29:59.999Z'), // last millisecond inside
    { ...change(5, false, false), causedReload: null }, // malformed flag is ignored
  ]);
  assert.deepEqual(
    [rows.financial_change_reload_rate.numerator, rows.financial_change_reload_rate.denominator],
    [1, 2]
  );
});

test('weekly cohort metrics carry no target', () => {
  const { journeys, events } = buildCohort(3, [SEC, SEC, SEC]);
  const rows = metricsOf(calculateMetricReport({ period: WEEK, generatedAt: WEEK_GENERATED, journeys, events }));
  for (const name of ['first_meaningful_outcome_rate', 'median_time_to_first_meaningful_outcome', 'clarity_confirmation_rate', 'recommended_action_completion_rate']) {
    assert.equal(rows[name].target, null, name);
    assert.equal(rows[name].targetStatus, null, name);
  }
  assert.equal(rows.first_meaningful_outcome_rate.numerator, 3);
});

// Source failures ------------------------------------------------------------

const COHORT_METRICS = [
  'first_meaningful_outcome_rate', 'median_time_to_first_meaningful_outcome',
  'clarity_confirmation_rate', 'recommended_action_completion_rate',
];
const CHANGE_METRICS = ['financial_change_reload_rate', 'financial_change_page_wide_loading_rate'];

function assertUnavailable(row, source, start, end) {
  assert.equal(row.sourceStatus, 'unavailable', row.metricName);
  assert.equal(row.targetStatus, null, row.metricName);
  for (const field of ['numerator', 'denominator', 'percentageTenths', 'percentageDisplay', 'durationMs']) {
    assert.equal(row[field], null, `${row.metricName}.${field}`);
  }
  assert.equal(row.unavailableSource, source);
  assert.equal(row.unavailableStart, start);
  assert.equal(row.unavailableEndExclusive, end);
}

test('a journey-source outage makes only the four cohort metrics unavailable', () => {
  const { journeys, events } = buildCohort(2, [SEC, SEC]);
  const rows = report28({
    journeys,
    events: [...events, event(1, 'financial_change_ui', START, { changeId: 1, causedReload: false, causedPageWideLoading: false })],
    outages: [outage('guided_journeys', '2026-01-10T00:00:00.000Z', '2026-01-11T00:00:00.000Z')],
  });
  for (const name of COHORT_METRICS) {
    assertUnavailable(rows[name], 'guided_journeys', '2026-01-10T00:00:00.000Z', '2026-01-11T00:00:00.000Z');
  }
  for (const name of CHANGE_METRICS) {
    assert.equal(rows[name].sourceStatus, 'complete');
    assert.deepEqual([rows[name].numerator, rows[name].denominator], [0, 1]);
    assert.equal(rows[name].unavailableSource, null);
  }
});

test('a change-receipt outage makes only the two change metrics unavailable', () => {
  const { journeys, events } = buildCohort(2, [SEC, SEC]);
  const rows = report28({
    journeys,
    events,
    outages: [outage('financial_record_changes', '2025-12-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')],
  });
  for (const name of CHANGE_METRICS) {
    assertUnavailable(rows[name], 'financial_record_changes', JAN.start, '2026-01-02T00:00:00.000Z');
  }
  for (const name of COHORT_METRICS) assert.equal(rows[name].sourceStatus, 'complete');
  assert.equal(rows.first_meaningful_outcome_rate.numerator, 2);
});

test('an event-source outage affects every metric, and overlapping outages are all reported', () => {
  const rows = report28({
    outages: [
      outage('product_measurement_events', '2026-01-10T00:00:00.000Z', '2026-01-12T00:00:00.000Z'),
      outage('guided_journeys', '2026-01-11T00:00:00.000Z', '2026-01-13T00:00:00.000Z'),
    ],
  });
  for (const name of METRIC_NAMES) assert.equal(rows[name].sourceStatus, 'unavailable', name);
  assert.equal(rows.first_meaningful_outcome_rate.unavailableSource, 'guided_journeys,product_measurement_events');
  assert.equal(rows.first_meaningful_outcome_rate.unavailableSources.length, 2);
  assertUnavailable(
    rows.financial_change_reload_rate, 'product_measurement_events',
    '2026-01-10T00:00:00.000Z', '2026-01-12T00:00:00.000Z'
  );
});

test('outages outside the period leave every metric complete', () => {
  const rows = report28({
    outages: [
      outage('product_measurement_events', '2025-12-01T00:00:00.000Z', JAN.start),
      outage('guided_journeys', JAN.endExclusive, '2026-02-05T00:00:00.000Z'),
    ],
  });
  for (const name of METRIC_NAMES) assert.equal(rows[name].sourceStatus, 'complete', name);
});

test('an event outage inside an action window after the period affects only the action metric', () => {
  const journeys = [journey(1, 1, '2026-01-28T10:00:00.000Z')];
  const events = [event(1, 'first_outcome_displayed', Date.parse('2026-01-28T10:00:05.000Z'), { journeyId: 1 })];
  const rows = report28({
    journeys,
    events,
    outages: [outage('product_measurement_events', '2026-02-02T00:00:00.000Z', '2026-02-03T00:00:00.000Z')],
  });
  assertUnavailable(
    rows.recommended_action_completion_rate, 'product_measurement_events',
    '2026-02-02T00:00:00.000Z', '2026-02-03T00:00:00.000Z'
  );
  for (const name of METRIC_NAMES.filter((metric) => metric !== 'recommended_action_completion_rate')) {
    assert.equal(rows[name].sourceStatus, 'complete', name);
  }
});

test('report input is validated', () => {
  assert.throws(() => calculateMetricReport({ period: { periodType: 'daily' }, generatedAt: GENERATED_AT }), TypeError);
  assert.throws(() => calculateMetricReport({ period: JAN, generatedAt: GENERATED_AT, events: [{ userId: 1 }] }), TypeError);
  assert.throws(() => calculateMetricReport({ period: JAN, generatedAt: 'tomorrow' }), TypeError);
});

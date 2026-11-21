import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {
  METRIC_NAMES,
  actionWindowFor,
  assignNewUserCohort,
  calculateMetricReport,
  createPeriod,
  isInstantInPeriod,
  isPeriodCompleted,
  listCompletedPeriods,
  toLocalDate,
  toLocalWeekStart,
  twentyEightDayPeriodEndingOn,
  weeklyPeriodContaining,
} from '../../src/domain/measurement.js';

/**
 * Property 28: Local reporting periods and cohorts have exact boundaries.
 *
 * The reference model below never calls the module's helpers. Every expected
 * value is derived from a local day number plus a millisecond time of day:
 * - civil dates come from Howard Hinnant's days-from-civil algorithms;
 * - weekdays come from Sakamoto's algorithm;
 * - instants are `localDay * 86_400_000 + timeOfDay - 05:30`, because
 *   Asia/Kolkata is a fixed +05:30 zone with no offset changes;
 * - an Intl.DateTimeFormat oracle for Asia/Kolkata checks the model itself.
 *
 * Decisions from task 16.1 that the model follows:
 * 1. 28-day periods are rolling (one ends on every local date).
 * 2. Cohort metric targets exist only on 28-day periods.
 * 4. A first-outcome event stored for the starting journey is the same-session condition.
 * 7. Action windows still open at generation time are counted, not hidden.
 */

const NUM_RUNS = 200;
const DAY = 86_400_000;
const IST_OFFSET = 19_800_000;
const ZONE = 'Asia/Kolkata';

// ---------------------------------------------------------------------------
// Independent reference model
// ---------------------------------------------------------------------------

function daysFromCivil(year, month, day) {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(dayNumber) {
  const z = dayNumber + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { year: yoe + era * 400 + (month <= 2 ? 1 : 0), month, day };
}

function dateText(dayNumber) {
  const { year, month, day } = civilFromDays(dayNumber);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Monday = 0 ... Sunday = 6 (Sakamoto's algorithm, Sunday = 0 internally). */
function weekdayMondayZero(dayNumber) {
  const { year, month, day } = civilFromDays(dayNumber);
  const table = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
  const y = month < 3 ? year - 1 : year;
  const sundayZero = (y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) + table[month - 1] + day) % 7;
  return (sundayZero + 6) % 7;
}

const mondayOf = (dayNumber) => dayNumber - weekdayMondayZero(dayNumber);
const localInstantMs = (dayNumber, timeOfDayMs = 0) => dayNumber * DAY + timeOfDayMs - IST_OFFSET;
const iso = (ms) => new Date(ms).toISOString();
const isoAt = (dayNumber, timeOfDayMs = 0) => iso(localInstantMs(dayNumber, timeOfDayMs));

function sqliteText(ms) {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

const intlParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  fractionalSecondDigits: 3,
  hourCycle: 'h23',
});

/** Local calendar date and time of day reported by the platform for Asia/Kolkata. */
function intlLocal(ms) {
  const parts = Object.fromEntries(intlParts.formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    timeOfDayMs:
      ((Number(parts.hour) * 60 + Number(parts.minute)) * 60 + Number(parts.second)) * 1000
      + Number(parts.fractionalSecond),
  };
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const FIRST_DAY = daysFromCivil(2000, 1, 1);
const LAST_DAY = daysFromCivil(2100, 12, 31);

/** Month ends, year ends, leap days, non-leap century, and Monday/Sunday edges. */
const SPECIAL_DAYS = [
  [2000, 2, 29], [2000, 3, 1], [2023, 2, 28], [2023, 3, 1], [2023, 12, 31], [2024, 1, 1],
  [2024, 2, 22], [2024, 2, 23], [2024, 2, 28], [2024, 2, 29], [2024, 3, 1], [2024, 12, 29],
  [2024, 12, 30], [2024, 12, 31], [2025, 1, 1], [2025, 12, 28], [2025, 12, 29], [2025, 12, 31],
  [2026, 1, 1], [2026, 1, 11], [2026, 1, 12], [2026, 1, 31], [2026, 2, 1], [2026, 4, 30],
  [2026, 5, 1], [2028, 2, 29], [2100, 2, 21], [2100, 2, 28], [2100, 3, 1], [2100, 12, 31],
].map(([year, month, day]) => daysFromCivil(year, month, day));

const dayArbitrary = fc.oneof(
  { weight: 2, arbitrary: fc.constantFrom(...SPECIAL_DAYS) },
  { weight: 3, arbitrary: fc.integer({ min: FIRST_DAY, max: LAST_DAY }) },
);

/** Milliseconds into the local day: midnight edges, UTC-midnight (05:30) edges, and anywhere. */
const timeOfDayArbitrary = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(0, 1, 999, 1000, DAY - 1, DAY - 1000, DAY - 1001, IST_OFFSET - 1, IST_OFFSET, IST_OFFSET + 1) },
  { weight: 2, arbitrary: fc.integer({ min: 0, max: DAY - 1 }) },
);

const periodTypeArbitrary = fc.constantFrom('weekly', '28_day');
const periodLength = (periodType) => (periodType === 'weekly' ? 7 : 28);

function periodStartDayFor(periodType, dayNumber) {
  return periodType === 'weekly' ? mondayOf(dayNumber) : dayNumber;
}

function assertPeriodShape(period, periodType, startDay) {
  const length = periodLength(periodType);
  assert.equal(period.periodType, periodType);
  assert.equal(period.timeZone, ZONE);
  assert.equal(period.startDate, dateText(startDay));
  assert.equal(period.endDateInclusive, dateText(startDay + length - 1));
  assert.equal(period.endDateExclusive, dateText(startDay + length));
  assert.equal(period.start, isoAt(startDay));
  assert.equal(period.endExclusive, isoAt(startDay + length));
}

/** Exactly `length` consecutive local dates fall in the period, and each date is covered end to end. */
function assertExactLocalDates(period, startDay, length) {
  const inside = [];
  for (let day = startDay - 2; day <= startDay + length + 2; day += 1) {
    const first = localInstantMs(day, 0);
    const last = localInstantMs(day, DAY - 1);
    const firstIn = isInstantInPeriod(period, iso(first));
    const lastIn = isInstantInPeriod(period, iso(last));
    assert.equal(firstIn, lastIn, `local date ${dateText(day)} must be wholly in or out`);
    if (firstIn) inside.push(day);
  }
  assert.deepEqual(inside, Array.from({ length }, (_, index) => startDay + index));
  assert.equal(isInstantInPeriod(period, iso(localInstantMs(startDay) - 1)), false);
  assert.equal(isInstantInPeriod(period, iso(localInstantMs(startDay))), true);
  assert.equal(isInstantInPeriod(period, iso(localInstantMs(startDay + length) - 1)), true);
  assert.equal(isInstantInPeriod(period, iso(localInstantMs(startDay + length))), false);
}

// ---------------------------------------------------------------------------
// Model self-checks
// ---------------------------------------------------------------------------

test('reference model agrees with the platform Asia/Kolkata oracle and known calendar facts', () => {
  assert.equal(weekdayMondayZero(daysFromCivil(2026, 1, 12)), 0, '2026-01-12 is a Monday');
  assert.equal(weekdayMondayZero(daysFromCivil(2024, 2, 29)), 3, '2024-02-29 is a Thursday');
  assert.equal(weekdayMondayZero(daysFromCivil(2025, 12, 28)), 6, '2025-12-28 is a Sunday');
  assert.equal(dateText(daysFromCivil(2100, 2, 28) + 1), '2100-03-01', '2100 is not a leap year');
  assert.equal(dateText(daysFromCivil(2000, 2, 28) + 1), '2000-02-29', '2000 is a leap year');
  fc.assert(
    fc.property(dayArbitrary, timeOfDayArbitrary, (day, timeOfDay) => {
      const local = intlLocal(localInstantMs(day, timeOfDay));
      assert.equal(local.date, dateText(day));
      assert.equal(local.timeOfDayMs, timeOfDay);
    }),
    { numRuns: NUM_RUNS },
  );
});

// ---------------------------------------------------------------------------
// Local dates and Monday weeks
// ---------------------------------------------------------------------------

test('Property 28: local dates and Monday-start weeks are exact at every boundary', () => {
  // Feature: financial-clarity-experience, Property 28: Local reporting periods and cohorts have exact boundaries
  // **Validates: Requirements 13.1, 13.2**
  let cases = 0;
  fc.assert(
    fc.property(dayArbitrary, timeOfDayArbitrary, (day, timeOfDay) => {
      cases += 1;
      const ms = localInstantMs(day, timeOfDay);
      const monday = mondayOf(day);

      assert.equal(toLocalDate(iso(ms)), dateText(day));
      assert.equal(toLocalDate(new Date(ms)), dateText(day));
      if (ms % 1000 === 0) assert.equal(toLocalDate(sqliteText(ms)), dateText(day));
      assert.equal(toLocalWeekStart(iso(ms)), dateText(monday));
      assert.equal(toLocalWeekStart(new Date(ms)), dateText(monday));

      const week = weeklyPeriodContaining(iso(ms));
      assertPeriodShape(week, 'weekly', monday);
      assert.equal(isInstantInPeriod(week, iso(ms)), true);
      assertExactLocalDates(week, monday, 7);
      assert.deepEqual(createPeriod('weekly', dateText(monday)), week);

      // One millisecond before the local Monday midnight belongs to the previous week.
      const previous = weeklyPeriodContaining(iso(localInstantMs(monday) - 1));
      assert.equal(previous.startDate, dateText(monday - 7));
      assert.equal(previous.endDateExclusive, dateText(monday));
      assert.equal(previous.endExclusive, week.start);

      // Any other weekday cannot start a weekly period.
      if (weekdayMondayZero(day) !== 0) {
        assert.throws(() => createPeriod('weekly', dateText(day)), RangeError);
      }
    }),
    { numRuns: NUM_RUNS },
  );
  assert.ok(cases >= 100, `expected at least 100 cases, ran ${cases}`);
});

// ---------------------------------------------------------------------------
// 28-date periods
// ---------------------------------------------------------------------------

test('Property 28: 28-day periods hold exactly 28 consecutive local dates', () => {
  // Feature: financial-clarity-experience, Property 28: Local reporting periods and cohorts have exact boundaries
  // **Validates: Requirements 13.1, 13.3**
  let cases = 0;
  fc.assert(
    fc.property(dayArbitrary, (reportEndDay) => {
      cases += 1;
      const startDay = reportEndDay - 27;
      const ending = twentyEightDayPeriodEndingOn(dateText(reportEndDay));
      assertPeriodShape(ending, '28_day', startDay);
      assertExactLocalDates(ending, startDay, 28);
      assert.deepEqual(createPeriod('28_day', dateText(startDay)), ending);
      assert.equal(ending.endExclusive, isoAt(reportEndDay + 1));
    }),
    { numRuns: NUM_RUNS },
  );
  assert.ok(cases >= 100, `expected at least 100 cases, ran ${cases}`);
});

// ---------------------------------------------------------------------------
// Completed periods
// ---------------------------------------------------------------------------

test('Property 28: a period is completed exactly when its exclusive local end has been reached', () => {
  // Feature: financial-clarity-experience, Property 28: Local reporting periods and cohorts have exact boundaries
  // **Validates: Requirements 13.1, 13.2, 13.3**
  let cases = 0;
  fc.assert(
    fc.property(
      periodTypeArbitrary,
      dayArbitrary,
      fc.integer({ min: -3, max: 3 }),
      timeOfDayArbitrary,
      (periodType, anyDay, dayDelta, timeOfDay) => {
        cases += 1;
        const startDay = periodStartDayFor(periodType, anyDay);
        const endDay = startDay + periodLength(periodType);
        const period = createPeriod(periodType, dateText(startDay));
        const nowDay = endDay + dayDelta;
        const now = localInstantMs(nowDay, timeOfDay);

        // Completed only once the local date has reached the exclusive end date.
        assert.equal(isPeriodCompleted(period, iso(now)), nowDay >= endDay);
        assert.equal(isPeriodCompleted(period, iso(localInstantMs(endDay) - 1)), false);
        assert.equal(isPeriodCompleted(period, iso(localInstantMs(endDay))), true);

        // Reports are produced for completed periods only.
        assert.throws(
          () => calculateMetricReport({ period, generatedAt: iso(localInstantMs(endDay) - 1) }),
          RangeError,
        );
        const report = calculateMetricReport({ period, generatedAt: iso(localInstantMs(endDay)) });
        assert.deepEqual(report.map((row) => row.metricName), [...METRIC_NAMES]);
        for (const row of report) {
          assert.equal(row.periodStart, isoAt(startDay));
          assert.equal(row.periodEndExclusive, isoAt(endDay));
          assert.equal(row.periodStartDate, dateText(startDay));
          assert.equal(row.periodEndDateInclusive, dateText(endDay - 1));
          assert.equal(row.timeZone, ZONE);
        }
      },
    ),
    { numRuns: NUM_RUNS },
  );
  assert.ok(cases >= 100, `expected at least 100 cases, ran ${cases}`);
});

test('Property 28: completed-period listing follows consecutive weeks and rolling 28-day periods', () => {
  // Feature: financial-clarity-experience, Property 28: Local reporting periods and cohorts have exact boundaries
  // **Validates: Requirements 13.1, 13.2, 13.3**
  let cases = 0;
  fc.assert(
    fc.property(
      periodTypeArbitrary,
      dayArbitrary,
      timeOfDayArbitrary,
      fc.integer({ min: -3, max: 90 }),
      timeOfDayArbitrary,
      fc.option(fc.integer({ min: 0, max: 40 }), { nil: null }),
      (periodType, earliestDay, earliestTime, nowDayOffset, nowTime, checkpointOffset) => {
        cases += 1;
        const length = periodLength(periodType);
        // Decision 1: weekly periods advance by 7 dates, 28-day periods roll forward by 1 date.
        const step = periodType === 'weekly' ? 7 : 1;
        const nowDay = earliestDay + nowDayOffset;
        const now = localInstantMs(nowDay, nowTime);

        let firstEndDay;
        const args = { periodType, now: iso(now) };
        if (checkpointOffset === null) {
          args.earliestInstant = iso(localInstantMs(earliestDay, earliestTime));
          firstEndDay = periodStartDayFor(periodType, earliestDay) + length;
        } else {
          const checkpointDay = periodType === 'weekly'
            ? mondayOf(earliestDay + checkpointOffset)
            : earliestDay + checkpointOffset;
          args.checkpointEndExclusive = isoAt(checkpointDay);
          firstEndDay = checkpointDay + step;
        }

        const expected = [];
        for (let endDay = firstEndDay; endDay <= nowDay; endDay += step) {
          expected.push({
            periodType,
            startDate: dateText(endDay - length),
            endDateInclusive: dateText(endDay - 1),
            endDateExclusive: dateText(endDay),
            start: isoAt(endDay - length),
            endExclusive: isoAt(endDay),
          });
        }

        const actual = listCompletedPeriods(args).map((period) => ({
          periodType: period.periodType,
          startDate: period.startDate,
          endDateInclusive: period.endDateInclusive,
          endDateExclusive: period.endDateExclusive,
          start: period.start,
          endExclusive: period.endExclusive,
        }));
        assert.deepEqual(actual, expected);

        // A period that ends exactly at `now` is listed; one millisecond earlier it is not.
        const atBoundary = listCompletedPeriods({ ...args, now: isoAt(firstEndDay) });
        assert.equal(atBoundary.length, 1);
        assert.equal(atBoundary[0].endExclusive, isoAt(firstEndDay));
        assert.equal(listCompletedPeriods({ ...args, now: iso(localInstantMs(firstEndDay) - 1) }).length, 0);
      },
    ),
    { numRuns: NUM_RUNS },
  );
  assert.ok(cases >= 100, `expected at least 100 cases, ran ${cases}`);
});

// ---------------------------------------------------------------------------
// Cohort assignment
// ---------------------------------------------------------------------------

const cohortScenarioArbitrary = fc.record({
  periodType: periodTypeArbitrary,
  anyDay: dayArbitrary,
  periodCount: fc.integer({ min: 1, max: 4 }),
  users: fc.array(
    fc.array(
      fc.record({
        offset: fc.oneof(
          // Exactly on, one millisecond either side of, and one day either side of a period edge.
          fc.tuple(fc.integer({ min: 0, max: 4 }), fc.constantFrom(-DAY, -1, 0, 1, DAY))
            .map(([edge, delta]) => ({ edge, delta })),
          // Anywhere from ten days before the first period to ten days after the last.
          fc.integer({ min: -10 * DAY, max: 4 * 28 * DAY + 10 * DAY }).map((delta) => ({ edge: null, delta })),
        ),
        measurementEligible: fc.boolean(),
      }),
      { minLength: 1, maxLength: 4 },
    ),
    { minLength: 1, maxLength: 6 },
  ),
});

test('Property 28: each user lands in exactly one period cohort from complete journey history', () => {
  // Feature: financial-clarity-experience, Property 28: Local reporting periods and cohorts have exact boundaries
  // **Validates: Requirements 13.3, 13.4, 13.5, 13.13**
  let cases = 0;
  fc.assert(
    fc.property(cohortScenarioArbitrary, (scenario) => {
      cases += 1;
      const { periodType, periodCount } = scenario;
      const length = periodLength(periodType);
      const firstDay = periodStartDayFor(periodType, scenario.anyDay);
      const firstStartMs = localInstantMs(firstDay);
      const periodMs = length * DAY;

      // Journeys for every user, including journeys outside every period.
      let nextId = 1;
      const journeys = [];
      scenario.users.forEach((userJourneys, userIndex) => {
        for (const spec of userJourneys) {
          const base = spec.offset.edge === null ? 0 : spec.offset.edge * periodMs;
          journeys.push({
            id: nextId,
            userId: userIndex + 1,
            startedAt: iso(firstStartMs + base + spec.offset.delta),
            measurementEligible: spec.measurementEligible,
          });
          nextId += 1;
        }
      });

      // Reference: the earliest journey (ties by lowest id) over the full history decides everything.
      const earliestByUser = new Map();
      for (const journey of journeys) {
        const current = earliestByUser.get(journey.userId);
        const ms = Date.parse(journey.startedAt);
        if (!current || ms < current.ms || (ms === current.ms && journey.id < current.journey.id)) {
          earliestByUser.set(journey.userId, { ms, journey });
        }
      }
      const expectedPeriodIndex = (ms) => {
        if (ms < firstStartMs || ms >= firstStartMs + periodCount * periodMs) return null;
        return Math.floor((ms - firstStartMs) / periodMs);
      };

      const reversed = [...journeys].reverse();
      const membership = new Map();
      for (let index = 0; index < periodCount; index += 1) {
        const period = createPeriod(periodType, dateText(firstDay + index * length));
        const result = assignNewUserCohort({ journeys, period });

        const inPeriod = [...earliestByUser.entries()]
          .filter(([, { ms }]) => expectedPeriodIndex(ms) === index)
          .sort(([a], [b]) => a - b);
        const eligible = inPeriod.filter(([, { journey }]) => journey.measurementEligible);

        assert.deepEqual(
          result.users.map((user) => ({ userId: user.userId, journeyId: user.journeyId, startedAt: user.startedAt })),
          eligible.map(([userId, { journey }]) => ({ userId, journeyId: journey.id, startedAt: journey.startedAt })),
        );
        assert.deepEqual(result.population, {
          newUsers: inPeriod.length,
          measurableUsers: eligible.length,
          excludedNotMeasurementEligible: inPeriod.length - eligible.length,
          excludedOptedOut: 0,
        });
        assert.equal(new Set(result.users.map((user) => user.userId)).size, result.users.length);

        // Input order does not change the cohort.
        assert.deepEqual(assignNewUserCohort({ journeys: reversed, period }), result);

        for (const user of result.users) membership.set(user.userId, (membership.get(user.userId) ?? 0) + 1);
      }

      // Across consecutive, non-overlapping periods a measurable new user appears exactly once.
      for (const [userId, { ms, journey }] of earliestByUser) {
        const covered = expectedPeriodIndex(ms) !== null && journey.measurementEligible;
        assert.equal(membership.get(userId) ?? 0, covered ? 1 : 0, `user ${userId}`);
      }
    }),
    { numRuns: NUM_RUNS },
  );
  assert.ok(cases >= 100, `expected at least 100 cases, ran ${cases}`);
});

// ---------------------------------------------------------------------------
// Seven-local-date action windows
// ---------------------------------------------------------------------------

test('Property 28: action windows end at the same local time on the seventh following date, exclusive', () => {
  // Feature: financial-clarity-experience, Property 28: Local reporting periods and cohorts have exact boundaries
  // **Validates: Requirements 13.1, 13.13**
  let cases = 0;
  fc.assert(
    fc.property(dayArbitrary, timeOfDayArbitrary, (day, timeOfDay) => {
      cases += 1;
      const display = localInstantMs(day, timeOfDay);
      const endMs = localInstantMs(day + 7, timeOfDay);
      const window = actionWindowFor(iso(display));

      assert.equal(window.start, iso(display));
      assert.equal(window.endExclusive, iso(endMs));
      assert.equal(endMs - display, 7 * DAY, 'a fixed-offset zone has 24-hour local days');

      // The platform oracle places the end on the seventh following local date at the same local time.
      const local = intlLocal(endMs);
      assert.equal(local.date, dateText(day + 7));
      assert.equal(local.timeOfDayMs, timeOfDay);
    }),
    { numRuns: NUM_RUNS },
  );
  assert.ok(cases >= 100, `expected at least 100 cases, ran ${cases}`);
});

test('Property 28: a report counts an action only inside [display, window end) and counts open windows', () => {
  // Feature: financial-clarity-experience, Property 28: Local reporting periods and cohorts have exact boundaries
  // **Validates: Requirements 13.1, 13.3, 13.5, 13.13**
  const TARGET_METRICS = new Set(['financial_change_reload_rate', 'financial_change_page_wide_loading_rate']);
  let cases = 0;
  fc.assert(
    fc.property(
      periodTypeArbitrary,
      dayArbitrary,
      timeOfDayArbitrary,
      fc.constantFrom(0, 1, 119_999, 120_000, 3 * DAY),
      fc.uniqueArray(fc.integer({ min: 0, max: 5 }), { minLength: 0, maxLength: 3 }),
      fc.constantFrom(-1, 0, 1, DAY),
      (periodType, displayDay, displayTime, msToOutcome, actionKinds, generatedDelta) => {
        cases += 1;
        const displayMs = localInstantMs(displayDay, displayTime);
        const startedMs = displayMs - msToOutcome;
        const windowEndMs = localInstantMs(displayDay + 7, displayTime);

        // The journey starts inside this period (local date of the start instant).
        const startedDay = Math.floor((startedMs + IST_OFFSET) / DAY);
        const periodStartDay = periodStartDayFor(periodType, startedDay);
        const length = periodLength(periodType);
        const period = createPeriod(periodType, dateText(periodStartDay));
        assertPeriodShape(period, periodType, periodStartDay);
        const periodEndMs = localInstantMs(periodStartDay + length);

        const generatedMs = Math.max(periodEndMs, windowEndMs + generatedDelta);
        const actionTimes = actionKinds.map((kind) => [
          displayMs - 1, displayMs, displayMs + 1, windowEndMs - 1, windowEndMs, windowEndMs + 1,
        ][kind]);
        const countedAction = actionTimes.some((ms) => ms >= displayMs && ms < windowEndMs);

        const report = calculateMetricReport({
          period,
          generatedAt: iso(generatedMs),
          journeys: [{ id: 1, userId: 1, startedAt: iso(startedMs), measurementEligible: true }],
          events: [
            { id: 1, userId: 1, eventName: 'first_outcome_displayed', journeyId: 1, occurredAt: iso(displayMs) },
            ...actionTimes.map((ms, index) => ({
              id: 10 + index,
              userId: 1,
              eventName: 'recommended_action_completed',
              occurredAt: iso(ms),
            })),
          ],
        });
        const row = (name) => report.find((entry) => entry.metricName === name);

        // The starting-journey user is in this period's cohort once, with a same-session display (decision 4).
        const outcome = row('first_meaningful_outcome_rate');
        assert.equal(outcome.numerator, 1);
        assert.equal(outcome.denominator, 1);

        const action = row('recommended_action_completion_rate');
        assert.equal(action.denominator, 1);
        assert.equal(action.numerator, countedAction ? 1 : 0);
        // Decision 7: a window still open at generation time is counted and reported.
        assert.equal(action.population.openActionWindows, windowEndMs > generatedMs ? 1 : 0);
        assert.equal(action.periodStart, isoAt(periodStartDay));
        assert.equal(action.periodEndExclusive, isoAt(periodStartDay + length));

        // Decision 2: cohort targets apply only to 28-day periods; change-rate targets apply to both.
        for (const entry of report) {
          const hasTarget = TARGET_METRICS.has(entry.metricName) || periodType === '28_day';
          assert.equal(entry.target !== null, hasTarget, `${entry.metricName} in ${periodType}`);
        }
      },
    ),
    { numRuns: NUM_RUNS },
  );
  assert.ok(cases >= 100, `expected at least 100 cases, ran ${cases}`);
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fc } from '../../test/test-utils';
import { assertProperty } from '../../test/propertyReport';
import {
  DAY_MS,
  KOLKATA_OFFSET_MS,
  addDays,
  formatIsoDate,
  isLeapYear,
  kolkataDateOf,
  kolkataMidnightMs,
  kolkataMonthOf,
  withProcessTimeZone,
} from '../../test/kolkataReference';
import {
  getServerTimeOffsetMs,
  kolkataMonth,
  kolkataNow,
  kolkataToday,
  observeResponseTime,
  observeServerTime,
  resetServerTimeOffset,
} from './kolkata';

/*
 * Feature: quick-add-daily-answer, Property 24: The Kolkata calendar helper agrees with the reference
 *
 * Validates: Requirements 11.18, 11.21
 *
 * Reference: `kolkataDateOf` and `kolkataMonthOf` in test/kolkataReference.ts read the date through
 * `Intl.DateTimeFormat` with `timeZone: 'Asia/Kolkata'`. Nothing below uses the helper's own arithmetic to
 * compute an expectation. Instants are limited to 1990 through 2100, the years in which Intl's historical
 * Asia/Kolkata zone equals the fixed +05:30 offset the helper uses.
 *
 * The helper keeps the observed server offset in module state. Every case resets it before and after the run.
 *
 * The clock is a frozen fake `Date` (only `Date` is faked, and it never advances by itself). Each case sets the
 * system time itself before it observes or reads, so no real millisecond can move a read across a Kolkata midnight.
 * Offsets are compared with arithmetic that cannot meet a negative zero (see the observation test).
 */

const RUNS = 200;
const ZONES = [
  'UTC',
  'America/Los_Angeles',
  'America/St_Johns',
  'Pacific/Pago_Pago',
  'Pacific/Kiritimati',
  'Australia/Lord_Howe',
  'Asia/Kathmandu',
  'Asia/Kolkata',
] as const;

/** Instants stay a week inside the 1990..2100 window so a generated device offset cannot leave it. */
const MIN_INSTANT = Date.UTC(1990, 0, 10);
const MAX_INSTANT = Date.UTC(2100, 11, 20);
const MAX_OFFSET_MS = 7 * DAY_MS;

const zoneArb = fc.constantFrom(...ZONES);

/** A Kolkata midnight, as the day index of its UTC-shifted calendar day. */
const dayIndexArb = fc.integer({ min: Math.ceil(MIN_INSTANT / DAY_MS), max: Math.floor(MAX_INSTANT / DAY_MS) });
const midnightMsArb = dayIndexArb.map((index) => index * DAY_MS - KOLKATA_OFFSET_MS);

/** Uniform instants, mixed with instants within a millisecond of a Kolkata midnight. */
const instantArb = fc.oneof(
  fc.integer({ min: MIN_INSTANT, max: MAX_INSTANT }),
  fc.tuple(midnightMsArb, fc.constantFrom(-2, -1, 0, 1, 2)).map(([midnight, nudge]) => midnight + nudge),
);

const deviceOffsetArb = fc.integer({ min: -MAX_OFFSET_MS, max: MAX_OFFSET_MS });
const elapsedArb = fc.integer({ min: 0, max: 3 * DAY_MS });

function withCleanOffset<T>(fn: () => T): T {
  resetServerTimeOffset();
  try {
    return fn();
  } finally {
    resetServerTimeOffset();
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  resetServerTimeOffset();
});

afterEach(() => {
  resetServerTimeOffset();
  vi.useRealTimers();
});

describe('Property 24: The Kolkata calendar helper agrees with the reference', () => {
  it('names the Intl date and month of any instant under any process time zone, and the month is the date prefix', () => {
    assertProperty(
      fc.property(zoneArb, instantArb, (zone, instant) => {
        withCleanOffset(() => withProcessTimeZone(zone, () => {
          const date = kolkataToday(instant);
          expect(date).toBe(kolkataDateOf(instant));
          expect(kolkataMonth(instant)).toBe(kolkataMonthOf(instant));
          expect(kolkataMonth(instant)).toBe(date.slice(0, 7));
          expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        }));
      }),
      { numRuns: RUNS },
    );
  });

  it('uses the device clock plus any device clock offset when no server time was observed', () => {
    assertProperty(
      fc.property(zoneArb, instantArb, deviceOffsetArb, (zone, trueInstant, deviceOffset) => {
        withCleanOffset(() => withProcessTimeZone(zone, () => {
          const deviceNow = trueInstant + deviceOffset;
          vi.setSystemTime(deviceNow);
          expect(getServerTimeOffsetMs()).toBe(0);
          expect(kolkataNow()).toBe(deviceNow);
          expect(kolkataToday()).toBe(kolkataDateOf(deviceNow));
          expect(kolkataMonth()).toBe(kolkataMonthOf(deviceNow));
        }));
      }),
      { numRuns: RUNS },
    );
  });

  it('returns the Kolkata date of server time after an observation, however far the device clock is off', () => {
    assertProperty(
      fc.property(
        zoneArb,
        instantArb,
        deviceOffsetArb,
        elapsedArb,
        fc.constantFrom('iso', 'date', 'epoch', 'receivedAt'),
        (zone, serverNow, deviceOffset, elapsed, form) => {
          withCleanOffset(() => withProcessTimeZone(zone, () => {
            const deviceNow = serverNow + deviceOffset;
            vi.setSystemTime(deviceNow);

            let observed: boolean;
            if (form === 'iso') observed = observeServerTime(new Date(serverNow).toISOString());
            else if (form === 'date') observed = observeServerTime(new Date(serverNow));
            else if (form === 'epoch') observed = observeServerTime(serverNow);
            else observed = observeServerTime(new Date(serverNow).toISOString(), deviceNow);
            expect(observed).toBe(true);

            // `offset + deviceOffset === 0` rather than `toBe(-deviceOffset)`: `toBe` uses Object.is, so a generated
            // device offset of 0 would compare the helper's +0 with a negated -0 and fail on a correct helper.
            expect(getServerTimeOffsetMs() + deviceOffset).toBe(0);
            // The fake clock is frozen: no real time passes between the observation and these reads.
            expect(Date.now()).toBe(deviceNow);
            expect(kolkataNow()).toBe(serverNow);
            expect(kolkataToday()).toBe(kolkataDateOf(serverNow));
            expect(kolkataMonth()).toBe(kolkataMonthOf(serverNow));

            // The device clock keeps running, and the corrected clock keeps the same distance from it.
            vi.setSystemTime(deviceNow + elapsed);
            expect(kolkataNow()).toBe(serverNow + elapsed);
            expect(kolkataToday()).toBe(kolkataDateOf(serverNow + elapsed));
            expect(kolkataMonth()).toBe(kolkataMonthOf(serverNow + elapsed));
          }));
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('reads the server time from a response body generatedAt before the Date header', () => {
    assertProperty(
      fc.property(
        zoneArb,
        instantArb,
        deviceOffsetArb,
        fc.constantFrom('snapshot', 'flat', 'header'),
        (zone, serverNow, deviceOffset, source) => {
          withCleanOffset(() => withProcessTimeZone(zone, () => {
            vi.setSystemTime(serverNow + deviceOffset);
            const stamp = new Date(serverNow).toISOString();
            // A header that disagrees with the body shows which one the helper used.
            const wrongHeader = new Date(serverNow + 5 * DAY_MS).toUTCString();

            let observed: boolean;
            if (source === 'snapshot') observed = observeResponseTime(wrongHeader, { snapshot: { generatedAt: stamp } });
            else if (source === 'flat') observed = observeResponseTime(wrongHeader, { generatedAt: stamp });
            else observed = observeResponseTime(new Date(serverNow - (serverNow % 1000)).toUTCString(), { ok: true });
            expect(observed).toBe(true);

            const expectedNow = source === 'header' ? serverNow - (serverNow % 1000) : serverNow;
            expect(kolkataNow()).toBe(expectedNow);
            expect(kolkataToday()).toBe(kolkataDateOf(expectedNow));
            expect(kolkataMonth()).toBe(kolkataMonthOf(expectedNow));
          }));
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('rolls the date over at 18:30 UTC, and the month at the end of a Kolkata month', () => {
    assertProperty(
      fc.property(zoneArb, dayIndexArb, (zone, index) => {
        withCleanOffset(() => withProcessTimeZone(zone, () => {
          const utcDay = new Date(index * DAY_MS);
          const date = formatIsoDate(utcDay.getUTCFullYear(), utcDay.getUTCMonth() + 1, utcDay.getUTCDate());
          const previous = addDays(date, -1);
          const next = addDays(date, 1);
          // 18:30 UTC on the day before `date` is midnight at the start of `date` in Kolkata.
          const midnight = kolkataMidnightMs(date);
          expect(new Date(midnight + DAY_MS).getUTCHours()).toBe(18);
          expect(new Date(midnight + DAY_MS).getUTCMinutes()).toBe(30);

          expect(kolkataToday(midnight - 1)).toBe(previous);
          expect(kolkataToday(midnight)).toBe(date);
          expect(kolkataToday(midnight + DAY_MS - 1)).toBe(date);
          expect(kolkataToday(midnight + DAY_MS)).toBe(next);

          expect(kolkataMonth(midnight - 1)).toBe(previous.slice(0, 7));
          expect(kolkataMonth(midnight)).toBe(date.slice(0, 7));
          expect(kolkataMonth(midnight + DAY_MS)).toBe(next.slice(0, 7));
          // The month changes exactly when the new date is the first of a month.
          expect(kolkataMonth(midnight) !== kolkataMonth(midnight - 1)).toBe(date.endsWith('-01'));

          // The Intl reference names the same days at the boundary.
          expect(kolkataToday(midnight - 1)).toBe(kolkataDateOf(midnight - 1));
          expect(kolkataToday(midnight)).toBe(kolkataDateOf(midnight));
        }));
      }),
      { numRuns: RUNS },
    );
  });

  it('names 29 February in a leap year and goes from 28 February to 1 March otherwise', () => {
    assertProperty(
      fc.property(zoneArb, fc.integer({ min: 1991, max: 2099 }), fc.integer({ min: 0, max: DAY_MS - 1 }), (zone, year, within) => {
        withCleanOffset(() => withProcessTimeZone(zone, () => {
          const feb28 = kolkataMidnightMs(formatIsoDate(year, 2, 28));
          const instant = feb28 + DAY_MS + within;
          const expected = isLeapYear(year) ? formatIsoDate(year, 2, 29) : formatIsoDate(year, 3, 1);
          expect(kolkataToday(instant)).toBe(expected);
          expect(kolkataToday(instant)).toBe(kolkataDateOf(instant));
          expect(kolkataMonth(instant)).toBe(expected.slice(0, 7));
          expect(kolkataToday(feb28 + within)).toBe(formatIsoDate(year, 2, 28));

          // The day after a leap day is 1 March.
          if (isLeapYear(year)) {
            expect(kolkataToday(instant + DAY_MS)).toBe(formatIsoDate(year, 3, 1));
          }
        }));
      }),
      { numRuns: RUNS },
    );
  });

  it('forgets an observed offset when it is reset', () => {
    assertProperty(
      fc.property(instantArb, deviceOffsetArb, (serverNow, deviceOffset) => {
        withCleanOffset(() => {
          vi.setSystemTime(serverNow + deviceOffset);
          observeServerTime(serverNow);
          resetServerTimeOffset();
          expect(getServerTimeOffsetMs()).toBe(0);
          expect(kolkataNow()).toBe(serverNow + deviceOffset);
        });
      }),
      { numRuns: RUNS },
    );
  });
});

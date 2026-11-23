import { describe, expect, it } from 'vitest';
import { fc } from '../../test/test-utils';
import { assertProperty } from '../../test/propertyReport';
import { anyRealDateArb, noteWordArb } from '../../test/quickAddGenerators';
import { addDays, daysInMonth, formatIsoDate, isRealDate, scanBackDate, weekdayOf } from '../../test/kolkataReference';
import { acceptedDateRange, classifyDateToken, resolveDateText, resolveDateToken, type DateResolution } from './dates';
import { parseQuickAddLine } from './parser';

/*
 * Feature: quick-add-daily-answer, Property 5: Day-only and relative dates resolve to the latest date on or before Today
 *
 * Validates: Requirements 2.16, 2.17, 2.18, 2.19, 2.20, 2.21, 2.22, 2.23, 2.24, 2.25, 17.6
 *
 * Reference model: `scanBackDate` in test/kolkataReference.ts walks back from Today one calendar day at a time and
 * returns the first date that matches the token's predicate (weekday, day of the month, or day and month). Full
 * dates are expected as written. The accepted range is computed here from the year of Today. Nothing below calls
 * `dates.ts` to compute an expectation.
 */

const RUNS = 200;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;

type Expected = { ok: true; date: string } | { ok: false; subcode: 'NOT_A_DATE' | 'OUT_OF_RANGE' };

const dayOf = (date: string): number => Number(date.slice(8, 10));
const monthOf = (date: string): number => Number(date.slice(5, 7));
const two = (n: number): string => String(n).padStart(2, '0');

/** The accepted range from the year of Today: 1 January of year-10 through 31 December of year+1. */
function modelRange(today: string): { min: string; max: string } {
  const year = Number(today.slice(0, 4));
  return { min: formatIsoDate(year - 10, 1, 1), max: formatIsoDate(year + 1, 12, 31) };
}

function modelAccept(date: string, today: string): Expected {
  const { min, max } = modelRange(today);
  return date >= min && date <= max ? { ok: true, date } : { ok: false, subcode: 'OUT_OF_RANGE' };
}

function scan(today: string, matches: (date: string) => boolean): string {
  const found = scanBackDate(today, matches);
  if (found === null) throw new Error(`The model found no date for ${today}`);
  return found;
}

const modelYesterday = (today: string): Expected => modelAccept(addDays(today, -1), today);
const modelWeekday = (today: string, weekday: number): Expected =>
  modelAccept(scan(today, (d) => weekdayOf(d) === weekday), today);
const modelDayOfMonth = (today: string, day: number): Expected =>
  day >= 1 && day <= 31
    ? modelAccept(scan(today, (d) => dayOf(d) === day), today)
    : { ok: false, subcode: 'NOT_A_DATE' };
const modelDayMonth = (today: string, day: number, month: number): Expected =>
  month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(2000, month)
    ? modelAccept(scan(today, (d) => dayOf(d) === day && monthOf(d) === month), today)
    : { ok: false, subcode: 'NOT_A_DATE' };
const modelFull = (today: string, year: number, month: number, day: number): Expected =>
  isRealDate(year, month, day)
    ? modelAccept(formatIsoDate(year, month, day), today)
    : { ok: false, subcode: 'NOT_A_DATE' };

function expectResolution(actual: DateResolution | null, expected: Expected, text: string): void {
  expect(actual).not.toBeNull();
  if (expected.ok) {
    expect(actual).toEqual({ ok: true, date: expected.date });
    return;
  }
  expect(actual?.ok).toBe(false);
  if (actual && !actual.ok) {
    expect(actual.problem.code).toBe('INVALID_DATE');
    expect(actual.problem.subcode).toBe(expected.subcode);
    expect(actual.problem.part).toBe(text);
  }
}

/** Applies a letter-case mask to a token. Digits and punctuation have no case, so they pass through. */
function withCase(text: string, mask: readonly boolean[]): string {
  return [...text].map((ch, i) => (mask[i % mask.length] ? ch.toUpperCase() : ch.toLowerCase())).join('');
}

const caseMaskArb = fc.array(fc.boolean(), { minLength: 1, maxLength: 12 });
const todayArb = anyRealDateArb;
const suffixArb = fc.constantFrom('', 'st', 'nd', 'rd', 'th');
const gapArb = fc.constantFrom(' ', '  ', '\t', ' \t ', '\u000b', '\f', '\n');
const dayNumberArb = fc.oneof({ weight: 3, arbitrary: fc.integer({ min: 1, max: 31 }) }, { weight: 2, arbitrary: fc.constantFrom(29, 30, 31) });

/** One written Date_Token with the expectation the model gives for it. */
interface Case {
  text: string;
  expected: (today: string) => Expected;
}

const wordCaseArb: fc.Arbitrary<Case> = fc
  .tuple(
    fc.constantFrom<string>('today', 'yesterday', ...WEEKDAYS),
    caseMaskArb,
  )
  .map(([word, mask]) => ({
    text: withCase(word, mask),
    expected: (today: string): Expected => {
      if (word === 'today') return modelAccept(today, today);
      if (word === 'yesterday') return modelYesterday(today);
      return modelWeekday(today, WEEKDAYS.indexOf(word as (typeof WEEKDAYS)[number]));
    },
  }));

/**
 * `on N` (optional ordinal suffix, optional leading zero) and bare ordinals such as `3rd`. Ordinals may name a
 * day that does not exist (`0th`, `32nd`); `on N` with N above 31 is not a Date_Token (Requirement 2.19), so it
 * stays out of this family and is covered separately.
 */
const onDayCaseArb: fc.Arbitrary<Case> = fc.oneof(
  fc
    .tuple(dayNumberArb, suffixArb, fc.boolean(), caseMaskArb)
    .map(([day, suffix, zeroPad, mask]) => ({
      day,
      text: withCase(`on ${zeroPad ? two(day) : String(day)}${suffix}`, mask),
    })),
  fc
    .tuple(
      fc.oneof({ weight: 3, arbitrary: dayNumberArb }, { weight: 1, arbitrary: fc.integer({ min: 0, max: 99 }) }),
      fc.constantFrom('st', 'nd', 'rd', 'th'),
      fc.boolean(),
      caseMaskArb,
    )
    .map(([day, suffix, zeroPad, mask]) => ({
      day,
      text: withCase(`${zeroPad ? two(day) : String(day)}${suffix}`, mask),
    })),
).map(({ day, text }) => ({ text, expected: (today: string): Expected => modelDayOfMonth(today, day) }));

const dayMonthCaseArb: fc.Arbitrary<Case> = fc
  .oneof(
    { weight: 3, arbitrary: fc.integer({ min: 1, max: 12 }).chain((month) => fc.integer({ min: 1, max: daysInMonth(2000, month) }).map((day) => ({ day, month }))) },
    { weight: 2, arbitrary: fc.constant({ day: 29, month: 2 }) },
    { weight: 1, arbitrary: fc.record({ day: fc.integer({ min: 0, max: 99 }), month: fc.integer({ min: 0, max: 99 }) }) },
  )
  .chain(({ day, month }) => fc.boolean().map((pad) => ({ day, month, pad })))
  .map(({ day, month, pad }) => ({
    text: pad ? `${two(day)}/${two(month)}` : `${day}/${month}`,
    expected: (today: string): Expected => modelDayMonth(today, day, month),
  }));

/** Full dates in the three forms, in range, just inside or outside the edges, or not real dates. */
const fullDateCaseArb: fc.Arbitrary<{ month: number; day: number; form: 'iso' | 'slash4' | 'slash2'; todayYearOffset: number }> =
  fc
    .tuple(
      fc.constantFrom<'iso' | 'slash4' | 'slash2'>('iso', 'slash4', 'slash2'),
      fc.integer({ min: -13, max: 4 }),
      fc.oneof(
        { weight: 4, arbitrary: fc.integer({ min: 1, max: 12 }).chain((month) => fc.integer({ min: 1, max: 31 }).map((day) => ({ month, day }))) },
        { weight: 2, arbitrary: fc.constantFrom({ month: 1, day: 1 }, { month: 12, day: 31 }, { month: 2, day: 29 }, { month: 2, day: 28 }) },
        { weight: 1, arbitrary: fc.record({ month: fc.integer({ min: 0, max: 99 }), day: fc.integer({ min: 0, max: 99 }) }) },
      ),
    )
    .map(([form, todayYearOffset, { month, day }]) => ({ form, todayYearOffset, month, day }));

function writeFull(form: 'iso' | 'slash4' | 'slash2', year: number, month: number, day: number): string {
  if (form === 'iso') return `${String(year).padStart(4, '0')}-${two(month)}-${two(day)}`;
  if (form === 'slash4') return `${two(day)}/${two(month)}/${String(year).padStart(4, '0')}`;
  return `${two(day)}/${two(month)}/${two(year - 2000)}`;
}

/** Chooses the year from Today and the offset. Two-digit years need a year from 2000 through 2099. */
function fullFor(today: string, c: { form: 'iso' | 'slash4' | 'slash2'; month: number; day: number; todayYearOffset: number }) {
  let year = Number(today.slice(0, 4)) + c.todayYearOffset;
  let form = c.form;
  if (form === 'slash2' && (year < 2000 || year > 2099)) form = 'slash4';
  year = Math.max(1, year);
  const text = writeFull(form, year, c.month, c.day);
  return { text, expected: modelFull(today, year, c.month, c.day) };
}

describe('Property 5: day-only and relative dates resolve to the latest date on or before Today', () => {
  it('resolves today, yesterday, and weekday names (any letter case) to the latest matching date', () => {
    assertProperty(
      fc.property(todayArb, wordCaseArb, (today, c) => {
        const expected = c.expected(today);
        expectResolution(resolveDateText(c.text, today), expected, c.text);
        const token = classifyDateToken(c.text);
        expect(token).not.toBeNull();
        if (token) expectResolution(resolveDateToken(token, today), expected, c.text);
      }),
      { numRuns: RUNS },
    );
  });

  it('resolves a weekday to Today when it is Today\'s weekday and never to a later date', () => {
    assertProperty(
      fc.property(todayArb, fc.constantFrom(...WEEKDAYS), (today, name) => {
        const result = resolveDateText(name, today);
        expect(result?.ok).toBe(true);
        if (result?.ok) {
          expect(result.date <= today).toBe(true);
          expect(weekdayOf(result.date)).toBe(WEEKDAYS.indexOf(name));
          expect(result.date === today).toBe(weekdayOf(today) === WEEKDAYS.indexOf(name));
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('resolves `on N` and ordinals to the latest date with that day, skipping months without it', () => {
    assertProperty(
      fc.property(todayArb, onDayCaseArb, gapArb, (today, c, gap) => {
        const text = c.text.replace(/^(on)[ ]/i, (_m, on: string) => `${on}${gap}`);
        const expected = c.expected(today);
        expectResolution(resolveDateText(text, today), expected, text);
        if (expected.ok) expect(expected.date <= today).toBe(true);
      }),
      { numRuns: RUNS },
    );
  });

  it('skips months without day 29, 30, or 31 for `on N`', () => {
    assertProperty(
      fc.property(todayArb, fc.constantFrom(29, 30, 31), suffixArb, (today, day, suffix) => {
        const result = resolveDateText(`on ${day}${suffix}`, today);
        expect(result?.ok).toBe(true);
        if (result?.ok) {
          const year = Number(result.date.slice(0, 4));
          const month = monthOf(result.date);
          expect(dayOf(result.date)).toBe(day);
          expect(day <= daysInMonth(year, month)).toBe(true);
          expect(result).toEqual({ ok: true, date: scan(today, (d) => dayOf(d) === day) });
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('classifies `on N` with N above 31 as no date, and the parser reads N as the amount', () => {
    assertProperty(
      fc.property(todayArb, fc.integer({ min: 32, max: 99_999 }), gapArb, (today, n, gap) => {
        expect(classifyDateToken(`on${gap}${n}`)).toBeNull();
        expect(resolveDateText(`on${gap}${n}`, today)).toBeNull();
        expect(parseQuickAddLine(`on ${n}`, today)).toEqual({
          ok: true,
          entry: { amountMinor: n * 100, spentOn: today, note: 'on' },
        });
      }),
      { numRuns: RUNS },
    );
  });

  it('resolves dd/mm to the latest date with that day and month, skipping years without it', () => {
    assertProperty(
      fc.property(todayArb, dayMonthCaseArb, (today, c) => {
        expectResolution(resolveDateText(c.text, today), c.expected(today), c.text);
      }),
      { numRuns: RUNS },
    );
  });

  it('finds the latest 29 February on or before Today for 29/02', () => {
    assertProperty(
      fc.property(todayArb, fc.boolean(), (today, pad) => {
        const text = pad ? '29/02' : '29/2';
        const result = resolveDateText(text, today);
        expect(result?.ok).toBe(true);
        if (result?.ok) {
          expect(result.date <= today).toBe(true);
          expect(result.date.slice(5)).toBe('02-29');
          // No later 29 February lies on or before Today.
          const year = Number(result.date.slice(0, 4));
          for (let y = year + 1; y <= Number(today.slice(0, 4)); y += 1) {
            expect(isRealDate(y, 2, 29) && formatIsoDate(y, 2, 29) <= today).toBe(false);
          }
          expect(result.date).toBe(scan(today, (d) => dayOf(d) === 29 && monthOf(d) === 2));
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('resolves dd/mm/yy, dd/mm/yyyy, and yyyy-mm-dd as written (two-digit years read as 20yy) and checks the range', () => {
    assertProperty(
      fc.property(todayArb, fullDateCaseArb, (today, c) => {
        const { text, expected } = fullFor(today, c);
        expectResolution(resolveDateText(text, today), expected, text);
      }),
      { numRuns: RUNS },
    );
  });

  it('reads a two-digit year as 20yy', () => {
    assertProperty(
      fc.property(fc.integer({ min: 0, max: 99 }), fc.integer({ min: 1, max: 12 }), fc.integer({ min: 1, max: 28 }), (yy, month, day) => {
        const today = formatIsoDate(2000 + yy, month, day);
        const text = `${two(day)}/${two(month)}/${two(yy)}`;
        expect(resolveDateText(text, today)).toEqual({ ok: true, date: today });
      }),
      { numRuns: RUNS },
    );
  });

  it('accepts exactly 1 January of year-10 through 31 December of year+1', () => {
    assertProperty(
      fc.property(todayArb, (today) => {
        const range = modelRange(today);
        expect(acceptedDateRange(today)).toEqual(range);
        for (const [date, ok] of [
          [range.min, true],
          [addDays(range.min, -1), false],
          [range.max, true],
          [addDays(range.max, 1), false],
        ] as const) {
          const result = resolveDateText(date, today);
          expect(result?.ok).toBe(ok);
          if (result && !result.ok) expect(result.problem.subcode).toBe('OUT_OF_RANGE');
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('reports non-real calendar dates as INVALID_DATE / NOT_A_DATE naming the token', () => {
    assertProperty(
      fc.property(
        todayArb,
        fc.oneof(
          fc.integer({ min: 32, max: 99 }).map((n) => `${n}th`),
          fc.constantFrom('0th', '00th', '0st', 'on 0', '0/5', '5/0', '13/13', '32/01', '31/02', '30/02', '31/04', '31/06', '31/09', '31/11', '12/25'),
          fc.constantFrom(1990, 2001, 2023, 2025).map((y) => `29/02/${y}`),
          fc.constantFrom(1990, 2001, 2023, 2025).map((y) => `${y}-02-29`),
          fc.constantFrom(2001, 2023).map((y) => `${y}-04-31`),
        ),
        (today, text) => {
          expectResolution(resolveDateText(text, today), { ok: false, subcode: 'NOT_A_DATE' }, text);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('puts the resolved date in the parser result and uses Today when the line has no date', () => {
    assertProperty(
      fc.property(
        todayArb,
        fc.oneof(wordCaseArb, onDayCaseArb, dayMonthCaseArb),
        fc.integer({ min: 1, max: 99_999 }),
        fc.option(noteWordArb(), { nil: '' }),
        fc.constantFrom('dateFirst', 'dateLast', 'dateMiddle'),
        (today, c, rupees, note, order) => {
          const amount = String(rupees);
          const pieces =
            order === 'dateFirst' ? [c.text, amount, note] : order === 'dateLast' ? [note, amount, c.text] : [amount, c.text, note];
          const line = pieces.filter((p) => p !== '').join(' ');
          const expected = c.expected(today);
          const result = parseQuickAddLine(line, today);
          if (expected.ok) {
            expect(result).toEqual({ ok: true, entry: { amountMinor: rupees * 100, spentOn: expected.date, note } });
          } else {
            expect(result.ok).toBe(false);
            if (!result.ok) {
              expect(result.problems.some((p) => p.code === 'INVALID_DATE' && p.subcode === expected.subcode && p.part === c.text)).toBe(true);
            }
          }
          const undated = parseQuickAddLine([amount, note].filter((p) => p !== '').join(' '), today);
          expect(undated).toEqual({ ok: true, entry: { amountMinor: rupees * 100, spentOn: today, note } });
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('returns a multiple-dates problem for a line with more than one Date_Token', () => {
    assertProperty(
      fc.property(
        todayArb,
        fc.oneof(wordCaseArb, onDayCaseArb, dayMonthCaseArb),
        fc.oneof(wordCaseArb, onDayCaseArb, dayMonthCaseArb),
        fc.integer({ min: 1, max: 99_999 }),
        (today, first, second, rupees) => {
          const result = parseQuickAddLine(`${first.text} ${rupees} ${second.text}`, today);
          expect(result.ok).toBe(false);
          if (!result.ok) {
            const multiple = result.problems.filter((p) => p.code === 'MULTIPLE_DATES');
            expect(multiple).toHaveLength(1);
            expect(multiple[0]?.part).toContain(first.text);
            expect(multiple[0]?.part).toContain(second.text);
          }
        },
      ),
      { numRuns: RUNS },
    );
  });
});

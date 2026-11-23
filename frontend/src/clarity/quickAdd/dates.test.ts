import { describe, expect, it } from 'vitest';
import {
  acceptedDateRange,
  addDaysIso,
  classifyDateToken,
  daysInMonth,
  describeAcceptedDateRange,
  formatIsoDate,
  isInAcceptedRange,
  isIsoDate,
  isLeapYear,
  isRealDate,
  multipleDatesProblem,
  parseIsoDate,
  resolveDateText,
  resolveDateToken,
  weekdayOf,
} from './dates';

/** Resolves text and returns the date, failing the test when it does not resolve. */
function resolve(text: string, today: string): string {
  const result = resolveDateText(text, today);
  if (!result || !result.ok) throw new Error(`"${text}" did not resolve: ${JSON.stringify(result)}`);
  return result.date;
}

function problemOf(text: string, today: string) {
  const result = resolveDateText(text, today);
  if (!result || result.ok) throw new Error(`"${text}" should be a problem: ${JSON.stringify(result)}`);
  return result.problem;
}

describe('calendar helpers', () => {
  it('knows leap years and month lengths', () => {
    expect([1900, 2000, 2023, 2024, 2100].map(isLeapYear)).toEqual([false, true, false, true, false]);
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2025, 2)).toBe(28);
    expect([1, 3, 5, 7, 8, 10, 12].every((m) => daysInMonth(2025, m) === 31)).toBe(true);
    expect([4, 6, 9, 11].every((m) => daysInMonth(2025, m) === 30)).toBe(true);
  });

  it('validates real dates only', () => {
    expect(isRealDate(2024, 2, 29)).toBe(true);
    expect(isRealDate(2025, 2, 29)).toBe(false);
    expect(isRealDate(2025, 4, 31)).toBe(false);
    expect(isRealDate(2025, 0, 1)).toBe(false);
    expect(isRealDate(2025, 13, 1)).toBe(false);
    expect(isRealDate(2025, 1, 0)).toBe(false);
    expect(isRealDate(2025.5, 1, 1)).toBe(false);
    expect(isRealDate(0, 1, 1)).toBe(false);
  });

  it('parses only strict zero-padded ISO dates', () => {
    expect(parseIsoDate('2025-03-09')).toEqual({ year: 2025, month: 3, day: 9 });
    for (const bad of ['2025-3-9', '2025-02-30', '2025/03/09', ' 2025-03-09', '2025-03-09 ', '٢٠٢٥-٠٣-٠٩', '']) {
      expect(parseIsoDate(bad)).toBeNull();
    }
    expect(isIsoDate('2024-02-29')).toBe(true);
    expect(formatIsoDate(2025, 3, 9)).toBe('2025-03-09');
  });

  it('matches the UTC calendar for weekdays and day arithmetic', () => {
    for (const iso of ['1970-01-01', '2000-02-29', '2024-12-31', '2025-01-01', '2026-07-15', '2100-03-01']) {
      const date = parseIsoDate(iso)!;
      const reference = new Date(Date.UTC(date.year, date.month - 1, date.day));
      expect(weekdayOf(date)).toBe(reference.getUTCDay());
      for (const delta of [-400, -31, -1, 0, 1, 30, 366]) {
        const moved = new Date(reference.getTime() + delta * 86_400_000).toISOString().slice(0, 10);
        expect(addDaysIso(iso, delta)).toBe(moved);
      }
    }
    expect(() => addDaysIso('2025-02-30', 1)).toThrow(RangeError);
  });
});

describe('Accepted_Date_Range', () => {
  it('runs from 1 January ten years back to 31 December next year', () => {
    expect(acceptedDateRange('2025-06-15')).toEqual({ min: '2015-01-01', max: '2026-12-31' });
    expect(describeAcceptedDateRange('2025-06-15')).toBe('1 January 2015 through 31 December 2026');
  });

  it('includes both ends and excludes the days beside them', () => {
    const today = '2025-06-15';
    expect(isInAcceptedRange('2015-01-01', today)).toBe(true);
    expect(isInAcceptedRange('2014-12-31', today)).toBe(false);
    expect(isInAcceptedRange('2026-12-31', today)).toBe(true);
    expect(isInAcceptedRange('2027-01-01', today)).toBe(false);
    expect(isInAcceptedRange('2025-02-30', today)).toBe(false);
  });
});

describe('relative words', () => {
  const today = '2025-03-01'; // a Saturday
  it('resolves today and yesterday in any letter case, across a month boundary', () => {
    expect(resolve('today', today)).toBe('2025-03-01');
    expect(resolve('TODAY', today)).toBe('2025-03-01');
    expect(resolve('Yesterday', today)).toBe('2025-02-28');
    expect(resolve('yesterday', '2024-03-01')).toBe('2024-02-29');
    expect(resolve('yesterday', '2025-01-01')).toBe('2024-12-31');
  });

  it('resolves a weekday to the latest such day on or before Today', () => {
    expect(weekdayOf(parseIsoDate(today)!)).toBe(6);
    expect(resolve('saturday', today)).toBe('2025-03-01');
    expect(resolve('Friday', today)).toBe('2025-02-28');
    expect(resolve('sunday', today)).toBe('2025-02-23');
    expect(resolve('monday', today)).toBe('2025-02-24');
  });

  it('ignores abbreviations and non-ASCII look-alikes', () => {
    for (const text of ['mon', 'tues', 'tomorrow', 'आज', 'తెలుగు', 'todayy', '']) {
      expect(classifyDateToken(text)).toBeNull();
    }
  });
});

describe('day of the month', () => {
  it('uses this month when the day has not passed and last month when it has not yet come', () => {
    expect(resolve('on 3', '2025-06-15')).toBe('2025-06-03');
    expect(resolve('on 15', '2025-06-15')).toBe('2025-06-15');
    expect(resolve('on 16', '2025-06-15')).toBe('2025-05-16');
    expect(resolve('3rd', '2025-06-02')).toBe('2025-05-03');
    expect(resolve('1st', '2025-01-01')).toBe('2025-01-01');
    expect(resolve('on 31', '2025-01-01')).toBe('2024-12-31');
  });

  it('skips months without the requested day', () => {
    expect(resolve('on 31', '2025-05-15')).toBe('2025-03-31'); // April has 30, so back to March
    expect(resolve('31st', '2025-03-15')).toBe('2025-01-31'); // February has 28
    expect(resolve('on 30', '2025-03-15')).toBe('2025-01-30');
    expect(resolve('on 30', '2024-03-15')).toBe('2024-01-30'); // leap February still has no 30th
    expect(resolve('on 29', '2025-03-15')).toBe('2025-01-29'); // February 2025 has no 29th
    expect(resolve('on 29', '2024-03-15')).toBe('2024-02-29');
  });

  it('accepts the on-word with several spaces, any letter case, and ordinal suffixes', () => {
    expect(resolve('On   3rd', '2025-06-15')).toBe('2025-06-03');
    expect(resolve('ON 2ND', '2025-06-15')).toBe('2025-06-02');
    expect(resolve('on\u00a03', '2025-06-15')).toBe('2025-06-03');
    expect(resolve('on ３', '2025-06-15')).toBe('2025-06-03'); // fullwidth digit, NFKC
  });

  it('leaves on N with N above 31 to the amount rules, and names zero as an invalid date', () => {
    expect(classifyDateToken('on 45')).toBeNull();
    expect(classifyDateToken('on 99')).toBeNull();
    for (const text of ['on 0', '0th', 'on 00']) {
      const problem = problemOf(text, '2025-06-15');
      expect(problem).toMatchObject({ code: 'INVALID_DATE', subcode: 'NOT_A_DATE', part: text });
      expect(problem.reason).toContain(text);
    }
    expect(problemOf('32nd', '2025-06-15')).toMatchObject({ subcode: 'NOT_A_DATE', part: '32nd' });
  });

  it('keeps Devanagari and Telugu numerals out of date tokens', () => {
    for (const text of ['on ३', '३rd', 'on ౩', '३/०५']) {
      expect(classifyDateToken(text)).toBeNull();
    }
  });
});

describe('dd/mm', () => {
  it('reads the day first and picks the latest date on or before Today', () => {
    expect(resolve('15/06', '2025-06-15')).toBe('2025-06-15');
    expect(resolve('16/06', '2025-06-15')).toBe('2024-06-16');
    expect(resolve('01/06', '2025-06-15')).toBe('2025-06-01');
    expect(resolve('5/6', '2025-06-15')).toBe('2025-06-05');
    expect(resolve('31/12', '2025-01-02')).toBe('2024-12-31');
  });

  it('resolves 29 February to the latest leap day', () => {
    expect(resolve('29/02', '2025-06-15')).toBe('2024-02-29');
    expect(resolve('29/02', '2024-02-28')).toBe('2020-02-29');
    expect(resolve('29/02', '2024-02-29')).toBe('2024-02-29');
    expect(resolve('29/02', '2100-06-01')).toBe('2096-02-29'); // 2100 is not a leap year
  });

  it('finds the latest leap day across the longest gap between leap years', () => {
    expect(resolve('29/02', '2104-02-28')).toBe('2096-02-29');
  });

  it('names a day and month that never exist', () => {
    for (const text of ['31/02', '30/02', '12/25', '00/05', '5/00', '32/01', '31/04']) {
      expect(problemOf(text, '2025-06-15')).toMatchObject({ code: 'INVALID_DATE', subcode: 'NOT_A_DATE', part: text });
    }
  });

  it('is never read month first', () => {
    expect(resolve('03/04', '2025-06-15')).toBe('2025-04-03');
  });
});

describe('full dates', () => {
  const today = '2025-06-15';
  it('resolves dd/mm/yy, dd/mm/yyyy, and yyyy-mm-dd exactly, reading yy as 20yy', () => {
    expect(resolve('03/04/25', today)).toBe('2025-04-03');
    expect(resolve('03/04/2025', today)).toBe('2025-04-03');
    expect(resolve('2025-04-03', today)).toBe('2025-04-03');
    expect(resolve('3/4/25', today)).toBe('2025-04-03');
    expect(resolve('29/02/24', today)).toBe('2024-02-29');
  });

  it('accepts a future date inside the range', () => {
    expect(resolve('31/12/2026', today)).toBe('2026-12-31');
    expect(resolve('2026-01-01', today)).toBe('2026-01-01');
  });

  it('rejects dates that do not exist', () => {
    for (const text of ['29/02/25', '31/04/2025', '2025-02-30', '2025-13-01', '2025-00-10', '12/25/2025']) {
      expect(problemOf(text, today)).toMatchObject({ subcode: 'NOT_A_DATE', part: text });
    }
  });

  it('rejects dates outside the Accepted_Date_Range and states the range', () => {
    for (const text of ['31/12/2014', '2014-12-31', '01/01/2027', '2027-01-01', '01/01/99']) {
      const problem = problemOf(text, today);
      expect(problem).toMatchObject({ code: 'INVALID_DATE', subcode: 'OUT_OF_RANGE', part: text });
      expect(problem.correction).toContain('1 January 2015 through 31 December 2026');
    }
    expect(resolve('01/01/2015', today)).toBe('2015-01-01');
    expect(resolve('31/12/26', today)).toBe('2026-12-31');
  });

  it('does not read other slash or dash shapes as dates', () => {
    for (const text of ['1/2/3', '12/05/202', '2025-3-3', '1/2/3/4', 'a/b', '12-05-2025']) {
      expect(classifyDateToken(text)).toBeNull();
    }
  });
});

describe('purity', () => {
  it('gives the same answer whatever the process time zone and locale settings are', () => {
    const before = ['yesterday', 'friday', 'on 31', '29/02'].map((t) => resolve(t, '2025-03-01'));
    const originalTz = process.env.TZ;
    try {
      for (const tz of ['Asia/Kolkata', 'Pacific/Kiritimati', 'America/Los_Angeles', 'UTC']) {
        process.env.TZ = tz;
        const after = ['yesterday', 'friday', 'on 31', '29/02'].map((t) => resolve(t, '2025-03-01'));
        expect(after).toEqual(before);
      }
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });

  it('throws a RangeError for a Today that is not a real date, a precondition of the caller', () => {
    const token = classifyDateToken('yesterday')!;
    expect(() => resolveDateToken(token, '2025-02-30')).toThrow(RangeError);
    expect(() => resolveDateToken(token, 'today')).toThrow(RangeError);
  });

  it('returns null for text that is not a Date_Token', () => {
    expect(resolveDateText('coffee', '2025-06-15')).toBeNull();
    expect(resolveDateText('450', '2025-06-15')).toBeNull();
  });
});

describe('multiple dates', () => {
  it('lists every date token in the problem', () => {
    const problem = multipleDatesProblem(['today', '3rd']);
    expect(problem).toMatchObject({ code: 'MULTIPLE_DATES', part: 'today 3rd' });
    expect(problem.reason).toContain('"today"');
    expect(problem.reason).toContain('"3rd"');
    expect(problem.correction).toMatch(/one date/);
  });
});

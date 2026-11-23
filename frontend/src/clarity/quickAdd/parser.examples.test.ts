/**
 * Parser example tests (task 2.11). They complement parser.test.ts and the parser.*.property.test.ts files and give
 * every example and error case named in Requirements 2 to 4 and 17 and in the design's error taxonomy an explicit
 * assertion, including the exact reason and correction text of every Parse_Problem code and subcode.
 *
 * Requirements: 2.3, 2.5 to 2.11, 2.14, 2.15, 2.16 to 2.31, 2.34, 2.35, 4.1 to 4.3, 17.18.
 */
import { describe, expect, it } from 'vitest';
import { MAX_LINE_LENGTH, MAX_NOTE_LENGTH, parseQuickAddLine, type ParseProblem, type ParsedEntry } from './parser';

/** Saturday. */
const TODAY = '2025-03-15';

const RANGE_TEXT = '₹0.01 to ₹99,99,99,99,999.99';
const ACCEPTED_RANGE_FOR_TODAY = '1 January 2015 through 31 December 2026';

function entryOf(line: string, today = TODAY): ParsedEntry {
  const result = parseQuickAddLine(line, today);
  if (!result.ok) throw new Error(`"${line}" should parse: ${JSON.stringify(result.problems)}`);
  return result.entry;
}

function problemsOf(line: string, today = TODAY): ParseProblem[] {
  const result = parseQuickAddLine(line, today);
  if (result.ok) throw new Error(`"${line}" should not parse: ${JSON.stringify(result.entry)}`);
  return result.problems;
}

function onlyProblem(line: string, today = TODAY): ParseProblem {
  const problems = problemsOf(line, today);
  expect(problems).toHaveLength(1);
  return problems[0] as ParseProblem;
}

describe('named examples from Requirement 2 (entries)', () => {
  it.each([
    ['120 coffee', { amountMinor: 12_000, spentOn: '2025-03-15', note: 'coffee' }],
    ['swiggy 450 yesterday', { amountMinor: 45_000, spentOn: '2025-03-14', note: 'swiggy' }],
    ['rent 25,000 on 3rd', { amountMinor: 2_500_000, spentOn: '2025-03-03', note: 'rent' }],
    ['₹1,20,000/-', { amountMinor: 12_000_000, spentOn: '2025-03-15', note: '' }],
    ['7up 40', { amountMinor: 4_000, spentOn: '2025-03-15', note: '7up' }],
    ['450', { amountMinor: 45_000, spentOn: '2025-03-15', note: '' }],
    ['120 "lunch on 3rd"', { amountMinor: 12_000, spentOn: '2025-03-15', note: 'lunch on 3rd' }],
    ['lunch on 45', { amountMinor: 4_500, spentOn: '2025-03-15', note: 'lunch on' }],
  ])('parses %j', (line, expected) => {
    expect(entryOf(line)).toEqual(expected);
  });
});

describe('amount candidates and grouping (Requirements 2.5 to 2.9, 17.2, 17.3)', () => {
  it('reads Indian, Western, and ungrouped notation as the same paise value', () => {
    for (const line of ['1,20,000', '120,000', '120000', '₹1,20,000', '₹120,000', 'Rs 120000/-']) {
      expect(entryOf(line).amountMinor).toBe(12_000_000);
    }
    expect(entryOf('12,34,567 x').amountMinor).toBe(123_456_700);
    expect(entryOf('1,234,567 x').amountMinor).toBe(123_456_700);
    expect(entryOf('1,000 x').amountMinor).toBe(100_000);
    expect(entryOf('10,00,000 x').amountMinor).toBe(100_000_000);
  });

  it('reads one fractional digit as tenths and two as paise, without floating point', () => {
    expect(entryOf('120.5').amountMinor).toBe(12_050);
    expect(entryOf('120.05').amountMinor).toBe(12_005);
    expect(entryOf('120.50').amountMinor).toBe(12_050);
    expect(entryOf('0.5').amountMinor).toBe(50);
    expect(entryOf('0.01').amountMinor).toBe(1);
    expect(entryOf('0.07').amountMinor).toBe(7);
    expect(entryOf('1,20,000.5').amountMinor).toBe(12_000_050);
  });

  it('accepts the smallest and largest amount and stays exact at the top of the range', () => {
    expect(entryOf('₹0.01').amountMinor).toBe(1);
    expect(entryOf('99,99,99,99,999.99').amountMinor).toBe(9_999_999_999_999);
    expect(entryOf('99999999999.99').amountMinor).toBe(9_999_999_999_999);
    expect(Number.isSafeInteger(entryOf('99999999999.99').amountMinor)).toBe(true);
    expect(entryOf('10000000000 x').amountMinor).toBe(1_000_000_000_000);
  });

  it.each([
    ['₹120', 12_000],
    ['₹ 120', 12_000],
    ['Rs120', 12_000],
    ['rs120', 12_000],
    ['RS120', 12_000],
    ['Rs.120', 12_000],
    ['rs.120', 12_000],
    ['Rs 120', 12_000],
    ['Rs. 120', 12_000],
    ['rs. 120', 12_000],
    ['INR120', 12_000],
    ['inr120', 12_000],
    ['INR 120', 12_000],
    ['Inr 120', 12_000],
    ['120/-', 12_000],
    ['₹120/-', 12_000],
    ['Rs 120/-', 12_000],
    ['₹ 120/-', 12_000],
    ['₹120.50', 12_050],
    ['₹１２０', 12_000],
  ])('treats the marker and suffix of %j as part of the Amount_Token', (line, paise) => {
    expect(entryOf(line)).toEqual({ amountMinor: paise, spentOn: TODAY, note: '' });
    // The marker never leaks into the note when a word accompanies it.
    expect(entryOf(`${line} tea`).note).toBe('tea');
    expect(entryOf(`tea ${line}`).note).toBe('tea');
  });

  it('treats a mixed digit-and-letter token as Note_Text (Requirement 2.6)', () => {
    expect(entryOf('7up 40')).toMatchObject({ amountMinor: 4_000, note: '7up' });
    expect(entryOf('route66 40')).toMatchObject({ amountMinor: 4_000, note: 'route66' });
    expect(entryOf('3pm 40')).toMatchObject({ amountMinor: 4_000, note: '3pm' });
    expect(entryOf('40 3pm meeting')).toMatchObject({ amountMinor: 4_000, note: '3pm meeting' });
    expect(entryOf('40 120rs')).toMatchObject({ amountMinor: 4_000, note: '120rs' });
  });

  it('uses the single remaining candidate after Date_Tokens are removed (Requirement 2.12)', () => {
    expect(entryOf('3rd 5')).toEqual({ amountMinor: 500, spentOn: '2025-03-03', note: '' });
    expect(entryOf('5 on 3')).toEqual({ amountMinor: 500, spentOn: '2025-03-03', note: '' });
    expect(entryOf('5 15/03')).toEqual({ amountMinor: 500, spentOn: '2025-03-15', note: '' });
    expect(entryOf('5 2025-03-01')).toEqual({ amountMinor: 500, spentOn: '2025-03-01', note: '' });
  });

  it('uses the marked candidate among several and keeps the others in the note (Requirement 2.13)', () => {
    expect(entryOf('coffee 5 tea Rs 6')).toEqual({ amountMinor: 600, spentOn: TODAY, note: 'coffee 5 tea' });
    expect(entryOf('INR 6 coffee 5 tea 7')).toEqual({ amountMinor: 600, spentOn: TODAY, note: 'coffee 5 tea 7' });
  });
});

describe('invalid amounts: every subcode with its exact text (Requirements 2.10, 2.11, 2.15, 2.14)', () => {
  it('BAD_GROUPING names the token and states the accepted grouping', () => {
    const expected = {
      code: 'INVALID_AMOUNT',
      subcode: 'BAD_GROUPING',
      reason: 'uses commas in a way that is not Indian or three-digit grouping.',
      correction: 'Write 1,20,000 or 120,000, or leave the commas out.',
    };
    for (const token of ['1,2,3', '12,34', '1,2345', '1234,567', '1,20,00', '12,3456', ',120', '1,,000', '120,']) {
      expect(onlyProblem(`${token} tea`)).toEqual({ ...expected, part: token, reason: `"${token}" ${expected.reason}` });
    }
  });

  it('TOO_MANY_DECIMALS never rounds or truncates', () => {
    for (const token of ['120.555', '0.001', '5.123', '1,20,000.999']) {
      expect(onlyProblem(`${token} tea`)).toEqual({
        code: 'INVALID_AMOUNT',
        subcode: 'TOO_MANY_DECIMALS',
        part: token,
        reason: `"${token}" has more than two digits after the decimal point.`,
        correction: 'Use at most two digits after the point, like 120.50.',
      });
    }
  });

  it('NO_INTEGER_PART names the token', () => {
    expect(onlyProblem('.5 tea')).toEqual({
      code: 'INVALID_AMOUNT',
      subcode: 'NO_INTEGER_PART',
      part: '.5',
      reason: '".5" has no digit before the decimal point.',
      correction: 'Write the amount like 120 or 0.50.',
    });
    expect(onlyProblem('₹.50 tea')).toMatchObject({ subcode: 'NO_INTEGER_PART', part: '₹.50' });
  });

  it('TRAILING_POINT names the token', () => {
    expect(onlyProblem('5. tea')).toEqual({
      code: 'INVALID_AMOUNT',
      subcode: 'TRAILING_POINT',
      part: '5.',
      reason: '"5." has a decimal point with no digits after it.',
      correction: 'Write 120 or 120.50.',
    });
  });

  it('ZERO states the accepted range ₹0.01 to ₹99,99,99,99,999.99', () => {
    for (const token of ['0', '0.0', '0.00', '000', '₹0', 'Rs 0', '0/-']) {
      const problem = onlyProblem(`${token} tea`);
      expect(problem).toMatchObject({ code: 'INVALID_AMOUNT', subcode: 'ZERO' });
      expect(problem.reason).toMatch(/^".+" is zero\.$/);
      expect(problem.correction).toBe(`Use an amount from ${RANGE_TEXT}.`);
    }
    expect(onlyProblem('0 tea').part).toBe('0');
  });

  it('TOO_LARGE states the accepted range and the 11-digit boundary is exact', () => {
    expect(onlyProblem('100000000000 tea')).toEqual({
      code: 'INVALID_AMOUNT',
      subcode: 'TOO_LARGE',
      part: '100000000000',
      reason: '"100000000000" is too large.',
      correction: `Use an amount from ${RANGE_TEXT}.`,
    });
    expect(onlyProblem('1,00,00,00,00,000 tea')).toMatchObject({ subcode: 'TOO_LARGE' });
    expect(onlyProblem('₹123456789012.50 tea')).toMatchObject({ subcode: 'TOO_LARGE' });
    expect(entryOf('99999999999 tea').amountMinor).toBe(9_999_999_999_900);
  });

  it('a problem token keeps its marker and suffix as typed', () => {
    expect(onlyProblem('Rs120.555 tea').part).toBe('Rs120.555');
    expect(onlyProblem('120.555/- tea').part).toBe('120.555/-');
  });

  it('MISSING_AMOUNT shows an accepted form', () => {
    const expected = {
      code: 'MISSING_AMOUNT',
      part: '',
      reason: 'The line has no amount.',
      correction: 'Add an amount, like "120 coffee" or "coffee ₹120".',
    };
    for (const line of ['coffee', '', '   ', 'today', 'coffee yesterday', '₹', 'Rs.', '"120"', 'on', '/-']) {
      expect(problemsOf(line)).toEqual([expected]);
    }
  });

  it('MULTIPLE_AMOUNTS lists the candidates and asks for the ₹ mark', () => {
    const problem = onlyProblem('coffee 5, tea 6');
    expect(problem).toEqual({
      code: 'MULTIPLE_AMOUNTS',
      part: '5, 6',
      reason: 'The line has more than one amount: "5,", "6".',
      correction: 'Mark the amount with ₹, like "₹120", or put the other numbers in double quotes.',
    });
    // Two unmarked, two marked, and `/-` alone all count as "none or more than one marked".
    expect(onlyProblem('5 6 7').reason).toBe('The line has more than one amount: "5", "6", "7".');
    expect(onlyProblem('₹5 Rs 6').reason).toBe('The line has more than one amount: "₹5", "Rs 6".');
    expect(onlyProblem('5/- 6/-').code).toBe('MULTIPLE_AMOUNTS');
  });

  it('puts the other numbers in quotes to resolve multiple amounts (the correction works)', () => {
    expect(entryOf('coffee "5," tea 6')).toEqual({ amountMinor: 600, spentOn: TODAY, note: 'coffee 5, tea' });
    expect(entryOf('coffee ₹5 tea 6')).toMatchObject({ amountMinor: 500, note: 'coffee tea 6' });
  });
});

describe('dates: every form and rule (Requirements 2.16 to 2.25, 17.6)', () => {
  it('resolves today and yesterday without regard to case, across month, year, and leap boundaries', () => {
    expect(entryOf('5 TODAY').spentOn).toBe('2025-03-15');
    expect(entryOf('5 Yesterday').spentOn).toBe('2025-03-14');
    expect(entryOf('5 YESTERDAY', '2025-03-01').spentOn).toBe('2025-02-28');
    expect(entryOf('5 yesterday', '2024-03-01').spentOn).toBe('2024-02-29');
    expect(entryOf('5 yesterday', '2025-01-01').spentOn).toBe('2024-12-31');
    expect(entryOf('5 yesterday', '2025-12-01').spentOn).toBe('2025-11-30');
  });

  it('resolves a weekday name to the latest date on or before Today, and Today when it matches', () => {
    // 2025-03-15 is a Saturday.
    const expected: Record<string, string> = {
      saturday: '2025-03-15',
      friday: '2025-03-14',
      thursday: '2025-03-13',
      wednesday: '2025-03-12',
      tuesday: '2025-03-11',
      monday: '2025-03-10',
      sunday: '2025-03-09',
    };
    for (const [name, date] of Object.entries(expected)) {
      expect(entryOf(`5 ${name}`).spentOn).toBe(date);
      expect(entryOf(`5 ${name.toUpperCase()}`).spentOn).toBe(date);
    }
    // Across a month boundary: 2025-03-02 is a Sunday, so the latest Monday is 24 February.
    expect(entryOf('5 monday', '2025-03-02').spentOn).toBe('2025-02-24');
  });

  it('does not read an abbreviated weekday as a date', () => {
    expect(entryOf('5 mon')).toEqual({ amountMinor: 500, spentOn: TODAY, note: 'mon' });
    expect(entryOf('5 sat')).toMatchObject({ note: 'sat', spentOn: TODAY });
  });

  it('resolves `on N` and an ordinal to the latest matching day, with or without a suffix', () => {
    for (const token of ['on 3', 'on 3rd', 'on 03', 'ON 3', 'On 3Rd', '3rd', '3RD', '03rd']) {
      expect(entryOf(`5 ${token}`).spentOn).toBe('2025-03-03');
    }
    for (const [token, day] of [
      ['1st', '2025-03-01'],
      ['2nd', '2025-03-02'],
      ['4th', '2025-03-04'],
      ['11th', '2025-03-11'],
      ['15th', '2025-03-15'],
    ] as const) {
      expect(entryOf(`5 ${token}`).spentOn).toBe(day);
    }
    // A day after Today's day belongs to the previous month.
    expect(entryOf('5 on 16').spentOn).toBe('2025-02-16');
    expect(entryOf('5 on 15').spentOn).toBe('2025-03-15');
    // On the first of January the previous month is in the previous year.
    expect(entryOf('5 on 2', '2025-01-01').spentOn).toBe('2024-12-02');
  });

  it('skips months without the requested day (`31` in a 30-day month, 29 and 30 in February)', () => {
    expect(entryOf('5 on 31', '2025-04-15').spentOn).toBe('2025-03-31');
    expect(entryOf('5 31st', '2025-05-15').spentOn).toBe('2025-03-31');
    expect(entryOf('5 31st', '2025-03-01').spentOn).toBe('2025-01-31');
    expect(entryOf('5 on 31', '2025-03-31').spentOn).toBe('2025-03-31');
    expect(entryOf('5 on 30', '2025-03-15').spentOn).toBe('2025-01-30');
    expect(entryOf('5 on 29', '2025-03-15').spentOn).toBe('2025-01-29');
    expect(entryOf('5 on 29', '2024-03-15').spentOn).toBe('2024-02-29');
  });

  it('resolves dd/mm to the latest matching date on or before Today, day first', () => {
    expect(entryOf('5 28/02').spentOn).toBe('2025-02-28');
    expect(entryOf('5 15/03').spentOn).toBe('2025-03-15');
    expect(entryOf('5 16/03').spentOn).toBe('2024-03-16');
    expect(entryOf('5 1/2').spentOn).toBe('2025-02-01');
    expect(entryOf('5 01/02').spentOn).toBe('2025-02-01');
    expect(entryOf('5 25/12').spentOn).toBe('2024-12-25');
  });

  it('resolves 29/02 to the latest leap day', () => {
    expect(entryOf('5 29/02', '2025-03-15').spentOn).toBe('2024-02-29');
    expect(entryOf('5 29/02', '2024-02-29').spentOn).toBe('2024-02-29');
    expect(entryOf('5 29/02', '2024-02-28').spentOn).toBe('2020-02-29');
    expect(entryOf('5 29/02', '2024-03-01').spentOn).toBe('2024-02-29');
  });

  it('reads dd/mm/yy as 20yy and dd/mm/yyyy and yyyy-mm-dd exactly', () => {
    expect(entryOf('5 15/03/24').spentOn).toBe('2024-03-15');
    expect(entryOf('5 1/2/25').spentOn).toBe('2025-02-01');
    expect(entryOf('5 29/02/24').spentOn).toBe('2024-02-29');
    expect(entryOf('5 01/02/2023').spentOn).toBe('2023-02-01');
    expect(entryOf('5 2023-02-01').spentOn).toBe('2023-02-01');
    expect(entryOf('5 25/12/2025').spentOn).toBe('2025-12-25');
    expect(entryOf('5 2026-12-31').spentOn).toBe('2026-12-31');
    expect(entryOf('5 2015-01-01').spentOn).toBe('2015-01-01');
  });

  it('defaults to Today when the line has no Date_Token (Requirement 2.25)', () => {
    expect(entryOf('5 coffee').spentOn).toBe(TODAY);
    expect(entryOf('5 coffee', '2024-02-29').spentOn).toBe('2024-02-29');
    expect(entryOf('5 coffee', '2025-12-31').spentOn).toBe('2025-12-31');
    expect(entryOf('5 coffee', '2025-01-01').spentOn).toBe('2025-01-01');
  });

  it('does not recognize date words in other languages or abbreviations', () => {
    expect(entryOf('50 आज')).toEqual({ amountMinor: 5_000, spentOn: TODAY, note: 'आज' });
    expect(entryOf('50 कल')).toEqual({ amountMinor: 5_000, spentOn: TODAY, note: 'कल' });
    expect(entryOf('50 నిన్న')).toEqual({ amountMinor: 5_000, spentOn: TODAY, note: 'నిన్న' });
    expect(entryOf('50 yday').note).toBe('yday');
    expect(entryOf('50 tmrw').note).toBe('tmrw');
  });
});

describe('invalid and out-of-range dates (Requirements 2.22, 2.23, 2.24)', () => {
  const notADateReason = (token: string) => `"${token}" is not a real calendar date.`;
  const notADateCorrection =
    'Use a real date such as today, yesterday, a weekday name, on 3rd, 28/02, 28/02/2025, or 2025-02-28.';

  it.each([
    ['31/02', '31/02'],
    ['0th', '0th'],
    ['32nd', '32nd'],
    ['12/25', '12/25'],
    ['00/05', '00/05'],
    ['30/02', '30/02'],
    ['31/04', '31/04'],
    ['1/13', '1/13'],
    ['29/02/2025', '29/02/2025'],
    ['29/02/2100', '29/02/2100'],
    ['31/04/2024', '31/04/2024'],
    ['2025-02-30', '2025-02-30'],
    ['2025-13-01', '2025-13-01'],
    ['2025-00-10', '2025-00-10'],
    ['on 0', 'on 0'],
    ['on 00', 'on 00'],
    ['on 0th', 'on 0th'],
  ])('rejects %j as NOT_A_DATE and names the token', (line, part) => {
    expect(onlyProblem(`5 ${line}`)).toEqual({
      code: 'INVALID_DATE',
      subcode: 'NOT_A_DATE',
      part,
      reason: notADateReason(part),
      correction: notADateCorrection,
    });
  });

  it('never reads 12/25 as month first', () => {
    expect(onlyProblem('5 12/25').subcode).toBe('NOT_A_DATE');
    expect(entryOf('5 25/12').spentOn).toBe('2024-12-25');
  });

  it('rejects a date outside the Accepted_Date_Range and states the range', () => {
    for (const token of ['2000-01-01', '2014-12-31', '2027-01-01', '2099-12-31', '01/01/14', '01/01/2027', '31/12/00']) {
      expect(onlyProblem(`5 ${token}`)).toEqual({
        code: 'INVALID_DATE',
        subcode: 'OUT_OF_RANGE',
        part: token,
        reason: `"${token}" is outside the accepted dates.`,
        correction: `Use a date from ${ACCEPTED_RANGE_FOR_TODAY}.`,
      });
    }
  });

  it('accepts the first and last accepted dates and follows Today across a year change', () => {
    expect(entryOf('5 2015-01-01').spentOn).toBe('2015-01-01');
    expect(entryOf('5 2026-12-31').spentOn).toBe('2026-12-31');
    expect(entryOf('5 2025-12-25').spentOn).toBe('2025-12-25');
    // The range moves with Today's year: for Today in 2030 it is 1 January 2020 through 31 December 2031.
    expect(entryOf('5 2020-01-01', '2030-06-01').spentOn).toBe('2020-01-01');
    expect(entryOf('5 2031-12-31', '2030-06-01').spentOn).toBe('2031-12-31');
    const low = onlyProblem('5 2019-12-31', '2030-06-01');
    expect(low).toMatchObject({ subcode: 'OUT_OF_RANGE', part: '2019-12-31' });
    expect(low.correction).toBe('Use a date from 1 January 2020 through 31 December 2031.');
    expect(onlyProblem('5 2032-01-01', '2030-06-01').correction).toBe(
      'Use a date from 1 January 2020 through 31 December 2031.',
    );
  });

  it('lists every date when the line has more than one (MULTIPLE_DATES)', () => {
    expect(onlyProblem('5 today yesterday')).toEqual({
      code: 'MULTIPLE_DATES',
      part: 'today yesterday',
      reason: 'The line has more than one date: "today", "yesterday".',
      correction: 'Keep one date, or put the other words in double quotes to use them as the note.',
    });
    expect(onlyProblem('5 3rd 4th').reason).toBe('The line has more than one date: "3rd", "4th".');
    expect(onlyProblem('5 on 3rd monday 28/02').reason).toBe(
      'The line has more than one date: "on 3rd", "monday", "28/02".',
    );
    expect(onlyProblem('5 2025-03-01 2025-03-02').code).toBe('MULTIPLE_DATES');
    // The correction works: quoting the extra word turns it into the note.
    expect(entryOf('5 today "yesterday"')).toEqual({ amountMinor: 500, spentOn: TODAY, note: 'yesterday' });
  });

  it('reports a Today that is not a real date as one INVALID_DATE / NOT_A_DATE problem', () => {
    expect(problemsOf('5 coffee', '2025-02-30')).toEqual([
      {
        code: 'INVALID_DATE',
        subcode: 'NOT_A_DATE',
        part: '',
        reason: "Today's date is not available.",
        correction: 'Reload the page so that the date can be read again.',
      },
    ]);
  });
});

describe('length limits with exact text (Requirements 2.3, 2.29, 4.3)', () => {
  it('rejects a 201-unit line with the length and the 200 limit and reports nothing else', () => {
    const line = `5 ${'a'.repeat(199)}`;
    expect(line).toHaveLength(201);
    expect(problemsOf(line)).toEqual([
      {
        code: 'LINE_TOO_LONG',
        part: '',
        reason: 'The line is 201 characters long and the limit is 200.',
        correction: 'Shorten the line to 200 characters or fewer.',
      },
    ]);
    // The length check stops the parse, so other defects in the same line are not reported.
    expect(problemsOf(`0 31/02 ${'a'.repeat(300)}`).map((problem) => problem.code)).toEqual(['LINE_TOO_LONG']);
    expect(problemsOf('x'.repeat(300))[0]?.reason).toBe('The line is 300 characters long and the limit is 200.');
  });

  it('accepts a line of exactly 200 units', () => {
    // Trailing whitespace pads the line to the limit while the note stays short.
    const line = `5 ${'a'.repeat(100)}${' '.repeat(MAX_LINE_LENGTH - 2 - 100)}`;
    expect(line).toHaveLength(MAX_LINE_LENGTH);
    expect(entryOf(line)).toEqual({ amountMinor: 500, spentOn: TODAY, note: 'a'.repeat(100) });
  });

  it('counts UTF-16 code units, so an astral character counts as two', () => {
    const emoji = '😀';
    expect(emoji).toHaveLength(2);
    const longLine = emoji.repeat(101);
    expect(longLine).toHaveLength(202);
    expect(onlyProblem(longLine).reason).toBe('The line is 202 characters long and the limit is 200.');
    expect(onlyProblem(`5 ${emoji.repeat(61)}`)).toEqual({
      code: 'NOTE_TOO_LONG',
      part: '',
      reason: 'The note is 122 characters long and the limit is 120.',
      correction: 'Shorten the note to 120 characters or fewer.',
    });
    expect(entryOf(`5 ${emoji.repeat(60)}`).note).toHaveLength(120);
  });

  it('rejects a 121-unit note with the length and the 120 limit, and accepts 120', () => {
    expect(onlyProblem(`5 ${'a'.repeat(121)}`)).toEqual({
      code: 'NOTE_TOO_LONG',
      part: '',
      reason: 'The note is 121 characters long and the limit is 120.',
      correction: 'Shorten the note to 120 characters or fewer.',
    });
    expect(entryOf(`5 ${'a'.repeat(MAX_NOTE_LENGTH)}`).note).toHaveLength(120);
  });

  it('measures the note after whitespace collapse and joins, not the typed line', () => {
    // 60 + 1 + 60 = 121 once the two words are joined by one space, however many spaces separate them in the line.
    const words = `${'a'.repeat(60)}      ${'b'.repeat(60)}`;
    expect(onlyProblem(`5 ${words}`).reason).toBe('The note is 121 characters long and the limit is 120.');
    expect(entryOf(`5 ${'a'.repeat(59)}      ${'b'.repeat(60)}`).note).toHaveLength(120);
  });

  it('applies the 120 limit to a quoted note and counts a doubled quote as one unit', () => {
    expect(onlyProblem(`5 "${'a'.repeat(121)}"`).code).toBe('NOTE_TOO_LONG');
    expect(entryOf(`5 "${'a'.repeat(120)}"`).note).toHaveLength(120);
    // 90 doubled quotes are 180 typed characters but a 90-unit note.
    expect(entryOf(`5 "${'""'.repeat(90)}"`).note).toBe('"'.repeat(90));
    // 20 doubled quotes (40 typed) plus 100 letters make exactly 120 units, and one more letter makes 121.
    expect(entryOf(`5 "${'""'.repeat(20)}${'a'.repeat(100)}"`).note).toHaveLength(120);
    expect(onlyProblem(`5 "${'""'.repeat(20)}${'a'.repeat(101)}"`).reason).toBe(
      'The note is 121 characters long and the limit is 120.',
    );
  });

  it('keeps the accepted limits no looser than the expense form (Requirement 4.1 to 4.3)', () => {
    const accepted = entryOf('99999999999.99 x');
    expect(accepted.amountMinor).toBeGreaterThan(0);
    expect(accepted.amountMinor).toBe(9_999_999_999_999);
    expect(onlyProblem('100000000000 x').subcode).toBe('TOO_LARGE');
    expect(onlyProblem('0 x').subcode).toBe('ZERO');
    expect(onlyProblem('1.234 x').subcode).toBe('TOO_MANY_DECIMALS');
    expect(onlyProblem('5 2014-12-31').subcode).toBe('OUT_OF_RANGE');
    expect(onlyProblem('5 31/02').subcode).toBe('NOT_A_DATE');
  });
});

describe('quoted text (Requirements 2.26 to 2.28)', () => {
  it('does not interpret an amount, marker, or date inside quotes', () => {
    expect(entryOf('5 "yesterday"')).toEqual({ amountMinor: 500, spentOn: TODAY, note: 'yesterday' });
    expect(entryOf('5 "31/02"')).toEqual({ amountMinor: 500, spentOn: TODAY, note: '31/02' });
    expect(entryOf('5 "monday 2000-01-01"')).toEqual({ amountMinor: 500, spentOn: TODAY, note: 'monday 2000-01-01' });
    expect(entryOf('"120" 5')).toEqual({ amountMinor: 500, spentOn: TODAY, note: '120' });
    expect(entryOf('"₹1,2,3" 5')).toEqual({ amountMinor: 500, spentOn: TODAY, note: '₹1,2,3' });
    expect(problemsOf('"5"').map((problem) => problem.code)).toEqual(['MISSING_AMOUNT']);
  });

  it('reads a doubled quote as one literal quote, at either end of the quoted text', () => {
    expect(entryOf('5 "say ""hi"""').note).toBe('say "hi"');
    expect(entryOf('5 """quoted"""').note).toBe('"quoted"');
    expect(entryOf('5 "a""b"').note).toBe('a"b');
    expect(entryOf('5 """"').note).toBe('"');
  });

  it('treats a quote without a closing quote as ordinary note text', () => {
    expect(entryOf('5 "coffee').note).toBe('"coffee');
    expect(entryOf('5 coffee"').note).toBe('coffee"');
    expect(entryOf('5 5" pipe').note).toBe('5" pipe');
    expect(entryOf('5 "a b').note).toBe('"a b');
  });

  it('keeps an amount-like word in a quoted segment and takes the amount from outside', () => {
    expect(entryOf('"7 eleven" 20')).toEqual({ amountMinor: 2_000, spentOn: TODAY, note: '7 eleven' });
    expect(entryOf('20 "7 eleven" yesterday')).toEqual({ amountMinor: 2_000, spentOn: '2025-03-14', note: '7 eleven' });
  });

  it('does not treat curly quotes as delimiters', () => {
    expect(entryOf('5 “yesterday”')).toEqual({ amountMinor: 500, spentOn: TODAY, note: '“yesterday”' });
    expect(entryOf('5 “a b”').note).toBe('“a b”');
  });

  it('collapses whitespace inside a quoted segment and joins segments in line order', () => {
    expect(entryOf('tea 5 "with  milk" sugar').note).toBe('tea with milk sugar');
    expect(entryOf('"a" "b" 5').note).toBe('a b');
  });
});

describe('notes in other scripts and ASCII-only numerals (Requirements 2.31, 2.34, 2.35)', () => {
  it('keeps Hindi and Telugu notes exactly as typed, with the amount before or after', () => {
    expect(entryOf('चाय 40')).toEqual({ amountMinor: 4_000, spentOn: TODAY, note: 'चाय' });
    expect(entryOf('40 दूध और रोटी')).toEqual({ amountMinor: 4_000, spentOn: TODAY, note: 'दूध और रोटी' });
    expect(entryOf('టీ 40')).toEqual({ amountMinor: 4_000, spentOn: TODAY, note: 'టీ' });
    expect(entryOf('ఆటో ₹120 yesterday')).toEqual({ amountMinor: 12_000, spentOn: '2025-03-14', note: 'ఆటో' });
    expect(entryOf('కూరగాయలు Rs. 99.50 on 3rd')).toEqual({
      amountMinor: 9_950,
      spentOn: '2025-03-03',
      note: 'కూరగాయలు',
    });
    expect(entryOf('सब्ज़ी 1,20,000/-').note).toBe('सब्ज़ी');
  });

  it('does not change the code points of a note (no normalization, case folding, or trimming of marks)', () => {
    const nfd = 'cafe\u0301';
    const nfc = 'caf\u00e9';
    expect(entryOf(`5 ${nfd}`).note).toBe(nfd);
    expect(entryOf(`5 ${nfc}`).note).toBe(nfc);
    expect(entryOf(`5 ${nfd}`).note).not.toBe(entryOf(`5 ${nfc}`).note);
    expect(entryOf('5 ＣＯＦＦＥＥ').note).toBe('ＣＯＦＦＥＥ');
    expect(entryOf('5 Cold COFFEE').note).toBe('Cold COFFEE');
  });

  it('keeps zero-width joiner and non-joiner inside a word, because they are not whitespace', () => {
    const withZwj = 'క్ష\u200dత్ర';
    const withZwnj = 'क\u200cख';
    expect(entryOf(`${withZwj} 5`).note).toBe(withZwj);
    expect(entryOf(`5 ${withZwnj}`).note).toBe(withZwnj);
    expect(entryOf(`5 ${withZwnj} ${withZwj}`).note).toBe(`${withZwnj} ${withZwj}`);
  });

  it('keeps Devanagari, Telugu, and Arabic-Indic numerals as note text', () => {
    expect(problemsOf('५० चाय').map((problem) => problem.code)).toEqual(['MISSING_AMOUNT']);
    expect(problemsOf('౫౦ టీ').map((problem) => problem.code)).toEqual(['MISSING_AMOUNT']);
    expect(problemsOf('٥٠ tea').map((problem) => problem.code)).toEqual(['MISSING_AMOUNT']);
    expect(entryOf('५० चाय 40').note).toBe('५० चाय');
    expect(entryOf('టీ ౫ 40').note).toBe('టీ ౫');
    expect(entryOf('5 on ३')).toEqual({ amountMinor: 500, spentOn: TODAY, note: 'on ३' });
    expect(entryOf('५ ₹10').note).toBe('५');
  });

  it('reads fullwidth ASCII digits as digits and keeps the typed text for the note', () => {
    expect(entryOf('\uFF12\uFF15 ｔｅａ')).toEqual({ amountMinor: 2_500, spentOn: TODAY, note: 'ｔｅａ' });
    expect(entryOf('rent １,２０,０００')).toMatchObject({ amountMinor: 12_000_000, note: 'rent' });
  });

  it('recognizes markers, date words, `on`, and ordinal suffixes in English only', () => {
    expect(entryOf('5 रुपये').note).toBe('रुपये');
    expect(entryOf('रु 120')).toEqual({ amountMinor: 12_000, spentOn: TODAY, note: 'रु' });
    expect(entryOf('रु120 5')).toEqual({ amountMinor: 500, spentOn: TODAY, note: 'रु120' });
    expect(entryOf('5 पर').note).toBe('पर');
    expect(problemsOf('5 पर 3').map((problem) => problem.code)).toEqual(['MULTIPLE_AMOUNTS']);
  });
});

describe('collecting every problem together (Requirement 2.30)', () => {
  it('returns date, amount, and note problems in that order, each with its own text', () => {
    const longNote = 'a'.repeat(MAX_NOTE_LENGTH + 1);
    const problems = problemsOf(`0 31/02 ${longNote}`);
    expect(problems.map((problem) => [problem.code, problem.subcode])).toEqual([
      ['INVALID_DATE', 'NOT_A_DATE'],
      ['INVALID_AMOUNT', 'ZERO'],
      ['NOTE_TOO_LONG', undefined],
    ]);
    for (const problem of problems) {
      expect(problem.reason).not.toBe('');
      expect(problem.correction).not.toBe('');
    }
  });

  it('reports a bad date together with multiple amounts, and a bad amount together with multiple dates', () => {
    expect(problemsOf('coffee 5, tea 6 31/02').map((problem) => problem.code)).toEqual(['INVALID_DATE', 'MULTIPLE_AMOUNTS']);
    expect(problemsOf('1,2,3 today yesterday').map((problem) => problem.code)).toEqual(['MULTIPLE_DATES', 'INVALID_AMOUNT']);
    expect(problemsOf('coffee 2000-01-01').map((problem) => problem.code)).toEqual(['INVALID_DATE', 'MISSING_AMOUNT']);
  });

  it('measures the note with every candidate in it when no amount could be chosen', () => {
    // Two unmarked amounts cannot be told apart, so both stay in the measured note (110 + 1 + 10 + 1 + 10 = 132).
    const a = '1'.repeat(10);
    const long = `${'w'.repeat(110)} ${a} ${a}`;
    const codes = problemsOf(long).map((problem) => problem.code);
    expect(codes).toEqual(['MULTIPLE_AMOUNTS', 'NOTE_TOO_LONG']);
  });
});

describe('lone markers and odd tokens are note text (Requirements 2.9, 2.5)', () => {
  it('keeps a marker that is not attached to an amount in the note', () => {
    expect(entryOf('5 rs')).toMatchObject({ note: 'rs' });
    expect(entryOf('Rs. 5 inr')).toMatchObject({ amountMinor: 500, note: 'inr' });
    expect(entryOf('₹ coffee 5')).toMatchObject({ amountMinor: 500, note: '₹ coffee' });
  });

  it('keeps tokens that contain a slash but are not dates as note text', () => {
    expect(entryOf('5 a/b').note).toBe('a/b');
    expect(entryOf('5 1/2/3/4').note).toBe('1/2/3/4');
    expect(entryOf('5 24x7').note).toBe('24x7');
  });

  it('reads a token of only digits and one point, with optional grouping, as the amount', () => {
    expect(entryOf('tea 1.5').amountMinor).toBe(150);
    expect(entryOf('tea 1,000.5').amountMinor).toBe(100_050);
    expect(entryOf('tea 007').amountMinor).toBe(700);
  });
});

import { describe, expect, it } from 'vitest';
import { MAX_LINE_LENGTH, MAX_NOTE_LENGTH, parseQuickAddLine, type ParseProblem, type ParsedEntry } from './parser';

/** Saturday. */
const TODAY = '2025-03-15';

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

function codesOf(line: string): string[] {
  return problemsOf(line).map((problem) => problem.code);
}

describe('parseQuickAddLine: entries', () => {
  it.each([
    ['120 coffee', { amountMinor: 12_000, spentOn: '2025-03-15', note: 'coffee' }],
    ['swiggy 450 yesterday', { amountMinor: 45_000, spentOn: '2025-03-14', note: 'swiggy' }],
    ['rent 25,000 on 3rd', { amountMinor: 2_500_000, spentOn: '2025-03-03', note: 'rent' }],
    ['₹1,20,000/-', { amountMinor: 12_000_000, spentOn: '2025-03-15', note: '' }],
    ['7up 40', { amountMinor: 4_000, spentOn: '2025-03-15', note: '7up' }],
    ['450', { amountMinor: 45_000, spentOn: '2025-03-15', note: '' }],
    ['120.5 tea', { amountMinor: 12_050, spentOn: '2025-03-15', note: 'tea' }],
    ['tea Rs. 99.50', { amountMinor: 9_950, spentOn: '2025-03-15', note: 'tea' }],
    ['rs120 tea', { amountMinor: 12_000, spentOn: '2025-03-15', note: 'tea' }],
    ['5 saturday', { amountMinor: 500, spentOn: '2025-03-15', note: '' }],
    ['5 Monday', { amountMinor: 500, spentOn: '2025-03-10', note: '' }],
    ['5 ON 3RD', { amountMinor: 500, spentOn: '2025-03-03', note: '' }],
    ['5 28/02', { amountMinor: 500, spentOn: '2025-02-28', note: '' }],
    ['5 2024-02-29 leap', { amountMinor: 500, spentOn: '2024-02-29', note: 'leap' }],
  ])('parses %j', (line, expected) => {
    expect(entryOf(line)).toEqual(expected);
  });

  it('reads only ASCII digits after NFKC, so fullwidth digits count and Devanagari numerals stay note text', () => {
    expect(entryOf('１２０ coffee')).toEqual({ amountMinor: 12_000, spentOn: TODAY, note: 'coffee' });
    expect(entryOf('चाय 50')).toEqual({ amountMinor: 5_000, spentOn: TODAY, note: 'चाय' });
    expect(codesOf('५० चाय')).toEqual(['MISSING_AMOUNT']);
  });

  it('keeps the note as typed with whitespace runs collapsed and the ends trimmed', () => {
    expect(entryOf('  120   Cold \t Coffée  ').note).toBe('Cold Coffée');
  });

  it('treats a lone marker with no amount after it, and a mixed digit-letter token, as note text', () => {
    expect(entryOf('5 rs')).toMatchObject({ amountMinor: 500, note: 'rs' });
    expect(codesOf('120rs coffee')).toEqual(['MISSING_AMOUNT']);
  });

  it('uses the one marked candidate and keeps the others in the note in line order', () => {
    expect(entryOf('coffee ₹5 tea 6')).toMatchObject({ amountMinor: 500, note: 'coffee tea 6' });
    expect(entryOf('coffee 6 Rs 5')).toMatchObject({ amountMinor: 500, note: 'coffee 6' });
  });

  it('returns a number after `on` that is above 31 as the amount (Requirement 2.19)', () => {
    expect(entryOf('lunch on 45')).toEqual({ amountMinor: 4_500, spentOn: TODAY, note: 'lunch on' });
  });
});

describe('parseQuickAddLine: quoted text', () => {
  it('does not interpret an amount or date inside quotes', () => {
    expect(entryOf('120 "lunch on 3rd"')).toEqual({ amountMinor: 12_000, spentOn: TODAY, note: 'lunch on 3rd' });
    expect(entryOf('"7 eleven" 20')).toEqual({ amountMinor: 2_000, spentOn: TODAY, note: '7 eleven' });
  });

  it('reads a doubled quote inside quotes as one literal quote', () => {
    expect(entryOf('5 "say ""hi"""').note).toBe('say "hi"');
  });

  it('keeps a quote with no closing quote as ordinary note text', () => {
    expect(entryOf('5 "coffee').note).toBe('"coffee');
  });

  it('accepts an empty quoted segment', () => {
    expect(entryOf('5 ""').note).toBe('');
  });
});

describe('parseQuickAddLine: problems', () => {
  it('names the affected part, the reason, and the correction for each problem', () => {
    const [missing] = problemsOf('coffee');
    expect(missing).toMatchObject({ code: 'MISSING_AMOUNT', part: '' });

    const [multiple] = problemsOf('coffee 5, tea 6');
    expect(multiple?.code).toBe('MULTIPLE_AMOUNTS');
    expect(multiple?.reason).toContain('"5,"');
    expect(multiple?.reason).toContain('"6"');
    expect(multiple?.correction).toContain('₹');

    const [badDate] = problemsOf('5 31/02');
    expect(badDate).toMatchObject({ code: 'INVALID_DATE', subcode: 'NOT_A_DATE', part: '31/02' });

    const [badAmount] = problemsOf('1,2,3 tea');
    expect(badAmount).toMatchObject({ code: 'INVALID_AMOUNT', subcode: 'BAD_GROUPING', part: '1,2,3' });

    for (const problem of [missing, multiple, badDate, badAmount]) {
      expect(problem?.reason).not.toBe('');
      expect(problem?.correction).not.toBe('');
    }
  });

  it('reports each amount subcode and never rounds', () => {
    const subcodeOf = (line: string) => problemsOf(line)[0]?.subcode;
    expect(subcodeOf('120.555 tea')).toBe('TOO_MANY_DECIMALS');
    expect(subcodeOf('.5 tea')).toBe('NO_INTEGER_PART');
    expect(subcodeOf('5. tea')).toBe('TRAILING_POINT');
    expect(subcodeOf('₹ 0 tea')).toBe('ZERO');
    expect(subcodeOf('123456789012 tea')).toBe('TOO_LARGE');
  });

  it('does not count a `/-` suffix as a Currency_Marker', () => {
    expect(codesOf('coffee 5 tea 500/-')).toEqual(['MULTIPLE_AMOUNTS']);
    expect(codesOf('₹5 ₹6')).toEqual(['MULTIPLE_AMOUNTS']);
  });

  it('reports a date outside the accepted range with the range', () => {
    const [problem] = problemsOf('5 2000-01-01');
    expect(problem).toMatchObject({ code: 'INVALID_DATE', subcode: 'OUT_OF_RANGE', part: '2000-01-01' });
    expect(problem?.correction).toContain('1 January 2015 through 31 December 2026');
  });

  it('lists every date when there is more than one', () => {
    const [problem] = problemsOf('5 today yesterday');
    expect(problem?.code).toBe('MULTIPLE_DATES');
    expect(problem?.reason).toContain('"today"');
    expect(problem?.reason).toContain('"yesterday"');
  });

  it('collects the date, amount, and note problems together', () => {
    expect(codesOf(`0 31/02 ${'a'.repeat(MAX_NOTE_LENGTH + 1)}`)).toEqual(['INVALID_DATE', 'INVALID_AMOUNT', 'NOTE_TOO_LONG']);
  });
});

describe('parseQuickAddLine: limits', () => {
  it('accepts a 200-unit line and rejects a 201-unit line with the length and limit', () => {
    const ok = `5 ${'a'.repeat(MAX_LINE_LENGTH - 2 - 80)} ${'b'.repeat(79)}`;
    expect(ok).toHaveLength(MAX_LINE_LENGTH);
    // The line is exactly at the limit, so the only problem is the note length.
    expect(codesOf(ok)).toEqual(['NOTE_TOO_LONG']);

    const tooLong = `5 ${'a'.repeat(MAX_LINE_LENGTH - 1)}`;
    const [problem] = problemsOf(tooLong);
    expect(problem?.code).toBe('LINE_TOO_LONG');
    expect(problem?.reason).toContain(String(tooLong.length));
    expect(problem?.reason).toContain('200');
    expect(problemsOf(tooLong)).toHaveLength(1);
  });

  it('accepts a 120-unit note and rejects a 121-unit note with the length and limit', () => {
    expect(entryOf(`5 ${'a'.repeat(120)}`).note).toHaveLength(120);
    const [problem] = problemsOf(`5 ${'a'.repeat(121)}`);
    expect(problem?.code).toBe('NOTE_TOO_LONG');
    expect(problem?.reason).toContain('121');
    expect(problem?.reason).toContain('120');
  });
});

describe('parseQuickAddLine: never throws', () => {
  it('returns a non-empty problem list for an invalid Today instead of throwing', () => {
    for (const today of ['2025-02-30', '', 'today', '2025-3-1', '0000-01-01']) {
      const result = parseQuickAddLine('5 coffee yesterday', today);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.problems.length).toBeGreaterThan(0);
    }
  });

  it('returns a result for odd lines, and a non-empty problem list when it has no entry', () => {
    const odd = ['', ' ', '"', '""', '"""', '""""', 'on', 'on on 3', '₹', '₹ ₹', '/-', '.', ',', 'Rs.', '\u0000', '\ud800', '5 \ud800 x'];
    for (const line of odd) {
      const result = parseQuickAddLine(line, TODAY);
      if (!result.ok) expect(result.problems.length).toBeGreaterThan(0);
    }
  });

  it('is deterministic', () => {
    const line = 'swiggy ₹450 on 3rd "a ""b"""';
    expect(parseQuickAddLine(line, TODAY)).toEqual(parseQuickAddLine(line, TODAY));
  });
});

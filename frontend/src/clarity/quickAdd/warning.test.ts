import { describe, expect, it } from 'vitest';
import { BILL_MATCH_MIN_LABEL_LENGTH, classifyEntryWarning, type ClassifyEntryWarningInput } from './warning';

const TODAY = '2025-03-14';

function classify(overrides: {
  amountMinor?: number;
  spentOn?: string;
  note?: string;
  today?: string | null;
  billKeys?: readonly string[] | null;
  threshold?: number | null;
}) {
  const input: ClassifyEntryWarningInput = {
    entry: {
      amountMinor: overrides.amountMinor ?? 5000,
      spentOn: overrides.spentOn ?? TODAY,
      note: overrides.note ?? '',
    },
    today: 'today' in overrides ? overrides.today : TODAY,
    billKeys: 'billKeys' in overrides ? overrides.billKeys : [],
    largeEntryThresholdMinor: 'threshold' in overrides ? overrides.threshold : null,
  };
  return classifyEntryWarning(input);
}

describe('BILL_MATCH_MIN_LABEL_LENGTH', () => {
  it('is the named minimum label length for containment', () => {
    expect(BILL_MATCH_MIN_LABEL_LENGTH).toBe(3);
  });
});

describe('classifyEntryWarning: date', () => {
  it('returns none for an entry dated on another day even with both causes', () => {
    const base = { note: 'Rent', billKeys: ['Rent'], threshold: 100 };
    expect(classify({ ...base, amountMinor: 999999, spentOn: '2025-03-13' })).toEqual({ kind: 'none' });
    expect(classify({ ...base, amountMinor: 999999, spentOn: '2025-03-15' })).toEqual({ kind: 'none' });
  });

  it('returns none when Today is unavailable', () => {
    expect(classify({ note: 'Rent', billKeys: ['Rent'], today: null })).toEqual({ kind: 'none' });
    expect(classify({ note: 'Rent', billKeys: ['Rent'], today: '' })).toEqual({ kind: 'none' });
  });
});

describe('classifyEntryWarning: large entry', () => {
  it('warns when the amount equals the threshold', () => {
    expect(classify({ amountMinor: 100000, threshold: 100000 })).toEqual({ kind: 'warn', large: true });
  });

  it('warns above the threshold and not one paisa below it', () => {
    expect(classify({ amountMinor: 100001, threshold: 100000 })).toEqual({ kind: 'warn', large: true });
    expect(classify({ amountMinor: 99999, threshold: 100000 })).toEqual({ kind: 'none' });
  });

  it('skips the cause when the threshold is unavailable', () => {
    expect(classify({ amountMinor: 9_999_999_999_999, threshold: null })).toEqual({ kind: 'none' });
    expect(classify({ amountMinor: 9_999_999_999_999, threshold: undefined })).toEqual({ kind: 'none' });
  });

  it('skips a threshold that is not a safe integer', () => {
    expect(classify({ amountMinor: 500, threshold: Number.NaN })).toEqual({ kind: 'none' });
    expect(classify({ amountMinor: 500, threshold: 1.5 })).toEqual({ kind: 'none' });
    expect(classify({ amountMinor: 500, threshold: Number.POSITIVE_INFINITY })).toEqual({ kind: 'none' });
  });
});

describe('classifyEntryWarning: bill match', () => {
  it('names the label of an equal note, ignoring case and whitespace', () => {
    expect(classify({ note: '  HOME   rent ', billKeys: ['Home Rent'] })).toEqual({
      kind: 'warn',
      bill: 'Home Rent',
      large: false,
    });
  });

  it('matches equality at any label length, including one below the minimum', () => {
    const short = 'a'.repeat(BILL_MATCH_MIN_LABEL_LENGTH - 1);
    expect(classify({ note: short, billKeys: [short] })).toEqual({ kind: 'warn', bill: short, large: false });
    expect(classify({ note: 'ए', billKeys: ['ए'] })).toEqual({ kind: 'warn', bill: 'ए', large: false });
  });

  it('does not match containment for a label below the minimum length', () => {
    const short = 'a'.repeat(BILL_MATCH_MIN_LABEL_LENGTH - 1);
    expect(classify({ note: `paid ${short} today`, billKeys: [short] })).toEqual({ kind: 'none' });
    expect(classify({ note: 'paid ए today', billKeys: ['ए'] })).toEqual({ kind: 'none' });
  });

  it('matches containment for a label at the minimum length as a whole word', () => {
    const label = 'b'.repeat(BILL_MATCH_MIN_LABEL_LENGTH);
    expect(classify({ note: `paid ${label} today`, billKeys: [label] })).toEqual({
      kind: 'warn',
      bill: label,
      large: false,
    });
  });

  it('matches a phrase label at the start, middle, and end of the note', () => {
    const keys = ['Jio Fiber'];
    for (const note of ['jio fiber march', 'march jio fiber bill', 'march jio fiber']) {
      expect(classify({ note, billKeys: keys })).toEqual({ kind: 'warn', bill: 'Jio Fiber', large: false });
    }
  });

  it('does not match inside a longer word', () => {
    expect(classify({ note: 'parental leave', billKeys: ['rent'] })).toEqual({ kind: 'none' });
    expect(classify({ note: 'rents', billKeys: ['rent'] })).toEqual({ kind: 'none' });
    expect(classify({ note: 'current', billKeys: ['rent'] })).toEqual({ kind: 'none' });
    expect(classify({ note: 'rent2', billKeys: ['rent'] })).toEqual({ kind: 'none' });
  });

  it('treats punctuation as a word boundary', () => {
    expect(classify({ note: 'paid rent, thanks', billKeys: ['rent'] })).toEqual({
      kind: 'warn',
      bill: 'rent',
      large: false,
    });
  });

  it('finds a whole-word occurrence after an embedded one', () => {
    expect(classify({ note: 'current rent', billKeys: ['rent'] })).toEqual({ kind: 'warn', bill: 'rent', large: false });
  });

  it('respects combining marks and non-Latin scripts as word characters', () => {
    // "किराया" (rent) inside a longer Devanagari word does not match, as a separate word it does.
    expect(classify({ note: 'किरायाघर', billKeys: ['किराया'] })).toEqual({ kind: 'none' });
    expect(classify({ note: 'मार्च किराया दिया', billKeys: ['किराया'] })).toEqual({
      kind: 'warn',
      bill: 'किराया',
      large: false,
    });
    // A word ending before a combining mark is not a whole word.
    expect(classify({ note: 'cafe\u0301 bill', billKeys: ['cafe'] })).toEqual({ kind: 'none' });
  });

  it('does not depend on the Unicode normalization form or letter case', () => {
    expect(classify({ note: 'CAF\u00c9 bill', billKeys: ['cafe\u0301'] })).toEqual({
      kind: 'warn',
      bill: 'cafe\u0301',
      large: false,
    });
    expect(classify({ note: '\uff32\uff45\uff4e\uff54', billKeys: ['rent'] })).toEqual({
      kind: 'warn',
      bill: 'rent',
      large: false,
    });
  });

  it('returns the first matching label in list order', () => {
    expect(classify({ note: 'wifi rent', billKeys: ['rent', 'wifi'] })).toMatchObject({ bill: 'rent' });
    expect(classify({ note: 'wifi rent', billKeys: ['wifi', 'rent'] })).toMatchObject({ bill: 'wifi' });
  });

  it('ignores blank labels and an empty note', () => {
    expect(classify({ note: '', billKeys: ['', '   ', 'rent'] })).toEqual({ kind: 'none' });
    expect(classify({ note: 'rent', billKeys: ['', '   '] })).toEqual({ kind: 'none' });
  });

  it('skips the cause when the labels are unavailable', () => {
    expect(classify({ note: 'rent', billKeys: null })).toEqual({ kind: 'none' });
    expect(classify({ note: 'rent', billKeys: undefined })).toEqual({ kind: 'none' });
    expect(classify({ note: 'rent', billKeys: [] })).toEqual({ kind: 'none' });
  });
});

describe('classifyEntryWarning: both causes', () => {
  it('reports the bill and the large amount together', () => {
    expect(classify({ amountMinor: 2500000, note: 'Rent', billKeys: ['Rent'], threshold: 100000 })).toEqual({
      kind: 'warn',
      bill: 'Rent',
      large: true,
    });
  });

  it('keeps one cause when the other input is unavailable', () => {
    expect(classify({ amountMinor: 2500000, note: 'Rent', billKeys: null, threshold: 100000 })).toEqual({
      kind: 'warn',
      large: true,
    });
    expect(classify({ amountMinor: 2500000, note: 'Rent', billKeys: ['Rent'], threshold: null })).toEqual({
      kind: 'warn',
      bill: 'Rent',
      large: false,
    });
  });

  it('does not change the entry', () => {
    const entry = { amountMinor: 2500000, spentOn: TODAY, note: 'Rent' };
    const before = { ...entry };
    classifyEntryWarning({ entry, today: TODAY, billKeys: ['Rent'], largeEntryThresholdMinor: 100000 });
    expect(entry).toEqual(before);
  });
});

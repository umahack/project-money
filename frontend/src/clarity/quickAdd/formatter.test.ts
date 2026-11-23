import { describe, expect, it } from 'vitest';
import { formatQuickAddLine } from './formatter';

describe('formatQuickAddLine', () => {
  it('writes the amount, the date, and the quoted note', () => {
    expect(formatQuickAddLine({ amountMinor: 12_000, spentOn: '2025-03-04', note: 'coffee' })).toBe(
      '₹120 2025-03-04 "coffee"',
    );
  });

  it('omits the quotes when the note is empty', () => {
    expect(formatQuickAddLine({ amountMinor: 45_000, spentOn: '2025-03-04', note: '' })).toBe('₹450 2025-03-04');
  });

  it('uses Indian grouping', () => {
    expect(formatQuickAddLine({ amountMinor: 12_000_000, spentOn: '2025-03-04', note: '' })).toBe(
      '₹1,20,000 2025-03-04',
    );
    expect(formatQuickAddLine({ amountMinor: 999, spentOn: '2025-03-04', note: '' })).toBe('₹9.99 2025-03-04');
  });

  it('writes two fractional digits only when paise exist', () => {
    expect(formatQuickAddLine({ amountMinor: 12_050, spentOn: '2025-03-04', note: '' })).toBe('₹120.50 2025-03-04');
    expect(formatQuickAddLine({ amountMinor: 12_005, spentOn: '2025-03-04', note: '' })).toBe('₹120.05 2025-03-04');
    expect(formatQuickAddLine({ amountMinor: 12_100, spentOn: '2025-03-04', note: '' })).toBe('₹121 2025-03-04');
  });

  it('formats the largest accepted amount', () => {
    expect(formatQuickAddLine({ amountMinor: 9_999_999_999_999, spentOn: '2025-03-04', note: '' })).toBe(
      '₹99,99,99,99,999.99 2025-03-04',
    );
  });

  it('doubles a literal double quote in the note', () => {
    expect(formatQuickAddLine({ amountMinor: 100, spentOn: '2025-03-04', note: 'the "big" one' })).toBe(
      '₹1 2025-03-04 "the ""big"" one"',
    );
    expect(formatQuickAddLine({ amountMinor: 100, spentOn: '2025-03-04', note: '"' })).toBe('₹1 2025-03-04 """"');
  });

  it('keeps notes that look like amounts, dates, or other scripts inside the quotes', () => {
    expect(formatQuickAddLine({ amountMinor: 100, spentOn: '2025-03-04', note: '7up 40 on 3rd today' })).toBe(
      '₹1 2025-03-04 "7up 40 on 3rd today"',
    );
    expect(formatQuickAddLine({ amountMinor: 100, spentOn: '2025-03-04', note: 'చాయ్ चाय' })).toBe(
      '₹1 2025-03-04 "చాయ్ चाय"',
    );
  });

  it('rejects an amount that is not a positive safe integer', () => {
    for (const amountMinor of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => formatQuickAddLine({ amountMinor, spentOn: '2025-03-04', note: '' })).toThrow(RangeError);
    }
  });

  it('rejects a date that is not a real YYYY-MM-DD date', () => {
    for (const spentOn of ['2025-02-30', '2025-3-4', '', 'today']) {
      expect(() => formatQuickAddLine({ amountMinor: 100, spentOn, note: '' })).toThrow(RangeError);
    }
  });
});

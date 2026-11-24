import { describe, expect, it } from 'vitest';
import {
  AMOUNT_RANGE_TEXT,
  MAX_AMOUNT_MINOR,
  convertAmountBody,
  convertAmountCandidate,
  formatInr,
  formatInrDigits,
  isCurrencyMarkerToken,
  readAmountCandidate,
} from './amount';

/** Reads a whole token and converts it, the way the parser will. */
function amountOf(token: string, precededByMarker = false) {
  const candidate = readAmountCandidate(token, precededByMarker);
  return candidate ? convertAmountCandidate(candidate) : null;
}

describe('readAmountCandidate', () => {
  it('reads plain, grouped, and decimal numbers', () => {
    expect(amountOf('120')).toEqual({ ok: true, amountMinor: 12000 });
    expect(amountOf('25,000')).toEqual({ ok: true, amountMinor: 2500000 });
    expect(amountOf('1,20,000')).toEqual({ ok: true, amountMinor: 12000000 });
    expect(amountOf('1,200,000')).toEqual({ ok: true, amountMinor: 120000000 });
    expect(amountOf('120.50')).toEqual({ ok: true, amountMinor: 12050 });
    expect(amountOf('0.05')).toEqual({ ok: true, amountMinor: 5 });
  });

  it('reads one fractional digit as tenths of a rupee', () => {
    expect(amountOf('120.5')).toEqual({ ok: true, amountMinor: 12050 });
    expect(amountOf('0.5')).toEqual({ ok: true, amountMinor: 50 });
  });

  it('accepts a marker attached to the number and the /- suffix', () => {
    for (const token of ['₹120', 'Rs120', 'rs.120', 'Rs.120', 'INR120', 'inr120', '120/-', '₹120/-', 'Rs.120/-']) {
      const candidate = readAmountCandidate(token);
      expect(candidate, token).not.toBeNull();
      expect(convertAmountCandidate(candidate!), token).toEqual({ ok: true, amountMinor: 12000 });
    }
    expect(amountOf('₹1,20,000/-')).toEqual({ ok: true, amountMinor: 12000000 });
  });

  it('reports which candidates carry a marker or suffix', () => {
    expect(readAmountCandidate('120')).toMatchObject({ hasMarker: false, hasSuffix: false, body: '120' });
    expect(readAmountCandidate('₹120')).toMatchObject({ hasMarker: true, hasSuffix: false });
    expect(readAmountCandidate('500/-')).toMatchObject({ hasMarker: false, hasSuffix: true, body: '500' });
    expect(readAmountCandidate('120', true)).toMatchObject({ hasMarker: true });
  });

  it('keeps the token as typed in raw', () => {
    expect(readAmountCandidate('Rs.120/-')?.raw).toBe('Rs.120/-');
  });

  it('treats mixed digit-and-letter tokens and words as note text', () => {
    for (const token of ['7up', 'route66', '3pm', '120rs', 'coffee', 'rs', '₹', '/-', '-', '.', ',', '', '₹₹5']) {
      expect(readAmountCandidate(token), token).toBeNull();
    }
  });

  it('accepts fullwidth ASCII digits after NFKC but not other script numerals', () => {
    expect(amountOf('１２０')).toEqual({ ok: true, amountMinor: 12000 });
    expect(readAmountCandidate('१२०')).toBeNull(); // Devanagari
    expect(readAmountCandidate('౧౨౦')).toBeNull(); // Telugu
    expect(readAmountCandidate('١٢٠')).toBeNull(); // Arabic-Indic
  });

  it('recognizes lone Currency_Marker tokens in any letter case', () => {
    for (const token of ['₹', 'Rs', 'rs.', 'INR', 'Inr', 'RS.']) expect(isCurrencyMarkerToken(token), token).toBe(true);
    for (const token of ['rsx', '120', 'rupees', '']) expect(isCurrencyMarkerToken(token), token).toBe(false);
  });
});

describe('convertAmountBody problems', () => {
  const subcodeOf = (body: string) => {
    const result = convertAmountBody(body);
    return result.ok ? 'OK' : result.subcode;
  };

  it('rejects inconsistent comma grouping', () => {
    for (const body of ['1,2', '12,34', '1,2,3', '1,23,45', '1234,567', '1,00,0', '120,', ',500', '12,3456', '1,234,56,789']) {
      expect(subcodeOf(body), body).toBe('BAD_GROUPING');
    }
  });

  it('rejects a missing integer part and a trailing point', () => {
    expect(subcodeOf('.5')).toBe('NO_INTEGER_PART');
    expect(subcodeOf(',.5')).toBe('NO_INTEGER_PART');
    expect(subcodeOf('5.')).toBe('TRAILING_POINT');
    expect(subcodeOf('1,000.')).toBe('TRAILING_POINT');
  });

  it('rejects more than two fractional digits without rounding or truncating', () => {
    expect(subcodeOf('1.234')).toBe('TOO_MANY_DECIMALS');
    expect(subcodeOf('120.999')).toBe('TOO_MANY_DECIMALS');
    expect(subcodeOf('0.001')).toBe('TOO_MANY_DECIMALS');
  });

  it('rejects zero and values above the accepted range', () => {
    for (const body of ['0', '00', '0.0', '0.00', '000.00']) expect(subcodeOf(body), body).toBe('ZERO');
    expect(subcodeOf('100000000000')).toBe('TOO_LARGE'); // 12 digits
    expect(subcodeOf('1,00,00,00,00,000')).toBe('TOO_LARGE');
    expect(subcodeOf('000000000001')).toBe('TOO_LARGE'); // digits are counted as typed
  });

  it('accepts the largest and smallest amounts', () => {
    expect(convertAmountBody('99999999999.99')).toEqual({ ok: true, amountMinor: MAX_AMOUNT_MINOR });
    expect(convertAmountBody('99,99,99,99,999.99')).toEqual({ ok: true, amountMinor: MAX_AMOUNT_MINOR });
    expect(convertAmountBody('99,999,999,999.99')).toEqual({ ok: true, amountMinor: MAX_AMOUNT_MINOR });
    expect(convertAmountBody('0.01')).toEqual({ ok: true, amountMinor: 1 });
    expect(Number.isSafeInteger(MAX_AMOUNT_MINOR)).toBe(true);
  });

  it('names the token and states a correction; range problems state the accepted range', () => {
    const grouping = convertAmountBody('1,2', '1,2');
    expect(grouping.ok).toBe(false);
    if (!grouping.ok) {
      expect(grouping.reason).toContain('"1,2"');
      expect(grouping.correction.length).toBeGreaterThan(0);
    }
    for (const body of ['0', '123456789012']) {
      const result = convertAmountBody(body);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.correction).toContain(AMOUNT_RANGE_TEXT);
    }
  });

  it('reports the problem for a token read from a line', () => {
    const result = amountOf('Rs1,2.345');
    expect(result).toMatchObject({ ok: false, subcode: 'BAD_GROUPING' });
    if (result && !result.ok) expect(result.reason).toContain('Rs1,2.345');
  });
});

describe('formatInr', () => {
  it('groups the Indian way', () => {
    expect(formatInrDigits(0)).toBe('0');
    expect(formatInrDigits(100)).toBe('1');
    expect(formatInrDigits(99900)).toBe('999');
    expect(formatInrDigits(100000)).toBe('1,000');
    expect(formatInrDigits(2500000)).toBe('25,000');
    expect(formatInrDigits(12000000)).toBe('1,20,000');
    expect(formatInrDigits(1000000000)).toBe('1,00,00,000');
    expect(formatInrDigits(MAX_AMOUNT_MINOR)).toBe('99,99,99,99,999.99');
  });

  it('shows two fractional digits only when paise exist', () => {
    expect(formatInrDigits(12000)).toBe('120');
    expect(formatInrDigits(12050)).toBe('120.50');
    expect(formatInrDigits(5)).toBe('0.05');
    expect(formatInrDigits(12000005)).toBe('1,20,000.05');
  });

  it('adds the rupee sign and handles negative values', () => {
    expect(formatInr(12000000)).toBe('₹1,20,000');
    expect(formatInr(12050)).toBe('₹120.50');
    expect(formatInr(-50000)).toBe('-₹500');
    expect(formatInr(0)).toBe('₹0');
  });

  it('refuses values that are not safe integers', () => {
    for (const value of [1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => formatInr(value), String(value)).toThrow(RangeError);
    }
  });

  it('round-trips through the grammar with and without a marker', () => {
    for (const minor of [1, 5, 99, 100, 12050, 99999, 100000, 12000000, 123456789, MAX_AMOUNT_MINOR]) {
      const digits = formatInrDigits(minor);
      expect(amountOf(digits), digits).toEqual({ ok: true, amountMinor: minor });
      expect(amountOf(formatInr(minor)), formatInr(minor)).toEqual({ ok: true, amountMinor: minor });
    }
  });
});

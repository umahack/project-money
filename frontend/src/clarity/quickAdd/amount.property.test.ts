import { describe, expect, it } from 'vitest';
import { fc } from '../../test/test-utils';
import { assertProperty } from '../../test/propertyReport';
import {
  MAX_AMOUNT_MINOR as REFERENCE_MAX_AMOUNT_MINOR,
  invalidAmountTokenArb,
  noteWordArb,
  paiseArb,
  validDateArb,
  writeAmount,
  writtenAmountArb,
  type Grouping,
} from '../../test/quickAddGenerators';
import {
  convertAmountCandidate,
  formatInr,
  formatInrDigits,
  isCurrencyMarkerToken,
  readAmountCandidate,
  type AmountResult,
} from './amount';
import { parseQuickAddLine } from './parser';

/*
 * Feature: quick-add-daily-answer, Property 2: Amount notation and grouping round trip
 *
 * Validates: Requirements 2.5, 2.7, 2.8, 2.9, 2.10, 2.11, 17.2, 17.3
 *
 * Reference model: `writeAmount` in test/quickAddGenerators.ts writes a paise value as text (Indian, Western, or
 * no grouping, every marker form, `/-`) without importing the module under test. The expected result of reading
 * that text is the paise value that was written. The invalid tokens come from `invalidAmountTokenArb`, which
 * states the rule each token breaks. The size and zero expectations below are computed from integers here.
 */

const RUNS = 200;

/** Reads written amount text token by token, the way the parser does: a marker with a space is its own token. */
function readWritten(text: string): { result: AmountResult; hasMarker: boolean; hasSuffix: boolean } | null {
  const space = text.indexOf(' ');
  let candidate;
  if (space === -1) {
    candidate = readAmountCandidate(text);
  } else {
    const marker = text.slice(0, space);
    if (!isCurrencyMarkerToken(marker)) return null;
    candidate = readAmountCandidate(text.slice(space + 1), true);
  }
  if (!candidate) return null;
  return { result: convertAmountCandidate(candidate), hasMarker: candidate.hasMarker, hasSuffix: candidate.hasSuffix };
}

const noteBeforeOrAfterArb = fc.record({
  note: fc.option(noteWordArb(), { nil: '' }),
  position: fc.constantFrom('before', 'after'),
});

function lineWith(amountText: string, note: string, position: string): string {
  if (note === '') return amountText;
  return position === 'before' ? `${note} ${amountText}` : `${amountText} ${note}`;
}

describe('Property 2: amount notation and grouping round trip', () => {
  it('reads every written form (grouping, marker, suffix) back to the original paise', () => {
    assertProperty(
      fc.property(writtenAmountArb, (written) => {
        const read = readWritten(written.text);
        expect(read).not.toBeNull();
        expect(read?.result).toEqual({ ok: true, amountMinor: written.paise });
        expect(read?.hasMarker).toBe(written.marker !== '');
        expect(read?.hasSuffix).toBe(written.suffix === '/-');
      }),
      { numRuns: RUNS },
    );
  });

  it('parses a line holding every written form back to the original paise, dated Today, with the note intact', () => {
    assertProperty(
      fc.property(writtenAmountArb, noteBeforeOrAfterArb, validDateArb(), (written, { note, position }, today) => {
        const result = parseQuickAddLine(lineWith(written.text, note, position), today);
        expect(result).toEqual({ ok: true, entry: { amountMinor: written.paise, spentOn: today, note } });
      }),
      { numRuns: RUNS },
    );
  });

  it('reads Indian, Western, and ungrouped writings of one value to the same paise', () => {
    assertProperty(
      fc.property(paiseArb, fc.constantFrom('always', 'minimal'), (paise, fraction) => {
        const readings = (['indian', 'western', 'none'] as const).map((grouping) => {
          const read = readWritten(writeAmount(paise, { grouping, fraction }));
          return read?.result;
        });
        for (const reading of readings) expect(reading).toEqual({ ok: true, amountMinor: paise });
      }),
      { numRuns: RUNS },
    );
  });

  it('formats paise with Indian grouping that reads back to the same paise', () => {
    assertProperty(
      fc.property(paiseArb, (paise) => {
        // Independent expectation: Indian grouping, two fractional digits only when paise exist.
        const expected = writeAmount(paise, { grouping: 'indian', fraction: paise % 100 === 0 ? 'minimal' : 'always' });
        expect(formatInrDigits(paise)).toBe(expected);
        expect(formatInr(paise)).toBe(`₹${expected}`);
        for (const text of [formatInrDigits(paise), formatInr(paise)]) {
          expect(readWritten(text)?.result).toEqual({ ok: true, amountMinor: paise });
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('reads one fractional digit as tenths of a rupee in any grouping', () => {
    const tenthsArb = fc
      .record({
        whole: fc.integer({ min: 0, max: 99_999_999_999 }),
        tenth: fc.integer({ min: 0, max: 9 }),
        grouping: fc.constantFrom<Grouping>('none', 'indian', 'western'),
      })
      .filter(({ whole, tenth }) => whole > 0 || tenth > 0);
    assertProperty(
      fc.property(tenthsArb, ({ whole, tenth, grouping }) => {
        const integerText = writeAmount(whole * 100, { grouping, fraction: 'minimal' });
        const read = readWritten(`${integerText}.${tenth}`);
        expect(read?.result).toEqual({ ok: true, amountMinor: whole * 100 + tenth * 10 });
      }),
      { numRuns: RUNS },
    );
  });

  it('counts leading zeros as typed digits and checks size before zero', () => {
    const typedArb = fc
      .record({
        whole: fc.integer({ min: 0, max: 99_999_999_999 }),
        extraZeros: fc.integer({ min: 0, max: 4 }),
        fraction: fc.constantFrom('', '0', '5', '07', '50', '99', '00'),
      });
    assertProperty(
      fc.property(typedArb, ({ whole, extraZeros, fraction }) => {
        const integerText = `${'0'.repeat(extraZeros)}${whole}`;
        const typedDigits = integerText.length;
        const paise = whole * 100 + Number(fraction.padEnd(2, '0'));
        const read = readWritten(fraction === '' ? integerText : `${integerText}.${fraction}`);
        expect(read).not.toBeNull();
        if (typedDigits > 11) {
          expect(read?.result).toMatchObject({ ok: false, subcode: 'TOO_LARGE' });
        } else if (paise === 0) {
          expect(read?.result).toMatchObject({ ok: false, subcode: 'ZERO' });
        } else {
          expect(read?.result).toEqual({ ok: true, amountMinor: paise });
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('accepts the maximum amount and refuses one more integer digit', () => {
    expect(readWritten('99999999999.99')?.result).toEqual({ ok: true, amountMinor: REFERENCE_MAX_AMOUNT_MINOR });
    expect(readWritten('99,99,99,99,999.99')?.result).toEqual({ ok: true, amountMinor: REFERENCE_MAX_AMOUNT_MINOR });
    expect(readWritten('100000000000')?.result).toMatchObject({ ok: false, subcode: 'TOO_LARGE' });
  });

  const wrapperArb = fc.record({
    marker: fc.constantFrom('', '₹', 'Rs', 'rs.', 'INR'),
    separate: fc.boolean(),
    suffix: fc.constantFrom('', '/-'),
  });

  /**
   * Wraps an invalid token in a marker and suffix. `Rs` directly followed by a token that starts with a point reads
   * as the marker `Rs.` plus the digits (`Rs.5`), so that one combination is written with a space instead.
   */
  function wrapInvalid(tokenText: string, marker: string, separate: boolean, suffix: string): string {
    const space = marker !== '' && (separate || (marker.toLowerCase() === 'rs' && tokenText.startsWith('.')));
    return `${marker}${space ? ' ' : ''}${tokenText}${suffix}`;
  }

  it('reports invalid tokens with the expected subcode at the reader and converter, never rounding or truncating', () => {
    assertProperty(
      fc.property(invalidAmountTokenArb, wrapperArb, (token, { marker, separate, suffix }) => {
        const read = readWritten(wrapInvalid(token.text, marker, separate, suffix));
        expect(read).not.toBeNull();
        expect(read?.result.ok).toBe(false);
        expect(read?.result).toMatchObject({ ok: false, subcode: token.subcode });
      }),
      { numRuns: RUNS },
    );
  });

  it('returns an invalid-amount problem and no entry for an invalid token inside a line', () => {
    assertProperty(
      fc.property(invalidAmountTokenArb, wrapperArb, noteBeforeOrAfterArb, validDateArb(), (token, wrapper, noteSpec, today) => {
        const { marker, separate, suffix } = wrapper;
        const amountText = wrapInvalid(token.text, marker, separate, suffix);
        const result = parseQuickAddLine(lineWith(amountText, noteSpec.note, noteSpec.position), today);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.problems.length).toBeGreaterThan(0);
        const amountProblems = result.problems.filter((problem) => problem.code === 'INVALID_AMOUNT');
        expect(amountProblems).toHaveLength(1);
        expect(amountProblems[0]).toMatchObject({ subcode: token.subcode });
        expect(amountProblems[0]?.part.endsWith(`${token.text}${suffix}`)).toBe(true);
      }),
      { numRuns: RUNS },
    );
  });

  it('applies the checks in the order integer part, fraction, size, zero when a token breaks several rules', () => {
    const cases: Array<[string, string]> = [
      ['.456', 'NO_INTEGER_PART'],
      ['1,2,3.456', 'BAD_GROUPING'],
      ['12,34.', 'BAD_GROUPING'],
      ['000000000000.', 'TRAILING_POINT'],
      ['000000000000.123', 'TOO_MANY_DECIMALS'],
      ['0.000', 'TOO_MANY_DECIMALS'],
      ['000000000000', 'TOO_LARGE'],
      ['0.00', 'ZERO'],
    ];
    for (const [token, subcode] of cases) {
      expect(readWritten(token)?.result, token).toMatchObject({ ok: false, subcode });
    }
  });
});

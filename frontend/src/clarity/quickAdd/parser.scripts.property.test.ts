import { describe, expect, it } from 'vitest';
import { fc } from '../../test/test-utils';
import { assertProperty } from '../../test/propertyReport';
import {
  MAX_LINE_UNITS,
  MAX_NOTE_UNITS,
  TRICKY_NOTE_WORDS,
  SCRIPT_WORD_ARBS,
  anyRealDateArb,
  collapseWhitespace,
  noteWordArb,
  whitespaceRunArb,
  writeAmount,
  writtenAmountArb,
  type FractionStyle,
  type Grouping,
} from '../../test/quickAddGenerators';
import { parseQuickAddLine, type ParseResult } from './parser';

/*
 * Feature: quick-add-daily-answer, Property 6: Notes in any script survive unchanged and only ASCII digits are numerals
 *
 * Validates: Requirements 2.31, 2.34, 2.35, 6.19
 *
 * Statement (design.md): for a note made of Devanagari, Telugu, or Latin text (with combining marks, joiners, and
 * non-ASCII digits) and any amount, the line formed from the amount and the note in either order parses to the same
 * amount and a note equal to the typed note with whitespace collapsed, with no Unicode normalization applied; and a
 * token made only of non-ASCII digits is note text, never an amount.
 *
 * Reference model: `modelLine` below re-derives the outcome of a line from the requirements and shares nothing with
 * the parser. It splits the line into quoted segments and whitespace-delimited words, folds each word with NFKC and
 * lower-casing, and calls a word an amount only when the folded text matches one regular expression whose digits are
 * the ASCII characters 0 to 9 (a lone marker word attaches to the next word when that one is an amount). It builds
 * the amount with BigInt from the digit string and the note from the words nobody claimed. The generators build the
 * expected note by construction as well, so the parser, the model, and the construction must agree.
 *
 * Scope of the generated lines: no date words, no ordinals, no stray quotes, exactly one amount or none. Dates,
 * amount grammar errors, and quote handling belong to Properties 1, 2, 3, and 5.
 *
 * Limits are in UTF-16 code units: a line of at most 200 and a note of at most 120, with astral characters counting
 * as two units.
 */

const RUNS = 300;

/* ----------------------------------------------------------- digit sets */

/** First code point of the zero digit of several non-ASCII decimal digit blocks. */
const NON_ASCII_ZEROS: readonly number[] = [
  0x0660, // Arabic-Indic
  0x06f0, // Extended Arabic-Indic
  0x0966, // Devanagari
  0x09e6, // Bengali
  0x0a66, // Gurmukhi
  0x0ae6, // Gujarati
  0x0b66, // Odia
  0x0be6, // Tamil
  0x0c66, // Telugu
  0x0ce6, // Kannada
  0x0d66, // Malayalam
  0x0e50, // Thai
];

const nonAsciiDigitsArb: fc.Arbitrary<string> = fc
  .array(fc.tuple(fc.constantFrom(...NON_ASCII_ZEROS), fc.integer({ min: 0, max: 9 })), { minLength: 1, maxLength: 8 })
  .map((digits) => digits.map(([zero, value]) => String.fromCodePoint(zero + value)).join(''));

const asciiDigitsArb: fc.Arbitrary<string> = fc.stringMatching(/^[0-9]{1,6}$/);

type NonAsciiForm = 'plain' | 'grouped' | 'decimal' | 'rupee' | 'rs' | 'suffix' | 'rupeeSuffix';

/** A token whose digits are all non-ASCII, bare or dressed like an amount (grouping, point, marker, `/-`). */
const nonAsciiNumeralTokenArb: fc.Arbitrary<string> = fc
  .record({
    digits: nonAsciiDigitsArb,
    form: fc.constantFrom<NonAsciiForm>('plain', 'plain', 'grouped', 'decimal', 'rupee', 'rs', 'suffix', 'rupeeSuffix'),
  })
  .map(({ digits, form }) => {
    switch (form) {
      case 'plain': return digits;
      case 'grouped': return [...digits].join(',');
      case 'decimal': return `${digits}.${digits.slice(0, 2)}`;
      case 'rupee': return `\u20b9${digits}`;
      case 'rs': return `Rs.${digits}`;
      case 'suffix': return `${digits}/-`;
      default: return `\u20b9${digits}/-`;
    }
  });

/* --------------------------------------------------------- note tokens */

/** Words that Unicode normalization would change, so that a normalized note would differ from the typed one. */
const NORMALIZATION_SENSITIVE_WORDS: readonly string[] = [
  '\u0958\u0932', // Devanagari qa, a composition exclusion that NFC and NFKC rewrite as ka + nukta
  '\u0929', // Devanagari nnna
  '\u0c48', // Telugu ai vowel sign, canonically ec46 + 0c56
  '\u0915\u094d\u200d\u0937', // conjunct with a joiner
  '\u0c15\u0c4d\u200c\u0c37', // conjunct with a non-joiner
  '\ufb01nance', // fi ligature
  '\uff43\uff41\uff46\u00e9', // fullwidth letters
  '\u212bngstr\u00f6m', // Angstrom sign
  'm\u00b2',
  'km\u00b3',
  'cafe\u0301',
  'caf\u00e9',
];

/** Latin suffixes that are not ordinal suffixes, so that `<digits><suffix>` is never a date. */
const LATIN_AFTER_DIGITS: readonly string[] = ['up', 'pm', 'am', 'rs', 'kg', 'km', 'gb', 'bhk', 'x', 'cab', 'lunch'];
/** Latin prefixes that are not Currency_Markers, so that `<prefix><digits>` is never an amount. */
const LATIN_BEFORE_DIGITS: readonly string[] = ['route', 'room', 'bus', 'wifi', 'a', 'b', 'cab', 'gate', 'flat'];

const indicWordArb: fc.Arbitrary<string> = fc.oneof(SCRIPT_WORD_ARBS.devanagari, SCRIPT_WORD_ARBS.telugu);

/** Digits of ASCII and another script together, for example `\u0967\u09680`. */
const mixedScriptDigitsArb: fc.Arbitrary<string> = fc
  .tuple(asciiDigitsArb, nonAsciiDigitsArb, fc.boolean())
  .map(([ascii, other, asciiFirst]) => (asciiFirst ? `${ascii}${other}${ascii.slice(0, 1)}` : `${other}${ascii}${other.slice(0, 1)}`));

/** A token that mixes ASCII digits with letters or other numerals. It is never an amount or a date. */
const mixedToken: fc.Arbitrary<string> = fc.oneof(
  fc.tuple(asciiDigitsArb, fc.constantFrom(...LATIN_AFTER_DIGITS)).map(([digits, word]) => `${digits}${word}`),
  fc.tuple(fc.constantFrom(...LATIN_BEFORE_DIGITS), asciiDigitsArb).map(([word, digits]) => `${word}${digits}`),
  fc.tuple(fc.constantFrom(...LATIN_BEFORE_DIGITS), asciiDigitsArb, fc.constantFrom(...LATIN_AFTER_DIGITS))
    .map(([head, digits, tail]) => `${head}${digits}${tail}`),
  fc.tuple(asciiDigitsArb, indicWordArb).map(([digits, word]) => `${digits}${word}`),
  fc.tuple(indicWordArb, asciiDigitsArb).map(([word, digits]) => `${word}${digits}`),
  fc.tuple(nonAsciiDigitsArb, fc.constantFrom(...LATIN_AFTER_DIGITS, 'th', 'rd')).map(([digits, word]) => `${digits}${word}`),
  mixedScriptDigitsArb,
);

const knownMixedTokens: readonly string[] = ['7up', 'route66', '120rs', '3pm', '5\u091a\u093e\u092f', '\u0c1f\u0c40\u0967'];

/** Any token a note may contain. */
const noteTokenArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 5, arbitrary: noteWordArb() },
  { weight: 1, arbitrary: fc.constantFrom(...NORMALIZATION_SENSITIVE_WORDS) },
  { weight: 3, arbitrary: nonAsciiNumeralTokenArb },
  { weight: 3, arbitrary: mixedToken },
  { weight: 1, arbitrary: fc.constantFrom(...knownMixedTokens) },
);

/** Inside a quoted segment even words the parser would read as dates, markers, or amounts stay note text. */
const quotedTokenArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 4, arbitrary: noteTokenArb },
  { weight: 3, arbitrary: fc.constantFrom(...TRICKY_NOTE_WORDS.filter((word) => !word.includes('"'))) },
  { weight: 2, arbitrary: asciiDigitsArb },
);

/* ------------------------------------------------------ line assembling */

interface Layout {
  position: 'before' | 'after' | 'middle';
  middle: number;
  seps: string[];
  lead: string;
  trail: string;
}

const optionalSpaceArb: fc.Arbitrary<string> = fc.oneof(fc.constant(''), whitespaceRunArb);

const layoutArb: fc.Arbitrary<Layout> = fc.record({
  position: fc.constantFrom<Layout['position']>('before', 'after', 'middle'),
  middle: fc.nat(8),
  seps: fc.array(whitespaceRunArb, { minLength: 12, maxLength: 12 }),
  lead: optionalSpaceArb,
  trail: optionalSpaceArb,
});

/** Joins pieces with the layout's whitespace runs. The amount text goes before, after, or inside the note tokens. */
function assemble(tokens: readonly string[], amountText: string | null, layout: Layout): string {
  const pieces = [...tokens];
  if (amountText !== null) {
    const at = layout.position === 'before' ? 0 : layout.position === 'after' ? pieces.length : Math.min(layout.middle, pieces.length);
    pieces.splice(at, 0, amountText);
  }
  const body = pieces.map((piece, index) => (index < pieces.length - 1 ? `${piece}${layout.seps[index] ?? ' '}` : piece)).join('');
  return `${layout.lead}${body}${layout.trail}`;
}

function within(line: string, note: string): boolean {
  return line.length <= MAX_LINE_UNITS && note.length <= MAX_NOTE_UNITS;
}

/* ------------------------------------------------------ reference model */

interface ModelOutcome {
  amountCount: number;
  amountMinor: number | null;
  note: string;
}

const MODEL_AMOUNT = /^(?:(₹|rs\.|rs|inr))?([0-9][0-9,]*(?:\.[0-9]{1,2})?)(?:\/-)?$/;
const MODEL_LONE_MARKERS = new Set(['₹', 'rs', 'rs.', 'inr']);

function foldWord(word: string): string {
  return word.normalize('NFKC').toLowerCase();
}

/** The paise of a word that is an amount (ASCII digits after NFKC), or null. */
function modelAmountOf(word: string): { marked: boolean; paise: bigint } | null {
  const match = MODEL_AMOUNT.exec(foldWord(word));
  if (!match) return null;
  const [whole = '', fraction = ''] = (match[2] as string).replace(/,/g, '').split('.');
  return { marked: match[1] !== undefined, paise: BigInt(whole + fraction.padEnd(2, '0')) };
}

/** Lines of this file have no dates, no stray quotes, and at most one amount. */
function modelLine(line: string): ModelOutcome {
  const items = [...line.matchAll(/"([^"]*)"|[^\s"]+/g)].map((match) => ({
    quoted: match[1] !== undefined,
    text: match[1] !== undefined ? match[1] : match[0],
  }));
  const noteParts: string[] = [];
  const amounts: Array<{ marked: boolean; paise: bigint }> = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i] as { quoted: boolean; text: string };
    const next = items[i + 1];
    if (item.quoted) {
      noteParts.push(item.text);
      continue;
    }
    if (next !== undefined && !next.quoted && MODEL_LONE_MARKERS.has(foldWord(item.text))) {
      const attached = modelAmountOf(next.text);
      if (attached) {
        amounts.push({ marked: true, paise: attached.paise });
        i += 1;
        continue;
      }
    }
    const amount = modelAmountOf(item.text);
    if (amount) amounts.push(amount);
    else noteParts.push(item.text);
  }
  return {
    amountCount: amounts.length,
    amountMinor: amounts.length === 1 ? Number((amounts[0] as { paise: bigint }).paise) : null,
    note: noteParts.join(' ').replace(/\s+/g, ' ').trim(),
  };
}

/* ---------------------------------------------------------- the checks */

function problemCodes(result: ParseResult): string[] {
  return result.ok ? [] : result.problems.map((problem) => problem.code);
}

/**
 * Parser, model, and construction must agree. `expectedPaise` is null when the line holds no ASCII-digit amount,
 * and then the only problem is the missing amount (no invalid amount, no multiple amounts).
 */
function expectOutcome(line: string, today: string, expectedNote: string, expectedPaise: number | null): void {
  const result = parseQuickAddLine(line, today);
  const model = modelLine(line);
  expect(model.note).toBe(expectedNote);
  if (expectedPaise === null) {
    expect(model.amountCount).toBe(0);
    expect(problemCodes(result)).toEqual(['MISSING_AMOUNT']);
    return;
  }
  expect(model.amountMinor).toBe(expectedPaise);
  expect(result).toEqual({ ok: true, entry: { amountMinor: expectedPaise, spentOn: today, note: expectedNote } });
}

/* ------------------------------------------------------------------ tests */

describe('Feature: quick-add-daily-answer, Property 6: Notes in any script survive unchanged and only ASCII digits are numerals', () => {
  it('uses non-ASCII digit sets that NFKC does not turn into ASCII digits', () => {
    for (const zero of NON_ASCII_ZEROS) {
      for (let value = 0; value <= 9; value += 1) {
        const digit = String.fromCodePoint(zero + value);
        expect(digit.normalize('NFKC')).toBe(digit);
        expect(/[0-9]/.test(digit)).toBe(false);
      }
    }
  });

  it('keeps a note in any script exactly as typed, whitespace collapsed, when an amount comes before, after, or inside it', () => {
    assertProperty(
      fc.property(
        fc.record({
          today: anyRealDateArb,
          tokens: fc.array(noteTokenArb, { minLength: 0, maxLength: 6 }),
          amount: writtenAmountArb,
          layout: layoutArb,
        }),
        ({ today, tokens, amount, layout }) => {
          const line = assemble(tokens, amount.text, layout);
          const expectedNote = tokens.join(' ');
          fc.pre(within(line, expectedNote));
          expectOutcome(line, today, expectedNote, amount.paise);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('keeps a quoted note in any script as typed, even when it holds ASCII numerals, markers, or date words', () => {
    assertProperty(
      fc.property(
        fc.record({
          today: anyRealDateArb,
          tokens: fc.array(quotedTokenArb, { minLength: 1, maxLength: 6 }),
          innerSeps: fc.array(whitespaceRunArb, { minLength: 8, maxLength: 8 }),
          innerLead: optionalSpaceArb,
          innerTrail: optionalSpaceArb,
          amount: writtenAmountArb,
          before: fc.boolean(),
          gap: whitespaceRunArb,
        }),
        ({ today, tokens, innerSeps, innerLead, innerTrail, amount, before, gap }) => {
          const inner = tokens.map((token, index) => (index < tokens.length - 1 ? `${token}${innerSeps[index] ?? ' '}` : token)).join('');
          const quoted = `"${innerLead}${inner}${innerTrail}"`;
          const line = before ? `${amount.text}${gap}${quoted}` : `${quoted}${gap}${amount.text}`;
          const expectedNote = collapseWhitespace(`${innerLead}${inner}${innerTrail}`);
          expect(expectedNote).toBe(tokens.join(' '));
          fc.pre(within(line, expectedNote));
          expectOutcome(line, today, expectedNote, amount.paise);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('reads a token made only of non-ASCII digits as note text, never as an amount', () => {
    assertProperty(
      fc.property(
        fc.record({
          today: anyRealDateArb,
          numerals: fc.array(nonAsciiNumeralTokenArb, { minLength: 1, maxLength: 4 }),
          words: fc.array(noteWordArb(), { minLength: 0, maxLength: 3 }),
          order: fc.integer({ min: 0, max: 1000 }),
          layout: layoutArb,
        }),
        ({ today, numerals, words, order, layout }) => {
          // Interleave the numerals with the words in a fixed pattern chosen by `order`.
          const tokens = [...numerals, ...words].map((token, index) => ({ token, key: (index * 7919 + order) % 31 }))
            .sort((a, b) => a.key - b.key || a.token.localeCompare(b.token))
            .map(({ token }) => token);
          const line = assemble(tokens, null, layout);
          const expectedNote = tokens.join(' ');
          fc.pre(within(line, expectedNote));
          expectOutcome(line, today, expectedNote, null);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('does not read a non-ASCII digit after `on`, or before an ordinal suffix, as a date', () => {
    assertProperty(
      fc.property(
        fc.record({
          today: anyRealDateArb,
          digits: nonAsciiDigitsArb,
          suffix: fc.constantFrom('', 'st', 'nd', 'rd', 'th'),
          form: fc.constantFrom<'onPair' | 'ordinal'>('onPair', 'ordinal'),
          amount: writtenAmountArb,
          before: fc.boolean(),
          gap: whitespaceRunArb,
        }),
        ({ today, digits, suffix, form, amount, before, gap }) => {
          const note = form === 'onPair' ? `on ${digits.slice(0, 2)}${suffix}` : `${digits.slice(0, 2)}${suffix || 'th'}`;
          const line = before ? `${amount.text}${gap}${note}` : `${note}${gap}${amount.text}`;
          // The result has today's date, so no non-ASCII digit became a day number.
          expectOutcome(line, today, note, amount.paise);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('never reads a token that mixes ASCII digits with letters or other numerals as an amount', () => {
    assertProperty(
      fc.property(
        fc.record({
          today: anyRealDateArb,
          mixed: fc.array(mixedToken, { minLength: 1, maxLength: 4 }),
          withAmount: fc.boolean(),
          amount: writtenAmountArb,
          layout: layoutArb,
        }),
        ({ today, mixed, withAmount, amount, layout }) => {
          const line = assemble(mixed, withAmount ? amount.text : null, layout);
          const expectedNote = mixed.join(' ');
          fc.pre(within(line, expectedNote));
          expectOutcome(line, today, expectedNote, withAmount ? amount.paise : null);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('reads fullwidth digits (ASCII after NFKC) as digits, with the same result as the ASCII spelling', () => {
    const toFullwidth = (text: string, mask: readonly boolean[]): string => {
      let index = 0;
      return text.replace(/[0-9,.]/g, (unit) => {
        const convert = mask[index % mask.length] ?? true;
        index += 1;
        return convert ? String.fromCodePoint((unit.codePointAt(0) as number) + 0xfee0) : unit;
      });
    };
    assertProperty(
      fc.property(
        fc.record({
          today: anyRealDateArb,
          tokens: fc.array(noteTokenArb, { minLength: 0, maxLength: 4 }),
          amount: writtenAmountArb,
          grouping: fc.constantFrom<Grouping>('none', 'indian', 'western'),
          fraction: fc.constantFrom<FractionStyle>('always', 'minimal'),
          rupee: fc.boolean(),
          mask: fc.array(fc.boolean(), { minLength: 1, maxLength: 24 }),
          layout: layoutArb,
        }),
        ({ today, tokens, amount, grouping, fraction, rupee, mask, layout }) => {
          const ascii = `${rupee ? '\u20b9' : ''}${writeAmount(amount.paise, { grouping, fraction })}`;
          const wide = `${rupee ? '\u20b9' : ''}${toFullwidth(writeAmount(amount.paise, { grouping, fraction }), mask)}`;
          const asciiLine = assemble(tokens, ascii, layout);
          const wideLine = assemble(tokens, wide, layout);
          const expectedNote = tokens.join(' ');
          fc.pre(within(asciiLine, expectedNote) && within(wideLine, expectedNote));
          expectOutcome(asciiLine, today, expectedNote, amount.paise);
          expectOutcome(wideLine, today, expectedNote, amount.paise);
          expect(parseQuickAddLine(wideLine, today)).toEqual(parseQuickAddLine(asciiLine, today));
        },
      ),
      { numRuns: RUNS },
    );
  });

  describe('limits are counted in UTF-16 code units', () => {
    const BMP_UNITS = ['a', 'q', 'k', '\u00e9', '\u0915', '\u092e', '\u0c15', '\u0c24'];
    const ASTRAL_UNITS = ['\u{1F600}', '\u{20BB7}'];

    interface Step {
      kind: 'bmp' | 'astral' | 'space';
      pick: number;
    }

    const planArb: fc.Arbitrary<Step[]> = fc.array(
      fc.record({ kind: fc.constantFrom<Step['kind']>('bmp', 'bmp', 'astral', 'space'), pick: fc.nat(20) }),
      { minLength: 0, maxLength: 150 },
    );

    /** A note of exactly `target` UTF-16 code units, single spaces only, never starting or ending with a space. */
    function noteOfUnits(target: number, plan: readonly Step[]): string {
      let note = '';
      for (const step of plan) {
        const remaining = target - note.length;
        if (remaining <= 0) break;
        if (step.kind === 'space') {
          if (note.length > 0 && !note.endsWith(' ') && remaining >= 2) note += ' ';
        } else if (step.kind === 'astral' && remaining >= 2) {
          note += ASTRAL_UNITS[step.pick % ASTRAL_UNITS.length] as string;
        } else {
          note += BMP_UNITS[step.pick % BMP_UNITS.length] as string;
        }
      }
      while (note.length < target) note += 'a';
      return note;
    }

    const targetArb: fc.Arbitrary<number> = fc.oneof(
      { weight: 3, arbitrary: fc.constantFrom(MAX_NOTE_UNITS - 1, MAX_NOTE_UNITS, MAX_NOTE_UNITS + 1, MAX_NOTE_UNITS + 2) },
      { weight: 1, arbitrary: fc.integer({ min: 1, max: 150 }) },
    );

    it('accepts a note of 120 units and rejects 121, whatever its scripts and astral characters', () => {
      assertProperty(
        fc.property(
          fc.record({ today: anyRealDateArb, target: targetArb, plan: planArb, before: fc.boolean(), gap: whitespaceRunArb }),
          ({ today, target, plan, before, gap }) => {
            const note = noteOfUnits(target, plan);
            expect(note.length).toBe(target);
            const line = before ? `450${gap}${note}` : `${note}${gap}450`;
            const result = parseQuickAddLine(line, today);
            if (target <= MAX_NOTE_UNITS) {
              expect(result).toEqual({ ok: true, entry: { amountMinor: 45_000, spentOn: today, note } });
            } else {
              expect(problemCodes(result)).toEqual(['NOTE_TOO_LONG']);
              const reason = result.ok ? '' : (result.problems[0]?.reason ?? '');
              expect(reason).toContain(String(target));
              expect(reason).toContain(String(MAX_NOTE_UNITS));
              expect(result.ok ? 0 : result.problems[0]?.correction.length).toBeGreaterThan(0);
            }
          },
        ),
        { numRuns: RUNS },
      );
    });

    it('accepts a line of 200 units and rejects 201, with the note kept as typed', () => {
      assertProperty(
        fc.property(
          fc.record({ today: anyRealDateArb, lineUnits: fc.integer({ min: 195, max: 206 }), plan: planArb }),
          ({ today, lineUnits, plan }) => {
            const note = noteOfUnits(MAX_NOTE_UNITS, plan);
            const padding = lineUnits - ('450'.length + note.length);
            const line = `450${' '.repeat(padding)}${note}`;
            expect(line.length).toBe(lineUnits);
            const result = parseQuickAddLine(line, today);
            if (lineUnits <= MAX_LINE_UNITS) {
              expect(result).toEqual({ ok: true, entry: { amountMinor: 45_000, spentOn: today, note } });
            } else {
              expect(problemCodes(result)).toEqual(['LINE_TOO_LONG']);
            }
          },
        ),
        { numRuns: RUNS },
      );
    });
  });

  it('keeps the named examples: 7up, route66, 120rs, and Devanagari, Telugu, and Arabic-Indic numerals are note text', () => {
    const today = '2026-05-15';
    const cases: Array<[string, number, string]> = [
      ['7up 40', 4000, '7up'],
      ['route66 120', 12_000, 'route66'],
      ['120rs 40', 4000, '120rs'],
      ['\u0967\u0968\u0969 40', 4000, '\u0967\u0968\u0969'],
      ['\u0c67\u0c68 \u0c1f\u0c40 40', 4000, '\u0c67\u0c68 \u0c1f\u0c40'],
      ['\u0661\u0662\u0663 40', 4000, '\u0661\u0662\u0663'],
      ['\uff11\uff12\uff10 coffee', 12_000, 'coffee'],
      ['\u091a\u093e\u092f \u20b9\uff11\uff12\uff10', 12_000, '\u091a\u093e\u092f'],
    ];
    for (const [line, amountMinor, note] of cases) {
      expect(parseQuickAddLine(line, today)).toEqual({ ok: true, entry: { amountMinor, spentOn: today, note } });
    }
    expect(problemCodes(parseQuickAddLine('\u0967\u0968\u0969', today))).toEqual(['MISSING_AMOUNT']);
  });
});

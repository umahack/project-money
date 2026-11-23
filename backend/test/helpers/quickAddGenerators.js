import fc from 'fast-check';
import {
  addDays,
  daysInMonth,
  formatIsoDate,
  isLeapYear,
  kolkataDateOf,
  kolkataMidnightMs,
} from './kolkataReference.js';

/**
 * fast-check generators and small reference writers shared by the property
 * tests of the Quick Add pure modules. The helpers import no production code,
 * so each reference stays independent of the module under test.
 *
 * A twin of this file lives at `frontend/src/test/quickAddGenerators.ts`. The
 * two runtimes share no source, so keep them equal.
 */

export const MAX_AMOUNT_MINOR = 9_999_999_999_999;
export const MAX_LINE_UNITS = 200;
export const MAX_NOTE_UNITS = 120;
export const NOTE_KEY_MAX_CODE_POINTS = 60;
export const MEMORY_CAPACITY = 500;
export const GENERATOR_MIN_YEAR = 1990;
export const GENERATOR_MAX_YEAR = 2100;

/** Words the parser reads as markers or date words (letter case ignored). */
export const RESERVED_WORDS = Object.freeze([
  'today', 'yesterday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'on', 'rs', 'rs.', 'inr', '₹',
]);
const RESERVED_SET = new Set(RESERVED_WORDS);

export const BUILT_IN_CATEGORIES = Object.freeze([
  'Food', 'Groceries', 'Transport', 'Shopping', 'Entertainment', 'Health', 'Rent', 'Utilities', 'Other',
]);

/* ------------------------------------------------------------------ dates */

const LEAP_YEARS = Object.freeze(
  Array.from({ length: GENERATOR_MAX_YEAR - GENERATOR_MIN_YEAR + 1 }, (_, i) => GENERATOR_MIN_YEAR + i).filter(isLeapYear),
);

/** `{ year, month, day }` of a real calendar date. */
export function dateFieldsArb({ minYear = GENERATOR_MIN_YEAR, maxYear = GENERATOR_MAX_YEAR } = {}) {
  return fc
    .record({ year: fc.integer({ min: minYear, max: maxYear }), month: fc.integer({ min: 1, max: 12 }) })
    .chain(({ year, month }) =>
      fc.integer({ min: 1, max: daysInMonth(year, month) }).map((day) => ({ year, month, day })));
}

/** A real `YYYY-MM-DD` date. */
export function validDateArb(options) {
  return dateFieldsArb(options).map(({ year, month, day }) => formatIsoDate(year, month, day));
}

/** Dates at the edges: first and last day of a month, 29 February, 28 February, year start and end. */
export const boundaryDateArb = fc
  .tuple(
    fc.constantFrom('monthStart', 'monthEnd', 'leapDay', 'feb28', 'yearStart', 'yearEnd'),
    fc.integer({ min: GENERATOR_MIN_YEAR, max: GENERATOR_MAX_YEAR }),
    fc.integer({ min: 1, max: 12 }),
    fc.constantFrom(...LEAP_YEARS),
  )
  .map(([kind, year, month, leapYear]) => {
    switch (kind) {
      case 'monthStart': return formatIsoDate(year, month, 1);
      case 'monthEnd': return formatIsoDate(year, month, daysInMonth(year, month));
      case 'leapDay': return formatIsoDate(leapYear, 2, 29);
      case 'feb28': return formatIsoDate(year, 2, 28);
      case 'yearStart': return formatIsoDate(year, 1, 1);
      default: return formatIsoDate(year, 12, 31);
    }
  });

/** Mostly any real date, with the edge dates over-represented. */
export const anyRealDateArb = fc.oneof(
  { weight: 3, arbitrary: validDateArb() },
  { weight: 2, arbitrary: boundaryDateArb },
);

/**
 * `{ year, month, day, kind }` that does not name a real date: day zero, a day
 * past the end of the month (31 February, 31 April, 29 February in a common
 * year), month zero, or a month above 12.
 */
export const invalidDateFieldsArb = fc.oneof(
  fc.record({ kind: fc.constant('dayZero'), year: fc.integer({ min: 1990, max: 2100 }), month: fc.integer({ min: 1, max: 12 }), day: fc.constant(0) }),
  dateFieldsArb().chain(({ year, month }) =>
    fc.integer({ min: daysInMonth(year, month) + 1, max: 99 })
      .map((day) => ({ kind: 'dayTooLarge', year, month, day }))),
  fc.constantFrom(...Array.from({ length: GENERATOR_MAX_YEAR - GENERATOR_MIN_YEAR + 1 }, (_, i) => GENERATOR_MIN_YEAR + i).filter((y) => !isLeapYear(y)))
    .map((year) => ({ kind: 'feb29CommonYear', year, month: 2, day: 29 })),
  fc.record({ kind: fc.constant('monthZero'), year: fc.integer({ min: 1990, max: 2100 }), month: fc.constant(0), day: fc.integer({ min: 1, max: 28 }) }),
  fc.record({ kind: fc.constant('monthTooLarge'), year: fc.integer({ min: 1990, max: 2100 }), month: fc.integer({ min: 13, max: 99 }), day: fc.integer({ min: 1, max: 28 }) }),
);

/** The spellings the parser accepts for a date, from fields that may be invalid. */
export function dateTokens({ year, month, day }) {
  const two = (n) => String(n).padStart(2, '0');
  const tokens = {
    iso: formatIsoDate(year, month, day),
    slashFull: `${two(day)}/${two(month)}/${String(year).padStart(4, '0')}`,
    slashNoPad: `${day}/${month}/${year}`,
  };
  if (year >= 2000 && year <= 2099) tokens.slashShortYear = `${two(day)}/${two(month)}/${two(year - 2000)}`;
  return tokens;
}

const OFFSETS_NEAR_MIDNIGHT_MS = Object.freeze([-60_000, -1000, -1, 0, 1, 1000, 60_000]);

/**
 * Instants at and around Asia/Kolkata midnight. The result carries the instant
 * in milliseconds and ISO form, the Kolkata date whose midnight it is near, the
 * offset from that midnight, and the Kolkata date `Intl` reports for the instant.
 */
export function kolkataInstantArb({ minYear = 2000, maxYear = GENERATOR_MAX_YEAR } = {}) {
  return fc
    .tuple(
      fc.oneof(validDateArb({ minYear, maxYear }), boundaryDateArb.filter((d) => Number(d.slice(0, 4)) >= minYear && Number(d.slice(0, 4)) <= maxYear)),
      fc.oneof(
        { weight: 3, arbitrary: fc.constantFrom(...OFFSETS_NEAR_MIDNIGHT_MS) },
        { weight: 1, arbitrary: fc.integer({ min: -36_000_000, max: 36_000_000 }) },
      ),
    )
    .map(([midnightDate, offsetMs]) => {
      const instantMs = kolkataMidnightMs(midnightDate) + offsetMs;
      return {
        midnightDate,
        offsetMs,
        instantMs,
        iso: new Date(instantMs).toISOString(),
        expectedDate: kolkataDateOf(instantMs),
      };
    });
}

/* ---------------------------------------------------------------- amounts */

const SAMPLE_PAISE = Object.freeze([1, 9, 10, 99, 100, 101, 999, 1000, 99_999, 100_000, 9_999_999, MAX_AMOUNT_MINOR - 1, MAX_AMOUNT_MINOR]);

/** Integer paise from 1 through the accepted maximum, with the edges over-represented. */
export const paiseArb = fc.oneof(
  { weight: 3, arbitrary: fc.integer({ min: 1, max: MAX_AMOUNT_MINOR }) },
  { weight: 3, arbitrary: fc.integer({ min: 1, max: 1_000_000 }) },
  { weight: 1, arbitrary: fc.constantFrom(...SAMPLE_PAISE) },
);

function groupWestern(digits) {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function groupIndian(digits) {
  if (digits.length <= 3) return digits;
  const head = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${head},${digits.slice(-3)}`;
}

/**
 * Independent amount writer. `grouping` is `none`, `indian`, or `western`.
 * `fraction` is `always` (`.dd`) or `minimal` (no fraction for whole rupees, one
 * digit for tenths, otherwise two digits). `marker` is a currency marker or ''.
 * A marker ending in a point is always written as its own token.
 */
export function writeAmount(paise, { grouping = 'none', fraction = 'always', marker = '', markerSeparator = '', suffix = '' } = {}) {
  const whole = String(Math.floor(paise / 100));
  const cents = paise % 100;
  const integerText = grouping === 'indian' ? groupIndian(whole) : grouping === 'western' ? groupWestern(whole) : whole;
  let fractionText = '';
  if (fraction === 'always') fractionText = `.${String(cents).padStart(2, '0')}`;
  else if (cents % 10 === 0 && cents !== 0) fractionText = `.${cents / 10}`;
  else if (cents !== 0) fractionText = `.${String(cents).padStart(2, '0')}`;
  const separator = marker.endsWith('.') ? ' ' : markerSeparator;
  return `${marker}${marker ? separator : ''}${integerText}${fractionText}${suffix}`;
}

export const MARKER_FORMS = Object.freeze(['', '₹', 'Rs', 'rs', 'RS', 'Rs.', 'rs.', 'INR', 'inr', 'Inr']);

/** `{ paise, text, grouping, marker, ... }` where `text` is a written amount. */
export const writtenAmountArb = fc
  .record({
    paise: paiseArb,
    grouping: fc.constantFrom('none', 'indian', 'western'),
    fraction: fc.constantFrom('always', 'minimal'),
    marker: fc.constantFrom(...MARKER_FORMS),
    markerSeparator: fc.constantFrom('', ' '),
    suffix: fc.constantFrom('', '/-'),
  })
  .map((spec) => ({ ...spec, text: writeAmount(spec.paise, spec) }));

const VALID_INDIAN_GROUPING = /^\d{1,2}(,\d{2})*,\d{3}$/;
const VALID_WESTERN_GROUPING = /^\d{1,3}(,\d{3})+$/;

/**
 * Amount tokens the parser must reject, with the subcode it is expected to
 * report. Each token breaks exactly one rule. Candidates for `BAD_GROUPING`
 * contain a comma and match neither valid grouping.
 */
export const invalidAmountTokenArb = fc.oneof(
  fc
    .stringMatching(/^[0-9]{1,6}(,[0-9]{0,4}){1,3}$/)
    .filter((text) => !VALID_INDIAN_GROUPING.test(text) && !VALID_WESTERN_GROUPING.test(text))
    .map((text) => ({ subcode: 'BAD_GROUPING', text })),
  fc.constantFrom('120,', '1,2,3', '12,34', '1234,567', '1,2345', '1,,000')
    .map((text) => ({ subcode: 'BAD_GROUPING', text })),
  fc.tuple(fc.integer({ min: 0, max: 99_999 }), fc.stringMatching(/^[0-9]{3,6}$/))
    .map(([whole, digits]) => ({ subcode: 'TOO_MANY_DECIMALS', text: `${whole}.${digits}` })),
  fc.integer({ min: 1, max: 99 }).map((cents) => ({ subcode: 'NO_INTEGER_PART', text: `.${cents}` })),
  fc.integer({ min: 1, max: 99_999 }).map((whole) => ({ subcode: 'TRAILING_POINT', text: `${whole}.` })),
  fc.constantFrom('0', '00', '0.0', '0.00', '000.00').map((text) => ({ subcode: 'ZERO', text })),
  fc.tuple(fc.integer({ min: 12, max: 16 }), fc.constantFrom('', '.5', '.99'))
    .map(([digits, fractionText]) => ({ subcode: 'TOO_LARGE', text: `${'9'.repeat(digits)}${fractionText}` })),
);

/* ------------------------------------------------------------------ notes */

const LATIN_UNITS = Object.freeze('abcdefghijklmnopqrstuvwxyz'.split(''));
const LATIN_UPPER_UNITS = Object.freeze('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''));
const ZWJ = '\u200D';
const ZWNJ = '\u200C';

function codePointRange(from, to) {
  return Array.from({ length: to - from + 1 }, (_, i) => String.fromCodePoint(from + i));
}

const DEVANAGARI = Object.freeze({
  consonants: codePointRange(0x0915, 0x0939),
  vowelSigns: [...codePointRange(0x093e, 0x094c), '\u0902', '\u0903'],
  virama: '\u094D',
});
const TELUGU = Object.freeze({
  consonants: codePointRange(0x0c15, 0x0c39),
  vowelSigns: [...codePointRange(0x0c3e, 0x0c4c), '\u0c02', '\u0c03'],
  virama: '\u0c4d',
});

function indicSyllableArb({ consonants, vowelSigns, virama }) {
  const consonant = fc.constantFrom(...consonants);
  const joiner = fc.constantFrom('', '', ZWJ, ZWNJ);
  return fc.oneof(
    fc.tuple(consonant, fc.option(fc.constantFrom(...vowelSigns), { nil: '' })).map((parts) => parts.join('')),
    // A conjunct: consonant, virama, optional joiner, consonant, optional vowel sign.
    fc.tuple(consonant, joiner, consonant, fc.option(fc.constantFrom(...vowelSigns), { nil: '' }))
      .map(([first, join, second, sign]) => `${first}${virama}${join}${second}${sign}`),
  );
}

const latinWordArb = fc.oneof(
  { weight: 4, arbitrary: fc.string({ unit: fc.constantFrom(...LATIN_UNITS), minLength: 1, maxLength: 10 }) },
  { weight: 1, arbitrary: fc.string({ unit: fc.constantFrom(...LATIN_UNITS, ...LATIN_UPPER_UNITS), minLength: 1, maxLength: 8 }) },
  // Accented forms in both composed (NFC) and decomposed (NFD) spelling.
  { weight: 1, arbitrary: fc.constantFrom('caf\u00e9', 'cafe\u0301', 'Cr\u00e8me', 'Cre\u0300me', 'na\u00efve') },
);
const devanagariWordArb = fc.array(indicSyllableArb(DEVANAGARI), { minLength: 1, maxLength: 4 }).map((s) => s.join(''));
const teluguWordArb = fc.array(indicSyllableArb(TELUGU), { minLength: 1, maxLength: 4 }).map((s) => s.join(''));

export const SCRIPT_WORD_ARBS = Object.freeze({
  latin: latinWordArb,
  devanagari: devanagariWordArb,
  telugu: teluguWordArb,
});

/** One note word in the given scripts that the parser does not read as a marker or date word. */
export function noteWordArb(scripts = ['latin', 'devanagari', 'telugu']) {
  return fc
    .oneof(...scripts.map((script) => SCRIPT_WORD_ARBS[script]))
    .filter((word) => !RESERVED_SET.has(word.toLowerCase()));
}

/** Words that look like amounts, dates, markers, or contain quotes. Only safe inside a quoted note. */
export const TRICKY_NOTE_WORDS = Object.freeze([
  '7up', '3pm', 'route66', '120rs', 'on', '3rd', 'today', 'yesterday', 'Monday', 'Rs', '\u20b9',
  '12/05', '2026-01-31', '1,000', '5', '.5', 'say"hi"', '""', '"', 'a""b',
]);

/** Whitespace the parser collapses: spaces, tabs, no-break space, em space, ideographic space. */
export const whitespaceRunArb = fc
  .array(fc.constantFrom(' ', '\t', '\u00a0', '\u2003', '\u3000'), { minLength: 1, maxLength: 4 })
  .map((units) => units.join(''));

export function collapseWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * A note in canonical form (single spaces, trimmed) of at most `maxUnits`
 * UTF-16 code units. With `tricky` it also contains digits, quotes, and date words.
 */
export function noteArb({ scripts = ['latin', 'devanagari', 'telugu'], maxUnits = MAX_NOTE_UNITS, maxWords = 6, tricky = false } = {}) {
  const word = tricky
    ? fc.oneof({ weight: 3, arbitrary: noteWordArb(scripts) }, { weight: 2, arbitrary: fc.constantFrom(...TRICKY_NOTE_WORDS) })
    : noteWordArb(scripts);
  return fc
    .array(word, { minLength: 0, maxLength: maxWords })
    .map((words) => words.join(' '))
    .filter((note) => note.length <= maxUnits);
}

/** A note as typed, with whitespace runs, together with its canonical form. */
export function typedNoteArb(options = {}) {
  const word = noteWordArb(options.scripts);
  return fc
    .tuple(fc.array(word, { minLength: 1, maxLength: 5 }), fc.array(whitespaceRunArb, { minLength: 6, maxLength: 6 }))
    .map(([words, runs]) => {
      const typed = words.map((w, i) => `${w}${i < words.length - 1 ? runs[i] : ''}`).join('');
      return { words, typed, canonical: words.join(' ') };
    })
    .filter(({ canonical }) => canonical.length <= (options.maxUnits ?? MAX_NOTE_UNITS));
}

/** A note of 121 to 200 UTF-16 code units, for the note-too-long problem. */
export const overlongNoteArb = fc
  .integer({ min: MAX_NOTE_UNITS + 1, max: 190 })
  .map((units) => 'abcde '.repeat(Math.ceil(units / 6)).slice(0, units).replace(/ $/, 'x'));

/* -------------------------------------------------------------- Note_Key */

/**
 * Independent Note_Key normalizer: NFKC, whitespace runs to one space,
 * `en-IN` lower-casing, NFKC again, trim. Returns null when the result is empty or has more
 * than 60 code points.
 */
export function referenceNoteKey(text) {
  const normalized = text.normalize('NFKC').replace(/\s+/g, ' ').toLocaleLowerCase('en-IN').normalize('NFKC').trim();
  if (normalized === '' || [...normalized].length > NOTE_KEY_MAX_CODE_POINTS) return null;
  return normalized;
}

function toFullWidthLatin(text) {
  return [...text].map((unit) => (/[A-Za-z0-9]/.test(unit) ? String.fromCodePoint(unit.codePointAt(0) + 0xfee0) : unit)).join('');
}

/** Strings to feed both Note_Key implementations: scripts, case, forms, whitespace, and arbitrary graphemes. */
export const noteKeyInputArb = fc.oneof(
  { weight: 4, arbitrary: fc.tuple(fc.array(noteWordArb(), { minLength: 0, maxLength: 5 }), fc.array(whitespaceRunArb, { minLength: 6, maxLength: 6 }), fc.boolean(), fc.constantFrom('NFC', 'NFD', 'NFKC', 'NFKD'), fc.constantFrom('asis', 'upper', 'fullwidth'), fc.boolean(), fc.boolean())
    .map(([words, runs, upper, form, style, lead, trail]) => {
      let text = words.map((w, i) => `${w}${i < words.length - 1 ? runs[i] : ''}`).join('');
      if (upper) text = text.toLocaleUpperCase('en-IN');
      if (style === 'fullwidth') text = toFullWidthLatin(text);
      text = `${lead ? runs[0] : ''}${text}${trail ? runs[1] : ''}`;
      return text.normalize(form);
    }) },
  { weight: 1, arbitrary: fc.string({ unit: 'grapheme', minLength: 0, maxLength: 80 }) },
  { weight: 1, arbitrary: fc.constantFrom('\u0130stanbul', 'KELVIN \u212a', '\ufb01nance', '\u2460\u2461', 'ABC\u00a0\u2003def') },
);

/** Text whose Note_Key is exactly `length` code points (59 through 62), or has none above 60. */
export const noteKeyBoundaryArb = fc
  .integer({ min: 59, max: 62 })
  .chain((codePoints) =>
    fc.array(fc.constantFrom('a', 'b', '\u0915', '\u0c15', '\u{1F600}'), { minLength: codePoints, maxLength: codePoints })
      .map((units) => ({ codePoints, text: units.join('') })));

/* ------------------------------------------------- plans and ledgers */

/** Rounds `dividend / divisor` half away from zero with integers only. */
export function referenceDivideHalfUp(dividend, divisor) {
  const magnitude = BigInt(Math.abs(dividend));
  const d = BigInt(divisor);
  let quotient = magnitude / d;
  if ((magnitude % d) * 2n >= d) quotient += 1n;
  return Number(dividend < 0 ? -quotient : quotient);
}

function dayWithinMonth(kind, rawDay, localDate) {
  const [year, month, today] = [Number(localDate.slice(0, 4)), Number(localDate.slice(5, 7)), Number(localDate.slice(8, 10))];
  const dim = daysInMonth(year, month);
  if (kind === 'past' && today > 1) return ((rawDay - 1) % (today - 1)) + 1;
  if (kind === 'future' && today < dim) return today + 1 + ((rawDay - 1) % (dim - today));
  return today;
}

/**
 * A current-month ledger with the plan the Allowance_Calculator receives.
 * `marks` is `none`, `all`, or `mixed`. Expenses are dated Today, earlier, or
 * later in the month, or carry no spending date and rely on `createdAt`.
 * `plan.remainingSpendableMinor` subtracts every expense of the month.
 */
export function monthLedgerArb({
  marks = 'mixed',
  maxExpenses = 12,
  maxAmountMinor = 5_000_000,
  extremeBudget = false,
} = {}) {
  const budgetArb = fc.oneof(
    { weight: 4, arbitrary: fc.integer({ min: 0, max: 500_000_000 }) },
    { weight: 1, arbitrary: fc.constantFrom(0, 1, 99, 100, 100_000, 99_999_999) },
    ...(extremeBudget ? [{ weight: 1, arbitrary: fc.constantFrom(Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER) }] : []),
  );
  const markArb = marks === 'all' ? fc.constant(true) : marks === 'none' ? fc.constant(false) : fc.boolean();
  const expenseArb = fc.record({
    amountMinor: fc.integer({ min: 1, max: maxAmountMinor }),
    dayKind: fc.constantFrom('today', 'past', 'future', 'none'),
    rawDay: fc.integer({ min: 1, max: 31 }),
    createdKind: fc.constantFrom('nearMidnight', 'nearMidnight', 'unparseable', 'missing'),
    createdOffsetMs: fc.constantFrom(...OFFSETS_NEAR_MIDNIGHT_MS),
    createdDayOffset: fc.integer({ min: -2, max: 2 }),
    mark: markArb,
  });
  return fc
    .record({
      localDate: anyRealDateArb,
      spendableBudgetMinor: budgetArb,
      expenses: fc.array(expenseArb, { minLength: 0, maxLength: maxExpenses }),
    })
    .map(({ localDate, spendableBudgetMinor, expenses }) => {
      const month = localDate.slice(0, 7);
      const year = Number(localDate.slice(0, 4));
      const monthNumber = Number(localDate.slice(5, 7));
      const today = Number(localDate.slice(8, 10));
      const records = expenses.map((spec, index) => {
        const hasDate = spec.dayKind !== 'none';
        const spentOn = hasDate ? `${month}-${String(dayWithinMonth(spec.dayKind, spec.rawDay, localDate)).padStart(2, '0')}` : null;
        const anchor = hasDate ? spentOn : addDays(localDate, spec.createdDayOffset);
        let createdAt = new Date(kolkataMidnightMs(anchor) + spec.createdOffsetMs).toISOString();
        if (!hasDate && spec.createdKind === 'unparseable') createdAt = 'not-a-timestamp';
        if (!hasDate && spec.createdKind === 'missing') createdAt = null;
        return {
          id: 1000 + index,
          amountMinor: spec.amountMinor,
          spentOn,
          createdAt,
          excludeFromDailyAllowance: spec.mark,
        };
      });
      const total = records.reduce((sum, record) => sum + record.amountMinor, 0);
      const remainingSpendableMinor = spendableBudgetMinor - total;
      const daysRemainingInclusive = daysInMonth(year, monthNumber) - today + 1;
      return {
        month,
        localDate,
        spendableBudgetMinor,
        expenses: records,
        plan: {
          spendableBudgetMinor,
          remainingSpendableMinor,
          dailySpendingGuideMinor: referenceDivideHalfUp(remainingSpendableMinor, daysRemainingInclusive),
          period: { daysRemainingInclusive },
        },
      };
    });
}

/* ------------------------------------------------------------ memory state */

const MEMORY_WORDS = Object.freeze(['coffee', 'tea', 'swiggy', 'uber', 'rent', '\u091a\u093e\u092f', '\u0938\u092c\u094d\u091c\u0940', '\u0c1f\u0c40', '\u0c15\u0c3e\u0c2b\u0c40']);

/**
 * A Category_Memory state of 0 to 501 entries for one user. Keys are unique,
 * `updatedAt` values collide often so the `(updated_at, id)` tie-break is
 * exercised, and sizes 499 to 501 are over-represented because 501 is the
 * state that makes an upsert evict.
 */
export function memoryStateArb({ maxEntries = MEMORY_CAPACITY + 1, categories = BUILT_IN_CATEGORIES } = {}) {
  const sizeArb = fc.oneof(
    { weight: 3, arbitrary: fc.integer({ min: 0, max: Math.min(20, maxEntries) }) },
    { weight: 1, arbitrary: fc.integer({ min: 0, max: maxEntries }) },
    { weight: 2, arbitrary: fc.constantFrom(...[MEMORY_CAPACITY - 1, MEMORY_CAPACITY, MEMORY_CAPACITY + 1].filter((n) => n <= maxEntries)) },
  );
  return sizeArb.chain((size) =>
    fc.tuple(
      fc.array(fc.constantFrom(...categories), { minLength: size, maxLength: size }),
      fc.array(fc.integer({ min: 0, max: 40 }), { minLength: size, maxLength: size }),
      fc.array(fc.integer({ min: 1, max: 5 }), { minLength: size, maxLength: size }),
      fc.array(fc.constantFrom(...MEMORY_WORDS), { minLength: size, maxLength: size }),
    ).map(([cats, minutes, revisions, words]) =>
      cats.map((category, i) => ({
        id: i + 1,
        noteKey: `${words[i]} ${i}`,
        category,
        revision: revisions[i] ?? 1,
        updatedAt: new Date(Date.UTC(2026, 0, 1) + (minutes[i] ?? 0) * 60_000).toISOString(),
      }))));
}

/* ----------------------------------------------- commands and interleavings */

/** A permutation of `0..n-1`, for shuffled response orders. */
export function permutationArb(n) {
  return fc.shuffledSubarray(Array.from({ length: n }, (_, i) => i), { minLength: n, maxLength: n });
}

/**
 * Category-memory commands by several users, expressed with indexes so a
 * counterexample prints structure only. `stale` asks for a revision that does
 * not match the stored one. Keys come from a small pool so keys collide.
 */
export function memoryCommandsArb({ users = 2, keys = 6, categories = 4, maxCommands = 60 } = {}) {
  const user = fc.integer({ min: 0, max: users - 1 });
  return fc.array(
    fc.oneof(
      { weight: 6, arbitrary: fc.record({ kind: fc.constant('upsert'), user, noteIndex: fc.integer({ min: 0, max: keys - 1 }), categoryIndex: fc.integer({ min: 0, max: categories - 1 }), stale: fc.boolean() }) },
      { weight: 2, arbitrary: fc.record({ kind: fc.constant('remove'), user, noteIndex: fc.integer({ min: 0, max: keys - 1 }), stale: fc.boolean() }) },
      { weight: 1, arbitrary: fc.record({ kind: fc.constant('removeAll'), user }) },
      { weight: 1, arbitrary: fc.record({ kind: fc.constant('removeCategory'), user, categoryIndex: fc.integer({ min: 0, max: categories - 1 }) }) },
      { weight: 1, arbitrary: fc.record({ kind: fc.constant('replay'), user, back: fc.integer({ min: 1, max: 5 }) }) },
    ),
    { minLength: 0, maxLength: maxCommands },
  );
}

/**
 * A save scenario for the exactly-once properties: entries with unique
 * idempotency keys, verbatim replays, key reuse with a different body, the
 * order in which requests are sent, and the order in which responses return.
 * `sends[i]` is `{ entry, kind }` with kind `first`, `replay`, or `conflict`.
 */
export function saveScenarioArb({ today = '2026-01-15', maxEntries = 5, categories = BUILT_IN_CATEGORIES } = {}) {
  const entryArb = fc.record({
    amountMinor: fc.integer({ min: 1, max: MAX_AMOUNT_MINOR - 1 }),
    spentOn: fc.oneof(fc.constant(today), validDateArb({ minYear: 2016, maxYear: 2027 })),
    note: noteArb({ maxWords: 3 }),
    category: fc.constantFrom(...categories),
    excludeFromDailyAllowance: fc.boolean(),
  });
  return fc
    .tuple(
      fc.array(entryArb, { minLength: 1, maxLength: maxEntries }),
      fc.array(fc.uuid(), { minLength: maxEntries, maxLength: maxEntries }),
      fc.array(fc.integer({ min: 0, max: maxEntries - 1 }), { minLength: 0, maxLength: 4 }),
      fc.array(fc.integer({ min: 0, max: maxEntries - 1 }), { minLength: 0, maxLength: 2 }),
    )
    .chain(([entries, uuids, replayPicks, conflictPicks]) => {
      const withKeys = entries.map((entry, index) => ({ index, idempotencyKey: `idem-${index}-${uuids[index]}`, ...entry }));
      const sends = [
        ...withKeys.map((entry) => ({ entry: entry.index, kind: 'first' })),
        ...replayPicks.filter((i) => i < entries.length).map((entry) => ({ entry, kind: 'replay' })),
        ...conflictPicks.filter((i) => i < entries.length).map((entry) => ({ entry, kind: 'conflict' })),
      ];
      return fc.tuple(permutationArb(sends.length), permutationArb(sends.length)).map(([sendOrder, responseOrder]) => ({
        entries: withKeys,
        sends,
        sendOrder,
        responseOrder,
      }));
    });
}

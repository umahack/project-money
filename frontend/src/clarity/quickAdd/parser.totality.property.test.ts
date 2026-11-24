import { describe, expect, it } from 'vitest';
import { fc } from '../../test/test-utils';
import { assertProperty } from '../../test/propertyReport';
import {
  MAX_AMOUNT_MINOR,
  MAX_LINE_UNITS,
  MAX_NOTE_UNITS,
  MARKER_FORMS,
  TRICKY_NOTE_WORDS,
  boundaryDateArb,
  collapseWhitespace,
  invalidAmountTokenArb,
  invalidDateFieldsArb,
  noteWordArb,
  validDateArb,
  whitespaceRunArb,
  writtenAmountArb,
} from '../../test/quickAddGenerators';
import {
  addDays,
  formatIsoDate,
  parseIsoDate,
  scanBackDate,
  weekdayOf,
  withProcessTimeZone,
} from '../../test/kolkataReference';
import { MAX_LINE_LENGTH, MAX_NOTE_LENGTH, parseQuickAddLine, type ParseResult } from './parser';

/*
 * Feature: quick-add-daily-answer, Property 1: Parsing is total, deterministic, and fully accounted
 *
 * Validates: Requirements 2.1, 2.2, 2.4, 2.6, 2.12, 2.13, 2.14, 2.15, 2.26, 2.27, 2.28, 2.30, 3.7, 3.11, 17.1, 17.4,
 * 17.7, 17.8
 *
 * Reference model: `modelParse` below reads the line again from the requirements and shares nothing with the
 * parser. It scans quotes forward, splits tokens on whitespace, classifies each token with its own regular
 * expressions, converts amounts from digit strings with BigInt, and resolves dates with the calendar helpers in
 * test/kolkataReference.ts (a day-by-day scan back from Today). Every character of the line is assigned to one
 * span class (amount, marker, date, note, quote delimiter, quote escape). The accounting check then compares the
 * non-whitespace characters of the line with the characters of the parser's own Note_Text plus the characters the
 * model assigned to the amount, marker, date, and quote syntax, so a character the parser dropped or invented
 * shows up as a multiset difference.
 *
 * Process time zones and locales: the time zone is varied in process through `withProcessTimeZone`. The locale
 * cannot be changed at runtime in Vitest (ICU reads it at process start), so the test instead replaces every
 * clock, random, locale, and `Intl` entry point with a function that throws while the parser runs, which shows
 * that the parse never reads them. The locale itself is varied by running this file under several LC_ALL values
 * from outside (see the task report).
 */

const MODEL_RUNS = 600;
const AMBIENT_RUNS = 300;
const AMBIENT_TEST_TIMEOUT_MS = 60_000;
const MAX_GENERATED_UNITS = 300;
const ZONES = [
  'UTC',
  'America/Los_Angeles',
  'Pacific/Kiritimati',
  'Pacific/Pago_Pago',
  'Asia/Kolkata',
  'Australia/Lord_Howe',
  'Europe/Istanbul',
] as const;

/* ------------------------------------------------------------- generators */

interface PieceContext {
  today: string;
}

type PieceSpec =
  | { kind: 'amount'; text: string }
  | { kind: 'badAmount'; text: string }
  | { kind: 'marker'; text: string }
  | { kind: 'dateWord'; word: string; casing: 'lower' | 'upper' | 'title' }
  | { kind: 'onDay'; n: number; suffix: string; gap: string; casing: 'lower' | 'upper' | 'title' }
  | { kind: 'ordinal'; n: number; suffix: string }
  | { kind: 'dayMonth'; day: number; month: number }
  | { kind: 'datedForm'; offset: number; form: 'iso' | 'slash4' | 'slash2' | 'noPad' | 'dayMonth' }
  | { kind: 'invalidDate'; fields: { year: number; month: number; day: number }; form: 'iso' | 'slash4' }
  | { kind: 'word'; text: string }
  | { kind: 'long'; units: number }
  | { kind: 'quoted'; words: string[]; seps: string[] }
  | { kind: 'stray'; text: string }
  | { kind: 'odd'; text: string };

const DATE_WORDS = ['today', 'yesterday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const CASINGS = ['lower', 'upper', 'title'] as const;
const SUFFIXES = ['st', 'nd', 'rd', 'th', '', 'TH'];
/** Spellings that need NFKC, lone markers, other numerals, and other astral or odd characters. */
const ODD_TOKENS = [
  '\uff11\uff12\uff10', // fullwidth 120
  '\u20b9\uff11\uff12\uff10',
  '\uff29\uff2e\uff32', // fullwidth INR
  '\u0967\u0968\u0969', // Devanagari 123
  '\u0c67\u0c68', // Telugu 12
  '\ud83d\ude00',
  '120\ud83d\ude00',
  '/-',
  '-',
  '.',
  ',',
  '\u20b9',
  'Rs.',
  'rs',
  'INR',
  '1/-',
  '5/-',
  '\u20b9/-',
  '1.5.5',
  '1..5',
  '0',
  '-5',
  '+5',
  '1e3',
  '0x10',
  '\u00bd',
  '\u2460',
  'on',
  'ON',
  'on 5',
  '5th',
  '31st',
  '0th',
  '32nd',
  '00/00',
  '29/02',
  '31/04',
  '30/02/2024',
  '2024-02-29',
  '0000-01-01',
  '9999-12-31',
];

function applyCasing(word: string, casing: 'lower' | 'upper' | 'title'): string {
  if (casing === 'upper') return word.toUpperCase();
  if (casing === 'title') return word.charAt(0).toUpperCase() + word.slice(1);
  return word;
}

const pieceArb: fc.Arbitrary<PieceSpec> = fc.oneof(
  { weight: 5, arbitrary: writtenAmountArb.map((amount): PieceSpec => ({ kind: 'amount', text: amount.text })) },
  { weight: 2, arbitrary: invalidAmountTokenArb.map((token): PieceSpec => ({ kind: 'badAmount', text: token.text })) },
  { weight: 1, arbitrary: fc.constantFrom(...MARKER_FORMS.filter((marker) => marker !== '')).map((text): PieceSpec => ({ kind: 'marker', text })) },
  {
    weight: 3,
    arbitrary: fc
      .record({ word: fc.constantFrom(...DATE_WORDS), casing: fc.constantFrom(...CASINGS) })
      .map(({ word, casing }): PieceSpec => ({ kind: 'dateWord', word, casing })),
  },
  {
    weight: 2,
    arbitrary: fc
      .record({
        n: fc.integer({ min: 0, max: 40 }),
        suffix: fc.constantFrom(...SUFFIXES),
        gap: fc.constantFrom(' ', '  ', '\t', '\u00a0'),
        casing: fc.constantFrom(...CASINGS),
      })
      .map((spec): PieceSpec => ({ kind: 'onDay', ...spec })),
  },
  {
    weight: 2,
    arbitrary: fc
      .record({ n: fc.integer({ min: 0, max: 40 }), suffix: fc.constantFrom('st', 'nd', 'rd', 'th', 'TH') })
      .map((spec): PieceSpec => ({ kind: 'ordinal', ...spec })),
  },
  {
    weight: 1,
    arbitrary: fc
      .record({ day: fc.integer({ min: 0, max: 33 }), month: fc.integer({ min: 0, max: 14 }) })
      .map((spec): PieceSpec => ({ kind: 'dayMonth', ...spec })),
  },
  {
    weight: 4,
    arbitrary: fc
      .record({
        offset: fc.oneof(fc.integer({ min: -400, max: 5 }), fc.integer({ min: -4600, max: 500 })),
        form: fc.constantFrom<'iso' | 'slash4' | 'slash2' | 'noPad' | 'dayMonth'>('iso', 'slash4', 'slash2', 'noPad', 'dayMonth'),
      })
      .map((spec): PieceSpec => ({ kind: 'datedForm', ...spec })),
  },
  {
    weight: 1,
    arbitrary: fc
      .record({ fields: invalidDateFieldsArb, form: fc.constantFrom<'iso' | 'slash4'>('iso', 'slash4') })
      .map(({ fields, form }): PieceSpec => ({ kind: 'invalidDate', fields: { year: fields.year, month: fields.month, day: fields.day }, form })),
  },
  { weight: 6, arbitrary: noteWordArb().map((text): PieceSpec => ({ kind: 'word', text })) },
  { weight: 2, arbitrary: fc.constantFrom(...TRICKY_NOTE_WORDS).map((text): PieceSpec => ({ kind: 'word', text })) },
  { weight: 1, arbitrary: fc.integer({ min: 40, max: 190 }).map((units): PieceSpec => ({ kind: 'long', units })) },
  {
    weight: 3,
    arbitrary: fc
      .record({
        words: fc.array(fc.oneof(noteWordArb(), fc.constantFrom(...TRICKY_NOTE_WORDS)), { minLength: 0, maxLength: 5 }),
        seps: fc.array(whitespaceRunArb, { minLength: 6, maxLength: 6 }),
      })
      .map(({ words, seps }): PieceSpec => ({ kind: 'quoted', words, seps })),
  },
  { weight: 1, arbitrary: fc.constantFrom('"', '""', '"""', '"a', 'a"', '"a "b', 'a"b"').map((text): PieceSpec => ({ kind: 'stray', text })) },
  { weight: 2, arbitrary: fc.constantFrom(...ODD_TOKENS).map((text): PieceSpec => ({ kind: 'odd', text })) },
);

function two(n: number): string {
  return String(n).padStart(2, '0');
}

function renderPiece(spec: PieceSpec, { today }: PieceContext): string {
  switch (spec.kind) {
    case 'amount':
    case 'badAmount':
    case 'marker':
    case 'word':
    case 'stray':
    case 'odd':
      return spec.text;
    case 'dateWord':
      return applyCasing(spec.word, spec.casing);
    case 'onDay':
      return `${applyCasing('on', spec.casing)}${spec.gap}${spec.n}${spec.suffix}`;
    case 'ordinal':
      return `${spec.n}${spec.suffix}`;
    case 'dayMonth':
      return `${spec.day}/${spec.month}`;
    case 'datedForm': {
      const fields = parseIsoDate(addDays(today, spec.offset));
      if (!fields) return '';
      switch (spec.form) {
        case 'iso':
          return formatIsoDate(fields.year, fields.month, fields.day);
        case 'slash4':
          return `${two(fields.day)}/${two(fields.month)}/${String(fields.year).padStart(4, '0')}`;
        case 'slash2':
          return `${two(fields.day)}/${two(fields.month)}/${two(fields.year % 100)}`;
        case 'noPad':
          return `${fields.day}/${fields.month}/${fields.year}`;
        default:
          return `${fields.day}/${fields.month}`;
      }
    }
    case 'invalidDate':
      return spec.form === 'iso'
        ? formatIsoDate(spec.fields.year, spec.fields.month, spec.fields.day)
        : `${two(spec.fields.day)}/${two(spec.fields.month)}/${String(spec.fields.year).padStart(4, '0')}`;
    case 'long':
      return 'x'.repeat(spec.units);
    case 'quoted': {
      const inner = spec.words
        .map((word, index) => `${word.replace(/"/g, '""')}${index < spec.words.length - 1 ? (spec.seps[index] ?? ' ') : ''}`)
        .join('');
      return `"${inner}"`;
    }
  }
}

const separatorArb = fc.constantFrom(' ', ' ', ' ', ' ', '  ', '\t', '\u00a0', '\u3000', '\n', '');

interface LineCase {
  today: string;
  line: string;
}

const todayArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 3, arbitrary: validDateArb({ minYear: 1990, maxYear: 2100 }) },
  { weight: 2, arbitrary: boundaryDateArb },
);

function joinPieces(today: string, specs: readonly PieceSpec[], separators: readonly string[]): LineCase {
  let line = '';
  specs.forEach((spec, index) => {
    line += renderPiece(spec, { today });
    if (index < specs.length - 1) line += separators[index] ?? ' ';
  });
  return { today, line: line.slice(0, MAX_GENERATED_UNITS) };
}

/** Any mix of pieces, many of which collide: several amounts, several dates, bad amounts, stray quotes. */
const mixedLineArb: fc.Arbitrary<LineCase> = fc
  .tuple(todayArb, fc.array(pieceArb, { minLength: 0, maxLength: 22 }), fc.array(separatorArb, { minLength: 22, maxLength: 22 }))
  .map(([today, specs, separators]) => joinPieces(today, specs, separators));

/** One amount, at most one date, a few note words and at most one quoted note, in any order. Mostly parses. */
const wellFormedLineArb: fc.Arbitrary<LineCase> = fc
  .tuple(
    todayArb,
    writtenAmountArb,
    fc.array(
      fc.record({ offset: fc.integer({ min: -400, max: 0 }), form: fc.constantFrom<'iso' | 'slash4' | 'slash2' | 'noPad' | 'dayMonth'>('iso', 'slash4', 'slash2', 'noPad', 'dayMonth') }),
      { minLength: 0, maxLength: 1 },
    ),
    fc.array(fc.oneof(noteWordArb(), fc.constantFrom(...DATE_WORDS.slice(0, 2).map((word) => `"${word}"`))), { minLength: 0, maxLength: 4 }),
    fc.array(pieceArb.filter((spec) => spec.kind === 'quoted'), { minLength: 0, maxLength: 1 }),
    fc.array(fc.constantFrom<PieceSpec>({ kind: 'dateWord', word: 'today', casing: 'lower' }, { kind: 'dateWord', word: 'yesterday', casing: 'title' }, { kind: 'dateWord', word: 'friday', casing: 'lower' }, { kind: 'onDay', n: 3, suffix: 'rd', gap: ' ', casing: 'lower' }), { minLength: 0, maxLength: 1 }),
    fc.array(separatorArb.filter((separator) => separator !== ''), { minLength: 12, maxLength: 12 }),
  )
  .chain(([today, amount, datedForms, words, quoted, dateWords, separators]) => {
    const specs: PieceSpec[] = [
      { kind: 'amount', text: amount.text },
      ...datedForms.map((form): PieceSpec => ({ kind: 'datedForm', offset: form.offset, form: form.form })),
      ...dateWords,
      ...words.map((text): PieceSpec => ({ kind: 'stray', text })),
      ...quoted,
    ];
    return fc
      .shuffledSubarray(specs, { minLength: specs.length, maxLength: specs.length })
      .map((ordered) => joinPieces(today, ordered, separators));
  });

const RAW_UNITS = [
  ...'0123456789,./-"\u20b9 \t\n\u00a0'.split(''),
  ...'RsINRonthdyamSTW'.split(''),
  '\u00e9', 'e\u0301', '\u0967', '\u0c67', '\u0c24\u0c46', '\u0915\u094d\u0937', '\u200d', '\ud83d\ude00', '\u3000', '\uff11', 'on ', 'Rs ', '"" ', '/-',
];

/** Noise: a string over the characters the grammar cares about, up to 300 UTF-16 code units. */
const rawLineArb: fc.Arbitrary<LineCase> = fc
  .tuple(todayArb, fc.array(fc.constantFrom(...RAW_UNITS), { minLength: 0, maxLength: 300 }))
  .map(([today, units]) => ({ today, line: units.join('').slice(0, MAX_GENERATED_UNITS) }));

/** Any string of up to 300 characters over the full code point range. */
const fullUnicodeLineArb: fc.Arbitrary<LineCase> = fc
  .tuple(todayArb, fc.string({ unit: 'grapheme', minLength: 0, maxLength: 120 }))
  .map(([today, line]) => ({ today, line: line.slice(0, MAX_GENERATED_UNITS) }));

const lineCaseArb: fc.Arbitrary<LineCase> = fc.oneof(
  { weight: 5, arbitrary: mixedLineArb },
  { weight: 4, arbitrary: wellFormedLineArb },
  { weight: 2, arbitrary: rawLineArb },
  { weight: 1, arbitrary: fullUnicodeLineArb },
);

/* ------------------------------------------------------ reference model */

type SpanClass = 'amount' | 'marker' | 'date' | 'note' | 'delimiter' | 'escape';

interface Span {
  cls: SpanClass;
  start: number;
  end: number; // exclusive
}

interface ModelProblem {
  code: string;
  subcode?: string;
  part: string;
}

interface ModelOutcome {
  ok: boolean;
  entry?: { amountMinor: number; spentOn: string; note: string };
  problems: ModelProblem[];
  spans: Span[];
  /** How many amount candidates the line has, and whether one was consumed. */
  amountCandidates: number;
  consumedAmounts: number;
}

const isSpace = (unit: string): boolean => /\s/.test(unit);

/** Index of the closing quote of a segment whose content starts at `from`, or -1. Pairs of quotes are literals. */
function findClosingQuote(line: string, from: number): number {
  let p = from;
  while (p < line.length) {
    if (line[p] === '"') {
      if (line[p + 1] === '"') p += 2;
      else return p;
    } else {
      p += 1;
    }
  }
  return -1;
}

interface Item {
  kind: 'word' | 'quoted';
  text: string;
  spans: Span[];
}

function modelItems(line: string): Item[] {
  const items: Item[] = [];
  let i = 0;
  while (i < line.length) {
    const unit = line[i] as string;
    if (isSpace(unit)) {
      i += 1;
      continue;
    }
    if (unit === '"') {
      const close = findClosingQuote(line, i + 1);
      if (close !== -1) {
        const spans: Span[] = [{ cls: 'delimiter', start: i, end: i + 1 }];
        let content = '';
        let k = i + 1;
        while (k < close) {
          const c = line[k] as string;
          if (c === '"') {
            spans.push({ cls: 'note', start: k, end: k + 1 }, { cls: 'escape', start: k + 1, end: k + 2 });
            content += '"';
            k += 2;
          } else {
            if (!isSpace(c)) spans.push({ cls: 'note', start: k, end: k + 1 });
            content += c;
            k += 1;
          }
        }
        spans.push({ cls: 'delimiter', start: close, end: close + 1 });
        items.push({ kind: 'quoted', text: content, spans });
        i = close + 1;
        continue;
      }
    }
    let j = i;
    while (j < line.length && !isSpace(line[j] as string) && !(line[j] === '"' && findClosingQuote(line, j + 1) !== -1)) j += 1;
    items.push({ kind: 'word', text: line.slice(i, j), spans: [{ cls: 'note', start: i, end: j }] });
    i = j;
  }
  return items;
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function foldText(text: string): string {
  return text.normalize('NFKC').toLowerCase();
}

type ModelDate =
  | { kind: 'today' | 'yesterday' }
  | { kind: 'weekday'; weekday: number }
  | { kind: 'dayOfMonth'; day: number }
  | { kind: 'dayMonth'; day: number; month: number }
  | { kind: 'full'; year: number; month: number; day: number };

/** The date forms of Requirements 2.16 to 2.25, matched on the NFKC text with letter case ignored. */
function modelDateOf(text: string): ModelDate | null {
  const form = foldText(text);
  if (form === 'today' || form === 'yesterday') return { kind: form };
  if (WEEKDAYS.includes(form)) return { kind: 'weekday', weekday: WEEKDAYS.indexOf(form) };
  let m = /^on ([0-9]{1,2})(?:st|nd|rd|th)?$/.exec(form);
  if (m) return Number(m[1]) > 31 ? null : { kind: 'dayOfMonth', day: Number(m[1]) };
  m = /^([0-9]{1,2})(?:st|nd|rd|th)$/.exec(form);
  if (m) return { kind: 'dayOfMonth', day: Number(m[1]) };
  m = /^([0-9]{1,2})\/([0-9]{1,2})\/([0-9]{2}|[0-9]{4})$/.exec(form);
  if (m) {
    const year = (m[3] as string).length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return { kind: 'full', year, month: Number(m[2]), day: Number(m[1]) };
  }
  m = /^([0-9]{1,2})\/([0-9]{1,2})$/.exec(form);
  if (m) return { kind: 'dayMonth', day: Number(m[1]), month: Number(m[2]) };
  m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(form);
  if (m) return { kind: 'full', year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  return null;
}

function daysOfMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

type DateOutcome = { date: string } | { subcode: 'NOT_A_DATE' | 'OUT_OF_RANGE' };

function modelResolveDate(token: ModelDate, today: string): DateOutcome {
  let date: string | null;
  switch (token.kind) {
    case 'today':
      date = today;
      break;
    case 'yesterday':
      date = addDays(today, -1);
      break;
    case 'weekday':
      date = scanBackDate(today, (candidate) => weekdayOf(candidate) === token.weekday);
      break;
    case 'dayOfMonth':
      if (token.day < 1 || token.day > 31) return { subcode: 'NOT_A_DATE' };
      date = scanBackDate(today, (candidate) => Number(candidate.slice(8, 10)) === token.day);
      break;
    case 'dayMonth':
      if (token.month < 1 || token.month > 12 || token.day < 1 || token.day > daysOfMonth(2000, token.month)) {
        return { subcode: 'NOT_A_DATE' };
      }
      date = scanBackDate(
        today,
        (candidate) => Number(candidate.slice(5, 7)) === token.month && Number(candidate.slice(8, 10)) === token.day,
      );
      break;
    default:
      if (token.year < 1 || token.month < 1 || token.month > 12 || token.day < 1 || token.day > daysOfMonth(token.year, token.month)) {
        return { subcode: 'NOT_A_DATE' };
      }
      date = formatIsoDate(token.year, token.month, token.day);
  }
  if (date === null) return { subcode: 'OUT_OF_RANGE' };
  const year = Number(today.slice(0, 4));
  const min = `${String(year - 10).padStart(4, '0')}-01-01`;
  const max = `${String(year + 1).padStart(4, '0')}-12-31`;
  return date >= min && date <= max ? { date } : { subcode: 'OUT_OF_RANGE' };
}

interface ModelCandidate {
  raw: string;
  body: string;
  hasMarker: boolean;
}

function modelCandidateOf(token: string, precededByMarker: boolean): ModelCandidate | null {
  const m = /^(₹|rs\.|rs|inr)?([0-9,]*(?:\.[0-9]*)?)(\/-)?$/.exec(foldText(token));
  if (!m || !/[0-9]/.test(m[2] as string)) return null;
  return { raw: token, body: m[2] as string, hasMarker: m[1] !== undefined || precededByMarker };
}

function modelIsLoneMarker(token: string): boolean {
  return ['₹', 'rs', 'rs.', 'inr'].includes(foldText(token));
}

type AmountOutcome = { amountMinor: number } | { subcode: string };

function validGrouping(groups: readonly string[]): boolean {
  if (groups.length < 2 || groups.some((group) => !/^[0-9]+$/.test(group))) return false;
  const tail = groups.slice(1);
  const western = groups[0]!.length >= 1 && groups[0]!.length <= 3 && tail.every((group) => group.length === 3);
  const last = groups[groups.length - 1] as string;
  const middle = groups.slice(1, -1);
  const indian = groups[0]!.length >= 1 && groups[0]!.length <= 2 && middle.every((group) => group.length === 2) && last.length === 3;
  return western || indian;
}

function modelConvertAmount(body: string): AmountOutcome {
  const point = body.indexOf('.');
  const integerPart = point === -1 ? body : body.slice(0, point);
  const fraction = point === -1 ? null : body.slice(point + 1);
  if (!/[0-9]/.test(integerPart)) return { subcode: 'NO_INTEGER_PART' };
  if (integerPart.includes(',') ? !validGrouping(integerPart.split(',')) : !/^[0-9]+$/.test(integerPart)) {
    return { subcode: 'BAD_GROUPING' };
  }
  if (fraction === '') return { subcode: 'TRAILING_POINT' };
  if (fraction !== null && fraction.length > 2) return { subcode: 'TOO_MANY_DECIMALS' };
  const digits = integerPart.split(',').join('');
  if (digits.length > 11) return { subcode: 'TOO_LARGE' };
  const paise = BigInt(digits + (fraction ?? '').padEnd(2, '0'));
  if (paise === 0n) return { subcode: 'ZERO' };
  return { amountMinor: Number(paise) };
}

type ModelPart =
  | { kind: 'note'; text: string; spans: Span[] }
  | { kind: 'date'; token: ModelDate; text: string; spans: Span[] }
  | { kind: 'amount'; candidate: ModelCandidate; display: string; markerSpans: Span[]; amountSpans: Span[] };

function modelClassify(items: readonly Item[]): ModelPart[] {
  const parts: ModelPart[] = [];
  let i = 0;
  while (i < items.length) {
    const item = items[i] as Item;
    if (item.kind === 'quoted') {
      parts.push({ kind: 'note', text: item.text, spans: item.spans });
      i += 1;
      continue;
    }
    const next = items[i + 1];
    if (next !== undefined && next.kind === 'word' && foldText(item.text) === 'on') {
      const pair = `${item.text} ${next.text}`;
      const token = modelDateOf(pair);
      if (token) {
        parts.push({ kind: 'date', token, text: pair, spans: [...item.spans, ...next.spans].map((span) => ({ ...span, cls: 'date' as const })) });
        i += 2;
        continue;
      }
    }
    const token = modelDateOf(item.text);
    if (token) {
      parts.push({ kind: 'date', token, text: item.text, spans: item.spans.map((span) => ({ ...span, cls: 'date' as const })) });
      i += 1;
      continue;
    }
    if (next !== undefined && next.kind === 'word' && modelIsLoneMarker(item.text)) {
      const marked = modelCandidateOf(next.text, true);
      if (marked) {
        parts.push({
          kind: 'amount',
          candidate: marked,
          display: `${item.text} ${next.text}`,
          markerSpans: item.spans.map((span) => ({ ...span, cls: 'marker' as const })),
          amountSpans: next.spans.map((span) => ({ ...span, cls: 'amount' as const })),
        });
        i += 2;
        continue;
      }
    }
    const candidate = modelCandidateOf(item.text, false);
    if (candidate) {
      parts.push({ kind: 'amount', candidate, display: item.text, markerSpans: [], amountSpans: item.spans.map((span) => ({ ...span, cls: 'amount' as const })) });
    } else {
      parts.push({ kind: 'note', text: item.text, spans: item.spans });
    }
    i += 1;
  }
  return parts;
}

function modelParse(line: string, today: string): ModelOutcome {
  if (line.length > MAX_LINE_UNITS) {
    return { ok: false, problems: [{ code: 'LINE_TOO_LONG', part: '' }], spans: [], amountCandidates: 0, consumedAmounts: 0 };
  }
  const parts = modelClassify(modelItems(line));
  const problems: ModelProblem[] = [];
  const spans: Span[] = [];

  // Dates: none means Today, one is resolved, several are one problem.
  const dateParts = parts.filter((part): part is Extract<ModelPart, { kind: 'date' }> => part.kind === 'date');
  let spentOn = today;
  if (dateParts.length > 1) {
    problems.push({ code: 'MULTIPLE_DATES', part: dateParts.map((part) => part.text).join(' ') });
  } else if (dateParts.length === 1) {
    const only = dateParts[0] as Extract<ModelPart, { kind: 'date' }>;
    const outcome = modelResolveDate(only.token, today);
    if ('date' in outcome) spentOn = outcome.date;
    else problems.push({ code: 'INVALID_DATE', subcode: outcome.subcode, part: only.text });
  }

  // Amount: one candidate, or the single marked one, otherwise missing or multiple.
  const amountParts = parts.filter((part): part is Extract<ModelPart, { kind: 'amount' }> => part.kind === 'amount');
  const marked = amountParts.filter((part) => part.candidate.hasMarker);
  let chosen: Extract<ModelPart, { kind: 'amount' }> | null = null;
  if (amountParts.length === 0) problems.push({ code: 'MISSING_AMOUNT', part: '' });
  else if (amountParts.length === 1) chosen = amountParts[0] as Extract<ModelPart, { kind: 'amount' }>;
  else if (marked.length === 1) chosen = marked[0] as Extract<ModelPart, { kind: 'amount' }>;
  else problems.push({ code: 'MULTIPLE_AMOUNTS', part: amountParts.map((part) => part.display).join(' ') });
  let amountMinor = 0;
  if (chosen) {
    const outcome = modelConvertAmount(chosen.candidate.body);
    if ('amountMinor' in outcome) amountMinor = outcome.amountMinor;
    else problems.push({ code: 'INVALID_AMOUNT', subcode: outcome.subcode, part: chosen.candidate.raw });
  }

  // Note text: every part nobody claimed, in line order.
  const pieces: string[] = [];
  for (const part of parts) {
    if (part.kind === 'note') {
      pieces.push(part.text);
      spans.push(...part.spans);
    } else if (part.kind === 'date') {
      spans.push(...part.spans);
    } else if (part === chosen) {
      spans.push(...part.markerSpans, ...part.amountSpans);
    } else {
      pieces.push(part.display);
      spans.push(...[...part.markerSpans, ...part.amountSpans].map((span) => ({ ...span, cls: 'note' as const })));
    }
  }
  const note = pieces.join(' ').replace(/\s+/g, ' ').trim();
  if (note.length > MAX_NOTE_UNITS) problems.push({ code: 'NOTE_TOO_LONG', part: '' });

  const ok = problems.length === 0;
  return {
    ok,
    entry: ok ? { amountMinor, spentOn, note } : undefined,
    problems,
    spans,
    amountCandidates: amountParts.length,
    consumedAmounts: chosen ? 1 : 0,
  };
}

/* ---------------------------------------------------------- the checks */

function nonSpaceUnits(text: string): string[] {
  return text.replace(/\s/g, '').split('');
}

/** Every non-whitespace character of the line belongs to exactly one span, and no span covers whitespace. */
function expectFullyCovered(line: string, spans: readonly Span[]): void {
  const claims = new Array<number>(line.length).fill(0);
  for (const span of spans) for (let k = span.start; k < span.end; k += 1) claims[k] = (claims[k] ?? 0) + 1;
  for (let k = 0; k < line.length; k += 1) {
    const space = isSpace(line[k] as string);
    if (space ? claims[k] !== 0 : claims[k] !== 1) {
      throw new Error(`model accounting: index ${k} claimed ${claims[k]} times (whitespace=${space})`);
    }
  }
}

function describeProblems(result: ParseResult): ModelProblem[] {
  if (result.ok) return [];
  return result.problems.map((problem) => {
    const mapped: ModelProblem = { code: problem.code, part: problem.part };
    if (problem.subcode !== undefined) mapped.subcode = problem.subcode;
    return mapped;
  });
}

/** Compares the parser with the model and returns a short label of the outcome for the coverage tally. */
function checkAgainstModel(line: string, today: string): string[] {
  const result = parseQuickAddLine(line, today);
  const model = modelParse(line, today);

  expect(result.ok).toBe(model.ok);
  if (model.ok) {
    expect(result.ok && result.entry).toEqual(model.entry);
  } else {
    expect(describeProblems(result)).toEqual(model.problems);
  }

  if (line.length <= MAX_LINE_UNITS) {
    expectFullyCovered(line, model.spans);
    if (result.ok) {
      // Exactly one Amount_Token was consumed, and the characters of the line are the Note_Text plus the
      // amount, marker, date, and quote syntax the model named.
      expect(model.consumedAmounts).toBe(1);
      const claimed = model.spans.filter((span) => span.cls !== 'note');
      const accounted = [
        ...nonSpaceUnits(result.entry.note),
        ...claimed.flatMap((span) => nonSpaceUnits(line.slice(span.start, span.end))),
      ];
      expect([...accounted].sort()).toEqual([...nonSpaceUnits(line)].sort());
    }
  }
  return model.ok ? ['ok'] : model.problems.map((problem) => (problem.subcode ? `${problem.code}/${problem.subcode}` : problem.code));
}

const PROBLEM_CODES = new Set(['LINE_TOO_LONG', 'MISSING_AMOUNT', 'INVALID_AMOUNT', 'MULTIPLE_AMOUNTS', 'INVALID_DATE', 'MULTIPLE_DATES', 'NOTE_TOO_LONG']);
const CODE_STAGE: Record<string, number> = {
  INVALID_DATE: 1,
  MULTIPLE_DATES: 1,
  MISSING_AMOUNT: 2,
  INVALID_AMOUNT: 2,
  MULTIPLE_AMOUNTS: 2,
  NOTE_TOO_LONG: 3,
};

/** Shape rules that hold for every result, with no model: the entry bounds and the problem list structure. */
function expectResultInvariants(line: string, today: string, result: ParseResult): void {
  if (result.ok) {
    const { amountMinor, spentOn, note } = result.entry;
    expect(Object.keys(result.entry).sort()).toEqual(['amountMinor', 'note', 'spentOn']);
    expect(Number.isSafeInteger(amountMinor)).toBe(true);
    expect(amountMinor).toBeGreaterThanOrEqual(1);
    expect(amountMinor).toBeLessThanOrEqual(MAX_AMOUNT_MINOR);
    const fields = parseIsoDate(spentOn);
    expect(fields).not.toBeNull();
    expect((fields?.year ?? 0) >= 1).toBe(true);
    const year = Number(today.slice(0, 4));
    expect(spentOn >= `${String(year - 10).padStart(4, '0')}-01-01`).toBe(true);
    expect(spentOn <= `${String(year + 1).padStart(4, '0')}-12-31`).toBe(true);
    expect(note.length).toBeLessThanOrEqual(MAX_NOTE_LENGTH);
    expect(note).toBe(collapseWhitespace(note));
    expect(line.length).toBeLessThanOrEqual(MAX_LINE_LENGTH);
    return;
  }
  expect(result.problems.length).toBeGreaterThan(0);
  let previousStage = 0;
  for (const problem of result.problems) {
    expect(PROBLEM_CODES.has(problem.code)).toBe(true);
    expect(typeof problem.part).toBe('string');
    expect(problem.reason.length).toBeGreaterThan(0);
    expect(problem.correction.length).toBeGreaterThan(0);
    const stage = CODE_STAGE[problem.code];
    if (stage !== undefined) {
      expect(stage).toBeGreaterThan(previousStage); // date, then amount, then note, each at most once
      previousStage = stage;
    }
  }
  if (line.length > MAX_LINE_LENGTH) {
    expect(result.problems.map((problem) => problem.code)).toEqual(['LINE_TOO_LONG']);
  }
}

/* ------------------------------------------------------- ambient tripwire */

type AnyFn = (...args: never[]) => unknown;
interface Replacement {
  holder: object;
  key: string;
  original: unknown;
}

/** Replaces clock, random, locale, and Intl entry points with functions that throw, runs `fn`, and restores them. */
function withAmbientStateForbidden<T>(fn: () => T): T {
  const forbidden = (name: string): AnyFn => () => {
    throw new Error(`The parser read ambient state through ${name}`);
  };
  const targets: Array<[object, string, string]> = [
    [Date, 'now', 'Date.now'],
    [Math, 'random', 'Math.random'],
    [String.prototype, 'toLocaleLowerCase', 'toLocaleLowerCase'],
    [String.prototype, 'toLocaleUpperCase', 'toLocaleUpperCase'],
    [String.prototype, 'localeCompare', 'localeCompare'],
    [Number.prototype, 'toLocaleString', 'Number#toLocaleString'],
    [Date.prototype, 'toLocaleDateString', 'toLocaleDateString'],
    [Date.prototype, 'toLocaleTimeString', 'toLocaleTimeString'],
    [Date.prototype, 'toLocaleString', 'Date#toLocaleString'],
    [Date.prototype, 'getTimezoneOffset', 'getTimezoneOffset'],
    [Intl, 'DateTimeFormat', 'Intl.DateTimeFormat'],
    [Intl, 'NumberFormat', 'Intl.NumberFormat'],
    [Intl, 'Collator', 'Intl.Collator'],
    [Intl, 'PluralRules', 'Intl.PluralRules'],
    [Intl, 'Segmenter', 'Intl.Segmenter'],
  ];
  const replaced: Replacement[] = [];
  try {
    for (const [holder, key, name] of targets) {
      const original = (holder as Record<string, unknown>)[key];
      if (original === undefined) continue;
      replaced.push({ holder, key, original });
      Object.defineProperty(holder, key, { value: forbidden(name), configurable: true, writable: true });
    }
    return fn();
  } finally {
    for (const { holder, key, original } of replaced.reverse()) {
      Object.defineProperty(holder, key, { value: original, configurable: true, writable: true });
    }
  }
}

/* ------------------------------------------------------------------ tests */

describe('Feature: quick-add-daily-answer, Property 1: Parsing is total, deterministic, and fully accounted', () => {
  it('never throws, and every result obeys the entry bounds and the problem list rules', () => {
    assertProperty(
      fc.property(lineCaseArb, ({ line, today }) => {
        const result = parseQuickAddLine(line, today);
        expectResultInvariants(line, today, result);
      }),
      { numRuns: MODEL_RUNS },
    );
  });

  it('matches the independent character-accounting model on every line', () => {
    assertProperty(
      fc.property(lineCaseArb, ({ line, today }) => {
        checkAgainstModel(line, today);
      }),
      { numRuns: MODEL_RUNS },
    );
  });

  it('gives equal results on repeat calls under different process time zones', () => {
    assertProperty(
      fc.property(lineCaseArb, ({ line, today }) => {
        const first = parseQuickAddLine(line, today);
        expect(parseQuickAddLine(line, today)).toEqual(first);
        for (const zone of ZONES) {
          const inZone = withProcessTimeZone(zone, () => parseQuickAddLine(line, today));
          expect(inZone).toEqual(first);
        }
      }),
      { numRuns: AMBIENT_RUNS },
    );
  }, AMBIENT_TEST_TIMEOUT_MS);

  it('never reads the clock, random numbers, the locale, or Intl while parsing', () => {
    assertProperty(
      fc.property(lineCaseArb, ({ line, today }) => {
        const expected = parseQuickAddLine(line, today);
        const guarded = withAmbientStateForbidden(() => parseQuickAddLine(line, today));
        expect(guarded).toEqual(expected);
      }),
      { numRuns: AMBIENT_RUNS },
    );
  });

  it('returns one INVALID_DATE problem for a Today that is not a real date, and never throws', () => {
    const badTodayArb = fc.oneof(
      fc.constantFrom('', 'today', '2025-02-30', '2025-13-01', '2025-00-10', '25-03-15', '2025-3-5', '2025/03/15', '2025-03-15 ', '\u0662\u0660\u0662\u0665-03-15', '0000-01-01'),
      invalidDateFieldsArb.map(({ year, month, day }) => formatIsoDate(year, month, day)),
    );
    assertProperty(
      fc.property(rawLineArb, badTodayArb, ({ line }, today) => {
        const result = parseQuickAddLine(line, today);
        expect(result.ok).toBe(false);
        if (line.length > MAX_LINE_LENGTH) {
          expect(describeProblems(result).map((problem) => problem.code)).toEqual(['LINE_TOO_LONG']);
        } else {
          expect(describeProblems(result)).toEqual([{ code: 'INVALID_DATE', subcode: 'NOT_A_DATE', part: '' }]);
        }
      }),
    );
  });

  it('exercises accepted lines and every kind of problem, so the properties above are not vacuous', () => {
    const outcomes = new Map<string, number>();
    let quotedOk = 0;
    let multiProblem = 0;
    const cases = fc.sample(lineCaseArb, { numRuns: 1500, seed: 20250101 });
    for (const { line, today } of cases) {
      const labels = checkAgainstModel(line, today);
      for (const label of labels) outcomes.set(label, (outcomes.get(label) ?? 0) + 1);
      if (labels.length > 1) multiProblem += 1;
      if (labels[0] === 'ok' && line.includes('"')) quotedOk += 1;
    }
    for (const label of [
      'ok',
      'LINE_TOO_LONG',
      'MISSING_AMOUNT',
      'MULTIPLE_AMOUNTS',
      'MULTIPLE_DATES',
      'NOTE_TOO_LONG',
      'INVALID_DATE/NOT_A_DATE',
      'INVALID_DATE/OUT_OF_RANGE',
      'INVALID_AMOUNT/BAD_GROUPING',
      'INVALID_AMOUNT/TOO_MANY_DECIMALS',
      'INVALID_AMOUNT/TRAILING_POINT',
      'INVALID_AMOUNT/ZERO',
      'INVALID_AMOUNT/TOO_LARGE',
    ]) {
      expect(outcomes.get(label) ?? 0, label).toBeGreaterThan(0);
    }
    expect(outcomes.get('ok') ?? 0).toBeGreaterThan(150);
    expect(multiProblem).toBeGreaterThan(0);
    expect(quotedOk).toBeGreaterThan(0);
  });
});

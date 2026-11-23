import { describe, expect, it } from 'vitest';
import { fc } from '../../test/test-utils';
import { assertProperty } from '../../test/propertyReport';
import {
  MAX_LINE_UNITS,
  MAX_NOTE_UNITS,
  TRICKY_NOTE_WORDS,
  boundaryDateArb,
  collapseWhitespace,
  dateFieldsArb,
  dateTokens,
  invalidAmountTokenArb,
  invalidDateFieldsArb,
  noteWordArb,
  permutationArb,
  validDateArb,
  whitespaceRunArb,
  writtenAmountArb,
} from '../../test/quickAddGenerators';
import { addDays, parseIsoDate, scanBackDate, weekdayOf } from '../../test/kolkataReference';
import { parseQuickAddLine, type ParseResult } from './parser';

/*
 * Feature: quick-add-daily-answer, Property 4: Segment order is irrelevant
 *
 * Validates: Requirements 17.5
 *
 * For any line that parses into an entry, any reordering of its amount segment (marker and number kept together),
 * its date segment (`on` and its number kept together), and its note segments returns an equivalent entry.
 *
 * Reference model: the generator builds a line from named segments, so the expected entry comes from the segments
 * and never from the parser. The expected amount is the paise value the amount writer was given, the expected date
 * comes from the calendar model in test/kolkataReference.ts (a day-by-day scan back from Today, or the date the
 * token spells), and the expected note is the unclaimed text of the note segments in line order with whitespace runs
 * collapsed. Three arrangements of the same segments are parsed:
 *   A. one random order,
 *   B. a second random order (the note segments may swap places, so only the note text may differ, and the model
 *      predicts it from the new note order),
 *   C. B with its note slots refilled in A's note order (so the entry must be identical to A's).
 * Quoted note segments are written with `"` escaped as `""`. Spaces between segments are sometimes dropped next to a
 * quoted segment, because a quoted segment ends and starts tokens.
 *
 * Parser decisions the model follows (author's decisions): a lone marker followed by an amount candidate marks that
 * candidate; a candidate that is not chosen stays in the note, so a marked amount may sit next to unmarked decoy
 * numbers; `on N` with N above 31 is the word `on` plus an amount candidate (and `on` directly before a day number
 * 1 to 31 is a date, so the generator never places a note word `on` there); quoted text is note text whatever it
 * contains.
 */

const MAIN_RUNS = 500;
const PROBLEM_RUNS = 300;
const MAX_SEGMENTS = 9;

/* ---------------------------------------------------------------- segments */

interface Segment {
  kind: 'amount' | 'date' | 'note';
  /** The segment as typed. */
  text: string;
  /** True for a quoted note segment. Its first and last tokens do not exist, since quotes end tokens. */
  quoted: boolean;
  firstToken: string | null;
  lastToken: string | null;
  /** Amount segments: the paise the writer was given. */
  paise?: number;
  /** Amount segments: the segment carries a Currency_Marker. */
  marked?: boolean;
  /** Date segments: the date the model expects. */
  date?: string;
  /** Note segments: the pieces of text this segment adds to the note, in order. */
  pieces: string[];
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;

type Casing = 'lower' | 'upper' | 'title';
const casingArb = fc.constantFrom<Casing>('lower', 'upper', 'title');

function cased(word: string, casing: Casing): string {
  if (casing === 'upper') return word.toUpperCase();
  if (casing === 'title') return word.charAt(0).toUpperCase() + word.slice(1);
  return word;
}

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`The reference model found no ${what}.`);
  return value;
}

function tokensOf(text: string): string[] {
  return text.split(/\s+/).filter((token) => token !== '');
}

function plainSegment(kind: Segment['kind'], text: string, extra: Partial<Segment> = {}): Segment {
  const tokens = tokensOf(text);
  return {
    kind,
    text,
    quoted: false,
    firstToken: tokens[0] ?? null,
    lastToken: tokens[tokens.length - 1] ?? null,
    pieces: kind === 'note' ? tokens : [],
    ...extra,
  };
}

function dayOfMonth(date: string): number {
  return Number(date.slice(8, 10));
}

function monthOf(date: string): number {
  return Number(date.slice(5, 7));
}

/* ------------------------------------------------------------- generators */

const todayArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 3, arbitrary: validDateArb({ minYear: 1992, maxYear: 2098 }) },
  { weight: 2, arbitrary: boundaryDateArb.filter((date) => Number(date.slice(0, 4)) >= 1992 && Number(date.slice(0, 4)) <= 2098) },
);

const gapArb: fc.Arbitrary<string> = fc.oneof(fc.constant(' '), whitespaceRunArb);

/** A date segment together with the date the calendar model expects for it. */
function dateSegmentArb(today: string): fc.Arbitrary<Segment> {
  const word = fc
    .record({ word: fc.constantFrom('today', 'yesterday', ...WEEKDAYS), casing: casingArb })
    .map(({ word: name, casing }) => {
      let date: string;
      if (name === 'today') date = today;
      else if (name === 'yesterday') date = addDays(today, -1);
      else {
        const target = WEEKDAYS.indexOf(name as (typeof WEEKDAYS)[number]);
        date = must(scanBackDate(today, (candidate) => weekdayOf(candidate) === target), name);
      }
      return plainSegment('date', cased(name, casing), { date });
    });

  const suffixArb = fc.constantFrom('', 'st', 'nd', 'rd', 'th');
  const onDay = fc
    .record({ n: fc.integer({ min: 1, max: 31 }), suffix: suffixArb, gap: gapArb, casing: casingArb })
    .map(({ n, suffix, gap, casing }) => {
      const date = must(scanBackDate(today, (candidate) => dayOfMonth(candidate) === n), `on ${n}`);
      return plainSegment('date', `${cased('on', casing)}${gap}${n}${suffix}`, { date });
    });

  const ordinal = fc
    .record({ n: fc.integer({ min: 1, max: 31 }), suffix: fc.constantFrom('st', 'nd', 'rd', 'th', 'TH') })
    .map(({ n, suffix }) => {
      const date = must(scanBackDate(today, (candidate) => dayOfMonth(candidate) === n), `${n}${suffix}`);
      return plainSegment('date', `${n}${suffix}`, { date });
    });

  const dayMonth = fc
    .record({ fields: dateFieldsArb({ minYear: 2001, maxYear: 2099 }), padded: fc.boolean() })
    .map(({ fields, padded }) => {
      const { day, month } = fields;
      const text = padded ? `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}` : `${day}/${month}`;
      const date = must(
        scanBackDate(today, (candidate) => dayOfMonth(candidate) === day && monthOf(candidate) === month),
        text,
      );
      return plainSegment('date', text, { date });
    });

  const full = fc
    .record({
      offset: fc.integer({ min: -3000, max: 300 }),
      form: fc.constantFrom<'iso' | 'slashFull' | 'slashNoPad' | 'slashShortYear'>('iso', 'slashFull', 'slashNoPad', 'slashShortYear'),
    })
    .map(({ offset, form }) => {
      const date = addDays(today, offset);
      const tokens = dateTokens(must(parseIsoDate(date), date));
      return plainSegment('date', tokens[form] ?? tokens.slashFull, { date });
    });

  return fc.oneof(
    { weight: 3, arbitrary: word },
    { weight: 3, arbitrary: onDay },
    { weight: 2, arbitrary: ordinal },
    { weight: 2, arbitrary: dayMonth },
    { weight: 3, arbitrary: full },
  );
}

/** Whole rupees from 32 to 99 written bare: `on 45` is the word `on` and an amount, not a date. */
const bareAboveDayArb: fc.Arbitrary<Segment> = fc
  .integer({ min: 32, max: 99 })
  .map((rupees) => plainSegment('amount', String(rupees), { paise: rupees * 100, marked: false }));

const amountSegmentArb: fc.Arbitrary<Segment> = fc.oneof(
  { weight: 5, arbitrary: writtenAmountArb.map((amount) => plainSegment('amount', amount.text, { paise: amount.paise, marked: amount.marker !== '' })) },
  { weight: 2, arbitrary: bareAboveDayArb },
);

const wordsWithGapsArb = (words: fc.Arbitrary<string>, maxWords: number): fc.Arbitrary<{ words: string[]; gaps: string[] }> =>
  fc.record({
    words: fc.array(words, { minLength: 1, maxLength: maxWords }),
    gaps: fc.array(gapArb, { minLength: maxWords, maxLength: maxWords }),
  });

function typeWords(words: readonly string[], gaps: readonly string[]): string {
  return words.map((word, index) => `${word}${index < words.length - 1 ? (gaps[index] ?? ' ') : ''}`).join('');
}

/** One to three plain words in any script, separated by whitespace runs. */
const plainNoteArb: fc.Arbitrary<Segment> = wordsWithGapsArb(noteWordArb(), 3).map(({ words, gaps }) =>
  plainSegment('note', typeWords(words, gaps)));

/** A quoted note whose words may look like amounts, dates, markers, or contain quotes. */
const quotedNoteArb: fc.Arbitrary<Segment> = wordsWithGapsArb(
  fc.oneof(noteWordArb(), fc.constantFrom(...TRICKY_NOTE_WORDS)),
  4,
).map(({ words, gaps }) => {
  const inner = typeWords(words, gaps);
  return {
    kind: 'note',
    text: `"${inner.replace(/"/g, '""')}"`,
    quoted: true,
    firstToken: null,
    lastToken: null,
    pieces: [inner],
  };
});

const noteSegmentArb: fc.Arbitrary<Segment> = fc.oneof(
  { weight: 3, arbitrary: plainNoteArb },
  { weight: 2, arbitrary: quotedNoteArb },
);

/** Unmarked amount candidates, valid or not. They stay in the note when a marked amount is the Amount_Token. */
const decoyArb: fc.Arbitrary<Segment> = fc
  .oneof(
    fc.integer({ min: 1, max: 999_999 }).map(String),
    fc.constantFrom('1,000', '12,00,000', '12,34', '2.5', '0', '0.00', '1.234', '5/-', '.5', '5.', '99999999999999'),
  )
  .map((text) => plainSegment('note', text, { pieces: [text] }));

const onWord: Segment = plainSegment('note', 'on', { pieces: ['on'] });

const separatorArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 4, arbitrary: fc.constant(' ') },
  { weight: 2, arbitrary: whitespaceRunArb },
);

const edgeSpaceArb: fc.Arbitrary<string> = fc.oneof(fc.constant(''), whitespaceRunArb);

interface Layout {
  lead: string;
  trail: string;
  seps: string[];
  /** Drop the space after this position when exactly one of the two neighbours is quoted. */
  glue: boolean[];
}

const layoutArb: fc.Arbitrary<Layout> = fc.record({
  lead: edgeSpaceArb,
  trail: edgeSpaceArb,
  seps: fc.array(separatorArb, { minLength: MAX_SEGMENTS, maxLength: MAX_SEGMENTS }),
  glue: fc.array(fc.boolean(), { minLength: MAX_SEGMENTS, maxLength: MAX_SEGMENTS }),
});

function render(segments: readonly Segment[], order: readonly number[], layout: Layout): string {
  let line = layout.lead;
  order.forEach((index, position) => {
    const segment = segments[index] as Segment;
    line += segment.text;
    const nextIndex = order[position + 1];
    if (nextIndex !== undefined) {
      const next = segments[nextIndex] as Segment;
      line += layout.glue[position] === true && segment.quoted !== next.quoted ? '' : (layout.seps[position] ?? ' ');
    }
  });
  return line + layout.trail;
}

/** A note word `on` directly before a day number 1 to 31 would be a date, which this property does not generate. */
function hasOnBeforeDayNumber(segments: readonly Segment[], order: readonly number[]): boolean {
  return order.some((index, position) => {
    const last = (segments[index] as Segment).lastToken;
    const nextIndex = order[position + 1];
    const first = nextIndex === undefined ? null : (segments[nextIndex] as Segment).firstToken;
    if (last === null || first === null || last.toLowerCase() !== 'on') return false;
    const day = /^([0-9]{1,2})(?:st|nd|rd|th)?$/i.exec(first);
    return day !== null && Number(day[1]) <= 31;
  });
}

function expectedEntry(segments: readonly Segment[], order: readonly number[], today: string) {
  const ordered = order.map((index) => segments[index] as Segment);
  const amount = must(ordered.find((segment) => segment.kind === 'amount'), 'amount segment');
  const date = ordered.find((segment) => segment.kind === 'date');
  const pieces = ordered.filter((segment) => segment.kind === 'note').flatMap((segment) => segment.pieces);
  return {
    amountMinor: must(amount.paise, 'paise'),
    spentOn: date?.date ?? today,
    note: collapseWhitespace(pieces.join(' ')),
  };
}

/** `order` with its note slots refilled with the note segments in the order `noteOrder` lists them. */
function refillNotes(segments: readonly Segment[], order: readonly number[], noteOrder: readonly number[]): number[] {
  const queue = [...noteOrder];
  return order.map((index) => ((segments[index] as Segment).kind === 'note' ? (queue.shift() as number) : index));
}

interface Scenario {
  today: string;
  segments: Segment[];
  orderA: number[];
  orderB: number[];
  orderC: number[];
  layoutA: Layout;
  layoutB: Layout;
}

const scenarioArb: fc.Arbitrary<Scenario> = todayArb
  .chain((today) =>
    fc.record({
      today: fc.constant(today),
      amount: amountSegmentArb,
      date: fc.option(dateSegmentArb(today), { nil: null }),
      notes: fc.array(noteSegmentArb, { minLength: 0, maxLength: 3 }),
      withOn: fc.boolean(),
      decoys: fc.array(decoyArb, { minLength: 0, maxLength: 2 }),
    }))
  .chain(({ today, amount, date, notes, withOn, decoys }) => {
    const segments: Segment[] = [
      amount,
      ...(date === null ? [] : [date]),
      ...notes,
      ...(withOn ? [onWord] : []),
      ...(amount.marked === true ? decoys : []),
    ];
    return fc
      .record({
        orderA: permutationArb(segments.length),
        orderB: permutationArb(segments.length),
        layoutA: layoutArb,
        layoutB: layoutArb,
      })
      .map(({ orderA, orderB, layoutA, layoutB }): Scenario => {
        const noteOrderA = orderA.filter((index) => (segments[index] as Segment).kind === 'note');
        return { today, segments, orderA, orderB, orderC: refillNotes(segments, orderB, noteOrderA), layoutA, layoutB };
      });
  })
  .filter((scenario) =>
    [scenario.orderA, scenario.orderB, scenario.orderC].every((order) => {
      const layout = order === scenario.orderA ? scenario.layoutA : scenario.layoutB;
      return (
        !hasOnBeforeDayNumber(scenario.segments, order)
        && render(scenario.segments, order, layout).length <= MAX_LINE_UNITS
        && expectedEntry(scenario.segments, order, scenario.today).note.length <= MAX_NOTE_UNITS
      );
    }));

function entryOf(result: ParseResult): { amountMinor: number; spentOn: string; note: string } {
  if (!result.ok) throw new Error(`The line did not parse: ${result.problems.map((p) => p.code).join(', ')}`);
  return result.entry;
}

/* -------------------------------------------------------------- properties */

describe('parser segment order (Property 4)', () => {
  it('returns an equivalent entry for any reordering of the amount, date, and note segments', () => {
    assertProperty(
      fc.property(scenarioArb, (scenario) => {
        const { today, segments } = scenario;
        const lineA = render(segments, scenario.orderA, scenario.layoutA);
        const lineB = render(segments, scenario.orderB, scenario.layoutB);
        const lineC = render(segments, scenario.orderC, scenario.layoutB);

        const entryA = entryOf(parseQuickAddLine(lineA, today));
        const entryB = entryOf(parseQuickAddLine(lineB, today));
        const entryC = entryOf(parseQuickAddLine(lineC, today));

        // Each arrangement matches the model built from the segments.
        expect(entryA).toEqual(expectedEntry(segments, scenario.orderA, today));
        expect(entryB).toEqual(expectedEntry(segments, scenario.orderB, today));
        // Moving only the amount and date segments, with the note order kept, gives the identical entry.
        expect(entryC).toEqual(entryA);
        // Moving the note segments too keeps the amount and the date.
        expect(entryB.amountMinor).toBe(entryA.amountMinor);
        expect(entryB.spentOn).toBe(entryA.spentOn);
      }),
      { numRuns: MAIN_RUNS },
    );
  });

  /*
   * Problems follow the same stage order whatever the segment order: date problem, then amount problem, then
   * note problem. The model lists the expected (code, subcode) pairs from the failure each segment was built to cause.
   */
  type Pair = [string, string | undefined];

  interface ProblemScenario {
    today: string;
    segments: Segment[];
    expected: Pair[];
    orderA: number[];
    orderB: number[];
    layoutA: Layout;
    layoutB: Layout;
  }

  const plainAmountArb: fc.Arbitrary<Segment> = fc
    .integer({ min: 1, max: 99_999 })
    .map((rupees) => plainSegment('amount', String(rupees), { paise: rupees * 100, marked: false }));

  const problemScenarioArb: fc.Arbitrary<ProblemScenario> = fc
    .record({
      today: todayArb,
      dateStage: fc.constantFrom('none', 'ok', 'multi', 'invalid'),
      amountStage: fc.constantFrom('ok', 'missing', 'invalid', 'multi'),
      noteStage: fc.constantFrom('ok', 'long'),
    })
    .filter(({ dateStage, amountStage, noteStage }) =>
      dateStage === 'multi' || dateStage === 'invalid' || amountStage !== 'ok' || noteStage === 'long')
    .chain(({ today, dateStage, amountStage, noteStage }) =>
      fc
        .record({
          dates: fc.tuple(dateSegmentArb(today), dateSegmentArb(today)),
          invalidDate: invalidDateFieldsArb.chain((fields) =>
            fc.constantFrom(dateTokens(fields).iso, dateTokens(fields).slashFull)),
          goodAmount: amountSegmentArb,
          invalidAmount: invalidAmountTokenArb,
          plainAmounts: fc.tuple(plainAmountArb, plainAmountArb),
          shortNotes: fc.array(plainNoteArb, { minLength: 0, maxLength: 2 }),
          longNote: fc.integer({ min: MAX_NOTE_UNITS + 1, max: MAX_NOTE_UNITS + 6 }),
        })
        .chain((parts) => {
          const segments: Segment[] = [];
          const expected: Pair[] = [];
          if (dateStage === 'ok') segments.push(parts.dates[0]);
          if (dateStage === 'multi') {
            segments.push(parts.dates[0], parts.dates[1]);
            expected.push(['MULTIPLE_DATES', undefined]);
          }
          if (dateStage === 'invalid') {
            segments.push(plainSegment('date', parts.invalidDate));
            expected.push(['INVALID_DATE', 'NOT_A_DATE']);
          }
          if (amountStage === 'ok') segments.push(parts.goodAmount);
          if (amountStage === 'missing') expected.push(['MISSING_AMOUNT', undefined]);
          if (amountStage === 'invalid') {
            segments.push(plainSegment('amount', parts.invalidAmount.text, { marked: false }));
            expected.push(['INVALID_AMOUNT', parts.invalidAmount.subcode]);
          }
          if (amountStage === 'multi') {
            segments.push(parts.plainAmounts[0], parts.plainAmounts[1]);
            expected.push(['MULTIPLE_AMOUNTS', undefined]);
          }
          segments.push(...(noteStage === 'long' ? [plainSegment('note', 'x'.repeat(parts.longNote))] : parts.shortNotes));
          if (noteStage === 'long') expected.push(['NOTE_TOO_LONG', undefined]);
          return fc
            .record({
              orderA: permutationArb(segments.length),
              orderB: permutationArb(segments.length),
              layoutA: layoutArb,
              layoutB: layoutArb,
            })
            .map(({ orderA, orderB, layoutA, layoutB }): ProblemScenario =>
              ({ today, segments, expected, orderA, orderB, layoutA, layoutB }));
        }))
    .filter((scenario) =>
      render(scenario.segments, scenario.orderA, scenario.layoutA).length <= MAX_LINE_UNITS
      && render(scenario.segments, scenario.orderB, scenario.layoutB).length <= MAX_LINE_UNITS);

  it('reports date, amount, and note problems in the same stage order for any segment order', () => {
    assertProperty(
      fc.property(problemScenarioArb, (scenario) => {
        const pairsOf = (line: string): Pair[] => {
          const result = parseQuickAddLine(line, scenario.today);
          if (result.ok) throw new Error('The line parsed although a segment was built to fail.');
          return result.problems.map((problem): Pair => [problem.code, problem.subcode]);
        };
        expect(pairsOf(render(scenario.segments, scenario.orderA, scenario.layoutA))).toEqual(scenario.expected);
        expect(pairsOf(render(scenario.segments, scenario.orderB, scenario.layoutB))).toEqual(scenario.expected);
      }),
      { numRuns: PROBLEM_RUNS },
    );
  });

  /* The author's decisions as fixed examples, each with its reordering. */
  const TODAY = '2026-03-15';

  it('keeps `on` as a note word when the number after it is above 31', () => {
    expect(parseQuickAddLine('coffee on 45', TODAY)).toEqual({
      ok: true,
      entry: { amountMinor: 4500, spentOn: TODAY, note: 'coffee on' },
    });
    expect(parseQuickAddLine('45 coffee on', TODAY)).toEqual({
      ok: true,
      entry: { amountMinor: 4500, spentOn: TODAY, note: 'coffee on' },
    });
    expect(parseQuickAddLine('coffee on 5 45', TODAY)).toEqual({
      ok: true,
      entry: { amountMinor: 4500, spentOn: '2026-03-05', note: 'coffee' },
    });
  });

  it('marks the amount after a lone marker and leaves the other candidates in the note', () => {
    const expected = { ok: true, entry: { amountMinor: 12_000, spentOn: TODAY, note: '250 tea' } };
    expect(parseQuickAddLine('250 tea Rs. 120', TODAY)).toEqual(expected);
    expect(parseQuickAddLine('Rs. 120 250 tea', TODAY)).toEqual(expected);
    expect(parseQuickAddLine('tea 250 \u20b9 120', TODAY)).toEqual({
      ok: true,
      entry: { amountMinor: 12_000, spentOn: TODAY, note: 'tea 250' },
    });
  });

  it('treats quoted segments as note text that ends and starts tokens', () => {
    const expected = { ok: true, entry: { amountMinor: 12_000, spentOn: TODAY, note: 'today 5 say"hi" tea' } };
    expect(parseQuickAddLine('"today 5 say""hi"""tea 120', TODAY)).toEqual(expected);
    expect(parseQuickAddLine('120"today 5 say""hi""" tea', TODAY)).toEqual(expected);
  });

  it('reports an unusable Today as one INVALID_DATE problem in any order', () => {
    for (const line of ['coffee 120 today', 'today 120 coffee', '120 coffee']) {
      for (const today of ['2026-02-30', '2026-13-01', '', 'today']) {
        const result = parseQuickAddLine(line, today);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.problems.map((p) => [p.code, p.subcode])).toEqual([['INVALID_DATE', 'NOT_A_DATE']]);
      }
    }
  });
});

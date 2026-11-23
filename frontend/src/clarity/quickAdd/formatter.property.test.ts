import { describe, expect, it } from 'vitest';
import { fc } from '../../test/test-utils';
import { assertProperty } from '../../test/propertyReport';
import { formatIsoDate } from '../../test/kolkataReference';
import {
  MAX_AMOUNT_MINOR,
  MAX_LINE_UNITS,
  MAX_NOTE_UNITS,
  collapseWhitespace,
  dateFieldsArb,
  noteArb,
  paiseArb,
  validDateArb,
  whitespaceRunArb,
  writeAmount,
} from '../../test/quickAddGenerators';
import { formatQuickAddLine, type FormattableEntry } from './formatter';
import { parseQuickAddLine, type ParsedEntry } from './parser';

/**
 * The parser's `ParsedEntry` must be assignable to the formatter's `FormattableEntry`. This is checked by the
 * compiler (`tsc --noEmit`); the field names are `amountMinor`, `spentOn`, and `note` on both sides.
 */
const parsedEntryIsFormattable = (entry: ParsedEntry): FormattableEntry => entry;

const RUNS = 300;

/* ----------------------------------------------------------- generators */

/** Today and a date inside the Accepted_Date_Range of that Today (1 January of year - 10 through 31 December of year + 1). */
const todayAndDateArb: fc.Arbitrary<{ today: string; spentOn: string }> = validDateArb({ minYear: 2000, maxYear: 2090 })
  .chain((today) => {
    const year = Number(today.slice(0, 4));
    return fc
      .oneof(
        { weight: 4, arbitrary: dateFieldsArb({ minYear: year - 10, maxYear: year + 1 }).map((f) => formatIsoDate(f.year, f.month, f.day)) },
        { weight: 1, arbitrary: fc.constantFrom(formatIsoDate(year - 10, 1, 1), formatIsoDate(year + 1, 12, 31), today) },
      )
      .map((spentOn) => ({ today, spentOn }));
  });

const SOUP_UNITS: readonly string[] = Object.freeze([
  '"', '"', '""', 'a', 'Z', 'on', '7', '0', '5', ' ', ' ', '\t', '\u00a0', '\u2003', '.', ',', '/', '-', ':', '\u20b9',
  '\u091a\u093e', '\u0c1f\u0c40', 'today', '3rd', '\uff11\uff12',
]);

/** Free-form notes made of quotes, digits, separators, date words, whitespace runs of several kinds, and Indic text. */
const noteSoupArb: fc.Arbitrary<string> = fc.string({ unit: fc.constantFrom(...SOUP_UNITS), minLength: 0, maxLength: 40 });

/** A canonical note whose words are joined by whitespace runs, as a User could have typed it. */
const spacedNoteArb: fc.Arbitrary<string> = fc
  .array(fc.tuple(noteArb({ maxWords: 1, tricky: true }).filter((w) => w !== ''), whitespaceRunArb), { minLength: 1, maxLength: 5 })
  .map((pairs) => pairs.map(([word, run]) => `${word}${run}`).join(''));

/**
 * Note as handed to the formatter. Most are canonical (single spaces, trimmed); some carry whitespace runs. The
 * collapsed note stays within 120 code units (Requirement 2.4), and the formatted line within the 200-unit input limit.
 */
const anyNoteArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 3, arbitrary: noteArb({ tricky: true, maxWords: 6 }) },
  { weight: 1, arbitrary: noteArb({ tricky: false, maxWords: 8 }) },
  { weight: 2, arbitrary: noteSoupArb },
  { weight: 1, arbitrary: spacedNoteArb },
).filter((note) => collapseWhitespace(note).length <= MAX_NOTE_UNITS);

const entryArb: fc.Arbitrary<{ today: string; entry: FormattableEntry }> = fc
  .record({ dates: todayAndDateArb, amountMinor: paiseArb, note: anyNoteArb })
  .map(({ dates, amountMinor, note }) => ({ today: dates.today, entry: { amountMinor, spentOn: dates.spentOn, note } }));

/* ----------------------------------------------------- independent model */

/** `₹<Indian grouping>[.dd] <yyyy-mm-dd>[ "<note, quotes doubled>"]`, written without the formatter. */
function modelLine({ amountMinor, spentOn, note }: FormattableEntry): string {
  const amount = writeAmount(amountMinor, {
    grouping: 'indian',
    fraction: amountMinor % 100 === 0 ? 'minimal' : 'always',
    marker: '\u20b9',
  });
  const quoted = note === '' ? '' : ` "${note.split('"').join('""')}"`;
  return `${amount} ${spentOn}${quoted}`;
}

/* ------------------------------------------------------------------ tests */

// Feature: quick-add-daily-answer, Property 3: Entry format and parse round trip
// Validates: Requirements 2.32, 2.33
describe('Property 3: Entry format and parse round trip', () => {
  it('writes the model line and parses back to the same entry, with the note whitespace-collapsed', () => {
    let tested = 0;
    assertProperty(
      fc.property(entryArb, ({ today, entry }) => {
        const line = formatQuickAddLine(entry);

        // Only lines the input can hold are in scope (the 200-unit input limit).
        fc.pre(line.length <= MAX_LINE_UNITS);
        tested += 1;

        // The formatter writes exactly the independent model's line.
        expect(line).toBe(modelLine(entry));

        // The parser reads it back to an equal entry.
        const parsed = parseQuickAddLine(line, today);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        expect(Object.keys(parsed.entry).sort()).toEqual(['amountMinor', 'note', 'spentOn']);
        expect(parsed.entry).toEqual({
          amountMinor: entry.amountMinor,
          spentOn: entry.spentOn,
          note: collapseWhitespace(entry.note),
        });
        // A parser result goes straight back into the formatter, and the line is a fixed point.
        expect(formatQuickAddLine(parsedEntryIsFormattable(parsed.entry))).toBe(
          modelLine({ ...entry, note: collapseWhitespace(entry.note) }),
        );
      }),
      { numRuns: RUNS },
    );
    expect(tested).toBeGreaterThanOrEqual(100);
  });

  it('round trips the amount and date edges with notes that look like amounts, dates, and markers', () => {
    const edgeNotes = ['7up', '40', '1,000', '\u20b9 50', 'on 3rd', 'today', 'yesterday Monday', '12/05', '2026-01-31', 'say "hi"', '"', '""', ' a  b ', '\u091a\u093e\u092f 120', '\u0c1f\u0c40'];
    const today = '2026-03-15';
    for (const amountMinor of [1, 99, 100, 101, 12_050, 12_000_000, MAX_AMOUNT_MINOR]) {
      for (const spentOn of ['2016-01-01', '2024-02-29', '2026-03-15', '2027-12-31']) {
        for (const note of ['', ...edgeNotes]) {
          const entry = { amountMinor, spentOn, note };
          const parsed = parseQuickAddLine(formatQuickAddLine(entry), today);
          expect(parsed).toEqual({ ok: true, entry: { amountMinor, spentOn, note: collapseWhitespace(note) } });
        }
      }
    }
  });
});

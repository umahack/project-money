import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  KOLKATA_OFFSET_MS,
  addDays,
  daysInMonth,
  isRealDate,
  kolkataDateOf,
  kolkataMidnightMs,
  kolkataMonthOf,
  parseIsoDate,
  scanBackDate,
  weekdayOf,
  withProcessTimeZone,
} from './kolkataReference';
import { PropertyFailure, assertProperty, describeStructure } from './propertyReport';
import {
  BUILT_IN_CATEGORIES,
  MAX_AMOUNT_MINOR,
  MAX_NOTE_UNITS,
  MEMORY_CAPACITY,
  RESERVED_WORDS,
  anyRealDateArb,
  collapseWhitespace,
  dateTokens,
  invalidAmountTokenArb,
  invalidDateFieldsArb,
  kolkataInstantArb,
  memoryCommandsArb,
  memoryStateArb,
  monthLedgerArb,
  noteArb,
  noteKeyBoundaryArb,
  noteKeyInputArb,
  overlongNoteArb,
  paiseArb,
  referenceNoteKey,
  saveScenarioArb,
  typedNoteArb,
  validDateArb,
  writeAmount,
  writtenAmountArb,
} from './quickAddGenerators';

interface NoteKeyFixture {
  cases: Array<{ name: string; input: string; expected: string | null }>;
}

// The fixture lives in the backend package. Both runtimes read the same file.
// Vitest runs with the frontend package as its working directory.
const fixturePath = resolve(process.cwd(), '..', 'backend', 'test', 'fixtures', 'noteKey.json');
const noteKeyFixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as NoteKeyFixture;

describe('Kolkata reference', () => {
  it('reads the Asia/Kolkata date through Intl', () => {
    expect(kolkataDateOf('2026-01-14T18:29:59.999Z')).toBe('2026-01-14');
    expect(kolkataDateOf('2026-01-14T18:30:00.000Z')).toBe('2026-01-15');
    expect(kolkataMonthOf('2026-01-31T18:30:00.000Z')).toBe('2026-02');
    expect(kolkataDateOf('2024-02-28T18:30:00.000Z')).toBe('2024-02-29');
    expect(kolkataMidnightMs('2026-01-15')).toBe(Date.parse('2026-01-14T18:30:00.000Z'));
    expect(KOLKATA_OFFSET_MS).toBe(5.5 * 3_600_000);
    expect(() => kolkataDateOf('not a date')).toThrow(RangeError);
  });

  it('does not depend on the process time zone', () => {
    const instant = Date.parse('2026-03-31T18:30:00.000Z');
    const offsets: number[] = [];
    for (const zone of ['UTC', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Asia/Kolkata']) {
      withProcessTimeZone(zone, () => {
        offsets.push(new Date(instant).getTimezoneOffset());
        expect(kolkataDateOf(instant)).toBe('2026-04-01');
        expect(kolkataMonthOf(instant)).toBe('2026-04');
      });
    }
    expect(new Set(offsets).size).toBe(4);
  });

  it('agrees with known calendar facts and the day-by-day scan', () => {
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2100, 2)).toBe(28);
    expect(isRealDate(2026, 2, 29)).toBe(false);
    expect(parseIsoDate('2024-02-29')).toEqual({ year: 2024, month: 2, day: 29 });
    expect(parseIsoDate('2026-02-29')).toBeNull();
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(weekdayOf('2026-01-15')).toBe(4);
    expect(scanBackDate('2026-07-04', (d) => d.endsWith('-31'))).toBe('2026-05-31');
  });
});

describe('Note_Key fixture', () => {
  it('matches the independent reference and covers the required forms', () => {
    const { cases } = noteKeyFixture;
    expect(cases.length).toBeGreaterThanOrEqual(40);
    for (const { name, input, expected } of cases) {
      expect(referenceNoteKey(input), name).toBe(expected);
    }
    const inputs = cases.map((c) => c.input);
    expect(inputs.some((s) => /[\u0900-\u097f]/.test(s))).toBe(true);
    expect(inputs.some((s) => /[\u0c00-\u0c7f]/.test(s))).toBe(true);
    expect(inputs.some((s) => s.includes('\u200d')) && inputs.some((s) => s.includes('\u200c'))).toBe(true);
    expect(inputs.some((s) => s.includes('\u0301'))).toBe(true);
    expect(inputs).toContain('');
    expect(cases.find((c) => c.input === 'a'.repeat(61))?.expected).toBeNull();
    expect(cases.find((c) => c.input === 'a'.repeat(60))?.expected).toBe('a'.repeat(60));
  });

  it('keeps the reference idempotent and bounded for generated strings', () => {
    assertProperty(fc.property(noteKeyInputArb, (text) => {
      const key = referenceNoteKey(text);
      if (key === null) return;
      expect(referenceNoteKey(key)).toBe(key);
      expect([...key].length).toBeGreaterThanOrEqual(1);
      expect([...key].length).toBeLessThanOrEqual(60);
    }));
    assertProperty(fc.property(noteKeyBoundaryArb, ({ codePoints, text }) => {
      expect([...text].length).toBe(codePoints);
      expect(referenceNoteKey(text) === null).toBe(codePoints > 60);
    }));
  });
});

describe('generators', () => {
  it('produce real, boundary, and invalid dates', () => {
    assertProperty(fc.property(anyRealDateArb, (date) => parseIsoDate(date) !== null));
    assertProperty(fc.property(invalidDateFieldsArb, ({ year, month, day }) => {
      expect(isRealDate(year, month, day)).toBe(false);
      expect(Object.keys(dateTokens({ year, month, day })).length).toBeGreaterThanOrEqual(2);
    }));
    const seen = { leapDay: false, monthEnd: false };
    fc.assert(fc.property(anyRealDateArb, (date) => {
      if (date.endsWith('-02-29')) seen.leapDay = true;
      const fields = parseIsoDate(date);
      if (fields && fields.day === daysInMonth(fields.year, fields.month)) seen.monthEnd = true;
    }), { numRuns: 600 });
    expect(seen).toEqual({ leapDay: true, monthEnd: true });
  });

  it('produce Kolkata instants that straddle midnight', () => {
    assertProperty(fc.property(kolkataInstantArb(), ({ midnightDate, offsetMs, instantMs, iso, expectedDate }) => {
      expect(new Date(instantMs).toISOString()).toBe(iso);
      expect(instantMs).toBe(kolkataMidnightMs(midnightDate) + offsetMs);
      expect(expectedDate).toBe(offsetMs < 0 ? addDays(midnightDate, -1) : midnightDate);
    }));
  });

  it('write amounts that an independent digit reader reads back', () => {
    const read = (text: string): number => {
      const body = text.replace(/\/-$/, '').replace(/^(₹|rs\.?|inr)\s*/i, '');
      expect(body).toMatch(/^[0-9,]+(\.[0-9]{1,2})?$/);
      const [whole = '', fraction = ''] = body.replaceAll(',', '').split('.');
      return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
    };
    expect(writeAmount(12_000_000, { grouping: 'indian', marker: '₹', suffix: '/-' })).toBe('₹1,20,000.00/-');
    expect(writeAmount(12_000_000, { grouping: 'western', fraction: 'minimal' })).toBe('120,000');
    expect(writeAmount(12_050, { fraction: 'minimal' })).toBe('120.5');
    expect(writeAmount(5, { fraction: 'minimal', marker: 'Rs.' })).toBe('Rs. 0.05');
    assertProperty(fc.property(writtenAmountArb, ({ paise, text }) => {
      expect(paise).toBeGreaterThanOrEqual(1);
      expect(paise).toBeLessThanOrEqual(MAX_AMOUNT_MINOR);
      expect(read(text)).toBe(paise);
    }));
    assertProperty(fc.property(paiseArb, (paise) => Number.isSafeInteger(paise) && paise >= 1 && paise <= MAX_AMOUNT_MINOR));
  });

  it('produce invalid amount tokens that each break the rule they name', () => {
    assertProperty(fc.property(invalidAmountTokenArb, ({ subcode, text }) => {
      const [whole = '', fraction] = text.split('.');
      switch (subcode) {
        case 'BAD_GROUPING':
          expect(text).toContain(',');
          expect(text).not.toMatch(/^(\d{1,2}(,\d{2})*,\d{3}|\d{1,3}(,\d{3})+)$/);
          break;
        case 'TOO_MANY_DECIMALS': expect((fraction ?? '').length).toBeGreaterThan(2); break;
        case 'NO_INTEGER_PART': expect(whole).toBe(''); break;
        case 'TRAILING_POINT': expect(text.endsWith('.')).toBe(true); break;
        case 'ZERO': expect(Number(text)).toBe(0); break;
        case 'TOO_LARGE': expect(whole.length).toBeGreaterThan(11); break;
        default: throw new Error('unexpected subcode');
      }
    }));
  });

  it('produce notes within limits, outside reserved words, with whitespace that collapses', () => {
    const reserved = new Set(RESERVED_WORDS);
    assertProperty(fc.property(noteArb(), (note) => {
      expect(note.length).toBeLessThanOrEqual(MAX_NOTE_UNITS);
      expect(note).toBe(collapseWhitespace(note));
      expect(note.split(' ').some((word) => reserved.has(word.toLowerCase()))).toBe(false);
    }));
    assertProperty(fc.property(typedNoteArb(), ({ typed, canonical }) => collapseWhitespace(typed) === canonical));
    assertProperty(fc.property(noteArb({ tricky: true }), (note) => note.length <= MAX_NOTE_UNITS));
    assertProperty(fc.property(overlongNoteArb, (note) => {
      expect(note.length).toBeGreaterThan(MAX_NOTE_UNITS);
      expect(note.length).toBeLessThanOrEqual(200);
      expect(note).toBe(note.trim());
    }));
    const scripts = new Set<string>();
    fc.assert(fc.property(noteArb({ maxWords: 6 }), (note) => {
      if (/[a-z]/i.test(note)) scripts.add('latin');
      if (/[\u0900-\u097f]/.test(note)) scripts.add('devanagari');
      if (/[\u0c00-\u0c7f]/.test(note)) scripts.add('telugu');
    }), { numRuns: 300 });
    expect([...scripts].sort()).toEqual(['devanagari', 'latin', 'telugu']);
  });

  it('produce consistent month ledgers with marks and missing dates', () => {
    const seen = { marked: false, unmarked: false, noDate: false, today: false, unparseable: false };
    assertProperty(fc.property(monthLedgerArb(), ({ month, localDate, expenses, plan }) => {
      expect(localDate.startsWith(month)).toBe(true);
      expect(new Set(expenses.map((e) => e.id)).size).toBe(expenses.length);
      const total = expenses.reduce((sum, e) => sum + e.amountMinor, 0);
      expect(plan.remainingSpendableMinor).toBe(plan.spendableBudgetMinor - total);
      const fields = parseIsoDate(localDate);
      expect(fields).not.toBeNull();
      if (!fields) return;
      expect(plan.period.daysRemainingInclusive).toBe(daysInMonth(fields.year, fields.month) - fields.day + 1);
      const exact = plan.remainingSpendableMinor / plan.period.daysRemainingInclusive;
      expect(Math.abs(plan.dailySpendingGuideMinor - exact)).toBeLessThanOrEqual(0.5 + 1e-9);
      for (const e of expenses) {
        if (e.spentOn !== null) expect(e.spentOn.startsWith(month) && parseIsoDate(e.spentOn) !== null).toBe(true);
        seen[e.excludeFromDailyAllowance ? 'marked' : 'unmarked'] = true;
        if (e.spentOn === null) seen.noDate = true;
        if (e.spentOn === localDate) seen.today = true;
        if (e.createdAt === 'not-a-timestamp') seen.unparseable = true;
      }
    }));
    expect(Object.values(seen)).toEqual([true, true, true, true, true]);
    assertProperty(fc.property(monthLedgerArb({ marks: 'all' }), ({ expenses }) => expenses.every((e) => e.excludeFromDailyAllowance)));
    assertProperty(fc.property(monthLedgerArb({ marks: 'none' }), ({ expenses }) => expenses.every((e) => !e.excludeFromDailyAllowance)));
    assertProperty(fc.property(monthLedgerArb({ extremeBudget: true }), ({ plan }) => Number.isSafeInteger(plan.remainingSpendableMinor)));
  });

  it('produce memory states with unique keys that reach 501 entries', () => {
    let largest = 0;
    assertProperty(fc.property(memoryStateArb(), (state) => {
      largest = Math.max(largest, state.length);
      expect(state.length).toBeLessThanOrEqual(MEMORY_CAPACITY + 1);
      expect(new Set(state.map((e) => e.noteKey)).size).toBe(state.length);
      expect(new Set(state.map((e) => e.id)).size).toBe(state.length);
      expect(state.every((e) => referenceNoteKey(e.noteKey) === e.noteKey && BUILT_IN_CATEGORIES.includes(e.category))).toBe(true);
    }), { numRuns: 200 });
    expect(largest).toBe(MEMORY_CAPACITY + 1);
  });

  it('produce consistent command and save interleavings', () => {
    assertProperty(fc.property(memoryCommandsArb(), (commands) =>
      commands.every((c) => ['upsert', 'remove', 'removeAll', 'removeCategory', 'replay'].includes(c.kind))));
    assertProperty(fc.property(saveScenarioArb(), ({ entries, sends, sendOrder, responseOrder }) => {
      expect(new Set(entries.map((e) => e.idempotencyKey)).size).toBe(entries.length);
      const identity = sends.map((_, i) => i);
      expect([...sendOrder].sort((a, b) => a - b)).toEqual(identity);
      expect([...responseOrder].sort((a, b) => a - b)).toEqual(identity);
      expect(sends.filter((s) => s.kind === 'first')).toHaveLength(entries.length);
      expect(sends.every((s) => s.entry >= 0 && s.entry < entries.length)).toBe(true);
      expect(entries.every((e) => Number.isSafeInteger(e.amountMinor) && e.amountMinor < MAX_AMOUNT_MINOR && parseIsoDate(e.spentOn) !== null)).toBe(true);
    }));
    assertProperty(fc.property(validDateArb(), (date) => parseIsoDate(date) !== null));
  });
});

describe('property failure report', () => {
  it('prints structure and IDs only', () => {
    const secretNote = 'secret-note-text';
    const described = describeStructure({
      id: 7,
      amountMinor: 123_456,
      note: secretNote,
      noteKey: secretNote,
      category: 'Food',
      kind: 'upsert',
      idempotencyKey: 'idem-3-abc',
      nested: [{ userId: 2, note: secretNote }],
      flag: true,
    });
    expect(described).not.toMatch(/123456|secret-note-text|Food/);
    expect(described).toContain('id: 7');
    expect(described).toContain('kind: "upsert"');
    expect(described).toContain('idempotencyKey: "idem-3-abc"');
    expect(described).toContain('userId: 2');

    let caught: unknown;
    try {
      assertProperty(fc.property(
        fc.record({ id: fc.constant(9), note: fc.constant(secretNote), amountMinor: fc.constant(777_000) }),
        () => { throw new Error(`boom ${secretNote} 777000`); },
      ));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PropertyFailure);
    const message = (caught as PropertyFailure).message;
    expect(message).toMatch(/seed -?\d+/);
    expect(message).toContain('id: 9');
    expect(message).not.toMatch(/secret-note-text|777000/);
  });
});

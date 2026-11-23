import '../helpers/blockingStdout.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
} from '../helpers/kolkataReference.js';
import { PropertyFailure, assertProperty, describeStructure } from '../helpers/propertyReport.js';
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
} from '../helpers/quickAddGenerators.js';

const noteKeyFixture = JSON.parse(
  readFileSync(new URL('../fixtures/noteKey.json', import.meta.url), 'utf8'),
);

test('Kolkata reference reads the Asia/Kolkata date through Intl', () => {
  assert.equal(kolkataDateOf('2026-01-14T18:29:59.999Z'), '2026-01-14');
  assert.equal(kolkataDateOf('2026-01-14T18:30:00.000Z'), '2026-01-15');
  assert.equal(kolkataMonthOf('2026-01-31T18:30:00.000Z'), '2026-02');
  assert.equal(kolkataDateOf('2024-02-28T18:30:00.000Z'), '2024-02-29');
  assert.equal(kolkataMidnightMs('2026-01-15'), Date.parse('2026-01-14T18:30:00.000Z'));
  assert.equal(KOLKATA_OFFSET_MS, 5.5 * 3_600_000);
  assert.throws(() => kolkataDateOf('not a date'), RangeError);
});

test('Kolkata reference does not depend on the process time zone', () => {
  const instant = Date.parse('2026-03-31T18:30:00.000Z');
  const offsets = [];
  for (const zone of ['UTC', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Asia/Kolkata']) {
    withProcessTimeZone(zone, () => {
      offsets.push(new Date(instant).getTimezoneOffset());
      assert.equal(kolkataDateOf(instant), '2026-04-01');
      assert.equal(kolkataMonthOf(instant), '2026-04');
    });
  }
  assert.equal(new Set(offsets).size, 4, 'each run saw a different process time zone');
});

test('calendar helpers agree with known dates and the day-by-day scan', () => {
  assert.equal(daysInMonth(2024, 2), 29);
  assert.equal(daysInMonth(2100, 2), 28);
  assert.equal(isRealDate(2026, 2, 29), false);
  assert.deepEqual(parseIsoDate('2024-02-29'), { year: 2024, month: 2, day: 29 });
  assert.equal(parseIsoDate('2026-02-29'), null);
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(weekdayOf('2026-01-15'), 4);
  // 31 skips the 30-day months: the latest 31st on or before 2026-07-04 is 2026-05-31.
  assert.equal(scanBackDate('2026-07-04', (d) => d.endsWith('-31')), '2026-05-31');
});

test('Note_Key fixture matches the independent reference and covers the required forms', () => {
  const { cases } = noteKeyFixture;
  assert.ok(cases.length >= 40);
  for (const { name, input, expected } of cases) {
    assert.equal(referenceNoteKey(input), expected, name);
  }
  const inputs = cases.map((c) => c.input);
  assert.ok(inputs.some((s) => /[\u0900-\u097f]/.test(s)), 'Devanagari');
  assert.ok(inputs.some((s) => /[\u0c00-\u0c7f]/.test(s)), 'Telugu');
  assert.ok(inputs.some((s) => s.includes('\u200d')) && inputs.some((s) => s.includes('\u200c')), 'joiners');
  assert.ok(inputs.some((s) => s.includes('\u0301')), 'combining mark');
  assert.ok(inputs.some((s) => s !== s.normalize('NFC')) && inputs.some((s) => s === s.normalize('NFC') && s !== s.normalize('NFD')), 'NFD and NFC forms');
  assert.ok(inputs.includes(''), 'empty input');
  const lengths = cases.map((c) => (c.expected === null ? null : [...c.expected].length));
  assert.ok(lengths.includes(60) && lengths.includes(null));
  assert.equal(cases.find((c) => c.input === 'a'.repeat(61))?.expected, null);
  assert.equal(cases.find((c) => c.input === 'a'.repeat(60))?.expected, 'a'.repeat(60));
  assert.ok(cases.every((c) => c.expected === null || c.expected === c.expected.normalize('NFKC')));
});

test('Note_Key reference is idempotent and bounded for generated strings', () => {
  assertProperty(fc.property(noteKeyInputArb, (text) => {
    const key = referenceNoteKey(text);
    if (key === null) return;
    assert.equal(referenceNoteKey(key), key);
    assert.ok([...key].length >= 1 && [...key].length <= 60);
  }));
  assertProperty(fc.property(noteKeyBoundaryArb, ({ codePoints, text }) => {
    assert.equal([...text].length, codePoints);
    assert.equal(referenceNoteKey(text) === null, codePoints > 60);
  }));
});

test('date generators produce real, boundary, and invalid dates', () => {
  assertProperty(fc.property(anyRealDateArb, (date) => {
    assert.ok(parseIsoDate(date), 'real date');
  }));
  assertProperty(fc.property(invalidDateFieldsArb, ({ year, month, day }) => {
    assert.equal(isRealDate(year, month, day), false);
    assert.ok(Object.keys(dateTokens({ year, month, day })).length >= 2);
  }));
  const seen = { leapDay: false, monthEnd: false };
  fc.assert(fc.property(anyRealDateArb, (date) => {
    if (date.endsWith('-02-29')) seen.leapDay = true;
    const { year, month, day } = parseIsoDate(date);
    if (day === daysInMonth(year, month)) seen.monthEnd = true;
  }), { numRuns: 600 });
  assert.deepEqual(seen, { leapDay: true, monthEnd: true });
});

test('Kolkata instants straddle midnight and report the Intl date', () => {
  assertProperty(fc.property(kolkataInstantArb(), ({ midnightDate, offsetMs, instantMs, iso, expectedDate }) => {
    assert.equal(new Date(instantMs).toISOString(), iso);
    assert.equal(instantMs, kolkataMidnightMs(midnightDate) + offsetMs);
    assert.equal(expectedDate, offsetMs < 0 ? addDays(midnightDate, -1) : midnightDate);
  }));
});

test('amount writer round trips through an independent digit reader', () => {
  const read = (text) => {
    const body = text.replace(/\/-$/, '').replace(/^(₹|rs\.?|inr)\s*/i, '');
    assert.match(body, /^[0-9,]+(\.[0-9]{1,2})?$/);
    const [whole, fraction = ''] = body.replaceAll(',', '').split('.');
    return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  };
  assert.equal(writeAmount(12_000_000, { grouping: 'indian', marker: '₹', suffix: '/-' }), '₹1,20,000.00/-');
  assert.equal(writeAmount(12_000_000, { grouping: 'western', fraction: 'minimal' }), '120,000');
  assert.equal(writeAmount(12_050, { fraction: 'minimal' }), '120.5');
  assert.equal(writeAmount(5, { fraction: 'minimal', marker: 'Rs.' }), 'Rs. 0.05');
  assertProperty(fc.property(writtenAmountArb, ({ paise, text }) => {
    assert.ok(paise >= 1 && paise <= MAX_AMOUNT_MINOR);
    assert.equal(read(text), paise);
  }));
  assertProperty(fc.property(paiseArb, (paise) => {
    assert.ok(Number.isSafeInteger(paise) && paise >= 1 && paise <= MAX_AMOUNT_MINOR);
  }));
});

test('invalid amount tokens each break the rule they name', () => {
  assertProperty(fc.property(invalidAmountTokenArb, ({ subcode, text }) => {
    const [whole = '', fraction] = text.split('.');
    switch (subcode) {
      case 'BAD_GROUPING':
        assert.ok(text.includes(','));
        assert.doesNotMatch(text, /^(\d{1,2}(,\d{2})*,\d{3}|\d{1,3}(,\d{3})+)$/);
        break;
      case 'TOO_MANY_DECIMALS': assert.ok((fraction ?? '').length > 2); break;
      case 'NO_INTEGER_PART': assert.equal(whole, ''); break;
      case 'TRAILING_POINT': assert.ok(text.endsWith('.')); break;
      case 'ZERO': assert.ok(Number(text) === 0); break;
      case 'TOO_LARGE': assert.ok(whole.length > 11); break;
      default: assert.fail(`unexpected subcode ${subcode}`);
    }
  }));
});

test('note generators respect length limits, reserved words, and whitespace collapsing', () => {
  const reserved = new Set(RESERVED_WORDS);
  assertProperty(fc.property(noteArb(), (note) => {
    assert.ok(note.length <= MAX_NOTE_UNITS);
    assert.equal(note, collapseWhitespace(note));
    assert.ok(!note.split(' ').some((word) => reserved.has(word.toLowerCase())));
  }));
  assertProperty(fc.property(typedNoteArb(), ({ typed, canonical }) => {
    assert.equal(collapseWhitespace(typed), canonical);
  }));
  assertProperty(fc.property(noteArb({ tricky: true }), (note) => {
    assert.ok(note.length <= MAX_NOTE_UNITS);
  }));
  assertProperty(fc.property(overlongNoteArb, (note) => {
    assert.ok(note.length > MAX_NOTE_UNITS && note.length <= 200);
    assert.equal(note, note.trim());
  }));
  const scripts = new Set();
  fc.assert(fc.property(noteArb({ maxWords: 6 }), (note) => {
    if (/[a-z]/i.test(note)) scripts.add('latin');
    if (/[\u0900-\u097f]/.test(note)) scripts.add('devanagari');
    if (/[\u0c00-\u0c7f]/.test(note)) scripts.add('telugu');
  }), { numRuns: 300 });
  assert.deepEqual([...scripts].sort(), ['devanagari', 'latin', 'telugu']);
});

test('month ledgers are internally consistent and cover marks and missing dates', () => {
  const seen = { marked: false, unmarked: false, noDate: false, today: false, unparseable: false };
  assertProperty(fc.property(monthLedgerArb(), (ledger) => {
    const { month, localDate, expenses, plan } = ledger;
    assert.ok(parseIsoDate(localDate) && localDate.startsWith(month));
    assert.equal(new Set(expenses.map((e) => e.id)).size, expenses.length);
    const total = expenses.reduce((sum, e) => sum + e.amountMinor, 0);
    assert.equal(plan.remainingSpendableMinor, plan.spendableBudgetMinor - total);
    const { year, month: m, day } = parseIsoDate(localDate);
    assert.equal(plan.period.daysRemainingInclusive, daysInMonth(year, m) - day + 1);
    const days = plan.period.daysRemainingInclusive;
    const exact = plan.remainingSpendableMinor / days;
    assert.ok(Math.abs(plan.dailySpendingGuideMinor - exact) <= 0.5 + 1e-9);
    for (const e of expenses) {
      assert.equal(typeof e.excludeFromDailyAllowance, 'boolean');
      if (e.spentOn !== null) assert.ok(e.spentOn.startsWith(month) && parseIsoDate(e.spentOn));
      seen[e.excludeFromDailyAllowance ? 'marked' : 'unmarked'] = true;
      if (e.spentOn === null) seen.noDate = true;
      if (e.spentOn === localDate) seen.today = true;
      if (e.createdAt === 'not-a-timestamp') seen.unparseable = true;
    }
  }));
  assert.deepEqual(Object.values(seen), [true, true, true, true, true]);
  assertProperty(fc.property(monthLedgerArb({ marks: 'all' }), ({ expenses }) => expenses.every((e) => e.excludeFromDailyAllowance)));
  assertProperty(fc.property(monthLedgerArb({ marks: 'none' }), ({ expenses }) => expenses.every((e) => !e.excludeFromDailyAllowance)));
  assertProperty(fc.property(monthLedgerArb({ extremeBudget: true }), ({ plan }) => Number.isSafeInteger(plan.remainingSpendableMinor)));
});

test('memory states hold unique keys and reach 501 entries', () => {
  let largest = 0;
  assertProperty(fc.property(memoryStateArb(), (state) => {
    largest = Math.max(largest, state.length);
    assert.ok(state.length <= MEMORY_CAPACITY + 1);
    assert.equal(new Set(state.map((e) => e.noteKey)).size, state.length);
    assert.equal(new Set(state.map((e) => e.id)).size, state.length);
    assert.ok(state.every((e) => referenceNoteKey(e.noteKey) === e.noteKey && BUILT_IN_CATEGORIES.includes(e.category)));
  }), { numRuns: 200 });
  assert.equal(largest, MEMORY_CAPACITY + 1);
});

test('command and save scenario generators produce consistent interleavings', () => {
  assertProperty(fc.property(memoryCommandsArb(), (commands) => {
    assert.ok(commands.every((c) => ['upsert', 'remove', 'removeAll', 'removeCategory', 'replay'].includes(c.kind)));
  }));
  assertProperty(fc.property(saveScenarioArb(), ({ entries, sends, sendOrder, responseOrder }) => {
    assert.equal(new Set(entries.map((e) => e.idempotencyKey)).size, entries.length);
    assert.equal([...sendOrder].sort((a, b) => a - b).join(), sends.map((_, i) => i).join());
    assert.equal([...responseOrder].sort((a, b) => a - b).join(), sends.map((_, i) => i).join());
    assert.equal(sends.filter((s) => s.kind === 'first').length, entries.length);
    assert.ok(sends.every((s) => s.entry >= 0 && s.entry < entries.length));
    assert.ok(entries.every((e) => Number.isSafeInteger(e.amountMinor) && e.amountMinor < MAX_AMOUNT_MINOR && parseIsoDate(e.spentOn)));
  }));
  assertProperty(fc.property(validDateArb(), (date) => parseIsoDate(date) !== null));
});

test('failed properties print structure and IDs only', () => {
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
  assert.doesNotMatch(described, /123456|secret-note-text|Food/);
  assert.match(described, /id: 7/);
  assert.match(described, /kind: "upsert"/);
  assert.match(described, /idempotencyKey: "idem-3-abc"/);
  assert.match(described, /userId: 2/);

  assert.throws(
    () => assertProperty(fc.property(
      fc.record({ id: fc.constant(9), note: fc.constant(secretNote), amountMinor: fc.integer({ min: 777_000, max: 777_000 }) }),
      () => { throw new Error(`boom ${secretNote} 777000`); },
    )),
    (error) => {
      assert.ok(error instanceof PropertyFailure);
      assert.match(error.message, /seed -?\d+/);
      assert.match(error.message, /id: 9/);
      assert.doesNotMatch(error.message, /secret-note-text|777000/);
      return true;
    },
  );
});

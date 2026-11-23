import { describe, expect, it } from 'vitest';
import { fc } from '../../test/test-utils';
import { assertProperty } from '../../test/propertyReport';
import {
  MAX_AMOUNT_MINOR,
  SCRIPT_WORD_ARBS,
  anyRealDateArb,
  paiseArb,
  referenceNoteKey,
  whitespaceRunArb,
  type Script,
} from '../../test/quickAddGenerators';
import { BILL_MATCH_MIN_LABEL_LENGTH, classifyEntryWarning, type EntryWarning } from './warning';
/*
 * Feature: quick-add-daily-answer, Property 18: Entry warning classification is exact and monotone
 *
 * Validates: Requirements 17.23, 18.1, 18.2, 18.3, 18.8, 18.9, 18.10, 18.11
 *
 * Statement (design.md): for any parsed entry, Today, set of Active_Bill labels, and threshold (possibly absent), the
 * classifier warns exactly when the entry is dated Today and either its Note_Key has a Bill_Match or its amount is at
 * least the threshold; it does not warn for any other date; a missing threshold or label set removes only its own
 * cause; the result does not depend on letter case, Unicode normalization form, or whitespace runs in the note or
 * labels; raising the amount never removes a warning; and the entry is identical with and without the warning.
 *
 * The reference model below is written from the requirements and shares no code with `warning.ts`. It normalizes with
 * the independent `referenceNoteKey`, finds a whole word or phrase with a regular expression that has look-around
 * boundaries (the module scans with `indexOf`), and compares integers directly. Counterexamples print structure and
 * lengths only.
 */
const RUNS = 200;
/** Requirement text: containment applies to labels of at least 3 characters (equality applies to any length). */
const MIN_CONTAINMENT_CODE_POINTS = 3;

/* ------------------------------------------------------------- reference */

const WORD_CHARACTER = '[\\p{L}\\p{N}\\p{M}\\u200c\\u200d]';
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const codePoints = (text: string): number => [...text].length;

function referenceContainsAsWholeWord(noteKey: string, labelKey: string): boolean {
  return new RegExp(`(?<!${WORD_CHARACTER})${escapeRegExp(labelKey)}(?!${WORD_CHARACTER})`, 'u').test(noteKey);
}

/** The label of the first Active_Bill with a Bill_Match, or undefined. */
function referenceBill(note: string, labels: readonly string[] | null | undefined): string | undefined {
  if (labels === null || labels === undefined) return undefined;
  const noteKey = referenceNoteKey(note);
  if (noteKey === null) return undefined;
  for (const label of labels) {
    const labelKey = referenceNoteKey(label);
    if (labelKey === null) continue;
    if (labelKey === noteKey) return label;
    if (codePoints(labelKey) >= MIN_CONTAINMENT_CODE_POINTS && referenceContainsAsWholeWord(noteKey, labelKey)) return label;
  }
  return undefined;
}

function referenceLarge(amountMinor: number, threshold: number | null | undefined): boolean {
  return threshold !== null && threshold !== undefined && amountMinor >= threshold;
}

function referenceWarning(input: Scenario): EntryWarning {
  const { entry, today, billKeys, threshold } = input;
  if (entry.spentOn !== today) return { kind: 'none' };
  const bill = referenceBill(entry.note, billKeys);
  const large = referenceLarge(entry.amountMinor, threshold);
  if (bill === undefined && !large) return { kind: 'none' };
  return bill === undefined ? { kind: 'warn', large } : { kind: 'warn', bill, large };
}

/* ------------------------------------------------------------ generators */

interface EntryShape {
  amountMinor: number;
  spentOn: string;
  note: string;
}

interface Scenario {
  entry: EntryShape;
  today: string;
  billKeys: string[] | null | undefined;
  threshold: number | null | undefined;
}

const classify = (input: Scenario): EntryWarning =>
  classifyEntryWarning({
    entry: input.entry,
    today: input.today,
    billKeys: input.billKeys,
    largeEntryThresholdMinor: input.threshold,
  });

const SCRIPTS: readonly Script[] = Object.freeze(['latin', 'devanagari', 'telugu']);
const scriptArb = fc.constantFrom(...SCRIPTS);

/** Per code point, an upper-case twin that lower-cases to the same letter (others stay as they are). */
function upperCaseVariant(text: string): string {
  return [...text]
    .map((unit) => {
      const upper = unit.toLocaleUpperCase('en-IN');
      return codePoints(upper) === 1 && upper.toLocaleLowerCase('en-IN') === unit.toLocaleLowerCase('en-IN') ? upper : unit;
    })
    .join('');
}

interface Variant {
  upper: boolean;
  form: 'NFC' | 'NFD' | 'NFKC' | 'NFKD';
  run: string;
  lead: string;
  trail: string;
}

const variantArb: fc.Arbitrary<Variant> = fc.record({
  upper: fc.boolean(),
  form: fc.constantFrom('NFC', 'NFD', 'NFKC', 'NFKD'),
  run: whitespaceRunArb,
  lead: fc.option(whitespaceRunArb, { nil: '' }),
  trail: fc.option(whitespaceRunArb, { nil: '' }),
});

/** Same text with other letter case, normalization form, whitespace runs, and padding. */
function applyVariant(text: string, variant: Variant): string {
  const cased = variant.upper ? upperCaseVariant(text) : text;
  const spaced = cased.replace(/\s+/g, () => variant.run);
  return `${variant.lead}${spaced}${variant.trail}`.normalize(variant.form);
}

/** One to three words of one script, at most 24 code points, so a note built around it stays under 60. */
const phraseArb = (script: Script): fc.Arbitrary<string> =>
  fc
    .array(SCRIPT_WORD_ARBS[script], { minLength: 1, maxLength: 3 })
    .map((words) => words.join(' '))
    .filter((text) => codePoints(text) <= 24);

const SHORT_LABELS: readonly string[] = Object.freeze(['a', 'tv', 'ok', '\u090f', '\u092a\u0940', '\u0c24\u0c46', '\u0c15']);

/** A label whose Note_Key is 1 to 2 code points (equality only), at least 3 (containment too), or from any script. */
const labelCoreArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 5, arbitrary: scriptArb.chain(phraseArb) },
  { weight: 2, arbitrary: fc.constantFrom(...SHORT_LABELS) },
  { weight: 1, arbitrary: scriptArb.chain((script) => SCRIPT_WORD_ARBS[script].map((word) => [...word].slice(0, 3).join(''))) },
);

/** Labels with no usable Note_Key: blank, or longer than 60 code points. */
const keylessLabelArb: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom('', ' ', '\t\u00a0\u3000'),
  fc.integer({ min: 61, max: 80 }).map((length) => 'x'.repeat(length)),
);

interface Shown {
  base: string;
  shown: string;
}

const shownArb = (base: fc.Arbitrary<string>): fc.Arbitrary<Shown> =>
  fc.tuple(base, variantArb).map(([text, variant]) => ({ base: text, shown: applyVariant(text, variant) }));

type Relation = 'equal' | 'phrase' | 'embedded' | 'long' | 'unrelated' | 'empty';

const SEPARATORS: readonly string[] = Object.freeze([' ', ', ', ' - ', '/', ' (', ') ', ': ', '. ']);
const FILLER = 'abcdefghij '.repeat(6).trim();
/** Words around a label, at most 14 code points on each side. */
const unrelatedWordsArb: fc.Arbitrary<string> = scriptArb.chain(phraseArb).filter((text) => codePoints(text) <= 14);

/** A note that stands in a given relation to the label `core`. */
function relatedNoteArb(core: string): fc.Arbitrary<{ relation: Relation; note: string }> {
  const tag = (relation: Relation) => (note: string) => ({ relation, note });
  return fc.oneof(
    fc.constant(core).map(tag('equal')),
    fc
      .tuple(fc.option(unrelatedWordsArb, { nil: '' }), fc.constantFrom(...SEPARATORS), fc.constantFrom(...SEPARATORS), fc.option(unrelatedWordsArb, { nil: '' }))
      // A phrase has words on at least one side, so it is never equal to the label.
      .filter(([head, , , tail]) => head !== '' || tail !== '')
      .map(([head, before, after, tail]) => `${head === '' ? '' : `${head}${before}`}${core}${tail === '' ? '' : `${after}${tail}`}`)
      .map(tag('phrase')),
    fc
      .oneof(
        fc.constantFrom('x', 'z', '1', '\u0301', '\u200d', '\u0915', '\u0c15').map((tail) => `${core}${tail}`),
        fc.constantFrom('x', 'z', '9', '\u0915', '\u0c15').map((head) => `${head}${core}`),
        fc.constantFrom('x', '7').map((glue) => `pre${glue}${core}${glue}post`),
      )
      .map(tag('embedded')),
    fc.constantFrom(`${FILLER} ${core} ${FILLER}`, `${core} ${FILLER}`, `${FILLER} ${core}`).map(tag('long')),
    unrelatedWordsArb.map(tag('unrelated')),
    fc.constantFrom('', ' ', '\t').map(tag('empty')),
  );
}

interface LabelSet {
  cores: string[];
  shown: string[];
}

const labelSetArb: fc.Arbitrary<LabelSet> = fc
  .array(shownArb(fc.oneof({ weight: 6, arbitrary: labelCoreArb }, { weight: 1, arbitrary: keylessLabelArb })), { minLength: 0, maxLength: 5 })
  .map((labels) => ({ cores: labels.map((label) => label.base), shown: labels.map((label) => label.shown) }));

interface Case {
  today: string;
  entryDate: string;
  labels: LabelSet;
  note: Shown;
  amountMinor: number;
  threshold: number | null | undefined;
  billKeys: 'present' | 'null' | 'undefined';
}

const thresholdArb = (amountMinor: number): fc.Arbitrary<number | null | undefined> =>
  fc.oneof(
    { weight: 1, arbitrary: fc.constant(null) },
    { weight: 1, arbitrary: fc.constant(undefined) },
    { weight: 3, arbitrary: paiseArb },
    { weight: 3, arbitrary: fc.constantFrom(amountMinor, amountMinor + 1, Math.max(1, amountMinor - 1)) },
    { weight: 1, arbitrary: fc.constantFrom(100000, 1, MAX_AMOUNT_MINOR) },
  );

/** The date the entry carries: Today (most often), the days around Today, or any other real date. */
function entryDateArb(today: string): fc.Arbitrary<string> {
  const shifted = (days: number): string => {
    const [year, month, day] = today.split('-').map(Number) as [number, number, number];
    return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
  };
  return fc.oneof(
    { weight: 5, arbitrary: fc.constant(today) },
    { weight: 2, arbitrary: fc.constantFrom(shifted(-1), shifted(1)) },
    { weight: 1, arbitrary: anyRealDateArb },
  );
}

const caseArb: fc.Arbitrary<Case> = fc
  .tuple(anyRealDateArb, labelSetArb, paiseArb)
  .chain(([today, labels, amountMinor]) => {
    const noteBase: fc.Arbitrary<string> =
      labels.cores.length === 0
        ? unrelatedWordsArb
        : fc.integer({ min: 0, max: labels.cores.length - 1 }).chain((index) =>
            relatedNoteArb(labels.cores[index] as string).map(({ note }) => note),
          );
    return fc.record({
      today: fc.constant(today),
      entryDate: entryDateArb(today),
      labels: fc.constant(labels),
      note: shownArb(noteBase),
      amountMinor: fc.constant(amountMinor),
      threshold: thresholdArb(amountMinor),
      billKeys: fc.constantFrom<'present' | 'null' | 'undefined'>('present', 'present', 'present', 'null', 'undefined'),
    });
  });

function scenarioOf(input: Case, which: 'shown' | 'base' = 'shown'): Scenario {
  const labels = which === 'shown' ? input.labels.shown : input.labels.cores;
  return {
    entry: { amountMinor: input.amountMinor, spentOn: input.entryDate, note: which === 'shown' ? input.note.shown : input.note.base },
    today: input.today,
    billKeys: input.billKeys === 'present' ? [...labels] : input.billKeys === 'null' ? null : undefined,
    threshold: input.threshold,
  };
}

const withoutBill = (result: EntryWarning): boolean => result.kind === 'warn' && result.bill !== undefined;

/* ------------------------------------------------------------- properties */

describe('Property 18: Entry warning classification is exact and monotone', () => {
  it('exposes the minimum label length the requirements name', () => {
    expect(BILL_MATCH_MIN_LABEL_LENGTH).toBe(MIN_CONTAINMENT_CODE_POINTS);
  });

  it('matches the reference model exactly', () => {
    assertProperty(
      fc.property(caseArb, (input) => {
        const scenario = scenarioOf(input);
        expect(classify(scenario)).toStrictEqual(referenceWarning(scenario));
      }),
      { numRuns: RUNS },
    );
  });

  it('gives none for every date other than Today, and for an unavailable Today', () => {
    assertProperty(
      fc.property(caseArb, (input) => {
        const scenario = scenarioOf(input);
        if (scenario.entry.spentOn !== scenario.today) {
          expect(classify(scenario)).toStrictEqual({ kind: 'none' });
        }
        for (const today of [null, undefined, ''] as const) {
          expect(
            classifyEntryWarning({
              entry: scenario.entry,
              today,
              billKeys: scenario.billKeys,
              largeEntryThresholdMinor: scenario.threshold,
            }),
          ).toStrictEqual({ kind: 'none' });
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('warns for a note on Today exactly when its label relation or the amount says so', () => {
    assertProperty(
      fc.property(
        labelCoreArb.chain((core) => relatedNoteArb(core).map((related) => ({ core, ...related }))),
        variantArb,
        variantArb,
        anyRealDateArb,
        paiseArb,
        (related, labelVariant, noteVariant, today, amountMinor) => {
          const label = applyVariant(related.core, labelVariant);
          const note = applyVariant(related.note, noteVariant);
          const result = classifyEntryWarning({
            entry: { amountMinor, spentOn: today, note },
            today,
            billKeys: [label],
            largeEntryThresholdMinor: null,
          });
          const labelLength = codePoints(referenceNoteKey(label) as string);
          if (related.relation === 'equal') {
            expect(result).toStrictEqual({ kind: 'warn', bill: label, large: false });
          } else if (related.relation === 'phrase') {
            expect(result).toStrictEqual(
              labelLength >= MIN_CONTAINMENT_CODE_POINTS ? { kind: 'warn', bill: label, large: false } : { kind: 'none' },
            );
          } else if (related.relation === 'embedded' || related.relation === 'long' || related.relation === 'empty') {
            expect(result).toStrictEqual({ kind: 'none' });
          }
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('does not depend on letter case, normalization form, or whitespace runs in the note or the labels', () => {
    assertProperty(
      fc.property(caseArb, (input) => {
        const base = classify(scenarioOf(input, 'base'));
        const shown = classify(scenarioOf(input, 'shown'));
        expect(shown.kind).toBe(base.kind);
        if (base.kind === 'warn' && shown.kind === 'warn') {
          expect(shown.large).toBe(base.large);
          // The label returned is the one the caller supplied, at the same position in the list.
          expect(shown.bill === undefined).toBe(base.bill === undefined);
          if (base.bill !== undefined) {
            const position = input.labels.cores.indexOf(base.bill);
            expect(shown.bill).toBe(input.labels.shown[position]);
          }
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('names the first matching label in list order, as the label was supplied', () => {
    assertProperty(
      fc.property(
        fc.tuple(SCRIPT_WORD_ARBS.latin, SCRIPT_WORD_ARBS.latin).filter(([a, b]) => {
          const [keyA, keyB] = [referenceNoteKey(a), referenceNoteKey(b)];
          return keyA !== null && keyB !== null && keyA !== keyB && codePoints(keyA) >= 3 && codePoints(keyB) >= 3;
        }),
        variantArb,
        variantArb,
        fc.constantFrom(' ', ', ', ' / '),
        anyRealDateArb,
        ([first, second], firstVariant, secondVariant, separator, today) => {
          const labels = [applyVariant(first, firstVariant), applyVariant(second, secondVariant)];
          const entry = { amountMinor: 1, spentOn: today, note: `${first}${separator}${second}` };
          const forward = classifyEntryWarning({ entry, today, billKeys: labels, largeEntryThresholdMinor: null });
          const backward = classifyEntryWarning({ entry, today, billKeys: [labels[1] as string, labels[0] as string], largeEntryThresholdMinor: null });
          expect(forward).toStrictEqual({ kind: 'warn', bill: labels[0], large: false });
          expect(backward).toStrictEqual({ kind: 'warn', bill: labels[1], large: false });
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('keeps a bill cause working when other labels have no Note_Key', () => {
    assertProperty(
      fc.property(
        fc.array(keylessLabelArb, { minLength: 0, maxLength: 3 }),
        labelCoreArb,
        fc.array(keylessLabelArb, { minLength: 0, maxLength: 3 }),
        anyRealDateArb,
        (before, core, after, today) => {
          const entry = { amountMinor: 1, spentOn: today, note: core };
          const result = classifyEntryWarning({ entry, today, billKeys: [...before, core, ...after], largeEntryThresholdMinor: null });
          expect(result).toStrictEqual({ kind: 'warn', bill: core, large: false });
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('never matches a note or a label that has no Note_Key', () => {
    assertProperty(
      fc.property(keylessLabelArb, labelCoreArb, anyRealDateArb, paiseArb, (keyless, core, today, amountMinor) => {
        // A note over 60 code points never matches, even when it equals the label or holds it as a phrase.
        const longNote = `${core} ${FILLER}`;
        for (const note of [longNote, keyless, '']) {
          const result = classifyEntryWarning({
            entry: { amountMinor, spentOn: today, note },
            today,
            billKeys: [core, keyless, longNote],
            largeEntryThresholdMinor: null,
          });
          expect(withoutBill(result), `note length ${codePoints(note)}`).toBe(false);
        }
        // A label over 60 code points never matches the note it equals.
        const overlong = 'q'.repeat(61);
        expect(
          classifyEntryWarning({
            entry: { amountMinor, spentOn: today, note: overlong },
            today,
            billKeys: [overlong],
            largeEntryThresholdMinor: null,
          }),
        ).toStrictEqual({ kind: 'none' });
      }),
      { numRuns: RUNS },
    );
  });

  it('is large exactly when the amount is at least the threshold, and a missing threshold removes only that cause', () => {
    assertProperty(
      fc.property(
        paiseArb,
        fc.constantFrom(-1, 0, 1),
        fc.oneof(fc.constant(null), fc.constant(undefined), fc.constant('threshold' as const)),
        caseArb,
        (amountMinor, offset, mode, input) => {
          const threshold = mode === 'threshold' ? amountMinor + offset : mode;
          const scenario = { ...scenarioOf(input), threshold, entry: { ...scenarioOf(input).entry, amountMinor } };
          const result = classify(scenario);
          const onToday = scenario.entry.spentOn === scenario.today;
          const largeExpected = onToday && mode === 'threshold' && offset <= 0;
          const largeActual = result.kind === 'warn' && result.large;
          expect(largeActual).toBe(largeExpected);
          // The bill cause is the one the label set alone gives, with the threshold present or not.
          const billOnly = classify({ ...scenario, threshold: null });
          expect(result.kind === 'warn' ? result.bill : undefined).toBe(billOnly.kind === 'warn' ? billOnly.bill : undefined);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('combines the two causes without one changing the other', () => {
    assertProperty(
      fc.property(caseArb, (input) => {
        const scenario = scenarioOf(input);
        const full = classify(scenario);
        const billOnly = classify({ ...scenario, threshold: null });
        const largeOnly = classify({ ...scenario, billKeys: null });
        const neither = classify({ ...scenario, billKeys: undefined, threshold: undefined });
        expect(neither).toStrictEqual({ kind: 'none' });
        const bill = billOnly.kind === 'warn' ? billOnly.bill : undefined;
        const large = largeOnly.kind === 'warn' && largeOnly.large;
        const expected: EntryWarning =
          bill === undefined && !large ? { kind: 'none' } : bill === undefined ? { kind: 'warn', large } : { kind: 'warn', bill, large };
        expect(full).toStrictEqual(expected);
      }),
      { numRuns: RUNS },
    );
  });

  it('keeps a warning when the amount grows, and never clears the large cause', () => {
    assertProperty(
      fc.property(
        caseArb,
        paiseArb,
        fc.integer({ min: 0, max: MAX_AMOUNT_MINOR }),
        fc.constantFrom('random', 'at-threshold', 'below-threshold'),
        (input, smaller, growth, start) => {
          const scenario = scenarioOf(input);
          const threshold = scenario.threshold;
          const first =
            start === 'random' || typeof threshold !== 'number'
              ? smaller
              : Math.max(1, start === 'at-threshold' ? threshold : threshold - 1);
          const second = Math.min(Number.MAX_SAFE_INTEGER, first + growth);
          const low = classify({ ...scenario, entry: { ...scenario.entry, amountMinor: first } });
          const high = classify({ ...scenario, entry: { ...scenario.entry, amountMinor: second } });
          if (low.kind === 'warn') {
            expect(high.kind).toBe('warn');
            if (high.kind === 'warn') {
              expect(high.large || !low.large).toBe(true);
              expect(high.bill).toBe(low.bill);
            }
          }
          if (low.kind === 'warn' && low.large && high.kind === 'warn') expect(high.large).toBe(true);
          if (high.kind === 'none') expect(low.kind).toBe('none');
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('leaves the entry and the inputs exactly as they were', () => {
    assertProperty(
      fc.property(caseArb, (input) => {
        const scenario = scenarioOf(input);
        const before = structuredClone(scenario);
        const frozenEntry = Object.freeze({ ...scenario.entry });
        const frozenLabels = scenario.billKeys ? Object.freeze([...scenario.billKeys]) : scenario.billKeys;
        const first = classifyEntryWarning({
          entry: frozenEntry,
          today: scenario.today,
          billKeys: frozenLabels,
          largeEntryThresholdMinor: scenario.threshold,
        });
        const second = classifyEntryWarning({
          entry: frozenEntry,
          today: scenario.today,
          billKeys: frozenLabels,
          largeEntryThresholdMinor: scenario.threshold,
        });
        expect(second).toStrictEqual(first);
        expect(frozenEntry).toStrictEqual(before.entry);
        expect(frozenLabels ?? null).toStrictEqual(before.billKeys ?? null);
        // The result carries reasons only: no amount, note, date, or category.
        expect(Object.keys(first).every((key) => key === 'kind' || key === 'bill' || key === 'large')).toBe(true);
      }),
      { numRuns: RUNS },
    );
  });

  for (const script of SCRIPTS) {
    it(`matches ${script} labels as whole words and phrases and not inside longer words`, () => {
      assertProperty(
        fc.property(
          phraseArb(script).filter((label) => codePoints(referenceNoteKey(label) ?? '') >= MIN_CONTAINMENT_CODE_POINTS),
          unrelatedWordsArb,
          fc.constantFrom(' ', ', ', ' - ', '/'),
          variantArb,
          anyRealDateArb,
          (label, other, separator, variant, today) => {
            const run = (note: string) =>
              classifyEntryWarning({
                entry: { amountMinor: 100, spentOn: today, note: applyVariant(note, variant) },
                today,
                billKeys: [label],
                largeEntryThresholdMinor: null,
              });
            const whole = run(`${other}${separator}${label}${separator}${other}`);
            expect(whole.kind, 'whole phrase').toBe('warn');
            if (whole.kind === 'warn') expect(whole.bill).toBe(label);
            expect(run(`${label}x`).kind, 'letter after').toBe('none');
            expect(run(`x${label}`).kind, 'letter before').toBe('none');
            expect(run(`${label}\u0301`).kind, 'combining mark after').toBe('none');
            expect(run(`${label}7`).kind, 'digit after').toBe('none');
          },
        ),
        { numRuns: RUNS },
      );
    });
  }
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fc } from '../../test/test-utils';
import { assertProperty } from '../../test/propertyReport';
import {
  SCRIPT_WORD_ARBS,
  noteKeyBoundaryArb,
  noteKeyInputArb,
  referenceNoteKey,
  whitespaceRunArb,
} from '../../test/quickAddGenerators';
import { NOTE_KEY_MAX_CODE_POINTS, normalizeNoteKey as browserNoteKey } from './noteKey';
/*
 * Feature: quick-add-daily-answer, Property 9: Note_Key normalization is idempotent and agrees on both sides
 *
 * Validates: Requirements 6.19, 15.5, 17.25
 *
 * Statement (design.md): for any string, the browser and server implementations of `normalizeNoteKey` return the same
 * key (or both none); applying it to its own result returns that result; the result does not depend on letter case,
 * Unicode normalization form, or whitespace runs of the input; a key has between 1 and 60 code points, with longer or
 * empty input giving none; and the shared fixture file passes on both sides.
 *
 * The two services share no source, so this test loads the server module from `backend/src/domain/noteKey.js` as text
 * and runs it next to the browser module. The independent `referenceNoteKey` from the test helpers is the third
 * opinion. Counterexamples print structure and length only.
 */
const RUNS = 300;
type NormalizeNoteKey = (text: unknown) => string | null;
// Vitest runs with the frontend package as its working directory; the server module and the fixture live in backend.
const backendRoot = resolve(process.cwd(), '..', 'backend');
function loadServerNoteKey(): NormalizeNoteKey {
  const source = readFileSync(resolve(backendRoot, 'src', 'domain', 'noteKey.js'), 'utf8').replace(/^export /gm, '');
  return new Function(`${source}\nreturn normalizeNoteKey;`)() as NormalizeNoteKey;
}
const serverNoteKey = loadServerNoteKey();
const IMPLEMENTATIONS: ReadonlyArray<readonly [string, NormalizeNoteKey]> = Object.freeze([
  ['browser', browserNoteKey as NormalizeNoteKey],
  ['server', serverNoteKey],
]);
interface NoteKeyFixture {
  cases: Array<{ name: string; input: string; expected: string | null }>;
}
const fixture = JSON.parse(readFileSync(resolve(backendRoot, 'test', 'fixtures', 'noteKey.json'), 'utf8')) as NoteKeyFixture;
const codePoints = (text: string): number => [...text].length;
/** Per code point, an upper-case twin that lower-cases to the same letter. Greek sigma is skipped (context rules). */
function upperCaseVariant(text: string): string {
  return [...text]
    .map((unit) => {
      if (/[\u0391-\u03a9\u03c2\u03c3]/u.test(unit)) return unit;
      const upper = unit.toLocaleUpperCase('en-IN');
      return codePoints(upper) === 1 && upper.toLocaleLowerCase('en-IN') === unit.toLocaleLowerCase('en-IN') ? upper : unit;
    })
    .join('');
}
/** Replaces every whitespace run by another non-empty run taken in turn from `runs`, and pads both ends. */
function respaced(text: string, runs: readonly string[], lead: string, trail: string): string {
  let index = 0;
  return `${lead}${text.replace(/\s+/g, () => runs[index++ % runs.length] as string)}${trail}`;
}
/**
 * Generated strings plus capital letters whose lower-case form is not in NFKC. The first counterexample the property
 * found was a Greek capital upsilon with psili and oxia, which lowers to a decomposed letter that a second pass
 * composes, so the key was not idempotent until the normalizer applied NFKC after lower-casing.
 */
const inputArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 6, arbitrary: noteKeyInputArb },
  { weight: 1, arbitrary: fc.constantFrom('\u03a5\u0313\u0301', '\u03a5\u0313\u0301 Cafe\u0301', '\u0399\u0308\u0301', '\u1f5d') },
);
const NORMALIZATION_FORMS = ['NFC', 'NFD', 'NFKC', 'NFKD'] as const;
const EMOJI: readonly string[] = Object.freeze([
  '\u{1F600}', '\u{1F44D}\u{1F3FD}', '\u{1F468}\u200d\u{1F469}\u200d\u{1F467}', '\u{1F1EE}\u{1F1F3}', '\u2764\ufe0f',
  '\u2615', '\u{1F35B}', '\u{1F64F}', '1\ufe0f\u20e3',
]);
const emojiWordArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...EMOJI), { minLength: 1, maxLength: 5 })
  .map((parts) => parts.join(''));
const SCRIPT_ARBS: Readonly<Record<'latin' | 'devanagari' | 'telugu' | 'emoji', fc.Arbitrary<string>>> = Object.freeze({
  ...SCRIPT_WORD_ARBS,
  emoji: emojiWordArb,
});
const scriptTextArb = (script: keyof typeof SCRIPT_ARBS): fc.Arbitrary<string> =>
  fc.array(SCRIPT_ARBS[script], { minLength: 1, maxLength: 5 }).map((words) => words.join(' '));
const joinerTextArb = fc
  .tuple(
    fc.array(fc.constantFrom('a', 'b', '\u0915', '\u0c15', '\u{1F600}'), { minLength: 2, maxLength: 6 }),
    fc.constantFrom('\u200d', '\u200c'),
  )
  .map(([letters, joiner]) => ({ letters, joiner, text: letters.join(joiner) }));

describe('Property 9: Note_Key normalization is idempotent and agrees on both sides', () => {
  it('agrees across both implementations and the independent reference', () => {
    assertProperty(
      fc.property(inputArb, (text) => {
        const expected = referenceNoteKey(text);
        for (const [name, normalize] of IMPLEMENTATIONS) expect(normalize(text), name).toBe(expected);
      }),
      { numRuns: RUNS },
    );
  });

  it('returns the same key when a key is normalized again', () => {
    assertProperty(
      fc.property(inputArb, (text) => {
        for (const [name, normalize] of IMPLEMENTATIONS) {
          const key = normalize(text);
          if (key !== null) expect(normalize(key), name).toBe(key);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('does not depend on letter case', () => {
    assertProperty(
      fc.property(inputArb, (text) => {
        const upper = upperCaseVariant(text);
        const lower = text.toLocaleLowerCase('en-IN');
        for (const [name, normalize] of IMPLEMENTATIONS) {
          const key = normalize(text);
          expect(normalize(upper), `${name} upper-case`).toBe(key);
          expect(normalize(lower), `${name} lower-case`).toBe(key);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('does not depend on the Unicode normalization form of the input', () => {
    assertProperty(
      fc.property(inputArb, fc.constantFrom(...NORMALIZATION_FORMS), (text, form) => {
        const rewritten = text.normalize(form);
        for (const [name, normalize] of IMPLEMENTATIONS) expect(normalize(rewritten), name).toBe(normalize(text));
      }),
      { numRuns: RUNS },
    );
  });

  it('does not depend on the whitespace runs of the input', () => {
    assertProperty(
      fc.property(
        inputArb,
        fc.array(whitespaceRunArb, { minLength: 1, maxLength: 8 }),
        fc.option(whitespaceRunArb, { nil: '' }),
        fc.option(whitespaceRunArb, { nil: '' }),
        (text, runs, lead, trail) => {
          const rewritten = respaced(text, runs, lead, trail);
          for (const [name, normalize] of IMPLEMENTATIONS) expect(normalize(rewritten), name).toBe(normalize(text));
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('gives a trimmed key of 1 to 60 code points with single spaces, and none for empty or longer input', () => {
    assertProperty(
      fc.property(inputArb, (text) => {
        for (const [name, normalize] of IMPLEMENTATIONS) {
          const key = normalize(text);
          if (key === null) continue;
          const length = codePoints(key);
          expect(length >= 1 && length <= NOTE_KEY_MAX_CODE_POINTS, `${name} length ${length}`).toBe(true);
          expect(key, `${name} trimmed`).toBe(key.trim());
          expect(/\s\s/.test(key) || /[^\S ]/.test(key), `${name} single spaces`).toBe(false);
        }
      }),
      { numRuns: RUNS },
    );
    assertProperty(
      fc.property(noteKeyBoundaryArb, ({ codePoints: length, text }) => {
        for (const [name, normalize] of IMPLEMENTATIONS) {
          expect(normalize(text), `${name} at ${length}`).toBe(length <= NOTE_KEY_MAX_CODE_POINTS ? text : null);
        }
      }),
      { numRuns: RUNS },
    );
    assertProperty(
      fc.property(
        fc.constantFrom('', ' ', ' \t\u00a0\u2003\u3000 '),
        fc.array(fc.constantFrom(' ', '\n', '\u00a0'), { maxLength: 70 }),
        (prefix, blanks) => {
          for (const [name, normalize] of IMPLEMENTATIONS) expect(normalize(`${prefix}${blanks.join('')}`), name).toBeNull();
        },
      ),
      { numRuns: RUNS },
    );
  });

  for (const script of ['latin', 'devanagari', 'telugu', 'emoji'] as const) {
    it(`handles ${script} text the same on both sides, idempotently, and stably under form and spacing`, () => {
      assertProperty(
        fc.property(scriptTextArb(script), fc.constantFrom(...NORMALIZATION_FORMS), whitespaceRunArb, (text, form, run) => {
          const expected = referenceNoteKey(text);
          for (const [name, normalize] of IMPLEMENTATIONS) {
            const key = normalize(text);
            expect(key, name).toBe(expected);
            expect(normalize(text.normalize(form)), `${name} form`).toBe(key);
            expect(normalize(text.replace(/ /g, run)), `${name} spacing`).toBe(key);
            if (key !== null) expect(normalize(key), `${name} idempotence`).toBe(key);
          }
        }),
        { numRuns: RUNS },
      );
    });
  }

  it('keeps emoji text exactly when it fits in 60 code points', () => {
    assertProperty(
      fc.property(scriptTextArb('emoji'), (text) => {
        for (const [name, normalize] of IMPLEMENTATIONS) {
          expect(normalize(text), name).toBe(codePoints(text) <= NOTE_KEY_MAX_CODE_POINTS ? text : null);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('keeps zero-width joiner and non-joiner', () => {
    assertProperty(
      fc.property(joinerTextArb, ({ letters, joiner, text }) => {
        for (const [name, normalize] of IMPLEMENTATIONS) {
          const key = normalize(text);
          expect(key, name).toBe(text);
          expect((key as string).split(joiner).length - 1, `${name} joiner count`).toBe(letters.length - 1);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('gives no key for input that is not a string', () => {
    assertProperty(
      fc.property(fc.anything().filter((value) => typeof value !== 'string'), (value) => {
        for (const [name, normalize] of IMPLEMENTATIONS) expect(normalize(value), name).toBeNull();
      }),
      { numRuns: RUNS },
    );
  });

  it('passes the shared fixture on both sides', () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(40);
    for (const [name, normalize] of IMPLEMENTATIONS) {
      for (const { name: caseName, input, expected } of fixture.cases) {
        expect(normalize(input), `${name}: ${caseName}`).toBe(expected);
      }
    }
  });
});

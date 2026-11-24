import '../helpers/blockingStdout.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { NOTE_KEY_MAX_CODE_POINTS, normalizeNoteKey as serverNoteKey } from '../../src/domain/noteKey.js';
import { assertProperty } from '../helpers/propertyReport.js';
import {
  SCRIPT_WORD_ARBS,
  noteKeyBoundaryArb,
  noteKeyInputArb,
  referenceNoteKey,
  whitespaceRunArb,
} from '../helpers/quickAddGenerators.js';
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
 * The browser copy is TypeScript and the two services share no source, so this test loads the browser source text
 * (types stripped with node:module) and runs it next to the server module. The independent `referenceNoteKey` from
 * the test helpers is the third opinion. Counterexamples print structure and length only.
 */
const RUNS = 300;
const here = dirname(fileURLToPath(import.meta.url));
const backendRoot = resolve(here, '..', '..');
const clientSourcePath = resolve(backendRoot, '..', 'frontend', 'src', 'clarity', 'quickAdd', 'noteKey.ts');
/** Loads `normalizeNoteKey` from the browser TypeScript source without a TypeScript toolchain. */
function loadClientNoteKey() {
  const require = createRequire(import.meta.url);
  const { stripTypeScriptTypes } = require('node:module');
  const javascript = stripTypeScriptTypes(readFileSync(clientSourcePath, 'utf8')).replace(/^export /gm, '');
  return new Function(`${javascript}\nreturn normalizeNoteKey;`)();
}
const clientNoteKey = loadClientNoteKey();
const IMPLEMENTATIONS = Object.freeze([
  ['server', serverNoteKey],
  ['browser', clientNoteKey],
]);
const fixture = JSON.parse(readFileSync(resolve(backendRoot, 'test', 'fixtures', 'noteKey.json'), 'utf8'));
const codePoints = (text) => [...text].length;
/** Per code point, an upper-case twin that lower-cases to the same letter. Greek sigma is skipped (context rules). */
function upperCaseVariant(text) {
  return [...text]
    .map((unit) => {
      if (/[\u0391-\u03a9\u03c2\u03c3]/u.test(unit)) return unit;
      const upper = unit.toLocaleUpperCase('en-IN');
      return codePoints(upper) === 1 && upper.toLocaleLowerCase('en-IN') === unit.toLocaleLowerCase('en-IN') ? upper : unit;
    })
    .join('');
}
/** Replaces every whitespace run by another non-empty run taken in turn from `runs`, and pads both ends. */
function respaced(text, runs, lead, trail) {
  let index = 0;
  return `${lead}${text.replace(/\s+/g, () => runs[index++ % runs.length])}${trail}`;
}
const EMOJI = Object.freeze([
  '\u{1F600}', '\u{1F44D}\u{1F3FD}', '\u{1F468}\u200d\u{1F469}\u200d\u{1F467}', '\u{1F1EE}\u{1F1F3}', '\u2764\ufe0f',
  '\u2615', '\u{1F35B}', '\u{1F64F}', '1\ufe0f\u20e3',
]);
const emojiWordArb = fc.array(fc.constantFrom(...EMOJI), { minLength: 1, maxLength: 5 }).map((parts) => parts.join(''));
const SCRIPT_ARBS = Object.freeze({ ...SCRIPT_WORD_ARBS, emoji: emojiWordArb });
const scriptTextArb = (script) =>
  fc.array(SCRIPT_ARBS[script], { minLength: 1, maxLength: 5 }).map((words) => words.join(' '));
const joinerTextArb = fc
  .tuple(fc.array(fc.constantFrom('a', 'b', '\u0915', '\u0c15', '\u{1F600}'), { minLength: 2, maxLength: 6 }), fc.constantFrom('\u200d', '\u200c'))
  .map(([letters, joiner]) => ({ letters, joiner, text: letters.join(joiner) }));

/**
 * Generated strings plus capital letters whose lower-case form is not in NFKC. The first counterexample the property
 * found was a Greek capital upsilon with psili and oxia, which lowers to a decomposed letter that a second pass
 * composes, so the key was not idempotent until the normalizer applied NFKC after lower-casing.
 */
const inputArb = fc.oneof(
  { weight: 6, arbitrary: noteKeyInputArb },
  { weight: 1, arbitrary: fc.constantFrom('\u03a5\u0313\u0301', '\u03a5\u0313\u0301 Cafe\u0301', '\u0399\u0308\u0301', '\u1f5d') },
);

test('Property 9: both implementations agree with each other and with the independent reference', () => {
  assertProperty(
    fc.property(inputArb, (text) => {
      const expected = referenceNoteKey(text);
      assert.equal(serverNoteKey(text), expected, 'server');
      assert.equal(clientNoteKey(text), expected, 'browser');
    }),
    { numRuns: RUNS },
  );
});

test('Property 9: normalizing a key again returns the same key', () => {
  assertProperty(
    fc.property(inputArb, (text) => {
      for (const [name, normalize] of IMPLEMENTATIONS) {
        const key = normalize(text);
        if (key !== null) assert.equal(normalize(key), key, name);
      }
    }),
    { numRuns: RUNS },
  );
});

test('Property 9: the key does not depend on letter case', () => {
  assertProperty(
    fc.property(inputArb, (text) => {
      const upper = upperCaseVariant(text);
      const lower = text.toLocaleLowerCase('en-IN');
      for (const [name, normalize] of IMPLEMENTATIONS) {
        const key = normalize(text);
        assert.equal(normalize(upper), key, `${name} upper-case`);
        assert.equal(normalize(lower), key, `${name} lower-case`);
      }
    }),
    { numRuns: RUNS },
  );
});

test('Property 9: the key does not depend on the Unicode normalization form of the input', () => {
  assertProperty(
    fc.property(inputArb, fc.constantFrom('NFC', 'NFD', 'NFKC', 'NFKD'), (text, form) => {
      const rewritten = text.normalize(form);
      for (const [name, normalize] of IMPLEMENTATIONS) {
        assert.equal(normalize(rewritten), normalize(text), name);
      }
    }),
    { numRuns: RUNS },
  );
});

test('Property 9: the key does not depend on the whitespace runs of the input', () => {
  assertProperty(
    fc.property(
      inputArb,
      fc.array(whitespaceRunArb, { minLength: 1, maxLength: 8 }),
      fc.option(whitespaceRunArb, { nil: '' }),
      fc.option(whitespaceRunArb, { nil: '' }),
      (text, runs, lead, trail) => {
        const rewritten = respaced(text, runs, lead, trail);
        for (const [name, normalize] of IMPLEMENTATIONS) {
          assert.equal(normalize(rewritten), normalize(text), name);
        }
      },
    ),
    { numRuns: RUNS },
  );
});

test('Property 9: a key has 1 to 60 code points, is trimmed, and holds single spaces only', () => {
  assertProperty(
    fc.property(inputArb, (text) => {
      for (const [name, normalize] of IMPLEMENTATIONS) {
        const key = normalize(text);
        if (key === null) continue;
        const length = codePoints(key);
        assert.ok(length >= 1 && length <= NOTE_KEY_MAX_CODE_POINTS, `${name} length ${length}`);
        assert.equal(key, key.trim(), `${name} trimmed`);
        assert.ok(!/\s\s/.test(key) && !/[^\S ]/.test(key), `${name} single spaces`);
      }
    }),
    { numRuns: RUNS },
  );
  assertProperty(
    fc.property(noteKeyBoundaryArb, ({ codePoints: length, text }) => {
      for (const [name, normalize] of IMPLEMENTATIONS) {
        assert.equal(normalize(text), length <= NOTE_KEY_MAX_CODE_POINTS ? text : null, `${name} at ${length}`);
      }
    }),
    { numRuns: RUNS },
  );
  assertProperty(
    fc.property(fc.constantFrom('', ' ', ' \t\u00a0\u2003\u3000 '), fc.array(fc.constantFrom(' ', '\n', '\u00a0'), { maxLength: 70 }), (prefix, blanks) => {
      for (const [name, normalize] of IMPLEMENTATIONS) {
        assert.equal(normalize(`${prefix}${blanks.join('')}`), null, name);
      }
    }),
    { numRuns: RUNS },
  );
});

for (const script of ['latin', 'devanagari', 'telugu', 'emoji']) {
  test(`Property 9: ${script} text agrees on both sides, is idempotent, and is stable under form and spacing`, () => {
    assertProperty(
      fc.property(scriptTextArb(script), fc.constantFrom('NFC', 'NFD', 'NFKC', 'NFKD'), whitespaceRunArb, (text, form, run) => {
        const expected = referenceNoteKey(text);
        for (const [name, normalize] of IMPLEMENTATIONS) {
          const key = normalize(text);
          assert.equal(key, expected, name);
          assert.equal(normalize(text.normalize(form)), key, `${name} form`);
          assert.equal(normalize(text.replace(/ /g, run)), key, `${name} spacing`);
          if (key !== null) assert.equal(normalize(key), key, `${name} idempotence`);
        }
      }),
      { numRuns: RUNS },
    );
  });
}

test('Property 9: emoji text is kept exactly when it fits in 60 code points', () => {
  assertProperty(
    fc.property(scriptTextArb('emoji'), (text) => {
      for (const [name, normalize] of IMPLEMENTATIONS) {
        assert.equal(normalize(text), codePoints(text) <= NOTE_KEY_MAX_CODE_POINTS ? text : null, name);
      }
    }),
    { numRuns: RUNS },
  );
});

test('Property 9: zero-width joiner and non-joiner are kept', () => {
  assertProperty(
    fc.property(joinerTextArb, ({ letters, joiner, text }) => {
      for (const [name, normalize] of IMPLEMENTATIONS) {
        const key = normalize(text);
        assert.ok(key !== null, name);
        assert.equal(key.split(joiner).length - 1, letters.length - 1, `${name} joiner count`);
        assert.equal(key, text, name);
      }
    }),
    { numRuns: RUNS },
  );
});

test('Property 9: input that is not a string has no key', () => {
  assertProperty(
    fc.property(fc.anything().filter((value) => typeof value !== 'string'), (value) => {
      for (const [name, normalize] of IMPLEMENTATIONS) {
        assert.equal(normalize(value), null, name);
      }
    }),
    { numRuns: RUNS },
  );
});

test('Property 9: the shared fixture passes on both sides', () => {
  assert.ok(fixture.cases.length >= 40);
  for (const [name, normalize] of IMPLEMENTATIONS) {
    for (const { name: caseName, input, expected } of fixture.cases) {
      assert.equal(normalize(input), expected, `${name}: ${caseName}`);
    }
  }
});

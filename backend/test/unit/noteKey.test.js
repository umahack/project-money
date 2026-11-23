import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NOTE_KEY_MAX_CODE_POINTS, normalizeNoteKey } from '../../src/domain/noteKey.js';

const { cases } = JSON.parse(readFileSync(new URL('../fixtures/noteKey.json', import.meta.url), 'utf8'));

test('normalizeNoteKey returns the expected key for every shared fixture case', () => {
  assert.ok(cases.length >= 40);
  for (const { name, input, expected } of cases) {
    assert.equal(normalizeNoteKey(input), expected, name);
  }
});

test('normalizeNoteKey keeps the 60 code point limit and ignores non-strings', () => {
  assert.equal(NOTE_KEY_MAX_CODE_POINTS, 60);
  assert.equal(normalizeNoteKey(undefined), null);
  assert.equal(normalizeNoteKey(null), null);
  assert.equal(normalizeNoteKey(42), null);
});

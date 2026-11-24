import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NOTE_KEY_MAX_CODE_POINTS, normalizeNoteKey } from './noteKey';

interface NoteKeyFixture {
  cases: Array<{ name: string; input: string; expected: string | null }>;
}

// The fixture lives in the backend package. Vitest runs with the frontend package as its working directory.
const fixturePath = resolve(process.cwd(), '..', 'backend', 'test', 'fixtures', 'noteKey.json');
const { cases } = JSON.parse(readFileSync(fixturePath, 'utf8')) as NoteKeyFixture;

describe('normalizeNoteKey', () => {
  it('returns the expected key for every shared fixture case', () => {
    expect(cases.length).toBeGreaterThanOrEqual(40);
    for (const { name, input, expected } of cases) {
      expect(normalizeNoteKey(input), name).toBe(expected);
    }
  });

  it('keeps the 60 code point limit', () => {
    expect(NOTE_KEY_MAX_CODE_POINTS).toBe(60);
  });
});

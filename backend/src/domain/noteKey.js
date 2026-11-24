/**
 * Note_Key normalizer for Quick Add category memory.
 *
 * Pure module. The browser keeps an identical copy in `frontend/src/clarity/quickAdd/noteKey.ts`, because the two
 * services deploy separately and share no source. Both copies are checked against `test/fixtures/noteKey.json`.
 *
 * Requirements: 6.19, 15.5, 17.25.
 */

/** The longest Note_Key, counted in Unicode code points. */
export const NOTE_KEY_MAX_CODE_POINTS = 60;

/**
 * NFKC, whitespace runs to one space, `en-IN` lower-casing, NFKC again, trim. The second NFKC is needed because
 * lower-casing can leave text that is not in NFKC (a capital Greek upsilon with two marks lowers to a decomposed
 * letter), which would break idempotence. Returns null when the result is empty or has more than 60 code points, or
 * when the input is not a string. Zero-width joiner and non-joiner are kept.
 */
export function normalizeNoteKey(text) {
  if (typeof text !== 'string') return null;
  const key = text.normalize('NFKC').replace(/\s+/g, ' ').toLocaleLowerCase('en-IN').normalize('NFKC').trim();
  if (key === '' || [...key].length > NOTE_KEY_MAX_CODE_POINTS) return null;
  return key;
}

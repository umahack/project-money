/**
 * Entry warning classifier for Quick Add.
 *
 * Pure module. It decides only whether the preview shows an Entry_Warning and why. It compares integers and never
 * calculates money: the Large_Entry_Threshold arrives from the server (`outcomes.todayAllowance.value.largeEntryThreshold`),
 * and the Large_Entry percentage and floor live in `backend/src/domain/allowance.js`.
 *
 * Requirements: 17.23, 18.1, 18.2, 18.3, 18.8, 18.9, 18.10, 18.11, 18.26.
 */
import { normalizeNoteKey } from './noteKey';
import type { ParsedEntry } from './parser';

/**
 * The shortest Active_Bill label, in Unicode code points, that can match as a whole word or phrase inside a longer
 * note. A note that equals a label matches at any label length. This is the only place the literal appears.
 */
export const BILL_MATCH_MIN_LABEL_LENGTH = 3;

export type EntryWarning = { kind: 'none' } | { kind: 'warn'; bill?: string; large: boolean };

export interface ClassifyEntryWarningInput {
  entry: Pick<ParsedEntry, 'amountMinor' | 'spentOn' | 'note'>;
  /** The local date, `YYYY-MM-DD`. */
  today: string | null | undefined;
  /** Labels of the bills active in the Current_Month (`snapshot.facts` entries of type `bill`). Unavailable when absent. */
  billKeys: readonly string[] | null | undefined;
  /** The server-supplied Large_Entry_Threshold in minor units. Unavailable when null or undefined. */
  largeEntryThresholdMinor: number | null | undefined;
}

const NONE: EntryWarning = { kind: 'none' };

// A character that continues a word in any script: letters, digits, combining marks, and the zero-width joiner and
// non-joiner that Note_Key keeps inside Indic words.
const WORD_CHARACTER = /^[\p{L}\p{N}\p{M}\u200c\u200d]$/u;

function isWordCharacter(codePoint: string | undefined): boolean {
  return codePoint !== undefined && WORD_CHARACTER.test(codePoint);
}

/** True when `label` occurs in `key` with a non-word character, or an edge, on each side. */
function containsAsWholeWord(key: string, label: string): boolean {
  let from = 0;
  for (;;) {
    const at = key.indexOf(label, from);
    if (at === -1) return false;
    const end = at + label.length;
    const before = at === 0 ? undefined : [...key.slice(Math.max(0, at - 2), at)].pop();
    const after = end >= key.length ? undefined : String.fromCodePoint(key.codePointAt(end) as number);
    if (!isWordCharacter(before) && !isWordCharacter(after)) return true;
    from = at + 1;
  }
}

function matchBill(noteKey: string, labels: readonly string[]): string | undefined {
  for (const label of labels) {
    if (typeof label !== 'string') continue;
    const labelKey = normalizeNoteKey(label);
    if (labelKey === null) continue;
    if (labelKey === noteKey) return label;
    if ([...labelKey].length >= BILL_MATCH_MIN_LABEL_LENGTH && containsAsWholeWord(noteKey, labelKey)) return label;
  }
  return undefined;
}

/**
 * Returns `warn` exactly when the entry is dated Today and either the note matches an Active_Bill label or the amount
 * is at least the server threshold. An unavailable cause is skipped and never affects saving. The result carries the
 * reasons only, so the entry's amount, category, note, and date are untouched.
 */
export function classifyEntryWarning(input: ClassifyEntryWarningInput): EntryWarning {
  const { entry, today, billKeys, largeEntryThresholdMinor } = input;
  if (typeof today !== 'string' || today === '' || entry.spentOn !== today) return NONE;

  let bill: string | undefined;
  if (Array.isArray(billKeys) && typeof entry.note === 'string') {
    const noteKey = normalizeNoteKey(entry.note);
    if (noteKey !== null) bill = matchBill(noteKey, billKeys);
  }

  const large =
    typeof largeEntryThresholdMinor === 'number' &&
    Number.isSafeInteger(largeEntryThresholdMinor) &&
    Number.isSafeInteger(entry.amountMinor) &&
    entry.amountMinor >= largeEntryThresholdMinor;

  if (bill === undefined && !large) return NONE;
  return bill === undefined ? { kind: 'warn', large } : { kind: 'warn', bill, large };
}

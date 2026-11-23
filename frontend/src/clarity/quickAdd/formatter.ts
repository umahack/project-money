/**
 * Quick Add formatter: writes a parsed entry back as a canonical Quick_Add_Line.
 *
 * Pure: no clock, locale, `Intl`, storage, or network. The output is `₹<amount> <yyyy-mm-dd>` followed by the
 * note in double quotes when the note is not empty. A literal `"` in the note is written as `""`. Because the
 * note is quoted, a note that looks like an amount or a date parses back as a note.
 *
 * Requirements: 2.32, 2.33, 7.10.
 */

import { formatInrDigits } from './amount';
import { isIsoDate } from './dates';

/**
 * The fields the formatter reads. This is structurally the design's `ParsedEntry`
 * (`{ amountMinor, spentOn, note }`), so a parser result is assignable to it.
 */
export interface FormattableEntry {
  /** Positive integer paise. */
  amountMinor: number;
  /** A real `YYYY-MM-DD` date. */
  spentOn: string;
  /** Note_Text as the parser returns it (whitespace collapsed and trimmed); may be empty. */
  note: string;
}

/**
 * Formats an entry as a canonical Quick_Add_Line.
 *
 * Throws a RangeError when `amountMinor` is not a positive safe integer or `spentOn` is not a real
 * `YYYY-MM-DD` date, because the formatter never guesses a value. A parser result always satisfies both.
 * The note is written as given: pass the parser's canonical note (whitespace already collapsed) for the
 * round trip of Requirement 2.33.
 */
export function formatQuickAddLine(entry: FormattableEntry): string {
  if (!Number.isSafeInteger(entry.amountMinor) || entry.amountMinor <= 0) {
    throw new RangeError('Amount must be a positive safe integer number of paise.');
  }
  if (!isIsoDate(entry.spentOn)) {
    throw new RangeError('Date must be a real YYYY-MM-DD date.');
  }
  const head = `₹${formatInrDigits(entry.amountMinor)} ${entry.spentOn}`;
  if (entry.note.length === 0) return head;
  return `${head} "${entry.note.replace(/"/g, '""')}"`;
}

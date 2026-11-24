// The wording of the Entry_Answer. `buildEntryAnswer` returns message KEYS plus references to server money values and
// owns no text. This catalogue turns each key into one plain-language sentence. Every value is formatted from the
// server's integer paise with the shared INR formatter, and nothing here adds, subtracts, multiplies, or divides money.
// The only arithmetic on a money value is `Math.abs` for the signed `remainingSpendable`, which the answer model passes
// through as the server sent it (sign handling for display only).
//
// `ANSWER_MESSAGES` is typed `Record<AnswerMessageKey, ...>`, so a key added to answer.ts without copy here fails to
// compile. A test also reads answer.ts and compares its key literals with this catalogue.
//
// Requirements: 9.3 to 9.14, 9.16, 9.19, 8.5.
import type { MoneyValue } from '../../clarity/contracts';
import { formatInr } from '../../clarity/quickAdd/amount';
import type { AnswerLine, AnswerMessageKey, EntryAnswerModel } from '../../clarity/quickAdd/answer';
import { OUTCOME_KIND_LABEL, humanizeKey, joinList } from '../clarity/format';
import { formatEntryDate, formatMonthYear } from './format';

export type AnswerCopy = (line: AnswerLine) => string;

const FALLBACK_AMOUNT = 'an amount that is not available';

function isMoney(value: unknown): value is MoneyValue {
  return !!value && typeof value === 'object' && Number.isSafeInteger((value as MoneyValue).amountMinor);
}

/** The server value of `role` as `₹…`, or null when the line carries none. */
function moneyOf(line: AnswerLine, role: string): string | null {
  const value = line.money?.[role];
  return isMoney(value) ? formatInr(value.amountMinor) : null;
}

function need(line: AnswerLine, role: string): string {
  return moneyOf(line, role) ?? FALLBACK_AMOUNT;
}

function text(line: AnswerLine, name: string): string {
  const value = line.params?.[name];
  return typeof value === 'string' ? value : '';
}

function listOf(line: AnswerLine, name: string): readonly string[] {
  const value = line.params?.[name];
  return Array.isArray(value) ? (value as readonly string[]) : [];
}

function bucketName(line: AnswerLine): string {
  return text(line, 'bucket') === 'needs' ? 'Needs' : 'Wants';
}

/** `November 2026` for a `YYYY-MM` key. */
function monthName(key: string): string {
  return key === '' ? 'this month' : formatMonthYear(key);
}

const EXTRA_KIND_LABEL: Readonly<Record<string, string>> = Object.freeze({ today_allowance: "today's allowance" });

function kindLabel(kind: string): string {
  const known = (OUTCOME_KIND_LABEL as Readonly<Record<string, string>>)[kind];
  return known ?? EXTRA_KIND_LABEL[kind] ?? humanizeKey(kind).toLowerCase();
}

function isPayInput(input: string): boolean {
  return input === 'salary' || input.startsWith('salary:');
}

const ZERO_REASON: Readonly<Record<string, (used: string | null) => string>> = Object.freeze({
  month_budget_used: (used) => (
    `This month's spendable budget was already used before today${used ? `, by ${used}` : ''}.`
  ),
  no_spendable_budget: () => 'Your bills use all of your pay this month.',
  below_minimum_unit: () => 'What is left is less than ₹0.01 a day.',
});

export const ANSWER_MESSAGES: Readonly<Record<AnswerMessageKey, AnswerCopy>> = Object.freeze({
  'answer.saved': (line) => {
    const amount = moneyOf(line, 'amount') ?? 'your expense';
    const category = text(line, 'category');
    const note = text(line, 'note');
    return `Saved ${amount}${category ? ` to ${category}` : ''}${note ? `: ${note}` : ''}.`;
  },
  'answer.removed': (line) => {
    const category = text(line, 'category');
    return `The ${category ? `${category} ` : ''}entry was removed. These are the values after the deletion.`;
  },
  'answer.entry.date': (line) => {
    const date = formatEntryDate(text(line, 'date'));
    return text(line, 'relation') === 'future' ? `Dated ${date}, a future date.` : `Dated ${date}, not today.`;
  },
  'answer.today.spent': (line) => (
    `Spent today: ${need(line, 'todaySpent')} of today's allowance of ${need(line, 'todayAllowance')}.`
  ),
  'answer.today.left': (line) => `${need(line, 'leftToday')} left today.`,
  'answer.today.over': (line) => `Over today's allowance by ${need(line, 'overToday')}.`,
  'answer.today.zeroAllowance': (line) => {
    const reason = ZERO_REASON[text(line, 'reason')];
    return `You can spend ₹0 today.${reason ? ` ${reason(moneyOf(line, 'usedBeyondBudget'))}` : ''}`;
  },
  'answer.today.excluded.notCounted': () => "Not counted against today's allowance.",
  'answer.today.excluded.monthIncludes': () => "Your month's totals include it.",
  'answer.today.excluded.allowanceAfter': (line) => `Today's allowance after this save: ${need(line, 'todayAllowance')}.`,
  'answer.today.excluded.allowanceChanged': () => "It changed because this entry uses part of the month's budget.",
  'answer.today.exclusionUnconfirmed': () => 'Saved and counted against today. The server did not confirm the exclusion.',
  'answer.bucket.status': (line) => {
    const bucket = bucketName(line);
    const own = text(line, 'source') === 'override' ? ' (set by you)' : '';
    return `Counts toward your ${bucket} budget${own}: ${need(line, 'spent')} spent of ${need(line, 'budget')}.`;
  },
  'answer.bucket.exceeded': (line) => `${bucketName(line)} budget exceeded by ${need(line, 'excess')}.`,
  'answer.month.remaining': (line) => (
    `Remaining spendable for ${monthName(text(line, 'month'))}: ${need(line, 'remainingSpendable')}.`
  ),
  'answer.month.overBudget': (line) => {
    const value = line.money?.remainingSpendable;
    // The server value is negative. Its magnitude is shown after "Over", which is formatting and not a calculation.
    const magnitude = isMoney(value) ? formatInr(Math.abs(value.amountMinor)) : FALLBACK_AMOUNT;
    return `Over ${monthName(text(line, 'month'))}'s spendable budget by ${magnitude}.`;
  },
  'answer.month.countsTowardOther': (line) => {
    const month = monthName(text(line, 'month'));
    const current = monthName(text(line, 'currentMonth'));
    return `This entry counts toward ${month}, not ${current}. Your numbers for ${current} are unchanged.`;
  },
  'answer.missingInput': (line) => {
    const month = monthName(text(line, 'month'));
    const input = text(line, 'input');
    const what = isPayInput(input) || input === '' ? `the pay for ${month}` : `${humanizeKey(input).toLowerCase()} for ${month}`;
    return `Saved. Add ${what} to see what this entry changes.`;
  },
  'answer.invalidInput': (line) => {
    const month = monthName(text(line, 'month'));
    const input = text(line, 'input');
    const constraint = text(line, 'constraint');
    const affects = listOf(line, 'affects').map(kindLabel);
    const name = input === '' ? 'An input' : humanizeKey(input);
    return `Saved. ${name} for ${month} is not valid${constraint ? `. It must be: ${constraint}` : ''}.`
      + `${affects.length > 0 ? ` This affects your ${joinList(affects)}.` : ''}`;
  },
  'answer.effect.unavailable': (line) => (
    `Saved. What this entry changes for ${monthName(text(line, 'month'))} is temporarily unavailable.`
  ),
});

/** Every key the catalogue has copy for. */
export const ANSWER_MESSAGE_KEYS = Object.freeze(Object.keys(ANSWER_MESSAGES) as AnswerMessageKey[]);

/** The sentence for one answer line. A key without copy gives an empty string, which the UI never renders. */
export function formatAnswerLine(line: AnswerLine): string {
  const copy = (ANSWER_MESSAGES as Readonly<Record<string, AnswerCopy | undefined>>)[line.key];
  return copy ? copy(line) : '';
}

/** The lines that make a good one-line status for an entry that is no longer the current answer, best first. */
const SUMMARY_ORDER: readonly AnswerMessageKey[] = Object.freeze([
  'answer.today.over',
  'answer.today.left',
  'answer.month.countsTowardOther',
  'answer.missingInput',
  'answer.invalidInput',
  'answer.effect.unavailable',
]);

/**
 * One line for an earlier entry's row (Requirement 9.16). It is the entry's own answer as it was when the entry was
 * confirmed, so it never states a newer value than the one the server returned for that entry.
 */
export function summarizeAnswer(answer: EntryAnswerModel | undefined): string | null {
  if (!answer || answer.mode === 'removed') return null;
  for (const key of SUMMARY_ORDER) {
    const line = answer.lines.find((candidate) => candidate.key === key);
    if (line) return formatAnswerLine(line);
  }
  return null;
}

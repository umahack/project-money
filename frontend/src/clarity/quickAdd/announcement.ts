/**
 * The polite message that announces one confirmed save (Requirements 9.18, 12.3).
 *
 * It states the saved amount and category, and then ONE result: Left_Today (or "over today's allowance" when the
 * server says the entry's day is over), or, when the answer has no Today values, the month the entry counts toward.
 * Every value comes from the answer model, which holds the server's integer paise untouched. Nothing is added,
 * subtracted, multiplied, or divided here. A pending state is never announced, and the message is one short
 * sentence group so it stays quiet.
 */
import { formatInr } from './amount';
import type { AnswerLine, EntryAnswerModel } from './answer';
import { describeMonth } from './dates';

function lineOf(answer: EntryAnswerModel, key: AnswerLine['key']): AnswerLine | undefined {
  return answer.lines.find((line) => line.key === key);
}

/** The server's money value of `role` on the line, formatted, or null when the line does not carry it. */
function serverMoney(line: AnswerLine | undefined, role: string): string | null {
  const value = line?.money?.[role];
  return value && Number.isSafeInteger(value.amountMinor) ? formatInr(value.amountMinor) : null;
}

/** The sentence that ends the announcement, or null when the answer names neither Left_Today nor a month. */
export function answerResultSentence(answer: EntryAnswerModel | undefined): string | null {
  if (!answer) return null;
  if (answer.today === 'shown') {
    const over = serverMoney(lineOf(answer, 'answer.today.over'), 'overToday');
    if (over) return `Over today's allowance by ${over}.`;
    const left = serverMoney(lineOf(answer, 'answer.today.left'), 'leftToday');
    if (left) return `${left} left today.`;
  }
  return answer.month !== '' ? `Counts toward ${describeMonth(answer.month)}.` : null;
}

export function buildSaveAnnouncement(input: {
  amountMinor: number;
  category: string;
  answer?: EntryAnswerModel;
}): string {
  const saved = `Saved ${formatInr(input.amountMinor)} to ${input.category}.`;
  const result = answerResultSentence(input.answer);
  return result ? `${saved} ${result}` : saved;
}

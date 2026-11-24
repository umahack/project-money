import type { ReactNode } from 'react';
import { formatInr } from '../../clarity/quickAdd/amount';
import type { ParseProblem, ParseProblemCode } from '../../clarity/quickAdd/parser';
import { CategoryChoice } from './CategoryChoice';
import { EntryWarning } from './EntryWarning';
import { formatEntryDate, formatMonthYear } from './format';
import { RECURRING_HINT_TEXT, hasRecurringHint } from './recurringHint';
import { FORGET_DONE_TEXT, useRequiredQuickAddDraft } from './QuickAddDraft';
import './quickAdd.css';

export const NOT_READY_TEXT = 'Not ready to save yet.';
export const NO_NOTE_TEXT = 'No note';
export const TODAY_LABEL = 'Today';
export const FUTURE_DATE_LABEL = 'Future date';
export const HINTS_LOADING_TEXT = 'Checking your saved category choices.';
export const HINTS_UNAVAILABLE_TEXT = 'Saved choices are unavailable. Quick Add suggests from category names and keywords instead.';

const PROBLEM_FIELD: Readonly<Record<ParseProblemCode, string>> = {
  LINE_TOO_LONG: 'Line',
  MISSING_AMOUNT: 'Amount',
  INVALID_AMOUNT: 'Amount',
  MULTIPLE_AMOUNTS: 'Amount',
  INVALID_DATE: 'Date',
  MULTIPLE_DATES: 'Date',
  NOTE_TOO_LONG: 'Note',
};

/** The affected part, the reason, and the accepted correction, all from the parser, as one plain-text item. */
function ProblemItem({ problem }: { problem: ParseProblem }) {
  return (
    <li>
      <strong>{PROBLEM_FIELD[problem.code]}{problem.part ? ` "${problem.part}"` : ''}:</strong>
      {' '}{problem.reason} {problem.correction}
    </li>
  );
}

/**
 * The Entry_Preview: what Quick Add understood from the line, or why it could not (Requirements 3.1 to 3.6, 3.8, 3.13,
 * 3.14, 5.12, 5.14, 5.15, 18.1 to 18.7). It is derived in the same render as each keystroke, so it is on screen within
 * 100 milliseconds. It is plain text, never live while the User types. A line that cannot be saved is never guessed:
 * the parser's own reason and correction are shown. After a submit on such a line the same text is announced once
 * as an alert and tied to the input, and focus does not move.
 *
 * Nothing renders for an empty line. Renders nothing while Quick_Add_Enabled is off.
 */
export function ParsedPreview() {
  const draft = useRequiredQuickAddDraft();
  if (!draft) return null;
  const {
    ids, parse, entry, problems, attemptCount, suggestion, category, categories, today, hints, warning,
    gated, blockedReason, forgetStatus,
  } = draft;

  const forgetText = forgetStatus.kind === 'done'
    ? FORGET_DONE_TEXT
    : forgetStatus.kind === 'failed' ? forgetStatus.message : '';

  let body: ReactNode = null;
  if (parse && !parse.ok) {
    body = (
      <>
        <p className="qa-status is-not-ready">{NOT_READY_TEXT}</p>
        {attemptCount > 0 ? (
          // A new element for each attempt, so the problems are announced once per submit and focus stays put.
          <div role="alert" key={attemptCount}>
            <ul className="qa-problems">{problems.map((problem, index) => <ProblemItem key={index} problem={problem} />)}</ul>
          </div>
        ) : (
          <ul className="qa-problems qa-problems-plain">
            {problems.map((problem, index) => <ProblemItem key={index} problem={problem} />)}
          </ul>
        )}
      </>
    );
  } else if (entry && suggestion && category) {
    const otherMonth = entry.spentOn.slice(0, 7) !== today.slice(0, 7);
    const dateBadge = entry.spentOn === today ? TODAY_LABEL : entry.spentOn > today ? FUTURE_DATE_LABEL : null;
    const hintsText = hints.state === 'loading'
      ? HINTS_LOADING_TEXT
      : hints.state === 'unavailable' || hints.memoryUnavailable ? HINTS_UNAVAILABLE_TEXT : null;

    body = (
      <>
        <p className="qa-preview-title">What Quick Add understood</p>
        <ul className="qa-rows">
          <li className="qa-row">
            <span className="qa-row-label">Amount</span>
            <span className="qa-row-value"><strong>{formatInr(entry.amountMinor)}</strong></span>
          </li>
          <li className="qa-row qa-row-wide">
            <CategoryChoice
              id={ids.category}
              categories={categories}
              value={category}
              suggestion={suggestion}
              reasonId={ids.reason}
              onChange={draft.chooseCategory}
              onForget={draft.forget}
              forgetBusy={forgetStatus.kind === 'pending'}
              forgetStatusText={forgetText}
            />
          </li>
          <li className="qa-row">
            <span className="qa-row-label">Date</span>
            <span className="qa-row-value">
              <span>{formatEntryDate(entry.spentOn)}</span>
              {dateBadge && <span className="clarity-badge clarity-tone-info">{dateBadge}</span>}
            </span>
          </li>
          {otherMonth && (
            <li className="qa-row">
              <span className="qa-row-label">Month</span>
              <span className="qa-row-value">
                Counts toward {formatMonthYear(entry.spentOn)}, not this month.
              </span>
            </li>
          )}
          <li className="qa-row">
            <span className="qa-row-label">Note</span>
            <span className="qa-row-value">
              {entry.note === '' ? <span>{NO_NOTE_TEXT}</span> : <span className="qa-note-text">{entry.note}</span>}
            </span>
          </li>
        </ul>
        {hintsText && <p className="qa-hint small">{hintsText}</p>}
        {hasRecurringHint(entry.note) && <p className="qa-hint small">{RECURRING_HINT_TEXT}</p>}
      </>
    );
  }

  return (
    <div className="qa-preview">
      <div id={ids.preview} className="qa-preview-body">{body}</div>
      {warning && (
        <EntryWarning
          warning={warning}
          textId={ids.warning}
          disabled={gated || blockedReason !== null}
          disabledReasonId={gated ? ids.paused : ids.blocked}
          onSave={draft.submit}
        />
      )}
    </div>
  );
}

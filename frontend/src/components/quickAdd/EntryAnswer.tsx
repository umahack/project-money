import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { getToken } from '../../api';
import type { EntryAnswerModel, AnswerAction, AnswerExclusionReason } from '../../clarity/quickAdd/answer';
import { selectQuickAddEnabled } from '../../clarity/rollout';
import type { ChangeResult, RecalculateResult } from '../../clarity/quickAdd/useQuickAddActions';
import { ActionLink } from '../clarity/ActionLink';
import { CalculationExplanationPanel } from '../clarity/CalculationExplanationPanel';
import { useFocusRescue } from '../clarity/focus';
import { ClassificationBadge } from '../clarity/labels';
import { formatAnswerLine } from './answerMessages';
import './quickAdd.css';
import './quickAddEntries.css';

export const ANSWER_TITLE = 'Answer for your latest entry';
export const REMOVED_TITLE = 'Entry removed';
export const EXPLANATION_TITLE = "Today's allowance";
export const RECALCULATE_LABEL = 'Recalculate';
export const RECALCULATING_LABEL = 'Recalculating…';
export const RECALCULATE_FAILED_TEXT = 'It is still unavailable. Your expense is saved. Try Recalculate again in a moment.';
export const PAY_FORM_LABEL = "Add this month's pay";
export const EXCLUDE_LABEL = "Don't count this against today";
export const EXCLUDING_LABEL = 'Changing…';
export const EXCLUDE_BUSY_TEXT = 'Another change to this expense is still saving. Try again in a moment.';
export const EXCLUDE_FAILED_TEXT = 'The change was not saved. The expense is unchanged.';
export const TODAY_UNAVAILABLE_TEXT = "Today's allowance is temporarily unavailable. The saved entry and your monthly numbers are not affected.";

const EXCLUDE_REASON: Readonly<Record<AnswerExclusionReason, string>> = Object.freeze({
  unconfirmed: 'The server did not confirm the exclusion you asked for.',
  large: 'This was a large entry.',
  bill: 'It looks like a bill that your Plan already counts.',
  over_today: "It put you over today's allowance.",
});

export interface EntryAnswerProps {
  answer: EntryAnswerModel;
  headingLevel?: 2 | 3 | 4;
  /** Re-reads the snapshot and refreshes the answer. Resubmits nothing. Absent hides the action's effect, not its text. */
  onRecalculate?: () => Promise<RecalculateResult>;
  /** Changes the entry to "not counted against today". */
  onExclude?: (recordId: number) => Promise<ChangeResult>;
  /** The values come from the signed-in User's own data, so the explanation can be offered. */
  ownerData?: boolean;
  className?: string;
}

function ActionRow({ children }: { children: ReactNode }) {
  return <div className="qa-answer-actions">{children}</div>;
}

/**
 * The Entry_Answer of the most recently confirmed entry, as text (Requirements 9.3 to 9.14, 9.17, 9.19, 9.20).
 *
 * It renders the structured model of `buildEntryAnswer` and nothing else: each key becomes one sentence from the
 * message catalogue, each amount is the server's value formatted by the shared INR formatter, and no money is
 * calculated here. The entered amount is labelled an entered fact and every other value a calculated result. The
 * Today_Allowance explanation uses the existing explanation panel, and it stays open while the values update.
 * It is not a live region: the polite announcement of a save comes from the Announcer.
 *
 * Renders nothing while Quick_Add_Enabled is off.
 */
export function EntryAnswer(props: EntryAnswerProps) {
  if (!selectQuickAddEnabled()) return null;
  return <EnabledEntryAnswer {...props} />;
}

function EnabledEntryAnswer({
  answer,
  headingLevel = 3,
  onRecalculate,
  onExclude,
  ownerData = true,
  className = '',
}: EntryAnswerProps) {
  const baseId = useId();
  const titleId = `${baseId}-title`;
  const panelId = `${baseId}-explanation`;
  const rootRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const rescue = useFocusRescue(rootRef);
  const mounted = useRef(true);
  const [open, setOpen] = useState(false);
  const [recalculating, setRecalculating] = useState(false);
  const [recalcFailed, setRecalcFailed] = useState(false);
  const [excluding, setExcluding] = useState(false);
  const [excludeNote, setExcludeNote] = useState('');

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // A new answer, for example after a recalculation, clears the notes about the last attempt.
  useEffect(() => {
    setRecalcFailed(false);
    setExcludeNote('');
  }, [answer.dataVersion, answer.status]);

  const removed = answer.mode === 'removed';
  const Heading = `h${headingLevel}` as 'h2' | 'h3' | 'h4';
  const hasCalculated = answer.lines.some((line) => line.classification === 'calculated_result');
  const explainable = ownerData && !!getToken() && answer.explanation !== null;

  async function recalculate() {
    if (recalculating || !onRecalculate) return;
    rescue.arm();
    setRecalculating(true);
    setRecalcFailed(false);
    try {
      const result = await onRecalculate();
      // Anything but a finished re-read leaves the effect unavailable, and the text says so.
      if (mounted.current) setRecalcFailed(result.status !== 'recalculated');
    } catch {
      if (mounted.current) setRecalcFailed(true);
    } finally {
      if (mounted.current) setRecalculating(false);
    }
  }

  async function exclude(recordId: number) {
    if (excluding || !onExclude) return;
    rescue.arm();
    setExcluding(true);
    setExcludeNote('');
    try {
      const result = await onExclude(recordId);
      if (!mounted.current) return;
      if (result.status === 'busy') setExcludeNote(EXCLUDE_BUSY_TEXT);
      else if (result.status === 'failed') setExcludeNote(EXCLUDE_FAILED_TEXT);
    } catch {
      if (mounted.current) setExcludeNote(EXCLUDE_FAILED_TEXT);
    } finally {
      if (mounted.current) setExcluding(false);
    }
  }

  // Escape closes the explanation from the toggle or from inside the panel and returns focus to the toggle.
  const onDisclosureKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || !open) return;
    event.stopPropagation();
    setOpen(false);
    toggleRef.current?.focus();
  };

  function renderAction(action: AnswerAction) {
    switch (action.key) {
      case 'recalculate':
        return (
          <ActionRow key="recalculate">
            <button
              type="button"
              className="btn sm qa-answer-button"
              aria-disabled={recalculating || undefined}
              onClick={() => { void recalculate(); }}
            >
              {recalculating ? RECALCULATING_LABEL : RECALCULATE_LABEL}
            </button>
            {recalcFailed && <p role="status" className="small qa-answer-note">{RECALCULATE_FAILED_TEXT}</p>}
          </ActionRow>
        );
      case 'open_plan_pay_form':
        return (
          <ActionRow key="open_plan_pay_form">
            <ActionLink to={action.route} label={PAY_FORM_LABEL} variant="primary" showDisclaimer={false} />
          </ActionRow>
        );
      case 'exclude_from_today':
        return (
          <ActionRow key="exclude_from_today">
            <p className="small qa-answer-note">
              {action.reasons.map((reason) => EXCLUDE_REASON[reason]).join(' ')}
              {' '}You can leave it out of today's allowance. The month's totals still include it.
            </p>
            <button
              type="button"
              className="btn sm qa-answer-button"
              aria-disabled={excluding || undefined}
              onClick={() => { void exclude(action.recordId); }}
            >
              {excluding ? EXCLUDING_LABEL : EXCLUDE_LABEL}
            </button>
            {excludeNote && <p role="status" className="small qa-answer-note">{excludeNote}</p>}
          </ActionRow>
        );
      default:
        return null;
    }
  }

  return (
    <section
      ref={rootRef}
      tabIndex={-1}
      aria-labelledby={titleId}
      className={`qa-answer ${className}`.trim()}
      data-mode={answer.mode}
      data-status={answer.status}
      data-today={answer.today}
      data-scope={answer.scope}
      data-version={answer.dataVersion}
    >
      <Heading id={titleId} className="qa-answer-title">{removed ? REMOVED_TITLE : ANSWER_TITLE}</Heading>
      {hasCalculated && (
        <p className="qa-answer-label small">
          <ClassificationBadge classification="calculated_result" /> Values below are calculated by the server from your confirmed expenses.
        </p>
      )}
      <ul className="qa-answer-lines">
        {answer.lines.map((line, index) => {
          const copy = formatAnswerLine(line);
          if (copy === '') return null;
          const entered = line.classification === 'entered_fact';
          return (
            <li key={`${line.key}:${index}`} className="qa-answer-line" data-key={line.key}>
              <span className="qa-note-text">{copy}</span>
              {entered && <>{' '}<ClassificationBadge classification="entered_fact" /></>}
              {line.classification === 'calculated_result' && (
                <span className="sr-only" data-classification="calculated_result"> Calculated result.</span>
              )}
            </li>
          );
        })}
        {answer.today === 'unavailable' && answer.status === 'available' && (
          <li className="qa-answer-line" data-key="today.unavailable">
            <span className="qa-note-text">{TODAY_UNAVAILABLE_TEXT}</span>
          </li>
        )}
      </ul>

      {answer.actions.map(renderAction)}

      {explainable && answer.explanation && (
        <div className="clarity-explain" onKeyDown={onDisclosureKeyDown}>
          <button
            ref={toggleRef}
            type="button"
            className="btn sm ghost clarity-disclosure qa-answer-button"
            aria-expanded={open}
            aria-controls={panelId}
            aria-label={`How this was calculated for ${EXPLANATION_TITLE}`}
            onClick={() => setOpen((value) => !value)}
          >
            <span aria-hidden="true" className="clarity-chevron">{open ? '▾' : '▸'}</span>
            How this was calculated
          </button>
          <div id={panelId} hidden={!open}>
            {open && (
              <CalculationExplanationPanel
                outcomeId={answer.explanation.outcomeId}
                dataVersion={answer.explanation.dataVersion}
                title={EXPLANATION_TITLE}
              />
            )}
          </div>
        </div>
      )}
    </section>
  );
}

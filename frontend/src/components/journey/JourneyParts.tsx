import { useId, useRef, type Ref } from 'react';
import { Link } from 'react-router-dom';
import { buildActionRoute } from '../../clarity/actionContext';
import { outcomeLabel } from '../../clarity/dataUseLabels';
import type { JourneyFailure } from '../../clarity/useGuidedJourney';
import {
  CLARITY_CHOICES,
  CLARITY_QUESTION,
  JOURNEY_OUTCOMES,
  describeProgress,
  outcomeCopy,
  skipOutcomeFor,
  stepCopy,
  type GuidedJourneyView,
  type JourneyOutcomeKey,
  type JourneyStepView,
} from '../../clarity/journeys';
import type { ClarityResponse } from '../../clarity/measurement';
import { skipEffectText } from '../../clarity/purposeRegistry';
import { useFocusRescue } from '../clarity/focus';
import '../clarity/purpose.css';
import './journey.css';

/* ------------------------------ Outcome choice ------------------------------ */

export interface JourneyOutcomeChoiceProps {
  /** The outcome whose start request is running, if any. */
  starting: JourneyOutcomeKey | null;
  /** True while any journey request runs, so a second click cannot start another journey. */
  disabled: boolean;
  onChoose: (outcome: JourneyOutcomeKey) => void;
}

/**
 * Exactly four choices from the fixed client registry. They are native buttons,
 * so Enter and Space work, and each names what it gives and what it needs.
 */
export function JourneyOutcomeChoice({ starting, disabled, onChoose }: JourneyOutcomeChoiceProps) {
  return (
    <ul className="journey-choices" aria-label="Desired outcomes">
      {JOURNEY_OUTCOMES.map((outcome) => {
        const describedBy = `journey-choice-${outcome.key}`;
        const titleId = `${describedBy}-title`;
        return (
          <li key={outcome.key}>
            <button
              type="button"
              className="journey-choice"
              aria-labelledby={titleId}
              aria-describedby={describedBy}
              aria-disabled={disabled || undefined}
              aria-busy={starting === outcome.key || undefined}
              data-outcome={outcome.key}
              onClick={() => {
                if (!disabled) onChoose(outcome.key);
              }}
            >
              <strong id={titleId} className="journey-choice-title">{outcome.title}</strong>
              <span id={describedBy} className="journey-choice-text">
                <span className="journey-choice-line">{outcome.description}</span>
                <span className="journey-choice-line muted small">{outcome.needs}</span>
                {starting === outcome.key && <span className="journey-choice-line small">Starting…</span>}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/* --------------------------------- Progress --------------------------------- */

function stepStateText(journey: GuidedJourneyView, key: string, status: string): string {
  if (status === 'satisfied') return 'Done';
  if (journey.status === 'active' && !journey.firstOutcome.available && key === journey.currentStepKey) return 'Current step';
  return 'To do';
}

/**
 * Current, completed, and remaining required steps as text, so progress never
 * depends on color. Optional steps are named but not counted.
 */
export function JourneyProgress({ journey }: { journey: GuidedJourneyView }) {
  const required = journey.steps.filter((step) => step.required);
  const optional = journey.steps.filter((step) => !step.required);
  return (
    <section className="journey-progress" aria-label="Journey progress">
      <p className="journey-progress-text">
        <strong>{describeProgress(journey)}</strong>
      </p>
      <ol className="journey-steps">
        {required.map((step, index) => {
          const state = stepStateText(journey, step.key, step.status);
          return (
            <li key={step.key} aria-current={state === 'Current step' ? 'step' : undefined} data-step={step.key} data-state={state}>
              <span className="journey-step-name">{index + 1}. {stepCopy(step.key).title}</span>
              <span className="journey-step-state small">
                <span aria-hidden="true" className="clarity-glyph">{state === 'Done' ? '✓' : state === 'Current step' ? '→' : '•'}</span>
                {state}
              </span>
            </li>
          );
        })}
      </ol>
      {optional.length > 0 && (
        <p className="muted small">
          Optional after your first result: {optional.map((step) => stepCopy(step.key).title).join(', ')}.
        </p>
      )}
    </section>
  );
}

/* ----------------------------- Scoped failure slot ----------------------------- */

export interface FailureSlotProps {
  failure: JourneyFailure | null;
  /** Names what failed, for example "Add your monthly pay". */
  label: string;
  onRetry: () => void;
  onDismiss: () => void;
  className?: string;
}

/**
 * The failure for one place on the page: the choice list, one step, or the
 * journey controls. The slot stays mounted so the announcement is reliable and
 * focus has somewhere to land when Retry or Dismiss removes its own button.
 * Retry sends the same request again.
 */
export function FailureSlot({ failure, label, onRetry, onDismiss, className = '' }: FailureSlotProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const rescue = useFocusRescue(rootRef);
  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className={`clarity-mutation journey-failure ${failure ? 'clarity-mutation-error' : ''} ${className}`.trim()}
      data-scope={failure?.scope ?? undefined}
    >
      <div role="alert">
        {failure && (
          <p className="clarity-mutation-line small">
            <span aria-hidden="true" className="clarity-glyph">✕</span>
            <span>
              <strong>{label}: failed.</strong> {failure.message} Your confirmed records are unchanged.
            </span>
          </p>
        )}
      </div>
      {failure && (
        <div className="clarity-mutation-actions">
          {failure.retryable && (
            <button
              type="button"
              className="btn sm ghost clarity-retry"
              aria-label={`Retry ${label}`}
              onClick={() => {
                rescue.arm();
                onRetry();
              }}
            >
              Retry
            </button>
          )}
          <button
            type="button"
            className="btn sm ghost"
            aria-label={`Dismiss failed ${label}`}
            onClick={() => {
              rescue.arm();
              onDismiss();
            }}
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------- Heading ---------------------------------- */

/** A heading that takes focus when the journey moves to a new step or state. */
export function FocusHeading({ id, headingRef, children }: { id: string; headingRef: Ref<HTMLHeadingElement>; children: string }) {
  return (
    <h2 id={id} ref={headingRef} tabIndex={-1} className="journey-heading">
      {children}
    </h2>
  );
}

/* ------------------------------ Optional purpose ------------------------------ */

export interface JourneyOptionalPurposeProps {
  stepKey: string;
  /** One plain sentence on why the step is asked. */
  purpose: string;
  /** The outcome that stays as it is when the step is skipped. */
  outcome: string;
  onSkip: () => void;
}

/**
 * Purpose, optional state, and a skip for an optional step whose host form has
 * no purpose panel of its own. It uses the same wording and classes as
 * `PurposeExplanation`, and the same skip sentence, so every optional request
 * says that skipping saves nothing and names the outcome left as it is.
 */
export function JourneyOptionalPurpose({ stepKey, purpose, outcome, onSkip }: JourneyOptionalPurposeProps) {
  const id = `purpose-${stepKey}`;
  const titleId = `${id}-title`;
  const skipTextId = `${id}-skip`;
  const term = outcomeLabel(outcome);
  return (
    <section id={id} className="clarity-purpose" aria-labelledby={titleId} data-step={stepKey} data-requirement="optional">
      <p id={titleId} className="clarity-purpose-title">
        <span>Why we ask</span>
        <span className="clarity-badge clarity-tone-info clarity-purpose-requirement">Optional</span>
      </p>
      <p className="clarity-purpose-text">{purpose}</p>
      <p className="clarity-purpose-lead">This changes:</p>
      <ul className="clarity-purpose-terms">
        <li>
          <dfn className="clarity-purpose-term">{term.label}</dfn>
          {term.definition ? `: ${term.definition}.` : null}
        </li>
      </ul>
      <div className="clarity-purpose-skip">
        <p id={skipTextId} className="clarity-purpose-skip-text">If you skip: {skipEffectText(outcome)}</p>
        <button type="button" className="btn ghost" aria-describedby={skipTextId} onClick={onSkip}>
          Skip for now
        </button>
      </div>
    </section>
  );
}

/* ----------------------------- Clarity question ----------------------------- */

export type ClarityAnswer = ClarityResponse | 'skipped';

export interface ClarityQuestionProps {
  /** What the user chose, or null while the question is open. Kept in memory only. */
  answer: ClarityAnswer | null;
  onAnswer: (answer: ClarityAnswer) => void;
}

/**
 * One nonblocking question with exactly three answers and a skip. Answering or
 * skipping changes nothing else on the page, so the finish action stays enabled
 * the whole time. Which answer was chosen is shown as text only.
 */
export function ClarityQuestion({ answer, onAnswer }: ClarityQuestionProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const rescue = useFocusRescue(rootRef);
  const titleId = useId();
  const choose = (next: ClarityAnswer) => {
    rescue.arm();
    onAnswer(next);
  };
  return (
    <div ref={rootRef} tabIndex={-1} role="group" aria-labelledby={titleId} className="journey-question">
      <p id={titleId} className="journey-question-title">
        <strong>{CLARITY_QUESTION}</strong> <span className="muted small">Optional</span>
      </p>
      {answer === null ? (
        <>
          <div className="journey-actions">
            {CLARITY_CHOICES.map((choice) => (
              <button key={choice.value} type="button" className="btn" data-response={choice.value} onClick={() => choose(choice.value)}>
                {choice.label}
              </button>
            ))}
            <button type="button" className="btn ghost" onClick={() => choose('skipped')}>Skip question</button>
          </div>
          <p className="small muted">
            Your answer is shared only when Product Analytics is on in Settings. It is not saved anywhere else.
          </p>
        </>
      ) : (
        <p className="journey-question-result" data-answer={answer}>
          {answer === 'skipped' ? 'Question skipped. Nothing was sent.' : `Thanks. You answered: ${CLARITY_CHOICES.find((choice) => choice.value === answer)?.label}.`}
        </p>
      )}
    </div>
  );
}

/* --------------------------------- Summary --------------------------------- */

/** What happened to each step, as text, with the skipped outcome named. */
function summaryLine(step: JourneyStepView): string {
  if (step.status === 'satisfied') return 'Done';
  if (step.status === 'skipped') {
    const outcome = skipOutcomeFor(step);
    return outcome ? `Skipped. ${skipEffectText(outcome)}` : 'Skipped. Nothing was saved or changed.';
  }
  return step.required ? 'Not done' : 'Not added';
}

export interface JourneySummaryProps {
  journey: GuidedJourneyView;
  headingRef: Ref<HTMLHeadingElement>;
  onChooseAnother: () => void;
}

/**
 * The closing summary: each step and what happened to it, then links to the page
 * that shows the result and to Home. Routes come from the fixed action registry.
 */
export function JourneySummary({ journey, headingRef, onChooseAnother }: JourneySummaryProps) {
  const copy = outcomeCopy(journey.desiredOutcome);
  const homeRoute = buildActionRoute({ page: 'home' }) ?? '/';
  return (
    <section className="card journey-panel" aria-labelledby="journey-finished-title">
      <FocusHeading id="journey-finished-title" headingRef={headingRef}>Journey finished</FocusHeading>
      <p>
        You finished “{copy.title}”. Your records are saved and nothing was removed.
      </p>
      <ul className="journey-summary" aria-label="What happened to each step">
        {journey.steps.map((step) => (
          <li key={step.key} data-step={step.key} data-state={step.status}>
            <strong>{stepCopy(step.key).title}</strong>
            <span className="small">{step.required ? ' Required. ' : ' Optional. '}{summaryLine(step)}</span>
          </li>
        ))}
      </ul>
      <div className="journey-actions">
        <Link className="btn primary" to={copy.resultRoute}>{copy.resultLabel}</Link>
        <Link className="btn" to={homeRoute}>Go to Home</Link>
        <button type="button" className="btn ghost" onClick={onChooseAnother}>Choose another goal</button>
      </div>
    </section>
  );
}

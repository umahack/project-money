import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  JOURNEY_START_PARAM,
  describeProgress,
  offeredOptionalStep,
  outcomeCopy,
  parseJourneyIntent,
  skipOutcomeFor,
  stepCopy,
  type GuidedJourneyView,
  type JourneyOutcomeKey,
  type JourneyRevealKind,
  type JourneyTransition,
} from '../clarity/journeys';
import { skipEffectText } from '../clarity/purposeRegistry';
import { useGuidedJourney, type JourneyFailure } from '../clarity/useGuidedJourney';
import { useMeasurement } from '../hooks/useMeasurement';
import { RegionBoundary } from '../components/clarity/RegionBoundary';
import { JourneyStepHost, type HostedConfirmation } from '../components/journey/JourneyStepHost';
import {
  ClarityQuestion,
  FailureSlot,
  FocusHeading,
  JourneyOutcomeChoice,
  JourneyProgress,
  JourneySummary,
  type ClarityAnswer,
} from '../components/journey/JourneyParts';
import { StepOutcome, StepRevealBody } from '../components/journey/JourneyReveal';
import { useFirstOutcomeReport } from '../components/journey/useFirstOutcomeReport';
import { Card } from '../components/ui';

const STEP_HEADING_ID = 'journey-step-title';

/** The outcome shown at the first value moment, by the journey the user chose. */
const FIRST_OUTCOME_REVEAL: Readonly<Record<JourneyOutcomeKey, JourneyRevealKind>> = Object.freeze({
  plan_month: 'plan',
  control_spending: 'spending',
  fund_goal: 'goal',
  settle_trip: 'trip',
});

interface StepMark {
  journeyId: number;
  stepKey: string;
}

/** What the user sees. Focus moves to the matching heading when this changes. */
function phaseOf(
  journey: GuidedJourneyView | null | undefined,
  finished: boolean,
  revealed: StepMark | null,
): string {
  if (journey === undefined) return 'loading';
  if (journey === null) return finished ? 'finished' : 'choose';
  if (journey.status === 'paused') return `${journey.id}:paused`;
  if (journey.firstOutcome.available) return `${journey.id}:ready`;
  if (revealed && revealed.journeyId === journey.id) return `${journey.id}:revealed:${revealed.stepKey}`;
  return `${journey.id}:step:${journey.currentStepKey ?? 'none'}`;
}

/**
 * Protected first-session journey. The server owns the steps; this page shows
 * four fixed choices, starts or resumes the user's open journey, hosts the
 * existing input form for the current step, and moves on only after the server
 * has confirmed both the saved record and the step.
 *
 * After each confirmed required step it reveals the outcome that step unlocked
 * and offers one next step. The first outcome is the first value moment. Optional
 * steps come only after it, one at a time, each with a skip that saves nothing.
 * The journey ends with an optional Yes, Partly, or No question and a summary.
 */
export function GuidedJourneyPage() {
  const state = useGuidedJourney();
  const { journey, finished, failure, busy, run, retry, dismissFailure, clearFinished } = state;
  const measurement = useMeasurement();
  useFirstOutcomeReport(journey);
  const [params, setParams] = useSearchParams();
  const [announcement, setAnnouncement] = useState('');
  const [notice, setNotice] = useState('');
  /** Set after a required step is confirmed and another is still to do. Memory only. */
  const [revealed, setRevealed] = useState<StepMark | null>(null);
  /** The optional step confirmed most recently, so its update is shown below the first result. */
  const [updatedBy, setUpdatedBy] = useState<StepMark | null>(null);
  /** The user chose to stop adding optional details. */
  const [wrappedUp, setWrappedUp] = useState<number | null>(null);
  /** Kept in memory for this journey only. The measurement client decides whether it is sent. */
  const [answer, setAnswer] = useState<{ journeyId: number; choice: ClarityAnswer } | null>(null);
  const mainHeading = useRef<HTMLHeadingElement>(null);
  const followHeading = useRef<HTMLHeadingElement>(null);
  const handoffHandled = useRef(false);
  const previousPhase = useRef<string | null>(null);
  const previousFollow = useRef<string | null>(null);

  const open = journey ?? null;
  const optionalStep = open ? offeredOptionalStep(open) : null;
  const wrapping = open !== null && wrappedUp === open.id;
  const showFinish = open !== null && open.status === 'active' && open.firstOutcome.available && (optionalStep === null || wrapping);
  const phase = phaseOf(journey, finished !== null, revealed);
  // Within the ready screen, focus follows the optional step or the finish panel.
  const follow = open && open.status === 'active' && open.firstOutcome.available
    ? (showFinish ? `${open.id}:finish` : `${open.id}:optional:${optionalStep?.key}`)
    : null;

  // Focus moves to the new step's (or state's) heading, but never on the first view of the page.
  useEffect(() => {
    if (phase === 'loading') return;
    const previous = previousPhase.current;
    previousPhase.current = phase;
    if (previous !== null && previous !== phase) mainHeading.current?.focus();
  }, [phase]);

  useEffect(() => {
    const previous = previousFollow.current;
    previousFollow.current = follow;
    // A change inside the ready screen (next optional step, or the finish panel) moves focus there.
    // Entering the ready screen is handled above and focuses the first result.
    if (previous !== null && follow !== null && previous !== follow && previous.split(':')[0] === follow.split(':')[0]) {
      followHeading.current?.focus();
    }
  }, [follow]);

  const announceResult = useCallback((view: GuidedJourneyView | null, text: (view: GuidedJourneyView) => string) => {
    if (view) setAnnouncement(text(view));
  }, []);

  const start = useCallback(async (desiredOutcome: JourneyOutcomeKey) => {
    clearFinished();
    setNotice('');
    const view = await run({ kind: 'start', desiredOutcome });
    announceResult(view, (next) => {
      const ready = next.firstOutcome.available ? ' Your first result is ready.' : '';
      return `Started: ${outcomeCopy(next.desiredOutcome).title}. ${describeProgress(next)}${ready}`;
    });
  }, [announceResult, clearFinished, run]);

  const transition = useCallback(async (
    journeyId: number,
    move: JourneyTransition,
    text: (view: GuidedJourneyView) => string,
  ): Promise<GuidedJourneyView | null> => {
    const view = await run({ kind: 'transition', journeyId, transition: move });
    announceResult(view, text);
    return view;
  }, [announceResult, run]);

  // Registration handoff. A valid intent starts (or resumes) that journey once, then leaves the URL.
  useEffect(() => {
    if (handoffHandled.current || journey === undefined) return;
    handoffHandled.current = true;
    if (!params.has(JOURNEY_START_PARAM)) return;
    const intent = parseJourneyIntent(params);
    const next = new URLSearchParams(params);
    next.delete(JOURNEY_START_PARAM);
    setParams(next, { replace: true });
    if (!intent) return;
    if (journey === null) {
      void start(intent);
    } else if (journey.desiredOutcome === intent) {
      if (journey.status === 'paused') {
        void transition(journey.id, { action: 'resume' }, (view) => `Journey resumed. ${describeProgress(view)}`);
      }
    } else {
      setNotice(
        `Your “${outcomeCopy(journey.desiredOutcome).title}” journey is still open, so “${outcomeCopy(intent).title}” was not started. Finish that journey first.`,
      );
    }
  }, [journey, params, setParams, start, transition]);

  const advance = useCallback(async (stepKey: string, changeId?: number) => {
    if (!journey) return;
    const view = await transition(
      journey.id,
      { action: 'complete_step', stepKey, ...(changeId === undefined ? {} : { changeId }) },
      (next) => {
        const required = next.requiredStepKeys.includes(stepKey);
        const tail = next.firstOutcome.available
          ? required ? ' Your first result is ready.' : ' Your result was updated.'
          : next.currentStepKey ? ` Next: ${stepCopy(next.currentStepKey).title}.` : '';
        return `Step done: ${stepCopy(stepKey).title}. ${describeProgress(next)}${tail}`;
      },
    );
    if (!view || view.status !== 'active') return;
    if (view.requiredStepKeys.includes(stepKey)) {
      // Show what this step unlocked and one next step. When the first result is ready the ready screen shows it.
      if (!view.firstOutcome.available) setRevealed({ journeyId: view.id, stepKey });
    } else {
      setUpdatedBy({ journeyId: view.id, stepKey });
    }
  }, [journey, transition]);

  const onConfirmed = useCallback((stepKey: string, confirmation: HostedConfirmation) => {
    // Only the form's own saves carry a change id to the journey. The server confirms the step.
    if (stepCopy(stepKey).scopePattern?.test(confirmation.scopeKey)) void advance(stepKey, confirmation.changeId);
  }, [advance]);

  const skip = useCallback((stepKey: string) => {
    if (!journey) return;
    const step = journey.steps.find((item) => item.key === stepKey);
    const outcome = step ? skipOutcomeFor(step) : null;
    void transition(
      journey.id,
      { action: 'skip_step', stepKey },
      () => `Skipped: ${stepCopy(stepKey).title}. ${outcome ? skipEffectText(outcome) : 'Nothing was saved or changed.'}`,
    );
  }, [journey, transition]);

  const pause = () => {
    if (!journey) return;
    setRevealed(null);
    void transition(journey.id, { action: 'pause' }, () => 'Journey paused. Your saved records are unchanged.');
  };
  const resume = () => {
    if (journey) void transition(journey.id, { action: 'resume' }, (view) => `Journey resumed. ${describeProgress(view)}`);
  };
  const finish = () => {
    if (journey) void transition(journey.id, { action: 'complete' }, () => 'Journey finished. Your summary is ready.');
  };
  const answerQuestion = (choice: ClarityAnswer) => {
    if (!journey || answer?.journeyId === journey.id) return;
    setAnswer({ journeyId: journey.id, choice });
    if (choice === 'skipped') {
      setAnnouncement('Question skipped. Nothing was sent.');
      return;
    }
    // Sent only while Product Analytics is on; the client does nothing otherwise, and never throws.
    measurement.clarityResponse({ journeyId: journey.id, response: choice });
    setAnnouncement('Thanks for your answer.');
  };

  const startingOutcome = busy?.kind === 'start' ? busy.desiredOutcome : null;
  const currentKey = journey?.currentStepKey ?? null;
  const stepFailure: JourneyFailure | null = failure && failure.scope === `step:${currentKey}` ? failure : null;
  const startFailure = failure && failure.scope === 'start' ? failure : null;
  const completeFailure = failure && failure.scope === 'complete' ? failure : null;
  const journeyFailure = failure && !stepFailure && !completeFailure && !(journey === null && startFailure) ? failure : null;

  let body: ReactNode = null;
  if (journey === null && !finished) {
    body = (
      <Card className="journey-panel">
        <FocusHeading id="journey-choose-title" headingRef={mainHeading}>Choose what you want to get done</FocusHeading>
        <p className="muted">
          We ask for the least information needed, and tell you why before each request.
        </p>
        <JourneyOutcomeChoice starting={startingOutcome} disabled={busy !== null} onChoose={(outcome) => { void start(outcome); }} />
        <FailureSlot
          failure={startFailure}
          label="Starting your journey"
          onRetry={() => { void retry(); }}
          onDismiss={dismissFailure}
        />
      </Card>
    );
  } else if (journey === null && finished) {
    body = <JourneySummary journey={finished} headingRef={mainHeading} onChooseAnother={clearFinished} />;
  } else if (journey) {
    const copy = outcomeCopy(journey.desiredOutcome);
    const working = busy !== null;
    const showRevealed = revealed !== null && revealed.journeyId === journey.id && !journey.firstOutcome.available;
    const updated = updatedBy !== null && updatedBy.journeyId === journey.id ? stepCopy(updatedBy.stepKey) : null;
    body = (
      <>
        <Card className="journey-panel">
          <h2 className="journey-journey-title">{copy.title}</h2>
          <JourneyProgress journey={journey} />
          {journey.status === 'active' && (
            <div className="journey-actions">
              <button type="button" className="btn ghost" aria-disabled={working || undefined} onClick={() => { if (!working) pause(); }}>
                Pause for now
              </button>
            </div>
          )}
          <FailureSlot
            failure={journeyFailure}
            label="Journey change"
            onRetry={() => { void retry(); }}
            onDismiss={dismissFailure}
          />
        </Card>

        {journey.status === 'paused' ? (
          <Card className="journey-panel">
            <FocusHeading id="journey-paused-title" headingRef={mainHeading}>Your journey is paused</FocusHeading>
            <p>
              Your saved records are unchanged.
              {currentKey ? ` You will continue at: ${stepCopy(currentKey).title}.` : ''}
            </p>
            <div className="journey-actions">
              <button type="button" className="btn primary" aria-disabled={working || undefined} onClick={() => { if (!working) resume(); }}>
                Resume journey
              </button>
            </div>
          </Card>
        ) : journey.firstOutcome.available ? (
          <>
            <Card className="journey-panel" data-reveal="first-outcome">
              <FocusHeading id="journey-ready-title" headingRef={mainHeading}>Your first result is ready</FocusHeading>
              <p>
                This comes from what you saved. {optionalStep && !wrapping
                  ? 'Optional details can only make it more precise, and you can skip them.'
                  : 'Your records are saved either way.'}
              </p>
              <StepOutcome kind={FIRST_OUTCOME_REVEAL[journey.desiredOutcome]} journey={journey} />
              {updated && updated.reveal !== FIRST_OUTCOME_REVEAL[journey.desiredOutcome] && (
                <div className="journey-update" role="group" aria-label={`Updated by ${updated.title}`}>
                  <p className="small"><strong>Updated by “{updated.title}”.</strong></p>
                  <StepOutcome kind={updated.reveal} journey={journey} unlocked={updated.unlocked} />
                </div>
              )}
            </Card>

            {optionalStep && !wrapping ? (
              <section className="journey-step-panel journey-optional" aria-labelledby={STEP_HEADING_ID} key={optionalStep.key}>
                <FocusHeading id={STEP_HEADING_ID} headingRef={followHeading}>{stepCopy(optionalStep.key).title}</FocusHeading>
                <p className="muted">
                  <span className="clarity-badge clarity-tone-info">Optional</span>{' '}
                  {stepCopy(optionalStep.key).summary}
                </p>
                <FailureSlot
                  failure={stepFailure}
                  label={stepCopy(optionalStep.key).title}
                  onRetry={() => { void retry(); }}
                  onDismiss={dismissFailure}
                />
                <JourneyStepHost
                  stepKey={optionalStep.key}
                  journey={journey}
                  onConfirmed={(confirmation) => onConfirmed(optionalStep.key, confirmation)}
                  onCheck={() => { void advance(optionalStep.key); }}
                  checking={busy?.kind === 'transition'}
                  onSkip={() => { if (!working) skip(optionalStep.key); }}
                />
                <div className="journey-actions">
                  <button type="button" className="btn ghost" aria-disabled={working || undefined} onClick={() => { if (!working) setWrappedUp(journey.id); }}>
                    Stop optional steps and finish
                  </button>
                </div>
              </section>
            ) : (
              <Card className="journey-panel" data-stage="finish">
                <FocusHeading id="journey-finish-title" headingRef={followHeading}>Finish your journey</FocusHeading>
                <p>You can finish now. Your saved records stay as they are.</p>
                <ClarityQuestion
                  answer={answer?.journeyId === journey.id ? answer.choice : null}
                  onAnswer={answerQuestion}
                />
                <FailureSlot
                  failure={completeFailure}
                  label="Finishing your journey"
                  onRetry={() => { void retry(); }}
                  onDismiss={dismissFailure}
                />
                <div className="journey-actions">
                  <button type="button" className="btn primary" aria-disabled={working || undefined} onClick={() => { if (!working) finish(); }}>
                    Finish journey
                  </button>
                  <Link className="btn" to={copy.resultRoute}>{copy.resultLabel}</Link>
                </div>
              </Card>
            )}
          </>
        ) : showRevealed && revealed && currentKey ? (
          <Card className="journey-panel" data-reveal="step">
            <FocusHeading id="journey-reveal-title" headingRef={mainHeading}>{`Saved: ${stepCopy(revealed.stepKey).title}`}</FocusHeading>
            {stepCopy(revealed.stepKey).reveal !== 'none' && <p>This unlocked: {stepCopy(revealed.stepKey).unlocked}.</p>}
            <StepRevealBody stepKey={revealed.stepKey} journey={journey} />
            <div className="journey-actions">
              <button type="button" className="btn primary" onClick={() => setRevealed(null)}>
                {`Next: ${stepCopy(currentKey).title}`}
              </button>
            </div>
          </Card>
        ) : currentKey ? (
          <section className="journey-step-panel" aria-labelledby={STEP_HEADING_ID} key={currentKey}>
            <FocusHeading id={STEP_HEADING_ID} headingRef={mainHeading}>{stepCopy(currentKey).title}</FocusHeading>
            <p className="muted">{stepCopy(currentKey).summary} This step is required.</p>
            <FailureSlot
              failure={stepFailure}
              label={stepCopy(currentKey).title}
              onRetry={() => { void retry(); }}
              onDismiss={dismissFailure}
            />
            <JourneyStepHost
              stepKey={currentKey}
              journey={journey}
              onConfirmed={(confirmation) => onConfirmed(currentKey, confirmation)}
              onCheck={() => { void advance(currentKey); }}
              checking={busy?.kind === 'transition'}
            />
          </section>
        ) : (
          <Card className="journey-panel">
            <FocusHeading id="journey-nostep-title" headingRef={mainHeading}>No step is waiting</FocusHeading>
            <p>Your saved records are unchanged.</p>
          </Card>
        )}
      </>
    );
  }

  return (
    <div className="journey-page">
      <header>
        <h1>Guided journey</h1>
        <p className="journey-intro muted">
          One goal, a few steps, and a first result. Your progress is saved, so you can leave and come back.
        </p>
      </header>
      <p role="status" aria-live="polite" className="journey-status small">{announcement}</p>
      {notice && <p role="note" className="small">{notice}</p>}
      <RegionBoundary
        regionKey="guided-journey"
        label="Guided journey"
        hasData={journey !== undefined}
        loading={false}
        error={journey === undefined ? state.loadError : undefined}
        onRetry={state.reload}
        minHeight={200}
      >
        {body}
      </RegionBoundary>
    </div>
  );
}

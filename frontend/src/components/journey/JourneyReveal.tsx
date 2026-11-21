import type { ReactNode } from 'react';
import { buildActionRoute } from '../../clarity/actionContext';
import type { FinancialSnapshot, GoalOutcomeValue, TripOutcomeValue } from '../../clarity/contracts';
import {
  goalIdFromOutcomeId,
  stepCopy,
  tripIdFromOutcomeId,
  type GuidedJourneyView,
  type JourneyRevealKind,
} from '../../clarity/journeys';
import { ActionLink } from '../clarity/ActionLink';
import { formatMoney } from '../clarity/format';
import { ClassifiedValue } from '../clarity/labels';
import { OutcomeCard } from '../clarity/OutcomeCard';
import { RegionBoundary } from '../clarity/RegionBoundary';
import { findGoalOutcome } from '../goals/goalInputs';
import { useGoalList } from '../goals/useGoalChanges';
import { PlanOutcome } from '../plan/PlanOutcome';
import { SpendingOutcome } from '../spending/SpendingOutcome';
import { useJourneySnapshot } from './useJourneySnapshot';

/**
 * The outcome a confirmed step unlocked, read from the server's confirmed
 * snapshot and shown through the shared outcome components. Each card labels its
 * values as entered or calculated, names its period, and offers the same
 * calculation explanation as the page that owns it. Nothing is calculated here.
 */

interface Ctx {
  snapshot: FinancialSnapshot;
  month: string;
  retrying: boolean;
  recalculate: () => void;
}

function SnapshotRegion({ regionKey, label, children }: {
  regionKey: string;
  label: string;
  children: (ctx: Ctx) => ReactNode;
}) {
  const { month, query, snapshot, refresh } = useJourneySnapshot();
  return (
    <RegionBoundary
      regionKey={regionKey}
      label={label}
      hasData={!!snapshot}
      loading={false}
      error={query.isError ? query.error : undefined}
      onRetry={refresh}
      minHeight={160}
    >
      {snapshot && children({ snapshot, month, retrying: query.isFetching, recalculate: refresh })}
    </RegionBoundary>
  );
}

const FEASIBILITY_TEXT: Readonly<Record<GoalOutcomeValue['feasibility'], string>> = Object.freeze({
  feasible: 'Fits inside your monthly savings target',
  not_feasible: 'Does not fit inside your monthly savings target yet',
  funded: 'Fully funded',
  overdue: 'The target date has passed',
  unavailable: 'Add your monthly pay to compare it with your savings target',
});

function GoalReveal({ ctx, outcomeId }: { ctx: Ctx; outcomeId: string | null }) {
  const goals = useGoalList();
  const goalId = goalIdFromOutcomeId(outcomeId);
  const outcome = goalId === null ? ctx.snapshot.outcomes.goals[0] : findGoalOutcome(ctx.snapshot, goalId);
  const goal = goals.data?.find((item) => item.id === (goalId ?? outcome?.value?.goalId));
  const goalsRoute = buildActionRoute({ page: 'goals' });
  if (!outcome) {
    return <p className="muted" role="note">Your goal result is not available yet. Your saved goal is unchanged.</p>;
  }
  return (
    <>
      <OutcomeCard<GoalOutcomeValue>
        key={outcome.id}
        outcome={outcome}
        title={goal?.name ?? 'Your savings goal'}
        headingLevel={3}
        retrying={ctx.retrying}
        onRetry={ctx.recalculate}
        valueSummary={outcome.value
          ? `Funding gap ${formatMoney(outcome.value.fundingGap)}. ${outcome.value.requiredContribution
            ? `Required contribution ${formatMoney(outcome.value.requiredContribution)} a month`
            : 'Required contribution unavailable'}`
          : undefined}
        renderValue={(value) => (
          <div className="journey-values">
            {goal?.targetMinor != null && (
              <ClassifiedValue label="Target amount" classification="entered_fact" value={formatMoney({ currency: 'INR', amountMinor: goal.targetMinor })} />
            )}
            {goal?.savedMinor != null && (
              <ClassifiedValue label="Saved so far" classification="entered_fact" value={formatMoney({ currency: 'INR', amountMinor: goal.savedMinor })} />
            )}
            <ClassifiedValue label="Funding gap" classification="calculated_result" value={formatMoney(value.fundingGap)} emphasis />
            <ClassifiedValue
              label="Required monthly contribution"
              classification="calculated_result"
              value={value.requiredContribution ? formatMoney(value.requiredContribution) : 'Unavailable'}
              emphasis
            />
            <ClassifiedValue label="Feasibility" classification="calculated_result" value={FEASIBILITY_TEXT[value.feasibility]} />
          </div>
        )}
      />
      {goalsRoute && <ActionLink to={goalsRoute} label="Review or revise this goal" showDisclaimer={false} />}
    </>
  );
}

function userBalanceText(label: 'receivable' | 'owed', amountMinor: number): string {
  const amount = formatMoney({ currency: 'INR', amountMinor: Math.abs(amountMinor) });
  return label === 'owed' ? `You owe ${amount}` : `You are owed ${amount}`;
}

function TripReveal({ ctx, outcomeId }: { ctx: Ctx; outcomeId: string | null }) {
  const tripId = tripIdFromOutcomeId(outcomeId);
  const outcome = outcomeId === null ? undefined : ctx.snapshot.outcomes.tripSummary.items?.find((item) => item.id === outcomeId);
  const highlight = ctx.snapshot.highlights?.nearestTripSettlement;
  const mine = highlight && highlight.tripId === tripId ? highlight : null;
  const detailRoute = tripId === null ? null : buildActionRoute({ page: 'trip-detail', params: { tab: 'balances' }, tripId });
  if (!outcome) {
    return <p className="muted" role="note">Your trip result is not available yet. Your saved trip is unchanged.</p>;
  }
  return (
    <>
      <OutcomeCard<TripOutcomeValue>
        key={outcome.id}
        outcome={outcome}
        title={mine ? `Trip balance: ${mine.name}` : 'Your trip balance'}
        headingLevel={3}
        retrying={ctx.retrying}
        onRetry={ctx.recalculate}
        valueSummary={outcome.value
          ? `${outcome.value.balances.length} people with a balance. ${outcome.value.settlements.length} ${outcome.value.settlements.length === 1 ? 'payment' : 'payments'} settle the trip`
          : undefined}
        renderValue={(value) => (
          <div className="journey-values">
            {mine && (
              <ClassifiedValue
                label="Your balance"
                classification="calculated_result"
                value={userBalanceText(mine.label, mine.userBalance.amountMinor)}
                emphasis
              />
            )}
            <ClassifiedValue label="People with a balance" classification="calculated_result" value={String(value.balances.length)} />
            <ClassifiedValue label="Payments that settle the trip" classification="calculated_result" value={String(value.settlements.length)} />
          </div>
        )}
      />
      {detailRoute && <ActionLink to={detailRoute} label="See who pays whom" showDisclaimer={false} />}
    </>
  );
}

export interface StepOutcomeProps {
  kind: JourneyRevealKind;
  journey: GuidedJourneyView;
  /** Plain words for what the step unlocked. Shown when the step has no outcome of its own. */
  unlocked?: string;
}

/** The outcome for one kind, or the plain "what this unlocked" sentence when there is none. */
export function StepOutcome({ kind, journey, unlocked }: StepOutcomeProps) {
  const outcomeId = journey.firstOutcome.outcomeId;
  switch (kind) {
    case 'plan':
      return (
        <SnapshotRegion regionKey="journey-reveal-plan" label="Your plan">
          {(ctx) => (
            <PlanOutcome snapshot={ctx.snapshot} month={ctx.month} updating={false} retrying={ctx.retrying} onRetry={ctx.recalculate} />
          )}
        </SnapshotRegion>
      );
    case 'spending':
      return (
        <SnapshotRegion regionKey="journey-reveal-spending" label="Your spending">
          {(ctx) => (
            <SpendingOutcome snapshot={ctx.snapshot} month={ctx.month} updating={false} retrying={ctx.retrying} onRetry={ctx.recalculate} />
          )}
        </SnapshotRegion>
      );
    case 'goal':
      return (
        <SnapshotRegion regionKey="journey-reveal-goal" label="Your goal">
          {(ctx) => <GoalReveal ctx={ctx} outcomeId={outcomeId} />}
        </SnapshotRegion>
      );
    case 'trip':
      return (
        <SnapshotRegion regionKey="journey-reveal-trip" label="Your trip balance">
          {(ctx) => <TripReveal ctx={ctx} outcomeId={outcomeId} />}
        </SnapshotRegion>
      );
    default:
      return unlocked ? <p className="journey-unlocked" role="note">{unlocked}</p> : null;
  }
}

/** The outcome revealed for a step key, using the step's own registry entry. */
export function StepRevealBody({ stepKey, journey }: { stepKey: string; journey: GuidedJourneyView }) {
  const copy = stepCopy(stepKey);
  return <StepOutcome kind={copy.reveal} journey={journey} unlocked={copy.unlocked} />;
}

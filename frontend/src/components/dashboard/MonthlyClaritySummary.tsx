import { useId, type ReactNode } from 'react';
import type {
  FinancialSnapshot,
  GoalOutcomeValue,
  MonthlyPlanValue,
  MoneyValue,
  Outcome,
  SpendingOutcomeValue,
  TripOutcomeValue,
} from '../../clarity/contracts';
import { FALLBACK_ACTIONS } from '../../clarity/actionContext';
import { actionObservationText } from '../../clarity/actionCopy';
import { monthLabel } from '../../money';
import { ActionLink } from '../clarity/ActionLink';
import { formatMoney, INFORMATIONAL_DISCLAIMER } from '../clarity/format';
import { ClassificationBadge, ClassifiedValue } from '../clarity/labels';
import { OutcomeCard, type OutcomeRetry } from '../clarity/OutcomeCard';
import {
  FEASIBILITY_TEXT,
  correctiveActionFor,
  formatIsoDate,
  goalActionFor,
  tripActionFor,
  type HomeSummaryModel,
} from './homeSummary';
import './monthlyClarity.css';

export interface MonthlyClaritySummaryProps {
  snapshot: FinancialSnapshot;
  /** `selectHomeSummary(snapshot)`, computed once by the page so the header and regions agree. */
  model: HomeSummaryModel;
  /** ID of the outcome whose retry is running, so only that card shows "Retrying". */
  retryingOutcomeId?: string | null;
  /** The one scoped retry. Recalculating re-reads the snapshot, so no input is requested again. */
  onRetry?: (outcomeId: string, retry: OutcomeRetry) => void | Promise<void>;
}

function differenceText(difference: MoneyValue): string {
  if (difference.amountMinor === 0) return 'On target';
  const amount = formatMoney({ currency: 'INR', amountMinor: Math.abs(difference.amountMinor) });
  return difference.amountMinor > 0 ? `${amount} above target` : `${amount} below target`;
}

function MoreProblems({ count, to, label }: { count: number; to: string; label: string }) {
  if (count <= 0) return null;
  return (
    <p className="small muted monthly-clarity-more">
      {count} more {count === 1 ? 'needs' : 'need'} attention. <ActionLink to={to} label={label} showDisclaimer={false} />
    </p>
  );
}

/**
 * Home's single summary of the current position. Every region reads only its own
 * outcome, so one missing, invalid, stale, or failed outcome never hides a sibling.
 * Values are the server's; this component formats and labels them.
 */
export function MonthlyClaritySummary({
  snapshot,
  model,
  retryingOutcomeId = null,
  onRetry,
}: MonthlyClaritySummaryProps) {
  const actionsHeadingId = useId();
  const month = snapshot.period.month;

  const retryFor = onRetry
    ? (outcomeId: string) => (retry: OutcomeRetry) => onRetry(outcomeId, retry)
    : undefined;

  const corrective = (outcome: Outcome<unknown>): ReactNode => {
    const action = correctiveActionFor(outcome);
    return action ? <ActionLink to={action.to} label={action.label} variant="primary" showDisclaimer={false} /> : undefined;
  };

  const card = <T,>(
    outcome: Outcome<T>,
    title: string,
    options: { renderValue?: (value: T) => ReactNode; valueSummary?: string; extra?: ReactNode } = {},
  ) => (
    <OutcomeCard<T>
      key={outcome.id}
      outcome={outcome}
      title={title}
      renderValue={options.renderValue}
      valueSummary={options.valueSummary}
      retrying={retryingOutcomeId === outcome.id}
      onRetry={retryFor?.(outcome.id)}
      correctiveAction={corrective(outcome)}
    />
  );

  const { plan, spending, urgentGoal, nearestTrip } = model;

  const planCard = card<MonthlyPlanValue>(plan, 'Remaining to spend', {
    valueSummary: plan.value
      ? `Remaining spendable ${formatMoney(plan.value.remainingSpendable)}. Daily spending guide ${formatMoney(plan.value.dailySpendingGuide)}`
      : undefined,
    renderValue: (value) => (
      <>
        <ClassifiedValue
          label="Remaining spendable"
          classification="calculated_result"
          value={formatMoney(value.remainingSpendable)}
          emphasis
        />
        <ClassifiedValue
          label="Daily spending guide"
          classification="calculated_result"
          value={formatMoney(value.dailySpendingGuide)}
        />
        <p className="small muted">
          Based on {snapshot.period.daysRemainingInclusive} calendar {snapshot.period.daysRemainingInclusive === 1 ? 'day' : 'days'} left in {monthLabel(month)}, including today.
        </p>
      </>
    ),
  });

  const savingsCard = card<SpendingOutcomeValue>(spending, 'Projected savings vs target', {
    valueSummary: spending.value
      ? `Projected savings ${formatMoney(spending.value.projectedSavings)}, ${differenceText(spending.value.projectedSavingsDifference)}`
      : undefined,
    renderValue: (value) => (
      <>
        <ClassifiedValue
          label="Projected savings"
          classification="calculated_result"
          value={formatMoney(value.projectedSavings)}
          emphasis
        />
        <ClassifiedValue
          label="Savings target"
          classification="calculated_result"
          value={formatMoney(value.savingsTarget)}
        />
        <ClassifiedValue
          label="Difference"
          classification="calculated_result"
          value={differenceText(value.projectedSavingsDifference)}
        />
      </>
    ),
  });

  // Urgent goal region.
  let goalRegion: ReactNode;
  if (urgentGoal) {
    const { highlight, outcome } = urgentGoal;
    const action = goalActionFor(highlight);
    goalRegion = (
      <div className="monthly-clarity-stack" key="urgent-goal">
        <OutcomeCard<GoalOutcomeValue>
          key={outcome.id}
          outcome={outcome}
          title={`Urgent goal: ${highlight.name}`}
          retrying={retryingOutcomeId === outcome.id}
          onRetry={retryFor?.(outcome.id)}
          valueSummary={`Funding gap ${formatMoney(highlight.fundingGap)}`}
          renderValue={(value) => (
            <>
              <ClassifiedValue
                label="Funding gap"
                classification="calculated_result"
                value={formatMoney(highlight.fundingGap)}
                emphasis
              />
              <ClassifiedValue
                label="Required contribution per month"
                classification="calculated_result"
                value={value.requiredContribution ? formatMoney(value.requiredContribution) : 'Not available'}
              />
              <ClassifiedValue label="Target date" classification="entered_fact" value={formatIsoDate(highlight.targetDate)} />
              <p className="small">{FEASIBILITY_TEXT[value.feasibility]}.</p>
              {highlight.status === 'overdue' && (
                <p className="small"><strong>Overdue.</strong> The target date has passed.</p>
              )}
            </>
          )}
        />
        {action && <ActionLink to={action.to} label={action.label} showDisclaimer />}
      </div>
    );
  } else if (model.hasAvailableGoal) {
    goalRegion = (
      <section className="card monthly-clarity-note" aria-label="Goals" key="goals-note">
        <h2 className="clarity-outcome-title">Goals</h2>
        <p>No goal needs a contribution right now.</p>
      </section>
    );
  } else if (model.goalCount === 0) {
    goalRegion = (
      <section className="card monthly-clarity-note" aria-label="Goals" key="goals-none">
        <h2 className="clarity-outcome-title">Goals</h2>
        <p>You have not set a goal yet.</p>
        <ActionLink to="/goals?action=add-goal" label="Add a goal" showDisclaimer={false} />
      </section>
    );
  } else {
    goalRegion = null;
  }
  const firstGoalProblem = model.goalProblems[0];

  // Nearest trip settlement region.
  let tripRegion: ReactNode;
  if (model.tripSummary.status !== 'available') {
    tripRegion = card<TripOutcomeValue[]>(model.tripSummary, 'Nearest trip settlement');
  } else if (nearestTrip) {
    const { highlight, outcome } = nearestTrip;
    const action = tripActionFor(highlight);
    const received = highlight.label === 'receivable';
    const amount = formatMoney({ currency: 'INR', amountMinor: Math.abs(highlight.userBalance.amountMinor) });
    tripRegion = (
      <div className="monthly-clarity-stack" key="nearest-trip">
        <OutcomeCard<TripOutcomeValue>
          key={outcome.id}
          outcome={outcome}
          title={`Nearest trip settlement: ${highlight.name}`}
          retrying={retryingOutcomeId === outcome.id}
          onRetry={retryFor?.(outcome.id)}
          valueSummary={`${received ? 'You are owed' : 'You owe'} ${amount}`}
          renderValue={() => (
            <ClassifiedValue
              label={received ? 'You are owed' : 'You owe'}
              classification="calculated_result"
              value={amount}
              emphasis
            />
          )}
        />
        {action && <ActionLink to={action.to} label={action.label} showDisclaimer />}
      </div>
    );
  } else if (model.tripCount === 0) {
    tripRegion = (
      <section className="card monthly-clarity-note" aria-label="Trips" key="trips-none">
        <h2 className="clarity-outcome-title">Trips</h2>
        <p>You have no trips yet.</p>
        <ActionLink to={FALLBACK_ACTIONS.tripsNew.to} label={FALLBACK_ACTIONS.tripsNew.label} showDisclaimer={false} />
      </section>
    );
  } else {
    tripRegion = (
      <section className="card monthly-clarity-note" aria-label="Trips" key="trips-settled">
        <h2 className="clarity-outcome-title">Trips</h2>
        <p>No trip settlement is pending.</p>
      </section>
    );
  }
  const firstTripProblem = model.tripProblems[0];

  const actionsOffered = model.actions.length > 0;

  return (
    <div className="monthly-clarity" data-testid="monthly-clarity-summary">
      <div className="monthly-clarity-grid">
        <div className="monthly-clarity-region" data-region="monthly-plan">{planCard}</div>
        <div className="monthly-clarity-region" data-region="spending">{savingsCard}</div>
        <div className="monthly-clarity-region" data-region="goal">
          {goalRegion}
          {firstGoalProblem && card<GoalOutcomeValue>(firstGoalProblem, 'Goal needs attention')}
          <MoreProblems count={model.goalProblems.length - 1} to="/goals" label="Open goals" />
        </div>
        <div className="monthly-clarity-region" data-region="trip">
          {tripRegion}
          {firstTripProblem && card<TripOutcomeValue>(firstTripProblem, 'Trip needs attention')}
          <MoreProblems count={model.tripProblems.length - 1} to="/trips" label="Open trips" />
        </div>
      </div>

      <section className="card monthly-clarity-actions" aria-labelledby={actionsHeadingId} data-region="actions">
        <header className="clarity-outcome-header">
          <h2 id={actionsHeadingId} className="clarity-outcome-title">Next actions</h2>
          <ClassificationBadge classification="recommendation" />
        </header>
        {actionsOffered ? (
          <>
            <ol className="clarity-plain-list monthly-clarity-action-list">
              {model.actions.map((insight) => (
                <li key={insight.id}>
                  <p className="monthly-clarity-observation">{actionObservationText(insight)}</p>
                  {insight.shortfall && <p className="small muted">Amount: {formatMoney(insight.shortfall)}</p>}
                  {insight.deadline && <p className="small muted">By {formatIsoDate(insight.deadline)}</p>}
                  <ActionLink insight={insight} showDisclaimer={false} />
                </li>
              ))}
            </ol>
            <p className="clarity-disclaimer small muted">{INFORMATIONAL_DISCLAIMER}</p>
          </>
        ) : model.noActionNeeded ? (
          <p className="monthly-clarity-no-action" role="status">
            <span aria-hidden="true" className="clarity-glyph">✓</span>
            No action is needed for {monthLabel(month)}.
          </p>
        ) : model.rawActionCount > 0 ? (
          <p className="muted small">Recommended actions are temporarily unavailable.</p>
        ) : (
          <p className="muted small">Your next action depends on the items above. Fix them and it will appear here.</p>
        )}
      </section>
    </div>
  );
}

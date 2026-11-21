import { buildActionRoute } from '../../clarity/actionContext';
import { plainOr } from '../../clarity/actionCopy';
import type { FinancialSnapshot, SpendingOutcomeValue } from '../../clarity/contracts';
import { formatSignedChange } from '../../clarity/planInputs';
import { monthLabel } from '../../money';
import { correctiveActionFor } from '../dashboard/homeSummary';
import { ActionLink } from '../clarity/ActionLink';
import { formatMoney } from '../clarity/format';
import { ClassificationBadge, ClassifiedValue } from '../clarity/labels';
import { OutcomeCard, type OutcomeRetry } from '../clarity/OutcomeCard';
import type { ConfirmedSpendingChange } from './useSpendingChanges';
import './spending.css';

export interface SpendingOutcomeProps {
  snapshot: FinancialSnapshot;
  month: string;
  /** An expense or treatment change that affects this month is pending. Last confirmed values stay on screen with "Refreshing" text. */
  updating: boolean;
  retrying: boolean;
  /** Recalculates from the confirmed entries. No input is requested again. */
  onRetry: (retry: OutcomeRetry) => void | Promise<void>;
}

const money = (amountMinor: number) => formatMoney({ currency: 'INR', amountMinor });

function overBy(value: { amountMinor: number }): boolean {
  return value.amountMinor < 0;
}

/**
 * This month's spending decision: remaining spendable, daily guide, projected
 * savings, and any exceeded Needs or Wants budget with its corrective action.
 * Every value is the server's; this component only labels and formats it. A
 * negative remainder is worded as an amount over the budget, never as permission
 * to spend a negative amount.
 */
export function SpendingOutcome({ snapshot, month, updating, retrying, onRetry }: SpendingOutcomeProps) {
  const outcome = snapshot.outcomes.spending;
  const monthName = monthLabel(month);
  const corrective = correctiveActionFor(outcome);
  const days = snapshot.period.daysRemainingInclusive;
  const value = outcome.status === 'available' ? outcome.value : undefined;
  return (
    <>
      <OutcomeCard<SpendingOutcomeValue>
        key={outcome.id}
        outcome={outcome}
        title={`Spending for ${monthName}`}
        refreshing={updating}
        retrying={retrying}
        onRetry={onRetry}
        correctiveAction={corrective
          ? <ActionLink to={corrective.to} label={corrective.label} variant="primary" showDisclaimer={false} />
          : undefined}
        valueSummary={outcome.value
          ? `Remaining spendable ${formatMoney(outcome.value.remainingSpendable)}. Daily spending guide ${formatMoney(outcome.value.dailySpendingGuide)}. Projected savings ${formatMoney(outcome.value.projectedSavings)}`
          : undefined}
        renderValue={(spending) => (
          <div className="spending-values">
            <ClassifiedValue label="Spent so far" classification="calculated_result" value={formatMoney(spending.totalSpending)} />
            <ClassifiedValue label="Spendable budget" classification="calculated_result" value={formatMoney(spending.spendableBudget)} />
            <ClassifiedValue
              label={overBy(spending.remainingSpendable) ? 'Over the spendable budget by' : 'Remaining spendable'}
              classification="calculated_result"
              value={overBy(spending.remainingSpendable) ? money(Math.abs(spending.remainingSpendable.amountMinor)) : formatMoney(spending.remainingSpendable)}
              emphasis
            />
            <ClassifiedValue
              label={overBy(spending.dailySpendingGuide) ? 'Over pace by, a day' : 'Daily spending guide'}
              classification="calculated_result"
              value={overBy(spending.dailySpendingGuide) ? money(Math.abs(spending.dailySpendingGuide.amountMinor)) : formatMoney(spending.dailySpendingGuide)}
              emphasis
            />
            <p className="small muted">
              {overBy(spending.dailySpendingGuide)
                ? `You are past this month’s spendable budget, so there is no daily amount left. Days left in ${monthName}, including today: ${days}.`
                : `The guide divides what is left to spend by the ${days} calendar ${days === 1 ? 'day' : 'days'} left in ${monthName}, including today.`}
            </p>
            <ClassifiedValue label="Needs spent of budget" classification="calculated_result" value={`${formatMoney(spending.needsSpent)} of ${formatMoney(spending.needsBudget)}`} />
            <ClassifiedValue label="Wants spent of budget" classification="calculated_result" value={`${formatMoney(spending.wantsSpent)} of ${formatMoney(spending.wantsBudget)}`} />
            <ClassifiedValue label="Projected savings" classification="calculated_result" value={formatMoney(spending.projectedSavings)} emphasis />
            <ClassifiedValue label="Savings target" classification="calculated_result" value={formatMoney(spending.savingsTarget)} />
            <ClassifiedValue
              label="Projected savings compared with target"
              classification="calculated_result"
              value={formatSignedChange(spending.projectedSavingsDifference.amountMinor, money)}
            />
          </div>
        )}
      />
      {value?.exceededBudgetActions.map((action) => {
        const bucket = action.bucket === 'needs' ? 'Needs' : 'Wants';
        const to = buildActionRoute({ page: 'spending', action: 'review-budget', params: { bucket: action.bucket } });
        return (
          <section key={action.bucket} className="spending-excess" aria-label={`${bucket} budget exceeded`} data-bucket={action.bucket}>
            <p>
              <strong>{bucket} budget exceeded by {money(action.excessMinor)}.</strong>{' '}
              You have spent {money(action.spentMinor)} of {money(action.budgetMinor)}.
            </p>
            <p className="small">
              <ClassificationBadge classification="recommendation" /> {plainOr(action.correctiveAction, `Review ${bucket} spending to bring it back within budget.`)}
            </p>
            {to
              ? <ActionLink to={to} label={plainOr(action.actionLabel, `Review ${bucket} spending`)} variant="primary" showDisclaimer />
              : null}
          </section>
        );
      })}
    </>
  );
}

export interface SpendingChangeNoticeProps {
  change: ConfirmedSpendingChange;
  onDismiss: () => void;
}

/** What a confirmed expense or treatment change did, and which months were recalculated. */
export function SpendingChangeNotice({ change, onDismiss }: SpendingChangeNoticeProps) {
  return (
    <section className="card spending-change" aria-label="Latest change to your spending">
      <div role="status">
        <p><strong>{change.label}.</strong> {change.text}</p>
      </div>
      <button type="button" className="btn ghost sm" aria-label="Dismiss spending change" onClick={onDismiss}>
        Dismiss
      </button>
    </section>
  );
}

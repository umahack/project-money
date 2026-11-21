import { FALLBACK_ACTIONS, resolveInsightAction } from '../../clarity/actionContext';
import type { FinancialSnapshot, MonthlyPlanValue } from '../../clarity/contracts';
import { formatSignedChange } from '../../clarity/planInputs';
import { monthLabel } from '../../money';
import { correctiveActionFor } from '../dashboard/homeSummary';
import { ActionLink } from '../clarity/ActionLink';
import { formatMoney } from '../clarity/format';
import { ClassifiedValue } from '../clarity/labels';
import { OutcomeCard, type OutcomeRetry } from '../clarity/OutcomeCard';
import type { ConfirmedPlanChange } from './ClarityPlanInputs';
import './plan.css';

export interface PlanOutcomeProps {
  snapshot: FinancialSnapshot;
  month: string;
  /** A salary or bill change is pending. Last confirmed values stay on screen with "Refreshing" text. */
  updating: boolean;
  retrying: boolean;
  /** Recalculates from the confirmed inputs. No input is requested again. */
  onRetry: (retry: OutcomeRetry) => void | Promise<void>;
}

/**
 * The exact-month monthly plan. Every value is the server's; this component only
 * labels and formats it. The shortfall and its bill-review action come from the
 * server's `shortfall` value and ranked `review_bills` action.
 */
export function PlanOutcome({ snapshot, month, updating, retrying, onRetry }: PlanOutcomeProps) {
  const outcome = snapshot.outcomes.monthlyPlan;
  const monthName = monthLabel(month);
  const corrective = correctiveActionFor(outcome);
  const reviewAction = snapshot.actions
    .map((insight) => resolveInsightAction(insight))
    .find((insight) => insight?.actionKey === 'review_bills') ?? null;
  const value = outcome.status === 'available' ? outcome.value : undefined;
  const hasShortfall = !!value && value.shortfall.amountMinor > 0;

  return (
    <>
      <OutcomeCard<MonthlyPlanValue>
        key={outcome.id}
        outcome={outcome}
        title={`Your plan for ${monthName}`}
        refreshing={updating}
        retrying={retrying}
        onRetry={onRetry}
        correctiveAction={corrective
          ? <ActionLink to={corrective.to} label={corrective.label} variant="primary" showDisclaimer={false} />
          : undefined}
        valueSummary={outcome.value
          ? `Disposable income ${formatMoney(outcome.value.disposableIncome)}. Daily spending guide ${formatMoney(outcome.value.dailySpendingGuide)}`
          : undefined}
        renderValue={(plan) => (
          <div className="plan-values">
            <ClassifiedValue label={`Pay for ${monthName}`} classification="entered_fact" value={formatMoney(plan.salary)} />
            <ClassifiedValue label={`Bills counted in ${monthName}`} classification="calculated_result" value={formatMoney(plan.activeBillsTotal)} />
            {plan.shortfall.amountMinor > 0 && (
              <ClassifiedValue label="Bills above pay (shortfall)" classification="calculated_result" value={formatMoney(plan.shortfall)} />
            )}
            <ClassifiedValue label="Disposable income" classification="calculated_result" value={formatMoney(plan.disposableIncome)} emphasis />
            <ClassifiedValue label="Needs budget (50%)" classification="calculated_result" value={formatMoney(plan.needsBudget)} />
            <ClassifiedValue label="Wants budget (30%)" classification="calculated_result" value={formatMoney(plan.wantsBudget)} />
            <ClassifiedValue label="Savings target (20%)" classification="calculated_result" value={formatMoney(plan.savingsTarget)} />
            <ClassifiedValue label="Spendable budget" classification="calculated_result" value={formatMoney(plan.spendableBudget)} />
            <ClassifiedValue label="Remaining spendable" classification="calculated_result" value={formatMoney(plan.remainingSpendable)} />
            <ClassifiedValue label="Daily spending guide" classification="calculated_result" value={formatMoney(plan.dailySpendingGuide)} emphasis />
            <p className="small muted">
              The guide divides what is left to spend by the {snapshot.period.daysRemainingInclusive} calendar {snapshot.period.daysRemainingInclusive === 1 ? 'day' : 'days'} left in {monthName}, including today.
            </p>
            <ClassifiedValue label="Projected savings" classification="calculated_result" value={formatMoney(plan.projectedSavings)} />
          </div>
        )}
      />
      {value && (hasShortfall || reviewAction) && (
        <section className="plan-shortfall" aria-label="Bill review">
          <p>
            <strong>
              {hasShortfall
                ? `Your bills are ${formatMoney(value.shortfall)} more than your pay for ${monthName}.`
                : `Your bills use all of your pay for ${monthName}.`}
            </strong>
          </p>
          {reviewAction
            ? <ActionLink insight={reviewAction} variant="primary" />
            : <ActionLink to={FALLBACK_ACTIONS.planAddBills.to} label="Review monthly bills" variant="primary" showDisclaimer={false} />}
        </section>
      )}
    </>
  );
}

export interface PlanChangeNoticeProps {
  change: ConfirmedPlanChange;
  onDismiss: () => void;
}

/** The change in disposable income and daily guide after a confirmed salary or bill change. */
export function PlanChangeNotice({ change, onDismiss }: PlanChangeNoticeProps) {
  const { deltas } = change;
  const money = (minor: number) => formatMoney({ currency: 'INR', amountMinor: minor });
  const monthName = deltas ? monthLabel(deltas.month) : 'this month';
  return (
    <section className="card plan-change" aria-label="Latest change to your plan">
      <div role="status">
        <p><strong>{change.label}.</strong> Your plan for {monthName} was recalculated.</p>
        {deltas?.status === 'available' ? (
          <div className="plan-change-lines">
            <ClassifiedValue
              label={`Disposable income change for ${monthName}`}
              classification="calculated_result"
              value={formatSignedChange(deltas.disposableIncomeMinor, money)}
            />
            <ClassifiedValue
              label={`Daily spending guide change for ${monthName}`}
              classification="calculated_result"
              value={formatSignedChange(deltas.dailySpendingGuideMinor, money)}
            />
          </div>
        ) : (
          <p className="small muted">{deltas?.reason ?? 'The change in your plan is not available.'}</p>
        )}
      </div>
      <button
        type="button"
        className="btn ghost sm"
        aria-label="Dismiss plan change"
        onClick={onDismiss}
      >
        Dismiss
      </button>
    </section>
  );
}

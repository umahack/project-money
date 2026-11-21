import type { ReactNode } from 'react';
import { FALLBACK_ACTIONS } from '../../clarity/actionContext';
import type { GoalOutcomeValue, Outcome } from '../../clarity/contracts';
import { monthLabel } from '../../money';
import { ActionLink } from '../clarity/ActionLink';
import { INFORMATIONAL_DISCLAIMER, formatMoney } from '../clarity/format';
import { ClassificationBadge, ClassifiedValue } from '../clarity/labels';
import { OutcomeCard, type OutcomeRetry } from '../clarity/OutcomeCard';
import { correctionPrompt, displayDate, invalidGoalFields, type GoalField, type GoalView } from './goalInputs';
import './goals.css';

const STATUS_TEXT: Readonly<Record<GoalOutcomeValue['status'], string>> = Object.freeze({
  funded: 'Funded',
  active: 'Active',
  overdue: 'Overdue',
});

export interface GoalOutcomeCardProps {
  goal: GoalView;
  outcome: Outcome<GoalOutcomeValue>;
  month: string;
  /** The server's current local date. */
  today: string;
  /** A change to this goal is pending. Last confirmed values stay on screen with "Refreshing" text. */
  refreshing: boolean;
  /** The one retry for this outcome is running. */
  retrying: boolean;
  onRetry: (retry: OutcomeRetry) => void | Promise<void>;
  /** The accept-revision action is not available while a change to this goal is pending. */
  busy: boolean;
  onAcceptRevision: (revision: NonNullable<GoalOutcomeValue['revision']>) => void;
  /** Opens the correction form for this goal. */
  onRevise: (field?: GoalField) => void;
}

function summaryOf(goal: GoalView, value: GoalOutcomeValue): string {
  const parts = [`${goal.name}: ${STATUS_TEXT[value.status]}`, `Funding gap ${formatMoney(value.fundingGap)}`];
  parts.push(value.requiredContribution
    ? `Required contribution ${formatMoney(value.requiredContribution)} a month`
    : 'Required contribution unavailable');
  return parts.join('. ');
}

function Feasibility({ goal, value, month }: { goal: GoalView; value: GoalOutcomeValue; month: string }): ReactNode {
  let body: ReactNode;
  switch (value.feasibility) {
    case 'feasible':
      body = (
        <>
          <p><strong>Feasible.</strong> The required contribution fits inside your monthly savings target.</p>
          {value.capacityDifference && (
            <p>
              Remaining monthly savings capacity: <span className="mono">{formatMoney(value.capacityDifference)}</span>
            </p>
          )}
        </>
      );
      break;
    case 'not_feasible':
      body = (
        <>
          <p><strong>Not feasible yet.</strong> The required contribution is more than your monthly savings target.</p>
          {value.capacityDifference && (
            <p>
              Over your savings target by: <span className="mono">{formatMoney(value.capacityDifference)}</span> a month
            </p>
          )}
        </>
      );
      break;
    case 'funded':
      body = <p><strong>Fully funded.</strong> No monthly contribution is needed.</p>;
      break;
    case 'overdue':
      body = (
        <p>
          <strong>Target date passed.</strong> Feasibility is unavailable until you revise the target amount or the target date.
        </p>
      );
      break;
    default: {
      const input = value.missingPlanInput;
      const action = input === 'bills' ? FALLBACK_ACTIONS.planAddBills : FALLBACK_ACTIONS.planSetPay;
      body = (
        <>
          <p>
            <strong>Feasibility unavailable.</strong>{' '}
            {input === 'bills'
              ? `Add your monthly bills for ${monthLabel(month)} to compare ${goal.name} with your savings target.`
              : input === 'salary'
                ? `Add your monthly pay for ${monthLabel(month)} to compare ${goal.name} with your savings target.`
                : 'Your monthly plan is not complete yet.'}
          </p>
          {input && <ActionLink to={action.to} label={action.label} showDisclaimer={false} />}
        </>
      );
    }
  }
  return (
    <div className="goal-feasibility" role="group" aria-label={`Feasibility for ${goal.name}`} data-feasibility={value.feasibility}>
      {body}
    </div>
  );
}

function Revision({ goal, value, busy, onAccept, onRevise }: {
  goal: GoalView;
  value: GoalOutcomeValue;
  busy: boolean;
  onAccept: GoalOutcomeCardProps['onAcceptRevision'];
  onRevise: GoalOutcomeCardProps['onRevise'];
}): ReactNode {
  if (value.feasibility === 'overdue') {
    return (
      <div className="goal-revision" role="group" aria-label={`Revision needed for ${goal.name}`}>
        <p>
          <strong>Revise this goal.</strong> Choose a new target amount or a new target date to see the contribution it needs.
        </p>
        <button type="button" className="btn sm" aria-label={`Revise target for ${goal.name}`} onClick={() => onRevise('date')}>
          Revise target
        </button>
      </div>
    );
  }
  if (value.feasibility !== 'not_feasible') return null;
  const { revision } = value;
  if (!revision || (!revision.targetAmount && !revision.targetDate)) {
    return (
      <div className="goal-revision" role="group" aria-label={`Revision for ${goal.name}`}>
        <p>
          No revised target amount fits your savings target by this date. Choose a later target date.
        </p>
        <button type="button" className="btn sm" aria-label={`Revise target date for ${goal.name}`} onClick={() => onRevise('date')}>
          Revise target date
        </button>
      </div>
    );
  }
  return (
    <div className="goal-revision" role="group" aria-label={`Suggested revision for ${goal.name}`}>
      <p>
        <ClassificationBadge classification="recommendation" />{' '}
        {revision.targetAmount && (
          <>Revised target amount: <strong className="mono">{formatMoney(revision.targetAmount)}</strong>. </>
        )}
        {revision.targetDate && (
          <>Revised target date: <strong>{displayDate(revision.targetDate)}</strong>. </>
        )}
        With this change the required monthly contribution fits inside your savings target.
      </p>
      <p className="small muted">{INFORMATIONAL_DISCLAIMER}</p>
      <div className="goal-actions">
        <button
          type="button"
          className="btn sm primary"
          aria-disabled={busy || undefined}
          aria-label={`Accept revision for ${goal.name}`}
          onClick={() => { if (!busy) onAccept(revision); }}
        >
          Accept revision
        </button>
        <button type="button" className="btn sm ghost" aria-label={`Choose my own revision for ${goal.name}`} onClick={() => onRevise()}>
          Choose my own
        </button>
      </div>
    </div>
  );
}

/**
 * One goal's server-calculated outcome: status, funding gap, inclusive
 * contribution months, required contribution, feasibility, and at most one
 * revision. A goal the server cannot calculate shows what to correct and where,
 * and its stored values are never rewritten. Every number is the server's; this
 * component only labels and formats it.
 */
export function GoalOutcomeCard({
  goal,
  outcome,
  month,
  today,
  refreshing,
  retrying,
  onRetry,
  busy,
  onAcceptRevision,
  onRevise,
}: GoalOutcomeCardProps) {
  const value = outcome.status === 'available' ? outcome.value : undefined;
  const invalid = invalidGoalFields(outcome);
  const [firstInvalid] = invalid;
  return (
    <OutcomeCard<GoalOutcomeValue>
      key={outcome.id}
      outcome={outcome}
      title={goal.name}
      headingLevel={4}
      refreshing={refreshing}
      retrying={retrying}
      onRetry={onRetry}
      className="goal-outcome"
      valueSummary={outcome.value ? summaryOf(goal, outcome.value) : undefined}
      correctiveAction={outcome.status === 'invalid_input' ? (
        <div className="goal-correction">
          {invalid.map((field) => <p key={field}>{correctionPrompt(field, today)}</p>)}
          <button
            type="button"
            className="btn sm primary"
            aria-label={`Correct this goal: ${goal.name}`}
            onClick={() => onRevise(firstInvalid)}
          >
            Correct this goal
          </button>
        </div>
      ) : undefined}
      renderValue={(v) => (
        <div className="goal-values">
          <ClassifiedValue label="Goal status" classification="calculated_result" value={STATUS_TEXT[v.status]} />
          <ClassifiedValue
            label="Target amount"
            classification="entered_fact"
            value={goal.targetMinor === null ? '—' : formatMoney({ currency: 'INR', amountMinor: goal.targetMinor })}
          />
          <ClassifiedValue
            label="Saved so far"
            classification="entered_fact"
            value={goal.savedMinor === null ? '—' : formatMoney({ currency: 'INR', amountMinor: goal.savedMinor })}
          />
          <ClassifiedValue
            label="Target date"
            classification="entered_fact"
            value={goal.targetDate ? displayDate(goal.targetDate) : 'Not set'}
          />
          <ClassifiedValue label="Funding gap" classification="calculated_result" value={formatMoney(v.fundingGap)} emphasis />
          <ClassifiedValue
            label="Monthly contribution opportunities"
            classification="calculated_result"
            value={String(v.contributionOpportunities)}
          />
          {v.contributionOpportunities > 0 && (
            <p className="small muted">This month and the target month are both counted.</p>
          )}
          <ClassifiedValue
            label="Required monthly contribution"
            classification="calculated_result"
            value={v.requiredContribution ? formatMoney(v.requiredContribution) : 'Unavailable'}
            emphasis
          />
          {!v.requiredContribution && (
            <p className="small muted">The target date has passed, so there is no monthly amount to show.</p>
          )}
          <Feasibility goal={goal} value={v} month={month} />
          {value && <Revision goal={goal} value={v} busy={busy} onAccept={onAcceptRevision} onRevise={onRevise} />}
        </div>
      )}
    />
  );
}

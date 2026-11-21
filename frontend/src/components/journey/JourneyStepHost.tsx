import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { buildActionRoute } from '../../clarity/actionContext';
import {
  skipOutcomeFor,
  stepCopy,
  tripIdFromOutcomeId,
  type GuidedJourneyView,
  type JourneyStepView,
} from '../../clarity/journeys';
import type { PurposeOutcomeKey } from '../../clarity/purposeRegistry';
import { RegionBoundary } from '../clarity/RegionBoundary';
import { ClaritySavingsGoals } from '../goals/ClaritySavingsGoals';
import { ClarityPlanInputs, type OptionalInput } from '../plan/ClarityPlanInputs';
import { CategoryTotals } from '../spending/CategoryTotals';
import { ClaritySpendingTracker } from '../spending/ClaritySpendingTracker';
import { useExpenseList, useSpendingChanges } from '../spending/useSpendingChanges';
import { JourneyOptionalPurpose } from './JourneyParts';
import { useJourneySnapshot } from './useJourneySnapshot';

/** A change the server confirmed inside a hosted form. It carries ids only, never a value. */
export interface HostedConfirmation {
  scopeKey: string;
  changeId: number;
}

export interface JourneyStepHostProps {
  stepKey: string;
  /** The journey as the server last returned it. Hosts read ids from it and never change it. */
  journey: GuidedJourneyView;
  /** Called after a hosted form's change is confirmed by the server. */
  onConfirmed: (confirmation: HostedConfirmation) => void;
  /** Asks the server whether the step is now satisfied. Used for steps saved on another page. */
  onCheck: () => void;
  checking: boolean;
  /** Optional steps only. Resolves the prompt without saving anything. */
  onSkip?: () => void;
}

/**
 * The pay or bills form of the Plan page, hosted as it is there. In an optional
 * step the same form is shown as optional with a skip that saves nothing.
 */
function PlanFormHost({ only, onConfirmed, optional }: Pick<JourneyStepHostProps, 'onConfirmed'> & {
  only: 'salary' | 'bills';
  optional?: OptionalInput;
}) {
  const { month, query, snapshot, refresh } = useJourneySnapshot();
  return (
    <RegionBoundary
      regionKey={`journey-${only}`}
      label={only === 'salary' ? 'Pay form' : 'Bills form'}
      hasData={!!snapshot}
      loading={false}
      error={query.isError ? query.error : undefined}
      onRetry={refresh}
      minHeight={200}
    >
      {snapshot && (
        <ClarityPlanInputs
          only={only}
          optional={optional}
          month={month}
          snapshot={snapshot}
          onConfirmed={(change) => onConfirmed({ scopeKey: change.scopeKey, changeId: change.changeId })}
          onRefresh={refresh}
        />
      )}
    </RegionBoundary>
  );
}

function ExpenseStepHost({ onConfirmed }: Pick<JourneyStepHostProps, 'onConfirmed'>) {
  const { month, query, snapshot, refresh } = useJourneySnapshot();
  return (
    <RegionBoundary
      regionKey="journey-expense"
      label="Expense form"
      hasData={!!snapshot}
      loading={false}
      error={query.isError ? query.error : undefined}
      onRetry={refresh}
      minHeight={200}
    >
      {snapshot && (
        <ClaritySpendingTracker
          month={month}
          snapshot={snapshot}
          onConfirmed={(change) => onConfirmed({ scopeKey: change.scopeKey, changeId: change.changeId })}
          onRefresh={refresh}
        />
      )}
    </RegionBoundary>
  );
}

const NO_ARRIVAL = { action: null, key: '' } as const;

function GoalStepHost({ onConfirmed }: Pick<JourneyStepHostProps, 'onConfirmed'>) {
  const { month, query, snapshot, refresh } = useJourneySnapshot();
  const [recalculating, setRecalculating] = useState(false);
  const { refetch } = query;
  // Recalculation re-reads the confirmed snapshot. Saved goals stay in their list.
  const recalculate = useCallback(async () => {
    setRecalculating(true);
    try {
      await refetch();
    } finally {
      setRecalculating(false);
    }
  }, [refetch]);
  return (
    <ClaritySavingsGoals
      month={month}
      snapshot={snapshot}
      snapshotLoading={query.isFetching}
      snapshotError={query.isError ? query.error : undefined}
      arrival={NO_ARRIVAL}
      onRefresh={refresh}
      onRecalculate={recalculate}
      recalculating={recalculating}
      onConfirmed={onConfirmed}
    />
  );
}

/**
 * Category treatment is chosen on the category list the Spending page shows. The
 * same list is hosted here with its own scoped status and retry per category.
 */
function TreatmentStepHost({ step, onConfirmed, onSkip }: Pick<JourneyStepHostProps, 'onConfirmed'> & {
  step: JourneyStepView;
  onSkip: () => void;
}) {
  const { month, query, snapshot, refresh } = useJourneySnapshot();
  const list = useExpenseList(month);
  const changes = useSpendingChanges({
    month,
    list,
    onConfirmed: (change) => onConfirmed({ scopeKey: change.scopeKey, changeId: change.changeId }),
    onRefresh: refresh,
  });
  const copy = stepCopy(step.key);
  return (
    <>
      <JourneyOptionalPurpose
        stepKey={step.key}
        purpose={copy.purpose ?? copy.summary}
        outcome={skipOutcomeFor(step) ?? 'daily_spending_guide'}
        onSkip={onSkip}
      />
      <RegionBoundary
        regionKey="journey-treatment"
        label="Category list"
        hasData={!!snapshot}
        loading={false}
        error={query.isError ? query.error : undefined}
        onRetry={refresh}
        minHeight={160}
      >
        {snapshot && <CategoryTotals snapshot={snapshot} month={month} changes={changes} />}
      </RegionBoundary>
    </>
  );
}

/**
 * Trip steps are saved on the existing Trips pages, whose forms navigate between
 * routes and are not embedded here. This links to them with plain text and asks
 * the server whether the step is now satisfied. The server decides; nothing is
 * entered or copied in this panel. Every link comes from the fixed action
 * registry, so no value or name ever appears in an address. The trip pages link
 * back here while the journey is open.
 */
function TripStepHost({ stepKey, journey, onCheck, checking, onSkip }: Pick<JourneyStepHostProps, 'stepKey' | 'journey' | 'onCheck' | 'checking' | 'onSkip'>) {
  const copy = stepCopy(stepKey);
  const step = journey.steps.find((item) => item.key === stepKey);
  const tripId = tripIdFromOutcomeId(journey.firstOutcome.outcomeId);
  const tripsList = buildActionRoute({ page: 'trips' }) ?? '/trips';
  const personal = stepKey === 'personal_expense';
  const where = stepKey === 'trip'
    ? { to: buildActionRoute({ page: 'trips', action: 'new-trip' }) ?? tripsList, label: 'Open Trips to create your trip' }
    : personal
      ? {
        to: (tripId === null ? null : buildActionRoute({ page: 'trip-detail', params: { tab: 'expenses' }, tripId })) ?? tripsList,
        label: 'Open your trip to include your share',
      }
      : stepKey === 'trip_members'
        ? { to: tripsList, label: 'Open Trips to add the people' }
        : { to: tripsList, label: 'Open Trips to add a shared expense' };
  return (
    <>
      {personal && step && onSkip && (
        <JourneyOptionalPurpose
          stepKey={stepKey}
          purpose={copy.purpose ?? copy.summary}
          outcome={skipOutcomeFor(step) ?? 'remaining_spendable_budget'}
          onSkip={onSkip}
        />
      )}
      <section className="card journey-trip-step" aria-label={copy.title}>
        <p>
          {stepKey === 'trip' && 'Create the trip on the Trips page. Your journey is saved, so you can come back here afterwards.'}
          {stepKey === 'trip_members' && 'Open your trip, choose the People tab, and add everyone who shared costs. At least two people are needed.'}
          {stepKey === 'trip_split' && 'Open your trip and add one shared expense. Choose who paid and how it is split.'}
          {personal && 'Open your trip, go to the Expenses tab, and choose to include your share of a shared expense in your monthly spending.'}
        </p>
        <div className="row journey-actions">
          <Link className="btn primary" to={where.to}>{where.label}</Link>
          <button type="button" className="btn" aria-disabled={checking || undefined} onClick={() => { if (!checking) onCheck(); }}>
            {checking ? 'Checking…' : 'I did this. Check my progress'}
          </button>
        </div>
      </section>
    </>
  );
}

/**
 * Renders the existing component that owns a step's input. Each step has its
 * own scoped mutation, purpose and preview text, data-use gate, and field errors
 * because those belong to the hosted component, not to the journey. Optional
 * steps add a skip that calls `onSkip` and saves nothing.
 */
export function JourneyStepHost({ stepKey, journey, onConfirmed, onCheck, checking, onSkip }: JourneyStepHostProps) {
  const step = journey.steps.find((item) => item.key === stepKey);
  switch (stepCopy(stepKey).host) {
    case 'salary':
      return <PlanFormHost only="salary" onConfirmed={onConfirmed} />;
    case 'expense':
      return <ExpenseStepHost onConfirmed={onConfirmed} />;
    case 'goal':
      return <GoalStepHost onConfirmed={onConfirmed} />;
    case 'trip':
      return <TripStepHost stepKey={stepKey} journey={journey} onCheck={onCheck} checking={checking} />;
    case 'bills':
      return onSkip ? <PlanFormHost only="bills" onConfirmed={onConfirmed} optional={{ onSkip, skipped: false }} /> : null;
    case 'pay_optional': {
      if (!onSkip) return null;
      const outcome = (step && skipOutcomeFor(step)) ?? 'goal_feasibility';
      return (
        <PlanFormHost
          only="salary"
          onConfirmed={onConfirmed}
          optional={{ skipOutcome: outcome as PurposeOutcomeKey, onSkip, skipped: false }}
        />
      );
    }
    case 'treatment':
      return step && onSkip ? <TreatmentStepHost step={step} onConfirmed={onConfirmed} onSkip={onSkip} /> : null;
    case 'personal_share':
      return <TripStepHost stepKey={stepKey} journey={journey} onCheck={onCheck} checking={checking} onSkip={onSkip} />;
    default:
      return (
        <p className="muted" role="note">
          This step is not available in this version of the app. Your other steps and records are unchanged.
        </p>
      );
  }
}

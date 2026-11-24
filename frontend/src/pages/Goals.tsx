import { useCallback, useState } from 'react';
import { ClarityPageHeader } from '../components/clarity/ClarityPageHeader';
import { SavingsGoals } from '../components/SavingsGoals';
import { FALLBACK_ACTIONS, PAGE_DECISIONS } from '../clarity/actionContext';
import { useFinancialClarity } from '../clarity/FinancialClarityProvider';
import { selectFinancialClarityRollout } from '../clarity/rollout';
import { useActionArrival } from '../clarity/useActionArrival';
import { useClaritySnapshotQuery } from '../clarity/useClaritySnapshot';
import { useHeaderAction } from '../clarity/useHeaderAction';
import { useKolkataMonth } from '../clarity/quickAdd/kolkata';
import { monthLabel } from '../money';

/**
 * Goals. With `VITE_FINANCIAL_CLARITY_ENABLED` off this is the legacy page,
 * unchanged. With it on, every goal outcome comes from the server's snapshot and
 * each goal change saves on its own.
 */
export function Goals() {
  return selectFinancialClarityRollout().enabled ? <ClarityGoals /> : <LegacyGoals />;
}

// ROLLBACK-ONLY: the flag-off Goals page. Clarity code must not use it (src/clarity/rollbackBoundary.test.ts).
function LegacyGoals() {
  // Scrolls to and focuses the goal or goal form named by the link that opened this page.
  useActionArrival('goals');
  const rankedAction = useHeaderAction('goals');
  return (
    <>
      <ClarityPageHeader
        legacy={{
          title: 'Goals 🎯',
          sub: 'Set a target, add to it when you can, watch the bar fill. Negative contributions let you record withdrawals too.',
        }}
        title="Goals"
        decision={PAGE_DECISIONS.goals}
        action={rankedAction}
        fallbackAction={FALLBACK_ACTIONS.goalsContribute}
      />
      <SavingsGoals />
    </>
  );
}

function ClarityGoals() {
  const month = useKolkataMonth();
  // Scrolls to and focuses the goal named by the link that opened this page. The goal opens its own form when the link asks for one.
  const arrival = useActionArrival('goals');
  const rankedAction = useHeaderAction('goals');
  const query = useClaritySnapshotQuery(month);
  const view = useFinancialClarity(month);
  // Newest confirmed snapshot with pending patches. The query covers the moment between a response and the store install.
  const snapshot = view.snapshot ?? query.data;
  const [recalculating, setRecalculating] = useState(false);
  const { refetch } = query;

  const refresh = useCallback(() => {
    void refetch();
  }, [refetch]);

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
    <>
      <ClarityPageHeader
        legacy={{ title: 'Goals 🎯' }}
        title="Goals"
        decision={PAGE_DECISIONS.goals}
        action={rankedAction}
        fallbackAction={FALLBACK_ACTIONS.goalsContribute}
        right={<span className="pill info">{monthLabel(month)}</span>}
      />
      <SavingsGoals
        month={month}
        snapshot={snapshot}
        snapshotLoading={query.isFetching}
        snapshotError={query.isError ? query.error : undefined}
        arrival={{ action: arrival.action, goalId: arrival.params.goalId, key: arrival.arrivalKey }}
        onRefresh={refresh}
        onRecalculate={recalculate}
        recalculating={recalculating}
      />
    </>
  );
}

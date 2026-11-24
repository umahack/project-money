import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Card } from '../components/ui';
import { ClarityPageHeader } from '../components/clarity/ClarityPageHeader';
import { RegionBoundary } from '../components/clarity/RegionBoundary';
import { SpendingTracker } from '../components/SpendingTracker';
import { SpendingChangeNotice, SpendingOutcome } from '../components/spending/SpendingOutcome';
import type { ConfirmedSpendingChange } from '../components/spending/useSpendingChanges';
import { MonthlyHistoryChart } from '../components/MonthlyHistoryChart';
import { SmartInsights } from '../components/SmartInsights';
import { FALLBACK_ACTIONS, PAGE_DECISIONS } from '../clarity/actionContext';
import { useFinancialClarity } from '../clarity/FinancialClarityProvider';
import { subscribeToExpenseChanges } from '../clarity/quickAdd/expenseEvents';
import { expenseChangeTouchesMonth } from '../clarity/spendingInputs';
import { selectFinancialClarityRollout, selectQuickAddEnabled } from '../clarity/rollout';
import { useActionArrival } from '../clarity/useActionArrival';
import { useClaritySnapshotQuery } from '../clarity/useClaritySnapshot';
import { useHeaderAction } from '../clarity/useHeaderAction';
import { useKolkataMonth } from '../clarity/quickAdd/kolkata';
import { monthLabel } from '../money';
import { errText, useToast } from '../state';
import type { Plan } from '../types';

/**
 * Spending. With `VITE_FINANCIAL_CLARITY_ENABLED` off this is the legacy page,
 * unchanged. With it on, every total and outcome comes from the server's
 * snapshot and each expense or treatment change saves on its own.
 */
export function Spending() {
  return selectFinancialClarityRollout().enabled ? <ClaritySpending /> : <LegacySpending />;
}

// ROLLBACK-ONLY: the flag-off Spending page. Clarity code must not use it (src/clarity/rollbackBoundary.test.ts).
function LegacySpending() {
  const { toast } = useToast();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Scrolls to and focuses the expense form or category budgets named by the link that opened this page.
  useActionArrival('spending');
  const rankedAction = useHeaderAction('spending');

  const load = useCallback(async () => {
    try {
      setPlan(await api.get<Plan>('/finance/plan'));
    } catch (e) {
      toast('err', errText(e));
    }
  }, [toast]);

  useEffect(() => { void load(); }, [load, reloadKey]);

  if (!plan) {
    return (
      <>
        <ClarityPageHeader
          legacy={{ title: 'Spending 📊', sub: "Pulling this month's log…" }}
          title="Spending"
          decision={PAGE_DECISIONS.spending}
          action={rankedAction}
          fallbackAction={FALLBACK_ACTIONS.spendingRecord}
        />
        <Card><div style={{ height: 20, width: 240, background: 'rgba(0,0,0,0.07)', borderRadius: 6, marginBottom: 10 }} /><div style={{ height: 14, width: 180, background: 'rgba(0,0,0,0.05)', borderRadius: 6 }} /></Card>
      </>
    );
  }

  return (
    <>
      <ClarityPageHeader
        legacy={{
          title: 'Spending 📊',
          sub: 'Daily log, inline category budgets, and a 12-month history chart. Everything comes from your logged entries.',
        }}
        title="Spending"
        decision={PAGE_DECISIONS.spending}
        action={rankedAction}
        fallbackAction={FALLBACK_ACTIONS.spendingRecord}
      />
      <SpendingTracker disposable={plan.afterFixed} onChange={() => setReloadKey((k) => k + 1)} />
      <SmartInsights refreshKey={reloadKey} />
      <MonthlyHistoryChart refreshKey={reloadKey} />
    </>
  );
}

/** Mutation scopes that change this page's spending: expense log, correction, delete, and category treatment. */
const SPENDING_SCOPE = /^(expense|new-expense|category-treatment):/;

function ClaritySpending() {
  const month = useKolkataMonth();
  const monthName = monthLabel(month);
  // Scrolls to and focuses the expense form, an expense row, or the category totals named by the link that opened this page.
  const arrival = useActionArrival('spending');
  const rankedAction = useHeaderAction('spending');
  const query = useClaritySnapshotQuery(month);
  const view = useFinancialClarity(month);
  // Newest confirmed snapshot with pending patches. The query covers the moment between a response and the store install.
  const snapshot = view.snapshot ?? query.data;
  const [change, setChange] = useState<ConfirmedSpendingChange | null>(null);
  const [retrying, setRetrying] = useState(false);
  // Bumped after each confirmed change so the two supporting sections quietly re-read in the background.
  const [supportKey, setSupportKey] = useState(0);
  const outcomeRef = useRef<HTMLDivElement>(null);
  const { refetch } = query;

  const refresh = useCallback(() => {
    void refetch();
  }, [refetch]);

  // Recalculation re-reads the confirmed snapshot. Entered expenses stay in their list.
  const recalculate = useCallback(async () => {
    setRetrying(true);
    try {
      await refetch();
    } finally {
      setRetrying(false);
    }
  }, [refetch]);

  const confirmed = useCallback((next: ConfirmedSpendingChange) => {
    setChange(next);
    setSupportKey((key) => key + 1);
  }, []);

  // A Quick Add confirmation for this month: the two supporting sections that list or chart expenses read again in
  // the background, as they do after a change made here. The expense list and the snapshot follow the same bus in
  // `useExpenseList`.
  useEffect(() => {
    if (!selectQuickAddEnabled()) return undefined;
    return subscribeToExpenseChanges((confirmedChange) => {
      if (expenseChangeTouchesMonth(confirmedChange, month)) setSupportKey((key) => key + 1);
    });
  }, [month]);

  const updating = view.pendingMutations.some((mutation) => SPENDING_SCOPE.test(mutation.scopeKey));
  const error = query.isError ? query.error : undefined;

  return (
    <>
      <ClarityPageHeader
        legacy={{ title: 'Spending 📊' }}
        title="Spending"
        decision={PAGE_DECISIONS.spending}
        action={rankedAction}
        fallbackAction={FALLBACK_ACTIONS.spendingRecord}
        right={<span className="pill info">{monthName}</span>}
      />
      <div ref={outcomeRef} tabIndex={-1}>
        <RegionBoundary
          regionKey="spending-outcome"
          label="Spending outcome"
          hasData={!!snapshot}
          loading={query.isFetching}
          error={error}
          onRetry={refresh}
          minHeight={240}
        >
          {snapshot && (
            <SpendingOutcome snapshot={snapshot} month={month} updating={updating} retrying={retrying} onRetry={recalculate} />
          )}
        </RegionBoundary>
        {change && (
          <SpendingChangeNotice
            change={change}
            onDismiss={() => {
              setChange(null);
              outcomeRef.current?.focus({ preventScroll: true });
            }}
          />
        )}
      </div>
      {!snapshot && !error && (
        <p className="muted small center" style={{ marginTop: '0.8rem' }} aria-live="polite">
          If this takes a few seconds, the free API host is waking up.
        </p>
      )}
      {/* The log form follows the outcome. Its purpose explanation and preview sit above the input. */}
      <SpendingTracker
        month={month}
        snapshot={snapshot}
        focusExpenseId={arrival.params.expenseId}
        onConfirmed={confirmed}
        onRefresh={refresh}
      />
      <SmartInsights refreshKey={supportKey} />
      <MonthlyHistoryChart refreshKey={supportKey} />
    </>
  );
}

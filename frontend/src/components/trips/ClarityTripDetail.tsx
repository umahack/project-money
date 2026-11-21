import { useCallback, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { PAGE_DECISIONS, tabForAction, tripDetailFallback } from '../../clarity/actionContext';
import type { TripOutcomeValue } from '../../clarity/contracts';
import { useDataUseGate } from '../../clarity/DataUseGateProvider';
import { useFinancialClarity } from '../../clarity/FinancialClarityProvider';
import { useActionArrival } from '../../clarity/useActionArrival';
import { useClaritySnapshotQuery } from '../../clarity/useClaritySnapshot';
import { useHeaderAction } from '../../clarity/useHeaderAction';
import { currentMonth } from '../../money';
import { useAuth } from '../../state';
import { ClarityPageHeader } from '../clarity/ClarityPageHeader';
import { DecisionActionHeader } from '../clarity/DecisionActionHeader';
import { RegionBoundary } from '../clarity/RegionBoundary';
import { Card, Empty } from '../ui';
import { usePersonalLinkStates } from './PersonalShare';
import { TripBalances } from './TripBalances';
import { TripExpenseForm } from './TripExpenseForm';
import { TripLedger } from './TripLedger';
import { TripPeople } from './TripPeople';
import { TripSummary } from './TripSummary';
import { findLinkedMember, findTripOutcome, tripConfirmedState } from './tripModel';
import { useTripChanges, useTripDetail } from './useTripChanges';
import { JourneyReturnLink } from '../journey/JourneyReturnLink';
import { TripShareLink } from '../TripShareLink';
import './trips.css';

type TripTab = 'expenses' | 'balances' | 'people' | 'share';
const TAB_LABELS: Record<TripTab, string> = {
  expenses: '🧾 Expenses',
  balances: '⚖️ Balances',
  people: '👥 People',
  share: '🔗 Share',
};

/**
 * Trip detail in the clarity branch. Allocations, balances, and the settlement
 * come from the server's snapshot; this page writes member, expense, settlement
 * and personal-share changes as separate scoped mutations and never reloads.
 */
export function ClarityTripDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const month = currentMonth();
  const gate = useDataUseGate();
  const [params, setParams] = useSearchParams();
  // Opens the tab and focuses the form named by the link that opened this page.
  const arrival = useActionArrival('trip-detail');
  const routeTripId = /^[1-9][0-9]{0,8}$/.test(id ?? '') ? Number(id) : undefined;
  const rankedAction = useHeaderAction('trip-detail', { tripId: routeTripId });
  const detail = useTripDetail(routeTripId === undefined ? undefined : String(routeTripId));
  const changes = useTripChanges();
  const query = useClaritySnapshotQuery(month);
  const view = useFinancialClarity(month);
  // Newest confirmed snapshot with pending patches. The query covers the moment between a response and the store install.
  const snapshot = view.snapshot ?? query.data;
  const personal = usePersonalLinkStates();
  const [recalculating, setRecalculating] = useState(false);
  const { refetch } = query;
  const retained = useRef<TripOutcomeValue | undefined>(undefined);

  const raw = params.get('tab') ?? tabForAction(arrival.action);
  const tab: TripTab = raw === 'balances' || raw === 'people' || raw === 'share' ? raw : 'expenses';
  const setTab = (next: TripTab) => setParams({ tab: next }, { replace: true });

  const refresh = useCallback(() => {
    void refetch();
  }, [refetch]);
  // Recalculation re-reads the confirmed snapshot. Saved trip records stay as they are.
  const recalculate = useCallback(async () => {
    setRecalculating(true);
    try {
      await refetch();
    } finally {
      setRecalculating(false);
    }
  }, [refetch]);

  const d = detail.data;
  const outcome = routeTripId === undefined ? undefined : findTripOutcome(snapshot, routeTripId);
  if (outcome?.status === 'available' && outcome.value) retained.current = outcome.value;
  const shown = outcome?.status === 'available' ? outcome.value : retained.current;
  const linked = useMemo(() => findLinkedMember(d?.members ?? [], user?.email), [d?.members, user?.email]);
  const confirmed = useMemo(() => tripConfirmedState(shown, linked?.id), [shown, linked?.id]);

  if (detail.missing || routeTripId === undefined) {
    return (
      <Card>
        <Empty emoji="🧭" title="Trip not found" text="It may have been deleted, or it belongs to another account." />
        <div className="center"><Link className="btn" to="/trips">Back to trips</Link></div>
      </Card>
    );
  }
  if (!d) {
    return (
      <>
        <ClarityPageHeader
          legacy={{ title: 'Trip ✈️', sub: 'Opening the trip…' }}
          title="Trip balance"
          decision={PAGE_DECISIONS['trip-detail']}
          action={rankedAction}
        />
        <RegionBoundary
          regionKey="trip-detail"
          label="Trip"
          hasData={false}
          loading={detail.loading}
          error={detail.error}
          onRetry={() => { void detail.reload(); }}
          minHeight={120}
        >
          {null}
        </RegionBoundary>
      </>
    );
  }

  const isOwner = d.role === 'owner';
  const availableTabs: TripTab[] = isOwner ? ['expenses', 'balances', 'people', 'share'] : ['expenses', 'balances', 'people'];
  const activeTab: TripTab = availableTabs.includes(tab) ? tab : 'expenses';
  const gated = !gate.financialInputsEnabled;
  const hasSettlements = (shown?.settlements.length ?? 0) > 0;
  const nextKind = hasSettlements ? 'settle' : d.members.length === 0 ? 'add-member' : 'add-expense';

  return (
    <>
      <div className="crumbs"><Link to="/trips">← All trips</Link></div>
      <JourneyReturnLink />
      <DecisionActionHeader
        title="Trip balance"
        decision={PAGE_DECISIONS['trip-detail']}
        action={rankedAction}
        fallbackAction={tripDetailFallback(nextKind, d.trip.id) ?? undefined}
      />
      <TripSummary d={d} />

      {/* Tabs follow the ARIA tabs pattern: the selected tab is the one Tab stop, and the arrow keys, Home, and End
          move between tabs and select them. */}
      <nav
        className="trip-tabs"
        role="tablist"
        aria-label="Trip sections"
        onKeyDown={(event) => {
          const last = availableTabs.length - 1;
          // Start from the tab that has focus: a quick second key can arrive before the first selection has rendered.
          const focused = availableTabs.findIndex((t) => `trip-tab-${t}` === (event.target as HTMLElement).id);
          const current = focused >= 0 ? focused : availableTabs.indexOf(activeTab);
          let next: number;
          if (event.key === 'ArrowRight') next = current === last ? 0 : current + 1;
          else if (event.key === 'ArrowLeft') next = current === 0 ? last : current - 1;
          else if (event.key === 'Home') next = 0;
          else if (event.key === 'End') next = last;
          else return;
          event.preventDefault();
          const target = availableTabs[next];
          if (!target) return;
          setTab(target);
          event.currentTarget.querySelector<HTMLElement>(`#trip-tab-${target}`)?.focus();
        }}
      >
        {availableTabs.map((t) => (
          <button
            key={t}
            id={`trip-tab-${t}`}
            role="tab"
            aria-selected={activeTab === t}
            aria-controls="trip-tab-panel"
            tabIndex={activeTab === t ? 0 : -1}
            className={`trip-tab ${activeTab === t ? 'on' : ''}`}
            onClick={() => setTab(t)}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </nav>

      <div className="stack" id="trip-tab-panel" role="tabpanel" aria-labelledby={`trip-tab-${activeTab}`}>
        {activeTab === 'expenses' && (
          <>
            <TripExpenseForm tripId={d.trip.id} members={d.members} changes={changes} detail={detail} gated={gated} confirmed={confirmed} />
            <TripLedger
              tripId={d.trip.id}
              members={d.members}
              expenses={d.expenses}
              linked={linked}
              outcome={outcome}
              value={shown}
              snapshotLoading={query.isFetching && !snapshot}
              snapshotError={query.isError ? query.error : undefined}
              onRefresh={refresh}
              detail={detail}
              changes={changes}
              gated={gated}
              personalStates={personal.states}
              onPersonalState={personal.set}
            />
          </>
        )}
        {activeTab === 'balances' && (
          <TripBalances
            tripId={d.trip.id}
            members={d.members}
            isOwner={isOwner}
            linked={linked}
            outcome={outcome}
            retained={retained.current}
            hasExpenses={d.expenses.length > 0}
            snapshotReady={!!snapshot}
            snapshotLoading={query.isFetching}
            snapshotError={query.isError ? query.error : undefined}
            onRefresh={refresh}
            onRecalculate={recalculate}
            recalculating={recalculating}
            changes={changes}
            detail={detail}
            gated={gated}
          />
        )}
        {activeTab === 'people' && (
          <TripPeople tripId={d.trip.id} members={d.members} isOwner={isOwner} changes={changes} detail={detail} gated={gated} />
        )}
        {activeTab === 'share' && isOwner && <TripShareLink tripId={d.trip.id} />}
      </div>
    </>
  );
}

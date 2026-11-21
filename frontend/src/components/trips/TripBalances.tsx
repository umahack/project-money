import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Outcome, TripOutcomeValue } from '../../clarity/contracts';
import type { OutcomeRetry } from '../clarity/OutcomeCard';
import { OutcomeCard } from '../clarity/OutcomeCard';
import { RegionBoundary } from '../clarity/RegionBoundary';
import { ScopedMutationStatus } from '../clarity/ScopedMutationStatus';
import { DATA_USE_REASON_ID } from '../clarity/DataUseGate';
import { formatMoney } from '../clarity/format';
import type { TripMember } from '../../types';
import { Card } from '../ui';
import {
  SETTLEMENT_PREFIX,
  balanceWording,
  memberNameResolver,
  ownBalanceWording,
  type TripBalance,
} from './tripModel';
import type { TripChanges, TripDetailState } from './useTripChanges';
import type { TripMutationEnvelope } from '../../clarity/tripMutation';

const GLYPH: Record<TripBalance['label'], string> = { receivable: '▲', owed: '▼', settled: '●' };

export interface TripBalancesProps {
  tripId: number;
  members: readonly TripMember[];
  isOwner: boolean;
  /** The trip member that carries the signed-in user's email, when there is exactly one. */
  linked: TripMember | undefined;
  outcome: Outcome<TripOutcomeValue> | undefined;
  /** The last available outcome value this page saw for the trip. Shown only while the stored trip data is invalid. */
  retained: TripOutcomeValue | undefined;
  hasExpenses: boolean;
  /** A confirmed snapshot has been read, even if it holds no entry for this trip. */
  snapshotReady: boolean;
  snapshotLoading: boolean;
  snapshotError?: unknown;
  onRefresh: () => void;
  onRecalculate: (retry: OutcomeRetry) => void | Promise<void>;
  recalculating: boolean;
  changes: TripChanges;
  detail: TripDetailState;
  gated: boolean;
}

function BalanceList({ balances, nameOf, linkedId }: {
  balances: readonly TripBalance[];
  nameOf: (memberId: number) => string;
  linkedId: number | undefined;
}) {
  return (
    <ul className="list trip-balance-list">
      {balances.map((balance) => {
        const name = nameOf(balance.memberId);
        return (
          <li key={balance.memberId} className="list-item" data-member-id={balance.memberId}>
            <span className="avatar" aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>
            <div className="grow"><strong>{name}</strong>{balance.memberId === linkedId ? <small className="muted"> (you)</small> : null}</div>
            <span className={`balance-chip trip-balance trip-balance-${balance.label}`}>
              <span aria-hidden="true" className="clarity-glyph">{GLYPH[balance.label]}</span>
              {balanceWording(balance)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The trip's member balances and proposed settlement, exactly as the server
 * calculated them. Each balance is written as text (Receivable, Owed, Settled).
 * A settlement payment is recorded on its own scope and is never a shared expense.
 */
export function TripBalances({
  tripId,
  members,
  isOwner,
  linked,
  outcome,
  retained,
  hasExpenses,
  snapshotReady,
  snapshotLoading,
  snapshotError,
  onRefresh,
  onRecalculate,
  recalculating,
  changes,
  detail,
  gated,
}: TripBalancesProps) {
  const ids = useId();
  const nameOf = useMemo(() => memberNameResolver(members), [members]);
  // Scopes started on this page stay listed after their transfer leaves the plan, so a success or failure stays visible.
  const [scopes, setScopes] = useState<string[]>([]);
  // The payment button the user activated, so focus can move to a remaining control if confirming removes it.
  const activated = useRef<Element | null>(null);
  const value = outcome?.status === 'available' || outcome?.status === 'stale' || outcome?.status === 'refresh_failed'
    ? outcome.value
    : undefined;
  const own = linked && value ? value.balances.find((balance) => balance.memberId === linked.id) : undefined;

  function record(transfer: TripOutcomeValue['settlements'][number]) {
    const active = document.activeElement;
    activated.current = active?.closest('[data-transfer]') ? active : null;
    const from = nameOf(transfer.fromMemberId);
    const to = nameOf(transfer.toMemberId);
    const scopeKey = `trip-settlement:${tripId}:${transfer.fromMemberId}>${transfer.toMemberId}`;
    const description = `${SETTLEMENT_PREFIX}${from} → ${to}`.slice(0, 100);
    const amount = transfer.amount.amountMinor / 100;
    const split = [{ name: to, share: 1 }];
    setScopes((current) => (current.includes(scopeKey) ? current : [...current, scopeKey]));
    void changes.run({
      scopeKey,
      label: `Payment from ${from} to ${to}`,
      path: `/trips/${tripId}/expenses`,
      method: 'POST',
      body: { payer: from, description, amount, split },
    }, {
      onSettled: (result) => {
        if (result.outcome !== 'confirmed') return;
        const envelope = result.envelope as TripMutationEnvelope;
        if (typeof envelope.id !== 'number') {
          void detail.reload();
          return;
        }
        detail.addExpense({
          id: envelope.id,
          payer: from,
          description,
          amount,
          split,
          created_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
        });
      },
    });
  }

  // A confirmed payment leaves the plan, and its button with it. Focus stays where the user moved it; if
  // it was on that button, it goes to the next payment, or to the card when none is left, not to the page.
  useEffect(() => {
    const was = activated.current;
    if (!was || was.isConnected) return;
    activated.current = null;
    if (document.activeElement && document.activeElement !== document.body) return;
    const card = document.getElementById('trip-balances');
    (card?.querySelector<HTMLElement>('[data-transfer] button:not(:disabled)') ?? card)?.focus();
  }, [outcome]);

  function planRow(transfer: TripOutcomeValue['settlements'][number]) {
    const from = nameOf(transfer.fromMemberId);
    const to = nameOf(transfer.toMemberId);
    const amount = formatMoney(transfer.amount);
    const scopeKey = `trip-settlement:${tripId}:${transfer.fromMemberId}>${transfer.toMemberId}`;
    const allowed = isOwner || transfer.fromMemberId === linked?.id;
    const reasonId = `${ids}-reason-${transfer.fromMemberId}-${transfer.toMemberId}`;
    return (
      <li key={scopeKey} className="list-item" data-transfer={`${transfer.fromMemberId}>${transfer.toMemberId}`}>
        <div className="grow"><b>{from}</b> pays <b>{to}</b></div>
        <b className="mono">{amount}</b>
        <button
          type="button"
          className="btn sm"
          disabled={gated || !allowed}
          aria-describedby={gated ? DATA_USE_REASON_ID : !allowed ? reasonId : undefined}
          aria-label={`Record payment: ${from} pays ${to} ${amount}`}
          onClick={() => record(transfer)}
        >
          Record payment
        </button>
        {!allowed && (
          <span id={reasonId} className="small muted trip-reason">Only {from} or the trip owner can record this payment.</span>
        )}
      </li>
    );
  }

  return (
    <Card tilt id="trip-balances" tabIndex={-1}>
      <h2>⚖️ Who owes whom</h2>
      <RegionBoundary
        regionKey="trip-balances"
        label="Trip balances"
        hasData={!!outcome || snapshotReady}
        loading={snapshotLoading}
        error={snapshotError}
        onRetry={onRefresh}
        minHeight={140}
      >
        {!outcome && snapshotReady ? (
          <p className="trip-unavailable" role="status">
            <strong>Balances are not available yet.</strong>{' '}
            <button type="button" className="btn sm ghost" onClick={onRefresh}>Refresh</button>
          </p>
        ) : null}
        {outcome ? (
          <OutcomeCard
            key={outcome.id}
            outcome={outcome}
            title="Balances and settlement"
            headingLevel={3}
            retrying={recalculating}
            onRetry={onRecalculate}
            valueSummary={own ? ownBalanceWording(own) : undefined}
            renderValue={(tripValue) => (
              <div className="trip-outcome">
                {own && <p className="trip-own-balance"><strong>{ownBalanceWording(own)}</strong></p>}
                {tripValue.balances.length === 0 ? (
                  <p className="muted">Add people and expenses to see balances.</p>
                ) : (
                  <>
                    <h4 className="trip-subtitle">Member balances</h4>
                    <BalanceList balances={tripValue.balances} nameOf={nameOf} linkedId={linked?.id} />
                  </>
                )}
                {tripValue.settlements.length > 0 ? (
                  <>
                    <h4 className="trip-subtitle">Simplest way to settle up</h4>
                    <p className="small muted">
                      Recording a payment adds a settlement payment. It is not a shared expense and is not part of what the trip spent.
                    </p>
                    <ul className="list trip-settlement-plan">{tripValue.settlements.map(planRow)}</ul>
                  </>
                ) : hasExpenses && tripValue.balances.length > 0 ? (
                  <p className="ok-text trip-all-square">All square. No payments are needed.</p>
                ) : null}
              </div>
            )}
          />
        ) : null}

        {outcome && outcome.status === 'invalid_input' && (
          retained ? (
            <section className="trip-retained" aria-labelledby={`${ids}-retained`}>
              <h3 id={`${ids}-retained`} className="trip-subtitle">Last confirmed balances</h3>
              <p className="small">
                The trip data has a problem, so new balances and the settlement are withheld. These are the last balances that were confirmed (trip version {retained.tripVersion}).
              </p>
              <BalanceList balances={retained.balances} nameOf={nameOf} linkedId={linked?.id} />
            </section>
          ) : (
            <p className="trip-unavailable" role="status">
              <strong>Member balances and the settlement are unavailable</strong> until the trip data is corrected.
            </p>
          )
        )}
      </RegionBoundary>
      {scopes.map((scopeKey) => (
        <ScopedMutationStatus key={scopeKey} scopeKey={scopeKey} onRetry={changes.retry} className="trip-scope-status" />
      ))}
    </Card>
  );
}

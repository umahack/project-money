import { useMemo } from 'react';
import type { Outcome, TripOutcomeValue } from '../../clarity/contracts';
import { fmtDate, inr } from '../../money';
import type { TripExpense, TripMember } from '../../types';
import { formatPaise } from '../clarity/format';
import { RegionBoundary } from '../clarity/RegionBoundary';
import { Card, Empty } from '../ui';
import { PersonalShare, type PersonalLinkState } from './PersonalShare';
import {
  allocationsByExpense,
  isSettlementPayment,
  memberNameResolver,
  roundingWording,
  splitRuleWording,
} from './tripModel';
import type { TripChanges, TripDetailState } from './useTripChanges';

export interface TripLedgerProps {
  tripId: number;
  members: readonly TripMember[];
  expenses: readonly TripExpense[];
  linked: TripMember | undefined;
  outcome: Outcome<TripOutcomeValue> | undefined;
  /** The trip's outcome value to read allocations from: the available one, or the last confirmed one. */
  value: TripOutcomeValue | undefined;
  snapshotLoading: boolean;
  snapshotError?: unknown;
  onRefresh: () => void;
  detail: TripDetailState;
  changes: TripChanges;
  gated: boolean;
  personalStates: ReadonlyMap<number, PersonalLinkState>;
  onPersonalState: (expenseId: number, state: PersonalLinkState) => void;
}

/**
 * Shared expenses with the server's allocation for each member, and settlement
 * payments in a separate list so a payment is never read as spending.
 */
export function TripLedger({
  tripId,
  members,
  expenses,
  linked,
  outcome,
  value,
  snapshotLoading,
  snapshotError,
  onRefresh,
  detail,
  changes,
  gated,
  personalStates,
  onPersonalState,
}: TripLedgerProps) {
  const nameOf = useMemo(() => memberNameResolver(members), [members]);
  const allocations = useMemo(() => allocationsByExpense(value), [value]);
  const shared = expenses.filter((expense) => !isSettlementPayment(expense.description));
  const payments = expenses.filter((expense) => isSettlementPayment(expense.description));
  const unavailable = outcome?.status === 'invalid_input' || outcome?.status === 'calculation_failed';

  return (
    <Card>
      <h2>🧾 Expenses</h2>
      <p className="small muted trip-personal-note">
        You can add your own share of a shared expense to your monthly spending. Nothing is added unless you confirm it,
        and including a share twice counts it once.
      </p>
      <RegionBoundary
        regionKey="trip-expense-list"
        label="Trip expenses"
        hasData={!detail.loading || !!detail.data}
        loading={detail.loading}
        error={detail.error}
        onRetry={() => { void detail.reload(); }}
        minHeight={120}
      >
        {shared.length === 0 ? (
          <Empty emoji="🧾" title="Nothing spent yet" text="Add the first expense above." />
        ) : (
          <ul className="list trip-expense-list">
            {shared.map((expense) => {
              const rows = allocations.get(expense.id);
              const own = linked ? rows?.find((row) => row.memberId === linked.id) : undefined;
              return (
                <li key={expense.id} id={`trip-expense-${expense.id}`} className="list-item hoverable trip-expense" data-expense-id={expense.id}>
                  <span className="avatar" aria-hidden="true">🧾</span>
                  <div className="grow">
                    <strong>{expense.description}</strong>
                    <small className="muted">
                      {expense.payer} paid · {splitRuleWording(expense)} · {fmtDate(expense.created_at)}
                    </small>
                    {rows && rows.length > 0 ? (
                      <ul className="trip-allocations" aria-label={`Each member’s share of ${expense.description}`}>
                        {rows.map((row) => (
                          <li key={row.memberId}>
                            <span>{nameOf(row.memberId)}</span>{' '}
                            <span className="mono">{formatPaise(row.amount.amountMinor)}</span>
                            {row.roundingAdjustmentMinor !== 0 && (
                              <small className="muted"> ({roundingWording(row.roundingAdjustmentMinor)})</small>
                            )}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="small muted trip-allocation-pending">
                        {unavailable
                          ? 'Shares are unavailable until the trip data is corrected.'
                          : snapshotLoading ? 'Calculating each member’s share…' : 'Each member’s share is not shown yet.'}
                      </p>
                    )}
                    {linked && own && own.amount.amountMinor > 0 && (
                      <PersonalShare
                        tripId={tripId}
                        expense={expense}
                        shareMinor={own.amount.amountMinor}
                        changes={changes}
                        gated={gated}
                        state={personalStates.get(expense.id)}
                        onState={onPersonalState}
                      />
                    )}
                  </div>
                  <b className="mono">{inr(expense.amount)}</b>
                </li>
              );
            })}
          </ul>
        )}
      </RegionBoundary>
      {snapshotError !== undefined && snapshotError !== null && !outcome && (
        <p className="small" role="status">
          Each member’s share could not be loaded.{' '}
          <button type="button" className="btn sm ghost" onClick={onRefresh}>Retry loading shares</button>
        </p>
      )}

      {payments.length > 0 && (
        <section aria-labelledby={`trip-${tripId}-payments`} className="trip-payments">
          <h3 id={`trip-${tripId}-payments`}>🤝 Settlement payments</h3>
          <p className="small muted">These payments settle balances. They are not shared expenses.</p>
          <ul className="list">
            {payments.map((payment) => (
              <li key={payment.id} className="list-item" data-payment-id={payment.id}>
                <span className="avatar" aria-hidden="true">🤝</span>
                <div className="grow">
                  <strong>{payment.payer} paid {payment.split[0]?.name ?? ''}</strong>
                  <small className="muted">Settlement payment · {fmtDate(payment.created_at)}</small>
                </div>
                <b className="mono ok-text">{inr(payment.amount)}</b>
              </li>
            ))}
          </ul>
        </section>
      )}
    </Card>
  );
}

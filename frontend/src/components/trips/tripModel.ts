import type { FinancialSnapshot, Outcome, TripOutcomeValue } from '../../clarity/contracts';
import type { ConfirmedState } from '../../clarity/purposeRegistry';
import type { MutationFailure } from '../../clarity/mutationStatusStore';
import type { FieldProblem } from '../../clarity/planInputs';
import { monthLabel } from '../../money';
import type { TripExpense, TripMember } from '../../types';
import { formatPaise } from '../clarity/format';

/**
 * Settlement payments are stored as shared-expense rows that carry this prefix
 * (the server's `LEGACY_SETTLEMENT_PREFIX`). The prefix is how this page keeps a
 * payment apart from a shared expense. The server decides what each row means.
 */
export const SETTLEMENT_PREFIX = '↔ Settlement: ';
export const isSettlementPayment = (description: string): boolean => description.startsWith(SETTLEMENT_PREFIX);

export type TripAllocation = TripOutcomeValue['allocations'][number];
export type TripBalance = TripOutcomeValue['balances'][number];

/** The trip's own outcome in the snapshot, or undefined while the snapshot has no entry for it. */
export function findTripOutcome(snapshot: FinancialSnapshot | undefined, tripId: number): Outcome<TripOutcomeValue> | undefined {
  return snapshot?.outcomes.tripSummary.items?.find((item) => item.id === `trip:${tripId}`);
}

/** Groups the server's per-member allocations by shared expense. */
export function allocationsByExpense(value: TripOutcomeValue | undefined): Map<number, TripAllocation[]> {
  const grouped = new Map<number, TripAllocation[]>();
  for (const allocation of value?.allocations ?? []) {
    const list = grouped.get(allocation.expenseId);
    if (list) list.push(allocation);
    else grouped.set(allocation.expenseId, [allocation]);
  }
  return grouped;
}

/** The trip member that carries the signed-in user's email, if there is exactly one. */
export function findLinkedMember(members: readonly TripMember[], email: string | undefined): TripMember | undefined {
  if (!email) return undefined;
  const wanted = email.trim().toLowerCase();
  const matches = members.filter((member) => member.email?.trim().toLowerCase() === wanted);
  return matches.length === 1 ? matches[0] : undefined;
}

/** Text for a signed member balance. The wording carries the meaning; color never does. */
export function balanceWording(balance: Pick<TripBalance, 'amountMinor' | 'label'>): string {
  if (balance.label === 'settled') return 'Settled';
  const amount = formatPaise(Math.abs(balance.amountMinor));
  return balance.label === 'receivable' ? `Receivable ${amount}` : `Owed ${amount}`;
}

/** Same meaning from the signed-in member's point of view. */
export function ownBalanceWording(balance: Pick<TripBalance, 'amountMinor' | 'label'>): string {
  if (balance.label === 'settled') return 'You are settled on this trip.';
  const amount = formatPaise(Math.abs(balance.amountMinor));
  return balance.label === 'receivable' ? `You are owed ${amount} (receivable).` : `You owe ${amount} (owed).`;
}

export function roundingWording(adjustmentMinor: number): string {
  const amount = formatPaise(Math.abs(adjustmentMinor));
  return `${adjustmentMinor > 0 ? '+' : '-'}${amount} rounding adjustment`;
}

export function splitRuleWording(expense: Pick<TripExpense, 'split'>): string {
  const included = expense.split.filter((entry) => entry.share > 0);
  const equal = included.length > 0 && included.every((entry) => entry.share === included[0]!.share);
  return equal ? `Equal split between ${included.length}` : 'Weighted split';
}

export function memberNameResolver(members: readonly TripMember[]): (memberId: number) => string {
  const names = new Map(members.map((member) => [member.id, member.name]));
  return (memberId) => names.get(memberId) ?? `Member ${memberId}`;
}

/** A month name for a `YYYY-MM-DD` date. */
export function monthOfDate(date: string): string {
  return monthLabel(date.slice(0, 7));
}

export type ExpenseFormField = 'description' | 'amount' | 'payer' | 'split' | 'form';
export type MemberFormField = 'name' | 'email' | 'form';
export type PersonalFormField = 'category' | 'spentOn' | 'form';

const SPLIT_FIELD = /^(split|memberWeights|split_json)/;

/**
 * Maps a rejected trip change to the field the user can correct. Returns null
 * for failures that are not about a value (network, conflict, server), which
 * stay in the scoped status with a retry.
 */
export function describeTripProblem(
  error: MutationFailure,
  fallbackField: string,
): { key: string; problem: FieldProblem } | null {
  if (!error.status || error.status < 400 || error.status >= 500) return null;
  if (error.status === 401 || error.status === 403 || error.status === 404 || error.status === 409 || error.status === 428 || error.status === 429) return null;
  const field = error.field ?? '';
  const constraint = typeof error.constraint === 'string' ? error.constraint : undefined;
  const make = (key: string, name: string, correction: string) => ({
    key,
    problem: { field: name, reason: error.message.replace(/\.?$/, '.'), correction: constraint ? `Accepted: ${constraint}.` : correction },
  });
  if (field === 'amount') return make('amount', 'Amount', 'Enter an amount above zero with at most two decimals.');
  if (field === 'description') return make('description', 'What it was for', 'Use 1 to 100 characters.');
  if (field === 'payer') return make('payer', 'Paid by', 'Choose a member of this trip.');
  if (SPLIT_FIELD.test(field)) return make('split', 'Split', 'Choose at least one member and give every chosen member a share above zero.');
  if (field === 'name') return make('name', 'Friend’s name', 'Use 1 to 40 characters.');
  if (field === 'email') return make('email', 'Email', 'Enter an address such as ravi@example.com.');
  if (field === 'category') return make('category', 'Category', 'Choose one of your categories. You can add categories in Settings.');
  if (field === 'spentOn') return make('spentOn', 'Date', 'Pick a valid date within the last ten years.');
  return { key: 'form', problem: { field: fallbackField, reason: error.message.replace(/\.?$/, '.'), correction: 'Your last confirmed balances are unchanged.' } };
}

/** What the Trip expense preview shows for an existing trip: the signed-in member's own balance and settlement, as the server returned them. */
export function tripConfirmedState(value: TripOutcomeValue | undefined, linkedId: number | undefined): ConfirmedState {
  if (!value) return {};
  const own = linkedId === undefined ? undefined : value.balances.find((balance) => balance.memberId === linkedId);
  const transfer = linkedId === undefined
    ? undefined
    : value.settlements.find((item) => item.fromMemberId === linkedId || item.toMemberId === linkedId);
  return {
    trip: {
      outcomes: {
        member_balance: own
          ? { kind: 'balance', label: own.label, amount: { currency: 'INR', amountMinor: Math.abs(own.amountMinor) } }
          : null,
        trip_settlement: transfer?.amount ?? null,
      },
    },
  };
}

/** Rows for a trip's list: the server's own ranking decides which trips lead. */
export function orderTripsByNearestSettlement<T extends { id: number }>(
  trips: readonly T[],
  snapshot: FinancialSnapshot | undefined,
): T[] {
  if (!snapshot) return [...trips];
  const rank = new Map<number, number>();
  const highlighted = snapshot.highlights?.nearestTripSettlement?.tripId;
  if (highlighted !== undefined) rank.set(highlighted, 0);
  let next = 1;
  for (const action of snapshot.actions) {
    if (action.context.recordType !== 'trip' || action.context.recordId === undefined) continue;
    if (!rank.has(action.context.recordId)) rank.set(action.context.recordId, next++);
  }
  // Array.prototype.sort is stable, so trips with no rank keep the order the server listed them in.
  return [...trips].sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER));
}

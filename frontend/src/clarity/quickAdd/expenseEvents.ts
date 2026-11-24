// In-memory, synchronous change bus for CONFIRMED expense changes (Requirements
// 7.17 and 7.21). A Quick Add confirmation publishes here so every mounted view
// of the affected month (the Spending list, the logging streak card, and any
// other subscriber) can apply the change without a refetch.
//
// Publish ONLY a result the server has confirmed: a mutation the runner reports
// as `confirmed` (create, update, or delete, including a replay of an earlier
// confirmation). Never publish a draft, a pending entry, a failed entry, or a
// provisional value. `publishExpenseChange` enforces this at the boundary by
// requiring `confirmed: true` and dropping anything malformed.
//
// What an event carries: the kind, the expense id, the original and resulting
// month and category exactly as the server returned them (null where the server
// gave none, for example the original side of a create), the server's mark
// state, and, for create and update, the server-confirmed `record` by reference.
// The Spending list needs the record's amount, note, and date to show a new row
// without a refetch (see design: Client State Architecture and the
// `mutation.record` response shape). The record is the same object the caller
// holds and is handed only to in-memory subscribers. This module never copies it,
// stores it beyond delivery, persists it, or logs it. Subscribers must treat it
// as read-only.
//
// Lifetime: subscribers live in module memory only. Every subscriber is dropped
// when the financial state clears (sign-out), so nothing outlives the account.
import { subscribeToFinancialStateClear } from '../stateLifecycle';

export type ExpenseChangeKind = 'create' | 'update' | 'delete';

/**
 * The expense as the server's confirmed mutation returns it
 * (`mutation.record`). Present on create and update, null on delete.
 */
export interface ConfirmedExpenseRecord {
  id: number;
  /** `YYYY-MM`. */
  month: string;
  category: string;
  amountMinor: number;
  note?: string | null;
  spentOn?: string | null;
  excludeFromDailyAllowance?: boolean;
}

export interface ConfirmedExpenseChange {
  /** Documents and enforces that the server confirmed this result. */
  readonly confirmed: true;
  readonly kind: ExpenseChangeKind;
  readonly expenseId: number;
  /** Month before the change as the server reports it; null for a create. */
  readonly originalMonth: string | null;
  /** Month after the change as the server reports it; null for a delete. */
  readonly resultingMonth: string | null;
  readonly originalCategory: string | null;
  readonly resultingCategory: string | null;
  /**
   * Whether the confirmed expense is marked "not counted in the daily
   * allowance". Null when the server did not report the mark (for example a
   * delete).
   */
  readonly excludedFromDailyAllowance: boolean | null;
  /** The server-confirmed record, by reference. Null on delete. */
  readonly record: Readonly<ConfirmedExpenseRecord> | null;
}

export type ExpenseChangeListener = (change: ConfirmedExpenseChange) => void;

interface Subscription {
  readonly listener: ExpenseChangeListener;
}

let subscriptions = new Set<Subscription>();

const KINDS: readonly string[] = ['create', 'update', 'delete'];

function isNullableText(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

function isDeliverable(change: ConfirmedExpenseChange): boolean {
  if (!change || typeof change !== 'object') return false;
  const value = change as unknown as Record<string, unknown>;
  return value.confirmed === true
    && typeof value.kind === 'string' && KINDS.includes(value.kind)
    && typeof value.expenseId === 'number' && Number.isInteger(value.expenseId) && value.expenseId > 0
    && isNullableText(value.originalMonth)
    && isNullableText(value.resultingMonth)
    && isNullableText(value.originalCategory)
    && isNullableText(value.resultingCategory)
    && (value.excludedFromDailyAllowance === null || typeof value.excludedFromDailyAllowance === 'boolean')
    && (value.record === null || (typeof value.record === 'object' && value.record !== undefined));
}

/**
 * Tell every subscriber, in subscription order and synchronously, that the
 * server confirmed an expense change. Only call this with a confirmed result.
 * An event that is not marked confirmed or is malformed is dropped.
 * A subscriber that throws does not stop the others and does not make this
 * function throw; the error is not logged because an event can concern money.
 */
export function publishExpenseChange(change: ConfirmedExpenseChange): void {
  if (!isDeliverable(change)) return;
  // Deliver to the subscribers present now. One that unsubscribes during this
  // delivery is skipped, and one added during it waits for the next event.
  for (const subscription of [...subscriptions]) {
    if (!subscriptions.has(subscription)) continue;
    try {
      subscription.listener(change);
    } catch {
      // Isolated on purpose: a failing view must not block the other views.
    }
  }
}

/** Receive confirmed expense changes. The returned function unsubscribes and is safe to call twice. */
export function subscribeToExpenseChanges(listener: ExpenseChangeListener): () => void {
  const subscription: Subscription = { listener };
  subscriptions.add(subscription);
  return () => {
    subscriptions.delete(subscription);
  };
}

function clearExpenseSubscribers(): void {
  subscriptions = new Set<Subscription>();
}

// Sign-out discards every subscriber with the rest of the in-memory financial state.
subscribeToFinancialStateClear(clearExpenseSubscribers);

/** Drop every subscriber so one test cannot leak a listener into the next. */
export function resetExpenseEventsForTests(): void {
  clearExpenseSubscribers();
}

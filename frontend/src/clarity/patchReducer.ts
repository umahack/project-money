// Pure, framework-free reducer for confirmed-plus-pending financial clarity state.
//
// Visible state = highest-version confirmed snapshot (per month) with the ordered
// pending patches applied on top. A patch is a pure, record-scoped function. The
// reducer never mutates a confirmed snapshot, so removing one patch (failure) or
// installing a newer snapshot (success) cannot disturb any other pending patch.
import type { FinancialSnapshot } from './contracts';

export type SnapshotPatch = (snapshot: FinancialSnapshot) => FinancialSnapshot;

export interface PendingMutation {
  readonly mutationId: string;
  readonly scopeKey: string;
  readonly submittedAt: number;
  /** Months whose snapshot the patch applies to. Omitted means every month. */
  readonly months?: readonly string[];
  readonly patch: SnapshotPatch;
}

export interface ClarityState {
  /** Highest-version confirmed snapshot per `YYYY-MM`. */
  readonly confirmed: Readonly<Record<string, FinancialSnapshot>>;
  /** Pending mutations in submission order. */
  readonly pending: readonly PendingMutation[];
}

export type ClarityAction =
  | { type: 'install'; snapshot: FinancialSnapshot }
  | { type: 'submit'; mutation: PendingMutation }
  | { type: 'succeed'; mutationId: string; snapshot?: FinancialSnapshot }
  | { type: 'fail'; mutationId: string }
  | { type: 'reset' };

export const initialClarityState: ClarityState = Object.freeze({
  confirmed: Object.freeze({}),
  pending: Object.freeze([]),
});

/**
 * A snapshot is installed unless a strictly higher version is already confirmed.
 * Equal versions install so a scoped recalculation retry can replace a
 * calculation_failed outcome without a data change.
 */
export function shouldInstallSnapshot(
  current: FinancialSnapshot | undefined,
  incoming: FinancialSnapshot,
): boolean {
  return !current || incoming.dataVersion >= current.dataVersion;
}

function installSnapshot(
  confirmed: ClarityState['confirmed'],
  incoming: FinancialSnapshot | undefined,
): ClarityState['confirmed'] {
  if (!incoming) return confirmed;
  const month = incoming.period.month;
  const current = confirmed[month];
  if (current === incoming || !shouldInstallSnapshot(current, incoming)) return confirmed;
  return { ...confirmed, [month]: incoming };
}

function withoutMutation(
  pending: ClarityState['pending'],
  mutationId: string,
): ClarityState['pending'] {
  return pending.some((item) => item.mutationId === mutationId)
    ? pending.filter((item) => item.mutationId !== mutationId)
    : pending;
}

export function isScopePending(state: ClarityState, scopeKey: string): boolean {
  return state.pending.some((item) => item.scopeKey === scopeKey);
}

export function clarityReducer(state: ClarityState, action: ClarityAction): ClarityState {
  switch (action.type) {
    case 'install': {
      const confirmed = installSnapshot(state.confirmed, action.snapshot);
      return confirmed === state.confirmed ? state : { ...state, confirmed };
    }
    case 'submit': {
      const { mutation } = action;
      // The same record scope cannot be submitted twice while pending.
      if (isScopePending(state, mutation.scopeKey)) return state;
      if (state.pending.some((item) => item.mutationId === mutation.mutationId)) return state;
      return { ...state, pending: [...state.pending, mutation] };
    }
    case 'succeed': {
      const confirmed = installSnapshot(state.confirmed, action.snapshot);
      const pending = withoutMutation(state.pending, action.mutationId);
      return confirmed === state.confirmed && pending === state.pending
        ? state
        : { confirmed, pending };
    }
    case 'fail': {
      const pending = withoutMutation(state.pending, action.mutationId);
      return pending === state.pending ? state : { ...state, pending };
    }
    case 'reset':
      return initialClarityState;
  }
}

export function applyPatches(
  confirmed: FinancialSnapshot,
  pending: readonly PendingMutation[],
): FinancialSnapshot {
  const month = confirmed.period.month;
  let visible = confirmed;
  for (const mutation of pending) {
    if (mutation.months && !mutation.months.includes(month)) continue;
    try {
      visible = mutation.patch(visible);
    } catch {
      // A faulty provisional patch must never hide confirmed values.
    }
  }
  return visible;
}

export function selectVisibleSnapshot(
  state: ClarityState,
  month: string,
): FinancialSnapshot | undefined {
  const confirmed = state.confirmed[month];
  return confirmed ? applyPatches(confirmed, state.pending) : undefined;
}

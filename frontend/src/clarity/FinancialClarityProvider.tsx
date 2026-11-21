import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { FinancialSnapshot } from './contracts';
import { createClarityStore, type ClarityStore } from './clarityStore';
import { selectVisibleSnapshot, type PendingMutation } from './patchReducer';
import { subscribeToFinancialStateClear } from './stateLifecycle';

const ClarityStoreContext = createContext<ClarityStore | null>(null);

function isClarityQueryKey(queryKey: readonly unknown[]): boolean {
  return queryKey.length === 2 && queryKey[0] === 'clarity' && typeof queryKey[1] === 'string';
}

function isFinancialSnapshot(value: unknown): value is FinancialSnapshot {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<FinancialSnapshot>;
  return typeof candidate.dataVersion === 'number'
    && !!candidate.period
    && typeof candidate.period.month === 'string'
    && !!candidate.outcomes;
}

/**
 * Holds the confirmed financial snapshot per month plus ordered pending patches.
 * Confirmed snapshots arrive from the query cache (reads) and from mutation
 * responses. Nothing is persisted; all state is dropped when auth is cleared.
 */
export function FinancialClarityProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [store] = useState(createClarityStore);

  useEffect(() => subscribeToFinancialStateClear(() => store.reset()), [store]);

  useEffect(() => {
    const cache = queryClient.getQueryCache();
    const install = (data: unknown) => {
      if (isFinancialSnapshot(data)) store.dispatch({ type: 'install', snapshot: data });
    };

    for (const query of cache.findAll({ predicate: (q) => isClarityQueryKey(q.queryKey) })) {
      install(query.state.data);
    }
    return cache.subscribe((event) => {
      if (event.type !== 'updated' || event.action.type !== 'success') return;
      if (!isClarityQueryKey(event.query.queryKey)) return;
      install(event.query.state.data);
    });
  }, [queryClient, store]);

  return <ClarityStoreContext.Provider value={store}>{children}</ClarityStoreContext.Provider>;
}

export function useClarityStore(): ClarityStore {
  const store = useContext(ClarityStoreContext);
  if (!store) throw new Error('useClarityStore must be used inside FinancialClarityProvider');
  return store;
}

/** Store when a provider is mounted, otherwise null. Lets page headers degrade to fixed actions. */
export function useOptionalClarityStore(): ClarityStore | null {
  return useContext(ClarityStoreContext);
}

export interface FinancialClarityView {
  /** Newest confirmed snapshot with pending patches applied, or undefined before the first read. */
  snapshot: FinancialSnapshot | undefined;
  /** Newest confirmed snapshot only. */
  confirmedSnapshot: FinancialSnapshot | undefined;
  /** Pending mutations that affect this month, in submission order. */
  pendingMutations: readonly PendingMutation[];
}

export function useFinancialClarity(month: string): FinancialClarityView {
  const store = useClarityStore();
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  return useMemo(() => ({
    snapshot: selectVisibleSnapshot(state, month),
    confirmedSnapshot: state.confirmed[month],
    pendingMutations: state.pending.filter(
      (mutation) => !mutation.months || mutation.months.includes(month),
    ),
  }), [state, month]);
}

/** True while any pending mutation (in any scope) targets this scope key. */
export function useScopePending(scopeKey: string): boolean {
  const store = useClarityStore();
  return useSyncExternalStore(
    store.subscribe,
    () => store.getState().pending.some((mutation) => mutation.scopeKey === scopeKey),
    () => false,
  );
}

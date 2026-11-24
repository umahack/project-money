import { useMemo, useSyncExternalStore } from 'react';
import { currentMonth } from '../money';
import type { ActionableInsight } from './contracts';
import { createClarityStore } from './clarityStore';
import { useOptionalClarityStore } from './FinancialClarityProvider';
import { pickPageAction, type ActionPage } from './actionContext';
import { selectVisibleSnapshot } from './patchReducer';

// Used when no provider is mounted (for example in isolated tests), so the header falls back to its fixed action.
const EMPTY_STORE = createClarityStore();

/**
 * The highest-ranked valid insight for this page from the current month's
 * visible snapshot, or null. The route is rebuilt from the fixed action key, so
 * the returned insight is safe to hand to `ActionLink`.
 */
export function useHeaderAction(page: ActionPage, options: { tripId?: number } = {}): ActionableInsight | null {
  const store = useOptionalClarityStore() ?? EMPTY_STORE;
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const { tripId } = options;
  // Read at render time so a month rollover, which re-renders the page, selects the new month's snapshot.
  const month = currentMonth();
  return useMemo(() => {
    const snapshot = selectVisibleSnapshot(state, month);
    return pickPageAction(snapshot?.actions, page, { tripId });
  }, [state, month, page, tripId]);
}

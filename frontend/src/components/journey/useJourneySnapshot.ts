import { useCallback } from 'react';
import { useFinancialClarity } from '../../clarity/FinancialClarityProvider';
import { useClaritySnapshotQuery } from '../../clarity/useClaritySnapshot';
import { currentMonth } from '../../money';

/**
 * Month snapshot and refresh for a hosted form or an outcome reveal, wired the
 * way the page that owns the form wires it. The snapshot is the server's newest
 * confirmed one with pending patches applied; nothing here calculates a value.
 */
export function useJourneySnapshot() {
  const month = currentMonth();
  const query = useClaritySnapshotQuery(month);
  const view = useFinancialClarity(month);
  const { refetch } = query;
  const refresh = useCallback(() => {
    void refetch();
  }, [refetch]);
  return { month, query, snapshot: view.snapshot ?? query.data, refresh };
}

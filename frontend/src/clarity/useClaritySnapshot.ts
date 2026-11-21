import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, clarityApi } from '../api';
import type { ClarityReadResponse, FinancialSnapshot } from './contracts';
import { queryKeys, selectNewestSnapshot } from './queryClient';

const MAX_RETRIES = 2;

function shouldRetry(failureCount: number, error: unknown): boolean {
  // A client error (bad request, forbidden, not found) will not change on retry.
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
  return failureCount < MAX_RETRIES;
}

/**
 * One query per month for `GET /api/finance/clarity?month=YYYY-MM`.
 *
 * The result is the newest snapshot: a response whose `dataVersion` is older than
 * the one already cached never replaces it. A failed refetch keeps the last
 * confirmed snapshot as `data` and sets `error`, so the page can keep showing
 * confirmed values with a scoped retry.
 */
export function useClaritySnapshotQuery(month: string, enabled = true) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: queryKeys.clarity(month),
    enabled,
    retry: shouldRetry,
    queryFn: async (): Promise<FinancialSnapshot> => {
      const response = await clarityApi.get<ClarityReadResponse>(
        `/finance/clarity?month=${encodeURIComponent(month)}`,
      );
      return selectNewestSnapshot(
        queryClient.getQueryData<FinancialSnapshot>(queryKeys.clarity(month)),
        response.snapshot,
      );
    },
  });
}

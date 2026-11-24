// What the Quick Add input needs to know about the User's data, read from places that already exist:
//
//   - categories: the ten built-in categories plus the User's custom ones (`GET /finance/categories`, the list the
//     Settings category manager edits). Until it loads, or when it cannot load, the built-in categories stand in, so
//     the input and the suggester work at once (Requirement 13.1).
//   - billLabels: the labels of the bills the server counts toward the current month, from the confirmed snapshot's
//     entered facts, for Bill_Match (Requirement 18.10).
//   - largeEntryThresholdMinor: the server's Large_Entry_Threshold, `outcomes.todayAllowance.value.largeEntryThreshold`.
//     The browser only compares integers with it (Requirement 18.10).
//
// Every cause that is not available yet is null, which classifyEntryWarning treats as "no warning for that cause"
// (Requirement 18.11). Nothing here blocks typing or saving. While Quick_Add_Enabled is off, no query is enabled and
// no request is sent.
//
// The snapshot read is passive: it uses the shared `['clarity', month]` query, never refetches because of focus,
// reconnect, or age, and only reads once when no page has read that month yet (Requirement 7.20: no polling).
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api, clarityApi } from '../../api';
import type { ClarityReadResponse, FinancialSnapshot } from '../../clarity/contracts';
import { useFinancialClarity } from '../../clarity/FinancialClarityProvider';
import { selectCountedBills } from '../../clarity/planInputs';
import { queryKeys, selectNewestSnapshot } from '../../clarity/queryClient';
import { selectQuickAddEnabled } from '../../clarity/rollout';
import { BUILT_IN_CATEGORIES } from '../../clarity/quickAdd/keywordRules';
import { useKolkataMonth } from '../../clarity/quickAdd/kolkata';
import type { QuickAddContext } from '../../clarity/quickAdd/useQuickAddActions';

export const CATEGORIES_PATH = '/finance/categories';
/** The custom-category list changes only in Settings, so a minute is enough and nothing refetches on focus. */
export const CATEGORIES_STALE_MS = 60_000;

interface CategoriesResponse {
  defaults: string[];
  custom: Array<{ id: number; name: string }>;
}

export interface QuickAddUiContext extends QuickAddContext {
  /** Never empty. */
  categories: readonly string[];
  billLabels: readonly string[] | null;
  largeEntryThresholdMinor: number | null;
}

const CATEGORIES_KEY = ['finance', 'categories'] as const;

/** Built-in categories first, then custom ones in creation order, without repeats. A malformed reply gives the built-ins. */
export function buildCategoryList(response: unknown): readonly string[] {
  const value = response as Partial<CategoriesResponse> | null | undefined;
  const defaults = Array.isArray(value?.defaults)
    ? value.defaults.filter((name): name is string => typeof name === 'string' && name !== '')
    : [];
  const custom = Array.isArray(value?.custom)
    ? value.custom.flatMap((item) => (item && typeof item.name === 'string' && item.name !== '' ? [item.name] : []))
    : [];
  const merged = [...new Set([...(defaults.length > 0 ? defaults : BUILT_IN_CATEGORIES), ...custom])];
  return merged.length > 0 ? merged : BUILT_IN_CATEGORIES;
}

/** The Large_Entry_Threshold in paise, or null when the snapshot has none for this month. */
export function selectLargeEntryThreshold(snapshot: FinancialSnapshot | undefined, month: string): number | null {
  if (!snapshot || snapshot.period.month !== month) return null;
  const value = snapshot.outcomes.todayAllowance?.value;
  if (!value || value.applicable !== true) return null;
  const threshold = value.largeEntryThreshold;
  return threshold && Number.isSafeInteger(threshold.amountMinor) ? threshold.amountMinor : null;
}

/** The labels of the bills the server counts toward `month`, or null while no snapshot for it is known. */
export function selectBillLabels(snapshot: FinancialSnapshot | undefined, month: string): readonly string[] | null {
  if (!snapshot || snapshot.period.month !== month) return null;
  return selectCountedBills(snapshot, month).map((bill) => bill.label);
}

export function useQuickAddCategories(): readonly string[] {
  const enabled = selectQuickAddEnabled();
  const query = useQuery({
    queryKey: CATEGORIES_KEY,
    enabled,
    staleTime: CATEGORIES_STALE_MS,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: () => api.get<CategoriesResponse>(CATEGORIES_PATH),
  });
  return useMemo(() => buildCategoryList(query.data), [query.data]);
}

function useCurrentMonthSnapshot(month: string): FinancialSnapshot | undefined {
  const enabled = selectQuickAddEnabled();
  const queryClient = useQueryClient();
  useQuery({
    queryKey: queryKeys.clarity(month),
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async (): Promise<FinancialSnapshot> => {
      const response = await clarityApi.get<ClarityReadResponse>(`/finance/clarity?month=${encodeURIComponent(month)}`);
      return selectNewestSnapshot(queryClient.getQueryData<FinancialSnapshot>(queryKeys.clarity(month)), response.snapshot);
    },
  });
  // The visible snapshot of the clarity store: confirmed values from reads and mutation responses.
  return useFinancialClarity(month).snapshot;
}

/**
 * Categories, bill labels, and the Large_Entry_Threshold for Quick Add. Must be used inside the query client and
 * FinancialClarityProvider. The result is stable until one of the three values changes.
 */
export function useQuickAddContext(): QuickAddUiContext {
  const month = useKolkataMonth();
  const categories = useQuickAddCategories();
  const snapshot = useCurrentMonthSnapshot(month);
  const billLabels = useMemo(() => selectBillLabels(snapshot, month), [snapshot, month]);
  const largeEntryThresholdMinor = useMemo(() => selectLargeEntryThreshold(snapshot, month), [snapshot, month]);
  return useMemo(
    () => ({ categories, billLabels, largeEntryThresholdMinor }),
    [categories, billLabels, largeEntryThresholdMinor],
  );
}

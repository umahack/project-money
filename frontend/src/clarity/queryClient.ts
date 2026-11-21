import { QueryClient } from '@tanstack/react-query';
import { registerQueryCacheClearer } from '../api';
import type { FinancialSnapshot } from './contracts';
import { notifyFinancialStateCleared } from './stateLifecycle';

export const queryKeys = Object.freeze({
  clarity: (month: string) => ['clarity', month] as const,
  explanation: (outcomeId: string, dataVersion: number) => (
    ['clarity-explanation', outcomeId, dataVersion] as const
  ),
  journey: (activeJourneyId: number | null) => ['journey', activeJourneyId] as const,
  expenses: (month: string) => ['finance', 'expenses', month] as const,
  goals: () => ['finance', 'goals'] as const,
  trip: (tripId: number) => ['trip', tripId] as const,
  settings: () => ['clarity-settings'] as const,
  /** All saved bills (id, label, amount, category), including bills not counted this month. */
  bills: () => ['finance', 'emis'] as const,
  /** The most recent saved salary, which may belong to a prior month. */
  latestSalary: () => ['finance', 'salary-latest'] as const,
});

export function createAppQueryClient(): QueryClient {
  // No storage persister is configured. Financial snapshots live only in this
  // in-memory cache and are discarded when the tab reloads or auth is cleared.
  return new QueryClient();
}

export function selectNewestSnapshot(
  current: FinancialSnapshot | undefined,
  incoming: FinancialSnapshot,
): FinancialSnapshot {
  return current && current.dataVersion > incoming.dataVersion ? current : incoming;
}

export function setFinancialSnapshot(
  client: QueryClient,
  incoming: FinancialSnapshot,
): FinancialSnapshot {
  let selected = incoming;
  client.setQueryData<FinancialSnapshot>(queryKeys.clarity(incoming.period.month), (current) => {
    selected = selectNewestSnapshot(current, incoming);
    return selected;
  });
  return selected;
}

export const queryClient = createAppQueryClient();
registerQueryCacheClearer(() => {
  queryClient.clear();
  // Pending patches, mutation statuses, and retry commands are memory-only too.
  notifyFinancialStateCleared();
});

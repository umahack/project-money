import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import type { MutationMetadata } from '../../clarity/contracts';
import { useMutationRunner } from '../../clarity/MutationStatusProvider';
import type { MutationCommand, MutationSubmitResult } from '../../clarity/mutationStatusStore';
import { queryKeys } from '../../clarity/queryClient';
import { useMeasurement } from '../../hooks/useMeasurement';
import { describeServerProblem, goalFromRecord, toGoalView, type GoalRow, type GoalView } from './goalInputs';

export const CONFLICT_TEXT = 'This goal was changed somewhere else, so your change was not saved. Your entry is kept. Save again to replace the other change with yours.';

export interface GoalListState {
  data: GoalView[] | undefined;
  error: unknown;
  loading: boolean;
  /** Reads the list again. `silent` keeps the shown list without a "Refreshing" note while it runs. */
  reload: (options?: { silent?: boolean }) => Promise<void>;
  /** Applies a confirmed goal change to the list without reading it again. */
  apply: (mutation: MutationMetadata) => void;
}

/**
 * The saved goals. They are read once; after that each confirmed change is
 * applied from its own response, so a change never triggers a broad refetch.
 * A read that was running when a change was confirmed is repeated, so it cannot
 * bring back an older list.
 */
export function useGoalList(): GoalListState {
  const [data, setData] = useState<GoalView[] | undefined>();
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(true);
  const epoch = useRef(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const reload = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    if (!silent) setLoading(true);
    try {
      for (;;) {
        const started = epoch.current;
        const response = await api.get<{ goals: GoalRow[] }>('/finance/goals');
        if (!alive.current) return;
        if (epoch.current !== started) continue;
        setData(response.goals.map(toGoalView));
        setError(undefined);
        return;
      }
    } catch (failure) {
      if (alive.current) setError(failure);
    } finally {
      if (alive.current && !silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const apply = useCallback((mutation: MutationMetadata) => {
    epoch.current += 1;
    if (mutation.operation === 'goal.delete') {
      setData((current) => current?.filter((goal) => goal.id !== mutation.recordId));
      return;
    }
    const goal = goalFromRecord(mutation.record);
    if (!goal) {
      // The response had no usable record, so read the list again rather than guess.
      void reload();
      return;
    }
    setData((current) => {
      if (!current) return current;
      return current.some((item) => item.id === goal.id)
        ? current.map((item) => (item.id === goal.id ? goal : item))
        : [goal, ...current];
    });
  }, [reload]);

  return useMemo(() => ({ data, error, loading, reload, apply }), [data, error, loading, reload, apply]);
}

export interface GoalRunOptions {
  /** Goal whose version this change moves, so the next change can send it. */
  goalId?: number;
  /**
   * The caller shows a rejected value beside its field. A 422 answer for a field
   * is then removed from the shared status so it is not reported twice, and is
   * never offered as a retry because sending the same value again fails again.
   */
  showsValidation?: boolean;
  /** Runs after the first attempt and after every retry of this scope settles, so a retry finishes the same way. */
  onSettled?: (result: MutationSubmitResult) => void;
}

export interface GoalChanges {
  run(command: MutationCommand, options?: GoalRunOptions): Promise<MutationSubmitResult>;
  /** Retries a failed scope with its original request and key, then settles it exactly as the first attempt would have. */
  retry(scopeKey: string): Promise<MutationSubmitResult>;
  /** Record version to send with the next change to this goal, or undefined when none is known. */
  versionOf(goalId: number): number | undefined;
  /** Scopes whose last save found that the goal changed elsewhere. */
  conflicts: ReadonlySet<string>;
}

/** A goal change the server confirmed. Carries ids and scope only, never a value. */
export interface ConfirmedGoalChange {
  scopeKey: string;
  changeId: number;
}

export interface GoalChangesOptions {
  month: string;
  list: GoalListState;
  /** Called after each confirmed goal change. The guided journey uses it to advance. */
  onConfirmed?: (change: ConfirmedGoalChange) => void;
  /** Re-reads the confirmed snapshot, for example after a conflict or a rejected contribution. */
  onRefresh?: () => void;
}

/**
 * Runs each goal change through the scoped mutation runner and keeps what the
 * page needs around it: record versions and conflict state. A goal's create,
 * correction, delete, contribution, and revision each use its own record scope
 * (`goal:<id>`, or `new-goal:form` before it exists), so they never block other
 * goals, the create form, or the rest of the page.
 */
export function useGoalChanges({ month, list, onRefresh, onConfirmed }: GoalChangesOptions): GoalChanges {
  const runner = useMutationRunner();
  const queryClient = useQueryClient();
  const measurement = useMeasurement();
  const versions = useRef(new Map<number, number>());
  const [conflicts, setConflicts] = useState<ReadonlySet<string>>(() => new Set());
  const handlers = useRef({ onRefresh, onConfirmed, measurement, list, month });
  handlers.current = { onRefresh, onConfirmed, measurement, list, month };
  const attempts = useRef(new Map<string, GoalRunOptions>());

  const clearConflict = useCallback((scopeKey: string) => {
    setConflicts((current) => {
      if (!current.has(scopeKey)) return current;
      const next = new Set(current);
      next.delete(scopeKey);
      return next;
    });
  }, []);

  const settle = useCallback((scopeKey: string, options: GoalRunOptions, result: MutationSubmitResult) => {
    if (result.outcome === 'duplicate' || result.outcome === 'not_retryable') return;
    if (result.outcome === 'confirmed') {
      const { envelope } = result;
      const { mutation } = envelope;
      if (mutation.recordType === 'goal' && typeof mutation.recordId === 'number') {
        if (mutation.operation === 'goal.delete') versions.current.delete(mutation.recordId);
        else versions.current.set(mutation.recordId, mutation.recordVersion);
      }
      handlers.current.list.apply(mutation);
      // The response carries the snapshot for the month it was calculated for. Read the month on screen again if that differs.
      const shown = handlers.current.month;
      if (envelope.clarity.period.month !== shown) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.clarity(shown) });
      }
      // Reports what this page did for the change: nothing reloaded and no page-wide loading.
      handlers.current.measurement.financialChangeUi({
        changeId: mutation.changeId,
        causedReload: false,
        causedPageWideLoading: false,
      });
      handlers.current.onConfirmed?.({ scopeKey, changeId: mutation.changeId });
    } else if (result.outcome === 'failed') {
      const { error } = result;
      if (error.status === 409) {
        // The goal changed elsewhere. Keep the draft, drop the stale version, and read again.
        if (options.goalId !== undefined) versions.current.delete(options.goalId);
        runner.dismiss(scopeKey);
        setConflicts((current) => new Set(current).add(scopeKey));
        handlers.current.onRefresh?.();
        void handlers.current.list.reload();
      } else if (options.showsValidation && describeServerProblem(error)) {
        runner.dismiss(scopeKey);
        // A rejected range usually means the gap moved. Show the server's current values: the
        // snapshot for the gap, and the goal list so "Saved so far" matches it. The list is read
        // without a loading note, so the rejection message is not delayed or pushed down by it.
        if (error.field === 'contributionMinor') {
          handlers.current.onRefresh?.();
          void handlers.current.list.reload({ silent: true });
        }
      }
    }
    options.onSettled?.(result);
  }, [queryClient, runner]);

  const run = useCallback(async (command: MutationCommand, options: GoalRunOptions = {}) => {
    attempts.current.set(command.scopeKey, options);
    clearConflict(command.scopeKey);
    // The pending acknowledgement is registered inside submit(), before any await in this function.
    const result = await runner.submit(command);
    settle(command.scopeKey, options, result);
    return result;
  }, [clearConflict, runner, settle]);

  const retry = useCallback(async (scopeKey: string) => {
    const options = attempts.current.get(scopeKey);
    clearConflict(scopeKey);
    const result = await runner.retry(scopeKey);
    if (options && result.outcome !== 'not_retryable') settle(scopeKey, options, result);
    return result;
  }, [clearConflict, runner, settle]);

  const versionOf = useCallback((goalId: number) => versions.current.get(goalId), []);

  return useMemo(() => ({ run, retry, versionOf, conflicts }), [run, retry, versionOf, conflicts]);
}

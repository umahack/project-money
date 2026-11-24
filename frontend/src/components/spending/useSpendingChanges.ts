import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import type { MutationMetadata } from '../../clarity/contracts';
import { useMutationRunner } from '../../clarity/MutationStatusProvider';
import type { MutationCommand, MutationSubmitResult } from '../../clarity/mutationStatusStore';
import { subscribeToExpenseChanges } from '../../clarity/quickAdd/expenseEvents';
import { queryKeys } from '../../clarity/queryClient';
import { selectQuickAddEnabled } from '../../clarity/rollout';
import {
  TREATMENT_LABEL,
  applyConfirmedExpense,
  applyExpenseChange,
  describeExpenseTransition,
  expenseChangeTouchesMonth,
  readExpenseTransition,
  treatmentPatch,
  treatmentScope,
  type ExpensesResponse,
  type Treatment,
} from '../../clarity/spendingInputs';
import { useMeasurement } from '../../hooks/useMeasurement';
import { monthLabel } from '../../money';

const CONFLICT_TEXT = 'This was changed somewhere else, so it was not saved. Your entry is kept. Save again to replace the other change with yours.';
export { CONFLICT_TEXT };

/** What the Spending page says after an expense or treatment change is confirmed. */
export interface ConfirmedSpendingChange {
  scopeKey: string;
  /** Plain text such as "Expense saved". */
  label: string;
  changeId: number;
  /** One sentence naming the original and resulting month and category, and the months recalculated. */
  text: string;
}

/** Entered values to show on one existing row while its correction is pending. Cleared when it settles. */
export interface RowOverlay {
  id: number;
  month: string;
  category: string;
  amountMinor: number;
  note: string | null;
  spentOn: string;
  /** The mark shown while the change is pending. Absent when the change does not carry it. */
  excluded?: boolean;
}

/** A new expense that has been submitted and is not confirmed yet, or failed. */
export interface PendingCreate {
  cid: string;
  scopeKey: string;
  amountMinor: number;
  category: string;
  note: string | null;
  /** Shown until the server confirms the saved date. */
  spentOn: string;
}

interface RunOptions {
  doneLabel: string;
  /** Record whose version this change moves, so the next change can send it. */
  versionKey?: string;
  overlay?: RowOverlay;
  /** The create this change belongs to. */
  cid?: string;
  /** Sentence for the confirmed-change notice. Defaults to the expense transition. */
  describe?: (mutation: MutationMetadata) => string;
  /** Runs after the first attempt and after every retry of this scope settles, so a retry finishes the same way. */
  onSettled?: (result: MutationSubmitResult) => void;
}

function withEntry<V>(map: ReadonlyMap<string, V>, key: string, value: V): ReadonlyMap<string, V> {
  const next = new Map(map);
  next.set(key, value);
  return next;
}

function withoutEntry<V>(map: ReadonlyMap<string, V>, key: string): ReadonlyMap<string, V> {
  if (!map.has(key)) return map;
  const next = new Map(map);
  next.delete(key);
  return next;
}

function localToday(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export interface ExpenseListOptions {
  /** A Quick Add change is removing a row that holds keyboard focus. Called before the row leaves, so focus can move on. */
  onRowLeaving?: (expenseId: number) => void;
}

export interface ExpenseListState {
  data: ExpensesResponse | undefined;
  error: unknown;
  loading: boolean;
  reload: () => Promise<void>;
  /** Applies a confirmed expense change to the list without reading it again. */
  apply: (mutation: MutationMetadata) => void;
}

/**
 * The month's expense list. It is read once; after that each confirmed change is
 * applied from its own response, so a change never triggers a broad refetch.
 * A read that was running when a change was confirmed is repeated, so it cannot
 * bring back an older list.
 *
 * While Quick_Add_Enabled, the list also follows the confirmed-change bus: an
 * expense that Quick Add created, corrected, moved, or removed is inserted,
 * replaced, or removed in place from the server's confirmed record, with no read
 * and no loading state. Changes for other months are ignored, and the month's
 * snapshot is marked stale so the server's totals are read again, never summed here.
 */
export function useExpenseList(month: string, options: ExpenseListOptions = {}): ExpenseListState {
  const [data, setData] = useState<ExpensesResponse | undefined>();
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(true);
  const epoch = useRef(0);
  const alive = useRef(true);
  const queryClient = useQueryClient();
  const latest = useRef(data);
  latest.current = data;
  const onRowLeaving = useRef(options.onRowLeaving);
  onRowLeaving.current = options.onRowLeaving;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      for (;;) {
        const started = epoch.current;
        const response = await api.get<ExpensesResponse>(`/finance/expenses?month=${encodeURIComponent(month)}`);
        if (!alive.current) return;
        if (epoch.current !== started) continue;
        setData(response);
        setError(undefined);
        return;
      }
    } catch (failure) {
      if (alive.current) setError(failure);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [month]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const apply = useCallback((mutation: MutationMetadata) => {
    epoch.current += 1;
    setData((current) => (current ? applyConfirmedExpense(current, mutation) : current));
  }, []);

  useEffect(() => {
    if (!selectQuickAddEnabled()) return undefined;
    return subscribeToExpenseChanges((change) => {
      if (!expenseChangeTouchesMonth(change, month)) return;
      // A read that is running now may have started before this change, so it is repeated.
      epoch.current += 1;
      const current = latest.current;
      if (current) {
        const next = applyExpenseChange(current, change);
        if (next !== current) {
          // The row is about to leave the list. Tell the page while it still holds focus, so focus can be handed on.
          const leaving = !next.expenses.some((row) => row.id === change.expenseId);
          const row = leaving ? document.getElementById(`expense-${change.expenseId}`) : null;
          if (row?.contains(document.activeElement)) onRowLeaving.current?.(change.expenseId);
        }
        setData((previous) => (previous ? applyExpenseChange(previous, change) : previous));
      }
      // The month's totals come from the server. Mark the confirmed snapshot stale so it is read again.
      void queryClient.invalidateQueries({ queryKey: queryKeys.clarity(month) });
    });
  }, [month, queryClient]);

  return useMemo(() => ({ data, error, loading, reload, apply }), [data, error, loading, reload, apply]);
}

export interface SpendingChangesOptions {
  month: string;
  list: ExpenseListState;
  onConfirmed?: (change: ConfirmedSpendingChange) => void;
  /** Re-reads the confirmed snapshot, for example after a conflict. */
  onRefresh?: () => void;
}

export interface SpendingChanges {
  run(command: MutationCommand, options: RunOptions): Promise<MutationSubmitResult>;
  /** Retries a failed scope with its original request, then settles it exactly as the first attempt would have. */
  retry(scopeKey: string): Promise<MutationSubmitResult>;
  createExpense(draft: { amountMinor: number; category: string; note: string | null }): void;
  /** Removes a failed or dismissed new expense from the list. */
  dropCreate(cid: string): void;
  setTreatment(input: { category: string; treatment: Treatment; recordId?: number }): void;
  removeTreatment(input: { category: string; recordId?: number }): void;
  versionOf(type: 'expense' | 'category_treatment', id: number | null | undefined): number | undefined;
  /** Id of the new-expense scope that created this record in this session, if any. */
  createdScopeOf(expenseId: number): string | undefined;
  conflicts: ReadonlySet<string>;
  overlays: ReadonlyMap<string, RowOverlay>;
  creates: ReadonlyMap<string, PendingCreate>;
}

/**
 * Runs each expense or treatment change through the scoped mutation runner and
 * keeps what the page needs around it: provisional row values, record versions,
 * and conflict state. Nothing here blocks the page.
 */
export function useSpendingChanges({ month, list, onConfirmed, onRefresh }: SpendingChangesOptions): SpendingChanges {
  const runner = useMutationRunner();
  const queryClient = useQueryClient();
  const measurement = useMeasurement();
  const versions = useRef(new Map<string, number>());
  const createdBy = useRef(new Map<number, string>());
  const [conflicts, setConflicts] = useState<ReadonlySet<string>>(() => new Set());
  const [overlays, setOverlays] = useState<ReadonlyMap<string, RowOverlay>>(() => new Map());
  const [creates, setCreates] = useState<ReadonlyMap<string, PendingCreate>>(() => new Map());
  const handlers = useRef({ onConfirmed, onRefresh, measurement, list, month });
  handlers.current = { onConfirmed, onRefresh, measurement, list, month };

  // What each scope's latest attempt needs once it settles, so Retry can finish it the same way.
  const attempts = useRef(new Map<string, RunOptions>());

  const clearConflict = useCallback((scopeKey: string) => {
    setConflicts((current) => {
      if (!current.has(scopeKey)) return current;
      const next = new Set(current);
      next.delete(scopeKey);
      return next;
    });
  }, []);

  const settle = useCallback((scopeKey: string, options: RunOptions, result: MutationSubmitResult) => {
    if (result.outcome === 'duplicate' || result.outcome === 'not_retryable') return;
    // Settled either way: confirmed values replace the provisional ones, and a failure restores the confirmed row.
    setOverlays((current) => withoutEntry(current, scopeKey));
    if (result.outcome === 'confirmed') {
      const { envelope } = result;
      const { mutation } = envelope;
      if (mutation.recordType && typeof mutation.recordId === 'number') {
        versions.current.set(`${mutation.recordType}:${mutation.recordId}`, mutation.recordVersion);
      }
      const { list: expenseList, month: shown } = handlers.current;
      expenseList.apply(mutation);
      if (options.cid) {
        if (mutation.operation === 'expense.create' && typeof mutation.recordId === 'number') {
          createdBy.current.set(mutation.recordId, options.cid);
        }
        const cid = options.cid;
        setCreates((current) => withoutEntry(current, cid));
      }
      // The response carries the snapshot for the month the change landed in. When that is not the month on screen, read the month on screen again.
      if (envelope.clarity.period.month !== shown) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.clarity(shown) });
      }
      const text = options.describe
        ? options.describe(mutation)
        : describeExpenseTransition(
          readExpenseTransition(mutation) ?? {
            type: mutation.operation,
            originalPeriod: null,
            resultingPeriod: shown,
            originalCategory: null,
            resultingCategory: null,
            affectedPeriods: [shown],
          },
          monthLabel,
        );
      handlers.current.onConfirmed?.({ scopeKey, label: options.doneLabel, changeId: mutation.changeId, text });
      // Reports what this page did for the change: nothing reloaded and no page-wide loading.
      handlers.current.measurement.financialChangeUi({
        changeId: mutation.changeId,
        causedReload: false,
        causedPageWideLoading: false,
      });
    } else if (result.outcome === 'failed' && result.error.status === 409) {
      // Someone else changed this record. Keep the draft, drop the stale version, and re-read.
      if (options.versionKey) versions.current.delete(options.versionKey);
      runner.dismiss(scopeKey);
      setConflicts((current) => new Set(current).add(scopeKey));
      handlers.current.onRefresh?.();
      void handlers.current.list.reload();
    }
    options.onSettled?.(result);
  }, [queryClient, runner]);

  const run = useCallback(async (command: MutationCommand, options: RunOptions) => {
    attempts.current.set(command.scopeKey, options);
    clearConflict(command.scopeKey);
    // The pending acknowledgement is registered inside submit(), before any await in this function.
    if (options.overlay) {
      const { overlay } = options;
      setOverlays((current) => withEntry(current, command.scopeKey, overlay));
    }
    const result = await runner.submit(command);
    settle(command.scopeKey, options, result);
    return result;
  }, [clearConflict, runner, settle]);

  const retry = useCallback(async (scopeKey: string) => {
    const options = attempts.current.get(scopeKey);
    clearConflict(scopeKey);
    if (options?.overlay) {
      const { overlay } = options;
      setOverlays((current) => withEntry(current, scopeKey, overlay));
    }
    const result = await runner.retry(scopeKey);
    if (options && result.outcome !== 'not_retryable') settle(scopeKey, options, result);
    else setOverlays((current) => withoutEntry(current, scopeKey));
    return result;
  }, [clearConflict, runner, settle]);

  const createExpense = useCallback<SpendingChanges['createExpense']>((draft) => {
    const cid = globalThis.crypto.randomUUID();
    const scopeKey = `new-expense:${cid}`;
    setCreates((current) => withEntry(current, cid, { cid, scopeKey, ...draft, spentOn: localToday() }));
    void run({
      scopeKey,
      label: 'Log expense',
      path: '/finance/expenses',
      method: 'POST',
      body: { amountMinor: draft.amountMinor, category: draft.category, ...(draft.note ? { note: draft.note } : {}) },
      months: [handlers.current.month],
    }, { doneLabel: 'Expense logged', cid });
  }, [run]);

  const dropCreate = useCallback((cid: string) => {
    const scopeKey = `new-expense:${cid}`;
    attempts.current.delete(scopeKey);
    runner.dismiss(scopeKey);
    setCreates((current) => withoutEntry(current, cid));
  }, [runner]);

  const versionOf = useCallback<SpendingChanges['versionOf']>((type, id) => (
    id === null || id === undefined ? undefined : versions.current.get(`${type}:${id}`)
  ), []);

  const setTreatment = useCallback<SpendingChanges['setTreatment']>(({ category, treatment, recordId }) => {
    const shown = handlers.current.month;
    const version = versionOf('category_treatment', recordId);
    const label = `Count ${category} as ${TREATMENT_LABEL[treatment]}`;
    void run({
      scopeKey: treatmentScope(category),
      label,
      path: `/finance/category-treatments/${encodeURIComponent(category)}`,
      method: 'PUT',
      body: { treatment, ...(version === undefined ? {} : { expectedRecordVersion: version }) },
      patch: treatmentPatch(shown, category, treatment),
      months: [shown],
    }, {
      doneLabel: 'Treatment saved',
      versionKey: recordId === undefined ? undefined : `category_treatment:${recordId}`,
      describe: () => `${category} now counts as ${TREATMENT_LABEL[treatment]}. Your spending for ${monthLabel(shown)} was recalculated.`,
    });
  }, [run, versionOf]);

  const removeTreatment = useCallback<SpendingChanges['removeTreatment']>(({ category, recordId }) => {
    const shown = handlers.current.month;
    const version = versionOf('category_treatment', recordId);
    void run({
      scopeKey: treatmentScope(category),
      label: `Use the default for ${category}`,
      path: `/finance/category-treatments/${encodeURIComponent(category)}`,
      method: 'DELETE',
      body: version === undefined ? {} : { expectedRecordVersion: version },
      months: [shown],
    }, {
      doneLabel: 'Default treatment restored',
      versionKey: recordId === undefined ? undefined : `category_treatment:${recordId}`,
      describe: () => `${category} uses its default treatment again. Your spending for ${monthLabel(shown)} was recalculated.`,
    });
  }, [run, versionOf]);

  const createdScopeOf = useCallback<SpendingChanges['createdScopeOf']>((expenseId) => {
    const cid = createdBy.current.get(expenseId);
    return cid === undefined ? undefined : `new-expense:${cid}`;
  }, []);

  return useMemo<SpendingChanges>(() => ({
    run,
    retry,
    createExpense,
    dropCreate,
    setTreatment,
    removeTreatment,
    versionOf,
    createdScopeOf,
    conflicts,
    overlays,
    creates,
  }), [run, retry, createExpense, dropCreate, setTreatment, removeTreatment, versionOf, createdScopeOf, conflicts, overlays, creates]);
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../../api';
import { useMutationRunner } from '../../clarity/MutationStatusProvider';
import type { MutationCommand, MutationSubmitResult } from '../../clarity/mutationStatusStore';
import type { TripMutationEnvelope } from '../../clarity/tripMutation';
import { useMeasurement } from '../../hooks/useMeasurement';
import type { TripDetailData, TripExpense, TripMember } from '../../types';
import { describeTripProblem } from './tripModel';

export interface TripDetailState {
  data: TripDetailData | null;
  missing: boolean;
  error: unknown;
  loading: boolean;
  reload: () => Promise<void>;
  /** Adds a confirmed member to the list without reading the trip again. */
  addMember: (member: TripMember) => void;
  /** Adds a confirmed expense or settlement payment to the list without reading the trip again. */
  addExpense: (expense: TripExpense) => void;
}

/**
 * The trip's members and entered expenses. They are read once; after that each
 * confirmed change is applied from what was submitted and the id the server
 * returned, so a change never causes a broad reload. The canonical allocations,
 * balances and settlement come from the confirmed snapshot, not from this list.
 */
export function useTripDetail(id: string | undefined): TripDetailState {
  const [data, setData] = useState<TripDetailData | null>(null);
  const [missing, setMissing] = useState(false);
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

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      for (;;) {
        const started = epoch.current;
        const response = await api.get<TripDetailData>(`/trips/${id}`);
        if (!alive.current) return;
        // A change confirmed while this read was running makes the read stale. Read again.
        if (epoch.current !== started) continue;
        setData(response);
        setError(undefined);
        setMissing(false);
        return;
      }
    } catch (failure) {
      if (!alive.current) return;
      if (failure instanceof ApiError && failure.status === 404) setMissing(true);
      else setError(failure);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const addMember = useCallback((member: TripMember) => {
    epoch.current += 1;
    setData((current) => (
      !current || current.members.some((item) => item.id === member.id)
        ? current
        : { ...current, members: [...current.members, member] }
    ));
  }, []);

  const addExpense = useCallback((expense: TripExpense) => {
    epoch.current += 1;
    setData((current) => (
      !current || current.expenses.some((item) => item.id === expense.id)
        ? current
        : { ...current, expenses: [expense, ...current.expenses] }
    ));
  }, []);

  return useMemo(
    () => ({ data, missing, error, loading, reload, addMember, addExpense }),
    [data, missing, error, loading, reload, addMember, addExpense],
  );
}

export interface TripRunOptions {
  /**
   * The caller shows a rejected value beside its field. A 4xx answer that names a
   * correctable field is then removed from the shared status so it is not reported
   * twice, and is never offered as a retry because sending it again fails again.
   */
  showsValidation?: boolean;
  /** Name used when the rejection is about the whole form. */
  fallbackField?: string;
  /** Runs after the first attempt and after every retry of this scope settles, so a retry finishes the same way. */
  onSettled?: (result: MutationSubmitResult) => void;
}

export interface TripChanges {
  run(command: MutationCommand, options?: TripRunOptions): Promise<MutationSubmitResult>;
  /** Retries a failed scope with its original request and key, then settles it exactly as the first attempt would have. */
  retry(scopeKey: string): Promise<MutationSubmitResult>;
}

/**
 * Runs each trip change through the scoped mutation runner. A member, a shared
 * expense, a settlement payment, and a personal-share link each use their own
 * scope, so one pending or failed change never blocks another control.
 */
export function useTripChanges(): TripChanges {
  const runner = useMutationRunner();
  const measurement = useMeasurement();
  const handlers = useRef({ measurement });
  handlers.current = { measurement };
  const attempts = useRef(new Map<string, TripRunOptions>());

  const settle = useCallback((scopeKey: string, options: TripRunOptions, result: MutationSubmitResult) => {
    if (result.outcome === 'duplicate' || result.outcome === 'not_retryable') return;
    if (result.outcome === 'failed' && result.error.committed) {
      // The server saved the change and only the balances read failed. Show the saved change now.
      // The scope keeps its failed status with a retry that reads again and never writes again.
      const saved = { outcome: 'confirmed', envelope: { id: result.error.committed.id } } as unknown as MutationSubmitResult;
      options.onSettled?.(saved);
      return;
    }
    if (result.outcome === 'confirmed') {
      const envelope = result.envelope as TripMutationEnvelope;
      // Reports what this page did for the change: nothing reloaded and no page-wide loading.
      handlers.current.measurement.financialChangeUi({
        changeId: envelope.mutation.changeId,
        causedReload: false,
        causedPageWideLoading: false,
      });
    } else if (result.outcome === 'failed' && options.showsValidation) {
      // The rejected value is shown beside its field. Retrying the same value fails again, so drop the shared status.
      const { status, code } = result.error;
      if (
        ((status === 400 || status === 422) && describeTripProblem(result.error, options.fallbackField ?? 'Trip change'))
        || (status === 409 && code === 'TRIP_MEMBER_EXISTS')
      ) {
        runner.dismiss(scopeKey);
      }
    }
    options.onSettled?.(result);
  }, [runner]);

  const run = useCallback(async (command: MutationCommand, options: TripRunOptions = {}) => {
    attempts.current.set(command.scopeKey, options);
    // The pending acknowledgement is registered inside submit(), before any await in this function.
    const result = await runner.submit(command);
    settle(command.scopeKey, options, result);
    return result;
  }, [runner, settle]);

  const retry = useCallback(async (scopeKey: string) => {
    const options = attempts.current.get(scopeKey);
    const result = await runner.retry(scopeKey);
    if (options && result.outcome !== 'not_retryable') settle(scopeKey, options, result);
    return result;
  }, [runner, settle]);

  return useMemo(() => ({ run, retry }), [run, retry]);
}

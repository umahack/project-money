import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../api';
import { useMeasurement } from '../hooks/useMeasurement';
import {
  fetchActiveJourney,
  sendJourneyRequest,
  type GuidedJourneyView,
  type JourneyRequest,
} from './journeys';
import { queryKeys } from './queryClient';

/**
 * Where a failed request is reported: the outcome choice, one step (saving it or
 * skipping it), the final "finish" action, or the journey as a whole (pause, resume).
 */
export type JourneyFailureScope = 'start' | 'journey' | 'complete' | `step:${string}`;

export interface JourneyFailure {
  scope: JourneyFailureScope;
  /** The exact request that failed. Retry sends this same request again. */
  request: JourneyRequest;
  message: string;
  code?: string;
  status?: number;
  retryable: boolean;
}

const RETRYABLE_CODES: ReadonlySet<string> = new Set(['STEP_NOT_CONFIRMED', 'DATA_NOTICE_REQUIRED', 'JOURNEY_OPERATION_FAILED']);
/** After these the client's picture of the journey is stale, so it is read again. */
const STALE_CODES: ReadonlySet<string> = new Set([
  'JOURNEY_ALREADY_ACTIVE',
  'JOURNEY_NOT_ACTIVE',
  'JOURNEY_NOT_FOUND',
  'JOURNEY_PAUSED',
  'FIRST_OUTCOME_PENDING',
]);

function scopeOf(request: JourneyRequest): JourneyFailureScope {
  if (request.kind === 'start') return 'start';
  const { transition } = request;
  if (transition.action === 'complete_step' || transition.action === 'skip_step') return `step:${transition.stepKey}`;
  return transition.action === 'complete' ? 'complete' : 'journey';
}

function describe(request: JourneyRequest, error: unknown): JourneyFailure {
  const status = error instanceof ApiError ? error.status : 0;
  const code = error instanceof ApiError ? error.code : undefined;
  let message = error instanceof Error && error.message ? error.message : 'The journey change could not be saved.';
  if (status === 428 && code === 'DATA_NOTICE_REQUIRED') {
    message = 'Review and acknowledge the data-use notice on this page, then try again.';
  }
  const retryable = status === 0 || status >= 500 || status === 429 || (code !== undefined && RETRYABLE_CODES.has(code));
  return { scope: scopeOf(request), request, message, code, status, retryable };
}

export interface GuidedJourneyState {
  /** `undefined` until the first read finishes; `null` when the user has no open journey. */
  journey: GuidedJourneyView | null | undefined;
  /** A journey the user just finished, kept so the page can say so. */
  finished: GuidedJourneyView | null;
  loadError: unknown;
  reload: () => void;
  /** The request being sent, or null. Only one request runs at a time. */
  busy: JourneyRequest | null;
  failure: JourneyFailure | null;
  /** Sends a request. Resolves to the updated journey, or null when it failed or another request is running. */
  run: (request: JourneyRequest) => Promise<GuidedJourneyView | null>;
  /** Sends the failed request again, unchanged. */
  retry: () => Promise<GuidedJourneyView | null>;
  dismissFailure: () => void;
  clearFinished: () => void;
}

/**
 * Reads and changes the user's open guided journey. The server decides every
 * step; this hook sends only the fixed requests in `journeys.ts`, shows the
 * response it gets back, and never advances on its own. One request runs at a
 * time, so a double click cannot start two journeys.
 */
export function useGuidedJourney(): GuidedJourneyState {
  const queryClient = useQueryClient();
  const measurement = useMeasurement();
  const measurementRef = useRef(measurement);
  measurementRef.current = measurement;
  const [failure, setFailure] = useState<JourneyFailure | null>(null);
  const [busy, setBusy] = useState<JourneyRequest | null>(null);
  const [finished, setFinished] = useState<GuidedJourneyView | null>(null);
  const inFlight = useRef(false);
  const alive = useRef(true);
  const reported = useRef(new Set<number>());

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const query = useQuery({
    queryKey: queryKeys.journey(null),
    queryFn: fetchActiveJourney,
    retry: (count, error) => count < 1 && (!(error instanceof ApiError) || error.status === 0 || error.status >= 500),
    retryDelay: 500,
  });
  const { refetch } = query;

  const run = useCallback(async (request: JourneyRequest): Promise<GuidedJourneyView | null> => {
    if (inFlight.current) return null;
    inFlight.current = true;
    setBusy(request);
    setFailure(null);
    const hadOpenJourney = !!queryClient.getQueryData<GuidedJourneyView | null>(queryKeys.journey(null));
    try {
      const view = await sendJourneyRequest(request);
      if (view.status === 'completed' || view.status === 'abandoned') {
        queryClient.setQueryData(queryKeys.journey(null), null);
        if (alive.current) setFinished(view);
      } else {
        queryClient.setQueryData(queryKeys.journey(null), view);
      }
      // A start that found no open journey created one. Report it once, and only if analytics is on.
      if (request.kind === 'start' && !hadOpenJourney && !reported.current.has(view.id)) {
        reported.current.add(view.id);
        measurementRef.current.journeyStarted({ journeyId: view.id, desiredOutcome: view.desiredOutcome });
      }
      return view;
    } catch (error) {
      const described = describe(request, error);
      if (alive.current) setFailure(described);
      if (described.code !== undefined && STALE_CODES.has(described.code)) void refetch();
      return null;
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(null);
    }
  }, [queryClient, refetch]);

  const retry = useCallback(async () => (failure ? run(failure.request) : null), [failure, run]);
  const dismissFailure = useCallback(() => setFailure(null), []);
  const clearFinished = useCallback(() => setFinished(null), []);
  const reload = useCallback(() => {
    void refetch();
  }, [refetch]);

  return {
    journey: query.data,
    finished,
    loadError: query.isError ? query.error : undefined,
    reload,
    busy,
    failure,
    run,
    retry,
    dismissFailure,
    clearFinished,
  };
}

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, getToken } from '../api';
import { useAuth } from '../state';
import { analyticsConsentFromSettings, measurement } from './measurement';
import { queryKeys } from './queryClient';
import { selectFinancialClarityRollout } from './rollout';
import {
  acknowledgeDataUseNotice,
  DATA_NOTICE_REQUIRED_EVENT,
  fetchClaritySettings,
  setProductAnalyticsEnabled,
  type ClaritySettings,
} from './settings';

/** Session-only flag that the Core Promise was rendered. It holds the user id and nothing else. */
export const PROMISE_RENDERED_KEY = 'pm_promise_rendered';

export type DataUseGateStatus = 'disabled' | 'loading' | 'error' | 'required' | 'acknowledged';

export interface DataUseGateValue {
  status: DataUseGateStatus;
  settings: ClaritySettings | null;
  promiseShown: boolean;
  markPromiseShown: () => void;
  /**
   * Whether new financial inputs may be submitted. Reading, correcting,
   * exporting, and deleting records are never gated by this value.
   */
  financialInputsEnabled: boolean;
  /** Why new inputs are paused, or null when they are enabled. */
  reason: string | null;
  acknowledge: () => Promise<boolean>;
  acknowledging: boolean;
  acknowledgeError: string | null;
  setAnalytics: (enabled: boolean) => Promise<boolean>;
  analyticsPending: boolean;
  analyticsError: string | null;
  retry: () => void;
}

const NOOP_VALUE: DataUseGateValue = Object.freeze({
  status: 'disabled',
  settings: null,
  promiseShown: true,
  markPromiseShown: () => {},
  financialInputsEnabled: true,
  reason: null,
  acknowledge: async () => false,
  acknowledging: false,
  acknowledgeError: null,
  setAnalytics: async () => false,
  analyticsPending: false,
  analyticsError: null,
  retry: () => {},
});

const DataUseGateContext = createContext<DataUseGateValue>(NOOP_VALUE);

/** Pages read this to pause new-input submit buttons and show `reason` beside them. */
export function useDataUseGate(): DataUseGateValue {
  return useContext(DataUseGateContext);
}

function readPromiseFlag(userId: number | undefined): boolean {
  if (userId === undefined) return false;
  try {
    return sessionStorage.getItem(PROMISE_RENDERED_KEY) === String(userId);
  } catch {
    return false;
  }
}

function writePromiseFlag(userId: number | undefined): void {
  if (userId === undefined) return;
  try {
    sessionStorage.setItem(PROMISE_RENDERED_KEY, String(userId));
  } catch {
    // The flag is a convenience. The promise is still rendered without it.
  }
}

function messageOf(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Something went wrong. Please try again.';
}

function reasonFor(
  status: DataUseGateStatus,
  promiseShown: boolean,
  noticeVersion: number | null,
): string | null {
  if (status === 'disabled') return null;
  if (status === 'loading') return 'Checking your data-use settings.';
  if (status === 'error') {
    return 'Your data-use status could not be confirmed. Retry to continue.';
  }
  if (status === 'required') {
    return `Review and acknowledge the data-use notice${noticeVersion === null ? '' : ` (version ${noticeVersion})`} to add new financial entries.`;
  }
  if (!promiseShown) return 'Read the Project Money promise first, then new entries turn on.';
  return null;
}

export interface DataUseGateProviderProps {
  children: ReactNode;
  /** Overrides the VITE_FINANCIAL_CLARITY_ENABLED rollout flag. Used by tests. */
  enabled?: boolean;
}

export function DataUseGateProvider({ children, enabled }: DataUseGateProviderProps) {
  const rolloutEnabled = enabled ?? selectFinancialClarityRollout().enabled;
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const userId = user?.id;
  const active = rolloutEnabled && userId !== undefined && !!getToken();

  const [promiseShown, setPromiseShown] = useState(() => readPromiseFlag(userId));
  // This provider stays mounted across sign-in, sign-out, and a change of user, so
  // re-read the session flag for the new user instead of keeping the previous one.
  const [promiseUserId, setPromiseUserId] = useState(userId);
  if (promiseUserId !== userId) {
    setPromiseUserId(userId);
    setPromiseShown(readPromiseFlag(userId));
  }
  const markPromiseShown = useCallback(() => {
    writePromiseFlag(userId);
    setPromiseShown(true);
  }, [userId]);

  const query = useQuery({
    queryKey: queryKeys.settings(),
    queryFn: fetchClaritySettings,
    enabled: active,
    retry: (failureCount, error) => (
      failureCount < 1 && (!(error instanceof ApiError) || error.status === 0 || error.status >= 500)
    ),
    retryDelay: 500,
  });

  // A command rejected with 428 means the cached acknowledgement is stale.
  useEffect(() => {
    if (!active) return undefined;
    const onNoticeRequired = () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings() });
    };
    window.addEventListener(DATA_NOTICE_REQUIRED_EVENT, onNoticeRequired);
    return () => window.removeEventListener(DATA_NOTICE_REQUIRED_EVENT, onNoticeRequired);
  }, [active, queryClient]);

  const store = useCallback(
    (next: ClaritySettings) => {
      queryClient.setQueryData(queryKeys.settings(), next);
    },
    [queryClient],
  );

  const acknowledgeMutation = useMutation({
    mutationFn: (version: number) => acknowledgeDataUseNotice(version),
    onSuccess: store,
  });
  const analyticsMutation = useMutation({
    mutationFn: (next: boolean) => setProductAnalyticsEnabled(next),
    onSuccess: store,
  });

  const settings = active ? (query.data ?? null) : null;

  // The measurement client sends only while the confirmed setting is on. It is
  // cleared when this provider unmounts (sign-out) or the rollout flag is off.
  const analyticsConfirmed = analyticsConsentFromSettings(settings);
  useEffect(() => {
    measurement.setAnalyticsConsent(analyticsConfirmed);
  }, [analyticsConfirmed]);
  useEffect(() => () => measurement.setAnalyticsConsent(false), []);

  let status: DataUseGateStatus;
  if (!active) status = 'disabled';
  else if (settings) status = settings.dataUseNotice.acknowledgementRequired ? 'required' : 'acknowledged';
  else if (query.isError) status = 'error';
  else status = 'loading';

  const { mutateAsync: acknowledgeAsync } = acknowledgeMutation;
  const { mutateAsync: analyticsAsync } = analyticsMutation;
  const noticeVersion = settings?.dataUseNotice.version ?? null;

  const acknowledge = useCallback(async () => {
    if (noticeVersion === null) return false;
    try {
      await acknowledgeAsync(noticeVersion);
      return true;
    } catch {
      return false;
    }
  }, [acknowledgeAsync, noticeVersion]);

  const setAnalytics = useCallback(
    async (next: boolean) => {
      // An opt-out request stops sending immediately, before the server confirms.
      // If the request fails, sending stays paused until the confirmed setting changes.
      if (!next) measurement.setAnalyticsConsent(false);
      try {
        await analyticsAsync(next);
        return true;
      } catch {
        return false;
      }
    },
    [analyticsAsync],
  );

  const { refetch } = query;
  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);

  const reason = reasonFor(status, promiseShown, noticeVersion);
  const value = useMemo<DataUseGateValue>(
    () => ({
      status,
      settings,
      promiseShown,
      markPromiseShown,
      financialInputsEnabled: status === 'disabled' || (status === 'acknowledged' && promiseShown),
      reason,
      acknowledge,
      acknowledging: acknowledgeMutation.isPending,
      acknowledgeError: acknowledgeMutation.isError ? messageOf(acknowledgeMutation.error) : null,
      setAnalytics,
      analyticsPending: analyticsMutation.isPending,
      analyticsError: analyticsMutation.isError ? messageOf(analyticsMutation.error) : null,
      retry,
    }),
    [
      status, settings, promiseShown, markPromiseShown, reason, acknowledge, setAnalytics, retry,
      acknowledgeMutation.isPending, acknowledgeMutation.isError, acknowledgeMutation.error,
      analyticsMutation.isPending, analyticsMutation.isError, analyticsMutation.error,
    ],
  );

  return <DataUseGateContext.Provider value={value}>{children}</DataUseGateContext.Provider>;
}

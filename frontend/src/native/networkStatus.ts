// Network status for the Android app (requirement 7): the online/offline store, the friendly failure
// description, and the stale-data rule. Everything here is plain TypeScript with no React, so it can be
// tested without a renderer. The listeners are not gated on the native platform; only the component that
// shows the notice is (see OfflineBanner).
import { ApiError, REQUEST_TIMEOUT_CODE } from '../api';

/** How long the first request of a session may stay pending before the "free server is waking up" hint appears. */
export const COLD_START_HINT_DELAY_MS = 5000;

export const MESSAGE_TIMEOUT = 'The server did not answer in time. Check your connection and retry.';
export const MESSAGE_UNREACHABLE = 'Could not reach the server. Check your connection and retry.';
export const MESSAGE_GENERIC = 'Something went wrong. Retry.';

/** HTTP statuses a gateway returns while the free Render instance is still waking (the Cold_Start). */
const GATEWAY_COLD_START_STATUSES: readonly number[] = [502, 503, 504];

/**
 * Subscribes to the browser `online` and `offline` events, which the Android WebView also fires.
 * The callback takes no arguments; read the current value with `getOnlineStatusSnapshot`.
 */
export function subscribeOnlineStatus(callback: () => void): () => void {
  window.addEventListener('online', callback);
  window.addEventListener('offline', callback);
  return () => {
    window.removeEventListener('online', callback);
    window.removeEventListener('offline', callback);
  };
}

/** True while the device reports it is online. Pair with `subscribeOnlineStatus` in `useSyncExternalStore`. */
export function getOnlineStatusSnapshot(): boolean {
  return typeof navigator === 'undefined' ? true : navigator.onLine !== false;
}

/**
 * Maps a failed request to one of three fixed, retry-oriented messages. The original error text
 * (for example "TypeError: Failed to fetch") is never returned.
 */
export function describeFetchFailure(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === REQUEST_TIMEOUT_CODE) return MESSAGE_TIMEOUT;
    if (GATEWAY_COLD_START_STATUSES.includes(error.status)) return MESSAGE_UNREACHABLE;
    return MESSAGE_GENERIC;
  }
  if (error instanceof TypeError || (error instanceof Error && error.name === 'AbortError')) {
    return MESSAGE_UNREACHABLE;
  }
  return MESSAGE_GENERIC;
}

/**
 * Cached or older figures are never shown as fresh: the notice is required when there is data on screen
 * and the device is offline or the last refresh failed.
 */
export function shouldShowStaleDataNotice(input: {
  isOffline: boolean;
  lastFetchFailed: boolean;
  hasData: boolean;
}): boolean {
  return input.hasData && (input.isOffline || input.lastFetchFailed);
}

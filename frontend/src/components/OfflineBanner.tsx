import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { isNativePlatform } from '../platform';
import { getOnlineStatusSnapshot, subscribeOnlineStatus } from '../native/networkStatus';

export const OFFLINE_NOTICE_TEXT = "You're offline. The figures on screen may be out of date.";

function OfflineNotice() {
  const queryClient = useQueryClient();
  const online = useSyncExternalStore(subscribeOnlineStatus, getOnlineStatusSnapshot, () => true);
  const wasOffline = useRef(!online);

  // Coming back online refetches the active queries without user action (requirement 7.3).
  useEffect(() => {
    if (!online) {
      wasOffline.current = true;
      return;
    }
    if (wasOffline.current) {
      wasOffline.current = false;
      void queryClient.refetchQueries({ type: 'active' });
    }
  }, [online, queryClient]);

  if (online) return null;
  return (
    <div className="offline-banner" role="status" aria-live="polite">
      <span className="offline-banner-text">{OFFLINE_NOTICE_TEXT}</span>
      <button
        type="button"
        className="btn offline-banner-retry"
        onClick={() => void queryClient.refetchQueries({ type: 'active' })}
      >
        Retry
      </button>
    </div>
  );
}

/**
 * The persistent offline notice for the Android app. It renders nothing on the web, and never takes focus.
 * Mounted once from App.
 */
export function OfflineBanner() {
  if (!isNativePlatform()) return null;
  return <OfflineNotice />;
}

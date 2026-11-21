import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useLocation } from 'react-router-dom';
import { measurement } from '../clarity/measurement';
import { visitRouteForPath, type VisitRoute } from '../clarity/visitRoutes';

/**
 * Sends a page-view beacon on every route change. Best effort: failures are
 * dropped so analytics never breaks the UI.
 *
 * The beacon carries a fixed route key such as `plan` or `trip_detail`, never a
 * path, so record ids, share tokens, and query strings are not reported.
 *
 * - Signed-out visitors report public routes only.
 * - Signed-in visits are sent only while the confirmed Product Analytics
 *   setting is on, and never when the clarity rollout flag is off.
 * - A route that could not be sent yet (the setting is still loading) is sent
 *   once, when the setting is confirmed on. Turning analytics off clears the
 *   record, so turning it on again reports the current page.
 */
export function useVisitTracker() {
  const location = useLocation();
  const analyticsEnabled = useSyncExternalStore(
    measurement.subscribe,
    measurement.getAnalyticsConsent,
    () => false,
  );
  const lastSent = useRef<VisitRoute | null>(null);
  const wasEnabled = useRef(false);

  useEffect(() => {
    if (wasEnabled.current && !analyticsEnabled) lastSent.current = null;
    wasEnabled.current = analyticsEnabled;
    const route = visitRouteForPath(location.pathname);
    if (lastSent.current === route) return;
    if (measurement.trackVisit(route)) lastSent.current = route;
  }, [location.pathname, analyticsEnabled]);
}

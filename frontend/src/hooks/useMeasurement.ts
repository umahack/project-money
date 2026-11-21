import { useMemo, useSyncExternalStore } from 'react';
import { measurement, type MeasurementClient } from '../clarity/measurement';

export interface UseMeasurement extends Pick<
  MeasurementClient,
  | 'journeyStarted'
  | 'firstOutcomeDisplayed'
  | 'clarityResponse'
  | 'recommendedActionCompleted'
  | 'financialChangeUi'
> {
  /** True while the confirmed Product Analytics setting is on. Informational only. */
  analyticsEnabled: boolean;
}

/**
 * Typed Product Analytics events for pages. See `clarity/measurement.md`.
 *
 * - Call an event function once, when the thing it reports actually happens.
 *   It returns immediately, never throws, and never changes what the page renders.
 * - Do not branch UI on `analyticsEnabled`, and never wait for an event to be sent.
 *   The functions already do nothing while analytics is off or the rollout flag is off.
 * - Pass only the fields in each function's input type. No amount, name, note, URL,
 *   or other value can be passed.
 */
export function useMeasurement(): UseMeasurement {
  const analyticsEnabled = useSyncExternalStore(
    measurement.subscribe,
    measurement.getAnalyticsConsent,
    () => false,
  );
  return useMemo(
    () => ({
      analyticsEnabled,
      journeyStarted: measurement.journeyStarted,
      firstOutcomeDisplayed: measurement.firstOutcomeDisplayed,
      clarityResponse: measurement.clarityResponse,
      recommendedActionCompleted: measurement.recommendedActionCompleted,
      financialChangeUi: measurement.financialChangeUi,
    }),
    [analyticsEnabled],
  );
}

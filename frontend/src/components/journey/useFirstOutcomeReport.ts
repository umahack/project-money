import { useEffect } from 'react';
import { subscribeToFinancialStateClear } from '../../clarity/stateLifecycle';
import type { GuidedJourneyView } from '../../clarity/journeys';
import {
  MEASUREMENT_OUTCOME_KINDS,
  type MeasurementDesiredOutcome,
  type MeasurementOutcomeKind,
} from '../../clarity/measurement';
import { useMeasurement } from '../../hooks/useMeasurement';

/**
 * Journey ids whose first outcome was reported during this page session. Memory
 * only, so nothing about a journey reaches browser storage. It lets a return to
 * the page, or a resume after a pause, skip a result the user has already seen.
 */
const reportedJourneyIds = new Set<number>();
const MAX_REMEMBERED = 50;

const FALLBACK_KIND: Readonly<Record<MeasurementDesiredOutcome, MeasurementOutcomeKind>> = Object.freeze({
  plan_month: 'monthly_plan',
  control_spending: 'spending',
  fund_goal: 'goal',
  settle_trip: 'trip',
});

/** Forgets what was reported. Runs at sign-out, and between tests. */
export function resetFirstOutcomeReports(): void {
  reportedJourneyIds.clear();
}

subscribeToFinancialStateClear(resetFirstOutcomeReports);

/** The server's outcome kind when it is one the closed event schema accepts, else the fixed kind for the journey. */
export function outcomeKindFor(journey: Pick<GuidedJourneyView, 'desiredOutcome' | 'firstOutcome'>): MeasurementOutcomeKind {
  const kind = journey.firstOutcome.kind;
  return (MEASUREMENT_OUTCOME_KINDS as readonly string[]).includes(kind)
    ? (kind as MeasurementOutcomeKind)
    : FALLBACK_KIND[journey.desiredOutcome];
}

/**
 * Reports `first_outcome_displayed` once per journey, when the first result is
 * actually on screen (the journey is active and the server says it is available)
 * and Product Analytics is on.
 *
 * A page re-render, a return to the page, or a resume after a pause does not
 * repeat it within this page session. While analytics is off nothing is sent or
 * remembered, so a result that is still on screen when the confirmed setting
 * arrives (or is switched on) is reported then. The send is fire-and-forget, is
 * dropped by the measurement client when the rollout flag is off, and never
 * changes what is shown.
 */
export function useFirstOutcomeReport(journey: GuidedJourneyView | null | undefined): void {
  const { analyticsEnabled, firstOutcomeDisplayed } = useMeasurement();

  const journeyId = journey?.id ?? null;
  const displayed = !!journey && journey.status === 'active' && journey.firstOutcome.available;
  const kind = journey ? outcomeKindFor(journey) : null;

  useEffect(() => {
    if (journeyId === null || kind === null || !displayed || !analyticsEnabled) return;
    if (reportedJourneyIds.has(journeyId)) return;
    if (reportedJourneyIds.size >= MAX_REMEMBERED) reportedJourneyIds.clear();
    reportedJourneyIds.add(journeyId);
    firstOutcomeDisplayed({ journeyId, outcomeKind: kind });
  }, [analyticsEnabled, displayed, firstOutcomeDisplayed, journeyId, kind]);
}

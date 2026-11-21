import { skipToken, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { JOURNEY_ROUTE, stepCopy, type GuidedJourneyView } from '../../clarity/journeys';
import { queryKeys } from '../../clarity/queryClient';
import './journey.css';

/**
 * A link back to the open trip journey, shown on the Trips pages. It only reads
 * the journey this browser tab already loaded, so it adds no request, and it
 * shows only while a trip journey is open and active. The link is the fixed
 * `/start` route: no value, name, or id is placed in the address, and the journey
 * itself asks the server where the user left off.
 */
export function JourneyReturnLink() {
  const { data } = useQuery<GuidedJourneyView | null>({
    queryKey: queryKeys.journey(null),
    queryFn: skipToken,
  });
  if (!data || data.status !== 'active' || data.desiredOutcome !== 'settle_trip' || data.currentStepKey === null) return null;
  return (
    <p className="journey-return small">
      <Link to={JOURNEY_ROUTE}>← Back to your guided journey: {stepCopy(data.currentStepKey).title}</Link>
    </p>
  );
}

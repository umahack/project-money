import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DataUseGateProvider } from '../clarity/DataUseGateProvider';
import { FinancialClarityProvider } from '../clarity/FinancialClarityProvider';
import { parseJourneyView } from '../clarity/journeys';
import { MutationStatusProvider } from '../clarity/MutationStatusProvider';
import { queryKeys } from '../clarity/queryClient';
import { DATA_USE_REASON_ID, DataUseGate } from '../components/clarity';
import { currentMonth } from '../money';
import { FULL_HIGHLIGHTS, TRIP_ACTION, tripItemOutcome } from '../test/homeSummaryFixtures';
import { buildSettings } from '../test/dataUseFixtures';
import { mockTripApi, readSnapshot, tripSnapshot } from '../test/tripFixtures';
import { createTestQueryClient, renderAuthenticated } from '../test/test-utils';
import { Trips } from './Trips';

const MONTH = currentMonth();

const trip = (id: number, name: string) => ({
  id,
  name,
  destination: `${name} place`,
  budget: 1000 * id,
  start_date: null,
  end_date: null,
  role: 'owner',
});
// The server lists newest first.
const LIST = { trips: [trip(7, 'Kerala'), trip(5, 'Goa weekend'), trip(3, 'Manali')] };

function renderTrips(options: { gate?: boolean } = {}) {
  const page = options.gate
    ? (
      <DataUseGateProvider enabled>
        <DataUseGate />
        <Trips />
      </DataUseGateProvider>
    )
    : <Trips />;
  return renderAuthenticated(
    <FinancialClarityProvider>
      <MutationStatusProvider>{page}</MutationStatusProvider>
    </FinancialClarityProvider>,
    { route: '/trips', queryClient: createTestQueryClient() },
  );
}

const headingsOf = () => screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent);

beforeEach(() => {
  vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'true');
});

describe('Trips', () => {
  it('lists trips in the server order with no clarity requests when the flag is off', async () => {
    vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'false');
    const api = mockTripApi({ 'GET /trips': LIST });
    renderTrips();
    await screen.findByText('Kerala');
    expect(headingsOf()).toEqual(['Kerala', 'Goa weekend', 'Manali']);
    expect(screen.getByRole('heading', { level: 1, name: /Trips & splits/ })).toBeInTheDocument();
    expect(screen.queryByText(/nearest settlement first/)).toBeNull();
    expect(api.to('GET', '/finance/clarity')).toHaveLength(0);
  });

  it('puts the trip with the nearest settlement first, then ranked settle actions, then the rest', async () => {
    const snapshot = tripSnapshot(MONTH, {
      highlights: { urgentGoal: null, nearestTripSettlement: { ...FULL_HIGHLIGHTS.nearestTripSettlement!, tripId: 5, name: 'Goa weekend' } },
      actions: [{ ...TRIP_ACTION, id: 'action:settle_trip_balance:trip:3', context: { recordType: 'trip', recordId: 3 } }],
      items: [tripItemOutcome(7, MONTH, 1), tripItemOutcome(5, MONTH, 1), tripItemOutcome(3, MONTH, 1)],
    });
    mockTripApi({ 'GET /trips': LIST, 'GET /finance/clarity': readSnapshot(snapshot) });
    renderTrips();
    await waitFor(() => expect(headingsOf()).toEqual(['Goa weekend', 'Manali', 'Kerala']));
    const list = screen.getByRole('list', { name: 'Trips, nearest settlement first' });
    const first = within(list).getAllByRole('listitem')[0]!;
    // The wording comes from the server's highlight; nothing is added up here.
    expect(first).toHaveTextContent('You are owed ₹500 (receivable)');
    expect(within(list).getAllByRole('listitem')[2]).toHaveTextContent('Open balances');
  });

  it('keeps the server order when no trip has a ranked settlement, and says when every balance is settled', async () => {
    const settled = tripItemOutcome(5, MONTH, 1);
    settled.value = {
      ...settled.value!,
      balances: [{ memberId: 101, amountMinor: 0, label: 'settled' }, { memberId: 102, amountMinor: 0, label: 'settled' }],
    };
    const snapshot = tripSnapshot(MONTH, { items: [tripItemOutcome(7, MONTH, 1), settled, tripItemOutcome(3, MONTH, 1)] });
    mockTripApi({ 'GET /trips': LIST, 'GET /finance/clarity': readSnapshot(snapshot) });
    renderTrips();
    await screen.findByText('All settled');
    expect(headingsOf()).toEqual(['Kerala', 'Goa weekend', 'Manali']);
  });

  it('keeps the list when the snapshot cannot be read', async () => {
    mockTripApi({ 'GET /trips': LIST });
    renderTrips();
    await screen.findByText('Kerala');
    expect(headingsOf()).toEqual(['Kerala', 'Goa weekend', 'Manali']);
    expect(screen.queryByText(/You are owed/)).toBeNull();
  });

  it('pauses creating a trip with a visible reason while the data-use notice is unacknowledged', async () => {
    const user = userEvent.setup();
    mockTripApi({ 'GET /clarity/settings': buildSettings(), 'GET /trips': LIST, 'GET /finance/clarity': readSnapshot(tripSnapshot(MONTH)) });
    renderTrips({ gate: true });
    await screen.findByText('Kerala');
    await waitFor(() => expect(document.getElementById(DATA_USE_REASON_ID)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: '+ New trip' }));
    const create = await screen.findByRole('button', { name: 'Create trip' });
    expect(create).toBeDisabled();
    expect(create).toHaveAttribute('aria-describedby', DATA_USE_REASON_ID);
  });

  it('shows the field-level correction for an invalid budget and creates nothing', async () => {
    const user = userEvent.setup();
    const api = mockTripApi({ 'GET /trips': LIST, 'GET /finance/clarity': readSnapshot(tripSnapshot(MONTH)) });
    renderTrips();
    await screen.findByText('Kerala');
    await user.click(screen.getByRole('button', { name: '+ New trip' }));
    await user.type(await screen.findByRole('textbox', { name: 'Trip name' }), 'Hampi');
    await user.type(screen.getByRole('textbox', { name: 'Total budget (₹)' }), 'lots');
    await user.click(screen.getByRole('button', { name: 'Create trip' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Total budget is not an accepted amount');
    expect(api.to('POST', '/trips')).toHaveLength(0);
    expect(screen.getByRole('textbox', { name: 'Trip name' })).toHaveValue('Hampi');
  });
});

describe('Trips return link to an open journey', () => {
  const openTripJourney = () => {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(queryKeys.journey(null), parseJourneyView({
      id: 1,
      desiredOutcome: 'settle_trip',
      status: 'active',
      requiredStepKeys: ['trip', 'trip_members', 'trip_split'],
      optionalStepKeys: ['personal_expense'],
      currentStepKey: 'trip_members',
      nextIncompleteStepKey: 'trip_members',
      progress: { requiredTotal: 3, requiredCompleted: 1, requiredRemaining: 2, currentStepNumber: 2 },
      steps: [{ key: 'trip', required: true, status: 'satisfied', confirmedChangeId: null }],
      firstOutcome: { available: false, kind: 'trip', outcomeId: null },
    }));
    return queryClient;
  };
  const renderWith = (queryClient: ReturnType<typeof createTestQueryClient>) => renderAuthenticated(
    <FinancialClarityProvider>
      <MutationStatusProvider><Trips /></MutationStatusProvider>
    </FinancialClarityProvider>,
    { route: '/trips', queryClient },
  );

  it('links back to the fixed journey route while a trip journey is open', async () => {
    mockTripApi({ 'GET /trips': LIST, 'GET /finance/clarity': readSnapshot(tripSnapshot(MONTH)) });
    renderWith(openTripJourney());
    await screen.findByText('Kerala');
    expect(screen.getByRole('link', { name: /Back to your guided journey: Add the people on the trip/ })).toHaveAttribute('href', '/start');
  });

  it('shows no link without an open journey, and none with the rollout off', async () => {
    mockTripApi({ 'GET /trips': LIST, 'GET /finance/clarity': readSnapshot(tripSnapshot(MONTH)) });
    const view = renderWith(createTestQueryClient());
    await screen.findByText('Kerala');
    expect(screen.queryByRole('link', { name: /guided journey/ })).toBeNull();
    view.unmount();

    vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'false');
    mockTripApi({ 'GET /trips': LIST });
    renderWith(openTripJourney());
    await screen.findByText('Kerala');
    expect(screen.queryByRole('link', { name: /guided journey/ })).toBeNull();
  });
});

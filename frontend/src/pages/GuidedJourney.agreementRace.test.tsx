// Task 9.2 of data-use-agreement-page: a fresh load of /start?start=plan_month for a user who must agree.
//
// The journey query can answer before the settings query. The journey page must not consume the start intent or
// start a journey (the server answers 428) while the data-use gate is still loading. The redirect to /agreement then
// carries the whole location, and after agreeing the user lands on the journey they asked for.
// The real App, route tree, gate providers, Agreement page and journey page run here. Shell is a marker.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import { FinancialClarityProvider } from '../clarity/FinancialClarityProvider';
import { MutationStatusProvider } from '../clarity/MutationStatusProvider';
import { deferred } from '../test/clarity-fixtures';
import { buildSettings } from '../test/dataUseFixtures';
import { FakeJourneyServer, installJourneyFetch } from '../test/journeyBackend';
import { heading2, salaryRoutes } from '../test/journeyPage';
import { renderAuthenticated } from '../test/test-utils';

vi.mock('../components/Shell', async () => {
  const { createElement, Fragment } = await import('react');
  const { Outlet, useLocation } = await import('react-router-dom');
  return {
    Background: () => null,
    Shell: () => createElement(
      Fragment,
      null,
      createElement(function Where() {
        const loc = useLocation();
        return createElement('output', { 'data-testid': 'location' }, loc.pathname + loc.search);
      }),
      createElement(Outlet),
    ),
  };
});

class NoopIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
}

beforeEach(() => {
  vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'true');
  vi.stubGlobal('IntersectionObserver', NoopIntersectionObserver);
});

describe('fresh load of /start?start=plan_month while the settings answer is slow', () => {
  it('keeps the start intent through the redirect to /agreement and starts the journey only after agreeing', async () => {
    const server = new FakeJourneyServer();
    const settingsGate = deferred<void>();
    const fetches = installJourneyFetch(server, {
      ...salaryRoutes(server),
      'GET /clarity/settings': async () => {
        await settingsGate.promise;
        return { status: 200, body: buildSettings({ acknowledgedVersion: 0 }) };
      },
      'PATCH /clarity/settings': buildSettings({ acknowledgedVersion: 1 }),
    });

    renderAuthenticated(
      <FinancialClarityProvider>
        <MutationStatusProvider>
          <App />
        </MutationStatusProvider>
      </FinancialClarityProvider>,
      { route: '/start?start=plan_month' },
    );

    // The journey query answers first. The settings answer is still pending.
    await waitFor(() => expect(fetches.to('GET', '/clarity/journeys/active').length).toBeGreaterThan(0));
    await waitFor(() => expect(fetches.to('GET', '/clarity/settings')).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetches.to('POST', '/clarity/journeys')).toHaveLength(0);
    expect(screen.getByTestId('location')).toHaveTextContent('/start?start=plan_month');
    expect(server.startsCreated).toBe(0);

    // The settings answer says the notice is required: the user is redirected, and nothing was started.
    settingsGate.resolve();
    const agree = await screen.findByRole('button', { name: 'I agree and continue' });
    expect(fetches.to('POST', '/clarity/journeys')).toHaveLength(0);

    await userEvent.setup().click(agree);

    // The intent was still in the address, so the journey the user asked for starts now.
    await heading2('Add your monthly pay');
    expect(fetches.to('PATCH', '/clarity/settings')).toHaveLength(1);
    expect(fetches.to('POST', '/clarity/journeys').map((call) => call.body)).toEqual([{ desiredOutcome: 'plan_month' }]);
    expect(server.startsCreated).toBe(1);
    expect(screen.getByTestId('location')).toHaveTextContent('/start');
  });

  it('starts the journey once the settings answer says the notice is already acknowledged', async () => {
    const server = new FakeJourneyServer();
    const settingsGate = deferred<void>();
    const fetches = installJourneyFetch(server, {
      ...salaryRoutes(server),
      'GET /clarity/settings': async () => {
        await settingsGate.promise;
        return { status: 200, body: buildSettings({ acknowledgedVersion: 1 }) };
      },
    });

    renderAuthenticated(
      <FinancialClarityProvider>
        <MutationStatusProvider>
          <App />
        </MutationStatusProvider>
      </FinancialClarityProvider>,
      { route: '/start?start=plan_month' },
    );

    await waitFor(() => expect(fetches.to('GET', '/clarity/journeys/active').length).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetches.to('POST', '/clarity/journeys')).toHaveLength(0);

    settingsGate.resolve();
    await heading2('Add your monthly pay');
    expect(fetches.to('POST', '/clarity/journeys').map((call) => call.body)).toEqual([{ desiredOutcome: 'plan_month' }]);
    expect(screen.queryByRole('button', { name: 'I agree and continue' })).toBeNull();
    expect(screen.getByTestId('location')).toHaveTextContent('/start');
  });
});

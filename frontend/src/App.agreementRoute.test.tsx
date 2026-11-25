// Tasks 3.3 and 2.3 of data-use-agreement-page: the /agreement route and the cases where it never redirects.
//
// The real App, route tree, DataUseGateProvider and AgreementGateProvider run here. Only the pages that need their own
// network data are replaced by markers that print the gate status they can see, and Shell is a marker that prints the
// location and renders its Outlet. Requirements 1.1, 1.5, 1.6, 5.1, 5.2, 5.3, 6.1, 6.2, 6.3, 6.4.
import { screen, waitFor } from '@testing-library/react';
import { Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { AgreementGateProvider } from './clarity/AgreementGateProvider';
import { DataUseGateProvider } from './clarity/DataUseGateProvider';
import { Agreement } from './pages/Agreement';
import { buildSettings } from './test/claritySettingsBuilder';
import { createApiResponse, createTestUser, renderAuthenticated, renderWithProviders } from './test/test-utils';

/** A page marker that prints the status of the gate it is rendered under. */
const probe = vi.hoisted(() => async (testId: string) => {
  const { createElement } = await import('react');
  const { useDataUseGate } = await import('./clarity/DataUseGateProvider');
  return function Probe() {
    const { status } = useDataUseGate();
    return createElement('p', { 'data-testid': testId, 'data-status': status }, status);
  };
});

vi.mock('./components/Shell', async () => {
  const { createElement, Fragment } = await import('react');
  const { Outlet, useLocation: useLoc } = await import('react-router-dom');
  const Gate = await probe('shell');
  return {
    Background: () => null,
    Shell: () => createElement(
      Fragment,
      null,
      createElement(Gate),
      createElement(function Where() { return createElement('p', { 'data-testid': 'location' }, useLoc().pathname); }),
      createElement(Outlet),
    ),
  };
});
vi.mock('./pages/Dashboard', async () => ({ Dashboard: await probe('home') }));
vi.mock('./pages/Settings', async () => ({ Settings: await probe('settings') }));
vi.mock('./pages/admin/AdminOverview', async () => ({ AdminOverview: await probe('admin') }));
vi.mock('./pages/admin/AdminUsers', async () => ({ AdminUsers: await probe('admin-users') }));
vi.mock('./pages/PublicTrip', async () => ({ PublicTrip: await probe('public-trip') }));
vi.mock('./pages/Legal', async () => ({ Privacy: await probe('privacy'), Terms: await probe('terms') }));

const ROLLOUT = 'VITE_FINANCIAL_CLARITY_ENABLED';
const AGREEMENT_HEADING = 'Review how Project Money uses your data';
const NOT_FOUND_HEADING = 'Lost your way?';

class NoopIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
}

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

/** The settings request answers with the given notice state, and every other request is refused. */
function installNetwork(acknowledgedVersion: number) {
  const fetchMock = vi.mocked(globalThis.fetch);
  fetchMock.mockImplementation(async (input) => {
    if (urlOf(input).includes('/clarity/settings')) {
      return createApiResponse({ body: buildSettings({ acknowledgedVersion }) });
    }
    return createApiResponse({ status: 404, body: { error: { code: 'NOT_FOUND', message: 'Not found.' } } });
  });
  return fetchMock;
}

const settingsRequests = (fetchMock: ReturnType<typeof installNetwork>) =>
  fetchMock.mock.calls.filter(([input]) => urlOf(input).includes('/clarity/settings'));

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', NoopIntersectionObserver);
});

describe('Rollout_Flag off', () => {
  beforeEach(() => {
    vi.stubEnv(ROLLOUT, '');
  });

  it('has no /agreement route for a signed-in user: the catch-all shows, with no redirect and no settings request', async () => {
    const fetchMock = installNetwork(0);
    renderAuthenticated(<App />, { route: '/agreement' });

    expect(await screen.findByRole('heading', { name: NOT_FOUND_HEADING })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: AGREEMENT_HEADING })).toBeNull();
    // The signed-in catch-all keeps the Shell, and nothing moved the location.
    expect(screen.getByTestId('shell')).toHaveAttribute('data-status', 'disabled');
    expect(screen.getByTestId('location')).toHaveTextContent('/agreement');
    expect(settingsRequests(fetchMock)).toHaveLength(0);
  });

  it('treats /agreement as any unknown path for a visitor who is not signed in, not as the Agreement_Page', async () => {
    installNetwork(0);
    renderWithProviders(<App />, { route: '/agreement' });

    // The guarded catch-all sends a visitor without a session to sign-in, as it does for every unknown path.
    expect(await screen.findByRole('heading', { level: 1, name: 'Welcome back' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: AGREEMENT_HEADING })).toBeNull();
  });

  it('reports the gate as disabled and does not redirect a signed-in route, whatever the server would say', async () => {
    const fetchMock = installNetwork(0);
    renderAuthenticated(<App />, { route: '/' });

    const home = await screen.findByTestId('home');
    expect(home).toHaveAttribute('data-status', 'disabled');
    expect(screen.getByTestId('location')).toHaveTextContent('/');
    expect(screen.queryByRole('heading', { name: AGREEMENT_HEADING })).toBeNull();
    expect(settingsRequests(fetchMock)).toHaveLength(0);
  });
});

describe('Rollout_Flag on', () => {
  beforeEach(() => {
    vi.stubEnv(ROLLOUT, 'true');
  });

  it('sends a visitor who is not signed in from /agreement to sign-in', async () => {
    installNetwork(0);
    renderWithProviders(<App />, { route: '/agreement' });

    expect(await screen.findByRole('heading', { level: 1, name: 'Welcome back' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: AGREEMENT_HEADING })).toBeNull();
  });

  it('renders the Agreement_Page outside Shell while the notice is required, and redirects other routes to it', async () => {
    installNetwork(0);
    renderAuthenticated(<App />, { route: '/' });

    expect(await screen.findByRole('heading', { level: 1, name: AGREEMENT_HEADING })).toBeInTheDocument();
    expect(screen.queryByTestId('shell')).toBeNull();
    expect(screen.queryByTestId('home')).toBeNull();
  });

  it('renders the Agreement_Page at /agreement itself while the notice is required, outside Shell', async () => {
    installNetwork(0);
    renderAuthenticated(<App />, { route: '/agreement' });

    expect(await screen.findByRole('button', { name: 'I agree and continue' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: AGREEMENT_HEADING })).toBeInTheDocument();
    expect(screen.queryByTestId('shell')).toBeNull();
  });

  it('sends /agreement to Home while the notice is acknowledged', async () => {
    installNetwork(1);
    renderAuthenticated(<App />, { route: '/agreement' });

    const home = await screen.findByTestId('home');
    expect(home).toHaveAttribute('data-status', 'acknowledged');
    expect(screen.getByTestId('location')).toHaveTextContent('/');
    expect(screen.queryByRole('heading', { name: AGREEMENT_HEADING })).toBeNull();
  });

  it('sends /agreement to Home while the gate is disabled', async () => {
    // With the flag on, the gate is disabled when there is no session to read settings for. This is the same
    // provider tree and the same Agreement route element that App mounts, with the gate switched off.
    function Where() {
      return <p data-testid="location">{useLocation().pathname}</p>;
    }
    const fetchMock = installNetwork(0);
    renderAuthenticated(
      <DataUseGateProvider enabled={false}>
        <AgreementGateProvider>
          <Where />
          <Routes>
            <Route path="/agreement" element={<Agreement />} />
            <Route path="/" element={<p data-testid="home">Home</p>} />
          </Routes>
        </AgreementGateProvider>
      </DataUseGateProvider>,
      { route: '/agreement' },
    );

    expect(await screen.findByTestId('home')).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/');
    expect(screen.queryByRole('heading', { name: AGREEMENT_HEADING })).toBeNull();
    expect(settingsRequests(fetchMock)).toHaveLength(0);
  });

  describe('while the notice is required, these routes are never redirected', () => {
    const routes: Array<{ name: string; path: string; testId: string; admin?: boolean; inShell: boolean }> = [
      { name: '/settings', path: '/settings', testId: 'settings', inShell: true },
      { name: '/admin', path: '/admin', testId: 'admin', admin: true, inShell: true },
      { name: '/admin/users', path: '/admin/users', testId: 'admin-users', admin: true, inShell: true },
      { name: '/terms (public)', path: '/terms', testId: 'terms', inShell: false },
      { name: '/privacy (public)', path: '/privacy', testId: 'privacy', inShell: false },
      { name: '/share/trip/:token (public)', path: '/share/trip/abc123', testId: 'public-trip', inShell: false },
    ];

    it.each(routes)('$name', async ({ path, testId, admin, inShell }) => {
      installNetwork(0);
      renderAuthenticated(<App />, { route: path, user: createTestUser({ is_admin: !!admin }) });

      const page = await screen.findByTestId(testId);
      // The gate is required for this user, so a redirect would have happened if the route were not exempt.
      await waitFor(() => expect(page).toHaveAttribute('data-status', 'required'));
      expect(screen.queryByRole('heading', { name: AGREEMENT_HEADING })).toBeNull();
      if (inShell) expect(screen.getByTestId('location')).toHaveTextContent(path);
      else expect(screen.queryByTestId('shell')).toBeNull();
    });
  });
});

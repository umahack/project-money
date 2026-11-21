import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { FinancialClarityProvider } from './clarity/FinancialClarityProvider';
import { MutationStatusProvider } from './clarity/MutationStatusProvider';
import { FakeJourneyServer, installJourneyFetch } from './test/journeyBackend';
import { buildSettings } from './test/dataUseFixtures';
import { planSnapshot } from './test/planFixtures';
import { createTestUser, renderAuthenticated, renderWithProviders } from './test/test-utils';
import { currentMonth } from './money';

const MONTH = currentMonth();

function renderApp(route: string, { signedIn }: { signedIn: boolean }) {
  const ui = (
    <FinancialClarityProvider>
      <MutationStatusProvider>
        <App />
      </MutationStatusProvider>
    </FinancialClarityProvider>
  );
  return signedIn ? renderAuthenticated(ui, { route }) : renderWithProviders(ui, { route });
}

function routes() {
  return {
    'GET /clarity/settings': buildSettings({ acknowledgedVersion: 1 }),
    'GET /finance/clarity': { schemaVersion: 1, snapshot: planSnapshot(MONTH, { salaryMinor: null }) },
    'GET /finance/salary': { salary: null },
    'POST /auth/login': { token: 'login.jwt.token', user: createTestUser({ id: 77, email: 'new.user@example.test' }) },
    'POST /auth/register-finish': { token: 'register.jwt.token', user: createTestUser({ id: 78, email: 'new.user@example.test' }) },
  };
}

class NoopIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
}

let server: FakeJourneyServer;
beforeEach(() => {
  server = new FakeJourneyServer();
  // The landing page animates sections into view; jsdom has no IntersectionObserver.
  vi.stubGlobal('IntersectionObserver', NoopIntersectionObserver);
});

describe('rollout flag off', () => {
  it('has no /start route and registration behaves as before', async () => {
    vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', '');
    const fetches = installJourneyFetch(server, routes());
    renderApp('/start', { signedIn: true });

    // The signed-in catch-all keeps the Shell and shows no journey page.
    expect(await screen.findByRole('complementary', { name: 'Primary' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: 'Guided journey' })).toBeNull();
    expect(fetches.calls.filter((call) => call.path.startsWith('/clarity'))).toHaveLength(0);
  });

  it('sends a signed-in user at /register?start=... to Home, not the journey', async () => {
    vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', '');
    const fetches = installJourneyFetch(server, routes());
    renderApp('/register?start=plan_month', { signedIn: true });

    expect(await screen.findByRole('complementary', { name: 'Primary' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: 'Guided journey' })).toBeNull();
    expect(fetches.to('POST', '/clarity/journeys')).toHaveLength(0);
  });

  it('shows no journey links on the landing page', async () => {
    vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', '');
    installJourneyFetch(server, routes());
    renderApp('/', { signedIn: false });

    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Start with one goal' })).toBeNull();
    expect(document.querySelector('a[href*="start="]')).toBeNull();
  });
});

describe('rollout flag on', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'true');
  });

  it('redirects an unauthenticated visitor from /start to sign-in', async () => {
    const fetches = installJourneyFetch(server, routes());
    renderApp('/start', { signedIn: false });

    expect(await screen.findByRole('heading', { level: 1, name: 'Welcome back' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: 'Guided journey' })).toBeNull();
    expect(fetches.calls.filter((call) => call.path.startsWith('/clarity/journeys'))).toHaveLength(0);
  });

  it('shows the guided journey inside the app shell for a signed-in user', async () => {
    installJourneyFetch(server, routes());
    renderApp('/start', { signedIn: true });

    expect(await screen.findByRole('heading', { level: 1, name: 'Guided journey' })).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Primary' })).toBeInTheDocument();
    expect(await screen.findByRole('list', { name: 'Desired outcomes' })).toBeInTheDocument();
  });

  it('offers a Home entry that opens the guided journey', async () => {
    installJourneyFetch(server, routes());
    renderApp('/', { signedIn: true });

    const link = await screen.findByRole('link', { name: 'Start or continue a guided journey' });
    expect(link).toHaveAttribute('href', '/start');
  });

  it('links the landing page to exactly the four journeys through fixed keys', async () => {
    installJourneyFetch(server, routes());
    renderApp('/', { signedIn: false });

    const heading = await screen.findByRole('heading', { name: 'Start with one goal' });
    const links = Array.from((heading.closest('section') as HTMLElement).querySelectorAll('a'));
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/register?start=plan_month',
      '/register?start=control_spending',
      '/register?start=fund_goal',
      '/register?start=settle_trip',
    ]);
  });

  it('keeps a valid intent on the sign-in and sign-up links and drops an invalid one', async () => {
    installJourneyFetch(server, routes());
    const { unmount } = renderApp('/register?start=fund_goal', { signedIn: false });
    expect(await screen.findByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login?start=fund_goal');
    unmount();

    renderApp('/register?start=nope', { signedIn: false });
    expect(await screen.findByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
  });

  it('starts the journey named by a valid intent after sign-in, then removes it from the address', async () => {
    const fetches = installJourneyFetch(server, routes());
    renderApp('/login?start=fund_goal', { signedIn: false });

    const user = userEvent.setup();
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'new.user@example.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'Secret#1234' } });
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Guided journey' })).toBeInTheDocument();
    await waitFor(() => expect(fetches.to('POST', '/clarity/journeys')).toHaveLength(1));
    expect(fetches.to('POST', '/clarity/journeys')[0]?.body).toEqual({ desiredOutcome: 'fund_goal' });
    expect(server.startsCreated).toBe(1);
    // The token stays in session storage, and no journey value is stored in the browser.
    expect(sessionStorage.getItem('pm_token')).toBe('login.jwt.token');
    expect(localStorage.length).toBeLessThanOrEqual(1);
  });

  it('sends a sign-in with an unknown intent to Home and starts nothing', async () => {
    const fetches = installJourneyFetch(server, routes());
    renderApp('/login?start=bogus', { signedIn: false });

    const user = userEvent.setup();
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'new.user@example.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'Secret#1234' } });
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('complementary', { name: 'Primary' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: 'Guided journey' })).toBeNull();
    expect(fetches.to('POST', '/clarity/journeys')).toHaveLength(0);
  });

  it('opens the journey choice for a user who finishes sign-up without an intent', async () => {
    // Sign-up ends on this page when the code is accepted; the Guest route sees a user that appeared after arrival.
    const fetches = installJourneyFetch(server, {
      ...routes(),
      'POST /auth/register-start': { ok: true },
    });
    renderApp('/register', { signedIn: false });

    const user = userEvent.setup();
    fireEvent.change(await screen.findByLabelText('Your name'), { target: { value: 'Asha Rao' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'new.user@example.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'Secret#1234abc' } });
    await user.click(screen.getByRole('button', { name: 'Send verification code' }));
    fireEvent.change(await screen.findByLabelText(/6-digit code/), { target: { value: '123456' } });
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Guided journey' })).toBeInTheDocument();
    expect(await screen.findByRole('list', { name: 'Desired outcomes' })).toBeInTheDocument();
    // No intent means nothing is started on the user's behalf.
    expect(fetches.to('POST', '/clarity/journeys')).toHaveLength(0);
  });

  it('starts the intent journey for a user who finishes sign-up with an allowlisted key', async () => {
    const fetches = installJourneyFetch(server, {
      ...routes(),
      'POST /auth/register-start': { ok: true },
    });
    renderApp('/register?start=plan_month', { signedIn: false });

    const user = userEvent.setup();
    fireEvent.change(await screen.findByLabelText('Your name'), { target: { value: 'Asha Rao' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'new.user@example.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'Secret#1234abc' } });
    await user.click(screen.getByRole('button', { name: 'Send verification code' }));
    fireEvent.change(await screen.findByLabelText(/6-digit code/), { target: { value: '123456' } });
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Guided journey' })).toBeInTheDocument();
    await waitFor(() => expect(fetches.to('POST', '/clarity/journeys')).toHaveLength(1));
    expect(fetches.to('POST', '/clarity/journeys')[0]?.body).toEqual({ desiredOutcome: 'plan_month' });
  });
});

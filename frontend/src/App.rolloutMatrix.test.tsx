// Final rollout acceptance (task 17.5): the whole App is rendered for every combination of
// rollout flag (on/off), session (signed in/guest), and route (Home, Plan, Spending, Goals,
// Trips, and the guided journey at /start). Each case asserts which branch rendered and
// which requests were made, so a rollback (flag off) is proven to select the legacy UI and
// the legacy read path and to send nothing from the clarity contract, and the flag-on
// branch is proven to use it.
//
// Requirements 1.3 to 1.7 (page decisions), 3.1 (journey entry), 10.8 and 11.x (rollback keeps
// user data: no mutation is ever issued by selecting a branch).
import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { FinancialClarityProvider } from './clarity/FinancialClarityProvider';
import { MutationStatusProvider } from './clarity/MutationStatusProvider';
import { QuickAddProvider } from './clarity/quickAdd/QuickAddProvider';
import { PAGE_DECISIONS } from './clarity/actionContext';
import { currentMonth } from './money';
import { buildSettings } from './test/claritySettingsBuilder';
import { FakeJourneyServer, installJourneyFetch } from './test/journeyBackend';
import { homeSnapshot } from './test/homeSummaryFixtures';
import { createTestUser, renderAuthenticated, renderWithProviders } from './test/test-utils';

const MONTH = currentMonth();

class NoopIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
}

const TRIP = { id: 3, name: 'Goa weekend', destination: 'Goa', budget: 40000, start_date: null, end_date: null };
const GOAL = {
  id: 5,
  name: 'Laptop upgrade',
  target_amount: 60000,
  saved_amount: 1000,
  target_date: null,
  created_at: '2026-01-01 00:00:00',
  updated_at: '2026-01-01 00:00:00',
};

/** Both generations of every read the five pages make. The legacy and the clarity routes exist side by side. */
function routes(): Record<string, unknown> {
  return {
    // Clarity contract
    'GET /clarity/settings': buildSettings({ acknowledgedVersion: 1 }),
    'GET /finance/clarity': { schemaVersion: 1, snapshot: homeSnapshot(MONTH) },
    // Legacy contract and shared reads
    'GET /finance/plan': {
      income: 75000, emiTotal: 0, afterFixed: 75000,
      breakdown: { needs: 37500, wants: 22500, save: 15000 }, tips: [], month: MONTH, spentThisMonth: 0,
    },
    'GET /finance/salary': { salary: { month: MONTH, amount: 75000 } },
    'GET /finance/emis': { emis: [] },
    'GET /finance/expenses': { month: MONTH, categories: ['Food', 'Other'], expenses: [] },
    'GET /finance/budgets': { budgets: { Food: 3000 } },
    'GET /finance/goals': { goals: [GOAL] },
    'GET /finance/streak': { current: 3, longest: 5, days_logged: 9 },
    'GET /finance/insights': { thisMonth: MONTH, prevMonth: MONTH, totals: { thisMonth: 0, prevMonth: 0 }, weekdayAvg: [], insights: [] },
    'GET /finance/history': { months: [] },
    'GET /trips': { trips: [TRIP] },
    'GET /invites': { invites: [] },
    'GET /public/announcement': { announcement: null },
  };
}

interface RouteCase {
  route: string;
  /** Subtitle text that appears only on the legacy page. */
  legacy: string | RegExp;
  /** The decision sentence of the clarity page header, which the legacy page does not have. */
  clarity: string | RegExp;
}

const PAGES: RouteCase[] = [
  { route: '/', legacy: /where your money is going/, clarity: PAGE_DECISIONS.home },
  { route: '/plan', legacy: /mandatory payments/, clarity: PAGE_DECISIONS.plan },
  { route: '/spending', legacy: /Daily log, inline category budgets/, clarity: PAGE_DECISIONS.spending },
  { route: '/goals', legacy: /Set a target, add to it/, clarity: PAGE_DECISIONS.goals },
  { route: '/trips', legacy: /split costs like Splitwise/, clarity: PAGE_DECISIONS.trips },
];

function renderApp(route: string, signedIn: boolean) {
  const ui = (
    <FinancialClarityProvider>
      <MutationStatusProvider>
        {/* As in main.tsx: the Shell mounts Quick Add inside this provider while Quick_Add_Enabled. */}
        <QuickAddProvider>
          <App />
        </QuickAddProvider>
      </MutationStatusProvider>
    </FinancialClarityProvider>
  );
  return signedIn ? renderAuthenticated(ui, { route, user: createTestUser({ name: 'Test User' }) }) : renderWithProviders(ui, { route });
}

function install() {
  return installJourneyFetch(new FakeJourneyServer(), routes() as Record<string, object>);
}

const isClarityRequest = (path: string) => path.startsWith('/clarity/') || path.startsWith('/finance/clarity');
const isMutation = (method: string) => method !== 'GET';

/** Header names are matched without regard to case. */
function contractHeaderOf(call: { method: string; path: string }, fetchMock: ReturnType<typeof vi.fn>): string | undefined {
  const entry = fetchMock.mock.calls.find(([input, init]) => (
    String(input).replace(/^\/api/, '').split('?')[0] === call.path && (init?.method ?? 'GET') === call.method
  ));
  const headers = (entry?.[1]?.headers ?? {}) as Record<string, string>;
  const name = Object.keys(headers).find((key) => key.toLowerCase() === 'x-clarity-contract');
  return name ? headers[name] : undefined;
}

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', NoopIntersectionObserver);
});

describe('flag OFF (rollback to legacy), signed in', () => {
  beforeEach(() => vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', ''));

  it.each(PAGES)('$route renders the legacy page and makes no clarity request', async ({ route, legacy, clarity }) => {
    const fetches = install();
    renderApp(route, true);
    await screen.findAllByText(legacy);
    expect(screen.queryByText(clarity)).toBeNull();
    expect(document.querySelector('.clarity-decision-header')).toBeNull();
    expect(screen.queryByText('Decision')).toBeNull();
    // Let every mount-time read settle before counting.
    await waitFor(() => expect(fetches.calls.length).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(fetches.calls.filter((call) => isClarityRequest(call.path))).toEqual([]);
    const fetchMock = vi.mocked(globalThis.fetch) as unknown as ReturnType<typeof vi.fn>;
    for (const call of fetches.calls) expect(contractHeaderOf(call, fetchMock), `${call.method} ${call.path}`).toBeUndefined();
    // Selecting the legacy branch never writes anything.
    expect(fetches.calls.filter((call) => isMutation(call.method))).toEqual([]);
  });

  it('/start has no journey route: the signed-in catch-all keeps the shell and shows no journey page', async () => {
    const fetches = install();
    renderApp('/start', true);
    expect(await screen.findByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: 'Guided journey' })).toBeNull();
    expect(screen.queryByRole('list', { name: 'Desired outcomes' })).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetches.calls.filter((call) => isClarityRequest(call.path))).toEqual([]);
    expect(fetches.calls.filter((call) => isMutation(call.method))).toEqual([]);
  });
});

describe('flag ON, signed in', () => {
  beforeEach(() => vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'true'));

  it.each(PAGES)('$route renders the clarity page, reads the clarity snapshot, and sends the contract header', async ({ route, legacy, clarity }) => {
    const fetches = install();
    renderApp(route, true);
    await screen.findAllByText(clarity);
    expect(document.querySelector('.clarity-decision-header')).not.toBeNull();
    expect(screen.queryByText(legacy)).toBeNull();
    await waitFor(() => expect(fetches.to('GET', '/finance/clarity').length).toBeGreaterThan(0));

    const fetchMock = vi.mocked(globalThis.fetch) as unknown as ReturnType<typeof vi.fn>;
    const contractRoutes = fetches.calls.filter((call) => /^\/(?:finance|trips)(?:\/|$)/.test(call.path));
    expect(contractRoutes.length).toBeGreaterThan(0);
    for (const call of contractRoutes) expect(contractHeaderOf(call, fetchMock), `${call.method} ${call.path}`).toBe('1');
    // The legacy plan read is not used by the clarity pages.
    expect(fetches.to('GET', '/finance/plan')).toEqual([]);
    expect(fetches.calls.filter((call) => isMutation(call.method))).toEqual([]);
  });

  it('/start renders the guided journey inside the shell', async () => {
    install();
    renderApp('/start', true);
    expect(await screen.findByRole('heading', { level: 1, name: 'Guided journey' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    expect(await screen.findByRole('list', { name: 'Desired outcomes' })).toBeInTheDocument();
  });
});

describe.each([['OFF', ''], ['ON', 'true']])('flag %s, guest', (_label, value) => {
  beforeEach(() => vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', value));

  it.each(PAGES.filter((page) => page.route !== '/'))('$route sends a guest to sign-in and requests no financial data', async ({ route }) => {
    const fetches = install();
    renderApp(route, false);
    expect(await screen.findByRole('heading', { level: 1, name: 'Welcome back' })).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fetches.calls.filter((call) => /^\/(?:finance|trips|clarity)(?:\/|$)/.test(call.path))).toEqual([]);
    expect(document.querySelector('.clarity-decision-header')).toBeNull();
  });

  it('/start sends a guest to sign-in and starts no journey', async () => {
    const fetches = install();
    renderApp('/start', false);
    expect(await screen.findByRole('heading', { level: 1, name: 'Welcome back' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: 'Guided journey' })).toBeNull();
    expect(fetches.calls.filter((call) => /^\/(?:finance|trips|clarity)(?:\/|$)/.test(call.path))).toEqual([]);
  });

  it('/ shows the marketing landing, with journey links only while the flag is on', async () => {
    const fetches = install();
    renderApp('/', false);
    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(document.querySelector('.clarity-decision-header')).toBeNull();
    const journeyLinks = document.querySelectorAll('a[href*="start="]');
    expect(journeyLinks.length).toBe(value === 'true' ? 4 : 0);
    expect(fetches.calls.filter((call) => /^\/(?:finance|trips|clarity)(?:\/|$)/.test(call.path))).toEqual([]);
  });
});

// Task 11.6: the Quick_Add_Flag joins the matrix. While the Rollout_Flag is off it has no effect, and
// while the Rollout_Flag is on the pages and requests are the same whatever the Quick_Add_Flag says.
// Nothing Quick Add is requested in any combination that leaves Quick_Add_Enabled false.
const isQuickAddRequest = (path: string) => /quick-add|category-memory/.test(path);

describe('Quick_Add_Flag combinations, signed in', () => {
  describe('Rollout_Flag OFF, Quick_Add_Flag ON', () => {
    beforeEach(() => {
      vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', '');
      vi.stubEnv('VITE_QUICK_ADD_ENABLED', 'true');
    });

    it.each(PAGES)('$route still renders the legacy page and makes no clarity or Quick Add request', async ({ route, legacy, clarity }) => {
      const fetches = install();
      renderApp(route, true);
      await screen.findAllByText(legacy);
      expect(screen.queryByText(clarity)).toBeNull();
      expect(document.querySelector('.clarity-decision-header')).toBeNull();
      await waitFor(() => expect(fetches.calls.length).toBeGreaterThan(0));
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(fetches.calls.filter((call) => isClarityRequest(call.path) || isQuickAddRequest(call.path))).toEqual([]);
      const fetchMock = vi.mocked(globalThis.fetch) as unknown as ReturnType<typeof vi.fn>;
      for (const call of fetches.calls) expect(contractHeaderOf(call, fetchMock), `${call.method} ${call.path}`).toBeUndefined();
      expect(fetches.calls.filter((call) => isMutation(call.method))).toEqual([]);
    });
  });

  describe.each([['OFF', ''], ['ON', 'true']])('Rollout_Flag ON, Quick_Add_Flag %s', (_label, quickAdd) => {
    beforeEach(() => {
      vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'true');
      vi.stubEnv('VITE_QUICK_ADD_ENABLED', quickAdd);
    });

    it.each(PAGES)('$route renders the clarity page with the contract header', async ({ route, legacy, clarity }) => {
      const fetches = install();
      renderApp(route, true);
      await screen.findAllByText(clarity);
      expect(screen.queryByText(legacy)).toBeNull();
      await waitFor(() => expect(fetches.to('GET', '/finance/clarity').length).toBeGreaterThan(0));

      const fetchMock = vi.mocked(globalThis.fetch) as unknown as ReturnType<typeof vi.fn>;
      const contractRoutes = fetches.calls.filter((call) => /^\/(?:finance|trips)(?:\/|$)/.test(call.path));
      expect(contractRoutes.length).toBeGreaterThan(0);
      for (const call of contractRoutes) expect(contractHeaderOf(call, fetchMock), `${call.method} ${call.path}`).toBe('1');
      expect(fetches.to('GET', '/finance/plan')).toEqual([]);
      expect(fetches.calls.filter((call) => isMutation(call.method))).toEqual([]);
    });

  });

  describe('Rollout_Flag ON, Quick_Add_Flag OFF', () => {
    beforeEach(() => {
      vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'true');
      vi.stubEnv('VITE_QUICK_ADD_ENABLED', '');
    });

    it.each(PAGES)('$route makes no Quick Add or memory request', async ({ route, clarity }) => {
      const fetches = install();
      renderApp(route, true);
      await screen.findAllByText(clarity);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(fetches.calls.filter((call) => isQuickAddRequest(call.path))).toEqual([]);
    });
  });
});

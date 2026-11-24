// Task 11.6: the Quick_Add_Flag, the Rollout_Flag, and the month the pages name when the device
// clock is in another month than Asia/Kolkata.
//
// The device is set to America/New_York at 2025-12-31 22:00 (UTC-5), which is 2026-01-01 08:30 in
// Asia/Kolkata. Only `Date` is faked, so timers and promises keep running and the whole App renders
// and fetches normally.
//
// Requirements 1.18, 16.1, 16.12, 16.13 (flags), 11.22 and 11.23 (month), 16.2 (nothing Quick Add
// is requested or shown while Quick_Add_Enabled is false).
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../App';
import { currentMonth, monthLabel } from '../../money';
import { FinancialClarityProvider } from '../FinancialClarityProvider';
import { MutationStatusProvider } from '../MutationStatusProvider';
import { QuickAddProvider } from './QuickAddProvider';
import { PAGE_DECISIONS } from '../actionContext';
import {
  clarityContractHeaders,
  readClientFeatureFlags,
  readQuickAddFlag,
  selectFinancialClarityRollout,
  selectQuickAddEnabled,
} from '../rollout';
import { buildSettings } from '../../test/claritySettingsBuilder';
import { homeSnapshot } from '../../test/homeSummaryFixtures';
import { FakeJourneyServer, installJourneyFetch } from '../../test/journeyBackend';
import { kolkataMonthOf } from '../../test/kolkataReference';
import { createApiResponse, createTestUser, renderAuthenticated } from '../../test/test-utils';
import { resetServerTimeOffset } from './kolkata';

// 2026-01-01 03:00 UTC. New York (UTC-5) reads 2025-12-31 22:00, Asia/Kolkata reads 2026-01-01 08:30.
const INSTANT = Date.parse('2026-01-01T03:00:00Z');
const DEVICE_ZONE = 'America/New_York';
const DEVICE_MONTH = '2025-12';
const KOLKATA_MONTH = '2026-01';
const DEVICE_LABEL = monthLabel(DEVICE_MONTH);
const KOLKATA_LABEL = monthLabel(KOLKATA_MONTH);

const ROLLOUT = 'VITE_FINANCIAL_CLARITY_ENABLED';
const QUICK_ADD = 'VITE_QUICK_ADD_ENABLED';

class NoopIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
}

let previousZone: string | undefined;
let hadZone = false;

beforeEach(() => {
  hadZone = Object.prototype.hasOwnProperty.call(process.env, 'TZ');
  previousZone = process.env.TZ;
  process.env.TZ = DEVICE_ZONE;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(INSTANT);
  resetServerTimeOffset();
  vi.stubGlobal('IntersectionObserver', NoopIntersectionObserver);
});

afterEach(() => {
  resetServerTimeOffset();
  if (hadZone) process.env.TZ = previousZone;
  else delete process.env.TZ;
});

function stubFlags(rollout: string, quickAdd: string) {
  vi.stubEnv(ROLLOUT, rollout);
  vi.stubEnv(QUICK_ADD, quickAdd);
}

describe('the test clock', () => {
  it('puts the device and Asia/Kolkata in different months', () => {
    const device = new Date();
    expect(`${device.getFullYear()}-${String(device.getMonth() + 1).padStart(2, '0')}`).toBe(DEVICE_MONTH);
    expect(device.getDate()).toBe(31);
    expect(kolkataMonthOf(INSTANT)).toBe(KOLKATA_MONTH);
  });
});

describe('flag reading', () => {
  it.each([
    ['absent', undefined, false],
    ['empty', '', false],
    ['malformed', 'enabled', false],
    ['zero', '0', false],
    ['false', 'false', false],
    ['one', '1', true],
    ['true', 'true', true],
    ['upper case', 'TRUE', true],
    ['mixed case', 'tRuE', true],
    ['capitalized with spaces', '  True ', true],
  ] as const)('reads the Quick_Add_Flag %s as %s', (_name, value, expected) => {
    expect(readQuickAddFlag({ [QUICK_ADD]: value })).toBe(expected);
  });

  it('reads both flags from the build environment the same way', () => {
    for (const [value, expected] of [['1', true], ['true', true], ['TrUe', true], ['', false], ['maybe', false]] as const) {
      stubFlags(value, value);
      expect(readClientFeatureFlags().financialClarityEnabled).toBe(expected);
      expect(readQuickAddFlag()).toBe(expected);
      expect(selectQuickAddEnabled()).toBe(expected);
    }
  });

  it('is off when neither flag is set in the build environment', () => {
    vi.stubEnv(ROLLOUT, undefined as unknown as string);
    vi.stubEnv(QUICK_ADD, undefined as unknown as string);
    expect(readQuickAddFlag()).toBe(false);
    expect(selectQuickAddEnabled()).toBe(false);
  });
});

describe('the Quick_Add_Flag while the Rollout_Flag is off', () => {
  const ROLLOUT_OFF: unknown[] = [undefined, '', '0', 'false', 'yes', 'tru', ' ', 0, null];
  const QUICK_ON = ['1', 'true', 'TRUE', 'tRuE', ' true '];

  it.each(ROLLOUT_OFF.flatMap((rollout) => QUICK_ON.map((quick) => [rollout, quick] as const)))(
    'changes nothing with rollout %j and Quick_Add_Flag %j',
    (rollout, quick) => {
      const withFlag = { [ROLLOUT]: rollout, [QUICK_ADD]: quick };
      const without = { [ROLLOUT]: rollout };
      expect(selectQuickAddEnabled(withFlag)).toBe(false);
      expect(readClientFeatureFlags(withFlag)).toEqual(readClientFeatureFlags(without));
      expect(selectFinancialClarityRollout(withFlag)).toEqual(selectFinancialClarityRollout(without));
      expect(selectFinancialClarityRollout(withFlag).readPath).toBe('legacy');
      for (const path of ['/finance/plan', '/finance/clarity', '/trips/3']) {
        expect(clarityContractHeaders(path, true, withFlag)).toEqual(clarityContractHeaders(path, true, without));
        expect(clarityContractHeaders(path, true, withFlag)).toEqual({});
      }
    },
  );

  it.each(['', 'true'])('keeps the month on the device clock with Quick_Add_Flag %j', (quick) => {
    stubFlags('', quick);
    expect(currentMonth()).toBe(DEVICE_MONTH);
  });
});

describe('currentMonth with the device clock in another month than Asia/Kolkata', () => {
  it.each(['', '1', 'true', 'TRUE', 'no'])('is the Kolkata month while the Rollout_Flag is on and Quick_Add_Flag is %j', (quick) => {
    stubFlags('true', quick);
    expect(currentMonth()).toBe(KOLKATA_MONTH);
  });

  it.each([
    ['absent', ''],
    ['false', 'false'],
    ['malformed', 'yes'],
  ])('is the device month while the Rollout_Flag is %s, with Quick Add on or off', (_name, rollout) => {
    for (const quick of ['', 'true']) {
      stubFlags(rollout, quick);
      expect(currentMonth()).toBe(DEVICE_MONTH);
    }
  });
});

// ---- the pages ----

interface PageCase {
  name: string;
  route: string;
  /** The decision sentence of the clarity page header. */
  decision: string;
  /** The page names its month in its header. Trips shows no month, so only its request is checked. */
  showsMonth: boolean;
}

const PAGES: PageCase[] = [
  { name: 'Home', route: '/', decision: PAGE_DECISIONS.home, showsMonth: true },
  { name: 'Plan', route: '/plan', decision: PAGE_DECISIONS.plan, showsMonth: true },
  { name: 'Spending', route: '/spending', decision: PAGE_DECISIONS.spending, showsMonth: true },
  { name: 'Goals', route: '/goals', decision: PAGE_DECISIONS.goals, showsMonth: true },
  { name: 'Trips', route: '/trips', decision: PAGE_DECISIONS.trips, showsMonth: false },
];

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

/** Both generations of every read the five pages make. `salaryMonth` is the month the legacy pages are told the pay is for. */
function routes(month: string, salaryMonth: string): Record<string, object> {
  return {
    'GET /clarity/settings': buildSettings({ acknowledgedVersion: 1 }),
    'GET /finance/plan': {
      income: 75000, emiTotal: 0, afterFixed: 75000,
      breakdown: { needs: 37500, wants: 22500, save: 15000 }, tips: [], month, spentThisMonth: 0,
    },
    'GET /finance/salary': { salary: { month: salaryMonth, amount: 75000 } },
    'GET /finance/emis': { emis: [] },
    'GET /finance/expenses': { month, categories: ['Food', 'Other'], expenses: [] },
    'GET /finance/budgets': { budgets: { Food: 3000 } },
    'GET /finance/goals': { goals: [GOAL] },
    'GET /finance/streak': { current: 3, longest: 5, days_logged: 9 },
    'GET /finance/insights': { thisMonth: month, prevMonth: month, totals: { thisMonth: 0, prevMonth: 0 }, weekdayAvg: [], insights: [] },
    'GET /finance/history': { months: [] },
    'GET /trips': { trips: [TRIP] },
    'GET /invites': { invites: [] },
    'GET /public/announcement': { announcement: null },
  };
}

interface Seen {
  method: string;
  path: string;
  search: string;
  body: string;
}

interface Backend {
  seen: Seen[];
  /** The `month` query of every clarity read, in order. */
  clarityMonths(): Array<string | null>;
}

/**
 * Journey and finance routes come from the shared journey backend. The clarity read answers with a
 * snapshot for whichever month the page asks for, and every request is recorded with its query.
 */
function install(salaryMonth = KOLKATA_MONTH): Backend {
  installJourneyFetch(new FakeJourneyServer(), routes(KOLKATA_MONTH, salaryMonth));
  const fetchMock = vi.mocked(globalThis.fetch);
  const delegate = fetchMock.getMockImplementation();
  if (!delegate) throw new Error('The journey backend did not install a fetch implementation.');
  const seen: Seen[] = [];
  fetchMock.mockImplementation(async (input, init) => {
    const url = new URL(String(input), 'http://localhost');
    const path = url.pathname.replace(/^\/api/, '');
    const method = (init?.method ?? 'GET').toUpperCase();
    // Measurement events and visit beacons are not page requests.
    if (path !== '/clarity/events' && path !== '/track') {
      seen.push({ method, path, search: url.search, body: typeof init?.body === 'string' ? init.body : '' });
    }
    if (method === 'GET' && path === '/finance/clarity') {
      const requested = url.searchParams.get('month') ?? KOLKATA_MONTH;
      return createApiResponse({ body: { schemaVersion: 1, snapshot: homeSnapshot(requested) } });
    }
    return delegate(input, init);
  });
  return {
    seen,
    clarityMonths: () => seen
      .filter((call) => call.method === 'GET' && call.path === '/finance/clarity')
      .map((call) => new URLSearchParams(call.search).get('month')),
  };
}

function renderApp(route: string) {
  return renderAuthenticated(
    <FinancialClarityProvider>
      <MutationStatusProvider>
        {/* As in main.tsx: the Shell mounts Quick Add inside this provider while Quick_Add_Enabled. */}
        <QuickAddProvider>
          <App />
        </QuickAddProvider>
      </MutationStatusProvider>
    </FinancialClarityProvider>,
    { route, user: createTestUser({ name: 'Test User' }) },
  );
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

/** A sorted, comparable record of every request a page made. */
function signature(backend: Backend): string[] {
  return backend.seen.map((call) => `${call.method} ${call.path}${call.search} ${call.body}`).sort();
}

describe.each([
  ['off', ''],
  ['on', 'true'],
])('Rollout_Flag on, Quick_Add_Flag %s', (_label, quickAdd) => {
  beforeEach(() => stubFlags('true', quickAdd));

  it.each(PAGES)('$name requests and shows the Asia/Kolkata month', async ({ route, decision, showsMonth }) => {
    const backend = install();
    renderApp(route);
    await screen.findAllByText(decision);
    await waitFor(() => expect(backend.clarityMonths().length).toBeGreaterThan(0));
    await settle();

    // Every clarity read names the Kolkata month, and so does every other read that names a month.
    expect(new Set(backend.clarityMonths())).toEqual(new Set([KOLKATA_MONTH]));
    for (const call of backend.seen) {
      const month = new URLSearchParams(call.search).get('month');
      if (month !== null) expect(month, `${call.method} ${call.path}`).toBe(KOLKATA_MONTH);
      expect(call.search, `${call.method} ${call.path}`).not.toContain(DEVICE_MONTH);
    }

    if (showsMonth) {
      expect((await screen.findAllByText(KOLKATA_LABEL)).length).toBeGreaterThan(0);
    }
    expect(screen.queryByText(new RegExp(DEVICE_LABEL))).toBeNull();
  });
});

describe('Rollout_Flag off, with Quick Add on or off', () => {
  it.each(['', 'true'])('Home shows the pay month as current on the device clock, Quick_Add_Flag %j', async (quickAdd) => {
    stubFlags('', quickAdd);
    const backend = install(DEVICE_MONTH);
    renderApp('/');
    const pills = await screen.findAllByText(`Pay for ${DEVICE_LABEL}`);
    // The pay month equals the device month, so it is not marked as an earlier month.
    for (const pill of pills) expect(pill.className).not.toContain('warn');
    expect(backend.seen.filter((call) => call.path.startsWith('/finance/clarity'))).toEqual([]);
  });

  it.each(['', 'true'])('Home marks a pay month equal to the Kolkata month as an earlier month, Quick_Add_Flag %j', async (quickAdd) => {
    stubFlags('', quickAdd);
    install(KOLKATA_MONTH);
    renderApp('/');
    const pills = await screen.findAllByText(`Pay for ${KOLKATA_LABEL}`);
    // The device is still in December, so a January pay month is not the current month.
    expect(pills.some((pill) => pill.className.includes('warn'))).toBe(true);
  });

  it.each(['', 'true'])('Plan says the pay is saved for the device month, Quick_Add_Flag %j', async (quickAdd) => {
    stubFlags('', quickAdd);
    install('2025-11');
    renderApp('/plan');
    expect(await screen.findByText(`Updating saves it for ${DEVICE_LABEL}.`)).toBeInTheDocument();
    expect(screen.queryByText(`Updating saves it for ${KOLKATA_LABEL}.`)).toBeNull();
  });

  it.each(PAGES)('$name sends no month and no clarity request', async ({ route, decision }) => {
    for (const quickAdd of ['', 'true']) {
      stubFlags('', quickAdd);
      const backend = install();
      const view = renderApp(route);
      await waitFor(() => expect(backend.seen.length).toBeGreaterThan(0));
      await settle();
      expect(screen.queryByText(decision)).toBeNull();
      expect(backend.seen.filter((call) => call.path.startsWith('/finance/clarity'))).toEqual([]);
      for (const call of backend.seen) expect(call.search, `${call.method} ${call.path}`).not.toMatch(/month=/);
      view.unmount();
      cleanup();
    }
  });
});

describe('Quick_Add_Enabled is false', () => {
  const DISABLED: Array<[string, string, string]> = [
    ['both flags off', '', ''],
    ['Quick_Add_Flag on, Rollout_Flag off', '', 'true'],
    ['Rollout_Flag on, Quick_Add_Flag off', 'true', ''],
  ];

  describe.each(DISABLED)('%s', (_name, rollout, quickAdd) => {
    beforeEach(() => stubFlags(rollout, quickAdd));

    it.each(PAGES)('$name makes no Quick Add or memory request and shows no Quick Add surface', async ({ route }) => {
      const backend = install();
      renderApp(route);
      await waitFor(() => expect(backend.seen.length).toBeGreaterThan(0));
      await settle();

      // No hints read, no memory write or delete, and nothing that carries an Allowance_Exclusion.
      expect(backend.seen.filter((call) => /quick-add|category-memory/.test(call.path))).toEqual([]);
      expect(backend.seen.filter((call) => /exclude|exclusion/i.test(call.body + call.search))).toEqual([]);
      expect(backend.seen.filter((call) => call.method !== 'GET')).toEqual([]);

      // No Quick Add control, no shortcut hint, no Allowance_Exclusion text.
      expect(document.querySelector('[aria-keyshortcuts]')).toBeNull();
      expect(screen.queryByRole('button', { name: /quick add/i })).toBeNull();
      expect(screen.queryByRole('textbox', { name: /quick add/i })).toBeNull();
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.queryByText(/not counted today/i)).toBeNull();
      expect(screen.queryByText(/not counted in daily allowance/i)).toBeNull();
      expect(screen.queryByText(/you can spend .* today/i)).toBeNull();
    });
  });

  it.each(DISABLED)('leaves Ctrl+K and Cmd+K to the browser with %s', async (_name, rollout, quickAdd) => {
    stubFlags(rollout, quickAdd);
    const backend = install();
    renderApp('/');
    await waitFor(() => expect(backend.seen.length).toBeGreaterThan(0));
    await settle();

    for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
      const press = new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', bubbles: true, cancelable: true, ...modifier });
      fireEvent(document.body, press);
      expect(press.defaultPrevented).toBe(false);
    }
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(backend.seen.filter((call) => /quick-add|category-memory/.test(call.path))).toEqual([]);
  });

  it.each(PAGES)('$name makes the same requests with the Quick_Add_Flag on or off while the Rollout_Flag is off', async ({ route }) => {
    const signatures: string[][] = [];
    for (const quickAdd of ['', 'true']) {
      stubFlags('', quickAdd);
      sessionStorage.clear();
      const backend = install();
      const view = renderApp(route);
      await waitFor(() => expect(backend.seen.length).toBeGreaterThan(0));
      await settle();
      signatures.push(signature(backend));
      view.unmount();
      cleanup();
    }
    expect(signatures[1]).toEqual(signatures[0]);
  });
});

// Task 18.2: rollout, rollback, and old-server behavior of Quick Add.
//
// 1. The four client flag combinations (Rollout_Flag x Quick_Add_Flag) against the two server states: wherever
//    Quick_Add_Enabled is false, Home, Spending, Settings, and the navigation are the markup of the application as it was
//    before this feature (src/test/fixtures/preFeatureDom.json, produced by src/test/preFeatureDom.tsx from the commit
//    before the feature), and nothing Quick Add is requested or shown. The one allowed difference is the month rule of
//    Requirement 11.22: while the Rollout_Flag is on the pages name the Asia/Kolkata month, not the device's.
// 2. Flipping the client flag on to off and off to on in one session keeps every expense, mark, and memory row, and every
//    monthly total, the Daily spending guide, and the logging streak the pages show.
// 3. Old-server fixtures (no `todayAllowance`, no memory routes, no mark support): the unavailable headline, suggestions
//    from the keyword rules only, and the saved-and-counted message with the update action.
//
// Requirements 16.1, 16.2, 16.3, 16.5, 16.7, 16.8, 16.12, 16.13, 16.14, 16.15, 16.16, 16.17, 16.19.
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FinancialSnapshot, TodayAllowanceOutcome } from './clarity/contracts';
import { DataUseGateProvider, PROMISE_RENDERED_KEY } from './clarity/DataUseGateProvider';
import { FinancialClarityProvider } from './clarity/FinancialClarityProvider';
import { MutationStatusProvider } from './clarity/MutationStatusProvider';
import { resetExpenseEventsForTests } from './clarity/quickAdd/expenseEvents';
import { BUILT_IN_CATEGORIES } from './clarity/quickAdd/keywordRules';
import { resetServerTimeOffset } from './clarity/quickAdd/kolkata';
import { QuickAddProvider } from './clarity/quickAdd/QuickAddProvider';
import { createQuickAddStore, type QuickAddStore } from './clarity/quickAdd/quickAddStore';
import { ANSWER_TITLE, EXCLUDE_LABEL, EXCLUDING_LABEL } from './components/quickAdd/EntryAnswer';
import { SAVE_AND_COUNT_LABEL, SAVE_WITHOUT_COUNTING_LABEL } from './components/quickAdd/EntryWarning';
import { HINTS_UNAVAILABLE_TEXT } from './components/quickAdd/ParsedPreview';
import { Shell } from './components/Shell';
import { monthLabel } from './money';
import { Dashboard } from './pages/Dashboard';
import { Spending } from './pages/Spending';
import { FakeQuickAddBackend } from './test/fakeQuickAddBackend';
import { FakeSpendingBackend, type SpendingBackendReply, type SpendingBackendRequest } from './test/fakeSpendingBackend';
import { installSpendingFetch, type SpendingFetch } from './test/fakeSpendingFetch';
import { buildVersionTwoSettings, resetSharedMemoryClient } from './test/settingsMemoryServer';
import { buildSettings } from './test/claritySettingsBuilder';
import { createTestQueryClient, createTestUser, renderAuthenticated } from './test/test-utils';
import {
  ALIGNED_CLOCK,
  MISALIGNED_CLOCK,
  PRE_FEATURE_ROUTES,
  fixtureKey,
  normalizeMarkup,
  renderPageDom,
  withDeviceClock,
  type PageDom,
  type PreFeatureClock,
  type PreFeatureFixture,
  type PreFeatureRoute,
  type RenderPageOptions,
} from './test/preFeatureDom';

const PRE_FEATURE = JSON.parse(readFileSync('src/test/fixtures/preFeatureDom.json', 'utf8')) as PreFeatureFixture;

class NoopIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
}

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', NoopIntersectionObserver);
  resetServerTimeOffset();
});
afterEach(() => {
  resetSharedMemoryClient();
  resetServerTimeOffset();
});

const ROLLOUT = 'VITE_FINANCIAL_CLARITY_ENABLED';
const QUICK_ADD = 'VITE_QUICK_ADD_ENABLED';
const stubFlags = (rollout: boolean, quickAdd: boolean) => {
  vi.stubEnv(ROLLOUT, rollout ? 'true' : '');
  vi.stubEnv(QUICK_ADD, quickAdd ? 'true' : '');
};

/** A `todayAllowance` outcome as a server with the feature sends it for the month of the snapshot. */
function withTodayAllowance(snapshot: FinancialSnapshot): FinancialSnapshot {
  const month = snapshot.period.month;
  const money = (amountMinor: number) => ({ currency: 'INR' as const, amountMinor });
  const outcome: TodayAllowanceOutcome = {
    id: `today-allowance:${month}`,
    kind: 'today_allowance',
    status: 'available',
    classification: 'calculated_result',
    period: { month, start: `${month}-01`, endExclusive: `${month}-31`, timeZone: 'Asia/Kolkata' },
    dataVersion: snapshot.dataVersion,
    sourceRefs: [],
    explanationRef: { outcomeId: `today-allowance:${month}`, dataVersion: snapshot.dataVersion },
    value: {
      applicable: true,
      date: `${month}-15`,
      daysRemainingInclusive: 17,
      todayAllowance: money(300_000),
      todaySpent: money(0),
      leftToday: money(300_000),
      overToday: money(0),
      allowanceBasis: money(5_100_000),
      usedPermille: 0,
      zeroReason: null,
      usedBeyondBudget: money(0),
      excludedToday: { count: 0, total: money(0) },
      largeEntryThreshold: money(100_000),
    },
  };
  return { ...snapshot, outcomes: { ...snapshot.outcomes, todayAllowance: outcome } };
}

type ServerState = 'off' | 'on';

/** The server flag off is the server before the feature. On, it sends notice version 2 and the `todayAllowance` outcome. */
function serverOptions(server: ServerState): RenderPageOptions {
  return server === 'on'
    ? { snapshot: withTodayAllowance, settings: buildVersionTwoSettings(2) }
    : { settings: buildSettings({ acknowledgedVersion: 1 }) };
}

const quickAddWrap: RenderPageOptions['wrap'] = (app) => <QuickAddProvider>{app}</QuickAddProvider>;
const isQuickAddRequest = (path: string) => /quick-add|category-memory/.test(path);

interface Combination {
  name: string;
  rollout: boolean;
  quickAdd: boolean;
  /** Quick_Add_Enabled: both client flags on. */
  enabled: boolean;
}
const COMBINATIONS: Combination[] = [
  { name: 'Rollout_Flag off, Quick_Add_Flag off', rollout: false, quickAdd: false, enabled: false },
  { name: 'Rollout_Flag off, Quick_Add_Flag on', rollout: false, quickAdd: true, enabled: false },
  { name: 'Rollout_Flag on, Quick_Add_Flag off', rollout: true, quickAdd: false, enabled: false },
  { name: 'Rollout_Flag on, Quick_Add_Flag on', rollout: true, quickAdd: true, enabled: true },
];
const DISABLED = COMBINATIONS.filter((combination) => !combination.enabled);

async function pageUnder(
  clock: PreFeatureClock,
  combination: Combination,
  server: ServerState,
  route: PreFeatureRoute,
): Promise<PageDom & { unmount(): void }> {
  stubFlags(combination.rollout, combination.quickAdd);
  return withDeviceClock(clock, () => renderPageDom(route, { ...serverOptions(server), wrap: quickAddWrap }));
}

/**
 * A server with its flag on announces notice version 2 (Requirement 16.20), and the data-use summary that every clarity
 * page shows names that version. The version number is the server's answer, not part of the page.
 */
function withoutNoticeVersion(markup: string, server: ServerState): string {
  return server === 'on' ? markup.replace('data-use notice (version 2)', 'data-use notice (version 1)') : markup;
}

/** The first place two strings differ, shown with its surroundings. */
function firstDifference(expected: string, actual: string): string {
  let at = 0;
  while (at < expected.length && at < actual.length && expected[at] === actual[at]) at += 1;
  return `first difference at ${at}: expected ...${expected.slice(Math.max(0, at - 80), at + 160)} but got ...${actual.slice(Math.max(0, at - 80), at + 160)}`;
}
function expectSameMarkup(actual: string, expected: string, label: string) {
  // Both sides are normalized again, so an animation caught at its last frame does not matter.
  const [left, right] = [normalizeMarkup(actual), normalizeMarkup(expected)];
  expect(left === right, `${label}: ${firstDifference(right, left)}`).toBe(true);
}

/**
 * Today's markup is the pre-feature markup with the device's month named as the Asia/Kolkata month, and nothing else
 * changed. Only the Rollout_Flag selects the Asia/Kolkata month (Requirement 11.22).
 */
function withKolkataMonth(markup: string, device: string, kolkata: string): string {
  return markup
    .split(monthLabel(device)).join(monthLabel(kolkata))
    .split(device).join(kolkata);
}

describe.each([
  ['server flag off', 'off'],
  ['server flag on', 'on'],
] as const)('Quick_Add_Enabled is false, %s', (_label, server) => {
  describe.each(DISABLED)('$name', (combination) => {
    it.each(PRE_FEATURE_ROUTES)('%s is the page as it was before the feature, on a device clock that agrees with Asia/Kolkata', async (route) => {
      const dom = await pageUnder(ALIGNED_CLOCK, combination, server, route);
      const expected = PRE_FEATURE[fixtureKey('aligned', combination.rollout, route)];
      expect(expected, 'the pre-feature fixture has this page').toBeDefined();
      expectSameMarkup(withoutNoticeVersion(dom.page, server), expected!.page, `${route} page`);
      expectSameMarkup(dom.navigation, expected!.navigation, `${route} navigation`);
      dom.unmount();
    });

    it.each(PRE_FEATURE_ROUTES)('%s differs from the pre-feature page only by the Asia/Kolkata month rule, on a device clock in another month', async (route) => {
      const dom = await pageUnder(MISALIGNED_CLOCK, combination, server, route);
      const expected = PRE_FEATURE[fixtureKey('misaligned', combination.rollout, route)];
      expect(expected).toBeDefined();
      // Requirement 11.22 applies to the Current_Month whenever the Rollout_Flag is on, and only then.
      const page = combination.rollout ? withKolkataMonth(expected!.page, '2025-12', '2026-01') : expected!.page;
      expectSameMarkup(withoutNoticeVersion(dom.page, server), page, `${route} page`);
      expectSameMarkup(dom.navigation, expected!.navigation, `${route} navigation`);
      dom.unmount();
    });
  });
});

// The pages are the pages while Quick_Add_Enabled is false: no Quick Add request, no Quick Add element, and no write.
describe.each([
  ['server flag off', 'off'],
  ['server flag on', 'on'],
] as const)('Quick_Add_Enabled is false, %s: nothing Quick Add is requested or shown', (_label, server) => {
  describe.each(DISABLED)('$name', (combination) => {
    it.each(PRE_FEATURE_ROUTES)('%s sends no Quick Add, memory, or exclusion request, and shows no Quick Add element', async (route) => {
      const dom = await pageUnder(ALIGNED_CLOCK, combination, server, route);
      const { calls } = dom.fetches;
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.filter((call) => isQuickAddRequest(call.path))).toEqual([]);
      expect(calls.filter((call) => /exclu/i.test(JSON.stringify(call.body ?? null)))).toEqual([]);
      expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
      expect(screen.queryByTestId('today-headline')).toBeNull();
      expect(document.querySelector('[data-region="today"]')).toBeNull();
      expect(document.querySelector('[aria-keyshortcuts]')).toBeNull();
      expect(document.querySelector('.home-quick-add, .memory-panel, .spending-excluded')).toBeNull();
      expect(document.querySelector('.qa-panel, .qa-preview, .qa-entry, .qa-answer, .qa-warning, .qa-fab')).toBeNull();
      expect(screen.queryByLabelText('Add an expense')).toBeNull();
      expect(screen.queryByRole('button', { name: /quick add/i })).toBeNull();
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.queryByText(/Remembered category choices/)).toBeNull();
      expect(screen.queryByText(/not counted (?:in daily allowance|against today|today)|You can spend ₹/i)).toBeNull();
      dom.unmount();
    });
  });
});

describe.each([
  ['server flag off', 'off'],
  ['server flag on', 'on'],
] as const)('Quick_Add_Enabled is true, %s', (_label, server) => {
  it('is the one combination whose Home is not the pre-feature Home', async () => {
    const dom = await pageUnder(ALIGNED_CLOCK, COMBINATIONS[3]!, server, '/');
    const expected = PRE_FEATURE[fixtureKey('aligned', true, '/')];
    expect(withoutNoticeVersion(dom.page, server)).not.toBe(expected!.page);
    expect(screen.getByTestId('today-headline')).toBeInTheDocument();
    expect(screen.getByLabelText('Add an expense')).toBeInTheDocument();
    // The navigation does not change with Quick Add, only the page and the floating action around it.
    expectSameMarkup(dom.navigation, expected!.navigation, 'navigation');
    dom.unmount();
  });
});

// ---- flipping the client flag, and an old server -------------------------------------------------------------------

const MONTH = '2026-11';
const TODAY = '2026-11-18';
const NOW = Date.parse('2026-11-18T06:30:00.000Z');
const MARKED = 'Not counted in daily allowance';
const HEADLINE_NOT_COUNTED = '1 expense not counted today (₹1,500)';
const HINTS = '/finance/quick-add/hints';
const MEMORY = '/finance/category-memory';
const EXPENSES = '/finance/expenses';

/** What the server answers besides the expense routes: the category list, the data-use settings, and the streak. */
function sessionReply(backend: FakeSpendingBackend, request: SpendingBackendRequest): SpendingBackendReply | null {
  if (request.method.toUpperCase() !== 'GET') return null;
  if (request.path === '/finance/categories') return { status: 200, body: { defaults: [...BUILT_IN_CATEGORIES], custom: [] } };
  if (request.path === '/clarity/settings') return { status: 200, body: buildSettings({ acknowledgedVersion: 1 }) };
  if (request.path === '/finance/streak') {
    // The server counts the days that hold at least one expense, whatever mark an expense has.
    const days = new Set(backend.expenses.map((expense) => expense.spentOn)).size;
    return { status: 200, body: { current: days, longest: days, days_logged: days } };
  }
  return null;
}

function withBills(snapshot: FinancialSnapshot, labels: readonly string[]): FinancialSnapshot {
  if (labels.length === 0) return snapshot;
  return {
    ...snapshot,
    facts: labels.map((label, index) => ({
      classification: 'entered_fact' as const,
      source: {
        sourceType: 'bill' as const,
        recordId: 900 + index,
        field: 'amount',
        label,
        value: { currency: 'INR' as const, amountMinor: 2_500_000 },
        period: { month: snapshot.period.month },
      },
    })),
  };
}

/** The server with the feature: `todayAllowance`, the Memory_API, and the mark. */
class FeatureServer extends FakeQuickAddBackend {
  billLabels: string[] = [];
  override snapshot(month: string = this.month): FinancialSnapshot {
    return withBills(super.snapshot(month), this.billLabels);
  }
  override handle(request: SpendingBackendRequest): SpendingBackendReply {
    return sessionReply(this, request) ?? super.handle(request);
  }
}

/** The server before the feature: no `todayAllowance`, no memory routes, and no mark in any request or record. */
class OldServer extends FakeSpendingBackend {
  billLabels: string[] = [];
  override snapshot(month: string = this.month): FinancialSnapshot {
    return withBills(super.snapshot(month), this.billLabels);
  }
  override handle(request: SpendingBackendRequest): SpendingBackendReply {
    return sessionReply(this, request) ?? super.handle(request);
  }
}

function installViewport(width: number) {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true });
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() { return /min-width:\s*900px/.test(query) ? width >= 900 : false; },
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

interface Load {
  user: ReturnType<typeof userEvent.setup>;
  net: SpendingFetch;
  store: QuickAddStore;
  /** The application unloads: every entry whose request was not sent is gone, and nothing else is kept. */
  unload(): void;
}

/** One application load with the Rollout_Flag on and the Quick_Add_Flag as given, read when the application loads. */
function load(backend: FakeSpendingBackend, route: '/' | '/spending', quickAdd: boolean): Load {
  stubFlags(true, quickAdd);
  sessionStorage.setItem(PROMISE_RENDERED_KEY, '4242');
  installViewport(1440);
  const net = installSpendingFetch(backend);
  const store = createQuickAddStore();
  const view = renderAuthenticated(
    <FinancialClarityProvider>
      <MutationStatusProvider>
        <QuickAddProvider store={store}>
          <Routes>
            <Route element={<DataUseGateProvider><Shell /></DataUseGateProvider>}>
              <Route path="/" element={<Dashboard />} />
              <Route path="/spending" element={<Spending />} />
            </Route>
          </Routes>
        </QuickAddProvider>
      </MutationStatusProvider>
    </FinancialClarityProvider>,
    { route, queryClient: createTestQueryClient(), user: createTestUser() },
  );
  return {
    user: userEvent.setup(),
    net,
    store,
    unload() {
      view.unmount();
      cleanup();
      resetSharedMemoryClient();
      resetServerTimeOffset();
      resetExpenseEventsForTests();
    },
  };
}

const input = () => screen.getByLabelText('Add an expense') as HTMLInputElement;
const headline = () => screen.getByTestId('today-headline');
const planCard = () => screen.getByRole('article', { name: /Remaining to spend/ });
const streakText = () => (screen.getByRole('heading', { name: /Logging streak/ }).closest('.card') as HTMLElement | null)?.textContent ?? null;
const categoryChoice = () => screen.getByLabelText('Category', { selector: '.qa-preview select' }) as HTMLSelectElement;
const unavailableHeadline = () => headline().querySelector('[data-state="unavailable"]');
const requestsOf = (net: SpendingFetch, pattern: RegExp) => net.calls.filter((call) => pattern.test(call.path));
const writesOf = (net: SpendingFetch) => net.calls.filter((call) => call.method !== 'GET');

/** Home is up. With Quick Add on the headline has a value, or says it is unavailable; with it off there is no headline. */
async function homeReady(quickAdd: boolean, headlineState: 'value' | 'unavailable' = 'value') {
  await screen.findByRole('article', { name: /Remaining to spend/ });
  await screen.findByRole('heading', { name: /Logging streak/ });
  if (!quickAdd) return;
  if (headlineState === 'value') await within(headline()).findByText(/You can spend/);
  else await waitFor(() => expect(unavailableHeadline()).not.toBeNull());
}

/** The monthly values, the Daily spending guide, and the logging streak, as text, the way Home shows them. */
async function homeValues() {
  return { plan: planCard().textContent, guide: within(planCard()).getByText('Daily spending guide').closest('div')?.textContent, streak: streakText() };
}

async function spendingReady() {
  await screen.findByRole('article', { name: /Spending for/ });
  await waitFor(() => expect(document.querySelector('[data-expense-id]')).not.toBeNull());
}

/** The month's spending card and the listed expenses, as text, with Quick Add's own wording about the mark taken out. */
function spendingValues() {
  const card = screen.getByRole('article', { name: /Spending for/ });
  const rows = Array.from(document.querySelectorAll('[data-expense-id]')).map((row) => ({
    id: row.getAttribute('data-expense-id'),
    text: (row.textContent ?? '').replace(MARKED, '').replace(/(?:Don't count|Count) in daily allowance/, ''),
  }));
  return { card: card.textContent, rows };
}

/** Every expense (with its mark) and every memory row the server holds. */
function stored(backend: FeatureServer) {
  return structuredClone({
    expenses: backend.expenses,
    marks: [...backend.marks.entries()].sort(([a], [b]) => a - b),
    memory: backend.memory,
  });
}

async function saveEntry(h: Load, line: string, choice?: 'count' | 'dont-count') {
  const before = h.store.getState().entries.length;
  if (line !== '') await h.user.type(input(), line);
  if (choice === 'dont-count') await h.user.click(await screen.findByRole('button', { name: SAVE_WITHOUT_COUNTING_LABEL }));
  else if (choice === 'count') await h.user.click(await screen.findByRole('button', { name: SAVE_AND_COUNT_LABEL }));
  else await h.user.keyboard('{Enter}');
  await waitFor(() => {
    const entries = h.store.getState().entries;
    expect(entries).toHaveLength(before + 1);
    expect(entries[before]?.phase).toBe('saved');
  });
}

describe('flipping the client flag between loads', () => {
  beforeEach(() => {
    vi.setSystemTime(NOW);
    Object.defineProperty(window.navigator, 'platform', { value: 'Win32', configurable: true });
  });
  afterEach(() => {
    resetSharedMemoryClient();
    resetExpenseEventsForTests();
    delete (window.navigator as unknown as Record<string, unknown>).platform;
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true, writable: true });
  });

  function seededServer(): FeatureServer {
    const backend = new FeatureServer(MONTH, { categories: [...BUILT_IN_CATEGORIES] });
    backend.todayDate = TODAY;
    backend.seedMemory('coffee', 'Shopping');
    backend.seedMemory('metro', 'Transport');
    return backend;
  }

  it('on to off to on keeps every expense, mark, and memory row, and every monthly value, the guide, and the streak', async () => {
    const backend = seededServer();

    // Load 1: Quick Add on. One entry uses the remembered category, and one is saved without counting against today.
    let h = load(backend, '/', true);
    await homeReady(true);
    await saveEntry(h, '300 coffee');
    await saveEntry(h, '1500 laptop', 'dont-count');
    expect(backend.expenses.map((expense) => [expense.amountMinor, expense.category])).toEqual([[30000, 'Shopping'], [150000, 'Other']]);
    expect([...backend.marks.entries()]).toEqual([[2, true]]);
    await waitFor(() => expect(headline()).toHaveTextContent(HEADLINE_NOT_COUNTED));
    h.unload();

    h = load(backend, '/', true);
    await homeReady(true);
    await waitFor(() => expect(headline()).toHaveTextContent(HEADLINE_NOT_COUNTED));
    const homeOn = await homeValues();
    h.unload();
    h = load(backend, '/spending', true);
    await spendingReady();
    expect(document.querySelectorAll('.spending-excluded')).toHaveLength(1);
    const spendingOn = spendingValues();
    h.unload();

    const beforeFlip = stored(backend);
    expect(beforeFlip.memory.map((entry) => entry.noteKey).sort()).toEqual(['coffee', 'metro']);

    // Load 2: Quick Add off. The surfaces are gone, nothing is written or requested, and every value is the same.
    h = load(backend, '/', false);
    await homeReady(false);
    expect(screen.queryByTestId('today-headline')).toBeNull();
    expect(screen.queryByLabelText('Add an expense')).toBeNull();
    expect(screen.queryByRole('button', { name: /quick add/i })).toBeNull();
    expect(await homeValues()).toEqual(homeOn);
    expect(requestsOf(h.net, /quick-add|category-memory/)).toEqual([]);
    expect(writesOf(h.net)).toEqual([]);
    h.unload();
    h = load(backend, '/spending', false);
    await spendingReady();
    expect(document.querySelectorAll('.spending-excluded')).toHaveLength(0);
    expect(screen.queryByText(MARKED)).toBeNull();
    expect(screen.queryByRole('button', { name: /daily allowance/i })).toBeNull();
    expect(spendingValues()).toEqual(spendingOn);
    expect(requestsOf(h.net, /quick-add|category-memory/)).toEqual([]);
    expect(writesOf(h.net)).toEqual([]);
    h.unload();
    expect(stored(backend)).toEqual(beforeFlip);

    // Load 3: Quick Add on again. The mark and the remembered choices are back with no migration step and no write.
    h = load(backend, '/', true);
    await homeReady(true);
    await waitFor(() => expect(headline()).toHaveTextContent(HEADLINE_NOT_COUNTED));
    expect(await homeValues()).toEqual(homeOn);
    await h.user.type(input(), '40 coffee');
    expect(categoryChoice()).toHaveValue('Shopping');
    expect(writesOf(h.net)).toEqual([]);
    h.unload();
    h = load(backend, '/spending', true);
    await spendingReady();
    expect(document.querySelectorAll('.spending-excluded')).toHaveLength(1);
    expect(screen.getByText(MARKED)).toBeInTheDocument();
    expect(spendingValues()).toEqual(spendingOn);
    expect(writesOf(h.net)).toEqual([]);
    h.unload();
    expect(stored(backend)).toEqual(beforeFlip);
  });

  it('off to on shows marks and remembered choices that an earlier load saved, without a migration step', async () => {
    const backend = seededServer();
    backend.expenses.push(
      { id: 1, month: MONTH, category: 'Shopping', amountMinor: 30000, note: 'coffee', spentOn: TODAY, version: 1 },
      { id: 2, month: MONTH, category: 'Other', amountMinor: 150000, note: 'laptop', spentOn: TODAY, version: 1 },
    );
    backend.marks.set(2, true);
    const beforeFlip = stored(backend);

    let h = load(backend, '/spending', false);
    await spendingReady();
    expect(screen.queryByText(MARKED)).toBeNull();
    const spendingOff = spendingValues();
    h.unload();
    h = load(backend, '/', false);
    await homeReady(false);
    const homeOff = await homeValues();
    expect(requestsOf(h.net, /quick-add|category-memory/)).toEqual([]);
    h.unload();

    h = load(backend, '/spending', true);
    await spendingReady();
    expect(screen.getByText(MARKED)).toBeInTheDocument();
    expect(spendingValues()).toEqual(spendingOff);
    expect(writesOf(h.net)).toEqual([]);
    h.unload();
    h = load(backend, '/', true);
    await homeReady(true);
    await waitFor(() => expect(headline()).toHaveTextContent(HEADLINE_NOT_COUNTED));
    expect(await homeValues()).toEqual(homeOff);
    await h.user.type(input(), '40 metro');
    expect(categoryChoice()).toHaveValue('Transport');
    expect(writesOf(h.net)).toEqual([]);
    h.unload();
    expect(stored(backend)).toEqual(beforeFlip);
  });

  it('discards an entry that was typed but not sent when the application unloads, and keeps nothing of it', async () => {
    const backend = seededServer();
    const h = load(backend, '/', true);
    await homeReady(true);
    await h.user.type(input(), '300 coffee');
    expect(input()).toHaveValue('300 coffee');
    h.unload();
    expect(backend.expenses).toEqual([]);
    // Nothing of the typed line was kept anywhere the next load could read it.
    for (const storage of [localStorage, sessionStorage]) {
      for (let index = 0; index < storage.length; index += 1) {
        expect(`${storage.key(index)}=${storage.getItem(storage.key(index) as string)}`).not.toContain('coffee');
      }
    }
    const next = load(backend, '/', true);
    await homeReady(true);
    expect(input()).toHaveValue('');
    expect(next.store.getState().entries).toEqual([]);
    expect(writesOf(next.net)).toEqual([]);
    next.unload();
  });

  it('with the server flag off and the client flag on, entries save, hints are read, and memory writes are not retried', async () => {
    const backend = seededServer();
    backend.memoryWritesDisabled = true;
    const h = load(backend, '/', true);
    await homeReady(true);
    expect(requestsOf(h.net, new RegExp(HINTS))).toHaveLength(1);
    // The remembered choice for "coffee" is still used for the suggestion.
    await h.user.type(input(), '40 coffee');
    expect(categoryChoice()).toHaveValue('Shopping');
    await h.user.clear(input());
    // Choosing another category would be remembered, and the disabled answer is the first and last write attempt.
    await h.user.type(input(), '120 chai');
    await h.user.selectOptions(categoryChoice(), 'Transport');
    await h.user.click(input());
    await h.user.keyboard('{Enter}');
    await waitFor(() => expect(h.store.getState().entries[0]?.phase).toBe('saved'));
    await waitFor(() => expect(requestsOf(h.net, new RegExp(`${MEMORY}$`))).toHaveLength(1));
    await h.user.type(input(), '80 tea');
    await h.user.selectOptions(categoryChoice(), 'Transport');
    await h.user.click(input());
    await h.user.keyboard('{Enter}');
    await waitFor(() => expect(h.store.getState().entries[1]?.phase).toBe('saved'));
    expect(requestsOf(h.net, new RegExp(`${MEMORY}$`))).toHaveLength(1);
    expect(requestsOf(h.net, new RegExp(HINTS))).toHaveLength(1);
    expect(h.net.to('POST', EXPENSES)).toHaveLength(2);
    expect(backend.expenses.map((expense) => expense.category)).toEqual(['Transport', 'Transport']);
    // No remembered choice was created, and none was removed.
    expect(backend.memory.map((entry) => entry.noteKey).sort()).toEqual(['coffee', 'metro']);
    h.unload();
  });
});

describe('an old server: no todayAllowance, no memory routes, and no mark support', () => {
  beforeEach(() => {
    vi.setSystemTime(NOW);
    Object.defineProperty(window.navigator, 'platform', { value: 'Win32', configurable: true });
  });
  afterEach(() => {
    resetSharedMemoryClient();
    resetExpenseEventsForTests();
    delete (window.navigator as unknown as Record<string, unknown>).platform;
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true, writable: true });
  });

  it('shows the unavailable headline and every monthly value, and Quick Add still saves the entry', async () => {
    const backend = new OldServer(MONTH, { categories: [...BUILT_IN_CATEGORIES] });
    const h = load(backend, '/', true);
    await homeReady(true, 'unavailable');
    expect(unavailableHeadline()).toHaveTextContent('Temporarily unavailable');
    expect(within(headline()).getByText(/You can still save expenses/)).toBeInTheDocument();
    expect(planCard()).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Logging streak/ })).toBeInTheDocument();
    await saveEntry(h, '120 coffee');
    expect(h.net.to('POST', EXPENSES)).toHaveLength(1);
    expect(backend.expenses).toHaveLength(1);
    // The answer is the monthly one: no Today values, and no sentence about a server that did not send them.
    const region = screen.getByRole('region', { name: ANSWER_TITLE });
    expect(region).toHaveTextContent('Saved ₹120 to Food: coffee.');
    expect(region).not.toHaveTextContent(/left today|Spent today/);
    expect(unavailableHeadline()).not.toBeNull();
    h.unload();
  });

  it('suggests from keywords and category names only, says memory is unavailable, and sends no memory request', async () => {
    const backend = new OldServer(MONTH, { categories: [...BUILT_IN_CATEGORIES] });
    const h = load(backend, '/', true);
    await homeReady(true, 'unavailable');
    await waitFor(() => expect(requestsOf(h.net, new RegExp(HINTS))).toHaveLength(1));
    await h.user.type(input(), '120 coffee');
    expect(categoryChoice()).toHaveValue('Food');
    expect(screen.getByText('"coffee" usually means Food.')).toBeInTheDocument();
    expect(screen.getByText(HINTS_UNAVAILABLE_TEXT)).toBeInTheDocument();
    // Choosing another category would be remembered on a server that remembers. This one is not asked.
    await h.user.selectOptions(categoryChoice(), 'Shopping');
    await h.user.click(input());
    await h.user.keyboard('{Enter}');
    await waitFor(() => expect(h.store.getState().entries[0]?.phase).toBe('saved'));
    expect(backend.expenses.map((expense) => expense.category)).toEqual(['Shopping']);
    await h.user.type(input(), 'Groceries 300');
    expect(categoryChoice()).toHaveValue('Groceries');
    // Accepting a suggestion asks nothing of the memory routes. Only the one changed choice tried a write, which the
    // server could not take, and the expense stayed saved either way.
    expect(requestsOf(h.net, /category-memory/).length).toBeLessThanOrEqual(1);
    expect(requestsOf(h.net, /category-memory/).every((call) => call.method === 'PUT')).toBe(true);
    expect(h.store.getState().entries[0]?.phase).toBe('saved');
    expect(requestsOf(h.net, new RegExp(HINTS))).toHaveLength(1);
    expect(screen.queryAllByRole('alert').filter((node) => (node.textContent ?? '').trim() !== '')).toEqual([]);
    h.unload();
  });

  it('says the expense was saved and counted against today, and offers the update action, when the server does not confirm the mark', async () => {
    const backend = new OldServer(MONTH, { categories: [...BUILT_IN_CATEGORIES] });
    backend.billLabels = ['Rent'];
    const h = load(backend, '/', true);
    await homeReady(true, 'unavailable');
    await h.user.type(input(), '100 rent');
    expect(await screen.findByText(/This looks like a bill: Rent\./)).toBeInTheDocument();
    await saveEntry(h, '', 'dont-count');
    // The client asked for the exclusion. The old server ignored the field and its record has no mark.
    expect(h.net.to('POST', EXPENSES)[0]?.body).toMatchObject({ amountMinor: 10000, note: 'rent', excludeFromDailyAllowance: true });
    expect(backend.expenses).toHaveLength(1);
    const region = screen.getByRole('region', { name: ANSWER_TITLE });
    expect(region).toHaveTextContent('Saved and counted against today. The server did not confirm the exclusion.');
    expect(region).toHaveTextContent('The server did not confirm the exclusion you asked for.');
    expect(within(region).queryByText(/Not counted against today's allowance\./)).toBeNull();
    expect(unavailableHeadline()).not.toBeNull();

    // The update action sends the one field the Expense_API takes for it. An old server still does not confirm it, and
    // the expense, its amount, and the message stay as they were.
    await h.user.click(within(region).getByRole('button', { name: EXCLUDE_LABEL }));
    await waitFor(() => expect(h.net.to('PATCH', `${EXPENSES}/1`)).toHaveLength(1));
    expect(h.net.to('PATCH', `${EXPENSES}/1`)[0]?.body).toMatchObject({ excludeFromDailyAllowance: true });
    expect(backend.expenses.map((expense) => expense.amountMinor)).toEqual([10000]);
    await waitFor(() => expect(screen.queryByRole('button', { name: EXCLUDING_LABEL })).toBeNull());
    expect(screen.getByRole('region', { name: ANSWER_TITLE })).toHaveTextContent('Saved and counted against today.');
    expect(screen.queryByText(/Not counted against today's allowance\./)).toBeNull();
    h.unload();
  });

  it('shows the Spending page as it was: no mark text and no mark control, while Quick Add is on', async () => {
    const backend = new OldServer(MONTH, { categories: [...BUILT_IN_CATEGORIES], expenses: [{ category: 'Food', amount: 500, day: 18 }] });
    const h = load(backend, '/spending', true);
    await spendingReady();
    expect(screen.queryByText(MARKED)).toBeNull();
    expect(document.querySelectorAll('.spending-excluded')).toHaveLength(0);
    expect(writesOf(h.net)).toEqual([]);
    h.unload();
  });
});

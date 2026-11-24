// Quick Add end to end through the real providers (task 13.4; Requirements 1.9 to 1.11, 1.15 to 1.18, 3.2, 3.6 to 3.14,
// 4.5, 7.1, 18.5 to 18.7). Each test drives the real Shell, QuickAddProvider, mutation runner, answer builder, category
// memory client, and announcer against the transport-free FakeQuickAddBackend. Nothing is mocked inside the feature.
//
// The pieces (input, preview, warning, status rows, answer, shortcut host, dialog, floating action) have their own tests
// in quickAddUi.test.tsx, quickAddEntries.test.tsx, and Shell.quickAddHost.test.tsx. This file covers the flows that
// join them:
//
// - type, preview, Enter, saved row and answer, Undo, on the inline panel and in the dialog at 390 CSS pixels,
// - a past-date entry, the large-entry and bill warnings with both save choices,
// - category correction, category memory, and Forget this,
// - a failed save (Retry with the same key), a validation failure (Edit with a new key), five entries in flight,
// - the data-use gated state, a keyboard-only flow, the screen-reader announcements,
// - request count while typing, no entry value in the console, storage, cookies, address, or URLs,
// - reduced motion, and axe in the light and dark themes for the composed states.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FinancialSnapshot } from '../../clarity/contracts';
import { PROMISE_RENDERED_KEY } from '../../clarity/DataUseGateProvider';
import { FinancialClarityProvider } from '../../clarity/FinancialClarityProvider';
import { MutationStatusProvider } from '../../clarity/MutationStatusProvider';
import { BUILT_IN_CATEGORIES } from '../../clarity/quickAdd/keywordRules';
import { resetServerTimeOffset } from '../../clarity/quickAdd/kolkata';
import { QuickAddProvider } from '../../clarity/quickAdd/QuickAddProvider';
import { createQuickAddStore, type QuickAddStore } from '../../clarity/quickAdd/quickAddStore';
import { REMOVED_TEXT, SAVE_FAILED_TEXT } from '../../clarity/quickAdd/useQuickAddActions';
import { buildSettings } from '../../test/claritySettingsBuilder';
import { FakeQuickAddBackend } from '../../test/fakeQuickAddBackend';
import { installSpendingFetch, type SpendingFetch } from '../../test/fakeSpendingFetch';
import type { SpendingBackendReply, SpendingBackendRequest } from '../../test/fakeSpendingBackend';
import { resetSharedMemoryClient } from '../../test/settingsMemoryServer';
import { axe, createTestQueryClient, createTestUser, renderAuthenticated } from '../../test/test-utils';
import { Shell } from '../Shell';
import { ANSWER_TITLE, REMOVED_TITLE } from './EntryAnswer';
import { SAVE_AND_COUNT_LABEL, SAVE_WITHOUT_COUNTING_LABEL } from './EntryWarning';
import { FORGET_DONE_TEXT } from './QuickAddDraft';
import { QUICK_ADD_DIALOG_TITLE } from './QuickAddDialog';
import { FAB_HEIGHT_PROPERTY, FAB_LABEL } from './QuickAddFab';
import { QUICK_ADD_LABEL } from './QuickAddInput';
import { QuickAddPanel } from './QuickAddPanel';
import {
  EDIT_HELP_TEXT,
  FAILED_TEXT,
  NOT_COUNTED_TEXT,
  SAVED_TEXT,
  UNDONE_TEXT,
} from './QuickAddEntries';
import { UNDO_AVAILABLE_TEXT } from './UndoControl';

const MONTH = '2026-11';
const TODAY = '2026-11-18';
const NOW = Date.parse('2026-11-18T06:30:00.000Z');
const EXPENSES = '/finance/expenses';
const MEMORY = '/finance/category-memory';
const HINTS = '/finance/quick-add/hints';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const entriesCss = readFileSync('src/components/quickAdd/quickAddEntries.css', 'utf8');

/* --------------------------------- harness ---------------------------------- */

/** The Spending fake with the category list, the data-use settings the Shell's gate reads, and saved bills. */
class FlowBackend extends FakeQuickAddBackend {
  noticeAcknowledged = true;
  billLabels: string[] = [];
  override snapshot(month: string = this.month): FinancialSnapshot {
    const snapshot = super.snapshot(month);
    if (this.billLabels.length === 0) return snapshot;
    return {
      ...snapshot,
      facts: this.billLabels.map((label, index) => ({
        classification: 'entered_fact' as const,
        source: {
          sourceType: 'bill' as const,
          recordId: 900 + index,
          field: 'amount',
          label,
          value: { currency: 'INR' as const, amountMinor: 2_500_000 },
          period: { month },
        },
      })),
    };
  }
  override handle(request: SpendingBackendRequest): SpendingBackendReply {
    const get = request.method.toUpperCase() === 'GET';
    if (get && request.path === '/finance/categories') {
      return { status: 200, body: { defaults: [...BUILT_IN_CATEGORIES], custom: [] } };
    }
    if (get && request.path === '/clarity/settings') {
      return { status: 200, body: buildSettings({ acknowledgedVersion: this.noticeAcknowledged ? 1 : 0 }) };
    }
    return super.handle(request);
  }
}

/** A viewport the test can resize (900px media query) with a reduced-motion preference. */
function installViewport(initiallyWide: boolean, reducedMotion: boolean) {
  let wide = initiallyWide;
  const listeners = new Set<() => void>();
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      if (/prefers-reduced-motion:\s*reduce/.test(query)) return reducedMotion;
      return /min-width:\s*900px/.test(query) ? wide : false;
    },
    media: query,
    onchange: null,
    addEventListener: (_type: string, listener: () => void) => { listeners.add(listener); },
    removeEventListener: (_type: string, listener: () => void) => { listeners.delete(listener); },
    addListener: (listener: () => void) => { listeners.add(listener); },
    removeListener: (listener: () => void) => { listeners.delete(listener); },
    dispatchEvent: () => false,
  }));
  return {
    resize(next: boolean) {
      wide = next;
      act(() => { for (const listener of [...listeners]) listener(); });
    },
  };
}

interface Harness {
  user: ReturnType<typeof userEvent.setup>;
  backend: FlowBackend;
  net: SpendingFetch;
  store: QuickAddStore;
  container: HTMLElement;
}
interface MountOptions {
  route?: '/' | '/spending';
  /** 900px and wider (inline panel, no floating action) or the 390px phone layout. */
  width?: 'desktop' | 'mobile';
  noticeAcknowledged?: boolean;
  reducedMotion?: boolean;
  bills?: string[];
  prepare?(backend: FlowBackend, net: SpendingFetch): void;
}

function HomePage() {
  return (
    <>
      <h1>Home page</h1>
      <QuickAddPanel variant="inline" headingLevel={2} />
    </>
  );
}
function SpendingPage() {
  return (
    <>
      <h1>Spending page</h1>
      <button type="button">Page button</button>
    </>
  );
}

function mount(options: MountOptions = {}): Harness {
  const width = options.width ?? 'desktop';
  vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'true');
  vi.stubEnv('VITE_QUICK_ADD_ENABLED', 'true');
  sessionStorage.setItem(PROMISE_RENDERED_KEY, '4242');
  window.innerWidth = width === 'mobile' ? 390 : 1280;
  installViewport(width === 'desktop', options.reducedMotion ?? false);
  Object.defineProperty(window.navigator, 'platform', { value: 'Win32', configurable: true });
  const backend = new FlowBackend(MONTH, { categories: [...BUILT_IN_CATEGORIES] });
  backend.todayDate = TODAY;
  backend.noticeAcknowledged = options.noticeAcknowledged ?? true;
  backend.billLabels = options.bills ?? [];
  const net = installSpendingFetch(backend);
  options.prepare?.(backend, net);
  const store = createQuickAddStore();
  const view = renderAuthenticated(
    <FinancialClarityProvider>
      <MutationStatusProvider>
        <QuickAddProvider store={store}>
          <Routes>
            <Route element={<Shell />}>
              <Route path="/" element={<HomePage />} />
              <Route path="/spending" element={<SpendingPage />} />
            </Route>
          </Routes>
        </QuickAddProvider>
      </MutationStatusProvider>
    </FinancialClarityProvider>,
    { route: options.route ?? '/', queryClient: createTestQueryClient(), user: createTestUser({ is_admin: false }) },
  );
  return { user: userEvent.setup(), backend, net, store, container: view.container };
}

beforeEach(() => {
  vi.setSystemTime(NOW);
});
afterEach(() => {
  resetSharedMemoryClient();
  resetServerTimeOffset();
  delete (window.navigator as unknown as Record<string, unknown>).platform;
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.style.removeProperty(FAB_HEIGHT_PROPERTY);
  document.documentElement.style.removeProperty('--bottom-nav-h');
});

const input = () => screen.getByLabelText(QUICK_ADD_LABEL) as HTMLInputElement;
const dialog = () => screen.queryByRole('dialog', { name: QUICK_ADD_DIALOG_TITLE });
const fab = () => screen.queryByRole('button', { name: FAB_LABEL });
const polite = () => screen.getByTestId('quick-add-polite');
const assertive = () => screen.getByTestId('quick-add-assertive');
const rows = () => [...document.querySelectorAll<HTMLElement>('li.qa-entry')];
const preview = () => document.querySelector('.qa-preview') as HTMLElement;
const answer = () => document.querySelector('.qa-answer')?.textContent ?? '';
const categoryChoice = () => screen.getByLabelText('Category', { selector: '.qa-preview select' }) as HTMLSelectElement;
const writes = (h: Harness) => h.net.calls.filter((call) => call.method !== 'GET' && !call.path.startsWith('/api/clarity/events'));
const phases = (h: Harness) => h.store.getState().entries.map((entry) => entry.phase);

/** The page is up, the data-use gate has read its settings, and (on Home) the Quick Add hints have been read. */
async function ready(h: Harness, route: '/' | '/spending' = '/') {
  await screen.findByRole('heading', { name: route === '/' ? 'Home page' : 'Spending page' });
  await waitFor(() => expect(h.net.to('GET', '/clarity/settings').length).toBeGreaterThan(0));
  // Only a mounted panel reads the hints. Away from Home nothing reads them until the dialog opens.
  if (route === '/') await waitFor(() => expect(h.net.to('GET', HINTS).length).toBeGreaterThan(0));
}

/** Types a line into the visible input and presses Enter, as a person at a keyboard does. */
async function enter(h: Harness, line: string) {
  await h.user.type(input(), `${line}{Enter}`);
}
/** Waits for the newest entry (the store keeps entries oldest first) to reach a phase. */
async function waitForPhase(h: Harness, expected: string) {
  await waitFor(() => expect(h.store.getState().entries.at(-1)?.phase).toBe(expected));
}

/* ------------------------- the main flow: type to Undo ----------------------- */

describe('type, preview, Enter, saved row and answer, Undo (desktop inline panel)', () => {
  it('previews as the User types, sends nothing until Enter, then saves, answers, and restores everything on Undo', async () => {
    const h = mount();
    await ready(h);
    expect(screen.queryByRole('button', { name: FAB_LABEL })).toBeNull();
    expect(dialog()).toBeNull();
    const requestsBefore = h.net.calls.length;

    await h.user.type(input(), '120 coffee');
    // The preview names the amount, the category with its reason, the date as Today, and the note.
    expect(within(preview()).getByText('₹120')).toBeInTheDocument();
    expect(within(preview()).getByText('Wednesday, 18 November 2026')).toBeInTheDocument();
    expect(within(preview()).getByText('Today')).toBeInTheDocument();
    expect(within(preview()).getByText('coffee')).toBeInTheDocument();
    expect(categoryChoice()).toHaveValue('Food');
    expect(within(preview()).getByText('"coffee" usually means Food.')).toBeInTheDocument();
    // Nothing was sent while typing (Requirement 7.1).
    expect(h.net.calls.length).toBe(requestsBefore);
    expect(writes(h)).toHaveLength(0);

    await h.user.keyboard('{Enter}');
    await waitForPhase(h, 'saved');
    expect(input()).toHaveValue('');
    expect(input()).toHaveFocus();
    // One expense, saved through the expense route with structured fields only.
    const posts = h.net.to('POST', EXPENSES);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toEqual({ amountMinor: 12000, category: 'Food', note: 'coffee', spentOn: TODAY });
    expect(posts[0]?.headers['idempotency-key']).toMatch(UUID);
    expect(h.backend.expenses).toHaveLength(1);
    // The saved row and the immediate answer, from the server's own values.
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toHaveAttribute('data-phase', 'saved');
    expect(rows()[0]).toHaveTextContent(SAVED_TEXT);
    expect(rows()[0]).toHaveTextContent(UNDO_AVAILABLE_TEXT);
    const region = screen.getByRole('region', { name: ANSWER_TITLE });
    expect(region).toHaveTextContent('Saved ₹120 to Food: coffee.');
    expect(region).toHaveTextContent("Spent today: ₹120 of today's allowance of ₹3,000.");
    expect(region).toHaveTextContent('₹2,880 left today.');

    // Undo removes exactly that expense, and the answer shows the values after the removal.
    await h.user.click(screen.getByRole('button', { name: 'Undo ₹120 coffee' }));
    await waitForPhase(h, 'undone');
    expect(h.backend.expenses).toHaveLength(0);
    expect(h.net.to('DELETE', `${EXPENSES}/${h.store.getState().entries[0]?.expenseId}`)).toHaveLength(1);
    expect(rows()[0]).toHaveTextContent(UNDONE_TEXT);
    expect(screen.getByRole('heading', { name: REMOVED_TITLE })).toBeInTheDocument();
    expect(answer()).toContain('₹3,000 left today.');
    expect(input()).toHaveFocus();
  });

  it('shows the answer for a past-date entry: the date it counts for and not today', async () => {
    const h = mount();
    await ready(h);
    await h.user.type(input(), 'swiggy 450 yesterday');
    expect(within(preview()).getByText('Tuesday, 17 November 2026')).toBeInTheDocument();
    expect(within(preview()).queryByText('Today')).toBeNull();
    await h.user.keyboard('{Enter}');
    await waitForPhase(h, 'saved');
    expect(h.net.to('POST', EXPENSES)[0]?.body).toEqual({
      amountMinor: 45000, category: 'Food', note: 'swiggy', spentOn: '2026-11-17',
    });
    expect(answer()).toContain('Saved ₹450 to Food: swiggy.');
    expect(answer()).toContain('Dated Tuesday, 17 November 2026, not today.');
    expect(rows()[0]).toHaveTextContent('swiggy');
    // The entry is not dated today, so it does not change today's spending.
    expect(answer()).not.toContain('Spent today: ₹450');
  });
});

/* ------------------------------- warnings ----------------------------------- */

describe('large entry and bill warnings with the exclusion choice', () => {
  it('warns about a large entry, saves it with the mark on request, and shows it as not counted today', async () => {
    const h = mount();
    await ready(h);
    await h.user.type(input(), '1500 laptop');
    expect(await screen.findByText(/This amount is large compared with this month's spendable budget\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: SAVE_AND_COUNT_LABEL })).toBeEnabled();
    // The warning does not move focus, and typing sent nothing.
    expect(writes(h)).toHaveLength(0);
    await h.user.click(screen.getByRole('button', { name: SAVE_WITHOUT_COUNTING_LABEL }));
    await waitForPhase(h, 'saved');
    const posts = h.net.to('POST', EXPENSES);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toEqual({
      amountMinor: 150000, category: expect.any(String), note: 'laptop', spentOn: TODAY, excludeFromDailyAllowance: true,
    });
    expect(h.backend.marks.get(h.backend.expenses[0]?.id ?? 0)).toBe(true);
    expect(rows()[0]).toHaveTextContent(NOT_COUNTED_TEXT);
    expect(input()).toHaveFocus();
    expect(screen.queryByRole('button', { name: SAVE_WITHOUT_COUNTING_LABEL })).toBeNull();
  });

  it('warns about a bill with its label, offers both save choices, and counts today on "Save and count today"', async () => {
    const h = mount({ bills: ['Rent'] });
    await ready(h);
    await h.user.type(input(), '100 rent');
    expect(await screen.findByText(/This looks like a bill: Rent\./)).toBeInTheDocument();
    expect(screen.getByText(/Your Plan already includes this bill\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: SAVE_WITHOUT_COUNTING_LABEL })).toBeEnabled();
    await h.user.click(screen.getByRole('button', { name: SAVE_AND_COUNT_LABEL }));
    await waitForPhase(h, 'saved');
    const body = h.net.to('POST', EXPENSES)[0]?.body as Record<string, unknown>;
    expect(body).toMatchObject({ amountMinor: 10000, note: 'rent' });
    expect(body).not.toHaveProperty('excludeFromDailyAllowance');
    expect(rows()[0]).not.toHaveTextContent(NOT_COUNTED_TEXT);
  });

  it('gives one warning for a large bill and Enter saves it counted, without the mark', async () => {
    const h = mount({ bills: ['Rent'] });
    await ready(h);
    await h.user.type(input(), '5000 rent');
    const text = await screen.findByText(/This looks like a bill: Rent\./);
    expect(text).toHaveTextContent(/large compared with this month's spendable budget/);
    expect(screen.getAllByText(/Check before saving\./)).toHaveLength(1);
    await h.user.keyboard('{Enter}');
    await waitForPhase(h, 'saved');
    expect(h.net.to('POST', EXPENSES)[0]?.body).not.toHaveProperty('excludeFromDailyAllowance');
  });
});

/* ------------------------ category correction and memory --------------------- */

describe('category correction, memory, and Forget this', () => {
  it('saves the chosen category, remembers it, suggests it next time with its reason, and forgets it on request', async () => {
    const h = mount();
    await ready(h);
    await h.user.type(input(), '120 coffee');
    await h.user.selectOptions(categoryChoice(), 'Transport');
    expect(screen.getByText(/You chose Transport\. Quick Add suggested Food/)).toBeInTheDocument();
    await h.user.click(input());
    await h.user.keyboard('{Enter}');
    await waitForPhase(h, 'saved');
    expect(h.net.to('POST', EXPENSES)[0]?.body).toMatchObject({ category: 'Transport', note: 'coffee' });
    await waitFor(() => expect(h.backend.memoryFor('coffee')?.category).toBe('Transport'));
    expect(h.net.to('PUT', MEMORY)).toHaveLength(1);

    // The next entry with the same note starts at the remembered category and says why.
    await h.user.type(input(), '80 coffee');
    await waitFor(() => expect(categoryChoice()).toHaveValue('Transport'));
    expect(screen.getByText('You corrected "coffee" to Transport before.')).toBeInTheDocument();

    const memoryId = h.backend.memoryFor('coffee')?.id;
    await h.user.click(screen.getByRole('button', { name: 'Forget this' }));
    await waitFor(() => expect(h.backend.memory).toHaveLength(0));
    expect(h.net.to('DELETE', `${MEMORY}/${memoryId}`)).toHaveLength(1);
    expect(await screen.findByText(FORGET_DONE_TEXT)).toBeInTheDocument();
    await waitFor(() => expect(categoryChoice()).toHaveValue('Food'));
    expect(screen.queryByRole('button', { name: 'Forget this' })).toBeNull();
    // The expense saved earlier is untouched by forgetting the memory.
    expect(h.backend.expenses).toHaveLength(1);
    expect(h.backend.expenses[0]?.category).toBe('Transport');
  });

  it('changes the category of a saved entry from its row and updates the remembered choice', async () => {
    const h = mount();
    await ready(h);
    await enter(h, '120 coffee');
    await waitForPhase(h, 'saved');
    const select = within(rows()[0] as HTMLElement).getByLabelText('Category');
    await h.user.selectOptions(select, 'Transport');
    await waitFor(() => expect(h.backend.expenses[0]?.category).toBe('Transport'));
    expect(h.net.to('PATCH', `${EXPENSES}/${h.backend.expenses[0]?.id}`)).toHaveLength(1);
    await waitFor(() => expect(h.backend.memoryFor('coffee')?.category).toBe('Transport'));
  });
});

/* ----------------------------- failures ------------------------------------- */

describe('a failed save', () => {
  it('keeps the entry, shows Retry, Edit, and Discard, and Retry sends the same Idempotency-Key and saves it once', async () => {
    const h = mount({ prepare: (backend) => backend.failWith('POST', EXPENSES, { status: 503, code: 'UNAVAILABLE', message: 'Try again.' }) });
    await ready(h);
    await enter(h, '120 coffee');
    await waitForPhase(h, 'failed');
    const row = rows()[0] as HTMLElement;
    expect(row).toHaveTextContent(FAILED_TEXT);
    expect(row).toHaveTextContent('₹120');
    expect(row).toHaveTextContent('coffee');
    expect(within(row).getByRole('button', { name: 'Retry saving ₹120 coffee' })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Edit ₹120 coffee' })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Discard ₹120 coffee' })).toBeInTheDocument();
    expect(h.backend.expenses).toHaveLength(0);
    // The failure is announced assertively, once, and the polite region stays quiet.
    expect(assertive()).toHaveTextContent(SAVE_FAILED_TEXT);
    expect(polite()).toHaveTextContent('');

    await h.user.click(within(row).getByRole('button', { name: /^Retry saving/ }));
    await waitForPhase(h, 'saved');
    const posts = h.net.to('POST', EXPENSES);
    expect(posts).toHaveLength(2);
    expect(posts[0]?.headers['idempotency-key']).toMatch(UUID);
    expect(posts[1]?.headers['idempotency-key']).toBe(posts[0]?.headers['idempotency-key']);
    expect(h.backend.expenses).toHaveLength(1);
    expect(rows()).toHaveLength(1);
    expect(answer()).toContain('Saved ₹120 to Food: coffee.');
  });

  it('offers no Retry for a validation failure; Edit brings the line back and the next save uses a new key', async () => {
    const h = mount({
      prepare: (backend) => backend.failWith('POST', EXPENSES, {
        status: 422, code: 'VALIDATION_ERROR', field: 'amountMinor', message: 'The amount is too large.',
      }),
    });
    await ready(h);
    await enter(h, '120 coffee');
    await waitForPhase(h, 'failed');
    const row = rows()[0] as HTMLElement;
    expect(row).toHaveTextContent('Amount: The amount is too large.');
    expect(row).toHaveTextContent(EDIT_HELP_TEXT);
    expect(within(row).queryByRole('button', { name: /^Retry/ })).toBeNull();
    const firstKey = h.net.to('POST', EXPENSES)[0]?.headers['idempotency-key'];

    await h.user.click(within(row).getByRole('button', { name: /^Edit/ }));
    expect(input()).toHaveValue(`₹120 ${TODAY} "coffee"`);
    expect(input()).toHaveFocus();
    expect(rows()).toHaveLength(0);
    await h.user.keyboard('{Enter}');
    await waitForPhase(h, 'saved');
    const posts = h.net.to('POST', EXPENSES);
    expect(posts).toHaveLength(2);
    expect(posts[1]?.headers['idempotency-key']).toMatch(UUID);
    expect(posts[1]?.headers['idempotency-key']).not.toBe(firstKey);
    expect(posts[1]?.body).toEqual({ amountMinor: 12000, category: 'Food', note: 'coffee', spentOn: TODAY });
    expect(h.backend.expenses).toHaveLength(1);
  });

  it('leaves the other entries alone when one entry fails', async () => {
    const h = mount();
    await ready(h);
    await enter(h, '10 tea');
    await waitForPhase(h, 'saved');
    h.backend.failWith('POST', EXPENSES, { status: 500, code: 'INTERNAL_ERROR' });
    await enter(h, '20 chai');
    await waitForPhase(h, 'failed');
    await enter(h, '30 lunch');
    await waitForPhase(h, 'saved');
    expect(h.store.getState().entries.map((entry) => `${entry.parsed.amountMinor}:${entry.phase}`).sort())
      .toEqual(['1000:saved', '2000:failed', '3000:saved']);
    expect(h.backend.expenses).toHaveLength(2);
  });
});

/* ------------------------------ five rapid entries --------------------------- */

describe('five rapid entries', () => {
  it('saves five entries in flight, each with its own row and key, whatever order the server answers in', async () => {
    const gates: Array<{ release(): void }> = [];
    const h = mount({
      prepare: (_backend, net) => { for (let i = 0; i < 5; i += 1) gates.push(net.hold('POST', EXPENSES)); },
    });
    await ready(h);
    for (const amount of [10, 20, 30, 40, 50]) await enter(h, `${amount} tea`);
    await waitFor(() => expect(rows()).toHaveLength(5));
    expect(phases(h)).toEqual(['pending', 'pending', 'pending', 'pending', 'pending']);
    // The newest entry is first, and every pending row says so on its own.
    expect(rows()[0]).toHaveTextContent('₹50');
    expect(rows()[4]).toHaveTextContent('₹10');
    expect(h.backend.expenses).toHaveLength(0);
    // No page-wide loading state while they save.
    expect(screen.queryByRole('progressbar')).toBeNull();

    // The server answers newest first.
    act(() => { [...gates].reverse().forEach((gate) => gate.release()); });
    await waitFor(() => expect(phases(h)).toEqual(['saved', 'saved', 'saved', 'saved', 'saved']));
    expect(h.backend.expenses).toHaveLength(5);
    const keys = h.net.to('POST', EXPENSES).map((call) => call.headers['idempotency-key']);
    expect(keys).toHaveLength(5);
    expect(new Set(keys).size).toBe(5);
    keys.forEach((key) => expect(key).toMatch(UUID));
    expect(rows().map((row) => row.getAttribute('data-phase'))).toEqual(['saved', 'saved', 'saved', 'saved', 'saved']);
    // One answer, never five.
    expect(screen.getAllByRole('region', { name: ANSWER_TITLE })).toHaveLength(1);
    expect(h.backend.expenses.map((expense) => expense.amountMinor).sort((a, b) => a - b)).toEqual([1000, 2000, 3000, 4000, 5000]);
  });
});

/* -------------------------------- data-use gate ------------------------------ */

describe('data-use gated state', () => {
  it('keeps the input and preview working, pauses saving with the reason, and sends nothing on Enter', async () => {
    const h = mount({ noticeAcknowledged: false });
    await ready(h);
    await screen.findByRole('button', { name: /I have read this/ });
    const reasons = await screen.findAllByText(/Review and acknowledge the data-use notice/);
    expect(input()).toBeEnabled();
    await h.user.type(input(), '120 coffee');
    expect(within(preview()).getByText('₹120')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    // The input is described by the reason that sits with it.
    const describedBy = (input().getAttribute('aria-describedby') ?? '').split(' ');
    expect(reasons.some((reason) => describedBy.includes(reason.closest('p')?.id ?? 'missing'))).toBe(true);
    await h.user.keyboard('{Enter}');
    expect(writes(h)).toHaveLength(0);
    expect(input()).toHaveValue('120 coffee');
    expect(rows()).toHaveLength(0);
    // The shortcut is left to the browser while the notice is waiting to be read.
    expect(fireEvent.keyDown(document.body, { key: 'k', code: 'KeyK', ctrlKey: true })).toBe(true);
    expect(dialog()).toBeNull();
  });
});

/* ---------------------------- keyboard-only flow ----------------------------- */

describe('keyboard-only complete flow', () => {
  it('goes from the shortcut to a saved entry, Undo, and back to the input without a pointer', async () => {
    const h = mount({ route: '/spending' });
    await ready(h, '/spending');
    const opener = screen.getByRole('button', { name: 'Page button' });
    opener.focus();
    await h.user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('dialog', { name: QUICK_ADD_DIALOG_TITLE });
    await waitFor(() => expect(input()).toHaveFocus());
    await h.user.keyboard('120 coffee');
    expect(within(preview()).getByText('₹120')).toBeInTheDocument();
    // Tab leaves the input for the Save button and Shift+Tab comes back, then Enter in the input saves.
    await h.user.tab();
    expect(screen.getByRole('button', { name: 'Save' })).toHaveFocus();
    await h.user.tab({ shift: true });
    expect(input()).toHaveFocus();
    await h.user.keyboard('{Enter}');
    await waitForPhase(h, 'saved');
    expect(input()).toHaveFocus();
    // Reach Undo by Tab alone and press it with Enter.
    const undo = screen.getByRole('button', { name: 'Undo ₹120 coffee' });
    for (let step = 0; step < 6 && document.activeElement !== undo; step += 1) await h.user.tab();
    expect(undo).toHaveFocus();
    await h.user.keyboard('{Enter}');
    await waitForPhase(h, 'undone');
    expect(h.backend.expenses).toHaveLength(0);
    await waitFor(() => expect(input()).toHaveFocus());
    await h.user.keyboard('{Escape}');
    await waitFor(() => expect(dialog()).toBeNull());
    expect(opener).toHaveFocus();
  });

  it('works on the inline panel too: the shortcut focuses the Home input and Enter saves', async () => {
    const h = mount();
    await ready(h);
    await h.user.keyboard('{Control>}k{/Control}');
    await waitFor(() => expect(input()).toHaveFocus());
    expect(dialog()).toBeNull();
    await h.user.keyboard('75 auto{Enter}');
    await waitForPhase(h, 'saved');
    expect(h.net.to('POST', EXPENSES)[0]?.body).toMatchObject({ amountMinor: 7500, note: 'auto' });
  });
});

/* ---------------------------- mobile and desktop ---------------------------- */

describe('mobile (390 CSS pixels) dialog flow', () => {
  it('opens from the floating action, saves, answers, undoes inside the dialog, and returns focus to the action', async () => {
    const h = mount({ width: 'mobile', route: '/spending' });
    await ready(h, '/spending');
    expect(window.innerWidth).toBe(390);
    const opener = fab() as HTMLElement;
    expect(opener).not.toBeNull();
    expect(document.documentElement.style.getPropertyValue(FAB_HEIGHT_PROPERTY)).not.toBe('');
    await h.user.click(opener);
    const opened = await screen.findByRole('dialog', { name: QUICK_ADD_DIALOG_TITLE });
    await waitFor(() => expect(input()).toHaveFocus());
    expect(opened).toContainElement(input());
    await h.user.type(input(), '120 coffee{Enter}');
    await waitForPhase(h, 'saved');
    // The row and the answer are inside the dialog, which stays open for the next entry.
    expect(opened).toContainElement(rows()[0] as HTMLElement);
    expect(within(opened).getByRole('region', { name: ANSWER_TITLE })).toHaveTextContent('Saved ₹120 to Food: coffee.');
    expect(input()).toHaveFocus();
    await h.user.click(within(opened).getByRole('button', { name: 'Undo ₹120 coffee' }));
    await waitForPhase(h, 'undone');
    expect(h.backend.expenses).toHaveLength(0);
    await h.user.keyboard('{Escape}');
    await waitFor(() => expect(dialog()).toBeNull());
    expect(opener).toHaveFocus();
    // Closing the dialog keeps the page where it was.
    expect(screen.getByRole('heading', { name: 'Spending page' })).toBeInTheDocument();
  });

  it('keeps an entry saving when the dialog closes, and shows the result when it reopens', async () => {
    const held: { release?: () => void } = {};
    const h = mount({ width: 'mobile', route: '/spending', prepare: (_b, net) => { held.release = net.hold('POST', EXPENSES).release; } });
    await ready(h, '/spending');
    await h.user.click(fab() as HTMLElement);
    await screen.findByRole('dialog', { name: QUICK_ADD_DIALOG_TITLE });
    await h.user.type(input(), '120 coffee{Enter}');
    await waitFor(() => expect(rows()).toHaveLength(1));
    await h.user.keyboard('{Escape}');
    await waitFor(() => expect(dialog()).toBeNull());
    expect(phases(h)).toEqual(['pending']);
    act(() => held.release?.());
    await waitForPhase(h, 'saved');
    await h.user.click(fab() as HTMLElement);
    await screen.findByRole('dialog', { name: QUICK_ADD_DIALOG_TITLE });
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toHaveAttribute('data-phase', 'saved');
    expect(h.net.to('POST', EXPENSES)).toHaveLength(1);
  });
});

describe('desktop inline panel', () => {
  it('has no floating action or dialog, shows the shortcut beside the input, and saves in place', async () => {
    const h = mount({ width: 'desktop' });
    await ready(h);
    expect(fab()).toBeNull();
    expect(screen.getByText('Ctrl K')).toBeInTheDocument();
    expect(input()).toHaveAttribute('aria-keyshortcuts', 'Control+K');
    await enter(h, '120 coffee');
    await waitForPhase(h, 'saved');
    expect(dialog()).toBeNull();
    expect(document.querySelector('.qa-panel-inline')).toContainElement(rows()[0] as HTMLElement);
  });
});

/* --------------------------- screen-reader announcements --------------------- */

describe('screen-reader announcements', () => {
  it('says nothing while typing, tells the problem without moving focus, then announces the save and the removal once each', async () => {
    const h = mount();
    await ready(h);
    await h.user.type(input(), 'coffee');
    expect(polite()).toHaveTextContent('');
    expect(assertive()).toHaveTextContent('');
    expect(preview().querySelector('[aria-live], [role="alert"], [role="status"]')).toBeNull();

    // Enter on a line without an amount: the problem is text inside the preview, announced as an alert, focus stays.
    await h.user.keyboard('{Enter}');
    const problem = await waitFor(() => {
      const found = preview().querySelector('[role="alert"]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(problem).toHaveTextContent('Amount: The line has no amount.');
    expect(input()).toHaveFocus();
    expect(input()).toHaveAttribute('aria-invalid', 'true');
    expect(writes(h)).toHaveLength(0);

    await h.user.clear(input());
    await h.user.type(input(), '120 coffee{Enter}');
    await waitForPhase(h, 'saved');
    await waitFor(() => expect(polite().textContent).not.toBe(''));
    expect(polite()).toHaveTextContent(/^Saved ₹120 to Food\. ₹2,880 left today\.$/);
    expect(polite().querySelectorAll('span')).toHaveLength(1);
    expect(assertive()).toHaveTextContent('');
    expect(h.store.getState().announcements).toHaveLength(0);
    // The status rows are not live regions themselves.
    for (const row of rows()) expect(row.querySelector('[aria-live], [role="alert"], [role="status"]')).toBeNull();

    await h.user.click(screen.getByRole('button', { name: 'Undo ₹120 coffee' }));
    await waitForPhase(h, 'undone');
    await waitFor(() => expect(polite()).toHaveTextContent(REMOVED_TEXT));
    expect(assertive()).toHaveTextContent('');
  });

  it('announces a failed save through the assertive region only', async () => {
    const h = mount({ prepare: (backend) => backend.failWith('POST', EXPENSES, { status: 500, code: 'INTERNAL_ERROR' }) });
    await ready(h);
    await enter(h, '120 coffee');
    await waitFor(() => expect(assertive()).toHaveTextContent(SAVE_FAILED_TEXT));
    expect(polite()).toHaveTextContent('');
  });
});

/* ------------------------- request count and privacy ------------------------- */

describe('typing performance sanity', () => {
  it('sends zero requests for any number of keystrokes and one expense write on submit', async () => {
    const h = mount();
    await ready(h);
    const before = h.net.calls.length;
    const line = '1234.50 dinner at the corner restaurant with friends yesterday';
    await h.user.type(input(), line);
    // Every keystroke was handled in memory: no snapshot, hint, category, memory, or expense request.
    expect(h.net.calls.length).toBe(before);
    expect(input()).toHaveValue(line);
    expect(within(preview()).getByText('Tuesday, 17 November 2026')).toBeInTheDocument();
    await h.user.keyboard('{Enter}');
    await waitForPhase(h, 'saved');
    expect(h.net.to('POST', EXPENSES)).toHaveLength(1);
    expect(h.net.to('GET', HINTS)).toHaveLength(1);
  });
});

describe('no entry value outside the page', () => {
  it('keeps the typed line, amount, and note out of the console, storage, cookies, address, and request addresses', async () => {
    const consoleCalls: unknown[][] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { consoleCalls.push(args); });
    }
    const h = mount({ prepare: (backend) => backend.failWith('POST', EXPENSES, { status: 500, code: 'INTERNAL_ERROR' }) });
    await ready(h);
    const secrets = ['7777', 'zebra', 'quokka', '8888'];
    await enter(h, '7777 zebra latte');
    await waitForPhase(h, 'failed');
    await h.user.click(within(rows()[0] as HTMLElement).getByRole('button', { name: /^Retry saving/ }));
    await waitForPhase(h, 'saved');
    await h.user.selectOptions(within(rows()[0] as HTMLElement).getByLabelText('Category'), 'Transport');
    await waitFor(() => expect(h.backend.expenses[0]?.category).toBe('Transport'));
    await enter(h, '8888 quokka tea');
    await waitForPhase(h, 'saved');
    await h.user.click(screen.getByRole('button', { name: 'Undo ₹8,888 quokka tea' }));
    await waitForPhase(h, 'undone');

    const outside = JSON.stringify({
      console: consoleCalls.map((args) => args.map((arg) => (arg instanceof Error ? arg.message : String(arg)))),
      local: { ...localStorage },
      session: { ...sessionStorage },
      cookie: document.cookie,
      href: window.location.href,
      historyState: window.history.state,
      urls: h.net.calls.map((call) => `${call.method} ${call.path}?${call.query.toString()}`),
    });
    for (const secret of secrets) expect(outside, secret).not.toContain(secret);
    expect(outside).not.toMatch(/zebra latte|quokka tea/);
    expect(window.location.search).toBe('');
    expect(window.location.hash).toBe('');
    // The values do reach the server where they belong: in the body of the expense write.
    expect(h.net.to('POST', EXPENSES)[0]?.body).toMatchObject({ amountMinor: 777700, note: 'zebra latte' });
  });
});

/* ------------------------------- reduced motion ------------------------------ */

describe('reduced motion', () => {
  it('completes the whole flow with the Undo window as static text, and the stylesheet hides the bar and the countdown', async () => {
    const h = mount({ reducedMotion: true });
    await ready(h);
    expect(window.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true);
    await enter(h, '120 coffee');
    await waitForPhase(h, 'saved');
    // The window is stated in text, so nothing depends on the shrinking bar.
    expect(rows()[0]).toHaveTextContent(UNDO_AVAILABLE_TEXT);
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(entriesCss)?.[1] ?? '';
    expect(reduced).toMatch(/\.qa-undo-bar, \.qa-undo-left \{ display: none; \}/);
    expect(reduced).toMatch(/animation: none !important/);
    expect(reduced).toMatch(/transition: none !important/);
    await h.user.click(screen.getByRole('button', { name: 'Undo ₹120 coffee' }));
    await waitForPhase(h, 'undone');
    expect(h.backend.expenses).toHaveLength(0);
  });
});

/* ----------------------------------- axe ------------------------------------ */

describe.each(['light', 'dark'] as const)('axe in the %s theme', (theme) => {
  beforeEach(() => {
    localStorage.setItem('theme', theme);
  });

  it('has no violations on Home for the empty input, a warning, a saved row with its answer, and a removed entry', async () => {
    const h = mount();
    await ready(h);
    expect(document.documentElement.dataset.theme).toBe(theme);
    expect(await axe(h.container)).toHaveNoViolations();
    await h.user.type(input(), '1500 laptop');
    await screen.findByRole('button', { name: SAVE_WITHOUT_COUNTING_LABEL });
    expect(await axe(h.container)).toHaveNoViolations();
    await h.user.click(screen.getByRole('button', { name: SAVE_WITHOUT_COUNTING_LABEL }));
    await waitForPhase(h, 'saved');
    await screen.findByRole('region', { name: ANSWER_TITLE });
    expect(await axe(h.container)).toHaveNoViolations();
    await h.user.click(screen.getByRole('button', { name: /^Undo/ }));
    await waitForPhase(h, 'undone');
    expect(await axe(h.container)).toHaveNoViolations();
  });

  it('has no violations in the mobile dialog with a failed row, a saved row, and a preview for another month', async () => {
    const h = mount({
      width: 'mobile',
      route: '/spending',
      prepare: (backend) => backend.failWith('POST', EXPENSES, { status: 500, code: 'INTERNAL_ERROR' }),
    });
    await ready(h, '/spending');
    expect(await axe(h.container)).toHaveNoViolations();
    await h.user.click(fab() as HTMLElement);
    await screen.findByRole('dialog', { name: QUICK_ADD_DIALOG_TITLE });
    await h.user.type(input(), '10 tea{Enter}');
    await waitForPhase(h, 'failed');
    await h.user.type(input(), '20 chai{Enter}');
    await waitForPhase(h, 'saved');
    await h.user.type(input(), '5000 bonus 2026-12-05');
    await screen.findByText('Counts toward December 2026, not this month.');
    expect(await axe(h.container)).toHaveNoViolations();
    expect(await axe(document.body)).toHaveNoViolations();
  });

  it('has no violations while the data-use gate pauses saving', async () => {
    const h = mount({ noticeAcknowledged: false });
    await ready(h);
    await screen.findAllByText(/Review and acknowledge the data-use notice/);
    await h.user.type(input(), '120 coffee');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(await axe(h.container)).toHaveNoViolations();
  });
});

// Privacy, request-count, and measurement assertions for Quick Add (task 18.3; Requirements 7.18, 7.20, 13.7, 13.8,
// 14.1, 14.2, 14.3, 14.5, 14.6, 14.8).
//
// Every test drives the real Shell, the real Home (headline and inline panel), the real QuickAddProvider, the mutation
// runner, the memory client, and the measurement client against the transport-free FakeQuickAddBackend. Spies sit on
// the places an entry value could leak to:
//
// - `fetch` (every URL), XMLHttpRequest, sendBeacon, WebSocket, and EventSource, and the DOM's own links and sources,
// - `localStorage` and `sessionStorage` writes and contents, `document.cookie` writes, `history` and the address,
//   and every `console` method,
// - the request log of the fake backend (one expense write per entry, memory writes per command, hints per page load),
// - the measurement client's event payloads, with analytics on and off.
//
// One flow covers a plain save, a category change on a saved row, a save with a category chosen in the preview, an
// Undo that restores memory, and a failed save with a same-key Retry. The entries use distinctive amounts and notes in
// Latin and Devanagari so a search of every spy can name a leak.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FinancialSnapshot } from '../../clarity/contracts';
import { DataUseGateProvider, PROMISE_RENDERED_KEY } from '../../clarity/DataUseGateProvider';
import { FinancialClarityProvider } from '../../clarity/FinancialClarityProvider';
import {
  MEASUREMENT_EVENT_NAMES,
  MEASUREMENT_EVENTS_PATH,
  VISIT_TRACK_PATH,
  measurement,
} from '../../clarity/measurement';
import { MutationStatusProvider } from '../../clarity/MutationStatusProvider';
import { BUILT_IN_CATEGORIES } from '../../clarity/quickAdd/keywordRules';
import { KOLKATA_REEVALUATE_MS, resetServerTimeOffset } from '../../clarity/quickAdd/kolkata';
import { QuickAddProvider } from '../../clarity/quickAdd/QuickAddProvider';
import { createQuickAddStore, type QuickAddStore } from '../../clarity/quickAdd/quickAddStore';
import { Dashboard } from '../../pages/Dashboard';
import { buildSettings } from '../../test/claritySettingsBuilder';
import { FakeQuickAddBackend } from '../../test/fakeQuickAddBackend';
import type { SpendingBackendReply, SpendingBackendRequest } from '../../test/fakeSpendingBackend';
import { installSpendingFetch, type SpendingFetch, type SpendingRecordedCall } from '../../test/fakeSpendingFetch';
import { resetSharedMemoryClient } from '../../test/settingsMemoryServer';
import { createTestQueryClient, createTestUser, renderAuthenticated } from '../../test/test-utils';
import { Shell } from '../Shell';
import { QUICK_ADD_DIALOG_TITLE } from './QuickAddDialog';
import { FAB_HEIGHT_PROPERTY, FAB_LABEL } from './QuickAddFab';
import { QUICK_ADD_LABEL } from './QuickAddInput';
import { UNDONE_TEXT } from './QuickAddEntries';

// Each test drives a whole multi-entry flow through the real application, which takes longer on a busy machine.
vi.setConfig({ testTimeout: 40_000 });
configure({ asyncUtilTimeout: 10_000 });

const MONTH = '2026-11';
const TODAY = '2026-11-18';
const NOW = Date.parse('2026-11-18T06:30:00.000Z');
const EXPENSES = '/finance/expenses';
const MEMORY = '/finance/category-memory';
const HINTS = '/finance/quick-add/hints';
const API_PREFIX = `${((import.meta.env.VITE_API_BASE as string | undefined) ?? '').replace(/\/+$/, '')}/api/`;
const SRC = join(process.cwd(), 'src');

// Entry values the searches look for. Each is distinctive enough not to occur in static application text.
const SECRETS = ['7777', '8888', 'zebra', 'latte', 'quokka', 'मसाला', 'चाय'];

/* --------------------------------- harness ---------------------------------- */

/** The Quick Add fake with the settings the Shell's data-use gate reads and the category list. */
class PrivacyBackend extends FakeQuickAddBackend {
  analyticsEnabled = false;
  override snapshot(month: string = this.month): FinancialSnapshot {
    return super.snapshot(month);
  }
  override handle(request: SpendingBackendRequest): SpendingBackendReply {
    const get = request.method.toUpperCase() === 'GET';
    if (get && request.path === '/finance/categories') {
      return { status: 200, body: { defaults: [...BUILT_IN_CATEGORIES], custom: [] } };
    }
    if (get && request.path === '/clarity/settings') {
      return { status: 200, body: buildSettings({ acknowledgedVersion: 1, analyticsEnabled: this.analyticsEnabled }) };
    }
    return super.handle(request);
  }
}

function matchesWidth(query: string, width: number): boolean {
  const min = /\(min-width:\s*(\d+(?:\.\d+)?)px\)/.exec(query);
  const max = /\(max-width:\s*(\d+(?:\.\d+)?)px\)/.exec(query);
  if (!min && !max) return false;
  return (!min || width >= Number(min[1])) && (!max || width <= Number(max[1]));
}

function installViewport(width: number) {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true });
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() { return matchesWidth(query, width); },
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

interface Harness {
  user: ReturnType<typeof userEvent.setup>;
  backend: PrivacyBackend;
  net: SpendingFetch;
  store: QuickAddStore;
  container: HTMLElement;
}
interface MountOptions {
  route?: '/' | '/spending';
  /** 1440 CSS pixels (inline panel on Home) or 390 (floating action and dialog). */
  width?: number;
  analytics?: boolean;
  /** Fake timers that follow real time, so a test can also move the clock by minutes. */
  fakeTimers?: boolean;
}

function HomeLinks() {
  return <Link to="/spending">Go to spending</Link>;
}
function SpendingPage() {
  return (
    <>
      <h1>Spending page</h1>
      <Link to="/">Go to home</Link>
    </>
  );
}

function mount(options: MountOptions = {}): Harness {
  vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'true');
  vi.stubEnv('VITE_QUICK_ADD_ENABLED', 'true');
  sessionStorage.setItem(PROMISE_RENDERED_KEY, '4242');
  installViewport(options.width ?? 1440);
  Object.defineProperty(window.navigator, 'platform', { value: 'Win32', configurable: true });
  const backend = new PrivacyBackend(MONTH, { categories: [...BUILT_IN_CATEGORIES] });
  backend.todayDate = TODAY;
  backend.analyticsEnabled = options.analytics ?? false;
  const net = installSpendingFetch(backend);
  const store = createQuickAddStore();
  const view = renderAuthenticated(
    <FinancialClarityProvider>
      <MutationStatusProvider>
        <QuickAddProvider store={store}>
          <Routes>
            <Route element={<DataUseGateProvider><Shell /></DataUseGateProvider>}>
              <Route path="/" element={<><HomeLinks /><Dashboard /></>} />
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
  measurement.setAnalyticsConsent(false);
  resetSharedMemoryClient();
  resetServerTimeOffset();
  delete (window.navigator as unknown as Record<string, unknown>).platform;
  delete (window.navigator as unknown as Record<string, unknown>).sendBeacon;
  delete (document as unknown as Record<string, unknown>).cookie;
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.style.removeProperty(FAB_HEIGHT_PROPERTY);
  document.documentElement.style.removeProperty('--bottom-nav-h');
});

const input = () => screen.getByLabelText(QUICK_ADD_LABEL) as HTMLInputElement;
const rows = () => [...document.querySelectorAll<HTMLElement>('li.qa-entry')];
const answer = () => document.querySelector('.qa-answer')?.textContent ?? '';
const headline = () => screen.getByTestId('today-headline');
const categoryChoice = () => screen.getByLabelText('Category', { selector: '.qa-preview select' }) as HTMLSelectElement;
const waitForPhase = (h: Harness, phase: string) => waitFor(() => expect(h.store.getState().entries.at(-1)?.phase).toBe(phase));

/** Home is up: the headline has its value, the data-use gate has read its settings, and the hints were read. */
async function homeReady(h: Harness) {
  await screen.findByRole('article', { name: /Remaining to spend/ });
  await within(headline()).findByText(/You can spend/);
  await waitFor(() => expect(h.net.to('GET', '/clarity/settings').length).toBeGreaterThan(0));
  await waitFor(() => expect(h.net.to('GET', HINTS).length).toBeGreaterThan(0));
  if (h.backend.analyticsEnabled) await waitFor(() => expect(measurement.getAnalyticsConsent()).toBe(true));
}

const isExpenseWrite = (call: SpendingRecordedCall) => call.method !== 'GET' && call.path.startsWith(EXPENSES);
const isMemoryWrite = (call: SpendingRecordedCall) => call.method !== 'GET' && call.path.startsWith(MEMORY);
const count = (h: Harness, predicate: (call: SpendingRecordedCall) => boolean) => h.net.calls.filter(predicate).length;

interface StepRecord {
  name: string;
  expenseWrites: number;
  memoryWrites: number;
  /** The Idempotency-Keys of the expense writes this step sent. */
  keys: string[];
}

interface FlowResult {
  steps: StepRecord[];
  /** Text of the answer and of the headline after each step, for comparing two runs. */
  observed: string[];
}

/**
 * The flow of the file. The first entry is saved as suggested and then recategorized from its row, the second takes a
 * category chosen in the preview and is undone, and the third fails once and is retried with the same key.
 */
async function runFlow(h: Harness): Promise<FlowResult> {
  const steps: StepRecord[] = [];
  const observed: string[] = [];
  const mark = () => ({ expense: h.net.calls.filter(isExpenseWrite).length, memory: h.net.calls.filter(isMemoryWrite).length });
  async function step(name: string, action: () => Promise<void>) {
    const before = mark();
    const callsBefore = h.net.calls.length;
    await action();
    const sent = h.net.calls.slice(callsBefore);
    steps.push({
      name,
      expenseWrites: mark().expense - before.expense,
      memoryWrites: mark().memory - before.memory,
      keys: sent.filter(isExpenseWrite).map((call) => call.headers['idempotency-key'] ?? ''),
    });
    observed.push(`${name} | ${answer()} | ${headline().textContent ?? ''}`);
  }

  await step('save a plain entry', async () => {
    await h.user.type(input(), '7777 zebra latte{Enter}');
    await waitForPhase(h, 'saved');
  });
  await step('change the category of the saved row', async () => {
    await h.user.selectOptions(within(rows()[0] as HTMLElement).getByLabelText('Category'), 'Transport');
    await waitFor(() => expect(h.backend.expenses[0]?.category).toBe('Transport'));
    await waitFor(() => expect(h.backend.memoryFor('zebra latte')?.category).toBe('Transport'));
  });
  await step('save with a category chosen in the preview', async () => {
    await h.user.type(input(), '8888 quokka tea');
    await h.user.selectOptions(categoryChoice(), 'Transport');
    await h.user.click(input());
    await h.user.keyboard('{Enter}');
    await waitForPhase(h, 'saved');
    await waitFor(() => expect(h.backend.memoryFor('quokka tea')?.category).toBe('Transport'));
  });
  await step('undo that entry', async () => {
    await h.user.click(screen.getByRole('button', { name: 'Undo ₹8,888 quokka tea' }));
    await waitForPhase(h, 'undone');
    // The compensation for the memory the entry wrote runs after the expense is removed.
    await waitFor(() => expect(h.backend.memoryFor('quokka tea')).toBeUndefined());
  });
  h.backend.failWith('POST', EXPENSES, { status: 500, code: 'INTERNAL_ERROR' });
  await step('save an entry that fails', async () => {
    await h.user.type(input(), '55 मसाला चाय{Enter}');
    await waitForPhase(h, 'failed');
  });
  await step('retry the failed entry', async () => {
    await h.user.click(within(rows()[0] as HTMLElement).getByRole('button', { name: /^Retry saving/ }));
    await waitForPhase(h, 'saved');
  });
  return { steps, observed };
}

/* ------------------------------- the spies ---------------------------------- */

interface Spies {
  consoleCalls: unknown[][];
  storageWrites: Array<[string, string]>;
  cookieWrites: string[];
  historyCalls: unknown[][];
  xhrOpens: number;
  beacons: number;
  sockets: number;
  readonly fetchUrls: string[];
}

function installSpies(): Spies {
  const spies: Spies = {
    consoleCalls: [],
    storageWrites: [],
    cookieWrites: [],
    historyCalls: [],
    xhrOpens: 0,
    beacons: 0,
    sockets: 0,
    get fetchUrls() {
      return vi.mocked(globalThis.fetch).mock.calls.map(([target]) => {
        if (typeof target === 'string') return target;
        if (target instanceof URL) return target.href;
        return (target as Request).url;
      });
    },
  };
  for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'table', 'group', 'groupCollapsed', 'assert'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { spies.consoleCalls.push(args); });
  }
  const setItem = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function setItemSpy(this: Storage, key: string, value: string) {
    spies.storageWrites.push([key, value]);
    setItem.call(this, key, value);
  });
  const cookie = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
  Object.defineProperty(document, 'cookie', {
    configurable: true,
    get: () => cookie?.get?.call(document) as string,
    set: (value: string) => {
      spies.cookieWrites.push(value);
      cookie?.set?.call(document, value);
    },
  });
  for (const method of ['pushState', 'replaceState', 'go', 'back', 'forward'] as const) {
    vi.spyOn(window.history, method).mockImplementation((...args: unknown[]) => { spies.historyCalls.push([method, ...args]); });
  }
  vi.spyOn(XMLHttpRequest.prototype, 'open').mockImplementation(() => { spies.xhrOpens += 1; });
  Object.defineProperty(window.navigator, 'sendBeacon', {
    configurable: true,
    value: () => { spies.beacons += 1; return true; },
  });
  vi.stubGlobal('WebSocket', function WebSocketSpy() { spies.sockets += 1; });
  vi.stubGlobal('EventSource', function EventSourceSpy() { spies.sockets += 1; });
  return spies;
}

/** Everything a spy saw, as one string for searching. */
function outsideText(spies: Spies, h: Harness): string {
  const printable = (arg: unknown) => (arg instanceof Error ? arg.message : typeof arg === 'string' ? arg : JSON.stringify(arg) ?? String(arg));
  return JSON.stringify({
    console: spies.consoleCalls.map((args) => args.map(printable)),
    storageWrites: spies.storageWrites,
    local: { ...localStorage },
    session: { ...sessionStorage },
    cookieWrites: spies.cookieWrites,
    cookie: document.cookie,
    href: window.location.href,
    historyCalls: spies.historyCalls,
    title: document.title,
    urls: spies.fetchUrls,
    queries: h.net.calls.map((call) => call.query.toString()),
  });
}

/* ------------------------------ network and requests ------------------------- */

describe('the browser talks only to the API base (Requirements 14.1, 14.2)', () => {
  it('sends every request to the API base and opens no other channel, link, or source', async () => {
    const spies = installSpies();
    const h = mount({ analytics: true });
    await homeReady(h);
    await runFlow(h);
    await waitFor(() => expect(h.net.events.length).toBeGreaterThan(0));

    const urls = spies.fetchUrls;
    expect(urls.length).toBeGreaterThan(10);
    for (const url of urls) {
      expect(url.startsWith(API_PREFIX), url).toBe(true);
      // The address is relative or on the same origin as the page: no third-party host and no AI service.
      expect(new URL(url, window.location.href).origin, url).toBe(window.location.origin);
    }
    // Quick Add's own requests go to the expense and memory routes of that base and nowhere else.
    const quickAddPaths = new Set(h.net.calls.filter((call) => call.path.startsWith(EXPENSES) || call.path.startsWith(MEMORY) || call.path === HINTS).map((call) => call.path.replace(/\/\d+$/, '/:id')));
    expect([...quickAddPaths].sort()).toEqual([`${EXPENSES}`, `${EXPENSES}/:id`, MEMORY, `${MEMORY}/:id`, HINTS].sort());
    expect(spies.xhrOpens).toBe(0);
    expect(spies.beacons).toBe(0);
    expect(spies.sockets).toBe(0);
    for (const element of document.querySelectorAll('[src], [href], [action], [data]')) {
      for (const name of ['src', 'href', 'action', 'data']) {
        const value = element.getAttribute(name);
        if (!value || value.startsWith('#')) continue;
        expect(new URL(value, window.location.href).origin, `${element.tagName} ${name}=${value}`).toBe(window.location.origin);
      }
    }
  });

  it('keeps every network call out of the Quick Add source and routes them through the shared API helper', () => {
    const files = [...sourceFiles(join(SRC, 'clarity/quickAdd')), ...sourceFiles(join(SRC, 'components/quickAdd'))];
    expect(files.length).toBeGreaterThan(30);
    for (const file of files) {
      const text = stripComments(readFileSync(file, 'utf8'));
      expect(text, file).not.toMatch(/\bfetch\s*\(/);
      expect(text, file).not.toMatch(/XMLHttpRequest|sendBeacon|new WebSocket|new EventSource/);
      expect(text, file).not.toMatch(/https?:\/\//);
    }
  });
});

describe('one write per entry and no polling (Requirements 7.20, 13.7)', () => {
  it('sends one expense write per entry and at most one memory write per command', async () => {
    const h = mount();
    await homeReady(h);
    const { steps } = await runFlow(h);
    const byName = Object.fromEntries(steps.map((entry) => [entry.name, entry]));

    // A plain save: one expense write, and no memory write because the suggestion was kept.
    expect(byName['save a plain entry']).toMatchObject({ expenseWrites: 1, memoryWrites: 0 });
    // Correcting the saved row: one expense update and one memory write.
    expect(byName['change the category of the saved row']).toMatchObject({ expenseWrites: 1, memoryWrites: 1 });
    // A category chosen in the preview: one expense create and one memory write.
    expect(byName['save with a category chosen in the preview']).toMatchObject({ expenseWrites: 1, memoryWrites: 1 });
    // Undo: one delete of the expense and one compensating memory write.
    expect(byName['undo that entry']).toMatchObject({ expenseWrites: 1, memoryWrites: 1 });
    // A failed save sends its one request; Retry sends the same request once more, with the same key.
    expect(byName['save an entry that fails']).toMatchObject({ expenseWrites: 1, memoryWrites: 0 });
    expect(byName['retry the failed entry']).toMatchObject({ expenseWrites: 1, memoryWrites: 0 });
    expect(byName['retry the failed entry']?.keys).toEqual(byName['save an entry that fails']?.keys);

    // Each entry's create went out under its own key, and each key was used for one command only (except the Retry).
    const createKeys = h.net.to('POST', EXPENSES).map((call) => call.headers['idempotency-key']);
    expect(createKeys).toHaveLength(4);
    expect(new Set(createKeys).size).toBe(3);
    const expenseKeys = h.net.calls.filter(isExpenseWrite).map((call) => call.headers['idempotency-key']);
    expect(new Set(expenseKeys).size).toBe(expenseKeys.length - 1);
    // Memory writes per note: the remembered choice for each note and nothing else.
    const memoryBodies = h.net.to('PUT', MEMORY).map((call) => (call.body as { noteKey: string }).noteKey);
    expect(memoryBodies.filter((noteKey) => noteKey === 'zebra latte')).toHaveLength(1);
    expect(memoryBodies.filter((noteKey) => noteKey === 'quokka tea')).toHaveLength(1);
    expect(h.net.to('PUT', MEMORY).length + h.net.to('DELETE', MEMORY).length + h.net.calls.filter((call) => call.method === 'DELETE' && call.path.startsWith(`${MEMORY}/`)).length).toBeLessThanOrEqual(4);
    expect(h.backend.expenses.map((expense) => expense.amountMinor).sort()).toEqual([5500, 777700]);
  });

  it('sends nothing while typing, and one request when an invalid line is submitted is none at all', async () => {
    const h = mount();
    await homeReady(h);
    const before = h.net.calls.length;
    await h.user.type(input(), '7777 zebra latte, 8888 quokka');
    expect(h.net.calls.length).toBe(before);
    await h.user.clear(input());
    await h.user.type(input(), 'zebra latte{Enter}');
    expect(h.net.calls.length).toBe(before);
    expect(count(h, isExpenseWrite)).toBe(0);
    expect(count(h, isMemoryWrite)).toBe(0);
  });

  it('reads the hints once per page load, through saves, memory changes, Undo, the dialog, and route changes', async () => {
    const h = mount({ width: 390 });
    await homeReady(h);
    await h.user.type(input(), '7777 zebra latte{Enter}');
    await waitForPhase(h, 'saved');
    await h.user.selectOptions(within(rows()[0] as HTMLElement).getByLabelText('Category'), 'Transport');
    await waitFor(() => expect(h.backend.memoryFor('zebra latte')?.category).toBe('Transport'));
    await h.user.click(screen.getByRole('button', { name: 'Undo ₹7,777 zebra latte' }));
    await waitForPhase(h, 'undone');
    expect(rows()[0]).toHaveTextContent(UNDONE_TEXT);

    // Leave Home, open the dialog from another page, close and open it again, then come back.
    await h.user.click(screen.getByRole('link', { name: 'Go to spending' }));
    await screen.findByRole('heading', { name: 'Spending page' });
    await h.user.click(screen.getByRole('button', { name: FAB_LABEL }));
    await screen.findByRole('dialog', { name: QUICK_ADD_DIALOG_TITLE });
    await h.user.type(input(), '120 coffee{Enter}');
    await waitForPhase(h, 'saved');
    await h.user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: QUICK_ADD_DIALOG_TITLE })).toBeNull());
    await h.user.click(screen.getByRole('button', { name: FAB_LABEL }));
    await screen.findByRole('dialog', { name: QUICK_ADD_DIALOG_TITLE });
    await h.user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: QUICK_ADD_DIALOG_TITLE })).toBeNull());
    await h.user.click(screen.getByRole('link', { name: 'Go to home' }));
    await screen.findByRole('article', { name: /Remaining to spend/ });
    await h.user.type(input(), '30 tea{Enter}');
    await waitFor(() => expect(h.store.getState().entries).toHaveLength(3));
    await waitForPhase(h, 'saved');

    expect(h.net.to('GET', HINTS)).toHaveLength(1);
  });

  it('never polls: with the clock moved on by minutes and the Undo window over, no request is sent', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 10, now: NOW });
    const h = mount();
    h.user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    await homeReady(h);
    await h.user.type(input(), '7777 zebra latte{Enter}');
    await waitForPhase(h, 'saved');
    await waitFor(() => expect(answer()).not.toBe(''));
    const settledEvents = h.net.events.length;
    const minutes = async (count: number) => {
      for (let minute = 0; minute < count; minute += 1) {
        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      }
    };

    // The Undo window (8 seconds) and the Asia/Kolkata re-check (every 30 seconds) both run inside this time. The
    // save's own follow-up reads (the streak card) settle in the first window.
    expect(KOLKATA_REEVALUATE_MS).toBeLessThanOrEqual(30_000);
    await minutes(2);
    await waitFor(() => expect(h.store.getState().entries[0]?.undo).toBeUndefined());
    const settled = h.net.calls.length;
    await minutes(5);

    // Nothing of Quick Add, the clarity snapshot, or the expense list is read or written again. The Shell's own
    // once-a-minute reads of invitations and the announcement are older than this feature and are the only calls.
    const later = h.net.calls.slice(settled).map((call) => `${call.method} ${call.path}`);
    expect(later.filter((call) => !['GET /invites', 'GET /public/announcement'].includes(call))).toEqual([]);
    expect(h.net.calls.filter((call) => call.path.startsWith('/finance/quick-add') || call.path.startsWith(MEMORY))).toHaveLength(1);
    expect(h.net.to('POST', EXPENSES)).toHaveLength(1);
    expect(h.net.events.length).toBe(settledEvents);
    expect(h.backend.expenses).toHaveLength(1);
  });

  it('declares no polling in the Quick Add sources', () => {
    const files = [...sourceFiles(join(SRC, 'clarity/quickAdd')), ...sourceFiles(join(SRC, 'components/quickAdd'))];
    const intervals: string[] = [];
    for (const file of files) {
      const text = stripComments(readFileSync(file, 'utf8'));
      expect(text, file).not.toMatch(/refetchInterval|refetchIntervalInBackground/);
      if (/\bsetInterval\b/.test(text)) intervals.push(file.slice(SRC.length + 1));
    }
    // The only intervals tick a clock that is shown or compared locally: the Undo countdown and the Kolkata day.
    expect(intervals.sort()).toEqual(['clarity/quickAdd/kolkata.ts', 'components/quickAdd/UndoControl.tsx']);
    for (const file of ['clarity/quickAdd/kolkata.ts', 'components/quickAdd/UndoControl.tsx']) {
      const text = stripComments(readFileSync(join(SRC, file), 'utf8'));
      expect(text, file).not.toMatch(/\bfetch\b|\bapi\(|apiRequest|invalidateQueries|refetch/);
    }
  });
});

/* --------------------------------- privacy ---------------------------------- */

describe('no entry value outside the page (Requirements 7.18, 14.3)', () => {
  it('keeps the typed line, amounts, notes, categories, and Note_Keys out of storage, cookies, the address, and the console', async () => {
    const spies = installSpies();
    const h = mount();
    const addressBefore = window.location.href;
    const historyLengthBefore = window.history.length;
    const historyStateBefore = window.history.state as unknown;
    await homeReady(h);
    await runFlow(h);

    const outside = outsideText(spies, h);
    for (const secret of SECRETS) expect(outside, secret).not.toContain(secret);
    expect(outside).not.toMatch(/zebra latte|quokka tea|मसाला चाय/);
    // Nothing from Quick Add was written to the browser at all: category and Note_Key included.
    for (const [key, value] of spies.storageWrites) {
      expect(`${key}=${value}`).not.toMatch(/quick|memory|hint|zebra|quokka|Transport/i);
    }
    expect(spies.cookieWrites).toEqual([]);
    expect(document.cookie).toBe('');
    // The address, its query and hash, and the history are exactly as they were.
    expect(window.location.href).toBe(addressBefore);
    expect(window.location.search).toBe('');
    expect(window.location.hash).toBe('');
    expect(window.history.length).toBe(historyLengthBefore);
    expect(window.history.state).toEqual(historyStateBefore);
    expect(spies.historyCalls).toEqual([]);
    // No console output at all during the flow, including the failed save and its Retry.
    expect(spies.consoleCalls).toEqual([]);
    // The values do reach the server where they belong: the body of the expense write.
    expect(h.net.to('POST', EXPENSES)[0]?.body).toMatchObject({ amountMinor: 777700, note: 'zebra latte' });
  });

  it('keeps entry values out of the browser through a sign-out of the session state', async () => {
    const spies = installSpies();
    const h = mount();
    await homeReady(h);
    await h.user.type(input(), '7777 zebra latte{Enter}');
    await waitForPhase(h, 'saved');
    await h.user.type(input(), '8888 quokka tea');
    expect(input()).toHaveValue('8888 quokka tea');
    // The draft, the entry, and the memory copy live only in memory. Unmounting the page drops them all.
    cleanup();
    resetSharedMemoryClient();
    const outside = outsideText(spies, h);
    for (const secret of SECRETS) expect(outside, secret).not.toContain(secret);
    expect(localStorage.length === 0 || !JSON.stringify({ ...localStorage }).includes('zebra')).toBe(true);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain('quokka');
    expect(spies.consoleCalls).toEqual([]);
  });
});

/* ------------------------------- measurement -------------------------------- */

/** Reads the production sources of Quick Add for the measurement client's methods they call. */
function measurementCallsIn(files: string[]): Set<string> {
  const called = new Set<string>();
  for (const file of files) {
    const text = stripComments(readFileSync(file, 'utf8'));
    for (const match of text.matchAll(/\bmeasurement\.(\w+)/g)) called.add(match[1] ?? '');
  }
  return called;
}

describe('Product Analytics (Requirements 13.8, 14.5, 14.6, 14.8)', () => {
  it('introduces no event name and reaches the measurement client only through financialChangeUi', () => {
    // The names the client and the server accept are the five that existed before Quick Add.
    expect([...MEASUREMENT_EVENT_NAMES]).toEqual([
      'journey_started',
      'first_outcome_displayed',
      'clarity_response',
      'recommended_action_completed',
      'financial_change_ui',
    ]);
    const files = [...sourceFiles(join(SRC, 'clarity/quickAdd')), ...sourceFiles(join(SRC, 'components/quickAdd'))];
    expect([...measurementCallsIn(files)]).toEqual(['financialChangeUi']);
    for (const file of files) {
      const text = stripComments(readFileSync(file, 'utf8'));
      expect(text, file).not.toMatch(/journeyStarted|firstOutcomeDisplayed|clarityResponse|recommendedActionCompleted|trackVisit/);
      expect(text, file).not.toContain(MEASUREMENT_EVENTS_PATH);
      expect(text, file).not.toContain(VISIT_TRACK_PATH);
      expect(text, file).not.toMatch(/buildEventPayload|createMeasurementClient/);
    }
  });

  it('with analytics on, reports each confirmed save, category change, and Undo as the one value-free event', async () => {
    const h = mount({ analytics: true });
    await homeReady(h);
    await h.user.type(input(), '7777 zebra latte{Enter}');
    await waitForPhase(h, 'saved');
    await waitFor(() => expect(h.net.events).toHaveLength(1));
    await h.user.selectOptions(within(rows()[0] as HTMLElement).getByLabelText('Category'), 'Transport');
    await waitFor(() => expect(h.net.events).toHaveLength(2));
    await h.user.click(screen.getByRole('button', { name: 'Undo ₹7,777 zebra latte' }));
    await waitFor(() => expect(h.net.events).toHaveLength(3));
    await waitFor(() => expect(measurement.queuedCount()).toBe(0));

    for (const event of h.net.events) {
      expect(Object.keys(event).sort()).toEqual(['causedPageWideLoading', 'causedReload', 'changeId', 'event', 'occurredAt']);
      expect(event).toEqual({
        event: 'financial_change_ui',
        changeId: expect.any(Number),
        causedReload: false,
        causedPageWideLoading: false,
        occurredAt: expect.any(String),
      });
    }
    expect(new Set(h.net.events.map((event) => event.changeId)).size).toBe(3);
    // The memory write and the hints read are not reported, and no value is in any event.
    const sent = JSON.stringify(h.net.events).replace(/"occurredAt":"[^"]+"/g, '');
    for (const secret of [...SECRETS, 'Transport', 'Food', '777700', 'amount', 'note']) expect(sent, secret).not.toContain(secret);
    expect(vi.mocked(globalThis.fetch).mock.calls.filter(([target]) => String(target).endsWith(VISIT_TRACK_PATH))).toHaveLength(0);
  });

  it('with analytics off, sends no event or beacon and gives the same saves, answers, and headline', async () => {
    const on = mount({ analytics: true });
    await homeReady(on);
    const withAnalytics = await runFlow(on);
    await waitFor(() => expect(on.net.events.length).toBeGreaterThanOrEqual(5));
    const writesOn = on.net.calls.filter((call) => isExpenseWrite(call) || isMemoryWrite(call)).map(shapeOf);
    const expensesOn = on.backend.expenses.map(({ amountMinor, category, note, spentOn }) => ({ amountMinor, category, note, spentOn }));
    cleanup();
    resetSharedMemoryClient();
    resetServerTimeOffset();
    measurement.setAnalyticsConsent(false);
    vi.mocked(globalThis.fetch).mockReset();

    const off = mount({ analytics: false });
    await homeReady(off);
    const withoutAnalytics = await runFlow(off);
    expect(measurement.getAnalyticsConsent()).toBe(false);
    expect(off.net.events).toEqual([]);
    const reported = vi.mocked(globalThis.fetch).mock.calls.map(([target]) => String(target));
    expect(reported.filter((url) => url.endsWith(MEASUREMENT_EVENTS_PATH) || url.endsWith(VISIT_TRACK_PATH))).toEqual([]);

    // The same requests, saves, answers, and headline text at every step.
    expect(withoutAnalytics.observed).toEqual(withAnalytics.observed);
    expect(withoutAnalytics.steps.map(({ name, expenseWrites, memoryWrites }) => ({ name, expenseWrites, memoryWrites })))
      .toEqual(withAnalytics.steps.map(({ name, expenseWrites, memoryWrites }) => ({ name, expenseWrites, memoryWrites })));
    expect(off.net.calls.filter((call) => isExpenseWrite(call) || isMemoryWrite(call)).map(shapeOf)).toEqual(writesOn);
    expect(off.backend.expenses.map(({ amountMinor, category, note, spentOn }) => ({ amountMinor, category, note, spentOn }))).toEqual(expensesOn);
    expect(withoutAnalytics.observed.some((line) => line.includes('You can spend'))).toBe(true);
  });

  it('keeps the reload and page-wide-loading measurements at zero for every Quick Add command', async () => {
    const spies = installSpies();
    const h = mount({ analytics: true });
    await homeReady(h);
    // The page nodes the flow must leave alone, and a watch for any busy state outside an entry row.
    const main = document.querySelector('main');
    const region = document.querySelector('[data-region="today"]');
    const panel = input().closest('.home-quick-add');
    const busy: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        const nodes = record.type === 'attributes' ? [record.target] : [...record.addedNodes];
        for (const node of nodes) {
          if (!(node instanceof Element)) continue;
          for (const el of [node, ...node.querySelectorAll('[aria-busy="true"]')]) {
            if (el.getAttribute('aria-busy') === 'true' && !el.closest('li.qa-entry')) busy.push(`${el.tagName}.${el.className}`);
          }
        }
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-busy'] });

    await runFlow(h);
    await waitFor(() => expect(h.net.events.length).toBeGreaterThanOrEqual(5));
    observer.disconnect();

    // Every confirmed change says: no reload, no page-wide loading.
    for (const event of h.net.events) {
      expect(event).toMatchObject({ event: 'financial_change_ui', causedReload: false, causedPageWideLoading: false });
    }
    // And the page agrees: the same document, shell, headline region, and panel stayed in place.
    expect(document.querySelector('main')).toBe(main);
    expect(document.querySelector('[data-region="today"]')).toBe(region);
    expect(input().closest('.home-quick-add')).toBe(panel);
    expect(busy).toEqual([]);
    // The only alert is the announcer's own live region for the one failed save. No page-level alert appeared.
    expect(screen.queryAllByRole('alert').filter((node) => node.getAttribute('data-testid') !== 'quick-add-assertive')).toEqual([]);
    // No navigation of the document was attempted (jsdom reports one on the console).
    expect(spies.historyCalls).toEqual([]);
    expect(spies.consoleCalls).toEqual([]);
    expect(input()).toBeInTheDocument();
  });
});

/* --------------------------------- helpers ---------------------------------- */

function shapeOf(call: SpendingRecordedCall) {
  return { method: call.method, path: call.path.replace(/\d+/g, ':n'), body: call.body };
}

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(directory)) {
    const full = join(directory, name);
    if (statSync(full).isDirectory()) found.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) found.push(full);
  }
  return found;
}

/** Drops block and line comments, so a sentence about `fetch` or `setInterval` is not taken for a call. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

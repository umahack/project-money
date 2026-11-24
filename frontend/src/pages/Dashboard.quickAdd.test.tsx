// The clarity Home with Quick_Add_Enabled (task 14.2; Requirements 1.1, 9.7, 11.1, 11.11 to 11.15, 11.18, 11.19, 11.21,
// 13.1, 12.9):
//
// - the order: page decision header, the headline, the inline Quick Add input, the quick actions, the key numbers, the
//   rest,
// - the flags: with Quick_Add_Enabled off Home has no headline, no panel, and makes no Quick Add request,
// - an old server (no `todayAllowance`): the unavailable headline, and Quick Add still saves,
// - region isolation: a failed outcome and a failed read stay inside the headline, and the retry re-reads the snapshot,
// - the floating action and the shortcut focus the inline input on Home and open no dialog,
// - the headline updates in place after a Quick Add save, with no re-read and no page-wide loading,
// - a new Asia/Kolkata day re-reads the snapshot, and an entry for another month leaves the headline alone,
// - the order at 320, 390, 768, 1024, and 1440 CSS pixels, and the stylesheets that never reorder it (task 14.3),
// - every headline state inside Home, the unchanged Daily spending guide, and the midnight and month rollover re-read,
// - axe in the light and dark themes.
//
// The real Shell and the real Dashboard are rendered against the transport-free Quick Add fake, so the shell host, the
// inline panel, and the snapshot store work together as they do in the application.
import { readFileSync } from 'node:fs';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROMISE_RENDERED_KEY } from '../clarity/DataUseGateProvider';
import type { FinancialSnapshot, MoneyValue, TodayAllowanceOutcome, TodayAllowanceValue } from '../clarity/contracts';
import { FinancialClarityProvider } from '../clarity/FinancialClarityProvider';
import { MutationStatusProvider } from '../clarity/MutationStatusProvider';
import { PAGE_DECISIONS } from '../clarity/actionContext';
import { BUILT_IN_CATEGORIES } from '../clarity/quickAdd/keywordRules';
import { KOLKATA_REEVALUATE_MS, resetServerTimeOffset } from '../clarity/quickAdd/kolkata';
import { QuickAddProvider } from '../clarity/quickAdd/QuickAddProvider';
import { createQuickAddStore, type QuickAddStore } from '../clarity/quickAdd/quickAddStore';
import { FAB_HEIGHT_PROPERTY, FAB_LABEL } from '../components/quickAdd/QuickAddFab';
import { QUICK_ADD_DIALOG_TITLE } from '../components/quickAdd/QuickAddDialog';
import { SAVE_WITHOUT_COUNTING_LABEL } from '../components/quickAdd/EntryWarning';
import { QUICK_ADD_LABEL } from '../components/quickAdd/QuickAddInput';
import { Shell } from '../components/Shell';
import { buildSettings } from '../test/claritySettingsBuilder';
import { FakeQuickAddBackend } from '../test/fakeQuickAddBackend';
import type { SpendingBackendReply, SpendingBackendRequest } from '../test/fakeSpendingBackend';
import { installSpendingFetch, type SpendingFetch } from '../test/fakeSpendingFetch';
import { resetSharedMemoryClient } from '../test/settingsMemoryServer';
import { monthLabel } from '../money';
import { axe, createTestQueryClient, createTestUser, renderAuthenticated } from '../test/test-utils';
import { Dashboard } from './Dashboard';

const MONTH = '2026-11';
const TODAY = '2026-11-18';
const TOMORROW = '2026-11-19';
const NOW = Date.parse('2026-11-18T06:30:00.000Z');
const HEADLINE_TITLE = "Today's allowance";
const QUICK_ADD_PATH = /category-memory|\/finance\/categories|\/finance\/expenses|quick-add\/hints/;

/** The Quick Add fake with the settings the Shell's data-use gate reads, the category list, and an optional outcome change. */
class HomeBackend extends FakeQuickAddBackend {
  /** Replaces the `todayAllowance` outcome of every snapshot. */
  alterToday?: (outcome: TodayAllowanceOutcome) => TodayAllowanceOutcome;
  override snapshot(month: string = this.month): FinancialSnapshot {
    const snapshot = super.snapshot(month);
    const outcome = snapshot.outcomes.todayAllowance;
    if (!outcome || !this.alterToday) return snapshot;
    return { ...snapshot, outcomes: { ...snapshot.outcomes, todayAllowance: this.alterToday(outcome) } };
  }
  override handle(request: SpendingBackendRequest): SpendingBackendReply {
    const get = request.method.toUpperCase() === 'GET';
    if (get && request.path === '/finance/categories') {
      return { status: 200, body: { defaults: [...BUILT_IN_CATEGORIES], custom: [] } };
    }
    if (get && request.path === '/clarity/settings') return { status: 200, body: buildSettings({ acknowledgedVersion: 1 }) };
    return super.handle(request);
  }
}

/** Whether a `(min-width: Npx)` or `(max-width: Npx)` media query matches a viewport that is `width` CSS pixels wide. */
function matchesWidth(query: string, width: number): boolean {
  const min = /\(min-width:\s*(\d+(?:\.\d+)?)px\)/.exec(query);
  const max = /\(max-width:\s*(\d+(?:\.\d+)?)px\)/.exec(query);
  if (!min && !max) return false;
  return (!min || width >= Number(min[1])) && (!max || width <= Number(max[1]));
}

const ORIGINAL_INNER_WIDTH = window.innerWidth;

/** A viewport the test can resize: `window.innerWidth` and every width media query answer from `width`. */
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
  backend: HomeBackend;
  net: SpendingFetch;
  store: QuickAddStore;
  container: HTMLElement;
}
interface MountOptions {
  /** Both flags on (the default), or the Rollout_Flag on with Quick Add off. */
  quickAdd?: boolean;
  /** 1440 CSS pixels (the default) or, when false, 390. `width` takes precedence. */
  wide?: boolean;
  /** The viewport width in CSS pixels. */
  width?: number;
  today?: string | null;
  prepare?(backend: HomeBackend, net: SpendingFetch): void;
}

function mount(options: MountOptions = {}): Harness {
  const quickAdd = options.quickAdd ?? true;
  vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'true');
  vi.stubEnv('VITE_QUICK_ADD_ENABLED', quickAdd ? 'true' : '');
  sessionStorage.setItem(PROMISE_RENDERED_KEY, '4242');
  installViewport(options.width ?? ((options.wide ?? true) ? 1440 : 390));
  const backend = new HomeBackend(MONTH, { categories: [...BUILT_IN_CATEGORIES] });
  backend.todayDate = options.today === undefined ? TODAY : options.today;
  const net = installSpendingFetch(backend);
  options.prepare?.(backend, net);
  const store = createQuickAddStore();
  const view = renderAuthenticated(
    <FinancialClarityProvider>
      <MutationStatusProvider>
        <QuickAddProvider store={store}>
          <Routes>
            <Route element={<Shell />}>
              <Route path="/" element={<Dashboard />} />
            </Route>
          </Routes>
        </QuickAddProvider>
      </MutationStatusProvider>
    </FinancialClarityProvider>,
    { route: '/', queryClient: createTestQueryClient(), user: createTestUser() },
  );
  return { user: userEvent.setup(), backend, net, store, container: view.container };
}

beforeEach(() => {
  vi.setSystemTime(NOW);
  Object.defineProperty(window.navigator, 'platform', { value: 'Win32', configurable: true });
});
afterEach(() => {
  resetSharedMemoryClient();
  resetServerTimeOffset();
  delete (window.navigator as unknown as Record<string, unknown>).platform;
  Object.defineProperty(window, 'innerWidth', { value: ORIGINAL_INNER_WIDTH, configurable: true, writable: true });
  delete (document as unknown as Record<string, unknown>).visibilityState;
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.style.removeProperty(FAB_HEIGHT_PROPERTY);
  document.documentElement.style.removeProperty('--bottom-nav-h');
});

const region = (name: string) => document.querySelector(`[data-region="${name}"]`) as HTMLElement | null;
const headline = () => screen.getByTestId('today-headline');
const unavailable = () => headline().querySelector('[data-state="unavailable"]') as HTMLElement | null;
const quickActions = () => screen.getByRole('navigation', { name: 'Quick actions' });
const input = () => screen.getByLabelText(QUICK_ADD_LABEL) as HTMLInputElement;
const clarityReads = (h: Harness) => h.net.to('GET', '/finance/clarity');
const quickAddRequests = (h: Harness) => h.net.calls.filter((call) => QUICK_ADD_PATH.test(call.path));
const comesBefore = (first: Element, second: Element) =>
  Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);

/** Home is up: the monthly summary is shown and, with Quick Add on, so is the headline's value. */
async function homeLoaded(h: Harness, options: { headlineValue?: boolean } = {}) {
  await screen.findByRole('article', { name: /Remaining to spend/ });
  if (options.headlineValue ?? true) await within(headline()).findByText(/You can spend/);
  await waitFor(() => expect(h.net.to('GET', '/clarity/settings').length).toBeGreaterThan(0));
}

describe('the order of Home with Quick Add on', () => {
  it('shows the decision header, the headline, the Quick Add input, the quick actions, the key numbers, then the rest', async () => {
    const h = mount();
    await homeLoaded(h);
    const header = h.container.querySelector('.clarity-decision-header') as HTMLElement;
    expect(within(header).getByText(PAGE_DECISIONS.home)).toBeInTheDocument();
    const sequence = [
      header,
      region('today') as HTMLElement,
      input(),
      quickActions(),
      region('monthly-plan') as HTMLElement,
      region('actions') as HTMLElement,
      screen.getByRole('heading', { name: 'Guided journey' }),
    ];
    for (const element of sequence) expect(element).toBeTruthy();
    for (let i = 0; i < sequence.length - 1; i += 1) {
      expect(comesBefore(sequence[i]!, sequence[i + 1]!), `item ${i} comes before item ${i + 1}`).toBe(true);
    }
    // The headline is the first financial outcome, and the input sits directly below it, above the tiles.
    const panel = input().closest('.home-quick-add') as HTMLElement;
    expect(panel).not.toBeNull();
    expect(headline().nextElementSibling).toBe(panel);
    expect(panel.nextElementSibling).toBe(quickActions());
    expect(header.nextElementSibling).toBe(headline());
  });

  it('shows the headline text, "left today", and keeps the unchanged Daily spending guide in the summary', async () => {
    const h = mount();
    await homeLoaded(h);
    expect(headline().querySelector('.today-headline-main')).toHaveTextContent('You can spend ₹3,000 today');
    expect(headline().querySelector('.today-headline-left')).toHaveTextContent('₹3,000 left today');
    const plan = screen.getByRole('article', { name: /Remaining to spend/ });
    expect(within(plan).getByText('Daily spending guide')).toBeInTheDocument();
  });

  it('keeps the input interactive before the snapshot loads', async () => {
    const h = mount({ prepare: (_backend, net) => { net.hold('GET', '/finance/clarity'); } });
    await screen.findByLabelText(QUICK_ADD_LABEL);
    await h.user.type(input(), '120 coffee');
    expect(input()).toHaveValue('120 coffee');
    // The headline is a size-stable placeholder inside its own region, and the quick actions stay.
    expect(region('today')).toHaveAttribute('aria-busy', 'true');
    expect(quickActions()).toBeInTheDocument();
  });
});

describe('the flags', () => {
  it('with Quick Add off, Home has no headline, no panel, no request, and the quick actions follow the header', async () => {
    const h = mount({ quickAdd: false });
    await homeLoaded(h, { headlineValue: false });
    expect(screen.queryByTestId('today-headline')).toBeNull();
    expect(region('today')).toBeNull();
    expect(screen.queryByLabelText(QUICK_ADD_LABEL)).toBeNull();
    expect(h.container.querySelector('.home-quick-add')).toBeNull();
    expect(document.querySelector('[class*="qa-panel"]')).toBeNull();
    expect(screen.queryByRole('button', { name: FAB_LABEL })).toBeNull();
    const header = h.container.querySelector('.clarity-decision-header') as HTMLElement;
    expect(header.nextElementSibling).toBe(quickActions());
    expect(quickActions().nextElementSibling).toBe(region('summary'));
    expect(quickAddRequests(h)).toEqual([]);
    // Nothing of the headline is read from the snapshot either.
    expect(screen.queryByText(/You can spend/)).toBeNull();
  });
});

describe('an old server without the todayAllowance outcome', () => {
  it('shows the unavailable headline, keeps every other region, and still saves a Quick Add entry', async () => {
    const h = mount({ today: null });
    await screen.findByRole('article', { name: /Remaining to spend/ });
    await waitFor(() => expect(unavailable()).not.toBeNull());
    expect(unavailable()).toHaveTextContent('Temporarily unavailable');
    expect(within(headline()).getByText(/You can still save expenses/)).toBeInTheDocument();
    expect(within(headline()).getByRole('button', { name: `Refresh ${HEADLINE_TITLE}` })).toBeInTheDocument();
    expect(screen.getByRole('article', { name: /Remaining to spend/ })).toBeInTheDocument();
    expect(quickActions()).toBeInTheDocument();
    await h.user.type(input(), '120 coffee{Enter}');
    await waitFor(() => expect(h.net.to('POST', '/finance/expenses')).toHaveLength(1));
    await waitFor(() => expect(h.store.getState().entries[0]?.phase).toBe('saved'));
    expect(h.backend.expenses).toHaveLength(1);
    // The unavailable state stays, and no region was replaced by page-wide loading.
    expect(unavailable()).not.toBeNull();
    expect(screen.queryByText(/Refreshing/)).toBeNull();
  });

  it('re-reads the snapshot once from the Refresh button', async () => {
    const h = mount({ today: null });
    await waitFor(() => expect(unavailable()).not.toBeNull());
    const before = clarityReads(h).length;
    await h.user.click(within(headline()).getByRole('button', { name: `Refresh ${HEADLINE_TITLE}` }));
    await waitFor(() => expect(clarityReads(h).length).toBe(before + 1));
    await waitFor(() => expect(screen.queryByText(/Refreshing/)).toBeNull());
  });
});

describe('region isolation', () => {
  it('a failed todayAllowance calculation stays inside the headline', async () => {
    const h = mount({
      prepare: (backend) => {
        backend.alterToday = (outcome) => ({
          ...outcome,
          status: 'calculation_failed',
          value: undefined,
          retry: { action: 'recalculate', scopeKey: `outcome:${outcome.id}` },
        });
      },
    });
    await screen.findByRole('article', { name: /Remaining to spend/ });
    const card = await within(headline()).findByRole('article', { name: new RegExp(HEADLINE_TITLE) });
    expect(card).toHaveAttribute('data-status', 'calculation_failed');
    expect(within(card).getByRole('button', { name: /Recalculate/ })).toBeInTheDocument();
    // The siblings keep their values and the input still works.
    expect(screen.getByRole('article', { name: /Remaining to spend/ })).toHaveAttribute('data-status', 'available');
    expect(quickActions()).toBeInTheDocument();
    await h.user.type(input(), '50 tea');
    expect(input()).toHaveValue('50 tea');
    // One retry re-reads the snapshot.
    const before = clarityReads(h).length;
    await h.user.click(within(card).getByRole('button', { name: /Recalculate/ }));
    await waitFor(() => expect(clarityReads(h).length).toBe(before + 1));
  });

  it('a failed read puts an error and one retry in the headline, keeps the input and the quick actions, and recovers', async () => {
    const h = mount({
      prepare: (backend) => {
        backend.failWith('GET', '/finance/clarity', { status: 403, code: 'FORBIDDEN', message: 'Not allowed right now.' });
      },
    });
    const error = await within(await screen.findByTestId('today-headline')).findByRole('alert');
    expect(error).toHaveTextContent(`${HEADLINE_TITLE} could not load.`);
    expect(quickActions()).toBeInTheDocument();
    expect(input()).toBeInTheDocument();
    await h.user.type(input(), '50 tea');
    expect(input()).toHaveValue('50 tea');
    await h.user.click(within(headline()).getByRole('button', { name: `Retry loading ${HEADLINE_TITLE}` }));
    await within(headline()).findByText(/You can spend/);
    await screen.findByRole('article', { name: /Remaining to spend/ });
    // The typed line survived the retry.
    expect(input()).toHaveValue('50 tea');
  });
});

describe('the floating action and the shortcut on Home', () => {
  it('the floating action focuses the inline input and opens no dialog', async () => {
    const h = mount({ wide: false });
    await homeLoaded(h);
    const fab = screen.getByRole('button', { name: FAB_LABEL });
    await h.user.click(fab);
    expect(input()).toHaveFocus();
    expect(screen.queryByRole('dialog', { name: QUICK_ADD_DIALOG_TITLE })).toBeNull();
    expect(h.store.getState().dialogOpen).toBe(false);
    // The one input on the page is the inline one.
    expect(screen.getAllByLabelText(QUICK_ADD_LABEL)).toHaveLength(1);
    expect(input().closest('.home-quick-add')).not.toBeNull();
  });

  it('Ctrl K focuses the inline input from another control, cancels the browser default, and opens no dialog', async () => {
    const h = mount();
    await homeLoaded(h);
    const tile = within(quickActions()).getAllByRole('link')[0] as HTMLElement;
    tile.focus();
    expect(fireEvent.keyDown(tile, { key: 'k', code: 'KeyK', ctrlKey: true })).toBe(false);
    expect(input()).toHaveFocus();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(h.store.getState().dialogOpen).toBe(false);
    // The shortcut text is visible beside the input where the tab bar is not shown.
    expect(within(input().closest('.home-quick-add') as HTMLElement).getByText('Ctrl K')).toBeInTheDocument();
  });
});

describe('the headline after a Quick Add save', () => {
  it('updates in place from the confirmed response, with no re-read, no reload, and no page-wide loading', async () => {
    const h = mount();
    await homeLoaded(h);
    const spent = () => headline().querySelector('.today-headline-spent') as HTMLElement;
    const left = () => headline().querySelector('.today-headline-left') as HTMLElement;
    expect(spent()).toHaveTextContent('Spent today ₹0');
    const regionNode = region('today');
    const articleNode = within(headline()).getByRole('article', { name: new RegExp(HEADLINE_TITLE) });
    const reads = clarityReads(h).length;
    await h.user.type(input(), '300 coffee{Enter}');
    await waitFor(() => expect(spent()).toHaveTextContent('Spent today ₹300'));
    expect(left()).toHaveTextContent('₹2,700 left today');
    // The same nodes were updated: nothing was replaced or re-read.
    expect(region('today')).toBe(regionNode);
    expect(within(headline()).getByRole('article', { name: new RegExp(HEADLINE_TITLE) })).toBe(articleNode);
    expect(clarityReads(h)).toHaveLength(reads);
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
    expect(screen.queryByText(/Refreshing/)).toBeNull();
    // Focus stayed on the input for the next entry.
    expect(input()).toHaveFocus();
  });

  it('leaves the headline unchanged for an entry that counts toward another month', async () => {
    const h = mount();
    await homeLoaded(h);
    const before = headline().textContent;
    await h.user.type(input(), '300 coffee 2026-10-05{Enter}');
    await waitFor(() => expect(h.store.getState().entries[0]?.phase).toBe('saved'));
    expect(h.net.to('POST', '/finance/expenses')).toHaveLength(1);
    expect(h.backend.expenses[0]?.spentOn).toBe('2026-10-05');
    expect(headline().textContent).toBe(before);
  });
});

describe('a new Asia/Kolkata day', () => {
  it('re-reads the snapshot when Home becomes visible on a later date and shows the new date', async () => {
    const h = mount();
    await homeLoaded(h);
    expect(within(headline()).getByText('18 Nov 2026', { exact: false })).toBeInTheDocument();
    const reads = clarityReads(h).length;
    h.backend.todayDate = TOMORROW;
    // Midnight in Asia/Kolkata passes while the page is hidden. It is visible again.
    vi.setSystemTime(Date.parse('2026-11-19T00:10:00.000Z'));
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => expect(clarityReads(h).length).toBe(reads + 1));
    await waitFor(() => expect(within(headline()).getByText('19 Nov 2026', { exact: false })).toBeInTheDocument());
    // One re-read per new day, not a loop.
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(clarityReads(h)).toHaveLength(reads + 1);
  });

  it('does not re-read while the date is unchanged', async () => {
    const h = mount();
    await homeLoaded(h);
    const reads = clarityReads(h).length;
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(clarityReads(h)).toHaveLength(reads);
  });
});

describe('accessibility', () => {
  it.each(['light', 'dark'] as const)('has no axe violations on Home with the headline and the inline panel in the %s theme', async (theme) => {
    localStorage.setItem('theme', theme);
    const h = mount();
    await homeLoaded(h);
    expect(document.documentElement.dataset.theme).toBe(theme);
    expect(await axe(h.container)).toHaveNoViolations();
    await h.user.type(input(), '300 coffee{Enter}');
    await waitFor(() => expect(h.store.getState().entries[0]?.phase).toBe('saved'));
    expect(await axe(h.container)).toHaveNoViolations();
  });

  it('has no axe violations with the unavailable headline of an old server', async () => {
    const h = mount({ today: null });
    await screen.findByTestId('today-headline');
    await waitFor(() => expect(unavailable()).not.toBeNull());
    expect(await axe(h.container)).toHaveNoViolations();
  });
});

// ---- Task 14.3: Home order at every width, headline states inside Home, the guide, and the rollover re-read ----

const WIDTHS = [320, 390, 768, 1024, 1440] as const;
const money = (amountMinor: number): MoneyValue => ({ currency: 'INR', amountMinor });
const guideText = () => screen.getByRole('article', { name: /Remaining to spend/ }).textContent;

/** The backend's own `todayAllowance` value with some fields replaced. */
function withValue(overrides: Partial<Extract<TodayAllowanceValue, { applicable: true }>>) {
  return (outcome: TodayAllowanceOutcome): TodayAllowanceOutcome => ({
    ...outcome,
    value: { ...(outcome.value as object), ...overrides } as TodayAllowanceValue,
  });
}

describe.each(WIDTHS)('the order of Home at %i CSS pixels (Requirements 1.1, 11.1)', (width) => {
  it('is the page decision header, the headline, the input, the quick actions, the key numbers, then the rest', async () => {
    const h = mount({ width });
    await homeLoaded(h);
    expect(window.innerWidth).toBe(width);
    const header = h.container.querySelector('.clarity-decision-header') as HTMLElement;
    const sequence = [
      header,
      region('today') as HTMLElement,
      input(),
      quickActions(),
      region('monthly-plan') as HTMLElement,
      region('actions') as HTMLElement,
      screen.getByRole('heading', { name: 'Guided journey' }),
    ];
    for (const element of sequence) expect(element).toBeTruthy();
    for (let i = 0; i < sequence.length - 1; i += 1) {
      expect(comesBefore(sequence[i]!, sequence[i + 1]!), `item ${i} comes before item ${i + 1}`).toBe(true);
    }
    const panel = input().closest('.home-quick-add') as HTMLElement;
    expect(header.nextElementSibling).toBe(headline());
    expect(headline().nextElementSibling).toBe(panel);
    expect(panel.nextElementSibling).toBe(quickActions());
    // One headline, one input, four quick actions, and no dialog at any width.
    expect(screen.getAllByLabelText(QUICK_ADD_LABEL)).toHaveLength(1);
    expect(within(quickActions()).getAllByRole('link')).toHaveLength(4);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(headline().querySelector('.today-headline-main')).toHaveTextContent('You can spend ₹3,000 today');
  });

  it(width < 900
    ? 'shows the floating action while the bottom tab bar is displayed and no shortcut text beside the input'
    : 'shows the shortcut text beside the input and no floating action', async () => {
    const h = mount({ width });
    await homeLoaded(h);
    const fab = screen.queryByRole('button', { name: FAB_LABEL });
    const hint = within(input().closest('.home-quick-add') as HTMLElement).queryByText('Ctrl K');
    if (width < 900) {
      expect(fab).toBeInTheDocument();
      expect(hint).toBeNull();
    } else {
      expect(fab).toBeNull();
      expect(hint).toBeInTheDocument();
    }
  });
});

describe('the stylesheets keep one Home order at every width (Requirement 1.1)', () => {
  const FILES = [
    'src/styles.css',
    'src/components/dashboard/todayHeadline.css',
    'src/components/dashboard/monthlyClarity.css',
    'src/components/quickAdd/quickAdd.css',
    'src/components/quickAdd/quickAddShell.css',
  ];
  const HOME_BLOCK = /\.(today-headline|home-quick-add|home-secondary|quick-actions|monthly-clarity|clarity-decision-header|qa-panel)\b/;
  const REORDERING = /(?<![-\w])order\s*:|-reverse|grid-template-areas|grid-area\b|display\s*:\s*none|position\s*:\s*(absolute|fixed)|(?<![-\w])float\s*:/;

  it('has no rule that reorders, hides, or lifts out of the flow a block of Home, in any media query', () => {
    let inspected = 0;
    for (const file of FILES) {
      const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (selector!.trim().startsWith('@') || !HOME_BLOCK.test(selector!)) continue;
        inspected += 1;
        expect(body, `${file}: ${selector!.trim()}`).not.toMatch(REORDERING);
      }
    }
    // The scan found the Home rules, so a changed file layout cannot make this pass by matching nothing.
    expect(inspected).toBeGreaterThan(10);
  });

  it('uses only the 900px breakpoint of the shell and width-free rules for the headline and the input panel', () => {
    const headlineCss = readFileSync('src/components/dashboard/todayHeadline.css', 'utf8');
    const widths = [...headlineCss.matchAll(/@media\s*\(\s*(?:min|max)-width:\s*(\d+)px\s*\)/g)].map((match) => Number(match[1]));
    expect(widths).toEqual([900]);
    const homeCss = readFileSync('src/components/dashboard/monthlyClarity.css', 'utf8');
    expect(homeCss).toMatch(/\.home-quick-add\.card\s*\{[^}]*min-width:\s*0/);
    expect(homeCss).not.toMatch(/\.home-quick-add[^{]*\{[^}]*(?<![-\w])width:\s*\d+px/);
  });
});

describe('every headline state inside Home keeps the other regions (Requirements 11.3, 11.6 to 11.12)', () => {
  const text = (node: HTMLElement) => node.textContent ?? '';
  const CASES: Array<[string, (backend: HomeBackend) => void, RegExp]> = [
    ['over today', (b) => { b.alterToday = withValue({ todaySpent: money(80000), leftToday: money(-29654), overToday: money(29654), usedPermille: 1000 }); },
      /Over today's allowance by ₹296\.54/],
    ['zero: month budget used', (b) => { b.alterToday = withValue({ todayAllowance: money(0), todaySpent: money(0), leftToday: money(0), usedPermille: null, zeroReason: 'month_budget_used', usedBeyondBudget: money(123450) }); },
      /You can spend ₹0 today[\s\S]*already used before today, by ₹1,234\.50/],
    ['zero: no spendable budget', (b) => { b.alterToday = withValue({ todayAllowance: money(0), todaySpent: money(0), leftToday: money(0), usedPermille: null, zeroReason: 'no_spendable_budget' }); },
      /Your bills use all of your pay this month\./],
    ['zero: below the minimum unit', (b) => { b.alterToday = withValue({ todayAllowance: money(0), todaySpent: money(0), leftToday: money(0), usedPermille: null, zeroReason: 'below_minimum_unit' }); },
      /less than ₹0\.01 a day/],
    ['missing pay', (b) => { b.alterToday = (o) => ({ ...o, status: 'missing_input', value: undefined, explanationRef: undefined, missing: [{ input: 'salary', unlocks: ['monthly_plan', 'spending'] }] }); },
      /Add this month's pay to see what you can spend today\./],
    ['invalid input', (b) => { b.alterToday = (o) => ({ ...o, status: 'invalid_input', value: undefined, explanationRef: undefined, invalid: [{ input: 'salary', constraint: 'an amount above zero', affects: ['monthly_plan', 'spending'] }] }); },
      /Salary must be: an amount above zero\./],
  ];

  it.each(CASES)('%s: shows its state in the headline, links the Plan form where one applies, and leaves the rest of Home', async (name, prepare, expected) => {
    const h = mount({ prepare: (backend) => prepare(backend) });
    await screen.findByRole('article', { name: /Remaining to spend/ });
    await waitFor(() => expect(text(headline())).toMatch(expected));
    if (name === 'missing pay') {
      expect(within(headline()).getByRole('link', { name: /pay/i }).getAttribute('href')).toMatch(/^\/plan#pay-form/);
    }
    if (name === 'zero: no spendable budget') {
      expect(within(headline()).getByRole('link', { name: /Review monthly bills/ })).toHaveAttribute('href', '/plan#bills-form');
    }
    // The monthly summary keeps its value, and the input and the quick actions stay usable.
    expect(screen.getByRole('article', { name: /Remaining to spend/ })).toHaveAttribute('data-status', 'available');
    expect(quickActions()).toBeInTheDocument();
    await h.user.type(input(), '50 tea');
    expect(input()).toHaveValue('50 tea');
  });

  it('a stale headline keeps its values and says so until the re-read returns (Requirement 11.14)', async () => {
    const h = mount();
    await homeLoaded(h);
    const gate = h.net.hold('GET', '/finance/clarity');
    h.backend.todayDate = TOMORROW;
    // 00:01 on 19 November in Asia/Kolkata. The visibility event is the trigger; the clock is the only input.
    vi.setSystemTime(Date.parse('2026-11-18T18:31:00.000Z'));
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => expect(within(headline()).getByText('Stale', { selector: '.clarity-status' })).toBeInTheDocument());
    expect(headline()).toHaveTextContent('Showing 18 Nov 2026; 19 Nov 2026 was requested.');
    expect(headline().querySelector('.today-headline-main')).toHaveTextContent('You can spend ₹3,000 today');
    gate.release();
    await waitFor(() => expect(within(headline()).getByText('19 Nov 2026', { exact: false })).toBeInTheDocument());
    expect(within(headline()).queryByText('Stale', { selector: '.clarity-status' })).toBeNull();
  });
});

describe('an entry that is not counted today (Requirement 11.20)', () => {
  it('shows its number and total in the headline and leaves Spent today and left today alone', async () => {
    const h = mount();
    await homeLoaded(h);
    expect(headline().querySelector('.today-headline-excluded')).toBeNull();
    await h.user.type(input(), '1500 laptop');
    await h.user.click(await screen.findByRole('button', { name: SAVE_WITHOUT_COUNTING_LABEL }));
    await waitFor(() => expect(headline()).toHaveTextContent('1 expense not counted today (₹1,500)'));
    expect(h.net.to('POST', '/finance/expenses')[0]?.body).toMatchObject({ amountMinor: 150000, excludeFromDailyAllowance: true });
    expect(headline().querySelector('.today-headline-spent')).toHaveTextContent('Spent today ₹0');
    expect(headline().querySelector('.today-headline-left')).toHaveTextContent('₹3,000 left today');
  });

  it('counts the same entry in Spent today when the User saves it as counted', async () => {
    const h = mount();
    await homeLoaded(h);
    await h.user.type(input(), '1500 laptop');
    await h.user.click(await screen.findByRole('button', { name: 'Save and count today' }));
    await waitFor(() => expect(headline().querySelector('.today-headline-spent')).toHaveTextContent('Spent today ₹1,500'));
    expect(headline()).not.toHaveTextContent(/not counted today/);
  });
});

describe('the Daily spending guide stays as it was (Requirement 11.19)', () => {
  it('shows the same guide with Quick Add off and on, and does not take the allowance as its value', async () => {
    const off = mount({ quickAdd: false });
    await homeLoaded(off, { headlineValue: false });
    const guideOff = guideText();
    expect(guideOff).toContain('Daily spending guide');
    cleanup();

    const on = mount({
      prepare: (backend) => { backend.alterToday = withValue({ todayAllowance: money(123456), leftToday: money(123456), todaySpent: money(0) }); },
    });
    await homeLoaded(on);
    expect(headline().querySelector('.today-headline-main')).toHaveTextContent('You can spend ₹1,234.56 today');
    expect(guideText()).toBe(guideOff);
    expect(guideText()).not.toContain('1,234.56');
  });

  it('is not changed by a save, while the headline moves', async () => {
    const h = mount();
    await homeLoaded(h);
    const before = guideText();
    await h.user.type(input(), '300 coffee{Enter}');
    await waitFor(() => expect(headline().querySelector('.today-headline-spent')).toHaveTextContent('Spent today ₹300'));
    expect(guideText()).toBe(before);
  });
});

describe('the midnight and month rollover re-read (Requirements 11.14, 11.15, 11.18, 11.21)', () => {
  /** The 30-second calendar timer of `useKolkataToday`, captured so a test can fire it without waiting. */
  function captureCalendarTimer() {
    const captured: Array<() => void> = [];
    const real = globalThis.setInterval;
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((handler: () => void, delay?: number, ...args: unknown[]) => {
      if (delay === KOLKATA_REEVALUATE_MS && handler.name === 'notifySubscribers') captured.push(handler);
      return real(handler, delay, ...(args as []));
    }) as unknown as typeof setInterval);
    return captured;
  }
  const monthReads = (h: Harness, month: string) => clarityReads(h).filter((call) => call.query.get('month') === month);

  it('re-reads within 60 seconds of midnight with no event at all, and shows the new date', async () => {
    const timer = captureCalendarTimer();
    const h = mount();
    await homeLoaded(h);
    expect(timer.length).toBeGreaterThan(0);
    expect(KOLKATA_REEVALUATE_MS).toBeLessThanOrEqual(30_000);
    const reads = clarityReads(h).length;
    // Midnight passes on the device. Nothing happens until the calendar timer next looks.
    h.backend.todayDate = TOMORROW;
    vi.setSystemTime(Date.parse('2026-11-18T18:30:30.000Z'));
    act(() => timer[timer.length - 1]!());
    await waitFor(() => expect(clarityReads(h).length).toBe(reads + 1));
    await waitFor(() => expect(within(headline()).getByText('19 Nov 2026', { exact: false })).toBeInTheDocument());
    expect(monthReads(h, '2026-11')).toHaveLength(clarityReads(h).length);
    // A timer tick on the same day reads nothing more.
    act(() => timer[timer.length - 1]!());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(clarityReads(h)).toHaveLength(reads + 1);
  });

  it('reads the new month at the month boundary and names it in the header and the headline', async () => {
    const timer = captureCalendarTimer();
    const h = mount();
    await homeLoaded(h);
    const header = () => h.container.querySelector('.clarity-decision-header .pill') as HTMLElement;
    expect(header()).toHaveTextContent(monthLabel('2026-11'));
    const novemberReads = monthReads(h, '2026-11').length;
    // 00:10 on 1 December in Asia/Kolkata is 18:40 on 30 November UTC, and the device zone plays no part.
    h.backend.todayDate = '2026-12-01';
    vi.setSystemTime(Date.parse('2026-11-30T18:40:00.000Z'));
    act(() => timer[timer.length - 1]!());
    await waitFor(() => expect(monthReads(h, '2026-12')).toHaveLength(1));
    await waitFor(() => expect(within(headline()).getByText('1 Dec 2026', { exact: false })).toBeInTheDocument());
    expect(header()).toHaveTextContent(monthLabel('2026-12'));
    expect(headline().querySelector('.today-headline-main')).toHaveTextContent('You can spend ₹3,000 today');
    expect(monthReads(h, '2026-11')).toHaveLength(novemberReads);
    expect(screen.queryByText('Stale')).toBeNull();
  });

  it('does not re-read while the page is hidden, and re-reads once when it becomes visible on a later date', async () => {
    const h = mount();
    await homeLoaded(h);
    const reads = clarityReads(h).length;
    h.backend.todayDate = TOMORROW;
    vi.setSystemTime(Date.parse('2026-11-19T00:10:00.000Z'));
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(clarityReads(h)).toHaveLength(reads);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => expect(clarityReads(h).length).toBe(reads + 1));
    await waitFor(() => expect(within(headline()).getByText('19 Nov 2026', { exact: false })).toBeInTheDocument());
  });
});

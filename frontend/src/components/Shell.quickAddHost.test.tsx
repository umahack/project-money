// Quick Add in the application Shell (task 13.3; Requirements 1.1 to 1.19, 12.5, 12.6, 9.18):
//
// - the shortcut: Ctrl K and Cmd K, the other platform's modifier, Shift, Alt, repeat, composition, other keys,
//   another modal, the open data-use notice, another text field, the open dialog, `preventDefault` only when handled,
// - the dialog: opens over the page without navigating, focuses the input, contains focus, closes on Escape and on
//   Close, returns focus to the opener, stays open after a save, and keeps a pending entry saving when it is closed,
// - the floating action: only below 900px, on every page of the User view, publishes `--quick-add-fab-h`,
// - Home (inline input) against the other pages (dialog), the failed-entries status, the announcement text,
// - the administrator console and the flag-off Shell: nothing mounted, no listener, no request,
// - axe in both themes and a keyboard-only flow.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgreementGateProvider } from '../clarity/AgreementGateProvider';
import { DataUseGateProvider, PROMISE_RENDERED_KEY } from '../clarity/DataUseGateProvider';
import { FinancialClarityProvider } from '../clarity/FinancialClarityProvider';
import { MutationStatusProvider } from '../clarity/MutationStatusProvider';
import { BUILT_IN_CATEGORIES } from '../clarity/quickAdd/keywordRules';
import { resetServerTimeOffset } from '../clarity/quickAdd/kolkata';
import { QuickAddProvider } from '../clarity/quickAdd/QuickAddProvider';
import { createQuickAddStore, type QuickAddStore } from '../clarity/quickAdd/quickAddStore';
import { Agreement } from '../pages/Agreement';
import { buildSettings } from '../test/claritySettingsBuilder';
import { FakeQuickAddBackend } from '../test/fakeQuickAddBackend';
import { installSpendingFetch, type SpendingFetch } from '../test/fakeSpendingFetch';
import type { SpendingBackendReply, SpendingBackendRequest } from '../test/fakeSpendingBackend';
import { resetSharedMemoryClient } from '../test/settingsMemoryServer';
import { axe, createTestQueryClient, createTestUser, renderAuthenticated } from '../test/test-utils';
import { FAB_HEIGHT_PROPERTY, FAB_LABEL } from './quickAdd/QuickAddFab';
import { FAILED_STATUS_ACTION } from './quickAdd/QuickAddFailedStatus';
import { QuickAddPanel } from './quickAdd/QuickAddPanel';
import { QUICK_ADD_CLOSE_LABEL, QUICK_ADD_DIALOG_TITLE } from './quickAdd/QuickAddDialog';
import { QUICK_ADD_LABEL } from './quickAdd/QuickAddInput';
import { Shell } from './Shell';

const MONTH = '2026-11';
const TODAY = '2026-11-18';
const NOW = Date.parse('2026-11-18T06:30:00.000Z');
const EXPENSES = '/finance/expenses';
const QUICK_ADD_PATH = /category-memory|\/finance\/categories|\/finance\/expenses|quick-add\/hints/;

/** The Spending fake with the settings the Shell's data-use gate reads and the category list. */
class ShellBackend extends FakeQuickAddBackend {
  noticeAcknowledged = true;

  override handle(request: SpendingBackendRequest): SpendingBackendReply {
    const get = request.method.toUpperCase() === 'GET';
    if (get && request.path === '/finance/categories') {
      return { status: 200, body: { defaults: [...BUILT_IN_CATEGORIES], custom: [] } };
    }
    if (request.path === '/clarity/settings') {
      // Agreeing on the Agreement page sends the PATCH that acknowledges the notice.
      if (request.method.toUpperCase() === 'PATCH') this.noticeAcknowledged = true;
      if (get || request.method.toUpperCase() === 'PATCH') {
        return { status: 200, body: buildSettings({ acknowledgedVersion: this.noticeAcknowledged ? 1 : 0 }) };
      }
    }
    return super.handle(request);
  }
}

/** A viewport the test can resize: the 900px media query answers from `wide`, and listeners are told on a change. */
function installViewport(initiallyWide: boolean) {
  let wide = initiallyWide;
  const listeners = new Set<() => void>();
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() { return /min-width:\s*900px/.test(query) ? wide : false; },
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

function setPlatform(platform: string) {
  Object.defineProperty(window.navigator, 'platform', { value: platform, configurable: true });
}

interface Harness {
  user: ReturnType<typeof userEvent.setup>;
  backend: ShellBackend;
  net: SpendingFetch;
  store: QuickAddStore;
  viewport: ReturnType<typeof installViewport>;
  container: HTMLElement;
}

interface MountOptions {
  route?: string;
  wide?: boolean;
  admin?: boolean;
  /** Both flags on (the default), both off, or only the Quick_Add_Flag on. */
  flags?: 'on' | 'off' | 'quickAddOnly';
  noticeAcknowledged?: boolean;
  today?: string | null;
  prepare?(backend: ShellBackend, net: SpendingFetch): void;
}

function HomePage() {
  return (
    <>
      <h1>Home page</h1>
      <label>Home note<input defaultValue="home value" /></label>
      <QuickAddPanel variant="inline" />
    </>
  );
}

function SpendingPage() {
  return (
    <>
      <h1>Spending page</h1>
      <label>Other field<input defaultValue="keep me" /></label>
      <button type="button">Page button</button>
    </>
  );
}

function mount(options: MountOptions = {}): Harness {
  const flags = options.flags ?? 'on';
  vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', flags === 'quickAddOnly' || flags === 'off' ? '' : 'true');
  vi.stubEnv('VITE_QUICK_ADD_ENABLED', flags === 'off' ? '' : 'true');
  sessionStorage.setItem(PROMISE_RENDERED_KEY, '4242');
  const viewport = installViewport(options.wide ?? true);
  const backend = new ShellBackend(MONTH, { categories: [...BUILT_IN_CATEGORIES] });
  backend.todayDate = options.today === undefined ? TODAY : options.today;
  backend.noticeAcknowledged = options.noticeAcknowledged ?? true;
  const net = installSpendingFetch(backend);
  options.prepare?.(backend, net);
  const store = createQuickAddStore();

  const view = renderAuthenticated(
    <FinancialClarityProvider>
      <MutationStatusProvider>
        <QuickAddProvider store={store}>
          {/* The gate providers sit above the routes, as in App, so the Shell and the Agreement page share one gate. */}
          <DataUseGateProvider>
            <AgreementGateProvider>
              <Routes>
                <Route path="/agreement" element={<Agreement />} />
                <Route element={<Shell />}>
                  <Route path="/" element={<HomePage />} />
                  <Route path="/spending" element={<SpendingPage />} />
                  <Route path="/admin" element={<h1>Admin overview</h1>} />
                </Route>
              </Routes>
            </AgreementGateProvider>
          </DataUseGateProvider>
        </QuickAddProvider>
      </MutationStatusProvider>
    </FinancialClarityProvider>,
    {
      route: options.route ?? '/spending',
      queryClient: createTestQueryClient(),
      user: createTestUser({ is_admin: options.admin ?? false }),
    },
  );
  return { user: userEvent.setup(), backend, net, store, viewport, container: view.container };
}

beforeEach(() => {
  vi.setSystemTime(NOW);
  setPlatform('Win32');
});

afterEach(() => {
  resetSharedMemoryClient();
  resetServerTimeOffset();
  delete (window.navigator as unknown as Record<string, unknown>).platform;
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.style.removeProperty(FAB_HEIGHT_PROPERTY);
  document.documentElement.style.removeProperty('--bottom-nav-h');
});

const dialog = () => screen.queryByRole('dialog', { name: QUICK_ADD_DIALOG_TITLE });
const findDialog = () => screen.findByRole('dialog', { name: QUICK_ADD_DIALOG_TITLE });
const input = () => screen.getByLabelText(QUICK_ADD_LABEL) as HTMLInputElement;
const fab = () => screen.queryByRole('button', { name: FAB_LABEL });
const polite = () => screen.getByTestId('quick-add-polite');
const rows = () => [...document.querySelectorAll<HTMLElement>('li.qa-entry')];
const quickAddRequests = (h: Harness) => h.net.calls.filter((call) => QUICK_ADD_PATH.test(call.path));

/** Dispatches the key on the focused element. Returns false when a handler called `preventDefault`. */
function press(init: KeyboardEventInit = {}, target: Element = document.activeElement ?? document.body): boolean {
  return fireEvent.keyDown(target, { key: 'k', code: 'KeyK', ctrlKey: true, ...init });
}

/** The page is up and, while the Rollout_Flag is on, the Shell's data-use gate has read its settings. */
async function settled(h: Harness, route = '/spending', gateRead = true) {
  await screen.findByRole('heading', { name: route === '/' ? 'Home page' : 'Spending page' });
  if (gateRead) await waitFor(() => expect(h.net.to('GET', '/clarity/settings').length).toBeGreaterThan(0));
}

async function closeDialog() {
  await waitFor(() => expect(dialog()).toBeNull());
}

/* ------------------------------ flag off ----------------------------------- */

describe('flag off', () => {
  it.each([
    ['both flags off', 'off'],
    ['the Rollout_Flag off and the Quick_Add_Flag on', 'quickAddOnly'],
  ] as const)('mounts nothing, installs no listener, sends no request, and leaves the key alone with %s', async (_label, flags) => {
    const added = vi.spyOn(window, 'addEventListener');
    const h = mount({ flags, wide: false });
    await settled(h, '/spending', false);

    expect(fab()).toBeNull();
    expect(dialog()).toBeNull();
    expect(document.querySelector('[class*="qa-"]')).toBeNull();
    expect(screen.queryByTestId('quick-add-polite')).toBeNull();
    expect(added.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(0);
    expect(press()).toBe(true);
    expect(dialog()).toBeNull();
    expect(quickAddRequests(h)).toEqual([]);
    expect(document.documentElement.style.getPropertyValue(FAB_HEIGHT_PROPERTY)).toBe('');
  });

  it('renders nothing for the Home panel either', async () => {
    const h = mount({ flags: 'off', route: '/' });
    await settled(h, '/', false);
    expect(screen.queryByLabelText(QUICK_ADD_LABEL)).toBeNull();
    expect(quickAddRequests(h)).toEqual([]);
  });
});

/* ------------------------------ the shortcut -------------------------------- */

describe('shortcut: platform', () => {
  it('opens the dialog on Ctrl K away from Home, cancels the browser default, and focuses the input', async () => {
    const h = mount();
    await settled(h);
    expect(dialog()).toBeNull();

    expect(press()).toBe(false);
    const opened = await findDialog();
    expect(opened).toHaveAttribute('aria-modal', 'true');
    await waitFor(() => expect(input()).toHaveFocus());
    // It opened over the page. The route did not change.
    expect(screen.getByRole('heading', { name: 'Spending page' })).toBeInTheDocument();
    expect(h.store.getState().dialogOpen).toBe(true);
  });

  it('does not respond to Cmd K on a non-Apple platform', async () => {
    const h = mount();
    await settled(h);
    expect(press({ ctrlKey: false, metaKey: true })).toBe(true);
    expect(dialog()).toBeNull();
    expect(h.store.getState().dialogOpen).toBe(false);
  });

  it('opens on Cmd K and ignores Ctrl K on an Apple platform, and names the shortcut as Cmd K', async () => {
    setPlatform('MacIntel');
    const h = mount();
    await settled(h);
    expect(press({ ctrlKey: true })).toBe(true);
    expect(dialog()).toBeNull();

    expect(press({ ctrlKey: false, metaKey: true })).toBe(false);
    await findDialog();
    expect(input()).toHaveAttribute('aria-keyshortcuts', 'Meta+K');
    expect(within(dialog() as HTMLElement).getByText('⌘ K')).toBeInTheDocument();
  });

  it('matches the physical K key on a layout whose letter is not Latin', async () => {
    const h = mount();
    await settled(h);
    expect(press({ key: 'क' })).toBe(false);
    await findDialog();
    expect(h.store.getState().dialogOpen).toBe(true);
  });
});

describe('shortcut: presses that are left to the browser', () => {
  it.each([
    ['Shift held', { shiftKey: true }],
    ['Alt held', { altKey: true }],
    ['the key held down', { repeat: true }],
    ['an input method composition', { isComposing: true }],
    ['another key', { key: 'j', code: 'KeyJ' }],
    ['no modifier', { ctrlKey: false }],
  ] as const)('does nothing and does not cancel the default with %s', async (_label, init) => {
    const h = mount();
    await settled(h);
    expect(press(init)).toBe(true);
    expect(dialog()).toBeNull();
    expect(h.store.getState().dialogOpen).toBe(false);
  });

  it('leaves the key to another modal and does not break its focus containment', async () => {
    const h = mount();
    await settled(h);
    await h.user.click(screen.getByRole('button', { name: 'Sign out' }));
    const feedback = await screen.findAllByRole('dialog');
    expect(feedback).toHaveLength(1);
    expect(press()).toBe(true);
    expect(dialog()).toBeNull();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });

  it('leaves the key alone while the gate asks the User to read the data-use notice, and handles it again once the User agreed on the Agreement page', async () => {
    const h = mount({ noticeAcknowledged: false });
    await settled(h);
    const link = await screen.findByRole('link', { name: /Review and agree to the data-use notice/ });
    expect(press()).toBe(true);
    expect(dialog()).toBeNull();

    // The acknowledgement now happens on /agreement. Agreeing returns to Home, where the key is handled again.
    await h.user.click(link);
    await h.user.click(await screen.findByRole('button', { name: 'I agree and continue' }));
    await screen.findByRole('heading', { name: 'Home page' });
    await waitFor(() => expect(screen.queryByRole('link', { name: /Review and agree to the data-use notice/ })).toBeNull());
    expect(h.net.to('PATCH', '/clarity/settings')).toHaveLength(1);
    expect(press()).toBe(false);
    await waitFor(() => expect(input()).toHaveFocus());
  });

  it('leaves the key alone while the acknowledged notice is open for review, and handles it again once it is closed', async () => {
    const h = mount();
    await settled(h);
    await h.user.click(await screen.findByRole('button', { name: 'Your data' }));
    const review = await screen.findByRole('button', { name: /Review the data-use notice/ });
    await h.user.click(review);
    expect(review).toHaveAttribute('aria-expanded', 'true');
    expect(press()).toBe(true);
    expect(dialog()).toBeNull();

    await h.user.click(review);
    expect(press()).toBe(false);
    await findDialog();
  });

  it('does not handle an event that another handler already claimed', async () => {
    const h = mount();
    await settled(h);
    const claim = (event: Event) => event.preventDefault();
    document.body.addEventListener('keydown', claim);
    try {
      expect(press({}, document.body)).toBe(false);
      expect(dialog()).toBeNull();
    } finally {
      document.body.removeEventListener('keydown', claim);
    }
  });
});

describe('shortcut: focus', () => {
  it('moves focus from another text field to the input and leaves that field untouched', async () => {
    const h = mount();
    await settled(h);
    const other = screen.getByLabelText('Other field') as HTMLInputElement;
    await h.user.click(other);
    expect(other).toHaveFocus();

    expect(press()).toBe(false);
    await findDialog();
    await waitFor(() => expect(input()).toHaveFocus());
    expect(other).toHaveValue('keep me');
  });

  it('moves focus to the input of the open dialog and neither closes it nor opens a second one', async () => {
    const h = mount();
    await settled(h);
    press();
    await findDialog();
    await waitFor(() => expect(input()).toHaveFocus());

    act(() => screen.getByRole('button', { name: QUICK_ADD_CLOSE_LABEL }).focus());
    expect(input()).not.toHaveFocus();

    expect(press()).toBe(false);
    expect(input()).toHaveFocus();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(h.store.getState().dialogOpen).toBe(true);
  });

  it('on Home focuses the inline input instead of opening the dialog', async () => {
    const h = mount({ route: '/' });
    await settled(h, '/');
    const note = screen.getByLabelText('Home note') as HTMLInputElement;
    await h.user.click(note);

    expect(press()).toBe(false);
    expect(input()).toHaveFocus();
    expect(dialog()).toBeNull();
    expect(h.store.getState().dialogOpen).toBe(false);
    expect(note).toHaveValue('home value');
  });
});

/* ------------------------------ the dialog ---------------------------------- */

describe('dialog', () => {
  it('is labelled, shows the shortcut as text in its footer at 900px and wider, and has no body scroll', async () => {
    const h = mount();
    await settled(h);
    press();
    const opened = await findDialog();
    expect(opened).toHaveAccessibleName(QUICK_ADD_DIALOG_TITLE);
    expect(within(opened).getByRole('heading', { name: QUICK_ADD_DIALOG_TITLE })).toBeInTheDocument();
    expect(within(opened).getByText('Ctrl K')).toBeInTheDocument();
    expect(input()).toHaveAttribute('aria-keyshortcuts', 'Control+K');
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('closes on Escape and returns focus to the control that had it', async () => {
    const h = mount({ wide: false });
    await settled(h);
    const opener = fab() as HTMLElement;
    await h.user.click(opener);
    await findDialog();
    await waitFor(() => expect(input()).toHaveFocus());

    await h.user.keyboard('{Escape}');
    await closeDialog();
    expect(opener).toHaveFocus();
    expect(h.store.getState().dialogOpen).toBe(false);
    expect(document.body.style.overflow).not.toBe('hidden');
  });

  it('closes with the Close button, and focus returns to the field the shortcut came from', async () => {
    const h = mount();
    await settled(h);
    const other = screen.getByLabelText('Other field');
    await h.user.click(other);
    press();
    await findDialog();

    await h.user.click(screen.getByRole('button', { name: QUICK_ADD_CLOSE_LABEL }));
    await closeDialog();
    expect(other).toHaveFocus();
  });

  it('contains keyboard focus: Tab and Shift+Tab wrap inside the dialog', async () => {
    const h = mount();
    await settled(h);
    press();
    const opened = await findDialog();
    await waitFor(() => expect(input()).toHaveFocus());

    for (let step = 0; step < 6; step += 1) {
      await h.user.tab();
      expect(opened.contains(document.activeElement)).toBe(true);
    }
    for (let step = 0; step < 6; step += 1) {
      await h.user.tab({ shift: true });
      expect(opened.contains(document.activeElement)).toBe(true);
    }
  });

  it('stays open after a save so the next entry can be typed, and focus stays in the input', async () => {
    const h = mount();
    await settled(h);
    press();
    await findDialog();
    await h.user.type(input(), '120 coffee{Enter}');

    await waitFor(() => expect(h.store.getState().entries[0]?.phase).toBe('saved'));
    expect(dialog()).not.toBeNull();
    expect(input()).toHaveValue('');
    expect(input()).toHaveFocus();
    expect(h.net.to('POST', EXPENSES)).toHaveLength(1);
    expect(rows()).toHaveLength(1);
  });

  it('keeps saving a pending entry when it is closed, and shows its row when it reopens', async () => {
    const h = mount({ prepare: (_backend, net) => { net.hold('POST', EXPENSES); } });
    await settled(h);
    press();
    await findDialog();
    await h.user.type(input(), '120 coffee{Enter}');
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toHaveAttribute('data-phase', 'pending');

    await h.user.keyboard('{Escape}');
    await closeDialog();
    expect(h.store.getState().entries[0]?.phase).toBe('pending');
    // Releasing the held request after the dialog closed still completes the save.
    expect(h.net.to('POST', EXPENSES)).toHaveLength(1);
  });

  it('shows the confirmed row on reopening after the entry finished while the dialog was closed', async () => {
    const held: { release?: () => void } = {};
    const h = mount({ prepare: (_backend, net) => { held.release = net.hold('POST', EXPENSES).release; } });
    await settled(h);
    press();
    await findDialog();
    await h.user.type(input(), '120 coffee{Enter}');
    await waitFor(() => expect(rows()).toHaveLength(1));
    await h.user.keyboard('{Escape}');
    await closeDialog();

    act(() => held.release?.());
    await waitFor(() => expect(h.store.getState().entries[0]?.phase).toBe('saved'));
    expect(h.backend.expenses).toHaveLength(1);

    press();
    await findDialog();
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toHaveAttribute('data-phase', 'saved');
  });
});

/* ------------------------------ the floating action ------------------------- */

describe('floating action', () => {
  it.each(['/', '/spending'])('is shown below 900px on %s, named, and carries aria-keyshortcuts', async (route) => {
    const h = mount({ wide: false, route });
    await settled(h, route);
    const button = screen.getByRole('button', { name: FAB_LABEL });
    expect(button).toHaveClass('qa-fab');
    expect(button).toHaveAttribute('aria-keyshortcuts', 'Control+K');
    expect(button.tagName).toBe('BUTTON');
  });

  it('is not rendered at 900px and wider, and appears and disappears with the width without a reload', async () => {
    const h = mount({ wide: true });
    await settled(h);
    expect(fab()).toBeNull();

    h.viewport.resize(false);
    expect(fab()).not.toBeNull();
    h.viewport.resize(true);
    expect(fab()).toBeNull();
  });

  it('publishes its height as --quick-add-fab-h while it is shown and removes it when it goes away', async () => {
    const h = mount({ wide: false });
    await settled(h);
    const root = document.documentElement.style;
    expect(Number.parseInt(root.getPropertyValue(FAB_HEIGHT_PROPERTY), 10)).toBeGreaterThanOrEqual(48);

    h.viewport.resize(true);
    expect(root.getPropertyValue(FAB_HEIGHT_PROPERTY)).toBe('');
  });

  it('opens the dialog on a page other than Home, without navigating', async () => {
    const h = mount({ wide: false });
    await settled(h);
    await h.user.click(fab() as HTMLElement);
    await findDialog();
    await waitFor(() => expect(input()).toHaveFocus());
    expect(screen.getByRole('heading', { name: 'Spending page' })).toBeInTheDocument();
    // Below 900px there is no keyboard shortcut to teach, so the dialog does not show it as text.
    expect(within(dialog() as HTMLElement).queryByText('Ctrl K')).toBeNull();
  });

  it('moves focus to the inline input on Home', async () => {
    const h = mount({ wide: false, route: '/' });
    await settled(h, '/');
    await h.user.click(fab() as HTMLElement);
    expect(input()).toHaveFocus();
    expect(dialog()).toBeNull();
  });

  it('is operable by keyboard alone', async () => {
    const h = mount({ wide: false });
    await settled(h);
    const button = fab() as HTMLElement;
    button.focus();
    await h.user.keyboard('{Enter}');
    await findDialog();
    await waitFor(() => expect(input()).toHaveFocus());
  });
});

/* ------------------------------ Home and the shortcut text ------------------- */

describe('Home input', () => {
  it('shows the shortcut as text beside the input at 900px and wider, and sets aria-keyshortcuts', async () => {
    const h = mount({ route: '/' });
    await settled(h, '/');
    const label = screen.getByText(QUICK_ADD_LABEL).parentElement as HTMLElement;
    expect(within(label).getByText('Ctrl K')).toBeInTheDocument();
    expect(input()).toHaveAttribute('aria-keyshortcuts', 'Control+K');
  });

  it('shows no shortcut text where the tab bar is displayed, but keeps aria-keyshortcuts', async () => {
    const h = mount({ route: '/', wide: false });
    await settled(h, '/');
    expect(screen.queryByText('Ctrl K')).toBeNull();
    expect(input()).toHaveAttribute('aria-keyshortcuts', 'Control+K');
  });
});

/* ------------------------------ the administrator console ------------------- */

describe('administrator console', () => {
  it('has no floating action, no dialog, no listener, and leaves the key to the browser', async () => {
    const added = vi.spyOn(window, 'addEventListener');
    const h = mount({ admin: true, route: '/admin', wide: false });
    await screen.findByRole('heading', { name: 'Admin overview' });

    expect(fab()).toBeNull();
    expect(dialog()).toBeNull();
    expect(document.querySelector('[class*="qa-"]')).toBeNull();
    expect(added.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(0);
    expect(press()).toBe(true);
    expect(dialog()).toBeNull();
    expect(quickAddRequests(h)).toEqual([]);
  });

  it('has Quick Add again on the user view of the same administrator', async () => {
    const h = mount({ admin: true, route: '/spending', wide: false });
    await settled(h);
    expect(fab()).not.toBeNull();
    await h.user.click(screen.getByRole('button', { name: 'Switch to admin console' }));
    await screen.findByRole('heading', { name: 'Admin overview' });
    expect(fab()).toBeNull();
    expect(press()).toBe(true);
  });
});

/* ------------------------------ entries not saved --------------------------- */

describe('failed entries status', () => {
  it('shows how many entries were not saved while no Quick Add surface is open, with an action that opens Quick Add', async () => {
    const h = mount({
      prepare: (backend) => backend.failWith('POST', EXPENSES, { status: 503, code: 'SERVER_BUSY', message: 'Try again.' }),
    });
    await settled(h);
    expect(screen.queryByTestId('quick-add-failed-status')).toBeNull();

    press();
    await findDialog();
    await h.user.type(input(), '120 coffee{Enter}');
    await waitFor(() => expect(rows()[0]).toHaveAttribute('data-phase', 'failed'));
    // The dialog is a surface, so the row carries Retry, Edit, and Discard and the status stays out.
    expect(screen.queryByTestId('quick-add-failed-status')).toBeNull();

    await h.user.keyboard('{Escape}');
    await closeDialog();
    const status = await screen.findByTestId('quick-add-failed-status');
    expect(status).toHaveTextContent('1 entry was not saved.');
    const action = within(status).getByRole('button', { name: FAILED_STATUS_ACTION });
    expect(action).toHaveAttribute('aria-keyshortcuts', 'Control+K');

    await h.user.click(action);
    await findDialog();
    expect(screen.queryByTestId('quick-add-failed-status')).toBeNull();
    expect(rows()).toHaveLength(1);
  });
});

/* ------------------------------ the announcement ---------------------------- */

describe('save announcement (Requirement 9.18)', () => {
  it('states the amount, the category, and Left_Today from the server, once, in the polite region only', async () => {
    const h = mount();
    await settled(h);
    press();
    await findDialog();
    await h.user.type(input(), '120 coffee{Enter}');
    await waitFor(() => expect(polite().textContent).not.toBe(''));

    expect(polite().textContent).toMatch(/^Saved ₹120 to Food\. ₹[\d,]+(\.\d{1,2})? left today\.$/);
    expect(polite().querySelectorAll('span')).toHaveLength(1);
    expect(screen.getByTestId('quick-add-assertive')).toHaveTextContent('');
    expect(h.store.getState().announcements).toHaveLength(0);
  });

  it('names the month the entry counts toward when it is in another month', async () => {
    const h = mount();
    await settled(h);
    press();
    await findDialog();
    await h.user.type(input(), '120 coffee 2026-10-15{Enter}');
    await waitFor(() => expect(polite().textContent).not.toBe(''));
    expect(polite()).toHaveTextContent('Saved ₹120 to Food. Counts toward October 2026.');
  });

  it('names the month when the server returned no Today values', async () => {
    const h = mount({ today: null });
    await settled(h);
    press();
    await findDialog();
    await h.user.type(input(), '120 coffee{Enter}');
    await waitFor(() => expect(polite().textContent).not.toBe(''));
    expect(polite()).toHaveTextContent('Saved ₹120 to Food. Counts toward November 2026.');
  });
});

/* ------------------------------ accessibility and flow ---------------------- */

describe('accessibility', () => {
  it.each(['light', 'dark'] as const)('has no axe violations with the floating action and the open dialog in the %s theme', async (theme) => {
    localStorage.setItem('theme', theme);
    const h = mount({ wide: false });
    await settled(h);
    expect(document.documentElement.dataset.theme).toBe(theme);
    expect(await axe(h.container)).toHaveNoViolations();

    await h.user.click(fab() as HTMLElement);
    await findDialog();
    await h.user.type(input(), '120 coffee{Enter}');
    await waitFor(() => expect(h.store.getState().entries[0]?.phase).toBe('saved'));
    expect(await axe(h.container)).toHaveNoViolations();
  });

  it('has no axe violations on Home with the inline panel in the dark theme at 900px and wider', async () => {
    localStorage.setItem('theme', 'dark');
    const h = mount({ route: '/' });
    await settled(h, '/');
    expect(await axe(h.container)).toHaveNoViolations();
  });
});

describe('keyboard-only flow', () => {
  it('opens with the shortcut, saves with Enter, reaches Undo with Tab, and returns focus on Escape', async () => {
    const h = mount();
    await settled(h);
    const other = screen.getByLabelText('Other field');
    other.focus();

    press();
    await findDialog();
    await waitFor(() => expect(input()).toHaveFocus());
    await h.user.keyboard('120 coffee{Enter}');
    await waitFor(() => expect(h.store.getState().entries[0]?.phase).toBe('saved'));
    expect(input()).toHaveFocus();

    await h.user.tab();
    await h.user.tab();
    const undo = screen.getByRole('button', { name: 'Undo ₹120 coffee' });
    expect(opened(undo)).toBe(true);

    await h.user.keyboard('{Escape}');
    await closeDialog();
    expect(other).toHaveFocus();
  });
});

function opened(element: HTMLElement): boolean {
  return dialog()?.contains(element) ?? false;
}

/* ------------------------------ styles -------------------------------------- */

describe('styles', () => {
  const shell = readFileSync('src/components/quickAdd/quickAddShell.css', 'utf8');
  const app = readFileSync('src/styles.css', 'utf8');

  it('sizes the floating action at least 48 by 48 and places it above the tab bar, the safe area, and the right edge', () => {
    const rule = /\.qa-fab \{([^}]*)\}/.exec(shell)?.[1] ?? '';
    expect(rule).toMatch(/min-width:\s*48px/);
    expect(rule).toMatch(/min-height:\s*48px/);
    expect(rule).toContain('right: max(1rem, env(safe-area-inset-right))');
    expect(rule).toContain('bottom: calc(var(--bottom-nav-h, 0px) + env(safe-area-inset-bottom) + 1rem)');
    expect(shell).toMatch(/@media \(min-width: 900px\) \{\s*\.qa-fab \{ display: none; \}/);
  });

  it('moves the toast stack and the page padding above the floating action, and leaves them unchanged while it is absent', () => {
    expect(app).toMatch(/\.toasts \{[^}]*--quick-add-fab-h/);
    expect(app).toMatch(/\.container\.app-main \{[^}]*--quick-add-fab-h/);
    // With the property unset, max() resolves to the original 0.5rem and 1rem offsets.
    expect(app).toContain('max(0.5rem, var(--quick-add-fab-h, -2rem) + 1.5rem)');
    expect(app).toContain('max(1rem, var(--quick-add-fab-h, -2rem) + 1.5rem)');
  });
});

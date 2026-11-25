// Accessibility of Quick Add and the Home headline in jsdom (task 16.2; Requirements 1.2, 1.3, 1.14, 11.5, 12.1 to 12.15).
//
// The pieces have their own axe runs (quickAddUi, quickAddEntries, quickAddFlows, Shell.quickAddHost, TodayHeadline,
// categoryMemoryPanel, Settings.quickAdd). This file adds what none of them covers on its own:
//
// - one axe sweep over the real Shell with the headline, input, preview, warning, a failed row, a saved row, and the
//   answer on the page at once, on Home and in the dialog, in both themes, and axe on each of those surfaces alone,
// - one keyboard-only run through typing, choosing a category, saving, Retry, Edit, Discard, Undo, and closing,
// - the Tab order against the reading order, focus containment in the dialog with every control present, and no
//   positive tabindex anywhere,
// - focus that stays on the active control while the preview, the answer, and the headline change underneath it,
// - the colours the Quick Add stylesheets mix (tints over the page and the card) at 4.5:1 in both themes, and
//   stylesheet rules that keep 320 pixels and 200 percent text free of sideways scrolling and clipping.
//
// jsdom has no layout and axe cannot measure colour here, so the rendered colour, the layout from 320 to 3840 CSS pixels,
// and the 200 percent text run are measured in a real browser by e2e/quickAdd.a11y.quickadd.spec.ts.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DataUseGateProvider, PROMISE_RENDERED_KEY } from '../../clarity/DataUseGateProvider';
import { FinancialClarityProvider } from '../../clarity/FinancialClarityProvider';
import { MutationStatusProvider } from '../../clarity/MutationStatusProvider';
import { BUILT_IN_CATEGORIES } from '../../clarity/quickAdd/keywordRules';
import { resetServerTimeOffset } from '../../clarity/quickAdd/kolkata';
import { QuickAddProvider } from '../../clarity/quickAdd/QuickAddProvider';
import { createQuickAddStore, type QuickAddStore } from '../../clarity/quickAdd/quickAddStore';
import { Dashboard } from '../../pages/Dashboard';
import { buildSettings } from '../../test/claritySettingsBuilder';
import { FakeQuickAddBackend } from '../../test/fakeQuickAddBackend';
import type { SpendingBackendReply, SpendingBackendRequest } from '../../test/fakeSpendingBackend';
import { installSpendingFetch, type SpendingFetch } from '../../test/fakeSpendingFetch';
import { resetSharedMemoryClient } from '../../test/settingsMemoryServer';
import { axe, createTestQueryClient, createTestUser, renderAuthenticated } from '../../test/test-utils';
import { Shell } from '../Shell';
import { QUICK_ADD_DIALOG_TITLE } from './QuickAddDialog';
import { ANSWER_TITLE } from './EntryAnswer';
import { SAVE_WITHOUT_COUNTING_LABEL } from './EntryWarning';
import { FAB_HEIGHT_PROPERTY, FAB_LABEL } from './QuickAddFab';
import { QUICK_ADD_LABEL } from './QuickAddInput';

const MONTH = '2026-11';
const TODAY = '2026-11-18';
const NOW = Date.parse('2026-11-18T06:30:00.000Z');
const EXPENSES = '/finance/expenses';
const HINTS = '/finance/quick-add/hints';

/** Everything the dialog's focus handling treats as a stop, which is also what a keyboard can reach there. */
const TABBABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

class A11yBackend extends FakeQuickAddBackend {
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
type Layout = 'home' | 'dialog';

interface Harness {
  user: ReturnType<typeof userEvent.setup>;
  backend: A11yBackend;
  net: SpendingFetch;
  store: QuickAddStore;
  container: HTMLElement;
}

/**
 * `home` is 1440 CSS pixels on Home with the inline panel. `dialog` is 390 CSS pixels on another page with the floating
 * action, so Quick Add opens in the dialog.
 */
function mount(layout: Layout, prepare?: (backend: A11yBackend, net: SpendingFetch) => void): Harness {
  vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'true');
  vi.stubEnv('VITE_QUICK_ADD_ENABLED', 'true');
  sessionStorage.setItem(PROMISE_RENDERED_KEY, '4242');
  const width = layout === 'home' ? 1440 : 390;
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
  Object.defineProperty(window.navigator, 'platform', { value: 'Win32', configurable: true });
  const backend = new A11yBackend(MONTH, { categories: [...BUILT_IN_CATEGORIES] });
  backend.todayDate = TODAY;
  const net = installSpendingFetch(backend);
  prepare?.(backend, net);
  const store = createQuickAddStore();
  const view = renderAuthenticated(
    <FinancialClarityProvider>
      <MutationStatusProvider>
        <QuickAddProvider store={store}>
          <Routes>
            <Route element={<DataUseGateProvider><Shell /></DataUseGateProvider>}>
              <Route path="/" element={<Dashboard />} />
              <Route
                path="/spending"
                element={<><h1>Spending page</h1><button type="button">Page button</button></>}
              />
            </Route>
          </Routes>
        </QuickAddProvider>
      </MutationStatusProvider>
    </FinancialClarityProvider>,
    { route: layout === 'home' ? '/' : '/spending', queryClient: createTestQueryClient(), user: createTestUser() },
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
  Object.defineProperty(window, 'innerWidth', { value: ORIGINAL_INNER_WIDTH, configurable: true, writable: true });
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.style.removeProperty(FAB_HEIGHT_PROPERTY);
  document.documentElement.style.removeProperty('--bottom-nav-h');
});

const input = () => screen.getByLabelText(QUICK_ADD_LABEL) as HTMLInputElement;
const dialog = () => screen.queryByRole('dialog', { name: QUICK_ADD_DIALOG_TITLE });
const headline = () => screen.getByTestId('today-headline');
const rows = () => [...document.querySelectorAll<HTMLElement>('li.qa-entry')];
const categoryChoice = () => screen.getByLabelText('Category', { selector: '.qa-preview select' }) as HTMLSelectElement;
const phases = (h: Harness) => h.store.getState().entries.map((entry) => entry.phase);
const failure = { status: 500, code: 'INTERNAL_ERROR', message: 'The server had a problem.' };

/** The page is up. On Home that includes the headline value and the hints. */
async function ready(h: Harness, layout: Layout) {
  if (layout === 'home') {
    await screen.findByRole('article', { name: /Remaining to spend/ });
    await within(headline()).findByText(/You can spend/);
    await waitFor(() => expect(h.net.to('GET', HINTS).length).toBeGreaterThan(0));
  } else {
    await screen.findByRole('heading', { name: 'Spending page' });
  }
  await waitFor(() => expect(h.net.to('GET', '/clarity/settings').length).toBeGreaterThan(0));
}

/** Opens the dialog with the shortcut, which is what a keyboard user does, and waits for the input to have focus. */
async function openDialog(h: Harness) {
  await h.user.keyboard('{Control>}k{/Control}');
  await screen.findByRole('dialog', { name: QUICK_ADD_DIALOG_TITLE });
  await waitFor(() => expect(input()).toHaveFocus());
}

/** Presses Tab (or Shift+Tab) until the target has focus. Fails if it is not reached within a full lap. */
async function tabTo(h: Harness, target: HTMLElement, shift = false) {
  for (let step = 0; step < 40 && document.activeElement !== target; step += 1) await h.user.tab({ shift });
  expect(document.activeElement).toBe(target);
}

async function enter(h: Harness, line: string) {
  await h.user.type(input(), `${line}{Enter}`);
}

/** Puts every surface on screen at once: a failed row, a saved row with its answer, and a warning for the typed line. */
async function composeEverything(h: Harness, layout: Layout) {
  await ready(h, layout);
  if (layout === 'dialog') await openDialog(h);
  await enter(h, '10 tea');
  await waitFor(() => expect(phases(h)).toEqual(['failed']));
  await enter(h, '20 chai');
  await waitFor(() => expect(phases(h)).toEqual(['failed', 'saved']));
  await waitFor(() => expect(document.querySelector('.qa-answer')).not.toBeNull());
  await h.user.type(input(), '1500 laptop');
  await screen.findByRole('button', { name: SAVE_WITHOUT_COUNTING_LABEL });
}

/* ------------------------------------ axe ----------------------------------- */

describe.each([
  ['light', 'home'],
  ['dark', 'home'],
  ['light', 'dialog'],
  ['dark', 'dialog'],
] as const)('axe in the %s theme, %s layout', (theme, layout) => {
  it('has no violations on the whole page or on any Quick Add surface, with every surface on screen at once', async () => {
    localStorage.setItem('theme', theme);
    const h = mount(layout, (backend) => backend.failWith('POST', EXPENSES, failure));
    await composeEverything(h, layout);
    expect(document.documentElement.dataset.theme).toBe(theme);

    const scope = layout === 'dialog' ? (dialog() as HTMLElement) : document.body;
    const find = (selector: string) => scope.querySelector<HTMLElement>(selector);
    const surfaces: Array<[string, HTMLElement | null]> = [
      ['input panel', find('.qa-input')],
      ['preview', find('.qa-preview')],
      ['warning', find('.qa-warning')],
      ['failed status row', find('li.qa-entry[data-phase="failed"]')],
      ['saved status row', find('li.qa-entry[data-phase="saved"]')],
      ['answer', find('.qa-answer')],
      ...(layout === 'home' ? ([['headline', headline()]] as Array<[string, HTMLElement | null]>) : []),
    ];
    for (const [name, element] of surfaces) {
      expect(element, `${name} is on screen`).not.toBeNull();
      expect(await axe(element as HTMLElement), name).toHaveNoViolations();
    }
    expect(await axe(h.container)).toHaveNoViolations();
    expect(await axe(document.body)).toHaveNoViolations();
  });

  it('keeps status in text beside the color or glyph on every row (Requirements 12.8, 11.5)', async () => {
    localStorage.setItem('theme', theme);
    const h = mount(layout, (backend) => backend.failWith('POST', EXPENSES, failure));
    await composeEverything(h, layout);
    for (const row of rows()) {
      const status = row.querySelector('.qa-entry-status');
      expect(status?.textContent?.trim(), `status text of the ${row.dataset.phase} row`).toBeTruthy();
    }
    const failed = rows().find((row) => row.dataset.phase === 'failed') as HTMLElement;
    expect(failed).toHaveTextContent('Not saved');
    if (layout === 'home') {
      // The headline says what it means in words: the figure, the label, and the text for the over state.
      expect(headline()).toHaveTextContent(/You can spend/);
      expect(headline()).toHaveTextContent(/left today/i);
    }
  });
});

/* ------------------------------ keyboard-only flow --------------------------- */

describe('keyboard-only operation (Requirements 12.4, 1.10, 12.6)', () => {
  it('types, chooses a category, saves, retries, edits, discards, undoes, and closes without a pointer', async () => {
    // The first save fails and is retried. Two more failures are queued later, for Edit and for Discard.
    const h = mount('dialog', (backend) => {
      backend.failWith('POST', EXPENSES, failure);
    });
    await ready(h, 'dialog');
    const opener = screen.getByRole('button', { name: 'Page button' });
    opener.focus();
    await openDialog(h);

    // Typing, then choosing a category. The control is a native select, so the browser's own keyboard handling changes
    // it, and jsdom has none, so the change event it would send is sent here.
    await h.user.keyboard('120 coffee');
    const select = categoryChoice();
    expect(select.tagName).toBe('SELECT');
    await tabTo(h, select);
    fireEvent.change(select, { target: { value: 'Transport' } });
    expect(select).toHaveValue('Transport');
    await tabTo(h, input(), true);
    await h.user.keyboard('{Enter}');
    await waitFor(() => expect(phases(h)).toEqual(['failed']));
    expect(h.net.to('POST', EXPENSES)[0]?.body).toMatchObject({ amountMinor: 12000, category: 'Transport', note: 'coffee' });
    expect(input()).toHaveFocus();

    // Retry, by Tab and Enter.
    await tabTo(h, screen.getByRole('button', { name: /^Retry saving/ }));
    await h.user.keyboard('{Enter}');
    await waitFor(() => expect(phases(h)).toEqual(['saved']));
    const posts = h.net.to('POST', EXPENSES);
    expect(posts).toHaveLength(2);
    expect(posts[1]?.headers['idempotency-key']).toBe(posts[0]?.headers['idempotency-key']);
    expect(h.backend.expenses).toHaveLength(1);

    // Edit: the failed entry comes back into the empty input, and the next save is a new entry.
    h.backend.failWith('POST', EXPENSES, failure);
    await tabTo(h, input(), true);
    await enter(h, '50 tea');
    await waitFor(() => expect(phases(h)).toEqual(['saved', 'failed']));
    await tabTo(h, screen.getByRole('button', { name: /^Edit/ }));
    await h.user.keyboard('{Enter}');
    expect(input()).toHaveValue(`₹50 ${TODAY} "tea"`);
    expect(input()).toHaveFocus();
    await h.user.keyboard('{Enter}');
    await waitFor(() => expect(phases(h)).toEqual(['saved', 'saved']));
    expect(h.backend.expenses).toHaveLength(2);

    // Discard.
    h.backend.failWith('POST', EXPENSES, failure);
    await enter(h, '70 snack');
    await waitFor(() => expect(phases(h)).toEqual(['saved', 'saved', 'failed']));
    await tabTo(h, screen.getByRole('button', { name: /^Discard/ }));
    await h.user.keyboard('{Enter}');
    await waitFor(() => expect(phases(h)).toEqual(['saved', 'saved']));
    expect(h.backend.expenses).toHaveLength(2);
    // Discard moves focus to the next row (here the Undo control of the saved entry) and never drops it to the page.
    const undo = screen.getByRole('button', { name: 'Undo ₹50 tea' });
    expect(undo).toHaveFocus();

    // Undo the newest saved entry.
    await tabTo(h, undo);
    await h.user.keyboard('{Enter}');
    await waitFor(() => expect(phases(h)).toContain('undone'));
    expect(h.backend.expenses).toHaveLength(1);

    // Closing: Escape returns focus to the control that had it before the dialog opened.
    await h.user.keyboard('{Escape}');
    await waitFor(() => expect(dialog()).toBeNull());
    expect(opener).toHaveFocus();
  });

  it('opens from the floating action by keyboard and reaches it by Tab on a page with a tab bar', async () => {
    const h = mount('dialog');
    await ready(h, 'dialog');
    const fab = screen.getByRole('button', { name: FAB_LABEL });
    await tabTo(h, fab);
    await h.user.keyboard('{Enter}');
    await screen.findByRole('dialog', { name: QUICK_ADD_DIALOG_TITLE });
    await waitFor(() => expect(input()).toHaveFocus());
    await h.user.keyboard('{Escape}');
    await waitFor(() => expect(dialog()).toBeNull());
    expect(fab).toHaveFocus();
  });
});

/* ------------------------- focus order and containment ----------------------- */

function tabbablesIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter((element) => !element.closest('[aria-hidden="true"], [hidden]'));
}

/** The elements that hold focus on each of `count` presses of Tab, starting from the current focus. */
async function stopsAfter(h: Harness, count: number, shift = false): Promise<Element[]> {
  const stops: Element[] = [];
  for (let step = 0; step < count; step += 1) {
    await h.user.tab({ shift });
    stops.push(document.activeElement as Element);
  }
  return stops;
}

describe('focus order and containment (Requirements 12.5, 12.6)', () => {
  it('moves through the dialog in the order the controls appear, and wraps inside it in both directions', async () => {
    const h = mount('dialog', (backend) => backend.failWith('POST', EXPENSES, failure));
    await composeEverything(h, 'dialog');
    const box = dialog() as HTMLElement;
    const stops = tabbablesIn(box);
    // The close button, the input, Save, the category, both warning buttons, and the controls of both rows are all there.
    expect(stops.length).toBeGreaterThanOrEqual(9);
    const domOrder = [...stops];
    const start = domOrder.indexOf(input());
    const expectedForward = [...domOrder.slice(start + 1), ...domOrder.slice(0, start + 1)];
    const forward = await stopsAfter(h, domOrder.length);
    expect(forward.map(label)).toEqual(expectedForward.map(label));
    for (const stop of forward) expect(box.contains(stop), `${label(stop)} is inside the dialog`).toBe(true);
    // A second lap lands on the same stops: nothing escapes to the page behind.
    expect((await stopsAfter(h, domOrder.length)).map(label)).toEqual(expectedForward.map(label));

    const backward = await stopsAfter(h, domOrder.length, true);
    // Shift+Tab from the input visits the controls before it, wraps to the last one, and ends on the input again.
    const expectedBackward = [...domOrder.slice(0, start).reverse(), ...domOrder.slice(start).reverse()];
    expect(backward.map(label)).toEqual(expectedBackward.map(label));
    for (const stop of backward) expect(box.contains(stop)).toBe(true);
  });

  it('follows the reading order on Home too: the stops of the page are in document order from top to bottom', async () => {
    const h = mount('home', (backend) => backend.failWith('POST', EXPENSES, failure));
    await composeEverything(h, 'home');
    const main = document.querySelector('main') as HTMLElement;
    const stops = tabbablesIn(main);
    input().focus();
    const start = stops.indexOf(input());
    const forward = await stopsAfter(h, stops.length - start - 1);
    expect(forward.map(label)).toEqual(stops.slice(start + 1).map(label));
    // The panel's own controls come after the input and before the quick actions, as Requirement 1.1 orders them.
    const preview = main.querySelector('.qa-preview') as HTMLElement;
    const actions = screen.getByRole('navigation', { name: 'Quick actions' });
    expect(Boolean(preview.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  });

  it('uses no positive tabindex and no tabindex on a static element of Quick Add or the headline', async () => {
    const h = mount('home', (backend) => backend.failWith('POST', EXPENSES, failure));
    await composeEverything(h, 'home');
    for (const element of document.querySelectorAll<HTMLElement>('[tabindex]')) {
      expect(Number(element.getAttribute('tabindex')), label(element)).toBeLessThanOrEqual(0);
    }
    const region = [headline(), ...document.querySelectorAll<HTMLElement>('.qa-input, .qa-preview, .qa-warning, .qa-entries, .qa-answer')];
    for (const root of region) {
      for (const element of root.querySelectorAll<HTMLElement>('[tabindex="0"]')) {
        expect(element.matches('a, button, input, select, textarea, summary, [role="button"]'), `${label(element)} is not a control`).toBe(true);
      }
    }
  });
});

function label(element: Element): string {
  const label = element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 24) ?? '';
  return `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''} "${label}"`;
}

/* ---------------------------- focus retention (12.13) ------------------------ */

describe('focus stays on the active control while values change (Requirement 12.13)', () => {
  it('keeps focus on the category control while an earlier entry confirms, the answer appears, and the headline changes', async () => {
    const h = mount('home');
    await ready(h, 'home');
    const gate = h.net.holdResponse('POST', EXPENSES);
    await enter(h, '100 coffee');
    await waitFor(() => expect(phases(h)).toEqual(['pending']));
    await h.user.type(input(), '200 lunch');
    const select = categoryChoice();
    await tabTo(h, select);
    const headlineBefore = headline().textContent;
    act(() => gate.release());
    await waitFor(() => expect(phases(h)).toEqual(['saved']));
    await screen.findByRole('region', { name: ANSWER_TITLE });
    await waitFor(() => expect(headline().textContent).not.toBe(headlineBefore));
    expect(document.activeElement).toBe(select);
    expect(categoryChoice()).toBe(select);
    expect(input()).toHaveValue('200 lunch');
  });

  it('keeps focus on the category control when the saved hints replace the suggestion under it', async () => {
    let release!: () => void;
    const h = mount('home', (backend, net) => {
      backend.seedMemory('coffee', 'Transport');
      release = net.hold('GET', HINTS).release;
    });
    await screen.findByRole('article', { name: /Remaining to spend/ });
    await h.user.type(input(), '120 coffee');
    const select = categoryChoice();
    await tabTo(h, select);
    expect(select).toHaveValue('Food');
    act(() => release());
    await waitFor(() => expect(categoryChoice()).toHaveValue('Transport'));
    expect(document.activeElement).toBe(select);
    expect(categoryChoice()).toBe(select);
  });

  it('keeps focus on the Undo control of an earlier row while a newer entry joins the list above it and replaces the answer', async () => {
    const h = mount('home');
    await ready(h, 'home');
    await enter(h, '40 tea');
    await waitFor(() => expect(phases(h)).toEqual(['saved']));
    const undo = screen.getByRole('button', { name: 'Undo ₹40 tea' });
    const gate = h.net.holdResponse('POST', EXPENSES);
    await enter(h, '60 chai');
    await waitFor(() => expect(phases(h)).toEqual(['saved', 'pending']));
    await tabTo(h, undo);
    const answerBefore = document.querySelector('.qa-answer')?.textContent;
    act(() => gate.release());
    await waitFor(() => expect(phases(h)).toEqual(['saved', 'saved']));
    await waitFor(() => expect(document.querySelector('.qa-answer')?.textContent).not.toBe(answerBefore));
    expect(document.activeElement).toBe(undo);
    expect(screen.getByRole('button', { name: 'Undo ₹40 tea' })).toBe(undo);
  });
});

/* ------------------------------ stylesheets: colors -------------------------- */

const SHEETS = [
  'src/components/quickAdd/quickAdd.css',
  'src/components/quickAdd/quickAddEntries.css',
  'src/components/quickAdd/quickAddShell.css',
  'src/components/dashboard/todayHeadline.css',
  'src/components/clarity/categoryMemory.css',
].map((path) => ({ path, source: readFileSync(path, 'utf8') }));
const appSheet = readFileSync('src/styles.css', 'utf8');
const claritySheet = readFileSync('src/components/clarity/clarity.css', 'utf8');

type Rgba = [number, number, number, number];

/** The custom properties of every rule that starts a line with exactly this selector. */
function tokensOf(source: string, selector: string): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (let start = source.indexOf(`\n${selector} {`); start >= 0; start = source.indexOf(`\n${selector} {`, start + 1)) {
    const end = source.indexOf('}', start);
    for (const match of source.slice(start, end).matchAll(/(--[\w-]+):\s*([^;]+);/g)) tokens[match[1]!] = match[2]!.trim();
  }
  return tokens;
}

const THEME_TOKENS = {
  dark: {
    ...tokensOf(appSheet, ':root'),
    ...tokensOf(claritySheet, ':root'),
    ...tokensOf(claritySheet, ":root:not([data-theme='light']):has(main.clarity-on)"),
  },
  light: {
    ...tokensOf(appSheet, ':root'),
    ...tokensOf(appSheet, ":root[data-theme='light']"),
    ...tokensOf(claritySheet, ':root'),
    ...tokensOf(claritySheet, ":root[data-theme='light']"),
    ...tokensOf(claritySheet, ":root[data-theme='light']:has(main.clarity-on)"),
  },
} as const;

function parseColor(value: string, tokens: Record<string, string>): Rgba {
  const trimmed = value.trim();
  const reference = /^var\((--[\w-]+)(?:,\s*(.+))?\)$/.exec(trimmed);
  if (reference) {
    const token = tokens[reference[1]!] ?? reference[2];
    if (token === undefined) throw new Error(`${reference[1]} has no value`);
    return parseColor(token, tokens);
  }
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(trimmed);
  if (hex) {
    const digits = hex[1]!.length === 3 ? [...hex[1]!].map((d) => d + d).join('') : hex[1]!;
    return [0, 2, 4].map((offset) => parseInt(digits.slice(offset, offset + 2), 16)).concat(1) as Rgba;
  }
  const rgb = /^rgba?\(([^)]+)\)$/.exec(trimmed);
  if (rgb) {
    const [r, g, b, a] = rgb[1]!.split(',').map((part) => parseFloat(part));
    return [r!, g!, b!, a ?? 1];
  }
  throw new Error(`Cannot read the color "${value}"`);
}
const over = (top: Rgba, bottom: Rgba): Rgba => {
  const alpha = top[3] + bottom[3] * (1 - top[3]);
  const mix = (a: number, b: number) => (a * top[3] + b * bottom[3] * (1 - top[3])) / alpha;
  return [mix(top[0], bottom[0]), mix(top[1], bottom[1]), mix(top[2], bottom[2]), alpha];
};
const channel = (value: number) => {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = (c: Rgba) => 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
function ratio(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Every `color-mix(in srgb, <token> N%, transparent)` the Quick Add and headline sheets use as a tint or a track. */
const TINTS = SHEETS.flatMap(({ path, source }) => [...source.matchAll(/color-mix\(in srgb,\s*var\((--[\w-]+)(?:,\s*[^)]+)?\)\s*(\d+)%,\s*transparent\)/g)]
  .map((match) => ({ path, token: match[1]!, percent: Number(match[2]) })));

describe.each(['light', 'dark'] as const)('Quick Add colors, %s theme (Requirement 12.9)', (theme) => {
  const tokens = THEME_TOKENS[theme];
  const page = parseColor('var(--bg)', tokens);
  const card = over(parseColor('var(--glass)', tokens), page);
  const surfaces = { page, card } as const;

  it('finds the tints the stylesheets mix, so the checks below are not empty', () => {
    expect(TINTS.length).toBeGreaterThanOrEqual(5);
    expect(new Set(TINTS.map((tint) => tint.token))).toContain('--clarity-warn');
    expect(new Set(TINTS.map((tint) => tint.token))).toContain('--clarity-danger');
  });

  it('keeps the text color at 4.5:1 on every tint over the page and over the card', () => {
    for (const tint of TINTS) {
      for (const [name, surface] of Object.entries(surfaces)) {
        const tone = parseColor(`var(${tint.token})`, tokens);
        const mixed = over([tone[0], tone[1], tone[2], tint.percent / 100], surface);
        for (const text of ['--text']) {
          const value = ratio(parseColor(`var(${text})`, tokens), mixed);
          expect(value, `${text} on ${tint.token} ${tint.percent}% over the ${name} (${tint.path})`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it('keeps the focus ring at 3:1 on every tint, and the Undo bar fill at 3:1 against its track', () => {
    for (const tint of TINTS) {
      for (const [name, surface] of Object.entries(surfaces)) {
        const tone = parseColor(`var(${tint.token})`, tokens);
        const mixed = over([tone[0], tone[1], tone[2], tint.percent / 100], surface);
        expect(ratio(parseColor('var(--clarity-focus)', tokens), mixed), `focus ring on ${tint.token} over the ${name}`).toBeGreaterThanOrEqual(3);
      }
    }
    const info = parseColor('var(--clarity-info)', tokens);
    for (const [name, surface] of Object.entries(surfaces)) {
      const track = over([info[0], info[1], info[2], 0.18], surface);
      expect(ratio(info, track), `Undo bar on its track over the ${name}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('keeps the text and muted text of the panel, rows, answer, and headline at 4.5:1 on the page and the card', () => {
    for (const [name, surface] of Object.entries(surfaces)) {
      for (const token of ['--text', '--muted', '--clarity-danger', '--clarity-warn', '--clarity-ok', '--clarity-info']) {
        expect(ratio(parseColor(`var(${token})`, tokens), surface), `${token} on the ${name}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('keeps the field edge at 3:1 and the floating action fill at 4.5:1 for its text', () => {
    for (const [name, surface] of Object.entries(surfaces)) {
      expect(ratio(parseColor('var(--field-border, var(--muted))', tokens), surface), `field edge on the ${name}`).toBeGreaterThanOrEqual(3);
    }
    expect(ratio(parseColor('var(--bg)', tokens), parseColor('var(--clarity-info)', tokens))).toBeGreaterThanOrEqual(4.5);
  });
});

it('uses only theme tokens for color in the Quick Add and headline stylesheets', () => {
  for (const { path, source } of SHEETS) {
    const literals = [...source.matchAll(/(?:^|[;{\s])(color|background|background-color|border(?:-left|-color)?)\s*:\s*([^;}]*)/g)]
      .map((match) => match[2]!)
      .filter((value) => /#[0-9a-f]{3,8}\b|rgba?\(/i.test(value));
    expect(literals, `${path} has a literal color`).toEqual([]);
  }
});

/* --------------------- stylesheets: motion and reflow rules ------------------ */

/** The rules of a stylesheet outside any @media block, as [selector, body] pairs. */
function topLevelRules(source: string): Array<[string, string]> {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Array<[string, string]> = [];
  let depth = 0;
  let selector = '';
  let body = '';
  let skipBlock = false;
  for (const char of withoutComments) {
    if (char === '{') {
      depth += 1;
      if (depth === 1) skipBlock = /^\s*@/.test(selector);
      else if (depth > 1 && !skipBlock) body += char;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        if (!skipBlock) rules.push([selector.trim(), body]);
        selector = '';
        body = '';
        skipBlock = false;
      } else if (!skipBlock) body += char;
    } else if (depth === 0) {
      selector += char;
    } else if (!skipBlock) {
      body += char;
    }
  }
  return rules;
}

describe('stylesheet rules for reduced motion and reflow (Requirements 12.10, 12.11, 12.12)', () => {
  it('turns off every transition and animation under prefers-reduced-motion in each sheet that has one', () => {
    for (const { path, source } of SHEETS) {
      const animated = topLevelRules(source).filter(([, body]) => /(^|[;\s])(animation|animation-name|transition)\s*:/.test(body));
      if (animated.length === 0) continue;
      const reduced = [...source.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)].map((match) => match[1]).join('\n');
      expect(reduced, `${path} has a reduced-motion block`).toMatch(/animation: none !important|display: none/);
      expect(reduced, `${path} stops transitions`).toMatch(/transition: none !important/);
      // Every selector that animates is named in the reduced-motion block, directly or by a wildcard under its container.
      for (const [selector] of animated) {
        const root = selector.split(/[\s,>]+/)[0]!.replace(/[:[].*$/, '');
        expect(reduced.includes(root) || /\.qa-undo-bar|\.today-headline-fill/.test(reduced), `${path}: ${selector} is covered`).toBe(true);
      }
    }
  });

  it('keeps the dialog field edge rule above the light theme field rules in specificity (a 1.3:1 edge in the light dialog)', () => {
    const shell = SHEETS.find((sheet) => sheet.path.endsWith('quickAddShell.css'))!.source;
    const rule = /(:root \.qa-dialog-body :is\(input, select\)(?::not\(\[type='[a-z]+'\]\))+) \{ border-color: var\(--field-border, var\(--muted\)\); \}/.exec(shell);
    expect(rule, 'the dialog has its own field edge rule').not.toBeNull();
    // `:root[data-theme='light'] input:focus` is (0,3,1): :root, the attribute, :focus, and the element.
    const classes = 1 /* :root */ + 1 /* .qa-dialog-body */ + (rule![1]!.match(/:not\(/g) ?? []).length * 1;
    expect(classes).toBeGreaterThan(3);
    expect(appSheet).toMatch(/:root\[data-theme='light'\] input:focus,/);
  });

  it('gives no text container a fixed width, a clipped overflow, or an ellipsis, so 200 percent text at 320 pixels reflows', () => {
    for (const { path, source } of SHEETS) {
      for (const [selector, body] of topLevelRules(source)) {
        const where = `${path}: ${selector}`;
        expect(body, `${where} has a fixed width`).not.toMatch(/(^|[;\s])width\s*:\s*[\d.]+px/);
        // A bar clips its own fill, and the dialog backdrop scrolls vertically when the on-screen keyboard leaves it short.
        if (!/bar|track|modal-backdrop/.test(selector)) {
          expect(body, `${where} clips sideways`).not.toMatch(/overflow(-x)?\s*:\s*(hidden|scroll|auto|clip)/);
        }
        expect(body, `${where} truncates`).not.toMatch(/text-overflow/);
        if (/white-space\s*:\s*nowrap/.test(body)) expect(selector, `${where} does not wrap`).toMatch(/kbd/);
        const height = /(^|[;\s])height\s*:\s*[\d.]+px/.exec(body);
        if (height) expect(selector, `${where} has a fixed height`).toMatch(/bar|track|fill/);
      }
    }
  });
});

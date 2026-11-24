import { QueryClient } from '@tanstack/react-query';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FinancialSnapshot } from '../../clarity/contracts';
import { DataUseGateProvider, PROMISE_RENDERED_KEY } from '../../clarity/DataUseGateProvider';
import { FinancialClarityProvider } from '../../clarity/FinancialClarityProvider';
import { BUILT_IN_CATEGORIES } from '../../clarity/quickAdd/keywordRules';
import { resetServerTimeOffset } from '../../clarity/quickAdd/kolkata';
import { createMemoryClient, type MemoryClient } from '../../clarity/quickAdd/memoryClient';
import { QuickAddProvider } from '../../clarity/quickAdd/QuickAddProvider';
import { createQuickAddStore, type QuickAddStore } from '../../clarity/quickAdd/quickAddStore';
import { MutationStatusProvider } from '../../clarity/MutationStatusProvider';
import { buildSettings } from '../../test/claritySettingsBuilder';
import { FakeQuickAddBackend } from '../../test/fakeQuickAddBackend';
import { installSpendingFetch, type SpendingFetch } from '../../test/fakeSpendingFetch';
import type { SpendingBackendReply, SpendingBackendRequest } from '../../test/fakeSpendingBackend';
import { axe, createTestQueryClient, renderAuthenticated } from '../../test/test-utils';
import { CategoryChoice } from './CategoryChoice';
import { EntryWarning, SAVE_AND_COUNT_LABEL, SAVE_WITHOUT_COUNTING_LABEL } from './EntryWarning';
import { currentQuickAddInput, focusQuickAddInput, registerQuickAddInput } from './inputFocus';
import { LIMIT_HINT_FROM, QUICK_ADD_LABEL, QUICK_ADD_PLACEHOLDER } from './QuickAddInput';
import { ParsedPreview, QuickAddDraftProvider, QuickAddInput } from './index';
import { FORGET_DONE_TEXT, FORGET_FAILED_TEXT } from './QuickAddDraft';
import { HINTS_LOADING_TEXT, HINTS_UNAVAILABLE_TEXT, NOT_READY_TEXT } from './ParsedPreview';
import { RECURRING_HINT_TEXT, hasRecurringHint } from './recurringHint';
import { buildCategoryList, selectBillLabels, selectLargeEntryThreshold } from './useQuickAddContext';

const MONTH = '2026-11';
const TODAY = '2026-11-18';
const NOW = Date.parse('2026-11-18T06:30:00.000Z');
const CUSTOM = 'Pets';
const EXPENSES = '/finance/expenses';
const MEMORY = '/finance/category-memory';
const css = readFileSync('src/components/quickAdd/quickAdd.css', 'utf8');

/** The Spending fake plus the category list, the saved bills of the snapshot, and the data-use settings. */
class UiBackend extends FakeQuickAddBackend {
  billLabels: string[] = [];
  noticeAcknowledged = true;

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
    if (request.method.toUpperCase() === 'GET' && request.path === '/finance/categories') {
      return {
        status: 200,
        body: { defaults: [...BUILT_IN_CATEGORIES], custom: [{ id: 3, name: CUSTOM }] },
      };
    }
    if (request.method.toUpperCase() === 'GET' && request.path === '/clarity/settings') {
      return { status: 200, body: buildSettings({ acknowledgedVersion: this.noticeAcknowledged ? 1 : 0 }) };
    }
    return super.handle(request);
  }
}

interface Harness {
  user: ReturnType<typeof userEvent.setup>;
  backend: UiBackend;
  net: SpendingFetch;
  store: QuickAddStore;
  memory: MemoryClient;
  container: HTMLElement;
  input(): HTMLInputElement;
  /** Sets the draft line at once, as a paste or an Edit would. */
  setLine(line: string): void;
  requests(): string[];
}

interface MountOptions {
  enabled?: boolean;
  /** Mount the real DataUseGateProvider: `required` pauses new entries, `acknowledged` lets them through. */
  gate?: 'required' | 'acknowledged';
  today?: string | null;
  bills?: string[];
  children?: ReactNode;
  prepare?(backend: UiBackend, net: SpendingFetch): void;
}

const memoryClients: MemoryClient[] = [];

function mount(options: MountOptions = {}): Harness {
  const enabled = options.enabled ?? true;
  vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', enabled ? 'true' : 'false');
  vi.stubEnv('VITE_QUICK_ADD_ENABLED', enabled ? 'true' : 'false');
  const backend = new UiBackend(MONTH, { categories: [...BUILT_IN_CATEGORIES, CUSTOM] });
  backend.todayDate = options.today === undefined ? TODAY : options.today;
  backend.billLabels = options.bills ?? [];
  backend.noticeAcknowledged = options.gate !== 'required';
  if (options.gate === 'acknowledged') sessionStorage.setItem(PROMISE_RENDERED_KEY, '4242');
  const net = installSpendingFetch(backend);
  options.prepare?.(backend, net);
  const memory = createMemoryClient({ queryClient: new QueryClient(), isEnabled: () => enabled });
  memoryClients.push(memory);
  const store = createQuickAddStore();

  const content = options.children ?? (
    <>
      <QuickAddInput />
      <ParsedPreview />
    </>
  );
  const inner = (
    <QuickAddProvider store={store}>
      <QuickAddDraftProvider memory={memory}>{content}</QuickAddDraftProvider>
    </QuickAddProvider>
  );
  const view = renderAuthenticated(
    <FinancialClarityProvider>
      <MutationStatusProvider>
        {options.gate ? <DataUseGateProvider enabled>{inner}</DataUseGateProvider> : inner}
      </MutationStatusProvider>
    </FinancialClarityProvider>,
    { queryClient: createTestQueryClient() },
  );

  return {
    user: userEvent.setup(),
    backend,
    net,
    store,
    memory,
    container: view.container,
    input: () => screen.getByLabelText(QUICK_ADD_LABEL) as HTMLInputElement,
    setLine(line) {
      act(() => {
        store.dispatch({ type: 'line/set', line });
      });
    },
    requests: () => net.calls.map((call) => `${call.method} ${call.path}`),
  };
}

beforeEach(() => {
  vi.setSystemTime(NOW);
});

afterEach(() => {
  resetServerTimeOffset();
  document.documentElement.removeAttribute('data-theme');
  for (const client of memoryClients.splice(0)) client.dispose();
});

/** The test harness adds its own toast region, so look for Quick Add's elements and text only. */
function expectNothingRendered(container: HTMLElement) {
  expect(container.querySelector('[class*="qa-"], input, button, select')).toBeNull();
  expect(container.textContent).toBe('');
}

const previewText = () => document.querySelector('.qa-preview')?.textContent ?? '';
const writes = (h: Harness, method: string, path: string) => h.net.to(method, path);

describe('flag off', () => {
  it('renders nothing and sends no request', () => {
    vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'true');
    vi.stubEnv('VITE_QUICK_ADD_ENABLED', 'false');
    // No Quick Add provider, store, or clarity provider is mounted: nothing may read them while the flag is off.
    const { container } = renderAuthenticated(
      <QuickAddDraftProvider>
        <QuickAddInput />
        <ParsedPreview />
      </QuickAddDraftProvider>,
    );
    expectNothingRendered(container);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('renders nothing while the Rollout_Flag is off even if the Quick_Add_Flag is on', () => {
    vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'false');
    vi.stubEnv('VITE_QUICK_ADD_ENABLED', 'true');
    const { container } = renderAuthenticated(
      <QuickAddDraftProvider>
        <QuickAddInput />
        <ParsedPreview />
      </QuickAddDraftProvider>,
    );
    expectNothingRendered(container);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('QuickAddInput', () => {
  it('has a visible label, examples in its description, and the mobile-safe attributes', () => {
    const h = mount();
    const input = h.input();
    expect(screen.getByText(QUICK_ADD_LABEL).tagName).toBe('LABEL');
    expect(input).toHaveAttribute('type', 'text');
    expect(input).toHaveAttribute('autocomplete', 'off');
    expect(input).toHaveAttribute('autocorrect', 'off');
    expect(input).toHaveAttribute('autocapitalize', 'none');
    expect(input).toHaveAttribute('spellcheck', 'false');
    expect(input).toHaveAttribute('maxlength', '200');
    expect(input).toHaveAttribute('placeholder', QUICK_ADD_PLACEHOLDER);
    const described = (input.getAttribute('aria-describedby') ?? '').split(' ');
    const help = document.getElementById(described[0] ?? '');
    expect(help).toHaveTextContent('120 coffee');
    expect(help).toHaveTextContent('swiggy 450 yesterday');
    expect(help).toHaveTextContent('rent 25,000 on 3rd');
    // The preview container exists from the start, so the description never points at nothing.
    expect(document.getElementById(described[1] ?? '')).toBeInTheDocument();
  });

  it('stays editable and shows the same draft the store holds', async () => {
    const h = mount();
    await h.user.type(h.input(), '120 coffee');
    expect(h.input()).toHaveValue('120 coffee');
    expect(h.store.getState().line).toBe('120 coffee');
    // Nothing is requested for typing: only the passive reads (hints, categories, snapshot) are made.
    expect(h.requests().some((request) => request.startsWith('POST'))).toBe(false);
  });

  it('shows the limit hint near 200 characters and never keeps more than 200', () => {
    const h = mount();
    expect(screen.queryByText(/of 200 characters/)).not.toBeInTheDocument();
    fireEvent.change(h.input(), { target: { value: 'a'.repeat(LIMIT_HINT_FROM + 3) } });
    const hint = screen.getByText(`${LIMIT_HINT_FROM + 3} of 200 characters.`);
    expect(h.input().getAttribute('aria-describedby')).toContain(hint.id);
    fireEvent.change(h.input(), { target: { value: 'b'.repeat(250) } });
    expect(h.store.getState().line).toHaveLength(200);
    expect(screen.getByText('Limit reached: 200 of 200 characters.')).toBeInTheDocument();
  });

  it('does not cut a surrogate pair when it clamps', () => {
    const h = mount();
    fireEvent.change(h.input(), { target: { value: `${'a'.repeat(199)}😀` } });
    expect(h.store.getState().line).toBe('a'.repeat(199));
  });

  it('does nothing on Enter while the line is empty', async () => {
    const h = mount();
    await h.user.click(h.input());
    await h.user.keyboard('{Enter}');
    expect(h.requests().some((request) => request.startsWith('POST'))).toBe(false);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(h.input()).toHaveFocus();
  });

  it('ignores the Enter that confirms an input-method composition', () => {
    const h = mount();
    h.setLine('120 coffee');
    fireEvent.keyDown(h.input(), { key: 'Enter', isComposing: true, keyCode: 229 });
    expect(h.store.getState().entries).toHaveLength(0);
  });
});

describe('ParsedPreview states', () => {
  it('shows the amount, category with its reason, the full date with Today, and the note, in the same render as the keystroke', () => {
    const h = mount();
    fireEvent.change(h.input(), { target: { value: '120 coffee' } });
    // No await: the preview is derived synchronously (Requirement 3.1).
    expect(screen.getByText('₹120')).toBeInTheDocument();
    expect(screen.getByLabelText('Category')).toHaveValue('Food');
    expect(screen.getByText('"coffee" usually means Food.')).toBeInTheDocument();
    expect(screen.getByText('Wednesday, 18 November 2026')).toBeInTheDocument();
    expect(screen.getByText('Today')).toBeInTheDocument();
    expect(screen.getByText('coffee')).toBeInTheDocument();
    expect(screen.queryByText('Future date')).not.toBeInTheDocument();
    expect(screen.queryByText('Default')).not.toBeInTheDocument();
  });

  it('shows an earlier date without the Today label', () => {
    const h = mount();
    h.setLine('swiggy 450 yesterday');
    expect(screen.getByText('Tuesday, 17 November 2026')).toBeInTheDocument();
    expect(screen.queryByText('Today')).not.toBeInTheDocument();
    expect(screen.getByText('₹450')).toBeInTheDocument();
  });

  it('labels a later date in the same month as a Future date', () => {
    const h = mount();
    h.setLine('120 coffee 2026-11-20');
    expect(screen.getByText('Friday, 20 November 2026')).toBeInTheDocument();
    expect(screen.getByText('Future date')).toBeInTheDocument();
    expect(screen.queryByText(/not this month/)).not.toBeInTheDocument();
  });

  it('states the month an entry in another month counts toward', () => {
    const h = mount();
    h.setLine('120 coffee 2026-12-05');
    expect(screen.getByText('Future date')).toBeInTheDocument();
    expect(screen.getByText('Counts toward December 2026, not this month.')).toBeInTheDocument();
    h.setLine('120 coffee 2026-10-05');
    expect(screen.getByText('Counts toward October 2026, not this month.')).toBeInTheDocument();
  });

  it('shows No note and the Default label for a bare amount', () => {
    const h = mount();
    h.setLine('120');
    expect(screen.getByText('No note')).toBeInTheDocument();
    expect(screen.getByLabelText('Category')).toHaveValue('Other');
    expect(screen.getByText('Default')).toBeInTheDocument();
    expect(screen.getByText('No note, so this goes to Other.')).toBeInTheDocument();
  });

  it('shows the recurring-payment hint without blocking the save', () => {
    const h = mount();
    h.setLine('999 rent every month');
    expect(screen.getByText(RECURRING_HINT_TEXT)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    h.setLine('999 rent');
    expect(screen.queryByText(RECURRING_HINT_TEXT)).not.toBeInTheDocument();
  });

  it('renders a note, a category reason, and a bill label as plain text', async () => {
    const h = mount({ bills: ['<b>Rent</b>'] });
    h.setLine('1500 <img src=x onerror=alert(1)> <b>bold</b>');
    expect(h.container.querySelector('img')).toBeNull();
    expect(h.container.querySelector('.qa-preview b')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)> <b>bold</b>')).toBeInTheDocument();
    // A bill label with markup in it is text too.
    h.setLine('100 <b>rent</b>');
    expect(await screen.findByText(/This looks like a bill: <b>Rent<\/b>\./)).toBeInTheDocument();
    expect(h.container.querySelector('.qa-warning b')).toBeNull();
  });

  it('shows nothing for an empty or blank line', () => {
    const h = mount();
    expect(previewText()).toBe('');
    h.setLine('   ');
    expect(previewText()).toBe('');
  });

  const PROBLEMS: Array<[name: string, line: string | (() => string), expected: RegExp]> = [
    ['a missing amount', 'coffee', /Amount: The line has no amount\. Add an amount/],
    ['an invalid amount', '1.234 coffee', /Amount "1\.234":/],
    ['multiple amounts', '120 450 coffee', /Amount "120 450": The line has more than one amount.*Mark the amount with ₹/],
    ['an invalid date', '120 coffee 31/02', /Date "31\/02":/],
    ['multiple dates', '120 today yesterday', /Date/],
    ['a note that is too long', () => `120 ${'x'.repeat(125)}`, /Note: The note is 125 characters long and the limit is 120\. Shorten the note/],
    ['a line that is too long', () => `120 ${'y '.repeat(100)}`, /Line: The line is \d+ characters long and the limit is 200\./],
  ];

  it.each(PROBLEMS)('shows the parser reason and correction for %s, never a guess', (_name, line, expected) => {
    const h = mount();
    h.setLine(typeof line === 'function' ? line() : line);
    const text = previewText();
    expect(text).toContain(NOT_READY_TEXT);
    expect(text).toMatch(expected);
    // No understood values are shown for a line that cannot be saved.
    expect(screen.queryByText('What Quick Add understood')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Category')).not.toBeInTheDocument();
    // Requirement 3.6: the status is neutral text and is not announced.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    const preview = h.container.querySelector('.qa-preview');
    expect(preview?.querySelector('[aria-live]')).toBeNull();
    expect(preview?.querySelector('[role="status"]')).toBeNull();
  });

  it('keeps every live region out of the preview while the User types', async () => {
    const h = mount();
    await h.user.type(h.input(), '120 coffee yesterday');
    const quickAdd = [...h.container.querySelectorAll('.qa-input, .qa-preview')];
    expect(quickAdd).toHaveLength(2);
    for (const region of quickAdd) expect(region.querySelectorAll('[aria-live], [role="alert"]')).toHaveLength(0);
    // The only status element belongs to "Forget this" and is empty until that action runs.
    for (const status of h.container.querySelectorAll('.qa-preview [role="status"]')) expect(status.textContent).toBe('');
  });

  it('says saved choices are being checked while the hints load, then clears it', async () => {
    let gate!: { release(): void };
    const h = mount({ prepare: (_backend, net) => { gate = net.hold('GET', '/finance/quick-add/hints'); } });
    h.setLine('120 coffee');
    expect(screen.getByText(HINTS_LOADING_TEXT)).toBeInTheDocument();
    // The input and the preview work before the hints, the snapshot, and the categories have loaded.
    expect(screen.getByLabelText('Category')).toHaveValue('Food');
    act(() => gate.release());
    await waitFor(() => expect(screen.queryByText(HINTS_LOADING_TEXT)).not.toBeInTheDocument());
  });

  it('says saved choices are unavailable when the hints cannot be read, and still suggests from the rest', async () => {
    const h = mount({
      prepare: (backend) => backend.failWith('GET', '/finance/quick-add/hints', { status: 500, code: 'INTERNAL_ERROR' }),
    });
    h.setLine('120 coffee');
    expect(await screen.findByText(HINTS_UNAVAILABLE_TEXT)).toBeInTheDocument();
    expect(screen.getByLabelText('Category')).toHaveValue('Food');
  });
});

describe('submitting', () => {
  it('saves with Enter through the expense path with structured fields only, clears the line, and keeps focus', async () => {
    const h = mount();
    await h.user.type(h.input(), '120 coffee{Enter}');
    expect(h.input()).toHaveValue('');
    expect(h.input()).toHaveFocus();
    await waitFor(() => expect(h.store.getState().entries[0]?.phase).toBe('saved'));
    const posts = writes(h, 'POST', EXPENSES);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toEqual({ amountMinor: 12000, category: 'Food', note: 'coffee', spentOn: TODAY });
    expect(JSON.stringify(posts[0]?.body)).not.toContain('120 coffee');
    expect(h.backend.expenses).toHaveLength(1);
    expect(h.input()).toHaveFocus();
  });

  it('saves with the Save button as it does with Enter', async () => {
    const h = mount();
    h.setLine('450 swiggy yesterday');
    await h.user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(h.backend.expenses).toHaveLength(1));
    expect(writes(h, 'POST', EXPENSES)[0]?.body).toEqual({
      amountMinor: 45000, category: 'Food', note: 'swiggy', spentOn: '2026-11-17',
    });
  });

  it('sends no request for a line with problems, keeps the line, shows each problem as text tied to the input, and does not move focus', async () => {
    const h = mount();
    await h.user.type(h.input(), 'coffee');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await h.user.keyboard('{Enter}');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Amount: The line has no amount.');
    expect(h.requests().some((request) => request.startsWith('POST'))).toBe(false);
    expect(h.input()).toHaveValue('coffee');
    expect(h.input()).toHaveFocus();
    expect(h.input()).toHaveAttribute('aria-invalid', 'true');
    // The alert lives inside the preview that the input names in aria-describedby.
    const preview = document.getElementById((h.input().getAttribute('aria-describedby') ?? '').split(' ')[1] ?? '');
    expect(preview).toContainElement(alert);

    // Editing the line drops the alert and the invalid mark.
    await h.user.type(h.input(), ' 100');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(h.input()).not.toHaveAttribute('aria-invalid');
  });

  it('announces the problems again when the User presses Enter again on the same line', async () => {
    const h = mount();
    h.setLine('coffee');
    await h.user.click(h.input());
    await h.user.keyboard('{Enter}');
    const first = await screen.findByRole('alert');
    await h.user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByRole('alert')).not.toBe(first));
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  it('saves the category the User chose and remembers it', async () => {
    const h = mount();
    h.setLine('120 coffee');
    await h.user.selectOptions(screen.getByLabelText('Category'), 'Transport');
    expect(screen.getByLabelText('Category')).toHaveValue('Transport');
    expect(screen.getByText(/You chose Transport\. Quick Add suggested Food: "coffee" usually means Food\./)).toBeInTheDocument();
    await h.user.click(h.input());
    await h.user.keyboard('{Enter}');
    await waitFor(() => expect(h.backend.expenses).toHaveLength(1));
    expect(writes(h, 'POST', EXPENSES)[0]?.body).toMatchObject({ category: 'Transport', note: 'coffee' });
    await waitFor(() => expect(h.backend.memoryFor('coffee')?.category).toBe('Transport'));
  });

  it('lists every available category, custom ones included, and drops a choice when the note changes', async () => {
    const h = mount();
    h.setLine('120 coffee');
    const select = screen.getByLabelText('Category');
    await waitFor(() => expect(within(select).queryByRole('option', { name: CUSTOM })).toBeInTheDocument());
    expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual([...BUILT_IN_CATEGORIES, CUSTOM]);
    await h.user.selectOptions(select, CUSTOM);
    expect(select).toHaveValue(CUSTOM);
    h.setLine('120 coffee beans');
    expect(screen.getByLabelText('Category')).not.toHaveValue(CUSTOM);
  });

  it('uses built-in categories before the category list has loaded', () => {
    const h = mount({ prepare: (_backend, net) => { net.hold('GET', '/finance/categories'); } });
    h.setLine('120 coffee');
    const options = within(screen.getByLabelText('Category')).getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([...BUILT_IN_CATEGORIES]);
  });
});

describe('Entry_Warning', () => {
  it('stays hidden for a large amount when the server sends no threshold, and saving is unaffected', async () => {
    const h = mount({ today: null });
    h.setLine('150000 laptop');
    await waitFor(() => expect(h.requests()).toContain('GET /finance/clarity'));
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    expect(screen.queryByText(/Check before saving/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: SAVE_AND_COUNT_LABEL })).not.toBeInTheDocument();
  });

  it('warns about a large amount, ties the text to the input, and offers both save choices', async () => {
    const h = mount();
    h.setLine('1500 laptop');
    const warning = await screen.findByText(/This amount is large compared with this month's spendable budget\./);
    expect(warning.id).not.toBe('');
    expect(h.input().getAttribute('aria-describedby')).toContain(warning.id);
    expect(screen.queryByText(/This looks like a bill/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: SAVE_AND_COUNT_LABEL })).toBeEnabled();
    expect(screen.getByRole('button', { name: SAVE_WITHOUT_COUNTING_LABEL })).toBeEnabled();
    // The warning does not move focus and does not change the entry.
    expect(h.input()).not.toHaveFocus();
    expect(screen.getByText('₹1,500')).toBeInTheDocument();
  });

  it('warns about a bill, names its label, and says the Plan already subtracts it', async () => {
    const h = mount({ bills: ['Rent'] });
    h.setLine('100 rent');
    expect(await screen.findByText(/This looks like a bill: Rent\./)).toBeInTheDocument();
    expect(screen.getByText(/Your Plan already includes this bill\. Saving it here also counts it as spending this month\./)).toBeInTheDocument();
    // 100 rupees is not large, so the bill is the only reason.
    expect(screen.queryByText(/large compared/)).not.toBeInTheDocument();
  });

  it('gives both reasons in one warning', async () => {
    const h = mount({ bills: ['Rent'] });
    h.setLine('5000 rent');
    const text = await screen.findByText(/This looks like a bill: Rent\./);
    expect(text).toHaveTextContent(/large compared with this month's spendable budget/);
    expect(screen.getAllByText(/Check before saving\./)).toHaveLength(1);
  });

  it('shows no warning and no exclusion choice for an entry that is not dated Today', async () => {
    const h = mount({ bills: ['Rent'] });
    h.setLine('5000 rent');
    await screen.findByText(/This looks like a bill/);
    h.setLine('5000 rent yesterday');
    expect(screen.queryByText(/This looks like a bill/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: SAVE_WITHOUT_COUNTING_LABEL })).not.toBeInTheDocument();
  });

  it('saves with the exclusion mark in the same create request, once, and returns focus to the input', async () => {
    const h = mount();
    h.setLine('1500 laptop');
    await h.user.click(await screen.findByRole('button', { name: SAVE_WITHOUT_COUNTING_LABEL }));
    expect(h.input()).toHaveFocus();
    expect(h.input()).toHaveValue('');
    await waitFor(() => expect(h.backend.expenses).toHaveLength(1));
    const posts = writes(h, 'POST', EXPENSES);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toEqual({
      amountMinor: 150000, category: expect.any(String), note: 'laptop', spentOn: TODAY, excludeFromDailyAllowance: true,
    });
    expect(screen.queryByRole('button', { name: SAVE_WITHOUT_COUNTING_LABEL })).not.toBeInTheDocument();
  });

  it('saves without the mark for "Save and count today" and for Enter', async () => {
    const h = mount();
    h.setLine('1500 laptop');
    await h.user.click(await screen.findByRole('button', { name: SAVE_AND_COUNT_LABEL }));
    await waitFor(() => expect(h.backend.expenses).toHaveLength(1));

    h.setLine('1600 laptop');
    await screen.findByRole('button', { name: SAVE_AND_COUNT_LABEL });
    await h.user.click(h.input());
    await h.user.keyboard('{Enter}');
    await waitFor(() => expect(h.backend.expenses).toHaveLength(2));
    for (const post of writes(h, 'POST', EXPENSES)) {
      expect(post.body).not.toHaveProperty('excludeFromDailyAllowance');
    }
  });

  it('is reachable and operable by keyboard alone', async () => {
    const h = mount();
    h.setLine('1500 laptop');
    const exclude = await screen.findByRole('button', { name: SAVE_WITHOUT_COUNTING_LABEL });
    await h.user.click(h.input());
    await h.user.tab();
    expect(screen.getByRole('button', { name: 'Save' })).toHaveFocus();
    await h.user.tab();
    expect(screen.getByLabelText('Category')).toHaveFocus();
    await h.user.tab();
    expect(screen.getByRole('button', { name: SAVE_AND_COUNT_LABEL })).toHaveFocus();
    await h.user.tab();
    expect(exclude).toHaveFocus();
    await h.user.keyboard('{Enter}');
    await waitFor(() => expect(h.backend.expenses).toHaveLength(1));
    expect(writes(h, 'POST', EXPENSES)[0]?.body).toHaveProperty('excludeFromDailyAllowance', true);
    expect(h.input()).toHaveFocus();
  });

  it('has buttons that are disabled and point at the pause reason while saving is paused', () => {
    renderAuthenticated(
      <EntryWarning
        warning={{ large: true }}
        textId="warning-text"
        disabled
        disabledReasonId="why"
        onSave={() => undefined}
      />,
    );
    const button = screen.getByRole('button', { name: SAVE_AND_COUNT_LABEL });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-describedby', 'why');
  });
});

describe('Forget this', () => {
  it('shows the remembered category with its reason, forgets it with one action, and moves focus to the category control', async () => {
    let seededId = 0;
    const h = mount({ prepare: (backend) => { seededId = backend.seedMemory('coffee', 'Transport').id; } });
    h.setLine('120 coffee');
    const forget = await screen.findByRole('button', { name: 'Forget this' });
    expect(screen.getByLabelText('Category')).toHaveValue('Transport');
    expect(screen.getByText('You corrected "coffee" to Transport before.')).toBeInTheDocument();

    await h.user.click(forget);
    await waitFor(() => expect(h.backend.memory).toHaveLength(0));
    expect(h.net.to('DELETE', `${MEMORY}/${seededId}`)).toHaveLength(1);
    expect(await screen.findByText(FORGET_DONE_TEXT)).toHaveAttribute('role', 'status');
    expect(screen.queryByRole('button', { name: 'Forget this' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Category')).toHaveValue('Food'));
    expect(screen.getByLabelText('Category')).toHaveFocus();
  });

  it('keeps the button and says so when the remembered choice could not be removed', async () => {
    let id = 0;
    const h = mount({
      prepare: (backend) => {
        id = backend.seedMemory('coffee', 'Transport').id;
        backend.failWith('DELETE', `${MEMORY}/${id}`, { status: 500, code: 'INTERNAL_ERROR' });
      },
    });
    h.setLine('120 coffee');
    await h.user.click(await screen.findByRole('button', { name: 'Forget this' }));
    expect(await screen.findByText(FORGET_FAILED_TEXT)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Forget this' })).toBeInTheDocument();
    expect(h.backend.memory).toHaveLength(1);
    // Trying again works and sends one more request.
    await h.user.click(screen.getByRole('button', { name: 'Forget this' }));
    await waitFor(() => expect(h.backend.memory).toHaveLength(0));
  });

  it('is not offered when the suggestion does not come from a remembered choice', async () => {
    const h = mount({ prepare: (backend) => { backend.seedMemory('metro', 'Transport'); } });
    h.setLine('120 coffee');
    await screen.findByLabelText('Category');
    expect(screen.queryByRole('button', { name: 'Forget this' })).not.toBeInTheDocument();
  });
});

describe('CategoryChoice on its own', () => {
  it('keeps a category that is no longer in the list selectable and states a chosen category as the User\'s choice', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderAuthenticated(
      <CategoryChoice
        id="c1"
        categories={['Food', 'Other']}
        value="Gone"
        onChange={onChange}
        suggestion={{ category: 'Food', source: 'keyword', reason: '"tea" usually means Food.' }}
        reasonId="r1"
      />,
    );
    const select = screen.getByLabelText('Category');
    expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual(['Gone', 'Food', 'Other']);
    expect(screen.getByText('You chose Gone. Quick Add suggested Food: "tea" usually means Food.')).toBeInTheDocument();
    await user.selectOptions(select, 'Other');
    expect(onChange).toHaveBeenCalledWith('Other');
  });
});

describe('Data_Use_Gate', () => {
  it('keeps the input editable and the preview available, disables saving, and shows the gate reason', async () => {
    const h = mount({ gate: 'required' });
    const reason = await screen.findByText(/Review and acknowledge the data-use notice/);
    expect(h.input()).toBeEnabled();
    await h.user.type(h.input(), '120 coffee');
    expect(screen.getByText('₹120')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    const paused = reason.closest('p');
    expect(h.input().getAttribute('aria-describedby')).toContain(paused?.id ?? 'missing');
    await h.user.keyboard('{Enter}');
    expect(h.requests().some((request) => request.startsWith('POST'))).toBe(false);
    expect(h.input()).toHaveValue('120 coffee');
  });

  it('saves again once the notice has been acknowledged', async () => {
    const h = mount({ gate: 'acknowledged' });
    h.setLine('120 coffee');
    await h.user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(h.backend.expenses).toHaveLength(1));
  });
});

describe('five pending entries', () => {
  it('disables saving, keeps the line, and says that earlier entries are still saving', async () => {
    const h = mount({ prepare: (_backend, net) => { for (let i = 0; i < 5; i += 1) net.hold('POST', EXPENSES); } });
    for (let i = 1; i <= 5; i += 1) {
      h.setLine(`${i}0 coffee`);
      await h.user.click(screen.getByRole('button', { name: 'Save' }));
    }
    h.setLine('60 coffee');
    expect(await screen.findByText(/Earlier entries are still saving/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(h.input()).toHaveValue('60 coffee');
    expect(h.input()).toBeEnabled();
  });
});

describe('input focus registry', () => {
  it('focuses the newest mounted input and forgets one that unmounts', () => {
    const first = document.createElement('input');
    const second = document.createElement('input');
    document.body.append(first, second);
    const stopFirst = registerQuickAddInput(first);
    const stopSecond = registerQuickAddInput(second);
    expect(focusQuickAddInput()).toBe(true);
    expect(second).toHaveFocus();
    stopSecond();
    expect(currentQuickAddInput()).toBe(first);
    stopFirst();
    expect(focusQuickAddInput()).toBe(false);
    first.remove();
    second.remove();
  });
});

describe('pure helpers', () => {
  it('detects the recurring-payment words as whole words only', () => {
    for (const note of ['rent monthly', 'Weekly pass', 'yearly, plan', 'recurring gym', 'rent every month', 'EVERY   MONTH rent']) {
      expect(hasRecurringHint(note), note).toBe(true);
    }
    for (const note of ['', 'coffee', 'bimonthly', 'every months', 'monthlyfee', 'every other month']) {
      expect(hasRecurringHint(note), note).toBe(false);
    }
  });

  it('builds the category list with built-ins first, custom after, and falls back to the built-ins', () => {
    expect(buildCategoryList({ defaults: ['Food', 'Other'], custom: [{ id: 1, name: 'Pets' }, { id: 2, name: 'Food' }] }))
      .toEqual(['Food', 'Other', 'Pets']);
    expect(buildCategoryList(undefined)).toEqual([...BUILT_IN_CATEGORIES]);
    expect(buildCategoryList({ defaults: 'x', custom: null })).toEqual([...BUILT_IN_CATEGORIES]);
  });

  it('reads the threshold and bill labels only from a snapshot of the current month', () => {
    const backend = new UiBackend(MONTH);
    backend.todayDate = TODAY;
    backend.billLabels = ['Rent', 'Netflix'];
    const snapshot = backend.snapshot(MONTH);
    expect(selectLargeEntryThreshold(snapshot, MONTH)).toBe(100_000);
    expect(selectBillLabels(snapshot, MONTH)).toEqual(['Netflix', 'Rent']);
    expect(selectLargeEntryThreshold(snapshot, '2026-12')).toBeNull();
    expect(selectBillLabels(snapshot, '2026-12')).toBeNull();
    expect(selectLargeEntryThreshold(undefined, MONTH)).toBeNull();
    backend.todayDate = null;
    expect(selectLargeEntryThreshold(backend.snapshot(MONTH), MONTH)).toBeNull();
  });
});

describe('accessibility and layout', () => {
  async function checkBothThemes(prepare: (h: Harness) => Promise<void> | void, options: MountOptions = {}) {
    for (const theme of ['light', 'dark'] as const) {
      document.documentElement.setAttribute('data-theme', theme);
      const h = mount(options);
      await prepare(h);
      expect(await axe(h.container), theme).toHaveNoViolations();
      // The next theme mounts fresh.
      cleanup();
      memoryClients.splice(0).forEach((client) => client.dispose());
    }
  }

  it('has no axe violations when empty, with a preview, with problems, and with a warning, in light and dark themes', async () => {
    await checkBothThemes(() => undefined);
    await checkBothThemes((h) => h.setLine('120 coffee'));
    await checkBothThemes(async (h) => {
      h.setLine('coffee');
      await h.user.click(h.input());
      await h.user.keyboard('{Enter}');
      await screen.findByRole('alert');
    });
    await checkBothThemes(async (h) => {
      h.setLine('5000 rent');
      await screen.findByRole('button', { name: SAVE_WITHOUT_COUNTING_LABEL });
    }, { bills: ['Rent'] });
  });

  it('has no axe violations while saving is paused by the Data_Use_Gate', async () => {
    const h = mount({ gate: 'required' });
    h.setLine('120 coffee');
    await screen.findByText(/Review and acknowledge/);
    expect(await axe(h.container)).toHaveNoViolations();
  });

  it('styles with theme tokens only, keeps 44 pixel targets, wraps long text, and removes motion on request', () => {
    // Colors come from the app and clarity tokens, so light and dark follow the theme.
    expect(css.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    expect(css).toMatch(/min-height: 44px; min-width: 44px/);
    expect(css).toMatch(/\.qa-input input, \.qa-preview select \{ min-height: 44px; \}/);
    expect(css).toMatch(/overflow-wrap: anywhere/);
    expect(css).toMatch(/\.qa-input-row \{[^}]*flex-wrap: wrap/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*animation: none !important/);
    expect(css).toMatch(/outline: 3px solid var\(--clarity-focus\)/);
  });
});

// The Spending page while Quick_Add_Enabled, beyond Spending.quickAdd.test.tsx (Requirements 7.17, 7.21, 16.1,
// 18.15, 18.16, 18.17, 18.24): what that file does not cover.
//
// - an auto-posted recurring expense shows "Not counted in daily allowance", still counts in the month, and clearing
//   or correcting it sends only what changed,
// - the per-row control works by keyboard (Enter and Space), once each, and Tab keeps the row's order,
// - focus after Quick Add confirmations change the list: a row that held focus hands it to the list heading, and
//   nothing else ever takes focus,
// - with the Quick_Add_Flag off, each row and the edit form are exactly the rows and form they were (structural,
//   snapshot-free: the flag-on markup minus the added elements equals the flag-off markup),
// - axe in both themes with the added elements together.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FinancialClarityProvider } from '../clarity/FinancialClarityProvider';
import { MutationStatusProvider } from '../clarity/MutationStatusProvider';
import {
  publishExpenseChange,
  resetExpenseEventsForTests,
  type ConfirmedExpenseChange,
  type ConfirmedExpenseRecord,
  type ExpenseChangeKind,
} from '../clarity/quickAdd/expenseEvents';
import { currentMonth, monthLabel } from '../money';
import { FakeQuickAddBackend } from '../test/fakeQuickAddBackend';
import type { FakeSpendingInit, SpendingBackendReply } from '../test/fakeSpendingBackend';
import { installSpendingFetch } from '../test/fakeSpendingFetch';
import { axe, createTestQueryClient, renderAuthenticated } from '../test/test-utils';
import { Spending } from './Spending';

const MONTH = currentMonth();
const MONTH_NAME = monthLabel(MONTH);
const PRIOR = (() => {
  const now = new Date();
  const prior = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${prior.getFullYear()}-${String(prior.getMonth() + 1).padStart(2, '0')}`;
})();
const MARKED = 'Not counted in daily allowance';

/** Ids 1 to 5. Id 5 is the auto-posted rent. The list shows 5, 4, 3, 2, 1. Spent 2,200 in all. */
const BASE: NonNullable<FakeSpendingInit['expenses']> = [
  { category: 'Food', amount: 500 },
  { category: 'Shopping', amount: 500 },
  { category: 'Transport', amount: 100 },
  { category: 'Food', amount: 200, note: 'Dinner' },
  { category: 'Other', amount: 900, note: 'Rent (recurring)' },
];

function setup(options: { quickAdd?: boolean; marked?: number[] } = {}) {
  vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'true');
  vi.stubEnv('VITE_QUICK_ADD_ENABLED', options.quickAdd === false ? '' : 'true');
  const backend = new FakeQuickAddBackend(MONTH, { expenses: BASE });
  for (const id of options.marked ?? []) backend.marks.set(id, true);
  const net = installSpendingFetch(backend);
  const view = renderAuthenticated(
    <FinancialClarityProvider>
      <MutationStatusProvider>
        <Spending />
      </MutationStatusProvider>
    </FinancialClarityProvider>,
    { route: '/spending', queryClient: createTestQueryClient() },
  );
  return { backend, net, ...view };
}

const rowOf = (id: number) => document.getElementById(`expense-${id}`) as HTMLElement;
const statusOf = (scope: string) => document.querySelector(`[data-scope="${scope}"]`) as HTMLElement;
const card = () => screen.getByRole('article', { name: `Spending for ${MONTH_NAME}` });
const spentSoFar = () => (within(card()).getByText('Spent so far').closest('.clarity-value')?.querySelector('.clarity-value-amount') as HTMLElement).textContent;
const entriesHeading = () => screen.getByRole('heading', { name: `Recent entries for ${MONTH_NAME}` });
const rowIds = () => Array.from(document.querySelectorAll('[data-expense-id]')).map((row) => Number(row.getAttribute('data-expense-id')));
const dontCount = (category: string, amount: string) => screen.getByRole('button', { name: `Don't count in daily allowance, ${category} ${amount}` });
const countAgain = (category: string, amount: string) => screen.getByRole('button', { name: `Count in daily allowance, ${category} ${amount}` });
const patches = (net: ReturnType<typeof installSpendingFetch>, id: number) => net.to('PATCH', `/finance/expenses/${id}`);
const logForm = () => screen.getByRole('form', { name: 'Log an expense' });
/** The form ids React generates differ between renders, so markup is compared with them normalized. */
const normalized = (html: string) => html.replace(/:r[0-9a-z]+:/g, ':id:');

async function loaded() {
  await screen.findByRole('article', { name: `Spending for ${MONTH_NAME}` });
  await waitFor(() => expect(rowOf(1)).toBeInTheDocument());
  await screen.findByText('Food', { selector: '.pill' });
}

function confirm(
  kind: ExpenseChangeKind,
  reply: SpendingBackendReply,
  months: { original: string | null; resulting: string | null },
  categories: { original?: string; resulting?: string } = {},
) {
  expect(reply.status).toBe(200);
  const mutation = (reply.body as { mutation: { recordId: number; record: ConfirmedExpenseRecord | null } }).mutation;
  const change: ConfirmedExpenseChange = {
    confirmed: true,
    kind,
    expenseId: mutation.recordId,
    originalMonth: months.original,
    resultingMonth: months.resulting,
    originalCategory: categories.original ?? null,
    resultingCategory: categories.resulting ?? null,
    excludedFromDailyAllowance: typeof mutation.record?.excludeFromDailyAllowance === 'boolean' ? mutation.record.excludeFromDailyAllowance : null,
    record: mutation.record,
  };
  act(() => publishExpenseChange(change));
}

function removeViaBus(backend: FakeQuickAddBackend, id: number, category: string) {
  const reply = backend.handle({ method: 'DELETE', path: `/finance/expenses/${id}`, body: {}, headers: { 'idempotency-key': `qa-delete-${id}` } });
  confirm('delete', reply, { original: MONTH, resulting: null }, { original: category });
}

function createViaBus(backend: FakeQuickAddBackend, input: { amountMinor: number; category: string; spentOn: string; mark?: boolean }) {
  const reply = backend.handle({
    method: 'POST',
    path: '/finance/expenses',
    body: { amountMinor: input.amountMinor, category: input.category, spentOn: input.spentOn, ...(input.mark === undefined ? {} : { excludeFromDailyAllowance: input.mark }) },
    headers: { 'idempotency-key': `qa-create-${input.amountMinor}` },
  });
  confirm('create', reply, { original: null, resulting: MONTH }, { resulting: input.category });
  return (reply.body as { mutation: { recordId: number } }).mutation.recordId;
}

beforeEach(() => {
  resetExpenseEventsForTests();
});
afterEach(() => {
  resetExpenseEventsForTests();
  vi.unstubAllEnvs();
});

describe('an auto-posted recurring expense', () => {
  it('shows "Not counted in daily allowance" as text, and the month still counts it', async () => {
    setup({ marked: [5] });
    await loaded();
    const rent = within(rowOf(5));
    expect(rent.getByText('Other')).toBeInTheDocument();
    expect(rent.getByText(/Rent \(recurring\)/)).toBeInTheDocument();
    expect(rent.getByText(MARKED)).toBeInTheDocument();
    expect(document.querySelectorAll('.spending-excluded')).toHaveLength(1);
    // The mark changes the daily allowance only. The month total still holds the rent.
    expect(spentSoFar()).toBe('₹2,200');
    expect(countAgain('Other', '₹900')).toBeInTheDocument();
  });

  it('clears the mark with the mark alone, keeps the month total, and later corrections leave the mark cleared', async () => {
    const user = userEvent.setup();
    const { net } = setup({ marked: [5] });
    await loaded();
    await user.click(countAgain('Other', '₹900'));
    await waitFor(() => expect(within(rowOf(5)).queryByText(MARKED)).toBeNull());
    await waitFor(() => expect(statusOf('expense:5')).toHaveTextContent('done'));
    expect(patches(net, 5)[0]?.body).toEqual({ excludeFromDailyAllowance: false });
    expect(spentSoFar()).toBe('₹2,200');
    // A later correction of the amount sends the amount and the record version, never the mark.
    await user.click(screen.getByRole('button', { name: 'Edit Other ₹900' }));
    const form = screen.getByRole('form', { name: 'Correct Other ₹900' });
    expect(within(form).getByRole('checkbox', { name: MARKED })).not.toBeChecked();
    fireEvent.change(within(form).getByRole('textbox', { name: 'Amount' }), { target: { value: '950' } });
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(patches(net, 5)).toHaveLength(2));
    expect(patches(net, 5)[1]?.body).toEqual({ amountMinor: 95_000, expectedRecordVersion: 2 });
    await waitFor(() => expect(within(rowOf(5)).getByText('₹950')).toBeInTheDocument());
    expect(within(rowOf(5)).queryByText(MARKED)).toBeNull();
  });

  it('keeps the mark through a correction of the amount, and sends no mark', async () => {
    const user = userEvent.setup();
    const { net } = setup({ marked: [5] });
    await loaded();
    await user.click(screen.getByRole('button', { name: 'Edit Other ₹900' }));
    const form = screen.getByRole('form', { name: 'Correct Other ₹900' });
    expect(within(form).getByRole('checkbox', { name: MARKED })).toBeChecked();
    fireEvent.change(within(form).getByRole('textbox', { name: 'Amount' }), { target: { value: '950' } });
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(patches(net, 5)).toHaveLength(1));
    expect(patches(net, 5)[0]?.body).toEqual({ amountMinor: 95_000 });
    await waitFor(() => expect(within(rowOf(5)).getByText('₹950')).toBeInTheDocument());
    expect(within(rowOf(5)).getByText(MARKED)).toBeInTheDocument();
  });
});

describe('keyboard operation of the row controls', () => {
  it('activates the mark control with Enter and with Space, once each, and keeps focus on it', async () => {
    const user = userEvent.setup();
    const { net } = setup();
    await loaded();
    const button = dontCount('Food', '₹500');
    button.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(patches(net, 1)).toHaveLength(1));
    await waitFor(() => expect(statusOf('expense:1')).toHaveTextContent('done'));
    expect(patches(net, 1)[0]?.body).toEqual({ excludeFromDailyAllowance: true });
    expect(countAgain('Food', '₹500')).toBe(button);
    expect(document.activeElement).toBe(button);
    await user.keyboard(' ');
    await waitFor(() => expect(patches(net, 1)).toHaveLength(2));
    expect(patches(net, 1)[1]?.body).toEqual({ excludeFromDailyAllowance: false, expectedRecordVersion: 2 });
    await waitFor(() => expect(within(rowOf(1)).queryByText(MARKED)).toBeNull());
    expect(document.activeElement).toBe(button);
  });

  it('tabs through each row in order: the mark control, then Edit, then Delete', async () => {
    const user = userEvent.setup();
    setup();
    await loaded();
    dontCount('Transport', '₹100').focus();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Edit Transport ₹100' }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Delete Transport ₹100' }));
    await user.tab();
    // The list is newest first: the row after row 3 is row 2, and its first control is the mark control.
    expect(document.activeElement).toBe(dontCount('Shopping', '₹500'));
  });

  it('opens the edit form with focus on the amount and returns focus to Edit on Cancel', async () => {
    const user = userEvent.setup();
    setup({ marked: [2] });
    await loaded();
    await user.click(screen.getByRole('button', { name: 'Edit Shopping ₹500' }));
    const form = screen.getByRole('form', { name: 'Correct Shopping ₹500' });
    expect(document.activeElement).toBe(within(form).getByRole('textbox', { name: 'Amount' }));
    // Tab reaches the checkbox before Save changes and Cancel.
    const checkbox = within(form).getByRole('checkbox', { name: MARKED });
    checkbox.focus();
    await user.keyboard(' ');
    expect(checkbox).not.toBeChecked();
    await user.tab();
    expect(document.activeElement).toBe(within(form).getByRole('button', { name: 'Save changes' }));
    await user.tab();
    expect(document.activeElement).toBe(within(form).getByRole('button', { name: 'Cancel' }));
    await user.keyboard('{Enter}');
    expect(screen.queryByRole('form', { name: 'Correct Shopping ₹500' })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Edit Shopping ₹500' })));
    // Cancelling sent nothing and left the mark.
    expect(within(rowOf(2)).getByText(MARKED)).toBeInTheDocument();
  });
});

describe('focus when Quick Add confirmations change the list', () => {
  it('leaves focus in the log form when a row elsewhere is removed', async () => {
    const { backend } = setup();
    await loaded();
    const amount = within(logForm()).getByRole('textbox', { name: 'Amount' });
    amount.focus();
    removeViaBus(backend, 3, 'Transport');
    await waitFor(() => expect(rowOf(3)).toBeNull());
    expect(document.activeElement).toBe(amount);
    expect(document.activeElement).not.toBe(entriesHeading());
  });

  it('leaves focus on another row control when a different row is removed or inserted', async () => {
    const { backend } = setup();
    await loaded();
    const keep = screen.getByRole('button', { name: 'Edit Shopping ₹500' });
    keep.focus();
    removeViaBus(backend, 3, 'Transport');
    await waitFor(() => expect(rowOf(3)).toBeNull());
    expect(document.activeElement).toBe(keep);
    const created = createViaBus(backend, { amountMinor: 12_000, category: 'Food', spentOn: `${MONTH}-12`, mark: true });
    await waitFor(() => expect(rowOf(created)).toBeInTheDocument());
    expect(document.activeElement).toBe(keep);
    expect(keep).toBeInTheDocument();
  });

  it('moves no focus when nothing on the page held it', async () => {
    const { backend } = setup();
    await loaded();
    expect(document.activeElement).toBe(document.body);
    removeViaBus(backend, 3, 'Transport');
    await waitFor(() => expect(rowOf(3)).toBeNull());
    expect(document.activeElement).toBe(document.body);
  });

  it('hands focus to the list heading when the row with its edit form open is removed, and Tab continues from there', async () => {
    const user = userEvent.setup();
    const { backend } = setup();
    await loaded();
    await user.click(screen.getByRole('button', { name: 'Edit Transport ₹100' }));
    const form = screen.getByRole('form', { name: 'Correct Transport ₹100' });
    expect(rowOf(3).contains(document.activeElement)).toBe(true);
    expect(within(form).getByRole('textbox', { name: 'Amount' })).toHaveFocus();
    removeViaBus(backend, 3, 'Transport');
    await waitFor(() => expect(rowOf(3)).toBeNull());
    expect(screen.queryByRole('form', { name: 'Correct Transport ₹100' })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(entriesHeading()));
    // The heading is not a tab stop of its own: Tab goes on to the first control of the first remaining row.
    await user.tab();
    expect(rowOf(rowIds()[0] as number).contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(within(rowOf(rowIds()[0] as number)).getByRole('button', { name: /daily allowance/ }));
  });

  it('hands focus to the list heading when the row that held it moves to another month', async () => {
    const { backend } = setup();
    await loaded();
    dontCount('Shopping', '₹500').focus();
    const reply = backend.handle({ method: 'PATCH', path: '/finance/expenses/2', body: { spentOn: `${PRIOR}-05` }, headers: { 'idempotency-key': 'qa-move-focus' } });
    confirm('update', reply, { original: MONTH, resulting: PRIOR }, { original: 'Shopping', resulting: 'Shopping' });
    await waitFor(() => expect(rowOf(2)).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(entriesHeading()));
    expect(rowIds()).toEqual([5, 4, 3, 1]);
  });

  it('keeps focus on the same control when the row that holds it is replaced in place', async () => {
    const { backend } = setup();
    await loaded();
    const toggle = dontCount('Food', '₹500');
    toggle.focus();
    const reply = backend.handle({
      method: 'PATCH',
      path: '/finance/expenses/1',
      body: { excludeFromDailyAllowance: true },
      headers: { 'idempotency-key': 'qa-replace-in-place' },
    });
    confirm('update', reply, { original: MONTH, resulting: MONTH }, { original: 'Food', resulting: 'Food' });
    await waitFor(() => expect(within(rowOf(1)).getByText(MARKED)).toBeInTheDocument());
    expect(document.activeElement).toBe(toggle);
    expect(countAgain('Food', '₹500')).toBe(toggle);
    expect(entriesHeading()).not.toHaveFocus();
  });

  it('shows no alert and no page-wide busy state while the list follows a confirmation', async () => {
    const { backend } = setup();
    await loaded();
    createViaBus(backend, { amountMinor: 3_000, category: 'Other', spentOn: `${MONTH}-13` });
    removeViaBus(backend, 3, 'Transport');
    await waitFor(() => expect(rowOf(3)).toBeNull());
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
    expect(screen.queryByRole('progressbar')).toBeNull();
    // Each row keeps an empty alert region for its own failures. None of them has anything to say.
    for (const alert of screen.queryAllByRole('alert')) expect(alert).toBeEmptyDOMElement();
  });
});

describe('with the Quick_Add_Flag off, rows and the edit form are what they were', () => {
  async function rowMarkup(quickAdd: boolean) {
    const view = setup({ quickAdd, marked: [2, 5] });
    await loaded();
    const rows = rowIds().map((id) => rowOf(id).cloneNode(true) as HTMLElement);
    const markup = rows.map((row) => row.outerHTML);
    const net = view.net;
    view.unmount();
    return { rows, markup, net };
  }

  it('shows exactly Edit and Delete on each row, with no mark text, no mark control, and no mark attribute', async () => {
    setup({ quickAdd: false, marked: [2, 5] });
    await loaded();
    for (const id of rowIds()) {
      const row = rowOf(id);
      const names = within(row).getAllByRole('button').map((button) => button.getAttribute('aria-label'));
      expect(names).toHaveLength(2);
      expect(names[0]).toMatch(/^Edit /);
      expect(names[1]).toMatch(/^Delete /);
      expect(row.querySelector('.spending-excluded, [data-excluded]')).toBeNull();
      expect(row).not.toHaveTextContent(/daily allowance/i);
      expect(Array.from((row.querySelector('.grow') as HTMLElement).children).map((child) => child.tagName)).toEqual(['STRONG', 'SMALL']);
    }
    expect(screen.queryByRole('button', { name: /daily allowance/ })).toBeNull();
  });

  it('renders each row as the flag-on row without its added mark text and mark control', async () => {
    const off = await rowMarkup(false);
    const on = await rowMarkup(true);
    expect(on.rows).toHaveLength(off.rows.length);
    on.rows.forEach((row, index) => {
      row.querySelectorAll('.spending-excluded').forEach((node) => node.remove());
      row.querySelectorAll('button').forEach((button) => {
        if (/daily allowance/.test(button.getAttribute('aria-label') ?? '')) button.remove();
      });
      expect(normalized(row.outerHTML), `row ${index}`).toBe(normalized(off.markup[index] as string));
    });
  });

  it('renders the edit form as the flag-on form without its checkbox and note', async () => {
    const user = userEvent.setup();
    const forms: string[] = [];
    for (const quickAdd of [false, true]) {
      const view = setup({ quickAdd, marked: [2] });
      await loaded();
      await user.click(screen.getByRole('button', { name: 'Edit Shopping ₹500' }));
      const live = screen.getByRole('form', { name: 'Correct Shopping ₹500' });
      const form = live.cloneNode(true) as HTMLElement;
      if (quickAdd) {
        expect(within(live).getByRole('checkbox', { name: MARKED })).toBeInTheDocument();
        form.querySelector('.spending-exclusion-check')?.remove();
        form.querySelector('.spending-exclusion-note')?.remove();
      } else {
        expect(within(live).queryByRole('checkbox')).toBeNull();
        expect(live).not.toHaveTextContent(/daily allowance/i);
      }
      forms.push(normalized(form.outerHTML));
      view.unmount();
    }
    expect(forms[1]).toBe(forms[0]);
  });

  it('sends no mark and reads no Quick Add or memory route in any request, and ignores the bus', async () => {
    const user = userEvent.setup();
    const { backend, net } = setup({ quickAdd: false, marked: [2, 5] });
    await loaded();
    await user.click(screen.getByRole('button', { name: 'Edit Other ₹900' }));
    const form = screen.getByRole('form', { name: 'Correct Other ₹900' });
    fireEvent.change(within(form).getByRole('textbox', { name: 'Amount' }), { target: { value: '950' } });
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(patches(net, 5)).toHaveLength(1));
    expect(patches(net, 5)[0]?.body).toEqual({ amountMinor: 95_000 });
    for (const call of net.calls) {
      expect(call.path, `${call.method} ${call.path}`).not.toMatch(/quick-add|category-memory/);
      if (call.method !== 'GET') expect(JSON.stringify(call.body ?? {}), `${call.method} ${call.path}`).not.toContain('excludeFromDailyAllowance');
    }
    const before = rowIds();
    removeViaBus(backend, 3, 'Transport');
    expect(rowIds()).toEqual(before);
    expect(net.to('GET', '/finance/expenses')).toHaveLength(1);
  });
});

describe.each(['light', 'dark'] as const)('accessibility in the %s theme', (theme) => {
  it('has no violations with an auto-posted row, a row inserted and a row removed by Quick Add, and an open form', async () => {
    document.documentElement.dataset.theme = theme;
    try {
      const user = userEvent.setup();
      const { backend, container } = setup({ marked: [5] });
      await loaded();
      const created = createViaBus(backend, { amountMinor: 12_000, category: 'Food', spentOn: `${MONTH}-12`, mark: true });
      await waitFor(() => expect(rowOf(created)).toBeInTheDocument());
      removeViaBus(backend, 3, 'Transport');
      await waitFor(() => expect(rowOf(3)).toBeNull());
      await user.click(screen.getByRole('button', { name: 'Edit Other ₹900' }));
      expect(screen.getByRole('checkbox', { name: MARKED })).toBeChecked();
      expect(within(rowOf(created)).getByText(MARKED)).toBeInTheDocument();
      expect(await axe(container)).toHaveNoViolations();
    } finally {
      delete document.documentElement.dataset.theme;
    }
  });

  it('has no violations with the Quick_Add_Flag off', async () => {
    document.documentElement.dataset.theme = theme;
    try {
      const { container } = setup({ quickAdd: false, marked: [5] });
      await loaded();
      expect(await axe(container)).toHaveNoViolations();
    } finally {
      delete document.documentElement.dataset.theme;
    }
  });
});

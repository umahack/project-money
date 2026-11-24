// The Spending page while Quick_Add_Enabled (Requirements 7.17, 7.21, 18.15, 18.16, 18.17), against the fake
// Spending backend with the Quick Add additions (the mark on the list rows, on the record, and on update):
//
// - the text "Not counted in daily allowance" beside each marked expense, never colour alone,
// - the per-row control and the edit-form checkbox, each sending only a changed mark, with a scoped status and retry,
// - the confirmed-change bus: create, update, delete, and move events change the list in place, with no list read,
//   no page-wide loading, the server's snapshot read again for the totals, other months ignored, duplicates folded,
// - the subscription ends when the page unmounts, and the logging streak card reads again on a confirmed change,
// - with the Quick_Add_Flag off, none of it exists,
// - axe in both themes.
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
import { StreakCard } from '../components/StreakCard';
import { currentMonth, monthLabel } from '../money';
import { FakeQuickAddBackend } from '../test/fakeQuickAddBackend';
import type { FakeSpendingInit, SpendingBackendReply } from '../test/fakeSpendingBackend';
import { installSpendingFetch } from '../test/fakeSpendingFetch';
import { axe, createApiResponse, createTestQueryClient, renderAuthenticated } from '../test/test-utils';
import { Spending } from './Spending';

const MONTH = currentMonth();
const MONTH_NAME = monthLabel(MONTH);
const PRIOR = (() => {
  const now = new Date();
  const prior = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${prior.getFullYear()}-${String(prior.getMonth() + 1).padStart(2, '0')}`;
})();
const MARKED = 'Not counted in daily allowance';

/** Ids 1 to 4. The list shows 4, 3, 2, 1. Spent 1,300 in all. */
const BASE: NonNullable<FakeSpendingInit['expenses']> = [
  { category: 'Food', amount: 500 },
  { category: 'Shopping', amount: 500 },
  { category: 'Transport', amount: 100 },
  { category: 'Food', amount: 200, note: 'Dinner' },
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

const rowOf = (id: number) => document.getElementById(`expense-${id}`) as HTMLElement | null;
const statusOf = (scope: string) => document.querySelector(`[data-scope="${scope}"]`) as HTMLElement;
const card = () => screen.getByRole('article', { name: `Spending for ${MONTH_NAME}` });
const spentSoFar = () => (within(card()).getByText('Spent so far').closest('.clarity-value')?.querySelector('.clarity-value-amount') as HTMLElement).textContent;
const entriesHeading = () => screen.getByRole('heading', { name: `Recent entries for ${MONTH_NAME}` });
const rowIds = () => Array.from(document.querySelectorAll('[data-expense-id]')).map((row) => Number(row.getAttribute('data-expense-id')));
const dontCount = (category: string, amount: string) => screen.getByRole('button', { name: `Don't count in daily allowance, ${category} ${amount}` });
const countAgain = (category: string, amount: string) => screen.getByRole('button', { name: `Count in daily allowance, ${category} ${amount}` });
/** How many times the page read the list, the snapshot, and the two supporting sections. */
const readsOf = (net: ReturnType<typeof installSpendingFetch>) =>
  ['/finance/expenses', '/finance/clarity', '/finance/insights', '/finance/history'].map((path) => net.to('GET', path).length);
const patches = (net: ReturnType<typeof installSpendingFetch>, id: number) => net.to('PATCH', `/finance/expenses/${id}`);

async function loaded() {
  await screen.findByRole('article', { name: `Spending for ${MONTH_NAME}` });
  await waitFor(() => expect(rowOf(1)).toBeInTheDocument());
  await screen.findByText('Food', { selector: '.pill' });
}

/** What Quick Add does after the server confirms: tell every mounted view. */
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
  return change;
}

function createViaQuickAdd(backend: FakeQuickAddBackend, input: { amountMinor: number; category: string; note?: string; spentOn: string; mark?: boolean }) {
  return backend.handle({
    method: 'POST',
    path: '/finance/expenses',
    body: { amountMinor: input.amountMinor, category: input.category, ...(input.note ? { note: input.note } : {}), spentOn: input.spentOn, ...(input.mark === undefined ? {} : { excludeFromDailyAllowance: input.mark }) },
    headers: { 'idempotency-key': `qa-${input.spentOn}-${input.amountMinor}` },
  });
}

beforeEach(() => {
  resetExpenseEventsForTests();
});

afterEach(() => {
  resetExpenseEventsForTests();
  vi.unstubAllEnvs();
});

describe('the mark on each expense', () => {
  it('shows "Not counted in daily allowance" as text on each marked expense only, with a control on every row', async () => {
    setup({ marked: [2, 4] });
    await loaded();
    expect(within(rowOf(2) as HTMLElement).getByText(MARKED)).toBeInTheDocument();
    expect(within(rowOf(4) as HTMLElement).getByText(MARKED)).toBeInTheDocument();
    expect(within(rowOf(1) as HTMLElement).queryByText(MARKED)).toBeNull();
    expect(within(rowOf(3) as HTMLElement).queryByText(MARKED)).toBeNull();
    expect(document.querySelectorAll('.spending-excluded')).toHaveLength(2);
    expect(countAgain('Shopping', '₹500')).toBeInTheDocument();
    expect(dontCount('Food', '₹500')).toBeInTheDocument();
  });

  it('sets the mark alone from the row, keeps focus on the same button, and sends nothing else', async () => {
    const user = userEvent.setup();
    const { net } = setup();
    await loaded();
    const totalBefore = spentSoFar();
    const button = dontCount('Food', '₹500');
    button.focus();
    await user.click(button);

    await waitFor(() => expect(within(rowOf(1) as HTMLElement).getByText(MARKED)).toBeInTheDocument());
    await waitFor(() => expect(statusOf('expense:1')).toHaveTextContent('done'));
    const sent = patches(net, 1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toEqual({ excludeFromDailyAllowance: true });
    expect(sent[0]?.headers['idempotency-key']).toBeTruthy();
    expect(sent[0]?.headers['x-clarity-contract']).toBe('1');
    // The same button stays, now offering the opposite, and still holds focus. No total moved.
    expect(countAgain('Food', '₹500')).toBe(button);
    expect(document.activeElement).toBe(button);
    expect(spentSoFar()).toBe(totalBefore);
    expect(net.to('GET', '/finance/expenses')).toHaveLength(1);
  });

  it('clears the mark from the row with the confirmed record version', async () => {
    const user = userEvent.setup();
    const { net } = setup({ marked: [1] });
    await loaded();
    await user.click(countAgain('Food', '₹500'));
    await waitFor(() => expect(within(rowOf(1) as HTMLElement).queryByText(MARKED)).toBeNull());
    await waitFor(() => expect(statusOf('expense:1')).toHaveTextContent('done'));
    expect(patches(net, 1)[0]?.body).toEqual({ excludeFromDailyAllowance: false });

    // The next change to the same expense carries the version the first one returned.
    await user.click(dontCount('Food', '₹500'));
    await waitFor(() => expect(patches(net, 1)).toHaveLength(2));
    expect(patches(net, 1)[1]?.body).toEqual({ excludeFromDailyAllowance: true, expectedRecordVersion: 2 });
  });

  it('keeps the confirmed row and offers a retry with the same key when the change fails', async () => {
    const user = userEvent.setup();
    const { backend, net } = setup();
    await loaded();
    backend.failNext('PATCH', '/finance/expenses/1', 500, 'SERVER_ERROR', 'The change could not be saved.');
    await user.click(dontCount('Food', '₹500'));

    await waitFor(() => expect(statusOf('expense:1')).toHaveTextContent('failed'));
    expect(within(rowOf(1) as HTMLElement).queryByText(MARKED)).toBeNull();
    // Only this row reports it. The other rows and the totals are untouched.
    expect(statusOf('expense:2')).toHaveTextContent('');
    expect(spentSoFar()).toBe('₹1,300');

    await user.click(within(statusOf('expense:1')).getByRole('button', { name: /^Retry / }));
    await waitFor(() => expect(within(rowOf(1) as HTMLElement).getByText(MARKED)).toBeInTheDocument());
    const sent = patches(net, 1);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.body).toEqual({ excludeFromDailyAllowance: true });
    expect(sent[1]?.headers['idempotency-key']).toBe(sent[0]?.headers['idempotency-key']);
  });

  it('offers the labelled checkbox with its note in the edit form and sends the mark only when it changed', async () => {
    const user = userEvent.setup();
    const { net } = setup({ marked: [2] });
    await loaded();

    // Marked and unchanged: nothing to save.
    await user.click(screen.getByRole('button', { name: 'Edit Shopping ₹500' }));
    let form = screen.getByRole('form', { name: 'Correct Shopping ₹500' });
    const checkbox = within(form).getByRole('checkbox', { name: MARKED });
    expect(checkbox).toBeChecked();
    expect(checkbox).toHaveAccessibleDescription(/only the daily allowance of the day this expense is dated/);
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    expect(within(form).getByText(/has no changes to save/)).toBeInTheDocument();
    expect(patches(net, 2)).toHaveLength(0);

    // Only the mark changed.
    await user.click(checkbox);
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(patches(net, 2)).toHaveLength(1));
    expect(patches(net, 2)[0]?.body).toEqual({ excludeFromDailyAllowance: false });
    await waitFor(() => expect(within(rowOf(2) as HTMLElement).queryByText(MARKED)).toBeNull());

    // Only the amount changed: the mark is not sent.
    await user.click(screen.getByRole('button', { name: 'Edit Shopping ₹500' }));
    form = screen.getByRole('form', { name: 'Correct Shopping ₹500' });
    expect(within(form).getByRole('checkbox', { name: MARKED })).not.toBeChecked();
    const amount = within(form).getByRole('textbox', { name: 'Amount' });
    fireEvent.change(amount, { target: { value: '450' } });
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(patches(net, 2)).toHaveLength(2));
    expect(patches(net, 2)[1]?.body).toEqual(expect.objectContaining({ amountMinor: 45000 }));
    expect(patches(net, 2)[1]?.body).not.toHaveProperty('excludeFromDailyAllowance');
  });
});

describe('Quick Add confirmations while Spending is mounted', () => {
  it('inserts a created expense with its mark, reads no list, and reads the server totals again', async () => {
    const { backend, net } = setup();
    await loaded();
    const others = [rowOf(1), rowOf(3), rowOf(4)];
    const snapshotReads = net.to('GET', '/finance/clarity').length;

    const reply = createViaQuickAdd(backend, { amountMinor: 12_000, category: 'Food', note: 'Tea', spentOn: `${MONTH}-12`, mark: true });
    confirm('create', reply, { original: null, resulting: MONTH }, { resulting: 'Food' });

    const created = (reply.body as { mutation: { recordId: number } }).mutation.recordId;
    await waitFor(() => expect(rowOf(created)).toBeInTheDocument());
    expect(within(rowOf(created) as HTMLElement).getByText(MARKED)).toBeInTheDocument();
    expect(within(rowOf(created) as HTMLElement).getByText(/Tea/)).toBeInTheDocument();
    expect(rowIds()).toEqual([created, 4, 3, 2, 1]);
    // Other rows are the same elements, so nothing remounted and no focus moved.
    expect([rowOf(1), rowOf(3), rowOf(4)]).toEqual(others);
    expect(net.to('GET', '/finance/expenses')).toHaveLength(1);
    // The month's total is the server's, read again, never summed in the browser.
    await waitFor(() => expect(spentSoFar()).toBe('₹1,420'));
    expect(net.to('GET', '/finance/clarity').length).toBeGreaterThan(snapshotReads);
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('replaces an updated expense in place, including a changed mark', async () => {
    const { backend, net } = setup();
    await loaded();
    const reply = backend.handle({
      method: 'PATCH',
      path: '/finance/expenses/1',
      body: { category: 'Transport', amountMinor: 55_000, excludeFromDailyAllowance: true },
      headers: { 'idempotency-key': 'qa-update-1' },
    });
    confirm('update', reply, { original: MONTH, resulting: MONTH }, { original: 'Food', resulting: 'Transport' });

    await waitFor(() => expect(within(rowOf(1) as HTMLElement).getByText('Transport')).toBeInTheDocument());
    expect(within(rowOf(1) as HTMLElement).getByText('₹550')).toBeInTheDocument();
    expect(within(rowOf(1) as HTMLElement).getByText(MARKED)).toBeInTheDocument();
    expect(rowIds().filter((id) => id === 1)).toHaveLength(1);
    expect(screen.getByRole('button', { name: "Count in daily allowance, Transport ₹550" })).toBeInTheDocument();
    expect(net.to('GET', '/finance/expenses')).toHaveLength(1);
  });

  it('removes a deleted expense and hands focus to the list heading when the row held it', async () => {
    const { backend } = setup();
    await loaded();
    screen.getByRole('button', { name: 'Edit Transport ₹100' }).focus();
    expect(rowOf(3)?.contains(document.activeElement)).toBe(true);

    const reply = backend.handle({ method: 'DELETE', path: '/finance/expenses/3', body: {}, headers: { 'idempotency-key': 'qa-delete-3' } });
    confirm('delete', reply, { original: MONTH, resulting: null }, { original: 'Transport' });

    await waitFor(() => expect(rowOf(3)).toBeNull());
    expect(rowIds()).toEqual([4, 2, 1]);
    await waitFor(() => expect(document.activeElement).toBe(entriesHeading()));
    await waitFor(() => expect(spentSoFar()).toBe('₹1,200'));
  });

  it('removes an expense that moved to another month and adds one that moved in', async () => {
    const { backend } = setup();
    await loaded();

    const moveOut = backend.handle({
      method: 'PATCH',
      path: '/finance/expenses/2',
      body: { spentOn: `${PRIOR}-05` },
      headers: { 'idempotency-key': 'qa-move-out' },
    });
    confirm('update', moveOut, { original: MONTH, resulting: PRIOR }, { original: 'Shopping', resulting: 'Shopping' });
    await waitFor(() => expect(rowOf(2)).toBeNull());
    expect(rowIds()).toEqual([4, 3, 1]);

    const moveIn = backend.handle({
      method: 'PATCH',
      path: '/finance/expenses/2',
      body: { spentOn: `${MONTH}-15` },
      headers: { 'idempotency-key': 'qa-move-in' },
    });
    confirm('update', moveIn, { original: PRIOR, resulting: MONTH }, { original: 'Shopping', resulting: 'Shopping' });
    await waitFor(() => expect(rowOf(2)).toBeInTheDocument());
    expect(rowIds()).toEqual([2, 4, 3, 1]);
  });

  it('ignores a change for another month and reads nothing for it', async () => {
    const { backend, net } = setup();
    await loaded();
    const reads = readsOf(net);
    const reply = createViaQuickAdd(backend, { amountMinor: 9_900, category: 'Food', spentOn: `${PRIOR}-20` });
    confirm('create', reply, { original: null, resulting: PRIOR }, { resulting: 'Food' });

    expect(rowIds()).toEqual([4, 3, 2, 1]);
    expect(readsOf(net)).toEqual(reads);
    expect(spentSoFar()).toBe('₹1,300');
  });

  it('shows an expense once when the same confirmation arrives twice', async () => {
    const { backend } = setup();
    await loaded();
    const reply = createViaQuickAdd(backend, { amountMinor: 7_500, category: 'Other', note: 'Once', spentOn: `${MONTH}-11` });
    const created = (reply.body as { mutation: { recordId: number } }).mutation.recordId;
    confirm('create', reply, { original: null, resulting: MONTH }, { resulting: 'Other' });
    confirm('create', reply, { original: null, resulting: MONTH }, { resulting: 'Other' });

    await waitFor(() => expect(rowOf(created)).toBeInTheDocument());
    expect(rowIds().filter((id) => id === created)).toHaveLength(1);
    expect(rowIds()).toHaveLength(5);
  });

  it('stops following the bus when the page unmounts', async () => {
    const { backend, net, unmount } = setup();
    await loaded();
    const reads = readsOf(net);
    unmount();
    const reply = createViaQuickAdd(backend, { amountMinor: 1_000, category: 'Food', spentOn: `${MONTH}-12` });
    expect(() => confirm('create', reply, { original: null, resulting: MONTH })).not.toThrow();
    expect(readsOf(net)).toEqual(reads);
  });
});

describe('with the Quick_Add_Flag off', () => {
  it('shows no mark text and no control, sends no mark, and ignores the bus', async () => {
    const user = userEvent.setup();
    const { backend, net } = setup({ quickAdd: false, marked: [2] });
    await loaded();
    expect(screen.queryByText(MARKED)).toBeNull();
    expect(screen.queryByRole('button', { name: /daily allowance/ })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Edit Shopping ₹500' }));
    const form = screen.getByRole('form', { name: 'Correct Shopping ₹500' });
    expect(within(form).queryByRole('checkbox')).toBeNull();
    fireEvent.change(within(form).getByRole('textbox', { name: 'Amount' }), { target: { value: '450' } });
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(patches(net, 2)).toHaveLength(1));
    expect(patches(net, 2)[0]?.body).not.toHaveProperty('excludeFromDailyAllowance');

    const reads = readsOf(net);
    const reply = createViaQuickAdd(backend, { amountMinor: 12_000, category: 'Food', spentOn: `${MONTH}-12` });
    confirm('create', reply, { original: null, resulting: MONTH });
    expect(rowIds()).toHaveLength(4);
    expect(readsOf(net)).toEqual(reads);
  });
});

describe('the logging streak card', () => {
  const streak = (current: number) => ({ current, longest: 9, days_logged: 20 });

  function renderStreak(quickAdd: boolean) {
    vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'true');
    vi.stubEnv('VITE_QUICK_ADD_ENABLED', quickAdd ? 'true' : '');
    let reads = 0;
    vi.mocked(globalThis.fetch).mockImplementation(async () => {
      reads += 1;
      return createApiResponse({ body: streak(reads === 1 ? 2 : 3) });
    });
    renderAuthenticated(<StreakCard />);
    return { reads: () => reads };
  }

  const changeEvent = (): ConfirmedExpenseChange => ({
    confirmed: true,
    kind: 'create',
    expenseId: 9,
    originalMonth: null,
    resultingMonth: MONTH,
    originalCategory: null,
    resultingCategory: 'Food',
    excludedFromDailyAllowance: null,
    record: { id: 9, month: MONTH, category: 'Food', amountMinor: 1000 },
  });

  it('reads the server streak again after a confirmed change and keeps showing the card', async () => {
    const { reads } = renderStreak(true);
    expect(await screen.findByText('Day 2. Keep it up.')).toBeInTheDocument();
    act(() => publishExpenseChange(changeEvent()));
    expect(await screen.findByText('Day 3. Keep it up.')).toBeInTheDocument();
    expect(reads()).toBe(2);
  });

  it('does not follow the bus while the flag is off', async () => {
    const { reads } = renderStreak(false);
    expect(await screen.findByText('Day 2. Keep it up.')).toBeInTheDocument();
    act(() => publishExpenseChange(changeEvent()));
    expect(reads()).toBe(1);
  });
});

describe.each(['light', 'dark'] as const)('accessibility in the %s theme', (theme) => {
  it('has no violations with marked rows, a failed change, and an open edit form', async () => {
    document.documentElement.dataset.theme = theme;
    try {
      const user = userEvent.setup();
      const { backend, container } = setup({ marked: [2, 4] });
      await loaded();
      backend.failNext('PATCH', '/finance/expenses/1', 500, 'SERVER_ERROR', 'The change could not be saved.');
      await user.click(dontCount('Food', '₹500'));
      await waitFor(() => expect(statusOf('expense:1')).toHaveTextContent('failed'));
      await user.click(screen.getByRole('button', { name: 'Edit Shopping ₹500' }));
      expect(screen.getByRole('checkbox', { name: MARKED })).toBeChecked();
      expect(await axe(container)).toHaveNoViolations();
    } finally {
      delete document.documentElement.dataset.theme;
    }
  });
});

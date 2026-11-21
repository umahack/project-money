// The Spending page rendered against a fake API that implements the financial
// clarity contract for expenses and category treatments (snapshot reads, mutation
// envelopes with original and resulting period and category, record versions,
// 409 conflicts, idempotent replays). It covers what Spending.clarity.test.tsx
// does not:
//
// - each transition (create, edit, move category, move month, delete, reclassify)
//   leaves the month on screen with the server's exact category totals, once,
// - reclassifying Needs/Wants moves spending between buckets and nothing else,
// - the exceeded-budget action appears only with the server's exact excess,
// - concurrent changes in different scopes whose responses arrive in reverse order,
// - same-scope duplicates, scoped rollback, retries with the same key, a lost
//   response that is replayed, and a 409 conflict,
// - focus after a retried new expense is replaced by its saved row, and keyboard
//   operation of the row and treatment controls,
// - live announcements for outcomes whose values did not change,
// - feedback timing against a controlled clock (no wall-clock waits),
// - axe in both themes for pending, failed, calculation-failed, and exceeded states.
//
// Timing in jsdom has no paint. Here a "frame" is 16 ms of fake time and every
// budget is checked against the fake clock; response-to-paint in a real browser
// is covered by e2e/spending.clarity.spec.ts. jsdom cannot compute color
// contrast, so contrast is left to the browser acceptance checks.
import { readFileSync } from 'node:fs';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MoneyValue, SpendingOutcomeValue } from '../clarity/contracts';
import { FinancialClarityProvider } from '../clarity/FinancialClarityProvider';
import { MutationStatusProvider } from '../clarity/MutationStatusProvider';
import { formatMoney } from '../components/clarity/format';
import { OutcomeCard } from '../components/clarity/OutcomeCard';
import { currentMonth, inr, monthLabel } from '../money';
import { FakeSpendingBackend, type FakeSpendingInit } from '../test/fakeSpendingBackend';
import { installSpendingFetch } from '../test/fakeSpendingFetch';
import { spendingSnapshot } from '../test/spendingFixtures';
import { axe, createTestQueryClient, renderAuthenticated } from '../test/test-utils';
import { Spending } from './Spending';

const MONTH = currentMonth();
const MONTH_NAME = monthLabel(MONTH);
const PRIOR = (() => {
  const now = new Date();
  const prior = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${prior.getFullYear()}-${String(prior.getMonth() + 1).padStart(2, '0')}`;
})();
const paise = (rupees: number) => Math.round(rupees * 100);

/**
 * Food 700 and Transport 100 count as Needs by default; Shopping 500 as Wants.
 * Spent 1,300 of a 64,000 budget. Rows list newest first: 4, 3, 2, 1.
 */
const BASE: NonNullable<FakeSpendingInit['expenses']> = [
  { category: 'Food', amount: 500 },
  { category: 'Shopping', amount: 500 },
  { category: 'Transport', amount: 100 },
  { category: 'Food', amount: 200, note: 'Dinner' },
];

function setup(init: FakeSpendingInit = {}, route = '/spending') {
  const backend = new FakeSpendingBackend(MONTH, { expenses: BASE, ...init });
  const net = installSpendingFetch(backend);
  const view = renderAuthenticated(
    <FinancialClarityProvider>
      <MutationStatusProvider>
        <Spending />
      </MutationStatusProvider>
    </FinancialClarityProvider>,
    { route, queryClient: createTestQueryClient() },
  );
  return { backend, net, ...view };
}

const card = () => screen.getByRole('article', { name: `Spending for ${MONTH_NAME}` });
const amountOf = (label: string) => (within(card()).getByText(label).closest('.clarity-value')?.querySelector('.clarity-value-amount') as HTMLElement).textContent;
const statusOf = (scope: string) => document.querySelector(`[data-scope="${scope}"]`) as HTMLElement;
const rowOf = (id: number) => document.getElementById(`expense-${id}`) as HTMLElement;
const pendingCreate = () => document.querySelector('[data-pending-create]') as HTMLElement;
const categoryRow = (category: string) => screen.getByText(category, { selector: '.pill' }).closest('li') as HTMLElement;
const categoryTotal = (category: string) => (categoryRow(category).querySelector('b.mono') as HTMLElement).textContent;
const editButton = (category: string, amount: string) => screen.getByRole('button', { name: `Edit ${category} ${amount}` });
const deleteButton = (category: string, amount: string) => screen.getByRole('button', { name: `Delete ${category} ${amount}` });
const logButton = () => screen.getByRole('button', { name: '+ Log expense' });
const treatmentButton = (category: string, to: 'Needs' | 'Wants') => screen.getByRole('button', { name: `Count ${category} as ${to}` });
const entriesHeading = () => screen.getByRole('heading', { name: `Recent entries for ${MONTH_NAME}` });
const notice = () => screen.getByRole('region', { name: 'Latest change to your spending' });
const live = () => card().querySelector('[aria-live="polite"]') as HTMLElement;
/** Changes the backend has applied. Held requests are not counted until released. */
const nonGetCalls = (backend: FakeSpendingBackend) => backend.log.filter((entry) => entry.method !== 'GET');
/** Changes the page has sent, held or not. */
const sentChanges = (net: ReturnType<typeof installSpendingFetch>) => net.calls.filter((call) => call.method !== 'GET');

async function loaded() {
  await screen.findByRole('article', { name: `Spending for ${MONTH_NAME}` });
  await waitFor(() => expect(rowOf(1)).toBeInTheDocument());
  await screen.findByText('Food', { selector: '.pill' });
}

function fillLog(amount: string, note?: string) {
  fireEvent.change(screen.getByRole('textbox', { name: 'Amount' }), { target: { value: amount } });
  if (note !== undefined) fireEvent.change(screen.getByRole('textbox', { name: 'Note (optional)' }), { target: { value: note } });
}

/** Clicks inside act so pending feedback is checked before any await. */
function click(element: HTMLElement) {
  act(() => {
    fireEvent.click(element);
  });
}

async function openEdit(user: ReturnType<typeof userEvent.setup>, category: string, amount: string) {
  await user.click(editButton(category, amount));
  return screen.getByRole('form', { name: `Correct ${category} ${amount}` });
}

const formAmount = (form: HTMLElement) => within(form).getByRole('textbox', { name: 'Amount' });
const saveButton = (form: HTMLElement) => within(form).getByRole('button', { name: 'Save changes' });

/** What the server calculated, as the page must show it. */
function expectScreenMatches(backend: FakeSpendingBackend) {
  const value = backend.snapshot().outcomes.spending.value as SpendingOutcomeValue;
  const money = (amount: MoneyValue) => formatMoney(amount);
  expect(amountOf('Spent so far')).toBe(money(value.totalSpending));
  expect(amountOf('Spendable budget')).toBe(money(value.spendableBudget));
  expect(amountOf('Remaining spendable')).toBe(money(value.remainingSpendable));
  expect(amountOf('Daily spending guide')).toBe(money(value.dailySpendingGuide));
  expect(amountOf('Projected savings')).toBe(money(value.projectedSavings));
  expect(amountOf('Needs spent of budget')).toBe(`${money(value.needsSpent)} of ${money(value.needsBudget)}`);
  expect(amountOf('Wants spent of budget')).toBe(`${money(value.wantsSpent)} of ${money(value.wantsBudget)}`);
  const shown = Array.from(document.querySelectorAll('.spending-category')).map((item) => item.getAttribute('data-category'));
  expect(shown.sort()).toEqual(value.categoryTotals.map((total) => total.category).sort());
  for (const total of value.categoryTotals) expect(categoryTotal(total.category)).toBe(money(total.total));
  for (const applied of value.appliedTreatments) {
    expect(categoryRow(applied.category)).toHaveTextContent(
      `Counted as ${applied.treatment === 'needs' ? 'Needs' : 'Wants'} (${applied.source === 'override' ? 'your choice' : 'default'})`,
    );
  }
}

const reload = vi.fn();
beforeEach(() => {
  vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'true');
  reload.mockClear();
  vi.stubGlobal('location', { ...window.location, reload });
});

describe('each transition updates the month on screen exactly once', () => {
  it('create: adds the confirmed amount to its category once', async () => {
    const { backend, net } = setup();
    await loaded();
    expect(categoryTotal('Food')).toBe('₹700');
    expect(amountOf('Spent so far')).toBe('₹1,300');
    const gate = net.hold('POST', '/finance/expenses');

    fillLog('170', 'Lunch');
    click(logButton());
    // Calculated values keep their last confirmed numbers until the server answers.
    expect(pendingCreate()).toHaveTextContent('Saving this expense…');
    expect(categoryTotal('Food')).toBe('₹700');
    expect(amountOf('Spent so far')).toBe('₹1,300');

    await act(async () => {
      gate.release();
    });
    await waitFor(() => expect(rowOf(5)).toBeInTheDocument());
    expect(categoryTotal('Food')).toBe('₹870');
    expect(amountOf('Spent so far')).toBe('₹1,470');
    expect(amountOf('Remaining spendable')).toBe('₹62,530');
    expect(amountOf('Needs spent of budget')).toBe('₹970 of ₹40,000');
    expect(amountOf('Projected savings')).toBe('₹78,530');
    expectScreenMatches(backend);
    expect(document.querySelectorAll('[data-expense-id="5"]')).toHaveLength(1);
    expect(pendingCreate()).toBeNull();
    expect(backend.expenses).toHaveLength(5);
    expect(net.to('POST', '/finance/expenses')).toHaveLength(1);
    expect(net.to('GET', '/finance/expenses')).toHaveLength(1);
    expect(reload).not.toHaveBeenCalled();
  });

  it('edit: replaces the preceding amount in the same category instead of adding to it', async () => {
    const user = userEvent.setup();
    const { backend, net } = setup();
    await loaded();
    const form = await openEdit(user, 'Food', '₹500');
    fireEvent.change(formAmount(form), { target: { value: '650' } });
    await user.click(saveButton(form));

    await waitFor(() => expect(statusOf('expense:1')).toHaveTextContent('Update Food expense: done'));
    expect(categoryTotal('Food')).toBe('₹850');
    expect(amountOf('Spent so far')).toBe('₹1,450');
    expect(amountOf('Needs spent of budget')).toBe('₹950 of ₹40,000');
    expect(rowOf(1)).toHaveTextContent('₹650');
    expect(editButton('Food', '₹650')).toHaveFocus();
    expectScreenMatches(backend);
    expect(net.to('PATCH', '/finance/expenses/1')[0]?.body).toEqual({ amountMinor: paise(650) });
    expect(notice()).toHaveTextContent(`Updated Food for ${MONTH_NAME}.`);
  });

  it('move category: removes the amount from the original category and adds it to the resulting one', async () => {
    const user = userEvent.setup();
    const { backend, net } = setup();
    await loaded();
    const form = await openEdit(user, 'Food', '₹200');
    fireEvent.change(within(form).getByRole('combobox', { name: 'Category' }), { target: { value: 'Shopping' } });
    await user.click(saveButton(form));

    await waitFor(() => expect(statusOf('expense:4')).toHaveTextContent('Update Food expense: done'));
    expect(categoryTotal('Food')).toBe('₹500');
    expect(categoryTotal('Shopping')).toBe('₹700');
    // Food was Needs and Shopping is Wants, so the buckets move; the total does not.
    expect(amountOf('Needs spent of budget')).toBe('₹600 of ₹40,000');
    expect(amountOf('Wants spent of budget')).toBe('₹700 of ₹24,000');
    expect(amountOf('Spent so far')).toBe('₹1,300');
    expect(amountOf('Remaining spendable')).toBe('₹62,700');
    expectScreenMatches(backend);
    expect(net.to('PATCH', '/finance/expenses/4')[0]?.body).toEqual({ category: 'Shopping' });
    expect(notice()).toHaveTextContent(`Moved from Food in ${MONTH_NAME} to Shopping in ${MONTH_NAME}.`);
    expect(notice()).toHaveTextContent(`Recalculated: ${MONTH_NAME}.`);
  });

  it('move month: takes the amount out of this month once and leaves the other month for its own page', async () => {
    const user = userEvent.setup();
    const { backend, net } = setup();
    await loaded();
    const form = await openEdit(user, 'Shopping', '₹500');
    fireEvent.change(within(form).getByLabelText(/^Date/), { target: { value: `${PRIOR}-20` } });
    await user.click(saveButton(form));

    await waitFor(() => expect(rowOf(2)).toBeNull());
    await waitFor(() => expect(screen.queryByText('Shopping', { selector: '.pill' })).toBeNull());
    expect(amountOf('Spent so far')).toBe('₹800');
    expect(amountOf('Wants spent of budget')).toBe('₹0 of ₹24,000');
    expect(amountOf('Remaining spendable')).toBe('₹63,200');
    expect(amountOf('Projected savings')).toBe('₹79,200');
    expectScreenMatches(backend);
    // The other month holds it now, once.
    const prior = backend.snapshot(PRIOR).outcomes.spending.value as SpendingOutcomeValue;
    expect(prior.categoryTotals).toEqual([expect.objectContaining({ category: 'Shopping', total: { currency: 'INR', amountMinor: paise(500) } })]);
    expect(notice()).toHaveTextContent(`Moved from Shopping in ${MONTH_NAME} to Shopping in ${monthLabel(PRIOR)}.`);
    expect(notice()).toHaveTextContent(`Recalculated: ${MONTH_NAME} and ${monthLabel(PRIOR)}.`);
    // One snapshot read at load, one to bring the month on screen up to date. No list re-read.
    expect(net.to('GET', '/finance/clarity')).toHaveLength(2);
    expect(net.to('GET', '/finance/expenses')).toHaveLength(1);
    expect(net.to('PATCH', '/finance/expenses/2')).toHaveLength(1);
  });

  it('delete: removes the preceding amount once from its category and the outcomes', async () => {
    const user = userEvent.setup();
    const { backend, net } = setup();
    await loaded();
    await user.click(deleteButton('Transport', '₹100'));

    await waitFor(() => expect(rowOf(3)).toBeNull());
    expect(screen.queryByText('Transport', { selector: '.pill' })).toBeNull();
    expect(amountOf('Spent so far')).toBe('₹1,200');
    expect(amountOf('Needs spent of budget')).toBe('₹700 of ₹40,000');
    expect(amountOf('Remaining spendable')).toBe('₹62,800');
    expectScreenMatches(backend);
    expect(net.to('DELETE', '/finance/expenses/3')).toHaveLength(1);
    expect(notice()).toHaveTextContent(`Removed from Transport for ${MONTH_NAME}.`);
  });

  it('reclassify: moves spending between Needs and Wants and leaves total spending, remaining, and projected savings alone', async () => {
    const user = userEvent.setup();
    const { backend, net } = setup();
    await loaded();
    const unchanged = () => ({
      spent: amountOf('Spent so far'),
      spendable: amountOf('Spendable budget'),
      remaining: amountOf('Remaining spendable'),
      daily: amountOf('Daily spending guide'),
      projected: amountOf('Projected savings'),
      target: amountOf('Savings target'),
    });
    const before = unchanged();
    expect(before.spent).toBe('₹1,300');
    expect(before.projected).toBe('₹78,700');
    const gate = net.hold('PUT', '/finance/category-treatments/Food');

    click(treatmentButton('Food', 'Wants'));
    expect(statusOf('category-treatment:food')).toHaveTextContent('Count Food as Wants: pending');
    expect(treatmentButton('Food', 'Wants')).toHaveAttribute('aria-pressed', 'true');
    // The chosen treatment shows at once; calculated buckets wait for the server.
    expect(amountOf('Needs spent of budget')).toBe('₹800 of ₹40,000');
    expect(unchanged()).toEqual(before);

    await act(async () => {
      gate.release();
    });
    await waitFor(() => expect(statusOf('category-treatment:food')).toHaveTextContent('Count Food as Wants: done'));
    expect(amountOf('Needs spent of budget')).toBe('₹100 of ₹40,000');
    expect(amountOf('Wants spent of budget')).toBe('₹1,200 of ₹24,000');
    expect(unchanged()).toEqual(before);
    expect(categoryTotal('Food')).toBe('₹700');
    expectScreenMatches(backend);
    expect(net.to('PUT', '/finance/category-treatments/Food')[0]?.body).toEqual({ treatment: 'wants' });
    expect(notice()).toHaveTextContent('Food now counts as Wants.');

    // Restoring the default moves it back, and sends the version the first change returned.
    await user.click(screen.getByRole('button', { name: 'Use the default treatment for Food' }));
    await waitFor(() => expect(statusOf('category-treatment:food')).toHaveTextContent('Use the default for Food: done'));
    expect(amountOf('Needs spent of budget')).toBe('₹800 of ₹40,000');
    expect(amountOf('Wants spent of budget')).toBe('₹500 of ₹24,000');
    expect(unchanged()).toEqual(before);
    expect(net.to('DELETE', '/finance/category-treatments/Food')[0]?.body).toEqual({ expectedRecordVersion: 1 });
    expectScreenMatches(backend);
  });
});

describe('exceeded Needs and Wants budgets', () => {
  const needsRegion = () => screen.queryByRole('region', { name: 'Needs budget exceeded' });
  const wantsRegion = () => screen.queryByRole('region', { name: 'Wants budget exceeded' });

  it('shows one corrective action with the exact excess, only for the bucket that is over, and only once the server says so', async () => {
    const user = userEvent.setup();
    const { backend, net } = setup({
      needsBudget: 1000,
      wantsBudget: 1400,
      expenses: [{ category: 'Food', amount: 500 }, { category: 'Shopping', amount: 500 }, { category: 'Transport', amount: 100 }],
    });
    await loaded();
    expect(needsRegion()).toBeNull();
    expect(wantsRegion()).toBeNull();
    const gate = net.hold('POST', '/finance/expenses');

    // Needs: 500 + 100 + 600 = 1,200 against 1,000.
    fillLog('600');
    click(logButton());
    expect(needsRegion()).toBeNull();
    await act(async () => {
      gate.release();
    });
    await waitFor(() => expect(needsRegion()).toBeInTheDocument());
    const needs = needsRegion() as HTMLElement;
    expect(needs).toHaveTextContent('Needs budget exceeded by ₹200.');
    expect(needs).toHaveTextContent('You have spent ₹1,200 of ₹1,000.');
    expect(within(needs).getAllByRole('link')).toHaveLength(1);
    expect(within(needs).getByRole('link', { name: /Review Needs spending/ })).toHaveAttribute('href', '/spending?action=review-budget&bucket=needs');
    expect(wantsRegion()).toBeNull();
    expectScreenMatches(backend);

    // Reclassify Food as Wants: Needs falls to 100 and Wants rises to 500 + 1,100 = 1,600 against 1,400.
    await user.click(treatmentButton('Food', 'Wants'));
    await waitFor(() => expect(wantsRegion()).toBeInTheDocument());
    expect(needsRegion()).toBeNull();
    const wants = wantsRegion() as HTMLElement;
    expect(wants).toHaveTextContent('Wants budget exceeded by ₹200.');
    expect(wants).toHaveTextContent('You have spent ₹1,600 of ₹1,400.');
    expect(within(wants).getAllByRole('link')).toHaveLength(1);
    expect(within(wants).getByRole('link', { name: /Review Wants spending/ })).toHaveAttribute('href', '/spending?action=review-budget&bucket=wants');
    expectScreenMatches(backend);

    // Deleting the large expense brings Wants back under budget: no action remains.
    await user.click(deleteButton('Food', '₹600'));
    await waitFor(() => expect(wantsRegion()).toBeNull());
    expect(needsRegion()).toBeNull();
    expect(card()).not.toHaveTextContent('exceeded');
    expectScreenMatches(backend);
  });

  it('shows both buckets when both are over, each with its own excess', async () => {
    setup({ needsBudget: 500, wantsBudget: 300 });
    await loaded();
    expect(needsRegion()).toHaveTextContent('Needs budget exceeded by ₹300.');
    expect(wantsRegion()).toHaveTextContent('Wants budget exceeded by ₹200.');
    expect(screen.getAllByRole('region', { name: /budget exceeded$/ })).toHaveLength(2);
  });
});

describe('concurrent changes in different scopes', () => {
  it.each([
    ['responses arrive in reverse order', 'response'],
    ['requests are processed in reverse order', 'request'],
  ] as const)('a new expense and a delete end in the correct state when %s', async (_name, held) => {
    const { backend, net } = setup();
    await loaded();
    const hold = held === 'response' ? net.holdResponse : net.hold;
    const create = hold('POST', '/finance/expenses');
    const remove = hold('DELETE', '/finance/expenses/3');

    // The create is submitted first, then the delete. Both are pending, each with its own status.
    fillLog('170');
    click(logButton());
    click(deleteButton('Transport', '₹100'));
    expect(pendingCreate()).toHaveTextContent('Log expense: pending');
    expect(statusOf('expense:3')).toHaveTextContent('Delete Transport expense: pending');
    if (held === 'response') await waitFor(() => expect(nonGetCalls(backend)).toHaveLength(2));
    expect(amountOf('Spent so far')).toBe('₹1,300');

    // The delete answers first.
    await act(async () => {
      remove.release();
    });
    await waitFor(() => expect(rowOf(3)).toBeNull());
    // The deleted row, and the status on it, are gone. The notice reports the confirmed delete.
    expect(notice()).toHaveTextContent('Removed from Transport');
    expect(pendingCreate()).toHaveTextContent('Log expense: pending');
    if (held === 'response') {
      // The server did the create first, so its snapshot already counts both.
      expect(amountOf('Spent so far')).toBe('₹1,370');
      expect(card()).toHaveAttribute('data-version', '3');
    } else {
      expect(amountOf('Spent so far')).toBe('₹1,200');
      expect(card()).toHaveAttribute('data-version', '2');
    }
    expect(card()).toHaveTextContent('Refreshing…');

    // The create answers last. With held responses its snapshot is the older one and must not undo the delete.
    await act(async () => {
      create.release();
    });
    await waitFor(() => expect(rowOf(5)).toBeInTheDocument());
    expect(pendingCreate()).toBeNull();
    expect(notice()).toHaveTextContent('Added to Food');
    expect(card()).toHaveAttribute('data-version', '3');
    expect(card()).not.toHaveTextContent('Refreshing…');
    expect(amountOf('Spent so far')).toBe('₹1,370');
    expect(categoryTotal('Food')).toBe('₹870');
    expect(screen.queryByText('Transport', { selector: '.pill' })).toBeNull();
    expect(rowOf(3)).toBeNull();
    expect(document.querySelectorAll('[data-expense-id="5"]')).toHaveLength(1);
    expectScreenMatches(backend);
    expect(nonGetCalls(backend)).toHaveLength(2);
    expect(reload).not.toHaveBeenCalled();
  });

  it('a move to another month and a treatment change end in the correct state when responses arrive in reverse order', async () => {
    const user = userEvent.setup();
    const { backend, net } = setup();
    await loaded();
    const move = net.holdResponse('PATCH', '/finance/expenses/2');
    const treatment = net.holdResponse('PUT', '/finance/category-treatments/Food');

    const form = await openEdit(user, 'Shopping', '₹500');
    fireEvent.change(within(form).getByLabelText(/^Date/), { target: { value: `${PRIOR}-20` } });
    click(saveButton(form));
    click(treatmentButton('Food', 'Wants'));
    await waitFor(() => expect(nonGetCalls(backend)).toHaveLength(2));
    expect(statusOf('expense:2')).toHaveTextContent('Update Shopping expense: pending');
    expect(statusOf('category-treatment:food')).toHaveTextContent('Count Food as Wants: pending');

    // The treatment answers first with the newest snapshot of this month.
    await act(async () => {
      treatment.release();
    });
    await waitFor(() => expect(statusOf('category-treatment:food')).toHaveTextContent('Count Food as Wants: done'));
    expect(statusOf('expense:2')).toHaveTextContent('Update Shopping expense: pending');
    expect(rowOf(2)).toBeInTheDocument();

    // The move answers last, with the other month's snapshot. This month stays at the newest values.
    await act(async () => {
      move.release();
    });
    await waitFor(() => expect(rowOf(2)).toBeNull());
    expect(notice()).toHaveTextContent(`Moved from Shopping in ${MONTH_NAME} to Shopping in ${monthLabel(PRIOR)}.`);
    await waitFor(() => expect(card()).not.toHaveTextContent('Refreshing…'));
    expect(card()).toHaveAttribute('data-version', '3');
    expect(amountOf('Spent so far')).toBe('₹800');
    expect(amountOf('Needs spent of budget')).toBe('₹100 of ₹40,000');
    expect(amountOf('Wants spent of budget')).toBe('₹700 of ₹24,000');
    expect(screen.queryByText('Shopping', { selector: '.pill' })).toBeNull();
    expectScreenMatches(backend);
    expect(reload).not.toHaveBeenCalled();
  });

  it('blocks a second submission in the same scope and sends one request', async () => {
    const user = userEvent.setup();
    const { backend, net } = setup();
    await loaded();
    const del = net.hold('DELETE', '/finance/expenses/3');
    const put = net.hold('PUT', '/finance/category-treatments/Food');
    const patch = net.hold('PATCH', '/finance/expenses/1');

    click(deleteButton('Transport', '₹100'));
    click(deleteButton('Transport', '₹100'));
    click(deleteButton('Transport', '₹100'));
    expect(deleteButton('Transport', '₹100')).toHaveAttribute('aria-disabled', 'true');

    click(treatmentButton('Food', 'Wants'));
    // Choosing the other treatment of the same category while it is pending does nothing.
    click(treatmentButton('Food', 'Needs'));
    expect(treatmentButton('Food', 'Wants')).toHaveAttribute('aria-disabled', 'true');
    expect(treatmentButton('Food', 'Wants')).toHaveAttribute('aria-pressed', 'true');

    // The pending row's edit control does not open a form, while another row's does.
    const form = await openEdit(user, 'Food', '₹500');
    fireEvent.change(formAmount(form), { target: { value: '650' } });
    click(saveButton(form));
    expect(statusOf('expense:1')).toHaveTextContent('Update Food expense: pending');
    click(editButton('Food', '₹500'));
    expect(screen.queryByRole('form', { name: /^Correct Food ₹500/ })).toBeNull();
    click(deleteButton('Food', '₹500'));
    expect(statusOf('expense:1')).toHaveTextContent('Update Food expense: pending');

    await waitFor(() => expect(sentChanges(net)).toHaveLength(3));
    await act(async () => {
      del.release();
      put.release();
      patch.release();
    });
    await waitFor(() => expect(statusOf('expense:1')).toHaveTextContent('Update Food expense: done'));
    await waitFor(() => expect(statusOf('category-treatment:food')).toHaveTextContent('done'));
    expect(nonGetCalls(backend)).toHaveLength(3);
    expect(sentChanges(net)).toHaveLength(3);
    expect(net.to('DELETE', '/finance/expenses/3')).toHaveLength(1);
    expect(net.to('DELETE', '/finance/expenses/1')).toHaveLength(0);
    expect(net.to('PUT', '/finance/category-treatments/Food')).toHaveLength(1);
    expect(net.to('PATCH', '/finance/expenses/1')).toHaveLength(1);
    expectScreenMatches(backend);
  });

  it('rolls back only the failed scope and keeps the unrelated drafts and pending changes', async () => {
    const user = userEvent.setup();
    const { backend, net } = setup();
    await loaded();
    const patch = net.hold('PATCH', '/finance/expenses/1');
    backend.failNext('PUT', '/finance/category-treatments/Shopping', 500, 'SERVER_ERROR', 'The treatment could not be saved.');
    // An unrelated draft in the log form.
    fillLog('55', 'Keep me');

    const form = await openEdit(user, 'Food', '₹500');
    fireEvent.change(formAmount(form), { target: { value: '650' } });
    click(saveButton(form));
    await user.click(treatmentButton('Shopping', 'Needs'));
    await waitFor(() => expect(statusOf('category-treatment:shopping')).toHaveTextContent('Count Shopping as Needs: failed.'));

    // Only Shopping's treatment is restored. The edit is still pending and shows its entered value.
    expect(treatmentButton('Shopping', 'Wants')).toHaveAttribute('aria-pressed', 'true');
    expect(treatmentButton('Shopping', 'Needs')).toHaveAttribute('aria-pressed', 'false');
    expect(statusOf('expense:1')).toHaveTextContent('Update Food expense: pending');
    expect(rowOf(1)).toHaveTextContent('₹650');
    expect(screen.getByRole('textbox', { name: 'Amount' })).toHaveValue('55');
    expect(screen.getByRole('textbox', { name: 'Note (optional)' })).toHaveValue('Keep me');
    expect(amountOf('Wants spent of budget')).toBe('₹500 of ₹24,000');
    expect(amountOf('Needs spent of budget')).toBe('₹800 of ₹40,000');

    await act(async () => {
      patch.release();
    });
    await waitFor(() => expect(statusOf('expense:1')).toHaveTextContent('Update Food expense: done'));
    expect(statusOf('category-treatment:shopping')).toHaveTextContent('failed.');
    expect(categoryTotal('Food')).toBe('₹850');
    expect(screen.getByRole('textbox', { name: 'Amount' })).toHaveValue('55');
    expectScreenMatches(backend);

    // The failed treatment retries on its own with the same key.
    await user.click(within(statusOf('category-treatment:shopping')).getByRole('button', { name: 'Retry Count Shopping as Needs' }));
    await waitFor(() => expect(statusOf('category-treatment:shopping')).toHaveTextContent('Count Shopping as Needs: done'));
    const puts = net.to('PUT', '/finance/category-treatments/Shopping');
    expect(puts).toHaveLength(2);
    expect(puts[1]?.headers['idempotency-key']).toBe(puts[0]?.headers['idempotency-key']);
    expect(amountOf('Needs spent of budget')).toBe('₹1,450 of ₹40,000');
    expectScreenMatches(backend);
  });

  it('keeps a failed new expense with its values while another change confirms, and retries it with the same key', async () => {
    const user = userEvent.setup();
    const { backend, net } = setup();
    await loaded();
    backend.failNext('POST', '/finance/expenses', 500, 'SERVER_ERROR', 'The expense could not be saved.');

    fillLog('99', 'Tea');
    await user.click(logButton());
    await waitFor(() => expect(pendingCreate()).toHaveTextContent('Log expense: failed.'));
    await user.click(deleteButton('Transport', '₹100'));
    await waitFor(() => expect(rowOf(3)).toBeNull());

    // The delete counted, the failed create did not, and its entered values are still on its row.
    expect(amountOf('Spent so far')).toBe('₹1,200');
    expect(pendingCreate()).toHaveTextContent('₹99');
    expect(pendingCreate()).toHaveTextContent('Tea');
    expect(pendingCreate()).toHaveTextContent('Not saved yet');
    expect(categoryTotal('Food')).toBe('₹700');

    await user.click(within(pendingCreate()).getByRole('button', { name: 'Retry Log expense' }));
    await waitFor(() => expect(pendingCreate()).toBeNull());
    expect(amountOf('Spent so far')).toBe('₹1,299');
    expect(categoryTotal('Food')).toBe('₹799');
    const posts = net.to('POST', '/finance/expenses');
    expect(posts).toHaveLength(2);
    expect(posts[1]?.headers['idempotency-key']).toBe(posts[0]?.headers['idempotency-key']);
    expect(posts[1]?.body).toEqual(posts[0]?.body);
    expectScreenMatches(backend);
  });
});

describe('retries, replays, and conflicts', () => {
  it('counts a created expense once when its response was lost and the retry is replayed by the server', async () => {
    const user = userEvent.setup();
    const { backend, net } = setup();
    await loaded();
    net.loseResponse('POST', '/finance/expenses');

    fillLog('170', 'Lunch');
    await user.click(logButton());
    await waitFor(() => expect(pendingCreate()).toHaveTextContent('Log expense: failed.'));
    // The server saved it, but the page only shows confirmed values.
    expect(backend.expenses).toHaveLength(5);
    expect(categoryTotal('Food')).toBe('₹700');
    expect(amountOf('Spent so far')).toBe('₹1,300');

    await user.click(within(pendingCreate()).getByRole('button', { name: 'Retry Log expense' }));
    await waitFor(() => expect(rowOf(5)).toBeInTheDocument());
    expect(rowOf(5)).toHaveTextContent('Log expense: done (already saved)');
    expect(categoryTotal('Food')).toBe('₹870');
    expect(amountOf('Spent so far')).toBe('₹1,470');
    expect(document.querySelectorAll('[data-expense-id="5"]')).toHaveLength(1);
    expect(backend.expenses).toHaveLength(5);
    const posts = backend.log.filter((entry) => entry.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts[1]?.idempotencyKey).toBe(posts[0]?.idempotencyKey);
    expect(notice()).toHaveTextContent('Added to Food');
    expectScreenMatches(backend);
  });

  it('keeps the draft on a 409, re-reads this month once, and lets the user save again over the other change', async () => {
    const user = userEvent.setup();
    const { backend, net } = setup();
    await loaded();
    // The first correction teaches the page this expense's record version.
    const first = await openEdit(user, 'Food', '₹500');
    fireEvent.change(formAmount(first), { target: { value: '600' } });
    await user.click(saveButton(first));
    await waitFor(() => expect(statusOf('expense:1')).toHaveTextContent('Update Food expense: done'));
    backend.changeElsewhere(1);
    const clarityReads = net.to('GET', '/finance/clarity').length;
    const listReads = net.to('GET', '/finance/expenses').length;

    const form = await openEdit(user, 'Food', '₹600');
    fireEvent.change(formAmount(form), { target: { value: '650' } });
    await user.click(saveButton(form));

    expect(await screen.findByText(/This was changed somewhere else, so it was not saved/)).toBeInTheDocument();
    expect(net.to('PATCH', '/finance/expenses/1')[1]?.body).toEqual({ amountMinor: paise(650), expectedRecordVersion: 2 });
    // The draft stays in the open form and the row is not marked failed.
    expect(formAmount(screen.getByRole('form', { name: 'Correct Food ₹600' }))).toHaveValue('650');
    expect(statusOf('expense:1')).not.toHaveTextContent('failed');
    await waitFor(() => expect(net.to('GET', '/finance/clarity')).toHaveLength(clarityReads + 1));
    await waitFor(() => expect(net.to('GET', '/finance/expenses')).toHaveLength(listReads + 1));
    await waitFor(() => expect(categoryTotal('Food')).toBe('₹800'));

    // Saving again no longer claims the old version, so it replaces the other change.
    await user.click(saveButton(screen.getByRole('form', { name: 'Correct Food ₹600' })));
    await waitFor(() => expect(statusOf('expense:1')).toHaveTextContent('Update Food expense: done'));
    const patches = net.to('PATCH', '/finance/expenses/1');
    expect(patches).toHaveLength(3);
    expect(patches[2]?.body).not.toHaveProperty('expectedRecordVersion');
    expect(patches[2]?.body).toMatchObject({ amountMinor: paise(650) });
    expect(screen.queryByText(/This was changed somewhere else/)).toBeNull();
    expect(categoryTotal('Food')).toBe('₹850');
    expectScreenMatches(backend);
  });
});

describe('focus', () => {
  it('moves focus to the entries list when a retried new expense is replaced by its saved row', async () => {
    const user = userEvent.setup();
    const { backend, net } = setup();
    await loaded();
    backend.failNext('POST', '/finance/expenses', 500, 'SERVER_ERROR', 'The expense could not be saved.');
    fillLog('170', 'Lunch');
    await user.click(logButton());
    await waitFor(() => expect(pendingCreate()).toHaveTextContent('Log expense: failed.'));
    const failedRow = pendingCreate();
    const retry = within(failedRow).getByRole('button', { name: 'Retry Log expense' });
    const gate = net.hold('POST', '/finance/expenses');

    // Retry from the keyboard. The button turns into pending text, and focus stays in the row.
    retry.focus();
    await user.keyboard('{Enter}');
    expect(failedRow).toBe(pendingCreate());
    expect(failedRow).toHaveTextContent('Log expense: pending');
    expect(failedRow.contains(document.activeElement)).toBe(true);

    // The saved row replaces the pending row. Focus is not dropped to the page.
    await act(async () => {
      gate.release();
    });
    await waitFor(() => expect(rowOf(5)).toBeInTheDocument());
    expect(pendingCreate()).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(entriesHeading()).toHaveFocus();
    expect(categoryTotal('Food')).toBe('₹870');
  });

  it('moves focus to the entries list when a failed new expense is dismissed', async () => {
    const user = userEvent.setup();
    const { backend } = setup();
    await loaded();
    backend.failNext('POST', '/finance/expenses', 500, 'SERVER_ERROR', 'The expense could not be saved.');
    fillLog('170');
    await user.click(logButton());
    await waitFor(() => expect(pendingCreate()).toHaveTextContent('Log expense: failed.'));
    const dismiss = within(pendingCreate()).getByRole('button', { name: 'Dismiss failed Log expense' });
    dismiss.focus();
    await user.keyboard('{Enter}');

    await waitFor(() => expect(pendingCreate()).toBeNull());
    expect(document.activeElement).not.toBe(document.body);
    expect(entriesHeading()).toHaveFocus();
    expect(amountOf('Spent so far')).toBe('₹1,300');
  });

  it('keeps focus on the control the user is using while another change confirms', async () => {
    const user = userEvent.setup();
    const { net } = setup();
    await loaded();
    const gate = net.hold('DELETE', '/finance/expenses/3');
    click(deleteButton('Transport', '₹100'));
    // The user moves on to the log form and types while the delete is pending.
    const amount = screen.getByRole('textbox', { name: 'Amount' });
    await user.click(amount);
    await user.keyboard('42');

    await act(async () => {
      gate.release();
    });
    await waitFor(() => expect(rowOf(3)).toBeNull());
    expect(amount).toHaveFocus();
    expect(amount).toHaveValue('42');
  });
});

describe('live announcements', () => {
  it('announces the changed spending outcome, not an outcome whose values did not change', async () => {
    const user = userEvent.setup();
    setup();
    await loaded();
    // One outcome card on this page: sibling cards are not announced here.
    expect(screen.getAllByRole('article')).toHaveLength(1);
    expect(live()).toBeEmptyDOMElement();

    // A note-only correction moves the data version and nothing the card shows.
    const noteForm = await openEdit(user, 'Food', '₹200');
    fireEvent.change(within(noteForm).getByRole('textbox', { name: 'Note (optional)' }), { target: { value: 'Team dinner' } });
    await user.click(saveButton(noteForm));
    await waitFor(() => expect(statusOf('expense:4')).toHaveTextContent('Update Food expense: done'));
    expect(card()).toHaveAttribute('data-version', '2');
    expect(live()).toBeEmptyDOMElement();
    expect(notice()).toHaveTextContent(`Updated Food for ${MONTH_NAME}.`);

    // A correction that changes the amount announces the new values once.
    const amountForm = await openEdit(user, 'Food', '₹500');
    fireEvent.change(formAmount(amountForm), { target: { value: '650' } });
    await user.click(saveButton(amountForm));
    await waitFor(() => expect(statusOf('expense:1')).toHaveTextContent('Update Food expense: done'));
    expect(live()).toHaveTextContent('Spending for');
    expect(live()).toHaveTextContent(`Remaining spendable ${inr(62550)}.`);
    expect(live()).toHaveTextContent('Calculated result');
  });

  it('announces a reclassification through the change notice, because the headline values do not move', async () => {
    const user = userEvent.setup();
    setup();
    await loaded();
    await user.click(treatmentButton('Food', 'Wants'));
    await waitFor(() => expect(statusOf('category-treatment:food')).toHaveTextContent('done'));
    expect(live()).toBeEmptyDOMElement();
    const status = within(notice()).getByRole('status');
    expect(status).toHaveTextContent('Food now counts as Wants. Your spending for');
  });
});

describe('shared outcome card announcements', () => {
  function Pair({ planVersion, spendingVersion, spendingValue }: { planVersion: number; spendingVersion: number; spendingValue: string }) {
    const plan = spendingSnapshot(MONTH, { dataVersion: planVersion }).outcomes.monthlyPlan;
    const spending = spendingSnapshot(MONTH, { dataVersion: spendingVersion }).outcomes.spending;
    return (
      <div>
        <OutcomeCard outcome={plan} title="Plan" valueSummary="₹64,000" />
        <OutcomeCard outcome={spending} title="Spending" valueSummary={spendingValue} />
      </div>
    );
  }

  it('does not announce a sibling card whose values are unchanged when the server only stamps a new data version', () => {
    const view = renderAuthenticated(<Pair planVersion={1} spendingVersion={1} spendingValue="₹62,700" />);
    view.rerender(<Pair planVersion={2} spendingVersion={2} spendingValue="₹62,530" />);
    const plan = within(screen.getByRole('article', { name: 'Plan' })).getByRole('status');
    const spending = within(screen.getByRole('article', { name: 'Spending' })).getByRole('status');
    expect(spending).toHaveTextContent('Spending. ₹62,530.');
    expect(plan).toBeEmptyDOMElement();
  });
});

describe('feedback timing on a controlled clock', () => {
  const FRAME_MS = 16;
  const BUDGET_MS = 100;

  /** Turns on the fake clock after the page has loaded, so loading itself is not what is measured. */
  function controlClock() {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  }

  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  /** Fake milliseconds from now until `ready()` is true, checked after every 16 ms frame. Infinity when it is not true within the budget. */
  async function elapsedUntil(ready: () => boolean, budgetMs = BUDGET_MS): Promise<number> {
    const start = performance.now();
    await advance(0);
    for (;;) {
      if (ready()) return performance.now() - start;
      if (performance.now() - start >= budgetMs) return Number.POSITIVE_INFINITY;
      await advance(FRAME_MS);
    }
  }

  const text = (element: Element | null | undefined) => element?.textContent ?? '';

  it('shows a new expense as pending at submit, keeps it for a slow server, then confirms everything within 100 ms of the response', async () => {
    const { net } = setup();
    await loaded();
    controlClock();
    const gate = net.hold('POST', '/finance/expenses');

    fillLog('170', 'Lunch');
    const submit = logButton();
    submit.focus();
    click(submit);
    // Submit to feedback with no clock movement at all.
    expect(text(pendingCreate())).toContain('Log expense: pending');
    expect(text(pendingCreate())).toContain('Saving this expense…');
    expect(await elapsedUntil(() => text(pendingCreate()).includes('Log expense: pending'))).toBeLessThanOrEqual(BUDGET_MS);
    expect(text(card())).toContain('Refreshing…');
    // Other controls stay usable while it is pending.
    expect(treatmentButton('Transport', 'Wants')).not.toHaveAttribute('aria-disabled');
    expect(deleteButton('Shopping', '₹500')).not.toHaveAttribute('aria-disabled');
    expect(submit).toHaveFocus();

    // A slow server (30 s) does not time the feedback out, flicker it, or confirm anything early.
    await advance(30_000);
    expect(text(pendingCreate())).toContain('Log expense: pending');
    expect(amountOf('Spent so far')).toBe('₹1,300');

    await act(async () => {
      gate.release();
    });
    const confirmed = await elapsedUntil(() => (
      !pendingCreate()
      && amountOf('Spent so far') === '₹1,470'
      && categoryTotal('Food') === '₹870'
      && text(rowOf(5)).includes('Log expense: done')
      && !text(card()).includes('Refreshing…')
      && text(screen.queryByRole('region', { name: 'Latest change to your spending' })).includes('Added to Food')
    ));
    expect(confirmed).toBeLessThanOrEqual(BUDGET_MS);
    expect(submit).toHaveFocus();
    expect(reload).not.toHaveBeenCalled();
  });

  it('shows a failed new expense within 100 ms of the failed response, with its values, the confirmed totals, and a retry', async () => {
    const { backend, net } = setup();
    await loaded();
    controlClock();
    backend.failNext('POST', '/finance/expenses', 500, 'SERVER_ERROR', 'The expense could not be saved.');
    const gate = net.hold('POST', '/finance/expenses');

    fillLog('170', 'Lunch');
    click(logButton());
    expect(text(pendingCreate())).toContain('Log expense: pending');

    await act(async () => {
      gate.release();
    });
    const failed = await elapsedUntil(() => text(pendingCreate()).includes('Log expense: failed.'));
    expect(failed).toBeLessThanOrEqual(BUDGET_MS);
    expect(text(pendingCreate())).toContain('The expense could not be saved.');
    expect(text(pendingCreate())).toContain('₹170');
    expect(text(pendingCreate())).toContain('Lunch');
    expect(within(pendingCreate()).getByRole('button', { name: 'Retry Log expense' })).toBeInTheDocument();
    expect(amountOf('Spent so far')).toBe('₹1,300');
    expect(categoryTotal('Food')).toBe('₹700');
    expect(text(card())).not.toContain('Refreshing…');
  });

  it('shows a correction as pending at submit and its confirmed values within 100 ms of the response', async () => {
    const user = userEvent.setup();
    const { net } = setup();
    await loaded();
    const form = await openEdit(user, 'Food', '₹500');
    fireEvent.change(formAmount(form), { target: { value: '650' } });
    controlClock();
    const gate = net.hold('PATCH', '/finance/expenses/1');

    click(saveButton(form));
    expect(text(statusOf('expense:1'))).toContain('Update Food expense: pending');
    expect(await elapsedUntil(() => text(rowOf(1)).includes('₹650'))).toBeLessThanOrEqual(BUDGET_MS);
    expect(amountOf('Spent so far')).toBe('₹1,300');

    await act(async () => {
      gate.release();
    });
    const confirmed = await elapsedUntil(() => (
      text(statusOf('expense:1')).includes('Update Food expense: done')
      && amountOf('Spent so far') === '₹1,450'
      && categoryTotal('Food') === '₹850'
      && !text(card()).includes('Refreshing…')
    ));
    expect(confirmed).toBeLessThanOrEqual(BUDGET_MS);
  });

  it('shows a delete as pending at submit and the removal within 100 ms of the response', async () => {
    const { net } = setup();
    await loaded();
    controlClock();
    const gate = net.hold('DELETE', '/finance/expenses/3');

    click(deleteButton('Transport', '₹100'));
    expect(text(statusOf('expense:3'))).toContain('Delete Transport expense: pending');
    expect(await elapsedUntil(() => text(statusOf('expense:3')).includes('pending'))).toBeLessThanOrEqual(BUDGET_MS);
    expect(rowOf(3)).toBeInTheDocument();

    await act(async () => {
      gate.release();
    });
    const confirmed = await elapsedUntil(() => !rowOf(3) && amountOf('Spent so far') === '₹1,200');
    expect(confirmed).toBeLessThanOrEqual(BUDGET_MS);
    expect(text(screen.queryByRole('region', { name: 'Latest change to your spending' }))).toContain('Removed from Transport');
  });

  it('shows a reclassification as pending at submit and failure within 100 ms of the failed response', async () => {
    const { backend, net } = setup();
    await loaded();
    controlClock();
    backend.failNext('PUT', '/finance/category-treatments/Food', 500, 'SERVER_ERROR', 'The treatment could not be saved.');
    const gate = net.hold('PUT', '/finance/category-treatments/Food');

    const wants = treatmentButton('Food', 'Wants');
    wants.focus();
    click(wants);
    expect(text(statusOf('category-treatment:food'))).toContain('Count Food as Wants: pending');
    expect(wants).toHaveAttribute('aria-pressed', 'true');

    await act(async () => {
      gate.release();
    });
    const failed = await elapsedUntil(() => text(statusOf('category-treatment:food')).includes('Count Food as Wants: failed.'));
    expect(failed).toBeLessThanOrEqual(BUDGET_MS);
    expect(treatmentButton('Food', 'Needs')).toHaveAttribute('aria-pressed', 'true');
    expect(treatmentButton('Food', 'Wants')).toHaveAttribute('aria-pressed', 'false');
    expect(amountOf('Needs spent of budget')).toBe('₹800 of ₹40,000');
    expect(within(statusOf('category-treatment:food')).getByRole('button', { name: 'Retry Count Food as Wants' })).toBeInTheDocument();
  });
});

describe('keyboard operation and status text', () => {
  it('reaches, opens, edits, saves, and deletes rows and changes treatments with the keyboard in reading order', async () => {
    const user = userEvent.setup();
    const { backend, net } = setup();
    await loaded();

    // Reading order: each row's Edit, then its Delete, then the next row.
    editButton('Food', '₹200').focus();
    await user.tab();
    expect(deleteButton('Food', '₹200')).toHaveFocus();
    await user.tab();
    expect(editButton('Transport', '₹100')).toHaveFocus();

    // Enter opens the correction form and puts focus in it, so typing goes to the form.
    await user.keyboard('{Enter}');
    const form = screen.getByRole('form', { name: 'Correct Transport ₹100' });
    expect(form.contains(document.activeElement)).toBe(true);
    expect(formAmount(form)).toHaveFocus();
    // Tab order inside the form follows the visual order and ends at Save and Cancel.
    await user.tab();
    expect(within(form).getByRole('combobox', { name: 'Category' })).toHaveFocus();
    await user.tab();
    expect(within(form).getByRole('textbox', { name: 'Note (optional)' })).toHaveFocus();
    await user.tab();
    expect(within(form).getByLabelText(/^Date/)).toHaveFocus();
    await user.tab();
    expect(saveButton(form)).toHaveFocus();
    await user.tab();
    expect(within(form).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    // Cancel with the keyboard returns focus to the Edit button.
    await user.keyboard(' ');
    expect(screen.queryByRole('form', { name: 'Correct Transport ₹100' })).toBeNull();
    expect(editButton('Transport', '₹100')).toHaveFocus();

    // Edit and submit with Enter from the amount field.
    await user.keyboard('{Enter}');
    const again = screen.getByRole('form', { name: 'Correct Transport ₹100' });
    await user.clear(formAmount(again));
    await user.keyboard('120{Enter}');
    await waitFor(() => expect(statusOf('expense:3')).toHaveTextContent('Update Transport expense: done'));
    expect(categoryTotal('Transport')).toBe('₹120');
    expect(editButton('Transport', '₹120')).toHaveFocus();

    // Space on a treatment button toggles it, and focus stays on that button.
    const toNeeds = treatmentButton('Shopping', 'Needs');
    toNeeds.focus();
    await user.keyboard(' ');
    await waitFor(() => expect(statusOf('category-treatment:shopping')).toHaveTextContent('Count Shopping as Needs: done'));
    expect(toNeeds).toHaveFocus();
    expect(toNeeds).toHaveAttribute('aria-pressed', 'true');
    expect(amountOf('Needs spent of budget')).toBe('₹1,320 of ₹40,000');

    // Enter on Delete removes the row and focus moves to the list, not the page.
    deleteButton('Shopping', '₹500').focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(rowOf(2)).toBeNull());
    expect(document.activeElement).not.toBe(document.body);
    expect(net.to('DELETE', '/finance/expenses/2')).toHaveLength(1);
    expectScreenMatches(backend);
  });

  it('says every state in words, not only in color', async () => {
    const user = userEvent.setup();
    const { backend, net } = setup({ needsBudget: 500, wantsBudget: 300 });
    await loaded();
    const gate = net.hold('DELETE', '/finance/expenses/3');
    backend.failNext('PUT', '/finance/category-treatments/Food', 500, 'SERVER_ERROR', 'The treatment could not be saved.');

    click(deleteButton('Transport', '₹100'));
    await user.click(treatmentButton('Food', 'Wants'));
    await waitFor(() => expect(statusOf('category-treatment:food')).toHaveTextContent('failed.'));

    // Pending, failed, and the outcome's own status each carry a word. Their glyphs are decorative.
    expect(statusOf('expense:3')).toHaveTextContent('Delete Transport expense: pending');
    expect(statusOf('category-treatment:food')).toHaveTextContent('Count Food as Wants: failed. The treatment could not be saved. Your last confirmed values are unchanged.');
    for (const scope of ['expense:3', 'category-treatment:food']) {
      for (const glyph of statusOf(scope).querySelectorAll('.clarity-glyph')) expect(glyph).toHaveAttribute('aria-hidden', 'true');
    }
    expect(statusOf('category-treatment:food').querySelector('[role="alert"]')).toHaveTextContent('failed.');
    expect(statusOf('expense:3').querySelector('[role="status"]')).toHaveTextContent('pending');
    expect(card()).toHaveTextContent('Confirmed');
    expect(card()).toHaveTextContent('Calculated result');
    // An exceeded bucket says so with its name and the amount, plus a label for its kind.
    const needs = screen.getByRole('region', { name: 'Needs budget exceeded' });
    expect(needs).toHaveTextContent('Needs budget exceeded by ₹300.');
    expect(needs).toHaveTextContent('Recommendation');
    // Which treatment is chosen is said in text beside the buttons, not only by the pressed color.
    expect(categoryRow('Food')).toHaveTextContent('Counted as Needs (default)');
    await act(async () => {
      gate.release();
    });
    await waitFor(() => expect(rowOf(3)).toBeNull());
  });

  it('ties a field error to its input in the correction form, without moving focus, and keeps the other entered values', async () => {
    const user = userEvent.setup();
    const { backend } = setup();
    await loaded();
    const form = await openEdit(user, 'Food', '₹500');
    const amount = formAmount(form);
    const note = within(form).getByRole('textbox', { name: 'Note (optional)' });
    fireEvent.change(amount, { target: { value: '0' } });
    fireEvent.change(note, { target: { value: 'Kept' } });
    fireEvent.change(within(form).getByLabelText(/^Date/), { target: { value: '1990-01-01' } });
    note.focus();
    click(saveButton(form));

    const amountError = within(form).getByText(/Amount:/).closest('p') as HTMLElement;
    const dateError = within(form).getByText(/Date:/).closest('p') as HTMLElement;
    expect(amountError).toHaveTextContent('Amount: must be an amount above 0.');
    expect(amount).toHaveAttribute('aria-invalid', 'true');
    expect(amount.getAttribute('aria-describedby')).toContain(amountError.id);
    const date = within(form).getByLabelText(/^Date/);
    expect(date).toHaveAttribute('aria-invalid', 'true');
    expect(date.getAttribute('aria-describedby')).toContain(dateError.id);
    expect(note).toHaveFocus();
    expect(note).toHaveValue('Kept');
    expect(nonGetCalls(backend)).toEqual([]);
  });

  it('points each row control at its own status so a failure is read with the control', async () => {
    const { backend } = setup();
    await loaded();
    backend.failNext('DELETE', '/finance/expenses/3', 500, 'SERVER_ERROR', 'The expense could not be deleted.');
    await userEvent.setup().click(deleteButton('Transport', '₹100'));
    await waitFor(() => expect(statusOf('expense:3')).toHaveTextContent('failed.'));
    for (const button of [editButton('Transport', '₹100'), deleteButton('Transport', '₹100')]) {
      const target = document.getElementById(button.getAttribute('aria-describedby') as string);
      expect(target).toBe(statusOf('expense:3'));
    }
  });
});

describe('reduced motion', () => {
  const spendingStyles = readFileSync('src/components/spending/spending.css', 'utf8');

  function mockReducedMotion(reduce: boolean) {
    vi.stubGlobal('matchMedia', (query: string): MediaQueryList => ({
      matches: reduce && /prefers-reduced-motion:\s*reduce/.test(query),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    }));
  }

  it('adds no animated movement of its own: the Spending styles hold no transition, animation, or keyframes', () => {
    expect(spendingStyles).not.toMatch(/@keyframes|animation\s*:|transition\s*:|animation-name/);
  });

  it('changes state immediately: no inline motion on the outcome, rows, or statuses after a change', async () => {
    mockReducedMotion(true);
    const user = userEvent.setup();
    const { container } = setup();
    await loaded();
    await user.click(deleteButton('Transport', '₹100'));
    await waitFor(() => expect(rowOf(3)).toBeNull());
    for (const element of container.querySelectorAll<HTMLElement>('.clarity-outcome *, .spending-expense, .clarity-mutation, .spending-categories *')) {
      expect(element.getAttribute('style') ?? '').not.toMatch(/animation|transition|transform/i);
    }
  });

  it('scrolls to an action target without smooth movement when the device asks for reduced motion', async () => {
    mockReducedMotion(true);
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    setup({}, '/spending?action=correct-expense&expenseId=1');
    await waitFor(() => expect(rowOf(1)).toHaveFocus(), { timeout: 3000 });
    expect(scrollIntoView).toHaveBeenCalled();
    for (const call of scrollIntoView.mock.calls) expect(call[0]).toMatchObject({ behavior: 'auto' });
  });
});

describe.each(['light', 'dark'] as const)('accessibility in the %s theme', (theme) => {
  async function withTheme(run: () => Promise<void>) {
    document.documentElement.dataset.theme = theme;
    try {
      await run();
    } finally {
      delete document.documentElement.dataset.theme;
    }
  }

  it('has no violations with pending changes in three scopes', async () => {
    await withTheme(async () => {
      const user = userEvent.setup();
      const { container, net } = setup();
      await loaded();
      net.hold('POST', '/finance/expenses');
      net.hold('PATCH', '/finance/expenses/1');
      net.hold('PUT', '/finance/category-treatments/Transport');
      fillLog('25', 'Tea');
      click(logButton());
      const form = await openEdit(user, 'Food', '₹500');
      fireEvent.change(formAmount(form), { target: { value: '650' } });
      click(saveButton(form));
      click(treatmentButton('Transport', 'Wants'));
      expect(pendingCreate()).toHaveTextContent('Log expense: pending');
      expect(statusOf('expense:1')).toHaveTextContent('pending');
      expect(statusOf('category-treatment:transport')).toHaveTextContent('pending');
      expect(await axe(container)).toHaveNoViolations();
    });
  });

  it('has no violations with a failed create, a failed correction with its form open, a failed delete, and a failed treatment', async () => {
    await withTheme(async () => {
      const user = userEvent.setup();
      const { backend, container } = setup();
      await loaded();
      backend.failNext('POST', '/finance/expenses', 500, 'SERVER_ERROR', 'The expense could not be saved.');
      backend.failNext('PATCH', '/finance/expenses/1', 500, 'SERVER_ERROR', 'The correction could not be saved.');
      backend.failNext('DELETE', '/finance/expenses/3', 500, 'SERVER_ERROR', 'The expense could not be deleted.');
      backend.failNext('PUT', '/finance/category-treatments/Shopping', 500, 'SERVER_ERROR', 'The treatment could not be saved.');
      fillLog('25', 'Tea');
      await user.click(logButton());
      const form = await openEdit(user, 'Food', '₹500');
      fireEvent.change(formAmount(form), { target: { value: '650' } });
      await user.click(saveButton(form));
      await user.click(deleteButton('Transport', '₹100'));
      await user.click(treatmentButton('Shopping', 'Needs'));
      await waitFor(() => {
        expect(pendingCreate()).toHaveTextContent('failed.');
        expect(statusOf('expense:1')).toHaveTextContent('failed.');
        expect(statusOf('expense:3')).toHaveTextContent('failed.');
        expect(statusOf('category-treatment:shopping')).toHaveTextContent('failed.');
      });
      expect(screen.getByRole('form', { name: 'Correct Food ₹500' })).toBeInTheDocument();
      expect(await axe(container)).toHaveNoViolations();
    });
  });

  it('has no violations when the calculation failed, with the entries kept', async () => {
    await withTheme(async () => {
      const { container } = setup({ calculationFailed: true });
      const outcome = await screen.findByRole('article', { name: `Spending for ${MONTH_NAME}` });
      expect(outcome).toHaveAttribute('data-status', 'calculation_failed');
      await waitFor(() => expect(rowOf(1)).toBeInTheDocument());
      expect(screen.getByText(/Category totals are temporarily unavailable/)).toBeInTheDocument();
      expect(await axe(container)).toHaveNoViolations();
    });
  });

  it('has no violations with both Needs and Wants budgets exceeded', async () => {
    await withTheme(async () => {
      const { container } = setup({ needsBudget: 500, wantsBudget: 300 });
      await loaded();
      expect(screen.getAllByRole('region', { name: /budget exceeded$/ })).toHaveLength(2);
      expect(await axe(container)).toHaveNoViolations();
    });
  });
});

afterEach(() => {
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

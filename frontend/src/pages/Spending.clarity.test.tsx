import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PAGE_DECISIONS } from '../clarity/actionContext';
import type { FinancialSnapshot } from '../clarity/contracts';
import { DataUseGateProvider } from '../clarity/DataUseGateProvider';
import { FinancialClarityProvider } from '../clarity/FinancialClarityProvider';
import { MutationStatusProvider } from '../clarity/MutationStatusProvider';
import { DATA_USE_REASON_ID, DataUseGate } from '../components/clarity';
import { currentMonth, inr, monthLabel } from '../money';
import { deferred } from '../test/clarity-fixtures';
import { buildSettings } from '../test/dataUseFixtures';
import {
  NEEDS_ACTION,
  expenseEnvelope,
  expenseRow,
  spendingSnapshot,
  type SpendingExpenseFixture,
} from '../test/spendingFixtures';
import { axe, createApiResponse, createTestQueryClient, renderAuthenticated } from '../test/test-utils';
import type { Plan as PlanData } from '../types';
import { Spending } from './Spending';

const MONTH = currentMonth();
const MONTH_NAME = monthLabel(MONTH);
const PRIOR = (() => {
  const now = new Date();
  const prior = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${prior.getFullYear()}-${String(prior.getMonth() + 1).padStart(2, '0')}`;
})();
const PRIOR_NAME = monthLabel(PRIOR);
const CATEGORIES = ['Food', 'Groceries', 'Transport', 'Shopping', 'Other'];
const paise = (amount: number) => Math.round(amount * 100);

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
  headers: Record<string, string>;
}
type Handler = (call: Call, attempt: number) => Response | Promise<Response>;

/** Routes fetch by `METHOD /path`. A plain value is a 200 JSON body; a function controls the response. */
function mockApi(routes: Record<string, Handler | object>) {
  const calls: Call[] = [];
  const attempts = new Map<string, number>();
  const all: Record<string, Handler | object> = {
    'GET /finance/insights': { thisMonth: MONTH, prevMonth: PRIOR, totals: { thisMonth: 0, prevMonth: 0 }, weekdayAvg: [], insights: [] },
    'GET /finance/history': { months: [] },
    'GET /finance/budgets': { budgets: {} },
    ...routes,
  };
  vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
    const path = new URL(String(input), 'http://localhost').pathname.replace(/^\/api/, '');
    const method = init?.method ?? 'GET';
    const key = `${method} ${path}`;
    const call: Call = {
      method,
      path,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
      headers: { ...(init?.headers as Record<string, string> | undefined) },
    };
    calls.push(call);
    const attempt = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, attempt);
    const route = all[key];
    if (route === undefined) return createApiResponse({ status: 404, body: { error: 'Not found' } });
    if (typeof route === 'function') return (route as Handler)(call, attempt);
    return createApiResponse({ body: route });
  });
  return {
    calls,
    to: (method: string, path: string) => calls.filter((call) => call.method === method && call.path === path),
  };
}

const read = (snapshot: FinancialSnapshot) => ({ schemaVersion: 1, snapshot });
const okResponse = (body: unknown) => createApiResponse({ body });
const failure = (status: number, code: string, message: string) => createApiResponse({ status, body: { error: { code, message } } });

function renderSpending(options: { gate?: boolean; route?: string } = {}) {
  const page = options.gate
    ? (
      <DataUseGateProvider enabled>
        <DataUseGate />
        <Spending />
      </DataUseGateProvider>
    )
    : <Spending />;
  return renderAuthenticated(
    <FinancialClarityProvider>
      <MutationStatusProvider>{page}</MutationStatusProvider>
    </FinancialClarityProvider>,
    { route: options.route ?? '/spending', queryClient: createTestQueryClient() },
  );
}

const statusOf = (scope: string) => document.querySelector(`[data-scope="${scope}"]`) as HTMLElement;
const outcomeCard = () => screen.findByRole('article', { name: `Spending for ${MONTH_NAME}` });
const valueOf = (card: HTMLElement, label: string) => within(card).getByText(label).closest('.clarity-value') as HTMLElement;
const money = (snapshot: FinancialSnapshot, key: 'remainingSpendable' | 'dailySpendingGuide' | 'projectedSavings' | 'totalSpending' | 'needsSpent' | 'wantsSpent') =>
  inr((snapshot.outcomes.spending.value?.[key].amountMinor ?? 0) / 100);
const comesBefore = (first: Element, second: Element) =>
  Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);

const FOOD: SpendingExpenseFixture = { id: 1, category: 'Food', amount: 500 };
const SHOPPING: SpendingExpenseFixture = { id: 2, category: 'Shopping', amount: 500 };
const TRANSPORT: SpendingExpenseFixture = { id: 3, category: 'Transport', amount: 100 };
const BASE = [FOOD, SHOPPING, TRANSPORT];
const rowsFor = (expenses: SpendingExpenseFixture[]) =>
  expenses.map((e) => expenseRow(e.id, e.category, e.amount, MONTH));
const listFor = (expenses: SpendingExpenseFixture[]) => ({ month: MONTH, categories: CATEGORIES, expenses: rowsFor(expenses) });
const editButton = (category: string, amount: string) => screen.getByRole('button', { name: `Edit ${category} ${amount}` });
const deleteButton = (category: string, amount: string) => screen.getByRole('button', { name: `Delete ${category} ${amount}` });
const logButton = () => screen.getByRole('button', { name: '+ Log expense' });
const rowOf = (id: number) => document.getElementById(`expense-${id}`) as HTMLElement;

function baseRoutes(snapshot = spendingSnapshot(MONTH, { expenses: BASE }), expenses = BASE) {
  return {
    'GET /finance/clarity': read(snapshot),
    'GET /finance/expenses': listFor(expenses),
  };
}

const reload = vi.fn();
beforeEach(() => {
  vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'true');
  reload.mockClear();
  vi.stubGlobal('location', { ...window.location, reload });
});

describe('canonical outcomes with purpose, previews, and explanations', () => {
  it('shows the server totals, treatments, and excess in order: header, outcome, purpose, form', async () => {
    const snapshot = spendingSnapshot(MONTH, { expenses: BASE, needsBudget: 400, actions: [NEEDS_ACTION] });
    mockApi(baseRoutes(snapshot));
    const { container } = renderSpending();
    const card = await outcomeCard();
    expect(card).toHaveTextContent(`Period: ${MONTH_NAME}`);
    expect(valueOf(card, 'Remaining spendable')).toHaveTextContent(money(snapshot, 'remainingSpendable'));
    expect(valueOf(card, 'Daily spending guide')).toHaveTextContent(money(snapshot, 'dailySpendingGuide'));
    expect(valueOf(card, 'Projected savings')).toHaveTextContent(money(snapshot, 'projectedSavings'));
    expect(valueOf(card, 'Projected savings')).toHaveTextContent('Calculated result');
    expect(valueOf(card, 'Projected savings compared with target')).toHaveTextContent('+₹');
    expect(valueOf(card, 'Needs spent of budget')).toHaveTextContent('₹600 of ₹400');
    expect(card).toHaveTextContent('17 calendar days left');
    // Needs excess: the server's amount, its corrective action, and a link to the category region.
    const excess = screen.getByRole('region', { name: 'Needs budget exceeded' });
    expect(excess).toHaveTextContent('Needs budget exceeded by ₹200.');
    expect(excess).toHaveTextContent('Reduce Needs spending or reclassify an incorrectly treated expense.');
    expect(excess).toHaveTextContent('Recommendation');
    expect(within(excess).getByRole('link', { name: /Review Needs spending/ })).toHaveAttribute('href', '/spending?action=review-budget&bucket=needs');
    expect(screen.queryByRole('region', { name: 'Wants budget exceeded' })).toBeNull();
    // Category totals come from the server, each with its applied treatment.
    const food = await screen.findByText('Food', { selector: '.pill' });
    const foodRow = food.closest('li') as HTMLElement;
    expect(foodRow).toHaveTextContent('₹500');
    expect(foodRow).toHaveTextContent('Counted as Needs (default)');
    expect(within(foodRow).getByRole('button', { name: 'Count Food as Needs' })).toHaveAttribute('aria-pressed', 'true');
    const shopping = (screen.getByText('Shopping', { selector: '.pill' }).closest('li')) as HTMLElement;
    expect(shopping).toHaveTextContent('Counted as Wants (default)');
    // Purpose and preview use the confirmed values and sit above the form's input.
    const header = container.querySelector('.clarity-decision-header') as HTMLElement;
    expect(within(header).getByText(PAGE_DECISIONS.spending)).toBeInTheDocument();
    const purpose = document.getElementById('purpose-expense') as HTMLElement;
    expect(purpose).toHaveTextContent('Required');
    expect(document.getElementById('benefit-expense')).toHaveTextContent('Based on your saved values.');
    const amount = screen.getByRole('textbox', { name: 'Amount' });
    expect(comesBefore(header, card)).toBe(true);
    expect(comesBefore(card, purpose)).toBe(true);
    expect(comesBefore(purpose, amount)).toBe(true);
    expect(amount).toHaveAttribute('aria-describedby', expect.stringContaining('purpose-expense'));
  });

  it('opens and closes the calculation explanation from the keyboard-operable toggle', async () => {
    const user = userEvent.setup();
    const snapshot = spendingSnapshot(MONTH, { expenses: BASE });
    const outcomeId = `spending:${MONTH}`;
    const api = mockApi({
      ...baseRoutes(snapshot),
      [`GET /finance/explanations/${encodeURIComponent(outcomeId)}`]: {
        schemaVersion: 1,
        explanation: {
          schemaVersion: 1,
          outcomeId,
          kind: 'spending',
          status: 'available',
          classification: 'calculated_result',
          dataVersion: 1,
          period: snapshot.outcomes.spending.period,
          currency: 'INR',
          precisionMinor: 1,
          sourceRefs: [],
          operations: [],
          rounding: { precisionMinor: 1, direction: 'half_up', adjustmentMinor: 0 },
        },
      },
    });
    renderSpending();
    const card = await outcomeCard();
    const toggle = within(card).getByRole('button', { name: `How this was calculated for Spending for ${MONTH_NAME}` });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(await within(card).findByText('Steps, in order')).toBeInTheDocument();
    expect(api.to('GET', `/finance/explanations/${encodeURIComponent(outcomeId)}`)).toHaveLength(1);
    await user.keyboard('{Escape}');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveFocus();
  });

  it('words an exceeded budget as an amount over, never as negative permission to spend', async () => {
    const snapshot = spendingSnapshot(MONTH, { expenses: [{ id: 1, category: 'Shopping', amount: 70000 }], wantsBudget: 24000 });
    mockApi(baseRoutes(snapshot, [{ id: 1, category: 'Shopping', amount: 70000 }]));
    renderSpending();
    const card = await outcomeCard();
    expect(valueOf(card, 'Over the spendable budget by')).toBeInTheDocument();
    expect(valueOf(card, 'Over pace by, a day')).toBeInTheDocument();
    expect(card).not.toHaveTextContent('-₹');
    expect(screen.getByRole('region', { name: 'Wants budget exceeded' })).toHaveTextContent('Wants budget exceeded by ₹46,000.');
  });
});

describe('log an expense', () => {
  it('acknowledges at once, keeps other controls usable, then updates every outcome without a reload or broad refetch', async () => {
    const user = userEvent.setup();
    const pending = deferred<Response>();
    const transportTreatment = deferred<Response>();
    const confirmed = spendingSnapshot(MONTH, { dataVersion: 2, expenses: [...BASE, { id: 4, category: 'Food', amount: 170 }] });
    const api = mockApi({
      ...baseRoutes(),
      'POST /finance/expenses': () => pending.promise,
      'PUT /finance/category-treatments/Transport': () => transportTreatment.promise,
    });
    renderSpending();
    const card = await outcomeCard();
    await screen.findByText('Recent entries for ' + MONTH_NAME);
    await waitFor(() => expect(rowOf(1)).toBeInTheDocument());
    const before = money(spendingSnapshot(MONTH, { expenses: BASE }), 'remainingSpendable');
    const documentMarker = document.body.appendChild(document.createElement('i'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Amount' }), { target: { value: '170' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Note (optional)' }), { target: { value: 'Lunch' } });
    const submit = logButton();
    submit.focus();
    // Pending feedback is in the DOM before the click handler's act() returns.
    act(() => {
      fireEvent.click(submit);
    });
    const creating = document.querySelector('[data-pending-create]') as HTMLElement;
    expect(creating).toHaveTextContent('Saving this expense…');
    expect(creating).toHaveTextContent('₹170');
    expect(within(creating).getByRole('status')).toHaveTextContent('Log expense: pending');
    // The outcome keeps its last confirmed values and says it is refreshing.
    expect(card).toHaveTextContent('Refreshing…');
    expect(valueOf(card, 'Remaining spendable')).toHaveTextContent(before);
    expect(submit).toHaveFocus();
    // The request carries whole paise, the contract header, and an idempotency key.
    const [post] = api.to('POST', '/finance/expenses');
    expect(post?.body).toEqual({ amountMinor: paise(170), category: 'Food', note: 'Lunch' });
    expect(post?.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(post?.headers['X-Clarity-Contract']).toBe('1');
    // The form is free for the next entry, and unrelated controls stay interactive.
    expect(screen.getByRole('textbox', { name: 'Amount' })).toHaveValue('');
    expect(editButton('Shopping', '₹500')).not.toHaveAttribute('aria-disabled');
    await user.click(screen.getByRole('button', { name: 'Count Transport as Wants' }));
    expect(statusOf('category-treatment:transport')).toHaveTextContent('Count Transport as Wants: pending');
    await act(async () => {
      pending.resolve(okResponse(expenseEnvelope(confirmed, {
        scopeKey: 'expense:4',
        operation: 'expense.create',
        recordType: 'expense',
        recordId: 4,
        record: { id: 4, month: MONTH, category: 'Food', amountMinor: paise(170), note: 'Lunch', spentOn: `${MONTH}-10` },
        transition: {
          type: 'create',
          originalPeriod: null,
          resultingPeriod: MONTH,
          originalCategory: null,
          resultingCategory: 'Food',
          affectedPeriods: [MONTH],
        },
      })));
    });
    await waitFor(() => expect(document.querySelector('[data-pending-create]')).toBeNull());
    // The Transport treatment is still pending, so the outcome says it is refreshing until that settles too.
    expect(statusOf('category-treatment:transport')).toHaveTextContent('Count Transport as Wants: pending');
    expect(screen.getByRole('article', { name: `Spending for ${MONTH_NAME}` })).toHaveTextContent('Refreshing…');
    await act(async () => {
      transportTreatment.resolve(failure(500, 'SERVER_ERROR', 'The treatment could not be saved.'));
    });
    await waitFor(() => expect(statusOf('category-treatment:transport')).toHaveTextContent('failed.'));
    // The confirmed row replaces the provisional one, and outcomes come from the response.
    expect(rowOf(4)).toHaveTextContent('Lunch');
    expect(rowOf(4)).toHaveTextContent('₹170');
    expect(rowOf(4)).toHaveTextContent('Log expense: done');
    const updated = screen.getByRole('article', { name: `Spending for ${MONTH_NAME}` });
    expect(valueOf(updated, 'Remaining spendable')).toHaveTextContent(money(confirmed, 'remainingSpendable'));
    expect(valueOf(updated, 'Daily spending guide')).toHaveTextContent('₹3,690');
    expect(updated).not.toHaveTextContent('Refreshing…');
    const notice = screen.getByRole('region', { name: 'Latest change to your spending' });
    expect(notice).toHaveTextContent('Added to Food for');
    expect(notice).toHaveTextContent(`Recalculated: ${MONTH_NAME}.`);
    // Same document, no reload, and no broad refetch: the list, plan, and snapshot were each read once.
    expect(reload).not.toHaveBeenCalled();
    expect(documentMarker.isConnected).toBe(true);
    expect(api.to('GET', '/finance/expenses')).toHaveLength(1);
    expect(api.to('GET', '/finance/clarity')).toHaveLength(1);
    expect(api.to('GET', '/finance/plan')).toHaveLength(0);
    expect(api.to('GET', '/finance/budgets')).toHaveLength(1);
    documentMarker.remove();
  });

  it('keeps a failed new expense with its values and retries with the same body and idempotency key', async () => {
    const user = userEvent.setup();
    const retried = deferred<Response>();
    const confirmed = spendingSnapshot(MONTH, { dataVersion: 2, expenses: [...BASE, { id: 4, category: 'Food', amount: 170 }] });
    const api = mockApi({
      ...baseRoutes(),
      'POST /finance/expenses': (_call, attempt) => (
        attempt === 1 ? failure(500, 'SERVER_ERROR', 'The expense could not be saved.') : retried.promise
      ),
    });
    renderSpending();
    await outcomeCard();
    await waitFor(() => expect(rowOf(1)).toBeInTheDocument());
    fireEvent.change(screen.getByRole('textbox', { name: 'Amount' }), { target: { value: '170' } });
    await user.click(logButton());
    const failed = await waitFor(() => {
      const row = document.querySelector('[data-pending-create]') as HTMLElement;
      expect(within(row).getByRole('alert')).toHaveTextContent('Log expense: failed.');
      return row;
    });
    expect(failed).toHaveTextContent('Not saved yet');
    expect(failed).toHaveTextContent('₹170');
    // Confirmed rows and outcomes are untouched by the failure.
    expect(screen.getByRole('article', { name: `Spending for ${MONTH_NAME}` })).not.toHaveTextContent('Refreshing…');
    expect(rowOf(1)).toBeInTheDocument();
    await user.click(within(failed).getByRole('button', { name: 'Retry Log expense' }));
    expect(within(document.querySelector('[data-pending-create]') as HTMLElement).getByRole('status')).toHaveTextContent('Log expense: pending');
    const posts = api.to('POST', '/finance/expenses');
    expect(posts).toHaveLength(2);
    expect(posts[1]?.headers['Idempotency-Key']).toBe(posts[0]?.headers['Idempotency-Key']);
    expect(posts[1]?.body).toEqual(posts[0]?.body);
    await act(async () => {
      retried.resolve(okResponse(expenseEnvelope(confirmed, {
        scopeKey: 'expense:4',
        operation: 'expense.create',
        recordType: 'expense',
        recordId: 4,
        record: { id: 4, month: MONTH, category: 'Food', amountMinor: paise(170), note: null, spentOn: `${MONTH}-10` },
        transition: { type: 'create', originalPeriod: null, resultingPeriod: MONTH, originalCategory: null, resultingCategory: 'Food', affectedPeriods: [MONTH] },
      })));
    });
    // The retry finishes like the first attempt: the saved row replaces the failed one and the notice appears.
    await waitFor(() => expect(document.querySelector('[data-pending-create]')).toBeNull());
    expect(rowOf(4)).toHaveTextContent('₹170');
    expect(screen.getByRole('region', { name: 'Latest change to your spending' })).toHaveTextContent('Added to Food');
    expect(reload).not.toHaveBeenCalled();
  });

  it('puts a failed entry back in the form with "Edit again" and drops the unsaved row', async () => {
    const user = userEvent.setup();
    mockApi({
      ...baseRoutes(),
      'POST /finance/expenses': () => failure(422, 'UNKNOWN_EXPENSE_CATEGORY', 'Unknown category.'),
    });
    renderSpending();
    await outcomeCard();
    await waitFor(() => expect(rowOf(1)).toBeInTheDocument());
    fireEvent.change(screen.getByRole('textbox', { name: 'Amount' }), { target: { value: '99' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Note (optional)' }), { target: { value: 'Tea' } });
    await user.click(logButton());
    const failed = await waitFor(() => {
      const row = document.querySelector('[data-pending-create]') as HTMLElement;
      expect(row).toHaveTextContent('Log expense: failed.');
      return row;
    });
    await user.click(within(failed).getByRole('button', { name: 'Edit again' }));
    expect(screen.getByRole('textbox', { name: 'Amount' })).toHaveValue('99');
    expect(screen.getByRole('textbox', { name: 'Note (optional)' })).toHaveValue('Tea');
    expect(document.querySelector('[data-pending-create]')).toBeNull();
    expect(document.querySelector('[data-scope^="new-expense:"]')).toBeNull();
  });

  it('names the invalid input, keeps the valid ones, announces without moving focus, and sends nothing', async () => {
    const api = mockApi(baseRoutes());
    renderSpending();
    await outcomeCard();
    const amount = screen.getByRole('textbox', { name: 'Amount' });
    const note = screen.getByRole('textbox', { name: 'Note (optional)' });
    fireEvent.change(amount, { target: { value: '12.345' } });
    fireEvent.change(note, { target: { value: 'Keep me' } });
    note.focus();
    act(() => {
      fireEvent.click(logButton());
    });
    const error = screen.getByText(/Amount:/).closest('p') as HTMLElement;
    expect(error).toHaveTextContent('Amount: must be an amount above 0.');
    expect(error).toHaveTextContent('at most 2 decimals');
    expect(amount).toHaveAttribute('aria-invalid', 'true');
    expect(amount.getAttribute('aria-describedby')).toContain(error.id);
    expect(note).toHaveFocus();
    expect(note).toHaveValue('Keep me');
    expect(amount).toHaveValue('12.345');
    expect(api.calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });
});

describe('correct an expense', () => {
  async function openEdit(user: ReturnType<typeof userEvent.setup>, category: string, amount: string) {
    await user.click(editButton(category, amount));
    return screen.getByRole('form', { name: `Correct ${category} ${amount}` });
  }

  it('rolls back only the failed row, keeps its draft, and retries with the same key and the same post-save handling', async () => {
    const user = userEvent.setup();
    const first = deferred<Response>();
    const second = deferred<Response>();
    const retried = deferred<Response>();
    const afterShopping = spendingSnapshot(MONTH, { dataVersion: 2, expenses: [FOOD, { ...SHOPPING, amount: 500 }, TRANSPORT] });
    const afterFood = spendingSnapshot(MONTH, { dataVersion: 3, expenses: [{ ...FOOD, amount: 670 }, SHOPPING, TRANSPORT] });
    const api = mockApi({
      ...baseRoutes(),
      'PATCH /finance/expenses/1': (_call, attempt) => (attempt === 1 ? first.promise : retried.promise),
      'PATCH /finance/expenses/2': () => second.promise,
    });
    renderSpending();
    const card = await outcomeCard();
    await waitFor(() => expect(rowOf(1)).toBeInTheDocument());
    const foodForm = await openEdit(user, 'Food', '₹500');
    fireEvent.change(within(foodForm).getByRole('textbox', { name: 'Amount' }), { target: { value: '670' } });
    const shoppingForm = await openEdit(user, 'Shopping', '₹500');
    fireEvent.change(within(shoppingForm).getByRole('textbox', { name: 'Note (optional)' }), { target: { value: 'Shoes' } });
    act(() => {
      fireEvent.click(within(foodForm).getByRole('button', { name: 'Save changes' }));
    });
    act(() => {
      fireEvent.click(within(shoppingForm).getByRole('button', { name: 'Save changes' }));
    });
    // Two independent changes, each with its own status. Only changed fields are sent.
    expect(statusOf('expense:1')).toHaveTextContent('Update Food expense: pending');
    expect(statusOf('expense:2')).toHaveTextContent('Update Shopping expense: pending');
    expect(api.to('PATCH', '/finance/expenses/1')[0]?.body).toEqual({ amountMinor: paise(670) });
    expect(api.to('PATCH', '/finance/expenses/2')[0]?.body).toEqual({ note: 'Shoes' });
    // The rows show the entered values while pending; calculated outcomes keep their confirmed values.
    expect(rowOf(1)).toHaveTextContent('₹670');
    expect(rowOf(2)).toHaveTextContent('Shoes');
    expect(card).toHaveTextContent('Refreshing…');
    expect(valueOf(card, 'Spent so far')).toHaveTextContent('₹1,100');
    // Shopping is confirmed while Food is still pending.
    await act(async () => {
      second.resolve(okResponse(expenseEnvelope(afterShopping, {
        scopeKey: 'expense:2',
        operation: 'expense.update',
        recordType: 'expense',
        recordId: 2,
        record: { id: 2, month: MONTH, category: 'Shopping', amountMinor: paise(500), note: 'Shoes', spentOn: `${MONTH}-10` },
        transition: { type: 'update', originalPeriod: MONTH, resultingPeriod: MONTH, originalCategory: 'Shopping', resultingCategory: 'Shopping', affectedPeriods: [MONTH] },
      })));
    });
    await waitFor(() => expect(statusOf('expense:2')).toHaveTextContent('Update Shopping expense: done'));
    expect(statusOf('expense:1')).toHaveTextContent('Update Food expense: pending');
    expect(rowOf(2)).toHaveTextContent('Shoes');
    expect(screen.queryByRole('form', { name: 'Correct Shopping ₹500' })).toBeNull();
    // Food fails. Only Food rolls back; its draft stays in the open form.
    await act(async () => {
      first.resolve(failure(500, 'SERVER_ERROR', 'The correction could not be saved.'));
    });
    await waitFor(() => expect(statusOf('expense:1')).toHaveTextContent('Update Food expense: failed.'));
    expect(statusOf('expense:1')).toHaveTextContent('The correction could not be saved.');
    // The form reopens with the draft; the record behind it is still the confirmed ₹500, and so is its category total.
    const reopened = screen.getByRole('form', { name: 'Correct Food ₹500' });
    expect(within(reopened).getByRole('textbox', { name: 'Amount' })).toHaveValue('670');
    expect(within((await screen.findByText('Food', { selector: '.pill' })).closest('li') as HTMLElement).getByText('₹500')).toBeInTheDocument();
    expect(valueOf(screen.getByRole('article', { name: `Spending for ${MONTH_NAME}` }), 'Spent so far')).toHaveTextContent('₹1,100');
    expect(rowOf(2)).toHaveTextContent('Shoes');
    // Retry resends the same request with the same key and then closes the form, as the first attempt would have.
    await user.click(within(statusOf('expense:1')).getByRole('button', { name: 'Retry Update Food expense' }));
    expect(statusOf('expense:1')).toHaveTextContent('Update Food expense: pending');
    expect(rowOf(1)).toHaveTextContent('₹670');
    const patches = api.to('PATCH', '/finance/expenses/1');
    expect(patches).toHaveLength(2);
    expect(patches[1]?.headers['Idempotency-Key']).toBe(patches[0]?.headers['Idempotency-Key']);
    expect(patches[1]?.body).toEqual(patches[0]?.body);
    await act(async () => {
      retried.resolve(okResponse(expenseEnvelope(afterFood, {
        scopeKey: 'expense:1',
        operation: 'expense.update',
        recordType: 'expense',
        recordId: 1,
        record: { id: 1, month: MONTH, category: 'Food', amountMinor: paise(670), note: null, spentOn: `${MONTH}-10` },
        transition: { type: 'update', originalPeriod: MONTH, resultingPeriod: MONTH, originalCategory: 'Food', resultingCategory: 'Food', affectedPeriods: [MONTH] },
      })));
    });
    await waitFor(() => expect(statusOf('expense:1')).toHaveTextContent('Update Food expense: done'));
    expect(screen.queryByRole('form', { name: /^Correct Food/ })).toBeNull();
    expect(rowOf(1)).toHaveTextContent('₹670');
    expect(editButton('Food', '₹670')).toHaveFocus();
    expect(valueOf(screen.getByRole('article', { name: `Spending for ${MONTH_NAME}` }), 'Remaining spendable'))
      .toHaveTextContent(money(afterFood, 'remainingSpendable'));
    expect(reload).not.toHaveBeenCalled();
    expect(api.to('GET', '/finance/expenses')).toHaveLength(1);
  });

  it('moves an expense to another month: both months recalculate and the row leaves this month', async () => {
    const user = userEvent.setup();
    const priorSnapshot = spendingSnapshot(PRIOR, { dataVersion: 2, expenses: [{ ...SHOPPING }] });
    const movedAway = spendingSnapshot(MONTH, { dataVersion: 2, expenses: [FOOD, TRANSPORT] });
    const api = mockApi({
      ...baseRoutes(),
      'GET /finance/clarity': (_call, attempt) => okResponse(read(attempt === 1 ? spendingSnapshot(MONTH, { expenses: BASE }) : movedAway)),
      'PATCH /finance/expenses/2': () => okResponse(expenseEnvelope(priorSnapshot, {
        scopeKey: 'expense:2',
        operation: 'expense.update',
        recordType: 'expense',
        recordId: 2,
        record: { id: 2, month: PRIOR, category: 'Shopping', amountMinor: paise(500), note: null, spentOn: `${PRIOR}-20` },
        transition: { type: 'move', originalPeriod: MONTH, resultingPeriod: PRIOR, originalCategory: 'Shopping', resultingCategory: 'Shopping', affectedPeriods: [MONTH, PRIOR] },
      })),
    });
    renderSpending();
    await outcomeCard();
    await waitFor(() => expect(rowOf(2)).toBeInTheDocument());
    const form = await openEdit(user, 'Shopping', '₹500');
    fireEvent.change(within(form).getByLabelText(/^Date/), { target: { value: `${PRIOR}-20` } });
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    expect(api.to('PATCH', '/finance/expenses/2')[0]?.body).toEqual({ spentOn: `${PRIOR}-20` });
    await waitFor(() => expect(rowOf(2)).toBeNull());
    const notice = await screen.findByRole('region', { name: 'Latest change to your spending' });
    expect(notice).toHaveTextContent(`Moved from Shopping in ${MONTH_NAME} to Shopping in ${PRIOR_NAME}.`);
    expect(notice).toHaveTextContent(`Recalculated: ${MONTH_NAME} and ${PRIOR_NAME}.`);
    // The response was for the other month, so the month on screen was read again and now excludes the expense.
    await waitFor(() => expect(api.to('GET', '/finance/clarity')).toHaveLength(2));
    await waitFor(() => expect(valueOf(screen.getByRole('article', { name: `Spending for ${MONTH_NAME}` }), 'Spent so far'))
      .toHaveTextContent(money(movedAway, 'totalSpending')));
    expect(api.to('GET', '/finance/expenses')).toHaveLength(1);
    expect(reload).not.toHaveBeenCalled();
  });

  it('names an invalid date or amount in the row form and keeps every other entered value', async () => {
    const user = userEvent.setup();
    const api = mockApi(baseRoutes());
    renderSpending();
    await outcomeCard();
    await waitFor(() => expect(rowOf(1)).toBeInTheDocument());
    const form = await openEdit(user, 'Food', '₹500');
    fireEvent.change(within(form).getByRole('textbox', { name: 'Amount' }), { target: { value: '0' } });
    fireEvent.change(within(form).getByRole('textbox', { name: 'Note (optional)' }), { target: { value: 'Dinner' } });
    fireEvent.change(within(form).getByLabelText(/^Date/), { target: { value: '1990-01-01' } });
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    const amountError = within(form).getByText(/Amount:/).closest('p') as HTMLElement;
    expect(amountError).toHaveTextContent('must be an amount above 0.');
    expect(within(form).getByRole('textbox', { name: 'Amount' })).toHaveAttribute('aria-invalid', 'true');
    expect(within(form).getByText(/Date:/).closest('p')).toHaveTextContent('Pick a real day between');
    expect(within(form).getByRole('textbox', { name: 'Note (optional)' })).toHaveValue('Dinner');
    expect(api.calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });
});

describe('delete an expense', () => {
  it('keeps the row with its own status on failure, retries with the same key, and removes it once confirmed', async () => {
    const user = userEvent.setup();
    const confirmed = spendingSnapshot(MONTH, { dataVersion: 2, expenses: [FOOD, SHOPPING] });
    const api = mockApi({
      ...baseRoutes(),
      'DELETE /finance/expenses/3': (_call, attempt) => (
        attempt === 1
          ? failure(500, 'SERVER_ERROR', 'The expense could not be deleted.')
          : okResponse(expenseEnvelope(confirmed, {
            scopeKey: 'expense:3',
            operation: 'expense.delete',
            recordType: 'expense',
            recordId: 3,
            record: null,
            transition: { type: 'delete', originalPeriod: MONTH, resultingPeriod: null, originalCategory: 'Transport', resultingCategory: null, affectedPeriods: [MONTH] },
          }))
      ),
    });
    renderSpending();
    await outcomeCard();
    await waitFor(() => expect(rowOf(3)).toBeInTheDocument());
    await user.click(deleteButton('Transport', '₹100'));
    await waitFor(() => expect(statusOf('expense:3')).toHaveTextContent('Delete Transport expense: failed.'));
    expect(rowOf(3)).toHaveTextContent('₹100');
    expect(rowOf(1)).toBeInTheDocument();
    await user.click(within(statusOf('expense:3')).getByRole('button', { name: 'Retry Delete Transport expense' }));
    await waitFor(() => expect(rowOf(3)).toBeNull());
    const deletes = api.to('DELETE', '/finance/expenses/3');
    expect(deletes).toHaveLength(2);
    expect(deletes[1]?.headers['Idempotency-Key']).toBe(deletes[0]?.headers['Idempotency-Key']);
    expect(deletes[0]?.headers['X-Clarity-Contract']).toBe('1');
    expect(screen.getByRole('region', { name: 'Latest change to your spending' })).toHaveTextContent('Removed from Transport');
    expect(valueOf(screen.getByRole('article', { name: `Spending for ${MONTH_NAME}` }), 'Spent so far'))
      .toHaveTextContent(money(confirmed, 'totalSpending'));
    // Focus is not dropped to the page when the row it was in is removed.
    expect(document.activeElement).not.toBe(document.body);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('Needs and Wants treatment per category', () => {
  it('changes one category on its own, rolls back on failure, retries with the same key, and updates totals from the server', async () => {
    const user = userEvent.setup();
    const retried = deferred<Response>();
    const afterFood = spendingSnapshot(MONTH, {
      dataVersion: 2,
      expenses: [{ ...FOOD, override: { treatment: 'wants', recordId: 9 } }, SHOPPING, TRANSPORT],
    });
    const api = mockApi({
      ...baseRoutes(),
      'PUT /finance/category-treatments/Food': (_call, attempt) => (
        attempt === 1 ? failure(500, 'SERVER_ERROR', 'The treatment could not be saved.') : retried.promise
      ),
    });
    renderSpending();
    const card = await outcomeCard();
    const foodRow = (await screen.findByText('Food', { selector: '.pill' })).closest('li') as HTMLElement;
    const transportRow = screen.getByText('Transport', { selector: '.pill' }).closest('li') as HTMLElement;
    await user.click(within(foodRow).getByRole('button', { name: 'Count Food as Wants' }));
    // The failure rolls Food back to Needs and leaves every other category alone.
    await waitFor(() => expect(statusOf('category-treatment:food')).toHaveTextContent('Count Food as Wants: failed.'));
    expect(within(foodRow).getByRole('button', { name: 'Count Food as Needs' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(foodRow).getByRole('button', { name: 'Count Food as Wants' })).toHaveAttribute('aria-pressed', 'false');
    expect(valueOf(card, 'Needs spent of budget')).toHaveTextContent('₹600');
    expect(within(transportRow).getByRole('button', { name: 'Count Transport as Needs' })).toHaveAttribute('aria-pressed', 'true');
    expect(statusOf('category-treatment:transport')).not.toHaveTextContent(/pending|failed|done/);
    // Retry: pending shows the chosen treatment at once; other categories stay usable.
    await user.click(within(statusOf('category-treatment:food')).getByRole('button', { name: 'Retry Count Food as Wants' }));
    expect(statusOf('category-treatment:food')).toHaveTextContent('Count Food as Wants: pending');
    expect(within(foodRow).getByRole('button', { name: 'Count Food as Wants' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(transportRow).getByRole('button', { name: 'Count Transport as Wants' })).not.toHaveAttribute('aria-disabled');
    expect(valueOf(card, 'Needs spent of budget')).toHaveTextContent('₹600');
    const puts = api.to('PUT', '/finance/category-treatments/Food');
    expect(puts).toHaveLength(2);
    expect(puts[0]?.body).toEqual({ treatment: 'wants' });
    expect(puts[1]?.headers['Idempotency-Key']).toBe(puts[0]?.headers['Idempotency-Key']);
    await act(async () => {
      retried.resolve(okResponse(expenseEnvelope(afterFood, {
        scopeKey: 'category-treatment:food',
        operation: 'category_treatment.set',
        recordType: 'category_treatment',
        recordId: 9,
        record: { id: 9, category: 'Food', treatment: 'wants' },
      })));
    });
    await waitFor(() => expect(statusOf('category-treatment:food')).toHaveTextContent('Count Food as Wants: done'));
    const updated = screen.getByRole('article', { name: `Spending for ${MONTH_NAME}` });
    expect(valueOf(updated, 'Needs spent of budget')).toHaveTextContent(money(afterFood, 'needsSpent'));
    expect(valueOf(updated, 'Wants spent of budget')).toHaveTextContent(money(afterFood, 'wantsSpent'));
    expect(foodRow).toHaveTextContent('Counted as Wants (your choice)');
    expect(screen.getByRole('region', { name: 'Latest change to your spending' })).toHaveTextContent('Food now counts as Wants.');
    // Restoring the default is its own change with its own scope.
    const restore = within(foodRow).getByRole('button', { name: 'Use the default treatment for Food' });
    expect(restore).toBeInTheDocument();
  });

  it('restores the default treatment with a DELETE that sends the saved record version', async () => {
    const user = userEvent.setup();
    const start = spendingSnapshot(MONTH, { expenses: [{ ...FOOD, override: { treatment: 'wants', recordId: 9 } }, SHOPPING] });
    const after = spendingSnapshot(MONTH, { dataVersion: 2, expenses: [FOOD, SHOPPING] });
    const api = mockApi({
      ...baseRoutes(start, [FOOD, SHOPPING]),
      'DELETE /finance/category-treatments/Food': () => okResponse(expenseEnvelope(after, {
        scopeKey: 'category-treatment:food',
        operation: 'category_treatment.remove',
        recordType: 'category_treatment',
        recordId: 9,
        record: null,
      })),
    });
    renderSpending();
    await outcomeCard();
    const foodRow = (await screen.findByText('Food', { selector: '.pill' })).closest('li') as HTMLElement;
    expect(foodRow).toHaveTextContent('Counted as Wants (your choice)');
    await user.click(within(foodRow).getByRole('button', { name: 'Use the default treatment for Food' }));
    await waitFor(() => expect(statusOf('category-treatment:food')).toHaveTextContent('Use the default for Food: done'));
    expect(api.to('DELETE', '/finance/category-treatments/Food')[0]?.body).toEqual({});
    expect(foodRow).toHaveTextContent('Counted as Needs (default)');
    expect(screen.getByRole('region', { name: 'Latest change to your spending' })).toHaveTextContent('Food uses its default treatment again.');
  });
});

describe('calculation failure', () => {
  it('keeps the confirmed entries and the typed draft, and recalculates without any new entry', async () => {
    const user = userEvent.setup();
    const failed = spendingSnapshot(MONTH, {
      expenses: BASE,
      spending: { status: 'calculation_failed', value: undefined, retry: { action: 'recalculate', scopeKey: `outcome:spending:${MONTH}` } },
    });
    const api = mockApi({
      ...baseRoutes(),
      'GET /finance/clarity': (_call, attempt) => okResponse(read(attempt === 1 ? failed : spendingSnapshot(MONTH, { dataVersion: 2, expenses: BASE }))),
    });
    renderSpending();
    const card = await outcomeCard();
    expect(card).toHaveAttribute('data-status', 'calculation_failed');
    expect(within(card).getByText('Temporarily unavailable.', { selector: 'strong' })).toBeInTheDocument();
    expect(within(card).getAllByRole('button', { name: /Recalculate/ })).toHaveLength(1);
    // Entries stay, category totals say they are unavailable, and the form still works.
    await waitFor(() => expect(rowOf(1)).toBeInTheDocument());
    expect(rowOf(1)).toHaveTextContent('₹500');
    expect(screen.getByText(/Category totals are temporarily unavailable/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Amount' }), { target: { value: '321' } });
    expect(logButton()).toBeEnabled();
    await user.click(within(card).getByRole('button', { name: /Recalculate Spending for/ }));
    await waitFor(() => expect(screen.getByRole('article', { name: `Spending for ${MONTH_NAME}` })).toHaveAttribute('data-status', 'available'));
    expect(screen.getByRole('textbox', { name: 'Amount' })).toHaveValue('321');
    expect(rowOf(1)).toBeInTheDocument();
    expect(api.calls.filter((call) => call.method !== 'GET')).toEqual([]);
    expect(api.to('GET', '/finance/clarity')).toHaveLength(2);
  });

  it('names the missing pay and previews with a labelled example before any expense exists', async () => {
    mockApi({
      'GET /finance/clarity': read(spendingSnapshot(MONTH, {
        spending: { status: 'missing_input', value: undefined, missing: [{ input: 'salary', unlocks: ['monthly_plan', 'spending'] }] },
      })),
      'GET /finance/expenses': listFor([]),
    });
    renderSpending();
    const card = await outcomeCard();
    expect(card).toHaveTextContent('Needs input');
    expect(card).toHaveTextContent('Add salary to unlock your monthly plan and spending guidance.');
    expect(within(card).getByRole('link', { name: /Add this month’s pay/ })).toHaveAttribute('href', '/plan#pay-form');
    expect(document.getElementById('benefit-expense')).toHaveTextContent('Example, not your data.');
    expect(await screen.findByText('Log a few expenses to see your actuals against the plan.')).toBeInTheDocument();
  });
});

describe('data-use gate', () => {
  it('pauses only new expenses, with a reason, and never corrections, deletes, or treatments', async () => {
    const api = mockApi({
      'GET /clarity/settings': buildSettings(),
      ...baseRoutes(),
    });
    renderSpending({ gate: true });
    await outcomeCard();
    await waitFor(() => expect(document.getElementById(DATA_USE_REASON_ID)).toBeInTheDocument());
    const submit = logButton();
    expect(submit).toBeDisabled();
    expect(submit).toHaveAttribute('aria-describedby', DATA_USE_REASON_ID);
    expect(document.getElementById(DATA_USE_REASON_ID)).toHaveTextContent(/acknowledge the data-use notice/i);
    expect(screen.getByRole('textbox', { name: 'Amount' }).getAttribute('aria-describedby')).toContain(DATA_USE_REASON_ID);
    await waitFor(() => expect(rowOf(1)).toBeInTheDocument());
    expect(editButton('Food', '₹500')).not.toHaveAttribute('aria-disabled');
    expect(deleteButton('Food', '₹500')).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Count Food as Wants' })).toBeEnabled();
    expect(screen.getByRole('article', { name: `Spending for ${MONTH_NAME}` })).toBeInTheDocument();
    expect(api.calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });
});

describe('arrival from an action link', () => {
  it('shows and focuses the named expense even when it is beyond the first entries', async () => {
    const many = Array.from({ length: 10 }, (_, index) => ({ id: index + 1, category: 'Food', amount: 10 + index }));
    mockApi(baseRoutes(spendingSnapshot(MONTH, { expenses: many }), many));
    renderSpending({ route: '/spending?action=correct-expense&expenseId=10' });
    await waitFor(() => expect(rowOf(10)).toBeInTheDocument());
    await waitFor(() => expect(rowOf(10)).toHaveFocus(), { timeout: 3000 });
    expect(screen.getByRole('button', { name: 'Show fewer' })).toHaveAttribute('aria-expanded', 'true');
  });
});

describe('rollout flag off', () => {
  const PLAN: PlanData = {
    income: 75000,
    emiTotal: 0,
    afterFixed: 75000,
    breakdown: { needs: 37500, wants: 22500, save: 15000 },
    tips: [],
    month: MONTH,
    spentThisMonth: 0,
  };

  beforeEach(() => {
    vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', '');
  });

  it('renders and behaves as before: legacy reads, the old log call, no clarity contract', async () => {
    const user = userEvent.setup();
    const api = mockApi({
      'GET /finance/clarity': () => failure(500, 'SERVER_ERROR', 'must not be called'),
      'GET /finance/plan': PLAN,
      'GET /finance/expenses': listFor([FOOD]),
      'POST /finance/expenses': { id: 11, month: MONTH },
    });
    const { container } = renderSpending();
    expect(await screen.findByRole('heading', { level: 1, name: /Spending/ })).toBeInTheDocument();
    expect(await screen.findByText("📊 This month's spending")).toBeInTheDocument();
    expect(container.querySelector('.clarity-decision-header')).toBeNull();
    expect(screen.queryByRole('article')).toBeNull();
    expect(document.getElementById('purpose-expense')).toBeNull();
    expect(screen.queryByRole('form', { name: 'Log an expense' })).toBeNull();
    expect(screen.queryByRole('group', { name: /Budget treatment/ })).toBeNull();
    await waitFor(() => expect(screen.getByText('Spent so far')).toBeInTheDocument());
    fireEvent.change(screen.getByRole('textbox', { name: 'Amount' }), { target: { value: '480' } });
    await user.click(screen.getByRole('button', { name: '+ Log expense' }));
    await waitFor(() => expect(api.to('POST', '/finance/expenses')).toHaveLength(1));
    const [post] = api.to('POST', '/finance/expenses');
    expect(post?.body).toEqual({ amount: 480, category: 'Food' });
    expect(post?.headers['Idempotency-Key']).toBeUndefined();
    expect(post?.headers['X-Clarity-Contract']).toBeUndefined();
    expect(api.to('GET', '/finance/clarity')).toHaveLength(0);
    expect(api.to('GET', '/finance/plan').length).toBeGreaterThanOrEqual(1);
  });
});

describe.each(['light', 'dark'] as const)('accessibility in the %s theme', (theme) => {
  async function expectNoViolations(setup: () => void, ready: () => Promise<unknown>) {
    document.documentElement.dataset.theme = theme;
    try {
      setup();
      const { container } = renderSpending();
      await ready();
      expect(await axe(container)).toHaveNoViolations();
    } finally {
      delete document.documentElement.dataset.theme;
    }
  }

  it('has no violations with totals, treatments, an exceeded budget, and a row form open', async () => {
    const user = userEvent.setup();
    await expectNoViolations(
      () => {
        mockApi({
          ...baseRoutes(spendingSnapshot(MONTH, { expenses: [FOOD, { ...SHOPPING, override: { treatment: 'needs', recordId: 4 } }, TRANSPORT], needsBudget: 400, actions: [NEEDS_ACTION] })),
          'GET /finance/budgets': { budgets: { Food: 3000 } },
        });
      },
      async () => {
        await outcomeCard();
        await waitFor(() => expect(rowOf(1)).toBeInTheDocument());
        await screen.findByText('Your limit:', { exact: false });
        await user.click(editButton('Food', '₹500'));
      },
    );
  });

  it('has no violations with a calculation failure, a failed save, and a pending create', async () => {
    const user = userEvent.setup();
    await expectNoViolations(
      () => {
        mockApi({
          ...baseRoutes(spendingSnapshot(MONTH, {
            expenses: BASE,
            spending: { status: 'calculation_failed', value: undefined, retry: { action: 'recalculate', scopeKey: `outcome:spending:${MONTH}` } },
          })),
          'POST /finance/expenses': () => failure(500, 'SERVER_ERROR', 'The expense could not be saved.'),
        });
      },
      async () => {
        await outcomeCard();
        await waitFor(() => expect(rowOf(1)).toBeInTheDocument());
        fireEvent.change(screen.getByRole('textbox', { name: 'Amount' }), { target: { value: '25' } });
        await user.click(logButton());
        await waitFor(() => expect(document.querySelector('[data-pending-create]')).toHaveTextContent('Log expense: failed.'));
      },
    );
  });
});

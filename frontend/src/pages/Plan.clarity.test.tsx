import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PAGE_DECISIONS } from '../clarity/actionContext';
import type { FinancialSnapshot } from '../clarity/contracts';
import { DataUseGateProvider } from '../clarity/DataUseGateProvider';
import { FinancialClarityProvider } from '../clarity/FinancialClarityProvider';
import { MutationStatusProvider } from '../clarity/MutationStatusProvider';
import { DATA_USE_REASON_ID, DataUseGate } from '../components/clarity';
import { currentMonth, monthLabel } from '../money';
import { deferred } from '../test/clarity-fixtures';
import { buildSettings } from '../test/dataUseFixtures';
import { BILLS_ACTION, mutationEnvelope, planSnapshot } from '../test/planFixtures';
import { axe, createApiResponse, createTestQueryClient, renderAuthenticated } from '../test/test-utils';
import type { Plan as PlanData } from '../types';
import { Plan } from './Plan';

const MONTH = currentMonth();
const MONTH_NAME = monthLabel(MONTH);
const PRIOR = (() => {
  const now = new Date();
  const prior = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${prior.getFullYear()}-${String(prior.getMonth() + 1).padStart(2, '0')}`;
})();
const PRIOR_NAME = monthLabel(PRIOR);
const SALARY_SCOPE = `salary:${MONTH}`;
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
    const route = routes[key];
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

function renderPlan(options: { gate?: boolean; queryClient?: ReturnType<typeof createTestQueryClient> } = {}) {
  const page = options.gate
    ? (
      <DataUseGateProvider enabled>
        <DataUseGate />
        <Plan />
      </DataUseGateProvider>
    )
    : <Plan />;
  return renderAuthenticated(
    <FinancialClarityProvider>
      <MutationStatusProvider>{page}</MutationStatusProvider>
    </FinancialClarityProvider>,
    { route: '/plan', queryClient: options.queryClient ?? createTestQueryClient() },
  );
}

const statusOf = (scope: string) => document.querySelector(`[data-scope="${scope}"]`) as HTMLElement;
const payField = () => screen.findByRole('textbox', { name: 'Monthly pay' });
const saveButton = () => screen.getByRole('button', { name: `Save pay for ${MONTH_NAME}` });
const addButton = () => screen.getByRole('button', { name: '+ Add bill' });
const comesBefore = (first: Element, second: Element) =>
  Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
const planCard = () => screen.findByRole('article', { name: `Your plan for ${MONTH_NAME}` });

const RENT = { id: 1, label: 'Rent', amountMinor: paise(20000) };
const RENT_EMI = { id: 1, label: 'Rent', amount: 20000, category: 'Rent' };

const reload = vi.fn();
beforeEach(() => {
  vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'true');
  reload.mockClear();
  vi.stubGlobal('location', { ...window.location, reload });
});

describe('exact-month outcomes with purposes and previews', () => {
  it('shows the month, the calculated plan, and each purpose and preview before its input', async () => {
    mockApi({
      'GET /finance/clarity': read(planSnapshot(MONTH, { bills: [RENT] })),
      'GET /finance/emis': { emis: [RENT_EMI] },
      'GET /finance/salary': { salary: { month: MONTH, amount: 75000 } },
    });
    const { container } = renderPlan();

    const card = await planCard();
    expect(within(card).getByText('Disposable income').closest('.clarity-value')).toHaveTextContent('₹55,000');
    expect(within(card).getByText('Needs budget (50%)').closest('.clarity-value')).toHaveTextContent('₹27,500');
    expect(within(card).getByText(`Pay for ${MONTH_NAME}`).closest('.clarity-value')).toHaveTextContent('Entered fact');
    expect(within(card).getByText('Disposable income').closest('.clarity-value')).toHaveTextContent('Calculated result');
    expect(card).toHaveTextContent(`Period: ${MONTH_NAME}`);
    expect(within(card).getByRole('button', { name: /How this was calculated for Your plan for/ })).toBeInTheDocument();

    const header = container.querySelector('.clarity-decision-header') as HTMLElement;
    expect(within(header).getByText(PAGE_DECISIONS.plan)).toBeInTheDocument();

    const pay = await payField();
    expect(pay).toHaveValue('75000');
    expect(screen.getByRole('heading', { name: new RegExp(`Monthly pay for ${MONTH_NAME}`) })).toBeInTheDocument();
    const salaryPurpose = document.getElementById('purpose-salary') as HTMLElement;
    expect(salaryPurpose).toHaveTextContent('Required');
    expect(document.getElementById('benefit-salary')).toHaveTextContent('Based on your saved values.');
    expect(document.getElementById('purpose-bill')).toHaveTextContent('Optional');
    expect(document.getElementById('benefit-bill')).toHaveTextContent('Based on your saved values.');

    const rent = screen.getByText('Rent', { selector: 'strong' }).closest('li') as HTMLElement;
    expect(rent).toHaveTextContent('Counted every month');
    expect(rent).toHaveTextContent('₹20,000');
    // Order: header, then the outcome, then the form it explains, with the purpose above the input.
    expect(comesBefore(header, card)).toBe(true);
    expect(comesBefore(card, pay)).toBe(true);
    expect(comesBefore(salaryPurpose, pay)).toBe(true);
  });

  it('names the missing pay and previews with a labelled example until it is entered', async () => {
    mockApi({
      'GET /finance/clarity': read(planSnapshot(MONTH, { salaryMinor: null })),
      'GET /finance/emis': { emis: [] },
      'GET /finance/salary': { salary: null },
    });
    renderPlan();

    const card = await planCard();
    expect(card).toHaveTextContent('Needs input');
    expect(card).toHaveTextContent('Add salary to unlock your monthly plan and spending guidance.');
    expect(within(card).getByRole('link', { name: /Add this month’s pay/ })).toHaveAttribute('href', '/plan#pay-form');
    expect(document.getElementById('benefit-salary')).toHaveTextContent('Example, not your data.');
    expect(await payField()).toHaveValue('');
  });
});

describe('scoped salary save', () => {
  it('shows pending at once, keeps unrelated controls usable, then confirms with deltas and no reload', async () => {
    const user = userEvent.setup();
    const pending = deferred<Response>();
    const confirmed = planSnapshot(MONTH, { dataVersion: 2, salaryMinor: paise(80000) });
    const api = mockApi({
      'GET /finance/clarity': read(planSnapshot(MONTH)),
      'GET /finance/emis': { emis: [] },
      'GET /finance/salary': { salary: { month: MONTH, amount: 75000 } },
      'POST /finance/salary': () => pending.promise,
    });
    renderPlan();

    const pay = await payField();
    await screen.findByRole('article', { name: `Your plan for ${MONTH_NAME}` });
    const documentMarker = document.body.appendChild(document.createElement('i'));
    fireEvent.change(pay, { target: { value: '80,000' } });
    const save = saveButton();
    save.focus();

    // Pending feedback is in the DOM before the click handler's act() returns.
    act(() => {
      fireEvent.click(save);
    });
    expect(statusOf(SALARY_SCOPE)).toHaveTextContent('Save pay: pending');
    expect(save).toHaveAttribute('aria-disabled', 'true');
    expect(save).toHaveFocus();
    // The visible plan keeps its last confirmed calculated values and says it is refreshing.
    const card = screen.getByRole('article', { name: `Your plan for ${MONTH_NAME}` });
    expect(card).toHaveTextContent('Refreshing…');
    expect(within(card).getByText('Disposable income').closest('.clarity-value')).toHaveTextContent('₹75,000');

    // The request carries the exact month, whole paise, and an idempotency key.
    const [post] = api.to('POST', '/finance/salary');
    expect(post?.body).toEqual({ month: MONTH, amountMinor: paise(80000) });
    expect(post?.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(post?.headers['X-Clarity-Contract']).toBe('1');

    // Unrelated controls stay interactive, and a second submit of the same pay sends nothing.
    expect(addButton()).not.toHaveAttribute('aria-disabled');
    expect(addButton()).toBeEnabled();
    await user.type(screen.getByLabelText(/What is it/), 'Gym');
    expect(screen.getByLabelText(/What is it/)).toHaveValue('Gym');
    await user.click(save);
    expect(api.to('POST', '/finance/salary')).toHaveLength(1);

    await act(async () => {
      pending.resolve(okResponse(mutationEnvelope(confirmed, {
        scopeKey: SALARY_SCOPE,
        operation: 'salary.upsert',
        recordType: 'salary',
        recordId: 5,
        recordVersion: 2,
        planDeltas: { status: 'available', month: MONTH, disposableIncomeMinor: paise(5000), dailySpendingGuideMinor: paise(100) },
      })));
    });

    await waitFor(() => expect(statusOf(SALARY_SCOPE)).toHaveTextContent('Save pay: done'));
    const updated = screen.getByRole('article', { name: `Your plan for ${MONTH_NAME}` });
    expect(within(updated).getByText('Disposable income').closest('.clarity-value')).toHaveTextContent('₹80,000');
    expect(updated).not.toHaveTextContent('Refreshing…');
    const notice = screen.getByRole('region', { name: 'Latest change to your plan' });
    expect(notice).toHaveTextContent('Pay saved.');
    expect(within(notice).getByText(`Disposable income change for ${MONTH_NAME}`).closest('.clarity-value')).toHaveTextContent('+₹5,000');
    expect(within(notice).getByText(`Daily spending guide change for ${MONTH_NAME}`).closest('.clarity-value')).toHaveTextContent('+₹100');

    // Same document and same controls: nothing reloaded or remounted, and focus stayed on Save.
    expect(reload).not.toHaveBeenCalled();
    expect(documentMarker.isConnected).toBe(true);
    expect(screen.getByRole('textbox', { name: 'Monthly pay' })).toBe(pay);
    expect(save).toHaveFocus();
    expect(screen.getByLabelText(/What is it/)).toHaveValue('Gym');
    documentMarker.remove();
  });

  it('rolls back only the failed scope, keeps its draft, and retries with the same idempotency key', async () => {
    const user = userEvent.setup();
    const salary = deferred<Response>();
    const bill = deferred<Response>();
    const retried = deferred<Response>();
    const NETFLIX = { id: 7, label: 'Netflix', amountMinor: paise(649) };
    const withBill = planSnapshot(MONTH, { dataVersion: 2, bills: [NETFLIX] });
    const both = planSnapshot(MONTH, { dataVersion: 3, salaryMinor: paise(90000), bills: [NETFLIX] });
    const api = mockApi({
      'GET /finance/clarity': read(planSnapshot(MONTH)),
      'GET /finance/emis': { emis: [] },
      'GET /finance/salary': { salary: { month: MONTH, amount: 75000 } },
      'POST /finance/salary': (_call, attempt) => (attempt === 1 ? salary.promise : retried.promise),
      'POST /finance/emis': () => bill.promise,
    });
    renderPlan();

    const pay = await payField();
    await screen.findByRole('article', { name: `Your plan for ${MONTH_NAME}` });
    fireEvent.change(pay, { target: { value: '90000' } });
    await user.type(screen.getByLabelText(/What is it/), 'Netflix');
    await user.selectOptions(screen.getByLabelText('Type'), 'Subscription');
    await user.type(screen.getByLabelText(/₹ per month/), '649');

    act(() => {
      fireEvent.click(saveButton());
    });
    act(() => {
      fireEvent.click(addButton());
    });
    // Two independent changes, each with its own status.
    expect(statusOf(SALARY_SCOPE)).toHaveTextContent('Save pay: pending');
    expect(statusOf('new-bill:plan')).toHaveTextContent('Add bill: pending');
    expect(screen.getByText('Adding this bill…')).toBeInTheDocument();

    // The bill is confirmed while the pay is still pending.
    await act(async () => {
      bill.resolve(okResponse(mutationEnvelope(withBill, {
        scopeKey: 'bill:7',
        operation: 'bill.create',
        recordType: 'bill',
        recordId: 7,
        record: { id: 7, label: 'Netflix', amountMinor: paise(649), category: 'Subscription', active: true },
        planDeltas: { status: 'available', month: MONTH, disposableIncomeMinor: -paise(649), dailySpendingGuideMinor: -paise(20) },
      })));
    });
    await waitFor(() => expect(statusOf('new-bill:plan')).toHaveTextContent('Add bill: done'));
    expect(statusOf(SALARY_SCOPE)).toHaveTextContent('Save pay: pending');
    expect(screen.getByLabelText(/What is it/)).toHaveValue('');

    // The pay fails. Only the pay is rolled back; the confirmed bill stays.
    await act(async () => {
      salary.resolve(failure(500, 'SERVER_ERROR', 'The pay could not be saved.'));
    });
    await waitFor(() => expect(statusOf(SALARY_SCOPE)).toHaveTextContent('Save pay: failed.'));
    expect(statusOf(SALARY_SCOPE)).toHaveTextContent('The pay could not be saved.');
    expect(screen.getByRole('textbox', { name: 'Monthly pay' })).toHaveValue('90000');
    const card = screen.getByRole('article', { name: `Your plan for ${MONTH_NAME}` });
    expect(within(card).getByText(`Pay for ${MONTH_NAME}`).closest('.clarity-value')).toHaveTextContent('₹75,000');
    expect(within(card).getByText(`Bills counted in ${MONTH_NAME}`).closest('.clarity-value')).toHaveTextContent('₹649');
    expect(screen.getByText('Netflix', { selector: 'strong' })).toBeInTheDocument();
    expect(statusOf('new-bill:plan')).toHaveTextContent('Add bill: done');

    // Retry resends the same request with the same key, and the pay is confirmed.
    await user.click(within(statusOf(SALARY_SCOPE)).getByRole('button', { name: 'Retry Save pay' }));
    expect(statusOf(SALARY_SCOPE)).toHaveTextContent('Save pay: pending');
    const posts = api.to('POST', '/finance/salary');
    expect(posts).toHaveLength(2);
    expect(posts[1]?.headers['Idempotency-Key']).toBe(posts[0]?.headers['Idempotency-Key']);
    expect(posts[1]?.body).toEqual(posts[0]?.body);
    await act(async () => {
      retried.resolve(okResponse(mutationEnvelope(both, {
        scopeKey: SALARY_SCOPE,
        operation: 'salary.upsert',
        recordType: 'salary',
        recordId: 5,
        planDeltas: { status: 'available', month: MONTH, disposableIncomeMinor: paise(15000), dailySpendingGuideMinor: paise(500) },
      })));
    });
    await waitFor(() => expect(statusOf(SALARY_SCOPE)).toHaveTextContent('Save pay: done'));
    expect(screen.getByRole('textbox', { name: 'Monthly pay' })).toHaveValue('90000');
    expect(reload).not.toHaveBeenCalled();
  });

  it('keeps the typed pay when another change replaced the saved one, and re-reads the confirmed plan', async () => {
    const user = userEvent.setup();
    const api = mockApi({
      'GET /finance/clarity': read(planSnapshot(MONTH)),
      'GET /finance/emis': { emis: [] },
      'GET /finance/salary': { salary: { month: MONTH, amount: 75000 } },
      'POST /finance/salary': () => failure(409, 'RECORD_VERSION_CONFLICT', 'The record changed.'),
    });
    renderPlan();

    const pay = await payField();
    await screen.findByRole('article', { name: `Your plan for ${MONTH_NAME}` });
    fireEvent.change(pay, { target: { value: '81000' } });
    await user.click(saveButton());

    expect(await screen.findByText(/This was changed somewhere else, so it was not saved/)).toBeInTheDocument();
    expect(pay).toHaveValue('81000');
    expect(statusOf(SALARY_SCOPE)).not.toHaveTextContent('failed');
    await waitFor(() => expect(api.to('GET', '/finance/clarity')).toHaveLength(2));
  });
});

describe('explicit prior-month pay', () => {
  it('names the source and target month, applies only on request, and shows the deltas', async () => {
    const user = userEvent.setup();
    const pending = deferred<Response>();
    const applied = planSnapshot(MONTH, { dataVersion: 2, salaryMinor: paise(60000) });
    const api = mockApi({
      'GET /finance/clarity': read(planSnapshot(MONTH, { salaryMinor: null })),
      'GET /finance/emis': { emis: [] },
      'GET /finance/salary': { salary: { month: PRIOR, amount: 60000 } },
      'POST /finance/salary/apply': () => pending.promise,
    });
    renderPlan();

    const button = await screen.findByRole('button', { name: `Use ${PRIOR_NAME} pay for ${MONTH_NAME}` });
    const group = screen.getByRole('group', { name: "Use an earlier month's pay" });
    expect(group).toHaveTextContent(`${PRIOR_NAME}`);
    expect(group).toHaveTextContent(`It is not counted in ${MONTH_NAME} unless you apply it.`);
    // The prior pay is never used on its own.
    expect(api.to('POST', '/finance/salary/apply')).toHaveLength(0);
    expect(await screen.findByRole('article', { name: `Your plan for ${MONTH_NAME}` })).toHaveAttribute('data-status', 'missing_input');

    act(() => {
      fireEvent.click(button);
    });
    expect(statusOf(SALARY_SCOPE)).toHaveTextContent(`Apply ${PRIOR_NAME} pay: pending`);
    expect(api.to('POST', '/finance/salary/apply')[0]?.body).toEqual({ sourceMonth: PRIOR, targetMonth: MONTH });

    await act(async () => {
      pending.resolve(okResponse(mutationEnvelope(applied, {
        scopeKey: SALARY_SCOPE,
        operation: 'salary.apply',
        recordType: 'salary',
        recordId: 9,
        planDeltas: { status: 'available', month: MONTH, disposableIncomeMinor: paise(60000), dailySpendingGuideMinor: paise(2000) },
      })));
    });
    await waitFor(() => expect(screen.getByRole('article', { name: `Your plan for ${MONTH_NAME}` })).toHaveAttribute('data-status', 'available'));
    const notice = screen.getByRole('region', { name: 'Latest change to your plan' });
    expect(notice).toHaveTextContent(`${PRIOR_NAME} pay applied to ${MONTH_NAME}.`);
    expect(notice).toHaveTextContent('+₹60,000');
    expect(screen.queryByRole('button', { name: /^Use .* pay for/ })).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Monthly pay' })).toHaveValue('60000');
    await user.click(within(notice).getByRole('button', { name: 'Dismiss plan change' }));
    expect(screen.queryByRole('region', { name: 'Latest change to your plan' })).toBeNull();
  });
});

describe('bills: shortfall, activity periods, and scoped edits', () => {
  it('shows the shortfall and one bill-review action when bills exceed pay', async () => {
    mockApi({
      'GET /finance/clarity': read(planSnapshot(MONTH, {
        salaryMinor: paise(10000),
        bills: [{ id: 1, label: 'Rent', amountMinor: paise(15000) }],
        actions: [BILLS_ACTION],
      })),
      'GET /finance/emis': { emis: [{ ...RENT_EMI, amount: 15000 }] },
      'GET /finance/salary': { salary: { month: MONTH, amount: 10000 } },
    });
    renderPlan();

    const review = await screen.findByRole('region', { name: 'Bill review' });
    expect(review).toHaveTextContent(`Your bills are ${'₹5,000'} more than your pay for ${MONTH_NAME}.`);
    expect(within(review).getAllByRole('link')).toHaveLength(1);
    expect(within(review).getByRole('link', { name: /Review monthly bills/ })).toHaveAttribute('href', '/plan#bills-form');
    const card = screen.getByRole('article', { name: `Your plan for ${MONTH_NAME}` });
    expect(within(card).getByText('Disposable income').closest('.clarity-value')).toHaveTextContent('₹0');
    expect(within(card).getByText('Bills above pay (shortfall)').closest('.clarity-value')).toHaveTextContent('₹5,000');
  });

  it('shows the bill-review action when bills equal pay', async () => {
    mockApi({
      'GET /finance/clarity': read(planSnapshot(MONTH, {
        salaryMinor: paise(10000),
        bills: [{ id: 1, label: 'Rent', amountMinor: paise(10000) }],
        actions: [BILLS_ACTION],
      })),
      'GET /finance/emis': { emis: [{ ...RENT_EMI, amount: 10000 }] },
      'GET /finance/salary': { salary: { month: MONTH, amount: 10000 } },
    });
    renderPlan();
    const review = await screen.findByRole('region', { name: 'Bill review' });
    expect(review).toHaveTextContent(`Your bills use all of your pay for ${MONTH_NAME}.`);
    expect(within(review).getByRole('link', { name: /Review monthly bills/ })).toBeInTheDocument();
  });

  it('adds a bill with an activity period, edits only the changed field, and validates periods', async () => {
    const user = userEvent.setup();
    const GYM = { id: 7, label: 'Gym', amountMinor: paise(1500), from: '2026-01', to: null };
    const afterAdd = planSnapshot(MONTH, { dataVersion: 2, bills: [GYM] });
    const afterEdit = planSnapshot(MONTH, { dataVersion: 3, bills: [{ ...GYM, to: '2099-12' }] });
    const api = mockApi({
      'GET /finance/clarity': read(planSnapshot(MONTH)),
      'GET /finance/emis': { emis: [] },
      'GET /finance/salary': { salary: { month: MONTH, amount: 75000 } },
      'POST /finance/emis': mutationEnvelope(afterAdd, {
        scopeKey: 'bill:7',
        operation: 'bill.create',
        recordType: 'bill',
        recordId: 7,
        recordVersion: 1,
        record: { id: 7, label: 'Gym', amountMinor: paise(1500), category: 'Other', active: true, effectiveFromMonth: '2026-01', effectiveToMonth: null },
        planDeltas: { status: 'available', month: MONTH, disposableIncomeMinor: -paise(1500), dailySpendingGuideMinor: -paise(40) },
      }),
      'PATCH /finance/emis/7': mutationEnvelope(afterEdit, {
        scopeKey: 'bill:7',
        operation: 'bill.update',
        recordType: 'bill',
        recordId: 7,
        recordVersion: 2,
        record: { id: 7, label: 'Gym', amountMinor: paise(1500), category: 'Other', active: true, effectiveFromMonth: '2026-01', effectiveToMonth: '2099-12' },
        planDeltas: { status: 'available', month: MONTH, disposableIncomeMinor: 0, dailySpendingGuideMinor: 0 },
      }),
    });
    renderPlan();

    await screen.findByRole('article', { name: `Your plan for ${MONTH_NAME}` });
    // A period that ends before it starts is rejected beside the field, with nothing sent.
    await user.type(screen.getByLabelText(/What is it/), 'Gym');
    await user.type(screen.getByLabelText(/₹ per month/), '1500');
    fireEvent.change(screen.getByLabelText(/Counted from/), { target: { value: '2026-05' } });
    fireEvent.change(screen.getByLabelText(/Counted until/), { target: { value: '2026-01' } });
    await user.click(addButton());
    await waitFor(() => expect(document.querySelector('p.clarity-field-error')).not.toBeNull());
    const problem = document.querySelector('p.clarity-field-error') as HTMLElement;
    expect(problem).toHaveTextContent('Counted until: is before the month it is counted from. Choose the same month or a later one.');
    expect(screen.getByLabelText(/Counted until/)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText(/Counted until/)).toHaveAccessibleDescription(/Counted until: is before the month/);
    expect(api.to('POST', '/finance/emis')).toHaveLength(0);
    expect(screen.getByLabelText(/What is it/)).toHaveValue('Gym');

    fireEvent.change(screen.getByLabelText(/Counted from/), { target: { value: '2026-01' } });
    fireEvent.change(screen.getByLabelText(/Counted until/), { target: { value: '' } });
    await user.click(addButton());
    await waitFor(() => expect(statusOf('new-bill:plan')).toHaveTextContent('Add bill: done'));
    expect(api.to('POST', '/finance/emis')[0]?.body).toEqual({
      label: 'Gym',
      amountMinor: paise(1500),
      category: 'EMI',
      active: true,
      effectiveFromMonth: '2026-01',
      effectiveToMonth: null,
      applicableMonth: MONTH,
    });
    const row = screen.getByText('Gym', { selector: 'strong' }).closest('li') as HTMLElement;
    expect(row).toHaveTextContent('Counted from January 2026, no end month');
    expect(screen.getByLabelText(/What is it/)).toHaveValue('');

    // Edit sends only the changed field plus the month and the record version it expects.
    await user.click(within(row).getByRole('button', { name: 'Edit Gym' }));
    fireEvent.change(within(row).getByLabelText(/Counted until/), { target: { value: '2099-12' } });
    await user.click(within(row).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(statusOf('bill:7')).toHaveTextContent('Update Gym: done'));
    expect(api.to('PATCH', '/finance/emis/7')[0]?.body).toEqual({
      applicableMonth: MONTH,
      effectiveToMonth: '2099-12',
      expectedRecordVersion: 1,
    });
    const updated = screen.getByText('Gym', { selector: 'strong' }).closest('li') as HTMLElement;
    expect(updated).toHaveTextContent('Counted from January 2026 until December 2099');
    expect(within(updated).getByRole('button', { name: 'Edit Gym' })).toHaveFocus();
    expect(reload).not.toHaveBeenCalled();
  });

  it('keeps a failed bill edit open with its draft while other bills stay usable', async () => {
    const user = userEvent.setup();
    const emis = [RENT_EMI, { id: 2, label: 'Netflix', amount: 649, category: 'Subscription' }];
    mockApi({
      'GET /finance/clarity': read(planSnapshot(MONTH, { bills: [RENT, { id: 2, label: 'Netflix', amountMinor: paise(649) }] })),
      'GET /finance/emis': { emis },
      'GET /finance/salary': { salary: { month: MONTH, amount: 75000 } },
      'PATCH /finance/emis/1': () => failure(500, 'SERVER_ERROR', 'The bill could not be saved.'),
    });
    renderPlan();

    const rent = (await screen.findByText('Rent', { selector: 'strong' })).closest('li') as HTMLElement;
    await user.click(within(rent).getByRole('button', { name: 'Edit Rent' }));
    const amount = within(rent).getByLabelText(/₹ per month/);
    await user.clear(amount);
    await user.type(amount, '22000');
    await user.click(within(rent).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(statusOf('bill:1')).toHaveTextContent('Update Rent: failed.'));
    expect(within(rent).getByLabelText(/₹ per month/)).toHaveValue('22000');
    expect(within(rent).getByRole('button', { name: 'Retry Update Rent' })).toBeInTheDocument();
    const netflix = screen.getByText('Netflix', { selector: 'strong' }).closest('li') as HTMLElement;
    expect(netflix).toHaveTextContent('₹649');
    expect(within(netflix).getByRole('button', { name: 'Edit Netflix' })).not.toHaveAttribute('aria-disabled');
  });

  it('lists saved bills that are not counted this month and counts one on request', async () => {
    const user = userEvent.setup();
    const counted = planSnapshot(MONTH, { dataVersion: 2, bills: [{ id: 3, label: 'Old loan', amountMinor: paise(3000) }] });
    const api = mockApi({
      'GET /finance/clarity': read(planSnapshot(MONTH)),
      'GET /finance/emis': { emis: [{ id: 3, label: 'Old loan', amount: 3000, category: 'EMI' }] },
      'GET /finance/salary': { salary: { month: MONTH, amount: 75000 } },
      'PATCH /finance/emis/3': mutationEnvelope(counted, {
        scopeKey: 'bill:3',
        operation: 'bill.update',
        recordType: 'bill',
        recordId: 3,
        record: { id: 3, label: 'Old loan', amountMinor: paise(3000), category: 'EMI', active: true },
        planDeltas: { status: 'available', month: MONTH, disposableIncomeMinor: -paise(3000), dailySpendingGuideMinor: -paise(100) },
      }),
    });
    renderPlan();

    const row = (await screen.findByText('Old loan', { selector: 'strong' })).closest('li') as HTMLElement;
    expect(row).toHaveTextContent(`Saved, not counted in ${MONTH_NAME}`);
    await user.click(within(row).getByRole('button', { name: `Count in ${MONTH_NAME}` }));
    await waitFor(() => expect(statusOf('bill:3')).toHaveTextContent(`Count Old loan in ${MONTH_NAME}: done`));
    expect(api.to('PATCH', '/finance/emis/3')[0]?.body).toEqual({
      active: true,
      effectiveFromMonth: null,
      effectiveToMonth: null,
      applicableMonth: MONTH,
    });
    const nowCounted = screen.getByText('Old loan', { selector: 'strong' }).closest('li') as HTMLElement;
    expect(nowCounted).toHaveTextContent('Counted every month');
    expect(screen.queryByText(/Saved but not counted/)).toBeNull();
  });
});

describe('calculation failure', () => {
  it('keeps the confirmed pay and bills in their inputs and recalculates without new entry', async () => {
    const user = userEvent.setup();
    const failedPlan = planSnapshot(MONTH, {
      bills: [RENT],
      plan: {
        status: 'calculation_failed',
        value: undefined,
        retry: { action: 'recalculate', scopeKey: `outcome:monthly-plan:${MONTH}` },
      },
    });
    const api = mockApi({
      'GET /finance/clarity': (_call, attempt) => okResponse(read(attempt === 1 ? failedPlan : planSnapshot(MONTH, { dataVersion: 2, bills: [RENT] }))),
      'GET /finance/emis': { emis: [RENT_EMI] },
      'GET /finance/salary': { salary: { month: MONTH, amount: 75000 } },
    });
    renderPlan();

    const card = await screen.findByRole('article', { name: `Your plan for ${MONTH_NAME}` });
    expect(card).toHaveAttribute('data-status', 'calculation_failed');
    expect(within(card).getByText('Temporarily unavailable.', { selector: 'strong' })).toBeInTheDocument();
    expect(within(card).getAllByRole('button', { name: /Recalculate/ })).toHaveLength(1);
    // The confirmed inputs are still there and still editable.
    expect(await payField()).toHaveValue('75000');
    expect(screen.getByText('Rent', { selector: 'strong' })).toBeInTheDocument();
    expect(saveButton()).toBeEnabled();

    await user.click(within(card).getByRole('button', { name: /Recalculate Your plan for/ }));
    await waitFor(() => expect(screen.getByRole('article', { name: `Your plan for ${MONTH_NAME}` })).toHaveAttribute('data-status', 'available'));
    expect(screen.getByRole('textbox', { name: 'Monthly pay' })).toHaveValue('75000');
    expect(api.calls.filter((call) => call.method !== 'GET')).toEqual([]);
    expect(api.to('GET', '/finance/clarity')).toHaveLength(2);
  });
});

describe('data-use gate', () => {
  it('pauses new pay and bill entries with a reason, but not corrections to saved pay', async () => {
    const api = mockApi({
      'GET /clarity/settings': buildSettings(),
      'GET /finance/clarity': read(planSnapshot(MONTH, { salaryMinor: null })),
      'GET /finance/emis': { emis: [] },
      'GET /finance/salary': { salary: { month: PRIOR, amount: 60000 } },
    });
    renderPlan({ gate: true });

    const save = await screen.findByRole('button', { name: `Save pay for ${MONTH_NAME}` });
    await waitFor(() => expect(document.getElementById(DATA_USE_REASON_ID)).toBeInTheDocument());
    expect(save).toBeDisabled();
    expect(save).toHaveAttribute('aria-describedby', DATA_USE_REASON_ID);
    expect(addButton()).toBeDisabled();
    expect(addButton()).toHaveAttribute('aria-describedby', DATA_USE_REASON_ID);
    const apply = screen.getByRole('button', { name: `Use ${PRIOR_NAME} pay for ${MONTH_NAME}` });
    expect(apply).toBeDisabled();
    expect(apply).toHaveAttribute('aria-describedby', DATA_USE_REASON_ID);
    expect(document.getElementById(DATA_USE_REASON_ID)).toHaveTextContent(/acknowledge the data-use notice/i);
    // Reading stays available and nothing was sent.
    expect(screen.getByRole('article', { name: `Your plan for ${MONTH_NAME}` })).toBeInTheDocument();
    expect(api.calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });

  it('keeps correcting a saved pay available while new entries are paused', async () => {
    mockApi({
      'GET /clarity/settings': buildSettings(),
      'GET /finance/clarity': read(planSnapshot(MONTH)),
      'GET /finance/emis': { emis: [] },
      'GET /finance/salary': { salary: { month: MONTH, amount: 75000 } },
    });
    renderPlan({ gate: true });
    await screen.findByRole('article', { name: `Your plan for ${MONTH_NAME}` });
    await waitFor(() => expect(document.getElementById(DATA_USE_REASON_ID)).toBeInTheDocument());
    expect(saveButton()).toBeEnabled();
    expect(addButton()).toBeDisabled();
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

  it('renders and behaves as before: legacy reads, the old save, and a page reload', async () => {
    const user = userEvent.setup();
    const api = mockApi({
      'GET /finance/clarity': () => failure(500, 'SERVER_ERROR', 'must not be called'),
      'GET /finance/plan': PLAN,
      'GET /finance/emis': { emis: [] },
      'GET /finance/salary': { salary: { month: MONTH, amount: 75000 } },
      'POST /finance/salary': { ok: true },
    });
    const { container } = renderPlan();

    expect(await screen.findByRole('heading', { level: 1, name: /Your month, line by line/ })).toBeInTheDocument();
    expect(container.querySelector('.clarity-decision-header')).toBeNull();
    expect(screen.getByRole('heading', { name: /💰 Monthly pay$/ })).toBeInTheDocument();
    expect(screen.queryByRole('article')).toBeNull();
    expect(document.getElementById('purpose-salary')).toBeNull();
    const pay = await payField();
    await waitFor(() => expect(pay).toHaveValue('75000'));
    fireEvent.change(pay, { target: { value: '80000' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(api.to('POST', '/finance/salary')[0]?.body).toEqual({ amount: 80000 });
    expect(api.to('POST', '/finance/salary')[0]?.headers['Idempotency-Key']).toBeUndefined();
    expect(api.to('GET', '/finance/clarity')).toHaveLength(0);
  });
});

describe.each(['light', 'dark'] as const)('accessibility in the %s theme', (theme) => {
  async function expectNoViolations(setup: () => void) {
    document.documentElement.dataset.theme = theme;
    try {
      setup();
      const { container } = renderPlan();
      await screen.findByRole('article', { name: `Your plan for ${MONTH_NAME}` });
      await payField();
      expect(await axe(container)).toHaveNoViolations();
    } finally {
      delete document.documentElement.dataset.theme;
    }
  }

  it('has no violations with pay, bills, and a shortfall action', async () => {
    await expectNoViolations(() => {
      mockApi({
        'GET /finance/clarity': read(planSnapshot(MONTH, {
          salaryMinor: paise(10000),
          bills: [{ id: 1, label: 'Rent', amountMinor: paise(15000), from: '2026-01' }],
          actions: [BILLS_ACTION],
        })),
        'GET /finance/emis': { emis: [{ ...RENT_EMI, amount: 15000 }, { id: 4, label: 'Old loan', amount: 3000, category: 'EMI' }] },
        'GET /finance/salary': { salary: { month: MONTH, amount: 10000 } },
      });
    });
  });

  it('has no violations with missing pay and an offer to use the prior month', async () => {
    await expectNoViolations(() => {
      mockApi({
        'GET /finance/clarity': read(planSnapshot(MONTH, { salaryMinor: null })),
        'GET /finance/emis': { emis: [] },
        'GET /finance/salary': { salary: { month: PRIOR, amount: 60000 } },
      });
    });
  });
});

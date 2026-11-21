// Home and Plan rendered together against a fake API that implements the
// financial clarity contract (snapshot reads, mutation envelopes with record
// versions and plan deltas, idempotent replays, and ordered calculation
// explanations). It covers what Dashboard.clarity.test.tsx and
// Plan.clarity.test.tsx do not:
//
// - one Plan save updating Home's snapshot in place while sibling regions stay put,
// - the calculation explanation's content and order,
// - the bill delete path and its retry and conflict handling,
// - the `financial_change_ui` measurement event,
// - feedback timing against a controlled clock (no wall-clock waits).
//
// Timing in jsdom has no paint. Here a "frame" is 16 ms of fake time and every
// budget is checked against the fake clock; response-to-paint in a real browser
// is covered by e2e/plan-save.clarity.spec.ts.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FinancialClarityProvider } from '../clarity/FinancialClarityProvider';
import { measurement } from '../clarity/measurement';
import { MutationStatusProvider } from '../clarity/MutationStatusProvider';
import { currentMonth, monthLabel } from '../money';
import { FakeClarityBackend, type FakeBackendInit } from '../test/fakeClarityBackend';
import { installBackendFetch, type BackendFetch } from '../test/fakeClarityFetch';
import { createTestQueryClient, renderAuthenticated } from '../test/test-utils';
import { Dashboard } from './Dashboard';
import { Plan } from './Plan';

const MONTH = currentMonth();
const MONTH_NAME = monthLabel(MONTH);
const SALARY_SCOPE = `salary:${MONTH}`;
const paise = (rupees: number) => Math.round(rupees * 100);

function BothPages() {
  return (
    <>
      <Dashboard />
      <Plan />
    </>
  );
}

function setup(init: FakeBackendInit = {}, page: 'both' | 'plan' = 'both') {
  const backend = new FakeClarityBackend(MONTH, init);
  const net = installBackendFetch(backend);
  const view = renderAuthenticated(
    <FinancialClarityProvider>
      <MutationStatusProvider>{page === 'both' ? <BothPages /> : <Plan />}</MutationStatusProvider>
    </FinancialClarityProvider>,
    { route: '/plan', queryClient: createTestQueryClient() },
  );
  return { backend, net, ...view };
}

const summary = () => within(screen.getByTestId('monthly-clarity-summary'));
const homeValue = (label: string) => summary().getByText(label).closest('.clarity-value') as HTMLElement;
const planCard = () => screen.getByRole('article', { name: `Your plan for ${MONTH_NAME}` });
const planValue = (label: string) => within(planCard()).getByText(label).closest('.clarity-value') as HTMLElement;
const statusOf = (scope: string) => document.querySelector(`[data-scope="${scope}"]`) as HTMLElement;
const payField = () => screen.getByRole('textbox', { name: 'Monthly pay' });
const saveButton = () => screen.getByRole('button', { name: `Save pay for ${MONTH_NAME}` });
const addButton = () => screen.getByRole('button', { name: '+ Add bill' });
const billRow = (label: string) => screen.getByText(label, { selector: 'strong' }).closest('li') as HTMLElement;
const notice = () => screen.getByRole('region', { name: 'Latest change to your plan' });
/** What a sighted user reads. The polite live region is excluded: the server stamps every outcome with the new data version, so it re-announces. */
function visibleText(element: Element): string {
  const copy = element.cloneNode(true) as Element;
  copy.querySelectorAll('.sr-only').forEach((node) => node.remove());
  return copy.textContent ?? '';
}

async function loaded() {
  await screen.findByRole('article', { name: /Remaining to spend/ });
  await screen.findByRole('article', { name: `Your plan for ${MONTH_NAME}` });
  await screen.findByRole('textbox', { name: 'Monthly pay' });
}

function fillBill(label: string, amount: number) {
  fireEvent.change(screen.getByLabelText(/What is it/), { target: { value: label } });
  fireEvent.change(screen.getByLabelText(/₹ per month/), { target: { value: String(amount) } });
}

const reload = vi.fn();
beforeEach(() => {
  vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'true');
  reload.mockClear();
  vi.stubGlobal('location', { ...window.location, reload });
});

describe('a Plan save updates Home without reloading', () => {
  it('replaces Home’s plan and savings values from the confirmed response and leaves goal and trip regions alone', async () => {
    const { net } = setup({ salaryMinor: paise(75000) });
    await loaded();
    expect(homeValue('Remaining spendable')).toHaveTextContent('₹60,000');
    expect(homeValue('Projected savings')).toHaveTextContent('₹75,000');

    const homePlan = screen.getByRole('article', { name: /Remaining to spend/ });
    const goal = screen.getByRole('article', { name: /Urgent goal: Emergency fund/ });
    const trip = screen.getByRole('article', { name: /Nearest trip settlement: Goa weekend/ });
    const goalText = visibleText(goal);
    const tripText = visibleText(trip);
    const marker = document.body.appendChild(document.createElement('i'));
    const pay = payField();
    const gate = net.hold('POST', '/finance/salary');

    fireEvent.change(pay, { target: { value: '80000' } });
    const save = saveButton();
    save.focus();
    act(() => {
      fireEvent.click(save);
    });

    // While the request is pending, neither page shows a calculated value that the server has not confirmed.
    expect(statusOf(SALARY_SCOPE)).toHaveTextContent('Save pay: pending');
    expect(homeValue('Remaining spendable')).toHaveTextContent('₹60,000');
    expect(planValue('Disposable income')).toHaveTextContent('₹75,000');
    expect(save).toHaveFocus();

    await act(async () => {
      gate.release();
    });
    await waitFor(() => expect(homeValue('Remaining spendable')).toHaveTextContent('₹64,000'));
    expect(homeValue('Projected savings')).toHaveTextContent('₹80,000');
    expect(within(screen.getByRole('article', { name: /Projected savings vs target/ })).getByText('₹64,000 above target')).toBeInTheDocument();
    expect(planValue('Disposable income')).toHaveTextContent('₹80,000');
    expect(within(notice()).getByText(`Disposable income change for ${MONTH_NAME}`).closest('.clarity-value')).toHaveTextContent('+₹5,000');
    expect(within(notice()).getByText(`Daily spending guide change for ${MONTH_NAME}`).closest('.clarity-value')).toHaveTextContent('+₹235.30');

    // Same document, same elements, no second snapshot read, and no change to sibling regions.
    expect(reload).not.toHaveBeenCalled();
    expect(marker.isConnected).toBe(true);
    expect(net.to('GET', '/finance/clarity')).toHaveLength(1);
    expect(screen.getByRole('article', { name: /Remaining to spend/ })).toBe(homePlan);
    expect(screen.getByRole('article', { name: /Urgent goal: Emergency fund/ })).toBe(goal);
    expect(screen.getByRole('article', { name: /Nearest trip settlement: Goa weekend/ })).toBe(trip);
    expect(visibleText(goal)).toBe(goalText);
    expect(visibleText(trip)).toBe(tripText);
    expect(payField()).toBe(pay);
    expect(save).toHaveFocus();
    marker.remove();
  });

  it('keeps focus and the draft in an unrelated field while the pay response arrives', async () => {
    const user = userEvent.setup();
    const { net } = setup({ salaryMinor: paise(75000) });
    await loaded();
    const gate = net.hold('POST', '/finance/salary');
    fireEvent.change(payField(), { target: { value: '81000' } });
    act(() => {
      fireEvent.click(saveButton());
    });

    // The user moves on to another form while the pay is pending.
    const name = screen.getByLabelText(/What is it/);
    await user.click(name);
    await user.type(name, 'Gym');
    expect(statusOf(SALARY_SCOPE)).toHaveTextContent('Save pay: pending');
    expect(addButton()).toBeEnabled();

    await act(async () => {
      gate.release();
    });
    await waitFor(() => expect(statusOf(SALARY_SCOPE)).toHaveTextContent('Save pay: done'));
    expect(name).toHaveFocus();
    expect(name).toHaveValue('Gym');
    expect(homeValue('Remaining spendable')).toHaveTextContent('₹64,800');
  });

  it('leaves Home and Plan on the last confirmed values when the save fails, and keeps the typed pay', async () => {
    const { backend, net } = setup({ salaryMinor: paise(75000) });
    await loaded();
    backend.failNext('POST', '/finance/salary', 500, 'SERVER_ERROR', 'The pay could not be saved.');
    const homePlan = screen.getByRole('article', { name: /Remaining to spend/ });
    const goalText = visibleText(screen.getByRole('article', { name: /Urgent goal/ }));

    fireEvent.change(payField(), { target: { value: '99000' } });
    await userEvent.setup().click(saveButton());

    await waitFor(() => expect(statusOf(SALARY_SCOPE)).toHaveTextContent('Save pay: failed.'));
    expect(statusOf(SALARY_SCOPE)).toHaveTextContent('The pay could not be saved.');
    expect(payField()).toHaveValue('99000');
    expect(homeValue('Remaining spendable')).toHaveTextContent('₹60,000');
    expect(planValue('Disposable income')).toHaveTextContent('₹75,000');
    expect(planValue(`Pay for ${MONTH_NAME}`)).toHaveTextContent('₹75,000');
    expect(screen.queryByRole('region', { name: 'Latest change to your plan' })).toBeNull();
    expect(screen.getByRole('article', { name: /Remaining to spend/ })).toBe(homePlan);
    expect(visibleText(screen.getByRole('article', { name: /Urgent goal/ }))).toBe(goalText);
    expect(net.to('POST', '/finance/salary')).toHaveLength(1);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('bill shortfall and the bill delete path across Home and Plan', () => {
  it('adds a bill larger than pay, shows the review action on both pages, and removes it again on delete', async () => {
    const user = userEvent.setup();
    const { net } = setup({ salaryMinor: paise(75000) });
    await loaded();
    expect(screen.queryByRole('region', { name: 'Bill review' })).toBeNull();

    fillBill('Loan', 90000);
    await user.click(addButton());
    await waitFor(() => expect(statusOf('new-bill:plan')).toHaveTextContent('Add bill: done'));

    // Plan: shortfall text and exactly one review action.
    const review = screen.getByRole('region', { name: 'Bill review' });
    expect(review).toHaveTextContent(`Your bills are ₹15,000 more than your pay for ${MONTH_NAME}.`);
    expect(within(review).getAllByRole('link')).toHaveLength(1);
    expect(planValue('Bills above pay (shortfall)')).toHaveTextContent('₹15,000');
    // Home: no remaining spend, the same action ranked first, and the header names it.
    expect(homeValue('Remaining spendable')).toHaveTextContent('₹0');
    const homeActions = document.querySelector('[data-region="actions"]') as HTMLElement;
    const first = within(homeActions).getAllByRole('listitem')[0] as HTMLElement;
    expect(first).toHaveTextContent('Current-month bills exceed salary.');
    expect(within(first).getByRole('link', { name: /Review monthly bills/ })).toHaveAttribute('href', '/plan#bills-form');
    const headers = Array.from(document.querySelectorAll<HTMLElement>('.clarity-decision-header'));
    expect(headers.some((header) => within(header).queryByRole('link', { name: /Review monthly bills/ }))).toBe(true);

    // Delete: no optimistic removal; the row stays with a pending status until the server confirms.
    const gate = net.hold('DELETE', '/finance/emis/1');
    const row = billRow('Loan');
    act(() => {
      fireEvent.click(within(row).getByRole('button', { name: 'Delete Loan' }));
    });
    expect(statusOf('bill:1')).toHaveTextContent('Delete Loan: pending');
    expect(billRow('Loan')).toBe(row);
    expect(within(row).getByRole('button', { name: 'Delete Loan' })).toHaveAttribute('aria-disabled', 'true');
    expect(payField()).toBeEnabled();
    expect(addButton()).toBeEnabled();
    expect(homeValue('Remaining spendable')).toHaveTextContent('₹0');

    await act(async () => {
      gate.release();
    });
    await waitFor(() => expect(screen.queryByText('Loan', { selector: 'strong' })).toBeNull());
    expect(screen.queryByRole('region', { name: 'Bill review' })).toBeNull();
    expect(homeValue('Remaining spendable')).toHaveTextContent('₹60,000');
    expect(within(homeActions).queryByText('Current-month bills exceed salary.')).toBeNull();
    expect(within(notice()).getByText(/Bill deleted\./)).toBeInTheDocument();
    expect(within(notice()).getByText(`Disposable income change for ${MONTH_NAME}`).closest('.clarity-value')).toHaveTextContent('+₹75,000');

    const [request] = net.to('DELETE', '/finance/emis/1');
    // The add confirmed record version 1, so the delete says which version it expects.
    expect(request?.body).toEqual({ applicableMonth: MONTH, expectedRecordVersion: 1 });
    expect(request?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(request?.headers['x-clarity-contract']).toBe('1');
    expect(reload).not.toHaveBeenCalled();
  });

  it('keeps a bill whose delete failed, leaves the other bill usable, and retries with the same key', async () => {
    const user = userEvent.setup();
    const { backend, net } = setup({
      salaryMinor: paise(75000),
      bills: [{ label: 'Rent', amountMinor: paise(20000), category: 'Rent' }, { label: 'Netflix', amountMinor: paise(649), category: 'Subscription' }],
    });
    await loaded();
    expect(homeValue('Remaining spendable')).toHaveTextContent('₹43,480.80');
    backend.failNext('DELETE', '/finance/emis/1', 500, 'SERVER_ERROR', 'The bill could not be deleted.');

    await user.click(within(billRow('Rent')).getByRole('button', { name: 'Delete Rent' }));
    await waitFor(() => expect(statusOf('bill:1')).toHaveTextContent('Delete Rent: failed.'));
    expect(statusOf('bill:1')).toHaveTextContent('The bill could not be deleted.');
    expect(statusOf('bill:1')).toHaveTextContent('Your last confirmed values are unchanged.');
    // The bill is still counted everywhere, and the sibling bill is still editable and deletable.
    expect(billRow('Rent')).toHaveTextContent('₹20,000');
    expect(planValue(`Bills counted in ${MONTH_NAME}`)).toHaveTextContent('₹20,649');
    expect(homeValue('Remaining spendable')).toHaveTextContent('₹43,480.80');
    expect(within(billRow('Netflix')).getByRole('button', { name: 'Edit Netflix' })).not.toHaveAttribute('aria-disabled');
    expect(within(billRow('Netflix')).getByRole('button', { name: 'Delete Netflix' })).not.toHaveAttribute('aria-disabled');

    await user.click(within(statusOf('bill:1')).getByRole('button', { name: 'Retry Delete Rent' }));
    await waitFor(() => expect(screen.queryByText('Rent', { selector: 'strong' })).toBeNull());
    const deletes = net.to('DELETE', '/finance/emis/1');
    expect(deletes).toHaveLength(2);
    expect(deletes[1]?.headers['idempotency-key']).toBe(deletes[0]?.headers['idempotency-key']);
    expect(deletes[1]?.body).toEqual(deletes[0]?.body);
    expect(planValue(`Bills counted in ${MONTH_NAME}`)).toHaveTextContent('₹649');
    expect(homeValue('Remaining spendable')).toHaveTextContent('₹59,480.80');
    expect(screen.getByText('Netflix', { selector: 'strong' })).toBeInTheDocument();
    // A retried delete finishes like a first attempt: the bill is not offered again as "saved, not counted", and the change is announced with its deltas.
    expect(screen.queryByText(/Saved but not counted/)).toBeNull();
    expect(screen.queryByRole('button', { name: `Count in ${MONTH_NAME}` })).toBeNull();
    expect(within(notice()).getByText(/Bill deleted\./)).toBeInTheDocument();
    expect(within(notice()).getByText(`Disposable income change for ${MONTH_NAME}`).closest('.clarity-value')).toHaveTextContent('+₹20,000');
  });

  it('closes a bill edit that succeeds on retry, with focus back on its Edit button', async () => {
    const user = userEvent.setup();
    const { backend, net } = setup({
      salaryMinor: paise(75000),
      bills: [{ label: 'Rent', amountMinor: paise(20000), category: 'Rent' }],
    });
    await loaded();
    backend.failNext('PATCH', '/finance/emis/1', 500, 'SERVER_ERROR', 'The bill could not be saved.');

    const row = billRow('Rent');
    await user.click(within(row).getByRole('button', { name: 'Edit Rent' }));
    const amount = within(row).getByLabelText(/₹ per month/);
    await user.clear(amount);
    await user.type(amount, '22000');
    await user.click(within(row).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(statusOf('bill:1')).toHaveTextContent('Update Rent: failed.'));
    expect(within(row).getByLabelText(/₹ per month/)).toHaveValue('22000');

    await user.click(within(statusOf('bill:1')).getByRole('button', { name: 'Retry Update Rent' }));
    await waitFor(() => expect(statusOf('bill:1')).toHaveTextContent('Update Rent: done'));
    const updated = billRow('Rent');
    expect(within(updated).queryByLabelText(/₹ per month/)).toBeNull();
    expect(updated).toHaveTextContent('₹22,000');
    await waitFor(() => expect(within(updated).getByRole('button', { name: 'Edit Rent' })).toHaveFocus());
    expect(net.to('PATCH', '/finance/emis/1')).toHaveLength(2);
    expect(homeValue('Remaining spendable')).toHaveTextContent('₹42,400');
  });

  it('keeps the bill and re-reads the plan when another change replaced the version this delete expected', async () => {
    const user = userEvent.setup();
    const { backend, net } = setup({
      salaryMinor: paise(75000),
      bills: [{ label: 'Netflix', amountMinor: paise(649), category: 'Subscription' }],
    });
    await loaded();

    // Edit once so the client knows the bill's record version, then change it elsewhere.
    const row = billRow('Netflix');
    await user.click(within(row).getByRole('button', { name: 'Edit Netflix' }));
    const amount = within(row).getByLabelText(/₹ per month/);
    await user.clear(amount);
    await user.type(amount, '700');
    await user.click(within(row).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(statusOf('bill:1')).toHaveTextContent('Update Netflix: done'));
    const bill = backend.bills[0];
    if (bill) bill.version += 5;
    const clarityReads = net.to('GET', '/finance/clarity').length;

    await user.click(within(billRow('Netflix')).getByRole('button', { name: 'Delete Netflix' }));
    expect(await screen.findByText(/This was changed somewhere else, so it was not saved/)).toBeInTheDocument();
    expect(net.to('DELETE', '/finance/emis/1')[0]?.body).toEqual({ applicableMonth: MONTH, expectedRecordVersion: 2 });
    expect(statusOf('bill:1')).not.toHaveTextContent('failed');
    expect(billRow('Netflix')).toBeInTheDocument();
    await waitFor(() => expect(net.to('GET', '/finance/clarity').length).toBe(clarityReads + 1));
    expect(homeValue('Remaining spendable')).toHaveTextContent('₹59,440');
  });
});

describe('calculation explanation', () => {
  const STEP_TEXT = [
    'Start with the salary entered for this month.',
    'Add every bill that applies to this month.',
    'Subtract bills from salary to get disposable income.',
    'Split disposable income into needs, wants, and savings (50/30/20).',
    'Divide what is left to spend by the days remaining, including today.',
  ];

  async function openPlanExplanation(user: ReturnType<typeof userEvent.setup>) {
    const toggle = screen.getByRole('button', { name: `How this was calculated for Your plan for ${MONTH_NAME}` });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    return screen.findByRole('group', { name: `How Your plan for ${MONTH_NAME} was calculated` });
  }

  it.each([
    ['in server order', false],
    ['when the server sends them out of order', true],
  ])('lists entered values, then the ordered steps, then rounding and the result %s', async (_name, unorderedExplanations) => {
    const user = userEvent.setup();
    const { net } = setup({
      salaryMinor: paise(75000),
      bills: [{ label: 'Rent', amountMinor: paise(20000), category: 'Rent' }, { label: 'Gym', amountMinor: paise(1500), category: 'Other' }],
      unorderedExplanations,
    }, 'plan');
    await screen.findByRole('article', { name: `Your plan for ${MONTH_NAME}` });

    const group = await openPlanExplanation(user);
    await within(group).findByText('Values you entered');

    // The request is for this outcome and version, under the contract header, and nothing else is read.
    const [request] = net.to('GET', `/finance/explanations/${encodeURIComponent(`monthly-plan:${MONTH}`)}`);
    expect(request?.query.get('version')).toBe('1');
    expect(request?.headers['x-clarity-contract']).toBe('1');
    expect(net.calls.filter((call) => call.path.startsWith('/finance/explanations/'))).toHaveLength(1);

    // Section order.
    expect(Array.from(group.querySelectorAll('.clarity-subheading')).map((heading) => heading.textContent)).toEqual([
      'Values you entered',
      'Steps, in order',
      'Rounding and precision',
      'Result',
    ]);

    // Entered values: salary, then each bill, each labelled as an entered fact.
    const entered = Array.from(group.querySelectorAll('ul.clarity-plain-list'))[0] as HTMLElement;
    const items = within(entered).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining('Salary for'),
      expect.stringContaining('Rent'),
      expect.stringContaining('Gym'),
    ]);
    expect(items[0]).toHaveTextContent('₹75,000');
    expect(items[1]).toHaveTextContent('₹20,000');
    expect(items[2]).toHaveTextContent('₹1,500');
    for (const item of items) expect(item).toHaveTextContent('Entered fact');

    // Steps run in order, each with its plain-language reason, operands, and result.
    const steps = Array.from(group.querySelectorAll('ol.clarity-operations > li'));
    expect(steps).toHaveLength(5);
    steps.forEach((step, index) => expect(step).toHaveTextContent(STEP_TEXT[index] as string));
    expect(steps[0]).toHaveTextContent('Add.');
    expect(steps[2]).toHaveTextContent('Subtract.');
    expect(steps[2]).toHaveTextContent('Salary for');
    expect(steps[2]).toHaveTextContent('Result: ₹53,500');
    expect(steps[3]).toHaveTextContent('Needs budget: ₹26,750');
    expect(steps[3]).toHaveTextContent('Wants budget: ₹16,050');
    expect(steps[3]).toHaveTextContent('Savings target: ₹10,700');
    expect(steps[4]).toHaveTextContent('divisor 17');
    for (const step of steps) expect(step).toHaveTextContent('Calculated result');

    expect(group).toHaveTextContent(`Period: ${MONTH_NAME}`);
    expect(group).toHaveTextContent('Data version 1');
    expect(group).toHaveTextContent('Rounding direction');
    expect(group).toHaveTextContent('to the nearest paisa, halves round up');
  });

  it('shares one request between the Home and Plan cards for the same outcome and version', async () => {
    const user = userEvent.setup();
    const { net } = setup({ salaryMinor: paise(75000) });
    await loaded();

    await openPlanExplanation(user);
    await user.click(screen.getByRole('button', { name: 'How this was calculated for Remaining to spend' }));
    const homeGroup = await screen.findByRole('group', { name: 'How Remaining to spend was calculated' });
    await within(homeGroup).findByText('Steps, in order');
    expect(net.calls.filter((call) => call.path.startsWith('/finance/explanations/'))).toHaveLength(1);
  });

  it('updates an open explanation in place to the confirmed version after a Plan save', async () => {
    const user = userEvent.setup();
    const { net } = setup({ salaryMinor: paise(75000) }, 'plan');
    await screen.findByRole('article', { name: `Your plan for ${MONTH_NAME}` });
    await screen.findByRole('textbox', { name: 'Monthly pay' });
    const group = await openPlanExplanation(user);
    await within(group).findByText('Steps, in order');
    expect(group).toHaveTextContent('Data version 1');

    fireEvent.change(payField(), { target: { value: '80000' } });
    await user.click(saveButton());

    await waitFor(() => expect(screen.getByRole('group', { name: `How Your plan for ${MONTH_NAME} was calculated` })).toHaveTextContent('Data version 2'));
    const updated = screen.getByRole('group', { name: `How Your plan for ${MONTH_NAME} was calculated` });
    expect(updated).toHaveTextContent('₹80,000');
    expect(screen.getByRole('button', { name: `How this was calculated for Your plan for ${MONTH_NAME}` })).toHaveAttribute('aria-expanded', 'true');
    expect(net.to('GET', `/finance/explanations/${encodeURIComponent(`monthly-plan:${MONTH}`)}`).map((call) => call.query.get('version'))).toEqual(['1', '2']);
  });
});

describe('financial change measurement event', () => {
  beforeEach(() => {
    measurement.setAnalyticsConsent(true);
  });
  afterEach(() => {
    measurement.setAnalyticsConsent(false);
  });

  it('reports the confirmed change receipt with no reload and no page-wide loading, and nothing else about the change', async () => {
    const user = userEvent.setup();
    const { net } = setup({ salaryMinor: paise(75000), bills: [{ label: 'Rent', amountMinor: paise(20000), category: 'Rent' }] });
    await loaded();

    fireEvent.change(payField(), { target: { value: '81234' } });
    await user.click(saveButton());
    await waitFor(() => expect(net.events).toHaveLength(1));
    await user.click(within(billRow('Rent')).getByRole('button', { name: 'Delete Rent' }));
    await waitFor(() => expect(net.events).toHaveLength(2));

    expect(net.events[0]).toEqual({
      event: 'financial_change_ui',
      changeId: 100,
      causedReload: false,
      causedPageWideLoading: false,
      occurredAt: expect.any(String),
    });
    expect(net.events[1]).toMatchObject({ event: 'financial_change_ui', changeId: 101, causedReload: false, causedPageWideLoading: false });
    // Only the schema fields. No amount, label, month, or note is sent.
    const sent = JSON.stringify(net.events);
    for (const secret of ['81234', '8123400', 'Rent', '20000', '2026']) expect(sent.replace(/"occurredAt":"[^"]+"/g, '')).not.toContain(secret);
  });

  it('reports a change that succeeds on retry once, with the receipt of the confirmed attempt', async () => {
    const user = userEvent.setup();
    const { backend, net } = setup({ salaryMinor: paise(75000) });
    await loaded();
    backend.failNext('POST', '/finance/salary', 500, 'SERVER_ERROR', 'The pay could not be saved.');
    fireEvent.change(payField(), { target: { value: '90000' } });
    await user.click(saveButton());
    await waitFor(() => expect(statusOf(SALARY_SCOPE)).toHaveTextContent('Save pay: failed.'));
    expect(net.events).toEqual([]);

    await user.click(within(statusOf(SALARY_SCOPE)).getByRole('button', { name: 'Retry Save pay' }));
    await waitFor(() => expect(net.events).toHaveLength(1));
    expect(net.events[0]).toMatchObject({ event: 'financial_change_ui', changeId: 100, causedReload: false, causedPageWideLoading: false });
    expect(within(notice()).getByText(/Pay saved\./)).toBeInTheDocument();
  });

  it('sends nothing for a change the server did not confirm', async () => {
    const { backend, net } = setup({ salaryMinor: paise(75000) });
    await loaded();
    backend.failNext('POST', '/finance/salary', 500, 'SERVER_ERROR', 'The pay could not be saved.');
    fireEvent.change(payField(), { target: { value: '90000' } });
    await userEvent.setup().click(saveButton());
    await waitFor(() => expect(statusOf(SALARY_SCOPE)).toHaveTextContent('Save pay: failed.'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(net.events).toEqual([]);
  });

  it('sends nothing while Product Analytics is off', async () => {
    measurement.setAnalyticsConsent(false);
    const { net } = setup({ salaryMinor: paise(75000) });
    await loaded();
    fireEvent.change(payField(), { target: { value: '90000' } });
    await userEvent.setup().click(saveButton());
    await waitFor(() => expect(statusOf(SALARY_SCOPE)).toHaveTextContent('Save pay: done'));
    expect(net.events).toEqual([]);
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

  /**
   * Fake milliseconds from now until `ready()` is true, checked after every
   * 16 ms frame. Infinity when it is not true within the budget.
   */
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

  it('shows pending at submit, keeps showing it for as long as the response takes, then confirms within 100 ms of the response', async () => {
    const { net } = setup({ salaryMinor: paise(75000) }, 'plan');
    await screen.findByRole('article', { name: `Your plan for ${MONTH_NAME}` });
    await screen.findByRole('textbox', { name: 'Monthly pay' });
    controlClock();
    const gate = net.hold('POST', '/finance/salary');

    fireEvent.change(payField(), { target: { value: '80000' } });
    act(() => {
      fireEvent.click(saveButton());
    });
    // Submit to feedback with no clock movement at all.
    expect(text(statusOf(SALARY_SCOPE))).toContain('Save pay: pending');
    expect(await elapsedUntil(() => text(statusOf(SALARY_SCOPE)).includes('Save pay: pending'))).toBeLessThanOrEqual(BUDGET_MS);
    expect(text(planCard())).toContain('Refreshing…');

    // A slow server (30 s) does not time the feedback out, flicker it, or confirm anything early.
    await advance(30_000);
    expect(text(statusOf(SALARY_SCOPE))).toContain('Save pay: pending');
    expect(text(planValue('Disposable income'))).toContain('₹75,000');
    expect(net.to('POST', '/finance/salary')).toHaveLength(1);

    await act(async () => {
      gate.release();
    });
    const confirmed = await elapsedUntil(() => (
      text(statusOf(SALARY_SCOPE)).includes('Save pay: done')
      && text(planValue('Disposable income')).includes('₹80,000')
      && !text(planCard()).includes('Refreshing…')
      && text(screen.queryByRole('region', { name: 'Latest change to your plan' })).includes('Pay saved.')
    ));
    expect(confirmed).toBeLessThanOrEqual(BUDGET_MS);
    expect(reload).not.toHaveBeenCalled();
  });

  it('shows a failure and keeps the draft and confirmed values within 100 ms of the failed response', async () => {
    const { backend, net } = setup({ salaryMinor: paise(75000) }, 'plan');
    await screen.findByRole('article', { name: `Your plan for ${MONTH_NAME}` });
    await screen.findByRole('textbox', { name: 'Monthly pay' });
    controlClock();
    backend.failNext('POST', '/finance/salary', 500, 'SERVER_ERROR', 'The pay could not be saved.');
    const gate = net.hold('POST', '/finance/salary');

    fireEvent.change(payField(), { target: { value: '90000' } });
    const save = saveButton();
    save.focus();
    act(() => {
      fireEvent.click(save);
    });
    expect(await elapsedUntil(() => text(statusOf(SALARY_SCOPE)).includes('Save pay: pending'))).toBeLessThanOrEqual(BUDGET_MS);

    await act(async () => {
      gate.release();
    });
    const failed = await elapsedUntil(() => text(statusOf(SALARY_SCOPE)).includes('Save pay: failed.'));
    expect(failed).toBeLessThanOrEqual(BUDGET_MS);
    expect(text(statusOf(SALARY_SCOPE))).toContain('The pay could not be saved.');
    expect(payField()).toHaveValue('90000');
    expect(text(planValue('Disposable income'))).toContain('₹75,000');
    expect(text(planCard())).not.toContain('Refreshing…');
    expect(save).toHaveFocus();
    expect(saveButton()).toBeEnabled();
  });

  it('shows the added bill as pending at submit and the confirmed plan within 100 ms of the response', async () => {
    const { net } = setup({ salaryMinor: paise(75000) }, 'plan');
    await screen.findByRole('article', { name: `Your plan for ${MONTH_NAME}` });
    await screen.findByRole('textbox', { name: 'Monthly pay' });
    controlClock();
    const gate = net.hold('POST', '/finance/emis');

    fillBill('Netflix', 649);
    act(() => {
      fireEvent.click(addButton());
    });
    expect(await elapsedUntil(() => (
      text(statusOf('new-bill:plan')).includes('Add bill: pending') && text(document.body).includes('Adding this bill…')
    ))).toBeLessThanOrEqual(BUDGET_MS);
    // The pay form stays usable.
    expect(payField()).toBeEnabled();
    expect(saveButton()).toBeEnabled();

    await act(async () => {
      gate.release();
    });
    const confirmed = await elapsedUntil(() => (
      text(statusOf('new-bill:plan')).includes('Add bill: done')
      && text(planValue(`Bills counted in ${MONTH_NAME}`)).includes('₹649')
      && !text(document.body).includes('Adding this bill…')
    ));
    expect(confirmed).toBeLessThanOrEqual(BUDGET_MS);
  });

  it('shows the delete as pending at submit and the removal within 100 ms of the response', async () => {
    const { net } = setup({
      salaryMinor: paise(75000),
      bills: [{ label: 'Rent', amountMinor: paise(20000), category: 'Rent' }],
    }, 'plan');
    await screen.findByRole('article', { name: `Your plan for ${MONTH_NAME}` });
    await screen.findByRole('textbox', { name: 'Monthly pay' });
    controlClock();
    const gate = net.hold('DELETE', '/finance/emis/1');

    act(() => {
      fireEvent.click(within(billRow('Rent')).getByRole('button', { name: 'Delete Rent' }));
    });
    expect(await elapsedUntil(() => text(statusOf('bill:1')).includes('Delete Rent: pending'))).toBeLessThanOrEqual(BUDGET_MS);

    await act(async () => {
      gate.release();
    });
    const confirmed = await elapsedUntil(() => (
      !screen.queryByText('Rent', { selector: 'strong' })
      && text(planValue('Disposable income')).includes('₹75,000')
    ));
    expect(confirmed).toBeLessThanOrEqual(BUDGET_MS);
    expect(text(screen.queryByRole('region', { name: 'Latest change to your plan' }))).toContain('Bill deleted.');
  });
});

// The Goals page, and Home beside it, rendered against a fake API that implements
// the financial clarity contract for goals (snapshot reads with per-goal outcomes
// and the urgent-goal highlight, goal mutation envelopes, bounded contributions
// with a 422 range, record versions, 409 conflicts, idempotent replays). It
// covers what Goals.clarity.test.tsx does not:
//
// - same-month, next-month, and far-future target dates, and past dates rejected,
// - contribution bounds at 1 paisa, exactly the gap, and the gap plus 1 paisa,
// - active, overdue, and funded transitions, including the clock moving past a date,
// - one proposed revision accepted, a revision chosen by hand, and a missing pay
//   that is added elsewhere,
// - legacy-invalid goals that are prompted but never rewritten,
// - scoped rollback with the draft kept, retries with the same key, and a lost response,
// - responses that arrive in the opposite order across goals,
// - an open explanation that updates in place after a contribution,
// - Home and Goals sharing one backend: a contribution on Goals moves Home's urgent
//   goal in place, in the server's order, and a failed one leaves Home alone,
// - feedback timing against a controlled clock (no wall-clock waits),
// - axe in both themes.
//
// Timing in jsdom has no paint. Here a "frame" is 16 ms of fake time and every
// budget is checked against the fake clock; response-to-paint in a real browser
// is covered by e2e/goals.clarity.spec.ts. jsdom cannot compute color contrast,
// so contrast is left to the browser acceptance checks.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FinancialClarityProvider } from '../clarity/FinancialClarityProvider';
import { MutationStatusProvider } from '../clarity/MutationStatusProvider';
import { displayDate } from '../components/goals/goalInputs';
import { currentMonth, inr } from '../money';
import { FakeGoalsBackend, type FakeGoalsInit } from '../test/fakeGoalsBackend';
import { installGoalsFetch } from '../test/fakeGoalsFetch';
import { axe, createTestQueryClient, renderAuthenticated } from '../test/test-utils';
import { Dashboard } from './Dashboard';
import { Goals } from './Goals';

const MONTH = currentMonth();
const [YEAR, MONTH_NUMBER] = MONTH.split('-').map(Number) as [number, number];
const two = (value: number) => String(value).padStart(2, '0');
const shiftMonth = (months: number) => {
  const shifted = new Date(YEAR, MONTH_NUMBER - 1 + months, 1);
  return `${shifted.getFullYear()}-${two(shifted.getMonth() + 1)}`;
};
const NEXT = shiftMonth(1);
/** The fake server's current local date is the 15th of the month. */
const TODAY = `${MONTH}-15`;
const BEFORE_TODAY = `${MONTH}-14`;
const LAST_DAY = `${MONTH}-${two(new Date(YEAR, MONTH_NUMBER, 0).getDate())}`;
const NEXT_MONTH_DATE = `${NEXT}-10`;
const FAR_DATE = `${YEAR + 5}-12-31`;
/** Months from this month through December five years on, both counted. */
const FAR_OPPORTUNITIES = 5 * 12 + (12 - MONTH_NUMBER) + 1;
const OVERDUE_DATE = `${MONTH}-01`;
const paise = (rupees: number) => Math.round(rupees * 100);

type GoalInit = NonNullable<FakeGoalsInit['goals']>[number];

function setup(init: FakeGoalsInit = {}, options: { route?: string; home?: boolean } = {}) {
  const backend = new FakeGoalsBackend(MONTH, init);
  const net = installGoalsFetch(backend);
  const view = renderAuthenticated(
    <FinancialClarityProvider>
      <MutationStatusProvider>
        {options.home ? <><Dashboard /><Goals /></> : <Goals />}
      </MutationStatusProvider>
    </FinancialClarityProvider>,
    { route: options.route ?? '/goals', queryClient: createTestQueryClient() },
  );
  return { backend, net, ...view };
}

const goalCard = (name: string) => screen.getByRole('article', { name });
/** The labelled value of an outcome card. An open explanation can repeat a label, so only `.clarity-value` blocks count. */
const valueOf = (card: HTMLElement, label: string) => {
  const blocks = within(card).getAllByText(label).flatMap((node) => {
    const block = node.closest('.clarity-value');
    return block && !block.closest('.clarity-explanation') ? [block as HTMLElement] : [];
  });
  if (blocks.length !== 1) throw new Error(`Expected one "${label}" value, found ${blocks.length}`);
  return blocks[0] as HTMLElement;
};
const feasibility = (name: string) => screen.getByRole('group', { name: `Feasibility for ${name}` });
const statusOf = (scope: string) => document.querySelector(`[data-scope="${scope}"]`) as HTMLElement;
const addButton = (name: string) => screen.getByRole('button', { name: `Add contribution to ${name}` });
const editButton = (name: string) => screen.getByRole('button', { name: `Edit ${name}` });
const contributionForm = (name: string) => screen.getByRole('form', { name: `Add a contribution to ${name}` });
const contributionInput = (name: string) => within(contributionForm(name)).getByRole('textbox', { name: 'Contribution amount' });
const saveContribution = (name: string) => within(contributionForm(name)).getByRole('button', { name: 'Save contribution' });
const nonGet = (backend: FakeGoalsBackend) => backend.log.filter((entry) => entry.method !== 'GET');
const text = (element: Element | null | undefined) => element?.textContent ?? '';


const DUE_TODAY: GoalInit = { id: 1, name: 'Due today', target: 12000, saved: 0, date: TODAY };
/** Gap 600 in two months. Required 300 a month. */
const LAPTOP: GoalInit = { id: 1, name: 'Laptop', target: 1000, saved: 400, date: NEXT_MONTH_DATE };
const PAIR: GoalInit[] = [
  { id: 1, name: 'Alpha', target: 1000, saved: 0, date: NEXT_MONTH_DATE },
  { id: 2, name: 'Bravo', target: 2000, saved: 0, date: NEXT_MONTH_DATE },
];

async function loaded(name: string) {
  await screen.findByRole('article', { name });
}

/** Clicks inside act so pending feedback is checked before any await. */
function click(element: HTMLElement) {
  act(() => {
    fireEvent.click(element);
  });
}

type User = ReturnType<typeof userEvent.setup>;

async function openContribution(user: User, name: string, amount: string) {
  await user.click(addButton(name));
  fireEvent.change(contributionInput(name), { target: { value: amount } });
}

async function contribute(user: User, name: string, amount: string) {
  await openContribution(user, name, amount);
  await user.click(saveContribution(name));
}

function fillCreate(values: { name?: string; target?: string; saved?: string; date?: string }) {
  const form = screen.getByRole('form', { name: 'Add a goal' });
  if (values.name !== undefined) fireEvent.change(within(form).getByRole('textbox', { name: 'Goal name' }), { target: { value: values.name } });
  if (values.target !== undefined) fireEvent.change(within(form).getByRole('textbox', { name: 'Target amount' }), { target: { value: values.target } });
  if (values.saved !== undefined) fireEvent.change(within(form).getByRole('textbox', { name: /Saved so far/ }), { target: { value: values.saved } });
  if (values.date !== undefined) fireEvent.change(within(form).getByLabelText('Target date'), { target: { value: values.date } });
  return form;
}

const reload = vi.fn();
beforeEach(() => {
  vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'true');
  reload.mockClear();
  vi.stubGlobal('location', { ...window.location, reload });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('target date boundaries', () => {
  it('counts this month and the target month for a date today, at month end, next month, and years away', async () => {
    setup({
      goals: [
        DUE_TODAY,
        { id: 2, name: 'Month end', target: 12000, saved: 0, date: LAST_DAY },
        { id: 3, name: 'Next month', target: 100.01, saved: 0, date: `${NEXT}-01` },
        { id: 4, name: 'Far away', target: 120000, saved: 0, date: FAR_DATE },
      ],
    });
    await loaded('Due today');

    for (const name of ['Due today', 'Month end']) {
      const card = goalCard(name);
      expect(valueOf(card, 'Goal status')).toHaveTextContent('Active');
      expect(valueOf(card, 'Monthly contribution opportunities')).toHaveTextContent('1');
      expect(valueOf(card, 'Required monthly contribution')).toHaveTextContent('₹12,000');
      expect(feasibility(name)).toHaveTextContent('Remaining monthly savings capacity: ₹4,000');
      expect(card).toHaveTextContent('This month and the target month are both counted.');
    }
    // 10,001 paise over two months is 5,000.5 paise a month, rounded up to the next paisa.
    const next = goalCard('Next month');
    expect(valueOf(next, 'Monthly contribution opportunities')).toHaveTextContent('2');
    expect(valueOf(next, 'Funding gap')).toHaveTextContent('₹100.01');
    expect(valueOf(next, 'Required monthly contribution')).toHaveTextContent('₹50.01');
    expect(feasibility('Next month')).toHaveTextContent('Remaining monthly savings capacity: ₹15,949.99');

    const far = goalCard('Far away');
    expect(valueOf(far, 'Monthly contribution opportunities')).toHaveTextContent(String(FAR_OPPORTUNITIES));
    expect(valueOf(far, 'Required monthly contribution')).toHaveTextContent(inr(Math.ceil(12_000_000 / FAR_OPPORTUNITIES) / 100));
  });

  it('accepts a target date of today, and the date field offers nothing earlier', async () => {
    const user = userEvent.setup();
    const { backend, net } = setup();
    await screen.findByText(/You have no goals yet/);
    const form = fillCreate({ name: 'Today goal', target: '9000', date: TODAY });
    expect(within(form).getByLabelText('Target date')).toHaveAttribute('min', TODAY);
    await user.click(within(form).getByRole('button', { name: 'Add goal' }));

    const card = await screen.findByRole('article', { name: 'Today goal' });
    expect(net.to('POST', '/finance/goals')[0]?.body).toEqual({
      name: 'Today goal', targetAmountMinor: paise(9000), savedAmountMinor: 0, targetDate: TODAY,
    });
    expect(valueOf(card, 'Monthly contribution opportunities')).toHaveTextContent('1');
    expect(valueOf(card, 'Required monthly contribution')).toHaveTextContent('₹9,000');
    expect(valueOf(card, 'Target date')).toHaveTextContent(displayDate(TODAY));
    expect(backend.goals).toHaveLength(1);
  });

  it('rejects yesterday with the bound named, sends nothing, and keeps every other field', async () => {
    const user = userEvent.setup();
    const { backend, net } = setup();
    await screen.findByText(/You have no goals yet/);
    const form = fillCreate({ name: 'Late goal', target: '9000', saved: '100', date: BEFORE_TODAY });
    await user.click(within(form).getByRole('button', { name: 'Add goal' }));

    const problem = within(form).getByText(/Target date:/).parentElement;
    expect(problem).toHaveTextContent(`is before today. Choose ${displayDate(TODAY)} or a later date.`);
    expect(within(form).getByLabelText('Target date')).toHaveAttribute('aria-invalid', 'true');
    expect(within(form).getByRole('textbox', { name: 'Goal name' })).toHaveValue('Late goal');
    expect(within(form).getByRole('textbox', { name: 'Target amount' })).toHaveValue('9000');
    expect(within(form).getByRole('textbox', { name: /Saved so far/ })).toHaveValue('100');
    expect(net.to('POST', '/finance/goals')).toHaveLength(0);
    expect(backend.goals).toHaveLength(0);

    // Today is accepted from the same draft.
    fireEvent.change(within(form).getByLabelText('Target date'), { target: { value: TODAY } });
    await user.click(within(form).getByRole('button', { name: 'Add goal' }));
    await screen.findByRole('article', { name: 'Late goal' });
    expect(net.to('POST', '/finance/goals')).toHaveLength(1);
  });

  it('rejects a changed target date before today without touching the saved goal', async () => {
    const user = userEvent.setup();
    const { backend, net } = setup({ goals: [LAPTOP] });
    await loaded('Laptop');
    await user.click(editButton('Laptop'));
    const form = screen.getByRole('form', { name: 'Correct Laptop' });
    fireEvent.change(within(form).getByLabelText('Target date'), { target: { value: BEFORE_TODAY } });
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));

    expect(within(form).getByText(/Target date:/).parentElement).toHaveTextContent('is before today.');
    expect(within(form).getByLabelText('Target date')).toHaveValue(BEFORE_TODAY);
    expect(net.to('PATCH', '/finance/goals/1')).toHaveLength(0);
    expect(backend.find(1)?.targetDate).toBe(NEXT_MONTH_DATE);
    expect(valueOf(goalCard('Laptop'), 'Target date')).toHaveTextContent(displayDate(NEXT_MONTH_DATE));
  });

  it('turns a goal due today into an overdue one when the server date moves on, on the next confirmed response', async () => {
    const user = userEvent.setup();
    const { backend } = setup({ goals: [DUE_TODAY, { id: 2, name: 'Other', target: 500, saved: 0, date: NEXT_MONTH_DATE }] });
    await loaded('Due today');
    expect(valueOf(goalCard('Due today'), 'Goal status')).toHaveTextContent('Active');

    backend.today = `${MONTH}-16`;
    await contribute(user, 'Other', '10');
    await waitFor(() => expect(valueOf(goalCard('Due today'), 'Goal status')).toHaveTextContent('Overdue'));
    const card = goalCard('Due today');
    expect(valueOf(card, 'Funding gap')).toHaveTextContent('₹12,000');
    expect(valueOf(card, 'Required monthly contribution')).toHaveTextContent('Unavailable');
    expect(valueOf(card, 'Monthly contribution opportunities')).toHaveTextContent('0');
    expect(feasibility('Due today')).toHaveTextContent('Target date passed.');
    expect(within(card).getByRole('group', { name: 'Revision needed for Due today' })).toHaveTextContent('Revise this goal.');
  });
});

describe('contribution amount boundaries', () => {
  it('accepts 1 paisa, the smallest amount, and counts it once', async () => {
    const user = userEvent.setup();
    const { backend, net } = setup({ goals: [LAPTOP] });
    await loaded('Laptop');
    await contribute(user, 'Laptop', '0.01');

    await waitFor(() => expect(statusOf('goal:1')).toHaveTextContent('Add contribution to Laptop: done'));
    const card = goalCard('Laptop');
    expect(net.to('POST', '/finance/goals/1/contributions')[0]?.body).toEqual({ contributionMinor: 1 });
    expect(valueOf(card, 'Funding gap')).toHaveTextContent('₹599.99');
    expect(valueOf(card, 'Saved so far')).toHaveTextContent('₹400.01');
    // 59,999 paise over two months is 29,999.5, rounded up to 30,000 paise.
    expect(valueOf(card, 'Required monthly contribution')).toHaveTextContent('₹300');
    expect(backend.find(1)?.savedMinor).toBe(paise(400) + 1);
    expect(nonGet(backend)).toHaveLength(1);
  });

  it('accepts exactly the gap: the goal is funded, needs no contribution, and focus moves to a control that remains', async () => {
    const user = userEvent.setup();
    const { backend } = setup({ goals: [LAPTOP] });
    await loaded('Laptop');
    await contribute(user, 'Laptop', '600');

    await waitFor(() => expect(valueOf(goalCard('Laptop'), 'Goal status')).toHaveTextContent('Funded'));
    const card = goalCard('Laptop');
    expect(valueOf(card, 'Funding gap')).toHaveTextContent('₹0');
    expect(valueOf(card, 'Required monthly contribution')).toHaveTextContent('₹0');
    expect(valueOf(card, 'Saved so far')).toHaveTextContent('₹1,000');
    expect(feasibility('Laptop')).toHaveTextContent('Fully funded.');
    expect(feasibility('Laptop')).toHaveAttribute('data-feasibility', 'funded');
    expect(screen.queryByRole('button', { name: 'Add contribution to Laptop' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Add a contribution to Laptop' })).toBeNull();
    expect(editButton('Laptop')).toHaveFocus();
    expect(backend.find(1)?.savedMinor).toBe(paise(1000));
  });

  it('rejects the gap plus 1 paisa, shows the server minimum and maximum, keeps the draft, and applies nothing', async () => {
    const user = userEvent.setup();
    const { backend } = setup({ goals: [LAPTOP] });
    await loaded('Laptop');
    await contribute(user, 'Laptop', '600.01');

    const form = contributionForm('Laptop');
    const error = await within(form).findByText(/Contribution:/);
    expect(error.parentElement).toHaveTextContent('is outside the accepted range. Enter an amount from ₹0.01 to ₹600.');
    const input = contributionInput('Laptop');
    expect(input).toHaveValue('600.01');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input.getAttribute('aria-describedby')).toContain(error.parentElement?.id);
    expect(statusOf('goal:1')).not.toHaveTextContent(/failed|pending|done/);
    expect(within(statusOf('goal:1')).queryByRole('button', { name: /Retry/ })).toBeNull();
    expect(valueOf(goalCard('Laptop'), 'Funding gap')).toHaveTextContent('₹600');
    expect(backend.find(1)?.savedMinor).toBe(paise(400));
    expect(backend.find(1)?.version).toBe(0);

    // The same draft, lowered to the maximum, is accepted.
    fireEvent.change(input, { target: { value: '600' } });
    await user.click(saveContribution('Laptop'));
    await waitFor(() => expect(valueOf(goalCard('Laptop'), 'Goal status')).toHaveTextContent('Funded'));
    expect(within(statusOf('goal:1')).queryByText(/Contribution:/)).toBeNull();
  });

  it('rejects zero with the server minimum of 1 paisa', async () => {
    const user = userEvent.setup();
    const { backend, net } = setup({ goals: [LAPTOP] });
    await loaded('Laptop');
    await contribute(user, 'Laptop', '0');

    const error = await within(contributionForm('Laptop')).findByText(/Contribution:/);
    expect(error.parentElement).toHaveTextContent('Enter an amount from ₹0.01 to ₹600.');
    expect(net.to('POST', '/finance/goals/1/contributions')[0]?.body).toEqual({ contributionMinor: 0 });
    expect(backend.find(1)?.savedMinor).toBe(paise(400));
  });

  it('shows the new range after the gap changed elsewhere, and the form keeps what was typed', async () => {
    const user = userEvent.setup();
    const { backend, net } = setup({ goals: [LAPTOP] });
    await loaded('Laptop');
    await user.click(addButton('Laptop'));
    expect(contributionForm('Laptop')).toHaveTextContent('Accepted range: ₹0.01 to ₹600');

    // Another device adds 100 rupees, so the gap is now 500.
    const goal = backend.find(1);
    if (goal) goal.savedMinor += paise(100);
    backend.dataVersion += 1;
    fireEvent.change(contributionInput('Laptop'), { target: { value: '600' } });
    const listRead = net.hold('GET', '/finance/goals');
    await user.click(saveContribution('Laptop'));

    await within(contributionForm('Laptop')).findByText(/Contribution:/);
    expect(within(contributionForm('Laptop')).getByText(/Contribution:/).parentElement).toHaveTextContent('Enter an amount from ₹0.01 to ₹500.');
    await waitFor(() => expect(contributionForm('Laptop')).toHaveTextContent('Accepted range: ₹0.01 to ₹500'));
    expect(valueOf(goalCard('Laptop'), 'Funding gap')).toHaveTextContent('₹500');
    // The goal list is read again with the snapshot. While that read runs, the shown list stays as it was
    // and gets no "Refreshing" note, so nothing shifts beside the rejection message.
    await waitFor(() => expect(net.to('GET', '/finance/goals')).toHaveLength(2));
    expect(screen.queryByText(/Refreshing Goal list/)).toBeNull();
    expect(valueOf(goalCard('Laptop'), 'Saved so far')).toHaveTextContent('₹400');
    listRead.release();
    // Then "Saved so far" is not stale beside the new gap.
    await waitFor(() => expect(valueOf(goalCard('Laptop'), 'Saved so far')).toHaveTextContent('₹500'));
    expect(net.to('GET', '/finance/goals')).toHaveLength(2);
    expect(contributionInput('Laptop')).toHaveValue('600');
    expect(net.to('GET', '/finance/clarity').length).toBeGreaterThanOrEqual(2);
    expect(goal?.savedMinor).toBe(paise(500));
  });

  it('keeps the draft on a stale record version, says the goal changed, and saves with the next try', async () => {
    const user = userEvent.setup();
    const { backend, net } = setup({ goals: [LAPTOP] });
    await loaded('Laptop');
    await contribute(user, 'Laptop', '100');
    await waitFor(() => expect(statusOf('goal:1')).toHaveTextContent('done'));

    backend.changeElsewhere(1);
    await contribute(user, 'Laptop', '50');
    expect(await screen.findByText(/This goal was changed somewhere else/)).toBeInTheDocument();
    expect(contributionInput('Laptop')).toHaveValue('50');
    expect(statusOf('goal:1')).not.toHaveTextContent(/failed|pending/);
    expect(backend.find(1)?.savedMinor).toBe(paise(500));

    await user.click(saveContribution('Laptop'));
    await waitFor(() => expect(valueOf(goalCard('Laptop'), 'Saved so far')).toHaveTextContent('₹550'));
    const posts = net.to('POST', '/finance/goals/1/contributions');
    expect(posts.map((post) => (post.body as Record<string, unknown>).expectedRecordVersion)).toEqual([undefined, 1, undefined]);
    expect(screen.queryByText(/This goal was changed somewhere else/)).toBeNull();
  });
});

describe('active, overdue, and funded transitions', () => {
  it('turns an overdue goal into a funded one with a contribution of exactly the gap', async () => {
    const user = userEvent.setup();
    const { backend } = setup({ goals: [{ id: 1, name: 'Late goal', target: 300, saved: 100, date: OVERDUE_DATE }] });
    await loaded('Late goal');
    const card = goalCard('Late goal');
    expect(valueOf(card, 'Goal status')).toHaveTextContent('Overdue');
    expect(valueOf(card, 'Funding gap')).toHaveTextContent('₹200');
    expect(valueOf(card, 'Required monthly contribution')).toHaveTextContent('Unavailable');
    expect(within(card).getByRole('group', { name: 'Revision needed for Late goal' })).toBeInTheDocument();

    await contribute(user, 'Late goal', '200');
    await waitFor(() => expect(valueOf(goalCard('Late goal'), 'Goal status')).toHaveTextContent('Funded'));
    expect(feasibility('Late goal')).toHaveTextContent('Fully funded.');
    expect(within(goalCard('Late goal')).queryByRole('group', { name: /Revision needed/ })).toBeNull();
    expect(backend.find(1)?.savedMinor).toBe(paise(300));
  });

  it('keeps an overdue goal overdue after a partial contribution, with the smaller gap', async () => {
    const user = userEvent.setup();
    setup({ goals: [{ id: 1, name: 'Late goal', target: 300, saved: 100, date: OVERDUE_DATE }] });
    await loaded('Late goal');
    await contribute(user, 'Late goal', '50');
    await waitFor(() => expect(valueOf(goalCard('Late goal'), 'Funding gap')).toHaveTextContent('₹150'));
    expect(valueOf(goalCard('Late goal'), 'Goal status')).toHaveTextContent('Overdue');
    expect(valueOf(goalCard('Late goal'), 'Required monthly contribution')).toHaveTextContent('Unavailable');
  });

  it('turns an overdue goal into an active one when its date is revised, sending only the date', async () => {
    const user = userEvent.setup();
    const { net } = setup({ goals: [{ id: 1, name: 'Late goal', target: 300, saved: 100, date: OVERDUE_DATE }] });
    await loaded('Late goal');
    await user.click(screen.getByRole('button', { name: 'Revise target for Late goal' }));
    const form = screen.getByRole('form', { name: 'Correct Late goal' });
    expect(within(form).getByLabelText('Target date')).toHaveFocus();
    fireEvent.change(within(form).getByLabelText('Target date'), { target: { value: NEXT_MONTH_DATE } });
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(valueOf(goalCard('Late goal'), 'Goal status')).toHaveTextContent('Active'));
    const card = goalCard('Late goal');
    expect(net.to('PATCH', '/finance/goals/1')[0]?.body).toEqual({ targetDate: NEXT_MONTH_DATE });
    expect(valueOf(card, 'Monthly contribution opportunities')).toHaveTextContent('2');
    expect(valueOf(card, 'Required monthly contribution')).toHaveTextContent('₹100');
    expect(feasibility('Late goal')).toHaveTextContent('Feasible.');
    expect(within(card).queryByRole('group', { name: /Revision needed/ })).toBeNull();
  });
});

describe('revisions and the missing monthly plan', () => {
  const CAR: GoalInit = { id: 1, name: 'Car', target: 100000, saved: 0, date: NEXT_MONTH_DATE };

  it('accepts the one proposed revision and recomputes to feasible with no capacity left', async () => {
    const user = userEvent.setup();
    const { backend, net } = setup({ goals: [CAR] });
    await loaded('Car');
    const card = goalCard('Car');
    expect(feasibility('Car')).toHaveTextContent('Over your savings target by: ₹34,000 a month');
    const revision = within(card).getByRole('group', { name: 'Suggested revision for Car' });
    expect(revision).toHaveTextContent('Revised target amount: ₹32,000');
    expect(screen.getAllByRole('button', { name: /Accept revision/ })).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Accept revision for Car' }));
    await waitFor(() => expect(statusOf('goal:1')).toHaveTextContent('Accept revised target for Car: done'));
    expect(net.to('PATCH', '/finance/goals/1')[0]?.body).toEqual({ targetAmountMinor: paise(32000) });
    expect(valueOf(card, 'Target amount')).toHaveTextContent('₹32,000');
    expect(valueOf(card, 'Funding gap')).toHaveTextContent('₹32,000');
    expect(valueOf(card, 'Required monthly contribution')).toHaveTextContent('₹16,000');
    expect(feasibility('Car')).toHaveTextContent('Feasible.');
    expect(feasibility('Car')).toHaveTextContent('Remaining monthly savings capacity: ₹0');
    expect(within(card).queryByRole('group', { name: /revision/i })).toBeNull();
    expect(backend.find(1)?.targetMinor).toBe(paise(32000));
  });

  it('lets the user choose a target amount of their own, which recomputes to feasible', async () => {
    const user = userEvent.setup();
    const { net } = setup({ goals: [CAR] });
    await loaded('Car');
    await user.click(screen.getByRole('button', { name: 'Choose my own revision for Car' }));
    const form = screen.getByRole('form', { name: 'Correct Car' });
    fireEvent.change(within(form).getByRole('textbox', { name: 'Target amount' }), { target: { value: '30000' } });
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(feasibility('Car')).toHaveTextContent('Feasible.'));
    expect(net.to('PATCH', '/finance/goals/1')[0]?.body).toEqual({ targetAmountMinor: paise(30000) });
    expect(feasibility('Car')).toHaveTextContent('Remaining monthly savings capacity: ₹1,000');
  });

  it('offers a later date, not an invented amount, when no revised amount can fit', async () => {
    const { backend } = setup({ goals: [CAR], savingsTarget: 0 });
    await loaded('Car');
    const group = within(goalCard('Car')).getByRole('group', { name: 'Revision for Car' });
    expect(group).toHaveTextContent('No revised target amount fits your savings target by this date.');
    expect(screen.queryByRole('button', { name: /Accept revision/ })).toBeNull();
    expect(nonGet(backend)).toHaveLength(0);
  });

  it('names the missing pay inside the feasibility region only, then shows feasibility once the pay exists', async () => {
    const user = userEvent.setup();
    const { backend } = setup({ goals: [LAPTOP, { id: 2, name: 'Phone', target: 500, saved: 0, date: NEXT_MONTH_DATE }], savingsTarget: null });
    await loaded('Laptop');
    const card = goalCard('Laptop');
    const region = feasibility('Laptop');
    expect(region).toHaveAttribute('data-feasibility', 'unavailable');
    expect(region).toHaveTextContent('Feasibility unavailable. Add your monthly pay');
    expect(within(region).getByRole('link', { name: /Add this month’s pay/ })).toHaveAttribute('href', '/plan#pay-form');
    expect(within(card).queryAllByText(/Add your monthly pay/)).toHaveLength(1);
    // The gap and the required contribution do not depend on pay.
    expect(valueOf(card, 'Funding gap')).toHaveTextContent('₹600');
    expect(valueOf(card, 'Required monthly contribution')).toHaveTextContent('₹300');
    expect(screen.queryByRole('button', { name: /Accept revision/ })).toBeNull();

    // The pay is entered on the Plan page. The next confirmed response carries the result.
    backend.setSavingsTarget(16000);
    await contribute(user, 'Phone', '10');
    await waitFor(() => expect(feasibility('Laptop')).toHaveTextContent('Feasible.'));
    expect(feasibility('Laptop')).toHaveTextContent('Remaining monthly savings capacity: ₹15,700');
    expect(within(goalCard('Laptop')).queryByText(/Add your monthly pay/)).toBeNull();
  });
});

describe('legacy-invalid goals', () => {
  const LEGACY: GoalInit[] = [
    { id: 1, name: 'Overfunded', target: 100, saved: 500, date: NEXT_MONTH_DATE },
    { id: 2, name: 'Undated', target: 5000, saved: 100, date: null },
    { id: 3, name: 'Fine', target: 1000, saved: 0, date: NEXT_MONTH_DATE },
  ];

  it('prompts for each correction, offers no contribution, and writes nothing on load', async () => {
    const { backend } = setup({ goals: LEGACY });
    await loaded('Fine');
    const over = goalCard('Overfunded');
    const undated = goalCard('Undated');
    expect(over).toHaveAttribute('data-status', 'invalid_input');
    expect(over).toHaveTextContent('The saved amount is above the target amount.');
    expect(undated).toHaveAttribute('data-status', 'invalid_input');
    expect(undated).toHaveTextContent(`This goal has no valid target date. Choose a target date on or after ${displayDate(TODAY)}`);
    expect(within(over).getByRole('button', { name: 'Correct this goal: Overfunded' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add contribution to Overfunded' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add contribution to Undated' })).toBeNull();
    // The saved values stay as entered, and the valid goal is unaffected.
    expect(screen.getByText('No target date')).toBeInTheDocument();
    expect(goalCard('Fine')).toHaveAttribute('data-status', 'available');
    expect(screen.getByRole('button', { name: 'Add contribution to Fine' })).toBeInTheDocument();
    expect(nonGet(backend)).toHaveLength(0);
    expect(backend.find(1)).toMatchObject({ targetMinor: paise(100), savedMinor: paise(500) });
    expect(backend.find(2)?.targetDate).toBeNull();
  });

  it('corrects only the field that is wrong and leaves the other invalid goal exactly as stored', async () => {
    const user = userEvent.setup();
    const { backend, net } = setup({ goals: LEGACY });
    await loaded('Undated');
    await user.click(screen.getByRole('button', { name: 'Correct this goal: Undated' }));
    const form = screen.getByRole('form', { name: 'Correct Undated' });
    expect(within(form).getByLabelText('Target date')).toHaveFocus();
    fireEvent.change(within(form).getByLabelText('Target date'), { target: { value: `${NEXT}-20` } });
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(goalCard('Undated')).toHaveAttribute('data-status', 'available'));
    expect(net.to('PATCH', '/finance/goals/2')[0]?.body).toEqual({ targetDate: `${NEXT}-20` });
    expect(valueOf(goalCard('Undated'), 'Monthly contribution opportunities')).toHaveTextContent('2');
    expect(screen.getByRole('button', { name: 'Add contribution to Undated' })).toBeInTheDocument();
    expect(goalCard('Overfunded')).toHaveAttribute('data-status', 'invalid_input');
    expect(backend.find(1)).toMatchObject({ targetMinor: paise(100), savedMinor: paise(500), version: 0 });
    expect(nonGet(backend)).toHaveLength(1);
  });

  it('corrects an over-funded goal by changing only the saved amount', async () => {
    const user = userEvent.setup();
    const { net } = setup({ goals: LEGACY });
    await loaded('Overfunded');
    await user.click(screen.getByRole('button', { name: 'Correct this goal: Overfunded' }));
    const form = screen.getByRole('form', { name: 'Correct Overfunded' });
    expect(within(form).getByRole('textbox', { name: 'Saved so far' })).toHaveFocus();
    fireEvent.change(within(form).getByRole('textbox', { name: 'Saved so far' }), { target: { value: '50' } });
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(goalCard('Overfunded')).toHaveAttribute('data-status', 'available'));
    expect(net.to('PATCH', '/finance/goals/1')[0]?.body).toEqual({ savedAmountMinor: paise(50) });
    expect(valueOf(goalCard('Overfunded'), 'Funding gap')).toHaveTextContent('₹50');
  });

  it('refuses a contribution to a goal that became invalid after it loaded, names the correction, and keeps the draft', async () => {
    const user = userEvent.setup();
    const { backend } = setup({ goals: [LAPTOP] });
    await loaded('Laptop');
    await user.click(addButton('Laptop'));
    const goal = backend.find(1);
    if (goal) goal.savedMinor = paise(1500);
    fireEvent.change(contributionInput('Laptop'), { target: { value: '100' } });
    await user.click(saveContribution('Laptop'));

    const error = await within(contributionForm('Laptop')).findByText(/This goal:/);
    expect(error.parentElement).toHaveTextContent('needs a correction before you can add to it.');
    expect(error.parentElement).toHaveTextContent('Choose Correct this goal');
    expect(contributionInput('Laptop')).toHaveValue('100');
    expect(statusOf('goal:1')).not.toHaveTextContent(/failed|pending|done/);
    expect(goal?.savedMinor).toBe(paise(1500));
    expect(goal?.version).toBe(0);
  });
});

describe('failures roll back one goal and keep what was typed', () => {
  it('fails a contribution without touching another goal, then retries once with the same key', async () => {
    const user = userEvent.setup();
    const { backend, net } = setup({ goals: PAIR });
    await loaded('Alpha');
    backend.failNext('POST', '/finance/goals/1/contributions', 500, 'SERVER_ERROR', 'The contribution could not be saved.');
    await contribute(user, 'Alpha', '100');

    await waitFor(() => expect(statusOf('goal:1')).toHaveTextContent('Add contribution to Alpha: failed.'));
    expect(statusOf('goal:1')).toHaveTextContent('The contribution could not be saved.');
    expect(valueOf(goalCard('Alpha'), 'Funding gap')).toHaveTextContent('₹1,000');
    expect(contributionInput('Alpha')).toHaveValue('100');
    expect(contributionForm('Alpha')).toBeInTheDocument();
    expect(valueOf(goalCard('Bravo'), 'Funding gap')).toHaveTextContent('₹2,000');
    expect(statusOf('goal:2')).not.toHaveTextContent(/pending|failed|done/);
    expect(addButton('Bravo')).not.toHaveAttribute('aria-disabled');
    expect(backend.find(1)?.savedMinor).toBe(0);
    // A server failure does no extra work: no snapshot or goal-list re-read.
    expect(net.to('GET', '/finance/clarity')).toHaveLength(1);
    expect(net.to('GET', '/finance/goals')).toHaveLength(1);

    await user.click(within(statusOf('goal:1')).getByRole('button', { name: 'Retry Add contribution to Alpha' }));
    await waitFor(() => expect(statusOf('goal:1')).toHaveTextContent('Add contribution to Alpha: done'));
    const posts = net.to('POST', '/finance/goals/1/contributions');
    expect(posts).toHaveLength(2);
    expect(posts[1]?.headers['idempotency-key']).toBe(posts[0]?.headers['idempotency-key']);
    expect(posts[1]?.body).toEqual(posts[0]?.body);
    expect(valueOf(goalCard('Alpha'), 'Funding gap')).toHaveTextContent('₹900');
    expect(backend.find(1)?.savedMinor).toBe(paise(100));
    expect(valueOf(goalCard('Bravo'), 'Funding gap')).toHaveTextContent('₹2,000');
  });

  it('counts a contribution once when its response was lost and the retry is replayed by the server', async () => {
    const user = userEvent.setup();
    const { backend, net } = setup({ goals: PAIR });
    await loaded('Alpha');
    net.loseResponse('POST', '/finance/goals/1/contributions');
    await contribute(user, 'Alpha', '100');

    await waitFor(() => expect(statusOf('goal:1')).toHaveTextContent('Add contribution to Alpha: failed.'));
    // The server did apply it, but the page has not seen that, so it shows the last confirmed values.
    expect(backend.find(1)?.savedMinor).toBe(paise(100));
    expect(valueOf(goalCard('Alpha'), 'Funding gap')).toHaveTextContent('₹1,000');
    expect(contributionInput('Alpha')).toHaveValue('100');

    await user.click(within(statusOf('goal:1')).getByRole('button', { name: 'Retry Add contribution to Alpha' }));
    await waitFor(() => expect(statusOf('goal:1')).toHaveTextContent('Add contribution to Alpha: done'));
    const posts = net.to('POST', '/finance/goals/1/contributions');
    expect(posts).toHaveLength(2);
    expect(posts[1]?.headers['idempotency-key']).toBe(posts[0]?.headers['idempotency-key']);
    expect(backend.find(1)?.savedMinor).toBe(paise(100));
    expect(valueOf(goalCard('Alpha'), 'Funding gap')).toHaveTextContent('₹900');
    expect(valueOf(goalCard('Alpha'), 'Saved so far')).toHaveTextContent('₹100');
  });

  it('keeps an edited draft when the save fails, and the saved goal unchanged', async () => {
    const user = userEvent.setup();
    const { backend } = setup({ goals: PAIR });
    await loaded('Alpha');
    backend.failNext('PATCH', '/finance/goals/1', 500, 'SERVER_ERROR', 'The goal could not be saved.');
    await user.click(editButton('Alpha'));
    const form = screen.getByRole('form', { name: 'Correct Alpha' });
    fireEvent.change(within(form).getByRole('textbox', { name: 'Goal name' }), { target: { value: 'Alpha plus' } });
    fireEvent.change(within(form).getByRole('textbox', { name: 'Target amount' }), { target: { value: '1500' } });
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(statusOf('goal:1')).toHaveTextContent('Save Alpha: failed.'));
    expect(within(form).getByRole('textbox', { name: 'Goal name' })).toHaveValue('Alpha plus');
    expect(within(form).getByRole('textbox', { name: 'Target amount' })).toHaveValue('1500');
    expect(screen.getByRole('article', { name: 'Alpha' })).toBeInTheDocument();
    expect(valueOf(goalCard('Alpha'), 'Target amount')).toHaveTextContent('₹1,000');
    expect(backend.find(1)).toMatchObject({ name: 'Alpha', targetMinor: paise(1000) });
  });

  it('keeps a goal when its delete fails and removes only that goal once the delete is confirmed', async () => {
    const user = userEvent.setup();
    const { backend } = setup({ goals: PAIR });
    await loaded('Alpha');
    backend.failNext('DELETE', '/finance/goals/1', 500, 'SERVER_ERROR', 'The goal could not be deleted.');
    await user.click(screen.getByRole('button', { name: 'Delete Alpha' }));
    await user.click(screen.getByRole('button', { name: 'Delete goal' }));

    await waitFor(() => expect(statusOf('goal:1')).toHaveTextContent('Delete Alpha: failed.'));
    expect(goalCard('Alpha')).toBeInTheDocument();
    expect(backend.goals).toHaveLength(2);

    await user.click(within(statusOf('goal:1')).getByRole('button', { name: 'Retry Delete Alpha' }));
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Alpha' })).toBeNull());
    expect(goalCard('Bravo')).toBeInTheDocument();
    expect(backend.goals.map((goal) => goal.name)).toEqual(['Bravo']);
  });

  it('keeps a new goal’s draft when saving fails and retries it once with the same key', async () => {
    const user = userEvent.setup();
    const { backend, net } = setup({ goals: [LAPTOP] });
    await loaded('Laptop');
    backend.failNext('POST', '/finance/goals', 500, 'SERVER_ERROR', 'The goal could not be saved.');
    const form = fillCreate({ name: 'Trip fund', target: '50,000', saved: '500', date: FAR_DATE });
    await user.click(within(form).getByRole('button', { name: 'Add goal' }));

    await waitFor(() => expect(statusOf('new-goal:form')).toHaveTextContent('Add goal: failed.'));
    expect(within(form).getByRole('textbox', { name: 'Goal name' })).toHaveValue('Trip fund');
    expect(within(form).getByRole('textbox', { name: 'Target amount' })).toHaveValue('50,000');
    expect(within(form).getByRole('textbox', { name: /Saved so far/ })).toHaveValue('500');
    expect(within(form).getByLabelText('Target date')).toHaveValue(FAR_DATE);
    expect(screen.queryByRole('article', { name: 'Trip fund' })).toBeNull();
    expect(goalCard('Laptop')).toHaveAttribute('data-status', 'available');

    await user.click(within(statusOf('new-goal:form')).getByRole('button', { name: 'Retry Add goal' }));
    await screen.findByRole('article', { name: 'Trip fund' });
    const posts = net.to('POST', '/finance/goals');
    expect(posts).toHaveLength(2);
    expect(posts[1]?.headers['idempotency-key']).toBe(posts[0]?.headers['idempotency-key']);
    expect(backend.goals.filter((goal) => goal.name === 'Trip fund')).toHaveLength(1);
    await waitFor(() => expect(within(form).getByRole('textbox', { name: 'Goal name' })).toHaveValue(''));
  });
});

describe('responses for different goals arrive in the opposite order', () => {
  it.each([
    ['responses arrive in reverse order', 'response'],
    ['requests are processed in reverse order', 'request'],
  ] as const)('both contributions end in the correct state when %s', async (_name, held) => {
    const user = userEvent.setup();
    const { backend, net } = setup({ goals: PAIR });
    await loaded('Alpha');
    await openContribution(user, 'Alpha', '100');
    await openContribution(user, 'Bravo', '200');
    const hold = held === 'response' ? net.holdResponse : net.hold;
    const first = hold('POST', '/finance/goals/1/contributions');
    const second = hold('POST', '/finance/goals/2/contributions');

    click(saveContribution('Alpha'));
    click(saveContribution('Bravo'));
    expect(statusOf('goal:1')).toHaveTextContent('Add contribution to Alpha: pending');
    expect(statusOf('goal:2')).toHaveTextContent('Add contribution to Bravo: pending');
    if (held === 'response') await waitFor(() => expect(nonGet(backend)).toHaveLength(2));
    expect(valueOf(goalCard('Alpha'), 'Funding gap')).toHaveTextContent('₹1,000');
    expect(valueOf(goalCard('Bravo'), 'Funding gap')).toHaveTextContent('₹2,000');

    // Bravo was submitted second and answers first.
    await act(async () => {
      second.release();
    });
    await waitFor(() => expect(statusOf('goal:2')).toHaveTextContent('Add contribution to Bravo: done'));
    expect(valueOf(goalCard('Bravo'), 'Funding gap')).toHaveTextContent('₹1,800');
    expect(statusOf('goal:1')).toHaveTextContent('Add contribution to Alpha: pending');

    // Alpha answers last. With held responses its snapshot is the older one and must not undo Bravo.
    await act(async () => {
      first.release();
    });
    await waitFor(() => expect(statusOf('goal:1')).toHaveTextContent('Add contribution to Alpha: done'));
    expect(valueOf(goalCard('Alpha'), 'Funding gap')).toHaveTextContent('₹900');
    expect(valueOf(goalCard('Bravo'), 'Funding gap')).toHaveTextContent('₹1,800');
    expect(goalCard('Alpha')).toHaveAttribute('data-version', '3');
    expect(goalCard('Bravo')).toHaveAttribute('data-version', '3');
    expect(goalCard('Alpha')).not.toHaveTextContent('Refreshing…');
    expect(goalCard('Bravo')).not.toHaveTextContent('Refreshing…');
    expect(backend.find(1)?.savedMinor).toBe(paise(100));
    expect(backend.find(2)?.savedMinor).toBe(paise(200));
    expect(nonGet(backend)).toHaveLength(2);
    expect(net.to('GET', '/finance/goals')).toHaveLength(1);
    expect(reload).not.toHaveBeenCalled();
  });

  it('shows a failed contribution on one goal and a confirmed one on another, whichever answers first', async () => {
    const user = userEvent.setup();
    const { backend, net } = setup({ goals: PAIR });
    await loaded('Alpha');
    await openContribution(user, 'Alpha', '100');
    await openContribution(user, 'Bravo', '200');
    backend.failNext('POST', '/finance/goals/1/contributions', 500, 'SERVER_ERROR', 'The contribution could not be saved.');
    const first = net.hold('POST', '/finance/goals/1/contributions');
    const second = net.hold('POST', '/finance/goals/2/contributions');
    click(saveContribution('Alpha'));
    click(saveContribution('Bravo'));

    await act(async () => {
      second.release();
    });
    await waitFor(() => expect(statusOf('goal:2')).toHaveTextContent('done'));
    await act(async () => {
      first.release();
    });
    await waitFor(() => expect(statusOf('goal:1')).toHaveTextContent('Add contribution to Alpha: failed.'));
    expect(valueOf(goalCard('Alpha'), 'Funding gap')).toHaveTextContent('₹1,000');
    expect(valueOf(goalCard('Bravo'), 'Funding gap')).toHaveTextContent('₹1,800');
    expect(contributionInput('Alpha')).toHaveValue('100');
    expect(backend.find(1)?.savedMinor).toBe(0);
  });
});

describe('an open explanation updates in place after a contribution', () => {
  const EXPLANATION = '/finance/explanations/goal%3A1';

  it('keeps the explanation open and its toggle in place, replaces its values when the new version arrives, and never reloads', async () => {
    const user = userEvent.setup();
    const { backend, net } = setup({ goals: [LAPTOP, { id: 2, name: 'Phone', target: 500, saved: 0, date: NEXT_MONTH_DATE }] });
    await loaded('Laptop');
    const toggle = screen.getByRole('button', { name: 'How this was calculated for Laptop' });
    await user.click(toggle);
    const group = await screen.findByRole('group', { name: 'How Laptop was calculated' });
    await within(group).findByText('Steps, in order');
    expect(group).toHaveTextContent('Data version 1');
    expect(group).toHaveTextContent('Laptop saved amount: ₹400');
    expect(group).toHaveTextContent('Result: ₹600');
    expect(Array.from(group.querySelectorAll('.clarity-subheading')).map((heading) => heading.textContent)).toEqual([
      'Values you entered', 'Steps, in order', 'Rounding and precision', 'Result',
    ]);

    const gate = net.hold('GET', EXPLANATION);
    await openContribution(user, 'Laptop', '100');
    await user.click(saveContribution('Laptop'));
    await waitFor(() => expect(valueOf(goalCard('Laptop'), 'Funding gap')).toHaveTextContent('₹500'));

    // The new confirmed outcome is on screen. The explanation is still the old one, marked as updating, and still open.
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(group).toHaveTextContent('Updating to the latest confirmed data…'));
    expect(group).toHaveTextContent('Data version 1');
    expect(group).toHaveTextContent('Laptop saved amount: ₹400');
    expect(screen.getByRole('group', { name: 'How Laptop was calculated' })).toBe(group);

    await act(async () => {
      gate.release();
    });
    await waitFor(() => expect(group).toHaveTextContent('Data version 2'));
    expect(group).toHaveTextContent('Laptop saved amount: ₹500');
    expect(group).toHaveTextContent('Result: ₹500');
    expect(group).not.toHaveTextContent('Updating to the latest confirmed data…');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('group', { name: 'How Laptop was calculated' })).toBe(group);
    expect(net.to('GET', EXPLANATION)).toHaveLength(2);
    expect(net.to('GET', EXPLANATION).map((call) => call.query.get('version'))).toEqual(['1', String(backend.dataVersion)]);
    expect(reload).not.toHaveBeenCalled();
  });

  it('updates the open explanation when a goal becomes funded, ending with the funded gap of zero', async () => {
    const user = userEvent.setup();
    setup({ goals: [LAPTOP] });
    await loaded('Laptop');
    await user.click(screen.getByRole('button', { name: 'How this was calculated for Laptop' }));
    const group = await screen.findByRole('group', { name: 'How Laptop was calculated' });
    await within(group).findByText('Steps, in order');
    await contribute(user, 'Laptop', '600');

    await waitFor(() => expect(group).toHaveTextContent('Data version 2'));
    expect(group).toHaveTextContent('Laptop saved amount: ₹1,000');
    expect(group).toHaveTextContent('Result: ₹0');
    expect(screen.getByRole('button', { name: 'How this was calculated for Laptop' })).toHaveAttribute('aria-expanded', 'true');
  });
});

describe('Home beside Goals on one backend', () => {
  /** Overdue goals come first, then the earliest date, the larger gap, and the name. */
  const URGENCY: GoalInit[] = [
    { id: 1, name: 'Zeta', target: 5000, saved: 0, date: NEXT_MONTH_DATE },
    { id: 2, name: 'Alpha', target: 5000, saved: 0, date: NEXT_MONTH_DATE },
    { id: 3, name: 'Big', target: 9000, saved: 0, date: NEXT_MONTH_DATE },
    { id: 4, name: 'Early', target: 100, saved: 0, date: `${MONTH}-20` },
    { id: 5, name: 'Overdue one', target: 50, saved: 0, date: OVERDUE_DATE },
    { id: 6, name: 'Funded and past', target: 100, saved: 100, date: `${MONTH}-02` },
  ];

  const homeNow = (name: string) => screen.getByRole('article', { name: `Urgent goal: ${name}` });

  it('moves Home’s urgent goal in place as contributions are recorded on Goals: overdue, earliest date, larger gap, then name', async () => {
    const user = userEvent.setup();
    const { net } = setup({ goals: URGENCY }, { home: true });
    await screen.findByRole('article', { name: 'Urgent goal: Overdue one' });
    await loaded('Zeta');
    const marker = document.body.appendChild(document.createElement('i'));
    // An overdue goal wins over every dated goal, and a funded goal never counts.
    expect(homeNow('Overdue one')).toHaveTextContent('Overdue.');
    expect(homeNow('Overdue one')).toHaveTextContent('₹50');

    await contribute(user, 'Overdue one', '50');
    await screen.findByRole('article', { name: 'Urgent goal: Early' });
    expect(screen.queryByRole('article', { name: 'Urgent goal: Overdue one' })).toBeNull();
    expect(homeNow('Early')).not.toHaveTextContent('Overdue.');

    // The earliest date wins over a larger gap.
    await contribute(user, 'Early', '100');
    await screen.findByRole('article', { name: 'Urgent goal: Big' });

    // On a shared date the larger gap wins. A partial contribution changes Home's card in place.
    const big = homeNow('Big');
    expect(big).toHaveTextContent('₹9,000');
    await contribute(user, 'Big', '1000');
    await waitFor(() => expect(homeNow('Big')).toHaveTextContent('₹8,000'));
    expect(homeNow('Big')).toBe(big);

    // At an equal gap the name decides: Alpha, then Big, then Zeta.
    await contribute(user, 'Big', '3000');
    await screen.findByRole('article', { name: 'Urgent goal: Alpha' });
    expect(homeNow('Alpha')).toHaveTextContent('₹5,000');
    await contribute(user, 'Alpha', '5000');
    await screen.findByRole('article', { name: 'Urgent goal: Big' });
    await contribute(user, 'Big', '5000');
    await screen.findByRole('article', { name: 'Urgent goal: Zeta' });
    await contribute(user, 'Zeta', '5000');
    await waitFor(() => expect(screen.queryByRole('article', { name: /^Urgent goal:/ })).toBeNull());
    expect(screen.getByText('No goal needs a contribution right now.')).toBeInTheDocument();

    // Every step came from a confirmed response: one snapshot read, one list read, no reload.
    expect(net.to('GET', '/finance/clarity')).toHaveLength(1);
    expect(net.to('GET', '/finance/goals')).toHaveLength(1);
    expect(marker.isConnected).toBe(true);
    expect(reload).not.toHaveBeenCalled();
    marker.remove();
  });

  it('updates Home’s urgent goal from the confirmed response only, not while the contribution is pending', async () => {
    const user = userEvent.setup();
    const { net } = setup({ goals: PAIR }, { home: true });
    await screen.findByRole('article', { name: 'Urgent goal: Bravo' });
    await loaded('Alpha');
    // Same date, so the larger gap (Bravo) is first.
    const home = homeNow('Bravo');
    const gate = net.hold('POST', '/finance/goals/2/contributions');
    await openContribution(user, 'Bravo', '1500');
    click(saveContribution('Bravo'));
    expect(statusOf('goal:2')).toHaveTextContent('pending');
    expect(homeNow('Bravo')).toBe(home);
    expect(home).toHaveTextContent('₹2,000');

    await act(async () => {
      gate.release();
    });
    // Bravo's gap is now 500, below Alpha's 1,000.
    await screen.findByRole('article', { name: 'Urgent goal: Alpha' });
    expect(homeNow('Alpha')).toHaveTextContent('₹1,000');
    expect(screen.queryByRole('article', { name: 'Urgent goal: Bravo' })).toBeNull();
  });

  it('leaves Home exactly as it was when a contribution fails', async () => {
    const user = userEvent.setup();
    const { backend, net } = setup({ goals: PAIR }, { home: true });
    await screen.findByRole('article', { name: 'Urgent goal: Bravo' });
    await loaded('Alpha');
    const home = homeNow('Bravo');
    const homeText = text(home);
    backend.failNext('POST', '/finance/goals/2/contributions', 500, 'SERVER_ERROR', 'The contribution could not be saved.');
    await contribute(user, 'Bravo', '1500');

    await waitFor(() => expect(statusOf('goal:2')).toHaveTextContent('Add contribution to Bravo: failed.'));
    expect(homeNow('Bravo')).toBe(home);
    expect(text(home)).toBe(homeText);
    expect(valueOf(goalCard('Bravo'), 'Funding gap')).toHaveTextContent('₹2,000');
    expect(net.to('GET', '/finance/clarity')).toHaveLength(1);

    // The retry then moves Home.
    await user.click(within(statusOf('goal:2')).getByRole('button', { name: 'Retry Add contribution to Bravo' }));
    await screen.findByRole('article', { name: 'Urgent goal: Alpha' });
  });

  it('shows a server rejection on Goals and leaves Home on the last confirmed goal', async () => {
    const user = userEvent.setup();
    setup({ goals: PAIR }, { home: true });
    await screen.findByRole('article', { name: 'Urgent goal: Bravo' });
    await loaded('Alpha');
    const home = homeNow('Bravo');
    await contribute(user, 'Bravo', '2000.01');

    await within(contributionForm('Bravo')).findByText(/Contribution:/);
    expect(contributionForm('Bravo')).toHaveTextContent('Enter an amount from ₹0.01 to ₹2,000.');
    expect(homeNow('Bravo')).toBe(home);
    expect(home).toHaveTextContent('₹2,000');
  });
});

describe('focus and keyboard', () => {
  it('opens, saves, and returns focus with the keyboard, and keeps focus on the field when the server rejects the amount', async () => {
    const user = userEvent.setup();
    setup({ goals: [LAPTOP] });
    await loaded('Laptop');
    const opener = addButton('Laptop');
    opener.focus();
    await user.keyboard('{Enter}');
    expect(contributionInput('Laptop')).toHaveFocus();
    await user.keyboard('700{Enter}');

    await within(contributionForm('Laptop')).findByText(/Contribution:/);
    expect(contributionInput('Laptop')).toHaveValue('700');
    expect(contributionInput('Laptop').getAttribute('aria-describedby')).toContain(
      within(contributionForm('Laptop')).getByText(/Contribution:/).parentElement?.id,
    );

    await user.clear(contributionInput('Laptop'));
    await user.keyboard('25{Enter}');
    await waitFor(() => expect(statusOf('goal:1')).toHaveTextContent('Add contribution to Laptop: done'));
    expect(screen.queryByRole('form', { name: 'Add a contribution to Laptop' })).toBeNull();
    expect(addButton('Laptop')).toHaveFocus();
  });

  it('leaves focus where the user moved it while a contribution was pending', async () => {
    const user = userEvent.setup();
    const { net } = setup({ goals: PAIR });
    await loaded('Alpha');
    const gate = net.hold('POST', '/finance/goals/1/contributions');
    await openContribution(user, 'Alpha', '100');
    click(saveContribution('Alpha'));
    expect(statusOf('goal:1')).toHaveTextContent('pending');

    // The user goes on to another goal while the first saves.
    await user.click(addButton('Bravo'));
    expect(contributionInput('Bravo')).toHaveFocus();
    await user.type(contributionInput('Bravo'), '55');

    await act(async () => {
      gate.release();
    });
    await waitFor(() => expect(statusOf('goal:1')).toHaveTextContent('Add contribution to Alpha: done'));
    expect(contributionInput('Bravo')).toHaveFocus();
    expect(contributionInput('Bravo')).toHaveValue('55');
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

  it('shows a contribution as pending at submit, holds that for a slow server, then confirms everything within 100 ms of the response', async () => {
    const user = userEvent.setup();
    const { net } = setup({ goals: [LAPTOP, { id: 2, name: 'Phone', target: 500, saved: 0, date: NEXT_MONTH_DATE }] });
    await loaded('Laptop');
    await openContribution(user, 'Laptop', '100');
    controlClock();
    const gate = net.hold('POST', '/finance/goals/1/contributions');

    const submit = saveContribution('Laptop');
    submit.focus();
    click(submit);
    // Submit to feedback with no clock movement at all.
    expect(text(statusOf('goal:1'))).toContain('Add contribution to Laptop: pending');
    expect(text(goalCard('Laptop'))).toContain('Refreshing…');
    expect(await elapsedUntil(() => text(statusOf('goal:1')).includes('pending'))).toBeLessThanOrEqual(BUDGET_MS);
    expect(submit).toHaveFocus();
    // The goal's own controls wait for its answer; other goals stay usable.
    expect(editButton('Laptop')).toHaveAttribute('aria-disabled', 'true');
    expect(addButton('Phone')).not.toHaveAttribute('aria-disabled');
    expect(editButton('Phone')).not.toHaveAttribute('aria-disabled');

    // A slow server (30 s) does not time the feedback out, flicker it, or confirm anything early.
    await advance(30_000);
    expect(text(statusOf('goal:1'))).toContain('pending');
    expect(text(valueOf(goalCard('Laptop'), 'Funding gap'))).toContain('₹600');

    await act(async () => {
      gate.release();
    });
    const confirmed = await elapsedUntil(() => (
      text(statusOf('goal:1')).includes('Add contribution to Laptop: done')
      && text(valueOf(goalCard('Laptop'), 'Funding gap')).includes('₹500')
      && text(valueOf(goalCard('Laptop'), 'Saved so far')).includes('₹500')
      && !text(goalCard('Laptop')).includes('Refreshing…')
      && !screen.queryByRole('form', { name: 'Add a contribution to Laptop' })
    ));
    expect(confirmed).toBeLessThanOrEqual(BUDGET_MS);
    expect(reload).not.toHaveBeenCalled();
  });

  it('shows a failed contribution within 100 ms of the failed response, with the draft, the confirmed values, and a retry', async () => {
    const user = userEvent.setup();
    const { backend, net } = setup({ goals: [LAPTOP] });
    await loaded('Laptop');
    await openContribution(user, 'Laptop', '100');
    controlClock();
    backend.failNext('POST', '/finance/goals/1/contributions', 500, 'SERVER_ERROR', 'The contribution could not be saved.');
    const gate = net.hold('POST', '/finance/goals/1/contributions');

    click(saveContribution('Laptop'));
    expect(text(statusOf('goal:1'))).toContain('Add contribution to Laptop: pending');

    await act(async () => {
      gate.release();
    });
    const failed = await elapsedUntil(() => text(statusOf('goal:1')).includes('Add contribution to Laptop: failed.'));
    expect(failed).toBeLessThanOrEqual(BUDGET_MS);
    expect(text(statusOf('goal:1'))).toContain('The contribution could not be saved.');
    expect(within(statusOf('goal:1')).getByRole('button', { name: 'Retry Add contribution to Laptop' })).toBeInTheDocument();
    expect(contributionInput('Laptop')).toHaveValue('100');
    expect(text(valueOf(goalCard('Laptop'), 'Funding gap'))).toContain('₹600');
    expect(text(goalCard('Laptop'))).not.toContain('Refreshing…');
  });

  it('shows the server’s range within 100 ms of a rejected contribution, and no failure', async () => {
    const user = userEvent.setup();
    const { net } = setup({ goals: [LAPTOP] });
    await loaded('Laptop');
    await openContribution(user, 'Laptop', '600.01');
    controlClock();
    const gate = net.hold('POST', '/finance/goals/1/contributions');

    click(saveContribution('Laptop'));
    expect(text(statusOf('goal:1'))).toContain('pending');
    await act(async () => {
      gate.release();
    });
    const shown = await elapsedUntil(() => text(contributionForm('Laptop')).includes('Enter an amount from ₹0.01 to ₹600.'));
    expect(shown).toBeLessThanOrEqual(BUDGET_MS);
    expect(text(statusOf('goal:1'))).not.toMatch(/failed|pending/);
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

  it('has no violations with feasible, funded, overdue, not-feasible, and legacy-invalid goals together', async () => {
    await withTheme(async () => {
      const { container } = setup({
        goals: [
          { id: 1, name: 'Feasible', target: 3000, saved: 0, date: NEXT_MONTH_DATE },
          { id: 2, name: 'Funded', target: 100, saved: 100, date: NEXT_MONTH_DATE },
          { id: 3, name: 'Overdue', target: 300, saved: 100, date: OVERDUE_DATE },
          { id: 4, name: 'Stretch', target: 100000, saved: 0, date: NEXT_MONTH_DATE },
          { id: 5, name: 'Overfunded', target: 100, saved: 500, date: NEXT_MONTH_DATE },
          { id: 6, name: 'Undated', target: 5000, saved: 100, date: null },
        ],
      });
      await loaded('Stretch');
      expect(goalCard('Overdue')).toHaveAttribute('data-status', 'available');
      expect(goalCard('Undated')).toHaveAttribute('data-status', 'invalid_input');
      expect(await axe(container)).toHaveNoViolations();
    });
  });

  it('has no violations when the monthly pay is missing', async () => {
    await withTheme(async () => {
      const { container } = setup({ goals: [LAPTOP], savingsTarget: null });
      await loaded('Laptop');
      expect(feasibility('Laptop')).toHaveAttribute('data-feasibility', 'unavailable');
      expect(await axe(container)).toHaveNoViolations();
    });
  });

  it('has no violations with a pending contribution, a rejected amount, and a failed contribution', async () => {
    await withTheme(async () => {
      const user = userEvent.setup();
      const { backend, net, container } = setup({ goals: PAIR });
      await loaded('Alpha');
      backend.failNext('POST', '/finance/goals/1/contributions', 500, 'SERVER_ERROR', 'The contribution could not be saved.');
      await contribute(user, 'Alpha', '100');
      await waitFor(() => expect(statusOf('goal:1')).toHaveTextContent('failed.'));
      await user.click(editButton('Bravo'));
      expect(await axe(container)).toHaveNoViolations();

      await user.click(addButton('Bravo'));
      fireEvent.change(contributionInput('Bravo'), { target: { value: '2000.01' } });
      await user.click(saveContribution('Bravo'));
      await within(contributionForm('Bravo')).findByText(/Contribution:/);
      expect(await axe(container)).toHaveNoViolations();

      net.hold('POST', '/finance/goals/2/contributions');
      fireEvent.change(contributionInput('Bravo'), { target: { value: '5' } });
      click(saveContribution('Bravo'));
      expect(statusOf('goal:2')).toHaveTextContent('pending');
      expect(await axe(container)).toHaveNoViolations();
    });
  });
});

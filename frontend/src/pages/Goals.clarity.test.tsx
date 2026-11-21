import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FinancialSnapshot } from '../clarity/contracts';
import { DataUseGateProvider } from '../clarity/DataUseGateProvider';
import { FinancialClarityProvider } from '../clarity/FinancialClarityProvider';
import { MutationStatusProvider } from '../clarity/MutationStatusProvider';
import { DATA_USE_REASON_ID, DataUseGate } from '../components/clarity';
import { currentMonth, monthLabel } from '../money';
import { deferred } from '../test/clarity-fixtures';
import { buildSettings } from '../test/dataUseFixtures';
import { goalEnvelope, goalRow, goalSnapshot, rupees, type GoalFixture } from '../test/goalFixtures';
import { axe, createApiResponse, createTestQueryClient, renderAuthenticated } from '../test/test-utils';
import { Goals } from './Goals';

const MONTH = currentMonth();
const MONTH_NAME = monthLabel(MONTH);
const FUTURE = `${new Date().getFullYear() + 1}-12-31`;
/** The server's current local date in these snapshots is the 15th of the month. */
const BEFORE_TODAY = `${MONTH}-14`;
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
const failure = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) =>
  createApiResponse({ status, body: { error: { code, message, ...extra } } });

function renderGoals(options: { gate?: boolean; route?: string } = {}) {
  const page = options.gate
    ? (
      <DataUseGateProvider enabled>
        <DataUseGate />
        <Goals />
      </DataUseGateProvider>
    )
    : <Goals />;
  return renderAuthenticated(
    <FinancialClarityProvider>
      <MutationStatusProvider>{page}</MutationStatusProvider>
    </FinancialClarityProvider>,
    { route: options.route ?? '/goals', queryClient: createTestQueryClient() },
  );
}

const rowOf = (id: number) => document.getElementById(`goal-${id}`) as HTMLElement;
const statusOf = (scope: string) => document.querySelector(`[data-scope="${scope}"]`) as HTMLElement;
const outcomeCard = async (name: string) => screen.findByRole('article', { name });
const valueOf = (card: HTMLElement, label: string) => within(card).getByText(label).closest('.clarity-value') as HTMLElement;
const button = (name: string) => screen.getByRole('button', { name });

const EMERGENCY = goalRow(7, 'Emergency fund', 100000, 40000, FUTURE);
const LAPTOP = goalRow(8, 'Laptop', 80000, 10000, FUTURE);
const record = (id: number, name: string, target: number, saved: number, date: string | null = FUTURE) => ({
  id,
  name,
  targetAmountMinor: paise(target),
  savedAmountMinor: paise(saved),
  targetDate: date,
});

function baseRoutes(goals = [EMERGENCY], fixtures: GoalFixture[] = [{ id: 7 }]) {
  return {
    'GET /finance/clarity': read(goalSnapshot(MONTH, fixtures)),
    'GET /finance/goals': { goals },
  };
}

beforeEach(() => {
  vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'true');
});

describe('flag off', () => {
  it('renders and behaves as the original Goals page, with no clarity requests', async () => {
    vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'false');
    const user = userEvent.setup();
    const api = mockApi({
      'GET /finance/goals': { goals: [EMERGENCY] },
      'PATCH /finance/goals/7': { ok: true },
    });
    renderGoals();
    await screen.findByText('Emergency fund');
    expect(screen.getByRole('heading', { level: 2, name: /Savings goals/ })).toBeInTheDocument();
    expect(document.querySelector('.clarity-decision-header')).toBeNull();
    expect(screen.getByText(/Negative contributions let you record withdrawals too/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '+ Add' }));
    const input = screen.getByPlaceholderText('e.g. 500 or -200 to withdraw');
    await user.type(input, '500');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.to('PATCH', '/finance/goals/7')).toHaveLength(1));
    const [patch] = api.to('PATCH', '/finance/goals/7');
    expect(patch?.body).toEqual({ addToSaved: 500 });
    expect(patch?.headers['Idempotency-Key']).toBeUndefined();
    expect(patch?.headers['X-Clarity-Contract']).toBeUndefined();
    expect(api.to('GET', '/finance/clarity')).toHaveLength(0);
  });
});

describe('canonical goal outcomes', () => {
  it('shows funded, active, and overdue goals with the server values and no recomputation', async () => {
    mockApi(baseRoutes(
      [EMERGENCY, goalRow(8, 'Done goal', 5000, 5000, FUTURE), goalRow(9, 'Late goal', 30000, 10000, `${MONTH}-02`)],
      [
        { id: 7 },
        {
          id: 8,
          value: {
            status: 'funded',
            fundingGap: rupees(0),
            requiredContribution: rupees(0),
            feasibility: 'funded',
            capacityDifference: null,
          },
        },
        {
          id: 9,
          value: {
            status: 'overdue',
            fundingGap: rupees(20000),
            contributionOpportunities: 0,
            requiredContribution: null,
            feasibility: 'overdue',
            capacityDifference: null,
            revisionRequest: { fields: ['targetAmountMinor', 'targetDate'], action: 'revise_target_amount_or_date' },
          },
        },
      ],
    ));
    renderGoals();

    const active = await outcomeCard('Emergency fund');
    expect(valueOf(active, 'Goal status')).toHaveTextContent('Active');
    expect(valueOf(active, 'Funding gap')).toHaveTextContent('₹60,000');
    expect(valueOf(active, 'Funding gap')).toHaveTextContent('Calculated result');
    expect(valueOf(active, 'Monthly contribution opportunities')).toHaveTextContent('6');
    expect(valueOf(active, 'Required monthly contribution')).toHaveTextContent('₹10,000');
    expect(valueOf(active, 'Target amount')).toHaveTextContent('₹1,00,000');
    expect(valueOf(active, 'Target amount')).toHaveTextContent('Entered fact');
    const feasible = within(active).getByRole('group', { name: 'Feasibility for Emergency fund' });
    expect(feasible).toHaveTextContent('Feasible.');
    expect(feasible).toHaveTextContent('Remaining monthly savings capacity: ₹6,000');

    const funded = await outcomeCard('Done goal');
    expect(valueOf(funded, 'Goal status')).toHaveTextContent('Funded');
    expect(valueOf(funded, 'Funding gap')).toHaveTextContent('₹0');
    expect(valueOf(funded, 'Required monthly contribution')).toHaveTextContent('₹0');
    expect(within(funded).getByRole('group', { name: 'Feasibility for Done goal' })).toHaveTextContent('Fully funded');
    // A funded goal accepts no contribution.
    expect(screen.queryByRole('button', { name: 'Add contribution to Done goal' })).toBeNull();

    const overdue = await outcomeCard('Late goal');
    expect(valueOf(overdue, 'Goal status')).toHaveTextContent('Overdue');
    expect(valueOf(overdue, 'Funding gap')).toHaveTextContent('₹20,000');
    expect(valueOf(overdue, 'Required monthly contribution')).toHaveTextContent('Unavailable');
    expect(within(overdue).getByRole('group', { name: 'Feasibility for Late goal' })).toHaveTextContent('Target date passed');
    expect(within(overdue).getByRole('group', { name: 'Revision needed for Late goal' })).toHaveTextContent('Revise this goal.');
    expect(screen.getByRole('button', { name: 'Add contribution to Late goal' })).toBeInTheDocument();
  });

  it('names the minimum missing monthly-plan input inside the feasibility region only', async () => {
    mockApi(baseRoutes(
      [EMERGENCY, LAPTOP],
      [
        { id: 7, value: { feasibility: 'unavailable', capacityDifference: null, missingPlanInput: 'salary' } },
        { id: 8, value: { feasibility: 'unavailable', capacityDifference: null, missingPlanInput: 'bills' } },
      ],
    ));
    renderGoals();
    const salary = await outcomeCard('Emergency fund');
    const region = within(salary).getByRole('group', { name: 'Feasibility for Emergency fund' });
    expect(region).toHaveTextContent(`Feasibility unavailable. Add your monthly pay for ${MONTH_NAME}`);
    expect(within(region).getByRole('link', { name: /Add this month’s pay/ })).toHaveAttribute('href', '/plan#pay-form');
    // The funding gap and required contribution still show; the missing input is named nowhere else.
    expect(valueOf(salary, 'Funding gap')).toHaveTextContent('₹60,000');
    expect(valueOf(salary, 'Required monthly contribution')).toHaveTextContent('₹10,000');
    expect(within(salary).queryAllByText(/Add your monthly pay/)).toHaveLength(1);

    const bills = await outcomeCard('Laptop');
    const billsRegion = within(bills).getByRole('group', { name: 'Feasibility for Laptop' });
    expect(billsRegion).toHaveTextContent(`Add your monthly bills for ${MONTH_NAME}`);
    expect(within(billsRegion).getByRole('link', { name: /Add your monthly bills/ })).toHaveAttribute('href', '/plan#bills-form');
  });

  it('shows the difference and one revision, and accepting it sends the server target and shows the recomputed result', async () => {
    const user = userEvent.setup();
    const pending = deferred<Response>();
    const infeasible: GoalFixture = {
      id: 7,
      value: {
        feasibility: 'not_feasible',
        requiredContribution: rupees(15000),
        capacityDifference: rupees(5000),
        revision: { targetAmount: rupees(70000) },
      },
    };
    const confirmed = goalSnapshot(MONTH, [{ id: 7, value: { fundingGap: rupees(30000), requiredContribution: rupees(5000), capacityDifference: rupees(5000) } }], { dataVersion: 2 });
    const api = mockApi({
      ...baseRoutes([EMERGENCY], [infeasible]),
      'PATCH /finance/goals/7': () => pending.promise,
    });
    renderGoals();
    const card = await outcomeCard('Emergency fund');
    const region = within(card).getByRole('group', { name: 'Feasibility for Emergency fund' });
    expect(region).toHaveTextContent('Not feasible yet.');
    expect(region).toHaveTextContent('Over your savings target by: ₹5,000 a month');
    const revision = within(card).getByRole('group', { name: 'Suggested revision for Emergency fund' });
    expect(revision).toHaveTextContent('Revised target amount: ₹70,000');
    expect(revision).toHaveTextContent('Recommendation');
    expect(revision).toHaveTextContent('Informational guidance, not a guaranteed financial result.');
    expect(screen.getAllByRole('button', { name: /Accept revision/ })).toHaveLength(1);

    act(() => {
      fireEvent.click(button('Accept revision for Emergency fund'));
    });
    // Pending is acknowledged before the request settles, and the last confirmed values stay.
    expect(statusOf('goal:7')).toHaveTextContent('Accept revised target for Emergency fund: pending');
    expect(card).toHaveTextContent('Refreshing…');
    expect(valueOf(card, 'Funding gap')).toHaveTextContent('₹60,000');
    const [patch] = api.to('PATCH', '/finance/goals/7');
    expect(patch?.body).toEqual({ targetAmountMinor: paise(70000) });
    expect(patch?.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(patch?.headers['X-Clarity-Contract']).toBe('1');

    await act(async () => {
      pending.resolve(okResponse(goalEnvelope(confirmed, {
        operation: 'goal.update',
        goalId: 7,
        recordVersion: 2,
        record: record(7, 'Emergency fund', 70000, 40000),
      })));
    });
    await waitFor(() => expect(valueOf(card, 'Funding gap')).toHaveTextContent('₹30,000'));
    expect(within(card).getByRole('group', { name: 'Feasibility for Emergency fund' })).toHaveTextContent('Feasible.');
    expect(within(card).queryByRole('group', { name: 'Suggested revision for Emergency fund' })).toBeNull();
    expect(valueOf(card, 'Target amount')).toHaveTextContent('₹70,000');
    expect(statusOf('goal:7')).toHaveTextContent('Accept revised target for Emergency fund: done');
  });

  it('says so when no revised target fits, and offers the target date instead of inventing a value', async () => {
    mockApi(baseRoutes([EMERGENCY], [{
      id: 7,
      value: { feasibility: 'not_feasible', requiredContribution: rupees(15000), capacityDifference: rupees(5000) },
    }]));
    renderGoals();
    const card = await outcomeCard('Emergency fund');
    expect(within(card).getByRole('group', { name: 'Revision for Emergency fund' })).toHaveTextContent('No revised target amount fits');
    expect(screen.queryByRole('button', { name: /Accept revision/ })).toBeNull();
  });

  it('opens an explanation for the goal and closes it from the keyboard', async () => {
    const user = userEvent.setup();
    const outcomeId = 'goal:7';
    const api = mockApi({
      ...baseRoutes(),
      [`GET /finance/explanations/${encodeURIComponent(outcomeId)}`]: {
        schemaVersion: 1,
        explanation: {
          schemaVersion: 1,
          outcomeId,
          kind: 'goal',
          status: 'available',
          classification: 'calculated_result',
          dataVersion: 1,
          period: goalSnapshot(MONTH, [{ id: 7 }]).outcomes.goals[0]?.period,
          currency: 'INR',
          precisionMinor: 1,
          sourceRefs: [],
          operations: [],
          rounding: { precisionMinor: 1, direction: 'up', adjustmentMinor: 0 },
        },
      },
    });
    renderGoals();
    const card = await outcomeCard('Emergency fund');
    const toggle = within(card).getByRole('button', { name: 'How this was calculated for Emergency fund' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(await within(card).findByText('Steps, in order')).toBeInTheDocument();
    expect(api.to('GET', `/finance/explanations/${encodeURIComponent(outcomeId)}`)).toHaveLength(1);
    await user.keyboard('{Escape}');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveFocus();
  });
});

describe('legacy-invalid goals', () => {
  const undated: GoalFixture = {
    id: 9,
    outcome: {
      status: 'invalid_input',
      value: undefined,
      invalid: [{ input: 'goal:9.targetDate', constraint: 'a valid YYYY-MM-DD calendar date', affects: ['goal'] }],
    },
  };
  const overfunded: GoalFixture = {
    id: 10,
    outcome: {
      status: 'invalid_input',
      value: undefined,
      invalid: [{ input: 'goal:10.savedAmountMinor', constraint: 'from 0 through 5000000 paise, inclusive', affects: ['goal'] }],
    },
  };

  it('prompts for a correction instead of rewriting, then sends only the corrected field', async () => {
    const user = userEvent.setup();
    const confirmed = goalSnapshot(MONTH, [
      { id: 9 },
      overfunded,
    ], { dataVersion: 2 });
    const api = mockApi({
      ...baseRoutes(
        [goalRow(9, 'No date goal', 50000, 1000, null), goalRow(10, 'Overfunded goal', 50000, 60000, FUTURE)],
        [undated, overfunded],
      ),
      'PATCH /finance/goals/9': () => okResponse(goalEnvelope(confirmed, {
        operation: 'goal.update',
        goalId: 9,
        recordVersion: 2,
        record: record(9, 'No date goal', 50000, 1000, FUTURE),
      })),
    });
    renderGoals();

    const undatedCard = await outcomeCard('No date goal');
    expect(undatedCard).toHaveAttribute('data-status', 'invalid_input');
    expect(undatedCard).toHaveTextContent('This goal has no valid target date. Choose a target date on or after');
    const overCard = await outcomeCard('Overfunded goal');
    expect(overCard).toHaveTextContent('The saved amount is above the target amount.');
    // Nothing was rewritten, and an invalid goal accepts no contribution until it is corrected.
    expect(api.to('PATCH', '/finance/goals/9')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /Add contribution to (No date|Overfunded) goal/ })).toBeNull();

    await user.click(within(undatedCard).getByRole('button', { name: 'Correct this goal: No date goal' }));
    const dateInput = within(rowOf(9)).getByLabelText('Target date');
    expect(dateInput).toHaveFocus();
    fireEvent.change(dateInput, { target: { value: FUTURE } });
    await user.click(within(rowOf(9)).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.to('PATCH', '/finance/goals/9')).toHaveLength(1));
    const [patch] = api.to('PATCH', '/finance/goals/9');
    expect(patch?.body).toEqual({ targetDate: FUTURE });
    await waitFor(() => expect(screen.getByRole('article', { name: 'No date goal' })).toHaveAttribute('data-status', 'available'));
    // The other invalid goal is still only a prompt.
    expect(screen.getByRole('article', { name: 'Overfunded goal' })).toHaveAttribute('data-status', 'invalid_input');
    expect(within(rowOf(9)).getByRole('button', { name: 'Edit No date goal' })).toHaveFocus();
  });
});

describe('create a goal', () => {
  const fill = (values: { name?: string; target?: string; saved?: string; date?: string }) => {
    const form = screen.getByRole('form', { name: 'Add a goal' });
    if (values.name !== undefined) fireEvent.change(within(form).getByRole('textbox', { name: 'Goal name' }), { target: { value: values.name } });
    if (values.target !== undefined) fireEvent.change(within(form).getByRole('textbox', { name: 'Target amount' }), { target: { value: values.target } });
    if (values.saved !== undefined) fireEvent.change(within(form).getByRole('textbox', { name: /Saved so far/ }), { target: { value: values.saved } });
    if (values.date !== undefined) fireEvent.change(within(form).getByLabelText('Target date'), { target: { value: values.date } });
    return form;
  };

  it('names the field and the accepted bound for every value outside the bounds and sends nothing', async () => {
    const user = userEvent.setup();
    const api = mockApi(baseRoutes());
    renderGoals();
    await outcomeCard('Emergency fund');
    const form = fill({});
    await user.click(within(form).getByRole('button', { name: 'Add goal' }));
    expect(within(form).getByText(/Goal name:/).parentElement).toHaveTextContent('must have between 1 and 60 characters.');
    expect(within(form).getByText(/Target amount:/).parentElement).toHaveTextContent('must be an amount above 0.');
    expect(within(form).getByText(/Target date:/).parentElement).toHaveTextContent('is required.');
    fill({ name: 'Trip', target: '1000', saved: '2000', date: BEFORE_TODAY });
    await user.click(within(form).getByRole('button', { name: 'Add goal' }));
    expect(within(form).getByText(/Saved so far:/).parentElement).toHaveTextContent('is more than the target amount. Enter an amount from ₹0 up to ₹1,000');
    expect(within(form).getByText(/Target date:/).parentElement).toHaveTextContent('is before today.');
    expect(within(form).getByRole('textbox', { name: /Saved so far/ })).toHaveAttribute('aria-invalid', 'true');
    expect(api.to('POST', '/finance/goals')).toHaveLength(0);
  });

  it('acknowledges at once, keeps the draft on failure, retries with the same key, and clears when saved', async () => {
    const user = userEvent.setup();
    const first = deferred<Response>();
    const retried = deferred<Response>();
    const confirmed = goalSnapshot(MONTH, [{ id: 7 }, { id: 11, value: { fundingGap: rupees(50000), requiredContribution: rupees(5000) } }], { dataVersion: 2 });
    const api = mockApi({
      ...baseRoutes(),
      'POST /finance/goals': (_call, attempt) => (attempt === 1 ? first.promise : retried.promise),
    });
    renderGoals();
    await outcomeCard('Emergency fund');
    const form = fill({ name: 'Trip fund', target: '50,000', date: FUTURE });
    act(() => {
      fireEvent.click(within(form).getByRole('button', { name: 'Add goal' }));
    });
    expect(statusOf('new-goal:form')).toHaveTextContent('Add goal: pending');
    const [post] = api.to('POST', '/finance/goals');
    expect(post?.body).toEqual({ name: 'Trip fund', targetAmountMinor: paise(50000), savedAmountMinor: 0, targetDate: FUTURE });
    expect(post?.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(post?.headers['X-Clarity-Contract']).toBe('1');
    // Other goals stay usable while this one saves.
    expect(screen.getByRole('button', { name: 'Edit Emergency fund' })).not.toHaveAttribute('aria-disabled');

    await act(async () => {
      first.resolve(failure(500, 'SERVER_ERROR', 'The goal could not be saved.'));
    });
    await waitFor(() => expect(statusOf('new-goal:form')).toHaveTextContent('Add goal: failed.'));
    expect(within(form).getByRole('textbox', { name: 'Goal name' })).toHaveValue('Trip fund');
    expect(within(form).getByRole('textbox', { name: 'Target amount' })).toHaveValue('50,000');
    expect(within(form).getByLabelText('Target date')).toHaveValue(FUTURE);
    expect(screen.getByRole('article', { name: 'Emergency fund' })).toHaveAttribute('data-status', 'available');

    await user.click(within(statusOf('new-goal:form')).getByRole('button', { name: 'Retry Add goal' }));
    expect(statusOf('new-goal:form')).toHaveTextContent('Add goal: pending');
    const posts = api.to('POST', '/finance/goals');
    expect(posts).toHaveLength(2);
    expect(posts[1]?.headers['Idempotency-Key']).toBe(posts[0]?.headers['Idempotency-Key']);
    expect(posts[1]?.body).toEqual(posts[0]?.body);

    await act(async () => {
      retried.resolve(okResponse(goalEnvelope(confirmed, {
        operation: 'goal.create',
        goalId: 11,
        record: record(11, 'Trip fund', 50000, 0),
      })));
    });
    expect(await screen.findByRole('article', { name: 'Trip fund' })).toBeInTheDocument();
    await waitFor(() => expect(within(form).getByRole('textbox', { name: 'Goal name' })).toHaveValue(''));
    expect(statusOf('new-goal:form')).toHaveTextContent('Add goal: done');
    // The list was read once; the new goal came from the confirmed response.
    expect(api.to('GET', '/finance/goals')).toHaveLength(1);
  });
});

describe('contribute to a goal', () => {
  it('shows the server range as a hint, saves a bounded contribution once, and updates from the confirmed response', async () => {
    const user = userEvent.setup();
    const pending = deferred<Response>();
    const confirmed = goalSnapshot(MONTH, [{
      id: 7,
      value: { fundingGap: rupees(59500), requiredContribution: rupees(9917), capacityDifference: rupees(6083) },
    }], { dataVersion: 2 });
    const api = mockApi({
      ...baseRoutes(),
      'POST /finance/goals/7/contributions': () => pending.promise,
    });
    renderGoals();
    const card = await outcomeCard('Emergency fund');
    await user.click(button('Add contribution to Emergency fund'));
    const form = screen.getByRole('form', { name: 'Add a contribution to Emergency fund' });
    const input = within(form).getByRole('textbox', { name: 'Contribution amount' });
    expect(input).toHaveFocus();
    expect(form).toHaveTextContent('Accepted range: ₹0.01 to ₹60,000');
    fireEvent.change(input, { target: { value: '500' } });
    act(() => {
      fireEvent.click(within(form).getByRole('button', { name: 'Save contribution' }));
    });
    expect(statusOf('goal:7')).toHaveTextContent('Add contribution to Emergency fund: pending');
    expect(card).toHaveTextContent('Refreshing…');
    expect(valueOf(card, 'Funding gap')).toHaveTextContent('₹60,000');
    const [post] = api.to('POST', '/finance/goals/7/contributions');
    expect(post?.body).toEqual({ contributionMinor: paise(500) });
    expect(post?.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(post?.headers['X-Clarity-Contract']).toBe('1');

    await act(async () => {
      pending.resolve(okResponse(goalEnvelope(confirmed, {
        operation: 'goal.contribute',
        goalId: 7,
        recordVersion: 2,
        record: record(7, 'Emergency fund', 100000, 40500),
      })));
    });
    await waitFor(() => expect(valueOf(card, 'Funding gap')).toHaveTextContent('₹59,500'));
    expect(valueOf(card, 'Required monthly contribution')).toHaveTextContent('₹9,917');
    expect(valueOf(card, 'Saved so far')).toHaveTextContent('₹40,500');
    expect(screen.queryByRole('form', { name: 'Add a contribution to Emergency fund' })).toBeNull();
    expect(button('Add contribution to Emergency fund')).toHaveFocus();
    expect(statusOf('goal:7')).toHaveTextContent('Add contribution to Emergency fund: done');
    expect(api.to('POST', '/finance/goals/7/contributions')).toHaveLength(1);
  });

  it('shows the server range when a contribution is outside it, keeps the draft, and leaves the goal as it was', async () => {
    const user = userEvent.setup();
    const api = mockApi({
      ...baseRoutes(),
      'POST /finance/goals/7/contributions': () => failure(
        422,
        'GOAL_CONTRIBUTION_OUT_OF_RANGE',
        'Contribution must be between 1 and 6000000 paise.',
        { field: 'contributionMinor', constraint: { minMinor: 1, maxMinor: paise(60000), integer: true } },
      ),
    });
    renderGoals();
    const card = await outcomeCard('Emergency fund');
    await user.click(button('Add contribution to Emergency fund'));
    const form = screen.getByRole('form', { name: 'Add a contribution to Emergency fund' });
    const input = within(form).getByRole('textbox', { name: 'Contribution amount' });
    fireEvent.change(input, { target: { value: '70000' } });
    await user.click(within(form).getByRole('button', { name: 'Save contribution' }));

    const error = await within(form).findByText(/Contribution:/);
    expect(error.parentElement).toHaveTextContent('is outside the accepted range. Enter an amount from ₹0.01 to ₹60,000.');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveValue('70000');
    expect(input.getAttribute('aria-describedby')).toContain(error.parentElement?.id);
    // It is a rejected value, not a failed change: no retry is offered and nothing was applied.
    expect(statusOf('goal:7')).not.toHaveTextContent(/failed|pending|done/);
    expect(within(statusOf('goal:7')).queryByRole('button', { name: /Retry/ })).toBeNull();
    expect(valueOf(card, 'Funding gap')).toHaveTextContent('₹60,000');
    // A stale range triggers a quiet re-read of the confirmed snapshot.
    await waitFor(() => expect(api.to('GET', '/finance/clarity').length).toBeGreaterThanOrEqual(2));
  });

  it('rejects text that is not an amount without sending it, including negative amounts', async () => {
    const user = userEvent.setup();
    const api = mockApi(baseRoutes());
    renderGoals();
    await outcomeCard('Emergency fund');
    await user.click(button('Add contribution to Emergency fund'));
    const form = screen.getByRole('form', { name: 'Add a contribution to Emergency fund' });
    fireEvent.change(within(form).getByRole('textbox', { name: 'Contribution amount' }), { target: { value: '-200' } });
    await user.click(within(form).getByRole('button', { name: 'Save contribution' }));
    expect(await within(form).findByText(/Contribution:/)).toBeInTheDocument();
    expect(form).toHaveTextContent('Negative amounts are not accepted');
    expect(api.to('POST', '/finance/goals/7/contributions')).toHaveLength(0);
  });

  it('keeps each goal in its own scope: one fails and retries with the same key while another stays usable', async () => {
    const user = userEvent.setup();
    const retried = deferred<Response>();
    const other = deferred<Response>();
    const confirmed = goalSnapshot(MONTH, [
      { id: 7, value: { fundingGap: rupees(59900), requiredContribution: rupees(9984), capacityDifference: rupees(6016) } },
      { id: 8 },
    ], { dataVersion: 2 });
    const api = mockApi({
      ...baseRoutes([EMERGENCY, LAPTOP], [{ id: 7 }, { id: 8, value: { fundingGap: rupees(70000) } }]),
      'POST /finance/goals/7/contributions': (_call, attempt) => (
        attempt === 1 ? failure(500, 'SERVER_ERROR', 'The contribution could not be saved.') : retried.promise
      ),
      'PATCH /finance/goals/8': () => other.promise,
    });
    renderGoals();
    const emergency = await outcomeCard('Emergency fund');
    const laptop = await outcomeCard('Laptop');
    await user.click(button('Add contribution to Emergency fund'));
    const form = screen.getByRole('form', { name: 'Add a contribution to Emergency fund' });
    fireEvent.change(within(form).getByRole('textbox', { name: 'Contribution amount' }), { target: { value: '100' } });
    await user.click(within(form).getByRole('button', { name: 'Save contribution' }));
    await waitFor(() => expect(statusOf('goal:7')).toHaveTextContent('Add contribution to Emergency fund: failed.'));
    // Rolled back: the confirmed values stay and the draft is still in the form.
    expect(valueOf(emergency, 'Funding gap')).toHaveTextContent('₹60,000');
    expect(within(form).getByRole('textbox', { name: 'Contribution amount' })).toHaveValue('100');
    expect(statusOf('goal:8')).not.toHaveTextContent(/pending|failed|done/);

    // The other goal changes independently.
    await user.click(button('Edit Laptop'));
    const edit = screen.getByRole('form', { name: 'Correct Laptop' });
    fireEvent.change(within(edit).getByRole('textbox', { name: 'Goal name' }), { target: { value: 'Work laptop' } });
    await user.click(within(edit).getByRole('button', { name: 'Save changes' }));
    expect(statusOf('goal:8')).toHaveTextContent('Save Laptop: pending');
    expect(statusOf('goal:7')).toHaveTextContent('failed');

    await user.click(within(statusOf('goal:7')).getByRole('button', { name: 'Retry Add contribution to Emergency fund' }));
    expect(statusOf('goal:7')).toHaveTextContent('Add contribution to Emergency fund: pending');
    const posts = api.to('POST', '/finance/goals/7/contributions');
    expect(posts).toHaveLength(2);
    expect(posts[1]?.headers['Idempotency-Key']).toBe(posts[0]?.headers['Idempotency-Key']);
    expect(posts[1]?.body).toEqual(posts[0]?.body);
    expect(posts[0]?.body).toEqual({ contributionMinor: paise(100) });
    await act(async () => {
      retried.resolve(okResponse(goalEnvelope(confirmed, {
        operation: 'goal.contribute',
        goalId: 7,
        recordVersion: 2,
        record: record(7, 'Emergency fund', 100000, 40100),
      })));
    });
    // The retry finishes like the first attempt: the form closes and the confirmed values show.
    await waitFor(() => expect(valueOf(emergency, 'Funding gap')).toHaveTextContent('₹59,900'));
    expect(screen.queryByRole('form', { name: 'Add a contribution to Emergency fund' })).toBeNull();
    expect(statusOf('goal:8')).toHaveTextContent('Save Laptop: pending');
    expect(laptop).toBeInTheDocument();
    other.resolve(failure(500, 'SERVER_ERROR', 'x'));
  });
});

describe('correct and delete', () => {
  it('keeps an edited draft on failure and sends only the changed fields on retry with the same key', async () => {
    const user = userEvent.setup();
    const retried = deferred<Response>();
    const confirmed = goalSnapshot(MONTH, [{ id: 7, value: { fundingGap: rupees(80000), requiredContribution: rupees(13334), capacityDifference: rupees(2666) } }], { dataVersion: 2 });
    const api = mockApi({
      ...baseRoutes(),
      'PATCH /finance/goals/7': (_call, attempt) => (
        attempt === 1 ? failure(500, 'SERVER_ERROR', 'The goal could not be saved.') : retried.promise
      ),
    });
    renderGoals();
    await outcomeCard('Emergency fund');
    await user.click(button('Edit Emergency fund'));
    const form = screen.getByRole('form', { name: 'Correct Emergency fund' });
    expect(within(form).getByRole('textbox', { name: 'Goal name' })).toHaveValue('Emergency fund');
    expect(within(form).getByRole('textbox', { name: 'Target amount' })).toHaveValue('100000');
    fireEvent.change(within(form).getByRole('textbox', { name: 'Target amount' }), { target: { value: '120000' } });
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(statusOf('goal:7')).toHaveTextContent('Save Emergency fund: failed.'));
    expect(screen.getByRole('form', { name: 'Correct Emergency fund' })).toBe(form);
    expect(within(form).getByRole('textbox', { name: 'Target amount' })).toHaveValue('120000');

    await user.click(within(statusOf('goal:7')).getByRole('button', { name: 'Retry Save Emergency fund' }));
    const patches = api.to('PATCH', '/finance/goals/7');
    expect(patches).toHaveLength(2);
    expect(patches[0]?.body).toEqual({ targetAmountMinor: paise(120000) });
    expect(patches[1]?.body).toEqual(patches[0]?.body);
    expect(patches[1]?.headers['Idempotency-Key']).toBe(patches[0]?.headers['Idempotency-Key']);
    await act(async () => {
      retried.resolve(okResponse(goalEnvelope(confirmed, {
        operation: 'goal.update',
        goalId: 7,
        recordVersion: 2,
        record: record(7, 'Emergency fund', 120000, 40000),
      })));
    });
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Correct Emergency fund' })).toBeNull());
    expect(valueOf(screen.getByRole('article', { name: 'Emergency fund' }), 'Funding gap')).toHaveTextContent('₹80,000');
    expect(button('Edit Emergency fund')).toHaveFocus();
  });

  it('deletes after an inline confirmation, keeps the goal and offers a retry on failure, and removes it once confirmed', async () => {
    const user = userEvent.setup();
    const confirmed = goalSnapshot(MONTH, [{ id: 8 }], { dataVersion: 2 });
    const api = mockApi({
      ...baseRoutes([EMERGENCY, LAPTOP], [{ id: 7 }, { id: 8 }]),
      'DELETE /finance/goals/7': (_call, attempt) => (
        attempt === 1
          ? failure(500, 'SERVER_ERROR', 'The goal could not be deleted.')
          : okResponse(goalEnvelope(confirmed, { operation: 'goal.delete', goalId: 7, recordVersion: 2, record: null }))
      ),
    });
    renderGoals();
    await outcomeCard('Emergency fund');
    await user.click(button('Delete Emergency fund'));
    const confirm = screen.getByRole('group', { name: 'Delete Emergency fund' });
    expect(within(confirm).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.click(within(confirm).getByRole('button', { name: 'Delete goal' }));
    await waitFor(() => expect(statusOf('goal:7')).toHaveTextContent('Delete Emergency fund: failed.'));
    expect(rowOf(7)).toBeInTheDocument();
    expect(rowOf(8)).toBeInTheDocument();
    await user.click(within(statusOf('goal:7')).getByRole('button', { name: 'Retry Delete Emergency fund' }));
    await waitFor(() => expect(rowOf(7)).toBeNull());
    const deletes = api.to('DELETE', '/finance/goals/7');
    expect(deletes).toHaveLength(2);
    expect(deletes[1]?.headers['Idempotency-Key']).toBe(deletes[0]?.headers['Idempotency-Key']);
    expect(deletes[0]?.headers['X-Clarity-Contract']).toBe('1');
    expect(rowOf(8)).toBeInTheDocument();
    // Focus lands on the list heading, not on the page.
    expect(screen.getByRole('heading', { name: 'Your goals' })).toHaveFocus();
  });
});

describe('action context', () => {
  it('opens the contribution form for the goal named by the link and focuses it', async () => {
    mockApi(baseRoutes([EMERGENCY, LAPTOP], [{ id: 7 }, { id: 8 }]));
    renderGoals({ route: '/goals?action=contribute&goalId=8' });
    const input = await screen.findByRole('textbox', { name: 'Contribution amount' });
    await waitFor(() => expect(input).toHaveFocus());
    expect(rowOf(8)).toContainElement(input);
    expect(screen.getAllByRole('form', { name: /Add a contribution/ })).toHaveLength(1);
  });

  it('opens the revision form for an invalid goal named by the link, on the field that needs correcting', async () => {
    mockApi(baseRoutes([goalRow(9, 'No date goal', 50000, 1000, null)], [{
      id: 9,
      outcome: {
        status: 'invalid_input',
        value: undefined,
        invalid: [{ input: 'goal:9.targetDate', constraint: 'a valid YYYY-MM-DD calendar date', affects: ['goal'] }],
      },
    }]));
    renderGoals({ route: '/goals?action=revise&goalId=9' });
    const form = await screen.findByRole('form', { name: 'Correct No date goal' });
    await waitFor(() => expect(within(form).getByLabelText('Target date')).toHaveFocus());
  });

  it('does not open a form for a goal that cannot take the action, and leaves focus on the goal', async () => {
    mockApi(baseRoutes([goalRow(8, 'Done goal', 5000, 5000, FUTURE)], [{
      id: 8,
      value: { status: 'funded', fundingGap: rupees(0), requiredContribution: rupees(0), feasibility: 'funded', capacityDifference: null },
    }]));
    renderGoals({ route: '/goals?action=contribute&goalId=8' });
    await outcomeCard('Done goal');
    await waitFor(() => expect(rowOf(8)).toHaveFocus());
    expect(screen.queryByRole('form', { name: /Add a contribution/ })).toBeNull();
  });
});

describe('data-use gate', () => {
  it('pauses only new goals and contributions, with a reason, and never corrections or deletes', async () => {
    mockApi({
      'GET /clarity/settings': buildSettings(),
      ...baseRoutes(),
    });
    renderGoals({ gate: true });
    await outcomeCard('Emergency fund');
    await waitFor(() => expect(document.getElementById(DATA_USE_REASON_ID)).toBeInTheDocument());
    expect(document.getElementById(DATA_USE_REASON_ID)).toHaveTextContent(/acknowledge the data-use notice/i);
    const create = screen.getByRole('button', { name: 'Add goal' });
    expect(create).toBeDisabled();
    expect(create).toHaveAttribute('aria-describedby', DATA_USE_REASON_ID);
    expect(screen.getByRole('textbox', { name: 'Goal name' }).getAttribute('aria-describedby')).toContain(DATA_USE_REASON_ID);
    const contribute = button('Add contribution to Emergency fund');
    expect(contribute).toBeDisabled();
    expect(contribute).toHaveAttribute('aria-describedby', DATA_USE_REASON_ID);
    expect(button('Edit Emergency fund')).not.toBeDisabled();
    expect(button('Delete Emergency fund')).not.toBeDisabled();
  });
});

describe('accessibility', () => {
  it.each(['light', 'dark'] as const)('has no axe violations with every goal state in the %s theme', async (theme) => {
    document.documentElement.dataset.theme = theme;
    try {
      const user = userEvent.setup();
      mockApi(baseRoutes(
        [EMERGENCY, LAPTOP, goalRow(9, 'No date goal', 50000, 1000, null)],
        [
          { id: 7 },
          {
            id: 8,
            value: {
              feasibility: 'not_feasible',
              requiredContribution: rupees(15000),
              capacityDifference: rupees(5000),
              revision: { targetAmount: rupees(70000) },
            },
          },
          {
            id: 9,
            outcome: {
              status: 'invalid_input',
              value: undefined,
              invalid: [{ input: 'goal:9.targetDate', constraint: 'a valid YYYY-MM-DD calendar date', affects: ['goal'] }],
            },
          },
        ],
      ));
      const { container } = renderGoals();
      await outcomeCard('No date goal');
      await user.click(button('Add contribution to Emergency fund'));
      expect(screen.getByRole('form', { name: 'Add a contribution to Emergency fund' })).toBeInTheDocument();
      await user.click(button('Edit Laptop'));
      await user.click(button('Delete No date goal'));
      expect(await axe(container, { rules: { 'heading-order': { enabled: false } } })).toHaveNoViolations();
    } finally {
      delete document.documentElement.dataset.theme;
    }
  });
});

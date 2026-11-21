import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PAGE_DECISIONS } from '../clarity/actionContext';
import type { FinancialSnapshot, GoalOutcomeValue, Outcome, SpendingOutcomeValue } from '../clarity/contracts';
import { FinancialClarityProvider } from '../clarity/FinancialClarityProvider';
import { MutationStatusProvider } from '../clarity/MutationStatusProvider';
import { queryKeys } from '../clarity/queryClient';
import { correctiveActionFor, selectHomeSummary } from '../components/dashboard/homeSummary';
import { currentMonth, monthLabel } from '../money';
import {
  BILLS_ACTION,
  FULL_HIGHLIGHTS,
  GOAL_ACTION,
  NEEDS_ACTION,
  NO_HIGHLIGHTS,
  TRIP_ACTION,
  WANTS_ACTION,
  goalOutcome,
  homeSnapshot,
  insight,
  planOutcome,
  rupees,
  spendingOutcome,
} from '../test/homeSummaryFixtures';
import { axe, createApiResponse, createTestQueryClient, renderAuthenticated } from '../test/test-utils';
import type { Plan as PlanData } from '../types';
import { Dashboard } from './Dashboard';
import { Plan } from './Plan';

const MONTH = currentMonth();
const MONTH_NAME = monthLabel(MONTH);

const PLAN: PlanData = {
  income: 75000,
  emiTotal: 0,
  afterFixed: 75000,
  breakdown: { needs: 37500, wants: 22500, save: 15000 },
  tips: [],
  month: MONTH,
  spentThisMonth: 0,
};

const LEGACY_ROUTES: Record<string, unknown> = {
  '/finance/plan': PLAN,
  '/finance/emis': { emis: [] },
  '/finance/salary': { salary: { month: MONTH, amount: 75000 } },
};

type ClarityResponder = (callNumber: number) => Response | Promise<Response>;

const snapshotResponse = (snapshot: FinancialSnapshot) => createApiResponse({ body: { schemaVersion: 1, snapshot } });

/** Routes fetch by path. Returns the list of `METHOD /path` requests made so far. */
function mockApi(clarity: ClarityResponder, routes: Record<string, unknown> = {}): string[] {
  const calls: string[] = [];
  let clarityCalls = 0;
  vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
    const path = new URL(String(input), 'http://localhost').pathname.replace(/^\/api/, '');
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    if (path === '/finance/clarity') {
      clarityCalls += 1;
      return clarity(clarityCalls);
    }
    if (path in routes) return createApiResponse({ body: routes[path] });
    return createApiResponse({ status: 404, body: { error: 'Not found' } });
  });
  return calls;
}

const serve = (snapshot: FinancialSnapshot) => mockApi(() => snapshotResponse(snapshot));

function LocationProbe() {
  const location = useLocation();
  return <p data-testid="location">{`${location.pathname}${location.search}${location.hash}`}</p>;
}

function renderHome(options: { route?: string; queryClient?: ReturnType<typeof createTestQueryClient> } = {}) {
  const queryClient = options.queryClient ?? createTestQueryClient();
  const result = renderAuthenticated(
    <FinancialClarityProvider>
      <MutationStatusProvider>
        <LocationProbe />
        <Routes>
          <Route index element={<Dashboard />} />
          <Route path="plan" element={<Plan />} />
          <Route path="*" element={<p>Elsewhere</p>} />
        </Routes>
      </MutationStatusProvider>
    </FinancialClarityProvider>,
    { route: options.route ?? '/', queryClient },
  );
  return { ...result, queryClient };
}

function enableClarity() {
  vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'true');
}

const region = (name: string) => document.querySelector(`[data-region="${name}"]`) as HTMLElement;
const comesBefore = (first: Element, second: Element) =>
  Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);

const missingSalary = (outcomeId: string, kind: 'monthly_plan' | 'spending') => ({
  id: outcomeId,
  kind,
  status: 'missing_input' as const,
  value: undefined,
  missing: [{ input: 'salary', unlocks: ['monthly_plan', 'spending'] as Array<'monthly_plan' | 'spending'> }],
});

beforeEach(() => {
  enableClarity();
});

describe('Home Monthly Clarity Summary: personalized outcomes first', () => {
  it('shows each server value in its own region before any generic content', async () => {
    serve(homeSnapshot(MONTH, { actions: [GOAL_ACTION, TRIP_ACTION] }));
    const { container } = renderHome();

    const plan = await screen.findByRole('article', { name: /Remaining to spend/ });
    expect(within(plan).getByText('Remaining spendable')).toBeInTheDocument();
    expect(within(plan).getByText('₹54,000')).toBeInTheDocument();
    expect(within(plan).getByText('Daily spending guide')).toBeInTheDocument();
    expect(within(plan).getByText('₹3,176')).toBeInTheDocument();
    expect(within(plan).getByText(/17 calendar days left/)).toBeInTheDocument();

    const savings = screen.getByRole('article', { name: /Projected savings vs target/ });
    expect(within(savings).getByText('₹70,000')).toBeInTheDocument();
    expect(within(savings).getByText('₹16,000')).toBeInTheDocument();
    expect(within(savings).getByText('₹54,000 above target')).toBeInTheDocument();

    const goal = screen.getByRole('article', { name: /Urgent goal: Emergency fund/ });
    expect(within(goal).getByText('₹60,000')).toBeInTheDocument();
    expect(within(goal).getByText(/Fits within your savings target/)).toBeInTheDocument();

    const trip = screen.getByRole('article', { name: /Nearest trip settlement: Goa weekend/ });
    expect(within(trip).getByText('You are owed')).toBeInTheDocument();
    expect(within(trip).getByText('₹500')).toBeInTheDocument();

    // Every component is labelled as a calculated result or entered fact.
    expect(within(plan).getAllByText('Calculated result').length).toBeGreaterThanOrEqual(2);
    expect(within(goal).getByText('Entered fact')).toBeInTheDocument();

    // Order: header, then plan, spending, goal, trip, actions, and only then generic shortcuts.
    const header = container.querySelector('.clarity-decision-header')!;
    expect(within(header as HTMLElement).getByText(PAGE_DECISIONS.home)).toBeInTheDocument();
    const order = [header, region('monthly-plan'), region('spending'), region('goal'), region('trip'), region('actions'), screen.getByRole('navigation', { name: 'Quick actions' })];
    for (let i = 0; i < order.length - 1; i += 1) expect(comesBefore(order[i]!, order[i + 1]!)).toBe(true);
  });

  it('has no pay form, no sample plan, and makes no legacy calculation requests', async () => {
    const calls = serve(homeSnapshot(MONTH));
    renderHome();
    await screen.findByRole('article', { name: /Remaining to spend/ });

    expect(screen.queryByRole('textbox', { name: 'Monthly pay' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Show my real plan/ })).toBeNull();
    expect(screen.queryByText(/Sample month/)).toBeNull();
    expect(document.getElementById('home-pay-form')).toBeNull();
    expect(calls.filter((call) => /\/finance\/(plan|salary|emis)$/.test(call))).toEqual([]);
    expect(calls).toContain('GET /finance/clarity');
  });

  it('shows the goal and trip the server selected even when the three-action cap leaves them out', async () => {
    serve(homeSnapshot(MONTH, { actions: [BILLS_ACTION, NEEDS_ACTION, WANTS_ACTION] }));
    renderHome();

    expect(await screen.findByRole('article', { name: /Urgent goal: Emergency fund/ })).toBeInTheDocument();
    expect(screen.getByRole('article', { name: /Nearest trip settlement: Goa weekend/ })).toBeInTheDocument();
  });

  it('shows at most three ranked actions, in server order, with the guidance label', async () => {
    serve(homeSnapshot(MONTH, { actions: [GOAL_ACTION, TRIP_ACTION, BILLS_ACTION, NEEDS_ACTION, WANTS_ACTION] }));
    renderHome();
    await screen.findByRole('article', { name: /Remaining to spend/ });

    const items = within(region('actions')).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('The goal “Emergency fund” still has a funding gap.');
    expect(items[0]).toHaveTextContent('By 31 Dec 2026');
    expect(items[1]).toHaveTextContent('Goa weekend');
    expect(items[2]).toHaveTextContent('Current-month bills exceed salary.');
    expect(within(region('actions')).queryByText(/Needs spending exceeds/)).toBeNull();
    expect(within(region('actions')).getByText('Informational guidance, not a guaranteed financial result.')).toBeInTheDocument();
    expect(within(region('actions')).getByText('Recommendation')).toBeInTheDocument();
  });

  it('names the highest-ranked action in the header', async () => {
    serve(homeSnapshot(MONTH, { actions: [BILLS_ACTION, GOAL_ACTION] }));
    const { container } = renderHome();
    await screen.findByRole('article', { name: /Remaining to spend/ });

    const header = container.querySelector('.clarity-decision-header') as HTMLElement;
    const link = await within(header).findByRole('link', { name: /Review monthly bills/ });
    expect(link).toHaveAttribute('href', '/plan#bills-form');
  });
});

describe('missing, invalid, and calculation-failed regions stay isolated', () => {
  it('missing pay marks only the pay-dependent regions and routes to the Plan pay form', async () => {
    serve(homeSnapshot(MONTH, {
      actions: [],
      plan: missingSalary(`monthly-plan:${MONTH}`, 'monthly_plan'),
      spending: missingSalary(`spending:${MONTH}`, 'spending'),
    }));
    renderHome();

    const plan = await screen.findByRole('article', { name: /Remaining to spend/ });
    expect(plan).toHaveTextContent('Add salary to unlock your monthly plan and spending guidance.');
    expect(within(plan).getByText('Needs input')).toBeInTheDocument();
    const payLink = within(plan).getByRole('link', { name: /Add this month’s pay/ });
    expect(payLink).toHaveAttribute('href', '/plan#pay-form');

    const savings = screen.getByRole('article', { name: /Projected savings vs target/ });
    expect(within(savings).getByText('Needs input')).toBeInTheDocument();

    // Siblings are untouched.
    expect(screen.getByRole('article', { name: /Urgent goal: Emergency fund/ })).toHaveAttribute('data-status', 'available');
    expect(screen.getByRole('article', { name: /Nearest trip settlement/ })).toHaveAttribute('data-status', 'available');

    // The header action also goes to the Plan form, and no "no action" claim is made.
    const header = document.querySelector('.clarity-decision-header') as HTMLElement;
    expect(within(header).getByRole('link', { name: /Add this month’s pay/ })).toHaveAttribute('href', '/plan#pay-form');
    expect(screen.queryByText(/No action is needed/)).toBeNull();
  });

  it('an invalid input names the input, its constraint, and the affected outcome', async () => {
    serve(homeSnapshot(MONTH, {
      highlights: NO_HIGHLIGHTS,
      actions: [],
      plan: {
        status: 'invalid_input',
        value: undefined,
        invalid: [{ input: 'bill:4.amount', constraint: 'a value representable as a safe integer number of paise', affects: ['monthly_plan'] }],
      },
      goals: [goalOutcome(7, MONTH, 1)],
    }));
    renderHome();

    const plan = await screen.findByRole('article', { name: /Remaining to spend/ });
    expect(within(plan).getByText('Needs correction')).toBeInTheDocument();
    expect(plan).toHaveTextContent('must be: a value representable as a safe integer number of paise');
    expect(plan).toHaveTextContent('This affects your monthly plan.');
    expect(within(plan).getByRole('link', { name: /Correct your bills/ })).toHaveAttribute('href', '/plan#bills-form');
    // The spending region still renders its own confirmed value.
    const savings = screen.getByRole('article', { name: /Projected savings vs target/ });
    expect(within(savings).getByText('₹70,000')).toBeInTheDocument();
  });

  it('an invalid goal gets its own card and leaves plan, spending, and trip regions intact', async () => {
    const badGoal: Outcome<GoalOutcomeValue> = {
      ...goalOutcome(9, MONTH, 1),
      status: 'invalid_input',
      value: undefined,
      invalid: [{ input: 'goal:9.targetDate', constraint: 'a valid YYYY-MM-DD calendar date', affects: ['goal'] }],
    };
    serve(homeSnapshot(MONTH, {
      highlights: { urgentGoal: null, nearestTripSettlement: FULL_HIGHLIGHTS.nearestTripSettlement },
      goals: [badGoal],
    }));
    renderHome();

    const problem = await screen.findByRole('article', { name: /Goal needs attention/ });
    expect(problem).toHaveAttribute('data-status', 'invalid_input');
    expect(within(problem).getByRole('link', { name: /Correct this goal/ })).toHaveAttribute('href', '/goals?action=revise&goalId=9');
    expect(screen.queryByRole('article', { name: /Urgent goal/ })).toBeNull();
    expect(screen.getByRole('article', { name: /Remaining to spend/ })).toHaveAttribute('data-status', 'available');
    expect(screen.getByRole('article', { name: /Nearest trip settlement: Goa weekend/ })).toBeInTheDocument();
  });

  it('a failed calculation shows one retry, keeps entered values, and recalculates without new input', async () => {
    const failed: Partial<Outcome<SpendingOutcomeValue>> = {
      status: 'calculation_failed',
      value: undefined,
      sourceRefs: [{
        sourceType: 'salary',
        recordId: 1,
        field: 'amountMinor',
        label: 'Salary for this month',
        value: rupees(100000),
      }],
      retry: { action: 'recalculate', scopeKey: `outcome:spending:${MONTH}` },
    };
    const user = userEvent.setup();
    const calls = mockApi((n) => snapshotResponse(
      n === 1 ? homeSnapshot(MONTH, { spending: failed }) : homeSnapshot(MONTH),
    ));
    renderHome();

    const card = await screen.findByRole('article', { name: /Projected savings vs target/ });
    expect(card).toHaveAttribute('data-status', 'calculation_failed');
    expect(within(card).getByText('Temporarily unavailable.', { selector: 'strong' })).toBeInTheDocument();
    expect(card).toHaveTextContent('Salary for this month');
    expect(within(card).getAllByRole('button', { name: /Recalculate|Retry|Refresh/ })).toHaveLength(1);
    expect(screen.getByRole('article', { name: /Remaining to spend/ })).toHaveAttribute('data-status', 'available');
    expect(screen.getByRole('article', { name: /Urgent goal/ })).toHaveAttribute('data-status', 'available');

    await user.click(within(card).getByRole('button', { name: /Recalculate Projected savings vs target/ }));
    await waitFor(() => expect(screen.getByRole('article', { name: /Projected savings vs target/ })).toHaveAttribute('data-status', 'available'));
    expect(calls.filter((call) => call === 'GET /finance/clarity')).toHaveLength(2);
    // No input was requested and nothing was written.
    expect(calls.filter((call) => call.startsWith('POST') || call.startsWith('PUT') || call.startsWith('PATCH'))).toEqual([]);
  });

  it('a calculation failure in the trip summary leaves the plan and goal regions available', async () => {
    serve(homeSnapshot(MONTH, {
      highlights: { urgentGoal: FULL_HIGHLIGHTS.urgentGoal, nearestTripSettlement: null },
      actions: [],
      tripSummary: { status: 'calculation_failed', value: undefined, items: undefined },
    }));
    renderHome();

    const trip = await screen.findByRole('article', { name: /Nearest trip settlement/ });
    expect(trip).toHaveAttribute('data-status', 'calculation_failed');
    expect(screen.getByRole('article', { name: /Remaining to spend/ })).toHaveAttribute('data-status', 'available');
    expect(screen.getByRole('article', { name: /Urgent goal: Emergency fund/ })).toHaveAttribute('data-status', 'available');
  });
});

describe('explicit no-action state', () => {
  it('states that no action is needed only when every outcome is confirmed and no action applies', async () => {
    serve(homeSnapshot(MONTH, { actions: [], highlights: NO_HIGHLIGHTS, goals: [], trips: [] }));
    const { container } = renderHome();
    await screen.findByRole('article', { name: /Remaining to spend/ });

    const text = `No action is needed for ${MONTH_NAME}.`;
    expect(within(region('actions')).getByText(text)).toBeInTheDocument();
    expect(within(container.querySelector('.clarity-decision-header') as HTMLElement).getByText(text)).toBeInTheDocument();
    expect(within(region('actions')).queryByRole('listitem')).toBeNull();
  });

  it('does not claim no action while an outcome is unavailable', async () => {
    serve(homeSnapshot(MONTH, { actions: [], plan: missingSalary(`monthly-plan:${MONTH}`, 'monthly_plan') }));
    renderHome();
    await screen.findByRole('article', { name: /Remaining to spend/ });

    expect(screen.queryByText(/No action is needed/)).toBeNull();
    expect(within(region('actions')).getByText(/depends on the items above/)).toBeInTheDocument();
  });
});

describe('action routing', () => {
  it('rebuilds every action route from its fixed key and ignores the route the server sent', async () => {
    const hostile = { ...GOAL_ACTION, route: 'https://evil.example/steal?amount=9' };
    const unknown = insight('drop_everything', { observation: 'Unknown action.' });
    serve(homeSnapshot(MONTH, { actions: [hostile, unknown, TRIP_ACTION] }));
    renderHome();
    await screen.findByRole('article', { name: /Remaining to spend/ });

    const actions = region('actions');
    expect(within(actions).getByRole('link', { name: /Contribute to goal/ })).toHaveAttribute('href', '/goals?action=contribute&goalId=7');
    expect(within(actions).getByRole('link', { name: /Settle trip balance/ })).toHaveAttribute('href', '/trips/3?tab=balances&action=settle');
    expect(within(actions).queryByText('Unknown action.')).toBeNull();
    for (const link of screen.getAllByRole('link')) {
      expect(link.getAttribute('href') ?? '').not.toMatch(/evil|amount=|Emergency|Goa/);
    }
  });

  it('selecting an action opens the existing page with its record context', async () => {
    const user = userEvent.setup();
    serve(homeSnapshot(MONTH, { actions: [GOAL_ACTION] }));
    renderHome();
    await screen.findByRole('article', { name: /Remaining to spend/ });

    await user.click(within(region('actions')).getByRole('link', { name: /Contribute to goal/ }));
    expect(screen.getByTestId('location')).toHaveTextContent('/goals?action=contribute&goalId=7');
    expect(screen.getByText('Elsewhere')).toBeInTheDocument();
  });

  it('a missing-pay action opens the existing Plan pay form and focuses it', async () => {
    const user = userEvent.setup();
    mockApi(() => snapshotResponse(homeSnapshot(MONTH, {
      actions: [],
      plan: missingSalary(`monthly-plan:${MONTH}`, 'monthly_plan'),
      spending: missingSalary(`spending:${MONTH}`, 'spending'),
    })), LEGACY_ROUTES);
    renderHome();

    const plan = await screen.findByRole('article', { name: /Remaining to spend/ });
    await user.click(within(plan).getByRole('link', { name: /Add this month’s pay/ }));

    expect(screen.getByTestId('location')).toHaveTextContent('/plan#pay-form');
    await screen.findByRole('textbox', { name: 'Monthly pay' });
    await waitFor(() => expect(document.getElementById('pay-form')).toHaveFocus());
  });

  it('an old ?action=set-pay link goes to the Plan pay form instead of a Home form', async () => {
    mockApi(() => snapshotResponse(homeSnapshot(MONTH)), LEGACY_ROUTES);
    renderHome({ route: '/?action=set-pay' });

    await screen.findByRole('textbox', { name: 'Monthly pay' });
    expect(screen.getByTestId('location')).toHaveTextContent('/plan#pay-form');
  });
});

describe('rollout flag off keeps the legacy Home', () => {
  const DEMO_ROUTES = {
    ...LEGACY_ROUTES,
    '/finance/plan': { ...PLAN, income: 0, afterFixed: 0, breakdown: { needs: 0, wants: 0, save: 0 } },
    '/finance/salary': { salary: null },
  };

  beforeEach(() => {
    vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', '');
  });

  it('loads the legacy plan, never the clarity snapshot, and renders the legacy header', async () => {
    const calls = mockApi(() => createApiResponse({ status: 500, body: { error: 'must not be called' } }), LEGACY_ROUTES);
    const { container } = renderHome();

    await screen.findByText(/Your money this month/);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/Hey Test/);
    expect(screen.getByText(/where your money is going/)).toBeInTheDocument();
    expect(container.querySelector('.clarity-decision-header')).toBeNull();
    expect(container.querySelector('[data-testid="monthly-clarity-summary"]')).toBeNull();
    expect(calls).toEqual(expect.arrayContaining(['GET /finance/plan', 'GET /finance/emis', 'GET /finance/salary']));
    expect(calls).not.toContain('GET /finance/clarity');
  });

  it('keeps the salary form working in sample mode', async () => {
    const user = userEvent.setup();
    const calls = mockApi(() => createApiResponse({ status: 500, body: {} }), DEMO_ROUTES);
    renderHome();

    const pay = await screen.findByRole('textbox', { name: 'Monthly pay' });
    expect(screen.getByText(/Make it yours in one number/)).toBeInTheDocument();
    await user.type(pay, '75000');
    await user.click(screen.getByRole('button', { name: /Show my real plan/ }));
    await waitFor(() => expect(calls).toContain('POST /finance/salary'));
    expect(calls).not.toContain('GET /finance/clarity');
  });

  it('the same data with the flag on has no salary form on Home', async () => {
    vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'true');
    const calls = mockApi(() => snapshotResponse(homeSnapshot(MONTH, {
      plan: missingSalary(`monthly-plan:${MONTH}`, 'monthly_plan'),
      spending: missingSalary(`spending:${MONTH}`, 'spending'),
    })), DEMO_ROUTES);
    renderHome();

    await screen.findByRole('article', { name: /Remaining to spend/ });
    expect(screen.queryByRole('textbox', { name: 'Monthly pay' })).toBeNull();
    expect(calls).not.toContain('GET /finance/plan');
  });
});

describe('loading, refresh, and failure', () => {
  it('shows a stable skeleton for the summary while the header and shortcuts stay available', async () => {
    let release!: (response: Response) => void;
    mockApi(() => new Promise<Response>((resolve) => { release = resolve; }));
    const { container } = renderHome();
    await waitFor(() => expect(release).toBeDefined());

    const summary = await screen.findByRole('group', { name: 'Monthly summary' });
    expect(summary).toHaveAttribute('aria-busy', 'true');
    expect(container.querySelector('.clarity-decision-header')).not.toBeNull();
    expect(screen.getByRole('navigation', { name: 'Quick actions' })).toBeInTheDocument();
    expect(screen.queryByRole('article', { name: /Remaining to spend/ })).toBeNull();

    await act(async () => {
      release(snapshotResponse(homeSnapshot(MONTH)));
    });
    expect(await screen.findByRole('article', { name: /Remaining to spend/ })).toBeInTheDocument();
  });

  it('an initial failure is contained in the summary region with one retry', async () => {
    const user = userEvent.setup();
    mockApi((n) => (n === 1
      ? createApiResponse({ status: 403, body: { error: { code: 'FORBIDDEN', message: 'Not allowed right now.' } } })
      : snapshotResponse(homeSnapshot(MONTH))));
    const { container } = renderHome();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Monthly summary could not load.');
    expect(container.querySelector('.clarity-decision-header')).not.toBeNull();
    expect(screen.getByRole('navigation', { name: 'Quick actions' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry loading Monthly summary' }));
    expect(await screen.findByRole('article', { name: /Remaining to spend/ })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps confirmed values while refreshing, after a failed refresh, and replaces them on success', async () => {
    const user = userEvent.setup();
    let release!: (response: Response) => void;
    mockApi((n) => {
      if (n === 1) return new Promise<Response>((resolve) => { release = resolve; });
      if (n === 2) return createApiResponse({ status: 403, body: { error: { code: 'FORBIDDEN', message: 'Try later.' } } });
      return snapshotResponse(homeSnapshot(MONTH, {
        dataVersion: 3,
        plan: { value: { ...planOutcome(MONTH, 3).value!, remainingSpendable: rupees(50000) } },
      }));
    });
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(queryKeys.clarity(MONTH), homeSnapshot(MONTH, { dataVersion: 2 }));
    renderHome({ queryClient });

    const plan = await screen.findByRole('article', { name: /Remaining to spend/ });
    expect(within(plan).getByText('₹54,000')).toBeInTheDocument();

    // Refreshing: confirmed values stay, with text naming the region.
    let refetch!: Promise<unknown>;
    act(() => {
      refetch = queryClient.refetchQueries({ queryKey: queryKeys.clarity(MONTH) });
    });
    expect(await screen.findByText('Refreshing Monthly summary…')).toBeInTheDocument();
    expect(screen.getByRole('article', { name: /Remaining to spend/ })).toHaveTextContent('₹54,000');

    // Failed refresh: still the last confirmed values, a failure label, and a scoped retry.
    await act(async () => {
      release(createApiResponse({ status: 403, body: { error: { code: 'FORBIDDEN', message: 'Not allowed right now.' } } }));
      await refetch;
    });
    const note = await screen.findByText('Refresh failed.');
    expect(note.closest('[role="status"]')).toHaveTextContent('Showing the last confirmed values for Monthly summary');
    expect(screen.getByRole('article', { name: /Remaining to spend/ })).toHaveTextContent('₹54,000');
    expect(screen.getByRole('article', { name: /Urgent goal/ })).toBeInTheDocument();

    // The second attempt fails too and still keeps the values, then the third succeeds.
    await user.click(screen.getByRole('button', { name: 'Retry loading Monthly summary' }));
    await screen.findByText('Refresh failed.');
    expect(screen.getByRole('article', { name: /Remaining to spend/ })).toHaveTextContent('₹54,000');

    await user.click(screen.getByRole('button', { name: 'Retry loading Monthly summary' }));
    await waitFor(() => expect(screen.getByRole('article', { name: /Remaining to spend/ })).toHaveTextContent('₹50,000'));
    expect(screen.queryByText('Refresh failed.')).toBeNull();
    expect(screen.queryByText(/Refreshing Monthly summary/)).toBeNull();
  });

  it('never replaces a newer confirmed snapshot with an older response', async () => {
    mockApi(() => snapshotResponse(homeSnapshot(MONTH, {
      dataVersion: 1,
      plan: { value: { ...planOutcome(MONTH, 1).value!, remainingSpendable: rupees(1000) } },
    })));
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(queryKeys.clarity(MONTH), homeSnapshot(MONTH, { dataVersion: 5 }));
    renderHome({ queryClient });
    await screen.findByRole('article', { name: /Remaining to spend/ });

    await act(async () => {
      await queryClient.refetchQueries({ queryKey: queryKeys.clarity(MONTH) });
    });
    expect(screen.getByRole('article', { name: /Remaining to spend/ })).toHaveTextContent('₹54,000');
    expect((queryClient.getQueryData(queryKeys.clarity(MONTH)) as FinancialSnapshot).dataVersion).toBe(5);
  });
});

describe('selectors', () => {
  it('caps actions at three and drops insights whose key is not registered', () => {
    const model = selectHomeSummary(homeSnapshot(MONTH, {
      actions: [insight('nope'), GOAL_ACTION, TRIP_ACTION, BILLS_ACTION, NEEDS_ACTION],
    }));
    expect(model.actions.map(({ actionKey }) => actionKey)).toEqual(['contribute_to_goal', 'settle_trip_balance', 'review_bills']);
    expect(model.noActionNeeded).toBe(false);
  });

  it('maps the missing and invalid inputs to existing forms from fixed routes', () => {
    const outcome = (status: 'missing_input' | 'invalid_input', input: string): Outcome<unknown> => ({
      ...spendingOutcome(MONTH, 1),
      status,
      value: undefined,
      missing: status === 'missing_input' ? [{ input, unlocks: ['spending'] }] : undefined,
      invalid: status === 'invalid_input' ? [{ input, constraint: 'x', affects: ['spending'] }] : undefined,
    });
    expect(correctiveActionFor(outcome('missing_input', 'salary'))?.to).toBe('/plan#pay-form');
    expect(correctiveActionFor(outcome('invalid_input', 'salary:3.amount'))?.to).toBe('/plan#pay-form');
    expect(correctiveActionFor(outcome('missing_input', 'bills'))?.to).toBe('/plan#bills-form');
    expect(correctiveActionFor(outcome('invalid_input', 'expense:12.amount'))?.to).toBe('/spending?action=correct-expense&expenseId=12');
    expect(correctiveActionFor(outcome('invalid_input', 'trip:3.split'))?.to).toBe('/trips/3?tab=expenses');
    expect(correctiveActionFor(outcome('missing_input', 'something_else'))).toBeNull();
    expect(correctiveActionFor(spendingOutcome(MONTH, 1))).toBeNull();
  });
});

describe.each(['light', 'dark'] as const)('accessibility in the %s theme', (theme) => {
  async function expectNoViolations(snapshot: FinancialSnapshot) {
    document.documentElement.dataset.theme = theme;
    try {
      serve(snapshot);
      const { container } = renderHome();
      await screen.findByRole('article', { name: /Remaining to spend/ });
      expect(await axe(container.querySelector('[data-testid="monthly-clarity-summary"]') as HTMLElement)).toHaveNoViolations();
      expect(await axe(container.querySelector('.clarity-decision-header') as HTMLElement)).toHaveNoViolations();
      // Existing shortcuts and cards keep the heading-order gap owned by their own migrations.
      expect(await axe(container, { rules: { 'heading-order': { enabled: false } } })).toHaveNoViolations();
    } finally {
      delete document.documentElement.dataset.theme;
    }
  }

  it('has no violations with every region available', async () => {
    await expectNoViolations(homeSnapshot(MONTH, { actions: [GOAL_ACTION, TRIP_ACTION, BILLS_ACTION] }));
  });

  it('has no violations with missing, failed, and no-action states', async () => {
    await expectNoViolations(homeSnapshot(MONTH, {
      actions: [],
      highlights: NO_HIGHLIGHTS,
      plan: missingSalary(`monthly-plan:${MONTH}`, 'monthly_plan'),
      spending: { status: 'calculation_failed', value: undefined, retry: { action: 'recalculate', scopeKey: 'outcome:spending' } },
      goals: [],
      trips: [],
    }));
  });
});

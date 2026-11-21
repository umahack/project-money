import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PAGE_DECISIONS } from '../clarity/actionContext';
import type { ActionableInsight } from '../clarity/contracts';
import { FinancialClarityProvider } from '../clarity/FinancialClarityProvider';
import { MutationStatusProvider } from '../clarity/MutationStatusProvider';
import { ARRIVAL_FALLBACK_MS, focusActionTarget } from '../clarity/useActionArrival';
import { currentMonth } from '../money';
import { makeSnapshot } from '../test/clarity-fixtures';
import { homeSnapshot } from '../test/homeSummaryFixtures';
import { axe, createApiResponse, createTestQueryClient, renderAuthenticated } from '../test/test-utils';
import type { Plan as PlanData, TripDetailData } from '../types';
import { Dashboard } from './Dashboard';
import { Goals } from './Goals';
import { Plan } from './Plan';
import { Spending } from './Spending';
import { TripDetail } from './TripDetail';
import { Trips } from './Trips';

const MONTH = currentMonth();
const PLAN: PlanData = {
  income: 75000,
  emiTotal: 0,
  afterFixed: 75000,
  breakdown: { needs: 37500, wants: 22500, save: 15000 },
  tips: [],
  month: MONTH,
  spentThisMonth: 0,
};
const GOAL = {
  id: 5,
  name: 'Laptop upgrade',
  target_amount: 60000,
  saved_amount: 1000,
  target_date: null,
  created_at: '2026-01-01 00:00:00',
  updated_at: '2026-01-01 00:00:00',
};
const TRIP_DETAIL: TripDetailData = {
  trip: { id: 3, name: 'Goa weekend', destination: 'Goa', budget: 40000, start_date: null, end_date: null },
  role: 'owner',
  members: [
    { id: 1, name: 'Asha', email: null },
    { id: 2, name: 'Ravi', email: null },
  ],
  expenses: [],
  settlement: { balances: { Asha: 500, Ravi: -500 }, transactions: [{ from: 'Ravi', to: 'Asha', amount: 500 }] },
};

const API: Record<string, unknown> = {
  '/finance/clarity': { schemaVersion: 1, snapshot: homeSnapshot(MONTH) },
  '/finance/plan': PLAN,
  '/finance/emis': { emis: [] },
  '/finance/salary': { salary: { month: MONTH, amount: 75000 } },
  '/finance/expenses': { month: MONTH, categories: ['Food', 'Other'], expenses: [] },
  '/finance/budgets': { budgets: { Food: 3000 } },
  '/finance/goals': { goals: [GOAL] },
  '/trips': { trips: [TRIP_DETAIL.trip] },
  '/trips/3': TRIP_DETAIL,
};

function mockApi(overrides: Record<string, unknown> = {}) {
  const routes = { ...API, ...overrides };
  vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
    const path = new URL(String(input), 'http://localhost').pathname.replace(/^\/api/, '');
    if (path in routes) return createApiResponse({ body: routes[path] });
    return createApiResponse({ status: 404, body: { error: 'Not found' } });
  });
}

function AppRoutes() {
  return (
    <Routes>
      <Route index element={<Dashboard />} />
      <Route path="plan" element={<Plan />} />
      <Route path="spending" element={<Spending />} />
      <Route path="goals" element={<Goals />} />
      <Route path="trips" element={<Trips />} />
      <Route path="trips/:id" element={<TripDetail />} />
    </Routes>
  );
}

function renderApp(route: string, snapshotActions?: ActionableInsight[]) {
  const queryClient = createTestQueryClient();
  if (snapshotActions) {
    queryClient.setQueryData(['clarity', MONTH], { ...makeSnapshot(1, MONTH), actions: snapshotActions });
  }
  return renderAuthenticated(
    <FinancialClarityProvider>
      <MutationStatusProvider>
        <AppRoutes />
      </MutationStatusProvider>
    </FinancialClarityProvider>,
    { route, queryClient },
  );
}

function enableClarity() {
  vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'true');
}

/** Rules that fail on untouched legacy page content, not on this task's header or anchors. */
const LEGACY_CONTENT_RULES = {
  'aria-progressbar-name': { enabled: false },
  'heading-order': { enabled: false },
};

const comesBefore = (first: Element, second: Element) =>
  Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);

interface PageCase {
  name: string;
  route: string;
  decision: string;
  /** Text that appears only once the page content has loaded. */
  ready: string | RegExp;
  action: string;
  legacySub: string | RegExp;
  legacyTitle: string | RegExp;
}

const PAGES: PageCase[] = [
  {
    name: 'Home',
    route: '/',
    decision: PAGE_DECISIONS.home,
    // Legacy Home shows the first text, the Monthly Clarity Summary the second.
    ready: /Your money this month|Remaining to spend/,
    // The default snapshot's first ranked action; the legacy header is not asserted for its action.
    action: 'Contribute to goal',
    legacyTitle: /Hey Test/,
    legacySub: /where your money is going/,
  },
  {
    name: 'Plan',
    route: '/plan',
    decision: PAGE_DECISIONS.plan,
    ready: /Monthly pay/,
    action: 'Add your monthly bills',
    legacyTitle: /Your month, line by line/,
    legacySub: /mandatory payments/,
  },
  {
    name: 'Spending',
    route: '/spending',
    decision: PAGE_DECISIONS.spending,
    ready: /This month's spending/,
    action: 'Record or correct an expense',
    legacyTitle: /Spending/,
    legacySub: /Daily log, inline category budgets/,
  },
  {
    name: 'Goals',
    route: '/goals',
    decision: PAGE_DECISIONS.goals,
    ready: 'Laptop upgrade',
    // The Goals page now reads the snapshot, so its ranked goal action can replace the fixed fallback once it loads.
    action: 'Contribute to goal|Record a contribution or adjust a goal',
    legacyTitle: /Goals/,
    legacySub: /Set a target, add to it/,
  },
  {
    name: 'Trips',
    route: '/trips',
    decision: PAGE_DECISIONS.trips,
    ready: 'Goa weekend',
    // The Trips page now reads the snapshot, so its ranked settle action can replace the fixed fallback once it loads.
    action: 'Settle trip balance|Review trip balances',
    legacyTitle: /Trips & splits/,
    legacySub: /split costs like Splitwise/,
  },
  {
    name: 'Trip detail',
    route: '/trips/3',
    decision: PAGE_DECISIONS['trip-detail'],
    ready: /Add an expense/,
    // The trip page now reads the snapshot, so the ranked settle action can replace the fixed fallback once it loads.
    action: 'Settle trip balance|Record a settlement|Add a shared expense',
    legacyTitle: /Goa weekend/,
    legacySub: '',
  },
];

beforeEach(() => {
  mockApi();
});

describe.each(PAGES)('$name page header', (page) => {
  it('names the decision and highest relevant action before any form or card (rollout on)', async () => {
    enableClarity();
    const { container } = renderApp(page.route);
    await screen.findAllByText(page.ready);

    const header = container.querySelector('.clarity-decision-header');
    expect(header).not.toBeNull();
    const h1s = screen.getAllByRole('heading', { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(header).toContainElement(h1s[0]!);
    expect(within(header as HTMLElement).getByText(page.decision)).toBeInTheDocument();

    const link = within(header as HTMLElement).getByRole('link', { name: new RegExp(page.action) });
    const href = link.getAttribute('href')!;
    expect(href.startsWith('/')).toBe(true);
    expect(href).not.toMatch(/amount|name=|note=|email|75000|Goa weekend|Laptop|Asha|Ravi/);

    for (const control of container.querySelectorAll('form, input, select, .card')) {
      expect(comesBefore(header!, control)).toBe(true);
    }
  });

  it('keeps the legacy header and no decision header while the rollout is off', async () => {
    const { container } = renderApp(page.route);
    await screen.findAllByText(page.ready);

    expect(container.querySelector('.clarity-decision-header')).toBeNull();
    expect(screen.queryByText('Decision')).toBeNull();
    expect(screen.queryByText('Next action')).toBeNull();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(page.legacyTitle);
    if (page.name !== 'Trip detail') {
      expect(container.querySelector('.page-title')).not.toBeNull();
      expect(screen.getByText(page.legacySub)).toBeInTheDocument();
    } else {
      expect(container.querySelector('.page-title')).toBeNull();
    }
  });

  it.each(['light', 'dark'] as const)('has no axe violations in the %s theme', async (theme) => {
    enableClarity();
    document.documentElement.dataset.theme = theme;
    try {
      const { container } = renderApp(page.route);
      await screen.findAllByText(page.ready);
      // The new header and anchors are held to every rule.
      expect(await axe(container.querySelector('.clarity-decision-header') as HTMLElement)).toHaveNoViolations();
      // Existing page content keeps two known legacy gaps (unnamed progress bars, h3 under h1) that
      // the Spending, Goals, and Trips migrations own; every other rule applies to the whole page.
      expect(await axe(container, { rules: LEGACY_CONTENT_RULES })).toHaveNoViolations();
    } finally {
      delete document.documentElement.dataset.theme;
    }
  });
});

describe('ranked action from the confirmed snapshot', () => {
  const needs: ActionableInsight = {
    id: 'needs',
    conditionCode: 'needs_budget_exceeded',
    observation: 'Needs spending exceeds its current-month budget.',
    actionKey: 'address_needs_budget_excess',
    actionLabel: 'Review Needs spending',
    expectedEffect: 'Reducing spending reduces the Needs budget excess.',
    route: 'https://evil.example/steal?amount=9000&name=Goa',
    context: { recordType: 'expense' },
    disclaimer: 'Informational guidance, not a guaranteed financial result.',
  };

  it('shows the highest-ranked insight and rebuilds its route from the fixed action key', async () => {
    enableClarity();
    renderApp('/spending', [needs]);
    const link = await screen.findByRole('link', { name: /Review Needs spending/ });
    expect(link).toHaveAttribute('href', '/spending?action=review-budget&bucket=needs');
    expect(screen.queryByRole('link', { name: /Record or correct an expense/ })).toBeNull();
  });

  it('shows the same insight on Home and ignores it on a page it does not belong to', async () => {
    enableClarity();
    const { unmount } = renderApp('/', [needs]);
    // Home shows the action in its header and again in the Next actions list.
    expect((await screen.findAllByRole('link', { name: /Review Needs spending/ })).length).toBeGreaterThanOrEqual(1);
    unmount();

    renderApp('/plan', [needs]);
    await screen.findAllByText(/Monthly pay/);
    expect(screen.queryByRole('link', { name: /Review Needs spending/ })).toBeNull();
    expect(screen.getByRole('link', { name: /Add your monthly bills/ })).toHaveAttribute('href', '/plan#bills-form');
  });

  it('drops an insight with an unknown action key and falls back to the fixed action', async () => {
    enableClarity();
    renderApp('/spending', [{ ...needs, actionKey: 'drop_everything' }]);
    expect(await screen.findByRole('link', { name: /Record or correct an expense/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Review Needs spending/ })).toBeNull();
  });
});

describe('arrival focus and scroll', () => {
  let scrollIntoView: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView as unknown as typeof Element.prototype.scrollIntoView;
  });
  afterEach(() => {
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  function setReducedMotion(reduce: boolean) {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: reduce && /prefers-reduced-motion:\s*reduce/.test(query),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
  }

  it.each([
    ['/plan#bills-form', 'bills-form'],
    ['/plan#pay-form', 'pay-form'],
    ['/spending?action=log-expense', 'expense-form'],
    ['/spending?action=review-budget&bucket=needs', 'category-budgets'],
    ['/goals?action=contribute&goalId=5', 'goal-5'],
    ['/goals?action=add-goal', 'goal-form'],
    ['/trips/3?tab=balances&action=settle', 'trip-balances'],
    ['/trips/3?tab=expenses&action=add-expense', 'trip-expense-form'],
    ['/trips/3?tab=people&action=add-member', 'trip-people-form'],
  ])('moves focus to the existing target for %s', async (route, targetId) => {
    enableClarity();
    renderApp(route);
    await waitFor(() => expect(document.getElementById(targetId)).toHaveFocus(), { timeout: 3000 });
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'smooth' });
  });

  it('opens the tab named by the action when the URL has no tab', async () => {
    enableClarity();
    renderApp('/trips/3?action=settle');
    await waitFor(() => expect(document.getElementById('trip-balances')).toHaveFocus());
    expect(screen.getByRole('tab', { name: /Balances/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('opens the new-trip form and keeps focus in its first field', async () => {
    enableClarity();
    renderApp('/trips?action=new-trip');
    const form = await screen.findByRole('textbox', { name: /Trip name/ });
    expect(form).toHaveFocus();
    expect(document.getElementById('new-trip-form')).toContainElement(form);
  });

  it('sends the old Home pay link to the existing Plan pay form, since Home has no pay form', async () => {
    enableClarity();
    renderApp('/?action=set-pay');
    await screen.findByRole('textbox', { name: 'Monthly pay' });
    expect(document.getElementById('home-pay-form')).toBeNull();
    await waitFor(() => expect(document.getElementById('pay-form')).toHaveFocus());
  });

  it('uses instant scrolling when reduced motion is requested', async () => {
    enableClarity();
    setReducedMotion(true);
    renderApp('/plan#bills-form');
    await waitFor(() => expect(document.getElementById('bills-form')).toHaveFocus());
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'auto' });
  });

  it('does not move focus for unknown actions, unknown anchors, or values in the URL', async () => {
    enableClarity();
    renderApp('/goals?action=drop&goalId=5&amount=50000&name=Laptop#anything');
    await screen.findByText('Laptop upgrade');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(document.body).toHaveFocus();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('does nothing while the rollout is off, even with a valid action in the URL', async () => {
    renderApp('/plan#bills-form');
    await screen.findAllByText(/Monthly pay/);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(document.getElementById('bills-form')).not.toHaveFocus();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('opens no new-trip form while the rollout is off', async () => {
    renderApp('/trips?action=new-trip');
    await screen.findByText('Goa weekend');
    expect(screen.queryByRole('textbox', { name: /Trip name/ })).toBeNull();
  });

  it('arrives again when the same action link is used a second time', async () => {
    enableClarity();
    const user = userEvent.setup();
    function Jump() {
      const navigate = useNavigate();
      return <button type="button" onClick={() => navigate('/plan#bills-form')}>Jump to bills</button>;
    }
    renderAuthenticated(
      <FinancialClarityProvider>
        <MutationStatusProvider>
          <Jump />
          <AppRoutes />
        </MutationStatusProvider>
      </FinancialClarityProvider>,
      { route: '/plan#bills-form' },
    );
    await waitFor(() => expect(document.getElementById('bills-form')).toHaveFocus());
    (screen.getByRole('textbox', { name: 'Monthly pay' })).focus();
    expect(document.getElementById('bills-form')).not.toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Jump to bills' }));
    await waitFor(() => expect(document.getElementById('bills-form')).toHaveFocus());
  });
});

describe('focusActionTarget', () => {
  function mount(ids: string[]) {
    for (const id of ids) {
      const el = document.createElement('div');
      el.id = id;
      document.body.append(el);
    }
  }
  afterEach(() => {
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('waits for the specific target and uses the broader one only after the fallback delay', async () => {
    vi.useFakeTimers();
    mount(['goals-list']);
    const stop = focusActionTarget(['goal-9', 'goals-list']);
    await vi.advanceTimersByTimeAsync(ARRIVAL_FALLBACK_MS - 10);
    expect(document.getElementById('goals-list')).not.toHaveFocus();
    await vi.advanceTimersByTimeAsync(20);
    expect(document.getElementById('goals-list')).toHaveFocus();
    stop();
  });

  it('prefers the specific target when it appears before the fallback delay', async () => {
    vi.useFakeTimers();
    mount(['goals-list']);
    const stop = focusActionTarget(['goal-9', 'goals-list']);
    await vi.advanceTimersByTimeAsync(300);
    mount(['goal-9']);
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    expect(document.getElementById('goal-9')).toHaveFocus();
    stop();
  });

  it('stops looking after user input so focus is never taken from the user', async () => {
    vi.useFakeTimers();
    mount(['goals-list']);
    const stop = focusActionTarget(['goal-9', 'goals-list']);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
    await vi.advanceTimersByTimeAsync(ARRIVAL_FALLBACK_MS + 100);
    expect(document.body).toHaveFocus();
    stop();
  });

  it('keeps focus inside the target when a field there already has it', () => {
    const form = document.createElement('form');
    form.id = 'new-trip-form';
    const input = document.createElement('input');
    form.append(input);
    document.body.append(form);
    input.focus();
    focusActionTarget(['new-trip-form']);
    expect(input).toHaveFocus();
  });

  it('does nothing for an empty target list', () => {
    expect(() => focusActionTarget([])()).not.toThrow();
  });
});

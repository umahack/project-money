import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type {
  ActionableInsight,
  ExplanationResponse,
  Outcome,
  OutcomeStatus,
} from '../../clarity/contracts';
import { FinancialClarityProvider } from '../../clarity/FinancialClarityProvider';
import { MutationStatusProvider, useMutationRunner } from '../../clarity/MutationStatusProvider';
import { queueApiResponses, renderAuthenticated, renderWithProviders } from '../../test/test-utils';
import {
  ActionLink,
  DecisionActionHeader,
  FieldError,
  OutcomeCard,
  RegionBoundary,
  ScopedMutationStatus,
  fieldErrorProps,
  safeInternalRoute,
} from './index';

type Amount = { amount: number };

function makeOutcome(overrides: Partial<Outcome<Amount>> = {}): Outcome<Amount> {
  return {
    id: 'monthly-plan:2026-01',
    kind: 'monthly_plan',
    status: 'available',
    classification: 'calculated_result',
    dataVersion: 3,
    period: { month: '2026-01', start: '2026-01-01', endExclusive: '2026-02-01', timeZone: 'Asia/Kolkata' },
    value: { amount: 12000 },
    sourceRefs: [],
    ...overrides,
  };
}

const EXPLANATION: ExplanationResponse = {
  schemaVersion: 1,
  explanation: {
    schemaVersion: 1,
    outcomeId: 'monthly-plan:2026-01',
    kind: 'monthly_plan',
    status: 'available',
    classification: 'calculated_result',
    dataVersion: 3,
    period: { month: '2026-01', start: '2026-01-01', endExclusive: '2026-02-01', timeZone: 'Asia/Kolkata' },
    currency: 'INR',
    precisionMinor: 1,
    sourceRefs: [{
      ref: 'salary',
      order: 1,
      sourceType: 'salary',
      recordId: 1,
      field: 'amount',
      label: 'Salary',
      value: { currency: 'INR', amountMinor: 5000000 },
      classification: 'entered_fact',
    }],
    operations: [{
      order: 1,
      operation: 'sum',
      operandRefs: ['salary'],
      result: { currency: 'INR', amountMinor: 5000000 },
      explanationKey: 'monthly_plan.salary',
    }],
    rounding: { precisionMinor: 1, direction: 'exact', adjustmentMinor: 0 },
  },
};

describe('OutcomeCard', () => {
  it('labels the outcome and period, and announces a changed value without announcing the first render', () => {
    const { rerender } = renderAuthenticated(
      <OutcomeCard outcome={makeOutcome()} title="Remaining spendable" valueSummary="₹12,000" />,
    );

    expect(screen.getByRole('heading', { name: 'Remaining spendable' })).toBeInTheDocument();
    expect(screen.getByText('Calculated result')).toBeInTheDocument();
    expect(screen.getByText('Confirmed')).toBeInTheDocument();
    expect(screen.getByText(/Period: January 2026/)).toBeInTheDocument();
    const live = document.querySelector('[aria-live="polite"]') as HTMLElement;
    expect(live).toHaveTextContent('');

    rerender(<OutcomeCard outcome={makeOutcome({ dataVersion: 4 })} title="Remaining spendable" valueSummary="₹11,500" />);
    expect(live).toHaveTextContent('Remaining spendable. ₹11,500. Calculated result for January 2026. Status: Confirmed.');
  });

  it('shows the informational disclaimer for a recommendation', () => {
    renderAuthenticated(
      <OutcomeCard outcome={makeOutcome({ classification: 'recommendation' })} title="Suggested action" />,
    );
    expect(screen.getByText('Informational guidance, not a guaranteed financial result.')).toBeInTheDocument();
  });

  it.each<[OutcomeStatus, string, boolean]>([
    ['missing_input', 'Needs input', false],
    ['invalid_input', 'Needs correction', false],
    ['stale', 'Stale', true],
    ['refresh_failed', 'Refresh failed', true],
    ['calculation_failed', 'Temporarily unavailable', true],
  ])('renders %s as text and offers a retry only when it can help', async (status, label, retryable) => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    renderAuthenticated(
      <OutcomeCard
        outcome={makeOutcome({
          status,
          missing: [{ input: 'salary', unlocks: ['monthly_plan', 'spending'] }],
          invalid: [{ input: 'salary', constraint: 'a positive amount', affects: ['monthly_plan'] }],
          stale: { sourcePeriod: '2025-12', requestedPeriod: '2026-01' },
        })}
        title="Monthly plan"
        onRetry={onRetry}
      />,
    );

    expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    const retryButtons = screen.queryAllByRole('button', { name: /refresh|recalculate/i });
    expect(retryButtons).toHaveLength(retryable ? 1 : 0);
    if (retryable) {
      await user.click(retryButtons[0]!);
      expect(onRetry).toHaveBeenCalledTimes(1);
    }
  });

  it('names the missing input and the outcome it unlocks', () => {
    renderAuthenticated(
      <OutcomeCard
        outcome={makeOutcome({ status: 'missing_input', missing: [{ input: 'salary', unlocks: ['monthly_plan'] }] })}
        title="Monthly plan"
      />,
    );
    expect(screen.getByText(/to unlock your monthly plan/)).toBeInTheDocument();
  });

  it('opens the explanation from the keyboard, closes it with Escape, and returns focus to the toggle', async () => {
    const user = userEvent.setup();
    const fetchMock = queueApiResponses({ body: EXPLANATION });
    renderAuthenticated(
      <OutcomeCard
        outcome={makeOutcome({ explanationRef: { outcomeId: 'monthly-plan:2026-01', dataVersion: 3 } })}
        title="Monthly plan"
      />,
    );

    const toggle = screen.getByRole('button', { name: /How this was calculated/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    toggle.focus();
    await user.keyboard('{Enter}');

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByText('Steps, in order')).toBeInTheDocument();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/finance/explanations/monthly-plan%3A2026-01?version=3');

    const panel = screen.getByRole('group', { name: /How Monthly plan was calculated/ });
    expect(within(panel).getByText(/Start with the salary/)).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveFocus();
  });

  it('does not offer an explanation without a signed-in session', () => {
    renderWithProviders(
      <OutcomeCard
        outcome={makeOutcome({ explanationRef: { outcomeId: 'monthly-plan:2026-01', dataVersion: 3 } })}
        title="Monthly plan"
      />,
    );
    expect(screen.queryByRole('button', { name: /How this was calculated/ })).not.toBeInTheDocument();
  });
});

describe('RegionBoundary', () => {
  it('shows a labelled skeleton before data, an in-region error with one retry, and keeps sibling regions', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const { rerender } = renderAuthenticated(
      <div>
        <RegionBoundary regionKey="summary" label="Monthly summary" hasData={false} loading>
          <p>summary content</p>
        </RegionBoundary>
        <RegionBoundary regionKey="goal-list" label="Goals" hasData>
          <p>goals content</p>
        </RegionBoundary>
      </div>,
    );
    expect(screen.getByTestId('region-skeleton')).toHaveTextContent('Loading Monthly summary…');
    expect(screen.getByText('goals content')).toBeInTheDocument();

    rerender(
      <div>
        <RegionBoundary regionKey="summary" label="Monthly summary" hasData={false} error={new Error('Offline')} onRetry={onRetry}>
          <p>summary content</p>
        </RegionBoundary>
        <RegionBoundary regionKey="goal-list" label="Goals" hasData>
          <p>goals content</p>
        </RegionBoundary>
      </div>,
    );
    expect(screen.getByText(/Monthly summary could not load/)).toBeInTheDocument();
    expect(screen.getByText('goals content')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Retry loading Monthly summary/ }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('keeps last confirmed content and says "Refresh failed" when a refresh fails', () => {
    renderAuthenticated(
      <RegionBoundary regionKey="summary" label="Monthly summary" hasData error={new Error('Offline')} onRetry={() => {}}>
        <p>last confirmed</p>
      </RegionBoundary>,
    );
    expect(screen.getByText('last confirmed')).toBeInTheDocument();
    expect(screen.getByText('Refresh failed.')).toBeInTheDocument();
  });
});

describe('ScopedMutationStatus', () => {
  function Harness() {
    const runner = useMutationRunner();
    return (
      <div>
        <button
          type="button"
          onClick={() => void runner.submit({ scopeKey: 'goal:17', label: 'Saving goal', path: '/finance/goals/17', method: 'PATCH', body: { amount: 5 } })}
        >
          Save goal
        </button>
        <ScopedMutationStatus scopeKey="goal:17" />
      </div>
    );
  }

  it('shows failed text with a retry that reuses the same idempotency key', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockRejectedValue(new TypeError('network down'));
    renderAuthenticated(
      <FinancialClarityProvider>
        <MutationStatusProvider>
          <Harness />
        </MutationStatusProvider>
      </FinancialClarityProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Save goal' }));
    await waitFor(() => expect(screen.getByText('Saving goal: failed.')).toBeInTheDocument());

    const retry = screen.getByRole('button', { name: /Retry Saving goal/ });
    await user.click(retry);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const keys = fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get('Idempotency-Key'));
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
    await act(async () => {});
  });
});

describe('ActionLink, DecisionActionHeader, and FieldError', () => {
  const insight: ActionableInsight = {
    id: 'a1',
    conditionCode: 'budget_exceeded',
    observation: 'Wants budget exceeded.',
    actionKey: 'review_wants',
    actionLabel: 'Review wants spending',
    expectedEffect: 'Brings spending back within the Wants budget.',
    route: '/spending?action=correct-expense&expenseId=3',
    context: { recordType: 'expense', recordId: 3 },
    disclaimer: 'Informational guidance, not a guaranteed financial result.',
  };

  it('only follows in-app routes and carries an opaque measurement id', () => {
    expect(safeInternalRoute('/spending?action=x&expenseId=3')).toBe('/spending?action=x&expenseId=3');
    expect(safeInternalRoute('/goals', 'abcDEF123456')).toBe('/goals?rid=abcDEF123456');
    expect(safeInternalRoute('/goals', 'not opaque!')).toBe('/goals');
    for (const bad of ['https://evil.example', '//evil.example', 'javascript:alert(1)', '/\\evil', 'spending', undefined]) {
      expect(safeInternalRoute(bad)).toBeNull();
    }
  });

  it('renders the action as a link with its expected effect and the disclaimer', () => {
    renderAuthenticated(
      <DecisionActionHeader title="Spending" decision="Does current spending fit the monthly plan?" action={insight} />,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Spending' })).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /Review wants spending/ });
    expect(link).toHaveAttribute('href', '/spending?action=correct-expense&expenseId=3');
    expect(link).toHaveAccessibleDescription(/Brings spending back.*Informational guidance/);
  });

  it('does not link an unsafe route', () => {
    renderAuthenticated(<ActionLink label="Go" to="https://evil.example" />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('Go')).toBeInTheDocument();
  });

  it('associates the field error with its input', () => {
    renderAuthenticated(
      <div>
        <label htmlFor="salary">Salary</label>
        <input id="salary" {...fieldErrorProps('salary-error', true)} />
        <FieldError id="salary-error" field="Salary" reason="must be positive." correction="Enter an amount above 0." />
      </div>,
    );
    expect(screen.getByLabelText('Salary')).toHaveAccessibleDescription('Salary: must be positive. Enter an amount above 0.');
    expect(screen.getByRole('alert')).toHaveTextContent('Enter an amount above 0.');
  });
});

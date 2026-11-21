import { readFileSync } from 'node:fs';
import { useQuery } from '@tanstack/react-query';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ActionableInsight,
  ExplanationResponse,
  Outcome,
  OutcomeStatus,
  ValueClassification,
} from '../../clarity/contracts';
import { FinancialClarityProvider } from '../../clarity/FinancialClarityProvider';
import { MutationStatusProvider, useMutationRunner } from '../../clarity/MutationStatusProvider';
import { deferred, makeEnvelope, makeSnapshot } from '../../test/clarity-fixtures';
import { axe, createApiResponse, queueApiResponses, renderAuthenticated, type HarnessRenderResult } from '../../test/test-utils';
import {
  ActionLink,
  ClassificationBadge,
  DecisionActionHeader,
  FieldError,
  OutcomeCard,
  RegionBoundary,
  RegionSkeleton,
  ScopedMutationStatus,
  StatusBadge,
  fieldErrorProps,
} from './index';
import { CLASSIFICATION_LABEL, INFORMATIONAL_DISCLAIMER, STATUS_PRESENTATION } from './format';

type Amount = { amount: number };

// Vitest replaces CSS imports with empty modules, so read the stylesheet sources directly (tests run from the frontend package root).
const clarityStyles = readFileSync('src/components/clarity/clarity.css', 'utf8');
const appStyles = readFileSync('src/styles.css', 'utf8');

const ALL_STATUSES: readonly OutcomeStatus[] = [
  'available',
  'missing_input',
  'invalid_input',
  'stale',
  'refresh_failed',
  'calculation_failed',
];

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

const PERIOD = { month: '2026-01', start: '2026-01-01', endExclusive: '2026-02-01', timeZone: 'Asia/Kolkata' } as const;

function makeExplanation(dataVersion: number, salaryMinor: number): ExplanationResponse {
  return {
    schemaVersion: 1,
    explanation: {
      schemaVersion: 1,
      outcomeId: 'monthly-plan:2026-01',
      kind: 'monthly_plan',
      status: 'available',
      classification: 'calculated_result',
      dataVersion,
      period: PERIOD,
      currency: 'INR',
      precisionMinor: 1,
      sourceRefs: [{
        ref: 'salary',
        order: 1,
        sourceType: 'salary',
        recordId: 1,
        field: 'amount',
        label: 'Salary',
        value: { currency: 'INR', amountMinor: salaryMinor },
        classification: 'entered_fact',
      }],
      operations: [{
        order: 1,
        operation: 'sum',
        operandRefs: ['salary'],
        result: { currency: 'INR', amountMinor: salaryMinor },
        explanationKey: 'monthly_plan.salary',
      }],
      rounding: { precisionMinor: 1, direction: 'exact', adjustmentMinor: 0 },
    },
  };
}

const INSIGHT: ActionableInsight = {
  id: 'a1',
  conditionCode: 'budget_exceeded',
  observation: 'Wants budget exceeded.',
  actionKey: 'review_wants',
  actionLabel: 'Review wants spending',
  expectedEffect: 'Brings spending back within the Wants budget.',
  route: '/spending?action=correct-expense&expenseId=3',
  context: { recordType: 'expense', recordId: 3 },
  disclaimer: INFORMATIONAL_DISCLAIMER,
};

function explainable(overrides: Partial<Outcome<Amount>> = {}): Outcome<Amount> {
  return makeOutcome({ explanationRef: { outcomeId: 'monthly-plan:2026-01', dataVersion: 3 }, ...overrides });
}

function articleOf(title: string): HTMLElement {
  return screen.getByRole('article', { name: title });
}

/** Elements a keyboard user reaches with Tab, in document order. */
function tabbables(root: ParentNode = document.body): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), [tabindex="0"]'),
  ).filter((element) => !element.closest('[hidden]'));
}

function mockMatchMedia(reduceMotion: boolean): void {
  vi.stubGlobal('matchMedia', (query: string): MediaQueryList => ({
    matches: reduceMotion && /prefers-reduced-motion:\s*reduce/.test(query),
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => false),
  }));
}

function renderWithMutations(ui: ReactElement): HarnessRenderResult {
  return renderAuthenticated(
    <FinancialClarityProvider>
      <MutationStatusProvider>{ui}</MutationStatusProvider>
    </FinancialClarityProvider>,
  );
}

function SaveGoalHarness() {
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
      <button type="button">After status</button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Outcome statuses, text equivalents, and retry placement
// ---------------------------------------------------------------------------

describe('OutcomeCard: every outcome status (Requirements 9.6, 9.7, 9.9, 9.11, 12.2)', () => {
  const EXPECT: Record<OutcomeStatus, { label: string; detail: RegExp | null; valueShown: boolean; retry: string | null; corrective: boolean }> = {
    available: { label: 'Confirmed', detail: null, valueShown: true, retry: null, corrective: false },
    missing_input: {
      label: 'Needs input',
      detail: /Not available yet\.\s*Add salary to unlock your monthly plan and spending guidance\./,
      valueShown: false,
      retry: null,
      corrective: true,
    },
    invalid_input: {
      label: 'Needs correction',
      detail: /Not available until an input is corrected\.\s*Salary must be: a positive amount\. This affects your monthly plan\./,
      valueShown: false,
      retry: null,
      corrective: true,
    },
    stale: {
      label: 'Stale',
      detail: /Stale\.\s*Showing December 2025; January 2026 was requested\./,
      valueShown: true,
      retry: 'Refresh Monthly plan',
      corrective: false,
    },
    refresh_failed: {
      label: 'Refresh failed',
      detail: /Refresh failed\.\s*Showing your last confirmed values\./,
      valueShown: true,
      retry: 'Retry refresh Monthly plan',
      corrective: false,
    },
    calculation_failed: {
      label: 'Temporarily unavailable',
      detail: /Temporarily unavailable\.\s*The calculation did not finish\. Your entered values are saved/,
      valueShown: false,
      retry: 'Recalculate Monthly plan',
      corrective: false,
    },
  };

  it.each(ALL_STATUSES)('%s renders its text label, detail, value visibility, corrective link, and retry', (status) => {
    const expected = EXPECT[status];
    renderAuthenticated(
      <OutcomeCard
        outcome={makeOutcome({
          status,
          missing: [{ input: 'salary', unlocks: ['monthly_plan', 'spending'] }],
          invalid: [{ input: 'salary', constraint: 'a positive amount', affects: ['monthly_plan'] }],
          stale: { sourcePeriod: '2025-12', requestedPeriod: '2026-01' },
        })}
        title="Monthly plan"
        valueSummary="₹12,000"
        onRetry={() => {}}
        correctiveAction={<ActionLink label="Add salary" to="/plan" />}
      />,
    );

    const card = articleOf('Monthly plan');
    expect(card).toHaveAttribute('data-status', status);
    // The status is text, so it never relies on color or the glyph alone.
    expect(within(card).getByText(expected.label, { selector: '.clarity-status' })).toBeInTheDocument();
    if (expected.detail) expect(card.textContent).toMatch(expected.detail);
    else expect(card.querySelector('.clarity-state')).toBeNull();

    if (expected.valueShown) expect(within(card).getByText('₹12,000')).toBeInTheDocument();
    else expect(within(card).queryByText('₹12,000')).not.toBeInTheDocument();

    if (expected.corrective) expect(within(card).getByRole('link', { name: /Add salary/ })).toHaveAttribute('href', '/plan');
    else expect(within(card).queryByRole('link', { name: /Add salary/ })).not.toBeInTheDocument();

    const retryButtons = within(card).queryAllByRole('button', { name: /refresh|recalculate/i });
    if (expected.retry) {
      expect(retryButtons).toHaveLength(1);
      expect(retryButtons[0]).toHaveAccessibleName(expected.retry);
    } else {
      expect(retryButtons).toHaveLength(0);
    }
  });

  it('uses the server-provided retry scope and action when given', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    renderAuthenticated(
      <OutcomeCard
        outcome={makeOutcome({ status: 'stale', retry: { action: 'recalculate', scopeKey: 'outcome:custom' } })}
        title="Monthly plan"
        onRetry={onRetry}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Recalculate Monthly plan' }));
    expect(onRetry).toHaveBeenCalledWith({ action: 'recalculate', scopeKey: 'outcome:custom' });
  });

  it('offers no retry when no handler is supplied', () => {
    renderAuthenticated(<OutcomeCard outcome={makeOutcome({ status: 'stale' })} title="Monthly plan" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it.each<[ValueClassification, string]>([
    ['entered_fact', 'Entered fact'],
    ['calculated_result', 'Calculated result'],
    ['recommendation', 'Recommendation'],
  ])('labels a %s component as text, and shows the disclaimer only for recommendations', (classification, label) => {
    renderAuthenticated(
      <OutcomeCard outcome={makeOutcome({ classification })} title="Monthly plan" valueSummary="₹12,000" />,
    );
    const card = articleOf('Monthly plan');
    expect(within(card).getByText(label, { selector: '.clarity-badge' })).toBeInTheDocument();
    if (classification === 'recommendation') expect(within(card).getByText(INFORMATIONAL_DISCLAIMER)).toBeInTheDocument();
    else expect(within(card).queryByText(INFORMATIONAL_DISCLAIMER)).not.toBeInTheDocument();
  });

  it('places the single scoped retry after the state text and value, inside the card, and before the explanation control', () => {
    renderAuthenticated(
      <OutcomeCard
        outcome={explainable({ status: 'refresh_failed' })}
        title="Monthly plan"
        valueSummary="₹12,000"
        onRetry={() => {}}
      />,
    );
    const card = articleOf('Monthly plan');
    const retry = within(card).getByRole('button', { name: 'Retry refresh Monthly plan' });
    const stateText = within(card).getByText('Refresh failed.', { selector: 'strong' });
    const value = within(card).getByText('₹12,000');
    const toggle = within(card).getByRole('button', { name: /How this was calculated/ });
    const follows = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

    expect(card).toContainElement(retry);
    expect(retry.closest('.clarity-retry-row')).not.toBeNull();
    expect(follows(stateText, retry)).toBe(true);
    expect(follows(value, retry)).toBe(true);
    expect(follows(retry, toggle)).toBe(true);
    expect(within(card).getAllByRole('button', { name: /refresh|recalculate|retry/i })).toHaveLength(1);
  });

  it('keeps the last confirmed value on a failed refresh and keeps entered values on a failed calculation', () => {
    const { rerender } = renderAuthenticated(
      <OutcomeCard outcome={makeOutcome({ status: 'refresh_failed' })} title="Monthly plan" valueSummary="₹12,000" onRetry={() => {}} />,
    );
    expect(screen.getByText('₹12,000')).toBeInTheDocument();
    expect(screen.getByText(/Showing your last confirmed values/)).toBeInTheDocument();

    rerender(
      <OutcomeCard
        outcome={makeOutcome({
          status: 'calculation_failed',
          sourceRefs: [{
            ref: 'salary',
            sourceType: 'salary',
            recordId: 1,
            field: 'amount',
            label: 'Salary',
            value: { currency: 'INR', amountMinor: 5000000 },
            classification: 'entered_fact',
          }],
        })}
        title="Monthly plan"
        valueSummary="₹12,000"
        onRetry={() => {}}
      />,
    );
    const card = articleOf('Monthly plan');
    expect(within(card).queryByText('₹12,000')).not.toBeInTheDocument();
    expect(within(card).getByText('Your entered values (kept):')).toBeInTheDocument();
    expect(within(card).getByText(/Salary:/)).toHaveTextContent('50,000');
    expect(within(card).getByRole('button', { name: 'Recalculate Monthly plan' })).toBeInTheDocument();
  });
});

describe('OutcomeCard: refresh and calculation updates in place (Requirements 9.9, 9.11, 10.15)', () => {
  it('shows Refreshing text with the old values, then replaces stale values and removes the stale label', () => {
    const { rerender } = renderAuthenticated(
      <OutcomeCard outcome={makeOutcome({ status: 'stale', stale: { sourcePeriod: '2025-12', requestedPeriod: '2026-01' } })} title="Monthly plan" valueSummary="₹12,000" onRetry={() => {}} />,
    );
    const card = articleOf('Monthly plan');
    expect(within(card).getByText('Stale', { selector: '.clarity-status' })).toBeInTheDocument();

    rerender(
      <OutcomeCard outcome={makeOutcome({ status: 'stale', stale: { sourcePeriod: '2025-12', requestedPeriod: '2026-01' } })} title="Monthly plan" valueSummary="₹12,000" refreshing onRetry={() => {}} />,
    );
    expect(within(card).getByText('Refreshing…')).toBeInTheDocument();
    expect(within(card).getByText('₹12,000')).toBeInTheDocument();

    rerender(
      <OutcomeCard outcome={makeOutcome({ dataVersion: 4 })} title="Monthly plan" valueSummary="₹11,500" onRetry={() => {}} />,
    );
    // Same element: the card updates in place instead of remounting.
    expect(articleOf('Monthly plan')).toBe(card);
    expect(card).toHaveAttribute('data-version', '4');
    expect(within(card).queryByText('Refreshing…')).not.toBeInTheDocument();
    expect(within(card).queryByText(/Stale/)).not.toBeInTheDocument();
    expect(within(card).queryByText('₹12,000')).not.toBeInTheDocument();
    expect(within(card).getByText('₹11,500')).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: /refresh|recalculate/i })).not.toBeInTheDocument();
  });

  it('shows pending retry text, ignores a second activation, and exposes the state as disabled', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    renderAuthenticated(
      <OutcomeCard outcome={makeOutcome({ status: 'calculation_failed' })} title="Monthly plan" retrying onRetry={onRetry} />,
    );
    // The accessible name starts with the visible words (WCAG 2.5.3 Label in Name).
    const button = screen.getByRole('button', { name: 'Retrying… Monthly plan' });
    expect(button).toHaveTextContent('Retrying…');
    expect(button).toHaveAttribute('aria-disabled', 'true');
    // The button stays focusable (aria-disabled, not disabled), so focus is never dropped.
    button.focus();
    expect(button).toHaveFocus();
    await user.click(button);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('updates an open explanation in place to the new confirmed version without closing it', async () => {
    const user = userEvent.setup();
    const v4 = deferred<void>();
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('version=4')) {
        await v4.promise;
        return createApiResponse({ body: makeExplanation(4, 6000000) });
      }
      return createApiResponse({ body: makeExplanation(3, 5000000) });
    });

    const { rerender } = renderAuthenticated(
      <OutcomeCard outcome={explainable({ status: 'stale' })} title="Monthly plan" valueSummary="₹12,000" onRetry={() => {}} />,
    );
    const toggle = screen.getByRole('button', { name: /How this was calculated/ });
    await user.click(toggle);
    const panel = await screen.findByRole('group', { name: /How Monthly plan was calculated/ });
    expect(await within(panel).findByText(/Data version 3/)).toBeInTheDocument();
    expect(within(panel).getByText(/Salary:/)).toHaveTextContent('50,000');
    toggle.focus();

    rerender(
      <OutcomeCard
        outcome={explainable({ dataVersion: 4, explanationRef: { outcomeId: 'monthly-plan:2026-01', dataVersion: 4 } })}
        title="Monthly plan"
        valueSummary="₹11,500"
        onRetry={() => {}}
      />,
    );

    // Pending: the open panel keeps the previous version and says it is updating.
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('group', { name: /How Monthly plan was calculated/ })).toBe(panel);
    expect(await within(panel).findByText('Updating to the latest confirmed data…')).toBeInTheDocument();
    expect(within(panel).getByText(/Salary:/)).toHaveTextContent('50,000');
    expect(toggle).toHaveFocus();

    await act(async () => { v4.resolve(); });
    await waitFor(() => expect(within(panel).getByText(/Data version 4/)).toBeInTheDocument());
    expect(screen.getByRole('group', { name: /How Monthly plan was calculated/ })).toBe(panel);
    expect(within(panel).getByText(/Salary:/)).toHaveTextContent('60,000');
    expect(within(panel).queryByText('Updating to the latest confirmed data…')).not.toBeInTheDocument();
    expect(within(panel).getByText('The calculation for Monthly plan was updated to the latest confirmed data.')).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveFocus();
  });

  it('shows a calculation load failure inside the explanation with one retry that reloads it', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    renderAuthenticated(<OutcomeCard outcome={explainable()} title="Monthly plan" valueSummary="₹12,000" />);

    await user.click(screen.getByRole('button', { name: /How this was calculated/ }));
    const panel = await screen.findByRole('group', { name: /How Monthly plan was calculated/ });
    expect(await within(panel).findByText('The calculation could not be loaded.')).toBeInTheDocument();
    const retry = within(panel).getByRole('button', { name: 'Retry loading the calculation for Monthly plan' });
    expect(within(panel).getAllByRole('button')).toHaveLength(1);
    // The card keeps its confirmed value while the explanation fails.
    expect(screen.getByText('₹12,000')).toBeInTheDocument();

    queueApiResponses({ body: makeExplanation(3, 5000000) });
    await user.click(retry);
    expect(await within(panel).findByText(/Data version 3/)).toBeInTheDocument();
    expect(within(panel).queryByText('The calculation could not be loaded.')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Live announcements
// ---------------------------------------------------------------------------

describe('live announcements (Requirement 12.3)', () => {
  it('announces a changed value politely and atomically, and stays silent on first render', () => {
    const { rerender } = renderAuthenticated(
      <OutcomeCard outcome={makeOutcome()} title="Remaining spendable" valueSummary="₹12,000" />,
    );
    const live = within(articleOf('Remaining spendable')).getByRole('status');
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(live).toHaveAttribute('aria-atomic', 'true');
    expect(live).toBeEmptyDOMElement();

    rerender(<OutcomeCard outcome={makeOutcome({ dataVersion: 4 })} title="Remaining spendable" valueSummary="₹11,500" />);
    expect(live).toHaveTextContent('Remaining spendable. ₹11,500. Calculated result for January 2026. Status: Confirmed.');
  });

  it('announces a status change that has no new value, and names the new status', () => {
    const { rerender } = renderAuthenticated(
      <OutcomeCard outcome={makeOutcome()} title="Monthly plan" valueSummary="₹12,000" />,
    );
    const live = within(articleOf('Monthly plan')).getByRole('status');
    rerender(<OutcomeCard outcome={makeOutcome({ status: 'refresh_failed' })} title="Monthly plan" valueSummary="₹12,000" onRetry={() => {}} />);
    expect(live).toHaveTextContent('Status: Refresh failed.');
  });

  it('announces only the card that changed', () => {
    const { rerender } = renderAuthenticated(
      <div>
        <OutcomeCard outcome={makeOutcome()} title="Plan" valueSummary="₹1" />
        <OutcomeCard outcome={makeOutcome({ id: 'spending:2026-01', kind: 'spending' })} title="Spending" valueSummary="₹2" />
      </div>,
    );
    rerender(
      <div>
        <OutcomeCard outcome={makeOutcome()} title="Plan" valueSummary="₹1" />
        <OutcomeCard outcome={makeOutcome({ id: 'spending:2026-01', kind: 'spending', dataVersion: 4 })} title="Spending" valueSummary="₹3" />
      </div>,
    );
    expect(within(articleOf('Plan')).getByRole('status')).toBeEmptyDOMElement();
    expect(within(articleOf('Spending')).getByRole('status')).toHaveTextContent('Spending. ₹3.');
  });

  it('announces pending and done politely and a failure assertively, without moving focus', async () => {
    const user = userEvent.setup();
    const gate = deferred<Response>();
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockReturnValueOnce(gate.promise);
    renderWithMutations(<SaveGoalHarness />);

    const save = screen.getByRole('button', { name: 'Save goal' });
    await user.click(save);
    const polite = await screen.findByText('Saving goal: pending');
    expect(polite.closest('[role="status"]')).not.toBeNull();
    expect(screen.queryByRole('alert')).toBeEmptyDOMElement();
    expect(save).toHaveFocus();

    await act(async () => { gate.resolve(createApiResponse({ body: makeEnvelope(makeSnapshot(5), 'goal:17') })); });
    expect(await screen.findByText('Saving goal: done')).toBeInTheDocument();
    expect(save).toHaveFocus();

    fetchMock.mockRejectedValueOnce(new TypeError('network down'));
    await user.click(save);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Saving goal: failed.');
    expect(alert).toHaveTextContent('Your last confirmed values are unchanged.');
    expect(save).toHaveFocus();
  });

  it('announces a field error when it appears without moving focus', async () => {
    const user = userEvent.setup();
    function Form() {
      const [error, setError] = useState(false);
      return (
        <form onSubmit={(event) => { event.preventDefault(); setError(true); }}>
          <label htmlFor="salary">Salary</label>
          <input id="salary" defaultValue="0" {...fieldErrorProps('salary-error', error)} />
          <button type="submit">Save</button>
          {error && <FieldError id="salary-error" field="Salary" reason="must be above 0." correction="Enter an amount from 1 to 10,00,00,000." />}
        </form>
      );
    }
    renderAuthenticated(<Form />);
    const submit = screen.getByRole('button', { name: 'Save' });
    await user.click(submit);
    expect(await screen.findByRole('alert')).toHaveTextContent('Salary: must be above 0. Enter an amount from 1 to 10,00,00,000.');
    expect(submit).toHaveFocus();
  });
});

// ---------------------------------------------------------------------------
// Focus retention and keyboard operation
// ---------------------------------------------------------------------------

describe('focus retention (Requirements 12.4, 12.6)', () => {
  it('keeps focus on the active control when the outcome changes', () => {
    const { rerender } = renderAuthenticated(
      <OutcomeCard outcome={explainable({ status: 'stale' })} title="Monthly plan" valueSummary="₹12,000" onRetry={() => {}} />,
    );
    const retry = screen.getByRole('button', { name: 'Refresh Monthly plan' });
    retry.focus();

    rerender(
      <OutcomeCard outcome={explainable({ status: 'stale', dataVersion: 4 })} title="Monthly plan" valueSummary="₹11,500" onRetry={() => {}} />,
    );
    expect(screen.getByRole('button', { name: 'Refresh Monthly plan' })).toBe(retry);
    expect(retry).toHaveFocus();

    const toggle = screen.getByRole('button', { name: /How this was calculated/ });
    toggle.focus();
    rerender(
      <OutcomeCard outcome={explainable({ status: 'stale', dataVersion: 5 })} title="Monthly plan" valueSummary="₹10,000" onRetry={() => {}} />,
    );
    expect(toggle).toHaveFocus();
  });

  it('moves focus to the card, not the page body, when the activated retry disappears', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const { rerender } = renderAuthenticated(
      <OutcomeCard outcome={makeOutcome({ status: 'stale' })} title="Monthly plan" valueSummary="₹12,000" onRetry={onRetry} />,
    );
    await user.click(screen.getByRole('button', { name: 'Refresh Monthly plan' }));
    expect(onRetry).toHaveBeenCalledTimes(1);

    rerender(<OutcomeCard outcome={makeOutcome({ dataVersion: 4 })} title="Monthly plan" valueSummary="₹11,500" onRetry={onRetry} />);
    expect(articleOf('Monthly plan')).toHaveFocus();
  });

  it('does not take focus back after the user moved it elsewhere', async () => {
    const user = userEvent.setup();
    const { rerender } = renderAuthenticated(
      <div>
        <OutcomeCard outcome={makeOutcome({ status: 'stale' })} title="Monthly plan" valueSummary="₹12,000" onRetry={() => {}} />
        <label>
          Notes
          <input />
        </label>
      </div>,
    );
    await user.click(screen.getByRole('button', { name: 'Refresh Monthly plan' }));
    const notes = screen.getByLabelText('Notes');
    await user.click(notes);

    rerender(
      <div>
        <OutcomeCard outcome={makeOutcome({ dataVersion: 4 })} title="Monthly plan" valueSummary="₹11,500" onRetry={() => {}} />
        <label>
          Notes
          <input />
        </label>
      </div>,
    );
    expect(screen.getByLabelText('Notes')).toHaveFocus();
  });

  it('moves focus to the failed region (not the body) when its retry starts loading again', async () => {
    const user = userEvent.setup();
    const props = { regionKey: 'summary', label: 'Monthly summary', hasData: false } as const;
    const { rerender } = renderAuthenticated(
      <RegionBoundary {...props} error={new Error('Offline')} onRetry={() => {}}><p>content</p></RegionBoundary>,
    );
    await user.click(screen.getByRole('button', { name: 'Retry loading Monthly summary' }));
    rerender(<RegionBoundary {...props} loading onRetry={() => {}}><p>content</p></RegionBoundary>);
    expect(screen.getByRole('group', { name: 'Monthly summary' })).toHaveFocus();
  });

  it('moves focus to the record scope (not the body) when a mutation retry starts', async () => {
    const user = userEvent.setup();
    const gate = deferred<Response>();
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockRejectedValueOnce(new TypeError('network down'));
    renderWithMutations(<SaveGoalHarness />);

    await user.click(screen.getByRole('button', { name: 'Save goal' }));
    const retry = await screen.findByRole('button', { name: 'Retry Saving goal' });
    fetchMock.mockReturnValueOnce(gate.promise);
    await user.click(retry);

    await screen.findByText('Saving goal: pending');
    expect(screen.queryByRole('button', { name: 'Retry Saving goal' })).not.toBeInTheDocument();
    expect(document.querySelector('[data-scope="goal:17"]')).toHaveFocus();

    await act(async () => { gate.resolve(createApiResponse({ body: makeEnvelope(makeSnapshot(6), 'goal:17') })); });
    await screen.findByText('Saving goal: done');
  });

  it('moves focus to the record scope after dismissing a finished status', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockResolvedValueOnce(createApiResponse({ body: makeEnvelope(makeSnapshot(7), 'goal:17') }));
    renderWithMutations(<SaveGoalHarness />);

    await user.click(screen.getByRole('button', { name: 'Save goal' }));
    await screen.findByText('Saving goal: done');
    await user.click(screen.getByRole('button', { name: 'Dismiss Saving goal message' }));
    expect(screen.queryByText('Saving goal: done')).not.toBeInTheDocument();
    expect(document.querySelector('[data-scope="goal:17"]')).toHaveFocus();
  });
});

describe('keyboard operation (Requirements 12.5, 12.6)', () => {
  it('moves through the card controls in reading order without a focus trap', async () => {
    const user = userEvent.setup();
    queueApiResponses({ body: makeExplanation(3, 5000000) });
    renderAuthenticated(
      <div>
        <button type="button">Before</button>
        <OutcomeCard
          outcome={explainable({ status: 'stale' })}
          title="Monthly plan"
          valueSummary="₹12,000"
          onRetry={() => {}}
          actions={[INSIGHT]}
        />
        <button type="button">After</button>
      </div>,
    );

    const expectedOrder = tabbables().map((element) => element.getAttribute('aria-label') ?? element.textContent);
    expect(expectedOrder).toEqual([
      'Before',
      'Refresh Monthly plan',
      expect.stringContaining('Review wants spending'),
      'How this was calculated for Monthly plan',
      'After',
    ]);

    screen.getByRole('button', { name: 'Before' }).focus();
    const visited: Element[] = [];
    for (let i = 0; i < expectedOrder.length - 1; i += 1) {
      await user.tab();
      visited.push(document.activeElement as Element);
    }
    expect(visited).toEqual(tabbables().slice(1));
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();

    // Open the explanation: Tab still leaves the card, and Shift+Tab walks back.
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: /How this was calculated/ })).toHaveFocus();
    await user.keyboard('{Enter}');
    await screen.findByText('Steps, in order');
    await user.tab();
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: /How this was calculated/ })).toHaveFocus();
  });

  it.each([['Enter', '{Enter}'], ['Space', ' ']])('activates the outcome retry with %s', async (_name, key) => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    renderAuthenticated(<OutcomeCard outcome={makeOutcome({ status: 'calculation_failed' })} title="Monthly plan" onRetry={onRetry} />);
    await user.tab();
    expect(screen.getByRole('button', { name: 'Recalculate Monthly plan' })).toHaveFocus();
    await user.keyboard(key);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it.each([['Enter', '{Enter}'], ['Space', ' ']])('opens and closes the explanation with %s and closes it with Escape from inside the panel', async (_name, key) => {
    const user = userEvent.setup();
    queueApiResponses({ body: makeExplanation(3, 5000000) });
    renderAuthenticated(<OutcomeCard outcome={explainable()} title="Monthly plan" valueSummary="₹12,000" />);

    await user.tab();
    const toggle = screen.getByRole('button', { name: /How this was calculated/ });
    expect(toggle).toHaveFocus();
    await user.keyboard(key);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await screen.findByText('Steps, in order');

    await user.keyboard(key);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveFocus();

    await user.keyboard(key);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    // Escape works from a focused element inside the panel as well as from the toggle.
    const panel = await screen.findByRole('group', { name: /How Monthly plan was calculated/ });
    panel.tabIndex = -1;
    panel.focus();
    await user.keyboard('{Escape}');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveFocus();
  });

  it('retries a failed region and a failed mutation from the keyboard', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    renderWithMutations(
      <div>
        <RegionBoundary regionKey="summary" label="Monthly summary" hasData={false} error={new Error('Offline')} onRetry={onRetry}>
          <p>content</p>
        </RegionBoundary>
        <SaveGoalHarness />
      </div>,
    );
    await user.tab();
    expect(screen.getByRole('button', { name: 'Retry loading Monthly summary' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onRetry).toHaveBeenCalledTimes(1);

    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockRejectedValueOnce(new TypeError('network down'));
    await user.tab();
    expect(screen.getByRole('button', { name: 'Save goal' })).toHaveFocus();
    await user.keyboard(' ');
    const retry = await screen.findByRole('button', { name: 'Retry Saving goal' });
    await user.tab();
    expect(retry).toHaveFocus();
    fetchMock.mockRejectedValueOnce(new TypeError('network down'));
    await user.keyboard('{Enter}');
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    // Dismiss is the next control after Retry, still in order.
    await screen.findByRole('button', { name: 'Dismiss failed Saving goal' });
    await act(async () => {});
  });

  it('reaches the action link from the keyboard', async () => {
    const user = userEvent.setup();
    renderAuthenticated(<DecisionActionHeader title="Spending" decision="Does spending fit the plan?" action={INSIGHT} />);
    await user.tab();
    expect(screen.getByRole('link', { name: /Review wants spending/ })).toHaveFocus();
  });
});

// ---------------------------------------------------------------------------
// Field-error association and status text
// ---------------------------------------------------------------------------

describe('field errors (Requirements 12.15, 12.16, 12.17)', () => {
  function Form() {
    const [salaryError, setSalaryError] = useState(false);
    return (
      <form onSubmit={(event) => { event.preventDefault(); setSalaryError(true); }}>
        <label htmlFor="name">Employer</label>
        <input id="name" />
        <label htmlFor="salary">Salary</label>
        <input id="salary" defaultValue="-5" {...fieldErrorProps('salary-error', salaryError)} />
        <button type="submit">Save</button>
        {salaryError && (
          <FieldError id="salary-error" field="Salary" reason="must be above 0." correction="Enter an amount from 1 to 10,00,00,000." />
        )}
      </form>
    );
  }

  it('names the input, reason, and correction, ties the error to the input, and keeps valid values and focus', async () => {
    const user = userEvent.setup();
    renderAuthenticated(<Form />);
    const salary = screen.getByLabelText('Salary');
    expect(salary).not.toHaveAttribute('aria-invalid');
    expect(salary).not.toHaveAttribute('aria-describedby');

    await user.type(screen.getByLabelText('Employer'), 'Acme');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveAttribute('id', 'salary-error');
    expect(alert).toHaveTextContent('Salary: must be above 0. Enter an amount from 1 to 10,00,00,000.');
    expect(salary).toHaveAttribute('aria-invalid', 'true');
    expect(salary).toHaveAttribute('aria-describedby', 'salary-error');
    expect(salary).toHaveAccessibleDescription('Salary: must be above 0. Enter an amount from 1 to 10,00,00,000.');
    expect(screen.getByRole('button', { name: 'Save' })).toHaveFocus();
    expect(screen.getByLabelText('Employer')).toHaveValue('Acme');
    expect(screen.getByLabelText('Salary')).toHaveValue('-5');
  });

  it('hides the decorative glyph from assistive technology so the text is read once', () => {
    renderAuthenticated(<FieldError id="e" field="Salary" reason="must be above 0." correction="Enter an amount above 0." />);
    const glyph = screen.getByRole('alert').querySelector('.clarity-glyph');
    expect(glyph).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('status is always text (Requirement 12.2)', () => {
  it.each(ALL_STATUSES)('StatusBadge %s carries its label as text and hides the glyph from assistive technology', (status) => {
    const { container } = renderAuthenticated(<StatusBadge status={status} />);
    const badge = container.querySelector('.clarity-status') as HTMLElement;
    const { label, glyph } = STATUS_PRESENTATION[status];
    expect(badge).toHaveTextContent(`${glyph}${label}`);
    expect(badge.querySelector('.clarity-glyph')).toHaveAttribute('aria-hidden', 'true');
    expect(within(badge).getByText(label)).toBeInTheDocument();
  });

  it.each(Object.keys(CLASSIFICATION_LABEL) as ValueClassification[])('ClassificationBadge %s is text', (classification) => {
    renderAuthenticated(<ClassificationBadge classification={classification} />);
    expect(screen.getByText(CLASSIFICATION_LABEL[classification])).toBeInTheDocument();
  });

  it('describes every mutation phase in words next to the control', async () => {
    const user = userEvent.setup();
    const gate = deferred<Response>();
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockReturnValueOnce(gate.promise);
    renderWithMutations(<SaveGoalHarness />);

    expect(document.querySelector('[data-scope="goal:17"]')).toHaveClass('clarity-mutation-idle');
    await user.click(screen.getByRole('button', { name: 'Save goal' }));
    expect(await screen.findByText('Saving goal: pending')).toBeInTheDocument();
    await act(async () => { gate.resolve(createApiResponse({ body: makeEnvelope(makeSnapshot(8), 'goal:17') })); });
    expect(await screen.findByText('Saving goal: done')).toBeInTheDocument();

    fetchMock.mockRejectedValueOnce(new TypeError('network down'));
    await user.click(screen.getByRole('button', { name: 'Save goal' }));
    expect(await screen.findByText('Saving goal: failed.')).toBeInTheDocument();
  });

  it('shows region loading, refreshing, and failure as text', () => {
    const { rerender } = renderAuthenticated(
      <RegionBoundary regionKey="r" label="Goals" hasData={false} loading><p>c</p></RegionBoundary>,
    );
    expect(screen.getByText('Loading Goals…')).toBeInTheDocument();
    rerender(<RegionBoundary regionKey="r" label="Goals" hasData loading><p>c</p></RegionBoundary>);
    expect(screen.getByText(/Refreshing Goals…/)).toBeInTheDocument();
    rerender(<RegionBoundary regionKey="r" label="Goals" hasData error={new Error('Offline')} onRetry={() => {}}><p>c</p></RegionBoundary>);
    expect(screen.getByText('Refresh failed.')).toBeInTheDocument();
    rerender(<RegionBoundary regionKey="r" label="Goals" hasData={false} error={new Error('Offline')} onRetry={() => {}}><p>c</p></RegionBoundary>);
    expect(screen.getByText('Goals could not load.')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Reduced motion
// ---------------------------------------------------------------------------

describe.each([true, false])('reduced motion preference = %s (Requirement 12.7)', (reduceMotion) => {
  beforeEach(() => mockMatchMedia(reduceMotion));

  it('reports the mocked preference to the page', () => {
    expect(window.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(reduceMotion);
  });

  it('changes state immediately with no inline animation, transition, or transform', async () => {
    const user = userEvent.setup();
    queueApiResponses({ body: makeExplanation(3, 5000000) });
    const { container, rerender } = renderAuthenticated(
      <div>
        <OutcomeCard outcome={explainable({ status: 'stale' })} title="Monthly plan" valueSummary="₹12,000" onRetry={() => {}} />
        <RegionBoundary regionKey="r" label="Goals" hasData={false} loading><p>c</p></RegionBoundary>
      </div>,
    );

    const toggle = screen.getByRole('button', { name: /How this was calculated/ });
    await user.click(toggle);
    // Synchronous: no transition stands between the click and the new state.
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await screen.findByText('Steps, in order');

    rerender(
      <div>
        <OutcomeCard outcome={explainable({ dataVersion: 4, explanationRef: { outcomeId: 'monthly-plan:2026-01', dataVersion: 3 } })} title="Monthly plan" valueSummary="₹11,500" onRetry={() => {}} />
        <RegionBoundary regionKey="r" label="Goals" hasData><p>loaded</p></RegionBoundary>
      </div>,
    );
    expect(screen.getByText('₹11,500')).toBeInTheDocument();
    expect(screen.getByText('loaded')).toBeInTheDocument();
    expect(screen.queryByTestId('region-skeleton')).not.toBeInTheDocument();

    for (const element of container.querySelectorAll<HTMLElement>('[style]')) {
      expect(element.getAttribute('style')).not.toMatch(/animation|transition|transform/i);
    }
  });

  it('marks the skeleton shimmer as decorative and keeps its loading text', () => {
    renderAuthenticated(<RegionSkeleton label="Goals" />);
    expect(screen.getByTestId('region-skeleton')).toHaveTextContent('Loading Goals…');
    expect(document.querySelector('.clarity-skeleton-lines')).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('reduced motion stylesheet rules (Requirement 12.7)', () => {
  const MEDIA = '@media (prefers-reduced-motion: reduce)';

  function reducedBlock(css: string): string {
    const start = css.indexOf(MEDIA);
    expect(start).toBeGreaterThanOrEqual(0);
    let depth = 0;
    for (let i = css.indexOf('{', start); i < css.length; i += 1) {
      if (css[i] === '{') depth += 1;
      if (css[i] === '}') {
        depth -= 1;
        if (depth === 0) return css.slice(start, i + 1);
      }
    }
    throw new Error('Unterminated reduced-motion block');
  }

  it('removes transitions and animations from every animated clarity surface', () => {
    const block = reducedBlock(clarityStyles);
    for (const selector of ['.clarity-outcome', '.clarity-explanation', '.clarity-action-link', '.clarity-chevron', '.clarity-region', '.clarity-mutation']) {
      expect(block).toContain(selector);
    }
    expect(block).toMatch(/transition:\s*none\s*!important/);
    expect(block).toMatch(/animation:\s*none\s*!important/);
    expect(block).toMatch(/\.clarity-skeleton \.skeleton\s*\{[^}]*animation:\s*none/);
  });

  it('adds no motion outside the reduced-motion block', () => {
    const rest = clarityStyles.replace(reducedBlock(clarityStyles), '');
    expect(rest).not.toMatch(/@keyframes|animation\s*:|transition\s*:/);
  });

  it('turns off the shared skeleton shimmer it relies on', () => {
    expect(reducedBlock(appStyles)).toBeTruthy();
    expect(appStyles).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.skeleton\s*\{\s*animation:\s*none;/);
  });
});

// ---------------------------------------------------------------------------
// Initial region failures
// ---------------------------------------------------------------------------

describe('initial region failures (Requirements 10.14, 10.15)', () => {
  function Region({ regionKey, label }: { regionKey: string; label: string }) {
    const query = useQuery({
      queryKey: ['region-test', regionKey],
      queryFn: async () => {
        const response = await fetch(`/region/${regionKey}`);
        if (!response.ok) throw new Error(`${label} is unavailable (${response.status}).`);
        return (await response.json()) as { text: string };
      },
    });
    return (
      <RegionBoundary
        regionKey={regionKey}
        label={label}
        hasData={query.data !== undefined}
        loading={query.isFetching}
        error={query.error ?? undefined}
        onRetry={() => { void query.refetch(); }}
        minHeight={120}
      >
        {query.data && <OutcomeCard outcome={makeOutcome({ id: `${regionKey}:2026-01` })} title={`${label} outcome`} valueSummary={query.data.text} />}
      </RegionBoundary>
    );
  }

  function Page() {
    return (
      <div>
        <nav aria-label="Primary">
          <Link to="/home">Home</Link>
          <Link to="/plan">Plan</Link>
        </nav>
        <main>
          <h1>Spending</h1>
          <Region regionKey="summary" label="Monthly summary" />
          <Region regionKey="goals" label="Goals" />
          <Region regionKey="trips" label="Trips" />
        </main>
      </div>
    );
  }

  function install() {
    const gates = { summary: deferred<Response>(), goals: deferred<Response>(), trips: deferred<Response>() };
    const calls: Record<string, number> = { summary: 0, goals: 0, trips: 0 };
    const fetchMock = vi.mocked(globalThis.fetch);
    const summaryResponses: Array<() => Response | Promise<Response>> = [
      () => createApiResponse({ body: { message: 'boom' }, status: 500 }),
      () => createApiResponse({ body: { text: '₹7,000' } }),
    ];
    fetchMock.mockImplementation(async (input) => {
      const key = String(input).replace('/region/', '') as keyof typeof gates;
      calls[key] = (calls[key] ?? 0) + 1;
      if (key === 'summary') {
        const next = summaryResponses.shift();
        if (!next) throw new Error('unexpected summary request');
        return next();
      }
      return gates[key].promise;
    });
    return { gates, calls };
  }

  it('keeps navigation and loaded regions, confines the failure and the placeholder to their own regions, and retries only the failed region', async () => {
    const user = userEvent.setup();
    const { gates, calls } = install();
    renderAuthenticated(<Page />);

    const nav = screen.getByRole('navigation', { name: 'Primary' });
    const summary = screen.getByRole('group', { name: 'Monthly summary' });
    const goals = screen.getByRole('group', { name: 'Goals' });
    const trips = screen.getByRole('group', { name: 'Trips' });

    // Goals loads; Trips is still pending; Summary fails.
    await act(async () => { gates.goals.resolve(createApiResponse({ body: { text: '₹3,000' } })); });
    await within(summary).findByText('Monthly summary could not load.');

    // Failed region: error and one retry inside it.
    expect(within(summary).getByRole('alert')).toHaveTextContent('Monthly summary is unavailable (500).');
    expect(within(summary).getAllByRole('button')).toHaveLength(1);
    expect(within(summary).getByRole('button', { name: 'Retry loading Monthly summary' })).toBeInTheDocument();
    // Exactly one alert on the page, so no page-level error replaced anything.
    expect(screen.getAllByRole('alert')).toHaveLength(1);

    // Loaded region is preserved.
    expect(within(goals).getByText('₹3,000')).toBeInTheDocument();
    expect(within(goals).queryByRole('button')).not.toBeInTheDocument();
    expect(goals).not.toHaveAttribute('aria-busy');

    // Pending region: a placeholder confined to it, with reserved height.
    expect(within(trips).getByTestId('region-skeleton')).toHaveTextContent('Loading Trips…');
    expect(trips).toHaveAttribute('aria-busy', 'true');
    expect(screen.getAllByTestId('region-skeleton')).toHaveLength(1);
    expect(within(trips).getByTestId('region-skeleton')).toHaveStyle({ minHeight: '120px' });
    expect(within(summary).getByRole('alert')).toHaveStyle({ minHeight: '120px' });

    // Navigation stays present and operable throughout.
    expect(nav).toBeInTheDocument();
    expect(within(nav).getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual(['/home', '/plan']);
    await user.tab();
    expect(within(nav).getByRole('link', { name: 'Home' })).toHaveFocus();

    // Retry runs only the failed region's request.
    const goalsBefore = within(goals).getByText('₹3,000');
    await user.click(within(summary).getByRole('button', { name: 'Retry loading Monthly summary' }));
    await within(summary).findByText('₹7,000');
    expect(calls).toEqual({ summary: 2, goals: 1, trips: 1 });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(within(goals).getByText('₹3,000')).toBe(goalsBefore);
    expect(within(trips).getByTestId('region-skeleton')).toBeInTheDocument();
    expect(nav).toBeInTheDocument();

    // The slow region later arrives without disturbing the others.
    await act(async () => { gates.trips.resolve(createApiResponse({ body: { text: '₹900' } })); });
    await within(trips).findByText('₹900');
    expect(within(summary).getByText('₹7,000')).toBeInTheDocument();
    expect(within(goals).getByText('₹3,000')).toBe(goalsBefore);
  });

  it('keeps the last confirmed values when a later refresh of a loaded region fails', () => {
    const { rerender } = renderAuthenticated(
      <div>
        <RegionBoundary regionKey="a" label="Goals" hasData><p>goal list</p></RegionBoundary>
        <RegionBoundary regionKey="b" label="Trips" hasData><p>trip list</p></RegionBoundary>
      </div>,
    );
    rerender(
      <div>
        <RegionBoundary regionKey="a" label="Goals" hasData error={new Error('Offline')} onRetry={() => {}}><p>goal list</p></RegionBoundary>
        <RegionBoundary regionKey="b" label="Trips" hasData><p>trip list</p></RegionBoundary>
      </div>,
    );
    const goals = screen.getByRole('group', { name: 'Goals' });
    expect(within(goals).getByText('goal list')).toBeInTheDocument();
    expect(within(goals).getByText('Refresh failed.')).toBeInTheDocument();
    expect(within(goals).getAllByRole('button')).toHaveLength(1);
    expect(within(screen.getByRole('group', { name: 'Trips' })).queryByRole('button')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Light and dark axe checks
// ---------------------------------------------------------------------------

describe.each(['light', 'dark'] as const)('axe in the %s theme (Requirements 12.2, 12.5, 12.15, 12.16)', (theme) => {
  beforeEach(() => {
    // Same attribute the app sets in Shell and main.tsx.
    document.documentElement.dataset.theme = theme;
  });
  afterEach(() => {
    delete document.documentElement.dataset.theme;
  });

  function AllStates() {
    return (
      <main>
        <DecisionActionHeader title="Spending" decision="Does current spending fit the monthly plan?" action={INSIGHT} />
        {ALL_STATUSES.map((status) => (
          <OutcomeCard
            key={status}
            outcome={makeOutcome({
              id: `monthly-plan:${status}`,
              status,
              classification: status === 'available' ? 'recommendation' : 'calculated_result',
              missing: [{ input: 'salary', unlocks: ['monthly_plan'] }],
              invalid: [{ input: 'salary', constraint: 'a positive amount', affects: ['monthly_plan'] }],
              stale: { sourcePeriod: '2025-12', requestedPeriod: '2026-01' },
              sourceRefs: [{
                ref: 'salary',
                sourceType: 'salary',
                recordId: 1,
                field: 'amount',
                label: 'Salary',
                value: { currency: 'INR', amountMinor: 5000000 },
                classification: 'entered_fact',
              }],
              explanationRef: status === 'available' ? { outcomeId: 'monthly-plan:available', dataVersion: 3 } : undefined,
            })}
            title={`Plan ${status}`}
            headingLevel={2}
            valueSummary="₹12,000"
            onRetry={() => {}}
            refreshing={status === 'stale'}
            correctiveAction={<ActionLink label="Fix salary" to="/plan" />}
            actions={status === 'available' ? [INSIGHT] : undefined}
            defaultExplanationOpen={status === 'available'}
          />
        ))}
        <RegionBoundary regionKey="loading" label="Trips" hasData={false} loading><p>x</p></RegionBoundary>
        <RegionBoundary regionKey="failed" label="Goals" hasData={false} error={new Error('Offline')} onRetry={() => {}}><p>x</p></RegionBoundary>
        <RegionBoundary regionKey="refresh" label="Bills" hasData error={new Error('Offline')} onRetry={() => {}}><p>bills</p></RegionBoundary>
        <form>
          <label htmlFor="salary">Salary</label>
          <input id="salary" defaultValue="-5" {...fieldErrorProps('salary-error', true)} />
          <FieldError id="salary-error" field="Salary" reason="must be above 0." correction="Enter an amount from 1 to 10,00,00,000." />
        </form>
        <SaveGoalHarness />
      </main>
    );
  }

  it('has no violations with every outcome status, region state, field error, and mutation failure', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockImplementation(async (input) => {
      if (String(input).includes('/finance/explanations/')) return createApiResponse({ body: makeExplanation(3, 5000000) });
      throw new TypeError('network down');
    });

    const { container } = renderWithMutations(<AllStates />);
    expect(document.documentElement.dataset.theme).toBe(theme);

    await user.click(screen.getByRole('button', { name: 'Save goal' }));
    await screen.findByText('Saving goal: failed.');
    await screen.findByText('Steps, in order');

    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no violations in the loading and refreshing states', async () => {
    const { container } = renderAuthenticated(
      <main>
        <RegionSkeleton label="Goals" />
        <OutcomeCard outcome={makeOutcome({ status: 'stale' })} title="Plan" valueSummary="₹1" refreshing retrying onRetry={() => {}} />
      </main>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});

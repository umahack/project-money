import { readFileSync } from 'node:fs';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ExplanationResponse,
  MoneyValue,
  TodayAllowanceOutcome,
  TodayAllowanceValue,
} from '../../clarity/contracts';
import { formatInr } from '../../clarity/quickAdd/amount';
import { axe, createApiResponse, fc, renderAuthenticated } from '../../test/test-utils';
import { SNAPSHOT_RETRY, TodayHeadline, formatPermille, type TodayHeadlineProps } from './TodayHeadline';
type ApplicableValue = Extract<TodayAllowanceValue, { applicable: true }>;
const css = readFileSync('src/components/dashboard/todayHeadline.css', 'utf8');
const money = (amountMinor: number): MoneyValue => ({ currency: 'INR', amountMinor });
const OUTCOME_ID = 'today-allowance:2026-11';
/** The design's example: allowance ₹503.46, spent ₹45, left ₹458.46, 8.9 percent used. */
function makeValue(overrides: Partial<ApplicableValue> = {}): ApplicableValue {
  return {
    applicable: true,
    date: '2026-11-18',
    daysRemainingInclusive: 13,
    todayAllowance: money(50346),
    todaySpent: money(4500),
    leftToday: money(45846),
    overToday: money(0),
    allowanceBasis: money(654500),
    usedPermille: 89,
    zeroReason: null,
    usedBeyondBudget: money(0),
    excludedToday: { count: 0, total: money(0) },
    largeEntryThreshold: money(100000),
    ...overrides,
  };
}
function makeOutcome(overrides: Partial<TodayAllowanceOutcome> = {}): TodayAllowanceOutcome {
  return {
    id: OUTCOME_ID,
    kind: 'today_allowance',
    status: 'available',
    classification: 'calculated_result',
    dataVersion: 3,
    period: { month: '2026-11', start: '2026-11-01', endExclusive: '2026-12-01', timeZone: 'Asia/Kolkata' },
    value: makeValue(),
    sourceRefs: [],
    explanationRef: { outcomeId: OUTCOME_ID, dataVersion: 3 },
    ...overrides,
  };
}
const OVER_VALUE = makeValue({
  todaySpent: money(80000),
  leftToday: money(-29654),
  overToday: money(29654),
  usedPermille: 1000,
});
const ZERO_BASE = {
  todayAllowance: money(0),
  todaySpent: money(0),
  leftToday: money(0),
  overToday: money(0),
  usedPermille: null,
} as const;
function props(overrides: Partial<TodayHeadlineProps> = {}): TodayHeadlineProps {
  return { outcome: makeOutcome(), hasSnapshot: true, today: '2026-11-18', ...overrides };
}
function renderHeadline(overrides: Partial<TodayHeadlineProps> = {}, ui?: (element: ReactElement) => ReactElement) {
  const element = <TodayHeadline {...props(overrides)} />;
  return renderAuthenticated(ui ? ui(element) : element);
}
function explanation(dataVersion: number, amountMinor: number): ExplanationResponse {
  return {
    schemaVersion: 1,
    explanation: {
      schemaVersion: 1,
      outcomeId: OUTCOME_ID,
      kind: 'today_allowance',
      status: 'available',
      classification: 'calculated_result',
      dataVersion,
      period: { month: '2026-11', start: '2026-11-01', endExclusive: '2026-12-01', timeZone: 'Asia/Kolkata' },
      currency: 'INR',
      precisionMinor: 1,
      sourceRefs: [{
        ref: 'spendable',
        order: 1,
        sourceType: 'salary',
        recordId: 1,
        field: 'amount',
        label: 'Spendable budget',
        value: money(amountMinor),
        classification: 'entered_fact',
      }],
      operations: [{
        order: 1,
        operation: 'divide',
        operandRefs: ['spendable'],
        divisor: 13,
        result: money(amountMinor),
        explanationKey: 'today_allowance.divide_days',
      }],
      rounding: { precisionMinor: 1, direction: 'half_up', adjustmentMinor: 0 },
    },
  } as unknown as ExplanationResponse;
}
const main = (root: HTMLElement) => root.querySelector('.today-headline-main')!;
const left = (root: HTMLElement) => root.querySelector('.today-headline-left');
const announcement = (root: HTMLElement) => root.querySelector('article > p.sr-only[role="status"]')!;
describe('formatPermille', () => {
  it.each([
    [0, '0'],
    [5, '0.5'],
    [89, '8.9'],
    [100, '10'],
    [101, '10.1'],
    [999, '99.9'],
    [1000, '100'],
  ])('writes %i tenths of a percent as %s', (permille, text) => {
    expect(formatPermille(permille)).toBe(text);
  });
  it.each([null, undefined, -1, 1001, 8.5, Number.NaN])('has no text for %s', (permille) => {
    expect(formatPermille(permille as number | null)).toBeNull();
  });
});
describe('TodayHeadline: available (Requirements 11.2 to 11.5, 11.17)', () => {
  it('shows the allowance, left today, spent today with the date, the progress text, and the labels', () => {
    const { container } = renderHeadline();
    expect(main(container).textContent).toBe('You can spend ₹503.46 today');
    expect(left(container)?.textContent).toBe('₹458.46 left today');
    expect(left(container)).toBe(main(container).nextElementSibling);
    expect(screen.getByText(/Spent today/).textContent).toMatch(/^Spent today ₹45 on 18 Nov 2026/);
    expect(container.querySelector('time')).toHaveAttribute('datetime', '2026-11-18');
    expect(screen.getByText("8.9% of today's allowance used")).toBeInTheDocument();
    // Calculated-result labels: the card's own label and the note on the spent amount.
    expect(screen.getByText('Calculated result')).toBeInTheDocument();
    expect(screen.getByText(/Calculated from your confirmed expenses/)).toBeInTheDocument();
    expect(screen.getByText('Confirmed')).toBeInTheDocument();
    expect(screen.getByRole('article', { name: "Today's allowance" })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: "Today's allowance", level: 2 })).toBeInTheDocument();
  });
  it('fills the bar from the server share and hides the bar from assistive technology', () => {
    const { container } = renderHeadline();
    const track = container.querySelector('.today-headline-track')!;
    expect(track).toHaveAttribute('aria-hidden', 'true');
    expect(track.querySelector('.today-headline-fill')).toHaveStyle({ width: '8.9%' });
    expect(within(track as HTMLElement).queryByText(/./)).toBeNull();
    // The meaning is in text outside the hidden bar, and the bar has no role of its own.
    expect(container.querySelector('[role="progressbar"], [role="meter"], progress, meter')).toBeNull();
  });
  it('shows no not-counted line when nothing is excluded', () => {
    renderHeadline();
    expect(screen.queryByText(/not counted today/)).not.toBeInTheDocument();
  });
  it('shows the number and total of expenses not counted today (Requirement 11.20)', () => {
    const { rerender } = renderHeadline({
      outcome: makeOutcome({ value: makeValue({ excludedToday: { count: 1, total: money(120000) } }) }),
    });
    expect(screen.getByText('1 expense not counted today (₹1,200)')).toBeInTheDocument();
    rerender(<TodayHeadline {...props({ outcome: makeOutcome({ value: makeValue({ excludedToday: { count: 3, total: money(120050) } }) }) })} />);
    expect(screen.getByText('3 expenses not counted today (₹1,200.50)')).toBeInTheDocument();
  });
});
describe('TodayHeadline: over today (Requirement 11.6)', () => {
  it('replaces "left today" with the server excess and fills the bar to 100 percent', () => {
    const { container } = renderHeadline({ outcome: makeOutcome({ value: OVER_VALUE }) });
    expect(main(container).textContent).toBe('You can spend ₹503.46 today');
    expect(left(container)?.textContent).toBe("!Over today's allowance by ₹296.54");
    expect(screen.queryByText(/left today/)).not.toBeInTheDocument();
    expect(screen.getByText("100% of today's allowance used")).toBeInTheDocument();
    expect(container.querySelector('.today-headline-fill')).toHaveStyle({ width: '100%' });
    expect(screen.getByText(/Spent today/).textContent).toMatch(/^Spent today ₹800 on/);
    // The "!" is decorative; the words carry the status.
    expect(container.querySelector('.today-headline-glyph')).toHaveAttribute('aria-hidden', 'true');
  });
});
describe('TodayHeadline: zero allowance (Requirement 11.7)', () => {
  it('month_budget_used names the amount used beyond the budget and omits the percentage', () => {
    const { container } = renderHeadline({
      outcome: makeOutcome({
        value: makeValue({ ...ZERO_BASE, zeroReason: 'month_budget_used', usedBeyondBudget: money(123450) }),
      }),
    });
    expect(main(container).textContent).toBe('You can spend ₹0 today');
    expect(screen.getByText("This month's spendable budget was already used before today, by ₹1,234.50.")).toBeInTheDocument();
    expect(container.querySelector('.today-headline-progress')).toBeNull();
    expect(container.textContent).not.toMatch(/%/);
    expect(screen.queryByText(/left today/)).not.toBeInTheDocument();
  });
  it('no_spendable_budget says the bills use all of the pay and links to the Plan bills form', () => {
    renderHeadline({ outcome: makeOutcome({ value: makeValue({ ...ZERO_BASE, zeroReason: 'no_spendable_budget' }) }) });
    expect(screen.getByText('Your bills use all of your pay this month.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Review monthly bills/ })).toHaveAttribute('href', '/plan#bills-form');
  });
  it('below_minimum_unit says what is left is under one paisa a day', () => {
    renderHeadline({ outcome: makeOutcome({ value: makeValue({ ...ZERO_BASE, zeroReason: 'below_minimum_unit' }) }) });
    expect(screen.getByText('What is left is less than ₹0.01 a day.')).toBeInTheDocument();
  });
  it('shows the over text when something was spent against a zero allowance', () => {
    const { container } = renderHeadline({
      outcome: makeOutcome({
        value: makeValue({
          ...ZERO_BASE,
          todaySpent: money(5000),
          leftToday: money(-5000),
          overToday: money(5000),
          zeroReason: 'no_spendable_budget',
        }),
      }),
    });
    expect(left(container)?.textContent).toBe("!Over today's allowance by ₹50");
    expect(container.textContent).not.toMatch(/%/);
  });
});
describe('TodayHeadline: missing, invalid, and failed outcomes (Requirements 11.8, 11.9, 11.10)', () => {
  it('missing pay says the pay is needed and links to the Plan pay form', () => {
    const { container } = renderHeadline({
      outcome: makeOutcome({
        status: 'missing_input',
        value: undefined,
        missing: [{ input: 'salary', unlocks: ['monthly_plan', 'spending'] }],
        explanationRef: undefined,
      }),
    });
    expect(screen.getByText("Add this month's pay to see what you can spend today.")).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Add this month’s pay/ }).getAttribute('href')).toMatch(/^\/plan#pay-form/);
    expect(screen.getByText('Needs input')).toBeInTheDocument();
    expect(container.querySelector('.today-headline-main')).toBeNull();
  });
  it('an invalid input names the input, the accepted constraint, and the affected outcome', () => {
    renderHeadline({
      outcome: makeOutcome({
        status: 'invalid_input',
        value: undefined,
        invalid: [{ input: 'salary', constraint: 'an amount above zero', affects: ['monthly_plan', 'spending'] }],
        explanationRef: undefined,
      }),
    });
    const card = screen.getByRole('article', { name: "Today's allowance" });
    expect(card).toHaveTextContent('Salary must be: an amount above zero.');
    expect(card).toHaveTextContent('This affects your monthly plan and spending guidance.');
    expect(card).toHaveTextContent('what you can spend today is not shown');
    expect(screen.getByText('Needs correction')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /pay/i }).getAttribute('href')).toMatch(/^\/plan#pay-form/);
  });
  it('a failed calculation says temporarily unavailable, keeps the confirmed inputs, and offers one retry', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    renderHeadline({
      onRetry,
      outcome: makeOutcome({
        status: 'calculation_failed',
        value: undefined,
        explanationRef: undefined,
        retry: { action: 'recalculate', scopeKey: `outcome:${OUTCOME_ID}` },
        sourceRefs: [{
          ref: 'salary',
          sourceType: 'salary',
          recordId: 1,
          field: 'amount',
          label: 'Salary for November 2026',
          value: money(5000000),
          classification: 'entered_fact',
        }],
      }),
    });
    const card = screen.getByRole('article', { name: "Today's allowance" });
    expect(within(card).getAllByText('Temporarily unavailable').length).toBeGreaterThan(0);
    expect(card).toHaveTextContent('Your entered values (kept):');
    expect(card).toHaveTextContent('Salary for November 2026');
    const retries = within(card).getAllByRole('button').filter((button) => button.classList.contains('clarity-retry'));
    expect(retries).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: "Recalculate Today's allowance" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith({ action: 'recalculate', scopeKey: `outcome:${OUTCOME_ID}` });
  });
  it('shows server text as plain text, never as markup', () => {
    const { container } = renderHeadline({
      outcome: makeOutcome({
        status: 'calculation_failed',
        value: undefined,
        explanationRef: undefined,
        sourceRefs: [{
          ref: 'salary',
          sourceType: 'salary',
          recordId: 1,
          field: 'amount',
          label: '<img src=x onerror=alert(1)>Salary',
          value: money(5000000),
          classification: 'entered_fact',
        }],
      }),
    });
    expect(container.querySelector('img')).toBeNull();
    expect(container).toHaveTextContent('<img src=x onerror=alert(1)>Salary');
  });
});
describe('TodayHeadline: server without the field and other months (Requirement 16.7)', () => {
  it('shows the unavailable state with one retry that re-reads the snapshot when the outcome is absent', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const { container } = renderHeadline({ outcome: undefined, onRetry });
    const section = container.querySelector('[data-state="unavailable"]') as HTMLElement;
    expect(section).toHaveAttribute('data-reason', 'no_field');
    expect(section).toHaveTextContent('Temporarily unavailable.');
    expect(section).toHaveTextContent('You can still save expenses, and your monthly answer still works.');
    expect(container.querySelector('.today-headline-main')).toBeNull();
    expect(within(section).getAllByRole('button')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: "Refresh Today's allowance" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(SNAPSHOT_RETRY);
  });
  it('treats null like absent and offers no retry when none is wired', () => {
    const { container } = renderHeadline({ outcome: null });
    expect(container.querySelector('[data-state="unavailable"]')).not.toBeNull();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
  it('treats a not_current_month value as unavailable instead of showing numbers', () => {
    const { container } = renderHeadline({
      outcome: makeOutcome({ value: { applicable: false, reason: 'not_current_month' } }),
      onRetry: vi.fn(),
    });
    expect(container.querySelector('[data-reason="not_current_month"]')).not.toBeNull();
    expect(container).toHaveTextContent("Today's allowance is shown for the current month only.");
    expect(container.textContent).not.toMatch(/You can spend/);
  });
  it('treats an available outcome with malformed values as unavailable', () => {
    const { container } = renderHeadline({
      outcome: makeOutcome({ value: makeValue({ todayAllowance: { currency: 'INR', amountMinor: 12.5 } }) }),
    });
    expect(container.querySelector('[data-reason="no_field"]')).not.toBeNull();
    expect(container.textContent).not.toMatch(/NaN|undefined/);
  });
});
describe('TodayHeadline: stale, refreshing, and region states (Requirements 11.11, 11.12, 11.14)', () => {
  it('marks values stale in text when the values are for an earlier date, keeping the values and one refresh', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const { container } = renderHeadline({ today: '2026-11-19', onRetry });
    expect(main(container).textContent).toBe('You can spend ₹503.46 today');
    const card = screen.getByRole('article', { name: "Today's allowance" });
    expect(within(card).getByText('Stale', { selector: '.clarity-status' })).toBeInTheDocument();
    expect(card).toHaveTextContent('Showing 18 Nov 2026; 19 Nov 2026 was requested.');
    await user.click(screen.getByRole('button', { name: "Refresh Today's allowance" }));
    expect(onRetry).toHaveBeenCalledWith({ action: 'refresh', scopeKey: `outcome:${OUTCOME_ID}` });
  });
  it('is not stale on the same date or when the date is unknown', () => {
    const { rerender } = renderHeadline();
    expect(screen.queryByText('Stale')).not.toBeInTheDocument();
    rerender(<TodayHeadline {...props({ today: undefined })} />);
    expect(screen.queryByText('Stale')).not.toBeInTheDocument();
  });
  it('keeps the values and shows the server stale state as text', () => {
    const { container } = renderHeadline({
      outcome: makeOutcome({
        status: 'stale',
        stale: { sourcePeriod: '2026-10', requestedPeriod: '2026-11' },
      }),
    });
    expect(main(container).textContent).toBe('You can spend ₹503.46 today');
    expect(screen.getByRole('article')).toHaveTextContent('Stale.');
  });
  it('keeps the last confirmed values and says "Refresh failed" when a refresh fails', () => {
    const { container } = renderHeadline({
      outcome: makeOutcome({ status: 'refresh_failed' }),
      onRetry: vi.fn(),
    });
    expect(main(container).textContent).toBe('You can spend ₹503.46 today');
    expect(screen.getByRole('article')).toHaveTextContent('Refresh failed. Showing your last confirmed values.');
    expect(screen.getByRole('button', { name: "Retry refresh Today's allowance" })).toBeInTheDocument();
  });
  it('shows a size-stable placeholder inside the region while the first read is pending', () => {
    const { container } = renderHeadline({ outcome: undefined, hasSnapshot: false, loading: true });
    expect(screen.getByTestId('region-skeleton')).toHaveStyle({ minHeight: '176px' });
    expect(screen.getByText("Loading Today's allowance…")).toBeInTheDocument();
    expect(container.querySelector('[data-region="today"]')).toHaveAttribute('aria-busy', 'true');
  });
  it('shows an error with one retry inside the region when the first read fails', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    renderHeadline({ outcome: undefined, hasSnapshot: false, error: new Error('Offline'), onRetry });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent("Today's allowance could not load.");
    expect(within(alert).getAllByRole('button')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: "Retry loading Today's allowance" }));
    expect(onRetry).toHaveBeenCalledWith(SNAPSHOT_RETRY);
  });
  it('keeps the confirmed values while a read is running and when it fails', () => {
    const { container, rerender } = renderHeadline({ loading: true });
    expect(main(container).textContent).toBe('You can spend ₹503.46 today');
    expect(screen.getByText(/Refreshing Today's allowance…/)).toBeInTheDocument();
    rerender(<TodayHeadline {...props({ error: new Error('Offline'), onRetry: vi.fn() })} />);
    expect(main(container).textContent).toBe('You can spend ₹503.46 today');
    expect(screen.getByText(/Refresh failed\./)).toBeInTheDocument();
  });
});
describe('TodayHeadline: "How this was calculated" (Requirement 11.16)', () => {
  beforeEach(() => {
    vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('version=4')) return createApiResponse({ body: explanation(4, 650000) });
      if (url.includes('/finance/explanations/')) return createApiResponse({ body: explanation(3, 654500) });
      throw new TypeError('network down');
    });
  });
  it('opens with Enter, closes with Escape, and returns focus to the control', async () => {
    const user = userEvent.setup();
    renderHeadline();
    const toggle = screen.getByRole('button', { name: "How this was calculated for Today's allowance" });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    toggle.focus();
    await user.keyboard('{Enter}');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const panel = await screen.findByRole('group', { name: "How Today's allowance was calculated" });
    expect(await within(panel).findByText('Steps, in order')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveFocus();
    await user.keyboard(' ');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });
  it('stays open, in the same panel, while the values update to a new version', async () => {
    const user = userEvent.setup();
    const { container, rerender } = renderHeadline();
    const toggle = screen.getByRole('button', { name: /How this was calculated/ });
    await user.click(toggle);
    const panel = await screen.findByRole('group', { name: "How Today's allowance was calculated" });
    await within(panel).findByText(/Data version 3/);
    rerender(
      <TodayHeadline
        {...props({
          outcome: makeOutcome({
            dataVersion: 4,
            explanationRef: { outcomeId: OUTCOME_ID, dataVersion: 4 },
            value: makeValue({
              todayAllowance: money(50000),
              todaySpent: money(10000),
              leftToday: money(40000),
              usedPermille: 200,
            }),
          }),
        })}
      />,
    );
    expect(main(container).textContent).toBe('You can spend ₹500 today');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('group', { name: "How Today's allowance was calculated" })).toBe(panel);
    await waitFor(() => expect(within(panel).getByText(/Data version 4/)).toBeInTheDocument());
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });
  it('offers no explanation control in the unavailable state', () => {
    renderHeadline({ outcome: undefined });
    expect(screen.queryByRole('button', { name: /How this was calculated/ })).not.toBeInTheDocument();
  });
});
describe('TodayHeadline: announcements (Requirement 12.3 and the clarity live-region convention)', () => {
  it('says nothing at first or when the values did not change, and announces a changed value once', () => {
    const { container, rerender } = renderHeadline();
    expect(announcement(container).textContent).toBe('');
    // A new data version with the same values announces nothing.
    rerender(<TodayHeadline {...props({ outcome: makeOutcome({ dataVersion: 4 }) })} />);
    expect(announcement(container).textContent).toBe('');
    rerender(
      <TodayHeadline
        {...props({
          outcome: makeOutcome({
            dataVersion: 5,
            value: makeValue({ todaySpent: money(9000), leftToday: money(41346), usedPermille: 179 }),
          }),
        })}
      />,
    );
    expect(announcement(container)).toHaveTextContent('You can spend ₹503.46 today. ₹413.46 left today.');
    expect(announcement(container)).toHaveTextContent('Calculated result');
  });
  it('does not move focus when a value changes', async () => {
    const { rerender } = renderHeadline({ onRetry: vi.fn(), outcome: makeOutcome({ status: 'refresh_failed' }) });
    const retry = screen.getByRole('button', { name: /Retry refresh/ });
    retry.focus();
    expect(retry).toHaveFocus();
    rerender(
      <TodayHeadline
        {...props({
          onRetry: vi.fn(),
          outcome: makeOutcome({
            status: 'refresh_failed',
            value: makeValue({ todaySpent: money(9000), leftToday: money(41346), usedPermille: 179 }),
          }),
        })}
      />,
    );
    expect(screen.getByRole('button', { name: /Retry refresh/ })).toHaveFocus();
  });
});
describe('TodayHeadline: numbers come only from server fields (Requirement 10.8 and "no money arithmetic")', () => {
  it('shows the server left, over, and share even when they do not agree with the other fields', () => {
    // These values are deliberately inconsistent. A component that did its own arithmetic would show others.
    const { container } = renderHeadline({
      outcome: makeOutcome({
        value: makeValue({
          todayAllowance: money(100000),
          todaySpent: money(30000),
          leftToday: money(12345),
          overToday: money(0),
          usedPermille: 777,
        }),
      }),
    });
    expect(left(container)?.textContent).toBe('₹123.45 left today');
    expect(screen.getByText("77.7% of today's allowance used")).toBeInTheDocument();
    expect(container.querySelector('.today-headline-fill')).toHaveStyle({ width: '77.7%' });
  });
  it('shows no percentage when the server sends no share for a positive allowance', () => {
    const { container } = renderHeadline({ outcome: makeOutcome({ value: makeValue({ usedPermille: null }) }) });
    expect(container.querySelector('.today-headline-progress')).toBeNull();
    expect(main(container).textContent).toBe('You can spend ₹503.46 today');
  });
  const moneyArb = fc.integer({ min: 0, max: 9_999_999_999_999 });
  const reasonArb = fc.constantFrom<ApplicableValue['zeroReason']>(null, 'no_spendable_budget', 'month_budget_used', 'below_minimum_unit');
  it('property: every rupee amount on screen is the formatted value of a server field, and nothing else', () => {
    // **Validates: Requirements 11.2, 11.3, 11.6, 11.20**
    fc.assert(
      fc.property(
        moneyArb, moneyArb, fc.integer({ min: -9_999_999_999_999, max: 9_999_999_999_999 }), moneyArb,
        fc.option(fc.integer({ min: 0, max: 1000 }), { nil: null }),
        reasonArb, moneyArb, fc.integer({ min: 0, max: 40 }), moneyArb,
        (allowance, spent, leftToday, over, permille, zeroReason, beyond, excludedCount, excludedTotal) => {
          const value = makeValue({
            todayAllowance: money(allowance),
            todaySpent: money(spent),
            leftToday: money(leftToday),
            overToday: money(over),
            usedPermille: permille,
            zeroReason,
            usedBeyondBudget: money(beyond),
            excludedToday: { count: excludedCount, total: money(excludedTotal) },
          });
          const { container, unmount } = renderHeadline({ outcome: makeOutcome({ value }) });
          try {
            const shown = (container.textContent ?? '').match(/-?₹[\d,]+(?:\.\d{2})?/g) ?? [];
            const allowed = new Set<string>([formatInr(allowance), formatInr(spent), '₹0.01']);
            if (over > 0) allowed.add(formatInr(over));
            else if (allowance > 0) allowed.add(formatInr(leftToday));
            if (excludedCount > 0) allowed.add(formatInr(excludedTotal));
            if (allowance === 0 && zeroReason === 'month_budget_used') allowed.add(formatInr(beyond));
            for (const amount of shown) expect(allowed.has(amount), `${amount} is not a server value`).toBe(true);
            expect(main(container).textContent).toBe(`You can spend ${formatInr(allowance)} today`);
            if (over > 0) expect(left(container)?.textContent).toBe(`!Over today's allowance by ${formatInr(over)}`);
            else if (allowance > 0) expect(left(container)?.textContent).toBe(`${formatInr(leftToday)} left today`);
            else expect(left(container)).toBeNull();
            if (allowance === 0) expect(container.textContent).not.toMatch(/% of today/);
          } finally {
            unmount();
          }
        },
      ),
      { numRuns: 60 },
    );
  });
});
describe('TodayHeadline: not colour alone (Requirements 11.5, 12.8)', () => {
  it.each([
    ['available', makeOutcome(), /8\.9% of today's allowance used/, 'Confirmed'],
    ['over', makeOutcome({ value: OVER_VALUE }), /Over today's allowance by ₹296\.54/, 'Confirmed'],
    ['stale', makeOutcome({ status: 'stale' }), /Stale\./, 'Stale'],
    ['refresh failed', makeOutcome({ status: 'refresh_failed' }), /Refresh failed\./, 'Refresh failed'],
    ['failed', makeOutcome({ status: 'calculation_failed', value: undefined, explanationRef: undefined }), /Temporarily unavailable\./, 'Temporarily unavailable'],
  ] as const)('%s state has text for its meaning', (_name, outcome, text, badge) => {
    const { container } = renderHeadline({ outcome });
    expect(container).toHaveTextContent(text);
    expect(within(container).getAllByText(badge).length).toBeGreaterThan(0);
    // Every decorative glyph is hidden from assistive technology and sits beside text.
    for (const glyph of container.querySelectorAll('.clarity-glyph, .today-headline-glyph')) {
      expect(glyph).toHaveAttribute('aria-hidden', 'true');
    }
  });
  it('gives the over state a non-colour cue in the stylesheet and the markup', () => {
    expect(css).toMatch(/\.today-headline-over\s*\{[^}]*--tone: var\(--clarity-danger\)/);
    const { container } = renderHeadline({ outcome: makeOutcome({ value: OVER_VALUE }) });
    expect(container.querySelector('.today-headline-over .today-headline-glyph')?.textContent).toBe('!');
  });
});
describe('TodayHeadline: stylesheet (Requirements 12.7, 12.9, 12.10, 12.11)', () => {
  it('sizes every control to at least 44 by 44 CSS pixels at every width', () => {
    expect(css).toMatch(/\.today-headline-region :is\([^)]*\.btn[^)]*\.clarity-action-link[^)]*\.clarity-retry[^)]*\.clarity-disclosure[^)]*\)\s*\{\s*min-height:\s*44px;\s*min-width:\s*44px;/);
  });
  it('uses only the app tokens for colour, so both themes and contrast checks apply', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\b(rgb|hsl)a?\(/);
  });
  it('removes the bar transition for reduced motion', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.today-headline-fill\s*\{\s*transition:\s*none/);
  });
  it('lays out without fixed widths so 320 to 3840 px and 200 percent text do not scroll or clip', () => {
    // Widths are fractions of the container or rem-based, and the row wraps.
    expect(css).toMatch(/\.today-headline-row\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(css).toMatch(/\.today-headline-region\s*\{[^}]*min-width:\s*0/);
    expect(css).not.toMatch(/(?<![-\w])width:\s*\d+px/);
    expect(css).not.toMatch(/overflow-x:\s*(hidden|scroll)/);
  });
});
describe.each(['light', 'dark'] as const)('TodayHeadline: axe in the %s theme (Requirements 12.8, 12.9)', (theme) => {
  beforeEach(() => {
    document.documentElement.dataset.theme = theme;
  });
  afterEach(() => {
    delete document.documentElement.dataset.theme;
  });
  const CASES: Array<[string, Partial<TodayHeadlineProps>]> = [
    ['available', {}],
    ['over', { outcome: makeOutcome({ value: OVER_VALUE }) }],
    ['excluded', { outcome: makeOutcome({ value: makeValue({ excludedToday: { count: 2, total: money(120000) } }) }) }],
    ['zero: month_budget_used', { outcome: makeOutcome({ value: makeValue({ ...ZERO_BASE, zeroReason: 'month_budget_used', usedBeyondBudget: money(5000) }) }) }],
    ['zero: no_spendable_budget', { outcome: makeOutcome({ value: makeValue({ ...ZERO_BASE, zeroReason: 'no_spendable_budget' }) }) }],
    ['zero: below_minimum_unit', { outcome: makeOutcome({ value: makeValue({ ...ZERO_BASE, zeroReason: 'below_minimum_unit' }) }) }],
    ['missing pay', { outcome: makeOutcome({ status: 'missing_input', value: undefined, missing: [{ input: 'salary', unlocks: ['monthly_plan'] }], explanationRef: undefined }) }],
    ['invalid input', { outcome: makeOutcome({ status: 'invalid_input', value: undefined, invalid: [{ input: 'salary', constraint: 'an amount above zero', affects: ['monthly_plan'] }], explanationRef: undefined }) }],
    ['calculation failed', { onRetry: () => {}, outcome: makeOutcome({ status: 'calculation_failed', value: undefined, explanationRef: undefined }) }],
    ['stale by date', { today: '2026-11-19', onRetry: () => {} }],
    ['refresh failed', { outcome: makeOutcome({ status: 'refresh_failed' }), onRetry: () => {} }],
    ['server without field', { outcome: undefined, onRetry: () => {} }],
    ['not current month', { outcome: makeOutcome({ value: { applicable: false, reason: 'not_current_month' } }) }],
    ['loading', { outcome: undefined, hasSnapshot: false, loading: true }],
    ['region error', { outcome: undefined, hasSnapshot: false, error: new Error('Offline'), onRetry: () => {} }],
    ['refreshing with values', { loading: true }],
  ];
  it.each(CASES)('has no violations: %s', async (_name, overrides) => {
    const { container, unmount } = renderHeadline(overrides, (element) => <main>{element}</main>);
    expect(document.documentElement.dataset.theme).toBe(theme);
    expect(await axe(container)).toHaveNoViolations();
    unmount();
  });
  it('has no violations with the explanation open', async () => {
    const user = userEvent.setup();
    vi.mocked(globalThis.fetch).mockImplementation(async () => createApiResponse({ body: explanation(3, 654500) }));
    const { container } = renderHeadline({}, (element) => <main>{element}</main>);
    await user.click(screen.getByRole('button', { name: /How this was calculated/ }));
    await screen.findByText('Steps, in order');
    await act(async () => {});
    expect(await axe(container)).toHaveNoViolations();
  });
});

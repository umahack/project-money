import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Outcome, OutcomeStatus, ValueClassification } from '../../clarity/contracts';
import { renderAuthenticated } from '../../test/test-utils';
import { OutcomeCard } from './OutcomeCard';
import { ClassifiedValue } from './labels';

type Amount = { amount: number };

function outcome(overrides: Partial<Outcome<Amount>> = {}): Outcome<Amount> {
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

function renderCard(options: { outcome?: Outcome<Amount> } = {}) {
  renderAuthenticated(
    <OutcomeCard<Amount>
      outcome={options.outcome ?? outcome()}
      title="Monthly plan"
      renderValue={(value) => (
        <>
          <ClassifiedValue label="Remaining" classification="calculated_result" value={`₹${value.amount}`} emphasis />
          <ClassifiedValue label="Guide" classification="calculated_result" value="₹400" />
          <ClassifiedValue label="Pay" classification="entered_fact" value="₹50,000" />
        </>
      )}
    />,
  );
  return screen.getByRole('article', { name: 'Monthly plan' });
}

describe('OutcomeCard label line', () => {
  it('states the classification and the status once, as text, under the title', () => {
    const card = renderCard();

    const line = card.querySelector('.clarity-outcome-badges') as HTMLElement;
    expect(line).toHaveTextContent('Calculated result · ✓Confirmed');
    // Both stay text with their classes and data attributes, so tests and assistive technology can read them.
    expect(within(line).getByText('Calculated result')).toHaveAttribute('data-classification', 'calculated_result');
    expect(within(line).getByText('Confirmed')).toHaveAttribute('data-status', 'available');
    // The decorative separator is hidden from assistive technology.
    expect(line.querySelector('.clarity-meta-sep')).toHaveAttribute('aria-hidden', 'true');
    // The period is on the same compact block.
    expect(card.querySelector('.clarity-outcome-meta')).toHaveTextContent('Period: January 2026');
    // The label line comes after the title and before the values.
    const title = within(card).getByRole('heading', { name: 'Monthly plan' });
    expect(title.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(line.compareDocumentPosition(card.querySelector('.clarity-value') as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('does not repeat the classification as a visible badge on values that match the card', () => {
    const card = renderCard();

    // One visible "Calculated result" badge in the card: the header's.
    expect(card.querySelectorAll('.clarity-badge[data-classification="calculated_result"]')).toHaveLength(1);
    // Each matching value still names its classification for a screen reader, hidden visually.
    const remaining = within(card).getByText('Remaining').closest('.clarity-value') as HTMLElement;
    const hidden = remaining.querySelector('.sr-only') as HTMLElement;
    expect(hidden).toHaveTextContent('Calculated result');
    expect(remaining.querySelector('.clarity-badge')).toBeNull();
    expect(remaining).toHaveTextContent('Remaining');
    expect(remaining).toHaveTextContent('Calculated result');
    expect(remaining).toHaveTextContent('₹12000');
  });

  it('keeps a visible label on a value whose classification differs from the card', () => {
    const card = renderCard();

    const pay = within(card).getByText('Pay').closest('.clarity-value') as HTMLElement;
    const badge = pay.querySelector('.clarity-badge') as HTMLElement;
    expect(badge).toHaveTextContent('Entered fact');
    expect(badge).toHaveAttribute('data-classification', 'entered_fact');
    expect(pay.querySelector('.sr-only')).toBeNull();
  });

  it.each<[OutcomeStatus, string]>([
    ['stale', 'Stale'],
    ['refresh_failed', 'Refresh failed'],
    ['missing_input', 'Needs input'],
    ['invalid_input', 'Needs correction'],
    ['calculation_failed', 'Temporarily unavailable'],
  ])('shows the %s status as text in the same line', (status, label) => {
    const card = renderCard({ outcome: outcome({ status }) });

    const line = card.querySelector('.clarity-outcome-badges') as HTMLElement;
    expect(line).toHaveTextContent(`Calculated result · `);
    expect(within(line).getByText(label)).toHaveAttribute('data-status', status);
  });

  it.each<[ValueClassification, string]>([
    ['entered_fact', 'Entered fact'],
    ['calculated_result', 'Calculated result'],
    ['recommendation', 'Recommendation'],
  ])('labels a %s card once and hides the label on its matching values', (classification, label) => {
    renderAuthenticated(
      <OutcomeCard<Amount>
        outcome={outcome({ classification })}
        title="Card"
        renderValue={() => (
          <>
            <ClassifiedValue label="One" classification={classification} value="1" />
            <ClassifiedValue label="Two" classification={classification} value="2" />
          </>
        )}
      />,
    );
    const card = screen.getByRole('article', { name: 'Card' });

    expect(within(card).getAllByText(label, { selector: '.clarity-badge' })).toHaveLength(1);
    expect(within(card).getAllByText(label, { selector: '.sr-only' })).toHaveLength(2);
  });
});

describe('ClassifiedValue outside a card', () => {
  it('always shows its own visible label', () => {
    renderAuthenticated(<ClassifiedValue label="Disposable income change" classification="calculated_result" value="+₹1,000" />);

    const value = screen.getByText('Disposable income change').closest('.clarity-value') as HTMLElement;
    expect(within(value).getByText('Calculated result')).toHaveClass('clarity-badge');
    expect(value.querySelector('.sr-only')).toBeNull();
  });
});

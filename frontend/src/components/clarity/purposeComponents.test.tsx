import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PURPOSE_INPUT_KINDS, type ConfirmedState } from '../../clarity/purposeRegistry';
import { axe } from '../../test/test-utils';
import { InputBenefitPreview, PurposeExplanation, purposeExplanationId } from './index';

const CONFIRMED: ConfirmedState = {
  salary: {
    outcomes: {
      disposable_income: { currency: 'INR', amountMinor: 3000000 },
      daily_spending_guide: { currency: 'INR', amountMinor: 80000 },
    },
  },
};

describe('PurposeExplanation (Requirements 2.1 to 2.6, 2.10, 2.12, 12.10)', () => {
  it('marks a required input before the field and defines each outcome term', () => {
    render(<PurposeExplanation input="salary" />);
    const section = screen.getByRole('region', { name: /Why we ask for salary/ });
    expect(section).toHaveAttribute('data-requirement', 'required');
    expect(within(section).getByText('Required')).toBeInTheDocument();
    expect(within(section).queryByText('Optional')).not.toBeInTheDocument();
    expect(within(section).queryByRole('button')).not.toBeInTheDocument();
    expect(within(section).getAllByRole('listitem')).toHaveLength(8);
    expect(section).toHaveTextContent('Disposable income: the pay left after your monthly bills.');
    expect(section).toHaveTextContent('Daily spending guide: what is left to spend, divided by the days left this month.');
    expect(section).toHaveTextContent('Goal feasibility: whether a goal fits inside your savings target.');
  });

  it.each(PURPOSE_INPUT_KINDS)('renders %s with its own id for aria-describedby', (input) => {
    render(<PurposeExplanation input={input} />);
    expect(document.getElementById(purposeExplanationId(input))).toBeInTheDocument();
    expect(purposeExplanationId(input, 'custom')).toBe('custom');
  });

  it('marks a bill as optional, names the skip outcome, and reports it after skipping', async () => {
    const user = userEvent.setup();
    const onSkip = vi.fn();
    render(<PurposeExplanation input="bill" onSkip={onSkip} />);
    const section = screen.getByRole('region', { name: /Why we ask for bill/ });
    expect(within(section).getByText('Optional')).toBeInTheDocument();
    expect(section).toHaveTextContent(/If you skip: Nothing is saved or changed\. Disposable income stays as it is now/);
    const status = within(section).getByRole('status');
    expect(status).toBeEmptyDOMElement();
    const skip = within(section).getByRole('button', { name: 'Skip for now' });
    expect(skip).toHaveAccessibleDescription(/Disposable income stays as it is now/);
    await user.click(skip);
    await user.click(skip);
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(status).toHaveTextContent(/^Skipped\. Nothing is saved or changed\. Disposable income stays/);
  });

  it('supports keyboard skip and keeps focus on the skip control', async () => {
    const user = userEvent.setup();
    render(<PurposeExplanation input="bill" />);
    await user.tab();
    const skip = screen.getByRole('button', { name: 'Skip for now' });
    expect(skip).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(skip).toHaveFocus();
    expect(screen.getByRole('status')).toHaveTextContent(/^Skipped\./);
  });

  it('can be controlled by the caller', () => {
    const { rerender } = render(<PurposeExplanation input="bill" skipped={false} />);
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    rerender(<PurposeExplanation input="bill" skipped />);
    expect(screen.getByRole('status')).toHaveTextContent(/^Skipped\./);
  });

  it('renders nothing for an unknown input and never renders server markup', () => {
    const { container } = render(<PurposeExplanation input={'<img src=x onerror=alert(1)>' as never} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('InputBenefitPreview (Requirements 2.7 and 2.8)', () => {
  it('labels fixed values as an example when the user has none', () => {
    render(<InputBenefitPreview input="salary" />);
    const section = screen.getByRole('region', { name: /What salary unlocks/ });
    expect(section).toHaveAttribute('data-source', 'example');
    expect(within(section).getByText('Example, not your data.')).toBeInTheDocument();
    expect(within(section).getByText(/^Example: salary ₹50,000/)).toBeInTheDocument();
    expect(within(section).getAllByRole('term')).toHaveLength(8);
    expect(within(section).getAllByText('₹30,000', { selector: 'dd' })).toHaveLength(2);
  });

  it('shows confirmed values and no example when the user has a value', () => {
    render(<InputBenefitPreview input="salary" confirmed={CONFIRMED} />);
    const section = screen.getByRole('region', { name: /What salary unlocks/ });
    expect(section).toHaveAttribute('data-source', 'confirmed');
    expect(within(section).getByText('Based on your saved values.')).toBeInTheDocument();
    expect(within(section).queryByText('Example, not your data.')).not.toBeInTheDocument();
    expect(within(section).queryByText(/^Example:/)).not.toBeInTheDocument();
    expect(within(section).getByText('₹30,000', { selector: 'dd' })).toBeInTheDocument();
    expect(within(section).getByText('₹800', { selector: 'dd' })).toBeInTheDocument();
    expect(within(section).getAllByText('Not available yet')).toHaveLength(6);
  });

  it('renders hostile confirmed values as unavailable text, not markup', () => {
    const { container } = render(
      <InputBenefitPreview
        input="goal"
        confirmed={{ goal: { outcomes: { goal_funding_gap: '<img src=x onerror=alert(1)>' as never } } }}
      />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container).not.toHaveTextContent('onerror');
  });
});

describe.each(['light', 'dark'] as const)('purpose components axe in the %s theme', (theme) => {
  beforeEach(() => {
    document.documentElement.dataset.theme = theme;
  });
  afterEach(() => {
    delete document.documentElement.dataset.theme;
  });

  it('has no violations for every input, in example and confirmed states, and after skip', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <main>
        {PURPOSE_INPUT_KINDS.map((input) => (
          <form key={input} aria-label={`${input} form`}>
            <PurposeExplanation input={input} />
            <InputBenefitPreview input={input} />
            <label htmlFor={`${input}-field`}>Amount for {input}</label>
            <input id={`${input}-field`} aria-describedby={purposeExplanationId(input)} />
          </form>
        ))}
        <section aria-label="Confirmed">
          <InputBenefitPreview input="salary" confirmed={CONFIRMED} idPrefix="benefit-confirmed" />
        </section>
      </main>,
    );
    expect(document.documentElement.dataset.theme).toBe(theme);
    await user.click(screen.getByRole('button', { name: 'Skip for now' }));
    expect(await axe(container)).toHaveNoViolations();
  });
});

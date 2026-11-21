import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { parseJourneyView, type GuidedJourneyView } from '../../clarity/journeys';
import { queryKeys } from '../../clarity/queryClient';
import { skipEffect, skipEffectText } from '../../clarity/purposeRegistry';
import { createTestQueryClient, renderWithProviders } from '../../test/test-utils';
import { PurposeExplanation } from '../clarity/PurposeExplanation';
import { JourneyReturnLink } from './JourneyReturnLink';

function view(overrides: Record<string, unknown> = {}): GuidedJourneyView {
  return parseJourneyView({
    id: 1,
    desiredOutcome: 'settle_trip',
    status: 'active',
    requiredStepKeys: ['trip', 'trip_members', 'trip_split'],
    optionalStepKeys: ['personal_expense'],
    currentStepKey: 'trip_members',
    nextIncompleteStepKey: 'trip_members',
    progress: { requiredTotal: 3, requiredCompleted: 1, requiredRemaining: 2, currentStepNumber: 2 },
    steps: [
      { key: 'trip', required: true, status: 'satisfied', confirmedChangeId: null },
      { key: 'trip_members', required: true, status: 'pending', confirmedChangeId: null },
      { key: 'trip_split', required: true, status: 'pending', confirmedChangeId: null },
    ],
    firstOutcome: { available: false, kind: 'trip', outcomeId: null },
    ...overrides,
  });
}

function renderLink(data: GuidedJourneyView | null | undefined) {
  const queryClient = createTestQueryClient();
  if (data !== undefined) queryClient.setQueryData(queryKeys.journey(null), data);
  return renderWithProviders(<JourneyReturnLink />, { queryClient });
}

describe('JourneyReturnLink', () => {
  it('links back to the fixed journey route while a trip journey is open, with no value in the address', () => {
    renderLink(view());
    const link = screen.getByRole('link', { name: /Back to your guided journey: Add the people on the trip/ });
    expect(link).toHaveAttribute('href', '/start');
  });

  it('also links back for the optional trip step offered after the first result', () => {
    renderLink(view({ currentStepKey: 'personal_expense', firstOutcome: { available: true, kind: 'trip', outcomeId: 'trip:3' } }));
    expect(screen.getByRole('link', { name: /Include your share in monthly spending/ })).toHaveAttribute('href', '/start');
  });

  it.each([
    ['no journey has been loaded', undefined],
    ['there is no open journey', null],
    ['the journey is paused', view({ status: 'paused' })],
    ['the journey is not a trip journey', view({ desiredOutcome: 'plan_month', requiredStepKeys: ['salary'], optionalStepKeys: [], currentStepKey: 'salary', steps: [{ key: 'salary', required: true, status: 'pending', confirmedChangeId: null }], progress: { requiredTotal: 1, requiredCompleted: 0, requiredRemaining: 1, currentStepNumber: 1 } })],
    ['no step is waiting', view({ currentStepKey: null })],
  ])('shows nothing when %s', (_name, data) => {
    renderLink(data as GuidedJourneyView | null | undefined);
    expect(screen.queryByRole('link')).toBeNull();
  });
});

describe('optional purpose copy', () => {
  it('presents a normally required input as optional, with a skip that names the chosen outcome', () => {
    let skipped = 0;
    render(
      <MemoryRouter>
        <PurposeExplanation input="salary" asOptional={{ skipOutcome: 'goal_feasibility' }} skipped={false} onSkip={() => { skipped += 1; }} />
      </MemoryRouter>,
    );
    expect(screen.getByText('Optional')).toBeInTheDocument();
    expect(screen.queryByText('Required')).toBeNull();
    expect(screen.getByText(/If you skip: Nothing is saved or changed\. Goal feasibility stays as it is/)).toBeInTheDocument();
    expect(skipEffectText('goal_feasibility')).toContain('Goal feasibility stays as it is');
    screen.getByRole('button', { name: 'Skip for now' }).click();
    expect(skipped).toBe(1);
  });

  it('ignores a skip outcome the input does not affect and keeps the registry default', () => {
    render(<PurposeExplanation input="salary" asOptional={{ skipOutcome: 'trip_settlement' }} skipped={false} />);
    expect(screen.getByText(/Disposable income stays as it is/)).toBeInTheDocument();
  });

  it('leaves required inputs required and bill skip text unchanged', () => {
    render(<PurposeExplanation input="salary" />);
    expect(screen.getByText('Required')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Skip for now' })).toBeNull();
    expect(skipEffect('bill')?.text).toBe(skipEffectText('disposable_income'));
  });
});

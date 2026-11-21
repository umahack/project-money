import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ActionLink } from '../components/clarity/ActionLink';
import { DecisionActionHeader } from '../components/clarity/DecisionActionHeader';
import { MonthlyClaritySummary } from '../components/dashboard/MonthlyClaritySummary';
import { selectHomeSummary } from '../components/dashboard/homeSummary';
import { homeSnapshot, insight } from '../test/homeSummaryFixtures';
import { renderAuthenticated } from '../test/test-utils';
import { CLARITY_ACTION_KEYS } from './actionContext';
import {
  ACTION_COPY,
  actionEffectText,
  actionLabelText,
  actionObservationText,
  isPlainLanguage,
} from './actionCopy';
import type { ActionableInsight } from './contracts';

const MONTH = '2026-03';
/** Anything shaped like an internal name: snake_case, CONSTANT_CASE, camelCase, or a `type:key:id` reference. */
const IDENTIFIER = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b|\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b|\b[a-z]+(?:[A-Z][a-z0-9]*)+\b|\b[a-z][a-z-]*:[a-z0-9_-]+(?::[a-z0-9_-]+)+\b/;
const GOAL_ROUTE_CONTEXT = { recordType: 'goal', recordId: 7 } as const;
const CONTEXT_FOR_KEY: Record<string, ActionableInsight['context']> = {
  review_bills: { recordType: 'bill' },
  address_needs_budget_excess: { recordType: 'expense' },
  address_wants_budget_excess: { recordType: 'expense' },
  revise_goal_target: GOAL_ROUTE_CONTEXT,
  contribute_to_goal: GOAL_ROUTE_CONTEXT,
  settle_trip_balance: { recordType: 'trip', recordId: 3 },
};

/** What a broken or older server could send: the key, a record ID, and camelCase names in every text field. */
function leakyInsight(actionKey: string): ActionableInsight {
  return insight(actionKey, {
    id: `action:${actionKey}:record:7`,
    context: CONTEXT_FOR_KEY[actionKey],
    observation: `Observation for ${actionKey} recordId 7.`,
    actionLabel: actionKey,
    expectedEffect: `Effect of ${actionKey}.`,
  });
}

/** Text nodes joined by spaces, so neighbouring elements do not fuse into a camelCase-looking word. */
function visibleText(container: HTMLElement): string {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) parts.push(node.textContent ?? '');
  return parts.join(' ').replace(/“[^”]*”/g, ' ');
}

describe('plain-language action copy', () => {
  it('has fixed, plain copy for every action key', () => {
    expect(Object.keys(ACTION_COPY).sort()).toEqual([...CLARITY_ACTION_KEYS].sort());
    for (const key of CLARITY_ACTION_KEYS) {
      for (const text of Object.values(ACTION_COPY[key])) {
        expect(isPlainLanguage(text), `${key}: ${text}`).toBe(true);
        expect(text).not.toMatch(IDENTIFIER);
        expect(text.toLowerCase()).not.toContain(key);
      }
    }
  });

  it('accepts ordinary server text and what the user typed, and rejects internal identifiers', () => {
    expect(isPlainLanguage('Current-month bills exceed salary.')).toBe(true);
    expect(isPlainLanguage('The goal “my_new_car” still has a funding gap.')).toBe(true);
    for (const raw of [
      'Effect of contribute_to_goal.',
      'contribute_to_goal',
      'Review recordId 7',
      'ADDRESS_NEEDS_BUDGET_EXCESS',
      'action:contribute_to_goal:goal:7',
      'Label for settleTripBalance',
      'The goal is undefined.',
      '',
    ]) {
      expect(isPlainLanguage(raw), raw).toBe(false);
    }
  });

  it.each(CLARITY_ACTION_KEYS)('replaces a leaked identifier with the fixed copy for %s', (key) => {
    const leaky = leakyInsight(key);
    expect(actionLabelText(leaky)).toBe(ACTION_COPY[key].label);
    expect(actionEffectText(leaky)).toBe(ACTION_COPY[key].effect);
    expect(actionObservationText(leaky)).toBe(ACTION_COPY[key].observation);
  });

  it('keeps the server wording when it is already plain, including the bills-equal-pay variant', () => {
    const equal = insight('review_bills', {
      conditionCode: 'bills_equal_salary',
      expectedEffect: 'raw_effect_key',
    });
    expect(actionEffectText(equal)).toBe('Reducing a bill makes part of the current-month salary available to spend or save.');
    const plain = insight('review_bills', { expectedEffect: 'Cutting a bill frees up pay.' });
    expect(actionEffectText(plain)).toBe('Cutting a bill frees up pay.');
  });

  it('uses generic copy for an action key outside the fixed set', () => {
    const unknown = insight('some_future_key', { actionLabel: 'some_future_key', expectedEffect: 'some_future_key' });
    expect(actionLabelText(unknown)).toBe('Review this item');
    expect(actionEffectText(unknown)).not.toMatch(IDENTIFIER);
  });

  describe.each(CLARITY_ACTION_KEYS)('rendered text for %s', (key) => {
    it('shows no identifier in ActionLink or DecisionActionHeader, for leaked and fixture text', () => {
      for (const candidate of [leakyInsight(key), insight(key, { context: CONTEXT_FOR_KEY[key] })]) {
        const { container, unmount } = renderAuthenticated(
          <div>
            <ActionLink insight={candidate} variant="primary" />
            <DecisionActionHeader title="Home" decision="Which current financial condition needs attention?" action={candidate} />
          </div>,
        );
        expect(visibleText(container)).not.toMatch(IDENTIFIER);
        expect(screen.getAllByRole('link')[0]).toHaveTextContent(ACTION_COPY[key].label);
        unmount();
      }
    });

    it('shows no identifier in the Home next actions list', () => {
      const candidate = leakyInsight(key);
      const snapshot = homeSnapshot(MONTH, { actions: [candidate] });
      const { container } = renderAuthenticated(
        <MonthlyClaritySummary snapshot={snapshot} model={selectHomeSummary(snapshot)} />,
      );
      const actions = container.querySelector('[data-region="actions"]') as HTMLElement;
      expect(actions).toHaveTextContent(ACTION_COPY[key].observation);
      expect(actions).toHaveTextContent(ACTION_COPY[key].effect);
      expect(visibleText(container)).not.toMatch(IDENTIFIER);
    });
  });
});

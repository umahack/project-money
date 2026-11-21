import { describe, expect, it } from 'vitest';
import { outcomeLabel } from './dataUseLabels';
import {
  EXAMPLE_LABEL,
  NOT_AVAILABLE_TEXT,
  PURPOSE_INPUT_KINDS,
  PURPOSE_REGISTRY,
  isRequested,
  outcomeTerms,
  previewFor,
  purposeFor,
  skipEffect,
  type ConfirmedState,
  type PurposeDefinition,
  type PurposeOutcomeKey,
} from './purposeRegistry';

const PLAN_OUTCOMES: PurposeOutcomeKey[] = [
  'disposable_income',
  'needs_budget',
  'wants_budget',
  'savings_target',
  'spendable_budget',
  'daily_spending_guide',
  'projected_savings',
  'goal_feasibility',
];

const NAMED_OUTCOMES: Record<string, PurposeOutcomeKey[]> = {
  salary: PLAN_OUTCOMES,
  bill: PLAN_OUTCOMES,
  expense: ['category_total', 'remaining_spendable_budget', 'daily_spending_guide', 'projected_savings'],
  goal: ['goal_funding_gap', 'required_goal_contribution', 'goal_feasibility'],
  trip: ['member_balance', 'trip_settlement'],
};

const OPTIONAL_WITHOUT_OUTCOMES: PurposeDefinition = {
  ...PURPOSE_REGISTRY.bill,
  outcomes: [],
};

describe('purpose registry (Requirements 2.1 to 2.5)', () => {
  it('covers exactly Salary, Bill, Expense, Goal, and Trip', () => {
    expect([...PURPOSE_INPUT_KINDS].sort()).toEqual(['bill', 'expense', 'goal', 'salary', 'trip']);
  });

  it.each(Object.entries(NAMED_OUTCOMES))('names the required outcomes for %s', (input, outcomes) => {
    expect(PURPOSE_REGISTRY[input as keyof typeof PURPOSE_REGISTRY].outcomes).toEqual(outcomes);
  });

  it('labels and defines every named outcome in plain language', () => {
    for (const input of PURPOSE_INPUT_KINDS) {
      for (const term of outcomeTerms(input)) {
        expect(term.label, term.key).not.toBe('');
        expect(term.definition, term.key).not.toBe('');
        expect(term.label).toBe(outcomeLabel(term.key).label);
      }
    }
  });

  it('has a fixed example for every named outcome and a skip outcome that is one of them', () => {
    for (const definition of Object.values(PURPOSE_REGISTRY)) {
      expect(definition.outcomes).toContain(definition.skipOutcome);
      for (const outcome of definition.outcomes) {
        expect(definition.example.values[outcome], `${definition.input}.${outcome}`).toBeTruthy();
      }
    }
  });

  it('is frozen so no caller can change purpose copy', () => {
    expect(Object.isFrozen(PURPOSE_REGISTRY)).toBe(true);
    expect(Object.isFrozen(PURPOSE_REGISTRY.salary)).toBe(true);
    expect(Object.isFrozen(PURPOSE_REGISTRY.salary.outcomes)).toBe(true);
  });

  it('does not resolve inherited or unknown input names', () => {
    expect(purposeFor('salary')?.input).toBe('salary');
    expect(purposeFor('constructor')).toBeNull();
    expect(purposeFor('__proto__')).toBeNull();
    expect(purposeFor('<img src=x onerror=alert(1)>')).toBeNull();
    expect(previewFor('toString' as never)).toBeNull();
    expect(skipEffect('toString' as never)).toBeNull();
  });
});

describe('requested inputs (Requirements 2.6 and 2.9)', () => {
  it('marks required and optional inputs', () => {
    expect(PURPOSE_REGISTRY.salary.requirement).toBe('required');
    expect(PURPOSE_REGISTRY.bill.requirement).toBe('optional');
  });

  it('requests every registry input', () => {
    for (const input of PURPOSE_INPUT_KINDS) expect(isRequested(input)).toBe(true);
  });

  it('omits an optional input that names no outcome', () => {
    expect(isRequested(OPTIONAL_WITHOUT_OUTCOMES)).toBe(false);
    expect(previewFor(OPTIONAL_WITHOUT_OUTCOMES)).toBeNull();
    expect(skipEffect(OPTIONAL_WITHOUT_OUTCOMES)).toBeNull();
    expect(outcomeTerms(OPTIONAL_WITHOUT_OUTCOMES)).toEqual([]);
  });

  it('still requests a required input that names no outcome', () => {
    expect(isRequested({ ...PURPOSE_REGISTRY.salary, outcomes: [] })).toBe(true);
  });
});

describe('previewFor (Requirements 2.7 and 2.8)', () => {
  it('uses a visibly labelled example when nothing is confirmed', () => {
    const preview = previewFor('salary');
    expect(preview?.source).toBe('example');
    expect(preview?.sourceLabel).toBe(EXAMPLE_LABEL);
    expect(preview?.basis).toMatch(/^Example:/);
    expect(preview?.lines.map((line) => line.outcome)).toEqual(PLAN_OUTCOMES);
    expect(preview?.lines.every((line) => line.available)).toBe(true);
    expect(previewFor('salary', {})).toEqual(preview);
    expect(previewFor('salary', { bill: { outcomes: {} } })).toEqual(preview);
  });

  it('uses confirmed values and never the example when the input exists', () => {
    const confirmed: ConfirmedState = {
      salary: {
        outcomes: {
          disposable_income: { currency: 'INR', amountMinor: 123456 },
          goal_feasibility: { kind: 'feasibility', value: 'not_feasible' },
          needs_budget: null,
        },
      },
    };
    const preview = previewFor('salary', confirmed)!;
    expect(preview.source).toBe('confirmed');
    expect(preview.basis).toBeUndefined();
    const byOutcome = Object.fromEntries(preview.lines.map((line) => [line.outcome, line]));
    expect(byOutcome['disposable_income']?.valueText).toBe('₹1,234.56');
    expect(byOutcome['goal_feasibility']?.valueText).toBe('Does not fit inside your savings target');
    expect(byOutcome['needs_budget']).toMatchObject({ valueText: NOT_AVAILABLE_TEXT, available: false });
    expect(byOutcome['wants_budget']).toMatchObject({ valueText: NOT_AVAILABLE_TEXT, available: false });
    const example = previewFor('salary')!;
    for (const line of preview.lines) {
      const exampleText = example.lines.find((candidate) => candidate.outcome === line.outcome)!.valueText;
      expect(line.valueText).not.toBe(exampleText);
    }
  });

  it('formats trip balances from fixed labels', () => {
    const preview = previewFor('trip', {
      trip: {
        outcomes: {
          member_balance: { kind: 'balance', label: 'receivable', amount: { currency: 'INR', amountMinor: 250000 } },
          trip_settlement: { currency: 'INR', amountMinor: 100000 },
        },
      },
    })!;
    expect(preview.lines.map((line) => line.valueText)).toEqual(['You are owed ₹2,500', '₹1,000']);
  });

  it('treats unrecognised confirmed values as not available instead of printing them', () => {
    const hostile = { kind: 'feasibility', value: '<b>bold</b>' } as never;
    const preview = previewFor('goal', {
      goal: { outcomes: { goal_funding_gap: '<img src=x onerror=alert(1)>' as never, goal_feasibility: hostile } },
    })!;
    for (const line of preview.lines) {
      expect(line.valueText).toBe(NOT_AVAILABLE_TEXT);
      expect(line.available).toBe(false);
    }
  });
});

describe('skipEffect (Requirements 2.11 and 2.12)', () => {
  it('names the unchanged or unavailable outcome for an optional input', () => {
    const effect = skipEffect('bill')!;
    expect(effect.outcome).toBe('disposable_income');
    expect(effect.text).toContain(outcomeLabel('disposable_income').label);
    expect(effect.text).toMatch(/stays as it is now/);
    expect(effect.text).toMatch(/unavailable/);
    expect(effect.text).toMatch(/Nothing is saved or changed/);
  });

  it('has no skip for a required input', () => {
    for (const input of ['salary', 'expense', 'goal', 'trip'] as const) expect(skipEffect(input)).toBeNull();
  });

  it('falls back to a named outcome when the skip outcome is not listed', () => {
    const effect = skipEffect({ ...PURPOSE_REGISTRY.bill, outcomes: ['savings_target'], skipOutcome: 'trip_settlement' })!;
    expect(effect.outcome).toBe('savings_target');
    expect(effect.text).toContain('Savings target');
  });
});

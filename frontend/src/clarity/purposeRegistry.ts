// Fixed registry that explains why each financial input is requested
// (Requirements 2.1 to 2.12 and 12.10).
//
// Every string shown by PurposeExplanation and InputBenefitPreview comes from
// this module. Nothing here is read from the server, so no server value can
// supply purpose copy or markup. Confirmed values passed to `previewFor` are
// limited to money amounts and a few fixed enum keys and are rendered as text.
import { inr } from '../money';
import type { MoneyValue } from './contracts';
import { outcomeLabel } from './dataUseLabels';

export type PurposeInputKind = 'salary' | 'bill' | 'expense' | 'goal' | 'trip';

/** Outcome keys. Each key has a label and a plain-language definition in `dataUseLabels`. */
export type PurposeOutcomeKey =
  | 'disposable_income'
  | 'needs_budget'
  | 'wants_budget'
  | 'savings_target'
  | 'spendable_budget'
  | 'daily_spending_guide'
  | 'projected_savings'
  | 'goal_feasibility'
  | 'category_total'
  | 'remaining_spendable_budget'
  | 'goal_funding_gap'
  | 'required_goal_contribution'
  | 'member_balance'
  | 'trip_settlement';

export type FeasibilityValue = 'feasible' | 'not_feasible' | 'unavailable' | 'funded' | 'overdue';
export type BalanceLabel = 'receivable' | 'owed' | 'settled';

/** A confirmed value that can be previewed. Anything else is shown as not available. */
export type ConfirmedPreviewValue =
  | MoneyValue
  | { kind: 'feasibility'; value: FeasibilityValue }
  | { kind: 'balance'; label: BalanceLabel; amount: MoneyValue };

/**
 * What the user has already confirmed for one input, keyed by outcome.
 * An input counts as "existing" when the entry is present, even if some
 * of its outcomes are `null` because they cannot be calculated yet.
 */
export interface ConfirmedInputState {
  outcomes: Partial<Record<PurposeOutcomeKey, ConfirmedPreviewValue | null>>;
}

export type ConfirmedState = Partial<Record<PurposeInputKind, ConfirmedInputState>>;

export interface PurposeDefinition {
  input: PurposeInputKind;
  /** Name of the input as the user sees it, for example "Salary". */
  inputLabel: string;
  requirement: 'required' | 'optional';
  /** One plain sentence. It avoids financial terms; the outcome list below defines them. */
  purpose: string;
  /** Every outcome the input changes. An optional input with none is not requested. */
  outcomes: readonly PurposeOutcomeKey[];
  /** The one named outcome reported when an optional input is skipped. Must be in `outcomes`. */
  skipOutcome: PurposeOutcomeKey;
  /** Fixed example used only when the user has no existing value. */
  example: {
    basis: string;
    values: Readonly<Partial<Record<PurposeOutcomeKey, string>>>;
  };
}

export const EXAMPLE_LABEL = 'Example, not your data.' as const;
export const CONFIRMED_LABEL = 'Based on your saved values.' as const;
export const NOT_AVAILABLE_TEXT = 'Not available yet' as const;

const PLAN_OUTCOMES = [
  'disposable_income',
  'needs_budget',
  'wants_budget',
  'savings_target',
  'spendable_budget',
  'daily_spending_guide',
  'projected_savings',
  'goal_feasibility',
] as const satisfies readonly PurposeOutcomeKey[];

const PLAN_EXAMPLE_VALUES = {
  disposable_income: '₹30,000',
  needs_budget: '₹15,000',
  wants_budget: '₹9,000',
  savings_target: '₹6,000',
  spendable_budget: '₹24,000',
  daily_spending_guide: '₹800 a day',
  projected_savings: '₹30,000',
  goal_feasibility: 'A goal needing ₹5,000 a month fits inside the ₹6,000 savings target',
} as const satisfies Partial<Record<PurposeOutcomeKey, string>>;

const PLAN_EXAMPLE_BASIS = 'Example: salary ₹50,000, bills ₹20,000, nothing spent yet, 30 days left in the month.';

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export const PURPOSE_REGISTRY: Readonly<Record<PurposeInputKind, PurposeDefinition>> = deepFreeze({
  salary: {
    input: 'salary',
    inputLabel: 'Salary',
    requirement: 'required',
    purpose: 'Your take-home pay for the month is the starting point for every budget and savings figure.',
    outcomes: PLAN_OUTCOMES,
    skipOutcome: 'disposable_income',
    example: { basis: PLAN_EXAMPLE_BASIS, values: PLAN_EXAMPLE_VALUES },
  },
  bill: {
    input: 'bill',
    inputLabel: 'Bill',
    requirement: 'optional',
    purpose: 'Regular bills come out of your pay before anything else, so they reduce what is free to spend and save.',
    outcomes: PLAN_OUTCOMES,
    skipOutcome: 'disposable_income',
    example: { basis: PLAN_EXAMPLE_BASIS, values: PLAN_EXAMPLE_VALUES },
  },
  expense: {
    input: 'expense',
    inputLabel: 'Expense',
    requirement: 'required',
    purpose: 'Each amount you spend shows how this month is going against your plan.',
    outcomes: ['category_total', 'remaining_spendable_budget', 'daily_spending_guide', 'projected_savings'],
    skipOutcome: 'remaining_spendable_budget',
    example: {
      basis: 'Example: a ₹1,200 food expense, a ₹24,000 spendable budget, 30 days left in the month.',
      values: {
        category_total: '₹1,200 on Food',
        remaining_spendable_budget: '₹22,800',
        daily_spending_guide: '₹760 a day',
        projected_savings: '₹28,800',
      },
    },
  },
  goal: {
    input: 'goal',
    inputLabel: 'Savings goal',
    requirement: 'required',
    purpose: 'A target, what you have saved so far, and a date show how much to set aside each month.',
    outcomes: ['goal_funding_gap', 'required_goal_contribution', 'goal_feasibility'],
    skipOutcome: 'goal_feasibility',
    example: {
      basis: 'Example: a ₹60,000 target, ₹12,000 saved, 12 monthly contributions left, a ₹6,000 savings target.',
      values: {
        goal_funding_gap: '₹48,000',
        required_goal_contribution: '₹4,000 a month',
        goal_feasibility: 'Fits inside the ₹6,000 savings target',
      },
    },
  },
  trip: {
    input: 'trip',
    inputLabel: 'Trip expense',
    requirement: 'required',
    purpose: 'Who paid and how each cost is shared show what every member owes or is owed.',
    outcomes: ['member_balance', 'trip_settlement'],
    skipOutcome: 'trip_settlement',
    example: {
      basis: 'Example: a ₹3,000 dinner paid by Asha and split equally between Asha, Ben, and Chen.',
      values: {
        member_balance: 'Asha is owed ₹2,000; Ben owes ₹1,000; Chen owes ₹1,000',
        trip_settlement: 'Ben pays Asha ₹1,000; Chen pays Asha ₹1,000',
      },
    },
  },
}) as Readonly<Record<PurposeInputKind, PurposeDefinition>>;

export const PURPOSE_INPUT_KINDS: readonly PurposeInputKind[] = Object.freeze(
  Object.keys(PURPOSE_REGISTRY) as PurposeInputKind[],
);

/** Registry lookup that tolerates an unknown runtime value. Never reads inherited keys. */
export function purposeFor(input: string): PurposeDefinition | null {
  return Object.hasOwn(PURPOSE_REGISTRY, input) ? PURPOSE_REGISTRY[input as PurposeInputKind] : null;
}

function resolve(input: PurposeInputKind | PurposeDefinition): PurposeDefinition | null {
  return typeof input === 'string' ? purposeFor(input) : input;
}

/**
 * An input is requested when it is required, or when it is optional and names
 * at least one affected outcome (Requirement 2.9).
 */
export function isRequested(input: PurposeInputKind | PurposeDefinition): boolean {
  const definition = resolve(input);
  if (!definition) return false;
  return definition.requirement === 'required' || definition.outcomes.length > 0;
}

export interface OutcomeTerm {
  key: PurposeOutcomeKey;
  label: string;
  /** Plain-language definition shown at the first point of use (Requirement 12.10). */
  definition: string;
}

/** The named outcomes with their labels and definitions. Empty when the input is not requested. */
export function outcomeTerms(input: PurposeInputKind | PurposeDefinition): OutcomeTerm[] {
  const definition = resolve(input);
  if (!definition || !isRequested(definition)) return [];
  return definition.outcomes.map((key) => {
    const { label, definition: text } = outcomeLabel(key);
    return { key, label, definition: text };
  });
}

export interface SkipEffect {
  input: PurposeInputKind;
  /** The named outcome that stays unchanged, or stays unavailable if it has no value yet. */
  outcome: PurposeOutcomeKey;
  outcomeLabel: string;
  text: string;
}

/** The sentence that names the outcome a skipped optional input leaves as it is (Requirements 2.11 and 2.12). */
export function skipEffectText(outcome: string): string {
  const label = outcomeLabel(outcome).label;
  return `Nothing is saved or changed. ${label} stays as it is now, or stays unavailable if it has no value yet.`;
}

/**
 * What skipping does. Only optional, requested inputs can be skipped, so a
 * required input returns null. Skipping writes nothing, so the text says that
 * records stay as they are and names the outcome (Requirements 2.11 and 2.12).
 */
export function skipEffect(input: PurposeInputKind | PurposeDefinition): SkipEffect | null {
  const definition = resolve(input);
  if (!definition || definition.requirement !== 'optional' || !isRequested(definition)) return null;
  const outcome = definition.outcomes.includes(definition.skipOutcome)
    ? definition.skipOutcome
    : definition.outcomes[0];
  // An optional definition is only requested when it names an outcome, so this is defensive.
  if (!outcome) return null;
  return {
    input: definition.input,
    outcome,
    outcomeLabel: outcomeLabel(outcome).label,
    text: skipEffectText(outcome),
  };
}

export interface BenefitPreviewLine {
  outcome: PurposeOutcomeKey;
  label: string;
  /** Text only. Never markup. */
  valueText: string;
  available: boolean;
}

export interface BenefitPreviewModel {
  input: PurposeInputKind;
  source: 'confirmed' | 'example';
  /** "Example, not your data." for examples. */
  sourceLabel: string;
  /** Describes the example values. Present only for examples. */
  basis?: string;
  lines: BenefitPreviewLine[];
}

const FEASIBILITY_TEXT: Readonly<Record<FeasibilityValue, string>> = Object.freeze({
  feasible: 'Fits inside your savings target',
  not_feasible: 'Does not fit inside your savings target',
  unavailable: NOT_AVAILABLE_TEXT,
  funded: 'Already fully funded',
  overdue: 'Target date has passed',
});

const BALANCE_TEXT: Readonly<Record<BalanceLabel, string>> = Object.freeze({
  receivable: 'You are owed',
  owed: 'You owe',
  settled: 'Settled',
});

function isMoney(value: unknown): value is MoneyValue {
  return !!value
    && typeof value === 'object'
    && (value as MoneyValue).currency === 'INR'
    && Number.isSafeInteger((value as MoneyValue).amountMinor);
}

/** Plain text for a confirmed value, or null when the value has no recognised shape. */
function confirmedText(value: ConfirmedPreviewValue | null | undefined): string | null {
  if (isMoney(value)) return inr(value.amountMinor / 100);
  if (!value || typeof value !== 'object') return null;
  if (value.kind === 'feasibility' && Object.hasOwn(FEASIBILITY_TEXT, value.value)) {
    return FEASIBILITY_TEXT[value.value];
  }
  if (value.kind === 'balance' && Object.hasOwn(BALANCE_TEXT, value.label) && isMoney(value.amount)) {
    return value.label === 'settled'
      ? BALANCE_TEXT.settled
      : `${BALANCE_TEXT[value.label]} ${inr(value.amount.amountMinor / 100)}`;
  }
  return null;
}

/**
 * The preview of each named outcome before submission (Requirements 2.7 and 2.8).
 *
 * - When the user already has a value for the input, every line comes from the
 *   confirmed state. A line with no confirmed value says it is not available.
 *   The example is never used, so example and real values never mix.
 * - Otherwise every line is a fixed example, visibly labelled.
 * - An optional input with no named outcome is not requested, so the result is null.
 */
export function previewFor(
  input: PurposeInputKind | PurposeDefinition,
  confirmed?: ConfirmedState | null,
): BenefitPreviewModel | null {
  const definition = resolve(input);
  if (!definition || !isRequested(definition)) return null;
  const existing = confirmed && Object.hasOwn(confirmed, definition.input)
    ? confirmed[definition.input]
    : undefined;
  const terms = outcomeTerms(definition);
  if (existing && existing.outcomes && typeof existing.outcomes === 'object') {
    return {
      input: definition.input,
      source: 'confirmed',
      sourceLabel: CONFIRMED_LABEL,
      lines: terms.map(({ key, label }) => {
        const text = Object.hasOwn(existing.outcomes, key) ? confirmedText(existing.outcomes[key]) : null;
        return { outcome: key, label, valueText: text ?? NOT_AVAILABLE_TEXT, available: text !== null };
      }),
    };
  }
  return {
    input: definition.input,
    source: 'example',
    sourceLabel: EXAMPLE_LABEL,
    basis: definition.example.basis,
    lines: terms.map(({ key, label }) => {
      const text = Object.hasOwn(definition.example.values, key) ? definition.example.values[key] : undefined;
      return { outcome: key, label, valueText: text ?? NOT_AVAILABLE_TEXT, available: text !== undefined };
    }),
  };
}

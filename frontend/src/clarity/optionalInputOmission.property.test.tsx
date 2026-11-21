import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { api, clarityApi } from '../api';
import { InputBenefitPreview } from '../components/clarity/InputBenefitPreview';
import { PurposeExplanation } from '../components/clarity/PurposeExplanation';
import { inr } from '../money';
import { makeSnapshot } from '../test/clarity-fixtures';
import { fc, propertyTestParameters } from '../test/test-utils';
import { createClarityStore } from './clarityStore';
import { outcomeLabel } from './dataUseLabels';
import {
  CONFIRMED_LABEL,
  EXAMPLE_LABEL,
  NOT_AVAILABLE_TEXT,
  PURPOSE_INPUT_KINDS,
  PURPOSE_REGISTRY,
  isRequested,
  outcomeTerms,
  previewFor,
  purposeFor,
  skipEffect,
  type BalanceLabel,
  type ConfirmedInputState,
  type ConfirmedPreviewValue,
  type ConfirmedState,
  type FeasibilityValue,
  type PurposeDefinition,
  type PurposeInputKind,
  type PurposeOutcomeKey,
} from './purposeRegistry';

/**
 * Feature: financial-clarity-experience, Property 21: Optional input omission
 * and skip are financial no-ops.
 *
 * **Validates: Requirements 2.7, 2.9, 2.11, 2.12, 3.6**
 *
 * The registry has one optional input (Bill), so the pure-function properties run
 * against synthetic registry-shaped definitions. The registry functions already
 * accept a definition object, so no production seam was needed. The component
 * properties use the real registry.
 */

const OUTCOME_KEYS: readonly PurposeOutcomeKey[] = [
  'disposable_income',
  'needs_budget',
  'wants_budget',
  'savings_target',
  'spendable_budget',
  'daily_spending_guide',
  'projected_savings',
  'goal_feasibility',
  'category_total',
  'remaining_spendable_budget',
  'goal_funding_gap',
  'required_goal_contribution',
  'member_balance',
  'trip_settlement',
];

/** Every fixed example string carries this marker so confirmed output can be checked for leaks. */
const EXAMPLE_MARK = 'EX~';

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------
const inputKindArb = fc.constantFrom<PurposeInputKind>(...PURPOSE_INPUT_KINDS);
const outcomeKeyArb = fc.constantFrom<PurposeOutcomeKey>(...OUTCOME_KEYS);

const moneyArb = fc.record({
  currency: fc.constant('INR' as const),
  amountMinor: fc.integer({ min: 0, max: 100_000_000 }),
});

const confirmedValueArb: fc.Arbitrary<ConfirmedPreviewValue | null> = fc.oneof(
  moneyArb,
  fc.constantFrom<BalanceLabel>('receivable', 'owed', 'settled').chain((label) =>
    moneyArb.map((amount) => ({ kind: 'balance' as const, label, amount })),
  ),
  fc
    .constantFrom<FeasibilityValue>('feasible', 'not_feasible', 'unavailable', 'funded', 'overdue')
    .map((value) => ({ kind: 'feasibility' as const, value })),
  fc.constant(null),
);

const confirmedInputArb: fc.Arbitrary<ConfirmedInputState> = fc
  .uniqueArray(fc.tuple(outcomeKeyArb, confirmedValueArb), {
    selector: ([key]) => key,
    maxLength: OUTCOME_KEYS.length,
  })
  .map((entries) => ({ outcomes: Object.fromEntries(entries) }));

/** Confirmed state for any subset of inputs. An absent key means the user has no value yet. */
const confirmedStateArb: fc.Arbitrary<ConfirmedState> = fc
  .uniqueArray(fc.tuple(inputKindArb, confirmedInputArb), {
    selector: ([kind]) => kind,
    maxLength: PURPOSE_INPUT_KINDS.length,
  })
  .map((entries) => Object.fromEntries(entries) as ConfirmedState);

/** Registry-shaped definitions. Outcomes can be empty, and skipOutcome can fall outside outcomes. */
const definitionArb: fc.Arbitrary<PurposeDefinition> = fc
  .record({
    input: inputKindArb,
    inputLabel: fc.constantFrom('Salary', 'Bill', 'Expense', 'Savings goal', 'Trip expense', 'Gift'),
    requirement: fc.constantFrom<'required' | 'optional'>('required', 'optional'),
    outcomes: fc.uniqueArray(outcomeKeyArb, { maxLength: 6 }),
    skipOutcome: outcomeKeyArb,
    exampleKeys: fc.uniqueArray(outcomeKeyArb, { maxLength: 6 }),
  })
  .map(({ exampleKeys, ...rest }) => deepFreeze({
    ...rest,
    purpose: 'Why this input is asked for.',
    example: {
      basis: `${EXAMPLE_MARK}basis`,
      values: Object.fromEntries(exampleKeys.map((key) => [key, `${EXAMPLE_MARK}${key}`])),
    },
  }));

const optionalDefinitionArb = definitionArb.map((d) => deepFreeze({ ...d, requirement: 'optional' as const }));
const emptyOptionalDefinitionArb = definitionArb.map((d) => deepFreeze({
  ...d,
  requirement: 'optional' as const,
  outcomes: [] as PurposeOutcomeKey[],
}));

// ---------------------------------------------------------------------------
// Pure registry functions
// ---------------------------------------------------------------------------
describe('Property 21: optional input omission and skip are financial no-ops (registry functions)', () => {
  it('omits an optional input that names no outcome, and keeps every requested input', () => {
    fc.assert(
      fc.property(emptyOptionalDefinitionArb, confirmedStateArb, (definition, confirmed) => {
        expect(isRequested(definition)).toBe(false);
        expect(outcomeTerms(definition)).toEqual([]);
        expect(previewFor(definition, confirmed)).toBeNull();
        expect(skipEffect(definition)).toBeNull();
      }),
      propertyTestParameters,
    );

    fc.assert(
      fc.property(definitionArb, (definition) => {
        const requested = definition.requirement === 'required' || definition.outcomes.length > 0;
        expect(isRequested(definition)).toBe(requested);
        expect(outcomeTerms(definition).map((term) => term.key)).toEqual(requested ? definition.outcomes : []);
      }),
      propertyTestParameters,
    );
  });

  it('skip names one outcome of the input, and only optional requested inputs can be skipped', () => {
    fc.assert(
      fc.property(definitionArb, (definition) => {
        const effect = skipEffect(definition);
        if (definition.requirement === 'required' || definition.outcomes.length === 0) {
          expect(effect).toBeNull();
          return;
        }
        expect(effect).not.toBeNull();
        const expectedOutcome = definition.outcomes.includes(definition.skipOutcome)
          ? definition.skipOutcome
          : definition.outcomes[0];
        expect(effect!.input).toBe(definition.input);
        expect(effect!.outcome).toBe(expectedOutcome);
        expect(definition.outcomes).toContain(effect!.outcome);
        const label = outcomeLabel(expectedOutcome!).label;
        expect(effect!.outcomeLabel).toBe(label);
        expect(effect!.text).toContain(label);
        expect(effect!.text).toContain('Nothing is saved or changed.');
        expect(effect!.text).toContain('stays unavailable if it has no value yet');
        // The named outcome is one the explanation lists, so the reader can find it.
        expect(outcomeTerms(definition).map((term) => term.label)).toContain(label);
      }),
      propertyTestParameters,
    );
  });

  it('skipping leaves the definition, the confirmed state, and every preview exactly as they were', () => {
    fc.assert(
      fc.property(optionalDefinitionArb, confirmedStateArb, (definition, confirmed) => {
        deepFreeze(confirmed);
        const confirmedBefore = structuredClone(confirmed);
        const definitionBefore = structuredClone(definition);
        const previewBefore = previewFor(definition, confirmed);
        const termsBefore = outcomeTerms(definition);

        // Frozen inputs make any write throw, so a mutating skip fails loudly.
        const first = skipEffect(definition);
        const second = skipEffect(definition);

        expect(second).toEqual(first);
        expect(confirmed).toEqual(confirmedBefore);
        expect(definition).toEqual(definitionBefore);
        expect(previewFor(definition, confirmed)).toEqual(previewBefore);
        expect(outcomeTerms(definition)).toEqual(termsBefore);
        expect(isRequested(definition)).toBe(definition.outcomes.length > 0);
      }),
      propertyTestParameters,
    );
  });

  it('shows confirmed values, never the fixed example, when the user already has a value', () => {
    fc.assert(
      fc.property(definitionArb, confirmedStateArb, (definition, confirmed) => {
        deepFreeze(confirmed);
        const preview = previewFor(definition, confirmed);
        if (!isRequested(definition)) {
          expect(preview).toBeNull();
          return;
        }
        const existing = Object.hasOwn(confirmed, definition.input) ? confirmed[definition.input] : undefined;
        expect(preview).not.toBeNull();
        expect(preview!.lines.map((line) => line.outcome)).toEqual(definition.outcomes);

        if (existing) {
          expect(preview!.source).toBe('confirmed');
          expect(preview!.sourceLabel).toBe(CONFIRMED_LABEL);
          expect(preview!.basis).toBeUndefined();
          for (const line of preview!.lines) {
            expect(line.valueText).not.toContain(EXAMPLE_MARK);
            const value = Object.hasOwn(existing.outcomes, line.outcome) ? existing.outcomes[line.outcome] : null;
            if (value && 'amountMinor' in value) {
              expect(line.valueText).toBe(inr(value.amountMinor / 100));
              expect(line.available).toBe(true);
            } else if (value === null || value === undefined) {
              expect(line.valueText).toBe(NOT_AVAILABLE_TEXT);
              expect(line.available).toBe(false);
            } else {
              expect(line.available).toBe(true);
            }
          }
        } else {
          expect(preview!.source).toBe('example');
          expect(preview!.sourceLabel).toBe(EXAMPLE_LABEL);
          expect(preview!.basis).toBe(definition.example.basis);
          for (const line of preview!.lines) {
            const fixed = Object.hasOwn(definition.example.values, line.outcome)
              ? definition.example.values[line.outcome]
              : undefined;
            expect(line.valueText).toBe(fixed ?? NOT_AVAILABLE_TEXT);
            expect(line.available).toBe(fixed !== undefined);
          }
        }
      }),
      propertyTestParameters,
    );
  });

  it('an unknown or inherited input name has no purpose, so nothing is requested or previewed', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), fc.constantFrom('constructor', 'toString', '__proto__', 'hasOwnProperty')),
        confirmedStateArb,
        (name, confirmed) => {
          fc.pre(!PURPOSE_INPUT_KINDS.includes(name as PurposeInputKind));
          expect(purposeFor(name)).toBeNull();
          expect(isRequested(name as PurposeInputKind)).toBe(false);
          expect(previewFor(name as PurposeInputKind, confirmed)).toBeNull();
          expect(skipEffect(name as PurposeInputKind)).toBeNull();
        },
      ),
      propertyTestParameters,
    );
  });
});

// ---------------------------------------------------------------------------
// Components: skip interaction
// ---------------------------------------------------------------------------
const apiSpies = () => [
  vi.spyOn(clarityApi, 'get'),
  vi.spyOn(clarityApi, 'mutate'),
  ...(['get', 'post', 'put', 'patch', 'delete'] as const)
    .filter((method) => typeof (api as Record<string, unknown>)[method] === 'function')
    .map((method) => vi.spyOn(api as never, method as never)),
];

describe('Property 21: skip click is a financial no-op (components)', () => {
  it('makes no API call, leaves the clarity store and confirmed snapshot untouched, and names the outcome', async () => {
    await fc.assert(
      fc.asyncProperty(
        inputKindArb,
        confirmedStateArb,
        fc.constantFrom<boolean | undefined>(undefined, false, true),
        fc.integer({ min: 1, max: 3 }),
        fc.integer({ min: 1, max: 9 }),
        async (input, confirmed, skippedProp, clicks, snapshotVersion) => {
          const definition = PURPOSE_REGISTRY[input];
          const optional = definition.requirement === 'optional';

          const store = createClarityStore();
          store.dispatch({ type: 'install', snapshot: makeSnapshot(snapshotVersion) });
          const stateBefore = store.getState();
          const generationBefore = store.getGeneration();
          const confirmedBefore = structuredClone(stateBefore.confirmed);
          const onStoreChange = vi.fn();
          const unsubscribe = store.subscribe(onStoreChange);

          const spies = apiSpies();
          const fetchMock = vi.mocked(globalThis.fetch);
          const onSkip = vi.fn();
          const user = userEvent.setup();

          try {
            render(
              <div>
                <PurposeExplanation input={input} onSkip={onSkip} skipped={skippedProp} />
                <InputBenefitPreview input={input} confirmed={confirmed} />
              </div>,
            );

            const preview = screen.getByRole('region', { name: /unlocks/ });
            const previewBefore = preview.outerHTML;
            const hasOwn = Object.hasOwn(confirmed, input);
            // Confirmed values take precedence over the labelled example (Requirement 2.7).
            expect(preview).toHaveAttribute('data-source', hasOwn ? 'confirmed' : 'example');
            expect(within(preview).queryByText(EXAMPLE_LABEL) !== null).toBe(!hasOwn);

            const explanation = screen.getByRole('region', { name: /Why we ask for/ });
            const skip = within(explanation).queryByRole('button', { name: 'Skip for now' });

            if (!optional) {
              expect(skip).toBeNull();
              expect(explanation).not.toHaveTextContent('If you skip');
            } else {
              const effect = skipEffect(definition)!;
              expect(skip).not.toBeNull();
              expect(explanation).toHaveTextContent(`If you skip: ${effect.text}`);
              expect(effect.text).toContain(effect.outcomeLabel);
              expect(skip).toHaveAccessibleDescription(`If you skip: ${effect.text}`);

              for (let i = 0; i < clicks; i += 1) await user.click(skip!);

              const status = within(explanation).getByRole('status');
              const showsSkipped = skippedProp ?? true;
              if (showsSkipped) {
                expect(status).toHaveTextContent(`Skipped. ${effect.text}`);
                expect(status).toHaveTextContent(effect.outcomeLabel);
              } else {
                expect(status).toBeEmptyDOMElement();
              }
              // Uncontrolled: the callback fires once. Controlled and not skipped: once per click, because
              // the parent owns the state. Controlled and already skipped: never.
              const expectedSkips = skippedProp === true ? 0 : skippedProp === false ? clicks : 1;
              expect(onSkip).toHaveBeenCalledTimes(expectedSkips);
            }

            // The financial preview is unchanged by skipping.
            expect(preview.outerHTML).toBe(previewBefore);

            for (const spy of spies) expect(spy).not.toHaveBeenCalled();
            expect(fetchMock).not.toHaveBeenCalled();
            expect(onStoreChange).not.toHaveBeenCalled();
            expect(store.getState()).toBe(stateBefore);
            expect(store.getState().pending).toHaveLength(0);
            expect(store.getState().confirmed).toEqual(confirmedBefore);
            expect(store.getGeneration()).toBe(generationBefore);
          } finally {
            unsubscribe();
            cleanup();
            vi.restoreAllMocks();
            fetchMock.mockClear();
          }
        },
      ),
      propertyTestParameters,
    );
  });

  it('uses confirmed Bill values for the preview and leaves them visible after a skip', async () => {
    await fc.assert(
      fc.asyncProperty(confirmedInputArb, async (billState) => {
        const confirmed: ConfirmedState = { bill: billState };
        const user = userEvent.setup();
        try {
          render(
            <div>
              <PurposeExplanation input="bill" />
              <InputBenefitPreview input="bill" confirmed={confirmed} />
            </div>,
          );
          const preview = screen.getByRole('region', { name: /What bill unlocks/ });
          const before = preview.textContent;
          expect(before).not.toContain('Example');
          expect(preview).toHaveTextContent(CONFIRMED_LABEL);

          await user.click(screen.getByRole('button', { name: 'Skip for now' }));

          expect(preview.textContent).toBe(before);
          expect(screen.getByRole('status')).toHaveTextContent('Disposable income');
        } finally {
          cleanup();
        }
      }),
      propertyTestParameters,
    );
  });
});

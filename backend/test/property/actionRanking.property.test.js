import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {
  ACTION_DISCLAIMER,
  MAX_SUMMARY_ACTIONS,
  buildActionCandidates,
  buildActionSummary,
  compareActions,
  createActionSummary,
  rankActions,
} from '../../src/domain/insights.js';

const NUM_RUNS = 150;
const REFERENCE_COLLATOR = new Intl.Collator('en-IN', {
  sensitivity: 'variant',
  usage: 'sort',
});

function referenceSortText(value) {
  return value.normalize('NFKC').toLocaleLowerCase('en-IN');
}

function referenceCompareActions(left, right) {
  const leftHasDeadline = left.deadline !== undefined && left.deadline !== null;
  const rightHasDeadline = right.deadline !== undefined && right.deadline !== null;
  if (leftHasDeadline !== rightHasDeadline) return leftHasDeadline ? -1 : 1;

  if (leftHasDeadline) {
    const deadlineOrder = Date.parse(left.deadline) - Date.parse(right.deadline);
    if (deadlineOrder !== 0) return deadlineOrder;
  }

  const shortfallOrder = (right.shortfall?.amountMinor ?? 0)
    - (left.shortfall?.amountMinor ?? 0);
  if (shortfallOrder !== 0) return shortfallOrder;

  const effectOrder = Math.abs(right.effect?.amountMinor ?? 0)
    - Math.abs(left.effect?.amountMinor ?? 0);
  if (effectOrder !== 0) return effectOrder;

  const labelOrder = REFERENCE_COLLATOR.compare(
    referenceSortText(left.actionLabel),
    referenceSortText(right.actionLabel)
  );
  if (labelOrder !== 0) return labelOrder;

  const keyOrder = REFERENCE_COLLATOR.compare(
    referenceSortText(left.actionKey),
    referenceSortText(right.actionKey)
  );
  if (keyOrder !== 0) return keyOrder;

  return REFERENCE_COLLATOR.compare(
    referenceSortText(left.id),
    referenceSortText(right.id)
  );
}

function referenceRankActions(actions) {
  return [...actions].sort(referenceCompareActions);
}

function action({
  id,
  actionKey,
  actionLabel,
  deadline = null,
  shortfallMinor = null,
  effectMinor = null,
}) {
  return {
    id,
    conditionCode: 'generated_condition',
    observation: 'A generated condition applies.',
    ...(deadline === null ? {} : { deadline }),
    ...(shortfallMinor === null
      ? {}
      : { shortfall: { currency: 'INR', amountMinor: shortfallMinor } }),
    ...(effectMinor === null
      ? {}
      : { effect: { currency: 'INR', amountMinor: effectMinor } }),
    actionKey,
    actionLabel,
    expectedEffect: 'Completing the action addresses the generated condition.',
    route: '/plan',
    context: {},
    disclaimer: ACTION_DISCLAIMER,
  };
}

function assertIndependentPairOrder(first, second) {
  assert.ok(referenceCompareActions(first, second) < 0);
  assert.ok(compareActions(first, second) < 0);
  assert.ok(compareActions(second, first) > 0);
  assert.deepEqual(rankActions([second, first]), [first, second]);
}

function conditionProjection(candidate) {
  return {
    conditionCode: candidate.conditionCode,
    shortfall: candidate.shortfall,
    actionKey: candidate.actionKey,
    actionLabel: candidate.actionLabel,
    route: candidate.route,
    context: candidate.context,
  };
}

const dateArbitrary = fc
  .record({
    year: fc.integer({ min: 2025, max: 2035 }),
    month: fc.integer({ min: 1, max: 12 }),
    day: fc.integer({ min: 1, max: 28 }),
  })
  .map(({ year, month, day }) => (
    `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  ));

const amountArbitrary = fc.oneof(
  fc.constantFrom(0, 1, 100, 10_000, 1_000_000),
  fc.integer({ min: 0, max: 1_000_000_000 })
);

const effectArbitrary = fc.oneof(
  fc.constantFrom(-1_000_000, -1, 0, 1, 1_000_000),
  fc.integer({ min: -1_000_000_000, max: 1_000_000_000 })
);

const actionSpecArbitrary = fc.record({
  deadline: fc.option(dateArbitrary, { nil: null }),
  shortfallMinor: fc.option(amountArbitrary, { nil: null }),
  effectMinor: fc.option(effectArbitrary, { nil: null }),
  actionLabel: fc.constantFrom(
    'Ａlpha action',
    'alpha action',
    'Beta action',
    'Review action',
    'समीक्षा action'
  ),
  keyStem: fc.constantFrom('alpha', 'Ａlpha', 'beta', 'review', 'stable'),
  idSuffix: fc.nat({ max: 1_000_000 }),
});

const actionScenarioArbitrary = fc
  .array(actionSpecArbitrary, { minLength: 4, maxLength: 12 })
  .chain((specs) => {
    const actions = specs.map((spec, index) => action({
      id: `action:generated:${index}:${spec.idSuffix}`,
      actionKey: `${spec.keyStem}:${String(index).padStart(2, '0')}:${spec.idSuffix}`,
      actionLabel: spec.actionLabel,
      deadline: spec.deadline,
      shortfallMinor: spec.shortfallMinor,
      effectMinor: spec.effectMinor,
    }));

    return fc.shuffledSubarray(actions, {
      minLength: actions.length,
      maxLength: actions.length,
    }).map((permutation) => ({ actions, permutation }));
  });

const conditionScenarioArbitrary = fc.record({
  salaryMinor: fc.integer({ min: 1, max: 1_000_000_000 }),
  billExcessMinor: fc.integer({ min: 1, max: 1_000_000_000 }),
  needsBudgetMinor: fc.integer({ min: 0, max: 1_000_000_000 }),
  needsExcessMinor: fc.integer({ min: 1, max: 1_000_000_000 }),
  wantsBudgetMinor: fc.integer({ min: 0, max: 1_000_000_000 }),
  wantsExcessMinor: fc.integer({ min: 1, max: 1_000_000_000 }),
  shortfallBaseMinor: fc.integer({ min: 0, max: 500_000_000 }),
  shortfallIncreaseMinor: fc.integer({ min: 1, max: 500_000_000 }),
  effectBaseMinor: fc.integer({ min: 0, max: 500_000_000 }),
  effectIncreaseMinor: fc.integer({ min: 1, max: 500_000_000 }),
});

// Feature: financial-clarity-experience, Property 16: Action ranking is total, stable, and capped
// **Validates: Requirements 4.5, 5.9, 5.10, 8.8, 8.9, 8.14, 8.15**
test('Property 16: action ranking is total, stable, and capped', () => {
  fc.assert(
    fc.property(
      actionScenarioArbitrary,
      conditionScenarioArbitrary,
      ({ actions, permutation }, scenario) => {
        const expectedRanking = referenceRankActions(actions);
        const recalculatedActions = JSON.parse(JSON.stringify(actions));

        assert.deepEqual(rankActions(actions), expectedRanking);
        assert.deepEqual(rankActions(permutation), expectedRanking);
        assert.deepEqual(rankActions(recalculatedActions), expectedRanking);

        for (const left of actions) {
          assert.equal(compareActions(left, left), 0);
          for (const right of actions) {
            assert.equal(
              Math.sign(compareActions(left, right)),
              Math.sign(referenceCompareActions(left, right))
            );
            assert.equal(
              Math.sign(compareActions(left, right))
                + Math.sign(compareActions(right, left)),
              0
            );
          }
        }

        const summary = createActionSummary(permutation);
        assert.equal(summary.status, 'actions_available');
        assert.equal(summary.actions.length, MAX_SUMMARY_ACTIONS);
        assert.ok(summary.actions.length <= 3);
        assert.deepEqual(summary.actions, expectedRanking.slice(0, MAX_SUMMARY_ACTIONS));
        assert.deepEqual(
          summary.actions.map(({ id, actionLabel, actionKey }) => ({
            id,
            actionLabel,
            actionKey,
          })),
          expectedRanking.slice(0, MAX_SUMMARY_ACTIONS).map(({
            id,
            actionLabel,
            actionKey,
          }) => ({ id, actionLabel, actionKey }))
        );

        const probeCommon = {
          deadline: '2028-06-15',
          shortfallMinor: scenario.shortfallBaseMinor,
          effectMinor: scenario.effectBaseMinor,
        };
        assertIndependentPairOrder(
          action({
            id: 'probe:with-deadline',
            actionKey: 'probe_with_deadline',
            actionLabel: 'Deadline action',
            deadline: '2035-12-31',
            shortfallMinor: 0,
            effectMinor: 0,
          }),
          action({
            id: 'probe:without-deadline',
            actionKey: 'probe_without_deadline',
            actionLabel: 'No deadline action',
            shortfallMinor: 1_000_000_000,
            effectMinor: -1_000_000_000,
          })
        );
        assertIndependentPairOrder(
          action({
            id: 'probe:earlier-deadline',
            actionKey: 'probe_earlier_deadline',
            actionLabel: 'Earlier deadline',
            deadline: '2028-06-01',
          }),
          action({
            id: 'probe:later-deadline',
            actionKey: 'probe_later_deadline',
            actionLabel: 'Later deadline',
            deadline: '2028-06-28',
            shortfallMinor: 1_000_000_000,
            effectMinor: 1_000_000_000,
          })
        );
        assertIndependentPairOrder(
          action({
            id: 'probe:larger-shortfall',
            actionKey: 'probe_larger_shortfall',
            actionLabel: 'Larger shortfall',
            ...probeCommon,
            shortfallMinor: scenario.shortfallBaseMinor
              + scenario.shortfallIncreaseMinor,
            effectMinor: 0,
          }),
          action({
            id: 'probe:smaller-shortfall',
            actionKey: 'probe_smaller_shortfall',
            actionLabel: 'Smaller shortfall',
            ...probeCommon,
            effectMinor: 1_000_000_000,
          })
        );
        assertIndependentPairOrder(
          action({
            id: 'probe:larger-effect',
            actionKey: 'probe_larger_effect',
            actionLabel: 'Larger effect',
            ...probeCommon,
            effectMinor: -(scenario.effectBaseMinor + scenario.effectIncreaseMinor),
          }),
          action({
            id: 'probe:smaller-effect',
            actionKey: 'probe_smaller_effect',
            actionLabel: 'Smaller effect',
            ...probeCommon,
          })
        );
        assertIndependentPairOrder(
          action({
            id: 'probe:alpha-label',
            actionKey: 'z_label_loses_before_key',
            actionLabel: 'Ａlpha action',
            ...probeCommon,
          }),
          action({
            id: 'probe:beta-label',
            actionKey: 'a_key_would_win',
            actionLabel: 'beta action',
            ...probeCommon,
          })
        );
        assertIndependentPairOrder(
          action({
            id: 'probe:z-id',
            actionKey: 'alpha_stable_key',
            actionLabel: 'Ｓame label',
            ...probeCommon,
          }),
          action({
            id: 'probe:a-id',
            actionKey: 'beta_stable_key',
            actionLabel: 'same label',
            ...probeCommon,
          })
        );

        const equalBillCandidates = buildActionCandidates({
          monthlyPlan: {
            salaryMinor: scenario.salaryMinor,
            activeBillsTotalMinor: scenario.salaryMinor,
          },
        });
        assert.equal(equalBillCandidates.length, 1);
        assert.deepEqual(conditionProjection(equalBillCandidates[0]), {
          conditionCode: 'bills_equal_salary',
          shortfall: { currency: 'INR', amountMinor: 0 },
          actionKey: 'review_bills',
          actionLabel: 'Review monthly bills',
          route: '/plan#bills-form',
          context: { recordType: 'bill' },
        });

        const excessBillCandidates = buildActionCandidates({
          monthlyPlan: {
            salaryMinor: scenario.salaryMinor,
            activeBillsTotalMinor: scenario.salaryMinor + scenario.billExcessMinor,
          },
        });
        assert.equal(excessBillCandidates.length, 1);
        assert.deepEqual(conditionProjection(excessBillCandidates[0]), {
          conditionCode: 'bills_exceed_salary',
          shortfall: {
            currency: 'INR',
            amountMinor: scenario.billExcessMinor,
          },
          actionKey: 'review_bills',
          actionLabel: 'Review monthly bills',
          route: '/plan#bills-form',
          context: { recordType: 'bill' },
        });

        const exceededBudgetCandidates = buildActionCandidates({
          spending: {
            needsBudgetMinor: scenario.needsBudgetMinor,
            needsSpentMinor: scenario.needsBudgetMinor + scenario.needsExcessMinor,
            wantsBudgetMinor: scenario.wantsBudgetMinor,
            wantsSpentMinor: scenario.wantsBudgetMinor + scenario.wantsExcessMinor,
          },
        });
        assert.equal(exceededBudgetCandidates.length, 2);
        assert.deepEqual(exceededBudgetCandidates.map(conditionProjection), [
          {
            conditionCode: 'needs_budget_exceeded',
            shortfall: {
              currency: 'INR',
              amountMinor: scenario.needsExcessMinor,
            },
            actionKey: 'address_needs_budget_excess',
            actionLabel: 'Review Needs spending',
            route: '/spending?action=review-budget&bucket=needs',
            context: { recordType: 'expense' },
          },
          {
            conditionCode: 'wants_budget_exceeded',
            shortfall: {
              currency: 'INR',
              amountMinor: scenario.wantsExcessMinor,
            },
            actionKey: 'address_wants_budget_excess',
            actionLabel: 'Review Wants spending',
            route: '/spending?action=review-budget&bucket=wants',
            context: { recordType: 'expense' },
          },
        ]);

        assert.deepEqual(buildActionSummary({
          monthlyPlan: {
            salaryMinor: scenario.salaryMinor,
            activeBillsTotalMinor: scenario.salaryMinor - 1,
          },
          spending: {
            needsBudgetMinor: scenario.needsBudgetMinor,
            needsSpentMinor: scenario.needsBudgetMinor,
            wantsBudgetMinor: scenario.wantsBudgetMinor,
            wantsSpentMinor: scenario.wantsBudgetMinor,
          },
        }), {
          status: 'no_action_needed',
          message: 'No action is needed for the current month.',
          actions: [],
        });
      }
    ),
    { numRuns: NUM_RUNS }
  );
});

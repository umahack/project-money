import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GOAL_FEASIBILITY,
  GOAL_STATUSES,
  GoalValidationError,
  applyGoalContribution,
  applyGoalDraft,
  calculateGoal,
  countInclusiveMonthlyOpportunities,
  validateGoalDraft,
} from '../../src/domain/goals.js';

function goal(overrides = {}) {
  return {
    id: 7,
    name: 'Emergency fund',
    targetAmountMinor: 1_001,
    savedAmountMinor: 0,
    targetDate: '2026-03-01',
    ...overrides,
  };
}

test('goal calculation uses an inclusive month count and rounds contributions upward', () => {
  assert.equal(countInclusiveMonthlyOpportunities('2026-01-31', '2026-03-01'), 3);
  assert.equal(countInclusiveMonthlyOpportunities('2026-01-31', '2026-01-31'), 1);
  assert.equal(countInclusiveMonthlyOpportunities('2026-01-31', '2026-01-30'), 0);

  const result = calculateGoal({
    goal: goal(),
    localDate: '2026-01-31',
    savingsTargetMinor: 500,
  });

  assert.equal(result.status, GOAL_STATUSES.ACTIVE);
  assert.equal(result.fundingGapMinor, 1_001);
  assert.equal(result.contributionOpportunities, 3);
  assert.equal(result.requiredContributionMinor, 334);
  assert.equal(result.feasibility, GOAL_FEASIBILITY.FEASIBLE);
  assert.equal(result.capacityDifferenceMinor, 166);
  assert.deepEqual(result.rounding.requiredContribution, {
    precisionMinor: 1,
    direction: 'up',
    adjustmentMinor: 0,
  });
});

test('goal calculation distinguishes funded and overdue confirmed goals', () => {
  const funded = calculateGoal({
    goal: goal({ targetAmountMinor: 500, savedAmountMinor: 500 }),
    localDate: '2026-01-31',
  });
  assert.equal(funded.status, GOAL_STATUSES.FUNDED);
  assert.equal(funded.fundingGapMinor, 0);
  assert.equal(funded.requiredContributionMinor, 0);
  assert.equal(funded.feasibility, GOAL_FEASIBILITY.FUNDED);
  assert.equal(funded.missingPlanInput, null);

  const overdue = calculateGoal({
    goal: goal({ targetDate: '2026-01-30' }),
    localDate: '2026-01-31',
    savingsTargetMinor: 10_000,
  });
  assert.equal(overdue.status, GOAL_STATUSES.OVERDUE);
  assert.equal(overdue.fundingGapMinor, 1_001);
  assert.equal(overdue.contributionOpportunities, 0);
  assert.equal(overdue.requiredContributionMinor, null);
  assert.equal(overdue.feasibility, GOAL_FEASIBILITY.OVERDUE);
  assert.deepEqual(overdue.revisionRequest, {
    fields: ['targetAmountMinor', 'targetDate'],
    action: 'revise_target_amount_or_date',
  });
});

test('invalid goal drafts remain separate from the preceding confirmed goal', () => {
  const preceding = goal({ targetAmountMinor: 500, savedAmountMinor: 100 });
  const draft = {
    name: '   \t',
    savedAmountMinor: 501,
    targetDate: '2026-01-30',
  };
  const unchangedPreceding = structuredClone(preceding);
  const unchangedDraft = structuredClone(draft);

  const result = applyGoalDraft({
    precedingConfirmedGoal: preceding,
    draft,
    localDate: '2026-01-31',
    savingsTargetMinor: 200,
  });

  assert.equal(result.status, 'invalid');
  assert.deepEqual(result.confirmedGoal, preceding);
  assert.notEqual(result.confirmedGoal, preceding);
  assert.deepEqual(result.invalidDraft, draft);
  assert.notEqual(result.invalidDraft, draft);
  assert.deepEqual(
    result.errors.map(({ field }) => field),
    ['name', 'savedAmountMinor', 'targetDate']
  );
  assert.deepEqual(preceding, unchangedPreceding);
  assert.deepEqual(draft, unchangedDraft);
  assert.equal(result.outcome.fundingGapMinor, 400);

  const invalidCreate = applyGoalDraft({
    draft: {
      name: 'Goal',
      targetAmountMinor: 0,
      savedAmountMinor: -1,
      targetDate: '2026-02-30',
    },
    localDate: '2026-01-31',
  });
  assert.equal(invalidCreate.status, 'invalid');
  assert.equal(invalidCreate.confirmedGoal, null);
  assert.equal(invalidCreate.outcome, null);
});

test('draft validation accepts date boundaries and permits non-date edits to overdue goals', () => {
  const createBoundary = validateGoalDraft({
    draft: goal({ id: undefined, targetDate: '2026-01-31' }),
    localDate: '2026-01-31',
  });
  assert.equal(createBoundary.valid, true);

  const overdue = goal({ targetDate: '2026-01-30' });
  const nameOnlyEdit = validateGoalDraft({
    precedingConfirmedGoal: overdue,
    draft: { name: 'Revised emergency fund' },
    localDate: '2026-01-31',
  });
  assert.equal(nameOnlyEdit.valid, true);

  const changedPastDate = validateGoalDraft({
    precedingConfirmedGoal: overdue,
    draft: { targetDate: '2026-01-29' },
    localDate: '2026-01-31',
  });
  assert.equal(changedPastDate.valid, false);
  assert.equal(changedPastDate.errors[0].code, 'GOAL_TARGET_DATE_IN_PAST');

  assert.throws(
    () => calculateGoal({
      goal: goal({ name: '\n', targetAmountMinor: 0, savedAmountMinor: -1 }),
      localDate: '2026-01-31',
    }),
    (error) => error instanceof GoalValidationError
      && error.errors.map(({ field }) => field).join(',')
        === 'name,targetAmountMinor,savedAmountMinor'
  );
});

test('goal feasibility reports capacity, one recomputable revision, or the minimum missing input', () => {
  const inputGoal = goal({ targetAmountMinor: 1_000, savedAmountMinor: 100 });
  const infeasible = calculateGoal({
    goal: inputGoal,
    localDate: '2026-01-31',
    savingsTargetMinor: 250,
  });

  assert.equal(infeasible.requiredContributionMinor, 300);
  assert.equal(infeasible.feasibility, GOAL_FEASIBILITY.NOT_FEASIBLE);
  assert.equal(infeasible.capacityDifferenceMinor, 50);
  assert.deepEqual(infeasible.revision, {
    targetAmountMinor: 850,
    fundingGapMinor: 750,
    contributionOpportunities: 3,
    requiredContributionMinor: 250,
  });

  const revised = calculateGoal({
    goal: { ...inputGoal, targetAmountMinor: infeasible.revision.targetAmountMinor },
    localDate: '2026-01-31',
    savingsTargetMinor: 250,
  });
  assert.equal(revised.feasibility, GOAL_FEASIBILITY.FEASIBLE);
  assert.equal(revised.requiredContributionMinor, 250);

  const unavailable = calculateGoal({
    goal: inputGoal,
    localDate: '2026-01-31',
    missingPlanInputs: ['bills', 'salary'],
  });
  assert.equal(unavailable.feasibility, GOAL_FEASIBILITY.UNAVAILABLE);
  assert.equal(unavailable.missingPlanInput, 'salary');

  const billsOnly = calculateGoal({
    goal: inputGoal,
    localDate: '2026-01-31',
    missingPlanInputs: ['bills'],
  });
  assert.equal(billsOnly.missingPlanInput, 'bills');

  const zeroCapacity = calculateGoal({
    goal: goal({ targetAmountMinor: 1_000, savedAmountMinor: 0 }),
    localDate: '2026-01-31',
    savingsTargetMinor: 0,
  });
  assert.equal(zeroCapacity.feasibility, GOAL_FEASIBILITY.NOT_FEASIBLE);
  assert.equal(zeroCapacity.revision, null);
  assert.equal(
    zeroCapacity.revisionUnavailable.code,
    'NO_FEASIBLE_POSITIVE_TARGET'
  );
});

test('goal contributions enforce dynamic bounds, preserve failures, and replay exactly once', () => {
  const preceding = goal({ targetAmountMinor: 1_000, savedAmountMinor: 400 });
  const unchangedPreceding = structuredClone(preceding);

  for (const contributionMinor of [0, -1, 601]) {
    const rejected = applyGoalContribution({
      confirmedGoal: preceding,
      contributionMinor,
      idempotencyKey: `reject-${contributionMinor}`,
      localDate: '2026-01-31',
      savingsTargetMinor: 300,
    });
    assert.equal(rejected.status, 'invalid');
    assert.deepEqual(rejected.confirmedGoal, preceding);
    assert.deepEqual(rejected.appliedContributionKeys, []);
    assert.equal(rejected.errors[0].constraint, 'from 1 through 600 paise, inclusive');
    assert.equal(rejected.outcome.fundingGapMinor, 600);
  }
  assert.deepEqual(preceding, unchangedPreceding);

  const applied = applyGoalContribution({
    confirmedGoal: preceding,
    contributionMinor: 600,
    idempotencyKey: 'contribution-1',
    localDate: '2026-01-31',
    savingsTargetMinor: 300,
  });
  assert.equal(applied.status, 'confirmed');
  assert.equal(applied.confirmedGoal.savedAmountMinor, 1_000);
  assert.equal(applied.outcome.status, GOAL_STATUSES.FUNDED);
  assert.deepEqual(applied.appliedContributionKeys, ['contribution-1']);

  const replayed = applyGoalContribution({
    confirmedGoal: applied.confirmedGoal,
    contributionMinor: 600,
    idempotencyKey: 'contribution-1',
    appliedContributionKeys: applied.appliedContributionKeys,
    localDate: '2026-01-31',
    savingsTargetMinor: 300,
  });
  assert.equal(replayed.status, 'replayed');
  assert.equal(replayed.confirmedGoal.savedAmountMinor, 1_000);
  assert.deepEqual(replayed.appliedContributionKeys, ['contribution-1']);
});

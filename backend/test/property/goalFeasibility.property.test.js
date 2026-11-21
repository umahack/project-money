import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {
  GOAL_FEASIBILITY,
  GOAL_STATUSES,
  calculateGoal,
} from '../../src/domain/goals.js';

const NUM_RUNS = 150;

function formatPart(value) {
  return String(value).padStart(2, '0');
}

function formatDate({ year, month, day }) {
  return `${year}-${formatPart(month)}-${formatPart(day)}`;
}

function addMonths({ year, month }, offset) {
  const monthIndex = year * 12 + month - 1 + offset;
  return {
    year: Math.floor(monthIndex / 12),
    month: monthIndex % 12 + 1,
  };
}

function referenceMonthlyOpportunities(localDate, targetDate) {
  const [localYear, localMonth] = localDate.split('-').map(Number);
  const [targetYear, targetMonth] = targetDate.split('-').map(Number);
  return (targetYear - localYear) * 12 + targetMonth - localMonth + 1;
}

function referenceCeilingDivision(dividend, divisor) {
  if (dividend === 0) return 0;
  return Number(
    (BigInt(dividend) + BigInt(divisor) - 1n) / BigInt(divisor)
  );
}

function referenceGoal(goal, localDate) {
  const fundingGapMinor = goal.targetAmountMinor - goal.savedAmountMinor;
  const contributionOpportunities = referenceMonthlyOpportunities(
    localDate,
    goal.targetDate
  );

  return {
    fundingGapMinor,
    contributionOpportunities,
    requiredContributionMinor: referenceCeilingDivision(
      fundingGapMinor,
      contributionOpportunities
    ),
  };
}

function assertActiveCalculation(result, expected) {
  assert.equal(result.status, GOAL_STATUSES.ACTIVE);
  assert.equal(result.fundingGapMinor, expected.fundingGapMinor);
  assert.equal(
    result.contributionOpportunities,
    expected.contributionOpportunities
  );
  assert.equal(
    result.requiredContributionMinor,
    expected.requiredContributionMinor
  );
}

function assertProposedRevisionFits({
  originalGoal,
  localDate,
  savingsTargetMinor,
  revision,
}) {
  assert.notEqual(revision, null);

  const revisesAmount = Number.isSafeInteger(revision.targetAmountMinor);
  const revisesDate = typeof revision.targetDate === 'string';
  assert.notEqual(revisesAmount, revisesDate);

  const revisedGoal = {
    ...originalGoal,
    ...(revisesAmount
      ? { targetAmountMinor: revision.targetAmountMinor }
      : { targetDate: revision.targetDate }),
  };
  assert.ok(revisedGoal.targetAmountMinor > 0);
  assert.ok(revisedGoal.savedAmountMinor <= revisedGoal.targetAmountMinor);
  assert.ok(revisedGoal.targetDate >= localDate);

  const independentlyRecalculated = referenceGoal(revisedGoal, localDate);
  assert.equal(
    revision.fundingGapMinor,
    independentlyRecalculated.fundingGapMinor
  );
  assert.equal(
    revision.contributionOpportunities,
    independentlyRecalculated.contributionOpportunities
  );
  assert.equal(
    revision.requiredContributionMinor,
    independentlyRecalculated.requiredContributionMinor
  );
  assert.ok(
    independentlyRecalculated.requiredContributionMinor <= savingsTargetMinor
  );

  const canonicalRecalculation = calculateGoal({
    goal: revisedGoal,
    localDate,
    savingsTargetMinor,
  });
  assert.equal(canonicalRecalculation.feasibility, GOAL_FEASIBILITY.FEASIBLE);
  assert.equal(
    canonicalRecalculation.requiredContributionMinor,
    independentlyRecalculated.requiredContributionMinor
  );
  assert.ok(canonicalRecalculation.requiredContributionMinor <= savingsTargetMinor);
}

const scenarioArbitrary = fc
  .record({
    year: fc.integer({ min: 2024, max: 2090 }),
    month: fc.integer({ min: 1, max: 12 }),
    targetMonthOffset: fc.integer({ min: 0, max: 120 }),
    savedAmountMinor: fc.integer({ min: 0, max: 1_000_000_000 }),
    feasibleHeadroomMinor: fc.integer({ min: 0, max: 1_000_000 }),
  })
  .chain((base) => {
    const contributionOpportunities = base.targetMonthOffset + 1;
    return fc
      .integer({
        min: contributionOpportunities + 1,
        max: 1_000_000_000,
      })
      .chain((fundingGapMinor) => {
        const requiredContributionMinor = referenceCeilingDivision(
          fundingGapMinor,
          contributionOpportunities
        );
        return fc.integer({
          min: 1,
          max: requiredContributionMinor - 1,
        }).map((infeasibleSavingsTargetMinor) => ({
          ...base,
          fundingGapMinor,
          infeasibleSavingsTargetMinor,
        }));
      });
  });

// Feature: financial-clarity-experience, Property 10: Goal feasibility and revision are internally consistent
// **Validates: Requirements 6.14, 6.15, 6.16, 6.17, 6.18**
test('Property 10: goal feasibility and revision are internally consistent', () => {
  fc.assert(
    fc.property(scenarioArbitrary, (scenario) => {
      const currentMonth = {
        year: scenario.year,
        month: scenario.month,
      };
      const targetMonth = addMonths(
        currentMonth,
        scenario.targetMonthOffset
      );
      const localDate = formatDate({ ...currentMonth, day: 15 });
      const targetDate = formatDate({ ...targetMonth, day: 28 });
      const goal = {
        id: 10,
        name: 'Property feasibility goal',
        targetAmountMinor:
          scenario.savedAmountMinor + scenario.fundingGapMinor,
        savedAmountMinor: scenario.savedAmountMinor,
        targetDate,
      };
      const expected = referenceGoal(goal, localDate);

      const feasibleSavingsTargetMinor =
        expected.requiredContributionMinor + scenario.feasibleHeadroomMinor;
      const feasible = calculateGoal({
        goal,
        localDate,
        savingsTargetMinor: feasibleSavingsTargetMinor,
      });
      assertActiveCalculation(feasible, expected);
      assert.equal(feasible.feasibility, GOAL_FEASIBILITY.FEASIBLE);
      assert.equal(
        feasible.capacityDifferenceMinor,
        feasibleSavingsTargetMinor - expected.requiredContributionMinor
      );
      assert.equal(feasible.revision, null);
      assert.equal(feasible.missingPlanInput, null);

      const infeasible = calculateGoal({
        goal,
        localDate,
        savingsTargetMinor: scenario.infeasibleSavingsTargetMinor,
      });
      assertActiveCalculation(infeasible, expected);
      assert.equal(infeasible.feasibility, GOAL_FEASIBILITY.NOT_FEASIBLE);
      assert.equal(
        infeasible.capacityDifferenceMinor,
        expected.requiredContributionMinor
          - scenario.infeasibleSavingsTargetMinor
      );
      assert.equal(infeasible.missingPlanInput, null);
      assert.equal(infeasible.revisionUnavailable, null);
      assertProposedRevisionFits({
        originalGoal: goal,
        localDate,
        savingsTargetMinor: scenario.infeasibleSavingsTargetMinor,
        revision: infeasible.revision,
      });

      const missingInputCases = [
        { inputs: ['salary'], expected: 'salary' },
        { inputs: ['bills'], expected: 'bills' },
        { inputs: ['bills', 'salary'], expected: 'salary' },
        { inputs: ['salary', 'bills'], expected: 'salary' },
      ];
      for (const missingCase of missingInputCases) {
        const unavailable = calculateGoal({
          goal,
          localDate,
          missingPlanInputs: missingCase.inputs,
        });
        assertActiveCalculation(unavailable, expected);
        assert.equal(unavailable.feasibility, GOAL_FEASIBILITY.UNAVAILABLE);
        assert.equal(unavailable.missingPlanInput, missingCase.expected);
        assert.equal(unavailable.capacityDifferenceMinor, null);
        assert.equal(unavailable.revision, null);
      }

      const zeroSavingsGoal = {
        ...goal,
        targetAmountMinor: scenario.fundingGapMinor,
        savedAmountMinor: 0,
      };
      const zeroSavingsExpected = referenceGoal(zeroSavingsGoal, localDate);
      assert.equal(
        referenceCeilingDivision(1, zeroSavingsExpected.contributionOpportunities),
        1
      );
      const zeroSavings = calculateGoal({
        goal: zeroSavingsGoal,
        localDate,
        savingsTargetMinor: 0,
      });
      assertActiveCalculation(zeroSavings, zeroSavingsExpected);
      assert.equal(zeroSavings.feasibility, GOAL_FEASIBILITY.NOT_FEASIBLE);
      assert.equal(
        zeroSavings.capacityDifferenceMinor,
        zeroSavingsExpected.requiredContributionMinor
      );
      assert.equal(zeroSavings.revision, null);
      assert.equal(
        zeroSavings.revisionUnavailable?.code,
        'NO_FEASIBLE_POSITIVE_TARGET'
      );
    }),
    { numRuns: NUM_RUNS }
  );
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {
  GOAL_STATUSES,
  applyGoalContribution,
} from '../../src/domain/goals.js';

const NUM_RUNS = 100;
const MAX_TARGET_MINOR = 100_000_000;

function formatPart(value) {
  return String(value).padStart(2, '0');
}

function addMonths(year, monthNumber, offset) {
  const monthIndex = year * 12 + monthNumber - 1 + offset;
  return {
    year: Math.floor(monthIndex / 12),
    monthNumber: monthIndex % 12 + 1,
  };
}

function referenceOutcome(goal, localDate) {
  const [localYear, localMonth] = localDate.split('-').map(Number);
  const [targetYear, targetMonth] = goal.targetDate.split('-').map(Number);
  const fundingGapMinor = goal.targetAmountMinor - goal.savedAmountMinor;
  const contributionOpportunities = (
    (targetYear - localYear) * 12 + targetMonth - localMonth + 1
  );

  return {
    status: fundingGapMinor === 0 ? GOAL_STATUSES.FUNDED : GOAL_STATUSES.ACTIVE,
    fundingGapMinor,
    contributionOpportunities,
    requiredContributionMinor: fundingGapMinor === 0
      ? 0
      : Math.floor(
        (fundingGapMinor + contributionOpportunities - 1)
        / contributionOpportunities
      ),
  };
}

function applyReferenceContribution(state, command, localDate) {
  const precedingOutcome = referenceOutcome(state.goal, localDate);

  if (state.appliedContributionKeys.includes(command.idempotencyKey)) {
    return {
      status: 'replayed',
      goal: structuredClone(state.goal),
      appliedContributionKeys: [...state.appliedContributionKeys],
      outcome: precedingOutcome,
    };
  }

  const accepted = Number.isSafeInteger(command.contributionMinor)
    && command.contributionMinor > 0
    && command.contributionMinor <= precedingOutcome.fundingGapMinor;
  if (!accepted) {
    return {
      status: 'invalid',
      goal: structuredClone(state.goal),
      appliedContributionKeys: [...state.appliedContributionKeys],
      outcome: precedingOutcome,
    };
  }

  const goal = {
    ...state.goal,
    savedAmountMinor: state.goal.savedAmountMinor + command.contributionMinor,
  };
  return {
    status: 'confirmed',
    goal,
    appliedContributionKeys: [
      ...state.appliedContributionKeys,
      command.idempotencyKey,
    ],
    outcome: referenceOutcome(goal, localDate),
  };
}

function applyActualContribution(state, command, localDate) {
  return applyGoalContribution({
    confirmedGoal: state.goal,
    contributionMinor: command.contributionMinor,
    idempotencyKey: command.idempotencyKey,
    appliedContributionKeys: state.appliedContributionKeys,
    localDate,
  });
}

function assertMatchesReference(actual, expected) {
  assert.equal(actual.status, expected.status);
  assert.deepEqual(actual.confirmedGoal, expected.goal);
  assert.deepEqual(
    actual.appliedContributionKeys,
    expected.appliedContributionKeys
  );
  assert.equal(actual.outcome.status, expected.outcome.status);
  assert.equal(
    actual.outcome.fundingGapMinor,
    expected.outcome.fundingGapMinor
  );
  assert.equal(
    actual.outcome.contributionOpportunities,
    expected.outcome.contributionOpportunities
  );
  assert.equal(
    actual.outcome.requiredContributionMinor,
    expected.outcome.requiredContributionMinor
  );
}

function assertAcceptedRange(error, fundingGapMinor) {
  assert.equal(error.code, 'GOAL_CONTRIBUTION_OUT_OF_RANGE');
  assert.equal(error.field, 'contributionMinor');
  assert.equal(
    error.constraint,
    `from 1 through ${fundingGapMinor} paise, inclusive`
  );
}

const scenarioArbitrary = fc
  .record({
    year: fc.integer({ min: 2024, max: 2035 }),
    monthNumber: fc.integer({ min: 1, max: 12 }),
    targetMonthOffset: fc.integer({ min: 0, max: 36 }),
    targetAmountMinor: fc.integer({ min: 1, max: MAX_TARGET_MINOR }),
    existingKeyCount: fc.integer({ min: 0, max: 3 }),
    replayCount: fc.integer({ min: 1, max: 5 }),
    belowLowerBoundMinor: fc.integer({ min: -1_000, max: 0 }),
    aboveGapDeltaMinor: fc.integer({ min: 1, max: 1_000 }),
  })
  .chain((base) => fc
    .integer({ min: 0, max: base.targetAmountMinor - 1 })
    .chain((savedAmountMinor) => {
      const fundingGapMinor = base.targetAmountMinor - savedAmountMinor;
      return fc.record({
        validContributionMinor: fc.integer({ min: 1, max: fundingGapMinor }),
        proposedContributionMinor: fc.oneof(
          fc.integer({ min: 1, max: fundingGapMinor }),
          fc.integer({ min: -1_000, max: 0 }),
          fc.integer({
            min: fundingGapMinor + 1,
            max: fundingGapMinor + 1_000,
          })
        ),
      }).map((contributions) => ({
        ...base,
        savedAmountMinor,
        ...contributions,
      }));
    }));

// Feature: financial-clarity-experience, Property 9: Goal contribution is bounded and exactly once
// **Validates: Requirements 6.5, 6.11, 6.12, 6.13**
test('Property 9: goal contribution is bounded and exactly once', () => {
  fc.assert(
    fc.property(scenarioArbitrary, (scenario) => {
      const target = addMonths(
        scenario.year,
        scenario.monthNumber,
        scenario.targetMonthOffset
      );
      const localDate = `${scenario.year}-${formatPart(scenario.monthNumber)}-01`;
      const goal = {
        id: 7,
        name: 'Property goal',
        targetAmountMinor: scenario.targetAmountMinor,
        savedAmountMinor: scenario.savedAmountMinor,
        targetDate: `${target.year}-${formatPart(target.monthNumber)}-28`,
      };
      const initialState = {
        goal,
        appliedContributionKeys: Array.from(
          { length: scenario.existingKeyCount },
          (_, index) => `already-applied-${index}`
        ),
      };
      const unchangedInitialState = structuredClone(initialState);
      const currentGapMinor = (
        goal.targetAmountMinor - goal.savedAmountMinor
      );

      const proposedCommand = {
        contributionMinor: scenario.proposedContributionMinor,
        idempotencyKey: 'proposed-contribution',
      };
      const proposedExpected = applyReferenceContribution(
        initialState,
        proposedCommand,
        localDate
      );
      const proposedActual = applyActualContribution(
        initialState,
        proposedCommand,
        localDate
      );
      assertMatchesReference(proposedActual, proposedExpected);
      assert.equal(
        proposedActual.status === 'confirmed',
        scenario.proposedContributionMinor > 0
          && scenario.proposedContributionMinor <= currentGapMinor
      );
      if (proposedExpected.status === 'invalid') {
        assert.deepEqual(proposedActual.confirmedGoal, initialState.goal);
        assert.deepEqual(
          proposedActual.appliedContributionKeys,
          initialState.appliedContributionKeys
        );
        assertAcceptedRange(proposedActual.errors[0], currentGapMinor);
      }

      const rejectedCommands = [
        {
          contributionMinor: scenario.belowLowerBoundMinor,
          idempotencyKey: 'rejected-below-lower-bound',
        },
        {
          contributionMinor: currentGapMinor + scenario.aboveGapDeltaMinor,
          idempotencyKey: 'rejected-above-current-gap',
        },
      ];
      for (const command of rejectedCommands) {
        const expected = applyReferenceContribution(
          initialState,
          command,
          localDate
        );
        const actual = applyActualContribution(initialState, command, localDate);

        assertMatchesReference(actual, expected);
        assert.equal(actual.status, 'invalid');
        assert.deepEqual(actual.confirmedGoal, initialState.goal);
        assert.deepEqual(
          actual.appliedContributionKeys,
          initialState.appliedContributionKeys
        );
        assert.deepEqual(actual.invalidContributionDraft, command);
        assertAcceptedRange(actual.errors[0], currentGapMinor);
      }

      const acceptedCommand = {
        contributionMinor: scenario.validContributionMinor,
        idempotencyKey: 'accepted-contribution',
      };
      let expectedState = applyReferenceContribution(
        initialState,
        acceptedCommand,
        localDate
      );
      let actualResult = applyActualContribution(
        initialState,
        acceptedCommand,
        localDate
      );

      assertMatchesReference(actualResult, expectedState);
      assert.equal(actualResult.status, 'confirmed');
      assert.equal(actualResult.invalidContributionDraft, null);
      assert.deepEqual(actualResult.errors, []);

      for (let replay = 0; replay < scenario.replayCount; replay += 1) {
        const actualState = {
          goal: actualResult.confirmedGoal,
          appliedContributionKeys: actualResult.appliedContributionKeys,
        };
        expectedState = applyReferenceContribution(
          {
            goal: expectedState.goal,
            appliedContributionKeys: expectedState.appliedContributionKeys,
          },
          acceptedCommand,
          localDate
        );
        actualResult = applyActualContribution(
          actualState,
          acceptedCommand,
          localDate
        );

        assertMatchesReference(actualResult, expectedState);
        assert.equal(actualResult.status, 'replayed');
        assert.equal(actualResult.invalidContributionDraft, null);
        assert.deepEqual(actualResult.errors, []);
      }

      assert.deepEqual(initialState, unchangedInitialState);
    }),
    { numRuns: NUM_RUNS }
  );
});

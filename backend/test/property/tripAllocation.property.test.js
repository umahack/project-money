import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { allocateTripExpense } from '../../src/domain/trips.js';

const NUM_RUNS = 200;
const MAX_AMOUNT_MINOR = 1_000_000_000_000;
const MAX_WEIGHT = 1_000_000;

function boundaryIntegerArbitrary(min, max) {
  if (min === max) return fc.constant(min);
  return fc.oneof(
    fc.constant(min),
    fc.constant(max),
    fc.integer({ min, max })
  );
}

function referenceHalfUpShare(amountMinor, weight, totalWeight) {
  const numerator = BigInt(amountMinor) * BigInt(weight);
  const denominator = BigInt(totalWeight);
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;

  return {
    amountMinor: Number(
      remainder * 2n >= denominator ? quotient + 1n : quotient
    ),
    numerator: numerator.toString(),
    denominator: denominator.toString(),
  };
}

function referenceAllocation({ amountMinor, memberOrder, weightsByMemberId }) {
  const totalWeight = memberOrder.reduce(
    (total, memberId) => total + weightsByMemberId.get(memberId),
    0
  );
  const initialShares = memberOrder.map((memberId) => referenceHalfUpShare(
    amountMinor,
    weightsByMemberId.get(memberId),
    totalWeight
  ));
  const initialAmounts = initialShares.map(({ amountMinor: share }) => share);
  const initialTotal = initialAmounts.reduce((total, share) => total + share, 0);
  const difference = amountMinor - initialTotal;
  const direction = Math.sign(difference);
  let remaining = Math.abs(difference);
  const finalAmounts = [...initialAmounts];
  const adjustmentSequence = [];

  while (remaining > 0) {
    for (let index = 0; index < memberOrder.length && remaining > 0; index += 1) {
      if (direction < 0 && finalAmounts[index] === 0) continue;
      finalAmounts[index] += direction;
      remaining -= 1;
      adjustmentSequence.push({
        sequence: adjustmentSequence.length + 1,
        memberId: memberOrder[index],
        adjustmentMinor: direction,
      });
    }
  }

  return {
    totalWeight,
    initialShares,
    finalAmounts,
    adjustments: finalAmounts.map((amount, index) => amount - initialAmounts[index]),
    adjustmentSequence,
  };
}

const memberOrderArbitrary = fc
  .uniqueArray(fc.integer({ min: 1, max: 1_000_000 }), {
    minLength: 1,
    maxLength: 12,
  })
  .map((memberIds) => [...memberIds].sort((left, right) => left - right));

const weightArbitrary = fc.oneof(
  fc.constant(0),
  fc.constant(1),
  fc.constant(MAX_WEIGHT),
  fc.integer({ min: 0, max: MAX_WEIGHT })
);

const tripAllocationCaseArbitrary = memberOrderArbitrary.chain((memberOrder) => (
  fc.record({
    expenseId: fc.integer({ min: 1, max: 1_000_000 }),
    amountMinor: boundaryIntegerArbitrary(1, MAX_AMOUNT_MINOR),
    weights: fc.array(weightArbitrary, {
      minLength: memberOrder.length,
      maxLength: memberOrder.length,
    }),
    positiveWeightIndex: fc.integer({ min: 0, max: memberOrder.length - 1 }),
    requiredPositiveWeight: boundaryIntegerArbitrary(1, MAX_WEIGHT),
    inputRotation: fc.integer({ min: 0, max: memberOrder.length - 1 }),
    reverseInput: fc.boolean(),
  }).map((scenario) => {
    const weights = [...scenario.weights];
    weights[scenario.positiveWeightIndex] = scenario.requiredPositiveWeight;
    const orderedWeights = memberOrder.map((memberId, index) => ({
      memberId,
      weight: weights[index],
    }));
    const rotatedWeights = [
      ...orderedWeights.slice(scenario.inputRotation),
      ...orderedWeights.slice(0, scenario.inputRotation),
    ];

    return {
      expenseId: scenario.expenseId,
      amountMinor: scenario.amountMinor,
      memberOrder,
      memberWeights: scenario.reverseInput
        ? [...rotatedWeights].reverse()
        : rotatedWeights,
    };
  })
));

// Feature: financial-clarity-experience, Property 11: Trip allocation conserves each expense deterministically
// **Validates: Requirements 7.1, 7.3, 7.4**
test('Property 11: trip allocation conserves each expense deterministically', () => {
  fc.assert(
    fc.property(tripAllocationCaseArbitrary, (scenario) => {
      const weightsByMemberId = new Map(
        scenario.memberWeights.map(({ memberId, weight }) => [memberId, weight])
      );
      const expected = referenceAllocation({
        amountMinor: scenario.amountMinor,
        memberOrder: scenario.memberOrder,
        weightsByMemberId,
      });
      const input = {
        expenseId: scenario.expenseId,
        amountMinor: scenario.amountMinor,
        memberWeights: scenario.memberWeights,
        memberOrder: scenario.memberOrder,
      };

      const first = allocateTripExpense(structuredClone(input));
      const repeated = allocateTripExpense(structuredClone(input));
      const reorderedInput = allocateTripExpense({
        ...structuredClone(input),
        memberWeights: [...scenario.memberWeights].reverse(),
      });

      assert.deepEqual(repeated, first);
      assert.deepEqual(reorderedInput, first);
      assert.equal(first.totalWeight, expected.totalWeight);
      assert.deepEqual(
        first.allocations.map(({ memberId }) => memberId),
        scenario.memberOrder
      );

      first.allocations.forEach((allocation, index) => {
        const initial = expected.initialShares[index];
        assert.equal(allocation.weight, weightsByMemberId.get(allocation.memberId));
        assert.deepEqual(allocation.rawShare, {
          numerator: initial.numerator,
          denominator: initial.denominator,
        });
        assert.equal(allocation.initialAmountMinor, initial.amountMinor);
        assert.equal(allocation.roundingAdjustmentMinor, expected.adjustments[index]);
        assert.equal(allocation.amountMinor, expected.finalAmounts[index]);
        assert.equal(Number.isSafeInteger(allocation.amountMinor), true);
        assert.ok(allocation.amountMinor >= 0);
      });

      const allocatedTotal = first.allocations.reduce(
        (total, allocation) => total + BigInt(allocation.amountMinor),
        0n
      );
      assert.equal(allocatedTotal, BigInt(scenario.amountMinor));
      assert.deepEqual(first.adjustmentSequence, expected.adjustmentSequence);
      assert.equal(
        first.adjustmentSequence.length,
        Math.abs(
          scenario.amountMinor
            - expected.initialShares.reduce(
              (total, share) => total + share.amountMinor,
              0
            )
        )
      );
      first.adjustmentSequence.forEach((adjustment, index) => {
        assert.equal(adjustment.sequence, index + 1);
        assert.equal(Math.abs(adjustment.adjustmentMinor), 1);
      });
    }),
    { numRuns: NUM_RUNS }
  );
});

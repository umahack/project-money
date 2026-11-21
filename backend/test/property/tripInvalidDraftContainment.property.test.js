import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { calculateTripOutcome } from '../../src/domain/trips.js';

const NUM_RUNS = 100;
const MAX_AMOUNT_MINOR = 1_000_000;

const scenarioArbitrary = fc.integer({ min: 2, max: 6 }).chain((memberCount) => {
  const weightsArbitrary = fc
    .array(fc.integer({ min: 0, max: 1_000 }), {
      minLength: memberCount,
      maxLength: memberCount,
    })
    .filter((weights) => weights.some((weight) => weight > 0));

  return fc.record({
    tripId: fc.integer({ min: 1, max: 10_000 }),
    confirmedVersion: fc.integer({ min: 0, max: 10_000 }),
    members: fc.constant(
      Array.from({ length: memberCount }, (_, index) => ({
        id: index + 1,
        name: `Member ${index + 1}`,
      }))
    ),
    expenses: fc.array(
      fc.record({
        amountMinor: fc.integer({ min: 1, max: MAX_AMOUNT_MINOR }),
        payerIndex: fc.integer({ min: 0, max: memberCount - 1 }),
        weights: weightsArbitrary,
      }),
      { minLength: 1, maxLength: 4 }
    ),
    payments: fc.array(
      fc.record({
        amountMinor: fc.integer({ min: 1, max: MAX_AMOUNT_MINOR }),
        fromIndex: fc.integer({ min: 0, max: memberCount - 1 }),
        recipientOffset: fc.integer({ min: 1, max: memberCount - 1 }),
      }),
      { minLength: 1, maxLength: 3 }
    ),
  });
});

function buildRecords(scenario) {
  const memberCount = scenario.members.length;
  const sharedExpenses = scenario.expenses.map((expense, index) => ({
    id: index + 1,
    kind: 'shared_expense',
    payerMemberId: scenario.members[expense.payerIndex].id,
    amountMinor: expense.amountMinor,
    splitRule: 'weighted',
    memberWeights: scenario.members.map((member, memberIndex) => ({
      memberId: member.id,
      weight: expense.weights[memberIndex],
    })),
  }));
  const settlementPayments = scenario.payments.map((payment, index) => {
    const fromMemberId = scenario.members[payment.fromIndex].id;
    const toIndex = (payment.fromIndex + payment.recipientOffset) % memberCount;
    return {
      id: sharedExpenses.length + index + 1,
      kind: 'settlement_payment',
      fromMemberId,
      toMemberId: scenario.members[toIndex].id,
      amountMinor: payment.amountMinor,
    };
  });
  return { sharedExpenses, settlementPayments };
}

function replaceRecord(records, recordId, replacement) {
  return records.map((record) => (
    record.id === recordId ? replacement(structuredClone(record)) : structuredClone(record)
  ));
}

function invalidDraftCases({ members, records, sharedExpenses, settlementPayments }) {
  const expenseId = sharedExpenses[0].id;
  const paymentId = settlementPayments[0].id;
  const unknownMemberId = Math.max(...members.map(({ id }) => id)) + 1;

  return [
    {
      category: 'malformed split',
      code: 'INCOMPLETE_SPLIT',
      field: 'memberWeights',
      records: replaceRecord(records, expenseId, (expense) => ({
        ...expense,
        memberWeights: [],
      })),
    },
    {
      category: 'malformed split',
      code: 'INCOMPLETE_SPLIT',
      field: 'memberWeights',
      records: replaceRecord(records, expenseId, (expense) => ({
        ...expense,
        memberWeights: expense.memberWeights.map((entry) => ({ ...entry, weight: 0 })),
      })),
    },
    {
      category: 'malformed split',
      code: 'DUPLICATE_SPLIT_MEMBER',
      field: 'memberWeights[1]',
      records: replaceRecord(records, expenseId, (expense) => ({
        ...expense,
        memberWeights: [
          expense.memberWeights[0],
          { ...expense.memberWeights[0] },
        ],
      })),
    },
    {
      category: 'malformed split',
      code: 'INVALID_SPLIT_WEIGHT',
      field: 'memberWeights[0].weight',
      records: replaceRecord(records, expenseId, (expense) => ({
        ...expense,
        memberWeights: [
          { ...expense.memberWeights[0], weight: -1 },
          ...expense.memberWeights.slice(1),
        ],
      })),
    },
    {
      category: 'unknown member',
      code: 'UNKNOWN_TRIP_MEMBER',
      field: 'payerMemberId',
      records: replaceRecord(records, expenseId, (expense) => ({
        ...expense,
        payerMemberId: unknownMemberId,
      })),
    },
    {
      category: 'unknown member',
      code: 'UNKNOWN_TRIP_MEMBER',
      field: 'memberWeights[0].memberId',
      records: replaceRecord(records, expenseId, (expense) => ({
        ...expense,
        memberWeights: [
          { ...expense.memberWeights[0], memberId: unknownMemberId },
          ...expense.memberWeights.slice(1),
        ],
      })),
    },
    {
      category: 'invalid payment',
      code: 'INVALID_TRIP_AMOUNT',
      field: 'amountMinor',
      records: replaceRecord(records, paymentId, (payment) => ({
        ...payment,
        amountMinor: 0,
      })),
    },
    {
      category: 'invalid payment',
      code: 'INVALID_SETTLEMENT_MEMBERS',
      field: 'toMemberId',
      records: replaceRecord(records, paymentId, (payment) => ({
        ...payment,
        toMemberId: payment.fromMemberId,
      })),
    },
    {
      category: 'invalid payment',
      code: 'UNKNOWN_TRIP_MEMBER',
      field: 'fromMemberId',
      records: replaceRecord(records, paymentId, (payment) => ({
        ...payment,
        fromMemberId: unknownMemberId,
      })),
    },
    {
      category: 'invalid payment',
      code: 'UNKNOWN_TRIP_MEMBER',
      field: 'toMemberId',
      records: replaceRecord(records, paymentId, (payment) => ({
        ...payment,
        toMemberId: unknownMemberId,
      })),
    },
  ];
}

function assertInvalidIssue(outcome, draftCase) {
  const issue = outcome.invalid.find(({ code, field }) => (
    code === draftCase.code && field === draftCase.field
  ));
  assert.ok(
    issue,
    `${draftCase.category} must identify ${draftCase.field} with ${draftCase.code}`
  );
  assert.equal(typeof issue.constraint, 'string');
  assert.ok(issue.constraint.length > 0);
}

function assertRetainsConfirmed({
  draftCase,
  outcome,
  confirmed,
  attemptedTripVersion,
}) {
  assert.equal(outcome.status, 'invalid_input');
  assert.equal(outcome.availability, 'retained_last_confirmed');
  assert.equal(outcome.attemptedTripVersion, attemptedTripVersion);
  assert.equal(outcome.tripVersion, confirmed.tripVersion);
  assert.deepEqual(outcome.value, confirmed.value);
  assert.deepEqual(outcome.outcomes.memberBalances, {
    status: 'retained_last_confirmed',
    invalid: outcome.invalid,
    value: confirmed.value.balances,
  });
  assert.deepEqual(outcome.outcomes.tripSettlement, {
    status: 'retained_last_confirmed',
    invalid: outcome.invalid,
    value: confirmed.value.settlements,
  });
  assertInvalidIssue(outcome, draftCase);
}

function assertUnavailable({ draftCase, outcome, attemptedTripVersion }) {
  assert.equal(outcome.status, 'invalid_input');
  assert.equal(outcome.availability, 'unavailable');
  assert.equal(outcome.attemptedTripVersion, attemptedTripVersion);
  assert.equal(outcome.tripVersion, null);
  assert.equal('value' in outcome, false);
  assert.deepEqual(outcome.outcomes.memberBalances, {
    status: 'unavailable',
    invalid: outcome.invalid,
  });
  assert.deepEqual(outcome.outcomes.tripSettlement, {
    status: 'unavailable',
    invalid: outcome.invalid,
  });
  assertInvalidIssue(outcome, draftCase);
}

function assertValidExplanation(outcome) {
  assert.equal(outcome.status, 'available');
  const {
    allocations,
    explanation,
    settlements,
    sharedExpenses,
    settlementPayments,
  } = outcome.value;

  assert.equal(explanation.precisionMinor, 1);
  assert.deepEqual(
    explanation.sourceRefs.map(({ order }) => order),
    explanation.sourceRefs.map((_, index) => index + 1)
  );
  assert.deepEqual(
    explanation.operations.map(({ order }) => order),
    explanation.operations.map((_, index) => index + 1)
  );

  for (const expense of sharedExpenses) {
    const sourceFields = explanation.sourceRefs
      .filter(({ sourceType, recordId }) => (
        sourceType === 'trip_expense' && recordId === expense.id
      ))
      .map(({ field }) => field);
    assert.deepEqual(sourceFields, [
      'amountMinor',
      'payerMemberId',
      ...expense.memberWeights.map(({ memberId }) => `splitRule.member:${memberId}`),
    ]);

    const allocation = allocations.find(({ expenseId }) => expenseId === expense.id);
    assert.ok(allocation, `expense ${expense.id} must have an allocation`);
    const allocationOperation = explanation.operations.find(({ stage, expenseId }) => (
      stage === 'allocate_shared_expense' && expenseId === expense.id
    ));
    assert.ok(allocationOperation, `expense ${expense.id} must have an allocation operation`);
    assert.equal(allocationOperation.payerMemberId, expense.payerMemberId);
    assert.equal(allocationOperation.splitRule, expense.splitRule);
    assert.deepEqual(
      allocationOperation.allocations.map(({ memberId, weight, result }) => ({
        memberId,
        weight,
        amountMinor: result.amountMinor,
      })),
      allocation.allocations.map(({ memberId, weight, amountMinor }) => ({
        memberId,
        weight,
        amountMinor,
      }))
    );

    const adjustmentOperation = explanation.operations.find(({ stage, expenseId }) => (
      stage === 'adjust_allocation_remainder' && expenseId === expense.id
    ));
    assert.ok(adjustmentOperation, `expense ${expense.id} must have an adjustment operation`);
    assert.deepEqual(adjustmentOperation.adjustmentSequence, allocation.adjustmentSequence);

    const roundingAdjustment = explanation.roundingAdjustments.find(
      ({ expenseId }) => expenseId === expense.id
    );
    assert.ok(roundingAdjustment, `expense ${expense.id} must describe rounding adjustments`);
    assert.deepEqual(
      roundingAdjustment.memberAdjustments,
      allocation.allocations.map((share) => ({
        memberId: share.memberId,
        initialAmountMinor: share.initialAmountMinor,
        adjustmentMinor: share.roundingAdjustmentMinor,
        amountMinor: share.amountMinor,
      }))
    );
    assert.deepEqual(roundingAdjustment.sequence, allocation.adjustmentSequence);
  }
  assert.equal(explanation.roundingAdjustments.length, sharedExpenses.length);

  for (const payment of settlementPayments) {
    const sourceFields = explanation.sourceRefs
      .filter(({ sourceType, recordId }) => (
        sourceType === 'trip_settlement' && recordId === payment.id
      ))
      .map(({ field }) => field);
    assert.deepEqual(sourceFields, ['amountMinor', 'fromMemberId', 'toMemberId']);
    assert.ok(explanation.operations.some((operation) => (
      operation.stage === 'apply_settlement_payment'
      && operation.settlementPaymentId === payment.id
      && operation.fromMemberId === payment.fromMemberId
      && operation.toMemberId === payment.toMemberId
      && operation.result.amountMinor === payment.amountMinor
    )), `settlement payment ${payment.id} must have an explanation operation`);
  }

  for (const settlement of settlements) {
    assert.ok(explanation.operations.some((operation) => (
      operation.stage === 'propose_settlement_transfer'
      && operation.fromMemberId === settlement.fromMemberId
      && operation.toMemberId === settlement.toMemberId
      && operation.result.amountMinor === settlement.amountMinor
    )), 'each proposed settlement must have an explanation operation');
  }
}

// Feature: financial-clarity-experience, Property 13: Invalid trip drafts cannot replace confirmed outcomes
// **Validates: Requirements 7.11, 7.16, 7.17, 7.18**
test('Property 13: invalid trip drafts cannot replace confirmed outcomes', () => {
  fc.assert(
    fc.property(scenarioArbitrary, (scenario) => {
      const { sharedExpenses, settlementPayments } = buildRecords(scenario);
      const records = [...sharedExpenses, ...settlementPayments];
      const confirmed = calculateTripOutcome({
        tripId: scenario.tripId,
        tripVersion: scenario.confirmedVersion,
        members: scenario.members,
        records,
      });
      assert.equal(confirmed.status, 'available');
      const unchangedConfirmed = structuredClone(confirmed);
      const attemptedTripVersion = scenario.confirmedVersion + 1;

      const validControl = calculateTripOutcome({
        tripId: scenario.tripId,
        tripVersion: attemptedTripVersion,
        members: scenario.members,
        records,
        lastConfirmed: confirmed,
      });
      assert.equal(validControl.tripVersion, attemptedTripVersion);
      assertValidExplanation(validControl);

      const draftCases = invalidDraftCases({
        members: scenario.members,
        records,
        sharedExpenses,
        settlementPayments,
      });
      for (const draftCase of draftCases) {
        const retained = calculateTripOutcome({
          tripId: scenario.tripId,
          tripVersion: attemptedTripVersion,
          members: scenario.members,
          records: draftCase.records,
          lastConfirmed: confirmed,
        });
        assertRetainsConfirmed({
          draftCase,
          outcome: retained,
          confirmed,
          attemptedTripVersion,
        });

        const unavailable = calculateTripOutcome({
          tripId: scenario.tripId,
          tripVersion: attemptedTripVersion,
          members: scenario.members,
          records: draftCase.records,
        });
        assertUnavailable({ draftCase, outcome: unavailable, attemptedTripVersion });
      }

      assert.deepEqual(confirmed, unchangedConfirmed);
    }),
    { numRuns: NUM_RUNS }
  );
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LEGACY_SETTLEMENT_PREFIX,
  allocateTripExpense,
  calculateTripBalances,
  calculateTripOutcome,
  normalizeStoredTripRecords,
} from '../../src/domain/trips.js';

const members = [
  { id: 3, name: 'Cara' },
  { id: 1, name: 'Alice' },
  { id: 2, name: 'Bob' },
];

function sharedExpense(overrides = {}) {
  return {
    id: 10,
    kind: 'shared_expense',
    payerMemberId: 1,
    amountMinor: 100,
    splitRule: 'weighted',
    memberWeights: [
      { memberId: 3, weight: 1 },
      { memberId: 1, weight: 1 },
      { memberId: 2, weight: 1 },
    ],
    description: 'Dinner',
    ...overrides,
  };
}

test('weighted allocation rounds half-up and adjusts paise in confirmed member order', () => {
  const input = {
    expenseId: 9,
    amountMinor: 10,
    memberWeights: [
      { memberId: 20, weight: 1 },
      { memberId: 10, weight: 1 },
      { memberId: 30, weight: 1 },
    ],
    memberOrder: [10, 20, 30],
  };
  const unchangedInput = structuredClone(input);

  const increased = allocateTripExpense(input);

  assert.deepEqual(input, unchangedInput);
  assert.deepEqual(
    increased.allocations.map((share) => ({
      memberId: share.memberId,
      initialAmountMinor: share.initialAmountMinor,
      adjustmentMinor: share.roundingAdjustmentMinor,
      amountMinor: share.amountMinor,
    })),
    [
      { memberId: 10, initialAmountMinor: 3, adjustmentMinor: 1, amountMinor: 4 },
      { memberId: 20, initialAmountMinor: 3, adjustmentMinor: 0, amountMinor: 3 },
      { memberId: 30, initialAmountMinor: 3, adjustmentMinor: 0, amountMinor: 3 },
    ]
  );
  assert.equal(
    increased.allocations.reduce((total, share) => total + share.amountMinor, 0),
    input.amountMinor
  );
  assert.deepEqual(increased.adjustmentSequence, [
    { sequence: 1, memberId: 10, adjustmentMinor: 1 },
  ]);

  const decreased = allocateTripExpense({ ...input, amountMinor: 2 });
  assert.deepEqual(
    decreased.allocations.map(({ memberId, initialAmountMinor, amountMinor }) => ({
      memberId,
      initialAmountMinor,
      amountMinor,
    })),
    [
      { memberId: 10, initialAmountMinor: 1, amountMinor: 0 },
      { memberId: 20, initialAmountMinor: 1, amountMinor: 1 },
      { memberId: 30, initialAmountMinor: 1, amountMinor: 1 },
    ]
  );
  assert.deepEqual(decreased.adjustmentSequence, [
    { sequence: 1, memberId: 10, adjustmentMinor: -1 },
  ]);
});

test('balances apply explicit expenses and settlement payments and proposed transfers clear the ledger', () => {
  const result = calculateTripBalances({
    members,
    sharedExpenses: [sharedExpense()],
    settlementPayments: [{
      id: 11,
      kind: 'settlement_payment',
      fromMemberId: 2,
      toMemberId: 1,
      amountMinor: 10,
      description: 'Partial repayment',
    }],
  });

  assert.deepEqual(result.members.map(({ id }) => id), [1, 2, 3]);
  assert.deepEqual(
    result.balances.map((balance) => ({
      memberId: balance.memberId,
      sharedExpensePaymentsMadeMinor: balance.sharedExpensePaymentsMadeMinor,
      settlementPaymentsMadeMinor: balance.settlementPaymentsMadeMinor,
      allocatedSharesMinor: balance.allocatedSharesMinor,
      settlementPaymentsReceivedMinor: balance.settlementPaymentsReceivedMinor,
      amountMinor: balance.amountMinor,
      displayAmountMinor: balance.displayAmountMinor,
      label: balance.label,
    })),
    [
      {
        memberId: 1,
        sharedExpensePaymentsMadeMinor: 100,
        settlementPaymentsMadeMinor: 0,
        allocatedSharesMinor: 34,
        settlementPaymentsReceivedMinor: 10,
        amountMinor: 56,
        displayAmountMinor: 56,
        label: 'receivable',
      },
      {
        memberId: 2,
        sharedExpensePaymentsMadeMinor: 0,
        settlementPaymentsMadeMinor: 10,
        allocatedSharesMinor: 33,
        settlementPaymentsReceivedMinor: 0,
        amountMinor: -23,
        displayAmountMinor: 23,
        label: 'owed',
      },
      {
        memberId: 3,
        sharedExpensePaymentsMadeMinor: 0,
        settlementPaymentsMadeMinor: 0,
        allocatedSharesMinor: 33,
        settlementPaymentsReceivedMinor: 0,
        amountMinor: -33,
        displayAmountMinor: 33,
        label: 'owed',
      },
    ]
  );
  assert.equal(result.balanceTotalMinor, 0);
  assert.deepEqual(
    result.settlements.map(({ fromMemberId, toMemberId, amountMinor }) => ({
      fromMemberId,
      toMemberId,
      amountMinor,
    })),
    [
      { fromMemberId: 3, toMemberId: 1, amountMinor: 33 },
      { fromMemberId: 2, toMemberId: 1, amountMinor: 23 },
    ]
  );
  assert.deepEqual(result.postSettlementBalances, [
    { memberId: 1, amountMinor: 0 },
    { memberId: 2, amountMinor: 0 },
    { memberId: 3, amountMinor: 0 },
  ]);

  const settled = calculateTripBalances({ members: [{ id: 1, name: 'Alice' }] });
  assert.deepEqual(settled.balances, [{
    memberId: 1,
    order: 0,
    sharedExpensePaymentsMadeMinor: 0,
    settlementPaymentsMadeMinor: 0,
    allocatedSharesMinor: 0,
    settlementPaymentsReceivedMinor: 0,
    amountMinor: 0,
    displayAmountMinor: 0,
    label: 'settled',
  }]);
  assert.deepEqual(settled.settlements, []);
});

test('stored payer names and split JSON normalize into explicit expense and settlement records', () => {
  const storedMembers = [
    { id: 20, name: 'Bob' },
    { id: 10, name: 'Alice' },
  ];
  const expenses = [
    {
      id: 5,
      payer: 'Alice',
      description: 'Taxi',
      amount: 1,
      split_json: JSON.stringify([
        { name: 'Bob', share: 1 },
        { name: 'Alice', share: 1 },
      ]),
    },
    {
      id: 6,
      payer: 'Bob',
      description: `${LEGACY_SETTLEMENT_PREFIX}Bob → Alice`,
      amount: 0.25,
      split_json: JSON.stringify([{ name: 'Alice', share: 1 }]),
    },
  ];
  const normalized = normalizeStoredTripRecords({ members: storedMembers, expenses });

  assert.equal(normalized.valid, true);
  assert.deepEqual(normalized.members.map(({ id }) => id), [10, 20]);
  assert.deepEqual(normalized.sharedExpenses, [{
    id: 5,
    kind: 'shared_expense',
    payerMemberId: 10,
    amountMinor: 100,
    splitRule: 'weighted',
    memberWeights: [
      { memberId: 10, weight: 100 },
      { memberId: 20, weight: 100 },
    ],
    description: 'Taxi',
    sourceBoundary: 'stored_payer_name_split_json',
  }]);
  assert.deepEqual(normalized.settlementPayments, [{
    id: 6,
    kind: 'settlement_payment',
    fromMemberId: 20,
    toMemberId: 10,
    amountMinor: 25,
    description: `${LEGACY_SETTLEMENT_PREFIX}Bob → Alice`,
    sourceBoundary: 'stored_payer_name_split_json',
  }]);

  const outcome = calculateTripOutcome({
    tripId: 7,
    tripVersion: 3,
    members: storedMembers,
    expenses,
  });
  assert.equal(outcome.status, 'available');
  assert.deepEqual(
    outcome.value.balances.map(({ memberId, amountMinor, label }) => ({
      memberId,
      amountMinor,
      label,
    })),
    [
      { memberId: 10, amountMinor: 25, label: 'receivable' },
      { memberId: 20, amountMinor: -25, label: 'owed' },
    ]
  );
  assert.deepEqual(
    outcome.value.settlements.map(({ fromMemberId, toMemberId, amountMinor }) => ({
      fromMemberId,
      toMemberId,
      amountMinor,
    })),
    [{ fromMemberId: 20, toMemberId: 10, amountMinor: 25 }]
  );
});

test('invalid drafts retain confirmed balances without publishing a new version', () => {
  const confirmed = calculateTripOutcome({
    tripId: 7,
    tripVersion: 4,
    members,
    records: [sharedExpense()],
  });
  const confirmedCopy = structuredClone(confirmed);

  const invalidDraft = calculateTripOutcome({
    tripId: 7,
    tripVersion: 5,
    members,
    expenses: [{
      id: 12,
      payer: 'Alice',
      description: 'Broken split',
      amount: 1,
      split_json: '{not-json',
    }],
    lastConfirmed: confirmed,
  });

  assert.deepEqual(confirmed, confirmedCopy);
  assert.equal(invalidDraft.status, 'invalid_input');
  assert.equal(invalidDraft.availability, 'retained_last_confirmed');
  assert.equal(invalidDraft.attemptedTripVersion, 5);
  assert.equal(invalidDraft.tripVersion, 4);
  assert.deepEqual(invalidDraft.value, confirmed.value);
  assert.equal(invalidDraft.invalid[0].code, 'INVALID_SPLIT_JSON');
  assert.equal(invalidDraft.invalid[0].field, 'split_json');
  assert.equal(invalidDraft.outcomes.memberBalances.status, 'retained_last_confirmed');
  assert.equal(invalidDraft.outcomes.tripSettlement.status, 'retained_last_confirmed');

  const unavailable = calculateTripOutcome({
    tripId: 7,
    tripVersion: 1,
    members,
    records: [sharedExpense({ memberWeights: [] })],
  });
  assert.equal(unavailable.status, 'invalid_input');
  assert.equal(unavailable.availability, 'unavailable');
  assert.equal(unavailable.tripVersion, null);
  assert.equal('value' in unavailable, false);
  assert.equal(unavailable.outcomes.memberBalances.status, 'unavailable');
  assert.equal(unavailable.outcomes.tripSettlement.status, 'unavailable');
});

test('valid outcomes explain every expense, payer, share, payment, and rounding adjustment', () => {
  const input = {
    tripId: 8,
    tripVersion: 2,
    members,
    records: [
      sharedExpense(),
      {
        id: 11,
        kind: 'settlement_payment',
        fromMemberId: 2,
        toMemberId: 1,
        amountMinor: 10,
      },
    ],
  };
  const unchangedInput = structuredClone(input);

  const outcome = calculateTripOutcome(input);
  const explanation = outcome.value.explanation;

  assert.deepEqual(input, unchangedInput);
  assert.equal(outcome.status, 'available');
  assert.equal(explanation.precisionMinor, 1);
  assert.deepEqual(
    explanation.sourceRefs.map(({ sourceType, recordId, field }) => ({
      sourceType,
      recordId,
      field,
    })),
    [
      { sourceType: 'trip_expense', recordId: 10, field: 'amountMinor' },
      { sourceType: 'trip_expense', recordId: 10, field: 'payerMemberId' },
      { sourceType: 'trip_expense', recordId: 10, field: 'splitRule.member:1' },
      { sourceType: 'trip_expense', recordId: 10, field: 'splitRule.member:2' },
      { sourceType: 'trip_expense', recordId: 10, field: 'splitRule.member:3' },
      { sourceType: 'trip_settlement', recordId: 11, field: 'amountMinor' },
      { sourceType: 'trip_settlement', recordId: 11, field: 'fromMemberId' },
      { sourceType: 'trip_settlement', recordId: 11, field: 'toMemberId' },
    ]
  );
  assert.deepEqual(
    explanation.operations.map(({ stage }) => stage),
    [
      'allocate_shared_expense',
      'adjust_allocation_remainder',
      'apply_settlement_payment',
      'calculate_member_balance',
      'calculate_member_balance',
      'calculate_member_balance',
      'propose_settlement_transfer',
      'propose_settlement_transfer',
    ]
  );
  assert.equal(explanation.operations[0].payerMemberId, 1);
  assert.equal(explanation.operations[0].splitRule, 'weighted');
  assert.deepEqual(
    explanation.operations[0].allocations.map(({ memberId, result }) => ({ memberId, result })),
    [
      { memberId: 1, result: { currency: 'INR', amountMinor: 34 } },
      { memberId: 2, result: { currency: 'INR', amountMinor: 33 } },
      { memberId: 3, result: { currency: 'INR', amountMinor: 33 } },
    ]
  );
  assert.deepEqual(explanation.roundingAdjustments, [{
    expenseId: 10,
    adjustmentMinor: 1,
    memberAdjustments: [
      { memberId: 1, initialAmountMinor: 33, adjustmentMinor: 1, amountMinor: 34 },
      { memberId: 2, initialAmountMinor: 33, adjustmentMinor: 0, amountMinor: 33 },
      { memberId: 3, initialAmountMinor: 33, adjustmentMinor: 0, amountMinor: 33 },
    ],
    sequence: [{ sequence: 1, memberId: 1, adjustmentMinor: 1 }],
  }]);
});

test('trip validation identifies unknown members and incomplete splits', () => {
  const unknownPayer = calculateTripOutcome({
    tripVersion: 1,
    members,
    records: [sharedExpense({ payerMemberId: 99 })],
  });
  assert.equal(unknownPayer.status, 'invalid_input');
  assert.equal(unknownPayer.invalid[0].code, 'UNKNOWN_TRIP_MEMBER');
  assert.equal(unknownPayer.invalid[0].field, 'payerMemberId');

  const zeroWeights = calculateTripOutcome({
    tripVersion: 1,
    members,
    records: [sharedExpense({
      memberWeights: [
        { memberId: 1, weight: 0 },
        { memberId: 2, weight: 0 },
      ],
    })],
  });
  assert.equal(zeroWeights.status, 'invalid_input');
  assert.equal(zeroWeights.invalid[0].code, 'INCOMPLETE_SPLIT');
});

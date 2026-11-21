import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { calculateTripBalances } from '../../src/domain/trips.js';

const NUM_RUNS = 150;
const MAX_AMOUNT_MINOR = 2_000_000;
const MAX_MEMBER_COUNT = 6;
const MAX_RECORD_COUNT = 8;

function compareRemainingThenOrder(left, right) {
  if (left.remainingMinor > right.remainingMinor) return -1;
  if (left.remainingMinor < right.remainingMinor) return 1;
  return left.order - right.order;
}

function referenceHalfUpShare(amountMinor, weight, totalWeight) {
  const doubledNumerator = BigInt(amountMinor) * BigInt(weight) * 2n;
  const doubledDenominator = BigInt(totalWeight) * 2n;
  return Number(
    (doubledNumerator + BigInt(totalWeight)) / doubledDenominator
  );
}

function referenceAllocation(expense, orderedMemberIds) {
  const orderByMemberId = new Map(
    orderedMemberIds.map((memberId, order) => [memberId, order])
  );
  const orderedWeights = [...expense.memberWeights].sort(
    (left, right) => (
      orderByMemberId.get(left.memberId) - orderByMemberId.get(right.memberId)
    )
  );
  const totalWeight = orderedWeights.reduce(
    (total, { weight }) => total + weight,
    0
  );
  const allocations = orderedWeights.map(({ memberId, weight }) => ({
    memberId,
    amountMinor: referenceHalfUpShare(
      expense.amountMinor,
      weight,
      totalWeight
    ),
  }));
  const initialTotal = allocations.reduce(
    (total, { amountMinor }) => total + amountMinor,
    0
  );
  const direction = Math.sign(expense.amountMinor - initialTotal);
  let remaining = Math.abs(expense.amountMinor - initialTotal);

  while (remaining > 0) {
    for (const allocation of allocations) {
      if (remaining === 0) break;
      if (direction < 0 && allocation.amountMinor === 0) continue;
      allocation.amountMinor += direction;
      remaining -= 1;
    }
  }

  return allocations;
}

function referenceSettlementTransfers(balances) {
  const creditors = balances
    .filter(({ amountMinor }) => amountMinor > 0)
    .map(({ memberId, order, amountMinor }) => ({
      memberId,
      order,
      remainingMinor: amountMinor,
    }))
    .sort(compareRemainingThenOrder);
  const debtors = balances
    .filter(({ amountMinor }) => amountMinor < 0)
    .map(({ memberId, order, amountMinor }) => ({
      memberId,
      order,
      remainingMinor: -amountMinor,
    }))
    .sort(compareRemainingThenOrder);
  const transfers = [];
  let creditorIndex = 0;
  let debtorIndex = 0;

  while (creditorIndex < creditors.length && debtorIndex < debtors.length) {
    const creditor = creditors[creditorIndex];
    const debtor = debtors[debtorIndex];
    const amountMinor = Math.min(
      creditor.remainingMinor,
      debtor.remainingMinor
    );

    transfers.push({
      order: transfers.length + 1,
      fromMemberId: debtor.memberId,
      toMemberId: creditor.memberId,
      amountMinor,
      amount: { currency: 'INR', amountMinor },
    });
    creditor.remainingMinor -= amountMinor;
    debtor.remainingMinor -= amountMinor;
    if (creditor.remainingMinor === 0) creditorIndex += 1;
    if (debtor.remainingMinor === 0) debtorIndex += 1;
  }

  assert.equal(
    creditors.every(({ remainingMinor }) => remainingMinor === 0),
    true
  );
  assert.equal(
    debtors.every(({ remainingMinor }) => remainingMinor === 0),
    true
  );
  return transfers;
}

function referenceLedger({ members, sharedExpenses, settlementPayments }) {
  const orderedMembers = [...members].sort((left, right) => left.id - right.id);
  const orderedMemberIds = orderedMembers.map(({ id }) => id);
  const accounts = new Map(orderedMembers.map(({ id }, order) => [id, {
    memberId: id,
    order,
    sharedExpensePaymentsMadeMinor: 0,
    settlementPaymentsMadeMinor: 0,
    allocatedSharesMinor: 0,
    settlementPaymentsReceivedMinor: 0,
  }]));

  for (const expense of sharedExpenses) {
    accounts.get(expense.payerMemberId).sharedExpensePaymentsMadeMinor +=
      expense.amountMinor;
    for (const allocation of referenceAllocation(expense, orderedMemberIds)) {
      accounts.get(allocation.memberId).allocatedSharesMinor +=
        allocation.amountMinor;
    }
  }

  for (const payment of settlementPayments) {
    accounts.get(payment.fromMemberId).settlementPaymentsMadeMinor +=
      payment.amountMinor;
    accounts.get(payment.toMemberId).settlementPaymentsReceivedMinor +=
      payment.amountMinor;
  }

  const balances = orderedMembers.map(({ id }) => {
    const account = accounts.get(id);
    const amountMinor = account.sharedExpensePaymentsMadeMinor
      + account.settlementPaymentsMadeMinor
      - account.allocatedSharesMinor
      - account.settlementPaymentsReceivedMinor;
    return {
      ...account,
      amountMinor,
      displayAmountMinor: Math.abs(amountMinor),
      label: amountMinor > 0
        ? 'receivable'
        : amountMinor < 0
          ? 'owed'
          : 'settled',
    };
  });

  return {
    balances,
    settlements: referenceSettlementTransfers(balances),
  };
}

function applyTransfers(balances, transfers) {
  const postSettlement = new Map(
    balances.map(({ memberId, amountMinor }) => [memberId, amountMinor])
  );

  for (const transfer of transfers) {
    assert.ok(postSettlement.get(transfer.fromMemberId) < 0);
    assert.ok(postSettlement.get(transfer.toMemberId) > 0);
    assert.ok(transfer.amountMinor > 0);
    assert.ok(
      transfer.amountMinor <= -postSettlement.get(transfer.fromMemberId)
    );
    assert.ok(
      transfer.amountMinor <= postSettlement.get(transfer.toMemberId)
    );
    postSettlement.set(
      transfer.fromMemberId,
      postSettlement.get(transfer.fromMemberId) + transfer.amountMinor
    );
    postSettlement.set(
      transfer.toMemberId,
      postSettlement.get(transfer.toMemberId) - transfer.amountMinor
    );
  }

  return postSettlement;
}

function memberWeightsArbitrary(memberCount) {
  return fc.array(
    fc.integer({ min: 1, max: 100 }),
    { minLength: memberCount, maxLength: memberCount }
  );
}

function populatedLedgerArbitrary() {
  return fc.integer({ min: 2, max: MAX_MEMBER_COUNT }).chain((memberCount) => {
    const memberIds = Array.from(
      { length: memberCount },
      (_, index) => index + 1
    );
    const sharedExpenseArbitrary = fc.record({
      payerSelector: fc.nat(),
      amountMinor: fc.integer({ min: 1, max: MAX_AMOUNT_MINOR }),
      weights: memberWeightsArbitrary(memberCount),
    });
    const settlementPaymentArbitrary = fc.record({
      fromSelector: fc.nat(),
      recipientOffset: fc.integer({ min: 1, max: memberCount - 1 }),
      amountMinor: fc.integer({ min: 1, max: MAX_AMOUNT_MINOR }),
    });

    return fc.tuple(
      fc.shuffledSubarray(memberIds, {
        minLength: memberCount,
        maxLength: memberCount,
      }),
      fc.array(sharedExpenseArbitrary, {
        minLength: 1,
        maxLength: MAX_RECORD_COUNT,
      }),
      fc.array(settlementPaymentArbitrary, {
        maxLength: MAX_RECORD_COUNT,
      })
    ).map(([inputMemberIds, expenseDrafts, settlementDrafts]) => ({
      members: inputMemberIds.map((id) => ({ id })),
      sharedExpenses: expenseDrafts.map((draft, index) => ({
        id: 100 + index,
        payerMemberId: memberIds[draft.payerSelector % memberCount],
        amountMinor: draft.amountMinor,
        splitRule: 'weighted',
        memberWeights: memberIds.map((memberId, memberIndex) => ({
          memberId,
          weight: draft.weights[memberIndex],
        })),
      })),
      settlementPayments: settlementDrafts.map((draft, index) => {
        const fromIndex = draft.fromSelector % memberCount;
        const toIndex = (
          fromIndex + draft.recipientOffset
        ) % memberCount;
        return {
          id: 1_000 + index,
          fromMemberId: memberIds[fromIndex],
          toMemberId: memberIds[toIndex],
          amountMinor: draft.amountMinor,
        };
      }),
    }));
  });
}

const emptyLedgerArbitrary = fc.integer({ min: 1, max: MAX_MEMBER_COUNT })
  .chain((memberCount) => {
    const memberIds = Array.from(
      { length: memberCount },
      (_, index) => index + 1
    );
    return fc.shuffledSubarray(memberIds, {
      minLength: memberCount,
      maxLength: memberCount,
    });
  })
  .map((memberIds) => ({
    members: memberIds.map((id) => ({ id })),
    sharedExpenses: [],
    settlementPayments: [],
  }));

const validTripLedgerArbitrary = fc.oneof(
  { weight: 1, arbitrary: emptyLedgerArbitrary },
  { weight: 5, arbitrary: populatedLedgerArbitrary() }
);

// Feature: financial-clarity-experience, Property 12: Trip balances and settlements conserve money
// **Validates: Requirements 7.2, 7.5, 7.6, 7.7, 7.8, 7.9, 7.10**
test('Property 12: trip balances and settlements conserve money', () => {
  fc.assert(
    fc.property(validTripLedgerArbitrary, (ledger) => {
      const unchangedLedger = structuredClone(ledger);
      const expected = referenceLedger(ledger);
      const result = calculateTripBalances(ledger);

      assert.deepEqual(ledger, unchangedLedger);
      assert.deepEqual(result.balances, expected.balances);
      assert.equal(
        result.balances.reduce(
          (total, { amountMinor }) => total + amountMinor,
          0
        ),
        0
      );
      assert.equal(result.balanceTotalMinor, 0);

      for (const balance of result.balances) {
        assert.equal(
          balance.amountMinor,
          balance.sharedExpensePaymentsMadeMinor
            + balance.settlementPaymentsMadeMinor
            - balance.allocatedSharesMinor
            - balance.settlementPaymentsReceivedMinor
        );
        assert.equal(balance.displayAmountMinor, Math.abs(balance.amountMinor));
        assert.equal(
          balance.label,
          balance.amountMinor > 0
            ? 'receivable'
            : balance.amountMinor < 0
              ? 'owed'
              : 'settled'
        );
      }

      assert.deepEqual(result.settlements, expected.settlements);
      assert.deepEqual(
        calculateTripBalances(structuredClone(ledger)).settlements,
        result.settlements
      );
      const reordered = calculateTripBalances({
        members: [...ledger.members].reverse(),
        sharedExpenses: [...ledger.sharedExpenses].reverse(),
        settlementPayments: [...ledger.settlementPayments].reverse(),
      });
      assert.deepEqual(reordered.balances, result.balances);
      assert.deepEqual(reordered.settlements, result.settlements);

      const independentlySettled = applyTransfers(
        expected.balances,
        result.settlements
      );
      assert.equal(
        [...independentlySettled.values()].reduce(
          (total, amountMinor) => total + amountMinor,
          0
        ),
        0
      );
      assert.equal(
        [...independentlySettled.values()].every(
          (amountMinor) => amountMinor === 0
        ),
        true
      );
      assert.deepEqual(
        result.postSettlementBalances,
        result.members.map(({ id: memberId }) => ({ memberId, amountMinor: 0 }))
      );

      const recalculatedAfterSettlement = calculateTripBalances({
        ...ledger,
        settlementPayments: [
          ...ledger.settlementPayments,
          ...result.settlements.map((transfer, index) => ({
            id: 2_000 + index,
            fromMemberId: transfer.fromMemberId,
            toMemberId: transfer.toMemberId,
            amountMinor: transfer.amountMinor,
          })),
        ],
      });
      assert.equal(recalculatedAfterSettlement.balanceTotalMinor, 0);
      assert.equal(
        recalculatedAfterSettlement.balances.every((balance) => (
          balance.amountMinor === 0
          && balance.displayAmountMinor === 0
          && balance.label === 'settled'
        )),
        true
      );
      assert.deepEqual(recalculatedAfterSettlement.settlements, []);
    }),
    { numRuns: NUM_RUNS }
  );
});

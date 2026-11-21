import { describe, expect, it } from 'vitest';
import { isTripMutationPath, sendTripMutation } from '../../clarity/tripMutation';
import { currentMonth } from '../../money';
import { jsonFailure, jsonOk, mockTripApi, readSnapshot, tripSnapshot, tripWrite } from '../../test/tripFixtures';
import {
  balanceWording,
  describeTripProblem,
  findLinkedMember,
  orderTripsByNearestSettlement,
  ownBalanceWording,
  roundingWording,
} from './tripModel';

describe('balance wording', () => {
  it('writes receivable, owed, and settled as text', () => {
    expect(balanceWording({ amountMinor: 66666, label: 'receivable' })).toBe('Receivable ₹666.66');
    expect(balanceWording({ amountMinor: -33333, label: 'owed' })).toBe('Owed ₹333.33');
    expect(balanceWording({ amountMinor: 0, label: 'settled' })).toBe('Settled');
    expect(ownBalanceWording({ amountMinor: -500, label: 'owed' })).toBe('You owe ₹5 (owed).');
    expect(roundingWording(-1)).toBe('-₹0.01 rounding adjustment');
  });
});

describe('findLinkedMember', () => {
  const members = [
    { id: 1, name: 'A', email: 'Me@Example.test' },
    { id: 2, name: 'B', email: null },
  ];
  it('matches one member by email and nothing else', () => {
    expect(findLinkedMember(members, 'me@example.test')?.id).toBe(1);
    expect(findLinkedMember(members, 'nobody@example.test')).toBeUndefined();
    expect(findLinkedMember([...members, { id: 3, name: 'C', email: 'me@example.test' }], 'me@example.test')).toBeUndefined();
  });
});

describe('describeTripProblem', () => {
  it('maps a rejected split to the split field with the server constraint', () => {
    const problem = describeTripProblem({ message: 'Split required', status: 422, field: 'split[1].share', constraint: 'a non-negative finite number' }, 'Expense');
    expect(problem?.key).toBe('split');
    expect(problem?.problem.correction).toBe('Accepted: a non-negative finite number.');
  });
  it('leaves network, authorization, conflict, and server failures to the scoped status', () => {
    for (const status of [undefined, 0, 401, 403, 404, 409, 428, 429, 500]) {
      expect(describeTripProblem({ message: 'x', status }, 'Expense')).toBeNull();
    }
  });
});

describe('orderTripsByNearestSettlement', () => {
  const trips = [{ id: 7 }, { id: 5 }, { id: 3 }];
  it('keeps the given order without a snapshot or any ranking', () => {
    expect(orderTripsByNearestSettlement(trips, undefined).map((trip) => trip.id)).toEqual([7, 5, 3]);
    expect(orderTripsByNearestSettlement(trips, tripSnapshot('2026-01')).map((trip) => trip.id)).toEqual([7, 5, 3]);
  });
});

describe('trip write adapter', () => {
  it('only accepts the trip write paths', () => {
    expect(isTripMutationPath('/trips/3/expenses')).toBe(true);
    expect(isTripMutationPath('/trips/3/members')).toBe(true);
    expect(isTripMutationPath('/trips/3/expenses/11/personal-link')).toBe(true);
    expect(isTripMutationPath('/trips/3/share')).toBe(false);
    expect(isTripMutationPath('/finance/goals')).toBe(false);
  });

  it('returns the server write together with the confirmed snapshot', async () => {
    const api = mockTripApi({
      'POST /trips/3/expenses': jsonOkBody(),
      'GET /finance/clarity': readSnapshot(tripSnapshot(currentMonth())),
    });
    const envelope = await sendTripMutation({ path: '/trips/3/expenses', method: 'POST', body: {}, idempotencyKey: 'k-1' });
    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.id).toBe(12);
    expect(envelope.clarity.dataVersion).toBe(1);
    expect(api.to('POST', '/trips/3/expenses')[0]?.headers['Idempotency-Key']).toBe('k-1');
  });

  it('says the change was saved when only the snapshot read fails, so a retry is a refresh', async () => {
    mockTripApi({
      'POST /trips/3/expenses': jsonOkBody(),
      'GET /finance/clarity': () => jsonFailure(500, { error: 'down', code: 'X' }),
    });
    await expect(sendTripMutation({ path: '/trips/3/expenses', method: 'POST', body: {}, idempotencyKey: 'k-2' }))
      .rejects.toThrow('The change was saved, but the updated balances could not be loaded.');
  });
});

function jsonOkBody() {
  return () => jsonOk(tripWrite({ id: 12, operation: 'trip.expense.create', recordType: 'trip_expense', scopeKey: 'trip-expense:12' }));
}

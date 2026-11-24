import { afterEach, describe, expect, it, vi } from 'vitest';
import { notifyFinancialStateCleared } from '../stateLifecycle';
import {
  publishExpenseChange,
  resetExpenseEventsForTests,
  subscribeToExpenseChanges,
  type ConfirmedExpenseChange,
} from './expenseEvents';

const record = {
  id: 98,
  month: '2026-11',
  category: 'Bills',
  amountMinor: 2500000,
  note: 'rent',
  spentOn: '2026-11-18',
  excludeFromDailyAllowance: true,
} as const;

function created(overrides: Partial<ConfirmedExpenseChange> = {}): ConfirmedExpenseChange {
  return {
    confirmed: true,
    kind: 'create',
    expenseId: 98,
    originalMonth: null,
    resultingMonth: '2026-11',
    originalCategory: null,
    resultingCategory: 'Bills',
    excludedFromDailyAllowance: true,
    record,
    ...overrides,
  };
}

afterEach(resetExpenseEventsForTests);

describe('expense change bus', () => {
  it('delivers a confirmed change synchronously, in subscription order, with the record by reference', () => {
    const calls: string[] = [];
    const received: ConfirmedExpenseChange[] = [];
    subscribeToExpenseChanges((change) => { calls.push('first'); received.push(change); });
    subscribeToExpenseChanges(() => calls.push('second'));
    subscribeToExpenseChanges(() => calls.push('third'));
    const change = created();

    publishExpenseChange(change);

    expect(calls).toEqual(['first', 'second', 'third']);
    expect(received[0]).toBe(change);
    expect(received[0]?.record).toBe(record);
  });

  it('carries delete and update changes as the server reported them', () => {
    const seen: ConfirmedExpenseChange[] = [];
    subscribeToExpenseChanges((change) => seen.push(change));
    const moved = created({
      kind: 'update',
      originalMonth: '2026-10',
      originalCategory: 'Food',
    });
    const deleted = created({
      kind: 'delete',
      originalMonth: '2026-11',
      originalCategory: 'Bills',
      resultingMonth: null,
      resultingCategory: null,
      excludedFromDailyAllowance: null,
      record: null,
    });

    publishExpenseChange(moved);
    publishExpenseChange(deleted);

    expect(seen.map((change) => change.kind)).toEqual(['update', 'delete']);
    expect(seen[0]).toMatchObject({ originalMonth: '2026-10', resultingMonth: '2026-11' });
    expect(seen[1]).toMatchObject({ resultingMonth: null, record: null });
  });

  it('stops delivering after unsubscribe, leaves others subscribed, and tolerates a second unsubscribe', () => {
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = subscribeToExpenseChanges(first);
    subscribeToExpenseChanges(second);

    publishExpenseChange(created());
    unsubscribeFirst();
    unsubscribeFirst();
    publishExpenseChange(created({ kind: 'update' }));

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it('skips a subscriber that unsubscribes during delivery and defers one added during delivery', () => {
    const late = vi.fn();
    const removed = vi.fn();
    let unsubscribeRemoved = () => {};
    subscribeToExpenseChanges(() => {
      unsubscribeRemoved();
      subscribeToExpenseChanges(late);
    });
    unsubscribeRemoved = subscribeToExpenseChanges(removed);

    publishExpenseChange(created());
    expect(removed).not.toHaveBeenCalled();
    expect(late).not.toHaveBeenCalled();

    publishExpenseChange(created());
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('isolates a throwing subscriber from the others and from the publisher', () => {
    const after = vi.fn();
    const before = vi.fn();
    subscribeToExpenseChanges(before);
    subscribeToExpenseChanges(() => { throw new Error('view failed'); });
    subscribeToExpenseChanges(after);

    expect(() => publishExpenseChange(created())).not.toThrow();
    expect(before).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('does not log a failing subscriber', () => {
    const spies = [vi.spyOn(console, 'error'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'log')]
      .map((spy) => spy.mockImplementation(() => {}));
    subscribeToExpenseChanges(() => { throw new Error('view failed'); });
    publishExpenseChange(created());
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('drops every subscriber when the financial state clears, and accepts new ones afterwards', () => {
    const before = vi.fn();
    const unsubscribeBefore = subscribeToExpenseChanges(before);

    notifyFinancialStateCleared();
    publishExpenseChange(created());
    expect(before).not.toHaveBeenCalled();

    const after = vi.fn();
    subscribeToExpenseChanges(after);
    unsubscribeBefore(); // a stale unsubscribe must not remove the new subscriber
    publishExpenseChange(created());
    expect(after).toHaveBeenCalledTimes(1);
    expect(before).not.toHaveBeenCalled();
  });

  it('delivers nothing for a result that is not confirmed or is malformed', () => {
    const listener = vi.fn();
    subscribeToExpenseChanges(listener);
    const unconfirmed = { ...created(), confirmed: false } as unknown as ConfirmedExpenseChange;
    const withoutFlag = (({ confirmed: _confirmed, ...rest }) => rest)(created()) as unknown as ConfirmedExpenseChange;
    const badKind = created({ kind: 'pending' as unknown as 'create' });
    const badId = created({ expenseId: 0 });
    const pendingRecord = created({ record: undefined as unknown as null });

    for (const change of [unconfirmed, withoutFlag, badKind, badId, pendingRecord, null as never, undefined as never]) {
      expect(() => publishExpenseChange(change)).not.toThrow();
    }

    expect(listener).not.toHaveBeenCalled();
  });

  it('is empty after resetExpenseEventsForTests', () => {
    const listener = vi.fn();
    subscribeToExpenseChanges(listener);
    resetExpenseEventsForTests();
    publishExpenseChange(created());
    expect(listener).not.toHaveBeenCalled();
  });
});

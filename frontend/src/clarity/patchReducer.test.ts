import { describe, expect, it } from 'vitest';
import { makeSnapshot, tagPatch } from '../test/clarity-fixtures';
import {
  clarityReducer,
  initialClarityState,
  isScopePending,
  selectVisibleSnapshot,
  type ClarityAction,
  type ClarityState,
  type PendingMutation,
} from './patchReducer';

function mutation(id: string, scopeKey: string, mark: string, months?: string[]): PendingMutation {
  return { mutationId: id, scopeKey, submittedAt: 1, months, patch: tagPatch(mark) };
}

function run(actions: ClarityAction[], from: ClarityState = initialClarityState): ClarityState {
  return actions.reduce(clarityReducer, from);
}

const MONTH = '2026-01';
const visibleTag = (state: ClarityState, month = MONTH) => selectVisibleSnapshot(state, month)?.generatedAt;

describe('clarityReducer', () => {
  it('shows the confirmed snapshot with pending patches applied in submit order', () => {
    const state = run([
      { type: 'install', snapshot: makeSnapshot(3) },
      { type: 'submit', mutation: mutation('a', 'goal:1', 'a') },
      { type: 'submit', mutation: mutation('b', 'expense:2', 'b') },
    ]);

    expect(visibleTag(state)).toBe('v3+a+b');
    expect(state.confirmed[MONTH]?.generatedAt).toBe('v3');
  });

  it('returns nothing for a month with no confirmed snapshot', () => {
    expect(selectVisibleSnapshot(run([{ type: 'submit', mutation: mutation('a', 'goal:1', 'a') }]), MONTH))
      .toBeUndefined();
  });

  it('blocks a second submission for the same scope without changing state', () => {
    const state = run([{ type: 'submit', mutation: mutation('a', 'goal:1', 'a') }]);
    const next = clarityReducer(state, { type: 'submit', mutation: mutation('b', 'goal:1', 'b') });

    expect(next).toBe(state);
    expect(isScopePending(next, 'goal:1')).toBe(true);
  });

  it('allows independent scopes to be pending together', () => {
    const state = run([
      { type: 'submit', mutation: mutation('a', 'goal:1', 'a') },
      { type: 'submit', mutation: mutation('b', 'goal:2', 'b') },
    ]);

    expect(state.pending.map((item) => item.scopeKey)).toEqual(['goal:1', 'goal:2']);
  });

  it('removes only the failed patch and keeps unrelated pending patches', () => {
    const base = run([
      { type: 'install', snapshot: makeSnapshot(3) },
      { type: 'submit', mutation: mutation('a', 'goal:1', 'a') },
      { type: 'submit', mutation: mutation('b', 'expense:2', 'b') },
      { type: 'submit', mutation: mutation('c', 'bill:3', 'c') },
    ]);
    const state = clarityReducer(base, { type: 'fail', mutationId: 'b' });

    expect(visibleTag(state)).toBe('v3+a+c');
    expect(isScopePending(state, 'expense:2')).toBe(false);
    expect(state.confirmed).toBe(base.confirmed);
  });

  it('allows the same scope to be submitted again after it fails', () => {
    const state = run([
      { type: 'submit', mutation: mutation('a', 'goal:1', 'a') },
      { type: 'fail', mutationId: 'a' },
      { type: 'submit', mutation: mutation('a2', 'goal:1', 'a2') },
    ]);

    expect(state.pending.map((item) => item.mutationId)).toEqual(['a2']);
  });

  it('installs a newer snapshot on success and removes only that mutation patch', () => {
    const state = run([
      { type: 'install', snapshot: makeSnapshot(3) },
      { type: 'submit', mutation: mutation('a', 'goal:1', 'a') },
      { type: 'submit', mutation: mutation('b', 'expense:2', 'b') },
      { type: 'succeed', mutationId: 'a', snapshot: makeSnapshot(4, MONTH, 'v4') },
    ]);

    expect(visibleTag(state)).toBe('v4+b');
  });

  it('ignores an older snapshot returned out of order but still removes the completed patch', () => {
    const state = run([
      { type: 'install', snapshot: makeSnapshot(5) },
      { type: 'submit', mutation: mutation('a', 'goal:1', 'a') },
      { type: 'succeed', mutationId: 'a', snapshot: makeSnapshot(4) },
    ]);

    expect(visibleTag(state)).toBe('v5');
    expect(state.pending).toHaveLength(0);
  });

  it('keeps the highest version regardless of install order', () => {
    const state = run([
      { type: 'install', snapshot: makeSnapshot(7) },
      { type: 'install', snapshot: makeSnapshot(6) },
    ]);

    expect(state.confirmed[MONTH]?.dataVersion).toBe(7);
  });

  it('keeps separate confirmed snapshots per month and applies patches only to listed months', () => {
    const state = run([
      { type: 'install', snapshot: makeSnapshot(3, '2026-01') },
      { type: 'install', snapshot: makeSnapshot(3, '2026-02') },
      { type: 'submit', mutation: mutation('a', 'expense:9', 'move', ['2026-02']) },
    ]);

    expect(visibleTag(state, '2026-01')).toBe('v3');
    expect(visibleTag(state, '2026-02')).toBe('v3+move');
  });

  it('does not let a throwing patch hide confirmed values', () => {
    const state = run([
      { type: 'install', snapshot: makeSnapshot(3) },
      {
        type: 'submit',
        mutation: { mutationId: 'x', scopeKey: 'goal:1', submittedAt: 1, patch: () => { throw new Error('bad'); } },
      },
      { type: 'submit', mutation: mutation('b', 'goal:2', 'b') },
    ]);

    expect(visibleTag(state)).toBe('v3+b');
  });

  it('never mutates the confirmed snapshot or earlier states', () => {
    const snapshot = makeSnapshot(3);
    const before = run([{ type: 'install', snapshot }]);
    const after = clarityReducer(before, { type: 'submit', mutation: mutation('a', 'goal:1', 'a') });

    expect(selectVisibleSnapshot(after, MONTH)).not.toBe(snapshot);
    expect(snapshot.generatedAt).toBe('v3');
    expect(before.pending).toHaveLength(0);
  });

  it('clears everything on reset', () => {
    const state = run([
      { type: 'install', snapshot: makeSnapshot(3) },
      { type: 'submit', mutation: mutation('a', 'goal:1', 'a') },
      { type: 'reset' },
    ]);

    expect(state).toBe(initialClarityState);
  });
});

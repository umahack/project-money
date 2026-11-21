import { describe, expect, it, vi } from 'vitest';
import {
  deferred,
  makeEnvelope,
  makeSnapshot,
  tagPatch,
  type Deferred,
} from '../test/clarity-fixtures';
import type { MutationEnvelope } from './contracts';
import { createClarityStore } from './clarityStore';
import {
  createMutationStatusStore,
  stableStringify,
  type MutationRequest,
} from './mutationStatusStore';
import { selectVisibleSnapshot } from './patchReducer';

const MONTH = '2026-01';

function setup() {
  const clarityStore = createClarityStore();
  clarityStore.dispatch({ type: 'install', snapshot: makeSnapshot(3) });
  const calls: Array<{ request: MutationRequest; response: Deferred<MutationEnvelope> }> = [];
  const onConfirmed = vi.fn();
  let keyCounter = 0;
  const store = createMutationStatusStore({
    clarityStore,
    send: (request) => {
      const response = deferred<MutationEnvelope>();
      calls.push({ request, response });
      return response.promise;
    },
    onConfirmed,
    createIdempotencyKey: () => `key-${++keyCounter}`,
    now: () => 1000,
  });
  const visibleTag = () => selectVisibleSnapshot(clarityStore.getState(), MONTH)?.generatedAt;
  return { clarityStore, store, calls, onConfirmed, visibleTag };
}

const goalCommand = (amount = 100) => ({
  scopeKey: 'goal:17',
  label: 'Saving goal',
  path: '/finance/goals/17',
  method: 'PATCH' as const,
  body: { targetAmount: amount },
  patch: tagPatch('goal'),
});

describe('mutation status store', () => {
  it('registers pending state and the optimistic patch before awaiting I/O', () => {
    const { store, calls, visibleTag } = setup();

    const pending = store.submit(goalCommand());

    // No await has happened yet: everything below is observable in the same tick.
    expect(store.getStatus('goal:17')).toMatchObject({ phase: 'pending', label: 'Saving goal' });
    expect(visibleTag()).toBe('v3+goal');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.request).toMatchObject({ method: 'PATCH', path: '/finance/goals/17', idempotencyKey: 'key-1' });
    void pending;
  });

  it('blocks a duplicate submission for the same scope and sends nothing', async () => {
    const { store, calls } = setup();
    void store.submit(goalCommand());

    const duplicate = await store.submit(goalCommand(200));

    expect(duplicate).toEqual({ outcome: 'duplicate' });
    expect(calls).toHaveLength(1);
  });

  it('runs independent scopes concurrently with separate statuses', async () => {
    const { store, calls, visibleTag } = setup();
    void store.submit(goalCommand());
    void store.submit({ scopeKey: 'expense:9', label: 'Saving expense', path: '/finance/expenses/9', method: 'PATCH', patch: tagPatch('exp') });

    expect(calls).toHaveLength(2);
    expect(store.getStatus('goal:17')?.phase).toBe('pending');
    expect(store.getStatus('expense:9')?.phase).toBe('pending');
    expect(visibleTag()).toBe('v3+goal+exp');

    calls[1]?.response.reject(Object.assign(new Error('nope'), { status: 422, code: 'INVALID' }));
    await vi.waitFor(() => expect(store.getStatus('expense:9')?.phase).toBe('error'));

    // The failed scope rolls back alone; the other scope is still pending.
    expect(store.getStatus('goal:17')?.phase).toBe('pending');
    expect(visibleTag()).toBe('v3+goal');
  });

  it('installs the confirmed snapshot, removes its patch, and reports completion', async () => {
    const { store, calls, clarityStore, onConfirmed, visibleTag } = setup();
    const result = store.submit(goalCommand());
    const confirmed = makeSnapshot(4, MONTH, 'v4');

    calls[0]?.response.resolve(makeEnvelope(confirmed, 'goal:17'));
    await expect(result).resolves.toMatchObject({ outcome: 'confirmed' });

    expect(visibleTag()).toBe('v4');
    expect(clarityStore.getState().pending).toHaveLength(0);
    expect(onConfirmed).toHaveBeenCalledWith(confirmed);
    expect(store.getStatus('goal:17')).toMatchObject({ phase: 'success', replayed: false });
  });

  it('keeps another scope pending patch when an independent mutation succeeds first', async () => {
    const { store, calls, visibleTag } = setup();
    void store.submit(goalCommand());
    const second = store.submit({ scopeKey: 'bill:2', label: 'Saving bill', path: '/finance/emis/2', patch: tagPatch('bill') });

    calls[1]?.response.resolve(makeEnvelope(makeSnapshot(4, MONTH, 'v4'), 'bill:2'));
    await second;

    expect(visibleTag()).toBe('v4+goal');
  });

  it('does not install an older snapshot that arrives after a newer one', async () => {
    const { store, calls, visibleTag } = setup();
    const first = store.submit(goalCommand());
    const second = store.submit({ scopeKey: 'bill:2', label: 'Saving bill', path: '/finance/emis/2' });

    calls[1]?.response.resolve(makeEnvelope(makeSnapshot(6, MONTH, 'v6'), 'bill:2'));
    await second;
    calls[0]?.response.resolve(makeEnvelope(makeSnapshot(5, MONTH, 'v5'), 'goal:17'));
    await first;

    expect(visibleTag()).toBe('v6');
    expect(store.getStatus('goal:17')?.phase).toBe('success');
  });

  it('rolls back to confirmed values on failure and exposes a retry with the same key and body', async () => {
    const { store, calls, visibleTag } = setup();
    const failed = store.submit(goalCommand());
    calls[0]?.response.reject(Object.assign(new Error('Server busy'), { status: 503 }));

    await expect(failed).resolves.toEqual({
      outcome: 'failed',
      error: { message: 'Server busy', status: 503, code: undefined, field: undefined },
    });
    expect(visibleTag()).toBe('v3');
    expect(store.getStatus('goal:17')).toMatchObject({ phase: 'error', error: { message: 'Server busy' } });

    const retried = store.retry('goal:17');
    expect(store.getStatus('goal:17')?.phase).toBe('pending');
    expect(visibleTag()).toBe('v3+goal');
    expect(calls[1]?.request.idempotencyKey).toBe(calls[0]?.request.idempotencyKey);
    expect(calls[1]?.request.body).toEqual(calls[0]?.request.body);

    calls[1]?.response.resolve(makeEnvelope(makeSnapshot(4, MONTH, 'v4'), 'goal:17'));
    await expect(retried).resolves.toMatchObject({ outcome: 'confirmed' });
  });

  it('keeps the retry body when the caller edits its draft object after submitting', async () => {
    const { store, calls } = setup();
    const draft = { targetAmount: 100 };
    const failed = store.submit({ ...goalCommand(), body: draft });
    draft.targetAmount = 999;
    calls[0]?.response.reject(new Error('offline'));
    await failed;

    void store.retry('goal:17');

    expect(calls[1]?.request.body).toEqual({ targetAmount: 100 });
    expect(calls[1]?.request.idempotencyKey).toBe('key-1');
  });

  it('creates a new idempotency key only after the draft is edited', async () => {
    const { store, calls } = setup();
    const failed = store.submit(goalCommand(100));
    calls[0]?.response.reject(new Error('offline'));
    await failed;

    // Same draft, resubmitted by the form: same key.
    const sameDraft = store.submit(goalCommand(100));
    expect(calls[1]?.request.idempotencyKey).toBe('key-1');
    calls[1]?.response.reject(new Error('offline'));
    await sameDraft;

    // Edited draft: new key.
    void store.submit(goalCommand(250));
    expect(calls[2]?.request.idempotencyKey).toBe('key-2');
    expect(calls[2]?.request.body).toEqual({ targetAmount: 250 });
  });

  it('creates a fresh key for an identical command submitted after a success', async () => {
    const { store, calls } = setup();
    const first = store.submit(goalCommand(100));
    calls[0]?.response.resolve(makeEnvelope(makeSnapshot(4), 'goal:17'));
    await first;

    void store.submit(goalCommand(100));

    expect(calls[1]?.request.idempotencyKey).toBe('key-2');
  });

  it('refuses to retry a scope that has no failed command', async () => {
    const { store } = setup();
    await expect(store.retry('goal:404')).resolves.toEqual({ outcome: 'not_retryable' });
  });

  it('treats a response without a snapshot as a failure that can be retried safely', async () => {
    const { store, calls } = setup();
    const result = store.submit(goalCommand());
    calls[0]?.response.resolve({ schemaVersion: 1 } as unknown as MutationEnvelope);

    await expect(result).resolves.toMatchObject({ outcome: 'failed' });
    void store.retry('goal:17');
    expect(calls[1]?.request.idempotencyKey).toBe(calls[0]?.request.idempotencyKey);
  });

  it('dismisses finished statuses but keeps pending ones', async () => {
    const { store, calls } = setup();
    const failed = store.submit(goalCommand());
    store.dismiss('goal:17');
    expect(store.getStatus('goal:17')?.phase).toBe('pending');

    calls[0]?.response.reject(new Error('offline'));
    await failed;
    store.dismiss('goal:17');
    expect(store.getStatus('goal:17')).toBeUndefined();
  });

  it('ignores a response that arrives after the session state was cleared', async () => {
    const { store, calls, clarityStore, onConfirmed } = setup();
    const result = store.submit(goalCommand());

    clarityStore.reset();
    store.reset();
    calls[0]?.response.resolve(makeEnvelope(makeSnapshot(9, MONTH, 'v9'), 'goal:17'));

    await expect(result).resolves.toEqual({ outcome: 'discarded' });
    expect(clarityStore.getState().confirmed).toEqual({});
    expect(store.getState().statuses).toEqual({});
    expect(onConfirmed).not.toHaveBeenCalled();
  });
});

describe('stableStringify', () => {
  it('ignores key order and undefined members', () => {
    expect(stableStringify({ b: 1, a: [{ d: 1, c: undefined }] })).toBe(stableStringify({ a: [{ d: 1 }], b: 1 }));
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }));
  });
});

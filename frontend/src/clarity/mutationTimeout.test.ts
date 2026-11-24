import { describe, expect, it, vi } from 'vitest';
import { REQUEST_TIMEOUT_CODE, clarityApi, setAuth } from '../api';
import { createApiResponse } from '../test/test-utils';
import { makeEnvelope, makeSnapshot } from '../test/clarity-fixtures';
import { createClarityStore } from './clarityStore';
import type { MutationEnvelope } from './contracts';
import {
  createMutationStatusStore,
  type MutationCommand,
  type MutationRequest,
} from './mutationStatusStore';

const USER = Object.freeze({ id: 9, email: 'runner@example.test', name: 'Runner', is_admin: false });

const command = (extra: Partial<MutationCommand> = {}): MutationCommand => ({
  scopeKey: 'new-expense:c1',
  label: 'Saving expense',
  path: '/finance/expenses',
  body: { amountMinor: 12_500, category: 'Food', note: 'tea', spentOn: '2026-01-15' },
  ...extra,
});

function setup(send: (request: MutationRequest) => Promise<MutationEnvelope>) {
  const clarityStore = createClarityStore();
  clarityStore.dispatch({ type: 'install', snapshot: makeSnapshot(3) });
  let keyCounter = 0;
  const store = createMutationStatusStore({
    clarityStore,
    send,
    createIdempotencyKey: () => `key-${++keyCounter}`,
    now: () => 1000,
  });
  return { store, clarityStore };
}

/** The same transport the provider uses: the runner request goes through clarityApi.mutate. */
const sendThroughApi = (request: MutationRequest) => clarityApi.mutate<MutationEnvelope>(request.path, {
  method: request.method,
  body: request.body,
  idempotencyKey: request.idempotencyKey,
  timeoutMs: request.timeoutMs,
});

describe('mutation runner timeout', () => {
  it('passes timeoutMs to the request only when the command sets it', async () => {
    const send = vi.fn<(request: MutationRequest) => Promise<MutationEnvelope>>(
      () => Promise.resolve(makeEnvelope(makeSnapshot(4), 'x')),
    );
    const { store } = setup(send);

    await store.submit(command({ scopeKey: 'a', timeoutMs: 60_000 }));
    await store.submit(command({ scopeKey: 'b' }));

    expect(send.mock.calls[0]?.[0]).toMatchObject({ timeoutMs: 60_000 });
    expect(send.mock.calls[1]?.[0]).not.toHaveProperty('timeoutMs');
  });

  it('fails a timed-out command at 60 seconds and retries with the same key, body, and timeout', async () => {
    vi.useFakeTimers();
    setAuth('runner-token', USER);
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockImplementationOnce((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const confirmed = makeSnapshot(4, '2026-01', 'v4');
    fetchMock.mockResolvedValueOnce(createApiResponse({ body: makeEnvelope(confirmed, 'new-expense:c1', 'key-1') }));
    const { store } = setup(sendThroughApi);

    const first = store.submit(command({ timeoutMs: 60_000 }));
    expect(store.getStatus('new-expense:c1')?.phase).toBe('pending');

    await vi.advanceTimersByTimeAsync(59_999);
    expect(store.getStatus('new-expense:c1')?.phase).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);

    const result = await first;
    expect(result).toMatchObject({ outcome: 'failed', error: { code: REQUEST_TIMEOUT_CODE, status: 0 } });
    expect(store.getStatus('new-expense:c1')).toMatchObject({
      phase: 'error',
      error: { code: REQUEST_TIMEOUT_CODE },
    });
    expect(vi.getTimerCount()).toBe(0);

    await expect(store.retry('new-expense:c1')).resolves.toMatchObject({ outcome: 'confirmed' });
    expect(store.getStatus('new-expense:c1')?.phase).toBe('success');
    expect(vi.getTimerCount()).toBe(0);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [firstCall, retryCall] = fetchMock.mock.calls;
    const headersOf = (call: typeof firstCall) => call?.[1]?.headers as Record<string, string>;
    expect(headersOf(firstCall)['Idempotency-Key']).toBe('key-1');
    expect(headersOf(retryCall)['Idempotency-Key']).toBe('key-1');
    expect(retryCall?.[1]?.body).toBe(firstCall?.[1]?.body);
    // The retry is armed with the same timeout.
    expect(retryCall?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('does not time out a command without timeoutMs', async () => {
    vi.useFakeTimers();
    setAuth('runner-token', USER);
    vi.mocked(globalThis.fetch).mockImplementationOnce(() => new Promise<Response>(() => undefined));
    const { store } = setup(sendThroughApi);

    void store.submit(command());
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(store.getStatus('new-expense:c1')?.phase).toBe('pending');
    expect(vi.getTimerCount()).toBe(0);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { REQUEST_TIMEOUT_CODE, api, clarityApi, getToken, setAuth } from './api';
import { deferred } from './test/clarity-fixtures';
import { createApiResponse } from './test/test-utils';

const USER = Object.freeze({ id: 7, email: 'timeout@example.test', name: 'Timeout User', is_admin: false });
const KEY = '0f1d3c2e-8f1c-4a73-9d0a-3a52d3a3c001';
const OK = { schemaVersion: 1 as const, clarity: { dataVersion: 2 } };

/** A fetch that never answers on its own and rejects like a browser when its signal aborts. */
function hangingFetch() {
  const signals: Array<AbortSignal | undefined> = [];
  vi.mocked(globalThis.fetch).mockImplementation((_url, init) => {
    signals.push(init?.signal ?? undefined);
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      });
    });
  });
  return signals;
}

/** Spies on the fake clock to follow the request's own timer, ignoring timers the Response body reader may use. */
function watchRequestTimer(timeoutMs: number) {
  const set = vi.spyOn(globalThis, 'setTimeout');
  const clear = vi.spyOn(globalThis, 'clearTimeout');
  return {
    armed: () => set.mock.calls.filter((call) => call[1] === timeoutMs).length,
    cleared: () => set.mock.calls.every((call, index) => (
      call[1] !== timeoutMs || clear.mock.calls.some((c) => c[0] === set.mock.results[index]?.value)
    )),
  };
}

describe('request timeout', () => {
  it('fails with REQUEST_TIMEOUT exactly at the limit and aborts the fetch', async () => {
    vi.useFakeTimers();
    setAuth('timeout-token', USER);
    const signals = hangingFetch();

    const result = clarityApi.mutate('/finance/expenses', {
      body: { amountMinor: 100 },
      idempotencyKey: KEY,
      timeoutMs: 60_000,
    }).then(() => 'resolved', (error: unknown) => error);

    await vi.advanceTimersByTimeAsync(59_999);
    expect(signals[0]?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(signals[0]?.aborted).toBe(true);
    expect(await result).toMatchObject({
      name: 'ApiError',
      status: 0,
      code: REQUEST_TIMEOUT_CODE,
      message: expect.stringContaining('Retry'),
    });
    expect(vi.getTimerCount()).toBe(0);
    // A timeout is not an auth failure.
    expect(getToken()).toBe('timeout-token');
  });

  it('clears the timer when the response arrives before the limit', async () => {
    vi.useFakeTimers();
    setAuth('timeout-token', USER);
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockResolvedValueOnce(createApiResponse({ body: OK }));
    const timer = watchRequestTimer(60_000);

    const result = clarityApi.mutate<typeof OK>('/finance/expenses', {
      body: {},
      idempotencyKey: KEY,
      timeoutMs: 60_000,
    });
    await expect(result).resolves.toEqual(OK);

    expect(timer.armed()).toBe(1);
    expect(timer.cleared()).toBe(true);
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(init?.signal?.aborted).toBe(false);
  });

  it('clears the timer when the server answers with an error before the limit', async () => {
    vi.useFakeTimers();
    setAuth('timeout-token', USER);
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(createApiResponse({
      status: 422,
      body: { error: { code: 'INVALID', message: 'Nope.' } },
    }));
    const timer = watchRequestTimer(60_000);

    await expect(clarityApi.mutate('/finance/expenses', {
      body: {},
      idempotencyKey: KEY,
      timeoutMs: 60_000,
    })).rejects.toMatchObject({ status: 422, code: 'INVALID' });

    expect(timer.armed()).toBe(1);
    expect(timer.cleared()).toBe(true);
  });

  it('ignores a late response that arrives after the abort', async () => {
    vi.useFakeTimers();
    setAuth('timeout-token', USER);
    const late = deferred<Response>();
    // This fetch ignores the abort signal, like a transport that answers anyway.
    vi.mocked(globalThis.fetch).mockImplementation(() => late.promise);
    const expired = vi.fn();
    window.addEventListener('auth:expired', expired);

    try {
      const timed = clarityApi.mutate('/finance/expenses', {
        body: {},
        idempotencyKey: KEY,
        timeoutMs: 1_000,
      }).then(() => 'resolved', (error: unknown) => error);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(await timed).toMatchObject({ code: REQUEST_TIMEOUT_CODE });

      // A 401 that shows up late must not sign the user out.
      late.resolve(createApiResponse({ status: 401, body: { error: 'Expired' } }));
      await vi.advanceTimersByTimeAsync(0);
      expect(expired).not.toHaveBeenCalled();
      expect(getToken()).toBe('timeout-token');
    } finally {
      window.removeEventListener('auth:expired', expired);
    }
  });

  it('leaves callers without timeoutMs unchanged: no signal, no timer', async () => {
    vi.useFakeTimers();
    setAuth('timeout-token', USER);
    const pending = deferred<void>();
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockImplementation(() => pending.promise.then(() => createApiResponse({ body: OK })));

    const timersBefore = vi.getTimerCount();
    const viaApi = api.post('/finance/expenses', { amount: 1 }, true, { idempotencyKey: KEY });
    const viaClarity = clarityApi.mutate('/finance/expenses', { body: {}, idempotencyKey: KEY });
    const viaGet = api.get('/finance/plan');

    expect(vi.getTimerCount()).toBe(timersBefore);
    for (const call of fetchMock.mock.calls) {
      expect(call[1]).not.toHaveProperty('signal');
    }

    // Far beyond any timeout, the request is still waiting rather than failed.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    pending.resolve();
    await expect(viaApi).resolves.toEqual(OK);
    await expect(viaClarity).resolves.toEqual(OK);
    await expect(viaGet).resolves.toEqual(OK);
  });

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])('treats timeoutMs %s as no timeout', async (timeoutMs) => {
    vi.useFakeTimers();
    setAuth('timeout-token', USER);
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockResolvedValueOnce(createApiResponse({ body: OK }));

    const timersBefore = vi.getTimerCount();
    const result = clarityApi.mutate('/finance/expenses', { body: {}, idempotencyKey: KEY, timeoutMs });

    expect(vi.getTimerCount()).toBe(timersBefore);
    await expect(result).resolves.toEqual(OK);
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty('signal');
  });
});

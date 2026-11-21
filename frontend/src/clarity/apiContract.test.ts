import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, clarityApi, setAuth } from '../api';
import { createApiResponse } from '../test/test-utils';

const USER = Object.freeze({
  id: 42,
  email: 'rollout@example.test',
  name: 'Rollout User',
  is_admin: false,
});

function successfulFetch(body: unknown) {
  const fetchMock = vi.mocked(globalThis.fetch);
  fetchMock.mockResolvedValueOnce(createApiResponse({ body }));
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('API clarity contract negotiation', () => {
  it('omits the contract header on the default legacy read path', async () => {
    vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'false');
    setAuth('rollout-token', USER);
    const fetchMock = successfulFetch({ income: 1000, breakdown: {} });

    await api.get('/finance/plan');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/finance/plan',
      expect.objectContaining({
        headers: expect.not.objectContaining({ 'X-Clarity-Contract': '1' }),
      }),
    );
  });

  it('requests contract version 1 for authenticated financial reads and mutations when enabled', async () => {
    vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'true');
    setAuth('rollout-token', USER);
    const fetchMock = successfulFetch({
      id: 98,
      month: '2026-01',
      mutation: { status: 'confirmed' },
      clarity: { dataVersion: 7 },
    });

    const response = await api.post<{
      id: number;
      month: string;
      mutation: { status: string };
      clarity: { dataVersion: number };
    }>('/finance/expenses', { amount: 10, category: 'Food' });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/finance/expenses',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer rollout-token',
          'Content-Type': 'application/json',
          'X-Clarity-Contract': '1',
        }),
      }),
    );
    expect(response).toEqual({
      id: 98,
      month: '2026-01',
      mutation: { status: 'confirmed' },
      clarity: { dataVersion: 7 },
    });
  });

  it('never negotiates the private clarity contract on a public route', async () => {
    vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'true');
    const fetchMock = successfulFetch({ trip: { name: 'Public fixture' } });

    await api.get('/public/trips/abcdef0123456789abcdef0123456789');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/public/trips/abcdef0123456789abcdef0123456789',
      expect.objectContaining({
        headers: expect.not.objectContaining({ 'X-Clarity-Contract': '1' }),
      }),
    );
  });

  it('sends contract and idempotency metadata for a versioned mutation', async () => {
    setAuth('mutation-token', USER);
    const fetchMock = successfulFetch({
      schemaVersion: 1,
      mutation: { changeId: 551 },
      clarity: { dataVersion: 43 },
    });

    const response = await clarityApi.mutate<{
      schemaVersion: 1;
      mutation: { changeId: number };
      clarity: { dataVersion: number };
    }>('/finance/expenses', {
      body: { amountMinor: 1299, category: 'Food' },
      idempotencyKey: '7cb459ef-631b-41e0-9b1f-49ca94da38a2',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/finance/expenses',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer mutation-token',
          'Content-Type': 'application/json',
          'Idempotency-Key': '7cb459ef-631b-41e0-9b1f-49ca94da38a2',
          'X-Clarity-Contract': '1',
        }),
      }),
    );
    expect(response.schemaVersion).toBe(1);
    expect(response.clarity.dataVersion).toBe(43);
  });

  it('exposes structured error metadata without changing the user-facing message', async () => {
    setAuth('mutation-token', USER);
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(createApiResponse({
      status: 422,
      body: {
        error: {
          code: 'INVALID_GOAL_CONTRIBUTION',
          message: 'Contribution is outside the accepted range.',
          field: 'contributionMinor',
          constraint: { minMinor: 1, maxMinor: 1250000 },
          outcomeIds: ['goal:17'],
        },
      },
    }));

    const request = clarityApi.mutate<{ schemaVersion: 1 }>('/finance/goals/17/contributions', {
      body: { contributionMinor: 1250001 },
      idempotencyKey: 'aeb5df51-0bb7-45b0-962f-6240222f716f',
    });

    await expect(request).rejects.toEqual(expect.objectContaining({
      name: 'ApiError',
      status: 422,
      code: 'INVALID_GOAL_CONTRIBUTION',
      message: 'Contribution is outside the accepted range.',
      field: 'contributionMinor',
      constraint: { minMinor: 1, maxMinor: 1250000 },
      outcomeIds: ['goal:17'],
    }));
  });

  it('rejects unsupported or missing clarity response versions', async () => {
    setAuth('version-token', USER);
    successfulFetch({ schemaVersion: 2, snapshot: { dataVersion: 8 } });

    const request = clarityApi.get<{ schemaVersion: 1 }>('/finance/clarity?month=2026-01');

    await expect(request).rejects.toEqual(expect.objectContaining({
      status: 0,
      code: 'UNSUPPORTED_CLARITY_SCHEMA_VERSION',
    }));
  });
});

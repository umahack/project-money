import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, type MockedFunction } from 'vitest';
import { clearAuth } from '../api';
import {
  createApiResponse,
  renderAuthenticated,
} from '../test/test-utils';
import { deferred, makeEnvelope, makeSnapshot, tagPatch } from '../test/clarity-fixtures';
import { FinancialClarityProvider, useClarityStore, useFinancialClarity } from './FinancialClarityProvider';
import { MutationStatusProvider, useMutationRunner, useMutationStatus } from './MutationStatusProvider';
import { queryKeys } from './queryClient';

const MONTH = '2026-01';

function ScopeControl({ scopeKey, amount }: { scopeKey: string; amount: number }) {
  const runner = useMutationRunner();
  const status = useMutationStatus(scopeKey);
  return (
    <div>
      <button
        type="button"
        onClick={() => void runner.submit({
          scopeKey,
          label: `Saving ${scopeKey}`,
          path: `/finance/${scopeKey.replace(':', '/')}`,
          method: 'PATCH',
          body: { amount },
          patch: tagPatch(scopeKey),
        })}
      >
        Save {scopeKey}
      </button>
      <span data-testid={`status-${scopeKey}`}>{status?.phase ?? 'idle'}</span>
      {status?.phase === 'error' && (
        <button type="button" onClick={() => void runner.retry(scopeKey)}>Retry {scopeKey}</button>
      )}
    </div>
  );
}

function Harness() {
  const { snapshot } = useFinancialClarity(MONTH);
  const store = useClarityStore();
  return (
    <div>
      <output data-testid="visible">{snapshot?.generatedAt ?? 'none'}</output>
      <button type="button" onClick={() => store.dispatch({ type: 'install', snapshot: makeSnapshot(3) })}>
        Load
      </button>
      <ScopeControl scopeKey="goal:17" amount={500} />
      <ScopeControl scopeKey="expense:9" amount={40} />
    </div>
  );
}

function renderHarness() {
  return renderAuthenticated(
    <FinancialClarityProvider>
      <MutationStatusProvider>
        <Harness />
      </MutationStatusProvider>
    </FinancialClarityProvider>,
  );
}

function sentRequests(fetchMock: MockedFunction<typeof fetch>) {
  return fetchMock.mock.calls.map(([url, init]) => ({
    url: String(url),
    headers: new Headers(init?.headers),
    body: init?.body,
  }));
}

describe('FinancialClarityProvider and MutationStatusProvider', () => {
  it('shows pending state and the optimistic value immediately, then the confirmed snapshot', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(globalThis.fetch);
    const response = deferred<Response>();
    fetchMock.mockReturnValueOnce(response.promise);
    renderHarness();
    await user.click(screen.getByText('Load'));

    await user.click(screen.getByText('Save goal:17'));

    expect(screen.getByTestId('status-goal:17')).toHaveTextContent('pending');
    expect(screen.getByTestId('visible')).toHaveTextContent('v3+goal:17');
    // Unrelated scope stays idle and interactive.
    expect(screen.getByTestId('status-expense:9')).toHaveTextContent('idle');
    expect(screen.getByText('Save expense:9')).toBeEnabled();

    const [request] = sentRequests(fetchMock);
    expect(request?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(request?.headers.get('X-Clarity-Contract')).toBe('1');

    await act(async () => {
      response.resolve(createApiResponse({ body: makeEnvelope(makeSnapshot(4, MONTH, 'v4'), 'goal:17') }));
    });

    await waitFor(() => expect(screen.getByTestId('status-goal:17')).toHaveTextContent('success'));
    expect(screen.getByTestId('visible')).toHaveTextContent('v4');
  });

  it('blocks a second click for a pending scope but lets another scope submit', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockReturnValue(new Promise<Response>(() => {}));
    renderHarness();
    await user.click(screen.getByText('Load'));

    await user.click(screen.getByText('Save goal:17'));
    await user.click(screen.getByText('Save goal:17'));
    await user.click(screen.getByText('Save expense:9'));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('visible')).toHaveTextContent('v3+goal:17+expense:9');
  });

  it('rolls back only the failed scope and retries with the same idempotency key', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(globalThis.fetch);
    const goalResponse = deferred<Response>();
    fetchMock
      .mockReturnValueOnce(goalResponse.promise)
      .mockReturnValueOnce(new Promise<Response>(() => {}));
    renderHarness();
    await user.click(screen.getByText('Load'));
    await user.click(screen.getByText('Save goal:17'));
    await user.click(screen.getByText('Save expense:9'));

    await act(async () => {
      goalResponse.resolve(createApiResponse({
        status: 422,
        body: { error: { code: 'INVALID', message: 'Amount is too high', field: 'amount' } },
      }));
    });

    await waitFor(() => expect(screen.getByTestId('status-goal:17')).toHaveTextContent('error'));
    expect(screen.getByTestId('visible')).toHaveTextContent('v3+expense:9');
    expect(screen.getByTestId('status-expense:9')).toHaveTextContent('pending');

    fetchMock.mockReturnValueOnce(new Promise<Response>(() => {}));
    await user.click(screen.getByText('Retry goal:17'));

    const requests = sentRequests(fetchMock);
    expect(requests).toHaveLength(3);
    expect(requests[2]?.headers.get('Idempotency-Key')).toBe(requests[0]?.headers.get('Idempotency-Key'));
    expect(requests[2]?.body).toBe(requests[0]?.body);
    expect(screen.getByTestId('visible')).toHaveTextContent('v3+expense:9+goal:17');
  });

  it('feeds snapshots written to the query cache into the confirmed state, newest version wins', async () => {
    const { queryClient } = renderHarness();

    act(() => {
      queryClient.setQueryData(queryKeys.clarity(MONTH), makeSnapshot(5, MONTH, 'v5'));
    });
    await waitFor(() => expect(screen.getByTestId('visible')).toHaveTextContent('v5'));

    act(() => {
      queryClient.setQueryData(queryKeys.clarity(MONTH), makeSnapshot(4, MONTH, 'v4'));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(screen.getByTestId('visible')).toHaveTextContent('v5');
  });

  it('mirrors a confirmed mutation snapshot into the query cache', async () => {
    const user = userEvent.setup();
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      createApiResponse({ body: makeEnvelope(makeSnapshot(8, MONTH, 'v8'), 'goal:17') }),
    );
    const { queryClient } = renderHarness();

    await user.click(screen.getByText('Save goal:17'));

    await waitFor(() => expect(screen.getByTestId('status-goal:17')).toHaveTextContent('success'));
    expect(queryClient.getQueryData(queryKeys.clarity(MONTH))).toMatchObject({ dataVersion: 8 });
    expect(screen.getByTestId('visible')).toHaveTextContent('v8');
  });

  it('drops confirmed values, pending patches, and statuses when auth is cleared', async () => {
    const user = userEvent.setup();
    vi.mocked(globalThis.fetch).mockReturnValue(new Promise<Response>(() => {}));
    renderHarness();
    await user.click(screen.getByText('Load'));
    await user.click(screen.getByText('Save goal:17'));
    expect(screen.getByTestId('status-goal:17')).toHaveTextContent('pending');

    act(() => clearAuth());

    expect(screen.getByTestId('visible')).toHaveTextContent('none');
    expect(screen.getByTestId('status-goal:17')).toHaveTextContent('idle');
    expect(sessionStorage.getItem('pm_token')).toBeNull();
    expect(localStorage.length).toBe(0);
  });
});

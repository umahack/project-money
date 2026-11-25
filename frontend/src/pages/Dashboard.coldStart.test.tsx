import { act, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FinancialClarityProvider } from '../clarity/FinancialClarityProvider';
import { MutationStatusProvider } from '../clarity/MutationStatusProvider';
import { COLD_START_HINT_DELAY_MS } from '../native/networkStatus';
import { createTestQueryClient, renderAuthenticated } from '../test/test-utils';
import { Dashboard } from './Dashboard';

const platform = vi.hoisted(() => ({ native: true }));
vi.mock('../platform', () => ({ isNativePlatform: () => platform.native }));

const HINT = /the free API host is waking up/i;

function renderPendingHome() {
  // The snapshot request never answers, as on a sleeping free Render instance.
  vi.mocked(globalThis.fetch).mockImplementation(() => new Promise<Response>(() => undefined));
  return renderAuthenticated(
    <FinancialClarityProvider>
      <MutationStatusProvider>
        <Dashboard />
      </MutationStatusProvider>
    </FinancialClarityProvider>,
    { queryClient: createTestQueryClient() },
  );
}

describe('Dashboard cold-start hint', () => {
  beforeEach(() => {
    platform.native = true;
    vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'true');
    vi.useFakeTimers();
  });

  it('appears only after the first request has been pending for 5 seconds, with a Retry button on native (Requirement 7.6)', async () => {
    renderPendingHome();
    await act(async () => { await vi.advanceTimersByTimeAsync(COLD_START_HINT_DELAY_MS - 1); });
    expect(screen.queryByText(HINT)).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByText(HINT)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('shows no Retry button on the web', async () => {
    platform.native = false;
    renderPendingHome();
    await act(async () => { await vi.advanceTimersByTimeAsync(COLD_START_HINT_DELAY_MS); });
    expect(screen.getByText(HINT)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});

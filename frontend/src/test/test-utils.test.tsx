import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import { screen } from '@testing-library/react';
import { useLocation, useParams } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { api } from '../api';
import { useAuth } from '../state';
import {
  axe,
  createTestQueryClient,
  createTestUser,
  fc,
  installFakeClock,
  propertyTestParameters,
  renderAtRoute,
  renderWithApiResponse,
} from './test-utils';

function ProviderProbe() {
  const { user } = useAuth();
  const location = useLocation();
  const [selected, setSelected] = useState(false);
  const response = useQuery({
    queryKey: ['test', 'api-response'],
    queryFn: () => api.get<{ message: string }>('/test-response'),
  });

  return (
    <main>
      <h1>Harness probe</h1>
      <p>{user?.email}</p>
      <p>{location.pathname + location.search}</p>
      <p role="status">{response.data?.message ?? 'Loading response'}</p>
      <button type="button" aria-pressed={selected} onClick={() => setSelected(true)}>
        Select outcome
      </button>
    </main>
  );
}

describe('frontend test harness', () => {
  it('renders authenticated routed content with API, interaction, query, and axe support', async () => {
    const user = createTestUser({ email: 'authenticated@example.test' });
    const result = renderWithApiResponse(
      <ProviderProbe />,
      { body: { message: 'Response ready' } },
      { route: '/plan?month=2026-01', user },
    );

    expect(screen.getByText('authenticated@example.test')).toBeInTheDocument();
    expect(screen.getByText('/plan?month=2026-01')).toBeInTheDocument();
    expect(await screen.findByText('Response ready')).toBeInTheDocument();
    expect(result.fetchMock).toHaveBeenCalledWith(
      '/api/test-response',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test.jwt.token' }),
      }),
    );

    const interaction = userEvent.setup();
    const button = screen.getByRole('button', { name: 'Select outcome' });
    await interaction.click(button);
    expect(button).toHaveAttribute('aria-pressed', 'true');

    expect(await axe(result.container)).toHaveNoViolations();
    result.queryClient.clear();
  });

  it('matches dynamic routes and exposes route parameters', () => {
    function RouteProbe() {
      const { goalId } = useParams();
      return <p>Goal {goalId}</p>;
    }

    renderAtRoute(<RouteProbe />, {
      path: '/goals/:goalId',
      route: '/goals/17',
      user: createTestUser(),
    });

    expect(screen.getByText('Goal 17')).toBeInTheDocument();
  });

  it('creates deterministic query and property-test defaults', () => {
    const queryClient = createTestQueryClient();

    expect(queryClient.getDefaultOptions().queries?.retry).toBe(false);
    expect(queryClient.getDefaultOptions().mutations?.retry).toBe(false);
    expect(propertyTestParameters.numRuns).toBe(100);
    expect(fc.sample(fc.constant('configured'), 1)).toEqual(['configured']);

    queryClient.clear();
  });

  it('controls time without leaking fake timers into later tests', async () => {
    const clock = installFakeClock('2026-02-01T00:00:00.000Z');

    expect(new Date().toISOString()).toBe('2026-02-01T00:00:00.000Z');
    await clock.advanceBy(60_000);
    expect(new Date().toISOString()).toBe('2026-02-01T00:01:00.000Z');

    clock.restore();
  });
});

import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAuth, setAuth } from '../api';
import { measurement } from '../clarity/measurement';
import { createApiResponse, createTestUser } from '../test/test-utils';
import { useVisitTracker } from './useVisitTracker';

function Tracker() {
  useVisitTracker();
  return (
    <nav>
      <Link to="/plan">plan</Link>
      <Link to="/trips/42">trip 42</Link>
      <Link to="/trips/43">trip 43</Link>
      <Link to="/share/trip/secret-share-token">share</Link>
      <Link to="/settings?tab=export">settings</Link>
      <Link to="/login">login</Link>
    </nav>
  );
}

function mount(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Tracker />
    </MemoryRouter>,
  );
}

function trackCalls() {
  return vi.mocked(globalThis.fetch).mock.calls
    .filter(([url]) => String(url).endsWith('/api/track'))
    .map(([, init]) => ({
      body: JSON.parse(String(init?.body)) as unknown,
      headers: init?.headers as Record<string, string>,
    }));
}

const signIn = () => setAuth('visit.jwt.token', createTestUser());

beforeEach(() => {
  vi.mocked(globalThis.fetch).mockImplementation(async () => createApiResponse({ body: {}, status: 204 }));
  vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'true');
});

afterEach(() => {
  measurement.setAnalyticsConsent(false);
  clearAuth();
});

describe('useVisitTracker', () => {
  it('sends only a fixed route key for a signed-out visit to a public route', () => {
    mount('/login');
    const calls = trackCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({ route: 'login' });
    expect(calls[0]?.headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('maps a public share link to its route key and never sends the token', async () => {
    mount('/login');
    await userEvent.click(screen.getByRole('link', { name: 'share' }));
    const calls = trackCalls();
    expect(calls.map((call) => call.body)).toEqual([{ route: 'login' }, { route: 'public_trip_share' }]);
    expect(JSON.stringify(vi.mocked(globalThis.fetch).mock.calls)).not.toContain('secret-share-token');
  });

  it('does not report a signed-in-only route for a signed-out visitor', () => {
    mount('/');
    expect(trackCalls()).toHaveLength(0);
  });

  it('sends nothing for a signed-in user until Product Analytics is confirmed on', () => {
    signIn();
    mount('/plan');
    expect(trackCalls()).toHaveLength(0);
  });

  it('reports the current page once when consent is confirmed, then each new route key once', async () => {
    signIn();
    mount('/plan');
    expect(trackCalls()).toHaveLength(0);

    act(() => measurement.setAnalyticsConsent(true));
    expect(trackCalls().map((call) => call.body)).toEqual([{ route: 'plan' }]);
    expect(trackCalls()[0]?.headers.Authorization).toBe('Bearer visit.jwt.token');

    await userEvent.click(screen.getByRole('link', { name: 'trip 42' }));
    await userEvent.click(screen.getByRole('link', { name: 'trip 43' }));
    await userEvent.click(screen.getByRole('link', { name: 'settings' }));
    const bodies = trackCalls().map((call) => call.body);
    expect(bodies).toEqual([{ route: 'plan' }, { route: 'trip_detail' }, { route: 'settings' }]);
    const sent = JSON.stringify(bodies);
    expect(sent).not.toMatch(/42|43|tab|export/);
  });

  it('stops reporting after an opt-out and reports the current page again after a new opt-in', async () => {
    signIn();
    act(() => measurement.setAnalyticsConsent(true));
    mount('/plan');
    expect(trackCalls()).toHaveLength(1);

    act(() => measurement.setAnalyticsConsent(false));
    await userEvent.click(screen.getByRole('link', { name: 'settings' }));
    expect(trackCalls()).toHaveLength(1);

    act(() => measurement.setAnalyticsConsent(true));
    expect(trackCalls().map((call) => call.body)).toEqual([{ route: 'plan' }, { route: 'settings' }]);
  });

  it('does not report signed-in visits when the rollout flag is off', () => {
    vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'false');
    signIn();
    act(() => measurement.setAnalyticsConsent(true));
    mount('/plan');
    expect(trackCalls()).toHaveLength(0);
  });

  it('keeps anonymous public-route tracking when the rollout flag is off', () => {
    vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'false');
    mount('/privacy');
    expect(trackCalls().map((call) => call.body)).toEqual([{ route: 'privacy' }]);
  });

  it('does not change what renders when the beacon fails', () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new TypeError('offline'));
    expect(() => mount('/login')).not.toThrow();
    expect(screen.getByRole('link', { name: 'login' })).toBeInTheDocument();
  });
});

import { screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { buildSettings, mockSettingsApi } from '../test/dataUseFixtures';
import { createTestUser, renderAuthenticated } from '../test/test-utils';
import { Shell } from './Shell';

function renderShell(route: string, { admin = false }: { admin?: boolean } = {}) {
  return renderAuthenticated(
    <Routes>
      <Route element={<Shell />}>
        <Route path="/" element={<><h1>Home page</h1><button type="button">Add expense</button></>} />
        <Route path="/admin" element={<h1>Admin overview</h1>} />
      </Route>
    </Routes>,
    { route, user: createTestUser({ is_admin: admin }) },
  );
}

function isBefore(first: Element, second: Element): boolean {
  return Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
}

describe('Shell core promise and data-use gate', () => {
  it('renders the promise and data-use gate before routed financial controls when the rollout is on', async () => {
    vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'true');
    const api = mockSettingsApi(buildSettings());
    renderShell('/');

    const promise = await screen.findByRole('region', { name: /safe to spend/i });
    const gate = await screen.findByRole('region', { name: 'Your data, your control' });
    const addExpense = screen.getByRole('button', { name: 'Add expense' });

    expect(isBefore(promise, gate)).toBe(true);
    expect(isBefore(gate, screen.getByRole('heading', { name: 'Home page' }))).toBe(true);
    expect(isBefore(gate, addExpense)).toBe(true);
    // Existing navigation is unchanged.
    const sidebar = screen.getByRole('complementary', { name: 'Primary' });
    for (const label of ['Home', 'Spending', 'Plan', 'Goals', 'Trips', 'Settings']) {
      expect(within(sidebar).getByRole('link', { name: new RegExp(label) })).toBeInTheDocument();
    }
    expect(api.calls.filter((call) => call.url.endsWith('/api/clarity/settings'))).toHaveLength(1);
  });

  it('keeps the legacy shell when the rollout flag is off', async () => {
    const api = mockSettingsApi(buildSettings());
    renderShell('/');

    expect(await screen.findByRole('heading', { name: 'Home page' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /safe to spend/i })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Your data, your control' })).toBeNull();
    await waitFor(() => expect(api.calls.length).toBeGreaterThan(0));
    expect(api.calls.some((call) => call.url.endsWith('/api/clarity/settings'))).toBe(false);
    expect(sessionStorage.getItem('pm_promise_rendered')).toBeNull();
  });

  it('keeps admin and user navigation, and leaves the admin console without the gate', async () => {
    vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'true');
    mockSettingsApi(buildSettings({ acknowledgedVersion: 1 }));
    const { unmount } = renderShell('/', { admin: true });

    expect(await screen.findByRole('region', { name: 'Your data, your control' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Switch to admin console' })).toBeInTheDocument();
    unmount();

    renderShell('/admin', { admin: true });
    expect(await screen.findByRole('heading', { name: 'Admin overview' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /safe to spend/i })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Your data, your control' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Switch to user view' })).toBeInTheDocument();
    const sidebar = screen.getByRole('complementary', { name: 'Primary' });
    expect(within(sidebar).getByRole('link', { name: /Users/ })).toBeInTheDocument();
  });
});

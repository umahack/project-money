// The Shell with Quick Add's notice version 2 (Requirements 6.18, 14.7, 16.1, 16.20, 16.21, 16.22), through the
// data-use gate that every signed-in page shares:
//
// - while the server's notice is version 2 and the User acknowledged version 1, the gate asks once, names the changed
//   notice, and shows the category memory entry and the exclusion wording in plain language,
// - acknowledging sends version 2 and collapses the gate,
// - reading, forgetting remembered choices, export, and deletion stay available while the notice waits,
// - the notice labels do not depend on the client Quick_Add_Flag, and without the notice change nothing is added.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FinancialClarityProvider } from '../clarity/FinancialClarityProvider';
import { MutationStatusProvider } from '../clarity/MutationStatusProvider';
import { memoryClient } from '../clarity/quickAdd/memoryClient';
import { QuickAddProvider } from '../clarity/quickAdd/QuickAddProvider';
import { Settings } from '../pages/Settings';
import { buildSettings } from '../test/claritySettingsBuilder';
import { buildVersionTwoSettings, installSettingsMemoryServer, resetSharedMemoryClient } from '../test/settingsMemoryServer';
import { axe, createTestUser, renderAuthenticated } from '../test/test-utils';
import { Shell } from './Shell';

function renderShell(route: string) {
  // The providers of main.tsx: with Quick_Add_Enabled the Shell mounts Quick Add inside them.
  return renderAuthenticated(
    <FinancialClarityProvider>
      <MutationStatusProvider>
        <QuickAddProvider>
          <Routes>
            <Route element={<Shell />}>
              <Route path="/" element={<h1>Home page</h1>} />
              <Route path="/settings" element={<Settings />} />
            </Route>
          </Routes>
        </QuickAddProvider>
      </MutationStatusProvider>
    </FinancialClarityProvider>,
    { route, user: createTestUser() },
  );
}

function stubFlags(quickAdd: boolean) {
  vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'true');
  vi.stubEnv('VITE_QUICK_ADD_ENABLED', quickAdd ? 'true' : '');
}

const gateRegion = () => screen.findByRole('region', { name: 'Your data, your control' });

afterEach(() => {
  resetSharedMemoryClient();
  document.documentElement.removeAttribute('data-theme');
});

describe('notice version 2 in the gate', () => {
  it('asks the User who acknowledged version 1 to review it, and shows the new labels in plain language', async () => {
    stubFlags(true);
    installSettingsMemoryServer({ settings: buildVersionTwoSettings(1) });
    renderShell('/');
    const gate = await gateRegion();
    expect(await within(gate).findByText(/The notice changed since you last acknowledged it\./)).toBeInTheDocument();
    expect(within(gate).getByText('(version 2)')).toBeInTheDocument();
    const memory = within(gate).getByRole('heading', { name: 'Remembered category choices' }).closest('li') as HTMLElement;
    expect(memory).toHaveTextContent('suggest a category for notes you have typed before');
    expect(memory).toHaveTextContent('Category suggestion: the category Quick Add proposes for a note you have typed before');
    expect(memory).toHaveTextContent('Private to you');
    expect(memory).toHaveTextContent('Kept until you delete your account');
    const expenses = within(gate).getByRole('heading', { name: 'Expenses' }).closest('li') as HTMLElement;
    expect(expenses).toHaveTextContent('including whether an expense is counted against it');
    expect(expenses).toHaveTextContent('what you can spend today, leaving out any expense you mark as not counted in the daily allowance');
    expect(gate).not.toHaveTextContent('Category memory');
    expect(gate).not.toHaveTextContent('Today allowance');
    // New financial entries are paused until it is acknowledged, and what stays available is named.
    expect(within(gate).getByText('New entries are paused.')).toBeInTheDocument();
    expect(within(gate).getByRole('link', { name: 'exporting your data' })).toHaveAttribute('href', '/settings');
    expect(within(gate).getByRole('link', { name: 'deleting your account and data' })).toHaveAttribute('href', '/settings');
  });

  it('sends version 2 once when acknowledged, then collapses to the acknowledged state and keeps the labels under Review', async () => {
    const user = userEvent.setup();
    stubFlags(true);
    const server = installSettingsMemoryServer({ settings: buildVersionTwoSettings(1) });
    renderShell('/');
    const gate = await gateRegion();
    await user.click(await within(gate).findByRole('button', { name: 'I have read this. Acknowledge version 2' }));
    await waitFor(() => expect(within(gate).queryByRole('button', { name: /Acknowledge version/ })).toBeNull());
    const patches = server.calls.filter((call) => call.method === 'PATCH');
    expect(patches).toEqual([{ method: 'PATCH', path: '/clarity/settings', body: { acknowledgedNoticeVersion: 2 } }]);
    expect(within(gate).getByText(/You acknowledged the data-use notice \(version 2\)/)).toBeInTheDocument();
    expect(within(gate).queryByText('New entries are paused.')).toBeNull();
    await user.click(within(gate).getByRole('button', { name: 'Your data' }));
    await user.click(within(gate).getByRole('button', { name: 'Review the data-use notice' }));
    expect(within(gate).getByRole('heading', { name: 'Remembered category choices' })).toBeInTheDocument();
  });

  it('shows the same labels whatever the client Quick_Add_Flag says, because the server decides the notice', async () => {
    stubFlags(false);
    const server = installSettingsMemoryServer({ settings: buildVersionTwoSettings(1) });
    renderShell('/');
    const gate = await gateRegion();
    expect(await within(gate).findByRole('heading', { name: 'Remembered category choices' })).toBeInTheDocument();
    expect(server.memoryCalls()).toEqual([]);
  });

  it('adds nothing while the server keeps notice version 1', async () => {
    stubFlags(true);
    installSettingsMemoryServer({ settings: buildSettings({ acknowledgedVersion: 1 }) });
    renderShell('/');
    const gate = await gateRegion();
    await waitFor(() => expect(within(gate).getByText(/You acknowledged the data-use notice \(version 1\)/)).toBeInTheDocument());
    expect(gate).not.toHaveTextContent('Remembered category choices');
    expect(gate).not.toHaveTextContent('Category suggestion');
    expect(gate).not.toHaveTextContent('Today\'s allowance');
  });
});

describe('Settings in the Shell while the new notice waits', () => {
  it('lists remembered choices, forgets one and all, and leaves export and deletion available', async () => {
    const user = userEvent.setup();
    stubFlags(true);
    const server = installSettingsMemoryServer({ settings: buildVersionTwoSettings(1) });
    renderShell('/settings');
    expect(await screen.findByText('coffee')).toBeInTheDocument();
    const gate = await gateRegion();
    expect(await within(gate).findByText('New entries are paused.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Forget the remembered choice for coffee' }));
    await waitFor(() => expect(screen.queryByText('coffee')).toBeNull());
    await user.click(screen.getByRole('button', { name: 'Forget all' }));
    await user.click(screen.getByRole('button', { name: 'Yes, forget all' }));
    expect(await screen.findByText(/Nothing is remembered yet/)).toBeInTheDocument();
    expect(server.writes().map((call) => `${call.method} ${call.path}`)).toEqual([
      'DELETE /finance/category-memory/12',
      'DELETE /finance/category-memory',
    ]);
    expect(screen.getByRole('button', { name: 'Download expenses (.csv)' })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Download my data \(JSON\)/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Delete my account/ })).toBeEnabled();
    // Still waiting for the User to review it. Forgetting acknowledged nothing.
    expect(server.settings().dataUseNotice.acknowledgementRequired).toBe(true);
  });

  it('has no panel and no memory request in the Shell while the Quick_Add_Flag is off', async () => {
    stubFlags(false);
    const server = installSettingsMemoryServer({ settings: buildSettings({ acknowledgedVersion: 1 }) });
    renderShell('/settings');
    await screen.findByRole('heading', { name: /Export my data/ });
    await gateRegion();
    expect(screen.queryByRole('heading', { name: 'Remembered category choices', level: 2 })).toBeNull();
    expect(server.memoryCalls()).toEqual([]);
    expect(screen.getAllByRole('link', { name: /Settings/ }).length).toBeGreaterThan(0);
  });

  it.each(['light', 'dark'] as const)('has no violations with the version 2 notice and the memory panel in the %s theme', async (theme) => {
    document.documentElement.dataset.theme = theme;
    stubFlags(true);
    installSettingsMemoryServer({ settings: buildVersionTwoSettings(1) });
    const { container } = renderShell('/settings');
    await screen.findByText('coffee');
    const gate = await gateRegion();
    await within(gate).findByRole('heading', { name: 'Remembered category choices' });
    expect(await axe(container)).toHaveNoViolations();
  });
});

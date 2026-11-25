// The Settings page with the data-use agreement page (Requirements 4.2, 4.3, 5.4).
//
// - Paused-entries banner: shown only while Not_Now_Choice is set and the notice is required. It names the pause,
//   links to /agreement, and keeps the DATA_USE_REASON_ID association. It is absent when the choice is not set,
//   when the notice is acknowledged, while settings load or fail, and with the rollout off.
// - Settings is an Exempt_Route: export, account deletion, and the Product Analytics opt-out stay present and
//   operable in the required state.
// - axe in both themes with the banner showing.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgreementGateProvider, useAgreementGate } from '../clarity/AgreementGateProvider';
import { DataUseGateProvider } from '../clarity/DataUseGateProvider';
import { DATA_USE_REASON_ID } from '../components/clarity/DataUseGate';
import { buildSettings } from '../test/claritySettingsBuilder';
import { installSettingsMemoryServer, resetSharedMemoryClient } from '../test/settingsMemoryServer';
import { axe, createApiResponse, renderAuthenticated } from '../test/test-utils';
import { Settings } from './Settings';

/** Records Not_Now_Choice the way the Agreement page does, by calling useAgreementGate().setNotNow(). */
function NotNowChoice({ chosen }: { chosen: boolean }) {
  const { setNotNow } = useAgreementGate();
  useEffect(() => {
    if (chosen) setNotNow();
  }, [chosen, setNotNow]);
  return null;
}

function renderSettings({ notNow, rollout = true }: { notNow: boolean; rollout?: boolean }) {
  return renderAuthenticated(
    <DataUseGateProvider enabled={rollout}>
      <AgreementGateProvider>
        <NotNowChoice chosen={notNow} />
        <Settings />
      </AgreementGateProvider>
    </DataUseGateProvider>,
    { route: '/settings' },
  );
}

const BANNER_TEXT = /New entries are paused/;
const bannerElement = () => document.querySelector<HTMLElement>('.clarity-gate-paused');
const analyticsToggle = () => screen.getByRole('checkbox', { name: 'Send product usage events' });

/** Waits until the cards that depend on the settings request have left their loading state. */
async function settled() {
  await screen.findByRole('heading', { name: /Export my data/ });
  await screen.findByRole('heading', { name: /Account controls/ });
  await screen.findByRole('checkbox', { name: 'Send product usage events' });
  await waitFor(() => expect(screen.queryByText(/Available once your settings load/)).toBeNull());
}

/** Makes GET /clarity/settings fail with 403 and leaves every other route to the memory server. */
function failSettingsReads() {
  const fetchMock = vi.mocked(globalThis.fetch);
  const answer = fetchMock.getMockImplementation() as NonNullable<ReturnType<typeof fetchMock.getMockImplementation>>;
  fetchMock.mockImplementation(async (input, init) => {
    if (String(input).endsWith('/clarity/settings') && (init?.method ?? 'GET') === 'GET') {
      return createApiResponse({ status: 403, body: { error: { code: 'FORBIDDEN', message: 'Settings are unavailable.' } } });
    }
    return answer(input, init);
  });
}

/** Makes GET /clarity/settings never answer, so the gate stays in `loading`. */
function holdSettingsReads() {
  const fetchMock = vi.mocked(globalThis.fetch);
  const answer = fetchMock.getMockImplementation() as NonNullable<ReturnType<typeof fetchMock.getMockImplementation>>;
  fetchMock.mockImplementation(async (input, init) => {
    if (String(input).endsWith('/clarity/settings') && (init?.method ?? 'GET') === 'GET') {
      return new Promise<Response>(() => {});
    }
    return answer(input, init);
  });
}

afterEach(() => {
  resetSharedMemoryClient();
  document.documentElement.removeAttribute('data-theme');
});

describe('paused-entries banner', () => {
  it('appears with the pause message and a link to /agreement when the notice is required and Not_Now_Choice is set', async () => {
    installSettingsMemoryServer({ settings: buildSettings() });
    renderSettings({ notNow: true });
    const banner = (await screen.findByText(BANNER_TEXT)).closest('.clarity-gate-paused') as HTMLElement;
    expect(banner).not.toBeNull();
    const link = within(banner).getByRole('link', { name: 'Review the data-use notice' });
    expect(link).toHaveAttribute('href', '/agreement');
    expect(banner).toHaveTextContent('New entries are paused because the data-use notice has not been acknowledged.');
    expect(banner).toHaveTextContent(/Exporting, correcting, and deleting your data, and turning Product Analytics off, stay available below\./);
    // Requirement 4.3: the existing reason association is kept.
    expect(banner).toHaveAttribute('aria-describedby', DATA_USE_REASON_ID);
    // One banner, above the settings cards.
    expect(document.querySelectorAll('.clarity-gate-paused')).toHaveLength(1);
    const firstCard = screen.getAllByRole('heading', { level: 2 })[0] as HTMLElement;
    expect(banner.compareDocumentPosition(firstCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('does not appear when Not_Now_Choice is not set, even though the notice is required', async () => {
    installSettingsMemoryServer({ settings: buildSettings() });
    renderSettings({ notNow: false });
    await settled();
    // The notice is required: Product Analytics is asking for it.
    expect(screen.getByText(/Acknowledge the data-use notice to turn it on/)).toBeInTheDocument();
    expect(screen.queryByText(BANNER_TEXT)).toBeNull();
    expect(bannerElement()).toBeNull();
  });

  it('does not appear when the notice is acknowledged, even though Not_Now_Choice is set', async () => {
    installSettingsMemoryServer({ settings: buildSettings({ acknowledgedVersion: 1 }) });
    renderSettings({ notNow: true });
    await settled();
    // Acknowledged: nothing asks for the notice any more.
    expect(analyticsToggle()).toBeEnabled();
    expect(screen.queryByText(/Acknowledge the data-use notice to turn it on/)).toBeNull();
    expect(screen.queryByText(BANNER_TEXT)).toBeNull();
    expect(bannerElement()).toBeNull();
  });

  it('does not appear while the settings are loading', async () => {
    installSettingsMemoryServer({ settings: buildSettings() });
    holdSettingsReads();
    renderSettings({ notNow: true });
    await screen.findByRole('heading', { name: /Account controls/ });
    await screen.findByText(/Available once your settings load/);
    expect(screen.queryByText(BANNER_TEXT)).toBeNull();
    expect(bannerElement()).toBeNull();
  });

  it('does not appear when the settings could not be loaded', async () => {
    installSettingsMemoryServer({ settings: buildSettings() });
    failSettingsReads();
    renderSettings({ notNow: true });
    await screen.findByText(/Settings could not be loaded/);
    expect(screen.queryByText(BANNER_TEXT)).toBeNull();
    expect(bannerElement()).toBeNull();
  });

  it('does not appear with the rollout flag off, and the page makes no settings request', async () => {
    const server = installSettingsMemoryServer({ settings: buildSettings() });
    renderSettings({ notNow: true, rollout: false });
    await screen.findByRole('heading', { name: /Account controls/ });
    // Product Analytics renders nothing while the rollout is off, and the gate is disabled.
    expect(screen.queryByRole('heading', { name: /Product Analytics/ })).toBeNull();
    expect(screen.queryByText(BANNER_TEXT)).toBeNull();
    expect(bannerElement()).toBeNull();
    expect(server.settingsReads()).toEqual([]);
  });
});

describe('Settings is exempt: data controls stay present and operable while the notice is required', () => {
  it('keeps export, account deletion, and the Product Analytics opt-out enabled next to the banner', async () => {
    installSettingsMemoryServer({ settings: buildSettings({ analyticsEnabled: true }) });
    renderSettings({ notNow: true });
    await screen.findByText(BANNER_TEXT);
    await settled();
    expect(screen.getByRole('button', { name: 'Download expenses (.csv)' })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Download my data \(JSON\)/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Delete my account/ })).toBeEnabled();
    expect(analyticsToggle()).toBeEnabled();
    expect(analyticsToggle()).toBeChecked();
  });

  it('turns Product Analytics off with a single request that changes nothing else', async () => {
    const user = userEvent.setup();
    const server = installSettingsMemoryServer({ settings: buildSettings({ analyticsEnabled: true }) });
    renderSettings({ notNow: true });
    await screen.findByText(BANNER_TEXT);
    await settled();
    await user.click(analyticsToggle());
    await waitFor(() => expect(server.writes()).toHaveLength(1));
    expect(server.writes()).toEqual([{ method: 'PATCH', path: '/clarity/settings', body: { analyticsEnabled: false } }]);
    expect(await screen.findByText(/Product Analytics is off\. Your records and results are unchanged\./)).toBeInTheDocument();
  });

  it('opens the account deletion form from the required state', async () => {
    const user = userEvent.setup();
    installSettingsMemoryServer({ settings: buildSettings() });
    renderSettings({ notNow: true });
    await screen.findByText(BANNER_TEXT);
    await settled();
    await user.click(screen.getByRole('button', { name: /Delete my account/ }));
    expect(screen.getByLabelText('Current password')).toBeEnabled();
    expect(screen.getByLabelText('Type "DELETE" to confirm')).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Permanently delete my account' })).toBeEnabled();
  });

  it('downloads the CSV and the account JSON from the required state', async () => {
    const user = userEvent.setup();
    const server = installSettingsMemoryServer({ settings: buildSettings() });
    // jsdom cannot follow a download link; keep the downloads inert.
    const spies = [
      vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test'),
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {}),
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {}),
    ];
    try {
      renderSettings({ notNow: true });
      await screen.findByText(BANNER_TEXT);
      await settled();
      await user.click(screen.getByRole('button', { name: 'Download expenses (.csv)' }));
      await waitFor(() => expect(server.calls.some((call) => call.path === '/finance/export.csv')).toBe(true));
      await user.click(screen.getByRole('button', { name: /Download my data \(JSON\)/ }));
      await waitFor(() => expect(server.calls.some((call) => call.path === '/auth/export')).toBe(true));
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });

  it('keeps the same controls without the banner when Not_Now_Choice is not set', async () => {
    installSettingsMemoryServer({ settings: buildSettings() });
    renderSettings({ notNow: false });
    await settled();
    expect(screen.queryByText(BANNER_TEXT)).toBeNull();
    expect(screen.getByRole('button', { name: 'Download expenses (.csv)' })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Download my data \(JSON\)/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Delete my account/ })).toBeEnabled();
  });
});

describe.each(['light', 'dark'] as const)('accessibility in the %s theme', (theme) => {
  it('has no violations with the paused-entries banner showing', async () => {
    document.documentElement.dataset.theme = theme;
    installSettingsMemoryServer({ settings: buildSettings() });
    const { container } = renderSettings({ notNow: true });
    await screen.findByText(BANNER_TEXT);
    await settled();
    expect(await axe(container)).toHaveNoViolations();
  });
});

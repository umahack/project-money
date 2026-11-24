// The Settings page with Quick Add (Requirements 6.10, 6.11, 6.18, 16.1, 16.2), as one page: the category memory
// panel together with Product Analytics, export, and account controls.
//
// - Quick_Add_Enabled off (the Rollout_Flag off, the Quick_Add_Flag off, or both): the page is the page it was.
//   Structural and snapshot-free: the flag-on markup minus the memory panel equals the flag-off markup, and no
//   Quick Add or Memory_API request is made.
// - Quick_Add_Enabled on: the panel sits between Product Analytics and export, the siblings keep working, one
//   and all remembered choices are forgotten from the page without touching them, and the page points at controls
//   it really has.
// - axe in both themes for the combined states.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { memoryClient } from '../clarity/quickAdd/memoryClient';
import { DataUseGateProvider } from '../clarity/DataUseGateProvider';
import { buildSettings } from '../test/claritySettingsBuilder';
import { buildVersionTwoSettings, installSettingsMemoryServer, resetSharedMemoryClient } from '../test/settingsMemoryServer';
import { axe, renderAuthenticated } from '../test/test-utils';
import { Settings } from './Settings';

const MEMORY_HEADING = 'Remembered category choices';
// React's generated ids and the entrance animation's inline opacity and offset differ between renders.
const normalized = (html: string) => html
  .replace(/:r[0-9a-z]+:/g, ':id:')
  .replace(/ style="opacity: [^"]*"/g, '');
function firstDifference(expected: string, actual: string): string {
  let at = 0;
  while (at < expected.length && at < actual.length && expected[at] === actual[at]) at += 1;
  return `first difference at ${at}: expected ...${expected.slice(Math.max(0, at - 60), at + 120)} but got ...${actual.slice(Math.max(0, at - 60), at + 120)}`;
}

function stubFlags(options: { rollout: boolean; quickAdd: boolean }) {
  vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', options.rollout ? 'true' : '');
  vi.stubEnv('VITE_QUICK_ADD_ENABLED', options.quickAdd ? 'true' : '');
}

function renderSettings() {
  return renderAuthenticated(<DataUseGateProvider><Settings /></DataUseGateProvider>);
}

const headings = () => screen.getAllByRole('heading', { level: 2 }).map((node) => (node.textContent ?? '').replace(/^\S+\s/u, '').trim());

/** Waits until every card on the page has left its loading state, so two renders can be compared. */
async function settled(options: { analytics: boolean; memory: boolean }) {
  await screen.findByRole('heading', { name: /Export my data/ });
  await screen.findByRole('heading', { name: /Account controls/ });
  if (options.analytics) {
    await screen.findByRole('checkbox', { name: 'Send product usage events' });
    await waitFor(() => expect(screen.queryByText(/Available once your settings load/)).toBeNull());
  }
  if (options.memory) await screen.findByText('coffee');
  await waitFor(() => expect(screen.queryByText(/Loading/)).toBeNull());
}

afterEach(() => {
  resetSharedMemoryClient();
  document.documentElement.removeAttribute('data-theme');
});

describe('Quick_Add_Enabled off', () => {
  it.each([
    ['the Quick_Add_Flag off', { rollout: true, quickAdd: false }],
    ['the Rollout_Flag off while the Quick_Add_Flag is on', { rollout: false, quickAdd: true }],
    ['both flags off', { rollout: false, quickAdd: false }],
  ])('shows no memory panel and makes no Quick Add or Memory_API request with %s', async (_label, flags) => {
    stubFlags(flags);
    const server = installSettingsMemoryServer({ settings: buildSettings({ acknowledgedVersion: 1 }) });
    const { container } = renderSettings();
    await settled({ analytics: flags.rollout, memory: false });
    expect(screen.queryByRole('heading', { name: MEMORY_HEADING })).toBeNull();
    expect(container.querySelector('.memory-panel')).toBeNull();
    expect(screen.queryByRole('button', { name: /Forget/ })).toBeNull();
    expect(server.memoryCalls()).toEqual([]);
    expect(server.writes()).toEqual([]);
  });

  it('lists the same cards in the same order as before, ending with Product Analytics (when the rollout is on), export, and account controls', async () => {
    stubFlags({ rollout: true, quickAdd: false });
    installSettingsMemoryServer({ settings: buildSettings({ acknowledgedVersion: 1 }) });
    renderSettings();
    await settled({ analytics: true, memory: false });
    const order = headings();
    expect(order.slice(-3)).toEqual(['Product Analytics', 'Export my data', 'Account controls']);
    expect(order).not.toContain(MEMORY_HEADING);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Settings');
    expect(screen.getByText('Device sign-ins, account password, and data export.')).toBeInTheDocument();
  });

  it.each([
    ['rollout on', true],
    ['rollout off', false],
  ])('is the same markup as the flag-on page without its memory panel (%s)', async (_label, rollout) => {
    // The flag-on page differs from the flag-off page only by the memory panel (which needs the rollout too).
    stubFlags({ rollout, quickAdd: false });
    installSettingsMemoryServer({ settings: buildSettings({ acknowledgedVersion: 1 }) });
    const off = renderSettings();
    await settled({ analytics: rollout, memory: false });
    const before = normalized(off.container.innerHTML);
    off.unmount();
    vi.unstubAllEnvs();
    resetSharedMemoryClient();
    stubFlags({ rollout, quickAdd: true });
    installSettingsMemoryServer({ settings: buildSettings({ acknowledgedVersion: 1 }) });
    const on = renderSettings();
    await settled({ analytics: rollout, memory: rollout });
    const clone = on.container.cloneNode(true) as HTMLElement;
    const panel = clone.querySelector('.memory-panel');
    // The panel needs the rollout as well as the Quick_Add_Flag.
    expect(panel !== null).toBe(rollout);
    panel?.remove();
    const after = normalized(clone.innerHTML);
    expect(after, firstDifference(before, after)).toBe(before);
  });
});

describe('Quick_Add_Enabled on', () => {
  function enable(acknowledgedVersion: 0 | 1 | 2 = 2) {
    stubFlags({ rollout: true, quickAdd: true });
    return installSettingsMemoryServer({ settings: buildVersionTwoSettings(acknowledgedVersion) });
  }

  it('puts the memory panel between Product Analytics and export, ahead of account controls, and reads the hints once', async () => {
    const server = enable();
    renderSettings();
    await settled({ analytics: true, memory: true });
    expect(headings().slice(-4)).toEqual(['Product Analytics', MEMORY_HEADING, 'Export my data', 'Account controls']);
    expect(server.hintReads()).toHaveLength(1);
    expect(server.settingsReads()).toHaveLength(1);
    expect(server.writes()).toEqual([]);
    const list = screen.getByRole('list', { name: MEMORY_HEADING });
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
  });

  it('keeps Product Analytics, export, and account controls working beside the panel', async () => {
    const user = userEvent.setup();
    const server = enable();
    renderSettings();
    await settled({ analytics: true, memory: true });
    const analytics = screen.getByRole('checkbox', { name: 'Send product usage events' });
    expect(analytics).toBeEnabled();
    expect(analytics).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Download expenses (.csv)' })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Download my data \(JSON\)/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Delete my account/ })).toBeEnabled();
    // Forgetting one choice touches none of them and sends nothing but its own delete.
    await user.click(screen.getByRole('button', { name: 'Forget the remembered choice for metro' }));
    await waitFor(() => expect(screen.queryByText('metro')).toBeNull());
    expect(server.writes()).toEqual([{ method: 'DELETE', path: '/finance/category-memory/7', body: undefined }]);
    expect(screen.getByRole('checkbox', { name: 'Send product usage events' })).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Download expenses (.csv)' })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Delete my account/ })).toBeEnabled();
  });

  it('forgets one remembered choice from the page without reading the hints or the settings again', async () => {
    const user = userEvent.setup();
    const server = enable();
    renderSettings();
    await settled({ analytics: true, memory: true });
    await user.click(screen.getByRole('button', { name: 'Forget the remembered choice for coffee' }));
    await waitFor(() => expect(screen.queryByText('coffee')).toBeNull());
    expect(server.memory.map((row) => row.noteKey)).toEqual(['metro', 'chai at the station']);
    expect(screen.getByText('metro')).toBeInTheDocument();
    expect(screen.getByText('chai at the station')).toBeInTheDocument();
    expect(server.hintReads()).toHaveLength(1);
    expect(server.settingsReads()).toHaveLength(1);
    // The deleted entry is no longer something the next suggestion can use.
    expect(memoryClient.readView().memory.map((entry) => entry.noteKey)).toEqual(['metro', 'chai at the station']);
  });

  it('forgets all remembered choices from the page after a confirmation, with one request', async () => {
    const user = userEvent.setup();
    const server = enable();
    renderSettings();
    await settled({ analytics: true, memory: true });
    await user.click(screen.getByRole('button', { name: 'Forget all' }));
    expect(server.writes()).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Yes, forget all' }));
    expect(await screen.findByText(/Nothing is remembered yet/)).toBeInTheDocument();
    expect(server.writes()).toEqual([{ method: 'DELETE', path: '/finance/category-memory', body: undefined }]);
    expect(screen.getByRole('heading', { name: MEMORY_HEADING })).toHaveFocus();
    expect(memoryClient.readView().memory).toEqual([]);
    // The panel stays in its place, and the cards around it are as they were.
    expect(headings().slice(-4)).toEqual(['Product Analytics', MEMORY_HEADING, 'Export my data', 'Account controls']);
  });

  it('points at export and deletion controls that are on this same page', async () => {
    enable();
    renderSettings();
    await settled({ analytics: true, memory: true });
    const panel = screen.getByRole('heading', { name: MEMORY_HEADING }).closest('.memory-panel') as HTMLElement;
    expect(panel).toHaveTextContent(/included when you download your account data, and are deleted with your account\. Both are under Account controls on this page\./);
    const accountControls = screen.getByRole('heading', { name: /Account controls/ }).closest('div') as HTMLElement;
    expect(within(accountControls).getByRole('button', { name: /Download my data \(JSON\)/ })).toBeInTheDocument();
    expect(within(accountControls).getByRole('button', { name: /Delete my account/ })).toBeInTheDocument();
    expect(within(accountControls).getByText(/Download everything we have on your account/)).toBeInTheDocument();
  });

  it('keeps listing and forgetting remembered choices while the new notice has not been acknowledged', async () => {
    const user = userEvent.setup();
    const server = enable(1);
    renderSettings();
    await settled({ analytics: true, memory: true });
    // Product Analytics asks for the notice first, and nothing else on this page is paused.
    expect(screen.getByRole('checkbox', { name: 'Send product usage events' })).toBeDisabled();
    expect(screen.getByText(/Acknowledge the data-use notice to turn it on/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Forget the remembered choice for coffee' }));
    await waitFor(() => expect(screen.queryByText('coffee')).toBeNull());
    expect(server.writes()).toEqual([{ method: 'DELETE', path: '/finance/category-memory/12', body: undefined }]);
    expect(screen.getByRole('button', { name: 'Download expenses (.csv)' })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Delete my account/ })).toBeEnabled();
  });
});

describe.each(['light', 'dark'] as const)('accessibility in the %s theme', (theme) => {
  it('has no violations with the whole page and the memory list', async () => {
    document.documentElement.dataset.theme = theme;
    stubFlags({ rollout: true, quickAdd: true });
    installSettingsMemoryServer({ settings: buildVersionTwoSettings(2) });
    const { container } = renderSettings();
    await settled({ analytics: true, memory: true });
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no violations with the forget-all confirmation open and a failed delete shown', async () => {
    document.documentElement.dataset.theme = theme;
    const user = userEvent.setup();
    stubFlags({ rollout: true, quickAdd: true });
    const server = installSettingsMemoryServer({ settings: buildVersionTwoSettings(2) });
    const { container } = renderSettings();
    await settled({ analytics: true, memory: true });
    const fetchMock = vi.mocked(globalThis.fetch);
    const answer = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (input, init) => {
      if ((init?.method ?? 'GET') === 'DELETE' && String(input).endsWith('/finance/category-memory/7')) {
        return new Response(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Detail that must not be shown.' } }), { status: 500, headers: { 'content-type': 'application/json' } });
      }
      return (answer as NonNullable<typeof answer>)(input, init);
    });
    await user.click(screen.getByRole('button', { name: 'Forget the remembered choice for metro' }));
    expect(await screen.findByText('Not forgotten.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Forget all' }));
    expect(screen.getByRole('group', { name: 'Forget all 3 remembered choices?' })).toBeInTheDocument();
    expect(server.memory).toHaveLength(3);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no violations with the Quick_Add_Flag off', async () => {
    document.documentElement.dataset.theme = theme;
    stubFlags({ rollout: true, quickAdd: false });
    installSettingsMemoryServer({ settings: buildSettings({ acknowledgedVersion: 1 }) });
    const { container } = renderSettings();
    await settled({ analytics: true, memory: false });
    expect(await axe(container)).toHaveNoViolations();
  });
});

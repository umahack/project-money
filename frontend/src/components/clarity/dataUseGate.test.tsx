import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DataUseGateProvider, PROMISE_RENDERED_KEY, useDataUseGate } from '../../clarity/DataUseGateProvider';
import { DATA_NOTICE_REQUIRED_EVENT } from '../../clarity/settings';
import { buildSettings, mockSettingsApi } from '../../test/dataUseFixtures';
import { axe, createApiResponse, createTestUser, renderAuthenticated } from '../../test/test-utils';
import { CorePromiseStrip, DATA_USE_REASON_ID, DataUseGate } from './index';

function Probe() {
  const gate = useDataUseGate();
  return (
    <div>
      <p>Saved salary: visible to you</p>
      <p data-testid="inputs-state">{gate.financialInputsEnabled ? 'inputs enabled' : 'inputs paused'}</p>
      <button type="button" disabled={!gate.financialInputsEnabled} aria-describedby={DATA_USE_REASON_ID}>
        Add expense
      </button>
    </div>
  );
}

function Harness({ enabled = true }: { enabled?: boolean }) {
  return (
    <DataUseGateProvider enabled={enabled}>
      <CorePromiseStrip />
      <DataUseGate />
      <Probe />
    </DataUseGateProvider>
  );
}

const inputsState = () => screen.getByTestId('inputs-state');
const gateStatus = () => document.querySelector('.clarity-gate-status');
const reviewButton = () => screen.getByRole('button', { name: /Review the data-use notice/ });

describe('CorePromiseStrip and DataUseGate when the notice is not acknowledged', () => {
  it('shows the connected promise and the full notice, and pauses new entries with a reason', async () => {
    mockSettingsApi(buildSettings());
    renderAuthenticated(<Harness />);

    const promise = await screen.findByRole('region', { name: /safe to spend/i });
    for (const word of ['Plan', 'Spending', 'Saving', 'Trips']) {
      expect(within(promise).getByText(`${word}:`)).toBeInTheDocument();
    }

    const gate = await screen.findByRole('region', { name: 'Your data, your control' });
    expect(within(gate).getByRole('heading', { name: /How Project Money uses your data/ })).toBeInTheDocument();
    // Categories, outcomes (with a first-use definition), access roles, retention, sharing.
    expect(within(gate).getByRole('heading', { name: 'Salary' })).toBeInTheDocument();
    expect(within(gate).getByText(/Disposable income: the pay left after your monthly bills/)).toBeInTheDocument();
    expect(within(gate).getAllByText('Disposable income')).toHaveLength(1); // defined once, then named only
    expect(within(gate).getAllByText('You, the account owner').length).toBeGreaterThan(0);
    expect(within(gate).getByText('Accepted trip members, for shared trip fields only')).toBeInTheDocument();
    expect(within(gate).getAllByText('Kept until you delete your account').length).toBeGreaterThan(0);
    expect(within(gate).getByText(/A separate confirmation, after you review the disclosed fields/)).toBeInTheDocument();
    // Correction, export, deletion, and Product Analytics controls are listed.
    expect(within(gate).getByText(/Your earlier confirmed value stays until the correction succeeds/)).toBeInTheDocument();
    expect(within(gate).getByRole('link', { name: 'Export your data' })).toHaveAttribute('href', '/settings');
    expect(within(gate).getByRole('link', { name: 'Delete your account and data' })).toHaveAttribute('href', '/settings');
    expect(within(gate).getAllByText(/It never includes financial amounts, free-text notes/).length).toBeGreaterThan(0);

    // Existing data stays readable. New entries are paused with a visible reason.
    expect(screen.getByText('Saved salary: visible to you')).toBeInTheDocument();
    expect(inputsState()).toHaveTextContent('inputs paused');
    const addExpense = screen.getByRole('button', { name: 'Add expense' });
    expect(addExpense).toBeDisabled();
    const reason = document.getElementById(DATA_USE_REASON_ID);
    expect(reason).toHaveTextContent(/acknowledge the data-use notice \(version 1\)/i);
    expect(addExpense).toHaveAccessibleDescription(/New entries are paused/);
    expect(reason).toHaveTextContent(/viewing everything you have saved, correcting records/);
    expect(within(reason as HTMLElement).getByRole('link', { name: /exporting your data/ })).toBeVisible();
  });

  it('renders server-provided notice text as plain text, never as markup', async () => {
    const settings = buildSettings();
    settings.dataUseNotice.categories[0]!.purposes = ['<img src=x onerror=alert(1)> and <b>bold</b>'];
    mockSettingsApi(settings);
    renderAuthenticated(<Harness />);

    await screen.findByRole('heading', { name: 'Salary' });
    expect(screen.getByText('<img src=x onerror=alert(1)> and <b>bold</b>')).toBeInTheDocument();
    expect(document.querySelector('.clarity-gate img, .clarity-gate b')).toBeNull();
  });

  it('acknowledges only the notice version, enables entries, and keeps focus in the region', async () => {
    const user = userEvent.setup();
    const api = mockSettingsApi(buildSettings());
    renderAuthenticated(<Harness />);

    await user.click(await screen.findByRole('button', { name: /Acknowledge version 1/ }));

    await waitFor(() => expect(inputsState()).toHaveTextContent('inputs enabled'));
    expect(api.patches()).toHaveLength(1);
    expect(api.patches()[0]?.body).toEqual({ acknowledgedNoticeVersion: 1 });
    expect(gateStatus()).toHaveTextContent('Data-use notice acknowledged');
    expect(screen.getByRole('heading', { name: 'Your data, your control' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Add expense' })).toBeEnabled();
    expect(document.getElementById(DATA_USE_REASON_ID)).toBeNull();
    // Acknowledging never turns Product Analytics on.
    expect(screen.getByRole('checkbox', { name: /Product Analytics/ })).not.toBeChecked();
  });

  it('keeps the gate and shows a text error when the acknowledgement cannot be saved', async () => {
    const user = userEvent.setup();
    mockSettingsApi(buildSettings());
    renderAuthenticated(<Harness />);
    const button = await screen.findByRole('button', { name: /Acknowledge version 1/ });

    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      createApiResponse({ status: 500, body: { error: { code: 'SERVER', message: 'The server had a problem.' } } }),
    );
    await user.click(button);

    expect(await screen.findByText(/Your acknowledgement was not saved/)).toBeInTheDocument();
    expect(inputsState()).toHaveTextContent('inputs paused');
    expect(screen.getByRole('button', { name: /Acknowledge version 1/ })).toBeEnabled();
  });

  it('explains why Product Analytics cannot be turned on yet', async () => {
    mockSettingsApi(buildSettings());
    renderAuthenticated(<Harness />);

    await screen.findByRole('button', { name: /Acknowledge version 1/ });
    const toggle = screen.getByRole('checkbox', { name: /Product Analytics/ });
    expect(toggle).toBeDisabled();
    expect(toggle).not.toBeChecked();
    expect(toggle).toHaveAccessibleDescription(/Acknowledge the data-use notice to turn it on/);
  });

  it('shows the notice when a command is rejected with 428 after an acknowledged state', async () => {
    const state = buildSettings({ acknowledgedVersion: 1 });
    const api = mockSettingsApi(state);
    renderAuthenticated(<Harness />);
    await waitFor(() => expect(inputsState()).toHaveTextContent('inputs enabled'));

    // The server now requires a newer notice.
    const newer = buildSettings();
    newer.dataUseNotice.acknowledgedVersion = 1;
    newer.dataUseNotice.acknowledgementRequired = true;
    vi.mocked(globalThis.fetch).mockImplementation(async () => createApiResponse({ body: newer }));
    act(() => { window.dispatchEvent(new Event(DATA_NOTICE_REQUIRED_EVENT)); });

    await waitFor(() => expect(inputsState()).toHaveTextContent('inputs paused'));
    expect(screen.getByText(/The notice changed since you last acknowledged it/)).toBeInTheDocument();
    expect(api.patches()).toHaveLength(0);
  });
});

describe('DataUseGate when the notice is acknowledged', () => {
  it('enables entries, keeps the notice reviewable, and stores only a promise flag', async () => {
    const user = userEvent.setup();
    const authenticated = createTestUser();
    mockSettingsApi(buildSettings({ acknowledgedVersion: 1 }));
    renderAuthenticated(<Harness />, { user: authenticated });

    await waitFor(() => expect(inputsState()).toHaveTextContent('inputs enabled'));
    expect(screen.getByText(/You acknowledged the data-use notice \(version 1\) on 10 Jan 2026/)).toBeInTheDocument();
    expect(document.getElementById(DATA_USE_REASON_ID)).toBeNull();
    expect(screen.queryByRole('button', { name: /Acknowledge version/ })).toBeNull();
    // Correction, export, and deletion stay discoverable from the collapsed notice.
    expect(reviewButton()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: 'Export your data' })).toBeNull();
    await user.click(reviewButton());
    expect(reviewButton()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: 'Export your data' })).toBeVisible();

    // Only the session-rendered promise flag is stored, never financial values.
    expect(sessionStorage.getItem(PROMISE_RENDERED_KEY)).toBe(String(authenticated.id));
    const stored = Object.keys(sessionStorage).sort();
    expect(stored).toEqual([PROMISE_RENDERED_KEY, 'pm_token', 'pm_user'].sort());
    expect(Object.keys(localStorage)).toEqual([]);
  });
});

describe('Product Analytics independence', () => {
  it('turns on and off without changing whether financial entries are enabled', async () => {
    const user = userEvent.setup();
    const api = mockSettingsApi(buildSettings({ acknowledgedVersion: 1 }));
    renderAuthenticated(<Harness />);
    const toggle = await screen.findByRole('checkbox', { name: /Product Analytics/ });
    await waitFor(() => expect(inputsState()).toHaveTextContent('inputs enabled'));

    await user.click(toggle);
    await waitFor(() => expect(toggle).toBeChecked());
    expect(api.patches().map((call) => call.body)).toEqual([{ analyticsEnabled: true }]);
    expect(inputsState()).toHaveTextContent('inputs enabled');
    expect(gateStatus()).toHaveTextContent('Product Analytics is on.');
    expect(toggle).toHaveFocus();

    await user.click(toggle);
    await waitFor(() => expect(toggle).not.toBeChecked());
    expect(api.patches().map((call) => call.body)).toEqual([{ analyticsEnabled: true }, { analyticsEnabled: false }]);
    expect(inputsState()).toHaveTextContent('inputs enabled');
    expect(gateStatus()).toHaveTextContent('Your records and results are unchanged');
    expect(screen.getByRole('button', { name: 'Add expense' })).toBeEnabled();
  });

  it('can be turned off while the notice is outstanding, without enabling entries', async () => {
    const user = userEvent.setup();
    const settings = buildSettings({ acknowledgedVersion: 0, analyticsEnabled: true });
    const api = mockSettingsApi(settings);
    renderAuthenticated(<Harness />);
    await screen.findByRole('button', { name: /Acknowledge version 1/ });
    const toggle = screen.getByRole('checkbox', { name: /Product Analytics/ });

    expect(toggle).toBeChecked();
    expect(toggle).toBeEnabled();
    await user.click(toggle);

    await waitFor(() => expect(toggle).not.toBeChecked());
    expect(api.patches().map((call) => call.body)).toEqual([{ analyticsEnabled: false }]);
    expect(inputsState()).toHaveTextContent('inputs paused');
  });

  it('keeps the previous setting and shows a text error when the change fails', async () => {
    const user = userEvent.setup();
    mockSettingsApi(buildSettings({ acknowledgedVersion: 1 }));
    renderAuthenticated(<Harness />);
    const toggle = await screen.findByRole('checkbox', { name: /Product Analytics/ });
    await waitFor(() => expect(toggle).toBeEnabled());

    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      createApiResponse({ status: 500, body: { error: { code: 'SERVER', message: 'The server had a problem.' } } }),
    );
    await user.click(toggle);

    expect(await screen.findByText(/The Product Analytics setting was not changed/)).toBeInTheDocument();
    expect(toggle).not.toBeChecked();
    expect(inputsState()).toHaveTextContent('inputs enabled');
  });
});

describe('failure and rollout states', () => {
  it('pauses new entries with a retry when settings cannot be loaded, and recovers on retry', async () => {
    const user = userEvent.setup();
    let failing = true;
    mockSettingsApi(buildSettings({ acknowledgedVersion: 1 }), { failGet: () => failing });
    renderAuthenticated(<Harness />);

    expect(await screen.findByText(/Your data-use settings could not be loaded/)).toBeInTheDocument();
    expect(screen.getByText('Saved salary: visible to you')).toBeInTheDocument();
    expect(inputsState()).toHaveTextContent('inputs paused');
    expect(document.getElementById(DATA_USE_REASON_ID)).toHaveTextContent(/new entries are paused/i);

    failing = false;
    await user.click(screen.getByRole('button', { name: 'Retry loading settings' }));
    await waitFor(() => expect(inputsState()).toHaveTextContent('inputs enabled'));
  });

  it('renders nothing and requests nothing when the clarity rollout is disabled', async () => {
    const api = mockSettingsApi(buildSettings());
    renderAuthenticated(<Harness enabled={false} />);

    expect(screen.queryByRole('region')).toBeNull();
    expect(inputsState()).toHaveTextContent('inputs enabled');
    expect(screen.getByRole('button', { name: 'Add expense' })).toBeEnabled();
    expect(api.calls).toHaveLength(0);
    expect(sessionStorage.getItem(PROMISE_RENDERED_KEY)).toBeNull();
  });

  it('rejects malformed settings instead of rendering unknown content', async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async () => createApiResponse({ body: { schemaVersion: 2 } }));
    renderAuthenticated(<Harness />);

    expect(await screen.findByText(/Your data-use settings could not be loaded/, {}, { timeout: 3000 })).toBeInTheDocument();
    expect(inputsState()).toHaveTextContent('inputs paused');
  });
});

describe('keyboard operation', () => {
  it('reaches and operates every control in reading order without a pointer', async () => {
    const user = userEvent.setup();
    mockSettingsApi(buildSettings());
    renderAuthenticated(<Harness />);
    await screen.findByRole('button', { name: /Acknowledge version 1/ });

    // Reading order: notice controls, acknowledge, still-available links.
    await user.tab();
    expect(screen.getByRole('link', { name: 'Export your data' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('link', { name: 'Delete your account and data' })).toHaveFocus();
    await user.tab();
    const acknowledge = screen.getByRole('button', { name: /Acknowledge version 1/ });
    expect(acknowledge).toHaveFocus();

    await user.keyboard('{Enter}');
    await waitFor(() => expect(inputsState()).toHaveTextContent('inputs enabled'));
    expect(screen.getByRole('heading', { name: 'Your data, your control' })).toHaveFocus();

    // Next stop is the notice disclosure, then the Product Analytics checkbox. Nothing traps focus.
    await user.tab();
    expect(reviewButton()).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(reviewButton()).toHaveAttribute('aria-expanded', 'true');
    expect(reviewButton()).toHaveFocus();
    await user.keyboard(' ');
    expect(reviewButton()).toHaveAttribute('aria-expanded', 'false');
    await user.tab();
    const toggle = screen.getByRole('checkbox', { name: /Product Analytics/ });
    expect(toggle).toHaveFocus();
    await user.keyboard(' ');
    await waitFor(() => expect(toggle).toBeChecked());
    expect(toggle).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Add expense' })).toHaveFocus();
  });
});

describe('accessibility', () => {
  it.each(['light', 'dark'] as const)('has no axe violations in %s theme (gated and acknowledged)', async (theme) => {
    document.documentElement.dataset.theme = theme;
    try {
      const user = userEvent.setup();
      mockSettingsApi(buildSettings());
      const view = renderAuthenticated(<Harness />);

      await screen.findByRole('button', { name: /Acknowledge version 1/ });
      expect(await axe(view.container)).toHaveNoViolations();

      await user.click(screen.getByRole('button', { name: /Acknowledge version 1/ }));
      await waitFor(() => expect(inputsState()).toHaveTextContent('inputs enabled'));
      await user.click(reviewButton());
      expect(await axe(view.container)).toHaveNoViolations();
    } finally {
      delete document.documentElement.dataset.theme;
    }
  });
});

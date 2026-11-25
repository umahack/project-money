import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { DataUseGateProvider, PROMISE_RENDERED_KEY, useDataUseGate } from '../../clarity/DataUseGateProvider';
import { DATA_NOTICE_REQUIRED_EVENT } from '../../clarity/settings';
import { buildSettings, mockSettingsApi } from '../../test/dataUseFixtures';
import { axe, createApiResponse, createTestUser, renderAuthenticated } from '../../test/test-utils';
import { CorePromiseStrip, DATA_USE_REASON_ID, DataUseGate } from './index';

// The full notice and the acknowledge action moved to the Agreement page (`/agreement`). This file covers
// the compact gate that stays in Shell. What the page now owns (full notice content, plain-text rendering,
// the failed-acknowledgement text, the "notice changed" wording, keyboard acknowledgement) is covered in
// src/pages/Agreement.notice.test.tsx, and the page's own behaviour in src/pages/Agreement.test.tsx.

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

/**
 * Stands in for the Agreement page, which owns the acknowledge action. It calls the same provider
 * `acknowledge()` the page calls and shows the provider's error, so the gate can be checked before and
 * after an acknowledgement without the page.
 */
function AcknowledgeDriver() {
  const gate = useDataUseGate();
  return (
    <div>
      <button type="button" onClick={() => { void gate.acknowledge(); }}>Agree through the provider</button>
      <p data-testid="acknowledge-error">{gate.acknowledgeError ?? ''}</p>
    </div>
  );
}

/** Shows where a link in the gate led. */
function LocationProbe() {
  const loc = useLocation();
  return <p data-testid="location">{loc.pathname}</p>;
}

function Harness({ enabled = true, driver = false }: { enabled?: boolean; driver?: boolean }) {
  return (
    <DataUseGateProvider enabled={enabled}>
      <CorePromiseStrip />
      <DataUseGate />
      <Probe />
      <LocationProbe />
      {driver && <AcknowledgeDriver />}
    </DataUseGateProvider>
  );
}

const inputsState = () => screen.getByTestId('inputs-state');
const gateStatus = () => document.querySelector('.clarity-gate-status');
const agreementLink = () => screen.findByRole('link', { name: /Review and agree to the data-use notice/ });
const agreeThroughProvider = () => screen.getByRole('button', { name: 'Agree through the provider' });
const reviewButton = () => screen.getByRole('button', { name: /Review the data-use notice/ });
/** After acknowledgement the card is collapsed to this control, which opens the notice and the analytics control. */
const yourDataButton = () => screen.getByRole('button', { name: 'Your data' });
async function openYourData(user: ReturnType<typeof userEvent.setup>) {
  const button = await screen.findByRole('button', { name: 'Your data' });
  if (button.getAttribute('aria-expanded') !== 'true') await user.click(button);
  expect(button).toHaveAttribute('aria-expanded', 'true');
}

describe('CorePromiseStrip and DataUseGate when the notice is not acknowledged', () => {
  it('shows the connected promise and a compact line to /agreement, and pauses new entries with a reason', async () => {
    mockSettingsApi(buildSettings());
    renderAuthenticated(<Harness />);

    const promise = await screen.findByRole('region', { name: /safe to spend/i });
    for (const word of ['Plan', 'Spending', 'Saving', 'Trips']) {
      expect(within(promise).getByText(`${word}:`)).toBeInTheDocument();
    }
    // Before acknowledgement there is no collapsed control: the compact card is on screen.
    expect(screen.queryByRole('button', { name: 'Your data' })).toBeNull();

    // The full notice and the acknowledge button live on the Agreement page, not in the gate.
    const gate = await screen.findByRole('region', { name: 'Your data, your control' });
    expect(gate).toHaveClass('clarity-gate-compact');
    const link = await agreementLink();
    expect(link).toHaveAttribute('href', '/agreement');
    expect(gate).toHaveTextContent('Review and agree to the data-use notice to add new financial entries.');
    expect(within(gate).queryByRole('heading', { name: /How Project Money uses your data/ })).toBeNull();
    expect(within(gate).queryByRole('heading', { name: 'Salary' })).toBeNull();
    expect(within(gate).queryByRole('button', { name: /Acknowledge version/ })).toBeNull();
    expect(within(gate).queryByRole('button', { name: /I have read this/ })).toBeNull();

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
    expect(within(reason as HTMLElement).getByRole('link', { name: /deleting your account and data/ })).toHaveAttribute('href', '/settings');
  });

  it('leads to /agreement from the compact line', async () => {
    const user = userEvent.setup();
    mockSettingsApi(buildSettings());
    renderAuthenticated(<Harness />);

    await user.click(await agreementLink());

    expect(screen.getByTestId('location')).toHaveTextContent('/agreement');
  });

  it('enables entries and collapses to "Your data" once the provider records an acknowledgement of only the notice version', async () => {
    const user = userEvent.setup();
    const api = mockSettingsApi(buildSettings());
    renderAuthenticated(<Harness driver />);

    await agreementLink();
    await user.click(agreeThroughProvider());

    await waitFor(() => expect(inputsState()).toHaveTextContent('inputs enabled'));
    expect(api.patches()).toHaveLength(1);
    expect(api.patches()[0]?.body).toEqual({ acknowledgedNoticeVersion: 1 });
    // The card collapses to the "Your data" control and the compact line is gone.
    expect(yourDataButton()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: /Review and agree to the data-use notice/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Add expense' })).toBeEnabled();
    expect(document.getElementById(DATA_USE_REASON_ID)).toBeNull();
    // Acknowledging never turns Product Analytics on.
    await openYourData(user);
    expect(screen.getByRole('checkbox', { name: /Product Analytics/ })).not.toBeChecked();
  });

  it('keeps the compact gate and entries paused when the acknowledgement cannot be saved', async () => {
    const user = userEvent.setup();
    mockSettingsApi(buildSettings());
    renderAuthenticated(<Harness driver />);
    await agreementLink();

    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      createApiResponse({ status: 500, body: { error: { code: 'SERVER', message: 'The server had a problem.' } } }),
    );
    await user.click(agreeThroughProvider());

    // The provider reports the failure. The Agreement page shows it as text and offers "Try again"
    // (pages/Agreement.notice.test.tsx).
    await waitFor(() => expect(screen.getByTestId('acknowledge-error')).toHaveTextContent('The server had a problem.'));
    expect(inputsState()).toHaveTextContent('inputs paused');
    expect(screen.getByRole('link', { name: /Review and agree to the data-use notice/ })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Add expense' })).toBeDisabled();
    expect(agreeThroughProvider()).toBeEnabled();
  });

  it('explains why Product Analytics cannot be turned on yet', async () => {
    mockSettingsApi(buildSettings());
    renderAuthenticated(<Harness />);

    await agreementLink();
    const toggle = screen.getByRole('checkbox', { name: /Product Analytics/ });
    expect(toggle).toBeDisabled();
    expect(toggle).not.toBeChecked();
    expect(toggle).toHaveAccessibleDescription(/Acknowledge the data-use notice to turn it on/);
  });

  it('shows the compact line when a command is rejected with 428 after an acknowledged state', async () => {
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
    // The gate points to /agreement. The "notice changed" wording is on that page
    // (pages/Agreement.notice.test.tsx).
    expect(await agreementLink()).toHaveAttribute('href', '/agreement');
    expect(document.getElementById(DATA_USE_REASON_ID)).toHaveTextContent(/acknowledge the data-use notice/i);
    expect(api.patches()).toHaveLength(0);
  });
});

describe('CorePromiseStrip', () => {
  it('is one short line with a "How it works" disclosure for the four parts, rendered before the controls', async () => {
    const user = userEvent.setup();
    mockSettingsApi(buildSettings({ acknowledgedVersion: 1 }));
    const { container } = renderAuthenticated(<Harness />);

    const promise = await screen.findByRole('region', { name: /safe to spend/i });
    expect(within(promise).getByRole('heading', { name: 'See what is safe to spend, what to save, and what to do next.' })).toBeInTheDocument();
    const toggle = within(promise).getByRole('button', { name: 'How it works' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // The four connected parts and the lead sentence are in the page but not on screen until asked for.
    const lead = within(promise).getByText(/connects four parts of your money/);
    const plan = within(promise).getByText('Plan:');
    expect(lead).not.toBeVisible();
    expect(plan).not.toBeVisible();

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(lead).toBeVisible();
    for (const word of ['Plan', 'Spending', 'Saving', 'Trips']) expect(within(promise).getByText(`${word}:`)).toBeVisible();
    await user.click(toggle);
    expect(plan).not.toBeVisible();

    // It still comes before the financial controls (Requirement 1.1).
    const addExpense = screen.getByRole('button', { name: 'Add expense' });
    expect(promise.compareDocumentPosition(addExpense) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelectorAll('.clarity-promise')).toHaveLength(1);
  });

  it('is operated by keyboard', async () => {
    const user = userEvent.setup();
    mockSettingsApi(buildSettings({ acknowledgedVersion: 1 }));
    renderAuthenticated(<Harness />);
    const toggle = await screen.findByRole('button', { name: 'How it works' });

    await user.tab();
    expect(toggle).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard(' ');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('DataUseGate when the notice is acknowledged', () => {
  it('enables entries, keeps the notice reviewable, and stores only a promise flag', async () => {
    const user = userEvent.setup();
    const authenticated = createTestUser();
    mockSettingsApi(buildSettings({ acknowledgedVersion: 1 }));
    renderAuthenticated(<Harness />, { user: authenticated });

    await waitFor(() => expect(inputsState()).toHaveTextContent('inputs enabled'));
    expect(document.getElementById(DATA_USE_REASON_ID)).toBeNull();
    expect(screen.queryByRole('button', { name: /Acknowledge version/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /Review and agree to the data-use notice/ })).toBeNull();

    // Collapsed: only a small "Your data" control is on screen. The full card is not.
    const gate = screen.getByRole('region', { name: 'Your data, your control' });
    expect(gate).toHaveAttribute('data-collapsed', 'true');
    expect(yourDataButton()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText(/You acknowledged the data-use notice \(version 1\) on 10 Jan 2026/)).not.toBeVisible();
    expect(screen.queryByRole('checkbox', { name: /Product Analytics/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Review the data-use notice/ })).toBeNull();

    // It opens the acknowledgement summary, the notice, and the Product Analytics control.
    await user.click(yourDataButton());
    expect(yourDataButton()).toHaveAttribute('aria-expanded', 'true');
    expect(gate).toHaveAttribute('data-collapsed', 'false');
    expect(screen.getByText(/You acknowledged the data-use notice \(version 1\) on 10 Jan 2026/)).toBeVisible();
    expect(screen.getByRole('checkbox', { name: /Product Analytics/ })).toBeVisible();
    // Correction, export, and deletion stay discoverable from the notice.
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
    await waitFor(() => expect(inputsState()).toHaveTextContent('inputs enabled'));
    await openYourData(user);
    const toggle = screen.getByRole('checkbox', { name: /Product Analytics/ });

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
    await agreementLink();
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
    await openYourData(user);
    const toggle = screen.getByRole('checkbox', { name: /Product Analytics/ });
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
  it('reaches every control of the compact required state in reading order, and follows the link', async () => {
    const user = userEvent.setup();
    mockSettingsApi(buildSettings());
    renderAuthenticated(<Harness />);
    await agreementLink();

    // Reading order: the promise's "How it works" control, the link to /agreement, then the
    // still-available links. The analytics checkbox and "Add expense" are disabled, so they are skipped.
    await user.tab();
    expect(screen.getByRole('button', { name: 'How it works' })).toHaveFocus();
    await user.tab();
    const link = screen.getByRole('link', { name: /Review and agree to the data-use notice/ });
    expect(link).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('link', { name: /exporting your data/ })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('link', { name: /deleting your account and data/ })).toHaveFocus();

    // Enter on the link goes to the Agreement page, where the acknowledge flow is operated by keyboard
    // (pages/Agreement.notice.test.tsx).
    link.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('location')).toHaveTextContent('/agreement');
  });

  it('reaches and operates every control of the acknowledged state in reading order without a pointer', async () => {
    const user = userEvent.setup();
    mockSettingsApi(buildSettings({ acknowledgedVersion: 1 }));
    renderAuthenticated(<Harness />);
    await waitFor(() => expect(inputsState()).toHaveTextContent('inputs enabled'));
    expect(yourDataButton()).toHaveAttribute('aria-expanded', 'false');

    await user.tab();
    expect(screen.getByRole('button', { name: 'How it works' })).toHaveFocus();
    await user.tab();
    expect(yourDataButton()).toHaveFocus();

    // Enter opens it and focus stays on it. The next stops are the notice disclosure, then the
    // Product Analytics checkbox. Nothing traps focus.
    await user.keyboard('{Enter}');
    expect(yourDataButton()).toHaveAttribute('aria-expanded', 'true');
    expect(yourDataButton()).toHaveFocus();
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
  it.each(['light', 'dark'] as const)('has no axe violations in %s theme (compact required and acknowledged)', async (theme) => {
    document.documentElement.dataset.theme = theme;
    try {
      const user = userEvent.setup();
      mockSettingsApi(buildSettings());
      const view = renderAuthenticated(<Harness driver />);

      await agreementLink();
      expect(await axe(view.container)).toHaveNoViolations();

      await user.click(agreeThroughProvider());
      await waitFor(() => expect(inputsState()).toHaveTextContent('inputs enabled'));
      // Collapsed to the "Your data" control.
      expect(await axe(view.container)).toHaveNoViolations();
      await openYourData(user);
      await user.click(reviewButton());
      expect(await axe(view.container)).toHaveNoViolations();
    } finally {
      delete document.documentElement.dataset.theme;
    }
  });
});

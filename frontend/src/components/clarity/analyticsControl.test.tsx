import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DataUseGateProvider } from '../../clarity/DataUseGateProvider';
import { measurement } from '../../clarity/measurement';
import type { ClaritySettings } from '../../clarity/settings';
import { buildSettings, mockSettingsApi } from '../../test/dataUseFixtures';
import { axe, createApiResponse, renderAuthenticated } from '../../test/test-utils';
import { AnalyticsControl } from './AnalyticsControl';

function Harness({ enabled = true }: { enabled?: boolean }) {
  return (
    <DataUseGateProvider enabled={enabled}>
      <AnalyticsControl />
    </DataUseGateProvider>
  );
}

/** Resolves once the settings have loaded, so the checkbox shows the confirmed state. */
async function checkbox() {
  const toggle = await screen.findByRole('checkbox', { name: 'Send product usage events' });
  await waitFor(() => expect(screen.queryByText(/Available once your settings load/)).toBeNull());
  return toggle;
}

function eventCalls() {
  return vi.mocked(globalThis.fetch).mock.calls.filter(([url]) => String(url).endsWith('/api/clarity/events'));
}

beforeEach(() => {
  vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'true');
});

afterEach(() => {
  measurement.setAnalyticsConsent(false);
});

describe('AnalyticsControl on Settings', () => {
  it('renders nothing while the financial clarity rollout is off', () => {
    renderAuthenticated(<Harness enabled={false} />);
    expect(screen.queryByRole('heading', { name: /Product Analytics/ })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('is off by default, explains what it never includes, and sends no events', async () => {
    mockSettingsApi(buildSettings({ acknowledgedVersion: 1 }));
    renderAuthenticated(<Harness />);

    const toggle = await checkbox();
    expect(toggle).not.toBeChecked();
    expect(toggle).toBeEnabled();
    expect(toggle).toHaveAccessibleDescription(/It never includes financial amounts, free-text notes/);
    expect(measurement.getAnalyticsConsent()).toBe(false);

    measurement.journeyStarted({ journeyId: 3, desiredOutcome: 'plan_month' });
    expect(eventCalls()).toHaveLength(0);
  });

  it('turning it on sends the typed events, and turning it off keeps records and the notice unchanged', async () => {
    const user = userEvent.setup();
    const api = mockSettingsApi(buildSettings({ acknowledgedVersion: 1 }));
    const view = renderAuthenticated(<Harness />);

    await user.click(await checkbox());
    await waitFor(() => expect(measurement.getAnalyticsConsent()).toBe(true));
    expect(api.patches().map((call) => call.body)).toEqual([{ analyticsEnabled: true }]);

    measurement.firstOutcomeDisplayed({ journeyId: 3, outcomeKind: 'monthly_plan' });
    await waitFor(() => expect(eventCalls()).toHaveLength(1));
    const [url, init] = eventCalls()[0] ?? [];
    expect(String(url)).toMatch(/\/api\/clarity\/events$/);
    expect(JSON.parse(String(init?.body))).toEqual({
      event: 'first_outcome_displayed',
      journeyId: 3,
      outcomeKind: 'monthly_plan',
      occurredAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/),
    });

    await user.click(await checkbox());
    await waitFor(() => expect(measurement.getAnalyticsConsent()).toBe(false));
    // Only the analytics flag was sent. The notice acknowledgement is not part of the request.
    expect(api.patches().map((call) => call.body)).toEqual([
      { analyticsEnabled: true },
      { analyticsEnabled: false },
    ]);
    expect(view.container.querySelector('.clarity-gate-status')).toHaveTextContent('Your records and results are unchanged');

    measurement.journeyStarted({ journeyId: 3, desiredOutcome: 'plan_month' });
    expect(eventCalls()).toHaveLength(1);
  });

  it('starts sending when settings already confirm analytics is on', async () => {
    mockSettingsApi(buildSettings({ acknowledgedVersion: 1, analyticsEnabled: true }));
    renderAuthenticated(<Harness />);
    expect(await checkbox()).toBeChecked();
    expect(measurement.getAnalyticsConsent()).toBe(true);
    measurement.clarityResponse({ journeyId: 3, response: 'partly' });
    await waitFor(() => expect(eventCalls()).toHaveLength(1));
  });

  it('stops sending as soon as an opt-out is requested, before the server confirms', async () => {
    const user = userEvent.setup();
    let patchStarted = false;
    let confirmPatch: (response: Response) => void = () => {};
    const settings: ClaritySettings = buildSettings({ acknowledgedVersion: 1, analyticsEnabled: true });
    vi.mocked(globalThis.fetch).mockImplementation((input, init) => {
      if (!String(input).endsWith('/api/clarity/settings')) {
        return Promise.resolve(createApiResponse({ body: {}, status: 204 }));
      }
      if ((init?.method ?? 'GET') === 'GET') return Promise.resolve(createApiResponse({ body: settings }));
      return new Promise<Response>((resolve) => {
        patchStarted = true;
        confirmPatch = resolve;
      });
    });
    renderAuthenticated(<Harness />);

    await user.click(await checkbox());
    await waitFor(() => expect(patchStarted).toBe(true));
    // The PATCH is still pending, and sending has already stopped.
    expect(measurement.getAnalyticsConsent()).toBe(false);
    measurement.clarityResponse({ journeyId: 3, response: 'yes' });
    expect(eventCalls()).toHaveLength(0);

    const next = structuredClone(settings);
    next.productAnalytics.enabled = false;
    next.productAnalytics.consentVersion = null;
    await act(async () => { confirmPatch(createApiResponse({ body: next })); });
    await waitFor(() => expect(screen.getByRole('checkbox')).not.toBeChecked());
    expect(measurement.getAnalyticsConsent()).toBe(false);
  });

  it('cannot be turned on until the current notice is acknowledged, and stays independent of it', async () => {
    mockSettingsApi(buildSettings());
    renderAuthenticated(<Harness />);

    const toggle = await checkbox();
    expect(toggle).toBeDisabled();
    expect(screen.getByText('Acknowledge the data-use notice to turn it on.')).toBeInTheDocument();
    expect(measurement.getAnalyticsConsent()).toBe(false);
  });

  it('lets a user turn analytics off even when the notice needs acknowledgement again', async () => {
    const user = userEvent.setup();
    const settings = buildSettings({ analyticsEnabled: true });
    mockSettingsApi(settings);
    renderAuthenticated(<Harness />);

    const toggle = await checkbox();
    expect(toggle).toBeChecked();
    expect(toggle).toBeEnabled();
    await user.click(toggle);
    await waitFor(() => expect(screen.getByRole('checkbox')).not.toBeChecked());
    expect(measurement.getAnalyticsConsent()).toBe(false);
  });

  it('turns measurement off when the user signs out (the provider unmounts)', async () => {
    mockSettingsApi(buildSettings({ acknowledgedVersion: 1, analyticsEnabled: true }));
    const view = renderAuthenticated(<Harness />);
    await checkbox();
    expect(measurement.getAnalyticsConsent()).toBe(true);

    view.unmount();
    expect(measurement.getAnalyticsConsent()).toBe(false);
  });

  it('has no accessibility violations', async () => {
    mockSettingsApi(buildSettings({ acknowledgedVersion: 1 }));
    const view = renderAuthenticated(<Harness />);
    await checkbox();
    expect(await axe(view.container)).toHaveNoViolations();
  });
});

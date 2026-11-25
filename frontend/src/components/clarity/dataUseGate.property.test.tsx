import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgreementGateProvider, useAgreementGate } from '../../clarity/AgreementGateProvider';
import { DataUseGateProvider, PROMISE_RENDERED_KEY } from '../../clarity/DataUseGateProvider';
import type { ClaritySettings } from '../../clarity/settings';
import { buildSettings } from '../../test/claritySettingsBuilder';
import { assertProperty } from '../../test/propertyReport';
import { createApiResponse, fc, renderAuthenticated } from '../../test/test-utils';
import { DATA_USE_REASON_ID, DataUseGate } from './DataUseGate';

/**
 * Feature: data-use-agreement-page, Property 10: The paused-entries explanation always links to the Agreement_Page
 *
 * **Validates: Requirements 4.1, 4.3**
 *
 * The compact DataUseGate is rendered through the real DataUseGateProvider and
 * AgreementGateProvider inside the harness MemoryRouter. Only the settings
 * response differs per scenario. In the `required` state (with or without the
 * Not_Now_Choice) the reason block carries DATA_USE_REASON_ID and the card links
 * to /agreement. The other states that also report a reason (loading, error, and
 * acknowledged before the promise is shown) keep their reason text but have no
 * agreement to review, so they never link to /agreement.
 */

type ReasonStatus = 'required' | 'loading' | 'error' | 'acknowledgedPromiseUnseen';

interface Scenario {
  status: ReasonStatus;
  notNow: boolean;
  version: number;
  priorAcknowledgedVersion: number;
  analyticsEnabled: boolean;
}

const scenarioArb: fc.Arbitrary<Scenario> = fc
  .record({
    status: fc.constantFrom<ReasonStatus>('required', 'required', 'required', 'loading', 'error', 'acknowledgedPromiseUnseen'),
    notNow: fc.boolean(),
    version: fc.integer({ min: 1, max: 6 }),
    priorAcknowledgedVersion: fc.integer({ min: 0, max: 5 }),
    analyticsEnabled: fc.boolean(),
  })
  .map((scenario) => ({
    ...scenario,
    priorAcknowledgedVersion: Math.min(scenario.priorAcknowledgedVersion, scenario.version - 1),
  }));

function settingsFor(scenario: Scenario): ClaritySettings {
  const base = buildSettings({ acknowledgedVersion: 0, analyticsEnabled: scenario.analyticsEnabled });
  if (scenario.status === 'acknowledgedPromiseUnseen') {
    return buildSettings({ acknowledgedVersion: 1, analyticsEnabled: scenario.analyticsEnabled });
  }
  const acknowledged = scenario.priorAcknowledgedVersion >= 1;
  return {
    ...base,
    dataUseNotice: {
      ...base.dataUseNotice,
      version: scenario.version,
      acknowledgedVersion: scenario.priorAcknowledgedVersion,
      acknowledgedAt: acknowledged ? '2026-01-10T05:00:00.000Z' : null,
      acknowledgementRequired: true,
    },
  };
}

function expectedReason(scenario: Scenario): string {
  switch (scenario.status) {
    case 'required':
      return `Review and acknowledge the data-use notice (version ${scenario.version}) to add new financial entries.`;
    case 'loading':
      return 'Checking your data-use settings.';
    case 'error':
      return 'Your data-use status could not be confirmed. Retry to continue.';
    default:
      return 'Read the Project Money promise first, then new entries turn on.';
  }
}

function installNetwork(scenario: Scenario): void {
  vi.mocked(globalThis.fetch).mockImplementation(async () => {
    if (scenario.status === 'loading') return new Promise<Response>(() => {});
    if (scenario.status === 'error') {
      return createApiResponse({
        status: 403,
        body: { error: { code: 'FORBIDDEN', message: 'Settings are unavailable.' } },
      });
    }
    return createApiResponse({ body: settingsFor(scenario) });
  });
}

function ChooseNotNow() {
  const { setNotNow } = useAgreementGate();
  useEffect(() => {
    setNotNow();
  }, [setNotNow]);
  return null;
}

async function checkScenario(scenario: Scenario): Promise<void> {
  installNetwork(scenario);
  try {
    renderAuthenticated(
      <DataUseGateProvider enabled>
        <AgreementGateProvider>
          {scenario.notNow ? <ChooseNotNow /> : null}
          <DataUseGate />
        </AgreementGateProvider>
      </DataUseGateProvider>,
    );

    const reasonText = expectedReason(scenario);
    const section = screen.getByRole('region', { name: 'Your data, your control' });
    await waitFor(() => {
      const reason = section.querySelector(`#${DATA_USE_REASON_ID}`);
      expect(reason).not.toBeNull();
      expect(reason).toHaveTextContent(reasonText);
    });

    const reason = section.querySelector(`#${DATA_USE_REASON_ID}`) as HTMLElement;
    expect(reason).toHaveTextContent('New entries are paused.');

    const agreementLinks = within(section)
      .queryAllByRole('link')
      .filter((link) => link.getAttribute('href') === '/agreement');

    if (scenario.status === 'required') {
      expect(agreementLinks.length).toBeGreaterThanOrEqual(1);
      // The link and the reason are in the same compact card.
      expect(agreementLinks[0]?.closest('section')).toBe(reason.closest('section'));
    } else {
      expect(agreementLinks).toHaveLength(0);
    }
  } finally {
    cleanup();
  }
}

describe('Property 10: The paused-entries explanation always links to the Agreement_Page', () => {
  beforeEach(() => {
    sessionStorage.removeItem(PROMISE_RENDERED_KEY);
  });

  it('shows the DATA_USE_REASON_ID reason, and a /agreement link whenever the notice is required, for any notNow', async () => {
    await assertProperty(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        await checkScenario(scenario);
      }),
    );
  }, 180_000);

  it('links to /agreement in the required state with the Not_Now_Choice true', async () => {
    await checkScenario({
      status: 'required',
      notNow: true,
      version: 1,
      priorAcknowledgedVersion: 0,
      analyticsEnabled: false,
    });
  }, 30_000);
});

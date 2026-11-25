import { cleanup, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { buildSettings } from '../test/claritySettingsBuilder';
import { assertProperty } from '../test/propertyReport';
import { createApiResponse, fc, renderAuthenticated } from '../test/test-utils';
import { AgreementGateProvider, useAgreementGate } from './AgreementGateProvider';
import { DataUseGateProvider, useDataUseGate, type DataUseGateStatus } from './DataUseGateProvider';

/**
 * Feature: data-use-agreement-page, Property 7: Entries are never enabled while the notice is required
 *
 * **Validates: Requirements 3.4**
 *
 * Every (status, notNow) combination is rendered through the real
 * DataUseGateProvider and AgreementGateProvider. Only the network response
 * differs per status: a pending request is `loading`, a 403 is `error`, and a
 * settings body with or without an acknowledged notice is `acknowledged` or
 * `required`. `disabled` comes from the provider's `enabled` override.
 */

const STATUSES: readonly DataUseGateStatus[] = ['disabled', 'loading', 'error', 'required', 'acknowledged'];

interface Scenario {
  status: DataUseGateStatus;
  notNow: boolean;
  analyticsEnabled: boolean;
}

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  status: fc.constantFrom(...STATUSES),
  notNow: fc.boolean(),
  analyticsEnabled: fc.boolean(),
});

function installNetwork({ status, analyticsEnabled }: Scenario): void {
  vi.mocked(globalThis.fetch).mockImplementation(async () => {
    if (status === 'loading') return new Promise<Response>(() => {});
    if (status === 'error') {
      return createApiResponse({
        status: 403,
        body: { error: { code: 'FORBIDDEN', message: 'Settings are unavailable.' } },
      });
    }
    return createApiResponse({
      body: buildSettings({ acknowledgedVersion: status === 'acknowledged' ? 1 : 0, analyticsEnabled }),
    });
  });
}

function ChooseNotNow() {
  const { setNotNow } = useAgreementGate();
  useEffect(() => {
    setNotNow();
  }, [setNotNow]);
  return null;
}

function Probe() {
  const gate = useDataUseGate();
  const { notNow } = useAgreementGate();
  return (
    <div>
      <p data-testid="status">{gate.status}</p>
      <p data-testid="not-now">{String(notNow)}</p>
      <p data-testid="inputs-enabled">{String(gate.financialInputsEnabled)}</p>
    </div>
  );
}

/** Renders one scenario and returns what the provider reported once it settled. */
async function observe(scenario: Scenario): Promise<{ status: string; notNow: string; inputsEnabled: string }> {
  installNetwork(scenario);
  renderAuthenticated(
    <DataUseGateProvider enabled={scenario.status !== 'disabled'}>
      <AgreementGateProvider>
        {scenario.notNow ? <ChooseNotNow /> : null}
        <Probe />
      </AgreementGateProvider>
    </DataUseGateProvider>,
  );
  await waitFor(() => {
    expect(screen.getByTestId('status')).toHaveTextContent(scenario.status);
    expect(screen.getByTestId('not-now')).toHaveTextContent(String(scenario.notNow));
  });
  return {
    status: screen.getByTestId('status').textContent ?? '',
    notNow: screen.getByTestId('not-now').textContent ?? '',
    inputsEnabled: screen.getByTestId('inputs-enabled').textContent ?? '',
  };
}

async function checkScenario(scenario: Scenario): Promise<void> {
  try {
    const seen = await observe(scenario);
    expect(seen.status).toBe(scenario.status);
    expect(seen.notNow).toBe(String(scenario.notNow));
    if (seen.status === 'required') expect(seen.inputsEnabled).toBe('false');
  } finally {
    cleanup();
  }
}

describe('Property 7: Entries are never enabled while the notice is required', () => {
  it('reports financialInputsEnabled false whenever status is required, for any notNow', async () => {
    await assertProperty(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        await checkScenario(scenario);
      }),
    );
  }, 120_000);

  it('covers every (status, notNow) combination at least once', async () => {
    for (const status of STATUSES) {
      for (const notNow of [false, true]) {
        await checkScenario({ status, notNow, analyticsEnabled: false });
      }
    }
  }, 60_000);
});

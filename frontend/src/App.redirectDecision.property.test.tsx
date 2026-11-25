import { cleanup, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AgreementRedirect, isExemptRoute } from './App';
import { AgreementGateProvider, useAgreementGate } from './clarity/AgreementGateProvider';
import { DataUseGateProvider, useDataUseGate } from './clarity/DataUseGateProvider';
import { buildSettings } from './test/claritySettingsBuilder';
import { assertProperty } from './test/propertyReport';
import { createApiResponse, fc, renderAuthenticated } from './test/test-utils';

// The redirect decision does not depend on what Shell renders, so Shell is a marker here. Everything that
// decides the redirect (App's AgreementRedirect, the real DataUseGateProvider and AgreementGateProvider, and
// the router) is real.
vi.mock('./components/Shell', () => ({
  Shell: () => <div data-testid="shell" />,
}));

/**
 * Feature: data-use-agreement-page, Property 1: The redirect decision is exactly required AND not exempt AND not Not_Now_Choice AND rollout enabled
 *
 * **Validates: Requirements 1.1, 1.5, 6.1**
 *
 * Every (status, pathname, notNow, rolloutEnabled) combination is rendered at the generated location. The
 * redirect is observed through the router: the location becomes /agreement and carries the attempted location
 * in `state.from`. The page at /agreement is a marker, because the route itself is registered by a later task.
 * Only the network response differs per status: a pending request is `loading`, a 403 is `error`, and a settings
 * body with or without an acknowledged notice is `acknowledged` or `required`. With the rollout off the provider
 * tree must report `disabled`.
 */

type NetworkStatus = 'loading' | 'error' | 'required' | 'acknowledged';

const NETWORK_STATUSES: readonly NetworkStatus[] = ['loading', 'error', 'required', 'acknowledged'];

const EXEMPT_PATHS = ['/settings', '/agreement', '/admin', '/admin/users', '/admin/feedback', '/admin/x'];
const NON_EXEMPT_PATHS = [
  '/', '/spending', '/plan', '/goals', '/trips', '/trips/7', '/recurring', '/arcade', '/start',
  '/settings/x', '/administrator', '/agreement/x',
];
const SEARCHES = ['', '?month=2026-01', '?start=save'];

interface Scenario {
  status: NetworkStatus;
  pathname: string;
  search: string;
  notNow: boolean;
  rolloutEnabled: boolean;
}

const segmentArb = fc.constantFrom('a', 'spending', 'admin', 'settings', 'agreement', 'x1');
const pathnameArb: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(...EXEMPT_PATHS, ...NON_EXEMPT_PATHS),
  fc.array(segmentArb, { minLength: 1, maxLength: 3 }).map((segments) => `/${segments.join('/')}`),
);

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  status: fc.constantFrom(...NETWORK_STATUSES),
  pathname: pathnameArb,
  search: fc.constantFrom(...SEARCHES),
  notNow: fc.boolean(),
  rolloutEnabled: fc.boolean(),
});

/** The exempt routes listed in the requirements, written out independently of isExemptRoute. */
function exemptBySpec(pathname: string): boolean {
  return pathname === '/settings' || pathname === '/agreement' || pathname === '/admin' || pathname.startsWith('/admin/');
}

/** The decision under test, written from the property statement. */
function expectedRedirect({ status, pathname, notNow, rolloutEnabled }: Scenario): boolean {
  return rolloutEnabled && status === 'required' && !isExemptRoute(pathname) && !notNow;
}

function installNetwork({ status }: Scenario): void {
  vi.mocked(globalThis.fetch).mockImplementation(async () => {
    if (status === 'loading') return new Promise<Response>(() => {});
    if (status === 'error') {
      return createApiResponse({
        status: 403,
        body: { error: { code: 'FORBIDDEN', message: 'Settings are unavailable.' } },
      });
    }
    return createApiResponse({ body: buildSettings({ acknowledgedVersion: status === 'acknowledged' ? 1 : 0 }) });
  });
}

function ChooseNotNow() {
  const { setNotNow } = useAgreementGate();
  useEffect(() => {
    setNotNow();
  }, [setNotNow]);
  return null;
}

/** Reports the gate status, the Not_Now_Choice, and the router location the tree settled on. */
function Probe() {
  const gate = useDataUseGate();
  const { notNow } = useAgreementGate();
  const loc = useLocation();
  const from = (loc.state as { from?: { pathname: string; search: string } } | null)?.from;
  return (
    <div>
      <p data-testid="status">{gate.status}</p>
      <p data-testid="not-now">{String(notNow)}</p>
      <p data-testid="pathname">{loc.pathname}</p>
      <p data-testid="from">{from ? `${from.pathname}${from.search}` : 'none'}</p>
    </div>
  );
}

interface Observation {
  status: string;
  pathname: string;
  from: string;
  agreementPage: boolean;
  shell: boolean;
}

async function observe(scenario: Scenario): Promise<Observation> {
  installNetwork(scenario);
  const effectiveStatus = scenario.rolloutEnabled ? scenario.status : 'disabled';
  renderAuthenticated(
    <DataUseGateProvider enabled={scenario.rolloutEnabled}>
      <AgreementGateProvider>
        {scenario.notNow ? <ChooseNotNow /> : null}
        <Probe />
        <Routes>
          <Route path="/agreement" element={<div data-testid="agreement-page" />} />
          <Route path="*" element={<AgreementRedirect />} />
        </Routes>
      </AgreementGateProvider>
    </DataUseGateProvider>,
    { route: `${scenario.pathname}${scenario.search}` },
  );
  await waitFor(() => {
    expect(screen.getByTestId('status')).toHaveTextContent(effectiveStatus);
    expect(screen.getByTestId('not-now')).toHaveTextContent(String(scenario.notNow));
  });
  // The redirect is an effect of the render that reported the settled status, so the location is final here.
  if (expectedRedirect(scenario)) {
    await waitFor(() => expect(screen.getByTestId('pathname')).toHaveTextContent('/agreement'));
  }
  return {
    status: screen.getByTestId('status').textContent ?? '',
    pathname: screen.getByTestId('pathname').textContent ?? '',
    from: screen.getByTestId('from').textContent ?? '',
    agreementPage: screen.queryByTestId('agreement-page') !== null,
    shell: screen.queryByTestId('shell') !== null,
  };
}

async function checkScenario(scenario: Scenario): Promise<void> {
  try {
    const seen = await observe(scenario);
    expect(isExemptRoute(scenario.pathname)).toBe(exemptBySpec(scenario.pathname));
    // The rollout flag off always means a disabled gate, so no redirect.
    if (!scenario.rolloutEnabled) expect(seen.status).toBe('disabled');

    if (expectedRedirect(scenario)) {
      expect(seen.pathname).toBe('/agreement');
      expect(seen.from).toBe(`${scenario.pathname}${scenario.search}`);
      expect(seen.agreementPage).toBe(true);
      expect(seen.shell).toBe(false);
    } else {
      // No redirect: the location is untouched and carries no Intended_Destination.
      expect(seen.pathname).toBe(scenario.pathname);
      expect(seen.from).toBe('none');
      expect(seen.agreementPage).toBe(scenario.pathname === '/agreement');
      expect(seen.shell).toBe(scenario.pathname !== '/agreement');
    }
  } finally {
    cleanup();
  }
}

describe('Property 1: The redirect decision is exactly required AND not exempt AND not Not_Now_Choice AND rollout enabled', () => {
  it('redirects to /agreement with the attempted location exactly when the decision holds', async () => {
    await assertProperty(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        await checkScenario(scenario);
      }),
    );
  }, 180_000);

  it('covers every (status, notNow, rolloutEnabled) combination on exempt and non-exempt pathnames', async () => {
    const pathnames = ['/spending', '/trips/7', '/settings', '/admin/users', '/agreement'];
    for (const status of NETWORK_STATUSES) {
      for (const notNow of [false, true]) {
        for (const rolloutEnabled of [false, true]) {
          for (const pathname of pathnames) {
            await checkScenario({ status, pathname, search: '', notNow, rolloutEnabled });
          }
        }
      }
    }
  }, 180_000);
});

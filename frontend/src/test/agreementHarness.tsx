import { vi } from 'vitest';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AgreementGateProvider, useAgreementGate } from '../clarity/AgreementGateProvider';
import { DataUseGateProvider } from '../clarity/DataUseGateProvider';
import type { ClaritySettings } from '../clarity/settings';
import { Agreement } from '../pages/Agreement';
import type { User } from '../types';
import { createApiResponse, renderAuthenticated, type HarnessRenderResult } from './test-utils';

// Shared by the Agreement page property and example tests. The page, both providers, the router, and the
// settings client are real. Only the network is replaced, with a small in-memory stand-in for
// GET/PATCH /api/clarity/settings.

export interface AgreementNetworkPlan {
  /** The settings the server returns. For the page to show anything its notice must require acknowledgement. */
  settings: ClaritySettings;
  /** `pending` never answers, `error` answers 403. Defaults to `ok`. */
  get?: 'ok' | 'pending' | 'error';
  /** `fail` answers 500, `hold` waits for `release()`. Defaults to `ok`. */
  patch?: 'ok' | 'fail' | 'hold';
}

export interface AgreementNetwork {
  calls: { method: string; url: string; body: unknown }[];
  patches: () => unknown[];
  gets: () => number;
  /** Lets a held PATCH answer. */
  release: () => void;
}

function acknowledged(settings: ClaritySettings): ClaritySettings {
  const next = structuredClone(settings);
  next.dataUseNotice.acknowledgedVersion = next.dataUseNotice.version;
  next.dataUseNotice.acknowledgedAt = '2026-01-15T06:30:00.000Z';
  next.dataUseNotice.acknowledgementRequired = false;
  return next;
}

export function installAgreementNetwork(plan: AgreementNetworkPlan): AgreementNetwork {
  const calls: AgreementNetwork['calls'] = [];
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });

  vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body });
    if (!url.endsWith('/api/clarity/settings')) return createApiResponse({ body: {} });
    if (method === 'GET') {
      if (plan.get === 'pending') return new Promise<Response>(() => {});
      if (plan.get === 'error') {
        return createApiResponse({
          status: 403,
          body: { error: { code: 'FORBIDDEN', message: 'Settings are unavailable.' } },
        });
      }
      return createApiResponse({ body: plan.settings });
    }
    if (plan.patch === 'hold') await held;
    if (plan.patch === 'fail') {
      return createApiResponse({
        status: 500,
        body: { error: { code: 'SERVER_ERROR', message: 'Could not save your acknowledgement.' } },
      });
    }
    return createApiResponse({ body: acknowledged(plan.settings) });
  });

  return {
    calls,
    patches: () => calls.filter((call) => call.method === 'PATCH').map((call) => call.body),
    gets: () => calls.filter((call) => call.method === 'GET').length,
    release: () => release(),
  };
}

/** Where the router is and whether Not_Now_Choice is set, whatever route is showing. */
function Probe() {
  const loc = useLocation();
  const { notNow } = useAgreementGate();
  return (
    <div>
      <p data-testid="location">{`${loc.pathname}${loc.search}`}</p>
      <p data-testid="not-now">{String(notNow)}</p>
    </div>
  );
}

export interface RecordedFrom {
  pathname: string;
  search?: string;
}

export interface RenderAgreementOptions {
  /** The Intended_Destination the redirect would have recorded. Omit for no recorded destination. */
  from?: RecordedFrom;
  user?: User;
}

/**
 * Reaches /agreement the way the app does: a redirect from another route carrying `state.from`. Any other route
 * renders a marker, so `location` shows where the page sent the user.
 */
export function renderAgreement({ from, user }: RenderAgreementOptions = {}): HarnessRenderResult {
  return renderAuthenticated(
    <DataUseGateProvider enabled>
      <AgreementGateProvider>
        <Probe />
        <Routes>
          <Route path="/origin" element={<Navigate to="/agreement" replace state={from ? { from } : null} />} />
          <Route path="/agreement" element={<Agreement />} />
          <Route path="*" element={<p data-testid="landed">Landed</p>} />
        </Routes>
      </AgreementGateProvider>
    </DataUseGateProvider>,
    { route: '/origin', user },
  );
}

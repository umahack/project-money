import { vi } from 'vitest';
import type { ClaritySettings } from '../clarity/settings';
import { createApiResponse } from './test-utils';

// The builder has no test-runner dependency, so Playwright specs import it directly.
export { buildSettings } from './claritySettingsBuilder';

export interface RecordedCall { method: string; url: string; body: unknown }

/** A small in-memory stand-in for GET/PATCH /api/clarity/settings, including the 428 rule. */
export function mockSettingsApi(initial: ClaritySettings, { failGet }: { failGet?: () => boolean } = {}) {
  let state = initial;
  const calls: RecordedCall[] = [];
  vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body });
    if (!url.endsWith('/api/clarity/settings')) return createApiResponse({ body: {} });
    if (method === 'GET') {
      if (failGet?.()) return createApiResponse({ status: 403, body: { error: { code: 'FORBIDDEN', message: 'Settings are unavailable.' } } });
      return createApiResponse({ body: state });
    }
    const next = structuredClone(state);
    if (body.acknowledgedNoticeVersion === 1) {
      next.dataUseNotice.acknowledgedVersion = 1;
      next.dataUseNotice.acknowledgedAt = '2026-01-15T06:30:00.000Z';
      next.dataUseNotice.acknowledgementRequired = false;
    }
    if (typeof body.analyticsEnabled === 'boolean') {
      if (body.analyticsEnabled && next.dataUseNotice.acknowledgementRequired) {
        return createApiResponse({
          status: 428,
          body: { error: { code: 'DATA_NOTICE_REQUIRED', message: 'Acknowledge the notice first.' } },
        });
      }
      next.productAnalytics.enabled = body.analyticsEnabled;
      next.productAnalytics.consentVersion = body.analyticsEnabled ? 1 : null;
    }
    state = next;
    return createApiResponse({ body: state });
  });
  return { calls, patches: () => calls.filter((call) => call.method === 'PATCH') };
}

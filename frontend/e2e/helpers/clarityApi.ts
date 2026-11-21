import type { DeterministicApiFixtures, RecordedApiRequest } from '../fixtures/test';
import { buildSettings } from '../../src/test/claritySettingsBuilder';
import { FakeClarityBackend, type FakeBackendInit } from '../../src/test/fakeClarityBackend';

/** The month the browser renders: Asia/Kolkata, as configured for every Playwright project. */
export function currentMonthInIndia(): string {
  const parts = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  if (!year || !month) throw new Error('Unable to derive the isolated fixture month.');
  return `${year}-${month}`;
}

/** The label the app shows for a month, such as "November 2026". */
export function monthName(month: string): string {
  const [year, number] = month.split('-').map(Number) as [number, number];
  return new Date(year, number - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
}

export interface ClarityBackendControl {
  backend: FakeClarityBackend;
  /**
   * Holds the next `METHOD path` response until `release()`. The change is applied to the
   * fixture state when the response is released, so the browser sees the same sequence a
   * slow server would produce.
   */
  hold(method: 'POST' | 'PATCH' | 'DELETE', path: string): { release(): void };
}

/**
 * Serves the salary, bill, snapshot, and saved-list endpoints the clarity Plan page
 * uses from one in-memory `FakeClarityBackend`. No request leaves the browser fixture.
 */
export function installClarityBackend(
  api: DeterministicApiFixtures,
  month: string,
  init: FakeBackendInit = {},
): ClarityBackendControl {
  const backend = new FakeClarityBackend(month, init);
  const respond = (request: RecordedApiRequest) => {
    const url = new URL(request.path, 'http://fixture.invalid');
    const reply = backend.handle({
      method: request.method,
      path: url.pathname.replace(/^\/api/, ''),
      query: url.searchParams,
      body: request.body,
    });
    return { status: reply.status, json: reply.body };
  };
  api.stub('GET', '/api/invites', { json: { invites: [] } });
  // The data-use notice is already acknowledged, so new pay and bill entries are not paused.
  api.stub('GET', '/api/clarity/settings', { json: buildSettings({ acknowledgedVersion: 1 }) });
  api.stub('GET', `/api/finance/clarity?month=${month}`, respond);
  api.stub('GET', '/api/finance/emis', respond);
  api.stub('GET', '/api/finance/salary', respond);
  api.stub('POST', '/api/finance/salary', respond);
  api.stub('POST', '/api/finance/emis', respond);
  return {
    backend,
    hold(method, path) {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      api.stubOnce(method, path, async (request) => {
        await gate;
        return respond(request);
      });
      return { release };
    },
  };
}

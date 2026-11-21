import type { DeterministicApiFixtures, RecordedApiRequest } from '../fixtures/test';
import { buildSettings } from '../../src/test/claritySettingsBuilder';
import { FakeTripsBackend, type FakeTripsInit } from '../../src/test/fakeTripsBackend';

export interface TripsBackendControl {
  backend: FakeTripsBackend;
  /**
   * Holds the next `METHOD path` response until `release()`. The change is applied to the
   * fixture state when the response is released, so the browser sees the same sequence a
   * slow server would produce.
   */
  hold(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string): { release(): void };
}

/** Highest trip id the persistent stubs cover. The fixtures here use only a few. */
const MAX_TRIP_ID = 6;

/**
 * Serves the snapshot, trip, trip write, and share endpoints the clarity trip page uses from
 * one in-memory `FakeTripsBackend`. Nothing leaves the browser fixture. The signed-in
 * account is the backend's `viewer`, which must be the fixture user's email.
 */
export function installTripsBackend(
  api: DeterministicApiFixtures,
  month: string,
  init: FakeTripsInit,
): TripsBackendControl {
  const backend = new FakeTripsBackend(month, init);
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
  // The data-use notice is already acknowledged, so new entries are not paused.
  api.stub('GET', '/api/clarity/settings', { json: buildSettings({ acknowledgedVersion: 1 }) });
  api.stub('GET', `/api/finance/clarity?month=${month}`, respond);
  api.stub('GET', `/api/finance/expenses?month=${month}`, respond);
  api.stub('GET', '/api/trips', respond);
  for (let id = 1; id <= MAX_TRIP_ID; id += 1) {
    api.stub('GET', `/api/trips/${id}`, respond);
    api.stub('POST', `/api/trips/${id}/members`, respond);
    api.stub('POST', `/api/trips/${id}/expenses`, respond);
    api.stub('GET', `/api/trips/${id}/share`, respond);
    api.stub('POST', `/api/trips/${id}/share`, respond);
    api.stub('DELETE', `/api/trips/${id}/share`, respond);
    api.stub('GET', `/api/trips/${id}/share/disclosure`, respond);
  }
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

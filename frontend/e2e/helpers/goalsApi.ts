import type { DeterministicApiFixtures, RecordedApiRequest } from '../fixtures/test';
import { buildSettings } from '../../src/test/claritySettingsBuilder';
import { FakeGoalsBackend, type FakeGoalsInit } from '../../src/test/fakeGoalsBackend';

export interface GoalsBackendControl {
  backend: FakeGoalsBackend;
  /**
   * Holds the next `METHOD path` response until `release()`. The change is applied to the
   * fixture state when the response is released, so the browser sees the same sequence a
   * slow server would produce, and releasing two held changes in the opposite order from
   * submission makes the server process them in that opposite order.
   */
  hold(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string): { release(): void };
}

/** Highest goal id the persistent stubs cover. The fixtures here use only a few. */
const MAX_GOAL_ID = 8;

/**
 * Serves the snapshot, goal list, goal change, and contribution endpoints the clarity
 * Goals page uses from one in-memory `FakeGoalsBackend`. Nothing leaves the browser fixture.
 */
export function installGoalsBackend(
  api: DeterministicApiFixtures,
  month: string,
  init: FakeGoalsInit = {},
): GoalsBackendControl {
  const backend = new FakeGoalsBackend(month, init);
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
  api.stub('GET', '/api/finance/goals', respond);
  api.stub('POST', '/api/finance/goals', respond);
  for (let id = 1; id <= MAX_GOAL_ID; id += 1) {
    api.stub('PATCH', `/api/finance/goals/${id}`, respond);
    api.stub('DELETE', `/api/finance/goals/${id}`, respond);
    api.stub('POST', `/api/finance/goals/${id}/contributions`, respond);
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

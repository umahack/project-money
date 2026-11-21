import type { DeterministicApiFixtures, RecordedApiRequest } from '../fixtures/test';
import { buildSettings } from '../../src/test/claritySettingsBuilder';
import { FakeSpendingBackend, type FakeSpendingInit } from '../../src/test/fakeSpendingBackend';

export interface SpendingBackendControl {
  backend: FakeSpendingBackend;
  /**
   * Holds the next `METHOD path` response until `release()`. The change is applied to the
   * fixture state when the response is released, so the browser sees the same sequence a
   * slow server would produce, and releasing two held changes in the opposite order from
   * submission makes the server process them in that opposite order.
   */
  hold(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string): { release(): void };
}

/** Highest expense id the persistent stubs cover. The fixtures here create only a few. */
const MAX_EXPENSE_ID = 12;

/**
 * Serves the snapshot, expense list, expense change, and category-treatment endpoints the
 * clarity Spending page uses from one in-memory `FakeSpendingBackend`. Nothing leaves the
 * browser fixture.
 */
export function installSpendingBackend(
  api: DeterministicApiFixtures,
  month: string,
  init: FakeSpendingInit = {},
): SpendingBackendControl {
  const backend = new FakeSpendingBackend(month, init);
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
  api.stub('GET', '/api/finance/budgets', respond);
  api.stub('GET', '/api/finance/insights', respond);
  api.stub('GET', '/api/finance/history', respond);
  api.stub('POST', '/api/finance/expenses', respond);
  for (let id = 1; id <= MAX_EXPENSE_ID; id += 1) {
    api.stub('PATCH', `/api/finance/expenses/${id}`, respond);
    api.stub('DELETE', `/api/finance/expenses/${id}`, respond);
  }
  for (const category of backend.categories) {
    const path = `/api/finance/category-treatments/${encodeURIComponent(category)}`;
    api.stub('PUT', path, respond);
    api.stub('DELETE', path, respond);
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

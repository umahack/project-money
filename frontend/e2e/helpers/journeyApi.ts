import type { DeterministicApiFixtures, RecordedApiRequest } from '../fixtures/test';
import type { FakeBackendInit } from '../../src/test/fakeClarityBackend';
import { FakeJourneyServer } from '../../src/test/fakeJourneyServer';
import { installClarityBackend, type ClarityBackendControl } from './clarityApi';

/** The first journey the in-memory server creates always has this id. */
export const FIRST_JOURNEY_PATH = '/api/clarity/journeys/1';

export interface JourneyApiControl extends ClarityBackendControl {
  server: FakeJourneyServer;
  /** Holds the next journey PATCH response until `release()`. The step is applied when it is released. */
  holdJourneyPatch(): { release(): void };
}

/**
 * The journey routes plus the pay, bill, and snapshot routes the journey hosts, all in
 * memory. Saved records satisfy journey steps the way the real server derives them from
 * confirmed records: a saved pay satisfies the pay step. Nothing leaves the browser fixture.
 */
export function installJourneyApi(
  api: DeterministicApiFixtures,
  month: string,
  init: FakeBackendInit = {},
): JourneyApiControl {
  const control = installClarityBackend(api, month, init);
  const server = new FakeJourneyServer();
  const respond = (request: RecordedApiRequest) => {
    if (control.backend.salary) server.satisfied.add('salary');
    else server.satisfied.delete('salary');
    const url = new URL(request.path, 'http://fixture.invalid');
    const body = request.body && typeof request.body === 'object' ? (request.body as Record<string, unknown>) : undefined;
    const reply = server.handle({ method: request.method, path: url.pathname.replace(/^\/api/, ''), body });
    return { status: reply?.status ?? 404, json: reply?.body ?? { error: 'Not found' } };
  };
  api.stub('GET', '/api/clarity/journeys/active', respond);
  api.stub('POST', '/api/clarity/journeys', respond);
  api.stub('PATCH', FIRST_JOURNEY_PATH, respond);
  // Product Analytics is off for this fixture, so nothing should be sent; a send is dropped quietly.
  api.stub('POST', '/api/clarity/events', { status: 204 });
  return {
    ...control,
    server,
    holdJourneyPatch() {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      api.stubOnce('PATCH', FIRST_JOURNEY_PATH, async (request) => {
        await gate;
        return respond(request);
      });
      return { release };
    },
  };
}

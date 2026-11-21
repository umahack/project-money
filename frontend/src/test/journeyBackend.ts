import { vi } from 'vitest';
import { FakeJourneyServer, type JourneyCall, type Reply } from './fakeJourneyServer';
import { createApiResponse } from './test-utils';

export {
  DEFINITIONS,
  FakeJourneyServer,
  SKIP_OUTCOME,
  type DesiredOutcome,
  type JourneyCall,
} from './fakeJourneyServer';

type Extra = (call: JourneyCall, attempt: number) => Reply | Response | Promise<Reply | Response>;

export interface JourneyFetch {
  calls: JourneyCall[];
  events: Array<Record<string, unknown>>;
  to(method: string, path: string): JourneyCall[];
}

/**
 * Routes the Vitest `fetch` stub to a `FakeJourneyServer`, with `extra` routes
 * (keyed `METHOD /path`) for the finance endpoints a hosted form calls.
 */
export function installJourneyFetch(server: FakeJourneyServer, extra: Record<string, Extra | object> = {}): JourneyFetch {
  const calls: JourneyCall[] = [];
  const events: Array<Record<string, unknown>> = [];
  const attempts = new Map<string, number>();
  vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
    const url = new URL(String(input), 'http://localhost');
    const path = url.pathname.replace(/^\/api/, '');
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    if (path === '/clarity/events') {
      events.push(body ?? {});
      return new Response(null, { status: 204 });
    }
    if (path === '/track') return new Response(null, { status: 204 });
    const call: JourneyCall = { method, path, body };
    calls.push(call);
    const handled = server.handle(call);
    if (handled) return createApiResponse(handled);
    const key = `${method} ${path}`;
    const attempt = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, attempt);
    const route = extra[key];
    if (route === undefined) return createApiResponse({ status: 404, body: { error: 'Not found' } });
    const result = typeof route === 'function' ? await (route as Extra)(call, attempt) : { status: 200, body: route };
    return result instanceof Response ? result : createApiResponse(result);
  });
  return {
    calls,
    events,
    to: (method, path) => calls.filter((call) => call.method === method && call.path === path),
  };
}

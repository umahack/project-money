import { vi } from 'vitest';
import { FakeClarityBackend } from './fakeClarityBackend';
import { createApiResponse } from './test-utils';

export interface RecordedCall {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  headers: Record<string, string>;
}

export interface Gate {
  /** Lets the held request reach the backend and respond. */
  release(): void;
}

export interface BackendFetch {
  calls: RecordedCall[];
  /** Bodies posted to `/api/clarity/events`, in order. */
  events: Array<Record<string, unknown>>;
  to(method: string, path: string): RecordedCall[];
  /**
   * Holds the next `METHOD /path` request before the backend sees it, so a test
   * decides when the response arrives. The change is applied when released.
   */
  hold(method: string, path: string): Gate;
}

/**
 * Routes the Vitest `fetch` stub to a `FakeClarityBackend`. Measurement events
 * and visit beacons get a 204, as the real service answers when a setting is off.
 */
export function installBackendFetch(backend: FakeClarityBackend): BackendFetch {
  const calls: RecordedCall[] = [];
  const events: Array<Record<string, unknown>> = [];
  const gates = new Map<string, Array<Promise<void>>>();

  vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
    const url = new URL(String(input), 'http://localhost');
    const path = url.pathname.replace(/^\/api/, '');
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries((init?.headers as Record<string, string> | undefined) ?? {})) {
      headers[name.toLowerCase()] = value;
    }
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;

    if (path === '/clarity/events') {
      events.push(body as Record<string, unknown>);
      return new Response(null, { status: 204 });
    }
    if (path === '/track') return new Response(null, { status: 204 });

    const call: RecordedCall = { method, path, query: url.searchParams, body, headers };
    calls.push(call);
    const held = gates.get(`${method} ${path}`)?.shift();
    if (held) await held;
    const reply = backend.handle({ method, path, query: url.searchParams, body, headers });
    return createApiResponse({ status: reply.status, body: reply.body });
  });

  return {
    calls,
    events,
    to: (method, path) => calls.filter((call) => call.method === method && call.path === path),
    hold(method, path) {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      const key = `${method} ${path}`;
      gates.set(key, [...(gates.get(key) ?? []), promise]);
      return { release };
    },
  };
}

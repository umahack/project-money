import { vi } from 'vitest';
import { FakeSpendingBackend } from './fakeSpendingBackend';
import { createApiResponse } from './test-utils';

export interface SpendingRecordedCall {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  /** Header names in lower case. */
  headers: Record<string, string>;
}

export interface SpendingGate {
  /** Lets the held request or response continue. */
  release(): void;
}

export interface SpendingFetch {
  calls: SpendingRecordedCall[];
  /** Bodies posted to `/api/clarity/events`, in order. */
  events: Array<Record<string, unknown>>;
  to(method: string, path: string): SpendingRecordedCall[];
  /** Holds the next `METHOD /path` request before the backend sees it. The change is applied when released. */
  hold(method: string, path: string): SpendingGate;
  /**
   * Lets the next `METHOD /path` request reach the backend at once, which applies the
   * change, and holds the response until released. Releasing responses in the opposite
   * order from the requests makes a newer confirmed snapshot arrive before an older one.
   */
  holdResponse(method: string, path: string): SpendingGate;
  /** The backend applies the next `METHOD /path` change, and the client sees a network failure instead of the response. */
  loseResponse(method: string, path: string): void;
}

type Plan = { kind: 'request' | 'response'; promise: Promise<void> } | { kind: 'lose' };

/**
 * Routes the Vitest `fetch` stub to a `FakeSpendingBackend`. Measurement events
 * and visit beacons get a 204, as the real service answers when a setting is off.
 */
export function installSpendingFetch(backend: FakeSpendingBackend): SpendingFetch {
  const calls: SpendingRecordedCall[] = [];
  const events: Array<Record<string, unknown>> = [];
  const plans = new Map<string, Plan[]>();

  function plan(method: string, path: string, next: Plan) {
    const key = `${method} ${path}`;
    plans.set(key, [...(plans.get(key) ?? []), next]);
  }

  function gate(method: string, path: string, kind: 'request' | 'response'): SpendingGate {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    plan(method, path, { kind, promise });
    return { release };
  }

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

    calls.push({ method, path, query: url.searchParams, body, headers });
    const planned = plans.get(`${method} ${path}`)?.shift();
    if (planned?.kind === 'request') await planned.promise;
    const reply = backend.handle({ method, path, query: url.searchParams, body, headers });
    if (planned?.kind === 'response') await planned.promise;
    if (planned?.kind === 'lose') throw new TypeError('Failed to fetch');
    return createApiResponse({ status: reply.status, body: reply.body });
  });

  return {
    calls,
    events,
    to: (method, path) => calls.filter((call) => call.method === method && call.path === path),
    hold: (method, path) => gate(method, path, 'request'),
    holdResponse: (method, path) => gate(method, path, 'response'),
    loseResponse: (method, path) => plan(method, path, { kind: 'lose' }),
  };
}

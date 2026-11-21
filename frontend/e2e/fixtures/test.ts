import {
  expect,
  test as base,
  type Page,
  type Request,
  type Route,
} from '@playwright/test';

import { neutralizeDecorativeRendering as neutralizeDecorativeRenderingStyle } from '../helpers/browser';

export const LOCAL_TEST_ORIGIN = 'http://127.0.0.1:4173';

export const TEST_USER = Object.freeze({
  id: 9001,
  email: 'browser-fixture@example.invalid',
  name: 'Browser Fixture',
  is_admin: false,
});

const TEST_TOKEN = 'playwright-fixture-token-not-valid-outside-tests';

type ApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface ApiReply {
  status?: number;
  json?: unknown;
  body?: string;
  headers?: Record<string, string>;
  delayMs?: number;
}

export interface RecordedApiRequest {
  method: ApiMethod;
  path: string;
  body: unknown;
  hasAuthorization: boolean;
  /** The `X-Clarity-Contract` header the browser sent, or null. A legacy (flag off) client never sends it. */
  clarityContract?: string | null;
}

type ApiResponder = ApiReply | ((request: RecordedApiRequest) => ApiReply | Promise<ApiReply>);

export interface DeferredApiReply {
  fulfill(reply: ApiReply): void;
}

function requestKey(method: ApiMethod, path: string): string {
  if (!path.startsWith('/api/')) {
    throw new Error(`Browser API fixtures must use a local /api/ path, received: ${path}`);
  }
  return `${method} ${path}`;
}

function toResponder(responder: ApiResponder): (request: RecordedApiRequest) => ApiReply | Promise<ApiReply> {
  return typeof responder === 'function' ? responder : () => responder;
}

function parseRequestBody(request: Request): unknown {
  const raw = request.postData();
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/**
 * A closed, in-memory API used by every browser test. Requests never reach the
 * Express service, Turso, production credentials, or a real public-share URL.
 */
export class DeterministicApiFixtures {
  readonly requests: RecordedApiRequest[] = [];
  readonly unhandledRequests: string[] = [];
  readonly blockedExternalRequests: string[] = [];

  private readonly persistent = new Map<string, ReturnType<typeof toResponder>>();
  private readonly queued = new Map<string, Array<ReturnType<typeof toResponder>>>();
  private fallbackResponder: ((request: RecordedApiRequest) => ApiReply | null | Promise<ApiReply | null>) | null = null;

  constructor(private readonly origin: string) {
    this.stub('POST', '/api/track', { status: 204 });
    this.stub('GET', '/api/health', { json: { ok: true, source: 'browser-fixture' } });
    this.stub('GET', '/api/public/announcement', { json: { announcement: null } });
  }

  stub(method: ApiMethod, path: string, responder: ApiResponder): void {
    this.persistent.set(requestKey(method, path), toResponder(responder));
  }

  stubOnce(method: ApiMethod, path: string, responder: ApiResponder): void {
    const key = requestKey(method, path);
    const queue = this.queued.get(key) ?? [];
    queue.push(toResponder(responder));
    this.queued.set(key, queue);
  }

  /**
   * Answers every `/api/` request that has no exact stub. Return null for a route nobody owns, so it is
   * recorded as unhandled and fails the test like any other missing fixture. Used by the connected
   * acceptance world (helpers/worldApi.ts), whose routes carry ids and queries.
   */
  fallback(responder: (request: RecordedApiRequest) => ApiReply | null | Promise<ApiReply | null>): void {
    this.fallbackResponder = responder;
  }

  defer(method: ApiMethod, path: string): DeferredApiReply {
    let settled = false;
    let resolveReply: (reply: ApiReply) => void = () => {};
    const reply = new Promise<ApiReply>((resolve) => {
      resolveReply = resolve;
    });
    this.stubOnce(method, path, () => reply);
    return {
      fulfill(value) {
        if (settled) throw new Error(`Deferred browser fixture already fulfilled: ${method} ${path}`);
        settled = true;
        resolveReply(value);
      },
    };
  }

  count(method: ApiMethod, path: string): number {
    return this.requests.filter((request) => request.method === method && request.path === path).length;
  }

  async dispatch(route: Route): Promise<void> {
    const request = route.request();
    const url = new URL(request.url());

    if (url.origin !== this.origin) {
      this.blockedExternalRequests.push(request.url());
      await route.abort('blockedbyclient');
      return;
    }

    if (!url.pathname.startsWith('/api/')) {
      await route.continue();
      return;
    }

    const method = request.method() as ApiMethod;
    const path = `${url.pathname}${url.search}`;
    const record: RecordedApiRequest = {
      method,
      path,
      body: parseRequestBody(request),
      hasAuthorization: request.headers().authorization !== undefined,
      clarityContract: request.headers()['x-clarity-contract'] ?? null,
    };
    this.requests.push(record);

    const key = requestKey(method, path);
    const queue = this.queued.get(key);
    const responder = queue?.shift() ?? this.persistent.get(key);
    if (queue?.length === 0) this.queued.delete(key);

    let reply: ApiReply | null = null;
    if (responder) reply = await responder(record);
    else if (this.fallbackResponder) reply = await this.fallbackResponder(record);

    if (!reply) {
      this.unhandledRequests.push(key);
      await route.fulfill({
        status: 501,
        contentType: 'application/json',
        body: JSON.stringify({ error: `Missing deterministic browser fixture for ${key}` }),
      });
      return;
    }

    if (reply.delayMs && reply.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
    }

    const status = reply.status ?? 200;
    const headers = { ...reply.headers };
    if (status === 204 || status === 304) {
      await route.fulfill({ status, headers });
      return;
    }

    const hasRawBody = reply.body !== undefined;
    if (!hasRawBody && !Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')) {
      headers['content-type'] = 'application/json; charset=utf-8';
    }
    await route.fulfill({
      status,
      headers,
      body: hasRawBody ? reply.body : JSON.stringify(reply.json ?? {}),
    });
  }
}

function assertLoopbackOrigin(origin: string): void {
  const hostname = new URL(origin).hostname;
  if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]') {
    throw new Error(`Playwright baseURL must stay on loopback; received ${origin}`);
  }
}

export interface FixtureUser {
  id: number;
  email: string;
  name: string;
  is_admin: boolean;
}

export async function installAuthenticatedSession(
  page: Page,
  user: FixtureUser = TEST_USER,
): Promise<void> {
  const auth = { token: TEST_TOKEN, user };
  const install = (value: typeof auth) => {
    sessionStorage.setItem('pm_token', value.token);
    sessionStorage.setItem('pm_user', JSON.stringify(value.user));
  };
  await page.addInitScript(install, auth);
  if (page.url() !== 'about:blank') await page.evaluate(install, auth);
}

interface BrowserFixtures {
  api: DeterministicApiFixtures;
  decorativeRendering: void;
}

interface BrowserOptions {
  /**
   * Off by default. Paint-budget specs turn it on with
   * `test.use({ neutralizeDecorativeRendering: true })` so the 100 ms budgets measure
   * application latency instead of software-rendered blur and background animation.
   * Layout, focus, overflow, reduced-motion, responsive, and accessibility specs must
   * leave it off. See `neutralizeDecorativeRendering` in helpers/browser.ts.
   */
  neutralizeDecorativeRendering: boolean;
}

export const test = base.extend<BrowserFixtures & BrowserOptions>({
  neutralizeDecorativeRendering: [false, { option: true }],
  decorativeRendering: [async ({ page, neutralizeDecorativeRendering }, use) => {
    if (neutralizeDecorativeRendering) await neutralizeDecorativeRenderingStyle(page);
    await use();
  }, { auto: true }],
  api: [async ({ page, baseURL }, use) => {
    const origin = new URL(baseURL ?? LOCAL_TEST_ORIGIN).origin;
    assertLoopbackOrigin(origin);
    const api = new DeterministicApiFixtures(origin);
    const routeHandler = (route: Route) => api.dispatch(route);
    await page.route('**/*', routeHandler);

    try {
      await use(api);

      expect(api.unhandledRequests, 'Every browser API request must have a deterministic fixture').toEqual([]);
      expect(api.blockedExternalRequests, 'Browser tests must not contact non-loopback services').toEqual([]);
    } finally {
      await page.unroute('**/*', routeHandler);
    }
  }, { auto: true }],
});

export { expect };

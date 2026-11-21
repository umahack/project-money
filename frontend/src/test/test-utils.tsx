import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { vi } from 'vitest';
import { configureAxe } from 'vitest-axe';
import { clearAuth, setAuth } from '../api';
import { AuthProvider, ToastProvider } from '../state';
import type { User } from '../types';

export { default as fc } from 'fast-check';

// jsdom has no layout or canvas implementation, so axe cannot measure color
// contrast here. Browser acceptance tests cover contrast with rendered styles.
export const axe = configureAxe({
  rules: { 'color-contrast': { enabled: false } },
});

export const propertyTestParameters = Object.freeze({ numRuns: 100 });
export const TEST_AUTH_TOKEN = 'test.jwt.token';

export function createTestUser(overrides: Partial<User> = {}): User {
  return {
    id: 4242,
    name: 'Test User',
    email: 'test.user@example.test',
    is_admin: false,
    ...overrides,
  };
}

export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Number.POSITIVE_INFINITY,
        gcTime: Number.POSITIVE_INFINITY,
      },
      mutations: { retry: false },
    },
  });
}

export interface HarnessRenderOptions extends Omit<RenderOptions, 'wrapper'> {
  route?: string;
  initialEntries?: string[];
  queryClient?: QueryClient;
  user?: User | null;
  token?: string;
}

export interface HarnessRenderResult extends RenderResult {
  queryClient: QueryClient;
  authenticatedUser: User | null;
}

export function renderWithProviders(
  ui: ReactElement,
  options: HarnessRenderOptions = {},
): HarnessRenderResult {
  const {
    route = '/',
    initialEntries = [route],
    queryClient = createTestQueryClient(),
    user = null,
    token = TEST_AUTH_TOKEN,
    ...renderOptions
  } = options;

  if (user) setAuth(token, user);
  else clearAuth();

  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <MemoryRouter initialEntries={initialEntries}>
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <AuthProvider>{children}</AuthProvider>
          </ToastProvider>
        </QueryClientProvider>
      </MemoryRouter>
    );
  }

  return Object.assign(render(ui, { ...renderOptions, wrapper: Wrapper }), {
    queryClient,
    authenticatedUser: user,
  });
}

export type AuthenticatedRenderOptions = Omit<HarnessRenderOptions, 'user'> & {
  user?: User;
};

export function renderAuthenticated(
  ui: ReactElement,
  options: AuthenticatedRenderOptions = {},
): HarnessRenderResult {
  return renderWithProviders(ui, {
    ...options,
    user: options.user ?? createTestUser(),
  });
}

export interface RouteRenderOptions extends HarnessRenderOptions {
  path: string;
}

export function renderAtRoute(
  ui: ReactElement,
  { path, ...options }: RouteRenderOptions,
): HarnessRenderResult {
  return renderWithProviders(
    <Routes>
      <Route path={path} element={ui} />
    </Routes>,
    options,
  );
}

export interface ApiResponseFixture<T = unknown> {
  body: T;
  status?: number;
  headers?: HeadersInit;
}

export function createApiResponse<T>({
  body,
  status = 200,
  headers: initialHeaders,
}: ApiResponseFixture<T>): Response {
  const headers = new Headers(initialHeaders);
  const hasBody = status !== 204 && status !== 205;
  if (hasBody && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  return new Response(hasBody ? JSON.stringify(body) : null, { status, headers });
}

export function queueApiResponses(...fixtures: ApiResponseFixture[]) {
  const fetchMock = vi.mocked(globalThis.fetch);
  if (!vi.isMockFunction(fetchMock)) {
    throw new Error('The API response helper requires the Vitest setup fetch guard');
  }

  for (const fixture of fixtures) {
    fetchMock.mockResolvedValueOnce(createApiResponse(fixture));
  }
  return fetchMock;
}

export function renderWithApiResponse(
  ui: ReactElement,
  response: ApiResponseFixture,
  options: AuthenticatedRenderOptions = {},
) {
  const fetchMock = queueApiResponses(response);
  return Object.assign(renderAuthenticated(ui, options), { fetchMock });
}

export interface FakeClock {
  initialTime: Date;
  advanceBy(milliseconds: number): Promise<void>;
  restore(): void;
}

export function installFakeClock(
  now: Date | string | number = '2026-01-15T06:30:00.000Z',
): FakeClock {
  const initialTime = new Date(now);
  if (Number.isNaN(initialTime.getTime())) {
    throw new RangeError('Fake clock requires a valid date');
  }

  vi.useFakeTimers();
  vi.setSystemTime(initialTime);

  return {
    initialTime: new Date(initialTime),
    async advanceBy(milliseconds: number) {
      await vi.advanceTimersByTimeAsync(milliseconds);
    },
    restore() {
      vi.useRealTimers();
    },
  };
}

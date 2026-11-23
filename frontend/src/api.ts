// API client for the Project Money backend (Express + JWT). Same storage keys as the classic UI,
// so users stay signed in across a UI switch or a rollback.
import type { User } from './types';
import { clearCachedPlan } from './hooks/useCachedPlan';
import {
  CLARITY_CONTRACT_HEADER,
  CLARITY_CONTRACT_VERSION,
  clarityContractHeaders,
} from './clarity/rollout';
import {
  CLARITY_SCHEMA_VERSION,
  type StructuredApiError,
  type StructuredErrorConstraint,
  type VersionedClarityResponse,
} from './clarity/contracts';
import { observeResponseTime } from './clarity/quickAdd/kolkata';

const BASE = ((import.meta.env.VITE_API_BASE as string | undefined) ?? '').replace(/\/+$/, '') + '/api';
export const DATA_NOTICE_REQUIRED_CODE = 'DATA_NOTICE_REQUIRED';
/** Dispatched on `window` when a command is rejected with 428 `DATA_NOTICE_REQUIRED`. */
export const DATA_NOTICE_REQUIRED_EVENT = 'clarity:data-notice-required';
const TOKEN_KEY = 'pm_token';
const USER_KEY = 'pm_user';

type ApiErrorDetails = Partial<Omit<StructuredApiError, 'message'>>;

export class ApiError extends Error {
  readonly code?: string;
  readonly field?: string;
  readonly constraint?: StructuredErrorConstraint;
  readonly outcomeIds?: string[];
  readonly currentVersion?: number;
  readonly currentRecordVersion?: number;

  constructor(
    public readonly status: number,
    message: string,
    details: ApiErrorDetails = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = details.code;
    this.field = details.field;
    this.constraint = details.constraint;
    this.outcomeIds = details.outcomeIds;
    this.currentVersion = details.currentVersion;
    this.currentRecordVersion = details.currentRecordVersion;
  }
}

let queryCacheClearer: (() => void) | null = null;

/** Register the single application query cache that must be wiped on auth clear. */
export function registerQueryCacheClearer(clearer: () => void): () => void {
  queryCacheClearer = clearer;
  return () => {
    if (queryCacheClearer === clearer) queryCacheClearer = null;
  };
}

export const getToken = (): string | null => sessionStorage.getItem(TOKEN_KEY);

export function getUser(): User | null {
  try {
    const raw = sessionStorage.getItem(USER_KEY);
    if (!raw) return null;
    const u = JSON.parse(raw) as Partial<User> | null;
    return u && typeof u.id === 'number' && typeof u.email === 'string'
      ? { id: u.id, email: u.email, name: String(u.name ?? ''), is_admin: !!u.is_admin }
      : null;
  } catch {
    return null;
  }
}

export function setAuth(token: string, user: User): void {
  sessionStorage.setItem(TOKEN_KEY, token);
  sessionStorage.setItem(USER_KEY, JSON.stringify(user));
  // Signal to any hook watching session expiry (e.g. "stay signed in" toast).
  window.dispatchEvent(new Event('auth:changed'));
}

export function clearAuth(): void {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(USER_KEY);
  // Also wipe both generations of financial cache so a later account in this
  // tab cannot read the previous account's data. The clarity cache is memory-only.
  clearCachedPlan();
  try {
    queryCacheClearer?.();
  } catch {
    // Auth clearing must still complete if a cache implementation fails.
  }
}

export interface MutationRequestMetadata {
  idempotencyKey?: string;
}

/** `ApiError.code` for a request that got no response within its `timeoutMs`. */
export const REQUEST_TIMEOUT_CODE = 'REQUEST_TIMEOUT';
export const REQUEST_TIMEOUT_MESSAGE =
  'The server did not answer in time. Your change may have been saved. Retry to confirm it without saving it twice.';

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  auth?: boolean;
  idempotencyKey?: string;
  /** Abort and fail with `REQUEST_TIMEOUT` after this many milliseconds. Omitted means no timeout. */
  timeoutMs?: number;
  forceClarityContract?: boolean;
  expectedSchemaVersion?: typeof CLARITY_SCHEMA_VERSION;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function structuredErrorFrom(data: unknown): StructuredApiError | null {
  if (!isRecord(data)) return null;
  const nested = isRecord(data.error) ? data.error : null;
  const source = nested ?? data;
  const message = nested ? optionalString(source.message) : optionalString(data.error);
  const code = optionalString(source.code);
  if (!message || !code) return null;

  const constraint = typeof source.constraint === 'string' || isRecord(source.constraint)
    ? source.constraint
    : undefined;
  const outcomeIds = Array.isArray(source.outcomeIds)
    && source.outcomeIds.every((item) => typeof item === 'string')
    ? source.outcomeIds
    : undefined;

  return {
    code,
    message,
    field: optionalString(source.field),
    constraint,
    outcomeIds,
    currentVersion: optionalNumber(source.currentVersion),
    currentRecordVersion: optionalNumber(source.currentRecordVersion),
  };
}

function errorMessageFrom(data: unknown): string | null {
  if (!isRecord(data)) return null;
  if (typeof data.error === 'string') return data.error;
  if (isRecord(data.error) && typeof data.error.message === 'string') return data.error.message;
  return null;
}

export function assertClarityResponseVersion(
  value: unknown,
): asserts value is VersionedClarityResponse {
  if (!isRecord(value) || value.schemaVersion !== CLARITY_SCHEMA_VERSION) {
    throw new ApiError(
      0,
      'The server returned an unsupported financial clarity response version.',
      { code: 'UNSUPPORTED_CLARITY_SCHEMA_VERSION' },
    );
  }
}

async function request<T>(
  path: string,
  {
    method = 'GET',
    body,
    auth = true,
    idempotencyKey,
    timeoutMs,
    forceClarityContract = false,
    expectedSchemaVersion,
  }: RequestOptions = {},
): Promise<T> {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return requestOnce<T>(path, {
      method, body, auth, idempotencyKey, forceClarityContract, expectedSchemaVersion,
    });
  }
  // The timer covers the whole exchange, including reading the body. When it fires the
  // fetch is aborted and the caller gets the timeout error; anything the abandoned
  // exchange produces later is dropped because requestOnce's result is no longer awaited.
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ApiError(0, REQUEST_TIMEOUT_MESSAGE, { code: REQUEST_TIMEOUT_CODE }));
    }, timeoutMs);
  });
  const exchange = requestOnce<T>(path, {
    method, body, auth, idempotencyKey, forceClarityContract, expectedSchemaVersion,
    signal: controller.signal,
  });
  // A late rejection from the abandoned exchange must not become an unhandled rejection.
  exchange.catch(() => undefined);
  try {
    return await Promise.race([exchange, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

async function requestOnce<T>(
  path: string,
  {
    method = 'GET',
    body,
    auth = true,
    idempotencyKey,
    forceClarityContract = false,
    expectedSchemaVersion,
    signal,
  }: RequestOptions & { signal?: AbortSignal } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    ...(forceClarityContract
      ? { [CLARITY_CONTRACT_HEADER]: CLARITY_CONTRACT_VERSION }
      : clarityContractHeaders(path, auth)),
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  if (auth) {
    const t = getToken();
    if (t) headers.Authorization = `Bearer ${t}`;
  }
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      ...(signal ? { signal } : {}),
    });
  } catch {
    throw new ApiError(
      0,
      "Couldn't reach the server. If this is the first visit in a while, the free host may be waking up. Wait about 30 seconds and retry.",
    );
  }
  const data: unknown = await res.json().catch(() => ({}));
  // After a timeout abort, a late response must not clear auth, fire events, or resolve.
  if (signal?.aborted) {
    throw new ApiError(0, REQUEST_TIMEOUT_MESSAGE, { code: REQUEST_TIMEOUT_CODE });
  }
  observeResponseTime(res.headers?.get('Date'), data);
  if (!res.ok) {
    const structuredError = structuredErrorFrom(data);
    const serverMessage = structuredError?.message ?? errorMessageFrom(data);
    if (res.status === 401 && auth) {
      clearAuth();
      const detail = serverMessage ?? 'Your session has ended. Please sign in again.';
      window.dispatchEvent(new CustomEvent('auth:expired', { detail }));
    }
    // A new data use needs the current notice acknowledged. Tell the data-use
    // gate so it shows the notice instead of leaving a failed command.
    if (res.status === 428 && structuredError?.code === DATA_NOTICE_REQUIRED_CODE) {
      window.dispatchEvent(new Event(DATA_NOTICE_REQUIRED_EVENT));
    }
    // If the server says "not admin", the client's cached is_admin flag has
    // drifted (or was tampered with). Clear it so the admin UI stops leaking.
    if (res.status === 403 && path.startsWith('/admin')) {
      try {
        const raw = sessionStorage.getItem(USER_KEY);
        if (raw) {
          const u = JSON.parse(raw);
          if (u && u.is_admin) {
            u.is_admin = false;
            sessionStorage.setItem(USER_KEY, JSON.stringify(u));
            window.dispatchEvent(new Event('auth:changed'));
          }
        }
      } catch { /* ignore */ }
    }
    let fallback: string;
    if (res.status === 429) {
      const retry = Number(res.headers.get('retry-after')) || 60;
      fallback = `Too many requests. Try again in ${retry} seconds.`;
    } else if (res.status >= 500) {
      fallback = 'The server had a problem. Please try again shortly.';
    } else {
      fallback = `Request failed (${res.status})`;
    }
    throw new ApiError(
      res.status,
      serverMessage ?? fallback,
      structuredError ?? {},
    );
  }
  if (expectedSchemaVersion !== undefined) assertClarityResponseVersion(data);
  return data as T;
}

export interface ClarityMutationRequest {
  method?: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  idempotencyKey: string;
  /** Abort and fail with `REQUEST_TIMEOUT` after this many milliseconds. Omitted means no timeout. */
  timeoutMs?: number;
}

export const clarityApi = {
  get: <T extends VersionedClarityResponse>(path: string) => request<T>(path, {
    forceClarityContract: true,
    expectedSchemaVersion: CLARITY_SCHEMA_VERSION,
  }),
  mutate: <T extends VersionedClarityResponse>(
    path: string,
    { method = 'POST', body = {}, idempotencyKey, timeoutMs }: ClarityMutationRequest,
  ) => request<T>(path, {
    method,
    body,
    idempotencyKey,
    timeoutMs,
    forceClarityContract: true,
    expectedSchemaVersion: CLARITY_SCHEMA_VERSION,
  }),
};

export const api = {
  get: <T>(p: string) => request<T>(p),
  post: <T>(
    p: string,
    body?: unknown,
    auth = true,
    metadata: MutationRequestMetadata = {},
  ) => request<T>(p, { method: 'POST', body: body ?? {}, auth, ...metadata }),
  put: <T>(p: string, body?: unknown, metadata: MutationRequestMetadata = {}) => (
    request<T>(p, { method: 'PUT', body: body ?? {}, ...metadata })
  ),
  patch: <T>(p: string, body?: unknown, metadata: MutationRequestMetadata = {}) => (
    request<T>(p, { method: 'PATCH', body: body ?? {}, ...metadata })
  ),
  del: <T>(p: string, body?: unknown, metadata: MutationRequestMetadata = {}) => (
    request<T>(p, { method: 'DELETE', body, ...metadata })
  ),
};

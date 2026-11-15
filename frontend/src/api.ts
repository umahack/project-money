// API client for the Project Money backend (Express + JWT). Same storage keys as the classic UI,
// so users stay signed in across a UI switch or a rollback.
import type { User } from './types';

const BASE = ((import.meta.env.VITE_API_BASE as string | undefined) ?? '').replace(/\/+$/, '') + '/api';
const TOKEN_KEY = 'pm_token';
const USER_KEY = 'pm_user';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
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
}

export function clearAuth(): void {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(USER_KEY);
}

interface Opts {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  auth?: boolean;
}

async function request<T>(path: string, { method = 'GET', body, auth = true }: Opts = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
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
    });
  } catch {
    throw new ApiError(
      0,
      "Couldn't reach the server. If this is the first visit in a while, the free host may be waking up. Wait about 30 seconds and retry.",
    );
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    if (res.status === 401 && auth) {
      clearAuth();
      window.dispatchEvent(new Event('auth:expired'));
    }
    const fallback =
      res.status === 429 ? 'Too many requests. Please wait a moment and try again.'
      : res.status >= 500 ? 'The server had a problem. Please try again shortly.'
      : `Request failed (${res.status})`;
    throw new ApiError(res.status, typeof data?.error === 'string' ? data.error : fallback);
  }
  return data as T;
}

export const api = {
  get: <T>(p: string) => request<T>(p),
  post: <T>(p: string, body?: unknown, auth = true) => request<T>(p, { method: 'POST', body: body ?? {}, auth }),
  put: <T>(p: string, body?: unknown) => request<T>(p, { method: 'PUT', body: body ?? {} }),
  patch: <T>(p: string, body?: unknown) => request<T>(p, { method: 'PATCH', body: body ?? {} }),
  del: <T>(p: string) => request<T>(p, { method: 'DELETE' }),
};

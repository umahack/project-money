// API client for the Project Money backend (Express + JWT). Same storage keys as the classic UI,
// so users stay signed in across a UI switch or a rollback.
import type { User } from './types';
import { clearCachedPlan } from './hooks/useCachedPlan';

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
  // Signal to any hook watching session expiry (e.g. "stay signed in" toast).
  window.dispatchEvent(new Event('auth:changed'));
}

export function clearAuth(): void {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(USER_KEY);
  // Also wipe the dashboard-hydration cache so the next account signing in
  // on this tab never reads the previous user's plan. Covers 401 kick-outs,
  // explicit logout, and account-delete.
  clearCachedPlan();
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
      const detail =
        typeof data?.error === 'string'
          ? data.error
          : 'Your session has ended. Please sign in again.';
      window.dispatchEvent(new CustomEvent('auth:expired', { detail }));
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
    throw new ApiError(res.status, typeof data?.error === 'string' ? data.error : fallback);
  }
  return data as T;
}

export const api = {
  get: <T>(p: string) => request<T>(p),
  post: <T>(p: string, body?: unknown, auth = true) => request<T>(p, { method: 'POST', body: body ?? {}, auth }),
  put: <T>(p: string, body?: unknown) => request<T>(p, { method: 'PUT', body: body ?? {} }),
  patch: <T>(p: string, body?: unknown) => request<T>(p, { method: 'PATCH', body: body ?? {} }),
  del: <T>(p: string, body?: unknown) => request<T>(p, { method: 'DELETE', body }),
};

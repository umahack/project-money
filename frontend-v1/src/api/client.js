const BASE = (import.meta.env.VITE_API_BASE || '') + '/api';

export function getToken() {
  return sessionStorage.getItem('pm_token');
}
export function setAuth(token, user) {
  if (token) sessionStorage.setItem('pm_token', token);
  if (user) sessionStorage.setItem('pm_user', JSON.stringify(user));
}
export function getUser() {
  try { return JSON.parse(sessionStorage.getItem('pm_user') || 'null'); } catch { return null; }
}
export function logout() {
  sessionStorage.removeItem('pm_token');
  sessionStorage.removeItem('pm_user');
}

export async function api(path, { method = 'GET', body, auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) {
    const t = getToken();
    if (t) headers.Authorization = `Bearer ${t}`;
  }
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    // Network-level failure: offline, CORS blocked, DNS, or server cold-start timeout.
    throw new Error(
      "Couldn't reach the server. If this is the first visit in a while, the free host may be waking up — wait ~30 s and retry. Otherwise check your internet connection."
    );
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && auth) {
      logout();
      if (!/\/login|\/register/.test(location.pathname)) {
        location.href = '/login';
      }
    }
    const msg = data?.error || `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return data;
}

import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * Fire a page-view beacon on every route change. Best-effort — failures
 * are swallowed so analytics never breaks the UX.
 *
 * To keep token/share pages private the exact query / token path is
 * stripped: /share/trip/abc123 is reported as /share/trip/*.
 */
export function useVisitTracker() {
  const location = useLocation();
  const last = useRef<string | null>(null);

  useEffect(() => {
    const path = normalizePath(location.pathname);
    if (last.current === path) return;
    last.current = path;
    const base = ((import.meta.env.VITE_API_BASE as string | undefined) ?? '').replace(/\/+$/, '');
    const token = sessionStorage.getItem('pm_token') ?? '';
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    // keepalive lets it fly on tab close too
    fetch(`${base}/api/track`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path }),
      keepalive: true,
    }).catch(() => { /* ignore */ });
  }, [location.pathname]);
}

function normalizePath(p: string): string {
  if (p.startsWith('/share/trip/')) return '/share/trip/*';
  if (/^\/trips\/\d+$/.test(p)) return '/trips/:id';
  return p || '/';
}

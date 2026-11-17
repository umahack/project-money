import { useEffect, useRef, useState } from 'react';

/** Decode the 'exp' claim of a JWT without a library. Null if unparseable. */
function expOf(token: string | null): number | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '==='.slice((b64.length + 3) % 4);
    const payload = JSON.parse(atob(padded)) as { exp?: number };
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

/**
 * Watch the current JWT and surface a "warn" flag when expiry is within
 * `warnBeforeMs` of now. Re-reads sessionStorage on 'auth:changed' so a
 * token refresh resets the warning.
 */
export function useSessionWarning(warnBeforeMs = 5 * 60 * 1000) {
  const [warn, setWarn] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const schedule = () => {
      if (timer.current) clearTimeout(timer.current);
      setWarn(false);
      const token = sessionStorage.getItem('pm_token');
      const exp = expOf(token);
      if (!exp) return;
      const expMs = exp * 1000;
      const warnAt = expMs - warnBeforeMs;
      const now = Date.now();
      if (now >= expMs) return;
      if (now >= warnAt) {
        setWarn(true);
        return;
      }
      timer.current = setTimeout(() => setWarn(true), warnAt - now);
    };
    schedule();
    const onChange = () => schedule();
    const onExpired = () => setWarn(false);
    window.addEventListener('auth:changed', onChange);
    window.addEventListener('auth:expired', onExpired);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      window.removeEventListener('auth:changed', onChange);
      window.removeEventListener('auth:expired', onExpired);
    };
  }, [warnBeforeMs]);

  return warn;
}

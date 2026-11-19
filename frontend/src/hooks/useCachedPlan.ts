import { useEffect, useRef, useState } from 'react';
import type { Emi, Plan } from '../types';

const PLAN_KEY = 'pm_cache_plan_v1';
const EMIS_KEY = 'pm_cache_emis_v1';

interface Cached {
  plan: Plan | null;
  emis: Emi[] | null;
}

/**
 * Hydrate the dashboard from localStorage on first paint so the user sees
 * their last-known plan instantly, then swap in fresh server data when it
 * arrives. We only cache per-tab last values — not a server of truth.
 */
export function readCachedPlan(): Cached {
  try {
    const p = localStorage.getItem(PLAN_KEY);
    const e = localStorage.getItem(EMIS_KEY);
    return {
      plan: p ? (JSON.parse(p) as Plan) : null,
      emis: e ? (JSON.parse(e) as Emi[]) : null,
    };
  } catch {
    return { plan: null, emis: null };
  }
}

export function writeCachedPlan(plan: Plan | null, emis: Emi[] | null): void {
  try {
    if (plan) localStorage.setItem(PLAN_KEY, JSON.stringify(plan));
    if (emis) localStorage.setItem(EMIS_KEY, JSON.stringify(emis));
  } catch {
    /* storage full / blocked — ignore */
  }
}

export function clearCachedPlan(): void {
  try {
    localStorage.removeItem(PLAN_KEY);
    localStorage.removeItem(EMIS_KEY);
  } catch {
    /* ignore */
  }
}

/** Convenience hook: syncs state to localStorage on every change. */
export function usePersisted<T>(key: string, initial: T): [T, (v: T) => void] {
  const [val, setVal] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* ignore */ }
  }, [key, val]);
  return [val, setVal];
}

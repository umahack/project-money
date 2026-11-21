import type { Emi, Plan } from '../types';
import { currentMonth } from '../money';

// ROLLBACK-ONLY (task 17.2): this financial snapshot cache is read and written only by
// the flag-off legacy Home and Plan pages. Clarity pages keep server state in the
// in-memory query cache and never import it. `clearCachedPlan` stays wired into
// sign-out so a legacy session never leaves income or bills behind in the tab.
//
// Dashboard-hydration cache for instant first paint on a tab reload.
// Deliberately **sessionStorage**, not localStorage: the plan contains the
// user's income and bills (PII), and sessionStorage is tab-scoped so it
// dies on tab close. That is enough — the UX win is reload-within-tab, not
// cross-tab persistence. The cache is also keyed by uid so a different
// account signing into the same tab never reads the previous user's plan.

const PLAN_PREFIX = 'pm_cache_plan_v2_';
const EMIS_PREFIX = 'pm_cache_emis_v2_';
const UID_KEY = 'pm_cache_uid_v2';

interface Envelope<T> {
  uid: number;
  month?: string;
  data: T;
}

interface Cached {
  plan: Plan | null;
  emis: Emi[] | null;
}

function getUid(): number | null {
  try {
    const raw = sessionStorage.getItem('pm_user');
    if (!raw) return null;
    const u = JSON.parse(raw) as { id?: unknown };
    return typeof u.id === 'number' ? u.id : null;
  } catch {
    return null;
  }
}

// Minimal schema validation — if the Plan shape drifts between deploys,
// reject the cached blob instead of letting undefined fields crash render.
function isPlanShape(x: unknown): x is Plan {
  if (!x || typeof x !== 'object') return false;
  const p = x as Record<string, unknown>;
  if (typeof p.income !== 'number' || typeof p.emiTotal !== 'number' || typeof p.afterFixed !== 'number') return false;
  const b = p.breakdown as Record<string, unknown> | undefined;
  return !!b && typeof b.needs === 'number' && typeof b.wants === 'number' && typeof b.save === 'number';
}

export function readCachedPlan(): Cached {
  try {
    const uid = getUid();
    if (uid == null) return { plan: null, emis: null };
    // Discard cache belonging to a different user (defence in depth on top
    // of clearAuth cleanup; relevant if a user is impersonated or swapped
    // in the same tab without a full reload).
    const storedUid = sessionStorage.getItem(UID_KEY);
    if (storedUid && Number(storedUid) !== uid) return { plan: null, emis: null };

    const pRaw = sessionStorage.getItem(PLAN_PREFIX + uid);
    const eRaw = sessionStorage.getItem(EMIS_PREFIX + uid);
    const p = pRaw ? (JSON.parse(pRaw) as Envelope<Plan>) : null;
    const e = eRaw ? (JSON.parse(eRaw) as Envelope<Emi[]>) : null;

    const planOk = p && p.uid === uid && isPlanShape(p.data) && p.month === currentMonth();
    const emisOk = e && e.uid === uid && Array.isArray(e.data);
    return {
      plan: planOk ? p.data : null,
      emis: emisOk ? e.data : null,
    };
  } catch {
    return { plan: null, emis: null };
  }
}

export function writeCachedPlan(plan: Plan | null, emis: Emi[] | null): void {
  try {
    const uid = getUid();
    if (uid == null) return;
    sessionStorage.setItem(UID_KEY, String(uid));
    if (plan) {
      const envelope: Envelope<Plan> = { uid, month: currentMonth(), data: plan };
      sessionStorage.setItem(PLAN_PREFIX + uid, JSON.stringify(envelope));
    }
    if (emis) {
      const envelope: Envelope<Emi[]> = { uid, data: emis };
      sessionStorage.setItem(EMIS_PREFIX + uid, JSON.stringify(envelope));
    }
  } catch {
    /* storage full / blocked — ignore */
  }
}

export function clearCachedPlan(): void {
  try {
    sessionStorage.removeItem(UID_KEY);
    // Sweep any per-uid keys (covers prior sessions lingering in the tab).
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i);
      if (k && (k.startsWith(PLAN_PREFIX) || k.startsWith(EMIS_PREFIX))) {
        sessionStorage.removeItem(k);
      }
    }
    // Clean up any v1 localStorage keys left over from the earlier design.
    try {
      localStorage.removeItem('pm_cache_plan_v1');
      localStorage.removeItem('pm_cache_emis_v1');
    } catch { /* ignore */ }
  } catch {
    /* ignore */
  }
}

import { readClientFeatureFlags } from './clarity/rollout';
import { kolkataMonth } from './clarity/quickAdd/kolkata';

const fmt0 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const fmt2 = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Format rupees with Indian digit grouping. Whole amounts show no decimals, others show paise. */
export function inr(n: number | null | undefined): string {
  const v = Number.isFinite(n) ? (n as number) : 0;
  const r = Math.round(v * 100) / 100;
  const sign = r < 0 ? '-' : '';
  const a = Math.abs(r);
  return `${sign}₹${Number.isInteger(a) ? fmt0.format(a) : fmt2.format(a)}`;
}

export const MAX_AMOUNT = 1e11;

/**
 * Parse text like "1,25,000.50" into rupees using string checks (no float surprises).
 * Returns null for anything that is not a plain non-negative amount with at most 2 decimals.
 */
export function parseAmount(input: string): number | null {
  const s = input.replace(/[₹,\s]/g, '');
  if (!/^\d{1,11}(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n <= MAX_AMOUNT ? n : null;
}

export function amountToInput(n: number | null | undefined): string {
  if (!n) return '';
  return String(Math.round(n * 100) / 100);
}

export const toPaise = (n: number): number => Math.round(n * 100);

/**
 * The current month as `YYYY-MM`. While the Rollout_Flag is on this is the Asia/Kolkata month,
 * corrected by the server time of the latest response, so every clarity page names the server's
 * month. While it is off this is the device-clock month, exactly as before. Call it during render,
 * with `useKolkataMonth()` in the component so a rollover re-renders, and never keep it in a
 * module constant.
 */
export function currentMonth(): string {
  if (readClientFeatureFlags().financialClarityEnabled) return kolkataMonth();
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function monthLabel(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return month;
  return new Date(Number(m[1]), Number(m[2]) - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
}

/** The API stores UTC timestamps as "YYYY-MM-DD HH:MM:SS". */
export function fmtDate(ts: string | null | undefined, withYear = false): string {
  if (!ts) return '—';
  const d = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(ts) ? ts.replace(' ', 'T') + 'Z' : ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}) });
}

import { useSyncExternalStore } from 'react';

/**
 * Asia/Kolkata calendar for the browser.
 *
 * Asia/Kolkata has used UTC+05:30 with no daylight saving since 1945, so adding
 * a constant offset to a UTC instant and reading the UTC fields is exact. This
 * is the same arithmetic as `backend/src/domain/kolkataTime.js`. Nothing here
 * reads the device time zone or locale, so a device in any zone names the same
 * day as the server for the same instant.
 *
 * The device clock can be wrong. `observeServerTime` records the difference
 * between a server time and the device clock, and `kolkataNow` applies it, so
 * a device whose clock is hours off still agrees with the server on the day.
 */

export const KOLKATA_UTC_OFFSET_MS = 19_800_000;
/** How often a mounted hook re-reads the calendar, in addition to `visibilitychange`. */
export const KOLKATA_REEVALUATE_MS = 30_000;

let serverOffsetMs = 0;
const offsetListeners = new Set<() => void>();

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

function kolkataFields(instantMs: number): { year: number; month: number; day: number } {
  const local = new Date(instantMs + KOLKATA_UTC_OFFSET_MS);
  const year = local.getUTCFullYear();
  if (!Number.isFinite(instantMs) || Number.isNaN(year)) {
    throw new RangeError('The Kolkata calendar needs a valid instant.');
  }
  return { year, month: local.getUTCMonth() + 1, day: local.getUTCDate() };
}

/** The offset, in milliseconds, between the server clock and the device clock (server minus device). */
export function getServerTimeOffsetMs(): number {
  return serverOffsetMs;
}

/** Forget the observed server offset, so `kolkataNow()` is the device clock again. */
export function resetServerTimeOffset(): void {
  if (serverOffsetMs === 0) return;
  serverOffsetMs = 0;
  offsetListeners.forEach((listener) => listener());
}

/**
 * Record a server time seen in a response. `serverTime` is an ISO timestamp, an
 * HTTP date, epoch milliseconds, or a `Date`. `receivedAtMs` is the device clock
 * when the response arrived. Returns true when the value was usable.
 */
export function observeServerTime(
  serverTime: string | number | Date | null | undefined,
  receivedAtMs: number = Date.now(),
): boolean {
  let serverMs: number;
  if (serverTime instanceof Date) serverMs = serverTime.getTime();
  else if (typeof serverTime === 'number') serverMs = serverTime;
  else if (typeof serverTime === 'string' && serverTime.trim() !== '') serverMs = Date.parse(serverTime);
  else return false;
  const offset = serverMs - receivedAtMs;
  if (!Number.isFinite(offset) || !Number.isFinite(new Date(serverMs).getTime())) return false;
  if (offset === serverOffsetMs) return true;
  serverOffsetMs = offset;
  offsetListeners.forEach((listener) => listener());
  return true;
}

/**
 * Record the server time carried by an API response. A snapshot or mutation
 * body has `generatedAt` with millisecond precision. The `Date` response header
 * is the fallback, and a browser only exposes it to same-origin callers.
 */
export function observeResponseTime(dateHeader: string | null | undefined, body: unknown): boolean {
  if (body && typeof body === 'object') {
    const record = body as { generatedAt?: unknown; snapshot?: { generatedAt?: unknown } | null };
    const stamp = (record.snapshot && typeof record.snapshot === 'object'
      ? record.snapshot.generatedAt
      : undefined) ?? record.generatedAt;
    if (typeof stamp === 'string' && observeServerTime(stamp)) return true;
  }
  return observeServerTime(dateHeader);
}

/** The device clock corrected by the observed server offset, in epoch milliseconds. */
export function kolkataNow(): number {
  return Date.now() + serverOffsetMs;
}

/** `YYYY-MM-DD` in Asia/Kolkata for a UTC instant. Defaults to the corrected current time. */
export function kolkataToday(instantMs: number = kolkataNow()): string {
  const { year, month, day } = kolkataFields(instantMs);
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/** `YYYY-MM` in Asia/Kolkata for a UTC instant. Defaults to the corrected current time. */
export function kolkataMonth(instantMs: number = kolkataNow()): string {
  const { year, month } = kolkataFields(instantMs);
  return `${pad(year, 4)}-${pad(month, 2)}`;
}

/**
 * One shared timer and one `visibilitychange` listener serve every mounted
 * hook. Each notification only makes React re-read the snapshot, and a hook
 * re-renders only when the date or month it returns has changed.
 */
const subscribers = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

function notifySubscribers(): void {
  subscribers.forEach((listener) => listener());
}

function onVisibilityChange(): void {
  if (typeof document === 'undefined' || document.visibilityState !== 'hidden') notifySubscribers();
}

function subscribe(listener: () => void): () => void {
  subscribers.add(listener);
  offsetListeners.add(listener);
  if (subscribers.size === 1) {
    timer = setInterval(notifySubscribers, KOLKATA_REEVALUATE_MS);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibilityChange);
  }
  return () => {
    subscribers.delete(listener);
    offsetListeners.delete(listener);
    if (subscribers.size === 0) {
      clearInterval(timer);
      timer = undefined;
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibilityChange);
    }
  };
}

/** The Kolkata date, re-read every 30 seconds, when the page becomes visible, and when the server offset changes. */
export function useKolkataToday(): string {
  return useSyncExternalStore(subscribe, () => kolkataToday());
}

/** The Kolkata month, re-read on the same schedule as `useKolkataToday`. */
export function useKolkataMonth(): string {
  return useSyncExternalStore(subscribe, () => kolkataMonth());
}

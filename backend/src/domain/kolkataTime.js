/**
 * Fixed-offset Asia/Kolkata calendar helpers.
 *
 * Asia/Kolkata has used UTC+05:30 with no daylight saving since 1945, so adding
 * a constant offset to a UTC instant is exact. These helpers never read the
 * process clock or the process time zone and never use Intl, so the result for
 * an instant is the same on every host.
 */

import { FINANCIAL_CLARITY_TIME_ZONE } from './monthlyPlan.js';

/** The product time zone name shared with the monthly plan. */
export const KOLKATA_TIME_ZONE = FINANCIAL_CLARITY_TIME_ZONE;

export const KOLKATA_UTC_OFFSET_SECONDS = 19800;

const KOLKATA_UTC_OFFSET_MS = KOLKATA_UTC_OFFSET_SECONDS * 1000;
const MAX_YEAR = 9999;

// Accepts ISO 8601 ("2025-03-04T10:00:00Z", "...+05:30") and the SQLite
// CURRENT_TIMESTAMP form ("2025-03-04 10:00:00"). A value with no zone is UTC.
const TIMESTAMP_PATTERN = new RegExp(
  '^(\\d{4})-(\\d{2})-(\\d{2})[T ](\\d{2}):(\\d{2})(?::(\\d{2})(?:\\.(\\d{1,9}))?)?'
  + '(Z|[+-]\\d{2}:?\\d{2})?$'
);

function parseOffsetMs(text) {
  if (text === undefined || text === 'Z') return 0;
  const sign = text[0] === '-' ? -1 : 1;
  const digits = text.slice(1).replace(':', '');
  const hours = Number(digits.slice(0, 2));
  const minutes = Number(digits.slice(2, 4));
  if (hours > 23 || minutes > 59) return null;
  return sign * ((hours * 60) + minutes) * 60 * 1000;
}

function parseTimestampString(text) {
  const match = TIMESTAMP_PATTERN.exec(text.trim());
  if (!match) return null;

  const [, year, month, day, hour, minute, second = '0', fraction = '0', zone] = match;
  const offsetMs = parseOffsetMs(zone);
  if (offsetMs === null) return null;

  const [y, mo, d, h, mi, s] = [year, month, day, hour, minute, second].map(Number);
  if (h > 23 || mi > 59 || s > 59) return null;

  const utc = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  // Date.UTC rolls over invalid days (for example February 30); reject those.
  if (utc.getUTCFullYear() !== y || utc.getUTCMonth() !== mo - 1 || utc.getUTCDate() !== d) {
    return null;
  }

  const millis = Number(fraction.slice(0, 3).padEnd(3, '0'));
  return utc.getTime() + millis - offsetMs;
}

/**
 * Convert a Date, epoch milliseconds, or a timestamp string to epoch
 * milliseconds. Returns null for anything that is not a valid instant.
 */
export function parseTimestampMs(value) {
  let ms = null;
  if (value instanceof Date) {
    ms = value.getTime();
  } else if (typeof value === 'number') {
    ms = value;
  } else if (typeof value === 'string') {
    ms = parseTimestampString(value);
  }
  return Number.isSafeInteger(ms) ? ms : null;
}

/**
 * Asia/Kolkata calendar date (YYYY-MM-DD) of a UTC instant, or null when the
 * value is not a valid instant or falls outside years 0000 through 9999.
 */
export function kolkataDateOf(value) {
  const ms = parseTimestampMs(value);
  if (ms === null) return null;

  const local = new Date(ms + KOLKATA_UTC_OFFSET_MS);
  const year = local.getUTCFullYear();
  if (Number.isNaN(year) || year < 0 || year > MAX_YEAR) return null;

  const pad = (number, width) => String(number).padStart(width, '0');
  return `${pad(year, 4)}-${pad(local.getUTCMonth() + 1, 2)}-${pad(local.getUTCDate(), 2)}`;
}

/** Asia/Kolkata month (YYYY-MM) of a UTC instant, or null when invalid. */
export function kolkataMonthOf(value) {
  const date = kolkataDateOf(value);
  return date === null ? null : date.slice(0, 7);
}

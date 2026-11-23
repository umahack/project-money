/**
 * Independent Asia/Kolkata reference for tests of the Quick Add and daily
 * allowance features.
 *
 * The date and month of an instant come from `Intl.DateTimeFormat` with an
 * explicit `timeZone`, so they never depend on the process time zone. The
 * calendar helpers use UTC arithmetic only. Nothing here imports production
 * code, so a test can compare a production helper with it.
 *
 * A twin of this file lives at `frontend/src/test/kolkataReference.ts`. The
 * two runtimes share no source, so keep them equal.
 */

export const KOLKATA_TIME_ZONE = 'Asia/Kolkata';
/** Asia/Kolkata is a fixed UTC+05:30 offset (no daylight saving since 1945). */
export const KOLKATA_OFFSET_MS = 19_800_000;
export const DAY_MS = 86_400_000;

const kolkataFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: KOLKATA_TIME_ZONE,
  calendar: 'gregory',
  numberingSystem: 'latn',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function toEpochMs(instant) {
  const ms = instant instanceof Date ? instant.getTime() : typeof instant === 'number' ? instant : Date.parse(instant);
  if (!Number.isFinite(ms)) throw new RangeError('The reference helper needs a valid instant.');
  return ms;
}

/** Calendar fields of an instant in Asia/Kolkata, read through Intl. */
export function kolkataParts(instant) {
  const fields = {};
  for (const part of kolkataFormatter.formatToParts(new Date(toEpochMs(instant)))) {
    if (part.type !== 'literal') fields[part.type] = Number(part.value);
  }
  const { year, month, day, hour, minute, second } = fields;
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    date: formatIsoDate(year, month, day),
    monthKey: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`,
  };
}

/** `YYYY-MM-DD` of an instant in Asia/Kolkata. */
export function kolkataDateOf(instant) {
  return kolkataParts(instant).date;
}

/** `YYYY-MM` of an instant in Asia/Kolkata. */
export function kolkataMonthOf(instant) {
  return kolkataParts(instant).monthKey;
}

/** The epoch milliseconds at which a Kolkata calendar date begins. */
export function kolkataMidnightMs(date) {
  const parts = parseIsoDate(date);
  if (!parts) throw new RangeError('The reference helper needs a real YYYY-MM-DD date.');
  return Date.UTC(parts.year, parts.month - 1, parts.day) - KOLKATA_OFFSET_MS;
}

export function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year, month) {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function isRealDate(year, month, day) {
  return (
    Number.isInteger(year) && Number.isInteger(month) && Number.isInteger(day)
    && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month)
  );
}

/** Formats fields as `YYYY-MM-DD` without checking that they name a real date. */
export function formatIsoDate(year, month, day) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Returns `{ year, month, day }` for a real `YYYY-MM-DD` date, otherwise null. */
export function parseIsoDate(text) {
  const match = ISO_DATE.exec(text);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return isRealDate(year, month, day) ? { year, month, day } : null;
}

/** Adds whole days to a real `YYYY-MM-DD` date using UTC arithmetic. */
export function addDays(date, days) {
  const parts = parseIsoDate(date);
  if (!parts) throw new RangeError('The reference helper needs a real YYYY-MM-DD date.');
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day) + days * DAY_MS);
  return formatIsoDate(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

/** Day of the week of a real date, 0 for Sunday through 6 for Saturday. */
export function weekdayOf(date) {
  const parts = parseIsoDate(date);
  if (!parts) throw new RangeError('The reference helper needs a real YYYY-MM-DD date.');
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
}

/**
 * The calendar model for "latest date on or before today": scans back one day
 * at a time and returns the first date the predicate accepts, or null when no
 * date within `maxDays` matches.
 */
export function scanBackDate(today, matches, maxDays = 3700) {
  let candidate = today;
  for (let step = 0; step <= maxDays; step += 1) {
    if (matches(candidate)) return candidate;
    candidate = addDays(candidate, -1);
  }
  return null;
}

/**
 * Runs `fn` with the process time zone set to `timeZone` and restores the
 * previous value afterwards. The callback must be synchronous. Node re-reads
 * `TZ` when `process.env.TZ` changes, so `Date` local-time methods follow it.
 */
export function withProcessTimeZone(timeZone, fn) {
  const hadValue = Object.prototype.hasOwnProperty.call(process.env, 'TZ');
  const previous = process.env.TZ;
  process.env.TZ = timeZone;
  try {
    return fn();
  } finally {
    if (hadValue) process.env.TZ = previous;
    else delete process.env.TZ;
  }
}

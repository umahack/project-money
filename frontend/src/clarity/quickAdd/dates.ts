/**
 * Calendar helpers and day-only date resolution for Quick Add.
 *
 * Pure module: it reads no clock, locale, storage, network, or process time zone. Every date is a plain
 * `YYYY-MM-DD` string and all arithmetic uses integer day numbers (proleptic Gregorian calendar), never `Date`
 * or `Intl`. The caller supplies "Today" (the Asia/Kolkata calendar date) and must pass a real date.
 *
 * Requirements: 2.16 to 2.25, 17.6, 17.7.
 */

/** A real calendar date split into numbers. */
export interface CalendarDate {
  year: number;
  month: number; // 1 to 12
  day: number; // 1 to 31
}

/** Sunday is 0 and Saturday is 6. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export const WEEKDAY_NAMES = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** Years before Today's year that the Accepted_Date_Range covers. */
export const ACCEPTED_YEARS_BEFORE = 10;
/** Years after Today's year that the Accepted_Date_Range covers. */
export const ACCEPTED_YEARS_AFTER = 1;

const MIN_YEAR = 1;
const MAX_YEAR = 9999;
/** The longest gap between two 29 Februaries in the Gregorian calendar is 8 years (for example 2096 to 2104). */
const MAX_LEAP_GAP_YEARS = 8;
/** Months scanned back for `on N`: every day 1 to 31 occurs in at least one of any 3 consecutive months. */
const MAX_MONTH_SCAN = 12;

/* ----------------------------- calendar basics ----------------------------- */

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 2:
      return isLeapYear(year) ? 29 : 28;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    default:
      return 31;
  }
}

/** True only for an integer year 1 to 9999, month 1 to 12, and a day that exists in that month and year. */
export function isRealDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (year < MIN_YEAR || year > MAX_YEAR || month < 1 || month > 12 || day < 1) return false;
  return day <= daysInMonth(year, month);
}

const ISO_DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;

/** Reads a strict `YYYY-MM-DD` string. Returns null unless it is exactly that form and a real date. */
export function parseIsoDate(text: string): CalendarDate | null {
  const match = ISO_DATE.exec(text);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return isRealDate(year, month, day) ? { year, month, day } : null;
}

export function isIsoDate(text: string): boolean {
  return parseIsoDate(text) !== null;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/** Writes `YYYY-MM-DD`. The caller passes a real date. */
export function formatIsoDate(year: number, month: number, day: number): string {
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/* ------------------------------ day numbers ------------------------------- */

/** Days since 1970-01-01 for a real date (civil-from-days algorithm, no `Date`). */
function toDayNumber(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const shiftedMonth = month > 2 ? month - 3 : month + 9;
  const dayOfYear = Math.floor((153 * shiftedMonth + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

function fromDayNumber(dayNumber: number): CalendarDate {
  const z = dayNumber + 719468;
  const era = Math.floor(z / 146097);
  const dayOfEra = z - era * 146097;
  const yearOfEra = Math.floor(
    (dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36524) - Math.floor(dayOfEra / 146096)) / 365,
  );
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const shiftedMonth = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * shiftedMonth + 2) / 5) + 1;
  const month = shiftedMonth < 10 ? shiftedMonth + 3 : shiftedMonth - 9;
  const year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0);
  return { year, month, day };
}

function dayNumberOf(date: CalendarDate): number {
  return toDayNumber(date.year, date.month, date.day);
}

/** The weekday of a real date. */
export function weekdayOf(date: CalendarDate): Weekday {
  const dayNumber = dayNumberOf(date);
  // 1970-01-01 was a Thursday (4).
  return ((((dayNumber + 4) % 7) + 7) % 7) as Weekday;
}

/** Adds whole days to an ISO date string. Throws a RangeError when the input is not a real ISO date. */
export function addDaysIso(iso: string, days: number): string {
  const date = requireIsoDate(iso, 'date');
  const next = fromDayNumber(dayNumberOf(date) + days);
  return formatIsoDate(next.year, next.month, next.day);
}

function requireIsoDate(iso: string, name: string): CalendarDate {
  const date = parseIsoDate(iso);
  if (!date) throw new RangeError(`${name} must be a real YYYY-MM-DD date`);
  return date;
}

/* --------------------------- Accepted_Date_Range --------------------------- */

export interface AcceptedDateRange {
  /** First accepted date: 1 January of Today's year minus 10. */
  min: string;
  /** Last accepted date: 31 December of Today's year plus 1. */
  max: string;
}

/** 1 January of Today's year minus 10 through 31 December of Today's year plus 1. */
export function acceptedDateRange(today: string): AcceptedDateRange {
  const { year } = requireIsoDate(today, 'today');
  const first = Math.max(MIN_YEAR, year - ACCEPTED_YEARS_BEFORE);
  const last = Math.min(MAX_YEAR, year + ACCEPTED_YEARS_AFTER);
  return { min: formatIsoDate(first, 1, 1), max: formatIsoDate(last, 12, 31) };
}

/** True when `date` is a real ISO date inside the Accepted_Date_Range of `today`. */
export function isInAcceptedRange(date: string, today: string): boolean {
  if (!isIsoDate(date)) return false;
  const { min, max } = acceptedDateRange(today);
  // Both strings are zero-padded `YYYY-MM-DD`, so string order is date order.
  return date >= min && date <= max;
}

/** Plain-language range, for example `1 January 2015 through 31 December 2026`. */
export function describeAcceptedDateRange(today: string): string {
  const { min, max } = acceptedDateRange(today);
  return `${describeDate(min)} through ${describeDate(max)}`;
}

function describeDate(iso: string): string {
  const date = requireIsoDate(iso, 'date');
  return `${date.day} ${MONTH_NAMES[date.month - 1]} ${date.year}`;
}

/* ------------------------------- Date_Tokens ------------------------------- */

/** One recognized Date_Token. `text` is the token (or token pair) exactly as the caller supplied it. */
export type DateToken =
  | { kind: 'today'; text: string }
  | { kind: 'yesterday'; text: string }
  | { kind: 'weekday'; weekday: Weekday; text: string }
  | { kind: 'dayOfMonth'; day: number; text: string }
  | { kind: 'dayMonth'; day: number; month: number; text: string }
  | { kind: 'fullDate'; year: number; month: number; day: number; text: string };

export interface DateProblem {
  code: 'INVALID_DATE';
  subcode: 'NOT_A_DATE' | 'OUT_OF_RANGE';
  /** The affected text exactly as typed. */
  part: string;
  reason: string;
  correction: string;
}

export interface MultipleDatesProblem {
  code: 'MULTIPLE_DATES';
  part: string;
  reason: string;
  correction: string;
}

export type DateResolution = { ok: true; date: string } | { ok: false; problem: DateProblem };

const ORDINAL = /^([0-9]{1,2})(?:st|nd|rd|th)$/;
const ON_DAY = /^on[ \t\n\v\f\r]+([0-9]{1,2})(?:st|nd|rd|th)?$/;
const DAY_MONTH = /^([0-9]{1,2})\/([0-9]{1,2})$/;
const DAY_MONTH_YEAR = /^([0-9]{1,2})\/([0-9]{1,2})\/([0-9]{2}|[0-9]{4})$/;

/**
 * Recognizes one Date_Token. The form is matched on the NFKC text with letter case ignored, and only ASCII
 * digits count as digits. The result keeps `text` as supplied so problems can name what the User typed.
 *
 * Accepted forms: `today`, `yesterday`, a full weekday name, `on N` (one or more whitespace characters between
 * the two words, optional ordinal suffix), an ordinal such as `3rd`, `dd/mm`, `dd/mm/yy`, `dd/mm/yyyy`, and
 * `yyyy-mm-dd`. Returns null when the text is not a Date_Token, including `on N` with N above 31, which the
 * parser reads as `on` followed by an amount (Requirement 2.19).
 *
 * The returned token can still name no real date (`0th`, `32nd`, `31/02`, `12/25`); `resolveDateToken` reports it.
 */
export function classifyDateToken(text: string): DateToken | null {
  const form = text.normalize('NFKC').toLowerCase();

  if (form === 'today') return { kind: 'today', text };
  if (form === 'yesterday') return { kind: 'yesterday', text };
  const weekday = WEEKDAY_NAMES.indexOf(form as (typeof WEEKDAY_NAMES)[number]);
  if (weekday >= 0) return { kind: 'weekday', weekday: weekday as Weekday, text };

  const on = ON_DAY.exec(form);
  if (on) {
    const day = Number(on[1]);
    return day > 31 ? null : { kind: 'dayOfMonth', day, text };
  }
  const ordinal = ORDINAL.exec(form);
  if (ordinal) return { kind: 'dayOfMonth', day: Number(ordinal[1]), text };

  const dayMonthYear = DAY_MONTH_YEAR.exec(form);
  if (dayMonthYear) {
    const yearText = dayMonthYear[3] as string;
    const year = yearText.length === 2 ? 2000 + Number(yearText) : Number(yearText);
    return { kind: 'fullDate', year, month: Number(dayMonthYear[2]), day: Number(dayMonthYear[1]), text };
  }
  const dayMonth = DAY_MONTH.exec(form);
  if (dayMonth) return { kind: 'dayMonth', day: Number(dayMonth[1]), month: Number(dayMonth[2]), text };

  const iso = ISO_DATE.exec(form);
  if (iso) return { kind: 'fullDate', year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]), text };

  return null;
}

/* ------------------------------- resolution ------------------------------- */

function notADate(token: DateToken): DateResolution {
  return {
    ok: false,
    problem: {
      code: 'INVALID_DATE',
      subcode: 'NOT_A_DATE',
      part: token.text,
      reason: `"${token.text}" is not a real calendar date.`,
      correction:
        'Use a real date such as today, yesterday, a weekday name, on 3rd, 28/02, 28/02/2025, or 2025-02-28.',
    },
  };
}

function outOfRange(token: DateToken, today: string): DateResolution {
  const range = describeAcceptedDateRange(today);
  return {
    ok: false,
    problem: {
      code: 'INVALID_DATE',
      subcode: 'OUT_OF_RANGE',
      part: token.text,
      reason: `"${token.text}" is outside the accepted dates.`,
      correction: `Use a date from ${range}.`,
    },
  };
}

function accept(token: DateToken, date: string, today: string): DateResolution {
  return isInAcceptedRange(date, today) ? { ok: true, date } : outOfRange(token, today);
}

/** Latest date on or before `today` whose day of the month is `day`, skipping months without that day. */
function latestDayOfMonth(today: CalendarDate, day: number): string | null {
  let year = today.year;
  let month = today.month;
  for (let scanned = 0; scanned < MAX_MONTH_SCAN; scanned += 1) {
    if (year < MIN_YEAR) return null;
    const inThisMonth = day <= daysInMonth(year, month);
    const notAfterToday = year < today.year || month < today.month || day <= today.day;
    if (inThisMonth && notAfterToday) return formatIsoDate(year, month, day);
    month -= 1;
    if (month === 0) {
      month = 12;
      year -= 1;
    }
  }
  return null;
}

/** Latest date on or before `today` with this day and month, skipping years without that date. */
function latestDayMonth(today: CalendarDate, day: number, month: number): string | null {
  for (let back = 0; back <= MAX_LEAP_GAP_YEARS; back += 1) {
    const year = today.year - back;
    if (year < MIN_YEAR) return null;
    if (!isRealDate(year, month, day)) continue;
    const candidate = formatIsoDate(year, month, day);
    if (back > 0 || candidate <= formatIsoDate(today.year, today.month, today.day)) return candidate;
  }
  return null;
}

/**
 * Resolves one Date_Token against Today (`YYYY-MM-DD`, Asia/Kolkata). Day-only and relative forms resolve to the
 * latest matching date on or before Today, and a weekday equal to Today's weekday resolves to Today. A token that
 * names no real date returns an `INVALID_DATE` problem with subcode `NOT_A_DATE`, and a date outside the
 * Accepted_Date_Range returns one with subcode `OUT_OF_RANGE`.
 *
 * `today` must be a real `YYYY-MM-DD` date. This is a precondition of the caller, so a violation throws a
 * RangeError; `parseQuickAddLine` must validate it before calling.
 */
export function resolveDateToken(token: DateToken, today: string): DateResolution {
  const now = requireIsoDate(today, 'today');
  const todayNumber = dayNumberOf(now);

  switch (token.kind) {
    case 'today':
      return accept(token, today, today);
    case 'yesterday': {
      const date = fromDayNumber(todayNumber - 1);
      return accept(token, formatIsoDate(date.year, date.month, date.day), today);
    }
    case 'weekday': {
      const back = (weekdayOf(now) - token.weekday + 7) % 7;
      const date = fromDayNumber(todayNumber - back);
      return accept(token, formatIsoDate(date.year, date.month, date.day), today);
    }
    case 'dayOfMonth': {
      if (token.day < 1 || token.day > 31) return notADate(token);
      const date = latestDayOfMonth(now, token.day);
      return date === null ? outOfRange(token, today) : accept(token, date, today);
    }
    case 'dayMonth': {
      if (!isRealDateInSomeYear(token.day, token.month)) return notADate(token);
      const date = latestDayMonth(now, token.day, token.month);
      return date === null ? outOfRange(token, today) : accept(token, date, today);
    }
    case 'fullDate': {
      if (!isRealDate(token.year, token.month, token.day)) return notADate(token);
      return accept(token, formatIsoDate(token.year, token.month, token.day), today);
    }
  }
}

/** A day and month that exist in at least one year (29 February does, 30 February does not). */
function isRealDateInSomeYear(day: number, month: number): boolean {
  return Number.isInteger(day) && Number.isInteger(month) && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(2000, month);
}

/**
 * Classifies and resolves one Date_Token given as text. Returns null when the text is not a Date_Token, so the
 * caller keeps it as an amount candidate or note text.
 */
export function resolveDateText(text: string, today: string): DateResolution | null {
  const token = classifyDateToken(text);
  return token ? resolveDateToken(token, today) : null;
}

/** The problem for a line that holds more than one Date_Token (Requirement 2.24). */
export function multipleDatesProblem(tokens: readonly string[]): MultipleDatesProblem {
  const listed = tokens.map((token) => `"${token}"`).join(', ');
  return {
    code: 'MULTIPLE_DATES',
    part: tokens.join(' '),
    reason: `The line has more than one date: ${listed}.`,
    correction: 'Keep one date, or put the other words in double quotes to use them as the note.',
  };
}

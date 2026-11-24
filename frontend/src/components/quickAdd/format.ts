// Plain-text date labels for the Entry_Preview. They read no clock, locale, or time zone: the weekday comes from the
// same calendar arithmetic as the parser, so a device in any zone shows the date the parser resolved.
import { parseIsoDate, weekdayOf, WEEKDAY_NAMES } from '../../clarity/quickAdd/dates';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

/** `Wednesday, 18 November 2026` (Requirement 3.2: weekday, day, month, and year). Returns the input for a bad date. */
export function formatEntryDate(iso: string): string {
  const date = parseIsoDate(iso);
  if (!date) return iso;
  const weekday = WEEKDAY_NAMES[weekdayOf(date)];
  return `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)}, ${date.day} ${MONTH_NAMES[date.month - 1]} ${date.year}`;
}

/** `November 2026` for `2026-11` or for a full ISO date. */
export function formatMonthYear(monthOrDate: string): string {
  const match = /^(\d{4})-(\d{2})/.exec(monthOrDate);
  if (!match) return monthOrDate;
  const name = MONTH_NAMES[Number(match[2]) - 1];
  return name ? `${name} ${Number(match[1])}` : monthOrDate;
}

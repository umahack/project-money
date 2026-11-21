import { inr, monthLabel } from '../../money';
import type {
  CalculationOperation,
  MoneyValue,
  OutcomeKind,
  OutcomePeriod,
  OutcomeStatus,
  SourceRef,
  ValueClassification,
} from '../../clarity/contracts';

/** Fixed wording required by Requirement 9.8. Mirrors `ActionableInsight.disclaimer`. */
export const INFORMATIONAL_DISCLAIMER = 'Informational guidance, not a guaranteed financial result.' as const;

export const CLASSIFICATION_LABEL: Readonly<Record<ValueClassification, string>> = Object.freeze({
  entered_fact: 'Entered fact',
  calculated_result: 'Calculated result',
  recommendation: 'Recommendation',
});

export interface StatusPresentation {
  /** Text that carries the meaning; color and glyph are only reinforcement. */
  label: string;
  glyph: string;
  tone: 'ok' | 'info' | 'warn' | 'danger';
}

export const STATUS_PRESENTATION: Readonly<Record<OutcomeStatus, StatusPresentation>> = Object.freeze({
  available: { label: 'Confirmed', glyph: '✓', tone: 'ok' },
  missing_input: { label: 'Needs input', glyph: '○', tone: 'info' },
  invalid_input: { label: 'Needs correction', glyph: '!', tone: 'danger' },
  stale: { label: 'Stale', glyph: '◷', tone: 'warn' },
  refresh_failed: { label: 'Refresh failed', glyph: '↻', tone: 'warn' },
  calculation_failed: { label: 'Temporarily unavailable', glyph: '✕', tone: 'danger' },
});

export const OUTCOME_KIND_LABEL: Readonly<Record<OutcomeKind, string>> = Object.freeze({
  monthly_plan: 'monthly plan',
  spending: 'spending guidance',
  goal: 'goal contribution',
  trip: 'trip balance',
  trip_summary: 'trip summary',
});

const OPERATION_LABEL: Readonly<Record<CalculationOperation, string>> = Object.freeze({
  sum: 'Add',
  subtract: 'Subtract',
  maximum: 'Take the larger value',
  multiply_ratio: 'Multiply by a ratio',
  divide: 'Divide',
  round_half_up: 'Round to the nearest paisa (halves up)',
  ceil: 'Round up to the next paisa',
  remainder_adjustment: 'Adjust for the remaining paise',
});

const EXPLANATION_TEXT: Readonly<Record<string, string>> = Object.freeze({
  'monthly_plan.salary': 'Start with the salary entered for this month.',
  'monthly_plan.active_bills': 'Add every bill that applies to this month.',
  'monthly_plan.disposable_income': 'Subtract bills from salary to get disposable income.',
  'monthly_plan.allocation_50_30_20': 'Split disposable income into needs, wants, and savings (50/30/20).',
  'monthly_plan.expenses': 'Add the expenses recorded for this month.',
  'monthly_plan.daily_guide': 'Divide what is left to spend by the days remaining, including today.',
  'trip.allocate_shared_expense': 'Share the expense among members by their split weights.',
  'trip.adjust_allocation_remainder': 'Give any leftover paise to members one at a time so shares add up exactly.',
  'trip.apply_settlement_payment': 'Apply a recorded settlement payment between two members.',
  'trip.calculate_member_balance': 'Work out what each member owes or is owed.',
  'trip.propose_settlement_transfer': 'Propose a transfer that settles the balances.',
});

/** Turns a machine key such as `monthly_plan.salary` into plain words. */
export function humanizeKey(key: string): string {
  const words = key.replace(/[_.\-:]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}

export function operationLabel(operation: CalculationOperation): string {
  return OPERATION_LABEL[operation] ?? humanizeKey(operation);
}

export function explanationText(explanationKey: string): string {
  return EXPLANATION_TEXT[explanationKey] ?? humanizeKey(explanationKey);
}

export function isMoneyValue(value: unknown): value is MoneyValue {
  return !!value
    && typeof value === 'object'
    && (value as MoneyValue).currency === 'INR'
    && Number.isSafeInteger((value as MoneyValue).amountMinor);
}

export function formatMoney(value: MoneyValue | null | undefined): string {
  return value ? inr(value.amountMinor / 100) : '—';
}

export function formatPaise(amountMinor: number): string {
  return inr(amountMinor / 100);
}

/** Plain text for a source or result value. Text only; never interpreted as markup. */
export function formatSourceValue(value: SourceRef['value']): string {
  if (isMoneyValue(value)) return formatMoney(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;

function formatDate(isoDate: string): string {
  const match = ISO_DATE.exec(isoDate);
  if (!match) return isoDate;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function previousDay(isoDate: string): string {
  const match = ISO_DATE.exec(isoDate);
  if (!match) return isoDate;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) - 1));
  return date.toISOString().slice(0, 10);
}

/** `January 2026` for a month period, otherwise an inclusive `1 Jan 2026 to 31 Jan 2026` range. */
export function formatPeriod(period: Pick<OutcomePeriod, 'month' | 'start' | 'endExclusive'>): string {
  if (period.month) return monthLabel(period.month);
  return `${formatDate(period.start)} to ${formatDate(previousDay(period.endExclusive))}`;
}

/** Inclusive date range text such as `1 Jan 2026 to 31 Jan 2026`, used inside explanations. */
export function formatDateRange(period: Pick<OutcomePeriod, 'start' | 'endExclusive'>): string {
  return `${formatDate(period.start)} to ${formatDate(previousDay(period.endExclusive))}`;
}

/** Month keys (`YYYY-MM`) are shown as month names; anything else is shown as given. */
export function formatPeriodKey(key: string): string {
  return /^\d{4}-\d{2}$/.test(key) ? monthLabel(key) : key;
}

export function formatSignedPaise(amountMinor: number): string {
  if (amountMinor === 0) return 'no adjustment';
  const sign = amountMinor > 0 ? '+' : '−';
  return `${sign}${inr(Math.abs(amountMinor) / 100)}`;
}

export function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

// Pure helpers for the Plan page's pay and bill inputs in the clarity branch.
//
// Reading: salary and bills come from the confirmed snapshot's entered facts, so
// the inputs stay populated even when a calculated outcome failed.
//
// Optimistic patches change ENTERED facts only (the salary value, a bill's name,
// amount, and period). They never recompute a calculated result. Disposable
// income, the allocation, and the daily guide keep their last confirmed values
// until the server's confirmed snapshot replaces them.
import { toPaise } from '../money';
import type { FinancialSnapshot, MoneyValue, SourceRef } from './contracts';
import type { SnapshotPatch } from './patchReducer';
import type { ConfirmedInputState, ConfirmedState } from './purposeRegistry';

/** Record id used for a bill row that is only pending creation. */
export const PENDING_BILL_ID = -1;

export const BILL_CATEGORIES = ['EMI', 'Rent', 'Utility', 'Insurance', 'Subscription', 'Other'] as const;
export type BillCategory = (typeof BILL_CATEGORIES)[number];

export const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

const money = (amountMinor: number): MoneyValue => ({ currency: 'INR', amountMinor });

function isMoney(value: SourceRef['value']): value is MoneyValue {
  return typeof value === 'object' && value !== null && Number.isSafeInteger(value.amountMinor);
}

function inMonth(source: SourceRef, month: string): boolean {
  return source.period?.month === undefined || source.period.month === month;
}

/** Entered facts of one type for the month, from the snapshot facts and the plan outcome. */
function sourcesOf(snapshot: FinancialSnapshot, month: string, type: 'salary' | 'bill'): SourceRef[] {
  const plan = snapshot.outcomes.monthlyPlan;
  const candidates = [...snapshot.facts.map((fact) => fact.source), ...plan.sourceRefs];
  const seen = new Set<string>();
  const result: SourceRef[] = [];
  for (const source of candidates) {
    if (source.sourceType !== type || !inMonth(source, month) || !isMoney(source.value)) continue;
    const key = `${source.recordId}:${source.field}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(source);
  }
  return result;
}

/** The confirmed salary for exactly this month, or null. A prior month's salary is never returned. */
export function selectConfirmedSalary(snapshot: FinancialSnapshot | undefined, month: string): MoneyValue | null {
  if (!snapshot || snapshot.period.month !== month) return null;
  const [source] = sourcesOf(snapshot, month, 'salary');
  if (source && isMoney(source.value)) return source.value;
  const value = snapshot.outcomes.monthlyPlan.value?.salary;
  return value && snapshot.outcomes.monthlyPlan.status === 'available' ? value : null;
}

export interface CountedBill {
  id: number;
  label: string;
  amount: MoneyValue;
  /** Null means the bill applies from the beginning. */
  effectiveFromMonth: string | null;
  /** Null means the bill has no end month. */
  effectiveToMonth: string | null;
  /** The row only exists as an optimistic patch. */
  pending: boolean;
}

/** Bills the server counts toward this month. */
export function selectCountedBills(snapshot: FinancialSnapshot | undefined, month: string): CountedBill[] {
  if (!snapshot || snapshot.period.month !== month) return [];
  return sourcesOf(snapshot, month, 'bill')
    .flatMap((source) => (isMoney(source.value) ? [{
      id: source.recordId,
      label: source.label,
      amount: source.value,
      effectiveFromMonth: source.period?.effectiveFromMonth ?? null,
      effectiveToMonth: source.period?.effectiveToMonth ?? null,
      pending: source.recordId === PENDING_BILL_ID,
    }] : []))
    .sort((a, b) => b.id - a.id);
}

function transformSources(
  snapshot: FinancialSnapshot,
  transform: (sources: SourceRef[]) => SourceRef[],
): FinancialSnapshot {
  const plan = snapshot.outcomes.monthlyPlan;
  const factSources = transform(snapshot.facts.map((fact) => fact.source));
  const nextFacts = factSources.map((source) => ({
    classification: 'entered_fact' as const,
    source,
  }));
  return {
    ...snapshot,
    facts: nextFacts,
    outcomes: {
      ...snapshot.outcomes,
      monthlyPlan: { ...plan, sourceRefs: transform(plan.sourceRefs) },
    },
  };
}

function billSource(
  month: string,
  id: number,
  label: string,
  amountMinor: number,
  from: string | null,
  to: string | null,
): SourceRef {
  return {
    ref: `bill:${id}:amountMinor`,
    sourceType: 'bill',
    recordId: id,
    field: 'amountMinor',
    label,
    value: money(amountMinor),
    classification: 'entered_fact',
    period: { month, effectiveFromMonth: from, effectiveToMonth: to },
  };
}

/** Shows the submitted pay as the entered fact. Calculated outcomes stay at their confirmed values. */
export function salaryPatch(month: string, amountMinor: number): SnapshotPatch {
  return (snapshot) => {
    if (snapshot.period.month !== month) return snapshot;
    const next = transformSources(snapshot, (sources) => {
      const found = sources.some((source) => source.sourceType === 'salary');
      if (found) {
        return sources.map((source) => (
          source.sourceType === 'salary' ? { ...source, value: money(amountMinor) } : source
        ));
      }
      return [...sources, {
        ref: 'salary:pending:amountMinor',
        sourceType: 'salary',
        recordId: 0,
        field: 'amountMinor',
        label: `Salary for ${month}`,
        value: money(amountMinor),
        classification: 'entered_fact',
        period: { month },
      } satisfies SourceRef];
    });
    const plan = next.outcomes.monthlyPlan;
    return plan.value
      ? {
          ...next,
          outcomes: {
            ...next.outcomes,
            monthlyPlan: { ...plan, value: { ...plan.value, salary: money(amountMinor) } },
          },
        }
      : next;
  };
}

export interface BillDraftValues {
  label: string;
  amountMinor: number;
  effectiveFromMonth: string | null;
  effectiveToMonth: string | null;
}

/** Adds a pending bill row. The server's confirmed snapshot replaces it with the real record. */
export function billCreatePatch(month: string, draft: BillDraftValues): SnapshotPatch {
  return (snapshot) => {
    if (snapshot.period.month !== month) return snapshot;
    return transformSources(snapshot, (sources) => [
      ...sources,
      billSource(month, PENDING_BILL_ID, draft.label, draft.amountMinor, draft.effectiveFromMonth, draft.effectiveToMonth),
    ]);
  };
}

/** Shows the changed name, amount, and period on one bill row. Whether it still counts waits for the server. */
export function billUpdatePatch(month: string, id: number, changes: Partial<BillDraftValues>): SnapshotPatch {
  return (snapshot) => {
    if (snapshot.period.month !== month) return snapshot;
    return transformSources(snapshot, (sources) => sources.map((source) => {
      if (source.sourceType !== 'bill' || source.recordId !== id) return source;
      return {
        ...source,
        ...(changes.label === undefined ? {} : { label: changes.label }),
        ...(changes.amountMinor === undefined ? {} : { value: money(changes.amountMinor) }),
        period: {
          ...source.period,
          ...(changes.effectiveFromMonth === undefined ? {} : { effectiveFromMonth: changes.effectiveFromMonth }),
          ...(changes.effectiveToMonth === undefined ? {} : { effectiveToMonth: changes.effectiveToMonth }),
        },
      };
    }));
  };
}

/** Parses a rupee amount typed by the user into paise, or null when it is not accepted. */
export function parseMinor(text: string, { allowZero }: { allowZero: boolean }): number | null {
  const stripped = text.replace(/[₹,\s]/g, '');
  if (!/^\d{1,11}(\.\d{1,2})?$/.test(stripped)) return null;
  const minor = toPaise(Number(stripped));
  if (!Number.isSafeInteger(minor) || minor > 100_000_000_000_00) return null;
  if (!allowZero && minor <= 0) return null;
  return minor;
}

/** `+₹5,000`, `−₹2,000`, or `No change`. */
export function formatSignedChange(amountMinor: number, format: (minor: number) => string): string {
  if (amountMinor === 0) return 'No change';
  return `${amountMinor > 0 ? '+' : '−'}${format(Math.abs(amountMinor))}`;
}

export interface FieldProblem {
  /** Plain name of the input, for example "Bill name". */
  field: string;
  reason: string;
  correction: string;
}

export type BillField = 'label' | 'amount' | 'from' | 'until';

export interface BillFieldValues {
  label: string;
  amountMinor: number;
  /** Null when the field is empty, meaning the bill applies from the beginning. */
  effectiveFromMonth: string | null;
  /** Null when the field is empty, meaning the bill has no end month. */
  effectiveToMonth: string | null;
}

export interface BillFieldValidation {
  errors: Partial<Record<BillField, FieldProblem>>;
  /** Present only when every field is valid. */
  values: BillFieldValues | null;
}

export const SALARY_PROBLEM: FieldProblem = {
  field: 'Monthly pay',
  reason: 'is not an accepted amount.',
  correction: 'Enter an amount such as 75000 or 75,000.50, with at most 2 decimals.',
};

/** Checks the text a user typed for a bill. Every message names the input, the reason, and the accepted correction. */
export function validateBillFields(
  input: { label: string; amount: string; from: string; until: string },
  { allowZeroAmount }: { allowZeroAmount: boolean },
): BillFieldValidation {
  const errors: BillFieldValidation['errors'] = {};
  const label = input.label.trim();
  if (label.length < 1 || label.length > 60) {
    errors.label = {
      field: 'Bill name',
      reason: 'must have between 1 and 60 characters.',
      correction: 'Enter a short name, for example Netflix.',
    };
  }
  const amountMinor = parseMinor(input.amount, { allowZero: allowZeroAmount });
  if (amountMinor === null) {
    errors.amount = {
      field: 'Monthly amount',
      reason: allowZeroAmount ? 'is not an accepted amount.' : 'must be an amount above 0.',
      correction: 'Enter an amount such as 649 or 1,250.50, with at most 2 decimals.',
    };
  }
  const from = input.from.trim();
  const until = input.until.trim();
  if (from && !MONTH_PATTERN.test(from)) {
    errors.from = {
      field: 'Counted from',
      reason: 'is not a month.',
      correction: 'Use the form YYYY-MM, for example 2026-07, or leave it empty.',
    };
  }
  if (until && !MONTH_PATTERN.test(until)) {
    errors.until = {
      field: 'Counted until',
      reason: 'is not a month.',
      correction: 'Use the form YYYY-MM, for example 2026-12, or leave it empty.',
    };
  }
  if (!errors.from && !errors.until && from && until && from > until) {
    errors.until = {
      field: 'Counted until',
      reason: 'is before the month it is counted from.',
      correction: 'Choose the same month or a later one.',
    };
  }
  if (Object.keys(errors).length > 0 || amountMinor === null) return { errors, values: null };
  return {
    errors,
    values: {
      label,
      amountMinor,
      effectiveFromMonth: from || null,
      effectiveToMonth: until || null,
    },
  };
}

/** Plain text for the months a bill applies to. */
export function describeBillPeriod(
  from: string | null,
  to: string | null,
  formatMonth: (month: string) => string,
): string {
  if (from && to) return `Counted from ${formatMonth(from)} until ${formatMonth(to)}`;
  if (from) return `Counted from ${formatMonth(from)}, no end month`;
  if (to) return `Counted until ${formatMonth(to)}`;
  return 'Counted every month';
}

/**
 * What the user has already confirmed, for the benefit previews. Salary and bill
 * count as existing only when a confirmed record exists. Outcome values are the
 * server's; nothing is calculated here.
 */
export function planConfirmedState(snapshot: FinancialSnapshot | undefined, month: string): ConfirmedState {
  if (!snapshot) return {};
  const plan = snapshot.outcomes.monthlyPlan;
  const value = plan.status === 'available' ? plan.value : undefined;
  const goal = snapshot.outcomes.goals.find((item) => item.status === 'available' && item.value);
  const outcomes: ConfirmedInputState['outcomes'] = value
    ? {
        disposable_income: value.disposableIncome,
        needs_budget: value.needsBudget,
        wants_budget: value.wantsBudget,
        savings_target: value.savingsTarget,
        spendable_budget: value.spendableBudget,
        daily_spending_guide: value.dailySpendingGuide,
        projected_savings: value.projectedSavings,
        goal_feasibility: goal?.value ? { kind: 'feasibility', value: goal.value.feasibility } : null,
      }
    : {};
  const hasSalary = selectConfirmedSalary(snapshot, month) !== null;
  const hasBills = selectCountedBills(snapshot, month).some((bill) => !bill.pending);
  return {
    ...(hasSalary ? { salary: { outcomes } } : {}),
    ...(hasBills ? { bill: { outcomes } } : {}),
  };
}

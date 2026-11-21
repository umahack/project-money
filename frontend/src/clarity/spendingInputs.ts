// Pure helpers for the Spending page's expense and category-treatment inputs in
// the clarity branch.
//
// Reading: category totals, applied treatments, and every spending outcome come
// from the server's confirmed snapshot. Nothing here adds, subtracts, or divides
// a financial value. The expense list itself is the user's entered facts.
//
// Optimistic changes touch ENTERED facts only: an expense row's own fields while
// its change is pending, and the label of the treatment the user just chose.
// Calculated totals keep their last confirmed values until the server responds.
import { toPaise } from '../money';
import type {
  FinancialSnapshot,
  MoneyValue,
  MutationMetadata,
  SpendingOutcomeValue,
} from './contracts';
import type { SnapshotPatch } from './patchReducer';
import { parseMinor, type FieldProblem } from './planInputs';
import type { ConfirmedState } from './purposeRegistry';

export const EXPENSE_NOTE_MAX = 120;
/** Used until the server's category list loads. */
export const FALLBACK_EXPENSE_CATEGORIES: readonly string[] = Object.freeze(['Food', 'Other']);

export type Treatment = 'needs' | 'wants';
export const TREATMENT_LABEL: Readonly<Record<Treatment, string>> = Object.freeze({ needs: 'Needs', wants: 'Wants' });

/** One expense as `GET /api/finance/expenses` returns it. */
export interface ExpenseRow {
  id: number;
  month: string;
  category: string;
  /** Rupees. */
  amount: number;
  note: string | null;
  spent_on: string | null;
  created_at: string;
}

export interface ExpensesResponse {
  month: string;
  categories: string[];
  expenses: ExpenseRow[];
}

/** An expense with its amount in paise and the date to show. */
export interface ExpenseView {
  id: number;
  month: string;
  category: string;
  amountMinor: number;
  note: string | null;
  /** The saved date, or null for an old row that has none. */
  spentOn: string | null;
  displayDate: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function toExpenseView(row: ExpenseRow): ExpenseView {
  return {
    id: row.id,
    month: row.month,
    category: row.category,
    amountMinor: toPaise(row.amount),
    note: row.note,
    spentOn: row.spent_on,
    displayDate: row.spent_on ?? row.created_at.slice(0, 10),
  };
}

function sortKey(row: ExpenseRow): string {
  return row.spent_on ?? row.created_at.slice(0, 10);
}

/** Newest date first, then newest record first. Matches the server's list order. */
export function sortExpenses(rows: readonly ExpenseRow[]): ExpenseRow[] {
  return [...rows].sort((a, b) => {
    const byDate = sortKey(b).localeCompare(sortKey(a));
    return byDate !== 0 ? byDate : b.id - a.id;
  });
}

/** Reads the confirmed expense record a mutation response carries. Returns null for any other shape. */
export function expenseRowFromRecord(record: unknown, previous?: ExpenseRow): ExpenseRow | null {
  if (!isRecord(record)) return null;
  const { id, month, category, amountMinor, note, spentOn } = record;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return null;
  if (typeof month !== 'string' || typeof category !== 'string') return null;
  if (typeof amountMinor !== 'number' || !Number.isSafeInteger(amountMinor)) return null;
  const date = typeof spentOn === 'string' ? spentOn : null;
  return {
    id,
    month,
    category,
    amount: amountMinor / 100,
    note: typeof note === 'string' ? note : null,
    spent_on: date,
    created_at: previous?.created_at ?? `${date ?? `${month}-01`} 00:00:00`,
  };
}

/**
 * Applies one confirmed expense mutation to the list for `list.month`. A record
 * that now belongs to another month leaves this list; a record that moved in is added.
 * Returns the same object when nothing applies.
 */
export function applyConfirmedExpense(list: ExpensesResponse, mutation: MutationMetadata): ExpensesResponse {
  const id = typeof mutation.recordId === 'number' ? mutation.recordId : null;
  if (id === null) return list;
  const without = list.expenses.filter((row) => row.id !== id);
  if (mutation.operation === 'expense.delete') {
    return without.length === list.expenses.length ? list : { ...list, expenses: without };
  }
  if (mutation.operation !== 'expense.create' && mutation.operation !== 'expense.update') return list;
  const previous = list.expenses.find((row) => row.id === id);
  const row = expenseRowFromRecord(mutation.record, previous);
  if (!row) return list;
  if (row.month !== list.month) return { ...list, expenses: without };
  return { ...list, expenses: sortExpenses([...without, row]) };
}

/* ------------------------------ Validation ------------------------------ */

export type ExpenseField = 'amount' | 'category' | 'note' | 'date';

export interface ExpenseFieldInput {
  amount: string;
  category: string;
  note: string;
  /** `YYYY-MM-DD`. Only the edit form has a date. */
  date?: string;
}

export interface ExpenseFieldValues {
  amountMinor: number;
  category: string;
  note: string | null;
  /** Null when the form has no date field. */
  spentOn: string | null;
}

export interface ExpenseValidation {
  errors: Partial<Record<ExpenseField, FieldProblem>>;
  /** Present only when every field is valid. */
  values: ExpenseFieldValues | null;
}

/** First and last year the server accepts for an expense date, around `now`. */
export function expenseYearRange(now: Date = new Date()): { min: number; max: number } {
  const year = now.getFullYear();
  return { min: year - 10, max: year + 1 };
}

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * Checks what the user typed for an expense. Every message names the input, the
 * reason, and the accepted correction, and valid fields are never cleared.
 */
export function validateExpenseFields(
  input: ExpenseFieldInput,
  options: { categories: readonly string[]; withDate: boolean; now?: Date },
): ExpenseValidation {
  const errors: ExpenseValidation['errors'] = {};
  const amountMinor = parseMinor(input.amount, { allowZero: false });
  if (amountMinor === null) {
    errors.amount = {
      field: 'Amount',
      reason: 'must be an amount above 0.',
      correction: 'Enter an amount such as 480 or 1,250.50, with at most 2 decimals.',
    };
  }
  if (!input.category || (options.categories.length > 0 && !options.categories.includes(input.category))) {
    errors.category = {
      field: 'Category',
      reason: 'is not one of your categories.',
      correction: 'Choose a category from the list. You can add categories in Settings.',
    };
  }
  const note = input.note.trim();
  if (note.length > EXPENSE_NOTE_MAX) {
    errors.note = {
      field: 'Note',
      reason: `has ${note.length} characters.`,
      correction: `Shorten it to at most ${EXPENSE_NOTE_MAX} characters, or leave it empty.`,
    };
  }
  let spentOn: string | null = null;
  if (options.withDate) {
    const date = (input.date ?? '').trim();
    const { min, max } = expenseYearRange(options.now);
    const year = Number(date.slice(0, 4));
    if (!isCalendarDate(date) || year < min || year > max) {
      errors.date = {
        field: 'Date',
        reason: date ? 'is not an accepted date.' : 'is required.',
        correction: `Pick a real day between 1 January ${min} and 31 December ${max}.`,
      };
    } else {
      spentOn = date;
    }
  }
  if (Object.keys(errors).length > 0 || amountMinor === null) return { errors, values: null };
  return { errors, values: { amountMinor, category: input.category, note: note || null, spentOn } };
}

/* ------------------------- Snapshot selectors --------------------------- */

const VALUE_STATUSES: ReadonlySet<string> = new Set(['available', 'stale', 'refresh_failed']);

/** The spending value for exactly this month when the outcome has one to show. */
export function selectSpendingValue(
  snapshot: FinancialSnapshot | undefined,
  month: string,
): SpendingOutcomeValue | undefined {
  if (!snapshot || snapshot.period.month !== month) return undefined;
  const outcome = snapshot.outcomes.spending;
  return VALUE_STATUSES.has(outcome.status) ? outcome.value : undefined;
}

export interface CategoryTotalView {
  category: string;
  total: MoneyValue;
}

/** The server's category totals for this month, largest first. */
export function selectCategoryTotals(snapshot: FinancialSnapshot | undefined, month: string): CategoryTotalView[] {
  const value = selectSpendingValue(snapshot, month);
  if (!value) return [];
  return value.categoryTotals
    .filter((total) => total.month === month)
    .map((total) => ({ category: total.category, total: total.total }))
    .sort((a, b) => b.total.amountMinor - a.total.amountMinor || a.category.localeCompare(b.category));
}

export interface CategoryTreatment {
  category: string;
  treatment: Treatment;
  /** `override` is the user's own choice; `default` is the product's. */
  source: 'default' | 'override';
  recordId?: number;
}

/** The treatment the server applied to each category with spending this month. */
export function selectCategoryTreatments(
  snapshot: FinancialSnapshot | undefined,
  month: string,
): ReadonlyMap<string, CategoryTreatment> {
  const result = new Map<string, CategoryTreatment>();
  const value = selectSpendingValue(snapshot, month);
  for (const applied of value?.appliedTreatments ?? []) {
    if (result.has(applied.category)) continue;
    result.set(applied.category, {
      category: applied.category,
      treatment: applied.treatment,
      source: applied.source,
      ...(applied.treatmentRecordId === undefined ? {} : { recordId: applied.treatmentRecordId }),
    });
  }
  return result;
}

/** Scope for one category's treatment control. Case-insensitive, like the server's. */
export function treatmentScope(category: string): string {
  return `category-treatment:${encodeURIComponent(category.toLocaleLowerCase('en-IN'))}`;
}

/**
 * Shows the treatment the user just chose. Needs and Wants spending, the
 * excess, and the daily guide keep their last confirmed values until the
 * server's snapshot replaces them.
 */
export function treatmentPatch(month: string, category: string, treatment: Treatment): SnapshotPatch {
  return (snapshot) => {
    if (snapshot.period.month !== month) return snapshot;
    const spending = snapshot.outcomes.spending;
    if (!spending.value) return snapshot;
    const folded = category.toLocaleLowerCase('en-IN');
    return {
      ...snapshot,
      outcomes: {
        ...snapshot.outcomes,
        spending: {
          ...spending,
          value: {
            ...spending.value,
            appliedTreatments: spending.value.appliedTreatments.map((applied) => (
              applied.category.toLocaleLowerCase('en-IN') === folded
                ? { ...applied, treatment, source: 'override' as const }
                : applied
            )),
          },
        },
      },
    };
  };
}

/**
 * What the user has already confirmed for the expense input, for the benefit
 * preview. An expense counts as existing once one is saved this month. The
 * category total is the server's total for the selected category, or ₹0 when
 * the server lists no spending for it. Other values are the server's.
 */
export function spendingConfirmedState(
  snapshot: FinancialSnapshot | undefined,
  month: string,
  options: { hasExpenses: boolean; category: string },
): ConfirmedState {
  const value = selectSpendingValue(snapshot, month);
  const hasExpenses = options.hasExpenses || (value?.categoryTotals.length ?? 0) > 0;
  if (!hasExpenses) return {};
  if (!value) return { expense: { outcomes: {} } };
  const total = value.categoryTotals.find((item) => item.month === month && item.category === options.category);
  return {
    expense: {
      outcomes: {
        category_total: total?.total ?? { currency: 'INR', amountMinor: 0 },
        remaining_spendable_budget: value.remainingSpendable,
        daily_spending_guide: value.dailySpendingGuide,
        projected_savings: value.projectedSavings,
      },
    },
  };
}

/* --------------------------- Change summaries --------------------------- */

export interface ExpenseTransition {
  type: string;
  originalPeriod: string | null;
  resultingPeriod: string | null;
  originalCategory: string | null;
  resultingCategory: string | null;
  affectedPeriods: string[];
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * The original and resulting month and category the server reports for an
 * expense change. Returns null when the response has no transition.
 */
export function readExpenseTransition(mutation: unknown): ExpenseTransition | null {
  if (!isRecord(mutation)) return null;
  const source = isRecord(mutation.expenseTransition) ? mutation.expenseTransition : mutation;
  const periods = Array.isArray(source.affectedPeriods)
    ? source.affectedPeriods.filter((item): item is string => typeof item === 'string')
    : [];
  const type = textOrNull(source.type) ?? textOrNull(mutation.operation) ?? 'update';
  return {
    type,
    originalPeriod: textOrNull(source.originalPeriod),
    resultingPeriod: textOrNull(source.resultingPeriod),
    originalCategory: textOrNull(source.originalCategory),
    resultingCategory: textOrNull(source.resultingCategory),
    affectedPeriods: periods,
  };
}

/** One plain sentence that says what the confirmed change did and which months were recalculated. */
export function describeExpenseTransition(
  transition: ExpenseTransition,
  formatMonth: (month: string) => string,
): string {
  const { originalPeriod, resultingPeriod, originalCategory, resultingCategory } = transition;
  let sentence: string;
  if (originalPeriod === null && resultingPeriod !== null) {
    sentence = `Added to ${resultingCategory ?? 'your expenses'} for ${formatMonth(resultingPeriod)}.`;
  } else if (resultingPeriod === null && originalPeriod !== null) {
    sentence = `Removed from ${originalCategory ?? 'your expenses'} for ${formatMonth(originalPeriod)}.`;
  } else if (originalPeriod !== null && resultingPeriod !== null
    && (originalPeriod !== resultingPeriod || originalCategory !== resultingCategory)) {
    sentence = `Moved from ${originalCategory ?? 'its category'} in ${formatMonth(originalPeriod)} to ${resultingCategory ?? 'its category'} in ${formatMonth(resultingPeriod)}.`;
  } else if (resultingPeriod !== null) {
    sentence = `Updated ${resultingCategory ?? 'the expense'} for ${formatMonth(resultingPeriod)}.`;
  } else {
    sentence = 'Expense updated.';
  }
  const months = [...new Set(transition.affectedPeriods)];
  if (months.length === 0) return sentence;
  return `${sentence} Recalculated: ${months.map(formatMonth).join(' and ')}.`;
}

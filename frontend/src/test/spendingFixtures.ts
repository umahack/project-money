import type {
  FinancialSnapshot,
  MutationEnvelope,
  Outcome,
  SpendingOutcomeValue,
} from '../clarity/contracts';
import type { ExpenseRow } from '../clarity/spendingInputs';
import { NO_HIGHLIGHTS, NEEDS_ACTION, homeSnapshot, rupees } from './homeSummaryFixtures';

export { NEEDS_ACTION, rupees };

const NEEDS_CATEGORIES = new Set(['Food', 'Groceries', 'Transport', 'Bills', 'Health']);
const min = (rupeesAmount: number) => Math.round(rupeesAmount * 100);

export interface SpendingExpenseFixture {
  id: number;
  category: string;
  /** Rupees. */
  amount: number;
  /** An override the user chose. Omit for the default treatment. */
  override?: { treatment: 'needs' | 'wants'; recordId: number };
}

export interface SpendingSnapshotOptions {
  dataVersion?: number;
  expenses?: SpendingExpenseFixture[];
  /** Rupees. */
  needsBudget?: number;
  /** Rupees. */
  wantsBudget?: number;
  spending?: Partial<Outcome<SpendingOutcomeValue>>;
  actions?: FinancialSnapshot['actions'];
}

/**
 * A confirmed snapshot whose spending outcome stands in for the server's: round
 * budgets (Needs 40,000, Wants 24,000), a 17-day month, and a 16,000 savings target.
 * The arithmetic here plays the server; the page under test never repeats it.
 */
export function spendingSnapshot(month: string, options: SpendingSnapshotOptions = {}): FinancialSnapshot {
  const dataVersion = options.dataVersion ?? 1;
  const expenses = options.expenses ?? [];
  const needsBudget = options.needsBudget ?? 40000;
  const wantsBudget = options.wantsBudget ?? 24000;
  const treatmentOf = (expense: SpendingExpenseFixture) => expense.override?.treatment
    ?? (NEEDS_CATEGORIES.has(expense.category) ? 'needs' : 'wants');
  const sum = (items: SpendingExpenseFixture[]) => items.reduce((total, item) => total + min(item.amount), 0);
  const needsSpent = sum(expenses.filter((e) => treatmentOf(e) === 'needs'));
  const wantsSpent = sum(expenses.filter((e) => treatmentOf(e) === 'wants'));
  const total = needsSpent + wantsSpent;
  const spendable = min(needsBudget + wantsBudget);
  const remaining = spendable - total;
  const projected = Math.max(0, min(80000) - total);
  const categories = [...new Set(expenses.map((e) => e.category))];
  const exceeded: SpendingOutcomeValue['exceededBudgetActions'] = [];
  for (const [bucket, spent, budget] of [['needs', needsSpent, min(needsBudget)], ['wants', wantsSpent, min(wantsBudget)]] as const) {
    if (spent > budget) {
      exceeded.push({
        conditionCode: `${bucket}_budget_exceeded`,
        bucket,
        budgetMinor: budget,
        spentMinor: spent,
        excessMinor: spent - budget,
        actionKey: `address_${bucket}_budget_excess`,
        actionLabel: `Review ${bucket === 'needs' ? 'Needs' : 'Wants'} spending`,
        correctiveAction: `Reduce ${bucket === 'needs' ? 'Needs' : 'Wants'} spending or reclassify an incorrectly treated expense.`,
      });
    }
  }
  const value: SpendingOutcomeValue = {
    month,
    categoryTotals: categories.map((category) => ({
      month,
      category,
      total: { currency: 'INR', amountMinor: sum(expenses.filter((e) => e.category === category)) },
      expenseIds: expenses.filter((e) => e.category === category).map((e) => e.id),
    })),
    appliedTreatments: expenses.map((expense) => ({
      expenseId: expense.id,
      category: expense.category,
      treatment: treatmentOf(expense),
      source: expense.override ? 'override' as const : 'default' as const,
      ...(expense.override ? { treatmentRecordId: expense.override.recordId } : {}),
    })),
    needsBudget: rupees(needsBudget),
    wantsBudget: rupees(wantsBudget),
    needsSpent: { currency: 'INR', amountMinor: needsSpent },
    wantsSpent: { currency: 'INR', amountMinor: wantsSpent },
    totalSpending: { currency: 'INR', amountMinor: total },
    spendableBudget: { currency: 'INR', amountMinor: spendable },
    remainingSpendable: { currency: 'INR', amountMinor: remaining },
    dailySpendingGuide: { currency: 'INR', amountMinor: Math.round(remaining / 17) },
    savingsTarget: rupees(16000),
    projectedSavings: { currency: 'INR', amountMinor: projected },
    projectedSavingsDifference: { currency: 'INR', amountMinor: projected - min(16000) },
    exceededBudgetActions: exceeded,
  };
  const base = homeSnapshot(month, {
    dataVersion,
    actions: options.actions ?? [],
    highlights: NO_HIGHLIGHTS,
    goals: [],
    trips: [],
  });
  return {
    ...base,
    outcomes: {
      ...base.outcomes,
      spending: { ...base.outcomes.spending, dataVersion, value, ...options.spending },
    },
  };
}

/** One expense as `GET /api/finance/expenses` returns it. */
export function expenseRow(
  id: number,
  category: string,
  amount: number,
  month: string,
  extra: Partial<Pick<ExpenseRow, 'note' | 'spent_on'>> = {},
): ExpenseRow {
  const day = extra.spent_on === undefined ? `${month}-10` : extra.spent_on;
  return {
    id,
    month: day ? day.slice(0, 7) : month,
    category,
    amount,
    note: extra.note ?? null,
    spent_on: day,
    created_at: `${day ?? `${month}-10`} 09:00:00`,
  };
}

export interface ExpenseEnvelopeOptions {
  scopeKey: string;
  operation: 'expense.create' | 'expense.update' | 'expense.delete' | 'category_treatment.set' | 'category_treatment.remove';
  recordType: 'expense' | 'category_treatment';
  recordId: number;
  recordVersion?: number;
  changeId?: number;
  record?: Record<string, unknown> | null;
  /** Fields the server adds for expense changes. */
  transition?: {
    type: string;
    originalPeriod: string | null;
    resultingPeriod: string | null;
    originalCategory: string | null;
    resultingCategory: string | null;
    affectedPeriods: string[];
  };
}

/** The body of a confirmed expense or treatment response (X-Clarity-Contract: 1). */
export function expenseEnvelope(snapshot: FinancialSnapshot, options: ExpenseEnvelopeOptions): MutationEnvelope & { ok: true } {
  return {
    ok: true,
    schemaVersion: 1,
    mutation: {
      changeId: options.changeId ?? 200 + snapshot.dataVersion,
      idempotencyKey: 'server-key',
      scopeKey: options.scopeKey,
      operation: options.operation,
      recordType: options.recordType,
      recordId: options.recordId,
      status: 'confirmed',
      recordVersion: options.recordVersion ?? 1,
      record: options.record,
      ...(options.transition ? { expenseTransition: options.transition, ...options.transition } : {}),
    } as MutationEnvelope['mutation'],
    clarity: snapshot,
  };
}

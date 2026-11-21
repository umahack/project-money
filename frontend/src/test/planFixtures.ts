import type {
  ActionableInsight,
  FinancialSnapshot,
  MonthlyPlanValue,
  MutationEnvelope,
  Outcome,
  PlanDeltas,
  SourceRef,
} from '../clarity/contracts';
import { BILLS_ACTION, NO_HIGHLIGHTS, homeSnapshot, rupees } from './homeSummaryFixtures';

export { BILLS_ACTION, rupees };

export interface PlanBillFixture {
  id: number;
  label: string;
  amountMinor: number;
  from?: string | null;
  to?: string | null;
}

export interface PlanSnapshotOptions {
  dataVersion?: number;
  /** Salary in paise. Omit or pass null for no confirmed salary for the month. */
  salaryMinor?: number | null;
  bills?: PlanBillFixture[];
  plan?: Partial<Outcome<MonthlyPlanValue>>;
  actions?: ActionableInsight[];
}

const min = (rupeesAmount: number) => Math.round(rupeesAmount * 100);

/**
 * A confirmed Plan snapshot for one month. Values use round figures so tests can read
 * them: disposable income is salary minus bills, split 50/30/20, with no spending yet.
 * Entered facts (salary and bills) are present in `facts` even when an outcome failed.
 */
export function planSnapshot(month: string, options: PlanSnapshotOptions = {}): FinancialSnapshot {
  const dataVersion = options.dataVersion ?? 1;
  const bills = options.bills ?? [];
  const salaryMinor = options.salaryMinor === undefined ? min(75000) : options.salaryMinor;
  const billsTotal = bills.reduce((sum, bill) => sum + bill.amountMinor, 0);
  const salary = salaryMinor ?? 0;
  const disposable = Math.max(0, salary - billsTotal);
  const needs = Math.round(disposable * 0.5);
  const wants = Math.round(disposable * 0.3);
  const savings = disposable - needs - wants;
  const daysLeft = 17;

  const sources: SourceRef[] = [];
  if (salaryMinor !== null) {
    sources.push({
      ref: 'salary:5:amountMinor',
      sourceType: 'salary',
      recordId: 5,
      field: 'amountMinor',
      label: `Salary for ${month}`,
      value: rupees(salaryMinor / 100),
      classification: 'entered_fact',
      period: { month },
    });
  }
  for (const bill of bills) {
    sources.push({
      ref: `bill:${bill.id}:amountMinor`,
      sourceType: 'bill',
      recordId: bill.id,
      field: 'amountMinor',
      label: bill.label,
      value: rupees(bill.amountMinor / 100),
      classification: 'entered_fact',
      period: { month, effectiveFromMonth: bill.from ?? null, effectiveToMonth: bill.to ?? null },
    });
  }

  const base = homeSnapshot(month, {
    dataVersion,
    actions: options.actions ?? [],
    highlights: NO_HIGHLIGHTS,
    goals: [],
    trips: [],
  });
  const available = salaryMinor !== null;
  const plan: Outcome<MonthlyPlanValue> = {
    ...base.outcomes.monthlyPlan,
    status: available ? 'available' : 'missing_input',
    value: available
      ? {
          salary: rupees(salary / 100),
          activeBillsTotal: rupees(billsTotal / 100),
          shortfall: rupees(Math.max(0, billsTotal - salary) / 100),
          disposableIncome: rupees(disposable / 100),
          needsBudget: rupees(needs / 100),
          wantsBudget: rupees(wants / 100),
          savingsTarget: rupees(savings / 100),
          spendableBudget: rupees((needs + wants) / 100),
          needsSpent: rupees(0),
          wantsSpent: rupees(0),
          remainingSpendable: rupees((needs + wants) / 100),
          dailySpendingGuide: rupees(Math.round((needs + wants) / daysLeft) / 100),
          projectedSavings: rupees(disposable / 100),
        }
      : undefined,
    missing: available ? undefined : [{ input: 'salary', unlocks: ['monthly_plan', 'spending'] }],
    sourceRefs: sources,
    ...options.plan,
  };
  return {
    ...base,
    facts: sources.map((source) => ({ classification: 'entered_fact' as const, source })),
    outcomes: { ...base.outcomes, monthlyPlan: plan },
  };
}

export interface EnvelopeOptions {
  scopeKey: string;
  operation: string;
  recordType: 'salary' | 'bill';
  recordId: number;
  recordVersion?: number;
  changeId?: number;
  idempotencyKey?: string;
  planDeltas?: PlanDeltas;
  record?: Record<string, unknown> | null;
}

/** The body of a confirmed salary or bill mutation response (X-Clarity-Contract: 1). */
export function mutationEnvelope(snapshot: FinancialSnapshot, options: EnvelopeOptions): MutationEnvelope & { ok: true } {
  return {
    ok: true,
    schemaVersion: 1,
    mutation: {
      changeId: options.changeId ?? 100 + snapshot.dataVersion,
      idempotencyKey: options.idempotencyKey ?? 'server-key',
      scopeKey: options.scopeKey,
      operation: options.operation,
      recordType: options.recordType,
      recordId: options.recordId,
      status: 'confirmed',
      recordVersion: options.recordVersion ?? 1,
      planDeltas: options.planDeltas,
      record: options.record,
    },
    clarity: snapshot,
  };
}

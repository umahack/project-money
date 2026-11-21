// A closed, in-memory stand-in for the salary, bill, snapshot, and explanation
// endpoints of the financial clarity contract (contract version 1).
//
// It is transport-free: `handle()` takes a request and returns a status and a
// JSON body. Vitest wraps it in a `fetch` mock and Playwright wraps it in route
// responders, so both suites exercise the same contract:
//
// - `GET /finance/clarity?month=` returns `{ schemaVersion, snapshot }`.
// - `POST /finance/salary`, `POST /finance/salary/apply`, `POST /finance/emis`,
//   `PATCH /finance/emis/:id`, and `DELETE /finance/emis/:id` return a mutation
//   envelope `{ ok, schemaVersion, mutation, clarity }` with server-calculated
//   `planDeltas`, the confirmed record, and a new `dataVersion`.
// - `expectedRecordVersion` is checked; a mismatch is a 409 RECORD_VERSION_CONFLICT.
// - The same `Idempotency-Key` replays the first confirmed response.
// - `GET /finance/explanations/:outcomeId?version=` returns ordered sources and steps.
//
// All amounts are whole paise. Nothing here reads a clock, the network, or a database.
import type {
  ActionableInsight,
  CalculationExplanation,
  ExplanationResponse,
  FinancialSnapshot,
  MoneyValue,
  MonthlyPlanValue,
  Outcome,
  PlanDeltas,
  SourceRef,
  SpendingOutcomeValue,
} from '../clarity/contracts';
import {
  BILLS_ACTION,
  GOAL_ACTION,
  TRIP_ACTION,
  goalOutcome,
  homeSnapshot,
  spendingOutcome,
  tripItemOutcome,
} from './homeSummaryFixtures';
import { mutationEnvelope, planSnapshot } from './planFixtures';

export interface FakeBill {
  id: number;
  label: string;
  amountMinor: number;
  category: string;
  active: boolean;
  /** First month counted, or null for "from the start". */
  from: string | null;
  /** Last month counted, or null for "no end month". */
  to: string | null;
  version: number;
}

export interface FakeSalary {
  id: number;
  month: string;
  amountMinor: number;
  version: number;
}

export interface BackendRequest {
  method: string;
  /** Path below `/api`, without the query string, such as `/finance/emis/7`. */
  path: string;
  query?: URLSearchParams;
  body?: unknown;
  /** Header names in lower case. */
  headers?: Record<string, string>;
}

export interface BackendReply {
  status: number;
  body: unknown;
}

export interface FakeBackendInit {
  /** Confirmed pay for the viewed month in paise. Null or omitted means none is saved. */
  salaryMinor?: number | null;
  /** An earlier month's pay, offered for explicit application. */
  priorSalary?: { month: string; amountMinor: number };
  bills?: Array<Partial<FakeBill> & Pick<FakeBill, 'label' | 'amountMinor'>>;
  /** Return explanation sources and steps out of order, to prove the client orders them. */
  unorderedExplanations?: boolean;
}

const DAYS_REMAINING = 17;
const SALARY_ID = 5;
const GOAL_ID = 7;
const TRIP_ID = 3;
const rupeesOf = (minor: number): MoneyValue => ({ currency: 'INR', amountMinor: minor });

function error(status: number, code: string, message: string, extra: Record<string, unknown> = {}): BackendReply {
  return { status, body: { error: { code, message, ...extra } } };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export class FakeClarityBackend {
  readonly month: string;
  dataVersion = 1;
  salary: FakeSalary | null;
  readonly priorSalary: { month: string; amountMinor: number } | null;
  readonly bills: FakeBill[];
  /** Every request this backend handled, in order. */
  readonly log: Array<{ method: string; path: string; body: unknown }> = [];
  private nextBillId: number;
  private nextChangeId = 100;
  private readonly unordered: boolean;
  private readonly replies = new Map<string, BackendReply>();
  private readonly injected = new Map<string, BackendReply[]>();

  constructor(month: string, init: FakeBackendInit = {}) {
    this.month = month;
    this.unordered = init.unorderedExplanations === true;
    this.salary = init.salaryMinor === undefined || init.salaryMinor === null
      ? null
      : { id: SALARY_ID, month, amountMinor: init.salaryMinor, version: 1 };
    this.priorSalary = init.priorSalary ?? null;
    this.bills = (init.bills ?? []).map((bill, index) => ({
      id: index + 1,
      category: 'EMI',
      active: true,
      from: null,
      to: null,
      version: 1,
      ...bill,
    }));
    this.nextBillId = this.bills.length + 1;
  }

  /** The next request for `METHOD /path` fails with this reply, and no state changes. */
  failNext(method: string, path: string, status: number, code: string, message: string): void {
    const key = `${method} ${path}`;
    const queue = this.injected.get(key) ?? [];
    queue.push(error(status, code, message));
    this.injected.set(key, queue);
  }

  /** Outcomes after the confirmed change, as a complete confirmed snapshot. */
  snapshot(): FinancialSnapshot {
    const month = this.month;
    const counted = this.bills.filter((bill) => this.counts(bill));
    const salaryMinor = this.salary?.amountMinor ?? null;
    const shortfall = salaryMinor !== null && counted.reduce((sum, bill) => sum + bill.amountMinor, 0) > salaryMinor;
    const actions: ActionableInsight[] = [
      ...(shortfall ? [{ ...BILLS_ACTION, shortfall: rupeesOf(this.shortfallMinor(counted, salaryMinor)) }] : []),
      GOAL_ACTION,
      TRIP_ACTION,
    ];
    const plan = planSnapshot(month, {
      dataVersion: this.dataVersion,
      salaryMinor,
      bills: counted.map((bill) => ({
        id: bill.id,
        label: bill.label,
        amountMinor: bill.amountMinor,
        from: bill.from,
        to: bill.to,
      })),
    });
    const planOutcome = plan.outcomes.monthlyPlan;
    const spending = this.spendingFrom(planOutcome);
    const snapshot = homeSnapshot(month, {
      dataVersion: this.dataVersion,
      actions,
      plan: planOutcome,
      spending,
      goals: [goalOutcome(GOAL_ID, month, this.dataVersion)],
      trips: [tripItemOutcome(TRIP_ID, month, this.dataVersion)],
    });
    return { ...snapshot, facts: plan.facts };
  }

  handle(request: BackendRequest): BackendReply {
    const method = request.method.toUpperCase();
    const path = request.path;
    this.log.push({ method, path, body: request.body });
    const key = `${method} ${path}`;
    const injected = this.injected.get(key)?.shift();
    if (injected) return injected;

    if (method === 'GET') return this.read(path, request.query);
    const idempotencyKey = request.headers?.['idempotency-key'];
    if (idempotencyKey && this.replies.has(idempotencyKey)) {
      const first = this.replies.get(idempotencyKey) as BackendReply;
      const envelope = asRecord(first.body);
      return {
        status: first.status,
        body: { ...envelope, mutation: { ...asRecord(envelope.mutation), replayed: true } },
      };
    }
    const reply = this.mutate(method, path, asRecord(request.body), idempotencyKey ?? 'server-key');
    if (idempotencyKey && reply.status === 200) this.replies.set(idempotencyKey, reply);
    return reply;
  }

  // ---- reads ----

  private read(path: string, query: URLSearchParams | undefined): BackendReply {
    if (path === '/finance/clarity') {
      const requested = query?.get('month');
      if (requested && requested !== this.month) return error(404, 'MONTH_NOT_FOUND', 'Only the fixture month is available.');
      return { status: 200, body: { schemaVersion: 1, snapshot: this.snapshot() } };
    }
    if (path === '/finance/emis') {
      return {
        status: 200,
        body: {
          emis: this.bills.map((bill) => ({
            id: bill.id,
            label: bill.label,
            amount: bill.amountMinor / 100,
            category: bill.category,
          })),
        },
      };
    }
    if (path === '/finance/salary') {
      const latest = this.salary
        ? { month: this.salary.month, amount: this.salary.amountMinor / 100 }
        : this.priorSalary
          ? { month: this.priorSalary.month, amount: this.priorSalary.amountMinor / 100 }
          : null;
      return { status: 200, body: { salary: latest } };
    }
    const explanation = /^\/finance\/explanations\/(.+)$/.exec(path);
    if (explanation) {
      const outcomeId = decodeURIComponent(explanation[1] as string);
      return this.explain(outcomeId, Number(query?.get('version')));
    }
    return error(404, 'NOT_FOUND', `No fixture for GET ${path}.`);
  }

  private explain(outcomeId: string, requestedVersion: number): BackendReply {
    if (outcomeId !== `monthly-plan:${this.month}`) return error(404, 'OUTCOME_NOT_FOUND', 'No explanation for this outcome.');
    if (Number.isFinite(requestedVersion) && requestedVersion > this.dataVersion) {
      return error(409, 'DATA_VERSION_NOT_AVAILABLE', 'That version is not confirmed yet.', { currentVersion: this.dataVersion });
    }
    const response: ExplanationResponse = {
      schemaVersion: 1,
      ...(Number.isFinite(requestedVersion) && requestedVersion < this.dataVersion
        ? { supersededByVersion: this.dataVersion }
        : {}),
      explanation: this.explanation(),
    };
    return { status: 200, body: response };
  }

  /** Salary first, then bills, then the ordered steps from entered facts to the daily guide. */
  explanation(): CalculationExplanation<MonthlyPlanValue> {
    const snapshot = this.snapshot();
    const plan = snapshot.outcomes.monthlyPlan;
    const value = plan.value as MonthlyPlanValue;
    const counted = this.bills.filter((bill) => this.counts(bill));
    const sources: SourceRef[] = [
      { ...(plan.sourceRefs.find((source) => source.sourceType === 'salary') as SourceRef), order: 1 },
      ...counted.map((bill, index) => ({
        ...(plan.sourceRefs.find((source) => source.sourceType === 'bill' && source.recordId === bill.id) as SourceRef),
        order: index + 2,
      })),
    ];
    const billRefs = sources.filter((source) => source.sourceType === 'bill').map((source) => source.ref as string);
    const operations: CalculationExplanation['operations'] = [
      { order: 1, operation: 'sum', operandRefs: [sources[0]?.ref as string], result: value.salary, explanationKey: 'monthly_plan.salary' },
      { order: 2, operation: 'sum', operandRefs: billRefs, result: value.activeBillsTotal, explanationKey: 'monthly_plan.active_bills' },
      {
        order: 3,
        operation: 'subtract',
        operandRefs: [sources[0]?.ref as string, ...billRefs],
        result: value.disposableIncome,
        explanationKey: 'monthly_plan.disposable_income',
      },
      {
        order: 4,
        operation: 'multiply_ratio',
        operandRefs: ['disposable_income'],
        result: value.needsBudget,
        explanationKey: 'monthly_plan.allocation_50_30_20',
        rounding: { precisionMinor: 1, direction: 'half_up', adjustmentMinor: 0 },
        intermediateResults: { needsBudget: value.needsBudget, wantsBudget: value.wantsBudget, savingsTarget: value.savingsTarget },
        intermediateResultClassifications: {
          needsBudget: 'calculated_result',
          wantsBudget: 'calculated_result',
          savingsTarget: 'calculated_result',
        },
      },
      {
        order: 5,
        operation: 'divide',
        operandRefs: ['spendable_budget'],
        divisor: DAYS_REMAINING,
        result: value.dailySpendingGuide,
        explanationKey: 'monthly_plan.daily_guide',
      },
    ];
    return {
      schemaVersion: 1,
      outcomeId: plan.id,
      kind: 'monthly_plan',
      status: 'available',
      classification: 'calculated_result',
      dataVersion: this.dataVersion,
      period: plan.period,
      currency: 'INR',
      precisionMinor: 1,
      sourceRefs: this.unordered ? [...sources].reverse() : sources,
      operations: this.unordered ? [...operations].reverse() : operations,
      rounding: { precisionMinor: 1, direction: 'half_up', adjustmentMinor: 0 },
      result: { classification: 'calculated_result', value },
    };
  }

  // ---- mutations ----

  private mutate(method: string, path: string, body: Record<string, unknown>, idempotencyKey: string): BackendReply {
    const before = this.snapshot().outcomes.monthlyPlan.value;
    let result: { scopeKey: string; operation: string; recordType: 'salary' | 'bill'; recordId: number; recordVersion: number; record: Record<string, unknown> | null } | BackendReply;

    if (method === 'POST' && path === '/finance/salary') result = this.saveSalary(body);
    else if (method === 'POST' && path === '/finance/salary/apply') result = this.applySalary(body);
    else if (method === 'POST' && path === '/finance/emis') result = this.createBill(body);
    else if (/^\/finance\/emis\/\d+$/.test(path) && (method === 'PATCH' || method === 'DELETE')) {
      result = this.changeBill(method, Number(path.split('/').pop()), body);
    } else return error(404, 'NOT_FOUND', `No fixture for ${method} ${path}.`);

    if ('status' in result) return result;
    this.dataVersion += 1;
    const after = this.snapshot();
    const planDeltas = this.deltas(before, after.outcomes.monthlyPlan);
    const envelope = mutationEnvelope(after, {
      scopeKey: result.scopeKey,
      operation: result.operation,
      recordType: result.recordType,
      recordId: result.recordId,
      recordVersion: result.recordVersion,
      changeId: this.nextChangeId++,
      idempotencyKey,
      planDeltas,
      record: result.record,
    });
    return { status: 200, body: envelope };
  }

  private saveSalary(body: Record<string, unknown>) {
    const amountMinor = body.amountMinor;
    if (!Number.isSafeInteger(amountMinor) || (amountMinor as number) < 0) {
      return error(400, 'INVALID_INPUT', 'Pay must be a whole number of paise.', { field: 'amountMinor' });
    }
    if (body.month !== this.month) return error(400, 'INVALID_INPUT', 'Pay is saved for the viewed month only.', { field: 'month' });
    const stale = this.versionConflict(body, this.salary?.version);
    if (stale) return stale;
    this.salary = this.salary
      ? { ...this.salary, amountMinor: amountMinor as number, version: this.salary.version + 1 }
      : { id: SALARY_ID, month: this.month, amountMinor: amountMinor as number, version: 1 };
    return {
      scopeKey: `salary:${this.month}`,
      operation: 'salary.upsert',
      recordType: 'salary' as const,
      recordId: this.salary.id,
      recordVersion: this.salary.version,
      record: { id: this.salary.id, month: this.month, amountMinor: this.salary.amountMinor },
    };
  }

  private applySalary(body: Record<string, unknown>) {
    const prior = this.priorSalary;
    if (!prior || body.sourceMonth !== prior.month || body.targetMonth !== this.month) {
      return error(400, 'INVALID_INPUT', 'There is no saved pay for that month.', { field: 'sourceMonth' });
    }
    this.salary = { id: SALARY_ID, month: this.month, amountMinor: prior.amountMinor, version: (this.salary?.version ?? 0) + 1 };
    return {
      scopeKey: `salary:${this.month}`,
      operation: 'salary.apply',
      recordType: 'salary' as const,
      recordId: this.salary.id,
      recordVersion: this.salary.version,
      record: { id: this.salary.id, month: this.month, amountMinor: this.salary.amountMinor },
    };
  }

  private createBill(body: Record<string, unknown>) {
    if (typeof body.label !== 'string' || !body.label.trim()) {
      return error(400, 'INVALID_INPUT', 'A bill needs a name.', { field: 'label' });
    }
    if (!Number.isSafeInteger(body.amountMinor) || (body.amountMinor as number) <= 0) {
      return error(400, 'INVALID_INPUT', 'A bill needs an amount above zero.', { field: 'amountMinor' });
    }
    const bill: FakeBill = {
      id: this.nextBillId++,
      label: body.label,
      amountMinor: body.amountMinor as number,
      category: typeof body.category === 'string' ? body.category : 'EMI',
      active: body.active !== false,
      from: typeof body.effectiveFromMonth === 'string' ? body.effectiveFromMonth : null,
      to: typeof body.effectiveToMonth === 'string' ? body.effectiveToMonth : null,
      version: 1,
    };
    this.bills.unshift(bill);
    return this.billResult('bill.create', bill);
  }

  private changeBill(method: string, id: number, body: Record<string, unknown>) {
    const bill = this.bills.find((candidate) => candidate.id === id);
    if (!bill) return error(404, 'RECORD_NOT_FOUND', 'That bill no longer exists.');
    const stale = this.versionConflict(body, bill.version);
    if (stale) return stale;
    if (method === 'DELETE') {
      this.bills.splice(this.bills.indexOf(bill), 1);
      return {
        scopeKey: `bill:${id}`,
        operation: 'bill.delete',
        recordType: 'bill' as const,
        recordId: id,
        recordVersion: bill.version + 1,
        record: null,
      };
    }
    if (typeof body.label === 'string') bill.label = body.label;
    if (Number.isSafeInteger(body.amountMinor)) bill.amountMinor = body.amountMinor as number;
    if (typeof body.category === 'string') bill.category = body.category;
    if (typeof body.active === 'boolean') bill.active = body.active;
    if ('effectiveFromMonth' in body) bill.from = typeof body.effectiveFromMonth === 'string' ? body.effectiveFromMonth : null;
    if ('effectiveToMonth' in body) bill.to = typeof body.effectiveToMonth === 'string' ? body.effectiveToMonth : null;
    bill.version += 1;
    return this.billResult('bill.update', bill);
  }

  private billResult(operation: string, bill: FakeBill) {
    return {
      scopeKey: `bill:${bill.id}`,
      operation,
      recordType: 'bill' as const,
      recordId: bill.id,
      recordVersion: bill.version,
      record: {
        id: bill.id,
        label: bill.label,
        amountMinor: bill.amountMinor,
        category: bill.category,
        active: bill.active,
        effectiveFromMonth: bill.from,
        effectiveToMonth: bill.to,
      },
    };
  }

  private versionConflict(body: Record<string, unknown>, current: number | undefined): BackendReply | null {
    if (body.expectedRecordVersion === undefined || current === undefined) return null;
    if (body.expectedRecordVersion === current) return null;
    return error(409, 'RECORD_VERSION_CONFLICT', 'The record changed.', { currentRecordVersion: current });
  }

  // ---- calculations (server side only) ----

  private counts(bill: FakeBill): boolean {
    return bill.active && (bill.from === null || bill.from <= this.month) && (bill.to === null || bill.to >= this.month);
  }

  private shortfallMinor(counted: FakeBill[], salaryMinor: number | null): number {
    const total = counted.reduce((sum, bill) => sum + bill.amountMinor, 0);
    return Math.max(0, total - (salaryMinor ?? 0));
  }

  private deltas(before: MonthlyPlanValue | undefined, after: Outcome<MonthlyPlanValue>): PlanDeltas {
    if (!after.value) return { status: 'unavailable', month: this.month, reason: 'The plan could not be calculated after this change.' };
    return {
      status: 'available',
      month: this.month,
      disposableIncomeMinor: after.value.disposableIncome.amountMinor - (before?.disposableIncome.amountMinor ?? 0),
      dailySpendingGuideMinor: after.value.dailySpendingGuide.amountMinor - (before?.dailySpendingGuide.amountMinor ?? 0),
    };
  }

  private spendingFrom(plan: Outcome<MonthlyPlanValue>): Partial<Outcome<SpendingOutcomeValue>> {
    const value = plan.value;
    if (plan.status !== 'available' || !value) {
      return {
        status: 'missing_input',
        value: undefined,
        missing: [{ input: 'salary', unlocks: ['monthly_plan', 'spending'] }],
      };
    }
    const base = spendingOutcome(this.month, this.dataVersion).value as SpendingOutcomeValue;
    return {
      value: {
        ...base,
        needsBudget: value.needsBudget,
        wantsBudget: value.wantsBudget,
        spendableBudget: value.spendableBudget,
        remainingSpendable: value.remainingSpendable,
        dailySpendingGuide: value.dailySpendingGuide,
        savingsTarget: value.savingsTarget,
        projectedSavings: value.projectedSavings,
        projectedSavingsDifference: rupeesOf(value.projectedSavings.amountMinor - value.savingsTarget.amountMinor),
      },
    };
  }
}

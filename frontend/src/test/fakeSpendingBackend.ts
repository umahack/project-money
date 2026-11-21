// A closed, in-memory stand-in for the expense, category-treatment, snapshot,
// and supporting reads of the financial clarity contract (contract version 1)
// that the Spending page uses. Counterpart of FakeClarityBackend for pay and bills.
//
// It is transport-free: `handle()` takes a request and returns a status and a
// JSON body. Vitest wraps it in a `fetch` mock (`installSpendingFetch`) and
// Playwright wraps it in route responders, so both suites exercise one contract:
//
// - `GET /finance/clarity?month=` returns `{ schemaVersion, snapshot }` for any month.
// - `GET /finance/expenses?month=` returns that month's rows, newest first.
// - `POST /finance/expenses`, `PATCH`/`DELETE /finance/expenses/:id`, and
//   `PUT`/`DELETE /finance/category-treatments/:category` return a mutation
//   envelope `{ ok, schemaVersion, mutation, clarity }`. For expenses the
//   mutation names the original and resulting period and category, and
//   `clarity` is the snapshot of the month the change landed in (the resulting
//   month, or the original month after a delete).
// - Every confirmed change moves one shared `dataVersion` forward.
// - `expectedRecordVersion` is checked; a mismatch is a 409 RECORD_VERSION_CONFLICT.
// - The same `Idempotency-Key` replays the first confirmed response with `replayed: true`.
//
// All amounts are whole paise. Nothing here reads a clock, the network, or a database.
// Every total, excess, and daily guide is computed by `spendingSnapshot`, which plays the server.
import type { FinancialSnapshot, MutationEnvelope, SpendingOutcomeValue, Outcome } from '../clarity/contracts';
import { NEEDS_ACTION, WANTS_ACTION } from './homeSummaryFixtures';
import { expenseEnvelope, spendingSnapshot, type SpendingExpenseFixture } from './spendingFixtures';

export interface FakeExpense {
  id: number;
  month: string;
  category: string;
  amountMinor: number;
  note: string | null;
  /** `YYYY-MM-DD`. */
  spentOn: string;
  version: number;
}

export interface FakeTreatment {
  id: number;
  category: string;
  treatment: 'needs' | 'wants';
  version: number;
}

export interface SpendingBackendRequest {
  method: string;
  /** Path below `/api`, without the query string, such as `/finance/expenses/7`. */
  path: string;
  query?: URLSearchParams;
  body?: unknown;
  /** Header names in lower case. */
  headers?: Record<string, string>;
}

export interface SpendingBackendReply {
  status: number;
  body: unknown;
}

export interface FakeSpendingInit {
  /** Rupees for `amount`. `month` defaults to the viewed month. `day` defaults to 10. */
  expenses?: Array<{
    category: string;
    amount: number;
    id?: number;
    month?: string;
    day?: number;
    note?: string;
  }>;
  /** Category treatments the user already chose. */
  treatments?: Array<{ category: string; treatment: 'needs' | 'wants'; id?: number }>;
  /** Rupees. */
  needsBudget?: number;
  /** Rupees. */
  wantsBudget?: number;
  categories?: string[];
  /** Start with the spending outcome in `calculation_failed`. The first snapshot read recovers it. */
  calculationFailed?: boolean;
}

const DEFAULT_CATEGORIES = ['Food', 'Groceries', 'Transport', 'Shopping', 'Other'];
const fold = (category: string) => category.toLocaleLowerCase('en-IN');

function error(status: number, code: string, message: string, extra: Record<string, unknown> = {}): SpendingBackendReply {
  return { status, body: { error: { code, message, ...extra } } };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

interface Applied {
  scopeKey: string;
  operation: Parameters<typeof expenseEnvelope>[1]['operation'];
  recordType: 'expense' | 'category_treatment';
  recordId: number;
  recordVersion: number;
  record: Record<string, unknown> | null;
  /** The month whose snapshot the response carries. */
  snapshotMonth: string;
  transition?: Parameters<typeof expenseEnvelope>[1]['transition'];
}

export class FakeSpendingBackend {
  readonly month: string;
  dataVersion = 1;
  readonly expenses: FakeExpense[];
  readonly treatments: FakeTreatment[];
  readonly categories: string[];
  needsBudget: number;
  wantsBudget: number;
  /** While true, the spending outcome of every snapshot is `calculation_failed`. A snapshot read clears it when `recoverOnRead` is set. */
  calculationFailed = false;
  recoverOnRead = true;
  /** Every request this backend handled, in order. */
  readonly log: Array<{ method: string; path: string; body: unknown; idempotencyKey?: string }> = [];
  private nextExpenseId: number;
  private nextTreatmentId = 50;
  private nextChangeId = 300;
  private readonly replies = new Map<string, SpendingBackendReply>();
  private readonly injected = new Map<string, SpendingBackendReply[]>();

  constructor(month: string, init: FakeSpendingInit = {}) {
    this.month = month;
    this.categories = init.categories ?? DEFAULT_CATEGORIES;
    this.calculationFailed = init.calculationFailed ?? false;
    this.needsBudget = init.needsBudget ?? 40000;
    this.wantsBudget = init.wantsBudget ?? 24000;
    this.expenses = (init.expenses ?? []).map((expense, index) => {
      const expenseMonth = expense.month ?? month;
      const day = String(expense.day ?? 10).padStart(2, '0');
      return {
        id: expense.id ?? index + 1,
        month: expenseMonth,
        category: expense.category,
        amountMinor: Math.round(expense.amount * 100),
        note: expense.note ?? null,
        spentOn: `${expenseMonth}-${day}`,
        version: 1,
      };
    });
    this.nextExpenseId = Math.max(0, ...this.expenses.map((expense) => expense.id)) + 1;
    this.treatments = (init.treatments ?? []).map((treatment) => ({
      id: treatment.id ?? this.nextTreatmentId++,
      category: treatment.category,
      treatment: treatment.treatment,
      version: 1,
    }));
  }

  /** The next request for `METHOD /path` fails with this reply, and no state changes. */
  failNext(method: string, path: string, status: number, code: string, message: string): void {
    const key = `${method} ${path}`;
    const queue = this.injected.get(key) ?? [];
    queue.push(error(status, code, message));
    this.injected.set(key, queue);
  }

  /** Another client changed this expense: its record version moves on and its note changes. */
  changeElsewhere(id: number, note = 'Changed elsewhere'): void {
    const expense = this.expenses.find((candidate) => candidate.id === id);
    if (!expense) throw new Error(`No expense ${id}`);
    expense.version += 1;
    expense.note = note;
    this.dataVersion += 1;
  }

  /** Confirmed snapshot for a month: server-calculated totals, treatments, and any exceeded budget. */
  snapshot(month: string = this.month): FinancialSnapshot {
    const rows: SpendingExpenseFixture[] = this.expenses
      .filter((expense) => expense.month === month)
      .map((expense) => {
        const override = this.treatments.find((treatment) => fold(treatment.category) === fold(expense.category));
        return {
          id: expense.id,
          category: expense.category,
          amount: expense.amountMinor / 100,
          ...(override ? { override: { treatment: override.treatment, recordId: override.id } } : {}),
        };
      });
    const snapshot = spendingSnapshot(month, {
      dataVersion: this.dataVersion,
      expenses: rows,
      needsBudget: this.needsBudget,
      wantsBudget: this.wantsBudget,
    });
    const value = snapshot.outcomes.spending.value as SpendingOutcomeValue;
    const actions = value.exceededBudgetActions.map((action) => (action.bucket === 'needs' ? NEEDS_ACTION : WANTS_ACTION));
    const failed: Partial<Outcome<SpendingOutcomeValue>> = this.calculationFailed
      ? { status: 'calculation_failed', value: undefined, retry: { action: 'recalculate', scopeKey: `outcome:spending:${month}` } }
      : {};
    return {
      ...snapshot,
      actions,
      outcomes: { ...snapshot.outcomes, spending: { ...snapshot.outcomes.spending, ...failed } },
    };
  }

  handle(request: SpendingBackendRequest): SpendingBackendReply {
    const method = request.method.toUpperCase();
    const path = request.path;
    const idempotencyKey = request.headers?.['idempotency-key'];
    this.log.push({ method, path, body: request.body, ...(idempotencyKey ? { idempotencyKey } : {}) });
    const injected = this.injected.get(`${method} ${path}`)?.shift();
    if (injected) return injected;

    if (method === 'GET') return this.read(path, request.query);
    if (idempotencyKey && this.replies.has(idempotencyKey)) {
      const first = this.replies.get(idempotencyKey) as SpendingBackendReply;
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

  private read(path: string, query: URLSearchParams | undefined): SpendingBackendReply {
    if (path === '/finance/clarity') {
      const month = query?.get('month') ?? this.month;
      const snapshot = this.snapshot(month);
      if (this.calculationFailed && this.recoverOnRead) this.calculationFailed = false;
      return { status: 200, body: { schemaVersion: 1, snapshot } };
    }
    if (path === '/finance/expenses') {
      const month = query?.get('month') ?? this.month;
      const rows = this.expenses
        .filter((expense) => expense.month === month)
        .sort((a, b) => b.spentOn.localeCompare(a.spentOn) || b.id - a.id)
        .map((expense) => ({
          id: expense.id,
          month: expense.month,
          category: expense.category,
          amount: expense.amountMinor / 100,
          note: expense.note,
          spent_on: expense.spentOn,
          created_at: `${expense.spentOn} 09:00:00`,
        }));
      return { status: 200, body: { month, categories: this.categories, expenses: rows } };
    }
    if (path === '/finance/budgets') return { status: 200, body: { budgets: {} } };
    if (path === '/finance/insights') {
      return {
        status: 200,
        body: { thisMonth: this.month, prevMonth: this.month, totals: { thisMonth: 0, prevMonth: 0 }, weekdayAvg: [], insights: [] },
      };
    }
    if (path === '/finance/history') return { status: 200, body: { months: [] } };
    return error(404, 'NOT_FOUND', `No fixture for GET ${path}.`);
  }

  // ---- mutations ----

  private mutate(method: string, path: string, body: Record<string, unknown>, idempotencyKey: string): SpendingBackendReply {
    let result: Applied | SpendingBackendReply;
    const expense = /^\/finance\/expenses\/(\d+)$/.exec(path);
    const treatment = /^\/finance\/category-treatments\/(.+)$/.exec(path);
    if (method === 'POST' && path === '/finance/expenses') result = this.createExpense(body);
    else if (expense && method === 'PATCH') result = this.updateExpense(Number(expense[1]), body);
    else if (expense && method === 'DELETE') result = this.deleteExpense(Number(expense[1]), body);
    else if (treatment && method === 'PUT') result = this.setTreatment(decodeURIComponent(treatment[1] as string), body);
    else if (treatment && method === 'DELETE') result = this.removeTreatment(decodeURIComponent(treatment[1] as string), body);
    else return error(404, 'NOT_FOUND', `No fixture for ${method} ${path}.`);

    if ('status' in result) return result;
    this.dataVersion += 1;
    const envelope = expenseEnvelope(this.snapshot(result.snapshotMonth), {
      scopeKey: result.scopeKey,
      operation: result.operation,
      recordType: result.recordType,
      recordId: result.recordId,
      recordVersion: result.recordVersion,
      changeId: this.nextChangeId++,
      record: result.record,
      transition: result.transition,
    });
    const body200: MutationEnvelope & { ok: true } = {
      ...envelope,
      mutation: { ...envelope.mutation, idempotencyKey },
    };
    return { status: 200, body: body200 };
  }

  private recordOf(expense: FakeExpense): Record<string, unknown> {
    return {
      id: expense.id,
      month: expense.month,
      category: expense.category,
      amountMinor: expense.amountMinor,
      note: expense.note,
      spentOn: expense.spentOn,
    };
  }

  private validDate(value: unknown): value is string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number) as [number, number, number];
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  }

  private checkFields(body: Record<string, unknown>, partial: boolean): SpendingBackendReply | null {
    if (!partial || 'amountMinor' in body) {
      if (!Number.isSafeInteger(body.amountMinor) || (body.amountMinor as number) <= 0) {
        return error(400, 'INVALID_INPUT', 'Amount must be a whole number of paise above zero.', { field: 'amountMinor' });
      }
    }
    if (!partial || 'category' in body) {
      if (typeof body.category !== 'string' || !this.categories.includes(body.category)) {
        return error(422, 'UNKNOWN_EXPENSE_CATEGORY', 'Unknown category.', { field: 'category' });
      }
    }
    if ('spentOn' in body && !this.validDate(body.spentOn)) {
      return error(400, 'INVALID_INPUT', 'Pick a real date.', { field: 'spentOn' });
    }
    return null;
  }

  private versionConflict(body: Record<string, unknown>, current: number): SpendingBackendReply | null {
    if (body.expectedRecordVersion === undefined || body.expectedRecordVersion === current) return null;
    return error(409, 'RECORD_VERSION_CONFLICT', 'The record changed.', { currentRecordVersion: current });
  }

  private createExpense(body: Record<string, unknown>): Applied | SpendingBackendReply {
    const invalid = this.checkFields(body, false);
    if (invalid) return invalid;
    const spentOn = typeof body.spentOn === 'string' ? body.spentOn : `${this.month}-10`;
    const expense: FakeExpense = {
      id: this.nextExpenseId++,
      month: spentOn.slice(0, 7),
      category: body.category as string,
      amountMinor: body.amountMinor as number,
      note: typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null,
      spentOn,
      version: 1,
    };
    this.expenses.push(expense);
    return {
      scopeKey: `expense:${expense.id}`,
      operation: 'expense.create',
      recordType: 'expense',
      recordId: expense.id,
      recordVersion: expense.version,
      record: this.recordOf(expense),
      snapshotMonth: expense.month,
      transition: {
        type: 'create',
        originalPeriod: null,
        resultingPeriod: expense.month,
        originalCategory: null,
        resultingCategory: expense.category,
        affectedPeriods: [expense.month],
      },
    };
  }

  private updateExpense(id: number, body: Record<string, unknown>): Applied | SpendingBackendReply {
    const expense = this.expenses.find((candidate) => candidate.id === id);
    if (!expense) return error(404, 'RECORD_NOT_FOUND', 'That expense no longer exists.');
    const stale = this.versionConflict(body, expense.version);
    if (stale) return stale;
    const invalid = this.checkFields(body, true);
    if (invalid) return invalid;
    const original = { month: expense.month, category: expense.category };
    if (typeof body.amountMinor === 'number') expense.amountMinor = body.amountMinor;
    if (typeof body.category === 'string') expense.category = body.category;
    if ('note' in body) expense.note = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null;
    if (typeof body.spentOn === 'string') {
      expense.spentOn = body.spentOn;
      expense.month = body.spentOn.slice(0, 7);
    }
    expense.version += 1;
    return {
      scopeKey: `expense:${id}`,
      operation: 'expense.update',
      recordType: 'expense',
      recordId: id,
      recordVersion: expense.version,
      record: this.recordOf(expense),
      snapshotMonth: expense.month,
      transition: {
        type: original.month === expense.month ? 'update' : 'move',
        originalPeriod: original.month,
        resultingPeriod: expense.month,
        originalCategory: original.category,
        resultingCategory: expense.category,
        affectedPeriods: [...new Set([original.month, expense.month])],
      },
    };
  }

  private deleteExpense(id: number, body: Record<string, unknown>): Applied | SpendingBackendReply {
    const expense = this.expenses.find((candidate) => candidate.id === id);
    if (!expense) return error(404, 'RECORD_NOT_FOUND', 'That expense no longer exists.');
    const stale = this.versionConflict(body, expense.version);
    if (stale) return stale;
    this.expenses.splice(this.expenses.indexOf(expense), 1);
    return {
      scopeKey: `expense:${id}`,
      operation: 'expense.delete',
      recordType: 'expense',
      recordId: id,
      recordVersion: expense.version + 1,
      record: null,
      snapshotMonth: expense.month,
      transition: {
        type: 'delete',
        originalPeriod: expense.month,
        resultingPeriod: null,
        originalCategory: expense.category,
        resultingCategory: null,
        affectedPeriods: [expense.month],
      },
    };
  }

  private setTreatment(category: string, body: Record<string, unknown>): Applied | SpendingBackendReply {
    if (body.treatment !== 'needs' && body.treatment !== 'wants') {
      return error(400, 'INVALID_INPUT', 'Treatment must be needs or wants.', { field: 'treatment' });
    }
    let record = this.treatments.find((candidate) => fold(candidate.category) === fold(category));
    const stale = this.versionConflict(body, record?.version ?? 0);
    if (record && stale) return stale;
    if (record) {
      record.treatment = body.treatment;
      record.version += 1;
    } else {
      record = { id: this.nextTreatmentId++, category, treatment: body.treatment, version: 1 };
      this.treatments.push(record);
    }
    return {
      scopeKey: `category-treatment:${encodeURIComponent(fold(category))}`,
      operation: 'category_treatment.set',
      recordType: 'category_treatment',
      recordId: record.id,
      recordVersion: record.version,
      record: { id: record.id, category: record.category, treatment: record.treatment },
      snapshotMonth: this.month,
    };
  }

  private removeTreatment(category: string, body: Record<string, unknown>): Applied | SpendingBackendReply {
    const record = this.treatments.find((candidate) => fold(candidate.category) === fold(category));
    if (!record) return error(404, 'RECORD_NOT_FOUND', 'There is no saved treatment for that category.');
    const stale = this.versionConflict(body, record.version);
    if (stale) return stale;
    this.treatments.splice(this.treatments.indexOf(record), 1);
    return {
      scopeKey: `category-treatment:${encodeURIComponent(fold(category))}`,
      operation: 'category_treatment.remove',
      recordType: 'category_treatment',
      recordId: record.id,
      recordVersion: record.version + 1,
      record: null,
      snapshotMonth: this.month,
    };
  }
}

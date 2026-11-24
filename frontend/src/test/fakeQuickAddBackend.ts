// Quick Add additions on top of FakeSpendingBackend, kept apart so the Spending fake stays as it is:
//
// - `excludeFromDailyAllowance` on expense create and update, echoed on `mutation.record` (a flag turns the echo off,
//   which plays a server that does not confirm the mark).
// - An optional `todayAllowance` outcome in every snapshot of the current month.
// - The Memory_API and hints routes: `GET /finance/quick-add/hints`, `PUT /finance/category-memory` with the revision
//   check (409 MEMORY_REVISION_CONFLICT), `DELETE /finance/category-memory/:id` with the revision check, and
//   `DELETE /finance/category-memory`.
// - Injected failures with a code and a field, for any route.
//
// Like FakeSpendingBackend it is transport-free and reads no clock or network.
import type { FinancialSnapshot, MoneyValue, TodayAllowanceOutcome } from '../clarity/contracts';
import {
  FakeSpendingBackend,
  type FakeSpendingInit,
  type SpendingBackendReply,
  type SpendingBackendRequest,
} from './fakeSpendingBackend';

export interface FakeMemoryEntry {
  id: number;
  noteKey: string;
  category: string;
  revision: number;
  updatedAt: string;
}

export interface FakeHistoryEntry {
  noteKey: string;
  category: string;
  lastSpentOn: string;
}

export interface InjectedFailure {
  status: number;
  code: string;
  message?: string;
  field?: string;
  constraint?: unknown;
}

const money = (amountMinor: number): MoneyValue => ({ currency: 'INR', amountMinor });

/** The most Memory_Entries the server keeps for one user. */
export const MEMORY_ENTRY_LIMIT = 500;

export class FakeQuickAddBackend extends FakeSpendingBackend {
  /** Newest change first, as the hints return them. */
  readonly memory: FakeMemoryEntry[] = [];
  history: FakeHistoryEntry[] = [];
  readonly marks = new Map<number, boolean>();
  /** False plays a server that does not confirm the mark on the record. */
  echoMark = true;
  /** The Kolkata date of the `todayAllowance` outcome. Null leaves the outcome out of every snapshot. */
  todayDate: string | null = null;
  /** True answers every memory write with 404 QUICK_ADD_DISABLED, as the server does while its flag is off. */
  memoryWritesDisabled = false;
  private nextMemoryId = 40;
  private memoryClock = 0;
  private readonly failures = new Map<string, InjectedFailure[]>();

  constructor(month: string, init: FakeSpendingInit = {}) {
    super(month, init);
  }

  /** The next `METHOD /path` request fails with this reply and changes nothing. */
  failWith(method: string, path: string, failure: InjectedFailure): void {
    const key = `${method.toUpperCase()} ${path}`;
    this.failures.set(key, [...(this.failures.get(key) ?? []), failure]);
  }

  /** Puts a memory entry in place, as an earlier session or another device would have. */
  seedMemory(noteKey: string, category: string, revision = 1): FakeMemoryEntry {
    const entry = { id: this.nextMemoryId++, noteKey, category, revision, updatedAt: this.stamp() };
    this.memory.unshift(entry);
    return entry;
  }

  /** Another device changed this entry: its category and revision move on. */
  changeMemoryElsewhere(noteKey: string, category: string): FakeMemoryEntry {
    const entry = this.memory.find((candidate) => candidate.noteKey === noteKey);
    if (!entry) throw new Error('No memory entry for that key');
    entry.category = category;
    entry.revision += 1;
    entry.updatedAt = this.stamp();
    return entry;
  }

  memoryFor(noteKey: string): FakeMemoryEntry | undefined {
    return this.memory.find((candidate) => candidate.noteKey === noteKey);
  }

  /** Removes an expense without a request, as a deletion on another device would. */
  removeElsewhere(id: number): void {
    const index = this.expenses.findIndex((expense) => expense.id === id);
    if (index < 0) throw new Error(`No expense ${id}`);
    this.expenses.splice(index, 1);
    this.marks.delete(id);
    this.dataVersion += 1;
  }

  override snapshot(month: string = this.month): FinancialSnapshot {
    const snapshot = super.snapshot(month);
    if (this.todayDate === null || !this.todayDate.startsWith(`${month}-`)) return snapshot;
    const date = this.todayDate;
    const todayExpenses = this.expenses.filter((expense) => expense.spentOn === date);
    const excluded = todayExpenses.filter((expense) => this.marks.get(expense.id) === true);
    const sum = (rows: typeof todayExpenses) => rows.reduce((total, expense) => total + expense.amountMinor, 0);
    const outcome: TodayAllowanceOutcome = {
      id: `today-allowance:${month}`,
      kind: 'today_allowance',
      status: 'available',
      classification: 'calculated_result',
      period: { month, start: `${month}-01`, endExclusive: `${month}-31`, timeZone: 'Asia/Kolkata' },
      dataVersion: this.dataVersion,
      sourceRefs: [],
      explanationRef: { outcomeId: `today-allowance:${month}`, dataVersion: this.dataVersion },
      value: {
        applicable: true,
        date,
        daysRemainingInclusive: 13,
        todayAllowance: money(300_000),
        todaySpent: money(sum(todayExpenses) - sum(excluded)),
        leftToday: money(300_000 - (sum(todayExpenses) - sum(excluded))),
        overToday: money(0),
        allowanceBasis: money(3_900_000),
        usedPermille: 0,
        zeroReason: null,
        usedBeyondBudget: money(0),
        excludedToday: { count: excluded.length, total: money(sum(excluded)) },
        largeEntryThreshold: money(100_000),
      },
    };
    return { ...snapshot, outcomes: { ...snapshot.outcomes, todayAllowance: outcome } };
  }

  override handle(request: SpendingBackendRequest): SpendingBackendReply {
    const method = request.method.toUpperCase();
    const path = request.path;
    const failure = this.failures.get(`${method} ${path}`)?.shift();
    if (failure) {
      return {
        status: failure.status,
        body: {
          error: {
            code: failure.code,
            message: failure.message ?? 'The request failed.',
            ...(failure.field ? { field: failure.field } : {}),
            ...(failure.constraint !== undefined ? { constraint: failure.constraint } : {}),
          },
        },
      };
    }

    if (method === 'GET' && path === '/finance/quick-add/hints') return this.hints();
    if (path === '/finance/category-memory' || path.startsWith('/finance/category-memory/')) {
      return this.handleMemory(method, path, request);
    }

    const reply = super.handle(request);
    if (reply.status !== 200) return reply;
    if (method === 'GET' && path === '/finance/expenses') {
      // The month's list carries the mark as a boolean on every row, false for an expense without it.
      const list = reply.body as { expenses: Array<Record<string, unknown> & { id: number }> };
      list.expenses = list.expenses.map((row) => ({ ...row, excludeFromDailyAllowance: this.marks.get(row.id) === true }));
      return reply;
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const created = method === 'POST' && path === '/finance/expenses';
    const updated = method === 'PATCH' && /^\/finance\/expenses\/\d+$/.test(path);
    const deleted = method === 'DELETE' && /^\/finance\/expenses\/\d+$/.test(path);
    const envelope = reply.body as {
      mutation: { recordId: number; replayed?: boolean; record: Record<string, unknown> | null };
      clarity?: FinancialSnapshot;
    };
    if (created || updated) {
      const id = envelope.mutation.recordId;
      if (!envelope.mutation.replayed && typeof body.excludeFromDailyAllowance === 'boolean') {
        this.marks.set(id, body.excludeFromDailyAllowance);
        // The real server builds the confirmed snapshot after the commit, so it already reflects the mark.
        if (envelope.clarity) envelope.clarity = this.snapshot(envelope.clarity.period.month);
      }
      if (envelope.mutation.record && this.echoMark) {
        envelope.mutation.record.excludeFromDailyAllowance = this.marks.get(id) === true;
      }
    } else if (deleted) {
      this.marks.delete(envelope.mutation.recordId);
    }
    return reply;
  }

  private stamp(): string {
    this.memoryClock += 1;
    return `2026-11-18T01:${String(this.memoryClock).padStart(2, '0')}:00.000Z`;
  }

  private error(status: number, code: string, message: string): SpendingBackendReply {
    return { status, body: { error: { code, message } } };
  }

  private hints(): SpendingBackendReply {
    return {
      status: 200,
      body: {
        schemaVersion: 1,
        memory: this.memory.map((entry) => ({ ...entry })),
        history: this.history.map((entry) => ({ ...entry })),
        limits: { memoryEntries: MEMORY_ENTRY_LIMIT, historyDays: 90, historyKeys: 500 },
      },
    };
  }

  private handleMemory(method: string, path: string, request: SpendingBackendRequest): SpendingBackendReply {
    const idMatch = /^\/finance\/category-memory\/(\d+)$/.exec(path);
    if (method === 'PUT' && path === '/finance/category-memory') {
      if (this.memoryWritesDisabled) return this.error(404, 'QUICK_ADD_DISABLED', 'Quick Add category memory is unavailable.');
      const body = (request.body ?? {}) as { noteKey?: unknown; category?: unknown; expectedRevision?: unknown };
      if (typeof body.noteKey !== 'string' || typeof body.category !== 'string') {
        return this.error(400, 'INVALID_MEMORY_REQUEST', 'Memory request is not valid.');
      }
      if (!this.categories.includes(body.category)) return this.error(422, 'UNKNOWN_EXPENSE_CATEGORY', 'Unknown category.');
      const existing = this.memory.find((entry) => entry.noteKey === body.noteKey);
      if (body.expectedRevision !== undefined && (!existing || existing.revision !== body.expectedRevision)) {
        return this.error(409, 'MEMORY_REVISION_CONFLICT', 'That choice changed after it was read.');
      }
      let entry: FakeMemoryEntry;
      if (existing) {
        entry = existing;
        entry.category = body.category;
        entry.revision += 1;
        entry.updatedAt = this.stamp();
        this.memory.splice(this.memory.indexOf(entry), 1);
        this.memory.unshift(entry);
      } else {
        entry = { id: this.nextMemoryId++, noteKey: body.noteKey, category: body.category, revision: 1, updatedAt: this.stamp() };
        this.memory.unshift(entry);
      }
      // The server keeps the newest 500 entries. The entry just written is first, so it is never the one removed.
      const evicted = this.memory.length > MEMORY_ENTRY_LIMIT;
      if (evicted) this.memory.length = MEMORY_ENTRY_LIMIT;
      return { status: 200, body: { schemaVersion: 1, created: !existing, evicted, entry: { ...entry } } };
    }
    if (method === 'DELETE' && idMatch) {
      const id = Number(idMatch[1]);
      const entry = this.memory.find((candidate) => candidate.id === id);
      if (!entry) return this.error(404, 'MEMORY_NOT_FOUND', 'That remembered category choice does not exist.');
      const expected = request.query?.get('expectedRevision');
      if (expected !== null && expected !== undefined && Number(expected) !== entry.revision) {
        return this.error(409, 'MEMORY_REVISION_CONFLICT', 'That choice changed after it was read.');
      }
      this.memory.splice(this.memory.indexOf(entry), 1);
      return { status: 200, body: { schemaVersion: 1, deleted: true } };
    }
    if (method === 'DELETE' && path === '/finance/category-memory') {
      const deleted = this.memory.length;
      this.memory.length = 0;
      return { status: 200, body: { schemaVersion: 1, deleted } };
    }
    return this.error(404, 'NOT_FOUND', `No fixture for ${method} ${path}.`);
  }
}

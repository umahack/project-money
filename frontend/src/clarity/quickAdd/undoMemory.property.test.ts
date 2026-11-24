import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { FakeQuickAddBackend, MEMORY_ENTRY_LIMIT } from '../../test/fakeQuickAddBackend';
import { installSpendingFetch } from '../../test/fakeSpendingFetch';
import { assertProperty } from '../../test/propertyReport';
import { fc } from '../../test/test-utils';
import type { MutationEnvelope } from '../contracts';
import type { MutationCommand, MutationSubmitResult } from '../mutationStatusStore';
import { createMemoryClient } from './memoryClient';
import { createQuickAddStore, selectEntry } from './quickAddStore';
import { createQuickAddActions, type QuickAddActionDeps } from './useQuickAddActions';

/**
 * Feature: quick-add-daily-answer, Property 11: Undo restores category memory unless it changed later
 *
 * Validates: Requirements 8.6
 *
 * Statement (design.md): for any memory state and any entry that created or replaced the entry for its Note_Key,
 * undoing the entry restores that Note_Key to its prior category, or removes it if it had none, when the entry's
 * revision is still the stored revision. If the entry was changed after the save, undo leaves the newer entry
 * unchanged. Restoration never creates or changes an entry for another Note_Key. An entry the 500-entry limit
 * removed when the entry was saved is not restored (Requirement 8.6).
 *
 * The reference model below is written from that statement. It holds the User's memory as a list of entries (Note_Key,
 * category, revision, and an identity that changes when a key is deleted and created again), newest first. It never
 * reads the code under test. Each scenario seeds a memory state (up to the 500-entry limit), saves an entry whose
 * category the User chose, applies optional changes by another tab, undoes the entry, and compares the whole memory
 * of the fake server with the model. The memory client, the store, and the actions are the real ones. The expense
 * routes of the fake backend stand in for the mutation runner, which this property does not exercise.
 */

const MONTH = '2026-11';
const TODAY = '2026-11-18';
const CATEGORIES = ['Food', 'Groceries', 'Transport', 'Shopping', 'Entertainment', 'Bills', 'Health', 'Travel', 'Education', 'Other'];
const DEFAULT_SUGGESTION = 'Other';
const MEMORY = '/finance/category-memory';
const ABSENT_KEY = 'zqabsent';
const SEEDED_EXPENSES = [
  { id: 1, category: 'Food', amount: 80, note: 'tea', day: 3 },
  { id: 2, category: 'Transport', amount: 45, note: 'metro', day: 9 },
];

/* ------------------------------ reference model ---------------------------- */

interface ModelEntry {
  key: string;
  category: string;
  revision: number;
  /** Changes when the key is deleted and created again, so a new entry is never taken for the old one. */
  origin: number;
}

class ReferenceMemory {
  /** Newest change first. */
  entries: ModelEntry[] = [];
  private nextOrigin = 1;

  find(key: string): ModelEntry | undefined {
    return this.entries.find((entry) => entry.key === key);
  }

  seed(key: string, category: string, revision: number): ModelEntry {
    const entry = { key, category, revision, origin: this.nextOrigin++ };
    this.entries.unshift(entry);
    return entry;
  }

  /** Create or replace, newest first, and drop the oldest entry beyond the limit. */
  write(key: string, category: string): { entry: ModelEntry; evictedKey: string | null } {
    const existing = this.find(key);
    let entry: ModelEntry;
    if (existing) {
      this.entries = this.entries.filter((candidate) => candidate !== existing);
      existing.category = category;
      existing.revision += 1;
      this.entries.unshift(existing);
      entry = existing;
    } else {
      entry = { key, category, revision: 1, origin: this.nextOrigin++ };
      this.entries.unshift(entry);
    }
    const evicted = this.entries.length > MEMORY_ENTRY_LIMIT ? this.entries.pop() : undefined;
    return { entry, evictedKey: evicted?.key ?? null };
  }

  /** A change of category in place (another tab). The revision moves on. */
  change(key: string, category: string): void {
    const entry = this.find(key);
    if (!entry) return;
    entry.category = category;
    entry.revision += 1;
  }

  remove(key: string): void {
    this.entries = this.entries.filter((entry) => entry.key !== key);
  }

  view(): string[] {
    return this.entries.map((entry) => `${entry.key}|${entry.category}|${entry.revision}`).sort();
  }
}

function viewOf(backend: FakeQuickAddBackend): string[] {
  return backend.memory.map((entry) => `${entry.noteKey}|${entry.category}|${entry.revision}`).sort();
}

/** A Note_Key made of letters only, so the parser reads it as a plain note. */
function keyFor(index: number): string {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  return `zq${letters[Math.floor(index / 676) % 26]}${letters[Math.floor(index / 26) % 26]}${letters[index % 26]}`;
}

/* -------------------------------- scenarios -------------------------------- */

type Op =
  | { kind: 'change'; category: number }
  | { kind: 'changeOther'; pick: number; category: number }
  | { kind: 'newKey'; n: number; category: number }
  | { kind: 'delete' }
  | { kind: 'recreate'; category: number };

interface Scenario {
  state: Array<{ category: number; revision: number }>;
  keyMode: 'existing' | 'absent';
  keyIndex: number;
  chosen: number;
  hintsLoaded: boolean;
  inFlight: boolean;
  expenseGone: boolean;
  doubleUndo: boolean;
  amount: number;
  ops: Op[];
}

const categoryIndexArb = fc.integer({ min: 0, max: CATEGORIES.length - 1 });
const entrySpecArb = fc.record({ category: categoryIndexArb, revision: fc.integer({ min: 1, max: 5 }) });
const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('change' as const), category: categoryIndexArb }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('changeOther' as const), pick: fc.integer({ min: 0, max: 999 }), category: categoryIndexArb }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('newKey' as const), n: fc.integer({ min: 0, max: 5 }), category: categoryIndexArb }) },
  { weight: 1, arbitrary: fc.constant<Op>({ kind: 'delete' }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('recreate' as const), category: categoryIndexArb }) },
);

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  // Mostly small states, and often the states at and just below the 500-entry limit.
  state: fc.oneof(
    { weight: 6, arbitrary: fc.array(entrySpecArb, { minLength: 0, maxLength: 12 }) },
    { weight: 2, arbitrary: fc.array(entrySpecArb, { minLength: MEMORY_ENTRY_LIMIT - 1, maxLength: MEMORY_ENTRY_LIMIT }) },
  ),
  keyMode: fc.constantFrom('existing' as const, 'absent' as const),
  keyIndex: fc.integer({ min: 0, max: 9999 }),
  chosen: categoryIndexArb,
  hintsLoaded: fc.oneof({ weight: 4, arbitrary: fc.constant(true) }, { weight: 1, arbitrary: fc.constant(false) }),
  inFlight: fc.oneof({ weight: 4, arbitrary: fc.constant(false) }, { weight: 1, arbitrary: fc.constant(true) }),
  expenseGone: fc.oneof({ weight: 4, arbitrary: fc.constant(false) }, { weight: 1, arbitrary: fc.constant(true) }),
  doubleUndo: fc.boolean(),
  amount: fc.integer({ min: 1, max: 5000 }),
  ops: fc.array(opArb, { minLength: 0, maxLength: 4 }),
});

/* --------------------------------- harness --------------------------------- */

/** The expense routes of the fake backend in place of the mutation runner. */
function backendRunner(backend: FakeQuickAddBackend): QuickAddActionDeps['runner'] {
  let sent = 0;
  return {
    async submit(command: MutationCommand): Promise<MutationSubmitResult> {
      await Promise.resolve();
      sent += 1;
      const reply = backend.handle({
        method: command.method ?? 'POST',
        path: command.path,
        body: command.body,
        headers: { 'idempotency-key': `undo-memory-${sent}` },
      });
      if (reply.status === 200) return { outcome: 'confirmed', envelope: reply.body as MutationEnvelope };
      const error = (reply.body as { error?: { code?: string; message?: string } }).error ?? {};
      return {
        outcome: 'failed',
        error: { message: error.message ?? 'The request failed.', status: reply.status, ...(error.code ? { code: error.code } : {}) },
      };
    },
    retry: async () => ({ outcome: 'not_retryable' }),
    dismiss: () => undefined,
  };
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
  throw new Error('The awaited state was not reached.');
}

async function runScenario(scenario: Scenario, seen: Set<string>): Promise<void> {
  const backend = new FakeQuickAddBackend(MONTH, { categories: CATEGORIES, expenses: SEEDED_EXPENSES });
  const model = new ReferenceMemory();
  scenario.state.forEach((spec, index) => {
    const category = CATEGORIES[spec.category] ?? DEFAULT_SUGGESTION;
    backend.seedMemory(keyFor(index), category, spec.revision);
    model.seed(keyFor(index), category, spec.revision);
  });

  const net = installSpendingFetch(backend);
  const memory = createMemoryClient({ queryClient: new QueryClient(), isEnabled: () => true });
  const store = createQuickAddStore();
  let nextCid = 0;
  const actions = createQuickAddActions({
    store,
    runner: backendRunner(backend),
    memory,
    readSnapshot: async (month) => backend.snapshot(month),
    reportChange: () => undefined,
    context: () => ({ categories: CATEGORIES }),
    isEnabled: () => true,
    today: () => TODAY,
    createId: () => `entry-${nextCid++}`,
  });

  let thrown: unknown = null;
  const guarded = <T>(work: Promise<T>): Promise<T | undefined> => work.catch((error: unknown) => {
    thrown = error;
    return undefined;
  });

  try {
    /* ---- the entry: the key, the category the User chose, and what the memory held ---- */
    const existingIndex = scenario.keyMode === 'existing' && scenario.state.length > 0
      ? scenario.keyIndex % scenario.state.length
      : -1;
    const key = existingIndex >= 0 ? keyFor(existingIndex) : ABSENT_KEY;
    const chosen = CATEGORIES[scenario.chosen] ?? DEFAULT_SUGGESTION;
    const prior = model.find(key);
    const previous = prior ? { category: prior.category, revision: prior.revision } : null;
    // The suggestion for this note: the remembered category when the hints were read, otherwise the default.
    const suggested = scenario.hintsLoaded && previous ? previous.category : DEFAULT_SUGGESTION;
    const writesMemory = chosen !== suggested;
    const ledgerBefore = JSON.stringify(backend.expenses);

    if (scenario.hintsLoaded) await memory.loadHints();
    const inFlight = scenario.inFlight && writesMemory;
    const gate = inFlight ? net.hold('PUT', MEMORY) : null;

    const saving = guarded(actions.submit({ line: `${scenario.amount} ${key}`, category: chosen }));
    const cid = 'entry-0';
    const entryOf = () => selectEntry(store.getState(), cid);

    let wrote: { origin: number; revision: number } | null = null;
    let evictedKey: string | null = null;
    if (writesMemory) {
      const written = model.write(key, chosen);
      wrote = { origin: written.entry.origin, revision: written.entry.revision };
      evictedKey = written.evictedKey;
    }

    if (inFlight) {
      await until(() => entryOf()?.phase === 'saved' && entryOf()?.memory.phase === 'saving');
    } else {
      const saved = await saving;
      expect(saved).toMatchObject({ status: 'confirmed' });
    }
    const expenseId = entryOf()?.expenseId ?? 0;
    expect(expenseId).toBeGreaterThan(0);
    // The id of the entry this entry wrote, before another tab can delete it. In flight it is known after the release.
    const writtenId = inFlight ? undefined : backend.memoryFor(key)?.id;

    /* ---- changes by another tab or another entry after the save ---- */
    if (!inFlight) {
      for (const op of scenario.ops) {
        switch (op.kind) {
          case 'change': {
            const category = CATEGORIES[op.category] ?? DEFAULT_SUGGESTION;
            if (model.find(key)) {
              backend.changeMemoryElsewhere(key, category);
              model.change(key, category);
            }
            break;
          }
          case 'changeOther': {
            const others = model.entries.filter((entry) => entry.key !== key);
            const target = others[op.pick % Math.max(others.length, 1)];
            if (target) {
              const category = CATEGORIES[op.category] ?? DEFAULT_SUGGESTION;
              backend.changeMemoryElsewhere(target.key, category);
              model.change(target.key, category);
            }
            break;
          }
          case 'newKey': {
            const otherKey = `zqother${'abcdef'[op.n] ?? 'a'}`;
            const category = CATEGORIES[op.category] ?? DEFAULT_SUGGESTION;
            const reply = backend.handle({ method: 'PUT', path: MEMORY, body: { noteKey: otherKey, category } });
            expect(reply.status).toBe(200);
            model.write(otherKey, category);
            break;
          }
          case 'delete': {
            const index = backend.memory.findIndex((entry) => entry.noteKey === key);
            if (index >= 0) backend.memory.splice(index, 1);
            model.remove(key);
            break;
          }
          case 'recreate': {
            const category = CATEGORIES[op.category] ?? DEFAULT_SUGGESTION;
            const index = backend.memory.findIndex((entry) => entry.noteKey === key);
            if (index >= 0) backend.memory.splice(index, 1);
            model.remove(key);
            // Created through the server route, which applies the 500-entry limit, as another tab would. Seeding the
            // fake directly bypassed the limit and left 501 entries when the memory was full.
            const reply = backend.handle({ method: 'PUT', path: MEMORY, body: { noteKey: key, category } });
            expect(reply.status).toBe(200);
            model.write(key, category);
            break;
          }
        }
      }
    }
    if (scenario.expenseGone) backend.removeElsewhere(expenseId);

    /* ---- undo ---- */
    const otherIds = new Set(backend.memory.filter((entry) => entry.noteKey !== key).map((entry) => entry.id));
    const memoryCallsBefore = net.calls.length;
    if (inFlight) {
      const undoing = guarded(actions.undo(cid));
      await until(() => entryOf()?.phase === 'undone');
      gate?.release();
      await Promise.all([saving, undoing]);
    } else if (scenario.doubleUndo) {
      await Promise.all([guarded(actions.undo(cid)), guarded(actions.undo(cid))]);
    } else {
      await guarded(actions.undo(cid));
    }
    const memoryCalls = net.calls.slice(memoryCallsBefore).filter((call) => call.path.startsWith(MEMORY));

    // Model of the compensation (Requirement 8.6).
    const restorable = !scenario.expenseGone && wrote !== null && scenario.hintsLoaded;
    const current = model.find(key);
    // The entry is the one this entry wrote when the stored revision is the revision written. A key that was absent
    // before is also deleted by the identity of the written entry, so a later entry for the key is never deleted.
    const stillTheEntryThisWrote = !!current && !!wrote && current.revision === wrote.revision
      && (previous !== null || current.origin === wrote.origin);
    if (restorable && stillTheEntryThisWrote) {
      if (previous === null) {
        model.remove(key);
        seen.add('removed-written');
      } else {
        model.write(key, previous.category);
        seen.add('restored-previous');
      }
    } else if (writesMemory && !scenario.hintsLoaded) {
      seen.add('unknown-previous');
    } else if (restorable) {
      seen.add('preserved-newer');
    }
    if (evictedKey !== null) seen.add('evicted-at-limit');
    if (!writesMemory) seen.add('kept-suggestion');
    if (scenario.expenseGone) seen.add('expense-gone');
    if (inFlight) seen.add('in-flight');

    /* ---- the properties ---- */
    expect(thrown).toBeNull();
    expect(entryOf()?.phase).toBe('undone');
    expect(['none', 'saved']).toContain(entryOf()?.memory.phase);

    // Memory equals the model: restored, removed, or the newer change in place, and nothing else touched.
    expect(viewOf(backend)).toEqual(model.view());
    expect(backend.memory.length).toBeLessThanOrEqual(MEMORY_ENTRY_LIMIT);
    // An entry the limit removed at the save stays removed.
    if (evictedKey !== null) expect(backend.memoryFor(evictedKey)).toBeUndefined();

    // Restoration touches the entry of this Note_Key only.
    for (const call of memoryCalls) {
      if (call.method === 'PUT') {
        expect((call.body as { noteKey?: string }).noteKey).toBe(key);
      } else {
        expect(call.method).toBe('DELETE');
        const id = Number(call.path.slice(MEMORY.length + 1));
        expect(otherIds.has(id)).toBe(false);
        if (writtenId !== undefined) expect(id).toBe(writtenId);
      }
    }
    // Nothing is restored when the entry did not write, the previous state is unknown, or the expense was already gone.
    if (!restorable) expect(memoryCalls.filter((call) => call.method === 'DELETE')).toHaveLength(0);
    if (!writesMemory || !scenario.hintsLoaded || scenario.expenseGone) {
      expect(memoryCalls.filter((call) => call.path.startsWith(MEMORY) && call.query.has('expectedRevision'))).toHaveLength(0);
      expect(memoryCalls.filter((call) => (call.body as { expectedRevision?: number } | undefined)?.expectedRevision !== undefined)).toHaveLength(0);
    }

    // No effect on the expense ledger: the entry's own expense is gone, every other expense is as it was.
    expect(JSON.stringify(backend.expenses)).toBe(ledgerBefore);
    const expenseWrites = backend.log
      .filter((request) => request.method !== 'GET' && request.path.startsWith('/finance/expenses'))
      .map((request) => `${request.method} ${request.path === '/finance/expenses' ? '' : '/:id'}`.trim());
    expect(expenseWrites[0]).toBe('POST');
    expect(expenseWrites.slice(1).every((write) => write === 'DELETE /:id')).toBe(true);

    // A replay of undo is idempotent: nothing is sent and nothing changes.
    const requestsBefore = net.calls.length;
    const backendRequestsBefore = backend.log.length;
    const memoryBefore = viewOf(backend);
    const again = await guarded(actions.undo(cid));
    const retried = await guarded(actions.retry(cid));
    expect(again).toEqual({ status: 'unavailable' });
    expect(retried).toEqual({ status: 'unavailable' });
    expect(net.calls.length).toBe(requestsBefore);
    expect(backend.log.length).toBe(backendRequestsBefore);
    expect(viewOf(backend)).toEqual(memoryBefore);
    expect(thrown).toBeNull();
  } finally {
    store.reset();
    memory.dispose();
  }
}

describe('Property 11: Undo restores category memory unless it changed later', () => {
  it('equals the reference model of the memory after undo for any state, choice, and later change', async () => {
    const seen = new Set<string>();
    await assertProperty(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        await runScenario(scenario, seen);
      }),
      { numRuns: 150 },
    );
    // The generated cases reach every branch of the statement.
    for (const label of [
      'removed-written',
      'restored-previous',
      'preserved-newer',
      'unknown-previous',
      'evicted-at-limit',
      'kept-suggestion',
      'expense-gone',
      'in-flight',
    ]) {
      expect(seen, label).toContain(label);
    }
  }, 120_000);
});

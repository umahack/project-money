import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { deferred, type Deferred } from '../../test/clarity-fixtures';
import { FakeQuickAddBackend } from '../../test/fakeQuickAddBackend';
import type { SpendingBackendReply } from '../../test/fakeSpendingBackend';
import { assertProperty } from '../../test/propertyReport';
import { fc } from '../../test/test-utils';
import { createClarityStore } from '../clarityStore';
import type { MutationEnvelope } from '../contracts';
import { createMutationStatusStore, type MutationRequest } from '../mutationStatusStore';
import type { AnswerStatus, EntryAnswerModel } from './answer';
import { resetExpenseEventsForTests } from './expenseEvents';
import { createMemoryClient } from './memoryClient';
import type { ParsedEntry } from './parser';
import {
  createQuickAddStore,
  isSubmissionBlocked,
  isUndoAvailable,
  isUndoPaused,
  selectCurrentAnswer,
  selectCurrentAnswerEntry,
  undoRemainingMs,
  type EntryPhase,
  type QuickAddEntry,
  type QuickAddState,
  type QuickAddTimers,
  type UndoPauseSource,
} from './quickAddStore';
import type { CategorySuggestion } from './suggester';
import { createQuickAddActions } from './useQuickAddActions';

/*
 * Feature: quick-add-daily-answer, Property 21: The entry store keeps entries isolated and ordered
 *
 * Validates: Requirements 7.12, 7.14, 8.9, 8.10, 9.15, 9.16, 13.5, 13.6
 *
 * Statement (design.md): for any sequence of submissions, successes, failures, retries, undos, hover and focus
 * pauses, and out-of-order responses, each entry keeps its own status, key, and values; a failure changes only its own
 * entry; submission is disabled exactly while five entries are pending; the undo deadline is the confirmation time plus
 * 8 seconds extended by the paused time, does not expire while an undo is pending or failed, and ends the control when
 * it passes; the current answer comes from the most recently confirmed entry; and an older snapshot never replaces a
 * newer one.
 *
 * Three properties, each with an independent reference model that shares no code with the store:
 *
 *  1. The store (`createQuickAddStore`) runs under a fake clock and fake timers, driven by generated actions that
 *     include stale and illegal ones (a confirmation of an entry that already failed, a pause of a closed window, a
 *     discard of a saved row). The model tracks phases, order, deadlines with pause spans, the waking-up flag, and the
 *     current answer, including the rule that an equal data version replaces a held answer only when the held one is not
 *     `available` and the new one is.
 *  2. With responses delivered in order and strictly rising versions, the current answer is the most recently confirmed
 *     entry.
 *  3. The real actions (`createQuickAddActions`) run on the real mutation runner and `FakeQuickAddBackend`, with every
 *     response held and released in any order, lost, or rejected. The model tracks phases, answer versions, the five
 *     pending limit, and Idempotency-Keys (one per command, none shared, replayed by the server on a same-key retry).
 *
 * A failing run prints the structure of the shrunk scenario and the last mismatch, never entry text.
 */

const RUNS = 150;
/* Spelled out from the requirements, not imported, so a changed constant in the store is caught. */
/** Requirement 7.12. */
const PENDING_LIMIT = 5;
/** Requirement 8.1. */
const UNDO_WINDOW = 8_000;
/** Requirement 7.13. */
const WAKING_UP_AFTER = 5_000;
const T0 = Date.parse('2026-11-18T06:30:00.000Z');
const TODAY = '2026-11-18';
const MONTH = '2026-11';
const CATEGORIES = ['Food', 'Groceries', 'Transport', 'Shopping', 'Other'];
const ANSWER_STATUSES: readonly AnswerStatus[] = ['available', 'missing_input', 'invalid_input', 'calculation_failed'];
const SOURCES: readonly UndoPauseSource[] = ['pointer', 'focus'];

/** Legal phase transitions of one entry between two steps (same entry, same cid). */
const ALLOWED_NEXT: Readonly<Record<EntryPhase, readonly EntryPhase[]>> = {
  pending: ['pending', 'saved', 'failed'],
  failed: ['failed', 'pending'],
  saved: ['saved', 'removing'],
  removing: ['removing', 'undone', 'undo_failed'],
  undo_failed: ['undo_failed', 'removing'],
  undone: ['undone'],
};

let lastMismatch = '';
let trace: string[] = [];

function mismatch(message: string): never {
  lastMismatch = `${message} (steps: ${trace.join(',')})`;
  throw new Error(lastMismatch);
}

function check(condition: boolean, message: () => string): void {
  if (!condition) mismatch(message());
}

async function assertWithMismatch(run: () => void | Promise<void>): Promise<void> {
  lastMismatch = '';
  try {
    await run();
  } catch (error) {
    if (error instanceof Error && lastMismatch) error.message += ` | last mismatch: ${lastMismatch}`;
    throw error;
  }
}

const categoryOf = (index: number): string => CATEGORIES[index % CATEGORIES.length] as string;

/* ----------------------------------------------------------------------------------------------------------------- */
/* Property 1: the store under a fake clock                                                                          */
/* ----------------------------------------------------------------------------------------------------------------- */

class FakeTimers implements QuickAddTimers {
  now = T0;
  private nextId = 1;
  private readonly scheduled = new Map<number, { at: number; callback: () => void }>();

  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = this.nextId;
    this.nextId += 1;
    this.scheduled.set(id, { at: this.now + Math.max(0, delayMs), callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.scheduled.delete(handle as number);
  }

  /** Moves the clock, running every timer that comes due, earliest first, with the clock at its due time. */
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      let nextId = -1;
      let nextAt = Number.POSITIVE_INFINITY;
      for (const [id, timer] of this.scheduled) {
        if (timer.at <= target && timer.at < nextAt) {
          nextAt = timer.at;
          nextId = id;
        }
      }
      if (nextId < 0) break;
      const due = this.scheduled.get(nextId);
      this.scheduled.delete(nextId);
      if (!due) break;
      this.now = Math.max(this.now, due.at);
      due.callback();
    }
    this.now = target;
  }
}

function makeAnswer(dataVersion: number, status: AnswerStatus, tag: number): EntryAnswerModel {
  return {
    mode: 'saved',
    titleKey: 'answer.saved',
    dataVersion,
    month: MONTH,
    scope: 'current_month',
    countsTowardCurrentMonth: true,
    status,
    today: 'shown',
    bucket: null,
    saved: null,
    explanation: null,
    lines: [{ key: 'answer.saved', params: { tag } }],
    actions: [],
  };
}

interface ModelAnswer {
  object: EntryAnswerModel;
  version: number;
  status: AnswerStatus;
  /** Order in which answers were accepted. Breaks ties between equal versions. */
  order: number;
}

interface ModelEntry {
  cid: string;
  phase: EntryPhase;
  category: string;
  exclusionRequested: boolean;
  parsed: ParsedEntry;
  suggestion: CategorySuggestion;
  submittedAt: number;
  pendingSince: number;
  expenseId?: number;
  recordVersion?: number;
  excluded?: boolean;
  confirmedAt?: number;
  alreadyRemoved: boolean;
  windowOpen: boolean;
  sources: Set<UndoPauseSource>;
  pausedSince: number | null;
  pausedTotal: number;
  answer?: ModelAnswer;
}

/** Confirmation time plus 8 seconds plus every closed pause span. */
const deadlineOf = (entry: ModelEntry): number => (entry.confirmedAt ?? 0) + UNDO_WINDOW + entry.pausedTotal;

class StoreModel {
  line = '';
  entries: ModelEntry[] = [];
  now = T0;
  private accepted = 0;

  find(cid: string): ModelEntry | undefined {
    return this.entries.find((entry) => entry.cid === cid);
  }

  pendingCount(): number {
    return this.entries.filter((entry) => entry.phase === 'pending').length;
  }

  /** An answer replaces the held one when its version is higher, or equal when the held one was not available and it is. */
  accept(entry: ModelEntry, answer: EntryAnswerModel | undefined): void {
    if (!answer) return;
    const held = entry.answer;
    const replaces = held === undefined
      || answer.dataVersion > held.version
      || (answer.dataVersion === held.version && held.status !== 'available' && answer.status === 'available');
    if (!replaces) return;
    this.accepted += 1;
    entry.answer = { object: answer, version: answer.dataVersion, status: answer.status, order: this.accepted };
  }

  currentAnswerEntry(): ModelEntry | undefined {
    let best: ModelEntry | undefined;
    for (const entry of this.entries) {
      if (!entry.answer) continue;
      if (
        !best?.answer
        || entry.answer.version > best.answer.version
        || (entry.answer.version === best.answer.version && entry.answer.order > best.answer.order)
      ) {
        best = entry;
      }
    }
    return best;
  }
}

interface Target {
  pickIndex: number;
  legal: boolean;
}

type AnswerSpec = { versionId: number; status: AnswerStatus } | undefined;

type StoreOp =
  | { kind: 'line'; text: string }
  | { kind: 'submit'; categoryIndex: number; suggestedIndex: number; amountMinor: number; note: string; exclusion: boolean }
  | {
    kind: 'confirm';
    target: Target;
    expenseId: number;
    recordVersion: number | undefined;
    excluded: boolean | undefined;
    categoryIndex: number | undefined;
    answer: AnswerSpec;
  }
  | { kind: 'fail'; target: Target }
  | { kind: 'retry'; target: Target }
  | { kind: 'discard'; target: Target }
  | { kind: 'edit'; target: Target; text: string }
  | { kind: 'updated'; target: Target; categoryIndex: number | undefined; excluded: boolean | undefined; recordVersion: number | undefined; answer: AnswerSpec }
  | { kind: 'undoStart'; target: Target }
  | { kind: 'undone'; target: Target; alreadyRemoved: boolean; answer: AnswerSpec }
  | { kind: 'undoFailed'; target: Target }
  | { kind: 'pause'; target: Target; source: UndoPauseSource }
  | { kind: 'resume'; target: Target; source: UndoPauseSource }
  | { kind: 'advance'; elapsedMs: number };

const targetArb: fc.Arbitrary<Target> = fc.record({
  pickIndex: fc.nat(1000),
  // Most targets are in the phase the action expects; the rest play stale and out-of-order responses.
  legal: fc.integer({ min: 0, max: 9 }).map((n) => n < 8),
});

const answerSpecArb: fc.Arbitrary<AnswerSpec> = fc.option(
  fc.record({
    // A narrow range so equal versions occur often.
    versionId: fc.integer({ min: 1, max: 6 }),
    status: fc.constantFrom(...ANSWER_STATUSES),
  }),
  { nil: undefined, freq: 4 },
);

const optionalBoolArb = fc.option(fc.boolean(), { nil: undefined });
const optionalIntArb = fc.option(fc.integer({ min: 1, max: 9 }), { nil: undefined });

const lineTextArb = fc.oneof(
  fc.constant(''),
  fc.constant('   '),
  fc.stringMatching(/^[a-z0-9]{1,6}$/),
);

const elapsedArb = fc.oneof(
  fc.integer({ min: 0, max: 12_000 }),
  fc.constantFrom(1, 4_999, 5_000, 5_001, 7_999, 8_000, 8_001),
);

const storeOpArb: fc.Arbitrary<StoreOp> = fc.oneof(
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('line' as const), text: lineTextArb }) },
  {
    weight: 7,
    arbitrary: fc.record({
      kind: fc.constant('submit' as const),
      categoryIndex: fc.nat(CATEGORIES.length - 1),
      suggestedIndex: fc.nat(CATEGORIES.length - 1),
      amountMinor: fc.integer({ min: 100, max: 500_000 }),
      note: fc.stringMatching(/^[a-z]{0,6}$/),
      exclusion: fc.boolean(),
    }),
  },
  {
    weight: 6,
    arbitrary: fc.record({
      kind: fc.constant('confirm' as const),
      target: targetArb,
      expenseId: fc.integer({ min: 1, max: 999 }),
      recordVersion: optionalIntArb,
      excluded: optionalBoolArb,
      categoryIndex: fc.option(fc.nat(CATEGORIES.length - 1), { nil: undefined }),
      answer: answerSpecArb,
    }),
  },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant('fail' as const), target: targetArb }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('retry' as const), target: targetArb }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('discard' as const), target: targetArb }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('edit' as const), target: targetArb, text: fc.stringMatching(/^[a-z0-9 ]{1,8}$/) }) },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant('updated' as const),
      target: targetArb,
      categoryIndex: fc.option(fc.nat(CATEGORIES.length - 1), { nil: undefined }),
      excluded: optionalBoolArb,
      recordVersion: optionalIntArb,
      answer: answerSpecArb,
    }),
  },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('undoStart' as const), target: targetArb }) },
  {
    weight: 3,
    arbitrary: fc.record({ kind: fc.constant('undone' as const), target: targetArb, alreadyRemoved: fc.boolean(), answer: answerSpecArb }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('undoFailed' as const), target: targetArb }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('pause' as const), target: targetArb, source: fc.constantFrom(...SOURCES) }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('resume' as const), target: targetArb, source: fc.constantFrom(...SOURCES) }) },
  { weight: 5, arbitrary: fc.record({ kind: fc.constant('advance' as const), elapsedMs: elapsedArb }) },
);

function pickEntry(model: StoreModel, target: Target, phases: readonly EntryPhase[]): ModelEntry | undefined {
  const inPhase = target.legal ? model.entries.filter((entry) => phases.includes(entry.phase)) : [];
  const pool = inPhase.length > 0 ? inPhase : model.entries;
  if (pool.length === 0) return undefined;
  return pool[target.pickIndex % pool.length];
}

function expectEntry(entry: QuickAddEntry, model: ModelEntry, now: number): void {
  const same = (name: string, actual: unknown, expected: unknown) => {
    check(Object.is(actual, expected), () => `${model.cid}.${name}: ${String(actual)} expected ${String(expected)}`);
  };
  same('phase', entry.phase, model.phase);
  same('category', entry.category, model.category);
  same('exclusionRequested', entry.exclusionRequested, model.exclusionRequested);
  same('parsed', entry.parsed, model.parsed);
  same('suggestion', entry.suggestion, model.suggestion);
  same('submittedAt', entry.submittedAt, model.submittedAt);
  same('pendingSince', entry.pendingSince, model.pendingSince);
  same('expenseId', entry.expenseId, model.expenseId);
  same('recordVersion', entry.recordVersion, model.recordVersion);
  same('excluded', entry.excluded, model.excluded);
  same('confirmedAt', entry.confirmedAt, model.confirmedAt);
  same('alreadyRemoved', entry.alreadyRemoved === true, model.alreadyRemoved);
  same('answer', entry.answer, model.answer?.object);
  same('hasError', entry.error !== undefined, model.phase === 'failed' || model.phase === 'undo_failed');
  // Requirement 7.13: the flag is set once an entry has been pending for 5 seconds.
  same('wakingUp', entry.wakingUp, model.phase === 'pending' && now >= model.pendingSince + WAKING_UP_AFTER);

  // Requirements 8.9 and 8.10: the Undo control, its deadline, and its pause.
  const open = model.phase === 'saved' && model.windowOpen;
  same('undoWindow', entry.undo !== undefined, open);
  same('undoAvailable', isUndoAvailable(entry), open || model.phase === 'removing' || model.phase === 'undo_failed');
  same('undoPaused', isUndoPaused(entry), open && model.pausedSince !== null);
  const remaining = open ? Math.max(0, deadlineOf(model) - (model.pausedSince ?? now)) : null;
  same('undoRemainingMs', undoRemainingMs(entry, now), remaining);
  if (open && model.pausedSince === null) same('undoDeadline', entry.undo?.deadline, deadlineOf(model));
}

function expectStore(state: QuickAddState, model: StoreModel, before: QuickAddState, affected: ReadonlySet<string> | 'all'): void {
  check(state.line === model.line, () => 'draft line differs');
  // Submission order is the list order.
  check(
    state.entries.map((entry) => entry.cid).join('|') === model.entries.map((entry) => entry.cid).join('|'),
    () => `order ${state.entries.map((entry) => entry.cid).join(',')} expected ${model.entries.map((entry) => entry.cid).join(',')}`,
  );
  model.entries.forEach((expected, index) => {
    const entry = state.entries[index];
    check(entry !== undefined, () => `missing ${expected.cid}`);
    expectEntry(entry as QuickAddEntry, expected, model.now);
  });

  // Requirement 7.12: at most five pending, and submission is blocked exactly then.
  const pending = state.entries.filter((entry) => entry.phase === 'pending').length;
  check(pending <= PENDING_LIMIT, () => `${pending} entries pending`);
  check(isSubmissionBlocked(state) === (pending === PENDING_LIMIT), () => `blocked flag with ${pending} pending`);

  // Requirements 9.15 and 9.16: the newest snapshot is the current answer.
  const expectedCurrent = model.currentAnswerEntry();
  check(selectCurrentAnswerEntry(state)?.cid === expectedCurrent?.cid, () => 'current answer entry differs');
  check(selectCurrentAnswer(state) === expectedCurrent?.answer?.object, () => 'current answer differs');

  // Requirements 13.5 and 13.6: an action on one entry never touches another entry, and phases move legally.
  const after = new Map(state.entries.map((entry) => [entry.cid, entry]));
  for (const previous of before.entries) {
    const next = after.get(previous.cid);
    if (next && !ALLOWED_NEXT[previous.phase].includes(next.phase)) {
      mismatch(`${previous.cid} moved ${previous.phase} -> ${next.phase}`);
    }
    if (affected === 'all' || affected.has(previous.cid)) continue;
    check(next === previous, () => `${previous.cid} changed by an action on another entry`);
  }
}

function runStoreScenario(ops: readonly StoreOp[]): void {
  trace = [];
  const clock = new FakeTimers();
  const store = createQuickAddStore({ now: () => clock.now, timers: clock });
  const model = new StoreModel();
  let created = 0;
  let tag = 0;

  expectStore(store.getState(), model, store.getState(), new Set());

  for (const op of ops) {
    trace.push(op.kind);
    const before = store.getState();
    const affected = new Set<string>();
    const now = clock.now;
    model.now = now;
    const answerOf = (spec: AnswerSpec): EntryAnswerModel | undefined => {
      if (!spec) return undefined;
      tag += 1;
      return makeAnswer(spec.versionId, spec.status, tag);
    };

    switch (op.kind) {
      case 'line': {
        store.dispatch({ type: 'line/set', line: op.text });
        model.line = op.text;
        break;
      }
      case 'submit': {
        created += 1;
        const cid = `e${created}`;
        const parsed: ParsedEntry = { amountMinor: op.amountMinor, spentOn: TODAY, note: op.note };
        const suggestion: CategorySuggestion = { category: categoryOf(op.suggestedIndex), source: 'default', reason: 'Default.' };
        const category = categoryOf(op.categoryIndex);
        store.dispatch({
          type: 'entry/submit',
          entry: { cid, parsed, suggestion, category, exclusionRequested: op.exclusion },
        });
        if (model.pendingCount() < PENDING_LIMIT) {
          model.line = '';
          model.entries.push({
            cid,
            phase: 'pending',
            category,
            exclusionRequested: op.exclusion,
            parsed,
            suggestion,
            submittedAt: now,
            pendingSince: now,
            alreadyRemoved: false,
            windowOpen: false,
            sources: new Set(),
            pausedSince: null,
            pausedTotal: 0,
          });
        }
        break;
      }
      case 'confirm': {
        const entry = pickEntry(model, op.target, ['pending']);
        const cid = entry?.cid ?? 'ghost';
        affected.add(cid);
        const answer = answerOf(op.answer);
        store.dispatch({
          type: 'entry/confirmed',
          cid,
          expenseId: op.expenseId,
          ...(op.recordVersion !== undefined ? { recordVersion: op.recordVersion } : {}),
          ...(op.excluded !== undefined ? { excluded: op.excluded } : {}),
          ...(op.categoryIndex !== undefined ? { category: categoryOf(op.categoryIndex) } : {}),
          ...(answer ? { answer } : {}),
        });
        if (entry && entry.phase === 'pending') {
          entry.phase = 'saved';
          entry.expenseId = op.expenseId;
          if (op.recordVersion !== undefined) entry.recordVersion = op.recordVersion;
          if (op.excluded !== undefined) entry.excluded = op.excluded;
          if (op.categoryIndex !== undefined) entry.category = categoryOf(op.categoryIndex);
          entry.confirmedAt = now;
          entry.alreadyRemoved = false;
          entry.windowOpen = true;
          entry.sources = new Set();
          entry.pausedSince = null;
          entry.pausedTotal = 0;
          model.accept(entry, answer);
        }
        break;
      }
      case 'fail': {
        const entry = pickEntry(model, op.target, ['pending']);
        const cid = entry?.cid ?? 'ghost';
        affected.add(cid);
        store.dispatch({ type: 'entry/failed', cid, error: { message: 'Failed.' } });
        if (entry && entry.phase === 'pending') entry.phase = 'failed';
        break;
      }
      case 'retry': {
        const entry = pickEntry(model, op.target, ['failed']);
        const cid = entry?.cid ?? 'ghost';
        affected.add(cid);
        store.dispatch({ type: 'entry/retry', cid });
        if (entry && entry.phase === 'failed' && model.pendingCount() < PENDING_LIMIT) {
          entry.phase = 'pending';
          entry.pendingSince = now;
        }
        break;
      }
      case 'discard': {
        const entry = pickEntry(model, op.target, ['failed', 'undone']);
        const cid = entry?.cid ?? 'ghost';
        affected.add(cid);
        store.dispatch({ type: 'entry/discard', cid });
        if (entry && (entry.phase === 'failed' || entry.phase === 'undone')) {
          model.entries = model.entries.filter((candidate) => candidate !== entry);
        }
        break;
      }
      case 'edit': {
        const entry = pickEntry(model, op.target, ['failed']);
        const cid = entry?.cid ?? 'ghost';
        affected.add(cid);
        store.dispatch({ type: 'entry/edit', cid, line: op.text });
        // Requirement 7.10: the entry moves back to the input only when the input is empty.
        if (entry && entry.phase === 'failed' && model.line.trim() === '') {
          model.entries = model.entries.filter((candidate) => candidate !== entry);
          model.line = op.text;
        }
        break;
      }
      case 'updated': {
        const entry = pickEntry(model, op.target, ['saved', 'undo_failed']);
        const cid = entry?.cid ?? 'ghost';
        affected.add(cid);
        const answer = answerOf(op.answer);
        store.dispatch({
          type: 'entry/updated',
          cid,
          ...(op.categoryIndex !== undefined ? { category: categoryOf(op.categoryIndex) } : {}),
          ...(op.excluded !== undefined ? { excluded: op.excluded } : {}),
          ...(op.recordVersion !== undefined ? { recordVersion: op.recordVersion } : {}),
          ...(answer ? { answer } : {}),
        });
        if (entry && (entry.phase === 'saved' || entry.phase === 'undo_failed')) {
          if (op.categoryIndex !== undefined) entry.category = categoryOf(op.categoryIndex);
          if (op.excluded !== undefined) entry.excluded = op.excluded;
          if (op.recordVersion !== undefined) entry.recordVersion = op.recordVersion;
          model.accept(entry, answer);
        }
        break;
      }
      case 'undoStart': {
        const entry = pickEntry(model, op.target, ['saved', 'undo_failed']);
        const cid = entry?.cid ?? 'ghost';
        affected.add(cid);
        store.dispatch({ type: 'entry/undoStart', cid });
        if (entry && ((entry.phase === 'saved' && entry.windowOpen) || entry.phase === 'undo_failed')) {
          entry.phase = 'removing';
          entry.windowOpen = false;
          entry.sources = new Set();
          entry.pausedSince = null;
        }
        break;
      }
      case 'undone': {
        const entry = pickEntry(model, op.target, ['removing']);
        const cid = entry?.cid ?? 'ghost';
        affected.add(cid);
        const answer = answerOf(op.answer);
        store.dispatch({
          type: 'entry/undone',
          cid,
          ...(op.alreadyRemoved ? { alreadyRemoved: true } : {}),
          ...(answer ? { answer } : {}),
        });
        if (entry && entry.phase === 'removing') {
          entry.phase = 'undone';
          if (op.alreadyRemoved) entry.alreadyRemoved = true;
          model.accept(entry, answer);
        }
        break;
      }
      case 'undoFailed': {
        const entry = pickEntry(model, op.target, ['removing']);
        const cid = entry?.cid ?? 'ghost';
        affected.add(cid);
        store.dispatch({ type: 'entry/undoFailed', cid, error: { message: 'Failed.' } });
        if (entry && entry.phase === 'removing') entry.phase = 'undo_failed';
        break;
      }
      case 'pause': {
        const entry = pickEntry(model, op.target, ['saved']);
        const cid = entry?.cid ?? 'ghost';
        affected.add(cid);
        store.dispatch({ type: 'undo/pause', cid, source: op.source });
        if (entry && entry.phase === 'saved' && entry.windowOpen && !entry.sources.has(op.source)) {
          if (entry.sources.size === 0) entry.pausedSince = now;
          entry.sources.add(op.source);
        }
        break;
      }
      case 'resume': {
        const entry = pickEntry(model, op.target, ['saved']);
        const cid = entry?.cid ?? 'ghost';
        affected.add(cid);
        store.dispatch({ type: 'undo/resume', cid, source: op.source });
        if (entry && entry.phase === 'saved' && entry.windowOpen && entry.sources.has(op.source)) {
          entry.sources.delete(op.source);
          if (entry.sources.size === 0 && entry.pausedSince !== null) {
            entry.pausedTotal += now - entry.pausedSince;
            entry.pausedSince = null;
          }
        }
        break;
      }
      case 'advance': {
        clock.advance(op.elapsedMs);
        model.now = clock.now;
        // The control ends when the deadline passes, unless it is paused. Entries with an undo pending or failed
        // have no window to expire.
        for (const entry of model.entries) {
          if (entry.phase === 'saved' && entry.windowOpen && entry.pausedSince === null && deadlineOf(entry) <= model.now) {
            entry.windowOpen = false;
            entry.sources = new Set();
          }
        }
        break;
      }
    }
    expectStore(store.getState(), model, before, op.kind === 'advance' ? 'all' : affected);
  }
  store.reset();
}

/* ----------------------------------------------------------------------------------------------------------------- */
/* Property 2: in-order responses make the most recently confirmed entry current                                      */
/* ----------------------------------------------------------------------------------------------------------------- */

type OrderedStep = { kind: 'submit' } | { kind: 'confirm'; pickIndex: number } | { kind: 'fail'; pickIndex: number };

const orderedStepArb: fc.Arbitrary<OrderedStep> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('submit' as const) }) },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant('confirm' as const), pickIndex: fc.nat(100) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('fail' as const), pickIndex: fc.nat(100) }) },
);

function runOrderedScenario(steps: readonly OrderedStep[]): void {
  trace = [];
  const clock = new FakeTimers();
  const store = createQuickAddStore({ now: () => clock.now, timers: clock });
  let created = 0;
  let version = 0;
  let lastConfirmed: string | undefined;

  for (const step of steps) {
    trace.push(step.kind);
    const pending = store.getState().entries.filter((entry) => entry.phase === 'pending');
    if (step.kind === 'submit') {
      created += 1;
      store.dispatch({
        type: 'entry/submit',
        entry: {
          cid: `o${created}`,
          parsed: { amountMinor: 100, spentOn: TODAY, note: 'x' },
          suggestion: { category: 'Food', source: 'default', reason: 'Default.' },
          category: 'Food',
        },
      });
    } else if (pending.length > 0) {
      const entry = pending[step.pickIndex % pending.length] as QuickAddEntry;
      if (step.kind === 'fail') {
        store.dispatch({ type: 'entry/failed', cid: entry.cid, error: { message: 'Failed.' } });
      } else {
        version += 1;
        store.dispatch({ type: 'entry/confirmed', cid: entry.cid, expenseId: version, answer: makeAnswer(version, 'available', version) });
        lastConfirmed = entry.cid;
      }
    }
    clock.advance(1_000);
    const current = selectCurrentAnswerEntry(store.getState());
    check(current?.cid === lastConfirmed, () => 'the current answer is not the most recently confirmed entry');
    check(selectCurrentAnswer(store.getState())?.dataVersion === (version === 0 ? undefined : version), () => 'current answer version differs');
  }
  store.reset();
}

/* ----------------------------------------------------------------------------------------------------------------- */
/* Property 3: the real actions on the real runner and the fake backend, responses held and released in any order     */
/* ----------------------------------------------------------------------------------------------------------------- */

interface ActionTarget {
  pickIndex: number;
  legal: boolean;
}

type ActionOp =
  | { kind: 'line'; text: string }
  | { kind: 'submit'; rupees: number; wordIndex: number; commits: boolean }
  | { kind: 'resolve'; pickIndex: number; deliver: boolean }
  | { kind: 'retry'; target: ActionTarget; commits: boolean }
  | { kind: 'edit'; target: ActionTarget }
  | { kind: 'discard'; target: ActionTarget }
  | { kind: 'undo'; target: ActionTarget; commits: boolean };

const WORDS = ['chai', 'coffee', 'lunch', 'auto', 'books'];

const actionOpArb: fc.Arbitrary<ActionOp> = fc.oneof(
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('line' as const), text: lineTextArb }) },
  {
    weight: 7,
    arbitrary: fc.record({
      kind: fc.constant('submit' as const),
      rupees: fc.integer({ min: 1, max: 900 }),
      wordIndex: fc.nat(WORDS.length - 1),
      commits: fc.boolean(),
    }),
  },
  { weight: 8, arbitrary: fc.record({ kind: fc.constant('resolve' as const), pickIndex: fc.nat(1000), deliver: fc.integer({ min: 0, max: 9 }).map((n) => n < 7) }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('retry' as const), target: targetArb, commits: fc.boolean() }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('edit' as const), target: targetArb }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('discard' as const), target: targetArb }) },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant('undo' as const), target: targetArb, commits: fc.boolean() }) },
);

const actionScenarioArb = fc.record({
  ops: fc.array(actionOpArb, { minLength: 1, maxLength: 30, size: 'max' }),
  drain: fc.array(fc.boolean(), { minLength: 40, maxLength: 40, size: 'max' }),
  drainReversed: fc.boolean(),
});

interface HeldRequest {
  cid: string;
  kind: 'create' | 'undo';
  key: string;
  scope: string;
  reply: SpendingBackendReply | null;
  version: number | null;
  recordId: number | null;
  gate: Deferred<MutationEnvelope>;
  action?: Promise<unknown>;
  open: boolean;
}

interface ActionModelEntry {
  cid: string;
  phase: EntryPhase;
  expenseId?: number;
  answerVersion?: number;
}

interface Intent {
  cid: string;
  kind: 'create' | 'undo';
  commits: boolean;
}

interface CommittedReply {
  kind: 'create' | 'undo';
  reply: SpendingBackendReply;
}

function envelopeVersion(reply: SpendingBackendReply): number {
  return (reply.body as { clarity: { dataVersion: number } }).clarity.dataVersion;
}

function envelopeRecordId(reply: SpendingBackendReply): number {
  return (reply.body as { mutation: { recordId: number } }).mutation.recordId;
}

async function runActionScenario(scenario: { ops: readonly ActionOp[]; drain: readonly boolean[]; drainReversed: boolean }): Promise<void> {
  trace = [];
  const backend = new FakeQuickAddBackend(MONTH, { categories: CATEGORIES });
  const clarityStore = createClarityStore();
  const clock = new FakeTimers();
  const store = createQuickAddStore({ now: () => clock.now, timers: clock });
  const memory = createMemoryClient({ queryClient: new QueryClient(), isEnabled: () => true });
  const requests: HeldRequest[] = [];
  const committed = new Map<string, CommittedReply>();
  const keysByScope = new Map<string, Set<string>>();
  const problems: string[] = [];
  let intent: Intent | null = null;
  let idCounter = 0;

  // The real runner keeps the Idempotency-Key of a command until it is confirmed. `send` plays the transport: a
  // request that commits reaches the fake backend at once (which replays a key it has seen), and its response is held
  // until the scenario releases it, drops it, or the request is rejected before the server applies it.
  const runner = createMutationStatusStore({
    clarityStore,
    send(request: MutationRequest): Promise<MutationEnvelope> {
      const current = intent;
      if (!current) {
        problems.push('a request was sent without an action');
        return Promise.reject(new Error('unexpected request'));
      }
      const known = committed.get(request.idempotencyKey);
      let reply: SpendingBackendReply | null = null;
      if (current.commits || known !== undefined) {
        reply = backend.handle({
          method: request.method,
          path: request.path,
          body: request.body,
          headers: { 'idempotency-key': request.idempotencyKey },
        });
        if (reply.status !== 200) problems.push(`backend answered ${reply.status}`);
        if (known === undefined && reply.status === 200) committed.set(request.idempotencyKey, { kind: current.kind, reply });
      }
      const gate = deferred<MutationEnvelope>();
      const scope = `${current.kind}:${current.cid}`;
      const keys = keysByScope.get(scope) ?? new Set<string>();
      keys.add(request.idempotencyKey);
      keysByScope.set(scope, keys);
      requests.push({
        cid: current.cid,
        kind: current.kind,
        key: request.idempotencyKey,
        scope,
        reply,
        version: reply ? envelopeVersion(reply) : null,
        recordId: reply ? envelopeRecordId(reply) : null,
        gate,
        open: true,
      });
      return gate.promise;
    },
  });

  const actions = createQuickAddActions({
    store,
    runner,
    memory,
    readSnapshot: async () => undefined,
    reportChange: () => undefined,
    context: () => ({ categories: CATEGORIES }),
    isEnabled: () => true,
    today: () => TODAY,
    createId: () => {
      idCounter += 1;
      return `c${idCounter}`;
    },
  });

  const entries: ActionModelEntry[] = [];
  let modelLine = '';
  const pendingCount = () => entries.filter((entry) => entry.phase === 'pending').length;

  function pick(target: ActionTarget, phases: readonly EntryPhase[]): ActionModelEntry | undefined {
    const inPhase = target.legal ? entries.filter((entry) => phases.includes(entry.phase)) : [];
    const pool = inPhase.length > 0 ? inPhase : entries;
    return pool.length === 0 ? undefined : pool[target.pickIndex % pool.length];
  }

  function verify(before: QuickAddState, affected: ReadonlySet<string>): void {
    check(problems.length === 0, () => problems.join('; '));
    const state = store.getState();
    check(state.line === modelLine, () => 'draft line differs');
    check(
      state.entries.map((entry) => entry.cid).join('|') === entries.map((entry) => entry.cid).join('|'),
      () => `order ${state.entries.map((entry) => entry.cid).join(',')} expected ${entries.map((entry) => entry.cid).join(',')}`,
    );
    entries.forEach((expected, index) => {
      const entry = state.entries[index] as QuickAddEntry;
      check(entry.phase === expected.phase, () => `${expected.cid} is ${entry.phase}, expected ${expected.phase}`);
      check(entry.expenseId === expected.expenseId, () => `${expected.cid} expense id differs`);
      check(entry.answer?.dataVersion === expected.answerVersion, () => `${expected.cid} answer version differs`);
      check(entry.undo === undefined || entry.phase === 'saved', () => `${expected.cid} holds an undo window in ${entry.phase}`);
    });

    const pending = state.entries.filter((entry) => entry.phase === 'pending').length;
    check(pending <= PENDING_LIMIT, () => `${pending} entries pending`);
    check(isSubmissionBlocked(state) === (pending === PENDING_LIMIT), () => `blocked flag with ${pending} pending`);

    // The newest confirmed snapshot is the current answer, whatever order the responses arrived in.
    let newest: ActionModelEntry | undefined;
    for (const entry of entries) {
      if (entry.answerVersion !== undefined && (newest?.answerVersion === undefined || entry.answerVersion > newest.answerVersion)) {
        newest = entry;
      }
    }
    check(selectCurrentAnswerEntry(state)?.cid === newest?.cid, () => 'current answer entry differs');
    check(selectCurrentAnswer(state)?.dataVersion === newest?.answerVersion, () => 'current answer version differs');

    // Isolation and legal phase moves.
    const after = new Map(state.entries.map((entry) => [entry.cid, entry]));
    for (const previous of before.entries) {
      const next = after.get(previous.cid);
      if (next && !ALLOWED_NEXT[previous.phase].includes(next.phase)) mismatch(`${previous.cid} moved ${previous.phase} -> ${next.phase}`);
      if (affected.has(previous.cid)) continue;
      check(next === previous, () => `${previous.cid} changed by an action on another entry`);
    }

    // Keys: one per command (same on every retry), none shared between commands.
    const owners = new Map<string, string>();
    for (const [scope, keys] of keysByScope) {
      check(keys.size === 1, () => `${scope} used ${keys.size} keys`);
      for (const key of keys) {
        check(!owners.has(key), () => `${scope} shares a key with ${owners.get(key)}`);
        owners.set(key, scope);
      }
    }
    // The server applied each committed command once, however many times it was sent.
    let created = 0;
    let removed = 0;
    for (const { kind } of committed.values()) {
      if (kind === 'create') created += 1;
      else removed += 1;
    }
    check(backend.expenses.length === created - removed, () => `server holds ${backend.expenses.length} expenses, expected ${created - removed}`);
    const ids = entries.map((entry) => entry.expenseId).filter((id): id is number => id !== undefined);
    check(new Set(ids).size === ids.length, () => 'two entries share an expense id');
  }

  async function release(held: HeldRequest, deliver: boolean): Promise<void> {
    held.open = false;
    const model = entries.find((entry) => entry.cid === held.cid);
    const succeeds = held.reply !== null && deliver;
    if (succeeds) held.gate.resolve(held.reply?.body as MutationEnvelope);
    else if (held.reply !== null) held.gate.reject(new TypeError('Failed to fetch'));
    else held.gate.reject(Object.assign(new Error('Service unavailable.'), { status: 503 }));
    await held.action;
    if (!model) return;
    const acceptVersion = () => {
      if (held.version !== null && (model.answerVersion === undefined || held.version > model.answerVersion)) {
        model.answerVersion = held.version;
      }
    };
    if (held.kind === 'create') {
      if (succeeds) {
        model.phase = 'saved';
        model.expenseId = held.recordId ?? undefined;
        acceptVersion();
      } else {
        model.phase = 'failed';
      }
    } else if (succeeds) {
      model.phase = 'undone';
      acceptVersion();
    } else {
      model.phase = 'undo_failed';
    }
  }

  /** Runs an action that may send one request, and attaches its promise to that request. */
  async function act(next: Intent | null, call: () => Promise<unknown>): Promise<boolean> {
    const sent = requests.length;
    intent = next;
    const promise = call();
    intent = null;
    if (requests.length > sent) {
      (requests[requests.length - 1] as HeldRequest).action = promise;
      return true;
    }
    await promise;
    return false;
  }

  verify(store.getState(), new Set());
  try {
    for (const op of scenario.ops) {
      trace.push(op.kind);
      const before = store.getState();
      const affected = new Set<string>();

      switch (op.kind) {
        case 'line': {
          store.dispatch({ type: 'line/set', line: op.text });
          modelLine = op.text;
          break;
        }
        case 'submit': {
          const blocked = pendingCount() >= PENDING_LIMIT;
          const cid = `c${idCounter + 1}`;
          const line = `${op.rupees} ${WORDS[op.wordIndex] as string}`;
          const sent = await act({ cid, kind: 'create', commits: op.commits }, () => actions.submit({ line }));
          check(sent === !blocked, () => (blocked ? 'a request was sent while five entries were pending' : 'a submission sent no request'));
          if (!blocked) {
            entries.push({ cid, phase: 'pending' });
            modelLine = '';
          }
          break;
        }
        case 'resolve': {
          const open = requests.filter((request) => request.open);
          if (open.length === 0) break;
          const held = open[op.pickIndex % open.length] as HeldRequest;
          affected.add(held.cid);
          await release(held, op.deliver);
          break;
        }
        case 'retry': {
          const entry = pick(op.target, ['failed', 'undo_failed']);
          const cid = entry?.cid ?? 'ghost';
          affected.add(cid);
          const kind = entry?.phase === 'undo_failed' ? 'undo' : 'create';
          const sent = await act({ cid, kind, commits: op.commits }, () => actions.retry(cid));
          if (entry && entry.phase === 'failed' && pendingCount() < PENDING_LIMIT) {
            check(sent, () => 'a retry sent no request');
            entry.phase = 'pending';
          } else if (entry && entry.phase === 'undo_failed') {
            check(sent, () => 'an undo retry sent no request');
            entry.phase = 'removing';
          } else {
            check(!sent, () => 'a request was sent by a retry that is not available');
          }
          break;
        }
        case 'edit': {
          const entry = pick(op.target, ['failed']);
          const cid = entry?.cid ?? 'ghost';
          affected.add(cid);
          await act(null, async () => actions.edit(cid));
          if (entry && entry.phase === 'failed' && modelLine.trim() === '') {
            entries.splice(entries.indexOf(entry), 1);
            modelLine = store.getState().line;
            check(modelLine.trim() !== '', () => 'an edit left the input empty');
          }
          break;
        }
        case 'discard': {
          const entry = pick(op.target, ['failed', 'undone']);
          const cid = entry?.cid ?? 'ghost';
          affected.add(cid);
          await act(null, async () => actions.discard(cid));
          if (entry && (entry.phase === 'failed' || entry.phase === 'undone')) entries.splice(entries.indexOf(entry), 1);
          break;
        }
        case 'undo': {
          // Undo is offered on a saved entry and again on one whose undo failed (Requirement 8.11).
          const entry = pick(op.target, ['saved', 'undo_failed']);
          const cid = entry?.cid ?? 'ghost';
          affected.add(cid);
          const sent = await act({ cid, kind: 'undo', commits: op.commits }, () => actions.undo(cid));
          if (entry && (entry.phase === 'saved' || entry.phase === 'undo_failed')) {
            check(sent, () => 'an undo sent no request');
            entry.phase = 'removing';
          } else {
            check(!sent, () => 'a request was sent by an undo that is not available');
          }
          break;
        }
      }
      verify(before, affected);
    }

    // Release everything that is still in flight, in any order, and check the settled state.
    let step = 0;
    for (;;) {
      const open = requests.filter((request) => request.open);
      if (open.length === 0) break;
      const held = (scenario.drainReversed ? open[open.length - 1] : open[0]) as HeldRequest;
      const before = store.getState();
      trace.push('drain');
      await release(held, scenario.drain[step % scenario.drain.length] ?? true);
      step += 1;
      verify(before, new Set([held.cid]));
    }
    for (const entry of entries) {
      check(entry.phase !== 'pending' && entry.phase !== 'removing', () => `${entry.cid} is still ${entry.phase} with nothing in flight`);
    }
  } finally {
    store.reset();
    memory.dispose();
    resetExpenseEventsForTests();
  }
}

/* ----------------------------------------------------------------------------------------------------------------- */

describe('Feature: quick-add-daily-answer, Property 21: The entry store keeps entries isolated and ordered', () => {
  it('matches the reference model of phases, order, deadlines, waking-up flag, and current answer under a fake clock', async () => {
    await assertWithMismatch(() => assertProperty(
      fc.property(fc.array(storeOpArb, { minLength: 1, maxLength: 45, size: 'max' }), (ops) => {
        runStoreScenario(ops);
      }),
      { numRuns: RUNS },
    ));
  });

  it('makes the most recently confirmed entry the current answer when snapshots arrive in order', async () => {
    await assertWithMismatch(() => assertProperty(
      fc.property(fc.array(orderedStepArb, { minLength: 1, maxLength: 40, size: 'max' }), (steps) => {
        runOrderedScenario(steps);
      }),
      { numRuns: RUNS },
    ));
  });

  it('keeps entries isolated, keyed once, and ordered when the real actions get out-of-order, lost, and rejected responses', async () => {
    await assertWithMismatch(() => assertProperty(
      fc.asyncProperty(actionScenarioArb, async (scenario) => {
        await runActionScenario(scenario);
      }),
      { numRuns: RUNS },
    ));
  }, 60_000);

  it('reproduces the equal-version rule on a minimal example', () => {
    // A guard for the model itself: a held answer that is not available is replaced at an equal version by an
    // available one, and an available answer is never replaced at an equal version.
    const clock = new FakeTimers();
    const store = createQuickAddStore({ now: () => clock.now, timers: clock });
    store.dispatch({
      type: 'entry/submit',
      entry: {
        cid: 'g1',
        parsed: { amountMinor: 100, spentOn: TODAY, note: '' },
        suggestion: { category: 'Food', source: 'default', reason: 'Default.' },
        category: 'Food',
      },
    });
    const failed = makeAnswer(3, 'calculation_failed', 1);
    const good = makeAnswer(3, 'available', 2);
    const other = makeAnswer(3, 'available', 3);
    store.dispatch({ type: 'entry/confirmed', cid: 'g1', expenseId: 1, answer: failed });
    store.dispatch({ type: 'entry/updated', cid: 'g1', answer: good });
    expect(selectCurrentAnswer(store.getState())).toBe(good);
    store.dispatch({ type: 'entry/updated', cid: 'g1', answer: other });
    expect(selectCurrentAnswer(store.getState())).toBe(good);
    store.dispatch({ type: 'entry/updated', cid: 'g1', answer: makeAnswer(2, 'available', 4) });
    expect(selectCurrentAnswer(store.getState())).toBe(good);
    store.reset();
  });
});

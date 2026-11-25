/**
 * Quick Add actions: `submit`, `retry`, `edit`, `discard`, `undo`, `changeCategory`, `setExclusion`, `forgetMemory`,
 * and `recalculate`.
 *
 * Every action is built on pieces that already exist:
 *   - the parser, suggester, hints, and warning classifier decide what an entry is and what the User saw;
 *   - the mutation runner sends each expense write (scope `new-expense:<cid>` until the create is confirmed, then
 *     `expense:<id>`), keeps the Idempotency-Key per logical command, and times a request out after 60 seconds;
 *   - the Quick Add store holds the entry rows and answers (see `quickAddStore.ts`);
 *   - the memory client sends the category memory writes and keeps the hints cache current;
 *   - `publishExpenseChange` and the measurement call run only after the server confirmed a change.
 *
 * What is sent (Requirements 4.5, 18.7): the structured amount in paise, the category, the note when there is one,
 * `spentOn`, and `excludeFromDailyAllowance: true` only when the User asked for it. The typed line is never sent. The
 * Idempotency-Key is a `crypto.randomUUID()` value made by the runner, one per logical command (Requirement 15.12).
 * The contract header is added by the existing client.
 *
 * Failures (Requirements 7.7, 7.8, 4.7, 4.8, 7.23): a failed create keeps its values. A same-key retry is offered for
 * network failures, timeouts, 408, 428, 429, and 5xx. A validation failure names the field and the accepted
 * constraint, offers Edit, and offers no retry. Edit places the formatter output in the input, and the next
 * submission is a new entry with a new key.
 *
 * Undo (Requirements 8.2 to 8.13): the DELETE targets the expense id the create returned and carries no record
 * version, so a category change or an edit elsewhere cannot block it. A 404 means the expense was already removed. A
 * confirmed undo restores the category memory this entry wrote by compensation with a revision check: the previous
 * category is written back, or the entry is deleted when there was none, unless the entry changed after this entry
 * wrote it, in which case the newer change stays.
 *
 * Memory (Requirements 6.5, 6.8): a category memory write happens when the User chose a category other than the
 * suggestion. It never blocks or alters the save. A failed write is shown on the row with a retry, and the saved
 * expense stays.
 *
 * Privacy (Requirements 14.1, 14.3): nothing here writes a note, amount, category, or Note_Key to the console or to
 * browser storage. Nothing is persisted. Every action is a no-op with zero requests while Quick_Add_Enabled is off
 * (Requirement 16.2).
 *
 * Requirements: 4.5, 4.7, 4.8, 6.2 to 6.5, 6.8, 7.1, 7.7 to 7.11, 7.16, 7.22, 7.23, 8.2 to 8.8, 8.12, 8.13, 13.8, 14.1,
 * 14.6, 15.11, 15.12, 16.17, 18.7, 18.17.
 */
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useMemo, useRef } from 'react';
import { REQUEST_TIMEOUT_CODE, clarityApi } from '../../api';
import { useMeasurement } from '../../hooks/useMeasurement';
import { fireHaptic } from '../../native/haptics';
import { useMutationRunner } from '../MutationStatusProvider';
import {
  CLARITY_SCHEMA_VERSION,
  type ClarityReadResponse,
  type FinancialSnapshot,
  type MutationEnvelope,
  type MutationMetadata,
} from '../contracts';
import type { MutationCommand, MutationFailure, MutationSubmitResult } from '../mutationStatusStore';
import { queryKeys, selectNewestSnapshot } from '../queryClient';
import { selectQuickAddEnabled } from '../rollout';
import { FALLBACK_EXPENSE_CATEGORIES } from '../spendingInputs';
import { buildSaveAnnouncement } from './announcement';
import { EXPENSE_DELETE_OPERATION, buildEntryAnswer, type AnswerEntryInput, type EntryAnswerModel } from './answer';
import {
  publishExpenseChange,
  type ConfirmedExpenseChange,
  type ConfirmedExpenseRecord,
  type ExpenseChangeKind,
} from './expenseEvents';
import { formatQuickAddLine } from './formatter';
import { kolkataToday } from './kolkata';
import {
  findMemoryEntry,
  memoryClient,
  selectSuggestionSources,
  type MemoryClient,
  type MemoryResult,
} from './memoryClient';
import { normalizeNoteKey } from './noteKey';
import { parseQuickAddLine, type ParseProblem } from './parser';
import { useQuickAddStore } from './QuickAddProvider';
import {
  isSubmissionBlocked,
  selectEntry,
  submissionBlockedReason,
  type EntryError,
  type EntryMemory,
  type QuickAddEntry,
  type QuickAddStore,
} from './quickAddStore';
import { suggestCategory } from './suggester';
import { classifyEntryWarning } from './warning';

/** Requirement 7.23: an expense request with no response in 60 seconds counts as failed, with the same-key retry. */
export const EXPENSE_REQUEST_TIMEOUT_MS = 60_000;

export const EXPENSES_PATH = '/finance/expenses';

const FIELD_LABELS: Readonly<Record<string, string>> = Object.freeze({
  amountMinor: 'Amount',
  category: 'Category',
  note: 'Note',
  spentOn: 'Date',
  excludeFromDailyAllowance: 'Not counted against today',
});

export const SAVE_FAILED_TEXT = 'The entry was not saved. Your entry is kept.';
export const UNDO_FAILED_TEXT = 'The entry could not be removed. It is still saved.';
export const CHANGE_FAILED_TEXT = 'The change was not saved. The expense is unchanged.';
export const ALREADY_REMOVED_TEXT = 'This entry was already removed.';
export const REMOVED_TEXT = 'Entry removed.';
export const UNDO_BUSY_TEXT = 'Another change to this expense is still saving. Try Undo again in a moment.';

/* --------------------------------- types ---------------------------------- */

/** What the actions need to know about the User's data. All of it is optional and read when an action runs. */
export interface QuickAddContext {
  /** Every category available to the User. Defaults to the fallback list the Spending page uses before it loads. */
  categories?: readonly string[];
  /** Labels of the bills active this month (`snapshot.facts` bills). Unavailable when absent. */
  billLabels?: readonly string[] | null;
  /** The server's Large_Entry_Threshold in paise. Unavailable when absent. */
  largeEntryThresholdMinor?: number | null;
}

export interface QuickAddActionsOptions extends QuickAddContext {
  /** The memory client. Defaults to the application client. */
  memory?: MemoryClient;
  /** Defaults to `selectQuickAddEnabled()`, read each time an action runs. */
  isEnabled?: () => boolean;
  /** The Kolkata date. Defaults to `kolkataToday()`. */
  today?: () => string;
  /** A new random entry id. Defaults to `crypto.randomUUID()`. */
  createId?: () => string;
}

export interface SubmitInput {
  /** The line to save. Defaults to the draft line in the store. */
  line?: string;
  /** The category the User chose in the preview. Defaults to the suggestion. */
  category?: string;
  /** "Save, but don't count against today". Applies only to an entry dated Today (Requirement 18.8). */
  excludeFromToday?: boolean;
}

export type SubmitResult =
  | { status: 'disabled' }
  | { status: 'blocked'; reason: string }
  | { status: 'invalid'; problems: ParseProblem[] }
  | { status: 'confirmed'; cid: string; expenseId: number }
  | { status: 'failed'; cid: string; error: EntryError }
  /** The session was cleared while the request was in flight. */
  | { status: 'discarded'; cid: string };

export type RetryResult =
  | { status: 'disabled' }
  /** There is nothing to resend for this entry, or a validation failure means the entry must be edited. */
  | { status: 'unavailable' }
  | { status: 'blocked'; reason: string }
  | { status: 'confirmed'; cid: string }
  | { status: 'failed'; cid: string; error: EntryError }
  | { status: 'discarded'; cid: string }
  | { status: 'memory'; cid: string; memory: EntryMemory['phase'] };

export type EditResult =
  | { status: 'disabled' }
  | { status: 'unavailable' }
  /** The input is not empty, so the entry stays as it is (Requirement 7.10). */
  | { status: 'input_not_empty' }
  | { status: 'edited'; line: string };

export type DiscardResult = { status: 'disabled' } | { status: 'unavailable' } | { status: 'discarded' };

export type UndoResult =
  | { status: 'disabled' }
  | { status: 'unavailable' }
  | { status: 'removed'; cid: string }
  | { status: 'already_removed'; cid: string }
  | { status: 'failed'; cid: string; error: EntryError }
  | { status: 'discarded'; cid: string };

export type ChangeResult =
  | { status: 'disabled' }
  | { status: 'unavailable' }
  /** The values already match, so nothing was sent. */
  | { status: 'unchanged' }
  /** Another change to the same expense is still in flight. */
  | { status: 'busy' }
  | { status: 'confirmed'; cid: string }
  | { status: 'failed'; cid: string; error: EntryError }
  | { status: 'discarded'; cid: string };

export type ForgetResult = { status: 'disabled' } | { status: 'not_found' } | MemoryResult;

export type RecalculateResult =
  | { status: 'disabled' }
  | { status: 'unavailable' }
  | { status: 'failed' }
  /** `answerUpdated` is false when the store kept the answer it held because the re-read was not newer. */
  | { status: 'recalculated'; answerUpdated: boolean };

export interface QuickAddActions {
  submit(input?: SubmitInput): Promise<SubmitResult>;
  /**
   * Resends a failed entry with the same key, an undo that failed with the same command, or a memory write that
   * failed. The row's state decides which.
   */
  retry(cid: string): Promise<RetryResult>;
  edit(cid: string): EditResult;
  discard(cid: string): DiscardResult;
  undo(cid: string): Promise<UndoResult>;
  changeCategory(cid: string, category: string): Promise<ChangeResult>;
  /** Sets or clears the Allowance_Exclusion of a saved entry through the expense update operation. */
  setExclusion(cid: string, excluded: boolean): Promise<ChangeResult>;
  /** The "Forget this" action: deletes the Memory_Entry of this Note_Key. */
  forgetMemory(input: { noteKey: string }): Promise<ForgetResult>;
  /** Re-reads the snapshot of the entry's month and refreshes its answer. Resubmits nothing. */
  recalculate(cid: string): Promise<RecalculateResult>;
}

export interface QuickAddActionDeps {
  store: QuickAddStore;
  runner: {
    submit(command: MutationCommand): Promise<MutationSubmitResult>;
    retry(scopeKey: string): Promise<MutationSubmitResult>;
    dismiss(scopeKey: string): void;
  };
  memory: MemoryClient;
  /** Reads the confirmed snapshot of a month, or undefined when the read failed. Never throws. */
  readSnapshot(month: string): Promise<FinancialSnapshot | undefined>;
  /** Reports a confirmed change through the existing `financialChangeUi` measurement call. */
  reportChange(changeId: number): void;
  context(): QuickAddContext;
  isEnabled(): boolean;
  today(): string;
  createId(): string;
}

/* -------------------------------- helpers --------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function newEntryScope(cid: string): string {
  return `new-expense:${cid}`;
}

function expenseScope(expenseId: number): string {
  return `expense:${expenseId}`;
}

function monthOf(entry: QuickAddEntry): string {
  return entry.parsed.spentOn.slice(0, 7);
}

function isUsableExpenseId(id: number | undefined): id is number {
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0;
}

/** A same-key retry can succeed for these failures. A validation failure goes back to Edit (Requirement 4.8). */
export function isRetryableFailure(failure: Pick<MutationFailure, 'status' | 'code'>): boolean {
  const { status, code } = failure;
  if (code === REQUEST_TIMEOUT_CODE) return true;
  if (status === undefined || status === 0) return true;
  return status === 408 || status === 425 || status === 428 || status === 429 || status >= 500;
}

function constraintText(constraint: MutationFailure['constraint']): string {
  if (typeof constraint === 'string') return constraint;
  if (!isRecord(constraint)) return '';
  const parts: string[] = [];
  for (const [name, value] of Object.entries(constraint)) {
    if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
      parts.push(`${name} ${String(value)}`);
    }
  }
  return parts.join(', ');
}

/** Requirement 4.7: the message names the affected field and the accepted constraint. */
function failureMessage(failure: MutationFailure, retryable: boolean): string {
  if (retryable || failure.field === undefined) return failure.message;
  const label = FIELD_LABELS[failure.field] ?? failure.field;
  const accepted = constraintText(failure.constraint);
  return `${label}: ${failure.message}${accepted ? ` Accepted: ${accepted}.` : ''}`;
}

function toEntryError(failure: MutationFailure, retryable = isRetryableFailure(failure)): EntryError {
  return {
    message: failureMessage(failure, retryable),
    ...(failure.status !== undefined ? { status: failure.status } : {}),
    ...(failure.code !== undefined ? { code: failure.code } : {}),
    ...(failure.field !== undefined ? { field: failure.field } : {}),
    retryable,
  };
}

function textOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function confirmedRecord(mutation: MutationMetadata): Record<string, unknown> | null {
  return isRecord(mutation.record) ? mutation.record : null;
}

function asConfirmedRecord(record: Record<string, unknown> | null): ConfirmedExpenseRecord | null {
  if (!record) return null;
  const { id, month, category, amountMinor } = record;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return null;
  if (typeof month !== 'string' || typeof category !== 'string') return null;
  if (typeof amountMinor !== 'number' || !Number.isSafeInteger(amountMinor)) return null;
  return record as unknown as ConfirmedExpenseRecord;
}

/** Tells every mounted view that the server confirmed an expense change. Only called for confirmed results. */
function publishConfirmed(kind: ExpenseChangeKind, expenseId: number, mutation: MutationMetadata, entry: QuickAddEntry) {
  const record = kind === 'delete' ? null : asConfirmedRecord(confirmedRecord(mutation));
  const fields = mutation as unknown as Record<string, unknown>;
  const transition = isRecord(fields.expenseTransition) ? fields.expenseTransition : fields;
  const original = textOrUndefined(transition.originalPeriod);
  const resulting = textOrUndefined(transition.resultingPeriod);
  const change: ConfirmedExpenseChange = {
    confirmed: true,
    kind,
    expenseId,
    originalMonth: kind === 'create' ? null : (original ?? monthOf(entry)),
    resultingMonth: kind === 'delete' ? null : (resulting ?? record?.month ?? monthOf(entry)),
    originalCategory: kind === 'create' ? null : (textOrUndefined(transition.originalCategory) ?? null),
    resultingCategory: kind === 'delete' ? null : (record?.category ?? textOrUndefined(transition.resultingCategory) ?? null),
    excludedFromDailyAllowance: record && typeof record.excludeFromDailyAllowance === 'boolean'
      ? record.excludeFromDailyAllowance
      : null,
    record,
  };
  publishExpenseChange(change);
}

/** The memory writes that are still in flight, by entry, so an Undo can wait for the revision it must restore. */
const pendingMemoryWrites = new WeakMap<QuickAddStore, Map<string, Promise<unknown>>>();

function trackMemoryWrite(store: QuickAddStore, cid: string, write: Promise<unknown>): Promise<unknown> {
  let writes = pendingMemoryWrites.get(store);
  if (!writes) {
    writes = new Map();
    pendingMemoryWrites.set(store, writes);
  }
  const tracked = write.finally(() => {
    if (writes.get(cid) === tracked) writes.delete(cid);
  });
  writes.set(cid, tracked);
  return tracked;
}

/* ---------------------------------- factory -------------------------------- */

export function createQuickAddActions(deps: QuickAddActionDeps): QuickAddActions {
  const { store, runner, memory, readSnapshot, reportChange } = deps;

  const writeKey = (cid: string) => `entry:${cid}`;
  const restoreKey = (cid: string) => `restore:${cid}`;

  function entryOf(cid: string): QuickAddEntry | undefined {
    return selectEntry(store.getState(), cid);
  }

  function announce(text: string) {
    store.dispatch({ type: 'announcement/push', announcement: { text } });
  }

  function createCommand(entry: QuickAddEntry): MutationCommand {
    const { parsed } = entry;
    return {
      scopeKey: newEntryScope(entry.cid),
      label: 'Save expense',
      path: EXPENSES_PATH,
      method: 'POST',
      // Structured fields only. The typed line is never sent (Requirement 4.5).
      body: {
        amountMinor: parsed.amountMinor,
        category: entry.category,
        ...(parsed.note !== '' ? { note: parsed.note } : {}),
        spentOn: parsed.spentOn,
        ...(entry.exclusionRequested ? { excludeFromDailyAllowance: true } : {}),
      },
      months: [monthOf(entry)],
      timeoutMs: EXPENSE_REQUEST_TIMEOUT_MS,
    };
  }

  function updateCommand(entry: QuickAddEntry, expenseId: number, body: Record<string, unknown>, label: string): MutationCommand {
    return {
      scopeKey: expenseScope(expenseId),
      label,
      path: `${EXPENSES_PATH}/${expenseId}`,
      method: 'PATCH',
      body,
      months: [monthOf(entry)],
      timeoutMs: EXPENSE_REQUEST_TIMEOUT_MS,
    };
  }

  function deleteCommand(entry: QuickAddEntry, expenseId: number): MutationCommand {
    return {
      scopeKey: expenseScope(expenseId),
      label: 'Undo expense',
      path: `${EXPENSES_PATH}/${expenseId}`,
      method: 'DELETE',
      // No expectedRecordVersion: a change made meanwhile cannot block the deletion (Requirement 8.13).
      body: {},
      months: [monthOf(entry)],
      timeoutMs: EXPENSE_REQUEST_TIMEOUT_MS,
    };
  }

  function answerInput(entry: QuickAddEntry, exclusionRequested = entry.exclusionRequested): AnswerEntryInput {
    return {
      category: entry.category,
      spentOn: entry.parsed.spentOn,
      note: entry.parsed.note,
      exclusionRequested,
      warning: entry.warning,
    };
  }

  /** An envelope built from a snapshot read, for the answer of an entry whose own response is not at hand. */
  function envelopeFromRead(entry: QuickAddEntry, snapshot: FinancialSnapshot, removed: boolean): MutationEnvelope {
    const id = entry.expenseId ?? 0;
    return {
      schemaVersion: CLARITY_SCHEMA_VERSION,
      mutation: {
        changeId: 0,
        idempotencyKey: '',
        scopeKey: expenseScope(id),
        operation: removed ? EXPENSE_DELETE_OPERATION : 'expense.update',
        recordType: 'expense',
        recordId: id,
        status: 'confirmed',
        recordVersion: entry.recordVersion ?? 0,
        record: removed
          ? null
          : {
            id,
            month: monthOf(entry),
            category: entry.category,
            amountMinor: entry.parsed.amountMinor,
            note: entry.parsed.note === '' ? null : entry.parsed.note,
            spentOn: entry.parsed.spentOn,
            excludeFromDailyAllowance: entry.excluded === true,
          },
      },
      clarity: snapshot,
    };
  }

  /* ------------------------------ category memory --------------------------- */

  function noteKeyOf(entry: QuickAddEntry): string | null {
    return normalizeNoteKey(entry.parsed.note);
  }

  /**
   * Requirement 6.5: remember the choice when the User chose a category other than the suggestion. The write never
   * blocks or alters the save. It records what Undo needs to restore: the entry as it was and the revision written.
   */
  function rememberChoice(cid: string, category: string): Promise<unknown> {
    const entry = entryOf(cid);
    if (!entry || !deps.isEnabled()) return Promise.resolve();
    const noteKey = noteKeyOf(entry);
    if (noteKey === null) return Promise.resolve();
    const changedSuggestion = category !== entry.suggestion.category;
    // After this entry wrote a choice, a change back to the suggestion must replace that choice too.
    const replacesOwnWrite = entry.memory.written !== undefined && entry.memory.phase === 'saved';
    if (!changedSuggestion && !replacesOwnWrite) return Promise.resolve();
    if (memory.getState().memoryUnavailable) return Promise.resolve();

    const startedGeneration = store.getGeneration();
    const view = memory.readView();
    const known = view.state === 'ready';
    const existing = findMemoryEntry(view, noteKey);
    const firstWrite = entry.memory.previous === undefined && entry.memory.written === undefined;
    store.dispatch({
      type: 'entry/memory',
      cid,
      memory: {
        phase: 'saving',
        noteKey,
        // The entry before this entry's first write. Unknown while the hints are not loaded, and then not restored.
        ...(firstWrite && known ? { previous: existing ? { category: existing.category, revision: existing.revision } : null } : {}),
      },
    });
    return trackMemoryWrite(store, cid, settleMemoryWrite(cid, noteKey, memory.remember(writeKey(cid), { noteKey, category }), startedGeneration));
  }

  async function settleMemoryWrite(
    cid: string,
    noteKey: string,
    write: Promise<MemoryResult>,
    startedGeneration: number,
  ): Promise<void> {
    const result = await write;
    if (store.getGeneration() !== startedGeneration) return;
    if (result.status === 'saved') {
      const stored = findMemoryEntry(memory.readView(), noteKey);
      store.dispatch({
        type: 'entry/memory',
        cid,
        memory: { phase: 'saved', ...(stored ? { written: { id: stored.id, revision: stored.revision } } : {}) },
      });
    } else if (result.status === 'failed' || result.status === 'conflict') {
      // The expense stays saved. The row says the choice was not remembered and offers a retry (Requirement 6.8).
      store.dispatch({ type: 'entry/memory', cid, memory: { phase: 'failed' } });
    } else {
      // Memory is switched off or unavailable. Nothing to show, and the save is unaffected.
      store.dispatch({ type: 'entry/memory', cid, memory: { phase: 'none' } });
    }
  }

  /** Requirement 8.6: compensation after a confirmed undo. */
  async function restoreMemory(cid: string): Promise<void> {
    const startedGeneration = store.getGeneration();
    await pendingMemoryWrites.get(store)?.get(cid);
    if (store.getGeneration() !== startedGeneration) return;
    const entry = entryOf(cid);
    if (!entry) return;
    const { noteKey, written, previous, phase } = entry.memory;
    if (!noteKey || !written || previous === undefined || phase === 'failed' || phase === 'none') {
      // Nothing was written, or what was written cannot be proven: leave the memory as it is.
      if (phase === 'failed' || phase === 'saving') store.dispatch({ type: 'entry/memory', cid, memory: { phase: 'none' } });
      return;
    }
    if (!deps.isEnabled()) return;
    store.dispatch({ type: 'entry/memory', cid, memory: { phase: 'restoring' } });
    const result = previous === null
      ? await memory.forget(restoreKey(cid), { id: written.id, expectedRevision: written.revision })
      : await memory.remember(restoreKey(cid), {
        noteKey,
        category: previous.category,
        expectedRevision: written.revision,
      });
    if (store.getGeneration() !== startedGeneration) return;
    // A conflict means the entry changed after this entry wrote it. The newer change stays.
    const retryable = result.status === 'failed' && result.retryable;
    store.dispatch({ type: 'entry/memory', cid, memory: { phase: retryable ? 'restore_failed' : 'none' } });
  }

  /* ------------------------------ create ------------------------------------ */

  async function settleCreate(cid: string, result: MutationSubmitResult, startedGeneration: number): Promise<SubmitResult> {
    if (store.getGeneration() !== startedGeneration || result.outcome === 'discarded') return { status: 'discarded', cid };
    const entry = entryOf(cid);
    if (!entry) return { status: 'discarded', cid };

    if (result.outcome === 'failed') {
      const error = toEntryError(result.error);
      store.dispatch({ type: 'entry/failed', cid, error });
      announce(SAVE_FAILED_TEXT);
      return { status: 'failed', cid, error };
    }
    if (result.outcome !== 'confirmed') {
      // `duplicate` and `not_retryable` send nothing. The row stays as it is.
      return { status: 'discarded', cid };
    }

    const { envelope } = result;
    const { mutation } = envelope;
    const record = confirmedRecord(mutation);
    const recordId = typeof mutation.recordId === 'number' ? mutation.recordId : (typeof record?.id === 'number' ? record.id : 0);
    const category = textOrUndefined(record?.category) ?? entry.category;
    const excluded = typeof record?.excludeFromDailyAllowance === 'boolean' ? record.excludeFromDailyAllowance : undefined;
    const amountMinor = typeof record?.amountMinor === 'number' && Number.isSafeInteger(record.amountMinor)
      ? record.amountMinor
      : entry.parsed.amountMinor;
    const answer = buildEntryAnswer(envelope, answerInput(entry), deps.today());

    store.dispatch({
      type: 'entry/confirmed',
      cid,
      expenseId: recordId,
      ...(Number.isSafeInteger(mutation.recordVersion) ? { recordVersion: mutation.recordVersion } : {}),
      ...(excluded !== undefined ? { excluded } : {}),
      category,
      answer,
      announcement: { text: buildSaveAnnouncement({ amountMinor, category, answer }) },
    });
    // One haptic impulse per confirmed save, including a confirmed same-key retry. Never for pending or failed rows.
    if (entryOf(cid)?.phase === 'saved') void fireHaptic('save');
    // Only a confirmed result is published and reported (Requirements 7.17, 14.6).
    if (isUsableExpenseId(recordId)) publishConfirmed('create', recordId, mutation, entry);
    if (Number.isSafeInteger(mutation.changeId)) reportChange(mutation.changeId);

    await rememberChoice(cid, category);
    return { status: 'confirmed', cid, expenseId: recordId };
  }

  async function runCreate(cid: string, send: () => Promise<MutationSubmitResult>): Promise<SubmitResult> {
    const startedGeneration = store.getGeneration();
    try {
      return await settleCreate(cid, await send(), startedGeneration);
    } catch {
      // Whatever went wrong, the entry keeps its values and can be retried. Nothing is logged.
      const error: EntryError = { message: 'The entry could not be saved.', retryable: true };
      store.dispatch({ type: 'entry/failed', cid, error });
      return { status: 'failed', cid, error };
    }
  }

  async function submit(input: SubmitInput = {}): Promise<SubmitResult> {
    if (!deps.isEnabled()) return { status: 'disabled' };
    const state = store.getState();
    if (isSubmissionBlocked(state)) {
      return { status: 'blocked', reason: submissionBlockedReason(state) ?? '' };
    }

    const today = deps.today();
    const parsedResult = parseQuickAddLine(input.line ?? state.line, today);
    if (!parsedResult.ok) return { status: 'invalid', problems: parsedResult.problems };
    const parsed = parsedResult.entry;

    const context = deps.context();
    const categories = context.categories && context.categories.length > 0 ? context.categories : FALLBACK_EXPENSE_CATEGORIES;
    const sources = selectSuggestionSources(memory.readView());
    const suggestion = suggestCategory({
      note: parsed.note,
      categories,
      memory: sources.memory,
      history: sources.history,
    });
    const warning = classifyEntryWarning({
      entry: parsed,
      today,
      billKeys: context.billLabels,
      largeEntryThresholdMinor: context.largeEntryThresholdMinor,
    });
    const cid = deps.createId();
    // The mark is only for an entry dated Today (Requirement 18.8).
    const exclusionRequested = input.excludeFromToday === true && parsed.spentOn === today;

    // The pending row is added and the input cleared in this same step (Requirements 7.2, 7.3).
    store.dispatch({
      type: 'entry/submit',
      entry: {
        cid,
        parsed,
        suggestion,
        category: input.category ?? suggestion.category,
        exclusionRequested,
        warning,
      },
    });
    const entry = entryOf(cid);
    if (!entry) return { status: 'blocked', reason: submissionBlockedReason(store.getState()) ?? '' };

    return runCreate(cid, () => runner.submit(createCommand(entry)));
  }

  async function retryCreate(cid: string, entry: QuickAddEntry): Promise<RetryResult> {
    if (entry.error?.retryable === false) return { status: 'unavailable' };
    store.dispatch({ type: 'entry/retry', cid });
    if (entryOf(cid)?.phase !== 'pending') {
      return { status: 'blocked', reason: submissionBlockedReason(store.getState()) ?? '' };
    }
    const result = await runCreate(cid, async () => {
      const resent = await runner.retry(newEntryScope(cid));
      // With no failed command left to resend, the same command is submitted again. The runner keeps the
      // Idempotency-Key of an unchanged command until it is confirmed, so the key is the same.
      return resent.outcome === 'not_retryable' ? runner.submit(createCommand(entry)) : resent;
    });
    return result.status === 'confirmed' ? { status: 'confirmed', cid } : result.status === 'failed'
      ? { status: 'failed', cid, error: result.error }
      : { status: 'discarded', cid };
  }

  /* ------------------------------ updates ----------------------------------- */

  async function settleUpdate(cid: string, result: MutationSubmitResult, startedGeneration: number, exclusionRequested?: boolean): Promise<ChangeResult> {
    if (store.getGeneration() !== startedGeneration || result.outcome === 'discarded') return { status: 'discarded', cid };
    if (result.outcome === 'duplicate') return { status: 'busy' };
    if (result.outcome === 'not_retryable') return { status: 'unavailable' };
    const entry = entryOf(cid);
    if (result.outcome === 'failed') {
      // The row keeps its last confirmed values (Requirement 13.6). The runner status carries the scoped failure.
      announce(CHANGE_FAILED_TEXT);
      return { status: 'failed', cid, error: toEntryError(result.error) };
    }
    if (!entry) return { status: 'discarded', cid };

    const { envelope } = result;
    const { mutation } = envelope;
    const record = confirmedRecord(mutation);
    const category = textOrUndefined(record?.category) ?? entry.category;
    const excluded = typeof record?.excludeFromDailyAllowance === 'boolean' ? record.excludeFromDailyAllowance : undefined;
    const answer = buildEntryAnswer(envelope, answerInput(entry, exclusionRequested ?? entry.exclusionRequested), deps.today());

    store.dispatch({
      type: 'entry/updated',
      cid,
      category,
      ...(excluded !== undefined ? { excluded } : {}),
      ...(Number.isSafeInteger(mutation.recordVersion) ? { recordVersion: mutation.recordVersion } : {}),
      answer,
      announcement: { text: excluded === true && entry.excluded !== true ? 'Not counted against today.' : `Category changed to ${category}.` },
    });
    if (isUsableExpenseId(entry.expenseId)) publishConfirmed('update', entry.expenseId, mutation, entry);
    if (Number.isSafeInteger(mutation.changeId)) reportChange(mutation.changeId);

    if (category !== entry.category) await rememberChoice(cid, category);
    return { status: 'confirmed', cid };
  }

  async function runUpdate(
    cid: string,
    build: (entry: QuickAddEntry, expenseId: number) => MutationCommand,
    exclusionRequested?: boolean,
  ): Promise<ChangeResult> {
    if (!deps.isEnabled()) return { status: 'disabled' };
    const entry = entryOf(cid);
    if (!entry || entry.phase !== 'saved' || !isUsableExpenseId(entry.expenseId)) return { status: 'unavailable' };
    const startedGeneration = store.getGeneration();
    try {
      return await settleUpdate(cid, await runner.submit(build(entry, entry.expenseId)), startedGeneration, exclusionRequested);
    } catch {
      return { status: 'failed', cid, error: { message: 'The change could not be saved.', retryable: true } };
    }
  }

  function changeCategory(cid: string, category: string): Promise<ChangeResult> {
    if (!deps.isEnabled()) return Promise.resolve({ status: 'disabled' });
    const entry = entryOf(cid);
    if (entry && entry.phase === 'saved' && entry.category === category) return Promise.resolve({ status: 'unchanged' });
    return runUpdate(cid, (current, id) => updateCommand(current, id, { category }, 'Change category'));
  }

  function setExclusion(cid: string, excluded: boolean): Promise<ChangeResult> {
    if (!deps.isEnabled()) return Promise.resolve({ status: 'disabled' });
    const entry = entryOf(cid);
    if (entry && entry.phase === 'saved' && (entry.excluded === true) === excluded && entry.excluded !== undefined) {
      return Promise.resolve({ status: 'unchanged' });
    }
    return runUpdate(
      cid,
      (current, id) => updateCommand(current, id, { excludeFromDailyAllowance: excluded }, excluded ? 'Do not count against today' : 'Count against today'),
      excluded,
    );
  }

  /* -------------------------------- undo ------------------------------------ */

  async function settleUndo(cid: string, result: MutationSubmitResult, startedGeneration: number): Promise<UndoResult> {
    if (store.getGeneration() !== startedGeneration || result.outcome === 'discarded') return { status: 'discarded', cid };
    const entry = entryOf(cid);
    if (!entry) return { status: 'discarded', cid };

    if (result.outcome === 'duplicate') {
      const error: EntryError = { message: UNDO_BUSY_TEXT, retryable: true };
      store.dispatch({ type: 'entry/undoFailed', cid, error });
      return { status: 'failed', cid, error };
    }
    if (result.outcome === 'not_retryable') return { status: 'discarded', cid };

    if (result.outcome === 'failed') {
      if (result.error.status === 404) return settleAlreadyRemoved(cid, entry, startedGeneration);
      // Requirement 8.8: the expense stays saved, and Undo stays available with the same-key retry.
      const error = toEntryError(result.error, true);
      store.dispatch({ type: 'entry/undoFailed', cid, error });
      announce(UNDO_FAILED_TEXT);
      return { status: 'failed', cid, error };
    }

    const { envelope } = result;
    // The answer shows the server's values after the deletion (Requirement 8.5).
    const answer = buildEntryAnswer(envelope, answerInput(entry), deps.today());
    store.dispatch({ type: 'entry/undone', cid, answer, announcement: { text: REMOVED_TEXT } });
    // One distinct impulse per confirmed undo. The already-removed (404) path is not a completed undo.
    if (entryOf(cid)?.phase === 'undone') void fireHaptic('undo');
    if (isUsableExpenseId(entry.expenseId)) publishConfirmed('delete', entry.expenseId, envelope.mutation, entry);
    if (Number.isSafeInteger(envelope.mutation.changeId)) reportChange(envelope.mutation.changeId);
    await restoreMemory(cid);
    return { status: 'removed', cid };
  }

  /** Requirement 8.12: the expense no longer exists. Say so and refresh the answer from the server. */
  async function settleAlreadyRemoved(cid: string, entry: QuickAddEntry, startedGeneration: number): Promise<UndoResult> {
    runner.dismiss(expenseScope(entry.expenseId ?? 0));
    const snapshot = await readSnapshot(monthOf(entry));
    if (store.getGeneration() !== startedGeneration) return { status: 'discarded', cid };
    const answer = snapshot ? buildEntryAnswer(envelopeFromRead(entry, snapshot, true), answerInput(entry), deps.today()) : undefined;
    store.dispatch({
      type: 'entry/undone',
      cid,
      alreadyRemoved: true,
      ...(answer ? { answer } : {}),
      announcement: { text: ALREADY_REMOVED_TEXT },
    });
    // The entry did not remove it, so no memory is restored and nothing is published or reported.
    if (entryOf(cid)?.memory.phase === 'failed') store.dispatch({ type: 'entry/memory', cid, memory: { phase: 'none' } });
    return { status: 'already_removed', cid };
  }

  async function performUndo(cid: string, entry: QuickAddEntry, expenseId: number): Promise<UndoResult> {
    const startedGeneration = store.getGeneration();
    try {
      return await settleUndo(cid, await runner.submit(deleteCommand(entry, expenseId)), startedGeneration);
    } catch {
      const error: EntryError = { message: UNDO_FAILED_TEXT, retryable: true };
      store.dispatch({ type: 'entry/undoFailed', cid, error });
      return { status: 'failed', cid, error };
    }
  }

  async function undo(cid: string): Promise<UndoResult> {
    if (!deps.isEnabled()) return { status: 'disabled' };
    const entry = entryOf(cid);
    if (!entry || !isUsableExpenseId(entry.expenseId)) return { status: 'unavailable' };
    // Undo is offered while the window is open, and stays while an undo is pending or has failed (Requirement 8.9).
    const open = (entry.phase === 'saved' && entry.undo !== undefined) || entry.phase === 'undo_failed';
    if (!open) return { status: 'unavailable' };
    // The row shows "removing" in this same step (Requirement 8.3).
    store.dispatch({ type: 'entry/undoStart', cid });
    if (entryOf(cid)?.phase !== 'removing') return { status: 'unavailable' };
    // The same command keeps the same Idempotency-Key until it is confirmed, so a retry is a same-key retry.
    return performUndo(cid, entry, entry.expenseId);
  }

  /* -------------------------------- retry ----------------------------------- */

  async function retryMemory(cid: string, entry: QuickAddEntry): Promise<RetryResult> {
    const restoring = entry.memory.phase === 'restore_failed';
    const key = restoring ? restoreKey(cid) : writeKey(cid);
    const startedGeneration = store.getGeneration();
    store.dispatch({ type: 'entry/memory', cid, memory: { phase: restoring ? 'restoring' : 'saving' } });
    const noteKey = entry.memory.noteKey ?? noteKeyOf(entry);
    const result = await memory.retry(key);
    if (store.getGeneration() !== startedGeneration) return { status: 'discarded', cid };
    if (restoring) {
      store.dispatch({ type: 'entry/memory', cid, memory: { phase: result.status === 'failed' && result.retryable ? 'restore_failed' : 'none' } });
    } else if (noteKey) {
      await settleMemoryWrite(cid, noteKey, Promise.resolve(result), startedGeneration);
    }
    return { status: 'memory', cid, memory: entryOf(cid)?.memory.phase ?? 'none' };
  }

  async function retry(cid: string): Promise<RetryResult> {
    if (!deps.isEnabled()) return { status: 'disabled' };
    const entry = entryOf(cid);
    if (!entry) return { status: 'unavailable' };

    if (entry.phase === 'failed') return retryCreate(cid, entry);

    if (entry.phase === 'undo_failed') {
      if (!isUsableExpenseId(entry.expenseId)) return { status: 'unavailable' };
      store.dispatch({ type: 'entry/undoStart', cid });
      if (entryOf(cid)?.phase !== 'removing') return { status: 'unavailable' };
      const result = await performUndo(cid, entry, entry.expenseId);
      if (result.status === 'removed' || result.status === 'already_removed') return { status: 'confirmed', cid };
      return result.status === 'failed' ? { status: 'failed', cid, error: result.error } : { status: 'discarded', cid };
    }

    if (entry.memory.phase === 'failed' || entry.memory.phase === 'restore_failed') return retryMemory(cid, entry);

    if (entry.phase === 'saved' && isUsableExpenseId(entry.expenseId)) {
      // A category or exclusion change that failed: resend it with its original key.
      const startedGeneration = store.getGeneration();
      const result = await settleUpdate(cid, await runner.retry(expenseScope(entry.expenseId)), startedGeneration);
      if (result.status === 'confirmed') return { status: 'confirmed', cid };
      return result.status === 'failed' ? { status: 'failed', cid, error: result.error } : { status: 'unavailable' };
    }
    return { status: 'unavailable' };
  }

  /* --------------------------- edit, discard, forget ------------------------- */

  function edit(cid: string): EditResult {
    if (!deps.isEnabled()) return { status: 'disabled' };
    const entry = entryOf(cid);
    if (!entry || entry.phase !== 'failed') return { status: 'unavailable' };
    const line = formatQuickAddLine(entry.parsed);
    store.dispatch({ type: 'entry/edit', cid, line });
    if (entryOf(cid)) return { status: 'input_not_empty' };
    // The failed command is dropped. The next submission is a new entry with a new Idempotency-Key (Requirement 7.10).
    runner.dismiss(newEntryScope(cid));
    memory.discard(writeKey(cid));
    return { status: 'edited', line };
  }

  function discard(cid: string): DiscardResult {
    if (!deps.isEnabled()) return { status: 'disabled' };
    const entry = entryOf(cid);
    if (!entry || (entry.phase !== 'failed' && entry.phase !== 'undone')) return { status: 'unavailable' };
    store.dispatch({ type: 'entry/discard', cid });
    if (entryOf(cid)) return { status: 'unavailable' };
    // Only the row and its status go. Every confirmed record stays (Requirement 7.11).
    runner.dismiss(entry.phase === 'failed' || !isUsableExpenseId(entry.expenseId) ? newEntryScope(cid) : expenseScope(entry.expenseId));
    memory.discard(writeKey(cid));
    memory.discard(restoreKey(cid));
    return { status: 'discarded' };
  }

  async function forgetMemory({ noteKey }: { noteKey: string }): Promise<ForgetResult> {
    if (!deps.isEnabled()) return { status: 'disabled' };
    const found = findMemoryEntry(memory.readView(), noteKey);
    if (!found) return { status: 'not_found' };
    return memory.forget(`forget:${found.id}`, { id: found.id });
  }

  /* ------------------------------- recalculate ------------------------------- */

  async function recalculate(cid: string): Promise<RecalculateResult> {
    if (!deps.isEnabled()) return { status: 'disabled' };
    const entry = entryOf(cid);
    if (!entry || (entry.phase !== 'saved' && entry.phase !== 'undo_failed') || !isUsableExpenseId(entry.expenseId)) {
      return { status: 'unavailable' };
    }
    const startedGeneration = store.getGeneration();
    // A read only. The entry is not sent again (Requirement 9.14).
    const snapshot = await readSnapshot(monthOf(entry));
    if (store.getGeneration() !== startedGeneration) return { status: 'unavailable' };
    if (!snapshot) return { status: 'failed' };
    const current = entryOf(cid);
    if (!current) return { status: 'unavailable' };
    const before = current.answer;
    const answer: EntryAnswerModel = buildEntryAnswer(envelopeFromRead(current, snapshot, false), answerInput(current), deps.today());
    store.dispatch({ type: 'entry/updated', cid, answer });
    return { status: 'recalculated', answerUpdated: entryOf(cid)?.answer !== before };
  }

  return { submit, retry, edit, discard, undo, changeCategory, setExclusion, forgetMemory, recalculate };
}

/* ----------------------------------- hook ---------------------------------- */

async function readMonthSnapshot(queryClient: QueryClient, month: string): Promise<FinancialSnapshot | undefined> {
  try {
    return await queryClient.fetchQuery({
      queryKey: queryKeys.clarity(month),
      staleTime: 0,
      retry: false,
      queryFn: async (): Promise<FinancialSnapshot> => {
        const response = await clarityApi.get<ClarityReadResponse>(`/finance/clarity?month=${encodeURIComponent(month)}`);
        // A response older than the cached snapshot never replaces it.
        return selectNewestSnapshot(queryClient.getQueryData<FinancialSnapshot>(queryKeys.clarity(month)), response.snapshot);
      },
    });
  } catch {
    return undefined;
  }
}

function defaultCreateId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * The Quick Add actions for the signed-in session. Must be used inside FinancialClarityProvider,
 * MutationStatusProvider, and QuickAddProvider. The returned object is stable for the life of the provider, and the
 * context options (categories, bill labels, threshold, flag, clock) are read each time an action runs, so a change of
 * categories or bills needs no new object. The memory client is read once, when the provider mounts.
 */
export function useQuickAddActions(options: QuickAddActionsOptions = {}): QuickAddActions {
  const store = useQuickAddStore();
  const runner = useMutationRunner();
  const queryClient = useQueryClient();
  const measurement = useMeasurement();
  const latest = useRef({ options, queryClient, measurement });
  latest.current = { options, queryClient, measurement };

  return useMemo(() => createQuickAddActions({
    store,
    runner,
    memory: latest.current.options.memory ?? memoryClient,
    readSnapshot: (month) => readMonthSnapshot(latest.current.queryClient, month),
    reportChange: (changeId) => {
      // The existing value-free event only. No new event name (Requirement 14.5).
      latest.current.measurement.financialChangeUi({ changeId, causedReload: false, causedPageWideLoading: false });
    },
    context: () => latest.current.options,
    isEnabled: () => (latest.current.options.isEnabled ?? (() => selectQuickAddEnabled()))(),
    today: () => (latest.current.options.today ?? kolkataToday)(),
    createId: () => (latest.current.options.createId ?? defaultCreateId)(),
  }), [store, runner]);
}

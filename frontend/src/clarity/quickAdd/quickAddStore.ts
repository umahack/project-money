// Framework-free state for Quick Add: the draft line, the ordered entries and their phases, the Undo
// deadlines with pause, the memory status of each entry, the announcement queue, the five-pending
// submission limit, newest-snapshot-wins answers, and the 5-second "waking up" flag.
//
// `quickAddReducer` is pure. It never reads a clock: every action that depends on time carries `at`.
// `createQuickAddStore` wraps it the way clarityStore wraps the clarity reducer, stamps `at` from an
// injectable clock, and owns the two timers the state needs (the waking-up check of a pending entry and
// the expiry of an Undo window). Timers are held outside the serializable state, as mutationStatusStore
// holds its retry commands.
//
// Everything lives in memory only (Requirement 7.18). This module never touches local storage, session
// storage, cookies, the address, or the console, and it keeps the typed line, notes, and amounts out of
// every log. `subscribeToFinancialStateClear` resets it in QuickAddProvider (Requirement 7.19).
//
// The store does not send requests. The actions of task 12.5 run the mutation runner and report each
// outcome here through `dispatch`.
//
// Requirements: 7.2 to 7.5, 7.12 to 7.14, 7.18, 7.19, 8.1, 8.9 to 8.11, 9.15, 9.16, 13.4 to 13.6.
import type { EntryAnswerModel } from './answer';
import type { ParsedEntry } from './parser';
import type { CategorySuggestion } from './suggester';
import type { EntryWarning } from './warning';

/** Requirement 8.1: the Undo control is offered for 8 seconds after confirmation. */
export const UNDO_WINDOW_MS = 8_000;
/** Requirement 7.13: a pending entry older than this shows that the free server may be waking up. */
export const WAKING_UP_AFTER_MS = 5_000;
/** Requirement 7.12: submission is disabled while this many entries are pending. */
export const MAX_PENDING_ENTRIES = 5;
/** The announcement queue keeps the newest messages only, so it cannot grow without bound. */
export const MAX_ANNOUNCEMENTS = 10;

export const WAKING_UP_TEXT = 'The free server may be waking up. Your entry is still saving and is not sent again.';
export const SUBMISSION_BLOCKED_TEXT = 'Earlier entries are still saving. Your line is kept. Press Enter again in a moment.';

export type EntryPhase = 'pending' | 'saved' | 'failed' | 'removing' | 'undone' | 'undo_failed';
export type MemoryPhase = 'none' | 'saving' | 'saved' | 'failed' | 'restoring' | 'restore_failed';
/** What holds the Undo window paused: the pointer over the control, or keyboard focus on it (Requirement 8.10). */
export type UndoPauseSource = 'pointer' | 'focus';

export interface EntryError {
  message: string;
  status?: number;
  code?: string;
  field?: string;
  /** False for a validation failure, where a same-key retry cannot succeed (Requirement 4.8). Set by the caller. */
  retryable?: boolean;
}

export interface EntryUndo {
  /** Confirmation time plus 8 seconds, plus every paused span. Meaningless while `pausedRemainingMs` is set. */
  deadline: number;
  /** Present while paused: the time that was left when the pause began. */
  pausedRemainingMs?: number;
  pauseSources?: readonly UndoPauseSource[];
}

export interface EntryMemory {
  phase: MemoryPhase;
  noteKey?: string;
  /** The Memory_Entry this entry wrote, with its revision, for the compensating restore on Undo. */
  written?: { id: number; revision: number };
  /** The entry that the write replaced, or null when there was none. */
  previous?: { category: string; revision: number } | null;
}

export interface QuickAddEntry {
  /** Random UUID, one per submitted entry. */
  cid: string;
  submittedAt: number;
  parsed: ParsedEntry;
  /** What the User saw. */
  suggestion: CategorySuggestion;
  /** What was saved or is selected. */
  category: string;
  exclusionRequested: boolean;
  /** The Entry_Warning shown at submission, kept for the answer's exclusion offer. */
  warning: EntryWarning | null;
  phase: EntryPhase;
  /** When the entry last became pending. Retry restarts it. */
  pendingSince: number;
  /** True after the entry stayed pending for 5 seconds. The request is never resent because of it. */
  wakingUp: boolean;
  expenseId?: number;
  recordVersion?: number;
  /** The mark as the server confirmed it. */
  excluded?: boolean;
  confirmedAt?: number;
  /** Order of confirmation, from the state's sequence. */
  confirmedSeq?: number;
  answer?: EntryAnswerModel;
  /** Order in which the current answer was accepted. Breaks ties between equal snapshot versions. */
  answerSeq?: number;
  undo?: EntryUndo;
  /** The delete returned 404: the expense was already gone (Requirement 8.12). */
  alreadyRemoved?: boolean;
  memory: EntryMemory;
  error?: EntryError;
}

export interface QuickAddAnnouncement {
  key: string;
  text: string;
  assertive: boolean;
}

export interface QuickAddState {
  /** The draft line. The Home input and the dialog show the same text. */
  line: string;
  /** Submission order. */
  entries: readonly QuickAddEntry[];
  dialogOpen: boolean;
  announcements: readonly QuickAddAnnouncement[];
  /** Monotone counter behind confirmation order, answer order, and announcement keys. */
  sequence: number;
}

export const initialQuickAddState: QuickAddState = Object.freeze({
  line: '',
  entries: Object.freeze([]) as readonly QuickAddEntry[],
  dialogOpen: false,
  announcements: Object.freeze([]) as readonly QuickAddAnnouncement[],
  sequence: 0,
});

export interface NewEntryInput {
  cid: string;
  parsed: ParsedEntry;
  suggestion: CategorySuggestion;
  category: string;
  exclusionRequested?: boolean;
  warning?: EntryWarning | null;
}

export interface AnnouncementInput {
  text: string;
  /** Defaults to polite (Requirement 9.18). */
  assertive?: boolean;
}

export type QuickAddAction =
  | { type: 'line/set'; line: string }
  | { type: 'dialog/set'; open: boolean }
  /** Adds a pending row and clears the line in one step. Ignored while five entries are pending or when the cid exists. */
  | { type: 'entry/submit'; entry: NewEntryInput; at: number }
  /** Sets the waking-up flag of an entry that has been pending for 5 seconds. */
  | { type: 'entry/waking'; cid: string; at: number }
  | {
    type: 'entry/confirmed';
    cid: string;
    at: number;
    expenseId: number;
    recordVersion?: number;
    excluded?: boolean;
    /** The category the server confirmed. Defaults to the one submitted. */
    category?: string;
    answer?: EntryAnswerModel;
    announcement?: AnnouncementInput;
  }
  | { type: 'entry/failed'; cid: string; error: EntryError }
  /** Failed to pending, for the same-key retry. Ignored while five entries are pending. */
  | { type: 'entry/retry'; cid: string; at: number }
  /** Removes a failed or undone row. Confirmed records are not touched. */
  | { type: 'entry/discard'; cid: string }
  /** Moves a failed entry back to the input, only when the input is empty (Requirement 7.10). */
  | { type: 'entry/edit'; cid: string; line: string }
  /** A category change, an exclusion change, or a recalculation of a saved entry. */
  | {
    type: 'entry/updated';
    cid: string;
    category?: string;
    excluded?: boolean;
    recordVersion?: number;
    answer?: EntryAnswerModel;
    announcement?: AnnouncementInput;
  }
  /** Saved (while the window is open) or undo_failed to removing. */
  | { type: 'entry/undoStart'; cid: string }
  | {
    type: 'entry/undone';
    cid: string;
    answer?: EntryAnswerModel;
    alreadyRemoved?: boolean;
    announcement?: AnnouncementInput;
  }
  | { type: 'entry/undoFailed'; cid: string; error: EntryError }
  | { type: 'entry/memory'; cid: string; memory: Partial<EntryMemory> }
  | { type: 'undo/pause'; cid: string; source: UndoPauseSource; at: number }
  | { type: 'undo/resume'; cid: string; source: UndoPauseSource; at: number }
  | { type: 'undo/expire'; cid: string; at: number }
  | { type: 'announcement/push'; announcement: AnnouncementInput }
  | { type: 'announcement/consume'; key: string }
  | { type: 'reset' };

/* --------------------------------- selectors -------------------------------- */

export function countPendingEntries(state: QuickAddState): number {
  let count = 0;
  for (const entry of state.entries) if (entry.phase === 'pending') count += 1;
  return count;
}

/** Requirement 7.12. */
export function isSubmissionBlocked(state: QuickAddState): boolean {
  return countPendingEntries(state) >= MAX_PENDING_ENTRIES;
}

/** The text that says why submission is disabled, or null when it is not. */
export function submissionBlockedReason(state: QuickAddState): string | null {
  return isSubmissionBlocked(state) ? SUBMISSION_BLOCKED_TEXT : null;
}

export function countFailedEntries(state: QuickAddState): number {
  let count = 0;
  for (const entry of state.entries) if (entry.phase === 'failed') count += 1;
  return count;
}

export function selectEntry(state: QuickAddState, cid: string): QuickAddEntry | undefined {
  return state.entries.find((entry) => entry.cid === cid);
}

/**
 * The Undo control exists while the window is open, and stays while an undo is pending or has failed
 * (Requirements 8.9 and 8.11).
 */
export function isUndoAvailable(entry: QuickAddEntry): boolean {
  return (entry.phase === 'saved' && entry.undo !== undefined)
    || entry.phase === 'removing'
    || entry.phase === 'undo_failed';
}

/** Milliseconds left in the Undo window at `now`, or null when the entry has no open window. */
export function undoRemainingMs(entry: QuickAddEntry, now: number): number | null {
  if (entry.phase !== 'saved' || entry.undo === undefined) return null;
  if (entry.undo.pausedRemainingMs !== undefined) return entry.undo.pausedRemainingMs;
  return Math.max(0, entry.undo.deadline - now);
}

export function isUndoPaused(entry: QuickAddEntry): boolean {
  return entry.undo?.pausedRemainingMs !== undefined;
}

/**
 * The entry whose answer is the current answer. It is the entry holding the newest confirmed snapshot, the
 * latest accepted one among equal versions, so a late older response never replaces a newer one
 * (Requirements 9.15 and 9.16). With responses in order this is the most recently confirmed entry.
 */
export function selectCurrentAnswerEntry(state: QuickAddState): QuickAddEntry | undefined {
  let best: QuickAddEntry | undefined;
  for (const entry of state.entries) {
    if (!entry.answer) continue;
    if (
      !best
      || !best.answer
      || entry.answer.dataVersion > best.answer.dataVersion
      || (entry.answer.dataVersion === best.answer.dataVersion && (entry.answerSeq ?? 0) > (best.answerSeq ?? 0))
    ) {
      best = entry;
    }
  }
  return best;
}

export function selectCurrentAnswer(state: QuickAddState): EntryAnswerModel | undefined {
  return selectCurrentAnswerEntry(state)?.answer;
}

/* --------------------------------- reducer ---------------------------------- */

function replaceEntry(state: QuickAddState, cid: string, update: (entry: QuickAddEntry) => QuickAddEntry): QuickAddState {
  const index = state.entries.findIndex((entry) => entry.cid === cid);
  if (index < 0) return state;
  const current = state.entries[index] as QuickAddEntry;
  const next = update(current);
  if (next === current) return state;
  const entries = state.entries.slice();
  entries[index] = next;
  return { ...state, entries };
}

/**
 * Whether `incoming` replaces the answer `held` (Requirement 9.15). Mirrors `shouldInstallSnapshot` in
 * patchReducer.ts:
 *  - a strictly higher dataVersion always wins;
 *  - a strictly lower one never does;
 *  - an equal version wins only as a recovery: the held answer is not `available` (calculation failed, missing or
 *    invalid input) and the incoming one is `available`. This lets a recalculation or a re-read at an unchanged
 *    version replace a failed answer. An equal version never replaces an equal `available` answer or another
 *    non-available one, so a repeated read does not make the answer flicker.
 */
export function shouldAcceptAnswer(held: EntryAnswerModel | undefined, incoming: EntryAnswerModel): boolean {
  if (!held) return true;
  if (incoming.dataVersion !== held.dataVersion) return incoming.dataVersion > held.dataVersion;
  return held.status !== 'available' && incoming.status === 'available';
}

function acceptAnswer(
  entry: QuickAddEntry,
  answer: EntryAnswerModel | undefined,
  sequence: number,
): { entry: QuickAddEntry; sequence: number } {
  if (!answer) return { entry, sequence };
  if (!shouldAcceptAnswer(entry.answer, answer)) return { entry, sequence };
  const next = sequence + 1;
  return { entry: { ...entry, answer, answerSeq: next }, sequence: next };
}

function withAnnouncement(state: QuickAddState, input: AnnouncementInput | undefined): QuickAddState {
  if (!input || !input.text) return state;
  const sequence = state.sequence + 1;
  const announcement: QuickAddAnnouncement = {
    key: `qa-announcement-${sequence}`,
    text: input.text,
    assertive: input.assertive === true,
  };
  const announcements = [...state.announcements, announcement].slice(-MAX_ANNOUNCEMENTS);
  return { ...state, sequence, announcements };
}

function omitKey<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const { [key]: _omitted, ...rest } = value;
  return rest;
}

export function quickAddReducer(state: QuickAddState, action: QuickAddAction): QuickAddState {
  switch (action.type) {
    case 'line/set':
      return state.line === action.line ? state : { ...state, line: action.line };

    case 'dialog/set':
      return state.dialogOpen === action.open ? state : { ...state, dialogOpen: action.open };

    case 'entry/submit': {
      const { entry: input, at } = action;
      if (state.entries.some((entry) => entry.cid === input.cid) || isSubmissionBlocked(state)) return state;
      const entry: QuickAddEntry = {
        cid: input.cid,
        submittedAt: at,
        parsed: input.parsed,
        suggestion: input.suggestion,
        category: input.category,
        exclusionRequested: input.exclusionRequested === true,
        warning: input.warning ?? null,
        phase: 'pending',
        pendingSince: at,
        wakingUp: false,
        memory: { phase: 'none' },
      };
      // The row is added and the input cleared in the same step, so the next entry can be typed at once.
      return { ...state, line: '', entries: [...state.entries, entry] };
    }

    case 'entry/waking':
      return replaceEntry(state, action.cid, (entry) => (
        entry.phase === 'pending' && !entry.wakingUp && action.at >= entry.pendingSince + WAKING_UP_AFTER_MS
          ? { ...entry, wakingUp: true }
          : entry
      ));

    case 'entry/confirmed': {
      const target = selectEntry(state, action.cid);
      if (!target || target.phase !== 'pending') return state;
      const confirmedSeq = state.sequence + 1;
      const confirmed: QuickAddEntry = {
        ...omitKey(omitKey(target, 'error'), 'alreadyRemoved'),
        phase: 'saved',
        wakingUp: false,
        expenseId: action.expenseId,
        ...(action.recordVersion !== undefined ? { recordVersion: action.recordVersion } : {}),
        ...(action.excluded !== undefined ? { excluded: action.excluded } : {}),
        category: action.category ?? target.category,
        confirmedAt: action.at,
        confirmedSeq,
        undo: { deadline: action.at + UNDO_WINDOW_MS },
      };
      const accepted = acceptAnswer(confirmed, action.answer, confirmedSeq);
      const next = replaceEntry({ ...state, sequence: accepted.sequence }, action.cid, () => accepted.entry);
      return withAnnouncement(next, action.announcement);
    }

    case 'entry/failed':
      return replaceEntry(state, action.cid, (entry) => (
        entry.phase === 'pending'
          ? { ...entry, phase: 'failed', wakingUp: false, error: action.error }
          : entry
      ));

    case 'entry/retry': {
      const target = selectEntry(state, action.cid);
      if (!target || target.phase !== 'failed' || isSubmissionBlocked(state)) return state;
      return replaceEntry(state, action.cid, (entry) => ({
        ...omitKey(entry, 'error'),
        phase: 'pending',
        pendingSince: action.at,
        wakingUp: false,
      }));
    }

    case 'entry/discard': {
      const target = selectEntry(state, action.cid);
      if (!target || (target.phase !== 'failed' && target.phase !== 'undone')) return state;
      return { ...state, entries: state.entries.filter((entry) => entry.cid !== action.cid) };
    }

    case 'entry/edit': {
      const target = selectEntry(state, action.cid);
      if (!target || target.phase !== 'failed' || state.line.trim() !== '') return state;
      return {
        ...state,
        line: action.line,
        entries: state.entries.filter((entry) => entry.cid !== action.cid),
      };
    }

    case 'entry/updated': {
      const target = selectEntry(state, action.cid);
      if (!target || (target.phase !== 'saved' && target.phase !== 'undo_failed')) return state;
      const changed: QuickAddEntry = {
        ...target,
        ...(action.category !== undefined ? { category: action.category } : {}),
        ...(action.excluded !== undefined ? { excluded: action.excluded } : {}),
        ...(action.recordVersion !== undefined ? { recordVersion: action.recordVersion } : {}),
      };
      const accepted = acceptAnswer(changed, action.answer, state.sequence);
      const next = replaceEntry({ ...state, sequence: accepted.sequence }, action.cid, () => accepted.entry);
      return withAnnouncement(next, action.announcement);
    }

    case 'entry/undoStart': {
      const target = selectEntry(state, action.cid);
      if (!target) return state;
      const open = (target.phase === 'saved' && target.undo !== undefined) || target.phase === 'undo_failed';
      if (!open) return state;
      return replaceEntry(state, action.cid, (entry) => ({
        ...omitKey(omitKey(entry, 'undo'), 'error'),
        phase: 'removing',
      }));
    }

    case 'entry/undone': {
      const target = selectEntry(state, action.cid);
      if (!target || target.phase !== 'removing') return state;
      const settled: QuickAddEntry = {
        ...omitKey(omitKey(target, 'undo'), 'error'),
        phase: 'undone',
        ...(action.alreadyRemoved === true ? { alreadyRemoved: true } : {}),
      };
      const accepted = acceptAnswer(settled, action.answer, state.sequence);
      const next = replaceEntry({ ...state, sequence: accepted.sequence }, action.cid, () => accepted.entry);
      return withAnnouncement(next, action.announcement);
    }

    case 'entry/undoFailed':
      return replaceEntry(state, action.cid, (entry) => (
        entry.phase === 'removing' ? { ...entry, phase: 'undo_failed', error: action.error } : entry
      ));

    case 'entry/memory':
      return replaceEntry(state, action.cid, (entry) => ({
        ...entry,
        memory: { ...entry.memory, ...action.memory },
      }));

    case 'undo/pause':
      return replaceEntry(state, action.cid, (entry) => {
        if (entry.phase !== 'saved' || !entry.undo) return entry;
        const undo = entry.undo;
        const sources = undo.pauseSources ?? [];
        if (sources.includes(action.source)) return entry;
        if (undo.pausedRemainingMs === undefined) {
          // A window that already ended is not paused back to life.
          if (action.at >= undo.deadline) return omitKey(entry, 'undo');
          return {
            ...entry,
            undo: { deadline: undo.deadline, pausedRemainingMs: undo.deadline - action.at, pauseSources: [action.source] },
          };
        }
        return { ...entry, undo: { ...undo, pauseSources: [...sources, action.source] } };
      });

    case 'undo/resume':
      return replaceEntry(state, action.cid, (entry) => {
        if (entry.phase !== 'saved' || !entry.undo || entry.undo.pausedRemainingMs === undefined) return entry;
        const undo = entry.undo;
        const pausedRemainingMs = undo.pausedRemainingMs;
        if (pausedRemainingMs === undefined) return entry;
        const sources = undo.pauseSources ?? [];
        if (!sources.includes(action.source)) return entry;
        const remaining = sources.filter((source) => source !== action.source);
        if (remaining.length > 0) return { ...entry, undo: { ...undo, pauseSources: remaining } };
        // The deadline moves by exactly the paused span.
        return { ...entry, undo: { deadline: action.at + pausedRemainingMs } };
      });

    case 'undo/expire':
      return replaceEntry(state, action.cid, (entry) => (
        entry.phase === 'saved'
          && entry.undo
          && entry.undo.pausedRemainingMs === undefined
          && action.at >= entry.undo.deadline
          ? omitKey(entry, 'undo')
          : entry
      ));

    case 'announcement/push':
      return withAnnouncement(state, action.announcement);

    case 'announcement/consume': {
      const announcements = state.announcements.filter((item) => item.key !== action.key);
      return announcements.length === state.announcements.length ? state : { ...state, announcements };
    }

    case 'reset':
      return initialQuickAddState;
  }
}

/* ----------------------------------- store ---------------------------------- */

type WithOptionalAt<A> = A extends { at: number } ? Omit<A, 'at'> & { at?: number } : A;
/** An action as a caller writes it. The store stamps `at` from its clock when it is omitted. */
export type QuickAddActionInput = WithOptionalAt<QuickAddAction>;

export interface QuickAddTimers {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface QuickAddStore {
  getState(): QuickAddState;
  dispatch(action: QuickAddActionInput): QuickAddState;
  subscribe(listener: () => void): () => void;
  /** Increments on every reset so a response from a cleared session can be ignored. */
  getGeneration(): number;
  /** Stops (false) or restarts (true) the waking-up and Undo timers, for an unmounted provider. */
  setTimersEnabled(enabled: boolean): void;
  /** Discards every draft, entry, and announcement and cancels every timer. */
  reset(): void;
}

export interface QuickAddStoreOptions {
  now?: () => number;
  /** Looked up at call time, so tests may install fake timers after the store exists. */
  timers?: QuickAddTimers;
}

const defaultTimers: QuickAddTimers = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createQuickAddStore({
  now = Date.now,
  timers = defaultTimers,
}: QuickAddStoreOptions = {}): QuickAddStore {
  let state = initialQuickAddState;
  let generation = 0;
  let timersEnabled = true;
  const listeners = new Set<() => void>();
  const wakingTimers = new Map<string, { handle: unknown; since: number }>();
  const expiryTimers = new Map<string, { handle: unknown; deadline: number }>();

  function emit() {
    for (const listener of [...listeners]) listener();
  }

  function cancel(map: Map<string, { handle: unknown }>, cid: string) {
    const scheduled = map.get(cid);
    if (!scheduled) return;
    timers.clearTimeout(scheduled.handle);
    map.delete(cid);
  }

  function cancelAll() {
    for (const cid of [...wakingTimers.keys()]) cancel(wakingTimers, cid);
    for (const cid of [...expiryTimers.keys()]) cancel(expiryTimers, cid);
  }

  function fire(map: Map<string, { handle: unknown }>, cid: string, action: QuickAddAction) {
    map.delete(cid);
    const next = quickAddReducer(state, action);
    if (next !== state) {
      state = next;
      syncTimers();
      emit();
    } else {
      syncTimers();
    }
  }

  function syncTimers() {
    if (!timersEnabled) {
      cancelAll();
      return;
    }
    const live = new Set<string>();
    for (const entry of state.entries) {
      live.add(entry.cid);

      if (entry.phase === 'pending' && !entry.wakingUp) {
        const scheduled = wakingTimers.get(entry.cid);
        if (!scheduled || scheduled.since !== entry.pendingSince) {
          cancel(wakingTimers, entry.cid);
          const since = entry.pendingSince;
          const delay = Math.max(0, since + WAKING_UP_AFTER_MS - now());
          const handle = timers.setTimeout(
            () => fire(wakingTimers, entry.cid, { type: 'entry/waking', cid: entry.cid, at: now() }),
            delay,
          );
          wakingTimers.set(entry.cid, { handle, since });
        }
      } else {
        cancel(wakingTimers, entry.cid);
      }

      const undo = entry.phase === 'saved' ? entry.undo : undefined;
      if (undo && undo.pausedRemainingMs === undefined) {
        const scheduled = expiryTimers.get(entry.cid);
        if (!scheduled || scheduled.deadline !== undo.deadline) {
          cancel(expiryTimers, entry.cid);
          const { deadline } = undo;
          const handle = timers.setTimeout(
            () => fire(expiryTimers, entry.cid, { type: 'undo/expire', cid: entry.cid, at: now() }),
            Math.max(0, deadline - now()),
          );
          expiryTimers.set(entry.cid, { handle, deadline });
        }
      } else {
        cancel(expiryTimers, entry.cid);
      }
    }
    for (const cid of [...wakingTimers.keys()]) if (!live.has(cid)) cancel(wakingTimers, cid);
    for (const cid of [...expiryTimers.keys()]) if (!live.has(cid)) cancel(expiryTimers, cid);
  }

  return {
    getState: () => state,
    getGeneration: () => generation,
    dispatch(input) {
      // Actions without a time field ignore the extra `at`.
      const action = { ...input, at: (input as { at?: number }).at ?? now() } as QuickAddAction;
      const next = quickAddReducer(state, action);
      if (next !== state) {
        state = next;
        syncTimers();
        emit();
      }
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setTimersEnabled(enabled) {
      if (timersEnabled === enabled) return;
      timersEnabled = enabled;
      syncTimers();
    },
    reset() {
      generation += 1;
      cancelAll();
      state = initialQuickAddState;
      emit();
    },
  };
}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeEnvelope, makeSnapshot } from '../../test/clarity-fixtures';
import { buildEntryAnswer, type EntryAnswerModel } from './answer';
import {
  MAX_ANNOUNCEMENTS,
  MAX_PENDING_ENTRIES,
  SUBMISSION_BLOCKED_TEXT,
  UNDO_WINDOW_MS,
  WAKING_UP_AFTER_MS,
  countFailedEntries,
  countPendingEntries,
  createQuickAddStore,
  initialQuickAddState,
  isSubmissionBlocked,
  isUndoAvailable,
  quickAddReducer,
  selectCurrentAnswer,
  selectEntry,
  shouldAcceptAnswer,
  submissionBlockedReason,
  undoRemainingMs,
  type NewEntryInput,
  type QuickAddAction,
  type QuickAddState,
} from './quickAddStore';

const TODAY = '2026-01-15';
const T0 = Date.parse('2026-01-15T06:30:00.000Z');

function newEntry(cid: string, overrides: Partial<NewEntryInput> = {}): NewEntryInput {
  return {
    cid,
    parsed: { amountMinor: 45000, spentOn: TODAY, note: 'swiggy' },
    suggestion: { category: 'Food', source: 'keyword', reason: 'Matched the word swiggy.' },
    category: 'Food',
    ...overrides,
  };
}

function answerAt(dataVersion: number): EntryAnswerModel {
  return buildEntryAnswer(makeEnvelope(makeSnapshot(dataVersion), 'expense:1'), { category: 'Food', spentOn: TODAY }, TODAY);
}

function run(actions: readonly QuickAddAction[], from: QuickAddState = initialQuickAddState): QuickAddState {
  return actions.reduce(quickAddReducer, from);
}

const submit = (cid: string, at = T0, overrides: Partial<NewEntryInput> = {}): QuickAddAction => (
  { type: 'entry/submit', entry: newEntry(cid, overrides), at }
);
const confirm = (cid: string, at = T0, extra: Partial<Extract<QuickAddAction, { type: 'entry/confirmed' }>> = {}): QuickAddAction => (
  { type: 'entry/confirmed', cid, at, expenseId: 100, ...extra }
);
const phases = (state: QuickAddState) => state.entries.map((entry) => `${entry.cid}:${entry.phase}`);

describe('quick add reducer', () => {
  it('adds a pending row, clears the line, and keeps submission order', () => {
    let state = run([{ type: 'line/set', line: '450 swiggy' }]);
    expect(state.line).toBe('450 swiggy');

    state = run([submit('a')], state);
    expect(state.line).toBe('');
    expect(state.entries[0]).toMatchObject({
      cid: 'a', phase: 'pending', category: 'Food', exclusionRequested: false, wakingUp: false,
      memory: { phase: 'none' }, pendingSince: T0, submittedAt: T0,
    });

    state = run([submit('b', T0 + 1), submit('c', T0 + 2)], state);
    expect(state.entries.map((entry) => entry.cid)).toEqual(['a', 'b', 'c']);
  });

  it('ignores a repeated cid and returns the same state for no-ops', () => {
    const state = run([submit('a')]);
    expect(quickAddReducer(state, submit('a', T0 + 5))).toBe(state);
    expect(quickAddReducer(state, { type: 'line/set', line: '' })).toBe(state);
    expect(quickAddReducer(state, { type: 'dialog/set', open: false })).toBe(state);
    expect(quickAddReducer(state, { type: 'entry/failed', cid: 'missing', error: { message: 'x' } })).toBe(state);
  });

  it('keeps the dialog flag and the draft apart from the entries', () => {
    const state = run([{ type: 'dialog/set', open: true }, { type: 'line/set', line: '120 tea' }, submit('a')]);
    expect(state.dialogOpen).toBe(true);
    expect(state.entries).toHaveLength(1);
  });

  it('disables submission exactly while five entries are pending and keeps the typed line', () => {
    let state = run(['a', 'b', 'c', 'd'].map((cid) => submit(cid)));
    expect(countPendingEntries(state)).toBe(MAX_PENDING_ENTRIES - 1);
    expect(isSubmissionBlocked(state)).toBe(false);
    expect(submissionBlockedReason(state)).toBeNull();

    state = run([submit('e')], state);
    expect(isSubmissionBlocked(state)).toBe(true);
    expect(submissionBlockedReason(state)).toBe(SUBMISSION_BLOCKED_TEXT);

    const typed = quickAddReducer(state, { type: 'line/set', line: '99 chai' });
    const rejected = quickAddReducer(typed, submit('f'));
    expect(rejected).toBe(typed);
    expect(rejected.line).toBe('99 chai');
    expect(rejected.entries).toHaveLength(5);

    // One entry leaving pending, by success or by failure, reopens submission.
    const afterConfirm = quickAddReducer(typed, confirm('a'));
    expect(isSubmissionBlocked(afterConfirm)).toBe(false);
    expect(quickAddReducer(afterConfirm, submit('f')).entries).toHaveLength(6);
    const afterFail = quickAddReducer(typed, { type: 'entry/failed', cid: 'b', error: { message: 'offline' } });
    expect(isSubmissionBlocked(afterFail)).toBe(false);
  });

  it('counts only pending entries toward the limit, not failed or saved ones', () => {
    let state = run(['a', 'b', 'c'].map((cid) => submit(cid)));
    state = run([
      confirm('a'),
      { type: 'entry/failed', cid: 'b', error: { message: 'offline' } },
    ], state);
    state = run(['d', 'e', 'f', 'g'].map((cid) => submit(cid)), state);
    expect(countPendingEntries(state)).toBe(5);
    expect(countFailedEntries(state)).toBe(1);
    expect(state.entries).toHaveLength(7);
  });

  it('isolates a failure to its own entry', () => {
    const before = run([submit('a'), submit('b'), confirm('a')]);
    const after = quickAddReducer(before, {
      type: 'entry/failed', cid: 'b', error: { message: 'Offline', code: 'NETWORK', retryable: true },
    });
    expect(phases(after)).toEqual(['a:saved', 'b:failed']);
    expect(after.entries[0]).toBe(before.entries[0]);
    expect(after.entries[1]?.error).toEqual({ message: 'Offline', code: 'NETWORK', retryable: true });
    // A failure never touches a saved entry.
    expect(quickAddReducer(after, { type: 'entry/failed', cid: 'a', error: { message: 'late' } })).toBe(after);
  });

  it('retries a failed entry back to pending, restarts its clock, and refuses a retry at the limit', () => {
    let state = run([submit('a'), { type: 'entry/waking', cid: 'a', at: T0 + WAKING_UP_AFTER_MS }]);
    expect(state.entries[0]?.wakingUp).toBe(true);
    state = run([{ type: 'entry/failed', cid: 'a', error: { message: 'timeout' } }], state);
    expect(state.entries[0]).toMatchObject({ phase: 'failed', wakingUp: false });

    const full = run(['b', 'c', 'd', 'e', 'f'].map((cid) => submit(cid, T0 + 10)), state);
    expect(isSubmissionBlocked(full)).toBe(true);
    expect(quickAddReducer(full, { type: 'entry/retry', cid: 'a', at: T0 + 20 })).toBe(full);

    const retried = quickAddReducer(state, { type: 'entry/retry', cid: 'a', at: T0 + 9000 });
    expect(retried.entries[0]).toMatchObject({ phase: 'pending', pendingSince: T0 + 9000, wakingUp: false });
    expect(retried.entries[0]?.error).toBeUndefined();
    // Only a failed entry can be retried.
    expect(quickAddReducer(retried, { type: 'entry/retry', cid: 'a', at: T0 + 9001 })).toBe(retried);
  });

  it('sets the waking-up flag only after 5 seconds of pending', () => {
    const state = run([submit('a')]);
    expect(quickAddReducer(state, { type: 'entry/waking', cid: 'a', at: T0 + WAKING_UP_AFTER_MS - 1 })).toBe(state);
    const waking = quickAddReducer(state, { type: 'entry/waking', cid: 'a', at: T0 + WAKING_UP_AFTER_MS });
    expect(waking.entries[0]?.wakingUp).toBe(true);
    const saved = quickAddReducer(waking, confirm('a', T0 + 6000));
    expect(saved.entries[0]?.wakingUp).toBe(false);
    expect(quickAddReducer(saved, { type: 'entry/waking', cid: 'a', at: T0 + 20_000 })).toBe(saved);
  });

  it('confirms a pending entry once, with an 8-second Undo deadline and a queued announcement', () => {
    const state = run([submit('a'), submit('b')]);
    const confirmed = quickAddReducer(state, confirm('a', T0 + 700, {
      expenseId: 98,
      recordVersion: 3,
      excluded: true,
      category: 'Wants',
      answer: answerAt(5),
      announcement: { text: 'Saved ₹450 Food. ₹550 left today.' },
    }));
    expect(confirmed.entries[0]).toMatchObject({
      phase: 'saved', expenseId: 98, recordVersion: 3, excluded: true, category: 'Wants', confirmedAt: T0 + 700,
      undo: { deadline: T0 + 700 + UNDO_WINDOW_MS },
    });
    expect(confirmed.entries[1]).toBe(state.entries[1]);
    expect(confirmed.announcements).toHaveLength(1);
    expect(confirmed.announcements[0]).toMatchObject({ text: 'Saved ₹450 Food. ₹550 left today.', assertive: false });
    expect(UNDO_WINDOW_MS).toBe(8000);

    // A second confirmation of the same entry changes nothing.
    expect(quickAddReducer(confirmed, confirm('a', T0 + 900, { expenseId: 99 }))).toBe(confirmed);
  });

  it('discards a failed row, leaves other rows alone, and refuses to discard a pending or saved row', () => {
    const state = run([
      submit('a'), submit('b'), submit('c'),
      confirm('a'),
      { type: 'entry/failed', cid: 'b', error: { message: 'x' } },
    ]);
    expect(quickAddReducer(state, { type: 'entry/discard', cid: 'c' })).toBe(state);
    expect(quickAddReducer(state, { type: 'entry/discard', cid: 'a' })).toBe(state);
    const discarded = quickAddReducer(state, { type: 'entry/discard', cid: 'b' });
    expect(phases(discarded)).toEqual(['a:saved', 'c:pending']);
    expect(discarded.entries[0]).toBe(state.entries[0]);
  });

  it('moves a failed entry to the input on Edit only when the input is empty', () => {
    const failed = run([submit('a'), { type: 'entry/failed', cid: 'a', error: { message: 'x' } }]);
    const typed = quickAddReducer(failed, { type: 'line/set', line: 'chai 20' });
    expect(quickAddReducer(typed, { type: 'entry/edit', cid: 'a', line: '450 swiggy' })).toBe(typed);

    const edited = quickAddReducer(failed, { type: 'entry/edit', cid: 'a', line: '450 swiggy' });
    expect(edited.line).toBe('450 swiggy');
    expect(edited.entries).toHaveLength(0);
  });

  it('replaces an answer only with a higher data version, for a save, a change, and an undo', () => {
    let state = run([submit('a'), confirm('a', T0, { answer: answerAt(5) })]);
    expect(state.entries[0]?.answer?.dataVersion).toBe(5);

    const older = quickAddReducer(state, { type: 'entry/updated', cid: 'a', category: 'Wants', answer: answerAt(4) });
    expect(older.entries[0]?.answer).toBe(state.entries[0]?.answer);
    expect(older.entries[0]?.category).toBe('Wants');

    const equal = quickAddReducer(state, { type: 'entry/updated', cid: 'a', answer: answerAt(5) });
    expect(equal.entries[0]?.answer).toBe(state.entries[0]?.answer);

    const newer = answerAt(7);
    state = quickAddReducer(state, { type: 'entry/updated', cid: 'a', category: 'Fun', recordVersion: 2, answer: newer });
    expect(state.entries[0]).toMatchObject({ category: 'Fun', recordVersion: 2, phase: 'saved' });
    expect(state.entries[0]?.answer).toBe(newer);

    state = run([{ type: 'entry/undoStart', cid: 'a' }, { type: 'entry/undone', cid: 'a', answer: answerAt(6) }], state);
    expect(state.entries[0]).toMatchObject({ phase: 'undone' });
    expect(state.entries[0]?.answer).toBe(newer);
  });

  it('shows the answer of the newest snapshot even when responses arrive out of order', () => {
    let state = run([submit('a'), submit('b'), submit('c')]);
    const versions: Record<string, number> = { a: 10, b: 12, c: 11 };
    // Arrival order b, c, a: the answers hold versions 12, 11, 10.
    for (const cid of ['b', 'c', 'a']) {
      state = quickAddReducer(state, confirm(cid, T0 + 100, { answer: answerAt(versions[cid] as number) }));
    }
    expect(selectCurrentAnswer(state)?.dataVersion).toBe(12);
    expect(selectCurrentAnswer(state)).toBe(selectEntry(state, 'b')?.answer);
    // The earlier rows keep their own answers for their one-line status.
    expect(selectEntry(state, 'a')?.answer?.dataVersion).toBe(10);
  });

  it('shows the most recently confirmed entry as the current answer when responses arrive in order', () => {
    let state = run([submit('a'), submit('b')]);
    state = run([confirm('a', T0, { answer: answerAt(5) }), confirm('b', T0 + 1, { answer: answerAt(6) })], state);
    expect(selectCurrentAnswer(state)).toBe(selectEntry(state, 'b')?.answer);

    // A later correction of the first entry makes its answer the newest.
    state = quickAddReducer(state, { type: 'entry/updated', cid: 'a', answer: answerAt(8) });
    expect(selectCurrentAnswer(state)).toBe(selectEntry(state, 'a')?.answer);

    // Equal versions: the later accepted answer wins.
    const tied = run([submit('x'), submit('y'), confirm('x', T0, { answer: answerAt(3) }), confirm('y', T0, { answer: answerAt(3) })]);
    expect(selectCurrentAnswer(tied)).toBe(selectEntry(tied, 'y')?.answer);
    expect(selectCurrentAnswer(initialQuickAddState)).toBeUndefined();
  });

  it('walks the undo path: removing, failure, same-entry retry, and undone', () => {
    const saved = run([submit('a'), confirm('a', T0, { answer: answerAt(5) })]);
    const removing = quickAddReducer(saved, { type: 'entry/undoStart', cid: 'a' });
    expect(removing.entries[0]).toMatchObject({ phase: 'removing' });
    expect(isUndoAvailable(removing.entries[0]!)).toBe(true);
    expect(quickAddReducer(removing, { type: 'entry/undoStart', cid: 'a' })).toBe(removing);

    const failed = quickAddReducer(removing, { type: 'entry/undoFailed', cid: 'a', error: { message: 'offline' } });
    expect(failed.entries[0]).toMatchObject({ phase: 'undo_failed', error: { message: 'offline' } });
    expect(isUndoAvailable(failed.entries[0]!)).toBe(true);

    const again = quickAddReducer(failed, { type: 'entry/undoStart', cid: 'a' });
    expect(again.entries[0]).toMatchObject({ phase: 'removing' });
    expect(again.entries[0]?.error).toBeUndefined();

    const undone = quickAddReducer(again, { type: 'entry/undone', cid: 'a', answer: answerAt(6), announcement: { text: 'Entry removed.' } });
    expect(undone.entries[0]).toMatchObject({ phase: 'undone' });
    expect(undone.entries[0]?.undo).toBeUndefined();
    expect(undone.entries[0]?.answer?.dataVersion).toBe(6);
    expect(isUndoAvailable(undone.entries[0]!)).toBe(false);
    expect(undone.announcements.map((item) => item.text)).toEqual(['Entry removed.']);
  });

  it('records an already-removed entry after a 404 and lets the row be dismissed', () => {
    const state = run([
      submit('a'), confirm('a'),
      { type: 'entry/undoStart', cid: 'a' },
      { type: 'entry/undone', cid: 'a', alreadyRemoved: true, answer: answerAt(9) },
    ]);
    expect(state.entries[0]).toMatchObject({ phase: 'undone', alreadyRemoved: true });
    expect(quickAddReducer(state, { type: 'entry/discard', cid: 'a' }).entries).toHaveLength(0);
  });

  it('does not offer Undo for an entry whose window ended, and ignores a category change on other phases', () => {
    const expired = run([submit('a'), confirm('a', T0), { type: 'undo/expire', cid: 'a', at: T0 + UNDO_WINDOW_MS }]);
    expect(expired.entries[0]).toMatchObject({ phase: 'saved' });
    expect(expired.entries[0]?.undo).toBeUndefined();
    expect(isUndoAvailable(expired.entries[0]!)).toBe(false);
    expect(quickAddReducer(expired, { type: 'entry/undoStart', cid: 'a' })).toBe(expired);

    const pending = run([submit('p')]);
    expect(quickAddReducer(pending, { type: 'entry/updated', cid: 'p', category: 'Fun' })).toBe(pending);
  });

  it('keeps the per-entry memory status separate from the entry phase', () => {
    let state = run([submit('a'), submit('b'), confirm('a')]);
    state = run([
      { type: 'entry/memory', cid: 'a', memory: { phase: 'saving', noteKey: 'swiggy', previous: null } },
      { type: 'entry/memory', cid: 'a', memory: { phase: 'saved', written: { id: 4, revision: 2 } } },
    ], state);
    expect(state.entries[0]?.memory).toEqual({
      phase: 'saved', noteKey: 'swiggy', previous: null, written: { id: 4, revision: 2 },
    });
    expect(state.entries[0]?.phase).toBe('saved');
    expect(state.entries[1]?.memory).toEqual({ phase: 'none' });
    state = quickAddReducer(state, { type: 'entry/memory', cid: 'a', memory: { phase: 'failed' } });
    expect(state.entries[0]?.phase).toBe('saved');
  });

  it('queues announcements with unique keys, caps the queue, and consumes one by key', () => {
    let state = initialQuickAddState;
    for (let index = 0; index < MAX_ANNOUNCEMENTS + 3; index += 1) {
      state = quickAddReducer(state, {
        type: 'announcement/push', announcement: { text: `message ${index}`, assertive: index === 0 },
      });
    }
    expect(state.announcements).toHaveLength(MAX_ANNOUNCEMENTS);
    expect(new Set(state.announcements.map((item) => item.key)).size).toBe(MAX_ANNOUNCEMENTS);
    expect(state.announcements[0]?.text).toBe('message 3');

    const first = state.announcements[0]!;
    const consumed = quickAddReducer(state, { type: 'announcement/consume', key: first.key });
    expect(consumed.announcements).toHaveLength(MAX_ANNOUNCEMENTS - 1);
    expect(quickAddReducer(consumed, { type: 'announcement/consume', key: first.key })).toBe(consumed);
    expect(quickAddReducer(state, { type: 'announcement/push', announcement: { text: '' } })).toBe(state);
  });

  it('resets to the initial state', () => {
    const state = run([{ type: 'line/set', line: 'x' }, submit('a'), { type: 'dialog/set', open: true }, confirm('a', T0, { announcement: { text: 'hi' } })]);
    expect(quickAddReducer(state, { type: 'reset' })).toBe(initialQuickAddState);
  });
});

describe('quick add reducer: Undo pause', () => {
  const saved = () => run([submit('a'), confirm('a', T0)]);

  it('pauses while hovered or focused and extends the deadline by the paused time', () => {
    const paused = quickAddReducer(saved(), { type: 'undo/pause', cid: 'a', source: 'pointer', at: T0 + 3000 });
    expect(paused.entries[0]?.undo).toMatchObject({ pausedRemainingMs: 5000 });
    expect(undoRemainingMs(paused.entries[0]!, T0 + 60_000)).toBe(5000);

    const resumed = quickAddReducer(paused, { type: 'undo/resume', cid: 'a', source: 'pointer', at: T0 + 13_000 });
    // confirmation + 8 s + the 10 s that were paused.
    expect(resumed.entries[0]?.undo).toEqual({ deadline: T0 + 18_000 });
    expect(undoRemainingMs(resumed.entries[0]!, T0 + 13_000)).toBe(5000);
  });

  it('stays paused until both the pointer and focus have left', () => {
    let state = run([
      { type: 'undo/pause', cid: 'a', source: 'pointer', at: T0 + 1000 },
      { type: 'undo/pause', cid: 'a', source: 'focus', at: T0 + 2000 },
    ], saved());
    expect(state.entries[0]?.undo?.pausedRemainingMs).toBe(7000);
    state = quickAddReducer(state, { type: 'undo/resume', cid: 'a', source: 'pointer', at: T0 + 3000 });
    expect(state.entries[0]?.undo?.pausedRemainingMs).toBe(7000);
    state = quickAddReducer(state, { type: 'undo/resume', cid: 'a', source: 'focus', at: T0 + 4000 });
    expect(state.entries[0]?.undo).toEqual({ deadline: T0 + 11_000 });
  });

  it('ignores a repeated pause, a resume that never paused, and an expiry during a pause', () => {
    const paused = quickAddReducer(saved(), { type: 'undo/pause', cid: 'a', source: 'focus', at: T0 + 100 });
    expect(quickAddReducer(paused, { type: 'undo/pause', cid: 'a', source: 'focus', at: T0 + 200 })).toBe(paused);
    expect(quickAddReducer(paused, { type: 'undo/resume', cid: 'a', source: 'pointer', at: T0 + 200 })).toBe(paused);
    expect(quickAddReducer(paused, { type: 'undo/expire', cid: 'a', at: T0 + 99_000 })).toBe(paused);
    const never = saved();
    expect(quickAddReducer(never, { type: 'undo/resume', cid: 'a', source: 'focus', at: T0 + 100 })).toBe(never);
  });

  it('does not pause a window that already ended, and does not expire early', () => {
    const late = quickAddReducer(saved(), { type: 'undo/pause', cid: 'a', source: 'focus', at: T0 + UNDO_WINDOW_MS });
    expect(late.entries[0]?.undo).toBeUndefined();
    const early = saved();
    expect(quickAddReducer(early, { type: 'undo/expire', cid: 'a', at: T0 + UNDO_WINDOW_MS - 1 })).toBe(early);
  });

  it('never expires an undo that is pending or has failed', () => {
    const removing = quickAddReducer(saved(), { type: 'entry/undoStart', cid: 'a' });
    expect(quickAddReducer(removing, { type: 'undo/expire', cid: 'a', at: T0 + 99_000 })).toBe(removing);
    const failed = quickAddReducer(removing, { type: 'entry/undoFailed', cid: 'a', error: { message: 'x' } });
    expect(quickAddReducer(failed, { type: 'undo/expire', cid: 'a', at: T0 + 99_000 })).toBe(failed);
    expect(isUndoAvailable(failed.entries[0]!)).toBe(true);
  });
});

describe('quick add store with a fake clock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const entryOf = (store: ReturnType<typeof createQuickAddStore>, cid: string) => selectEntry(store.getState(), cid);

  it('stamps actions from the injected clock', () => {
    let clock = 5_000;
    const store = createQuickAddStore({ now: () => clock });
    store.dispatch({ type: 'entry/submit', entry: newEntry('a') });
    clock = 5_300;
    store.dispatch({ type: 'entry/confirmed', cid: 'a', expenseId: 7 });
    expect(entryOf(store, 'a')).toMatchObject({ submittedAt: 5_000, confirmedAt: 5_300, undo: { deadline: 5_300 + UNDO_WINDOW_MS } });
  });

  it('flags a pending entry as waking up after 5 seconds without resending anything', () => {
    const store = createQuickAddStore();
    store.dispatch({ type: 'entry/submit', entry: newEntry('a') });
    vi.advanceTimersByTime(WAKING_UP_AFTER_MS - 1);
    expect(entryOf(store, 'a')?.wakingUp).toBe(false);
    vi.advanceTimersByTime(1);
    expect(entryOf(store, 'a')).toMatchObject({ phase: 'pending', wakingUp: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels the waking-up check when the entry settles and restarts it on retry', () => {
    const store = createQuickAddStore();
    store.dispatch({ type: 'entry/submit', entry: newEntry('a') });
    store.dispatch({ type: 'entry/submit', entry: newEntry('b') });
    vi.advanceTimersByTime(2000);
    store.dispatch({ type: 'entry/failed', cid: 'a', error: { message: 'x' } });
    store.dispatch({ type: 'entry/confirmed', cid: 'b', expenseId: 2 });
    vi.advanceTimersByTime(10_000);
    expect(entryOf(store, 'a')?.wakingUp).toBe(false);
    expect(entryOf(store, 'b')?.wakingUp).toBe(false);

    store.dispatch({ type: 'entry/retry', cid: 'a' });
    vi.advanceTimersByTime(WAKING_UP_AFTER_MS - 1);
    expect(entryOf(store, 'a')?.wakingUp).toBe(false);
    vi.advanceTimersByTime(1);
    expect(entryOf(store, 'a')?.wakingUp).toBe(true);
  });

  it('ends the Undo window 8 seconds after confirmation', () => {
    const store = createQuickAddStore();
    store.dispatch({ type: 'entry/submit', entry: newEntry('a') });
    vi.advanceTimersByTime(1500);
    store.dispatch({ type: 'entry/confirmed', cid: 'a', expenseId: 7 });
    vi.advanceTimersByTime(UNDO_WINDOW_MS - 1);
    expect(isUndoAvailable(entryOf(store, 'a')!)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(isUndoAvailable(entryOf(store, 'a')!)).toBe(false);
    expect(entryOf(store, 'a')).toMatchObject({ phase: 'saved', expenseId: 7 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('holds the window while hovered or focused and resumes with the time that was left', () => {
    const store = createQuickAddStore();
    store.dispatch({ type: 'entry/submit', entry: newEntry('a') });
    store.dispatch({ type: 'entry/confirmed', cid: 'a', expenseId: 7 });
    vi.advanceTimersByTime(3000);

    store.dispatch({ type: 'undo/pause', cid: 'a', source: 'pointer' });
    store.dispatch({ type: 'undo/pause', cid: 'a', source: 'focus' });
    vi.advanceTimersByTime(60_000);
    expect(isUndoAvailable(entryOf(store, 'a')!)).toBe(true);
    expect(undoRemainingMs(entryOf(store, 'a')!, Date.now())).toBe(5000);
    expect(vi.getTimerCount()).toBe(0);

    store.dispatch({ type: 'undo/resume', cid: 'a', source: 'pointer' });
    vi.advanceTimersByTime(60_000);
    expect(isUndoAvailable(entryOf(store, 'a')!)).toBe(true);

    store.dispatch({ type: 'undo/resume', cid: 'a', source: 'focus' });
    vi.advanceTimersByTime(4999);
    expect(isUndoAvailable(entryOf(store, 'a')!)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(isUndoAvailable(entryOf(store, 'a')!)).toBe(false);
  });

  it('does not expire while an undo is pending or has failed, and keeps Undo available', () => {
    const store = createQuickAddStore();
    store.dispatch({ type: 'entry/submit', entry: newEntry('a') });
    store.dispatch({ type: 'entry/confirmed', cid: 'a', expenseId: 7 });
    vi.advanceTimersByTime(7000);
    store.dispatch({ type: 'entry/undoStart', cid: 'a' });
    vi.advanceTimersByTime(30_000);
    expect(entryOf(store, 'a')?.phase).toBe('removing');
    store.dispatch({ type: 'entry/undoFailed', cid: 'a', error: { message: 'offline' } });
    vi.advanceTimersByTime(30_000);
    expect(entryOf(store, 'a')?.phase).toBe('undo_failed');
    expect(isUndoAvailable(entryOf(store, 'a')!)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps each entry on its own deadline', () => {
    const store = createQuickAddStore();
    store.dispatch({ type: 'entry/submit', entry: newEntry('a') });
    store.dispatch({ type: 'entry/submit', entry: newEntry('b') });
    store.dispatch({ type: 'entry/confirmed', cid: 'a', expenseId: 1 });
    vi.advanceTimersByTime(5000);
    store.dispatch({ type: 'entry/confirmed', cid: 'b', expenseId: 2 });
    vi.advanceTimersByTime(3000);
    expect(isUndoAvailable(entryOf(store, 'a')!)).toBe(false);
    expect(isUndoAvailable(entryOf(store, 'b')!)).toBe(true);
    vi.advanceTimersByTime(5000);
    expect(isUndoAvailable(entryOf(store, 'b')!)).toBe(false);
  });

  it('notifies subscribers only on a change and stops after unsubscribe', () => {
    const store = createQuickAddStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.dispatch({ type: 'line/set', line: 'a' });
    store.dispatch({ type: 'line/set', line: 'a' });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    store.dispatch({ type: 'line/set', line: 'b' });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('discards every entry, draft, announcement, and timer on reset and bumps the generation', () => {
    const store = createQuickAddStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.dispatch({ type: 'line/set', line: '450 swiggy' });
    store.dispatch({ type: 'entry/submit', entry: newEntry('a') });
    store.dispatch({ type: 'entry/submit', entry: newEntry('b') });
    store.dispatch({ type: 'entry/confirmed', cid: 'b', expenseId: 2, announcement: { text: 'Saved.' } });
    expect(vi.getTimerCount()).toBe(2);
    const generation = store.getGeneration();

    store.reset();
    expect(store.getState()).toBe(initialQuickAddState);
    expect(store.getGeneration()).toBe(generation + 1);
    expect(vi.getTimerCount()).toBe(0);
    expect(listener).toHaveBeenCalled();

    // A response from the signed-out session finds no entry to change.
    const before = store.getState();
    store.dispatch({ type: 'entry/confirmed', cid: 'a', expenseId: 1 });
    expect(store.getState()).toBe(before);
  });

  it('stops its timers while disabled and starts them again from the entry state', () => {
    const store = createQuickAddStore();
    store.dispatch({ type: 'entry/submit', entry: newEntry('a') });
    store.dispatch({ type: 'entry/submit', entry: newEntry('b') });
    store.dispatch({ type: 'entry/confirmed', cid: 'b', expenseId: 2 });
    expect(vi.getTimerCount()).toBe(2);
    store.setTimersEnabled(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(9000);
    store.setTimersEnabled(true);
    // Both deadlines already passed, so each fires at once.
    vi.advanceTimersByTime(0);
    expect(entryOf(store, 'a')?.wakingUp).toBe(true);
    expect(isUndoAvailable(entryOf(store, 'b')!)).toBe(false);
  });
});

describe('quick add store privacy', () => {
  it('writes nothing to storage, cookies, the address, the console, or the network', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem');
    const cookieSet = vi.spyOn(document, 'cookie', 'set');
    const pushState = vi.spyOn(window.history, 'pushState');
    const replaceState = vi.spyOn(window.history, 'replaceState');
    const consoles = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => vi.spyOn(console, method));
    const url = window.location.href;

    const store = createQuickAddStore();
    store.dispatch({ type: 'line/set', line: '450 swiggy' });
    store.dispatch({ type: 'entry/submit', entry: newEntry('a') });
    store.dispatch({ type: 'entry/submit', entry: newEntry('b') });
    store.dispatch({ type: 'entry/confirmed', cid: 'a', expenseId: 1, announcement: { text: 'Saved.' } });
    store.dispatch({ type: 'entry/failed', cid: 'b', error: { message: 'offline' } });
    store.dispatch({ type: 'undo/pause', cid: 'a', source: 'pointer' });
    store.dispatch({ type: 'undo/resume', cid: 'a', source: 'pointer' });
    vi.advanceTimersByTime(60_000);
    store.reset();

    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    expect(cookieSet).not.toHaveBeenCalled();
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
    for (const spy of consoles) expect(spy).not.toHaveBeenCalled();
    expect(window.location.href).toBe(url);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });
});

describe('quick add reducer: equal-version answers (Requirement 9.15)', () => {
  const withStatus = (dataVersion: number, status: EntryAnswerModel['status']): EntryAnswerModel => ({ ...answerAt(dataVersion), status });
  const removedAt = (dataVersion: number): EntryAnswerModel => ({
    ...answerAt(dataVersion),
    status: 'available',
    mode: 'removed',
    titleKey: 'answer.removed',
  });

  it('accepts an answer by version: higher always, lower never, equal only as a recovery', () => {
    const available = (version: number) => withStatus(version, 'available');

    expect(shouldAcceptAnswer(undefined, withStatus(1, 'calculation_failed'))).toBe(true);
    expect(shouldAcceptAnswer(available(5), available(6))).toBe(true);
    expect(shouldAcceptAnswer(withStatus(5, 'calculation_failed'), withStatus(6, 'calculation_failed'))).toBe(true);
    // A strictly lower version never wins, not even as a recovery.
    expect(shouldAcceptAnswer(available(5), available(4))).toBe(false);
    expect(shouldAcceptAnswer(withStatus(5, 'calculation_failed'), available(4))).toBe(false);

    for (const held of ['calculation_failed', 'missing_input', 'invalid_input'] as const) {
      expect(shouldAcceptAnswer(withStatus(5, held), available(5))).toBe(true);
    }
    // Equal and not a recovery: no replacement, so a repeated read does not flicker.
    expect(shouldAcceptAnswer(available(5), available(5))).toBe(false);
    expect(shouldAcceptAnswer(available(5), withStatus(5, 'calculation_failed'))).toBe(false);
    expect(shouldAcceptAnswer(withStatus(5, 'calculation_failed'), withStatus(5, 'calculation_failed'))).toBe(false);
    expect(shouldAcceptAnswer(withStatus(5, 'calculation_failed'), withStatus(5, 'missing_input'))).toBe(false);
  });

  it('lets an available answer at the same version replace a failed one, once', () => {
    const failed = withStatus(5, 'calculation_failed');
    const base = run([submit('a'), confirm('a', T0, { answer: failed })]);
    expect(selectEntry(base, 'a')?.answer).toBe(failed);

    const recovered = withStatus(5, 'available');
    const after = quickAddReducer(base, { type: 'entry/updated', cid: 'a', answer: recovered });
    expect(selectEntry(after, 'a')?.answer).toBe(recovered);
    expect(selectEntry(after, 'a')?.answerSeq).toBeGreaterThan(selectEntry(base, 'a')?.answerSeq ?? 0);
    expect(selectEntry(after, 'a')).toMatchObject({ phase: 'saved' });

    // The same version again, even a different object, does not replace the available answer.
    const again = quickAddReducer(after, { type: 'entry/updated', cid: 'a', answer: withStatus(5, 'available') });
    expect(selectEntry(again, 'a')?.answer).toBe(recovered);
    expect(selectEntry(again, 'a')?.answerSeq).toBe(selectEntry(after, 'a')?.answerSeq);
    // A failed read at the same version does not bring the failure back.
    const failedAgain = quickAddReducer(after, { type: 'entry/updated', cid: 'a', answer: withStatus(5, 'calculation_failed') });
    expect(selectEntry(failedAgain, 'a')?.answer).toBe(recovered);
    // And a lower version never replaces it.
    const lower = quickAddReducer(after, { type: 'entry/updated', cid: 'a', answer: withStatus(4, 'available') });
    expect(selectEntry(lower, 'a')?.answer).toBe(recovered);
  });

  it('does not replace a failed answer with another failed answer, or with a lower version, at the same version', () => {
    const failed = withStatus(5, 'calculation_failed');
    const base = run([submit('a'), confirm('a', T0, { answer: failed })]);
    const sameFailure = quickAddReducer(base, { type: 'entry/updated', cid: 'a', answer: withStatus(5, 'calculation_failed') });
    expect(selectEntry(sameFailure, 'a')?.answer).toBe(failed);
    const lower = quickAddReducer(base, { type: 'entry/updated', cid: 'a', answer: withStatus(4, 'available') });
    expect(selectEntry(lower, 'a')?.answer).toBe(failed);
    // A higher version replaces it, failed or not.
    const higher = withStatus(6, 'calculation_failed');
    expect(selectEntry(quickAddReducer(base, { type: 'entry/updated', cid: 'a', answer: higher }), 'a')?.answer).toBe(higher);
  });

  it('makes the recovered answer the current answer when an equal version is held by a later entry', () => {
    let state = run([
      submit('a'), submit('b'),
      confirm('a', T0, { answer: withStatus(5, 'calculation_failed') }),
      confirm('b', T0 + 1, { answer: withStatus(5, 'available') }),
    ]);
    expect(selectCurrentAnswer(state)).toBe(selectEntry(state, 'b')?.answer);

    const recovered = withStatus(5, 'available');
    state = quickAddReducer(state, { type: 'entry/updated', cid: 'a', answer: recovered });
    expect(selectCurrentAnswer(state)).toBe(recovered);
  });

  it('refreshes a failed answer at the same version after an already-removed undo, and never from a lower one', () => {
    const failed = withStatus(5, 'calculation_failed');
    const saved = run([submit('a'), confirm('a', T0, { answer: failed }), { type: 'entry/undoStart', cid: 'a' }]);

    const lower = quickAddReducer(saved, { type: 'entry/undone', cid: 'a', alreadyRemoved: true, answer: removedAt(4) });
    expect(selectEntry(lower, 'a')).toMatchObject({ phase: 'undone', alreadyRemoved: true });
    expect(selectEntry(lower, 'a')?.answer).toBe(failed);

    const removed = removedAt(5);
    const equal = quickAddReducer(saved, { type: 'entry/undone', cid: 'a', alreadyRemoved: true, answer: removed });
    expect(selectEntry(equal, 'a')).toMatchObject({ phase: 'undone', alreadyRemoved: true });
    expect(selectEntry(equal, 'a')?.answer).toBe(removed);
    expect(selectEntry(equal, 'a')?.answer?.mode).toBe('removed');

    // With no answer from the re-read the held answer stays, and the row is still marked removed.
    const noRead = quickAddReducer(saved, { type: 'entry/undone', cid: 'a', alreadyRemoved: true });
    expect(selectEntry(noRead, 'a')).toMatchObject({ phase: 'undone', alreadyRemoved: true });
    expect(selectEntry(noRead, 'a')?.answer).toBe(failed);
  });

  it('keeps an available saved answer when an equal-version removed answer arrives', () => {
    const saved = withStatus(5, 'available');
    const state = run([submit('a'), confirm('a', T0, { answer: saved }), { type: 'entry/undoStart', cid: 'a' }]);
    const undone = quickAddReducer(state, { type: 'entry/undone', cid: 'a', answer: removedAt(5) });
    expect(selectEntry(undone, 'a')?.answer).toBe(saved);
  });
});

// The Entry_Status_Rows of Quick Add: one row for each entry of this session, with its own status text and its own
// controls. A row confines loading, failure, and retry text to itself (Requirements 13.4, 13.5), keeps the entry's
// values when a save fails (Requirement 7.7), and offers Retry (same key), Edit, and Discard (Requirement 7.8).
//
// All of it is plain text and native controls. Statuses use a glyph only as reinforcement beside the words. No row is a
// live region: confirmed saves, undos, and errors are announced once by the Announcer, and a pending state is never
// announced (Requirement 12.3).
//
// Everything renders only while Quick_Add_Enabled is on. The components read the shared draft (for the actions, the
// categories, and the data-use gate), so they must be inside QuickAddDraftProvider and QuickAddProvider.
//
// Requirements: 6.3, 6.8, 7.2, 7.6, 7.8, 7.10, 7.11, 7.13, 7.16, 8.1, 8.3, 8.8, 8.9, 8.12, 9.16, 13.4, 13.5, 12.4, 12.14.
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { DATA_NOTICE_REQUIRED_CODE } from '../../api';
import { useMutationRunner, useMutationStatus } from '../../clarity/MutationStatusProvider';
import { formatInr } from '../../clarity/quickAdd/amount';
import { useQuickAddEntries, useQuickAddSelector } from '../../clarity/quickAdd/QuickAddProvider';
import {
  WAKING_UP_TEXT,
  isUndoAvailable,
  selectCurrentAnswerEntry,
  type EntryPhase,
  type QuickAddEntry,
} from '../../clarity/quickAdd/quickAddStore';
import { summarizeAnswer } from './answerMessages';
import { CategoryChoice } from './CategoryChoice';
import { formatEntryDate } from './format';
import { currentQuickAddInput, focusQuickAddInput } from './inputFocus';
import { useRequiredQuickAddDraft, type QuickAddDraftValue } from './QuickAddDraft';
import { UndoControl, entryLabel } from './UndoControl';
import { useFocusKeeper } from './useFocusKeeper';
import './quickAdd.css';
import './quickAddEntries.css';

export const PENDING_TEXT = 'Saving…';
export const SAVED_TEXT = 'Saved';
export const FAILED_TEXT = 'Not saved';
export const REMOVING_TEXT = 'Removing…';
export const UNDONE_TEXT = 'Undone. The expense was removed.';
export const ALREADY_REMOVED_ROW_TEXT = 'This entry was already removed.';
export const UNDO_FAILED_STATUS_TEXT = 'Still saved. The undo did not finish.';
export const NOT_COUNTED_TEXT = "Not counted against today's allowance.";
export const NOTICE_REQUIRED_TEXT = 'Review the data-use notice, then choose Retry. Your entry is kept.';
export const EDIT_FIRST_TEXT = 'Your input already has text. Save or clear it, then choose Edit again.';
export const EDIT_HELP_TEXT = 'Choose Edit to correct it. Your entry is kept.';
export const CHANGE_BUSY_TEXT = 'Another change to this expense is still saving. Try again in a moment.';
export const MEMORY_FAILED_TEXT = 'Your category choice was not remembered. The expense is saved.';
export const MEMORY_SAVING_TEXT = 'Remembering your category choice…';
export const MEMORY_RESTORING_TEXT = 'Restoring your earlier category choice…';
export const MEMORY_RESTORE_FAILED_TEXT = 'Your earlier category choice could not be restored.';
export const ENTRIES_TITLE = 'Your entries';

const GLYPH: Readonly<Record<EntryPhase, string>> = Object.freeze({
  pending: '…',
  saved: '✓',
  failed: '✕',
  removing: '…',
  undone: '↶',
  undo_failed: '!',
});

const FOCUSABLE = 'button:not([aria-disabled="true"]), select, a[href]';

/** The control to focus after the row at `row` is removed: a neighbor's first control, or the input. */
function neighborTarget(row: HTMLElement | null): HTMLElement | null {
  const sibling = (row?.nextElementSibling ?? row?.previousElementSibling) as HTMLElement | null;
  if (!sibling) return null;
  return sibling.querySelector<HTMLElement>(FOCUSABLE) ?? sibling;
}

function RowButton({
  label,
  name,
  onClick,
  disabled = false,
  describedBy,
  ghost = true,
}: {
  label: string;
  name: string;
  onClick(): void;
  disabled?: boolean;
  describedBy?: string;
  ghost?: boolean;
}) {
  return (
    <button
      type="button"
      className={`btn sm${ghost ? ' ghost' : ''} qa-entry-button`}
      aria-label={name}
      aria-disabled={disabled || undefined}
      aria-describedby={describedBy}
      onClick={() => {
        if (!disabled) onClick();
      }}
    >
      {label}
    </button>
  );
}

export interface EntryStatusRowProps {
  entry: QuickAddEntry;
  /** This entry holds the current answer, which the list shows below the rows. Other saved rows get a one-line status. */
  isCurrentAnswer?: boolean;
}

/** One entry: pending, saved, failed, removing, undone, or undo failed. Renders nothing while the flag is off. */
export function EntryStatusRow(props: EntryStatusRowProps) {
  const draft = useRequiredQuickAddDraft();
  if (!draft) return null;
  return <Row {...props} draft={draft} />;
}

function Row({ entry, isCurrentAnswer = false, draft }: EntryStatusRowProps & { draft: QuickAddDraftValue }) {
  const { actions, categories, gated, gateReason, today } = draft;
  const { cid, phase } = entry;
  const baseId = useId();
  const summaryId = `${baseId}-summary`;
  const gateId = `${baseId}-gate`;
  const rowRef = useRef<HTMLLIElement>(null);
  const mounted = useRef(true);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const [note, setNote] = useState('');
  const runner = useMutationRunner();
  const updateScope = entry.expenseId !== undefined ? `expense:${entry.expenseId}` : '';
  const updateStatus = useMutationStatus(updateScope);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // A note belongs to the phase it was written in.
  useEffect(() => setNote(''), [phase]);

  const keeper = useFocusKeeper(rowRef, () => (
    phaseRef.current === 'pending' || phaseRef.current === 'removing'
      ? rowRef.current
      : (currentQuickAddInput() ?? rowRef.current)
  ));

  const label = entryLabel(entry);
  const retryable = entry.error?.retryable !== false;
  const noticeRequired = entry.error?.code === DATA_NOTICE_REQUIRED_CODE;

  function removeRow(run: () => { status: string }) {
    const target = neighborTarget(rowRef.current);
    const result = run();
    if (result.status === 'discarded') (target ?? currentQuickAddInput())?.focus({ preventScroll: true });
  }

  function retry() {
    setNote('');
    void actions.retry(cid).then((result) => {
      if (mounted.current && result.status === 'blocked') setNote(result.reason);
    }).catch(() => undefined);
  }

  function edit() {
    const result = actions.edit(cid);
    if (result.status === 'edited') focusQuickAddInput();
    else if (result.status === 'input_not_empty') setNote(EDIT_FIRST_TEXT);
  }

  function undo() {
    void actions.undo(cid).catch(() => undefined);
  }

  function changeCategory(category: string) {
    setNote('');
    void actions.changeCategory(cid, category).then((result) => {
      if (mounted.current && result.status === 'busy') setNote(CHANGE_BUSY_TEXT);
    }).catch(() => undefined);
  }

  let statusText: ReactNode = null;
  switch (phase) {
    case 'pending': statusText = PENDING_TEXT; break;
    case 'saved': statusText = SAVED_TEXT; break;
    case 'failed': statusText = FAILED_TEXT; break;
    case 'removing': statusText = REMOVING_TEXT; break;
    case 'undone': statusText = entry.alreadyRemoved ? ALREADY_REMOVED_ROW_TEXT : UNDONE_TEXT; break;
    case 'undo_failed': statusText = UNDO_FAILED_STATUS_TEXT; break;
  }

  const oneLine = phase === 'saved' && !isCurrentAnswer ? summarizeAnswer(entry.answer) : null;
  const memory = entry.memory.phase;
  const updating = phase === 'saved' && updateStatus?.phase === 'pending';
  const updateFailed = phase === 'saved' && updateStatus?.phase === 'error' ? updateStatus : null;
  const canCountAgain = phase === 'saved' && entry.excluded === true && entry.parsed.spentOn === today;

  return (
    <li
      ref={rowRef}
      tabIndex={-1}
      aria-labelledby={summaryId}
      className="qa-entry"
      data-cid={cid}
      data-phase={phase}
      onFocus={keeper.onFocus}
      onBlur={keeper.onBlur}
    >
      <p id={summaryId} className="qa-entry-summary">
        <strong className="mono">{formatInr(entry.parsed.amountMinor)}</strong>
        <span aria-hidden="true"> · </span>
        <span> {entry.category}</span>
        <span aria-hidden="true"> · </span>
        <span> {formatEntryDate(entry.parsed.spentOn)}</span>
        <span aria-hidden="true"> · </span>
        <span className="qa-note-text"> {entry.parsed.note === '' ? 'No note' : entry.parsed.note}</span>
      </p>

      <p className="qa-entry-status">
        <span aria-hidden="true" className="clarity-glyph">{GLYPH[phase]}</span>
        <strong>{statusText}</strong>
        {phase === 'saved' && entry.excluded === true && <span> {NOT_COUNTED_TEXT}</span>}
        {oneLine && <span className="qa-entry-oneline"> {oneLine}</span>}
      </p>

      {phase === 'pending' && entry.wakingUp && <p className="qa-entry-detail small">{WAKING_UP_TEXT}</p>}

      {phase === 'failed' && (
        <div className="qa-entry-failure">
          <p className="qa-entry-detail">{noticeRequired ? NOTICE_REQUIRED_TEXT : entry.error?.message ?? ''}</p>
          {noticeRequired && gated && <p id={gateId} className="qa-entry-detail small">{gateReason}</p>}
          {!retryable && <p className="qa-entry-detail small">{EDIT_HELP_TEXT}</p>}
          <div className="qa-entry-actions">
            {retryable && (
              <RowButton
                label="Retry"
                name={`Retry saving ${label}`}
                disabled={gated}
                describedBy={gated ? gateId : undefined}
                ghost={false}
                onClick={retry}
              />
            )}
            <RowButton label="Edit" name={`Edit ${label}`} onClick={edit} />
            <RowButton label="Discard" name={`Discard ${label}`} onClick={() => removeRow(() => actions.discard(cid))} />
          </div>
          {gated && retryable && !noticeRequired && <p id={gateId} className="qa-entry-detail small">{gateReason}</p>}
        </div>
      )}

      {(isUndoAvailable(entry)) && (
        <UndoControl entry={entry} onUndo={phase === 'undo_failed' ? retry : undo} describedBy={summaryId} />
      )}

      {phase === 'saved' && (
        <div className="qa-entry-change">
          <CategoryChoice
            id={`${baseId}-category`}
            categories={categories}
            value={entry.category}
            label="Category"
            describedBy={summaryId}
            onChange={changeCategory}
          />
          {canCountAgain && (
            <RowButton
              label="Count against today"
              name={`Count ${label} against today`}
              onClick={() => { void actions.setExclusion(cid, false).catch(() => undefined); }}
            />
          )}
        </div>
      )}

      {updating && <p className="qa-entry-detail small">Updating this entry…</p>}
      {updateFailed && (
        <div className="qa-entry-failure">
          <p className="qa-entry-detail small">
            {updateFailed.label} failed: {updateFailed.error.message} The expense is unchanged.
          </p>
          <div className="qa-entry-actions">
            <RowButton label="Retry" name={`Retry ${updateFailed.label.toLowerCase()} for ${label}`} onClick={retry} />
            <RowButton label="Dismiss" name={`Dismiss failed change for ${label}`} onClick={() => runner.dismiss(updateScope)} />
          </div>
        </div>
      )}

      {memory === 'saving' && <p className="qa-entry-detail small">{MEMORY_SAVING_TEXT}</p>}
      {memory === 'restoring' && <p className="qa-entry-detail small">{MEMORY_RESTORING_TEXT}</p>}
      {(memory === 'failed' || memory === 'restore_failed') && (
        <div className="qa-entry-failure">
          <p className="qa-entry-detail small">{memory === 'failed' ? MEMORY_FAILED_TEXT : MEMORY_RESTORE_FAILED_TEXT}</p>
          <div className="qa-entry-actions">
            <RowButton label="Retry" name={`Retry remembering the category for ${label}`} onClick={retry} />
          </div>
        </div>
      )}

      {phase === 'undone' && (
        <div className="qa-entry-actions">
          <RowButton label="Dismiss" name={`Dismiss ${label}`} onClick={() => removeRow(() => actions.discard(cid))} />
        </div>
      )}

      {note && <p role="status" className="qa-entry-detail small">{note}</p>}
    </li>
  );
}

export interface QuickAddEntriesProps {
  headingLevel?: 2 | 3 | 4;
}

/**
 * The ordered status rows of the entries of this session, newest first, so the entry just submitted sits next to the
 * input. Each row shows its own status (Requirement 13.5). Renders nothing while there is no entry or while
 * Quick_Add_Enabled is off.
 */
export function QuickAddEntries(props: QuickAddEntriesProps) {
  const draft = useRequiredQuickAddDraft();
  if (!draft) return null;
  return <EntriesList {...props} />;
}

/** The name the design gives the same list. */
export const EntryStatusList = QuickAddEntries;

function EntriesList({ headingLevel = 3 }: QuickAddEntriesProps) {
  const titleId = useId();
  const entries = useQuickAddEntries();
  const current = useQuickAddSelector(selectCurrentAnswerEntry);
  const ordered = useMemo(() => [...entries].reverse(), [entries]);
  if (ordered.length === 0) return null;
  const Heading = `h${headingLevel}` as 'h2' | 'h3' | 'h4';
  return (
    <div className="qa-entries">
      <Heading id={titleId} className="qa-entries-title">{ENTRIES_TITLE}</Heading>
      <ul className="qa-entries-list" aria-labelledby={titleId}>
        {ordered.map((entry) => (
          <EntryStatusRow key={entry.cid} entry={entry} isCurrentAnswer={current?.cid === entry.cid} />
        ))}
      </ul>
    </div>
  );
}

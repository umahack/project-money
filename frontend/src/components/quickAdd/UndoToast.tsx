import { useRef, useSyncExternalStore } from 'react';
import { useQuickAddEntries } from '../../clarity/quickAdd/QuickAddProvider';
import { formatInr } from '../../clarity/quickAdd/amount';
import { isUndoAvailable, type QuickAddEntry } from '../../clarity/quickAdd/quickAddStore';
import type { QuickAddActions } from '../../clarity/quickAdd/useQuickAddActions';
import { hasQuickAddInput, subscribeQuickAddInputs } from './inputFocus';
import { useRequiredQuickAddDraft } from './QuickAddDraft';
import { UndoControl, entryLabel } from './UndoControl';
import { useFocusKeeper } from './useFocusKeeper';
import './quickAdd.css';
import './quickAddEntries.css';

export const UNDO_TOAST_LABEL = 'Undo a saved entry';

export interface UndoToastProps {
  /**
   * Whether a Quick Add surface (the inline panel or the dialog) is on screen. By default it is true while a Quick Add
   * input is mounted. While it is true the entry's own row carries the Undo control and no toast is shown.
   */
  surfaceMounted?: boolean;
}

/**
 * An Undo control in the toast area for an entry that is inside its Undo window (or whose undo is pending or has
 * failed), shown only when no Quick Add surface is mounted, for example after the dialog was closed on another page
 * (Requirement 8.1). The control is the same one the status row uses: it pauses the window while the pointer or
 * keyboard focus is on it, names the entry by amount and note, and offers the same-key retry when an undo fails.
 *
 * The toast area is not a live region. A confirmed save and a confirmed undo are announced once by the Announcer.
 * It renders nothing while Quick_Add_Enabled is off, and must be inside QuickAddDraftProvider.
 */
export function UndoToast(props: UndoToastProps) {
  const draft = useRequiredQuickAddDraft();
  if (!draft) return null;
  return <Stack {...props} actions={draft.actions} />;
}

function Stack({ surfaceMounted, actions }: UndoToastProps & { actions: QuickAddActions }) {
  const detected = useSyncExternalStore(subscribeQuickAddInputs, hasQuickAddInput, () => false);
  const surface = surfaceMounted ?? detected;
  const entries = useQuickAddEntries();
  const stackRef = useRef<HTMLDivElement>(null);
  // With no input to go back to, focus returns to the element it came from.
  const keeper = useFocusKeeper(stackRef, () => null);
  const toasts = surface ? [] : entries.filter(isUndoAvailable);

  return (
    <div
      ref={stackRef}
      className="qa-undo-toasts"
      data-testid="undo-toasts"
      onFocus={keeper.onFocus}
      onBlur={keeper.onBlur}
    >
      {toasts.map((entry) => (
        <Toast key={entry.cid} entry={entry} actions={actions} />
      ))}
    </div>
  );
}

function Toast({ entry, actions }: { entry: QuickAddEntry; actions: QuickAddActions }) {
  const { cid } = entry;
  return (
    <div className="qa-undo-toast" role="group" aria-label={`${UNDO_TOAST_LABEL}: ${entryLabel(entry)}`} data-cid={cid}>
      <p className="qa-undo-toast-text">
        <span aria-hidden="true" className="clarity-glyph">✓</span>
        {' '}Saved <strong className="mono">{formatInr(entry.parsed.amountMinor)}</strong> to {entry.category}
        {entry.parsed.note === '' ? '' : `: ${entry.parsed.note}`}.
      </p>
      <UndoControl
        entry={entry}
        onUndo={() => {
          void (entry.phase === 'undo_failed' ? actions.retry(cid) : actions.undo(cid)).catch(() => undefined);
        }}
      />
    </div>
  );
}

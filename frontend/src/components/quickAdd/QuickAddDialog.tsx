import { useEffect } from 'react';
import type { MemoryClient } from '../../clarity/quickAdd/memoryClient';
import { selectQuickAddEnabled } from '../../clarity/rollout';
import { Modal } from '../ui';
import { focusQuickAddInput } from './inputFocus';
import { DIALOG_MARKER, useCloseQuickAddDialog, useQuickAddDialogOpen } from './openQuickAdd';
import { QuickAddPanel } from './QuickAddPanel';
import './quickAddShell.css';

export const QUICK_ADD_DIALOG_TITLE = 'Quick Add';
export const QUICK_ADD_CLOSE_LABEL = 'Close';

/**
 * Quick Add in a dialog over the current page (Requirements 1.5, 1.10, 1.11, 1.17, 12.6). It is the shared `Modal`, so
 * Escape and a click on the backdrop close it, `aria-modal` is set, keyboard focus is contained, the page behind does
 * not scroll, and focus returns to the element that had it before the dialog opened. The panel inside it is the same
 * `QuickAddPanel` that Home uses, so the draft line and every entry row are the store's.
 *
 * The dialog stays open after a save, so the next entry can be typed at once. Closing it only hides it: an entry that
 * is still saving keeps saving in the store, and its row is there when the dialog opens again. The open state is the
 * store's `dialogOpen`, so the shortcut, the floating action, and the failed-entries status all open the same dialog.
 *
 * Renders nothing while Quick_Add_Enabled is off. Must be inside QuickAddProvider.
 */
export function QuickAddDialog({ memory }: { memory?: MemoryClient }) {
  if (!selectQuickAddEnabled()) return null;
  return <EnabledDialog memory={memory} />;
}

function EnabledDialog({ memory }: { memory?: MemoryClient }) {
  const open = useQuickAddDialogOpen();
  // A stable function: `Modal` restarts its focus handling, and so would lose the opener, when `onClose` changes.
  const close = useCloseQuickAddDialog();

  // This runs after the Modal's own effect, which moves focus to the dialog box, so the input ends up focused.
  useEffect(() => {
    if (open) focusQuickAddInput();
  }, [open]);

  return (
    <Modal open={open} onClose={close} title={QUICK_ADD_DIALOG_TITLE}>
      <div className="qa-dialog-body" {...{ [DIALOG_MARKER]: '' }}>
        <div className="qa-dialog-head">
          <h2 className="qa-dialog-title">{QUICK_ADD_DIALOG_TITLE}</h2>
          <button type="button" className="btn ghost sm qa-dialog-close" onClick={close}>{QUICK_ADD_CLOSE_LABEL}</button>
        </div>
        <QuickAddPanel variant="dialog" memory={memory} />
      </div>
    </Modal>
  );
}

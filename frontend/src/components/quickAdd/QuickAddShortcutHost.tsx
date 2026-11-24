import { useEffect, useRef } from 'react';
import { matchQuickAddShortcut } from '../../clarity/quickAdd/shortcut';
import { useDataUseGate } from '../../clarity/DataUseGateProvider';
import { selectQuickAddEnabled } from '../../clarity/rollout';
import { DATA_USE_NOTICE_REVIEW_ID } from '../clarity/DataUseGate';
import { DIALOG_MARKER, useOpenQuickAdd } from './openQuickAdd';
import { useQuickAddShortcut } from './shortcutInfo';

const MODAL_SELECTOR = '[role="dialog"][aria-modal="true"]';
const NOTICE_SELECTOR = `#${DATA_USE_NOTICE_REVIEW_ID}:not([hidden])`;

/** True while a modal dialog other than the Quick Add dialog is open. Its focus containment must not be broken. */
export function isOtherModalOpen(root: ParentNode = document): boolean {
  return Array.from(root.querySelectorAll(MODAL_SELECTOR)).some((dialog) => dialog.querySelector(`[${DIALOG_MARKER}]`) === null);
}

/**
 * True while the Data_Use_Gate shows the data-use notice: the card that asks for acknowledgement (`required`) always
 * shows it, and an acknowledged card shows it only after "Review the data-use notice" is opened.
 */
export function isDataUseNoticeOpen(status: string, root: ParentNode = document): boolean {
  return status === 'required' || root.querySelector(NOTICE_SELECTOR) !== null;
}

/**
 * Installs the one `keydown` listener of the Quick Add shortcut (Requirements 1.6, 1.7, 1.9, 1.15 to 1.18): Cmd K on
 * Apple platforms and Ctrl K elsewhere, at every width, from any page of the User view, also while another text field
 * has focus (its value is not touched, because the shortcut only moves focus or opens the dialog).
 *
 * The matcher already rejects the other platform's modifier, Shift, Alt, a key repeat, and an input method composition.
 * The host adds two checks: another modal dialog or the data-use notice on screen (the gate asking for acknowledgement,
 * or the notice opened for review) leaves the key alone, and so does an event that another handler already claimed.
 * Quick Add stays reachable through the floating action and the Home input while the notice is up (Requirement 1.13). `preventDefault` is called only when the press opens or focuses Quick Add, so
 * the browser keeps the key everywhere else. With the dialog open, the press moves focus to the input and neither
 * closes the dialog nor opens a second one.
 *
 * Mount it for the signed-in User view only. It installs no listener while Quick_Add_Enabled is off, and it renders
 * nothing. Must be inside QuickAddProvider.
 */
export function QuickAddShortcutHost() {
  if (!selectQuickAddEnabled()) return null;
  return <EnabledHost />;
}

function EnabledHost() {
  const { apple } = useQuickAddShortcut();
  const open = useOpenQuickAdd();
  const { status } = useDataUseGate();
  // The listener reads the latest status without being installed again each time it changes.
  const gateStatus = useRef(status);
  gateStatus.current = status;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      // keyCode 229 marks a key that belongs to an input method even when `isComposing` is not set yet.
      if (event.keyCode === 229) return;
      if (!matchQuickAddShortcut(event, apple)) return;
      if (isOtherModalOpen() || isDataUseNoticeOpen(gateStatus.current)) return;
      event.preventDefault();
      open();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [apple, open]);

  return null;
}

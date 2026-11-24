// One way to "open or focus Quick Add" for every opener: the floating action, the shortcut, and the failed-entries
// action. When a Quick Add input is already on screen (the inline input on Home, or the input of the open dialog) the
// opener moves focus to it. Otherwise it opens the dialog over the current page, without navigating (Requirements 1.4,
// 1.5, 1.9, 1.17).
import { useCallback } from 'react';
import { useQuickAddSelector, useQuickAddStore } from '../../clarity/quickAdd/QuickAddProvider';
import type { QuickAddState } from '../../clarity/quickAdd/quickAddStore';
import { currentQuickAddInput, focusQuickAddInput } from './inputFocus';

/** Marks the content of the Quick Add dialog, so the host can tell it from every other modal. */
export const DIALOG_MARKER = 'data-quick-add-dialog';
const DIALOG_SELECTOR = `[${DIALOG_MARKER}]`;

function selectDialogOpen(state: QuickAddState): boolean {
  return state.dialogOpen;
}

export function useQuickAddDialogOpen(): boolean {
  return useQuickAddSelector(selectDialogOpen);
}

/** A stable function. It returns true when it focused an input and false when it opened the dialog. */
export function useOpenQuickAdd(): () => boolean {
  const store = useQuickAddStore();
  return useCallback(() => {
    // The input of a dialog that is closing (its exit animation is still running) is not a surface to focus.
    const input = currentQuickAddInput();
    const leaving = input?.closest(DIALOG_SELECTOR) != null && !store.getState().dialogOpen;
    if (!leaving && focusQuickAddInput()) return true;
    store.dispatch({ type: 'dialog/set', open: true });
    return false;
  }, [store]);
}

/** A stable function that closes the dialog. The draft and every entry stay in the store. */
export function useCloseQuickAddDialog(): () => void {
  const store = useQuickAddStore();
  return useCallback(() => {
    store.dispatch({ type: 'dialog/set', open: false });
  }, [store]);
}

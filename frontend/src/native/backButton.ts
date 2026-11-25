/**
 * Back_Button_Policy and Overlay_Registry.
 *
 * Pure decision logic plus a tiny in-memory overlay stack. This module has no
 * Capacitor or React imports; the hook that wires it to the hardware back
 * button lives separately (task 4.2).
 */

export type BackAction = 'close-overlay' | 'consume' | 'navigate-back' | 'minimize';

export interface OverlayEntry {
  /** Stable id so re-registering (e.g. React effect re-run) replaces, not stacks, the same overlay. */
  id: string;
  /** False for a locked/undismissable overlay (e.g. a mutation in flight). */
  closable: boolean;
  onClose: () => void;
}

export interface BackDecisionInput {
  pathname: string;
  /** Agreement_Gate.mustAgree */
  mustAgree: boolean;
  hasInAppHistory: boolean;
  topOverlay: OverlayEntry | undefined;
}

const HOME_PATHS = new Set(['/', '/login']);

export function decideBackAction(input: BackDecisionInput): BackAction {
  const { pathname, mustAgree, hasInAppHistory } = input;
  const overlay = input.topOverlay;
  if (overlay) return overlay.closable ? 'close-overlay' : 'consume';
  if (pathname === '/agreement' && mustAgree) return 'minimize';
  if (HOME_PATHS.has(pathname)) return 'minimize';
  return hasInAppHistory ? 'navigate-back' : 'minimize';
}

// ---- Overlay registry -------------------------------------------------------

const overlayStack: OverlayEntry[] = [];

/**
 * Registers an open overlay on top of the stack. An entry with an id that is
 * already registered replaces the old entry in place instead of stacking.
 */
export function pushOverlay(entry: OverlayEntry): void {
  const existing = overlayStack.findIndex((e) => e.id === entry.id);
  if (existing >= 0) {
    overlayStack[existing] = entry;
    return;
  }
  overlayStack.push(entry);
}

/** Removes the overlay with the given id. Unknown ids are ignored. */
export function popOverlay(id: string): void {
  const index = overlayStack.findIndex((e) => e.id === id);
  if (index >= 0) overlayStack.splice(index, 1);
}

/** The most recently registered overlay, or undefined when none is open. */
export function topOverlay(): OverlayEntry | undefined {
  return overlayStack[overlayStack.length - 1];
}

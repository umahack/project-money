// Keeps keyboard focus from falling to the document body when the control the User was on disappears for a reason
// that is not a click on another control: an Undo that expires or is confirmed, a Retry that becomes a pending
// status, a Discard that removes a row. The container must stay mounted while its controls come and go.
//
// It remembers the control that holds focus inside the container and the element that held focus before it. After
// each render, if focus has fallen to the body and that control is gone, focus moves to the first target that exists:
// the one the caller names, then the element focus came from. Focus that the User moved to another control, or to an
// empty part of the page while the control was still there, is never taken back.
//
// Requirements: 8.7 (focus returns to the input after Undo), 12.4, 12.13 (focus stays on the active control).
import { useCallback, useLayoutEffect, useRef, type FocusEvent, type RefObject } from 'react';

export interface FocusKeeperHandlers {
  onFocus(event: FocusEvent<HTMLElement>): void;
  onBlur(event: FocusEvent<HTMLElement>): void;
}

interface Held {
  element: HTMLElement;
  from: HTMLElement | null;
}

export function useFocusKeeper(
  container: RefObject<HTMLElement | null>,
  /** The element that should take focus when the focused control is gone. Read when the loss is found. */
  fallback: () => HTMLElement | null,
): FocusKeeperHandlers {
  const held = useRef<Held | null>(null);
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;

  // After every render of the owner: a control that held focus and no longer exists means the focus was lost.
  useLayoutEffect(() => {
    const record = held.current;
    if (!record || record.element.isConnected) return;
    held.current = null;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const target = fallbackRef.current() ?? (record.from?.isConnected ? record.from : null);
    target?.focus({ preventScroll: true });
  });

  const onFocus = useCallback((event: FocusEvent<HTMLElement>) => {
    const element = event.target as HTMLElement;
    const related = event.relatedTarget as HTMLElement | null;
    const from = related && !container.current?.contains(related) ? related : (held.current?.from ?? null);
    held.current = { element, from };
  }, [container]);

  const onBlur = useCallback((event: FocusEvent<HTMLElement>) => {
    const next = event.relatedTarget as Node | null;
    if (next) {
      // Focus went to another element. Its own focus event records it when it is inside the container.
      held.current = null;
      return;
    }
    const blurred = event.target as HTMLElement;
    // A blur with no new target is either a removal or a click on an empty area. In the second case the control is
    // still there a moment later, and the User chose to leave it.
    globalThis.setTimeout(() => {
      if (held.current?.element === blurred && blurred.isConnected) held.current = null;
    }, 0);
  }, []);

  return { onFocus, onBlur };
}

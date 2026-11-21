import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

export interface FocusRescue {
  /**
   * Call from the click handler of a control that may disappear because of the
   * state change it causes (for example a Retry button that becomes a pending
   * status). If focus is lost to the document body afterwards, it moves to the
   * container instead of being dropped.
   */
  arm(): void;
}

/**
 * Keeps keyboard focus from falling to the document body when the control the
 * user just activated is removed. Focus the user placed elsewhere is never moved.
 */
export function useFocusRescue(container: RefObject<HTMLElement | null>): FocusRescue {
  const armed = useRef(false);

  useLayoutEffect(() => {
    if (!armed.current) return;
    const active = document.activeElement;
    if (!active || active === document.body) {
      container.current?.focus({ preventScroll: true });
    }
  });

  useEffect(() => {
    const disarm = () => {
      armed.current = false;
    };
    // Any later focus change means the user (or the rescue itself) settled focus.
    document.addEventListener('focusin', disarm);
    return () => document.removeEventListener('focusin', disarm);
  }, []);

  const arm = useCallback(() => {
    armed.current = true;
  }, []);
  return { arm };
}

// What the Quick Add openers need to know about the device: which shortcut to name (Cmd K or Ctrl K), and whether the
// bottom tab bar is displayed. Both are read from the browser at the moment they are needed and are never stored.
//
// Requirements: 1.7, 1.8, 1.14.
import { useState, useSyncExternalStore } from 'react';
import { isApplePlatform } from '../../clarity/quickAdd/shortcut';
import './quickAddShell.css';

/** The width from which the header navigation replaces the bottom tab bar. It is the same 900px as styles.css. */
export const TAB_BAR_BREAKPOINT_PX = 900;
const WIDE_QUERY = `(min-width: ${TAB_BAR_BREAKPOINT_PX}px)`;

export interface QuickAddShortcutInfo {
  apple: boolean;
  /** The visible text: `⌘ K` on Apple platforms, `Ctrl K` elsewhere. */
  label: string;
  /** The `aria-keyshortcuts` value of every control that opens or focuses Quick Add. */
  keyshortcuts: string;
}

export function describeQuickAddShortcut(apple: boolean): QuickAddShortcutInfo {
  return apple
    ? { apple, label: '⌘ K', keyshortcuts: 'Meta+K' }
    : { apple, label: 'Ctrl K', keyshortcuts: 'Control+K' };
}

/** The shortcut of this device. The platform does not change while a page is open, so it is read once. */
export function useQuickAddShortcut(): QuickAddShortcutInfo {
  const [info] = useState(() => describeQuickAddShortcut(isApplePlatform()));
  return info;
}

function subscribeWidth(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  if (typeof window.matchMedia === 'function') {
    const query = window.matchMedia(WIDE_QUERY);
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', onChange);
      return () => query.removeEventListener('change', onChange);
    }
    if (typeof query.addListener === 'function') {
      query.addListener(onChange);
      return () => query.removeListener(onChange);
    }
    return () => undefined;
  }
  window.addEventListener('resize', onChange);
  return () => window.removeEventListener('resize', onChange);
}

function tabBarShown(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof window.matchMedia === 'function') return !window.matchMedia(WIDE_QUERY).matches;
  return window.innerWidth < TAB_BAR_BREAKPOINT_PX;
}

/** True below 900 CSS pixels, where the bottom tab bar is displayed and the header navigation is not. */
export function useTabBarShown(): boolean {
  return useSyncExternalStore(subscribeWidth, tabBarShown, () => false);
}

/**
 * The shortcut written as visible text, for example "Shortcut: Ctrl K". It is shown only where the bottom tab bar is
 * not displayed, because a phone has no keyboard shortcut to teach (Requirement 1.8).
 */
export function ShortcutHint({ className = '' }: { className?: string }) {
  const shortcut = useQuickAddShortcut();
  const tabBar = useTabBarShown();
  if (tabBar) return null;
  return (
    <span className={`qa-shortcut-hint small ${className}`.trim()}>
      Shortcut: <kbd>{shortcut.label}</kbd>
    </span>
  );
}

import { useEffect, useRef } from 'react';
import { selectQuickAddEnabled } from '../../clarity/rollout';
import { useOpenQuickAdd } from './openQuickAdd';
import { useQuickAddShortcut, useTabBarShown } from './shortcutInfo';
import './quickAddShell.css';

export const FAB_LABEL = 'Quick add expense';
/** The smallest size the floating action has in CSS, which is what is published when the browser cannot measure it. */
export const FAB_MIN_SIZE_PX = 48;
export const FAB_HEIGHT_PROPERTY = '--quick-add-fab-h';

/**
 * The floating action (Requirements 1.2, 1.3, 1.4, 1.5, 1.14): a round button of at least 48 by 48 CSS pixels, fixed
 * above the bottom tab bar, the safe area, and the toast area, and shown only while the bottom tab bar is displayed
 * (below 900px). On Home it moves focus to the inline input. On another page it opens the dialog. It never navigates.
 *
 * While it is on screen it publishes its height as `--quick-add-fab-h`, so the toast stack and the page's bottom padding
 * stay above it. The property is removed when the button goes away.
 *
 * Renders nothing while Quick_Add_Enabled is off or at 900px and wider. Must be inside QuickAddProvider.
 */
export function QuickAddFab() {
  if (!selectQuickAddEnabled()) return null;
  return <EnabledFab />;
}

function EnabledFab() {
  const tabBar = useTabBarShown();
  const shortcut = useQuickAddShortcut();
  const open = useOpenQuickAdd();
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!tabBar || !element) return undefined;
    const root = document.documentElement;
    const publish = () => {
      const measured = Math.ceil(element.getBoundingClientRect().height);
      root.style.setProperty(FAB_HEIGHT_PROPERTY, `${Math.max(measured, FAB_MIN_SIZE_PX)}px`);
    };
    publish();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(publish);
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      root.style.removeProperty(FAB_HEIGHT_PROPERTY);
    };
  }, [tabBar]);

  if (!tabBar) return null;
  return (
    <button
      ref={ref}
      type="button"
      className="qa-fab"
      aria-label={FAB_LABEL}
      aria-keyshortcuts={shortcut.keyshortcuts}
      onClick={() => { open(); }}
    >
      <span className="qa-fab-plus" aria-hidden="true">+</span>
    </button>
  );
}

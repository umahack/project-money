import { useSyncExternalStore } from 'react';
import { useQuickAddSelector } from '../../clarity/quickAdd/QuickAddProvider';
import type { QuickAddState } from '../../clarity/quickAdd/quickAddStore';
import { selectQuickAddEnabled } from '../../clarity/rollout';
import { hasQuickAddInput, subscribeQuickAddInputs } from './inputFocus';
import { useOpenQuickAdd } from './openQuickAdd';
import { useQuickAddShortcut } from './shortcutInfo';
import './quickAddShell.css';

export const FAILED_STATUS_ACTION = 'Open Quick Add';

export function failedStatusText(count: number): string {
  return count === 1 ? '1 entry was not saved.' : `${count} entries were not saved.`;
}

function selectFailedCount(state: QuickAddState): number {
  let count = 0;
  for (const entry of state.entries) if (entry.phase === 'failed') count += 1;
  return count;
}

/**
 * The nonblocking status that says how many entries were not saved, with an action that opens Quick Add (Requirement
 * 1.12). It shows only while an entry has failed and no Quick Add surface (the inline input or the dialog) is open,
 * because an open surface already shows each failed row with Retry, Edit, and Discard. It sits in the page flow, never
 * over content, and it is plain text. The failure itself is announced once by the Announcer, so this is not a live region.
 *
 * Renders nothing while Quick_Add_Enabled is off. Must be inside QuickAddProvider.
 */
export function QuickAddFailedStatus() {
  if (!selectQuickAddEnabled()) return null;
  return <EnabledStatus />;
}

function EnabledStatus() {
  const count = useQuickAddSelector(selectFailedCount);
  const surface = useSyncExternalStore(subscribeQuickAddInputs, hasQuickAddInput, () => false);
  const shortcut = useQuickAddShortcut();
  const open = useOpenQuickAdd();
  if (count === 0 || surface) return null;
  return (
    <div className="qa-failed-status" role="group" aria-label="Entries not saved" data-testid="quick-add-failed-status">
      <p>{failedStatusText(count)}</p>
      <button
        type="button"
        className="btn sm"
        aria-keyshortcuts={shortcut.keyshortcuts}
        onClick={() => { open(); }}
      >
        {FAILED_STATUS_ACTION}
      </button>
    </div>
  );
}

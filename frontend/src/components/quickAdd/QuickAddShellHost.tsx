import type { MemoryClient } from '../../clarity/quickAdd/memoryClient';
import { useQuickAddEntries } from '../../clarity/quickAdd/QuickAddProvider';
import { selectQuickAddEnabled } from '../../clarity/rollout';
import { Announcer } from './Announcer';
import { QuickAddDialog } from './QuickAddDialog';
import { QuickAddDraftProvider } from './QuickAddDraft';
import { QuickAddFab } from './QuickAddFab';
import { QuickAddShortcutHost } from './QuickAddShortcutHost';
import { UndoToast } from './UndoToast';

/**
 * Everything Quick Add puts in the application shell for the signed-in User view: the one shortcut listener, the
 * floating action, the dialog, the one live-region announcer, and the Undo toast. Mount it for the User view only (never
 * on the administrator console). Renders nothing, installs no listener, and sends no request while Quick_Add_Enabled is
 * off. Must be inside the financial and mutation providers, QuickAddProvider, and the data-use gate provider.
 *
 * The Undo toast needs the shared actions, so it has its own draft provider. That provider is mounted only once the first
 * entry exists, so a page that never submitted an entry reads nothing for it.
 */
export function QuickAddShellHost({ memory }: { memory?: MemoryClient }) {
  if (!selectQuickAddEnabled()) return null;
  return (
    <>
      <QuickAddShortcutHost />
      <QuickAddFab />
      <QuickAddDialog memory={memory} />
      <Announcer />
      <ToastArea memory={memory} />
    </>
  );
}

function ToastArea({ memory }: { memory?: MemoryClient }) {
  const entries = useQuickAddEntries();
  if (entries.length === 0) return null;
  return (
    <QuickAddDraftProvider memory={memory}>
      <UndoToast />
    </QuickAddDraftProvider>
  );
}

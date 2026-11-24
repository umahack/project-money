import type { MemoryClient } from '../../clarity/quickAdd/memoryClient';
import { selectQuickAddEnabled } from '../../clarity/rollout';
import { ImmediateAnswer } from './ImmediateAnswer';
import { ParsedPreview } from './ParsedPreview';
import { QuickAddDraftProvider } from './QuickAddDraft';
import { QuickAddEntries } from './QuickAddEntries';
import { QuickAddInput } from './QuickAddInput';
import { ShortcutHint } from './shortcutInfo';
import './quickAddShell.css';

export interface QuickAddPanelProps {
  /** `inline` is the panel on Home. `dialog` is the same panel inside `QuickAddDialog`. */
  variant: 'inline' | 'dialog';
  /** The heading level of the entries list and the answer. The inline panel on Home sits below an h2 region. */
  headingLevel?: 2 | 3 | 4;
  /** The memory client. Defaults to the application client. Tests pass an isolated one. */
  memory?: MemoryClient;
}

/**
 * The one implementation of Quick Add: the input, the preview with its warning and category choice, the entry status
 * rows, and the immediate answer. It brings its own draft provider, so it can be placed on Home (`inline`) and in the
 * dialog (`dialog`) alike, and both show the same draft line from the store. The inline panel shows the shortcut as text
 * beside the input where the tab bar is not displayed. The dialog shows it in its footer (Requirement 1.8).
 *
 * Renders nothing while Quick_Add_Enabled is off. Must be inside QuickAddProvider.
 */
export function QuickAddPanel({ variant, headingLevel = 3, memory }: QuickAddPanelProps) {
  if (!selectQuickAddEnabled()) return null;
  return (
    <QuickAddDraftProvider memory={memory}>
      <div className={`qa-panel qa-panel-${variant}`} data-variant={variant}>
        <QuickAddInput shortcutHint={variant === 'inline'} />
        <ParsedPreview />
        <QuickAddEntries headingLevel={headingLevel} />
        <ImmediateAnswer headingLevel={headingLevel} />
        {variant === 'dialog' && (
          <p className="qa-dialog-foot"><ShortcutHint /></p>
        )}
      </div>
    </QuickAddDraftProvider>
  );
}

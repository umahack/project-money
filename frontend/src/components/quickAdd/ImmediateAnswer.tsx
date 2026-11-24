import { useQuickAddSelector } from '../../clarity/quickAdd/QuickAddProvider';
import { selectCurrentAnswerEntry } from '../../clarity/quickAdd/quickAddStore';
import type { QuickAddActions } from '../../clarity/quickAdd/useQuickAddActions';
import { EntryAnswer } from './EntryAnswer';
import { useRequiredQuickAddDraft } from './QuickAddDraft';

export interface ImmediateAnswerProps {
  headingLevel?: 2 | 3 | 4;
}

/**
 * The Entry_Answer of the most recently confirmed entry (Requirement 9.16), below the status rows. It follows the
 * store's current answer, so a newer confirmed snapshot from a later save, correction, or undo replaces it and an
 * older one never does (Requirement 9.15). Recalculate and "not counted against today" run through the shared actions
 * on the entry that holds the answer. Renders nothing before any entry is confirmed, and while Quick_Add_Enabled is off.
 */
export function ImmediateAnswer(props: ImmediateAnswerProps) {
  const draft = useRequiredQuickAddDraft();
  if (!draft) return null;
  return <Current actions={draft.actions} {...props} />;
}

function Current({ actions, headingLevel }: ImmediateAnswerProps & { actions: QuickAddActions }) {
  const entry = useQuickAddSelector(selectCurrentAnswerEntry);
  if (!entry?.answer) return null;
  const { cid } = entry;
  return (
    <EntryAnswer
      answer={entry.answer}
      headingLevel={headingLevel}
      onRecalculate={() => actions.recalculate(cid)}
      onExclude={() => actions.setExclusion(cid, true)}
    />
  );
}

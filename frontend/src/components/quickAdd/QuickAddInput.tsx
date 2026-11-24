import { useEffect, useRef, type ChangeEvent, type KeyboardEvent } from 'react';
import { MAX_LINE_LENGTH } from '../../clarity/quickAdd/parser';
import { registerQuickAddInput } from './inputFocus';
import { useRequiredQuickAddDraft } from './QuickAddDraft';
import { ShortcutHint, useQuickAddShortcut } from './shortcutInfo';
import './quickAdd.css';

/** The number of characters from which the visible limit hint appears. */
export const LIMIT_HINT_FROM = 160;

export const QUICK_ADD_LABEL = 'Add an expense';
export const QUICK_ADD_PLACEHOLDER = 'e.g. 120 coffee';
export const QUICK_ADD_HELP = 'Type an amount and a note, like 120 coffee. Add a day if it was not today, like swiggy 450 yesterday or rent 25,000 on 3rd. Press Enter to save.';

/** Keeps the line at the limit without cutting a character in half. */
function clampLine(value: string): string {
  if (value.length <= MAX_LINE_LENGTH) return value;
  const cut = value.slice(0, MAX_LINE_LENGTH);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * The single-line Quick Add input (Requirements 1.9, 3.12, 12.1, 13.1). It is bound to the draft line of the Quick Add
 * store, so the Home input and the dialog show the same text. Enter saves the entry as the preview shows it. An empty
 * line does nothing on Enter. While the Data_Use_Gate pauses inputs the input stays editable and saving is disabled
 * with the gate reason shown beside it (Requirement 1.13). The input never waits for the snapshot or the hints.
 *
 * It registers itself with `focusQuickAddInput`, so the floating action, the shortcut, and Undo can return focus to it.
 * Renders nothing while Quick_Add_Enabled is off.
 */
export function QuickAddInput({ shortcutHint = false }: { shortcutHint?: boolean } = {}) {
  const draft = useRequiredQuickAddDraft();
  const shortcut = useQuickAddShortcut();
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => registerQuickAddInput(ref.current), []);

  if (!draft) return null;
  const { ids, line, gated, gateReason, blockedReason, attemptCount, warning } = draft;
  const length = line.length;
  const showLimit = length >= LIMIT_HINT_FROM;
  const atLimit = length >= MAX_LINE_LENGTH;
  const showBlocked = blockedReason !== null && !gated;

  const describedBy = [
    ids.help,
    ids.preview,
    warning ? ids.warning : '',
    showLimit ? ids.limit : '',
    gated ? ids.paused : '',
    showBlocked ? ids.blocked : '',
  ].filter(Boolean).join(' ');

  function onChange(event: ChangeEvent<HTMLInputElement>) {
    draft?.setLine(clampLine(event.target.value));
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter') return;
    // Enter that confirms an input-method composition is not a save.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    // Requirement 18.6: with a warning shown, Enter is "Save and count today", which is the plain save.
    draft?.submit();
  }

  return (
    <div className="qa-input">
      <div className="qa-label-row">
        <label htmlFor={ids.input} className="qa-label">{QUICK_ADD_LABEL}</label>
        {/* Visible text, only where the bottom tab bar is not displayed (Requirement 1.8). */}
        {shortcutHint && <ShortcutHint />}
      </div>
      <div className="qa-input-row">
        <input
          ref={ref}
          id={ids.input}
          type="text"
          value={line}
          onChange={onChange}
          onKeyDown={onKeyDown}
          maxLength={MAX_LINE_LENGTH}
          placeholder={QUICK_ADD_PLACEHOLDER}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          enterKeyHint="done"
          aria-describedby={describedBy}
          aria-invalid={attemptCount > 0 || undefined}
          aria-keyshortcuts={shortcut.keyshortcuts}
        />
        <button
          type="button"
          className="btn primary"
          disabled={gated || showBlocked || line.trim() === ''}
          aria-describedby={gated ? ids.paused : showBlocked ? ids.blocked : undefined}
          onClick={() => draft.submit()}
        >
          Save
        </button>
      </div>
      <p id={ids.help} className="qa-help small">{QUICK_ADD_HELP}</p>
      {showLimit && (
        <p id={ids.limit} className="qa-limit small">
          {atLimit
            ? `Limit reached: ${length} of ${MAX_LINE_LENGTH} characters.`
            : `${length} of ${MAX_LINE_LENGTH} characters.`}
        </p>
      )}
      {gated && (
        <p id={ids.paused} className="qa-paused small">
          <strong>Saving is paused.</strong> {gateReason} You can keep typing.
        </p>
      )}
      {showBlocked && <p id={ids.blocked} className="qa-paused small">{blockedReason}</p>}
    </div>
  );
}

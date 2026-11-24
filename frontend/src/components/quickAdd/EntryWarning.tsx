import './quickAdd.css';

export const SAVE_AND_COUNT_LABEL = 'Save and count today';
export const SAVE_WITHOUT_COUNTING_LABEL = "Save, but don't count against today";
export const LARGE_WARNING_TEXT = "This amount is large compared with this month's spendable budget.";
export const BILL_PLAN_TEXT = 'Your Plan already includes this bill. Saving it here also counts it as spending this month.';
export const BOTH_WAYS_TEXT = "Either way, this month's totals include the expense. The choice only decides whether today's allowance counts it.";

export interface EntryWarningProps {
  /** The bill label and the large-amount cause, from `classifyEntryWarning`. */
  warning: { bill?: string; large: boolean };
  /** Id of the warning text, which the input names in `aria-describedby` (Requirement 12.15). */
  textId: string;
  /** True while saving is paused. The two buttons are then disabled. */
  disabled?: boolean;
  /** Id of the text that says why saving is paused. */
  disabledReasonId?: string;
  onSave(choice: { excludeFromToday: boolean }): void;
}

/**
 * The Entry_Warning: text that says why the entry looks like a bill or a large amount, and the two explicit save
 * choices (Requirements 18.1 to 18.5, 18.7). It never changes the amount, category, note, or date, never blocks a save,
 * and never moves focus. Meaning is in the words, not in color. Both buttons are at least 44 by 44 CSS pixels and sit
 * after the preview in reading order.
 */
export function EntryWarning({ warning, textId, disabled = false, disabledReasonId, onSave }: EntryWarningProps) {
  const { bill, large } = warning;
  const describedBy = disabled ? disabledReasonId : undefined;

  return (
    <div className="qa-warning">
      <p id={textId}>
        <span aria-hidden="true" className="clarity-glyph">!</span>
        <strong>Check before saving.</strong>
        {bill !== undefined && <> This looks like a bill: {bill}. {BILL_PLAN_TEXT}</>}
        {large && <> {LARGE_WARNING_TEXT}</>}
        {' '}{BOTH_WAYS_TEXT}
      </p>
      <div className="qa-warning-actions">
        <button
          type="button"
          className="btn primary"
          disabled={disabled}
          aria-describedby={describedBy}
          onClick={() => onSave({ excludeFromToday: false })}
        >
          {SAVE_AND_COUNT_LABEL}
        </button>
        <button
          type="button"
          className="btn"
          disabled={disabled}
          aria-describedby={describedBy}
          onClick={() => onSave({ excludeFromToday: true })}
        >
          {SAVE_WITHOUT_COUNTING_LABEL}
        </button>
      </div>
    </div>
  );
}

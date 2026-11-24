import type { CategorySuggestion } from '../../clarity/quickAdd/suggester';
import './quickAdd.css';

export const DEFAULT_LABEL = 'Default';
export const FORGET_LABEL = 'Forget this';

export interface CategoryChoiceProps {
  /** The id of the `<select>`. */
  id: string;
  /** Every category available to the User, built-in and custom (Requirement 6.1). */
  categories: readonly string[];
  /** The category that will be saved, or that the entry has. */
  value: string;
  onChange(category: string): void;
  /** The visible label. Defaults to "Category". */
  label?: string;
  disabled?: boolean;
  /** The suggestion behind the shown category. Its reason and its Default label are shown as text. */
  suggestion?: CategorySuggestion | null;
  /** Id of the reason text, so an outer description can point at it. */
  reasonId?: string;
  /** Present for a remembered suggestion: the "Forget this" action (Requirement 6.12). */
  onForget?: () => void;
  forgetBusy?: boolean;
  /** The result of the last "Forget this", shown in a polite status once. Rendered whenever `onForget` is given. */
  forgetStatusText?: string;
  /** Extra ids for `aria-describedby` of the select, for example a row status. */
  describedBy?: string;
}

/**
 * A native `<select>` of every available category, one selection to change it by keyboard, mouse, or touch
 * (Requirement 6.1). With a suggestion it also shows, as plain text, why the category was suggested, and the text
 * "Default" when no source applied (Requirement 5.12). A category the User chose instead of the suggestion is stated as
 * the User's choice. "Forget this" appears only while the suggestion comes from a remembered choice.
 */
export function CategoryChoice({
  id,
  categories,
  value,
  onChange,
  label = 'Category',
  disabled = false,
  suggestion = null,
  reasonId,
  onForget,
  forgetBusy = false,
  forgetStatusText = '',
  describedBy,
}: CategoryChoiceProps) {
  // A saved category that is no longer in the list stays selectable, so the control never shows a wrong value.
  const options = categories.includes(value) ? categories : [value, ...categories];
  const chosenOther = suggestion !== null && value !== suggestion.category;
  const showDefault = suggestion !== null && suggestion.source === 'default' && !chosenOther;
  const reasonRefs = [describedBy ?? '', suggestion ? reasonId ?? '' : ''].filter(Boolean).join(' ');

  return (
    <div className="qa-category">
      <label htmlFor={id} className="qa-category-label">{label}</label>
      <div className="qa-category-line">
        <select
          id={id}
          value={value}
          disabled={disabled}
          aria-describedby={reasonRefs || undefined}
          onChange={(event) => onChange(event.target.value)}
        >
          {options.map((category) => <option key={category} value={category}>{category}</option>)}
        </select>
        {showDefault && <span className="clarity-badge clarity-tone-info">{DEFAULT_LABEL}</span>}
        {suggestion?.source === 'memory' && onForget && (
          <button
            type="button"
            className="btn sm ghost"
            aria-disabled={forgetBusy || undefined}
            aria-describedby={reasonId}
            onClick={() => {
              if (!forgetBusy) onForget();
            }}
          >
            {forgetBusy ? 'Forgetting…' : FORGET_LABEL}
          </button>
        )}
      </div>
      {suggestion && (
        <p id={reasonId} className="qa-reason small">
          {chosenOther
            ? `You chose ${value}. Quick Add suggested ${suggestion.category}: ${suggestion.reason}`
            : suggestion.reason}
        </p>
      )}
      {/* Always mounted while "Forget this" can exist, so the one result message is announced when it is set. */}
      {onForget && <p role="status" className="qa-reason small qa-forget-status">{forgetStatusText}</p>}
    </div>
  );
}

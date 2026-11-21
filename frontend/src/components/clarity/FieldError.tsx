import './clarity.css';

export interface FieldErrorProps {
  /** Id referenced by the input's `aria-describedby`. */
  id: string;
  /** Plain name of the affected input, for example "Salary". */
  field: string;
  /** Why the value was rejected. */
  reason: string;
  /** The accepted correction, for example "Enter an amount from 1 to 10,00,00,000". */
  correction: string;
}

/**
 * Text error for one input (Requirements 12.15 to 12.17). It names the input,
 * the reason, and the accepted correction. It is announced by assistive
 * technology when it appears and never moves keyboard focus.
 */
export function FieldError({ id, field, reason, correction }: FieldErrorProps) {
  return (
    <p id={id} role="alert" className="clarity-field-error">
      <span aria-hidden="true" className="clarity-glyph">!</span>
      <strong>{field}:</strong> {reason} {correction}
    </p>
  );
}

/** Attributes that tie an input to its `FieldError`. Spread onto the input. */
export function fieldErrorProps(errorId: string, hasError: boolean): {
  'aria-invalid'?: true;
  'aria-describedby'?: string;
} {
  return hasError ? { 'aria-invalid': true, 'aria-describedby': errorId } : {};
}

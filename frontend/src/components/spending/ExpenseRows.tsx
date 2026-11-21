import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { useMutationStatus } from '../../clarity/MutationStatusProvider';
import {
  expenseYearRange,
  validateExpenseFields,
  type ExpenseField,
  type ExpenseView,
} from '../../clarity/spendingInputs';
import type { FieldProblem } from '../../clarity/planInputs';
import { amountToInput, inr, monthLabel } from '../../money';
import { FieldError, fieldErrorProps } from '../clarity/FieldError';
import { ScopedMutationStatus } from '../clarity/ScopedMutationStatus';
import { Field } from '../ui';
import { CONFLICT_TEXT, type PendingCreate, type SpendingChanges } from './useSpendingChanges';
import './spending.css';

function Problem({ id, problem }: { id: string; problem: FieldProblem | undefined }) {
  return problem ? <FieldError id={id} field={problem.field} reason={problem.reason} correction={problem.correction} /> : null;
}

function describeEntry(view: Pick<ExpenseView, 'displayDate' | 'note'>): string {
  return `${view.displayDate}${view.note ? ` · ${view.note}` : ''}`;
}

export interface ExpenseItemProps {
  /** The row as shown: the confirmed record, or its provisional values while a correction is pending. */
  view: ExpenseView;
  /** The last confirmed record. Corrections are compared against it. */
  original: ExpenseView;
  categories: readonly string[];
  /** The month the page shows. */
  month: string;
  changes: SpendingChanges;
  /** The row will leave this month's list once its change is confirmed. */
  onRemoved: () => void;
}

/**
 * One saved expense with its own correction form, delete, and status. Its scope
 * is `expense:<id>`, so it is independent of every other row, the log form, and
 * every category treatment control.
 */
export function ExpenseItem({ view, original, categories, month, changes, onRemoved }: ExpenseItemProps) {
  const ids = useId();
  const scope = `expense:${original.id}`;
  const status = useMutationStatus(scope);
  const pending = status?.phase === 'pending';
  const conflict = changes.conflicts.has(scope);
  const createdScope = changes.createdScopeOf(original.id);
  const rowRef = useRef<HTMLLIElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [returnFocus, setReturnFocus] = useState(false);
  const [dAmount, setDAmount] = useState('');
  const [dCategory, setDCategory] = useState('');
  const [dNote, setDNote] = useState('');
  const [dDate, setDDate] = useState('');
  const [errors, setErrors] = useState<Partial<Record<ExpenseField | 'form', FieldProblem>>>({});
  const statusId = `${ids}-status`;
  const amountText = inr(original.amountMinor / 100);
  const range = expenseYearRange();

  useEffect(() => {
    if (!editing && returnFocus) {
      editButton.current?.focus();
      setReturnFocus(false);
    }
  }, [editing, returnFocus]);

  // The Edit button is replaced by the form, so focus moves to the form's first field instead of dropping to the page.
  // A failed save reopens the same form without changing `editing`, so it does not take focus back.
  useEffect(() => {
    if (editing) amountRef.current?.focus({ preventScroll: true });
  }, [editing]);

  function startEdit() {
    setDAmount(amountToInput(original.amountMinor / 100));
    setDCategory(original.category);
    setDNote(original.note ?? '');
    setDDate(original.displayDate);
    setErrors({});
    setEditing(true);
  }

  function cancelEdit() {
    setEditing(false);
    setErrors({});
    setReturnFocus(true);
  }

  function save(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    const checked = validateExpenseFields(
      { amount: dAmount, category: dCategory, note: dNote, date: dDate },
      { categories, withDate: true },
    );
    if (!checked.values) {
      setErrors(checked.errors);
      return;
    }
    const values = checked.values;
    const spentOn = values.spentOn ?? original.displayDate;
    // Only changed fields are sent.
    const body: Record<string, unknown> = {};
    if (values.amountMinor !== original.amountMinor) body.amountMinor = values.amountMinor;
    if (values.category !== original.category) body.category = values.category;
    if (values.note !== original.note) body.note = values.note;
    if (spentOn !== original.displayDate) body.spentOn = spentOn;
    if (Object.keys(body).length === 0) {
      setErrors({ form: { field: 'This expense', reason: 'has no changes to save.', correction: 'Change at least one field, or choose Cancel.' } });
      return;
    }
    setErrors({});
    const version = changes.versionOf('expense', original.id);
    if (version !== undefined) body.expectedRecordVersion = version;
    const resultingMonth = spentOn.slice(0, 7);
    const leaves = resultingMonth !== month;
    void changes.run({
      scopeKey: scope,
      label: `Update ${original.category} expense`,
      path: `/finance/expenses/${original.id}`,
      method: 'PATCH',
      body,
      months: [...new Set([original.month, resultingMonth])],
    }, {
      doneLabel: 'Expense updated',
      versionKey: `expense:${original.id}`,
      overlay: {
        id: original.id,
        month: resultingMonth,
        category: values.category,
        amountMinor: values.amountMinor,
        note: values.note,
        spentOn,
      },
      onSettled: (result) => {
        if (result.outcome !== 'confirmed') return;
        setEditing(false);
        if (leaves) onRemoved();
        else setReturnFocus(true);
      },
    });
  }

  function remove() {
    if (pending) return;
    const version = changes.versionOf('expense', original.id);
    void changes.run({
      scopeKey: scope,
      label: `Delete ${original.category} expense`,
      path: `/finance/expenses/${original.id}`,
      method: 'DELETE',
      body: version === undefined ? {} : { expectedRecordVersion: version },
      months: [original.month],
    }, {
      doneLabel: 'Expense deleted',
      versionKey: `expense:${original.id}`,
      onSettled: (result) => {
        if (result.outcome === 'confirmed') onRemoved();
      },
    });
  }

  // While a correction is pending the row shows the entered values with the pending status beside it.
  // A failure reopens the form with the draft untouched, and the row is back to its confirmed values.
  const formOpen = editing && !pending;
  const movingTo = view.month !== month ? monthLabel(view.month) : null;

  // The Save button leaves the page while its change is pending. Hand focus to the row's status so it is not dropped to the page.
  useEffect(() => {
    if (!pending || !editing) return;
    if (!document.activeElement || document.activeElement === document.body) {
      document.getElementById(statusId)?.focus({ preventScroll: true });
    }
  }, [pending, editing, statusId]);

  return (
    <li
      ref={rowRef}
      id={`expense-${original.id}`}
      tabIndex={-1}
      className={`list-item spending-expense${pending ? ' is-pending' : ''}`}
      data-expense-id={original.id}
    >
      {formOpen ? (
        <form className="spending-edit" onSubmit={save} noValidate aria-label={`Correct ${original.category} ${amountText}`}>
          <Field label="Amount">
            <input
              ref={amountRef}
              value={dAmount}
              onChange={(e) => setDAmount(e.target.value)}
              inputMode="decimal"
              maxLength={16}
              {...fieldErrorProps(`${ids}-amount`, !!errors.amount)}
            />
          </Field>
          <Problem id={`${ids}-amount`} problem={errors.amount} />
          <Field label="Category">
            <select
              value={dCategory}
              onChange={(e) => setDCategory(e.target.value)}
              {...fieldErrorProps(`${ids}-category`, !!errors.category)}
            >
              {!categories.includes(dCategory) && <option value={dCategory}>{dCategory}</option>}
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
          <Problem id={`${ids}-category`} problem={errors.category} />
          <Field label="Note (optional)">
            <input
              value={dNote}
              onChange={(e) => setDNote(e.target.value)}
              maxLength={160}
              {...fieldErrorProps(`${ids}-note`, !!errors.note)}
            />
          </Field>
          <Problem id={`${ids}-note`} problem={errors.note} />
          <Field label="Date" hint={`Moving it to another month recalculates both months.`}>
            <input
              type="date"
              value={dDate}
              min={`${range.min}-01-01`}
              max={`${range.max}-12-31`}
              onChange={(e) => setDDate(e.target.value)}
              {...fieldErrorProps(`${ids}-date`, !!errors.date)}
            />
          </Field>
          <Problem id={`${ids}-date`} problem={errors.date} />
          <Problem id={`${ids}-form`} problem={errors.form} />
          <div className="row" style={{ gap: '0.4rem' }}>
            <button className="btn primary sm" type="submit" aria-disabled={pending || undefined} aria-describedby={statusId}>
              Save changes
            </button>
            <button className="btn ghost sm" type="button" onClick={cancelEdit}>Cancel</button>
          </div>
        </form>
      ) : (
        <>
          <span className="avatar" aria-hidden="true">{view.category.slice(0, 1)}</span>
          <div className="grow">
            <strong>{view.category}</strong>
            <small className="muted">{describeEntry(view)}</small>
            {movingTo && <small className="muted spending-moving">Moving to {movingTo}…</small>}
          </div>
          <b className="mono">{inr(view.amountMinor / 100)}</b>
          <button
            ref={editButton}
            type="button"
            className="btn sm ghost"
            aria-disabled={pending || undefined}
            aria-describedby={statusId}
            aria-label={`Edit ${original.category} ${amountText}`}
            onClick={() => { if (!pending) startEdit(); }}
          >
            ✏
          </button>
          <button
            type="button"
            className="btn sm ghost"
            aria-disabled={pending || undefined}
            aria-describedby={statusId}
            aria-label={`Delete ${original.category} ${amountText}`}
            onClick={remove}
          >
            ✕
          </button>
        </>
      )}
      {conflict && <p role="alert" className="clarity-field-error spending-wide">{CONFLICT_TEXT}</p>}
      <ScopedMutationStatus scopeKey={scope} id={statusId} className="spending-wide" onRetry={changes.retry} />
      {createdScope && <ScopedMutationStatus scopeKey={createdScope} className="spending-wide" onRetry={changes.retry} />}
    </li>
  );
}

export interface PendingCreateItemProps {
  entry: PendingCreate;
  changes: SpendingChanges;
  /** Puts the entry's values back in the log form. Offered only while the form is empty. */
  onEditAgain?: (entry: PendingCreate) => void;
  /** The entry left the list while keyboard focus was inside it, so the list can take focus instead of the page. */
  onFocusLost?: () => void;
}

/**
 * A new expense that is saving or failed. It keeps every value the user entered
 * and its own status, with a retry that resends the original request and key.
 */
export function PendingCreateItem({ entry, changes, onEditAgain, onFocusLost }: PendingCreateItemProps) {
  const statusId = useId();
  const status = useMutationStatus(entry.scopeKey);
  const failed = status?.phase === 'error';
  const { dropCreate } = changes;
  const rowRef = useRef<HTMLLIElement>(null);
  const focusLost = useRef(onFocusLost);
  focusLost.current = onFocusLost;

  // The row is replaced by the saved row, or dismissed, while its Retry or Dismiss control or status held focus.
  // That focus would fall to the page, so the list is told to take it. Layout cleanup runs before the row is removed.
  useLayoutEffect(() => {
    const row = rowRef.current;
    return () => {
      if (row && row.contains(document.activeElement)) focusLost.current?.();
    };
  }, []);

  // Dismissing a failed save removes the unsaved entry.
  useEffect(() => {
    if (!status) dropCreate(entry.cid);
  }, [status, dropCreate, entry.cid]);

  return (
    <li ref={rowRef} className="list-item spending-expense is-pending" data-pending-create={entry.cid}>
      <span className="avatar" aria-hidden="true">{failed ? '!' : '⏳'}</span>
      <div className="grow">
        <strong>{entry.category}</strong>
        <small className="muted">{describeEntry({ displayDate: entry.spentOn, note: entry.note })}</small>
        <small className="muted">{failed ? 'Not saved yet. Retry, or edit it and log it again.' : 'Saving this expense…'}</small>
      </div>
      <b className="mono">{inr(entry.amountMinor / 100)}</b>
      {failed && onEditAgain && (
        <button
          type="button"
          className="btn sm ghost"
          aria-describedby={statusId}
          onClick={() => onEditAgain(entry)}
        >
          Edit again
        </button>
      )}
      <ScopedMutationStatus scopeKey={entry.scopeKey} id={statusId} className="spending-wide" onRetry={changes.retry} />
    </li>
  );
}

import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import type { FinancialSnapshot } from '../../clarity/contracts';
import { useDataUseGate } from '../../clarity/DataUseGateProvider';
import type { FieldProblem } from '../../clarity/planInputs';
import {
  FALLBACK_EXPENSE_CATEGORIES,
  spendingConfirmedState,
  toExpenseView,
  validateExpenseFields,
  type ExpenseField,
  type ExpenseView,
} from '../../clarity/spendingInputs';
import { amountToInput, monthLabel } from '../../money';
import { DATA_USE_REASON_ID } from '../clarity/DataUseGate';
import { FieldError, fieldErrorProps } from '../clarity/FieldError';
import { InputBenefitPreview } from '../clarity/InputBenefitPreview';
import { PurposeExplanation } from '../clarity/PurposeExplanation';
import { RegionBoundary } from '../clarity/RegionBoundary';
import { Card, Field } from '../ui';
import { CategoryTotals } from './CategoryTotals';
import { ExpenseItem, PendingCreateItem } from './ExpenseRows';
import {
  useExpenseList,
  useSpendingChanges,
  type ConfirmedSpendingChange,
  type PendingCreate,
} from './useSpendingChanges';
import './spending.css';

/** Entries shown before "Show all". */
const VISIBLE_ENTRIES = 8;

export interface ClaritySpendingTrackerProps {
  /** The exact month the page shows. */
  month: string;
  /** Newest confirmed snapshot with pending patches applied. */
  snapshot: FinancialSnapshot | undefined;
  /** An expense named by the link that opened the page. Its row is always shown. */
  focusExpenseId?: number;
  /** Called after each confirmed expense or treatment change. */
  onConfirmed?: (change: ConfirmedSpendingChange) => void;
  /** Re-reads the confirmed snapshot, for example after a conflict. */
  onRefresh?: () => void;
}

function Problem({ id, problem }: { id: string; problem: FieldProblem | undefined }) {
  return problem ? <FieldError id={id} field={problem.field} reason={problem.reason} correction={problem.correction} /> : null;
}

/**
 * Spending inputs and records for the clarity branch. Log, correct, delete, and
 * Needs/Wants treatment are each their own mutation scope with their own status,
 * retry, and rollback. The page never reloads, shows no page-wide busy state,
 * and every total and outcome it shows comes from the server's snapshot.
 */
export function ClaritySpendingTracker({ month, snapshot, focusExpenseId, onConfirmed, onRefresh }: ClaritySpendingTrackerProps) {
  const gate = useDataUseGate();
  const ids = useId();
  const list = useExpenseList(month);
  const changes = useSpendingChanges({ month, list, onConfirmed, onRefresh });
  const categories = list.data?.categories ?? FALLBACK_EXPENSE_CATEGORIES;
  const [amount, setAmount] = useState('');
  const [chosen, setChosen] = useState('Food');
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Partial<Record<ExpenseField, FieldProblem>>>({});
  const [showAll, setShowAll] = useState(false);
  const [removedCount, setRemovedCount] = useState(0);
  const amountRef = useRef<HTMLInputElement>(null);
  const entriesHeading = useRef<HTMLHeadingElement>(null);
  const monthName = monthLabel(month);
  // A category that no longer exists is not submitted; the first available one stands in.
  const category = categories.includes(chosen) ? chosen : (categories[0] ?? chosen);
  const gated = !gate.financialInputsEnabled;

  const originals = useMemo<ExpenseView[]>(() => (list.data?.expenses ?? []).map(toExpenseView), [list.data]);
  const confirmedState = useMemo(
    () => spendingConfirmedState(snapshot, month, { hasExpenses: originals.length > 0, category }),
    [snapshot, month, originals.length, category],
  );

  // A row that leaves the list takes focus with it. Hand focus to the list heading so it is not dropped to the page.
  useEffect(() => {
    if (removedCount === 0) return;
    if (!document.activeElement || document.activeElement === document.body) {
      entriesHeading.current?.focus({ preventScroll: true });
    }
  }, [removedCount]);

  const pristine = amount === '' && note === '';
  const pendingCreates = [...changes.creates.values()].reverse();
  const focusIndex = focusExpenseId === undefined ? -1 : originals.findIndex((row) => row.id === focusExpenseId);
  const expanded = showAll || focusIndex >= VISIBLE_ENTRIES;
  const shown = expanded ? originals : originals.slice(0, VISIBLE_ENTRIES);

  function add(event: FormEvent) {
    event.preventDefault();
    if (gated) return;
    const checked = validateExpenseFields({ amount, category, note }, { categories, withDate: false });
    if (!checked.values) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    const values = checked.values;
    // The entry moves to its own row with its own status, so the form is free for the next expense.
    changes.createExpense({ amountMinor: values.amountMinor, category: values.category, note: values.note });
    setAmount('');
    setNote('');
  }

  function editAgain(entry: PendingCreate) {
    setAmount(amountToInput(entry.amountMinor / 100));
    setChosen(entry.category);
    setNote(entry.note ?? '');
    setErrors({});
    changes.dropCreate(entry.cid);
    amountRef.current?.focus();
  }

  function display(original: ExpenseView): ExpenseView {
    const overlay = changes.overlays.get(`expense:${original.id}`);
    if (!overlay) return original;
    return {
      ...original,
      month: overlay.month,
      category: overlay.category,
      amountMinor: overlay.amountMinor,
      note: overlay.note,
      spentOn: overlay.spentOn,
      displayDate: overlay.spentOn,
    };
  }

  const amountErrorId = `${ids}-amount-error`;
  const categoryErrorId = `${ids}-category-error`;
  const noteErrorId = `${ids}-note-error`;
  const amountDescribed = ['purpose-expense', 'benefit-expense', errors.amount ? amountErrorId : '', gated ? DATA_USE_REASON_ID : '']
    .filter(Boolean).join(' ');

  return (
    <Card>
      <h2>📊 This month's spending</h2>
      <PurposeExplanation input="expense" />
      <InputBenefitPreview input="expense" confirmed={confirmedState} />

      <form id="expense-form" tabIndex={-1} onSubmit={add} noValidate aria-label="Log an expense" className="stack-sm spending-form" style={{ marginTop: '0.6rem' }}>
        <div className="row-sm" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
          <Field label="Amount">
            <input
              ref={amountRef}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              placeholder="e.g. 480"
              maxLength={20}
              {...fieldErrorProps(amountErrorId, !!errors.amount)}
              aria-describedby={amountDescribed}
            />
          </Field>
          <Field label="Category">
            <select
              value={category}
              onChange={(e) => setChosen(e.target.value)}
              {...fieldErrorProps(categoryErrorId, !!errors.category)}
            >
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
        </div>
        <Problem id={amountErrorId} problem={errors.amount} />
        <Problem id={categoryErrorId} problem={errors.category} />
        <Field label="Note (optional)">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={160}
            placeholder="Coffee with Priya"
            {...fieldErrorProps(noteErrorId, !!errors.note)}
          />
        </Field>
        <Problem id={noteErrorId} problem={errors.note} />
        <button
          className="btn primary"
          type="submit"
          disabled={gated}
          aria-describedby={gated ? DATA_USE_REASON_ID : undefined}
        >
          + Log expense
        </button>
        {/* The visible reason lives in the data-use notice; the button points at it. */}
        {gated && <span className="sr-only">New entries are paused. See the data-use notice for the reason.</span>}
      </form>

      <CategoryTotals snapshot={snapshot} month={month} changes={changes} />

      <h3 ref={entriesHeading} tabIndex={-1} className="spending-entries-title">Recent entries for {monthName}</h3>
      {pendingCreates.length > 0 && (
        <ul className="list" aria-label="Expenses being saved">
          {pendingCreates.map((entry) => (
            <PendingCreateItem
              key={entry.cid}
              entry={entry}
              changes={changes}
              onEditAgain={pristine ? editAgain : undefined}
              onFocusLost={() => setRemovedCount((count) => count + 1)}
            />
          ))}
        </ul>
      )}
      <RegionBoundary
        regionKey="expense-list"
        label="Expense list"
        hasData={!!list.data}
        loading={list.loading}
        error={list.error}
        onRetry={() => { void list.reload(); }}
        minHeight={120}
      >
        {originals.length === 0 ? (
          pendingCreates.length === 0 && (
            <p className="muted small" style={{ marginTop: '0.6rem' }}>
              Log a few expenses to see your actuals against the plan.
            </p>
          )
        ) : (
          <>
            <ul className="list">
              {shown.map((original) => (
                <ExpenseItem
                  key={changes.createdScopeOf(original.id) ?? `e:${original.id}`}
                  view={display(original)}
                  original={original}
                  categories={categories}
                  month={month}
                  changes={changes}
                  onRemoved={() => setRemovedCount((count) => count + 1)}
                />
              ))}
            </ul>
            {originals.length > VISIBLE_ENTRIES && (
              <p className="small muted">
                {expanded ? `Showing all ${originals.length} entries. ` : `+${originals.length - VISIBLE_ENTRIES} more this month. `}
                <button
                  type="button"
                  className="btn sm ghost"
                  aria-expanded={expanded}
                  onClick={() => setShowAll((value) => !value)}
                >
                  {expanded ? 'Show fewer' : 'Show all'}
                </button>
              </p>
            )}
          </>
        )}
      </RegionBoundary>
    </Card>
  );
}

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useMutationStatus } from '../../clarity/MutationStatusProvider';
import type { FieldProblem } from '../../clarity/planInputs';
import { FALLBACK_EXPENSE_CATEGORIES } from '../../clarity/spendingInputs';
import { formatPaise } from '../clarity/format';
import { DATA_USE_REASON_ID } from '../clarity/DataUseGate';
import { FieldError, fieldErrorProps } from '../clarity/FieldError';
import { ScopedMutationStatus } from '../clarity/ScopedMutationStatus';
import { useExpenseList } from '../spending/useSpendingChanges';
import { currentMonth } from '../../money';
import type { TripExpense } from '../../types';
import { Field } from '../ui';
import { describeTripProblem, monthOfDate } from './tripModel';
import type { TripChanges } from './useTripChanges';

export type PersonalLinkState =
  | { status: 'included'; category: string; spentOn: string; amountMinor: number }
  | { status: 'withdrawn' };

/** What this page learned from confirmed include and withdraw changes. The server's read has no link state, so a reload starts unknown. */
export function usePersonalLinkStates() {
  const [states, setStates] = useState<ReadonlyMap<number, PersonalLinkState>>(() => new Map());
  const set = useCallback((expenseId: number, state: PersonalLinkState) => {
    setStates((current) => new Map(current).set(expenseId, state));
  }, []);
  return { states, set };
}

function localToday(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

export interface PersonalShareProps {
  tripId: number;
  expense: TripExpense;
  /** The signed-in member's allocated share, in paise, exactly as the server calculated it. */
  shareMinor: number;
  changes: TripChanges;
  gated: boolean;
  state: PersonalLinkState | undefined;
  onState: (expenseId: number, state: PersonalLinkState) => void;
}

type Problem = FieldProblem | undefined;

function IncludePanel({ tripId, expense, shareMinor, changes, onState, onClose, scopeKey }: Pick<PersonalShareProps, 'tripId' | 'expense' | 'shareMinor' | 'changes' | 'onState'> & { onClose: () => void; scopeKey: string }) {
  const ids = useId();
  const list = useExpenseList(currentMonth());
  const categories = list.data?.categories ?? FALLBACK_EXPENSE_CATEGORIES;
  const [chosen, setChosen] = useState('');
  const [spentOn, setSpentOn] = useState(localToday);
  const [errors, setErrors] = useState<{ category?: Problem; spentOn?: Problem; form?: Problem }>({});
  const status = useMutationStatus(scopeKey);
  const pending = status?.phase === 'pending';
  const category = categories.includes(chosen) ? chosen : (categories[0] ?? '');
  const amount = formatPaise(shareMinor);
  const validDate = isCalendarDate(spentOn);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    if (!category) {
      setErrors({ category: { field: 'Category', reason: 'is required.', correction: 'Choose one of your categories. You can add categories in Settings.' } });
      return;
    }
    if (!validDate) {
      setErrors({ spentOn: { field: 'Date', reason: 'is not a valid date.', correction: 'Pick the day this share was spent.' } });
      return;
    }
    setErrors({});
    void changes.run({
      scopeKey,
      label: `Include my share of ${expense.description}`,
      path: `/trips/${tripId}/expenses/${expense.id}/personal-link`,
      method: 'PUT',
      body: { category, spentOn },
    }, {
      showsValidation: true,
      fallbackField: 'Personal share',
      onSettled: (result) => {
        if (result.outcome === 'confirmed') {
          onState(expense.id, { status: 'included', category, spentOn, amountMinor: shareMinor });
          onClose();
        } else if (result.outcome === 'failed') {
          // A rejected value is shown beside its field. The runner dropped the shared status for it.
          const problem = describeTripProblem(result.error, 'Personal share');
          if (problem && (result.error.status === 400 || result.error.status === 422)) {
            setErrors({ [problem.key]: problem.problem });
          }
        }
      },
    });
  }

  return (
    <form className="trip-personal-panel stack-sm" onSubmit={submit} noValidate aria-label={`Confirm including your share of ${expense.description}`}>
      <p>
        <strong>Add {amount} to {category || 'a category'} spending for {validDate ? monthOfDate(spentOn) : 'the chosen month'}?</strong>
      </p>
      <p className="small muted">
        This is your share of “{expense.description}”. It is counted once in that month and category. Your trip balance does not change.
      </p>
      <div className="row-sm" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
        <Field label="Category">
          <select
            value={category}
            onChange={(event) => setChosen(event.target.value)}
            disabled={pending}
            {...fieldErrorProps(`${ids}-category-error`, !!errors.category)}
          >
            {categories.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </Field>
        <Field label="Date spent">
          <input
            type="date"
            value={spentOn}
            onChange={(event) => setSpentOn(event.target.value)}
            readOnly={pending}
            {...fieldErrorProps(`${ids}-date-error`, !!errors.spentOn)}
          />
        </Field>
      </div>
      {errors.category && <FieldError id={`${ids}-category-error`} {...errors.category} />}
      {errors.spentOn && <FieldError id={`${ids}-date-error`} {...errors.spentOn} />}
      {errors.form && <FieldError id={`${ids}-form-error`} {...errors.form} />}
      <div className="row-sm" style={{ gap: '0.5rem' }}>
        <button className="btn primary sm" type="submit" aria-disabled={pending || undefined}>Confirm and include</button>
        <button className="btn ghost sm" type="button" onClick={onClose}>Cancel</button>
      </div>
    </form>
  );
}

/**
 * One shared expense's link to the signed-in member's monthly spending. Including
 * and withdrawing each ask for an explicit confirmation that shows the exact
 * amount, category, and month, and each runs on its own scope with its own
 * status and retry. Both are safe to repeat on the server: an include for a link
 * that exists with the same values and a withdraw with nothing linked change nothing.
 */
export function PersonalShare({ tripId, expense, shareMinor, changes, gated, state, onState }: PersonalShareProps) {
  const ids = useId();
  const scopeKey = `trip-personal-link:${expense.id}`;
  const status = useMutationStatus(scopeKey);
  const pending = status?.phase === 'pending';
  const [panel, setPanel] = useState<'include' | 'withdraw' | null>(null);
  const amount = formatPaise(shareMinor);
  const statusId = `${ids}-status`;
  const rootRef = useRef<HTMLDivElement>(null);
  const includeButton = useRef<HTMLButtonElement>(null);
  const withdrawButton = useRef<HTMLButtonElement>(null);
  const refocus = useRef<'include' | 'withdraw' | null>(null);

  // Closing a confirmation (by confirming or cancelling) removes the control that had focus. If the user is
  // still in it, focus goes to the control that now stands for the share; if they moved on, it stays put.
  function closePanel() {
    if (panel && rootRef.current?.contains(document.activeElement)) refocus.current = panel;
    setPanel(null);
  }
  useEffect(() => {
    const closed = refocus.current;
    if (!closed || panel !== null) return;
    refocus.current = null;
    const included = state?.status === 'included';
    const withdrawn = state?.status === 'withdrawn';
    const target = closed === 'include'
      ? (included ? withdrawButton.current : includeButton.current)
      : (withdrawn ? includeButton.current : withdrawButton.current);
    (target ?? includeButton.current ?? withdrawButton.current)?.focus();
  }, [panel, state?.status]);

  function withdraw() {
    if (pending) return;
    void changes.run({
      scopeKey,
      label: `Withdraw my share of ${expense.description}`,
      path: `/trips/${tripId}/expenses/${expense.id}/personal-link`,
      method: 'DELETE',
    }, {
      onSettled: (result) => {
        if (result.outcome !== 'confirmed') return;
        onState(expense.id, { status: 'withdrawn' });
        closePanel();
      },
    });
  }

  return (
    <div ref={rootRef} className="trip-personal" role="group" aria-label={`Your share of ${expense.description}`}>
      <p className="small">
        <strong>Your share: <span className="mono">{amount}</span></strong>{' '}
        {state?.status === 'included'
          ? <span>Included in {state.category} spending for {monthOfDate(state.spentOn)}.</span>
          : state?.status === 'withdrawn'
            ? <span>Not included in your monthly spending.</span>
            : <span className="muted">Not added to monthly spending unless you include it.</span>}
      </p>
      <div className="row-sm" style={{ gap: '0.4rem', flexWrap: 'wrap' }}>
        {state?.status !== 'included' && (
          <button
            ref={includeButton}
            type="button"
            className="btn sm"
            disabled={gated}
            aria-disabled={pending || undefined}
            aria-expanded={panel === 'include'}
            aria-describedby={gated ? DATA_USE_REASON_ID : statusId}
            aria-label={`Include in my spending: ${expense.description}`}
            onClick={() => setPanel(panel === 'include' ? null : 'include')}
          >
            Include in my spending…
          </button>
        )}
        {state?.status !== 'withdrawn' && (
          <button
            ref={withdrawButton}
            type="button"
            className="btn sm ghost"
            aria-disabled={pending || undefined}
            aria-expanded={panel === 'withdraw'}
            aria-describedby={statusId}
            aria-label={`Withdraw from my spending: ${expense.description}`}
            onClick={() => setPanel(panel === 'withdraw' ? null : 'withdraw')}
          >
            Withdraw from my spending…
          </button>
        )}
      </div>
      {panel === 'include' && (
        <IncludePanel
          tripId={tripId}
          expense={expense}
          shareMinor={shareMinor}
          changes={changes}
          onState={onState}
          scopeKey={scopeKey}
          onClose={closePanel}
        />
      )}
      {panel === 'withdraw' && (
        <div className="trip-personal-panel stack-sm" role="group" aria-label={`Confirm withdrawing your share of ${expense.description}`}>
          <p>
            <strong>Remove {amount} from your monthly spending?</strong>
          </p>
          <p className="small muted">
            This removes the personal expense that was created from your share of “{expense.description}”, once, from the month and category it was included in.
            The trip and your trip balance are kept.
          </p>
          <div className="row-sm" style={{ gap: '0.5rem' }}>
            <button className="btn primary sm" type="button" aria-disabled={pending || undefined} onClick={withdraw}>Confirm and withdraw</button>
            <button className="btn ghost sm" type="button" onClick={closePanel}>Cancel</button>
          </div>
        </div>
      )}
      <ScopedMutationStatus scopeKey={scopeKey} id={statusId} onRetry={changes.retry} />
    </div>
  );
}

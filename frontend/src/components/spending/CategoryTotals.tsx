import { useId, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import type { FinancialSnapshot } from '../../clarity/contracts';
import { useMutationStatus } from '../../clarity/MutationStatusProvider';
import type { FieldProblem } from '../../clarity/planInputs';
import {
  TREATMENT_LABEL,
  selectCategoryTotals,
  selectCategoryTreatments,
  selectSpendingValue,
  treatmentScope,
  type CategoryTreatment,
  type Treatment,
} from '../../clarity/spendingInputs';
import { amountToInput, inr, monthLabel, parseAmount } from '../../money';
import { errText } from '../../state';
import { FieldError, fieldErrorProps } from '../clarity/FieldError';
import { formatMoney } from '../clarity/format';
import { ClassificationBadge } from '../clarity/labels';
import { ScopedMutationStatus } from '../clarity/ScopedMutationStatus';
import { CONFLICT_TEXT, type SpendingChanges } from './useSpendingChanges';
import './spending.css';

const BUDGETS_KEY = ['finance', 'budgets'] as const;

type LimitState =
  | { phase: 'idle' }
  | { phase: 'pending'; label: string }
  | { phase: 'done'; label: string }
  | { phase: 'failed'; label: string; message: string; retry: () => void };

const LIMIT_PROBLEM: FieldProblem = {
  field: 'Limit',
  reason: 'is not an accepted amount.',
  correction: 'Enter an amount such as 5000, or 0 to remove the limit.',
};

/**
 * The user's own spending limit for one category. It is an entered value shown
 * beside the server's total. It is never compared or subtracted here.
 */
function LimitControl({ category, limit }: { category: string; limit: number }) {
  const queryClient = useQueryClient();
  const ids = useId();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState<FieldProblem | undefined>();
  const [state, setState] = useState<LimitState>({ phase: 'idle' });
  const busy = state.phase === 'pending';

  async function send(amount: number) {
    const label = amount === 0 ? `Remove ${category} limit` : `Set ${category} limit`;
    const path = `/finance/budgets/${encodeURIComponent(category)}`;
    const attempt = async (): Promise<void> => {
      setState({ phase: 'pending', label });
      try {
        if (amount === 0) await api.del(path);
        else await api.put(path, { amount });
        queryClient.setQueryData<{ budgets: Record<string, number> } | undefined>(BUDGETS_KEY, (current) => {
          if (!current) return current;
          const budgets = { ...current.budgets };
          if (amount === 0) delete budgets[category];
          else budgets[category] = amount;
          return { budgets };
        });
        setState({ phase: 'done', label });
        setEditing(false);
      } catch (error) {
        setState({ phase: 'failed', label, message: errText(error), retry: () => { void attempt(); } });
      }
    };
    await attempt();
  }

  function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const amount = parseAmount(draft);
    if (amount === null) {
      setProblem(LIMIT_PROBLEM);
      return;
    }
    setProblem(undefined);
    void send(amount);
  }

  return (
    <div className="spending-limit">
      {editing ? (
        <form onSubmit={save} noValidate aria-label={`Limit for ${category}`} className="spending-limit-form">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            inputMode="decimal"
            placeholder="0 = remove"
            aria-label={`Spending limit for ${category}`}
            autoFocus
            {...fieldErrorProps(`${ids}-problem`, !!problem)}
          />
          <button className="btn sm" type="submit" aria-disabled={busy || undefined}>Save limit</button>
          <button className="btn sm ghost" type="button" onClick={() => { setEditing(false); setProblem(undefined); }}>Cancel</button>
        </form>
      ) : (
        <>
          <span className="small">{limit > 0 ? <>Your limit: <span className="mono">{inr(limit)}</span></> : 'No limit set'}</span>
          <button
            type="button"
            className="btn sm ghost"
            aria-label={limit > 0 ? `Edit limit for ${category}` : `Set limit for ${category}`}
            onClick={() => { setDraft(limit > 0 ? amountToInput(limit) : ''); setEditing(true); }}
          >
            {limit > 0 ? '✏' : '➕'}
          </button>
        </>
      )}
      {problem && <FieldError id={`${ids}-problem`} field={problem.field} reason={problem.reason} correction={problem.correction} />}
      <p className="small" role="status">
        {state.phase === 'pending' && `${state.label}: pending`}
        {state.phase === 'done' && `${state.label}: done`}
      </p>
      {state.phase === 'failed' && (
        <div role="alert" className="clarity-field-error">
          <strong>{state.label}: failed.</strong> {state.message}{' '}
          <button type="button" className="btn sm ghost" aria-label={`Retry ${state.label}`} onClick={state.retry}>Retry</button>
        </div>
      )}
    </div>
  );
}

function TreatmentControl({
  category,
  treatment,
  changes,
}: {
  category: string;
  treatment: CategoryTreatment;
  changes: SpendingChanges;
}) {
  const scope = treatmentScope(category);
  const status = useMutationStatus(scope);
  const statusId = useId();
  const pending = status?.phase === 'pending';
  const conflict = changes.conflicts.has(scope);

  function choose(next: Treatment) {
    if (pending || next === treatment.treatment) return;
    changes.setTreatment({ category, treatment: next, recordId: treatment.recordId });
  }

  function restore() {
    if (pending) return;
    changes.removeTreatment({ category, recordId: treatment.recordId });
  }

  return (
    <div className="spending-treatment">
      <div role="group" aria-label={`Budget treatment for ${category}`} className="spending-treatment-buttons">
        {(['needs', 'wants'] as const).map((value) => (
          <button
            key={value}
            type="button"
            className={`btn sm ${treatment.treatment === value ? 'primary' : 'ghost'}`}
            aria-pressed={treatment.treatment === value}
            aria-disabled={pending || undefined}
            aria-describedby={statusId}
            aria-label={`Count ${category} as ${TREATMENT_LABEL[value]}`}
            onClick={() => choose(value)}
          >
            {TREATMENT_LABEL[value]}
          </button>
        ))}
        {treatment.source === 'override' && (
          <button
            type="button"
            className="btn sm ghost"
            aria-disabled={pending || undefined}
            aria-describedby={statusId}
            aria-label={`Use the default treatment for ${category}`}
            onClick={restore}
          >
            Use default
          </button>
        )}
      </div>
      <small className="muted">
        Counted as {TREATMENT_LABEL[treatment.treatment]} ({treatment.source === 'override' ? 'your choice' : 'default'})
      </small>
      {conflict && <p role="alert" className="clarity-field-error">{CONFLICT_TEXT}</p>}
      <ScopedMutationStatus scopeKey={scope} id={statusId} onRetry={changes.retry} />
    </div>
  );
}

export interface CategoryTotalsProps {
  snapshot: FinancialSnapshot | undefined;
  month: string;
  changes: SpendingChanges;
}

/**
 * Each category's total and Needs or Wants treatment, from the server's snapshot.
 * Every treatment control is its own scope, so changing one category never
 * disables or reloads another. This is the target of the "review budget" action.
 */
export function CategoryTotals({ snapshot, month, changes }: CategoryTotalsProps) {
  const totals = selectCategoryTotals(snapshot, month);
  const treatments = selectCategoryTreatments(snapshot, month);
  const value = selectSpendingValue(snapshot, month);
  const limits = useQuery({
    queryKey: BUDGETS_KEY,
    queryFn: () => api.get<{ budgets: Record<string, number> }>('/finance/budgets'),
  });
  const budgets = limits.data?.budgets ?? {};
  const categories = [...new Set([...totals.map((item) => item.category), ...Object.keys(budgets)])];
  const monthName = monthLabel(month);
  const status = snapshot?.outcomes.spending.status;

  return (
    <section id="category-budgets" tabIndex={-1} aria-labelledby="category-totals-title" className="spending-categories">
      <h3 id="category-totals-title">Categories for {monthName}</h3>
      {!value && (
        <p className="small muted">
          {status === 'calculation_failed'
            ? 'Category totals are temporarily unavailable. Your expenses below are saved.'
            : 'Category totals appear once this month’s spending is calculated. Your expenses below are saved.'}
        </p>
      )}
      {categories.length === 0 ? (
        value && <p className="small muted">No spending is recorded for {monthName} yet.</p>
      ) : (
        <ul className="list">
          {categories.map((category) => {
            const total = totals.find((item) => item.category === category);
            const treatment = treatments.get(category);
            return (
              <li key={category} className="list-item spending-category" data-category={category}>
                <span className="pill info">{category}</span>
                <div className="grow">
                  {total ? (
                    <span>
                      <ClassificationBadge classification="calculated_result" />{' '}
                      Total <b className="mono">{formatMoney(total.total)}</b>
                    </span>
                  ) : (
                    <span className="small muted">{value ? 'No spending this month' : 'Total not available'}</span>
                  )}
                </div>
                {treatment && <TreatmentControl category={category} treatment={treatment} changes={changes} />}
                <LimitControl category={category} limit={budgets[category] ?? 0} />
              </li>
            );
          })}
        </ul>
      )}
      {limits.isError && (
        <p className="small muted" role="status">
          Your saved limits could not be loaded.{' '}
          <button type="button" className="btn ghost sm" onClick={() => { void limits.refetch(); }}>Retry loading limits</button>
        </p>
      )}
    </section>
  );
}

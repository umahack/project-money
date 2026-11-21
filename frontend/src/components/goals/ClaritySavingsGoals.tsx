import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import type { FinancialSnapshot } from '../../clarity/contracts';
import { useDataUseGate } from '../../clarity/DataUseGateProvider';
import { useMutationStatus } from '../../clarity/MutationStatusProvider';
import type { FieldProblem } from '../../clarity/planInputs';
import { DATA_USE_REASON_ID } from '../clarity/DataUseGate';
import { FieldError, fieldErrorProps } from '../clarity/FieldError';
import { InputBenefitPreview } from '../clarity/InputBenefitPreview';
import { OutcomeCard, type OutcomeRetry } from '../clarity/OutcomeCard';
import { PurposeExplanation } from '../clarity/PurposeExplanation';
import { RegionBoundary } from '../clarity/RegionBoundary';
import { ScopedMutationStatus } from '../clarity/ScopedMutationStatus';
import { Card, Field } from '../ui';
import { GoalItem, type GoalArrival } from './GoalRows';
import {
  describeServerProblem,
  findAggregateGoalOutcome,
  findGoalOutcome,
  goalConfirmedState,
  todayFor,
  validateNewGoal,
  type GoalDraftText,
  type GoalField,
} from './goalInputs';
import { CONFLICT_TEXT, useGoalChanges, useGoalList, type ConfirmedGoalChange } from './useGoalChanges';
import './goals.css';

const CREATE_SCOPE = 'new-goal:form';
const EMPTY_DRAFT: GoalDraftText = { name: '', target: '', saved: '', date: '' };

export interface ClaritySavingsGoalsProps {
  /** The exact month the page shows. */
  month: string;
  /** Newest confirmed snapshot with pending patches applied. */
  snapshot: FinancialSnapshot | undefined;
  snapshotLoading: boolean;
  snapshotError?: unknown;
  /** The action link that opened the page. */
  arrival: GoalArrival;
  /** Re-reads the confirmed snapshot, for example after a conflict. */
  onRefresh: () => void;
  /** Recalculates from the confirmed goals. No input is requested again. */
  onRecalculate: (retry: OutcomeRetry) => void | Promise<void>;
  recalculating: boolean;
  /** Called after each confirmed goal change. The guided journey uses it to advance. */
  onConfirmed?: (change: ConfirmedGoalChange) => void;
}

function Problem({ id, problem }: { id: string; problem: FieldProblem | undefined }) {
  return problem ? <FieldError id={id} field={problem.field} reason={problem.reason} correction={problem.correction} /> : null;
}

/**
 * Goals in the clarity branch. Create, correct, contribute, revise, and delete
 * are each their own mutation scope with their own status, retry, and rollback.
 * The page never reloads and shows no page-wide busy state. Every outcome shown
 * is the server's snapshot; the browser only checks what was typed.
 */
export function ClaritySavingsGoals({
  month,
  snapshot,
  snapshotLoading,
  snapshotError,
  arrival,
  onRefresh,
  onRecalculate,
  recalculating,
  onConfirmed,
}: ClaritySavingsGoalsProps) {
  const gate = useDataUseGate();
  const ids = useId();
  const list = useGoalList();
  const changes = useGoalChanges({ month, list, onRefresh, onConfirmed });
  const status = useMutationStatus(CREATE_SCOPE);
  const pending = status?.phase === 'pending';
  const conflict = changes.conflicts.has(CREATE_SCOPE);
  const [draft, setDraft] = useState<GoalDraftText>(EMPTY_DRAFT);
  const [errors, setErrors] = useState<Partial<Record<GoalField | 'form', FieldProblem>>>({});
  const [removedCount, setRemovedCount] = useState(0);
  const draftRef = useRef('');
  draftRef.current = JSON.stringify(draft);
  const listHeading = useRef<HTMLHeadingElement>(null);
  const today = todayFor(snapshot);
  const gated = !gate.financialInputsEnabled;
  const confirmedState = useMemo(() => goalConfirmedState(snapshot), [snapshot]);
  const aggregate = findAggregateGoalOutcome(snapshot);
  const goals = list.data;

  // A deleted goal takes focus with it. Hand focus to the list heading so it is not dropped to the page.
  useEffect(() => {
    if (removedCount === 0) return;
    if (!document.activeElement || document.activeElement === document.body) {
      listHeading.current?.focus({ preventScroll: true });
    }
  }, [removedCount]);

  function create(event: FormEvent) {
    event.preventDefault();
    if (pending || gated) return;
    const checked = validateNewGoal(draft, today);
    if (!checked.values) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    const values = checked.values;
    const submitted = draftRef.current;
    void changes.run({
      scopeKey: CREATE_SCOPE,
      label: 'Add goal',
      path: '/finance/goals',
      method: 'POST',
      body: {
        name: values.name,
        targetAmountMinor: values.targetAmountMinor,
        savedAmountMinor: values.savedAmountMinor,
        targetDate: values.targetDate,
      },
      months: [month],
    }, {
      showsValidation: true,
      onSettled: (result) => {
        if (result.outcome === 'confirmed') {
          // Clear the form only when it still holds what was submitted.
          if (draftRef.current === submitted) setDraft(EMPTY_DRAFT);
        } else if (result.outcome === 'failed') {
          const problem = describeServerProblem(result.error);
          if (problem && problem.key !== 'contribution') setErrors({ [problem.key]: problem.problem });
        }
      },
    });
  }

  const statusId = `${ids}-status`;
  const describedBy = (field: GoalField, extra: string[] = []) => [...extra, errors[field] ? `${ids}-${field}-error` : '']
    .filter(Boolean).join(' ') || undefined;
  const readOnly = pending;

  return (
    <Card>
      <h2>🎯 Savings goals</h2>

      <div id="goals-list" tabIndex={-1}>
        <h3 ref={listHeading} tabIndex={-1} className="goals-list-title">Your goals</h3>
        {aggregate && (
          <OutcomeCard
            key={aggregate.id}
            outcome={aggregate}
            title="Goal outcomes"
            headingLevel={4}
            retrying={recalculating}
            onRetry={onRecalculate}
          />
        )}
        <RegionBoundary
          regionKey="goal-list"
          label="Goal list"
          hasData={!!goals}
          loading={list.loading}
          error={list.error}
          onRetry={() => { void list.reload(); }}
          minHeight={120}
        >
          {goals && goals.length === 0 ? (
            <p className="muted small">
              You have no goals yet. Add one below to see how much to set aside each month.
            </p>
          ) : (
            <ul className="list">
              {goals?.map((goal) => (
                <GoalItem
                  key={goal.id}
                  goal={goal}
                  outcome={findGoalOutcome(snapshot, goal.id)}
                  snapshotReady={!!snapshot}
                  snapshotLoading={snapshotLoading}
                  snapshotError={snapshotError}
                  onRefresh={onRefresh}
                  month={month}
                  today={today}
                  gated={gated}
                  changes={changes}
                  arrival={arrival}
                  retrying={recalculating}
                  onRecalculate={onRecalculate}
                  onRemoved={() => setRemovedCount((count) => count + 1)}
                />
              ))}
            </ul>
          )}
        </RegionBoundary>
      </div>

      {/* The inputs follow the outcomes. Their purpose explanation and preview sit above the first field. */}
      <h3 className="goals-form-title">Add a goal</h3>
      <PurposeExplanation input="goal" />
      <InputBenefitPreview input="goal" confirmed={confirmedState} />

      <form id="goal-form" tabIndex={-1} onSubmit={create} noValidate aria-label="Add a goal" className="stack-sm goal-form" style={{ marginTop: '0.6rem' }}>
        <Field label="Goal name">
          <input
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            maxLength={60}
            placeholder="e.g. Laptop upgrade"
            readOnly={readOnly}
            {...fieldErrorProps(`${ids}-name-error`, !!errors.name)}
            aria-describedby={describedBy('name', ['purpose-goal', 'benefit-goal', gated ? DATA_USE_REASON_ID : ''])}
          />
        </Field>
        <Problem id={`${ids}-name-error`} problem={errors.name} />
        <div className="row-sm" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
          <Field label="Target amount">
            <input
              value={draft.target}
              onChange={(event) => setDraft({ ...draft, target: event.target.value })}
              inputMode="decimal"
              placeholder="60000"
              maxLength={20}
              readOnly={readOnly}
              {...fieldErrorProps(`${ids}-target-error`, !!errors.target)}
              aria-describedby={describedBy('target')}
            />
          </Field>
          <Field label="Saved so far (optional)">
            <input
              value={draft.saved}
              onChange={(event) => setDraft({ ...draft, saved: event.target.value })}
              inputMode="decimal"
              placeholder="0"
              maxLength={20}
              readOnly={readOnly}
              {...fieldErrorProps(`${ids}-saved-error`, !!errors.saved)}
              aria-describedby={describedBy('saved')}
            />
          </Field>
          <Field label="Target date">
            <input
              type="date"
              value={draft.date}
              min={today}
              onChange={(event) => setDraft({ ...draft, date: event.target.value })}
              readOnly={readOnly}
              {...fieldErrorProps(`${ids}-date-error`, !!errors.date)}
              aria-describedby={describedBy('date')}
            />
          </Field>
        </div>
        <Problem id={`${ids}-target-error`} problem={errors.target} />
        <Problem id={`${ids}-saved-error`} problem={errors.saved} />
        <Problem id={`${ids}-date-error`} problem={errors.date} />
        <Problem id={`${ids}-form-error`} problem={errors.form} />
        <button
          className="btn primary"
          type="submit"
          disabled={gated}
          aria-disabled={pending || undefined}
          aria-describedby={gated ? DATA_USE_REASON_ID : statusId}
        >
          Add goal
        </button>
        {/* The visible reason lives in the data-use notice; the button points at it. */}
        {gated && <span className="sr-only">New entries are paused. See the data-use notice for the reason.</span>}
      </form>
      {conflict && <p role="alert" className="clarity-field-error">{CONFLICT_TEXT}</p>}
      <ScopedMutationStatus scopeKey={CREATE_SCOPE} id={statusId} onRetry={changes.retry} />
    </Card>
  );
}

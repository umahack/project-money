import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { GoalOutcomeValue, Outcome } from '../../clarity/contracts';
import { useMutationStatus } from '../../clarity/MutationStatusProvider';
import type { FieldProblem } from '../../clarity/planInputs';
import { amountToInput } from '../../money';
import { DATA_USE_REASON_ID } from '../clarity/DataUseGate';
import { FieldError, fieldErrorProps } from '../clarity/FieldError';
import { formatMoney } from '../clarity/format';
import { RegionBoundary } from '../clarity/RegionBoundary';
import { ScopedMutationStatus } from '../clarity/ScopedMutationStatus';
import type { OutcomeRetry } from '../clarity/OutcomeCard';
import { Field } from '../ui';
import { GoalOutcomeCard } from './GoalOutcome';
import {
  CONTRIBUTION_FORMAT_PROBLEM,
  describeServerProblem,
  displayDate,
  invalidGoalFields,
  parseContribution,
  validateGoalEdit,
  type GoalDraftText,
  type GoalField,
  type GoalProblemKey,
  type GoalView,
} from './goalInputs';
import { CONFLICT_TEXT, type GoalChanges } from './useGoalChanges';
import './goals.css';

/** The action link that opened the page, as read from the URL by `useActionArrival`. */
export interface GoalArrival {
  action: string | null;
  goalId?: number;
  /** Changes each time a link is followed, so the same link can arrive again. */
  key: string;
}

type Panel = 'contribute' | 'edit' | 'delete' | null;

function Problem({ id, problem }: { id: string; problem: FieldProblem | undefined }) {
  return problem ? <FieldError id={id} field={problem.field} reason={problem.reason} correction={problem.correction} /> : null;
}

function draftFor(goal: GoalView): GoalDraftText {
  return {
    name: goal.name,
    target: goal.targetMinor === null ? '' : amountToInput(goal.targetMinor / 100),
    saved: goal.savedMinor === null ? '' : amountToInput(goal.savedMinor / 100),
    date: goal.targetDate ?? '',
  };
}

export interface GoalItemProps {
  goal: GoalView;
  outcome: Outcome<GoalOutcomeValue> | undefined;
  /** A confirmed snapshot exists. A goal without an outcome then says so instead of showing a skeleton. */
  snapshotReady: boolean;
  snapshotLoading: boolean;
  snapshotError: unknown;
  onRefresh: () => void;
  month: string;
  /** The server's current local date. */
  today: string;
  /** New entries are paused by the data-use gate. Corrections and deletes are never paused. */
  gated: boolean;
  changes: GoalChanges;
  arrival: GoalArrival;
  retrying: boolean;
  onRecalculate: (retry: OutcomeRetry) => void | Promise<void>;
  /** The goal is gone from the list once its delete is confirmed. */
  onRemoved: () => void;
}

/**
 * One saved goal with its server outcome, bounded contribution form, correction
 * form, delete, and status. Its mutation scope is `goal:<id>`, so a change to
 * this goal never blocks another goal, the create form, or the rest of the page.
 * Every form keeps what the user typed when a save fails.
 */
export function GoalItem({
  goal,
  outcome,
  snapshotReady,
  snapshotLoading,
  snapshotError,
  onRefresh,
  month,
  today,
  gated,
  changes,
  arrival,
  retrying,
  onRecalculate,
  onRemoved,
}: GoalItemProps) {
  const ids = useId();
  const scope = `goal:${goal.id}`;
  const status = useMutationStatus(scope);
  const pending = status?.phase === 'pending';
  const conflict = changes.conflicts.has(scope);
  const statusId = `${ids}-status`;

  const rowRef = useRef<HTMLLIElement>(null);
  const openers = {
    contribute: useRef<HTMLButtonElement>(null),
    edit: useRef<HTMLButtonElement>(null),
    delete: useRef<HTMLButtonElement>(null),
  };
  const [panel, setPanel] = useState<Panel>(null);
  const [returnFocus, setReturnFocus] = useState<Exclude<Panel, null> | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  const focusField = useRef<GoalField | 'contribution'>('contribution');

  const [contribution, setContribution] = useState('');
  const [contributionProblem, setContributionProblem] = useState<FieldProblem | undefined>();
  const [draft, setDraft] = useState<GoalDraftText>(() => draftFor(goal));
  const [problems, setProblems] = useState<Partial<Record<GoalProblemKey, FieldProblem>>>({});

  const value = outcome?.status === 'available' ? outcome.value : undefined;
  const gap = value?.fundingGap.amountMinor;
  const funded = gap === 0;
  const needsCorrection = outcome?.status === 'invalid_input';
  const showContribute = !funded && !needsCorrection;
  const invalid = invalidGoalFields(outcome);

  function open(next: Exclude<Panel, null>, field: GoalField | 'contribution' = 'contribution') {
    if (next === 'contribute') {
      setContribution('');
      setContributionProblem(undefined);
    }
    if (next === 'edit') {
      setDraft(draftFor(goal));
      setProblems({});
    }
    focusField.current = field;
    setPanel(next);
    setFocusTick((tick) => tick + 1);
  }

  function close(from: Exclude<Panel, null>) {
    setPanel(null);
    setReturnFocus(from);
  }

  // Focus follows an opened panel, and returns to its opener when the panel closes.
  useEffect(() => {
    if (!panel || focusTick === 0) return;
    const root = rowRef.current;
    const selector = panel === 'delete' ? '[data-goal-focus]' : `[data-goal-field="${focusField.current}"]`;
    root?.querySelector<HTMLElement>(selector)?.focus();
  }, [panel, focusTick]);
  useEffect(() => {
    if (panel !== null || !returnFocus) return;
    // Focus the user has since placed in another part of the page stays where they put it.
    const active = document.activeElement;
    if (!active || active === document.body || rowRef.current?.contains(active)) {
      // A contribution can fund the goal, which removes its opener. Focus then goes to the next control, never to the page.
      (openers[returnFocus].current ?? openers.edit.current ?? rowRef.current)?.focus();
    }
    setReturnFocus(null);
    // The opener refs are stable objects, so they are not dependencies.
  }, [panel, returnFocus]);

  // An action link for this goal opens its form and focuses it, once the outcome shows the goal can take that action.
  const handledArrival = useRef<string | null>(null);
  const canContributeNow = !!value && (gap ?? 0) > 0 && !gated;
  useEffect(() => {
    if (arrival.goalId !== goal.id || !arrival.action || handledArrival.current === arrival.key) return;
    let target: { panel: Exclude<Panel, null>; field: GoalField | 'contribution' } | null = null;
    if (arrival.action === 'contribute' && canContributeNow) target = { panel: 'contribute', field: 'contribution' };
    else if (arrival.action === 'revise' && outcome) target = { panel: 'edit', field: invalid[0] ?? (value?.feasibility === 'overdue' ? 'date' : 'target') };
    if (!target) return;
    handledArrival.current = arrival.key;
    // Never take focus the user has already placed in another part of the page.
    const active = document.activeElement;
    const mayFocus = !active || active === document.body || !!rowRef.current?.contains(active)
      || active.id === 'goals-list';
    if (target.panel === 'contribute') {
      setContribution('');
      setContributionProblem(undefined);
    } else {
      setDraft(draftFor(goal));
      setProblems({});
    }
    focusField.current = target.field;
    setPanel(target.panel);
    if (mayFocus) setFocusTick((tick) => tick + 1);
    // `goal` and `invalid` are read once, when the link arrives.
  }, [arrival.key, arrival.action, arrival.goalId, goal.id, canContributeNow, !!outcome]);

  function submitContribution(event: FormEvent) {
    event.preventDefault();
    if (pending || gated) return;
    const minor = parseContribution(contribution);
    if (minor === null) {
      setContributionProblem(CONTRIBUTION_FORMAT_PROBLEM);
      return;
    }
    setContributionProblem(undefined);
    const version = changes.versionOf(goal.id);
    void changes.run({
      scopeKey: scope,
      label: `Add contribution to ${goal.name}`,
      path: `/finance/goals/${goal.id}/contributions`,
      method: 'POST',
      body: { contributionMinor: minor, ...(version === undefined ? {} : { expectedRecordVersion: version }) },
      months: [month],
    }, {
      goalId: goal.id,
      showsValidation: true,
      onSettled: (result) => {
        if (result.outcome === 'confirmed') {
          setContribution('');
          close('contribute');
        } else if (result.outcome === 'failed') {
          const problem = describeServerProblem(result.error);
          if (problem) setContributionProblem(problem.problem);
        }
      },
    });
  }

  function submitEdit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    const checked = validateGoalEdit(draft, goal, today);
    if (!checked.body) {
      setProblems(checked.unchanged
        ? { form: { field: 'This goal', reason: 'has no changes to save.', correction: 'Change at least one field, or choose Cancel.' } }
        : checked.errors);
      return;
    }
    setProblems({});
    const version = changes.versionOf(goal.id);
    void changes.run({
      scopeKey: scope,
      label: `Save ${goal.name}`,
      path: `/finance/goals/${goal.id}`,
      method: 'PATCH',
      body: { ...checked.body, ...(version === undefined ? {} : { expectedRecordVersion: version }) },
      months: [month],
    }, {
      goalId: goal.id,
      showsValidation: true,
      onSettled: (result) => {
        if (result.outcome === 'confirmed') close('edit');
        else if (result.outcome === 'failed') {
          const problem = describeServerProblem(result.error);
          if (problem) setProblems({ [problem.key === 'contribution' ? 'form' : problem.key]: problem.problem });
        }
      },
    });
  }

  function acceptRevision(revision: NonNullable<GoalOutcomeValue['revision']>) {
    if (pending) return;
    const version = changes.versionOf(goal.id);
    void changes.run({
      scopeKey: scope,
      label: `Accept revised target for ${goal.name}`,
      path: `/finance/goals/${goal.id}`,
      method: 'PATCH',
      body: {
        ...(revision.targetAmount ? { targetAmountMinor: revision.targetAmount.amountMinor } : {}),
        ...(revision.targetDate ? { targetDate: revision.targetDate } : {}),
        ...(version === undefined ? {} : { expectedRecordVersion: version }),
      },
      months: [month],
    }, { goalId: goal.id });
  }

  function confirmDelete() {
    if (pending) return;
    const version = changes.versionOf(goal.id);
    void changes.run({
      scopeKey: scope,
      label: `Delete ${goal.name}`,
      path: `/finance/goals/${goal.id}`,
      method: 'DELETE',
      body: version === undefined ? {} : { expectedRecordVersion: version },
      months: [month],
    }, {
      goalId: goal.id,
      onSettled: (result) => {
        if (result.outcome === 'confirmed') onRemoved();
      },
    });
  }

  const contributionErrorId = `${ids}-contribution-error`;
  const contributionHintId = `${ids}-contribution-hint`;
  const contributionDescribed = [contributionHintId, contributionProblem ? contributionErrorId : '', gated ? DATA_USE_REASON_ID : '']
    .filter(Boolean).join(' ');
  const editField = (field: GoalField) => ({
    'data-goal-field': field,
    readOnly: pending,
    ...fieldErrorProps(`${ids}-${field}-error`, !!problems[field]),
  });

  return (
    <li
      ref={rowRef}
      id={`goal-${goal.id}`}
      tabIndex={-1}
      className={`list-item goal-item${pending ? ' is-pending' : ''}`}
      data-goal-id={goal.id}
    >
      <div className="goal-head">
        <span className="avatar" aria-hidden="true">{funded ? '✅' : '🎯'}</span>
        <div className="grow">
          <strong>{goal.name}</strong>
          <small className="muted">{goal.targetDate ? `Target date ${displayDate(goal.targetDate)}` : 'No target date'}</small>
        </div>
        <div className="goal-actions">
          {showContribute && (
            <button
              ref={openers.contribute}
              type="button"
              className="btn sm"
              disabled={gated}
              aria-disabled={pending || undefined}
              aria-expanded={panel === 'contribute'}
              aria-describedby={gated ? DATA_USE_REASON_ID : statusId}
              aria-label={`Add contribution to ${goal.name}`}
              onClick={() => {
                if (pending) return;
                if (panel === 'contribute') close('contribute');
                else open('contribute');
              }}
            >
              + Add
            </button>
          )}
          <button
            ref={openers.edit}
            type="button"
            className="btn sm ghost"
            aria-disabled={pending || undefined}
            aria-expanded={panel === 'edit'}
            aria-describedby={statusId}
            aria-label={`Edit ${goal.name}`}
            onClick={() => {
              if (pending) return;
              if (panel === 'edit') close('edit');
              else open('edit', invalid[0] ?? 'name');
            }}
          >
            ✏
          </button>
          <button
            ref={openers.delete}
            type="button"
            className="btn sm ghost"
            aria-disabled={pending || undefined}
            aria-expanded={panel === 'delete'}
            aria-describedby={statusId}
            aria-label={`Delete ${goal.name}`}
            onClick={() => {
              if (pending) return;
              open('delete');
            }}
          >
            ✕
          </button>
        </div>
      </div>
      {gated && showContribute && <span className="sr-only">New contributions are paused. See the data-use notice for the reason.</span>}

      <RegionBoundary
        regionKey={`goal-outcome-${goal.id}`}
        label={`Outcome for ${goal.name}`}
        hasData={!!outcome || snapshotReady}
        loading={snapshotLoading}
        error={snapshotError}
        onRetry={onRefresh}
        minHeight={96}
      >
        {outcome ? (
          <GoalOutcomeCard
            goal={goal}
            outcome={outcome}
            month={month}
            today={today}
            refreshing={pending}
            retrying={retrying}
            onRetry={onRecalculate}
            busy={pending}
            onAcceptRevision={acceptRevision}
            onRevise={(field) => open('edit', field ?? 'target')}
          />
        ) : (
          <p className="small muted goal-no-outcome">
            The funding outcome for this goal is not available yet. Your saved values are kept.
          </p>
        )}
      </RegionBoundary>

      {panel === 'contribute' && (
        <form
          className="goal-panel"
          onSubmit={submitContribution}
          noValidate
          aria-label={`Add a contribution to ${goal.name}`}
        >
          <Field label="Contribution amount">
            <input
              value={contribution}
              onChange={(event) => setContribution(event.target.value)}
              inputMode="decimal"
              placeholder="e.g. 500"
              maxLength={20}
              readOnly={pending}
              data-goal-field="contribution"
              {...fieldErrorProps(contributionErrorId, !!contributionProblem)}
              aria-describedby={contributionDescribed}
            />
          </Field>
          <p id={contributionHintId} className="small muted">
            {value && gap !== undefined && gap > 0
              ? `Accepted range: ${formatMoney({ currency: 'INR', amountMinor: 1 })} to ${formatMoney(value.fundingGap)}, the amount still to fund. The server checks it when you save.`
              : 'The accepted range is the amount still to fund. The server checks it when you save.'}
          </p>
          <Problem id={contributionErrorId} problem={contributionProblem} />
          <div className="goal-actions">
            <button
              className="btn sm primary"
              type="submit"
              disabled={gated}
              aria-disabled={pending || undefined}
              aria-describedby={gated ? DATA_USE_REASON_ID : statusId}
            >
              Save contribution
            </button>
            <button type="button" className="btn sm ghost" onClick={() => close('contribute')}>Cancel</button>
          </div>
        </form>
      )}

      {panel === 'edit' && (
        <form className="goal-panel" onSubmit={submitEdit} noValidate aria-label={`Correct ${goal.name}`}>
          <Field label="Goal name">
            <input
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              maxLength={60}
              {...editField('name')}
            />
          </Field>
          <Problem id={`${ids}-name-error`} problem={problems.name} />
          <Field label="Target amount">
            <input
              value={draft.target}
              onChange={(event) => setDraft({ ...draft, target: event.target.value })}
              inputMode="decimal"
              maxLength={20}
              {...editField('target')}
            />
          </Field>
          <Problem id={`${ids}-target-error`} problem={problems.target} />
          <Field label="Saved so far">
            <input
              value={draft.saved}
              onChange={(event) => setDraft({ ...draft, saved: event.target.value })}
              inputMode="decimal"
              maxLength={20}
              {...editField('saved')}
            />
          </Field>
          <Problem id={`${ids}-saved-error`} problem={problems.saved} />
          <Field label="Target date">
            <input
              type="date"
              value={draft.date}
              min={today}
              onChange={(event) => setDraft({ ...draft, date: event.target.value })}
              {...editField('date')}
            />
          </Field>
          <Problem id={`${ids}-date-error`} problem={problems.date} />
          <Problem id={`${ids}-form-error`} problem={problems.form} />
          <div className="goal-actions">
            <button className="btn sm primary" type="submit" aria-disabled={pending || undefined} aria-describedby={statusId}>
              Save changes
            </button>
            <button type="button" className="btn sm ghost" onClick={() => close('edit')}>Cancel</button>
          </div>
        </form>
      )}

      {panel === 'delete' && (
        <div className="goal-panel" role="group" aria-label={`Delete ${goal.name}`}>
          <p>
            <strong>Delete “{goal.name}”?</strong> This removes the goal and its funding outcome. Your other goals are not changed.
          </p>
          <div className="goal-actions">
            <button
              type="button"
              className="btn sm danger"
              aria-disabled={pending || undefined}
              aria-describedby={statusId}
              onClick={confirmDelete}
            >
              Delete goal
            </button>
            <button type="button" className="btn sm ghost" data-goal-focus onClick={() => close('delete')}>Cancel</button>
          </div>
        </div>
      )}

      {conflict && <p role="alert" className="clarity-field-error goal-wide">{CONFLICT_TEXT}</p>}
      <ScopedMutationStatus scopeKey={scope} id={statusId} className="goal-wide" onRetry={changes.retry} />
    </li>
  );
}

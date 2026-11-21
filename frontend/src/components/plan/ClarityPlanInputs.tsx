import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import type { FinancialSnapshot, PlanDeltas } from '../../clarity/contracts';
import { useDataUseGate } from '../../clarity/DataUseGateProvider';
import { useMutationRunner, useMutationStatus } from '../../clarity/MutationStatusProvider';
import type { MutationCommand, MutationSubmitResult } from '../../clarity/mutationStatusStore';
import {
  BILL_CATEGORIES,
  SALARY_PROBLEM,
  billCreatePatch,
  billUpdatePatch,
  describeBillPeriod,
  parseMinor,
  planConfirmedState,
  salaryPatch,
  selectConfirmedSalary,
  selectCountedBills,
  validateBillFields,
  type BillDraftValues,
  type BillField,
  type CountedBill,
  type FieldProblem,
} from '../../clarity/planInputs';
import type { PurposeOutcomeKey } from '../../clarity/purposeRegistry';
import { queryKeys } from '../../clarity/queryClient';
import { useMeasurement } from '../../hooks/useMeasurement';
import { amountToInput, inr, monthLabel, toPaise } from '../../money';
import type { Emi } from '../../types';
import { DATA_USE_REASON_ID } from '../clarity/DataUseGate';
import { FieldError, fieldErrorProps } from '../clarity/FieldError';
import { InputBenefitPreview } from '../clarity/InputBenefitPreview';
import { PurposeExplanation } from '../clarity/PurposeExplanation';
import { ScopedMutationStatus } from '../clarity/ScopedMutationStatus';
import { Card, Field } from '../ui';
import './plan.css';

const CAT_ICON: Record<string, string> = { EMI: '🏦', Rent: '🏠', Utility: '💡', Insurance: '🛡️', Subscription: '📺', Other: '📌' };
const CONFLICT_TEXT = 'This was changed somewhere else, so it was not saved. Your entry is kept. Save again to replace the other change with yours.';

/** What the Plan page shows after a salary or bill change is confirmed. */
export interface ConfirmedPlanChange {
  scopeKey: string;
  /** Plain text such as "Pay saved". */
  label: string;
  changeId: number;
  /** Disposable income and daily guide differences, calculated by the server. */
  deltas: PlanDeltas | undefined;
}

export interface ClarityPlanInputsProps {
  month: string;
  /** Newest confirmed snapshot with pending patches applied. */
  snapshot: FinancialSnapshot | undefined;
  onConfirmed?: (change: ConfirmedPlanChange) => void;
  /** Re-reads the confirmed snapshot, for example after a conflict. */
  onRefresh?: () => void;
  /** Shows one form only. The guided journey hosts the pay form alone. Both forms show by default. */
  only?: 'salary' | 'bills';
  /**
   * Presents the one hosted form as an optional input with a skip, as the guided
   * journey does after the first result. Skipping saves nothing; the caller
   * decides what the skip does. Only meaningful with `only`.
   */
  optional?: OptionalInput;
}

export interface OptionalInput {
  /** The outcome that stays as it is when the input is skipped. */
  skipOutcome?: PurposeOutcomeKey;
  onSkip: () => void;
  /** Controls the skipped state of the purpose panel. */
  skipped?: boolean;
}

interface RunOptions {
  /** Text for the confirmed-change notice. */
  doneLabel: string;
  /** Record whose version this change moves, so the next change can send it. */
  versionKey?: string;
  /** Runs after the first attempt and after every retry of this scope settles, so a retry finishes the same way. */
  onSettled?: (result: MutationSubmitResult) => void;
}

interface PlanChanges {
  run(command: MutationCommand, options: RunOptions): Promise<MutationSubmitResult>;
  /** Retries a failed scope with its original request, then settles it exactly as the first attempt would have. */
  retry(scopeKey: string): Promise<MutationSubmitResult>;
  versionOf(type: 'salary' | 'bill', id: number | null | undefined): number | undefined;
  salaryRecordId(): number | null;
  conflicts: ReadonlySet<string>;
  deleting: ReadonlySet<number>;
  setDeleting(id: number, deleting: boolean): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Runs each salary or bill change through the scoped mutation runner and keeps
 * what a later change needs: the record version it should expect, the saved bill
 * list, and the conflict state. Nothing here blocks the page.
 */
function usePlanChanges({ onConfirmed, onRefresh }: Pick<ClarityPlanInputsProps, 'onConfirmed' | 'onRefresh'>): PlanChanges {
  const runner = useMutationRunner();
  const queryClient = useQueryClient();
  const measurement = useMeasurement();
  const versions = useRef(new Map<string, number>());
  const salaryId = useRef<number | null>(null);
  const [conflicts, setConflicts] = useState<ReadonlySet<string>>(() => new Set());
  const [deleting, setDeletingState] = useState<ReadonlySet<number>>(() => new Set());
  const handlers = useRef({ onConfirmed, onRefresh, measurement });
  handlers.current = { onConfirmed, onRefresh, measurement };

  const setDeleting = useCallback((id: number, value: boolean) => {
    setDeletingState((current) => {
      if (current.has(id) === value) return current;
      const next = new Set(current);
      if (value) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  // What each scope's latest attempt needs once it settles, so Retry can finish it the same way.
  const attempts = useRef(new Map<string, RunOptions>());

  const settle = useCallback((scopeKey: string, options: RunOptions, result: MutationSubmitResult) => {
    if (result.outcome === 'confirmed') {
      const { mutation } = result.envelope;
      if (mutation.recordType && typeof mutation.recordId === 'number') {
        versions.current.set(`${mutation.recordType}:${mutation.recordId}`, mutation.recordVersion);
        if (mutation.recordType === 'salary') salaryId.current = mutation.recordId;
      }
      if (mutation.recordType === 'bill') {
        // Keep the saved-bill list current without re-reading it.
        const record = mutation.record;
        queryClient.setQueryData<{ emis: Emi[] } | undefined>(queryKeys.bills(), (current) => {
          if (!current) return current;
          const id = mutation.recordId;
          if (mutation.operation === 'bill.delete') return { emis: current.emis.filter((bill) => bill.id !== id) };
          if (
            isRecord(record)
            && typeof record.id === 'number'
            && typeof record.label === 'string'
            && typeof record.category === 'string'
            && Number.isSafeInteger(record.amountMinor)
          ) {
            const row: Emi = {
              id: record.id,
              label: record.label,
              amount: (record.amountMinor as number) / 100,
              category: record.category,
            };
            const exists = current.emis.some((bill) => bill.id === row.id);
            return { emis: exists ? current.emis.map((bill) => (bill.id === row.id ? row : bill)) : [row, ...current.emis] };
          }
          return current;
        });
      }
      handlers.current.onConfirmed?.({
        scopeKey,
        label: options.doneLabel,
        changeId: mutation.changeId,
        deltas: mutation.planDeltas,
      });
      // Reports what this page did for the change: nothing reloaded and no page-wide loading.
      handlers.current.measurement.financialChangeUi({
        changeId: mutation.changeId,
        causedReload: false,
        causedPageWideLoading: false,
      });
    } else if (result.outcome === 'failed' && result.error.status === 409) {
      // Someone else changed this record. Keep the draft, drop the stale version, and re-read.
      if (options.versionKey) versions.current.delete(options.versionKey);
      runner.dismiss(scopeKey);
      setConflicts((current) => new Set(current).add(scopeKey));
      handlers.current.onRefresh?.();
    }
    options.onSettled?.(result);
  }, [queryClient, runner]);

  const clearConflict = useCallback((scopeKey: string) => {
    setConflicts((current) => {
      if (!current.has(scopeKey)) return current;
      const next = new Set(current);
      next.delete(scopeKey);
      return next;
    });
  }, []);

  const run = useCallback(async (command: MutationCommand, options: RunOptions) => {
    attempts.current.set(command.scopeKey, options);
    // The pending acknowledgement is registered inside submit(), before any await in this function.
    clearConflict(command.scopeKey);
    const result = await runner.submit(command);
    settle(command.scopeKey, options, result);
    return result;
  }, [clearConflict, runner, settle]);

  const retry = useCallback(async (scopeKey: string) => {
    const options = attempts.current.get(scopeKey);
    clearConflict(scopeKey);
    const result = await runner.retry(scopeKey);
    if (options && result.outcome !== 'not_retryable') settle(scopeKey, options, result);
    return result;
  }, [clearConflict, runner, settle]);

  return useMemo<PlanChanges>(() => ({
    run,
    retry,
    versionOf: (type, id) => (id === null || id === undefined ? undefined : versions.current.get(`${type}:${id}`)),
    salaryRecordId: () => salaryId.current,
    conflicts,
    deleting,
    setDeleting,
  }), [run, retry, conflicts, deleting, setDeleting]);
}

function Problem({ id, problem }: { id: string; problem: FieldProblem | undefined }) {
  return problem ? <FieldError id={id} field={problem.field} reason={problem.reason} correction={problem.correction} /> : null;
}

function GateNote({ gated }: { gated: boolean }) {
  // The visible reason lives in the data-use notice; the button points at it.
  return gated ? <span className="sr-only">New entries are paused. See the data-use notice for the reason.</span> : null;
}

/* ---------------------------------- Pay ---------------------------------- */

function SalaryCard({ month, snapshot, changes, optional }: { month: string; snapshot: FinancialSnapshot | undefined; changes: PlanChanges; optional?: OptionalInput }) {
  const gate = useDataUseGate();
  const ids = useId();
  const scope = `salary:${month}`;
  const status = useMutationStatus(scope);
  const pending = status?.phase === 'pending';
  const conflict = changes.conflicts.has(scope);

  const confirmed = selectConfirmedSalary(snapshot, month);
  const confirmedText = confirmed ? amountToInput(confirmed.amountMinor / 100) : '';
  const [draft, setDraft] = useState(confirmedText);
  const [dirty, setDirty] = useState(false);
  const [problem, setProblem] = useState<FieldProblem | undefined>();
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // Follow the confirmed value until the user types. A failure never clears what they typed.
  useEffect(() => {
    if (!dirty) setDraft(confirmedText);
  }, [confirmedText, dirty]);

  // A first salary is a new input. Changing a saved salary is a correction and is never paused.
  const gated = !confirmed && !gate.financialInputsEnabled;
  const monthName = monthLabel(month);
  const confirmedPlanState = useMemo(() => planConfirmedState(snapshot, month), [snapshot, month]);

  const latest = useQuery({
    queryKey: queryKeys.latestSalary(),
    queryFn: () => api.get<{ salary: { month: string; amount: number } | null }>('/finance/salary'),
  });
  const prior = !confirmed && latest.data?.salary && /^\d{4}-\d{2}$/.test(latest.data.salary.month) && latest.data.salary.month < month
    ? latest.data.salary
    : null;
  const applyGated = !gate.financialInputsEnabled;

  const statusId = `${ids}-status`;
  const errorId = `${ids}-error`;
  const serverFieldError = status?.phase === 'error' && (status.error.field === 'amountMinor' || status.error.field === 'amount');
  const describedBy = ['purpose-salary', 'benefit-salary', statusId, problem ? errorId : '', gated ? DATA_USE_REASON_ID : '']
    .filter(Boolean).join(' ');

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || gated) return;
    const minor = parseMinor(draft, { allowZero: true });
    if (minor === null) {
      setProblem(SALARY_PROBLEM);
      return;
    }
    setProblem(undefined);
    const submitted = draft;
    const id = changes.salaryRecordId();
    const version = changes.versionOf('salary', id);
    void changes.run({
      scopeKey: scope,
      label: 'Save pay',
      path: '/finance/salary',
      method: 'POST',
      body: { month, amountMinor: minor, ...(version === undefined ? {} : { expectedRecordVersion: version }) },
      patch: salaryPatch(month, minor),
      months: [month],
    }, {
      doneLabel: 'Pay saved',
      versionKey: id === null ? undefined : `salary:${id}`,
      onSettled: (result) => {
        if (result.outcome === 'confirmed' && draftRef.current === submitted) setDirty(false);
      },
    });
  }

  function apply() {
    if (!prior || pending || applyGated) return;
    const id = changes.salaryRecordId();
    const sourceName = monthLabel(prior.month);
    void changes.run({
      scopeKey: scope,
      label: `Apply ${sourceName} pay`,
      path: '/finance/salary/apply',
      method: 'POST',
      body: { sourceMonth: prior.month, targetMonth: month },
      patch: salaryPatch(month, toPaise(prior.amount)),
      months: [month],
    }, {
      doneLabel: `${sourceName} pay applied to ${monthName}`,
      versionKey: id === null ? undefined : `salary:${id}`,
      onSettled: (result) => {
        if (result.outcome === 'confirmed') setDirty(false);
      },
    });
  }

  return (
    <Card>
      <h2 id="pay-form" tabIndex={-1}>💰 Monthly pay for {monthName}</h2>
      <PurposeExplanation
        input="salary"
        {...(optional ? { asOptional: { skipOutcome: optional.skipOutcome }, onSkip: optional.onSkip, skipped: optional.skipped ?? false } : {})}
      />
      <InputBenefitPreview input="salary" confirmed={confirmedPlanState} />

      {prior && (
        <div className="plan-prior-salary" role="group" aria-label="Use an earlier month's pay">
          <p className="small">
            Your latest saved pay is <strong>{inr(prior.amount)}</strong> for <strong>{monthLabel(prior.month)}</strong>.
            It is not counted in {monthName} unless you apply it.
          </p>
          <button
            type="button"
            className="btn sm"
            aria-disabled={pending || undefined}
            disabled={applyGated}
            aria-describedby={applyGated ? DATA_USE_REASON_ID : statusId}
            onClick={apply}
          >
            Use {monthLabel(prior.month)} pay for {monthName}
          </button>
        </div>
      )}

      <form onSubmit={save} className="salary-form" noValidate>
        <div className="input-prefix">
          <span aria-hidden="true">₹</span>
          <input
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setDirty(true);
            }}
            inputMode="decimal"
            placeholder="75,000"
            aria-label="Monthly pay"
            maxLength={16}
            {...fieldErrorProps(errorId, !!problem || serverFieldError)}
            aria-describedby={describedBy}
          />
        </div>
        <button
          className="btn primary"
          type="submit"
          disabled={gated}
          aria-disabled={pending || undefined}
          aria-describedby={gated ? DATA_USE_REASON_ID : statusId}
        >
          Save pay for {monthName}
        </button>
        <GateNote gated={gated} />
      </form>
      <Problem id={errorId} problem={problem} />
      {conflict && <p role="alert" className="clarity-field-error">{CONFLICT_TEXT}</p>}
      <p className="small muted">This saves your pay for {monthName} only.</p>
      <ScopedMutationStatus scopeKey={scope} id={statusId} onRetry={changes.retry} />
    </Card>
  );
}

/* ---------------------------------- Bills --------------------------------- */

function MonthInput({
  label,
  value,
  onChange,
  problem,
  problemId,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  problem: FieldProblem | undefined;
  problemId: string;
  hint: string;
}) {
  return (
    <div>
      <Field label={label} hint={hint}>
        <input
          type="month"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="YYYY-MM"
          {...fieldErrorProps(problemId, !!problem)}
        />
      </Field>
      <Problem id={problemId} problem={problem} />
    </div>
  );
}

function BillRow({
  bill,
  category,
  month,
  changes,
}: {
  bill: CountedBill;
  category: string | undefined;
  month: string;
  changes: PlanChanges;
}) {
  const ids = useId();
  const scope = `bill:${bill.id}`;
  const status = useMutationStatus(scope);
  const pending = status?.phase === 'pending';
  const conflict = changes.conflicts.has(scope);
  const [editing, setEditing] = useState(false);
  const [dLabel, setDLabel] = useState('');
  const [dAmount, setDAmount] = useState('');
  const [dCategory, setDCategory] = useState('');
  const [dCounted, setDCounted] = useState(true);
  const [dFrom, setDFrom] = useState('');
  const [dUntil, setDUntil] = useState('');
  const [errors, setErrors] = useState<Partial<Record<BillField | 'form', FieldProblem>>>({});
  const editButton = useRef<HTMLButtonElement>(null);
  const [returnFocus, setReturnFocus] = useState(false);
  const statusId = `${ids}-status`;

  useEffect(() => {
    if (!editing && returnFocus) {
      editButton.current?.focus();
      setReturnFocus(false);
    }
  }, [editing, returnFocus]);

  const monthName = (value: string) => monthLabel(value);

  if (bill.pending) {
    return (
      <li className="list-item">
        <span className="avatar" aria-hidden="true">⏳</span>
        <div className="grow">
          <strong>{bill.label}</strong>
          <small className="muted">Adding this bill…</small>
        </div>
        <b className="mono">{inr(bill.amount.amountMinor / 100)}</b>
      </li>
    );
  }

  function startEdit() {
    setDLabel(bill.label);
    setDAmount(amountToInput(bill.amount.amountMinor / 100));
    setDCategory(category ?? '');
    setDCounted(true);
    setDFrom(bill.effectiveFromMonth ?? '');
    setDUntil(bill.effectiveToMonth ?? '');
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
    const checked = validateBillFields({ label: dLabel, amount: dAmount, from: dFrom, until: dUntil }, { allowZeroAmount: true });
    if (!checked.values) {
      setErrors(checked.errors);
      return;
    }
    const values = checked.values;
    // Only changed fields are sent, so an unknown category or period is never overwritten.
    const body: Record<string, unknown> = { applicableMonth: month };
    const shown: Partial<BillDraftValues> = {};
    if (values.label !== bill.label) {
      body.label = values.label;
      shown.label = values.label;
    }
    if (values.amountMinor !== bill.amount.amountMinor) {
      body.amountMinor = values.amountMinor;
      shown.amountMinor = values.amountMinor;
    }
    if (dCategory && dCategory !== category) body.category = dCategory;
    if (!dCounted) body.active = false;
    if (values.effectiveFromMonth !== bill.effectiveFromMonth) {
      body.effectiveFromMonth = values.effectiveFromMonth;
      shown.effectiveFromMonth = values.effectiveFromMonth;
    }
    if (values.effectiveToMonth !== bill.effectiveToMonth) {
      body.effectiveToMonth = values.effectiveToMonth;
      shown.effectiveToMonth = values.effectiveToMonth;
    }
    if (Object.keys(body).length === 1) {
      setErrors({ form: { field: 'This bill', reason: 'has no changes to save.', correction: 'Change at least one field, or choose Cancel.' } });
      return;
    }
    setErrors({});
    const version = changes.versionOf('bill', bill.id);
    if (version !== undefined) body.expectedRecordVersion = version;
    void changes.run({
      scopeKey: scope,
      label: `Update ${bill.label}`,
      path: `/finance/emis/${bill.id}`,
      method: 'PATCH',
      body,
      patch: billUpdatePatch(month, bill.id, shown),
      months: [month],
    }, {
      doneLabel: 'Bill updated',
      versionKey: `bill:${bill.id}`,
      onSettled: (result) => {
        if (result.outcome === 'confirmed') {
          setEditing(false);
          setReturnFocus(true);
        }
      },
    });
  }

  function remove() {
    if (pending) return;
    const version = changes.versionOf('bill', bill.id);
    changes.setDeleting(bill.id, true);
    void changes.run({
      scopeKey: scope,
      label: `Delete ${bill.label}`,
      path: `/finance/emis/${bill.id}`,
      method: 'DELETE',
      body: { applicableMonth: month, ...(version === undefined ? {} : { expectedRecordVersion: version }) },
      months: [month],
    }, {
      doneLabel: 'Bill deleted',
      versionKey: `bill:${bill.id}`,
      onSettled: (result) => {
        if (result.outcome !== 'confirmed') changes.setDeleting(bill.id, false);
      },
    });
  }

  return (
    <li className="list-item plan-bill" data-bill-id={bill.id}>
      {editing ? (
        <form className="plan-bill-edit" onSubmit={save} noValidate aria-label={`Edit ${bill.label}`}>
          <Field label="Bill name">
            <input value={dLabel} onChange={(e) => setDLabel(e.target.value)} maxLength={60} {...fieldErrorProps(`${ids}-label`, !!errors.label)} />
          </Field>
          <Problem id={`${ids}-label`} problem={errors.label} />
          <Field label="Type">
            <select value={dCategory} onChange={(e) => setDCategory(e.target.value)}>
              {category === undefined && <option value="">Keep current type</option>}
              {BILL_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="₹ per month">
            <input value={dAmount} onChange={(e) => setDAmount(e.target.value)} inputMode="decimal" maxLength={16} {...fieldErrorProps(`${ids}-amount`, !!errors.amount)} />
          </Field>
          <Problem id={`${ids}-amount`} problem={errors.amount} />
          <MonthInput label="Counted from" hint="Leave empty to count from the start." value={dFrom} onChange={setDFrom} problem={errors.from} problemId={`${ids}-from`} />
          <MonthInput label="Counted until" hint="Leave empty for no end month." value={dUntil} onChange={setDUntil} problem={errors.until} problemId={`${ids}-until`} />
          <label className="plan-check">
            <input type="checkbox" checked={dCounted} onChange={(e) => setDCounted(e.target.checked)} />
            <span>Count this bill in my plan</span>
          </label>
          <Problem id={`${ids}-form`} problem={errors.form} />
          <div className="row" style={{ gap: '0.4rem' }}>
            <button className="btn primary sm" type="submit" aria-disabled={pending || undefined} aria-describedby={statusId}>Save changes</button>
            <button className="btn ghost sm" type="button" onClick={cancelEdit}>Cancel</button>
          </div>
        </form>
      ) : (
        <>
          <span className="avatar" aria-hidden="true">{CAT_ICON[category ?? ''] ?? '📌'}</span>
          <div className="grow">
            <strong>{bill.label}</strong>
            <small className="muted">
              {category ?? 'Type not loaded'} · {describeBillPeriod(bill.effectiveFromMonth, bill.effectiveToMonth, monthName)}
            </small>
          </div>
          <b className="mono">{inr(bill.amount.amountMinor / 100)}</b>
          <button ref={editButton} className="icon-btn" title={`Edit ${bill.label}`} aria-label={`Edit ${bill.label}`} aria-disabled={pending || undefined} onClick={() => { if (!pending) startEdit(); }}>✏️</button>
          <button className="icon-btn danger" aria-label={`Delete ${bill.label}`} aria-disabled={pending || undefined} onClick={remove}>🗑️</button>
        </>
      )}
      {conflict && <p role="alert" className="clarity-field-error plan-bill-wide">{CONFLICT_TEXT}</p>}
      <ScopedMutationStatus scopeKey={scope} id={statusId} className="plan-bill-wide" onRetry={changes.retry} />
    </li>
  );
}

function OtherBillRow({ emi, month, changes }: { emi: Emi; month: string; changes: PlanChanges }) {
  const scope = `bill:${emi.id}`;
  const status = useMutationStatus(scope);
  const pending = status?.phase === 'pending';
  const statusId = useId();
  const monthName = monthLabel(month);

  function count() {
    if (pending) return;
    const version = changes.versionOf('bill', emi.id);
    void changes.run({
      scopeKey: scope,
      label: `Count ${emi.label} in ${monthName}`,
      path: `/finance/emis/${emi.id}`,
      method: 'PATCH',
      body: { active: true, effectiveFromMonth: null, effectiveToMonth: null, applicableMonth: month, ...(version === undefined ? {} : { expectedRecordVersion: version }) },
      months: [month],
    }, { doneLabel: 'Bill counted', versionKey: `bill:${emi.id}` });
  }

  function remove() {
    if (pending) return;
    const version = changes.versionOf('bill', emi.id);
    changes.setDeleting(emi.id, true);
    void changes.run({
      scopeKey: scope,
      label: `Delete ${emi.label}`,
      path: `/finance/emis/${emi.id}`,
      method: 'DELETE',
      body: { applicableMonth: month, ...(version === undefined ? {} : { expectedRecordVersion: version }) },
      months: [month],
    }, {
      doneLabel: 'Bill deleted',
      versionKey: `bill:${emi.id}`,
      onSettled: (result) => {
        if (result.outcome !== 'confirmed') changes.setDeleting(emi.id, false);
      },
    });
  }

  return (
    <li className="list-item plan-bill" data-bill-id={emi.id}>
      <span className="avatar" aria-hidden="true">{CAT_ICON[emi.category] ?? '📌'}</span>
      <div className="grow">
        <strong>{emi.label}</strong>
        <small className="muted">{emi.category} · Saved, not counted in {monthName}</small>
      </div>
      <b className="mono">{inr(emi.amount)}</b>
      <button className="btn ghost sm" aria-disabled={pending || undefined} aria-describedby={statusId} onClick={count}>
        Count in {monthName}
      </button>
      <button className="icon-btn danger" aria-label={`Delete ${emi.label}`} aria-disabled={pending || undefined} onClick={remove}>🗑️</button>
      {changes.conflicts.has(scope) && <p role="alert" className="clarity-field-error plan-bill-wide">{CONFLICT_TEXT}</p>}
      <ScopedMutationStatus scopeKey={scope} id={statusId} className="plan-bill-wide" onRetry={changes.retry} />
    </li>
  );
}

function BillsCard({ month, snapshot, changes, optional }: { month: string; snapshot: FinancialSnapshot | undefined; changes: PlanChanges; optional?: OptionalInput }) {
  const gate = useDataUseGate();
  const ids = useId();
  const scope = 'new-bill:plan';
  const status = useMutationStatus(scope);
  const pending = status?.phase === 'pending';
  const [label, setLabel] = useState('');
  const [category, setCategory] = useState<string>('EMI');
  const [amount, setAmount] = useState('');
  const [from, setFrom] = useState('');
  const [until, setUntil] = useState('');
  const [errors, setErrors] = useState<Partial<Record<BillField, FieldProblem>>>({});
  const draftRef = useRef('');
  draftRef.current = JSON.stringify([label, category, amount, from, until]);
  const statusId = `${ids}-status`;
  const monthName = monthLabel(month);
  const gated = !gate.financialInputsEnabled;

  const saved = useQuery({
    queryKey: queryKeys.bills(),
    queryFn: () => api.get<{ emis: Emi[] }>('/finance/emis'),
  });
  const emis = useMemo(() => saved.data?.emis ?? [], [saved.data]);
  const categoryById = useMemo(() => new Map(emis.map((emi) => [emi.id, emi.category])), [emis]);
  const counted = selectCountedBills(snapshot, month);
  const countedIds = new Set(counted.map((bill) => bill.id));
  const notCounted = emis.filter((emi) => !countedIds.has(emi.id) && !changes.deleting.has(emi.id));
  const confirmedPlanState = useMemo(() => planConfirmedState(snapshot, month), [snapshot, month]);

  function add(event: FormEvent) {
    event.preventDefault();
    if (pending || gated) return;
    const checked = validateBillFields({ label, amount, from, until }, { allowZeroAmount: false });
    if (!checked.values) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    const values = checked.values;
    const submitted = draftRef.current;
    void changes.run({
      scopeKey: scope,
      label: 'Add bill',
      path: '/finance/emis',
      method: 'POST',
      body: {
        label: values.label,
        amountMinor: values.amountMinor,
        category,
        active: true,
        effectiveFromMonth: values.effectiveFromMonth,
        effectiveToMonth: values.effectiveToMonth,
        applicableMonth: month,
      },
      patch: billCreatePatch(month, values),
      months: [month],
    }, {
      doneLabel: 'Bill added',
      onSettled: (result) => {
        // Clear the form only when it still holds what was submitted.
        if (result.outcome === 'confirmed' && draftRef.current === submitted) {
          setLabel('');
          setAmount('');
          setFrom('');
          setUntil('');
          setCategory('EMI');
        }
      },
    });
  }

  const describedBy = (field: BillField) => [`${ids}-${field}-error`].filter(() => !!errors[field]).join(' ') || undefined;

  return (
    <Card>
      <h2 id="bills-form" tabIndex={-1}>📄 Monthly bills for {monthName} <small className="muted" style={{ fontWeight: 400 }}>(optional)</small></h2>
      <PurposeExplanation
        input="bill"
        {...(optional ? { onSkip: optional.onSkip, skipped: optional.skipped ?? false } : {})}
      />
      <InputBenefitPreview input="bill" confirmed={confirmedPlanState} />

      <form onSubmit={add} className="commit-form" noValidate aria-label="Add a bill">
        <Field label="What is it?">
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Netflix" maxLength={60} {...fieldErrorProps(`${ids}-label-error`, !!errors.label)} aria-describedby={describedBy('label')} />
        </Field>
        <Problem id={`${ids}-label-error`} problem={errors.label} />
        <Field label="Type">
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            {BILL_CATEGORIES.map((c) => <option key={c}>{c}</option>)}
          </select>
        </Field>
        <Field label="₹ per month">
          <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="649" maxLength={16} {...fieldErrorProps(`${ids}-amount-error`, !!errors.amount)} aria-describedby={describedBy('amount')} />
        </Field>
        <Problem id={`${ids}-amount-error`} problem={errors.amount} />
        <MonthInput label="Counted from" hint="Optional. Empty counts from the start." value={from} onChange={setFrom} problem={errors.from} problemId={`${ids}-from-error`} />
        <MonthInput label="Counted until" hint="Optional. Empty has no end month." value={until} onChange={setUntil} problem={errors.until} problemId={`${ids}-until-error`} />
        <div className="row">
          <button
            className="btn primary"
            type="submit"
            disabled={gated}
            aria-disabled={pending || undefined}
            aria-describedby={gated ? DATA_USE_REASON_ID : statusId}
          >
            + Add bill
          </button>
          <GateNote gated={gated} />
        </div>
      </form>
      <ScopedMutationStatus scopeKey={scope} id={statusId} onRetry={changes.retry} />

      <h3 className="plan-list-title">Counted in {monthName}</h3>
      {counted.length === 0 ? (
        <p className="muted small">No bills are counted for {monthName}.</p>
      ) : (
        <ul className="list">
          {counted.map((bill) => (
            <BillRow key={bill.id} bill={bill} category={categoryById.get(bill.id)} month={month} changes={changes} />
          ))}
        </ul>
      )}

      {notCounted.length > 0 && (
        <>
          <h3 className="plan-list-title">Saved but not counted in {monthName}</h3>
          <ul className="list">
            {notCounted.map((emi) => <OtherBillRow key={emi.id} emi={emi} month={month} changes={changes} />)}
          </ul>
        </>
      )}
      {saved.isError && (
        <p className="small muted" role="status">
          Other saved bills could not be loaded.{' '}
          <button type="button" className="btn ghost sm" onClick={() => { void saved.refetch(); }}>Retry loading saved bills</button>
        </p>
      )}
    </Card>
  );
}

/**
 * Pay and bills for the Plan page in the clarity branch. Each salary and each
 * bill is its own mutation scope: it has its own pending, success, and failure
 * text, its own retry, and its own rollback. Other controls stay usable, the
 * page never reloads, and a failed change keeps what the user typed.
 */
export function ClarityPlanInputs({ month, snapshot, onConfirmed, onRefresh, only, optional }: ClarityPlanInputsProps) {
  const changes = usePlanChanges({ onConfirmed, onRefresh });
  if (only === 'salary') return <div className="gap-top"><SalaryCard month={month} snapshot={snapshot} changes={changes} optional={optional} /></div>;
  if (only === 'bills') return <div className="gap-top"><BillsCard month={month} snapshot={snapshot} changes={changes} optional={optional} /></div>;
  return (
    <div className="grid two gap-top">
      <SalaryCard month={month} snapshot={snapshot} changes={changes} />
      <BillsCard month={month} snapshot={snapshot} changes={changes} />
    </div>
  );
}

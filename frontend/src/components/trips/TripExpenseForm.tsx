import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { ConfirmedState } from '../../clarity/purposeRegistry';
import type { FieldProblem } from '../../clarity/planInputs';
import { useMutationStatus } from '../../clarity/MutationStatusProvider';
import { inr, parseAmount, toPaise } from '../../money';
import type { TripMember } from '../../types';
import { DATA_USE_REASON_ID } from '../clarity/DataUseGate';
import { FieldError, fieldErrorProps } from '../clarity/FieldError';
import { InputBenefitPreview } from '../clarity/InputBenefitPreview';
import { PurposeExplanation } from '../clarity/PurposeExplanation';
import { ScopedMutationStatus } from '../clarity/ScopedMutationStatus';
import { Card, Empty, Field } from '../ui';
import { describeTripProblem, type ExpenseFormField } from './tripModel';
import type { TripChanges, TripDetailState } from './useTripChanges';
import type { TripMutationEnvelope } from '../../clarity/tripMutation';

type Problems = Partial<Record<ExpenseFormField, FieldProblem>>;

export interface TripExpenseFormProps {
  tripId: number;
  members: readonly TripMember[];
  changes: TripChanges;
  detail: TripDetailState;
  gated: boolean;
  confirmed: ConfirmedState;
}

/**
 * Adds a shared expense. Typed values are checked here only for the entries a
 * person can correct at once; the split itself is validated by the server, and a
 * rejected draft keeps every entered value, shows the correction beside the field,
 * and leaves the last confirmed balances untouched.
 */
export function TripExpenseForm({ tripId, members, changes, detail, gated, confirmed }: TripExpenseFormProps) {
  const ids = useId();
  const scopeKey = `new-trip-expense:${tripId}`;
  const status = useMutationStatus(scopeKey);
  const pending = status?.phase === 'pending';
  const names = members.map((member) => member.name);
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [payer, setPayer] = useState('');
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(names));
  const [custom, setCustom] = useState(false);
  const [shares, setShares] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Problems>({});
  const draftKey = JSON.stringify([description, amount, payer, [...chosen].sort(), custom, shares]);
  const draftRef = useRef(draftKey);
  draftRef.current = draftKey;

  // When the crew changes: forget removed names, select anyone newly added, and keep a valid payer.
  const known = useRef(new Set(names));
  useEffect(() => {
    const now = new Set(members.map((member) => member.name));
    setChosen((previous) => {
      const next = new Set([...previous].filter((name) => now.has(name)));
      now.forEach((name) => { if (!known.current.has(name)) next.add(name); });
      return next;
    });
    known.current = now;
    setPayer((current) => (current && now.has(current) ? current : members[0]?.name ?? ''));
  }, [members]);

  const total = parseAmount(amount || '0') ?? 0;
  const customSum = [...chosen].reduce((sum, name) => sum + toPaise(parseAmount(shares[name] || '0') ?? 0), 0);
  const toggle = (name: string) => setChosen((current) => {
    const next = new Set(current);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    return next;
  });

  function validate(): { body: { payer: string; description: string; amount: number; split: Array<{ name: string; share: number }> } } | { errors: Problems } {
    const found: Problems = {};
    const value = parseAmount(amount);
    if (!description.trim()) found.description = { field: 'What for', reason: 'is empty.', correction: 'Say what the expense was for, in up to 100 characters.' };
    if (value === null || value === 0) found.amount = { field: 'Amount', reason: 'is not an accepted amount.', correction: 'Enter an amount above zero such as 2400 or 2,400.50, with at most 2 decimals.' };
    if (!payer) found.payer = { field: 'Paid by', reason: 'is not chosen.', correction: 'Choose who paid.' };
    if (chosen.size === 0) found.split = { field: 'Split', reason: 'has nobody in it.', correction: 'Choose at least one person who shares this expense.' };
    else if (custom && value !== null && customSum !== toPaise(value)) {
      found.split = {
        field: 'Split',
        reason: `adds up to ${inr(customSum / 100)} but the bill is ${inr(value)}.`,
        correction: 'Change the shares so they add up to the bill.',
      };
    }
    const split = [...chosen]
      .map((name) => ({ name, share: custom ? parseAmount(shares[name] || '0') ?? 0 : 1 }))
      .filter((entry) => entry.share > 0);
    if (!found.split && split.length === 0) found.split = { field: 'Split', reason: 'gives nobody a share.', correction: 'Give at least one person a share above zero.' };
    if (Object.keys(found).length > 0 || value === null) return { errors: found };
    return { body: { payer, description: description.trim(), amount: value, split } };
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || gated) return;
    const checked = validate();
    if ('errors' in checked) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    const body = checked.body;
    const submitted = draftRef.current;
    void changes.run({
      scopeKey,
      label: 'Add expense',
      path: `/trips/${tripId}/expenses`,
      method: 'POST',
      body,
    }, {
      showsValidation: true,
      fallbackField: 'Expense',
      onSettled: (result) => {
        if (result.outcome === 'confirmed') {
          const envelope = result.envelope as TripMutationEnvelope;
          if (typeof envelope.id === 'number') {
            detail.addExpense({
              id: envelope.id,
              payer: body.payer,
              description: body.description,
              amount: body.amount,
              split: body.split,
              created_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
            });
          } else {
            void detail.reload();
          }
          // Clear the form only when it still holds what was submitted.
          if (draftRef.current === submitted) {
            setDescription('');
            setAmount('');
            setShares({});
          }
        } else if (result.outcome === 'failed') {
          const problem = describeTripProblem(result.error, 'Expense');
          if (problem && (result.error.status === 400 || result.error.status === 422)) {
            setErrors({ [problem.key]: problem.problem } as Problems);
          }
        }
      },
    });
  }

  if (members.length === 0) {
    return (
      <Card id="trip-expense-form" tabIndex={-1}>
        <h2>➕ Add an expense</h2>
        <Empty emoji="👥" title="Add your crew first" text="Add yourself and your friends in “Friends on this trip”, then you can split expenses." />
      </Card>
    );
  }

  const describedBy = (field: ExpenseFormField, extra: string[] = []) => [...extra, errors[field] ? `${ids}-${field}-error` : '']
    .filter(Boolean).join(' ') || undefined;
  const statusId = `${ids}-status`;

  return (
    <Card id="trip-expense-form" tabIndex={-1}>
      <h2>➕ Add an expense</h2>
      <PurposeExplanation input="trip" />
      <InputBenefitPreview input="trip" confirmed={confirmed} />
      <form onSubmit={submit} noValidate aria-label="Add an expense" className="expense-form">
        <div className="grid two tight">
          <Field label="What for?">
            <input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Beach shack dinner"
              maxLength={100}
              readOnly={pending}
              {...fieldErrorProps(`${ids}-description-error`, !!errors.description)}
              aria-describedby={describedBy('description', ['purpose-trip', 'benefit-trip', gated ? DATA_USE_REASON_ID : ''])}
            />
          </Field>
          <Field label="Amount (₹)">
            <input
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              inputMode="decimal"
              placeholder="2,400"
              maxLength={16}
              readOnly={pending}
              {...fieldErrorProps(`${ids}-amount-error`, !!errors.amount)}
              aria-describedby={describedBy('amount')}
            />
          </Field>
          <Field label="Paid by">
            <select
              value={payer}
              onChange={(event) => setPayer(event.target.value)}
              disabled={pending}
              {...fieldErrorProps(`${ids}-payer-error`, !!errors.payer)}
              aria-describedby={describedBy('payer')}
            >
              {members.map((member) => <option key={member.id} value={member.name}>{member.name}</option>)}
            </select>
          </Field>
        </div>
        {errors.description && <FieldError id={`${ids}-description-error`} {...errors.description} />}
        {errors.amount && <FieldError id={`${ids}-amount-error`} {...errors.amount} />}
        {errors.payer && <FieldError id={`${ids}-payer-error`} {...errors.payer} />}

        <fieldset className="trip-split" aria-describedby={describedBy('split')} style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="sr-only">Split between</legend>
          <div className="row between wrap">
            <strong>Split between</strong>
            <div className="segmented sm" role="group" aria-label="Split rule">
              <button type="button" className={!custom ? 'on' : ''} aria-pressed={!custom} onClick={() => setCustom(false)}>Equally</button>
              <button type="button" className={custom ? 'on' : ''} aria-pressed={custom} onClick={() => setCustom(true)}>Custom</button>
            </div>
          </div>
          <ul className="chips">
            {members.map((member) => (
              <li key={member.id}>
                <label className={`chip ${chosen.has(member.name) ? 'on' : ''}`}>
                  <input type="checkbox" checked={chosen.has(member.name)} onChange={() => toggle(member.name)} />
                  <span>{member.name}</span>
                </label>
                {custom && chosen.has(member.name) && (
                  <input
                    className="share-input"
                    value={shares[member.name] ?? ''}
                    onChange={(event) => setShares({ ...shares, [member.name]: event.target.value })}
                    inputMode="decimal"
                    placeholder="₹"
                    aria-label={`Share for ${member.name}`}
                    maxLength={16}
                    readOnly={pending}
                  />
                )}
              </li>
            ))}
          </ul>
          {!custom && <p className="muted small">Each chosen person gets an equal share. The exact shares, with any rounding adjustment, are shown after the expense is saved.</p>}
          {custom && total > 0 && (
            <p className={`small ${customSum === toPaise(total) ? 'ok-text' : 'err-text'}`}>
              {customSum === toPaise(total)
                ? 'Shares match the bill ✓'
                : `${inr(Math.abs(toPaise(total) - customSum) / 100)} ${customSum < toPaise(total) ? 'left to assign' : 'over'}`}
            </p>
          )}
        </fieldset>
        {errors.split && <FieldError id={`${ids}-split-error`} {...errors.split} />}
        {errors.form && <FieldError id={`${ids}-form-error`} {...errors.form} />}
        <button
          className="btn primary block"
          type="submit"
          disabled={gated}
          aria-disabled={pending || undefined}
          aria-describedby={gated ? DATA_USE_REASON_ID : statusId}
        >
          Add &amp; split
        </button>
        {gated && <span className="sr-only">New entries are paused. See the data-use notice for the reason.</span>}
      </form>
      <ScopedMutationStatus scopeKey={scopeKey} id={statusId} onRetry={changes.retry} />
    </Card>
  );
}

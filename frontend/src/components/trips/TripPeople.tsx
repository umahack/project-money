import { useId, useState, type FormEvent } from 'react';
import { api } from '../../api';
import type { FieldProblem } from '../../clarity/planInputs';
import { useMutationStatus } from '../../clarity/MutationStatusProvider';
import type { TripMutationEnvelope } from '../../clarity/tripMutation';
import { errText, useAuth, useToast } from '../../state';
import type { TripMember } from '../../types';
import { DATA_USE_REASON_ID } from '../clarity/DataUseGate';
import { FieldError, fieldErrorProps } from '../clarity/FieldError';
import { ScopedMutationStatus } from '../clarity/ScopedMutationStatus';
import { Card, Field } from '../ui';
import { describeTripProblem, type MemberFormField } from './tripModel';
import type { TripChanges, TripDetailState } from './useTripChanges';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface TripPeopleProps {
  tripId: number;
  members: readonly TripMember[];
  isOwner: boolean;
  changes: TripChanges;
  detail: TripDetailState;
  gated: boolean;
}

/**
 * The people on a trip. Adding yourself and adding a friend are separate
 * scopes, each with its own status, so a failed one never blocks the other
 * or any other tab. Invitations are not trip data and keep their own state.
 */
export function TripPeople({ tripId, members, isOwner, changes, detail, gated }: TripPeopleProps) {
  const ids = useId();
  const { toast } = useToast();
  const { user } = useAuth();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviting, setInviting] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<MemberFormField | 'invite', FieldProblem>>>({});
  const formScope = `new-trip-member:${tripId}`;
  const selfScope = `trip-member:self:${tripId}`;
  const formStatus = useMutationStatus(formScope);
  const selfStatus = useMutationStatus(selfScope);
  const formPending = formStatus?.phase === 'pending';
  const selfPending = selfStatus?.phase === 'pending';

  function add(scopeKey: string, memberName: string, memberEmail: string | undefined, onDone?: () => void) {
    const body = { name: memberName, ...(memberEmail ? { email: memberEmail } : {}) };
    void changes.run({
      scopeKey,
      label: `Add ${memberName}`,
      path: `/trips/${tripId}/members`,
      method: 'POST',
      body,
    }, {
      showsValidation: true,
      fallbackField: 'Friend',
      onSettled: (result) => {
        if (result.outcome === 'confirmed') {
          const envelope = result.envelope as TripMutationEnvelope;
          if (typeof envelope.id === 'number') {
            detail.addMember({ id: envelope.id, name: memberName, email: memberEmail?.toLowerCase() ?? null });
          } else {
            void detail.reload();
          }
          onDone?.();
        } else if (result.outcome === 'failed') {
          if (result.error.status === 409 && result.error.code === 'TRIP_MEMBER_EXISTS') {
            setErrors({ name: { field: 'Friend’s name', reason: 'is already on this trip.', correction: 'Use a different name, for example add an initial.' } });
            return;
          }
          const problem = describeTripProblem(result.error, 'Friend');
          if (problem && (result.error.status === 400 || result.error.status === 422)) {
            setErrors({ [problem.key]: problem.problem } as Partial<Record<MemberFormField, FieldProblem>>);
          }
        }
      },
    });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (formPending || gated) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setErrors({ name: { field: 'Friend’s name', reason: 'is empty.', correction: 'Enter your friend’s name, up to 40 characters.' } });
      return;
    }
    if (email.trim() && !EMAIL.test(email.trim())) {
      setErrors({ email: { field: 'Email', reason: 'does not look like an email address.', correction: 'Enter an address such as ravi@example.com, or leave it empty.' } });
      return;
    }
    setErrors({});
    add(formScope, trimmed, email.trim() || undefined, () => {
      setName('');
      setEmail('');
    });
  }

  async function sendInvite(event: FormEvent) {
    event.preventDefault();
    const address = inviteEmail.trim();
    if (!EMAIL.test(address)) {
      setErrors({ invite: { field: 'Friend’s email', reason: 'is not a valid email address.', correction: 'Enter the email of a friend who has an account.' } });
      return;
    }
    setErrors({});
    setInviting(true);
    try {
      await api.post(`/trips/${tripId}/invite`, { email: address });
      toast('ok', `If ${address} has a Project Money account, they'll see your invite.`);
      setInviteEmail('');
    } catch (error) {
      toast('err', errText(error));
    } finally {
      setInviting(false);
    }
  }

  const meMissing = !!user && !members.some((member) => (
    member.email?.toLowerCase() === user.email.toLowerCase() || member.name.toLowerCase() === user.name.toLowerCase()
  ));
  const nameErrorId = `${ids}-name-error`;
  const emailErrorId = `${ids}-email-error`;
  const inviteErrorId = `${ids}-invite-error`;

  return (
    <Card id="trip-people-form" tabIndex={-1}>
      <h2>👥 Friends on this trip</h2>
      {members.length === 0 ? (
        <p className="muted">Nobody yet. Add yourself and your crew.</p>
      ) : (
        <ul className="list">
          {members.map((member) => (
            <li key={member.id} className="list-item">
              <span className="avatar" aria-hidden="true">{member.name.slice(0, 1).toUpperCase()}</span>
              <div className="grow">
                <strong>{member.name}</strong>
                {member.email && <small className="muted">{member.email}</small>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {meMissing && (
        <div style={{ marginTop: '0.8rem' }}>
          <button
            type="button"
            className="btn sm"
            disabled={gated}
            aria-disabled={selfPending || undefined}
            aria-describedby={gated ? DATA_USE_REASON_ID : `${ids}-self-status`}
            onClick={() => { if (!selfPending) add(selfScope, user!.name.slice(0, 40), user!.email); }}
          >
            + Add me ({user!.name.split(' ')[0]})
          </button>
        </div>
      )}
      {/* Outside the button's block so a saved change that is waiting on a refresh keeps its retry after "Add me" goes away. */}
      <ScopedMutationStatus scopeKey={selfScope} id={`${ids}-self-status`} onRetry={changes.retry} />

      {isOwner && (
        <form onSubmit={(event) => { void sendInvite(event); }} noValidate className="stack-sm" style={{ marginTop: '1rem' }} aria-label="Invite a registered friend">
          <h3 style={{ margin: 0 }}>✉️ Invite a registered friend</h3>
          <Field label="Friend's email" hint="They need an account. On their next login they'll see the invite and can accept to join this trip.">
            <input
              type="email"
              value={inviteEmail}
              onChange={(event) => setInviteEmail(event.target.value)}
              maxLength={254}
              placeholder="friend@example.com"
              {...fieldErrorProps(inviteErrorId, !!errors.invite)}
            />
          </Field>
          {errors.invite && <FieldError id={inviteErrorId} {...errors.invite} />}
          <button className="btn" type="submit" disabled={inviting}>{inviting ? 'Sending…' : 'Send invite'}</button>
        </form>
      )}

      {isOwner ? (
      <form onSubmit={submit} noValidate className="stack-sm" style={{ marginTop: '1rem' }} aria-label="Add an offline friend">
        <h3 style={{ margin: 0 }}>➕ Add an offline friend (label only)</h3>
        <Field label="Friend's name" hint="Use this when they don't have an account. They appear in splits by name.">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={40}
            placeholder="Ravi"
            readOnly={formPending}
            {...fieldErrorProps(nameErrorId, !!errors.name)}
          />
        </Field>
        {errors.name && <FieldError id={nameErrorId} {...errors.name} />}
        <Field label="Email (optional)">
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            maxLength={254}
            placeholder="ravi@example.com"
            readOnly={formPending}
            {...fieldErrorProps(emailErrorId, !!errors.email)}
          />
        </Field>
        {errors.email && <FieldError id={emailErrorId} {...errors.email} />}
        {errors.form && <FieldError id={`${ids}-form-error`} {...errors.form} />}
        <button
          className="btn ghost"
          type="submit"
          disabled={gated}
          aria-disabled={formPending || undefined}
          aria-describedby={gated ? DATA_USE_REASON_ID : `${ids}-form-status`}
        >
          Add label
        </button>
        <ScopedMutationStatus scopeKey={formScope} id={`${ids}-form-status`} onRetry={changes.retry} />
      </form>
      ) : (
        <p className="small muted" style={{ marginTop: '1rem' }}>Only the trip owner can add people to this trip.</p>
      )}
    </Card>
  );
}

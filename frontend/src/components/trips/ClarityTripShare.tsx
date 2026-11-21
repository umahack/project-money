import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { api } from '../../api';
import { useDataUseGate } from '../../clarity/DataUseGateProvider';
import { errText, useToast } from '../../state';
import { DATA_USE_REASON_ID } from '../clarity/DataUseGate';
import { Card, Modal } from '../ui';
import '../clarity/clarity.css';
import './trips.css';

interface ShareState {
  enabled: boolean;
  token: string | null;
}

/** What the server says the public link serves. The UI renders this and keeps no field list of its own. */
export interface PublicDisclosure {
  version: number;
  groups: ReadonlyArray<{
    id: string;
    title: string;
    fields: ReadonlyArray<{ path: string; label: string }>;
  }>;
  private: readonly string[];
}

type Kind = 'create' | 'rotate' | 'revoke';

interface Operation {
  kind: Kind;
  phase: 'pending' | 'success' | 'error';
  message?: string;
  /** The link state before the attempt. A retry compares against it to learn whether the attempt already took effect. */
  before: ShareState;
}

const WORDS: Record<Kind, { label: string; done: string }> = {
  create: { label: 'Creating public link', done: 'Public link created. Anyone with it can now view this trip.' },
  rotate: { label: 'Rotating public link', done: 'Public link rotated. The previous link no longer works.' },
  revoke: { label: 'Revoking public link', done: 'Public link revoked. Your trip data is unchanged.' },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isDisclosure(value: unknown): value is PublicDisclosure {
  if (!isRecord(value) || !Array.isArray(value.groups) || !Array.isArray(value.private)) return false;
  return value.groups.every((group) => (
    isRecord(group)
    && typeof group.id === 'string'
    && typeof group.title === 'string'
    && Array.isArray(group.fields)
    && group.fields.length > 0
    && group.fields.every((field) => isRecord(field) && typeof field.path === 'string' && typeof field.label === 'string')
  )) && value.groups.length > 0 && value.private.every((item) => typeof item === 'string');
}

function isShareState(value: unknown): value is ShareState {
  return isRecord(value) && typeof value.enabled === 'boolean'
    && (value.token === null || typeof value.token === 'string');
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface DisclosureDialogProps {
  tripId: number;
  kind: 'create' | 'rotate';
  gated: boolean;
  gateReason: string | null;
  confirming: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * The separate sharing confirmation. It lists every public field exactly as the
 * server describes it and sends nothing until the owner chooses the confirm button.
 */
function DisclosureDialog({ tripId, kind, gated, gateReason, confirming, onCancel, onConfirm }: DisclosureDialogProps) {
  const [disclosure, setDisclosure] = useState<PublicDisclosure | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const ids = useId();

  useEffect(() => {
    let live = true;
    setFailure(null);
    api.get<unknown>(`/trips/${tripId}/share/disclosure`).then((body) => {
      if (!live) return;
      if (isDisclosure(body)) setDisclosure(body);
      else setFailure('The list of public fields came back in an unexpected form.');
    }, (error: unknown) => {
      if (live) setFailure(errText(error));
    });
    return () => {
      live = false;
    };
  }, [tripId, attempt]);

  // Keep Tab inside the dialog. The dialog box itself is the first focus stop.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const box = rootRef.current?.closest<HTMLElement>('[role="dialog"]');
      if (!box) return;
      const stops = Array.from(box.querySelectorAll<HTMLElement>(FOCUSABLE));
      const first = stops[0];
      const last = stops[stops.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === box)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      } else if (active && !box.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const rotating = kind === 'rotate';
  const confirmLabel = rotating ? 'Rotate link' : 'Create public link';
  const blocked = !disclosure || gated || confirming;
  return (
    <div ref={rootRef} className="trip-share-dialog stack-sm">
      <h2 id={`${ids}-title`}>{rotating ? 'Rotate the public link?' : 'Create a public link?'}</h2>
      <p>
        <strong>Anyone who has the link can view this trip.</strong>{' '}
        They do not need to sign in. The link is read-only, so nobody can change anything through it.
      </p>
      {rotating && (
        <p role="note">
          <strong>The previous link stops working</strong> as soon as you confirm. Share the new link with the people who should still have access.
        </p>
      )}
      <section aria-labelledby={`${ids}-public`}>
        <h3 id={`${ids}-public`} className="trip-subtitle">What the link shows</h3>
        {!disclosure && !failure && <p className="muted small" role="status">Loading the list of public fields…</p>}
        {failure && (
          <div className="trip-share-failure" role="alert">
            <p><strong>Could not load the public fields.</strong> {failure} You can’t confirm until they are shown.</p>
            <button type="button" className="btn sm ghost" onClick={() => setAttempt((count) => count + 1)}>Retry</button>
          </div>
        )}
        {disclosure && disclosure.groups.map((group) => (
          <div key={group.id} className="trip-share-group" data-group={group.id}>
            <h4 className="trip-share-group-title">{group.title}</h4>
            <ul aria-label={group.title}>
              {group.fields.map((field) => <li key={field.path} data-field={field.path}>{field.label}</li>)}
            </ul>
          </div>
        ))}
      </section>
      {disclosure && (
        <section aria-labelledby={`${ids}-private`}>
          <h3 id={`${ids}-private`} className="trip-subtitle">What stays private</h3>
          <ul aria-label="Stays private">
            {disclosure.private.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </section>
      )}
      <p className="small muted">
        You can stop sharing at any time with <strong>Revoke link</strong> on this tab. It takes effect immediately and keeps all of your trip’s data.
        {' '}<strong>Rotate link</strong> makes a new link and ends the old one.
      </p>
      {gated && gateReason && <p className="small" role="note">{gateReason}</p>}
      <div className="row end" style={{ gap: '0.5rem' }}>
        <button type="button" className="btn ghost" onClick={onCancel} disabled={confirming}>Cancel</button>
        <button
          type="button"
          className="btn primary"
          disabled={blocked}
          aria-describedby={gated ? DATA_USE_REASON_ID : undefined}
          onClick={onConfirm}
        >
          {confirming ? 'Working…' : confirmLabel}
        </button>
      </div>
    </div>
  );
}

/**
 * Public share link for the clarity branch. Sharing starts off. Creating or
 * rotating a link first shows exactly which fields the public page serves and
 * what stays private, and sends nothing until the owner confirms. Revoking is a
 * single action with no confirmation step.
 */
export function ClarityTripShare({ tripId }: { tripId: number }) {
  const { toast } = useToast();
  const gate = useDataUseGate();
  const [share, setShare] = useState<ShareState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [op, setOp] = useState<Operation | null>(null);
  const [dialog, setDialog] = useState<'create' | 'rotate' | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [focusLink, setFocusLink] = useState(false);
  const alive = useRef(true);
  const sending = useRef(false);
  const linkRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const statusId = useId();
  // Keeps the dialog's content in place while it fades out.
  const lastDialog = useRef<'create' | 'rotate'>('create');
  if (dialog) lastDialog.current = dialog;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const readStatus = useCallback(async (): Promise<ShareState> => {
    const body = await api.get<unknown>(`/trips/${tripId}/share`);
    if (!isShareState(body)) throw new Error('The server returned an unexpected sharing status.');
    return body;
  }, [tripId]);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const next = await readStatus();
      if (alive.current) setShare(next);
    } catch (error) {
      if (alive.current) setLoadError(errText(error));
    }
  }, [readStatus]);

  useEffect(() => { void load(); }, [load]);

  const closeDialog = useCallback(() => {
    if (sending.current) return;
    setDialog(null);
  }, []);

  /** Runs one create, rotate, or revoke and records its scoped status. Returns whether it ended in the wanted state. */
  const perform = useCallback(async (kind: Kind, before: ShareState, retrying: boolean): Promise<boolean> => {
    setOp({ kind, phase: 'pending', before });
    try {
      let next: ShareState;
      if (kind === 'revoke') {
        await api.del(`/trips/${tripId}/share`);
        next = { enabled: false, token: null };
      } else {
        // After a failure the request may still have reached the server. Read the
        // link first so a retry never makes a second link or rotates a newer one.
        let applied: ShareState | null = null;
        if (retrying) {
          const current = await readStatus();
          const changed = kind === 'create' ? current.enabled : current.enabled && current.token !== before.token;
          if (changed && current.token) applied = current;
        }
        if (applied) {
          next = applied;
        } else {
          const created = await api.post<unknown>(`/trips/${tripId}/share`, {});
          next = isRecord(created) && typeof created.token === 'string'
            ? { enabled: true, token: created.token }
            : await readStatus();
        }
      }
      if (!alive.current) return true;
      setShare(next);
      setOp({ kind, phase: 'success', before });
      return true;
    } catch (error) {
      if (alive.current) setOp({ kind, phase: 'error', message: errText(error), before });
      return false;
    }
  }, [tripId, readStatus]);

  async function confirm() {
    if (sending.current || !dialog || !share) return;
    sending.current = true;
    setConfirming(true);
    const kind = dialog;
    const ok = await perform(kind, share, false);
    sending.current = false;
    if (!alive.current) return;
    setConfirming(false);
    setDialog(null);
    if (ok && kind === 'create') setFocusLink(true);
  }

  async function revoke() {
    if (!share || op?.phase === 'pending') return;
    const ok = await perform('revoke', share, false);
    if (ok && alive.current) setFocusLink(true);
  }

  async function retry() {
    if (!op || op.phase !== 'error' || sending.current) return;
    sending.current = true;
    const ok = await perform(op.kind, op.before, true);
    sending.current = false;
    if (ok && alive.current && op.kind !== 'rotate') setFocusLink(true);
  }

  // Moves focus after the dialog or the revoke control disappears, so it never falls to the page body.
  useEffect(() => {
    if (!focusLink || !share || dialog) return;
    (share.enabled ? linkRef.current : headingRef.current)?.focus();
    setFocusLink(false);
  }, [focusLink, share, dialog]);

  async function copy() {
    const value = share?.token ? `${window.location.origin}/share/trip/${share.token}` : '';
    try {
      await navigator.clipboard.writeText(value);
      toast('ok', 'Link copied');
    } catch { toast('err', 'Could not copy — long-press the link to copy manually'); }
  }

  if (!share) {
    return (
      <Card id="trip-share" aria-labelledby={`${statusId}-heading`}>
        <h2 id={`${statusId}-heading`}>🔗 Public share link</h2>
        {loadError
          ? (
            <div role="alert" className="stack-sm">
              <p><strong>Sharing status could not be loaded.</strong> {loadError}</p>
              <button type="button" className="btn sm" onClick={() => void load()}>Retry</button>
            </div>
          )
          : <p className="muted small" role="status">Loading sharing status…</p>}
      </Card>
    );
  }

  const url = share.token ? `${window.location.origin}/share/trip/${share.token}` : '';
  const pending = op?.phase === 'pending';
  const gated = !gate.financialInputsEnabled;
  const words = op ? WORDS[op.kind] : null;
  return (
    <>
    <Card id="trip-share">
      <h2 ref={headingRef} tabIndex={-1}>🔗 Public share link</h2>
      <p className="muted small">
        {share.enabled
          ? 'Anyone with this link can view the trip without signing in. It is read-only.'
          : 'Sharing is off. Nobody can view this trip without signing in. You will see exactly what a link shows before it is created.'}
      </p>
      {share.enabled && url ? (
        <div className="stack-sm">
          <label className="trip-share-link-label">
            <span className="small muted">Public link</span>
            <input ref={linkRef} value={url} readOnly onFocus={(event) => event.currentTarget.select()} />
          </label>
          <div className="row-sm" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
            <button type="button" className="btn sm" onClick={() => void copy()}>Copy link</button>
            <button
              type="button"
              className="btn sm ghost"
              disabled={pending || gated}
              aria-describedby={gated ? DATA_USE_REASON_ID : undefined}
              onClick={() => setDialog('rotate')}
            >
              Rotate link
            </button>
            <button type="button" className="btn sm ghost danger" disabled={pending} onClick={() => void revoke()}>
              Revoke link
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="btn"
          disabled={pending || gated}
          aria-describedby={gated ? DATA_USE_REASON_ID : undefined}
          onClick={() => setDialog('create')}
        >
          Create public link
        </button>
      )}
      <div
        id={statusId}
        className={`clarity-mutation clarity-mutation-${op?.phase ?? 'idle'} trip-scope-status`}
        data-scope={`trip-share:${tripId}`}
      >
        <p className="clarity-mutation-line small" role="status">
          {op && words && op.phase === 'pending' && (
            <>
              <span aria-hidden="true" className="clarity-glyph">…</span>
              <span>{words.label}: pending</span>
            </>
          )}
          {op && words && op.phase === 'success' && (
            <>
              <span aria-hidden="true" className="clarity-glyph">✓</span>
              <span>{words.done}</span>
            </>
          )}
        </p>
        <div role="alert" className="clarity-mutation-failure">
          {op && words && op.phase === 'error' && (
            <p className="clarity-mutation-line small">
              <span aria-hidden="true" className="clarity-glyph">✕</span>
              <span>
                <strong>{words.label}: failed.</strong> {op.message} Retry first checks whether the change already went through, then sends it only if it did not.
              </span>
            </p>
          )}
        </div>
        {op && op.phase === 'error' && (
          <div className="clarity-mutation-actions">
            <button type="button" className="btn sm ghost clarity-retry" aria-label={`Retry ${words?.label.toLowerCase()}`} onClick={() => void retry()}>
              Retry
            </button>
            <button type="button" className="btn sm ghost" onClick={() => setOp(null)}>Dismiss</button>
          </div>
        )}
      </div>
    </Card>
      {/* Outside the card: the card's blur and clipping would otherwise trap the fixed backdrop. */}
      <Modal
        open={dialog !== null}
        onClose={closeDialog}
        title={lastDialog.current === 'rotate' ? 'Rotate the public link' : 'Create a public link'}
      >
        <DisclosureDialog
          tripId={tripId}
          kind={lastDialog.current}
          gated={gated}
          gateReason={gate.reason}
          confirming={confirming}
          onCancel={closeDialog}
          onConfirm={() => void confirm()}
        />
      </Modal>
    </>
  );
}

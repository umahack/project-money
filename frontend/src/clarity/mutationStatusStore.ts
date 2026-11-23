// Framework-free runner and status registry for scoped financial mutations.
//
// submit() registers the pending patch and pending status synchronously, then
// awaits the network. Each record scope (for example `salary:2026-11` or
// `expense:98`) has at most one in-flight change; independent scopes run
// concurrently with separate statuses. Retries reuse the original body and
// Idempotency-Key. A new key is created only when the submitted command differs
// from the failed attempt, which is how an edited draft is detected.
import type { FinancialSnapshot, MutationEnvelope, StructuredErrorConstraint } from './contracts';
import type { ClarityStore } from './clarityStore';
import { isScopePending, type SnapshotPatch } from './patchReducer';

export interface MutationFailure {
  message: string;
  status?: number;
  code?: string;
  field?: string;
  /** The server's accepted bound for `field`, for example `{ minMinor, maxMinor }`. Present only when the server sent one. */
  constraint?: StructuredErrorConstraint;
  /** Present when the server already committed the change and only the follow-up read failed. */
  committed?: { id: number | null };
}

export type MutationStatus =
  | {
      phase: 'pending';
      scopeKey: string;
      label: string;
      mutationId: string;
      startedAt: number;
    }
  | {
      phase: 'success';
      scopeKey: string;
      label: string;
      completedAt: number;
      replayed: boolean;
    }
  | {
      phase: 'error';
      scopeKey: string;
      label: string;
      failedAt: number;
      error: MutationFailure;
    };

export interface MutationCommand {
  /** Record scope that serializes submissions, such as `goal:17`. */
  scopeKey: string;
  /** Short human-readable change name shown beside the control, such as "Saving goal". */
  label: string;
  path: string;
  method?: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Pure provisional display change applied while the request is pending. */
  patch?: SnapshotPatch;
  /** Months the patch applies to. Omitted means every loaded month. */
  months?: readonly string[];
}

export interface MutationRequest {
  path: string;
  method: NonNullable<MutationCommand['method']>;
  body: unknown;
  idempotencyKey: string;
}

export type MutationSubmitResult =
  | { outcome: 'confirmed'; envelope: MutationEnvelope }
  | { outcome: 'failed'; error: MutationFailure }
  /** The same scope already has a pending change, so nothing was sent. */
  | { outcome: 'duplicate' }
  /** The session was cleared while the request was in flight; the response was ignored. */
  | { outcome: 'discarded' }
  /** retry() was called for a scope with no failed command to resend. */
  | { outcome: 'not_retryable' };

export interface MutationStatusState {
  readonly statuses: Readonly<Record<string, MutationStatus>>;
}

export interface MutationStatusStore {
  getState(): MutationStatusState;
  getStatus(scopeKey: string): MutationStatus | undefined;
  subscribe(listener: () => void): () => void;
  submit(command: MutationCommand): Promise<MutationSubmitResult>;
  /** Re-sends a failed scope's original command with its original Idempotency-Key. */
  retry(scopeKey: string): Promise<MutationSubmitResult>;
  /** Clears a finished (success or error) status. Pending statuses are kept. */
  dismiss(scopeKey: string): void;
  reset(): void;
}

export interface MutationStatusStoreOptions {
  clarityStore: ClarityStore;
  send: (request: MutationRequest) => Promise<MutationEnvelope>;
  /** Called synchronously with each newly confirmed snapshot, e.g. to mirror it into the query cache. */
  onConfirmed?: (snapshot: FinancialSnapshot) => void;
  createIdempotencyKey?: () => string;
  now?: () => number;
}

const identityPatch: SnapshotPatch = (snapshot) => snapshot;

export function stableStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${entries.join(',')}}`;
}

function fingerprintOf(command: MutationCommand): string {
  return stableStringify({
    path: command.path,
    method: command.method ?? 'POST',
    body: command.body ?? {},
  });
}

export function describeFailure(error: unknown): MutationFailure {
  if (error && typeof error === 'object') {
    const candidate = error as Partial<Record<'message' | 'status' | 'code' | 'field' | 'constraint' | 'committed', unknown>>;
    const { constraint, committed } = candidate;
    const committedRecord = committed && typeof committed === 'object' ? committed as { id?: unknown } : undefined;
    return {
      ...(committedRecord
        ? { committed: { id: typeof committedRecord.id === 'number' ? committedRecord.id : null } }
        : {}),
      message: typeof candidate.message === 'string' && candidate.message
        ? candidate.message
        : 'The change could not be saved.',
      status: typeof candidate.status === 'number' ? candidate.status : undefined,
      code: typeof candidate.code === 'string' ? candidate.code : undefined,
      field: typeof candidate.field === 'string' ? candidate.field : undefined,
      ...(typeof constraint === 'string' || (constraint && typeof constraint === 'object' && !Array.isArray(constraint))
        ? { constraint: constraint as StructuredErrorConstraint }
        : {}),
    };
  }
  return { message: 'The change could not be saved.' };
}

function defaultIdempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}

export function createMutationStatusStore({
  clarityStore,
  send,
  onConfirmed,
  createIdempotencyKey = defaultIdempotencyKey,
  now = Date.now,
}: MutationStatusStoreOptions): MutationStatusStore {
  let state: MutationStatusState = { statuses: {} };
  let generation = 0;
  let mutationCounter = 0;
  const listeners = new Set<() => void>();
  const attempts = new Map<string, { fingerprint: string; idempotencyKey: string }>();
  const commands = new Map<string, MutationCommand>();

  function emit() {
    for (const listener of [...listeners]) listener();
  }

  function setStatus(status: MutationStatus) {
    state = { statuses: { ...state.statuses, [status.scopeKey]: status } };
    emit();
  }

  function removeStatus(scopeKey: string) {
    if (!(scopeKey in state.statuses)) return;
    const { [scopeKey]: _removed, ...rest } = state.statuses;
    state = { statuses: rest };
    emit();
  }

  async function execute(
    command: MutationCommand,
    mutationId: string,
    request: MutationRequest,
    clarityGeneration: number,
    statusGeneration: number,
  ): Promise<MutationSubmitResult> {
    const sessionChanged = () => (
      clarityStore.getGeneration() !== clarityGeneration || generation !== statusGeneration
    );

    let envelope: MutationEnvelope;
    try {
      envelope = await send(request);
      if (!envelope || typeof envelope !== 'object' || !envelope.clarity) {
        throw new Error('The server response did not include the confirmed financial snapshot.');
      }
    } catch (error) {
      if (sessionChanged()) return { outcome: 'discarded' };
      // Remove only this mutation's patch; every other scope keeps its patch and values.
      clarityStore.dispatch({ type: 'fail', mutationId });
      const failure = describeFailure(error);
      setStatus({
        phase: 'error',
        scopeKey: command.scopeKey,
        label: command.label,
        failedAt: now(),
        error: failure,
      });
      return { outcome: 'failed', error: failure };
    }

    if (sessionChanged()) return { outcome: 'discarded' };
    // One synchronous step: install the newer snapshot and drop only this patch.
    clarityStore.dispatch({ type: 'succeed', mutationId, snapshot: envelope.clarity });
    try {
      onConfirmed?.(envelope.clarity);
    } catch {
      // Mirroring into the query cache must not turn a confirmed change into a failure.
    }
    attempts.delete(command.scopeKey);
    commands.delete(command.scopeKey);
    setStatus({
      phase: 'success',
      scopeKey: command.scopeKey,
      label: command.label,
      completedAt: now(),
      replayed: envelope.mutation?.replayed === true,
    });
    return { outcome: 'confirmed', envelope };
  }

  function submit(command: MutationCommand): Promise<MutationSubmitResult> {
    if (isScopePending(clarityStore.getState(), command.scopeKey)) {
      return Promise.resolve({ outcome: 'duplicate' });
    }

    const fingerprint = fingerprintOf(command);
    let attempt = attempts.get(command.scopeKey);
    if (!attempt || attempt.fingerprint !== fingerprint) {
      attempt = { fingerprint, idempotencyKey: createIdempotencyKey() };
      attempts.set(command.scopeKey, attempt);
    }

    mutationCounter += 1;
    const mutationId = `${command.scopeKey}#${mutationCounter}`;
    const startedAt = now();

    // Everything up to the await below runs synchronously inside the submit call.
    clarityStore.dispatch({
      type: 'submit',
      mutation: {
        mutationId,
        scopeKey: command.scopeKey,
        submittedAt: startedAt,
        months: command.months,
        patch: command.patch ?? identityPatch,
      },
    });
    // Keep a private copy so later edits to the caller's draft object cannot alter the retry.
    commands.set(command.scopeKey, {
      ...command,
      body: command.body === undefined ? undefined : JSON.parse(JSON.stringify(command.body)),
    });
    setStatus({
      phase: 'pending',
      scopeKey: command.scopeKey,
      label: command.label,
      mutationId,
      startedAt,
    });

    return execute(
      command,
      mutationId,
      {
        path: command.path,
        method: command.method ?? 'POST',
        body: command.body ?? {},
        idempotencyKey: attempt.idempotencyKey,
      },
      clarityStore.getGeneration(),
      generation,
    );
  }

  return {
    getState: () => state,
    getStatus: (scopeKey) => state.statuses[scopeKey],
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    submit,
    retry(scopeKey) {
      const command = commands.get(scopeKey);
      if (!command || state.statuses[scopeKey]?.phase !== 'error') {
        return Promise.resolve({ outcome: 'not_retryable' });
      }
      return submit(command);
    },
    dismiss(scopeKey) {
      if (state.statuses[scopeKey]?.phase === 'pending') return;
      commands.delete(scopeKey);
      removeStatus(scopeKey);
    },
    reset() {
      generation += 1;
      attempts.clear();
      commands.clear();
      state = { statuses: {} };
      emit();
    },
  };
}

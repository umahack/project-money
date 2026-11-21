import { api, ApiError, clarityApi } from '../api';
import { currentMonth } from '../money';
import {
  CLARITY_SCHEMA_VERSION,
  type ClarityReadResponse,
  type MutationEnvelope,
  type MutationMetadata,
} from './contracts';
import type { MutationRequest } from './mutationStatusStore';

/**
 * Trip writes answer with `{ id?, tripVersion, dataVersion, mutation, tripOutcome }` and no
 * financial snapshot. The scoped mutation runner installs a snapshot with every confirmed
 * change, so after the server confirms a trip write this adapter reads the confirmed snapshot
 * for the month on screen and returns both as one envelope.
 *
 * A retry sends the whole request again with the same Idempotency-Key. The server replays the
 * committed change (`mutation.replayed`) and the snapshot is read again, so a failure between
 * the two steps never writes twice.
 */
const TRIP_WRITE_PATH = /^\/trips\/[1-9][0-9]{0,8}\/(?:members|expenses|expenses\/[1-9][0-9]{0,8}\/personal-link)$/;

export function isTripMutationPath(path: string): boolean {
  return TRIP_WRITE_PATH.test(path);
}

interface TripWriteResponse {
  id?: number | null;
  month?: string;
  tripVersion?: number;
  dataVersion?: number;
  mutation?: MutationMetadata;
  tripOutcome?: unknown;
}

/** A confirmed trip write: the runner envelope plus the trip fields the server returned. */
export type TripMutationEnvelope = MutationEnvelope & {
  id?: number | null;
  tripVersion?: number;
  dataVersion?: number;
  tripOutcome?: unknown;
};

/** Code of the failure raised when the write is committed but the follow-up read failed. */
export const TRIP_REFRESH_FAILED = 'TRIP_REFRESH_FAILED';

/**
 * The server committed the change but the confirmed snapshot could not be read.
 * `committed` lets the page show the saved change while the scope offers a refresh.
 */
export class TripRefreshError extends ApiError {
  constructor(status: number, public readonly committed: { id: number | null }) {
    super(status, 'The change was saved, but the updated balances could not be loaded. Retry to load them. Nothing is saved twice.', {
      code: TRIP_REFRESH_FAILED,
    });
    this.name = 'TripRefreshError';
  }
}

/**
 * Writes the server has committed whose snapshot read failed, by Idempotency-Key.
 * A retry carries the same key, so it reads again and never sends the write again.
 */
type ConfirmedTripWrite = TripWriteResponse & { mutation: MutationMetadata };
const committedWrites = new Map<string, ConfirmedTripWrite>();

export async function sendTripMutation(request: MutationRequest): Promise<TripMutationEnvelope> {
  const metadata = { idempotencyKey: request.idempotencyKey };
  let written = committedWrites.get(request.idempotencyKey);
  if (!written) {
    let response: TripWriteResponse;
    if (request.method === 'PUT') response = await api.put<TripWriteResponse>(request.path, request.body, metadata);
    else if (request.method === 'DELETE') response = await api.del<TripWriteResponse>(request.path, undefined, metadata);
    else if (request.method === 'PATCH') response = await api.patch<TripWriteResponse>(request.path, request.body, metadata);
    else response = await api.post<TripWriteResponse>(request.path, request.body, true, metadata);

    if (!response || typeof response !== 'object' || !response.mutation) {
      throw new ApiError(0, 'The server response did not confirm the trip change.', {
        code: 'UNSUPPORTED_CLARITY_SCHEMA_VERSION',
      });
    }
    written = { ...response, mutation: response.mutation };
  }
  let read: ClarityReadResponse;
  try {
    read = await clarityApi.get<ClarityReadResponse>(
      `/finance/clarity?month=${encodeURIComponent(currentMonth())}`,
    );
  } catch (error) {
    // The change is committed. Remember it so the retry only refreshes and never writes twice.
    committedWrites.set(request.idempotencyKey, written);
    throw new TripRefreshError(error instanceof ApiError ? error.status : 0, {
      id: typeof written.id === 'number' ? written.id : null,
    });
  }
  committedWrites.delete(request.idempotencyKey);
  return {
    ...written,
    schemaVersion: CLARITY_SCHEMA_VERSION,
    mutation: written.mutation,
    clarity: read.snapshot,
  };
}

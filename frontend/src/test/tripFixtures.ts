import { vi } from 'vitest';
import type {
  ActionableInsight,
  FinancialSnapshot,
  MutationMetadata,
  Outcome,
  SnapshotHighlights,
  TripOutcomeValue,
} from '../clarity/contracts';
import type { TripDetailData, TripExpense, TripMember } from '../types';
import { NO_HIGHLIGHTS, homeSnapshot, rupees, tripItemOutcome } from './homeSummaryFixtures';
import { createApiResponse } from './test-utils';

export { rupees };

/** The signed-in test user's email, so the trip member below is the linked member. */
export const ME_EMAIL = 'test.user@example.test';
export const TRIP_ID = 3;

export const ASHA: TripMember = { id: 101, name: 'Asha', email: ME_EMAIL };
export const RAVI: TripMember = { id: 102, name: 'Ravi', email: null };
export const MEERA: TripMember = { id: 103, name: 'Meera', email: null };

/**
 * ₹1,000.00 shared three ways. The server's allocation is ₹333.34 / ₹333.33 / ₹333.33:
 * one paisa of rounding adjustment goes to the first member in confirmed order.
 */
export const DINNER: TripExpense = {
  id: 11,
  payer: 'Asha',
  description: 'Beach dinner',
  amount: 1000,
  created_at: '2026-01-10 12:00:00',
  split: [{ name: 'Asha', share: 1 }, { name: 'Ravi', share: 1 }, { name: 'Meera', share: 1 }],
};

export function tripDetail(overrides: Partial<TripDetailData> = {}): TripDetailData {
  return {
    trip: { id: TRIP_ID, name: 'Goa weekend', destination: 'Goa', budget: 5000, start_date: '2026-01-09', end_date: '2026-01-12' },
    role: 'owner',
    members: [ASHA, RAVI, MEERA],
    expenses: [DINNER],
    // The original, unconfirmed arithmetic. The clarity branch never reads it.
    settlement: {
      balances: { Asha: 666.66, Ravi: -333.33, Meera: -333.33 },
      transactions: [{ from: 'Ravi', to: 'Asha', amount: 333.33 }, { from: 'Meera', to: 'Asha', amount: 333.33 }],
    },
    ...overrides,
  };
}

const share = (expenseId: number, memberId: number, amountMinor: number, roundingAdjustmentMinor = 0) => ({
  expenseId,
  memberId,
  amount: { currency: 'INR' as const, amountMinor },
  roundingAdjustmentMinor,
});

/** The confirmed outcome for the trip above, in the server's shape. */
export function dinnerOutcomeValue(): TripOutcomeValue {
  return {
    tripId: TRIP_ID,
    tripVersion: 3,
    allocations: [share(11, 101, 33334, 1), share(11, 102, 33333), share(11, 103, 33333)],
    balances: [
      { memberId: 101, amountMinor: 66666, label: 'receivable' },
      { memberId: 102, amountMinor: -33333, label: 'owed' },
      { memberId: 103, amountMinor: -33333, label: 'owed' },
    ],
    settlements: [
      { fromMemberId: 102, toMemberId: 101, amount: { currency: 'INR', amountMinor: 33333 } },
      { fromMemberId: 103, toMemberId: 101, amount: { currency: 'INR', amountMinor: 33333 } },
    ],
  };
}

export function tripOutcomeItem(month: string, dataVersion: number, value: TripOutcomeValue = dinnerOutcomeValue()): Outcome<TripOutcomeValue> {
  return { ...tripItemOutcome(TRIP_ID, month, dataVersion), value };
}

/** A trip the server cannot calculate. The stored records are never rewritten. */
export function invalidTripOutcome(month: string, dataVersion: number): Outcome<TripOutcomeValue> {
  const item = tripItemOutcome(TRIP_ID, month, dataVersion);
  const { value: _value, ...rest } = item;
  return {
    ...rest,
    status: 'invalid_input',
    invalid: [{ input: `trip:${TRIP_ID}.split`, constraint: 'at least one member with a positive share', affects: ['trip'] }],
  };
}

export function tripSnapshot(
  month: string,
  options: {
    dataVersion?: number;
    items?: Array<Outcome<TripOutcomeValue>>;
    highlights?: SnapshotHighlights;
    actions?: ActionableInsight[];
  } = {},
): FinancialSnapshot {
  const dataVersion = options.dataVersion ?? 1;
  return homeSnapshot(month, {
    dataVersion,
    actions: options.actions ?? [],
    highlights: options.highlights ?? NO_HIGHLIGHTS,
    goals: [],
    trips: options.items ?? [tripOutcomeItem(month, dataVersion)],
  });
}

export interface TripWriteOptions {
  id?: number | null;
  operation: string;
  recordType: string;
  recordId?: number | null;
  scopeKey: string;
  replayed?: boolean;
  changeId?: number;
  tripVersion?: number;
  dataVersion?: number;
}

/** The body of a confirmed trip write. It carries the trip outcome and no financial snapshot. */
export function tripWrite(options: TripWriteOptions): Record<string, unknown> {
  const mutation: MutationMetadata = {
    changeId: options.changeId ?? 700,
    idempotencyKey: 'server-key',
    scopeKey: options.scopeKey,
    operation: options.operation,
    recordType: options.recordType,
    recordId: options.recordId ?? options.id ?? null,
    status: 'confirmed',
    recordVersion: 1,
    ...(options.replayed ? { replayed: true } : {}),
  };
  return {
    ok: true,
    ...(options.id === undefined ? {} : { id: options.id }),
    tripVersion: options.tripVersion ?? 4,
    dataVersion: options.dataVersion ?? 2,
    mutation,
    tripOutcome: { status: 'available' },
  };
}

export interface RecordedCall {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
  headers: Record<string, string>;
}
export type Handler = (call: RecordedCall, attempt: number) => Response | Promise<Response>;

/** Routes fetch by `METHOD /path`. A plain value is a 200 JSON body; a function controls the response. */
export function mockTripApi(routes: Record<string, Handler | object>) {
  const calls: RecordedCall[] = [];
  const attempts = new Map<string, number>();
  vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
    const path = decodeURIComponent(new URL(String(input), 'http://localhost').pathname.replace(/^\/api/, ''));
    const method = init?.method ?? 'GET';
    const key = `${method} ${path}`;
    const call: RecordedCall = {
      method,
      path,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
      headers: { ...(init?.headers as Record<string, string> | undefined) },
    };
    calls.push(call);
    const attempt = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, attempt);
    const route = routes[key];
    if (route === undefined) return createApiResponse({ status: 404, body: { error: 'Not found' } });
    if (typeof route === 'function') return (route as Handler)(call, attempt);
    return createApiResponse({ body: route });
  });
  return {
    calls,
    to: (method: string, path: string) => calls.filter((call) => call.method === method && call.path === path),
  };
}

export const readSnapshot = (snapshot: FinancialSnapshot) => ({ schemaVersion: 1, snapshot });
export const jsonOk = (body: unknown) => createApiResponse({ body });
export const jsonFailure = (status: number, body: Record<string, unknown>) => createApiResponse({ status, body });

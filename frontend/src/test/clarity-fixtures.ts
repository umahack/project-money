import type {
  FinancialSnapshot,
  GoalOutcomeValue,
  MonthlyPlanValue,
  MutationEnvelope,
  Outcome,
  SpendingOutcomeValue,
  TripOutcomeValue,
} from '../clarity/contracts';
import type { SnapshotPatch } from '../clarity/patchReducer';

function outcome<T>(id: string, kind: Outcome<T>['kind'], month: string, dataVersion: number): Outcome<T> {
  const [year, monthNumber] = month.split('-').map(Number) as [number, number];
  const next = new Date(Date.UTC(year, monthNumber, 1)).toISOString().slice(0, 10);
  return {
    id,
    kind,
    status: 'calculation_failed',
    classification: 'calculated_result',
    dataVersion,
    period: { month, start: `${month}-01`, endExclusive: next, timeZone: 'Asia/Kolkata' },
    sourceRefs: [],
  };
}

/**
 * Minimal valid snapshot. `generatedAt` carries a free-form tag so tests can see
 * which confirmed base and which patches produced a visible value.
 */
export function makeSnapshot(dataVersion: number, month = '2026-01', tag = `v${dataVersion}`): FinancialSnapshot {
  const [year, monthNumber] = month.split('-').map(Number) as [number, number];
  const endExclusive = new Date(Date.UTC(year, monthNumber, 1)).toISOString().slice(0, 10);
  return {
    dataVersion,
    currency: 'INR',
    precisionMinor: 1,
    period: {
      month,
      timeZone: 'Asia/Kolkata',
      start: `${month}-01`,
      endExclusive,
      asOfDate: `${month}-15`,
      daysRemainingInclusive: 17,
    },
    generatedAt: tag,
    facts: [],
    outcomes: {
      monthlyPlan: outcome<MonthlyPlanValue>(`monthly-plan:${month}`, 'monthly_plan', month, dataVersion),
      spending: outcome<SpendingOutcomeValue>(`spending:${month}`, 'spending', month, dataVersion),
      goals: [outcome<GoalOutcomeValue>('goal:17', 'goal', month, dataVersion)],
      tripSummary: outcome<TripOutcomeValue[]>(`trip-summary:${month}`, 'trip_summary', month, dataVersion),
    },
    actions: [],
  };
}

/** Pure patch that appends `+<mark>` to the snapshot tag. */
export function tagPatch(mark: string): SnapshotPatch {
  return (snapshot) => ({ ...snapshot, generatedAt: `${snapshot.generatedAt ?? ''}+${mark}` });
}

export function makeEnvelope(snapshot: FinancialSnapshot, scopeKey: string, idempotencyKey = 'key'): MutationEnvelope {
  return {
    schemaVersion: 1,
    mutation: {
      changeId: snapshot.dataVersion,
      idempotencyKey,
      scopeKey,
      operation: 'update',
      status: 'confirmed',
      recordVersion: snapshot.dataVersion,
    },
    clarity: snapshot,
  };
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

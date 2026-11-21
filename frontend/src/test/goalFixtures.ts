import type {
  FinancialSnapshot,
  GoalOutcomeValue,
  MutationEnvelope,
  Outcome,
} from '../clarity/contracts';
import type { GoalRow } from '../components/goals/goalInputs';
import { NO_HIGHLIGHTS, goalOutcome, homeSnapshot, rupees } from './homeSummaryFixtures';

export { rupees };

export interface GoalFixture {
  id: number;
  /** Replaces fields of the server's calculated value. */
  value?: Partial<GoalOutcomeValue>;
  /** Replaces fields of the outcome itself, for example a status and its missing or invalid inputs. */
  outcome?: Partial<Outcome<GoalOutcomeValue>>;
}

/**
 * A confirmed snapshot whose goal outcomes stand in for the server's. The values
 * here play the server; the page under test never repeats the arithmetic.
 */
export function goalSnapshot(month: string, goals: GoalFixture[], options: { dataVersion?: number } = {}): FinancialSnapshot {
  const dataVersion = options.dataVersion ?? 1;
  return homeSnapshot(month, {
    dataVersion,
    actions: [],
    highlights: NO_HIGHLIGHTS,
    goals: goals.map((goal) => ({
      ...goalOutcome(goal.id, month, dataVersion, goal.value),
      ...goal.outcome,
    })),
    trips: [],
  });
}

/** One goal as `GET /api/finance/goals` returns it. Amounts are rupees. */
export function goalRow(
  id: number,
  name: string,
  target: number,
  saved: number,
  targetDate: string | null,
): GoalRow {
  return {
    id,
    name,
    target_amount: target,
    saved_amount: saved,
    target_date: targetDate,
    created_at: '2026-01-01 00:00:00',
    updated_at: '2026-01-01 00:00:00',
  };
}

export interface GoalEnvelopeOptions {
  operation: 'goal.create' | 'goal.update' | 'goal.delete' | 'goal.contribute';
  goalId: number;
  recordVersion?: number;
  changeId?: number;
  /** The confirmed record after the change. Null after a delete. */
  record: { id: number; name: string; targetAmountMinor: number; savedAmountMinor: number; targetDate: string | null } | null;
  replayed?: boolean;
}

/** The body of a confirmed goal response (X-Clarity-Contract: 1). */
export function goalEnvelope(snapshot: FinancialSnapshot, options: GoalEnvelopeOptions): MutationEnvelope & { ok: true } {
  return {
    ok: true,
    schemaVersion: 1,
    mutation: {
      changeId: options.changeId ?? 300 + snapshot.dataVersion,
      idempotencyKey: 'server-key',
      scopeKey: `goal:${options.goalId}`,
      operation: options.operation,
      recordType: 'goal',
      recordId: options.goalId,
      status: 'confirmed',
      recordVersion: options.recordVersion ?? 1,
      record: options.record,
      ...(options.replayed ? { replayed: true } : {}),
    },
    clarity: snapshot,
  };
}

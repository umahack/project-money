// A closed, in-memory stand-in for the goal endpoints and snapshot reads of the
// financial clarity contract (contract version 1). Counterpart of FakeSpendingBackend
// for savings goals, shared by Vitest (`installGoalsFetch`) and Playwright.
//
// It is transport-free: `handle()` takes a request and returns a status and a JSON body.
//
// - `GET /finance/clarity?month=` returns `{ schemaVersion, snapshot }`. The snapshot holds one
//   outcome per goal (server rules: gap, inclusive months, ceiling division, feasibility,
//   one revised target amount, overdue, funded, invalid-input for legacy-invalid rows) and
//   `highlights.urgentGoal` chosen as the server does (overdue, earliest date, larger gap,
//   name, id), plus the single goal action.
// - `GET /finance/goals` returns the saved rows (rupees), newest id first.
// - `GET /finance/explanations/goal:<id>?version=` returns ordered sources and steps.
// - `POST /finance/goals`, `PATCH`/`DELETE /finance/goals/:id` and
//   `POST /finance/goals/:id/contributions` return a mutation envelope
//   `{ ok, schemaVersion, mutation, clarity }`.
// - A contribution must be a whole number of paise from 1 through the funding gap. Outside
//   that, 422 GOAL_CONTRIBUTION_OUT_OF_RANGE with `constraint { minMinor, maxMinor }`. A goal
//   whose stored values break the bounds answers 422 GOAL_REQUIRES_CORRECTION.
// - Every confirmed change moves one shared `dataVersion` forward and the goal's record version.
// - `expectedRecordVersion` is checked after validation; a mismatch is 409 RECORD_VERSION_CONFLICT.
// - The same `Idempotency-Key` with the same command replays the first confirmed response with
//   `replayed: true`. The same key with a different command is 409 IDEMPOTENCY_KEY_REUSED.
//
// All amounts are whole paise. Nothing here reads a clock, the network, or a database: the
// current local date is `today`, which is also the snapshot's `asOfDate`.
import type {
  CalculationExplanation,
  CalculationStep,
  ExplanationResponse,
  FinancialSnapshot,
  GoalOutcomeValue,
  MoneyValue,
  Outcome,
  SourceRef,
} from '../clarity/contracts';
import { goalEnvelope } from './goalFixtures';
import { homeSnapshot, insight, planOutcome, spendingOutcome } from './homeSummaryFixtures';

export interface FakeGoal {
  id: number;
  name: string;
  targetMinor: number;
  savedMinor: number;
  targetDate: string | null;
  /** Record version. Zero until the first confirmed change. */
  version: number;
}

export interface GoalsBackendRequest {
  method: string;
  /** Path below `/api`, without the query string, such as `/finance/goals/7`. */
  path: string;
  query?: URLSearchParams;
  body?: unknown;
  /** Header names in lower case. */
  headers?: Record<string, string>;
}

export interface GoalsBackendReply {
  status: number;
  body: unknown;
}

export interface FakeGoalsInit {
  /** Rupees for `target` and `saved`. A legacy-invalid row may break the bounds, for example `saved > target` or `date: null`. */
  goals?: Array<{ id?: number; name: string; target: number; saved?: number; date: string | null }>;
  /** The current local date. Defaults to the 15th of the viewed month. */
  today?: string;
  /** Monthly savings target in rupees. `null` means the monthly pay has not been entered. Defaults to 16,000. */
  savingsTarget?: number | null;
}

type Issue = { code: string; field: string; constraint: unknown; message: string };

const DATE_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MAX_NAME = 60;
const money = (amountMinor: number): MoneyValue => ({ currency: 'INR', amountMinor });

function error(status: number, code: string, message: string, extra: Record<string, unknown> = {}): GoalsBackendReply {
  return { status, body: { error: { code, message, ...extra } } };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stable(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
}

function parseDate(value: unknown): { year: number; month: number; day: number } | null {
  const match = typeof value === 'string' ? DATE_PATTERN.exec(value) : null;
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])] as [number, number, number];
  const real = new Date(Date.UTC(year, month - 1, day));
  return real.getUTCMonth() === month - 1 && real.getUTCDate() === day ? { year, month, day } : null;
}

/** The server's inclusive count of contribution months from today's month through the target month. */
export function contributionOpportunities(today: string, targetDate: string): number {
  const now = parseDate(today);
  const target = parseDate(targetDate);
  if (!now || !target || targetDate < today) return 0;
  return (target.year - now.year) * 12 + target.month - now.month + 1;
}

const ceilDiv = (numerator: number, divisor: number) => Math.ceil(numerator / divisor);

export class FakeGoalsBackend {
  readonly month: string;
  today: string;
  dataVersion = 1;
  readonly goals: FakeGoal[];
  /** Whole paise, or null when the monthly pay is missing. */
  savingsTargetMinor: number | null;
  /** Every request this backend handled, in order. */
  readonly log: Array<{ method: string; path: string; body: unknown; idempotencyKey?: string }> = [];
  private nextId: number;
  private nextChangeId = 300;
  private readonly replies = new Map<string, { fingerprint: string; reply: GoalsBackendReply }>();
  private readonly injected = new Map<string, GoalsBackendReply[]>();

  constructor(month: string, init: FakeGoalsInit = {}) {
    this.month = month;
    this.today = init.today ?? `${month}-15`;
    this.savingsTargetMinor = init.savingsTarget === null ? null : Math.round((init.savingsTarget ?? 16000) * 100);
    this.goals = (init.goals ?? []).map((goal, index) => ({
      id: goal.id ?? index + 1,
      name: goal.name,
      targetMinor: Math.round(goal.target * 100),
      savedMinor: Math.round((goal.saved ?? 0) * 100),
      targetDate: goal.date,
      version: 0,
    }));
    this.nextId = Math.max(0, ...this.goals.map((goal) => goal.id)) + 1;
  }

  /** The next request for `METHOD /path` fails with this reply, and no state changes. */
  failNext(method: string, path: string, status: number, code: string, message: string, extra: Record<string, unknown> = {}): void {
    const key = `${method} ${path}`;
    this.injected.set(key, [...(this.injected.get(key) ?? []), error(status, code, message, extra)]);
  }

  /** Another client changed this goal: its record version and the data version move on. */
  changeElsewhere(id: number): void {
    const goal = this.find(id);
    if (!goal) throw new Error(`No goal ${id}`);
    goal.version += 1;
    this.dataVersion += 1;
  }

  /** The monthly pay (savings target) changed on the Plan page. `null` removes it. */
  setSavingsTarget(rupeesAmount: number | null): void {
    this.savingsTargetMinor = rupeesAmount === null ? null : Math.round(rupeesAmount * 100);
    this.dataVersion += 1;
  }

  find(id: number): FakeGoal | undefined {
    return this.goals.find((goal) => goal.id === id);
  }

  // ---- the server's goal rules ----

  /** First stored-value problem, as the snapshot reports it. Null when the goal can be calculated. */
  private storedIssue(goal: FakeGoal): { input: string; constraint: string } | null {
    if (goal.name.trim() === '') return { input: `goal:${goal.id}.name`, constraint: 'at least one non-whitespace character' };
    if (!Number.isSafeInteger(goal.targetMinor) || goal.targetMinor <= 0) {
      return { input: `goal:${goal.id}.targetAmountMinor`, constraint: 'a positive safe integer number of paise' };
    }
    if (!Number.isSafeInteger(goal.savedMinor) || goal.savedMinor < 0 || goal.savedMinor > goal.targetMinor) {
      return { input: `goal:${goal.id}.savedAmountMinor`, constraint: `from 0 through ${goal.targetMinor} paise, inclusive` };
    }
    if (!parseDate(goal.targetDate)) {
      return { input: `goal:${goal.id}.targetDate`, constraint: 'a valid YYYY-MM-DD calendar date' };
    }
    return null;
  }

  /** The calculated value for a goal with valid stored values. */
  calculate(goal: FakeGoal): GoalOutcomeValue {
    const gap = goal.targetMinor - goal.savedMinor;
    const date = goal.targetDate as string;
    const opportunities = contributionOpportunities(this.today, date);
    const base = {
      goalId: goal.id,
      contributionOpportunities: opportunities,
      missingPlanInput: null,
    };
    if (gap === 0) {
      return { ...base, status: 'funded', fundingGap: money(0), requiredContribution: money(0), feasibility: 'funded', capacityDifference: null };
    }
    if (date < this.today) {
      return {
        ...base,
        status: 'overdue',
        fundingGap: money(gap),
        requiredContribution: null,
        feasibility: 'overdue',
        capacityDifference: null,
        revisionRequest: { fields: ['targetAmountMinor', 'targetDate'], action: 'revise_target_amount_or_date' },
      };
    }
    const required = ceilDiv(gap, opportunities);
    const active = { ...base, status: 'active' as const, fundingGap: money(gap), requiredContribution: money(required) };
    const savings = this.savingsTargetMinor;
    if (savings === null) return { ...active, feasibility: 'unavailable', capacityDifference: null, missingPlanInput: 'salary' };
    if (required <= savings) return { ...active, feasibility: 'feasible', capacityDifference: money(savings - required) };
    const revisedTarget = goal.savedMinor + savings * opportunities;
    return {
      ...active,
      feasibility: 'not_feasible',
      capacityDifference: money(required - savings),
      ...(revisedTarget > 0 ? { revision: { targetAmount: money(revisedTarget) } } : {}),
    };
  }

  private outcomeOf(goal: FakeGoal): Outcome<GoalOutcomeValue> {
    const id = `goal:${goal.id}`;
    const base = {
      id,
      kind: 'goal' as const,
      status: 'available' as const,
      classification: 'calculated_result' as const,
      dataVersion: this.dataVersion,
      period: this.snapshotBase().outcomes.monthlyPlan.period,
      sourceRefs: this.sourceRefs(goal),
      explanationRef: { outcomeId: id, dataVersion: this.dataVersion },
    };
    const issue = this.storedIssue(goal);
    if (issue) {
      const { explanationRef: _unused, ...withoutExplanation } = base;
      return {
        ...withoutExplanation,
        status: 'invalid_input',
        invalid: [{ input: issue.input, constraint: issue.constraint, affects: ['goal'] }],
      };
    }
    return { ...base, value: this.calculate(goal) };
  }

  /** Overdue first, then the earliest target date, the larger gap, the name, and the id. */
  private urgencyOrder(): FakeGoal[] {
    return this.goals
      .filter((goal) => !this.storedIssue(goal) && goal.targetMinor - goal.savedMinor > 0)
      .sort((a, b) => {
        const overdue = Number((b.targetDate as string) < this.today) - Number((a.targetDate as string) < this.today);
        if (overdue !== 0) return overdue;
        if (a.targetDate !== b.targetDate) return (a.targetDate as string) < (b.targetDate as string) ? -1 : 1;
        const gap = (b.targetMinor - b.savedMinor) - (a.targetMinor - a.savedMinor);
        if (gap !== 0) return gap;
        const name = a.name.trim().toLocaleLowerCase('en-IN');
        const other = b.name.trim().toLocaleLowerCase('en-IN');
        if (name !== other) return name < other ? -1 : 1;
        return a.id - b.id;
      });
  }

  private sourceRefs(goal: FakeGoal): SourceRef[] {
    const label = goal.name || `Goal ${goal.id}`;
    const refs: SourceRef[] = [
      { ref: `goal:${goal.id}:targetAmountMinor`, sourceType: 'goal', recordId: goal.id, field: 'targetAmountMinor', label: `${label} target amount`, value: money(goal.targetMinor) },
      { ref: `goal:${goal.id}:savedAmountMinor`, sourceType: 'goal', recordId: goal.id, field: 'savedAmountMinor', label: `${label} saved amount`, value: money(goal.savedMinor) },
    ];
    if (goal.targetDate) {
      refs.push({ ref: `goal:${goal.id}:targetDate`, sourceType: 'goal', recordId: goal.id, field: 'targetDate', label: `${label} target date`, value: goal.targetDate });
    }
    return refs.map((source, index) => ({ ...source, order: index + 1 }));
  }

  private snapshotBase(): FinancialSnapshot {
    return homeSnapshot(this.month, { dataVersion: this.dataVersion, actions: [], goals: [], trips: [] });
  }

  /** Confirmed snapshot of the current month: server-calculated goal outcomes, the urgent goal, and the goal action. */
  snapshot(): FinancialSnapshot {
    const base = this.snapshotBase();
    const ordered = this.urgencyOrder();
    const urgent = ordered[0];
    const overdue = urgent ? (urgent.targetDate as string) < this.today : false;
    const missingPay = this.savingsTargetMinor === null;
    const plan = missingPay
      ? {
          ...planOutcome(this.month, this.dataVersion),
          status: 'missing_input' as const,
          value: undefined,
          missing: [{ input: 'salary', unlocks: ['monthly_plan' as const, 'spending' as const] }],
        }
      : planOutcome(this.month, this.dataVersion);
    const spending = missingPay
      ? {
          ...spendingOutcome(this.month, this.dataVersion),
          status: 'missing_input' as const,
          value: undefined,
          missing: [{ input: 'salary', unlocks: ['monthly_plan' as const, 'spending' as const] }],
        }
      : spendingOutcome(this.month, this.dataVersion);
    return {
      ...base,
      period: { ...base.period, asOfDate: this.today },
      highlights: {
        urgentGoal: urgent
          ? {
              goalId: urgent.id,
              name: urgent.name,
              status: overdue ? 'overdue' : 'active',
              targetDate: urgent.targetDate as string,
              fundingGap: money(urgent.targetMinor - urgent.savedMinor),
            }
          : null,
        nearestTripSettlement: null,
      },
      outcomes: {
        ...base.outcomes,
        monthlyPlan: plan,
        spending,
        goals: [...this.goals].sort((a, b) => a.id - b.id).map((goal) => this.outcomeOf(goal)),
      },
      actions: urgent
        ? [insight(overdue ? 'revise_goal_target' : 'contribute_to_goal', {
            id: `action:${overdue ? 'revise_goal_target' : 'contribute_to_goal'}:goal:${urgent.id}`,
            observation: `The goal “${urgent.name}” ${overdue ? 'is overdue and ' : ''}still has a funding gap.`,
            actionLabel: overdue ? 'Revise goal target' : 'Contribute to goal',
            deadline: urgent.targetDate as string,
            shortfall: money(urgent.targetMinor - urgent.savedMinor),
            context: { recordType: 'goal', recordId: urgent.id },
          })]
        : [],
    };
  }

  /** Sources, then the ordered steps from entered values to the feasibility difference. */
  explanation(goal: FakeGoal): CalculationExplanation<GoalOutcomeValue> {
    const value = this.calculate(goal);
    const sources = this.sourceRefs(goal);
    const [target, saved] = sources as [SourceRef, SourceRef];
    const operations: CalculationStep[] = [{
      order: 1,
      stage: 'funding_gap',
      operation: 'subtract',
      operandRefs: [target.ref as string, saved.ref as string],
      result: value.fundingGap,
      explanationKey: 'goal.funding_gap',
    }];
    if (value.requiredContribution) {
      operations.push({
        order: 2,
        stage: 'required_contribution',
        operation: 'ceil',
        operandRefs: ['result:funding_gap', 'result:contribution_opportunities'],
        divisor: value.contributionOpportunities,
        result: value.requiredContribution,
        explanationKey: 'goal.required_contribution',
      });
    }
    if (value.capacityDifference) {
      operations.push({
        order: operations.length + 1,
        stage: 'feasibility',
        operation: 'subtract',
        operandRefs: ['result:savings_target', 'result:required_contribution'],
        result: value.capacityDifference,
        explanationKey: 'goal.feasibility_difference',
      });
    }
    return {
      schemaVersion: 1,
      outcomeId: `goal:${goal.id}`,
      kind: 'goal',
      status: 'available',
      classification: 'calculated_result',
      dataVersion: this.dataVersion,
      period: this.snapshotBase().outcomes.monthlyPlan.period,
      currency: 'INR',
      precisionMinor: 1,
      sourceRefs: sources,
      operations,
      rounding: { precisionMinor: 1, direction: 'up', adjustmentMinor: 0 },
      result: { classification: 'calculated_result', value },
    };
  }

  // ---- requests ----

  handle(request: GoalsBackendRequest): GoalsBackendReply {
    const method = request.method.toUpperCase();
    const path = request.path;
    const idempotencyKey = request.headers?.['idempotency-key'];
    this.log.push({ method, path, body: request.body, ...(idempotencyKey ? { idempotencyKey } : {}) });
    const injected = this.injected.get(`${method} ${path}`)?.shift();
    if (injected) return injected;
    if (method === 'GET') return this.read(path, request.query);

    const fingerprint = stable({ method, path, body: request.body ?? {} });
    const earlier = idempotencyKey ? this.replies.get(idempotencyKey) : undefined;
    if (earlier) {
      if (earlier.fingerprint !== fingerprint) {
        return error(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was already used for a different financial command.', { field: 'idempotencyKey' });
      }
      const envelope = asRecord(earlier.reply.body);
      return { status: 200, body: { ...envelope, mutation: { ...asRecord(envelope.mutation), replayed: true } } };
    }
    const reply = this.mutate(method, path, asRecord(request.body), idempotencyKey ?? 'server-key');
    if (idempotencyKey && reply.status === 200) this.replies.set(idempotencyKey, { fingerprint, reply });
    return reply;
  }

  private read(path: string, query: URLSearchParams | undefined): GoalsBackendReply {
    if (path === '/finance/clarity') return { status: 200, body: { schemaVersion: 1, snapshot: this.snapshot() } };
    if (path === '/finance/goals') {
      const rows = [...this.goals].sort((a, b) => b.id - a.id).map((goal) => ({
        id: goal.id,
        name: goal.name,
        target_amount: goal.targetMinor / 100,
        saved_amount: goal.savedMinor / 100,
        target_date: goal.targetDate,
        created_at: '2026-01-01 00:00:00',
        updated_at: '2026-01-01 00:00:00',
      }));
      return { status: 200, body: { goals: rows } };
    }
    const explanation = /^\/finance\/explanations\/(.+)$/.exec(path);
    if (explanation) {
      const match = /^goal:(\d+)$/.exec(decodeURIComponent(explanation[1] as string));
      const goal = match ? this.find(Number(match[1])) : undefined;
      if (!goal || this.storedIssue(goal)) return error(404, 'OUTCOME_NOT_FOUND', 'No explanation for this outcome.');
      const requested = Number(query?.get('version'));
      if (Number.isFinite(requested) && requested > this.dataVersion) {
        return error(409, 'DATA_VERSION_NOT_AVAILABLE', 'That version is not confirmed yet.', { currentVersion: this.dataVersion });
      }
      const response: ExplanationResponse<GoalOutcomeValue> = {
        schemaVersion: 1,
        ...(Number.isFinite(requested) && requested < this.dataVersion ? { supersededByVersion: this.dataVersion } : {}),
        explanation: this.explanation(goal),
      };
      return { status: 200, body: response };
    }
    return error(404, 'NOT_FOUND', `No fixture for GET ${path}.`);
  }

  // ---- mutations ----

  private mutate(method: string, path: string, body: Record<string, unknown>, idempotencyKey: string): GoalsBackendReply {
    const one = /^\/finance\/goals\/(\d+)$/.exec(path);
    const contribution = /^\/finance\/goals\/(\d+)\/contributions$/.exec(path);
    let applied: { operation: 'goal.create' | 'goal.update' | 'goal.delete' | 'goal.contribute'; goal: FakeGoal; deleted?: boolean } | GoalsBackendReply;
    if (method === 'POST' && path === '/finance/goals') applied = this.create(body);
    else if (one && method === 'PATCH') applied = this.update(Number(one[1]), body);
    else if (one && method === 'DELETE') applied = this.remove(Number(one[1]), body);
    else if (contribution && method === 'POST') applied = this.contribute(Number(contribution[1]), body);
    else return error(404, 'NOT_FOUND', `No fixture for ${method} ${path}.`);
    if ('status' in applied) return applied;

    this.dataVersion += 1;
    const { goal, operation, deleted } = applied;
    const envelope = goalEnvelope(this.snapshot(), {
      operation,
      goalId: goal.id,
      recordVersion: goal.version,
      changeId: this.nextChangeId++,
      record: deleted ? null : { id: goal.id, name: goal.name, targetAmountMinor: goal.targetMinor, savedAmountMinor: goal.savedMinor, targetDate: goal.targetDate },
    });
    return { status: 200, body: { ...envelope, mutation: { ...envelope.mutation, idempotencyKey } } };
  }

  private nameIssue(name: unknown): Issue | null {
    if (typeof name !== 'string' || name.trim().length === 0) {
      return { code: 'INVALID_GOAL_NAME', field: 'name', constraint: 'at least one non-whitespace character', message: 'Goal name must contain at least one non-whitespace character.' };
    }
    if (name.trim().length > MAX_NAME) {
      return { code: 'INVALID_GOAL_NAME', field: 'name', constraint: { minLength: 1, maxLength: MAX_NAME }, message: `Goal name must contain at most ${MAX_NAME} characters.` };
    }
    return null;
  }

  /** Field checks for a candidate goal, in the server's order. The date is checked against today only when asked. */
  private issuesOf(candidate: { name: unknown; targetMinor: unknown; savedMinor: unknown; targetDate: unknown }, checkDateAgainstToday: boolean): Issue[] {
    const issues: Issue[] = [];
    const name = this.nameIssue(candidate.name);
    if (name) issues.push(name);
    const target = candidate.targetMinor;
    const targetOk = Number.isSafeInteger(target);
    if (!targetOk || (target as number) <= 0) {
      issues.push({ code: 'INVALID_GOAL_TARGET_AMOUNT', field: 'targetAmountMinor', constraint: 'a positive safe integer number of paise', message: 'Target amount must be greater than zero and use whole paise.' });
    }
    const saved = candidate.savedMinor;
    if (!Number.isSafeInteger(saved) || (saved as number) < 0) {
      issues.push({ code: 'INVALID_GOAL_SAVED_AMOUNT', field: 'savedAmountMinor', constraint: 'a non-negative safe integer number of paise', message: 'Amount already saved must be zero or greater and use whole paise.' });
    } else if (targetOk && (target as number) > 0 && (saved as number) > (target as number)) {
      issues.push({ code: 'GOAL_SAVED_AMOUNT_EXCEEDS_TARGET', field: 'savedAmountMinor', constraint: `from 0 through ${target as number} paise, inclusive`, message: 'Amount already saved must not exceed the target amount.' });
    }
    if (!parseDate(candidate.targetDate)) {
      issues.push({ code: 'INVALID_GOAL_TARGET_DATE', field: 'targetDate', constraint: 'a valid YYYY-MM-DD calendar date', message: 'Target date must be a valid calendar date.' });
    } else if (checkDateAgainstToday && (candidate.targetDate as string) < this.today) {
      issues.push({ code: 'GOAL_TARGET_DATE_IN_PAST', field: 'targetDate', constraint: `a date on or after ${this.today}`, message: `Target date must be on or after ${this.today}.` });
    }
    return issues;
  }

  private rejected(issues: Issue[], code?: string): GoalsBackendReply {
    const [first] = issues as [Issue];
    return error(422, code ?? first.code, first.message, { field: first.field, constraint: first.constraint, errors: issues });
  }

  private versionConflict(body: Record<string, unknown>, current: number): GoalsBackendReply | null {
    if (body.expectedRecordVersion === undefined || body.expectedRecordVersion === current) return null;
    return error(409, 'RECORD_VERSION_CONFLICT', 'Financial record changed since it was last confirmed.', { currentRecordVersion: current });
  }

  private integerField(body: Record<string, unknown>, key: string, fallback?: number): number | undefined | GoalsBackendReply {
    if (!(key in body)) return fallback;
    if (!Number.isSafeInteger(body[key])) {
      return error(400, 'INVALID_GOAL_AMOUNT_FORMAT', `${key} must be an integer number of paise.`, { field: key });
    }
    return body[key] as number;
  }

  private create(body: Record<string, unknown>) {
    const target = this.integerField(body, 'targetAmountMinor');
    if (typeof target === 'object') return target;
    const saved = this.integerField(body, 'savedAmountMinor', 0);
    if (typeof saved === 'object') return saved;
    const candidate = {
      name: typeof body.name === 'string' ? body.name.trim() : null,
      targetMinor: target ?? null,
      savedMinor: saved,
      targetDate: typeof body.targetDate === 'string' ? body.targetDate : null,
    };
    const issues = this.issuesOf(candidate, true);
    if (issues.length > 0) return this.rejected(issues);
    const goal: FakeGoal = {
      id: this.nextId++,
      name: candidate.name as string,
      targetMinor: candidate.targetMinor as number,
      savedMinor: candidate.savedMinor as number,
      targetDate: candidate.targetDate,
      version: 1,
    };
    this.goals.push(goal);
    return { operation: 'goal.create' as const, goal };
  }

  private update(id: number, body: Record<string, unknown>) {
    const goal = this.find(id);
    if (typeof body.addToSaved !== 'undefined') {
      return error(400, 'GOAL_ADD_TO_SAVED_NOT_SUPPORTED', 'Record contributions with POST /goals/:id/contributions.', { field: 'addToSaved' });
    }
    const target = this.integerField(body, 'targetAmountMinor');
    if (typeof target === 'object') return target;
    const saved = this.integerField(body, 'savedAmountMinor');
    if (typeof saved === 'object') return saved;
    const patch: Partial<Record<'name' | 'targetMinor' | 'savedMinor' | 'targetDate', unknown>> = {};
    if ('name' in body) patch.name = typeof body.name === 'string' ? body.name.trim() : null;
    if (target !== undefined) patch.targetMinor = target;
    if (saved !== undefined) patch.savedMinor = saved;
    if ('targetDate' in body) patch.targetDate = typeof body.targetDate === 'string' ? body.targetDate : null;
    if (Object.keys(patch).length === 0) return error(400, 'EMPTY_GOAL_UPDATE', 'At least one goal field must be updated.');
    if (!goal) return error(404, 'RECORD_NOT_FOUND', 'That goal no longer exists.');

    const merged = {
      name: goal.name, targetMinor: goal.targetMinor, savedMinor: goal.savedMinor, targetDate: goal.targetDate, ...patch,
    };
    const dateChanged = 'targetDate' in patch && patch.targetDate !== goal.targetDate;
    let issues = this.issuesOf(merged, dateChanged);
    if (this.storedIssue(goal)) {
      // A legacy row that breaks the bounds: only what this change touches must be valid.
      const touched = new Set((Object.keys(patch) as Array<keyof typeof patch>).filter((key) => !Object.is(patch[key], goal[key])));
      const field: Record<string, string> = { name: 'name', targetMinor: 'targetAmountMinor', savedMinor: 'savedAmountMinor', targetDate: 'targetDate' };
      const touchedFields = new Set([...touched].map((key) => field[key] as string));
      const amountsTouched = touchedFields.has('targetAmountMinor') || touchedFields.has('savedAmountMinor');
      issues = issues.filter((issue) => touchedFields.has(issue.field) || (issue.code === 'GOAL_SAVED_AMOUNT_EXCEEDS_TARGET' && amountsTouched));
    }
    if (issues.length > 0) return this.rejected(issues);
    const stale = this.versionConflict(body, goal.version);
    if (stale) return stale;
    goal.name = merged.name as string;
    goal.targetMinor = merged.targetMinor as number;
    goal.savedMinor = merged.savedMinor as number;
    goal.targetDate = merged.targetDate as string | null;
    goal.version += 1;
    return { operation: 'goal.update' as const, goal };
  }

  private remove(id: number, body: Record<string, unknown>) {
    const goal = this.find(id);
    if (!goal) return error(404, 'RECORD_NOT_FOUND', 'That goal no longer exists.');
    const stale = this.versionConflict(body, goal.version);
    if (stale) return stale;
    this.goals.splice(this.goals.indexOf(goal), 1);
    return { operation: 'goal.delete' as const, goal: { ...goal, version: goal.version + 1 }, deleted: true };
  }

  private contribute(id: number, body: Record<string, unknown>) {
    const amount = body.contributionMinor;
    if (!('contributionMinor' in body)) {
      return error(400, 'GOAL_CONTRIBUTION_REQUIRED', 'A contribution amount is required.', { field: 'contributionMinor' });
    }
    if (!Number.isSafeInteger(amount)) {
      return error(400, 'INVALID_GOAL_CONTRIBUTION', 'contributionMinor must be an integer number of paise.', { field: 'contributionMinor' });
    }
    const goal = this.find(id);
    if (!goal) return error(404, 'RECORD_NOT_FOUND', 'That goal no longer exists.');
    const stored = this.storedIssue(goal);
    if (stored) {
      const issues = this.issuesOf(goal, false);
      return this.rejected(issues.length > 0 ? issues : [{ code: 'INVALID_GOAL_DATA', field: 'goal', constraint: stored.constraint, message: 'Goal data must be corrected.' }], 'GOAL_REQUIRES_CORRECTION');
    }
    const gap = goal.targetMinor - goal.savedMinor;
    const contributionMinor = amount as number;
    if (contributionMinor <= 0 || contributionMinor > gap) {
      const constraint = { minMinor: 1, maxMinor: gap, integer: true };
      return error(422, 'GOAL_CONTRIBUTION_OUT_OF_RANGE', gap === 0 ? 'This goal is already fully funded, so no contribution is accepted.' : `Contribution must be between 1 and ${gap} paise.`, {
        field: 'contributionMinor',
        constraint,
        errors: [{ code: 'GOAL_CONTRIBUTION_OUT_OF_RANGE', field: 'contributionMinor', constraint, message: `Contribution must be between 1 and ${gap} paise.` }],
      });
    }
    const stale = this.versionConflict(body, goal.version);
    if (stale) return stale;
    goal.savedMinor += contributionMinor;
    goal.version += 1;
    return { operation: 'goal.contribute' as const, goal };
  }
}

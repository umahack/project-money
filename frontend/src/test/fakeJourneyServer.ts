// In-memory journey routes shared by the Vitest suites and the Playwright journey spec.
// It must not import Vitest, so browser specs can use it.
import { currentMonth } from '../money';

export type DesiredOutcome = 'plan_month' | 'control_spending' | 'fund_goal' | 'settle_trip';

/** Mirrors `JOURNEY_DEFINITIONS` on the server. */
export const DEFINITIONS: Record<DesiredOutcome, { required: string[]; optional: string[] }> = {
  plan_month: { required: ['salary'], optional: ['bills'] },
  control_spending: { required: ['salary', 'expense'], optional: ['bills', 'category_treatment'] },
  fund_goal: { required: ['goal'], optional: ['monthly_plan'] },
  settle_trip: { required: ['trip', 'trip_members', 'trip_split'], optional: ['personal_expense'] },
};

const FIRST_OUTCOME_KIND: Record<DesiredOutcome, string> = {
  plan_month: 'monthly_plan',
  control_spending: 'spending',
  fund_goal: 'goal',
  settle_trip: 'trip',
};

/** What the server says skipping each optional step leaves unchanged. Mirrors `STEP_REGISTRY.affectedOutcome`. */
export const SKIP_OUTCOME: Record<string, string> = {
  bills: 'disposable_income',
  category_treatment: 'daily_spending_guide',
  monthly_plan: 'goal_feasibility',
  personal_expense: 'remaining_spendable_budget',
};

export interface JourneyCall {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}

export type Reply = { status: number; body: unknown };

/**
 * A small stand-in for the journey routes. It follows the server's rules that the
 * client depends on: steps come from the fixed definitions, a step is done only
 * when a confirmed record satisfies it, a different outcome while one is open is
 * rejected, and a repeated start for the same outcome returns the open journey.
 */
export class FakeJourneyServer {
  /** Steps that current confirmed records satisfy. Tests change this to simulate saved records. */
  satisfied = new Set<string>();
  /** Optional steps the user skipped. A skip writes no financial record, so `satisfied` never changes. */
  skipped = new Set<string>();
  /** Ids the first-outcome reference uses once it exists. */
  tripId = 7;
  goalId = 11;
  journey: { id: number; desiredOutcome: DesiredOutcome; status: 'active' | 'paused' | 'completed' } | null = null;
  startsCreated = 0;
  private nextId = 1;
  private nextFailure = new Map<string, Reply>();

  /** Makes the next `METHOD path-suffix` request fail once, for example `PATCH complete_step`. */
  failNext(key: string, reply: Reply): void {
    this.nextFailure.set(key, reply);
  }

  open(desiredOutcome: DesiredOutcome, status: 'active' | 'paused' = 'active'): void {
    this.journey = { id: this.nextId++, desiredOutcome, status };
    this.skipped.clear();
  }

  view() {
    const journey = this.journey;
    if (!journey) return null;
    const definition = DEFINITIONS[journey.desiredOutcome];
    const remaining = definition.required.filter((key) => !this.satisfied.has(key));
    const firstOutcomeAvailable = remaining.length === 0;
    const nextOptional = firstOutcomeAvailable
      ? definition.optional.find((key) => !this.satisfied.has(key) && !this.skipped.has(key))
      : undefined;
    const currentStepKey = journey.status === 'completed' ? null : remaining[0] ?? nextOptional ?? null;
    const steps = [...definition.required, ...definition.optional].map((key) => {
      const required = definition.required.includes(key);
      const satisfied = this.satisfied.has(key);
      return {
        key,
        required,
        category: key,
        status: satisfied ? 'satisfied' : !required && this.skipped.has(key) ? 'skipped' : 'pending',
        unlocks: key,
        confirmedChangeId: satisfied ? 900 : null,
        ...(required
          ? {}
          : {
            offered: firstOutcomeAvailable,
            skip: {
              financialWrite: false,
              affectedOutcome: SKIP_OUTCOME[key],
              availableOutcomeKind: FIRST_OUTCOME_KIND[journey.desiredOutcome],
            },
          }),
      };
    });
    const outcomeId = !firstOutcomeAvailable
      ? null
      : journey.desiredOutcome === 'settle_trip'
        ? `trip:${this.tripId}`
        : journey.desiredOutcome === 'fund_goal'
          ? `goal:${this.goalId}`
          : journey.desiredOutcome === 'control_spending'
            ? `spending:${currentMonth()}`
            : `monthly-plan:${currentMonth()}`;
    return {
      id: journey.id,
      desiredOutcome: journey.desiredOutcome,
      status: journey.status,
      requiredStepKeys: definition.required,
      optionalStepKeys: definition.optional,
      currentStepKey,
      nextIncompleteStepKey: remaining[0] ?? null,
      completedRequiredStepKeys: definition.required.filter((key) => this.satisfied.has(key)),
      remainingRequiredStepKeys: remaining,
      progress: {
        requiredTotal: definition.required.length,
        requiredCompleted: definition.required.length - remaining.length,
        requiredRemaining: remaining.length,
        currentStepNumber: remaining[0] ? definition.required.indexOf(remaining[0]) + 1 : null,
      },
      steps,
      firstOutcome: { available: firstOutcomeAvailable, kind: FIRST_OUTCOME_KIND[journey.desiredOutcome], outcomeId },
      optionalOffered: firstOutcomeAvailable,
      nextChoice: currentStepKey === null
        ? null
        : { stepKey: currentStepKey, required: remaining.length > 0, skippable: remaining.length === 0 },
      clarityConfirmation: { available: firstOutcomeAvailable && journey.status !== 'completed', completed: journey.status === 'completed' },
    };
  }

  handle(call: JourneyCall): Reply | null {
    const { method, path, body } = call;
    const failure = this.nextFailure.get(`${method} ${body?.action ?? path}`);
    if (failure && path.startsWith('/clarity/journeys')) {
      this.nextFailure.delete(`${method} ${body?.action ?? path}`);
      return failure;
    }
    if (method === 'GET' && path === '/clarity/journeys/active') {
      return { status: 200, body: { schemaVersion: 1, journey: this.journey?.status === 'completed' ? null : this.view() } };
    }
    if (method === 'POST' && path === '/clarity/journeys') {
      const keys = Object.keys(body ?? {});
      const outcome = body?.desiredOutcome;
      if (keys.length !== 1 || typeof outcome !== 'string' || !(outcome in DEFINITIONS)) {
        return { status: 400, body: { error: { code: 'INVALID_DESIRED_OUTCOME', message: 'desiredOutcome must be one of the four fixed journey outcomes.' } } };
      }
      const desired = outcome as DesiredOutcome;
      if (this.journey && this.journey.status !== 'completed') {
        if (this.journey.desiredOutcome !== desired) {
          return { status: 409, body: { error: { code: 'JOURNEY_ALREADY_ACTIVE', message: 'Finish or pause the current journey before starting a different one.' } } };
        }
        this.journey.status = 'active';
        return { status: 200, body: { schemaVersion: 1, journey: this.view() } };
      }
      this.startsCreated += 1;
      this.open(desired);
      return { status: 201, body: { schemaVersion: 1, journey: this.view() } };
    }
    const match = /^\/clarity\/journeys\/(\d+)$/.exec(path);
    if (method === 'PATCH' && match) {
      if (!this.journey || this.journey.id !== Number(match[1])) {
        return { status: 404, body: { error: { code: 'JOURNEY_NOT_FOUND', message: 'Journey was not found.' } } };
      }
      const action = body?.action;
      if (action === 'complete_step') {
        const stepKey = String(body?.stepKey);
        if (!this.satisfied.has(stepKey)) {
          return { status: 409, body: { error: { code: 'STEP_NOT_CONFIRMED', message: 'This step has no confirmed record yet. Save it again to continue.' } } };
        }
      } else if (action === 'skip_step') {
        const stepKey = String(body?.stepKey);
        const definition = DEFINITIONS[this.journey.desiredOutcome];
        if (definition.required.includes(stepKey)) {
          return { status: 422, body: { error: { code: 'STEP_NOT_OPTIONAL', message: 'Required steps cannot be skipped.' } } };
        }
        if (!definition.optional.includes(stepKey)) {
          return { status: 400, body: { error: { code: 'INVALID_STEP_KEY', message: 'stepKey is not a step of this journey.' } } };
        }
        if (definition.required.some((key) => !this.satisfied.has(key))) {
          return { status: 409, body: { error: { code: 'FIRST_OUTCOME_PENDING', message: 'Optional steps are offered after the first outcome is available.' } } };
        }
        if (!this.satisfied.has(stepKey)) this.skipped.add(stepKey);
      } else if (action === 'pause') this.journey.status = 'paused';
      else if (action === 'resume') this.journey.status = 'active';
      else if (action === 'complete') {
        const required = DEFINITIONS[this.journey.desiredOutcome].required;
        if (this.journey.status !== 'completed' && required.some((key) => !this.satisfied.has(key))) {
          return { status: 409, body: { error: { code: 'FIRST_OUTCOME_PENDING', message: 'Complete the remaining required steps before finishing the journey.' } } };
        }
        this.journey.status = 'completed';
      }
      return { status: 200, body: { schemaVersion: 1, journey: this.view(), transition: { action } } };
    }
    return null;
  }
}


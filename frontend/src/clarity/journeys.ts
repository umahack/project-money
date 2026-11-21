// Client side of the server-owned guided journey (`backend/src/routes/journeys.js`).
//
// The server owns the workflow: step keys, which steps a user's confirmed
// records already satisfy, and the next incomplete step. This module holds only
// (1) a fixed registry of the four desired outcomes and the step keys the
// server may return, written as plain-language copy, (2) the typed requests the
// client may send, and (3) the allowlisted journey intent carried through
// sign-up. It never sends steps, record ids, or financial values.
import { ApiError, api } from '../api';
import { buildActionRoute, type ActionPage } from './actionContext';
import { CLARITY_RESPONSES, DESIRED_OUTCOMES, type ClarityResponse, type MeasurementDesiredOutcome } from './measurement';
import type { PurposeOutcomeKey } from './purposeRegistry';
import { selectFinancialClarityRollout } from './rollout';

export const JOURNEY_SCHEMA_VERSION = 1;
export const JOURNEY_START_PARAM = 'start';
export const JOURNEY_ROUTE = '/start';

export type JourneyOutcomeKey = MeasurementDesiredOutcome;

export interface JourneyOutcomeCopy {
  key: JourneyOutcomeKey;
  /** Exact choice label. */
  title: string;
  /** What the user gets, in plain language. */
  description: string;
  /** The minimum the journey asks for, in plain language. */
  needs: string;
  /** Existing page that shows the result of this journey, from the fixed action registry. */
  resultPage: ActionPage;
  resultRoute: string;
  resultLabel: string;
}

type OutcomeSource = Omit<JourneyOutcomeCopy, 'resultRoute'>;

/** The route of a result page always comes from the fixed action registry, never from a string written here. */
function withResultRoute(source: OutcomeSource): JourneyOutcomeCopy {
  return { ...source, resultRoute: buildActionRoute({ page: source.resultPage }) ?? '/' };
}

/** Display order. Keys mirror `JOURNEY_DEFINITIONS` on the server. */
export const JOURNEY_OUTCOMES: readonly JourneyOutcomeCopy[] = Object.freeze(([
  {
    key: 'plan_month',
    title: 'Plan the month',
    description: 'Turn your monthly pay into a clear plan for what to spend and what to save.',
    needs: 'One step: your monthly pay.',
    resultPage: 'plan',
    resultLabel: 'Open your plan',
  },
  {
    key: 'control_spending',
    title: 'Control spending',
    description: 'See how much you can still spend each day after you log an expense.',
    needs: 'Two steps: your monthly pay, then one expense.',
    resultPage: 'spending',
    resultLabel: 'Open spending',
  },
  {
    key: 'fund_goal',
    title: 'Fund a goal',
    description: 'Find out how much to set aside each month to reach a savings goal.',
    needs: 'One step: one goal with a target, an amount saved, and a date.',
    resultPage: 'goals',
    resultLabel: 'Open goals',
  },
  {
    key: 'settle_trip',
    title: 'Settle a trip',
    description: 'See who owes whom after a shared trip. No salary is needed.',
    needs: 'Three steps: create the trip, add the people, and add one shared expense.',
    resultPage: 'trips',
    resultLabel: 'Open trips',
  },
] satisfies OutcomeSource[]).map(withResultRoute));

// Compile-time guard: the registry must name every outcome the measurement client knows.
const REGISTRY_KEYS: readonly string[] = JOURNEY_OUTCOMES.map((outcome) => outcome.key);
if (REGISTRY_KEYS.length !== DESIRED_OUTCOMES.length || !DESIRED_OUTCOMES.every((key) => REGISTRY_KEYS.includes(key))) {
  throw new Error('JOURNEY_OUTCOMES must list exactly the four desired outcomes.');
}

export function isJourneyOutcomeKey(value: unknown): value is JourneyOutcomeKey {
  return typeof value === 'string' && (DESIRED_OUTCOMES as readonly string[]).includes(value);
}

export function outcomeCopy(key: JourneyOutcomeKey): JourneyOutcomeCopy {
  return JOURNEY_OUTCOMES.find((outcome) => outcome.key === key) as JourneyOutcomeCopy;
}

/* ------------------------------ Step registry ------------------------------ */

/**
 * Which existing component hosts a step. Required and optional steps share the
 * same hosts where the input is the same (`pay_optional` is the pay form shown as
 * an optional input in the goal journey).
 */
export type JourneyStepHostKind =
  | 'salary'
  | 'expense'
  | 'goal'
  | 'trip'
  | 'bills'
  | 'pay_optional'
  | 'treatment'
  | 'personal_share'
  | 'none';

/** The outcome shown after a step is confirmed. It always comes from the server's snapshot. */
export type JourneyRevealKind = 'plan' | 'spending' | 'goal' | 'trip' | 'none';

export interface JourneyStepCopy {
  title: string;
  summary: string;
  host: JourneyStepHostKind;
  /**
   * Scope keys of the hosted form's mutations that can complete this step. A
   * confirmed change in any other scope (for example a bill edit) does not carry
   * a `changeId` to the journey.
   */
  scopePattern: RegExp | null;
  /** The outcome revealed once this step is confirmed. */
  reveal: JourneyRevealKind;
  /** What the step unlocked, in plain words. Shown when `reveal` is `none`. */
  unlocked: string;
  /**
   * Optional steps only. The outcome that stays as it is when the step is
   * skipped. It mirrors the server's `affectedOutcome`, which wins when present.
   */
  skipOutcome?: PurposeOutcomeKey;
  /** Optional steps whose host has no purpose panel of its own. One plain sentence. */
  purpose?: string;
}

const NO_SCOPE: RegExp | null = null;

/** Presentation for the fixed step keys the server may return. */
export const JOURNEY_STEPS: Readonly<Record<string, JourneyStepCopy>> = Object.freeze({
  salary: {
    title: 'Add your monthly pay',
    summary: 'Your pay is the starting point for what you can spend and save this month.',
    host: 'salary',
    scopePattern: /^salary:/,
    reveal: 'plan',
    unlocked: 'Your monthly plan',
  },
  expense: {
    title: 'Log one expense',
    summary: 'One expense shows how much you have left to spend and your daily guide.',
    host: 'expense',
    scopePattern: /^(new-expense|expense):/,
    reveal: 'spending',
    unlocked: 'Your remaining spendable amount and daily guide',
  },
  goal: {
    title: 'Add one savings goal',
    summary: 'A goal with a target, an amount saved, and a date shows how much to set aside each month.',
    host: 'goal',
    scopePattern: /^(new-goal|goal):/,
    reveal: 'goal',
    unlocked: 'Your funding gap and required monthly contribution',
  },
  trip: {
    title: 'Create your trip',
    summary: 'Name the trip so its expenses and balances have a place to live.',
    host: 'trip',
    scopePattern: NO_SCOPE,
    reveal: 'none',
    unlocked: 'Your trip is created. Add the people and one shared expense to see who owes whom.',
  },
  trip_members: {
    title: 'Add the people on the trip',
    summary: 'Balances need at least two people.',
    host: 'trip',
    scopePattern: NO_SCOPE,
    reveal: 'none',
    unlocked: 'The people are added. One shared expense will show what each person owes.',
  },
  trip_split: {
    title: 'Add one shared expense',
    summary: 'One shared expense with a split shows what each person owes.',
    host: 'trip',
    scopePattern: NO_SCOPE,
    reveal: 'trip',
    unlocked: 'Each person’s balance and the payments that settle the trip',
  },
  // Optional steps are offered only after the first result.
  bills: {
    title: 'Add monthly bills',
    summary: 'Bills come out of your pay first, so they adjust what is free to spend and save.',
    host: 'bills',
    scopePattern: /^new-bill:/,
    reveal: 'plan',
    unlocked: 'Your plan, adjusted for your bills',
    skipOutcome: 'disposable_income',
  },
  category_treatment: {
    title: 'Choose Needs or Wants for a category',
    summary: 'Counting a category as a need or a want changes how your daily guide is split.',
    host: 'treatment',
    scopePattern: /^category-treatment:/,
    reveal: 'spending',
    unlocked: 'Your spending, with your choice applied',
    skipOutcome: 'daily_spending_guide',
    purpose: 'Some categories can count as a need or a want. Your choice decides which budget each expense comes out of.',
  },
  monthly_plan: {
    title: 'Add pay to check goal feasibility',
    summary: 'Your pay sets the savings target that your goal is compared with.',
    host: 'pay_optional',
    scopePattern: /^salary:/,
    reveal: 'goal',
    unlocked: 'Whether your goal fits inside your savings target',
    skipOutcome: 'goal_feasibility',
  },
  personal_expense: {
    title: 'Include your share in monthly spending',
    summary: 'Adds your share of the trip to this month’s spending.',
    host: 'personal_share',
    scopePattern: NO_SCOPE,
    reveal: 'none',
    unlocked: 'Your share of the trip now counts in this month’s spending.',
    skipOutcome: 'remaining_spendable_budget',
    purpose: 'Your share of a shared trip expense can count as your own spending for the month. It never changes what other people owe.',
  },
});

const FALLBACK_STEP: JourneyStepCopy = Object.freeze({
  title: 'Next step',
  summary: 'This step is not available in this version of the app.',
  host: 'none',
  scopePattern: NO_SCOPE,
  reveal: 'none',
  unlocked: 'Your saved records are unchanged.',
});

export function stepCopy(key: string): JourneyStepCopy {
  const found = Object.hasOwn(JOURNEY_STEPS, key) ? JOURNEY_STEPS[key] : undefined;
  return found ?? FALLBACK_STEP;
}

/* -------------------------------- Server view ------------------------------- */

export type JourneyStatus = 'active' | 'paused' | 'completed' | 'abandoned';
export type JourneyStepStatus = 'satisfied' | 'skipped' | 'pending';

export interface JourneyStepView {
  key: string;
  required: boolean;
  status: JourneyStepStatus;
  confirmedChangeId: number | null;
  /** Optional steps only: the outcome that stays as it is when the step is skipped, as the server names it. */
  skipOutcome: string | null;
}

export interface GuidedJourneyView {
  id: number;
  desiredOutcome: JourneyOutcomeKey;
  status: JourneyStatus;
  requiredStepKeys: string[];
  optionalStepKeys: string[];
  currentStepKey: string | null;
  nextIncompleteStepKey: string | null;
  progress: {
    requiredTotal: number;
    requiredCompleted: number;
    requiredRemaining: number;
    currentStepNumber: number | null;
  };
  steps: JourneyStepView[];
  firstOutcome: {
    available: boolean;
    kind: string;
    /** Reference such as `trip:7`. Null until the first outcome exists. */
    outcomeId: string | null;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const STATUSES: readonly string[] = ['active', 'paused', 'completed', 'abandoned'];
const STEP_STATUSES: readonly string[] = ['satisfied', 'skipped', 'pending'];

function unsupported(): ApiError {
  return new ApiError(0, 'The server returned a journey this version of the app cannot show.', {
    code: 'UNSUPPORTED_JOURNEY_RESPONSE',
  });
}

const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const isKeyList = (value: unknown): value is string[] => (
  Array.isArray(value) && value.every((item) => typeof item === 'string')
);

/** Keeps only the fields the client renders. Anything else on the response is dropped. */
export function parseJourneyView(raw: unknown): GuidedJourneyView {
  if (!isRecord(raw)) throw unsupported();
  const { id, desiredOutcome, status, requiredStepKeys, optionalStepKeys, progress, steps, firstOutcome } = raw;
  if (!Number.isSafeInteger(id) || (id as number) <= 0) throw unsupported();
  if (!isJourneyOutcomeKey(desiredOutcome)) throw unsupported();
  if (typeof status !== 'string' || !STATUSES.includes(status)) throw unsupported();
  if (!isKeyList(requiredStepKeys) || !isKeyList(optionalStepKeys)) throw unsupported();
  if (!isRecord(progress) || !isCount(progress.requiredTotal) || !isCount(progress.requiredCompleted) || !isCount(progress.requiredRemaining)) {
    throw unsupported();
  }
  if (!Array.isArray(steps) || !isRecord(firstOutcome)) throw unsupported();
  const parsedSteps: JourneyStepView[] = steps.map((step) => {
    if (!isRecord(step) || typeof step.key !== 'string' || typeof step.required !== 'boolean') throw unsupported();
    if (typeof step.status !== 'string' || !STEP_STATUSES.includes(step.status)) throw unsupported();
    return {
      key: step.key,
      required: step.required,
      status: step.status as JourneyStepStatus,
      confirmedChangeId: Number.isSafeInteger(step.confirmedChangeId) ? (step.confirmedChangeId as number) : null,
      skipOutcome: isRecord(step.skip) && typeof step.skip.affectedOutcome === 'string' ? step.skip.affectedOutcome : null,
    };
  });
  const keyOrNull = (value: unknown) => (typeof value === 'string' ? value : null);
  return {
    id: id as number,
    desiredOutcome,
    status: status as JourneyStatus,
    requiredStepKeys,
    optionalStepKeys,
    currentStepKey: keyOrNull(raw.currentStepKey),
    nextIncompleteStepKey: keyOrNull(raw.nextIncompleteStepKey),
    progress: {
      requiredTotal: progress.requiredTotal,
      requiredCompleted: progress.requiredCompleted,
      requiredRemaining: progress.requiredRemaining,
      currentStepNumber: Number.isSafeInteger(progress.currentStepNumber) ? (progress.currentStepNumber as number) : null,
    },
    steps: parsedSteps,
    firstOutcome: {
      available: firstOutcome.available === true,
      kind: typeof firstOutcome.kind === 'string' ? firstOutcome.kind : '',
      outcomeId: typeof firstOutcome.outcomeId === 'string' ? firstOutcome.outcomeId : null,
    },
  };
}

function parseEnvelope(raw: unknown): GuidedJourneyView | null {
  if (!isRecord(raw) || raw.schemaVersion !== JOURNEY_SCHEMA_VERSION) throw unsupported();
  return raw.journey === null || raw.journey === undefined ? null : parseJourneyView(raw.journey);
}

/** Text such as "Step 2 of 3; 1 required step remaining." Never relies on color. */
export function describeProgress(journey: GuidedJourneyView): string {
  const { requiredTotal, requiredCompleted, requiredRemaining, currentStepNumber } = journey.progress;
  const noun = (count: number) => `${count} required step${count === 1 ? '' : 's'}`;
  if (requiredRemaining === 0) return `All ${noun(requiredTotal)} done.`;
  const number = currentStepNumber ?? requiredCompleted + 1;
  return `Step ${number} of ${requiredTotal}; ${noun(requiredRemaining)} remaining.`;
}

/* ---------------------------------- Requests --------------------------------- */

/** The only commands the client sends. No step lists, record ids, or values. */
export type JourneyTransition =
  | { action: 'complete_step'; stepKey: string; changeId?: number }
  | { action: 'skip_step'; stepKey: string }
  | { action: 'pause' }
  | { action: 'resume' }
  | { action: 'complete' };

export type JourneyRequest =
  | { kind: 'start'; desiredOutcome: JourneyOutcomeKey }
  | { kind: 'transition'; journeyId: number; transition: JourneyTransition };

export async function fetchActiveJourney(): Promise<GuidedJourneyView | null> {
  return parseEnvelope(await api.get<unknown>('/clarity/journeys/active'));
}

export async function sendJourneyRequest(request: JourneyRequest): Promise<GuidedJourneyView> {
  const raw = request.kind === 'start'
    ? await api.post<unknown>('/clarity/journeys', { desiredOutcome: request.desiredOutcome })
    : await api.patch<unknown>(`/clarity/journeys/${request.journeyId}`, request.transition);
  const view = parseEnvelope(raw);
  if (!view) throw unsupported();
  return view;
}

/* ------------------------------ Registration intent ------------------------------ */

/**
 * Reads a journey intent from a query string. Only a single `start` value that
 * exactly equals one of the four outcome keys is accepted. Anything else
 * (unknown, repeated, empty, or oddly cased) is ignored.
 */
export function parseJourneyIntent(search: string | URLSearchParams | null | undefined): JourneyOutcomeKey | null {
  if (search === null || search === undefined) return null;
  let params: URLSearchParams;
  try {
    params = typeof search === 'string' ? new URLSearchParams(search) : search;
  } catch {
    return null;
  }
  const values = params.getAll(JOURNEY_START_PARAM);
  return values.length === 1 && isJourneyOutcomeKey(values[0]) ? values[0] : null;
}

/** `/register?start=plan_month` and similar. The value is always one of the fixed keys. */
export function withJourneyIntent(path: string, intent: JourneyOutcomeKey | null): string {
  return intent && selectFinancialClarityRollout().enabled ? `${path}?${JOURNEY_START_PARAM}=${intent}` : path;
}

export interface PostAuthTarget {
  isAdmin: boolean;
  /** Query string of the sign-in or sign-up page. */
  search: string;
  /** True when sign-up has just completed. */
  registered: boolean;
}

/**
 * Where to go after sign-in or sign-up. With the rollout flag off this is
 * exactly what the app did before: the admin console or Home.
 */
export function postAuthDestination({ isAdmin, search, registered }: PostAuthTarget): string {
  if (isAdmin) return '/admin';
  if (!selectFinancialClarityRollout().enabled) return '/';
  const intent = parseJourneyIntent(search);
  if (intent) return `${JOURNEY_ROUTE}?${JOURNEY_START_PARAM}=${intent}`;
  return registered ? JOURNEY_ROUTE : '/';
}

/* ------------------------------ Optional steps ------------------------------ */

/**
 * The one optional step to offer now, or null. The server offers optional steps
 * only after the first outcome exists, and one at a time: its current step is
 * the next pending optional step. This reads that answer and never decides it.
 */
export function offeredOptionalStep(journey: GuidedJourneyView): JourneyStepView | null {
  if (journey.status !== 'active' || !journey.firstOutcome.available || journey.currentStepKey === null) return null;
  const step = journey.steps.find((item) => item.key === journey.currentStepKey);
  return step && !step.required && step.status === 'pending' ? step : null;
}

/** The outcome that stays as it is when an optional step is skipped. The server's name wins over the registry. */
export function skipOutcomeFor(step: Pick<JourneyStepView, 'key' | 'skipOutcome'>): string | null {
  return step.skipOutcome ?? stepCopy(step.key).skipOutcome ?? null;
}

const TRIP_OUTCOME_ID = /^trip:([1-9]\d{0,14})$/;
const GOAL_OUTCOME_ID = /^goal:([1-9]\d{0,14})$/;

/** The trip id inside a first-outcome reference such as `trip:7`, or null. */
export function tripIdFromOutcomeId(outcomeId: string | null): number | null {
  const match = outcomeId === null ? null : TRIP_OUTCOME_ID.exec(outcomeId);
  return match ? Number(match[1]) : null;
}

/** The goal id inside a first-outcome reference such as `goal:11`, or null. */
export function goalIdFromOutcomeId(outcomeId: string | null): number | null {
  const match = outcomeId === null ? null : GOAL_OUTCOME_ID.exec(outcomeId);
  return match ? Number(match[1]) : null;
}

/* ------------------------------ Clarity question ----------------------------- */

export const CLARITY_QUESTION = 'Did this make your financial position clearer?';

/** Exactly the three answers the measurement event accepts, in display order. */
export const CLARITY_CHOICES: ReadonlyArray<{ value: ClarityResponse; label: string }> = Object.freeze(
  CLARITY_RESPONSES.map((value) => ({ value, label: value === 'yes' ? 'Yes' : value === 'partly' ? 'Partly' : 'No' })),
);

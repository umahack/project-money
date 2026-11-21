import {
  FALLBACK_ACTIONS,
  buildActionRoute,
  resolveInsightAction,
  type FallbackAction,
} from '../../clarity/actionContext';
import type {
  ActionableInsight,
  FinancialSnapshot,
  GoalOutcomeValue,
  MonthlyPlanValue,
  NearestTripHighlight,
  Outcome,
  SpendingOutcomeValue,
  TripOutcomeValue,
  UrgentGoalHighlight,
} from '../../clarity/contracts';

/** The server never returns more than three actions; the page enforces it again (Requirement 8.8). */
export const MAX_HOME_ACTIONS = 3;

type TripSummaryOutcome = FinancialSnapshot['outcomes']['tripSummary'];

export interface HomeSummaryModel {
  plan: Outcome<MonthlyPlanValue>;
  spending: Outcome<SpendingOutcomeValue>;
  urgentGoal: { highlight: UrgentGoalHighlight; outcome: Outcome<GoalOutcomeValue> } | null;
  /** Goal outcomes that are missing, invalid, stale, or failed. Each is shown in its own card. */
  goalProblems: Array<Outcome<GoalOutcomeValue>>;
  /** At least one goal outcome is available. */
  hasAvailableGoal: boolean;
  goalCount: number;
  tripSummary: TripSummaryOutcome;
  nearestTrip: { highlight: NearestTripHighlight; outcome: Outcome<TripOutcomeValue> } | null;
  tripProblems: Array<Outcome<TripOutcomeValue>>;
  tripCount: number;
  /** Ranked actions in server order, rebuilt from fixed action keys, at most three. */
  actions: ActionableInsight[];
  rawActionCount: number;
  /** True only when no action applies and every outcome is confirmed (Requirement 8.14). */
  noActionNeeded: boolean;
  /** Fixed fallback for the page header when an outcome needs input. */
  headerFallback: FallbackAction | null;
}

/**
 * Reads the snapshot into the Home regions. It only selects and labels values the
 * server calculated; it never computes a financial value (Requirements 8.1 to 8.7).
 */
export function selectHomeSummary(snapshot: FinancialSnapshot): HomeSummaryModel {
  const { monthlyPlan, spending, goals, tripSummary } = snapshot.outcomes;
  const tripItems = tripSummary.items ?? [];
  const highlights = snapshot.highlights;

  const urgentGoalOutcome = highlights?.urgentGoal
    ? goals.find((goal) => goal.id === `goal:${highlights.urgentGoal!.goalId}` && goal.status === 'available')
    : undefined;
  const nearestTripOutcome = highlights?.nearestTripSettlement
    ? tripItems.find((item) => item.id === `trip:${highlights.nearestTripSettlement!.tripId}` && item.status === 'available')
    : undefined;

  const goalProblems = goals.filter((goal) => goal.status !== 'available');
  const tripProblems = tripItems.filter((item) => item.status !== 'available');

  const rawActions = snapshot.actions ?? [];
  const actions: ActionableInsight[] = [];
  for (const insight of rawActions) {
    if (actions.length >= MAX_HOME_ACTIONS) break;
    const resolved = resolveInsightAction(insight);
    if (resolved) actions.push(resolved);
  }

  const everyOutcomeConfirmed = monthlyPlan.status === 'available'
    && spending.status === 'available'
    && goalProblems.length === 0
    && tripSummary.status === 'available'
    && tripProblems.length === 0;

  const needsPay = monthlyPlan.status === 'missing_input'
    && (monthlyPlan.missing ?? []).some(({ input }) => input === 'salary');

  return {
    plan: monthlyPlan,
    spending,
    urgentGoal: highlights?.urgentGoal && urgentGoalOutcome
      ? { highlight: highlights.urgentGoal, outcome: urgentGoalOutcome }
      : null,
    goalProblems,
    hasAvailableGoal: goals.some((goal) => goal.status === 'available'),
    goalCount: goals.length,
    tripSummary,
    nearestTrip: highlights?.nearestTripSettlement && nearestTripOutcome
      ? { highlight: highlights.nearestTripSettlement, outcome: nearestTripOutcome }
      : null,
    tripProblems,
    tripCount: tripItems.length,
    actions,
    rawActionCount: rawActions.length,
    noActionNeeded: rawActions.length === 0 && everyOutcomeConfirmed,
    headerFallback: needsPay
      ? FALLBACK_ACTIONS.planSetPay
      : everyOutcomeConfirmed ? null : FALLBACK_ACTIONS.homeLogSpending,
  };
}

function firstInput(outcome: Outcome<unknown>): { kind: 'missing' | 'invalid'; input: string } | null {
  if (outcome.status === 'missing_input' && outcome.missing?.[0]) {
    return { kind: 'missing', input: outcome.missing[0].input };
  }
  if (outcome.status === 'invalid_input' && outcome.invalid?.[0]) {
    return { kind: 'invalid', input: outcome.invalid[0].input };
  }
  return null;
}

function recordIdOf(input: string, prefix: string): number | undefined {
  const match = new RegExp(`^${prefix}:([1-9][0-9]{0,8})(?:\\.|$)`).exec(input);
  return match ? Number(match[1]) : undefined;
}

/**
 * The existing form that fixes a missing or invalid input, from fixed routes only.
 * Pay and bills go to the Plan form (Requirement 8.12, 8.13); Home has no pay form.
 */
export function correctiveActionFor(outcome: Outcome<unknown>): FallbackAction | null {
  const found = firstInput(outcome);
  if (!found) return null;
  const { kind, input } = found;

  if (input === 'salary' || input.startsWith('salary:')) {
    return kind === 'missing'
      ? FALLBACK_ACTIONS.planSetPay
      : { label: 'Correct this month’s pay', to: FALLBACK_ACTIONS.planSetPay.to };
  }
  if (input === 'bills' || input.startsWith('bill:')) {
    return kind === 'missing' ? FALLBACK_ACTIONS.planAddBills : { label: 'Correct your bills', to: FALLBACK_ACTIONS.planAddBills.to };
  }
  const expenseId = recordIdOf(input, 'expense');
  if (input === 'expenses' || expenseId !== undefined) {
    const to = buildActionRoute({
      page: 'spending',
      action: expenseId === undefined ? 'log-expense' : 'correct-expense',
      params: expenseId === undefined ? {} : { expenseId },
    });
    return to ? { label: 'Correct an expense', to } : null;
  }
  const goalId = recordIdOf(input, 'goal');
  if (goalId !== undefined) {
    const to = buildActionRoute({ page: 'goals', action: 'revise', params: { goalId } });
    return to ? { label: 'Correct this goal', to } : null;
  }
  const tripId = recordIdOf(input, 'trip');
  if (tripId !== undefined) {
    const to = buildActionRoute({ page: 'trip-detail', tripId, params: { tab: 'expenses' } });
    return to ? { label: 'Correct trip expenses', to } : null;
  }
  return null;
}

export function goalActionFor(highlight: UrgentGoalHighlight): FallbackAction | null {
  const overdue = highlight.status === 'overdue';
  const to = buildActionRoute({
    page: 'goals',
    action: overdue ? 'revise' : 'contribute',
    params: { goalId: highlight.goalId },
  });
  return to ? { label: overdue ? 'Revise goal target' : 'Contribute to goal', to } : null;
}

export function tripActionFor(highlight: NearestTripHighlight): FallbackAction | null {
  const to = buildActionRoute({ page: 'trip-detail', action: 'settle', tripId: highlight.tripId });
  return to ? { label: 'Settle trip balance', to } : null;
}

export const FEASIBILITY_TEXT: Readonly<Record<GoalOutcomeValue['feasibility'], string>> = Object.freeze({
  feasible: 'Fits within your savings target',
  not_feasible: 'More than your savings target covers',
  unavailable: 'Needs your monthly plan to check',
  funded: 'Fully funded',
  overdue: 'Past its target date',
});

/** `31 Jan 2026` from `YYYY-MM-DD`, or the text as given. */
export function formatIsoDate(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  if (!match) return isoDate;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

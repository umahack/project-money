import { isClarityActionKey } from '../clarity/actionContext';
import { ACTION_COPY } from '../clarity/actionCopy';
import type {
  ActionableInsight,
  FinancialSnapshot,
  GoalOutcomeValue,
  MoneyValue,
  MonthlyPlanValue,
  Outcome,
  SnapshotHighlights,
  SpendingOutcomeValue,
  TripOutcomeValue,
} from '../clarity/contracts';

export const DISCLAIMER = 'Informational guidance, not a guaranteed financial result.' as const;

/** Whole rupees to a money value in paise. */
export const rupees = (amount: number): MoneyValue => ({ currency: 'INR', amountMinor: Math.round(amount * 100) });

function period(month: string): Outcome<unknown>['period'] {
  const [year, monthNumber] = month.split('-').map(Number) as [number, number];
  return {
    month,
    start: `${month}-01`,
    endExclusive: new Date(Date.UTC(year, monthNumber, 1)).toISOString().slice(0, 10),
    timeZone: 'Asia/Kolkata',
  };
}

function base<T>(id: string, kind: Outcome<T>['kind'], month: string, dataVersion: number): Outcome<T> {
  return {
    id,
    kind,
    status: 'available',
    classification: 'calculated_result',
    dataVersion,
    period: period(month),
    sourceRefs: [],
    explanationRef: { outcomeId: id, dataVersion },
  };
}

export function planOutcome(month: string, dataVersion: number): Outcome<MonthlyPlanValue> {
  return {
    ...base<MonthlyPlanValue>(`monthly-plan:${month}`, 'monthly_plan', month, dataVersion),
    value: {
      salary: rupees(100000),
      activeBillsTotal: rupees(20000),
      shortfall: rupees(0),
      disposableIncome: rupees(80000),
      needsBudget: rupees(40000),
      wantsBudget: rupees(24000),
      savingsTarget: rupees(16000),
      spendableBudget: rupees(64000),
      needsSpent: rupees(6000),
      wantsSpent: rupees(4000),
      remainingSpendable: rupees(54000),
      dailySpendingGuide: rupees(3176),
      projectedSavings: rupees(70000),
    },
  };
}

export function spendingOutcome(month: string, dataVersion: number): Outcome<SpendingOutcomeValue> {
  return {
    ...base<SpendingOutcomeValue>(`spending:${month}`, 'spending', month, dataVersion),
    value: {
      month,
      categoryTotals: [],
      appliedTreatments: [],
      needsBudget: rupees(40000),
      wantsBudget: rupees(24000),
      needsSpent: rupees(6000),
      wantsSpent: rupees(4000),
      totalSpending: rupees(10000),
      spendableBudget: rupees(64000),
      remainingSpendable: rupees(54000),
      dailySpendingGuide: rupees(3176),
      savingsTarget: rupees(16000),
      projectedSavings: rupees(70000),
      projectedSavingsDifference: rupees(54000),
      exceededBudgetActions: [],
    },
  };
}

export function goalOutcome(
  id: number,
  month: string,
  dataVersion: number,
  overrides: Partial<GoalOutcomeValue> = {},
): Outcome<GoalOutcomeValue> {
  return {
    ...base<GoalOutcomeValue>(`goal:${id}`, 'goal', month, dataVersion),
    value: {
      goalId: id,
      status: 'active',
      fundingGap: rupees(60000),
      contributionOpportunities: 6,
      requiredContribution: rupees(10000),
      feasibility: 'feasible',
      capacityDifference: rupees(6000),
      ...overrides,
    },
  };
}

export function tripItemOutcome(id: number, month: string, dataVersion: number): Outcome<TripOutcomeValue> {
  return {
    ...base<TripOutcomeValue>(`trip:${id}`, 'trip', month, dataVersion),
    value: {
      tripId: id,
      tripVersion: 1,
      allocations: [],
      balances: [
        { memberId: 101, amountMinor: 50000, label: 'receivable' },
        { memberId: 102, amountMinor: -50000, label: 'owed' },
      ],
      settlements: [],
    },
  };
}

export function insight(
  actionKey: string,
  overrides: Partial<ActionableInsight> = {},
): ActionableInsight {
  // Plain-language copy, as the server sends it. Never put an action key or ID in rendered text.
  const copy = isClarityActionKey(actionKey) ? ACTION_COPY[actionKey] : { label: 'Review this item', effect: 'Reviewing it keeps your plan accurate.', observation: 'This item needs your attention.' };
  return {
    id: `action:${actionKey}`,
    conditionCode: 'code',
    observation: copy.observation,
    actionKey,
    actionLabel: copy.label,
    expectedEffect: copy.effect,
    route: '/not-used',
    context: {},
    disclaimer: DISCLAIMER,
    ...overrides,
  };
}

export const GOAL_ACTION = insight('contribute_to_goal', {
  id: 'action:contribute_to_goal:goal:7',
  observation: 'The goal “Emergency fund” still has a funding gap.',
  actionLabel: 'Contribute to goal',
  deadline: '2026-12-31',
  shortfall: rupees(60000),
  context: { recordType: 'goal', recordId: 7 },
});
export const TRIP_ACTION = insight('settle_trip_balance', {
  id: 'action:settle_trip_balance:trip:3',
  observation: 'The trip “Goa weekend” has an unsettled receivable balance.',
  actionLabel: 'Settle trip balance',
  effect: rupees(500),
  context: { recordType: 'trip', recordId: 3 },
});
export const BILLS_ACTION = insight('review_bills', {
  id: 'action:review_bills',
  observation: 'Current-month bills exceed salary.',
  actionLabel: 'Review monthly bills',
  shortfall: rupees(5000),
  context: { recordType: 'bill' },
});
export const NEEDS_ACTION = insight('address_needs_budget_excess', {
  id: 'action:address_needs_budget_excess',
  observation: 'Needs spending exceeds its current-month budget.',
  actionLabel: 'Review Needs spending',
  shortfall: rupees(1000),
  context: { recordType: 'expense' },
});
export const WANTS_ACTION = insight('address_wants_budget_excess', {
  id: 'action:address_wants_budget_excess',
  observation: 'Wants spending exceeds its current-month budget.',
  actionLabel: 'Review Wants spending',
  shortfall: rupees(500),
  context: { recordType: 'expense' },
});

export const FULL_HIGHLIGHTS: SnapshotHighlights = {
  urgentGoal: {
    goalId: 7,
    name: 'Emergency fund',
    status: 'active',
    targetDate: '2026-12-31',
    fundingGap: rupees(60000),
  },
  nearestTripSettlement: {
    tripId: 3,
    name: 'Goa weekend',
    userBalance: rupees(500),
    label: 'receivable',
  },
};

export interface HomeSnapshotOptions {
  dataVersion?: number;
  actions?: ActionableInsight[];
  highlights?: SnapshotHighlights;
  plan?: Partial<Outcome<MonthlyPlanValue>>;
  spending?: Partial<Outcome<SpendingOutcomeValue>>;
  goals?: Array<Outcome<GoalOutcomeValue>>;
  trips?: Array<Outcome<TripOutcomeValue>>;
  tripSummary?: Partial<FinancialSnapshot['outcomes']['tripSummary']>;
}

/** A complete confirmed Home snapshot with one goal and one trip. Override any region. */
export function homeSnapshot(month: string, options: HomeSnapshotOptions = {}): FinancialSnapshot {
  const dataVersion = options.dataVersion ?? 1;
  const [year, monthNumber] = month.split('-').map(Number) as [number, number];
  const goals = options.goals ?? [goalOutcome(7, month, dataVersion)];
  const trips = options.trips ?? [tripItemOutcome(3, month, dataVersion)];
  return {
    dataVersion,
    currency: 'INR',
    precisionMinor: 1,
    period: {
      month,
      timeZone: 'Asia/Kolkata',
      start: `${month}-01`,
      endExclusive: new Date(Date.UTC(year, monthNumber, 1)).toISOString().slice(0, 10),
      asOfDate: `${month}-15`,
      daysRemainingInclusive: 17,
    },
    generatedAt: `v${dataVersion}`,
    highlights: options.highlights ?? FULL_HIGHLIGHTS,
    facts: [],
    outcomes: {
      monthlyPlan: { ...planOutcome(month, dataVersion), ...options.plan },
      spending: { ...spendingOutcome(month, dataVersion), ...options.spending },
      goals,
      tripSummary: {
        ...base<TripOutcomeValue[]>(`trip-summary:${month}`, 'trip_summary', month, dataVersion),
        value: trips.flatMap((trip) => (trip.status === 'available' && trip.value ? [trip.value] : [])),
        items: trips,
        ...options.tripSummary,
      },
    },
    actions: options.actions ?? [GOAL_ACTION, TRIP_ACTION],
  };
}

export const NO_HIGHLIGHTS: SnapshotHighlights = { urgentGoal: null, nearestTripSettlement: null };

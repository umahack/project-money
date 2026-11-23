export const CLARITY_SCHEMA_VERSION = 1 as const;
export const CLARITY_CONTRACT_VERSION = '1' as const;

export type AmountMinor = number;
export type OutcomeStatus =
  | 'available'
  | 'missing_input'
  | 'invalid_input'
  | 'stale'
  | 'refresh_failed'
  | 'calculation_failed';
export type ValueClassification = 'entered_fact' | 'calculated_result' | 'recommendation';
export type OutcomeKind = 'monthly_plan' | 'spending' | 'goal' | 'trip' | 'trip_summary';
/**
 * The kind of the `today-allowance:<month>` outcome. It is kept out of
 * `OutcomeKind` so the exhaustive per-kind label tables stay valid until the
 * headline task labels it.
 */
export type TodayAllowanceOutcomeKind = 'today_allowance';
export type SourceType =
  | 'salary'
  | 'bill'
  | 'expense'
  | 'category_treatment'
  | 'goal'
  | 'trip_expense'
  | 'trip_settlement';
export type CalculationOperation =
  | 'sum'
  | 'subtract'
  | 'maximum'
  | 'multiply_ratio'
  | 'divide'
  | 'round_half_up'
  | 'ceil'
  | 'remainder_adjustment';

export interface MoneyValue {
  currency: 'INR';
  amountMinor: AmountMinor;
}

export interface OutcomePeriod {
  month?: string;
  start: string;
  endExclusive: string;
  timeZone: 'Asia/Kolkata';
}

export interface SourceRef {
  order?: number;
  ref?: string;
  sourceType: SourceType;
  recordId: number;
  field: string;
  label: string;
  value: MoneyValue | string | boolean;
  classification?: 'entered_fact';
  confirmedAt?: string;
  period?: {
    month?: string;
    start?: string;
    endExclusive?: string;
    /** Bill sources only: the months a bill applies to. Null means open-ended. */
    effectiveFromMonth?: string | null;
    effectiveToMonth?: string | null;
  };
}

export interface RoundingMetadata {
  precisionMinor: 1;
  direction: 'half_up' | 'up' | 'exact';
  adjustmentMinor: number;
  adjustmentTarget?: string;
}

export interface CalculationStep {
  order: number;
  stage?: string;
  operation: CalculationOperation;
  operandRefs: string[];
  divisor?: number;
  result: MoneyValue | number;
  explanationKey: string;
  rounding?: RoundingMetadata;
  resultClassification?: 'calculated_result';
  intermediateResults?: Record<string, MoneyValue | number>;
  intermediateResultClassifications?: Record<string, 'calculated_result'>;
}

export interface Outcome<T> {
  id: string;
  kind: OutcomeKind;
  status: OutcomeStatus;
  classification: ValueClassification;
  period: OutcomePeriod;
  dataVersion?: number;
  value?: T;
  sourceRefs: SourceRef[];
  explanationRef?: { outcomeId: string; dataVersion: number };
  rounding?: RoundingMetadata;
  missing?: Array<{ input: string; unlocks: OutcomeKind[] }>;
  invalid?: Array<{ input: string; constraint: string; affects: OutcomeKind[] }>;
  stale?: { sourcePeriod: string; requestedPeriod: string };
  retry?: { action: 'recalculate' | 'refresh'; scopeKey: string };
}

export interface MonthlyPlanValue {
  salary: MoneyValue;
  activeBillsTotal: MoneyValue;
  shortfall: MoneyValue;
  disposableIncome: MoneyValue;
  needsBudget: MoneyValue;
  wantsBudget: MoneyValue;
  savingsTarget: MoneyValue;
  spendableBudget: MoneyValue;
  needsSpent: MoneyValue;
  wantsSpent: MoneyValue;
  remainingSpendable: MoneyValue;
  dailySpendingGuide: MoneyValue;
  projectedSavings: MoneyValue;
}

export interface SpendingOutcomeValue {
  month: string;
  categoryTotals: Array<{
    month: string;
    category: string;
    total: MoneyValue;
    expenseIds: number[];
  }>;
  appliedTreatments: Array<{
    expenseId: number;
    category: string;
    treatment: 'needs' | 'wants';
    source: 'default' | 'override';
    treatmentRecordId?: number;
  }>;
  needsBudget: MoneyValue;
  wantsBudget: MoneyValue;
  needsSpent: MoneyValue;
  wantsSpent: MoneyValue;
  totalSpending: MoneyValue;
  spendableBudget: MoneyValue;
  remainingSpendable: MoneyValue;
  dailySpendingGuide: MoneyValue;
  savingsTarget: MoneyValue;
  projectedSavings: MoneyValue;
  projectedSavingsDifference: MoneyValue;
  exceededBudgetActions: Array<{
    conditionCode: string;
    bucket: 'needs' | 'wants';
    budgetMinor: number;
    spentMinor: number;
    excessMinor: number;
    actionKey: string;
    actionLabel: string;
    correctiveAction: string;
  }>;
}

/** Why a Today_Allowance of zero is zero. Null while the allowance is above zero. */
export type TodayAllowanceZeroReason =
  | 'no_spendable_budget'
  | 'month_budget_used'
  | 'below_minimum_unit';

/**
 * The value of the `today-allowance:<month>` outcome. Old servers omit the
 * whole outcome. Every amount is calculated on the server in paise.
 */
export type TodayAllowanceValue =
  | {
      applicable: false;
      /** Any month other than the current Asia/Kolkata month. */
      reason: 'not_current_month';
    }
  | {
      applicable: true;
      /** The Kolkata date the values are for, `YYYY-MM-DD`. */
      date: string;
      daysRemainingInclusive: number;
      todayAllowance: MoneyValue;
      todaySpent: MoneyValue;
      leftToday: MoneyValue;
      overToday: MoneyValue;
      allowanceBasis: MoneyValue;
      /** Spent share of the allowance in 0 to 1000, or null when the allowance is zero. */
      usedPermille: number | null;
      zeroReason: TodayAllowanceZeroReason | null;
      usedBeyondBudget: MoneyValue;
      /** Expenses dated today that carry the Allowance_Exclusion. */
      excludedToday: { count: number; total: MoneyValue };
      /** The Large_Entry threshold, or null when there is no spendable budget. */
      largeEntryThreshold: MoneyValue | null;
    };

/** The `today-allowance:<month>` outcome as it appears in the snapshot. */
export type TodayAllowanceOutcome = Omit<Outcome<TodayAllowanceValue>, 'kind'> & {
  kind: TodayAllowanceOutcomeKind;
};

/**
 * One remembered category choice from `GET /finance/quick-add/hints` and the
 * Memory_API. `revision` guards a restore or delete against a newer change.
 */
export interface MemoryEntry {
  id: number;
  noteKey: string;
  category: string;
  revision: number;
  updatedAt: string;
}

/** One distinct Note_Key from the preceding 90 days of expenses, newest first. */
export interface HistoryEntry {
  noteKey: string;
  category: string;
  /** `YYYY-MM-DD` of the latest expense with this Note_Key. */
  lastSpentOn: string;
}

/** The limits the hints response reports. */
export interface QuickAddHintLimits {
  memoryEntries: number;
  historyDays: number;
  historyKeys: number;
}

/** Response of `GET /finance/quick-add/hints`. Old servers answer 404 instead. */
export interface QuickAddHintsResponse {
  schemaVersion: typeof CLARITY_SCHEMA_VERSION;
  memory: MemoryEntry[];
  history: HistoryEntry[];
  limits: QuickAddHintLimits;
}

/**
 * The Allowance_Exclusion mark on an expense request or confirmed record. It
 * is optional because old servers neither accept nor return it, and a record
 * from before the feature has no mark. Send it only while Quick_Add_Enabled.
 */
export interface ExpenseAllowanceMark {
  excludeFromDailyAllowance?: boolean;
}

export interface GoalOutcomeValue {
  goalId: number;
  status: 'funded' | 'active' | 'overdue';
  fundingGap: MoneyValue;
  contributionOpportunities: number;
  requiredContribution: MoneyValue | null;
  feasibility: 'feasible' | 'not_feasible' | 'unavailable' | 'funded' | 'overdue';
  capacityDifference: MoneyValue | null;
  missingPlanInput?: 'salary' | 'bills' | null;
  revision?: { targetAmount?: MoneyValue; targetDate?: string };
  revisionRequest?: { fields: string[]; action: string };
}

export interface TripOutcomeValue {
  tripId: number;
  tripVersion: number;
  allocations: Array<{
    expenseId: number;
    memberId: number;
    amount: MoneyValue;
    roundingAdjustmentMinor: number;
  }>;
  balances: Array<{
    memberId: number;
    amountMinor: number;
    label: 'receivable' | 'owed' | 'settled';
  }>;
  settlements: Array<{
    fromMemberId: number;
    toMemberId: number;
    amount: MoneyValue;
  }>;
}

export interface ActionableInsight {
  id: string;
  conditionCode: string;
  observation: string;
  effect?: MoneyValue;
  shortfall?: MoneyValue;
  deadline?: string;
  actionKey: string;
  actionLabel: string;
  expectedEffect: string;
  route: string;
  context: { recordType?: 'bill' | 'expense' | 'goal' | 'trip'; recordId?: number };
  disclaimer: 'Informational guidance, not a guaranteed financial result.';
  recommendationInstanceId?: string;
}

export interface UrgentGoalHighlight {
  goalId: number;
  name: string;
  status: 'active' | 'overdue';
  targetDate: string;
  fundingGap: MoneyValue;
}

export interface NearestTripHighlight {
  tripId: number;
  name: string;
  /** Signed paise from the signed-in user's view: positive is receivable, negative is owed. */
  userBalance: MoneyValue;
  label: 'receivable' | 'owed';
}

export interface SnapshotHighlights {
  urgentGoal: UrgentGoalHighlight | null;
  nearestTripSettlement: NearestTripHighlight | null;
}

export interface FinancialSnapshot {
  dataVersion: number;
  currency: 'INR';
  precisionMinor: 1;
  period: {
    month: string;
    timeZone: 'Asia/Kolkata';
    start: string;
    endExclusive: string;
    asOfDate: string;
    daysRemainingInclusive: number;
  };
  generatedAt?: string;
  /** The one goal and one trip the Home summary features, chosen by the server. */
  highlights?: SnapshotHighlights;
  facts: Array<{ classification: 'entered_fact'; source: SourceRef }>;
  outcomes: {
    monthlyPlan: Outcome<MonthlyPlanValue>;
    spending: Outcome<SpendingOutcomeValue>;
    /** Absent when the server predates Quick Add. */
    todayAllowance?: TodayAllowanceOutcome;
    goals: Array<Outcome<GoalOutcomeValue>>;
    tripSummary: Outcome<TripOutcomeValue[]> & { items?: Array<Outcome<TripOutcomeValue>> };
  };
  actions: ActionableInsight[];
}

export interface CalculationExplanation<T = unknown> {
  schemaVersion: typeof CLARITY_SCHEMA_VERSION;
  outcomeId: string;
  kind: OutcomeKind;
  status: OutcomeStatus;
  classification: ValueClassification;
  dataVersion: number;
  period: OutcomePeriod;
  currency: 'INR';
  precisionMinor: 1;
  precision?: Record<string, unknown>;
  sourceRefs: SourceRef[];
  operations: CalculationStep[];
  rounding: RoundingMetadata;
  result?: { classification: ValueClassification; value: T };
  stale?: { sourcePeriod: string; requestedPeriod: string };
}

export interface ClarityReadResponse {
  schemaVersion: typeof CLARITY_SCHEMA_VERSION;
  snapshot: FinancialSnapshot;
}

export interface ExplanationResponse<T = unknown> {
  schemaVersion: typeof CLARITY_SCHEMA_VERSION;
  supersededByVersion?: number;
  explanation: CalculationExplanation<T>;
}

/**
 * The change in two monthly-plan values between the preceding and the newly
 * confirmed salary or bills for one month. Calculated on the server.
 */
export type PlanDeltas =
  | {
      status: 'available';
      month: string;
      disposableIncomeMinor: number;
      dailySpendingGuideMinor: number;
    }
  | { status: 'unavailable'; month: string; reason: string };

export interface MutationMetadata<TResult = unknown> {
  changeId: number;
  idempotencyKey: string;
  scopeKey: string;
  operation: string;
  recordType?: string | null;
  recordId?: number | null;
  status: 'confirmed';
  recordVersion: number;
  occurredAt?: string;
  replayed?: boolean;
  result?: TResult;
  /** Present on salary and bill changes. */
  planDeltas?: PlanDeltas;
  /** The confirmed record after the change. Null after a delete. */
  record?: Record<string, unknown> | null;
}

export interface MutationEnvelope<TResult = unknown> {
  schemaVersion: typeof CLARITY_SCHEMA_VERSION;
  mutation: MutationMetadata<TResult>;
  clarity: FinancialSnapshot;
}

export type StructuredErrorConstraint = string | Record<string, unknown>;

export interface StructuredApiError {
  code: string;
  message: string;
  field?: string;
  constraint?: StructuredErrorConstraint;
  outcomeIds?: string[];
  currentVersion?: number;
  currentRecordVersion?: number;
}

export interface StructuredApiErrorResponse {
  error: StructuredApiError;
}

export interface VersionedClarityResponse {
  schemaVersion: typeof CLARITY_SCHEMA_VERSION;
}

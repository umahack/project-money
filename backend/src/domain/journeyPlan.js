import { LEGACY_SETTLEMENT_PREFIX } from './trips.js';

/**
 * Pure, framework-free planning for the first-session guided journey.
 *
 * Nothing here reads a database, a clock, or a request. The caller supplies the
 * fixed journey definition, a facts object derived from current confirmed
 * records, and the step keys already stored on the journey. The result never
 * contains a financial amount, name, or note; it holds only fixed step keys,
 * statuses, counts, and outcome references.
 */

export const JOURNEY_PLAN_SCHEMA_VERSION = 1;
export const MAX_REQUIRED_CATEGORIES = 3;
export const MAX_REQUIRED_STEPS = 3;

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MIN_TRIP_MEMBERS = 2;
const MAX_CANDIDATE_TRIPS = 10;

/**
 * Fixed per-step registry. `changeRecordTypes` lists the receipt record types a
 * confirmed financial change for the step may carry. A step with no receipt
 * type (trip creation predates change receipts) accepts no `changeId`.
 */
export const STEP_REGISTRY = Object.freeze({
  salary: Object.freeze({
    category: 'salary',
    unlocks: 'disposable_income_and_allocation',
    affectedOutcome: 'disposable_income',
    changeRecordTypes: Object.freeze(['salary']),
  }),
  expense: Object.freeze({
    category: 'expenses',
    unlocks: 'remaining_spendable_and_daily_guide',
    affectedOutcome: 'remaining_spendable_budget',
    changeRecordTypes: Object.freeze(['expense']),
  }),
  goal: Object.freeze({
    category: 'goals',
    unlocks: 'goal_funding_gap_and_required_contribution',
    affectedOutcome: 'required_goal_contribution',
    changeRecordTypes: Object.freeze(['goal']),
  }),
  trip: Object.freeze({
    category: 'trips',
    unlocks: 'trip_overview',
    affectedOutcome: 'trip_settlement',
    changeRecordTypes: Object.freeze([]),
  }),
  trip_members: Object.freeze({
    category: 'trips',
    unlocks: 'trip_members',
    affectedOutcome: 'member_balance',
    changeRecordTypes: Object.freeze(['trip_member']),
  }),
  trip_split: Object.freeze({
    category: 'trips',
    unlocks: 'member_balance_and_settlement',
    affectedOutcome: 'trip_settlement',
    changeRecordTypes: Object.freeze(['trip_expense']),
  }),
  bills: Object.freeze({
    category: 'bills',
    unlocks: 'bill_adjusted_allocation',
    affectedOutcome: 'disposable_income',
    changeRecordTypes: Object.freeze(['bill']),
  }),
  category_treatment: Object.freeze({
    category: 'category_treatments',
    unlocks: 'category_budget_treatment',
    affectedOutcome: 'daily_spending_guide',
    changeRecordTypes: Object.freeze(['category_treatment']),
  }),
  monthly_plan: Object.freeze({
    category: 'salary',
    unlocks: 'goal_feasibility',
    affectedOutcome: 'goal_feasibility',
    changeRecordTypes: Object.freeze(['salary', 'bill']),
  }),
  personal_expense: Object.freeze({
    category: 'expenses',
    unlocks: 'trip_share_in_monthly_spending',
    affectedOutcome: 'remaining_spendable_budget',
    changeRecordTypes: Object.freeze(['trip_personal_link']),
  }),
});

export const STEP_KEYS = Object.freeze(Object.keys(STEP_REGISTRY));

export class JourneyPlanError extends TypeError {
  constructor(message) {
    super(message);
    this.name = 'JourneyPlanError';
  }
}

function assertDefinition(desiredOutcome, definition) {
  if (!definition || typeof definition !== 'object') {
    throw new JourneyPlanError('A fixed journey definition is required.');
  }
  const { requiredStepKeys, optionalStepKeys } = definition;
  if (!Array.isArray(requiredStepKeys) || !Array.isArray(optionalStepKeys)) {
    throw new JourneyPlanError('Journey definitions must list required and optional step keys.');
  }
  const all = [...requiredStepKeys, ...optionalStepKeys];
  if (new Set(all).size !== all.length) {
    throw new JourneyPlanError('Journey step keys must be unique.');
  }
  for (const key of all) {
    if (!Object.hasOwn(STEP_REGISTRY, key)) {
      throw new JourneyPlanError(`Step ${String(key)} is not a fixed journey step.`);
    }
  }
  if (requiredStepKeys.length === 0 || requiredStepKeys.length > MAX_REQUIRED_STEPS) {
    throw new JourneyPlanError(
      `${desiredOutcome} must require between 1 and ${MAX_REQUIRED_STEPS} steps.`
    );
  }
  const categories = new Set(requiredStepKeys.map((key) => STEP_REGISTRY[key].category));
  if (categories.size > MAX_REQUIRED_CATEGORIES) {
    throw new JourneyPlanError(
      `${desiredOutcome} must require at most ${MAX_REQUIRED_CATEGORIES} data categories.`
    );
  }
  return { requiredStepKeys, optionalStepKeys, requiredCategories: [...categories] };
}

function isPositiveAmount(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function hasNoIssues(record) {
  return !Array.isArray(record?.normalizationIssues) || record.normalizationIssues.length === 0;
}

function recordRef(recordType, recordId) {
  return Number.isSafeInteger(recordId) && recordId > 0 ? { recordType, recordId } : null;
}

function newest(records) {
  let best = null;
  for (const record of records) {
    if (best === null || record.id > best.id) best = record;
  }
  return best;
}

function isValidSalary(record) {
  return Boolean(record)
    && isPositiveAmount(record.amountMinor)
    && hasNoIssues(record);
}

function isValidBill(record) {
  return isPositiveAmount(record?.amountMinor) && hasNoIssues(record);
}

function isValidExpense(record) {
  return isPositiveAmount(record?.amountMinor) && hasNoIssues(record);
}

function isValidGoal(record) {
  return Boolean(record)
    && typeof record.name === 'string'
    && record.name.trim() !== ''
    && isPositiveAmount(record.targetAmountMinor)
    && Number.isSafeInteger(record.savedAmountMinor)
    && record.savedAmountMinor >= 0
    && typeof record.targetDate === 'string'
    && DATE_PATTERN.test(record.targetDate)
    && hasNoIssues(record);
}

function isValidSharedSplit(expense, memberNames) {
  return Boolean(expense)
    && typeof expense.description === 'string'
    && !expense.description.startsWith(LEGACY_SETTLEMENT_PREFIX)
    && expense.splitStatus === 'confirmed'
    && Array.isArray(expense.split)
    && expense.split.length > 0
    && isPositiveAmount(expense.amountMinor)
    && hasNoIssues(expense)
    && memberNames.has(expense.payer);
}

/**
 * Reduce repository output to the fixed facts the planner needs. Only counts,
 * validity flags, and record references survive; amounts and names do not.
 *
 * @param {object} input
 * @param {string} input.month YYYY-MM month the journey is evaluated against.
 * @param {object} [input.period] FinancialRepository.loadPeriod() result.
 * @param {object} [input.goals] FinancialRepository.loadGoals() result.
 * @param {object[]} [input.tripLedgers] loadAccessibleTripLedger() results.
 * @param {Iterable<number>} [input.personalLinkTripIds] Trips with a personal link.
 */
export function buildJourneyFacts({
  month,
  period = null,
  goals = null,
  tripLedgers = [],
  personalLinkTripIds = [],
}) {
  if (typeof month !== 'string' || !MONTH_PATTERN.test(month)) {
    throw new JourneyPlanError('month must use YYYY-MM format.');
  }

  const salary = period?.salary?.record ?? null;
  const salaryValid = isValidSalary(salary);
  const bills = (period?.bills?.records ?? []).filter(isValidBill);
  const expenses = (period?.expenses?.records ?? []).filter(isValidExpense);
  const treatments = period?.categoryTreatments?.records ?? [];
  const validGoals = (goals?.records ?? []).filter(isValidGoal);
  const goal = newest(validGoals);

  const linkedTrips = new Set(personalLinkTripIds);
  const trips = [];
  for (const ledger of tripLedgers.slice(0, MAX_CANDIDATE_TRIPS)) {
    const tripId = ledger?.trip?.id;
    if (!Number.isSafeInteger(tripId) || tripId <= 0) continue;
    const members = (ledger.members?.records ?? []).filter((member) => (
      typeof member.name === 'string' && member.name.trim() !== ''
    ));
    const memberNames = new Set(members.map((member) => member.name));
    const membersReady = memberNames.size >= MIN_TRIP_MEMBERS;
    const validSplits = (ledger.expenses?.records ?? [])
      .filter((expense) => isValidSharedSplit(expense, memberNames));
    trips.push({
      id: tripId,
      membersReady,
      splitReady: membersReady && validSplits.length > 0,
      personalLinked: linkedTrips.has(tripId),
      memberRef: membersReady ? recordRef('trip_member', newest(members)?.id) : null,
      splitRef: membersReady ? recordRef('trip_expense', newest(validSplits)?.id) : null,
    });
  }

  return {
    month,
    salaryValid,
    salaryRef: salaryValid ? recordRef('salary', salary.id) : null,
    billCount: bills.length,
    billRef: recordRef('bill', newest(bills)?.id),
    expenseCount: expenses.length,
    expenseRef: recordRef('expense', newest(expenses)?.id),
    treatmentCount: treatments.length,
    treatmentRef: recordRef('category_treatment', newest(treatments)?.id),
    goalId: goal?.id ?? null,
    goalRef: goal ? recordRef('goal', goal.id) : null,
    trips,
  };
}

function normalizeFacts(facts) {
  if (!facts || typeof facts !== 'object') {
    throw new JourneyPlanError('Journey facts are required.');
  }
  if (typeof facts.month !== 'string' || !MONTH_PATTERN.test(facts.month)) {
    throw new JourneyPlanError('facts.month must use YYYY-MM format.');
  }
  return {
    month: facts.month,
    salaryValid: facts.salaryValid === true,
    salaryRef: facts.salaryRef ?? null,
    billCount: Number.isSafeInteger(facts.billCount) ? facts.billCount : 0,
    billRef: facts.billRef ?? null,
    expenseCount: Number.isSafeInteger(facts.expenseCount) ? facts.expenseCount : 0,
    expenseRef: facts.expenseRef ?? null,
    treatmentCount: Number.isSafeInteger(facts.treatmentCount) ? facts.treatmentCount : 0,
    treatmentRef: facts.treatmentRef ?? null,
    goalId: Number.isSafeInteger(facts.goalId) ? facts.goalId : null,
    goalRef: facts.goalRef ?? null,
    trips: Array.isArray(facts.trips) ? facts.trips : [],
  };
}

/** Most advanced accessible trip; ties go to the newest trip. */
function selectBestTrip(trips) {
  let best = null;
  let bestScore = -1;
  for (const trip of trips) {
    const score = 1 + (trip.membersReady ? 1 : 0) + (trip.splitReady ? 1 : 0);
    if (score > bestScore || (score === bestScore && trip.id > best.id)) {
      best = trip;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Which steps current confirmed records satisfy, with one representative
 * record reference per step so the caller can look up its change receipt.
 */
export function deriveSatisfiedSteps(rawFacts) {
  const facts = normalizeFacts(rawFacts);
  const satisfied = new Set();
  const refs = {};
  const mark = (key, ref = null) => {
    satisfied.add(key);
    refs[key] = ref;
  };

  if (facts.salaryValid) {
    mark('salary', facts.salaryRef);
    mark('monthly_plan', facts.salaryRef);
  }
  if (facts.billCount > 0) mark('bills', facts.billRef);
  if (facts.expenseCount > 0) mark('expense', facts.expenseRef);
  if (facts.treatmentCount > 0) mark('category_treatment', facts.treatmentRef);
  if (facts.goalId !== null) mark('goal', facts.goalRef);

  const trip = selectBestTrip(facts.trips);
  if (trip) {
    mark('trip');
    if (trip.membersReady) mark('trip_members', trip.memberRef);
    if (trip.splitReady) mark('trip_split', trip.splitRef);
    if (trip.personalLinked) mark('personal_expense');
  }

  return {
    month: facts.month,
    satisfied,
    refs,
    goalId: facts.goalId,
    tripId: trip?.id ?? null,
  };
}

function firstOutcomeFor(desiredOutcome, derived) {
  switch (desiredOutcome) {
    case 'plan_month':
      return { kind: 'monthly_plan', outcomeId: `monthly-plan:${derived.month}` };
    case 'control_spending':
      return { kind: 'spending', outcomeId: `spending:${derived.month}` };
    case 'fund_goal':
      return derived.goalId === null
        ? { kind: 'goal', outcomeId: null }
        : { kind: 'goal', outcomeId: `goal:${derived.goalId}` };
    case 'settle_trip':
      return derived.tripId === null
        ? { kind: 'trip', outcomeId: null }
        : { kind: 'trip', outcomeId: `trip:${derived.tripId}` };
    default:
      throw new JourneyPlanError('desiredOutcome must be one of the four fixed journey outcomes.');
  }
}

/**
 * Plan a journey from its fixed definition and current confirmed records.
 *
 * Required steps are complete only when current records satisfy them, so a
 * resumed journey always reflects the data that exists now. Optional steps are
 * complete when records satisfy them or the user skipped them. Stored keys are
 * only ever added to, never removed, in `completedStepKeysToPersist`.
 *
 * @returns {object} plan with no financial values
 */
export function planJourney({
  desiredOutcome,
  definition,
  facts,
  storedCompletedStepKeys = [],
}) {
  const { requiredStepKeys, optionalStepKeys, requiredCategories } = assertDefinition(
    desiredOutcome,
    definition
  );
  const allowed = new Set([...requiredStepKeys, ...optionalStepKeys]);
  if (!Array.isArray(storedCompletedStepKeys)) {
    throw new JourneyPlanError('storedCompletedStepKeys must be an array.');
  }
  for (const key of storedCompletedStepKeys) {
    if (!allowed.has(key)) {
      throw new JourneyPlanError(`Step ${String(key)} is not valid for ${desiredOutcome}.`);
    }
  }

  const derived = deriveSatisfiedSteps(facts);
  const stored = new Set(storedCompletedStepKeys);

  const completedRequiredStepKeys = requiredStepKeys.filter((key) => derived.satisfied.has(key));
  const remainingRequiredStepKeys = requiredStepKeys.filter((key) => !derived.satisfied.has(key));
  const nextIncompleteStepKey = remainingRequiredStepKeys[0] ?? null;

  const firstOutcomeAvailable = remainingRequiredStepKeys.length === 0;
  const firstOutcome = {
    available: firstOutcomeAvailable,
    ...firstOutcomeFor(desiredOutcome, derived),
  };
  if (!firstOutcomeAvailable) firstOutcome.outcomeId = null;

  const steps = [...requiredStepKeys, ...optionalStepKeys].map((key) => {
    const required = requiredStepKeys.includes(key);
    const metadata = STEP_REGISTRY[key];
    const satisfiedByRecords = derived.satisfied.has(key);
    const skipped = !required && !satisfiedByRecords && stored.has(key);
    const step = {
      key,
      required,
      category: metadata.category,
      status: satisfiedByRecords ? 'satisfied' : skipped ? 'skipped' : 'pending',
      unlocks: metadata.unlocks,
      recordRef: satisfiedByRecords ? derived.refs[key] ?? null : null,
    };
    if (!required) {
      step.offered = firstOutcomeAvailable;
      step.skip = {
        financialWrite: false,
        affectedOutcome: metadata.affectedOutcome,
        availableOutcomeKind: firstOutcome.kind,
      };
    }
    return step;
  });

  // Optional prompts are offered only after the first meaningful outcome.
  const nextOptional = firstOutcomeAvailable
    ? steps.find((step) => !step.required && step.status === 'pending')
    : undefined;
  const currentStepKey = nextIncompleteStepKey ?? nextOptional?.key ?? null;
  const nextChoice = currentStepKey === null
    ? null
    : {
      stepKey: currentStepKey,
      required: nextIncompleteStepKey !== null,
      skippable: nextIncompleteStepKey === null,
    };

  const completedStepKeysToPersist = [...requiredStepKeys, ...optionalStepKeys].filter((key) => (
    stored.has(key) || derived.satisfied.has(key)
  ));

  return {
    schemaVersion: JOURNEY_PLAN_SCHEMA_VERSION,
    desiredOutcome,
    requiredStepKeys: [...requiredStepKeys],
    optionalStepKeys: [...optionalStepKeys],
    requiredCategories,
    steps,
    completedRequiredStepKeys,
    remainingRequiredStepKeys,
    nextIncompleteStepKey,
    currentStepKey,
    progress: {
      requiredTotal: requiredStepKeys.length,
      requiredCompleted: completedRequiredStepKeys.length,
      requiredRemaining: remainingRequiredStepKeys.length,
      currentStepNumber: nextIncompleteStepKey === null
        ? null
        : requiredStepKeys.indexOf(nextIncompleteStepKey) + 1,
    },
    firstOutcome,
    optionalOffered: firstOutcomeAvailable,
    nextChoice,
    completedStepKeysToPersist,
    tripId: derived.tripId,
    goalId: derived.goalId,
  };
}

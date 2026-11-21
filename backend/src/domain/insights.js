import { assertSafePaise } from './money.js';

export const ACTION_DISCLAIMER =
  'Informational guidance, not a guaranteed financial result.';
export const MAX_SUMMARY_ACTIONS = 3;
export const NO_ACTION_NEEDED = Object.freeze({
  status: 'no_action_needed',
  message: 'No action is needed for the current month.',
  actions: Object.freeze([]),
});

const GOAL_STATUSES = new Set(['active', 'overdue', 'funded']);
const RECORD_TYPES = new Set(['bill', 'expense', 'goal', 'trip']);
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const TEXT_COLLATOR = new Intl.Collator('en-IN', {
  sensitivity: 'variant',
  usage: 'sort',
});

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

function assertRecordId(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

function normalizeForSort(value, label) {
  return assertNonEmptyString(value, label).normalize('NFKC').toLocaleLowerCase('en-IN');
}

function compareText(left, right) {
  return TEXT_COLLATOR.compare(left, right);
}

function dateOnlyTimestamp(value, label) {
  const match = DATE_PATTERN.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  if (
    year < 1
    || date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    throw new TypeError(`${label} must be a valid ISO calendar date.`);
  }
  return timestamp;
}

function comparableDate(value, label) {
  assertNonEmptyString(value, label);
  const dateOnly = dateOnlyTimestamp(value, label);
  if (dateOnly !== null) return dateOnly;
  if (!ISO_INSTANT_PATTERN.test(value)) {
    throw new TypeError(`${label} must be an ISO calendar date or timestamp with a time zone.`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new TypeError(`${label} must be a valid ISO calendar date or timestamp.`);
  }
  return timestamp;
}

function money(amountMinor, { allowNegative = false, label = 'amountMinor' } = {}) {
  assertSafePaise(amountMinor, { allowNegative, label });
  return { currency: 'INR', amountMinor };
}

function normalizeGoal(goal, index = 0) {
  assertPlainObject(goal, `goals[${index}]`);
  const goalId = assertRecordId(goal.goalId, `goals[${index}].goalId`);
  const name = assertNonEmptyString(goal.name, `goals[${index}].name`);
  const targetDate = assertNonEmptyString(goal.targetDate, `goals[${index}].targetDate`);
  const targetDateSort = comparableDate(targetDate, `goals[${index}].targetDate`);
  const fundingGapMinor = assertSafePaise(goal.fundingGapMinor, {
    allowNegative: false,
    label: `goals[${index}].fundingGapMinor`,
  });
  if (!GOAL_STATUSES.has(goal.status)) {
    throw new TypeError(`goals[${index}].status must be active, overdue, or funded.`);
  }

  return {
    ...goal,
    goalId,
    name,
    targetDate,
    fundingGapMinor,
    status: goal.status,
    _nameSort: normalizeForSort(name, `goals[${index}].name`),
    _targetDateSort: targetDateSort,
  };
}

function compareNormalizedGoals(left, right) {
  const overdueOrder = Number(right.status === 'overdue') - Number(left.status === 'overdue');
  if (overdueOrder !== 0) return overdueOrder;
  if (left._targetDateSort !== right._targetDateSort) {
    return left._targetDateSort - right._targetDateSort;
  }
  if (left.fundingGapMinor !== right.fundingGapMinor) {
    return right.fundingGapMinor - left.fundingGapMinor;
  }
  const nameOrder = compareText(left._nameSort, right._nameSort);
  if (nameOrder !== 0) return nameOrder;
  return left.goalId - right.goalId;
}

function publicGoal(goal) {
  const { _nameSort, _targetDateSort, ...candidate } = goal;
  return candidate;
}

/** Compare active goal candidates by overdue/date/gap/name/ID urgency. */
export function compareGoals(left, right) {
  return compareNormalizedGoals(normalizeGoal(left), normalizeGoal(right));
}

/** Return active, unfunded goals in deterministic urgency order. */
export function rankGoals(goals = []) {
  if (!Array.isArray(goals)) throw new TypeError('goals must be an array.');
  return goals
    .map((goal, index) => normalizeGoal(goal, index))
    .filter((goal) => goal.status !== 'funded' && goal.fundingGapMinor > 0)
    .toSorted(compareNormalizedGoals)
    .map(publicGoal);
}

export function selectHighestUrgencyGoal(goals = []) {
  return rankGoals(goals)[0] ?? null;
}

function normalizeTrip(trip, index = 0) {
  assertPlainObject(trip, `trips[${index}]`);
  const tripId = assertRecordId(trip.tripId, `trips[${index}].tripId`);
  const name = assertNonEmptyString(trip.name, `trips[${index}].name`);
  const userBalanceMinor = assertSafePaise(trip.userBalanceMinor, {
    label: `trips[${index}].userBalanceMinor`,
  });
  const earliestUnsettledAt = trip.earliestUnsettledAt ?? null;
  if (userBalanceMinor !== 0 && earliestUnsettledAt === null) {
    throw new TypeError(`trips[${index}].earliestUnsettledAt is required for an unsettled trip.`);
  }
  const unsettledAtSort = earliestUnsettledAt === null
    ? null
    : comparableDate(earliestUnsettledAt, `trips[${index}].earliestUnsettledAt`);

  return {
    ...trip,
    tripId,
    name,
    userBalanceMinor,
    earliestUnsettledAt,
    _absoluteBalanceSort: Math.abs(userBalanceMinor),
    _nameSort: normalizeForSort(name, `trips[${index}].name`),
    _unsettledAtSort: unsettledAtSort,
  };
}

function compareNormalizedTrips(left, right) {
  if (left._absoluteBalanceSort !== right._absoluteBalanceSort) {
    return right._absoluteBalanceSort - left._absoluteBalanceSort;
  }
  if (left._unsettledAtSort !== right._unsettledAtSort) {
    return left._unsettledAtSort - right._unsettledAtSort;
  }
  const nameOrder = compareText(left._nameSort, right._nameSort);
  if (nameOrder !== 0) return nameOrder;
  return left.tripId - right.tripId;
}

function publicTrip(trip) {
  const {
    _absoluteBalanceSort,
    _nameSort,
    _unsettledAtSort,
    ...candidate
  } = trip;
  return candidate;
}

/** Compare unsettled trip candidates by balance/time/name/ID urgency. */
export function compareTrips(left, right) {
  const normalizedLeft = normalizeTrip(left);
  const normalizedRight = normalizeTrip(right);
  if (normalizedLeft.userBalanceMinor === 0 || normalizedRight.userBalanceMinor === 0) {
    throw new TypeError('compareTrips requires unsettled trip candidates.');
  }
  return compareNormalizedTrips(normalizedLeft, normalizedRight);
}

/** Return only unsettled trips in deterministic settlement order. */
export function rankTrips(trips = []) {
  if (!Array.isArray(trips)) throw new TypeError('trips must be an array.');
  return trips
    .map((trip, index) => normalizeTrip(trip, index))
    .filter((trip) => trip.userBalanceMinor !== 0)
    .toSorted(compareNormalizedTrips)
    .map(publicTrip);
}

export function selectNearestTripSettlement(trips = []) {
  return rankTrips(trips)[0] ?? null;
}

function normalizeMoneyValue(value, label, { allowNegative = false } = {}) {
  assertPlainObject(value, label);
  if (value.currency !== 'INR') throw new TypeError(`${label}.currency must be INR.`);
  return money(value.amountMinor, { allowNegative, label: `${label}.amountMinor` });
}

function normalizeAction(action, index = 0) {
  assertPlainObject(action, `actions[${index}]`);
  const id = assertNonEmptyString(action.id, `actions[${index}].id`);
  const conditionCode = assertNonEmptyString(
    action.conditionCode,
    `actions[${index}].conditionCode`
  );
  const actionKey = assertNonEmptyString(action.actionKey, `actions[${index}].actionKey`);
  const actionLabel = assertNonEmptyString(action.actionLabel, `actions[${index}].actionLabel`);
  const expectedEffect = assertNonEmptyString(
    action.expectedEffect,
    `actions[${index}].expectedEffect`
  );
  const route = assertNonEmptyString(action.route, `actions[${index}].route`);
  if (!route.startsWith('/') || route.startsWith('//')) {
    throw new TypeError(`actions[${index}].route must be an application-relative route.`);
  }
  if (action.disclaimer !== ACTION_DISCLAIMER) {
    throw new TypeError(`actions[${index}].disclaimer must use the informational-guidance label.`);
  }

  const context = { ...assertPlainObject(action.context, `actions[${index}].context`) };
  if (context.recordType !== undefined && !RECORD_TYPES.has(context.recordType)) {
    throw new TypeError(`actions[${index}].context.recordType is invalid.`);
  }
  if (context.recordId !== undefined) {
    assertRecordId(context.recordId, `actions[${index}].context.recordId`);
  }

  const deadline = action.deadline ?? null;
  const deadlineSort = deadline === null
    ? null
    : comparableDate(deadline, `actions[${index}].deadline`);
  const shortfall = action.shortfall === undefined
    ? null
    : normalizeMoneyValue(action.shortfall, `actions[${index}].shortfall`);
  const effect = action.effect === undefined
    ? null
    : normalizeMoneyValue(action.effect, `actions[${index}].effect`, { allowNegative: true });

  return {
    ...action,
    id,
    conditionCode,
    actionKey,
    actionLabel,
    expectedEffect,
    route,
    context,
    ...(deadline === null ? {} : { deadline }),
    ...(shortfall === null ? {} : { shortfall }),
    ...(effect === null ? {} : { effect }),
    disclaimer: ACTION_DISCLAIMER,
    _deadlineSort: deadlineSort,
    _shortfallSort: shortfall?.amountMinor ?? 0,
    _effectSort: Math.abs(effect?.amountMinor ?? 0),
    _labelSort: normalizeForSort(actionLabel, `actions[${index}].actionLabel`),
    _keySort: normalizeForSort(actionKey, `actions[${index}].actionKey`),
    _idSort: normalizeForSort(id, `actions[${index}].id`),
  };
}

function compareNormalizedActions(left, right) {
  const leftHasDeadline = left._deadlineSort !== null;
  const rightHasDeadline = right._deadlineSort !== null;
  if (leftHasDeadline !== rightHasDeadline) return leftHasDeadline ? -1 : 1;
  if (leftHasDeadline && left._deadlineSort !== right._deadlineSort) {
    return left._deadlineSort - right._deadlineSort;
  }
  if (left._shortfallSort !== right._shortfallSort) {
    return right._shortfallSort - left._shortfallSort;
  }
  if (left._effectSort !== right._effectSort) {
    return right._effectSort - left._effectSort;
  }
  const labelOrder = compareText(left._labelSort, right._labelSort);
  if (labelOrder !== 0) return labelOrder;
  const keyOrder = compareText(left._keySort, right._keySort);
  if (keyOrder !== 0) return keyOrder;
  return compareText(left._idSort, right._idSort);
}

function publicAction(action) {
  const {
    _deadlineSort,
    _effectSort,
    _idSort,
    _keySort,
    _labelSort,
    _shortfallSort,
    ...candidate
  } = action;
  return candidate;
}

/** Compare complete ActionableInsight values using the approved total order. */
export function compareActions(left, right) {
  return compareNormalizedActions(normalizeAction(left), normalizeAction(right));
}

/** Rank all candidates without mutating the input array. */
export function rankActions(actions = []) {
  if (!Array.isArray(actions)) throw new TypeError('actions must be an array.');
  return actions
    .map((action, index) => normalizeAction(action, index))
    .toSorted(compareNormalizedActions)
    .map(publicAction);
}

/** Rank candidates and apply the fixed Home summary cap. */
export function selectSummaryActions(actions = []) {
  return rankActions(actions).slice(0, MAX_SUMMARY_ACTIONS);
}

/** Build the explicit action/no-action state consumed by the Home summary. */
export function createActionSummary(actions = []) {
  const selected = selectSummaryActions(actions);
  if (selected.length === 0) {
    return {
      status: NO_ACTION_NEEDED.status,
      message: NO_ACTION_NEEDED.message,
      actions: [],
    };
  }
  return { status: 'actions_available', actions: selected };
}

function createInsight({
  id,
  conditionCode,
  observation,
  effect,
  shortfall,
  deadline,
  actionKey,
  actionLabel,
  expectedEffect,
  route,
  context,
}) {
  return {
    id,
    conditionCode,
    observation,
    ...(effect === undefined ? {} : { effect: money(effect, { allowNegative: true, label: 'effect' }) }),
    ...(shortfall === undefined ? {} : { shortfall: money(shortfall, { label: 'shortfall' }) }),
    ...(deadline === undefined ? {} : { deadline }),
    actionKey,
    actionLabel,
    expectedEffect,
    route,
    context,
    disclaimer: ACTION_DISCLAIMER,
  };
}

function billReviewCandidate(monthlyPlan) {
  if (monthlyPlan === null || monthlyPlan === undefined) return null;
  assertPlainObject(monthlyPlan, 'monthlyPlan');
  const salaryMinor = assertSafePaise(monthlyPlan.salaryMinor, {
    allowNegative: false,
    label: 'monthlyPlan.salaryMinor',
  });
  const activeBillsTotalMinor = assertSafePaise(monthlyPlan.activeBillsTotalMinor, {
    allowNegative: false,
    label: 'monthlyPlan.activeBillsTotalMinor',
  });
  if (activeBillsTotalMinor < salaryMinor) return null;

  const exceedsSalary = activeBillsTotalMinor > salaryMinor;
  const shortfallMinor = activeBillsTotalMinor - salaryMinor;
  return createInsight({
    id: 'action:review_bills',
    conditionCode: exceedsSalary ? 'bills_exceed_salary' : 'bills_equal_salary',
    observation: exceedsSalary
      ? 'Current-month bills exceed salary.'
      : 'Current-month bills use all salary.',
    shortfall: shortfallMinor,
    actionKey: 'review_bills',
    actionLabel: 'Review monthly bills',
    expectedEffect: exceedsSalary
      ? 'Reducing a bill reduces the current-month shortfall.'
      : 'Reducing a bill makes part of the current-month salary available to spend or save.',
    route: '/plan#bills-form',
    context: { recordType: 'bill' },
  });
}

const BUCKET_ACTIONS = Object.freeze({
  needs: Object.freeze({
    title: 'Needs',
    conditionCode: 'needs_budget_exceeded',
    actionKey: 'address_needs_budget_excess',
    route: '/spending?action=review-budget&bucket=needs',
  }),
  wants: Object.freeze({
    title: 'Wants',
    conditionCode: 'wants_budget_exceeded',
    actionKey: 'address_wants_budget_excess',
    route: '/spending?action=review-budget&bucket=wants',
  }),
});

function exceededBudgetCandidates(spending) {
  if (spending === null || spending === undefined) return [];
  assertPlainObject(spending, 'spending');

  return Object.entries(BUCKET_ACTIONS).flatMap(([bucket, definition]) => {
    const budgetMinor = assertSafePaise(spending[`${bucket}BudgetMinor`], {
      allowNegative: false,
      label: `spending.${bucket}BudgetMinor`,
    });
    const spentMinor = assertSafePaise(spending[`${bucket}SpentMinor`], {
      allowNegative: false,
      label: `spending.${bucket}SpentMinor`,
    });
    if (spentMinor <= budgetMinor) return [];

    return [createInsight({
      id: `action:${definition.actionKey}`,
      conditionCode: definition.conditionCode,
      observation: `${definition.title} spending exceeds its current-month budget.`,
      shortfall: spentMinor - budgetMinor,
      actionKey: definition.actionKey,
      actionLabel: `Review ${definition.title} spending`,
      expectedEffect: `Reducing or correctly reclassifying spending reduces the ${definition.title} budget excess.`,
      route: definition.route,
      context: { recordType: 'expense' },
    })];
  });
}

function goalCandidate(goals) {
  const goal = selectHighestUrgencyGoal(goals);
  if (!goal) return null;
  const overdue = goal.status === 'overdue';
  const actionKey = overdue ? 'revise_goal_target' : 'contribute_to_goal';
  return createInsight({
    id: `action:${actionKey}:goal:${goal.goalId}`,
    conditionCode: overdue ? 'goal_overdue' : 'goal_funding_gap',
    observation: overdue
      ? `The goal “${goal.name}” is overdue and still has a funding gap.`
      : `The goal “${goal.name}” still has a funding gap.`,
    shortfall: goal.fundingGapMinor,
    deadline: goal.targetDate,
    actionKey,
    actionLabel: overdue ? 'Revise goal target' : 'Contribute to goal',
    expectedEffect: overdue
      ? 'Setting a new target amount or date restores a current contribution plan.'
      : 'Recording a contribution reduces the goal funding gap.',
    route: overdue
      ? `/goals?action=revise&goalId=${goal.goalId}`
      : `/goals?action=contribute&goalId=${goal.goalId}`,
    context: { recordType: 'goal', recordId: goal.goalId },
  });
}

function tripCandidate(trips) {
  const trip = selectNearestTripSettlement(trips);
  if (!trip) return null;
  const receivable = trip.userBalanceMinor > 0;
  return createInsight({
    id: `action:settle_trip_balance:trip:${trip.tripId}`,
    conditionCode: receivable ? 'trip_balance_receivable' : 'trip_balance_owed',
    observation: receivable
      ? `The trip “${trip.name}” has an unsettled receivable balance.`
      : `The trip “${trip.name}” has an unsettled owed balance.`,
    effect: trip.userBalanceMinor,
    actionKey: 'settle_trip_balance',
    actionLabel: 'Settle trip balance',
    expectedEffect: 'Recording the proposed settlement clears the current trip balance.',
    route: `/trips/${trip.tripId}?tab=balances&action=settle`,
    context: { recordType: 'trip', recordId: trip.tripId },
  });
}

/**
 * Build one fixed action for every applicable condition. Goal and trip inputs
 * are reduced to their single highest-urgency candidate before action ranking.
 */
export function buildActionCandidates({
  monthlyPlan = null,
  spending = null,
  goals = [],
  trips = [],
} = {}) {
  const candidates = [
    billReviewCandidate(monthlyPlan),
    ...exceededBudgetCandidates(spending),
    goalCandidate(goals),
    tripCandidate(trips),
  ].filter(Boolean);
  return candidates.map((candidate, index) => publicAction(normalizeAction(candidate, index)));
}

export function buildActionSummary(input = {}) {
  return createActionSummary(buildActionCandidates(input));
}

import {
  assertSafePaise,
  divideCeilWithMetadata,
  sumPaise,
} from './money.js';

export const GOAL_STATUSES = Object.freeze({
  ACTIVE: 'active',
  FUNDED: 'funded',
  OVERDUE: 'overdue',
});

export const GOAL_FEASIBILITY = Object.freeze({
  FEASIBLE: 'feasible',
  NOT_FEASIBLE: 'not_feasible',
  UNAVAILABLE: 'unavailable',
  FUNDED: 'funded',
  OVERDUE: 'overdue',
});

export const GOAL_PLAN_INPUT_PRIORITY = Object.freeze(['salary', 'bills']);

const LOCAL_DATE_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const GOAL_DRAFT_FIELDS = Object.freeze([
  'name',
  'targetAmountMinor',
  'savedAmountMinor',
  'targetDate',
]);

export class GoalValidationError extends TypeError {
  constructor(errors) {
    super(errors[0]?.message ?? 'Goal data is invalid.');
    this.name = 'GoalValidationError';
    this.errors = errors.map((error) => ({ ...error }));
  }
}

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year, month) {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function parseLocalDate(value, field) {
  const match = typeof value === 'string' ? LOCAL_DATE_PATTERN.exec(value) : null;
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || day > daysInMonth(year, month)) return null;
  return { value, year, month, day, field };
}

function assertLocalDate(value, field = 'localDate') {
  const parsed = parseLocalDate(value, field);
  if (!parsed) throw new TypeError(`${field} must be a valid YYYY-MM-DD calendar date.`);
  return parsed;
}

function validationIssue(code, field, constraint, message) {
  return { code, field, constraint, message };
}

function copyGoal(goal) {
  return goal === null || goal === undefined ? null : { ...goal };
}

function copyDraft(draft) {
  return draft && typeof draft === 'object' && !Array.isArray(draft)
    ? { ...draft }
    : draft;
}

function buildGoalCandidate(precedingConfirmedGoal, draft) {
  const candidate = copyGoal(precedingConfirmedGoal) ?? {};
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return candidate;

  for (const field of GOAL_DRAFT_FIELDS) {
    if (Object.hasOwn(draft, field)) candidate[field] = draft[field];
  }
  return candidate;
}

function validateGoalCandidate(goal, { localDate, requireCurrentOrFutureTarget }) {
  const errors = [];
  if (!goal || typeof goal !== 'object' || Array.isArray(goal)) {
    return [validationIssue(
      'INVALID_GOAL_DATA',
      'goal',
      'an object containing goal fields',
      'Goal data must be an object.'
    )];
  }

  if (typeof goal.name !== 'string' || goal.name.normalize('NFKC').trim().length === 0) {
    errors.push(validationIssue(
      'INVALID_GOAL_NAME',
      'name',
      'at least one non-whitespace character',
      'Goal name must contain at least one non-whitespace character.'
    ));
  }

  const targetIsSafe = Number.isSafeInteger(goal.targetAmountMinor);
  if (!targetIsSafe || goal.targetAmountMinor <= 0) {
    errors.push(validationIssue(
      'INVALID_GOAL_TARGET_AMOUNT',
      'targetAmountMinor',
      'a positive safe integer number of paise',
      'Target amount must be greater than zero and use whole paise.'
    ));
  }

  const savedIsSafe = Number.isSafeInteger(goal.savedAmountMinor);
  if (!savedIsSafe || goal.savedAmountMinor < 0) {
    errors.push(validationIssue(
      'INVALID_GOAL_SAVED_AMOUNT',
      'savedAmountMinor',
      'a non-negative safe integer number of paise',
      'Amount already saved must be zero or greater and use whole paise.'
    ));
  } else if (targetIsSafe && goal.targetAmountMinor > 0
    && goal.savedAmountMinor > goal.targetAmountMinor) {
    errors.push(validationIssue(
      'GOAL_SAVED_AMOUNT_EXCEEDS_TARGET',
      'savedAmountMinor',
      `from 0 through ${goal.targetAmountMinor} paise, inclusive`,
      'Amount already saved must not exceed the target amount.'
    ));
  }

  const targetDate = parseLocalDate(goal.targetDate, 'targetDate');
  if (!targetDate) {
    errors.push(validationIssue(
      'INVALID_GOAL_TARGET_DATE',
      'targetDate',
      'a valid YYYY-MM-DD calendar date',
      'Target date must be a valid calendar date.'
    ));
  } else if (requireCurrentOrFutureTarget && targetDate.value < localDate) {
    errors.push(validationIssue(
      'GOAL_TARGET_DATE_IN_PAST',
      'targetDate',
      `a date on or after ${localDate}`,
      `Target date must be on or after ${localDate}.`
    ));
  }

  return errors;
}

function normalizeGoal(goal) {
  return {
    ...goal,
    name: goal.name.trim(),
  };
}

function assertConfirmedGoal(goal) {
  const errors = validateGoalCandidate(goal, {
    localDate: null,
    requireCurrentOrFutureTarget: false,
  });
  if (errors.length > 0) throw new GoalValidationError(errors);
  return normalizeGoal(goal);
}

/**
 * Count current-through-target contribution months, including both endpoints.
 * A date that has already passed has no remaining contribution opportunity.
 */
export function countInclusiveMonthlyOpportunities(localDate, targetDate) {
  const current = assertLocalDate(localDate, 'localDate');
  const target = assertLocalDate(targetDate, 'targetDate');
  if (target.value < current.value) return 0;
  return (target.year - current.year) * 12 + target.month - current.month + 1;
}

function resolveMissingPlanInput(missingPlanInputs) {
  const inputs = missingPlanInputs === undefined ? ['salary'] : missingPlanInputs;
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new TypeError(
      'missingPlanInputs must identify at least one missing monthly-plan input.'
    );
  }

  const uniqueInputs = new Set();
  for (const input of inputs) {
    if (!GOAL_PLAN_INPUT_PRIORITY.includes(input)) {
      throw new TypeError('missingPlanInputs may contain only salary or bills.');
    }
    uniqueInputs.add(input);
  }

  return GOAL_PLAN_INPUT_PRIORITY.find((input) => uniqueInputs.has(input));
}

function validateSavingsTarget(savingsTargetMinor) {
  if (savingsTargetMinor === undefined || savingsTargetMinor === null) return null;
  return assertSafePaise(savingsTargetMinor, {
    allowNegative: false,
    label: 'savingsTargetMinor',
  });
}

function buildFeasibleTargetRevision(goal, contributionOpportunities, savingsTargetMinor) {
  const achievableGapMinor = savingsTargetMinor * contributionOpportunities;
  assertSafePaise(achievableGapMinor, {
    allowNegative: false,
    label: 'revised funding gap',
  });
  const targetAmountMinor = sumPaise(
    [goal.savedAmountMinor, achievableGapMinor],
    { allowNegative: false, label: 'revised target amount' }
  );

  // No valid positive target or finite date can have a zero required
  // contribution when both the saved amount and monthly capacity are zero.
  if (targetAmountMinor === 0) {
    return {
      revision: null,
      revisionUnavailable: {
        code: 'NO_FEASIBLE_POSITIVE_TARGET',
        reason:
          'A positive target cannot be feasible with zero saved and zero monthly savings capacity.',
      },
    };
  }

  const fundingGapMinor = targetAmountMinor - goal.savedAmountMinor;
  const required = divideCeilWithMetadata(fundingGapMinor, contributionOpportunities);
  if (required.amountMinor > savingsTargetMinor) {
    throw new Error('Recomputed goal revision must fit the available savings target.');
  }

  return {
    revision: {
      targetAmountMinor,
      fundingGapMinor,
      contributionOpportunities,
      requiredContributionMinor: required.amountMinor,
    },
    revisionUnavailable: null,
  };
}

/**
 * Calculate gap, contribution cadence, state, and monthly-plan feasibility for
 * one confirmed goal. Confirmed historical goals may have a past target date so
 * they can be reported as overdue; new or changed dates are validated by
 * validateGoalDraft/applyGoalDraft.
 */
export function calculateGoal({
  goal,
  localDate,
  savingsTargetMinor,
  missingPlanInputs,
}) {
  assertLocalDate(localDate, 'localDate');
  const confirmedGoal = assertConfirmedGoal(goal);
  const availableSavingsTargetMinor = validateSavingsTarget(savingsTargetMinor);
  const fundingGapMinor = confirmedGoal.targetAmountMinor - confirmedGoal.savedAmountMinor;
  const contributionOpportunities = countInclusiveMonthlyOpportunities(
    localDate,
    confirmedGoal.targetDate
  );

  const base = {
    ...(confirmedGoal.id === undefined ? {} : { goalId: confirmedGoal.id }),
    status: GOAL_STATUSES.ACTIVE,
    fundingGapMinor,
    contributionOpportunities,
    requiredContributionMinor: null,
    feasibility: GOAL_FEASIBILITY.UNAVAILABLE,
    capacityDifferenceMinor: null,
    missingPlanInput: null,
    revision: null,
    revisionUnavailable: null,
    revisionRequest: null,
    rounding: { requiredContribution: null },
  };

  if (fundingGapMinor === 0) {
    return {
      ...base,
      status: GOAL_STATUSES.FUNDED,
      requiredContributionMinor: 0,
      feasibility: GOAL_FEASIBILITY.FUNDED,
    };
  }

  if (confirmedGoal.targetDate < localDate) {
    return {
      ...base,
      status: GOAL_STATUSES.OVERDUE,
      feasibility: GOAL_FEASIBILITY.OVERDUE,
      revisionRequest: {
        fields: ['targetAmountMinor', 'targetDate'],
        action: 'revise_target_amount_or_date',
      },
    };
  }

  const required = divideCeilWithMetadata(fundingGapMinor, contributionOpportunities);
  const active = {
    ...base,
    requiredContributionMinor: required.amountMinor,
    rounding: { requiredContribution: required.rounding },
  };

  if (availableSavingsTargetMinor === null) {
    return {
      ...active,
      feasibility: GOAL_FEASIBILITY.UNAVAILABLE,
      missingPlanInput: resolveMissingPlanInput(missingPlanInputs),
    };
  }

  if (required.amountMinor <= availableSavingsTargetMinor) {
    return {
      ...active,
      feasibility: GOAL_FEASIBILITY.FEASIBLE,
      capacityDifferenceMinor: availableSavingsTargetMinor - required.amountMinor,
    };
  }

  const revision = buildFeasibleTargetRevision(
    confirmedGoal,
    contributionOpportunities,
    availableSavingsTargetMinor
  );
  return {
    ...active,
    feasibility: GOAL_FEASIBILITY.NOT_FEASIBLE,
    capacityDifferenceMinor: required.amountMinor - availableSavingsTargetMinor,
    ...revision,
  };
}

/**
 * Validate a create or update draft without mutating the preceding confirmed
 * goal. Past dates are rejected for creates and only when an update changes the
 * target date, allowing an overdue confirmed goal to receive other corrections.
 */
export function validateGoalDraft({
  precedingConfirmedGoal = null,
  draft,
  localDate,
}) {
  assertLocalDate(localDate, 'localDate');
  const hasPrecedingGoal = precedingConfirmedGoal !== null;
  const preceding = hasPrecedingGoal ? assertConfirmedGoal(precedingConfirmedGoal) : null;
  const candidate = buildGoalCandidate(preceding, draft);
  const targetDateChanged = !hasPrecedingGoal
    || candidate.targetDate !== preceding.targetDate;
  const errors = validateGoalCandidate(candidate, {
    localDate,
    requireCurrentOrFutureTarget: targetDateChanged,
  });

  return {
    valid: errors.length === 0,
    candidateGoal: errors.length === 0 ? normalizeGoal(candidate) : null,
    errors,
  };
}

export function applyGoalDraft({
  precedingConfirmedGoal = null,
  draft,
  localDate,
  savingsTargetMinor,
  missingPlanInputs,
}) {
  const validation = validateGoalDraft({ precedingConfirmedGoal, draft, localDate });
  if (!validation.valid) {
    return {
      status: 'invalid',
      confirmedGoal: copyGoal(precedingConfirmedGoal),
      invalidDraft: copyDraft(draft),
      errors: validation.errors,
      outcome: precedingConfirmedGoal === null
        ? null
        : calculateGoal({
          goal: precedingConfirmedGoal,
          localDate,
          savingsTargetMinor,
          missingPlanInputs,
        }),
    };
  }

  const confirmedGoal = validation.candidateGoal;
  return {
    status: 'confirmed',
    confirmedGoal,
    invalidDraft: null,
    errors: [],
    outcome: calculateGoal({
      goal: confirmedGoal,
      localDate,
      savingsTargetMinor,
      missingPlanInputs,
    }),
  };
}

function assertAppliedContributionKeys(appliedContributionKeys) {
  if (!Array.isArray(appliedContributionKeys)) {
    throw new TypeError('appliedContributionKeys must be an array.');
  }

  const seen = new Set();
  for (const key of appliedContributionKeys) {
    if (typeof key !== 'string' || key.trim().length === 0 || seen.has(key)) {
      throw new TypeError(
        'appliedContributionKeys must contain unique nonblank idempotency keys.'
      );
    }
    seen.add(key);
  }
  return [...appliedContributionKeys];
}

function contributionIssue(contributionMinor, fundingGapMinor) {
  if (!Number.isSafeInteger(contributionMinor)) {
    return validationIssue(
      'INVALID_GOAL_CONTRIBUTION',
      'contributionMinor',
      `a whole-paise amount from 1 through ${fundingGapMinor}`,
      'Contribution must use whole paise.'
    );
  }
  if (contributionMinor <= 0 || contributionMinor > fundingGapMinor) {
    return validationIssue(
      'GOAL_CONTRIBUTION_OUT_OF_RANGE',
      'contributionMinor',
      `from 1 through ${fundingGapMinor} paise, inclusive`,
      `Contribution must be between 1 and ${fundingGapMinor} paise.`
    );
  }
  return null;
}

/**
 * Apply a bounded contribution to immutable confirmed state. The caller passes
 * its persisted idempotency-key set; replay returns the current confirmed state
 * without adding the amount again.
 */
export function applyGoalContribution({
  confirmedGoal,
  contributionMinor,
  idempotencyKey,
  appliedContributionKeys = [],
  localDate,
  savingsTargetMinor,
  missingPlanInputs,
}) {
  if (typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0) {
    throw new TypeError('idempotencyKey must be a nonblank string.');
  }
  const contributionKeys = assertAppliedContributionKeys(appliedContributionKeys);
  const precedingGoal = assertConfirmedGoal(confirmedGoal);
  const precedingOutcome = calculateGoal({
    goal: precedingGoal,
    localDate,
    savingsTargetMinor,
    missingPlanInputs,
  });

  if (contributionKeys.includes(idempotencyKey)) {
    return {
      status: 'replayed',
      confirmedGoal: copyGoal(precedingGoal),
      invalidContributionDraft: null,
      errors: [],
      appliedContributionKeys: contributionKeys,
      outcome: precedingOutcome,
    };
  }

  const error = contributionIssue(contributionMinor, precedingOutcome.fundingGapMinor);
  if (error) {
    return {
      status: 'invalid',
      confirmedGoal: copyGoal(precedingGoal),
      invalidContributionDraft: { contributionMinor, idempotencyKey },
      errors: [error],
      appliedContributionKeys: contributionKeys,
      outcome: precedingOutcome,
    };
  }

  const resultingGoal = {
    ...precedingGoal,
    savedAmountMinor: sumPaise(
      [precedingGoal.savedAmountMinor, contributionMinor],
      { allowNegative: false, label: 'saved amount after contribution' }
    ),
  };
  return {
    status: 'confirmed',
    confirmedGoal: resultingGoal,
    invalidContributionDraft: null,
    errors: [],
    appliedContributionKeys: [...contributionKeys, idempotencyKey],
    outcome: calculateGoal({
      goal: resultingGoal,
      localDate,
      savingsTargetMinor,
      missingPlanInputs,
    }),
  };
}

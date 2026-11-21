import db from '../db/index.js';
import {
  GoalValidationError,
  applyGoalContribution,
  calculateGoal,
  validateGoalDraft,
} from '../domain/goals.js';
import { legacyNumberToPaise, parseDecimalToPaise } from '../domain/money.js';
import clarityService from './clarityService.js';
import {
  FinancialMutationError,
  FinancialMutationService,
} from './financialMutation.js';

const MAX_AMOUNT_MINOR = 100_000_000_000_000;
const MAX_NAME_LENGTH = 60;
const TIME_ZONE = 'Asia/Kolkata';
// Used only to validate a legacy, undated goal: it is always a valid future
// date, and is never persisted (the stored target_date stays NULL).
const UNDATED_VALIDATION_DATE = '9999-12-31';
const GOAL_DRAFT_FIELDS = Object.freeze([
  'name',
  'targetAmountMinor',
  'savedAmountMinor',
  'targetDate',
]);

export const GOAL_ACCEPTED_CONSTRAINTS = Object.freeze({
  name: Object.freeze({ minLength: 1, maxLength: MAX_NAME_LENGTH, nonBlank: true }),
  targetAmountMinor: Object.freeze({ minMinor: 1, maxMinor: MAX_AMOUNT_MINOR, integer: true }),
  savedAmountMinor: Object.freeze({
    minMinor: 0,
    maxMinor: 'targetAmountMinor',
    integer: true,
  }),
  targetDate: Object.freeze({
    format: 'YYYY-MM-DD',
    minDate: 'current local date when created or changed',
  }),
  expectedRecordVersion: Object.freeze({ min: 0, integer: true, optional: true }),
});

export const GOAL_CONTRIBUTION_ACCEPTED_CONSTRAINTS = Object.freeze({
  contributionMinor: Object.freeze({
    minMinor: 1,
    maxMinor: 'current funding gap',
    integer: true,
  }),
  expectedRecordVersion: GOAL_ACCEPTED_CONSTRAINTS.expectedRecordVersion,
});

function commandError(code, message, httpStatus, details = {}) {
  throw new FinancialMutationError({ code, message, httpStatus, details });
}

function assertBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    commandError('INVALID_MUTATION_COMMAND', 'Request body must be an object.', 400);
  }
  return body;
}

function normalizeRecordId(value) {
  const id = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(id) || id <= 0) {
    commandError(
      'INVALID_RECORD_ID',
      'Goal identifier is invalid.',
      400,
      { field: 'id', constraint: { min: 1, integer: true } }
    );
  }
  return id;
}

function normalizeExpectedRecordVersion(body) {
  const value = body.expectedRecordVersion;
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    commandError(
      'INVALID_EXPECTED_RECORD_VERSION',
      'expectedRecordVersion must be a non-negative integer.',
      400,
      {
        field: 'expectedRecordVersion',
        constraint: GOAL_ACCEPTED_CONSTRAINTS.expectedRecordVersion,
      }
    );
  }
  return value;
}

/**
 * Read one money field supplied as integer paise or as a decimal alias. A
 * negative value is passed through so the domain can name the accepted bound.
 * Returns undefined when no alias is present.
 */
function normalizeMoneyField(input, { minorKey, majorKeys, code, constraint }) {
  let resolved;
  for (const key of [minorKey, ...majorKeys]) {
    if (!Object.hasOwn(input, key)) continue;
    const raw = input[key];
    let minor;
    if (key === minorKey) {
      if (!Number.isSafeInteger(raw)) {
        commandError(
          code,
          `${minorKey} must be an integer number of paise.`,
          400,
          { field: minorKey, constraint }
        );
      }
      minor = raw;
    } else {
      if (
        !['number', 'string'].includes(typeof raw)
        || (typeof raw === 'number' && !Number.isFinite(raw))
      ) {
        commandError(
          code,
          `${key} must use plain decimal notation with at most two fraction digits.`,
          400,
          { field: minorKey, constraint }
        );
      }
      try {
        minor = parseDecimalToPaise(String(raw), { allowNegative: true, label: key });
      } catch {
        commandError(
          code,
          `${key} must use plain decimal notation with at most two fraction digits.`,
          400,
          { field: minorKey, constraint }
        );
      }
    }
    if (resolved !== undefined && resolved !== minor) {
      commandError(
        'AMBIGUOUS_GOAL_AMOUNT',
        `${minorKey} and its aliases must identify the same value.`,
        400,
        { field: minorKey, constraint }
      );
    }
    resolved = minor;
  }
  if (resolved !== undefined && Math.abs(resolved) > MAX_AMOUNT_MINOR) {
    commandError(
      'GOAL_AMOUNT_OUT_OF_RANGE',
      'Goal amount is above the accepted maximum.',
      422,
      { field: minorKey, constraint }
    );
  }
  return resolved;
}

const targetAmountField = (input) => normalizeMoneyField(input, {
  minorKey: 'targetAmountMinor',
  majorKeys: ['targetAmount'],
  code: 'INVALID_GOAL_AMOUNT_FORMAT',
  constraint: GOAL_ACCEPTED_CONSTRAINTS.targetAmountMinor,
});

const savedAmountField = (input) => normalizeMoneyField(input, {
  minorKey: 'savedAmountMinor',
  majorKeys: ['savedAmount', 'setSaved'],
  code: 'INVALID_GOAL_AMOUNT_FORMAT',
  constraint: GOAL_ACCEPTED_CONSTRAINTS.savedAmountMinor,
});

function normalizeName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (name.length > MAX_NAME_LENGTH) {
    commandError(
      'INVALID_GOAL_NAME',
      `Goal name must contain at most ${MAX_NAME_LENGTH} characters.`,
      422,
      { field: 'name', constraint: GOAL_ACCEPTED_CONSTRAINTS.name }
    );
  }
  return name;
}

export function normalizeGoalCreateCommand(body) {
  const input = assertBody(body);
  return {
    command: {
      name: normalizeName(input.name),
      targetAmountMinor: targetAmountField(input) ?? null,
      savedAmountMinor: savedAmountField(input) ?? 0,
      targetDate: typeof input.targetDate === 'string' ? input.targetDate : null,
    },
    expectedRecordVersion: normalizeExpectedRecordVersion(input),
  };
}

export function normalizeGoalUpdateCommand(body, recordId) {
  const input = assertBody(body);
  if (Object.hasOwn(input, 'addToSaved')) {
    commandError(
      'GOAL_ADD_TO_SAVED_NOT_SUPPORTED',
      'Record contributions with POST /goals/:id/contributions; correct the saved amount with savedAmountMinor.',
      400,
      { field: 'addToSaved', constraint: GOAL_CONTRIBUTION_ACCEPTED_CONSTRAINTS.contributionMinor }
    );
  }
  const patch = {};
  if (Object.hasOwn(input, 'name')) patch.name = normalizeName(input.name);
  const targetAmountMinor = targetAmountField(input);
  if (targetAmountMinor !== undefined) patch.targetAmountMinor = targetAmountMinor;
  const savedAmountMinor = savedAmountField(input);
  if (savedAmountMinor !== undefined) patch.savedAmountMinor = savedAmountMinor;
  if (Object.hasOwn(input, 'targetDate')) {
    patch.targetDate = typeof input.targetDate === 'string' ? input.targetDate : null;
  }
  if (Object.keys(patch).length === 0) {
    commandError(
      'EMPTY_GOAL_UPDATE',
      'At least one goal field must be updated.',
      400,
      { constraint: { minUpdatedFields: 1 } }
    );
  }
  return {
    command: { id: normalizeRecordId(recordId), patch },
    expectedRecordVersion: normalizeExpectedRecordVersion(input),
  };
}

export function normalizeGoalDeleteCommand(body, recordId) {
  const input = assertBody(body ?? {});
  return {
    command: { id: normalizeRecordId(recordId) },
    expectedRecordVersion: normalizeExpectedRecordVersion(input),
  };
}

export function normalizeGoalContributionCommand(body, recordId) {
  const input = assertBody(body);
  const contributionMinor = normalizeMoneyField(input, {
    minorKey: 'contributionMinor',
    majorKeys: ['contributionAmount'],
    code: 'INVALID_GOAL_CONTRIBUTION',
    constraint: GOAL_CONTRIBUTION_ACCEPTED_CONSTRAINTS.contributionMinor,
  });
  if (contributionMinor === undefined) {
    commandError(
      'GOAL_CONTRIBUTION_REQUIRED',
      'A contribution amount is required.',
      400,
      {
        field: 'contributionMinor',
        constraint: GOAL_CONTRIBUTION_ACCEPTED_CONSTRAINTS.contributionMinor,
      }
    );
  }
  return {
    command: { id: normalizeRecordId(recordId), contributionMinor },
    expectedRecordVersion: normalizeExpectedRecordVersion(input),
  };
}

export function localDateForInstant(now, timeZone = TIME_ZONE) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now must be a valid Date.');
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function toRowId(value, label) {
  const id = typeof value === 'bigint' ? Number(value) : value;
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return id;
}

// Legacy rows may hold values that are not whole paise. They convert to null
// so the strict domain reports them as invalid fields instead of throwing, and
// the stored row is never rewritten unless the user corrects that field.
function minorOrNull(value) {
  try {
    return legacyNumberToPaise(Number(value), { label: 'goal amount' });
  } catch {
    return null;
  }
}

export function goalRecordFromRow(row) {
  if (!row) return null;
  return {
    id: toRowId(row.id, 'goal id'),
    name: row.name,
    targetAmountMinor: minorOrNull(row.target_amount),
    savedAmountMinor: minorOrNull(row.saved_amount),
    targetDate: row.target_date ?? null,
  };
}

export function legacyGoalFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    target_amount: row.target_amount,
    saved_amount: row.saved_amount,
    target_date: row.target_date ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function validationFailure(errors, { httpStatus = 422, code } = {}) {
  const [first] = errors;
  throw new FinancialMutationError({
    code: code ?? first.code,
    message: first.message,
    httpStatus,
    details: {
      field: first.field,
      constraint: first.constraint,
      errors: errors.map(({ code: errorCode, field, constraint, message }) => ({
        code: errorCode,
        field,
        constraint,
        message,
      })),
    },
  });
}

function isStrictlyValid(goal) {
  try {
    calculateGoal({ goal, localDate: '2000-01-01' });
    return true;
  } catch (error) {
    if (error instanceof GoalValidationError) return false;
    throw error;
  }
}

/**
 * Validate one create or update against the strict goal domain and return the
 * resulting goal. Nothing is written here, so an invalid draft leaves the
 * preceding confirmed row untouched.
 *
 * Legacy rows can already violate the strict bounds (overfunded, undated, or
 * sub-paise amounts). An unchanged field never blocks correcting a different
 * field; every field the draft changes, and the saved/target relation when
 * either amount changes, must be valid. `legacyUndated` lets a legacy
 * (non-contract) request keep a goal without a target date.
 */
export function resolveGoalChange({
  preceding = null,
  draft,
  now,
  legacyUndated = false,
}) {
  const localDate = localDateForInstant(now);
  const merged = { ...(preceding ?? {}), ...draft };
  const undated = legacyUndated && (merged.targetDate === null || merged.targetDate === undefined);
  const validationDraft = undated
    ? { ...draft, targetDate: UNDATED_VALIDATION_DATE }
    : draft;

  let errors;
  if (preceding === null) {
    errors = validateGoalDraft({
      precedingConfirmedGoal: null,
      draft: validationDraft,
      localDate,
    }).errors;
  } else if (isStrictlyValid(preceding)) {
    errors = validateGoalDraft({
      precedingConfirmedGoal: preceding,
      draft: validationDraft,
      localDate,
    }).errors;
  } else {
    const touched = new Set(GOAL_DRAFT_FIELDS.filter(
      (field) => Object.hasOwn(draft, field) && !Object.is(draft[field], preceding[field])
    ));
    const amountsTouched = touched.has('targetAmountMinor') || touched.has('savedAmountMinor');
    errors = validateGoalDraft({
      precedingConfirmedGoal: null,
      draft: undated ? { ...merged, targetDate: UNDATED_VALIDATION_DATE } : merged,
      localDate,
    }).errors.filter((error) => (
      touched.has(error.field)
      || (error.code === 'GOAL_SAVED_AMOUNT_EXCEEDS_TARGET' && amountsTouched)
    ));
  }

  if (errors.length > 0) validationFailure(errors);
  return {
    ...merged,
    name: merged.name.trim(),
    targetDate: undated ? null : merged.targetDate,
  };
}

function describeGoalOutcome(goal, now) {
  try {
    const outcome = calculateGoal({ goal, localDate: localDateForInstant(now) });
    return {
      status: outcome.status,
      fundingGapMinor: outcome.fundingGapMinor,
      contributionOpportunities: outcome.contributionOpportunities,
      requiredContributionMinor: outcome.requiredContributionMinor,
    };
  } catch (error) {
    if (error instanceof GoalValidationError) return null;
    throw error;
  }
}

function goalSummary(goal) {
  return {
    name: goal.name,
    targetAmountMinor: goal.targetAmountMinor,
    savedAmountMinor: goal.savedAmountMinor,
    targetDate: goal.targetDate,
  };
}

function currentMonthForInstant(now) {
  return localDateForInstant(now).slice(0, 7);
}

function goalContext({ command, idempotencyKey, receipt, now }) {
  const snapshotMonth = currentMonthForInstant(now);
  const recordId = receipt?.recordId ?? command.id ?? null;
  return {
    snapshotMonth,
    scopeKey: recordId === null ? `new-goal:${idempotencyKey}` : `goal:${recordId}`,
    affectedOutcomes: [
      { key: 'goals', id: `goal-feasibility:${snapshotMonth}`, kind: 'goal_feasibility' },
    ],
  };
}

const GOAL_COLUMNS = 'id, name, target_amount, saved_amount, target_date, created_at, updated_at';

async function loadGoalRow(database, userId, id) {
  return database.prepare(
    `SELECT ${GOAL_COLUMNS} FROM savings_goals WHERE id = ? AND user_id = ?`
  ).get(id, userId);
}

// The mutation service rejects an unowned or missing record with a uniform 404
// before any statement runs, so this placeholder is never executed.
function missingRecordPlan(action, id, userId, extra = {}) {
  return {
    action,
    recordType: 'goal',
    recordId: id,
    sourceStatement: {
      sql: 'UPDATE savings_goals SET updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?',
      args: [id, userId],
    },
    ...extra,
  };
}

const majorAmount = (amountMinor) => amountMinor / 100;

function updateAssignments(patch) {
  const assignments = [];
  const args = [];
  const columns = [
    ['name', 'name', (value) => value],
    ['targetAmountMinor', 'target_amount', majorAmount],
    ['savedAmountMinor', 'saved_amount', majorAmount],
    ['targetDate', 'target_date', (value) => value],
  ];
  for (const [field, column, convert] of columns) {
    if (!Object.hasOwn(patch, field)) continue;
    assignments.push(`${column} = ?`);
    args.push(convert(patch[field]));
  }
  assignments.push('updated_at = CURRENT_TIMESTAMP');
  return { assignments, args };
}

export function createGoalOperationHandlers({ database = db } = {}) {
  return {
    'goal.create': {
      getContext: goalContext,
      async prepare({ command, userId, now }) {
        const goal = resolveGoalChange({
          preceding: null,
          draft: {
            name: command.name,
            targetAmountMinor: command.targetAmountMinor,
            savedAmountMinor: command.savedAmountMinor,
            targetDate: command.targetDate,
          },
          now,
        });
        return {
          action: 'create',
          recordType: 'goal',
          recordId: null,
          sourceStatement: {
            sql: `INSERT INTO savings_goals
              (user_id, name, target_amount, saved_amount, target_date, updated_at)
              VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
            args: [
              userId,
              goal.name,
              majorAmount(goal.targetAmountMinor),
              majorAmount(goal.savedAmountMinor),
              goal.targetDate,
            ],
          },
          result: {
            type: 'create',
            status: 'confirmed',
            goal: goalSummary(goal),
            outcome: describeGoalOutcome(goal, now),
          },
        };
      },
    },
    'goal.update': {
      getContext: goalContext,
      async prepare({ command, userId, now }) {
        const row = await loadGoalRow(database, userId, command.id);
        if (!row) return missingRecordPlan('update', command.id, userId);
        const preceding = goalRecordFromRow(row);
        const goal = resolveGoalChange({ preceding, draft: command.patch, now });
        const { assignments, args } = updateAssignments(command.patch);
        return {
          action: 'update',
          recordType: 'goal',
          recordId: command.id,
          sourceStatement: {
            sql: `UPDATE savings_goals SET ${assignments.join(', ')}
                   WHERE id = ? AND user_id = ?`,
            args: [...args, command.id, userId],
          },
          result: {
            type: 'update',
            status: 'confirmed',
            goal: goalSummary(goal),
            outcome: describeGoalOutcome(goal, now),
          },
        };
      },
    },
    'goal.delete': {
      getContext: goalContext,
      async prepare({ command, userId }) {
        return {
          action: 'delete',
          recordType: 'goal',
          recordId: command.id,
          sourceStatement: {
            sql: 'DELETE FROM savings_goals WHERE id = ? AND user_id = ?',
            args: [command.id, userId],
          },
        };
      },
    },
    'goal.contribute': {
      getContext: goalContext,
      async prepare({ command, userId, idempotencyKey, now }) {
        const row = await loadGoalRow(database, userId, command.id);
        if (!row) return missingRecordPlan('update', command.id, userId);
        const record = goalRecordFromRow(row);
        const confirmedGoal = {
          id: record.id,
          name: record.name,
          targetAmountMinor: record.targetAmountMinor,
          savedAmountMinor: record.savedAmountMinor,
          targetDate: record.targetDate,
        };

        let applied;
        try {
          applied = applyGoalContribution({
            confirmedGoal,
            contributionMinor: command.contributionMinor,
            idempotencyKey,
            appliedContributionKeys: [],
            localDate: localDateForInstant(now),
          });
        } catch (error) {
          if (!(error instanceof GoalValidationError)) throw error;
          // Legacy data that violates the strict bounds must be corrected with
          // PATCH first; the contribution flow never repairs it implicitly.
          validationFailure(error.errors, { code: 'GOAL_REQUIRES_CORRECTION' });
        }

        if (applied.status === 'invalid') {
          const fundingGapMinor = applied.outcome.fundingGapMinor;
          const [issue] = applied.errors;
          throw new FinancialMutationError({
            code: issue.code,
            message: fundingGapMinor === 0
              ? 'This goal is already fully funded, so no contribution is accepted.'
              : `Contribution must be between 1 and ${fundingGapMinor} paise.`,
            httpStatus: 422,
            details: {
              field: 'contributionMinor',
              constraint: { minMinor: 1, maxMinor: fundingGapMinor, integer: true },
              errors: [{
                code: issue.code,
                field: 'contributionMinor',
                constraint: { minMinor: 1, maxMinor: fundingGapMinor, integer: true },
                message: issue.message,
              }],
            },
          });
        }

        const resulting = applied.confirmedGoal;
        return {
          action: 'update',
          recordType: 'goal',
          recordId: command.id,
          sourceStatement: {
            // Compare-and-swap on the amount read above. A concurrent write
            // that bypassed the versioned flow turns this into a NOT NULL
            // violation, which rolls back the receipt and version together.
            sql: `UPDATE savings_goals
                     SET saved_amount = CASE WHEN saved_amount = ? THEN ? ELSE NULL END,
                         updated_at = CURRENT_TIMESTAMP
                   WHERE id = ? AND user_id = ?`,
            args: [
              Number(row.saved_amount),
              majorAmount(resulting.savedAmountMinor),
              command.id,
              userId,
            ],
          },
          result: {
            type: 'contribution',
            status: 'confirmed',
            contributionMinor: command.contributionMinor,
            precedingSavedAmountMinor: record.savedAmountMinor,
            goal: goalSummary(resulting),
            outcome: {
              status: applied.outcome.status,
              fundingGapMinor: applied.outcome.fundingGapMinor,
              contributionOpportunities: applied.outcome.contributionOpportunities,
              requiredContributionMinor: applied.outcome.requiredContributionMinor,
            },
          },
        };
      },
    },
  };
}

export function createGoalMutationService({
  database = db,
  snapshotService = clarityService,
  ...serviceOptions
} = {}) {
  return new FinancialMutationService({
    database,
    snapshotService,
    operationHandlers: createGoalOperationHandlers({ database }),
    ...serviceOptions,
  });
}

function legacyMinor(value, field) {
  try {
    return legacyNumberToPaise(Number(value), { label: field });
  } catch {
    commandError(
      'INVALID_GOAL_AMOUNT_FORMAT',
      'Amounts must use whole paise (at most two decimal places).',
      422,
      { field }
    );
  }
}

/**
 * Legacy (non-contract) goal create. Strictly validated, written directly as
 * before, and answered with the unchanged `{ id }` shape by the caller.
 */
export async function createGoalLegacy({ database = db, userId, body, now = new Date() }) {
  const goal = resolveGoalChange({
    preceding: null,
    legacyUndated: true,
    now,
    draft: {
      name: String(body.name).trim(),
      targetAmountMinor: legacyMinor(body.targetAmount, 'targetAmountMinor'),
      savedAmountMinor: legacyMinor(body.savedAmount || 0, 'savedAmountMinor'),
      targetDate: body.targetDate || null,
    },
  });
  const info = await database.prepare(
    `INSERT INTO savings_goals (user_id, name, target_amount, saved_amount, target_date)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    userId,
    goal.name,
    majorAmount(goal.targetAmountMinor),
    majorAmount(goal.savedAmountMinor),
    goal.targetDate
  );
  return { id: info.lastInsertRowid };
}

/**
 * Legacy goal PATCH (name, targetAmount, targetDate, setSaved, addToSaved).
 * Returns null when the caller does not own the goal. Only the supplied columns
 * are written, so legacy-invalid fields the request does not touch stay as
 * stored.
 */
export async function patchGoalLegacy({
  database = db,
  userId,
  id,
  body,
  now = new Date(),
}) {
  const row = await loadGoalRow(database, userId, id);
  if (!row) return null;
  const preceding = goalRecordFromRow(row);

  const patch = {};
  if (body.name !== undefined) patch.name = String(body.name).trim();
  if (body.targetAmount !== undefined) {
    patch.targetAmountMinor = legacyMinor(body.targetAmount, 'targetAmountMinor');
  }
  if (body.targetDate !== undefined) patch.targetDate = body.targetDate || null;
  if (body.setSaved !== undefined) {
    patch.savedAmountMinor = legacyMinor(body.setSaved, 'savedAmountMinor');
  }
  if (body.addToSaved !== undefined) {
    if (preceding.savedAmountMinor === null) {
      commandError(
        'INVALID_GOAL_SAVED_AMOUNT',
        'Correct the saved amount before adding to it.',
        422,
        { field: 'savedAmountMinor' }
      );
    }
    patch.savedAmountMinor = Math.max(
      0,
      preceding.savedAmountMinor + legacyMinor(body.addToSaved, 'savedAmountMinor')
    );
  }
  if (Object.keys(patch).length === 0) {
    commandError('NOTHING_TO_UPDATE', 'Nothing to update', 400);
  }

  resolveGoalChange({ preceding, draft: patch, now, legacyUndated: true });
  const { assignments, args } = updateAssignments(patch);
  await database.prepare(
    `UPDATE savings_goals SET ${assignments.join(', ')} WHERE id = ? AND user_id = ?`
  ).run(...args, id, userId);
  return { id };
}

export { loadGoalRow };

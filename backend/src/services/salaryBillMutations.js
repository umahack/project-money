import db from '../db/index.js';
import { legacyNumberToPaise, parseDecimalToPaise } from '../domain/money.js';
import { assertMonth } from '../repositories/repositorySupport.js';
import clarityService from './clarityService.js';
import {
  FinancialMutationError,
  FinancialMutationService,
} from './financialMutation.js';

export const BILL_CATEGORIES = Object.freeze([
  'EMI',
  'Rent',
  'Utility',
  'Insurance',
  'Subscription',
  'Other',
]);

const MAX_AMOUNT_MINOR = 100_000_000_000_000;
const TIME_ZONE = 'Asia/Kolkata';

export const SALARY_ACCEPTED_CONSTRAINTS = Object.freeze({
  amountMinor: Object.freeze({ minMinor: 0, maxMinor: MAX_AMOUNT_MINOR, integer: true }),
  amount: Object.freeze({ min: 0, max: 1_000_000_000_000, fractionDigits: 2 }),
  month: Object.freeze({ format: 'YYYY-MM' }),
  expectedRecordVersion: Object.freeze({ min: 0, integer: true, optional: true }),
});

export const BILL_ACCEPTED_CONSTRAINTS = Object.freeze({
  label: Object.freeze({ minLength: 1, maxLength: 60 }),
  amountMinor: SALARY_ACCEPTED_CONSTRAINTS.amountMinor,
  amount: SALARY_ACCEPTED_CONSTRAINTS.amount,
  category: Object.freeze({ allowedValues: BILL_CATEGORIES }),
  active: Object.freeze({ type: 'boolean' }),
  effectiveFromMonth: Object.freeze({ format: 'YYYY-MM', nullable: true }),
  effectiveToMonth: Object.freeze({ format: 'YYYY-MM', nullable: true }),
  effectiveMonthRange: Object.freeze({ relation: 'effectiveFromMonth <= effectiveToMonth' }),
  applicableMonth: Object.freeze({ format: 'YYYY-MM', optional: true }),
  expectedRecordVersion: SALARY_ACCEPTED_CONSTRAINTS.expectedRecordVersion,
});

export const SALARY_APPLY_ACCEPTED_CONSTRAINTS = Object.freeze({
  sourceMonth: Object.freeze({ format: 'YYYY-MM', relation: 'sourceMonth < targetMonth' }),
  targetMonth: Object.freeze({ format: 'YYYY-MM', mustEqual: 'currentMonth', optional: true }),
  expectedRecordVersion: SALARY_ACCEPTED_CONSTRAINTS.expectedRecordVersion,
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

function normalizeMonth(value, field) {
  try {
    return assertMonth(value, field);
  } catch {
    commandError(
      'INVALID_MONTH',
      `${field} must use YYYY-MM format.`,
      400,
      { field, constraint: { format: 'YYYY-MM' } }
    );
  }
}

function normalizeNullableMonth(value, field) {
  if (value === null) return null;
  return normalizeMonth(value, field);
}

function currentMonthForInstant(now, timeZone = TIME_ZONE) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now must be a valid Date.');
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}`;
}

function normalizeAmountMinor(body) {
  const hasAmountMinor = Object.hasOwn(body, 'amountMinor');
  const hasAmount = Object.hasOwn(body, 'amount');
  if (!hasAmountMinor && !hasAmount) {
    commandError(
      'AMOUNT_REQUIRED',
      'Amount is required.',
      400,
      { field: 'amountMinor', constraint: SALARY_ACCEPTED_CONSTRAINTS.amountMinor }
    );
  }

  let amountMinor;
  if (hasAmountMinor) {
    amountMinor = body.amountMinor;
    if (!Number.isSafeInteger(amountMinor)) {
      commandError(
        'INVALID_AMOUNT_FORMAT',
        'amountMinor must be an integer number of paise.',
        400,
        { field: 'amountMinor', constraint: SALARY_ACCEPTED_CONSTRAINTS.amountMinor }
      );
    }
  }

  if (hasAmount) {
    const amount = body.amount;
    if (!['number', 'string'].includes(typeof amount) || (typeof amount === 'number' && !Number.isFinite(amount))) {
      commandError(
        'INVALID_AMOUNT_FORMAT',
        'amount must use plain decimal notation with at most two fraction digits.',
        400,
        { field: 'amount', constraint: SALARY_ACCEPTED_CONSTRAINTS.amount }
      );
    }
    let parsed;
    try {
      parsed = parseDecimalToPaise(String(amount), { label: 'amount' });
    } catch {
      commandError(
        'INVALID_AMOUNT_FORMAT',
        'amount must use plain decimal notation with at most two fraction digits.',
        400,
        { field: 'amount', constraint: SALARY_ACCEPTED_CONSTRAINTS.amount }
      );
    }
    if (hasAmountMinor && amountMinor !== parsed) {
      commandError(
        'AMBIGUOUS_AMOUNT',
        'amount and amountMinor must identify the same value.',
        400,
        { field: 'amountMinor', constraint: SALARY_ACCEPTED_CONSTRAINTS.amountMinor }
      );
    }
    amountMinor = parsed;
  }

  if (amountMinor < 0 || amountMinor > MAX_AMOUNT_MINOR) {
    commandError(
      'AMOUNT_OUT_OF_RANGE',
      'Amount must be between zero and the accepted maximum.',
      422,
      {
        field: hasAmountMinor ? 'amountMinor' : 'amount',
        constraint: hasAmountMinor
          ? SALARY_ACCEPTED_CONSTRAINTS.amountMinor
          : SALARY_ACCEPTED_CONSTRAINTS.amount,
      }
    );
  }
  return amountMinor;
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
        constraint: SALARY_ACCEPTED_CONSTRAINTS.expectedRecordVersion,
      }
    );
  }
  return value;
}

function normalizeRecordId(value) {
  const id = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(id) || id <= 0) {
    commandError(
      'INVALID_RECORD_ID',
      'Financial record identifier is invalid.',
      400,
      { field: 'id', constraint: { min: 1, integer: true } }
    );
  }
  return id;
}

function normalizeLabel(value) {
  if (typeof value !== 'string') {
    commandError(
      'INVALID_BILL_LABEL',
      'Bill label must contain between 1 and 60 characters.',
      400,
      { field: 'label', constraint: BILL_ACCEPTED_CONSTRAINTS.label }
    );
  }
  const label = value.trim();
  if (label.length < 1 || label.length > 60) {
    commandError(
      'INVALID_BILL_LABEL',
      'Bill label must contain between 1 and 60 characters.',
      422,
      { field: 'label', constraint: BILL_ACCEPTED_CONSTRAINTS.label }
    );
  }
  return label;
}

function normalizeCategory(value) {
  if (typeof value !== 'string' || !BILL_CATEGORIES.includes(value)) {
    commandError(
      'INVALID_BILL_CATEGORY',
      'Bill category is not accepted.',
      422,
      { field: 'category', constraint: BILL_ACCEPTED_CONSTRAINTS.category }
    );
  }
  return value;
}

function normalizeActive(value) {
  if (typeof value !== 'boolean') {
    commandError(
      'INVALID_BILL_ACTIVE',
      'active must be a boolean.',
      400,
      { field: 'active', constraint: BILL_ACCEPTED_CONSTRAINTS.active }
    );
  }
  return value;
}

function normalizeApplicableMonth(body, now) {
  const applicableMonth = body.applicableMonth;
  const legacyAlias = body.month;
  if (
    applicableMonth !== undefined
    && legacyAlias !== undefined
    && applicableMonth !== legacyAlias
  ) {
    commandError(
      'AMBIGUOUS_APPLICABLE_MONTH',
      'applicableMonth and month must identify the same month.',
      400,
      { field: 'applicableMonth', constraint: BILL_ACCEPTED_CONSTRAINTS.applicableMonth }
    );
  }
  const value = applicableMonth ?? legacyAlias ?? currentMonthForInstant(now);
  return normalizeMonth(value, 'applicableMonth');
}

function assertEffectiveRange(effectiveFromMonth, effectiveToMonth) {
  if (
    effectiveFromMonth !== null
    && effectiveToMonth !== null
    && effectiveFromMonth > effectiveToMonth
  ) {
    commandError(
      'INVALID_BILL_EFFECTIVE_RANGE',
      'effectiveFromMonth must not be after effectiveToMonth.',
      422,
      {
        field: 'effectiveToMonth',
        constraint: BILL_ACCEPTED_CONSTRAINTS.effectiveMonthRange,
      }
    );
  }
}

export function normalizeSalaryCommand(body, now = new Date()) {
  const input = assertBody(body);
  return {
    command: {
      month: normalizeMonth(input.month ?? currentMonthForInstant(now), 'month'),
      amountMinor: normalizeAmountMinor(input),
    },
    expectedRecordVersion: normalizeExpectedRecordVersion(input),
  };
}

export function normalizeBillCreateCommand(body, now = new Date()) {
  const input = assertBody(body);
  const effectiveFromMonth = input.effectiveFromMonth === undefined
    ? null
    : normalizeNullableMonth(input.effectiveFromMonth, 'effectiveFromMonth');
  const effectiveToMonth = input.effectiveToMonth === undefined
    ? null
    : normalizeNullableMonth(input.effectiveToMonth, 'effectiveToMonth');
  assertEffectiveRange(effectiveFromMonth, effectiveToMonth);
  return {
    command: {
      label: normalizeLabel(input.label),
      amountMinor: normalizeAmountMinor(input),
      category: normalizeCategory(input.category),
      active: input.active === undefined ? true : normalizeActive(input.active),
      effectiveFromMonth,
      effectiveToMonth,
      snapshotMonth: normalizeApplicableMonth(input, now),
    },
    expectedRecordVersion: normalizeExpectedRecordVersion(input),
  };
}

export function normalizeBillUpdateCommand(body, recordId, now = new Date()) {
  const input = assertBody(body);
  const patch = {};
  if (Object.hasOwn(input, 'label')) patch.label = normalizeLabel(input.label);
  if (Object.hasOwn(input, 'amount') || Object.hasOwn(input, 'amountMinor')) {
    patch.amountMinor = normalizeAmountMinor(input);
  }
  if (Object.hasOwn(input, 'category')) patch.category = normalizeCategory(input.category);
  if (Object.hasOwn(input, 'active')) patch.active = normalizeActive(input.active);
  if (Object.hasOwn(input, 'effectiveFromMonth')) {
    patch.effectiveFromMonth = normalizeNullableMonth(
      input.effectiveFromMonth,
      'effectiveFromMonth'
    );
  }
  if (Object.hasOwn(input, 'effectiveToMonth')) {
    patch.effectiveToMonth = normalizeNullableMonth(
      input.effectiveToMonth,
      'effectiveToMonth'
    );
  }
  if (Object.keys(patch).length === 0) {
    commandError(
      'EMPTY_BILL_UPDATE',
      'At least one bill field must be updated.',
      400,
      { constraint: { minUpdatedFields: 1 } }
    );
  }
  return {
    command: {
      id: normalizeRecordId(recordId),
      patch,
      snapshotMonth: normalizeApplicableMonth(input, now),
    },
    expectedRecordVersion: normalizeExpectedRecordVersion(input),
  };
}

export function normalizeBillDeleteCommand(body, recordId, now = new Date()) {
  const input = assertBody(body ?? {});
  return {
    command: {
      id: normalizeRecordId(recordId),
      snapshotMonth: normalizeApplicableMonth(input, now),
    },
    expectedRecordVersion: normalizeExpectedRecordVersion(input),
  };
}

export function normalizeSalaryApplyCommand(body, now = new Date()) {
  const input = assertBody(body);
  const currentMonth = currentMonthForInstant(now);
  const sourceMonth = normalizeMonth(input.sourceMonth, 'sourceMonth');
  const targetMonth = normalizeMonth(input.targetMonth ?? currentMonth, 'targetMonth');
  if (targetMonth !== currentMonth) {
    commandError(
      'TARGET_MONTH_NOT_CURRENT',
      'targetMonth must be the current month.',
      422,
      { field: 'targetMonth', constraint: { mustEqual: currentMonth } }
    );
  }
  if (sourceMonth >= targetMonth) {
    commandError(
      'SOURCE_MONTH_NOT_PRIOR',
      'sourceMonth must be earlier than targetMonth.',
      422,
      {
        field: 'sourceMonth',
        constraint: { relation: 'sourceMonth < targetMonth' },
      }
    );
  }
  return {
    command: { sourceMonth, targetMonth },
    expectedRecordVersion: normalizeExpectedRecordVersion(input),
  };
}

function affectedPlanOutcomes(month) {
  return [
    { key: 'monthlyPlan', id: `monthly-plan:${month}`, kind: 'monthly_plan' },
    { key: 'spending', id: `spending:${month}`, kind: 'spending' },
    { key: 'goals', id: `goal-feasibility:${month}`, kind: 'goal_feasibility' },
  ];
}

function salaryContext({ command }) {
  return {
    snapshotMonth: command.month,
    scopeKey: `salary:${command.month}`,
    affectedOutcomes: affectedPlanOutcomes(command.month),
  };
}

function salaryApplyContext({ command }) {
  return {
    snapshotMonth: command.targetMonth,
    scopeKey: `salary:${command.targetMonth}`,
    affectedOutcomes: affectedPlanOutcomes(command.targetMonth),
  };
}

function billContext({ command, idempotencyKey, receipt }) {
  const recordId = receipt?.recordId ?? command.id ?? null;
  return {
    snapshotMonth: command.snapshotMonth,
    scopeKey: recordId === null ? `new-bill:${idempotencyKey}` : `bill:${recordId}`,
    affectedOutcomes: affectedPlanOutcomes(command.snapshotMonth),
  };
}

function majorAmount(amountMinor) {
  return amountMinor / 100;
}

function toRowId(value, label) {
  const id = typeof value === 'bigint' ? Number(value) : value;
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return id;
}

export function createSalaryBillOperationHandlers() {
  return {
    'salary.upsert': {
      getContext: salaryContext,
      async prepare({ command, userId, database }) {
        const existing = await database.prepare(
          'SELECT id FROM salary_entries WHERE user_id = ? AND month = ?'
        ).get(userId, command.month);
        if (existing) {
          const recordId = toRowId(existing.id, 'salary id');
          return {
            action: 'update',
            recordType: 'salary',
            recordId,
            sourceStatement: {
              sql: `UPDATE salary_entries
                       SET amount = ?, updated_at = CURRENT_TIMESTAMP
                     WHERE id = ? AND user_id = ?`,
              args: [majorAmount(command.amountMinor), recordId, userId],
            },
          };
        }
        return {
          action: 'create',
          recordType: 'salary',
          recordId: null,
          sourceStatement: {
            sql: `INSERT INTO salary_entries (user_id, month, amount, updated_at)
                  VALUES (?, ?, ?, CURRENT_TIMESTAMP)`,
            args: [userId, command.month, majorAmount(command.amountMinor)],
          },
        };
      },
    },
    'salary.apply': {
      getContext: salaryApplyContext,
      async prepare({ command, userId, database }) {
        const source = await database.prepare(
          'SELECT id, amount FROM salary_entries WHERE user_id = ? AND month = ?'
        ).get(userId, command.sourceMonth);
        if (!source) {
          commandError(
            'SOURCE_SALARY_NOT_FOUND',
            'No confirmed salary exists for sourceMonth.',
            404,
            { field: 'sourceMonth' }
          );
        }
        let amountMinor;
        try {
          amountMinor = legacyNumberToPaise(Number(source.amount), {
            label: 'source salary amount',
          });
        } catch {
          commandError(
            'SOURCE_SALARY_INVALID',
            'The prior salary cannot be applied until its amount is corrected.',
            422,
            {
              field: 'sourceMonth',
              constraint: { amountMinor: SALARY_ACCEPTED_CONSTRAINTS.amountMinor },
            }
          );
        }
        const target = await database.prepare(
          'SELECT id FROM salary_entries WHERE user_id = ? AND month = ?'
        ).get(userId, command.targetMonth);
        if (target) {
          const recordId = toRowId(target.id, 'target salary id');
          return {
            action: 'update',
            recordType: 'salary',
            recordId,
            sourceStatement: {
              sql: `UPDATE salary_entries
                       SET amount = ?, updated_at = CURRENT_TIMESTAMP
                     WHERE id = ? AND user_id = ?`,
              args: [majorAmount(amountMinor), recordId, userId],
            },
          };
        }
        return {
          action: 'create',
          recordType: 'salary',
          recordId: null,
          sourceStatement: {
            sql: `INSERT INTO salary_entries (user_id, month, amount, updated_at)
                  VALUES (?, ?, ?, CURRENT_TIMESTAMP)`,
            args: [userId, command.targetMonth, majorAmount(amountMinor)],
          },
        };
      },
    },
    'bill.create': {
      getContext: billContext,
      async prepare({ command, userId }) {
        return {
          action: 'create',
          recordType: 'bill',
          recordId: null,
          sourceStatement: {
            sql: `INSERT INTO emis
                    (user_id, label, amount, category, active,
                     effective_from_month, effective_to_month, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
            args: [
              userId,
              command.label,
              majorAmount(command.amountMinor),
              command.category,
              command.active ? 1 : 0,
              command.effectiveFromMonth,
              command.effectiveToMonth,
            ],
          },
        };
      },
    },
    'bill.update': {
      getContext: billContext,
      async prepare({ command, userId, database }) {
        const existing = await database.prepare(
          `SELECT id, effective_from_month, effective_to_month
             FROM emis
            WHERE id = ? AND user_id = ?`
        ).get(command.id, userId);
        if (existing) {
          const effectiveFromMonth = Object.hasOwn(command.patch, 'effectiveFromMonth')
            ? command.patch.effectiveFromMonth
            : existing.effective_from_month ?? null;
          const effectiveToMonth = Object.hasOwn(command.patch, 'effectiveToMonth')
            ? command.patch.effectiveToMonth
            : existing.effective_to_month ?? null;
          assertEffectiveRange(effectiveFromMonth, effectiveToMonth);
        }

        const assignments = [];
        const args = [];
        const fieldMap = [
          ['label', 'label', (value) => value],
          ['amountMinor', 'amount', majorAmount],
          ['category', 'category', (value) => value],
          ['active', 'active', (value) => (value ? 1 : 0)],
          ['effectiveFromMonth', 'effective_from_month', (value) => value],
          ['effectiveToMonth', 'effective_to_month', (value) => value],
        ];
        for (const [commandField, column, convert] of fieldMap) {
          if (!Object.hasOwn(command.patch, commandField)) continue;
          assignments.push(`${column} = ?`);
          args.push(convert(command.patch[commandField]));
        }
        assignments.push('updated_at = CURRENT_TIMESTAMP');
        args.push(command.id, userId);
        return {
          action: 'update',
          recordType: 'bill',
          recordId: command.id,
          sourceStatement: {
            sql: `UPDATE emis SET ${assignments.join(', ')} WHERE id = ? AND user_id = ?`,
            args,
          },
        };
      },
    },
    'bill.delete': {
      getContext: billContext,
      async prepare({ command, userId }) {
        return {
          action: 'delete',
          recordType: 'bill',
          recordId: command.id,
          sourceStatement: {
            sql: 'DELETE FROM emis WHERE id = ? AND user_id = ?',
            args: [command.id, userId],
          },
        };
      },
    },
  };
}

export function createSalaryBillMutationService({
  database = db,
  snapshotService = clarityService,
  ...serviceOptions
} = {}) {
  return new FinancialMutationService({
    database,
    snapshotService,
    operationHandlers: createSalaryBillOperationHandlers(),
    ...serviceOptions,
  });
}

export function billRecordFromRow(row) {
  if (!row) return null;
  return {
    id: toRowId(row.id, 'bill id'),
    label: row.label,
    amountMinor: legacyNumberToPaise(Number(row.amount), { label: 'bill amount' }),
    category: row.category,
    active: Number(row.active) === 1,
    effectiveFromMonth: row.effective_from_month ?? null,
    effectiveToMonth: row.effective_to_month ?? null,
  };
}

export function salaryRecordFromRow(row) {
  if (!row) return null;
  return {
    id: toRowId(row.id, 'salary id'),
    month: row.month,
    amountMinor: legacyNumberToPaise(Number(row.amount), { label: 'salary amount' }),
  };
}

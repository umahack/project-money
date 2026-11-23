import db from '../db/index.js';
import {
  applyCategoryTreatmentTransition,
  applyExpenseTransition,
  createExpenseState,
  resolveCategoryTreatment,
} from '../domain/expenses.js';
import { legacyNumberToPaise, parseDecimalToPaise } from '../domain/money.js';
import clarityService from './clarityService.js';
import {
  FinancialMutationError,
  FinancialMutationService,
} from './financialMutation.js';

export const EXPENSE_CATEGORIES = Object.freeze([
  'Food',
  'Groceries',
  'Transport',
  'Shopping',
  'Entertainment',
  'Bills',
  'Health',
  'Travel',
  'Education',
  'Other',
]);

const CATEGORY_NAME_PATTERN = /^[A-Za-z0-9 &/+()-]{1,24}$/;
const MAX_AMOUNT_MINOR = 100_000_000_000_000;
const TIME_ZONE = 'Asia/Kolkata';
const TREATMENTS = Object.freeze(['needs', 'wants']);

export const EXPENSE_ACCEPTED_CONSTRAINTS = Object.freeze({
  amountMinor: Object.freeze({ minMinor: 0, maxMinor: MAX_AMOUNT_MINOR, integer: true }),
  amount: Object.freeze({ min: 0, max: 1_000_000_000_000, fractionDigits: 2 }),
  category: Object.freeze({
    minLength: 1,
    maxLength: 24,
    allowedValues: 'built-in or user-created expense category',
  }),
  note: Object.freeze({ maxLength: 120, nullable: true }),
  spentOn: Object.freeze({
    format: 'YYYY-MM-DD',
    earliestYearOffset: -10,
    latestYearOffset: 1,
  }),
  excludeFromDailyAllowance: Object.freeze({ type: 'boolean', optional: true }),
  expectedRecordVersion: Object.freeze({ min: 0, integer: true, optional: true }),
});

export const CATEGORY_TREATMENT_ACCEPTED_CONSTRAINTS = Object.freeze({
  category: EXPENSE_ACCEPTED_CONSTRAINTS.category,
  treatment: Object.freeze({ allowedValues: TREATMENTS }),
  expectedRecordVersion: EXPENSE_ACCEPTED_CONSTRAINTS.expectedRecordVersion,
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
      'Expense identifier is invalid.',
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
        constraint: EXPENSE_ACCEPTED_CONSTRAINTS.expectedRecordVersion,
      }
    );
  }
  return value;
}

function normalizeAmountMinor(body) {
  const hasAmountMinor = Object.hasOwn(body, 'amountMinor');
  const hasAmount = Object.hasOwn(body, 'amount');
  if (!hasAmountMinor && !hasAmount) {
    commandError(
      'EXPENSE_AMOUNT_REQUIRED',
      'Expense amount is required.',
      400,
      { field: 'amountMinor', constraint: EXPENSE_ACCEPTED_CONSTRAINTS.amountMinor }
    );
  }

  let amountMinor;
  if (hasAmountMinor) {
    amountMinor = body.amountMinor;
    if (!Number.isSafeInteger(amountMinor)) {
      commandError(
        'INVALID_EXPENSE_AMOUNT_FORMAT',
        'amountMinor must be an integer number of paise.',
        400,
        { field: 'amountMinor', constraint: EXPENSE_ACCEPTED_CONSTRAINTS.amountMinor }
      );
    }
  }

  if (hasAmount) {
    const amount = body.amount;
    if (
      !['number', 'string'].includes(typeof amount)
      || (typeof amount === 'number' && !Number.isFinite(amount))
    ) {
      commandError(
        'INVALID_EXPENSE_AMOUNT_FORMAT',
        'amount must use plain decimal notation with at most two fraction digits.',
        400,
        { field: 'amount', constraint: EXPENSE_ACCEPTED_CONSTRAINTS.amount }
      );
    }
    let parsed;
    try {
      parsed = parseDecimalToPaise(String(amount), { label: 'amount' });
    } catch {
      commandError(
        'INVALID_EXPENSE_AMOUNT_FORMAT',
        'amount must use plain decimal notation with at most two fraction digits.',
        400,
        { field: 'amount', constraint: EXPENSE_ACCEPTED_CONSTRAINTS.amount }
      );
    }
    if (hasAmountMinor && amountMinor !== parsed) {
      commandError(
        'AMBIGUOUS_EXPENSE_AMOUNT',
        'amount and amountMinor must identify the same value.',
        400,
        { field: 'amountMinor', constraint: EXPENSE_ACCEPTED_CONSTRAINTS.amountMinor }
      );
    }
    amountMinor = parsed;
  }

  if (amountMinor < 0 || amountMinor > MAX_AMOUNT_MINOR) {
    commandError(
      'EXPENSE_AMOUNT_OUT_OF_RANGE',
      'Expense amount must be between zero and the accepted maximum.',
      422,
      {
        field: hasAmountMinor ? 'amountMinor' : 'amount',
        constraint: hasAmountMinor
          ? EXPENSE_ACCEPTED_CONSTRAINTS.amountMinor
          : EXPENSE_ACCEPTED_CONSTRAINTS.amount,
      }
    );
  }
  return amountMinor;
}

function normalizeCategory(value) {
  if (typeof value !== 'string') {
    commandError(
      'INVALID_EXPENSE_CATEGORY',
      'Expense category is required.',
      400,
      { field: 'category', constraint: EXPENSE_ACCEPTED_CONSTRAINTS.category }
    );
  }
  const category = value.normalize('NFKC').trim();
  if (!CATEGORY_NAME_PATTERN.test(category)) {
    commandError(
      'INVALID_EXPENSE_CATEGORY',
      'Expense category is invalid.',
      422,
      { field: 'category', constraint: EXPENSE_ACCEPTED_CONSTRAINTS.category }
    );
  }
  return category;
}

function normalizeNote(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    commandError(
      'INVALID_EXPENSE_NOTE',
      'Expense note must be text.',
      400,
      { field: 'note', constraint: EXPENSE_ACCEPTED_CONSTRAINTS.note }
    );
  }
  const note = value.trim();
  if (note.length > EXPENSE_ACCEPTED_CONSTRAINTS.note.maxLength) {
    commandError(
      'INVALID_EXPENSE_NOTE',
      'Expense note must contain at most 120 characters.',
      422,
      { field: 'note', constraint: EXPENSE_ACCEPTED_CONSTRAINTS.note }
    );
  }
  return note || null;
}

function localDateForInstant(now, timeZone = TIME_ZONE) {
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

function currentMonthForInstant(now, timeZone = TIME_ZONE) {
  return localDateForInstant(now, timeZone).slice(0, 7);
}

function normalizeSpentOn(value, now) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    commandError(
      'INVALID_EXPENSE_DATE',
      'Pick a valid expense date in the accepted range.',
      400,
      { field: 'spentOn', constraint: EXPENSE_ACCEPTED_CONSTRAINTS.spentOn }
    );
  }
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  const isCalendarDate = parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
  const currentYear = Number(localDateForInstant(now).slice(0, 4));
  if (!isCalendarDate || year < currentYear - 10 || year > currentYear + 1) {
    commandError(
      'INVALID_EXPENSE_DATE',
      'Pick a valid expense date in the accepted range.',
      422,
      {
        field: 'spentOn',
        constraint: {
          ...EXPENSE_ACCEPTED_CONSTRAINTS.spentOn,
          minYear: currentYear - 10,
          maxYear: currentYear + 1,
        },
      }
    );
  }
  return value;
}

function normalizeTreatment(value) {
  if (typeof value !== 'string' || !TREATMENTS.includes(value)) {
    commandError(
      'INVALID_CATEGORY_TREATMENT',
      'Category treatment must be needs or wants.',
      422,
      { field: 'treatment', constraint: CATEGORY_TREATMENT_ACCEPTED_CONSTRAINTS.treatment }
    );
  }
  return value;
}

function normalizeExcludeFromDailyAllowance(value) {
  if (typeof value !== 'boolean') {
    commandError(
      'INVALID_EXPENSE_EXCLUSION',
      'excludeFromDailyAllowance must be a boolean.',
      400,
      {
        field: 'excludeFromDailyAllowance',
        constraint: EXPENSE_ACCEPTED_CONSTRAINTS.excludeFromDailyAllowance,
      }
    );
  }
  return value;
}

export function normalizeExpenseCreateCommand(body, now = new Date()) {
  const input = assertBody(body);
  const spentOn = input.spentOn === undefined
    ? localDateForInstant(now)
    : normalizeSpentOn(input.spentOn, now);
  const command = {
    amountMinor: normalizeAmountMinor(input),
    category: normalizeCategory(input.category),
    note: normalizeNote(input.note),
    spentOn,
    month: spentOn.slice(0, 7),
  };
  if (
    Object.hasOwn(input, 'excludeFromDailyAllowance')
    && normalizeExcludeFromDailyAllowance(input.excludeFromDailyAllowance)
  ) {
    command.excludeFromDailyAllowance = true;
  }
  return {
    command,
    expectedRecordVersion: normalizeExpectedRecordVersion(input),
  };
}

export function normalizeExpenseUpdateCommand(body, recordId, now = new Date()) {
  const input = assertBody(body);
  const patch = {};
  if (Object.hasOwn(input, 'amount') || Object.hasOwn(input, 'amountMinor')) {
    patch.amountMinor = normalizeAmountMinor(input);
  }
  if (Object.hasOwn(input, 'category')) patch.category = normalizeCategory(input.category);
  if (Object.hasOwn(input, 'note')) patch.note = normalizeNote(input.note);
  if (Object.hasOwn(input, 'spentOn')) {
    patch.spentOn = normalizeSpentOn(input.spentOn, now);
    patch.month = patch.spentOn.slice(0, 7);
  }
  if (Object.hasOwn(input, 'excludeFromDailyAllowance')) {
    patch.excludeFromDailyAllowance = normalizeExcludeFromDailyAllowance(
      input.excludeFromDailyAllowance
    );
  }
  if (Object.keys(patch).length === 0) {
    commandError(
      'EMPTY_EXPENSE_UPDATE',
      'At least one expense field must be updated.',
      400,
      { constraint: { minUpdatedFields: 1 } }
    );
  }
  return {
    command: { id: normalizeRecordId(recordId), patch },
    expectedRecordVersion: normalizeExpectedRecordVersion(input),
  };
}

export function normalizeExpenseDeleteCommand(body, recordId) {
  const input = assertBody(body ?? {});
  return {
    command: { id: normalizeRecordId(recordId) },
    expectedRecordVersion: normalizeExpectedRecordVersion(input),
  };
}

export function normalizeCategoryTreatmentSetCommand(body, category) {
  const input = assertBody(body);
  return {
    command: {
      category: normalizeCategory(category),
      treatment: normalizeTreatment(input.treatment),
    },
    expectedRecordVersion: normalizeExpectedRecordVersion(input),
  };
}

export function normalizeCategoryTreatmentDeleteCommand(body, category) {
  const input = assertBody(body ?? {});
  return {
    command: { category: normalizeCategory(category) },
    expectedRecordVersion: normalizeExpectedRecordVersion(input),
  };
}

function affectedExpenseOutcomes(month, currentMonth = null) {
  const outcomes = [
    { key: 'monthlyPlan', id: `monthly-plan:${month}`, kind: 'monthly_plan' },
    { key: 'spending', id: `spending:${month}`, kind: 'spending' },
  ];
  if (month === currentMonth) {
    outcomes.push({
      key: 'todayAllowance',
      id: `today-allowance:${month}`,
      kind: 'today_allowance',
    });
  }
  return outcomes;
}

async function expenseContext({ command, idempotencyKey, receipt, userId, now }, database) {
  let snapshotMonth = command.month ?? command.patch?.month;
  if (!snapshotMonth && command.id) {
    const row = await database.prepare(
      'SELECT month FROM expense_log WHERE id = ? AND user_id = ?'
    ).get(command.id, userId);
    snapshotMonth = row?.month;
  }
  snapshotMonth ??= currentMonthForInstant(now);
  const recordId = receipt?.recordId ?? command.id ?? null;
  return {
    snapshotMonth,
    scopeKey: recordId === null ? `new-expense:${idempotencyKey}` : `expense:${recordId}`,
    affectedOutcomes: affectedExpenseOutcomes(snapshotMonth, currentMonthForInstant(now)),
  };
}

function treatmentContext({ command, now }) {
  const snapshotMonth = currentMonthForInstant(now);
  return {
    snapshotMonth,
    scopeKey: `category-treatment:${encodeURIComponent(command.category.toLocaleLowerCase('en-IN'))}`,
    affectedOutcomes: affectedExpenseOutcomes(snapshotMonth),
  };
}

async function assertAllowedCategory(database, userId, category) {
  if (EXPENSE_CATEGORIES.includes(category)) return;
  const row = await database.prepare(
    'SELECT name FROM user_categories WHERE user_id = ? AND name = ?'
  ).get(userId, category);
  if (!row) {
    commandError(
      'UNKNOWN_EXPENSE_CATEGORY',
      'Unknown category — add it in Settings first.',
      422,
      { field: 'category', constraint: EXPENSE_ACCEPTED_CONSTRAINTS.category }
    );
  }
}

function toRowId(value, label) {
  const id = typeof value === 'bigint' ? Number(value) : value;
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return id;
}

export function expenseRecordFromRow(row) {
  if (!row) return null;
  return {
    id: toRowId(row.id, 'expense id'),
    month: row.month,
    category: row.category,
    amountMinor: legacyNumberToPaise(Number(row.amount), { label: 'expense amount' }),
    note: row.note ?? null,
    spentOn: row.spent_on,
    excludeFromDailyAllowance: row.exclude_from_daily_allowance === 1,
  };
}

export function categoryTreatmentRecordFromRow(row) {
  if (!row) return null;
  return {
    id: toRowId(row.id, 'category treatment id'),
    category: row.category,
    treatment: row.treatment,
  };
}

async function loadExpenseRow(database, userId, id) {
  return database.prepare(
    `SELECT id, month, category, amount, note, spent_on, exclude_from_daily_allowance
       FROM expense_log
      WHERE id = ? AND user_id = ?`
  ).get(id, userId);
}

async function loadExpensesForMonths(database, userId, months) {
  const uniqueMonths = [...new Set(months.filter(Boolean))];
  if (uniqueMonths.length === 0) return [];
  const placeholders = uniqueMonths.map(() => '?').join(', ');
  const rows = await database.prepare(
    `SELECT id, month, category, amount, note, spent_on, exclude_from_daily_allowance
       FROM expense_log
      WHERE user_id = ? AND month IN (${placeholders})
      ORDER BY id`
  ).all(userId, ...uniqueMonths);
  return rows.map(expenseRecordFromRow);
}

async function loadTreatmentRows(database, userId) {
  const rows = await database.prepare(
    `SELECT id, category, treatment
       FROM expense_category_treatments
      WHERE user_id = ?
      ORDER BY id`
  ).all(userId);
  return rows.map(categoryTreatmentRecordFromRow);
}

function transitionState({ month, expenses, categoryTreatments = [] }) {
  return createExpenseState({
    month,
    expenses,
    categoryTreatments,
    needsBudgetMinor: 0,
    wantsBudgetMinor: 0,
    salaryMinor: 0,
    activeBillsTotalMinor: 0,
  });
}

function nextSyntheticId(records, label) {
  const id = Math.max(0, ...records.map((record) => record.id)) + 1;
  if (!Number.isSafeInteger(id)) {
    commandError('RECORD_ID_EXHAUSTED', `${label} identifier is unavailable.`, 409);
  }
  return id;
}

function expenseTransitionResult(lastTransition) {
  const original = lastTransition.removedExpense;
  const resulting = lastTransition.insertedExpense;
  return {
    type: lastTransition.type,
    status: lastTransition.status,
    originalPeriod: original?.month ?? null,
    resultingPeriod: resulting?.month ?? null,
    originalCategory: original?.category ?? null,
    resultingCategory: resulting?.category ?? null,
    affectedPeriods: [...new Set(lastTransition.affectedPartitions.map(({ month }) => month))],
    affectedCategories: [...new Set(
      lastTransition.affectedPartitions.map(({ category }) => category)
    )],
    affectedPartitions: lastTransition.affectedPartitions.map((partition) => ({ ...partition })),
  };
}

function treatmentTransitionResult(state, category, lastTransition) {
  const originalEffective = resolveCategoryTreatment(category, state.categoryTreatments);
  const resultingEffective = resolveCategoryTreatment(category, lastTransition.type === 'set'
    ? [
        ...state.categoryTreatments.filter(
          (record) => record.category.toLocaleLowerCase('en-IN')
            !== category.toLocaleLowerCase('en-IN')
        ),
        lastTransition.resultingTreatment,
      ]
    : state.categoryTreatments.filter(
        (record) => record.category.toLocaleLowerCase('en-IN')
          !== category.toLocaleLowerCase('en-IN')
      ));
  return {
    type: lastTransition.type,
    status: lastTransition.status,
    category,
    originalTreatment: originalEffective.treatment,
    originalTreatmentSource: originalEffective.source,
    resultingTreatment: resultingEffective.treatment,
    resultingTreatmentSource: resultingEffective.source,
    affectedExpenseIds: [...lastTransition.affectedExpenseIds],
    needsSpentDeltaMinor: lastTransition.needsSpentDeltaMinor,
    wantsSpentDeltaMinor: lastTransition.wantsSpentDeltaMinor,
    totalSpendingDeltaMinor: lastTransition.totalSpendingDeltaMinor,
    projectedSavingsDeltaMinor: lastTransition.projectedSavingsDeltaMinor,
  };
}

export function createExpenseOperationHandlers({ database = db } = {}) {
  return {
    'expense.create': {
      getContext(input) {
        return expenseContext(input, database);
      },
      async prepare({ command, userId }) {
        await assertAllowedCategory(database, userId, command.category);
        const expenses = await loadExpensesForMonths(database, userId, [command.month]);
        const syntheticId = nextSyntheticId(expenses, 'Expense');
        const transition = applyExpenseTransition(
          transitionState({ month: command.month, expenses }),
          {
            type: 'create',
            expense: {
              id: syntheticId,
              month: command.month,
              category: command.category,
              amountMinor: command.amountMinor,
              note: command.note,
              spentOn: command.spentOn,
              excludeFromDailyAllowance: command.excludeFromDailyAllowance === true,
            },
          }
        );
        return {
          action: 'create',
          recordType: 'expense',
          recordId: null,
          sourceStatement: {
            sql: `INSERT INTO expense_log
              (user_id, month, category, amount, note, spent_on,
               exclude_from_daily_allowance, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
            args: [
              userId,
              command.month,
              command.category,
              command.amountMinor / 100,
              command.note,
              command.spentOn,
              Object.hasOwn(command, 'excludeFromDailyAllowance') ? 1 : null,
            ],
          },
          result: expenseTransitionResult(transition.lastTransition),
        };
      },
    },
    'expense.update': {
      getContext(input) {
        return expenseContext(input, database);
      },
      async prepare({ command, userId }) {
        const existingRow = await loadExpenseRow(database, userId, command.id);
        if (!existingRow) {
          return {
            action: 'update',
            recordType: 'expense',
            recordId: command.id,
            sourceStatement: {
              sql: 'UPDATE expense_log SET updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?',
              args: [command.id, userId],
            },
          };
        }
        const original = expenseRecordFromRow(existingRow);
        const resulting = {
          ...original,
          ...command.patch,
          id: original.id,
        };
        if (Object.hasOwn(command.patch, 'category')) {
          await assertAllowedCategory(database, userId, resulting.category);
        }
        const expenses = await loadExpensesForMonths(
          database,
          userId,
          [original.month, resulting.month]
        );
        const transitionType = original.month !== resulting.month
          || original.category !== resulting.category
          ? 'move'
          : 'update';
        const transition = applyExpenseTransition(
          transitionState({ month: resulting.month, expenses }),
          { type: transitionType, expenseId: original.id, expense: resulting }
        );
        const assignments = [];
        const args = [];
        const fields = [
          ['amountMinor', 'amount', (value) => value / 100],
          ['category', 'category', (value) => value],
          ['note', 'note', (value) => value],
          ['spentOn', 'spent_on', (value) => value],
          ['month', 'month', (value) => value],
          [
            'excludeFromDailyAllowance',
            'exclude_from_daily_allowance',
            (value) => value ? 1 : null,
          ],
        ];
        for (const [field, column, convert] of fields) {
          if (!Object.hasOwn(command.patch, field)) continue;
          assignments.push(`${column} = ?`);
          args.push(convert(command.patch[field]));
        }
        assignments.push('updated_at = CURRENT_TIMESTAMP');
        args.push(command.id, userId);
        return {
          action: 'update',
          recordType: 'expense',
          recordId: command.id,
          sourceStatement: {
            sql: `UPDATE expense_log SET ${assignments.join(', ')} WHERE id = ? AND user_id = ?`,
            args,
          },
          result: expenseTransitionResult(transition.lastTransition),
        };
      },
    },
    'expense.delete': {
      getContext(input) {
        return expenseContext(input, database);
      },
      async prepare({ command, userId }) {
        const existingRow = await loadExpenseRow(database, userId, command.id);
        let result;
        if (existingRow) {
          const original = expenseRecordFromRow(existingRow);
          const expenses = await loadExpensesForMonths(database, userId, [original.month]);
          const transition = applyExpenseTransition(
            transitionState({ month: original.month, expenses }),
            { type: 'delete', expenseId: original.id }
          );
          result = expenseTransitionResult(transition.lastTransition);
        }
        return {
          action: 'delete',
          recordType: 'expense',
          recordId: command.id,
          sourceStatement: {
            sql: 'DELETE FROM expense_log WHERE id = ? AND user_id = ?',
            args: [command.id, userId],
          },
          ...(result === undefined ? {} : { result }),
        };
      },
    },
    'category_treatment.set': {
      getContext: treatmentContext,
      async prepare({ command, userId, context }) {
        await assertAllowedCategory(database, userId, command.category);
        const existingRow = await database.prepare(
          `SELECT id, category, treatment
             FROM expense_category_treatments
            WHERE user_id = ? AND category = ?`
        ).get(userId, command.category);
        const treatmentRows = await loadTreatmentRows(database, userId);
        const expenses = await loadExpensesForMonths(database, userId, [context.snapshotMonth]);
        const syntheticId = existingRow
          ? toRowId(existingRow.id, 'category treatment id')
          : nextSyntheticId(treatmentRows, 'Category treatment');
        const state = transitionState({
          month: context.snapshotMonth,
          expenses,
          categoryTreatments: treatmentRows,
        });
        const transition = applyCategoryTreatmentTransition(state, {
          type: 'set',
          treatment: {
            id: syntheticId,
            category: command.category,
            treatment: command.treatment,
          },
        });
        const result = treatmentTransitionResult(
          state,
          command.category,
          transition.lastTreatmentTransition
        );
        if (existingRow) {
          return {
            action: 'update',
            recordType: 'category_treatment',
            recordId: syntheticId,
            sourceStatement: {
              sql: `UPDATE expense_category_treatments
                       SET treatment = ?, updated_at = CURRENT_TIMESTAMP
                     WHERE id = ? AND user_id = ?`,
              args: [command.treatment, syntheticId, userId],
            },
            result,
          };
        }
        return {
          action: 'create',
          recordType: 'category_treatment',
          recordId: null,
          sourceStatement: {
            sql: `INSERT INTO expense_category_treatments
              (user_id, category, treatment, updated_at)
              VALUES (?, ?, ?, CURRENT_TIMESTAMP)`,
            args: [userId, command.category, command.treatment],
          },
          result,
        };
      },
    },
    'category_treatment.remove': {
      getContext: treatmentContext,
      async prepare({ command, userId, context }) {
        await assertAllowedCategory(database, userId, command.category);
        const existingRow = await database.prepare(
          `SELECT id, category, treatment
             FROM expense_category_treatments
            WHERE user_id = ? AND category = ?`
        ).get(userId, command.category);
        if (!existingRow) {
          commandError(
            'CATEGORY_TREATMENT_NOT_FOUND',
            'No category treatment override exists.',
            404,
            { field: 'category' }
          );
        }
        const treatmentRows = await loadTreatmentRows(database, userId);
        const expenses = await loadExpensesForMonths(database, userId, [context.snapshotMonth]);
        const state = transitionState({
          month: context.snapshotMonth,
          expenses,
          categoryTreatments: treatmentRows,
        });
        const transition = applyCategoryTreatmentTransition(state, {
          type: 'remove',
          category: command.category,
        });
        return {
          action: 'delete',
          recordType: 'category_treatment',
          recordId: toRowId(existingRow.id, 'category treatment id'),
          sourceStatement: {
            sql: 'DELETE FROM expense_category_treatments WHERE id = ? AND user_id = ?',
            args: [existingRow.id, userId],
          },
          result: treatmentTransitionResult(
            state,
            command.category,
            transition.lastTreatmentTransition
          ),
        };
      },
    },
  };
}

export function createExpenseMutationService({
  database = db,
  snapshotService = clarityService,
  ...serviceOptions
} = {}) {
  return new FinancialMutationService({
    database,
    snapshotService,
    operationHandlers: createExpenseOperationHandlers({ database }),
    ...serviceOptions,
  });
}

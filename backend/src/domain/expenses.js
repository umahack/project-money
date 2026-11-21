import { assertSafePaise, sumPaise } from './money.js';

export const DEFAULT_NEEDS_CATEGORIES = Object.freeze([
  'Food',
  'Groceries',
  'Transport',
  'Bills',
  'Health',
]);

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const TREATMENTS = new Set(['needs', 'wants']);
const DEFAULT_NEEDS_CATEGORY_KEYS = new Set(
  DEFAULT_NEEDS_CATEGORIES.map((category) => normalizeCategoryKey(category))
);

function assertPlainRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a record.`);
  }
  return value;
}

function assertRecordId(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

function assertMonth(value, label = 'month') {
  if (typeof value !== 'string' || !MONTH_PATTERN.test(value)) {
    throw new TypeError(`${label} must use YYYY-MM format.`);
  }
  return value;
}

function assertCategory(value, label = 'category') {
  if (typeof value !== 'string' || value.normalize('NFKC').trim().length === 0) {
    throw new TypeError(`${label} must be a nonblank string.`);
  }
  return value;
}

export function normalizeCategoryKey(category) {
  return assertCategory(category).normalize('NFKC').trim().toLocaleLowerCase('en-IN');
}

function normalizeExpense(expense, label) {
  assertPlainRecord(expense, label);
  assertRecordId(expense.id, `${label}.id`);
  assertMonth(expense.month, `${label}.month`);
  assertCategory(expense.category, `${label}.category`);
  assertSafePaise(expense.amountMinor, {
    allowNegative: false,
    label: `${label}.amountMinor`,
  });
  return { ...expense };
}

function normalizeExpenses(expenses) {
  if (!Array.isArray(expenses)) throw new TypeError('expenses must be an array.');

  const seenIds = new Set();
  const normalized = expenses.map((expense, index) => {
    const record = normalizeExpense(expense, `expenses[${index}]`);
    if (seenIds.has(record.id)) {
      throw new RangeError('expenses must not contain duplicate record IDs.');
    }
    seenIds.add(record.id);
    return record;
  });
  return normalized.toSorted((left, right) => left.id - right.id);
}

function normalizeTreatmentRecord(record, label) {
  assertPlainRecord(record, label);
  assertRecordId(record.id, `${label}.id`);
  assertCategory(record.category, `${label}.category`);
  if (!TREATMENTS.has(record.treatment)) {
    throw new TypeError(`${label}.treatment must be needs or wants.`);
  }
  return { ...record };
}

function normalizeCategoryTreatments(categoryTreatments) {
  if (!Array.isArray(categoryTreatments)) {
    throw new TypeError('categoryTreatments must be an array.');
  }

  const seenIds = new Set();
  const seenCategories = new Set();
  const normalized = categoryTreatments.map((record, index) => {
    const treatment = normalizeTreatmentRecord(record, `categoryTreatments[${index}]`);
    const key = normalizeCategoryKey(treatment.category);
    if (seenIds.has(treatment.id)) {
      throw new RangeError('categoryTreatments must not contain duplicate record IDs.');
    }
    if (seenCategories.has(key)) {
      throw new RangeError('categoryTreatments must not contain duplicate categories.');
    }
    seenIds.add(treatment.id);
    seenCategories.add(key);
    return treatment;
  });

  return normalized.toSorted((left, right) => left.id - right.id);
}

/** Build a case-insensitive lookup of confirmed user category overrides. */
export function buildCategoryTreatmentMap(categoryTreatments = []) {
  return new Map(
    normalizeCategoryTreatments(categoryTreatments).map((record) => [
      normalizeCategoryKey(record.category),
      record,
    ])
  );
}

/** Resolve a category through a user override first and the canonical defaults second. */
export function resolveCategoryTreatment(category, categoryTreatments = []) {
  const key = normalizeCategoryKey(category);
  const treatmentMap = categoryTreatments instanceof Map
    ? categoryTreatments
    : buildCategoryTreatmentMap(categoryTreatments);
  const override = treatmentMap.get(key);
  if (override) {
    return { treatment: override.treatment, source: 'override', record: { ...override } };
  }
  return {
    treatment: DEFAULT_NEEDS_CATEGORY_KEYS.has(key) ? 'needs' : 'wants',
    source: 'default',
    record: null,
  };
}

function compareCategories(left, right) {
  const leftKey = normalizeCategoryKey(left);
  const rightKey = normalizeCategoryKey(right);
  if (leftKey < rightKey) return -1;
  if (leftKey > rightKey) return 1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function calculateCategoryTotalsFromNormalized(expenses, month) {
  const totals = new Map();
  for (const expense of expenses) {
    if (expense.month !== month) continue;
    const current = totals.get(expense.category) ?? {
      month,
      category: expense.category,
      totalMinor: 0,
      expenseIds: [],
    };
    current.totalMinor = sumPaise([current.totalMinor, expense.amountMinor], {
      allowNegative: false,
      label: `${month} ${expense.category} expenses`,
    });
    current.expenseIds.push(expense.id);
    totals.set(expense.category, current);
  }

  return [...totals.values()]
    .map((total) => ({ ...total, expenseIds: [...total.expenseIds].toSorted((a, b) => a - b) }))
    .toSorted((left, right) => compareCategories(left.category, right.category));
}

/** Sum each confirmed expense in an exact month/category partition once. */
export function calculateCategoryTotals(expenses, month) {
  const applicableMonth = assertMonth(month);
  return calculateCategoryTotalsFromNormalized(normalizeExpenses(expenses), applicableMonth);
}

function subtractPaise(left, right, label) {
  return sumPaise([left, -right], { label });
}

function createExceededBucketAction(bucket, budgetMinor, spentMinor) {
  if (spentMinor <= budgetMinor) return null;
  const title = bucket === 'needs' ? 'Needs' : 'Wants';
  return {
    conditionCode: `${bucket}_budget_exceeded`,
    bucket,
    budgetMinor,
    spentMinor,
    excessMinor: subtractPaise(spentMinor, budgetMinor, `${bucket} budget excess`),
    actionKey: `address_${bucket}_budget_excess`,
    actionLabel: `Review ${title} spending`,
    correctiveAction: `Reduce ${title} spending or reclassify an incorrectly treated expense.`,
  };
}

function normalizeSummaryInput({
  month,
  expenses = [],
  categoryTreatments = [],
  needsBudgetMinor = 0,
  wantsBudgetMinor = 0,
  salaryMinor = 0,
  activeBillsTotalMinor = 0,
}) {
  const normalizedMonth = assertMonth(month);
  const normalizedExpenses = normalizeExpenses(expenses);
  const normalizedTreatments = normalizeCategoryTreatments(categoryTreatments);
  assertSafePaise(needsBudgetMinor, { allowNegative: false, label: 'needsBudgetMinor' });
  assertSafePaise(wantsBudgetMinor, { allowNegative: false, label: 'wantsBudgetMinor' });
  assertSafePaise(salaryMinor, { allowNegative: false, label: 'salaryMinor' });
  assertSafePaise(activeBillsTotalMinor, {
    allowNegative: false,
    label: 'activeBillsTotalMinor',
  });

  return {
    month: normalizedMonth,
    expenses: normalizedExpenses,
    categoryTreatments: normalizedTreatments,
    needsBudgetMinor,
    wantsBudgetMinor,
    salaryMinor,
    activeBillsTotalMinor,
  };
}

function calculateExpenseSummaryFromNormalized(input) {
  const treatmentMap = buildCategoryTreatmentMap(input.categoryTreatments);
  const applicableExpenses = input.expenses
    .filter((expense) => expense.month === input.month)
    .map((expense) => ({
      ...expense,
      appliedTreatment: resolveCategoryTreatment(expense.category, treatmentMap),
    }));
  const needsExpenses = applicableExpenses.filter(
    (expense) => expense.appliedTreatment.treatment === 'needs'
  );
  const wantsExpenses = applicableExpenses.filter(
    (expense) => expense.appliedTreatment.treatment === 'wants'
  );
  const needsSpentMinor = sumPaise(
    needsExpenses.map((expense) => expense.amountMinor),
    { allowNegative: false, label: 'needs expenses' }
  );
  const wantsSpentMinor = sumPaise(
    wantsExpenses.map((expense) => expense.amountMinor),
    { allowNegative: false, label: 'wants expenses' }
  );
  const totalSpendingMinor = sumPaise(
    applicableExpenses.map((expense) => expense.amountMinor),
    { allowNegative: false, label: 'applicable expenses' }
  );
  const spendableBudgetMinor = sumPaise(
    [input.needsBudgetMinor, input.wantsBudgetMinor],
    { allowNegative: false, label: 'spendable budget' }
  );
  const remainingSpendableMinor = subtractPaise(
    spendableBudgetMinor,
    totalSpendingMinor,
    'remaining spendable'
  );
  const projectedSavingsDifferenceMinor = sumPaise(
    [input.salaryMinor, -input.activeBillsTotalMinor, -totalSpendingMinor],
    { label: 'projected savings difference' }
  );
  const projectedSavingsMinor = Math.max(0, projectedSavingsDifferenceMinor);
  const exceededBucketActions = [
    createExceededBucketAction('needs', input.needsBudgetMinor, needsSpentMinor),
    createExceededBucketAction('wants', input.wantsBudgetMinor, wantsSpentMinor),
  ].filter(Boolean);

  return {
    month: input.month,
    categoryTotals: calculateCategoryTotalsFromNormalized(input.expenses, input.month),
    appliedTreatments: applicableExpenses.map((expense) => ({
      expenseId: expense.id,
      category: expense.category,
      treatment: expense.appliedTreatment.treatment,
      source: expense.appliedTreatment.source,
      ...(expense.appliedTreatment.record
        ? { treatmentRecordId: expense.appliedTreatment.record.id }
        : {}),
    })),
    applicableExpenseIds: applicableExpenses.map((expense) => expense.id),
    needsSpentMinor,
    wantsSpentMinor,
    totalSpendingMinor,
    spendableBudgetMinor,
    remainingSpendableMinor,
    projectedSavingsMinor,
    exceededBucketActions,
  };
}

/** Calculate exact spending outcomes for one month from confirmed records. */
export function calculateExpenseSummary(input) {
  return calculateExpenseSummaryFromNormalized(normalizeSummaryInput(input));
}

/** Create an immutable transition state with a freshly calculated monthly summary. */
export function createExpenseState(input) {
  const normalized = normalizeSummaryInput(input);
  return {
    ...normalized,
    summary: calculateExpenseSummaryFromNormalized(normalized),
  };
}

function partitionTotal(expenses, { month, category }) {
  return sumPaise(
    expenses
      .filter((expense) => expense.month === month && expense.category === category)
      .map((expense) => expense.amountMinor),
    { allowNegative: false, label: `${month} ${category} partition` }
  );
}

function uniquePartitions(expenses) {
  const byMonth = new Map();
  const result = [];
  for (const expense of expenses.filter(Boolean)) {
    let categories = byMonth.get(expense.month);
    if (!categories) {
      categories = new Set();
      byMonth.set(expense.month, categories);
    }
    if (categories.has(expense.category)) continue;
    categories.add(expense.category);
    result.push({ month: expense.month, category: expense.category });
  }
  return result;
}

function rebuildState(state, expenses, categoryTreatments = state.categoryTreatments) {
  return createExpenseState({
    month: state.month,
    expenses,
    categoryTreatments,
    needsBudgetMinor: state.needsBudgetMinor,
    wantsBudgetMinor: state.wantsBudgetMinor,
    salaryMinor: state.salaryMinor,
    activeBillsTotalMinor: state.activeBillsTotalMinor,
  });
}

/**
 * Apply a confirmed create, update/move, or delete without mutating the prior state.
 * Updates always remove the original ID before inserting the confirmed result.
 */
export function applyExpenseTransition(state, transition) {
  const preceding = createExpenseState(assertPlainRecord(state, 'state'));
  assertPlainRecord(transition, 'transition');
  if (!['create', 'update', 'move', 'delete'].includes(transition.type)) {
    throw new TypeError('transition.type must be create, update, move, or delete.');
  }

  let removedExpense = null;
  let insertedExpense = null;
  let resultingExpenses;
  let status = 'confirmed';

  if (transition.type === 'create') {
    insertedExpense = normalizeExpense(transition.expense, 'transition.expense');
    if (preceding.expenses.some((expense) => expense.id === insertedExpense.id)) {
      throw new RangeError(`expense ${insertedExpense.id} already exists.`);
    }
    resultingExpenses = [...preceding.expenses, insertedExpense];
  } else if (transition.type === 'update' || transition.type === 'move') {
    insertedExpense = normalizeExpense(transition.expense, 'transition.expense');
    const expenseId = transition.expenseId ?? insertedExpense.id;
    assertRecordId(expenseId, 'transition.expenseId');
    if (insertedExpense.id !== expenseId) {
      throw new RangeError('the confirmed result must retain the original expense ID.');
    }
    removedExpense = preceding.expenses.find((expense) => expense.id === expenseId) ?? null;
    if (!removedExpense) throw new RangeError(`expense ${expenseId} does not exist.`);

    const withoutOriginal = preceding.expenses.filter((expense) => expense.id !== expenseId);
    resultingExpenses = [...withoutOriginal, insertedExpense];
  } else {
    const expenseId = assertRecordId(transition.expenseId, 'transition.expenseId');
    removedExpense = preceding.expenses.find((expense) => expense.id === expenseId) ?? null;
    if (!removedExpense) {
      resultingExpenses = preceding.expenses;
      status = 'unchanged';
    } else {
      resultingExpenses = preceding.expenses.filter((expense) => expense.id !== expenseId);
    }
  }

  const result = rebuildState(preceding, resultingExpenses);
  const affectedPartitions = uniquePartitions([removedExpense, insertedExpense]).map((partition) => ({
    ...partition,
    precedingTotalMinor: partitionTotal(preceding.expenses, partition),
    resultingTotalMinor: partitionTotal(result.expenses, partition),
  }));

  return {
    ...result,
    lastTransition: {
      type: transition.type,
      status,
      expenseId: insertedExpense?.id ?? removedExpense?.id ?? transition.expenseId,
      removedExpense: removedExpense ? { ...removedExpense } : null,
      insertedExpense: insertedExpense ? { ...insertedExpense } : null,
      affectedPartitions,
    },
  };
}

/** Apply or remove one confirmed user category override and recalculate current outcomes. */
export function applyCategoryTreatmentTransition(state, transition) {
  const preceding = createExpenseState(assertPlainRecord(state, 'state'));
  assertPlainRecord(transition, 'transition');
  if (!['set', 'remove'].includes(transition.type)) {
    throw new TypeError('transition.type must be set or remove.');
  }

  let category;
  let categoryTreatments;
  let precedingTreatment = null;
  let resultingTreatment = null;
  let status = 'confirmed';

  if (transition.type === 'set') {
    resultingTreatment = normalizeTreatmentRecord(
      transition.treatment,
      'transition.treatment'
    );
    category = resultingTreatment.category;
    const key = normalizeCategoryKey(category);
    precedingTreatment = preceding.categoryTreatments.find(
      (record) => normalizeCategoryKey(record.category) === key
    ) ?? null;
    categoryTreatments = [
      ...preceding.categoryTreatments.filter(
        (record) => normalizeCategoryKey(record.category) !== key
      ),
      resultingTreatment,
    ];
  } else {
    category = assertCategory(transition.category, 'transition.category');
    const key = normalizeCategoryKey(category);
    precedingTreatment = preceding.categoryTreatments.find(
      (record) => normalizeCategoryKey(record.category) === key
    ) ?? null;
    categoryTreatments = preceding.categoryTreatments.filter(
      (record) => normalizeCategoryKey(record.category) !== key
    );
    if (!precedingTreatment) status = 'unchanged';
  }

  const result = rebuildState(preceding, preceding.expenses, categoryTreatments);
  const categoryKey = normalizeCategoryKey(category);
  return {
    ...result,
    lastTreatmentTransition: {
      type: transition.type,
      status,
      category,
      precedingTreatment: precedingTreatment ? { ...precedingTreatment } : null,
      resultingTreatment: resultingTreatment ? { ...resultingTreatment } : null,
      affectedExpenseIds: preceding.expenses
        .filter(
          (expense) => expense.month === preceding.month
            && normalizeCategoryKey(expense.category) === categoryKey
        )
        .map((expense) => expense.id),
      needsSpentDeltaMinor: subtractPaise(
        result.summary.needsSpentMinor,
        preceding.summary.needsSpentMinor,
        'needs spending delta'
      ),
      wantsSpentDeltaMinor: subtractPaise(
        result.summary.wantsSpentMinor,
        preceding.summary.wantsSpentMinor,
        'wants spending delta'
      ),
      totalSpendingDeltaMinor: subtractPaise(
        result.summary.totalSpendingMinor,
        preceding.summary.totalSpendingMinor,
        'total spending delta'
      ),
      projectedSavingsDeltaMinor: subtractPaise(
        result.summary.projectedSavingsMinor,
        preceding.summary.projectedSavingsMinor,
        'projected savings delta'
      ),
    },
  };
}

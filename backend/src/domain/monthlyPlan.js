import {
  assertSafePaise,
  createRoundingMetadata,
  divideHalfUp,
  divideHalfUpWithMetadata,
  sumPaise,
} from './money.js';
import {
  buildCategoryTreatmentMap,
  normalizeCategoryKey,
  resolveCategoryTreatment,
} from './expenses.js';

export { DEFAULT_NEEDS_CATEGORIES } from './expenses.js';

export const FINANCIAL_CLARITY_TIME_ZONE = 'Asia/Kolkata';

export const MONTHLY_PLAN_CALCULATION_ORDER = Object.freeze([
  'salary',
  'active_bills',
  'disposable_income',
  'allocation',
  'expenses',
  'daily_guide',
]);

const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;
const LOCAL_DATE_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function assertMonth(value, label) {
  if (typeof value !== 'string' || !MONTH_PATTERN.test(value)) {
    throw new TypeError(`${label} must use YYYY-MM format.`);
  }
  return value;
}

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year, monthNumber) {
  if (monthNumber === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(monthNumber) ? 30 : 31;
}

function assertLocalDate(value, month) {
  const match = typeof value === 'string' ? LOCAL_DATE_PATTERN.exec(value) : null;
  if (!match) throw new TypeError('localDate must use valid YYYY-MM-DD format.');

  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  const day = Number(match[3]);
  if (day > daysInMonth(year, monthNumber)) {
    throw new TypeError('localDate must be a valid calendar date.');
  }
  if (value.slice(0, 7) !== month) {
    throw new RangeError('localDate must fall within the calculated month.');
  }
  return { value, year, monthNumber, day };
}

function assertTimeZone(timeZone) {
  if (timeZone !== FINANCIAL_CLARITY_TIME_ZONE) {
    throw new RangeError(`timeZone must be ${FINANCIAL_CLARITY_TIME_ZONE}.`);
  }
  return timeZone;
}

function assertRecordId(id, label) {
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return id;
}

function assertRecordArray(records, label) {
  if (!Array.isArray(records)) throw new TypeError(`${label} must be an array.`);

  const seenIds = new Set();
  records.forEach((record, index) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new TypeError(`${label}[${index}] must be a record.`);
    }
    const id = assertRecordId(record.id, `${label}[${index}].id`);
    if (seenIds.has(id)) throw new RangeError(`${label} must not contain duplicate record IDs.`);
    seenIds.add(id);
  });
  return records;
}

function assertCategory(category, label) {
  if (typeof category !== 'string' || normalizeCategoryKey(category).length === 0) {
    throw new TypeError(`${label} must be a nonblank string.`);
  }
  return category;
}

function nextMonth(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  if (year === 9999 && monthNumber === 12) {
    throw new RangeError('month must have a representable following month.');
  }
  const nextYear = monthNumber === 12 ? year + 1 : year;
  const nextMonthNumber = monthNumber === 12 ? 1 : monthNumber + 1;
  return `${String(nextYear).padStart(4, '0')}-${String(nextMonthNumber).padStart(2, '0')}`;
}

function money(amountMinor) {
  return { currency: 'INR', amountMinor };
}

function sourceTimestamp(record) {
  return record.confirmedAt ?? record.updatedAt ?? record.createdAt;
}

function sourceRef({ order, sourceType, record, field, label, value, period }) {
  const confirmedAt = sourceTimestamp(record);
  return {
    order,
    ref: `${sourceType}:${record.id}:${field}`,
    sourceType,
    recordId: record.id,
    field,
    label,
    value,
    ...(confirmedAt === undefined ? {} : { confirmedAt }),
    ...(period === undefined ? {} : { period }),
  };
}

function multiplyRatioHalfUp(amountMinor, numerator, denominator) {
  assertSafePaise(amountMinor, { allowNegative: false, label: 'ratio amountMinor' });
  if (!Number.isSafeInteger(numerator) || numerator < 0) {
    throw new RangeError('ratio numerator must be a non-negative safe integer.');
  }
  if (!Number.isSafeInteger(denominator) || denominator <= 0 || numerator > denominator) {
    throw new RangeError('ratio denominator must be positive and at least the numerator.');
  }

  // Decompose before multiplication so a safe amount remains safe even near
  // Number.MAX_SAFE_INTEGER. divideHalfUp supplies the canonical tie rule.
  const whole = Math.floor(amountMinor / denominator);
  const remainder = amountMinor % denominator;
  const wholeResult = whole * numerator;
  const fractionalNumerator = remainder * numerator;
  const amount = sumPaise([
    assertSafePaise(wholeResult, { allowNegative: false, label: 'ratio whole result' }),
    divideHalfUp(fractionalNumerator, denominator),
  ], { allowNegative: false, label: 'ratio result' });
  const exact = fractionalNumerator % denominator === 0;

  return {
    amountMinor: amount,
    rounding: createRoundingMetadata({ direction: exact ? 'exact' : 'half_up' }),
  };
}

function normalizeSalaryEntries(salaryEntries, month) {
  assertRecordArray(salaryEntries, 'salaryEntries');
  const matching = salaryEntries.filter((entry, index) => {
    assertMonth(entry.month, `salaryEntries[${index}].month`);
    return entry.month === month;
  });
  if (matching.length !== 1) {
    throw new RangeError(`salaryEntries must contain exactly one confirmed salary for ${month}.`);
  }

  const salary = matching[0];
  assertSafePaise(salary.amountMinor, {
    allowNegative: false,
    label: `salaryEntries record ${salary.id} amountMinor`,
  });
  return salary;
}

function billIsActiveForMonth(bill, index, month) {
  const active = bill.active ?? true;
  if (![true, false, 0, 1].includes(active)) {
    throw new TypeError(`bills[${index}].active must be a boolean or 0/1.`);
  }

  const effectiveFromMonth = bill.effectiveFromMonth ?? null;
  const effectiveToMonth = bill.effectiveToMonth ?? null;
  if (effectiveFromMonth !== null) {
    assertMonth(effectiveFromMonth, `bills[${index}].effectiveFromMonth`);
  }
  if (effectiveToMonth !== null) {
    assertMonth(effectiveToMonth, `bills[${index}].effectiveToMonth`);
  }
  if (
    effectiveFromMonth !== null
    && effectiveToMonth !== null
    && effectiveFromMonth > effectiveToMonth
  ) {
    throw new RangeError(`bills[${index}] effective month range is invalid.`);
  }

  return Boolean(active)
    && (effectiveFromMonth === null || effectiveFromMonth <= month)
    && (effectiveToMonth === null || effectiveToMonth >= month);
}

function normalizeActiveBills(bills, month) {
  assertRecordArray(bills, 'bills');
  return bills
    .filter((bill, index) => billIsActiveForMonth(bill, index, month))
    .map((bill) => {
      assertSafePaise(bill.amountMinor, {
        allowNegative: false,
        label: `bill record ${bill.id} amountMinor`,
      });
      return bill;
    })
    .sort((left, right) => left.id - right.id);
}

function normalizeApplicableExpenses(expenses, month, treatmentMap) {
  assertRecordArray(expenses, 'expenses');
  return expenses
    .filter((expense, index) => {
      assertMonth(expense.month, `expenses[${index}].month`);
      return expense.month === month;
    })
    .map((expense) => {
      const category = assertCategory(expense.category, `expense record ${expense.id} category`);
      assertSafePaise(expense.amountMinor, {
        allowNegative: false,
        label: `expense record ${expense.id} amountMinor`,
      });
      return {
        ...expense,
        appliedTreatment: resolveCategoryTreatment(category, treatmentMap),
      };
    })
    .sort((left, right) => left.id - right.id);
}

function subtractPaise(left, right, label) {
  return sumPaise([left, -right], { label });
}

function calculateAllocation(disposableIncomeMinor) {
  const needs = multiplyRatioHalfUp(disposableIncomeMinor, 1, 2);
  const wants = multiplyRatioHalfUp(disposableIncomeMinor, 3, 10);
  const independentlyRoundedSavings = multiplyRatioHalfUp(disposableIncomeMinor, 1, 5);
  const savingsTargetMinor = subtractPaise(
    subtractPaise(disposableIncomeMinor, needs.amountMinor, 'allocation after needs'),
    wants.amountMinor,
    'allocation after wants'
  );
  const savingsAdjustmentMinor = subtractPaise(
    savingsTargetMinor,
    independentlyRoundedSavings.amountMinor,
    'savings remainder adjustment'
  );

  return {
    needsBudgetMinor: needs.amountMinor,
    wantsBudgetMinor: wants.amountMinor,
    savingsTargetMinor,
    rounding: {
      needsBudget: needs.rounding,
      wantsBudget: wants.rounding,
      savingsTarget: createRoundingMetadata({
        direction:
          independentlyRoundedSavings.rounding.direction === 'exact'
          && savingsAdjustmentMinor === 0
            ? 'exact'
            : 'half_up',
        adjustmentMinor: savingsAdjustmentMinor,
        adjustmentTarget: 'savingsTarget',
      }),
    },
  };
}

function calculateProjectedSavings(salaryMinor, activeBillsTotalMinor, expensesTotalMinor) {
  if (activeBillsTotalMinor >= salaryMinor) return 0;
  const afterBills = salaryMinor - activeBillsTotalMinor;
  return expensesTotalMinor >= afterBills ? 0 : afterBills - expensesTotalMinor;
}

/**
 * Calculate one current-month plan from canonical integer-paise records.
 * The caller supplies the local calendar date and fixed product time zone; this
 * module never reads the process clock or machine time zone.
 */
export function calculateMonthlyPlan({
  month,
  localDate,
  timeZone,
  salaryEntries,
  bills = [],
  expenses = [],
  categoryTreatments = [],
}) {
  const applicableMonth = assertMonth(month, 'month');
  const validatedTimeZone = assertTimeZone(timeZone);
  const date = assertLocalDate(localDate, applicableMonth);
  const salary = normalizeSalaryEntries(salaryEntries, applicableMonth);
  const activeBills = normalizeActiveBills(bills, applicableMonth);
  const treatmentMap = buildCategoryTreatmentMap(categoryTreatments);
  const applicableExpenses = normalizeApplicableExpenses(
    expenses,
    applicableMonth,
    treatmentMap
  );

  const salaryMinor = salary.amountMinor;
  const activeBillsTotalMinor = sumPaise(
    activeBills.map((bill) => bill.amountMinor),
    { allowNegative: false, label: 'active bill amounts' }
  );
  const disposableDifferenceMinor = subtractPaise(
    salaryMinor,
    activeBillsTotalMinor,
    'salary less active bills'
  );
  const disposableIncomeMinor = Math.max(0, disposableDifferenceMinor);
  const shortfallMinor = Math.max(0, -disposableDifferenceMinor);
  const allocation = calculateAllocation(disposableIncomeMinor);
  const spendableBudgetMinor = sumPaise([
    allocation.needsBudgetMinor,
    allocation.wantsBudgetMinor,
  ], { allowNegative: false, label: 'spendable budget' });

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
  const applicableExpensesTotalMinor = sumPaise([
    needsSpentMinor,
    wantsSpentMinor,
  ], { allowNegative: false, label: 'applicable expenses' });
  const remainingSpendableMinor = subtractPaise(
    spendableBudgetMinor,
    applicableExpensesTotalMinor,
    'remaining spendable'
  );
  const daysRemainingInclusive = daysInMonth(date.year, date.monthNumber) - date.day + 1;
  const dailyGuide = divideHalfUpWithMetadata(
    remainingSpendableMinor,
    daysRemainingInclusive
  );
  const projectedSavingsMinor = calculateProjectedSavings(
    salaryMinor,
    activeBillsTotalMinor,
    applicableExpensesTotalMinor
  );

  const sourceRefs = [];
  sourceRefs.push(sourceRef({
    order: sourceRefs.length + 1,
    sourceType: 'salary',
    record: salary,
    field: 'amountMinor',
    label: `Salary for ${applicableMonth}`,
    value: money(salaryMinor),
    period: { month: applicableMonth },
  }));
  for (const bill of activeBills) {
    sourceRefs.push(sourceRef({
      order: sourceRefs.length + 1,
      sourceType: 'bill',
      record: bill,
      field: 'amountMinor',
      label: bill.label || `Bill ${bill.id}`,
      value: money(bill.amountMinor),
      period: {
        month: applicableMonth,
        effectiveFromMonth: bill.effectiveFromMonth ?? null,
        effectiveToMonth: bill.effectiveToMonth ?? null,
      },
    }));
  }
  for (const expense of applicableExpenses) {
    sourceRefs.push(sourceRef({
      order: sourceRefs.length + 1,
      sourceType: 'expense',
      record: expense,
      field: 'amountMinor',
      label: `Expense ${expense.id}`,
      value: money(expense.amountMinor),
      period: { month: applicableMonth },
    }));
  }
  const usedTreatmentOverrides = [...new Map(
    applicableExpenses
      .filter((expense) => expense.appliedTreatment.record)
      .map((expense) => [
        expense.appliedTreatment.record.id,
        expense.appliedTreatment.record,
      ])
  ).values()].sort((left, right) => left.id - right.id);
  for (const treatment of usedTreatmentOverrides) {
    sourceRefs.push(sourceRef({
      order: sourceRefs.length + 1,
      sourceType: 'category_treatment',
      record: treatment,
      field: 'treatment',
      label: `${treatment.category} category treatment`,
      value: treatment.treatment,
      period: { month: applicableMonth },
    }));
  }

  const salaryRef = sourceRefs.find((source) => source.sourceType === 'salary').ref;
  const billRefs = sourceRefs
    .filter((source) => source.sourceType === 'bill')
    .map((source) => source.ref);
  const expenseRefs = sourceRefs
    .filter((source) => source.sourceType === 'expense')
    .map((source) => source.ref);
  const operations = [
    {
      order: 1,
      stage: MONTHLY_PLAN_CALCULATION_ORDER[0],
      operation: 'sum',
      operandRefs: [salaryRef],
      result: money(salaryMinor),
      explanationKey: 'monthly_plan.salary',
    },
    {
      order: 2,
      stage: MONTHLY_PLAN_CALCULATION_ORDER[1],
      operation: 'sum',
      operandRefs: billRefs,
      result: money(activeBillsTotalMinor),
      explanationKey: 'monthly_plan.active_bills',
    },
    {
      order: 3,
      stage: MONTHLY_PLAN_CALCULATION_ORDER[2],
      operation: 'maximum',
      operandRefs: ['result:salary', 'result:active_bills'],
      intermediateResults: {
        difference: money(disposableDifferenceMinor),
        shortfall: money(shortfallMinor),
      },
      result: money(disposableIncomeMinor),
      explanationKey: 'monthly_plan.disposable_income',
    },
    {
      order: 4,
      stage: MONTHLY_PLAN_CALCULATION_ORDER[3],
      operation: 'remainder_adjustment',
      operandRefs: ['result:disposable_income'],
      intermediateResults: {
        needsBudget: money(allocation.needsBudgetMinor),
        wantsBudget: money(allocation.wantsBudgetMinor),
        savingsTarget: money(allocation.savingsTargetMinor),
        spendableBudget: money(spendableBudgetMinor),
      },
      result: money(disposableIncomeMinor),
      rounding: allocation.rounding,
      explanationKey: 'monthly_plan.allocation_50_30_20',
    },
    {
      order: 5,
      stage: MONTHLY_PLAN_CALCULATION_ORDER[4],
      operation: 'sum',
      operandRefs: expenseRefs,
      intermediateResults: {
        needsSpent: money(needsSpentMinor),
        wantsSpent: money(wantsSpentMinor),
        remainingSpendable: money(remainingSpendableMinor),
        projectedSavings: money(projectedSavingsMinor),
      },
      appliedTreatments: applicableExpenses.map((expense) => ({
        expenseId: expense.id,
        category: expense.category,
        treatment: expense.appliedTreatment.treatment,
        source: expense.appliedTreatment.source,
      })),
      result: money(applicableExpensesTotalMinor),
      explanationKey: 'monthly_plan.expenses',
    },
    {
      order: 6,
      stage: MONTHLY_PLAN_CALCULATION_ORDER[5],
      operation: 'round_half_up',
      operandRefs: ['result:remaining_spendable', 'period:days_remaining_inclusive'],
      divisor: daysRemainingInclusive,
      result: money(dailyGuide.amountMinor),
      rounding: dailyGuide.rounding,
      explanationKey: 'monthly_plan.daily_guide',
    },
  ];

  return {
    period: {
      month: applicableMonth,
      timeZone: validatedTimeZone,
      start: `${applicableMonth}-01`,
      endExclusive: `${nextMonth(applicableMonth)}-01`,
      asOfDate: date.value,
      daysRemainingInclusive,
    },
    salaryMinor,
    activeBillsTotalMinor,
    shortfallMinor,
    disposableIncomeMinor,
    needsBudgetMinor: allocation.needsBudgetMinor,
    wantsBudgetMinor: allocation.wantsBudgetMinor,
    savingsTargetMinor: allocation.savingsTargetMinor,
    spendableBudgetMinor,
    needsSpentMinor,
    wantsSpentMinor,
    applicableExpensesTotalMinor,
    remainingSpendableMinor,
    dailySpendingGuideMinor: dailyGuide.amountMinor,
    projectedSavingsMinor,
    activeBillIds: activeBills.map((bill) => bill.id),
    applicableExpenseIds: applicableExpenses.map((expense) => expense.id),
    rounding: {
      ...allocation.rounding,
      dailySpendingGuide: dailyGuide.rounding,
    },
    sourceRefs,
    operations,
  };
}

/** Calculate the required outcome deltas between two already-calculated plans. */
export function calculateMonthlyPlanDeltas(precedingPlan, resultingPlan) {
  if (!precedingPlan || !resultingPlan) {
    throw new TypeError('precedingPlan and resultingPlan are required.');
  }
  if (
    precedingPlan.period?.month !== resultingPlan.period?.month
    || precedingPlan.period?.timeZone !== resultingPlan.period?.timeZone
    || precedingPlan.period?.asOfDate !== resultingPlan.period?.asOfDate
  ) {
    throw new RangeError('monthly plan deltas require the same month, time zone, and local date.');
  }

  return {
    disposableIncomeMinor: subtractPaise(
      resultingPlan.disposableIncomeMinor,
      precedingPlan.disposableIncomeMinor,
      'disposable income delta'
    ),
    dailySpendingGuideMinor: subtractPaise(
      resultingPlan.dailySpendingGuideMinor,
      precedingPlan.dailySpendingGuideMinor,
      'daily spending guide delta'
    ),
  };
}

/** Calculate preceding and resulting plans plus exact transition deltas. */
export function calculateMonthlyPlanTransition({ preceding, resulting }) {
  const precedingPlan = calculateMonthlyPlan(preceding);
  const resultingPlan = calculateMonthlyPlan(resulting);
  return {
    month: resultingPlan.period.month,
    preceding: precedingPlan,
    resulting: resultingPlan,
    deltas: calculateMonthlyPlanDeltas(precedingPlan, resultingPlan),
  };
}

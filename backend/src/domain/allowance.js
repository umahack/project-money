/**
 * Today allowance domain.
 *
 * Pure calculation of Today_Spent, Allowance_Basis, Today_Allowance, Left_Today
 * and the related values of the clarity snapshot. Money is integer paise only.
 * This module never reads the clock, the locale, or the process time zone; the
 * caller supplies the Asia/Kolkata local date and an already-calculated plan.
 *
 * Named thresholds live here and nowhere else in the backend. No other source
 * file repeats these literal values (Requirement 18.26).
 */

import { kolkataDateOf } from './kolkataTime.js';
import {
  assertSafePaise,
  divideHalfUp,
  divideHalfUpWithMetadata,
  createRoundingMetadata,
  sumPaise,
} from './money.js';

/** Large_Entry_Threshold percentage of the month's Spendable_Budget. */
export const LARGE_ENTRY_PERCENT = 25;

/** Large_Entry_Threshold floor in paise (₹1,000.00). */
export const LARGE_ENTRY_FLOOR_MINOR = 100000;

/** Allowance_Progress is reported in tenths of a percent, from 0 through 1000. */
const PROGRESS_FULL_PERMILLE = 1000;

/**
 * The fixed order of the Today_Allowance calculation steps (Requirement 10.18).
 * Each stage is stored on its explanation operation as `stage`, and its
 * explanation key is `today_allowance.<stage>`.
 */
export const TODAY_ALLOWANCE_CALCULATION_ORDER = Object.freeze([
  'spendable_budget',
  'expenses_used',
  'remaining_spendable',
  'add_today_spent',
  'divide_days',
  'floor_zero',
  'subtract_today_spent',
  'versus_guide',
]);

const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;
const DATE_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year, monthNumber) {
  if (monthNumber === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(monthNumber) ? 30 : 31;
}

function assertMonth(value) {
  if (typeof value !== 'string' || !MONTH_PATTERN.test(value)) {
    throw new TypeError('month must use YYYY-MM format.');
  }
  return value;
}

function assertLocalDate(value) {
  const match = typeof value === 'string' ? DATE_PATTERN.exec(value) : null;
  if (!match) throw new TypeError('localDate must use valid YYYY-MM-DD format.');
  if (Number(match[3]) > daysInMonth(Number(match[1]), Number(match[2]))) {
    throw new TypeError('localDate must be a valid calendar date.');
  }
  return value;
}

/** Integer division of two non-negative BigInt values, half-up. */
function halfUpRatio(numerator, denominator) {
  const quotient = numerator / denominator;
  return numerator % denominator * 2n >= denominator ? quotient + 1n : quotient;
}

/**
 * The calendar date a record is attributed to. A recorded spending date wins.
 * A record with no spending date falls back to the Asia/Kolkata date of its
 * creation time. A spending date that is not a real YYYY-MM-DD date, or a
 * missing one with an unparseable creation time, is attributed to no day
 * (null), so the record is never counted as spent today.
 */
function effectiveDateOf(expense) {
  const { spentOn, createdAt } = expense;
  if (spentOn !== null && spentOn !== undefined && spentOn !== '') {
    if (typeof spentOn !== 'string') return null;
    const match = DATE_PATTERN.exec(spentOn);
    if (!match) return null;
    return Number(match[3]) <= daysInMonth(Number(match[1]), Number(match[2])) ? spentOn : null;
  }
  return kolkataDateOf(createdAt ?? null);
}

/** A mark is set only by `true` or the stored integer 1; anything else is unmarked. */
function isMarked(expense) {
  return expense.excludeFromDailyAllowance === true || expense.excludeFromDailyAllowance === 1;
}

function assertPlan(plan, month, localDate) {
  if (!plan || typeof plan !== 'object') throw new TypeError('plan is required.');
  if (plan.period?.month !== month || plan.period?.asOfDate !== localDate) {
    throw new RangeError('plan must be calculated for the same month and local date.');
  }
  const days = plan.period.daysRemainingInclusive;
  if (!Number.isSafeInteger(days) || days <= 0) {
    throw new RangeError('plan daysRemainingInclusive must be a positive safe integer.');
  }
  assertSafePaise(plan.spendableBudgetMinor, {
    allowNegative: false,
    label: 'plan spendableBudgetMinor',
  });
  assertSafePaise(plan.remainingSpendableMinor, { label: 'plan remainingSpendableMinor' });
  return days;
}

function calculateLargeEntryThreshold(spendableBudgetMinor) {
  if (spendableBudgetMinor <= 0) return null;
  const percent = halfUpRatio(
    BigInt(spendableBudgetMinor) * BigInt(LARGE_ENTRY_PERCENT),
    100n
  );
  // 25 percent of a safe integer is below the safe range, so Number() is exact.
  return Math.max(Number(percent), LARGE_ENTRY_FLOOR_MINOR);
}

function calculateUsedPermille(todaySpentMinor, todayAllowanceMinor) {
  if (todayAllowanceMinor <= 0) return null;
  const ratio = halfUpRatio(
    BigInt(todaySpentMinor) * BigInt(PROGRESS_FULL_PERMILLE),
    BigInt(todayAllowanceMinor)
  );
  return ratio > BigInt(PROGRESS_FULL_PERMILLE) ? PROGRESS_FULL_PERMILLE : Number(ratio);
}

function determineZeroReason({ todayAllowanceMinor, spendableBudgetMinor, allowanceBasisMinor }) {
  if (todayAllowanceMinor > 0) return null;
  if (spendableBudgetMinor === 0) return 'no_spendable_budget';
  if (allowanceBasisMinor <= 0) return 'month_budget_used';
  return 'below_minimum_unit';
}

function money(amountMinor) {
  return { currency: 'INR', amountMinor };
}

function compareIds(left, right) {
  if (left.expense.id < right.expense.id) return -1;
  return left.expense.id > right.expense.id ? 1 : 0;
}

function expenseSourceRef({ order, expense, field, label, value, month }) {
  const confirmedAt = expense.confirmedAt ?? expense.updatedAt ?? expense.createdAt;
  return {
    order,
    ref: `expense:${expense.id}:${field}`,
    sourceType: 'expense',
    recordId: expense.id,
    field,
    label,
    value,
    ...(typeof confirmedAt === 'string' && confirmedAt !== '' ? { confirmedAt } : {}),
    period: { month },
  };
}

/**
 * Build the ordered explanation steps and their source references, in the
 * shape `calculateMonthlyPlan` uses: `{ sourceRefs, operations }` with money
 * wrapped as `{ currency, amountMinor }`. Every value here was calculated by
 * `calculateTodayAllowance`, so replaying the steps in order reproduces it:
 * the basis is the remaining spendable plus the counted amounts, the quotient
 * is the half-up division of the basis, the allowance is the larger of zero
 * and the quotient, and Left_Today is the allowance minus Today_Spent.
 *
 * `entries` holds every record of the month with its group: `counted`
 * (dated Today, no mark), `excludedToday` (dated Today, marked) or `other`.
 */
function buildExplanation({
  month,
  entries,
  spendableBudgetMinor,
  remainingSpendableMinor,
  dailySpendingGuideMinor,
  daysRemainingInclusive,
  expensesUsedMinor,
  groupTotals,
  todaySpentMinor,
  allowanceBasisMinor,
  division,
  todayAllowanceMinor,
  leftTodayMinor,
}) {
  const ordered = [...entries].sort(compareIds);
  const sourceRefs = [];
  for (const { expense } of ordered) {
    sourceRefs.push(expenseSourceRef({
      order: sourceRefs.length + 1,
      expense,
      field: 'amountMinor',
      label: `Expense ${expense.id}`,
      value: money(expense.amountMinor),
      month,
    }));
  }
  const markRefs = [];
  for (const { expense, group } of ordered) {
    if (group === 'other') continue;
    const source = expenseSourceRef({
      order: sourceRefs.length + 1,
      expense,
      field: 'excludeFromDailyAllowance',
      label: `Expense ${expense.id} not counted against today's allowance`,
      value: group === 'excludedToday',
      month,
    });
    sourceRefs.push(source);
    markRefs.push(source.ref);
  }

  const amountRef = ({ expense }) => `expense:${expense.id}:amountMinor`;
  const refsOf = (group) => ordered.filter((entry) => entry.group === group).map(amountRef);
  const countedRefs = refsOf('counted');
  const excludedTodayRefs = refsOf('excludedToday');
  const otherRefs = refsOf('other');
  const [spendable, expensesUsed, remaining, basis, divide, floor, left, versus] =
    TODAY_ALLOWANCE_CALCULATION_ORDER;
  const guideDifferenceMinor = sumPaise([todayAllowanceMinor, -dailySpendingGuideMinor], {
    label: 'allowance difference from the daily spending guide',
  });

  const operations = [
    {
      order: 1,
      stage: spendable,
      operation: 'sum',
      operandRefs: ['plan:spendable_budget'],
      derivedFrom: 'monthly_plan.allocation_50_30_20',
      result: money(spendableBudgetMinor),
      explanationKey: `today_allowance.${spendable}`,
    },
    {
      order: 2,
      stage: expensesUsed,
      operation: 'sum',
      operandRefs: ordered.map(amountRef),
      countedExpenseRefs: countedRefs,
      excludedTodayExpenseRefs: excludedTodayRefs,
      otherExpenseRefs: otherRefs,
      markRefs,
      intermediateResults: {
        countedToday: money(groupTotals.counted),
        excludedToday: money(groupTotals.excludedToday),
        otherDays: money(groupTotals.other),
      },
      result: money(expensesUsedMinor),
      explanationKey: `today_allowance.${expensesUsed}`,
    },
    {
      order: 3,
      stage: remaining,
      operation: 'subtract',
      operandRefs: ['result:spendable_budget', 'result:expenses_used'],
      result: money(remainingSpendableMinor),
      explanationKey: `today_allowance.${remaining}`,
    },
    {
      order: 4,
      stage: basis,
      operation: 'sum',
      operandRefs: ['result:remaining_spendable', ...countedRefs],
      intermediateResults: { todaySpent: money(todaySpentMinor) },
      result: money(allowanceBasisMinor),
      explanationKey: `today_allowance.${basis}`,
    },
    {
      order: 5,
      stage: divide,
      operation: 'round_half_up',
      operandRefs: ['result:add_today_spent', 'period:days_remaining_inclusive'],
      divisor: daysRemainingInclusive,
      result: money(division.amountMinor),
      rounding: division.rounding,
      explanationKey: `today_allowance.${divide}`,
    },
    {
      order: 6,
      stage: floor,
      operation: 'maximum',
      operandRefs: ['result:divide_days', 'constant:zero'],
      intermediateResults: { floor: money(0) },
      result: money(todayAllowanceMinor),
      explanationKey: `today_allowance.${floor}`,
    },
    {
      order: 7,
      stage: left,
      operation: 'subtract',
      operandRefs: ['result:floor_zero', 'result:today_spent'],
      intermediateResults: { todaySpent: money(todaySpentMinor) },
      result: money(leftTodayMinor),
      explanationKey: `today_allowance.${left}`,
    },
    {
      order: 8,
      stage: versus,
      operation: 'subtract',
      operandRefs: ['result:floor_zero', 'result:daily_spending_guide'],
      guideOutcomeId: `monthly-plan:${month}`,
      guideExplanationKey: 'monthly_plan.daily_guide',
      comparison: guideDifferenceMinor === 0
        ? 'same'
        : (guideDifferenceMinor > 0 ? 'higher' : 'lower'),
      intermediateResults: { dailySpendingGuide: money(dailySpendingGuideMinor) },
      result: money(guideDifferenceMinor),
      explanationKey: `today_allowance.${versus}`,
    },
  ];

  return { sourceRefs, operations };
}

/**
 * Calculate Today_Spent, Allowance_Basis, Today_Allowance and Left_Today.
 *
 * @param {object} input
 * @param {string} input.month YYYY-MM month being calculated.
 * @param {string} input.localDate Asia/Kolkata date (YYYY-MM-DD) of the request instant.
 * @param {object} input.plan Result of calculateMonthlyPlan for the same month and date.
 *   It is not read when the month is not the month of localDate.
 * @param {Array<object>} input.expenses The month's records with id, amountMinor, spentOn,
 *   createdAt and excludeFromDailyAllowance. A record whose `month` names another
 *   month is ignored, as the plan ignores it.
 * @returns {{ applicable: false, reason: 'not_current_month' } | object}
 */
export function calculateTodayAllowance({ month, localDate, plan, expenses = [] } = {}) {
  const applicableMonth = assertMonth(month);
  const date = assertLocalDate(localDate);

  if (date.slice(0, 7) !== applicableMonth) {
    return { applicable: false, reason: 'not_current_month' };
  }

  const daysRemainingInclusive = assertPlan(plan, applicableMonth, date);
  if (!Array.isArray(expenses)) throw new TypeError('expenses must be an array.');

  const countedExpenseIds = [];
  const countedAmounts = [];
  const excludedTodayExpenseIds = [];
  const excludedTodayAmounts = [];
  const otherAmounts = [];
  const entries = [];

  expenses.forEach((expense, index) => {
    if (!expense || typeof expense !== 'object' || Array.isArray(expense)) {
      throw new TypeError(`expenses[${index}] must be a record.`);
    }
    if (expense.month !== undefined && expense.month !== applicableMonth) return;
    assertSafePaise(expense.amountMinor, {
      allowNegative: false,
      label: `expense record ${expense.id} amountMinor`,
    });
    if (effectiveDateOf(expense) !== date) {
      otherAmounts.push(expense.amountMinor);
      entries.push({ expense, group: 'other' });
    } else if (isMarked(expense)) {
      excludedTodayExpenseIds.push(expense.id);
      excludedTodayAmounts.push(expense.amountMinor);
      entries.push({ expense, group: 'excludedToday' });
    } else {
      countedExpenseIds.push(expense.id);
      countedAmounts.push(expense.amountMinor);
      entries.push({ expense, group: 'counted' });
    }
  });

  const { spendableBudgetMinor, remainingSpendableMinor } = plan;
  const todaySpentMinor = sumPaise(countedAmounts, {
    allowNegative: false,
    label: 'counted expenses',
  });
  const excludedTodayTotalMinor = sumPaise(excludedTodayAmounts, {
    allowNegative: false,
    label: 'excluded expenses dated today',
  });
  const allowanceBasisMinor = sumPaise([remainingSpendableMinor, todaySpentMinor], {
    label: 'allowance basis',
  });

  // The division is always carried out so the explanation shows the signed
  // quotient. A non-positive basis is floored to zero afterwards, and nothing is
  // rounded into that zero, so the reported rounding stays exact in that case.
  const division = divideHalfUpWithMetadata(allowanceBasisMinor, daysRemainingInclusive);
  const todayAllowanceMinor = Math.max(0, division.amountMinor);
  const rounding = allowanceBasisMinor > 0
    ? division.rounding
    : createRoundingMetadata({ direction: 'exact' });

  const leftTodayMinor = sumPaise([todayAllowanceMinor, -todaySpentMinor], {
    label: 'left today',
  });

  const otherDaysTotalMinor = sumPaise(otherAmounts, {
    allowNegative: false,
    label: 'expenses not dated today',
  });
  const expensesUsedMinor = sumPaise(
    [todaySpentMinor, excludedTodayTotalMinor, otherDaysTotalMinor],
    { allowNegative: false, label: 'expenses used' }
  );
  // A plan built by calculateMonthlyPlan always carries the guide. Without it,
  // the guide is by definition the remaining spendable over the same days.
  const dailySpendingGuideMinor = Number.isSafeInteger(plan.dailySpendingGuideMinor)
    ? plan.dailySpendingGuideMinor
    : divideHalfUp(remainingSpendableMinor, daysRemainingInclusive);
  const { sourceRefs, operations } = buildExplanation({
    month: applicableMonth,
    entries,
    spendableBudgetMinor,
    remainingSpendableMinor,
    dailySpendingGuideMinor,
    daysRemainingInclusive,
    expensesUsedMinor,
    groupTotals: {
      counted: todaySpentMinor,
      excludedToday: excludedTodayTotalMinor,
      other: otherDaysTotalMinor,
    },
    todaySpentMinor,
    allowanceBasisMinor,
    division,
    todayAllowanceMinor,
    leftTodayMinor,
  });

  return {
    applicable: true,
    date,
    daysRemainingInclusive,
    spendableBudgetMinor,
    remainingSpendableMinor,
    dailySpendingGuideMinor: plan.dailySpendingGuideMinor,
    todaySpentMinor,
    allowanceBasisMinor,
    todayAllowanceMinor,
    leftTodayMinor,
    overTodayMinor: Math.max(0, -leftTodayMinor),
    usedPermille: calculateUsedPermille(todaySpentMinor, todayAllowanceMinor),
    zeroReason: determineZeroReason({
      todayAllowanceMinor,
      spendableBudgetMinor,
      allowanceBasisMinor,
    }),
    usedBeyondBudgetMinor: Math.max(0, -allowanceBasisMinor),
    excludedToday: {
      count: excludedTodayExpenseIds.length,
      totalMinor: excludedTodayTotalMinor,
    },
    largeEntryThresholdMinor: calculateLargeEntryThreshold(spendableBudgetMinor),
    countedExpenseIds,
    excludedTodayExpenseIds,
    rounding,
    sourceRefs,
    operations,
  };
}

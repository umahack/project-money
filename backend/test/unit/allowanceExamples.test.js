import '../helpers/blockingStdout.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LARGE_ENTRY_FLOOR_MINOR,
  LARGE_ENTRY_PERCENT,
  calculateTodayAllowance,
} from '../../src/domain/allowance.js';
import { kolkataDateOf, kolkataMonthOf } from '../../src/domain/kolkataTime.js';
import { calculateMonthlyPlan } from '../../src/domain/monthlyPlan.js';

// Feature: quick-add-daily-answer, Task 4.8: allowance example tests
// Validates: Requirements 10.2, 10.3, 10.4, 10.5, 10.7, 10.9, 10.10, 10.11, 10.12,
// 10.13, 10.14, 10.15, 10.16, 10.18, 10.21, 10.22, 10.23, 11.2, 18.13, 18.21, 18.23, 18.26.
// Every amount below is integer paise. Salary 1,430,000 paise (₹14,300) gives a
// Spendable_Budget of 1,144,000 (50 and 30 percent), which is 52,000 a day over 22 days.

const SALARY = 1_430_000;
const SPENDABLE = 1_144_000;
const MARCH = '2026-03';
const TODAY = '2026-03-10';

function money(amountMinor) {
  return { currency: 'INR', amountMinor };
}

function expense(id, amountMinor, spentOn, { mark = false, month, createdAt } = {}) {
  const dated = spentOn ?? null;
  return {
    id,
    month: month ?? (dated ? dated.slice(0, 7) : MARCH),
    category: 'Food',
    amountMinor,
    spentOn: spentOn,
    createdAt: createdAt === undefined ? `${dated ?? TODAY}T06:00:00.000Z` : createdAt,
    excludeFromDailyAllowance: mark,
  };
}

function planFor({ month, localDate, salaryMinor = SALARY, billsMinor = [], expenses = [] }) {
  return calculateMonthlyPlan({
    month,
    localDate,
    timeZone: 'Asia/Kolkata',
    salaryEntries: [{ id: 1, month, amountMinor: salaryMinor, confirmedAt: `${month}-01T00:00:00.000Z` }],
    bills: billsMinor.map((amountMinor, index) => ({
      id: index + 1,
      label: `Bill ${index + 1}`,
      amountMinor,
      active: true,
    })),
    expenses,
    categoryTreatments: [],
  });
}

function run({ localDate = TODAY, expenses = [], ...planOptions } = {}) {
  const month = localDate.slice(0, 7);
  const plan = planFor({ month, localDate, expenses, ...planOptions });
  return { plan, result: calculateTodayAllowance({ month, localDate, plan, expenses }) };
}

/** A plan with exact values, for threshold and zero-budget cases that need an exact Spendable_Budget. */
function handPlan({ spendableMinor, remainingMinor = spendableMinor, localDate = TODAY, days = 22 }) {
  return {
    period: { month: localDate.slice(0, 7), asOfDate: localDate, daysRemainingInclusive: days },
    spendableBudgetMinor: spendableMinor,
    remainingSpendableMinor: remainingMinor,
  };
}

function thresholdFor(spendableMinor) {
  return calculateTodayAllowance({
    month: MARCH,
    localDate: TODAY,
    plan: handPlan({ spendableMinor }),
    expenses: [],
  }).largeEntryThresholdMinor;
}

/* ------------------------------------------------------------ Requirement 10 */

test('nothing spent today: Today_Allowance equals the Daily_Spending_Guide and all of it is left', () => {
  const { plan, result } = run();
  assert.equal(plan.dailySpendingGuideMinor, 52_000);
  assert.equal(result.applicable, true);
  assert.equal(result.date, TODAY);
  assert.equal(result.daysRemainingInclusive, 22);
  assert.equal(result.todaySpentMinor, 0);
  assert.equal(result.allowanceBasisMinor, SPENDABLE);
  assert.equal(result.todayAllowanceMinor, plan.dailySpendingGuideMinor);
  assert.equal(result.leftTodayMinor, 52_000);
  assert.equal(result.overTodayMinor, 0);
  assert.equal(result.usedPermille, 0);
  assert.equal(result.zeroReason, null);
  assert.deepEqual(result.excludedToday, { count: 0, totalMinor: 0 });
  assert.deepEqual(result.countedExpenseIds, []);
});

test('a guide that does not divide evenly still matches the allowance when nothing is spent', () => {
  // 10,000,000 salary: spendable 8,000,000 over 22 days is 363,636.36, rounded to 363,636.
  const { plan, result } = run({ salaryMinor: 10_000_000 });
  assert.equal(plan.dailySpendingGuideMinor, 363_636);
  assert.equal(result.todayAllowanceMinor, 363_636);
  assert.equal(result.leftTodayMinor, 363_636);
});

test('a guide of ₹520 with ₹350 spent today keeps the allowance at ₹520 and leaves ₹170', () => {
  const { plan, result } = run({ expenses: [expense(1, 35_000, TODAY)] });
  // The guide already subtracts the ₹350, but the allowance adds it back before dividing.
  assert.equal(plan.remainingSpendableMinor, SPENDABLE - 35_000);
  assert.equal(plan.dailySpendingGuideMinor, 50_409);
  assert.equal(result.todaySpentMinor, 35_000);
  assert.equal(result.allowanceBasisMinor, SPENDABLE);
  assert.equal(result.todayAllowanceMinor, 52_000);
  assert.equal(result.leftTodayMinor, 17_000);
  assert.equal(result.overTodayMinor, 0);
  // 35,000 of 52,000 is 673.08 tenths of a percent, rounded to 673.
  assert.equal(result.usedPermille, 673);
  assert.deepEqual(result.countedExpenseIds, [1]);
});

test('spending beyond the allowance reports the excess and fills the progress to 1000', () => {
  const { result } = run({ expenses: [expense(1, 60_000, TODAY)] });
  assert.equal(result.todayAllowanceMinor, 52_000);
  assert.equal(result.leftTodayMinor, -8_000);
  assert.equal(result.overTodayMinor, 8_000);
  assert.equal(result.usedPermille, 1000);
});

test('an overspent month gives a zero allowance, the amount beyond the budget, and no progress', () => {
  // 1,144,000 budget, 1,200,000 spent on 2 March: 56,000 beyond the budget.
  const { result } = run({ expenses: [expense(1, 1_200_000, '2026-03-02')] });
  assert.equal(result.remainingSpendableMinor, -56_000);
  assert.equal(result.allowanceBasisMinor, -56_000);
  assert.equal(result.todayAllowanceMinor, 0);
  assert.equal(result.zeroReason, 'month_budget_used');
  assert.equal(result.usedBeyondBudgetMinor, 56_000);
  assert.equal(result.usedPermille, null);
  assert.equal(result.leftTodayMinor, 0);
  assert.equal(result.overTodayMinor, 0);
});

test('an overspent month with spending today counts Left_Today as the negative of Today_Spent', () => {
  const { result } = run({
    expenses: [expense(1, 1_200_000, '2026-03-02'), expense(2, 5_000, TODAY)],
  });
  assert.equal(result.allowanceBasisMinor, -56_000 - 5_000 + 5_000);
  assert.equal(result.todayAllowanceMinor, 0);
  assert.equal(result.leftTodayMinor, -5_000);
  assert.equal(result.overTodayMinor, 5_000);
  assert.equal(result.usedPermille, null);
});

test('a month whose budget is used up exactly is month_budget_used, not a below-minimum zero', () => {
  const { result } = run({ expenses: [expense(1, SPENDABLE, '2026-03-02')] });
  assert.equal(result.allowanceBasisMinor, 0);
  assert.equal(result.todayAllowanceMinor, 0);
  assert.equal(result.zeroReason, 'month_budget_used');
  assert.equal(result.usedBeyondBudgetMinor, 0);
});

test('a zero spendable budget gives a zero allowance, its own reason, and no threshold', () => {
  // Bills equal the salary, so nothing is left to spend.
  const equal = run({ billsMinor: [SALARY] }).result;
  assert.equal(equal.spendableBudgetMinor, 0);
  assert.equal(equal.todayAllowanceMinor, 0);
  assert.equal(equal.zeroReason, 'no_spendable_budget');
  assert.equal(equal.largeEntryThresholdMinor, null);
  assert.equal(equal.usedPermille, null);
  assert.equal(equal.leftTodayMinor, 0);
  // Bills above the salary give the same result.
  const above = run({ billsMinor: [SALARY, 10_000] }).result;
  assert.equal(above.spendableBudgetMinor, 0);
  assert.equal(above.todayAllowanceMinor, 0);
  assert.equal(above.zeroReason, 'no_spendable_budget');
  assert.equal(above.largeEntryThresholdMinor, null);
});

test('the first and last day of a month use the month length and one day', () => {
  const cases = [
    ['2026-03-01', 31, 1_144_000 / 31],
    ['2026-03-31', 1, 1_144_000],
    ['2026-04-01', 30, 1_144_000 / 30],
    ['2026-04-30', 1, 1_144_000],
    ['2026-12-31', 1, 1_144_000],
    ['2027-01-01', 31, 1_144_000 / 31],
  ];
  for (const [localDate, days, exact] of cases) {
    const { plan, result } = run({ localDate });
    assert.equal(result.daysRemainingInclusive, days, localDate);
    assert.equal(result.applicable, true, localDate);
    assert.equal(result.todayAllowanceMinor, Math.round(exact), localDate);
    assert.equal(result.todayAllowanceMinor, plan.dailySpendingGuideMinor, localDate);
  }
});

test('a leap February has 29 days and a non-leap February has 28', () => {
  const cases = [
    ['2028-02-01', 29],
    ['2028-02-15', 15],
    ['2028-02-29', 1],
    ['2027-02-01', 28],
    ['2027-02-28', 1],
    ['2000-02-29', 1], // divisible by 400
    ['2100-02-28', 1], // divisible by 100 and not 400, so not a leap year
    ['2100-02-01', 28],
  ];
  for (const [localDate, days] of cases) {
    const { result } = run({ localDate });
    assert.equal(result.daysRemainingInclusive, days, localDate);
    assert.equal(result.todayAllowanceMinor, Math.round(SPENDABLE / days), localDate);
  }
  const plan = planFor({ month: '2027-02', localDate: '2027-02-28' });
  assert.throws(
    () => calculateTodayAllowance({ month: '2027-02', localDate: '2027-02-29', plan, expenses: [] }),
    TypeError
  );
  assert.throws(
    () => calculateTodayAllowance({ month: '2100-02', localDate: '2100-02-29', plan, expenses: [] }),
    TypeError
  );
});

test('the calendar day changes at 00:00 Asia/Kolkata, which is 18:30 UTC', () => {
  assert.equal(kolkataDateOf('2026-03-10T18:29:59.999Z'), '2026-03-10');
  assert.equal(kolkataDateOf('2026-03-10T18:30:00.000Z'), '2026-03-11');
  assert.equal(kolkataDateOf('2026-03-10T00:00:00.000Z'), '2026-03-10');
  assert.equal(kolkataDateOf('2026-03-09T18:30:00.000Z'), '2026-03-10');
  assert.equal(kolkataDateOf('2026-03-09T18:29:59.999Z'), '2026-03-09');
  // The month and the year change at the same instant.
  assert.equal(kolkataMonthOf('2026-03-31T18:29:59.999Z'), MARCH);
  assert.equal(kolkataMonthOf('2026-03-31T18:30:00.000Z'), '2026-04');
  assert.equal(kolkataDateOf('2025-12-31T18:30:00.000Z'), '2026-01-01');
  // A +05:30 offset names the same Kolkata midnight as 18:30 UTC.
  assert.equal(kolkataDateOf('2026-03-11T00:00:00+05:30'), '2026-03-11');
  assert.equal(kolkataDateOf('2026-03-10T23:59:59+05:30'), '2026-03-10');
});

test('an expense with no spending date moves from one day to the next at Kolkata midnight', () => {
  const beforeMidnight = expense(1, 7_000, null, { createdAt: '2026-03-10T18:29:59.999Z' });
  const atMidnight = expense(2, 3_000, null, { createdAt: '2026-03-10T18:30:00.000Z' });
  const expenses = [beforeMidnight, atMidnight];
  const tenth = run({ localDate: '2026-03-10', expenses }).result;
  assert.deepEqual(tenth.countedExpenseIds, [1]);
  assert.equal(tenth.todaySpentMinor, 7_000);
  const eleventh = run({ localDate: '2026-03-11', expenses }).result;
  assert.deepEqual(eleventh.countedExpenseIds, [2]);
  assert.equal(eleventh.todaySpentMinor, 3_000);
  assert.equal(eleventh.daysRemainingInclusive, 21);
});

test('an expense with no spending date is attributed to the Kolkata date of its creation', () => {
  const legacy = [
    expense(1, 100, null, { createdAt: '2026-03-10 02:00:00' }), // SQLite form, UTC: 07:30 on the 10th
    expense(2, 200, undefined, { createdAt: '2026-03-09T20:00:00.000Z' }), // 01:30 on the 10th Kolkata
    expense(3, 400, '', { createdAt: '2026-03-10T10:00:00.000Z' }), // empty text counts as no date
    expense(4, 800, null, { createdAt: '2026-03-09T10:00:00.000Z' }), // the 9th
    expense(5, 1_600, null, { createdAt: '2026-03-11T10:00:00.000Z' }), // the 11th
  ];
  const { result } = run({ expenses: legacy });
  assert.deepEqual(result.countedExpenseIds, [1, 2, 3]);
  assert.equal(result.todaySpentMinor, 700);
  // The other days still use up the month.
  assert.equal(result.operations[1].result.amountMinor, 100 + 200 + 400 + 800 + 1_600);
  assert.deepEqual(result.operations[1].otherExpenseRefs, ['expense:4:amountMinor', 'expense:5:amountMinor']);
});

test('an expense with no spending date and no usable creation time is never counted today', () => {
  const rows = [
    expense(1, 5_000, null, { createdAt: null }),
    expense(2, 6_000, null, { createdAt: 'not-a-timestamp' }),
    { id: 3, month: MARCH, category: 'Food', amountMinor: 7_000 },
    expense(4, 8_000, '2026-02-30', { month: MARCH, createdAt: '2026-03-10T06:00:00.000Z' }), // not a real date
  ];
  const { result } = run({ expenses: rows });
  assert.deepEqual(result.countedExpenseIds, []);
  assert.equal(result.todaySpentMinor, 0);
  // They still reduce the month's remaining spendable.
  assert.equal(result.remainingSpendableMinor, SPENDABLE - 26_000);
  assert.equal(result.operations[1].result.amountMinor, 26_000);
});

test('a past-month and a future-month entry change nothing for the current month', () => {
  const baseline = run({ expenses: [expense(1, 10_000, TODAY)] }).result;
  const withOthers = run({
    expenses: [
      expense(1, 10_000, TODAY),
      expense(2, 900_000, '2026-02-10'),
      expense(3, 900_000, '2026-04-10'),
      expense(4, 900_000, TODAY, { month: '2026-02' }),
    ],
  }).result;
  assert.deepEqual(withOthers, baseline);
  assert.equal(withOthers.sourceRefs.some(({ recordId }) => recordId !== 1), false);
});

test('a dated entry of the current month changes the allowance but not Today_Spent unless dated Today', () => {
  const baseline = run().result;
  const past = run({ expenses: [expense(1, 22_000, '2026-03-03')] }).result;
  const future = run({ expenses: [expense(1, 22_000, '2026-03-25')] }).result;
  for (const result of [past, future]) {
    assert.equal(result.todaySpentMinor, 0);
    assert.equal(result.todayAllowanceMinor, baseline.todayAllowanceMinor - 1_000); // 22,000 over 22 days
    assert.equal(result.leftTodayMinor, result.todayAllowanceMinor);
  }
  assert.equal(past.todayAllowanceMinor, 51_000);
});

test('a month other than the month of the local date is not applicable and its plan is not read', () => {
  const expected = { applicable: false, reason: 'not_current_month' };
  const plan = planFor({ month: MARCH, localDate: TODAY });
  assert.deepEqual(
    calculateTodayAllowance({ month: '2026-02', localDate: TODAY, plan, expenses: [] }),
    expected
  );
  assert.deepEqual(
    calculateTodayAllowance({ month: '2026-04', localDate: TODAY, plan, expenses: [] }),
    expected
  );
  assert.deepEqual(
    calculateTodayAllowance({ month: '2025-03', localDate: TODAY, plan, expenses: [] }),
    expected
  );
  // The plan is not needed, and the records are not looked at.
  assert.deepEqual(
    calculateTodayAllowance({ month: '2026-04', localDate: TODAY, plan: undefined, expenses: 'not a list' }),
    expected
  );
  // The result carries no Today value.
  assert.deepEqual(Object.keys(expected), ['applicable', 'reason']);
  // A month that is not YYYY-MM is a caller error, not "not applicable".
  assert.throws(() => calculateTodayAllowance({ month: '2026-3', localDate: TODAY, plan }), TypeError);
});

test('an expense dated Today with the mark is not counted and is reported separately', () => {
  const { result } = run({ expenses: [expense(1, 35_000, TODAY, { mark: true })] });
  assert.equal(result.todaySpentMinor, 0);
  assert.deepEqual(result.countedExpenseIds, []);
  assert.deepEqual(result.excludedTodayExpenseIds, [1]);
  assert.deepEqual(result.excludedToday, { count: 1, totalMinor: 35_000 });
  assert.equal(result.leftTodayMinor, result.todayAllowanceMinor);
  assert.equal(result.usedPermille, 0);
});

test('a marked expense dated Today lowers the allowance exactly as the same expense on another day', () => {
  const marked = run({ expenses: [expense(1, 220_000, TODAY, { mark: true })] }).result;
  const otherDay = run({ expenses: [expense(1, 220_000, '2026-03-04')] }).result;
  assert.equal(marked.todayAllowanceMinor, 42_000); // (1,144,000 - 220,000) / 22
  assert.equal(marked.todayAllowanceMinor, otherDay.todayAllowanceMinor);
  assert.equal(marked.allowanceBasisMinor, otherDay.allowanceBasisMinor);
  assert.equal(marked.remainingSpendableMinor, otherDay.remainingSpendableMinor);
  assert.equal(marked.leftTodayMinor, otherDay.leftTodayMinor);
  assert.equal(marked.usedPermille, otherDay.usedPermille);
  // The same expense unmarked is counted and leaves the allowance at the guide.
  const counted = run({ expenses: [expense(1, 220_000, TODAY)] }).result;
  assert.equal(counted.todayAllowanceMinor, 52_000);
  assert.equal(counted.leftTodayMinor, 52_000 - 220_000);
});

test('the mark applies to a boolean true and the stored integer 1 only', () => {
  const stored = [true, 1].map((mark) => run({ expenses: [expense(1, 100, TODAY, { mark })] }).result);
  for (const result of stored) assert.deepEqual(result.excludedTodayExpenseIds, [1]);
  for (const mark of [false, 0, null, undefined, 2, '1', 'true']) {
    const { result } = run({ expenses: [expense(1, 100, TODAY, { mark })] });
    assert.deepEqual(result.countedExpenseIds, [1], `mark ${String(mark)}`);
  }
});

test('an auto-posted recurring expense dated Today is excluded, and one dated another day changes nothing about Today_Spent', () => {
  const recurring = { ...expense(9, 150_000, TODAY, { mark: 1 }), category: 'Rent' };
  const earlier = { ...expense(8, 150_000, '2026-03-01', { mark: 1 }), category: 'Rent' };
  const today = run({ expenses: [recurring] }).result;
  assert.equal(today.todaySpentMinor, 0);
  assert.deepEqual(today.excludedToday, { count: 1, totalMinor: 150_000 });
  const earlierOnly = run({ expenses: [earlier] }).result;
  assert.equal(earlierOnly.todaySpentMinor, 0);
  assert.deepEqual(earlierOnly.excludedToday, { count: 0, totalMinor: 0 });
  assert.equal(today.todayAllowanceMinor, earlierOnly.todayAllowanceMinor);
});

test('an entry saved with the mark and then undone returns every server value to its earlier value', () => {
  const existing = [expense(1, 12_000, TODAY), expense(2, 40_000, '2026-03-02')];
  const before = run({ expenses: existing }).result;
  const saved = run({ expenses: [...existing, expense(3, 300_000, TODAY, { mark: true })] }).result;
  assert.notDeepEqual(saved, before);
  assert.equal(saved.todayAllowanceMinor < before.todayAllowanceMinor, true);
  assert.deepEqual(saved.excludedToday, { count: 1, totalMinor: 300_000 });
  const undone = run({ expenses: existing }).result;
  assert.deepEqual(undone, before);
  assert.deepEqual(undone.excludedToday, { count: 0, totalMinor: 0 });
});

test('an unmarked entry saved and then undone also returns every value, and Left_Today moves by its amount', () => {
  const before = run({ expenses: [expense(1, 12_000, TODAY)] }).result;
  const saved = run({ expenses: [expense(1, 12_000, TODAY), expense(2, 9_000, TODAY)] }).result;
  assert.equal(saved.todayAllowanceMinor, before.todayAllowanceMinor);
  assert.equal(saved.leftTodayMinor, before.leftTodayMinor - 9_000);
  assert.deepEqual(run({ expenses: [expense(1, 12_000, TODAY)] }).result, before);
});

/* ------------------------------------------------- Large_Entry_Threshold */

test('the Large_Entry_Threshold is 25 percent of the Spendable_Budget once that exceeds the ₹1,000 floor', () => {
  assert.equal(thresholdFor(4_000_000), 1_000_000);
  assert.equal(thresholdFor(SPENDABLE), 286_000);
  assert.equal(run().result.largeEntryThresholdMinor, 286_000);
});

test('the floor of 100,000 paise applies at and below the point where 25 percent equals it', () => {
  // 25 percent of 400,000 is exactly 100,000: the percentage and the floor agree.
  assert.equal(thresholdFor(400_000), LARGE_ENTRY_FLOOR_MINOR);
  assert.equal(thresholdFor(399_999), LARGE_ENTRY_FLOOR_MINOR);
  assert.equal(thresholdFor(400_001), LARGE_ENTRY_FLOOR_MINOR); // 100,000.25
  assert.equal(thresholdFor(100_000), LARGE_ENTRY_FLOOR_MINOR);
  assert.equal(thresholdFor(1), LARGE_ENTRY_FLOOR_MINOR); // the floor may exceed the budget itself
});

test('just above the floor the percentage rounds half-paise upward', () => {
  assert.equal(thresholdFor(400_002), 100_001); // 100,000.5 rounds up
  assert.equal(thresholdFor(400_005), 100_001); // 100,001.25 rounds down
  assert.equal(thresholdFor(400_006), 100_002); // 100,001.5 rounds up
  assert.equal(thresholdFor(4_000_001), 1_000_000); // 1,000,000.25
  assert.equal(thresholdFor(4_000_002), 1_000_001); // 1,000,000.5
  assert.equal(thresholdFor(4_000_004), 1_000_001); // exact
});

test('the threshold follows the named constants and is absent only without a spendable budget', () => {
  assert.equal(LARGE_ENTRY_PERCENT, 25);
  assert.equal(LARGE_ENTRY_FLOOR_MINOR, 100_000);
  assert.equal(thresholdFor(0), null);
  // The threshold is a value of the month's budget, so spending leaves it unchanged.
  const spent = run({ expenses: [expense(1, 500_000, '2026-03-02'), expense(2, 10_000, TODAY)] }).result;
  assert.equal(spent.largeEntryThresholdMinor, 286_000);
});

/* ------------------------------------------ the explanation steps */

test('the explanation lists the eight steps in order with exact values for a mixed month', () => {
  // Spendable 1,144,000. Used: 35,000 counted today, 10,000 marked today, 20,000 on 2 March.
  const expenses = [
    expense(1, 35_000, TODAY),
    expense(2, 10_000, TODAY, { mark: true }),
    expense(3, 20_000, '2026-03-02'),
  ];
  const { plan, result } = run({ expenses });
  assert.equal(plan.remainingSpendableMinor, 1_079_000);
  assert.equal(plan.dailySpendingGuideMinor, 49_045); // 1,079,000 / 22 = 49,045.45
  const steps = result.operations;
  assert.deepEqual(steps.map(({ order, stage, operation, explanationKey }) => [order, stage, operation, explanationKey]), [
    [1, 'spendable_budget', 'sum', 'today_allowance.spendable_budget'],
    [2, 'expenses_used', 'sum', 'today_allowance.expenses_used'],
    [3, 'remaining_spendable', 'subtract', 'today_allowance.remaining_spendable'],
    [4, 'add_today_spent', 'sum', 'today_allowance.add_today_spent'],
    [5, 'divide_days', 'round_half_up', 'today_allowance.divide_days'],
    [6, 'floor_zero', 'maximum', 'today_allowance.floor_zero'],
    [7, 'subtract_today_spent', 'subtract', 'today_allowance.subtract_today_spent'],
    [8, 'versus_guide', 'subtract', 'today_allowance.versus_guide'],
  ]);
  assert.deepEqual(steps.map(({ result: value }) => value), [
    money(1_144_000), // Spendable_Budget
    money(65_000), // 35,000 + 10,000 + 20,000
    money(1_079_000), // Remaining_Spendable
    money(1_114_000), // plus Today_Spent 35,000
    money(50_636), // 1,114,000 / 22 = 50,636.36
    money(50_636), // not below zero
    money(15_636), // minus Today_Spent 35,000
    money(1_591), // 50,636 - 49,045
  ]);
  assert.equal(steps[3].intermediateResults.todaySpent.amountMinor, 35_000);
  assert.equal(steps[4].divisor, 22);
  assert.equal(steps[4].rounding.direction, 'half_up');
  assert.deepEqual(steps[5].intermediateResults, { floor: money(0) });
  assert.equal(steps[6].intermediateResults.todaySpent.amountMinor, 35_000);
  assert.equal(steps[7].comparison, 'higher');
  assert.deepEqual(steps[7].intermediateResults, { dailySpendingGuide: money(49_045) });
  // The expenses are listed in separate groups (Requirement 10.25).
  assert.deepEqual(steps[1].countedExpenseRefs, ['expense:1:amountMinor']);
  assert.deepEqual(steps[1].excludedTodayExpenseRefs, ['expense:2:amountMinor']);
  assert.deepEqual(steps[1].otherExpenseRefs, ['expense:3:amountMinor']);
  assert.deepEqual(steps[1].intermediateResults, {
    countedToday: money(35_000),
    excludedToday: money(10_000),
    otherDays: money(20_000),
  });
  // The headline values are the last steps' values.
  assert.equal(result.todayAllowanceMinor, steps[5].result.amountMinor);
  assert.equal(result.leftTodayMinor, steps[6].result.amountMinor);
});

test('the explanation of a month with nothing spent says the allowance is the same as the guide', () => {
  const { result } = run();
  assert.deepEqual(result.operations.map(({ result: value }) => value.amountMinor), [
    SPENDABLE, 0, SPENDABLE, SPENDABLE, 52_000, 52_000, 52_000, 0,
  ]);
  assert.equal(result.operations[4].rounding.direction, 'exact');
  assert.equal(result.operations[7].comparison, 'same');
  assert.deepEqual(result.sourceRefs, []);
});

test('the explanation of a lower allowance says lower and keeps the signed difference', () => {
  // A marked ₹2,200 expense dated Today lowers the allowance to 42,000 but not the guide's meaning.
  const { result, plan } = run({ expenses: [expense(1, 220_000, TODAY, { mark: true })] });
  assert.equal(result.operations[7].comparison, 'same');
  const lower = calculateTodayAllowance({
    month: MARCH,
    localDate: TODAY,
    plan: { ...plan, dailySpendingGuideMinor: 50_000 },
    expenses: [expense(1, 220_000, TODAY, { mark: true })],
  });
  assert.equal(lower.operations[7].comparison, 'lower');
  assert.deepEqual(lower.operations[7].result, money(-8_000));
});

test('an expense dated Today is listed once in the explanation sources, with a mark reference', () => {
  const { result } = run({ expenses: [expense(5, 700, TODAY), expense(4, 900, TODAY, { mark: true })] });
  assert.deepEqual(result.sourceRefs.map(({ ref }) => ref), [
    'expense:4:amountMinor',
    'expense:5:amountMinor',
    'expense:4:excludeFromDailyAllowance',
    'expense:5:excludeFromDailyAllowance',
  ]);
  assert.deepEqual(result.sourceRefs.map(({ order }) => order), [1, 2, 3, 4]);
});

/* ------------------------------------------------------ source scan */

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');
const OWNER = path.join(SRC_ROOT, 'domain', 'allowance.js');
// Existing, unrelated validation of an Active_Bill label (1 to 60 characters). It is not the
// Bill_Match minimum, which lives in the frontend module. An exact line is allowed so that any
// new comparison of a label length with a number still fails.
const ALLOWED_LABEL_LINES = new Map([
  [path.join(SRC_ROOT, 'services', 'salaryBillMutations.js'), new Set(['if (label.length < 1 || label.length > 60) {'])],
]);
const COMPARATOR = '(?:<=|>=|===|!==|==|!=|<|>)';
const FORBIDDEN = [
  ['the floor literal 100000', /(?<![\w.])100_?000(?![\w])/],
  ['the floor expression 1000 * 100', /(?<![\w.])1_?000\s*\*\s*100(?![\w])/],
  ['the percentage expression * 25', /\*\s*25(?![\w.])|(?<![\w.])25\s*\*/],
  ['a label length compared with a number',
    new RegExp(`label\\w*\\s*\\.\\s*length\\s*${COMPARATOR}\\s*\\d|\\d\\s*${COMPARATOR}\\s*\\w*label\\w*\\s*\\.\\s*length`, 'i')],
];

function findViolations(text, allowedLines = new Set()) {
  const found = [];
  text.split('\n').forEach((line, index) => {
    if (allowedLines.has(line.trim())) return;
    for (const [name, pattern] of FORBIDDEN) {
      if (pattern.test(line)) found.push(`line ${index + 1}: ${name}: ${line.trim()}`);
    }
  });
  return found;
}

function sourceFiles(directory) {
  return readdirSync(directory).flatMap((name) => {
    const full = path.join(directory, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(?:js|mjs|cjs)$/.test(name) ? [full] : [];
  });
}

test('the source scan flags every forbidden form and leaves ordinary code alone', () => {
  const bad = [
    'const floor = 100000;',
    'const floor = 100_000;',
    'return Math.max(x, 100000);',
    'const threshold = budget * 25 / 100;',
    'const threshold = 25 * budget;',
    'if (label.length >= 3) {',
    'if (billLabel.length < 3) return false;',
    'return 3 <= label.length;',
  ];
  for (const line of bad) assert.equal(findViolations(line).length > 0, true, line);
  const fine = [
    'const id = 1000000;',
    'const ratio = 1000 / 100;',
    'const total = count * 250;',
    'const total = count * 25.5;',
    'const x = 1100000;',
    'if (label.length < maxLength) {',
    'if (items.length > 3) {',
  ];
  for (const line of fine) assert.deepEqual(findViolations(line), [], line);
});

test('the Large_Entry literals and label-length comparisons appear in no backend source file but allowance.js', () => {
  const files = sourceFiles(SRC_ROOT);
  assert.equal(files.length > 20, true, 'the scan found the backend source files');
  assert.equal(files.includes(OWNER), true);
  const violations = files
    .filter((file) => file !== OWNER)
    .flatMap((file) => findViolations(
      readFileSync(file, 'utf8'),
      ALLOWED_LABEL_LINES.get(file)
    ).map((message) => `${path.relative(SRC_ROOT, file)} ${message}`));
  assert.deepEqual(violations, []);
});

test('allowance.js defines each named threshold once as a constant', () => {
  const text = readFileSync(OWNER, 'utf8');
  assert.equal(text.match(/LARGE_ENTRY_PERCENT\s*=\s*25\b/g)?.length, 1);
  assert.equal(text.match(/LARGE_ENTRY_FLOOR_MINOR\s*=\s*100000\b/g)?.length, 1);
  assert.equal(text.match(/\b100000\b/g)?.length, 1);
});

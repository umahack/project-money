import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TODAY_ALLOWANCE_CALCULATION_ORDER,
  calculateTodayAllowance,
} from '../../src/domain/allowance.js';
import { calculateMonthlyPlan } from '../../src/domain/monthlyPlan.js';
import {
  VALUE_CLASSIFICATIONS,
  createAuthorizedSourceAccess,
  createAvailableOutcome,
  createCalculationExplanation,
} from '../../src/domain/outcomes.js';
import { divideHalfUp } from '../../src/domain/money.js';

const MONTH = '2026-03';
const TODAY = '2026-03-10';

function money(amountMinor) {
  return { currency: 'INR', amountMinor };
}

function expense(id, amountMinor, spentOn, mark = false, extra = {}) {
  return {
    id,
    month: MONTH,
    category: 'Food',
    amountMinor,
    spentOn,
    createdAt: `${spentOn ?? TODAY}T06:00:00.000Z`,
    excludeFromDailyAllowance: mark,
    ...extra,
  };
}

function planFor({ salaryMinor = 10_000_000, expenses, localDate = TODAY }) {
  return calculateMonthlyPlan({
    month: MONTH,
    localDate,
    timeZone: 'Asia/Kolkata',
    salaryEntries: [{ id: 1, month: MONTH, amountMinor: salaryMinor, confirmedAt: '2026-03-01T00:00:00.000Z' }],
    bills: [],
    expenses,
    categoryTreatments: [],
  });
}

function calculate(expenses, options = {}) {
  const plan = planFor({ ...options, expenses });
  return { plan, result: calculateTodayAllowance({ month: MONTH, localDate: options.localDate ?? TODAY, plan, expenses }) };
}

/** Replays the stored steps with nothing but the stored source values. */
function replay(result) {
  const sources = new Map(result.sourceRefs.map((source) => [source.ref, source]));
  const amount = (ref) => {
    const value = sources.get(ref)?.value;
    assert.equal(value?.currency, 'INR', `missing money source ${ref}`);
    return value.amountMinor;
  };
  const [spendable, used, remaining, basis, divide, floor, left, versus] = result.operations;

  const spendableMinor = spendable.result.amountMinor;
  const usedMinor = used.operandRefs.reduce((total, ref) => total + amount(ref), 0);
  assert.deepEqual(used.result, money(usedMinor));
  const remainingMinor = spendableMinor - usedMinor;
  assert.deepEqual(remaining.result, money(remainingMinor));
  const todaySpentMinor = basis.operandRefs.slice(1).reduce((total, ref) => total + amount(ref), 0);
  assert.deepEqual(basis.intermediateResults.todaySpent, money(todaySpentMinor));
  const basisMinor = remainingMinor + todaySpentMinor;
  assert.deepEqual(basis.result, money(basisMinor));
  const quotientMinor = divideHalfUp(basisMinor, divide.divisor);
  assert.deepEqual(divide.result, money(quotientMinor));
  const allowanceMinor = Math.max(0, quotientMinor);
  assert.deepEqual(floor.result, money(allowanceMinor));
  const leftMinor = allowanceMinor - todaySpentMinor;
  assert.deepEqual(left.result, money(leftMinor));
  const guideMinor = versus.intermediateResults.dailySpendingGuide.amountMinor;
  assert.deepEqual(versus.result, money(allowanceMinor - guideMinor));
  return { todaySpentMinor, basisMinor, allowanceMinor, leftMinor };
}

function sourceAccess() {
  return createAuthorizedSourceAccess({
    authenticated: true,
    authorized: true,
    principalId: 1,
    resourceScope: `month:${MONTH}`,
  });
}

test('the steps come in the required order with fixed keys and numbering', () => {
  const { result } = calculate([expense(1, 20_000, TODAY)]);
  assert.deepEqual(
    result.operations.map(({ order, stage, explanationKey }) => ({ order, stage, explanationKey })),
    TODAY_ALLOWANCE_CALCULATION_ORDER.map((stage, index) => ({
      order: index + 1,
      stage,
      explanationKey: `today_allowance.${stage}`,
    }))
  );
  assert.deepEqual(TODAY_ALLOWANCE_CALCULATION_ORDER, [
    'spendable_budget',
    'expenses_used',
    'remaining_spendable',
    'add_today_spent',
    'divide_days',
    'floor_zero',
    'subtract_today_spent',
    'versus_guide',
  ]);
  assert.deepEqual(result.operations.map(({ operation }) => operation), [
    'sum', 'sum', 'subtract', 'sum', 'round_half_up', 'maximum', 'subtract', 'subtract',
  ]);
});

test('replaying the stored steps reproduces the allowance, basis and Left_Today', () => {
  const expenses = [
    expense(1, 12_345, TODAY),
    expense(2, 50_001, TODAY, true),
    expense(3, 700_000, '2026-03-02'),
    expense(4, 33_333, '2026-03-25'),
    expense(5, 999, null, false, { createdAt: '2026-03-09T20:00:00.000Z' }),
    expense(6, 4_000, null, false, { createdAt: 'not-a-timestamp' }),
  ];
  const { result } = calculate(expenses);
  const replayed = replay(result);
  assert.deepEqual(replayed, {
    todaySpentMinor: result.todaySpentMinor,
    basisMinor: result.allowanceBasisMinor,
    allowanceMinor: result.todayAllowanceMinor,
    leftMinor: result.leftTodayMinor,
  });
  // Expense 5 was created at 01:30 on 10 March in Asia/Kolkata, so it is counted today.
  assert.deepEqual(result.countedExpenseIds, [1, 5]);
  assert.equal(result.todaySpentMinor, 12_345 + 999);
});

test('counted and excluded-today expenses are listed separately and every other expense is in the sum', () => {
  const expenses = [
    expense(9, 100, TODAY),
    expense(3, 200, TODAY, true),
    expense(7, 300, '2026-03-01'),
    expense(2, 400, TODAY),
    expense(5, 500, TODAY, true),
  ];
  const { result } = calculate(expenses);
  const used = result.operations[1];
  assert.deepEqual(used.countedExpenseRefs, ['expense:2:amountMinor', 'expense:9:amountMinor']);
  assert.deepEqual(used.excludedTodayExpenseRefs, ['expense:3:amountMinor', 'expense:5:amountMinor']);
  assert.deepEqual(used.otherExpenseRefs, ['expense:7:amountMinor']);
  assert.deepEqual(used.operandRefs, [2, 3, 5, 7, 9].map((id) => `expense:${id}:amountMinor`));
  assert.deepEqual(used.intermediateResults, {
    countedToday: money(500),
    excludedToday: money(700),
    otherDays: money(300),
  });
  assert.deepEqual(used.result, money(1500));
  // Today_Spent adds the counted amounts only. The excluded ones stay in Remaining_Spendable.
  assert.deepEqual(result.operations[3].operandRefs.slice(1), used.countedExpenseRefs);
  assert.equal(result.todaySpentMinor, 500);
  assert.deepEqual(result.excludedToday, { count: 2, totalMinor: 700 });
});

test('each expense dated Today has a boolean mark reference and no other expense has one', () => {
  const expenses = [
    expense(1, 100, TODAY),
    expense(2, 200, TODAY, true),
    expense(3, 300, '2026-03-04', true),
    expense(4, 400, '2026-03-30'),
  ];
  const { result } = calculate(expenses);
  const marks = result.sourceRefs.filter(({ field }) => field === 'excludeFromDailyAllowance');
  assert.deepEqual(marks.map(({ ref, value }) => [ref, value]), [
    ['expense:1:excludeFromDailyAllowance', false],
    ['expense:2:excludeFromDailyAllowance', true],
  ]);
  assert.deepEqual(result.operations[1].markRefs, marks.map(({ ref }) => ref));
  assert.equal(new Set(result.sourceRefs.map(({ ref }) => ref)).size, result.sourceRefs.length);
  assert.deepEqual(result.sourceRefs.map(({ order }) => order), result.sourceRefs.map((_, index) => index + 1));
});

test('the steps and references are accepted by the existing outcome and explanation builders', () => {
  const { result } = calculate([
    expense(1, 100, TODAY),
    expense(2, 200, TODAY, true),
    expense(3, 300, '2026-03-04'),
    expense(4, 5_000, null, false, { createdAt: null }),
  ]);
  const access = sourceAccess();
  const period = {
    month: MONTH,
    timeZone: 'Asia/Kolkata',
    start: '2026-03-01',
    endExclusive: '2026-04-01',
    asOfDate: TODAY,
    daysRemainingInclusive: result.daysRemainingInclusive,
  };
  const outcome = createAvailableOutcome({
    sourceAccess: access,
    id: `today-allowance:${MONTH}`,
    kind: 'today_allowance',
    classification: VALUE_CLASSIFICATIONS.CALCULATED_RESULT,
    period,
    dataVersion: 7,
    value: money(result.todayAllowanceMinor),
    sourceRefs: result.sourceRefs,
    rounding: result.rounding,
  });
  const explanation = createCalculationExplanation({
    sourceAccess: access,
    outcome,
    operations: result.operations,
  });
  assert.equal(explanation.operations.length, 8);
  assert.deepEqual(explanation.operations.map(({ stage }) => stage), TODAY_ALLOWANCE_CALCULATION_ORDER);
  assert.equal(explanation.dataVersion, 7);
  assert.deepEqual(explanation.period, outcome.period);
  assert.deepEqual(explanation.rounding, result.rounding);
  assert.equal(explanation.sourceRefs.every(({ sourceType }) => sourceType === 'expense'), true);
  assert.deepEqual(replay(explanation), replay(result));
});

test('the division step carries half-up rounding metadata and the final rounding matches it', () => {
  // Spendable budget 8,000,000 (50 and 30 percent of 10,000,000), 22 days left on 10 March: 363,636.36 paise.
  const { result } = calculate([]);
  const divide = result.operations[4];
  assert.equal(divide.divisor, result.daysRemainingInclusive);
  assert.equal(divide.divisor, 22);
  assert.equal(divide.result.amountMinor, result.todayAllowanceMinor);
  assert.equal(divide.rounding.direction, 'half_up');
  assert.deepEqual(divide.rounding, result.rounding);
  assert.equal(result.operations[0].result.amountMinor, 8_000_000);
});

test('an exact division reports exact rounding', () => {
  // 12 March leaves 20 days, and 8,000,000 divides by 20 without a remainder.
  const plan = planFor({ localDate: '2026-03-12', expenses: [] });
  assert.equal(plan.period.daysRemainingInclusive, 20);
  const result = calculateTodayAllowance({ month: MONTH, localDate: '2026-03-12', plan, expenses: [] });
  assert.equal(result.operations[4].rounding.direction, 'exact');
  assert.deepEqual(result.rounding, result.operations[4].rounding);
  assert.equal(result.todayAllowanceMinor, 400_000);
});

test('a negative basis shows the signed quotient, floors at zero and keeps the top-level rounding exact', () => {
  // Spendable 8,000,000; 8,000,007 already spent on other days; 22 days left.
  const { result } = calculate([expense(1, 8_000_007, '2026-03-02')]);
  const [, , remaining, basis, divide, floor, left] = result.operations;
  assert.deepEqual(remaining.result, money(-7));
  assert.deepEqual(basis.result, money(-7));
  assert.deepEqual(divide.result, money(0));
  assert.deepEqual(floor.result, money(0));
  assert.deepEqual(left.result, money(0));
  assert.equal(result.todayAllowanceMinor, 0);
  assert.equal(result.zeroReason, 'month_budget_used');
  assert.deepEqual(result.rounding, { precisionMinor: 1, direction: 'exact', adjustmentMinor: 0 });
  replay(result);

  const deep = calculate([expense(1, 8_000_700, '2026-03-02')]).result;
  assert.deepEqual(deep.operations[4].result, money(-32));
  assert.equal(deep.operations[4].rounding.direction, 'half_up');
  assert.deepEqual(deep.operations[5].result, money(0));
  assert.deepEqual(deep.rounding, { precisionMinor: 1, direction: 'exact', adjustmentMinor: 0 });
  replay(deep);
});

test('Left_Today is negative in the last step when Today_Spent is over the allowance', () => {
  const { result } = calculate([expense(1, 500_000, TODAY)]);
  const left = result.operations[6];
  assert.equal(left.result.amountMinor, result.leftTodayMinor);
  assert.ok(left.result.amountMinor < 0);
  assert.deepEqual(left.intermediateResults, { todaySpent: money(500_000) });
  replay(result);
});

test('the guide step references the guide result and states how the allowance differs from it', () => {
  const nothing = calculate([]).result;
  const same = nothing.operations[7];
  assert.equal(same.comparison, 'same');
  assert.deepEqual(same.result, money(0));
  assert.deepEqual(same.intermediateResults.dailySpendingGuide, money(nothing.dailySpendingGuideMinor));
  assert.equal(same.guideOutcomeId, `monthly-plan:${MONTH}`);
  assert.equal(same.guideExplanationKey, 'monthly_plan.daily_guide');

  // An expense dated Today leaves the basis unchanged only if it is counted, so spending
  // today raises the allowance above the guide, which already subtracts it.
  const counted = calculate([expense(1, 200_000, TODAY)]).result;
  assert.equal(counted.operations[7].comparison, 'higher');
  assert.equal(
    counted.operations[7].result.amountMinor,
    counted.todayAllowanceMinor - counted.dailySpendingGuideMinor
  );

  // The same expense with the mark lowers both the guide and the allowance equally.
  const marked = calculate([expense(1, 200_000, TODAY, true)]).result;
  assert.equal(marked.operations[7].comparison, 'same');
  assert.equal(marked.todayAllowanceMinor, marked.dailySpendingGuideMinor);
});

test('a plan without a guide value still yields a guide step equal to remaining over days', () => {
  const plan = planFor({ expenses: [] });
  const { dailySpendingGuideMinor, ...withoutGuide } = plan;
  assert.ok(Number.isSafeInteger(dailySpendingGuideMinor));
  const result = calculateTodayAllowance({ month: MONTH, localDate: TODAY, plan: withoutGuide, expenses: [] });
  assert.deepEqual(result.operations[7].intermediateResults.dailySpendingGuide, money(dailySpendingGuideMinor));
  assert.equal(result.dailySpendingGuideMinor, undefined);
});

test('another month has no steps or references', () => {
  const plan = planFor({ expenses: [] });
  const result = calculateTodayAllowance({ month: '2026-02', localDate: TODAY, plan, expenses: [] });
  assert.deepEqual(result, { applicable: false, reason: 'not_current_month' });
});

test('an expense record of another month is not listed', () => {
  const { plan } = calculate([]);
  const result = calculateTodayAllowance({
    month: MONTH,
    localDate: TODAY,
    plan,
    expenses: [{ ...expense(1, 100, TODAY), month: '2026-02' }],
  });
  assert.deepEqual(result.sourceRefs, []);
  assert.deepEqual(result.operations[1].operandRefs, []);
  assert.deepEqual(result.operations[1].result, money(0));
});

test('the added explanation fields leave the existing result fields unchanged', () => {
  const { result } = calculate([expense(1, 100, TODAY), expense(2, 200, TODAY, true)]);
  const { sourceRefs, operations, ...rest } = result;
  assert.deepEqual(Object.keys(rest).sort(), [
    'allowanceBasisMinor', 'applicable', 'countedExpenseIds', 'dailySpendingGuideMinor', 'date',
    'daysRemainingInclusive', 'excludedToday', 'excludedTodayExpenseIds', 'largeEntryThresholdMinor',
    'leftTodayMinor', 'overTodayMinor', 'remainingSpendableMinor', 'rounding', 'spendableBudgetMinor',
    'todayAllowanceMinor', 'todaySpentMinor', 'usedBeyondBudgetMinor', 'usedPermille', 'zeroReason',
  ]);
  assert.ok(Array.isArray(sourceRefs) && Array.isArray(operations));
});

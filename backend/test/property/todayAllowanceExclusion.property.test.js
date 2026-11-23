import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { calculateMonthlyPlan } from '../../src/domain/monthlyPlan.js';
import { calculateTodayAllowance } from '../../src/domain/allowance.js';
import { assertProperty } from '../helpers/propertyReport.js';
import {
  KOLKATA_TIME_ZONE,
  daysInMonth,
  kolkataDateOf,
  withProcessTimeZone,
} from '../helpers/kolkataReference.js';
import { monthLedgerArb } from '../helpers/quickAddGenerators.js';

// Feature: quick-add-daily-answer, Property 15: Allowance_Exclusion is a today-only mark
// Validates: Requirements 10.20, 10.21, 10.22, 17.20, 17.21, 17.22, 18.12, 18.13
//
// The reference below is independent of allowance.js and monthlyPlan.js. It
// uses BigInt arithmetic, attributes every record to a day through its
// spending date or, when there is none, the Asia/Kolkata date of its creation
// time read with Intl, and splits the month into the three groups: counted
// (dated Today, no mark), marked and dated Today, and dated on another day.
// Both modules under test run on the same expenses; calculateMonthlyPlan
// ignores the mark, so the plan has to be identical with and without it.

const NUM_RUNS = 300;
const PROCESS_TIME_ZONES = Object.freeze([
  'UTC', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Asia/Kolkata', 'Australia/Lord_Howe',
]);
const CATEGORIES = Object.freeze([
  'Food', 'Groceries', 'Rent', 'Utilities', 'Transport', 'Shopping', 'Entertainment', 'Other',
]);
const SET_FORMS = Object.freeze([true, 1]);
const CLEAR_FORMS = Object.freeze([false, 0, null, 'delete']);
const EXTRA_ID = 9_000_001;
const MAX_LEDGER = 12;

/* ------------------------------------------------------------- reference */

function halfUp(numerator, denominator) {
  let quotient = numerator / denominator;
  if ((numerator % denominator) * 2n >= denominator) quotient += 1n;
  return quotient;
}

/** Half away from zero, the rounding the Daily_Spending_Guide uses for a negative remainder. */
function halfAwayFromZero(numerator, denominator) {
  return numerator < 0n ? -halfUp(-numerator, denominator) : halfUp(numerator, denominator);
}

function referenceDate(expense) {
  if (expense.spentOn !== null && expense.spentOn !== undefined && expense.spentOn !== '') {
    return expense.spentOn;
  }
  if (typeof expense.createdAt !== 'string') return null;
  const ms = Date.parse(expense.createdAt);
  return Number.isFinite(ms) ? kolkataDateOf(ms) : null;
}

function referenceMarked(expense) {
  return expense.excludeFromDailyAllowance === true || expense.excludeFromDailyAllowance === 1;
}

function sum(list) {
  return list.reduce((total, value) => total + BigInt(value), 0n);
}

function sortedIds(list) {
  return [...list].sort((a, b) => a - b);
}

function referenceOf({ localDate, salary, bills, expenses }) {
  const year = Number(localDate.slice(0, 4));
  const monthNumber = Number(localDate.slice(5, 7));
  const today = Number(localDate.slice(8, 10));
  const daysRemaining = BigInt(daysInMonth(year, monthNumber) - today + 1);

  const groups = { counted: [], excluded: [], other: [] };
  for (const expense of expenses) {
    if (referenceDate(expense) !== localDate) groups.other.push(expense);
    else if (referenceMarked(expense)) groups.excluded.push(expense);
    else groups.counted.push(expense);
  }
  const countedMinor = sum(groups.counted.map((e) => e.amountMinor));
  const excludedMinor = sum(groups.excluded.map((e) => e.amountMinor));
  const otherMinor = sum(groups.other.map((e) => e.amountMinor));
  const totalMinor = sum(expenses.map((e) => e.amountMinor));

  const billsTotal = sum(bills);
  const salaryMinor = BigInt(salary);
  const disposable = salaryMinor > billsTotal ? salaryMinor - billsTotal : 0n;
  const spendable = halfUp(disposable, 2n) + halfUp(disposable * 3n, 10n);
  const remaining = spendable - totalMinor;
  const guide = halfAwayFromZero(remaining, daysRemaining);
  let projectedSavings = 0n;
  if (billsTotal < salaryMinor && totalMinor < salaryMinor - billsTotal) {
    projectedSavings = salaryMinor - billsTotal - totalMinor;
  }

  const basis = remaining + countedMinor;
  const allowance = basis <= 0n ? 0n : halfUp(basis, daysRemaining);
  const left = allowance - countedMinor;
  return {
    groups,
    countedMinor,
    excludedMinor,
    otherMinor,
    totalMinor,
    spendable,
    remaining,
    guide,
    projectedSavings,
    daysRemaining,
    basis,
    allowance,
    left,
  };
}

/* ------------------------------------------------------------- scenarios */

/** The expense with the mark set (to `forms.set`) or cleared (to `forms.clear`). */
function withMark(expense, marked, forms) {
  const copy = { ...expense };
  if (marked) copy.excludeFromDailyAllowance = forms.set;
  else if (forms.clear === 'delete') delete copy.excludeFromDailyAllowance;
  else copy.excludeFromDailyAllowance = forms.clear;
  return copy;
}

function withoutMarkProperty(expense) {
  const copy = { ...expense };
  delete copy.excludeFromDailyAllowance;
  return copy;
}

function evaluate(scenario, expenses) {
  const { month, localDate, salary, bills } = scenario;
  const plan = calculateMonthlyPlan({
    month,
    localDate,
    timeZone: KOLKATA_TIME_ZONE,
    salaryEntries: [{ id: 1, month, amountMinor: salary }],
    bills: bills.map((amountMinor, index) => ({ id: index + 1, amountMinor, active: true })),
    expenses,
    categoryTreatments: [],
  });
  const allowance = calculateTodayAllowance({ month, localDate, plan, expenses });
  return { plan, allowance, reference: referenceOf({ localDate, salary, bills, expenses }) };
}

function otherDayOf(localDate, rawIndex) {
  const month = localDate.slice(0, 7);
  const today = Number(localDate.slice(8, 10));
  const length = daysInMonth(Number(localDate.slice(0, 4)), Number(localDate.slice(5, 7)));
  const days = Array.from({ length }, (_, i) => i + 1).filter((day) => day !== today);
  return `${month}-${String(days[rawIndex % days.length]).padStart(2, '0')}`;
}

const extrasArb = fc.record({
  salary: fc.oneof(
    { weight: 3, arbitrary: fc.integer({ min: 0, max: 2_000_000_000 }) },
    { weight: 1, arbitrary: fc.integer({ min: 0, max: 5000 }) },
  ),
  bills: fc.array(fc.integer({ min: 0, max: 300_000_000 }), { minLength: 0, maxLength: 4 }),
  categories: fc.array(fc.constantFrom(...CATEGORIES), { minLength: MAX_LEDGER, maxLength: MAX_LEDGER }),
  mask: fc.array(fc.boolean(), { minLength: MAX_LEDGER, maxLength: MAX_LEDGER }),
  forms: fc.record({ set: fc.constantFrom(...SET_FORMS), clear: fc.constantFrom(...CLEAR_FORMS) }),
  extra: fc.record({
    amountMinor: fc.oneof(
      { weight: 3, arbitrary: fc.integer({ min: 1, max: 5_000_000 }) },
      { weight: 1, arbitrary: fc.integer({ min: 1, max: 100 }) },
    ),
    category: fc.constantFrom(...CATEGORIES),
    otherDayIndex: fc.integer({ min: 0, max: 30 }),
  }),
  processTimeZone: fc.constantFrom(...PROCESS_TIME_ZONES),
});

const scenarioArb = fc
  .tuple(monthLedgerArb({ marks: 'mixed', maxExpenses: MAX_LEDGER }), extrasArb)
  .map(([ledger, extras]) => {
    const { month, localDate } = ledger;
    // The generator's own marks are booleans; rewrite them in the stored forms under test.
    const expenses = ledger.expenses.map((expense, index) => withMark(
      { ...expense, month, category: extras.categories[index % extras.categories.length] },
      expense.excludeFromDailyAllowance === true,
      extras.forms,
    ));
    return { month, localDate, expenses, ...extras };
  });

const COMPARED_ALLOWANCE_FIELDS = Object.freeze([
  'daysRemainingInclusive', 'todaySpentMinor', 'allowanceBasisMinor', 'todayAllowanceMinor',
  'leftTodayMinor', 'overTodayMinor', 'usedPermille', 'zeroReason', 'usedBeyondBudgetMinor',
  'countedExpenseIds', 'rounding',
]);

function fieldsOf(allowance, fields) {
  return Object.fromEntries(fields.map((field) => [field, allowance[field]]));
}

function referencedIds(refs) {
  return refs.map((ref) => Number(ref.split(':')[1]));
}

/** Checks a result against the independent reference, including the three-group partition. */
function assertMatchesReference({ plan, allowance, reference }) {
  const r = reference;
  // Plan values the mark must never reach.
  assert.equal(BigInt(plan.spendableBudgetMinor), r.spendable);
  assert.equal(BigInt(plan.applicableExpensesTotalMinor), r.totalMinor);
  assert.equal(BigInt(plan.needsSpentMinor) + BigInt(plan.wantsSpentMinor), r.totalMinor);
  assert.equal(BigInt(plan.remainingSpendableMinor), r.remaining);
  assert.equal(BigInt(plan.dailySpendingGuideMinor), r.guide);
  assert.equal(BigInt(plan.projectedSavingsMinor), r.projectedSavings);

  // Today values.
  assert.equal(BigInt(allowance.todaySpentMinor), r.countedMinor);
  assert.equal(BigInt(allowance.allowanceBasisMinor), r.basis);
  assert.equal(BigInt(allowance.todayAllowanceMinor), r.allowance);
  assert.equal(BigInt(allowance.leftTodayMinor), r.left);
  assert.equal(BigInt(allowance.remainingSpendableMinor), r.remaining);
  assert.equal(BigInt(allowance.dailySpendingGuideMinor), r.guide);

  // Reported count and total of the marked expenses dated Today.
  assert.equal(allowance.excludedToday.count, r.groups.excluded.length);
  assert.equal(BigInt(allowance.excludedToday.totalMinor), r.excludedMinor);
  assert.deepStrictEqual(sortedIds(allowance.countedExpenseIds), sortedIds(r.groups.counted.map((e) => e.id)));
  assert.deepStrictEqual(
    sortedIds(allowance.excludedTodayExpenseIds),
    sortedIds(r.groups.excluded.map((e) => e.id)),
  );

  // Partition: every expense is in exactly one group, and the amounts sum to total spending.
  const step = allowance.operations.find((operation) => operation.stage === 'expenses_used');
  const parts = step.intermediateResults;
  assert.equal(BigInt(parts.countedToday.amountMinor), r.countedMinor);
  assert.equal(BigInt(parts.excludedToday.amountMinor), r.excludedMinor);
  assert.equal(BigInt(parts.otherDays.amountMinor), r.otherMinor);
  assert.equal(BigInt(step.result.amountMinor), r.totalMinor);
  assert.equal(r.countedMinor + r.excludedMinor + r.otherMinor, r.totalMinor);
  const counted = referencedIds(step.countedExpenseRefs);
  const excluded = referencedIds(step.excludedTodayExpenseRefs);
  const other = referencedIds(step.otherExpenseRefs);
  assert.deepStrictEqual(
    sortedIds([...counted, ...excluded, ...other]),
    sortedIds([...r.groups.counted, ...r.groups.excluded, ...r.groups.other].map((e) => e.id)),
  );
  assert.deepStrictEqual(sortedIds(other), sortedIds(r.groups.other.map((e) => e.id)));
}

/* ------------------------------------------------------------ properties */

test('Property 15: setting or clearing the mark changes only the Today values', async () => {
  const seen = {
    markedToday: 0, countedToday: 0, otherDay: 0, maskChangesToday: 0, maskChangesOther: 0, positive: 0,
  };
  await assertProperty(fc.property(scenarioArb, (scenario) => {
    const { forms, mask, processTimeZone } = scenario;
    withProcessTimeZone(processTimeZone, () => {
      const isToday = (expense) => referenceDate(expense) === scenario.localDate;
      const { expenses } = scenario;

      const unmarked = expenses.map((expense) => withMark(expense, false, forms));
      const allMarked = expenses.map((expense) => withMark(expense, true, forms));
      const masked = expenses.map((expense, index) => withMark(expense, mask[index], forms));
      // Toggle the mark of every expense not dated Today and leave the rest.
      const toggledOthers = expenses.map((expense) => (isToday(expense)
        ? expense
        : withMark(expense, !referenceMarked(expense), forms)));
      // No mark property at all: the plan must not read it.
      const stripped = expenses.map(withoutMarkProperty);

      const base = evaluate(scenario, expenses);
      const cleared = evaluate(scenario, unmarked);
      const set = evaluate(scenario, allMarked);
      const partial = evaluate(scenario, masked);
      const others = evaluate(scenario, toggledOthers);
      const bare = evaluate(scenario, stripped);

      for (const result of [base, cleared, set, partial, others, bare]) assertMatchesReference(result);

      // Totals, buckets, categories, projections, and the guide: the whole plan is identical.
      for (const result of [cleared, set, partial, others]) {
        assert.deepStrictEqual(result.plan, bare.plan);
      }
      assert.deepStrictEqual(base.plan, bare.plan);

      // The same Today_Allowance inputs give the same days and guide whatever the marks.
      for (const result of [base, cleared, set, partial, others]) {
        assert.equal(result.allowance.daysRemainingInclusive, bare.allowance.daysRemainingInclusive);
        assert.equal(result.allowance.dailySpendingGuideMinor, bare.allowance.dailySpendingGuideMinor);
        assert.equal(result.allowance.remainingSpendableMinor, bare.allowance.remainingSpendableMinor);
        assert.equal(result.allowance.spendableBudgetMinor, bare.allowance.spendableBudgetMinor);
        assert.equal(result.allowance.largeEntryThresholdMinor, bare.allowance.largeEntryThresholdMinor);
      }

      // The mark on an expense dated Today moves its amount between Today_Spent and the marked total.
      assert.equal(set.allowance.todaySpentMinor, 0);
      assert.deepStrictEqual(set.allowance.countedExpenseIds, []);
      assert.equal(set.allowance.excludedToday.totalMinor, cleared.allowance.todaySpentMinor);
      assert.equal(set.allowance.excludedToday.count, cleared.allowance.countedExpenseIds.length);
      assert.equal(cleared.allowance.excludedToday.count, 0);
      assert.equal(cleared.allowance.excludedToday.totalMinor, 0);

      // A mark on an expense dated on another day changes nothing about Today.
      assert.deepStrictEqual(
        fieldsOf(others.allowance, [...COMPARED_ALLOWANCE_FIELDS, 'excludedToday', 'excludedTodayExpenseIds']),
        fieldsOf(base.allowance, [...COMPARED_ALLOWANCE_FIELDS, 'excludedToday', 'excludedTodayExpenseIds']),
      );
      assert.equal(others.allowance.todayAllowanceMinor, base.allowance.todayAllowanceMinor);

      for (const expense of expenses) {
        if (isToday(expense)) seen[referenceMarked(expense) ? 'markedToday' : 'countedToday'] += 1;
        else seen.otherDay += 1;
      }
      if (set.allowance.todayAllowanceMinor !== cleared.allowance.todayAllowanceMinor) seen.maskChangesToday += 1;
      if (expenses.some((expense) => !isToday(expense))) seen.maskChangesOther += 1;
      if (base.allowance.todayAllowanceMinor > 0) seen.positive += 1;
    });
  }), { numRuns: NUM_RUNS });

  assert.ok(seen.markedToday > 0, 'marked expenses dated Today were generated');
  assert.ok(seen.countedToday > 0, 'counted expenses dated Today were generated');
  assert.ok(seen.otherDay > 0, 'expenses dated on other days were generated');
  assert.ok(seen.maskChangesToday > 0, 'the mark changed Today_Allowance for some ledger');
  assert.ok(seen.maskChangesOther > 0, 'marks on other days were toggled in some ledger');
  assert.ok(seen.positive > 0, 'positive allowances were generated');
});

test('Property 15: a marked expense dated Today lowers the allowance like the same expense on another day', async () => {
  const seen = { markedPositive: 0, lowered: 0, countedLower: 0 };
  await assertProperty(fc.property(scenarioArb, (scenario) => {
    const { forms, extra, localDate, month, processTimeZone } = scenario;
    withProcessTimeZone(processTimeZone, () => {
      const otherDate = otherDayOf(localDate, extra.otherDayIndex);
      assert.notEqual(otherDate, localDate);
      const entry = (spentOn, marked) => withMark({
        id: EXTRA_ID,
        month,
        category: extra.category,
        amountMinor: extra.amountMinor,
        spentOn,
        createdAt: null,
      }, marked, forms);
      // The ledger without the entry is the common starting point.
      const ledger = scenario.expenses.map((expense) => withMark(expense, referenceMarked(expense), forms));

      const without = evaluate(scenario, ledger);
      const markedToday = evaluate(scenario, [...ledger, entry(localDate, true)]);
      const unmarkedToday = evaluate(scenario, [...ledger, entry(localDate, false)]);
      const markedOther = evaluate(scenario, [...ledger, entry(otherDate, true)]);
      const unmarkedOther = evaluate(scenario, [...ledger, entry(otherDate, false)]);
      for (const result of [without, markedToday, unmarkedToday, markedOther, unmarkedOther]) {
        assertMatchesReference(result);
      }

      // The entry reaches the monthly totals the same way in all four forms.
      assert.deepStrictEqual(markedToday.plan, unmarkedToday.plan);
      assert.deepStrictEqual(markedToday.plan, markedOther.plan);
      assert.deepStrictEqual(markedToday.plan, unmarkedOther.plan);

      // Marked and dated Today equals unmarked on another day, in every Today value.
      const today = (result) => fieldsOf(result.allowance, COMPARED_ALLOWANCE_FIELDS);
      assert.deepStrictEqual(today(markedToday), today(unmarkedOther));
      assert.deepStrictEqual(today(markedToday), today(markedOther));

      // Both lower the allowance basis by exactly the amount and leave Today_Spent as it was.
      const a = extra.amountMinor;
      assert.equal(markedToday.allowance.todaySpentMinor, without.allowance.todaySpentMinor);
      assert.equal(markedToday.allowance.allowanceBasisMinor, without.allowance.allowanceBasisMinor - a);
      assert.equal(unmarkedOther.allowance.allowanceBasisMinor, without.allowance.allowanceBasisMinor - a);
      assert.ok(markedToday.allowance.todayAllowanceMinor <= without.allowance.todayAllowanceMinor);

      // Counting the same expense is the one difference: Today_Spent rises by the amount and the
      // basis returns to its value without the entry.
      assert.equal(unmarkedToday.allowance.todaySpentMinor, without.allowance.todaySpentMinor + a);
      assert.equal(unmarkedToday.allowance.allowanceBasisMinor, without.allowance.allowanceBasisMinor);
      assert.equal(unmarkedToday.allowance.todayAllowanceMinor, without.allowance.todayAllowanceMinor);

      // The reported count and total of marked expenses dated Today include only the marked Today entry.
      assert.equal(markedToday.allowance.excludedToday.count, without.allowance.excludedToday.count + 1);
      assert.equal(markedToday.allowance.excludedToday.totalMinor, without.allowance.excludedToday.totalMinor + a);
      for (const result of [unmarkedToday, markedOther, unmarkedOther]) {
        assert.deepStrictEqual(result.allowance.excludedToday, without.allowance.excludedToday);
      }
      assert.ok(markedToday.allowance.excludedTodayExpenseIds.includes(EXTRA_ID));
      assert.ok(!unmarkedOther.allowance.excludedTodayExpenseIds.includes(EXTRA_ID));
      assert.ok(unmarkedToday.allowance.countedExpenseIds.includes(EXTRA_ID));
      assert.ok(!markedToday.allowance.countedExpenseIds.includes(EXTRA_ID));

      if (markedToday.allowance.todayAllowanceMinor > 0) seen.markedPositive += 1;
      if (markedToday.allowance.todayAllowanceMinor < without.allowance.todayAllowanceMinor) seen.lowered += 1;
      if (unmarkedToday.allowance.leftTodayMinor < without.allowance.leftTodayMinor) seen.countedLower += 1;
    });
  }), { numRuns: NUM_RUNS });

  assert.ok(seen.markedPositive > 0, 'positive allowances were generated');
  assert.ok(seen.lowered > 0, 'the marked expense lowered the allowance in some ledger');
  assert.ok(seen.countedLower > 0, 'the counted expense lowered Left_Today in some ledger');
});

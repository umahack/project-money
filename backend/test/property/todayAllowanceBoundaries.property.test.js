import '../helpers/blockingStdout.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { calculateMonthlyPlan } from '../../src/domain/monthlyPlan.js';
import {
  calculateTodayAllowance,
  LARGE_ENTRY_FLOOR_MINOR,
  LARGE_ENTRY_PERCENT,
} from '../../src/domain/allowance.js';
import { kolkataDateOf, kolkataMonthOf } from '../../src/domain/kolkataTime.js';
import { assertProperty } from '../helpers/propertyReport.js';
import {
  addDays,
  daysInMonth,
  formatIsoDate,
  kolkataDateOf as referenceDateOf,
  kolkataMonthOf as referenceMonthOf,
  kolkataParts,
  parseIsoDate,
  withProcessTimeZone,
} from '../helpers/kolkataReference.js';
import {
  anyRealDateArb,
  kolkataInstantArb,
  validDateArb,
} from '../helpers/quickAddGenerators.js';

// Feature: quick-add-daily-answer, Property 16: Calendar, rounding, and boundary rules hold
// Validates: Requirements 10.2, 10.11, 10.12, 10.13, 10.14, 10.15, 10.23, 10.24
//
// The reference below is independent of allowance.js and kolkataTime.js. It
// reads instants through Intl with an explicit Asia/Kolkata zone, counts the
// days remaining by stepping the calendar one day at a time, and does every
// division with BigInt. The sibling properties 12, 13 and 15 cover the model,
// the counted-expense effect and the exclusion mark; this file covers the
// calendar edges, the rounding ties, the non-positive and zero cases, the
// safe-integer extremes and the not-current-month result.

const NUM_RUNS = 200;
const KOLKATA = 'Asia/Kolkata';
const MAX = Number.MAX_SAFE_INTEGER;
const PROCESS_TIME_ZONES = Object.freeze([
  'UTC', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Asia/Kolkata', 'Australia/Lord_Howe', 'Pacific/Pago_Pago',
]);

/* ------------------------------------------------------------- reference */

function halfUp(numerator, denominator) {
  let quotient = numerator / denominator;
  if ((numerator % denominator) * 2n >= denominator) quotient += 1n;
  return quotient;
}

/** Days from `date` through the last day of its month, found by stepping one day at a time. */
function referenceDaysRemaining(date) {
  const month = date.slice(0, 7);
  let count = 0;
  let cursor = date;
  while (cursor.startsWith(month)) {
    count += 1;
    cursor = addDays(cursor, 1);
  }
  return count;
}

function referenceMonthLength(month) {
  return referenceDaysRemaining(`${month}-01`);
}

/** Everything Property 16 states about a calculation, from BigInt arithmetic. */
function referenceBoundaries({ spendable, remaining, counted, excluded, days }) {
  const spent = counted.reduce((sum, amount) => sum + BigInt(amount), 0n);
  const basis = BigInt(remaining) + spent;
  const divisor = BigInt(days);
  const allowance = basis <= 0n ? 0n : halfUp(basis, divisor);
  let zeroReason = null;
  if (allowance === 0n) {
    if (spendable === 0) zeroReason = 'no_spendable_budget';
    else if (basis <= 0n) zeroReason = 'month_budget_used';
    else zeroReason = 'below_minimum_unit';
  }
  let usedPermille = null;
  if (allowance > 0n) {
    const ratio = halfUp(spent * 1000n, allowance);
    usedPermille = Number(ratio > 1000n ? 1000n : ratio);
  }
  let threshold = null;
  if (spendable > 0) {
    const quarter = halfUp(BigInt(spendable) * 25n, 100n);
    threshold = Number(quarter > 100000n ? quarter : 100000n);
  }
  return {
    basis: Number(basis),
    allowance: Number(allowance),
    left: Number(allowance - spent),
    over: Number(allowance - spent < 0n ? spent - allowance : 0n),
    zeroReason,
    usedBeyond: Number(basis < 0n ? -basis : 0n),
    usedPermille,
    threshold,
    roundingDirection: basis <= 0n || basis % divisor === 0n ? 'exact' : 'half_up',
    excludedCount: excluded.length,
    excludedTotal: excluded.reduce((sum, amount) => sum + amount, 0),
  };
}

/* ------------------------------------------------------------ generators */

/** Years that stress the Gregorian leap rule, mixed with ordinary years. */
const leapRuleYearArb = fc.constantFrom(1900, 2000, 2024, 2023, 2025, 2028, 2096, 2100, 2200, 2400);

/** First or last day of a month, including February of century and leap years. */
const monthEdgeDateArb = fc
  .tuple(
    fc.oneof(leapRuleYearArb, fc.integer({ min: 1990, max: 2100 })),
    fc.oneof({ weight: 2, arbitrary: fc.constant(2) }, { weight: 3, arbitrary: fc.integer({ min: 1, max: 12 }) }),
    fc.boolean(),
  )
  .map(([year, month, last]) => formatIsoDate(year, month, last ? daysInMonth(year, month) : 1));

const calendarDateArb = fc.oneof(
  { weight: 2, arbitrary: monthEdgeDateArb },
  { weight: 3, arbitrary: anyRealDateArb },
  { weight: 1, arbitrary: validDateArb({ minYear: 1900, maxYear: 2400 }) },
);

/** Safe-integer extremes mixed with ordinary values. */
function boundedAmountArb(max) {
  return fc.oneof(
    { weight: 4, arbitrary: fc.integer({ min: 0, max: Math.min(max, 50_000) }) },
    { weight: 2, arbitrary: fc.integer({ min: 0, max: Math.min(max, 1_000_000_000) }) },
    { weight: 1, arbitrary: fc.integer({ min: 0, max }) },
    { weight: 1, arbitrary: fc.constantFrom(0, 1, 2, max, max - 1).filter((value) => value >= 0 && value <= max) },
  );
}

/** Each expense amount stays below an eighth of the safe range, so seven of them sum safely. */
const EXPENSE_CAP = Math.floor(MAX / 8);
const expenseAmountsArb = (maxItems) => fc.array(boundedAmountArb(EXPENSE_CAP), { minLength: 0, maxLength: maxItems });

/** Spendable_Budget values with the zero, floor-crossing, half-paise and extreme cases over-represented. */
const spendableArb = fc.oneof(
  { weight: 2, arbitrary: fc.integer({ min: 0, max: 2_000_000 }) },
  { weight: 2, arbitrary: fc.integer({ min: 0, max: MAX }) },
  // 25 percent is a half paise exactly when the budget is 2 more than a multiple of 4.
  { weight: 2, arbitrary: fc.integer({ min: 0, max: Math.floor((MAX - 2) / 4) }).map((k) => 4 * k + 2) },
  { weight: 1, arbitrary: fc.constantFrom(0, 0, 1, 2, 3, 4, 6, 399_996, 399_997, 399_998, 399_999, 400_000, 400_001, 400_002, 400_003, 400_004, MAX, MAX - 1, MAX - 2) },
);

const boundaryScenarioArb = fc.record({
  localDate: calendarDateArb,
  mode: fc.constantFrom('free', 'free', 'tie', 'tie', 'zeroBudget', 'billsOnly'),
  spendable: spendableArb,
  counted: expenseAmountsArb(3),
  excluded: expenseAmountsArb(2),
  other: expenseAmountsArb(2),
  quotient: fc.oneof(
    { weight: 3, arbitrary: fc.integer({ min: 0, max: 1_000_000 }) },
    { weight: 1, arbitrary: fc.integer({ min: 0, max: Math.floor(MAX / 2 / 31) }) },
  ),
  remainderShift: fc.constantFrom(-1, 0, 0, 1),
  dailyGuide: fc.constantFrom('present', 'absent'),
  processTimeZone: fc.constantFrom(...PROCESS_TIME_ZONES),
});

/**
 * Builds a coherent plan literal and the expenses behind it. A plan is coherent
 * when remaining = spendable - (every expense of the month). The tie mode picks
 * the Allowance_Basis directly as a multiple of the divisor plus half of it (or
 * one paise either side), so the half-paise quotients occur on purpose.
 */
function buildBoundaryScenario(generated) {
  const { localDate, mode, counted, excluded, other, quotient, remainderShift } = generated;
  const month = localDate.slice(0, 7);
  const days = referenceDaysRemaining(localDate);
  const sum = (items) => items.reduce((total, amount) => total + amount, 0);
  const expenseTotal = sum(counted) + sum(excluded) + sum(other);
  let spendable = generated.spendable;
  if (mode === 'zeroBudget') spendable = 0;
  if (mode === 'billsOnly') spendable = Math.min(spendable, expenseTotal);
  if (mode === 'tie') {
    const basis = (quotient * days) + Math.floor(days / 2) + remainderShift;
    spendable = Math.max(0, basis) + sum(excluded) + sum(other);
  }
  const remaining = spendable - expenseTotal;
  const otherDate = localDate.slice(0, 8) + String((Number(localDate.slice(8, 10)) % referenceMonthLength(month)) + 1).padStart(2, '0');
  let id = 0;
  const record = (amountMinor, spentOn, mark) => {
    id += 1;
    return { id, month, category: 'Food', amountMinor, spentOn, createdAt: null, excludeFromDailyAllowance: mark };
  };
  const expenses = [
    ...counted.map((amount) => record(amount, localDate, false)),
    ...excluded.map((amount) => record(amount, localDate, true)),
    ...other.map((amount) => record(amount, otherDate, false)),
  ];
  const plan = {
    period: { month, asOfDate: localDate, daysRemainingInclusive: days },
    spendableBudgetMinor: spendable,
    remainingSpendableMinor: remaining,
    ...(generated.dailyGuide === 'present' ? { dailySpendingGuideMinor: Math.trunc(remaining / days) } : {}),
  };
  return { month, localDate, days, spendable, remaining, expenses, plan };
}

/* ------------------------------------------------------------ properties */

test('Property 16: the Asia/Kolkata date follows the instant under any process time zone', async () => {
  const seen = { before: 0, atOrAfter: 0, exactMidnight: 0 };
  await assertProperty(fc.property(
    kolkataInstantArb(),
    fc.constantFrom(...PROCESS_TIME_ZONES),
    (instant, processTimeZone) => {
      const { midnightDate, offsetMs, instantMs, expectedDate } = instant;
      // The calendar day changes exactly at local midnight: before it the previous day, from it the day itself.
      const rolloverDate = offsetMs >= 0 ? midnightDate : addDays(midnightDate, -1);
      assert.equal(expectedDate, rolloverDate, 'the Intl reference agrees with the rollover rule');
      withProcessTimeZone(processTimeZone, () => {
        const wall = kolkataParts(instantMs);
        const offsetText = `${wall.date}T${String(wall.hour).padStart(2, '0')}:${String(wall.minute).padStart(2, '0')}:`
          + `${String(wall.second).padStart(2, '0')}+05:30`;
        for (const form of [instantMs, new Date(instantMs), new Date(instantMs).toISOString(), offsetText]) {
          assert.equal(kolkataDateOf(form), rolloverDate, `date of ${typeof form}`);
          assert.equal(kolkataMonthOf(form), rolloverDate.slice(0, 7), `month of ${typeof form}`);
        }
      });
      if (offsetMs < 0) seen.before += 1; else seen.atOrAfter += 1;
      if (offsetMs === 0) seen.exactMidnight += 1;
    },
  ), { numRuns: NUM_RUNS });
  assert.ok(seen.before > 0 && seen.atOrAfter > 0 && seen.exactMidnight > 0, 'both sides of midnight were generated');
});

test('Property 16: 18:30 UTC is Asia/Kolkata midnight, one millisecond earlier is still the old day', async () => {
  // Intl follows the historical zone rules, which were not +05:30 before 1945, so stay in the generator range.
  await assertProperty(fc.property(anyRealDateArb, fc.constantFrom(...PROCESS_TIME_ZONES), (date, processTimeZone) => {
    const { year, month, day } = parseIsoDate(date);
    const rolloverMs = Date.UTC(year, month - 1, day, 18, 30, 0, 0);
    const nextDay = addDays(date, 1);
    withProcessTimeZone(processTimeZone, () => {
      assert.equal(kolkataDateOf(rolloverMs), nextDay);
      assert.equal(kolkataDateOf(rolloverMs - 1), date);
      assert.equal(kolkataDateOf(`${date}T18:30:00Z`), nextDay);
      assert.equal(kolkataDateOf(`${date}T18:29:59.999Z`), date);
      assert.equal(kolkataDateOf(`${nextDay}T00:00:00+05:30`), nextDay);
      assert.equal(kolkataDateOf(`${nextDay}T00:00:00+05:30`), referenceDateOf(rolloverMs));
      assert.equal(kolkataMonthOf(rolloverMs), referenceMonthOf(rolloverMs));
    });
  }), { numRuns: NUM_RUNS });
});

test('Property 16: instants that are not valid, or lie beyond year 9999, have no Kolkata date', () => {
  // 9999-12-31T18:30:00Z is 10000-01-01 in Asia/Kolkata, past the four-digit year range.
  const lastValidMs = Date.UTC(9999, 11, 31, 18, 29, 59, 999);
  assert.equal(kolkataDateOf(lastValidMs), '9999-12-31');
  assert.equal(kolkataDateOf(lastValidMs + 1), null);
  for (const value of [MAX, -MAX, 8.64e15, 8.64e15 + 1, 1.5, Number.NaN, Infinity, new Date(Number.NaN), 'not-a-date', '', null, undefined, {}]) {
    assert.equal(kolkataDateOf(value), null, `no date for ${String(value)}`);
    assert.equal(kolkataMonthOf(value), null, `no month for ${String(value)}`);
  }
});

test('Property 16: days remaining is 1 on the last day, the month length on the first day, and counts down in between', async () => {
  const seen = { leapFebruary: 0, commonFebruary: 0, first: 0, last: 0 };
  await assertProperty(fc.property(calendarDateArb, fc.constantFrom(...PROCESS_TIME_ZONES), fc.integer({ min: 0, max: 2_000_000_000 }), (localDate, processTimeZone, salary) => {
    const month = localDate.slice(0, 7);
    const { year, month: monthNumber, day } = parseIsoDate(localDate);
    const length = referenceMonthLength(month);
    const expectedDays = referenceDaysRemaining(localDate);
    assert.equal(expectedDays, length - day + 1, 'the stepped count equals the month length arithmetic');
    const result = withProcessTimeZone(processTimeZone, () => {
      const plan = calculateMonthlyPlan({
        month,
        localDate,
        timeZone: KOLKATA,
        salaryEntries: [{ id: 1, month, amountMinor: salary }],
        bills: [],
        expenses: [],
        categoryTreatments: [],
      });
      assert.equal(plan.period.daysRemainingInclusive, expectedDays, 'the plan counts the same days');
      return calculateTodayAllowance({ month, localDate, plan, expenses: [] });
    });
    assert.equal(result.applicable, true);
    assert.equal(result.date, localDate);
    assert.equal(result.daysRemainingInclusive, expectedDays);
    if (day === 1) {
      assert.equal(result.daysRemainingInclusive, length, 'first day: the month length');
      seen.first += 1;
    }
    if (day === length) {
      assert.equal(result.daysRemainingInclusive, 1, 'last day: one day');
      // With one day left the whole remaining amount is available today.
      assert.equal(result.todayAllowanceMinor, Math.max(0, result.remainingSpendableMinor));
      seen.last += 1;
    }
    if (monthNumber === 2) {
      assert.equal(length, (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28);
      if (length === 29) seen.leapFebruary += 1; else seen.commonFebruary += 1;
    }
  }), { numRuns: NUM_RUNS });
  assert.ok(seen.first > 0 && seen.last > 0, 'month starts and ends were generated');
  assert.ok(seen.leapFebruary > 0 && seen.commonFebruary > 0, 'both kinds of February were generated');
});

test('Property 16: the instant, the plan and the allowance agree on the day across the midnight rollover', async () => {
  await assertProperty(fc.property(kolkataInstantArb(), fc.constantFrom(...PROCESS_TIME_ZONES), (instant, processTimeZone) => {
    withProcessTimeZone(processTimeZone, () => {
      const localDate = kolkataDateOf(instant.iso);
      assert.equal(localDate, instant.expectedDate);
      const month = localDate.slice(0, 7);
      const plan = calculateMonthlyPlan({
        month,
        localDate,
        timeZone: KOLKATA,
        salaryEntries: [{ id: 1, month, amountMinor: 3_000_000 }],
        bills: [],
        expenses: [],
        categoryTreatments: [],
      });
      const result = calculateTodayAllowance({ month, localDate, plan, expenses: [] });
      assert.equal(result.date, instant.expectedDate);
      assert.equal(result.daysRemainingInclusive, referenceDaysRemaining(instant.expectedDate));
      assert.equal(
        result.todayAllowanceMinor,
        Number(halfUp(BigInt(plan.remainingSpendableMinor), BigInt(result.daysRemainingInclusive))),
      );
    });
  }), { numRuns: NUM_RUNS });
});

test('Property 16: rounding, zero reasons, progress bounds and the threshold match the BigInt reference', async () => {
  const seen = {
    tie: 0, positive: 0, monthUsed: 0, zeroBudget: 0, below: 0, permilleInside: 0, permilleCapped: 0,
    extremeBasis: 0, thresholdFloor: 0, thresholdPercent: 0, halfPaiseThreshold: 0,
  };
  await assertProperty(fc.property(boundaryScenarioArb, (generated) => {
    const built = buildBoundaryScenario(generated);
    const { month, localDate, days, spendable, remaining, expenses, plan } = built;
    const counted = expenses.filter((e) => e.spentOn === localDate && e.excludeFromDailyAllowance === false).map((e) => e.amountMinor);
    const excluded = expenses.filter((e) => e.spentOn === localDate && e.excludeFromDailyAllowance === true).map((e) => e.amountMinor);
    const expected = referenceBoundaries({ spendable, remaining, counted, excluded, days });
    const actual = withProcessTimeZone(generated.processTimeZone, () => calculateTodayAllowance({
      month, localDate, plan, expenses,
    }));

    assert.equal(actual.applicable, true);
    assert.equal(actual.daysRemainingInclusive, days);
    assert.equal(actual.allowanceBasisMinor, expected.basis);
    assert.equal(actual.todayAllowanceMinor, expected.allowance);
    assert.equal(actual.leftTodayMinor, expected.left);
    assert.equal(actual.overTodayMinor, expected.over);
    assert.equal(actual.zeroReason, expected.zeroReason);
    assert.equal(actual.usedBeyondBudgetMinor, expected.usedBeyond);
    assert.equal(actual.usedPermille, expected.usedPermille);
    assert.equal(actual.largeEntryThresholdMinor, expected.threshold);
    assert.equal(actual.rounding.direction, expected.roundingDirection);
    assert.deepStrictEqual(actual.excludedToday, { count: expected.excludedCount, totalMinor: expected.excludedTotal });

    // Requirement 10.11: a non-positive basis gives zero, the reason, and the amount used beyond the budget.
    if (expected.basis <= 0) {
      assert.equal(actual.todayAllowanceMinor, 0);
      assert.equal(actual.usedBeyondBudgetMinor, 0 - expected.basis);
      assert.equal(actual.zeroReason, spendable === 0 ? 'no_spendable_budget' : 'month_budget_used');
    }
    // Requirement 10.12: a zero Spendable_Budget gives zero and its own reason.
    if (spendable === 0) {
      assert.equal(actual.todayAllowanceMinor, 0);
      assert.equal(actual.zeroReason, 'no_spendable_budget');
      assert.equal(actual.largeEntryThresholdMinor, null);
      assert.equal(actual.usedPermille, null);
    }
    // Requirement 10.24: a whole number from 0 through 1000, absent exactly when the allowance is zero.
    if (actual.todayAllowanceMinor === 0) {
      assert.equal(actual.usedPermille, null);
    } else {
      assert.ok(Number.isInteger(actual.usedPermille) && actual.usedPermille >= 0 && actual.usedPermille <= 1000);
    }
    // Requirement 10.23: the greater of 25 percent (half-paise upward) and the floor, absent without a budget.
    if (spendable > 0) {
      assert.ok(actual.largeEntryThresholdMinor >= LARGE_ENTRY_FLOOR_MINOR);
      assert.ok(Number.isSafeInteger(actual.largeEntryThresholdMinor));
    }

    if (expected.roundingDirection === 'half_up' && (BigInt(expected.basis) % BigInt(days)) * 2n === BigInt(days)) seen.tie += 1;
    if (expected.allowance > 0) seen.positive += 1;
    if (expected.zeroReason === 'month_budget_used') seen.monthUsed += 1;
    if (expected.zeroReason === 'no_spendable_budget') seen.zeroBudget += 1;
    if (expected.zeroReason === 'below_minimum_unit') seen.below += 1;
    if (expected.usedPermille !== null && expected.usedPermille < 1000) seen.permilleInside += 1;
    if (expected.usedPermille === 1000) seen.permilleCapped += 1;
    if (Math.abs(expected.basis) > 2 ** 52) seen.extremeBasis += 1;
    if (expected.threshold === 100000) seen.thresholdFloor += 1;
    if (expected.threshold !== null && expected.threshold > 100000) seen.thresholdPercent += 1;
    if (spendable > 0 && spendable % 4 === 2) seen.halfPaiseThreshold += 1;
  }), { numRuns: 400 });
  for (const [name, count] of Object.entries(seen)) {
    assert.ok(count > 0, `the generator reached: ${name}`);
  }
});

test('Property 16: every exact half-paise quotient rounds upward and one paise less rounds down', () => {
  let ties = 0;
  for (const days of [28, 29, 30, 31, 2, 1]) {
    for (const quotient of [0, 1, 2, 9, 1000, 123_456_789, Math.floor(MAX / 2 / days)]) {
      for (const shift of [-1, 0, 1]) {
        // days is even for 28, 30 and 2: the basis q*days + days/2 is exactly q + 1/2.
        const basis = (quotient * days) + Math.floor(days / 2) + shift;
        if (basis <= 0) continue;
        const localDate = days === 31 ? '2026-01-01' : days === 30 ? '2026-04-01' : days === 29 ? '2024-02-01' : days === 28 ? '2026-02-01' : null;
        const date = localDate ?? (days === 2 ? '2026-04-29' : '2026-04-30');
        const month = date.slice(0, 7);
        const plan = {
          period: { month, asOfDate: date, daysRemainingInclusive: days },
          spendableBudgetMinor: MAX,
          remainingSpendableMinor: basis,
        };
        const result = calculateTodayAllowance({ month, localDate: date, plan, expenses: [] });
        const exactHalf = days % 2 === 0 && shift === 0;
        const expected = Number(halfUp(BigInt(basis), BigInt(days)));
        assert.equal(result.todayAllowanceMinor, expected, `basis ${basis} over ${days} days`);
        const floor = Math.floor(basis / days);
        if (exactHalf) {
          assert.equal(result.todayAllowanceMinor, floor + 1, 'an exact half rounds upward');
          assert.equal(result.rounding.direction, 'half_up');
          ties += 1;
        }
        if (days % 2 === 0 && shift === -1) {
          assert.equal(result.todayAllowanceMinor, floor, 'just under a half rounds down');
        }
      }
    }
  }
  assert.ok(ties > 20, 'exact half-paise quotients were exercised');
});

test('Property 16: Allowance_Progress is exact, bounded and overflow-free for every safe-integer amount', async () => {
  // d = 1 (the last day), so Today_Allowance equals the basis and the permille is a plain ratio.
  const seen = { tie: 0, capped: 0, inside: 0, huge: 0 };
  await assertProperty(fc.property(
    fc.oneof(
      { weight: 3, arbitrary: fc.integer({ min: 1, max: 5000 }) },
      { weight: 2, arbitrary: fc.integer({ min: 1, max: MAX }) },
      { weight: 1, arbitrary: fc.constantFrom(1, 2, 3, MAX, MAX - 1) },
    ),
    fc.oneof(
      { weight: 3, arbitrary: fc.integer({ min: 0, max: 6000 }) },
      { weight: 2, arbitrary: fc.integer({ min: 0, max: Math.floor(MAX / 2) }) },
      { weight: 1, arbitrary: fc.constantFrom(0, 1, 500, 1000, Math.floor(MAX / 2)) },
    ),
    fc.double({ min: 0, max: 1.5, noNaN: true }),
    (allowance, spentSeed, ratio) => {
      // Aim some cases at an exact half permille: spent * 1000 / allowance = k + 1/2.
      const spent = spentSeed > allowance && ratio < 1.2 ? Math.min(Math.floor(allowance * ratio), Math.floor(MAX / 2)) : Math.min(spentSeed, Math.floor(MAX / 2));
      const localDate = '2026-01-31';
      const plan = {
        period: { month: '2026-01', asOfDate: localDate, daysRemainingInclusive: 1 },
        spendableBudgetMinor: MAX,
        remainingSpendableMinor: allowance - spent,
      };
      const expenses = spent === 0 ? [] : [{
        id: 1, month: '2026-01', category: 'Food', amountMinor: spent, spentOn: localDate, createdAt: null, excludeFromDailyAllowance: false,
      }];
      const actual = calculateTodayAllowance({ month: '2026-01', localDate, plan, expenses });
      assert.equal(actual.todayAllowanceMinor, allowance);
      const exactRatio = halfUp(BigInt(spent) * 1000n, BigInt(allowance));
      const expected = Number(exactRatio > 1000n ? 1000n : exactRatio);
      assert.equal(actual.usedPermille, expected);
      assert.ok(Number.isInteger(actual.usedPermille) && actual.usedPermille >= 0 && actual.usedPermille <= 1000);
      if ((BigInt(spent) * 1000n) % BigInt(allowance) * 2n === BigInt(allowance)) seen.tie += 1;
      if (expected === 1000) seen.capped += 1; else seen.inside += 1;
      if (spent * 1000 > MAX) seen.huge += 1;
    },
  ), { numRuns: NUM_RUNS });
  assert.ok(seen.capped > 0 && seen.inside > 0 && seen.huge > 0, 'bounded, capped and above-2^53 products were generated');
  // Exact half permille cases by construction: allowance 2000 and spent 1 is 0.5, which rounds up to 1.
  for (const [allowance, spent, permille] of [[2000, 1, 1], [2000, 3, 2], [2000, 5, 3], [8, 1, 125], [16, 1, 63], [2000, 0, 0]]) {
    const plan = {
      period: { month: '2026-01', asOfDate: '2026-01-31', daysRemainingInclusive: 1 },
      spendableBudgetMinor: MAX,
      remainingSpendableMinor: allowance - spent,
    };
    const expenses = [{ id: 1, month: '2026-01', category: 'Food', amountMinor: spent, spentOn: '2026-01-31', createdAt: null, excludeFromDailyAllowance: false }];
    assert.equal(calculateTodayAllowance({ month: '2026-01', localDate: '2026-01-31', plan, expenses }).usedPermille, permille);
  }
});

test('Property 16: the Large_Entry_Threshold is the greater of 25 percent (half paise upward) and the floor', async () => {
  assert.equal(LARGE_ENTRY_PERCENT, 25);
  assert.equal(LARGE_ENTRY_FLOOR_MINOR, 100_000);
  await assertProperty(fc.property(spendableArb, fc.constantFrom('2026-01-31', '2026-02-01', '2024-02-29'), (spendable, localDate) => {
    const month = localDate.slice(0, 7);
    const days = referenceDaysRemaining(localDate);
    const plan = {
      period: { month, asOfDate: localDate, daysRemainingInclusive: days },
      spendableBudgetMinor: spendable,
      remainingSpendableMinor: spendable,
    };
    const { largeEntryThresholdMinor } = calculateTodayAllowance({ month, localDate, plan, expenses: [] });
    if (spendable === 0) {
      assert.equal(largeEntryThresholdMinor, null);
      return;
    }
    const quarter = BigInt(spendable) * 25n;
    const roundedUp = quarter / 100n + (quarter % 100n >= 50n ? 1n : 0n);
    assert.equal(largeEntryThresholdMinor, Number(roundedUp > 100_000n ? roundedUp : 100_000n));
    assert.ok(largeEntryThresholdMinor >= 100_000);
  }), { numRuns: NUM_RUNS });
  // Edges around the point where 25 percent meets the floor (a budget of 400,000 paise).
  const expectedAt = new Map([
    [1, 100_000], [399_997, 100_000], [399_998, 100_000], [399_999, 100_000], [400_000, 100_000],
    [400_001, 100_000], [400_002, 100_001], [400_003, 100_001], [400_006, 100_002], [MAX, 2_251_799_813_685_248],
  ]);
  for (const [spendable, threshold] of expectedAt) {
    const plan = {
      period: { month: '2026-01', asOfDate: '2026-01-31', daysRemainingInclusive: 1 },
      spendableBudgetMinor: spendable,
      remainingSpendableMinor: spendable,
    };
    assert.equal(
      calculateTodayAllowance({ month: '2026-01', localDate: '2026-01-31', plan, expenses: [] }).largeEntryThresholdMinor,
      threshold,
      `threshold for a budget of ${spendable}`,
    );
  }
});

test('Property 16: zero budget, zero remaining and negative remaining give a zero allowance with the right reason', async () => {
  await assertProperty(fc.property(
    calendarDateArb,
    fc.oneof(
      { weight: 2, arbitrary: fc.integer({ min: 0, max: 5_000_000 }) },
      { weight: 1, arbitrary: fc.constantFrom(0, 1, MAX) },
    ),
    fc.oneof(
      { weight: 2, arbitrary: fc.integer({ min: 0, max: 5_000_000 }) },
      { weight: 1, arbitrary: fc.constantFrom(0, 1, MAX) },
    ),
    fc.boolean(),
    (localDate, overBy, spentToday, zeroBudget) => {
      const month = localDate.slice(0, 7);
      const days = referenceDaysRemaining(localDate);
      const spent = Math.min(spentToday, Math.floor(MAX / 2));
      const excess = Math.min(overBy, Math.floor(MAX / 2));
      // Basis = remaining + spent = -excess  (zero when excess is zero), so the month was already used up.
      const remaining = -excess - spent;
      const spendable = zeroBudget ? 0 : 1000;
      const plan = {
        period: { month, asOfDate: localDate, daysRemainingInclusive: days },
        spendableBudgetMinor: spendable,
        remainingSpendableMinor: remaining,
      };
      const expenses = spent === 0 ? [] : [{
        id: 1, month, category: 'Food', amountMinor: spent, spentOn: localDate, createdAt: null, excludeFromDailyAllowance: false,
      }];
      const actual = calculateTodayAllowance({ month, localDate, plan, expenses });
      assert.equal(actual.allowanceBasisMinor, 0 - excess);
      assert.equal(actual.todayAllowanceMinor, 0);
      assert.equal(actual.usedBeyondBudgetMinor, excess);
      assert.equal(actual.zeroReason, zeroBudget ? 'no_spendable_budget' : 'month_budget_used');
      assert.equal(actual.leftTodayMinor, 0 - spent);
      assert.equal(actual.overTodayMinor, spent);
      assert.equal(actual.usedPermille, null);
      assert.equal(actual.rounding.direction, 'exact');
      assert.equal(actual.largeEntryThresholdMinor, zeroBudget ? null : 100_000);
    },
  ), { numRuns: NUM_RUNS });
});

test('Property 16: a positive basis too small to give one paise is a below-minimum zero, not a used-up month', () => {
  for (const days of [28, 29, 30, 31]) {
    const date = days === 31 ? '2026-01-01' : days === 30 ? '2026-04-01' : days === 29 ? '2024-02-01' : '2026-02-01';
    const month = date.slice(0, 7);
    for (let basis = 1; basis < Math.floor(days / 2); basis += 1) {
      const plan = {
        period: { month, asOfDate: date, daysRemainingInclusive: days },
        spendableBudgetMinor: 1000,
        remainingSpendableMinor: basis,
      };
      const result = calculateTodayAllowance({ month, localDate: date, plan, expenses: [] });
      assert.equal(result.todayAllowanceMinor, 0);
      assert.equal(result.zeroReason, 'below_minimum_unit');
      assert.equal(result.usedBeyondBudgetMinor, 0);
      assert.equal(result.usedPermille, null);
    }
  }
});

test('Property 16: a month other than the month of the local date is not applicable and reads nothing else', async () => {
  await assertProperty(fc.property(
    calendarDateArb,
    fc.integer({ min: -40, max: 40 }).filter((shift) => shift !== 0),
    fc.constantFrom('absent', 'garbage', 'plan'),
    (localDate, shift, planKind) => {
      const { year, month } = parseIsoDate(localDate);
      const index = (year * 12) + (month - 1) + shift;
      const otherMonth = `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`;
      assert.notEqual(otherMonth, localDate.slice(0, 7));
      const plan = planKind === 'absent'
        ? undefined
        : planKind === 'garbage'
          ? { period: null, spendableBudgetMinor: 'x' }
          : {
            period: { month: otherMonth, asOfDate: localDate, daysRemainingInclusive: 5 },
            spendableBudgetMinor: 1000,
            remainingSpendableMinor: 1000,
          };
      const expenses = planKind === 'garbage' ? 'not-an-array' : [{ id: 1, amountMinor: 'bad' }];
      assert.deepStrictEqual(
        calculateTodayAllowance({ month: otherMonth, localDate, plan, expenses }),
        { applicable: false, reason: 'not_current_month' },
      );
    },
  ), { numRuns: NUM_RUNS });
});

test('Property 16: safe-integer extremes in the plan are exact', () => {
  const lastDay = '2026-01-31';
  const firstDay = '2026-01-01';
  const run = (localDate, spendable, remaining, expenses = []) => {
    const month = localDate.slice(0, 7);
    const days = referenceDaysRemaining(localDate);
    const plan = {
      period: { month, asOfDate: localDate, daysRemainingInclusive: days },
      spendableBudgetMinor: spendable,
      remainingSpendableMinor: remaining,
    };
    return { days, result: calculateTodayAllowance({ month, localDate, plan, expenses }) };
  };

  // The largest basis, on the last day and on the first day (31 days remaining).
  let { result } = run(lastDay, MAX, MAX);
  assert.equal(result.todayAllowanceMinor, MAX);
  assert.equal(result.leftTodayMinor, MAX);
  assert.equal(result.usedPermille, 0);
  assert.equal(result.largeEntryThresholdMinor, Number(halfUp(BigInt(MAX) * 25n, 100n)));
  ({ result } = run(firstDay, MAX, MAX));
  assert.equal(result.daysRemainingInclusive, 31);
  assert.equal(result.todayAllowanceMinor, Number(halfUp(BigInt(MAX), 31n)));

  // The most negative remaining amount: zero allowance and the full amount used beyond the budget.
  ({ result } = run(firstDay, 0, -MAX));
  assert.equal(result.todayAllowanceMinor, 0);
  assert.equal(result.zeroReason, 'no_spendable_budget');
  assert.equal(result.usedBeyondBudgetMinor, MAX);
  ({ result } = run(firstDay, 1000, -MAX));
  assert.equal(result.zeroReason, 'month_budget_used');
  assert.equal(result.usedBeyondBudgetMinor, MAX);
  assert.equal(result.usedPermille, null);

  // A large counted amount against a large allowance: the product with 1000 is far beyond 2^53.
  const big = Math.floor(MAX / 2);
  ({ result } = run(lastDay, MAX, big - 1, [{
    id: 1, month: '2026-01', category: 'Food', amountMinor: big, spentOn: lastDay, createdAt: null, excludeFromDailyAllowance: false,
  }]));
  assert.equal(result.allowanceBasisMinor, (big - 1) + big);
  assert.equal(result.todayAllowanceMinor, (big - 1) + big);
  assert.equal(result.usedPermille, Number(halfUp(BigInt(big) * 1000n, BigInt((big - 1) + big))));
  assert.equal(result.leftTodayMinor, big - 1);
  assert.ok(result.usedPermille >= 0 && result.usedPermille <= 1000);

  // Spent far more than the allowance caps the permille at 1000 without overflow.
  ({ result } = run(firstDay, MAX, 0, [{
    id: 1, month: '2026-01', category: 'Food', amountMinor: big, spentOn: firstDay, createdAt: null, excludeFromDailyAllowance: false,
  }]));
  assert.equal(result.allowanceBasisMinor, big);
  assert.equal(result.todayAllowanceMinor, Number(halfUp(BigInt(big), 31n)));
  assert.equal(result.usedPermille, 1000);
  assert.equal(result.overTodayMinor, big - result.todayAllowanceMinor);
});

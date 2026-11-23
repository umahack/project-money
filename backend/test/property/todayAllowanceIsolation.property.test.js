import '../helpers/blockingStdout.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { ClarityService } from '../../src/services/clarityService.js';
import { assertProperty, MIN_PROPERTY_RUNS } from '../helpers/propertyReport.js';
import {
  daysInMonth,
  kolkataMidnightMs,
  parseIsoDate,
} from '../helpers/kolkataReference.js';
import { anyRealDateArb } from '../helpers/quickAddGenerators.js';

// Feature: quick-add-daily-answer, Property 14: Changes outside the counted set recalculate or are isolated
// Validates: Requirements 10.9, 10.10, 10.16, 17.17
//
// Every generated baseline contains a counted-Today expense, excluded-Today
// expenses, other-day expenses, malformed-date expenses, and expenses in an
// adjacent month. A mutable test repository implements the real repository
// contract and isolates each create, update, and delete branch. ClarityService
// and all of its production calculators are real. The reference below is
// independent: it derives the 50/30/20 allocation, monthly buckets, date
// attribution, and Today values directly from the generated records.

const RUNS = MIN_PROPERTY_RUNS;
const USER_ID = 745_001;
const KOLKATA = 'Asia/Kolkata';
const NOON_MS = 12 * 60 * 60 * 1000;
const CATEGORIES = Object.freeze(['Food', 'Shopping']);
const FAMILIES = Object.freeze(['excludedToday', 'otherDay', 'malformedDate', 'otherMonth']);
const MALFORMED_DATES = Object.freeze([
  'not-a-date',
  '2026-02-30',
  '2026-1-05',
  '15/01/2026',
  '2026-01-15T00:00:00Z',
]);
const TARGET_IDS = Object.freeze({
  excludedToday: [20, 21],
  otherDay: [30, 31],
  malformedDate: [40, 41],
  otherMonth: [50, 51],
});

function confirmedRecord(record = null) {
  return { status: 'confirmed', empty: record === null, record };
}

function confirmedCollection(records = []) {
  return { status: 'confirmed', empty: records.length === 0, records };
}

/**
 * Isolated repository seam for ClarityService. Mutations replace one private
 * ledger and increment its version; period reads expose only the requested
 * month, matching FinancialRepository's contract.
 */
class MutableTestRepository {
  #salaryMinor;
  #expenses;
  #version = 1;

  constructor({ salaryMinor, expenses }) {
    this.#salaryMinor = salaryMinor;
    this.#expenses = structuredClone(expenses);
  }

  replaceExpenses(expenses) {
    this.#expenses = structuredClone(expenses);
    this.#version += 1;
  }

  async getDataVersion(userId) {
    assert.equal(userId, USER_ID);
    return this.#version;
  }

  async loadPeriod({ userId, month }) {
    assert.equal(userId, USER_ID);
    const timestamp = `${month}-01T00:00:00.000Z`;
    return {
      status: 'confirmed',
      month,
      salary: confirmedRecord({
        id: 1,
        userId,
        month,
        amountMinor: this.#salaryMinor,
        createdAt: timestamp,
        updatedAt: timestamp,
        normalizationIssues: [],
      }),
      bills: confirmedCollection(),
      expenses: confirmedCollection(
        this.#expenses.filter((expense) => expense.month === month).map((expense) => structuredClone(expense)),
      ),
      categoryTreatments: confirmedCollection(),
    };
  }

  async loadGoals(userId) {
    assert.equal(userId, USER_ID);
    return confirmedCollection();
  }

  async listAccessibleTrips(userId) {
    assert.equal(userId, USER_ID);
    return confirmedCollection();
  }

  async loadAccessibleTripLedger() {
    throw new Error('No trip ledger is available in the isolated repository.');
  }
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function shiftMonth(month, delta) {
  const [year, monthNumber] = month.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, monthNumber - 1 + delta, 1));
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}`;
}

function otherDayOf(localDate) {
  const month = localDate.slice(0, 7);
  return localDate.endsWith('-01') ? `${month}-02` : `${month}-01`;
}

function createdAtFor(localDate, id) {
  return new Date(kolkataMidnightMs(localDate) + NOON_MS + id).toISOString();
}

function expenseRecord({
  id,
  month,
  localDate,
  amountMinor,
  category,
  spentOn,
  excludeFromDailyAllowance = false,
}) {
  const timestamp = createdAtFor(localDate, id);
  return {
    id,
    userId: USER_ID,
    month,
    category,
    note: null,
    spentOn,
    amountMinor,
    createdAt: timestamp,
    updatedAt: timestamp,
    excludeFromDailyAllowance,
    normalizationIssues: [],
  };
}

function familyRecord({
  family,
  id,
  amountMinor,
  category,
  localDate,
  otherMonth,
  malformedDate,
}) {
  const currentMonth = localDate.slice(0, 7);
  const common = { id, amountMinor, category, localDate };
  switch (family) {
    case 'excludedToday':
      return expenseRecord({
        ...common,
        month: currentMonth,
        spentOn: localDate,
        excludeFromDailyAllowance: true,
      });
    case 'otherDay':
      return expenseRecord({ ...common, month: currentMonth, spentOn: otherDayOf(localDate) });
    case 'malformedDate':
      return expenseRecord({ ...common, month: currentMonth, spentOn: malformedDate });
    case 'otherMonth':
      return expenseRecord({ ...common, month: otherMonth, spentOn: `${otherMonth}-15` });
    default:
      throw new RangeError(`Unknown generated family: ${family}`);
  }
}

function buildWorld(generated) {
  const localDate = generated.localDate;
  const currentMonth = localDate.slice(0, 7);
  const otherMonth = shiftMonth(currentMonth, generated.otherMonthDirection);
  const expenses = [expenseRecord({
    id: 10,
    month: currentMonth,
    localDate,
    amountMinor: generated.baselineAmounts[0],
    category: generated.baselineCategories[0],
    spentOn: localDate,
  })];

  let valueIndex = 1;
  for (const family of FAMILIES) {
    for (const id of TARGET_IDS[family]) {
      expenses.push(familyRecord({
        family,
        id,
        amountMinor: generated.baselineAmounts[valueIndex],
        category: generated.baselineCategories[valueIndex],
        localDate,
        otherMonth,
        malformedDate: generated.malformedDates[valueIndex % generated.malformedDates.length],
      }));
      valueIndex += 1;
    }
  }

  return {
    localDate,
    currentMonth,
    otherMonth,
    now: new Date(kolkataMidnightMs(localDate) + NOON_MS),
    salaryMinor: generated.salaryMinor,
    baseline: expenses,
  };
}

function snapshotInput(world, month = world.currentMonth) {
  return {
    userId: USER_ID,
    month,
    now: world.now,
    timeZone: KOLKATA,
  };
}

function halfUp(numerator, denominator) {
  const quotient = numerator / denominator;
  return numerator % denominator * 2n >= denominator ? quotient + 1n : quotient;
}

function divideHalfAwayFromZero(numerator, denominator) {
  return numerator < 0n ? -halfUp(-numerator, denominator) : halfUp(numerator, denominator);
}

function asOfDateFor(month, currentMonth, localDate) {
  if (month === currentMonth) return localDate;
  if (month > currentMonth) return `${month}-01`;
  const [year, monthNumber] = month.split('-').map(Number);
  return `${month}-${pad(daysInMonth(year, monthNumber))}`;
}

function isNeeds(category) {
  return category === 'Food';
}

function attributedDate(expense) {
  if (expense.spentOn !== null && expense.spentOn !== undefined && expense.spentOn !== '') {
    return typeof expense.spentOn === 'string' && parseIsoDate(expense.spentOn)
      ? expense.spentOn
      : null;
  }
  const instant = Date.parse(expense.createdAt);
  if (!Number.isFinite(instant)) return null;
  const shifted = new Date(instant + 19_800_000);
  return [
    shifted.getUTCFullYear(),
    pad(shifted.getUTCMonth() + 1),
    pad(shifted.getUTCDate()),
  ].join('-');
}

function sumAmounts(expenses) {
  return expenses.reduce((total, expense) => total + BigInt(expense.amountMinor), 0n);
}

/** Independent monthly and Today model for one requested snapshot month. */
function referenceSnapshot(world, ledger, month = world.currentMonth) {
  const localDate = asOfDateFor(month, world.currentMonth, world.localDate);
  const expenses = ledger.filter((expense) => expense.month === month).toSorted((a, b) => a.id - b.id);
  const salary = BigInt(world.salaryMinor);
  const needsBudget = halfUp(salary, 2n);
  const wantsBudget = halfUp(salary * 3n, 10n);
  const savingsTarget = salary - needsBudget - wantsBudget;
  const spendable = needsBudget + wantsBudget;
  const needsExpenses = expenses.filter((expense) => isNeeds(expense.category));
  const wantsExpenses = expenses.filter((expense) => !isNeeds(expense.category));
  const needsSpent = sumAmounts(needsExpenses);
  const wantsSpent = sumAmounts(wantsExpenses);
  const totalSpending = needsSpent + wantsSpent;
  const remaining = spendable - totalSpending;
  const [year, monthNumber, day] = localDate.split('-').map(Number);
  const daysRemaining = BigInt(daysInMonth(year, monthNumber) - day + 1);
  const dailyGuide = divideHalfAwayFromZero(remaining, daysRemaining);
  const projectedSavings = totalSpending >= salary ? 0n : salary - totalSpending;

  const categoryMap = new Map();
  for (const expense of expenses) {
    const value = categoryMap.get(expense.category) ?? { total: 0n, ids: [] };
    value.total += BigInt(expense.amountMinor);
    value.ids.push(expense.id);
    categoryMap.set(expense.category, value);
  }
  const categoryTotals = [...categoryMap.entries()]
    .sort(([left], [right]) => left.toLocaleLowerCase('en-IN').localeCompare(right.toLocaleLowerCase('en-IN')))
    .map(([category, value]) => ({ category, total: value.total, ids: value.ids }));

  const counted = expenses.filter((expense) => (
    attributedDate(expense) === localDate && expense.excludeFromDailyAllowance !== true
  ));
  const excluded = expenses.filter((expense) => (
    attributedDate(expense) === localDate && expense.excludeFromDailyAllowance === true
  ));
  const todaySpent = sumAmounts(counted);
  const allowanceBasis = remaining + todaySpent;
  const todayAllowance = allowanceBasis <= 0n ? 0n : halfUp(allowanceBasis, daysRemaining);
  const leftToday = todayAllowance - todaySpent;

  return {
    month,
    localDate,
    daysRemaining: Number(daysRemaining),
    salary,
    needsBudget,
    wantsBudget,
    savingsTarget,
    spendable,
    needsSpent,
    wantsSpent,
    totalSpending,
    remaining,
    dailyGuide,
    projectedSavings,
    categoryTotals,
    todaySpent,
    allowanceBasis,
    todayAllowance,
    leftToday,
    overToday: leftToday < 0n ? -leftToday : 0n,
    excludedCount: excluded.length,
    excludedTotal: sumAmounts(excluded),
  };
}

function amountOf(value) {
  assert.deepStrictEqual(value.currency, 'INR');
  return BigInt(value.amountMinor);
}

function assertSnapshotMatchesReference(snapshot, expected, { todayApplicable = true } = {}) {
  const monthly = snapshot.outcomes.monthlyPlan;
  const spending = snapshot.outcomes.spending;
  assert.equal(monthly.status, 'available');
  assert.equal(spending.status, 'available');

  assert.equal(amountOf(monthly.value.salary), expected.salary);
  assert.equal(amountOf(monthly.value.needsBudget), expected.needsBudget);
  assert.equal(amountOf(monthly.value.wantsBudget), expected.wantsBudget);
  assert.equal(amountOf(monthly.value.savingsTarget), expected.savingsTarget);
  assert.equal(amountOf(monthly.value.spendableBudget), expected.spendable);
  assert.equal(amountOf(monthly.value.needsSpent), expected.needsSpent);
  assert.equal(amountOf(monthly.value.wantsSpent), expected.wantsSpent);
  assert.equal(amountOf(monthly.value.remainingSpendable), expected.remaining);
  assert.equal(amountOf(monthly.value.dailySpendingGuide), expected.dailyGuide);
  assert.equal(amountOf(monthly.value.projectedSavings), expected.projectedSavings);

  assert.equal(spending.value.month, expected.month);
  assert.equal(amountOf(spending.value.needsBudget), expected.needsBudget);
  assert.equal(amountOf(spending.value.wantsBudget), expected.wantsBudget);
  assert.equal(amountOf(spending.value.needsSpent), expected.needsSpent);
  assert.equal(amountOf(spending.value.wantsSpent), expected.wantsSpent);
  assert.equal(amountOf(spending.value.totalSpending), expected.totalSpending);
  assert.equal(amountOf(spending.value.spendableBudget), expected.spendable);
  assert.equal(amountOf(spending.value.remainingSpendable), expected.remaining);
  assert.equal(amountOf(spending.value.dailySpendingGuide), expected.dailyGuide);
  assert.equal(amountOf(spending.value.savingsTarget), expected.savingsTarget);
  assert.equal(amountOf(spending.value.projectedSavings), expected.projectedSavings);
  assert.deepStrictEqual(
    spending.value.categoryTotals.map((total) => ({
      category: total.category,
      total: amountOf(total.total),
      ids: total.expenseIds,
    })),
    expected.categoryTotals,
  );

  const today = snapshot.outcomes.todayAllowance;
  assert.equal(today.status, 'available');
  if (!todayApplicable) {
    assert.deepStrictEqual(today.value, { applicable: false, reason: 'not_current_month' });
    assert.equal(Object.hasOwn(today, 'explanationRef'), false);
    return;
  }

  assert.equal(today.value.applicable, true);
  assert.equal(today.value.date, expected.localDate);
  assert.equal(today.value.daysRemainingInclusive, expected.daysRemaining);
  assert.equal(amountOf(today.value.todaySpent), expected.todaySpent);
  assert.equal(amountOf(today.value.allowanceBasis), expected.allowanceBasis);
  assert.equal(amountOf(today.value.todayAllowance), expected.todayAllowance);
  assert.equal(amountOf(today.value.leftToday), expected.leftToday);
  assert.equal(amountOf(today.value.overToday), expected.overToday);
  assert.equal(today.value.excludedToday.count, expected.excludedCount);
  assert.equal(amountOf(today.value.excludedToday.total), expected.excludedTotal);
}

function currentValues(snapshot) {
  const value = snapshot.outcomes.todayAllowance.value;
  return {
    todaySpent: value.todaySpent,
    allowanceBasis: value.allowanceBasis,
    todayAllowance: value.todayAllowance,
    leftToday: value.leftToday,
    excludedToday: value.excludedToday,
  };
}

function branchFor(world, generated, family, operation) {
  let ledger = structuredClone(world.baseline);
  let amountDelta;
  let excludedCountDelta = 0;
  const familyIndex = FAMILIES.indexOf(family);

  if (operation === 'create') {
    const record = familyRecord({
      family,
      id: 100 + familyIndex,
      amountMinor: generated.createAmounts[familyIndex],
      category: generated.createCategories[familyIndex],
      localDate: world.localDate,
      otherMonth: world.otherMonth,
      malformedDate: generated.malformedDates[familyIndex % generated.malformedDates.length],
    });
    ledger.push(record);
    amountDelta = record.amountMinor;
    if (family === 'excludedToday') excludedCountDelta = 1;
  } else if (operation === 'update') {
    const targetId = TARGET_IDS[family][0];
    const target = ledger.find((expense) => expense.id === targetId);
    const nextAmount = target.amountMinor + generated.updateIncreases[familyIndex];
    amountDelta = nextAmount - target.amountMinor;
    ledger = ledger.map((expense) => (expense.id === targetId
      ? {
          ...expense,
          amountMinor: nextAmount,
          category: expense.category === 'Food' ? 'Shopping' : 'Food',
          updatedAt: createdAtFor(world.localDate, 500 + targetId),
        }
      : expense));
  } else {
    const targetId = TARGET_IDS[family][1];
    const target = ledger.find((expense) => expense.id === targetId);
    amountDelta = -target.amountMinor;
    if (family === 'excludedToday') excludedCountDelta = -1;
    ledger = ledger.filter((expense) => expense.id !== targetId);
  }

  return { ledger, amountDelta, excludedCountDelta };
}

const scenarioArb = fc.record({
  localDate: anyRealDateArb,
  salaryMinor: fc.oneof(
    { weight: 3, arbitrary: fc.integer({ min: 100_000, max: 5_000_000 }) },
    { weight: 1, arbitrary: fc.integer({ min: 1, max: 10_000 }) },
  ),
  otherMonthDirection: fc.constantFrom(-1, 1),
  baselineAmounts: fc.array(fc.integer({ min: 1, max: 1_000_000 }), { minLength: 9, maxLength: 9 }),
  baselineCategories: fc.array(fc.constantFrom(...CATEGORIES), { minLength: 9, maxLength: 9 }),
  createAmounts: fc.array(fc.integer({ min: 1, max: 1_000_000 }), { minLength: 4, maxLength: 4 }),
  createCategories: fc.array(fc.constantFrom(...CATEGORIES), { minLength: 4, maxLength: 4 }),
  updateIncreases: fc.array(fc.integer({ min: 1, max: 500_000 }), { minLength: 4, maxLength: 4 }),
  malformedDates: fc.array(fc.constantFrom(...MALFORMED_DATES), { minLength: 4, maxLength: 4 }),
});

test('Property 14: non-counted changes recalculate the current month or stay isolated by month', async () => {
  const coverage = {
    cases: 0,
    currentSnapshots: 0,
    nonCurrentSnapshots: 0,
    creates: 0,
    updates: 0,
    deletes: 0,
    excludedChanges: 0,
    otherDayChanges: 0,
    malformedChanges: 0,
    otherMonthChanges: 0,
  };

  await assertProperty(fc.asyncProperty(scenarioArb, async (generated) => {
    coverage.cases += 1;
    const world = buildWorld(generated);
    const repository = new MutableTestRepository({
      salaryMinor: world.salaryMinor,
      expenses: world.baseline,
    });
    const service = new ClarityService({ repository });
    const baselineExpected = referenceSnapshot(world, world.baseline);
    const baseline = await service.getSnapshot(snapshotInput(world));
    coverage.currentSnapshots += 1;
    assertSnapshotMatchesReference(baseline, baselineExpected);

    for (const family of FAMILIES) {
      for (const operation of ['create', 'update', 'delete']) {
        const branch = branchFor(world, generated, family, operation);
        repository.replaceExpenses(branch.ledger);
        const actual = await service.getSnapshot(snapshotInput(world));
        const expected = referenceSnapshot(world, branch.ledger);
        coverage.currentSnapshots += 1;
        coverage[`${operation}s`] += 1;
        coverage[`${family === 'excludedToday' ? 'excluded' : family.replace('Date', '')}Changes`] += 1;

        assertSnapshotMatchesReference(actual, expected);
        assert.deepStrictEqual(
          actual.outcomes.todayAllowance.value.todaySpent,
          baseline.outcomes.todayAllowance.value.todaySpent,
        );

        if (family === 'otherMonth') {
          assert.deepStrictEqual(currentValues(actual), currentValues(baseline));
          assert.deepStrictEqual(actual.outcomes.monthlyPlan.value, baseline.outcomes.monthlyPlan.value);
          assert.deepStrictEqual(actual.outcomes.spending.value, baseline.outcomes.spending.value);
        } else {
          assert.equal(expected.remaining - baselineExpected.remaining, BigInt(-branch.amountDelta));
          assert.equal(expected.allowanceBasis - baselineExpected.allowanceBasis, BigInt(-branch.amountDelta));
          assert.equal(
            amountOf(actual.outcomes.monthlyPlan.value.remainingSpendable)
              - amountOf(baseline.outcomes.monthlyPlan.value.remainingSpendable),
            BigInt(-branch.amountDelta),
          );
          if (family === 'excludedToday') {
            assert.equal(
              actual.outcomes.todayAllowance.value.excludedToday.count
                - baseline.outcomes.todayAllowance.value.excludedToday.count,
              branch.excludedCountDelta,
            );
            assert.equal(
              amountOf(actual.outcomes.todayAllowance.value.excludedToday.total)
                - amountOf(baseline.outcomes.todayAllowance.value.excludedToday.total),
              BigInt(branch.amountDelta),
            );
          } else {
            assert.deepStrictEqual(
              actual.outcomes.todayAllowance.value.excludedToday,
              baseline.outcomes.todayAllowance.value.excludedToday,
            );
          }
        }
      }
    }

    const otherMonthBranch = branchFor(world, generated, 'otherMonth', 'create');
    repository.replaceExpenses(otherMonthBranch.ledger);
    const nonCurrent = await service.getSnapshot(snapshotInput(world, world.otherMonth));
    const nonCurrentExpected = referenceSnapshot(world, otherMonthBranch.ledger, world.otherMonth);
    coverage.nonCurrentSnapshots += 1;
    assertSnapshotMatchesReference(nonCurrent, nonCurrentExpected, { todayApplicable: false });
  }), { numRuns: RUNS });

  assert.equal(coverage.cases, RUNS);
  assert.equal(coverage.currentSnapshots, RUNS * 13);
  assert.equal(coverage.nonCurrentSnapshots, RUNS);
  assert.equal(coverage.creates, RUNS * FAMILIES.length);
  assert.equal(coverage.updates, RUNS * FAMILIES.length);
  assert.equal(coverage.deletes, RUNS * FAMILIES.length);
  assert.equal(coverage.excludedChanges, RUNS * 3);
  assert.equal(coverage.otherDayChanges, RUNS * 3);
  assert.equal(coverage.malformedChanges, RUNS * 3);
  assert.equal(coverage.otherMonthChanges, RUNS * 3);
});

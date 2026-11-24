import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { calculateMonthlyPlan } from '../../src/domain/monthlyPlan.js';
import { calculateTodayAllowance } from '../../src/domain/allowance.js';
import { assertProperty } from '../helpers/propertyReport.js';
import {
  addDays,
  kolkataDateOf,
  kolkataMidnightMs,
  kolkataParts,
  parseIsoDate,
  withProcessTimeZone,
} from '../helpers/kolkataReference.js';
import { anyRealDateArb, invalidDateFieldsArb, validDateArb } from '../helpers/quickAddGenerators.js';

// Feature: quick-add-daily-answer, Property 12: Today_Allowance matches the reference model
// Validates: Requirements 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 17.14, 17.16
//
// The reference model below is independent of allowance.js: it uses BigInt
// arithmetic, walks the month one calendar day at a time, and reads instants
// through Intl with an explicit Asia/Kolkata zone. The plan under test comes
// from the real calculateMonthlyPlan.

const NUM_RUNS = 300;
const KOLKATA = 'Asia/Kolkata';
const PROCESS_TIME_ZONES = Object.freeze([
  'UTC', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Asia/Kolkata', 'Australia/Lord_Howe',
]);
const CATEGORIES = Object.freeze(['Food', 'Groceries', 'Transport', 'Shopping', 'Entertainment', 'Other']);

/* ------------------------------------------------------------- reference */

function halfUp(numerator, denominator) {
  let quotient = numerator / denominator;
  if ((numerator % denominator) * 2n >= denominator) quotient += 1n;
  return quotient;
}

/** Every calendar date of a `YYYY-MM` month, built by stepping one day at a time. */
function datesOfMonth(month) {
  const dates = [];
  let date = `${month}-01`;
  while (date.startsWith(month)) {
    dates.push(date);
    date = addDays(date, 1);
  }
  return dates;
}

/** The date a record is attributed to, or null for none. */
function referenceAttribution({ record, createdMs }) {
  const { spentOn } = record;
  if (spentOn !== null && spentOn !== undefined && spentOn !== '') {
    return typeof spentOn === 'string' && parseIsoDate(spentOn) ? spentOn : null;
  }
  return createdMs === null ? null : kolkataDateOf(createdMs);
}

function referenceMarked(record) {
  return record.excludeFromDailyAllowance === true || record.excludeFromDailyAllowance === 1;
}

function referenceAllowance({ month, localDate, plan, entries }) {
  const days = datesOfMonth(month);
  const ledger = new Map(days.map((date) => [date, { counted: [], excluded: [] }]));
  for (const entry of entries) {
    if (entry.record.month !== month) continue;
    const date = referenceAttribution(entry);
    if (date === null || !ledger.has(date)) continue;
    (referenceMarked(entry.record) ? ledger.get(date).excluded : ledger.get(date).counted).push(entry.record);
  }

  // Walk the month: count the days from Today through the last day, and take
  // Today's bucket when the walk reaches it.
  let reachedToday = false;
  let daysRemaining = 0;
  let today = null;
  for (const date of days) {
    if (date === localDate) {
      reachedToday = true;
      today = ledger.get(date);
    }
    if (reachedToday) daysRemaining += 1;
  }

  const spent = today.counted.reduce((sum, record) => sum + BigInt(record.amountMinor), 0n);
  const excludedTotal = today.excluded.reduce((sum, record) => sum + BigInt(record.amountMinor), 0n);
  const spendable = BigInt(plan.spendableBudgetMinor);
  const basis = BigInt(plan.remainingSpendableMinor) + spent;
  const divisor = BigInt(daysRemaining);
  const allowance = basis <= 0n ? 0n : halfUp(basis, divisor);
  const left = allowance - spent;

  let zeroReason = null;
  if (allowance === 0n) {
    if (spendable === 0n) zeroReason = 'no_spendable_budget';
    else if (basis <= 0n) zeroReason = 'month_budget_used';
    else zeroReason = 'below_minimum_unit';
  }
  let usedPermille = null;
  if (allowance > 0n) {
    const ratio = halfUp(spent * 1000n, allowance);
    usedPermille = Number(ratio > 1000n ? 1000n : ratio);
  }
  let threshold = null;
  if (spendable > 0n) {
    const quarter = halfUp(spendable * 25n, 100n);
    threshold = Number(quarter > 100000n ? quarter : 100000n);
  }
  const exactDivision = basis > 0n && basis % divisor === 0n;

  return {
    applicable: true,
    date: localDate,
    daysRemainingInclusive: daysRemaining,
    spendableBudgetMinor: Number(spendable),
    remainingSpendableMinor: plan.remainingSpendableMinor,
    dailySpendingGuideMinor: plan.dailySpendingGuideMinor,
    todaySpentMinor: Number(spent),
    allowanceBasisMinor: Number(basis),
    todayAllowanceMinor: Number(allowance),
    leftTodayMinor: Number(left),
    overTodayMinor: Number(left < 0n ? -left : 0n),
    usedPermille,
    zeroReason,
    usedBeyondBudgetMinor: Number(basis < 0n ? -basis : 0n),
    excludedToday: { count: today.excluded.length, totalMinor: Number(excludedTotal) },
    largeEntryThresholdMinor: threshold,
    countedExpenseIds: today.counted.map((record) => record.id),
    excludedTodayExpenseIds: today.excluded.map((record) => record.id),
    rounding: {
      precisionMinor: 1,
      direction: basis <= 0n || exactDivision ? 'exact' : 'half_up',
      adjustmentMinor: 0,
    },
  };
}

const COMPARED_FIELDS = Object.freeze([
  'applicable', 'date', 'daysRemainingInclusive', 'spendableBudgetMinor', 'remainingSpendableMinor',
  'dailySpendingGuideMinor', 'todaySpentMinor', 'allowanceBasisMinor', 'todayAllowanceMinor',
  'leftTodayMinor', 'overTodayMinor', 'usedPermille', 'zeroReason', 'usedBeyondBudgetMinor',
  'excludedToday', 'largeEntryThresholdMinor', 'countedExpenseIds', 'excludedTodayExpenseIds', 'rounding',
]);

function pick(result) {
  return Object.fromEntries(COMPARED_FIELDS.map((field) => [field, result[field]]));
}

/* ------------------------------------------------------------ generators */

const CREATED_OFFSETS_MS = Object.freeze([-60_000, -1000, -1, 0, 1, 1000, 60_000]);
const MALFORMED_SPENT_ON = Object.freeze([
  'abc', '2026-1-5', '15/01/2026', ' 2026-01-15', '2026-01-15 ', '2026-01-15T00:00:00Z', '20260115',
  '0000-00-00', 'today',
]);
const UNPARSEABLE_CREATED = Object.freeze([
  'not-a-timestamp', '', '2026-02-30 10:00:00', '2026-01-15T25:00:00Z', 'yesterday', '12:00',
]);
const MARK_VALUES = Object.freeze([true, true, 1, false, 0, null, undefined, '1', 'true', 2]);

const expenseSpecArb = fc.record({
  amount: fc.oneof(
    { weight: 3, arbitrary: fc.integer({ min: 0, max: 50_000 }) },
    { weight: 3, arbitrary: fc.integer({ min: 0, max: 400_000_000 }) },
    { weight: 1, arbitrary: fc.constantFrom(0, 1, 2, 3) },
  ),
  monthKind: fc.constantFrom('current', 'current', 'current', 'current', 'current', 'other'),
  otherMonthDays: fc.integer({ min: 35, max: 400 }),
  otherMonthSign: fc.constantFrom(-1, 1),
  dateKind: fc.constantFrom(
    'today', 'today', 'today', 'past', 'future', 'otherMonthDate', 'absent', 'absent', 'empty',
    'malformedFixed', 'malformedInvalid', 'nonString',
  ),
  rawDay: fc.integer({ min: 1, max: 31 }),
  absentForm: fc.constantFrom('null', 'undefined'),
  invalidDate: invalidDateFieldsArb,
  malformedText: fc.constantFrom(...MALFORMED_SPENT_ON),
  nonString: fc.constantFrom(5, 20260115, 0, true),
  createdKind: fc.constantFrom('iso', 'offset', 'sqlite', 'epoch', 'unparseable', 'nullValue', 'omitted'),
  createdDayOffset: fc.integer({ min: -2, max: 2 }),
  createdOffsetMs: fc.oneof(
    { weight: 4, arbitrary: fc.constantFrom(...CREATED_OFFSETS_MS) },
    { weight: 1, arbitrary: fc.integer({ min: -43_200_000, max: 43_200_000 }) },
  ),
  unparseableText: fc.constantFrom(...UNPARSEABLE_CREATED),
  mark: fc.constantFrom(...MARK_VALUES),
  category: fc.constantFrom(...CATEGORIES),
});

function pad(value, width = 2) {
  return String(value).padStart(width, '0');
}

function dayInCurrentMonth(kind, rawDay, localDate) {
  const today = Number(localDate.slice(8, 10));
  const monthLength = datesOfMonth(localDate.slice(0, 7)).length;
  if (kind === 'past' && today > 1) return ((rawDay - 1) % (today - 1)) + 1;
  if (kind === 'future' && today < monthLength) return today + 1 + ((rawDay - 1) % (monthLength - today));
  return today;
}

/** Builds the stored record and the instant its creation time stands for. */
function buildEntry(spec, id, month, localDate) {
  const otherMonth = spec.monthKind === 'other'
    ? addDays(localDate, spec.otherMonthSign * spec.otherMonthDays).slice(0, 7)
    : null;

  let spentOn;
  switch (spec.dateKind) {
    case 'today': spentOn = localDate; break;
    case 'past':
    case 'future': spentOn = `${month}-${pad(dayInCurrentMonth(spec.dateKind, spec.rawDay, localDate))}`; break;
    case 'otherMonthDate':
      spentOn = addDays(localDate, (spec.rawDay % 2 === 0 ? -1 : 1) * (32 + spec.rawDay * 5));
      break;
    case 'absent': spentOn = spec.absentForm === 'null' ? null : undefined; break;
    case 'empty': spentOn = ''; break;
    case 'malformedFixed': spentOn = spec.malformedText; break;
    case 'malformedInvalid': {
      const { year, month: m, day } = spec.invalidDate;
      spentOn = `${pad(year, 4)}-${pad(m)}-${pad(day)}`;
      break;
    }
    default: spentOn = spec.nonString;
  }

  const anchor = addDays(localDate, spec.createdDayOffset);
  let createdMs = kolkataMidnightMs(anchor) + spec.createdOffsetMs;
  let createdAt;
  switch (spec.createdKind) {
    case 'iso': createdAt = new Date(createdMs).toISOString(); break;
    case 'offset': {
      const p = kolkataParts(createdMs);
      const millis = ((createdMs % 1000) + 1000) % 1000;
      createdAt = `${p.date}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}.${pad(millis, 3)}+05:30`;
      break;
    }
    case 'sqlite':
      createdMs = Math.floor(createdMs / 1000) * 1000;
      createdAt = new Date(createdMs).toISOString().slice(0, 19).replace('T', ' ');
      break;
    case 'epoch': createdAt = createdMs; break;
    case 'unparseable': createdAt = spec.unparseableText; createdMs = null; break;
    case 'nullValue': createdAt = null; createdMs = null; break;
    default: createdAt = undefined; createdMs = null;
  }

  const record = {
    id,
    month: otherMonth ?? month,
    category: spec.category,
    amountMinor: spec.amount,
    spentOn,
    createdAt,
    excludeFromDailyAllowance: spec.mark,
  };
  if (spec.createdKind === 'omitted') delete record.createdAt;
  return { record, createdMs };
}

const scenarioArb = fc
  .record({
    localDate: anyRealDateArb,
    budgetKind: fc.constantFrom('normal', 'normal', 'normal', 'billsEqual', 'noSalary'),
    salary: fc.oneof(
      { weight: 3, arbitrary: fc.integer({ min: 0, max: 2_000_000_000 }) },
      { weight: 1, arbitrary: fc.integer({ min: 0, max: 5000 }) },
    ),
    bills: fc.array(fc.integer({ min: 0, max: 300_000_000 }), { minLength: 0, maxLength: 4 }),
    specs: fc.array(expenseSpecArb, { minLength: 0, maxLength: 14 }),
    processTimeZone: fc.constantFrom(...PROCESS_TIME_ZONES),
  })
  .chain((base) => fc
    .uniqueArray(fc.integer({ min: 1, max: 1_000_000 }), {
      minLength: base.specs.length + base.bills.length + 1,
      maxLength: base.specs.length + base.bills.length + 1,
    })
    .map((ids) => ({ ...base, ids })));

function buildScenario({ localDate, budgetKind, salary, bills, specs, ids, processTimeZone }) {
  const month = localDate.slice(0, 7);
  const billAmounts = budgetKind === 'billsEqual' ? [...bills, salary] : bills;
  const salaryMinor = budgetKind === 'noSalary' ? 0 : salary;
  const entries = specs.map((spec, index) => buildEntry(spec, ids[index], month, localDate));
  const billRecords = billAmounts.map((amountMinor, index) => ({
    id: ids[specs.length + index] ?? 2_000_000 + index,
    amountMinor,
    active: true,
  }));
  const plan = calculateMonthlyPlan({
    month,
    localDate,
    timeZone: KOLKATA,
    salaryEntries: [{ id: 1, month, amountMinor: salaryMinor }],
    bills: billRecords,
    expenses: entries.map(({ record }) => record),
    categoryTreatments: [],
  });
  return { month, localDate, plan, entries, processTimeZone };
}

/* ------------------------------------------------------------ properties */

test('Property 12: Today_Allowance matches the day-by-day reference model', async () => {
  const counts = { zeroBudget: 0, monthUsed: 0, below: 0, positive: 0, excluded: 0, counted: 0, tie: 0 };
  await assertProperty(fc.property(scenarioArb, (generated) => {
    const { month, localDate, plan, entries, processTimeZone } = buildScenario(generated);
    const expenses = entries.map(({ record }) => record);

    const actual = withProcessTimeZone(processTimeZone, () => calculateTodayAllowance({
      month, localDate, plan, expenses,
    }));
    const expected = referenceAllowance({ month, localDate, plan, entries });

    assert.deepStrictEqual(pick(actual), expected);

    // Requirements 10.4, 10.5, 10.7 stated directly as well.
    assert.ok(actual.todayAllowanceMinor >= 0, 'Today_Allowance is never negative');
    assert.equal(actual.leftTodayMinor, actual.todayAllowanceMinor - actual.todaySpentMinor);
    assert.equal(actual.allowanceBasisMinor, plan.remainingSpendableMinor + actual.todaySpentMinor);
    if (actual.todaySpentMinor === 0 && plan.dailySpendingGuideMinor >= 0) {
      assert.equal(actual.todayAllowanceMinor, plan.dailySpendingGuideMinor);
    }

    if (expected.zeroReason === 'no_spendable_budget') counts.zeroBudget += 1;
    if (expected.zeroReason === 'month_budget_used') counts.monthUsed += 1;
    if (expected.zeroReason === 'below_minimum_unit') counts.below += 1;
    if (expected.todayAllowanceMinor > 0) counts.positive += 1;
    if (expected.excludedToday.count > 0) counts.excluded += 1;
    if (expected.countedExpenseIds.length > 0) counts.counted += 1;
    if (expected.allowanceBasisMinor > 0 && expected.rounding.direction === 'half_up'
      && (BigInt(expected.allowanceBasisMinor) % BigInt(expected.daysRemainingInclusive)) * 2n
        === BigInt(expected.daysRemainingInclusive)) counts.tie += 1;
  }), { numRuns: NUM_RUNS });

  // The generator must reach the interesting regions, or the property proves little.
  assert.ok(counts.positive > 0, 'positive allowances were generated');
  assert.ok(counts.zeroBudget > 0, 'no_spendable_budget was generated');
  assert.ok(counts.monthUsed > 0, 'month_budget_used was generated');
  assert.ok(counts.excluded > 0, 'excluded-today expenses were generated');
  assert.ok(counts.counted > 0, 'counted expenses were generated');
});

test('Property 12: half-paise quotients round upward against the reference', () => {
  let ties = 0;
  for (const localDate of ['2026-01-30', '2026-01-28', '2026-01-26', '2024-02-20', '2026-04-25']) {
    const month = localDate.slice(0, 7);
    const days = datesOfMonth(month).length - Number(localDate.slice(8, 10)) + 1;
    for (let salary = 0; salary <= 300; salary += 1) {
      for (const todayAmount of [0, 1, days]) {
        const entries = [{
          record: {
            id: 1, month, category: 'Food', amountMinor: todayAmount, spentOn: localDate,
            createdAt: null, excludeFromDailyAllowance: false,
          },
          createdMs: null,
        }];
        const plan = calculateMonthlyPlan({
          month,
          localDate,
          timeZone: KOLKATA,
          salaryEntries: [{ id: 1, month, amountMinor: salary }],
          bills: [],
          expenses: entries.map(({ record }) => record),
          categoryTreatments: [],
        });
        const actual = calculateTodayAllowance({
          month, localDate, plan, expenses: entries.map(({ record }) => record),
        });
        const expected = referenceAllowance({ month, localDate, plan, entries });
        assert.deepStrictEqual(pick(actual), expected);
        const basis = BigInt(expected.allowanceBasisMinor);
        if (basis > 0n && (basis % BigInt(days)) * 2n === BigInt(days)) {
          ties += 1;
          assert.equal(BigInt(actual.todayAllowanceMinor), basis / BigInt(days) + 1n);
        }
      }
    }
  }
  assert.ok(ties > 0, 'at least one exact half-paise quotient was reached');
});

test('Property 12: another month is not applicable and a mismatched plan is rejected', async () => {
  await assertProperty(fc.property(anyRealDateArb, validDateArb({ minYear: 2000, maxYear: 2090 }), (localDate, other) => {
    fc.pre(other.slice(0, 7) !== localDate.slice(0, 7));
    const month = localDate.slice(0, 7);
    const plan = calculateMonthlyPlan({
      month,
      localDate,
      timeZone: KOLKATA,
      salaryEntries: [{ id: 1, month, amountMinor: 1_000_000 }],
      bills: [],
      expenses: [],
      categoryTreatments: [],
    });
    assert.deepStrictEqual(
      calculateTodayAllowance({ month: other.slice(0, 7), localDate, plan, expenses: [] }),
      { applicable: false, reason: 'not_current_month' },
    );
    const otherPlan = calculateMonthlyPlan({
      month: other.slice(0, 7),
      localDate: other,
      timeZone: KOLKATA,
      salaryEntries: [{ id: 1, month: other.slice(0, 7), amountMinor: 1_000_000 }],
      bills: [],
      expenses: [],
      categoryTreatments: [],
    });
    assert.throws(() => calculateTodayAllowance({ month, localDate, plan: otherPlan, expenses: [] }), RangeError);
  }), { numRuns: 100 });
});

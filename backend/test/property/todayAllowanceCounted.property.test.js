import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { calculateMonthlyPlan } from '../../src/domain/monthlyPlan.js';
import { calculateTodayAllowance } from '../../src/domain/allowance.js';
import { assertProperty } from '../helpers/propertyReport.js';
import {
  DAY_MS,
  addDays,
  daysInMonth,
  kolkataDateOf,
  kolkataMidnightMs,
  kolkataParts,
  parseIsoDate,
  withProcessTimeZone,
} from '../helpers/kolkataReference.js';
import { anyRealDateArb } from '../helpers/quickAddGenerators.js';

// Feature: quick-add-daily-answer, Property 13: Counted expenses move Left_Today and not Today_Allowance
// Validates: Requirements 10.8, 17.14, 17.15
//
// A Counted_Expense is a record of the month attributed to Today and without
// the Allowance_Exclusion. For generated ledgers the test creates, updates and
// deletes Counted_Expenses one step at a time, rebuilds the plan with the real
// calculateMonthlyPlan after every step, and compares calculateTodayAllowance
// with an independent model that uses BigInt sums and a set of counted ids.
// Today_Allowance and Allowance_Basis must not move, Today_Spent must move by
// the amount difference and Left_Today by the opposite amount.

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

/** The date a record is attributed to, or null for none, from independent helpers. */
function modelDateOf(record) {
  const { spentOn, createdAt } = record;
  if (spentOn !== null && spentOn !== undefined && spentOn !== '') {
    return typeof spentOn === 'string' && parseIsoDate(spentOn) ? spentOn : null;
  }
  if (createdAt === null || createdAt === undefined) return null;
  if (typeof createdAt === 'number') return kolkataDateOf(createdAt);
  if (typeof createdAt !== 'string') return null;
  const sqlite = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(createdAt);
  const ms = Date.parse(sqlite ? `${sqlite[1]}T${sqlite[2]}:${sqlite[3]}:${sqlite[4]}Z` : createdAt);
  return Number.isNaN(ms) ? null : kolkataDateOf(ms);
}

function modelMarked(record) {
  return record.excludeFromDailyAllowance === true || record.excludeFromDailyAllowance === 1;
}

function modelCounted(ledger, month, localDate) {
  return ledger.filter((record) => record.month === month
    && modelDateOf(record) === localDate
    && !modelMarked(record));
}

function modelExcluded(ledger, month, localDate) {
  return ledger.filter((record) => record.month === month
    && modelDateOf(record) === localDate
    && modelMarked(record));
}

function sum(records) {
  return records.reduce((total, record) => total + BigInt(record.amountMinor), 0n);
}

function modelState({ ledger, month, localDate, plan }) {
  const [year, monthNumber, day] = localDate.split('-').map(Number);
  const days = BigInt(daysInMonth(year, monthNumber) - day + 1);
  const counted = modelCounted(ledger, month, localDate);
  const excluded = modelExcluded(ledger, month, localDate);
  const spent = sum(counted);
  const basis = BigInt(plan.remainingSpendableMinor) + spent;
  const allowance = basis <= 0n ? 0n : halfUp(basis, days);
  return {
    countedIds: counted.map((record) => record.id),
    excludedIds: excluded.map((record) => record.id),
    excludedTotal: sum(excluded),
    spent,
    basis,
    allowance,
    left: allowance - spent,
    remaining: BigInt(plan.remainingSpendableMinor),
  };
}

/* ------------------------------------------------------------ generators */

const UNMARKED_VALUES = Object.freeze([false, 0, null, undefined, '1', 'true', 2]);
const MARKED_VALUES = Object.freeze([true, 1]);
const MALFORMED_SPENT_ON = Object.freeze(['abc', '2026-1-5', '15/01/2026', ' 2026-01-15', '2026-01-15T00:00:00Z', '0000-00-00']);
const UNPARSEABLE_CREATED = Object.freeze(['not-a-timestamp', '', '2026-02-30 10:00:00', 'yesterday']);

function pad(value, width = 2) {
  return String(value).padStart(width, '0');
}

/** A creation time for a Kolkata day, written in one of the stored forms. */
function createdAtFor(date, offsetMs, form) {
  const instant = kolkataMidnightMs(date) + offsetMs;
  switch (form) {
    case 'offset': {
      const p = kolkataParts(instant);
      const millis = ((instant % 1000) + 1000) % 1000;
      return `${p.date}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}.${pad(millis, 3)}+05:30`;
    }
    case 'sqlite':
      return new Date(Math.floor(instant / 1000) * 1000).toISOString().slice(0, 19).replace('T', ' ');
    case 'epoch': return instant;
    default: return new Date(instant).toISOString();
  }
}

const DAY_OFFSETS_MS = Object.freeze([0, 1, 1000, 43_200_000, DAY_MS - 1000, DAY_MS - 1]);
const offsetMsArb = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(...DAY_OFFSETS_MS) },
  { weight: 1, arbitrary: fc.integer({ min: 0, max: DAY_MS - 1 }) },
);

const amountArb = fc.oneof(
  { weight: 3, arbitrary: fc.integer({ min: 0, max: 50_000 }) },
  { weight: 3, arbitrary: fc.integer({ min: 0, max: 100_000_000 }) },
  { weight: 1, arbitrary: fc.constantFrom(0, 1, 2, 3) },
);

const formArb = fc.constantFrom('iso', 'offset', 'sqlite', 'epoch');

/** Ledger records of any kind: counted, excluded-today, other days, other months, unattributed. */
const ledgerSpecArb = fc.record({
  amount: amountArb,
  kind: fc.constantFrom(
    'todayExplicit', 'todayExplicit', 'todayCreated', 'todayCreated', 'todayMarked', 'todayMarkedCreated',
    'past', 'future', 'otherMonth', 'otherMonthDate', 'malformed', 'unparseable', 'createdOtherDay',
  ),
  rawDay: fc.integer({ min: 1, max: 31 }),
  otherMonthDays: fc.integer({ min: 35, max: 400 }),
  otherMonthSign: fc.constantFrom(-1, 1),
  absent: fc.constantFrom(null, undefined, ''),
  unmarked: fc.constantFrom(...UNMARKED_VALUES),
  marked: fc.constantFrom(...MARKED_VALUES),
  mark: fc.constantFrom(...UNMARKED_VALUES, ...MARKED_VALUES),
  malformed: fc.constantFrom(...MALFORMED_SPENT_ON),
  unparseable: fc.constantFrom(...UNPARSEABLE_CREATED),
  form: formArb,
  offsetMs: offsetMsArb,
  dayShift: fc.constantFrom(-2, -1, 1, 2),
  category: fc.constantFrom(...CATEGORIES),
});

/** A new or replacing Counted_Expense. */
const countedSpecArb = fc.record({
  amount: amountArb,
  viaCreatedAt: fc.boolean(),
  absent: fc.constantFrom(null, undefined, ''),
  unmarked: fc.constantFrom(...UNMARKED_VALUES),
  form: formArb,
  offsetMs: offsetMsArb,
  category: fc.constantFrom(...CATEGORIES),
});

const operationArb = fc.record({
  kind: fc.constantFrom('create', 'create', 'update', 'update', 'delete'),
  pick: fc.nat({ max: 1000 }),
  counted: countedSpecArb,
  newAmount: amountArb,
});

const scenarioArb = fc.record({
  localDate: anyRealDateArb,
  budgetKind: fc.constantFrom('normal', 'normal', 'normal', 'billsEqual', 'noSalary'),
  salary: fc.oneof(
    { weight: 3, arbitrary: fc.integer({ min: 0, max: 2_000_000_000 }) },
    { weight: 1, arbitrary: fc.integer({ min: 0, max: 5000 }) },
  ),
  bills: fc.array(fc.integer({ min: 0, max: 300_000_000 }), { minLength: 0, maxLength: 4 }),
  specs: fc.array(ledgerSpecArb, { minLength: 0, maxLength: 12 }),
  operations: fc.array(operationArb, { minLength: 1, maxLength: 6 }),
  processTimeZone: fc.constantFrom(...PROCESS_TIME_ZONES),
});

function dayOfMonth(kind, rawDay, localDate) {
  const today = Number(localDate.slice(8, 10));
  const length = daysInMonth(Number(localDate.slice(0, 4)), Number(localDate.slice(5, 7)));
  if (kind === 'past' && today > 1) return ((rawDay - 1) % (today - 1)) + 1;
  if (kind === 'future' && today < length) return today + 1 + ((rawDay - 1) % (length - today));
  return today;
}

function buildLedgerRecord(spec, id, month, localDate) {
  const base = {
    id,
    month,
    category: spec.category,
    amountMinor: spec.amount,
    spentOn: spec.absent,
    createdAt: createdAtFor(localDate, spec.offsetMs, spec.form),
    excludeFromDailyAllowance: spec.unmarked,
  };
  switch (spec.kind) {
    case 'todayExplicit': return { ...base, spentOn: localDate };
    case 'todayCreated': return base;
    case 'todayMarked': return { ...base, spentOn: localDate, excludeFromDailyAllowance: spec.marked };
    case 'todayMarkedCreated': return { ...base, excludeFromDailyAllowance: spec.marked };
    case 'past':
    case 'future':
      return {
        ...base,
        spentOn: `${month}-${pad(dayOfMonth(spec.kind, spec.rawDay, localDate))}`,
        excludeFromDailyAllowance: spec.mark,
      };
    case 'otherMonth':
      return {
        ...base,
        month: addDays(localDate, spec.otherMonthSign * spec.otherMonthDays).slice(0, 7),
        spentOn: localDate,
        excludeFromDailyAllowance: spec.mark,
      };
    case 'otherMonthDate':
      return { ...base, spentOn: addDays(localDate, spec.otherMonthSign * (32 + spec.rawDay * 5)), excludeFromDailyAllowance: spec.mark };
    case 'malformed': return { ...base, spentOn: spec.malformed, excludeFromDailyAllowance: spec.mark };
    case 'unparseable': return { ...base, createdAt: spec.unparseable, excludeFromDailyAllowance: spec.mark };
    default:
      return {
        ...base,
        createdAt: createdAtFor(addDays(localDate, spec.dayShift), spec.offsetMs, spec.form),
        excludeFromDailyAllowance: spec.mark,
      };
  }
}

function buildCountedRecord(spec, id, month, localDate, amount = spec.amount) {
  const record = {
    id,
    month,
    category: spec.category,
    amountMinor: amount,
    spentOn: spec.viaCreatedAt ? spec.absent : localDate,
    createdAt: createdAtFor(localDate, spec.offsetMs, spec.form),
    excludeFromDailyAllowance: spec.unmarked,
  };
  return record;
}

/* ------------------------------------------------------------- the world */

function makeWorld({ localDate, budgetKind, salary, bills }) {
  const month = localDate.slice(0, 7);
  const billAmounts = budgetKind === 'billsEqual' ? [...bills, salary] : bills;
  const salaryMinor = budgetKind === 'noSalary' ? 0 : salary;
  return { month, localDate, salaryMinor, billAmounts };
}

function planFor(world, ledger) {
  return calculateMonthlyPlan({
    month: world.month,
    localDate: world.localDate,
    timeZone: KOLKATA,
    salaryEntries: [{ id: 1, month: world.month, amountMinor: world.salaryMinor }],
    bills: world.billAmounts.map((amountMinor, index) => ({ id: 3_000_000 + index, amountMinor, active: true })),
    expenses: ledger,
    categoryTreatments: [],
  });
}

function observe(world, ledger, processTimeZone) {
  const plan = planFor(world, ledger);
  const actual = withProcessTimeZone(processTimeZone, () => calculateTodayAllowance({
    month: world.month, localDate: world.localDate, plan, expenses: ledger,
  }));
  const model = modelState({ ledger, month: world.month, localDate: world.localDate, plan });
  return { plan, actual, model };
}

function assertMatchesModel({ actual, model }) {
  assert.equal(actual.applicable, true);
  assert.deepStrictEqual(actual.countedExpenseIds, model.countedIds);
  assert.deepStrictEqual(actual.excludedTodayExpenseIds, model.excludedIds);
  assert.equal(BigInt(actual.todaySpentMinor), model.spent);
  assert.equal(BigInt(actual.allowanceBasisMinor), model.basis);
  assert.equal(BigInt(actual.todayAllowanceMinor), model.allowance);
  assert.equal(BigInt(actual.leftTodayMinor), model.left);
  assert.equal(BigInt(actual.excludedToday.totalMinor), model.excludedTotal);
  assert.equal(actual.excludedToday.count, model.excludedIds.length);
}

/* ------------------------------------------------------------ properties */

test('Property 13: creating, updating and deleting Counted_Expenses leaves Today_Allowance and moves Left_Today by the amount', async () => {
  const seen = { create: 0, update: 0, delete: 0, positive: 0, zero: 0, overToday: 0, viaCreatedAt: 0, nonZeroDelta: 0 };

  await assertProperty(fc.property(scenarioArb, (generated) => {
    const world = makeWorld(generated);
    const { month, localDate } = world;
    let ledger = generated.specs.map((spec, index) => buildLedgerRecord(spec, index + 1, month, localDate));
    let nextId = 100_000;

    let before = observe(world, ledger, generated.processTimeZone);
    assertMatchesModel(before);

    for (const operation of generated.operations) {
      const countedNow = ledger.filter((record) => modelCounted([record], month, localDate).length === 1);
      let kind = operation.kind;
      if (kind !== 'create' && countedNow.length === 0) kind = 'create';

      let delta; // change in Today_Spent, in paise
      let targetId;
      let excludedBefore = before.actual.excludedToday;

      if (kind === 'create') {
        const record = buildCountedRecord(operation.counted, nextId, month, localDate);
        nextId += 1;
        ledger = [...ledger, record];
        delta = record.amountMinor;
        targetId = record.id;
        if (operation.counted.viaCreatedAt) seen.viaCreatedAt += 1;
      } else {
        const target = countedNow[operation.pick % countedNow.length];
        targetId = target.id;
        if (kind === 'update') {
          delta = operation.newAmount - target.amountMinor;
          ledger = ledger.map((record) => (record.id === target.id
            ? { ...record, amountMinor: operation.newAmount }
            : record));
        } else {
          delta = 0 - target.amountMinor;
          ledger = ledger.filter((record) => record.id !== target.id);
        }
      }
      seen[kind] += 1;

      const after = observe(world, ledger, generated.processTimeZone);
      assertMatchesModel(after);

      // Requirement 10.8: Today_Allowance (and its basis) is unchanged.
      assert.equal(after.actual.todayAllowanceMinor, before.actual.todayAllowanceMinor, `${kind}: Today_Allowance moved`);
      assert.equal(after.actual.allowanceBasisMinor, before.actual.allowanceBasisMinor, `${kind}: Allowance_Basis moved`);
      assert.equal(after.actual.zeroReason, before.actual.zeroReason, `${kind}: zero reason moved`);

      // Today_Spent moves by the amount difference, Left_Today by the opposite amount.
      assert.equal(after.actual.todaySpentMinor - before.actual.todaySpentMinor, delta, `${kind}: Today_Spent`);
      assert.equal(after.actual.leftTodayMinor - before.actual.leftTodayMinor, 0 - delta, `${kind}: Left_Today`);
      assert.equal(
        after.actual.leftTodayMinor,
        after.actual.todayAllowanceMinor - after.actual.todaySpentMinor,
      );

      // Remaining_Spendable falls by the same amount, which is why the basis holds still.
      assert.equal(after.plan.remainingSpendableMinor - before.plan.remainingSpendableMinor, 0 - delta);

      // Creating a Counted_Expense decreases Left_Today by exactly its amount (Requirement 17.15).
      if (kind === 'create') {
        assert.equal(before.actual.leftTodayMinor - after.actual.leftTodayMinor, ledger.at(-1).amountMinor);
        assert.ok(after.actual.countedExpenseIds.includes(targetId));
      } else if (kind === 'delete') {
        assert.ok(!after.actual.countedExpenseIds.includes(targetId));
      } else {
        assert.ok(after.actual.countedExpenseIds.includes(targetId));
      }

      // The counted set changes by exactly the touched record, in order.
      const expectedIds = kind === 'create'
        ? [...before.actual.countedExpenseIds, targetId]
        : (kind === 'delete'
          ? before.actual.countedExpenseIds.filter((id) => id !== targetId)
          : before.actual.countedExpenseIds);
      assert.deepStrictEqual(after.actual.countedExpenseIds, expectedIds);

      // Excluded-today records are untouched by a counted change.
      assert.deepStrictEqual(after.actual.excludedToday, excludedBefore);
      assert.deepStrictEqual(after.actual.excludedTodayExpenseIds, before.actual.excludedTodayExpenseIds);

      if (delta !== 0) seen.nonZeroDelta += 1;
      if (after.actual.todayAllowanceMinor > 0) seen.positive += 1; else seen.zero += 1;
      if (after.actual.overTodayMinor > 0) seen.overToday += 1;
      before = after;
    }
  }), { numRuns: NUM_RUNS });

  assert.ok(seen.create > 0, 'creates were generated');
  assert.ok(seen.update > 0, 'updates were generated');
  assert.ok(seen.delete > 0, 'deletes were generated');
  assert.ok(seen.positive > 0, 'positive allowances were generated');
  assert.ok(seen.zero > 0, 'zero allowances were generated');
  assert.ok(seen.overToday > 0, 'over-today states were generated');
  assert.ok(seen.viaCreatedAt > 0, 'created-at attributed expenses were generated');
  assert.ok(seen.nonZeroDelta > 0, 'non-zero amount changes were generated');
});

test('Property 13: a record dated Today is counted only when the mark is true or 1', async () => {
  await assertProperty(fc.property(
    anyRealDateArb,
    fc.constantFrom(...UNMARKED_VALUES, ...MARKED_VALUES),
    fc.integer({ min: 1, max: 100_000_000 }),
    fc.boolean(),
    (localDate, mark, amount, viaCreatedAt) => {
      const month = localDate.slice(0, 7);
      const world = { month, localDate, salaryMinor: 2_000_000_000, billAmounts: [] };
      const record = {
        id: 7,
        month,
        category: 'Food',
        amountMinor: amount,
        spentOn: viaCreatedAt ? null : localDate,
        createdAt: createdAtFor(localDate, 43_200_000, 'iso'),
        excludeFromDailyAllowance: mark,
      };
      const without = observe(world, [], 'UTC');
      const withRecord = observe(world, [record], 'UTC');
      const marked = mark === true || mark === 1;
      assert.deepStrictEqual(withRecord.actual.countedExpenseIds, marked ? [] : [7]);
      assert.deepStrictEqual(withRecord.actual.excludedTodayExpenseIds, marked ? [7] : []);
      if (!marked) {
        assert.equal(withRecord.actual.todayAllowanceMinor, without.actual.todayAllowanceMinor);
        assert.equal(withRecord.actual.todaySpentMinor, amount);
        assert.equal(withRecord.actual.leftTodayMinor, without.actual.leftTodayMinor - amount);
      } else {
        assert.equal(withRecord.actual.todaySpentMinor, 0);
      }
    },
  ), { numRuns: 100 });
});

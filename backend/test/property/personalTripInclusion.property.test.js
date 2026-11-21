import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {
  calculateMonthlyPlan,
  FINANCIAL_CLARITY_TIME_ZONE,
} from '../../src/domain/monthlyPlan.js';
import { calculateTripOutcome } from '../../src/domain/trips.js';
import { createIsolatedTestDatabase } from '../helpers/testDatabase.js';

const NUM_RUNS = 100;
const NOW = new Date('2026-01-15T06:30:00.000Z');
const OWNER_USER_ID = 71_001;
const LINKED_USER_ID = 71_002;
const UNRELATED_USER_ID = 71_003;
const TRIP_ID = 72_001;
const FIRST_MEMBER_ID = 73_001;
const TRIP_EXPENSE_ID = 74_001;
const INCLUDE_KEY = '75000000-0000-4000-8000-000000000001';
const WITHDRAW_KEY = '75000000-0000-4000-8000-000000000002';
const CATEGORIES = Object.freeze([
  'Food',
  'Groceries',
  'Transport',
  'Shopping',
  'Entertainment',
  'Bills',
  'Health',
  'Travel',
  'Education',
  'Other',
]);

let testDatabase;
let db;
let TripService;
let FinancialRepository;

function twoDigits(value) {
  return String(value).padStart(2, '0');
}

function adjacentMonth(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  const monthIndex = year * 12 + monthNumber;
  return `${Math.floor(monthIndex / 12)}-${twoDigits(monthIndex % 12 + 1)}`;
}

const scenarioArbitrary = fc.integer({ min: 2, max: 6 }).chain((memberCount) => (
  fc.record({
    weights: fc.array(fc.integer({ min: 1, max: 100 }), {
      minLength: memberCount,
      maxLength: memberCount,
    }),
    linkedMemberIndex: fc.integer({ min: 1, max: memberCount - 1 }),
    amountExtraMinor: fc.integer({ min: 0, max: 1_000_000 }),
    year: fc.integer({ min: 2017, max: 2027 }),
    monthNumber: fc.integer({ min: 1, max: 12 }),
    day: fc.integer({ min: 1, max: 28 }),
    category: fc.constantFrom(...CATEGORIES),
    existingAmountMinor: fc.integer({ min: 1, max: 100_000 }),
    otherMonthAmountMinor: fc.integer({ min: 1, max: 100_000 }),
    unrelatedAmountMinor: fc.integer({ min: 1, max: 100_000 }),
  }).map((scenario) => ({
    ...scenario,
    memberCount,
    amountMinor: scenario.weights.reduce((total, weight) => total + weight, 0)
      + scenario.amountExtraMinor,
  }))
));

function createService(repository) {
  return new TripService({
    database: db,
    repository,
    fingerprintKey: Buffer.alloc(32, 14),
    clock: () => new Date(NOW),
  });
}

async function seedUser(userId, label) {
  await db.prepare(
    'INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)'
  ).run(userId, `${label}@example.test`, label, 'test-password-hash');
}

async function seedFinancialRecords(scenario, month, otherMonth) {
  const salaryMinor = scenario.amountMinor + scenario.existingAmountMinor + 1_000_000;
  await db.prepare(
    'INSERT INTO salary_entries (user_id, month, amount) VALUES (?, ?, ?)'
  ).run(LINKED_USER_ID, month, salaryMinor / 100);
  await db.prepare(
    `INSERT INTO expense_log (user_id, month, category, amount, note, spent_on)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    LINKED_USER_ID,
    month,
    'Food',
    scenario.existingAmountMinor / 100,
    'Existing target-month expense',
    `${month}-01`
  );
  await db.prepare(
    `INSERT INTO expense_log (user_id, month, category, amount, note, spent_on)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    LINKED_USER_ID,
    otherMonth,
    'Other',
    scenario.otherMonthAmountMinor / 100,
    'Existing other-month expense',
    `${otherMonth}-01`
  );
  await db.prepare(
    `INSERT INTO expense_log (user_id, month, category, amount, note, spent_on)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    UNRELATED_USER_ID,
    month,
    'Travel',
    scenario.unrelatedAmountMinor / 100,
    'Unrelated user expense',
    `${month}-01`
  );
}

async function seedTrip(scenario) {
  await db.prepare(
    `INSERT INTO trips (id, user_id, name, destination, budget, start_date, end_date)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(TRIP_ID, OWNER_USER_ID, 'Property trip', 'Test destination', 20_000, '2026-01-01', '2026-01-31');

  const members = Array.from({ length: scenario.memberCount }, (_, index) => ({
    id: FIRST_MEMBER_ID + index,
    name: `Member ${index + 1}`,
    userId: index === 0
      ? OWNER_USER_ID
      : index === scenario.linkedMemberIndex
        ? LINKED_USER_ID
        : null,
  }));
  for (const member of members) {
    await db.prepare(
      'INSERT INTO trip_members (id, trip_id, user_id, name) VALUES (?, ?, ?, ?)'
    ).run(member.id, TRIP_ID, member.userId, member.name);
  }

  await db.prepare(
    `INSERT INTO trip_expenses
      (id, trip_id, payer, description, amount, split_json)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    TRIP_EXPENSE_ID,
    TRIP_ID,
    members[0].name,
    'Generated shared expense',
    scenario.amountMinor / 100,
    JSON.stringify(members.map((member, index) => ({
      name: member.name,
      share: scenario.weights[index],
    })))
  );

  return members;
}

// The repository returns normalized records ({ amountMinor, split, splitStatus }).
// The canonical trip calculator accepts the legacy compatibility boundary:
// rupee-decimal `amount` plus a stored-member-name `split`. Convert at that
// boundary exactly as the service does before calculating.
function legacyCalculatorExpenses(records) {
  return records.map((record) => ({
    ...record,
    amount: record.amountMinor / 100,
    split: record.splitStatus === 'confirmed' ? record.split : null,
  }));
}

function calculatePlan(period, localDate) {
  return calculateMonthlyPlan({
    month: period.month,
    localDate,
    timeZone: FINANCIAL_CLARITY_TIME_ZONE,
    salaryEntries: period.salary.record ? [period.salary.record] : [],
    bills: period.bills.records,
    expenses: period.expenses.records,
    categoryTreatments: period.categoryTreatments.records,
  });
}

async function readPersonalRows() {
  return db.prepare(
    `SELECT link.id, link.user_id, link.trip_id, link.trip_expense_id,
            link.expense_log_id, link.included_amount_minor,
            expense.month, expense.category, expense.amount, expense.note, expense.spent_on
       FROM trip_expense_personal_links link
       JOIN expense_log expense ON expense.id = link.expense_log_id
      WHERE link.user_id = ? AND link.trip_expense_id = ?
      ORDER BY link.id`
  ).all(LINKED_USER_ID, TRIP_EXPENSE_ID);
}

async function readReceipts() {
  return db.prepare(
    `SELECT idempotency_key, operation, record_type, record_id, record_version, status
       FROM financial_record_changes
      WHERE user_id = ?
      ORDER BY record_version, id`
  ).all(LINKED_USER_ID);
}

function assertTripLedgerUnchanged(actual, expected) {
  assert.deepEqual(actual, expected);
}

before(async () => {
  testDatabase = await createIsolatedTestDatabase();
  db = testDatabase.db;
  ({ TripService } = await import('../../src/services/tripService.js'));
  ({ FinancialRepository } = await import('../../src/repositories/financialRepository.js'));
});

after(async () => {
  await testDatabase?.cleanup();
});

// Feature: financial-clarity-experience, Property 14: Personal trip inclusion is isolated and idempotent
// **Validates: Requirements 7.12, 7.13, 7.14**
test('Property 14: personal trip inclusion is isolated and idempotent', async () => {
  await fc.assert(
    fc.asyncProperty(scenarioArbitrary, async (scenario) => {
      await testDatabase.reset();
      await seedUser(OWNER_USER_ID, 'trip-owner');
      await seedUser(LINKED_USER_ID, 'linked-member');
      await seedUser(UNRELATED_USER_ID, 'unrelated-user');

      const month = `${scenario.year}-${twoDigits(scenario.monthNumber)}`;
      const spentOn = `${month}-${twoDigits(scenario.day)}`;
      const otherMonth = adjacentMonth(month);
      const repository = new FinancialRepository(db);
      const service = createService(repository);

      await seedFinancialRecords(scenario, month, otherMonth);
      const periodBeforeTrip = await repository.loadPeriod({
        userId: LINKED_USER_ID,
        month,
      });
      const otherMonthBeforeTrip = await repository.loadPeriod({
        userId: LINKED_USER_ID,
        month: otherMonth,
      });
      const unrelatedBeforeTrip = await repository.loadPeriod({
        userId: UNRELATED_USER_ID,
        month,
      });
      const planBeforeTrip = calculatePlan(periodBeforeTrip, spentOn);

      const members = await seedTrip(scenario);
      const periodWithoutLink = await repository.loadPeriod({
        userId: LINKED_USER_ID,
        month,
      });
      assert.deepEqual(periodWithoutLink, periodBeforeTrip);
      assert.deepEqual(calculatePlan(periodWithoutLink, spentOn), planBeforeTrip);
      assert.deepEqual(
        await repository.loadPeriod({ userId: LINKED_USER_ID, month: otherMonth }),
        otherMonthBeforeTrip
      );
      assert.deepEqual(
        await repository.loadPeriod({ userId: UNRELATED_USER_ID, month }),
        unrelatedBeforeTrip
      );
      assert.deepEqual(await readPersonalRows(), []);

      const tripLedger = await repository.loadAccessibleTripLedger({
        userId: LINKED_USER_ID,
        tripId: TRIP_ID,
      });
      const unchangedTripLedger = structuredClone(tripLedger);
      const canonicalTrip = calculateTripOutcome({
        tripId: TRIP_ID,
        tripVersion: tripLedger.trip.tripVersion,
        members: tripLedger.members.records,
        expenses: legacyCalculatorExpenses(tripLedger.expenses.records),
      });
      assert.equal(canonicalTrip.status, 'available');
      const linkedMember = members[scenario.linkedMemberIndex];
      const expectedShareMinor = canonicalTrip.value.allocations
        .find(({ expenseId }) => expenseId === TRIP_EXPENSE_ID)
        .allocations
        .find(({ memberId }) => memberId === linkedMember.id)
        .amountMinor;
      assert.ok(expectedShareMinor > 0);

      const included = await service.includePersonalExpense({
        userId: LINKED_USER_ID,
        tripId: TRIP_ID,
        tripExpenseId: TRIP_EXPENSE_ID,
        category: scenario.category,
        spentOn,
        idempotencyKey: INCLUDE_KEY,
      });
      assert.equal(included.mutation.replayed, false);
      assert.equal(included.tripVersion, tripLedger.trip.tripVersion);
      assert.equal(included.dataVersion, 1);
      assert.deepEqual(included.tripOutcome, canonicalTrip);
      assertTripLedgerUnchanged(
        await repository.loadAccessibleTripLedger({ userId: LINKED_USER_ID, tripId: TRIP_ID }),
        unchangedTripLedger
      );

      const personalRowsAfterInclude = await readPersonalRows();
      assert.equal(personalRowsAfterInclude.length, 1);
      assert.equal(Number(personalRowsAfterInclude[0].expense_log_id), included.id);
      assert.equal(Number(personalRowsAfterInclude[0].included_amount_minor), expectedShareMinor);
      assert.equal(Number(personalRowsAfterInclude[0].amount), expectedShareMinor / 100);
      assert.equal(personalRowsAfterInclude[0].month, month);
      assert.equal(personalRowsAfterInclude[0].category, scenario.category);
      assert.equal(personalRowsAfterInclude[0].spent_on, spentOn);

      const periodAfterInclude = await repository.loadPeriod({
        userId: LINKED_USER_ID,
        month,
      });
      const planAfterInclude = calculatePlan(periodAfterInclude, spentOn);
      assert.equal(periodAfterInclude.expenses.records.length, 2);
      assert.equal(
        periodAfterInclude.expenses.records.filter(({ id }) => id === included.id).length,
        1
      );
      assert.equal(
        planAfterInclude.applicableExpensesTotalMinor,
        planBeforeTrip.applicableExpensesTotalMinor + expectedShareMinor
      );
      assert.equal(
        planAfterInclude.remainingSpendableMinor,
        planBeforeTrip.remainingSpendableMinor - expectedShareMinor
      );
      assert.equal(
        planAfterInclude.projectedSavingsMinor,
        planBeforeTrip.projectedSavingsMinor - expectedShareMinor
      );
      assert.deepEqual(
        await repository.loadPeriod({ userId: LINKED_USER_ID, month: otherMonth }),
        otherMonthBeforeTrip
      );
      assert.deepEqual(
        await repository.loadPeriod({ userId: UNRELATED_USER_ID, month }),
        unrelatedBeforeTrip
      );

      const includeReplay = await service.includePersonalExpense({
        userId: LINKED_USER_ID,
        tripId: TRIP_ID,
        tripExpenseId: TRIP_EXPENSE_ID,
        category: scenario.category,
        spentOn,
        idempotencyKey: INCLUDE_KEY.toUpperCase(),
      });
      assert.equal(includeReplay.id, included.id);
      assert.equal(includeReplay.mutation.replayed, true);
      assert.equal(includeReplay.dataVersion, included.dataVersion);
      assert.deepEqual(await readPersonalRows(), personalRowsAfterInclude);
      assert.deepEqual(
        await repository.loadPeriod({ userId: LINKED_USER_ID, month }),
        periodAfterInclude
      );
      assert.deepEqual(await readReceipts(), [{
        idempotency_key: INCLUDE_KEY,
        operation: 'trip.personal_link.include',
        record_type: 'trip_personal_link',
        record_id: TRIP_EXPENSE_ID,
        record_version: 1,
        status: 'confirmed',
      }]);
      assertTripLedgerUnchanged(
        await repository.loadAccessibleTripLedger({ userId: LINKED_USER_ID, tripId: TRIP_ID }),
        unchangedTripLedger
      );

      const withdrawn = await service.removePersonalExpense({
        userId: LINKED_USER_ID,
        tripId: TRIP_ID,
        tripExpenseId: TRIP_EXPENSE_ID,
        idempotencyKey: WITHDRAW_KEY,
      });
      assert.equal(withdrawn.mutation.replayed, false);
      assert.equal(withdrawn.tripVersion, tripLedger.trip.tripVersion);
      assert.equal(withdrawn.dataVersion, 2);
      assert.deepEqual(await readPersonalRows(), []);
      const periodAfterWithdraw = await repository.loadPeriod({
        userId: LINKED_USER_ID,
        month,
      });
      assert.deepEqual(periodAfterWithdraw, periodBeforeTrip);
      assert.deepEqual(calculatePlan(periodAfterWithdraw, spentOn), planBeforeTrip);
      assert.deepEqual(
        await repository.loadPeriod({ userId: LINKED_USER_ID, month: otherMonth }),
        otherMonthBeforeTrip
      );
      assert.deepEqual(
        await repository.loadPeriod({ userId: UNRELATED_USER_ID, month }),
        unrelatedBeforeTrip
      );
      assertTripLedgerUnchanged(
        await repository.loadAccessibleTripLedger({ userId: LINKED_USER_ID, tripId: TRIP_ID }),
        unchangedTripLedger
      );

      const withdrawReplay = await service.removePersonalExpense({
        userId: LINKED_USER_ID,
        tripId: TRIP_ID,
        tripExpenseId: TRIP_EXPENSE_ID,
        idempotencyKey: WITHDRAW_KEY,
      });
      assert.equal(withdrawReplay.mutation.replayed, true);
      assert.equal(withdrawReplay.dataVersion, withdrawn.dataVersion);
      assert.deepEqual(await readPersonalRows(), []);
      assert.deepEqual(
        await repository.loadPeriod({ userId: LINKED_USER_ID, month }),
        periodBeforeTrip
      );
      assert.deepEqual(await readReceipts(), [
        {
          idempotency_key: INCLUDE_KEY,
          operation: 'trip.personal_link.include',
          record_type: 'trip_personal_link',
          record_id: TRIP_EXPENSE_ID,
          record_version: 1,
          status: 'confirmed',
        },
        {
          idempotency_key: WITHDRAW_KEY,
          operation: 'trip.personal_link.remove',
          record_type: 'trip_personal_link',
          record_id: TRIP_EXPENSE_ID,
          record_version: 2,
          status: 'reversed',
        },
      ]);
      assertTripLedgerUnchanged(
        await repository.loadAccessibleTripLedger({ userId: LINKED_USER_ID, tripId: TRIP_ID }),
        unchangedTripLedger
      );
    }),
    { numRuns: NUM_RUNS }
  );
});

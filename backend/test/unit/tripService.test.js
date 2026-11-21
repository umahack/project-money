import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createIsolatedTestDatabase } from '../helpers/testDatabase.js';

const NOW = new Date('2026-01-15T06:30:00.000Z');
const OWNER_ID = 8101;
const MEMBER_ID = 8102;
const OUTSIDER_ID = 8103;
const TRIP_ID = 8201;
const OWNER_MEMBER_ID = 8301;
const LINKED_MEMBER_ID = 8302;
const TRIP_EXPENSE_ID = 8401;

let testDatabase;
let db;
let TripService;
let FinancialRepository;

before(async () => {
  testDatabase = await createIsolatedTestDatabase();
  db = testDatabase.db;
  ({ TripService } = await import('../../src/services/tripService.js'));
  ({ FinancialRepository } = await import('../../src/repositories/financialRepository.js'));
  await db.prepare(`CREATE TABLE injected_trip_service_failures (
    id INTEGER PRIMARY KEY,
    allowed INTEGER NOT NULL CHECK (allowed = 1)
  )`).run();
});

beforeEach(async () => {
  await testDatabase.reset();
  await seedTrip();
});

after(async () => {
  await testDatabase?.cleanup();
});

async function seedUser(id) {
  await db.prepare(
    'INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)'
  ).run(id, `trip-service-${id}@example.test`, `Trip User ${id}`, 'test-password-hash');
}

async function seedTrip() {
  for (const userId of [OWNER_ID, MEMBER_ID, OUTSIDER_ID]) await seedUser(userId);
  await db.prepare(
    `INSERT INTO trips (id, user_id, name, destination, budget, start_date, end_date)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(TRIP_ID, OWNER_ID, 'Canonical trip', 'Pune', 5000, '2026-01-10', '2026-01-20');
  await db.prepare(
    'INSERT INTO trip_members (id, trip_id, user_id, name, email) VALUES (?, ?, ?, ?, ?)'
  ).run(OWNER_MEMBER_ID, TRIP_ID, OWNER_ID, 'Owner', 'owner@example.test');
  await db.prepare(
    'INSERT INTO trip_members (id, trip_id, user_id, name, email) VALUES (?, ?, ?, ?, ?)'
  ).run(LINKED_MEMBER_ID, TRIP_ID, MEMBER_ID, 'Member', 'member@example.test');
  await db.prepare(
    `INSERT INTO trip_expenses
      (id, trip_id, payer, description, amount, split_json)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    TRIP_EXPENSE_ID,
    TRIP_ID,
    'Owner',
    'Hotel',
    100.01,
    JSON.stringify([{ name: 'Owner', share: 1 }, { name: 'Member', share: 1 }])
  );
}

function createService(database = db) {
  return new TripService({
    database,
    repository: new FinancialRepository(database),
    fingerprintKey: randomBytes(32),
    clock: () => new Date(NOW),
  });
}

async function count(sql, ...args) {
  const row = await db.prepare(sql).get(...args);
  return Number(row.count);
}

async function version(userId) {
  const row = await db.prepare(
    'SELECT data_version FROM user_financial_state WHERE user_id = ?'
  ).get(userId);
  return row == null ? 0 : Number(row.data_version);
}

test('member and expense writes preserve owner/member/payer authorization and return canonical versions', async () => {
  const service = createService();

  await assert.rejects(
    service.addMember({
      userId: MEMBER_ID,
      tripId: TRIP_ID,
      name: 'Not allowed',
      idempotencyKey: '81000000-0000-4000-8000-000000000001',
    }),
    (error) => error?.code === 'TRIP_NOT_FOUND' && error?.httpStatus === 404
  );

  const memberWrite = await service.addMember({
    userId: OWNER_ID,
    tripId: TRIP_ID,
    name: 'Friend',
    idempotencyKey: '81000000-0000-4000-8000-000000000002',
    expectedTripVersion: 0,
  });
  assert.ok(Number.isSafeInteger(memberWrite.id));
  assert.equal(memberWrite.tripVersion, 1);
  assert.equal(memberWrite.dataVersion, 1);
  assert.equal(memberWrite.tripOutcome.status, 'available');
  assert.equal(await version(MEMBER_ID), 1);

  const expenseWrite = await service.addExpense({
    userId: MEMBER_ID,
    tripId: TRIP_ID,
    payer: 'Owner',
    description: 'Taxi',
    amount: '30.00',
    split: [{ name: 'Owner', share: 1 }, { name: 'Member', share: 2 }],
    idempotencyKey: '81000000-0000-4000-8000-000000000003',
    expectedTripVersion: 1,
  });
  assert.ok(Number.isSafeInteger(expenseWrite.id));
  assert.equal(expenseWrite.tripVersion, 2);
  assert.equal(expenseWrite.dataVersion, 2);
  assert.equal(expenseWrite.tripOutcome.status, 'available');
  assert.equal(
    expenseWrite.tripOutcome.value.balances.reduce((sum, balance) => sum + balance.amountMinor, 0),
    0
  );

  await assert.rejects(
    service.addExpense({
      userId: MEMBER_ID,
      tripId: TRIP_ID,
      payer: 'Owner',
      description: '↔ Settlement: Owner → Member',
      amount: '1.00',
      split: [{ name: 'Member', share: 1 }],
      idempotencyKey: '81000000-0000-4000-8000-000000000004',
    }),
    (error) => error?.code === 'SETTLEMENT_PAYER_NOT_AUTHORIZED' && error?.httpStatus === 403
  );
  assert.equal(await count('SELECT COUNT(*) AS count FROM trip_expenses WHERE trip_id = ?', TRIP_ID), 2);
});

test('personal inclusion and withdrawal are atomic, isolated, and idempotent', async () => {
  const service = createService();
  const includeKey = '82000000-0000-4000-8000-000000000001';
  const removeKey = '82000000-0000-4000-8000-000000000002';

  const included = await service.includePersonalExpense({
    userId: MEMBER_ID,
    tripId: TRIP_ID,
    tripExpenseId: TRIP_EXPENSE_ID,
    category: 'Travel',
    spentOn: '2026-01-12',
    idempotencyKey: includeKey,
  });
  const replay = await service.includePersonalExpense({
    userId: MEMBER_ID,
    tripId: TRIP_ID,
    tripExpenseId: TRIP_EXPENSE_ID,
    category: 'Travel',
    spentOn: '2026-01-12',
    idempotencyKey: includeKey.toUpperCase(),
  });

  assert.equal(included.id, replay.id);
  assert.equal(included.tripVersion, 0);
  assert.equal(replay.tripVersion, 0);
  assert.equal(included.dataVersion, 1);
  assert.equal(replay.dataVersion, 1);
  assert.equal(replay.mutation.replayed, true);
  assert.equal(await count('SELECT COUNT(*) AS count FROM trip_expense_personal_links'), 1);
  assert.equal(await count('SELECT COUNT(*) AS count FROM expense_log WHERE user_id = ?', MEMBER_ID), 1);
  assert.equal(await count('SELECT COUNT(*) AS count FROM trip_expenses WHERE trip_id = ?', TRIP_ID), 1);

  const link = await db.prepare(
    `SELECT link.included_amount_minor, expense.amount, expense.month, expense.category, expense.spent_on
       FROM trip_expense_personal_links link
       JOIN expense_log expense ON expense.id = link.expense_log_id
      WHERE link.user_id = ? AND link.trip_expense_id = ?`
  ).get(MEMBER_ID, TRIP_EXPENSE_ID);
  assert.equal(Number(link.included_amount_minor), 5001);
  assert.equal(Number(link.amount), 50.01);
  assert.equal(link.month, '2026-01');
  assert.equal(link.category, 'Travel');
  assert.equal(link.spent_on, '2026-01-12');

  const removed = await service.removePersonalExpense({
    userId: MEMBER_ID,
    tripId: TRIP_ID,
    tripExpenseId: TRIP_EXPENSE_ID,
    idempotencyKey: removeKey,
  });
  const removeReplay = await service.removePersonalExpense({
    userId: MEMBER_ID,
    tripId: TRIP_ID,
    tripExpenseId: TRIP_EXPENSE_ID,
    idempotencyKey: removeKey,
  });

  assert.equal(removed.dataVersion, 2);
  assert.equal(removeReplay.dataVersion, 2);
  assert.equal(removeReplay.mutation.replayed, true);
  assert.equal(await count('SELECT COUNT(*) AS count FROM trip_expense_personal_links'), 0);
  assert.equal(await count('SELECT COUNT(*) AS count FROM expense_log WHERE user_id = ?', MEMBER_ID), 0);
  assert.equal(await count('SELECT COUNT(*) AS count FROM trip_expenses WHERE trip_id = ?', TRIP_ID), 1);
});

test('an injected linked-write failure rolls back expense, link, receipt, and financial version', async () => {
  const failingDatabase = {
    prepare: db.prepare.bind(db),
    batch(statements, mode) {
      const injected = [...statements];
      injected.splice(2, 0, {
        sql: 'INSERT INTO injected_trip_service_failures (id, allowed) VALUES (?, ?)',
        args: [1, 0],
      });
      return db.batch(injected, mode);
    },
  };
  const service = createService(failingDatabase);

  await assert.rejects(
    service.includePersonalExpense({
      userId: MEMBER_ID,
      tripId: TRIP_ID,
      tripExpenseId: TRIP_EXPENSE_ID,
      category: 'Travel',
      spentOn: '2026-01-12',
      idempotencyKey: '83000000-0000-4000-8000-000000000001',
    }),
    (error) => error?.code === 'TRIP_MUTATION_FAILED' && error?.httpStatus === 500
  );

  assert.equal(await count('SELECT COUNT(*) AS count FROM trip_expense_personal_links'), 0);
  assert.equal(await count('SELECT COUNT(*) AS count FROM expense_log WHERE user_id = ?', MEMBER_ID), 0);
  assert.equal(await count('SELECT COUNT(*) AS count FROM financial_record_changes'), 0);
  assert.equal(await version(MEMBER_ID), 0);
});

test('personal inclusion is denied for outsiders and settlement rows', async () => {
  const service = createService();
  await assert.rejects(
    service.includePersonalExpense({
      userId: OUTSIDER_ID,
      tripId: TRIP_ID,
      tripExpenseId: TRIP_EXPENSE_ID,
      category: 'Travel',
      spentOn: '2026-01-12',
      idempotencyKey: '84000000-0000-4000-8000-000000000001',
    }),
    (error) => error?.code === 'TRIP_NOT_FOUND' && error?.httpStatus === 404
  );

  const settlement = await service.addExpense({
    userId: OWNER_ID,
    tripId: TRIP_ID,
    payer: 'Member',
    description: '↔ Settlement: Member → Owner',
    amount: '10.00',
    split: [{ name: 'Owner', share: 1 }],
    idempotencyKey: '84000000-0000-4000-8000-000000000002',
  });
  await assert.rejects(
    service.includePersonalExpense({
      userId: MEMBER_ID,
      tripId: TRIP_ID,
      tripExpenseId: settlement.id,
      category: 'Travel',
      spentOn: '2026-01-12',
      idempotencyKey: '84000000-0000-4000-8000-000000000003',
    }),
    (error) => error?.code === 'PERSONAL_LINK_NOT_ELIGIBLE' && error?.httpStatus === 422
  );
});

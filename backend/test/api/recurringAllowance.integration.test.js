import '../helpers/blockingStdout.js';
import { after, before, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createIsolatedTestDatabase } from '../helpers/testDatabase.js';
import { buildSessionFixture, buildUserFixture } from '../helpers/fixtures.js';
import { createTestClock, TEST_INSTANT } from '../helpers/time.js';

/**
 * Recurring_Auto_Post through the real app (spec: quick-add-daily-answer,
 * task 9.3; requirements 10.9, 17.18, 17.28, 18.23, 18.24, 18.25).
 *
 * `materializeRecurring` reads the process clock, so the process Date is fixed
 * with `mock.timers` at the shared test instant (Thursday 2026-01-15 12:00 in
 * Asia/Kolkata; the isolated database sets TZ=Asia/Kolkata). January has 31
 * days, so Days_Remaining_Inclusive is 17. Every server flag is off (the
 * isolated-database default) for the whole file. Synthetic data only.
 */
const OWNER_ID = 9301;
const OWNER_SESSION_ID = 9311;
const NOTICE_FREE_ID = 9302;
const NOTICE_FREE_SESSION_ID = 9312;
const MONTH = '2026-01';
const TODAY = '2026-01-15';
const OTHER_DAY = '2026-01-10';
const DAYS_REMAINING = 17;
const SALARY = 100_000;
const BILLS = 20_000;
const RECURRING_AMOUNT = 1_500;
const RECURRING_MINOR = 150_000;

let testDatabase;
let db;
let app;
let authorization;
let keyCounter = 0;

function nextKey() {
  keyCounter += 1;
  return `93000000-0000-4000-8000-${String(keyCounter).padStart(12, '0')}`;
}

function tokenFor(userId, sessionId) {
  return `Bearer ${jwt.sign(
    { sub: String(userId), tv: 1, sid: sessionId },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '5m' }
  )}`;
}

async function insertAccount(userId, sessionId, email, noticeVersion) {
  const user = buildUserFixture({ id: userId, email });
  const session = buildSessionFixture({ userId, id: sessionId, ip_hash: `recurring-allowance-${userId}` });
  await db.prepare(
    `INSERT INTO users (id, email, name, password_hash, is_admin, token_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(user.id, user.email, user.name, user.password_hash, user.is_admin, user.token_version, user.created_at);
  await db.prepare(
    `INSERT INTO sessions
      (id, user_id, device_label, ip_hash, user_agent, created_at, last_seen_at, revoked_at, revoked_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    session.id, session.user_id, session.device_label, session.ip_hash, session.user_agent,
    session.created_at, session.last_seen_at, session.revoked_at, session.revoked_reason
  );
  if (noticeVersion !== null) {
    await db.prepare(
      `INSERT INTO user_financial_state (user_id, data_use_notice_version, data_use_acknowledged_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)`
    ).run(userId, noticeVersion);
  }
}

async function seedPlan(userId) {
  await db.prepare('INSERT INTO salary_entries (user_id, month, amount) VALUES (?, ?, ?)')
    .run(userId, MONTH, SALARY);
  await db.prepare(
    'INSERT INTO emis (user_id, label, amount, category, active) VALUES (?, ?, ?, ?, 1)'
  ).run(userId, 'Fixed bill', BILLS, 'Rent');
}

async function addRecurring(userId, { label, category, amount = RECURRING_AMOUNT, day = 15 }) {
  await db.prepare(
    `INSERT INTO recurring_expenses (user_id, label, amount, category, day_of_month, active)
     VALUES (?, ?, ?, ?, ?, 1)`
  ).run(userId, label, amount, category, day);
}

/** The legacy list read that triggers the unchanged materialize-on-read logic. */
function listExpenses(token = authorization, { contract = false } = {}) {
  let builder = request(app).get(`/api/finance/expenses?month=${MONTH}`).set('Authorization', token);
  if (contract) builder = builder.set('X-Clarity-Contract', '1');
  return builder;
}

async function clarity(token = authorization) {
  const response = await request(app)
    .get(`/api/finance/clarity?month=${MONTH}`)
    .set('Authorization', token)
    .set('X-Clarity-Contract', '1');
  assert.equal(response.status, 200);
  const { outcomes } = response.body.snapshot;
  assert.equal(outcomes.todayAllowance.status, 'available');
  return {
    allowance: outcomes.todayAllowance.value,
    plan: outcomes.monthlyPlan.value,
    spending: outcomes.spending.value,
  };
}

function patchExpense(id, body) {
  return request(app)
    .patch(`/api/finance/expenses/${id}`)
    .set('Authorization', authorization)
    .set('X-Clarity-Contract', '1')
    .set('Idempotency-Key', nextKey())
    .send(body);
}

async function expenseRows(userId = OWNER_ID) {
  return db.prepare(
    `SELECT id, month, category, amount, note, spent_on, exclude_from_daily_allowance
       FROM expense_log WHERE user_id = ? ORDER BY id`
  ).all(userId);
}

const minor = (money) => money.amountMinor;
const categoryTotal = (spending, category) => {
  const entry = spending.categoryTotals.find((item) => item.category === category);
  return entry ? entry.total.amountMinor : 0;
};

before(async () => {
  testDatabase = await createIsolatedTestDatabase();
  db = testDatabase.db;
  process.env.FINANCIAL_MUTATION_HMAC_KEY =
    'test-only-financial-mutation-hmac-key-32-bytes-minimum';
  // Every flag is off in this file; assert it rather than assume it.
  assert.equal(process.env.QUICK_ADD_ENABLED, 'false');
  assert.equal(process.env.CLARITY_SHADOW_COMPARE, 'false');
  const clock = createTestClock(TEST_INSTANT);
  mock.timers.enable({ apis: ['Date'], now: clock.now().getTime() });
  const { createApp } = await import('../../src/app.js');
  app = createApp();
});

beforeEach(async () => {
  await testDatabase.reset();
  await insertAccount(OWNER_ID, OWNER_SESSION_ID, 'recurring-allowance@example.test', 1);
  authorization = tokenFor(OWNER_ID, OWNER_SESSION_ID);
  await seedPlan(OWNER_ID);
});

after(async () => {
  mock.timers.reset();
  await testDatabase?.cleanup();
});

for (const { category, bucket } of [
  { category: 'Bills', bucket: 'needsSpent' },
  { category: 'Entertainment', bucket: 'wantsSpent' },
]) {
  test(`a ${category} definition due today posts one marked expense that counts in every monthly value but not in Today_Spent`, async () => {
    await addRecurring(OWNER_ID, { label: 'Auto bill', category });
    const baseline = await clarity();
    assert.equal(baseline.allowance.date, TODAY);
    assert.equal(baseline.allowance.daysRemainingInclusive, DAYS_REMAINING);
    assert.equal(minor(baseline.spending.totalSpending), 0);

    const response = await listExpenses();
    assert.equal(response.status, 200);
    assert.equal(response.body.expenses.length, 1);
    // The legacy list shape is unchanged: no contract header, no mark field.
    assert.equal('excludeFromDailyAllowance' in response.body.expenses[0], false);

    const rows = await expenseRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].note, 'Auto bill (recurring)');
    assert.equal(rows[0].category, category);
    assert.equal(Number(rows[0].amount), RECURRING_AMOUNT);
    assert.equal(rows[0].spent_on, TODAY);
    assert.equal(rows[0].month, MONTH);
    assert.equal(Number(rows[0].exclude_from_daily_allowance), 1);

    const contractList = await listExpenses(authorization, { contract: true });
    assert.equal(contractList.body.expenses.length, 1);
    assert.equal(contractList.body.expenses[0].excludeFromDailyAllowance, true);

    const marked = await clarity();
    // Today_Spent excludes it; it is reported as excluded today.
    assert.equal(minor(marked.allowance.todaySpent), 0);
    assert.deepEqual(marked.allowance.excludedToday, {
      count: 1,
      total: { currency: 'INR', amountMinor: RECURRING_MINOR },
    });
    // The allowance drops by exactly the amount spread over the remaining days.
    assert.equal(
      minor(baseline.allowance.allowanceBasis) - minor(marked.allowance.allowanceBasis),
      RECURRING_MINOR
    );
    assert.ok(minor(marked.allowance.todayAllowance) < minor(baseline.allowance.todayAllowance));
    assert.equal(
      minor(marked.allowance.todayAllowance),
      Math.floor((minor(marked.allowance.allowanceBasis) * 2 + DAYS_REMAINING) / (DAYS_REMAINING * 2))
    );
    // Monthly values include it.
    assert.equal(categoryTotal(marked.spending, category), RECURRING_MINOR);
    assert.equal(minor(marked.spending.totalSpending), RECURRING_MINOR);
    assert.equal(minor(marked.spending[bucket]), RECURRING_MINOR);
    assert.equal(
      minor(baseline.plan.projectedSavings) - minor(marked.plan.projectedSavings),
      RECURRING_MINOR
    );
    assert.equal(
      minor(baseline.plan.remainingSpendable) - minor(marked.plan.remainingSpendable),
      RECURRING_MINOR
    );

    // Same amount, category, and note on another day, unmarked: identical allowance and monthly values.
    await db.prepare('DELETE FROM expense_log WHERE user_id = ?').run(OWNER_ID);
    await db.prepare(
      `INSERT INTO expense_log (user_id, month, category, amount, note, spent_on)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(OWNER_ID, MONTH, category, RECURRING_AMOUNT, 'Auto bill (recurring)', OTHER_DAY);
    const otherDay = await clarity();
    assert.deepEqual(otherDay.allowance.todayAllowance, marked.allowance.todayAllowance);
    assert.deepEqual(otherDay.allowance.allowanceBasis, marked.allowance.allowanceBasis);
    assert.deepEqual(otherDay.allowance.leftToday, marked.allowance.leftToday);
    assert.deepEqual(otherDay.allowance.todaySpent, marked.allowance.todaySpent);
    assert.deepEqual(otherDay.allowance.excludedToday, { count: 0, total: { currency: 'INR', amountMinor: 0 } });
    assert.deepEqual(otherDay.spending.categoryTotals.map(({ category: name, total }) => [name, total]),
      marked.spending.categoryTotals.map(({ category: name, total }) => [name, total]));
    assert.deepEqual(otherDay.spending.totalSpending, marked.spending.totalSpending);
    assert.deepEqual(otherDay.spending[bucket], marked.spending[bucket]);
    assert.deepEqual(otherDay.plan.projectedSavings, marked.plan.projectedSavings);
    assert.deepEqual(otherDay.plan.remainingSpendable, marked.plan.remainingSpendable);
  });
}

test('a second read in the same month posts nothing more and the definition is claimed once', async () => {
  await addRecurring(OWNER_ID, { label: 'Auto bill', category: 'Bills' });
  await listExpenses();
  await listExpenses();
  await request(app).get('/api/finance/recurring').set('Authorization', authorization);
  assert.equal((await expenseRows()).length, 1);
  const definition = await db.prepare(
    'SELECT last_logged_month FROM recurring_expenses WHERE user_id = ?'
  ).get(OWNER_ID);
  assert.equal(definition.last_logged_month, MONTH);
});

test('an amount-only correction keeps the mark, and clearing it makes the expense counted from then on', async () => {
  await addRecurring(OWNER_ID, { label: 'Auto bill', category: 'Bills' });
  const noExpense = await clarity();
  await listExpenses();
  const [{ id }] = await expenseRows();
  const initial = await clarity();

  // Amount-only PATCH: the mark stays, so the expense stays outside Today_Spent.
  const corrected = await patchExpense(id, { amount: '900.00', expectedRecordVersion: 0 });
  assert.equal(corrected.status, 200);
  let [row] = await expenseRows();
  assert.equal(Number(row.amount), 900);
  assert.equal(Number(row.exclude_from_daily_allowance), 1);
  const afterAmount = await clarity();
  assert.equal(minor(afterAmount.allowance.todaySpent), 0);
  assert.deepEqual(afterAmount.allowance.excludedToday, {
    count: 1,
    total: { currency: 'INR', amountMinor: 90_000 },
  });
  assert.equal(minor(afterAmount.spending.totalSpending), 90_000);
  // Lowering the amount by 600 rupees raises the basis by exactly that amount.
  assert.equal(
    minor(afterAmount.allowance.allowanceBasis) - minor(initial.allowance.allowanceBasis),
    RECURRING_MINOR - 90_000
  );
  const contractList = await listExpenses(authorization, { contract: true });
  assert.equal(contractList.body.expenses[0].excludeFromDailyAllowance, true);

  // Clearing the mark with an explicit false: the expense is now counted.
  const cleared = await patchExpense(id, { excludeFromDailyAllowance: false, expectedRecordVersion: 1 });
  assert.equal(cleared.status, 200);
  [row] = await expenseRows();
  assert.equal(row.exclude_from_daily_allowance, null);
  const afterClear = await clarity();
  assert.equal(minor(afterClear.allowance.todaySpent), 90_000);
  assert.deepEqual(afterClear.allowance.excludedToday, { count: 0, total: { currency: 'INR', amountMinor: 0 } });
  assert.equal(
    minor(afterClear.allowance.leftToday),
    minor(afterClear.allowance.todayAllowance) - 90_000
  );
  // Once counted, the expense is in Today_Spent, so the basis gains it back and the allowance
  // equals what it was before the expense existed (10.8); Left_Today falls by the amount.
  assert.equal(
    minor(afterClear.allowance.allowanceBasis) - minor(afterAmount.allowance.allowanceBasis),
    90_000
  );
  assert.deepEqual(afterClear.allowance.allowanceBasis, noExpense.allowance.allowanceBasis);
  assert.deepEqual(afterClear.allowance.todayAllowance, noExpense.allowance.todayAllowance);
  // Clearing changes no amount, total, or projection (10.20, 18.12).
  assert.deepEqual(afterClear.spending.totalSpending, afterAmount.spending.totalSpending);
  assert.deepEqual(afterClear.spending.categoryTotals, afterAmount.spending.categoryTotals);
  assert.deepEqual(afterClear.spending.needsSpent, afterAmount.spending.needsSpent);
  assert.deepEqual(afterClear.plan.projectedSavings, afterAmount.plan.projectedSavings);
  assert.deepEqual(afterClear.plan.remainingSpendable, afterAmount.plan.remainingSpendable);
  assert.deepEqual(afterClear.plan.dailySpendingGuide, afterAmount.plan.dailySpendingGuide);
  const clearedList = await listExpenses(authorization, { contract: true });
  assert.equal(clearedList.body.expenses[0].excludeFromDailyAllowance, false);

  // A later correction of amount, category, and note leaves the cleared mark cleared (18.24),
  // and reading again does not post the definition a second time.
  const later = await patchExpense(id, {
    amount: '800.00',
    category: 'Groceries',
    note: 'Corrected note',
    expectedRecordVersion: 2,
  });
  assert.equal(later.status, 200);
  const rows = await expenseRows();
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].amount), 800);
  assert.equal(rows[0].exclude_from_daily_allowance, null);
  await listExpenses();
  assert.equal((await expenseRows()).length, 1);
  const afterLater = await clarity();
  assert.equal(minor(afterLater.allowance.todaySpent), 80_000);
});

test('with every flag off and the data-use notice unacknowledged the legacy read still posts the mark', async () => {
  await insertAccount(NOTICE_FREE_ID, NOTICE_FREE_SESSION_ID, 'recurring-no-notice@example.test', null);
  await addRecurring(NOTICE_FREE_ID, { label: 'No notice rent', category: 'Bills', amount: 700, day: 1 });
  const response = await listExpenses(tokenFor(NOTICE_FREE_ID, NOTICE_FREE_SESSION_ID));
  assert.equal(response.status, 200);
  const rows = await expenseRows(NOTICE_FREE_ID);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].note, 'No notice rent (recurring)');
  assert.equal(rows[0].spent_on, `${MONTH}-01`);
  assert.equal(Number(rows[0].amount), 700);
  assert.equal(Number(rows[0].exclude_from_daily_allowance), 1);
  // A definition due after today stays unposted.
  await addRecurring(NOTICE_FREE_ID, { label: 'Later bill', category: 'Bills', amount: 50, day: 20 });
  await listExpenses(tokenFor(NOTICE_FREE_ID, NOTICE_FREE_SESSION_ID));
  assert.equal((await expenseRows(NOTICE_FREE_ID)).length, 1);
});

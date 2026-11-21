import { after, afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createIsolatedTestDatabase } from '../helpers/testDatabase.js';
import {
  buildLegacyCharacterizationFixtures,
  buildSessionFixture,
  buildUserFixture,
} from '../helpers/fixtures.js';

let testDatabase;
let db;
let app;
let accounts;
let legacy;

function sortedKeys(value) {
  return Object.keys(value).sort();
}

function assertKeys(value, expected) {
  assert.deepEqual(sortedKeys(value), [...expected].sort());
}

function monthAtOffset(offset) {
  const date = new Date();
  date.setDate(1);
  date.setMonth(date.getMonth() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

async function insertAccount(user, session) {
  await db.prepare(
    `INSERT INTO users
      (id, email, name, password_hash, is_admin, token_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    user.id,
    user.email,
    user.name,
    user.password_hash,
    user.is_admin,
    user.token_version,
    user.created_at
  );
  await db.prepare(
    `INSERT INTO sessions
      (id, user_id, device_label, ip_hash, user_agent, created_at, last_seen_at, revoked_at, revoked_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    session.id,
    session.user_id,
    session.device_label,
    session.ip_hash,
    session.user_agent,
    session.created_at,
    session.last_seen_at,
    session.revoked_at,
    session.revoked_reason
  );
}

async function seedAccounts() {
  const owner = buildUserFixture({ id: 101, email: 'owner@example.test', name: 'Fixture Owner' });
  const member = buildUserFixture({ id: 102, email: 'member@example.test', name: 'Fixture Member' });
  const outsider = buildUserFixture({ id: 103, email: 'outsider@example.test', name: 'Fixture Outsider' });
  const ownerSession = buildSessionFixture({ userId: owner.id, id: 201 });
  const memberSession = buildSessionFixture({ userId: member.id, id: 202 });
  const outsiderSession = buildSessionFixture({ userId: outsider.id, id: 203 });

  for (const [user, session] of [
    [owner, ownerSession],
    [member, memberSession],
    [outsider, outsiderSession],
  ]) {
    await insertAccount(user, session);
  }

  return { owner, member, outsider, ownerSession, memberSession, outsiderSession };
}

function tokenFor(user, session) {
  return jwt.sign(
    { sub: String(user.id), tv: user.token_version, sid: session.id },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '5m' }
  );
}

function authFor(user, session) {
  return `Bearer ${tokenFor(user, session)}`;
}

async function insertSalary(salary) {
  await db.prepare(
    'INSERT INTO salary_entries (id, user_id, month, amount, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(salary.id, salary.user_id, salary.month, salary.amount, salary.created_at);
}

async function insertBill(bill) {
  await db.prepare(
    'INSERT INTO emis (id, user_id, label, amount, category, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(bill.id, bill.user_id, bill.label, bill.amount, bill.category, bill.created_at);
}

async function insertExpense(expense) {
  await db.prepare(
    `INSERT INTO expense_log
      (id, user_id, month, category, amount, note, spent_on, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    expense.id,
    expense.user_id,
    expense.month,
    expense.category,
    expense.amount,
    expense.note,
    expense.spent_on,
    expense.created_at
  );
}

async function insertPlanCase(planCase) {
  if (planCase.salary) await insertSalary(planCase.salary);
  for (const salary of planCase.salaries ?? []) await insertSalary(salary);
  for (const bill of planCase.bills ?? []) await insertBill(bill);
  for (const expense of planCase.expenses ?? []) await insertExpense(expense);
}

async function insertTrip(graph) {
  const { trip, members, expenses } = graph;
  await db.prepare(
    `INSERT INTO trips
      (id, user_id, name, destination, budget, start_date, end_date, public_token, public_enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    trip.id,
    trip.user_id,
    trip.name,
    trip.destination,
    trip.budget,
    trip.start_date,
    trip.end_date,
    trip.public_token,
    trip.public_enabled,
    trip.created_at
  );
  for (const member of members) {
    await db.prepare(
      'INSERT INTO trip_members (id, trip_id, user_id, name, email) VALUES (?, ?, ?, ?, ?)'
    ).run(member.id, member.trip_id, member.user_id, member.name, member.email);
  }
  for (const expense of expenses) {
    await db.prepare(
      `INSERT INTO trip_expenses
        (id, trip_id, payer, description, amount, split_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      expense.id,
      expense.trip_id,
      expense.payer,
      expense.description,
      expense.amount,
      expense.split_json,
      expense.created_at
    );
  }
}

async function resetScenario() {
  await testDatabase.reset();
  accounts = await seedAccounts();
  legacy = buildLegacyCharacterizationFixtures({
    userId: accounts.owner.id,
    memberUserId: accounts.member.id,
    currentMonth: monthAtOffset(0),
    previousMonth: monthAtOffset(-1),
    nextMonth: monthAtOffset(1),
  });
}

before(async () => {
  testDatabase = await createIsolatedTestDatabase();
  db = testDatabase.db;
  const { createApp } = await import('../../src/app.js');
  // Supertest owns and closes its ephemeral listener for each request. Keeping
  // a shared listener here adds no coverage and can keep the test process alive.
  app = createApp();
});

beforeEach(resetScenario);

afterEach(async () => {
  // authRequired updates session activity asynchronously.
  await new Promise((resolve) => setImmediate(resolve));
});

after(async () => {
  await testDatabase?.cleanup();
});

test('legacy finance CRUD routes retain their top-level response fields and funded-goal boundary', async () => {
  const authorization = authFor(accounts.owner, accounts.ownerSession);
  const currentMonth = monthAtOffset(0);

  const salaryWrite = await request(app)
    .post('/api/finance/salary')
    .set('Authorization', authorization)
    .send({ amount: 75_000, month: currentMonth });
  assert.equal(salaryWrite.status, 200);
  assertKeys(salaryWrite.body, ['ok', 'month', 'amount']);

  const salaryRead = await request(app)
    .get('/api/finance/salary')
    .set('Authorization', authorization);
  assert.equal(salaryRead.status, 200);
  assertKeys(salaryRead.body, ['salary']);
  assertKeys(salaryRead.body.salary, ['month', 'amount']);

  const billWrite = await request(app)
    .post('/api/finance/emis')
    .set('Authorization', authorization)
    .send({ label: 'Fixture rent', amount: 25_000, category: 'Rent' });
  assert.equal(billWrite.status, 200);
  assertKeys(billWrite.body, ['id']);

  const billsRead = await request(app)
    .get('/api/finance/emis')
    .set('Authorization', authorization);
  assert.equal(billsRead.status, 200);
  assertKeys(billsRead.body, ['emis']);
  assertKeys(billsRead.body.emis[0], ['id', 'label', 'amount', 'category']);

  const billUpdate = await request(app)
    .patch(`/api/finance/emis/${billWrite.body.id}`)
    .set('Authorization', authorization)
    .send({ category: 'Utility' });
  assert.equal(billUpdate.status, 200);
  assertKeys(billUpdate.body, ['ok', 'emi']);
  assertKeys(billUpdate.body.emi, ['id', 'label', 'amount', 'category']);

  const expenseWrite = await request(app)
    .post('/api/finance/expenses')
    .set('Authorization', authorization)
    .send({ amount: 825.5, category: 'Food', note: 'Synthetic fixture', spentOn: `${currentMonth}-01` });
  assert.equal(expenseWrite.status, 200);
  assertKeys(expenseWrite.body, ['id', 'month']);

  const expensesRead = await request(app)
    .get(`/api/finance/expenses?month=${currentMonth}`)
    .set('Authorization', authorization);
  assert.equal(expensesRead.status, 200);
  assertKeys(expensesRead.body, ['month', 'categories', 'expenses']);
  assertKeys(expensesRead.body.expenses[0], [
    'id',
    'month',
    'category',
    'amount',
    'note',
    'spent_on',
    'created_at',
  ]);

  const goal = legacy.fundedGoal;
  const goalWrite = await request(app)
    .post('/api/finance/goals')
    .set('Authorization', authorization)
    .send({
      name: goal.name,
      targetAmount: goal.target_amount,
      savedAmount: goal.saved_amount,
      targetDate: goal.target_date,
    });
  assert.equal(goalWrite.status, 200);
  assertKeys(goalWrite.body, ['id']);

  const goalsRead = await request(app)
    .get('/api/finance/goals')
    .set('Authorization', authorization);
  assert.equal(goalsRead.status, 200);
  assertKeys(goalsRead.body, ['goals']);
  assertKeys(goalsRead.body.goals[0], [
    'id',
    'name',
    'target_amount',
    'saved_amount',
    'target_date',
    'created_at',
    'updated_at',
  ]);
  assert.equal(goalsRead.body.goals[0].saved_amount, goalsRead.body.goals[0].target_amount);

  const expenseDelete = await request(app)
    .delete(`/api/finance/expenses/${expenseWrite.body.id}`)
    .set('Authorization', authorization);
  const billDelete = await request(app)
    .delete(`/api/finance/emis/${billWrite.body.id}`)
    .set('Authorization', authorization);
  const goalDelete = await request(app)
    .delete(`/api/finance/goals/${goalWrite.body.id}`)
    .set('Authorization', authorization);
  for (const response of [expenseDelete, billDelete, goalDelete]) {
    assert.equal(response.status, 200);
    assertKeys(response.body, ['ok']);
  }
});

test('legacy plan preserves empty, equal-bill, and excess-bill calculations', async (t) => {
  const cases = [
    { name: 'empty records', fixture: 'empty', income: 0, emiTotal: 0 },
    { name: 'bills equal salary', fixture: 'equal', income: 50_000, emiTotal: 50_000 },
    { name: 'bills exceed salary', fixture: 'excess', income: 50_000, emiTotal: 60_000 },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      await resetScenario();
      await insertPlanCase(legacy.planCases[scenario.fixture]);
      const response = await request(app)
        .get('/api/finance/plan')
        .set('Authorization', authFor(accounts.owner, accounts.ownerSession));

      assert.equal(response.status, 200);
      assertKeys(response.body, [
        'income',
        'emiTotal',
        'afterFixed',
        'breakdown',
        'month',
        'spentThisMonth',
        'byCategory',
        'tips',
      ]);
      assertKeys(response.body.breakdown, ['needs', 'wants', 'save']);
      assert.equal(response.body.income, scenario.income);
      assert.equal(response.body.emiTotal, scenario.emiTotal);
      assert.equal(response.body.afterFixed, 0);
      assert.deepEqual(response.body.breakdown, { needs: 0, wants: 0, save: 0 });
      assert.equal('shortfall' in response.body, false);
    });
  }
});

test('legacy plan uses the latest salary but isolates expense totals at a month boundary', async () => {
  await insertPlanCase(legacy.planCases.monthBoundary);
  const authorization = authFor(accounts.owner, accounts.ownerSession);
  const currentMonth = monthAtOffset(0);
  const previousMonth = monthAtOffset(-1);

  const plan = await request(app)
    .get('/api/finance/plan')
    .set('Authorization', authorization);
  assert.equal(plan.status, 200);
  assert.equal(plan.body.month, currentMonth);
  assert.equal(plan.body.income, legacy.planCases.monthBoundary.salaries[1].amount);
  assert.equal(plan.body.spentThisMonth, legacy.planCases.monthBoundary.expenses[1].amount);
  assert.equal(plan.body.byCategory.Food, legacy.planCases.monthBoundary.expenses[1].amount);

  const previousExpenses = await request(app)
    .get(`/api/finance/expenses?month=${previousMonth}`)
    .set('Authorization', authorization);
  const currentExpenses = await request(app)
    .get(`/api/finance/expenses?month=${currentMonth}`)
    .set('Authorization', authorization);
  assert.equal(previousExpenses.body.expenses.length, 1);
  assert.equal(currentExpenses.body.expenses.length, 1);
  assert.notEqual(previousExpenses.body.expenses[0].id, currentExpenses.body.expenses[0].id);
});

test('private trip detail allows owner and accepted member while hiding existence from outsiders', async () => {
  await insertTrip(legacy.trip);

  const ownerView = await request(app)
    .get(`/api/trips/${legacy.trip.trip.id}`)
    .set('Authorization', authFor(accounts.owner, accounts.ownerSession));
  const memberView = await request(app)
    .get(`/api/trips/${legacy.trip.trip.id}`)
    .set('Authorization', authFor(accounts.member, accounts.memberSession));
  const outsiderView = await request(app)
    .get(`/api/trips/${legacy.trip.trip.id}`)
    .set('Authorization', authFor(accounts.outsider, accounts.outsiderSession));
  const anonymousView = await request(app).get(`/api/trips/${legacy.trip.trip.id}`);

  assert.equal(ownerView.status, 200);
  assert.equal(memberView.status, 200);
  assert.equal(ownerView.body.role, 'owner');
  assert.equal(memberView.body.role, 'member');
  assertKeys(ownerView.body, ['trip', 'role', 'members', 'expenses', 'settlement']);
  assertKeys(ownerView.body.expenses[0], ['id', 'payer', 'description', 'amount', 'created_at', 'split']);
  assertKeys(ownerView.body.settlement, ['balances', 'transactions']);
  const balanceTotal = Object.values(ownerView.body.settlement.balances)
    .reduce((sum, amount) => sum + Number(amount), 0);
  assert.equal(balanceTotal, 0);

  assert.equal(outsiderView.status, 404);
  assert.deepEqual(outsiderView.body, { error: 'Not found' });
  assert.equal(anonymousView.status, 401);
  assert.deepEqual(anonymousView.body, { error: 'Missing token' });
});

test('public trip contract is allowlisted, canonical, and excludes internal linkage', async () => {
  await insertTrip(legacy.trip);
  await db.prepare(
    `INSERT INTO trip_expenses
      (id, trip_id, payer, description, amount, split_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    562,
    legacy.trip.trip.id,
    'Fixture Owner',
    'One-paise rounding fixture',
    0.01,
    JSON.stringify([
      { name: 'Fixture Owner', share: 1, user_id: accounts.owner.id },
      { name: 'Fixture Member', share: 1, email: accounts.member.email },
    ]),
    '2026-02-01T12:00:00.000Z'
  );

  const response = await request(app).get(`/api/public/trips/${legacy.publicToken}`);

  assert.equal(response.status, 200);
  assertKeys(response.body, ['trip', 'members', 'expenses', 'settlement']);
  assertKeys(response.body.trip, ['name', 'destination', 'budget', 'start_date', 'end_date']);
  assertKeys(response.body.members[0], ['name']);
  assertKeys(response.body.expenses[0], ['payer', 'description', 'amount', 'created_at', 'split']);
  assertKeys(response.body.expenses[0].split[0], ['name', 'share']);
  assertKeys(response.body.settlement, ['balances', 'transactions']);
  assertKeys(response.body.settlement.transactions[0], ['from', 'to', 'amount']);
  assert.deepEqual(response.body.settlement.balances, {
    'Fixture Owner': 3000.01,
    'Fixture Member': -3000.01,
  });
  assert.deepEqual(response.body.settlement.transactions, [{
    from: 'Fixture Member',
    to: 'Fixture Owner',
    amount: 3000.01,
  }]);
  assert.equal('email' in response.body.members[0], false);
  assert.equal('id' in response.body.trip, false);
  assert.equal('id' in response.body.members[0], false);
  assert.equal('id' in response.body.expenses[0], false);
  assert.equal('split_json' in response.body.expenses[0], false);
  assert.equal(JSON.stringify(response.body).includes(accounts.member.email), false);
});

test('disabled, rotated, revoked, unknown, and malformed public tokens share a constant 404', async () => {
  await insertTrip(legacy.trip);
  const originalPath = `/api/public/trips/${legacy.publicToken}`;
  const authorization = authFor(accounts.owner, accounts.ownerSession);
  const privateBefore = await request(app)
    .get(`/api/trips/${legacy.trip.trip.id}`)
    .set('Authorization', authorization);
  assert.equal(privateBefore.status, 200);
  const privateIdsBefore = {
    memberIds: privateBefore.body.members.map((member) => member.id).sort((a, b) => a - b),
    expenseIds: privateBefore.body.expenses.map((expense) => expense.id).sort((a, b) => a - b),
  };

  await db.prepare('UPDATE trips SET public_enabled = 0 WHERE id = ?').run(legacy.trip.trip.id);
  const disabled = await request(app).get(originalPath);
  await db.prepare('UPDATE trips SET public_enabled = 1 WHERE id = ?').run(legacy.trip.trip.id);

  const rotate = await request(app)
    .post(`/api/trips/${legacy.trip.trip.id}/share`)
    .set('Authorization', authorization);
  assert.equal(rotate.status, 200);
  assert.match(rotate.body.token, /^[a-f0-9]{32}$/);
  assert.notEqual(rotate.body.token, legacy.publicToken);
  const rotated = await request(app).get(originalPath);
  const rotatedCurrent = await request(app).get(`/api/public/trips/${rotate.body.token}`);
  assert.equal(rotatedCurrent.status, 200);

  const revoke = await request(app)
    .delete(`/api/trips/${legacy.trip.trip.id}/share`)
    .set('Authorization', authorization);
  assert.equal(revoke.status, 200);
  assertKeys(revoke.body, ['ok']);

  const revoked = await request(app).get(`/api/public/trips/${rotate.body.token}`);
  const unknown = await request(app).get('/api/public/trips/11111111111111111111111111111111');
  const malformed = await request(app).get('/api/public/trips/not-a-valid-token');
  for (const response of [disabled, rotated, revoked, unknown, malformed]) {
    assert.equal(response.status, 404);
    assert.deepEqual(response.body, { error: 'Not found' });
  }

  const privateAfter = await request(app)
    .get(`/api/trips/${legacy.trip.trip.id}`)
    .set('Authorization', authorization);
  assert.equal(privateAfter.status, 200);
  assert.deepEqual(
    privateAfter.body.members.map((member) => member.id).sort((a, b) => a - b),
    privateIdsBefore.memberIds
  );
  assert.deepEqual(
    privateAfter.body.expenses.map((expense) => expense.id).sort((a, b) => a - b),
    privateIdsBefore.expenseIds
  );
});

test('finance routes retain missing-token and revoked-session authorization failures', async () => {
  const missing = await request(app).get('/api/finance/plan');
  assert.equal(missing.status, 401);
  assert.deepEqual(missing.body, { error: 'Missing token' });

  await db.prepare(
    `UPDATE sessions
        SET revoked_at = CURRENT_TIMESTAMP, revoked_reason = 'user_logout'
      WHERE id = ?`
  ).run(accounts.outsiderSession.id);
  const revoked = await request(app)
    .get('/api/finance/plan')
    .set('Authorization', authFor(accounts.outsider, accounts.outsiderSession));
  assert.equal(revoked.status, 401);
  assertKeys(revoked.body, ['error', 'code']);
  assert.equal(revoked.body.code, 'SESSION_REVOKED');
});

test('monthly review dry-run characterizes populated and confirmed-empty users without retaining log contents', async () => {
  await insertPlanCase(legacy.planCases.monthBoundary);
  const logCounts = { start: 0, dry: 0, done: 0, failed: 0 };
  const classifyLogWithoutRetention = (message) => {
    const value = String(message);
    if (value.startsWith('[monthly-review] month=')) logCounts.start++;
    else if (value.startsWith('[dry] would send')) logCounts.dry++;
    else if (value.startsWith('[monthly-review] done')) logCounts.done++;
    else if (value.startsWith('[monthly-review] failed')) logCounts.failed++;
  };
  const { runMonthlyReview } = await import('../../src/jobs/monthlyReview.js');

  const result = await runMonthlyReview({ dry: true, log: classifyLogWithoutRetention });

  assertKeys(result, ['month', 'sent', 'skipped', 'failed', 'dry']);
  assert.equal(result.month, monthAtOffset(-1));
  assert.equal(result.sent, 1);
  assert.equal(result.skipped, 2);
  assert.equal(result.failed, 0);
  assert.equal(result.dry, true);
  assert.deepEqual(logCounts, { start: 1, dry: 1, done: 1, failed: 0 });
});

test('clarity contract header adds an authenticated snapshot without changing legacy plan fields', async () => {
  const currentMonth = monthAtOffset(0);
  await insertPlanCase({
    salary: {
      id: 801,
      user_id: accounts.owner.id,
      month: currentMonth,
      amount: 75_000,
      created_at: '2026-01-01T00:00:00.000Z',
    },
    bills: [],
    expenses: [],
  });
  const authorization = authFor(accounts.owner, accounts.ownerSession);
  const legacyResponse = await request(app)
    .get('/api/finance/plan')
    .set('Authorization', authorization);
  const clarityResponse = await request(app)
    .get('/api/finance/plan')
    .set('Authorization', authorization)
    .set('X-Clarity-Contract', '1');

  assert.equal(legacyResponse.status, 200);
  assert.equal(clarityResponse.status, 200);
  for (const key of Object.keys(legacyResponse.body)) {
    assert.deepEqual(clarityResponse.body[key], legacyResponse.body[key]);
  }
  assertKeys(clarityResponse.body, [
    ...Object.keys(legacyResponse.body),
    'schemaVersion',
    'clarity',
  ]);
  assert.equal(clarityResponse.body.schemaVersion, 1);
  assert.equal(clarityResponse.body.clarity.period.month, currentMonth);
  assert.equal(clarityResponse.body.clarity.currency, 'INR');
  assert.equal('mutation' in clarityResponse.body, false);

  const anonymous = await request(app)
    .get('/api/finance/plan')
    .set('X-Clarity-Contract', '1');
  assert.equal(anonymous.status, 401);
  assert.deepEqual(anonymous.body, { error: 'Missing token' });
});

test('shadow comparison leaves the legacy plan body unchanged and logs codes only', async () => {
  const currentMonth = monthAtOffset(0);
  const privateFixture = {
    id: 811,
    user_id: accounts.owner.id,
    month: currentMonth,
    amount: 1000.25,
    created_at: '2026-01-01T00:00:00.000Z',
  };
  await insertPlanCase({ salary: privateFixture, bills: [], expenses: [] });
  const authorization = authFor(accounts.owner, accounts.ownerSession);
  const baseline = await request(app)
    .get('/api/finance/plan')
    .set('Authorization', authorization);

  const previousFlag = process.env.CLARITY_SHADOW_COMPARE;
  const previousLevel = process.env.OPERATIONAL_LOG_LEVEL;
  const logs = [];
  const originalWarn = console.warn;
  process.env.CLARITY_SHADOW_COMPARE = 'true';
  // Operational logging is silent under NODE_ENV=test unless a level is set.
  process.env.OPERATIONAL_LOG_LEVEL = 'warn';
  console.warn = (message) => logs.push(String(message));
  let shadow;
  try {
    shadow = await request(app)
      .get('/api/finance/plan')
      .set('Authorization', authorization);
  } finally {
    console.warn = originalWarn;
    if (previousFlag === undefined) delete process.env.CLARITY_SHADOW_COMPARE;
    else process.env.CLARITY_SHADOW_COMPARE = previousFlag;
    if (previousLevel === undefined) delete process.env.OPERATIONAL_LOG_LEVEL;
    else process.env.OPERATIONAL_LOG_LEVEL = previousLevel;
  }

  assert.equal(shadow.status, 200);
  assert.deepEqual(shadow.body, baseline.body);
  assert.ok(logs.length > 0);
  // Each line is one structured event holding only the event name and a fixed mismatch code.
  assert.ok(logs.every((message) => {
    const entry = JSON.parse(message);
    return entry.event === 'SHADOW_MISMATCH'
      && /^PLAN_[A-Z0-9_]+$/.test(entry.code)
      && Object.keys(entry).sort().join() === 'code,event,level,ts';
  }));
  const serializedLogs = logs.join('\n');
  assert.equal(serializedLogs.includes(String(privateFixture.amount)), false);
  assert.equal(serializedLogs.includes(accounts.owner.email), false);
  assert.equal(serializedLogs.includes(accounts.owner.name), false);
  assert.equal(serializedLogs.includes(String(accounts.owner.id)), false);
});

test('public trip response ignores the private clarity contract header', async () => {
  await insertTrip(legacy.trip);
  const baseline = await request(app).get(`/api/public/trips/${legacy.publicToken}`);
  const negotiated = await request(app)
    .get(`/api/public/trips/${legacy.publicToken}`)
    .set('X-Clarity-Contract', '1');

  assert.equal(baseline.status, 200);
  assert.equal(negotiated.status, 200);
  assert.deepEqual(negotiated.body, baseline.body);
  assertKeys(negotiated.body, ['trip', 'members', 'expenses', 'settlement']);
});

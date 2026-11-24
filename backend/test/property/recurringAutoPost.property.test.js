import '../helpers/blockingStdout.js';
import test, { after, before, mock } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createIsolatedTestDatabase } from '../helpers/testDatabase.js';
import { assertProperty, MIN_PROPERTY_RUNS } from '../helpers/propertyReport.js';
import { buildSessionFixture, buildUserFixture } from '../helpers/fixtures.js';
import { daysInMonth, kolkataParts } from '../helpers/kolkataReference.js';
import { anyRealDateArb, noteArb } from '../helpers/quickAddGenerators.js';

// Feature: quick-add-daily-answer, Property 28: Auto-posted recurring expenses are marked and otherwise unchanged
// Validates: Requirements 17.27, 18.23, 18.25
//
// The real route path (GET /api/finance/plan, /expenses, /insights, /recurring, which all call
// materializeRecurring) runs against the isolated file database with the process clock mocked to a
// generated Asia/Kolkata instant. The model below is independent of finance.js: it reproduces the
// output of the logic before the feature (user, month, category, amount, note `<label> (recurring)`,
// spent_on, no update time) from the generated definitions and the date, and the stored mark is the
// only value allowed to differ. A second run, the earlier unmarked rows, the claim state of the
// definitions, and the Today_Spent / Remaining_Spendable split (ClarityService with the injected
// Kolkata date against a BigInt model) are checked on the same data.

const RUNS = Math.max(MIN_PROPERTY_RUNS, 120);
const FIRST_USER_ID = 962_000;
const FIRST_SESSION_ID = 962_000;
const KOLKATA = 'Asia/Kolkata';
const CATEGORIES = Object.freeze([
  'Food', 'Groceries', 'Rent', 'Utilities', 'Transport', 'Shopping', 'Entertainment', 'Other',
]);
const DAY_KINDS = Object.freeze(['fixed', 'today', 'before', 'after', 'last']);
const STATE_KINDS = Object.freeze(['fresh', 'postedThisMonth', 'postedPrevMonth', 'futureMonth']);
const ROUTES = Object.freeze(['plan', 'expenses', 'insights', 'recurring']);

let testDatabase;
let db;
let app;
let ClarityService;
let clarityService;
let nextCase = 0;
let clockEnabled = false;

before(async () => {
  testDatabase = await createIsolatedTestDatabase();
  db = testDatabase.db;
  process.env.FINANCIAL_MUTATION_HMAC_KEY =
    'test-only-recurring-auto-post-hmac-key-32-bytes-minimum';
  ({ ClarityService } = await import('../../src/services/clarityService.js'));
  const { createApp } = await import('../../src/app.js');
  clarityService = new ClarityService();
  app = createApp();
});

after(async () => {
  if (clockEnabled) mock.timers.reset();
  await testDatabase?.cleanup();
});

/* ------------------------------------------------------------ generators */

const definitionArb = fc.record({
  dayKind: fc.constantFrom(...DAY_KINDS),
  dayValue: fc.integer({ min: 1, max: 31 }),
  amountPaise: fc.oneof(
    { weight: 1, arbitrary: fc.constantFrom(1, 99, 100, 101, 12_345) },
    { weight: 3, arbitrary: fc.integer({ min: 1, max: 50_000_000 }) },
  ),
  categoryIndex: fc.integer({ min: 0, max: CATEGORIES.length - 1 }),
  label: fc
    .oneof(
      noteArb({ maxWords: 4, tricky: true }),
      fc.constantFrom('Rent', 'Gym (monthly)', 'a (recurring)', 'x'),
    )
    .filter((label) => label.length >= 1 && label.length <= 60),
  active: fc.constantFrom(true, true, true, false),
  kind: fc.constantFrom(...STATE_KINDS),
});

const manualArb = fc.record({
  dayKind: fc.constantFrom('today', 'other'),
  dayValue: fc.integer({ min: 1, max: 31 }),
  amountPaise: fc.integer({ min: 1, max: 20_000_000 }),
  categoryIndex: fc.integer({ min: 0, max: CATEGORIES.length - 1 }),
  zeroMark: fc.boolean(),
});

const timeOfDayArb = fc.oneof(
  { weight: 2, arbitrary: fc.constantFrom(0, 1, 999, 86_399_999, 86_399_000, 43_200_000) },
  { weight: 3, arbitrary: fc.integer({ min: 0, max: 86_399_999 }) },
);

const scenarioArb = fc.record({
  date: anyRealDateArb,
  timeOfDayMs: timeOfDayArb,
  salaryPaise: fc.integer({ min: 100_000, max: 5_000_000_000 }),
  definitions: fc.array(definitionArb, { minLength: 0, maxLength: 6 }),
  manual: fc.array(manualArb, { minLength: 0, maxLength: 3 }),
  firstRouteIndex: fc.integer({ min: 0, max: ROUTES.length - 1 }),
  secondRouteIndex: fc.integer({ min: 0, max: ROUTES.length - 1 }),
});

/* ------------------------------------------------------------- reference */

function pad(value) {
  return String(value).padStart(2, '0');
}

function halfUp(numerator, denominator) {
  let quotient = numerator / denominator;
  if ((numerator % denominator) * 2n >= denominator) quotient += 1n;
  return quotient;
}

function shiftMonth(year, month, delta) {
  const shifted = new Date(Date.UTC(year, month - 1 + delta, 1));
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}`;
}

function resolveDay(spec, todayDay) {
  switch (spec.dayKind) {
    case 'today': return todayDay;
    case 'before': return Math.max(1, todayDay - 1);
    case 'after': return Math.min(31, todayDay + 1);
    case 'last': return 31;
    default: return spec.dayValue;
  }
}

/** Stored values of the expense the logic created before the feature (no mark). */
function preFeatureRow({ userId, month, definition, dayOfMonth, lastDay }) {
  const day = Math.min(Math.max(1, dayOfMonth), lastDay);
  return {
    user_id: userId,
    month,
    category: CATEGORIES[definition.categoryIndex],
    amount: definition.amountPaise / 100,
    note: `${definition.label} (recurring)`,
    spent_on: `${month}-${pad(day)}`,
    updated_at: null,
  };
}

function isDue(definition, dayOfMonth, lastLogged, month, todayDay) {
  return definition.active && lastLogged !== month && dayOfMonth <= todayDay;
}

function sortedKeys(rows) {
  return rows.map((row) => JSON.stringify(row)).sort();
}

function amountOf(value) {
  assert.equal(value.currency, 'INR');
  return BigInt(value.amountMinor);
}

/* ------------------------------------------------------------- database */

async function loadRows(userId) {
  return (await db.prepare('SELECT * FROM expense_log WHERE user_id = ? ORDER BY id').all(userId))
    .map((row) => ({ ...row }));
}

async function loadDefinitions(userId) {
  return (await db.prepare(
    'SELECT id, label, amount, category, day_of_month, active, last_logged_month FROM recurring_expenses WHERE user_id = ? ORDER BY id',
  ).all(userId)).map((row) => ({ ...row }));
}

async function seedUser(caseNumber) {
  const userId = FIRST_USER_ID + caseNumber;
  const sessionId = FIRST_SESSION_ID + caseNumber;
  const user = buildUserFixture({ id: userId, email: `recurring-auto-post-${userId}@example.test` });
  const session = buildSessionFixture({ userId, id: sessionId, ip_hash: `recurring-auto-post-${caseNumber}` });
  await db.prepare(
    `INSERT INTO users (id, email, name, password_hash, is_admin, token_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(user.id, user.email, user.name, user.password_hash, user.is_admin, user.token_version, user.created_at);
  await db.prepare(
    `INSERT INTO sessions
      (id, user_id, device_label, ip_hash, user_agent, created_at, last_seen_at, revoked_at, revoked_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    session.id, session.user_id, session.device_label, session.ip_hash, session.user_agent,
    session.created_at, session.last_seen_at, session.revoked_at, session.revoked_reason,
  );
  await db.prepare(
    `INSERT INTO user_financial_state (user_id, data_use_notice_version, data_use_acknowledged_at)
     VALUES (?, 1, CURRENT_TIMESTAMP)`,
  ).run(userId);
  return { userId, sessionId };
}

function routePath(name, month) {
  return name === 'expenses' ? `/api/finance/expenses?month=${month}` : `/api/finance/${name}`;
}

/** Documentation-range IPs from a per-case counter, so the 120/min limiter never shares a bucket. */
function ipFor(caseNumber) {
  const n = caseNumber + 1;
  return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
}

/* -------------------------------------------------------------- the case */

async function runCase(scenario, seen) {
  const caseNumber = nextCase;
  nextCase += 1;

  const instantMs = Date.UTC(
    Number(scenario.date.slice(0, 4)),
    Number(scenario.date.slice(5, 7)) - 1,
    Number(scenario.date.slice(8, 10)),
  ) - 19_800_000 + scenario.timeOfDayMs;
  if (clockEnabled) {
    mock.timers.setTime(instantMs);
  } else {
    mock.timers.enable({ apis: ['Date'], now: instantMs });
    clockEnabled = true;
  }
  const now = new Date(instantMs);
  const local = kolkataParts(instantMs);
  const month = local.monthKey;
  const todayDate = local.date;
  const todayDay = local.day;
  const lastDay = daysInMonth(local.year, local.month);
  const previousMonth = shiftMonth(local.year, local.month, -1);
  const nextMonth = shiftMonth(local.year, local.month, 1);
  assert.equal(todayDate.slice(0, 7), month);

  const { userId, sessionId } = await seedUser(caseNumber);
  await db.prepare('INSERT INTO salary_entries (user_id, month, amount) VALUES (?, ?, ?)')
    .run(userId, month, scenario.salaryPaise / 100);

  // Definitions and the rows an earlier (pre-feature) run left behind.
  const definitions = scenario.definitions.map((definition) => {
    const dayOfMonth = resolveDay(definition, todayDay);
    const lastLogged = definition.kind === 'postedThisMonth' ? month
      : definition.kind === 'postedPrevMonth' ? previousMonth
        : definition.kind === 'futureMonth' ? nextMonth : null;
    return { definition, dayOfMonth, lastLogged };
  });
  for (const entry of definitions) {
    const { definition, dayOfMonth, lastLogged } = entry;
    await db.prepare(
      `INSERT INTO recurring_expenses (user_id, label, amount, category, day_of_month, active, last_logged_month)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      userId, definition.label, definition.amountPaise / 100, CATEGORIES[definition.categoryIndex],
      dayOfMonth, definition.active ? 1 : 0, lastLogged,
    );
    if (definition.kind === 'postedThisMonth' || definition.kind === 'postedPrevMonth') {
      const earlierMonth = lastLogged;
      const earlierLastDay = earlierMonth === month ? lastDay : daysInMonth(
        Number(earlierMonth.slice(0, 4)), Number(earlierMonth.slice(5, 7)),
      );
      const earlierDay = earlierMonth === month
        ? Math.min(dayOfMonth, todayDay, earlierLastDay)
        : Math.min(dayOfMonth, earlierLastDay);
      await db.prepare(
        `INSERT INTO expense_log (user_id, month, category, amount, note, spent_on)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        userId, earlierMonth, CATEGORIES[definition.categoryIndex], definition.amountPaise / 100,
        `${definition.label} (recurring)`, `${earlierMonth}-${pad(earlierDay)}`,
      );
    }
  }
  for (const manual of scenario.manual) {
    const day = manual.dayKind === 'today' ? todayDay : Math.min(manual.dayValue, lastDay);
    await db.prepare(
      `INSERT INTO expense_log (user_id, month, category, amount, note, spent_on, exclude_from_daily_allowance)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      userId, month, CATEGORIES[manual.categoryIndex], manual.amountPaise / 100, 'manual',
      `${month}-${pad(day)}`, manual.zeroMark ? 0 : null,
    );
  }

  const token = jwt.sign(
    { sub: String(userId), tv: 1, sid: sessionId },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '5m' },
  );
  const call = async (routeName) => {
    const response = await request(app)
      .get(routePath(routeName, month))
      .set('Authorization', `Bearer ${token}`)
      .set('X-Forwarded-For', ipFor(caseNumber));
    assert.equal(response.status, 200);
  };

  const preRows = await loadRows(userId);
  const definitionsBefore = await loadDefinitions(userId);

  /* ---- first run: one marked expense per due definition, pre-feature output otherwise */
  await call(ROUTES[scenario.firstRouteIndex]);
  const afterFirst = await loadRows(userId);
  const beforeIds = new Set(preRows.map((row) => row.id));
  const created = afterFirst.filter((row) => !beforeIds.has(row.id));

  const expected = [];
  for (const entry of definitions) {
    if (isDue(entry.definition, entry.dayOfMonth, entry.lastLogged, month, todayDay)) {
      expected.push(preFeatureRow({ userId, month, definition: entry.definition, dayOfMonth: entry.dayOfMonth, lastDay }));
    } else if (entry.definition.active && entry.lastLogged !== month) {
      seen.notYetDue += 1;
      if (entry.dayOfMonth > lastDay) seen.pastMonthEnd += 1;
    }
  }
  assert.equal(created.length, expected.length, 'one expense per due definition');
  for (const row of created) {
    assert.equal(Number(row.exclude_from_daily_allowance), 1, 'the new row carries the mark');
    assert.ok(row.id > Math.max(0, ...preRows.map((earlier) => earlier.id)));
  }
  // The mark is the only difference: strip it and the database-generated id and timestamp, and
  // the remaining stored values must equal the pre-feature output exactly.
  const withoutMark = created.map(({ id: _id, created_at: _createdAt, exclude_from_daily_allowance: _mark, ...rest }) => rest);
  assert.deepEqual(sortedKeys(withoutMark), sortedKeys(expected));
  for (const row of created) {
    assert.deepEqual(
      Object.keys(row).sort(),
      ['amount', 'category', 'created_at', 'exclude_from_daily_allowance', 'id', 'month', 'note', 'spent_on', 'updated_at', 'user_id'],
    );
  }

  // Definitions: due ones are claimed for this month, the rest are untouched.
  const definitionsAfter = await loadDefinitions(userId);
  assert.equal(definitionsAfter.length, definitionsBefore.length);
  definitionsAfter.forEach((row, index) => {
    const entry = definitions[index];
    const due = isDue(entry.definition, entry.dayOfMonth, entry.lastLogged, month, todayDay);
    assert.equal(row.last_logged_month, due ? month : entry.lastLogged);
    assert.equal(row.amount, definitionsBefore[index].amount);
    assert.equal(row.active, definitionsBefore[index].active);
    assert.equal(row.day_of_month, definitionsBefore[index].day_of_month);
  });

  // Earlier rows stay as they were: no backfill of the mark.
  const earlierNow = afterFirst.filter((row) => beforeIds.has(row.id));
  assert.deepEqual(earlierNow, preRows);
  for (const row of earlierNow) assert.notEqual(Number(row.exclude_from_daily_allowance), 1);

  /* ---- second run in the same month creates nothing and changes nothing */
  await call(ROUTES[scenario.secondRouteIndex]);
  const afterSecond = await loadRows(userId);
  assert.deepEqual(afterSecond, afterFirst);
  assert.deepEqual(await loadDefinitions(userId), definitionsAfter);

  /* ---- Today_Spent leaves the marked rows out, Remaining_Spendable keeps them */
  const snapshot = await clarityService.getSnapshot({ userId, month, now, timeZone: KOLKATA });
  const monthRows = afterSecond.filter((row) => row.month === month);
  const marked = (row) => Number(row.exclude_from_daily_allowance) === 1;
  const minor = (row) => BigInt(Math.round(Number(row.amount) * 100));
  const salary = BigInt(scenario.salaryPaise);
  const spendable = halfUp(salary, 2n) + halfUp(salary * 3n, 10n);
  const spentAll = monthRows.reduce((total, row) => total + minor(row), 0n);
  const remaining = spendable - spentAll;
  const counted = monthRows.filter((row) => row.spent_on === todayDate && !marked(row));
  const excluded = monthRows.filter((row) => row.spent_on === todayDate && marked(row));
  const todaySpent = counted.reduce((total, row) => total + minor(row), 0n);
  const excludedTotal = excluded.reduce((total, row) => total + minor(row), 0n);
  const daysRemaining = BigInt(lastDay - todayDay + 1);
  const basis = remaining + todaySpent;
  const allowance = basis <= 0n ? 0n : halfUp(basis, daysRemaining);

  const today = snapshot.outcomes.todayAllowance;
  assert.equal(today.status, 'available');
  assert.equal(today.value.applicable, true);
  assert.equal(today.value.date, todayDate);
  assert.equal(amountOf(today.value.todaySpent), todaySpent);
  assert.equal(today.value.excludedToday.count, excluded.length);
  assert.equal(amountOf(today.value.excludedToday.total), excludedTotal);
  assert.equal(amountOf(today.value.allowanceBasis), basis);
  assert.equal(amountOf(today.value.todayAllowance), allowance);
  assert.equal(amountOf(today.value.leftToday), allowance - todaySpent);
  assert.equal(amountOf(snapshot.outcomes.monthlyPlan.value.remainingSpendable), remaining);
  assert.equal(amountOf(snapshot.outcomes.spending.value.remainingSpendable), remaining);

  // Rows created by the recurring logic and dated Today are exactly the excluded ones.
  const createdToday = created.filter((row) => row.spent_on === todayDate);
  const earlierMarkedToday = earlierNow.filter((row) => row.spent_on === todayDate && marked(row));
  assert.equal(earlierMarkedToday.length, 0);
  assert.equal(excluded.length, createdToday.length);

  seen.cases += 1;
  seen.posted += created.length;
  if (created.length > 0) seen.casesWithPosts += 1;
  if (createdToday.length > 0) {
    seen.postedToday += 1;
    if (counted.length > 0) seen.postedTodayWithCounted += 1;
  }
  if (lastDay < 31) seen.shortMonths += 1;
  if (lastDay === 29) seen.leapFebruary += 1;
  if (todayDay === lastDay) seen.lastDayOfMonth += 1;
  if (todayDay === 1) seen.firstDayOfMonth += 1;
  if (definitions.some((entry) => entry.lastLogged === month)) seen.alreadyPosted += 1;
  if (earlierNow.some((row) => row.month === previousMonth)) seen.rolloverRows += 1;
}

test('Property 28: auto-posted recurring expenses are marked and otherwise unchanged', async () => {
  const seen = {
    cases: 0,
    posted: 0,
    casesWithPosts: 0,
    postedToday: 0,
    postedTodayWithCounted: 0,
    shortMonths: 0,
    leapFebruary: 0,
    lastDayOfMonth: 0,
    firstDayOfMonth: 0,
    alreadyPosted: 0,
    rolloverRows: 0,
    notYetDue: 0,
    pastMonthEnd: 0,
  };
  // One reset per property run; every case uses its own user, session, and client address.
  await testDatabase.reset();
  nextCase = 0;
  await assertProperty(
    fc.asyncProperty(scenarioArb, async (scenario) => {
      await runCase(scenario, seen);
    }),
    { numRuns: RUNS },
  );
  assert.ok(seen.cases >= MIN_PROPERTY_RUNS, `ran ${seen.cases} cases`);
  assert.ok(seen.casesWithPosts > 0, 'some cases posted expenses');
  assert.ok(seen.postedToday > 0, 'some posted rows were dated Today');
  assert.ok(seen.postedTodayWithCounted > 0, 'some Today rows sat beside counted Today expenses');
  assert.ok(seen.shortMonths > 0, 'short months were generated');
  assert.ok(seen.pastMonthEnd > 0, 'definitions beyond the end of a short month were generated');
  assert.ok(seen.alreadyPosted > 0, 'earlier unmarked posts were generated');
  assert.ok(seen.rolloverRows > 0, 'previous-month rows were generated');
  console.error(`PBT recurringAutoPost: ${JSON.stringify(seen)}`);
});

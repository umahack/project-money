import '../helpers/blockingStdout.js';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createIsolatedTestDatabase } from '../helpers/testDatabase.js';
import { buildSessionFixture, buildUserFixture } from '../helpers/fixtures.js';

/**
 * Task 17.2 parity gate for the legacy `GET /api/finance/plan` calculation.
 *
 * The legacy top-level fields and the canonical `clarity` snapshot are read
 * from ONE request (`X-Clarity-Contract: 1`) over the same stored rows and
 * compared in exact integer paise. The legacy math therefore stays in the
 * route (it is the rollback read path and is pinned by legacyContracts.test.js)
 * until every fixture below matches. Fixtures that do not match are listed
 * with the exact reason; they are the documented blockers to retiring it.
 */

const OWNER_ID = 701;
const SESSION_ID = 801;
const STAMP = '2026-01-15T06:30:00.000Z';

let testDatabase;
let db;
let app;

function monthAtOffset(offset) {
  const date = new Date();
  date.setDate(1);
  date.setMonth(date.getMonth() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

const CURRENT = monthAtOffset(0);
const PREVIOUS = monthAtOffset(-1);
const NEXT = monthAtOffset(1);

function authorization() {
  const token = jwt.sign(
    { sub: String(OWNER_ID), tv: 1, sid: SESSION_ID },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '5m' }
  );
  return `Bearer ${token}`;
}

async function seedAccount() {
  const user = buildUserFixture({ id: OWNER_ID, email: 'plan-parity@example.test', name: 'Plan Parity' });
  const session = buildSessionFixture({ id: SESSION_ID, userId: OWNER_ID });
  await db.prepare(
    `INSERT INTO users (id, email, name, password_hash, is_admin, token_version, created_at)
     VALUES (?, ?, ?, ?, 0, 1, ?)`
  ).run(user.id, user.email, user.name, user.password_hash, user.created_at);
  await db.prepare(
    `INSERT INTO sessions
      (id, user_id, device_label, ip_hash, user_agent, created_at, last_seen_at, revoked_at, revoked_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`
  ).run(session.id, session.user_id, session.device_label, session.ip_hash, session.user_agent, session.created_at, session.last_seen_at);
}

async function salary(month, amount) {
  await db.prepare('INSERT INTO salary_entries (user_id, month, amount, created_at) VALUES (?, ?, ?, ?)')
    .run(OWNER_ID, month, amount, STAMP);
}

async function bill(label, amount, { active = 1 } = {}) {
  await db.prepare(
    'INSERT INTO emis (user_id, label, amount, category, active, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(OWNER_ID, label, amount, 'Rent', active, STAMP);
}

async function expense(month, category, amount, day = 5) {
  await db.prepare(
    `INSERT INTO expense_log (user_id, month, category, amount, note, spent_on, created_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?)`
  ).run(OWNER_ID, month, category, amount, `${month}-${String(day).padStart(2, '0')}`, STAMP);
}

const paise = (rupees) => Math.round(Number(rupees) * 100);

/** One authenticated request. Legacy fields and the canonical snapshot come from the same stored rows. */
async function readBoth() {
  const response = await request(app)
    .get('/api/finance/plan')
    .set('Authorization', authorization())
    .set('X-Clarity-Contract', '1');
  assert.equal(response.status, 200);
  const { clarity, schemaVersion: _schemaVersion, ...legacy } = response.body;
  return { legacy, clarity };
}

function legacyMinor(legacy) {
  return {
    income: paise(legacy.income),
    fixed: paise(legacy.emiTotal),
    disposable: paise(legacy.afterFixed),
    needs: paise(legacy.breakdown.needs),
    wants: paise(legacy.breakdown.wants),
    savings: paise(legacy.breakdown.save),
    spent: paise(legacy.spentThisMonth),
    categories: Object.fromEntries(Object.entries(legacy.byCategory).map(([k, v]) => [k, paise(v)])),
  };
}

function canonicalMinor(clarity) {
  const monthly = clarity.outcomes.monthlyPlan;
  const spending = clarity.outcomes.spending;
  if (monthly.status !== 'available' || spending.status !== 'available') return null;
  const value = monthly.value;
  return {
    income: value.salary.amountMinor,
    fixed: value.activeBillsTotal.amountMinor,
    disposable: value.disposableIncome.amountMinor,
    needs: value.needsBudget.amountMinor,
    wants: value.wantsBudget.amountMinor,
    savings: value.savingsTarget.amountMinor,
    spent: spending.value.totalSpending.amountMinor,
    categories: Object.fromEntries(spending.value.categoryTotals.map((e) => [e.category, e.total.amountMinor])),
  };
}

before(async () => {
  testDatabase = await createIsolatedTestDatabase();
  db = testDatabase.db;
  const { createApp } = await import('../../src/app.js');
  app = createApp();
});

beforeEach(async () => {
  await testDatabase.reset();
  await seedAccount();
});

afterEach(async () => {
  // authRequired updates session activity asynchronously.
  await new Promise((resolve) => setImmediate(resolve));
});

after(async () => {
  await testDatabase?.cleanup();
});

// ---------------------------------------------------------------------------
// Fixtures where the legacy route and the canonical calculator agree exactly.
// ---------------------------------------------------------------------------

const MATCHING = [
  {
    name: 'equal bills and salary (zero disposable)',
    seed: async () => { await salary(CURRENT, 50_000); await bill('A', 20_000); await bill('B', 30_000); },
  },
  {
    name: 'bills exceed salary (shortfall, zero disposable)',
    seed: async () => { await salary(CURRENT, 50_000); await bill('Excess', 60_000); },
  },
  {
    name: 'salary with no bills',
    seed: async () => { await salary(CURRENT, 80_000); },
  },
  {
    name: 'whole-rupee disposable income with spending in two categories',
    seed: async () => {
      await salary(CURRENT, 82_500);
      await bill('Rent', 20_000);
      await bill('Insurance', 2_500);
      await expense(CURRENT, 'Groceries', 1_250.5);
      await expense(CURRENT, 'Groceries', 99.25, 9);
      await expense(CURRENT, 'Entertainment', 800, 12);
    },
  },
  {
    name: 'expenses in adjacent months stay out of the current month on both paths',
    seed: async () => {
      await salary(CURRENT, 60_000);
      await expense(PREVIOUS, 'Food', 700, 28);
      await expense(CURRENT, 'Food', 900, 1);
      await expense(NEXT, 'Food', 1_100, 2);
    },
  },
];

for (const scenario of MATCHING) {
  test(`plan parity: ${scenario.name}`, async () => {
    await scenario.seed();
    const { legacy, clarity } = await readBoth();
    const canonical = canonicalMinor(clarity);
    assert.ok(canonical, 'the canonical monthly plan and spending outcomes are available');
    assert.deepEqual(legacyMinor(legacy), canonical);

    const { planMismatchCodes } = await import('../../src/rollout/shadowComparison.js');
    assert.deepEqual([...planMismatchCodes(clarity, legacy)], []);
  });
}

// ---------------------------------------------------------------------------
// Fixtures where parity FAILS. Each pins the exact divergence so the legacy
// calculation is not retired and the difference is never silently changed.
// ---------------------------------------------------------------------------

test('plan divergence: legacy rounds each budget to whole rupees, canonical rounds to paise', async () => {
  // Disposable 1000.25: half-up paise gives 500.13 / 300.08 and a 200.04 remainder to savings.
  // The legacy route rounds each budget with Math.round to a whole rupee (500 / 300) and
  // keeps the 200.25 remainder. This is the case the legacy shadow-log contract test relies on.
  await salary(CURRENT, 1_000.25);
  const { legacy, clarity } = await readBoth();
  const canonical = canonicalMinor(clarity);

  assert.deepEqual(legacyMinor(legacy), {
    income: 100_025, fixed: 0, disposable: 100_025, needs: 50_000, wants: 30_000, savings: 20_025, spent: 0, categories: {},
  });
  assert.deepEqual(canonical, {
    income: 100_025, fixed: 0, disposable: 100_025, needs: 50_013, wants: 30_008, savings: 20_004, spent: 0, categories: {},
  });
  const { planMismatchCodes } = await import('../../src/rollout/shadowComparison.js');
  assert.deepEqual([...planMismatchCodes(clarity, legacy)], [
    'PLAN_NEEDS_BUDGET_MISMATCH',
    'PLAN_WANTS_BUDGET_MISMATCH',
    'PLAN_SAVINGS_TARGET_MISMATCH',
  ]);
});

test('plan divergence: legacy reads the latest salary of any month, canonical reads only the requested month', async () => {
  // Requirement 4.15 excludes salary that applies to another month from current-month outcomes.
  await salary(PREVIOUS, 48_000);
  await salary(NEXT, 72_000);
  const { legacy, clarity } = await readBoth();

  assert.equal(legacy.income, 72_000);
  assert.equal(legacy.afterFixed, 72_000);
  assert.equal(clarity.outcomes.monthlyPlan.status, 'missing_input');
  assert.equal(canonicalMinor(clarity), null);
  const { planMismatchCodes } = await import('../../src/rollout/shadowComparison.js');
  assert.deepEqual([...planMismatchCodes(clarity, legacy)], ['PLAN_CANONICAL_UNAVAILABLE']);
});

test('plan divergence: legacy sums every bill, canonical counts only active bills for the month', async () => {
  // Requirement 4.1 subtracts active same-month bills only. The legacy query ignores the active flag.
  await salary(CURRENT, 50_000);
  await bill('Counted', 10_000);
  await bill('Paused', 5_000, { active: 0 });
  const { legacy, clarity } = await readBoth();
  const canonical = canonicalMinor(clarity);

  assert.equal(paise(legacy.emiTotal), 1_500_000);
  assert.equal(canonical.fixed, 1_000_000);
  const { planMismatchCodes } = await import('../../src/rollout/shadowComparison.js');
  assert.deepEqual([...planMismatchCodes(clarity, legacy)], [
    'PLAN_FIXED_TOTAL_MISMATCH',
    'PLAN_DISPOSABLE_MISMATCH',
    'PLAN_NEEDS_BUDGET_MISMATCH',
    'PLAN_WANTS_BUDGET_MISMATCH',
    'PLAN_SAVINGS_TARGET_MISMATCH',
  ]);
});

test('plan divergence: a user with no salary gets legacy zeros but a canonical missing_input outcome', async () => {
  const { legacy, clarity } = await readBoth();

  assert.equal(legacy.income, 0);
  assert.equal(legacy.afterFixed, 0);
  assert.deepEqual(legacy.breakdown, { needs: 0, wants: 0, save: 0 });
  assert.equal(clarity.outcomes.monthlyPlan.status, 'missing_input');
});

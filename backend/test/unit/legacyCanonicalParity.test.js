import '../helpers/blockingStdout.js';
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { LEGACY_SETTLEMENT_PREFIX, calculateTripOutcome } from '../../src/domain/trips.js';
import { legacyTripSettlement } from '../../src/rollout/legacyTripSettlement.js';
import { createIsolatedTestDatabase } from '../helpers/testDatabase.js';

/**
 * Task 17.2 parity gate for the two legacy calculations that still duplicate a
 * canonical domain module:
 *
 *  1. The authenticated trip-detail `settlement` (rollout/legacyTripSettlement.js)
 *     versus `calculateTripOutcome`, which the public route already uses.
 *  2. The monthly-review rollback loader (`loadLegacyReviewData`) versus the
 *     canonical clarity snapshot (`reviewDataFromClaritySnapshot`).
 *
 * Both sides read the same stored rows and are compared in exact integer paise.
 * A fixture either matches exactly or has its divergence pinned below with the
 * reason. Nothing here is a reason to change legacy output silently: while any
 * fixture diverges, the legacy path stays as the rollback implementation.
 */

// ---------------------------------------------------------------------------
// Trip settlement
// ---------------------------------------------------------------------------

const ALICE = { id: 1, name: 'Alice' };
const BOB = { id: 2, name: 'Bob' };
const CARA = { id: 3, name: 'Cara' };
const THREE = [ALICE, BOB, CARA];

function storedExpense(id, payer, amount, split, description = `Expense ${id}`) {
  return { id, payer, description, amount, split_json: JSON.stringify(split) };
}

const equalSplit = (members) => members.map((member) => ({ name: member.name, share: 1 }));
const paise = (rupees) => Math.round(rupees * 100);

/** The route parses `split_json` before it calls the legacy function. */
function legacyView(members, expenses) {
  const parsed = expenses.map((expense) => {
    let split = [];
    try {
      const value = JSON.parse(expense.split_json);
      if (Array.isArray(value)) split = value;
    } catch {
      // The route keeps the row visible with an empty split.
    }
    return { ...expense, split, split_json: undefined };
  });
  const settlement = legacyTripSettlement(members, parsed);
  return {
    raw: settlement,
    balances: Object.fromEntries(Object.entries(settlement.balances).map(([name, value]) => [name, paise(value)])),
    transfers: settlement.transactions.map((t) => ({ from: t.from, to: t.to, amountMinor: paise(t.amount) })),
  };
}

function canonicalView(members, expenses) {
  const outcome = calculateTripOutcome({ tripId: 1, tripVersion: 1, members, expenses });
  if (outcome.status !== 'available') return { status: outcome.status, codes: outcome.invalid.map((i) => i.code) };
  const nameOf = (id) => members.find((member) => member.id === id).name;
  return {
    status: 'available',
    balances: Object.fromEntries(outcome.value.balances.map((b) => [nameOf(b.memberId), b.amountMinor])),
    transfers: outcome.value.settlements.map((s) => ({
      from: nameOf(s.fromMemberId),
      to: nameOf(s.toMemberId),
      amountMinor: s.amountMinor,
    })),
  };
}

const TRIP_MATCHING = [
  { name: 'no expenses', members: THREE, expenses: [] },
  {
    name: 'one evenly divisible shared expense',
    members: [ALICE, BOB],
    expenses: [storedExpense(1, 'Alice', 6000, equalSplit([ALICE, BOB]))],
  },
  {
    name: 'a legacy settlement-payment row that clears the balance',
    members: [ALICE, BOB],
    expenses: [
      storedExpense(1, 'Alice', 1, equalSplit([ALICE, BOB])),
      storedExpense(2, 'Bob', 0.25, [{ name: 'Alice', share: 1 }], `${LEGACY_SETTLEMENT_PREFIX}Bob → Alice`),
    ],
  },
  {
    name: 'a payer who is not in the split',
    members: THREE,
    expenses: [storedExpense(1, 'Alice', 900, [{ name: 'Bob', share: 1 }, { name: 'Cara', share: 2 }])],
  },
];

for (const scenario of TRIP_MATCHING) {
  test(`trip settlement parity: ${scenario.name}`, () => {
    const legacy = legacyView(scenario.members, scenario.expenses);
    const canonical = canonicalView(scenario.members, scenario.expenses);
    assert.equal(canonical.status, 'available');
    assert.deepEqual(legacy.balances, canonical.balances);
    assert.deepEqual(legacy.transfers, canonical.transfers);
  });
}

test('trip settlement divergence: a remainder paise is placed differently and legacy balances do not sum to zero', () => {
  // 100.00 split three ways leaves 1 paise. Canonical gives it to the first member in confirmed
  // order (Req 7.4) so displayed balances sum to zero (Req 7.5). The legacy float math leaves
  // 33.333… unrounded; rounding each displayed balance independently sums to +0.01.
  const expenses = [storedExpense(1, 'Alice', 100, equalSplit(THREE))];
  const legacy = legacyView(THREE, expenses);
  const canonical = canonicalView(THREE, expenses);

  assert.deepEqual(legacy.balances, { Alice: 6667, Bob: -3333, Cara: -3333 });
  assert.deepEqual(canonical.balances, { Alice: 6666, Bob: -3333, Cara: -3333 });
  assert.equal(Object.values(canonical.balances).reduce((a, b) => a + b, 0), 0);
  assert.equal(Object.values(legacy.balances).reduce((a, b) => a + b, 0), 1);
  // The legacy response carries the raw unrounded float, not a paise value.
  assert.equal(legacy.raw.balances.Alice, 66.66666666666666);
  assert.deepEqual(legacy.transfers, canonical.transfers);
});

test('trip settlement divergence: the remainder lands on a different member when the payer is last', () => {
  const expenses = [storedExpense(1, 'Cara', 100, equalSplit(THREE))];
  assert.deepEqual(legacyView(THREE, expenses).balances, { Alice: -3333, Bob: -3333, Cara: 6667 });
  assert.deepEqual(canonicalView(THREE, expenses).balances, { Alice: -3334, Bob: -3333, Cara: 6667 });
});

test('trip settlement divergence: weighted splits and one-paise amounts round differently', () => {
  const weighted = [storedExpense(1, 'Bob', 100, [{ name: 'Alice', share: 2 }, { name: 'Bob', share: 1 }])];
  // Same displayed paise, but the legacy response still serialises 66.66666666666666.
  assert.deepEqual(legacyView(THREE, weighted).balances, canonicalView(THREE, weighted).balances);
  assert.notEqual(legacyView(THREE, weighted).raw.balances.Bob, canonicalView(THREE, weighted).balances.Bob / 100);

  const onePaise = [storedExpense(1, 'Alice', 0.01, equalSplit([ALICE, BOB]))];
  assert.deepEqual(legacyView([ALICE, BOB], onePaise).raw.balances, { Alice: 0.005, Bob: -0.005 });
  assert.deepEqual(legacyView([ALICE, BOB], onePaise).raw.transactions, []);
  assert.deepEqual(canonicalView([ALICE, BOB], onePaise).balances, { Alice: 1, Bob: -1 });
  assert.deepEqual(canonicalView([ALICE, BOB], onePaise).transfers, [{ from: 'Bob', to: 'Alice', amountMinor: 1 }]);
});

test('trip settlement divergence: invalid or incomplete trips are calculated by legacy but withheld by canonical', () => {
  const cases = [
    ['payer is not a member', [storedExpense(1, 'Zed', 100, equalSplit([ALICE, BOB]))], 'UNKNOWN_TRIP_MEMBER_NAME'],
    ['every share is zero', [storedExpense(1, 'Alice', 100, [{ name: 'Alice', share: 0 }, { name: 'Bob', share: 0 }])], 'INCOMPLETE_SPLIT'],
    ['split names an unknown member', [storedExpense(1, 'Alice', 100, [{ name: 'Alice', share: 1 }, { name: 'Zed', share: 1 }])], 'UNKNOWN_TRIP_MEMBER_NAME'],
    ['split JSON is not an array', [{ id: 1, payer: 'Alice', description: 'x', amount: 100, split_json: '{"a":1}' }], 'INVALID_SPLIT_JSON'],
  ];
  for (const [label, expenses, code] of cases) {
    const canonical = canonicalView([ALICE, BOB], expenses);
    assert.equal(canonical.status, 'invalid_input', label);
    assert.deepEqual(canonical.codes, [code], label);
    // Legacy still returns a settlement object, so it cannot be replaced without changing old-client output.
    assert.deepEqual(Object.keys(legacyView([ALICE, BOB], expenses).raw).sort(), ['balances', 'transactions'], label);
  }
  // The only case where legacy credits money to a member is a split that names an unknown member.
  const partial = legacyView([ALICE, BOB], [storedExpense(1, 'Alice', 100, [{ name: 'Alice', share: 1 }, { name: 'Zed', share: 1 }])]);
  assert.deepEqual(partial.balances, { Alice: 5000, Bob: 0 });
});

// ---------------------------------------------------------------------------
// Monthly review
// ---------------------------------------------------------------------------

const USER_ID = 951;
const MONTH = '2026-01';
const NOW = new Date('2026-02-01T03:30:00.000Z');
const STAMP = '2026-01-15T06:30:00.000Z';

let testDatabase;
let db;
let ClarityService;
let FinancialRepository;
let loadLegacyReviewData;
let reviewDataFromClaritySnapshot;

async function addUser() {
  await db.prepare(
    `INSERT INTO users (id, email, name, password_hash, is_admin, token_version, created_at)
     VALUES (?, 'review-parity@example.test', 'Review Parity', 'x', 0, 1, ?)`
  ).run(USER_ID, STAMP);
}

async function addSalary(month, amount) {
  await db.prepare('INSERT INTO salary_entries (user_id, month, amount, created_at) VALUES (?, ?, ?, ?)')
    .run(USER_ID, month, amount, STAMP);
}

async function addBill(amount, active = 1) {
  await db.prepare(
    'INSERT INTO emis (user_id, label, amount, category, active, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(USER_ID, 'Bill', amount, 'Rent', active, STAMP);
}

async function addExpense(month, category, amount, day = 10) {
  await db.prepare(
    `INSERT INTO expense_log (user_id, month, category, amount, note, spent_on, created_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?)`
  ).run(USER_ID, month, category, amount, `${month}-${String(day).padStart(2, '0')}`, STAMP);
}

async function bothPaths() {
  const legacy = await loadLegacyReviewData({ database: db, userId: USER_ID, month: MONTH });
  const snapshot = await new ClarityService({ repository: new FinancialRepository(db) }).getSnapshot({
    userId: USER_ID,
    month: MONTH,
    now: NOW,
    timeZone: 'Asia/Kolkata',
  });
  return { legacy, snapshot };
}

const FIELDS = ['income', 'needs', 'wants', 'save', 'saveTarget', 'totalSpent'];
const minorFields = (review) => Object.fromEntries(FIELDS.map((field) => [field, paise(review[field])]));
const byCategory = (left, right) => left.category.localeCompare(right.category);
const categoryMinor = (review) => review.categoryTotals
  .toSorted(byCategory)
  .map(({ category, total }) => ({ category, totalMinor: paise(total) }));

before(async () => {
  testDatabase = await createIsolatedTestDatabase();
  db = testDatabase.db;
  ({ ClarityService } = await import('../../src/services/clarityService.js'));
  ({ FinancialRepository } = await import('../../src/repositories/financialRepository.js'));
  ({ loadLegacyReviewData, reviewDataFromClaritySnapshot } = await import('../../src/jobs/monthlyReview.js'));
});

beforeEach(async () => {
  await testDatabase.reset();
  await addUser();
});

after(async () => {
  await testDatabase?.cleanup();
});

const REVIEW_MATCHING = [
  {
    name: 'bills equal salary',
    seed: async () => { await addSalary(MONTH, 50_000); await addBill(20_000); await addBill(30_000); },
  },
  {
    name: 'bills exceed salary',
    seed: async () => { await addSalary(MONTH, 50_000); await addBill(60_000); },
  },
  {
    name: 'populated month with paise-precision expenses',
    seed: async () => {
      await addSalary(MONTH, 82_500);
      await addBill(20_000);
      await addBill(2_500);
      await addExpense(MONTH, 'Groceries', 1_250.5, 3);
      await addExpense(MONTH, 'Groceries', 99.25, 9);
      await addExpense(MONTH, 'Entertainment', 800, 12);
      await addExpense(MONTH, 'Transport', 120, 21);
    },
  },
  {
    name: 'month boundary: expenses of the adjacent months are excluded',
    seed: async () => {
      await addSalary(MONTH, 40_000);
      await addExpense('2025-12', 'Food', 700, 31);
      await addExpense(MONTH, 'Food', 900, 1);
      await addExpense(MONTH, 'Food', 100, 31);
      await addExpense('2026-02', 'Food', 1_100, 1);
    },
  },
];

for (const scenario of REVIEW_MATCHING) {
  test(`monthly review parity: ${scenario.name}`, async () => {
    await scenario.seed();
    const { legacy, snapshot } = await bothPaths();
    const canonical = reviewDataFromClaritySnapshot(snapshot);

    assert.deepEqual(minorFields(canonical), minorFields(legacy));
    assert.deepEqual(categoryMinor(canonical), categoryMinor(legacy));
    assert.deepEqual(canonical.recordIds, legacy.recordIds);
  });
}

test('monthly review divergence: a user with no salary or expenses is unavailable canonically but zero in legacy', async () => {
  const { legacy, snapshot } = await bothPaths();

  assert.deepEqual(minorFields(legacy), { income: 0, needs: 0, wants: 0, save: 0, saveTarget: 0, totalSpent: 0 });
  // The job falls back to the legacy zeros for this user and then skips the email.
  assert.throws(() => reviewDataFromClaritySnapshot(snapshot), /unavailable/);
});

test('monthly review divergence: legacy counts every bill while canonical counts active bills for the month', async () => {
  await addSalary(MONTH, 50_000);
  await addBill(10_000);
  await addBill(5_000, 0);
  const { legacy, snapshot } = await bothPaths();
  const canonical = reviewDataFromClaritySnapshot(snapshot);

  // Savings target is 20% of (salary - counted bills).
  assert.equal(paise(legacy.saveTarget), 700_000);
  assert.equal(paise(canonical.saveTarget), 800_000);
});

test('monthly review divergence: legacy ignores category treatments that canonical applies', async () => {
  await addSalary(MONTH, 50_000);
  await addExpense(MONTH, 'Food', 400, 5);
  await db.prepare(
    `INSERT INTO expense_category_treatments (user_id, category, treatment, updated_at)
     VALUES (?, 'Food', 'wants', ?)`
  ).run(USER_ID, STAMP);
  const { legacy, snapshot } = await bothPaths();
  const canonical = reviewDataFromClaritySnapshot(snapshot);

  assert.deepEqual([legacy.needs, legacy.wants], [400, 0]);
  assert.deepEqual([canonical.needs, canonical.wants], [0, 400]);
});

test('monthly review divergence: legacy rounds the savings target to whole rupees, canonical to paise', async () => {
  // Disposable 1000.25: canonical savings is the remainder after half-up needs and wants (200.04); legacy Math.round of 20% gives 200.
  await addSalary(MONTH, 1_000.25);
  const { legacy, snapshot } = await bothPaths();
  const canonical = reviewDataFromClaritySnapshot(snapshot);

  assert.equal(legacy.saveTarget, 200);
  assert.equal(canonical.saveTarget, 200.04);
});

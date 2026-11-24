import '../helpers/blockingStdout.js';
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { buildSessionFixture, buildUserFixture } from '../helpers/fixtures.js';
import { createIsolatedTestDatabase } from '../helpers/testDatabase.js';

/**
 * Rollout and rollback of the Quick Add server flag (task 18.2), against the real app and an isolated file database.
 *
 * rolloutRollback.integration.test.js covers the two older rollout switches, quickAddMemoryNotice.integration.test.js
 * the refusal of memory writes and the notice versions, and quickAddDataLifecycle.integration.test.js the export of
 * the new column and table. This file adds the cross-cutting claim of Requirements 16.3, 16.5, 16.13, 16.14, 16.15, and
 * 16.19: turning `QUICK_ADD_ENABLED` on to off and off to on, on the running app, loses no saved expense, mark, or
 * memory row and changes no monthly total, no Daily spending guide, no export, no monthly review, and no logging
 * streak, because each of those counts every saved expense, including one with an Allowance_Exclusion.
 *
 * Old clients (no contract header, no new field) see the same requests and responses with the flag on and off.
 */

const OWNER_ID = 18_201;
const OWNER_SESSION_ID = 18_211;
const NOTICE_VERSION_ACKNOWLEDGED = 2;
const MARKED_NOTE = 'rent-like entry';

let testDatabase;
let db;
let app;
let authorization;
let today;
let month;
let previousMonth;
let sequence;
let readServerFeatureFlags;
let runMonthlyReview;
let loadLegacyReviewData;
let CategoryMemoryService;

function tokenFor(user, session) {
  return jwt.sign(
    { sub: String(user.id), tv: user.token_version, sid: session.id },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '5m' }
  );
}

function setFlag(value) {
  if (value === undefined) delete process.env.QUICK_ADD_ENABLED;
  else process.env.QUICK_ADD_ENABLED = value ? 'true' : 'false';
}

function nextKey() {
  sequence += 1;
  return `18200000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
}

function canonical(method, path) {
  return request(app)[method](path)
    .set('Authorization', authorization)
    .set('X-Clarity-Contract', '1')
    .set('Idempotency-Key', nextKey());
}

/** A client from before the feature: no contract header, no idempotency key. */
function legacy(method, path) {
  return request(app)[method](path).set('Authorization', authorization);
}

function monthOf(offset) {
  const [year, number] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, number - 1 + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function ok(response, label) {
  assert.equal(response.status, 200, `${label}: ${JSON.stringify(response.body)}`);
  return response;
}

async function rows(sql, ...args) {
  return (await db.prepare(sql).all(...args)).map((row) => ({ ...row }));
}

const storedExpenses = () => rows('SELECT * FROM expense_log WHERE user_id = ? ORDER BY id', OWNER_ID);
const storedMemory = () => rows('SELECT * FROM category_memory WHERE user_id = ? ORDER BY id', OWNER_ID);

function withoutGeneratedAt(snapshot) {
  const { generatedAt: _generatedAt, ...rest } = snapshot;
  return rest;
}

/** Everything that must not depend on the server flag, read through the real routes and the real job. */
async function observe() {
  const clarity = ok(await canonical('get', `/api/finance/clarity?month=${month}`), 'clarity snapshot').body;
  const exported = ok(await legacy('get', '/api/auth/export'), 'json export').body;
  // Sessions record when a request last arrived, and the export names when it was made.
  const { sessions: _sessions, ...exportedData } = exported.data;
  const { exportedAt: _exportedAt, exported_at: _exportedAtSnake, generatedAt: _generatedAt, ...exportEnvelope } = exported;
  const review = await runMonthlyReview({
    dry: true,
    calculationMode: 'canonical',
    shadowCompare: false,
    log: () => {},
  });
  return {
    expenses: await storedExpenses(),
    memory: await storedMemory(),
    snapshot: withoutGeneratedAt(clarity.snapshot),
    monthlyPlan: clarity.snapshot.outcomes.monthlyPlan,
    spending: clarity.snapshot.outcomes.spending,
    legacyPlan: ok(await legacy('get', '/api/finance/plan'), 'legacy plan').body,
    expenseList: ok(await legacy('get', `/api/finance/expenses?month=${month}`), 'expense list').body,
    streak: ok(await legacy('get', '/api/finance/streak'), 'streak').body,
    csv: ok(await legacy('get', '/api/finance/export.csv'), 'csv export').text,
    exported: { ...exportEnvelope, data: exportedData },
    review,
    reviewData: await loadLegacyReviewData({ userId: OWNER_ID, month: previousMonth }),
  };
}

async function hints() {
  return ok(await legacy('get', '/api/finance/quick-add/hints'), 'hints').body.memory
    .map(({ noteKey, category, revision }) => ({ noteKey, category, revision }))
    .sort((a, b) => a.noteKey.localeCompare(b.noteKey));
}

/** Pay, a bill, and expenses for this and the previous month, written through the real routes. */
async function seedLedger({ withMark }) {
  ok(await canonical('post', '/api/finance/salary').send({ amountMinor: 8_000_000, month, expectedRecordVersion: 0 }), 'salary');
  ok(await canonical('post', '/api/finance/salary').send({ amountMinor: 7_000_000, month: previousMonth, expectedRecordVersion: 0 }), 'previous salary');
  ok(await canonical('post', '/api/finance/emis').send({ label: 'Rent', amountMinor: 2_000_000, category: 'Rent' }), 'bill');
  const expenses = [
    { amountMinor: 30_000, category: 'Food', note: 'coffee', spentOn: today },
    { amountMinor: 450_000, category: 'Shopping', note: MARKED_NOTE, spentOn: today, ...(withMark ? { excludeFromDailyAllowance: true } : {}) },
    { amountMinor: 120_000, category: 'Transport', note: 'earlier', spentOn: `${month}-01` },
    { amountMinor: 250_000, category: 'Groceries', note: 'last month', spentOn: `${previousMonth}-12` },
  ];
  const created = {};
  for (const body of expenses) {
    const response = ok(await canonical('post', '/api/finance/expenses').send(body), `expense ${body.note}`);
    created[body.note] = { id: response.body.mutation.recordId, version: response.body.mutation.recordVersion };
  }
  return created;
}

before(async () => {
  testDatabase = await createIsolatedTestDatabase();
  db = testDatabase.db;
  process.env.FINANCIAL_MUTATION_HMAC_KEY = 'test-only-quick-add-rollout-hmac-key-32-bytes-min';
  const [{ createApp }, { kolkataDateOf }, flags, review, memory] = await Promise.all([
    import('../../src/app.js'),
    import('../../src/domain/kolkataTime.js'),
    import('../../src/rollout/featureFlags.js'),
    import('../../src/jobs/monthlyReview.js'),
    import('../../src/services/categoryMemory.js'),
  ]);
  today = kolkataDateOf(new Date());
  month = today.slice(0, 7);
  previousMonth = monthOf(-1);
  ({ readServerFeatureFlags } = flags);
  ({ runMonthlyReview, loadLegacyReviewData } = review);
  ({ CategoryMemoryService } = memory);
  const silent = () => {};
  app = createApp({ operationalLogger: { debug: silent, info: silent, warn: silent, error: silent } });
});

beforeEach(async () => {
  await testDatabase.reset();
  await db.prepare('DROP TABLE IF EXISTS monthly_review_log').run();
  sequence = 0;
  setFlag(true);
  const owner = buildUserFixture({ id: OWNER_ID, email: 'quick-add-rollout@example.test', name: 'Rollout Owner' });
  const session = buildSessionFixture({ id: OWNER_SESSION_ID, userId: OWNER_ID });
  await db.prepare(
    `INSERT INTO users (id, email, name, password_hash, is_admin, token_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(owner.id, owner.email, owner.name, owner.password_hash, owner.is_admin, owner.token_version, owner.created_at);
  await db.prepare(
    `INSERT INTO sessions (id, user_id, device_label, ip_hash, user_agent, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(session.id, session.user_id, session.device_label, session.ip_hash, session.user_agent, session.created_at, session.last_seen_at);
  await db.prepare(
    `INSERT INTO user_financial_state (user_id, data_use_notice_version, data_use_acknowledged_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)`
  ).run(owner.id, NOTICE_VERSION_ACKNOWLEDGED);
  authorization = `Bearer ${tokenFor(owner, session)}`;
});

afterEach(async () => {
  setFlag(undefined);
  // authRequired updates last_seen_at without awaiting it.
  await new Promise((resolve) => setImmediate(resolve));
});

after(async () => {
  await testDatabase?.cleanup();
});

// ---------------------------------------------------------------------------------------------------------------
// Defaults (16.13, 16.18)
// ---------------------------------------------------------------------------------------------------------------

test('a deployment that sets no flag behaves as before the feature: the flag is off, memory writes are refused, and the notice is version 1', async () => {
  setFlag(undefined);
  assert.equal(readServerFeatureFlags({}).quickAddEnabled, false);
  assert.equal(readServerFeatureFlags({ QUICK_ADD_ENABLED: '' }).quickAddEnabled, false);
  assert.equal(readServerFeatureFlags({ QUICK_ADD_ENABLED: 'enabled' }).quickAddEnabled, false);
  assert.equal(readServerFeatureFlags({ QUICK_ADD_ENABLED: 'TRUE' }).quickAddEnabled, true);

  const settings = ok(await legacy('get', '/api/clarity/settings'), 'settings');
  assert.equal(settings.body.dataUseNotice.version, 1);
  const refused = await canonical('put', '/api/finance/category-memory').send({ noteKey: 'coffee', category: 'Food' });
  assert.equal(refused.status, 404);
  assert.equal(refused.body.error.code, 'QUICK_ADD_DISABLED');
  assert.deepEqual(await storedMemory(), []);
});

// ---------------------------------------------------------------------------------------------------------------
// On to off and off to on (16.3, 16.14, 16.15)
// ---------------------------------------------------------------------------------------------------------------

test('turning the server flag off and on again keeps every expense, mark, and memory row and changes no total, guide, export, review, or streak', async () => {
  setFlag(true);
  await seedLedger({ withMark: true });
  for (const [noteKey, category] of [['coffee', 'Shopping'], ['metro', 'Transport'], ['chai at the station', 'Food']]) {
    ok(await canonical('put', '/api/finance/category-memory').send({ noteKey, category }), `remember ${noteKey}`);
  }

  const markedBefore = await rows(
    'SELECT id, exclude_from_daily_allowance FROM expense_log WHERE user_id = ? AND exclude_from_daily_allowance = 1',
    OWNER_ID
  );
  assert.equal(markedBefore.length, 1, 'exactly the one expense saved with the mark carries it');
  assert.equal((await storedMemory()).length, 3);
  const withFlagOn = await observe();
  assert.ok(withFlagOn.streak.current >= 1, 'a logged day gives a streak');
  assert.equal(withFlagOn.snapshot.outcomes.todayAllowance.value.excludedToday.count, 1);
  // The mark never reaches the month: the exclusion count is inside the month's spent amount.
  const monthSpent = withFlagOn.snapshot.outcomes.spending.value.totalSpending.amountMinor;
  assert.equal(monthSpent, 30_000 + 450_000 + 120_000);
  assert.match(withFlagOn.csv, new RegExp(`${MARKED_NOTE},4500,?no|${MARKED_NOTE}.*,no`));

  // On to off.
  setFlag(false);
  assert.deepEqual(await observe(), withFlagOn, 'nothing a person can read changed when the flag went off');
  // Reading and forgetting stay available, writing is refused, and none of it touches an expense.
  assert.deepEqual(
    await hints(),
    [
      { noteKey: 'chai at the station', category: 'Food', revision: 1 },
      { noteKey: 'coffee', category: 'Shopping', revision: 1 },
      { noteKey: 'metro', category: 'Transport', revision: 1 },
    ]
  );
  const refused = await canonical('put', '/api/finance/category-memory').send({ noteKey: 'tea', category: 'Food' });
  assert.equal(refused.status, 404);
  assert.equal(refused.body.error.code, 'QUICK_ADD_DISABLED');
  assert.deepEqual((await storedMemory()).map((row) => row.note_key).sort(), ['chai at the station', 'coffee', 'metro']);

  // Off to on.
  setFlag(true);
  assert.deepEqual(await observe(), withFlagOn, 'nothing a person can read changed when the flag came back');
  const remembered = ok(await canonical('put', '/api/finance/category-memory').send({ noteKey: 'tea', category: 'Food' }), 'remember after flip');
  assert.equal(remembered.body.created, true);
  assert.equal((await storedMemory()).length, 4);
});

test('rows saved while the flag was on show again, with their marks and memory, when it comes back after a rollback, with no migration step', async () => {
  // An earlier period with the flag on left a marked expense and memory behind.
  setFlag(true);
  await seedLedger({ withMark: true });
  ok(await canonical('put', '/api/finance/category-memory').send({ noteKey: 'coffee', category: 'Shopping' }), 'remember');
  setFlag(false);
  const duringRollback = await observe();
  const marksDuringRollback = (await storedExpenses()).map((row) => [row.id, row.exclude_from_daily_allowance]);
  // Nothing in the schema changes: the column and the table are what they were, and no row was added or removed.
  const tablesBefore = await rows("SELECT name, sql FROM sqlite_master WHERE name IN ('category_memory', 'idx_category_memory_user_recency')");
  assert.equal(tablesBefore.length, 2);

  setFlag(true);
  const afterReturn = await observe();
  assert.deepEqual(afterReturn, duringRollback);
  assert.deepEqual((await storedExpenses()).map((row) => [row.id, row.exclude_from_daily_allowance]), marksDuringRollback);
  assert.deepEqual(await rows("SELECT name, sql FROM sqlite_master WHERE name IN ('category_memory', 'idx_category_memory_user_recency')"), tablesBefore);
  assert.deepEqual((await hints()).map((entry) => entry.noteKey), ['coffee']);
  const list = ok(await legacy('get', `/api/finance/expenses?month=${month}`), 'list').body.expenses;
  assert.equal(list.length, 3, 'every saved expense of the month is listed, marked or not');
});

test('the marked expense counts in every monthly value, the guide, the export, the review data, and the streak, whatever the flag says', async () => {
  setFlag(true);
  const created = await seedLedger({ withMark: true });
  const marked = await observe();
  const todayWithMark = marked.snapshot.outcomes.todayAllowance.value;
  assert.equal(todayWithMark.excludedToday.count, 1);

  // The same expense with the mark cleared, with the flag off: the table of expenses has the same rows and amounts.
  setFlag(false);
  const cleared = ok(
    await canonical('patch', `/api/finance/expenses/${created[MARKED_NOTE].id}`)
      .send({ excludeFromDailyAllowance: false, expectedRecordVersion: created[MARKED_NOTE].version }),
    'clear the mark'
  );
  assert.equal(cleared.body.mutation.record.excludeFromDailyAllowance, false);
  const unmarked = await observe();

  for (const key of ['monthlyPlan', 'spending', 'legacyPlan', 'streak', 'reviewData', 'review']) {
    assert.deepEqual(unmarked[key].value ?? unmarked[key], marked[key].value ?? marked[key], `${key} counts the expense with or without the mark`);
  }
  assert.deepEqual(
    unmarked.expenseList.expenses.map((row) => [row.id, row.amount, row.category, row.spent_on]),
    marked.expenseList.expenses.map((row) => [row.id, row.amount, row.category, row.spent_on])
  );
  // The monthly guide is the same number, and the exported amounts are the same, with and without the mark.
  assert.deepEqual(
    unmarked.snapshot.outcomes.spending.value.dailySpendingGuide,
    marked.snapshot.outcomes.spending.value.dailySpendingGuide
  );
  const amounts = (csv) => csv.trim().split('\n').slice(1).map((line) => line.split(',').slice(0, 5).join(','));
  assert.deepEqual(amounts(unmarked.csv), amounts(marked.csv));
  const todayWithoutMark = unmarked.snapshot.outcomes.todayAllowance.value;
  assert.equal(todayWithoutMark.excludedToday.count, 0);
  assert.equal(
    todayWithoutMark.todaySpent.amountMinor - todayWithMark.todaySpent.amountMinor,
    450_000,
    'only Today_Spent leaves the marked expense out'
  );
});

// ---------------------------------------------------------------------------------------------------------------
// Old clients (16.4, 16.5)
// ---------------------------------------------------------------------------------------------------------------

function shapeOf(value) {
  if (Array.isArray(value)) return value.map(shapeOf);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, shapeOf(inner)]));
  return typeof value;
}

test('a client from before the feature sends and receives the same thing with the flag on and off', async () => {
  const seen = {};
  for (const flag of [false, true]) {
    setFlag(flag);
    await testDatabase.reset();
    const owner = buildUserFixture({ id: OWNER_ID, email: 'quick-add-rollout@example.test', name: 'Rollout Owner' });
    const session = buildSessionFixture({ id: OWNER_SESSION_ID, userId: OWNER_ID });
    await db.prepare(
      `INSERT INTO users (id, email, name, password_hash, is_admin, token_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(owner.id, owner.email, owner.name, owner.password_hash, owner.is_admin, owner.token_version, owner.created_at);
    await db.prepare(
      `INSERT INTO sessions (id, user_id, device_label, ip_hash, user_agent, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(session.id, session.user_id, session.device_label, session.ip_hash, session.user_agent, session.created_at, session.last_seen_at);
    await db.prepare(
      `INSERT INTO user_financial_state (user_id, data_use_notice_version, data_use_acknowledged_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)`
    ).run(owner.id, flag ? 2 : 1);
    const created = ok(await legacy('post', '/api/finance/expenses').send({ amount: 99.5, category: 'Food', note: 'Legacy fare', spentOn: today }), 'legacy create');
    const list = ok(await legacy('get', `/api/finance/expenses?month=${month}`), 'legacy list');
    const clarityCreate = ok(
      await canonical('post', '/api/finance/expenses').send({ amountMinor: 20_000, category: 'Food', note: 'Contract fare', spentOn: today }),
      'contract create'
    );
    const removed = ok(await legacy('delete', `/api/finance/expenses/${created.body.id}`), 'legacy delete');
    seen[flag] = {
      created: shapeOf(created.body),
      list: shapeOf(list.body),
      contractCreate: shapeOf(clarityCreate.body),
      removed: shapeOf(removed.body),
      legacyListKeys: Object.keys(list.body.expenses[0]).sort(),
      // An old client that sends no mark never gets one stored.
      stored: (await storedExpenses()).map((row) => row.exclude_from_daily_allowance),
    };
  }
  assert.deepEqual(seen.true, seen.false);
  assert.deepEqual(seen.true.legacyListKeys, ['amount', 'category', 'created_at', 'id', 'month', 'note', 'spent_on']);
  assert.deepEqual(seen.true.stored, [null]);
});

test('the memory service keeps its rows when only the flag changes', async () => {
  setFlag(true);
  const service = new CategoryMemoryService();
  assert.ok(service, 'the service exists without any flag');
  ok(await canonical('put', '/api/finance/category-memory').send({ noteKey: 'bus', category: 'Transport' }), 'remember');
  const before = await storedMemory();
  for (const flag of [false, true, false, undefined, true]) {
    setFlag(flag);
    assert.deepEqual(await storedMemory(), before);
    assert.deepEqual((await hints()).map((entry) => entry.noteKey), ['bus']);
  }
});

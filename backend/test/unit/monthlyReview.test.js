import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createIsolatedTestDatabase } from '../helpers/testDatabase.js';

const USER_ID = 101;
const MONTH = '2026-01';
const NOW = new Date('2026-02-01T03:30:00.000Z');
const TIMESTAMP = '2026-01-15T06:30:00.000Z';

const PRIVATE_VALUES = Object.freeze({
  email: 'private.user@example.test',
  userName: 'Private Person Name',
  expenseNote: 'private expense note',
  category: 'PrivateCategory',
  tripName: 'Private Trip Name',
  memberName: 'Private Member Name',
  publicToken: 'abcdef0123456789abcdef0123456789',
});

let testDatabase;
let db;
let ClarityService;
let FinancialRepository;
let loadLegacyReviewData;
let monthlyReviewEmail;
let reviewDataFromClaritySnapshot;
let runMonthlyReview;

async function seedReviewRecords() {
  await db.prepare(
    `INSERT INTO users
      (id, email, name, password_hash, is_admin, token_version, created_at)
     VALUES (?, ?, ?, ?, 0, 1, ?)`
  ).run(
    USER_ID,
    PRIVATE_VALUES.email,
    PRIVATE_VALUES.userName,
    '$2b$10$abcdefghijklmnopqrstuu.ziWKiBEv.kEQhAbdWjX/e/lgxp1M1e',
    TIMESTAMP
  );
  await db.prepare(
    `INSERT INTO salary_entries (id, user_id, month, amount, created_at)
     VALUES (301, ?, ?, 1000.25, ?)`
  ).run(USER_ID, MONTH, TIMESTAMP);
  await db.prepare(
    `INSERT INTO emis
      (id, user_id, label, amount, category, active, effective_from_month, effective_to_month, created_at)
     VALUES (311, ?, ?, 100.25, 'Rent', 1, NULL, NULL, ?)`
  ).run(USER_ID, 'Private Bill Label', TIMESTAMP);
  await db.prepare(
    `INSERT INTO expense_log
      (id, user_id, month, category, amount, note, spent_on, created_at)
     VALUES (321, ?, ?, 'Food', 100, ?, '2026-01-30', ?)`
  ).run(USER_ID, MONTH, PRIVATE_VALUES.expenseNote, TIMESTAMP);
  await db.prepare(
    `INSERT INTO expense_log
      (id, user_id, month, category, amount, note, spent_on, created_at)
     VALUES (322, ?, ?, ?, 50.25, NULL, '2026-01-29', ?)`
  ).run(USER_ID, MONTH, PRIVATE_VALUES.category, TIMESTAMP);
  await db.prepare(
    `INSERT INTO savings_goals
      (id, user_id, name, target_amount, saved_amount, target_date, created_at, updated_at)
     VALUES (331, ?, ?, 1000, 0, '2026-06-30', ?, ?)`
  ).run(USER_ID, 'Private Goal Name', TIMESTAMP, TIMESTAMP);
  await db.prepare(
    `INSERT INTO trips
      (id, user_id, name, destination, budget, start_date, end_date,
       public_token, public_enabled, created_at)
     VALUES (351, ?, ?, 'Private Destination', 500, '2026-01-01', '2026-01-31', ?, 1, ?)`
  ).run(USER_ID, PRIVATE_VALUES.tripName, PRIVATE_VALUES.publicToken, TIMESTAMP);
  await db.prepare(
    `INSERT INTO trip_members (id, trip_id, user_id, name, email)
     VALUES (361, 351, ?, ?, ?)`
  ).run(USER_ID, PRIVATE_VALUES.userName, PRIVATE_VALUES.email);
  await db.prepare(
    `INSERT INTO trip_members (id, trip_id, user_id, name, email)
     VALUES (362, 351, NULL, ?, NULL)`
  ).run(PRIVATE_VALUES.memberName);
  await db.prepare(
    `INSERT INTO trip_expenses
      (id, trip_id, payer, description, amount, split_json, created_at)
     VALUES (371, 351, ?, 'Private Trip Expense', 200, ?, ?)`
  ).run(
    PRIVATE_VALUES.userName,
    JSON.stringify([
      { name: PRIVATE_VALUES.userName, share: 1 },
      { name: PRIVATE_VALUES.memberName, share: 1 },
    ]),
    TIMESTAMP
  );
}

function clarityService() {
  return new ClarityService({ repository: new FinancialRepository(db) });
}

before(async () => {
  testDatabase = await createIsolatedTestDatabase();
  db = testDatabase.db;
  ({ ClarityService } = await import('../../src/services/clarityService.js'));
  ({ FinancialRepository } = await import('../../src/repositories/financialRepository.js'));
  ({
    loadLegacyReviewData,
    reviewDataFromClaritySnapshot,
    runMonthlyReview,
  } = await import('../../src/jobs/monthlyReview.js'));
  ({ monthlyReviewEmail } = await import('../../src/mailer.js'));
});

beforeEach(async () => {
  await testDatabase.reset();
  try {
    await db.prepare('DELETE FROM monthly_review_log').run();
  } catch {
    // The job creates this table lazily on its first run.
  }
  await seedReviewRecords();
});

after(async () => {
  await testDatabase?.cleanup();
});

test('canonical prior-month results preserve the legacy monthly email for a parity fixture', async () => {
  const service = clarityService();
  const [legacy, snapshot] = await Promise.all([
    loadLegacyReviewData({ database: db, userId: USER_ID, month: MONTH }),
    service.getSnapshot({
      userId: USER_ID,
      month: MONTH,
      now: NOW,
      timeZone: 'Asia/Kolkata',
    }),
  ]);
  const canonical = reviewDataFromClaritySnapshot(snapshot);

  assert.deepEqual(
    {
      income: canonical.income,
      needs: canonical.needs,
      wants: canonical.wants,
      save: canonical.save,
      saveTarget: canonical.saveTarget,
      totalSpent: canonical.totalSpent,
      categoryTotals: canonical.categoryTotals,
      top3: canonical.top3,
    },
    {
      income: legacy.income,
      needs: legacy.needs,
      wants: legacy.wants,
      save: legacy.save,
      saveTarget: legacy.saveTarget,
      totalSpent: legacy.totalSpent,
      categoryTotals: legacy.categoryTotals,
      top3: legacy.top3,
    }
  );

  const sharedEmailFields = {
    name: PRIVATE_VALUES.userName,
    monthLabel: 'January 2026',
    streak: 0,
  };
  assert.deepEqual(
    monthlyReviewEmail({ ...sharedEmailFields, ...canonical }),
    monthlyReviewEmail({ ...sharedEmailFields, ...legacy })
  );
  assert.equal(snapshot.outcomes.goals[0].status, 'available');
  assert.equal(snapshot.outcomes.goals[0].value.feasibility, 'feasible');
});

test('legacy-selected shadow mode logs mismatch codes only', async () => {
  await db.prepare(
    `INSERT INTO expense_category_treatments (id, user_id, category, treatment, updated_at)
     VALUES (341, ?, 'Food', 'wants', ?)`
  ).run(USER_ID, TIMESTAMP);

  const jobLogs = [];
  const consoleLogs = [];
  const originalConsoleLog = console.log;
  console.log = (...parts) => consoleLogs.push(parts.join(' '));
  let result;
  try {
    result = await runMonthlyReview({
      dry: false,
      log: (message) => jobLogs.push(String(message)),
      now: NOW,
      calculationMode: 'legacy',
      shadowCompare: true,
      database: db,
      clarityService: clarityService(),
    });
  } finally {
    console.log = originalConsoleLog;
  }

  assert.deepEqual(result, {
    month: MONTH,
    sent: 1,
    skipped: 0,
    failed: 0,
    dry: false,
  });
  assert.deepEqual(consoleLogs, []);

  const shadowLogs = jobLogs.filter((message) => message.startsWith('[clarity-shadow]'));
  assert.deepEqual(
    shadowLogs.map((message) => message.match(/code=([A-Z_]+)/)?.[1]),
    ['SHADOW_NEEDS_SPENT_MISMATCH', 'SHADOW_WANTS_SPENT_MISMATCH']
  );
  assert.ok(shadowLogs.every((message) => (
    /^\[clarity-shadow\] code=SHADOW_[A-Z_]+$/.test(message)
  )));

  const allowedLogShapes = [
    /^\[monthly-review\] month=\d{4}-\d{2} dry=false$/,
    /^\[clarity-shadow\] code=SHADOW_[A-Z_]+$/,
    /^\[monthly-review\] mail code=FALLBACK user_id=\d+$/,
    /^\[monthly-review\] done · sent=\d+ skipped=\d+ failed=\d+$/,
  ];
  assert.ok(jobLogs.every((message) => allowedLogShapes.some((pattern) => pattern.test(message))));
  assert.ok(jobLogs.every((message) => (
    !/amount|email|name|note|split|token|request|subject|body|to=/i.test(message)
  )));
  for (const privateValue of Object.values(PRIVATE_VALUES)) {
    assert.ok(jobLogs.every((message) => !message.includes(privateValue)));
  }
});

test('canonical mode sends the parity fixture and keeps the legacy rollback loader selectable', async () => {
  const canonicalResult = await runMonthlyReview({
    dry: true,
    log: () => {},
    now: NOW,
    calculationMode: 'canonical',
    shadowCompare: false,
    database: db,
    clarityService: clarityService(),
  });
  const legacyResult = await runMonthlyReview({
    dry: true,
    log: () => {},
    now: NOW,
    calculationMode: 'legacy',
    shadowCompare: false,
    database: db,
    clarityService: clarityService(),
  });

  assert.deepEqual(canonicalResult, legacyResult);
  assert.equal(canonicalResult.sent, 1);
  assert.equal(canonicalResult.failed, 0);
});

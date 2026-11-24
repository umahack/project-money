import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createIsolatedTestDatabase } from '../helpers/testDatabase.js';
import { buildSessionFixture, buildUserFixture } from '../helpers/fixtures.js';

/*
 * Quick Add and Product Analytics (task 18.3; Requirements 13.8, 14.1, 14.4, 14.5, 14.6, 14.8).
 *
 * The same Quick Add flow (create, remembered category, category change, undo) runs for one User who has Product
 * Analytics enabled and one who has it disabled, through the real HTTP routes on an isolated database.
 *
 * - The accepted event names are exactly the five that existed before Quick Add, and no Quick Add name is accepted
 *   (14.5).
 * - A Quick Add change reports only through the existing value-free `financial_change_ui` event: the stored row holds
 *   the receipt ID and two false flags and nothing else, and an event that carries an amount, note, Note_Key, or
 *   category is rejected before anything is stored (14.6, 13.8).
 * - With analytics disabled nothing is stored, and every Quick Add answer equals the one the enabled User receives
 *   (14.8).
 * - No analytics table, operational log line, or console line holds an entry value (14.4).
 */
const ENABLED_ID = 83_101;
const DISABLED_ID = 83_102;
const ENABLED_SESSION_ID = 83_201;
const DISABLED_SESSION_ID = 83_202;
const NOTICE_VERSION = 2;
// Distinctive values. The amount is 98,765.43 rupees.
const SENTINEL_NOTE = 'Zq sentinel latte 7731';
const SENTINEL_NOTE_KEY = 'zq sentinel latte 7731';
const SENTINEL_AMOUNT_MINOR = 9_876_543;
const SENTINEL_AMOUNT_FORMS = ['9876543', '98765.43', '98,765.43', '98765,43'];
const PRE_FEATURE_EVENT_NAMES = [
  'journey_started',
  'first_outcome_displayed',
  'clarity_response',
  'recommended_action_completed',
  'financial_change_ui',
];
const QUICK_ADD_EVENT_NAMES = [
  'quick_add_saved',
  'quick_add_undo',
  'quick_add_category_change',
  'quick_add_opened',
  'quick_add_failed',
  'category_memory_changed',
  'category_memory_forgotten',
  'today_allowance_viewed',
  'entry_saved',
  'undo',
];

let testDatabase;
let db;
let app;
let kolkataDateOf;
let enabledAuthorization;
let disabledAuthorization;
let capturedLogs;
let consoleLines;
let restoreConsole = () => {};
let previousQuickAdd;
let keyCounter = 0;

function tokenFor(user, session) {
  return `Bearer ${jwt.sign(
    { sub: String(user.id), tv: user.token_version, sid: session.id },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '5m' },
  )}`;
}

async function insertAccount(user, session) {
  await db.prepare(
    `INSERT INTO users (id, email, name, password_hash, is_admin, token_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(user.id, user.email, user.name, user.password_hash, user.is_admin, user.token_version, user.created_at);
  await db.prepare(
    `INSERT INTO sessions (id, user_id, device_label, ip_hash, user_agent, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(session.id, session.user_id, session.device_label, session.ip_hash, session.user_agent, session.created_at, session.last_seen_at);
  await db.prepare(
    `INSERT INTO user_financial_state (user_id, data_use_notice_version, data_use_acknowledged_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)`,
  ).run(user.id, NOTICE_VERSION);
}

function captureConsole() {
  const original = {};
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
    original[method] = console[method];
    console[method] = (...args) => {
      consoleLines.push(args.map((arg) => {
        if (typeof arg === 'string') return arg;
        if (arg instanceof Error) return `${arg.name}: ${arg.message}\n${arg.stack ?? ''}`;
        try { return JSON.stringify(arg); } catch { return String(arg); }
      }).join(' '));
    };
  }
  restoreConsole = () => {
    for (const [method, fn] of Object.entries(original)) console[method] = fn;
    restoreConsole = () => {};
  };
}

const nextKey = () => {
  keyCounter += 1;
  return `93000000-0000-4000-8000-${String(keyCounter).padStart(12, '0')}`;
};

function canonical(builder, authorization, key = nextKey()) {
  return builder
    .set('Authorization', authorization)
    .set('X-Clarity-Contract', '1')
    .set('Idempotency-Key', key);
}

function postEvent(body, authorization) {
  return request(app).post('/api/clarity/events').set('Authorization', authorization).send(body);
}

async function setAnalytics(authorization, enabled) {
  const response = await request(app)
    .patch('/api/clarity/settings')
    .set('Authorization', authorization)
    .send(enabled
      ? { acknowledgedNoticeVersion: NOTICE_VERSION, analyticsEnabled: true }
      : { analyticsEnabled: false });
  assert.equal(response.status, 200, JSON.stringify(response.body));
}

async function storedEvents(userId) {
  return db.prepare('SELECT * FROM product_measurement_events WHERE user_id = ? ORDER BY id').all(userId);
}

/**
 * Runs one Quick Add flow for a User and reports each confirmed change the way the browser does. Returns what the
 * User saw (values the answer is built from) and the status of every event report.
 */
async function runQuickAddFlow(authorization) {
  const spentOn = kolkataDateOf(new Date());
  const seen = [];
  const eventStatuses = [];
  const report = async (changeId) => {
    const response = await postEvent({
      event: 'financial_change_ui',
      changeId,
      causedReload: false,
      causedPageWideLoading: false,
      occurredAt: new Date().toISOString(),
    }, authorization);
    eventStatuses.push(response.status);
  };

  const created = await canonical(request(app).post('/api/finance/expenses'), authorization).send({
    amountMinor: SENTINEL_AMOUNT_MINOR,
    category: 'Food',
    note: SENTINEL_NOTE,
    spentOn,
    expectedRecordVersion: 0,
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const expenseId = created.body.id;
  seen.push({
    step: 'create',
    status: created.status,
    amountMinor: created.body.mutation.record.amountMinor,
    category: created.body.mutation.resultingCategory,
    spending: created.body.clarity.outcomes.spending.value.totalSpending.amountMinor,
    todayStatus: created.body.clarity.outcomes.todayAllowance?.status ?? null,
    todaySpent: created.body.clarity.outcomes.todayAllowance?.value?.todaySpent?.amountMinor ?? null,
  });
  await report(created.body.mutation.changeId);

  const remembered = await request(app)
    .put('/api/finance/category-memory')
    .set('Authorization', authorization)
    .send({ noteKey: SENTINEL_NOTE_KEY, category: 'Transport' });
  seen.push({ step: 'memory', status: remembered.status });
  assert.equal(remembered.status, 200, JSON.stringify(remembered.body));

  const changed = await canonical(request(app).patch(`/api/finance/expenses/${expenseId}`), authorization).send({
    category: 'Transport',
    expectedRecordVersion: created.body.mutation.record.version,
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  seen.push({
    step: 'category',
    status: changed.status,
    category: changed.body.mutation.resultingCategory,
    spending: changed.body.clarity.outcomes.spending.value.totalSpending.amountMinor,
  });
  await report(changed.body.mutation.changeId);

  const undone = await canonical(request(app).delete(`/api/finance/expenses/${expenseId}`), authorization).send({});
  assert.equal(undone.status, 200, JSON.stringify(undone.body));
  seen.push({
    step: 'undo',
    status: undone.status,
    spending: undone.body.clarity.outcomes.spending.value.totalSpending.amountMinor,
    todaySpent: undone.body.clarity.outcomes.todayAllowance?.value?.todaySpent?.amountMinor ?? null,
  });
  await report(undone.body.mutation.changeId);

  return { seen, eventStatuses };
}

before(async () => {
  testDatabase = await createIsolatedTestDatabase();
  db = testDatabase.db;
  process.env.FINANCIAL_MUTATION_HMAC_KEY = 'test-only-quick-add-analytics-hmac-key-32-bytes-minimum';
  previousQuickAdd = process.env.QUICK_ADD_ENABLED;
  const [{ createApp }, kolkata] = await Promise.all([
    import('../../src/app.js'),
    import('../../src/domain/kolkataTime.js'),
  ]);
  kolkataDateOf = kolkata.kolkataDateOf;
  capturedLogs = [];
  consoleLines = [];
  const capture = (level) => (fields) => capturedLogs.push(JSON.stringify({ level, ...fields }));
  app = createApp({
    operationalLogger: {
      debug: capture('debug'),
      info: capture('info'),
      warn: capture('warn'),
      error: capture('error'),
    },
  });
});

beforeEach(async () => {
  await testDatabase.reset();
  process.env.QUICK_ADD_ENABLED = 'true';
  capturedLogs.length = 0;
  consoleLines.length = 0;
  captureConsole();
  const enabled = buildUserFixture({ id: ENABLED_ID, email: 'quick-add-analytics-on@example.test' });
  const disabled = buildUserFixture({ id: DISABLED_ID, email: 'quick-add-analytics-off@example.test' });
  const enabledSession = buildSessionFixture({ id: ENABLED_SESSION_ID, userId: ENABLED_ID });
  const disabledSession = buildSessionFixture({ id: DISABLED_SESSION_ID, userId: DISABLED_ID });
  await insertAccount(enabled, enabledSession);
  await insertAccount(disabled, disabledSession);
  enabledAuthorization = tokenFor(enabled, enabledSession);
  disabledAuthorization = tokenFor(disabled, disabledSession);
  for (const [userId, amount] of [[ENABLED_ID, 5_000_000], [DISABLED_ID, 5_000_000]]) {
    await db.prepare('INSERT INTO salary_entries (user_id, month, amount) VALUES (?, ?, ?)')
      .run(userId, kolkataDateOf(new Date()).slice(0, 7), amount);
  }
});

afterEach(async () => {
  restoreConsole();
  process.env.QUICK_ADD_ENABLED = 'false';
  await new Promise((resolve) => setImmediate(resolve));
});

after(async () => {
  restoreConsole();
  if (previousQuickAdd === undefined) delete process.env.QUICK_ADD_ENABLED;
  else process.env.QUICK_ADD_ENABLED = previousQuickAdd;
  await testDatabase?.cleanup();
});

test('the accepted Product Analytics event names are the five that existed before Quick Add', async () => {
  const { MEASUREMENT_EVENT_NAMES } = await import('../../src/services/measurementService.js');
  assert.deepEqual([...MEASUREMENT_EVENT_NAMES], PRE_FEATURE_EVENT_NAMES);
});

test('no Quick Add event name is accepted, with analytics enabled or disabled, and nothing is stored', async () => {
  await setAnalytics(enabledAuthorization, true);
  await setAnalytics(disabledAuthorization, false);
  const occurredAt = new Date().toISOString();
  for (const authorization of [enabledAuthorization, disabledAuthorization]) {
    for (const event of QUICK_ADD_EVENT_NAMES) {
      const response = await postEvent({ event, changeId: 1, causedReload: false, causedPageWideLoading: false, occurredAt }, authorization);
      assert.equal(response.status, 400, event);
      assert.equal(response.body.error.code, 'UNKNOWN_EVENT', event);
    }
  }
  const rows = await db.prepare('SELECT COUNT(*) AS count FROM product_measurement_events').get();
  assert.equal(Number(rows.count), 0);
});

test('an event that carries an entry value is rejected before anything is stored', async () => {
  await setAnalytics(enabledAuthorization, true);
  const created = await canonical(request(app).post('/api/finance/expenses'), enabledAuthorization).send({
    amountMinor: 12_000, category: 'Food', note: SENTINEL_NOTE, spentOn: kolkataDateOf(new Date()), expectedRecordVersion: 0,
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const base = {
    event: 'financial_change_ui',
    changeId: created.body.mutation.changeId,
    causedReload: false,
    causedPageWideLoading: false,
    occurredAt: new Date().toISOString(),
  };
  const extras = {
    amount: '120',
    amountMinor: 12_000,
    note: SENTINEL_NOTE,
    noteKey: SENTINEL_NOTE_KEY,
    category: 'Food',
    spentOn: kolkataDateOf(new Date()),
    quickAddLine: `120 ${SENTINEL_NOTE}`,
    excludeFromDailyAllowance: true,
    todayAllowance: 300_000,
  };
  for (const [field, value] of Object.entries(extras)) {
    const response = await postEvent({ ...base, [field]: value }, enabledAuthorization);
    assert.equal(response.status, 400, field);
    assert.equal(response.body.error.code, 'UNKNOWN_EVENT_FIELD', field);
    assert.ok(!JSON.stringify(response.body).includes(SENTINEL_NOTE), `${field} is not echoed`);
  }
  assert.equal((await storedEvents(ENABLED_ID)).length, 0);
  // The exact schema is accepted and stores the receipt ID and the two flags.
  const accepted = await postEvent(base, enabledAuthorization);
  assert.ok(accepted.status >= 200 && accepted.status < 300, JSON.stringify(accepted.body));
  assert.equal((await storedEvents(ENABLED_ID)).length, 1);
});

test('with analytics enabled a Quick Add flow reports only value-free financial_change_ui events', async () => {
  await setAnalytics(enabledAuthorization, true);
  const flow = await runQuickAddFlow(enabledAuthorization);
  assert.equal(flow.eventStatuses.length, 3);
  for (const status of flow.eventStatuses) assert.ok(status >= 200 && status < 300, `status ${status}`);

  const rows = await storedEvents(ENABLED_ID);
  assert.equal(rows.length, 3, 'one event for each confirmed create, category change, and undo');
  for (const row of rows) {
    assert.equal(row.event_name, 'financial_change_ui');
    assert.equal(row.caused_reload, 0);
    assert.equal(row.caused_page_wide_loading, 0);
    assert.ok(Number.isSafeInteger(Number(row.change_id)) && Number(row.change_id) > 0);
    for (const column of ['journey_id', 'outcome_kind', 'desired_outcome', 'response', 'action_key', 'recommendation_instance_id']) {
      assert.equal(row[column], null, column);
    }
  }
  assert.equal(new Set(rows.map((row) => Number(row.change_id))).size, 3);
  // Every stored name is one of the names that existed before the feature.
  const names = await db.prepare('SELECT DISTINCT event_name FROM product_measurement_events').all();
  for (const { event_name: name } of names) assert.ok(PRE_FEATURE_EVENT_NAMES.includes(name), name);
});

test('with analytics disabled the same flow stores nothing and gives the same saves, answers, and Today values', async () => {
  await setAnalytics(enabledAuthorization, true);
  await setAnalytics(disabledAuthorization, false);
  const enabledFlow = await runQuickAddFlow(enabledAuthorization);
  const disabledFlow = await runQuickAddFlow(disabledAuthorization);

  assert.deepEqual(disabledFlow.seen, enabledFlow.seen);
  // Reports from a disabled User are accepted as no-ops: no error reaches the page, and no row is stored.
  for (const status of disabledFlow.eventStatuses) assert.ok(status >= 200 && status < 300, `status ${status}`);
  assert.equal((await storedEvents(DISABLED_ID)).length, 0);
  assert.equal((await storedEvents(ENABLED_ID)).length, 3);
  // The flow itself left the same ledger state for both Users.
  for (const userId of [ENABLED_ID, DISABLED_ID]) {
    const left = await db.prepare('SELECT COUNT(*) AS count FROM expense_log WHERE user_id = ?').get(userId);
    assert.equal(Number(left.count), 0, 'undo removed the expense');
    const memory = await db.prepare('SELECT note_key, category FROM category_memory WHERE user_id = ?').all(userId);
    assert.deepEqual(memory.map((row) => ({ noteKey: row.note_key, category: row.category })), [
      { noteKey: SENTINEL_NOTE_KEY, category: 'Transport' },
    ]);
  }
});

test('no analytics table, operational log line, or console line holds an entry value', async () => {
  await setAnalytics(enabledAuthorization, true);
  await runQuickAddFlow(enabledAuthorization);
  await runQuickAddFlow(enabledAuthorization);

  const tables = (await db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE '%measurement%' OR name LIKE '%visit%' OR name LIKE '%analytics%')",
  ).all()).map((row) => row.name);
  assert.ok(tables.includes('product_measurement_events'));
  let analyticsText = '';
  for (const table of tables) {
    analyticsText += JSON.stringify(await db.prepare(`SELECT * FROM ${table}`).all());
  }
  const values = [SENTINEL_NOTE, SENTINEL_NOTE_KEY, 'zq sentinel', ...SENTINEL_AMOUNT_FORMS];
  for (const value of values) assert.ok(!analyticsText.includes(value), `analytics tables hold ${value.length}-character value`);

  const logText = `${capturedLogs.join('\n')}\n${consoleLines.join('\n')}`;
  assert.ok(capturedLogs.length > 0, 'the flow wrote operational log lines');
  for (const value of values) assert.ok(!logText.includes(value), `logs hold ${value.length}-character value`);
});

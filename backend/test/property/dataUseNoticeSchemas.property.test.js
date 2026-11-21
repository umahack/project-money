import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import fc from 'fast-check';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createIsolatedTestDatabase } from '../helpers/testDatabase.js';

const API_NUM_RUNS = 100;
const GATE_NUM_RUNS = 200;
const CREATED_AT = '2026-01-15T06:30:00.000Z';
const PASSWORD = 'Property-test-password-1!';
const ID_BASE = 8_200_000;

// Every field any generated command legitimately reads. Generated extras are
// filtered against this list so they can never override a fixed field.
const KNOWN_COMMAND_FIELDS = new Set([
  'amount', 'amountMinor', 'month', 'label', 'category', 'note', 'spentOn',
  'expectedRecordVersion', 'applicableMonth', 'active', 'effectiveFromMonth',
  'effectiveToMonth', 'name', 'targetAmount', 'targetDate', 'savedAmount',
  'dayOfMonth', 'budget', 'destination', 'startDate', 'endDate', 'id',
]);
const SPECIAL_EXTRA_KEYS = [
  '__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty',
  'acknowledgedAt', 'timeZone', 'userId', 'user_id', 'email', 'public_token',
  'analytics', 'dataVersion', 'idempotencyKey', 'requestFingerprint', '$where', 'a.b',
  'データ',
];
const SETTINGS_FIELDS = ['acknowledgedNoticeVersion', 'analyticsEnabled'];
const GATE_ERROR_KEYS = [
  'acknowledgedNoticeVersion', 'code', 'currentNoticeVersion', 'message',
  'requiredNoticeVersion', 'settingsPath',
];

// Tables whose rows carry the account's user_id. Sessions are excluded because
// authentication legitimately refreshes last_seen_at on every request.
const USER_TABLES = [
  'salary_entries', 'emis', 'expense_log', 'savings_goals', 'recurring_expenses',
  'trips', 'trip_members', 'financial_record_changes', 'user_financial_state',
  'expense_category_treatments', 'guided_journeys', 'product_measurement_events',
];

const COMMANDS = Object.freeze({
  salary: {
    path: '/api/finance/salary',
    table: 'salary_entries',
    mutation: true,
    fixed: (c) => ({ month: c.month, amount: c.amount }),
  },
  bill: {
    path: '/api/finance/emis',
    table: 'emis',
    mutation: true,
    fixed: (c) => ({ label: `Bill ${c.amount}`, amount: c.amount, category: 'Rent' }),
  },
  expense: {
    path: '/api/finance/expenses',
    table: 'expense_log',
    mutation: true,
    fixed: (c) => ({ amount: c.amount, category: 'Food', spentOn: `${currentMonth()}-01` }),
  },
  goal: {
    path: '/api/finance/goals',
    table: 'savings_goals',
    mutation: true,
    fixed: (c) => ({
      name: `Goal ${c.amount}`,
      targetAmount: c.amount + 1,
      targetDate: `${new Date().getFullYear() + 1}-12-31`,
    }),
  },
  recurring: {
    path: '/api/finance/recurring',
    table: 'recurring_expenses',
    mutation: false,
    fixed: (c) => ({
      label: `Recurring ${c.amount}`,
      amount: c.amount,
      category: 'Food',
      dayOfMonth: (c.amount % 28) + 1,
    }),
  },
  trip: {
    path: '/api/trips',
    table: 'trips',
    mutation: false,
    fixed: (c) => ({ name: `Trip ${c.amount}`, budget: c.amount }),
  },
});

const extraArbitrary = fc.record({
  special: fc.boolean(),
  specialKey: fc.constantFrom(...SPECIAL_EXTRA_KEYS),
  suffix: fc.stringMatching(/^[a-z]{1,6}$/),
  shape: fc.integer({ min: 0, max: 3 }),
  json: fc.jsonValue({ maxDepth: 2 }),
});
const extrasArbitrary = fc.array(extraArbitrary, { minLength: 0, maxLength: 5 });

const patchArbitrary = fc.record({
  extras: fc.array(extraArbitrary, { minLength: 0, maxLength: 2 }),
  includeVersion: fc.boolean(),
  version: fc.oneof(
    fc.integer({ min: -3, max: 6 }),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.string({ maxLength: 4 }),
    fc.constant(null),
    fc.boolean(),
    fc.constant([1]),
    fc.constant({ version: 1 })
  ),
  analytics: fc.option(fc.boolean(), { nil: undefined }),
});

const caseArbitrary = fc.record({
  kind: fc.constantFrom(...Object.keys(COMMANDS)),
  declaresNewUse: fc.boolean(),
  acknowledgedBefore: fc.boolean(),
  hasStateRow: fc.boolean(),
  salaryExists: fc.boolean(),
  deleteWhileUnacknowledged: fc.boolean(),
  malformedRejectedBody: fc.boolean(),
  amount: fc.integer({ min: 1, max: 500_000 }),
  year: fc.integer({ min: 2024, max: 2026 }),
  monthNumber: fc.integer({ min: 1, max: 12 }),
  firstExtras: extrasArbitrary,
  secondExtras: extrasArbitrary,
  thirdExtras: extrasArbitrary,
  patch: patchArbitrary,
});

let testDatabase;
let db;
let app;
let passwordHash;
let caseSequence = 0;
let completedApiCases = 0;
let processedCommandCases = 0;
let rejectedCommandCases = 0;
let rejectedPatchCases = 0;
let unacknowledgedDeletions = 0;

function currentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function buildExtras(extras, marker) {
  const entries = [];
  for (const extra of extras) {
    const key = extra.special ? extra.specialKey : `x${extra.suffix}_${marker}`;
    if (KNOWN_COMMAND_FIELDS.has(key) || SETTINGS_FIELDS.includes(key)) continue;
    const value = [
      marker,
      [marker, extra.json],
      { nested: marker, data: extra.json },
      { [marker]: extra.json },
    ][extra.shape];
    entries.push([key, value]);
  }
  return entries;
}

// Object.fromEntries defines own data properties, so '__proto__' stays an
// ordinary JSON key instead of replacing the prototype.
function jsonBody(entries) {
  return JSON.stringify(Object.fromEntries(entries));
}

function replacer(_key, value) {
  return typeof value === 'bigint' ? value.toString() : value;
}

async function snapshotUser(userId) {
  const snapshot = {};
  for (const table of USER_TABLES) {
    snapshot[table] = await db.prepare(
      `SELECT * FROM ${table} WHERE user_id = ? ORDER BY 1`
    ).all(userId);
  }
  return JSON.parse(JSON.stringify(snapshot, replacer));
}

async function countRows(table, userId) {
  const row = await db.prepare(
    `SELECT COUNT(*) AS count FROM ${table} WHERE user_id = ?`
  ).get(userId);
  return Number(row.count);
}

async function dataVersion(userId) {
  const row = await db.prepare(
    'SELECT data_version FROM user_financial_state WHERE user_id = ?'
  ).get(userId);
  return row ? Number(row.data_version) : null;
}

function modelPatch(parsed, state) {
  const keys = Object.keys(parsed);
  if (keys.length === 0) return { status: 400, code: 'EMPTY_SETTINGS_PATCH' };
  const unknown = keys.filter((key) => !SETTINGS_FIELDS.includes(key)).sort();
  if (unknown.length > 0) {
    return { status: 400, code: 'UNKNOWN_SETTINGS_FIELD', field: unknown[0] };
  }
  const hasVersion = Object.hasOwn(parsed, 'acknowledgedNoticeVersion');
  if (hasVersion && parsed.acknowledgedNoticeVersion !== 1) {
    return { status: 400, code: 'INVALID_NOTICE_VERSION' };
  }
  const resultingAck = hasVersion ? 1 : state.ack;
  if (parsed.analyticsEnabled === true && resultingAck < 1) {
    return { status: 428, code: 'DATA_NOTICE_REQUIRED' };
  }
  return {
    status: 200,
    state: {
      ack: resultingAck,
      analytics: Object.hasOwn(parsed, 'analyticsEnabled')
        ? parsed.analyticsEnabled
        : state.analytics,
    },
  };
}

async function insertAccount(ids, seq) {
  await db.prepare(
    `INSERT INTO users (id, email, name, password_hash, is_admin, token_version, created_at)
     VALUES (?, ?, ?, ?, 0, 1, ?)`
  ).run(ids.userId, `notice-pbt-${seq}@example.test`, `Notice PBT ${seq}`, passwordHash, CREATED_AT);
  await db.prepare(
    `INSERT INTO sessions
      (id, user_id, device_label, ip_hash, user_agent, created_at, last_seen_at)
     VALUES (?, ?, 'Property test session', 'test-only-ip-hash', 'property-test', ?, ?)`
  ).run(ids.sessionId, ids.userId, CREATED_AT, CREATED_AT);
}

async function runApiCase(c) {
  caseSequence += 1;
  const seq = caseSequence;
  const ids = { userId: ID_BASE + seq, sessionId: ID_BASE + seq };
  const marker = `PBTMARK${seq}X`;
  const command = COMMANDS[c.kind];
  const month = `${c.year}-${String(c.monthNumber).padStart(2, '0')}`;
  const commandInput = { amount: c.amount, month };
  const address = `10.${(seq >> 16) & 255}.${(seq >> 8) & 255}.${seq & 255}`;
  const authorization = `Bearer ${jwt.sign(
    { sub: String(ids.userId), tv: 1, sid: ids.sessionId },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '5m' }
  )}`;

  const call = (method, path) => request(app)[method](path)
    .set('Authorization', authorization)
    .set('X-Forwarded-For', address);
  const patchSettings = (text) => call('patch', '/api/clarity/settings')
    .set('Content-Type', 'application/json')
    .send(text);

  await insertAccount(ids, seq);
  const expense = await db.prepare(
    `INSERT INTO expense_log (user_id, month, category, amount, spent_on)
     VALUES (?, ?, 'Food', 125, ?)`
  ).run(ids.userId, currentMonth(), `${currentMonth()}-02`);
  const goal = await db.prepare(
    `INSERT INTO savings_goals (user_id, name, target_amount, saved_amount)
     VALUES (?, 'Seeded goal', 5000, 100)`
  ).run(ids.userId);
  const expenseId = Number(expense.lastInsertRowid);
  const goalId = Number(goal.lastInsertRowid);
  const salaryExists = c.kind === 'salary' && c.salaryExists;
  if (salaryExists) {
    await db.prepare(
      'INSERT INTO salary_entries (user_id, month, amount) VALUES (?, ?, 40000)'
    ).run(ids.userId, month);
  }

  // ---- Establish the notice state, then try to corrupt it with extras. ----
  let state = { ack: 0, analytics: false };
  if (c.acknowledgedBefore) {
    const acknowledged = await patchSettings(jsonBody([['acknowledgedNoticeVersion', 1]]));
    assert.equal(acknowledged.status, 200);
    state = { ack: 1, analytics: false };
  } else if (c.hasStateRow) {
    const created = await patchSettings(jsonBody([['analyticsEnabled', false]]));
    assert.equal(created.status, 200);
  }

  const patchEntries = [];
  if (c.patch.includeVersion) patchEntries.push(['acknowledgedNoticeVersion', c.patch.version]);
  if (c.patch.analytics !== undefined) patchEntries.push(['analyticsEnabled', c.patch.analytics]);
  patchEntries.push(...buildExtras(c.patch.extras, marker));
  const patchText = jsonBody(patchEntries);
  const expectedPatch = modelPatch(JSON.parse(patchText), state);
  const beforePatch = await snapshotUser(ids.userId);
  const patched = await patchSettings(patchText);
  assert.equal(patched.status, expectedPatch.status, patchText);
  if (expectedPatch.status === 200) {
    state = expectedPatch.state;
  } else {
    rejectedPatchCases += 1;
    assert.equal(patched.body.error.code, expectedPatch.code);
    if (expectedPatch.field !== undefined) assert.equal(patched.body.error.field, expectedPatch.field);
    assert.deepEqual(await snapshotUser(ids.userId), beforePatch, 'a rejected patch must change nothing');
  }
  // The rejection names the first unknown field (asserted above); nothing else
  // from the request may be echoed.
  const { field: _namedField, ...echoedBody } = patched.body.error ?? {};
  assert.equal(JSON.stringify({ ...patched.body, error: echoedBody }).includes(marker), false);
  const settings = await call('get', '/api/clarity/settings');
  assert.equal(settings.status, 200);
  assert.equal(settings.body.dataUseNotice.acknowledgedVersion, state.ack);
  assert.equal(settings.body.productAnalytics.enabled, state.analytics);
  assert.deepEqual(settings.body.dataUseNotice.acknowledgementRequired, state.ack < 1);

  // ---- Submit the financial command. ----
  const headers = { 'Content-Type': 'application/json' };
  if (c.declaresNewUse) headers['X-Clarity-Contract'] = '1';
  const useIdempotency = c.declaresNewUse && command.mutation;
  const idempotencyKey = `b2500000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
  const submit = (extras, { malformed = false } = {}) => {
    const fixed = malformed ? [] : Object.entries(command.fixed(commandInput));
    if (salaryExists && c.declaresNewUse && !malformed) fixed.push(['expectedRecordVersion', 0]);
    let pending = call('post', command.path).set(headers);
    if (useIdempotency) pending = pending.set('Idempotency-Key', idempotencyKey);
    return pending.send(jsonBody([...fixed, ...buildExtras(extras, marker)]));
  };

  const mustBeRejected = c.declaresNewUse && state.ack < 1 && !salaryExists;
  let versionAfterProcessing = null;
  const processCommand = async (extras) => {
    const baseline = await countRows(command.table, ids.userId);
    const response = await submit(extras);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(JSON.stringify(response.body).includes(marker), false);
    assert.equal(
      await countRows(command.table, ids.userId),
      baseline + (salaryExists ? 0 : 1)
    );
    versionAfterProcessing = await dataVersion(ids.userId);
    processedCommandCases += 1;
  };

  if (mustBeRejected) {
    const before = await snapshotUser(ids.userId);
    const rejected = await submit(c.firstExtras, { malformed: c.malformedRejectedBody });
    assert.equal(rejected.status, 428, JSON.stringify(rejected.body));
    assert.deepEqual(Object.keys(rejected.body), ['error']);
    assert.deepEqual(Object.keys(rejected.body.error).sort(), GATE_ERROR_KEYS);
    assert.equal(rejected.body.error.code, 'DATA_NOTICE_REQUIRED');
    assert.equal(rejected.body.error.requiredNoticeVersion, 1);
    assert.equal(rejected.body.error.currentNoticeVersion, 1);
    assert.equal(rejected.body.error.acknowledgedNoticeVersion, state.ack);
    assert.equal(rejected.body.error.settingsPath, '/api/clarity/settings');
    assert.equal(JSON.stringify(rejected.body).includes(marker), false);
    assert.deepEqual(await snapshotUser(ids.userId), before, 'rejection must precede all processing');
    rejectedCommandCases += 1;
  } else {
    await processCommand(c.firstExtras);
  }

  // ---- Read, export, correction, and deletion stay available. ----
  const clarity = await call('get', `/api/finance/clarity?month=${currentMonth()}`);
  assert.equal(clarity.status, 200);
  const exported = await call('get', '/api/auth/export');
  assert.equal(exported.status, 200);
  assert.ok(exported.body.data.expenses.some((row) => Number(row.id) === expenseId));
  assert.ok(exported.body.data.savings_goals.some((row) => Number(row.id) === goalId));
  assert.equal(JSON.stringify(exported.body).includes(marker), false);
  const corrected = await call('patch', `/api/finance/goals/${goalId}`)
    .send({ name: 'Corrected goal' });
  assert.equal(corrected.status, 200);
  assert.deepEqual(corrected.body, { ok: true });
  const deletedExpense = await call('delete', `/api/finance/expenses/${expenseId}`);
  assert.equal(deletedExpense.status, 200);
  assert.deepEqual(deletedExpense.body, { ok: true });

  if (mustBeRejected && c.deleteWhileUnacknowledged) {
    unacknowledgedDeletions += 1;
  } else {
    if (mustBeRejected) {
      // Acknowledging the current notice version admits the same command.
      const acknowledged = await patchSettings(jsonBody([['acknowledgedNoticeVersion', 1]]));
      assert.equal(acknowledged.status, 200);
      await processCommand(c.secondExtras);
    }
    if (useIdempotency) {
      // Extra fields are outside the fingerprinted command, so a replay with
      // different extras is the same command and must not duplicate it.
      const countBeforeReplay = await countRows(command.table, ids.userId);
      const versionBeforeReplay = await dataVersion(ids.userId);
      assert.equal(versionBeforeReplay, versionAfterProcessing);
      const replay = await submit(mustBeRejected ? c.thirdExtras : c.secondExtras);
      assert.equal(replay.status, 200, JSON.stringify(replay.body));
      assert.equal(JSON.stringify(replay.body).includes(marker), false);
      assert.equal(await countRows(command.table, ids.userId), countBeforeReplay);
      assert.equal(await dataVersion(ids.userId), versionBeforeReplay);
    }
  }

  const persisted = JSON.stringify(await snapshotUser(ids.userId));
  assert.equal(persisted.includes(marker), false, 'extra fields must never be persisted');

  // ---- Account deletion works regardless of notice state and leaves nothing. ----
  const deleted = await call('delete', '/api/auth/account').send({ currentPassword: PASSWORD });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.deepEqual(deleted.body, { ok: true });
  assert.equal(
    await db.prepare('SELECT id FROM users WHERE id = ?').get(ids.userId),
    undefined
  );
  const remaining = await snapshotUser(ids.userId);
  for (const table of USER_TABLES) assert.deepEqual(remaining[table], [], table);
  completedApiCases += 1;
}

before(async () => {
  testDatabase = await createIsolatedTestDatabase();
  db = testDatabase.db;
  process.env.FINANCIAL_MUTATION_HMAC_KEY =
    'test-only-data-use-schema-hmac-key-32-bytes-minimum';
  passwordHash = await bcrypt.hash(PASSWORD, 4);
  // One reset for the whole run. Each generated case uses unique identifiers
  // and deletes its own account, so no per-case reset is needed.
  await testDatabase.reset();
  const { createApp } = await import('../../src/app.js');
  app = createApp();
});

after(async () => {
  await testDatabase?.cleanup();
});

// Feature: financial-clarity-experience, Property 25: Data-use versioning and command schemas minimize data
// **Validates: Requirements 11.3, 11.4**
test(
  'Property 25: settings and financial commands accept fixed fields, reject before processing, and keep read/export/delete access',
  { timeout: 900_000 },
  async () => {
    await fc.assert(
      fc.asyncProperty(caseArbitrary, async (c) => {
        await new Promise((resolve) => setImmediate(resolve));
        await runApiCase(c);
      }),
      { numRuns: API_NUM_RUNS }
    );
    assert.equal(completedApiCases, API_NUM_RUNS);
    assert.ok(rejectedCommandCases > 0, 'the generator must exercise 428 rejections');
    assert.ok(processedCommandCases > 0, 'the generator must exercise accepted commands');
    assert.ok(rejectedPatchCases > 0, 'the generator must exercise rejected settings patches');
    assert.ok(unacknowledgedDeletions > 0, 'the generator must delete accounts without acknowledgement');
  }
);

// Feature: financial-clarity-experience, Property 25: Data-use versioning and command schemas minimize data
// **Validates: Requirements 11.3, 11.4**
test(
  'Property 25: notice-version gate compares versions exactly and never echoes request fields',
  async () => {
    const {
      ClaritySettingsError,
      ClaritySettingsService,
      CURRENT_DATA_USE_NOTICE_VERSION: CURRENT,
    } = await import('../../src/services/claritySettings.js');
    const { createDataUseNoticeGate } = await import('../../src/middleware/dataUse.js');

    const requiredArbitrary = fc.oneof(
      fc.integer({ min: 0, max: CURRENT }),
      fc.integer({ min: -5, max: -1 }),
      fc.integer({ min: CURRENT + 1, max: CURRENT + 5 }),
      fc.double({ noNaN: true, noDefaultInfinity: true }).filter((value) => !Number.isInteger(value)),
      fc.constant(String(CURRENT)),
      fc.constant(null)
    );
    const inRange = (value) => Number.isSafeInteger(value) && value >= 0 && value <= CURRENT;
    let cases = 0;

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 8 }),
        requiredArbitrary,
        fc.boolean(),
        extrasArbitrary,
        async (acknowledged, required, applies, extras) => {
          cases += 1;
          const marker = `GATEMARK${cases}X`;
          const service = new ClaritySettingsService({
            repository: {
              getConsentState: async () => ({ dataUseNoticeVersion: acknowledged }),
              acknowledgeDataUseNotice: async () => assert.fail('gate must not write'),
              setAnalyticsConsent: async () => assert.fail('gate must not write'),
            },
          });
          const body = Object.fromEntries(buildExtras(extras, marker));

          if (!inRange(required)) {
            await assert.rejects(
              service.assertDataUseNotice({ userId: 1, requiredNoticeVersion: required }),
              RangeError
            );
            assert.throws(
              () => createDataUseNoticeGate({ requiredNoticeVersion: required, service }),
              RangeError
            );
            return;
          }

          const admitted = required <= acknowledged;
          if (admitted) {
            await service.assertDataUseNotice({ userId: 1, requiredNoticeVersion: required });
          } else {
            await assert.rejects(
              service.assertDataUseNotice({ userId: 1, requiredNoticeVersion: required }),
              (error) => error instanceof ClaritySettingsError
                && error.httpStatus === 428
                && error.code === 'DATA_NOTICE_REQUIRED'
                && error.requiredNoticeVersion === required
                && error.currentNoticeVersion === CURRENT
                && error.acknowledgedNoticeVersion === acknowledged
                && error.settingsPath === '/api/clarity/settings'
            );
          }

          let serviceCalls = 0;
          const countingService = {
            assertDataUseNotice: (input) => {
              serviceCalls += 1;
              return service.assertDataUseNotice(input);
            },
          };
          const gate = createDataUseNoticeGate({
            requiredNoticeVersion: required,
            appliesTo: () => applies,
            service: countingService,
          });
          const nextCalls = [];
          const responses = [];
          const res = {
            status(code) {
              responses.push({ code });
              return this;
            },
            json(payload) {
              responses[responses.length - 1].payload = payload;
              return this;
            },
          };
          await gate({ user: { id: 1 }, body }, res, (...args) => nextCalls.push(args));

          if (!applies) {
            assert.equal(serviceCalls, 0, 'an undeclared command must not consult the notice');
            assert.deepEqual(nextCalls, [[]]);
            assert.deepEqual(responses, []);
          } else if (admitted) {
            assert.deepEqual(nextCalls, [[]]);
            assert.deepEqual(responses, []);
          } else {
            assert.deepEqual(nextCalls, [], 'a rejected command must not continue');
            assert.equal(responses.length, 1);
            assert.equal(responses[0].code, 428);
            assert.deepEqual(Object.keys(responses[0].payload), ['error']);
            assert.deepEqual(Object.keys(responses[0].payload.error).sort(), GATE_ERROR_KEYS);
            assert.equal(JSON.stringify(responses[0].payload).includes(marker), false);
          }
        }
      ),
      { numRuns: GATE_NUM_RUNS }
    );
    assert.equal(cases, GATE_NUM_RUNS);
  }
);

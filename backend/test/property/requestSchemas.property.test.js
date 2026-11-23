import '../helpers/blockingStdout.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createIsolatedTestDatabase } from '../helpers/testDatabase.js';
import { assertProperty, MIN_PROPERTY_RUNS } from '../helpers/propertyReport.js';

/*
 * Feature: quick-add-daily-answer, Property 25: Request schemas are closed and typed
 *
 * Validates: Requirements 15.5, 15.6, 15.7, 15.8, 15.15, 18.18
 *
 * The property drives the authenticated Memory API and expense create/update routes through the real Express app.
 * It covers closed-schema extras, wrong primitive and nested types, all three prototype-like keys, bodies above the
 * Memory API's 1 KB limit, Unicode controls, invalid revisions, invalid Note_Keys and categories, and every
 * non-boolean exclusion shape. Each refusal is compared with a fixed response and with source-table snapshots from
 * immediately before and after the request. Accepted expenses are then read through mutation records, the financial
 * repository, the contract list, the raw JSON export, and storage. The no-header legacy create/list shapes remain
 * exact. One isolated database reset is used for the whole run; each case receives collision-free account, session,
 * idempotency, note, and forwarded-IP identifiers. Counterexamples are redacted by propertyReport.js.
 */

const RUNS = 100;
const FIRST_USER_ID = 8_300_000;
const FIRST_SESSION_ID = 8_400_000;
const FIXTURE_TIME = '2026-01-15T06:30:00.000Z';
const MEMORY_REQUEST_MESSAGE =
  'Memory request must contain only noteKey, category, and optional expectedRevision fields with valid types.';
const NOTE_KEY_MESSAGE = 'noteKey must be a normalized note of 1 to 60 characters.';
const BUILT_IN_CATEGORIES = Object.freeze([
  'Food',
  'Groceries',
  'Transport',
  'Shopping',
  'Entertainment',
  'Bills',
  'Health',
  'Travel',
  'Education',
  'Other',
]);
const PROTOTYPE_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);
const UNICODE_CONTROLS = Object.freeze([
  '\u200c', // zero-width non-joiner
  '\u200d', // zero-width joiner
  '\u200e', // left-to-right mark
  '\u202e', // right-to-left override
  '\u2066', // left-to-right isolate
  '\u2069', // pop directional isolate
]);
const LEGACY_LIST_KEYS = Object.freeze([
  'amount', 'category', 'created_at', 'id', 'month', 'note', 'spent_on',
]);
const CONTRACT_LIST_KEYS = Object.freeze([
  ...LEGACY_LIST_KEYS,
  'excludeFromDailyAllowance',
].sort());
const LEGACY_PATCH_EXPENSE_KEYS = Object.freeze([
  'amount', 'category', 'id', 'month', 'note', 'spent_on',
]);
const CONTRACT_RECORD_KEYS = Object.freeze([
  'amountMinor', 'category', 'excludeFromDailyAllowance', 'id', 'month', 'note', 'spentOn',
]);

let testDatabase;
let db;
let app;
let FinancialRepository;
let EXPENSE_ACCEPTED_CONSTRAINTS;
let nextCase = 0;

const coverage = {
  cases: 0,
  memoryAccepted: 0,
  memoryRejected: 0,
  expenseAccepted: 0,
  expenseRejected: 0,
  prototypeKeys: new Set(),
  controls: new Set(),
  initialMarks: new Set(),
  finalMarks: new Set(),
  legacyRows: 0,
};

const wrongPrimitiveOrNestedModeArb = fc.constantFrom(
  'null', 'zero', 'one', 'negative', 'fraction', 'boolean', 'array', 'object'
);
const invalidMemoryRevisionModeArb = fc.constantFrom(
  'null', 'zero', 'negative', 'fraction', 'string', 'boolean', 'array', 'object'
);
const invalidExpenseRevisionModeArb = fc.constantFrom(
  'negative', 'fraction', 'string', 'null', 'boolean', 'array', 'object', 'unsafe'
);
const invalidExclusionModeArb = fc.constantFrom(
  'null', 'zero', 'one', 'string-true', 'string-false', 'array', 'object',
  'nested-proto', 'nested-constructor', 'nested-prototype'
);

const caseArb = fc.record({
  suffix: fc.stringMatching(/^[a-z0-9]{1,16}$/),
  extraSuffix: fc.stringMatching(/^[a-z]{1,8}$/),
  control: fc.constantFrom(...UNICODE_CONTROLS),
  category: fc.constantFrom(...BUILT_IN_CATEGORIES),
  amountMinor: fc.integer({ min: 1, max: 5_000_000 }),
  initialMark: fc.constantFrom('omitted', 'false', 'true'),
  finalMark: fc.boolean(),
  invalidNoteKind: fc.constantFrom('empty', 'blank', 'uppercase', 'spaced', 'compatibility', 'overlong'),
  invalidCategoryKind: fc.constantFrom('unknown', 'blank', 'unicode-control'),
  wrongNoteKeyMode: wrongPrimitiveOrNestedModeArb,
  wrongCategoryMode: wrongPrimitiveOrNestedModeArb,
  invalidMemoryRevisionMode: invalidMemoryRevisionModeArb,
  invalidExpenseRevisionMode: invalidExpenseRevisionModeArb,
  invalidCreateExclusionMode: invalidExclusionModeArb,
  invalidUpdateExclusionMode: invalidExclusionModeArb,
  extraValueKind: fc.constantFrom('string', 'array', 'object'),
});

before(async () => {
  testDatabase = await createIsolatedTestDatabase();
  db = testDatabase.db;
  process.env.FINANCIAL_MUTATION_HMAC_KEY =
    'qa83-property-financial-mutation-key-32-bytes-minimum';
  process.env.QUICK_ADD_ENABLED = 'true';
  await testDatabase.reset();

  const [{ createApp }, repositoryModule, expenseModule] = await Promise.all([
    import('../../src/app.js'),
    import('../../src/repositories/financialRepository.js'),
    import('../../src/services/expenseMutations.js'),
  ]);
  app = createApp();
  FinancialRepository = repositoryModule.FinancialRepository;
  EXPENSE_ACCEPTED_CONSTRAINTS = expenseModule.EXPENSE_ACCEPTED_CONSTRAINTS;
});

after(async () => {
  await testDatabase?.cleanup();
});

function sortedKeys(value) {
  return Object.keys(value).sort();
}

function plain(value) {
  return JSON.parse(JSON.stringify(value, (_key, item) => (
    typeof item === 'bigint' ? Number(item) : item
  )));
}

function alternateCategory(category) {
  return BUILT_IN_CATEGORIES[(BUILT_IN_CATEGORIES.indexOf(category) + 1) % BUILT_IN_CATEGORIES.length];
}

function invalidShape(mode, marker) {
  switch (mode) {
    case 'null': return null;
    case 'zero': return 0;
    case 'one': return 1;
    case 'negative': return -1;
    case 'fraction': return 1.5;
    case 'string': return marker;
    case 'boolean': return true;
    case 'array': return [marker];
    case 'object': return { payload: marker };
    default: throw new RangeError(`Unknown invalid shape mode: ${mode}`);
  }
}

function invalidExpenseRevision(mode, marker) {
  if (mode === 'unsafe') return Number.MAX_SAFE_INTEGER + 1;
  return invalidShape(mode, marker);
}

function prototypeRecord(key, marker) {
  return Object.fromEntries([[key, { payload: marker }]]);
}

function invalidExclusion(mode, marker) {
  switch (mode) {
    case 'string-true': return 'true';
    case 'string-false': return 'false';
    case 'nested-proto': return prototypeRecord('__proto__', marker);
    case 'nested-constructor': return prototypeRecord('constructor', marker);
    case 'nested-prototype': return prototypeRecord('prototype', marker);
    default: return invalidShape(mode, marker);
  }
}

function invalidNoteKey(kind, suffix) {
  switch (kind) {
    case 'empty': return '';
    case 'blank': return ' \t  ';
    case 'uppercase': return `Coffee${suffix}`;
    case 'spaced': return `two  spaces ${suffix}`;
    case 'compatibility': return `\u212Aey${suffix}`;
    case 'overlong': return `${'a'.repeat(61)}${suffix}`;
    default: throw new RangeError(`Unknown invalid note kind: ${kind}`);
  }
}

function invalidCategory(kind, sequence, control) {
  switch (kind) {
    case 'blank': return '   ';
    case 'unicode-control': return `Unlisted${sequence}${control}`;
    case 'unknown': return `Unlisted${sequence}`;
    default: throw new RangeError(`Unknown invalid category kind: ${kind}`);
  }
}

function memoryError(field) {
  return {
    error: {
      code: 'INVALID_MEMORY_REQUEST',
      message: MEMORY_REQUEST_MESSAGE,
      ...(field === undefined ? {} : { field }),
    },
  };
}

function noteKeyError() {
  return {
    error: {
      code: 'INVALID_NOTE_KEY',
      message: NOTE_KEY_MESSAGE,
      field: 'noteKey',
    },
  };
}

function payloadError() {
  return {
    error: {
      code: 'PAYLOAD_TOO_LARGE',
      message: 'Memory API request bodies must be at most 1 kilobyte.',
    },
  };
}

function unknownCategoryError() {
  return {
    error: {
      code: 'UNKNOWN_EXPENSE_CATEGORY',
      message: 'Unknown category — add it in Settings first.',
      field: 'category',
      constraint: EXPENSE_ACCEPTED_CONSTRAINTS.category,
    },
  };
}

function expenseExclusionError() {
  return {
    error: {
      code: 'INVALID_EXPENSE_EXCLUSION',
      message: 'excludeFromDailyAllowance must be a boolean.',
      field: 'excludeFromDailyAllowance',
      constraint: EXPENSE_ACCEPTED_CONSTRAINTS.excludeFromDailyAllowance,
    },
  };
}

function expenseRevisionError() {
  return {
    error: {
      code: 'INVALID_EXPECTED_RECORD_VERSION',
      message: 'expectedRecordVersion must be a non-negative integer.',
      field: 'expectedRecordVersion',
      constraint: EXPENSE_ACCEPTED_CONSTRAINTS.expectedRecordVersion,
    },
  };
}

function forwardedIp(sequence) {
  return `10.${(sequence >> 16) & 255}.${(sequence >> 8) & 255}.${sequence & 255}`;
}

function idempotencyKey(sequence, slot) {
  const tail = (BigInt(sequence) * 100n + BigInt(slot)).toString(16).padStart(12, '0');
  return `83000000-0000-4000-8000-${tail}`;
}

function rawJson(value) {
  return JSON.stringify(value);
}

async function createCaller(sequence) {
  const userId = FIRST_USER_ID + sequence;
  const sessionId = FIRST_SESSION_ID + sequence;
  await db.batch([
    [
      `INSERT INTO users
        (id, email, name, password_hash, is_admin, token_version, created_at)
       VALUES (?, ?, ?, ?, 0, 1, ?)`,
      [userId, `qa83-${sequence}@example.test`, `QA83 ${sequence}`, 'not-a-real-password-hash', FIXTURE_TIME],
    ],
    [
      `INSERT INTO sessions
        (id, user_id, device_label, ip_hash, user_agent, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [sessionId, userId, 'QA83 property session', `qa83-ip-hash-${sequence}`, 'QA83Property/1.0', FIXTURE_TIME, FIXTURE_TIME],
    ],
    [
      `INSERT INTO user_financial_state
        (user_id, data_use_notice_version, data_use_acknowledged_at)
       VALUES (?, 2, ?)`,
      [userId, FIXTURE_TIME],
    ],
  ]);
  const token = jwt.sign(
    { sub: String(userId), tv: 1, sid: sessionId },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '5m' },
  );
  return {
    userId,
    authorization: `Bearer ${token}`,
    ip: forwardedIp(sequence),
  };
}

function api(caller, method, path) {
  return request(app)[method](path)
    .set('Authorization', caller.authorization)
    .set('X-Forwarded-For', caller.ip);
}

function jsonRequest(caller, method, path, value, { contract = false, key } = {}) {
  let pending = api(caller, method, path)
    .set('Content-Type', 'application/json');
  if (contract) pending = pending.set('X-Clarity-Contract', '1');
  if (key !== undefined) pending = pending.set('Idempotency-Key', key);
  return pending.send(rawJson(value));
}

async function readMemoryState(userId) {
  return plain(await db.prepare(
    `SELECT id, user_id, note_key, category, revision, created_at, updated_at
       FROM category_memory
      WHERE user_id = ?
      ORDER BY id`
  ).all(userId));
}

async function readExpenseMutationState(userId) {
  const [expenses, changes, financialState] = await Promise.all([
    db.prepare(
      `SELECT id, user_id, month, category, amount, note, spent_on,
              exclude_from_daily_allowance, created_at, updated_at
         FROM expense_log
        WHERE user_id = ?
        ORDER BY id`
    ).all(userId),
    db.prepare(
      `SELECT id, user_id, idempotency_key, operation, record_type, record_id,
              record_version, status
         FROM financial_record_changes
        WHERE user_id = ?
        ORDER BY id`
    ).all(userId),
    db.prepare(
      `SELECT user_id, data_version, data_use_notice_version, data_use_acknowledged_at
         FROM user_financial_state
        WHERE user_id = ?`
    ).get(userId),
  ]);
  return plain({ expenses, changes, financialState });
}

function assertFixedResponse(response, status, expectedBody, forbidden = []) {
  assert.equal(response.status, status);
  assert.deepEqual(response.body, expectedBody);
  const serialized = JSON.stringify(response.body);
  assert.equal(serialized.includes('stack'), false, 'an error response contains a stack field');
  for (const value of forbidden) {
    if (typeof value === 'string' && value.length > 0) {
      assert.equal(serialized.includes(value), false, 'an error response echoes request data');
    }
  }
}

async function assertRejectedWithoutChange({
  caller,
  method,
  path,
  body,
  status,
  expectedBody,
  readState,
  forbidden,
  contract = false,
  key,
}) {
  const beforeState = await readState(caller.userId);
  const response = await jsonRequest(caller, method, path, body, { contract, key });
  assertFixedResponse(response, status, expectedBody, forbidden);
  const afterState = await readState(caller.userId);
  assert.deepEqual(afterState, beforeState, 'a rejected request changed source or receipt state');
  return response;
}

async function exerciseMemoryApi(c, sequence, caller) {
  const marker = `qa83memory${sequence}${c.extraSuffix}`;
  const noteKey = `qa${sequence}-${c.control}${c.suffix}`;
  const category = c.category;
  const replacementCategory = alternateCategory(category);

  assert.equal([...noteKey].length <= 60, true);
  assert.equal(noteKey.normalize('NFKC').toLocaleLowerCase('en-IN').trim(), noteKey);

  const created = await jsonRequest(caller, 'put', '/api/finance/category-memory', {
    noteKey,
    category,
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.created, true);
  assert.equal(created.body.entry.noteKey, noteKey);
  assert.equal(created.body.entry.category, category);
  assert.equal(created.body.entry.revision, 1);

  const updated = await jsonRequest(caller, 'put', '/api/finance/category-memory', {
    noteKey,
    category: replacementCategory,
    expectedRevision: 1,
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.created, false);
  assert.equal(updated.body.entry.noteKey, noteKey);
  assert.equal(updated.body.entry.category, replacementCategory);
  assert.equal(updated.body.entry.revision, 2);
  assert.deepEqual(await readMemoryState(caller.userId), [{
    id: created.body.entry.id,
    user_id: caller.userId,
    note_key: noteKey,
    category: replacementCategory,
    revision: 2,
    created_at: created.body.entry.updatedAt,
    updated_at: updated.body.entry.updatedAt,
  }]);
  coverage.memoryAccepted += 2;
  coverage.controls.add(c.control);

  const extraKey = `xqa${sequence}${c.control}${c.extraSuffix}`;
  const extraValue = c.extraValueKind === 'string'
    ? marker
    : c.extraValueKind === 'array'
      ? [marker]
      : { payload: marker };
  const invalidCases = [
    {
      body: Object.fromEntries([
        ['noteKey', noteKey],
        ['category', category],
        [extraKey, extraValue],
      ]),
      status: 400,
      expectedBody: memoryError(),
      forbidden: [extraKey, marker],
    },
    {
      body: [{ noteKey, category }],
      status: 400,
      expectedBody: memoryError(),
    },
    {
      body: { noteKey: invalidShape(c.wrongNoteKeyMode, marker), category },
      status: 400,
      expectedBody: noteKeyError(),
      forbidden: [marker],
    },
    {
      body: { noteKey, category: invalidShape(c.wrongCategoryMode, marker) },
      status: 400,
      expectedBody: memoryError('category'),
      forbidden: [marker],
    },
    {
      body: {
        noteKey,
        category,
        expectedRevision: invalidShape(c.invalidMemoryRevisionMode, marker),
      },
      status: 400,
      expectedBody: memoryError('expectedRevision'),
      forbidden: [marker],
    },
    {
      body: { noteKey: invalidNoteKey(c.invalidNoteKind, c.suffix), category },
      status: 400,
      expectedBody: noteKeyError(),
    },
    {
      body: {
        noteKey: `unknown-${sequence}`,
        category: invalidCategory(c.invalidCategoryKind, sequence, c.control),
      },
      status: c.invalidCategoryKind === 'blank' ? 400 : 422,
      expectedBody: c.invalidCategoryKind === 'blank'
        ? memoryError('category')
        : unknownCategoryError(),
      forbidden: c.invalidCategoryKind === 'blank'
        ? []
        : [invalidCategory(c.invalidCategoryKind, sequence, c.control)],
    },
    {
      body: {
        noteKey,
        category,
        padding: `${marker}${c.control}${'x'.repeat(1_100)}`,
      },
      status: 413,
      expectedBody: payloadError(),
      forbidden: [marker],
    },
  ];

  for (const prototypeKey of PROTOTYPE_KEYS) {
    invalidCases.push({
      body: Object.fromEntries([
        ['noteKey', noteKey],
        ['category', category],
        [prototypeKey, { payload: marker }],
      ]),
      status: 400,
      expectedBody: memoryError(),
      forbidden: [prototypeKey, marker],
    });
    coverage.prototypeKeys.add(prototypeKey);
  }

  for (const invalid of invalidCases) {
    await assertRejectedWithoutChange({
      caller,
      method: 'put',
      path: '/api/finance/category-memory',
      ...invalid,
      readState: readMemoryState,
    });
    coverage.memoryRejected += 1;
  }
}

function requestBodyForExpense(c, sequence) {
  const month = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
  return {
    month,
    spentOn: `${month}-01`,
    body: {
      amountMinor: c.amountMinor,
      category: c.category,
      note: `qa83 ${sequence} ${c.control} ${c.suffix}`,
      spentOn: `${month}-01`,
      expectedRecordVersion: 0,
    },
  };
}

function expectedStoredMark(mark) {
  return mark === true ? 1 : null;
}

function assertContractRecord(record, expectedMark) {
  assert.deepEqual(sortedKeys(record), [...CONTRACT_RECORD_KEYS].sort());
  assert.equal(typeof record.excludeFromDailyAllowance, 'boolean');
  assert.equal(record.excludeFromDailyAllowance, expectedMark);
}

async function assertExpenseSurfaces(c, sequence, caller, created, legacyCreated, month) {
  const expectedById = new Map([
    [created.body.id, c.finalMark],
    [legacyCreated.body.id, false],
  ]);

  const storedRows = await db.prepare(
    `SELECT id, exclude_from_daily_allowance
       FROM expense_log
      WHERE user_id = ? AND id IN (?, ?)
      ORDER BY id`
  ).all(caller.userId, created.body.id, legacyCreated.body.id);
  assert.equal(storedRows.length, 2);
  for (const row of storedRows) {
    const id = Number(row.id);
    assert.equal(row.exclude_from_daily_allowance, expectedStoredMark(expectedById.get(id)));
  }

  const repository = new FinancialRepository(db);
  const period = await repository.loadPeriod({ userId: caller.userId, month });
  const relevantRepositoryRecords = period.expenses.records.filter(({ id }) => expectedById.has(id));
  assert.equal(relevantRepositoryRecords.length, 2);
  for (const record of relevantRepositoryRecords) {
    assert.equal(typeof record.excludeFromDailyAllowance, 'boolean');
    assert.equal(record.excludeFromDailyAllowance, expectedById.get(record.id));
  }

  const contractList = await api(caller, 'get', `/api/finance/expenses?month=${month}`)
    .set('X-Clarity-Contract', '1');
  assert.equal(contractList.status, 200);
  const relevantContractRows = contractList.body.expenses.filter(({ id }) => expectedById.has(id));
  assert.equal(relevantContractRows.length, 2);
  for (const row of relevantContractRows) {
    assert.deepEqual(sortedKeys(row), CONTRACT_LIST_KEYS);
    assert.equal(typeof row.excludeFromDailyAllowance, 'boolean');
    assert.equal(row.excludeFromDailyAllowance, expectedById.get(row.id));
    assert.equal(Object.hasOwn(row, 'exclude_from_daily_allowance'), false);
  }

  const legacyList = await api(caller, 'get', `/api/finance/expenses?month=${month}`);
  assert.equal(legacyList.status, 200);
  const relevantLegacyRows = legacyList.body.expenses.filter(({ id }) => expectedById.has(id));
  assert.equal(relevantLegacyRows.length, 2);
  for (const row of relevantLegacyRows) {
    assert.deepEqual(sortedKeys(row), [...LEGACY_LIST_KEYS]);
    assert.equal(Object.hasOwn(row, 'excludeFromDailyAllowance'), false);
    assert.equal(Object.hasOwn(row, 'exclude_from_daily_allowance'), false);
  }
  coverage.legacyRows += relevantLegacyRows.length;

  const exported = await api(caller, 'get', '/api/auth/export');
  assert.equal(exported.status, 200);
  const relevantExportRows = exported.body.data.expenses.filter(({ id }) => expectedById.has(id));
  assert.equal(relevantExportRows.length, 2);
  for (const row of relevantExportRows) {
    assert.equal(Object.hasOwn(row, 'exclude_from_daily_allowance'), true);
    assert.equal(row.exclude_from_daily_allowance, expectedStoredMark(expectedById.get(row.id)));
    assert.equal(Object.hasOwn(row, 'excludeFromDailyAllowance'), false);
  }
}

async function exerciseExpenseApi(c, sequence, caller) {
  const { month, spentOn, body } = requestBodyForExpense(c, sequence);
  const createBody = { ...body };
  if (c.initialMark === 'true') createBody.excludeFromDailyAllowance = true;
  if (c.initialMark === 'false') createBody.excludeFromDailyAllowance = false;

  const created = await jsonRequest(
    caller,
    'post',
    '/api/finance/expenses',
    createBody,
    { contract: true, key: idempotencyKey(sequence, 1) },
  );
  assert.equal(created.status, 200);
  assert.deepEqual(sortedKeys(created.body), ['clarity', 'id', 'month', 'mutation', 'schemaVersion']);
  assertContractRecord(created.body.mutation.record, c.initialMark === 'true');
  assert.equal(created.body.mutation.record.note, body.note);
  coverage.expenseAccepted += 1;
  coverage.initialMarks.add(c.initialMark);

  const updated = await jsonRequest(
    caller,
    'patch',
    `/api/finance/expenses/${created.body.id}`,
    { excludeFromDailyAllowance: c.finalMark, expectedRecordVersion: 1 },
    { contract: true, key: idempotencyKey(sequence, 2) },
  );
  assert.equal(updated.status, 200);
  assert.deepEqual(sortedKeys(updated.body.expense), [...LEGACY_PATCH_EXPENSE_KEYS].sort());
  assertContractRecord(updated.body.mutation.record, c.finalMark);
  assert.equal(updated.body.mutation.record.note, body.note);
  coverage.expenseAccepted += 1;
  coverage.finalMarks.add(c.finalMark);

  const invalidExclusionCases = [
    {
      method: 'post',
      path: '/api/finance/expenses',
      body: {
        ...body,
        excludeFromDailyAllowance: invalidExclusion(c.invalidCreateExclusionMode, `qa83exclude-create-${sequence}`),
      },
      key: idempotencyKey(sequence, 3),
      forbidden: [`qa83exclude-create-${sequence}`],
    },
    {
      method: 'patch',
      path: `/api/finance/expenses/${created.body.id}`,
      body: {
        excludeFromDailyAllowance: invalidExclusion(c.invalidUpdateExclusionMode, `qa83exclude-update-${sequence}`),
        expectedRecordVersion: 2,
      },
      key: idempotencyKey(sequence, 4),
      forbidden: [`qa83exclude-update-${sequence}`],
    },
  ];
  for (const invalid of invalidExclusionCases) {
    await assertRejectedWithoutChange({
      caller,
      ...invalid,
      status: 400,
      expectedBody: expenseExclusionError(),
      readState: readExpenseMutationState,
      contract: true,
    });
    coverage.expenseRejected += 1;
  }

  const revisionMarker = `qa83revision-${sequence}`;
  const invalidRevision = invalidExpenseRevision(c.invalidExpenseRevisionMode, revisionMarker);
  for (const [slot, invalid] of [
    [5, {
      method: 'post',
      path: '/api/finance/expenses',
      body: { ...body, excludeFromDailyAllowance: true, expectedRecordVersion: invalidRevision },
    }],
    [6, {
      method: 'patch',
      path: `/api/finance/expenses/${created.body.id}`,
      body: { excludeFromDailyAllowance: !c.finalMark, expectedRecordVersion: invalidRevision },
    }],
  ]) {
    await assertRejectedWithoutChange({
      caller,
      ...invalid,
      status: 400,
      expectedBody: expenseRevisionError(),
      readState: readExpenseMutationState,
      contract: true,
      key: idempotencyKey(sequence, slot),
      forbidden: [revisionMarker],
    });
    coverage.expenseRejected += 1;
  }

  const unavailableCategory = `Unlisted${sequence}`;
  for (const [slot, invalid] of [
    [7, {
      method: 'post',
      path: '/api/finance/expenses',
      body: { ...body, category: unavailableCategory },
    }],
    [8, {
      method: 'patch',
      path: `/api/finance/expenses/${created.body.id}`,
      body: { category: unavailableCategory, expectedRecordVersion: 2 },
    }],
  ]) {
    await assertRejectedWithoutChange({
      caller,
      ...invalid,
      status: 422,
      expectedBody: unknownCategoryError(),
      readState: readExpenseMutationState,
      contract: true,
      key: idempotencyKey(sequence, slot),
      forbidden: [unavailableCategory],
    });
    coverage.expenseRejected += 1;
  }

  const legacyCreated = await jsonRequest(caller, 'post', '/api/finance/expenses', {
    amount: c.amountMinor / 100,
    category: c.category,
    note: `legacy ${sequence} ${c.control}`,
    spentOn,
    excludeFromDailyAllowance: true,
  });
  assert.equal(legacyCreated.status, 200);
  assert.deepEqual(sortedKeys(legacyCreated.body), ['id', 'month']);
  const legacyStored = await db.prepare(
    'SELECT exclude_from_daily_allowance FROM expense_log WHERE id = ? AND user_id = ?'
  ).get(legacyCreated.body.id, caller.userId);
  assert.equal(legacyStored.exclude_from_daily_allowance, null);
  coverage.expenseAccepted += 1;

  await assertExpenseSurfaces(c, sequence, caller, created, legacyCreated, month);
}

async function runCase(c) {
  nextCase += 1;
  const sequence = nextCase;
  const caller = await createCaller(sequence);
  await exerciseMemoryApi(c, sequence, caller);
  await exerciseExpenseApi(c, sequence, caller);
  coverage.cases += 1;
  return true;
}

test('Property 25: real request schemas reject hostile shapes before writes and expose typed expense marks', { timeout: 900_000 }, async () => {
  await assertProperty(fc.asyncProperty(caseArb, runCase), { numRuns: RUNS });

  assert.ok(coverage.cases >= MIN_PROPERTY_RUNS, `only ${coverage.cases} cases ran`);
  assert.equal(coverage.memoryAccepted, coverage.cases * 2);
  assert.equal(coverage.memoryRejected, coverage.cases * 11);
  assert.equal(coverage.expenseAccepted, coverage.cases * 3);
  assert.equal(coverage.expenseRejected, coverage.cases * 6);
  assert.deepEqual([...coverage.prototypeKeys].sort(), [...PROTOTYPE_KEYS].sort());
  assert.ok(coverage.controls.size > 1, 'Unicode control generation did not vary');
  assert.deepEqual([...coverage.initialMarks].sort(), ['false', 'omitted', 'true']);
  assert.deepEqual([...coverage.finalMarks].sort(), [false, true]);
  assert.equal(coverage.legacyRows, coverage.cases * 2);
});

import '../helpers/blockingStdout.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createIsolatedTestDatabase } from '../helpers/testDatabase.js';
import { buildSessionFixture, buildUserFixture } from '../helpers/fixtures.js';
import { assertProperty } from '../helpers/propertyReport.js';
import { collectRoutes } from '../helpers/routeInventory.js';
import {
  noteArb,
  noteWordArb,
} from '../helpers/quickAddGenerators.js';

/*
 * Feature: quick-add-daily-answer, Property 26: Operational logs never contain entry values
 *
 * Validates: Requirements 14.4, 17.19
 *
 * Every case runs the real Express app (default console logger at debug level, one REQUEST_COMPLETED event per
 * request) on the isolated database, with all console methods captured. One case covers: custom-category creation,
 * expense create, same-key replay, key reuse with another body (409), validation failures (422/400, new and legacy
 * routes), update, stale-version update (409), foreign and missing record probes (404), delete (undo) and delete of
 * an already removed expense, memory PUT, stale-revision PUT (409), unknown category, closed-schema, prototype-like,
 * oversized (413) and flag-off (404) PUTs, the notice-gated 428 on expense create and memory PUT, hints, memory
 * DELETE and delete-all, and forced 500s on every write and on the hints read (SQLite triggers and a table rename
 * whose messages carry the generated values).
 *
 * Checks, per case:
 *   1. Structure. Every console line is one JSON event that passes the production allowlist unchanged (no dropped
 *      field), names a registered route pattern, and carries record IDs and user IDs only for records the case
 *      touched. Each request has exactly one REQUEST_COMPLETED event with the response's status.
 *   2. Search. No generated value (amount in paise and in rupee forms with and without grouping, note, Note_Key,
 *      category, each as sent and JSON-escaped) appears in any captured log line or in any error response body.
 *      Timestamps, request IDs, and the numeric fields the allowlist permits (status, record ID, user ID, data
 *      version, counts) are masked before the search, because a record ID may legitimately equal a generated number.
 *      A value that is a substring of the static server text (the control pass below plus the logger vocabulary)
 *      cannot be told apart from that text, so only the structural check covers it. Failure messages never print a
 *      generated value.
 *
 * A control pass with distinctive values runs first. It proves the search detects nothing in a clean run and builds
 * the static vocabulary. A self-check then proves the search does detect each value kind when it is planted.
 */

const RUNS = 100;
const FIRST_USER_ID = 950_000;
const MAX_AMOUNT_MINOR = 100_000_000_000_000;
const ALLOWED_NUMERIC_FIELDS = Object.freeze(['status', 'recordId', 'userId', 'dataVersion', 'count', 'droppedFields']);
const MASKED_FIELDS = Object.freeze(['ts', 'requestId', ...ALLOWED_NUMERIC_FIELDS]);

let testDatabase;
let db;
let app;
let kolkataDateOf;
let normalizeNoteKey;
let EXPENSE_CATEGORIES;
let EXPENSE_ACCEPTED_CONSTRAINTS;
let sanitizeLogFields;
let operationalVocabulary;
let routePatterns;
let nextCase = 0;
let ambientText = '';
let lastFailure = '';
const stats = { cases: 0, requests: 0, errorResponses: 0, logLines: 0, searchedValues: 0, ambiguousValues: 0 };
const consoleLines = [];
let restoreConsole = () => {};
let previousQuickAdd;
let previousLogLevel;

/* ------------------------------------------------------------ console capture */

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

/* ------------------------------------------------------------------ generators */

const EMOJI_WORDS = Object.freeze(['\u{1F355}', '\u2615', '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}', '\u{1F1EE}\u{1F1F3}', '\u{1F6FA}\u{1F4B8}']);
const FORMULA_WORDS = Object.freeze(['=SUM(A1:A9)', '+1+1', '-2+3', '@cmd', '=HYPERLINK("x")', '=1+1', '=cmd|\' /C calc\'!A0']);
const QUOTE_WORDS = Object.freeze(['"', '\'', '`', 'it\'s', 'say "hi"', 'a\'b"c', '\\', '\\"', '<b>x</b>', '%s', '${x}', '{{x}}', '--', '\';--']);
const CUSTOM_CATEGORY_PATTERN = /^[A-Za-z][A-Za-z0-9 &/+()-]{1,20}[A-Za-z0-9]$/;

const noteArbitrary = fc.oneof(
  { weight: 3, arbitrary: noteArb({ tricky: true, maxWords: 5 }) },
  {
    weight: 3,
    arbitrary: fc
      .array(
        fc.oneof(
          noteWordArb(),
          fc.constantFrom(...EMOJI_WORDS),
          fc.constantFrom(...FORMULA_WORDS),
          fc.constantFrom(...QUOTE_WORDS),
        ),
        { minLength: 1, maxLength: 5 },
      )
      .map((words) => words.join(' ')),
  },
).filter((note) => note.length > 0 && note.length <= 100 && note === note.trim());

const customCategoryArbitrary = fc.stringMatching(CUSTOM_CATEGORY_PATTERN).filter((name) => {
  const folded = name.toLowerCase();
  return !EXPENSE_CATEGORIES.some((category) => category.toLowerCase() === folded) && !/\s{2,}/.test(name);
});

const amountArbitrary = fc.oneof(
  { weight: 2, arbitrary: fc.integer({ min: 1, max: 99_999 }) },
  { weight: 2, arbitrary: fc.integer({ min: 1, max: 99_999_999_999 }) },
  { weight: 1, arbitrary: fc.integer({ min: 1, max: MAX_AMOUNT_MINOR }) },
  { weight: 1, arbitrary: fc.constantFrom(1, 9, 10, 99, 100, 101, 999, 100_000, 12_345_678, MAX_AMOUNT_MINOR) },
);

function scenarioArbitrary() {
  return fc
    .record({
      amountMinor: amountArbitrary,
      amount2Minor: amountArbitrary,
      amountStyle: fc.constantFrom('minor', 'decimal'),
      note: noteArbitrary,
      note2: noteArbitrary,
      customName: customCategoryArbitrary,
      unknownName: customCategoryArbitrary,
      firstKind: fc.constantFrom('builtIn', 'custom'),
      secondKind: fc.constantFrom('builtIn', 'custom'),
      builtInIndex: fc.integer({ min: 0, max: 9 }),
      secondBuiltInIndex: fc.integer({ min: 0, max: 9 }),
      excluded: fc.boolean(),
      datePick: fc.constantFrom('today', 'monthStart'),
    })
    .filter((scenario) => scenario.customName.toLowerCase() !== scenario.unknownName.toLowerCase());
}

/* ---------------------------------------------------------------- value forms */

function groupWestern(digits) {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function groupIndian(digits) {
  if (digits.length <= 3) return digits;
  return `${digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${digits.slice(-3)}`;
}

/** The paise integer and every rupee spelling a developer might log for the amount. */
function amountForms(paise) {
  const whole = String(Math.floor(paise / 100));
  const cents = paise % 100;
  const fixed = `${whole}.${String(cents).padStart(2, '0')}`;
  const forms = new Set([String(paise), fixed, String(paise / 100)]);
  if (cents === 0) forms.add(whole);
  else if (cents % 10 === 0) forms.add(`${whole}.${cents / 10}`);
  for (const grouped of [groupIndian(whole), groupWestern(whole)]) {
    forms.add(`${grouped}.${String(cents).padStart(2, '0')}`);
    if (cents === 0) forms.add(grouped);
  }
  return [...forms];
}

function rupeeString(paise) {
  return `${Math.floor(paise / 100)}.${String(paise % 100).padStart(2, '0')}`;
}

function escapedForm(text) {
  return JSON.stringify(text).slice(1, -1);
}

function sqlLiteral(text) {
  return `'${text.replaceAll('\'', '\'\'')}'`;
}

function truncateCodePoints(text, count) {
  return [...text].slice(0, count).join('');
}

/* ----------------------------------------------------------------- the search */

function isDistinctive(text, ambient) {
  return typeof text === 'string' && text.length > 0 && !ambient.includes(text);
}

/**
 * `values` is a list of `{ kind, text }`. Returns the kinds (never the texts) found in `haystack`. A value matches
 * as sent or JSON-escaped. Ambiguous values (substrings of the static vocabulary) are skipped and counted.
 */
function findValues(haystack, values, ambient, { onlyUnmaskableValues = false } = {}) {
  const found = [];
  for (const { kind, text } of values) {
    if (!isDistinctive(text, ambient)) continue;
    // Raw lines still hold timestamps and request IDs, so a hex-and-punctuation value could match them by chance.
    if (onlyUnmaskableValues && /^[0-9a-fA-F:.TZ\-]*$/.test(text)) continue;
    if (haystack.includes(text) || haystack.includes(escapedForm(text))) found.push(kind);
  }
  return found;
}

function countSearchable(values, ambient) {
  let searchable = 0;
  let ambiguous = 0;
  for (const { text } of values) {
    if (isDistinctive(text, ambient)) searchable += 1;
    else ambiguous += 1;
  }
  return { searchable, ambiguous };
}

function maskedLineText(parsed) {
  const rest = { ...parsed };
  for (const field of MASKED_FIELDS) delete rest[field];
  return JSON.stringify(rest);
}

function maskedBodyText(body) {
  const clone = body === undefined ? null : structuredClone(body);
  if (clone && typeof clone === 'object' && clone.error && typeof clone.error === 'object') {
    delete clone.error.correlationId;
  }
  return JSON.stringify(clone);
}

/* ------------------------------------------------------------ database helpers */

function tokenFor(user, session) {
  return jwt.sign(
    { sub: String(user.id), tv: user.token_version, sid: session.id },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '5m' },
  );
}

function addressFor(userId) {
  return `10.${(userId >> 16) & 255}.${(userId >> 8) & 255}.${userId & 255}`;
}

async function createActor(id, noticeVersion) {
  const user = buildUserFixture({ id, email: `qa85-log-${id}@example.test`, name: `Log Redaction ${id}` });
  const session = buildSessionFixture({ id, userId: id });
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
     VALUES (?, ?, CURRENT_TIMESTAMP)`,
  ).run(id, noticeVersion);
  return { id, authorization: `Bearer ${tokenFor(user, session)}`, address: addressFor(id) };
}

async function withDatabaseFailure({ setup, teardown }, action) {
  await db.prepare(setup).run();
  try {
    return await action();
  } finally {
    await db.prepare(teardown).run();
  }
}

/* ------------------------------------------------------------------ one case */

async function runCase(scenario, { control = false } = {}) {
  const caseNumber = nextCase;
  nextCase += 1;
  const baseId = FIRST_USER_ID + caseNumber * 3;
  const today = kolkataDateOf(new Date());
  const month = today.slice(0, 7);
  const spentOn = scenario.datePick === 'today' ? today : `${month}-01`;
  const amountMinor = scenario.amountMinor;
  const amount2Minor = scenario.amount2Minor === amountMinor
    ? (amountMinor === MAX_AMOUNT_MINOR ? amountMinor - 1 : amountMinor + 1)
    : scenario.amount2Minor;
  const firstCategory = scenario.firstKind === 'custom'
    ? scenario.customName
    : EXPENSE_CATEGORIES[scenario.builtInIndex % EXPENSE_CATEGORIES.length];
  const secondCategory = scenario.secondKind === 'custom'
    ? scenario.customName
    : EXPENSE_CATEGORIES[scenario.secondBuiltInIndex % EXPENSE_CATEGORIES.length];
  const note = scenario.note;
  const note2 = scenario.note2;
  const noteKey = normalizeNoteKey(truncateCodePoints(note, 20));
  const noteKey2 = normalizeNoteKey(truncateCodePoints(note2, 20));
  assert.ok(noteKey !== null && noteKey2 !== null, 'generated notes produce Note_Keys');

  const values = [];
  const addValue = (kind, text) => { if (typeof text === 'string' && text !== '') values.push({ kind, text }); };
  for (const [index, paise] of [amountMinor, amount2Minor].entries()) {
    for (const form of amountForms(paise)) addValue(`amount${index + 1}`, form);
  }
  for (const [index, text] of [note, note2].entries()) {
    addValue(`note${index + 1}`, text);
    addValue(`note${index + 1}-trimmed`, text.trim());
  }
  addValue('noteKey1', noteKey);
  addValue('noteKey2', noteKey2);
  for (const [kind, text] of [
    ['category-first', firstCategory],
    ['category-second', secondCategory],
    ['category-custom', scenario.customName],
    ['category-unknown', scenario.unknownName],
  ]) addValue(kind, text);
  const sentinelText = values.map(({ text }) => text).join(' | ');

  const owner = await createActor(baseId, 2);
  const stale = await createActor(baseId + 1, 1);
  const peer = await createActor(baseId + 2, 2);
  const actors = [owner, stale, peer];
  const known = new Set([999_999_999]);
  // Two probes put the note in the record-ID position of the path. A note such as "5" is then a record ID the
  // case touched, and the allowlist logs record IDs.
  if (/^[1-9]\d{0,14}$/.test(note)) known.add(Number(note));
  const codes = new Set();
  const responses = [];

  async function send(label, expected, actor, method, path, options = {}) {
    let pending = request(app)[method](path)
      .set('Authorization', actor.authorization)
      .set('X-Forwarded-For', actor.address);
    if (options.contract) pending = pending.set('X-Clarity-Contract', '1');
    if (options.contract || options.key) pending = pending.set('Idempotency-Key', options.key ?? randomUUID());
    if (options.raw !== undefined) pending = pending.set('Content-Type', 'application/json').send(options.raw);
    else if (options.body !== undefined) pending = pending.send(options.body);
    const response = await pending;
    const accepted = Array.isArray(expected) ? expected : [expected];
    const errorCode = typeof response.body?.error === 'object' ? response.body.error?.code : undefined;
    assert.ok(
      accepted.includes(response.status),
      `${label}: status ${response.status} not in [${accepted.join(',')}]${errorCode ? ` code ${errorCode}` : ''}`,
    );
    if (typeof errorCode === 'string') codes.add(errorCode);
    if (typeof response.body?.code === 'string') codes.add(response.body.code);
    responses.push({
      label,
      status: response.status,
      requestId: response.headers['x-request-id'],
      body: response.body,
    });
    return response;
  }

  const canonical = (extra = {}) => ({
    ...(scenario.amountStyle === 'decimal' ? { amount: rupeeString(amountMinor) } : { amountMinor }),
    category: firstCategory,
    note,
    spentOn,
    expectedRecordVersion: 0,
    ...(scenario.excluded ? { excludeFromDailyAllowance: true } : {}),
    ...extra,
  });

  const salaryInfo = await db.prepare(
    'INSERT INTO salary_entries (user_id, month, amount) VALUES (?, ?, ?)',
  ).run(owner.id, month, 50_000);
  assert.ok(Number(salaryInfo.changes) === 1, 'salary row is seeded');
  const peerExpense = await db.prepare(
    `INSERT INTO expense_log (user_id, month, category, amount, note, spent_on)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(peer.id, month, 'Food', 12.34, 'peer private row', today);
  const peerExpenseId = Number(peerExpense.lastInsertRowid);
  known.add(peerExpenseId);
  const peerMemory = await db.prepare(
    `INSERT INTO category_memory (user_id, note_key, category, revision, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?)`,
  ).run(peer.id, 'peer private key', 'Food', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  const peerMemoryId = Number(peerMemory.lastInsertRowid);
  known.add(peerMemoryId);

  consoleLines.length = 0;
  captureConsole();
  process.env.QUICK_ADD_ENABLED = 'true';
  try {
    /* ---- custom category, including a duplicate and an invalid name ---- */
    await send('category create', 200, owner, 'post', '/api/finance/categories', { body: { name: scenario.customName } });
    await send('category duplicate', 409, owner, 'post', '/api/finance/categories', { body: { name: scenario.customName } });
    await send('category invalid', 400, owner, 'post', '/api/finance/categories', { body: { name: `${scenario.customName} ${note}!!${'x'.repeat(30)}` } });

    /* ---- create, replay, key reuse ---- */
    const createKey = randomUUID();
    const created = await send('create', 200, owner, 'post', '/api/finance/expenses', {
      contract: true, key: createKey, body: canonical(),
    });
    const expenseId = Number(created.body.id);
    assert.ok(Number.isSafeInteger(expenseId) && expenseId > 0, 'create returned an expense ID');
    known.add(expenseId);
    await send('create replay', 200, owner, 'post', '/api/finance/expenses', {
      contract: true, key: createKey, body: canonical(),
    });
    await send('create key reuse', 409, owner, 'post', '/api/finance/expenses', {
      contract: true, key: createKey, body: canonical({ amountMinor: amount2Minor, amount: undefined, note: note2 }),
    });

    /* ---- validation failures on the new and the legacy create route ---- */
    await send('create note too long', [400, 422], owner, 'post', '/api/finance/expenses', {
      contract: true, body: canonical({ note: `${note}${'y'.repeat(130)}` }),
    });
    await send('create amount out of range', [400, 422], owner, 'post', '/api/finance/expenses', {
      contract: true, body: canonical({ amountMinor: MAX_AMOUNT_MINOR + 1, amount: undefined }),
    });
    await send('create ambiguous amount', 400, owner, 'post', '/api/finance/expenses', {
      contract: true, body: canonical({ amount: rupeeString(amount2Minor), amountMinor: amountMinor }),
    });
    await send('create unknown category', [400, 422], owner, 'post', '/api/finance/expenses', {
      contract: true, body: canonical({ category: scenario.unknownName }),
    });
    await send('create bad date', [400, 422], owner, 'post', '/api/finance/expenses', {
      contract: true, body: canonical({ spentOn: `${note}-${rupeeString(amountMinor)}` }),
    });
    await send('create bad exclusion type', 400, owner, 'post', '/api/finance/expenses', {
      contract: true, body: canonical({ excludeFromDailyAllowance: note }),
    });
    await send('legacy create note too long', 400, owner, 'post', '/api/finance/expenses', {
      body: { amount: rupeeString(amountMinor), category: firstCategory, note: `${note}${'z'.repeat(130)}`, spentOn },
    });
    await send('legacy create unknown category', 400, owner, 'post', '/api/finance/expenses', {
      body: { amount: rupeeString(amountMinor), category: scenario.unknownName, note, spentOn },
    });

    /* ---- update, stale update, foreign and missing records ---- */
    await send('update', 200, owner, 'patch', `/api/finance/expenses/${expenseId}`, {
      contract: true,
      body: {
        ...(scenario.amountStyle === 'decimal' ? { amount: rupeeString(amount2Minor) } : { amountMinor: amount2Minor }),
        category: secondCategory,
        note: note2,
        expectedRecordVersion: 1,
      },
    });
    await send('update stale version', 409, owner, 'patch', `/api/finance/expenses/${expenseId}`, {
      contract: true, body: { note, category: firstCategory, expectedRecordVersion: 0 },
    });
    await send('update invalid note', [400, 422], owner, 'patch', `/api/finance/expenses/${expenseId}`, {
      contract: true, body: { note: `${note2}${'q'.repeat(130)}`, expectedRecordVersion: 2 },
    });
    await send('update foreign', 404, owner, 'patch', `/api/finance/expenses/${peerExpenseId}`, {
      contract: true, body: { note, amountMinor, category: firstCategory, expectedRecordVersion: 0 },
    });
    await send('update missing', 404, owner, 'patch', '/api/finance/expenses/999999999', {
      contract: true, body: { note, amountMinor, category: firstCategory, expectedRecordVersion: 0 },
    });
    await send('delete foreign', 404, owner, 'delete', `/api/finance/expenses/${peerExpenseId}`, {
      contract: true, body: {},
    });
    await send('delete path with note', [400, 404], owner, 'delete', `/api/finance/expenses/${encodeURIComponent(note)}`, {
      contract: true, body: {},
    });

    /* ---- the notice-gated 428 on create ---- */
    await send('create without notice', 428, stale, 'post', '/api/finance/expenses', {
      contract: true, body: canonical(),
    });

    /* ---- memory: write, conflicts, validation, gate, flag ---- */
    const written = await send('memory put', 200, owner, 'put', '/api/finance/category-memory', {
      body: { noteKey, category: secondCategory },
    });
    const memoryId = Number(written.body.entry.id);
    const revision = Number(written.body.entry.revision);
    known.add(memoryId);
    await send('memory put replay', 200, owner, 'put', '/api/finance/category-memory', {
      body: { noteKey, category: secondCategory },
    });
    await send('memory put stale revision', 409, owner, 'put', '/api/finance/category-memory', {
      body: { noteKey, category: firstCategory, expectedRevision: revision + 5 },
    });
    await send('memory put unknown category', 422, owner, 'put', '/api/finance/category-memory', {
      body: { noteKey, category: scenario.unknownName },
    });
    await send('memory put unnormalized key', 400, owner, 'put', '/api/finance/category-memory', {
      body: { noteKey: `${noteKey} ZZ`, category: secondCategory },
    });
    await send('memory put extra fields', 400, owner, 'put', '/api/finance/category-memory', {
      body: { noteKey, category: secondCategory, note, amount: rupeeString(amountMinor), amountMinor },
    });
    await send('memory put wrong type', 400, owner, 'put', '/api/finance/category-memory', {
      body: { noteKey, category: amountMinor },
    });
    await send('memory put prototype key', 400, owner, 'put', '/api/finance/category-memory', {
      raw: `{"noteKey":${JSON.stringify(noteKey)},"category":${JSON.stringify(secondCategory)},"__proto__":{"note":${JSON.stringify(note)}}}`,
    });
    await send('memory put oversized', 413, owner, 'put', '/api/finance/category-memory', {
      body: { noteKey: `${note} `.repeat(Math.ceil(2048 / (Buffer.byteLength(note) + 1))), category: secondCategory },
    });
    await send('memory put without notice', 428, stale, 'put', '/api/finance/category-memory', {
      body: { noteKey, category: secondCategory },
    });
    process.env.QUICK_ADD_ENABLED = 'false';
    await send('memory put flag off', 404, owner, 'put', '/api/finance/category-memory', {
      body: { noteKey, category: secondCategory },
    });
    process.env.QUICK_ADD_ENABLED = 'true';

    /* ---- hints and memory deletion ---- */
    await send('hints', 200, owner, 'get', '/api/finance/quick-add/hints');
    await send('hints with values in the query', 400, owner, 'get',
      `/api/finance/quick-add/hints?note=${encodeURIComponent(note)}&amount=${rupeeString(amountMinor)}&category=${encodeURIComponent(firstCategory)}`);
    await send('memory delete stale revision', 409, owner, 'delete',
      `/api/finance/category-memory/${memoryId}?expectedRevision=${revision + 7}`);
    await send('memory delete foreign', 404, owner, 'delete', `/api/finance/category-memory/${peerMemoryId}`);
    await send('memory delete path with note', 404, owner, 'delete', `/api/finance/category-memory/${encodeURIComponent(note)}`);
    await send('memory delete', 200, owner, 'delete', `/api/finance/category-memory/${memoryId}`);
    await send('memory put again', 200, owner, 'put', '/api/finance/category-memory', {
      body: { noteKey: noteKey2, category: firstCategory },
    });
    await send('memory delete all', 200, owner, 'delete', '/api/finance/category-memory');

    /* ---- undo: delete, delete again, delete with a stale version ---- */
    await send('delete (undo)', 200, owner, 'delete', `/api/finance/expenses/${expenseId}`, { contract: true, body: {} });
    await send('delete again', 404, owner, 'delete', `/api/finance/expenses/${expenseId}`, { contract: true, body: {} });
    await send('legacy delete missing', 404, owner, 'delete', `/api/finance/expenses/${expenseId}`);
    const second = await send('create second', 200, owner, 'post', '/api/finance/expenses', {
      contract: true, body: canonical({ note: note2, amountMinor: amount2Minor, amount: undefined }),
    });
    const secondId = Number(second.body.id);
    known.add(secondId);
    await send('delete stale version', 409, owner, 'delete', `/api/finance/expenses/${secondId}`, {
      contract: true, body: { expectedRecordVersion: 9 },
    });

    /* ---- forced 500s whose database messages carry every generated value ---- */
    const message = sqlLiteral(sentinelText);
    await withDatabaseFailure({
      setup: `CREATE TRIGGER qa85_fail_insert BEFORE INSERT ON expense_log WHEN NEW.user_id = ${owner.id}
              BEGIN SELECT RAISE(ABORT, ${message}); END`,
      teardown: 'DROP TRIGGER IF EXISTS qa85_fail_insert',
    }, () => send('create forced 500', 500, owner, 'post', '/api/finance/expenses', {
      contract: true, body: canonical(),
    }));
    await withDatabaseFailure({
      setup: `CREATE TRIGGER qa85_fail_update BEFORE UPDATE ON expense_log WHEN OLD.user_id = ${owner.id}
              BEGIN SELECT RAISE(ABORT, ${message}); END`,
      teardown: 'DROP TRIGGER IF EXISTS qa85_fail_update',
    }, () => send('update forced 500', 500, owner, 'patch', `/api/finance/expenses/${secondId}`, {
      contract: true, body: { category: firstCategory, note, expectedRecordVersion: 1 },
    }));
    await withDatabaseFailure({
      setup: `CREATE TRIGGER qa85_fail_delete BEFORE DELETE ON expense_log WHEN OLD.user_id = ${owner.id}
              BEGIN SELECT RAISE(ABORT, ${message}); END`,
      teardown: 'DROP TRIGGER IF EXISTS qa85_fail_delete',
    }, () => send('delete forced 500', 500, owner, 'delete', `/api/finance/expenses/${secondId}`, {
      contract: true, body: {},
    }));
    await withDatabaseFailure({
      setup: `CREATE TRIGGER qa85_fail_memory_insert BEFORE INSERT ON category_memory WHEN NEW.user_id = ${owner.id}
              BEGIN SELECT RAISE(ABORT, ${message}); END`,
      teardown: 'DROP TRIGGER IF EXISTS qa85_fail_memory_insert',
    }, () => send('memory put forced 500', 500, owner, 'put', '/api/finance/category-memory', {
      body: { noteKey, category: secondCategory },
    }));
    await send('memory put for update trigger', 200, owner, 'put', '/api/finance/category-memory', {
      body: { noteKey, category: firstCategory },
    });
    await withDatabaseFailure({
      setup: `CREATE TRIGGER qa85_fail_memory_update BEFORE UPDATE ON category_memory WHEN OLD.user_id = ${owner.id}
              BEGIN SELECT RAISE(ABORT, ${message}); END`,
      teardown: 'DROP TRIGGER IF EXISTS qa85_fail_memory_update',
    }, () => send('memory update forced 500', 500, owner, 'put', '/api/finance/category-memory', {
      body: { noteKey, category: secondCategory },
    }));
    const remembered = await db.prepare(
      'SELECT id FROM category_memory WHERE user_id = ? ORDER BY id LIMIT 1',
    ).get(owner.id);
    const rememberedId = Number(remembered.id);
    known.add(rememberedId);
    await withDatabaseFailure({
      setup: `CREATE TRIGGER qa85_fail_memory_delete BEFORE DELETE ON category_memory WHEN OLD.user_id = ${owner.id}
              BEGIN SELECT RAISE(ABORT, ${message}); END`,
      teardown: 'DROP TRIGGER IF EXISTS qa85_fail_memory_delete',
    }, async () => {
      await send('memory delete forced 500', 500, owner, 'delete', `/api/finance/category-memory/${rememberedId}`);
      await send('memory delete all forced 500', 500, owner, 'delete', '/api/finance/category-memory');
    });
    await withDatabaseFailure({
      setup: 'ALTER TABLE category_memory RENAME TO unavailable_category_memory',
      teardown: 'ALTER TABLE unavailable_category_memory RENAME TO category_memory',
    }, () => send('hints forced 500', 500, owner, 'get', '/api/finance/quick-add/hints'));

    // The events are written when each response finishes; let the last ones land.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.env.QUICK_ADD_ENABLED = 'true';
    restoreConsole();
    await db.prepare('DELETE FROM users WHERE id IN (?, ?, ?)').run(owner.id, stale.id, peer.id);
  }

  const lines = consoleLines.splice(0);
  return analyze({
    lines, responses, values, known, codes, actors, control,
  });
}

/* ------------------------------------------------------------------- analysis */

function analyze({ lines, responses, values, known, codes, actors, control }) {
  const userIds = new Set(actors.map((actor) => actor.id));
  const parsedLines = [];
  const maskedLines = [];

  /* 1. Structure. */
  for (const [index, line] of lines.entries()) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      assert.fail(`console line ${index} is not a JSON operational event`);
    }
    assert.ok(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed), `console line ${index} is not an object`);
    const { ts, level, event, droppedFields, ...fields } = parsed;
    assert.ok(typeof ts === 'string' && !Number.isNaN(Date.parse(ts)), `line ${index} has no valid timestamp`);
    assert.ok(typeof level === 'string' && operationalVocabulary.levels.includes(level), `line ${index} has an unknown level`);
    assert.ok(operationalVocabulary.events.includes(event) && event !== 'LOG_EVENT_REJECTED', `line ${index} has an unknown or rejected event`);
    assert.equal(droppedFields, undefined, `line ${index} carries dropped fields (a caller passed a field outside the allowlist)`);
    const { record, dropped } = sanitizeLogFields(fields);
    assert.equal(dropped, 0, `line ${index} has a field outside the allowlist or failing its value check`);
    assert.equal(JSON.stringify(record), JSON.stringify(fields), `line ${index} differs from its sanitized form`);
    if (fields.route !== undefined) {
      assert.ok(fields.route === 'unmatched' || routePatterns.has(fields.route), `line ${index} names a route pattern the app does not register`);
    }
    if (fields.recordId !== undefined) {
      assert.ok(known.has(fields.recordId), `line ${index} carries a record ID this case never touched`);
      assert.ok(['expense', 'category_memory'].includes(fields.recordType), `line ${index} carries a record ID with an unexpected record type`);
    }
    if (fields.userId !== undefined) assert.ok(userIds.has(fields.userId), `line ${index} carries a user ID outside the case`);
    if (fields.code !== undefined) {
      assert.ok(
        codes.has(fields.code) || /^SQLITE_[A-Z0-9_]+$/.test(fields.code),
        `line ${index} carries a code that no response or database driver produced`,
      );
    }
    if (fields.errorName !== undefined) {
      assert.ok(/^[A-Z][A-Za-z0-9]*Error$/.test(fields.errorName), `line ${index} has an errorName that is not an error class name`);
    }
    parsedLines.push(parsed);
    maskedLines.push(maskedLineText(parsed));
  }

  // One REQUEST_COMPLETED event per request, with the response's status and request ID.
  const completed = parsedLines.filter((entry) => entry.event === 'REQUEST_COMPLETED');
  assert.equal(completed.length, responses.length, 'each request has exactly one REQUEST_COMPLETED event');
  const byRequestId = new Map(completed.map((entry) => [entry.requestId, entry]));
  assert.equal(byRequestId.size, completed.length, 'request IDs in the events are unique');
  for (const response of responses) {
    const entry = byRequestId.get(response.requestId);
    assert.ok(entry, `${response.label}: no event carries the response's X-Request-Id`);
    assert.equal(entry.status, response.status, `${response.label}: the event status differs from the response`);
  }
  // The run must have exercised the failure families, or an empty log would pass vacuously.
  const outcomes = new Set(completed.map((entry) => entry.outcome));
  for (const expected of ['success', 'client_error', 'conflict', 'notice_required', 'server_error']) {
    assert.ok(outcomes.has(expected), `no ${expected} event was logged`);
  }
  const unexpected = parsedLines.filter((entry) => entry.event === 'REQUEST_UNEXPECTED_ERROR');
  // The expense mutation service wraps a database failure in its own MUTATION_FAILED error and the route answers
  // it directly, so only the memory routes and the hints read reach the error boundary.
  const serverErrors = responses.filter((response) => response.status >= 500);
  assert.equal(serverErrors.length, 8, 'the case forced eight 5xx responses');
  for (const response of serverErrors) {
    assert.equal(byRequestId.get(response.requestId).outcome, 'server_error', `${response.label}: the 5xx was logged as a server error`);
  }
  assert.equal(unexpected.length, 5, 'the memory writes, memory deletes, and hints reached the error boundary once each');

  /* 2. Search. */
  const errorBodies = responses
    .filter((response) => response.status >= 400)
    .map((response) => ({ label: response.label, text: maskedBodyText(response.body) }));
  stats.requests += responses.length;
  stats.errorResponses += errorBodies.length;
  stats.logLines += lines.length;

  if (control) {
    // Static vocabulary: everything the server and logger say regardless of the entry values.
    ambientText = [
      JSON.stringify(operationalVocabulary),
      JSON.stringify(EXPENSE_ACCEPTED_CONSTRAINTS),
      ...maskedLines,
      ...errorBodies.map(({ text }) => text),
    ].join('\n');
  }
  const ambient = control ? '' : ambientText;
  const { searchable, ambiguous } = countSearchable(values, ambient);
  stats.searchedValues += searchable;
  stats.ambiguousValues += ambiguous;

  for (const [index, text] of maskedLines.entries()) {
    const hits = findValues(text, values, ambient);
    assert.deepEqual(hits, [], `log line ${index} (${parsedLines[index].event}) contains generated values of kinds ${hits.join(',')}`);
  }
  for (const [index, line] of lines.entries()) {
    const hits = findValues(line, values, ambient, { onlyUnmaskableValues: true });
    assert.deepEqual(hits, [], `raw log line ${index} contains generated values of kinds ${hits.join(',')}`);
  }
  for (const { label, text } of errorBodies) {
    const hits = findValues(text, values, ambient);
    assert.deepEqual(hits, [], `error response "${label}" contains generated values of kinds ${hits.join(',')}`);
  }
  return { searchable, ambiguous, masked: maskedLines, errorBodies };
}

/* ----------------------------------------------------------------- lifecycle */

before(async () => {
  testDatabase = await createIsolatedTestDatabase();
  db = testDatabase.db;
  previousQuickAdd = process.env.QUICK_ADD_ENABLED;
  previousLogLevel = process.env.OPERATIONAL_LOG_LEVEL;
  // The test environment silences the operational logger; this suite reads it.
  process.env.OPERATIONAL_LOG_LEVEL = 'debug';
  // The mutation service is built when the app module loads, so the key must exist first.
  process.env.FINANCIAL_MUTATION_HMAC_KEY = 'quick-add-log-redaction-property-hmac-key-32-bytes';
  const [
    { createApp },
    kolkata,
    noteKeyModule,
    expenseModule,
    logModule,
  ] = await Promise.all([
    import('../../src/app.js'),
    import('../../src/domain/kolkataTime.js'),
    import('../../src/domain/noteKey.js'),
    import('../../src/services/expenseMutations.js'),
    import('../../src/observability/operationalLog.js'),
  ]);
  kolkataDateOf = kolkata.kolkataDateOf;
  normalizeNoteKey = noteKeyModule.normalizeNoteKey;
  EXPENSE_CATEGORIES = expenseModule.EXPENSE_CATEGORIES;
  EXPENSE_ACCEPTED_CONSTRAINTS = expenseModule.EXPENSE_ACCEPTED_CONSTRAINTS;
  sanitizeLogFields = logModule.sanitizeLogFields;
  operationalVocabulary = {
    events: [...logModule.LOG_EVENTS],
    fields: [...logModule.ALLOWED_LOG_FIELDS],
    levels: Object.keys(logModule.LOG_LEVELS),
    durationBuckets: [...logModule.DURATION_BUCKETS],
    outcomes: [...logModule.OUTCOME_KINDS],
    recordTypes: [...logModule.RECORD_TYPES],
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
    unmatched: 'unmatched',
  };
  // Production mode logs every request. The flag is read once, when the app is built.
  const previousEnvironment = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    app = createApp();
  } finally {
    process.env.NODE_ENV = previousEnvironment;
  }
  routePatterns = new Set(collectRoutes(app._router.stack).map((route) => route.path));
  // One reset for the whole run. Each case adds users with unique IDs and removes them afterwards.
  await testDatabase.reset();
});

after(async () => {
  restoreConsole();
  if (previousQuickAdd === undefined) delete process.env.QUICK_ADD_ENABLED;
  else process.env.QUICK_ADD_ENABLED = previousQuickAdd;
  if (previousLogLevel === undefined) delete process.env.OPERATIONAL_LOG_LEVEL;
  else process.env.OPERATIONAL_LOG_LEVEL = previousLogLevel;
  await testDatabase?.cleanup();
});

/* ------------------------------------------------------------------- tests */

const CONTROL_SCENARIO = Object.freeze({
  amountMinor: 7_391_573,
  amount2Minor: 8_264_819,
  amountStyle: 'decimal',
  note: 'zqxcontrolnote Rs 7391',
  note2: 'zqxsecondnote =1+1',
  customName: 'Zqxctl Cat',
  unknownName: 'Zqxunk Cat',
  firstKind: 'custom',
  secondKind: 'builtIn',
  builtInIndex: 0,
  secondBuiltInIndex: 4,
  excluded: true,
  datePick: 'today',
});

test('the control pass logs nothing from the entry values and builds the static vocabulary', { timeout: 120_000 }, async () => {
  const result = await runCase({ ...CONTROL_SCENARIO }, { control: true });
  assert.ok(result.masked.length > 40, 'the control pass produced the request events');
  assert.ok(result.searchable >= 14, 'the control values are all searchable');
  assert.equal(result.ambiguous, 0, 'no control value is ambiguous');
});

test('the search detects every value kind when it is planted in a log line or a response body', () => {
  const values = [
    { kind: 'amount', text: '73915.73' },
    { kind: 'paise', text: '7391573' },
    { kind: 'note', text: 'say "hi" \u0C1F\u0C40' },
    { kind: 'noteKey', text: 'zqxkey' },
    { kind: 'category', text: 'Zqxcat' },
  ];
  for (const { kind, text } of values) {
    const line = JSON.stringify({ ts: '2026-01-15T06:30:00.000Z', level: 'info', event: 'REQUEST_COMPLETED', code: `X${text}` });
    assert.deepEqual(findValues(line, values, ''), [kind], `a planted ${kind} is found in a log line`);
    const body = JSON.stringify({ error: { code: 'X', message: `bad ${text}` } });
    assert.deepEqual(findValues(body, values, ''), [kind], `a planted ${kind} is found in a response body`);
  }
  assert.deepEqual(findValues('{"event":"REQUEST_COMPLETED"}', values, ''), [], 'a clean line has no hits');
  assert.deepEqual(findValues('abc 73915.73', [{ kind: 'amount', text: '73915.73' }], 'abc 73915.73'), [], 'an ambiguous value is skipped');
});

test('Property 26: Operational logs never contain entry values', { timeout: 880_000 }, async (t) => {
  try {
    await assertProperty(
      fc.asyncProperty(scenarioArbitrary(), async (scenario) => {
        try {
          await runCase(scenario);
          stats.cases += 1;
        } catch (error) {
          lastFailure = `${error?.name}: ${String(error?.message).slice(0, 400)}`;
          throw error;
        }
      }),
      { numRuns: RUNS },
    );
  } catch (error) {
    if (lastFailure) error.message = `${error.message} | last failure: ${lastFailure}`;
    throw error;
  } finally {
    t.diagnostic(
      `Property 26 stats: cases=${stats.cases} requests=${stats.requests} errorResponses=${stats.errorResponses} `
      + `logLines=${stats.logLines} searchedValues=${stats.searchedValues} ambiguousValuesSkipped=${stats.ambiguousValues}`,
    );
  }
  assert.ok(stats.cases >= RUNS, 'at least 100 cases ran');
});

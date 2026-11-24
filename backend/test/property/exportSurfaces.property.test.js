import '../helpers/blockingStdout.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createIsolatedTestDatabase } from '../helpers/testDatabase.js';
import { assertProperty, MIN_PROPERTY_RUNS } from '../helpers/propertyReport.js';
import {
  BUILT_IN_CATEGORIES,
  memoryStateArb,
  monthLedgerArb,
  noteArb,
} from '../helpers/quickAddGenerators.js';

/*
 * Feature: quick-add-daily-answer, Property 27: Exports carry the exclusion exactly
 *
 * Validates: Requirements 17.26, 18.19, 18.20
 *
 * Statement (design.md): for any set of expenses with and without the mark, the JSON export carries each expense's
 * stored value, and the CSV export holds `no` in `counted_in_daily_allowance` exactly for marked expenses and `yes`
 * otherwise, keeps the first five columns and their order, and parses back to the same marks.
 *
 * Both surfaces are driven through the real app (`createApp`) on the isolated file database. Each case seeds two
 * users with collision-free ids, so the caller's rows sit between rows of another user, and asks for
 * `GET /api/auth/export` and `GET /api/finance/export.csv` with a distinct `X-Forwarded-For` so the rate limiter
 * never trips. The database is reset once per run.
 *
 * The references below share no code with the routes: `referenceCsv` is an independent RFC 4180 writer with the
 * formula guard and its own ordering, `parseCsv` is an independent reader used to read the response back, and the
 * expected JSON rows come from the generated values, not from a database read. Counterexamples print structure and
 * length only (propertyReport.js).
 */

const RUNS = 120;
const FIRST_USER_ID = 4_100_000;
const FIRST_SESSION_ID = 5_100_000;
const PEER_NOTE = 'PEERNOTE';
const PEER_CATEGORY = 'PEERCAT';
const PEER_KEY = 'peerkey';
const CSV_HEADER = 'date,month,category,amount,note,counted_in_daily_allowance';
const GUARD_TRIGGERS = ['=', '+', '-', '@', '\t'];
const KOLKATA_OFFSET_MS = 5.5 * 3_600_000;
const MEMORY_CREATED_AT = '2025-12-31T23:00:00.000Z';

let testDatabase;
let db;
let app;
let nextCase = 0;
const coverage = {
  cases: 0,
  expenses: 0,
  marked: 0,
  unmarked: 0,
  guarded: 0,
  quoted: 0,
  multiline: 0,
  nonAscii: 0,
  memoryEntries: 0,
  peerRows: 0,
};

before(async () => {
  testDatabase = await createIsolatedTestDatabase();
  db = testDatabase.db;
  await testDatabase.reset();
  const { createApp } = await import('../../src/app.js');
  app = createApp();
});

after(async () => {
  await testDatabase?.cleanup();
});

/* -------------------------------------------------------------- reference */

/** One CSV field as an independent writer produces it: formula guard first, then quoting. */
function referenceField(value) {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (text.length > 0 && GUARD_TRIGGERS.includes(text.charAt(0))) text = `'${text}`;
  const needsQuotes = [...text].some((unit) => unit === '"' || unit === ',' || unit === '\n' || unit === '\r');
  return needsQuotes ? `"${text.split('"').join('""')}"` : text;
}

/** The value a field holds after the guard and before quoting, which `parseCsv` must return. */
function guarded(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return text.length > 0 && GUARD_TRIGGERS.includes(text.charAt(0)) ? `'${text}` : text;
}

/** Local Asia/Kolkata calendar date of a UTC instant, computed by shifting the instant by +05:30. */
function kolkataDate(utcMs) {
  return new Date(utcMs + KOLKATA_OFFSET_MS).toISOString().slice(0, 10);
}

/** The date column: the spending date, else the local day of `created_at` (stored as `YYYY-MM-DD HH:MM:SS` UTC). */
function referenceDate(record) {
  if (record.spentOn) return record.spentOn;
  if (typeof record.createdAt !== 'string') return '';
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(record.createdAt);
  return match ? kolkataDate(Date.parse(`${match[1]}T${match[2]}Z`)) : '';
}

/** Ordering key of `COALESCE(spent_on, substr(created_at, 1, 10)), id`; a missing key sorts first. */
function orderKey(record) {
  if (record.spentOn) return record.spentOn;
  return typeof record.createdAt === 'string' ? record.createdAt.slice(0, 10) : '';
}

function referenceRows(records) {
  return records
    .map((record, index) => ({ record, index }))
    .sort((a, b) => {
      const ka = orderKey(a.record);
      const kb = orderKey(b.record);
      if (ka !== kb) return ka < kb ? -1 : 1;
      return a.index - b.index;
    })
    .map(({ record }) => record);
}

function referenceCsv(records) {
  const lines = [CSV_HEADER];
  for (const record of referenceRows(records)) {
    lines.push([
      referenceDate(record),
      record.month,
      record.category,
      record.amount,
      record.note,
      record.storedMark === 1 ? 'no' : 'yes',
    ].map(referenceField).join(','));
  }
  return `${lines.join('\n')}\n`;
}

/** Independent RFC 4180 reader: records end at an unquoted newline, quotes double inside quoted fields. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const unit = text[i];
    if (quoted) {
      if (unit === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (unit === '"') {
        quoted = false;
      } else {
        field += unit;
      }
    } else if (unit === '"' && field === '') {
      quoted = true;
    } else if (unit === ',') {
      row.push(field);
      field = '';
    } else if (unit === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += unit;
    }
  }
  assert.equal(quoted, false, 'the CSV ends inside a quoted field');
  assert.equal(field === '' && row.length === 0, true, 'the CSV ends with a newline');
  return rows;
}

/* ------------------------------------------------------------- generators */

const NOTE_PREFIXES = Object.freeze([
  '', '', '', '=', '+', '-', '@', '\t', ' ', "'", '"', ',', '=1+1', '-5', '@SUM(A1)', '\r', '\n',
]);
const NOTE_SUFFIXES = Object.freeze([
  '', '', '', ',', '"', '\n', '\r\n', '\r', ' ', '\u{1f600}', '\u200d', '\u00e9', 'e\u0301', '\u0c15\u0c3e', '\u091a\u093e\u092f',
]);
const TRICKY_CATEGORIES = Object.freeze([
  '=SUM(A1)', 'a,b', 'say "hi"', 'Caf\u00e9', '\u091a\u093e\u092f', '+Food', '\u0c15\u0c3e\u092b\u0940 line\nbreak',
]);

const noteValueArb = fc.oneof(
  { weight: 1, arbitrary: fc.constant(null) },
  {
    weight: 5,
    arbitrary: fc
      .tuple(fc.constantFrom(...NOTE_PREFIXES), noteArb({ tricky: true }), fc.constantFrom(...NOTE_SUFFIXES))
      .map(([prefix, note, suffix]) => `${prefix}${note}${suffix}`),
  },
);
const categoryArb = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom(...BUILT_IN_CATEGORIES) },
  { weight: 2, arbitrary: fc.constantFrom(...TRICKY_CATEGORIES) },
);
const recordExtrasArb = fc.record({
  note: noteValueArb,
  category: categoryArb,
  unmarkedKind: fc.constantFrom('null', 'zero'),
  markedKind: fc.constantFrom('one', 'true'),
});

const caseArb = fc.record({
  ledger: monthLedgerArb({ marks: 'mixed', maxExpenses: 12 }),
  peerLedger: monthLedgerArb({ marks: 'mixed', maxExpenses: 6 }),
  extras: fc.array(recordExtrasArb, { minLength: 12, maxLength: 12 }),
  peerExtras: fc.array(recordExtrasArb, { minLength: 6, maxLength: 6 }),
  memory: memoryStateArb().map((state) => state.slice(0, 30)),
  peerMemory: memoryStateArb().map((state) => state.slice(0, 12)),
});

/* ----------------------------------------------------------------- seeding */

/** SQLite `CURRENT_TIMESTAMP` form of an ISO instant; other values (unparseable text, null) are stored as given. */
function storedCreatedAt(createdAt) {
  return typeof createdAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(createdAt)
    ? `${createdAt.slice(0, 10)} ${createdAt.slice(11, 19)}`
    : createdAt;
}

/** Expected stored values of one generated expense, and the value the database receives for its mark. */
function buildRecords(ledger, extras, { peer = false } = {}) {
  return ledger.expenses.map((expense, index) => {
    const extra = extras[index];
    const marked = expense.excludeFromDailyAllowance === true;
    const bound = marked ? (extra.markedKind === 'true' ? true : 1) : (extra.unmarkedKind === 'zero' ? 0 : null);
    return {
      month: ledger.month,
      category: peer ? `${PEER_CATEGORY} ${extra.category}` : extra.category,
      amount: expense.amountMinor / 100,
      note: peer ? `${PEER_NOTE} ${extra.note ?? ''}` : extra.note,
      spentOn: expense.spentOn,
      createdAt: storedCreatedAt(expense.createdAt),
      bound,
      storedMark: marked ? 1 : bound,
    };
  });
}

function insertExpense(userId, record) {
  return [
    `INSERT INTO expense_log
       (user_id, month, category, amount, note, spent_on, created_at, exclude_from_daily_allowance)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, record.month, record.category, record.amount, record.note, record.spentOn, record.createdAt, record.bound],
  ];
}

function insertMemory(userId, entry, { peer = false } = {}) {
  return [
    `INSERT INTO category_memory (user_id, note_key, category, revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      userId,
      peer ? `${PEER_KEY} ${entry.noteKey}` : entry.noteKey,
      peer ? `${PEER_CATEGORY} ${entry.category}` : entry.category,
      entry.revision,
      entry.revision > 1 ? MEMORY_CREATED_AT : entry.updatedAt,
      entry.updatedAt,
    ],
  ];
}

/** Seeds the caller and one other user. Their expense and memory rows are interleaved in one batch. */
async function seedCase(generated) {
  const n = nextCase;
  nextCase += 1;
  const callerId = FIRST_USER_ID + 2 * n;
  const peerId = callerId + 1;
  const sessionId = FIRST_SESSION_ID + n;
  const caller = buildRecords(generated.ledger, generated.extras);
  const peer = buildRecords(generated.peerLedger, generated.peerExtras, { peer: true });

  const statements = [
    ['INSERT INTO users (id, email, name, password_hash, is_admin, token_version) VALUES (?, ?, ?, ?, 0, 1)', [callerId, `export-prop-${callerId}@example.test`, 'Export caller', 'not-a-real-hash']],
    ['INSERT INTO users (id, email, name, password_hash, is_admin, token_version) VALUES (?, ?, ?, ?, 0, 1)', [peerId, `export-prop-${peerId}@example.test`, 'Export peer', 'not-a-real-hash']],
    ['INSERT INTO sessions (id, user_id, device_label, ip_hash, user_agent) VALUES (?, ?, ?, ?, ?)', [sessionId, callerId, 'Property device', `export-prop-hash-${sessionId}`, 'ExportProperty/1.0']],
  ];
  const interleave = (a, b) => {
    const merged = [];
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      if (i < a.length) merged.push(a[i]);
      if (i < b.length) merged.push(b[i]);
    }
    return merged;
  };
  statements.push(...interleave(
    caller.map((record) => insertExpense(callerId, record)),
    peer.map((record) => insertExpense(peerId, record)),
  ));
  statements.push(...interleave(
    generated.memory.map((entry) => insertMemory(callerId, entry)),
    generated.peerMemory.map((entry) => insertMemory(peerId, entry, { peer: true })),
  ));
  await db.batch(statements);

  // Row IDs come from the database, in insertion order, so each record knows its stored ID.
  const callerIds = await db.prepare('SELECT id FROM expense_log WHERE user_id = ? ORDER BY id').all(callerId);
  assert.equal(callerIds.length, caller.length);
  caller.forEach((record, index) => { record.id = Number(callerIds[index].id); });
  const memoryRows = await db.prepare('SELECT id, note_key FROM category_memory WHERE user_id = ?').all(callerId);
  const memoryIdByKey = new Map(memoryRows.map((row) => [row.note_key, Number(row.id)]));
  const memory = generated.memory.map((entry) => ({
    id: memoryIdByKey.get(entry.noteKey),
    note_key: entry.noteKey,
    category: entry.category,
    revision: entry.revision,
    created_at: entry.revision > 1 ? MEMORY_CREATED_AT : entry.updatedAt,
    updated_at: entry.updatedAt,
  }));

  const token = jwt.sign(
    { sub: String(callerId), tv: 1, sid: sessionId },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '5m' },
  );
  return {
    callerId,
    caller,
    peerCount: peer.length + generated.peerMemory.length,
    memory,
    authorization: `Bearer ${token}`,
    forwardedFor: `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`,
  };
}

/* --------------------------------------------------------------- property */

function expectedJsonExpense(userId, record) {
  return {
    id: record.id,
    user_id: userId,
    month: record.month,
    category: record.category,
    amount: record.amount,
    note: record.note,
    spent_on: record.spentOn,
    created_at: record.createdAt,
    exclude_from_daily_allowance: record.storedMark,
  };
}

function pickExpense(row) {
  return {
    id: Number(row.id),
    user_id: Number(row.user_id),
    month: row.month,
    category: row.category,
    amount: row.amount,
    note: row.note,
    spent_on: row.spent_on,
    created_at: row.created_at,
    exclude_from_daily_allowance: row.exclude_from_daily_allowance,
  };
}

function assertJsonExport(response, seeded) {
  assert.equal(response.status, 200);
  const { schema, data, user } = response.body;
  assert.equal(user.id, seeded.callerId);

  // Descriptions: the memory collection is described, and the expense description names the exclusion.
  assert.equal(typeof schema.tables.category_memory, 'string');
  assert.ok(schema.tables.category_memory.length > 10);
  assert.match(schema.tables.expenses, /counted in the daily allowance/);

  // Expenses: exactly the caller's rows with their stored marks, and nothing of the other user.
  const byId = (a, b) => a.id - b.id;
  const exportedExpenses = data.expenses.map(pickExpense).sort(byId);
  const expectedExpenses = seeded.caller.map((record) => expectedJsonExpense(seeded.callerId, record)).sort(byId);
  assert.deepEqual(exportedExpenses, expectedExpenses);

  // Memory: exactly the caller's rows with explicit columns.
  assert.deepEqual(data.category_memory.map(Object.keys).map((keys) => keys.sort()), data.category_memory.map(() => (
    ['category', 'created_at', 'id', 'note_key', 'revision', 'updated_at']
  )));
  const exportedMemory = data.category_memory
    .map((row) => ({ ...row, id: Number(row.id), revision: Number(row.revision) }))
    .sort(byId);
  assert.deepEqual(exportedMemory, [...seeded.memory].sort(byId));

  const body = JSON.stringify(response.body);
  for (const marker of [PEER_NOTE, PEER_CATEGORY, PEER_KEY]) {
    assert.equal(body.includes(marker), false, 'another user\'s data appears in the JSON export');
  }
}

function assertCsvExport(response, seeded) {
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /^text\/csv/);
  const expectedText = referenceCsv(seeded.caller);
  assert.equal(response.text, expectedText);
  assert.equal(response.text.includes(PEER_NOTE), false, 'another user\'s data appears in the CSV export');

  // Read the response back: shape, the last column against the stored mark, the first five against the stored data.
  const rows = parseCsv(response.text);
  assert.deepEqual(rows[0], CSV_HEADER.split(','));
  const expectedRows = referenceRows(seeded.caller);
  assert.equal(rows.length, expectedRows.length + 1);
  expectedRows.forEach((record, index) => {
    const row = rows[index + 1];
    assert.equal(row.length, 6);
    assert.deepEqual(row.slice(0, 5), [
      referenceDate(record),
      record.month,
      record.category,
      String(record.amount),
      record.note ?? '',
    ].map(guarded));
    assert.equal(row[5], record.storedMark === 1 ? 'no' : 'yes');
  });
}

function recordCoverage(seeded, memoryCount, peerRows) {
  coverage.cases += 1;
  coverage.memoryEntries += memoryCount;
  coverage.peerRows += peerRows;
  for (const record of seeded.caller) {
    coverage.expenses += 1;
    if (record.storedMark === 1) coverage.marked += 1; else coverage.unmarked += 1;
    const note = record.note ?? '';
    const texts = [record.category, note];
    if (texts.some((text) => text.length > 0 && GUARD_TRIGGERS.includes(text.charAt(0)))) coverage.guarded += 1;
    if (texts.some((text) => /[",]/.test(text))) coverage.quoted += 1;
    if (texts.some((text) => /[\n\r]/.test(text))) coverage.multiline += 1;
    if (texts.some((text) => /[^\x00-\x7f]/.test(text))) coverage.nonAscii += 1;
  }
}

test('the JSON and CSV exports carry each expense mark exactly and only the caller\'s rows', async () => {
  await assertProperty(fc.asyncProperty(caseArb, async (generated) => {
    const seeded = await seedCase(generated);

    const jsonResponse = await request(app)
      .get('/api/auth/export')
      .set('Authorization', seeded.authorization)
      .set('X-Forwarded-For', `${seeded.forwardedFor}`);
    assertJsonExport(jsonResponse, seeded);

    const csvResponse = await request(app)
      .get('/api/finance/export.csv')
      .set('Authorization', seeded.authorization)
      .set('X-Forwarded-For', `${seeded.forwardedFor}`);
    assertCsvExport(csvResponse, seeded);

    recordCoverage(seeded, generated.memory.length, seeded.peerCount);
    return true;
  }), { numRuns: RUNS });

  // The generators must have reached the interesting inputs, or the property would pass vacuously.
  assert.ok(coverage.cases >= MIN_PROPERTY_RUNS, `only ${coverage.cases} cases ran`);
  for (const key of ['expenses', 'marked', 'unmarked', 'guarded', 'quoted', 'multiline', 'nonAscii', 'memoryEntries', 'peerRows']) {
    assert.ok(coverage[key] > 0, `no generated case covered ${key}`);
  }
});

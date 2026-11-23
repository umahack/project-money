import '../helpers/blockingStdout.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { createIsolatedTestDatabase } from '../helpers/testDatabase.js';
import { assertProperty } from '../helpers/propertyReport.js';
import { addDays } from '../helpers/kolkataReference.js';
import {
  BUILT_IN_CATEGORIES,
  MEMORY_CAPACITY,
  memoryCommandsArb,
  memoryStateArb,
  referenceNoteKey,
  validDateArb,
} from '../helpers/quickAddGenerators.js';

/*
 * Feature: quick-add-daily-answer, Property 10: Category memory keeps one entry per key, at most 500, per User
 *
 * Validates: Requirements 6.5, 6.6, 6.7, 6.9, 6.13, 15.3, 16.10, 17.10
 *
 * Statement (design.md): for any sequence of upserts, deletions, delete-alls, and custom-category deletions by any set
 * of Users, each User has at most one entry per Note_Key and at most 500 entries; an upsert past the limit removes
 * the least recently updated entry; deleting a custom category removes every entry of that User that maps to it;
 * replaying an upsert leaves the same state; an upsert with a stale `expectedRevision` changes nothing; and an
 * operation by one User never changes what another User reads.
 *
 * The service runs on the isolated file database. `MemoryModel` below is an independent map-and-recency model of one
 * User's memory: it shares no code with the service and writes its own eviction order, `(updated_at, id)` newest
 * first with the key just written ranked first. Every User of every case gets a fresh, collision-free user id, the
 * database is reset once per run, and the service clock is injected. Counterexamples print structure and length
 * only (propertyReport.js). Set PM_PROPERTY_TRACE=1 to print the failing assertion message while debugging.
 */

const RUNS = 120;
const SEQUENCE_RUNS = 120;
const FIRST_USER_ID = 880_000;
const MISSING_ID = 2_000_000_000;
const CLOCK_BASE_MS = Date.UTC(2026, 0, 1, 0, 20, 0);
const ENTRY_CATEGORIES = Object.freeze(['Food', 'Groceries', 'Transport', 'Pets']);
const ZERO_ENTRY_ERROR = Object.freeze({ code: 'MEMORY_NOT_FOUND', httpStatus: 404 });

let testDatabase;
let db;
let CategoryMemoryService;
let CategoryMemoryError;
let service;
let clock = CLOCK_BASE_MS;
let nextUserId = FIRST_USER_ID;
let nextExpenseId = 1;
let highestId = 0;

before(async () => {
  testDatabase = await createIsolatedTestDatabase();
  db = testDatabase.db;
  await testDatabase.reset();
  ({ CategoryMemoryService, CategoryMemoryError } = await import('../../src/services/categoryMemory.js'));
  service = new CategoryMemoryService({ database: db, now: () => new Date(clock) });
});

after(async () => {
  await testDatabase?.cleanup();
});

/* -------------------------------------------------------------- reference */

const foldCase = (text) => text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
const sameCategory = (a, b) => foldCase(a) === foldCase(b);
const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Case variant of a category by position: as given, upper case, or lower case with padding (the service trims). */
function categoryVariant(category, position) {
  switch (position % 3) {
    case 1: return category.toUpperCase();
    case 2: return `  ${category.toLowerCase()} `;
    default: return category;
  }
}

/** One User's memory: key -> { id, noteKey, category, revision, updatedAt }. Independent of the service. */
class MemoryModel {
  entries = new Map();

  /** Newest first by (updatedAt, id), at most 500, as `list` returns. */
  list() {
    return [...this.entries.values()]
      .sort((a, b) => compareText(b.updatedAt, a.updatedAt) || b.id - a.id)
      .slice(0, MEMORY_CAPACITY)
      .map((entry) => ({ ...entry }));
  }

  /** Predicts an upsert. `id` is the row ID the database issued, only read when the key is new. */
  upsert({ noteKey, category, expectedRevision }, nowIso) {
    const current = this.entries.get(noteKey);
    if (expectedRevision !== undefined && (!current || current.revision !== expectedRevision)) {
      return { error: { code: 'MEMORY_REVISION_CONFLICT', httpStatus: 409 } };
    }
    const chosen = category.trim();
    let created = false;
    let entry = current;
    if (!current) {
      created = true;
      entry = { id: null, noteKey, category: chosen, revision: 1, updatedAt: nowIso };
      this.entries.set(noteKey, entry);
    } else if (!sameCategory(current.category, chosen)) {
      entry.category = chosen;
      entry.revision += 1;
      entry.updatedAt = nowIso;
    }
    return { entry, created, evicted: this.evict(noteKey) };
  }

  /** Keeps the newest 500 by (updatedAt, id); the key just written ranks first. */
  evict(writtenKey) {
    if (this.entries.size <= MEMORY_CAPACITY) return false;
    const ranked = [...this.entries.values()].sort(
      (a, b) =>
        Number(b.noteKey === writtenKey) - Number(a.noteKey === writtenKey)
        || compareText(b.updatedAt, a.updatedAt)
        || b.id - a.id,
    );
    for (const entry of ranked.slice(MEMORY_CAPACITY)) this.entries.delete(entry.noteKey);
    return true;
  }

  byId(id) {
    return [...this.entries.values()].find((entry) => entry.id === id);
  }

  removeAll() {
    const removed = this.entries.size;
    this.entries.clear();
    return removed;
  }

  removeForCategory(category) {
    let removed = 0;
    for (const entry of [...this.entries.values()]) {
      if (sameCategory(entry.category, category.trim())) {
        this.entries.delete(entry.noteKey);
        removed += 1;
      }
    }
    return removed;
  }
}

/* ---------------------------------------------------------------- harness */

function trace(error) {
  if (process.env.PM_PROPERTY_TRACE === '1') console.error(`PM_PROPERTY_TRACE: ${error?.stack ?? error}`);
}

/** Runs `body`; with PM_PROPERTY_TRACE=1 prints the assertion message that propertyReport.js hides. */
async function traced(body) {
  try {
    return await body();
  } catch (error) {
    trace(error);
    throw error;
  }
}

async function createUsers(count) {
  const ids = [];
  for (let index = 0; index < count; index += 1) {
    const id = nextUserId;
    nextUserId += 1;
    await db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)')
      .run(id, `memory-property-${id}@example.test`, `User ${id}`, 'test-password-hash');
    ids.push(id);
  }
  return ids;
}

async function dropUsers(ids) {
  for (const id of ids) {
    await db.prepare('DELETE FROM category_memory WHERE user_id = ?').run(id);
    await db.prepare('DELETE FROM expense_log WHERE user_id = ?').run(id);
    await db.prepare('DELETE FROM users WHERE id = ?').run(id);
  }
}

async function withUsers(count, body) {
  const ids = await createUsers(count);
  try {
    return await traced(() => body(ids));
  } finally {
    await dropUsers(ids);
  }
}

/** Inserts a generated state in array order and returns the model with the row IDs the database issued. */
async function seedMemory(userId, state) {
  const model = new MemoryModel();
  if (state.length === 0) return model;
  await db.batch(state.map((entry) => ({
    sql: `INSERT INTO category_memory (user_id, note_key, category, revision, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [userId, entry.noteKey, entry.category, entry.revision, entry.updatedAt, entry.updatedAt],
  })));
  const rows = await db.prepare('SELECT id, note_key FROM category_memory WHERE user_id = ?').all(userId);
  const idByKey = new Map(rows.map((row) => [row.note_key, Number(row.id)]));
  let previousId = 0;
  for (const entry of state) {
    const id = idByKey.get(entry.noteKey);
    assert.ok(Number.isSafeInteger(id) && id > previousId, 'seeded rows get increasing IDs');
    previousId = id;
    model.entries.set(entry.noteKey, { ...entry, id });
  }
  highestId = Math.max(highestId, previousId);
  return model;
}

async function outcome(promise) {
  try {
    return { value: await promise };
  } catch (error) {
    return { error };
  }
}

function assertErrorIs(result, expected, label) {
  assert.ok(result.error, `${label}: expected an error`);
  assert.ok(result.error instanceof CategoryMemoryError, `${label}: a CategoryMemoryError`);
  assert.equal(result.error.code, expected.code, `${label}: code`);
  assert.equal(result.error.httpStatus, expected.httpStatus, `${label}: status`);
}

/** Calls `upsert` and compares with the model's prediction, then updates the model with the issued row ID. */
async function checkedUpsert(userId, model, request, label) {
  const nowIso = new Date(clock).toISOString();
  const expected = model.upsert(request, nowIso);
  const actual = await outcome(service.upsert(userId, request));
  if (expected.error) {
    assertErrorIs(actual, expected.error, label);
    return expected;
  }
  assert.ok(!actual.error, `${label}: upsert succeeds`);
  const { entry, created, evicted } = actual.value;
  if (expected.created) {
    assert.ok(entry.id > highestId, `${label}: a new row gets an ID above every ID issued before`);
    highestId = entry.id;
    expected.entry.id = entry.id;
  }
  assert.equal(created, expected.created, `${label}: created`);
  assert.equal(evicted, expected.evicted, `${label}: evicted`);
  assert.deepEqual({ ...entry }, { ...expected.entry }, `${label}: entry`);
  return expected;
}

async function assertUserState(userId, model, label) {
  const actual = (await service.list(userId)).map((entry) => ({ ...entry }));
  assert.deepEqual(actual, model.list(), `${label}: list`);
  const row = await db.prepare('SELECT COUNT(*) AS n FROM category_memory WHERE user_id = ?').get(userId);
  assert.equal(Number(row.n), model.entries.size, `${label}: stored row count`);
  assert.ok(model.entries.size <= MEMORY_CAPACITY, `${label}: at most 500 entries`);
}

async function assertNoDuplicateKeys(userIds, label) {
  const marks = userIds.map(() => '?').join(', ');
  const duplicates = await db.prepare(
    `SELECT user_id, note_key, COUNT(*) AS n FROM category_memory
      WHERE user_id IN (${marks}) GROUP BY user_id, note_key HAVING COUNT(*) > 1`,
  ).all(...userIds);
  assert.equal(duplicates.length, 0, `${label}: one entry per key per User`);
  const oversized = await db.prepare(
    `SELECT user_id FROM category_memory WHERE user_id IN (${marks}) GROUP BY user_id HAVING COUNT(*) > ${MEMORY_CAPACITY}`,
  ).all(...userIds);
  assert.equal(oversized.length, 0, `${label}: at most 500 entries per User`);
}

/* -------------------------------------------------------------- generators */

const CLOCK_DELTAS_MS = Object.freeze([-3_600_000, -1000, 0, 0, 1000, 1000, 60_000, 86_400_000]);

/** Three Users: a full-size state, a small one, and an empty one. */
const initialStatesArb = fc.tuple(
  memoryStateArb({ maxEntries: MEMORY_CAPACITY }),
  memoryStateArb({ maxEntries: MEMORY_CAPACITY }).map((state) => state.slice(0, 25)),
  fc.constant([]),
);

const sequenceArb = fc.record({
  states: initialStatesArb,
  commands: memoryCommandsArb({ users: 3, keys: 10, categories: ENTRY_CATEGORIES.length, maxCommands: 40 }),
  deltas: fc.array(fc.constantFrom(...CLOCK_DELTAS_MS), { minLength: 1, maxLength: 16 }),
});

/** Keys 0 to 5 are fresh; 6 to 9 name seeded entries of the User when it has any. */
function noteKeyFor(seedKeys, noteIndex) {
  if (noteIndex >= 6 && seedKeys.length > 0) {
    return seedKeys[Math.floor(((noteIndex - 6) * seedKeys.length) / 4) % seedKeys.length];
  }
  return `fresh ${noteIndex}`;
}

/* ----------------------------------------------- Property 10: sequences */

test('Property 10: sequences of upserts, deletions, delete-alls, category deletions, stale revisions, and replays match the model', async () => {
  await assertProperty(
    fc.asyncProperty(sequenceArb, ({ states, commands, deltas }) => withUsers(3, async (userIds) => {
      clock = CLOCK_BASE_MS;
      const models = [];
      for (let user = 0; user < 3; user += 1) models.push(await seedMemory(userIds[user], states[user]));
      const seedKeys = states.map((state) => state.map((entry) => entry.noteKey));
      const sent = [[], [], []];

      for (let step = 0; step < commands.length; step += 1) {
        const command = commands[step];
        const label = `step ${step} ${command.kind}`;
        clock += deltas[step % deltas.length];
        const user = command.user;
        const userId = userIds[user];
        const model = models[user];

        if (command.kind === 'upsert' || command.kind === 'replay') {
          let request;
          if (command.kind === 'upsert') {
            const noteKey = noteKeyFor(seedKeys[user], command.noteIndex);
            const current = model.entries.get(noteKey);
            let expectedRevision;
            if (command.stale) {
              expectedRevision = current ? (current.revision > 1 && step % 2 === 1 ? current.revision - 1 : current.revision + 1) : 1;
            } else if (current && step % 2 === 0) {
              expectedRevision = current.revision;
            }
            request = {
              noteKey,
              category: categoryVariant(ENTRY_CATEGORIES[command.categoryIndex], step),
              expectedRevision,
            };
          } else {
            request = sent[user][sent[user].length - command.back];
            if (!request) continue;
          }
          sent[user].push(request);
          await checkedUpsert(userId, model, request, label);
        } else if (command.kind === 'remove') {
          const noteKey = noteKeyFor(seedKeys[user], command.noteIndex);
          const current = model.entries.get(noteKey);
          if (current) {
            const expectedRevision = command.stale ? current.revision + 1 : step % 2 === 0 ? current.revision : undefined;
            const result = await outcome(service.remove(userId, current.id, { expectedRevision }));
            if (command.stale) {
              assertErrorIs(result, { code: 'MEMORY_REVISION_CONFLICT', httpStatus: 409 }, label);
            } else {
              assert.ok(!result.error, `${label}: delete succeeds`);
              model.entries.delete(noteKey);
            }
          } else {
            const foreign = models.find((other, index) => index !== user && other.entries.has(noteKey));
            const id = foreign ? foreign.entries.get(noteKey).id : MISSING_ID;
            const result = await outcome(service.remove(userId, id, { expectedRevision: step % 2 === 0 ? 1 : undefined }));
            assertErrorIs(result, ZERO_ENTRY_ERROR, `${label} foreign or missing`);
          }
        } else if (command.kind === 'removeAll') {
          assert.equal(await service.removeAll(userId), model.removeAll(), `${label}: count`);
        } else {
          const category = categoryVariant(ENTRY_CATEGORIES[command.categoryIndex], step);
          assert.equal(await service.removeForCategory(userId, category), model.removeForCategory(category), `${label}: count`);
        }

        await assertUserState(userId, model, label);
        const total = models.reduce((sum, each) => sum + each.entries.size, 0);
        if (total <= 60) {
          for (let other = 0; other < 3; other += 1) await assertUserState(userIds[other], models[other], `${label}: User ${other}`);
        }
      }

      for (let other = 0; other < 3; other += 1) await assertUserState(userIds[other], models[other], `end: User ${other}`);
      await assertNoDuplicateKeys(userIds, 'end');
    })),
    { numRuns: SEQUENCE_RUNS },
  );
});

/* -------------------------------------------- Property 10: the 500 limit */

const clockPositionArb = fc.constantFrom('beforeAll', 'inside', 'equalToNewest', 'afterAll');

function clockAt(position, state) {
  const stamps = state.map((entry) => Date.parse(entry.updatedAt));
  const newest = stamps.length ? Math.max(...stamps) : CLOCK_BASE_MS;
  const oldest = stamps.length ? Math.min(...stamps) : CLOCK_BASE_MS;
  switch (position) {
    case 'beforeAll': return oldest - 3_600_000;
    case 'inside': return Math.floor((oldest + newest) / 2);
    case 'equalToNewest': return newest;
    default: return newest + 86_400_000;
  }
}

test('Property 10: an upsert past 500 entries removes the least recently updated by (updated_at, id) and keeps the key just written', async () => {
  await assertProperty(
    fc.asyncProperty(
      memoryStateArb({ maxEntries: MEMORY_CAPACITY + 1 }),
      clockPositionArb,
      fc.constantFrom('new', 'existingSame', 'existingChanged'),
      fc.nat({ max: 600 }),
      fc.constantFrom(...ENTRY_CATEGORIES),
      (state, position, mode, pick, category) => withUsers(2, async ([userId, otherId]) => {
        const model = await seedMemory(userId, state);
        const otherModel = await seedMemory(otherId, state.slice(0, 5).map((entry) => ({ ...entry, noteKey: `other ${entry.noteKey}` })));
        clock = clockAt(position, state);
        let noteKey = `brand new ${pick}`;
        let chosen = category;
        if (mode !== 'new' && state.length > 0) {
          const existing = state[pick % state.length];
          noteKey = existing.noteKey;
          chosen = mode === 'existingSame' ? existing.category : `${existing.category}-changed`;
        }
        const before = [...model.entries.keys()];
        const result = await checkedUpsert(userId, model, { noteKey, category: chosen }, 'limit');

        assert.ok(model.entries.size <= MEMORY_CAPACITY, 'at most 500 entries');
        assert.ok(model.entries.has(noteKey), 'the key just written is kept');
        const removed = before.filter((key) => !model.entries.has(key));
        assert.equal(removed.length, Math.max(0, before.length + (result.created ? 1 : 0) - MEMORY_CAPACITY), 'removes only the excess');
        await assertUserState(userId, model, 'limit');
        await assertUserState(otherId, otherModel, 'limit: other User');
        await assertNoDuplicateKeys([userId, otherId], 'limit');
      }),
    ),
    { numRuns: RUNS },
  );
});

/* ------------------------------------ Property 10: replay and stale writes */

test('Property 10: replaying an upsert leaves the same state, and a stale expectedRevision changes nothing', async () => {
  await assertProperty(
    fc.asyncProperty(
      memoryStateArb({ maxEntries: MEMORY_CAPACITY }),
      fc.nat({ max: 600 }),
      fc.constantFrom(...ENTRY_CATEGORIES),
      fc.array(fc.constantFrom(1000, 60_000, 86_400_000, 0), { minLength: 1, maxLength: 4 }),
      fc.constantFrom('new', 'existing'),
      (state, pick, category, gaps, mode) => withUsers(2, async ([userId, otherId]) => {
        clock = CLOCK_BASE_MS;
        const model = await seedMemory(userId, state);
        const otherModel = await seedMemory(otherId, state.slice(0, 5).map((entry) => ({ ...entry, noteKey: `other ${entry.noteKey}` })));
        const noteKey = mode === 'existing' && state.length > 0 ? state[pick % state.length].noteKey : `replayed ${pick}`;

        const first = await checkedUpsert(userId, model, { noteKey, category }, 'first write');
        const settled = JSON.stringify(await service.list(userId));
        const settledOther = JSON.stringify(await service.list(otherId));
        const revision = model.entries.get(noteKey).revision;

        for (const [round, gap] of gaps.entries()) {
          clock += gap;
          // The same request again, then the same request pinned to the revision it produced: both are replays.
          const replay = await checkedUpsert(userId, model, { noteKey, category: categoryVariant(category, round) }, `replay ${round}`);
          assert.equal(replay.created, false, `replay ${round}: not created again`);
          assert.equal(replay.evicted, false, `replay ${round}: nothing evicted`);
          assert.equal(replay.entry.revision, revision, `replay ${round}: revision`);
          assert.equal(replay.entry.updatedAt, first.entry.updatedAt, `replay ${round}: updated_at`);
          await checkedUpsert(userId, model, { noteKey, category, expectedRevision: revision }, `pinned replay ${round}`);
          assert.equal(JSON.stringify(await service.list(userId)), settled, `replay ${round}: same state`);

          for (const stale of [revision + 1, revision + 7]) {
            await checkedUpsert(userId, model, { noteKey, category: `${category}-other`, expectedRevision: stale }, `stale ${stale}`);
            assert.equal(JSON.stringify(await service.list(userId)), settled, `stale ${stale}: same state`);
          }
        }
        assert.equal(JSON.stringify(await service.list(otherId)), settledOther, 'the other User reads the same');
        await assertUserState(userId, model, 'replay');
        await assertUserState(otherId, otherModel, 'replay: other User');
      }),
    ),
    { numRuns: RUNS },
  );
});

/* ------------------------------------------- Property 10: uniform 404 */

const malformedIdArb = fc.constantFrom(0, -1, 1.5, '3', 'abc', Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, null, undefined, {}, [], true);

test('Property 10: a missing, foreign, or malformed entry ID gets the same 404 and changes nothing', async () => {
  await assertProperty(
    fc.asyncProperty(
      memoryStateArb({ maxEntries: MEMORY_CAPACITY }).map((state) => state.slice(0, 30)).filter((state) => state.length > 0),
      fc.nat({ max: 600 }),
      malformedIdArb,
      fc.constantFrom(undefined, 1, 2, 9),
      (state, pick, malformed, expectedRevision) => withUsers(2, async ([userId, otherId]) => {
        const model = await seedMemory(userId, []);
        const otherModel = await seedMemory(otherId, state);
        const foreign = [...otherModel.entries.values()][pick % state.length];
        const ids = [foreign.id, MISSING_ID, malformed];
        const seen = [];
        for (const entryId of ids) {
          const result = await outcome(service.remove(userId, entryId, { expectedRevision }));
          assertErrorIs(result, ZERO_ENTRY_ERROR, 'not found');
          seen.push([result.error.code, result.error.message, result.error.httpStatus, result.error.field]);
        }
        for (const description of seen) assert.deepEqual(description, seen[0], 'the same answer for every kind of miss');
        await assertUserState(otherId, otherModel, 'the other User still reads the same');
        await assertUserState(userId, model, 'nothing was created');
      }),
    ),
    { numRuns: RUNS },
  );
});

/* ------------------------------------- Property 10: removeForCategory */

test('Property 10: deleting a category removes every entry of that User that maps to it, whatever the letter case', async () => {
  await assertProperty(
    fc.asyncProperty(
      memoryStateArb({ maxEntries: MEMORY_CAPACITY }).map((state) => state.slice(0, 60).map((entry, index) => ({ ...entry, category: categoryVariant(entry.category, index).trim() }))),
      fc.constantFrom(...BUILT_IN_CATEGORIES),
      fc.nat({ max: 8 }),
      (state, category, variantIndex) => withUsers(2, async ([userId, otherId]) => {
        const model = await seedMemory(userId, state);
        const otherModel = await seedMemory(otherId, state.map((entry) => ({ ...entry, noteKey: `other ${entry.noteKey}` })));
        const target = categoryVariant(category, variantIndex);
        assert.equal(await service.removeForCategory(userId, target), model.removeForCategory(target), 'count');
        await assertUserState(userId, model, 'after the category deletion');
        for (const entry of await service.list(userId)) assert.ok(!sameCategory(entry.category, category), 'none maps to it');
        await assertUserState(otherId, otherModel, 'the other User is unchanged');
      }),
    ),
    { numRuns: RUNS },
  );
});

/* ------------------------------------------------ history window and cap */

const HISTORY_NOTES = Object.freeze(['swiggy', 'cab ride', 'coffee', '\u091a\u093e\u092f', '\u0c1f\u0c40', 'rent', 'Dosa Hut']);
const NOTE_STYLES = Object.freeze(['asis', 'upper', 'padded', 'nfd', 'tabbed']);

function styledNote(base, style) {
  switch (style) {
    case 'upper': return base.toLocaleUpperCase('en-IN');
    case 'padded': return `  ${base} `;
    case 'nfd': return base.normalize('NFD');
    case 'tabbed': return `\t${base.replace(/ /g, '\u00a0\u00a0')}\n`;
    default: return base;
  }
}

const historyNoteArb = fc.oneof(
  { weight: 6, arbitrary: fc.tuple(fc.constantFrom(...HISTORY_NOTES), fc.constantFrom(...NOTE_STYLES)).map(([base, style]) => styledNote(base, style)) },
  { weight: 1, arbitrary: fc.constantFrom(null, '', '   ', '\t\u00a0', 'x'.repeat(61)) },
);

const historyExpenseArb = fc.record({
  user: fc.integer({ min: 0, max: 1 }),
  offset: fc.oneof(fc.integer({ min: -95, max: 3 }), fc.constantFrom(-91, -90, -89, -1, 0, 1)),
  note: historyNoteArb,
  category: fc.constantFrom(...BUILT_IN_CATEGORIES),
});

/** Independent history: most recent expense per Note_Key by (spent_on, id) inside today-days..today, at most maxKeys. */
function historyModel(expenses, user, today, days, maxKeys) {
  const start = addDays(today, -days);
  const eligible = expenses
    .filter((expense) => expense.user === user && expense.spentOn >= start && expense.spentOn <= today)
    .map((expense) => ({ ...expense, key: expense.note === null ? null : referenceNoteKey(expense.note) }))
    .filter((expense) => expense.key !== null)
    .sort((a, b) => compareText(b.spentOn, a.spentOn) || b.id - a.id);
  const seen = new Map();
  for (const expense of eligible) {
    if (seen.has(expense.key)) continue;
    seen.set(expense.key, { noteKey: expense.key, category: expense.category, lastSpentOn: expense.spentOn });
    if (seen.size >= maxKeys) break;
  }
  return [...seen.values()];
}

async function insertExpenses(userIds, expenses) {
  await db.batch(expenses.map((expense) => ({
    sql: `INSERT INTO expense_log (id, user_id, month, category, amount, note, spent_on) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [expense.id, userIds[expense.user], expense.spentOn.slice(0, 7), expense.category, 10, expense.note, expense.spentOn],
  })));
}

function withIds(today, expenses) {
  return expenses.map((expense) => {
    const id = nextExpenseId;
    nextExpenseId += 1;
    return { ...expense, id, spentOn: addDays(today, expense.offset) };
  });
}

test('Property 10: history is the newest expense per Note_Key over today-90..today, newest first, for the caller only', async () => {
  await assertProperty(
    fc.asyncProperty(
      validDateArb({ minYear: 2000, maxYear: 2090 }),
      fc.array(historyExpenseArb, { minLength: 0, maxLength: 40 }),
      fc.constantFrom({ days: 90, maxKeys: 500 }, { days: 90, maxKeys: 500 }, { days: 30, maxKeys: 500 }, { days: 1, maxKeys: 500 }, { days: 90, maxKeys: 3 }, { days: 90, maxKeys: 1 }),
      (today, drafts, limits) => withUsers(2, async (userIds) => {
        const expenses = withIds(today, drafts);
        await insertExpenses(userIds, expenses);
        for (let user = 0; user < 2; user += 1) {
          const actual = (await service.history(userIds[user], { today, ...limits })).map((item) => ({ ...item }));
          assert.deepEqual(actual, historyModel(expenses, user, today, limits.days, limits.maxKeys), `history of User ${user}`);
        }
      }),
    ),
    { numRuns: RUNS },
  );
});

test('Property 10: history lists at most 500 Note_Keys and drops the oldest beyond that', async () => {
  await assertProperty(
    fc.asyncProperty(
      validDateArb({ minYear: 2000, maxYear: 2090 }),
      fc.integer({ min: 499, max: 520 }),
      fc.array(fc.integer({ min: 0, max: 90 }), { minLength: 520, maxLength: 520 }),
      (today, count, offsets) => withUsers(2, async (userIds) => {
        const drafts = Array.from({ length: count }, (_, index) => ({
          user: 0,
          offset: -offsets[index],
          note: `item ${index}`,
          category: BUILT_IN_CATEGORIES[index % BUILT_IN_CATEGORIES.length],
        }));
        const expenses = withIds(today, drafts);
        await insertExpenses(userIds, expenses);
        const actual = (await service.history(userIds[0], { today })).map((item) => ({ ...item }));
        assert.ok(actual.length <= 500, 'at most 500 keys');
        assert.deepEqual(actual, historyModel(expenses, 0, today, 90, 500), 'newest first, cut at 500');
        assert.deepEqual(await service.history(userIds[1], { today }), [], 'the other User has none');
      }),
    ),
    { numRuns: RUNS },
  );
});

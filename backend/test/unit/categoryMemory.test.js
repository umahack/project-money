import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createIsolatedTestDatabase } from '../helpers/testDatabase.js';

const ALICE = 41_001;
const BOB = 41_002;

let testDatabase;
let db;
let CategoryMemoryService;
let CategoryMemoryError;
let removeForCategoryStatement;
let clock;
let service;

before(async () => {
  testDatabase = await createIsolatedTestDatabase();
  db = testDatabase.db;
  ({ CategoryMemoryService, CategoryMemoryError, removeForCategoryStatement } = await import(
    '../../src/services/categoryMemory.js'
  ));
});

beforeEach(async () => {
  await testDatabase.reset();
  for (const id of [ALICE, BOB]) {
    await db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)')
      .run(id, `user${id}@example.test`, `User ${id}`, 'test-password-hash');
  }
  clock = Date.parse('2026-03-10T06:30:00.000Z');
  service = new CategoryMemoryService({ database: db, now: () => new Date(clock) });
});

after(async () => {
  await testDatabase?.cleanup();
});

function tick(ms = 1000) {
  clock += ms;
}

async function count(userId) {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM category_memory WHERE user_id = ?').get(userId);
  return Number(row.n);
}

async function seedEntries(userId, total, { updatedAt = (index) => new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString() } = {}) {
  const statements = [];
  for (let index = 0; index < total; index += 1) {
    const stamp = updatedAt(index);
    statements.push({
      sql: `INSERT INTO category_memory (user_id, note_key, category, revision, created_at, updated_at)
            VALUES (?, ?, ?, 1, ?, ?)`,
      args: [userId, `seed ${index}`, 'Food', stamp, stamp],
    });
  }
  await db.batch(statements);
}

async function assertMemoryError(promise, code, httpStatus) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof CategoryMemoryError);
    assert.equal(error.code, code);
    assert.equal(error.httpStatus, httpStatus);
    return true;
  });
}

test('upsert creates an entry with revision 1 and lists it', async () => {
  const result = await service.upsert(ALICE, { noteKey: 'coffee', category: 'Food' });
  assert.equal(result.created, true);
  assert.equal(result.evicted, false);
  assert.equal(result.entry.noteKey, 'coffee');
  assert.equal(result.entry.category, 'Food');
  assert.equal(result.entry.revision, 1);
  assert.equal(result.entry.updatedAt, '2026-03-10T06:30:00.000Z');
  assert.deepEqual(await service.list(ALICE), [result.entry]);
});

test('upsert with a different category increments the revision and refreshes updated_at', async () => {
  const first = await service.upsert(ALICE, { noteKey: 'coffee', category: 'Food' });
  tick();
  const second = await service.upsert(ALICE, { noteKey: 'coffee', category: 'Transport' });
  assert.equal(second.created, false);
  assert.equal(second.entry.id, first.entry.id);
  assert.equal(second.entry.category, 'Transport');
  assert.equal(second.entry.revision, 2);
  assert.equal(second.entry.updatedAt, '2026-03-10T06:30:01.000Z');
  assert.equal(await count(ALICE), 1);
});

test('replaying an upsert, including a case-only difference, leaves the same state', async () => {
  const first = await service.upsert(ALICE, { noteKey: 'coffee', category: 'Food' });
  tick();
  const replay = await service.upsert(ALICE, { noteKey: 'coffee', category: 'Food' });
  const caseOnly = await service.upsert(ALICE, { noteKey: 'coffee', category: 'FOOD' });
  assert.deepEqual(replay.entry, first.entry);
  assert.deepEqual(caseOnly.entry, first.entry);
  assert.equal(replay.created, false);
});

test('expectedRevision must match: a stale value changes nothing and answers 409', async () => {
  const first = await service.upsert(ALICE, { noteKey: 'coffee', category: 'Food' });
  tick();
  const second = await service.upsert(ALICE, {
    noteKey: 'coffee', category: 'Transport', expectedRevision: first.entry.revision,
  });
  assert.equal(second.entry.revision, 2);

  tick();
  await assertMemoryError(
    service.upsert(ALICE, { noteKey: 'coffee', category: 'Shopping', expectedRevision: 1 }),
    'MEMORY_REVISION_CONFLICT',
    409
  );
  assert.deepEqual(await service.list(ALICE), [second.entry]);
});

test('expectedRevision for an entry that no longer exists is a conflict and does not recreate it', async () => {
  const first = await service.upsert(ALICE, { noteKey: 'coffee', category: 'Food' });
  await service.remove(ALICE, first.entry.id);
  await assertMemoryError(
    service.upsert(ALICE, { noteKey: 'coffee', category: 'Food', expectedRevision: 1 }),
    'MEMORY_REVISION_CONFLICT',
    409
  );
  assert.equal(await count(ALICE), 0);
});

test('undo compensation restores the prior category only while the revision is unchanged', async () => {
  const original = await service.upsert(ALICE, { noteKey: 'coffee', category: 'Food' });
  tick();
  const saved = await service.upsert(ALICE, { noteKey: 'coffee', category: 'Transport' });

  tick();
  const restored = await service.upsert(ALICE, {
    noteKey: 'coffee', category: original.entry.category, expectedRevision: saved.entry.revision,
  });
  assert.equal(restored.entry.category, 'Food');

  // A later change makes the stored revision differ from the one the undo knows, so undo must not overwrite it.
  tick();
  const savedAgain = await service.upsert(ALICE, { noteKey: 'coffee', category: 'Shopping' });
  tick();
  const newer = await service.upsert(ALICE, { noteKey: 'coffee', category: 'Health' });
  await assertMemoryError(
    service.upsert(ALICE, { noteKey: 'coffee', category: 'Food', expectedRevision: savedAgain.entry.revision }),
    'MEMORY_REVISION_CONFLICT',
    409
  );
  assert.deepEqual((await service.list(ALICE))[0], newer.entry);
});

test('upsert validates the note key, category, and expected revision', async () => {
  for (const noteKey of ['', 'Coffee', ' coffee', 'two  spaces', 'x'.repeat(61), undefined, null, 5]) {
    await assertMemoryError(service.upsert(ALICE, { noteKey, category: 'Food' }), 'INVALID_NOTE_KEY', 400);
  }
  await service.upsert(ALICE, { noteKey: 'x'.repeat(60), category: 'Food' });
  for (const category of ['', '   ', undefined, 7, 'c'.repeat(65)]) {
    await assertMemoryError(service.upsert(ALICE, { noteKey: 'coffee', category }), 'INVALID_MEMORY_REQUEST', 400);
  }
  for (const expectedRevision of [0, -1, 1.5, '2', Number.NaN]) {
    await assertMemoryError(
      service.upsert(ALICE, { noteKey: 'coffee', category: 'Food', expectedRevision }),
      'INVALID_MEMORY_REQUEST',
      400
    );
  }
  assert.equal(await count(ALICE), 1);
});

test('keys are stored in normalized form and one entry exists per key per user', async () => {
  await service.upsert(ALICE, { noteKey: 'चाय', category: 'Food' });
  await service.upsert(ALICE, { noteKey: 'coffee', category: 'Food' });
  await service.upsert(BOB, { noteKey: 'coffee', category: 'Transport' });
  assert.equal(await count(ALICE), 2);
  assert.equal(await count(BOB), 1);
  await assert.rejects(
    db.prepare(
      `INSERT INTO category_memory (user_id, note_key, category, created_at, updated_at) VALUES (?, 'coffee', 'x', 'a', 'a')`
    ).run(ALICE),
    { code: 'SQLITE_CONSTRAINT_UNIQUE' }
  );
});

test('the 501st entry evicts the least recently updated entry in the same operation', async () => {
  await seedEntries(ALICE, 500);
  assert.equal(await count(ALICE), 500);

  const result = await service.upsert(ALICE, { noteKey: 'newest', category: 'Food' });
  assert.equal(result.created, true);
  assert.equal(result.evicted, true);
  assert.equal(await count(ALICE), 500);

  const keys = new Set((await service.list(ALICE)).map((entry) => entry.noteKey));
  assert.ok(keys.has('newest'));
  assert.ok(!keys.has('seed 0'));
  assert.ok(keys.has('seed 1'));
});

test('replacing an entry at the cap does not evict, and refreshes its recency', async () => {
  await seedEntries(ALICE, 500);
  const result = await service.upsert(ALICE, { noteKey: 'seed 0', category: 'Transport' });
  assert.equal(result.created, false);
  assert.equal(result.evicted, false);
  assert.equal(await count(ALICE), 500);

  const next = await service.upsert(ALICE, { noteKey: 'another', category: 'Food' });
  assert.equal(next.evicted, true);
  const keys = new Set((await service.list(ALICE)).map((entry) => entry.noteKey));
  assert.ok(keys.has('seed 0'), 'the refreshed entry is no longer the oldest');
  assert.ok(!keys.has('seed 1'));
});

test('equal updated_at values evict the lowest ID first', async () => {
  const stamp = '2026-01-01T00:00:00.000Z';
  await seedEntries(ALICE, 500, { updatedAt: () => stamp });
  await service.upsert(ALICE, { noteKey: 'newest', category: 'Food' });
  const keys = new Set((await service.list(ALICE)).map((entry) => entry.noteKey));
  assert.ok(!keys.has('seed 0'));
  assert.ok(keys.has('seed 1'));
});

test('the entry just written is never the one evicted, even if the clock moved backwards', async () => {
  await seedEntries(ALICE, 500, { updatedAt: () => '2030-01-01T00:00:00.000Z' });
  const result = await service.upsert(ALICE, { noteKey: 'newest', category: 'Food' });
  assert.equal(result.evicted, true);
  assert.equal(await count(ALICE), 500);
  const keys = new Set((await service.list(ALICE)).map((entry) => entry.noteKey));
  assert.ok(keys.has('newest'));
  assert.ok(!keys.has('seed 0'));
});

test('eviction and the 500 cap are per user', async () => {
  await seedEntries(ALICE, 500);
  await seedEntries(BOB, 3);
  await service.upsert(ALICE, { noteKey: 'newest', category: 'Food' });
  assert.equal(await count(ALICE), 500);
  assert.equal(await count(BOB), 3);
});

test('remove deletes one entry and honours expectedRevision', async () => {
  const first = await service.upsert(ALICE, { noteKey: 'coffee', category: 'Food' });
  tick();
  const second = await service.upsert(ALICE, { noteKey: 'coffee', category: 'Transport' });
  await assertMemoryError(
    service.remove(ALICE, first.entry.id, { expectedRevision: 1 }),
    'MEMORY_REVISION_CONFLICT',
    409
  );
  assert.equal(await count(ALICE), 1);
  await service.remove(ALICE, second.entry.id, { expectedRevision: 2 });
  assert.equal(await count(ALICE), 0);
});

test('a missing entry and another user\'s entry answer the same 404', async () => {
  const bobs = await service.upsert(BOB, { noteKey: 'coffee', category: 'Food' });
  const errors = [];
  for (const entryId of [bobs.entry.id, 999_999, 0, -1, 1.5, '3', Number.NaN]) {
    const error = await service.remove(ALICE, entryId).then(() => null, (caught) => caught);
    assert.ok(error instanceof CategoryMemoryError);
    errors.push([error.code, error.message, error.httpStatus, error.field]);
  }
  assert.deepEqual(errors[0], ['MEMORY_NOT_FOUND', errors[0][1], 404, undefined]);
  for (const entry of errors) assert.deepEqual(entry, errors[0]);
  assert.equal(await count(BOB), 1);

  const withRevision = await service.remove(ALICE, bobs.entry.id, { expectedRevision: 1 })
    .then(() => null, (caught) => caught);
  assert.equal(withRevision.code, 'MEMORY_NOT_FOUND');
});

test('removeAll deletes only the caller\'s entries and returns the count', async () => {
  await service.upsert(ALICE, { noteKey: 'coffee', category: 'Food' });
  await service.upsert(ALICE, { noteKey: 'tea', category: 'Food' });
  await service.upsert(BOB, { noteKey: 'coffee', category: 'Food' });
  assert.equal(await service.removeAll(ALICE), 2);
  assert.equal(await count(ALICE), 0);
  assert.equal(await count(BOB), 1);
  assert.equal(await service.removeAll(ALICE), 0);
});

test('removeForCategory deletes the caller\'s entries for that category without regard to letter case', async () => {
  await service.upsert(ALICE, { noteKey: 'leash', category: 'Pets' });
  await service.upsert(ALICE, { noteKey: 'treats', category: 'pets' });
  await service.upsert(ALICE, { noteKey: 'coffee', category: 'Food' });
  await service.upsert(BOB, { noteKey: 'leash', category: 'Pets' });

  assert.equal(await service.removeForCategory(ALICE, 'PETS'), 2);
  assert.deepEqual((await service.list(ALICE)).map((entry) => entry.noteKey), ['coffee']);
  assert.equal(await count(BOB), 1);
});

test('removeForCategoryStatement runs inside a batch with other writes', async () => {
  await service.upsert(ALICE, { noteKey: 'leash', category: 'Pets' });
  await service.upsert(BOB, { noteKey: 'leash', category: 'Pets' });
  const statement = removeForCategoryStatement(ALICE, 'Pets');
  assert.match(statement.sql, /user_id = \?/);
  const [result] = await db.batch([statement]);
  assert.equal(result.changes, 1);
  assert.equal(await count(ALICE), 0);
  assert.equal(await count(BOB), 1);
});

test('list returns only the caller\'s entries, most recently updated first', async () => {
  await service.upsert(ALICE, { noteKey: 'a', category: 'Food' });
  tick();
  await service.upsert(ALICE, { noteKey: 'b', category: 'Food' });
  tick();
  await service.upsert(BOB, { noteKey: 'c', category: 'Food' });
  assert.deepEqual((await service.list(ALICE)).map((entry) => entry.noteKey), ['b', 'a']);
  assert.deepEqual((await service.list(BOB)).map((entry) => entry.noteKey), ['c']);
});

test('operations by one user never change what another user reads', async () => {
  await service.upsert(BOB, { noteKey: 'coffee', category: 'Food' });
  const before = await service.list(BOB);
  await service.upsert(ALICE, { noteKey: 'coffee', category: 'Transport' });
  await service.removeAll(ALICE);
  await service.removeForCategory(ALICE, 'Food');
  assert.deepEqual(await service.list(BOB), before);
});

async function addExpense(userId, { id, spentOn, category, note }) {
  await db.prepare(
    `INSERT INTO expense_log (id, user_id, month, category, amount, note, spent_on) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, userId, spentOn.slice(0, 7), category, 10, note, spentOn);
}

test('history keeps the most recent expense per Note_Key inside the preceding 90 days', async () => {
  await addExpense(ALICE, { id: 1, spentOn: '2026-03-01', category: 'Food', note: 'Swiggy' });
  await addExpense(ALICE, { id: 2, spentOn: '2026-03-05', category: 'Shopping', note: '  swiggy ' });
  await addExpense(ALICE, { id: 3, spentOn: '2026-03-05', category: 'Bills', note: 'rent' });
  await addExpense(ALICE, { id: 4, spentOn: '2025-12-10', category: 'Transport', note: 'cab' });
  await addExpense(ALICE, { id: 5, spentOn: '2025-12-09', category: 'Transport', note: 'too old' });
  await addExpense(ALICE, { id: 6, spentOn: '2026-03-11', category: 'Food', note: 'future' });
  await addExpense(ALICE, { id: 7, spentOn: '2026-03-02', category: 'Food', note: '' });
  await addExpense(ALICE, { id: 8, spentOn: '2026-03-02', category: 'Food', note: null });
  await addExpense(BOB, { id: 9, spentOn: '2026-03-09', category: 'Food', note: 'bobs only' });

  const history = await service.history(ALICE, { today: '2026-03-10' });
  assert.deepEqual(history, [
    { noteKey: 'rent', category: 'Bills', lastSpentOn: '2026-03-05' },
    { noteKey: 'swiggy', category: 'Shopping', lastSpentOn: '2026-03-05' },
    { noteKey: 'cab', category: 'Transport', lastSpentOn: '2025-12-10' },
  ]);
  assert.deepEqual(await service.history(BOB, { today: '2026-03-10' }), [
    { noteKey: 'bobs only', category: 'Food', lastSpentOn: '2026-03-09' },
  ]);
});

test('history crosses year boundaries and leap days', async () => {
  await addExpense(ALICE, { id: 1, spentOn: '2024-02-29', category: 'Food', note: 'leap' });
  await addExpense(ALICE, { id: 2, spentOn: '2023-12-31', category: 'Food', note: 'year end' });
  await addExpense(ALICE, { id: 3, spentOn: '2023-12-01', category: 'Food', note: 'edge' });
  await addExpense(ALICE, { id: 4, spentOn: '2023-11-30', category: 'Food', note: 'outside' });
  const history = await service.history(ALICE, { today: '2024-02-29' });
  assert.deepEqual(history.map((entry) => entry.noteKey), ['leap', 'year end', 'edge']);
});

test('history returns at most 500 Note_Keys, newest first', async () => {
  const statements = [];
  for (let index = 0; index < 510; index += 1) {
    const day = String((index % 28) + 1).padStart(2, '0');
    statements.push({
      sql: `INSERT INTO expense_log (user_id, month, category, amount, note, spent_on) VALUES (?, ?, ?, ?, ?, ?)`,
      args: [ALICE, '2026-02', 'Food', 10, `note ${index}`, `2026-02-${day}`],
    });
  }
  await db.batch(statements);
  const history = await service.history(ALICE, { today: '2026-03-10' });
  assert.equal(history.length, 500);
  assert.equal(new Set(history.map((entry) => entry.noteKey)).size, 500);
  const dates = history.map((entry) => entry.lastSpentOn);
  assert.deepEqual([...dates].sort().reverse(), dates);
});

test('history rejects an invalid date or out-of-range limits', async () => {
  for (const today of ['2026-02-30', '2026-3-1', '', undefined, '2026-03-10T00:00:00Z']) {
    await assert.rejects(service.history(ALICE, { today }), TypeError);
  }
  await assert.rejects(service.history(ALICE, { today: '2026-03-10', days: 91 }), RangeError);
  await assert.rejects(service.history(ALICE, { today: '2026-03-10', maxKeys: 501 }), RangeError);
});

test('errors never carry the note key or category', async () => {
  const secret = 'secret note';
  const first = await service.upsert(ALICE, { noteKey: secret, category: 'Hidden Category' });
  const attempts = [
    service.upsert(ALICE, { noteKey: secret, category: 'Other', expectedRevision: first.entry.revision + 5 }),
    service.upsert(ALICE, { noteKey: 'Secret Note', category: 'Hidden Category' }),
    service.remove(ALICE, first.entry.id + 100),
  ];
  for (const attempt of attempts) {
    const error = await attempt.then(() => null, (caught) => caught);
    assert.ok(error instanceof CategoryMemoryError);
    const rendered = JSON.stringify({ message: error.message, code: error.code, field: error.field });
    assert.ok(!/secret/i.test(rendered));
    assert.ok(!/hidden/i.test(rendered));
  }
});

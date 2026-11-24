import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { createIsolatedTestDatabase } from '../helpers/testDatabase.js';

const OWNER = 82_001;
const OTHER = 82_002;

let testDatabase;
let db;
let QuickAddRequestError;
let availableCategoryFor;
let validateMemoryBodySize;
let validateMemoryDeleteQuery;
let validateMemoryWriteBody;

before(async () => {
  testDatabase = await createIsolatedTestDatabase();
  db = testDatabase.db;
  ({
    QuickAddRequestError,
    availableCategoryFor,
    validateMemoryBodySize,
    validateMemoryDeleteQuery,
    validateMemoryWriteBody,
  } = await import('../../src/routes/quickAdd.js'));
});

beforeEach(async () => {
  await testDatabase.reset();
  await db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)')
    .run(OWNER, 'route-owner@example.test', 'Route Owner', 'test-password-hash');
  await db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)')
    .run(OTHER, 'route-other@example.test', 'Route Other', 'test-password-hash');
});

after(async () => {
  await testDatabase?.cleanup();
});

function assertRequestError(callback, code, status) {
  assert.throws(callback, (error) => {
    assert.ok(error instanceof QuickAddRequestError);
    assert.equal(error.code, code);
    assert.equal(error.httpStatus, status);
    return true;
  });
}

test('memory write validation accepts only the exact typed schema', () => {
  assert.deepEqual(validateMemoryWriteBody({ noteKey: 'coffee', category: 'Food' }), {
    noteKey: 'coffee',
    category: 'Food',
  });
  assert.deepEqual(validateMemoryWriteBody({
    noteKey: 'चाय', category: 'Food', expectedRevision: 3,
  }), {
    noteKey: 'चाय',
    category: 'Food',
    expectedRevision: 3,
  });

  const prototypeObject = Object.create({ inherited: true });
  prototypeObject.noteKey = 'coffee';
  prototypeObject.category = 'Food';
  const rejectedBodies = [
    null,
    [],
    prototypeObject,
    { noteKey: 'coffee', category: 'Food', unknown: true },
    JSON.parse('{"noteKey":"coffee","category":"Food","__proto__":"blocked"}'),
    JSON.parse('{"noteKey":"coffee","category":{"constructor":"blocked"}}'),
    { noteKey: 'coffee', category: ['Food'] },
    { noteKey: 'coffee', category: 'Food', expectedRevision: null },
    { noteKey: 'coffee', category: 'Food', expectedRevision: '1' },
    { noteKey: 'coffee', category: 'Food', expectedRevision: 0 },
  ];
  for (const body of rejectedBodies) {
    assertRequestError(() => validateMemoryWriteBody(body), 'INVALID_MEMORY_REQUEST', 400);
  }
});

test('memory write validation requires the exact normalized Note_Key', () => {
  for (const noteKey of ['', 'Coffee', ' coffee', 'two  spaces', 'x'.repeat(61), 7, null]) {
    assertRequestError(
      () => validateMemoryWriteBody({ noteKey, category: 'Food' }),
      'INVALID_NOTE_KEY',
      400
    );
  }
  assert.equal(validateMemoryWriteBody({
    noteKey: 'x'.repeat(60), category: 'Food',
  }).noteKey.length, 60);
});

test('the route-level byte check enforces the 1 KB body limit', () => {
  assert.doesNotThrow(() => validateMemoryBodySize({ contentLength: '1024', body: {} }));
  assertRequestError(
    () => validateMemoryBodySize({ contentLength: '1025', body: {} }),
    'PAYLOAD_TOO_LARGE',
    413
  );
  assertRequestError(
    () => validateMemoryBodySize({ body: { value: '₹'.repeat(400) } }),
    'PAYLOAD_TOO_LARGE',
    413
  );
});

test('delete query validation accepts one positive revision and rejects every other field', () => {
  assert.deepEqual(validateMemoryDeleteQuery({}), {});
  assert.deepEqual(validateMemoryDeleteQuery({ expectedRevision: '12' }), { expectedRevision: 12 });
  for (const query of [
    { expectedRevision: '' },
    { expectedRevision: '0' },
    { expectedRevision: '1.5' },
    { expectedRevision: ['1'] },
    { unexpected: '1' },
    JSON.parse('{"constructor":"blocked"}'),
  ]) {
    assertRequestError(() => validateMemoryDeleteQuery(query), 'INVALID_MEMORY_REQUEST', 400);
  }
});

test('available categories resolve canonically and stay scoped to the caller', async () => {
  await db.prepare('INSERT INTO user_categories (user_id, name) VALUES (?, ?)').run(OWNER, 'Pet Care');
  await db.prepare('INSERT INTO user_categories (user_id, name) VALUES (?, ?)').run(OTHER, 'Peer Only');

  assert.equal(await availableCategoryFor(db, OWNER, ' food '), 'Food');
  assert.equal(await availableCategoryFor(db, OWNER, 'pet care'), 'Pet Care');
  assert.equal(await availableCategoryFor(db, OWNER, 'Peer Only'), null);
  assert.equal(await availableCategoryFor(db, OWNER, 'not configured'), null);
});

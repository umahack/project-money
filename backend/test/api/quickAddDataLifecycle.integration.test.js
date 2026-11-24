import '../helpers/blockingStdout.js';
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createIsolatedTestDatabase } from '../helpers/testDatabase.js';

/**
 * Quick Add data lifecycle: how category memory and the daily-allowance mark move through export, account deletion
 * (self-service and admin), expense deletion, and custom-category removal.
 *
 * accountDataControls.test.js already covers the shape of the export, the CSV column, the structured deletion failure
 * at every dependency group, and the basic category cascade. This file adds the cross-path and lifecycle properties:
 * complete and exact scope of deletion, the 500-entry cap, export that agrees with the stored state after later
 * changes, isolation of another account's note text, and availability while the data-use notice is unacknowledged.
 *
 * Requirements: 6.13, 6.15, 6.16, 6.17, 18.19, 18.20.
 */

const PASSWORD = 'Quick-add-lifecycle-123!';
const PEER_SECRET = 'PEER-SECRET-NOTE-7f3a';
const PEER_EXPENSE_SECRET = 'PEER-SECRET-EXPENSE-NOTE-91c2';
const MEMORY_LIMIT = 500;
const ADMIN_ID = 9_001;
const ADMIN_SESSION = 9_002;

let testDatabase;
let db;
let app;
let passwordHash;
let CategoryMemoryService;

before(async () => {
  testDatabase = await createIsolatedTestDatabase();
  db = testDatabase.db;
  process.env.FINANCIAL_MUTATION_HMAC_KEY = 'test-only-quick-add-lifecycle-hmac-key-32-bytes';
  passwordHash = await bcrypt.hash(PASSWORD, 4);
  const { createApp } = await import('../../src/app.js');
  ({ CategoryMemoryService } = await import('../../src/services/categoryMemory.js'));
  app = createApp();
});

beforeEach(async () => {
  await testDatabase.reset();
});

after(async () => {
  await testDatabase?.cleanup();
});

async function insertUser(id, { isAdmin = 0 } = {}) {
  await db.prepare(
    `INSERT INTO users (id, email, name, password_hash, is_admin, token_version)
     VALUES (?, ?, ?, ?, ?, 1)`
  ).run(id, `lifecycle-${id}@example.test`, `Lifecycle ${id}`, passwordHash, isAdmin);
  await db.prepare(
    `INSERT INTO sessions (id, user_id, device_label, ip_hash, user_agent)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id + 500_000, id, 'Lifecycle device', `lifecycle-hash-${id}`, 'LifecycleTest/1.0');
  return { id, sessionId: id + 500_000, email: `lifecycle-${id}@example.test` };
}

function authFor(user) {
  const token = jwt.sign(
    { sub: String(user.id), tv: 1, sid: user.sessionId },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '5m' }
  );
  return `Bearer ${token}`;
}

async function insertAdmin() {
  return insertUser(ADMIN_ID, { isAdmin: 1 });
}

async function acknowledgeNotice(user, version = 1) {
  await db.prepare(
    `INSERT INTO user_financial_state (user_id, data_version, data_use_notice_version, data_use_acknowledged_at)
     VALUES (?, 1, ?, CURRENT_TIMESTAMP)`
  ).run(user.id, version);
}

async function addMemory(user, noteKey, category, { revision = 1, at } = {}) {
  const stamp = at ?? '2026-02-01T00:00:00.000Z';
  await db.prepare(
    `INSERT INTO category_memory (user_id, note_key, category, revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(user.id, noteKey, category, revision, stamp, stamp);
}

async function addExpense(user, { category = 'Food', amount = 10, note = null, spentOn = '2026-02-10', mark } = {}) {
  const info = await db.prepare(
    `INSERT INTO expense_log (user_id, month, category, amount, note, spent_on, exclude_from_daily_allowance)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(user.id, spentOn.slice(0, 7), category, amount, note, spentOn, mark ?? null);
  return Number(info.lastInsertRowid);
}

async function count(sql, ...args) {
  const row = await db.prepare(sql).get(...args);
  return Number(row.count);
}

async function memoryRows(userId) {
  return db.prepare(
    `SELECT id, note_key, category, revision, created_at, updated_at
       FROM category_memory WHERE user_id = ? ORDER BY id`
  ).all(userId);
}

function plain(rows) {
  return rows.map((row) => ({ ...row }));
}

async function expenseRows(userId) {
  return plain(await db.prepare(
    `SELECT id, user_id, month, category, amount, note, spent_on, exclude_from_daily_allowance
       FROM expense_log WHERE user_id = ? ORDER BY id`
  ).all(userId));
}

async function exportJson(user) {
  const response = await request(app).get('/api/auth/export').set('Authorization', authFor(user));
  assert.equal(response.status, 200);
  return response;
}

async function bulkMemory(user, total, { prefix = 'bulk note' } = {}) {
  const statements = [];
  for (let index = 0; index < total; index += 1) {
    // One distinct second per row, so recency order is the insert order.
    const stamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
    statements.push([
      `INSERT INTO category_memory (user_id, note_key, category, revision, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)`,
      [user.id, `${prefix} ${String(index).padStart(4, '0')}`, index % 2 === 0 ? 'Food' : 'Travel', stamp, stamp],
    ]);
  }
  await db.batch(statements);
}

function assertNoSecret(response, ...secrets) {
  const text = JSON.stringify(response.body ?? null) + String(response.text ?? '');
  for (const secret of secrets) {
    assert.equal(text.includes(secret), false, `response must not contain ${secret}`);
  }
}

// ---------------------------------------------------------------------------
// Account deletion: scope
// ---------------------------------------------------------------------------

test('self-service and admin deletion remove all of the account\'s memory and leave the other account\'s rows byte-for-byte unchanged', async () => {
  const selfUser = await insertUser(100);
  const adminTarget = await insertUser(200);
  const bystander = await insertUser(300);
  const admin = await insertAdmin();
  for (const user of [selfUser, adminTarget, bystander]) {
    await bulkMemory(user, 40, { prefix: `user ${user.id}` });
  }
  await addMemory(bystander, PEER_SECRET, 'Food');
  const bystanderBefore = plain(await memoryRows(bystander.id));
  assert.equal(bystanderBefore.length, 41);

  const selfResponse = await request(app)
    .delete('/api/auth/account')
    .set('Authorization', authFor(selfUser))
    .send({ currentPassword: PASSWORD });
  const adminResponse = await request(app)
    .delete(`/api/admin/users/${adminTarget.id}`)
    .set('Authorization', authFor(admin));

  assert.equal(selfResponse.status, 200);
  assert.equal(adminResponse.status, 200);
  assert.deepEqual(selfResponse.body, adminResponse.body);
  for (const user of [selfUser, adminTarget]) {
    assert.equal(await count('SELECT COUNT(*) AS count FROM category_memory WHERE user_id = ?', user.id), 0);
    assert.equal(await count('SELECT COUNT(*) AS count FROM users WHERE id = ?', user.id), 0);
  }
  assert.deepEqual(plain(await memoryRows(bystander.id)), bystanderBefore);
  assert.equal(await count('SELECT COUNT(*) AS count FROM category_memory'), 41);
});

test('the deletion probe reports no category_memory once the account is deleted, and reports it while rows remain', async () => {
  const { findUndeletedAccountRecordCategories } = await import('../../src/db/accountDeletion.js');
  const user = await insertUser(400);
  await addMemory(user, 'probe note', 'Food');

  const before = await findUndeletedAccountRecordCategories({ userId: user.id, email: user.email });
  assert.ok(before.some((entry) => entry.key === 'category_memory'));

  const response = await request(app)
    .delete('/api/auth/account')
    .set('Authorization', authFor(user))
    .send({ currentPassword: PASSWORD });
  assert.equal(response.status, 200);

  const after = await findUndeletedAccountRecordCategories({ userId: user.id, email: user.email });
  assert.deepEqual(after, [], 'no record category may remain after a completed deletion');
});

test('deleting an account that holds the full 500-entry cap removes every row', async () => {
  const selfUser = await insertUser(500);
  const adminTarget = await insertUser(600);
  const admin = await insertAdmin();
  await bulkMemory(selfUser, MEMORY_LIMIT);
  await bulkMemory(adminTarget, MEMORY_LIMIT);
  assert.equal(await count('SELECT COUNT(*) AS count FROM category_memory'), 2 * MEMORY_LIMIT);

  const selfResponse = await request(app)
    .delete('/api/auth/account')
    .set('Authorization', authFor(selfUser))
    .send({ currentPassword: PASSWORD });
  assert.equal(selfResponse.status, 200);
  assert.equal(await count('SELECT COUNT(*) AS count FROM category_memory'), MEMORY_LIMIT);

  const adminResponse = await request(app)
    .delete(`/api/admin/users/${adminTarget.id}`)
    .set('Authorization', authFor(admin));
  assert.equal(adminResponse.status, 200);
  assert.equal(await count('SELECT COUNT(*) AS count FROM category_memory'), 0);
});

// ---------------------------------------------------------------------------
// Account deletion: atomicity with an injected failure at the category_memory step
// ---------------------------------------------------------------------------

async function accountSnapshot(user) {
  const tables = [
    ['users', 'id'],
    ['sessions', 'user_id'],
    ['expense_log', 'user_id'],
    ['user_categories', 'user_id'],
    ['category_memory', 'user_id'],
    ['user_financial_state', 'user_id'],
  ];
  const snapshot = {};
  for (const [table, column] of tables) {
    snapshot[table] = plain(await db.prepare(`SELECT * FROM ${table} WHERE ${column} = ? ORDER BY 1`).all(user.id));
  }
  return snapshot;
}

test('a failure at the category_memory step rolls back every earlier step and reports category memory on both paths', async () => {
  const selfUser = await insertUser(700);
  const adminTarget = await insertUser(800);
  const bystander = await insertUser(900);
  const admin = await insertAdmin();
  for (const user of [selfUser, adminTarget, bystander]) {
    await acknowledgeNotice(user);
    await addMemory(user, 'remembered one', 'Food');
    await addMemory(user, 'remembered two', 'Travel', { revision: 3 });
    await addExpense(user, { note: 'kept expense', mark: 1 });
    await db.prepare('INSERT INTO user_categories (user_id, name) VALUES (?, ?)').run(user.id, 'Family');
  }
  const before = {
    self: await accountSnapshot(selfUser),
    target: await accountSnapshot(adminTarget),
    bystander: await accountSnapshot(bystander),
  };

  // Only the deleting account's rows are rejected, so the batch reaches the memory step and fails there, after the
  // expense_log, category_budgets, savings_goals and earlier statements already ran.
  await db.prepare(
    `CREATE TRIGGER reject_memory_step
       BEFORE DELETE ON category_memory
       BEGIN SELECT RAISE(ABORT, 'injected category-memory deletion failure'); END`
  ).run();
  let selfResponse;
  let adminResponse;
  try {
    selfResponse = await request(app)
      .delete('/api/auth/account')
      .set('Authorization', authFor(selfUser))
      .send({ currentPassword: PASSWORD });
    adminResponse = await request(app)
      .delete(`/api/admin/users/${adminTarget.id}`)
      .set('Authorization', authFor(admin));
  } finally {
    await db.prepare('DROP TRIGGER reject_memory_step').run();
  }

  for (const response of [selfResponse, adminResponse]) {
    assert.equal(response.status, 500);
    assert.equal(response.body.code, 'ACCOUNT_DELETION_INCOMPLETE');
    assert.equal(response.body.status, 'incomplete');
    const keys = response.body.undeleted_record_categories.map((entry) => entry.key);
    assert.ok(keys.includes('category_memory'), 'category memory must be named');
    assert.deepEqual(
      response.body.undeleted_record_categories.find((entry) => entry.key === 'category_memory'),
      {
        key: 'category_memory',
        description: 'Remembered category choices used to suggest categories in Quick Add.',
      }
    );
    assertNoSecret(response, 'remembered one', 'remembered two', 'kept expense');
  }
  assert.deepEqual(
    selfResponse.body.undeleted_record_categories,
    adminResponse.body.undeleted_record_categories
  );
  assert.equal(selfResponse.body.retry.path, '/api/auth/account');
  assert.equal(adminResponse.body.retry.path, `/api/admin/users/${adminTarget.id}`);

  assert.deepEqual(await accountSnapshot(selfUser), before.self);
  assert.deepEqual(await accountSnapshot(adminTarget), before.target);
  assert.deepEqual(await accountSnapshot(bystander), before.bystander);

  // The retry after the cause is removed succeeds and clears the memory on both paths.
  const retrySelf = await request(app)
    .delete('/api/auth/account')
    .set('Authorization', authFor(selfUser))
    .send({ currentPassword: PASSWORD });
  const retryAdmin = await request(app)
    .delete(`/api/admin/users/${adminTarget.id}`)
    .set('Authorization', authFor(admin));
  assert.equal(retrySelf.status, 200);
  assert.equal(retryAdmin.status, 200);
  assert.equal(await count('SELECT COUNT(*) AS count FROM category_memory WHERE user_id IN (?, ?)', selfUser.id, adminTarget.id), 0);
  assert.deepEqual(await accountSnapshot(bystander), before.bystander);
});

test('an account with only memory rows still reports exactly the remaining record categories when the memory step fails', async () => {
  const selfUser = await insertUser(1_000);
  await db.prepare('DELETE FROM sessions WHERE user_id = ?').run(selfUser.id);
  // Keep the session the request authenticates with, so only memory and the profile remain.
  await db.prepare(
    `INSERT INTO sessions (id, user_id, device_label, ip_hash, user_agent) VALUES (?, ?, 'Lifecycle device', 'h', 'ua')`
  ).run(selfUser.sessionId, selfUser.id);
  await addMemory(selfUser, 'only memory', 'Food');

  await db.prepare(
    `CREATE TRIGGER reject_memory_step
       BEFORE DELETE ON category_memory
       BEGIN SELECT RAISE(ABORT, 'injected category-memory deletion failure'); END`
  ).run();
  let response;
  try {
    response = await request(app)
      .delete('/api/auth/account')
      .set('Authorization', authFor(selfUser))
      .send({ currentPassword: PASSWORD });
  } finally {
    await db.prepare('DROP TRIGGER reject_memory_step').run();
  }

  assert.equal(response.status, 500);
  assert.deepEqual(
    response.body.undeleted_record_categories.map((entry) => entry.key).sort(),
    ['account_profile', 'category_memory', 'sessions']
  );
  assert.equal(await count('SELECT COUNT(*) AS count FROM category_memory WHERE user_id = ?', selfUser.id), 1);
  assert.equal(await count('SELECT COUNT(*) AS count FROM users WHERE id = ?', selfUser.id), 1);
});

// ---------------------------------------------------------------------------
// Export: completeness, consistency with stored state, marks, cap
// ---------------------------------------------------------------------------

test('exported memory equals the stored rows field for field and follows later changes', async () => {
  const user = await insertUser(1_100);
  const service = new CategoryMemoryService({ now: () => new Date('2026-03-01T10:00:00.000Z') });
  await service.upsert(user.id, { noteKey: 'uber to office', category: 'Travel' });
  await service.upsert(user.id, { noteKey: 'lunch with team', category: 'Food' });
  await addExpense(user, { note: 'unrelated expense' });

  const first = await exportJson(user);
  const firstStored = plain(await memoryRows(user.id));
  assert.deepEqual(
    [...first.body.data.category_memory].sort((a, b) => a.id - b.id),
    firstStored
  );
  assert.equal(first.body.data.category_memory.length, 2);

  // A category change increments the revision. The export reads the new state, not a cached one.
  const later = new CategoryMemoryService({ now: () => new Date('2026-03-02T10:00:00.000Z') });
  await later.upsert(user.id, { noteKey: 'uber to office', category: 'Other' });
  const listed = await later.list(user.id);
  const removed = listed.find((entry) => entry.noteKey === 'lunch with team');
  await later.remove(user.id, removed.id);

  const second = await exportJson(user);
  assert.deepEqual(
    [...second.body.data.category_memory].sort((a, b) => a.id - b.id),
    plain(await memoryRows(user.id))
  );
  assert.deepEqual(
    second.body.data.category_memory.map((entry) => [entry.note_key, entry.category, entry.revision]),
    [['uber to office', 'Other', 2]]
  );

  // The exported rows agree with what the service lists, so a re-read after export shows the same memory.
  const relisted = await later.list(user.id);
  assert.deepEqual(
    relisted.map((entry) => [entry.id, entry.noteKey, entry.category, entry.revision, entry.updatedAt]),
    second.body.data.category_memory.map((entry) => [
      entry.id, entry.note_key, entry.category, entry.revision, entry.updated_at,
    ])
  );
});

test('every entry of a full 500-entry memory is exported, including after an eviction', async () => {
  const user = await insertUser(1_200);
  await bulkMemory(user, MEMORY_LIMIT);

  const full = await exportJson(user);
  assert.equal(full.body.data.category_memory.length, MEMORY_LIMIT);
  assert.equal(new Set(full.body.data.category_memory.map((entry) => entry.note_key)).size, MEMORY_LIMIT);

  const service = new CategoryMemoryService({ now: () => new Date('2026-06-01T00:00:00.000Z') });
  const result = await service.upsert(user.id, { noteKey: 'the 501st note', category: 'Other' });
  assert.equal(result.evicted, true);

  const afterEviction = await exportJson(user);
  const keys = afterEviction.body.data.category_memory.map((entry) => entry.note_key);
  assert.equal(keys.length, MEMORY_LIMIT);
  assert.ok(keys.includes('the 501st note'));
  assert.equal(keys.includes('bulk note 0000'), false, 'the least recently updated entry is the one evicted');
  assert.ok(keys.includes('bulk note 0001'));
});

test('JSON and CSV exports carry the allowance mark as stored: 1, 0 and NULL', async () => {
  const user = await insertUser(1_300);
  const excluded = await addExpense(user, { note: 'excluded', spentOn: '2026-02-01', mark: 1 });
  const stored0 = await addExpense(user, { note: 'zero', spentOn: '2026-02-02', mark: 0 });
  const counted = await addExpense(user, { note: 'counted', spentOn: '2026-02-03' });

  const json = await exportJson(user);
  const marks = Object.fromEntries(
    json.body.data.expenses.map((expense) => [expense.id, expense.exclude_from_daily_allowance])
  );
  assert.deepEqual(marks, { [excluded]: 1, [stored0]: 0, [counted]: null });
  assert.equal(
    Object.hasOwn(json.body.data.expenses[0], 'exclude_from_daily_allowance'),
    true
  );

  const csv = await request(app).get('/api/finance/export.csv').set('Authorization', authFor(user));
  assert.equal(csv.status, 200);
  const lines = csv.text.split('\n');
  assert.equal(lines[0], 'date,month,category,amount,note,counted_in_daily_allowance');
  assert.deepEqual(lines.slice(1, -1).map((line) => line.split(',').at(-1)), ['no', 'yes', 'yes']);
  // The first five columns are exactly what the pre-feature export produced.
  assert.deepEqual(lines.slice(1, -1).map((line) => line.split(',').slice(0, 5).join(',')), [
    '2026-02-01,2026-02,Food,10,excluded',
    '2026-02-02,2026-02,Food,10,zero',
    '2026-02-03,2026-02,Food,10,counted',
  ]);
});

test('the exported mark equals the database column for every expense, and a later change is exported', async () => {
  const user = await insertUser(1_400);
  const ids = [
    await addExpense(user, { spentOn: '2026-02-01', mark: 1 }),
    await addExpense(user, { spentOn: '2026-02-02', mark: 0 }),
    await addExpense(user, { spentOn: '2026-02-03' }),
  ];
  const marksOf = (response) => Object.fromEntries(
    response.body.data.expenses.map((expense) => [expense.id, expense.exclude_from_daily_allowance])
  );
  const stored = async () => Object.fromEntries(
    (await expenseRows(user.id)).map((row) => [row.id, row.exclude_from_daily_allowance])
  );

  assert.deepEqual(marksOf(await exportJson(user)), await stored());
  await db.prepare('UPDATE expense_log SET exclude_from_daily_allowance = NULL WHERE id = ?').run(ids[0]);
  await db.prepare('UPDATE expense_log SET exclude_from_daily_allowance = 1 WHERE id = ?').run(ids[2]);
  assert.deepEqual(marksOf(await exportJson(user)), await stored());
  assert.deepEqual(await stored(), { [ids[0]]: null, [ids[1]]: 0, [ids[2]]: 1 });
});

// ---------------------------------------------------------------------------
// Isolation of another account's note text
// ---------------------------------------------------------------------------

test('no response to the account carries another account\'s note text', async () => {
  const user = await insertUser(1_500);
  const peer = await insertUser(1_600);
  await db.prepare('INSERT INTO user_categories (user_id, name) VALUES (?, ?)').run(user.id, 'Family');
  await db.prepare('INSERT INTO user_categories (user_id, name) VALUES (?, ?)').run(peer.id, 'Family');
  await addMemory(user, 'my own note', 'Family');
  await addMemory(user, 'my other note', 'Food');
  await addMemory(peer, PEER_SECRET, 'Family');
  const peerExpense = await addExpense(peer, { note: PEER_EXPENSE_SECRET, category: 'Family', mark: 1 });
  await addExpense(user, { note: 'my expense' });
  const familyId = Number((await db.prepare(
    'SELECT id FROM user_categories WHERE user_id = ? AND name = ?'
  ).get(user.id, 'Family')).id);
  const peerFamilyId = Number((await db.prepare(
    'SELECT id FROM user_categories WHERE user_id = ? AND name = ?'
  ).get(peer.id, 'Family')).id);

  const responses = [
    await request(app).get('/api/auth/export').set('Authorization', authFor(user)),
    await request(app).get('/api/finance/export.csv').set('Authorization', authFor(user)),
    await request(app).get('/api/finance/categories').set('Authorization', authFor(user)),
    await request(app).delete(`/api/finance/categories/${peerFamilyId}`).set('Authorization', authFor(user)),
    await request(app).delete(`/api/finance/expenses/${peerExpense}`).set('Authorization', authFor(user)),
    await request(app).delete(`/api/finance/categories/${familyId}`).set('Authorization', authFor(user)),
  ];
  assert.deepEqual(responses.map((response) => response.status), [200, 200, 200, 404, 404, 200]);
  for (const response of responses) assertNoSecret(response, PEER_SECRET, PEER_EXPENSE_SECRET);

  // The peer's rows are untouched by the account's requests.
  assert.equal(await count('SELECT COUNT(*) AS count FROM category_memory WHERE user_id = ?', peer.id), 1);
  assert.equal(await count('SELECT COUNT(*) AS count FROM expense_log WHERE id = ?', peerExpense), 1);

  // The failing paths do not echo it either.
  await db.prepare(
    `CREATE TRIGGER reject_memory_step
       BEFORE DELETE ON category_memory
       BEGIN SELECT RAISE(ABORT, 'injected category-memory deletion failure'); END`
  ).run();
  let failure;
  try {
    failure = await request(app)
      .delete('/api/auth/account')
      .set('Authorization', authFor(user))
      .send({ currentPassword: PASSWORD });
  } finally {
    await db.prepare('DROP TRIGGER reject_memory_step').run();
  }
  assert.equal(failure.status, 500);
  assertNoSecret(failure, PEER_SECRET, PEER_EXPENSE_SECRET, 'my own note');
});

// ---------------------------------------------------------------------------
// Expense deletion leaves memory alone
// ---------------------------------------------------------------------------

test('deleting an expense, by the legacy and the clarity route, does not touch any memory row', async () => {
  const user = await insertUser(1_700);
  const peer = await insertUser(1_800);
  await acknowledgeNotice(user);
  await addMemory(user, 'coffee', 'Food');
  await addMemory(user, 'metro card', 'Travel');
  await addMemory(peer, 'coffee', 'Food');
  const userBefore = plain(await memoryRows(user.id));
  const peerBefore = plain(await memoryRows(peer.id));

  const legacyId = await addExpense(user, { note: 'coffee', category: 'Food' });
  const clarityId = await addExpense(user, { note: 'metro card', category: 'Travel', mark: 1 });
  await addExpense(peer, { note: 'coffee', category: 'Food' });

  const legacy = await request(app)
    .delete(`/api/finance/expenses/${legacyId}`)
    .set('Authorization', authFor(user));
  assert.equal(legacy.status, 200);
  const clarity = await request(app)
    .delete(`/api/finance/expenses/${clarityId}`)
    .set('Authorization', authFor(user))
    .set('X-Clarity-Contract', '1')
    .set('Idempotency-Key', 'c1000000-0000-4000-8000-000000000001')
    .send({ expectedRecordVersion: 0 });
  assert.equal(clarity.status, 200, JSON.stringify(clarity.body));

  assert.equal(await count('SELECT COUNT(*) AS count FROM expense_log WHERE user_id = ?', user.id), 0);
  assert.deepEqual(plain(await memoryRows(user.id)), userBefore);
  assert.deepEqual(plain(await memoryRows(peer.id)), peerBefore);
});

// ---------------------------------------------------------------------------
// Custom-category removal
// ---------------------------------------------------------------------------

test('removing a custom category deletes that account\'s memory for the name in any letter case and nothing else', async () => {
  const user = await insertUser(1_900);
  const peer = await insertUser(2_000);
  for (const owner of [user, peer]) {
    await db.prepare('INSERT INTO user_categories (user_id, name) VALUES (?, ?)').run(owner.id, 'Pets');
  }
  await db.prepare('INSERT INTO user_categories (user_id, name) VALUES (?, ?)').run(user.id, 'Pets Extra');
  await addMemory(user, 'vet visit', 'Pets');
  await addMemory(user, 'dog food', 'pets');
  await addMemory(user, 'cat toys', 'PETS');
  await addMemory(user, 'groomer', 'Pets Extra');
  await addMemory(user, 'groceries', 'Food');
  await addMemory(peer, 'vet visit', 'Pets');
  await addMemory(peer, 'dog food', 'pets');
  const peerMemoryBefore = plain(await memoryRows(peer.id));

  const expenses = [
    await addExpense(user, { category: 'Pets', amount: 120.5, note: 'vet visit', mark: 1 }),
    await addExpense(user, { category: 'pets', amount: 30, note: 'dog food' }),
    await addExpense(user, { category: 'Food', amount: 99, note: 'groceries' }),
  ];
  await addExpense(peer, { category: 'Pets', amount: 15, note: 'peer pet note' });
  const expensesBefore = await expenseRows(user.id);
  const peerExpensesBefore = await expenseRows(peer.id);
  assert.equal(expensesBefore.length, expenses.length);

  const petsId = Number((await db.prepare(
    'SELECT id FROM user_categories WHERE user_id = ? AND name = ?'
  ).get(user.id, 'Pets')).id);
  const response = await request(app)
    .delete(`/api/finance/categories/${petsId}`)
    .set('Authorization', authFor(user));

  assert.equal(response.status, 200);
  assert.deepEqual(
    (await memoryRows(user.id)).map((row) => [row.note_key, row.category]),
    [['groomer', 'Pets Extra'], ['groceries', 'Food']]
  );
  assert.deepEqual(plain(await memoryRows(peer.id)), peerMemoryBefore);
  // Expenses recorded under the removed category keep their category, amount, note and mark.
  assert.deepEqual(await expenseRows(user.id), expensesBefore);
  assert.deepEqual(await expenseRows(peer.id), peerExpensesBefore);
  assert.equal(
    await count('SELECT COUNT(*) AS count FROM user_categories WHERE user_id = ? AND name = ?', peer.id, 'Pets'),
    1
  );
  assert.equal(
    await count('SELECT COUNT(*) AS count FROM user_categories WHERE user_id = ? AND name = ?', user.id, 'Pets Extra'),
    1
  );
});

test('removing a custom category when the account has no memory for it succeeds and changes no memory', async () => {
  const user = await insertUser(2_100);
  await db.prepare('INSERT INTO user_categories (user_id, name) VALUES (?, ?)').run(user.id, 'Hobby');
  await addMemory(user, 'tea', 'Food');
  const before = plain(await memoryRows(user.id));
  const id = Number((await db.prepare(
    'SELECT id FROM user_categories WHERE user_id = ? AND name = ?'
  ).get(user.id, 'Hobby')).id);

  const response = await request(app)
    .delete(`/api/finance/categories/${id}`)
    .set('Authorization', authFor(user));

  assert.equal(response.status, 200);
  assert.deepEqual(plain(await memoryRows(user.id)), before);
});

test('the removal cascade and an account\'s own export agree: removed memory is absent from the next export', async () => {
  const user = await insertUser(2_200);
  await db.prepare('INSERT INTO user_categories (user_id, name) VALUES (?, ?)').run(user.id, 'Hobby');
  await addMemory(user, 'guitar strings', 'Hobby');
  await addMemory(user, 'tea', 'Food');
  const id = Number((await db.prepare(
    'SELECT id FROM user_categories WHERE user_id = ? AND name = ?'
  ).get(user.id, 'Hobby')).id);

  const before = await exportJson(user);
  assert.deepEqual(before.body.data.category_memory.map((entry) => entry.note_key).sort(), ['guitar strings', 'tea']);
  const response = await request(app).delete(`/api/finance/categories/${id}`).set('Authorization', authFor(user));
  assert.equal(response.status, 200);
  const after = await exportJson(user);
  assert.deepEqual(after.body.data.category_memory.map((entry) => entry.note_key), ['tea']);
  assert.deepEqual(after.body.data.user_categories, []);
});

// ---------------------------------------------------------------------------
// Data-use notice: export and deletion stay available, new input is gated
// ---------------------------------------------------------------------------

const UNACKNOWLEDGED_VARIANTS = Object.freeze([
  { name: 'no notice state row', prepare: async () => {} },
  {
    name: 'a state row with notice version 0',
    prepare: async (user) => acknowledgeNotice(user, 0),
  },
]);

for (const variant of UNACKNOWLEDGED_VARIANTS) {
  test(`export, correction and deletion stay available while the notice is unacknowledged (${variant.name})`, async () => {
    const user = await insertUser(2_300);
    const adminTarget = await insertUser(2_400);
    const admin = await insertAdmin();
    for (const owner of [user, adminTarget]) {
      await variant.prepare(owner);
      await db.prepare('INSERT INTO user_categories (user_id, name) VALUES (?, ?)').run(owner.id, 'Hobby');
      await addMemory(owner, 'guitar strings', 'Hobby');
      await addMemory(owner, 'tea', 'Food');
    }
    const expenseId = await addExpense(user, { note: 'tea', mark: 1 });
    const hobbyId = Number((await db.prepare(
      'SELECT id FROM user_categories WHERE user_id = ?'
    ).get(user.id)).id);

    // New input is blocked, so the notice really is unacknowledged for this account.
    const blocked = await request(app)
      .post('/api/finance/salary')
      .set('Authorization', authFor(user))
      .set('X-Clarity-Contract', '1')
      .set('Idempotency-Key', 'c2000000-0000-4000-8000-000000000001')
      .send({ month: '2026-02', amountMinor: 5_000_000, expectedRecordVersion: 0 });
    assert.equal(blocked.status, 428);
    assert.equal(blocked.body.error.code, 'DATA_NOTICE_REQUIRED');

    // Export, both formats, carries the memory and the mark.
    const exported = await exportJson(user);
    assert.deepEqual(
      exported.body.data.category_memory.map((entry) => entry.note_key).sort(),
      ['guitar strings', 'tea']
    );
    assert.equal(exported.body.data.expenses[0].exclude_from_daily_allowance, 1);
    const csv = await request(app).get('/api/finance/export.csv').set('Authorization', authFor(user));
    assert.equal(csv.status, 200);
    assert.match(csv.text, /,no\n$/);

    // Correction: removing a category (and its memory) and deleting an expense are allowed.
    const removed = await request(app).delete(`/api/finance/categories/${hobbyId}`).set('Authorization', authFor(user));
    assert.equal(removed.status, 200);
    assert.deepEqual((await memoryRows(user.id)).map((row) => row.note_key), ['tea']);
    const deletedExpense = await request(app).delete(`/api/finance/expenses/${expenseId}`).set('Authorization', authFor(user));
    assert.equal(deletedExpense.status, 200);
    assert.deepEqual((await memoryRows(user.id)).map((row) => row.note_key), ['tea']);

    // Account deletion on both paths is not gated and removes the memory.
    const selfDelete = await request(app)
      .delete('/api/auth/account')
      .set('Authorization', authFor(user))
      .send({ currentPassword: PASSWORD });
    const adminDelete = await request(app)
      .delete(`/api/admin/users/${adminTarget.id}`)
      .set('Authorization', authFor(admin));
    assert.equal(selfDelete.status, 200);
    assert.equal(adminDelete.status, 200);
    assert.equal(
      await count('SELECT COUNT(*) AS count FROM category_memory WHERE user_id IN (?, ?)', user.id, adminTarget.id),
      0
    );
  });
}

test('an acknowledged account is also able to export, and its gated input is accepted', async () => {
  const user = await insertUser(2_500);
  await acknowledgeNotice(user, 1);
  await addMemory(user, 'tea', 'Food');

  const accepted = await request(app)
    .post('/api/finance/salary')
    .set('Authorization', authFor(user))
    .set('X-Clarity-Contract', '1')
    .set('Idempotency-Key', 'c3000000-0000-4000-8000-000000000001')
    .send({ month: '2026-02', amountMinor: 5_000_000, expectedRecordVersion: 0 });
  assert.equal(accepted.status, 200);
  const exported = await exportJson(user);
  assert.deepEqual(exported.body.data.category_memory.map((entry) => entry.note_key), ['tea']);
});

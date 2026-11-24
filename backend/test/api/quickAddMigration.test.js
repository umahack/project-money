import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient } from '@libsql/client';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { buildSessionFixture, buildUserFixture } from '../helpers/fixtures.js';
import { assertIsolatedTestDatabaseEnvironment } from '../helpers/testDatabase.js';

/**
 * Quick Add migration (spec quick-add-daily-answer, task 5.3).
 *
 * Every test builds a throwaway pre-feature database in a temporary directory,
 * runs the real initializer in src/db/index.js (the module executes its
 * additive migrations on import; cache-busted imports run it again), and
 * inspects the result. Only local file: databases are used. The shared helper
 * refuses remote Turso URLs, tokens, and mail credentials.
 */

const NEW_COLUMN = 'exclude_from_daily_allowance';
const NEW_INDEX = 'idx_category_memory_user_recency';
// Columns that other, unrelated work appends to users (Google sign-in binds
// users.google_sub). Quick Add adds none; this list only keeps the "users is
// unchanged by this migration" check from pinning those unrelated columns.
const UNRELATED_USER_COLUMNS = ['google_sub'];
const FIXTURE_TIME = '2025-12-02T09:30:00.000Z';

const TEST_ENV_KEYS = [
  'NODE_ENV',
  'TZ',
  'HOST',
  'PORT',
  'JWT_SECRET',
  'FINANCIAL_MUTATION_HMAC_KEY',
  'CORS_ORIGIN',
  'TURSO_DATABASE_URL',
  'TURSO_AUTH_TOKEN',
  'RESEND_API_KEY',
  'MAIL_FROM',
  'CRON_SECRET',
];

// Pre-feature shape of every table the feature touches, plus the sessions
// table that authentication reads. The remaining tables are created by the
// real initializer, as they would be on a database that predates them.
const PRE_FEATURE_SCHEMA = [
  `CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    token_version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_label TEXT,
    ip_hash TEXT,
    user_agent TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TEXT DEFAULT CURRENT_TIMESTAMP,
    revoked_at TEXT,
    revoked_reason TEXT
  )`,
  `CREATE TABLE expense_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    month TEXT NOT NULL,
    category TEXT NOT NULL,
    amount REAL NOT NULL CHECK (amount >= 0),
    note TEXT,
    spent_on TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT
  )`,
  'CREATE INDEX idx_expense_log_user_month ON expense_log(user_id, month)',
  `CREATE TABLE recurring_expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    amount REAL NOT NULL CHECK (amount >= 0),
    category TEXT NOT NULL,
    day_of_month INTEGER NOT NULL CHECK (day_of_month BETWEEN 1 AND 31),
    active INTEGER NOT NULL DEFAULT 1,
    last_logged_month TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE user_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, name)
  )`,
];

const OWNER = buildUserFixture({ id: 101, email: 'quick-add-owner@example.test' });
const OTHER = buildUserFixture({ id: 102, email: 'quick-add-other@example.test' });
const SESSION = buildSessionFixture({ id: 201, userId: OWNER.id });

// Legacy expense rows that exercise NULLs, zero, a float that is not exactly
// representable, non-Latin text, formula-like text, and a second user.
const LEGACY_EXPENSES = [
  { id: 1, user_id: 101, month: '2025-11', category: 'Food', amount: 450.5, note: 'swiggy दाल తెలుగు', spent_on: '2025-11-03', created_at: '2025-11-03T10:00:00.000Z', updated_at: null },
  { id: 2, user_id: 101, month: '2025-12', category: 'Rent', amount: 25000, note: null, spent_on: null, created_at: FIXTURE_TIME, updated_at: '2025-12-03T09:30:00.000Z' },
  { id: 3, user_id: 101, month: '2026-01', category: 'Transport', amount: 0, note: '', spent_on: '2026-01-15', created_at: FIXTURE_TIME, updated_at: null },
  { id: 4, user_id: 101, month: '2026-01', category: 'Food', amount: 0.30000000000000004, note: '=SUM(A1) "quoted" 🍜', spent_on: '2026-01-02', created_at: FIXTURE_TIME, updated_at: null },
  { id: 5, user_id: 102, month: '2026-01', category: 'Shopping', amount: 1999.99, note: 'other user', spent_on: '2026-01-09', created_at: FIXTURE_TIME, updated_at: null },
];
const LEGACY_RECURRING = [
  { id: 1, user_id: 101, label: 'Gym', amount: 1500, category: 'Health', day_of_month: 5, active: 1, last_logged_month: '2026-01', created_at: FIXTURE_TIME, updated_at: FIXTURE_TIME },
  { id: 2, user_id: 101, label: 'Streaming', amount: 649, category: 'Entertainment', day_of_month: 31, active: 0, last_logged_month: null, created_at: FIXTURE_TIME, updated_at: FIXTURE_TIME },
];
const LEGACY_CATEGORIES = [
  { id: 1, user_id: 101, name: 'Pets', created_at: FIXTURE_TIME },
];

const EXPENSE_COLUMNS = ['id', 'user_id', 'month', 'category', 'amount', 'note', 'spent_on', 'created_at', 'updated_at'];
const RECURRING_COLUMNS = ['id', 'user_id', 'label', 'amount', 'category', 'day_of_month', 'active', 'last_logged_month', 'created_at', 'updated_at'];
const CATEGORY_COLUMNS = ['id', 'user_id', 'name', 'created_at'];
const USER_COLUMNS = ['id', 'email', 'name', 'password_hash', 'is_admin', 'token_version', 'created_at'];

function captureEnvironment() {
  return Object.fromEntries(TEST_ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnvironment(previous) {
  for (const key of TEST_ENV_KEYS) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
}

function plainRows(rows) {
  return rows.map((row) => Object.fromEntries(Object.entries(row)));
}

async function rawRows(client, sql, args = []) {
  return plainRows((await client.execute({ sql, args })).rows);
}

async function adapterRows(database, sql, args = []) {
  return plainRows(await database.prepare(sql).all(...args));
}

/**
 * Create an isolated pre-feature database, run `body`, and always close every
 * initializer instance, remove the directory, and restore the environment.
 */
async function withPreFeatureDatabase(body, { seed = seedLegacyRows } = {}) {
  const previousEnvironment = captureEnvironment();
  const directory = await mkdtemp(join(tmpdir(), 'project-money-migration-test-'));
  const databaseUrl = pathToFileURL(join(directory, 'data.sqlite')).href;
  const opened = [];
  let pass = 0;

  try {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      TZ: 'Asia/Kolkata',
      HOST: '127.0.0.1',
      PORT: '0',
      JWT_SECRET: 'quick-add-migration-jwt-secret-at-least-24-characters',
      FINANCIAL_MUTATION_HMAC_KEY: 'test-only-financial-mutation-hmac-key-32-bytes-minimum',
      CORS_ORIGIN: 'http://127.0.0.1',
      TURSO_DATABASE_URL: databaseUrl,
      TURSO_AUTH_TOKEN: '',
      RESEND_API_KEY: '',
      MAIL_FROM: '',
      CRON_SECRET: '',
    });
    assertIsolatedTestDatabaseEnvironment();

    const bootstrap = createClient({ url: databaseUrl });
    try {
      for (const statement of PRE_FEATURE_SCHEMA) await bootstrap.execute(statement);
      if (seed) await seed(bootstrap);
    } finally {
      await bootstrap.close();
    }

    // The real initializer runs on import. A distinct query string gives each
    // pass a fresh module instance (and its own client) over the same file.
    const runInitializer = async (label = 'pass') => {
      const moduleUrl = new URL('../../src/db/index.js', import.meta.url);
      moduleUrl.searchParams.set('quick-add-migration-pass', `${label}-${(pass += 1)}`);
      const { default: database } = await import(moduleUrl.href);
      opened.push(database);
      return database;
    };
    const readBootstrap = async (sql, args = []) => {
      const client = createClient({ url: databaseUrl });
      try {
        return await rawRows(client, sql, args);
      } finally {
        await client.close();
      }
    };

    await body({ databaseUrl, runInitializer, readBootstrap });
  } finally {
    for (const database of opened) {
      try {
        await database.close();
      } catch {
        // Already closed by the test body.
      }
    }
    const expectedPrefix = `${tmpdir()}${sep}project-money-migration-test-`;
    if (!directory.startsWith(expectedPrefix)) {
      throw new Error(`Refusing to remove unexpected test directory: ${directory}`);
    }
    await rm(directory, { recursive: true, force: true });
    restoreEnvironment(previousEnvironment);
  }
}

async function insertRows(client, table, columns, rows) {
  const placeholders = columns.map(() => '?').join(', ');
  for (const row of rows) {
    await client.execute({
      sql: `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`,
      args: columns.map((column) => row[column]),
    });
  }
}

async function seedLegacyRows(client) {
  await insertRows(client, 'users', USER_COLUMNS, [OWNER, OTHER]);
  await insertRows(client, 'sessions', Object.keys(SESSION), [SESSION]);
  await insertRows(client, 'expense_log', EXPENSE_COLUMNS, LEGACY_EXPENSES);
  await insertRows(client, 'recurring_expenses', RECURRING_COLUMNS, LEGACY_RECURRING);
  await insertRows(client, 'user_categories', CATEGORY_COLUMNS, LEGACY_CATEGORIES);
}

/** Byte-level image: storage class and hex of the stored text for every column. */
async function byteImage(select, table, columns) {
  const parts = columns.flatMap((column) => [
    `"${column}" AS "v_${column}"`,
    `typeof("${column}") AS "t_${column}"`,
    `hex(CAST("${column}" AS BLOB)) AS "h_${column}"`,
  ]);
  return select(`SELECT ${parts.join(', ')} FROM ${table} ORDER BY id`);
}

/** Schema objects plus every row of every table, for whole-database equality. */
async function dumpDatabase(select) {
  const objects = await select(
    `SELECT type, name, tbl_name, sql FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_stat%' ORDER BY type, name`
  );
  const tables = {};
  for (const object of objects.filter((entry) => entry.type === 'table')) {
    tables[object.name] = await select(`SELECT * FROM "${object.name}" ORDER BY rowid`);
  }
  return { objects, tables };
}

async function capturePreMigrationSchema(select) {
  const objects = await select(
    `SELECT type, name, tbl_name, sql FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`
  );
  const tableInfo = {};
  for (const object of objects.filter((entry) => entry.type === 'table')) {
    tableInfo[object.name] = await select(`PRAGMA table_info("${object.name}")`);
  }
  const indexInfo = {};
  for (const object of objects.filter((entry) => entry.type === 'index')) {
    indexInfo[object.name] = await select(`PRAGMA index_info("${object.name}")`);
  }
  return { objects, tableInfo, indexInfo };
}

function authorizationFor(user, session) {
  const token = jwt.sign(
    { sub: String(user.id), tv: user.token_version, sid: session.id },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '5m' }
  );
  return `Bearer ${token}`;
}

function stripNewColumn(sql) {
  return sql.replace(new RegExp(`,\\s*"${NEW_COLUMN}"\\s+INTEGER`), '');
}

function stripUnrelatedUserColumns(sql) {
  return UNRELATED_USER_COLUMNS.reduce(
    (current, name) => current.replace(new RegExp(`,\\s*"?${name}"?\\s+\\w+`), ''),
    sql
  );
}

test('migrations run twice leave legacy expenses byte-equal with a NULL mark and change nothing else', async () => {
  await withPreFeatureDatabase(async ({ readBootstrap, runInitializer }) => {
    const before = await capturePreMigrationSchema(readBootstrap);
    const beforeImages = {
      expenses: await byteImage(readBootstrap, 'expense_log', EXPENSE_COLUMNS),
      recurring: await byteImage(readBootstrap, 'recurring_expenses', RECURRING_COLUMNS),
      categories: await byteImage(readBootstrap, 'user_categories', CATEGORY_COLUMNS),
      users: await byteImage(readBootstrap, 'users', USER_COLUMNS),
    };
    assert.equal(beforeImages.expenses.length, LEGACY_EXPENSES.length);
    assert.equal(
      before.tableInfo.expense_log.some((column) => column.name === NEW_COLUMN),
      false,
      'fixture must predate the feature'
    );

    const firstPass = await runInitializer('first');
    const afterFirstPass = await dumpDatabase((sql, args) => adapterRows(firstPass, sql, args));
    const afterFirstSchema = await capturePreMigrationSchema((sql, args) => adapterRows(firstPass, sql, args));

    const secondPass = await runInitializer('second');
    const afterSecondPass = await dumpDatabase((sql, args) => adapterRows(secondPass, sql, args));
    assert.deepEqual(
      afterSecondPass,
      afterFirstPass,
      'a second initializer pass must not change any object or row'
    );

    const select = (sql, args) => adapterRows(secondPass, sql, args);

    // Legacy rows: every original column is byte-equal and the new mark is NULL.
    const expenseImage = await byteImage(select, 'expense_log', EXPENSE_COLUMNS);
    assert.deepEqual(expenseImage, beforeImages.expenses);
    assert.deepEqual(await byteImage(select, 'recurring_expenses', RECURRING_COLUMNS), beforeImages.recurring);
    assert.deepEqual(await byteImage(select, 'user_categories', CATEGORY_COLUMNS), beforeImages.categories);
    assert.deepEqual(await byteImage(select, 'users', USER_COLUMNS), beforeImages.users);

    const marks = await select(
      `SELECT id, "${NEW_COLUMN}" AS mark, typeof("${NEW_COLUMN}") AS mark_type
         FROM expense_log ORDER BY id`
    );
    assert.deepEqual(
      marks,
      LEGACY_EXPENSES.map((row) => ({ id: row.id, mark: null, mark_type: 'null' }))
    );

    // No existing column or index changed; the new column is appended once.
    const afterSchema = afterFirstSchema;
    for (const [table, columns] of Object.entries(before.tableInfo)) {
      const actual = afterSchema.tableInfo[table];
      if (table === 'expense_log') {
        assert.deepEqual(actual.slice(0, columns.length), columns);
        assert.equal(actual.length, columns.length + 1);
        assert.deepEqual(actual.at(-1), {
          cid: columns.length,
          name: NEW_COLUMN,
          type: 'INTEGER',
          notnull: 0,
          dflt_value: null,
          pk: 0,
        });
      } else if (table === 'users') {
        // Every original column is untouched. Only columns owned by unrelated
        // work may follow them; Quick Add itself adds none.
        assert.deepEqual(actual.slice(0, columns.length), columns, 'users columns must be unchanged');
        const appended = actual.slice(columns.length).map((column) => column.name);
        assert.deepEqual(
          appended.filter((name) => !UNRELATED_USER_COLUMNS.includes(name)),
          [],
          'Quick Add must not add any users column'
        );
      } else {
        assert.deepEqual(actual, columns, `${table} columns must be unchanged`);
      }
    }
    assert.equal(
      afterSchema.tableInfo.expense_log.filter((column) => column.name === NEW_COLUMN).length,
      1
    );
    for (const object of before.objects) {
      const actual = afterSchema.objects.find(
        (entry) => entry.type === object.type && entry.name === object.name
      );
      assert.ok(actual, `${object.type} ${object.name} must still exist`);
      assert.equal(actual.tbl_name, object.tbl_name);
      assert.equal(
        object.name === 'expense_log'
          ? stripNewColumn(actual.sql)
          : object.name === 'users' ? stripUnrelatedUserColumns(actual.sql) : actual.sql,
        object.sql,
        `${object.name} definition must be unchanged apart from the new column`
      );
    }
    for (const [index, info] of Object.entries(before.indexInfo)) {
      assert.deepEqual(afterSchema.indexInfo[index], info, `${index} columns must be unchanged`);
    }

    // Nothing is backfilled: the new table starts empty and no mark is set.
    assert.deepEqual(await select('SELECT * FROM category_memory'), []);
    assert.deepEqual(
      await select(`SELECT COUNT(*) AS count FROM expense_log WHERE "${NEW_COLUMN}" IS NOT NULL`),
      [{ count: 0 }]
    );
    assert.deepEqual(
      await select(`SELECT name FROM sqlite_sequence WHERE name = 'category_memory'`),
      []
    );
  });
});

test('category_memory table and recency index have the designed shape', async () => {
  await withPreFeatureDatabase(async ({ runInitializer }) => {
    const database = await runInitializer('shape');
    const select = (sql, args) => adapterRows(database, sql, args);

    const columns = (await select('PRAGMA table_info("category_memory")')).map(
      ({ name, type, notnull, dflt_value: defaultValue, pk }) => ({ name, type, notnull, defaultValue, pk })
    );
    assert.deepEqual(columns, [
      { name: 'id', type: 'INTEGER', notnull: 0, defaultValue: null, pk: 1 },
      { name: 'user_id', type: 'INTEGER', notnull: 1, defaultValue: null, pk: 0 },
      { name: 'note_key', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
      { name: 'category', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
      { name: 'revision', type: 'INTEGER', notnull: 1, defaultValue: '1', pk: 0 },
      { name: 'created_at', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
      { name: 'updated_at', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
    ]);

    const foreignKeys = await select('PRAGMA foreign_key_list("category_memory")');
    assert.equal(foreignKeys.length, 1);
    assert.equal(foreignKeys[0].table, 'users');
    assert.equal(foreignKeys[0].from, 'user_id');
    assert.equal(foreignKeys[0].to, 'id');
    assert.equal(foreignKeys[0].on_delete, 'CASCADE');

    const indexes = await select('PRAGMA index_list("category_memory")');
    const recency = indexes.find((entry) => entry.name === NEW_INDEX);
    assert.ok(recency, 'recency index must exist');
    assert.equal(recency.unique, 0);
    assert.deepEqual(
      (await select(`PRAGMA index_info("${NEW_INDEX}")`)).map((entry) => entry.name),
      ['user_id', 'updated_at', 'id']
    );
    const uniqueIndexes = indexes.filter((entry) => entry.unique === 1);
    assert.equal(uniqueIndexes.length, 1);
    assert.deepEqual(
      (await select(`PRAGMA index_info("${uniqueIndexes[0].name}")`)).map((entry) => entry.name),
      ['user_id', 'note_key']
    );

    const plan = await select(
      `EXPLAIN QUERY PLAN
       SELECT id FROM category_memory WHERE user_id = ? ORDER BY updated_at, id`,
      [OWNER.id]
    );
    assert.ok(
      plan.some((step) => String(step.detail).includes(NEW_INDEX)),
      `recency query should use ${NEW_INDEX}: ${JSON.stringify(plan)}`
    );
  });
});

test('an already-migrated database is unchanged by further initializer passes', async () => {
  await withPreFeatureDatabase(async ({ runInitializer }) => {
    const first = await runInitializer('migrated');
    const select = (sql, args) => adapterRows(first, sql, args);

    // Feature data written after the first migration: marks and memory rows.
    await first.prepare(`UPDATE expense_log SET "${NEW_COLUMN}" = 1 WHERE id IN (1, 4)`).run();
    await first.prepare(
      `INSERT INTO category_memory (user_id, note_key, category, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(OWNER.id, 'swiggy', 'Food', 3, '2026-02-01T00:00:00.000Z', '2026-02-02T00:00:00.000Z');
    await first.prepare(
      `INSERT INTO category_memory (user_id, note_key, category, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(OTHER.id, 'swiggy', 'Shopping', '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z');
    const reference = await dumpDatabase(select);
    assert.equal(reference.tables.category_memory.length, 2);

    await runInitializer('again');
    const third = await runInitializer('and-again');
    assert.deepEqual(
      await dumpDatabase((sql, args) => adapterRows(third, sql, args)),
      reference,
      'marks, memory rows, schema, and sequences must survive repeated initialization'
    );
    assert.deepEqual(
      await adapterRows(third, `SELECT id, "${NEW_COLUMN}" AS mark FROM expense_log ORDER BY id`),
      [
        { id: 1, mark: 1 },
        { id: 2, mark: null },
        { id: 3, mark: null },
        { id: 4, mark: 1 },
        { id: 5, mark: null },
      ]
    );
  });
});

test('the new constraints hold: unique key per user, cascade, NOT NULL, defaults, collation', async () => {
  await withPreFeatureDatabase(async ({ runInitializer }) => {
    const database = await runInitializer('constraints');
    const select = (sql, args) => adapterRows(database, sql, args);
    const insert = (userId, noteKey, category, extra = {}) =>
      database.prepare(
        `INSERT INTO category_memory (user_id, note_key, category, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(
        userId,
        noteKey,
        category,
        extra.createdAt ?? '2026-02-01T00:00:00.000Z',
        extra.updatedAt ?? '2026-02-01T00:00:00.000Z'
      );
    const hasCode = (code) => (error) => {
      assert.equal(error.code, code, error.message);
      return true;
    };

    assert.deepEqual(await select('PRAGMA foreign_keys'), [{ foreign_keys: 1 }]);

    // Unique (user_id, note_key); the same key is allowed for another user.
    const first = await insert(OWNER.id, 'coffee', 'Food');
    assert.equal(first.changes, 1);
    await assert.rejects(insert(OWNER.id, 'coffee', 'Transport'), hasCode('SQLITE_CONSTRAINT_UNIQUE'));
    await insert(OTHER.id, 'coffee', 'Shopping');
    // note_key uses binary collation: normalization is the application's job.
    await insert(OWNER.id, 'Coffee', 'Food');
    await insert(OWNER.id, 'कॉफ़ी', 'Food');
    await insert(OWNER.id, 'కాఫీ', 'Food');
    assert.deepEqual(
      await select(`SELECT COUNT(*) AS count FROM category_memory WHERE note_key = 'COFFEE'`),
      [{ count: 0 }]
    );
    assert.deepEqual(
      await select('SELECT revision FROM category_memory WHERE user_id = ? AND note_key = ?', [OWNER.id, 'coffee']),
      [{ revision: 1 }],
      'revision defaults to 1'
    );

    // NOT NULL on every column except the generated id.
    for (const column of ['user_id', 'note_key', 'category', 'revision', 'created_at', 'updated_at']) {
      const values = {
        user_id: OWNER.id,
        note_key: `null-check-${column}`,
        category: 'Food',
        revision: 1,
        created_at: '2026-02-01T00:00:00.000Z',
        updated_at: '2026-02-01T00:00:00.000Z',
        [column]: null,
      };
      await assert.rejects(
        database.prepare(
          `INSERT INTO category_memory (user_id, note_key, category, revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(values.user_id, values.note_key, values.category, values.revision, values.created_at, values.updated_at),
        hasCode('SQLITE_CONSTRAINT_NOTNULL'),
        `${column} must be NOT NULL`
      );
    }

    // Foreign key: no memory row without a user.
    await assert.rejects(insert(999_999, 'orphan', 'Food'), hasCode('SQLITE_CONSTRAINT_FOREIGNKEY'));

    // Category collation is NOCASE (ASCII only) and preserves stored case.
    await insert(OWNER.id, 'groceries', 'Food');
    assert.deepEqual(
      await select(`SELECT category FROM category_memory WHERE user_id = ? AND note_key = 'groceries' AND category = 'FOOD'`, [OWNER.id]),
      [{ category: 'Food' }]
    );
    assert.deepEqual(
      await select(`SELECT COUNT(*) AS count FROM category_memory WHERE note_key = 'groceries' AND category = 'FOOD' COLLATE BINARY`),
      [{ count: 0 }]
    );
    await insert(OWNER.id, 'café', 'Café');
    assert.deepEqual(
      await select(`SELECT COUNT(*) AS count FROM category_memory WHERE note_key = 'café' AND category = 'CAFÉ'`),
      [{ count: 0 }],
      'NOCASE folds ASCII only'
    );

    // Cascade: deleting a user removes only that user's memory rows.
    const ownerBefore = await select('SELECT COUNT(*) AS count FROM category_memory WHERE user_id = ?', [OWNER.id]);
    assert.ok(ownerBefore[0].count > 0);
    await database.prepare('DELETE FROM users WHERE id = ?').run(OWNER.id);
    assert.deepEqual(
      await select('SELECT COUNT(*) AS count FROM category_memory WHERE user_id = ?', [OWNER.id]),
      [{ count: 0 }]
    );
    assert.deepEqual(
      await select('SELECT user_id, note_key, category FROM category_memory'),
      [{ user_id: OTHER.id, note_key: 'coffee', category: 'Shopping' }]
    );
  });
});

test('the exclusion column is nullable, unset by default, and keeps the amount check', async () => {
  await withPreFeatureDatabase(async ({ runInitializer }) => {
    const database = await runInitializer('column');
    const insert = (amount, mark) =>
      mark === undefined
        ? database.prepare(
            `INSERT INTO expense_log (user_id, month, category, amount, note, spent_on)
             VALUES (?, '2026-02', 'Food', ?, 'new', '2026-02-01')`
          ).run(OWNER.id, amount)
        : database.prepare(
            `INSERT INTO expense_log (user_id, month, category, amount, note, spent_on, "${NEW_COLUMN}")
             VALUES (?, '2026-02', 'Food', ?, 'new', '2026-02-01', ?)`
          ).run(OWNER.id, amount, mark);

    const unmarked = await insert(10);
    const explicitNull = await insert(11, null);
    const marked = await insert(12, 1);
    const rows = await adapterRows(
      database,
      `SELECT id, "${NEW_COLUMN}" AS mark FROM expense_log WHERE id IN (?, ?, ?) ORDER BY id`,
      [unmarked.lastInsertRowid, explicitNull.lastInsertRowid, marked.lastInsertRowid]
    );
    assert.deepEqual(rows.map((row) => row.mark), [null, null, 1]);
    await assert.rejects(
      insert(-1),
      (error) => error.code === 'SQLITE_CONSTRAINT_CHECK'
    );
  });
});

test('a concurrent duplicate-column race between initializers is tolerated', async () => {
  await withPreFeatureDatabase(async ({ databaseUrl, readBootstrap, runInitializer }) => {
    assert.equal(
      (await readBootstrap('PRAGMA table_info("expense_log")')).some((column) => column.name === NEW_COLUMN),
      false,
      'fixture must predate the feature'
    );
    const beforeImage = await byteImage(readBootstrap, 'expense_log', EXPENSE_COLUMNS);

    // Several initializers probe and add at the same time; none may throw.
    const databases = await Promise.all(
      Array.from({ length: 6 }, (_, index) => runInitializer(`race-${index}`))
    );
    assert.equal(databases.length, 6);

    const select = (sql, args) => adapterRows(databases[0], sql, args);
    const columns = await select('PRAGMA table_info("expense_log")');
    assert.equal(columns.filter((column) => column.name === NEW_COLUMN).length, 1);
    assert.deepEqual(await byteImage(select, 'expense_log', EXPENSE_COLUMNS), beforeImage);
    assert.deepEqual(await select('SELECT * FROM category_memory'), []);

    // The guard in addColumnIfMissing matches the driver's real duplicate error,
    // which is what a lost probe-then-add race produces.
    const client = createClient({ url: databaseUrl });
    try {
      await assert.rejects(
        client.execute(`ALTER TABLE "expense_log" ADD COLUMN "${NEW_COLUMN}" INTEGER`),
        /duplicate column name/i
      );
    } finally {
      await client.close();
    }
    assert.deepEqual(
      (await select(`SELECT name FROM sqlite_master WHERE name IN ('category_memory', '${NEW_INDEX}') ORDER BY name`)),
      [{ name: 'category_memory' }, { name: NEW_INDEX }]
    );
    assert.deepEqual(
      (await select('SELECT id, user_id, month, category, amount, note, spent_on, created_at, updated_at FROM expense_log ORDER BY id')),
      LEGACY_EXPENSES.map((row) => ({ ...row }))
    );
  });
});

test('initializing an empty pre-feature database creates an empty memory table and no rows', async () => {
  await withPreFeatureDatabase(async ({ runInitializer }) => {
    const database = await runInitializer('empty');
    await runInitializer('empty-again');
    for (const table of ['expense_log', 'recurring_expenses', 'category_memory', 'user_categories', 'users']) {
      assert.deepEqual(
        await adapterRows(database, `SELECT COUNT(*) AS count FROM ${table}`),
        [{ count: 0 }],
        `${table} must stay empty`
      );
    }
  }, { seed: null });
});

test('legacy expenses still export and can be corrected after migration', async () => {
  await withPreFeatureDatabase(async ({ runInitializer }) => {
    // The application modules bind to the plain import of the initializer, so
    // this is the one test that imports it without a cache-busting query.
    const { default: database } = await import('../../src/db/index.js');
    await runInitializer('export-second-pass');

    const { createApp } = await import('../../src/app.js');
    const app = createApp();
    const authorization = authorizationFor(OWNER, SESSION);

    const exported = await request(app).get('/api/auth/export').set('Authorization', authorization);
    assert.equal(exported.status, 200);
    const exportedExpenses = exported.body.data.expenses;
    const ownerExpenses = LEGACY_EXPENSES.filter((row) => row.user_id === OWNER.id);
    assert.equal(exportedExpenses.length, ownerExpenses.length);
    for (const legacyRow of ownerExpenses) {
      const exportedRow = exportedExpenses.find((entry) => entry.id === legacyRow.id);
      assert.ok(exportedRow, `expense ${legacyRow.id} must be exported`);
      for (const column of EXPENSE_COLUMNS) {
        assert.deepEqual(exportedRow[column], legacyRow[column], `${legacyRow.id}.${column}`);
      }
      assert.ok(
        exportedRow[NEW_COLUMN] == null,
        'a legacy expense exports with no exclusion mark'
      );
    }
    assert.equal(exported.body.data.recurring_expenses.length, LEGACY_RECURRING.length);

    const beforeCorrection = await byteImage(
      (sql, args) => adapterRows(database, sql, args),
      'expense_log',
      EXPENSE_COLUMNS
    );
    const correction = await request(app)
      .patch('/api/finance/expenses/1')
      .set('Authorization', authorization)
      .set('X-Clarity-Contract', '1')
      .set('Idempotency-Key', '95000000-0000-4000-8000-000000000001')
      .send({ amount: '460.25', expectedRecordVersion: 0 });
    assert.equal(correction.status, 200, JSON.stringify(correction.body));

    const afterCorrection = await adapterRows(
      database,
      `SELECT id, amount, category, note, spent_on, "${NEW_COLUMN}" AS mark FROM expense_log ORDER BY id`
    );
    assert.deepEqual(afterCorrection[0], {
      id: 1,
      amount: 460.25,
      category: 'Food',
      note: 'swiggy दाल తెలుగు',
      spent_on: '2025-11-03',
      mark: null,
    });
    const untouched = await byteImage(
      (sql, args) => adapterRows(database, sql, args),
      'expense_log',
      EXPENSE_COLUMNS
    );
    assert.deepEqual(untouched.slice(1), beforeCorrection.slice(1), 'other legacy rows are unchanged');
    assert.deepEqual(
      afterCorrection.slice(1).map((row) => row.mark),
      [null, null, null, null]
    );
  });
});

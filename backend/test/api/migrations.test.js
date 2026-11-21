import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient } from '@libsql/client';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { buildLegacyRowFixtures, buildSessionFixture, buildUserFixture } from '../helpers/fixtures.js';
import { assertIsolatedTestDatabaseEnvironment } from '../helpers/testDatabase.js';

const TEST_ENV_KEYS = [
  'NODE_ENV',
  'TZ',
  'HOST',
  'PORT',
  'JWT_SECRET',
  'CORS_ORIGIN',
  'TURSO_DATABASE_URL',
  'TURSO_AUTH_TOKEN',
  'RESEND_API_KEY',
  'MAIL_FROM',
  'CRON_SECRET',
];

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
  `CREATE TABLE emis (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    amount REAL NOT NULL CHECK (amount >= 0),
    category TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE savings_goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    target_amount REAL NOT NULL CHECK (target_amount > 0),
    saved_amount REAL NOT NULL DEFAULT 0 CHECK (saved_amount >= 0),
    target_date TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE trips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    destination TEXT,
    budget REAL NOT NULL CHECK (budget >= 0),
    start_date TEXT,
    end_date TEXT,
    public_token TEXT,
    public_enabled INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE trip_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    email TEXT,
    UNIQUE(trip_id, name)
  )`,
  `CREATE TABLE trip_expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    payer TEXT NOT NULL,
    description TEXT NOT NULL,
    amount REAL NOT NULL CHECK (amount >= 0),
    split_json TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  'CREATE UNIQUE INDEX idx_trips_public_token ON trips(public_token) WHERE public_token IS NOT NULL',
];

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
  const result = await client.execute({ sql, args });
  return plainRows(result.rows);
}

async function adapterRows(database, sql, args = []) {
  return plainRows(await database.prepare(sql).all(...args));
}

async function captureLegacySourceRows(selectRows) {
  return {
    users: await selectRows(
      'SELECT id, email, name, password_hash, is_admin, token_version, created_at FROM users ORDER BY id'
    ),
    sessions: await selectRows(
      `SELECT id, user_id, device_label, ip_hash, user_agent, created_at,
              last_seen_at, revoked_at, revoked_reason
         FROM sessions ORDER BY id`
    ),
    emis: await selectRows(
      'SELECT id, user_id, label, amount, category, created_at FROM emis ORDER BY id'
    ),
    savingsGoals: await selectRows(
      `SELECT id, user_id, name, target_amount, saved_amount, target_date,
              created_at, updated_at
         FROM savings_goals ORDER BY id`
    ),
    trips: await selectRows(
      `SELECT id, user_id, name, destination, budget, start_date, end_date,
              public_token, public_enabled, created_at
         FROM trips ORDER BY id`
    ),
    tripMembers: await selectRows(
      'SELECT id, trip_id, user_id, name, email FROM trip_members ORDER BY id'
    ),
    tripExpenses: await selectRows(
      `SELECT id, trip_id, payer, description, amount, split_json, created_at
         FROM trip_expenses ORDER BY id`
    ),
  };
}

async function seedPreFeatureDatabase(client, { user, session, legacy }) {
  for (const statement of PRE_FEATURE_SCHEMA) await client.execute(statement);

  await client.batch([
    {
      sql: `INSERT INTO users
        (id, email, name, password_hash, is_admin, token_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        user.id,
        user.email,
        user.name,
        user.password_hash,
        user.is_admin,
        user.token_version,
        user.created_at,
      ],
    },
    {
      sql: `INSERT INTO sessions
        (id, user_id, device_label, ip_hash, user_agent, created_at,
         last_seen_at, revoked_at, revoked_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        session.id,
        session.user_id,
        session.device_label,
        session.ip_hash,
        session.user_agent,
        session.created_at,
        session.last_seen_at,
        session.revoked_at,
        session.revoked_reason,
      ],
    },
    {
      sql: `INSERT INTO emis
        (id, user_id, label, amount, category, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        legacy.openEndedBill.id,
        legacy.openEndedBill.user_id,
        legacy.openEndedBill.label,
        legacy.openEndedBill.amount,
        legacy.openEndedBill.category,
        legacy.openEndedBill.created_at,
      ],
    },
    {
      sql: `INSERT INTO savings_goals
        (id, user_id, name, target_amount, saved_amount, target_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        legacy.overfundedGoal.id,
        legacy.overfundedGoal.user_id,
        legacy.overfundedGoal.name,
        legacy.overfundedGoal.target_amount,
        legacy.overfundedGoal.saved_amount,
        legacy.overfundedGoal.target_date,
        legacy.overfundedGoal.created_at,
        legacy.overfundedGoal.updated_at,
      ],
    },
    {
      sql: `INSERT INTO trips
        (id, user_id, name, destination, budget, start_date, end_date,
         public_token, public_enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        legacy.sharedTrip.id,
        legacy.sharedTrip.user_id,
        legacy.sharedTrip.name,
        legacy.sharedTrip.destination,
        legacy.sharedTrip.budget,
        legacy.sharedTrip.start_date,
        legacy.sharedTrip.end_date,
        legacy.sharedTrip.public_token,
        legacy.sharedTrip.public_enabled,
        legacy.sharedTrip.created_at,
      ],
    },
    {
      sql: `INSERT INTO trip_members (id, trip_id, user_id, name, email)
       VALUES (?, ?, ?, ?, ?)`,
      args: [941, legacy.sharedTrip.id, user.id, legacy.malformedTripExpense.payer, user.email],
    },
    {
      sql: `INSERT INTO trip_expenses
        (id, trip_id, payer, description, amount, split_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        legacy.malformedTripExpense.id,
        legacy.malformedTripExpense.trip_id,
        legacy.malformedTripExpense.payer,
        legacy.malformedTripExpense.description,
        legacy.malformedTripExpense.amount,
        legacy.malformedTripExpense.split_json,
        legacy.malformedTripExpense.created_at,
      ],
    },
  ], 'write');
}

function authorizationFor(user, session) {
  const token = jwt.sign(
    { sub: String(user.id), tv: user.token_version, sid: session.id },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '5m' }
  );
  return `Bearer ${token}`;
}

test('additive migrations are idempotent and preserve legacy rows for export and correction', async () => {
  const previousEnvironment = captureEnvironment();
  const directory = await mkdtemp(join(tmpdir(), 'project-money-migration-test-'));
  const databasePath = join(directory, 'data.sqlite');
  const databaseUrl = pathToFileURL(databasePath).href;
  const user = buildUserFixture({ id: 101, email: 'migration-owner@example.test' });
  const session = buildSessionFixture({ id: 201, userId: user.id });
  const legacy = buildLegacyRowFixtures({ userId: user.id, tripId: 901 });
  let database;
  let secondMigrationDatabase;

  try {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      TZ: 'Asia/Kolkata',
      HOST: '127.0.0.1',
      PORT: '0',
      JWT_SECRET: 'migration-test-jwt-secret-at-least-24-characters',
      CORS_ORIGIN: 'http://127.0.0.1',
      TURSO_DATABASE_URL: databaseUrl,
      TURSO_AUTH_TOKEN: '',
      RESEND_API_KEY: '',
      MAIL_FROM: '',
      CRON_SECRET: '',
    });
    assertIsolatedTestDatabaseEnvironment();

    const bootstrapClient = createClient({ url: databaseUrl });
    let sourceBefore;
    try {
      await seedPreFeatureDatabase(bootstrapClient, { user, session, legacy });
      sourceBefore = await captureLegacySourceRows((sql, args) => rawRows(bootstrapClient, sql, args));
    } finally {
      await bootstrapClient.close();
    }

    // Importing the production database module executes the real initializer.
    // A cache-busted second import runs the same additive migrations again.
    ({ default: database } = await import('../../src/db/index.js'));
    const secondPassUrl = new URL('../../src/db/index.js', import.meta.url);
    secondPassUrl.searchParams.set('migration-pass', 'second');
    ({ default: secondMigrationDatabase } = await import(secondPassUrl.href));
    await secondMigrationDatabase.close();
    secondMigrationDatabase = null;

    const sourceAfter = await captureLegacySourceRows((sql, args) => adapterRows(database, sql, args));
    assert.deepEqual(sourceAfter, sourceBefore);
    for (const rows of Object.values(sourceAfter)) assert.equal(rows.length, 1);

    const migratedBill = await database.prepare(
      `SELECT active, effective_from_month, effective_to_month, updated_at
         FROM emis WHERE id = ?`
    ).get(legacy.openEndedBill.id);
    assert.deepEqual(Object.fromEntries(Object.entries(migratedBill)), {
      active: 1,
      effective_from_month: null,
      effective_to_month: null,
      updated_at: null,
    });

    const migratedTrip = await database.prepare(
      `SELECT public_token, public_enabled, trip_version, updated_at
         FROM trips WHERE id = ?`
    ).get(legacy.sharedTrip.id);
    assert.deepEqual(Object.fromEntries(Object.entries(migratedTrip)), {
      public_token: legacy.sharedTrip.public_token,
      public_enabled: legacy.sharedTrip.public_enabled,
      trip_version: 0,
      updated_at: null,
    });

    const migratedTripExpense = await database.prepare(
      'SELECT split_json, created_at, updated_at FROM trip_expenses WHERE id = ?'
    ).get(legacy.malformedTripExpense.id);
    assert.deepEqual(Object.fromEntries(Object.entries(migratedTripExpense)), {
      split_json: legacy.malformedTripExpense.split_json,
      created_at: legacy.malformedTripExpense.created_at,
      updated_at: null,
    });

    const billColumns = await database.prepare('PRAGMA table_info("emis")').all();
    for (const column of ['active', 'effective_from_month', 'effective_to_month', 'updated_at']) {
      assert.equal(billColumns.filter((entry) => entry.name === column).length, 1);
    }

    for (const table of [
      'user_financial_state',
      'guided_journeys',
      'expense_category_treatments',
      'trip_expense_personal_links',
      'financial_record_changes',
      'product_measurement_events',
      'success_metric_reports',
    ]) {
      const row = await database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
      assert.equal(Number(row.count), 0, `${table} should not receive synthesized legacy rows`);
    }

    const { FinancialRepository } = await import('../../src/repositories/financialRepository.js');
    const financialRepository = new FinancialRepository(database);
    const goals = await financialRepository.loadGoals(user.id);
    assert.equal(goals.records[0].targetAmountMinor, 100_000);
    assert.equal(goals.records[0].savedAmountMinor, 125_000);
    assert.equal(goals.records[0].targetDate, null);
    assert.equal(goals.records[0].updatedAt, legacy.overfundedGoal.updated_at);

    const tripLedger = await financialRepository.loadAccessibleTripLedger({
      userId: user.id,
      tripId: legacy.sharedTrip.id,
    });
    assert.equal(tripLedger.expenses.records[0].splitStatus, 'invalid');
    assert.equal(tripLedger.expenses.records[0].split, null);
    assert.deepEqual(tripLedger.expenses.records[0].splitIssue, {
      code: 'INVALID_STORED_SPLIT',
      field: 'split_json',
      message: 'Stored split is not a valid array.',
    });
    assert.equal(tripLedger.expenses.records[0].updatedAt, legacy.malformedTripExpense.created_at);

    const { createApp } = await import('../../src/app.js');
    const app = createApp();
    const authorization = authorizationFor(user, session);
    const exportResponse = await request(app)
      .get('/api/auth/export')
      .set('Authorization', authorization);
    assert.equal(exportResponse.status, 200);

    const exportedGoal = exportResponse.body.data.savings_goals.find(
      (goal) => goal.id === legacy.overfundedGoal.id
    );
    assert.equal(exportedGoal.target_amount, legacy.overfundedGoal.target_amount);
    assert.equal(exportedGoal.saved_amount, legacy.overfundedGoal.saved_amount);
    assert.equal(exportedGoal.target_date, null);
    assert.equal(exportedGoal.created_at, legacy.overfundedGoal.created_at);
    assert.equal(exportedGoal.updated_at, legacy.overfundedGoal.updated_at);

    const exportedTrip = exportResponse.body.data.trips_owned.find(
      (trip) => trip.id === legacy.sharedTrip.id
    );
    assert.equal(exportedTrip.public_token, legacy.sharedTrip.public_token);
    assert.equal(exportedTrip.public_enabled, legacy.sharedTrip.public_enabled);

    const exportedTripExpense = exportResponse.body.data.trip_expenses.find(
      (expense) => expense.id === legacy.malformedTripExpense.id
    );
    assert.deepEqual(exportedTripExpense, {
      ...legacy.malformedTripExpense,
      updated_at: null,
    });

    const rejectedCorrection = await request(app)
      .patch(`/api/finance/goals/${legacy.overfundedGoal.id}`)
      .set('Authorization', authorization)
      .send({ setSaved: -1 });
    assert.equal(rejectedCorrection.status, 400);
    const afterRejectedCorrection = await database.prepare(
      'SELECT target_amount, saved_amount, target_date FROM savings_goals WHERE id = ?'
    ).get(legacy.overfundedGoal.id);
    assert.deepEqual(Object.fromEntries(Object.entries(afterRejectedCorrection)), {
      target_amount: legacy.overfundedGoal.target_amount,
      saved_amount: legacy.overfundedGoal.saved_amount,
      target_date: null,
    });

    const acceptedCorrection = await request(app)
      .patch(`/api/finance/goals/${legacy.overfundedGoal.id}`)
      .set('Authorization', authorization)
      .send({ setSaved: legacy.overfundedGoal.target_amount });
    assert.equal(acceptedCorrection.status, 200);
    assert.deepEqual(acceptedCorrection.body, { ok: true });

    const correctedGoal = await database.prepare(
      'SELECT target_amount, saved_amount FROM savings_goals WHERE id = ?'
    ).get(legacy.overfundedGoal.id);
    assert.deepEqual(Object.fromEntries(Object.entries(correctedGoal)), {
      target_amount: legacy.overfundedGoal.target_amount,
      saved_amount: legacy.overfundedGoal.target_amount,
    });
  } finally {
    await secondMigrationDatabase?.close();
    await database?.close();
    const expectedPrefix = `${tmpdir()}${sep}project-money-migration-test-`;
    if (!directory.startsWith(expectedPrefix)) {
      throw new Error(`Refusing to remove unexpected test directory: ${directory}`);
    }
    await rm(directory, { recursive: true, force: true });
    restoreEnvironment(previousEnvironment);
  }
});

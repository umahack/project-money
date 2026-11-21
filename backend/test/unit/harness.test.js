import test from 'node:test';
import assert from 'node:assert/strict';
import { readDatabaseConfig } from '../../src/db/config.js';
import {
  assertIsolatedTestDatabaseEnvironment,
} from '../helpers/testDatabase.js';
import {
  FIXTURE_TIMESTAMP,
  buildFixtureGraph,
  buildUserFixture,
} from '../helpers/fixtures.js';
import {
  TEST_INSTANT,
  TEST_TIME_ZONE,
  createTestClock,
  createTestTimeContext,
} from '../helpers/time.js';

test('test database configuration refuses remote URLs and Turso credentials', () => {
  assert.throws(
    () => readDatabaseConfig({
      NODE_ENV: 'test',
      TURSO_DATABASE_URL: 'libsql://production-example.turso.io',
      TURSO_AUTH_TOKEN: 'must-not-be-used',
    }),
    /isolated file: database URL/
  );

  assert.throws(
    () => assertIsolatedTestDatabaseEnvironment({
      NODE_ENV: 'test',
      TURSO_DATABASE_URL: 'file:///tmp/project-money-test.sqlite',
      TURSO_AUTH_TOKEN: 'must-not-be-used',
    }),
    /refuses Turso authentication tokens/
  );

  assert.deepEqual(
    readDatabaseConfig({
      NODE_ENV: 'test',
      TURSO_DATABASE_URL: 'file:///tmp/project-money-test.sqlite',
      TURSO_AUTH_TOKEN: '',
    }),
    { url: 'file:///tmp/project-money-test.sqlite', authToken: undefined }
  );
});

test('test clock returns defensive Date copies and advances deterministically', () => {
  const clock = createTestClock();
  const first = clock.now();
  first.setUTCFullYear(2040);

  assert.equal(clock.now().toISOString(), TEST_INSTANT);
  assert.equal(clock.advanceBy(60_000).toISOString(), '2026-01-15T06:31:00.000Z');
  assert.equal(clock.set('2026-02-01T00:00:00.000Z').toISOString(), '2026-02-01T00:00:00.000Z');

  const context = createTestTimeContext();
  assert.equal(context.timeZone, TEST_TIME_ZONE);
  assert.equal(context.clock.now().toISOString(), TEST_INSTANT);
});

test('fixture graph is deterministic and returns independent records', () => {
  const first = buildFixtureGraph();
  const second = buildFixtureGraph();

  assert.deepEqual(first, second);
  assert.equal(first.user.created_at, FIXTURE_TIMESTAMP);
  assert.equal(first.session.user_id, first.user.id);
  assert.equal(first.financialRecords.salary.user_id, first.user.id);
  assert.equal(first.trip.trip.user_id, first.user.id);
  assert.equal(first.legacyRows.sharedTrip.public_token.length, 32);

  first.financialRecords.expenses[0].category = 'Changed only in this graph';
  assert.equal(second.financialRecords.expenses[0].category, 'Groceries');
  assert.equal(buildUserFixture({ id: 999 }).id, 999);
});

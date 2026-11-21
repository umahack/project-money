import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { createIsolatedTestDatabase } from '../helpers/testDatabase.js';

const USER_ID = 13_001;
const SESSION_ID = 13_101;
const INSTANCE_ID = '3F2B8C1E-7A4D-4E0B-9C55-0D1E2F3A4B5C';
const FIXED_NOW = new Date('2026-01-15T06:30:00.000Z');

let testDatabase;
let db;
let MeasurementService;
let MeasurementError;
let validateMeasurementEvent;
let localPeriodFor;
let measurementRepository;
let claritySettingsService;
let journeyId;

before(async () => {
  testDatabase = await createIsolatedTestDatabase();
  db = testDatabase.db;
  ({
    MeasurementService,
    MeasurementError,
    validateMeasurementEvent,
    localPeriodFor,
  } = await import('../../src/services/measurementService.js'));
  ({ default: measurementRepository } = await import('../../src/repositories/measurementRepository.js'));
  ({ default: claritySettingsService } = await import('../../src/services/claritySettings.js'));
});

beforeEach(async () => {
  await testDatabase.reset();
  await db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)')
    .run(USER_ID, 'service-user@example.test', 'Service User', 'test-password-hash');
  await db.prepare(
    'INSERT INTO sessions (id, user_id, device_label, ip_hash, user_agent) VALUES (?, ?, ?, ?, ?)'
  ).run(SESSION_ID, USER_ID, 'Service Test', 'service-test-ip-hash', 'node:test');
  const journey = await db.prepare(
    `INSERT INTO guided_journeys
      (user_id, desired_outcome, status, current_step_key, completed_step_keys,
       started_session_id, measurement_eligible, measurement_consent_version, started_at)
     VALUES (?, 'fund_goal', 'active', 'goal', '[]', ?, 1, 1, '2026-01-15 06:00:00')`
  ).run(USER_ID, SESSION_ID);
  journeyId = journey.lastInsertRowid;
});

after(async () => {
  await testDatabase?.cleanup();
});

function service(overrides = {}) {
  return new MeasurementService({ clock: () => FIXED_NOW, ...overrides });
}

function clarityEvent(overrides = {}) {
  return {
    event: 'clarity_response',
    journeyId,
    response: 'yes',
    occurredAt: '2026-01-15T06:20:00.000Z',
    ...overrides,
  };
}

async function enableAnalytics() {
  await claritySettingsService.updateSettings({
    userId: USER_ID,
    patch: { acknowledgedNoticeVersion: 1, analyticsEnabled: true },
  });
}

async function storedEvents() {
  return db.prepare('SELECT * FROM product_measurement_events ORDER BY id').all();
}

test('validator returns only schema fields and normalizes the instance identifier case', () => {
  const normalized = validateMeasurementEvent({
    event: 'recommended_action_completed',
    journeyId: 5,
    recommendationInstanceId: INSTANCE_ID,
    actionKey: 'settle_trip_balance',
    occurredAt: '2026-01-15T06:30:00Z',
  });
  assert.deepEqual(normalized, {
    event: 'recommended_action_completed',
    journeyId: 5,
    recommendationInstanceId: INSTANCE_ID.toLowerCase(),
    actionKey: 'settle_trip_balance',
    occurredAt: '2026-01-15T06:30:00Z',
  });
});

test('validator distinguishes unknown, nested, missing, and invalid fields without echoing values', () => {
  const attempt = (input) => {
    try {
      validateMeasurementEvent(input);
    } catch (error) {
      assert.ok(error instanceof MeasurementError);
      assert.equal(error.httpStatus, 400);
      assert.equal(JSON.stringify([error.message, error.field]).includes('secret@example.test'), false);
      return error;
    }
    assert.fail('expected a rejection');
  };

  assert.equal(attempt(null).code, 'INVALID_EVENT');
  assert.equal(attempt([]).code, 'INVALID_EVENT');
  assert.equal(attempt({ event: 'toString' }).code, 'UNKNOWN_EVENT');
  assert.equal(attempt(clarityEvent({ 'secret@example.test': 1 })).code, 'UNKNOWN_EVENT_FIELD');
  assert.equal(attempt(clarityEvent({ response: { value: 'yes' } })).code, 'NESTED_EVENT_FIELD');
  assert.equal(attempt(clarityEvent({ response: ['yes'] })).code, 'NESTED_EVENT_FIELD');
  assert.equal(attempt(clarityEvent({ response: 'YES' })).code, 'INVALID_EVENT_FIELD');
  assert.equal(attempt(clarityEvent({ journeyId: 0 })).code, 'INVALID_EVENT_FIELD');
  const { occurredAt: _omitted, ...withoutTime } = clarityEvent();
  const missing = attempt(withoutTime);
  assert.equal(missing.code, 'MISSING_EVENT_FIELD');
  assert.equal(missing.field, 'occurredAt');
});

test('local period uses the configured Asia/Kolkata zone with Monday week starts', () => {
  assert.deepEqual(localPeriodFor('2026-01-11T18:29:59.999Z'), {
    localDate: '2026-01-11',
    localWeekStart: '2026-01-05',
  });
  assert.deepEqual(localPeriodFor('2026-01-11T18:30:00.000Z'), {
    localDate: '2026-01-12',
    localWeekStart: '2026-01-12',
  });
  assert.deepEqual(localPeriodFor('2026-01-15T06:30:00.000Z'), {
    localDate: '2026-01-15',
    localWeekStart: '2026-01-12',
  });
});

test('service stores a consented event with server fields and returns a no-op when disabled', async () => {
  const subject = service();
  assert.deepEqual(
    await subject.ingest({ userId: USER_ID, sessionId: SESSION_ID, input: clarityEvent() }),
    { recorded: false, reason: 'analytics_disabled' }
  );
  assert.equal((await storedEvents()).length, 0);

  await enableAnalytics();
  assert.deepEqual(
    await subject.ingest({ userId: USER_ID, sessionId: SESSION_ID, input: clarityEvent() }),
    { recorded: true, reason: 'recorded' }
  );
  const [row] = await storedEvents();
  assert.equal(Number(row.user_id), USER_ID);
  assert.equal(Number(row.consent_version), 1);
  assert.equal(row.received_at, '2026-01-15T06:30:00.000Z');
  assert.equal(row.occurred_at, '2026-01-15T06:20:00.000Z');
  assert.equal(row.local_date, '2026-01-15');
  assert.equal(row.local_week_start, '2026-01-12');
});

test('receipt-time consent wins when opt-out lands between the consent read and the insert', async () => {
  await enableAnalytics();
  const racingConsent = {
    async getAnalyticsConsent(args) {
      const consent = await claritySettingsService.getAnalyticsConsent(args);
      // The user opts out after this read reports enabled and before the insert.
      await measurementRepository.setAnalyticsConsent({ userId: args.userId, enabled: false });
      return consent;
    },
  };
  const result = await service({ consent: racingConsent }).ingest({
    userId: USER_ID,
    sessionId: SESSION_ID,
    input: clarityEvent(),
  });
  assert.deepEqual(result, { recorded: false, reason: 'not_recorded' });
  assert.equal((await storedEvents()).length, 0);
});

test('a deleted or unknown account is a no-op rather than an error', async () => {
  const result = await service().ingest({
    userId: 999_999,
    sessionId: SESSION_ID,
    input: clarityEvent(),
  });
  assert.deepEqual(result, { recorded: false, reason: 'analytics_disabled' });
  assert.equal((await storedEvents()).length, 0);
});

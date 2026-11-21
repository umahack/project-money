import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createIsolatedTestDatabase } from '../helpers/testDatabase.js';
import { buildSessionFixture, buildUserFixture } from '../helpers/fixtures.js';

const OWNER_ID = 12_001;
const OTHER_USER_ID = 12_002;
const OWNER_SESSION_ID = 12_101;
const OWNER_SECOND_SESSION_ID = 12_102;
const OTHER_SESSION_ID = 12_103;
const INSTANCE_ID = '3f2b8c1e-7a4d-4e0b-9c55-0d1e2f3a4b5c';

let testDatabase;
let db;
let app;
let ownerAuthorization;
let ownerSecondAuthorization;
let otherAuthorization;
let ownerJourneyId;
let otherJourneyId;
let ownerChangeId;
let otherChangeId;

function tokenFor(user, session) {
  return `Bearer ${jwt.sign(
    { sub: String(user.id), tv: user.token_version, sid: session.id },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '5m' }
  )}`;
}

async function insertAccount(user, sessions) {
  await db.prepare(
    `INSERT INTO users (id, email, name, password_hash, is_admin, token_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(user.id, user.email, user.name, user.password_hash, user.is_admin, user.token_version, user.created_at);
  for (const session of sessions) {
    await db.prepare(
      `INSERT INTO sessions
        (id, user_id, device_label, ip_hash, user_agent, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      session.id,
      session.user_id,
      session.device_label,
      session.ip_hash,
      session.user_agent,
      session.created_at,
      session.last_seen_at
    );
  }
}

async function insertJourney(userId, sessionId, desiredOutcome = 'plan_month') {
  const result = await db.prepare(
    `INSERT INTO guided_journeys
      (user_id, desired_outcome, status, current_step_key, completed_step_keys,
       started_session_id, measurement_eligible, measurement_consent_version, started_at)
     VALUES (?, ?, 'active', 'salary', '[]', ?, 1, 1, '2020-01-01 00:00:00')`
  ).run(userId, desiredOutcome, sessionId);
  return result.lastInsertRowid;
}

async function insertChange(userId, key) {
  const result = await db.prepare(
    `INSERT INTO financial_record_changes
      (user_id, idempotency_key, request_fingerprint_hmac, operation, record_type,
       record_id, record_version, status, occurred_at)
     VALUES (?, ?, 'test-hmac', 'create', 'salary', 1, 1, 'confirmed', '2020-01-01 00:00:00')`
  ).run(userId, key);
  return result.lastInsertRowid;
}

async function setAnalytics(enabled) {
  const body = enabled
    ? { acknowledgedNoticeVersion: 1, analyticsEnabled: true }
    : { analyticsEnabled: false };
  const response = await request(app)
    .patch('/api/clarity/settings')
    .set('Authorization', ownerAuthorization)
    .send(body);
  assert.equal(response.status, 200);
}

function postEvent(body, authorization = ownerAuthorization) {
  return request(app)
    .post('/api/clarity/events')
    .set('Authorization', authorization)
    .send(body);
}

async function countEvents(userId = OWNER_ID) {
  const row = await db.prepare(
    'SELECT COUNT(*) AS count FROM product_measurement_events WHERE user_id = ?'
  ).get(userId);
  return Number(row.count);
}

async function countAllEvents() {
  const row = await db.prepare('SELECT COUNT(*) AS count FROM product_measurement_events').get();
  return Number(row.count);
}

function validEvents() {
  const occurredAt = new Date().toISOString();
  return {
    journey_started: {
      event: 'journey_started',
      journeyId: ownerJourneyId,
      desiredOutcome: 'plan_month',
      occurredAt,
    },
    first_outcome_displayed: {
      event: 'first_outcome_displayed',
      journeyId: ownerJourneyId,
      outcomeKind: 'monthly_plan',
      occurredAt,
    },
    clarity_response: {
      event: 'clarity_response',
      journeyId: ownerJourneyId,
      response: 'partly',
      occurredAt,
    },
    recommended_action_completed: {
      event: 'recommended_action_completed',
      journeyId: ownerJourneyId,
      recommendationInstanceId: INSTANCE_ID,
      actionKey: 'contribute_to_goal',
      occurredAt,
    },
    financial_change_ui: {
      event: 'financial_change_ui',
      changeId: ownerChangeId,
      causedReload: false,
      causedPageWideLoading: true,
      occurredAt,
    },
  };
}

before(async () => {
  testDatabase = await createIsolatedTestDatabase();
  db = testDatabase.db;
  process.env.FINANCIAL_MUTATION_HMAC_KEY =
    'test-only-measurement-events-hmac-key-32-bytes-minimum';
  const { createApp } = await import('../../src/app.js');
  app = createApp();
});

beforeEach(async () => {
  await testDatabase.reset();
  const owner = buildUserFixture({ id: OWNER_ID, email: 'events-owner@example.test' });
  const other = buildUserFixture({ id: OTHER_USER_ID, email: 'events-other@example.test' });
  const ownerSession = buildSessionFixture({ id: OWNER_SESSION_ID, userId: OWNER_ID });
  const ownerSecondSession = buildSessionFixture({ id: OWNER_SECOND_SESSION_ID, userId: OWNER_ID });
  const otherSession = buildSessionFixture({ id: OTHER_SESSION_ID, userId: OTHER_USER_ID });
  await insertAccount(owner, [ownerSession, ownerSecondSession]);
  await insertAccount(other, [otherSession]);

  ownerAuthorization = tokenFor(owner, ownerSession);
  ownerSecondAuthorization = tokenFor(owner, ownerSecondSession);
  otherAuthorization = tokenFor(other, otherSession);

  ownerJourneyId = await insertJourney(OWNER_ID, OWNER_SESSION_ID);
  otherJourneyId = await insertJourney(OTHER_USER_ID, OTHER_SESSION_ID);
  ownerChangeId = await insertChange(OWNER_ID, 'owner-change-1');
  otherChangeId = await insertChange(OTHER_USER_ID, 'other-change-1');
});

afterEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
});

after(async () => {
  await testDatabase?.cleanup();
});

test('event ingestion requires a live authenticated session and stores nothing otherwise', async () => {
  await setAnalytics(true);
  const missing = await request(app).post('/api/clarity/events').send(validEvents().clarity_response);
  assert.equal(missing.status, 401);

  const invalid = await request(app)
    .post('/api/clarity/events')
    .set('Authorization', 'Bearer not-a-token')
    .send(validEvents().clarity_response);
  assert.equal(invalid.status, 401);

  await db.prepare('UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP, revoked_reason = ? WHERE id = ?')
    .run('logout', OWNER_SESSION_ID);
  const revoked = await postEvent(validEvents().clarity_response);
  assert.equal(revoked.status, 401);
  assert.equal(revoked.body.code, 'SESSION_REVOKED');

  assert.equal(await countAllEvents(), 0);
});

test('each closed event stores only fixed fields and server-supplied user, consent, receipt, and local-period values', async () => {
  await setAnalytics(true);
  const events = validEvents();
  for (const body of Object.values(events)) {
    const response = await postEvent(body);
    assert.equal(response.status, 204, `${body.event}: ${JSON.stringify(response.body)}`);
  }

  const rows = await db.prepare(
    'SELECT * FROM product_measurement_events WHERE user_id = ? ORDER BY id'
  ).all(OWNER_ID);
  assert.deepEqual(
    rows.map((row) => row.event_name),
    Object.keys(events)
  );

  const byName = Object.fromEntries(rows.map((row) => [row.event_name, row]));
  assert.equal(Number(byName.journey_started.journey_id), ownerJourneyId);
  assert.equal(byName.journey_started.desired_outcome, 'plan_month');
  assert.equal(byName.first_outcome_displayed.outcome_kind, 'monthly_plan');
  assert.equal(byName.clarity_response.response, 'partly');
  assert.equal(byName.recommended_action_completed.action_key, 'contribute_to_goal');
  assert.equal(byName.recommended_action_completed.recommendation_instance_id, INSTANCE_ID);
  assert.equal(Number(byName.financial_change_ui.change_id), ownerChangeId);
  assert.equal(Number(byName.financial_change_ui.caused_reload), 0);
  assert.equal(Number(byName.financial_change_ui.caused_page_wide_loading), 1);
  assert.equal(byName.clarity_response.change_id, null);
  assert.equal(byName.financial_change_ui.journey_id, null);

  for (const row of rows) {
    assert.equal(Number(row.user_id), OWNER_ID);
    assert.equal(Number(row.consent_version), 1);
    assert.match(row.received_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.match(row.occurred_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.ok(row.occurred_at <= row.received_at, 'occurred_at is bounded by receipt time');
    assert.match(row.local_date, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(row.local_week_start, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(row.local_week_start <= row.local_date);
  }
});

test('client timestamps are bounded to the window between the associated record and receipt', async () => {
  await setAnalytics(true);
  const before = await postEvent({
    ...validEvents().clarity_response,
    occurredAt: '1999-01-01T00:00:00.000Z',
  });
  const future = await postEvent({
    ...validEvents().recommended_action_completed,
    occurredAt: '2999-01-01T00:00:00.000Z',
  });
  assert.equal(before.status, 204);
  assert.equal(future.status, 204);

  const early = await db.prepare(
    "SELECT occurred_at, received_at FROM product_measurement_events WHERE event_name = 'clarity_response'"
  ).get();
  assert.equal(early.occurred_at, '2020-01-01T00:00:00.000Z', 'clamped to the journey start');
  const late = await db.prepare(
    "SELECT occurred_at, received_at FROM product_measurement_events WHERE event_name = 'recommended_action_completed'"
  ).get();
  assert.equal(late.occurred_at, late.received_at, 'future time clamps to receipt');
});

test('repeating one logical event does not create a second row', async () => {
  await setAnalytics(true);
  const body = validEvents().first_outcome_displayed;
  assert.equal((await postEvent(body)).status, 204);
  assert.equal((await postEvent(body)).status, 204);
  assert.equal(await countEvents(), 1);
});

const REJECTED_BODIES = [
  ['unknown event name', () => ({ event: 'page_viewed', journeyId: 1, occurredAt: new Date().toISOString() })],
  ['missing event name', () => ({ journeyId: 1 })],
  ['inherited event name', () => ({ event: 'constructor' })],
  ['extra amount field', (e) => ({ ...e.clarity_response, amount: 1500 })],
  ['extra amountMinor field', (e) => ({ ...e.financial_change_ui, amountMinor: 150000 })],
  ['extra name field', (e) => ({ ...e.clarity_response, goalName: 'Emergency fund' })],
  ['extra note field', (e) => ({ ...e.clarity_response, note: 'free text' })],
  ['extra email field', (e) => ({ ...e.first_outcome_displayed, email: 'person@example.test' })],
  ['extra trip field', (e) => ({ ...e.clarity_response, tripName: 'Goa', memberName: 'Asha' })],
  ['extra url field', (e) => ({ ...e.clarity_response, url: '/plan?salary=50000' })],
  ['client user id', (e) => ({ ...e.clarity_response, userId: 1 })],
  ['client consent version', (e) => ({ ...e.clarity_response, consentVersion: 1 })],
  ['client receipt time', (e) => ({ ...e.clarity_response, receivedAt: '2020-01-01T00:00:00.000Z' })],
  ['client local date', (e) => ({ ...e.clarity_response, localDate: '2020-01-01' })],
  ['client session', (e) => ({ ...e.clarity_response, sessionId: 1 })],
  ['nested object field', (e) => ({ ...e.clarity_response, response: { value: 'yes' } })],
  ['nested extra object', (e) => ({ ...e.clarity_response, meta: { amount: 1 } })],
  ['array field', (e) => ({ ...e.clarity_response, journeyId: [1] })],
  ['null field', (e) => ({ ...e.clarity_response, response: null })],
  ['value-like enum text', (e) => ({ ...e.clarity_response, response: '₹1,500.50' })],
  ['value-like outcome kind', (e) => ({ ...e.first_outcome_displayed, outcomeKind: 'Emergency fund' })],
  ['raw path as action key', (e) => ({ ...e.recommended_action_completed, actionKey: '/goals?amount=5' })],
  ['name as instance id', (e) => ({ ...e.recommended_action_completed, recommendationInstanceId: 'Asha Kumar' })],
  ['string journey id', (e) => ({ ...e.clarity_response, journeyId: String(e.clarity_response.journeyId) })],
  ['fractional journey id', (e) => ({ ...e.clarity_response, journeyId: 1.5 })],
  ['negative change id', (e) => ({ ...e.financial_change_ui, changeId: -1 })],
  ['string boolean', (e) => ({ ...e.financial_change_ui, causedReload: 'false' })],
  ['numeric boolean', (e) => ({ ...e.financial_change_ui, causedPageWideLoading: 1 })],
  ['missing field', (e) => {
    const { response: _response, ...rest } = e.clarity_response;
    return rest;
  }],
  ['non-ISO timestamp', (e) => ({ ...e.clarity_response, occurredAt: 'yesterday' })],
  ['timestamp with offset', (e) => ({ ...e.clarity_response, occurredAt: '2026-01-15T06:30:00+05:30' })],
  ['array body', () => [1, 2, 3]],
  ['string body', () => 'clarity_response'],
];

test('unknown, extra, nested, value-like, and wrongly typed fields are rejected before storage', async () => {
  await setAnalytics(true);
  for (const [label, build] of REJECTED_BODIES) {
    const response = await request(app)
      .post('/api/clarity/events')
      .set('Authorization', ownerAuthorization)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(build(validEvents())));
    assert.ok(
      response.status === 400,
      `${label} should be rejected, got ${response.status}`
    );
  }
  assert.equal(await countAllEvents(), 0);
});

test('prototype-like keys sent as raw JSON are rejected and rejection details do not echo client text', async () => {
  await setAnalytics(true);
  const raw = `{"event":"clarity_response","journeyId":${ownerJourneyId},"response":"yes",`
    + `"occurredAt":"${new Date().toISOString()}","__proto__":{"amount":1}}`;
  const response = await request(app)
    .post('/api/clarity/events')
    .set('Authorization', ownerAuthorization)
    .set('Content-Type', 'application/json')
    .send(raw);
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'UNKNOWN_EVENT_FIELD');
  assert.equal(response.body.error.field, undefined);

  const secret = await postEvent({ ...validEvents().clarity_response, 'person@example.test': 'x' });
  assert.equal(secret.status, 400);
  assert.equal(JSON.stringify(secret.body).includes('person@example.test'), false);
  assert.equal(await countAllEvents(), 0);
});

test('events cannot reference another user’s journey or change receipt', async () => {
  await setAnalytics(true);
  const foreignJourney = await postEvent({ ...validEvents().clarity_response, journeyId: otherJourneyId });
  assert.equal(foreignJourney.status, 404);
  assert.equal(foreignJourney.body.error.code, 'MEASUREMENT_REFERENCE_NOT_FOUND');

  const foreignChange = await postEvent({ ...validEvents().financial_change_ui, changeId: otherChangeId });
  assert.equal(foreignChange.status, 404);

  const unknownJourney = await postEvent({ ...validEvents().clarity_response, journeyId: 999_999 });
  assert.equal(unknownJourney.status, 404);
  assert.deepEqual(unknownJourney.body, foreignJourney.body, 'foreign and unknown references look alike');

  const mismatch = await postEvent({ ...validEvents().journey_started, desiredOutcome: 'settle_trip' });
  assert.equal(mismatch.status, 422);
  assert.equal(mismatch.body.error.code, 'MEASUREMENT_REFERENCE_MISMATCH');

  assert.equal(await countAllEvents(), 0);
});

test('start and first-outcome events count only from the session that started the journey', async () => {
  await setAnalytics(true);
  const otherSession = await postEvent(validEvents().first_outcome_displayed, ownerSecondAuthorization);
  assert.equal(otherSession.status, 204);
  const otherSessionStart = await postEvent(validEvents().journey_started, ownerSecondAuthorization);
  assert.equal(otherSessionStart.status, 204);
  assert.equal(await countEvents(), 0, 'a resumed session does not record start or first outcome');

  const response = await postEvent(validEvents().clarity_response, ownerSecondAuthorization);
  assert.equal(response.status, 204);
  assert.equal(await countEvents(), 1, 'a later clarity response is not session-bound');
});

test('disabled analytics is a 204 no-op, including for references that would be unauthorized', async () => {
  for (const body of Object.values(validEvents())) {
    const response = await postEvent(body);
    assert.equal(response.status, 204);
    assert.equal(response.text, '');
  }
  const foreign = await postEvent({ ...validEvents().clarity_response, journeyId: otherJourneyId });
  assert.equal(foreign.status, 204, 'disabled analytics does not reveal reference ownership');
  assert.equal(await countAllEvents(), 0);

  const state = await db.prepare('SELECT COUNT(*) AS count FROM user_financial_state').get();
  assert.equal(Number(state.count), 0, 'ingestion never creates consent state');
});

test('one user’s consent does not enable events for another user', async () => {
  await setAnalytics(true);
  const response = await postEvent(
    {
      event: 'clarity_response',
      journeyId: otherJourneyId,
      response: 'yes',
      occurredAt: new Date().toISOString(),
    },
    otherAuthorization
  );
  assert.equal(response.status, 204);
  assert.equal(await countEvents(OTHER_USER_ID), 0);
});

test('retries after opt-out are dropped while financial and journey records stay unchanged', async () => {
  await setAnalytics(true);
  await db.prepare('INSERT INTO salary_entries (user_id, month, amount) VALUES (?, ?, ?)')
    .run(OWNER_ID, '2026-01', 80_000);
  assert.equal((await postEvent(validEvents().clarity_response)).status, 204);
  assert.equal(await countEvents(), 1);

  await setAnalytics(false);
  const queuedRetry = await postEvent(validEvents().recommended_action_completed);
  assert.equal(queuedRetry.status, 204);
  const repeat = await postEvent(validEvents().clarity_response);
  assert.equal(repeat.status, 204);
  assert.equal(await countEvents(), 1, 'no event is added after opt-out');

  const salary = await db.prepare('SELECT amount FROM salary_entries WHERE user_id = ?').get(OWNER_ID);
  assert.equal(Number(salary.amount), 80_000);
  const journey = await db.prepare('SELECT status, completed_step_keys FROM guided_journeys WHERE id = ?')
    .get(ownerJourneyId);
  assert.equal(journey.status, 'active');
  assert.equal(journey.completed_step_keys, '[]');

  await setAnalytics(true);
  assert.equal((await postEvent(validEvents().recommended_action_completed)).status, 204);
  assert.equal(await countEvents(), 2, 're-enabling accepts new events');
});

test('visits store only fixed route keys for consenting authenticated users', async () => {
  const track = (body, authorization) => {
    const req = request(app).post('/api/track');
    if (authorization) req.set('Authorization', authorization);
    return req.send(body);
  };
  const storedPaths = async () => (await db.prepare('SELECT user_id, path FROM visits ORDER BY id').all())
    .map((row) => [row.user_id == null ? null : Number(row.user_id), row.path]);

  // Not consented yet: signed-in visits are not stored at all.
  assert.equal((await track({ route: 'plan' }, ownerAuthorization)).status, 204);
  assert.deepEqual(await storedPaths(), []);

  await setAnalytics(true);
  assert.equal((await track({ route: 'plan' }, ownerAuthorization)).status, 204);
  assert.equal(
    (await track({ path: '/trips/42?email=person@example.test&amount=5000' }, ownerAuthorization)).status,
    204
  );
  assert.equal((await track({ path: '/spending' }, ownerAuthorization)).status, 204);
  assert.deepEqual(await storedPaths(), [
    [OWNER_ID, 'plan'],
    [OWNER_ID, 'other'],
    [OWNER_ID, 'spending'],
  ]);

  // Another consent-less user is still not stored.
  assert.equal((await track({ route: 'goals' }, otherAuthorization)).status, 204);
  assert.equal((await storedPaths()).length, 3);

  await setAnalytics(false);
  assert.equal((await track({ route: 'home' }, ownerAuthorization)).status, 204);
  assert.equal((await storedPaths()).length, 3, 'no visit is stored after opt-out');
});

test('anonymous visits accept only fixed public routes and never private routes', async () => {
  assert.equal((await request(app).post('/api/track').send({ route: 'login' })).status, 204);
  assert.equal((await request(app).post('/api/track').send({ path: '/share/trip/*' })).status, 204);
  assert.equal((await request(app).post('/api/track').send({ route: 'plan' })).status, 204);
  assert.equal((await request(app).post('/api/track').send({ path: '/' })).status, 204);
  assert.equal(
    (await request(app)
      .post('/api/track')
      .set('Authorization', 'Bearer not-a-token')
      .send({ route: 'goals' })).status,
    204
  );

  const rows = await db.prepare('SELECT user_id, path FROM visits ORDER BY id').all();
  assert.deepEqual(rows.map((row) => [row.user_id, row.path]), [
    [null, 'login'],
    [null, 'public_trip_share'],
  ]);
});

test('visit bodies outside the fixed route contract are rejected without storage', async () => {
  await setAnalytics(true);
  const bodies = [
    {},
    { route: '/plan' },
    { route: 'unknown_route' },
    { route: { name: 'plan' } },
    { route: ['plan'] },
    { route: 'plan', path: '/plan' },
    { route: 'plan', email: 'person@example.test' },
    { path: '' },
    { path: 'x'.repeat(201) },
    { path: ['/plan'] },
    { other: 'plan' },
  ];
  for (const body of bodies) {
    const response = await request(app)
      .post('/api/track')
      .set('Authorization', ownerAuthorization)
      .send(body);
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  const array = await request(app)
    .post('/api/track')
    .set('Authorization', ownerAuthorization)
    .send(['plan']);
  assert.equal(array.status, 400);
  const count = await db.prepare('SELECT COUNT(*) AS count FROM visits').get();
  assert.equal(Number(count.count), 0);
});

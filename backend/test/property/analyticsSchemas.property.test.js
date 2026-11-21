import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createIsolatedTestDatabase } from '../helpers/testDatabase.js';
import { buildSessionFixture, buildUserFixture } from '../helpers/fixtures.js';

const NUM_RUNS = 200;
const ID_BASE = 9_100_000;
const OTHER_ID = ID_BASE - 1;
const UNKNOWN_REFERENCE_ID = 900_000_000;
const MARKER_PREFIX = 'PBTSENS';
const JOURNEY_OUTCOME = 'plan_month';

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const UUID_LOWER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EVENT_ID = /^[a-z_]+:\d+:\d+(?::[0-9a-f-]{36})?$/;

// Every column the measurement tables may ever hold. A new free-text column
// would fail the shape check below.
const EVENT_COLUMNS = [
  'action_key', 'caused_page_wide_loading', 'caused_reload', 'change_id', 'consent_version',
  'desired_outcome', 'event_id', 'event_name', 'id', 'journey_id', 'local_date',
  'local_week_start', 'occurred_at', 'outcome_kind', 'received_at',
  'recommendation_instance_id', 'response', 'user_id',
];
const VISIT_COLUMNS = ['created_at', 'id', 'ip_hash', 'path', 'user_agent', 'user_id'];

// Tables ingestion must leave untouched when an event or visit is rejected.
const GUARDED_TABLES = [
  'product_measurement_events',
  'visits',
  'guided_journeys',
  'financial_record_changes',
  'user_financial_state',
];

const SPECIAL_KEYS = [
  '__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', 'valueOf',
  'userId', 'user_id', 'email', 'amount', 'amountMinor', 'goalName', 'note', 'url',
  'sessionId', 'consentVersion', 'receivedAt', 'localDate', 'localWeekStart', 'data',
  'meta', 'properties', 'journey_id', 'Event', 'EVENT', ' event', 'event ', '',
  'データ', '💸', 'a.b', '$where', 'x\u0000y', 'ключ', 'ｅｖｅｎｔ',
];

let testDatabase;
let db;
let app;
let measurementRepository;
let service;
let visits;
let sequence = 0;
const scenarioCounts = {};

// ---------------------------------------------------------------- generators

const prefixArbitrary = fc.oneof(
  fc.string({ unit: 'binary', maxLength: 16 }),
  fc.constantFrom('₹', '/plan?salary=', 'person@', '/trips/42?email=', '../../', '日本語', '__proto__', '<script>')
);
const suffixArbitrary = fc.oneof(fc.string({ unit: 'binary', maxLength: 16 }), fc.constantFrom('', '.50', '@example.test', '%00'));
const badNumberArbitrary = fc.oneof(
  fc.integer({ min: -1000, max: 0 }),
  fc.double({ noNaN: true, noDefaultInfinity: true }).filter((value) => !Number.isInteger(value)),
  fc.constantFrom(2 ** 53, 1e21, -1e21)
);

// Every kind materializes to a value that no closed field accepts: it contains
// the per-case marker, is not an exact enum/UUID/instant/boolean, or is a
// non-positive/fractional/unsafe number.
const hostileArbitrary = fc.oneof(
  fc.record({ kind: fc.constant('marked'), prefix: prefixArbitrary, suffix: suffixArbitrary }),
  fc.record({ kind: fc.constant('nested'), json: fc.jsonValue({ maxDepth: 2 }) }),
  fc.record({ kind: fc.constant('array'), json: fc.jsonValue({ maxDepth: 2 }) }),
  fc.record({ kind: fc.constant('badNumber'), n: badNumberArbitrary }),
  fc.record({ kind: fc.constant('null') }),
  fc.record({ kind: fc.constant('boolText'), b: fc.boolean() }),
  fc.record({ kind: fc.constant('idString'), pad: fc.boolean() }),
  fc.record({ kind: fc.constant('offset'), hours: fc.integer({ min: 0, max: 14 }) }),
  fc.record({ kind: fc.constant('rupee'), n: fc.integer({ min: 0, max: 9_999_999 }) }),
  fc.record({ kind: fc.constant('padded') }),
  fc.record({ kind: fc.constant('empty') })
);
const nonStringHostileArbitrary = fc.oneof(
  fc.record({ kind: fc.constant('nested'), json: fc.jsonValue({ maxDepth: 2 }) }),
  fc.record({ kind: fc.constant('array'), json: fc.jsonValue({ maxDepth: 2 }) }),
  fc.record({ kind: fc.constant('badNumber'), n: badNumberArbitrary }),
  fc.record({ kind: fc.constant('null') })
);

const keyArbitrary = fc.oneof(
  fc.record({ kind: fc.constant('special'), key: fc.constantFrom(...SPECIAL_KEYS) }),
  fc.record({ kind: fc.constant('marked'), prefix: fc.string({ unit: 'binary', maxLength: 8 }) }),
  fc.record({ kind: fc.constant('unicode'), key: fc.string({ unit: 'grapheme', minLength: 1, maxLength: 12 }) })
);

const baseArbitrary = fc.record({
  event: fc.constantFrom(
    'journey_started',
    'first_outcome_displayed',
    'clarity_response',
    'recommended_action_completed',
    'financial_change_ui'
  ),
  occurredMs: fc.integer({ min: 946_684_800_000, max: 4_102_444_800_000 }),
  outcomeKind: fc.integer({ min: 0, max: 4 }),
  response: fc.integer({ min: 0, max: 2 }),
  actionKey: fc.integer({ min: 0, max: 5 }),
  instanceId: fc.uuid(),
  causedReload: fc.boolean(),
  causedPageWideLoading: fc.boolean(),
});

const bodyArbitrary = fc.oneof(
  fc.record({ kind: fc.constant('array'), json: fc.jsonValue({ maxDepth: 2 }) }),
  fc.record({ kind: fc.constant('string'), prefix: prefixArbitrary }),
  fc.record({ kind: fc.constant('number'), n: fc.integer() }),
  fc.record({ kind: fc.constant('null') }),
  fc.record({ kind: fc.constant('boolean'), b: fc.boolean() })
);

const visitRejectedArbitrary = fc.oneof(
  fc.record({ variant: fc.constant('extraWithRoute'), key: keyArbitrary, hostile: hostileArbitrary, routeIndex: fc.nat() }),
  fc.record({ variant: fc.constant('extraWithPath'), key: keyArbitrary, hostile: hostileArbitrary }),
  fc.record({ variant: fc.constant('routeAndPath'), routeIndex: fc.nat() }),
  fc.record({ variant: fc.constant('badRoute'), hostile: hostileArbitrary }),
  fc.record({ variant: fc.constant('badPathType'), hostile: nonStringHostileArbitrary }),
  fc.record({ variant: fc.constant('emptyPath') }),
  fc.record({ variant: fc.constant('longPath'), extra: fc.integer({ min: 1, max: 200 }) }),
  fc.record({ variant: fc.constant('unknownKey'), key: keyArbitrary, hostile: hostileArbitrary }),
  fc.record({ variant: fc.constant('emptyObject') }),
  fc.record({ variant: fc.constant('arrayBody'), json: fc.jsonValue({ maxDepth: 2 }) })
);

const scenarioArbitrary = fc.oneof(
  fc.record({ scenario: fc.constant('accepted'), base: baseArbitrary }),
  fc.record({ scenario: fc.constant('extraField'), base: baseArbitrary, key: keyArbitrary, hostile: hostileArbitrary }),
  fc.record({ scenario: fc.constant('badValue'), base: baseArbitrary, pick: fc.nat(), hostile: hostileArbitrary }),
  fc.record({
    scenario: fc.constant('unknownEvent'),
    base: baseArbitrary,
    name: fc.oneof(
      fc.constantFrom('__proto__', 'constructor', 'toString', 'hasOwnProperty', 'page_viewed', 'JOURNEY_STARTED', ''),
      fc.string({ unit: 'binary', maxLength: 12 })
    ),
    withMarker: fc.boolean(),
  }),
  fc.record({ scenario: fc.constant('missingField'), base: baseArbitrary, pick: fc.nat() }),
  fc.record({
    scenario: fc.constant('badReference'),
    base: baseArbitrary,
    reference: fc.constantFrom('foreign', 'unknown', 'mismatch'),
  }),
  fc.record({ scenario: fc.constant('badBody'), body: bodyArbitrary }),
  fc.record({
    scenario: fc.constant('unauthenticated'),
    base: baseArbitrary,
    mode: fc.constantFrom('none', 'garbage', 'forged'),
  }),
  fc.record({ scenario: fc.constant('visitRejected'), visit: visitRejectedArbitrary }),
  fc.record({
    scenario: fc.constant('visitAccepted'),
    actor: fc.constantFrom('owner', 'anonymous', 'forgedToken'),
    form: fc.constantFrom('hostilePath', 'route'),
    prefix: prefixArbitrary,
    suffix: suffixArbitrary,
    routeIndex: fc.nat(),
  })
);

// ------------------------------------------------------------------- helpers

function plain(rows) {
  return JSON.parse(JSON.stringify(rows, (_key, value) => (
    typeof value === 'bigint' ? Number(value) : value
  )));
}

async function snapshot() {
  const result = {};
  for (const table of GUARDED_TABLES) {
    result[table] = plain(await db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());
  }
  return result;
}

async function snapshotTables(tables) {
  const result = {};
  for (const table of tables) {
    result[table] = JSON.stringify(plain(await db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()));
  }
  return result;
}

function pickFrom(list, index) {
  return list[index % list.length];
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function materialize(hostile, { marker, current, realId }) {
  switch (hostile.kind) {
    case 'marked': return `${hostile.prefix}${marker}${hostile.suffix}`;
    case 'nested': return { [marker]: hostile.json, value: marker };
    case 'array': return [marker, hostile.json];
    case 'badNumber': return hostile.n;
    case 'null': return null;
    case 'boolText': return String(hostile.b);
    case 'idString': return `${hostile.pad ? ' ' : ''}${realId}`;
    case 'offset': return `2026-01-15T06:30:00+${pad2(hostile.hours)}:30`;
    case 'rupee': return `₹${hostile.n}.50`;
    case 'padded': return ` ${current}`;
    case 'empty': return '';
    default: throw new Error(`Unknown hostile kind ${hostile.kind}`);
  }
}

function materializeKey(key, marker, forbidden) {
  const candidate = key.kind === 'marked' ? `${key.prefix}${marker}` : key.key;
  // A generated key must never collide with a field the schema accepts.
  return forbidden.includes(candidate) ? `${candidate}${marker}` : candidate;
}

// Object.fromEntries defines own data properties, so '__proto__' stays an
// ordinary JSON key instead of replacing the prototype.
function jsonBody(entries) {
  return JSON.stringify(Object.fromEntries(entries));
}

function authFor(userId, sessionId, secret = process.env.JWT_SECRET) {
  return `Bearer ${jwt.sign(
    { sub: String(userId), tv: 1, sid: sessionId },
    secret,
    { algorithm: 'HS256', expiresIn: '5m' }
  )}`;
}

async function insertAccount({ userId, email }) {
  await db.prepare(
    `INSERT INTO users (id, email, name, password_hash, is_admin, token_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    ...(() => {
      const user = buildUserFixture({ id: userId, email });
      return [user.id, user.email, user.name, user.password_hash, user.is_admin, user.token_version, user.created_at];
    })()
  );
  const session = buildSessionFixture({ id: userId, userId });
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
  const journey = await db.prepare(
    `INSERT INTO guided_journeys
      (user_id, desired_outcome, status, current_step_key, completed_step_keys,
       started_session_id, measurement_eligible, measurement_consent_version, started_at)
     VALUES (?, ?, 'active', 'salary', '[]', ?, 1, 1, '2020-01-01 00:00:00')`
  ).run(userId, JOURNEY_OUTCOME, userId);
  const change = await db.prepare(
    `INSERT INTO financial_record_changes
      (user_id, idempotency_key, request_fingerprint_hmac, operation, record_type,
       record_id, record_version, status, occurred_at)
     VALUES (?, ?, 'test-hmac', 'create', 'salary', 1, 1, 'confirmed', '2020-01-01 00:00:00')`
  ).run(userId, `analytics-pbt-${userId}`);
  return {
    userId,
    sessionId: userId,
    journeyId: Number(journey.lastInsertRowid),
    changeId: Number(change.lastInsertRowid),
  };
}

async function enableAnalytics(userId) {
  await measurementRepository.acknowledgeDataUseNotice({ userId, noticeVersion: 1 });
  await measurementRepository.setAnalyticsConsent({ userId, enabled: true, consentVersion: 1 });
}

function eventEntries(base, ctx) {
  const occurredAt = new Date(base.occurredMs).toISOString();
  const outcomeKinds = service.OUTCOME_KINDS;
  switch (base.event) {
    case 'journey_started':
      return [['event', base.event], ['journeyId', ctx.journeyId], ['desiredOutcome', JOURNEY_OUTCOME], ['occurredAt', occurredAt]];
    case 'first_outcome_displayed':
      return [['event', base.event], ['journeyId', ctx.journeyId], ['outcomeKind', pickFrom(outcomeKinds, base.outcomeKind)], ['occurredAt', occurredAt]];
    case 'clarity_response':
      return [['event', base.event], ['journeyId', ctx.journeyId], ['response', pickFrom(service.CLARITY_RESPONSES, base.response)], ['occurredAt', occurredAt]];
    case 'recommended_action_completed':
      return [
        ['event', base.event],
        ['journeyId', ctx.journeyId],
        ['recommendationInstanceId', base.instanceId],
        ['actionKey', pickFrom(service.ACTION_KEYS, base.actionKey)],
        ['occurredAt', occurredAt],
      ];
    case 'financial_change_ui':
      return [
        ['event', base.event],
        ['changeId', ctx.changeId],
        ['causedReload', base.causedReload],
        ['causedPageWideLoading', base.causedPageWideLoading],
        ['occurredAt', occurredAt],
      ];
    default:
      throw new Error(`Unknown event ${base.event}`);
  }
}

function expectedRow(entries, ctx) {
  const fields = Object.fromEntries(entries);
  const isChange = fields.event === 'financial_change_ui';
  const instance = fields.recommendationInstanceId?.toLowerCase() ?? null;
  const subject = isChange ? ctx.changeId : ctx.journeyId;
  return {
    event_id: `${fields.event}:${ctx.userId}:${subject}${instance ? `:${instance}` : ''}`,
    user_id: ctx.userId,
    event_name: fields.event,
    journey_id: isChange ? null : ctx.journeyId,
    outcome_kind: fields.outcomeKind ?? null,
    desired_outcome: fields.desiredOutcome ?? null,
    response: fields.response ?? null,
    action_key: fields.actionKey ?? null,
    recommendation_instance_id: instance,
    change_id: isChange ? ctx.changeId : null,
    caused_reload: isChange ? Number(fields.causedReload) : null,
    caused_page_wide_loading: isChange ? Number(fields.causedPageWideLoading) : null,
    consent_version: 1,
  };
}

const isPositiveInt = (value) => Number.isSafeInteger(value) && value > 0;
const isNullOr = (check) => (value) => value === null || check(value);

/** Every persisted measurement row must be only fixed enum/UUID/ISO/ID values. */
function assertEventRowShape(row) {
  assert.deepEqual(Object.keys(row).sort(), EVENT_COLUMNS);
  assert.ok(service.MEASUREMENT_EVENT_NAMES.includes(row.event_name), 'event_name');
  assert.match(row.event_id, EVENT_ID);
  assert.ok(isPositiveInt(row.user_id), 'user_id');
  assert.ok(isNullOr(isPositiveInt)(row.journey_id), 'journey_id');
  assert.ok(isNullOr(isPositiveInt)(row.change_id), 'change_id');
  assert.ok(isNullOr((v) => service.OUTCOME_KINDS.includes(v))(row.outcome_kind), 'outcome_kind');
  assert.ok(isNullOr((v) => service.DESIRED_OUTCOMES.includes(v))(row.desired_outcome), 'desired_outcome');
  assert.ok(isNullOr((v) => service.CLARITY_RESPONSES.includes(v))(row.response), 'response');
  assert.ok(isNullOr((v) => service.ACTION_KEYS.includes(v))(row.action_key), 'action_key');
  assert.ok(isNullOr((v) => UUID_LOWER.test(v))(row.recommendation_instance_id), 'recommendation_instance_id');
  assert.ok(isNullOr((v) => v === 0 || v === 1)(row.caused_reload), 'caused_reload');
  assert.ok(isNullOr((v) => v === 0 || v === 1)(row.caused_page_wide_loading), 'caused_page_wide_loading');
  assert.equal(row.consent_version, 1);
  assert.match(row.occurred_at, INSTANT);
  assert.match(row.received_at, INSTANT);
  assert.ok(row.occurred_at <= row.received_at, 'occurred_at is bounded by receipt');
  assert.match(row.local_date, DATE_ONLY);
  assert.match(row.local_week_start, DATE_ONLY);
}

function assertVisitRowShape(row) {
  assert.deepEqual(Object.keys(row).sort(), VISIT_COLUMNS);
  assert.ok(visits.PUBLIC_VISIT_ROUTES.includes(row.path) || visits.PRIVATE_VISIT_ROUTES.includes(row.path), 'path is a fixed route key');
  assert.match(row.ip_hash, /^[0-9a-f]{24}$/);
  assert.ok(row.user_id === null || isPositiveInt(row.user_id));
  if (row.user_id === null) {
    assert.ok(visits.PUBLIC_VISIT_ROUTES.includes(row.path), 'anonymous rows hold only public routes');
  }
}

// ----------------------------------------------------------------- case body

async function runCase(c) {
  sequence += 1;
  const seq = sequence;
  scenarioCounts[c.scenario] = (scenarioCounts[c.scenario] ?? 0) + 1;

  const userId = ID_BASE + seq;
  const marker = `${MARKER_PREFIX}${seq}Z`;
  const address = `10.${(seq >> 16) & 255}.${(seq >> 8) & 255}.${seq & 255}`;
  const ctx = await insertAccount({ userId, email: `analytics-pbt-${seq}@example.test` });
  await enableAnalytics(userId);
  const authorization = authFor(userId, ctx.sessionId);

  const postEvent = (text, auth = authorization) => {
    let pending = request(app)
      .post('/api/clarity/events')
      .set('X-Forwarded-For', address)
      .set('Content-Type', 'application/json');
    if (auth) pending = pending.set('Authorization', auth);
    return pending.send(text);
  };
  const postVisit = (text, auth = authorization) => {
    let pending = request(app)
      .post('/api/track')
      .set('X-Forwarded-For', address)
      .set('Content-Type', 'application/json');
    if (auth) pending = pending.set('Authorization', auth);
    return pending.send(text);
  };

  const before = await snapshot();
  const assertRejected = async (response, expectedStatuses, label) => {
    assert.ok(
      expectedStatuses.includes(response.status),
      `${label}: expected ${expectedStatuses.join('/')}, got ${response.status} ${response.text}`
    );
    assert.equal(response.text.includes(marker), false, `${label}: rejection must not echo client text`);
    assert.deepEqual(await snapshot(), before, `${label}: a rejected request must change no measurement table`);
  };

  const context = { marker, realId: ctx.journeyId };

  switch (c.scenario) {
    case 'accepted': {
      const entries = eventEntries(c.base, ctx);
      const response = await postEvent(jsonBody(entries));
      assert.equal(response.status, 204, response.text);
      const rows = plain(await db.prepare('SELECT * FROM product_measurement_events WHERE user_id = ?').all(userId));
      assert.equal(rows.length, 1, 'one accepted event stores exactly one row');
      const [row] = rows;
      assertEventRowShape(row);
      const expected = expectedRow(entries, ctx);
      for (const [column, value] of Object.entries(expected)) {
        assert.deepEqual(row[column], value, `${c.base.event}.${column}`);
      }
      assert.deepEqual((await snapshot()).visits, before.visits, 'an event never writes visits');
      break;
    }

    case 'extraField': {
      const entries = eventEntries(c.base, ctx);
      const fields = entries.map(([name]) => name);
      const key = materializeKey(c.key, marker, fields);
      const value = materialize(c.hostile, { ...context, current: c.base.event });
      await assertRejected(await postEvent(jsonBody([...entries, [key, value]])), [400], 'extra field');
      break;
    }

    case 'badValue': {
      const entries = eventEntries(c.base, ctx);
      const index = c.pick % entries.length;
      const [field, current] = entries[index];
      const value = materialize(c.hostile, { ...context, current });
      const mutated = entries.map((entry, i) => (i === index ? [field, value] : entry));
      await assertRejected(await postEvent(jsonBody(mutated)), [400], `bad value for ${field}`);
      break;
    }

    case 'unknownEvent': {
      const entries = eventEntries(c.base, ctx);
      let name = c.withMarker ? `${c.name}${marker}` : c.name;
      // A random string could equal a supported name; the marker makes it unknown.
      if (service.MEASUREMENT_EVENT_NAMES.includes(name)) name = `${name}${marker}`;
      const mutated = entries.map(([field, value]) => (field === 'event' ? [field, name] : [field, value]));
      await assertRejected(await postEvent(jsonBody(mutated)), [400], 'unknown event name');
      break;
    }

    case 'missingField': {
      const entries = eventEntries(c.base, ctx);
      const index = c.pick % entries.length;
      const mutated = entries.filter((_entry, i) => i !== index);
      await assertRejected(await postEvent(jsonBody(mutated)), [400], `missing ${entries[index][0]}`);
      break;
    }

    case 'badReference': {
      const entries = eventEntries(c.base, ctx);
      const isChange = c.base.event === 'financial_change_ui';
      const idField = isChange ? 'changeId' : 'journeyId';
      let reference = c.reference;
      if (reference === 'mismatch' && c.base.event !== 'journey_started') reference = 'foreign';

      let mutated;
      let expectedStatus = 404;
      if (reference === 'mismatch') {
        const other = service.DESIRED_OUTCOMES.find((outcome) => outcome !== JOURNEY_OUTCOME);
        assert.ok(other, 'a second desired outcome exists');
        mutated = entries.map(([field, value]) => (field === 'desiredOutcome' ? [field, other] : [field, value]));
        expectedStatus = 422;
      } else {
        const foreignId = isChange ? otherAccount.changeId : otherAccount.journeyId;
        const referenced = reference === 'foreign' ? foreignId : UNKNOWN_REFERENCE_ID;
        mutated = entries.map(([field, value]) => (field === idField ? [field, referenced] : [field, value]));
      }
      await assertRejected(await postEvent(jsonBody(mutated)), [expectedStatus], `${reference} reference`);
      break;
    }

    case 'badBody': {
      const body = {
        array: () => [marker, c.body.json],
        string: () => `${c.body.prefix}${marker}`,
        number: () => c.body.n,
        null: () => null,
        boolean: () => c.body.b,
      }[c.body.kind]();
      await assertRejected(await postEvent(JSON.stringify(body)), [400], `${c.body.kind} body`);
      break;
    }

    case 'unauthenticated': {
      const entries = [...eventEntries(c.base, ctx), [`x${marker}`, marker]];
      const auth = {
        none: null,
        garbage: `Bearer ${marker}`,
        forged: authFor(userId, ctx.sessionId, `forged-secret-that-is-at-least-24-chars-${seq}`),
      }[c.mode];
      await assertRejected(await postEvent(jsonBody(entries), auth), [401], `${c.mode} credentials`);
      break;
    }

    case 'visitRejected': {
      const v = c.visit;
      const route = pickFrom(visits.PRIVATE_VISIT_ROUTES, v.routeIndex ?? 0);
      const hostile = v.hostile && materialize(v.hostile, { ...context, current: route });
      const keyFor = (forbidden) => v.key && materializeKey(v.key, marker, forbidden);
      let text;
      switch (v.variant) {
        case 'extraWithRoute': text = jsonBody([['route', route], [keyFor(['route', 'path']), hostile]]); break;
        case 'extraWithPath': text = jsonBody([['path', '/plan'], [keyFor(['route', 'path']), hostile]]); break;
        case 'routeAndPath': text = jsonBody([['route', route], ['path', `/plan${marker}`]]); break;
        case 'badRoute': text = jsonBody([['route', hostile]]); break;
        case 'badPathType': text = jsonBody([['path', hostile]]); break;
        case 'emptyPath': text = jsonBody([['path', '']]); break;
        case 'longPath': text = jsonBody([['path', `${marker}${'x'.repeat(201 + v.extra)}`]]); break;
        case 'unknownKey': text = jsonBody([[keyFor(['route', 'path']), hostile]]); break;
        case 'emptyObject': text = '{}'; break;
        case 'arrayBody': text = JSON.stringify([marker, v.json]); break;
        default: throw new Error(`Unknown visit variant ${v.variant}`);
      }
      await assertRejected(await postVisit(text), [400], `visit ${v.variant}`);
      break;
    }

    case 'visitAccepted': {
      const allRoutes = [...visits.PUBLIC_VISIT_ROUTES, ...visits.PRIVATE_VISIT_ROUTES];
      const route = pickFrom(allRoutes, c.routeIndex);
      const hostilePath = `${c.prefix}${marker}${c.suffix}`.slice(0, 200);
      // slice() can cut the marker only when prefix+suffix exceed 200 chars; the
      // generators cap both at 16 units so the marker always survives.
      assert.ok(hostilePath.includes(marker));
      const text = c.form === 'route'
        ? jsonBody([['route', route]])
        : jsonBody([['path', hostilePath]]);
      const auth = {
        owner: authorization,
        anonymous: null,
        forgedToken: authFor(userId, ctx.sessionId, `forged-secret-that-is-at-least-24-chars-${seq}`),
      }[c.actor];
      const response = await postVisit(text, auth);
      assert.equal(response.status, 204, response.text);

      const stored = c.form === 'route' ? route : 'other';
      const authenticated = c.actor === 'owner';
      const shouldStore = authenticated || visits.PUBLIC_VISIT_ROUTES.includes(stored);
      const rows = plain(await db.prepare('SELECT * FROM visits ORDER BY id').all());
      const added = rows.slice(before.visits.length);
      assert.equal(added.length, shouldStore ? 1 : 0, `visit by ${c.actor} (${stored})`);
      if (shouldStore) {
        assertVisitRowShape(added[0]);
        assert.equal(added[0].path, stored);
        assert.equal(added[0].user_id, authenticated ? userId : null);
      }
      assert.deepEqual(
        (await snapshot()).product_measurement_events,
        before.product_measurement_events,
        'a visit never writes events'
      );
      break;
    }

    default:
      throw new Error(`Unknown scenario ${c.scenario}`);
  }

  // No generated sensitive string may appear in any measurement-adjacent row.
  const after = JSON.stringify(await snapshot());
  assert.equal(after.includes(marker), false, 'a generated sensitive string was persisted');
}

let otherAccount;

before(async () => {
  testDatabase = await createIsolatedTestDatabase();
  db = testDatabase.db;
  process.env.FINANCIAL_MUTATION_HMAC_KEY =
    'test-only-analytics-schemas-hmac-key-32-bytes-minimum';
  // One reset for the whole run. Each case owns unique identifiers, so no
  // per-case reset is needed and accepted events can never collide.
  await testDatabase.reset();
  ({ default: measurementRepository } = await import('../../src/repositories/measurementRepository.js'));
  service = await import('../../src/services/measurementService.js');
  visits = await import('../../src/routes/visits.js');
  const { createApp } = await import('../../src/app.js');
  app = createApp();
  otherAccount = await insertAccount({ userId: OTHER_ID, email: 'analytics-pbt-other@example.test' });
  await enableAnalytics(OTHER_ID);
});

after(async () => {
  await testDatabase?.cleanup();
});

// Feature: financial-clarity-experience, Property 26: Analytics accepts no sensitive or arbitrary data
// **Validates: Requirements 11.12**
test(
  'Property 26: analytics ingestion persists only fixed enum/UUID/ISO fields and nothing from rejected input',
  { timeout: 900_000 },
  async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArbitrary, async (c) => {
        await new Promise((resolve) => setImmediate(resolve));
        await runCase(c);
      }),
      { numRuns: NUM_RUNS }
    );

    assert.equal(sequence, NUM_RUNS, 'every generated case ran exactly once');
    for (const scenario of [
      'accepted', 'extraField', 'badValue', 'unknownEvent', 'missingField',
      'badReference', 'badBody', 'unauthenticated', 'visitRejected', 'visitAccepted',
    ]) {
      assert.ok(scenarioCounts[scenario] > 0, `scenario ${scenario} was never generated`);
    }

    // Final sweep over everything persisted by the run.
    const events = plain(await db.prepare('SELECT * FROM product_measurement_events').all());
    const visitRows = plain(await db.prepare('SELECT * FROM visits').all());
    assert.ok(events.length > 0, 'accepted events were stored');
    events.forEach(assertEventRowShape);
    visitRows.forEach(assertVisitRowShape);

    const tables = (await db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
    ).all()).map((row) => row.name);
    const dump = await snapshotTables(tables);
    for (const [table, text] of Object.entries(dump)) {
      assert.equal(text.includes(MARKER_PREFIX), false, `${table} holds a generated sensitive string`);
    }
  }
);

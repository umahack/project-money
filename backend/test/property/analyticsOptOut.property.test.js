import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import fc from 'fast-check';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createIsolatedTestDatabase } from '../helpers/testDatabase.js';
import { buildSessionFixture, buildUserFixture } from '../helpers/fixtures.js';

const NUM_RUNS = 120;
const ID_BASE = 9_300_000;
const OTHER_ID = ID_BASE - 1;
const CLARITY_MONTH = '2024-03';
const INSTANCE_IDS = [
  '3f2b8c1e-7a4d-4e0b-9c55-0d1e2f3a4b5c',
  '9a1d0c2b-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
  'c0ffee00-1234-4abc-8def-0123456789ab',
];

// Tables whose rows a consent change, event, retry, or visit must never touch.
const USER_SCOPED_TABLES = [
  'salary_entries',
  'emis',
  'expense_log',
  'category_budgets',
  'recurring_expenses',
  'expense_category_treatments',
  'financial_record_changes',
  'guided_journeys',
];

const EVENT_FIELDS = [
  'event_id', 'event_name', 'journey_id', 'outcome_kind', 'desired_outcome', 'response',
  'action_key', 'recommendation_instance_id', 'change_id', 'caused_reload',
  'caused_page_wide_loading', 'consent_version',
];

let testDatabase;
let db;
let app;
let measurementRepository;
let claritySettingsService;
let journeyRepository;
let MeasurementService;
let measurementModule;
let journeyModule;
let visitsModule;
let createVisitsRouter;
let otherAccount;
let sequence = 0;

const stats = {
  ops: {},
  eventsPersisted: 0,
  eventsDroppedDisabled: 0,
  foreignWhileEnabled: 0,
  foreignWhileDisabled: 0,
  racePersisted: 0,
  raceNotPersisted: 0,
  racesWithConsent: 0,
  interleave: { persisted: 0, dropped: 0, disabled: 0 },
  visitsStored: 0,
  visitsDropped: 0,
  responseSignatures: new Set(),
};

// ---------------------------------------------------------------- generators

const eventSpecArbitrary = fc.record({
  kind: fc.constantFrom(
    'journey_started',
    'first_outcome_displayed',
    'clarity_response',
    'recommended_action_completed',
    'financial_change_ui'
  ),
  journey: fc.integer({ min: 0, max: 1 }),
  change: fc.nat(),
  instance: fc.integer({ min: 0, max: INSTANCE_IDS.length - 1 }),
  upperCaseInstance: fc.boolean(),
  response: fc.integer({ min: 0, max: 2 }),
  outcomeKind: fc.integer({ min: 0, max: 4 }),
  actionKey: fc.integer({ min: 0, max: 5 }),
  causedReload: fc.boolean(),
  causedPageWideLoading: fc.boolean(),
});

const operationArbitrary = fc.oneof(
  { weight: 6, arbitrary: fc.record({ op: fc.constant('optIn'), withAck: fc.boolean() }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant('optOut') }) },
  { weight: 10, arbitrary: fc.record({ op: fc.constant('event'), spec: eventSpecArbitrary }) },
  { weight: 3, arbitrary: fc.record({ op: fc.constant('retry'), pick: fc.nat() }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant('foreignEvent'), spec: eventSpecArbitrary }) },
  { weight: 3, arbitrary: fc.record({ op: fc.constant('visit'), route: fc.nat() }) },
  {
    weight: 3,
    arbitrary: fc.record({ op: fc.constant('salary'), amountMinor: fc.integer({ min: 0, max: 500_000_000 }) }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      op: fc.constant('journey'),
      action: fc.constantFrom('complete', 'pause', 'resume'),
      journey: fc.integer({ min: 0, max: 1 }),
      step: fc.nat(),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      op: fc.constant('raceOptOut'),
      specs: fc.array(eventSpecArbitrary, { minLength: 1, maxLength: 3 }),
      patchAt: fc.nat(),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      op: fc.constant('interleave'),
      variant: fc.constantFrom('afterConsentRead', 'beforeInsert', 'afterInsert'),
      spec: eventSpecArbitrary,
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      op: fc.constant('visitInterleave'),
      variant: fc.constantFrom('beforeInsert', 'afterInsert'),
      route: fc.nat(),
    }),
  }
);

const scenarioArbitrary = fc.record({
  // Most users start opted in, so events and visits are actually stored before an opt-out.
  startEnabled: fc.constantFrom(true, true, true, false),
  operations: fc.array(operationArbitrary, { minLength: 4, maxLength: 12 }),
});

// ------------------------------------------------------------------- helpers

function plain(rows) {
  return JSON.parse(JSON.stringify(rows, (_key, value) => (
    typeof value === 'bigint' ? Number(value) : value
  )));
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function authFor(userId, sessionId) {
  return `Bearer ${jwt.sign(
    { sub: String(userId), tv: 1, sid: sessionId },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '5m' }
  )}`;
}

async function insertAccount({ userId, email }) {
  const user = buildUserFixture({ id: userId, email });
  await db.prepare(
    `INSERT INTO users (id, email, name, password_hash, is_admin, token_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(user.id, user.email, user.name, user.password_hash, user.is_admin, user.token_version, user.created_at);
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
  await measurementRepository.acknowledgeDataUseNotice({ userId, noticeVersion: 1 });
  const journeys = [];
  for (const desiredOutcome of ['plan_month', 'fund_goal']) {
    const journey = await journeyRepository.create({
      userId,
      desiredOutcome,
      startedSessionId: session.id,
    });
    journeys.push({ id: journey.id, desiredOutcome, steps: [], status: 'active' });
  }
  const change = await db.prepare(
    `INSERT INTO financial_record_changes
      (user_id, idempotency_key, request_fingerprint_hmac, operation, record_type,
       record_id, record_version, status, occurred_at)
     VALUES (?, ?, 'test-hmac', 'create', 'goal', NULL, 1, 'confirmed', '2020-01-01 00:00:00')`
  ).run(userId, `optout-pbt-${userId}`);
  return {
    userId,
    sessionId: session.id,
    journeys,
    seedChangeId: Number(change.lastInsertRowid),
  };
}

/** Rows that consent, events, retries, and visits must leave byte-for-byte unchanged. */
async function protectedSnapshot(userId) {
  const result = {};
  for (const table of USER_SCOPED_TABLES) {
    result[table] = plain(
      await db.prepare(`SELECT * FROM ${table} WHERE user_id = ? ORDER BY id`).all(userId)
    );
  }
  result.financialState = plain(await db.prepare(
    `SELECT user_id, data_version, data_use_notice_version
       FROM user_financial_state WHERE user_id = ?`
  ).all(userId));
  return result;
}

async function eventRows(userId) {
  return plain(await db.prepare(
    `SELECT ${EVENT_FIELDS.join(', ')}, user_id FROM product_measurement_events
      WHERE user_id = ? ORDER BY event_id`
  ).all(userId));
}

async function consentRow(userId) {
  const row = await db.prepare(
    `SELECT analytics_enabled, analytics_consent_version FROM user_financial_state WHERE user_id = ?`
  ).get(userId);
  return plain(row);
}

function expectedEventFields(body, userId) {
  const isChange = body.event === 'financial_change_ui';
  const instance = body.recommendationInstanceId?.toLowerCase() ?? null;
  return {
    event_id: `${body.event}:${userId}:${isChange ? body.changeId : body.journeyId}${instance ? `:${instance}` : ''}`,
    event_name: body.event,
    journey_id: isChange ? null : body.journeyId,
    outcome_kind: body.outcomeKind ?? null,
    desired_outcome: body.desiredOutcome ?? null,
    response: body.response ?? null,
    action_key: body.actionKey ?? null,
    recommendation_instance_id: instance,
    change_id: isChange ? body.changeId : null,
    caused_reload: isChange ? Number(body.causedReload) : null,
    caused_page_wide_loading: isChange ? Number(body.causedPageWideLoading) : null,
    consent_version: 1,
  };
}

function countOp(name) {
  stats.ops[name] = (stats.ops[name] ?? 0) + 1;
}

// ----------------------------------------------------------------- case body

async function runCase({ startEnabled, operations }) {
  sequence += 1;
  const seq = sequence;
  const userId = ID_BASE + seq;
  const address = `10.${(seq >> 16) & 255}.${(seq >> 8) & 255}.${seq & 255}`;
  const ctx = await insertAccount({ userId, email: `optout-pbt-${seq}@example.test` });
  const authorization = authFor(userId, ctx.sessionId);

  // Independent model of everything the property talks about.
  if (startEnabled) {
    await measurementRepository.setAnalyticsConsent({ userId, enabled: true, consentVersion: 1 });
  }
  const model = {
    consent: startEnabled,
    events: new Map(),
    visits: [],
    salaries: new Map(),
    dataVersion: 0,
    changeIds: [ctx.seedChangeId],
    history: [],
    journeys: ctx.journeys.map((journey) => ({ ...journey })),
  };

  const send = (pending) => pending.set('X-Forwarded-For', address).set('Authorization', authorization);
  const postEvent = (body) => send(request(app).post('/api/clarity/events')).send(body);
  const patchSettings = (body) => send(request(app).patch('/api/clarity/settings')).send(body);
  const trackVisit = (route) => send(request(app).post('/api/track')).send({ route });
  const loadOutcomes = async () => {
    const response = await send(request(app).get('/api/finance/clarity').query({ month: CLARITY_MONTH }));
    assert.equal(response.status, 200, response.text);
    const { generatedAt: _generatedAt, ...snapshot } = response.body.snapshot;
    return snapshot;
  };

  const buildBody = (spec) => {
    const journey = model.journeys[spec.journey];
    const occurredAt = new Date().toISOString();
    switch (spec.kind) {
      case 'journey_started':
        return { event: spec.kind, journeyId: journey.id, desiredOutcome: journey.desiredOutcome, occurredAt };
      case 'first_outcome_displayed':
        return {
          event: spec.kind,
          journeyId: journey.id,
          outcomeKind: measurementModule.OUTCOME_KINDS[spec.outcomeKind % measurementModule.OUTCOME_KINDS.length],
          occurredAt,
        };
      case 'clarity_response':
        return {
          event: spec.kind,
          journeyId: journey.id,
          response: measurementModule.CLARITY_RESPONSES[spec.response],
          occurredAt,
        };
      case 'recommended_action_completed': {
        const instance = INSTANCE_IDS[spec.instance];
        return {
          event: spec.kind,
          journeyId: journey.id,
          recommendationInstanceId: spec.upperCaseInstance ? instance.toUpperCase() : instance,
          actionKey: measurementModule.ACTION_KEYS[spec.actionKey % measurementModule.ACTION_KEYS.length],
          occurredAt,
        };
      }
      case 'financial_change_ui':
        return {
          event: spec.kind,
          changeId: model.changeIds[spec.change % model.changeIds.length],
          causedReload: spec.causedReload,
          causedPageWideLoading: spec.causedPageWideLoading,
          occurredAt,
        };
      default:
        throw new Error(`Unknown event kind ${spec.kind}`);
    }
  };

  /** Receipt-time consent decides: apply a body to the model as the service must. */
  const applyToModel = (body, consentAtReceipt) => {
    const fields = expectedEventFields(body, userId);
    model.history.push(body);
    if (!consentAtReceipt) {
      stats.eventsDroppedDisabled += 1;
      return false;
    }
    if (model.events.has(fields.event_id)) return false;
    model.events.set(fields.event_id, fields);
    stats.eventsPersisted += 1;
    return true;
  };

  const assertEventResponse = (response, label) => {
    assert.equal(response.status, 204, `${label}: ${response.text}`);
    assert.equal(response.text, '', `${label}: a no-op must not carry a body`);
    stats.responseSignatures.add(Object.keys(response.headers).sort().join(','));
  };

  const assertModelMatchesDatabase = async (label) => {
    // Measurement rows: exactly the events accepted while consent was on at receipt.
    const rows = await eventRows(userId);
    assert.deepEqual(
      rows.map((row) => row.event_id),
      [...model.events.keys()].sort(),
      `${label}: persisted events must be exactly those received while consent was enabled`
    );
    for (const row of rows) {
      const { user_id: rowUser, ...fields } = row;
      assert.equal(rowUser, userId);
      assert.deepEqual(fields, model.events.get(row.event_id), `${label}: ${row.event_id}`);
    }

    const visitRows = plain(await db.prepare(
      'SELECT path FROM visits WHERE user_id = ? ORDER BY id'
    ).all(userId));
    assert.deepEqual(visitRows.map((row) => row.path), model.visits, `${label}: visits`);

    const consent = await consentRow(userId);
    assert.equal(consent.analytics_enabled, model.consent ? 1 : 0, `${label}: stored consent`);

    // Financial and journey state follow only the financial and journey operations.
    const salaryRows = plain(await db.prepare(
      'SELECT month, amount FROM salary_entries WHERE user_id = ? ORDER BY month'
    ).all(userId));
    assert.deepEqual(
      salaryRows.map((row) => [row.month, Math.round(row.amount * 100)]),
      [...model.salaries.entries()].sort(([a], [b]) => a.localeCompare(b)),
      `${label}: salary rows`
    );
    const state = plain(await db.prepare(
      'SELECT data_version FROM user_financial_state WHERE user_id = ?'
    ).get(userId));
    assert.equal(state.data_version, model.dataVersion, `${label}: data_version`);
    const changes = await db.prepare(
      'SELECT COUNT(*) AS count FROM financial_record_changes WHERE user_id = ?'
    ).get(userId);
    assert.equal(Number(changes.count), model.changeIds.length, `${label}: change receipts`);

    for (const journey of model.journeys) {
      const row = plain(await db.prepare(
        'SELECT status, completed_step_keys FROM guided_journeys WHERE id = ? AND user_id = ?'
      ).get(journey.id, userId));
      const definition = journeyModule.JOURNEY_DEFINITIONS[journey.desiredOutcome];
      const canonical = [...definition.requiredStepKeys, ...definition.optionalStepKeys]
        .filter((step) => journey.steps.includes(step));
      assert.equal(row.status, journey.status, `${label}: journey ${journey.id} status`);
      assert.deepEqual(JSON.parse(row.completed_step_keys), canonical, `${label}: journey ${journey.id} steps`);
    }

    const other = await db.prepare(
      'SELECT COUNT(*) AS count FROM product_measurement_events WHERE user_id = ?'
    ).get(OTHER_ID);
    assert.equal(Number(other.count), 0, `${label}: another user's consent must never be used`);
  };

  /** Run an operation that must not change any financial or journey row. */
  const assertFinancialStateUnchanged = async (label, operation) => {
    const before = await protectedSnapshot(userId);
    const result = await operation();
    assert.deepEqual(await protectedSnapshot(userId), before, `${label}: financial and journey rows changed`);
    return result;
  };

  const interleavedEvent = async (variant, body) => {
    const realRepository = measurementRepository;
    const optOutNow = () => realRepository.setAnalyticsConsent({ userId, enabled: false });
    const racingConsent = {
      async getAnalyticsConsent(args) {
        const consent = await claritySettingsService.getAnalyticsConsent(args);
        await optOutNow();
        return consent;
      },
    };
    const racingRepository = {
      getOwnedChangeReceipt: (args) => realRepository.getOwnedChangeReceipt(args),
      recordConsentedEvent: async (event) => {
        if (variant === 'beforeInsert') {
          await optOutNow();
          return realRepository.recordConsentedEvent(event);
        }
        const recorded = await realRepository.recordConsentedEvent(event);
        await optOutNow();
        return recorded;
      },
    };
    const subject = new MeasurementService(
      variant === 'afterConsentRead'
        ? { consent: racingConsent }
        : { repository: racingRepository }
    );
    return subject.ingest({ userId, sessionId: ctx.sessionId, input: body });
  };

  for (const [index, operation] of operations.entries()) {
    const label = `case ${seq} op ${index} ${operation.op}`;
    countOp(operation.op);

    switch (operation.op) {
      case 'optIn':
      case 'optOut': {
        const enabled = operation.op === 'optIn';
        const patch = enabled
          ? { analyticsEnabled: true, ...(operation.withAck ? { acknowledgedNoticeVersion: 1 } : {}) }
          : { analyticsEnabled: false };
        await assertFinancialStateUnchanged(label, async () => {
          const outcomesBefore = await loadOutcomes();
          const response = await patchSettings(patch);
          assert.equal(response.status, 200, response.text);
          assert.equal(response.body.productAnalytics.enabled, enabled, `${label}: PATCH reports the new state`);
          model.consent = enabled;
          // The change is awaited before the response, so the stored state already matches.
          assert.equal((await consentRow(userId)).analytics_enabled, enabled ? 1 : 0);
          assert.deepEqual(await loadOutcomes(), outcomesBefore, `${label}: personalized outcomes changed`);
        });
        break;
      }

      case 'event':
      case 'retry': {
        let body;
        if (operation.op === 'retry') {
          if (model.history.length === 0) break;
          body = model.history[operation.pick % model.history.length];
        } else {
          body = buildBody(operation.spec);
        }
        await assertFinancialStateUnchanged(label, async () => {
          const consentAtReceipt = model.consent;
          const response = await postEvent(body);
          assertEventResponse(response, label);
          applyToModel(body, consentAtReceipt);
        });
        break;
      }

      case 'foreignEvent': {
        const spec = operation.spec;
        const body = spec.kind === 'financial_change_ui'
          ? {
            event: spec.kind,
            changeId: otherAccount.seedChangeId,
            causedReload: spec.causedReload,
            causedPageWideLoading: spec.causedPageWideLoading,
            occurredAt: new Date().toISOString(),
          }
          : {
            event: 'clarity_response',
            journeyId: otherAccount.journeys[0].id,
            response: 'yes',
            occurredAt: new Date().toISOString(),
          };
        await assertFinancialStateUnchanged(label, async () => {
          const response = await postEvent(body);
          if (model.consent) {
            assert.equal(response.status, 404, `${label}: ${response.text}`);
            stats.foreignWhileEnabled += 1;
          } else {
            assertEventResponse(response, label);
            stats.foreignWhileDisabled += 1;
          }
        });
        break;
      }

      case 'visit': {
        const routes = [...visitsModule.PUBLIC_VISIT_ROUTES, ...visitsModule.PRIVATE_VISIT_ROUTES];
        const route = routes[operation.route % routes.length];
        await assertFinancialStateUnchanged(label, async () => {
          const consentAtReceipt = model.consent;
          const response = await trackVisit(route);
          assert.equal(response.status, 204, response.text);
          assert.equal(response.text, '');
          if (consentAtReceipt) {
            model.visits.push(route);
            stats.visitsStored += 1;
          } else {
            stats.visitsDropped += 1;
          }
        });
        break;
      }

      case 'salary': {
        const month = `2024-${pad2(model.salaries.size + 1)}`;
        const response = await send(request(app).post('/api/finance/salary'))
          .set('X-Clarity-Contract', '1')
          .set('Idempotency-Key', randomUUID())
          .send({ amountMinor: operation.amountMinor, month, expectedRecordVersion: 0 });
        assert.equal(response.status, 200, `${label}: ${response.text}`);
        model.salaries.set(month, operation.amountMinor);
        model.dataVersion += 1;
        model.changeIds.push(response.body.mutation.changeId);
        assert.equal(response.body.clarity.dataVersion, model.dataVersion, `${label}: reported data version`);
        break;
      }

      case 'journey': {
        const journey = model.journeys[operation.journey];
        const definition = journeyModule.JOURNEY_DEFINITIONS[journey.desiredOutcome];
        const allSteps = [...definition.requiredStepKeys, ...definition.optionalStepKeys];
        if (operation.action === 'complete') {
          const step = allSteps[operation.step % allSteps.length];
          await journeyRepository.completeStep({ userId, journeyId: journey.id, stepKey: step });
          if (!journey.steps.includes(step)) journey.steps.push(step);
          journey.status = 'active';
        } else if (operation.action === 'pause') {
          await journeyRepository.pause({ userId, journeyId: journey.id });
          journey.status = 'paused';
        } else {
          await journeyRepository.resume({ userId, journeyId: journey.id });
          journey.status = 'active';
        }
        break;
      }

      case 'raceOptOut': {
        // Distinct logical events only, so each racing event has one possible row.
        const seen = new Set();
        const bodies = [];
        for (const spec of operation.specs) {
          const body = buildBody(spec);
          const id = expectedEventFields(body, userId).event_id;
          if (!seen.has(id) && !model.events.has(id)) {
            seen.add(id);
            bodies.push(body);
          }
        }
        const consentBeforeRace = model.consent;
        await assertFinancialStateUnchanged(label, async () => {
          // The opt-out is issued at a generated position among the racing events.
          const patchAt = operation.patchAt % (bodies.length + 1);
          const pending = bodies.map((body) => postEvent(body));
          pending.splice(patchAt, 0, patchSettings({ analyticsEnabled: false }));
          const settled = await Promise.all(pending);
          const [patch] = settled.splice(patchAt, 1);
          const posts = settled;
          assert.equal(patch.status, 200, patch.text);
          assert.equal(patch.body.productAnalytics.enabled, false);
          posts.forEach((response, i) => assertEventResponse(response, `${label} racing event ${i}`));
          model.consent = false;

          // Each racing event either committed before the opt-out or never persists.
          const persistedIds = new Set((await eventRows(userId)).map((row) => row.event_id));
          for (const body of bodies) {
            const fields = expectedEventFields(body, userId);
            model.history.push(body);
            if (persistedIds.has(fields.event_id)) {
              assert.ok(consentBeforeRace, `${label}: ${fields.event_id} persisted although consent was already off`);
              model.events.set(fields.event_id, fields);
              stats.racePersisted += 1;
            } else {
              stats.raceNotPersisted += 1;
            }
          }
          if (consentBeforeRace && bodies.length > 0) stats.racesWithConsent += 1;

          // The opt-out response has been returned: no queued retry may persist now.
          const rowsAfterOptOut = await eventRows(userId);
          for (const body of bodies) {
            assertEventResponse(await postEvent(body), `${label} retry after opt-out`);
          }
          assert.deepEqual(await eventRows(userId), rowsAfterOptOut, `${label}: retries after opt-out persisted`);
        });
        break;
      }

      case 'interleave': {
        const body = buildBody(operation.spec);
        const fields = expectedEventFields(body, userId);
        await assertFinancialStateUnchanged(label, async () => {
          const consentAtStart = model.consent;
          const result = await interleavedEvent(operation.variant, body);
          model.history.push(body);
          if (!consentAtStart) {
            // The seam is never reached: disabled analytics is a no-op.
            assert.deepEqual(result, { recorded: false, reason: 'analytics_disabled' }, label);
            stats.interleave.disabled += 1;
            stats.eventsDroppedDisabled += 1;
            return;
          }
          model.consent = false;
          if (operation.variant === 'afterInsert') {
            const isNew = !model.events.has(fields.event_id);
            assert.deepEqual(
              result,
              isNew
                ? { recorded: true, reason: 'recorded' }
                : { recorded: false, reason: 'not_recorded' },
              `${label}: an event committed before the opt-out may persist`
            );
            if (isNew) {
              model.events.set(fields.event_id, fields);
              stats.eventsPersisted += 1;
              stats.interleave.persisted += 1;
            }
          } else {
            assert.deepEqual(
              result,
              { recorded: false, reason: 'not_recorded' },
              `${label}: an opt-out committed before the insert must win`
            );
            stats.interleave.dropped += 1;
            stats.eventsDroppedDisabled += 1;
          }
        });
        break;
      }

      case 'visitInterleave': {
        const routes = visitsModule.PRIVATE_VISIT_ROUTES;
        const route = routes[operation.route % routes.length];
        const realRepository = measurementRepository;
        const optOutNow = () => realRepository.setAnalyticsConsent({ userId, enabled: false });
        const racingRepository = {
          recordAnonymousVisit: (args) => realRepository.recordAnonymousVisit(args),
          recordConsentedVisit: async (visit) => {
            if (operation.variant === 'beforeInsert') {
              await optOutNow();
              return realRepository.recordConsentedVisit(visit);
            }
            const recorded = await realRepository.recordConsentedVisit(visit);
            await optOutNow();
            return recorded;
          },
        };
        const miniApp = express();
        miniApp.use(express.json());
        miniApp.use('/api', createVisitsRouter({
          repository: racingRepository,
          resolveUserId: async () => userId,
        }));
        await assertFinancialStateUnchanged(label, async () => {
          const consentAtStart = model.consent;
          const response = await request(miniApp).post('/api/track').send({ route });
          assert.equal(response.status, 204, response.text);
          assert.equal(response.text, '');
          if (!consentAtStart) {
            stats.visitsDropped += 1;
            return;
          }
          model.consent = false;
          if (operation.variant === 'afterInsert') {
            model.visits.push(route);
            stats.visitsStored += 1;
          } else {
            stats.visitsDropped += 1;
          }
        });
        break;
      }

      default:
        throw new Error(`Unknown operation ${operation.op}`);
    }

    await assertModelMatchesDatabase(label);
  }

  // Final receipt-time check: once consent is off nothing new can be stored,
  // and a final opt-out of every case still leaves earlier rows in place.
  const rowsBefore = await eventRows(userId);
  const visitsBefore = model.visits.length;
  assert.equal((await patchSettings({ analyticsEnabled: false })).status, 200);
  model.consent = false;
  for (const body of model.history) assertEventResponse(await postEvent(body), `case ${seq} final retry`);
  for (const route of visitsModule.PRIVATE_VISIT_ROUTES.slice(0, 2)) {
    assert.equal((await trackVisit(route)).status, 204);
  }
  assert.deepEqual(await eventRows(userId), rowsBefore, `case ${seq}: events stored after final opt-out`);
  assert.equal(model.visits.length, visitsBefore);
  await assertModelMatchesDatabase(`case ${seq} final`);
}

before(async () => {
  testDatabase = await createIsolatedTestDatabase();
  db = testDatabase.db;
  process.env.FINANCIAL_MUTATION_HMAC_KEY =
    'test-only-analytics-opt-out-hmac-key-32-bytes-minimum';
  // One reset for the whole run. Every case owns unique identifiers.
  await testDatabase.reset();
  ({ default: measurementRepository } = await import('../../src/repositories/measurementRepository.js'));
  ({ default: journeyRepository } = await import('../../src/repositories/journeyRepository.js'));
  ({ default: claritySettingsService } = await import('../../src/services/claritySettings.js'));
  measurementModule = await import('../../src/services/measurementService.js');
  ({ MeasurementService } = measurementModule);
  journeyModule = await import('../../src/repositories/journeyRepository.js');
  visitsModule = await import('../../src/routes/visits.js');
  ({ createVisitsRouter } = visitsModule);
  const { createApp } = await import('../../src/app.js');
  app = createApp();
  otherAccount = await insertAccount({ userId: OTHER_ID, email: 'optout-pbt-other@example.test' });
  await measurementRepository.setAnalyticsConsent({ userId: OTHER_ID, enabled: true, consentVersion: 1 });
});

after(async () => {
  await testDatabase?.cleanup();
});

// Feature: financial-clarity-experience, Property 27: Analytics opt-out is immediate and financially independent
// **Validates: Requirements 11.14, 11.15**
test(
  'Property 27: opt-out is immediate, receipt-time consent wins, and financial and journey state never depends on consent',
  { timeout: 1_800_000 },
  async (t) => {
    await fc.assert(
      fc.asyncProperty(scenarioArbitrary, async (scenario) => {
        await new Promise((resolve) => setImmediate(resolve));
        await runCase(scenario);
      }),
      { numRuns: NUM_RUNS }
    );

    assert.equal(sequence, NUM_RUNS, 'every generated case ran exactly once');
    for (const name of [
      'optIn', 'optOut', 'event', 'retry', 'foreignEvent', 'visit', 'salary',
      'journey', 'raceOptOut', 'interleave', 'visitInterleave',
    ]) {
      assert.ok(stats.ops[name] > 0, `operation ${name} was never generated`);
    }
    assert.ok(stats.eventsPersisted > 0, 'events were persisted while consent was enabled');
    assert.ok(stats.eventsDroppedDisabled > 0, 'events were dropped while consent was disabled');
    assert.ok(stats.foreignWhileDisabled > 0, 'a disabled no-op for an unauthorized reference was exercised');
    assert.ok(stats.foreignWhileEnabled > 0, 'an enabled rejection for an unauthorized reference was exercised');
    assert.ok(stats.racesWithConsent > 0, 'an opt-out raced an enabled event stream');
    assert.ok(stats.interleave.persisted > 0, 'an opt-out landing after the insert was exercised');
    assert.ok(stats.interleave.dropped > 0, 'an opt-out landing before the insert was exercised');
    assert.ok(stats.visitsStored > 0 && stats.visitsDropped > 0, 'visits were both stored and dropped');
    // Enabled, disabled, and dropped responses must not be distinguishable.
    assert.equal(
      stats.responseSignatures.size,
      1,
      `event responses differ by consent state: ${[...stats.responseSignatures].join(' | ')}`
    );

    t.diagnostic(JSON.stringify({
      cases: sequence,
      ...stats,
      responseSignatures: stats.responseSignatures.size,
    }));
  }
);

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createIsolatedTestDatabase } from '../helpers/testDatabase.js';

let testDatabase;
let db;
let financialRepository;
let journeyRepository;
let measurementRepository;

before(async () => {
  testDatabase = await createIsolatedTestDatabase();
  db = testDatabase.db;
  ({ default: financialRepository } = await import('../../src/repositories/financialRepository.js'));
  ({ default: journeyRepository } = await import('../../src/repositories/journeyRepository.js'));
  ({ default: measurementRepository } = await import('../../src/repositories/measurementRepository.js'));
});

after(async () => {
  await testDatabase?.cleanup();
});

async function insertUser(id) {
  await db.prepare(
    'INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)'
  ).run(id, `repository-${id}@example.test`, `Repository User ${id}`, 'test-password-hash');
}

async function insertSession(id, userId) {
  await db.prepare(
    `INSERT INTO sessions (id, user_id, device_label, ip_hash, user_agent)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, userId, 'Repository Test', 'repository-test-ip-hash', 'node:test');
}

test('financial repository scopes exact-period records and normalizes every amount to paise', async () => {
  const userId = 6101;
  const otherUserId = 6102;
  const emptyUserId = 6103;
  await Promise.all([insertUser(userId), insertUser(otherUserId), insertUser(emptyUserId)]);

  await db.batch([
    ['INSERT INTO salary_entries (user_id, month, amount) VALUES (?, ?, ?)', [userId, '2026-01', 1000.25]],
    ['INSERT INTO salary_entries (user_id, month, amount) VALUES (?, ?, ?)', [userId, '2025-12', 900]],
    ['INSERT INTO salary_entries (user_id, month, amount) VALUES (?, ?, ?)', [otherUserId, '2026-01', 9999]],
    [`INSERT INTO emis
       (user_id, label, amount, category, active, effective_from_month, effective_to_month)
     VALUES (?, ?, ?, ?, ?, ?, ?)`, [userId, 'Open bill', 100.1, 'Rent', 1, null, null]],
    [`INSERT INTO emis
       (user_id, label, amount, category, active, effective_from_month, effective_to_month)
     VALUES (?, ?, ?, ?, ?, ?, ?)`, [userId, 'January bill', 50.55, 'Utility', 1, '2026-01', '2026-01']],
    [`INSERT INTO emis
       (user_id, label, amount, category, active, effective_from_month, effective_to_month)
     VALUES (?, ?, ?, ?, ?, ?, ?)`, [userId, 'Inactive bill', 222, 'Other', 0, null, null]],
    [`INSERT INTO emis
       (user_id, label, amount, category, active, effective_from_month, effective_to_month)
     VALUES (?, ?, ?, ?, ?, ?, ?)`, [userId, 'Future bill', 333, 'Other', 1, '2026-02', null]],
    [`INSERT INTO emis
       (user_id, label, amount, category, active, effective_from_month, effective_to_month)
     VALUES (?, ?, ?, ?, ?, ?, ?)`, [otherUserId, 'Other user bill', 777, 'Rent', 1, null, null]],
    [`INSERT INTO expense_log (user_id, month, category, amount, note, spent_on)
     VALUES (?, ?, ?, ?, ?, ?)`, [userId, '2026-01', 'Groceries', 12.34, null, '2026-01-15']],
    [`INSERT INTO expense_log (user_id, month, category, amount, note, spent_on)
     VALUES (?, ?, ?, ?, ?, ?)`, [userId, '2025-12', 'Groceries', 88, null, '2025-12-15']],
    [`INSERT INTO expense_log (user_id, month, category, amount, note, spent_on)
     VALUES (?, ?, ?, ?, ?, ?)`, [otherUserId, '2026-01', 'Groceries', 444, null, '2026-01-15']],
    [`INSERT INTO expense_category_treatments (user_id, category, treatment)
     VALUES (?, ?, ?)`, [userId, 'Groceries', 'needs']],
    [`INSERT INTO savings_goals (user_id, name, target_amount, saved_amount, target_date)
     VALUES (?, ?, ?, ?, ?)`, [userId, 'Emergency fund', 2500.75, 500.25, '2026-12-31']],
    [`INSERT INTO savings_goals (user_id, name, target_amount, saved_amount, target_date)
     VALUES (?, ?, ?, ?, ?)`, [otherUserId, 'Private goal', 9999, 1, '2026-12-31']],
  ]);

  const period = await financialRepository.loadPeriod({ userId, month: '2026-01' });
  assert.equal(period.status, 'confirmed');
  assert.equal(period.salary.record.amountMinor, 100_025);
  assert.equal(Object.hasOwn(period.salary.record, 'amount'), false);
  assert.deepEqual(period.bills.records.map((bill) => bill.amountMinor), [10_010, 5_055]);
  assert.deepEqual(period.expenses.records.map((expense) => expense.amountMinor), [1_234]);
  assert.deepEqual(period.categoryTreatments.records.map(({ category, treatment }) => ({ category, treatment })), [
    { category: 'Groceries', treatment: 'needs' },
  ]);
  assert.ok(period.bills.records.every((bill) => bill.userId === userId));
  assert.ok(period.expenses.records.every((expense) => expense.month === '2026-01'));

  const goals = await financialRepository.loadGoals(userId);
  assert.equal(goals.status, 'confirmed');
  assert.equal(goals.empty, false);
  assert.deepEqual(
    goals.records.map(({ targetAmountMinor, savedAmountMinor }) => ({ targetAmountMinor, savedAmountMinor })),
    [{ targetAmountMinor: 250_075, savedAmountMinor: 50_025 }]
  );

  const empty = await financialRepository.loadPeriod({ userId: emptyUserId, month: '2026-01' });
  assert.deepEqual(empty.salary, { status: 'confirmed', empty: true, record: null });
  assert.deepEqual(empty.bills, { status: 'confirmed', empty: true, records: [] });
  assert.deepEqual(empty.expenses, { status: 'confirmed', empty: true, records: [] });
  assert.deepEqual(await financialRepository.loadGoals(emptyUserId), {
    status: 'confirmed',
    empty: true,
    records: [],
  });
});

test('financial repository maps the daily allowance exclusion to a boolean without rewriting stored values', async () => {
  const userId = 6104;
  await insertUser(userId);

  await db.batch([
    [`INSERT INTO expense_log (user_id, month, category, amount, note, spent_on)
     VALUES (?, ?, ?, ?, ?, ?)`, [userId, '2026-03', 'Groceries', 10, 'legacy', '2026-03-02']],
    [`INSERT INTO expense_log (user_id, month, category, amount, note, spent_on, exclude_from_daily_allowance)
     VALUES (?, ?, ?, ?, ?, ?, ?)`, [userId, '2026-03', 'Rent', 20, 'rent', '2026-03-03', 1]],
    [`INSERT INTO expense_log (user_id, month, category, amount, note, spent_on, exclude_from_daily_allowance)
     VALUES (?, ?, ?, ?, ?, ?, ?)`, [userId, '2026-03', 'Food', 30, 'zero', '2026-03-04', 0]],
  ]);
  const storedBefore = await db.prepare(
    'SELECT id, exclude_from_daily_allowance FROM expense_log WHERE user_id = ? ORDER BY id'
  ).all(userId);

  const period = await financialRepository.loadPeriod({ userId, month: '2026-03' });
  assert.deepEqual(
    period.expenses.records.map(({ note, amountMinor, excludeFromDailyAllowance }) => (
      { note, amountMinor, excludeFromDailyAllowance }
    )),
    [
      { note: 'legacy', amountMinor: 1_000, excludeFromDailyAllowance: false },
      { note: 'rent', amountMinor: 2_000, excludeFromDailyAllowance: true },
      { note: 'zero', amountMinor: 3_000, excludeFromDailyAllowance: false },
    ]
  );
  assert.ok(period.expenses.records.every((record) => (
    typeof record.excludeFromDailyAllowance === 'boolean'
    && !Object.hasOwn(record, 'exclude_from_daily_allowance')
    && record.normalizationIssues.length === 0
  )));

  const storedAfter = await db.prepare(
    'SELECT id, exclude_from_daily_allowance FROM expense_log WHERE user_id = ? ORDER BY id'
  ).all(userId);
  assert.deepEqual(storedAfter, storedBefore);
  assert.equal(storedAfter[0].exclude_from_daily_allowance, null);
});

test('financial repository preserves owner/member trip access and monotonic versions', async () => {
  const ownerId = 6201;
  const memberId = 6202;
  const outsiderId = 6203;
  await Promise.all([insertUser(ownerId), insertUser(memberId), insertUser(outsiderId)]);

  const trip = await db.prepare(
    `INSERT INTO trips (user_id, name, destination, budget)
     VALUES (?, ?, ?, ?)
     RETURNING id`
  ).get(ownerId, 'Scoped trip', 'Pune', 500.5);
  const tripId = Number(trip.id);
  await db.batch([
    [`INSERT INTO trip_members (trip_id, user_id, name, email)
     VALUES (?, ?, ?, ?)`, [tripId, ownerId, 'Owner', 'owner@example.test']],
    [`INSERT INTO trip_members (trip_id, user_id, name, email)
     VALUES (?, ?, ?, ?)`, [tripId, memberId, 'Member', 'member@example.test']],
    [`INSERT INTO trip_expenses (trip_id, payer, description, amount, split_json)
     VALUES (?, ?, ?, ?, ?)`, [
      tripId,
      'Owner',
      'Hotel',
      10.25,
      JSON.stringify([{ name: 'Owner', share: 1 }, { name: 'Member', share: 1 }]),
    ]],
  ]);

  const ownerLedger = await financialRepository.loadAccessibleTripLedger({ userId: ownerId, tripId });
  const memberLedger = await financialRepository.loadAccessibleTripLedger({ userId: memberId, tripId });
  const outsiderLedger = await financialRepository.loadAccessibleTripLedger({ userId: outsiderId, tripId });

  assert.equal(ownerLedger.role, 'owner');
  assert.equal(memberLedger.role, 'member');
  assert.equal(outsiderLedger, null);
  assert.equal(ownerLedger.trip.budgetMinor, 50_050);
  assert.equal(ownerLedger.expenses.records[0].amountMinor, 1_025);
  assert.equal(ownerLedger.expenses.records[0].splitStatus, 'confirmed');
  assert.deepEqual(ownerLedger.members.records.map((member) => member.userId), [ownerId, memberId]);

  assert.equal(await financialRepository.incrementTripVersion({ userId: ownerId, tripId }), 1);
  assert.equal(await financialRepository.incrementTripVersion({ userId: memberId, tripId }), 2);
  assert.equal(await financialRepository.incrementTripVersion({ userId: outsiderId, tripId }), null);
  assert.equal(await financialRepository.getTripVersion({ userId: ownerId, tripId }), 2);
  assert.equal(await financialRepository.getTripVersion({ userId: outsiderId, tripId }), null);

  const increments = await Promise.all(
    Array.from({ length: 12 }, () => financialRepository.incrementDataVersion(ownerId))
  );
  assert.deepEqual(increments.toSorted((left, right) => left - right), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.equal(await financialRepository.getDataVersion(ownerId), 12);
  assert.equal(await financialRepository.getDataVersion(outsiderId), 0);
});

test('journey repository persists only fixed steps and resumes the next incomplete step per user', async () => {
  const userId = 6301;
  const otherUserId = 6302;
  const sessionId = 7301;
  const otherSessionId = 7302;
  await Promise.all([insertUser(userId), insertUser(otherUserId)]);
  await Promise.all([insertSession(sessionId, userId), insertSession(otherSessionId, otherUserId)]);

  const journey = await journeyRepository.create({
    userId,
    desiredOutcome: 'settle_trip',
    startedSessionId: sessionId,
  });
  assert.equal(journey.currentStepKey, 'trip');
  assert.deepEqual(journey.requiredStepKeys, ['trip', 'trip_members', 'trip_split']);
  assert.equal(await journeyRepository.getById({ userId: otherUserId, journeyId: journey.id }), null);

  const afterTrip = await journeyRepository.completeStep({
    userId,
    journeyId: journey.id,
    stepKey: 'trip',
  });
  assert.deepEqual(afterTrip.completedStepKeys, ['trip']);
  assert.equal(afterTrip.nextIncompleteStepKey, 'trip_members');

  await assert.rejects(
    journeyRepository.completeStep({ userId, journeyId: journey.id, stepKey: 'client_defined_step' }),
    /not valid/
  );
  await assert.rejects(
    journeyRepository.saveProgress({ userId, journeyId: journey.id, completedStepKeys: [] }),
    /cannot be removed/
  );
  await assert.rejects(
    journeyRepository.create({
      userId,
      desiredOutcome: 'plan_month',
      startedSessionId: otherSessionId,
    }),
    /does not belong/
  );

  const paused = await journeyRepository.pause({ userId, journeyId: journey.id });
  assert.equal(paused.status, 'paused');
  const resumable = await journeyRepository.getResumable(userId);
  assert.equal(resumable.status, 'confirmed');
  assert.equal(resumable.record.id, journey.id);
  assert.equal(resumable.record.currentStepKey, 'trip_members');

  const resumed = await journeyRepository.resume({ userId, journeyId: journey.id });
  assert.equal(resumed.status, 'active');
  assert.equal(resumed.currentStepKey, 'trip_members');
  assert.deepEqual(await journeyRepository.getResumable(otherUserId), {
    status: 'confirmed',
    empty: true,
    record: null,
  });
});

test('measurement repository scopes consent/events and keeps checkpoints and outages explicit', async () => {
  const userId = 6401;
  const otherUserId = 6402;
  await Promise.all([insertUser(userId), insertUser(otherUserId)]);

  assert.deepEqual(await measurementRepository.getConsentState(userId), {
    userId,
    dataUseNoticeVersion: 0,
    dataUseAcknowledgedAt: null,
    analyticsEnabled: false,
    analyticsConsentVersion: null,
    analyticsChangedAt: null,
  });

  const enabled = await measurementRepository.setAnalyticsConsent({
    userId,
    enabled: true,
    consentVersion: 3,
  });
  assert.equal(enabled.analyticsEnabled, true);
  assert.equal(enabled.analyticsConsentVersion, 3);
  const acknowledged = await measurementRepository.acknowledgeDataUseNotice({
    userId,
    noticeVersion: 4,
  });
  assert.equal(acknowledged.dataUseNoticeVersion, 4);
  assert.equal((await measurementRepository.getConsentState(otherUserId)).analyticsEnabled, false);

  await db.batch([
    [`INSERT INTO product_measurement_events
      (event_id, user_id, event_name, consent_version, occurred_at, local_date, local_week_start)
     VALUES (?, ?, ?, ?, ?, ?, ?)`, [
      'repository-event-user', userId, 'journey_started', 3,
      '2026-01-15T06:30:00.000Z', '2026-01-15', '2026-01-12',
    ]],
    [`INSERT INTO product_measurement_events
      (event_id, user_id, event_name, consent_version, occurred_at, local_date, local_week_start)
     VALUES (?, ?, ?, ?, ?, ?, ?)`, [
      'repository-event-other', otherUserId, 'journey_started', 1,
      '2026-01-15T06:31:00.000Z', '2026-01-15', '2026-01-12',
    ]],
  ]);

  const events = await measurementRepository.loadUserEvents({
    userId,
    startInclusive: '2026-01-15T00:00:00.000Z',
    endExclusive: '2026-01-16T00:00:00.000Z',
  });
  assert.equal(events.status, 'confirmed');
  assert.deepEqual(events.records.map((event) => event.eventId), ['repository-event-user']);
  const emptyEvents = await measurementRepository.loadUserEvents({
    userId,
    startInclusive: '2026-02-01T00:00:00.000Z',
    endExclusive: '2026-02-02T00:00:00.000Z',
  });
  assert.deepEqual(emptyEvents, { status: 'confirmed', empty: true, records: [] });

  assert.deepEqual(await measurementRepository.getReportCheckpoint('weekly'), {
    status: 'confirmed',
    empty: true,
    record: null,
  });
  await measurementRepository.advanceReportCheckpoint({
    periodType: 'weekly',
    periodEndExclusive: '2026-02-02T00:00:00.000Z',
  });
  const checkpoint = await measurementRepository.advanceReportCheckpoint({
    periodType: 'weekly',
    periodEndExclusive: '2026-01-26T00:00:00.000Z',
  });
  assert.equal(checkpoint.lastPeriodEndExclusive, '2026-02-02T00:00:00.000Z');

  await measurementRepository.recordSourceOutage({
    sourceName: 'product_measurement_events',
    unavailableStart: '2026-01-15T06:00:00.000Z',
    unavailableEndExclusive: '2026-01-15T07:00:00.000Z',
  });
  const outages = await measurementRepository.loadSourceOutages({
    startInclusive: '2026-01-15T06:30:00.000Z',
    endExclusive: '2026-01-15T08:00:00.000Z',
    sourceNames: ['product_measurement_events'],
  });
  assert.deepEqual(outages.records.map((outage) => outage.sourceName), ['product_measurement_events']);
  assert.deepEqual(await measurementRepository.loadSourceOutages({
    startInclusive: '2026-01-16T00:00:00.000Z',
    endExclusive: '2026-01-17T00:00:00.000Z',
    sourceNames: ['product_measurement_events'],
  }), { status: 'confirmed', empty: true, records: [] });
});

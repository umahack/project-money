import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import fc from 'fast-check';
import request from 'supertest';
import { calculateTripOutcome } from '../../src/domain/trips.js';
import { serializePublicTrip } from '../../src/serializers/publicTrip.js';
import { createIsolatedTestDatabase } from '../helpers/testDatabase.js';

const NUM_RUNS = 100;
const CREATED_AT = '2026-04-01T10:00:00.000Z';
const CHARACTERS = [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 '];
const textArbitrary = fc
  .array(fc.constantFrom(...CHARACTERS), { minLength: 1, maxLength: 18 })
  .map((characters) => characters.join('').trim() || 'x');
const tokenArbitrary = fc
  .tuple(
    fc.integer({ min: 0, max: 0xffffffff }),
    fc.integer({ min: 0, max: 0xffffffff }),
    fc.integer({ min: 0, max: 0xffffffff }),
    fc.integer({ min: 0, max: 0xffffffff })
  )
  .map((parts) => parts.map((part) => part.toString(16).padStart(8, '0')).join(''));

const scenarioArbitrary = fc.record({
  baseId: fc.integer({ min: 1_000, max: 1_000_000 }),
  label: textArbitrary,
  destination: fc.option(textArbitrary, { nil: null }),
  budget: fc.integer({ min: 0, max: 1_000_000 }),
  amount: fc.integer({ min: 1, max: 100_000 }),
  privateNote: textArbitrary,
  tripVersion: fc.integer({ min: 0, max: 1_000_000 }),
  publicToken: tokenArbitrary,
  salaryMinor: fc.integer({ min: 0, max: 1_000_000_000 }),
  billAmountsMinor: fc.array(fc.integer({ min: 0, max: 100_000_000 }), {
    minLength: 0,
    maxLength: 4,
  }),
  personalExpenseAmountsMinor: fc.array(fc.integer({ min: 0, max: 100_000_000 }), {
    minLength: 0,
    maxLength: 4,
  }),
  goalAmountsMinor: fc.array(fc.integer({ min: 1, max: 100_000_000 }), {
    minLength: 0,
    maxLength: 4,
  }),
  arbitraryNestedValue: fc.jsonValue(),
});

let testDatabase;
let db;
let app;
let requestAddressSequence = 0;
let generatedCaseSequence = 0;

function sortedKeys(value) {
  return Object.keys(value).sort();
}

function assertKeys(value, expected) {
  assert.deepEqual(sortedKeys(value), [...expected].sort());
}

function allKeys(value, result = []) {
  if (!value || typeof value !== 'object') return result;
  for (const [key, child] of Object.entries(value)) {
    result.push(key);
    allKeys(child, result);
  }
  return result;
}

function identifiers(scenario) {
  return {
    userId: scenario.baseId,
    sessionId: scenario.baseId + 1_000_001,
    tripId: scenario.baseId + 2_000_002,
    ownerMemberId: scenario.baseId + 3_000_003,
    guestMemberId: scenario.baseId + 4_000_004,
    expenseId: scenario.baseId + 5_000_005,
  };
}

function buildPrivateTripModel(scenario) {
  const ids = identifiers(scenario);
  const ownerName = `Owner ${scenario.label}`;
  const guestName = `Guest ${scenario.label}`;
  const ownerEmail = `owner-${scenario.baseId}@example.test`;
  const guestEmail = `guest-${scenario.baseId}@example.test`;
  const privateMarker = `PRIVATE_${scenario.baseId}_${scenario.privateNote}`;
  const financialPlan = {
    salary: { amountMinor: scenario.salaryMinor, user_id: ids.userId },
    bills: scenario.billAmountsMinor.map((amountMinor, index) => ({
      id: ids.tripId + index + 10,
      user_id: ids.userId,
      amountMinor,
      note: privateMarker,
    })),
    personal_expenses: scenario.personalExpenseAmountsMinor.map((amountMinor, index) => ({
      id: ids.tripId + index + 20,
      user_id: ids.userId,
      amountMinor,
      note: privateMarker,
    })),
    goals: scenario.goalAmountsMinor.map((amountMinor, index) => ({
      id: ids.tripId + index + 30,
      user_id: ids.userId,
      targetAmountMinor: amountMinor,
      note: privateMarker,
    })),
  };
  const nestedPrivateFields = {
    owner: {
      id: ids.userId,
      user_id: ids.userId,
      email: ownerEmail,
      session: { token: scenario.publicToken, version: scenario.tripVersion },
    },
    linkage: {
      trip_id: ids.tripId,
      personal_expense_id: ids.expenseId + 1,
      goal_id: ids.expenseId + 2,
      personal_link: { expense_log_id: ids.expenseId + 3 },
    },
    financial_plan: financialPlan,
    notes: [privateMarker, { note: privateMarker }],
    versions: { trip_version: scenario.tripVersion, data_version: scenario.tripVersion + 1 },
    tokens: { public_token: scenario.publicToken, session_token: scenario.publicToken },
    arbitrary: scenario.arbitraryNestedValue,
  };

  const trip = {
    id: ids.tripId,
    user_id: ids.userId,
    owner_id: ids.userId,
    name: `Trip ${scenario.label}`,
    destination: scenario.destination,
    budget: scenario.budget,
    start_date: '2026-04-01',
    end_date: '2026-04-05',
    public_token: scenario.publicToken,
    public_enabled: 1,
    trip_version: scenario.tripVersion,
    version: scenario.tripVersion,
    note: privateMarker,
    private_notes: privateMarker,
    financial_plan: financialPlan,
    journey: { id: ids.tripId + 40, current_step_key: privateMarker },
    analytics: { id: ids.tripId + 41, event: privateMarker },
    personal_link: { id: ids.tripId + 42, expense_log_id: ids.tripId + 43 },
    extra: nestedPrivateFields,
  };
  const members = [
    {
      id: ids.ownerMemberId,
      trip_id: ids.tripId,
      user_id: ids.userId,
      name: ownerName,
      email: ownerEmail,
      note: privateMarker,
      version: scenario.tripVersion,
      token: scenario.publicToken,
      linkage: nestedPrivateFields.linkage,
      financial_plan: financialPlan,
      extra: nestedPrivateFields,
    },
    {
      id: ids.guestMemberId,
      trip_id: ids.tripId,
      user_id: null,
      name: guestName,
      email: guestEmail,
      note: privateMarker,
      version: scenario.tripVersion,
      token: scenario.publicToken,
      linkage: nestedPrivateFields.linkage,
      financial_plan: financialPlan,
      extra: nestedPrivateFields,
    },
  ];
  const split = members.map((member) => ({
    name: member.name,
    share: 1,
    id: member.id,
    trip_id: ids.tripId,
    user_id: member.user_id,
    email: member.email,
    note: privateMarker,
    version: scenario.tripVersion,
    token: scenario.publicToken,
    linkage: nestedPrivateFields.linkage,
    financial_plan: financialPlan,
    extra: nestedPrivateFields,
  }));
  const expenses = [{
    id: ids.expenseId,
    trip_id: ids.tripId,
    user_id: ids.userId,
    payer_member_id: ids.ownerMemberId,
    payer: ownerName,
    description: `Shared ${scenario.label}`,
    amount: scenario.amount,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    split_json: JSON.stringify(split),
    note: privateMarker,
    version: scenario.tripVersion,
    token: scenario.publicToken,
    personal_expense_id: ids.expenseId + 1,
    goal_id: ids.expenseId + 2,
    personal_link: nestedPrivateFields.linkage.personal_link,
    financial_plan: financialPlan,
    extra: nestedPrivateFields,
  }];

  return {
    ids,
    trip,
    members,
    expenses,
    split,
    ownerName,
    guestName,
    ownerEmail,
    guestEmail,
    privateMarker,
  };
}

function assertPublicProjection(response, privateModel) {
  assertKeys(response, ['trip', 'members', 'expenses', 'settlement']);
  assertKeys(response.trip, ['name', 'destination', 'budget', 'start_date', 'end_date']);
  assert.deepEqual(response.trip, {
    name: privateModel.trip.name,
    destination: privateModel.trip.destination,
    budget: privateModel.trip.budget,
    start_date: privateModel.trip.start_date,
    end_date: privateModel.trip.end_date,
  });

  response.members.forEach((member) => {
    assertKeys(member, ['name']);
  });
  assert.deepEqual(
    response.members
      .map((member) => ({ name: member.name }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    privateModel.members
      .map((member) => ({ name: member.name }))
      .sort((left, right) => left.name.localeCompare(right.name))
  );

  assert.equal(response.expenses.length, privateModel.expenses.length);
  response.expenses.forEach((expense, expenseIndex) => {
    assertKeys(expense, ['payer', 'description', 'amount', 'created_at', 'split']);
    assert.equal(expense.payer, privateModel.expenses[expenseIndex].payer);
    assert.equal(expense.description, privateModel.expenses[expenseIndex].description);
    assert.equal(expense.amount, privateModel.expenses[expenseIndex].amount);
    assert.equal(expense.created_at, privateModel.expenses[expenseIndex].created_at);
    assert.equal(expense.split.length, privateModel.split.length);
    expense.split.forEach((entry, splitIndex) => {
      assertKeys(entry, ['name', 'share']);
      assert.deepEqual(entry, {
        name: privateModel.split[splitIndex].name,
        share: privateModel.split[splitIndex].share,
      });
    });
  });

  const expectedSettlementAmount = privateModel.expenses[0].amount / 2;
  assertKeys(response.settlement, ['balances', 'transactions']);
  assertKeys(response.settlement.balances, [privateModel.ownerName, privateModel.guestName]);
  assert.deepEqual(response.settlement.balances, {
    [privateModel.ownerName]: expectedSettlementAmount,
    [privateModel.guestName]: -expectedSettlementAmount,
  });
  response.settlement.transactions.forEach((transaction) => {
    assertKeys(transaction, ['from', 'to', 'amount']);
  });
  assert.deepEqual(
    response.settlement.transactions
      .map((transaction) => ({
        from: transaction.from,
        to: transaction.to,
        amount: transaction.amount,
      }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    [{
      from: privateModel.guestName,
      to: privateModel.ownerName,
      amount: expectedSettlementAmount,
    }]
  );

  const forbiddenKeys = new Set([
    'id',
    'user_id',
    'userId',
    'owner_id',
    'trip_id',
    'payer_member_id',
    'personal_expense_id',
    'goal_id',
    'expense_log_id',
    'split_json',
    'email',
    'note',
    'notes',
    'private_notes',
    'version',
    'trip_version',
    'data_version',
    'token',
    'public_token',
    'session_token',
    'public_enabled',
    'owner',
    'session',
    'linkage',
    'financial_plan',
    'salary',
    'bills',
    'personal_expenses',
    'goals',
    'journey',
    'analytics',
    'personal_link',
    'extra',
    'arbitrary',
    'updated_at',
  ]);
  assert.deepEqual(allKeys(response).filter((key) => forbiddenKeys.has(key)), []);

  const serialized = JSON.stringify(response);
  assert.equal(serialized.includes(privateModel.ownerEmail), false);
  assert.equal(serialized.includes(privateModel.guestEmail), false);
  assert.equal(serialized.includes(privateModel.privateMarker), false);
  assert.equal(serialized.includes(privateModel.trip.public_token), false);
}

async function insertPrivateTrip(privateModel) {
  const { ids, trip, members, expenses } = privateModel;
  await db.prepare(
    `INSERT INTO users
      (id, email, name, password_hash, is_admin, token_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    ids.userId,
    privateModel.ownerEmail,
    privateModel.ownerName,
    'test-only-password-hash',
    0,
    1,
    CREATED_AT
  );
  await db.prepare(
    `INSERT INTO sessions
      (id, user_id, device_label, ip_hash, user_agent, created_at, last_seen_at, revoked_at, revoked_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    ids.sessionId,
    ids.userId,
    'Property test session',
    'test-only-ip-hash',
    'property-test',
    CREATED_AT,
    CREATED_AT,
    null,
    null
  );
  await db.prepare(
    `INSERT INTO trips
      (id, user_id, name, destination, budget, start_date, end_date,
       public_token, public_enabled, trip_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    trip.id,
    trip.user_id,
    trip.name,
    trip.destination,
    trip.budget,
    trip.start_date,
    trip.end_date,
    trip.public_token,
    trip.public_enabled,
    trip.trip_version,
    CREATED_AT,
    CREATED_AT
  );
  for (const member of members) {
    await db.prepare(
      'INSERT INTO trip_members (id, trip_id, user_id, name, email) VALUES (?, ?, ?, ?, ?)'
    ).run(member.id, member.trip_id, member.user_id, member.name, member.email);
  }
  for (const expense of expenses) {
    await db.prepare(
      `INSERT INTO trip_expenses
        (id, trip_id, payer, description, amount, split_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      expense.id,
      expense.trip_id,
      expense.payer,
      expense.description,
      expense.amount,
      expense.split_json,
      expense.created_at,
      expense.updated_at
    );
  }
}

async function readPrivateTripState(tripId) {
  const trip = await db.prepare(
    `SELECT id, user_id, name, destination, budget, start_date, end_date,
            trip_version, created_at, updated_at
       FROM trips WHERE id = ?`
  ).get(tripId);
  const members = await db.prepare(
    'SELECT id, trip_id, user_id, name, email FROM trip_members WHERE trip_id = ? ORDER BY id'
  ).all(tripId);
  const expenses = await db.prepare(
    `SELECT id, trip_id, payer, description, amount, split_json, created_at, updated_at
       FROM trip_expenses WHERE trip_id = ? ORDER BY id`
  ).all(tripId);
  return { trip, members, expenses };
}

function bearerToken(privateModel) {
  return jwt.sign(
    { sub: String(privateModel.ids.userId), tv: 1, sid: privateModel.ids.sessionId },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '5m' }
  );
}

function nextRequestAddress() {
  requestAddressSequence += 1;
  return `203.0.113.${requestAddressSequence}`;
}

function getPublicTrip(token, requestAddress) {
  return request(app)
    .get(`/api/public/trips/${token}`)
    .set('X-Forwarded-For', requestAddress);
}

function assertUnavailable(...responses) {
  for (const response of responses) {
    assert.equal(response.status, 404);
    assert.deepEqual(response.body, { error: 'Not found' });
  }
}

before(async () => {
  testDatabase = await createIsolatedTestDatabase();
  db = testDatabase.db;
  const { createApp } = await import('../../src/app.js');
  app = createApp();
});

after(async () => {
  await testDatabase?.cleanup();
});

// Feature: financial-clarity-experience, Property 24: Public trip serialization reveals only disclosed fields
// **Validates: Requirements 7.15, 11.10, 11.11**
test('Property 24: public trip serialization reveals only disclosed fields', async () => {
  await testDatabase.reset();
  await fc.assert(
    fc.asyncProperty(scenarioArbitrary, async (scenario) => {
      await new Promise((resolve) => setImmediate(resolve));
      generatedCaseSequence += 1;
      const uniqueScenario = {
        ...scenario,
        baseId: generatedCaseSequence * 10_000_000 + scenario.baseId,
        publicToken: `${scenario.publicToken.slice(0, 24)}${generatedCaseSequence
          .toString(16)
          .padStart(8, '0')}`,
      };

      const privateModel = buildPrivateTripModel(uniqueScenario);
      const unchangedPrivateModel = structuredClone(privateModel);
      const calculation = calculateTripOutcome({
        tripId: privateModel.trip.id,
        tripVersion: privateModel.trip.trip_version,
        members: privateModel.members,
        expenses: privateModel.expenses,
      });
      assert.equal(calculation.status, 'available');

      const directProjection = serializePublicTrip({
        trip: privateModel.trip,
        members: privateModel.members,
        expenses: privateModel.expenses,
        calculation,
      });
      assertPublicProjection(directProjection, privateModel);
      assert.deepEqual(privateModel, unchangedPrivateModel);

      await insertPrivateTrip(privateModel);
      const privateDatabaseBefore = await readPrivateTripState(privateModel.trip.id);
      const authorization = `Bearer ${bearerToken(privateModel)}`;
      const requestAddress = nextRequestAddress();

      const initialPublic = await getPublicTrip(privateModel.trip.public_token, requestAddress);
      assert.equal(initialPublic.status, 200);
      assertPublicProjection(initialPublic.body, privateModel);

      const revoke = await request(app)
        .delete(`/api/trips/${privateModel.trip.id}/share`)
        .set('Authorization', authorization)
        .set('X-Forwarded-For', requestAddress);
      assert.equal(revoke.status, 200);
      assert.deepEqual(revoke.body, { ok: true });

      const revoked = await getPublicTrip(privateModel.trip.public_token, requestAddress);
      assertUnavailable(revoked);

      const sharingState = await db.prepare(
        'SELECT public_token, public_enabled FROM trips WHERE id = ?'
      ).get(privateModel.trip.id);
      assert.deepEqual(sharingState, { public_token: null, public_enabled: 0 });
      assert.deepEqual(await readPrivateTripState(privateModel.trip.id), privateDatabaseBefore);
      await new Promise((resolve) => setImmediate(resolve));
    }),
    { numRuns: NUM_RUNS }
  );
});

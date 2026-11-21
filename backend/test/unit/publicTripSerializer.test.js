import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateTripOutcome } from '../../src/domain/trips.js';
import { PUBLIC_TRIP_DISCLOSURE, serializePublicTrip } from '../../src/serializers/publicTrip.js';

function allKeys(value, result = []) {
  if (!value || typeof value !== 'object') return result;
  for (const [key, child] of Object.entries(value)) {
    result.push(key);
    allKeys(child, result);
  }
  return result;
}

test('public trip serializer returns only display fields and canonical settlement math', () => {
  const trip = {
    id: 8101,
    user_id: 7001,
    name: 'Public trip',
    destination: 'Mysuru',
    budget: 1000,
    start_date: '2026-03-01',
    end_date: '2026-03-03',
    public_token: '0123456789abcdef0123456789abcdef',
    public_enabled: 1,
    trip_version: 12,
    private_notes: 'Do not publish this note',
    financial_plan: { salary: 100000 },
  };
  const members = [
    {
      id: 8201,
      trip_id: trip.id,
      user_id: 7001,
      name: 'Alice',
      email: 'alice@example.test',
      payer_link: { expenseId: 8301 },
    },
    {
      id: 8202,
      trip_id: trip.id,
      user_id: 7002,
      name: 'Bob',
      email: 'bob@example.test',
    },
  ];
  const expenses = [{
    id: 8301,
    trip_id: trip.id,
    payer: 'Alice',
    payer_member_id: members[0].id,
    description: 'Shared fare',
    amount: 0.01,
    created_at: '2026-03-01T10:00:00.000Z',
    split_json: JSON.stringify([
      { name: 'Alice', share: 1, user_id: 7001, email: 'alice@example.test' },
      { name: 'Bob', share: 1, user_id: 7002, private_note: 'hidden' },
    ]),
    note: 'Private expense note',
    version: 4,
    source_references: [{ recordId: 8301 }],
    personal_link: { expense_log_id: 9901 },
  }];
  const calculation = calculateTripOutcome({
    tripId: trip.id,
    tripVersion: trip.trip_version,
    members,
    expenses,
  });

  const response = serializePublicTrip({ trip, members, expenses, calculation });

  assert.deepEqual(response, {
    trip: {
      name: 'Public trip',
      destination: 'Mysuru',
      budget: 1000,
      start_date: '2026-03-01',
      end_date: '2026-03-03',
    },
    members: [{ name: 'Alice' }, { name: 'Bob' }],
    expenses: [{
      payer: 'Alice',
      description: 'Shared fare',
      amount: 0.01,
      created_at: '2026-03-01T10:00:00.000Z',
      split: [{ name: 'Alice', share: 1 }, { name: 'Bob', share: 1 }],
    }],
    settlement: {
      balances: { Alice: 0.01, Bob: -0.01 },
      transactions: [{ from: 'Bob', to: 'Alice', amount: 0.01 }],
    },
  });

  const forbiddenKeys = new Set([
    'id',
    'user_id',
    'trip_id',
    'payer_member_id',
    'split_json',
    'note',
    'private_note',
    'private_notes',
    'version',
    'trip_version',
    'source_references',
    'recordId',
    'public_token',
    'public_enabled',
    'email',
    'payer_link',
    'personal_link',
    'financial_plan',
    'expense_log_id',
  ]);
  assert.deepEqual(allKeys(response).filter((key) => forbiddenKeys.has(key)), []);
  assert.equal(JSON.stringify(response).includes('Do not publish this note'), false);
  assert.equal(JSON.stringify(response).includes('alice@example.test'), false);
});

// Describes each leaf the serializer emitted: `[]` for one array element and `*`
// for a member-name key, the notation used by PUBLIC_TRIP_DISCLOSURE.
function emittedPaths(value, prefix = '', result = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) emittedPaths(item, `${prefix}[]`, result);
    return result;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const segment = prefix === 'settlement.balances' ? '*' : key;
      emittedPaths(child, prefix ? `${prefix}.${segment}` : segment, result);
    }
    return result;
  }
  result.add(prefix);
  return result;
}

test('public-field disclosure lists exactly the keys the serializer emits', () => {
  const trip = {
    id: 1, user_id: 2, name: 'T', destination: 'D', budget: 10,
    start_date: '2026-03-01', end_date: '2026-03-02', trip_version: 1, public_token: 'x',
  };
  const members = [
    { id: 11, name: 'Alice', email: 'a@example.test', user_id: 2 },
    { id: 12, name: 'Bob', email: 'b@example.test' },
  ];
  const expenses = [{
    id: 21, payer: 'Alice', description: 'Fare', amount: 4, note: 'private',
    created_at: '2026-03-01T10:00:00.000Z',
    split_json: JSON.stringify([{ name: 'Alice', share: 1, email: 'a@example.test' }, { name: 'Bob', share: 1 }]),
  }];
  const calculation = calculateTripOutcome({ tripId: 1, tripVersion: 1, members, expenses });
  assert.equal(calculation.status, 'available');
  const response = serializePublicTrip({ trip, members, expenses, calculation });

  const described = PUBLIC_TRIP_DISCLOSURE.groups.flatMap((group) => group.fields.map((field) => field.path));
  assert.equal(new Set(described).size, described.length, 'no field is described twice');
  assert.deepEqual([...emittedPaths(response)].sort(), [...described].sort());
  for (const group of PUBLIC_TRIP_DISCLOSURE.groups) {
    assert.ok(group.title && group.fields.length > 0);
    for (const field of group.fields) assert.ok(field.label.trim().length > 0);
  }
  assert.ok(PUBLIC_TRIP_DISCLOSURE.private.length > 0);
  assert.ok(Object.isFrozen(PUBLIC_TRIP_DISCLOSURE) && Object.isFrozen(PUBLIC_TRIP_DISCLOSURE.groups[0].fields[0]));
});

test('public trip serializer withholds invalid canonical balances without exposing errors', () => {
  const trip = {
    id: 8401,
    name: 'Invalid stored trip',
    destination: null,
    budget: 50,
    start_date: null,
    end_date: null,
    trip_version: 3,
  };
  const members = [{ id: 8402, name: 'Alice' }];
  const expenses = [{
    id: 8403,
    payer: 'Alice',
    description: 'Broken expense',
    amount: 10,
    created_at: '2026-03-01T10:00:00.000Z',
    split_json: '{not-json',
  }];
  const calculation = calculateTripOutcome({
    tripId: trip.id,
    tripVersion: trip.trip_version,
    members,
    expenses,
  });

  const response = serializePublicTrip({ trip, members, expenses, calculation });

  assert.equal(calculation.status, 'invalid_input');
  assert.deepEqual(response.expenses[0].split, []);
  assert.deepEqual(response.settlement, { balances: {}, transactions: [] });
  assert.equal('status' in response, false);
  assert.equal(JSON.stringify(response).includes('INVALID_SPLIT_JSON'), false);
  assert.equal(JSON.stringify(response).includes('recordId'), false);
});

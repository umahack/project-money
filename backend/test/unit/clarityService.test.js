import test from 'node:test';
import assert from 'node:assert/strict';
import { ClarityService } from '../../src/services/clarityService.js';
import { calculateGoal } from '../../src/domain/goals.js';
import { calculateTripOutcome } from '../../src/domain/trips.js';

const NOW = new Date('2026-01-15T06:30:00.000Z');
const MONTH = '2026-01';
const USER_ID = 11;

function confirmedRecord(record = null) {
  return { status: 'confirmed', empty: record === null, record };
}

function confirmedCollection(records = []) {
  return { status: 'confirmed', empty: records.length === 0, records };
}

function salary(overrides = {}) {
  return {
    id: 1,
    userId: USER_ID,
    month: MONTH,
    amountMinor: 100_000,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    normalizationIssues: [],
    ...overrides,
  };
}

function bill(overrides = {}) {
  return {
    id: 2,
    userId: USER_ID,
    label: 'Rent',
    category: 'Housing',
    active: true,
    effectiveFromMonth: null,
    effectiveToMonth: null,
    amountMinor: 20_000,
    createdAt: '2026-01-02T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    normalizationIssues: [],
    ...overrides,
  };
}

function expense(overrides = {}) {
  return {
    id: 3,
    userId: USER_ID,
    month: MONTH,
    category: 'Groceries',
    note: null,
    spentOn: '2026-01-10',
    amountMinor: 10_000,
    createdAt: '2026-01-10T00:00:00.000Z',
    updatedAt: '2026-01-10T00:00:00.000Z',
    normalizationIssues: [],
    ...overrides,
  };
}

function goal(overrides = {}) {
  return {
    id: 21,
    userId: USER_ID,
    name: 'Emergency fund',
    targetAmountMinor: 120_000,
    savedAmountMinor: 60_000,
    targetDate: '2026-06-30',
    createdAt: '2026-01-03T00:00:00.000Z',
    updatedAt: '2026-01-03T00:00:00.000Z',
    normalizationIssues: [],
    ...overrides,
  };
}

function tripFixture({ tripId = 31, memberBase = 100 } = {}) {
  const ownerMemberId = memberBase + 1;
  const otherMemberId = memberBase + 2;
  const trip = {
    id: tripId,
    ownerUserId: USER_ID,
    name: `Trip ${tripId}`,
    destination: null,
    budgetMinor: 50_000,
    startDate: '2026-01-01',
    endDate: '2026-01-20',
    publicEnabled: false,
    tripVersion: 2,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-11T00:00:00.000Z',
    role: 'owner',
    normalizationIssues: [],
  };
  const members = [
    { id: ownerMemberId, tripId, userId: USER_ID, name: `Owner ${tripId}`, email: null },
    { id: otherMemberId, tripId, userId: null, name: `Friend ${tripId}`, email: null },
  ];
  const expenses = [{
    id: tripId * 10,
    tripId,
    payer: `Owner ${tripId}`,
    description: 'Lodging',
    amountMinor: 10_000,
    splitStatus: 'confirmed',
    split: [
      { name: `Owner ${tripId}`, share: 1 },
      { name: `Friend ${tripId}`, share: 1 },
    ],
    splitIssue: null,
    createdAt: '2026-01-11T00:00:00.000Z',
    updatedAt: '2026-01-11T00:00:00.000Z',
    normalizationIssues: [],
  }];
  return {
    trip,
    ledger: {
      status: 'confirmed',
      role: 'owner',
      trip,
      members: confirmedCollection(members),
      expenses: confirmedCollection(expenses),
    },
  };
}

function createRepository({
  dataVersion = 7,
  period = {
    status: 'confirmed',
    month: MONTH,
    salary: confirmedRecord(),
    bills: confirmedCollection(),
    expenses: confirmedCollection(),
    categoryTreatments: confirmedCollection(),
  },
  goals = [],
  trips = [],
  ledgers = new Map(),
  failures = {},
} = {}) {
  return {
    async getDataVersion() {
      if (failures.dataVersion) throw failures.dataVersion;
      return dataVersion;
    },
    async loadPeriod() {
      if (failures.period) throw failures.period;
      return structuredClone(period);
    },
    async loadGoals() {
      if (failures.goals) throw failures.goals;
      return structuredClone(confirmedCollection(goals));
    },
    async listAccessibleTrips() {
      if (failures.trips) throw failures.trips;
      return structuredClone(confirmedCollection(trips));
    },
    async loadAccessibleTripLedger({ tripId }) {
      if (failures.tripLedgers?.has(tripId)) throw failures.tripLedgers.get(tripId);
      return structuredClone(ledgers.get(tripId) ?? null);
    },
  };
}

function populatedRepository(overrides = {}) {
  const trip = tripFixture();
  return createRepository({
    period: {
      status: 'confirmed',
      month: MONTH,
      salary: confirmedRecord(salary()),
      bills: confirmedCollection([bill()]),
      expenses: confirmedCollection([expense()]),
      categoryTreatments: confirmedCollection(),
    },
    goals: [goal()],
    trips: [trip.trip],
    ledgers: new Map([[trip.trip.id, trip.ledger]]),
    ...overrides,
  });
}

async function snapshot(service) {
  return service.getSnapshot({
    userId: USER_ID,
    month: MONTH,
    now: NOW,
    timeZone: 'Asia/Kolkata',
  });
}

test('empty confirmed collections produce exact-period independent outcomes', async () => {
  const result = await snapshot(new ClarityService({ repository: createRepository() }));

  assert.equal(result.dataVersion, 7);
  assert.equal(result.generatedAt, NOW.toISOString());
  assert.deepEqual(result.period, {
    month: MONTH,
    timeZone: 'Asia/Kolkata',
    start: '2026-01-01',
    endExclusive: '2026-02-01',
    asOfDate: '2026-01-15',
    daysRemainingInclusive: 17,
  });
  assert.deepEqual(result.facts, []);
  assert.equal(result.outcomes.monthlyPlan.status, 'missing_input');
  assert.deepEqual(result.outcomes.monthlyPlan.missing, [{
    input: 'salary',
    unlocks: ['monthly_plan', 'spending'],
  }]);
  assert.equal(result.outcomes.spending.status, 'missing_input');
  assert.deepEqual(result.outcomes.goals, []);
  assert.equal(result.outcomes.tripSummary.status, 'available');
  assert.deepEqual(result.outcomes.tripSummary.value, []);
  assert.deepEqual(result.outcomes.tripSummary.items, []);
  assert.deepEqual(result.actions, []);
  assert.deepEqual(result.highlights, { urgentGoal: null, nearestTripSettlement: null });
});

test('populated confirmed records produce monthly, spending, goal, trip, and ranked action results', async () => {
  const result = await snapshot(new ClarityService({ repository: populatedRepository() }));

  assert.equal(result.outcomes.monthlyPlan.status, 'available');
  assert.deepEqual(result.outcomes.monthlyPlan.value.disposableIncome, {
    currency: 'INR',
    amountMinor: 80_000,
  });
  assert.deepEqual(result.outcomes.monthlyPlan.value.remainingSpendable, {
    currency: 'INR',
    amountMinor: 54_000,
  });
  assert.deepEqual(result.outcomes.monthlyPlan.value.dailySpendingGuide, {
    currency: 'INR',
    amountMinor: 3_176,
  });

  assert.equal(result.outcomes.spending.status, 'available');
  assert.deepEqual(result.outcomes.spending.value.categoryTotals, [{
    month: MONTH,
    category: 'Groceries',
    total: { currency: 'INR', amountMinor: 10_000 },
    expenseIds: [3],
  }]);
  assert.deepEqual(result.outcomes.spending.value.projectedSavingsDifference, {
    currency: 'INR',
    amountMinor: 54_000,
  });

  assert.equal(result.outcomes.goals[0].status, 'available');
  assert.deepEqual(result.outcomes.goals[0].value.requiredContribution, {
    currency: 'INR',
    amountMinor: 10_000,
  });
  assert.equal(result.outcomes.goals[0].value.feasibility, 'feasible');

  assert.equal(result.outcomes.tripSummary.status, 'available');
  assert.equal(result.outcomes.tripSummary.items[0].status, 'available');
  assert.deepEqual(result.outcomes.tripSummary.value[0].balances, [
    { memberId: 101, amountMinor: 5_000, label: 'receivable' },
    { memberId: 102, amountMinor: -5_000, label: 'owed' },
  ]);
  assert.deepEqual(result.actions.map(({ conditionCode }) => conditionCode), [
    'goal_funding_gap',
    'trip_balance_receivable',
  ]);
  assert.ok(result.actions.every(({ disclaimer }) => (
    disclaimer === 'Informational guidance, not a guaranteed financial result.'
  )));
  assert.deepEqual(result.highlights, {
    urgentGoal: {
      goalId: 21,
      name: 'Emergency fund',
      status: 'active',
      targetDate: result.highlights.urgentGoal.targetDate,
      fundingGap: { currency: 'INR', amountMinor: 60_000 },
    },
    nearestTripSettlement: {
      tripId: 31,
      name: 'Trip 31',
      userBalance: { currency: 'INR', amountMinor: 5_000 },
      label: 'receivable',
    },
  });
  assert.ok(result.facts.length >= 7);
  assert.ok(result.facts.every(({ classification, source }) => (
    classification === 'entered_fact' && source.classification === 'entered_fact'
  )));
});

test('calculator failures affect only their outcomes and retain confirmed facts', async () => {
  const failedTrip = tripFixture({ tripId: 31, memberBase: 100 });
  const availableTrip = tripFixture({ tripId: 32, memberBase: 200 });
  const repository = populatedRepository({
    goals: [
      goal({ id: 21, name: 'Broken calculator goal' }),
      goal({ id: 22, name: 'Available goal', targetDate: '2026-07-31' }),
    ],
    trips: [failedTrip.trip, availableTrip.trip],
    ledgers: new Map([
      [failedTrip.trip.id, failedTrip.ledger],
      [availableTrip.trip.id, availableTrip.ledger],
    ]),
  });
  const service = new ClarityService({
    repository,
    expenseSummaryCalculator() {
      throw new Error('injected spending calculator failure');
    },
    goalCalculator(input) {
      if (input.goal.id === 21) throw new Error('injected goal calculator failure');
      return calculateGoal(input);
    },
    tripOutcomeCalculator(input) {
      if (input.tripId === 31) throw new Error('injected trip calculator failure');
      return calculateTripOutcome(input);
    },
  });

  const result = await snapshot(service);

  assert.equal(result.outcomes.monthlyPlan.status, 'available');
  assert.equal(result.outcomes.spending.status, 'calculation_failed');
  assert.equal(result.outcomes.spending.confirmedInputsRetained, true);
  assert.deepEqual(result.outcomes.goals.map(({ status }) => status), [
    'calculation_failed',
    'available',
  ]);
  assert.deepEqual(result.outcomes.tripSummary.items.map(({ status }) => status), [
    'calculation_failed',
    'available',
  ]);
  assert.equal(result.outcomes.tripSummary.status, 'available');
  assert.equal(result.outcomes.tripSummary.value.length, 1);
  assert.ok(result.facts.some(({ source }) => source.ref === 'expense:3:amountMinor'));
  assert.ok(result.facts.some(({ source }) => source.ref === 'goal:21:targetAmountMinor'));
  assert.ok(result.facts.some(({ source }) => source.ref === 'trip_expense:310:amountMinor'));
});

test('a goal repository failure does not suppress confirmed monthly, spending, or trip outcomes', async () => {
  const repository = populatedRepository({
    failures: { goals: new Error('injected goals repository failure') },
  });
  const result = await snapshot(new ClarityService({ repository }));

  assert.equal(result.outcomes.monthlyPlan.status, 'available');
  assert.equal(result.outcomes.spending.status, 'available');
  assert.equal(result.outcomes.goals.length, 1);
  assert.equal(result.outcomes.goals[0].id, `goals:${MONTH}`);
  assert.equal(result.outcomes.goals[0].status, 'calculation_failed');
  assert.equal(result.outcomes.tripSummary.status, 'available');
  assert.equal(result.outcomes.tripSummary.items[0].status, 'available');
  assert.deepEqual(result.actions.map(({ conditionCode }) => conditionCode), [
    'trip_balance_receivable',
  ]);
});

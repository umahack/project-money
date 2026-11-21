import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {
  rankGoals,
  rankTrips,
  selectHighestUrgencyGoal,
  selectNearestTripSettlement,
} from '../../src/domain/insights.js';

const NUM_RUNS = 200;
const SHUFFLE_MODULUS = 2_147_483_647n;
const SHUFFLE_MULTIPLIER = 48_271n;

function normalizeName(name) {
  return name.normalize('NFKC').toLocaleLowerCase('en-IN');
}

function compareNames(left, right) {
  return left.localeCompare(right, 'en-IN', {
    sensitivity: 'variant',
    usage: 'sort',
  });
}

function referenceGoalComparator(left, right) {
  const overdueOrder = Number(right.status === 'overdue')
    - Number(left.status === 'overdue');
  if (overdueOrder !== 0) return overdueOrder;

  const dateOrder = Date.parse(left.targetDate) - Date.parse(right.targetDate);
  if (dateOrder !== 0) return dateOrder;

  const gapOrder = right.fundingGapMinor - left.fundingGapMinor;
  if (gapOrder !== 0) return gapOrder;

  const nameOrder = compareNames(
    normalizeName(left.name),
    normalizeName(right.name)
  );
  if (nameOrder !== 0) return nameOrder;

  return left.goalId - right.goalId;
}

function referenceTripComparator(left, right) {
  const balanceOrder = Math.abs(right.userBalanceMinor)
    - Math.abs(left.userBalanceMinor);
  if (balanceOrder !== 0) return balanceOrder;

  const timeOrder = Date.parse(left.earliestUnsettledAt)
    - Date.parse(right.earliestUnsettledAt);
  if (timeOrder !== 0) return timeOrder;

  const nameOrder = compareNames(
    normalizeName(left.name),
    normalizeName(right.name)
  );
  if (nameOrder !== 0) return nameOrder;

  return left.tripId - right.tripId;
}

function shuffleWithSeed(values, seed) {
  const shuffled = [...values];
  let state = BigInt(seed);

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    state = (state * SHUFFLE_MULTIPLIER) % SHUFFLE_MODULUS;
    const swapIndex = Number(state % BigInt(index + 1));
    [shuffled[index], shuffled[swapIndex]] = [
      shuffled[swapIndex],
      shuffled[index],
    ];
  }

  return shuffled;
}

function assertBefore(rankedIds, higherUrgencyId, lowerUrgencyId) {
  assert.ok(
    rankedIds.indexOf(higherUrgencyId) < rankedIds.indexOf(lowerUrgencyId),
    `expected ${higherUrgencyId} before ${lowerUrgencyId}`
  );
}

const nameArbitrary = fc
  .tuple(
    fc.constantFrom(
      'Alpha',
      'beta',
      'Éclair',
      'E\u0301clair',
      'Ａlpha',
      'Goal',
      'Trip',
      'यात्रा'
    ),
    fc.integer({ min: 0, max: 10_000 })
  )
  .map(([prefix, suffix]) => `${prefix} ${suffix}`);

const dateArbitrary = fc
  .record({
    year: fc.integer({ min: 2024, max: 2090 }),
    month: fc.integer({ min: 1, max: 12 }),
    day: fc.integer({ min: 1, max: 28 }),
  })
  .map(({ year, month, day }) => (
    `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  ));

const instantArbitrary = fc
  .record({
    date: dateArbitrary,
    hour: fc.integer({ min: 0, max: 23 }),
    minute: fc.integer({ min: 0, max: 59 }),
    second: fc.integer({ min: 0, max: 59 }),
  })
  .map(({ date, hour, minute, second }) => (
    `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}.000Z`
  ));

const noiseGoalArbitrary = fc.record({
  name: nameArbitrary,
  targetDate: dateArbitrary,
  fundingGapMinor: fc.integer({ min: 1, max: 1_000_000_000 }),
  status: fc.constantFrom('active', 'overdue'),
});

const nonZeroBalanceArbitrary = fc
  .tuple(
    fc.integer({ min: 1, max: 1_000_000_000 }),
    fc.constantFrom(-1, 1)
  )
  .map(([magnitude, sign]) => magnitude * sign);

const noiseTripArbitrary = fc.record({
  name: nameArbitrary,
  userBalanceMinor: nonZeroBalanceArbitrary,
  earliestUnsettledAt: instantArbitrary,
});

const comparatorGoalFixtures = [
  {
    goalId: 2,
    name: 'Zulu status winner',
    targetDate: '2090-12-31',
    fundingGapMinor: 1,
    status: 'overdue',
  },
  {
    goalId: 1,
    name: 'Alpha status loser',
    targetDate: '2024-01-01',
    fundingGapMinor: 1_000_000_000,
    status: 'active',
  },
  {
    goalId: 4,
    name: 'Zulu date winner',
    targetDate: '2025-01-01',
    fundingGapMinor: 1,
    status: 'active',
  },
  {
    goalId: 3,
    name: 'Alpha date loser',
    targetDate: '2025-02-01',
    fundingGapMinor: 1_000_000_000,
    status: 'active',
  },
  {
    goalId: 6,
    name: 'Zulu gap winner',
    targetDate: '2026-01-01',
    fundingGapMinor: 2_000,
    status: 'active',
  },
  {
    goalId: 5,
    name: 'Alpha gap loser',
    targetDate: '2026-01-01',
    fundingGapMinor: 1_000,
    status: 'active',
  },
  {
    goalId: 8,
    name: 'Ａlpha name winner',
    targetDate: '2027-01-01',
    fundingGapMinor: 3_000,
    status: 'active',
  },
  {
    goalId: 7,
    name: 'beta name loser',
    targetDate: '2027-01-01',
    fundingGapMinor: 3_000,
    status: 'active',
  },
  {
    goalId: 9,
    name: 'Ｔie goal',
    targetDate: '2028-01-01',
    fundingGapMinor: 4_000,
    status: 'active',
  },
  {
    goalId: 10,
    name: 'tie goal',
    targetDate: '2028-01-01',
    fundingGapMinor: 4_000,
    status: 'active',
  },
];

const comparatorTripFixtures = [
  {
    tripId: 2,
    name: 'Zulu balance winner',
    userBalanceMinor: -200,
    earliestUnsettledAt: '2029-12-31T23:59:59.000Z',
  },
  {
    tripId: 1,
    name: 'Alpha balance loser',
    userBalanceMinor: 100,
    earliestUnsettledAt: '2024-01-01T00:00:00.000Z',
  },
  {
    tripId: 4,
    name: 'Zulu time winner',
    userBalanceMinor: 300,
    earliestUnsettledAt: '2025-01-01T00:00:00.000Z',
  },
  {
    tripId: 3,
    name: 'Alpha time loser',
    userBalanceMinor: -300,
    earliestUnsettledAt: '2025-02-01T00:00:00.000Z',
  },
  {
    tripId: 6,
    name: 'Ａlpha name winner',
    userBalanceMinor: -400,
    earliestUnsettledAt: '2026-01-01T00:00:00.000Z',
  },
  {
    tripId: 5,
    name: 'beta name loser',
    userBalanceMinor: 400,
    earliestUnsettledAt: '2026-01-01T00:00:00.000Z',
  },
  {
    tripId: 7,
    name: 'Ｔie trip',
    userBalanceMinor: 500,
    earliestUnsettledAt: '2027-01-01T00:00:00.000Z',
  },
  {
    tripId: 8,
    name: 'tie trip',
    userBalanceMinor: -500,
    earliestUnsettledAt: '2027-01-01T00:00:00.000Z',
  },
];

const urgencyScenarioArbitrary = fc
  .record({
    noiseGoals: fc.array(noiseGoalArbitrary, { minLength: 0, maxLength: 12 }),
    noiseTrips: fc.array(noiseTripArbitrary, { minLength: 0, maxLength: 12 }),
    goalShuffleSeed: fc.integer({ min: 1, max: 2_147_483_646 }),
    tripShuffleSeed: fc.integer({ min: 1, max: 2_147_483_646 }),
  })
  .map(({ noiseGoals, noiseTrips, goalShuffleSeed, tripShuffleSeed }) => {
    const goals = [
      ...comparatorGoalFixtures,
      ...noiseGoals.map((goal, index) => ({
        goalId: 1_000 + index,
        ...goal,
      })),
    ];
    const trips = [
      ...comparatorTripFixtures,
      ...noiseTrips.map((trip, index) => ({
        tripId: 1_000 + index,
        ...trip,
      })),
    ];

    return {
      goals: shuffleWithSeed(goals, goalShuffleSeed),
      trips: shuffleWithSeed(trips, tripShuffleSeed),
      alternateGoals: shuffleWithSeed(goals, tripShuffleSeed),
      alternateTrips: shuffleWithSeed(trips, goalShuffleSeed),
    };
  });

// Feature: financial-clarity-experience, Property 15: Urgent goal and trip selection is deterministic
// **Validates: Requirements 8.4, 8.5, 8.6, 8.7**
test('Property 15: urgent goal and trip selection is deterministic', () => {
  fc.assert(
    fc.property(urgencyScenarioArbitrary, (scenario) => {
      const expectedGoals = [...scenario.goals].sort(referenceGoalComparator);
      const expectedTrips = [...scenario.trips].sort(referenceTripComparator);
      const expectedGoalIds = expectedGoals.map(({ goalId }) => goalId);
      const expectedTripIds = expectedTrips.map(({ tripId }) => tripId);

      const rankedGoals = rankGoals(scenario.goals);
      const rankedTrips = rankTrips(scenario.trips);
      const alternateRankedGoals = rankGoals(scenario.alternateGoals);
      const alternateRankedTrips = rankTrips(scenario.alternateTrips);

      assert.deepEqual(
        rankedGoals.map(({ goalId }) => goalId),
        expectedGoalIds
      );
      assert.deepEqual(
        alternateRankedGoals.map(({ goalId }) => goalId),
        expectedGoalIds
      );
      assert.deepEqual(
        rankedTrips.map(({ tripId }) => tripId),
        expectedTripIds
      );
      assert.deepEqual(
        alternateRankedTrips.map(({ tripId }) => tripId),
        expectedTripIds
      );
      assert.deepEqual(
        selectHighestUrgencyGoal(scenario.goals),
        expectedGoals[0]
      );
      assert.deepEqual(
        selectHighestUrgencyGoal(scenario.alternateGoals),
        expectedGoals[0]
      );
      assert.deepEqual(
        selectNearestTripSettlement(scenario.trips),
        expectedTrips[0]
      );
      assert.deepEqual(
        selectNearestTripSettlement(scenario.alternateTrips),
        expectedTrips[0]
      );

      const rankedGoalIds = rankedGoals.map(({ goalId }) => goalId);
      assertBefore(rankedGoalIds, 2, 1);
      assertBefore(rankedGoalIds, 4, 3);
      assertBefore(rankedGoalIds, 6, 5);
      assertBefore(rankedGoalIds, 8, 7);
      assertBefore(rankedGoalIds, 9, 10);

      const rankedTripIds = rankedTrips.map(({ tripId }) => tripId);
      assertBefore(rankedTripIds, 2, 1);
      assertBefore(rankedTripIds, 4, 3);
      assertBefore(rankedTripIds, 6, 5);
      assertBefore(rankedTripIds, 7, 8);
    }),
    { numRuns: NUM_RUNS }
  );
});

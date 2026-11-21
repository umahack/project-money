import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTION_DISCLAIMER,
  MAX_SUMMARY_ACTIONS,
  buildActionCandidates,
  buildActionSummary,
  compareActions,
  compareGoals,
  compareTrips,
  createActionSummary,
  rankActions,
  rankGoals,
  rankTrips,
  selectHighestUrgencyGoal,
  selectNearestTripSettlement,
} from '../../src/domain/insights.js';

function goal(overrides = {}) {
  return {
    goalId: 1,
    name: 'Emergency fund',
    targetDate: '2026-06-30',
    fundingGapMinor: 10_000,
    status: 'active',
    ...overrides,
  };
}

function trip(overrides = {}) {
  return {
    tripId: 1,
    name: 'Weekend trip',
    userBalanceMinor: -10_000,
    earliestUnsettledAt: '2026-01-10T08:00:00.000Z',
    ...overrides,
  };
}

function action(overrides = {}) {
  return {
    id: 'action:test',
    conditionCode: 'test_condition',
    observation: 'A condition applies.',
    actionKey: 'test_action',
    actionLabel: 'Review action',
    expectedEffect: 'Completing the action addresses the condition.',
    route: '/plan',
    context: {},
    disclaimer: ACTION_DISCLAIMER,
    ...overrides,
  };
}

function permutations(values) {
  if (values.length <= 1) return [values];
  return values.flatMap((value, index) => permutations([
    ...values.slice(0, index),
    ...values.slice(index + 1),
  ]).map((remaining) => [value, ...remaining]));
}

test('goal ranking applies overdue, date, gap, normalized name, and ID levels', () => {
  assert.ok(compareGoals(
    goal({ goalId: 1, status: 'overdue', targetDate: '2026-12-31' }),
    goal({ goalId: 2, status: 'active', targetDate: '2026-01-01' })
  ) < 0);
  assert.ok(compareGoals(
    goal({ goalId: 1, targetDate: '2026-05-31', fundingGapMinor: 1 }),
    goal({ goalId: 2, targetDate: '2026-06-01', fundingGapMinor: 99_999 })
  ) < 0);
  assert.ok(compareGoals(
    goal({ goalId: 1, fundingGapMinor: 20_000 }),
    goal({ goalId: 2, fundingGapMinor: 10_000 })
  ) < 0);
  assert.ok(compareGoals(
    goal({ goalId: 1, name: 'Ａlpha' }),
    goal({ goalId: 2, name: 'beta' })
  ) < 0);
  assert.ok(compareGoals(
    goal({ goalId: 1, name: 'SAME' }),
    goal({ goalId: 2, name: 'same' })
  ) < 0);

  const ranked = rankGoals([
    goal({ goalId: 9, status: 'funded', fundingGapMinor: 0 }),
    goal({ goalId: 4, name: 'Later', targetDate: '2026-07-01' }),
    goal({ goalId: 3, name: 'Overdue', status: 'overdue', targetDate: '2026-01-01' }),
    goal({ goalId: 8, name: 'Zero gap', fundingGapMinor: 0 }),
  ]);
  assert.deepEqual(ranked.map(({ goalId }) => goalId), [3, 4]);
  assert.equal(selectHighestUrgencyGoal(ranked).goalId, 3);
});

test('trip ranking applies absolute balance, time, normalized name, and ID levels', () => {
  assert.ok(compareTrips(
    trip({ tripId: 1, userBalanceMinor: -20_000, earliestUnsettledAt: '2026-12-01T00:00:00Z' }),
    trip({ tripId: 2, userBalanceMinor: 10_000, earliestUnsettledAt: '2026-01-01T00:00:00Z' })
  ) < 0);
  assert.ok(compareTrips(
    trip({ tripId: 1, earliestUnsettledAt: '2026-01-01T00:00:00+05:30' }),
    trip({ tripId: 2, earliestUnsettledAt: '2026-01-01T00:00:00Z' })
  ) < 0);
  assert.ok(compareTrips(
    trip({ tripId: 1, name: 'Ａgra' }),
    trip({ tripId: 2, name: 'Beach' })
  ) < 0);
  assert.ok(compareTrips(
    trip({ tripId: 1, name: 'SAME' }),
    trip({ tripId: 2, name: 'same' })
  ) < 0);

  const ranked = rankTrips([
    trip({ tripId: 5, name: 'Settled', userBalanceMinor: 0, earliestUnsettledAt: null }),
    trip({ tripId: 3, name: 'Smaller', userBalanceMinor: -500 }),
    trip({ tripId: 4, name: 'Larger', userBalanceMinor: 800 }),
  ]);
  assert.deepEqual(ranked.map(({ tripId }) => tripId), [4, 3]);
  assert.equal(selectNearestTripSettlement(ranked).tripId, 4);
});

test('action ranking applies every priority level and stable tie-breaker', () => {
  const deadline = '2026-06-30';
  const samePriority = {
    deadline,
    shortfall: { currency: 'INR', amountMinor: 1_000 },
    effect: { currency: 'INR', amountMinor: 500 },
    actionLabel: 'Same label',
  };

  assert.ok(compareActions(
    action({ id: 'deadline', deadline: '2026-12-31' }),
    action({ id: 'no-deadline', shortfall: { currency: 'INR', amountMinor: 999_999 } })
  ) < 0);
  assert.ok(compareActions(
    action({ id: 'earlier', deadline: '2026-05-01' }),
    action({ id: 'later', deadline: '2026-06-01', shortfall: { currency: 'INR', amountMinor: 999_999 } })
  ) < 0);
  assert.ok(compareActions(
    action({ id: 'larger-shortfall', deadline, shortfall: { currency: 'INR', amountMinor: 2_000 } }),
    action({ id: 'smaller-shortfall', deadline, shortfall: { currency: 'INR', amountMinor: 1_000 }, effect: { currency: 'INR', amountMinor: 99_999 } })
  ) < 0);
  assert.ok(compareActions(
    action({ id: 'larger-effect', ...samePriority, effect: { currency: 'INR', amountMinor: -600 } }),
    action({ id: 'smaller-effect', ...samePriority })
  ) < 0);
  assert.ok(compareActions(
    action({ id: 'alpha-label', ...samePriority, actionLabel: 'Ａlpha' }),
    action({ id: 'beta-label', ...samePriority, actionLabel: 'beta' })
  ) < 0);
  assert.ok(compareActions(
    action({ id: 'alpha-key', ...samePriority, actionKey: 'alpha' }),
    action({ id: 'beta-key', ...samePriority, actionKey: 'beta' })
  ) < 0);
  assert.ok(compareActions(
    action({ id: 'action:a', ...samePriority }),
    action({ id: 'action:b', ...samePriority })
  ) < 0);
});

test('goal, trip, and action ranking are invariant across input permutations', () => {
  const goals = [
    goal({ goalId: 4, name: 'Zulu', targetDate: '2026-05-01', fundingGapMinor: 200 }),
    goal({ goalId: 2, name: 'Alpha', targetDate: '2026-05-01', fundingGapMinor: 200 }),
    goal({ goalId: 3, name: 'Overdue', status: 'overdue', targetDate: '2026-01-01' }),
    goal({ goalId: 1, name: 'Soon', targetDate: '2026-04-01' }),
  ];
  const trips = [
    trip({ tripId: 4, name: 'Zulu', userBalanceMinor: 100 }),
    trip({ tripId: 2, name: 'Alpha', userBalanceMinor: -100 }),
    trip({ tripId: 3, name: 'Earlier', userBalanceMinor: 100, earliestUnsettledAt: '2026-01-01T00:00:00Z' }),
    trip({ tripId: 1, name: 'Largest', userBalanceMinor: -200 }),
  ];
  const actions = [
    action({ id: 'd', actionKey: 'd', actionLabel: 'Delta' }),
    action({ id: 'a', actionKey: 'a', actionLabel: 'Alpha' }),
    action({ id: 'deadline', actionKey: 'z', actionLabel: 'Zulu', deadline: '2026-04-01' }),
    action({ id: 'shortfall', actionKey: 's', actionLabel: 'Shortfall', shortfall: { currency: 'INR', amountMinor: 500 } }),
  ];

  const expectedGoalIds = rankGoals(goals).map(({ goalId }) => goalId);
  const expectedTripIds = rankTrips(trips).map(({ tripId }) => tripId);
  const expectedActionIds = rankActions(actions).map(({ id }) => id);

  for (const input of permutations(goals)) {
    assert.deepEqual(rankGoals(input).map(({ goalId }) => goalId), expectedGoalIds);
  }
  for (const input of permutations(trips)) {
    assert.deepEqual(rankTrips(input).map(({ tripId }) => tripId), expectedTripIds);
  }
  for (const input of permutations(actions)) {
    assert.deepEqual(rankActions(input).map(({ id }) => id), expectedActionIds);
  }
});

test('candidate generation emits exact condition actions and summary caps them at three', () => {
  const input = {
    monthlyPlan: { salaryMinor: 100_000, activeBillsTotalMinor: 100_000 },
    spending: {
      needsBudgetMinor: 30_000,
      needsSpentMinor: 30_500,
      wantsBudgetMinor: 20_000,
      wantsSpentMinor: 20_200,
    },
    goals: [
      goal({ goalId: 2, name: 'Later goal', targetDate: '2026-09-01', fundingGapMinor: 50_000 }),
      goal({ goalId: 1, name: 'Urgent goal', targetDate: '2026-04-01', fundingGapMinor: 10_000 }),
    ],
    trips: [
      trip({ tripId: 2, name: 'Small balance', userBalanceMinor: -300 }),
      trip({ tripId: 1, name: 'Nearest settlement', userBalanceMinor: 600 }),
    ],
  };

  const candidates = buildActionCandidates(input);
  assert.deepEqual(candidates.map(({ conditionCode }) => conditionCode), [
    'bills_equal_salary',
    'needs_budget_exceeded',
    'wants_budget_exceeded',
    'goal_funding_gap',
    'trip_balance_receivable',
  ]);
  assert.deepEqual(candidates.map(({ actionKey }) => actionKey), [
    'review_bills',
    'address_needs_budget_excess',
    'address_wants_budget_excess',
    'contribute_to_goal',
    'settle_trip_balance',
  ]);
  assert.deepEqual(candidates.map(({ route }) => route), [
    '/plan#bills-form',
    '/spending?action=review-budget&bucket=needs',
    '/spending?action=review-budget&bucket=wants',
    '/goals?action=contribute&goalId=1',
    '/trips/1?tab=balances&action=settle',
  ]);
  assert.deepEqual(candidates.map(({ context }) => context), [
    { recordType: 'bill' },
    { recordType: 'expense' },
    { recordType: 'expense' },
    { recordType: 'goal', recordId: 1 },
    { recordType: 'trip', recordId: 1 },
  ]);
  for (const candidate of candidates) {
    assert.equal(typeof candidate.actionLabel, 'string');
    assert.ok(candidate.actionLabel.length > 0);
    assert.equal(typeof candidate.expectedEffect, 'string');
    assert.ok(candidate.expectedEffect.length > 0);
    assert.equal(candidate.disclaimer, ACTION_DISCLAIMER);
  }

  const summary = buildActionSummary(input);
  assert.equal(summary.status, 'actions_available');
  assert.equal(summary.actions.length, MAX_SUMMARY_ACTIONS);
  assert.deepEqual(summary.actions.map(({ conditionCode }) => conditionCode), [
    'goal_funding_gap',
    'needs_budget_exceeded',
    'wants_budget_exceeded',
  ]);

  const excessBills = buildActionCandidates({
    monthlyPlan: { salaryMinor: 100_000, activeBillsTotalMinor: 125_000 },
  });
  assert.equal(excessBills.length, 1);
  assert.deepEqual(excessBills[0].shortfall, { currency: 'INR', amountMinor: 25_000 });
  assert.equal(excessBills[0].conditionCode, 'bills_exceed_salary');
});

test('no applicable condition produces the explicit current-month no-action state', () => {
  const candidates = buildActionCandidates({
    monthlyPlan: { salaryMinor: 100_000, activeBillsTotalMinor: 30_000 },
    spending: {
      needsBudgetMinor: 30_000,
      needsSpentMinor: 30_000,
      wantsBudgetMinor: 20_000,
      wantsSpentMinor: 19_999,
    },
    goals: [goal({ status: 'funded', fundingGapMinor: 0 })],
    trips: [trip({ userBalanceMinor: 0, earliestUnsettledAt: null })],
  });

  assert.deepEqual(candidates, []);
  assert.deepEqual(createActionSummary(candidates), {
    status: 'no_action_needed',
    message: 'No action is needed for the current month.',
    actions: [],
  });
  assert.deepEqual(buildActionSummary({}), {
    status: 'no_action_needed',
    message: 'No action is needed for the current month.',
    actions: [],
  });
});

test('every action text is plain language: no action key, record ID, snake_case, or camelCase outside user-typed names', () => {
  // One candidate for every condition and variant: bills over pay, bills equal to pay, both
  // budget buckets, a goal with a gap, an overdue goal, a receivable trip, and an owed trip.
  const inputs = [
    {
      monthlyPlan: { salaryMinor: 100_000, activeBillsTotalMinor: 125_000 },
      spending: { needsBudgetMinor: 100, needsSpentMinor: 900, wantsBudgetMinor: 100, wantsSpentMinor: 500 },
      goals: [goal({ goalId: 42 })],
      trips: [trip({ tripId: 77, userBalanceMinor: 5_000 })],
    },
    {
      monthlyPlan: { salaryMinor: 100_000, activeBillsTotalMinor: 100_000 },
      goals: [goal({ goalId: 43, status: 'overdue' })],
      trips: [trip({ tripId: 78, userBalanceMinor: -5_000 })],
    },
  ];
  const candidates = inputs.flatMap((input) => buildActionCandidates(input));
  assert.deepEqual(
    [...new Set(candidates.map((candidate) => candidate.actionKey))].sort(),
    [
      'address_needs_budget_excess',
      'address_wants_budget_excess',
      'contribute_to_goal',
      'review_bills',
      'revise_goal_target',
      'settle_trip_balance',
    ],
  );
  const identifier = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b|\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b|\b[a-z]+(?:[A-Z][a-z0-9]*)+\b|\b[a-z][a-z-]*:[a-z0-9_-]+(?::[a-z0-9_-]+)+\b|\b(?:[Rr]ecord|[Gg]oal|[Tt]rip|[Bb]ill|[Ee]xpense)\s*[Ii][Dd]\b|\bundefined\b|\bnull\b/;
  for (const candidate of candidates) {
    for (const field of ['observation', 'actionLabel', 'expectedEffect']) {
      const text = candidate[field].replace(/“[^”]*”/g, ' ');
      assert.doesNotMatch(text, identifier, `${candidate.actionKey}.${field}: ${candidate[field]}`);
      assert.equal(
        candidate[field].toLowerCase().includes(candidate.actionKey),
        false,
        `${candidate.actionKey}.${field} repeats the action key`,
      );
      assert.doesNotMatch(candidate[field], /\b(42|43|77|78)\b/, `${candidate.actionKey}.${field} contains a record ID`);
    }
  }
});

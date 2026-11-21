import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  JourneyPlanError,
  MAX_REQUIRED_CATEGORIES,
  MAX_REQUIRED_STEPS,
  STEP_REGISTRY,
  buildJourneyFacts,
  planJourney,
} from '../../src/domain/journeyPlan.js';

const MONTH = '2026-01';

// Mirrors repositories/journeyRepository.js JOURNEY_DEFINITIONS; the API suite
// asserts the two stay identical.
const DEFINITIONS = {
  plan_month: { requiredStepKeys: ['salary'], optionalStepKeys: ['bills'] },
  control_spending: {
    requiredStepKeys: ['salary', 'expense'],
    optionalStepKeys: ['bills', 'category_treatment'],
  },
  fund_goal: { requiredStepKeys: ['goal'], optionalStepKeys: ['monthly_plan'] },
  settle_trip: {
    requiredStepKeys: ['trip', 'trip_members', 'trip_split'],
    optionalStepKeys: ['personal_expense'],
  },
};

const salary = { id: 5, amountMinor: 5_000_000, normalizationIssues: [] };
const bill = { id: 6, amountMinor: 100_000, normalizationIssues: [] };
const expense = { id: 7, amountMinor: 25_000, normalizationIssues: [] };
const goal = {
  id: 8,
  name: 'Laptop',
  targetAmountMinor: 9_000_000,
  savedAmountMinor: 0,
  targetDate: '2026-12-31',
  normalizationIssues: [],
};

function period({ withSalary = false, bills = [], expenses = [], treatments = [] } = {}) {
  return {
    salary: { record: withSalary ? salary : null },
    bills: { records: bills },
    expenses: { records: expenses },
    categoryTreatments: { records: treatments },
  };
}

function ledger({ id = 40, members = [], expenses = [] } = {}) {
  return {
    trip: { id },
    members: { records: members },
    expenses: { records: expenses },
  };
}

const memberA = { id: 1, name: 'Asha' };
const memberB = { id: 2, name: 'Ben' };
const sharedExpense = {
  id: 9,
  payer: 'Asha',
  description: 'Hotel',
  amountMinor: 600_000,
  splitStatus: 'confirmed',
  split: [{ name: 'Asha', share: 1 }, { name: 'Ben', share: 1 }],
  normalizationIssues: [],
};

function plan(desiredOutcome, facts, storedCompletedStepKeys = []) {
  return planJourney({
    desiredOutcome,
    definition: DEFINITIONS[desiredOutcome],
    facts,
    storedCompletedStepKeys,
  });
}

test('every fixed definition stays within three required steps and categories', () => {
  for (const [name, definition] of Object.entries(DEFINITIONS)) {
    const result = plan(name, buildJourneyFacts({ month: MONTH }));
    assert.ok(result.requiredStepKeys.length <= MAX_REQUIRED_STEPS, name);
    assert.ok(result.requiredCategories.length <= MAX_REQUIRED_CATEGORIES, name);
    assert.deepEqual(result.requiredStepKeys, definition.requiredStepKeys);
  }
});

test('a definition over the first-value bound is rejected', () => {
  assert.throws(
    () => planJourney({
      desiredOutcome: 'plan_month',
      definition: {
        requiredStepKeys: ['salary', 'expense', 'goal', 'trip'],
        optionalStepKeys: [],
      },
      facts: buildJourneyFacts({ month: MONTH }),
    }),
    JourneyPlanError
  );
});

test('with no records every required step is pending and the first outcome is withheld', () => {
  const result = plan('control_spending', buildJourneyFacts({ month: MONTH, period: period() }));
  assert.deepEqual(result.completedRequiredStepKeys, []);
  assert.deepEqual(result.remainingRequiredStepKeys, ['salary', 'expense']);
  assert.equal(result.nextIncompleteStepKey, 'salary');
  assert.equal(result.firstOutcome.available, false);
  assert.equal(result.firstOutcome.outcomeId, null);
  assert.equal(result.optionalOffered, false);
  assert.equal(result.nextChoice.stepKey, 'salary');
  assert.equal(result.nextChoice.required, true);
  assert.equal(result.progress.currentStepNumber, 1);
});

test('existing records skip the journey ahead to the next incomplete step', () => {
  const facts = buildJourneyFacts({ month: MONTH, period: period({ withSalary: true }) });
  const result = plan('control_spending', facts);
  assert.deepEqual(result.completedRequiredStepKeys, ['salary']);
  assert.equal(result.nextIncompleteStepKey, 'expense');
  assert.equal(result.progress.currentStepNumber, 2);
  assert.equal(result.steps.find(({ key }) => key === 'salary').status, 'satisfied');
});

test('the first outcome is available before optional steps are offered', () => {
  const facts = buildJourneyFacts({ month: MONTH, period: period({ withSalary: true }) });
  const result = plan('plan_month', facts);
  assert.equal(result.firstOutcome.available, true);
  assert.equal(result.firstOutcome.outcomeId, `monthly-plan:${MONTH}`);
  assert.equal(result.nextChoice.stepKey, 'bills');
  assert.equal(result.nextChoice.skippable, true);
  const bills = result.steps.find(({ key }) => key === 'bills');
  assert.equal(bills.offered, true);
  assert.equal(bills.skip.financialWrite, false);
  assert.equal(bills.skip.availableOutcomeKind, 'monthly_plan');
});

test('optional steps are not offered while a required step remains', () => {
  const result = plan('control_spending', buildJourneyFacts({ month: MONTH, period: period() }));
  for (const step of result.steps.filter(({ required }) => !required)) {
    assert.equal(step.offered, false);
  }
});

test('a skipped optional step resolves the prompt without being satisfied by records', () => {
  const facts = buildJourneyFacts({ month: MONTH, period: period({ withSalary: true }) });
  const result = plan('plan_month', facts, ['salary', 'bills']);
  const bills = result.steps.find(({ key }) => key === 'bills');
  assert.equal(bills.status, 'skipped');
  assert.equal(result.nextChoice, null);
  assert.deepEqual(result.completedStepKeysToPersist, ['salary', 'bills']);
});

test('stored progress is never dropped even if its record no longer exists', () => {
  const facts = buildJourneyFacts({ month: MONTH, period: period() });
  const result = plan('plan_month', facts, ['salary']);
  assert.equal(result.steps.find(({ key }) => key === 'salary').status, 'pending');
  assert.equal(result.nextIncompleteStepKey, 'salary');
  assert.ok(result.completedStepKeysToPersist.includes('salary'));
});

test('invalid stored amounts do not satisfy a step', () => {
  const facts = buildJourneyFacts({
    month: MONTH,
    period: {
      ...period(),
      salary: { record: { id: 5, amountMinor: null, normalizationIssues: [{ code: 'X' }] } },
    },
  });
  assert.equal(plan('plan_month', facts).firstOutcome.available, false);
});

test('fund_goal needs only one valid goal and reports its outcome id', () => {
  const invalidGoal = { ...goal, id: 9, targetDate: null };
  const facts = buildJourneyFacts({
    month: MONTH,
    goals: { records: [goal, invalidGoal] },
  });
  const result = plan('fund_goal', facts);
  assert.equal(result.firstOutcome.available, true);
  assert.equal(result.firstOutcome.outcomeId, 'goal:8');
  assert.equal(result.nextChoice.stepKey, 'monthly_plan');
});

test('settle_trip reaches its first outcome with no salary data', () => {
  const facts = buildJourneyFacts({
    month: MONTH,
    tripLedgers: [ledger({ members: [memberA, memberB], expenses: [sharedExpense] })],
  });
  const result = plan('settle_trip', facts);
  assert.equal(facts.salaryValid, false);
  assert.deepEqual(result.remainingRequiredStepKeys, []);
  assert.equal(result.firstOutcome.available, true);
  assert.equal(result.firstOutcome.outcomeId, 'trip:40');
});

test('settle_trip prefers the most advanced trip and requires two members', () => {
  const facts = buildJourneyFacts({
    month: MONTH,
    tripLedgers: [
      ledger({ id: 41, members: [memberA] }),
      ledger({ id: 40, members: [memberA, memberB] }),
    ],
  });
  const result = plan('settle_trip', facts);
  assert.equal(result.tripId, 40);
  assert.deepEqual(result.remainingRequiredStepKeys, ['trip_split']);
});

test('settlement payments and invalid splits do not satisfy the split step', () => {
  const settlement = { ...sharedExpense, description: '↔ Settlement: Ben paid Asha' };
  const badSplit = { ...sharedExpense, id: 10, splitStatus: 'invalid', split: null };
  const outsidePayer = { ...sharedExpense, id: 11, payer: 'Stranger' };
  const facts = buildJourneyFacts({
    month: MONTH,
    tripLedgers: [ledger({
      members: [memberA, memberB],
      expenses: [settlement, badSplit, outsidePayer],
    })],
  });
  assert.deepEqual(plan('settle_trip', facts).remainingRequiredStepKeys, ['trip_split']);
});

test('plans and facts carry no financial amounts or names', () => {
  const facts = buildJourneyFacts({
    month: MONTH,
    period: period({ withSalary: true, bills: [bill], expenses: [expense] }),
    goals: { records: [goal] },
    tripLedgers: [ledger({ members: [memberA, memberB], expenses: [sharedExpense] })],
  });
  const serialized = JSON.stringify([facts, plan('control_spending', facts)]);
  for (const secret of ['5000000', '100000', '25000', 'Laptop', 'Asha', 'Ben', 'Hotel']) {
    assert.ok(!serialized.includes(secret), `${secret} must not appear in plan state`);
  }
});

test('step registry names every step used by a definition', () => {
  for (const definition of Object.values(DEFINITIONS)) {
    for (const key of [...definition.requiredStepKeys, ...definition.optionalStepKeys]) {
      assert.ok(Object.hasOwn(STEP_REGISTRY, key), key);
    }
  }
});

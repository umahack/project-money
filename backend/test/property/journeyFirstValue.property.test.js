import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import fc from 'fast-check';
import {
  STEP_KEYS,
  buildJourneyFacts,
  planJourney,
} from '../../src/domain/journeyPlan.js';
import { createIsolatedTestDatabase } from '../helpers/testDatabase.js';
import { buildUserFixture } from '../helpers/fixtures.js';

/**
 * Property 19: Journey plans remain within the first-value bound.
 *
 * Validates: Requirements 3.2, 3.3, 3.4, 3.5, 3.7, 3.8, 3.9, 3.10, 3.11
 *
 * The reference model below is written from the design table, not from the
 * planner: it re-derives which steps current records satisfy from raw record
 * shapes and re-computes everything the planner reports.
 */

const PURE_RUNS = 200;
const SERVICE_RUNS = 100;
const MONTH = '2026-03';
const SETTLEMENT_PREFIX = '↔ Settlement: ';

// Design table (First-session Guided Journey). Independent of the repository.
const SPEC = Object.freeze({
  plan_month: { required: ['salary'], optional: ['bills'], bound: 1, firstKind: 'monthly_plan' },
  control_spending: {
    required: ['salary', 'expense'],
    optional: ['bills', 'category_treatment'],
    bound: 2,
    firstKind: 'spending',
  },
  fund_goal: { required: ['goal'], optional: ['monthly_plan'], bound: 1, firstKind: 'goal' },
  settle_trip: {
    required: ['trip', 'trip_members', 'trip_split'],
    optional: ['personal_expense'],
    bound: 3,
    firstKind: 'trip',
  },
});
const OUTCOMES = Object.keys(SPEC);
const MAX_REQUIRED = 3;

const CATEGORY_OF = {
  salary: 'salary',
  monthly_plan: 'salary',
  bills: 'bills',
  expense: 'expenses',
  personal_expense: 'expenses',
  category_treatment: 'category_treatments',
  goal: 'goals',
  trip: 'trips',
  trip_members: 'trips',
  trip_split: 'trips',
};

let testDatabase;
let db;
let modules;
let pureCases = 0;
let resumeCases = 0;
let tripCases = 0;
let serviceCases = 0;

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const amountArb = fc.oneof(
  { weight: 5, arbitrary: fc.integer({ min: 1, max: 10_000_000 }) },
  { weight: 1, arbitrary: fc.constantFrom(0, -5, 1.5, Number.NaN, null, 2 ** 60) }
);
const issuesArb = fc.oneof(
  { weight: 6, arbitrary: fc.constant(false) },
  { weight: 1, arbitrary: fc.constant(true) }
);
const moneySpecArb = fc.record({ amountMinor: amountArb, hasIssue: issuesArb });
const goalSpecArb = fc.record({
  name: fc.constantFrom('Laptop', 'Car', '', '   ', 7),
  targetAmountMinor: amountArb,
  savedAmountMinor: fc.constantFrom(0, 0, 250, 9_000, -1, 1.5),
  targetDate: fc.constantFrom('2027-01-31', '2027-12-01', '2027-13-01', '2027-00-10', '2027-01-32', 'soon', null),
  hasIssue: issuesArb,
});
const NAMES = ['Asha', 'Ben', 'Chi', '', '  '];
const tripSpecArb = fc.record({
  members: fc.array(fc.constantFrom(...NAMES), { maxLength: 4 }),
  expenses: fc.array(
    fc.record({
      payer: fc.constantFrom('Asha', 'Ben', 'Zed'),
      settlement: fc.boolean(),
      status: fc.constantFrom('confirmed', 'confirmed', 'invalid'),
      splitLength: fc.constantFrom(0, 1, 2),
      amountMinor: amountArb,
      hasIssue: issuesArb,
    }),
    { maxLength: 3 }
  ),
  linked: fc.boolean(),
});

const worldArb = fc.record({
  pool: fc.shuffledSubarray(Array.from({ length: 80 }, (_, index) => index + 1), {
    minLength: 80,
    maxLength: 80,
  }),
  salary: fc.option(moneySpecArb, { nil: null }),
  bills: fc.array(moneySpecArb, { maxLength: 3 }),
  expenses: fc.array(moneySpecArb, { maxLength: 3 }),
  treatments: fc.integer({ min: 0, max: 2 }),
  goals: fc.array(goalSpecArb, { maxLength: 3 }),
  trips: fc.array(tripSpecArb, { maxLength: 3 }),
}).map(buildWorld);

/** Turn generated specs into the repository-shaped inputs of buildJourneyFacts. */
function buildWorld(spec) {
  let cursor = 0;
  const nextId = () => spec.pool[cursor++];
  const issues = (flag) => (flag ? [{ code: 'NORMALIZATION_ISSUE' }] : []);
  const money = (item) => ({
    id: nextId(),
    amountMinor: item.amountMinor,
    normalizationIssues: issues(item.hasIssue),
  });
  const salary = spec.salary ? money(spec.salary) : null;
  const bills = spec.bills.map(money);
  const expenses = spec.expenses.map(money);
  const treatments = Array.from({ length: spec.treatments }, () => ({ id: nextId() }));
  const goals = spec.goals.map((goal) => ({
    id: nextId(),
    name: goal.name,
    targetAmountMinor: goal.targetAmountMinor,
    savedAmountMinor: goal.savedAmountMinor,
    targetDate: goal.targetDate,
    normalizationIssues: issues(goal.hasIssue),
  }));
  const linkedTripIds = [];
  const tripLedgers = spec.trips.map((trip) => {
    const id = nextId();
    if (trip.linked) linkedTripIds.push(id);
    return {
      trip: { id },
      members: { records: trip.members.map((name) => ({ id: nextId(), name })) },
      expenses: {
        records: trip.expenses.map((expense) => ({
          id: nextId(),
          payer: expense.payer,
          description: expense.settlement ? `${SETTLEMENT_PREFIX}Ben` : 'Hotel',
          amountMinor: expense.amountMinor,
          splitStatus: expense.status,
          split: Array.from({ length: expense.splitLength }, () => ({ name: 'Asha', share: 1 })),
          normalizationIssues: issues(expense.hasIssue),
        })),
      },
    };
  });
  return {
    period: {
      salary: { record: salary },
      bills: { records: bills },
      expenses: { records: expenses },
      categoryTreatments: { records: treatments },
    },
    goals: { records: goals },
    tripLedgers,
    personalLinkTripIds: linkedTripIds,
  };
}

// ---------------------------------------------------------------------------
// Independent reference model
// ---------------------------------------------------------------------------

function validAmount(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    && value <= Number.MAX_SAFE_INTEGER;
}

function validMoney(record) {
  return validAmount(record.amountMinor) && record.normalizationIssues.length === 0;
}

function validGoal(goal) {
  if (typeof goal.name !== 'string' || goal.name.trim().length === 0) return false;
  if (!validAmount(goal.targetAmountMinor)) return false;
  if (!(Number.isInteger(goal.savedAmountMinor) && goal.savedAmountMinor >= 0)) return false;
  if (typeof goal.targetDate !== 'string') return false;
  const parts = goal.targetDate.split('-');
  if (parts.length !== 3 || parts[0].length !== 4 || parts[1].length !== 2 || parts[2].length !== 2) {
    return false;
  }
  const [year, month, day] = parts.map(Number);
  return Number.isInteger(year) && month >= 1 && month <= 12 && day >= 1 && day <= 31
    && goal.normalizationIssues.length === 0;
}

function maxBy(items, key) {
  return items.reduce((best, item) => (best === null || key(item) > key(best) ? item : best), null);
}

/** What current confirmed records satisfy, computed from raw record shapes. */
function referenceState(world) {
  const satisfied = new Set();
  const ids = {};

  const salary = world.period.salary.record;
  if (salary && validMoney(salary)) {
    satisfied.add('salary');
    satisfied.add('monthly_plan');
    ids.salary = salary.id;
  }
  const bills = world.period.bills.records.filter(validMoney);
  if (bills.length > 0) {
    satisfied.add('bills');
    ids.bills = maxBy(bills, (record) => record.id).id;
  }
  const expenses = world.period.expenses.records.filter(validMoney);
  if (expenses.length > 0) {
    satisfied.add('expense');
    ids.expense = maxBy(expenses, (record) => record.id).id;
  }
  if (world.period.categoryTreatments.records.length > 0) satisfied.add('category_treatment');
  const goals = world.goals.records.filter(validGoal);
  if (goals.length > 0) {
    satisfied.add('goal');
    ids.goal = maxBy(goals, (record) => record.id).id;
  }

  const stages = world.tripLedgers.map((ledger) => {
    const names = new Set(
      ledger.members.records.map((member) => member.name).filter((name) => name.trim() !== '')
    );
    const membersReady = names.size >= 2;
    const splitReady = membersReady && ledger.expenses.records.some((expense) => (
      !expense.description.startsWith(SETTLEMENT_PREFIX)
      && expense.splitStatus === 'confirmed'
      && expense.split.length > 0
      && validMoney(expense)
      && names.has(expense.payer)
    ));
    return {
      id: ledger.trip.id,
      stage: 1 + (membersReady ? 1 : 0) + (splitReady ? 1 : 0),
      linked: world.personalLinkTripIds.includes(ledger.trip.id),
    };
  });
  let bestTrip = null;
  if (stages.length > 0) {
    satisfied.add('trip');
    const top = Math.max(...stages.map((entry) => entry.stage));
    if (stages.some((entry) => entry.stage >= 2)) satisfied.add('trip_members');
    if (stages.some((entry) => entry.stage >= 3)) satisfied.add('trip_split');
    bestTrip = maxBy(stages.filter((entry) => entry.stage === top), (entry) => entry.id);
    if (bestTrip.linked) satisfied.add('personal_expense');
  }
  return { satisfied, ids, goalId: ids.goal ?? null, bestTripId: bestTrip?.id ?? null };
}

function definitionFor(outcome) {
  return {
    requiredStepKeys: [...SPEC[outcome].required],
    optionalStepKeys: [...SPEC[outcome].optional],
  };
}

function allowedKeys(outcome) {
  return [...SPEC[outcome].required, ...SPEC[outcome].optional];
}

function planFor(outcome, world, stored = []) {
  return planJourney({
    desiredOutcome: outcome,
    definition: definitionFor(outcome),
    facts: buildJourneyFacts({ month: MONTH, ...world }),
    storedCompletedStepKeys: stored,
  });
}

const storedCandidateArb = fc.subarray([...STEP_KEYS]);

/** goalId and tripId are informational references to records of other outcomes. */
function withoutCrossRefs(plan) {
  const { goalId, tripId, ...rest } = plan;
  return rest;
}

function expectedFirstOutcomeId(outcome, ref) {
  switch (outcome) {
    case 'plan_month': return `monthly-plan:${MONTH}`;
    case 'control_spending': return `spending:${MONTH}`;
    case 'fund_goal': return `goal:${ref.goalId}`;
    default: return `trip:${ref.bestTripId}`;
  }
}

/** Assert every planner claim against the reference for one plan. */
function assertPlanMatchesReference(outcome, plan, world, stored) {
  const spec = SPEC[outcome];
  const ref = referenceState(world);
  const expectedRemaining = spec.required.filter((key) => !ref.satisfied.has(key));
  const expectedCompleted = spec.required.filter((key) => ref.satisfied.has(key));
  const available = expectedRemaining.length === 0;

  // Fixed definition and bounds (3.2, 3.3, 3.4).
  assert.deepEqual(plan.requiredStepKeys, spec.required);
  assert.ok(plan.requiredStepKeys.length <= MAX_REQUIRED);
  assert.ok(plan.requiredCategories.length <= MAX_REQUIRED);
  assert.deepEqual(
    [...plan.requiredCategories].sort(),
    [...new Set(spec.required.map((key) => CATEGORY_OF[key]))].sort()
  );
  assert.ok(plan.remainingRequiredStepKeys.length <= spec.bound);
  assert.ok(plan.progress.requiredTotal <= MAX_REQUIRED);

  // Satisfied steps are skipped; progress partitions required steps (3.8, 3.10).
  assert.deepEqual(plan.remainingRequiredStepKeys, expectedRemaining);
  assert.deepEqual(plan.completedRequiredStepKeys, expectedCompleted);
  assert.deepEqual(
    [...plan.completedRequiredStepKeys, ...plan.remainingRequiredStepKeys].sort(),
    [...spec.required].sort()
  );
  assert.equal(plan.nextIncompleteStepKey, expectedRemaining[0] ?? null);
  assert.equal(plan.progress.requiredCompleted, expectedCompleted.length);
  assert.equal(plan.progress.requiredRemaining, expectedRemaining.length);
  assert.equal(
    plan.progress.currentStepNumber,
    expectedRemaining.length === 0 ? null : spec.required.indexOf(expectedRemaining[0]) + 1
  );
  for (const key of spec.required) {
    const step = plan.steps.find((entry) => entry.key === key);
    assert.equal(step.required, true);
    assert.equal(step.status, ref.satisfied.has(key) ? 'satisfied' : 'pending');
  }

  // First outcome appears exactly when all required steps are satisfied (3.5).
  assert.equal(plan.firstOutcome.available, available);
  assert.equal(plan.firstOutcome.kind, spec.firstKind);
  assert.equal(plan.firstOutcome.outcomeId, available ? expectedFirstOutcomeId(outcome, ref) : null);

  // Optional steps appear only after the first outcome (3.5, 3.6).
  assert.equal(plan.optionalOffered, available);
  const pendingOptional = spec.optional.filter(
    (key) => !ref.satisfied.has(key) && !stored.includes(key)
  );
  for (const key of spec.optional) {
    const step = plan.steps.find((entry) => entry.key === key);
    assert.equal(step.required, false);
    assert.equal(step.offered, available);
    assert.equal(step.skip.financialWrite, false);
    assert.equal(typeof step.skip.affectedOutcome, 'string');
    assert.ok(step.skip.affectedOutcome.length > 0);
    assert.equal(
      step.status,
      ref.satisfied.has(key) ? 'satisfied' : stored.includes(key) ? 'skipped' : 'pending'
    );
  }
  if (!available) {
    assert.equal(plan.currentStepKey, expectedRemaining[0]);
    assert.deepEqual(plan.nextChoice, {
      stepKey: expectedRemaining[0],
      required: true,
      skippable: false,
    });
  } else if (pendingOptional.length > 0) {
    assert.deepEqual(plan.nextChoice, {
      stepKey: pendingOptional[0],
      required: false,
      skippable: true,
    });
  } else {
    assert.equal(plan.currentStepKey, null);
    assert.equal(plan.nextChoice, null);
  }

  // Record references come from the newest valid record (3.7: no copied data).
  for (const [stepKey, recordType] of [
    ['salary', 'salary'], ['bills', 'bill'], ['expense', 'expense'], ['goal', 'goal'],
  ]) {
    const step = plan.steps.find((entry) => entry.key === stepKey);
    if (step && step.status === 'satisfied') {
      assert.deepEqual(step.recordRef, { recordType, recordId: ref.ids[stepKey] });
    }
  }
  const serialized = JSON.stringify(plan);
  assert.ok(!serialized.includes('amountMinor'));
  assert.ok(!serialized.includes('Laptop'));

  // Stored progress is only ever added to (3.9).
  for (const key of stored) assert.ok(plan.completedStepKeysToPersist.includes(key));
  assert.deepEqual(
    plan.completedStepKeysToPersist,
    allowedKeys(outcome).filter((key) => stored.includes(key) || ref.satisfied.has(key))
  );

  // The next required step depends on records, never on stored keys.
  assert.deepEqual(
    planFor(outcome, world, []).remainingRequiredStepKeys,
    plan.remainingRequiredStepKeys
  );
  return ref;
}

// ---------------------------------------------------------------------------
// Pure planner properties
// ---------------------------------------------------------------------------

test('Property 19: plans stay within the first-value bound and match the reference model', () => {
  fc.assert(
    fc.property(worldArb, fc.constantFrom(...OUTCOMES), storedCandidateArb, (world, outcome, candidate) => {
      const stored = allowedKeys(outcome).filter((key) => candidate.includes(key));
      assertPlanMatchesReference(outcome, planFor(outcome, world, stored), world, stored);
      pureCases += 1;
    }),
    { numRuns: PURE_RUNS }
  );
  assert.ok(pureCases >= 100);
});

test('Property 19: every desired outcome on an empty record set needs exactly its bounded steps', () => {
  const empty = buildWorld({
    pool: Array.from({ length: 80 }, (_, index) => index + 1),
    salary: null,
    bills: [],
    expenses: [],
    treatments: 0,
    goals: [],
    trips: [],
  });
  for (const outcome of OUTCOMES) {
    const plan = planFor(outcome, empty);
    assertPlanMatchesReference(outcome, plan, empty, []);
    assert.equal(plan.remainingRequiredStepKeys.length, SPEC[outcome].bound);
    assert.equal(plan.firstOutcome.available, false);
    assert.equal(plan.optionalOffered, false);
    assert.equal(plan.progress.currentStepNumber, 1);
  }
});

test('Property 19: pause then resume lands on the next incomplete step from current records', () => {
  fc.assert(
    fc.property(
      fc.array(worldArb, { minLength: 3, maxLength: 3 }),
      fc.constantFrom(...OUTCOMES),
      storedCandidateArb,
      (worlds, outcome, candidate) => {
        let persisted = allowedKeys(outcome).filter((key) => candidate.includes(key));
        const spec = SPEC[outcome];
        for (const world of worlds) {
          // Resume against whatever records exist now (added or deleted while paused).
          const plan = planFor(outcome, world, persisted);
          const ref = assertPlanMatchesReference(outcome, plan, world, persisted);
          const firstUnsatisfied = spec.required.find((key) => !ref.satisfied.has(key)) ?? null;
          assert.equal(plan.nextIncompleteStepKey, firstUnsatisfied);

          // Saved progress did not need to know the records to land on the same step.
          assert.equal(planFor(outcome, world, []).nextIncompleteStepKey, firstUnsatisfied);

          // A required key stored earlier but now missing from records is requested again.
          for (const key of persisted.filter((entry) => spec.required.includes(entry))) {
            const stillThere = ref.satisfied.has(key);
            assert.equal(plan.remainingRequiredStepKeys.includes(key), !stillThere);
          }

          // Progress never regresses across pause/resume cycles.
          for (const key of persisted) assert.ok(plan.completedStepKeysToPersist.includes(key));
          persisted = plan.completedStepKeysToPersist;
          resumeCases += 1;
        }
      }
    ),
    { numRuns: PURE_RUNS }
  );
  assert.ok(resumeCases >= 100);
});

const readyTripArb = fc.record({
  memberNames: fc.shuffledSubarray(['Asha', 'Ben', 'Chi'], { minLength: 2, maxLength: 3 }),
  extraBlank: fc.boolean(),
  amountMinor: fc.integer({ min: 1, max: 5_000_000 }),
  splitLength: fc.integer({ min: 1, max: 3 }),
  id: fc.integer({ min: 1, max: 5_000 }),
});

test('Property 19: settle a trip reaches its first outcome without any salary data', () => {
  fc.assert(
    fc.property(readyTripArb, worldArb, (ready, other) => {
      const payer = ready.memberNames[0];
      const members = ready.memberNames.map((name, index) => ({ id: index + 1, name }));
      if (ready.extraBlank) members.push({ id: 99, name: ' ' });
      const tripLedger = {
        trip: { id: ready.id },
        members: { records: members },
        expenses: {
          records: [{
            id: 1,
            payer,
            description: 'Hotel',
            amountMinor: ready.amountMinor,
            splitStatus: 'confirmed',
            split: Array.from({ length: ready.splitLength }, () => ({ name: payer, share: 1 })),
            normalizationIssues: [],
          }],
        },
      };
      const salaryFree = { period: null, goals: null, tripLedgers: [tripLedger], personalLinkTripIds: [] };
      const plan = planFor('settle_trip', salaryFree);
      assert.deepEqual(plan.remainingRequiredStepKeys, []);
      assert.equal(plan.firstOutcome.available, true);
      assert.equal(plan.firstOutcome.outcomeId, `trip:${ready.id}`);

      // Adding or removing salary, bills, expenses or goals never changes the trip plan.
      const withPeriod = { ...other, tripLedgers: [tripLedger], personalLinkTripIds: [] };
      assert.deepEqual(withoutCrossRefs(planFor('settle_trip', withPeriod)), withoutCrossRefs(plan));
      tripCases += 1;
    }),
    { numRuns: PURE_RUNS }
  );
  assert.ok(tripCases >= 100);
});

test('Property 19: every plan_month, control_spending and fund_goal plan ignores trips', () => {
  fc.assert(
    fc.property(worldArb, (world) => {
      const withoutTrips = { ...world, tripLedgers: [], personalLinkTripIds: [] };
      for (const outcome of ['plan_month', 'control_spending', 'fund_goal']) {
        assert.deepEqual(
          withoutCrossRefs(planFor(outcome, world)),
          withoutCrossRefs(planFor(outcome, withoutTrips))
        );
      }
    }),
    { numRuns: PURE_RUNS }
  );
});

test('planner step keys cover the design table', () => {
  for (const outcome of OUTCOMES) {
    for (const key of allowedKeys(outcome)) assert.ok(STEP_KEYS.includes(key), key);
  }
});

// ---------------------------------------------------------------------------
// Service-level properties against an isolated database
// ---------------------------------------------------------------------------

const USER_ID = 17_001;
const FIXED_NOW = new Date('2026-03-15T06:30:00.000Z');

const stateArb = fc.record({
  salary: fc.boolean(),
  expenses: fc.integer({ min: 0, max: 2 }),
  bills: fc.integer({ min: 0, max: 2 }),
  treatments: fc.integer({ min: 0, max: 1 }),
  goal: fc.boolean(),
  trip: fc.integer({ min: 0, max: 3 }),
});

function referenceSatisfied(state) {
  const set = new Set();
  if (state.salary) { set.add('salary'); set.add('monthly_plan'); }
  if (state.bills > 0) set.add('bills');
  if (state.expenses > 0) set.add('expense');
  if (state.treatments > 0) set.add('category_treatment');
  if (state.goal) set.add('goal');
  if (state.trip >= 1) set.add('trip');
  if (state.trip >= 2) set.add('trip_members');
  if (state.trip >= 3) set.add('trip_split');
  return set;
}

async function clearRecords() {
  await db.prepare(
    'DELETE FROM trip_expenses WHERE trip_id IN (SELECT id FROM trips WHERE user_id = ?)'
  ).run(USER_ID);
  await db.prepare(
    'DELETE FROM trip_members WHERE trip_id IN (SELECT id FROM trips WHERE user_id = ?)'
  ).run(USER_ID);
  for (const table of [
    'trips',
    'salary_entries',
    'expense_log',
    'emis',
    'expense_category_treatments',
    'savings_goals',
  ]) {
    await db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(USER_ID);
  }
}

/** Make the user's stored records equal `state`, deleting what is no longer present. */
async function applyRecords(state) {
  await clearRecords();
  if (state.salary) {
    await db.prepare('INSERT INTO salary_entries (user_id, month, amount) VALUES (?, ?, ?)')
      .run(USER_ID, MONTH, 50_000);
  }
  for (let index = 0; index < state.expenses; index += 1) {
    await db.prepare(
      'INSERT INTO expense_log (user_id, month, category, amount, note, spent_on) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(USER_ID, MONTH, 'Food', 125.5, 'Lunch', `${MONTH}-10`);
  }
  for (let index = 0; index < state.bills; index += 1) {
    await db.prepare('INSERT INTO emis (user_id, label, amount, category, active) VALUES (?, ?, ?, ?, 1)')
      .run(USER_ID, `Bill ${index}`, 1_000, 'Rent');
  }
  if (state.treatments > 0) {
    await db.prepare(
      "INSERT INTO expense_category_treatments (user_id, category, treatment) VALUES (?, 'Food', 'needs')"
    ).run(USER_ID);
  }
  if (state.goal) {
    await db.prepare(
      'INSERT INTO savings_goals (user_id, name, target_amount, saved_amount, target_date) VALUES (?, ?, ?, ?, ?)'
    ).run(USER_ID, 'Laptop', 1_000, 250, '2026-12-31');
  }
  if (state.trip >= 1) {
    const trip = await db.prepare('INSERT INTO trips (user_id, name, budget) VALUES (?, ?, ?) RETURNING id')
      .get(USER_ID, 'Goa', 20_000);
    const tripId = Number(trip.id);
    await db.prepare('INSERT INTO trip_members (trip_id, user_id, name) VALUES (?, ?, ?)')
      .run(tripId, USER_ID, 'Asha');
    if (state.trip >= 2) {
      await db.prepare('INSERT INTO trip_members (trip_id, name) VALUES (?, ?)').run(tripId, 'Ben');
    }
    if (state.trip >= 3) {
      await db.prepare(
        'INSERT INTO trip_expenses (trip_id, payer, description, amount, split_json) VALUES (?, ?, ?, ?, ?)'
      ).run(
        tripId,
        'Asha',
        'Hotel',
        6_000,
        JSON.stringify([{ name: 'Asha', share: 1 }, { name: 'Ben', share: 1 }])
      );
    }
  }
}

async function storedJourney(journeyId) {
  const row = await db.prepare(
    'SELECT status, completed_step_keys FROM guided_journeys WHERE id = ?'
  ).get(journeyId);
  return { status: row.status, steps: JSON.parse(row.completed_step_keys) };
}

function sorted(values) {
  return [...values].sort();
}

function assertViewMatches(view, outcome, state, stored) {
  const spec = SPEC[outcome];
  const satisfied = referenceSatisfied(state);
  const remaining = spec.required.filter((key) => !satisfied.has(key));
  assert.ok(view.requiredStepKeys.length <= MAX_REQUIRED);
  assert.ok(view.requiredCategories.length <= MAX_REQUIRED);
  assert.ok(view.remainingRequiredStepKeys.length <= spec.bound);
  assert.deepEqual(view.remainingRequiredStepKeys, remaining);
  assert.deepEqual(
    view.completedRequiredStepKeys,
    spec.required.filter((key) => satisfied.has(key))
  );
  assert.equal(view.nextIncompleteStepKey, remaining[0] ?? null);
  assert.equal(view.firstOutcome.available, remaining.length === 0);
  assert.equal(view.optionalOffered, remaining.length === 0);
  if (remaining.length > 0 && view.status !== 'completed') {
    assert.equal(view.currentStepKey, remaining[0]);
    assert.equal(view.nextChoice.required, true);
  }
  for (const step of view.steps.filter((entry) => !entry.required)) {
    assert.equal(step.offered, remaining.length === 0);
    assert.equal(
      step.status,
      satisfied.has(step.key) ? 'satisfied' : stored.includes(step.key) ? 'skipped' : 'pending'
    );
  }
  return { satisfied, remaining };
}

async function pauseAndCheck(service, journeyId, outcome, state) {
  const before = await storedJourney(journeyId);
  const paused = await service.apply({ userId: USER_ID, journeyId, body: { action: 'pause' } });
  assert.equal(paused.journey.status, 'paused');
  const afterPause = await storedJourney(journeyId);
  assert.equal(afterPause.status, 'paused');
  assert.deepEqual(sorted(afterPause.steps), sorted(before.steps));
  assertViewMatches(paused.journey, outcome, state, afterPause.steps);
  return afterPause;
}

async function resumeAndCheck(service, journeyId, outcome, state, pausedProgress) {
  const active = await service.getActive({ userId: USER_ID });
  assert.equal(active.status, 'paused');
  const resumed = await service.apply({ userId: USER_ID, journeyId, body: { action: 'resume' } });
  assert.equal(resumed.journey.status, 'active');
  const after = await storedJourney(journeyId);
  assert.equal(after.status, 'active');

  // Stored progress never regresses, even when records were deleted while paused.
  for (const key of pausedProgress.steps) assert.ok(after.steps.includes(key), key);
  const { satisfied, remaining } = assertViewMatches(resumed.journey, outcome, state, after.steps);
  assert.deepEqual(
    sorted(after.steps),
    sorted(allowedKeys(outcome).filter((key) => pausedProgress.steps.includes(key) || satisfied.has(key)))
  );
  assert.equal(resumed.transition.nextStepKey, resumed.journey.currentStepKey);
  if (remaining.length > 0) assert.equal(resumed.transition.nextStepKey, remaining[0]);
  return { view: resumed.journey, stored: after, remaining, satisfied };
}

before(async () => {
  testDatabase = await createIsolatedTestDatabase();
  db = testDatabase.db;
  process.env.FINANCIAL_MUTATION_HMAC_KEY =
    'test-only-journey-property-hmac-key-32-bytes-minimum';
  const [serviceModule, repositoryModule] = await Promise.all([
    import('../../src/services/journeyService.js'),
    import('../../src/repositories/journeyRepository.js'),
  ]);
  modules = {
    JourneyService: serviceModule.JourneyService,
    JOURNEY_DEFINITIONS: repositoryModule.JOURNEY_DEFINITIONS,
  };
  const user = buildUserFixture({ id: USER_ID, email: 'journey-property@example.test' });
  await db.prepare(
    `INSERT INTO users (id, email, name, password_hash, is_admin, token_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(user.id, user.email, user.name, user.password_hash, user.is_admin, user.token_version, user.created_at);
});

after(async () => {
  await testDatabase?.cleanup();
});

test('server journey definitions equal the design table', () => {
  for (const outcome of OUTCOMES) {
    assert.deepEqual([...modules.JOURNEY_DEFINITIONS[outcome].requiredStepKeys], SPEC[outcome].required);
    assert.deepEqual([...modules.JOURNEY_DEFINITIONS[outcome].optionalStepKeys], SPEC[outcome].optional);
  }
  assert.deepEqual(Object.keys(modules.JOURNEY_DEFINITIONS), OUTCOMES);
});

test('Property 19: service journeys stay within bounds, resume from current records and never regress', async () => {
  const service = new modules.JourneyService({ clock: () => FIXED_NOW });
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom(...OUTCOMES),
      fc.array(stateArb, { minLength: 3, maxLength: 3 }),
      async (outcome, [initial, whilePaused, later]) => {
        await db.prepare('DELETE FROM guided_journeys WHERE user_id = ?').run(USER_ID);
        try {
          // Start: existing records skip satisfied required steps.
          await applyRecords(initial);
          const started = await service.start({ userId: USER_ID, body: { desiredOutcome: outcome } });
          assert.equal(started.created, true);
          const journeyId = started.journey.id;
          const afterStart = await storedJourney(journeyId);
          const startView = assertViewMatches(started.journey, outcome, initial, []);
          assert.deepEqual(
            sorted(afterStart.steps),
            sorted(allowedKeys(outcome).filter((key) => startView.satisfied.has(key)))
          );
          const repeat = await service.start({ userId: USER_ID, body: { desiredOutcome: outcome } });
          assert.equal(repeat.created, false);
          assert.equal(repeat.journey.id, journeyId);

          // Pause, change records (add and delete), resume.
          let progress = await pauseAndCheck(service, journeyId, outcome, initial);
          await applyRecords(whilePaused);
          let result = await resumeAndCheck(service, journeyId, outcome, whilePaused, progress);

          // Optional steps: rejected before the first outcome, writes nothing when skipped after.
          const spec = SPEC[outcome];
          const pendingOptional = spec.optional.filter(
            (key) => !result.satisfied.has(key) && !result.stored.steps.includes(key)
          );
          if (pendingOptional.length > 0) {
            const beforeSkip = await storedJourney(journeyId);
            const snapshot = await db.prepare('SELECT COUNT(*) AS n FROM salary_entries').get();
            if (result.remaining.length > 0) {
              await assert.rejects(
                service.apply({
                  userId: USER_ID,
                  journeyId,
                  body: { action: 'skip_step', stepKey: pendingOptional[0] },
                }),
                (error) => error.code === 'FIRST_OUTCOME_PENDING' && error.httpStatus === 409
              );
              assert.deepEqual(await storedJourney(journeyId), beforeSkip);
            } else {
              const skipped = await service.apply({
                userId: USER_ID,
                journeyId,
                body: { action: 'skip_step', stepKey: pendingOptional[0] },
              });
              const afterSkip = await storedJourney(journeyId);
              for (const key of beforeSkip.steps) assert.ok(afterSkip.steps.includes(key));
              assert.ok(afterSkip.steps.includes(pendingOptional[0]));
              assert.equal(
                skipped.journey.steps.find((step) => step.key === pendingOptional[0]).status,
                'skipped'
              );
            }
            const after = await db.prepare('SELECT COUNT(*) AS n FROM salary_entries').get();
            assert.equal(Number(after.n), Number(snapshot.n));
          }

          // Second pause/resume cycle against a third record set.
          progress = await pauseAndCheck(service, journeyId, outcome, whilePaused);
          await applyRecords(later);
          result = await resumeAndCheck(service, journeyId, outcome, later, progress);

          const rows = await db.prepare(
            'SELECT COUNT(*) AS n FROM guided_journeys WHERE user_id = ?'
          ).get(USER_ID);
          assert.equal(Number(rows.n), 1);
          serviceCases += 1;
        } finally {
          await clearRecords();
        }
      }
    ),
    { numRuns: SERVICE_RUNS }
  );
  assert.ok(serviceCases >= 100, `service cases: ${serviceCases}`);
});

test('Property 19: a salary-free trip journey reaches its first outcome through the service', async () => {
  const service = new modules.JourneyService({ clock: () => FIXED_NOW });
  await db.prepare('DELETE FROM guided_journeys WHERE user_id = ?').run(USER_ID);
  await applyRecords({
    salary: false, expenses: 0, bills: 0, treatments: 0, goal: false, trip: 3,
  });
  const started = await service.start({ userId: USER_ID, body: { desiredOutcome: 'settle_trip' } });
  assert.deepEqual(started.journey.remainingRequiredStepKeys, []);
  assert.equal(started.journey.firstOutcome.available, true);
  assert.equal(started.journey.firstOutcome.kind, 'trip');
  const salaryRows = await db.prepare('SELECT COUNT(*) AS n FROM salary_entries WHERE user_id = ?').get(USER_ID);
  assert.equal(Number(salaryRows.n), 0);
  await clearRecords();
});

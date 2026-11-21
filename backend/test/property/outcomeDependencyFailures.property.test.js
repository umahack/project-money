import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {
  OUTCOME_STATUSES,
  VALUE_CLASSIFICATIONS,
  createAuthorizedSourceAccess,
  createDependentOutcome,
} from '../../src/domain/outcomes.js';

const NUM_RUNS = 150;
const PERIOD = Object.freeze({
  month: '2026-11',
  start: '2026-11-01',
  endExclusive: '2026-12-01',
  timeZone: 'Asia/Kolkata',
  asOfDate: '2026-11-18',
  daysRemainingInclusive: 13,
});

const SOURCE_DEFINITIONS = Object.freeze([
  {
    input: 'salary.amount',
    sourceType: 'salary',
    recordId: 1,
    field: 'amountMinor',
    label: 'Current-month salary',
    constraint: 'a non-negative safe integer amount in paise',
    valueKind: 'money',
  },
  {
    input: 'bills.amount',
    sourceType: 'bill',
    recordId: 2,
    field: 'amountMinor',
    label: 'Current-month bill',
    constraint: 'each bill amount must be a non-negative safe integer in paise',
    valueKind: 'money',
  },
  {
    input: 'expenses.amount',
    sourceType: 'expense',
    recordId: 3,
    field: 'amountMinor',
    label: 'Current-month expense',
    constraint: 'each expense amount must be a non-negative safe integer in paise',
    valueKind: 'money',
  },
  {
    input: 'goal.targetAmount',
    sourceType: 'goal',
    recordId: 4,
    field: 'targetAmountMinor',
    label: 'Goal target amount',
    constraint: 'a target amount greater than zero paise',
    valueKind: 'money',
  },
  {
    input: 'trip.expenseAmount',
    sourceType: 'trip_expense',
    recordId: 5,
    field: 'amountMinor',
    label: 'Shared trip expense',
    constraint: 'a shared expense amount greater than zero paise',
    valueKind: 'money',
  },
  {
    input: 'trip.splitWeight',
    sourceType: 'trip_expense',
    recordId: 6,
    field: 'splitRule.member:1',
    label: 'Trip split weight',
    constraint: 'a complete split with non-negative weights and at least one positive weight',
    valueKind: 'number',
  },
]);

const OUTCOME_DEFINITIONS = Object.freeze([
  {
    id: 'disposable-income:2026-11',
    kind: 'disposable_income',
    dependencies: ['salary.amount', 'bills.amount'],
  },
  {
    id: 'expense-category-total:2026-11',
    kind: 'expense_category_total',
    dependencies: ['expenses.amount'],
  },
  {
    id: 'daily-spending-guide:2026-11',
    kind: 'daily_spending_guide',
    dependencies: ['salary.amount', 'bills.amount', 'expenses.amount'],
  },
  {
    id: 'projected-savings:2026-11',
    kind: 'projected_savings',
    dependencies: ['salary.amount', 'bills.amount', 'expenses.amount'],
  },
  {
    id: 'goal-funding-gap:4',
    kind: 'goal_funding_gap',
    dependencies: ['goal.targetAmount'],
  },
  {
    id: 'goal-feasibility:4',
    kind: 'goal_feasibility',
    dependencies: ['goal.targetAmount', 'salary.amount', 'bills.amount'],
  },
  {
    id: 'trip-settlement:5',
    kind: 'trip_settlement',
    dependencies: ['trip.expenseAmount', 'trip.splitWeight'],
  },
]);

const sourceDefinitionByInput = new Map(
  SOURCE_DEFINITIONS.map((definition) => [definition.input, definition])
);

const failureAssignmentsArbitrary = fc
  .tuple(...SOURCE_DEFINITIONS.map(() => fc.constantFrom(
    OUTCOME_STATUSES.AVAILABLE,
    OUTCOME_STATUSES.MISSING_INPUT,
    OUTCOME_STATUSES.INVALID_INPUT
  )))
  .filter((statuses) => (
    statuses.includes(OUTCOME_STATUSES.MISSING_INPUT)
    && statuses.includes(OUTCOME_STATUSES.INVALID_INPUT)
  ));

const sourceValuesArbitrary = fc.tuple(
  ...SOURCE_DEFINITIONS.map(({ valueKind }) => (
    valueKind === 'money'
      ? fc.integer({ min: 1, max: 1_000_000_000 })
      : fc.integer({ min: 1, max: 1_000 })
  ))
);

const scenarioArbitrary = fc.record({
  dataVersion: fc.integer({ min: 0, max: 1_000_000 }),
  failureAssignments: failureAssignmentsArbitrary,
  sourceValues: sourceValuesArbitrary,
});

function sourceAccess() {
  return createAuthorizedSourceAccess({
    authenticated: true,
    authorized: true,
    principalId: 41,
    resourceScope: 'user:41:month:2026-11',
  });
}

function mapByInput(values) {
  return new Map(
    SOURCE_DEFINITIONS.map(({ input }, index) => [input, values[index]])
  );
}

function createSourceRef(definition, value) {
  return {
    ref: `${definition.sourceType}:${definition.recordId}:${definition.field}`,
    sourceType: definition.sourceType,
    recordId: definition.recordId,
    field: definition.field,
    label: definition.label,
    value: definition.valueKind === 'money'
      ? { currency: 'INR', amountMinor: value }
      : value,
    confirmedAt: '2026-11-18T00:00:00.000Z',
    period: { month: PERIOD.month },
  };
}

function createDependency(definition, status, value) {
  const dependency = {
    input: definition.input,
    status,
  };

  if (status === OUTCOME_STATUSES.AVAILABLE) {
    dependency.sourceRefs = [createSourceRef(definition, value)];
  } else if (status === OUTCOME_STATUSES.INVALID_INPUT) {
    dependency.constraint = definition.constraint;
  }

  return dependency;
}

function buildSnapshot({
  access,
  dataVersion,
  statusByInput,
  valueByInput,
  calculationCounts,
}) {
  return Object.fromEntries(OUTCOME_DEFINITIONS.map((definition) => {
    const dependencies = definition.dependencies.map((input) => {
      const sourceDefinition = sourceDefinitionByInput.get(input);
      return createDependency(
        sourceDefinition,
        statusByInput.get(input),
        valueByInput.get(input)
      );
    });

    const result = createDependentOutcome({
      sourceAccess: access,
      id: definition.id,
      kind: definition.kind,
      classification: VALUE_CLASSIFICATIONS.CALCULATED_RESULT,
      period: PERIOD,
      dataVersion,
      dependencies,
      calculate() {
        calculationCounts.set(
          definition.kind,
          (calculationCounts.get(definition.kind) ?? 0) + 1
        );
        const amountMinor = definition.dependencies.reduce(
          (total, input) => total + valueByInput.get(input),
          0
        );
        return {
          value: { currency: 'INR', amountMinor },
          operations: [],
        };
      },
    });

    return [definition.kind, result];
  }));
}

function assertMinimalCorrection({ outcome, expectedBlocking, definition }) {
  assert.equal('value' in outcome, false);

  if (expectedBlocking.status === OUTCOME_STATUSES.MISSING_INPUT) {
    assert.deepEqual(outcome.missing, [{
      input: expectedBlocking.input,
      unlocks: [definition.kind],
    }]);
    assert.equal('invalid' in outcome, false);
    return;
  }

  assert.deepEqual(outcome.invalid, [{
    input: expectedBlocking.input,
    constraint: sourceDefinitionByInput.get(expectedBlocking.input).constraint,
    affects: [definition.kind],
  }]);
  assert.equal('missing' in outcome, false);
}

// Feature: financial-clarity-experience, Property 17: Outcome dependency failures are isolated and minimal
// **Validates: Requirements 1.9, 1.10, 8.11, 8.12, 8.13, 9.7**
test('Property 17: outcome dependency failures are isolated and minimal', () => {
  fc.assert(
    fc.property(scenarioArbitrary, ({
      dataVersion,
      failureAssignments,
      sourceValues,
    }) => {
      const access = sourceAccess();
      const valueByInput = mapByInput(sourceValues);
      const baselineStatusByInput = new Map(
        SOURCE_DEFINITIONS.map(({ input }) => [input, OUTCOME_STATUSES.AVAILABLE])
      );
      const failedStatusByInput = mapByInput(failureAssignments);
      const baselineCalculationCounts = new Map();
      const failedCalculationCounts = new Map();

      const baseline = buildSnapshot({
        access,
        dataVersion,
        statusByInput: baselineStatusByInput,
        valueByInput,
        calculationCounts: baselineCalculationCounts,
      });
      const withFailures = buildSnapshot({
        access,
        dataVersion,
        statusByInput: failedStatusByInput,
        valueByInput,
        calculationCounts: failedCalculationCounts,
      });

      for (const definition of OUTCOME_DEFINITIONS) {
        const baselineResult = baseline[definition.kind];
        const actualResult = withFailures[definition.kind];
        const expectedBlockingInput = definition.dependencies.find(
          (input) => failedStatusByInput.get(input) !== OUTCOME_STATUSES.AVAILABLE
        );

        assert.equal(baselineResult.outcome.status, OUTCOME_STATUSES.AVAILABLE);
        assert.equal(baselineCalculationCounts.get(definition.kind), 1);

        if (expectedBlockingInput === undefined) {
          assert.deepEqual(actualResult, baselineResult);
          assert.equal(failedCalculationCounts.get(definition.kind), 1);
          continue;
        }

        const expectedBlocking = {
          input: expectedBlockingInput,
          status: failedStatusByInput.get(expectedBlockingInput),
        };
        assert.notDeepEqual(actualResult, baselineResult);
        assert.equal(actualResult.outcome.status, expectedBlocking.status);
        assert.equal(actualResult.explanation, null);
        assert.equal(failedCalculationCounts.has(definition.kind), false);
        assertMinimalCorrection({
          outcome: actualResult.outcome,
          expectedBlocking,
          definition,
        });
      }
    }),
    { numRuns: NUM_RUNS }
  );
});

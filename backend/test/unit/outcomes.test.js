import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OUTCOME_KINDS,
  OUTCOME_STATUSES,
  PUBLIC_TRIP_OUTCOME_TYPE,
  VALUE_CLASSIFICATIONS,
  createAuthorizedSourceAccess,
  createAvailableOutcome,
  createCalculationExplanation,
  createCalculationFailedOutcome,
  createDependentOutcome,
  createInvalidOutcome,
  createMissingOutcome,
  createPublicTripOutcome,
  createRefreshFailedOutcome,
  createStaleOutcome,
} from '../../src/domain/outcomes.js';

const PERIOD = Object.freeze({
  month: '2026-11',
  start: '2026-11-01',
  endExclusive: '2026-12-01',
  timeZone: 'Asia/Kolkata',
  asOfDate: '2026-11-18',
  daysRemainingInclusive: 13,
});

function sourceAccess() {
  return createAuthorizedSourceAccess({
    authenticated: true,
    authorized: true,
    principalId: 41,
    resourceScope: 'user:41:month:2026-11',
  });
}

test('financial snapshot outcome kinds include today allowance', () => {
  assert.deepEqual(Object.values(OUTCOME_KINDS), [
    'monthly_plan',
    'spending',
    'goal',
    'trip',
    'trip_summary',
    'today_allowance',
  ]);
  assert.equal(Object.isFrozen(OUTCOME_KINDS), true);
});

function salarySource(order = 1) {
  return {
    order,
    ref: 'salary:7:amountMinor',
    sourceType: 'salary',
    recordId: 7,
    field: 'amountMinor',
    label: 'Salary for 2026-11',
    value: { currency: 'INR', amountMinor: 100_000 },
    confirmedAt: '2026-11-01T00:00:00.000Z',
    period: { month: '2026-11' },
  };
}

function billSource(order = 2) {
  return {
    order,
    ref: 'bill:9:amountMinor',
    sourceType: 'bill',
    recordId: 9,
    field: 'amountMinor',
    label: 'Rent',
    value: { currency: 'INR', amountMinor: 20_000 },
    confirmedAt: '2026-11-02T00:00:00.000Z',
    period: { month: '2026-11' },
  };
}

function availableInput(overrides = {}) {
  return {
    sourceAccess: sourceAccess(),
    id: 'monthly-plan:2026-11',
    kind: 'monthly_plan',
    classification: VALUE_CLASSIFICATIONS.CALCULATED_RESULT,
    period: PERIOD,
    dataVersion: 42,
    value: { disposableIncome: { currency: 'INR', amountMinor: 80_000 } },
    sourceRefs: [salarySource()],
    rounding: {
      precisionMinor: 1,
      direction: 'half_up',
      adjustmentMinor: -1,
      adjustmentTarget: 'savingsTarget',
    },
    ...overrides,
  };
}

test('available outcomes generate ordered, classified, version-coherent explanations', () => {
  const sourceAccessCapability = sourceAccess();
  const outcome = createAvailableOutcome(availableInput({
    sourceAccess: sourceAccessCapability,
    sourceRefs: [billSource(2), salarySource(1)],
  }));
  const explanation = createCalculationExplanation({
    sourceAccess: sourceAccessCapability,
    outcome,
    operations: [
      {
        order: 2,
        stage: 'disposable_income',
        operation: 'subtract',
        operandRefs: ['salary:7:amountMinor', 'bill:9:amountMinor'],
        intermediateResults: {
          activeBillsTotal: { currency: 'INR', amountMinor: 20_000 },
        },
        result: { currency: 'INR', amountMinor: 80_000 },
        explanationKey: 'monthly_plan.disposable_income',
      },
      {
        order: 1,
        stage: 'salary',
        operation: 'sum',
        operandRefs: ['salary:7:amountMinor'],
        result: { currency: 'INR', amountMinor: 100_000 },
        explanationKey: 'monthly_plan.salary',
      },
    ],
  });

  assert.equal(outcome.status, OUTCOME_STATUSES.AVAILABLE);
  assert.deepEqual(outcome.explanationRef, {
    outcomeId: outcome.id,
    dataVersion: 42,
  });
  assert.deepEqual(
    outcome.sourceRefs.map(({ order, ref, classification }) => ({ order, ref, classification })),
    [
      {
        order: 1,
        ref: 'salary:7:amountMinor',
        classification: VALUE_CLASSIFICATIONS.ENTERED_FACT,
      },
      {
        order: 2,
        ref: 'bill:9:amountMinor',
        classification: VALUE_CLASSIFICATIONS.ENTERED_FACT,
      },
    ]
  );
  assert.equal(explanation.dataVersion, outcome.dataVersion);
  assert.deepEqual(explanation.period, outcome.period);
  assert.deepEqual(explanation.precision, {
    currency: 'INR',
    minorUnit: 'paise',
    minorUnitsPerMajor: 100,
    fractionDigits: 2,
    precisionMinor: 1,
  });
  assert.deepEqual(
    explanation.operations.map(({ order, stage }) => ({ order, stage })),
    [
      { order: 1, stage: 'salary' },
      { order: 2, stage: 'disposable_income' },
    ]
  );
  assert.deepEqual(
    explanation.operations[1].intermediateResultClassifications,
    { activeBillsTotal: VALUE_CLASSIFICATIONS.CALCULATED_RESULT }
  );
  assert.deepEqual(explanation.rounding, {
    precisionMinor: 1,
    direction: 'half_up',
    adjustmentMinor: -1,
    adjustmentTarget: 'savingsTarget',
  });
  assert.deepEqual(explanation.result, {
    classification: VALUE_CLASSIFICATIONS.CALCULATED_RESULT,
    value: outcome.value,
  });
});

test('private outcome and explanation builders require an opaque authorized capability', () => {
  assert.throws(
    () => createAuthorizedSourceAccess({
      authenticated: true,
      authorized: false,
      principalId: 41,
      resourceScope: 'user:41',
    }),
    /authenticated, authorized access/
  );
  assert.throws(
    () => createAvailableOutcome(availableInput({
      sourceAccess: {
        access: 'authenticated_authorized',
        principalId: 41,
        resourceScope: 'user:41',
      },
    })),
    /authorized source access capability/
  );
});

test('dependent outcomes report only the first direct missing or invalid correction', () => {
  const access = sourceAccess();
  const unaffected = createAvailableOutcome(availableInput({
    sourceAccess: access,
    id: 'trip-summary',
    kind: 'trip_summary',
    value: [],
    sourceRefs: [],
  }));
  let calculations = 0;
  const missing = createDependentOutcome({
    sourceAccess: access,
    id: 'daily-guide:2026-11',
    kind: 'daily_spending_guide',
    classification: VALUE_CLASSIFICATIONS.CALCULATED_RESULT,
    period: PERIOD,
    dataVersion: 42,
    dependencies: [
      { status: OUTCOME_STATUSES.MISSING_INPUT, input: 'salary' },
      {
        status: OUTCOME_STATUSES.INVALID_INPUT,
        input: 'bills',
        constraint: 'each bill amount must be non-negative',
      },
      { status: OUTCOME_STATUSES.AVAILABLE, input: 'expenses' },
    ],
    calculate() {
      calculations += 1;
      return { value: { currency: 'INR', amountMinor: 1 } };
    },
  });

  assert.equal(calculations, 0);
  assert.equal(missing.outcome.status, OUTCOME_STATUSES.MISSING_INPUT);
  assert.deepEqual(missing.outcome.missing, [{
    input: 'salary',
    unlocks: ['daily_spending_guide'],
  }]);
  assert.equal(unaffected.status, OUTCOME_STATUSES.AVAILABLE);
  assert.deepEqual(unaffected.value, []);

  const invalid = createDependentOutcome({
    sourceAccess: access,
    id: 'projected-savings:2026-11',
    kind: 'projected_savings',
    classification: VALUE_CLASSIFICATIONS.CALCULATED_RESULT,
    period: PERIOD,
    dataVersion: 42,
    dependencies: [{
      status: OUTCOME_STATUSES.INVALID_INPUT,
      input: 'expense.amount',
      constraint: 'a non-negative amount in paise',
    }],
    calculate() {
      throw new Error('must not run');
    },
  });
  assert.deepEqual(invalid.outcome.invalid, [{
    input: 'expense.amount',
    constraint: 'a non-negative amount in paise',
    affects: ['projected_savings'],
  }]);
});

test('stale and failed outcomes retain confirmed facts with one scoped retry', () => {
  const access = sourceAccess();
  const common = availableInput({ sourceAccess: access });
  const stale = createStaleOutcome({
    ...common,
    stale: { sourcePeriod: '2026-10', requestedPeriod: '2026-11' },
    retryScopeKey: 'summary:monthly-plan',
  });
  const refreshFailed = createRefreshFailedOutcome({
    ...common,
    retryScopeKey: 'summary:monthly-plan',
    attemptedAt: '2026-11-18T10:00:00.000Z',
  });
  const calculationFailed = createCalculationFailedOutcome({
    sourceAccess: access,
    id: common.id,
    kind: common.kind,
    classification: common.classification,
    period: common.period,
    dataVersion: common.dataVersion,
    sourceRefs: common.sourceRefs,
    retryScopeKey: 'summary:monthly-plan',
  });

  assert.equal(stale.status, OUTCOME_STATUSES.STALE);
  assert.deepEqual(stale.value, common.value);
  assert.deepEqual(stale.retry, {
    action: 'refresh',
    scopeKey: 'summary:monthly-plan',
  });
  assert.deepEqual(stale.stale, {
    sourcePeriod: '2026-10',
    requestedPeriod: '2026-11',
  });

  assert.equal(refreshFailed.status, OUTCOME_STATUSES.REFRESH_FAILED);
  assert.deepEqual(refreshFailed.value, common.value);
  assert.deepEqual(refreshFailed.retry, {
    action: 'refresh',
    scopeKey: 'summary:monthly-plan',
  });
  assert.deepEqual(refreshFailed.refreshFailure, {
    code: 'REFRESH_FAILED',
    attemptedAt: '2026-11-18T10:00:00.000Z',
  });

  assert.equal(calculationFailed.status, OUTCOME_STATUSES.CALCULATION_FAILED);
  assert.equal('value' in calculationFailed, false);
  assert.equal(calculationFailed.confirmedInputsRetained, true);
  assert.equal(calculationFailed.sourceRefs[0].value.amountMinor, 100_000);
  assert.deepEqual(calculationFailed.retry, {
    action: 'recalculate',
    scopeKey: 'summary:monthly-plan',
  });
});

test('dependent calculation failures are contained without exposing error details', () => {
  const result = createDependentOutcome({
    sourceAccess: sourceAccess(),
    id: 'monthly-plan:2026-11',
    kind: 'monthly_plan',
    classification: VALUE_CLASSIFICATIONS.CALCULATED_RESULT,
    period: PERIOD,
    dataVersion: 42,
    retryScopeKey: 'summary:monthly-plan',
    dependencies: [{
      status: OUTCOME_STATUSES.AVAILABLE,
      input: 'salary',
      sourceRefs: [salarySource()],
    }],
    calculate() {
      throw new Error('sensitive calculator detail: salary was 100000');
    },
  });

  assert.equal(result.outcome.status, OUTCOME_STATUSES.CALCULATION_FAILED);
  assert.equal(result.explanation, null);
  assert.equal(JSON.stringify(result).includes('sensitive calculator detail'), false);
  assert.equal(result.outcome.sourceRefs[0].classification, VALUE_CLASSIFICATIONS.ENTERED_FACT);
});

test('public trip outcomes use a separate allowlisted type without private source records', () => {
  const publicOutcome = createPublicTripOutcome({
    tripVersion: 8,
    balances: [{
      memberKey: 'member-a',
      amountMinor: -500,
      label: 'owed',
      email: 'private@example.com',
      userId: 41,
    }],
    settlements: [{
      fromMemberKey: 'member-a',
      toMemberKey: 'member-b',
      amountMinor: 500,
      sourceExpenseId: 99,
    }],
    sourceRefs: [salarySource()],
    operations: [{ private: true }],
  });

  assert.deepEqual(publicOutcome, {
    schemaVersion: 1,
    type: PUBLIC_TRIP_OUTCOME_TYPE,
    status: OUTCOME_STATUSES.AVAILABLE,
    tripVersion: 8,
    balances: [{ memberKey: 'member-a', amountMinor: -500, label: 'owed' }],
    settlements: [{
      fromMemberKey: 'member-a',
      toMemberKey: 'member-b',
      amountMinor: 500,
    }],
  });
  assert.equal('sourceRefs' in publicOutcome, false);
  assert.equal(JSON.stringify(publicOutcome).includes('private@example.com'), false);
});

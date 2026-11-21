import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {
  VALUE_CLASSIFICATIONS,
  createAuthorizedSourceAccess,
  createAvailableOutcome,
  createCalculationExplanation,
  createStaleOutcome,
} from '../../src/domain/outcomes.js';
import {
  FINANCIAL_CLARITY_TIME_ZONE,
  calculateMonthlyPlan,
} from '../../src/domain/monthlyPlan.js';
import { calculateTripOutcome } from '../../src/domain/trips.js';

const NUM_RUNS = 100;
const MONTHLY_OPERATION_ORDER = Object.freeze([
  'salary',
  'active_bills',
  'disposable_income',
  'allocation',
  'expenses',
  'daily_guide',
]);
const DEFAULT_NEEDS_CATEGORIES = new Set([
  'Food',
  'Groceries',
  'Transport',
  'Bills',
  'Health',
]);

function money(amountMinor) {
  return { currency: 'INR', amountMinor };
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function previousMonth(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  return monthNumber === 1
    ? `${year - 1}-12`
    : `${year}-${pad(monthNumber - 1)}`;
}

function signedHalfUp(dividend, divisor) {
  const sign = dividend < 0 ? -1n : 1n;
  const magnitude = BigInt(Math.abs(dividend));
  const denominator = BigInt(divisor);
  let quotient = magnitude / denominator;
  if ((magnitude % denominator) * 2n >= denominator) quotient += 1n;
  return Number(sign * quotient);
}

function ratioHalfUpFraction(numerator, denominator) {
  assert.equal(typeof numerator, 'bigint');
  assert.equal(typeof denominator, 'bigint');
  assert.ok(numerator >= 0n, 'ratio numerator must be non-negative');
  assert.ok(denominator > 0n, 'ratio denominator must be positive');
  let quotient = numerator / denominator;
  if ((numerator % denominator) * 2n >= denominator) quotient += 1n;
  assert.ok(
    quotient <= BigInt(Number.MAX_SAFE_INTEGER),
    'rounded ratio must remain a safe integer number'
  );
  return Number(quotient);
}

function ratioHalfUp(amountMinor, numerator, denominator) {
  return ratioHalfUpFraction(
    BigInt(amountMinor) * BigInt(numerator),
    BigInt(denominator)
  );
}

function parseUnsignedDecimalInteger(value, label, { positive = false } = {}) {
  assert.equal(typeof value, 'string', `${label} must be a decimal string`);
  assert.match(
    value,
    /^(0|[1-9]\d*)$/,
    `${label} must be a canonical unsigned decimal string`
  );
  const parsed = BigInt(value);
  if (positive) assert.ok(parsed > 0n, `${label} must be positive`);
  return parsed;
}

function expectedRounding(direction, adjustmentMinor = 0, adjustmentTarget) {
  return {
    precisionMinor: 1,
    direction,
    adjustmentMinor,
    ...(adjustmentTarget === undefined ? {} : { adjustmentTarget }),
  };
}

function sourceMap(explanation) {
  return new Map(explanation.sourceRefs.map((source) => [source.ref, source]));
}

function sourceAmount(sources, ref) {
  const value = sources.get(ref)?.value;
  assert.equal(value?.currency, 'INR', `missing INR source ${ref}`);
  assert.equal(Number.isSafeInteger(value.amountMinor), true, `invalid paise source ${ref}`);
  return value.amountMinor;
}

function sourceNumber(sources, ref, { minimum = Number.MIN_SAFE_INTEGER } = {}) {
  const value = sources.get(ref)?.value;
  assert.equal(Number.isSafeInteger(value), true, `invalid numeric source ${ref}`);
  assert.ok(value >= minimum, `numeric source ${ref} is below ${minimum}`);
  return value;
}

function assertExplanationEnvelope(outcome, explanation) {
  assert.equal(explanation.schemaVersion, 1);
  assert.equal(Number.isSafeInteger(outcome.dataVersion), true);
  assert.ok(outcome.dataVersion >= 0);
  assert.equal(Number.isSafeInteger(explanation.dataVersion), true);
  assert.ok(explanation.dataVersion >= 0);
  assert.deepEqual(outcome.explanationRef, {
    outcomeId: outcome.id,
    dataVersion: outcome.dataVersion,
  });
  assert.equal(explanation.outcomeId, outcome.id);
  assert.equal(explanation.dataVersion, outcome.dataVersion);
  assert.deepEqual(explanation.period, outcome.period);
  assert.equal(explanation.classification, VALUE_CLASSIFICATIONS.CALCULATED_RESULT);
  assert.deepEqual(explanation.precision, {
    currency: 'INR',
    minorUnit: 'paise',
    minorUnitsPerMajor: 100,
    fractionDigits: 2,
    precisionMinor: 1,
  });
  assert.equal(explanation.precisionMinor, 1);
  assert.equal(
    explanation.sourceRefs.every(
      ({ classification }) => classification === VALUE_CLASSIFICATIONS.ENTERED_FACT
    ),
    true
  );
  assert.equal(
    explanation.operations.every(
      ({ resultClassification }) => (
        resultClassification === VALUE_CLASSIFICATIONS.CALCULATED_RESULT
      )
    ),
    true
  );
  assert.deepEqual(explanation.result, {
    classification: VALUE_CLASSIFICATIONS.CALCULATED_RESULT,
    value: outcome.value,
  });
}

function evaluateMonthlyExplanation(explanation) {
  const sources = sourceMap(explanation);
  const operations = explanation.operations;
  assert.deepEqual(
    operations.map(({ order, stage }) => ({ order, stage })),
    MONTHLY_OPERATION_ORDER.map((stage, index) => ({ order: index + 1, stage }))
  );

  const [salaryOperation, billsOperation, disposableOperation, allocationOperation,
    expensesOperation, dailyGuideOperation] = operations;
  const salaryMinor = sourceAmount(sources, salaryOperation.operandRefs[0]);
  assert.deepEqual(salaryOperation.result, money(salaryMinor));

  const billsTotalMinor = billsOperation.operandRefs.reduce(
    (total, ref) => total + sourceAmount(sources, ref),
    0
  );
  assert.deepEqual(billsOperation.result, money(billsTotalMinor));

  const differenceMinor = salaryMinor - billsTotalMinor;
  const disposableIncomeMinor = Math.max(0, differenceMinor);
  const shortfallMinor = Math.max(0, -differenceMinor);
  assert.deepEqual(disposableOperation.intermediateResults, {
    difference: money(differenceMinor),
    shortfall: money(shortfallMinor),
  });
  assert.deepEqual(disposableOperation.result, money(disposableIncomeMinor));

  const needsBudgetMinor = ratioHalfUp(disposableIncomeMinor, 1, 2);
  const wantsBudgetMinor = ratioHalfUp(disposableIncomeMinor, 3, 10);
  const independentlyRoundedSavingsMinor = ratioHalfUp(disposableIncomeMinor, 1, 5);
  const savingsTargetMinor = disposableIncomeMinor - needsBudgetMinor - wantsBudgetMinor;
  const spendableBudgetMinor = needsBudgetMinor + wantsBudgetMinor;
  const savingsAdjustmentMinor = savingsTargetMinor - independentlyRoundedSavingsMinor;
  assert.deepEqual(allocationOperation.intermediateResults, {
    needsBudget: money(needsBudgetMinor),
    wantsBudget: money(wantsBudgetMinor),
    savingsTarget: money(savingsTargetMinor),
    spendableBudget: money(spendableBudgetMinor),
  });
  assert.deepEqual(allocationOperation.result, money(disposableIncomeMinor));
  assert.deepEqual(allocationOperation.rounding, {
    needsBudget: expectedRounding(disposableIncomeMinor % 2 === 0 ? 'exact' : 'half_up'),
    wantsBudget: expectedRounding(
      (disposableIncomeMinor * 3) % 10 === 0 ? 'exact' : 'half_up'
    ),
    savingsTarget: expectedRounding(
      disposableIncomeMinor % 5 === 0 && savingsAdjustmentMinor === 0
        ? 'exact'
        : 'half_up',
      savingsAdjustmentMinor,
      'savingsTarget'
    ),
  });

  const treatmentByExpenseId = new Map(
    expensesOperation.appliedTreatments.map(({ expenseId, treatment }) => [
      expenseId,
      treatment,
    ])
  );
  let needsSpentMinor = 0;
  let wantsSpentMinor = 0;
  for (const ref of expensesOperation.operandRefs) {
    const source = sources.get(ref);
    assert.equal(source?.sourceType, 'expense');
    const treatment = treatmentByExpenseId.get(source.recordId)
      ?? (DEFAULT_NEEDS_CATEGORIES.has(source.category) ? 'needs' : 'wants');
    assert.equal(['needs', 'wants'].includes(treatment), true);
    if (treatment === 'needs') needsSpentMinor += sourceAmount(sources, ref);
    else wantsSpentMinor += sourceAmount(sources, ref);
  }
  const expensesTotalMinor = needsSpentMinor + wantsSpentMinor;
  const remainingSpendableMinor = spendableBudgetMinor - expensesTotalMinor;
  const projectedSavingsMinor = Math.max(
    0,
    salaryMinor - billsTotalMinor - expensesTotalMinor
  );
  assert.deepEqual(expensesOperation.intermediateResults, {
    needsSpent: money(needsSpentMinor),
    wantsSpent: money(wantsSpentMinor),
    remainingSpendable: money(remainingSpendableMinor),
    projectedSavings: money(projectedSavingsMinor),
  });
  assert.deepEqual(expensesOperation.result, money(expensesTotalMinor));

  assert.equal(dailyGuideOperation.divisor, explanation.period.daysRemainingInclusive);
  const dailySpendingGuideMinor = signedHalfUp(
    remainingSpendableMinor,
    dailyGuideOperation.divisor
  );
  const dailyDirection = remainingSpendableMinor % dailyGuideOperation.divisor === 0
    ? 'exact'
    : 'half_up';
  assert.deepEqual(dailyGuideOperation.rounding, expectedRounding(dailyDirection));
  assert.deepEqual(dailyGuideOperation.result, money(dailySpendingGuideMinor));
  assert.deepEqual(explanation.rounding, expectedRounding(dailyDirection));

  return money(dailySpendingGuideMinor);
}

function adjustedShares(amountMinor, memberWeights) {
  const totalWeight = memberWeights.reduce((total, { weight }) => total + weight, 0);
  const denominator = BigInt(totalWeight);
  const shares = memberWeights.map(({ memberId, weight }) => {
    const numerator = BigInt(amountMinor) * BigInt(weight);
    return {
      memberId,
      weight,
      numerator,
      denominator,
      initialAmountMinor: ratioHalfUpFraction(numerator, denominator),
    };
  });
  const initialTotal = shares.reduce(
    (total, { initialAmountMinor }) => total + initialAmountMinor,
    0
  );
  const difference = amountMinor - initialTotal;
  const direction = Math.sign(difference);
  let remaining = Math.abs(difference);
  const amounts = shares.map(({ initialAmountMinor }) => initialAmountMinor);
  const sequence = [];

  while (remaining > 0) {
    for (let index = 0; index < amounts.length && remaining > 0; index += 1) {
      if (direction < 0 && amounts[index] === 0) continue;
      amounts[index] += direction;
      remaining -= 1;
      sequence.push({
        sequence: sequence.length + 1,
        memberId: shares[index].memberId,
        adjustmentMinor: direction,
      });
    }
  }

  return {
    shares: shares.map((share, index) => ({
      ...share,
      amountMinor: amounts[index],
      adjustmentMinor: amounts[index] - share.initialAmountMinor,
    })),
    difference,
    sequence,
  };
}

function compareRemainingThenMember(left, right) {
  if (left.remainingMinor !== right.remainingMinor) {
    return right.remainingMinor - left.remainingMinor;
  }
  return left.memberId - right.memberId;
}

function referenceSettlements(balances) {
  const creditors = balances
    .filter(({ amountMinor }) => amountMinor > 0)
    .map(({ memberId, amountMinor }) => ({ memberId, remainingMinor: amountMinor }))
    .sort(compareRemainingThenMember);
  const debtors = balances
    .filter(({ amountMinor }) => amountMinor < 0)
    .map(({ memberId, amountMinor }) => ({ memberId, remainingMinor: -amountMinor }))
    .sort(compareRemainingThenMember);
  const settlements = [];
  let creditorIndex = 0;
  let debtorIndex = 0;

  while (creditorIndex < creditors.length && debtorIndex < debtors.length) {
    const creditor = creditors[creditorIndex];
    const debtor = debtors[debtorIndex];
    const amountMinor = Math.min(creditor.remainingMinor, debtor.remainingMinor);
    settlements.push({
      fromMemberId: debtor.memberId,
      toMemberId: creditor.memberId,
      amountMinor,
    });
    creditor.remainingMinor -= amountMinor;
    debtor.remainingMinor -= amountMinor;
    if (creditor.remainingMinor === 0) creditorIndex += 1;
    if (debtor.remainingMinor === 0) debtorIndex += 1;
  }
  return settlements;
}

function evaluateTripExplanation(explanation) {
  const sources = sourceMap(explanation);
  const allocationOperation = explanation.operations.find(
    ({ stage }) => stage === 'allocate_shared_expense'
  );
  const adjustmentOperation = explanation.operations.find(
    ({ stage }) => stage === 'adjust_allocation_remainder'
  );
  assert.ok(allocationOperation);
  assert.ok(adjustmentOperation);

  const amountMinor = sourceAmount(sources, allocationOperation.operandRefs[0]);
  const payerMemberId = sourceNumber(sources, allocationOperation.operandRefs[1], {
    minimum: 1,
  });
  const memberWeights = allocationOperation.operandRefs.slice(2).map((ref) => {
    const memberIdText = ref.slice(ref.lastIndexOf(':') + 1);
    assert.match(memberIdText, /^[1-9]\d*$/, `invalid member ID in source ref ${ref}`);
    const memberId = Number(memberIdText);
    assert.equal(Number.isSafeInteger(memberId), true, `unsafe member ID in source ref ${ref}`);
    return {
      memberId,
      weight: sourceNumber(sources, ref, { minimum: 0 }),
    };
  });
  const allocation = adjustedShares(amountMinor, memberWeights);

  assert.equal(Number.isSafeInteger(allocationOperation.expenseId), true);
  assert.ok(allocationOperation.expenseId > 0);
  assert.equal(allocationOperation.payerMemberId, payerMemberId);
  assert.equal(allocationOperation.splitRule, 'weighted');
  assert.deepEqual(allocationOperation.result, money(amountMinor));
  assert.equal(allocationOperation.allocations.length, allocation.shares.length);

  // Exact rational components may exceed JSON's safe integer range. The
  // explanation contract therefore carries only these components as canonical
  // unsigned decimal strings; all IDs, weights, paise, versions, and
  // adjustments remain safe-integer numbers.
  const parsedRawShares = new Map(
    allocationOperation.allocations.map((actual, index) => {
      const expected = allocation.shares[index];
      assert.equal(Number.isSafeInteger(actual.memberId), true);
      assert.ok(actual.memberId > 0);
      assert.equal(Number.isSafeInteger(actual.weight), true);
      assert.ok(actual.weight >= 0);
      assert.equal(actual.memberId, expected.memberId);
      assert.equal(actual.weight, expected.weight);
      assert.equal(
        actual.rawShare !== null
          && typeof actual.rawShare === 'object'
          && !Array.isArray(actual.rawShare),
        true,
        `raw share for member ${actual.memberId} must be an object`
      );
      assert.deepEqual(
        Object.keys(actual.rawShare).sort(),
        ['denominator', 'numerator']
      );
      const numerator = parseUnsignedDecimalInteger(
        actual.rawShare.numerator,
        `raw share numerator for member ${actual.memberId}`
      );
      const denominator = parseUnsignedDecimalInteger(
        actual.rawShare.denominator,
        `raw share denominator for member ${actual.memberId}`,
        { positive: true }
      );
      assert.equal(numerator, expected.numerator);
      assert.equal(denominator, expected.denominator);
      assert.deepEqual(
        actual.initialResult,
        money(ratioHalfUpFraction(numerator, denominator))
      );
      return [actual.memberId, { numerator, denominator }];
    })
  );

  assert.deepEqual(
    allocationOperation.allocations,
    allocation.shares.map((share) => {
      const rawShare = parsedRawShares.get(share.memberId);
      return {
        memberId: share.memberId,
        weight: share.weight,
        rawShare: {
          numerator: share.numerator.toString(),
          denominator: share.denominator.toString(),
        },
        initialResult: money(share.initialAmountMinor),
        result: money(share.amountMinor),
        rounding: expectedRounding(
          rawShare.numerator % rawShare.denominator === 0n
            && share.adjustmentMinor === 0
            ? 'exact'
            : 'half_up',
          share.adjustmentMinor,
          `tripExpense:${allocationOperation.expenseId}:member:${share.memberId}`
        ),
      };
    })
  );
  assert.deepEqual(adjustmentOperation.adjustmentSequence, allocation.sequence);
  assert.deepEqual(
    adjustmentOperation.adjustments,
    allocation.shares.map(({ memberId, adjustmentMinor }) => ({
      memberId,
      adjustmentMinor,
    }))
  );
  const allocationRounding = expectedRounding(
    allocation.difference === 0 ? 'exact' : 'half_up',
    allocation.difference,
    `tripExpense:${allocationOperation.expenseId}`
  );
  assert.deepEqual(adjustmentOperation.rounding, allocationRounding);
  assert.deepEqual(adjustmentOperation.result, money(amountMinor));
  assert.deepEqual(explanation.rounding, allocationRounding);

  const memberIds = memberWeights.map(({ memberId }) => memberId).sort((left, right) => left - right);
  const accounts = new Map(memberIds.map((memberId) => [memberId, {
    sharedExpensePaymentsMade: 0,
    settlementPaymentsMade: 0,
    allocatedShares: 0,
    settlementPaymentsReceived: 0,
  }]));
  accounts.get(payerMemberId).sharedExpensePaymentsMade += amountMinor;
  for (const share of allocation.shares) {
    accounts.get(share.memberId).allocatedShares += share.amountMinor;
  }

  const paymentOperations = explanation.operations.filter(
    ({ stage }) => stage === 'apply_settlement_payment'
  );
  assert.ok(paymentOperations.length > 0);
  for (const operation of paymentOperations) {
    const paymentMinor = sourceAmount(sources, operation.operandRefs[0]);
    const fromMemberId = sourceNumber(sources, operation.operandRefs[1], {
      minimum: 1,
    });
    const toMemberId = sourceNumber(sources, operation.operandRefs[2], {
      minimum: 1,
    });
    assert.equal(operation.fromMemberId, fromMemberId);
    assert.equal(operation.toMemberId, toMemberId);
    assert.deepEqual(operation.result, money(paymentMinor));
    accounts.get(fromMemberId).settlementPaymentsMade += paymentMinor;
    accounts.get(toMemberId).settlementPaymentsReceived += paymentMinor;
  }

  const balances = memberIds.map((memberId) => {
    const account = accounts.get(memberId);
    const amountMinor = account.sharedExpensePaymentsMade
      + account.settlementPaymentsMade
      - account.allocatedShares
      - account.settlementPaymentsReceived;
    const label = amountMinor > 0 ? 'receivable' : amountMinor < 0 ? 'owed' : 'settled';
    const operation = explanation.operations.find(
      ({ stage, memberId: operationMemberId }) => (
        stage === 'calculate_member_balance' && operationMemberId === memberId
      )
    );
    assert.ok(operation);
    assert.deepEqual(operation.intermediateResults, {
      sharedExpensePaymentsMade: money(account.sharedExpensePaymentsMade),
      settlementPaymentsMade: money(account.settlementPaymentsMade),
      allocatedShares: money(account.allocatedShares),
      settlementPaymentsReceived: money(account.settlementPaymentsReceived),
    });
    assert.deepEqual(operation.result, money(amountMinor));
    assert.equal(operation.classification, label);
    return { memberId, amountMinor, label };
  });

  const settlements = referenceSettlements(balances);
  const settlementOperations = explanation.operations.filter(
    ({ stage }) => stage === 'propose_settlement_transfer'
  );
  assert.deepEqual(
    settlementOperations.map(({ fromMemberId, toMemberId, result }) => ({
      fromMemberId,
      toMemberId,
      amountMinor: result.amountMinor,
    })),
    settlements
  );

  return {
    allocations: [{
      expenseId: allocationOperation.expenseId,
      shares: allocation.shares.map(({ memberId, amountMinor }) => ({
        memberId,
        amountMinor,
      })),
    }],
    balances,
    settlements,
  };
}

function createSourceAccess(resourceScope) {
  return createAuthorizedSourceAccess({
    authenticated: true,
    authorized: true,
    principalId: 1,
    resourceScope,
  });
}

function monthlyExplanation(plan, dataVersion, { stale = false } = {}) {
  const sourceAccess = createSourceAccess(`month:${plan.period.month}`);
  const input = {
    sourceAccess,
    id: 'daily-spending-guide',
    kind: 'daily_spending_guide',
    classification: VALUE_CLASSIFICATIONS.CALCULATED_RESULT,
    period: plan.period,
    dataVersion,
    value: money(plan.dailySpendingGuideMinor),
    sourceRefs: plan.sourceRefs,
    rounding: plan.operations.at(-1).rounding,
  };
  const outcome = stale
    ? createStaleOutcome({
      ...input,
      stale: {
        sourcePeriod: plan.period.month,
        requestedPeriod: 'current-month',
      },
      retryScopeKey: 'outcome:daily-spending-guide',
    })
    : createAvailableOutcome(input);
  const explanation = createCalculationExplanation({
    sourceAccess,
    outcome,
    operations: plan.operations,
  });
  return { outcome, explanation };
}

function tripDisplayedValue(trip) {
  return {
    allocations: trip.value.allocations.map(({ expenseId, allocations }) => ({
      expenseId,
      shares: allocations.map(({ memberId, amountMinor }) => ({ memberId, amountMinor })),
    })),
    balances: trip.value.balances.map(({ memberId, amountMinor, label }) => ({
      memberId,
      amountMinor,
      label,
    })),
    settlements: trip.value.settlements.map(({ fromMemberId, toMemberId, amountMinor }) => ({
      fromMemberId,
      toMemberId,
      amountMinor,
    })),
  };
}

function tripExplanation(trip, period, dataVersion) {
  assert.equal(trip.status, 'available');
  const sourceAccess = createSourceAccess(`trip:${trip.tripId}`);
  const outcome = createAvailableOutcome({
    sourceAccess,
    id: `trip-settlement:${trip.tripId}`,
    kind: 'trip_settlement',
    classification: VALUE_CLASSIFICATIONS.CALCULATED_RESULT,
    period,
    dataVersion,
    value: tripDisplayedValue(trip),
    sourceRefs: trip.value.explanation.sourceRefs,
    rounding: trip.value.allocations[0].rounding,
  });
  const explanation = createCalculationExplanation({
    sourceAccess,
    outcome,
    operations: trip.value.explanation.operations,
  });
  return { outcome, explanation };
}

function updateOpenPanel(panel, next) {
  assert.equal(panel.open, true);
  assert.equal(next.outcome.id, panel.outcomeId);
  assert.ok(next.outcome.dataVersion > panel.explanation.dataVersion);
  assertExplanationEnvelope(next.outcome, next.explanation);
  panel.outcome = next.outcome;
  panel.explanation = next.explanation;
  assert.equal(panel.open, true);
  return panel;
}

function buildMonthlyInput({ month, day, salaryMinor, bills, expenses }) {
  const localDate = `${month}-${pad(day)}`;
  return {
    month,
    localDate,
    timeZone: FINANCIAL_CLARITY_TIME_ZONE,
    salaryEntries: [{
      id: 1,
      month,
      amountMinor: salaryMinor,
      confirmedAt: `${localDate}T00:00:00.000Z`,
    }],
    bills: bills.map((bill, index) => ({
      id: 100 + index,
      label: `Bill ${index + 1}`,
      amountMinor: bill.amountMinor,
      active: bill.active,
      effectiveFromMonth: null,
      effectiveToMonth: null,
      confirmedAt: `${localDate}T00:00:00.000Z`,
    })),
    expenses: expenses.map((expense, index) => ({
      id: 200 + index,
      month,
      amountMinor: expense.amountMinor,
      category: expense.category,
      confirmedAt: `${localDate}T00:00:00.000Z`,
    })),
    categoryTreatments: [],
  };
}

const monthlyScenarioArbitrary = fc.record({
  year: fc.integer({ min: 2024, max: 2035 }),
  monthNumber: fc.integer({ min: 1, max: 12 }),
  day: fc.integer({ min: 1, max: 28 }),
  dataVersion: fc.integer({ min: 0, max: 1_000_000 }),
  disposableIncomeMinor: fc.integer({ min: 100, max: 5_000_000 }),
  salaryIncreaseMinor: fc.integer({ min: 100, max: 1_000_000 }),
  bills: fc.array(fc.record({
    amountMinor: fc.integer({ min: 0, max: 500_000 }),
    active: fc.boolean(),
  }), { maxLength: 4 }),
  expenses: fc.array(fc.record({
    amountMinor: fc.integer({ min: 0, max: 500_000 }),
    category: fc.constantFrom('Food', 'Other'),
  }), { maxLength: 4 }),
});

const tripScenarioArbitrary = fc.integer({ min: 2, max: 5 }).chain((memberCount) => (
  fc.record({
    tripId: fc.integer({ min: 1, max: 100_000 }),
    tripVersion: fc.integer({ min: 0, max: 1_000_000 }),
    amountMinor: fc.integer({ min: 1, max: 1_000_000 }),
    amountIncreaseMinor: fc.integer({ min: 1, max: 100_000 }),
    payerIndex: fc.integer({ min: 0, max: memberCount - 1 }),
    weights: fc.array(fc.integer({ min: 0, max: 1_000 }), {
      minLength: memberCount,
      maxLength: memberCount,
    }).filter((weights) => weights.some((weight) => weight > 0)),
    paymentAmountMinor: fc.integer({ min: 1, max: 500_000 }),
    paymentFromIndex: fc.integer({ min: 0, max: memberCount - 1 }),
    paymentRecipientOffset: fc.integer({ min: 1, max: memberCount - 1 }),
    memberCount: fc.constant(memberCount),
  })
));

const scenarioArbitrary = fc.record({
  monthly: monthlyScenarioArbitrary,
  trip: tripScenarioArbitrary,
});

function buildTrip(scenario, amountMinor, tripVersion) {
  const members = Array.from({ length: scenario.memberCount }, (_, index) => ({
    id: index + 1,
    name: `Member ${index + 1}`,
  }));
  const payerMemberId = members[scenario.payerIndex].id;
  const fromMemberId = members[scenario.paymentFromIndex].id;
  const recipientIndex = (
    scenario.paymentFromIndex + scenario.paymentRecipientOffset
  ) % scenario.memberCount;
  const records = [
    {
      id: 1,
      kind: 'shared_expense',
      payerMemberId,
      amountMinor,
      splitRule: 'weighted',
      memberWeights: members.map((member, index) => ({
        memberId: member.id,
        weight: scenario.weights[index],
      })),
    },
    {
      id: 2,
      kind: 'settlement_payment',
      fromMemberId,
      toMemberId: members[recipientIndex].id,
      amountMinor: scenario.paymentAmountMinor,
    },
  ];
  return calculateTripOutcome({
    tripId: scenario.tripId,
    tripVersion,
    members,
    records,
  });
}

// Feature: financial-clarity-experience, Property 18: Explanations reproduce their outcomes
// **Validates: Requirements 4.17, 7.11, 9.1, 9.2, 9.3, 9.4, 9.5, 9.9, 9.10, 9.12**
test('Property 18: explanations reproduce their outcomes and remain version coherent', () => {
  fc.assert(
    fc.property(scenarioArbitrary, ({ monthly, trip }) => {
      const month = `${monthly.year}-${pad(monthly.monthNumber)}`;
      const oldMonth = previousMonth(month);
      const activeBillsTotal = monthly.bills
        .filter(({ active }) => active)
        .reduce((total, { amountMinor }) => total + amountMinor, 0);
      const salaryMinor = activeBillsTotal + monthly.disposableIncomeMinor;
      const oldPlan = calculateMonthlyPlan(buildMonthlyInput({
        ...monthly,
        month: oldMonth,
        salaryMinor,
      }));
      const currentPlan = calculateMonthlyPlan(buildMonthlyInput({
        ...monthly,
        month,
        salaryMinor,
      }));
      const changedPlan = calculateMonthlyPlan(buildMonthlyInput({
        ...monthly,
        month,
        salaryMinor: salaryMinor + monthly.salaryIncreaseMinor,
      }));

      const stale = monthlyExplanation(oldPlan, monthly.dataVersion, { stale: true });
      const refreshed = monthlyExplanation(currentPlan, monthly.dataVersion + 1);
      const changed = monthlyExplanation(changedPlan, monthly.dataVersion + 2);
      for (const pair of [stale, refreshed, changed]) {
        assertExplanationEnvelope(pair.outcome, pair.explanation);
        assert.deepEqual(evaluateMonthlyExplanation(pair.explanation), pair.outcome.value);
      }
      assert.ok(stale.explanation.stale);
      assert.equal('stale' in refreshed.explanation, false);
      assert.notDeepEqual(stale.explanation.period, refreshed.explanation.period);

      const monthlyPanel = {
        open: true,
        outcomeId: stale.outcome.id,
        outcome: stale.outcome,
        explanation: stale.explanation,
      };
      updateOpenPanel(monthlyPanel, refreshed);
      assert.equal(monthlyPanel.explanation.dataVersion, monthly.dataVersion + 1);
      assert.deepEqual(monthlyPanel.explanation.result.value, refreshed.outcome.value);
      const refreshedSourceRefs = structuredClone(monthlyPanel.explanation.sourceRefs);
      updateOpenPanel(monthlyPanel, changed);
      assert.equal(monthlyPanel.explanation.dataVersion, monthly.dataVersion + 2);
      assert.notDeepEqual(monthlyPanel.explanation.sourceRefs, refreshedSourceRefs);
      assert.notDeepEqual(monthlyPanel.explanation.result.value, refreshed.outcome.value);

      const initialTrip = buildTrip(trip, trip.amountMinor, trip.tripVersion);
      const updatedTrip = buildTrip(
        trip,
        trip.amountMinor + trip.amountIncreaseMinor,
        trip.tripVersion + 1
      );
      const tripInitial = tripExplanation(
        initialTrip,
        currentPlan.period,
        monthly.dataVersion + 3
      );
      const tripUpdated = tripExplanation(
        updatedTrip,
        currentPlan.period,
        monthly.dataVersion + 4
      );
      for (const pair of [tripInitial, tripUpdated]) {
        assertExplanationEnvelope(pair.outcome, pair.explanation);
        assert.deepEqual(evaluateTripExplanation(pair.explanation), pair.outcome.value);
      }

      const tripPanel = {
        open: true,
        outcomeId: tripInitial.outcome.id,
        outcome: tripInitial.outcome,
        explanation: tripInitial.explanation,
      };
      updateOpenPanel(tripPanel, tripUpdated);
      assert.equal(tripPanel.explanation.dataVersion, monthly.dataVersion + 4);
      assert.notDeepEqual(
        tripPanel.explanation.sourceRefs,
        tripInitial.explanation.sourceRefs
      );
      assert.notDeepEqual(tripPanel.explanation.result.value, tripInitial.outcome.value);
    }),
    { numRuns: NUM_RUNS }
  );
});

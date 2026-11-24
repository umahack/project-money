import '../helpers/blockingStdout.js';

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fc from 'fast-check';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createIsolatedTestDatabase } from '../helpers/testDatabase.js';
import { buildSessionFixture, buildUserFixture } from '../helpers/fixtures.js';
import {
  addDays,
  daysInMonth,
  kolkataDateOf,
  kolkataMidnightMs,
  parseIsoDate,
} from '../helpers/kolkataReference.js';
import { assertProperty } from '../helpers/propertyReport.js';
import { monthLedgerArb } from '../helpers/quickAddGenerators.js';

// Feature: quick-add-daily-answer, Property 17: Explanations reproduce Today_Allowance
// **Validates: Requirements 10.18, 10.19, 10.25**
//
// The evaluator below does not import the allowance calculator. It executes the
// explanation's ordered operations from their expense source references with
// independent BigInt half-up arithmetic, and independently partitions the
// generated ledger into counted, excluded-today, and other-day source groups.

const NUM_RUNS = 120;
const USER_ID = 761;
const SESSION_ID = 762;
const KOLKATA = 'Asia/Kolkata';
const FORCED_IDS = Object.freeze({ counted: 9_000_001, excludedToday: 9_000_002, other: 9_000_003 });
const EXPECTED_STEPS = Object.freeze([
  ['spendable_budget', 'sum'],
  ['expenses_used', 'sum'],
  ['remaining_spendable', 'subtract'],
  ['add_today_spent', 'sum'],
  ['divide_days', 'round_half_up'],
  ['floor_zero', 'maximum'],
  ['subtract_today_spent', 'subtract'],
  ['versus_guide', 'subtract'],
]);

let testDatabase;
let service;
let app;
let authorization;
let currentState;

function confirmedRecord(record = null) {
  return { status: 'confirmed', empty: record === null, record };
}

function confirmedCollection(records = []) {
  return { status: 'confirmed', empty: records.length === 0, records };
}

function money(amountMinor) {
  return { currency: 'INR', amountMinor };
}

function amountOf(value, label) {
  assert.equal(value?.currency, 'INR', `${label} must be INR money`);
  assert.equal(Number.isSafeInteger(value.amountMinor), true, `${label} must contain integer paise`);
  return value.amountMinor;
}

function nextMonth(month) {
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  const nextYear = monthNumber === 12 ? year + 1 : year;
  const nextMonthNumber = monthNumber === 12 ? 1 : monthNumber + 1;
  return `${String(nextYear).padStart(4, '0')}-${String(nextMonthNumber).padStart(2, '0')}`;
}

function expectedPeriod(localDate) {
  const month = localDate.slice(0, 7);
  const year = Number(localDate.slice(0, 4));
  const monthNumber = Number(localDate.slice(5, 7));
  const day = Number(localDate.slice(8, 10));
  return {
    month,
    timeZone: KOLKATA,
    start: `${month}-01`,
    endExclusive: `${nextMonth(month)}-01`,
    asOfDate: localDate,
    daysRemainingInclusive: daysInMonth(year, monthNumber) - day + 1,
  };
}

function effectiveDate(record) {
  if (record.spentOn !== null && record.spentOn !== undefined && record.spentOn !== '') {
    return typeof record.spentOn === 'string' && parseIsoDate(record.spentOn)
      ? record.spentOn
      : null;
  }
  const timestamp = Date.parse(record.createdAt);
  return Number.isFinite(timestamp) ? kolkataDateOf(timestamp) : null;
}

function isMarked(record) {
  return record.excludeFromDailyAllowance === true || record.excludeFromDailyAllowance === 1;
}

function partitionLedger(records, localDate) {
  const groups = { counted: [], excludedToday: [], other: [] };
  for (const record of [...records].sort((left, right) => left.id - right.id)) {
    if (effectiveDate(record) !== localDate) groups.other.push(record);
    else if (isMarked(record)) groups.excludedToday.push(record);
    else groups.counted.push(record);
  }
  return groups;
}

function sourceMap(explanation) {
  const sources = new Map(explanation.sourceRefs.map((source) => [source.ref, source]));
  assert.equal(sources.size, explanation.sourceRefs.length, 'source refs must be unique');
  return sources;
}

function sourceAmount(sources, ref) {
  const source = sources.get(ref);
  assert.equal(source?.sourceType, 'expense', `missing expense source ${ref}`);
  assert.equal(source.field, 'amountMinor');
  return amountOf(source.value, ref);
}

function signedHalfUp(dividend, divisor) {
  assert.equal(Number.isSafeInteger(dividend), true);
  assert.equal(Number.isSafeInteger(divisor), true);
  assert.ok(divisor > 0);
  const magnitude = BigInt(Math.abs(dividend));
  const denominator = BigInt(divisor);
  let quotient = magnitude / denominator;
  if ((magnitude % denominator) * 2n >= denominator) quotient += 1n;
  return Number(dividend < 0 ? -quotient : quotient);
}

function roundingFor(dividend, divisor) {
  return {
    precisionMinor: 1,
    direction: BigInt(dividend) % BigInt(divisor) === 0n ? 'exact' : 'half_up',
    adjustmentMinor: 0,
  };
}

function refsFor(records) {
  return records.map(({ id }) => `expense:${id}:amountMinor`);
}

function sumSourceAmounts(sources, refs) {
  return refs.reduce((total, ref) => total + sourceAmount(sources, ref), 0);
}

/** Execute and check every stored Today_Allowance operation independently. */
function evaluateExplanation(explanation, records) {
  const { period } = explanation;
  const sources = sourceMap(explanation);
  const groups = partitionLedger(records, period.asOfDate);
  const groupRefs = {
    counted: refsFor(groups.counted),
    excludedToday: refsFor(groups.excludedToday),
    other: refsFor(groups.other),
  };
  const allRefs = refsFor([...records].sort((left, right) => left.id - right.id));
  const todayRecords = [...groups.counted, ...groups.excludedToday]
    .sort((left, right) => left.id - right.id);

  assert.deepEqual(
    explanation.operations.map(({ order, stage, operation, explanationKey }) => ({
      order,
      stage,
      operation,
      explanationKey,
    })),
    EXPECTED_STEPS.map(([stage, operation], index) => ({
      order: index + 1,
      stage,
      operation,
      explanationKey: `today_allowance.${stage}`,
    }))
  );
  assert.deepEqual(
    explanation.sourceRefs.map(({ order }) => order),
    explanation.sourceRefs.map((_, index) => index + 1)
  );
  assert.equal(
    explanation.sourceRefs.every(({ classification }) => classification === 'entered_fact'),
    true
  );
  assert.equal(
    explanation.operations.every(({ resultClassification }) => resultClassification === 'calculated_result'),
    true
  );

  for (const record of records) {
    const amountRef = `expense:${record.id}:amountMinor`;
    const source = sources.get(amountRef);
    assert.ok(source, `missing amount source ${amountRef}`);
    assert.equal(source.recordId, record.id);
    assert.deepEqual(source.period, { month: period.month });
    assert.deepEqual(source.value, money(record.amountMinor));
  }

  const expectedMarkRefs = todayRecords.map(({ id }) => (
    `expense:${id}:excludeFromDailyAllowance`
  ));
  const actualMarkSources = explanation.sourceRefs.filter(
    ({ field }) => field === 'excludeFromDailyAllowance'
  );
  assert.deepEqual(actualMarkSources.map(({ ref }) => ref), expectedMarkRefs);
  for (const record of todayRecords) {
    const source = sources.get(`expense:${record.id}:excludeFromDailyAllowance`);
    assert.equal(source?.value, isMarked(record));
    assert.deepEqual(source?.period, { month: period.month });
  }

  const [spendable, used, remaining, basis, divide, floor, left, versus] = explanation.operations;
  assert.deepEqual(spendable.operandRefs, ['plan:spendable_budget']);
  const spendableMinor = amountOf(spendable.result, 'Spendable_Budget');

  assert.deepEqual(used.operandRefs, allRefs);
  assert.deepEqual(used.countedExpenseRefs, groupRefs.counted);
  assert.deepEqual(used.excludedTodayExpenseRefs, groupRefs.excludedToday);
  assert.deepEqual(used.otherExpenseRefs, groupRefs.other);
  assert.deepEqual(used.markRefs, expectedMarkRefs);
  const countedMinor = sumSourceAmounts(sources, groupRefs.counted);
  const excludedTodayMinor = sumSourceAmounts(sources, groupRefs.excludedToday);
  const otherMinor = sumSourceAmounts(sources, groupRefs.other);
  const expensesUsedMinor = countedMinor + excludedTodayMinor + otherMinor;
  assert.deepEqual(used.intermediateResults, {
    countedToday: money(countedMinor),
    excludedToday: money(excludedTodayMinor),
    otherDays: money(otherMinor),
  });
  assert.deepEqual(used.result, money(expensesUsedMinor));

  assert.deepEqual(remaining.operandRefs, ['result:spendable_budget', 'result:expenses_used']);
  const remainingSpendableMinor = spendableMinor - expensesUsedMinor;
  assert.deepEqual(remaining.result, money(remainingSpendableMinor));

  assert.deepEqual(basis.operandRefs, ['result:remaining_spendable', ...groupRefs.counted]);
  assert.deepEqual(basis.intermediateResults, { todaySpent: money(countedMinor) });
  const allowanceBasisMinor = remainingSpendableMinor + countedMinor;
  assert.deepEqual(basis.result, money(allowanceBasisMinor));

  assert.deepEqual(divide.operandRefs, [
    'result:add_today_spent',
    'period:days_remaining_inclusive',
  ]);
  assert.equal(divide.divisor, period.daysRemainingInclusive);
  const quotientMinor = signedHalfUp(allowanceBasisMinor, divide.divisor);
  assert.deepEqual(divide.result, money(quotientMinor));
  assert.deepEqual(divide.rounding, roundingFor(allowanceBasisMinor, divide.divisor));

  assert.deepEqual(floor.operandRefs, ['result:divide_days', 'constant:zero']);
  assert.deepEqual(floor.intermediateResults, { floor: money(0) });
  const todayAllowanceMinor = Math.max(0, quotientMinor);
  assert.deepEqual(floor.result, money(todayAllowanceMinor));

  assert.deepEqual(left.operandRefs, ['result:floor_zero', 'result:today_spent']);
  assert.deepEqual(left.intermediateResults, { todaySpent: money(countedMinor) });
  const leftTodayMinor = todayAllowanceMinor - countedMinor;
  assert.deepEqual(left.result, money(leftTodayMinor));

  assert.deepEqual(versus.operandRefs, ['result:floor_zero', 'result:daily_spending_guide']);
  assert.equal(versus.guideOutcomeId, `monthly-plan:${period.month}`);
  assert.equal(versus.guideExplanationKey, 'monthly_plan.daily_guide');
  const guideMinor = amountOf(
    versus.intermediateResults.dailySpendingGuide,
    'Daily_Spending_Guide'
  );
  const guideDifferenceMinor = todayAllowanceMinor - guideMinor;
  assert.deepEqual(versus.result, money(guideDifferenceMinor));
  assert.equal(
    versus.comparison,
    guideDifferenceMinor === 0 ? 'same' : (guideDifferenceMinor > 0 ? 'higher' : 'lower')
  );

  const topLevelRounding = allowanceBasisMinor > 0
    ? roundingFor(allowanceBasisMinor, divide.divisor)
    : { precisionMinor: 1, direction: 'exact', adjustmentMinor: 0 };
  assert.deepEqual(explanation.rounding, topLevelRounding);

  return {
    spendableMinor,
    expensesUsedMinor,
    remainingSpendableMinor,
    todaySpentMinor: countedMinor,
    allowanceBasisMinor,
    todayAllowanceMinor,
    leftTodayMinor,
    groupRefs,
  };
}

function assertEnvelope({ response, snapshot, expectedVersion, records }) {
  assert.equal(response.status, 200);
  assert.equal(response.body.schemaVersion, 1);
  const outcome = snapshot.outcomes.todayAllowance;
  const explanation = response.body.explanation;
  assert.equal(outcome.id, `today-allowance:${snapshot.period.month}`);
  assert.equal(outcome.kind, 'today_allowance');
  assert.equal(outcome.status, 'available');
  assert.equal(outcome.dataVersion, expectedVersion);
  assert.deepEqual(outcome.period, snapshot.period);
  assert.deepEqual(outcome.explanationRef, {
    outcomeId: outcome.id,
    dataVersion: expectedVersion,
  });
  assert.equal(explanation.schemaVersion, 1);
  assert.equal(explanation.outcomeId, outcome.id);
  assert.equal(explanation.kind, outcome.kind);
  assert.equal(explanation.dataVersion, expectedVersion);
  assert.deepEqual(explanation.period, snapshot.period);
  assert.deepEqual(explanation.result, {
    classification: 'calculated_result',
    value: outcome.value,
  });
  assert.deepEqual(explanation.precision, {
    currency: 'INR',
    minorUnit: 'paise',
    minorUnitsPerMajor: 100,
    fractionDigits: 2,
    precisionMinor: 1,
  });
  assert.equal(explanation.precisionMinor, 1);

  const replayed = evaluateExplanation(explanation, records);
  assert.equal(replayed.spendableMinor, snapshot.outcomes.monthlyPlan.value.spendableBudget.amountMinor);
  assert.equal(replayed.todaySpentMinor, outcome.value.todaySpent.amountMinor);
  assert.equal(replayed.allowanceBasisMinor, outcome.value.allowanceBasis.amountMinor);
  assert.equal(replayed.todayAllowanceMinor, outcome.value.todayAllowance.amountMinor);
  assert.equal(replayed.leftTodayMinor, outcome.value.leftToday.amountMinor);
  assert.deepEqual(outcome.value.excludedToday, {
    count: replayed.groupRefs.excludedToday.length,
    total: money(sumSourceAmounts(sourceMap(explanation), replayed.groupRefs.excludedToday)),
  });
  return replayed;
}

function otherDate(localDate) {
  return localDate.endsWith('-01') ? addDays(localDate, 1) : addDays(localDate, -1);
}

function buildCase({ ledger, dataVersion, versionIncrement, groupAmounts, updateUnits, budgetMode }) {
  const { localDate } = ledger;
  const month = localDate.slice(0, 7);
  const now = new Date(kolkataMidnightMs(localDate) + 12 * 60 * 60 * 1000);
  const timestamp = now.toISOString();
  const baseExpenses = ledger.expenses.map((record) => ({
    ...record,
    userId: USER_ID,
    month,
    category: 'Food',
    updatedAt: timestamp,
    normalizationIssues: [],
  }));
  const forcedExpenses = [
    {
      id: FORCED_IDS.counted,
      userId: USER_ID,
      month,
      category: 'Food',
      amountMinor: groupAmounts[0],
      spentOn: localDate,
      createdAt: timestamp,
      updatedAt: timestamp,
      excludeFromDailyAllowance: false,
      normalizationIssues: [],
    },
    {
      id: FORCED_IDS.excludedToday,
      userId: USER_ID,
      month,
      category: 'Food',
      amountMinor: groupAmounts[1],
      spentOn: localDate,
      createdAt: timestamp,
      updatedAt: timestamp,
      excludeFromDailyAllowance: true,
      normalizationIssues: [],
    },
    {
      id: FORCED_IDS.other,
      userId: USER_ID,
      month,
      category: 'Food',
      amountMinor: groupAmounts[2],
      spentOn: otherDate(localDate),
      createdAt: timestamp,
      updatedAt: timestamp,
      excludeFromDailyAllowance: false,
      normalizationIssues: [],
    },
  ];
  const expenses = [...baseExpenses, ...forcedExpenses];
  const expenseTotal = expenses.reduce((total, record) => total + record.amountMinor, 0);
  const salaryMinor = budgetMode === 'overspent'
    ? 0
    : expenseTotal + 100_000_000 + (ledger.plan.spendableBudgetMinor % 100_000_000);
  const salary = {
    id: 8_000_001,
    userId: USER_ID,
    month,
    amountMinor: salaryMinor,
    createdAt: timestamp,
    updatedAt: timestamp,
    normalizationIssues: [],
  };
  const period = {
    status: 'confirmed',
    month,
    salary: confirmedRecord(salary),
    bills: confirmedCollection(),
    expenses: confirmedCollection(expenses),
    categoryTreatments: confirmedCollection(),
  };
  const days = expectedPeriod(localDate).daysRemainingInclusive;
  const expenseIncreaseMinor = days * updateUnits;
  const updatedExpenses = expenses.map((record) => (
    record.id === FORCED_IDS.other
      ? { ...record, amountMinor: record.amountMinor + expenseIncreaseMinor }
      : record
  ));
  const updatedVersion = dataVersion + versionIncrement;

  return {
    initial: { now, month, dataVersion, period },
    updated: {
      now,
      month,
      dataVersion: updatedVersion,
      period: { ...period, expenses: confirmedCollection(updatedExpenses) },
    },
    expenses,
    updatedExpenses,
    updatedVersion,
    expenseIncreaseMinor,
    updateUnits,
    budgetMode,
  };
}

const scenarioArb = fc.record({
  ledger: monthLedgerArb({ marks: 'mixed', maxExpenses: 10, maxAmountMinor: 1_000_000 }),
  dataVersion: fc.integer({ min: 0, max: 1_000_000 }),
  versionIncrement: fc.integer({ min: 1, max: 20 }),
  groupAmounts: fc.tuple(
    fc.integer({ min: 1_000, max: 1_000_000 }),
    fc.integer({ min: 1_000, max: 1_000_000 }),
    fc.integer({ min: 1_000, max: 1_000_000 })
  ),
  updateUnits: fc.integer({ min: 1, max: 10_000 }),
  budgetMode: fc.constantFrom('positive', 'positive', 'overspent'),
});

function repositoryForCurrentState() {
  return {
    async getDataVersion(userId) {
      assert.equal(userId, USER_ID);
      return currentState.dataVersion;
    },
    async loadPeriod({ userId, month }) {
      assert.equal(userId, USER_ID);
      assert.equal(month, currentState.month);
      return structuredClone(currentState.period);
    },
    async loadGoals(userId) {
      assert.equal(userId, USER_ID);
      return confirmedCollection();
    },
    async listAccessibleTrips(userId) {
      assert.equal(userId, USER_ID);
      return confirmedCollection();
    },
    async loadAccessibleTripLedger() {
      throw new Error('No trip ledger should be loaded for an empty trip collection.');
    },
  };
}

async function insertAuthenticationFixtures(db) {
  const user = buildUserFixture({ id: USER_ID, email: 'qa76-property@example.test' });
  const session = buildSessionFixture({
    id: SESSION_ID,
    userId: USER_ID,
    ip_hash: 'qa76-property-session',
  });
  await db.prepare(
    `INSERT INTO users
      (id, email, name, password_hash, is_admin, token_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    user.id,
    user.email,
    user.name,
    user.password_hash,
    user.is_admin,
    user.token_version,
    user.created_at
  );
  await db.prepare(
    `INSERT INTO sessions
      (id, user_id, device_label, ip_hash, user_agent, created_at, last_seen_at,
       revoked_at, revoked_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    session.id,
    session.user_id,
    session.device_label,
    session.ip_hash,
    session.user_agent,
    session.created_at,
    session.last_seen_at,
    session.revoked_at,
    session.revoked_reason
  );
}

before(async () => {
  testDatabase = await createIsolatedTestDatabase();
  await insertAuthenticationFixtures(testDatabase.db);
  const { ClarityService } = await import('../../src/services/clarityService.js');
  const { createClarityRouter } = await import('../../src/routes/clarity.js');
  service = new ClarityService({ repository: repositoryForCurrentState() });
  app = express();
  app.use(express.json());
  app.use('/api/finance', createClarityRouter({
    service,
    clock: () => currentState.now,
  }));
  authorization = `Bearer ${jwt.sign(
    { sub: String(USER_ID), tv: 1, sid: SESSION_ID },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' }
  )}`;
});

after(async () => {
  await testDatabase?.cleanup();
});

test('Property 17: GET explanations reproduce the ClarityService Today_Allowance outcome', async () => {
  const coverage = { positive: 0, floored: 0, counted: 0, excludedToday: 0, other: 0 };

  await assertProperty(fc.asyncProperty(scenarioArb, async (generated) => {
    const scenario = buildCase(generated);
    currentState = scenario.initial;
    const initialSnapshot = await service.getSnapshot({
      userId: USER_ID,
      month: currentState.month,
      now: currentState.now,
    });
    assert.equal(initialSnapshot.dataVersion, currentState.dataVersion);
    assert.deepEqual(initialSnapshot.period, expectedPeriod(generated.ledger.localDate));

    const initialResponse = await request(app)
      .get(`/api/finance/explanations/today-allowance:${currentState.month}`)
      .query({ version: currentState.dataVersion })
      .set('Authorization', authorization);
    assert.equal(initialResponse.body.supersededByVersion, undefined);
    const initial = assertEnvelope({
      response: initialResponse,
      snapshot: initialSnapshot,
      expectedVersion: currentState.dataVersion,
      records: scenario.expenses,
    });

    assert.ok(initial.groupRefs.counted.length > 0);
    assert.ok(initial.groupRefs.excludedToday.length > 0);
    assert.ok(initial.groupRefs.other.length > 0);
    coverage.counted += 1;
    coverage.excludedToday += 1;
    coverage.other += 1;
    if (initial.todayAllowanceMinor > 0) coverage.positive += 1;
    else coverage.floored += 1;

    currentState = scenario.updated;
    const updatedSnapshot = await service.getSnapshot({
      userId: USER_ID,
      month: currentState.month,
      now: currentState.now,
    });
    const updatedResponse = await request(app)
      .get(`/api/finance/explanations/today-allowance:${currentState.month}`)
      .query({ version: scenario.initial.dataVersion })
      .set('Authorization', authorization);
    assert.equal(updatedResponse.body.supersededByVersion, scenario.updatedVersion);
    const updated = assertEnvelope({
      response: updatedResponse,
      snapshot: updatedSnapshot,
      expectedVersion: scenario.updatedVersion,
      records: scenario.updatedExpenses,
    });

    assert.equal(updated.allowanceBasisMinor, initial.allowanceBasisMinor - scenario.expenseIncreaseMinor);
    assert.equal(updated.todaySpentMinor, initial.todaySpentMinor);
    assert.equal(updated.expensesUsedMinor, initial.expensesUsedMinor + scenario.expenseIncreaseMinor);
    assert.equal(
      sourceMap(updatedResponse.body.explanation)
        .get(`expense:${FORCED_IDS.other}:amountMinor`).value.amountMinor,
      sourceMap(initialResponse.body.explanation)
        .get(`expense:${FORCED_IDS.other}:amountMinor`).value.amountMinor + scenario.expenseIncreaseMinor
    );
    if (scenario.budgetMode === 'positive') {
      assert.equal(updated.todayAllowanceMinor, initial.todayAllowanceMinor - scenario.updateUnits);
      assert.equal(updated.leftTodayMinor, initial.leftTodayMinor - scenario.updateUnits);
    } else {
      assert.equal(initial.todayAllowanceMinor, 0);
      assert.equal(updated.todayAllowanceMinor, 0);
      assert.equal(updated.leftTodayMinor, initial.leftTodayMinor);
    }
  }), { numRuns: NUM_RUNS });

  assert.equal(coverage.counted, NUM_RUNS);
  assert.equal(coverage.excludedToday, NUM_RUNS);
  assert.equal(coverage.other, NUM_RUNS);
  assert.ok(coverage.positive > 0, 'positive allowance explanations were generated');
  assert.ok(coverage.floored > 0, 'zero-floor allowance explanations were generated');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readBooleanFeatureFlag,
  readServerFeatureFlags,
} from '../../src/rollout/featureFlags.js';
import {
  negotiateClarityContract,
  requestsClarityContract,
} from '../../src/rollout/contractNegotiation.js';
import {
  logShadowMismatchCodes,
  planMismatchCodes,
} from '../../src/rollout/shadowComparison.js';

function requestWithHeader(value) {
  return {
    get(name) {
      return name.toLowerCase() === 'x-clarity-contract' ? value : undefined;
    },
  };
}

function money(amountMinor) {
  return { amountMinor };
}

function canonicalPlan(overrides = {}) {
  const values = {
    salary: money(100_000),
    activeBillsTotal: money(20_000),
    disposableIncome: money(80_000),
    needsBudget: money(40_000),
    wantsBudget: money(24_000),
    savingsTarget: money(16_000),
    ...overrides,
  };
  return {
    outcomes: {
      monthlyPlan: { status: 'available', value: values },
      spending: {
        status: 'available',
        value: {
          totalSpending: money(12_500),
          categoryTotals: [
            { category: 'Food', total: money(7_500) },
            { category: 'Travel', total: money(5_000) },
          ],
        },
      },
    },
  };
}

const legacyPlan = Object.freeze({
  income: 1000,
  emiTotal: 200,
  afterFixed: 800,
  breakdown: { needs: 400, wants: 240, save: 160 },
  spentThisMonth: 125,
  byCategory: { Travel: 50, Food: 75 },
  month: '2026-01',
  tips: [],
});

test('server rollout flags remain disabled for absent or unsupported values', () => {
  assert.equal(readBooleanFeatureFlag(undefined), false);
  assert.equal(readBooleanFeatureFlag(''), false);
  assert.equal(readBooleanFeatureFlag('yes'), false);
  assert.deepEqual(readServerFeatureFlags({}), {
    clarityShadowCompare: false,
    quickAddEnabled: false,
  });
  assert.deepEqual(readServerFeatureFlags({
    CLARITY_SHADOW_COMPARE: 'false',
    QUICK_ADD_ENABLED: 'yes',
  }), {
    clarityShadowCompare: false,
    quickAddEnabled: false,
  });
});

test('server rollout flag accepts only explicit true values', () => {
  assert.equal(readBooleanFeatureFlag('1'), true);
  assert.equal(readBooleanFeatureFlag(' true '), true);
  assert.deepEqual(readServerFeatureFlags({
    CLARITY_SHADOW_COMPARE: 'TRUE',
    QUICK_ADD_ENABLED: '1',
  }), {
    clarityShadowCompare: true,
    quickAddEnabled: true,
  });
});

test('QUICK_ADD_ENABLED accepts only the approved fail-closed true forms', () => {
  for (const value of ['1', 'true', 'TRUE', ' TrUe ', ' 1 ']) {
    assert.equal(
      readServerFeatureFlags({ QUICK_ADD_ENABLED: value }).quickAddEnabled,
      true,
      `${JSON.stringify(value)} should enable Quick Add`
    );
  }

  for (const value of [undefined, '', '0', 'false', 'yes', 'on', '1.0', 'true1', 1, true]) {
    assert.equal(
      readServerFeatureFlags({ QUICK_ADD_ENABLED: value }).quickAddEnabled,
      false,
      `${JSON.stringify(value)} should fail closed`
    );
  }
});

test('legacy response stays exact without contract version 1', () => {
  const contract = {
    schemaVersion: 1,
    mutation: { status: 'confirmed' },
    clarity: { dataVersion: 7 },
  };
  const absent = negotiateClarityContract(requestWithHeader(undefined), legacyPlan, contract);
  const unsupported = negotiateClarityContract(requestWithHeader('2'), legacyPlan, contract);

  assert.strictEqual(absent, legacyPlan);
  assert.strictEqual(unsupported, legacyPlan);
  assert.deepEqual(Object.keys(absent).sort(), Object.keys(legacyPlan).sort());
});

test('contract version 1 adds clarity and mutation without changing legacy fields', () => {
  const contract = {
    schemaVersion: 1,
    mutation: { changeId: 91, status: 'confirmed' },
    clarity: { dataVersion: 7 },
  };
  const response = negotiateClarityContract(requestWithHeader('1'), legacyPlan, contract);

  assert.equal(requestsClarityContract(requestWithHeader('1')), true);
  for (const [key, value] of Object.entries(legacyPlan)) {
    assert.deepEqual(response[key], value);
  }
  assert.deepEqual(response.mutation, contract.mutation);
  assert.deepEqual(response.clarity, contract.clarity);
  assert.equal(response.schemaVersion, 1);
});

test('plan shadow comparison returns stable mismatch codes without values', () => {
  assert.deepEqual(planMismatchCodes(canonicalPlan(), legacyPlan), []);
  assert.deepEqual(
    planMismatchCodes(canonicalPlan({ needsBudget: money(39_999) }), legacyPlan),
    ['PLAN_NEEDS_BUDGET_MISMATCH']
  );
});

test('shadow logger emits mismatch codes only', () => {
  const logs = [];
  logShadowMismatchCodes(
    ['PLAN_NEEDS_BUDGET_MISMATCH', 'PLAN_CATEGORY_TOTALS_MISMATCH'],
    (message) => logs.push(message)
  );

  assert.deepEqual(logs, [
    '[clarity-shadow] code=PLAN_NEEDS_BUDGET_MISMATCH',
    '[clarity-shadow] code=PLAN_CATEGORY_TOTALS_MISMATCH',
  ]);
  assert.ok(logs.every((message) => /^\[clarity-shadow\] code=[A-Z0-9_]+$/.test(message)));
  assert.throws(
    () => logShadowMismatchCodes(['amount=75000'], () => {}),
    /Mismatch codes/
  );
});

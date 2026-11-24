import { describe, expect, it } from 'vitest';
import type {
  FinancialSnapshot,
  MoneyValue,
  MonthlyPlanValue,
  MutationEnvelope,
  Outcome,
  OutcomeStatus,
  SpendingOutcomeValue,
  TodayAllowanceOutcome,
  TodayAllowanceValue,
} from '../contracts';
import { fc } from '../../test/test-utils';
import { assertProperty } from '../../test/propertyReport';
import { buildEntryAnswer, EXPENSE_DELETE_OPERATION, type AnswerEntryInput, type EntryAnswerModel } from './answer';

/*
 * Feature: quick-add-daily-answer, Property 22: Entry_Answer uses only server values
 *
 * Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5, 9.8, 9.9, 9.10, 9.11
 *
 * Statement (design.md): for any confirmed mutation response, every money amount in the answer model is a reference to
 * an integer-paise value that the response snapshot or record contains; the "over" text comes from the server's
 * `overToday` or `excessMinor` fields; the bucket is the treatment the server applied; an entry in another month names
 * that month and shows no Today value; and a missing, invalid, or failed outcome gives the matching
 * saved-but-unavailable message without a money value being invented.
 *
 * Sentinel generation: every money value in a generated response is drawn without repeats from a pool of large
 * integers. A case is skipped when any sum, difference, product, or exact quotient of two different response values is
 * itself a response value. In an accepted case a model amount that is present in the response cannot be the result of
 * arithmetic, and a model amount that is absent is an invented value. Money objects are also checked by identity.
 */

const TODAYS = ['2025-03-14', '2024-12-31', '2026-01-01'] as const;
const OTHER_MONTHS = ['2019-02', '2035-09'] as const;
const STATES = ['available', 'missing_input', 'invalid_input', 'calculation_failed', 'stale', 'refresh_failed'] as const;
const TODAY_KINDS = [
  'absent',
  'values',
  'other_date',
  'not_applicable',
  'missing_input',
  'invalid_input',
  'calculation_failed',
  'stale',
  'refresh_failed',
] as const;
const BROKEN_KEYS = [
  'todaySpent',
  'todayAllowance',
  'leftToday',
  'overToday',
  'usedBeyondBudget',
  'remainingSpendable',
  'needsSpent',
  'wantsSpent',
  'needsBudget',
  'wantsBudget',
  'recordAmount',
] as const;
type BrokenKey = (typeof BROKEN_KEYS)[number];
type TodayKind = (typeof TODAY_KINDS)[number];
/** Values that are not safe integers: a line that needs one must be dropped. */
const NOT_SAFE: readonly number[] = [1.5, Number.NaN, 2 ** 60, Number.POSITIVE_INFINITY];
const EXPENSE_ID = 41;
const POOL_SIZE = 140;

interface Scenario {
  pool: number[];
  today: (typeof TODAYS)[number];
  current: boolean;
  otherMonth: (typeof OTHER_MONTHS)[number];
  operation: 'expense.create' | 'expense.update' | 'expense.delete';
  mark: 'confirmed' | 'unconfirmed' | 'omitted';
  exclusionRequested: boolean;
  warning: 'none' | 'large' | 'bill' | 'both' | 'absent';
  dateKind: 'today' | 'past' | 'future';
  planState: (typeof STATES)[number];
  spendingState: (typeof STATES)[number];
  todayKind: TodayKind;
  missingInput: 'salary' | 'bills';
  staleValue: boolean;
  overKind: 'none' | 'over' | 'leftNegativeOnly';
  zeroReason: 'none' | 'month_budget_used' | 'no_spendable_budget';
  negativeRemaining: boolean;
  treatment: 'needs' | 'wants' | 'none';
  source: 'default' | 'override';
  exceeded: Array<{ bucket: 'needs' | 'wants' | 'savings'; valid: boolean }>;
  broken: BrokenKey[];
}

/** The usual value with the given weight, and the other values together with weight 1 per value. */
const mostly = <T>(usual: T, others: readonly T[], weight = 6): fc.Arbitrary<T> =>
  fc.oneof({ arbitrary: fc.constant(usual), weight }, { arbitrary: fc.constantFrom(...others), weight: others.length });

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  pool: fc.uniqueArray(fc.integer({ min: 1_000_000_000, max: 8_000_000_000_000 }), {
    minLength: POOL_SIZE,
    maxLength: POOL_SIZE,
  }),
  today: fc.constantFrom(...TODAYS),
  current: fc.oneof({ arbitrary: fc.constant(true), weight: 3 }, { arbitrary: fc.constant(false), weight: 1 }),
  otherMonth: fc.constantFrom(...OTHER_MONTHS),
  operation: mostly<Scenario['operation']>('expense.create', ['expense.update', 'expense.delete'], 3),
  mark: fc.constantFrom('confirmed', 'unconfirmed', 'omitted') as fc.Arbitrary<Scenario['mark']>,
  exclusionRequested: fc.boolean(),
  warning: fc.constantFrom('none', 'large', 'bill', 'both', 'absent') as fc.Arbitrary<Scenario['warning']>,
  dateKind: fc.constantFrom('today', 'past', 'future') as fc.Arbitrary<Scenario['dateKind']>,
  planState: mostly<Scenario['planState']>('available', STATES.slice(1), 10),
  spendingState: mostly<Scenario['spendingState']>('available', STATES.slice(1), 10),
  todayKind: mostly<TodayKind>('values', TODAY_KINDS.filter((kind) => kind !== 'values'), 12),
  missingInput: fc.constantFrom('salary', 'bills') as fc.Arbitrary<Scenario['missingInput']>,
  staleValue: fc.boolean(),
  overKind: mostly<Scenario['overKind']>('none', ['over', 'over', 'leftNegativeOnly'], 3),
  zeroReason: fc.constantFrom('none', 'month_budget_used', 'no_spendable_budget') as fc.Arbitrary<Scenario['zeroReason']>,
  negativeRemaining: fc.boolean(),
  treatment: mostly<Scenario['treatment']>('needs', ['wants', 'none'], 1),
  source: fc.constantFrom('default', 'override') as fc.Arbitrary<Scenario['source']>,
  exceeded: fc.array(
    fc.record({
      bucket: fc.constantFrom('needs', 'wants', 'savings') as fc.Arbitrary<'needs' | 'wants' | 'savings'>,
      valid: fc.boolean(),
    }),
    { minLength: 0, maxLength: 3 },
  ),
  // Mostly well-formed responses, with some broken money fields.
  broken: fc.oneof(
    { arbitrary: fc.constant([] as BrokenKey[]), weight: 4 },
    { arbitrary: fc.subarray([...BROKEN_KEYS], { minLength: 1, maxLength: 3 }), weight: 1 },
  ),
});

/* --------------------------------------------------------------- builder */

type ApplicableToday = Extract<TodayAllowanceValue, { applicable: true }>;

interface Built {
  envelope: MutationEnvelope;
  entry: AnswerEntryInput;
  today: string;
  month: string;
  isCurrent: boolean;
  removed: boolean;
  record: Record<string, unknown> | null;
  plan: Outcome<MonthlyPlanValue>;
  spending: Outcome<SpendingOutcomeValue>;
  todayOutcome: TodayAllowanceOutcome | null;
  /** Money objects the answer may reference by identity, decided from the scenario and not from the builder. */
  allowedObjects: Set<MoneyValue>;
  /** Integers the answer may wrap: the confirmed record amount and the server excess values. */
  wrapAllowed: Set<number>;
  responseInts: number[];
}

const valid = (money: unknown): money is MoneyValue =>
  typeof money === 'object' && money !== null && Number.isSafeInteger((money as MoneyValue).amountMinor);

function collectMoneyObjects(value: unknown, into: Set<MoneyValue>): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectMoneyObjects(item, into));
  } else if (typeof value === 'object' && value !== null) {
    if ('amountMinor' in value) into.add(value as MoneyValue);
    Object.values(value).forEach((item) => collectMoneyObjects(item, into));
  }
}

function collectResponseInts(value: unknown, into: number[]): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectResponseInts(item, into));
  } else if (typeof value === 'object' && value !== null) {
    for (const [name, item] of Object.entries(value)) {
      // `precisionMinor` is the snapshot's rounding unit, not money.
      if (typeof item === 'number' && /^(amount|budget|spent|excess)Minor$/.test(name)) {
        if (Number.isSafeInteger(item)) into.push(item);
      } else collectResponseInts(item, into);
    }
  }
}

function build(s: Scenario): Built {
  let cursor = 0;
  const next = (negative = false): number => {
    const value = s.pool[cursor];
    cursor += 1;
    if (value === undefined) throw new Error('value pool exhausted');
    return negative ? -value : value;
  };
  const money = (negative = false): MoneyValue => ({ currency: 'INR', amountMinor: next(negative) });
  /** Always consumes a pool value, so the layout of values does not depend on which fields are broken. */
  const field = (key: BrokenKey, negative = false): MoneyValue => {
    const base = next(negative);
    return {
      currency: 'INR',
      amountMinor: s.broken.includes(key) ? (NOT_SAFE[Math.abs(base) % NOT_SAFE.length] as number) : base,
    };
  };

  const currentMonth = s.today.slice(0, 7);
  const month = s.current ? currentMonth : s.otherMonth;
  const isCurrent = month === currentMonth;
  const removed = s.operation === EXPENSE_DELETE_OPERATION;
  const period = { month, start: `${month}-01`, endExclusive: `${month}-31`, timeZone: 'Asia/Kolkata' as const };
  const spentOn = s.dateKind === 'today' ? (isCurrent ? s.today : `${month}-15`) : s.dateKind === 'past' ? `${month}-01` : `${month}-28`;

  const plan: MonthlyPlanValue = {
    salary: money(),
    activeBillsTotal: money(),
    shortfall: money(),
    disposableIncome: money(),
    needsBudget: money(),
    wantsBudget: money(),
    savingsTarget: money(),
    spendableBudget: money(),
    needsSpent: money(),
    wantsSpent: money(),
    remainingSpendable: field('remainingSpendable', s.negativeRemaining),
    dailySpendingGuide: money(),
    projectedSavings: money(),
  };

  const exceededBudgetActions = s.exceeded.map((item) => ({
    conditionCode: `${item.bucket}_budget_exceeded`,
    bucket: item.bucket,
    budgetMinor: next(),
    spentMinor: next(),
    excessMinor: item.valid ? next() : NOT_SAFE[next() % NOT_SAFE.length]!,
    actionKey: 'review',
    actionLabel: 'Review',
    correctiveAction: 'x',
  }));
  const decoy = { expenseId: 99, category: 'Other', treatment: s.treatment === 'needs' ? 'wants' : 'needs', source: 'default' };
  const spendingValue = {
    month,
    categoryTotals: [],
    appliedTreatments: [
      decoy,
      ...(s.treatment === 'none' ? [] : [{ expenseId: EXPENSE_ID, category: 'Food', treatment: s.treatment, source: s.source }]),
    ],
    needsBudget: field('needsBudget'),
    wantsBudget: field('wantsBudget'),
    needsSpent: field('needsSpent'),
    wantsSpent: field('wantsSpent'),
    totalSpending: money(),
    spendableBudget: money(),
    remainingSpendable: money(s.negativeRemaining),
    dailySpendingGuide: money(),
    savingsTarget: money(),
    projectedSavings: money(),
    projectedSavingsDifference: money(),
    exceededBudgetActions,
  } as unknown as SpendingOutcomeValue;

  const overBase = money();
  const todayApplicable: ApplicableToday = {
    applicable: true,
    date: s.todayKind === 'other_date' ? '2000-01-01' : s.today,
    daysRemainingInclusive: 18,
    todayAllowance: field('todayAllowance'),
    todaySpent: field('todaySpent'),
    leftToday: field('leftToday', s.overKind !== 'none'),
    overToday: s.broken.includes('overToday')
      ? { currency: 'INR', amountMinor: NOT_SAFE[overBase.amountMinor % NOT_SAFE.length] as number }
      : s.overKind === 'over' ? overBase : { currency: 'INR', amountMinor: 0 },
    allowanceBasis: money(),
    usedPermille: 150,
    zeroReason: s.zeroReason === 'none' ? null : s.zeroReason,
    usedBeyondBudget: field('usedBeyondBudget'),
    excludedToday: { count: 1, total: money() },
    largeEntryThreshold: money(),
  };
  const todayValue: TodayAllowanceValue = s.todayKind === 'not_applicable'
    ? { applicable: false, reason: 'not_current_month' }
    : todayApplicable;

  const retryFor = (id: string) => ({ action: 'recalculate' as const, scopeKey: `outcome:${id}` });
  const shape = <T>(id: string, kind: string, status: OutcomeStatus, value: T): Outcome<T> => {
    const carriesValue = status === 'available' || s.staleValue;
    return {
      id,
      kind,
      status,
      classification: 'calculated_result',
      period,
      dataVersion: 7,
      ...(carriesValue ? { value } : {}),
      ...(status === 'missing_input' ? { missing: [{ input: s.missingInput, unlocks: ['monthly_plan'] }] } : {}),
      ...(status === 'invalid_input'
        ? { invalid: [{ input: 'bill:3.amountMinor', constraint: 'positive safe integer', affects: ['monthly_plan'] }] }
        : {}),
      ...(status === 'calculation_failed' || status === 'stale' || status === 'refresh_failed' ? { retry: retryFor(id) } : {}),
      sourceRefs: [],
    } as unknown as Outcome<T>;
  };

  const planOutcome = shape(`monthly-plan:${month}`, 'monthly_plan', s.planState, plan);
  const spendingOutcome = shape(`spending:${month}`, 'spending', s.spendingState, spendingValue);
  let todayOutcome: TodayAllowanceOutcome | null = null;
  if (s.todayKind !== 'absent') {
    const status: OutcomeStatus = ['values', 'other_date', 'not_applicable'].includes(s.todayKind)
      ? 'available'
      : (s.todayKind as OutcomeStatus);
    todayOutcome = shape(`today-allowance:${month}`, 'today_allowance', status, todayValue) as unknown as TodayAllowanceOutcome;
  }

  const record: Record<string, unknown> | null = removed
    ? null
    : {
        id: EXPENSE_ID,
        month,
        category: 'Food',
        amountMinor: field('recordAmount').amountMinor,
        note: 'swiggy',
        spentOn,
        ...(s.mark === 'omitted' ? {} : { excludeFromDailyAllowance: s.mark === 'confirmed' }),
      };

  const outcomes = {
    monthlyPlan: planOutcome,
    spending: spendingOutcome,
    goals: [],
    tripSummary: shape('trip-summary', 'trip_summary', 'available', []),
    ...(todayOutcome === null ? {} : { todayAllowance: todayOutcome }),
  } as unknown as FinancialSnapshot['outcomes'];

  const envelope = {
    schemaVersion: 1,
    mutation: {
      changeId: 5,
      idempotencyKey: 'k',
      scopeKey: `expense:${EXPENSE_ID}`,
      operation: s.operation,
      recordType: 'expense',
      recordId: EXPENSE_ID,
      status: 'confirmed',
      recordVersion: 1,
      record,
    },
    clarity: {
      dataVersion: 12,
      currency: 'INR',
      precisionMinor: 1,
      period: { ...period, asOfDate: s.today, daysRemainingInclusive: 18 },
      facts: [],
      outcomes,
      actions: [],
    },
  } as unknown as MutationEnvelope;

  const entry: AnswerEntryInput = {
    category: 'Food',
    spentOn,
    note: 'swiggy',
    exclusionRequested: s.exclusionRequested,
    ...(s.warning === 'absent'
      ? {}
      : {
          warning: s.warning === 'none'
            ? { kind: 'none' as const }
            : { kind: 'warn' as const, large: s.warning === 'large' || s.warning === 'both', ...(s.warning === 'bill' || s.warning === 'both' ? { bill: 'Rent' } : {}) },
        }),
  };

  // What the answer may reference, decided from the scenario.
  const allowedObjects = new Set<MoneyValue>();
  const wrapAllowed = new Set<number>();
  if (planOutcome.status === 'available') collectMoneyObjects(plan, allowedObjects);
  if (spendingOutcome.status === 'available') {
    collectMoneyObjects(spendingValue, allowedObjects);
    for (const action of exceededBudgetActions) {
      if (Number.isSafeInteger(action.excessMinor)) wrapAllowed.add(action.excessMinor);
    }
  }
  if (!removed && Number.isSafeInteger(record?.amountMinor)) wrapAllowed.add(record!.amountMinor as number);
  if (isCurrent && todayOutcome?.status === 'available' && todayValue.applicable && todayValue.date === s.today) {
    collectMoneyObjects(todayValue, allowedObjects);
  }

  const responseInts: number[] = [];
  collectResponseInts(envelope, responseInts);

  return {
    envelope,
    entry,
    today: s.today,
    month,
    isCurrent,
    removed,
    record,
    plan: planOutcome,
    spending: spendingOutcome,
    todayOutcome,
    allowedObjects,
    wrapAllowed,
    responseInts,
  };
}

/** Skips the case when arithmetic on two different response values lands on a response value. */
function requireSentinelValues(ints: readonly number[]): void {
  const present = new Set(ints);
  const operands = [...present].filter((value) => value !== 0);
  for (let i = 0; i < operands.length; i += 1) {
    for (let j = i + 1; j < operands.length; j += 1) {
      const a = operands[i] as number;
      const b = operands[j] as number;
      const derived = [a + b, a - b, b - a, a * b];
      if (a % b === 0) derived.push(a / b);
      if (b % a === 0) derived.push(b / a);
      for (const value of derived) {
        if (Number.isSafeInteger(value) && present.has(value)) fc.pre(false);
      }
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

/* ----------------------------------------------------------------- checks */

function modelMoney(answer: EntryAnswerModel): MoneyValue[] {
  const found: MoneyValue[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (typeof value === 'object' && value !== null) {
      if ('amountMinor' in value) found.push(value as MoneyValue);
      Object.values(value).forEach(walk);
    }
  };
  walk(answer);
  return found;
}

const TODAY_VALUE_KEYS = new Set([
  'answer.today.spent',
  'answer.today.left',
  'answer.today.over',
  'answer.today.zeroAllowance',
  'answer.today.excluded.allowanceAfter',
]);

function check(s: Scenario, built: Built, answer: EntryAnswerModel): void {
  const { lines } = answer;
  const keyed = (key: string) => lines.filter((line) => line.key === key);
  const present = new Set(built.responseInts);

  // 1. Every money in the model is a response object by identity, or a server integer wrapped unchanged.
  const found = modelMoney(answer);
  for (const money of found) {
    expect(Number.isSafeInteger(money.amountMinor)).toBe(true);
    if (built.allowedObjects.has(money)) {
      expect(present.has(money.amountMinor)).toBe(true);
    } else {
      expect(money.currency).toBe('INR');
      expect(built.wrapAllowed.has(money.amountMinor)).toBe(true);
      expect(present.has(money.amountMinor)).toBe(true);
    }
  }

  // 2. Undo is the delete operation, and nothing about a saved entry is claimed after it.
  expect(answer.mode).toBe(built.removed ? 'removed' : 'saved');
  expect(answer.titleKey).toBe(built.removed ? 'answer.removed' : 'answer.saved');
  expect(keyed('answer.removed')).toHaveLength(built.removed ? 1 : 0);
  expect(keyed('answer.saved')).toHaveLength(built.removed ? 0 : 1);
  if (built.removed) {
    expect(answer.saved).toBeNull();
    expect(answer.bucket).toBeNull();
    expect(answer.actions.filter((action) => action.key === 'exclude_from_today')).toEqual([]);
  }

  // 3. The saved amount is the confirmed record integer unchanged, or absent when it is not a safe integer.
  if (!built.removed) {
    const amount = built.record?.amountMinor;
    if (Number.isSafeInteger(amount)) {
      expect(answer.saved?.amount).toEqual({ currency: 'INR', amountMinor: amount });
      expect(keyed('answer.saved')[0]?.money?.amount).toEqual({ currency: 'INR', amountMinor: amount });
    } else {
      expect(answer.saved?.amount).toBeNull();
      expect(keyed('answer.saved')[0]?.money).toBeUndefined();
    }
  }

  // 4. Scope: another month names the month, never gets Today lines, and does not count toward the Current_Month.
  expect(answer.month).toBe(built.month);
  expect(answer.scope).toBe(built.isCurrent ? 'current_month' : 'other_month');
  expect(answer.countsTowardCurrentMonth).toBe(built.isCurrent);
  if (!built.isCurrent) {
    expect(answer.today).toBe('not_applicable');
    expect(answer.explanation).toBeNull();
    expect(lines.filter((line) => line.key.startsWith('answer.today.'))).toEqual([]);
    expect(answer.actions.filter((action) => action.key === 'exclude_from_today')).toEqual([]);
    expect(keyed('answer.month.countsTowardOther')[0]?.params).toEqual({ month: built.month, currentMonth: s.today.slice(0, 7) });
  } else {
    expect(keyed('answer.month.countsTowardOther')).toEqual([]);
  }

  // 5. Today lines: shown only for the current month when the server value is applicable and dated Today.
  const todayOutcome = built.todayOutcome;
  const shownValue = built.isCurrent && todayOutcome?.status === 'available' && todayOutcome.value?.applicable === true
    && todayOutcome.value.date === built.today
    ? todayOutcome.value
    : null;
  if (shownValue === null) {
    expect(lines.filter((line) => TODAY_VALUE_KEYS.has(line.key))).toEqual([]);
    expect(answer.today).not.toBe('shown');
    expect(answer.explanation).toBeNull();
    if (built.isCurrent) expect(answer.today).toBe(todayOutcome === null ? 'not_provided' : 'unavailable');
  } else {
    expect(answer.today).toBe('shown');
    expect(answer.explanation).not.toBeNull();
    const spent = keyed('answer.today.spent');
    if (valid(shownValue.todaySpent) && valid(shownValue.todayAllowance)) {
      expect(spent).toHaveLength(1);
      expect(spent[0]?.money?.todaySpent).toBe(shownValue.todaySpent);
      expect(spent[0]?.money?.todayAllowance).toBe(shownValue.todayAllowance);
    } else {
      expect(spent).toEqual([]);
    }
    // "Over" text comes from the server's overToday; a negative leftToday alone never produces it.
    const over = keyed('answer.today.over');
    const left = keyed('answer.today.left');
    if (valid(shownValue.overToday) && shownValue.overToday.amountMinor > 0) {
      expect(over).toHaveLength(1);
      expect(over[0]?.money?.overToday).toBe(shownValue.overToday);
      expect(left).toEqual([]);
    } else {
      expect(over).toEqual([]);
      if (valid(shownValue.leftToday)) {
        expect(left).toHaveLength(1);
        expect(left[0]?.money?.leftToday).toBe(shownValue.leftToday);
      } else {
        expect(left).toEqual([]);
      }
    }
    const zero = keyed('answer.today.zeroAllowance');
    expect(zero).toHaveLength(shownValue.zeroReason === null ? 0 : 1);
    if (zero[0] !== undefined) {
      if (shownValue.zeroReason === 'month_budget_used' && valid(shownValue.usedBeyondBudget)) {
        expect(zero[0].money?.usedBeyondBudget).toBe(shownValue.usedBeyondBudget);
      } else {
        expect(zero[0].money).toBeUndefined();
      }
    }
  }

  // 6. Bucket: the treatment the server applied to this entry, with the server spent and budget.
  const spendingValue = built.spending.status === 'available' ? built.spending.value : undefined;
  const expectedBucket = !built.removed && spendingValue !== undefined && s.treatment !== 'none' ? s.treatment : null;
  expect(answer.bucket).toBe(expectedBucket);
  const bucketLines = keyed('answer.bucket.status');
  if (spendingValue !== undefined && expectedBucket !== null) {
    const spent = expectedBucket === 'needs' ? spendingValue.needsSpent : spendingValue.wantsSpent;
    const budget = expectedBucket === 'needs' ? spendingValue.needsBudget : spendingValue.wantsBudget;
    if (valid(spent) && valid(budget)) {
      expect(bucketLines).toHaveLength(1);
      expect(bucketLines[0]?.money?.spent).toBe(spent);
      expect(bucketLines[0]?.money?.budget).toBe(budget);
      expect(bucketLines[0]?.params).toEqual({ bucket: expectedBucket, source: s.source });
    } else {
      expect(bucketLines).toEqual([]);
    }
  } else {
    expect(bucketLines).toEqual([]);
  }

  // 7. Exceeded buckets: the server excessMinor unchanged, one line per usable needs or wants action.
  const exceededLines = keyed('answer.bucket.exceeded');
  const expectedExcess = spendingValue === undefined
    ? []
    : spendingValue.exceededBudgetActions
      .filter((action) => (action.bucket === 'needs' || action.bucket === 'wants') && Number.isSafeInteger(action.excessMinor))
      .map((action) => action.excessMinor);
  expect(exceededLines.map((line) => line.money?.excess?.amountMinor).sort()).toEqual([...expectedExcess].sort());

  // 8. Remaining_Spendable passes through signed. The over-budget line exists only for a negative server value.
  const planValue = built.plan.status === 'available' ? built.plan.value : undefined;
  const remaining = planValue?.remainingSpendable ?? spendingValue?.remainingSpendable;
  const overBudget = keyed('answer.month.overBudget');
  if (valid(remaining) && remaining.amountMinor < 0) {
    expect(overBudget).toHaveLength(1);
    expect(overBudget[0]?.money?.remainingSpendable).toBe(remaining);
    expect(overBudget[0]?.money?.remainingSpendable?.amountMinor).toBeLessThan(0);
  } else {
    expect(overBudget).toEqual([]);
  }
  const remainingLines = keyed('answer.month.remaining');
  if (!built.isCurrent && valid(remaining)) {
    expect(remainingLines).toHaveLength(1);
    expect(remainingLines[0]?.money?.remainingSpendable).toBe(remaining);
  } else {
    expect(remainingLines).toEqual([]);
  }

  // 9. Missing, invalid, and failed outcomes: the matching message and action, and no invented value.
  const considered = [built.plan, built.spending, built.isCurrent ? todayOutcome : null].filter(
    (outcome): outcome is NonNullable<typeof outcome> => outcome !== null,
  );
  const status = considered.some((outcome) => outcome.status === 'missing_input')
    ? 'missing_input'
    : considered.some((outcome) => outcome.status === 'invalid_input')
      ? 'invalid_input'
      : considered.some((outcome) => outcome.status !== 'available') ? 'calculation_failed' : 'available';
  expect(answer.status).toBe(status);
  const recalculate = answer.actions.filter((action) => action.key === 'recalculate');
  const payForm = answer.actions.filter((action) => action.key === 'open_plan_pay_form');
  expect(keyed('answer.missingInput')).toHaveLength(status === 'missing_input' ? 1 : 0);
  expect(keyed('answer.invalidInput')).toHaveLength(status === 'invalid_input' ? 1 : 0);
  expect(keyed('answer.effect.unavailable')).toHaveLength(status === 'calculation_failed' ? 1 : 0);
  expect(payForm).toHaveLength(status === 'missing_input' && s.missingInput === 'salary' ? 1 : 0);
  expect(recalculate).toHaveLength(status === 'calculation_failed' ? 1 : 0);
  if (recalculate[0]?.key === 'recalculate') {
    const scopes = considered
      .filter((outcome) => ['calculation_failed', 'refresh_failed', 'stale'].includes(outcome.status))
      .map((outcome) => outcome.retry?.scopeKey);
    expect(scopes).toContain(recalculate[0].scopeKey);
  }
  if (status !== 'available') {
    for (const key of ['answer.missingInput', 'answer.invalidInput', 'answer.effect.unavailable']) {
      for (const line of keyed(key)) expect(line.money).toBeUndefined();
    }
  }

  // 10. A non-available outcome never supplies a value, even when it carries one.
  for (const money of found) {
    const fromUnavailable = [built.plan, built.spending, todayOutcome].some((outcome) => {
      if (outcome === null || outcome.status === 'available' || outcome.value === undefined) return false;
      const own = new Set<MoneyValue>();
      collectMoneyObjects(outcome.value, own);
      return own.has(money);
    });
    expect(fromUnavailable).toBe(false);
  }
}

/* ------------------------------------------------------------- properties */

describe('Property 22: Entry_Answer uses only server values', () => {
  it('references only response money, takes over text from server fields, and invents no value', () => {
    // Feature: quick-add-daily-answer, Property 22: Entry_Answer uses only server values
    // Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5, 9.8, 9.9, 9.10, 9.11
    assertProperty(
      fc.property(scenarioArb, (s) => {
        const built = build(s);
        requireSentinelValues(built.responseInts);
        const answer = buildEntryAnswer(built.envelope, built.entry, built.today);
        check(s, built, answer);
      }),
      { numRuns: 300 },
    );
  });

  it('gives a response for another month no Today line and no Current_Month claim in any outcome state', () => {
    // Feature: quick-add-daily-answer, Property 22: Entry_Answer uses only server values
    // Validates: Requirements 9.5, 9.11
    assertProperty(
      fc.property(scenarioArb.map((s): Scenario => ({ ...s, current: false })), (s) => {
        const built = build(s);
        requireSentinelValues(built.responseInts);
        const answer = buildEntryAnswer(built.envelope, built.entry, built.today);
        check(s, built, answer);
        expect(answer.lines.some((line) => TODAY_VALUE_KEYS.has(line.key))).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('is deterministic and leaves the response and the entry unmodified', () => {
    // Feature: quick-add-daily-answer, Property 22: Entry_Answer uses only server values
    // Validates: Requirements 9.1, 9.2
    assertProperty(
      fc.property(scenarioArb, (s) => {
        const built = build(s);
        const envelopeBefore = structuredClone(built.envelope);
        const entryBefore = structuredClone(built.entry);
        deepFreeze(built.envelope);
        deepFreeze(built.entry);
        const first = buildEntryAnswer(built.envelope, built.entry, built.today);
        const second = buildEntryAnswer(built.envelope, built.entry, built.today);
        expect(second).toEqual(first);
        expect(built.envelope).toEqual(envelopeBefore);
        expect(built.entry).toEqual(entryBefore);
      }),
      { numRuns: 100 },
    );
  });
});

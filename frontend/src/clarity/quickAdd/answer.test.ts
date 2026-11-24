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
import { buildEntryAnswer, EXPENSE_DELETE_OPERATION, type AnswerLine, type AnswerEntryInput } from './answer';

const TODAY = '2025-03-14';
const MONTH = '2025-03';
const EXPENSE_ID = 41;

const m = (amountMinor: number): MoneyValue => ({ currency: 'INR', amountMinor });
const period = (month = MONTH) => ({
  month,
  start: `${month}-01`,
  endExclusive: `${month}-31`,
  timeZone: 'Asia/Kolkata' as const,
});

function planValue(overrides: Partial<MonthlyPlanValue> = {}): MonthlyPlanValue {
  return {
    salary: m(10_000_000),
    activeBillsTotal: m(3_000_000),
    shortfall: m(0),
    disposableIncome: m(7_000_000),
    needsBudget: m(3_500_000),
    wantsBudget: m(2_100_000),
    savingsTarget: m(1_400_000),
    spendableBudget: m(5_600_000),
    needsSpent: m(500_000),
    wantsSpent: m(100_000),
    remainingSpendable: m(5_000_000),
    dailySpendingGuide: m(300_000),
    projectedSavings: m(1_400_000),
    ...overrides,
  };
}

function spendingValue(overrides: Partial<SpendingOutcomeValue> = {}): SpendingOutcomeValue {
  return {
    month: MONTH,
    categoryTotals: [],
    appliedTreatments: [{ expenseId: EXPENSE_ID, category: 'Food', treatment: 'wants', source: 'default' }],
    needsBudget: m(3_500_000),
    wantsBudget: m(2_100_000),
    needsSpent: m(500_000),
    wantsSpent: m(100_000),
    totalSpending: m(600_000),
    spendableBudget: m(5_600_000),
    remainingSpendable: m(5_000_000),
    dailySpendingGuide: m(300_000),
    savingsTarget: m(1_400_000),
    projectedSavings: m(1_400_000),
    projectedSavingsDifference: m(0),
    exceededBudgetActions: [],
    ...overrides,
  };
}

type ApplicableToday = Extract<TodayAllowanceValue, { applicable: true }>;

function todayValue(overrides: Partial<ApplicableToday> = {}): ApplicableToday {
  return {
    applicable: true,
    date: TODAY,
    daysRemainingInclusive: 18,
    todayAllowance: m(300_000),
    todaySpent: m(45_000),
    leftToday: m(255_000),
    overToday: m(0),
    allowanceBasis: m(5_300_000),
    usedPermille: 150,
    zeroReason: null,
    usedBeyondBudget: m(0),
    excludedToday: { count: 0, total: m(0) },
    largeEntryThreshold: m(1_400_000),
    ...overrides,
  };
}

function outcome<T>(
  id: string,
  kind: Outcome<T>['kind'],
  status: OutcomeStatus,
  value: T | undefined,
  extra: Partial<Outcome<T>> = {},
  month = MONTH,
): Outcome<T> {
  return {
    id,
    kind,
    status,
    classification: 'calculated_result',
    period: period(month),
    dataVersion: 7,
    ...(value === undefined ? {} : { value }),
    sourceRefs: [],
    ...extra,
  };
}

interface EnvelopeOptions {
  month?: string;
  operation?: string;
  record?: Record<string, unknown> | null;
  plan?: Outcome<MonthlyPlanValue>;
  spending?: Outcome<SpendingOutcomeValue>;
  today?: TodayAllowanceOutcome | null;
  dataVersion?: number;
}

function todayOutcome(
  status: OutcomeStatus,
  value: TodayAllowanceValue | undefined,
  extra: Partial<Outcome<TodayAllowanceValue>> = {},
  month = MONTH,
): TodayAllowanceOutcome {
  return {
    ...outcome<TodayAllowanceValue>(`today-allowance:${month}`, 'monthly_plan', status, value, extra, month),
    kind: 'today_allowance',
  };
}

function envelope(options: EnvelopeOptions = {}): MutationEnvelope {
  const month = options.month ?? MONTH;
  const outcomes: FinancialSnapshot['outcomes'] = {
    monthlyPlan: options.plan ?? outcome(`monthly-plan:${month}`, 'monthly_plan', 'available', planValue(), {}, month),
    spending: options.spending ?? outcome(`spending:${month}`, 'spending', 'available', spendingValue(), {}, month),
    goals: [],
    tripSummary: outcome('trip-summary', 'trip_summary', 'available', []),
    ...(options.today === null
      ? {}
      : { todayAllowance: options.today ?? todayOutcome('available', todayValue(), {}, month) }),
  };
  return {
    schemaVersion: 1,
    mutation: {
      changeId: 5,
      idempotencyKey: 'k',
      scopeKey: `expense:${EXPENSE_ID}`,
      operation: options.operation ?? 'expense.create',
      recordType: 'expense',
      recordId: EXPENSE_ID,
      status: 'confirmed',
      recordVersion: 1,
      record: options.record === undefined
        ? {
            id: EXPENSE_ID,
            month,
            category: 'Food',
            amountMinor: 45_000,
            note: 'swiggy',
            spentOn: TODAY,
            excludeFromDailyAllowance: false,
          }
        : options.record,
    },
    clarity: {
      dataVersion: options.dataVersion ?? 12,
      currency: 'INR',
      precisionMinor: 1,
      period: {
        month,
        timeZone: 'Asia/Kolkata',
        start: `${month}-01`,
        endExclusive: `${month}-31`,
        asOfDate: TODAY,
        daysRemainingInclusive: 18,
      },
      facts: [],
      outcomes,
      actions: [],
    },
  };
}

const ENTRY: AnswerEntryInput = { category: 'Food', spentOn: TODAY, note: 'swiggy', exclusionRequested: false };
const keys = (lines: readonly AnswerLine[]) => lines.map((line) => line.key);
const lineOf = (lines: readonly AnswerLine[], key: AnswerLine['key']) => lines.find((line) => line.key === key);

describe('buildEntryAnswer: current month with the plan available', () => {
  const env = envelope();
  const answer = buildEntryAnswer(env, ENTRY, TODAY);
  const today = (env.clarity.outcomes.todayAllowance as TodayAllowanceOutcome).value as ApplicableToday;

  it('names the saved entry from the confirmed record', () => {
    expect(answer.mode).toBe('saved');
    expect(answer.titleKey).toBe('answer.saved');
    expect(answer.saved).toEqual({
      recordId: EXPENSE_ID,
      amount: m(45_000),
      category: 'Food',
      note: 'swiggy',
      spentOn: TODAY,
      dateRelation: 'today',
    });
    expect(answer.lines[0]).toMatchObject({ key: 'answer.saved', classification: 'entered_fact' });
    expect(answer.lines[0]?.money?.amount).toEqual(m(45_000));
  });

  it('shows Today_Spent of Today_Allowance and Left_Today by reference to the server values', () => {
    expect(answer.scope).toBe('current_month');
    expect(answer.countsTowardCurrentMonth).toBe(true);
    expect(answer.status).toBe('available');
    expect(answer.today).toBe('shown');
    const spent = lineOf(answer.lines, 'answer.today.spent');
    expect(spent?.money?.todaySpent).toBe(today.todaySpent);
    expect(spent?.money?.todayAllowance).toBe(today.todayAllowance);
    expect(spent?.classification).toBe('calculated_result');
    expect(lineOf(answer.lines, 'answer.today.left')?.money?.leftToday).toBe(today.leftToday);
    expect(keys(answer.lines)).not.toContain('answer.today.over');
  });

  it('states the bucket the server applied with its spent and budget', () => {
    expect(answer.bucket).toBe('wants');
    const bucket = lineOf(answer.lines, 'answer.bucket.status');
    expect(bucket?.params).toEqual({ bucket: 'wants', source: 'default' });
    expect(bucket?.money).toEqual({ spent: m(100_000), budget: m(2_100_000) });
    expect(keys(answer.lines)).not.toContain('answer.bucket.exceeded');
  });

  it('uses the Needs amounts for a Needs entry and keeps the override source', () => {
    const needs = envelope({
      spending: outcome(`spending:${MONTH}`, 'spending', 'available', spendingValue({
        appliedTreatments: [{ expenseId: EXPENSE_ID, category: 'Food', treatment: 'needs', source: 'override' }],
      })),
    });
    const result = buildEntryAnswer(needs, ENTRY, TODAY);
    expect(result.bucket).toBe('needs');
    const bucket = lineOf(result.lines, 'answer.bucket.status');
    expect(bucket?.params).toEqual({ bucket: 'needs', source: 'override' });
    expect(bucket?.money).toEqual({ spent: m(500_000), budget: m(3_500_000) });
  });

  it('adds no date line for an entry dated today and offers the Today_Allowance explanation control', () => {
    expect(keys(answer.lines)).not.toContain('answer.entry.date');
    expect(answer.explanation).toEqual({ outcomeId: `today-allowance:${MONTH}`, dataVersion: 7 });
  });

  it('uses the explanation reference the server provides', () => {
    const withRef = envelope({
      today: todayOutcome('available', todayValue(), { explanationRef: { outcomeId: 'today-allowance:2025-03', dataVersion: 9 } }),
    });
    expect(buildEntryAnswer(withRef, ENTRY, TODAY).explanation).toEqual({
      outcomeId: 'today-allowance:2025-03',
      dataVersion: 9,
    });
  });

  it('offers no action and shows no month lines when nothing needs attention', () => {
    expect(answer.actions).toEqual([]);
    expect(keys(answer.lines)).not.toContain('answer.month.remaining');
    expect(keys(answer.lines)).not.toContain('answer.month.overBudget');
    expect(answer.dataVersion).toBe(12);
    expect(answer.month).toBe(MONTH);
  });

  it('states the entry date when it is not today, in the current month', () => {
    const past = buildEntryAnswer(
      envelope({ record: { id: EXPENSE_ID, month: MONTH, category: 'Food', amountMinor: 45_000, note: null, spentOn: '2025-03-10' } }),
      { ...ENTRY, spentOn: '2025-03-10' },
      TODAY,
    );
    expect(past.saved?.dateRelation).toBe('past');
    expect(lineOf(past.lines, 'answer.entry.date')?.params).toEqual({ date: '2025-03-10', relation: 'past' });
    expect(past.scope).toBe('current_month');
    expect(keys(past.lines)).toContain('answer.today.spent');

    const future = buildEntryAnswer(
      envelope({ record: { id: EXPENSE_ID, month: MONTH, category: 'Food', amountMinor: 45_000, note: null, spentOn: '2025-03-20' } }),
      { ...ENTRY, spentOn: '2025-03-20' },
      TODAY,
    );
    expect(future.saved?.dateRelation).toBe('future');
    expect(lineOf(future.lines, 'answer.entry.date')?.params).toEqual({ date: '2025-03-20', relation: 'future' });
  });
});

describe('buildEntryAnswer: over today and exceeded budgets', () => {
  it('states "over" from the server overToday field and offers the exclusion action', () => {
    const over = todayValue({
      todaySpent: m(450_000),
      leftToday: m(-150_000),
      overToday: m(150_000),
      usedPermille: 1000,
    });
    const env = envelope({ today: todayOutcome('available', over) });
    const answer = buildEntryAnswer(env, ENTRY, TODAY);
    expect(lineOf(answer.lines, 'answer.today.over')?.money?.overToday).toBe(over.overToday);
    expect(keys(answer.lines)).not.toContain('answer.today.left');
    expect(answer.actions).toEqual([{ key: 'exclude_from_today', recordId: EXPENSE_ID, reasons: ['over_today'] }]);
  });

  it('does not offer the exclusion action for an over-today entry dated on another day', () => {
    const over = todayValue({ leftToday: m(-1), overToday: m(1) });
    const env = envelope({
      today: todayOutcome('available', over),
      record: { id: EXPENSE_ID, month: MONTH, category: 'Food', amountMinor: 45_000, note: null, spentOn: '2025-03-13' },
    });
    expect(buildEntryAnswer(env, { ...ENTRY, spentOn: '2025-03-13' }, TODAY).actions).toEqual([]);
  });

  it('collects every reason: large, bill, and over today', () => {
    const over = todayValue({ leftToday: m(-1), overToday: m(1) });
    const answer = buildEntryAnswer(
      envelope({ today: todayOutcome('available', over) }),
      { ...ENTRY, warning: { kind: 'warn', bill: 'Rent', large: true } },
      TODAY,
    );
    expect(answer.actions).toEqual([
      { key: 'exclude_from_today', recordId: EXPENSE_ID, reasons: ['large', 'bill', 'over_today'] },
    ]);
  });

  it('offers the exclusion action for a Large_Entry or a Bill_Match even when Left_Today is not negative', () => {
    const large = buildEntryAnswer(envelope(), { ...ENTRY, warning: { kind: 'warn', large: true } }, TODAY);
    expect(large.actions).toEqual([{ key: 'exclude_from_today', recordId: EXPENSE_ID, reasons: ['large'] }]);
    const bill = buildEntryAnswer(envelope(), { ...ENTRY, warning: { kind: 'warn', bill: 'Rent', large: false } }, TODAY);
    expect(bill.actions).toEqual([{ key: 'exclude_from_today', recordId: EXPENSE_ID, reasons: ['bill'] }]);
    const none = buildEntryAnswer(envelope(), { ...ENTRY, warning: { kind: 'none' } }, TODAY);
    expect(none.actions).toEqual([]);
  });

  it('words an exceeded bucket from the server excessMinor, the entry bucket first', () => {
    const spending = outcome(`spending:${MONTH}`, 'spending', 'available', spendingValue({
      exceededBudgetActions: [
        {
          conditionCode: 'needs_budget_exceeded',
          bucket: 'needs',
          budgetMinor: 3_500_000,
          spentMinor: 3_650_000,
          excessMinor: 150_000,
          actionKey: 'review_needs',
          actionLabel: 'Review needs',
          correctiveAction: 'x',
        },
        {
          conditionCode: 'wants_budget_exceeded',
          bucket: 'wants',
          budgetMinor: 2_100_000,
          spentMinor: 2_160_000,
          excessMinor: 60_000,
          actionKey: 'review_wants',
          actionLabel: 'Review wants',
          correctiveAction: 'x',
        },
      ],
    }));
    const answer = buildEntryAnswer(envelope({ spending }), ENTRY, TODAY);
    const exceeded = answer.lines.filter((line) => line.key === 'answer.bucket.exceeded');
    expect(exceeded.map((line) => line.params?.bucket)).toEqual(['wants', 'needs']);
    expect(exceeded.map((line) => line.money?.excess)).toEqual([m(60_000), m(150_000)]);
    expect(exceeded.every((line) => line.classification === 'calculated_result')).toBe(true);
  });

  it('shows an over-budget month when Remaining_Spendable is negative', () => {
    const negative = m(-120_000);
    const plan = outcome(`monthly-plan:${MONTH}`, 'monthly_plan', 'available', planValue({ remainingSpendable: negative }));
    const answer = buildEntryAnswer(envelope({ plan }), ENTRY, TODAY);
    const line = lineOf(answer.lines, 'answer.month.overBudget');
    expect(line?.money?.remainingSpendable).toBe(negative);
    expect(line?.params).toEqual({ month: MONTH });
  });

  it('adds the zero-allowance reason with the server usedBeyondBudget', () => {
    const zero = todayValue({
      todayAllowance: m(0),
      todaySpent: m(0),
      leftToday: m(0),
      usedPermille: null,
      zeroReason: 'month_budget_used',
      usedBeyondBudget: m(80_000),
    });
    const answer = buildEntryAnswer(envelope({ today: todayOutcome('available', zero) }), ENTRY, TODAY);
    const line = lineOf(answer.lines, 'answer.today.zeroAllowance');
    expect(line?.params).toEqual({ reason: 'month_budget_used' });
    expect(line?.money?.usedBeyondBudget).toBe(zero.usedBeyondBudget);
    const bills = buildEntryAnswer(
      envelope({ today: todayOutcome('available', todayValue({ zeroReason: 'no_spendable_budget' })) }),
      ENTRY,
      TODAY,
    );
    expect(lineOf(bills.lines, 'answer.today.zeroAllowance')?.money).toBeUndefined();
  });
});

describe('buildEntryAnswer: saved mark and unconfirmed mark', () => {
  const excludedRecord = {
    id: EXPENSE_ID,
    month: MONTH,
    category: 'Bills',
    amountMinor: 1_500_000,
    note: 'rent',
    spentOn: TODAY,
    excludeFromDailyAllowance: true,
  };

  it('states the entry is not counted today, the month includes it, and the allowance after the save', () => {
    const value = todayValue({ excludedToday: { count: 1, total: m(1_500_000) }, todaySpent: m(0), leftToday: m(250_000), todayAllowance: m(250_000) });
    const answer = buildEntryAnswer(
      envelope({ record: excludedRecord, today: todayOutcome('available', value) }),
      { ...ENTRY, category: 'Bills', exclusionRequested: true },
      TODAY,
    );
    expect(keys(answer.lines)).toEqual(expect.arrayContaining([
      'answer.today.excluded.notCounted',
      'answer.today.excluded.monthIncludes',
      'answer.today.excluded.allowanceAfter',
      'answer.today.excluded.allowanceChanged',
    ]));
    expect(lineOf(answer.lines, 'answer.today.excluded.allowanceAfter')?.money?.todayAllowance).toBe(value.todayAllowance);
    expect(keys(answer.lines)).not.toContain('answer.today.exclusionUnconfirmed');
    expect(answer.actions).toEqual([]);
  });

  it('keeps the excluded statements and offers no action even when the warning was large', () => {
    const answer = buildEntryAnswer(
      envelope({ record: excludedRecord }),
      { ...ENTRY, exclusionRequested: true, warning: { kind: 'warn', large: true } },
      TODAY,
    );
    expect(keys(answer.lines)).toContain('answer.today.excluded.notCounted');
    expect(answer.actions).toEqual([]);
  });

  it('states the mark without allowance lines when the server sends no Today fields', () => {
    const answer = buildEntryAnswer(
      envelope({ record: excludedRecord, today: null }),
      { ...ENTRY, exclusionRequested: true },
      TODAY,
    );
    expect(keys(answer.lines)).toEqual(expect.arrayContaining([
      'answer.today.excluded.notCounted',
      'answer.today.excluded.monthIncludes',
    ]));
    expect(keys(answer.lines)).not.toContain('answer.today.excluded.allowanceAfter');
  });

  it('says "counted against today" and offers the update action when the mark was requested but not confirmed', () => {
    const answer = buildEntryAnswer(
      envelope({ record: { ...excludedRecord, excludeFromDailyAllowance: false } }),
      { ...ENTRY, exclusionRequested: true },
      TODAY,
    );
    expect(keys(answer.lines)).toContain('answer.today.exclusionUnconfirmed');
    expect(keys(answer.lines)).not.toContain('answer.today.excluded.notCounted');
    expect(answer.actions).toEqual([{ key: 'exclude_from_today', recordId: EXPENSE_ID, reasons: ['unconfirmed'] }]);
  });

  it('treats a record from an old server without the field as unconfirmed', () => {
    const { excludeFromDailyAllowance: _omitted, ...legacy } = excludedRecord;
    const answer = buildEntryAnswer(envelope({ record: legacy, today: null }), { ...ENTRY, exclusionRequested: true }, TODAY);
    expect(keys(answer.lines)).toContain('answer.today.exclusionUnconfirmed');
    expect(answer.actions).toEqual([{ key: 'exclude_from_today', recordId: EXPENSE_ID, reasons: ['unconfirmed'] }]);
  });

  it('adds nothing about the mark when it was not requested and the record is not marked', () => {
    const answer = buildEntryAnswer(envelope(), ENTRY, TODAY);
    expect(keys(answer.lines)).not.toContain('answer.today.exclusionUnconfirmed');
    expect(keys(answer.lines)).not.toContain('answer.today.excluded.notCounted');
  });
});

describe('buildEntryAnswer: another month', () => {
  const OTHER = '2025-02';
  const otherRecord = { id: EXPENSE_ID, month: OTHER, category: 'Food', amountMinor: 45_000, note: null, spentOn: '2025-02-27', excludeFromDailyAllowance: false };
  const plan = outcome(`monthly-plan:${OTHER}`, 'monthly_plan', 'available', planValue({ remainingSpendable: m(1_234_500) }), {}, OTHER);
  const spending = outcome(
    `spending:${OTHER}`,
    'spending',
    'available',
    spendingValue({ month: OTHER, needsSpent: m(111), wantsSpent: m(222), needsBudget: m(333), wantsBudget: m(444) }),
    {},
    OTHER,
  );
  const todayNotApplicable = todayOutcome('available', { applicable: false, reason: 'not_current_month' }, {}, OTHER);

  it('names the month, shows its Remaining_Spendable and bucket, and leaves the Current_Month alone', () => {
    const env = envelope({ month: OTHER, record: otherRecord, plan, spending, today: todayNotApplicable });
    const answer = buildEntryAnswer(env, { ...ENTRY, spentOn: '2025-02-27' }, TODAY);
    expect(answer.scope).toBe('other_month');
    expect(answer.month).toBe(OTHER);
    expect(answer.countsTowardCurrentMonth).toBe(false);
    expect(answer.today).toBe('not_applicable');
    expect(answer.explanation).toBeNull();
    expect(lineOf(answer.lines, 'answer.month.countsTowardOther')?.params).toEqual({ month: OTHER, currentMonth: MONTH });
    expect(lineOf(answer.lines, 'answer.month.remaining')?.money?.remainingSpendable).toBe(
      (plan.value as MonthlyPlanValue).remainingSpendable,
    );
    expect(lineOf(answer.lines, 'answer.bucket.status')?.money).toEqual({ spent: m(222), budget: m(444) });
    expect(keys(answer.lines).filter((key) => key.startsWith('answer.today.'))).toEqual([]);
    expect(answer.actions).toEqual([]);
  });

  it('never shows Today values for another month, even if the server sent applicable values', () => {
    const env = envelope({ month: OTHER, record: otherRecord, plan, spending, today: todayOutcome('available', todayValue(), {}, OTHER) });
    const answer = buildEntryAnswer(env, { ...ENTRY, exclusionRequested: true, warning: { kind: 'warn', large: true } }, TODAY);
    expect(answer.today).toBe('not_applicable');
    expect(keys(answer.lines).filter((key) => key.startsWith('answer.today.'))).toEqual([]);
    expect(answer.actions).toEqual([]);
    expect(answer.explanation).toBeNull();
  });

  it('treats a future month the same way and states the over-budget amount when negative', () => {
    const futurePlan = outcome('monthly-plan:2025-04', 'monthly_plan', 'available', planValue({ remainingSpendable: m(-500) }), {}, '2025-04');
    const env = envelope({
      month: '2025-04',
      record: { ...otherRecord, month: '2025-04', spentOn: '2025-04-02' },
      plan: futurePlan,
      spending: outcome('spending:2025-04', 'spending', 'available', spendingValue({ month: '2025-04' }), {}, '2025-04'),
      today: todayOutcome('available', { applicable: false, reason: 'not_current_month' }, {}, '2025-04'),
    });
    const answer = buildEntryAnswer(env, { ...ENTRY, spentOn: '2025-04-02' }, TODAY);
    expect(answer.scope).toBe('other_month');
    expect(lineOf(answer.lines, 'answer.entry.date')?.params).toEqual({ date: '2025-04-02', relation: 'future' });
    expect(keys(answer.lines)).toEqual(expect.arrayContaining(['answer.month.remaining', 'answer.month.overBudget']));
  });

  it('keeps the other-month answer when the server has no Today fields', () => {
    const env = envelope({ month: OTHER, record: otherRecord, plan, spending, today: null });
    const answer = buildEntryAnswer(env, { ...ENTRY, spentOn: '2025-02-27' }, TODAY);
    expect(answer.scope).toBe('other_month');
    expect(answer.status).toBe('available');
    expect(answer.today).toBe('not_applicable');
  });
});

describe('buildEntryAnswer: missing, invalid, and failed outcomes', () => {
  const missing = (month = MONTH) => ({
    plan: outcome<MonthlyPlanValue>(`monthly-plan:${month}`, 'monthly_plan', 'missing_input', undefined, {
      missing: [{ input: 'salary', unlocks: ['monthly_plan', 'spending'] }],
    }, month),
    spending: outcome<SpendingOutcomeValue>(`spending:${month}`, 'spending', 'missing_input', undefined, {
      missing: [{ input: 'salary', unlocks: ['monthly_plan', 'spending'] }],
    }, month),
    today: todayOutcome('missing_input', undefined, { missing: [{ input: 'salary', unlocks: ['monthly_plan'] }] }, month),
  });

  it('confirms the save, names the month and the missing pay, and links to the Plan pay form', () => {
    const answer = buildEntryAnswer(envelope(missing()), ENTRY, TODAY);
    expect(answer.status).toBe('missing_input');
    expect(answer.lines[0]?.key).toBe('answer.saved');
    expect(lineOf(answer.lines, 'answer.missingInput')?.params).toEqual({ month: MONTH, input: 'salary' });
    expect(answer.actions).toEqual([{ key: 'open_plan_pay_form', route: '/plan#pay-form' }]);
    expect(answer.lines.filter((line) => line.money !== undefined).map((line) => line.key)).toEqual(['answer.saved']);
    expect(answer.today).toBe('unavailable');
    expect(answer.explanation).toBeNull();
  });

  it('names the other month when the missing pay belongs to another month', () => {
    const parts = missing('2025-02');
    const env = envelope({
      month: '2025-02',
      record: { id: EXPENSE_ID, month: '2025-02', category: 'Food', amountMinor: 45_000, note: null, spentOn: '2025-02-02' },
      plan: parts.plan,
      spending: parts.spending,
      today: null,
    });
    const answer = buildEntryAnswer(env, { ...ENTRY, spentOn: '2025-02-02' }, TODAY);
    expect(answer.status).toBe('missing_input');
    expect(lineOf(answer.lines, 'answer.missingInput')?.params).toEqual({ month: '2025-02', input: 'salary' });
    expect(answer.actions).toEqual([{ key: 'open_plan_pay_form', route: '/plan#pay-form' }]);
  });

  it('names the invalid input, its constraint, and the affected outcomes', () => {
    const invalid = {
      input: 'bill:3.amountMinor',
      constraint: 'a positive safe integer number of paise',
      affects: ['monthly_plan' as const, 'spending' as const],
    };
    const plan = outcome<MonthlyPlanValue>(`monthly-plan:${MONTH}`, 'monthly_plan', 'invalid_input', undefined, { invalid: [invalid] });
    const spending = outcome<SpendingOutcomeValue>(`spending:${MONTH}`, 'spending', 'invalid_input', undefined, { invalid: [invalid] });
    const today = todayOutcome('invalid_input', undefined, { invalid: [invalid] });
    const answer = buildEntryAnswer(envelope({ plan, spending, today }), ENTRY, TODAY);
    expect(answer.status).toBe('invalid_input');
    expect(lineOf(answer.lines, 'answer.invalidInput')?.params).toEqual({
      month: MONTH,
      input: 'bill:3.amountMinor',
      constraint: 'a positive safe integer number of paise',
      affects: ['monthly_plan', 'spending'],
    });
    expect(answer.actions).toEqual([]);
    expect(answer.lines[0]?.key).toBe('answer.saved');
  });

  it('marks the effect unavailable with one recalculate action that carries the retry scope', () => {
    const retry = { action: 'recalculate' as const, scopeKey: 'outcome:monthly-plan:2025-03' };
    const plan = outcome<MonthlyPlanValue>(`monthly-plan:${MONTH}`, 'monthly_plan', 'calculation_failed', undefined, { retry });
    const spending = outcome<SpendingOutcomeValue>(`spending:${MONTH}`, 'spending', 'calculation_failed', undefined, {
      retry: { action: 'recalculate', scopeKey: 'outcome:spending:2025-03' },
    });
    const today = todayOutcome('calculation_failed', undefined, {
      retry: { action: 'recalculate', scopeKey: 'outcome:today-allowance:2025-03' },
    });
    const answer = buildEntryAnswer(envelope({ plan, spending, today }), ENTRY, TODAY);
    expect(answer.status).toBe('calculation_failed');
    expect(keys(answer.lines)).toContain('answer.effect.unavailable');
    expect(answer.actions).toEqual([{ key: 'recalculate', scopeKey: 'outcome:monthly-plan:2025-03' }]);
    expect(answer.lines.filter((line) => line.money !== undefined).map((line) => line.key)).toEqual(['answer.saved']);
  });

  it('keeps the available sections when only the Today outcome failed, with one recalculate action', () => {
    const today = todayOutcome('calculation_failed', undefined, {
      retry: { action: 'recalculate', scopeKey: 'outcome:today-allowance:2025-03' },
    });
    const answer = buildEntryAnswer(envelope({ today }), ENTRY, TODAY);
    expect(answer.status).toBe('calculation_failed');
    expect(answer.today).toBe('unavailable');
    expect(keys(answer.lines)).toContain('answer.bucket.status');
    expect(keys(answer.lines)).not.toContain('answer.today.spent');
    expect(answer.actions).toEqual([{ key: 'recalculate', scopeKey: 'outcome:today-allowance:2025-03' }]);
  });

  it('treats stale and refresh_failed outcomes as unavailable with a recalculate action', () => {
    for (const status of ['stale', 'refresh_failed'] as const) {
      const plan = outcome<MonthlyPlanValue>(`monthly-plan:${MONTH}`, 'monthly_plan', status, undefined, {
        retry: { action: 'refresh', scopeKey: 'outcome:monthly-plan:2025-03' },
      });
      const answer = buildEntryAnswer(envelope({ plan }), ENTRY, TODAY);
      expect(answer.status).toBe('calculation_failed');
      expect(answer.actions).toEqual([{ key: 'recalculate', scopeKey: 'outcome:monthly-plan:2025-03' }]);
    }
  });

  it('falls back to a recalculate action when the response carries no snapshot', () => {
    const env = { ...envelope(), clarity: undefined } as unknown as MutationEnvelope;
    const answer = buildEntryAnswer(env, ENTRY, TODAY);
    expect(answer.status).toBe('calculation_failed');
    expect(answer.actions).toEqual([{ key: 'recalculate', scopeKey: null }]);
    expect(answer.lines[0]?.key).toBe('answer.saved');
  });
});

describe('buildEntryAnswer: server without Today fields', () => {
  it('gives the monthly answer only, with no failure and no explanation control', () => {
    const answer = buildEntryAnswer(envelope({ today: null }), ENTRY, TODAY);
    expect(answer.today).toBe('not_provided');
    expect(answer.status).toBe('available');
    expect(answer.explanation).toBeNull();
    expect(answer.actions).toEqual([]);
    expect(keys(answer.lines).filter((key) => key.startsWith('answer.today.'))).toEqual([]);
    expect(keys(answer.lines)).toContain('answer.bucket.status');
  });

  it('shows the over-budget month when remaining is negative, without Today values', () => {
    const plan = outcome(`monthly-plan:${MONTH}`, 'monthly_plan', 'available', planValue({ remainingSpendable: m(-1) }));
    const answer = buildEntryAnswer(envelope({ plan, today: null }), ENTRY, TODAY);
    expect(keys(answer.lines)).toContain('answer.month.overBudget');
  });

  it('does not show Today values that are for another date than today', () => {
    const stale = todayValue({ date: '2025-03-13' });
    const answer = buildEntryAnswer(envelope({ today: todayOutcome('available', stale) }), ENTRY, TODAY);
    expect(answer.today).toBe('unavailable');
    expect(keys(answer.lines)).not.toContain('answer.today.spent');
    expect(answer.explanation).toBeNull();
  });

  it('does not show Today values when the server says the month is not current', () => {
    const answer = buildEntryAnswer(
      envelope({ today: todayOutcome('available', { applicable: false, reason: 'not_current_month' }) }),
      ENTRY,
      TODAY,
    );
    expect(answer.today).toBe('unavailable');
    expect(keys(answer.lines)).not.toContain('answer.today.spent');
  });
});

describe('buildEntryAnswer: result after undo', () => {
  const deleted = (overrides: EnvelopeOptions = {}) => envelope({
    operation: EXPENSE_DELETE_OPERATION,
    record: null,
    dataVersion: 13,
    ...overrides,
  });

  it('labels the answer "Entry removed" and shows the server values after the deletion', () => {
    const after = todayValue({ todaySpent: m(0), leftToday: m(300_000), usedPermille: 0 });
    const env = deleted({ today: todayOutcome('available', after) });
    const answer = buildEntryAnswer(env, ENTRY, TODAY);
    expect(answer.mode).toBe('removed');
    expect(answer.titleKey).toBe('answer.removed');
    expect(answer.saved).toBeNull();
    expect(answer.dataVersion).toBe(13);
    expect(answer.lines[0]?.key).toBe('answer.removed');
    expect(keys(answer.lines)).not.toContain('answer.saved');
    expect(lineOf(answer.lines, 'answer.today.spent')?.money?.todaySpent).toBe(after.todaySpent);
    expect(lineOf(answer.lines, 'answer.today.left')?.money?.leftToday).toBe(after.leftToday);
  });

  it('shows no entry bucket, no exclusion statements, and no exclusion action', () => {
    const answer = buildEntryAnswer(
      deleted(),
      { ...ENTRY, exclusionRequested: true, warning: { kind: 'warn', large: true } },
      TODAY,
    );
    expect(answer.bucket).toBeNull();
    expect(keys(answer.lines)).not.toContain('answer.bucket.status');
    expect(keys(answer.lines)).not.toContain('answer.today.exclusionUnconfirmed');
    expect(answer.actions).toEqual([]);
  });

  it('still reports an exceeded bucket and unavailable states after the deletion', () => {
    const spending = outcome(`spending:${MONTH}`, 'spending', 'available', spendingValue({
      exceededBudgetActions: [{
        conditionCode: 'wants_budget_exceeded',
        bucket: 'wants',
        budgetMinor: 1,
        spentMinor: 2,
        excessMinor: 1,
        actionKey: 'a',
        actionLabel: 'a',
        correctiveAction: 'a',
      }],
    }));
    expect(lineOf(buildEntryAnswer(deleted({ spending }), ENTRY, TODAY).lines, 'answer.bucket.exceeded')?.money?.excess).toEqual(m(1));
    const failed = buildEntryAnswer(
      deleted({ plan: outcome<MonthlyPlanValue>(`monthly-plan:${MONTH}`, 'monthly_plan', 'calculation_failed', undefined, { retry: { action: 'recalculate', scopeKey: 's' } }) }),
      ENTRY,
      TODAY,
    );
    expect(failed.mode).toBe('removed');
    expect(failed.actions).toEqual([{ key: 'recalculate', scopeKey: 's' }]);
  });

  it('keeps an answer for another month separate from the Current_Month after undo', () => {
    const OTHER = '2025-02';
    const env = deleted({
      month: OTHER,
      plan: outcome(`monthly-plan:${OTHER}`, 'monthly_plan', 'available', planValue(), {}, OTHER),
      spending: outcome(`spending:${OTHER}`, 'spending', 'available', spendingValue({ month: OTHER }), {}, OTHER),
      today: todayOutcome('available', { applicable: false, reason: 'not_current_month' }, {}, OTHER),
    });
    const answer = buildEntryAnswer(env, ENTRY, TODAY);
    expect(answer.mode).toBe('removed');
    expect(answer.countsTowardCurrentMonth).toBe(false);
    expect(keys(answer.lines)).toContain('answer.month.countsTowardOther');
  });
});

describe('buildEntryAnswer: server values only', () => {
  function collectMinor(value: unknown, into: Set<number>): void {
    if (Array.isArray(value)) {
      value.forEach((item) => collectMinor(item, into));
    } else if (typeof value === 'object' && value !== null) {
      for (const [name, item] of Object.entries(value)) {
        if (typeof item === 'number' && /minor$/i.test(name)) into.add(item);
        else collectMinor(item, into);
      }
    }
  }

  it('references only integer paise that the response contains, across several states', () => {
    const over = todayValue({ leftToday: m(-7), overToday: m(7), todaySpent: m(307_007) });
    const negativePlan = outcome(`monthly-plan:${MONTH}`, 'monthly_plan', 'available', planValue({ remainingSpendable: m(-99) }));
    const envelopes = [
      envelope(),
      envelope({ today: todayOutcome('available', over), plan: negativePlan }),
      envelope({ today: null }),
      envelope({ operation: EXPENSE_DELETE_OPERATION, record: null }),
    ];
    for (const env of envelopes) {
      const present = new Set<number>();
      collectMinor(env, present);
      const answer = buildEntryAnswer(env, { ...ENTRY, warning: { kind: 'warn', large: true } }, TODAY);
      const used: number[] = [];
      for (const line of answer.lines) {
        for (const value of Object.values(line.money ?? {})) used.push(value.amountMinor);
      }
      if (answer.saved?.amount) used.push(answer.saved.amount.amountMinor);
      expect(used.length).toBeGreaterThan(0);
      for (const amountMinor of used) expect(present.has(amountMinor)).toBe(true);
    }
  });

  it('is pure: it does not modify a frozen response and returns equal models for equal input', () => {
    const deepFreeze = <T,>(value: T): T => {
      if (typeof value === 'object' && value !== null) {
        Object.values(value).forEach(deepFreeze);
        Object.freeze(value);
      }
      return value;
    };
    const env = deepFreeze(envelope());
    const entry = deepFreeze({ ...ENTRY });
    expect(buildEntryAnswer(env, entry, TODAY)).toEqual(buildEntryAnswer(env, entry, TODAY));
  });

  it('uses no money value when the record or a field is unusable', () => {
    const answer = buildEntryAnswer(envelope({ record: { id: EXPENSE_ID, category: 'Food', amountMinor: 'x', spentOn: TODAY } }), ENTRY, TODAY);
    expect(answer.saved?.amount).toBeNull();
    expect(answer.lines[0]?.money).toBeUndefined();
  });
});

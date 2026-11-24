import { QueryClient } from '@tanstack/react-query';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
} from '../../clarity/contracts';
import { DataUseGateProvider, PROMISE_RENDERED_KEY } from '../../clarity/DataUseGateProvider';
import { FinancialClarityProvider } from '../../clarity/FinancialClarityProvider';
import { MutationStatusProvider } from '../../clarity/MutationStatusProvider';
import { buildEntryAnswer, type AnswerEntryInput, type AnswerLine, type EntryAnswerModel } from '../../clarity/quickAdd/answer';
import { BUILT_IN_CATEGORIES } from '../../clarity/quickAdd/keywordRules';
import { resetServerTimeOffset } from '../../clarity/quickAdd/kolkata';
import { createMemoryClient, type MemoryClient } from '../../clarity/quickAdd/memoryClient';
import { parseQuickAddLine } from '../../clarity/quickAdd/parser';
import { QuickAddProvider } from '../../clarity/quickAdd/QuickAddProvider';
import {
  WAKING_UP_TEXT,
  createQuickAddStore,
  type QuickAddEntry,
  type QuickAddStore,
} from '../../clarity/quickAdd/quickAddStore';
import { SAVE_FAILED_TEXT } from '../../clarity/quickAdd/useQuickAddActions';
import { buildSettings } from '../../test/claritySettingsBuilder';
import { FakeQuickAddBackend } from '../../test/fakeQuickAddBackend';
import { installSpendingFetch, type SpendingFetch } from '../../test/fakeSpendingFetch';
import type { SpendingBackendReply, SpendingBackendRequest } from '../../test/fakeSpendingBackend';
import { axe, createTestQueryClient, renderAuthenticated } from '../../test/test-utils';
import { Announcer } from './Announcer';
import {
  ANSWER_MESSAGE_KEYS,
  ANSWER_MESSAGES,
  formatAnswerLine,
  summarizeAnswer,
} from './answerMessages';
import {
  ANSWER_TITLE,
  EXCLUDE_LABEL,
  EXPLANATION_TITLE,
  EntryAnswer,
  PAY_FORM_LABEL,
  RECALCULATE_FAILED_TEXT,
  RECALCULATE_LABEL,
  REMOVED_TITLE,
  TODAY_UNAVAILABLE_TEXT,
} from './EntryAnswer';
import { ImmediateAnswer } from './ImmediateAnswer';
import { hasQuickAddInput, registerQuickAddInput } from './inputFocus';
import { ParsedPreview, QuickAddDraftProvider, QuickAddInput } from './index';
import {
  ALREADY_REMOVED_ROW_TEXT,
  EDIT_FIRST_TEXT,
  EDIT_HELP_TEXT,
  ENTRIES_TITLE,
  FAILED_TEXT,
  MEMORY_FAILED_TEXT,
  NOTICE_REQUIRED_TEXT,
  NOT_COUNTED_TEXT,
  PENDING_TEXT,
  QuickAddEntries,
  EntryStatusList,
  SAVED_TEXT,
  UNDONE_TEXT,
  UNDO_FAILED_STATUS_TEXT,
} from './QuickAddEntries';
import { UNDO_AVAILABLE_TEXT, UNDO_STILL_SAVED_TEXT } from './UndoControl';
import { UndoToast } from './UndoToast';

const MONTH = '2026-11';
const TODAY = '2026-11-18';
const NOW = Date.parse('2026-11-18T06:30:00.000Z');
const EXPENSES = '/finance/expenses';
const MEMORY = '/finance/category-memory';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const cssFiles = ['quickAdd.css', 'quickAddEntries.css'].map((name) => readFileSync(`src/components/quickAdd/${name}`, 'utf8'));
const entriesCss = cssFiles[1] ?? '';

/* ------------------------------ answer fixtures ----------------------------- */

const m = (amountMinor: number): MoneyValue => ({ currency: 'INR', amountMinor });
const period = (month = MONTH) => ({ month, start: `${month}-01`, endExclusive: `${month}-31`, timeZone: 'Asia/Kolkata' as const });
const EXPENSE_ID = 41;

function planValue(overrides: Partial<MonthlyPlanValue> = {}): MonthlyPlanValue {
  return {
    salary: m(10_000_000), activeBillsTotal: m(3_000_000), shortfall: m(0), disposableIncome: m(7_000_000),
    needsBudget: m(3_500_000), wantsBudget: m(2_100_000), savingsTarget: m(1_400_000), spendableBudget: m(5_600_000),
    needsSpent: m(500_000), wantsSpent: m(100_000), remainingSpendable: m(5_000_000), dailySpendingGuide: m(300_000),
    projectedSavings: m(1_400_000), ...overrides,
  };
}

function spendingValue(overrides: Partial<SpendingOutcomeValue> = {}): SpendingOutcomeValue {
  return {
    month: MONTH, categoryTotals: [],
    appliedTreatments: [{ expenseId: EXPENSE_ID, category: 'Food', treatment: 'wants', source: 'default' }],
    needsBudget: m(3_500_000), wantsBudget: m(2_100_000), needsSpent: m(500_000), wantsSpent: m(100_000),
    totalSpending: m(600_000), spendableBudget: m(5_600_000), remainingSpendable: m(5_000_000), dailySpendingGuide: m(300_000),
    savingsTarget: m(1_400_000), projectedSavings: m(1_400_000), projectedSavingsDifference: m(0), exceededBudgetActions: [],
    ...overrides,
  };
}

type ApplicableToday = Extract<TodayAllowanceValue, { applicable: true }>;

function todayValue(overrides: Partial<ApplicableToday> = {}): ApplicableToday {
  return {
    applicable: true, date: TODAY, daysRemainingInclusive: 13, todayAllowance: m(300_000), todaySpent: m(45_000),
    leftToday: m(255_000), overToday: m(0), allowanceBasis: m(5_300_000), usedPermille: 150, zeroReason: null,
    usedBeyondBudget: m(0), excludedToday: { count: 0, total: m(0) }, largeEntryThreshold: m(1_400_000), ...overrides,
  };
}

function outcome<T>(
  id: string, kind: Outcome<T>['kind'], status: OutcomeStatus, value: T | undefined,
  extra: Partial<Outcome<T>> = {}, month = MONTH,
): Outcome<T> {
  return {
    id, kind, status, classification: 'calculated_result', period: period(month), dataVersion: 7,
    ...(value === undefined ? {} : { value }), sourceRefs: [], ...extra,
  };
}

function todayOutcome(status: OutcomeStatus, value: TodayAllowanceValue | undefined, extra: Partial<Outcome<TodayAllowanceValue>> = {}): TodayAllowanceOutcome {
  return {
    ...outcome<TodayAllowanceValue>(`today-allowance:${MONTH}`, 'monthly_plan', status, value, extra),
    kind: 'today_allowance',
    explanationRef: { outcomeId: `today-allowance:${MONTH}`, dataVersion: 7 },
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

const RECORD = {
  id: EXPENSE_ID, month: MONTH, category: 'Food', amountMinor: 45_000, note: 'swiggy', spentOn: TODAY,
  excludeFromDailyAllowance: false,
};

function envelope(options: EnvelopeOptions = {}): MutationEnvelope {
  const month = options.month ?? MONTH;
  const outcomes: FinancialSnapshot['outcomes'] = {
    monthlyPlan: options.plan ?? outcome(`monthly-plan:${month}`, 'monthly_plan', 'available', planValue(), {}, month),
    spending: options.spending ?? outcome(`spending:${month}`, 'spending', 'available', spendingValue(), {}, month),
    goals: [],
    tripSummary: outcome('trip-summary', 'trip_summary', 'available', []),
    ...(options.today === null ? {} : { todayAllowance: options.today ?? todayOutcome('available', todayValue()) }),
  };
  return {
    schemaVersion: 1,
    mutation: {
      changeId: 5, idempotencyKey: 'k', scopeKey: `expense:${EXPENSE_ID}`, operation: options.operation ?? 'expense.create',
      recordType: 'expense', recordId: EXPENSE_ID, status: 'confirmed', recordVersion: 1,
      record: options.record === undefined ? { ...RECORD, month } : options.record,
    },
    clarity: {
      dataVersion: options.dataVersion ?? 12, currency: 'INR', precisionMinor: 1,
      period: { month, timeZone: 'Asia/Kolkata', start: `${month}-01`, endExclusive: `${month}-31`, asOfDate: TODAY, daysRemainingInclusive: 13 },
      facts: [], outcomes, actions: [],
    },
  };
}

const ENTRY: AnswerEntryInput = { category: 'Food', spentOn: TODAY, note: 'swiggy', exclusionRequested: false };
const answerOf = (options: EnvelopeOptions = {}, entry: AnswerEntryInput = ENTRY) => buildEntryAnswer(envelope(options), entry, TODAY);

function renderAnswer(answer: EntryAnswerModel, props: Partial<Parameters<typeof EntryAnswer>[0]> = {}) {
  vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'true');
  vi.stubEnv('VITE_QUICK_ADD_ENABLED', 'true');
  return renderAuthenticated(<EntryAnswer answer={answer} {...props} />);
}

/* --------------------------------- harness ---------------------------------- */

class UiBackend extends FakeQuickAddBackend {
  noticeAcknowledged = true;

  override handle(request: SpendingBackendRequest): SpendingBackendReply {
    if (request.method.toUpperCase() === 'GET' && request.path === '/finance/categories') {
      return { status: 200, body: { defaults: [...BUILT_IN_CATEGORIES], custom: [] } };
    }
    if (request.method.toUpperCase() === 'GET' && request.path === '/clarity/settings') {
      return { status: 200, body: buildSettings({ acknowledgedVersion: this.noticeAcknowledged ? 1 : 0 }) };
    }
    return super.handle(request);
  }
}

interface Harness {
  user: ReturnType<typeof userEvent.setup>;
  backend: UiBackend;
  net: SpendingFetch;
  store: QuickAddStore;
  memory: MemoryClient;
  container: HTMLElement;
  input(): HTMLInputElement;
  setLine(line: string): void;
  rows(): HTMLElement[];
  requests(): string[];
  /** Adds an entry to the store without a request, as a settled earlier session would hold it. */
  seed(cid: string, line: string, phases?: Array<'failed' | 'confirmed'>, expenseId?: number): void;
}

interface MountOptions {
  enabled?: boolean;
  children?: ReactNode;
  prepare?(backend: UiBackend, net: SpendingFetch): void;
  today?: string | null;
  gate?: 'required';
}

const memoryClients: MemoryClient[] = [];

const DEFAULT_CHILDREN = (
  <>
    <QuickAddInput />
    <ParsedPreview />
    <QuickAddEntries />
    <ImmediateAnswer />
    <Announcer />
  </>
);

function mount(options: MountOptions = {}): Harness {
  const enabled = options.enabled ?? true;
  vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', enabled ? 'true' : 'false');
  vi.stubEnv('VITE_QUICK_ADD_ENABLED', enabled ? 'true' : 'false');
  const backend = new UiBackend(MONTH, { categories: [...BUILT_IN_CATEGORIES] });
  backend.todayDate = options.today === undefined ? TODAY : options.today;
  backend.noticeAcknowledged = options.gate !== 'required';
  const net = installSpendingFetch(backend);
  options.prepare?.(backend, net);
  const memory = createMemoryClient({ queryClient: new QueryClient(), isEnabled: () => enabled });
  memoryClients.push(memory);
  const store = createQuickAddStore();

  const inner = (
    <QuickAddProvider store={store}>
      <QuickAddDraftProvider memory={memory}>{options.children ?? DEFAULT_CHILDREN}</QuickAddDraftProvider>
    </QuickAddProvider>
  );
  const view = renderAuthenticated(
    <FinancialClarityProvider>
      <MutationStatusProvider>
        {options.gate ? <DataUseGateProvider enabled>{inner}</DataUseGateProvider> : inner}
      </MutationStatusProvider>
    </FinancialClarityProvider>,
    { queryClient: createTestQueryClient() },
  );

  return {
    user: userEvent.setup(),
    backend,
    net,
    store,
    memory,
    container: view.container,
    input: () => screen.getByLabelText('Add an expense') as HTMLInputElement,
    setLine(line) {
      act(() => {
        store.dispatch({ type: 'line/set', line });
      });
    },
    rows: () => [...view.container.querySelectorAll<HTMLElement>('.qa-entry')],
    requests: () => net.calls.map((call) => `${call.method} ${call.path}`),
    seed(cid, line, phases = [], expenseId = 70) {
      const parsed = parseQuickAddLine(line, TODAY);
      if (!parsed.ok) throw new Error(`Cannot seed ${line}`);
      act(() => {
        store.dispatch({
          type: 'entry/submit',
          entry: { cid, parsed: parsed.entry, suggestion: { category: 'Food', source: 'keyword', reason: 'test' }, category: 'Food' },
        });
        for (const phase of phases) {
          if (phase === 'failed') {
            store.dispatch({ type: 'entry/failed', cid, error: { message: 'The server had a problem.', retryable: true } });
          } else {
            store.dispatch({ type: 'entry/confirmed', cid, expenseId });
          }
        }
      });
    },
  };
}

beforeEach(() => {
  vi.setSystemTime(NOW);
});

afterEach(() => {
  resetServerTimeOffset();
  document.documentElement.removeAttribute('data-theme');
  for (const client of memoryClients.splice(0)) client.dispose();
});

const rowOf = (h: Harness, text: string | RegExp) => {
  const row = h.rows().find((candidate) => (typeof text === 'string' ? candidate.textContent?.includes(text) : text.test(candidate.textContent ?? '')));
  if (!row) throw new Error(`No row with ${String(text)}`);
  return row;
};

/** Saves one line through the real input and waits for one more entry to be saved. */
async function save(h: Harness, line: string) {
  const saved = () => h.store.getState().entries.filter((entry) => entry.phase === 'saved').length;
  const before = saved();
  h.setLine(line);
  await h.user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(saved()).toBe(before + 1));
}

/* ------------------------------ message catalogue --------------------------- */

describe('answer message catalogue', () => {
  it('has copy for every message key that answer.ts can produce', () => {
    const source = readFileSync('src/clarity/quickAdd/answer.ts', 'utf8');
    const union = /export type AnswerMessageKey =([\s\S]*?);\n/.exec(source)?.[1] ?? '';
    const declared = [...union.matchAll(/'(answer\.[A-Za-z.]+)'/g)].map((match) => match[1] as string);
    expect(declared.length).toBeGreaterThan(15);
    expect([...ANSWER_MESSAGE_KEYS].sort()).toEqual([...new Set(declared)].sort());
    // A key that the builder emits as a literal is also in the catalogue.
    const emitted = [...source.matchAll(/key: '(answer\.[A-Za-z.]+)'/g)].map((match) => match[1] as string);
    for (const key of emitted) expect(ANSWER_MESSAGE_KEYS, key).toContain(key);
  });

  it('gives a plain sentence for each key, with no raw key, placeholder, or NaN in it', () => {
    const money = { amount: m(12_000), todaySpent: m(45_000), todayAllowance: m(300_000), leftToday: m(255_000), overToday: m(5_000),
      usedBeyondBudget: m(7_000), spent: m(100_000), budget: m(2_100_000), excess: m(2_500), remainingSpendable: m(-9_900) };
    const params = { category: 'Food', note: 'swiggy', date: TODAY, relation: 'past', reason: 'month_budget_used', bucket: 'needs', source: 'override',
      month: MONTH, currentMonth: '2026-12', input: 'salary', constraint: 'a positive amount', affects: ['monthly_plan', 'today_allowance'] };
    for (const key of ANSWER_MESSAGE_KEYS) {
      const copy = formatAnswerLine({ key, money, params });
      expect(copy.length, key).toBeGreaterThan(8);
      expect(copy, key).not.toMatch(/answer\.|undefined|NaN|\[object|\{\w+\}/);
      expect(copy.endsWith('.'), key).toBe(true);
    }
  });

  it('formats money from the server paise with the shared Indian-grouping formatter', () => {
    const line = (key: AnswerLine['key'], money: AnswerLine['money'], params?: AnswerLine['params']): AnswerLine => ({ key, money, params });
    expect(formatAnswerLine(line('answer.today.left', { leftToday: m(255_000) }))).toBe('₹2,550 left today.');
    expect(formatAnswerLine(line('answer.today.over', { overToday: m(150_050) }))).toBe("Over today's allowance by ₹1,500.50.");
    expect(formatAnswerLine(line('answer.bucket.exceeded', { excess: m(12_345_600) }, { bucket: 'wants' }))).toBe('Wants budget exceeded by ₹1,23,456.');
    expect(formatAnswerLine(line('answer.month.overBudget', { remainingSpendable: m(-250_000) }, { month: MONTH })))
      .toBe("Over November 2026's spendable budget by ₹2,500.");
  });

  it('names the bucket and says when the User set the treatment', () => {
    const base: AnswerLine = { key: 'answer.bucket.status', money: { spent: m(100_000), budget: m(2_100_000) }, params: { bucket: 'wants', source: 'default' } };
    expect(formatAnswerLine(base)).toBe('Counts toward your Wants budget: ₹1,000 spent of ₹21,000.');
    expect(formatAnswerLine({ ...base, params: { bucket: 'needs', source: 'override' } })).toContain('Needs budget (set by you)');
  });

  it('summarizes an earlier entry in one line, and says nothing for a removed entry', () => {
    expect(summarizeAnswer(answerOf())).toBe('₹2,550 left today.');
    expect(summarizeAnswer(answerOf({ today: todayOutcome('available', todayValue({ leftToday: m(-1), overToday: m(1) })) })))
      .toBe("Over today's allowance by ₹0.01.");
    expect(summarizeAnswer(answerOf({ month: '2026-12' }, { ...ENTRY, spentOn: '2026-12-05' }))).toContain('counts toward December 2026');
    expect(summarizeAnswer(answerOf({ operation: 'expense.delete', record: null }))).toBeNull();
    expect(summarizeAnswer(undefined)).toBeNull();
    expect(Object.keys(ANSWER_MESSAGES)).toHaveLength(ANSWER_MESSAGE_KEYS.length);
  });
});

/* ------------------------------- EntryAnswer -------------------------------- */

describe('EntryAnswer: every row of the answer table', () => {
  const text = () => document.querySelector('.qa-answer')?.textContent ?? '';

  it('current month, plan available: saved entry, spent of allowance, left today, bucket, and the calculated-result label', () => {
    renderAnswer(answerOf());
    expect(screen.getByRole('heading', { name: ANSWER_TITLE })).toBeInTheDocument();
    expect(text()).toContain('Saved ₹450 to Food: swiggy.');
    expect(text()).toContain("Spent today: ₹450 of today's allowance of ₹3,000.");
    expect(text()).toContain('₹2,550 left today.');
    expect(text()).toContain('Counts toward your Wants budget: ₹1,000 spent of ₹21,000.');
    // Requirement 9.17: the entered amount is an entered fact and the rest are calculated results, in text.
    expect(within(screen.getByRole('region', { name: ANSWER_TITLE })).getByText('Entered fact')).toBeInTheDocument();
    expect(screen.getAllByText('Calculated result').length).toBeGreaterThan(0);
    expect(document.querySelectorAll('.qa-answer-line [data-classification="calculated_result"]').length).toBeGreaterThan(2);
    expect(text()).not.toContain('Over today');
    expect(screen.queryByRole('button', { name: RECALCULATE_LABEL })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: EXCLUDE_LABEL })).not.toBeInTheDocument();
  });

  it('states the entry date when it is not today', () => {
    const past = answerOf(
      { record: { ...RECORD, spentOn: '2026-11-10' } },
      { ...ENTRY, spentOn: '2026-11-10' },
    );
    renderAnswer(past);
    expect(text()).toContain('Dated Tuesday, 10 November 2026, not today.');
    cleanup();
    renderAnswer(answerOf({ record: { ...RECORD, spentOn: '2026-11-20' } }, { ...ENTRY, spentOn: '2026-11-20' }));
    expect(text()).toContain('Dated Friday, 20 November 2026, a future date.');
  });

  it('over today: shows the server amount over and offers the exclusion action for that entry', async () => {
    const onExclude = vi.fn().mockResolvedValue({ status: 'confirmed', cid: 'a' });
    const over = todayValue({ todaySpent: m(450_000), leftToday: m(-150_000), overToday: m(150_000), usedPermille: 1000 });
    renderAnswer(answerOf({ today: todayOutcome('available', over) }), { onExclude });
    expect(text()).toContain("Over today's allowance by ₹1,500.");
    expect(text()).not.toContain('left today');
    expect(text()).toContain("It put you over today's allowance.");
    await userEvent.setup().click(screen.getByRole('button', { name: EXCLUDE_LABEL }));
    expect(onExclude).toHaveBeenCalledWith(EXPENSE_ID);
  });

  it('exceeded bucket budget and a negative remaining spendable are stated as amounts over', () => {
    const spending = outcome(`spending:${MONTH}`, 'spending', 'available', spendingValue({
      exceededBudgetActions: [{ bucket: 'wants', excessMinor: 250_000 } as SpendingOutcomeValue['exceededBudgetActions'][number]],
      remainingSpendable: m(-120_000),
    }));
    const plan = outcome(`monthly-plan:${MONTH}`, 'monthly_plan', 'available', planValue({ remainingSpendable: m(-120_000) }));
    renderAnswer(answerOf({ spending, plan }));
    expect(text()).toContain('Wants budget exceeded by ₹2,500.');
    expect(text()).toContain("Over November 2026's spendable budget by ₹1,200.");
  });

  it('saved with the exclusion: not counted today, the month includes it, and the allowance after the save', () => {
    const record = { ...RECORD, excludeFromDailyAllowance: true };
    renderAnswer(answerOf({ record }, { ...ENTRY, exclusionRequested: true }));
    expect(text()).toContain("Not counted against today's allowance.");
    expect(text()).toContain("Your month's totals include it.");
    expect(text()).toContain("Today's allowance after this save: ₹3,000.");
    expect(text()).toContain("It changed because this entry uses part of the month's budget.");
    expect(screen.queryByRole('button', { name: EXCLUDE_LABEL })).not.toBeInTheDocument();
  });

  it('exclusion requested but not confirmed: says it was counted and offers the action again', () => {
    renderAnswer(answerOf({}, { ...ENTRY, exclusionRequested: true }));
    expect(text()).toContain('Saved and counted against today. The server did not confirm the exclusion.');
    expect(screen.getByRole('button', { name: EXCLUDE_LABEL })).toBeInTheDocument();
    expect(text()).toContain('The server did not confirm the exclusion you asked for.');
  });

  it('other month: names the month, shows remaining spendable and the bucket, and shows no Today values', () => {
    renderAnswer(answerOf({ month: '2026-12', record: { ...RECORD, month: '2026-12', spentOn: '2026-12-05' } }, { ...ENTRY, spentOn: '2026-12-05' }));
    expect(text()).toContain('This entry counts toward December 2026, not November 2026. Your numbers for November 2026 are unchanged.');
    expect(text()).toContain('Remaining spendable for December 2026: ₹50,000.');
    expect(text()).toContain('Counts toward your Wants budget');
    expect(text()).not.toContain('left today');
    expect(text()).not.toContain('Spent today');
    expect(document.querySelector('.qa-answer')).toHaveAttribute('data-scope', 'other_month');
    expect(screen.queryByRole('button', { name: /How this was calculated/ })).not.toBeInTheDocument();
  });

  it('missing pay: confirms the save, names the month and the pay, and links to the Plan pay form', () => {
    const plan = outcome<MonthlyPlanValue>(`monthly-plan:${MONTH}`, 'monthly_plan', 'missing_input', undefined, { missing: [{ input: 'salary', unlocks: ['monthly_plan'] }] });
    renderAnswer(answerOf({ plan }));
    expect(text()).toContain('Saved ₹450 to Food: swiggy.');
    expect(text()).toContain('Saved. Add the pay for November 2026 to see what this entry changes.');
    const link = screen.getByRole('link', { name: new RegExp(PAY_FORM_LABEL) });
    expect(link.getAttribute('href')).toMatch(/^\/plan/);
    expect(link.getAttribute('href')).toContain('pay-form');
  });

  it('invalid plan input: names the input, the accepted constraint, and the affected outcomes', () => {
    const plan = outcome<MonthlyPlanValue>(`monthly-plan:${MONTH}`, 'monthly_plan', 'invalid_input', undefined, {
      invalid: [{ input: 'salary', constraint: 'a whole number of paise above zero', affects: ['monthly_plan', 'spending'] }],
    });
    renderAnswer(answerOf({ plan }));
    expect(text()).toContain('Saved. Salary for November 2026 is not valid. It must be: a whole number of paise above zero.');
    expect(text()).toContain('This affects your monthly plan and spending guidance.');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('calculation failed: confirms the save, marks the effect unavailable, and offers one Recalculate that resubmits nothing', async () => {
    const spending = outcome<SpendingOutcomeValue>(`spending:${MONTH}`, 'spending', 'calculation_failed', undefined, { retry: { action: 'recalculate', scopeKey: `outcome:spending:${MONTH}` } });
    const onRecalculate = vi.fn().mockResolvedValue({ status: 'failed' });
    renderAnswer(answerOf({ spending }), { onRecalculate });
    expect(text()).toContain('Saved ₹450 to Food: swiggy.');
    expect(text()).toContain('Saved. What this entry changes for November 2026 is temporarily unavailable.');
    expect(screen.getAllByRole('button', { name: RECALCULATE_LABEL })).toHaveLength(1);
    await userEvent.setup().click(screen.getByRole('button', { name: RECALCULATE_LABEL }));
    expect(onRecalculate).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(RECALCULATE_FAILED_TEXT)).toHaveAttribute('role', 'status');
    expect(screen.getByRole('button', { name: RECALCULATE_LABEL })).toBeInTheDocument();
  });

  it('server without the Today fields: the monthly answer stands alone, with no Today lines and no unavailable notice', () => {
    renderAnswer(answerOf({ today: null }));
    expect(document.querySelector('.qa-answer')).toHaveAttribute('data-today', 'not_provided');
    expect(text()).toContain('Saved ₹450 to Food: swiggy.');
    expect(text()).toContain('Counts toward your Wants budget');
    expect(text()).not.toContain('left today');
    expect(text()).not.toContain(TODAY_UNAVAILABLE_TEXT);
  });

  it('Today values that are not for today: says Today is unavailable and keeps the monthly answer', () => {
    renderAnswer(answerOf({ today: todayOutcome('available', todayValue({ date: '2026-11-17' })) }));
    expect(document.querySelector('.qa-answer')).toHaveAttribute('data-today', 'unavailable');
    expect(text()).toContain(TODAY_UNAVAILABLE_TEXT);
    expect(text()).toContain('Counts toward your Wants budget');
  });

  it('after Undo: is titled Entry removed and shows the values after the deletion', () => {
    renderAnswer(answerOf({ operation: 'expense.delete', record: null, spending: outcome(`spending:${MONTH}`, 'spending', 'available', spendingValue({ appliedTreatments: [] })) }));
    expect(screen.getByRole('heading', { name: REMOVED_TITLE })).toBeInTheDocument();
    expect(text()).toContain('The Food entry was removed. These are the values after the deletion.');
    expect(text()).toContain('₹2,550 left today.');
    expect(text()).not.toContain('Saved ₹');
  });

  it('renders a note with markup as plain text', () => {
    renderAnswer(answerOf({ record: { ...RECORD, note: '<img src=x onerror=alert(1)><b>x</b>' } }));
    expect(document.querySelector('.qa-answer img, .qa-answer b')).toBeNull();
    expect(text()).toContain('<img src=x onerror=alert(1)><b>x</b>');
  });

  it('renders nothing while the flag is off', () => {
    vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'true');
    vi.stubEnv('VITE_QUICK_ADD_ENABLED', 'false');
    const { container } = renderAuthenticated(<EntryAnswer answer={answerOf()} />);
    expect(container.textContent).toBe('');
  });
});

describe('EntryAnswer: explanation control', () => {
  it('offers "How this was calculated" for the Today values, opens a labelled panel, and closes it with Escape', async () => {
    const user = userEvent.setup();
    renderAnswer(answerOf());
    const toggle = screen.getByRole('button', { name: `How this was calculated for ${EXPLANATION_TITLE}` });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByRole('group', { name: `How ${EXPLANATION_TITLE} was calculated` })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveFocus();
  });

  it('is not offered without a session, and not when no Today value is shown', () => {
    renderAnswer(answerOf({ today: null }));
    expect(screen.queryByRole('button', { name: /How this was calculated/ })).not.toBeInTheDocument();
    cleanup();
    renderAnswer(answerOf(), { ownerData: false });
    expect(screen.queryByRole('button', { name: /How this was calculated/ })).not.toBeInTheDocument();
  });

  it('keeps an open explanation open when the answer is replaced by a newer one', async () => {
    const user = userEvent.setup();
    const view = renderAnswer(answerOf());
    await user.click(screen.getByRole('button', { name: /How this was calculated/ }));
    const newer = answerOf({ dataVersion: 13, today: todayOutcome('available', todayValue({ leftToday: m(100_000) }), { dataVersion: 13, explanationRef: { outcomeId: `today-allowance:${MONTH}`, dataVersion: 13 } }) });
    view.rerender(<EntryAnswer answer={newer} />);
    expect(screen.getByRole('button', { name: /How this was calculated/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('₹1,000 left today.')).toBeInTheDocument();
  });
});

/* --------------------------------- flag off --------------------------------- */

describe('flag off', () => {
  it('renders nothing and sends no request, and needs no provider', () => {
    vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'true');
    vi.stubEnv('VITE_QUICK_ADD_ENABLED', 'false');
    const { container } = renderAuthenticated(
      <QuickAddDraftProvider>
        <QuickAddEntries />
        <EntryStatusList />
        <ImmediateAnswer />
        <UndoToast />
        <Announcer />
      </QuickAddDraftProvider>,
    );
    expect(container.textContent).toBe('');
    // The test harness adds its own toast region, so only Quick Add's elements are checked.
    expect(container.querySelector('[class*="qa-"], [data-testid^="quick-add"], [role="alert"], button')).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

/* ------------------------------- status rows -------------------------------- */

describe('entry status rows', () => {
  it('shows a pending row with the amount, category, date, and note at once, and confines it to that row', async () => {
    const h = mount({ prepare: (_backend, net) => { net.hold('POST', EXPENSES); } });
    h.setLine('120 coffee');
    await h.user.click(screen.getByRole('button', { name: 'Save' }));
    const row = h.rows()[0] as HTMLElement;
    // No await between the click and the row: it is on screen in the same step (Requirement 7.2).
    expect(row).toHaveAttribute('data-phase', 'pending');
    expect(row).toHaveTextContent('₹120');
    expect(row).toHaveTextContent('Food');
    expect(row).toHaveTextContent('Wednesday, 18 November 2026');
    expect(row).toHaveTextContent('coffee');
    expect(row).toHaveTextContent(PENDING_TEXT);
    expect(row.querySelector('[aria-live], [role="status"], [role="alert"]')).toBeNull();
    expect(within(row).queryByRole('button')).not.toBeInTheDocument();
    // Unrelated controls stay available and the input is ready for the next entry.
    expect(h.input()).toHaveValue('');
    expect(h.input()).toHaveFocus();
    expect(screen.getByRole('heading', { name: ENTRIES_TITLE })).toBeInTheDocument();
  });

  it('gives each pending entry its own row and status', async () => {
    const h = mount({ prepare: (_backend, net) => { for (let i = 0; i < 3; i += 1) net.hold('POST', EXPENSES); } });
    for (const line of ['10 tea', '20 chai', '30 lunch']) {
      h.setLine(line);
      await h.user.click(screen.getByRole('button', { name: 'Save' }));
    }
    const rows = h.rows();
    expect(rows).toHaveLength(3);
    // Newest first, so the entry just typed is next to the input.
    expect(rows.map((row) => row.querySelector('.qa-note-text')?.textContent?.trim())).toEqual(['lunch', 'chai', 'tea']);
    for (const row of rows) expect(row).toHaveTextContent(PENDING_TEXT);
    expect(new Set(rows.map((row) => row.getAttribute('data-cid'))).size).toBe(3);
  });

  it('says the free server may be waking up after 5 seconds and does not send the entry again', async () => {
    const h = mount({ prepare: (_backend, net) => { net.hold('POST', EXPENSES); } });
    h.setLine('120 coffee');
    await h.user.click(screen.getByRole('button', { name: 'Save' }));
    const entry = h.store.getState().entries[0] as QuickAddEntry;
    expect(screen.queryByText(WAKING_UP_TEXT)).not.toBeInTheDocument();
    act(() => {
      h.store.dispatch({ type: 'entry/waking', cid: entry.cid, at: entry.pendingSince + 5000 });
    });
    expect(screen.getByText(WAKING_UP_TEXT)).toBeInTheDocument();
    expect(h.net.to('POST', EXPENSES)).toHaveLength(1);
  });

  it('shows a saved row with its status, the one-line answer for earlier entries, and the current answer once', async () => {
    const h = mount();
    await save(h, '120 coffee');
    await save(h, '450 swiggy');
    await waitFor(() => expect(h.rows()).toHaveLength(2));
    const [newest, earlier] = h.rows() as [HTMLElement, HTMLElement];
    expect(newest).toHaveTextContent('swiggy');
    for (const row of [newest, earlier]) expect(row).toHaveTextContent(SAVED_TEXT);
    // Requirement 9.16: a one-line status on the earlier row, the full answer for the latest entry only.
    expect(earlier.querySelector('.qa-entry-oneline')?.textContent).toMatch(/left today\./);
    expect(newest.querySelector('.qa-entry-oneline')).toBeNull();
    expect(screen.getAllByRole('region', { name: ANSWER_TITLE })).toHaveLength(1);
    expect(screen.getByRole('region', { name: ANSWER_TITLE })).toHaveTextContent('Saved ₹450 to Food: swiggy.');
  });
});

describe('failed entries', () => {
  async function fail(h: Harness, line = '120 coffee') {
    h.setLine(line);
    await h.user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(h.rows()[0]).toHaveAttribute('data-phase', 'failed'));
    return h.rows()[0] as HTMLElement;
  }

  it('shows the reason with Retry, Edit, and Discard for a server error, and keeps the entry values', async () => {
    const h = mount({ prepare: (backend) => backend.failWith('POST', EXPENSES, { status: 500, code: 'INTERNAL_ERROR', message: 'The server had a problem.' }) });
    const row = await fail(h);
    expect(row).toHaveTextContent(FAILED_TEXT);
    expect(row).toHaveTextContent('The server had a problem.');
    expect(row).toHaveTextContent('₹120');
    expect(row).toHaveTextContent('coffee');
    expect(within(row).getByRole('button', { name: 'Retry saving ₹120 coffee' })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Edit ₹120 coffee' })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Discard ₹120 coffee' })).toBeInTheDocument();
    expect(h.backend.expenses).toHaveLength(0);
  });

  it('Retry resends with the same Idempotency-Key and ends with exactly one expense', async () => {
    const h = mount({ prepare: (backend) => backend.failWith('POST', EXPENSES, { status: 503, code: 'UNAVAILABLE', message: 'Try again.' }) });
    const row = await fail(h);
    await h.user.click(within(row).getByRole('button', { name: /^Retry saving/ }));
    await waitFor(() => expect(h.rows()[0]).toHaveAttribute('data-phase', 'saved'));
    const posts = h.net.to('POST', EXPENSES);
    expect(posts).toHaveLength(2);
    expect(posts[1]?.headers['idempotency-key']).toMatch(UUID);
    expect(posts[1]?.headers['idempotency-key']).toBe(posts[0]?.headers['idempotency-key']);
    expect(h.backend.expenses).toHaveLength(1);
    expect(h.rows()).toHaveLength(1);
  });

  it('moves focus to the row when Retry is pressed, so it is not lost', async () => {
    const h = mount({ prepare: (backend) => backend.failWith('POST', EXPENSES, { status: 500, code: 'INTERNAL_ERROR' }) });
    const row = await fail(h);
    const gate = h.net.hold('POST', EXPENSES);
    await h.user.click(within(row).getByRole('button', { name: /^Retry saving/ }));
    expect(h.rows()[0]).toHaveAttribute('data-phase', 'pending');
    expect(h.rows()[0]).toHaveFocus();
    act(() => gate.release());
    await waitFor(() => expect(h.rows()[0]).toHaveAttribute('data-phase', 'saved'));
  });

  it('explains a data-use notice failure and keeps the entry for a retry after the notice is reviewed', async () => {
    const h = mount({ prepare: (backend) => backend.failWith('POST', EXPENSES, { status: 428, code: 'DATA_NOTICE_REQUIRED', message: 'Acknowledge the notice first.' }) });
    const row = await fail(h);
    expect(row).toHaveTextContent(NOTICE_REQUIRED_TEXT);
    expect(within(row).getByRole('button', { name: /^Retry saving/ })).toBeEnabled();
  });

  it('offers no Retry for a validation failure, names the field, and points to Edit', async () => {
    const h = mount({
      prepare: (backend) => backend.failWith('POST', EXPENSES, {
        status: 422, code: 'VALIDATION_ERROR', field: 'amountMinor', message: 'The amount is too large.', constraint: { maxMinor: 100 },
      }),
    });
    const row = await fail(h);
    expect(row).toHaveTextContent('Amount: The amount is too large.');
    expect(row).toHaveTextContent(EDIT_HELP_TEXT);
    expect(within(row).queryByRole('button', { name: /^Retry/ })).not.toBeInTheDocument();
    expect(within(row).getByRole('button', { name: /^Edit/ })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: /^Discard/ })).toBeInTheDocument();
  });

  it('Edit puts the formatted line in the empty input, removes the row, and focuses the input; the next save is a new key', async () => {
    const h = mount({ prepare: (backend) => backend.failWith('POST', EXPENSES, { status: 500, code: 'INTERNAL_ERROR' }) });
    const row = await fail(h);
    const firstKey = h.net.to('POST', EXPENSES)[0]?.headers['idempotency-key'];
    await h.user.click(within(row).getByRole('button', { name: /^Edit/ }));
    expect(h.input()).toHaveValue(`₹120 ${TODAY} "coffee"`);
    expect(h.input()).toHaveFocus();
    expect(h.rows()).toHaveLength(0);
    await h.user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(h.backend.expenses).toHaveLength(1));
    expect(h.net.to('POST', EXPENSES)[1]?.headers['idempotency-key']).not.toBe(firstKey);
  });

  it('keeps the row and says why when Edit is chosen while the input has text', async () => {
    const h = mount({ prepare: (backend) => backend.failWith('POST', EXPENSES, { status: 500, code: 'INTERNAL_ERROR' }) });
    const row = await fail(h);
    h.setLine('50 tea');
    await h.user.click(within(row).getByRole('button', { name: /^Edit/ }));
    expect(await within(row).findByText(EDIT_FIRST_TEXT)).toHaveAttribute('role', 'status');
    expect(h.rows()).toHaveLength(1);
    expect(h.input()).toHaveValue('50 tea');
  });

  it('Discard removes only the row, changes no record, and moves focus to the next row, then to the input', async () => {
    const h = mount({ children: <><QuickAddInput /><QuickAddEntries /></> });
    h.seed('a', '10 tea', ['failed']);
    h.seed('b', '20 chai', ['failed']);
    const [newest, older] = h.rows() as [HTMLElement, HTMLElement];
    expect(newest).toHaveAttribute('data-cid', 'b');
    await h.user.click(within(newest).getByRole('button', { name: /^Discard/ }));
    expect(h.rows()).toHaveLength(1);
    expect(older.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(within(older).getByRole('button', { name: /^Retry saving/ }));
    await h.user.click(within(older).getByRole('button', { name: /^Discard/ }));
    expect(h.rows()).toHaveLength(0);
    expect(h.input()).toHaveFocus();
    expect(h.backend.expenses).toHaveLength(0);
    expect(h.net.to('DELETE', EXPENSES)).toHaveLength(0);
  });

  it('has Retry, Edit, and Discard reachable and operable by keyboard alone', async () => {
    const h = mount({ prepare: (backend) => backend.failWith('POST', EXPENSES, { status: 500, code: 'INTERNAL_ERROR' }) });
    await fail(h);
    h.input().focus();
    await h.user.tab();
    expect(screen.getByRole('button', { name: /^Retry saving/ })).toHaveFocus();
    await h.user.tab();
    expect(screen.getByRole('button', { name: /^Edit/ })).toHaveFocus();
    await h.user.tab();
    expect(screen.getByRole('button', { name: /^Discard/ })).toHaveFocus();
    await h.user.keyboard('{Enter}');
    expect(h.rows()).toHaveLength(0);
    expect(h.input()).toHaveFocus();
  });

  it('disables Retry with the pause reason while the Data_Use_Gate pauses inputs', async () => {
    const h = mount({ gate: 'required' });
    h.seed('a', '10 tea', ['failed']);
    await screen.findAllByText(/Review and acknowledge the data-use notice/);
    const retry = within(h.rows()[0] as HTMLElement).getByRole('button', { name: /^Retry saving/ });
    expect(retry).toHaveAttribute('aria-disabled', 'true');
    await h.user.click(retry);
    expect(h.net.to('POST', EXPENSES)).toHaveLength(0);
  });
});

/* ----------------------------- undo and the toast ---------------------------- */

describe('Undo on a saved row', () => {
  it('is named by amount and note, states the 8 seconds in text, and removes exactly that expense', async () => {
    const h = mount();
    await save(h, '120 coffee');
    await save(h, '120 coffee');
    const [newest, older] = h.rows() as [HTMLElement, HTMLElement];
    const undo = within(older).getByRole('button', { name: 'Undo ₹120 coffee' });
    expect(older).toHaveTextContent(UNDO_AVAILABLE_TEXT);
    const olderId = h.store.getState().entries.find((entry) => entry.cid === older.getAttribute('data-cid'))?.expenseId;
    await h.user.click(undo);
    await waitFor(() => expect(older).toHaveAttribute('data-phase', 'undone'));
    expect(h.net.to('DELETE', `${EXPENSES}/${olderId}`)).toHaveLength(1);
    expect(h.backend.expenses).toHaveLength(1);
    expect(older).toHaveTextContent(UNDONE_TEXT);
    expect(newest).toHaveAttribute('data-phase', 'saved');
  });

  it('shows removing within the same step, returns focus to the input, and shows the Entry removed answer', async () => {
    const h = mount();
    await save(h, '120 coffee');
    const gate = h.net.hold('DELETE', `${EXPENSES}/${h.store.getState().entries[0]?.expenseId}`);
    await h.user.click(screen.getByRole('button', { name: 'Undo ₹120 coffee' }));
    const row = h.rows()[0] as HTMLElement;
    expect(row).toHaveAttribute('data-phase', 'removing');
    const button = within(row).getByRole('button', { name: 'Undo ₹120 coffee' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(row).toHaveTextContent('Removing…');
    act(() => gate.release());
    await waitFor(() => expect(row).toHaveAttribute('data-phase', 'undone'));
    await waitFor(() => expect(h.input()).toHaveFocus());
    expect(screen.getByRole('heading', { name: REMOVED_TITLE })).toBeInTheDocument();
  });

  it('does not take focus back when the User moved it to another control', async () => {
    const h = mount({
      children: (
        <>
          <QuickAddInput />
          <QuickAddEntries />
          <button type="button">Other control</button>
        </>
      ),
    });
    await save(h, '120 coffee');
    const gate = h.net.hold('DELETE', `${EXPENSES}/${h.store.getState().entries[0]?.expenseId}`);
    await h.user.click(screen.getByRole('button', { name: 'Undo ₹120 coffee' }));
    screen.getByRole('button', { name: 'Other control' }).focus();
    act(() => gate.release());
    await waitFor(() => expect(h.rows()[0]).toHaveAttribute('data-phase', 'undone'));
    expect(screen.getByRole('button', { name: 'Other control' })).toHaveFocus();
  });

  it('keeps the expense when the delete fails, says so, and Retry undo uses the same key', async () => {
    const h = mount();
    await save(h, '120 coffee');
    const id = h.store.getState().entries[0]?.expenseId;
    h.backend.failWith('DELETE', `${EXPENSES}/${id}`, { status: 500, code: 'INTERNAL_ERROR' });
    await h.user.click(screen.getByRole('button', { name: 'Undo ₹120 coffee' }));
    const row = h.rows()[0] as HTMLElement;
    await waitFor(() => expect(row).toHaveAttribute('data-phase', 'undo_failed'));
    expect(row).toHaveTextContent(UNDO_FAILED_STATUS_TEXT);
    expect(row).toHaveTextContent(UNDO_STILL_SAVED_TEXT);
    expect(h.backend.expenses).toHaveLength(1);
    // Undo stays available beyond the window (Requirement 8.9).
    await h.user.click(within(row).getByRole('button', { name: 'Retry undo ₹120 coffee' }));
    await waitFor(() => expect(row).toHaveAttribute('data-phase', 'undone'));
    const deletes = h.net.to('DELETE', `${EXPENSES}/${id}`);
    expect(deletes).toHaveLength(2);
    expect(deletes[1]?.headers['idempotency-key']).toBe(deletes[0]?.headers['idempotency-key']);
    expect(h.backend.expenses).toHaveLength(0);
  });

  it('says the entry was already removed when the expense no longer exists', async () => {
    const h = mount();
    await save(h, '120 coffee');
    h.backend.removeElsewhere(h.store.getState().entries[0]?.expenseId ?? 0);
    await h.user.click(screen.getByRole('button', { name: 'Undo ₹120 coffee' }));
    const row = h.rows()[0] as HTMLElement;
    await waitFor(() => expect(row).toHaveAttribute('data-phase', 'undone'));
    expect(row).toHaveTextContent(ALREADY_REMOVED_ROW_TEXT);
  });

  it('dismisses an undone row and puts focus on the input', async () => {
    const h = mount();
    await save(h, '120 coffee');
    await h.user.click(screen.getByRole('button', { name: 'Undo ₹120 coffee' }));
    await waitFor(() => expect(h.rows()[0]).toHaveAttribute('data-phase', 'undone'));
    await h.user.click(within(h.rows()[0] as HTMLElement).getByRole('button', { name: /^Dismiss/ }));
    expect(h.rows()).toHaveLength(0);
    expect(h.input()).toHaveFocus();
  });

  it('is reachable by keyboard and operable with Enter', async () => {
    const h = mount();
    await save(h, '120 coffee');
    h.input().focus();
    await h.user.tab();
    expect(screen.getByRole('button', { name: 'Undo ₹120 coffee' })).toHaveFocus();
    await h.user.tab();
    expect(screen.getByLabelText('Category', { selector: '.qa-entry select' })).toHaveFocus();
    await h.user.tab({ shift: true });
    await h.user.keyboard('{Enter}');
    await waitFor(() => expect(h.rows()[0]).toHaveAttribute('data-phase', 'undone'));
    expect(h.backend.expenses).toHaveLength(0);
  });
});

describe('Undo window with a clock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  function confirmedRow() {
    const h = mount({ children: <QuickAddEntries /> });
    h.seed('a', '120 coffee', ['confirmed'], 70);
    return h;
  }

  const undoButton = () => screen.getByRole('button', { name: 'Undo ₹120 coffee' });
  const advance = (ms: number) => act(() => {
    vi.advanceTimersByTime(ms);
  });

  it('shows the static text and the time left as text, and removes Undo after 8 seconds while the expense stays', () => {
    const h = confirmedRow();
    expect(screen.getByText(UNDO_AVAILABLE_TEXT)).toBeInTheDocument();
    expect(screen.getByTestId('undo-remaining')).toHaveTextContent('8 seconds left.');
    advance(3000);
    expect(screen.getByTestId('undo-remaining')).toHaveTextContent('5 seconds left.');
    advance(4900);
    expect(screen.getByTestId('undo-remaining')).toHaveTextContent('1 second left.');
    advance(200);
    expect(screen.queryByRole('button', { name: /^Undo/ })).not.toBeInTheDocument();
    expect(screen.queryByText(UNDO_AVAILABLE_TEXT)).not.toBeInTheDocument();
    expect(h.rows()[0]).toHaveAttribute('data-phase', 'saved');
    expect(h.net.to('DELETE', `${EXPENSES}/70`)).toHaveLength(0);
  });

  it('pauses while the pointer is over the button and resumes when it leaves', () => {
    const h = confirmedRow();
    advance(3000);
    fireEvent.pointerEnter(undoButton());
    expect(screen.getByTestId('undo-remaining')).toHaveTextContent('Paused while you use Undo. 5 seconds left.');
    advance(30_000);
    expect(undoButton()).toBeInTheDocument();
    expect(screen.getByTestId('undo-remaining')).toHaveTextContent('5 seconds left.');
    fireEvent.pointerLeave(undoButton());
    expect(screen.getByTestId('undo-remaining')).not.toHaveTextContent('Paused');
    advance(4900);
    expect(undoButton()).toBeInTheDocument();
    advance(200);
    expect(screen.queryByRole('button', { name: /^Undo/ })).not.toBeInTheDocument();
    expect(h.rows()[0]).toHaveAttribute('data-phase', 'saved');
  });

  it('pauses while the button has keyboard focus and resumes on blur', () => {
    confirmedRow();
    advance(2000);
    act(() => undoButton().focus());
    advance(20_000);
    expect(undoButton()).toBeInTheDocument();
    expect(screen.getByTestId('undo-remaining')).toHaveTextContent('Paused while you use Undo. 6 seconds left.');
    act(() => undoButton().blur());
    advance(6100);
    expect(screen.queryByRole('button', { name: /^Undo/ })).not.toBeInTheDocument();
  });

  it('stays paused until both the pointer and the focus have left', () => {
    confirmedRow();
    fireEvent.pointerEnter(undoButton());
    act(() => undoButton().focus());
    fireEvent.pointerLeave(undoButton());
    advance(20_000);
    expect(undoButton()).toBeInTheDocument();
    act(() => undoButton().blur());
    advance(8100);
    expect(screen.queryByRole('button', { name: /^Undo/ })).not.toBeInTheDocument();
  });
});

describe('UndoToast', () => {
  async function confirmedEntry(h: Harness) {
    await save(h, '120 coffee');
    return h.store.getState().entries[0] as QuickAddEntry;
  }

  it('shows an Undo control for an entry in its window when no Quick Add surface is mounted, and hides it when one is', () => {
    const h = mount({ children: <UndoToast /> });
    expect(hasQuickAddInput()).toBe(false);
    h.seed('a', '120 coffee', ['confirmed'], 70);
    const toast = screen.getByRole('group', { name: /Undo a saved entry: ₹120 coffee/ });
    expect(toast).toHaveTextContent('Saved ₹120 to Food: coffee.');
    expect(within(toast).getByRole('button', { name: 'Undo ₹120 coffee' })).toBeInTheDocument();
    expect(toast).toHaveTextContent(UNDO_AVAILABLE_TEXT);
    expect(toast.closest('[aria-live]')).toBeNull();

    // A mounted input means a surface is on screen, and the row carries Undo instead.
    let stop: () => void = () => undefined;
    act(() => {
      stop = registerQuickAddInput(document.createElement('input'));
    });
    expect(screen.queryByRole('group', { name: /Undo a saved entry/ })).not.toBeInTheDocument();
    act(() => stop());
    expect(screen.getByRole('group', { name: /Undo a saved entry/ })).toBeInTheDocument();
  });

  it('undoes the entry from the toast, then the toast leaves', async () => {
    const h = mount({ children: <><QuickAddInput /><UndoToast surfaceMounted={false} /></> });
    const entry = await confirmedEntry(h);
    await h.user.click(screen.getByRole('button', { name: 'Undo ₹120 coffee' }));
    await waitFor(() => expect(h.store.getState().entries[0]?.phase).toBe('undone'));
    expect(h.net.to('DELETE', `${EXPENSES}/${entry.expenseId}`)).toHaveLength(1);
    expect(screen.queryByRole('group', { name: /Undo a saved entry/ })).not.toBeInTheDocument();
    expect(h.backend.expenses).toHaveLength(0);
  });

  it('keeps the toast control through a failed undo, with the same-key retry', async () => {
    const h = mount({ children: <><QuickAddInput /><UndoToast surfaceMounted={false} /></> });
    const entry = await confirmedEntry(h);
    h.backend.failWith('DELETE', `${EXPENSES}/${entry.expenseId}`, { status: 500, code: 'INTERNAL_ERROR' });
    await h.user.click(screen.getByRole('button', { name: 'Undo ₹120 coffee' }));
    const retry = await screen.findByRole('button', { name: 'Retry undo ₹120 coffee' });
    expect(screen.getByRole('group', { name: /Undo a saved entry/ })).toHaveTextContent(/could not be removed|still saved/i);
    await h.user.click(retry);
    await waitFor(() => expect(h.store.getState().entries[0]?.phase).toBe('undone'));
    expect(UNDO_STILL_SAVED_TEXT.length).toBeGreaterThan(0);
  });
});

/* ------------------------------ category, memory ----------------------------- */

describe('changes on a saved row', () => {
  it('changes the category through the update operation, shows the confirmed value, and refreshes the answer', async () => {
    const h = mount();
    await save(h, '120 coffee');
    const row = h.rows()[0] as HTMLElement;
    await h.user.selectOptions(within(row).getByLabelText('Category'), 'Transport');
    await waitFor(() => expect(h.backend.expenses[0]?.category).toBe('Transport'));
    expect(h.net.to('PATCH', `${EXPENSES}/${h.store.getState().entries[0]?.expenseId}`)[0]?.body).toEqual({ category: 'Transport' });
    await waitFor(() => expect(within(row).getByLabelText('Category')).toHaveValue('Transport'));
    expect(screen.getByRole('region', { name: ANSWER_TITLE })).toHaveTextContent('Saved ₹120 to Transport: coffee.');
  });

  it('keeps the last confirmed category and offers Retry and Dismiss when the change fails', async () => {
    const h = mount();
    await save(h, '120 coffee');
    const row = h.rows()[0] as HTMLElement;
    const id = h.store.getState().entries[0]?.expenseId;
    h.backend.failWith('PATCH', `${EXPENSES}/${id}`, { status: 500, code: 'INTERNAL_ERROR', message: 'Please try again.' });
    await h.user.selectOptions(within(row).getByLabelText('Category'), 'Transport');
    expect(await within(row).findByText(/failed: .*The expense is unchanged\./)).toBeInTheDocument();
    expect(within(row).getByLabelText('Category')).toHaveValue('Food');
    await h.user.click(within(row).getByRole('button', { name: /^Retry change category/ }));
    await waitFor(() => expect(within(row).getByLabelText('Category')).toHaveValue('Transport'));
    expect(within(row).queryByText(/failed:/)).not.toBeInTheDocument();
  });

  it('shows the memory failure on the row with a retry, and the saved expense stays', async () => {
    const h = mount({ prepare: (backend) => backend.failWith('PUT', MEMORY, { status: 500, code: 'INTERNAL_ERROR' }) });
    h.setLine('120 coffee');
    await h.user.selectOptions(screen.getByLabelText('Category'), 'Transport');
    await h.user.click(screen.getByRole('button', { name: 'Save' }));
    const row = await waitFor(() => {
      const found = h.rows()[0] as HTMLElement;
      expect(found).toHaveTextContent(MEMORY_FAILED_TEXT);
      return found;
    });
    expect(row).toHaveAttribute('data-phase', 'saved');
    expect(h.backend.expenses).toHaveLength(1);
    await h.user.click(within(row).getByRole('button', { name: /^Retry remembering the category/ }));
    await waitFor(() => expect(row).not.toHaveTextContent(MEMORY_FAILED_TEXT));
    expect(h.backend.memoryFor('coffee')?.category).toBe('Transport');
    expect(h.net.to('POST', EXPENSES)).toHaveLength(1);
  });
});

describe('immediate answer and the exclusion action', () => {
  it('offers the exclusion for a large entry, changes it through the update operation, and updates row and answer', async () => {
    const h = mount();
    h.setLine('1500 laptop');
    await h.user.click(await screen.findByRole('button', { name: 'Save and count today' }));
    const exclude = await screen.findByRole('button', { name: EXCLUDE_LABEL });
    await h.user.click(exclude);
    await waitFor(() => expect(screen.getByRole('region', { name: ANSWER_TITLE })).toHaveTextContent("Not counted against today's allowance."));
    const patch = h.net.to('PATCH', `${EXPENSES}/${h.store.getState().entries[0]?.expenseId}`)[0];
    expect(patch?.body).toEqual({ excludeFromDailyAllowance: true });
    expect(h.rows()[0]).toHaveTextContent(NOT_COUNTED_TEXT);
    // The action's button left, and focus stays inside the answer instead of dropping to the page.
    expect(screen.queryByRole('button', { name: EXCLUDE_LABEL })).not.toBeInTheDocument();
    expect(document.activeElement).not.toBe(document.body);
    // The row can count it against today again.
    await h.user.click(within(h.rows()[0] as HTMLElement).getByRole('button', { name: /^Count .* against today/ }));
    await waitFor(() => expect(h.rows()[0]).not.toHaveTextContent(NOT_COUNTED_TEXT));
  });

  it('Recalculate re-reads the snapshot without resending the entry, and the answer recovers', async () => {
    const h = mount();
    h.backend.calculationFailed = true;
    h.backend.recoverOnRead = false;
    await save(h, '120 coffee');
    const recalc = await screen.findByRole('button', { name: RECALCULATE_LABEL });
    expect(screen.getByRole('region', { name: ANSWER_TITLE })).toHaveTextContent(/temporarily unavailable/);
    h.backend.calculationFailed = false;
    h.backend.dataVersion += 1;
    await h.user.click(recalc);
    await waitFor(() => expect(screen.queryByRole('button', { name: RECALCULATE_LABEL })).not.toBeInTheDocument());
    expect(h.net.to('POST', EXPENSES)).toHaveLength(1);
    expect(document.activeElement).not.toBe(document.body);
    expect(screen.getByRole('region', { name: ANSWER_TITLE })).toHaveTextContent('Saved ₹120 to Food: coffee.');
  });
});

/* -------------------------------- Announcer ---------------------------------- */

describe('Announcer', () => {
  const polite = () => screen.getByTestId('quick-add-polite');
  const assertive = () => screen.getByTestId('quick-add-assertive');
  const push = (h: Harness, text: string, assertiveFlag = false) => act(() => {
    h.store.dispatch({ type: 'announcement/push', announcement: { text, assertive: assertiveFlag } });
  });

  it('renders one polite status region and one assertive alert region, both empty at first', () => {
    mount({ children: <Announcer /> });
    expect(polite()).toHaveAttribute('role', 'status');
    expect(polite()).toHaveAttribute('aria-live', 'polite');
    expect(assertive()).toHaveAttribute('role', 'alert');
    expect(polite()).toHaveTextContent('');
    expect(assertive()).toHaveTextContent('');
  });

  it('speaks a message once, consumes it from the queue, and speaks a repeated sentence in a batch only once', () => {
    const h = mount({ children: <Announcer /> });
    push(h, 'Saved ₹120 to Food.');
    expect(polite()).toHaveTextContent('Saved ₹120 to Food.');
    expect(h.store.getState().announcements).toHaveLength(0);
    expect(assertive()).toHaveTextContent('');

    act(() => {
      h.store.dispatch({ type: 'announcement/push', announcement: { text: 'Entry removed.' } });
      h.store.dispatch({ type: 'announcement/push', announcement: { text: 'Entry removed.' } });
    });
    expect(polite().textContent).toBe('Entry removed.');
    expect(h.store.getState().announcements).toHaveLength(0);
  });

  it('speaks the same sentence again for a new event, as a new node', () => {
    const h = mount({ children: <Announcer /> });
    push(h, 'Saved ₹120 to Food.');
    const first = polite().firstElementChild;
    push(h, 'Saved ₹120 to Food.');
    expect(polite().firstElementChild).not.toBe(first);
    expect(polite().textContent).toBe('Saved ₹120 to Food.');
  });

  it('uses the assertive region only for errors', () => {
    const h = mount({ children: <Announcer /> });
    push(h, SAVE_FAILED_TEXT);
    expect(assertive()).toHaveTextContent(SAVE_FAILED_TEXT);
    expect(polite()).toHaveTextContent('');
    push(h, 'Something else went wrong.', true);
    expect(assertive()).toHaveTextContent('Something else went wrong.');
    push(h, 'Category changed to Transport.');
    expect(polite()).toHaveTextContent('Category changed to Transport.');
    expect(assertive()).toHaveTextContent('Something else went wrong.');
  });

  it('lets only one Announcer speak when two are mounted', () => {
    const h = mount({ children: <><Announcer /><Announcer /></> });
    expect(screen.getAllByTestId('quick-add-polite')).toHaveLength(1);
    push(h, 'Saved ₹5 to Food.');
    expect(screen.getAllByTestId('quick-add-polite')[0]).toHaveTextContent('Saved ₹5 to Food.');
    expect(h.store.getState().announcements).toHaveLength(0);
  });

  it('announces a confirmed save once and never announces the pending state', async () => {
    const gate = { release: () => undefined as void };
    const h = mount({ prepare: (_backend, net) => { Object.assign(gate, net.hold('POST', EXPENSES)); } });
    h.setLine('120 coffee');
    await h.user.click(screen.getByRole('button', { name: 'Save' }));
    expect(polite()).toHaveTextContent('');
    expect(assertive()).toHaveTextContent('');
    act(() => gate.release());
    await waitFor(() => expect(polite()).toHaveTextContent('Saved ₹120 to Food.'));
    expect(polite().querySelectorAll('span')).toHaveLength(1);
  });

  it('announces a failed save assertively, once', async () => {
    const h = mount({ prepare: (backend) => backend.failWith('POST', EXPENSES, { status: 500, code: 'INTERNAL_ERROR' }) });
    h.setLine('120 coffee');
    await h.user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(assertive()).toHaveTextContent(SAVE_FAILED_TEXT));
    expect(polite()).toHaveTextContent('');
    expect(h.store.getState().announcements).toHaveLength(0);
  });

  it('keeps every announcing region out of the status rows', async () => {
    const h = mount();
    await save(h, '120 coffee');
    for (const row of h.rows()) expect(row.querySelector('[aria-live], [role="alert"], [role="status"]')).toBeNull();
  });
});

/* ---------------------------- accessibility and layout ----------------------- */

describe('accessibility and layout', () => {
  async function checkBothThemes(prepare: (h: Harness) => Promise<void> | void, options: MountOptions = {}) {
    for (const theme of ['light', 'dark'] as const) {
      document.documentElement.setAttribute('data-theme', theme);
      const h = mount(options);
      await prepare(h);
      expect(await axe(h.container), theme).toHaveNoViolations();
      cleanup();
      memoryClients.splice(0).forEach((client) => client.dispose());
    }
  }

  it('has no axe violations for pending, failed, saved with an answer, and removed states, in light and dark themes', async () => {
    await checkBothThemes(async (h) => {
      h.seed('p', '10 tea');
      h.seed('f', '20 chai', ['failed']);
      h.seed('s', '30 lunch', ['confirmed'], 71);
      await waitFor(() => expect(h.rows()).toHaveLength(3));
    });
    await checkBothThemes(async (h) => {
      await save(h, '120 coffee');
      await screen.findByRole('region', { name: ANSWER_TITLE });
    });
    await checkBothThemes(async (h) => {
      await save(h, '120 coffee');
      await h.user.click(screen.getByRole('button', { name: 'Undo ₹120 coffee' }));
      await waitFor(() => expect(h.rows()[0]).toHaveAttribute('data-phase', 'undone'));
    });
  });

  it('has no axe violations for the answer states and the Undo toast', async () => {
    for (const theme of ['light', 'dark'] as const) {
      document.documentElement.setAttribute('data-theme', theme);
      const plan = outcome<MonthlyPlanValue>(`monthly-plan:${MONTH}`, 'monthly_plan', 'missing_input', undefined, { missing: [{ input: 'salary', unlocks: ['monthly_plan'] }] });
      const spending = outcome<SpendingOutcomeValue>(`spending:${MONTH}`, 'spending', 'calculation_failed', undefined);
      for (const answer of [answerOf(), answerOf({ plan }), answerOf({ spending }), answerOf({ today: null })]) {
        const view = renderAnswer(answer, { onRecalculate: async () => ({ status: 'failed' }), onExclude: async () => ({ status: 'unavailable' }) });
        expect(await axe(view.container), theme).toHaveNoViolations();
        cleanup();
      }
    }
    const h = mount({ children: <UndoToast /> });
    h.seed('a', '120 coffee', ['confirmed'], 70);
    expect(await axe(h.container)).toHaveNoViolations();
  });

  it('styles with theme tokens only, keeps 44 pixel targets, wraps long text, and removes the timer animation on request', () => {
    const stripped = entriesCss.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(stripped).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    expect(entriesCss).toMatch(/min-height: 44px; min-width: 44px/);
    expect(entriesCss).toMatch(/\.qa-entry select \{ min-height: 44px; \}/);
    expect(entriesCss).toMatch(/overflow-wrap: anywhere/);
    expect(entriesCss).toMatch(/outline: 3px solid var\(--clarity-focus\)/);
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(entriesCss)?.[1] ?? '';
    expect(reduced).toMatch(/\.qa-undo-bar, \.qa-undo-left \{ display: none; \}/);
    expect(reduced).toMatch(/animation: none !important/);
    // The toast clears the floating action through the variable the FAB publishes.
    expect(entriesCss).toMatch(/--quick-add-fab-h/);
    expect(entriesCss).toMatch(/env\(safe-area-inset-bottom\)/);
  });
});

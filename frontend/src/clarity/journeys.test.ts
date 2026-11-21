import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLARITY_RESPONSES, DESIRED_OUTCOMES } from './measurement';
import {
  CLARITY_CHOICES,
  JOURNEY_OUTCOMES,
  describeProgress,
  goalIdFromOutcomeId,
  offeredOptionalStep,
  parseJourneyIntent,
  parseJourneyView,
  postAuthDestination,
  skipOutcomeFor,
  stepCopy,
  tripIdFromOutcomeId,
  withJourneyIntent,
} from './journeys';

afterEach(() => vi.unstubAllEnvs());

describe('outcome registry', () => {
  it('lists exactly the four server outcome keys with plain-language copy', () => {
    expect(JOURNEY_OUTCOMES.map((outcome) => outcome.key)).toEqual([...DESIRED_OUTCOMES]);
    expect(JOURNEY_OUTCOMES.map((outcome) => outcome.title)).toEqual([
      'Plan the month',
      'Control spending',
      'Fund a goal',
      'Settle a trip',
    ]);
    for (const outcome of JOURNEY_OUTCOMES) {
      expect(outcome.description).not.toBe('');
      expect(outcome.needs).not.toBe('');
    }
  });

  it('knows every fixed step key the server can return and falls back for an unknown one', () => {
    for (const key of ['salary', 'expense', 'goal', 'trip', 'trip_members', 'trip_split', 'bills', 'category_treatment', 'monthly_plan', 'personal_expense']) {
      expect(stepCopy(key).title).not.toBe('');
    }
    expect(stepCopy('not_a_step').host).toBe('none');
    expect(stepCopy('constructor').host).toBe('none');
  });
});

describe('parseJourneyIntent', () => {
  it.each(DESIRED_OUTCOMES)('accepts %s', (key) => {
    expect(parseJourneyIntent(`?start=${key}`)).toBe(key);
    expect(parseJourneyIntent(new URLSearchParams({ start: key }))).toBe(key);
  });

  it.each([
    '',
    '?start=',
    '?start=PLAN_MONTH',
    '?start=plan_month%20',
    '?start=plan_month&start=fund_goal',
    '?start=__proto__',
    '?start=constructor',
    '?start=plan_month,fund_goal',
    '?start=%3Cscript%3E',
    '?start=1250000',
    '?other=plan_month',
  ])('ignores %j', (search) => {
    expect(parseJourneyIntent(search)).toBeNull();
  });

  it('ignores a missing value', () => {
    expect(parseJourneyIntent(null)).toBeNull();
    expect(parseJourneyIntent(undefined)).toBeNull();
  });
});

describe('post-auth destination and intent links', () => {
  it('is exactly the old behavior while the rollout flag is off', () => {
    vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', '');
    expect(postAuthDestination({ isAdmin: false, search: '?start=plan_month', registered: true })).toBe('/');
    expect(postAuthDestination({ isAdmin: true, search: '?start=plan_month', registered: true })).toBe('/admin');
    expect(withJourneyIntent('/register', 'plan_month')).toBe('/register');
  });

  it('sends a new registration to /start and carries only a valid intent', () => {
    vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'true');
    expect(postAuthDestination({ isAdmin: false, search: '', registered: true })).toBe('/start');
    expect(postAuthDestination({ isAdmin: false, search: '', registered: false })).toBe('/');
    expect(postAuthDestination({ isAdmin: false, search: '?start=fund_goal', registered: false })).toBe('/start?start=fund_goal');
    expect(postAuthDestination({ isAdmin: false, search: '?start=fund_goal', registered: true })).toBe('/start?start=fund_goal');
    expect(postAuthDestination({ isAdmin: false, search: '?start=evil', registered: false })).toBe('/');
    expect(postAuthDestination({ isAdmin: true, search: '?start=fund_goal', registered: true })).toBe('/admin');
    expect(withJourneyIntent('/register', 'settle_trip')).toBe('/register?start=settle_trip');
    expect(withJourneyIntent('/register', null)).toBe('/register');
  });
});

describe('parseJourneyView', () => {
  const raw = {
    id: 3,
    desiredOutcome: 'control_spending',
    status: 'active',
    requiredStepKeys: ['salary', 'expense'],
    optionalStepKeys: ['bills'],
    currentStepKey: 'expense',
    nextIncompleteStepKey: 'expense',
    progress: { requiredTotal: 2, requiredCompleted: 1, requiredRemaining: 1, currentStepNumber: 2 },
    steps: [
      { key: 'salary', required: true, status: 'satisfied', confirmedChangeId: 11, extra: 'dropped' },
      { key: 'expense', required: true, status: 'pending', confirmedChangeId: null },
    ],
    firstOutcome: { available: false, kind: 'spending', outcomeId: null },
    somethingElse: { amount: 5 },
  };

  it('keeps only the fields the page renders', () => {
    const view = parseJourneyView(raw);
    expect(view.id).toBe(3);
    expect(view.steps[0]).toEqual({ key: 'salary', required: true, status: 'satisfied', confirmedChangeId: 11, skipOutcome: null });
    expect(view).not.toHaveProperty('somethingElse');
  });

  it('says progress in text', () => {
    expect(describeProgress(parseJourneyView(raw))).toBe('Step 2 of 2; 1 required step remaining.');
    const done = parseJourneyView({ ...raw, progress: { requiredTotal: 2, requiredCompleted: 2, requiredRemaining: 0, currentStepNumber: null } });
    expect(describeProgress(done)).toBe('All 2 required steps done.');
  });

  it.each([
    ['an unknown outcome', { ...raw, desiredOutcome: 'get_rich' }],
    ['an unknown status', { ...raw, status: 'weird' }],
    ['a missing progress block', { ...raw, progress: undefined }],
    ['a malformed step', { ...raw, steps: [{ key: 5 }] }],
  ])('rejects %s', (_name, value) => {
    expect(() => parseJourneyView(value)).toThrow();
  });
});

describe('optional steps and the first outcome', () => {
  const base = {
    id: 3,
    desiredOutcome: 'control_spending',
    status: 'active',
    requiredStepKeys: ['salary', 'expense'],
    optionalStepKeys: ['bills', 'category_treatment'],
    currentStepKey: 'bills',
    nextIncompleteStepKey: null,
    progress: { requiredTotal: 2, requiredCompleted: 2, requiredRemaining: 0, currentStepNumber: null },
    steps: [
      { key: 'salary', required: true, status: 'satisfied', confirmedChangeId: 11 },
      { key: 'expense', required: true, status: 'satisfied', confirmedChangeId: 12 },
      { key: 'bills', required: false, status: 'pending', confirmedChangeId: null, offered: true, skip: { financialWrite: false, affectedOutcome: 'disposable_income', availableOutcomeKind: 'spending' } },
      { key: 'category_treatment', required: false, status: 'pending', confirmedChangeId: null },
    ],
    firstOutcome: { available: true, kind: 'spending', outcomeId: 'spending:2026-11' },
  };

  it('keeps the server-named skipped outcome and the first-outcome reference', () => {
    const view = parseJourneyView(base);
    expect(view.firstOutcome).toEqual({ available: true, kind: 'spending', outcomeId: 'spending:2026-11' });
    expect(view.steps.map((step) => step.skipOutcome)).toEqual([null, null, 'disposable_income', null]);
  });

  it('offers only the one optional step the server names, and only after the first outcome', () => {
    expect(offeredOptionalStep(parseJourneyView(base))?.key).toBe('bills');
    expect(offeredOptionalStep(parseJourneyView({ ...base, firstOutcome: { available: false, kind: 'spending', outcomeId: null } }))).toBeNull();
    expect(offeredOptionalStep(parseJourneyView({ ...base, status: 'paused' }))).toBeNull();
    expect(offeredOptionalStep(parseJourneyView({ ...base, currentStepKey: null }))).toBeNull();
    const skipped = { ...base, currentStepKey: 'category_treatment', steps: base.steps.map((step) => (step.key === 'bills' ? { ...step, status: 'skipped' } : step)) };
    expect(offeredOptionalStep(parseJourneyView(skipped))?.key).toBe('category_treatment');
  });

  it('names the outcome a skip leaves unchanged, preferring the server and falling back to the registry', () => {
    expect(skipOutcomeFor({ key: 'bills', skipOutcome: 'disposable_income' })).toBe('disposable_income');
    expect(skipOutcomeFor({ key: 'category_treatment', skipOutcome: null })).toBe('daily_spending_guide');
    expect(skipOutcomeFor({ key: 'salary', skipOutcome: null })).toBeNull();
  });

  it('reads ids only from references of the exact fixed shape', () => {
    expect(tripIdFromOutcomeId('trip:7')).toBe(7);
    expect(goalIdFromOutcomeId('goal:11')).toBe(11);
    for (const value of [null, '', 'trip:', 'trip:0', 'trip:07', 'trip:7/../x', 'goal:7', 'trip:7 ']) {
      expect(tripIdFromOutcomeId(value)).toBeNull();
    }
    expect(goalIdFromOutcomeId('trip:7')).toBeNull();
  });

  it('builds every result route from the fixed action registry', () => {
    expect(JOURNEY_OUTCOMES.map((outcome) => [outcome.resultPage, outcome.resultRoute])).toEqual([
      ['plan', '/plan'],
      ['spending', '/spending'],
      ['goals', '/goals'],
      ['trips', '/trips'],
    ]);
  });

  it('asks the clarity question with exactly the three measurement answers', () => {
    expect(CLARITY_CHOICES.map((choice) => choice.value)).toEqual([...CLARITY_RESPONSES]);
    expect(CLARITY_CHOICES.map((choice) => choice.label)).toEqual(['Yes', 'Partly', 'No']);
  });
});

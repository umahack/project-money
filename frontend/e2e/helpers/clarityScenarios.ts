// Deterministic page scenarios shared by the browser acceptance specs for the financial clarity pages.
//
// Each scenario opens one clarity page in one state (pending, failed, calculation_failed,
// refresh_failed, stale, missing_input, invalid_input, empty, or full of long values) with the
// in-memory API fixtures. `responsive.clarity.spec.ts` (task 17.3) audits their layout, and the
// `a11y-*.clarity.spec.ts` specs (task 17.4) audit their accessibility, so both look at exactly
// the same screens.
import { currentMonthInIndia, installClarityBackend, monthName } from './clarityApi';
import { installGoalsBackend } from './goalsApi';
import { installJourneyApi } from './journeyApi';
import { installSpendingBackend } from './spendingApi';
import { installTripsBackend } from './tripsApi';
import { TEST_USER, expect, installAuthenticatedSession, type DeterministicApiFixtures } from '../fixtures/test';
import { buildSettings } from '../../src/test/claritySettingsBuilder';
import type { FinancialSnapshot, Outcome } from '../../src/clarity/contracts';
import type { Page } from '@playwright/test';

export const MONTH = currentMonthInIndia();
export const MONTH_NAME = monthName(MONTH);
export const CLARITY_READ = `/api/finance/clarity?month=${MONTH}`;

// ---- Long values -------------------------------------------------------------------------------------------

/** Mixed scripts with no break opportunities inside the long words. */
export const LONG_UNICODE = 'सपनोंकाघरखरीदना東京への長い旅行プランとても長い名前Überweisung';
export const LONG_WORD = 'Pneumonoultramicroscopicsilicovolcanoconiosis0123456789';
export const LONG_NOTE = `Reimbursed by the office for the quarterly team offsite ${LONG_WORD} and the very long invoice reference ${'INV-2026-0042-'.repeat(8)}`.slice(0, 120);
const BILL_LABEL = 'Home loan instalment for the apartment in Bengaluru EMI'.slice(0, 60);
/** ₹99,99,999 a month, as paise. */
const SEVEN_DIGIT_PAY_MINOR = 9_999_999_00;

// ---- Snapshot states ---------------------------------------------------------------------------------------

type AnyOutcome = Outcome<unknown>;
const retryScope = (outcome: AnyOutcome) => `outcome:${outcome.id}`;
const calculationFailed = (outcome: AnyOutcome): AnyOutcome => ({
  ...outcome, status: 'calculation_failed', value: undefined, retry: { action: 'recalculate', scopeKey: retryScope(outcome) },
});
const refreshFailed = (outcome: AnyOutcome): AnyOutcome => ({
  ...outcome, status: 'refresh_failed', retry: { action: 'refresh', scopeKey: retryScope(outcome) },
});
const stale = (outcome: AnyOutcome): AnyOutcome => ({
  ...outcome, status: 'stale', stale: { sourcePeriod: '2025-12', requestedPeriod: outcome.period.month ?? MONTH },
});
const missingInput = (outcome: AnyOutcome): AnyOutcome => ({
  ...outcome, status: 'missing_input', value: undefined, missing: [{ input: 'salary', unlocks: [outcome.kind] }],
});
const invalidInput = (outcome: AnyOutcome): AnyOutcome => ({
  ...outcome, status: 'invalid_input', value: undefined,
  invalid: [{ input: 'goal.target_date', constraint: 'must be a real calendar date', affects: [outcome.kind] }],
});

type Degrade = (snapshot: FinancialSnapshot) => FinancialSnapshot;
const cast = (outcome: AnyOutcome) => outcome as never;
type TripSummary = FinancialSnapshot['outcomes']['tripSummary'];
/** Applies one state to the trip summary and to each trip under it. */
const degradeSummary = (summary: TripSummary, state: (outcome: AnyOutcome) => AnyOutcome, items = true): TripSummary => ({
  ...(state(summary) as TripSummary),
  items: items ? summary.items?.map((item) => state(item) as never) : [],
});

/** Every outcome fails to calculate: the server could not compute any region. */
export const allFailed: Degrade = (snapshot) => ({
  ...snapshot,
  outcomes: {
    monthlyPlan: cast(calculationFailed(snapshot.outcomes.monthlyPlan)),
    spending: cast(calculationFailed(snapshot.outcomes.spending)),
    goals: snapshot.outcomes.goals.map((goal) => cast(calculationFailed(goal))),
    tripSummary: degradeSummary(snapshot.outcomes.tripSummary, calculationFailed),
  },
});

/** One region in each degraded state, so every status block is laid out at once. */
export const mixedStates: Degrade = (snapshot) => ({
  ...snapshot,
  outcomes: {
    monthlyPlan: cast(calculationFailed(snapshot.outcomes.monthlyPlan)),
    spending: cast(refreshFailed(snapshot.outcomes.spending)),
    goals: snapshot.outcomes.goals.map((goal) => cast(invalidInput(goal))),
    tripSummary: degradeSummary(snapshot.outcomes.tripSummary, stale),
  },
});

export const missingEverything: Degrade = (snapshot) => ({
  ...snapshot,
  outcomes: {
    monthlyPlan: cast(missingInput(snapshot.outcomes.monthlyPlan)),
    spending: cast(missingInput(snapshot.outcomes.spending)),
    goals: snapshot.outcomes.goals.map((goal) => cast(missingInput(goal))),
    tripSummary: degradeSummary(snapshot.outcomes.tripSummary, missingInput, false),
  },
});

interface Backend {
  handle(request: { method: string; path: string }): { status: number; body: unknown };
}

/** Serves the fixture backend's clarity snapshot in the given degraded state. */
export function degradeSnapshotReads(backend: Backend, degrade: Degrade): void {
  const original = backend.handle.bind(backend);
  backend.handle = (request) => {
    const reply = original(request);
    if (request.method === 'GET' && request.path === '/finance/clarity' && reply.status === 200) {
      const body = reply.body as { snapshot: FinancialSnapshot };
      return { ...reply, body: { ...body, snapshot: degrade(body.snapshot) } };
    }
    return reply;
  };
}

// ---- Scenarios ---------------------------------------------------------------------------------------------

export interface Scenario {
  name: string;
  /** Opens the page in the state under test. Returns once that state is on screen. */
  open(page: Page, api: DeterministicApiFixtures): Promise<void>;
}

export async function signIn(page: Page, path: string): Promise<void> {
  await installAuthenticatedSession(page);
  await page.goto(path);
  await expect(page.locator('main h1').first()).toBeVisible();
}

/** The scenarios whose notice is required, so signed-in navigation is redirected to the Agreement page. */
export const AGREEMENT_SCENARIO = 'Agreement: data-use notice required, full details open';
export const PAUSED_HOME_SCENARIO = 'Home: entries paused after "Not now, just look around"';
export const AGREEMENT_HEADING = 'Review how Project Money uses your data';
/** Signs in at `path` while the notice is required and waits for the redirect to the Agreement page. */
export async function openAgreement(page: Page, path: string): Promise<void> {
  await signIn(page, path);
  await expect(page).toHaveURL(/\/agreement$/);
  await expect(page.getByRole('heading', { level: 1, name: AGREEMENT_HEADING })).toBeVisible();
}
/** The retry control of an outcome that failed to calculate, refresh, or is stale. */
export const RETRY_OUTCOME = /^(Recalculate|Retry refresh|Refresh) /;

export const BILLS = [
  { label: BILL_LABEL, amountMinor: 1_234_567_00 },
  { label: LONG_UNICODE.slice(0, 60), amountMinor: 45_000_00 },
  { label: 'Rent', amountMinor: 25_000_00 },
];

/** The streak card on Home reads a separate endpoint. */
const stubStreak = (api: DeterministicApiFixtures) => api.stub('GET', '/api/finance/streak', { json: { current: 12, longest: 31, days_logged: 120 } });

const HOME: Scenario[] = [
  {
    name: 'Home: full outcomes with a seven-digit pay and long bill names',
    async open(page, api) {
      stubStreak(api);
      installClarityBackend(api, MONTH, { salaryMinor: SEVEN_DIGIT_PAY_MINOR, bills: BILLS });
      await signIn(page, '/');
      await expect(page.getByRole('article', { name: 'Remaining to spend' })).toBeVisible();
    },
  },
  {
    name: 'Home: pay not entered yet (missing input)',
    async open(page, api) {
      stubStreak(api);
      installClarityBackend(api, MONTH, {});
      await signIn(page, '/');
      await expect(page.getByRole('article', { name: 'Remaining to spend' })).toBeVisible();
    },
  },
  {
    name: 'Home: every region missing its input',
    async open(page, api) {
      stubStreak(api);
      const control = installClarityBackend(api, MONTH, { salaryMinor: 8_000_000 });
      degradeSnapshotReads(control.backend, missingEverything);
      await signIn(page, '/');
      await expect(page.getByRole('article', { name: 'Remaining to spend' })).toBeVisible();
    },
  },
  {
    name: 'Home: calculation_failed, refresh_failed, invalid_input, and stale regions side by side',
    async open(page, api) {
      stubStreak(api);
      const control = installClarityBackend(api, MONTH, { salaryMinor: 8_000_000, bills: BILLS });
      degradeSnapshotReads(control.backend, mixedStates);
      await signIn(page, '/');
      await expect(page.getByRole('button', { name: RETRY_OUTCOME }).first()).toBeVisible();
    },
  },
  {
    name: 'Home: retry in progress after every region failed',
    async open(page, api) {
      stubStreak(api);
      const control = installClarityBackend(api, MONTH, { salaryMinor: 8_000_000 });
      degradeSnapshotReads(control.backend, allFailed);
      await signIn(page, '/');
      const retry = page.getByRole('button', { name: RETRY_OUTCOME }).first();
      await expect(retry).toBeVisible();
      api.defer('GET', CLARITY_READ);
      await retry.click();
      await expect(page.getByText('Retrying…').first()).toBeVisible();
    },
  },
  {
    // The notice is required, so Home opens the Agreement page (outside the shell) with the full details expanded.
    name: AGREEMENT_SCENARIO,
    async open(page, api) {
      stubStreak(api);
      installClarityBackend(api, MONTH, { salaryMinor: 8_000_000 });
      api.stub('GET', '/api/clarity/settings', { json: buildSettings({ acknowledgedVersion: 0 }) });
      await openAgreement(page, '/');
      const details = page.getByRole('button', { name: 'Read full details' });
      await details.click();
      await expect(details).toHaveAttribute('aria-expanded', 'true');
      await expect(page.getByRole('heading', { level: 2, name: 'Full notice' })).toBeVisible();
    },
  },
  {
    // "Not now, just look around" returns to Home with new entries paused, and the compact notice links back.
    name: PAUSED_HOME_SCENARIO,
    async open(page, api) {
      stubStreak(api);
      installClarityBackend(api, MONTH, { salaryMinor: 8_000_000 });
      api.stub('GET', '/api/clarity/settings', { json: buildSettings({ acknowledgedVersion: 0 }) });
      await openAgreement(page, '/');
      await page.getByRole('button', { name: 'Not now, just look around' }).click();
      await expect(page).toHaveURL(/\/$/);
      const gate = page.locator('section.clarity-gate');
      await expect(gate).toHaveAttribute('data-inputs-enabled', 'false');
      await expect(gate.getByText('New entries are paused.')).toBeVisible();
      await expect(gate.getByRole('link', { name: 'Review and agree to the data-use notice' })).toBeVisible();
      await expect(page.getByRole('article', { name: 'Remaining to spend' })).toBeVisible();
    },
  },
];

const PLAN: Scenario[] = [
  {
    name: 'Plan: full plan with a seven-digit pay and long bill names',
    async open(page, api) {
      installClarityBackend(api, MONTH, { salaryMinor: SEVEN_DIGIT_PAY_MINOR, bills: BILLS });
      await signIn(page, '/plan');
      await expect(page.getByRole('article', { name: `Your plan for ${MONTH_NAME}` })).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'Monthly pay' })).toHaveValue(/9999999/);
    },
  },
  {
    name: 'Plan: empty plan',
    async open(page, api) {
      installClarityBackend(api, MONTH, {});
      await signIn(page, '/plan');
      await expect(page.getByRole('article', { name: `Your plan for ${MONTH_NAME}` })).toBeVisible();
    },
  },
  {
    name: 'Plan: calculation_failed outcome with its retry',
    async open(page, api) {
      const control = installClarityBackend(api, MONTH, { salaryMinor: 8_000_000, bills: BILLS });
      degradeSnapshotReads(control.backend, allFailed);
      await signIn(page, '/plan');
      await expect(page.getByRole('button', { name: RETRY_OUTCOME }).first()).toBeVisible();
    },
  },
  {
    name: 'Plan: explanation open for a long-valued plan',
    async open(page, api) {
      const control = installClarityBackend(api, MONTH, { salaryMinor: SEVEN_DIGIT_PAY_MINOR, bills: BILLS });
      api.stub(
        'GET',
        `/api/finance/explanations/${encodeURIComponent(`monthly-plan:${MONTH}`)}?version=1`,
        (request) => {
          const url = new URL(request.path, 'http://fixture.invalid');
          const reply = control.backend.handle({
            method: 'GET', path: url.pathname.replace(/^\/api/, ''), query: url.searchParams, body: null,
          });
          return { status: reply.status, json: reply.body };
        },
      );
      await signIn(page, '/plan');
      await page.getByRole('button', { name: /^How this was calculated for / }).first().click();
      await expect(page.getByRole('group', { name: /^How .* was calculated$/ })).toBeVisible();
    },
  },
  {
    name: 'Plan: pay save pending',
    async open(page, api) {
      const control = installClarityBackend(api, MONTH, { salaryMinor: 7_500_000 });
      await signIn(page, '/plan');
      await expect(page.getByRole('textbox', { name: 'Monthly pay' })).toHaveValue('75000');
      control.hold('POST', '/api/finance/salary');
      await page.getByRole('textbox', { name: 'Monthly pay' }).fill('9999999');
      await page.getByRole('button', { name: `Save pay for ${MONTH_NAME}` }).click();
      await expect(page.getByText('Save pay: pending').first()).toBeVisible();
    },
  },
  {
    name: 'Plan: pay save failed with its retry',
    async open(page, api) {
      const control = installClarityBackend(api, MONTH, { salaryMinor: 7_500_000 });
      await signIn(page, '/plan');
      await expect(page.getByRole('textbox', { name: 'Monthly pay' })).toHaveValue('75000');
      control.backend.failNext('POST', '/finance/salary', 500, 'SERVER_ERROR', 'The pay could not be saved.');
      await page.getByRole('textbox', { name: 'Monthly pay' }).fill('9999999');
      await page.getByRole('button', { name: `Save pay for ${MONTH_NAME}` }).click();
      await expect(page.getByRole('button', { name: 'Retry Save pay' })).toBeVisible();
    },
  },
  {
    name: 'Plan: bill form with validation errors',
    async open(page, api) {
      installClarityBackend(api, MONTH, { salaryMinor: 7_500_000, bills: BILLS });
      await signIn(page, '/plan');
      await expect(page.getByRole('button', { name: '+ Add bill' })).toBeVisible();
      await page.getByLabel(/₹ per month/).fill('12abc');
      await page.getByRole('button', { name: '+ Add bill' }).click();
      await expect(page.locator('.clarity-field-error:not(:empty)').first()).toBeVisible();
    },
  },
];

export const SPENDING_EXPENSES = [
  { id: 1, category: 'Food', amount: 1_234_567, note: LONG_NOTE },
  { id: 2, category: 'Groceries', amount: 9_999_999, note: LONG_UNICODE },
  { id: 3, category: 'Transport', amount: 100 },
  { id: 4, category: 'Shopping', amount: 500, note: 'Gift' },
];

const SPENDING: Scenario[] = [
  {
    name: 'Spending: full list with seven-digit amounts and long notes',
    async open(page, api) {
      installSpendingBackend(api, MONTH, { expenses: SPENDING_EXPENSES });
      await signIn(page, '/spending');
      await expect(page.getByRole('article', { name: `Spending for ${MONTH_NAME}` })).toBeVisible();
      await expect(page.locator('#expense-1')).toBeVisible();
    },
  },
  {
    name: 'Spending: no entries yet',
    async open(page, api) {
      installSpendingBackend(api, MONTH, { expenses: [] });
      await signIn(page, '/spending');
      await expect(page.getByRole('article', { name: `Spending for ${MONTH_NAME}` })).toBeVisible();
    },
  },
  {
    name: 'Spending: calculation_failed outcome with its retry',
    async open(page, api) {
      installSpendingBackend(api, MONTH, { expenses: SPENDING_EXPENSES, calculationFailed: true });
      await signIn(page, '/spending');
      await expect(page.getByRole('button', { name: RETRY_OUTCOME }).first()).toBeVisible();
    },
  },
  {
    name: 'Spending: expense correction form open',
    async open(page, api) {
      installSpendingBackend(api, MONTH, { expenses: SPENDING_EXPENSES });
      await signIn(page, '/spending');
      await expect(page.locator('#expense-1')).toBeVisible();
      await page.getByRole('button', { name: /^Edit Food/ }).click();
      await expect(page.getByRole('form', { name: /^Correct Food/ })).toBeVisible();
    },
  },
  {
    name: 'Spending: expense save pending',
    async open(page, api) {
      const control = installSpendingBackend(api, MONTH, { expenses: SPENDING_EXPENSES });
      await signIn(page, '/spending');
      await expect(page.locator('#expense-1')).toBeVisible();
      control.hold('POST', '/api/finance/expenses');
      await page.getByRole('textbox', { name: 'Amount' }).fill('1234567');
      await page.getByRole('textbox', { name: 'Note (optional)' }).fill(LONG_NOTE);
      await page.getByRole('button', { name: '+ Log expense' }).click();
      await expect(page.locator('[data-pending-create]')).toContainText('Saving this expense…');
    },
  },
  {
    name: 'Spending: expense save failed with its retry',
    async open(page, api) {
      const control = installSpendingBackend(api, MONTH, { expenses: SPENDING_EXPENSES });
      await signIn(page, '/spending');
      await expect(page.locator('#expense-1')).toBeVisible();
      control.backend.failNext('POST', '/finance/expenses', 500, 'SERVER_ERROR', 'The expense could not be saved.');
      await page.getByRole('textbox', { name: 'Amount' }).fill('1234567');
      await page.getByRole('textbox', { name: 'Note (optional)' }).fill(LONG_NOTE);
      await page.getByRole('button', { name: '+ Log expense' }).click();
      await expect(page.locator('[data-pending-create]').getByRole('button', { name: 'Retry Log expense' })).toBeVisible();
    },
  },
];

export const GOALS_FULL = [
  { id: 1, name: LONG_UNICODE.slice(0, 60), target: 9_999_999, saved: 1_234_567, date: `${MONTH}-28` },
  { id: 2, name: LONG_WORD, target: 500, saved: 0, date: `${MONTH}-28` },
  { id: 3, name: 'Laptop', target: 1000, saved: 400, date: `${MONTH}-28` },
];

const GOALS: Scenario[] = [
  {
    name: 'Goals: full list with long Unicode names and seven-digit amounts',
    async open(page, api) {
      installGoalsBackend(api, MONTH, { goals: GOALS_FULL });
      await signIn(page, '/goals');
      await expect(page.getByRole('article', { name: 'Laptop', exact: true })).toBeVisible();
    },
  },
  {
    name: 'Goals: no goals yet',
    async open(page, api) {
      installGoalsBackend(api, MONTH, { goals: [] });
      await signIn(page, '/goals');
      await expect(page.getByRole('form', { name: 'Add a goal' })).toBeVisible();
    },
  },
  {
    name: 'Goals: monthly pay not entered (missing input)',
    async open(page, api) {
      installGoalsBackend(api, MONTH, { goals: GOALS_FULL, savingsTarget: null });
      await signIn(page, '/goals');
      await expect(page.getByRole('article', { name: 'Laptop', exact: true })).toBeVisible();
    },
  },
  {
    name: 'Goals: calculation_failed and invalid_input outcomes',
    async open(page, api) {
      const control = installGoalsBackend(api, MONTH, { goals: GOALS_FULL });
      degradeSnapshotReads(control.backend, mixedStates);
      await signIn(page, '/goals');
      await expect(page.getByRole('article', { name: 'Laptop', exact: true })).toBeVisible();
    },
  },
  {
    name: 'Goals: contribution form with a validation error',
    async open(page, api) {
      installGoalsBackend(api, MONTH, { goals: GOALS_FULL });
      await signIn(page, '/goals');
      await page.getByRole('button', { name: 'Add contribution to Laptop', exact: true }).click();
      const form = page.getByRole('form', { name: 'Add a contribution to Laptop' });
      await form.getByRole('textbox', { name: 'Contribution amount' }).fill('99999999');
      await form.getByRole('button', { name: 'Save contribution' }).click();
      await expect(form.locator('.clarity-field-error:not(:empty)').first()).toBeVisible();
    },
  },
  {
    name: 'Goals: contribution pending',
    async open(page, api) {
      const control = installGoalsBackend(api, MONTH, { goals: GOALS_FULL });
      await signIn(page, '/goals');
      await page.getByRole('button', { name: 'Add contribution to Laptop', exact: true }).click();
      const form = page.getByRole('form', { name: 'Add a contribution to Laptop' });
      control.hold('POST', '/api/finance/goals/3/contributions');
      await form.getByRole('textbox', { name: 'Contribution amount' }).fill('100');
      await form.getByRole('button', { name: 'Save contribution' }).click();
      await expect(page.getByText('Add contribution to Laptop: pending').first()).toBeVisible();
    },
  },
  {
    name: 'Goals: contribution failed with its retry',
    async open(page, api) {
      const control = installGoalsBackend(api, MONTH, { goals: GOALS_FULL });
      await signIn(page, '/goals');
      await page.getByRole('button', { name: 'Add contribution to Laptop', exact: true }).click();
      const form = page.getByRole('form', { name: 'Add a contribution to Laptop' });
      control.backend.failNext('POST', '/finance/goals/3/contributions', 500, 'SERVER_ERROR', 'The contribution could not be saved.');
      await form.getByRole('textbox', { name: 'Contribution amount' }).fill('100');
      await form.getByRole('button', { name: 'Save contribution' }).click();
      await expect(page.getByRole('button', { name: /^Retry Add contribution to Laptop/ })).toBeVisible();
    },
  },
];

const TRIP_MEMBERS = [
  { id: 101, name: 'Asha', email: TEST_USER.email },
  { id: 102, name: LONG_UNICODE.slice(0, 40), email: 'ravi@example.invalid' },
  { id: 103, name: LONG_WORD.slice(0, 40) },
];
export const TRIPS_INIT = {
  viewer: TEST_USER.email,
  trips: [{
    id: 3,
    name: `${LONG_UNICODE} trip with an extremely long title`,
    destination: LONG_WORD,
    budget: 9_999_999,
    startDate: `${MONTH}-09`,
    endDate: `${MONTH}-12`,
    owner: TEST_USER.email,
    members: TRIP_MEMBERS,
    expenses: [
      { id: 11, payer: 'Asha', description: LONG_NOTE.slice(0, 100), amount: 1_234_567, createdAt: `${MONTH}-02 12:00:00` },
      { id: 12, payer: LONG_WORD.slice(0, 40), description: 'Taxi', amount: 999, createdAt: `${MONTH}-03 12:00:00` },
    ],
  }, {
    id: 4,
    name: 'Goa weekend',
    destination: 'Goa',
    budget: 5000,
    owner: TEST_USER.email,
    members: [{ id: 201, name: 'Asha', email: TEST_USER.email }, { id: 202, name: 'Ravi' }],
    expenses: [],
  }],
};

const TRIPS: Scenario[] = [
  {
    name: 'Trips: list with long Unicode names and a seven-digit budget',
    async open(page, api) {
      installTripsBackend(api, MONTH, TRIPS_INIT);
      await signIn(page, '/trips');
      await expect(page.getByText('Goa weekend').first()).toBeVisible();
    },
  },
  {
    name: 'Trips: no trips yet',
    async open(page, api) {
      installTripsBackend(api, MONTH, { viewer: TEST_USER.email, trips: [] });
      await signIn(page, '/trips');
    },
  },
  {
    name: 'Trips: calculation_failed and stale trip outcomes',
    async open(page, api) {
      const control = installTripsBackend(api, MONTH, TRIPS_INIT);
      degradeSnapshotReads(control.backend, mixedStates);
      await signIn(page, '/trips');
      await expect(page.getByText('Goa weekend').first()).toBeVisible();
    },
  },
  {
    name: 'TripDetail: long names, long expense text, and seven-digit amounts',
    async open(page, api) {
      installTripsBackend(api, MONTH, TRIPS_INIT);
      await signIn(page, '/trips/3');
      await expect(page.getByRole('tab', { name: /Balances/ })).toBeVisible();
    },
  },
  ...(['people', 'balances', 'share'] as const).map((tab): Scenario => ({
    name: `TripDetail: ${tab} tab with long names and seven-digit amounts`,
    async open(page, api) {
      installTripsBackend(api, MONTH, TRIPS_INIT);
      await signIn(page, `/trips/3?tab=${tab}`);
      await expect(page.getByRole('tab', { name: /Balances/ })).toBeVisible();
    },
  })),
  {
    name: 'TripDetail: expense save pending',
    async open(page, api) {
      const control = installTripsBackend(api, MONTH, TRIPS_INIT);
      await signIn(page, '/trips/3');
      await expect(page.getByRole('tab', { name: /Balances/ })).toBeVisible();
      control.hold('POST', '/api/trips/3/expenses');
      await page.getByRole('textbox', { name: 'What for?' }).fill(LONG_NOTE.slice(0, 100));
      await page.getByRole('textbox', { name: 'Amount (₹)' }).fill('1234567');
      await page.getByRole('button', { name: 'Add & split' }).click();
      await expect(page.getByText('Add expense: pending').first()).toBeVisible();
    },
  },
  {
    name: 'TripDetail: expense save failed with its retry',
    async open(page, api) {
      const control = installTripsBackend(api, MONTH, TRIPS_INIT);
      await signIn(page, '/trips/3');
      await expect(page.getByRole('tab', { name: /Balances/ })).toBeVisible();
      control.backend.failNext('POST', '/trips/3/expenses', 500, 'SERVER_ERROR', 'The expense could not be saved.');
      await page.getByRole('textbox', { name: 'What for?' }).fill('Taxi');
      await page.getByRole('textbox', { name: 'Amount (₹)' }).fill('300');
      await page.getByRole('button', { name: 'Add & split' }).click();
      await expect(page.getByRole('button', { name: /^Retry Add expense/ })).toBeVisible();
    },
  },
  {
    name: 'TripDetail: share disclosure dialog',
    async open(page, api) {
      installTripsBackend(api, MONTH, TRIPS_INIT);
      await signIn(page, '/trips/3?tab=share');
      await expect(page.getByRole('button', { name: 'Create public link' })).toBeVisible();
      await page.getByRole('button', { name: 'Create public link' }).click();
      await expect(page.getByRole('dialog', { name: 'Create a public link' })).toBeVisible();
    },
  },
];

const JOURNEY: Scenario[] = [
  {
    name: 'Journey: choosing an outcome',
    async open(page, api) {
      installJourneyApi(api, MONTH);
      await signIn(page, '/start');
      await expect(page.getByRole('list', { name: 'Desired outcomes' }).getByRole('button')).toHaveCount(4);
    },
  },
  {
    name: 'Journey: first step with a seven-digit pay pending',
    async open(page, api) {
      const control = installJourneyApi(api, MONTH);
      await signIn(page, '/start');
      await page.getByRole('list', { name: 'Desired outcomes' }).getByRole('button', { name: 'Plan the month' }).click();
      await expect(page.getByRole('heading', { level: 2, name: 'Add your monthly pay' })).toBeVisible();
      control.hold('POST', '/api/finance/salary');
      await page.getByRole('textbox', { name: 'Monthly pay' }).fill('9999999');
      await page.getByRole('button', { name: `Save pay for ${MONTH_NAME}` }).click();
      await expect(page.getByText('Save pay: pending').first()).toBeVisible();
    },
  },
  {
    name: 'Journey: first step failed with its retry',
    async open(page, api) {
      const control = installJourneyApi(api, MONTH);
      await signIn(page, '/start');
      await page.getByRole('list', { name: 'Desired outcomes' }).getByRole('button', { name: 'Plan the month' }).click();
      await expect(page.getByRole('heading', { level: 2, name: 'Add your monthly pay' })).toBeVisible();
      control.backend.failNext('POST', '/finance/salary', 500, 'SERVER_ERROR', 'The pay could not be saved.');
      await page.getByRole('textbox', { name: 'Monthly pay' }).fill('9999999');
      await page.getByRole('button', { name: `Save pay for ${MONTH_NAME}` }).click();
      await expect(page.getByRole('button', { name: 'Retry Save pay' })).toBeVisible();
    },
  },
  {
    name: 'Journey: first result revealed',
    async open(page, api) {
      installJourneyApi(api, MONTH);
      await signIn(page, '/start');
      await page.getByRole('list', { name: 'Desired outcomes' }).getByRole('button', { name: 'Plan the month' }).click();
      await page.getByRole('textbox', { name: 'Monthly pay' }).fill('9999999');
      await page.getByRole('button', { name: `Save pay for ${MONTH_NAME}` }).click();
      await expect(page.getByRole('heading', { level: 2, name: 'Your first result is ready' })).toBeVisible();
    },
  },
];

const SETTINGS: Scenario[] = [
  {
    name: 'Settings: sessions, categories, analytics control, export, and delete-account zone',
    async open(page, api) {
      api.stub('GET', '/api/invites', { json: { invites: [] } });
      api.stub('GET', '/api/clarity/settings', { json: buildSettings({ acknowledgedVersion: 1 }) });
      api.stub('GET', '/api/auth/email-change-pending', { json: { pending: null } });
      api.stub('GET', '/api/auth/sessions', {
        json: {
          current_sid: 1,
          sessions: [
            { id: 1, device_label: LONG_UNICODE, user_agent: LONG_NOTE, created_at: '2026-01-02T05:00:00.000Z', last_seen_at: '2026-01-10T05:00:00.000Z', revoked_at: null, revoked_reason: null, revoked: false },
            { id: 2, device_label: LONG_WORD, user_agent: null, created_at: '2026-01-01T05:00:00.000Z', last_seen_at: null, revoked_at: null, revoked_reason: null, revoked: false },
          ],
        },
      });
      api.stub('GET', '/api/finance/categories', {
        json: { defaults: ['Food', 'Groceries', 'Transport'], custom: [{ id: 1, name: LONG_UNICODE.slice(0, 24) }, { id: 2, name: LONG_WORD.slice(0, 24) }] },
      });
      await signIn(page, '/settings');
      await expect(page.getByText(LONG_WORD.slice(0, 24)).first()).toBeVisible();
    },
  },
  {
    name: 'Settings: data-use notice not yet acknowledged',
    async open(page, api) {
      api.stub('GET', '/api/invites', { json: { invites: [] } });
      api.stub('GET', '/api/clarity/settings', { json: buildSettings({ acknowledgedVersion: 0 }) });
      api.stub('GET', '/api/auth/email-change-pending', { json: { pending: null } });
      api.stub('GET', '/api/auth/sessions', { json: { current_sid: 1, sessions: [] } });
      api.stub('GET', '/api/finance/categories', { json: { defaults: ['Food'], custom: [] } });
      await signIn(page, '/settings');
      await expect(page.getByRole('heading', { name: /data/i }).first()).toBeVisible();
    },
  },
];

export const SCENARIOS: Scenario[] = [...HOME, ...PLAN, ...SPENDING, ...GOALS, ...TRIPS, ...JOURNEY, ...SETTINGS];

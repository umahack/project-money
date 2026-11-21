// Keyboard-only acceptance for the financial clarity pages (task 17.4, Requirements 12.4 to 12.6, 12.14 to 12.16).
//
// jsdom covers per-component focus rules. This spec drives the real pages with the real, unmodified CSS and uses
// no pointer: only Tab, Shift+Tab, Enter, Space, and Escape.
//
// 1. Focus sweep. On every clarity page, in both themes, Tab through the whole page and check each stop:
//    the focus indicator exists, is at least 3:1 against the colour around it, and is not clipped by an
//    ancestor or the viewport; the stops inside `main` follow the visual reading order; and Tab and Shift+Tab
//    both come to an end (no keyboard trap).
// 2. Task flows by keyboard alone: navigation, saving pay with Enter, a bill form, the explanation
//    disclosure (Enter, Space, Escape), a failed save retried with Enter, spending entry and correction,
//    goal contribution with an associated validation error, the data-use notice, the share dialog, the
//    delete-account control, the guided journey, and the retry of a failed outcome.
//    Focus must stay on, or move to, a control inside the page after every mutation settles, a row is
//    replaced, or a region refreshes.
import {
  activeElementLabel,
  collectFocusStops,
  expectFocusKept,
  focusIndicatorProblems,
  readingOrderProblems,
  resetFocusToTop,
  setTheme,
  tabTo,
  THEMES,
} from './helpers/a11y';
import { MONTH, MONTH_NAME, SCENARIOS, signIn } from './helpers/clarityScenarios';
import { installClarityBackend } from './helpers/clarityApi';
import { installGoalsBackend } from './helpers/goalsApi';
import { installJourneyApi } from './helpers/journeyApi';
import { settleAnimations } from './helpers/layout';
import { installSpendingBackend } from './helpers/spendingApi';
import { installTripsBackend } from './helpers/tripsApi';
import { TEST_USER, expect, test } from './fixtures/test';
import { buildSettings } from '../src/test/claritySettingsBuilder';
import type { Page } from '@playwright/test';

// Keyboard checks need the screenshot of a failure, not a recording of every step.
test.use({ video: 'off', trace: 'off' });

const SWEEP_LIMIT = 160;

/** Pages whose whole tab sequence is checked: one full state of every clarity page. */
const SWEPT_SCENARIOS = [
  'Home: full outcomes with a seven-digit pay and long bill names',
  'Home: calculation_failed, refresh_failed, invalid_input, and stale regions side by side',
  'Home: data-use notice not yet acknowledged, notice expanded',
  'Plan: full plan with a seven-digit pay and long bill names',
  'Plan: bill form with validation errors',
  'Spending: full list with seven-digit amounts and long notes',
  'Spending: expense correction form open',
  'Goals: full list with long Unicode names and seven-digit amounts',
  'Goals: contribution form with a validation error',
  'Trips: list with long Unicode names and a seven-digit budget',
  'TripDetail: long names, long expense text, and seven-digit amounts',
  'TripDetail: share tab with long names and seven-digit amounts',
  'TripDetail: share disclosure dialog',
  'Journey: choosing an outcome',
  'Journey: first result revealed',
  'Settings: sessions, categories, analytics control, export, and delete-account zone',
];

function scenarioNamed(name: string) {
  const scenario = SCENARIOS.find((candidate) => candidate.name === name);
  if (!scenario) throw new Error(`No scenario is named "${name}".`);
  return scenario;
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await settleAnimations(page);
}



for (const name of SWEPT_SCENARIOS) {
  test(`focus sweep: ${name}`, async ({ page, api }) => {
    await scenarioNamed(name).open(page, api);
    await settle(page);
    const dialog = (await page.locator('[role="dialog"]').count()) > 0;
    for (const theme of THEMES) {
      await setTheme(page, theme);
      await resetFocusToTop(page);
      const forward = await collectFocusStops(page, SWEEP_LIMIT, 'forward');
      expect(forward.length, `there must be focus stops (${theme})`).toBeGreaterThanOrEqual(dialog ? 2 : 5);
      expect(forward.length, `Tab never ends: a keyboard trap (${theme})`).toBeLessThan(SWEEP_LIMIT);
      expect.soft(focusIndicatorProblems(forward), `focus indicators (${theme})`).toEqual([]);
      if (!dialog) expect.soft(readingOrderProblems(forward), `reading order (${theme})`).toEqual([]);
      const backward = await collectFocusStops(page, SWEEP_LIMIT, 'backward');
      expect(backward.length, `Shift+Tab never ends: a keyboard trap (${theme})`).toBeLessThan(SWEEP_LIMIT);
      expect.soft(focusIndicatorProblems(backward), `focus indicators going backward (${theme})`).toEqual([]);
    }
  });
}

test('navigation: a link is reached with Tab, followed with Enter, and focus stays on the navigation', async ({ page, api }) => {
  installClarityBackend(api, MONTH, { salaryMinor: 7_500_000 });
  api.stub('GET', '/api/finance/streak', { json: { current: 0, longest: 0, days_logged: 0 } });
  await signIn(page, '/');
  // The navigation is the sidebar from 900 px and the bottom bar below it; only one is visible.
  const plan = page.getByRole('navigation').getByRole('link', { name: /Plan$/ });
  await tabTo(page, plan);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/plan$/);
  await expect(page.getByRole('article', { name: `Your plan for ${MONTH_NAME}` })).toBeVisible();
  await expectFocusKept(page);
  await expect(plan).toBeFocused();
});

test('Plan: pay, bill, a failed save and its retry, and the explanation are all done by keyboard', async ({ page, api }) => {
  const control = installClarityBackend(api, MONTH, { salaryMinor: 7_500_000 });
  api.stub('GET', `/api/finance/explanations/${encodeURIComponent(`monthly-plan:${MONTH}`)}?version=1`, (request) => {
    const url = new URL(request.path, 'http://fixture.invalid');
    const reply = control.backend.handle({ method: 'GET', path: url.pathname.replace(/^\/api/, ''), query: url.searchParams, body: null });
    return { status: reply.status, json: reply.body };
  });
  await signIn(page, '/plan');
  const pay = page.getByRole('textbox', { name: 'Monthly pay' });
  await expect(pay).toHaveValue('75000');
  const salaryStatus = page.locator(`[data-scope="salary:${MONTH}"]`);

  // Explanation disclosure first, while the explanation of the loaded version is the one the fixture serves:
  // Enter opens, Escape closes and returns to the toggle, Space opens again.
  const toggle = page.getByRole('button', { name: /^How this was calculated for / }).first();
  await tabTo(page, toggle);
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('group', { name: /^How .* was calculated$/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toBeFocused();
  await page.keyboard.press('Space');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle).toBeFocused();
  await page.keyboard.press('Space');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');

  // Pay: reach the field, replace the value, and submit with Enter. Focus stays in the field.
  await tabTo(page, pay);
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('80000');
  await page.keyboard.press('Enter');
  await expect(salaryStatus).toContainText('Save pay: done');
  await expect(pay).toBeFocused();
  await expectFocusKept(page);

  // A failed save keeps the field, announces the failure, and the retry is the next stop after the field's form.
  control.backend.failNext('POST', '/finance/salary', 500, 'SERVER_ERROR', 'The pay could not be saved.');
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('90000');
  await page.keyboard.press('Enter');
  await expect(salaryStatus).toContainText('Save pay: failed.');
  await expect(pay).toHaveValue('90000');
  await expect(pay).toBeFocused();
  const retry = salaryStatus.getByRole('button', { name: 'Retry Save pay' });
  await tabTo(page, retry);
  await page.keyboard.press('Enter');
  await expect(salaryStatus).toContainText('Save pay: done');
  await expectFocusKept(page);

  // Bill form: two fields and Enter.
  const billName = page.getByLabel(/What is it/);
  const billAmount = page.getByLabel(/₹ per month/);
  await tabTo(page, billName);
  await page.keyboard.type('Gym');
  await tabTo(page, billAmount);
  await page.keyboard.type('1500');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-scope="new-bill:plan"]')).toContainText('Add bill: done');
  await expect(page.getByText('Gym', { exact: true })).toBeVisible();
  await expectFocusKept(page);
});

test('Spending: an expense is logged, then corrected, by keyboard, and focus stays in the page when the row is replaced', async ({ page, api }) => {
  installSpendingBackend(api, MONTH, { expenses: [{ id: 1, category: 'Food', amount: 600, note: 'Lunch' }] });
  await signIn(page, '/spending');
  await expect(page.locator('#expense-1')).toBeVisible();

  const amount = page.getByRole('textbox', { name: 'Amount' });
  const note = page.getByRole('textbox', { name: 'Note (optional)' });
  await tabTo(page, amount);
  await page.keyboard.type('250');
  await tabTo(page, note);
  await page.keyboard.type('Tea');
  await page.keyboard.press('Enter');
  await expect(page.getByText(/Added to Food for /)).toBeVisible();
  await expectFocusKept(page);

  // Correct the first row: the edit control opens a form and moves focus into it.
  const edit = page.getByRole('button', { name: /^Edit Food/ }).first();
  await tabTo(page, edit);
  await page.keyboard.press('Enter');
  const form = page.getByRole('form', { name: /^Correct Food/ });
  await expect(form).toBeVisible();
  expect(await form.evaluate((node) => node.contains(document.activeElement)), 'focus moved into the correction form').toBe(true);
  await tabTo(page, form.getByRole('textbox', { name: 'Amount' }));
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('650');
  await page.keyboard.press('Enter');
  await expect(form).toHaveCount(0);
  await expect(page.locator('main')).toContainText('₹650');
  // The row was replaced by a new one. Focus must be on a control, not on the page.
  await expectFocusKept(page);
});

test('Goals: a contribution is entered by keyboard and its validation error is tied to the field without moving focus', async ({ page, api }) => {
  installGoalsBackend(api, MONTH, {
    goals: [{ id: 3, name: 'Laptop', target: 1000, saved: 400, date: `${MONTH}-28` }],
  });
  await signIn(page, '/goals');
  const open = page.getByRole('button', { name: 'Add contribution to Laptop', exact: true });
  await expect(open).toBeVisible();
  await tabTo(page, open);
  await page.keyboard.press('Enter');
  const form = page.getByRole('form', { name: 'Add a contribution to Laptop' });
  const amount = form.getByRole('textbox', { name: 'Contribution amount' });
  await expect(amount).toBeFocused();

  // Invalid value: the error names the field, the reason, and the accepted range, and focus stays put.
  await page.keyboard.type('99999999');
  await page.keyboard.press('Enter');
  const error = form.locator('.clarity-field-error:not(:empty)').first();
  await expect(error).toBeVisible();
  await expect(error).toHaveAttribute('role', 'alert');
  await expect(amount).toHaveAttribute('aria-invalid', 'true');
  const describedBy = (await amount.getAttribute('aria-describedby')) ?? '';
  const errorId = await error.getAttribute('id');
  expect(errorId, 'the error has an id').toBeTruthy();
  expect(describedBy.split(/\s+/), 'the field points at its error').toContain(errorId);
  await expect(amount).toBeFocused();
  await expect(amount).toHaveValue('99999999');

  // Correct it and save, still by keyboard. Everything valid that was entered is kept.
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('100');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-scope="goal:3"]')).toContainText('Add contribution to Laptop: done');
  await expectFocusKept(page);
});

test('data-use notice: the review disclosure opens with Enter and closes with Space', async ({ page, api }) => {
  installClarityBackend(api, MONTH, { salaryMinor: 7_500_000 });
  api.stub('GET', '/api/finance/streak', { json: { current: 1, longest: 1, days_logged: 1 } });
  await signIn(page, '/');
  const review = page.getByRole('button', { name: /Review the data-use notice/ });
  await expect(review).toBeVisible();
  await tabTo(page, review);
  await page.keyboard.press('Enter');
  await expect(review).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#clarity-notice-review')).toBeVisible();
  await page.keyboard.press('Space');
  await expect(review).toHaveAttribute('aria-expanded', 'false');
  await expect(review).toBeFocused();
});

test('share dialog: focus moves in, Tab stays inside, Escape closes and returns focus to the opener', async ({ page, api }) => {
  installTripsBackend(api, MONTH, {
    viewer: TEST_USER.email,
    trips: [{
      id: 3,
      name: 'Goa weekend',
      destination: 'Goa',
      budget: 5000,
      owner: TEST_USER.email,
      members: [{ id: 101, name: 'Asha', email: TEST_USER.email }, { id: 102, name: 'Ravi' }],
      expenses: [],
    }],
  });
  await signIn(page, '/trips/3?tab=share');
  const opener = page.getByRole('button', { name: 'Create public link' });
  await expect(opener).toBeVisible();
  await tabTo(page, opener);
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Create a public link' });
  await expect(dialog).toBeVisible();
  await expect(page.locator('[role="dialog"]:focus-within')).toHaveCount(1);
  for (let press = 0; press < 14; press += 1) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((node) => node.contains(document.activeElement)), `Tab ${press + 1} left the dialog`).toBe(true);
  }
  for (let press = 0; press < 14; press += 1) {
    await page.keyboard.press('Shift+Tab');
    expect(await dialog.evaluate((node) => node.contains(document.activeElement)), `Shift+Tab ${press + 1} left the dialog`).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test('TripDetail tabs: the selected tab is one Tab stop, and the arrow keys, Home, and End move and select', async ({ page, api }) => {
  installTripsBackend(api, MONTH, {
    viewer: TEST_USER.email,
    trips: [{
      id: 3,
      name: 'Goa weekend',
      destination: 'Goa',
      budget: 5000,
      owner: TEST_USER.email,
      members: [{ id: 101, name: 'Asha', email: TEST_USER.email }, { id: 102, name: 'Ravi' }],
      expenses: [],
    }],
  });
  await signIn(page, '/trips/3');
  const tab = (name: RegExp) => page.getByRole('tab', { name });
  await expect(tab(/Expenses/)).toHaveAttribute('aria-selected', 'true');
  // Only the selected tab is in the Tab order, and it controls the panel.
  await expect(tab(/Balances/)).toHaveAttribute('tabindex', '-1');
  await tabTo(page, tab(/Expenses/));
  await page.keyboard.press('ArrowRight');
  await expect(tab(/Balances/)).toHaveAttribute('aria-selected', 'true');
  await expect(tab(/Balances/)).toBeFocused();
  await expect(page.getByRole('tabpanel')).toHaveAccessibleName(/Balances/);
  await page.keyboard.press('End');
  await expect(tab(/Share/)).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(tab(/Expenses/)).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(tab(/Share/)).toBeFocused();
  await page.keyboard.press('Home');
  await expect(tab(/Expenses/)).toBeFocused();
  await expect(tab(/Expenses/)).toHaveAttribute('aria-selected', 'true');
  await expectFocusKept(page);
});

test('Settings: the delete-account control opens and cancels by keyboard without losing focus', async ({ page, api }) => {
  api.stub('GET', '/api/invites', { json: { invites: [] } });
  api.stub('GET', '/api/clarity/settings', { json: buildSettings({ acknowledgedVersion: 1 }) });
  api.stub('GET', '/api/auth/email-change-pending', { json: { pending: null } });
  api.stub('GET', '/api/auth/sessions', { json: { current_sid: 1, sessions: [] } });
  api.stub('GET', '/api/finance/categories', { json: { defaults: ['Food'], custom: [] } });
  await signIn(page, '/settings');
  const remove = page.getByRole('button', { name: /Delete my account/ });
  await tabTo(page, remove);
  await page.keyboard.press('Enter');
  const password = page.getByLabel('Current password');
  await expect(password).toBeVisible();
  await expectFocusKept(page);
  await tabTo(page, password);
  await page.keyboard.type('not-a-real-password');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  const cancel = page.getByRole('button', { name: 'Cancel' }).first();
  await tabTo(page, cancel);
  await page.keyboard.press('Space');
  await expect(password).toHaveCount(0);
  await expectFocusKept(page);
});

test('Journey: a choice and its first step are completed by keyboard and focus follows the new content', async ({ page, api }) => {
  installJourneyApi(api, MONTH);
  await signIn(page, '/start');
  const choice = page.getByRole('list', { name: 'Desired outcomes' }).getByRole('button', { name: 'Plan the month' });
  await tabTo(page, choice);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 2, name: 'Add your monthly pay' })).toBeVisible();
  await expectFocusKept(page);
  const pay = page.getByRole('textbox', { name: 'Monthly pay' });
  await tabTo(page, pay);
  await page.keyboard.type('80000');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 2, name: 'Your first result is ready' })).toBeVisible();
  await expectFocusKept(page);
  expect(await activeElementLabel(page)).not.toBeNull();
});

test('Home: a failed outcome is retried with Enter and focus stays on its own card', async ({ page, api }) => {
  await scenarioNamed('Home: calculation_failed, refresh_failed, invalid_input, and stale regions side by side').open(page, api);
  await settle(page);
  const retry = page.getByRole('button', { name: /^(Recalculate|Retry refresh|Refresh) / }).first();
  const cardId = await retry.evaluate((node) => node.closest('article')?.getAttribute('data-outcome-id') ?? null);
  expect(cardId, 'the retry sits inside an outcome card').not.toBeNull();
  await tabTo(page, retry);
  await page.keyboard.press('Enter');
  await settle(page);
  await expectFocusKept(page);
  const after = await page.evaluate(() => document.activeElement?.closest('article')?.getAttribute('data-outcome-id') ?? null);
  expect(after, 'focus stayed on the card that was retried').toBe(cardId);
});

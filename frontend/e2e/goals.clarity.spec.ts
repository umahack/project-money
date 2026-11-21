// Browser acceptance for recording goal contributions on Goals with the financial
// clarity flag on.
//
// These tests assert, in a real browser:
//
// - pending feedback within 100 ms of submit, and outcome feedback within 100 ms of the
//   response, measured with the harness paint helpers,
// - one document for each flow, with no reload, no page-wide loading, and no broad re-read,
// - unrelated controls stay usable and focus stays on the control the user is using,
// - a failed or rejected contribution keeps the entered draft and the last confirmed values,
// - a contribution of exactly the gap funds the goal and leaves focus on a control, not the page.
//
// The `clarity-*` projects in playwright.config.ts run this file against a dev server
// started with VITE_FINANCIAL_CLARITY_ENABLED=true. Every response comes from the
// in-memory FakeGoalsBackend; nothing leaves loopback. Bounds, revisions, replays, response
// ordering, and Home integration are covered by src/pages/Goals.behavior.test.tsx.
import {
  captureDocumentIdentity,
  expectNoOverflowOrClipping,
  expectResponseToPaintWithin,
  expectSameDocument,
  expectSubmitToPaintWithin,
  installFocusTracker,
  installReloadSpy,
  measureResponseToPaint,
  measureSubmitToPaint,
  waitForQuietFrames,
} from './helpers/browser';
import { currentMonthInIndia } from './helpers/clarityApi';
import { installGoalsBackend } from './helpers/goalsApi';
import { expect, installAuthenticatedSession, test, type DeterministicApiFixtures } from './fixtures/test';
import type { FakeGoalsInit } from '../src/test/fakeGoalsBackend';
import type { Page, Response } from '@playwright/test';

// Screen recording and tracing halve headless Chromium's frame rate (17 to 33 ms per
// frame becomes a steady 33 ms), which would count against a 100 ms paint budget.
// Failures still keep a screenshot and the error context.
//
// The paint budgets measure application latency, not software-rendered decoration, so this
// spec switches off the background blob animation and backdrop blur with a test-only
// stylesheet (production CSS is unchanged). See neutralizeDecorativeRendering in
// helpers/browser.ts. Layout, focus, overflow, and reduced-motion tests must not do this.
test.use({ video: 'off', trace: 'off', neutralizeDecorativeRendering: true });
// Paint timing depends on the host's frame rate, which stalls when the machine is busy.
// A real regression misses the 100 ms budget on every attempt; a busy host does not.
test.describe.configure({ retries: 2 });

const MONTH = currentMonthInIndia();
const BUDGET_MS = 100;
const CLARITY_READ = `/api/finance/clarity?month=${MONTH}`;
const GOAL_LIST = '/api/finance/goals';

const nextMonth = (() => {
  const [year, month] = MONTH.split('-').map(Number) as [number, number];
  const next = new Date(year, month, 1);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`;
})();
const TARGET_DATE = `${nextMonth}-10`;

/**
 * Laptop: gap 600 over two months, 300 a month. Phone: gap 500, 250 a month. Both fit the
 * default monthly savings target of 16,000.
 */
const GOALS: NonNullable<FakeGoalsInit['goals']> = [
  { id: 1, name: 'Laptop', target: 1000, saved: 400, date: TARGET_DATE },
  { id: 2, name: 'Phone', target: 500, saved: 0, date: TARGET_DATE },
];

async function openGoals(page: Page, api: DeterministicApiFixtures, init: FakeGoalsInit = { goals: GOALS }) {
  const control = installGoalsBackend(api, MONTH, init);
  await installAuthenticatedSession(page);
  await page.goto('/goals');
  const laptop = page.getByRole('article', { name: 'Laptop', exact: true });
  await expect(laptop).toBeVisible();
  await expect(page.getByRole('article', { name: 'Phone', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add contribution to Laptop' })).toBeVisible();
  // Start timing after load work and entrance animations, as a user interacting with a settled page would.
  await waitForQuietFrames(page);
  const card = (name: string) => page.getByRole('article', { name, exact: true });
  const value = (name: string, label: string) => card(name)
    .locator('.clarity-value')
    .filter({ has: page.getByText(label, { exact: true }) })
    .locator('.clarity-value-amount');
  return {
    control,
    card,
    value,
    add: (name: string) => page.getByRole('button', { name: `Add contribution to ${name}`, exact: true }),
    edit: (name: string) => page.getByRole('button', { name: `Edit ${name}`, exact: true }),
    form: (name: string) => page.getByRole('form', { name: `Add a contribution to ${name}` }),
    amount: (name: string) => page.getByRole('form', { name: `Add a contribution to ${name}` }).getByRole('textbox', { name: 'Contribution amount' }),
    save: (name: string) => page.getByRole('form', { name: `Add a contribution to ${name}` }).getByRole('button', { name: 'Save contribution' }),
    status: (scope: string) => page.locator(`[data-scope="${scope}"]`),
    createName: page.getByRole('form', { name: 'Add a goal' }).getByRole('textbox', { name: 'Goal name' }),
  };
}

const isPath = (method: string, path: string) => (response: Response) => (
  new URL(response.url()).pathname === path && response.request().method() === method
);

test('a contribution gives feedback within 100 ms, keeps one document, and leaves other controls and focus alone', async ({ page, api }, testInfo) => {
  const g = await openGoals(page, api);
  const initialReads = api.count('GET', CLARITY_READ);
  const initialListReads = api.count('GET', GOAL_LIST);
  const documentIdentity = await captureDocumentIdentity(page);
  const reloadSpy = await installReloadSpy(page);
  const focusTracker = await installFocusTracker(page);
  const gate = g.control.hold('POST', '/api/finance/goals/1/contributions');

  await g.add('Laptop').click();
  await expect(g.amount('Laptop')).toBeFocused();
  await expect(g.form('Laptop')).toContainText('Accepted range: ₹0.01 to ₹600');
  await g.amount('Laptop').fill('100');
  const pending = await measureSubmitToPaint(page, () => g.save('Laptop').click(), {
    selector: '[data-scope="goal:1"]',
    text: 'Add contribution to Laptop: pending',
  }, 'submit');
  testInfo.annotations.push({ type: 'pending-to-paint-ms', description: pending.durationMs.toFixed(1) });
  expectSubmitToPaintWithin(pending, BUDGET_MS);
  await expect(g.save('Laptop')).toBeFocused();
  await expect(g.card('Laptop')).toContainText('Refreshing…');
  // The confirmed values stay, and nothing is replaced by a loading state.
  await expect(g.value('Laptop', 'Funding gap')).toHaveText('₹600');
  await expect(page.getByText('Loading…', { exact: true })).toHaveCount(0);

  // The user moves on to another control while the contribution is pending. It becomes the active control.
  await g.createName.fill('Trip fund');
  await expect(g.createName).toBeFocused();
  await expect(g.add('Phone')).not.toHaveAttribute('aria-disabled', 'true');
  await expect(g.edit('Phone')).not.toHaveAttribute('aria-disabled', 'true');
  expect(api.count('POST', '/api/finance/goals/1/contributions')).toBe(1);
  const focusEventsBeforeResponse = (await focusTracker.history()).length;

  // Response: the new values, the done status, and the closed form within 100 ms.
  const responsePromise = page.waitForResponse(isPath('POST', '/api/finance/goals/1/contributions'));
  gate.release();
  const outcome = await measureResponseToPaint(page, responsePromise, g.value('Laptop', 'Funding gap').filter({ hasText: '₹500' }));
  testInfo.annotations.push({ type: 'response-to-paint-ms', description: outcome.durationMs.toFixed(1) });
  expect(outcome.status).toBe(200);
  await expectResponseToPaintWithin(outcome, BUDGET_MS);
  await expect(g.value('Laptop', 'Saved so far')).toHaveText('₹500');
  await expect(g.value('Laptop', 'Required monthly contribution')).toHaveText('₹250');
  await expect(g.status('goal:1')).toContainText('Add contribution to Laptop: done');
  await expect(g.form('Laptop')).toHaveCount(0);
  await expect(g.card('Laptop')).not.toContainText('Refreshing…');
  await expect(g.value('Phone', 'Funding gap')).toHaveText('₹500');

  // Same document, no reload, no broad re-read, and focus where the user left it.
  await expectSameDocument(page, documentIdentity);
  await reloadSpy.expectNoReloads();
  expect(api.count('GET', CLARITY_READ)).toBe(initialReads);
  expect(api.count('GET', GOAL_LIST)).toBe(initialListReads);
  await expect(g.createName).toHaveValue('Trip fund');
  await expect(g.createName).toBeFocused();
  expect(await focusTracker.history()).toHaveLength(focusEventsBeforeResponse);
  await expectNoOverflowOrClipping(page);
});

test('a failed contribution keeps its draft and the confirmed values, and a retry confirms without a reload', async ({ page, api }, testInfo) => {
  const g = await openGoals(page, api);
  const documentIdentity = await captureDocumentIdentity(page);
  const reloadSpy = await installReloadSpy(page);
  g.control.backend.failNext('POST', '/finance/goals/1/contributions', 500, 'SERVER_ERROR', 'The contribution could not be saved.');
  const gate = g.control.hold('POST', '/api/finance/goals/1/contributions');

  await g.add('Laptop').click();
  await g.amount('Laptop').fill('250');
  const pending = await measureSubmitToPaint(page, () => g.save('Laptop').click(), {
    selector: '[data-scope="goal:1"]',
    text: 'Add contribution to Laptop: pending',
  }, 'submit');
  expectSubmitToPaintWithin(pending, BUDGET_MS);

  const failedResponse = page.waitForResponse(isPath('POST', '/api/finance/goals/1/contributions'));
  gate.release();
  const failed = await measureResponseToPaint(page, failedResponse, g.status('goal:1').getByText('Add contribution to Laptop: failed.'));
  testInfo.annotations.push({ type: 'failure-response-to-paint-ms', description: failed.durationMs.toFixed(1) });
  expect(failed.status).toBe(500);
  await expectResponseToPaintWithin(failed, BUDGET_MS);
  await expect(g.status('goal:1')).toContainText('The contribution could not be saved.');

  // The draft is still in the open form and the confirmed values are untouched.
  await expect(g.amount('Laptop')).toHaveValue('250');
  await expect(g.value('Laptop', 'Funding gap')).toHaveText('₹600');
  await expect(g.value('Laptop', 'Saved so far')).toHaveText('₹400');
  await expect(g.card('Laptop')).not.toContainText('Refreshing…');
  await expect(g.value('Phone', 'Funding gap')).toHaveText('₹500');
  await expectSameDocument(page, documentIdentity);
  await reloadSpy.expectNoReloads();

  // Retry resends the same change and finishes it the way a first save finishes.
  const retry = g.status('goal:1').getByRole('button', { name: 'Retry Add contribution to Laptop' });
  const retriedPending = await measureSubmitToPaint(page, () => retry.click(), {
    selector: '[data-scope="goal:1"]',
    text: 'Add contribution to Laptop: pending',
  }, 'click');
  expectSubmitToPaintWithin(retriedPending, BUDGET_MS);
  await expect(g.status('goal:1')).toContainText('Add contribution to Laptop: done');
  await expect(g.value('Laptop', 'Funding gap')).toHaveText('₹350');
  await expect(g.value('Laptop', 'Saved so far')).toHaveText('₹650');
  await expect(g.form('Laptop')).toHaveCount(0);
  await expect(g.add('Laptop')).toBeFocused();
  expect(api.count('POST', '/api/finance/goals/1/contributions')).toBe(2);
  expect(g.control.backend.find(1)?.savedMinor).toBe(65000);
  await expectSameDocument(page, documentIdentity);
  await reloadSpy.expectNoReloads();
});

test('an amount above the gap shows the server range within 100 ms and keeps the draft, the values, and the document', async ({ page, api }) => {
  const g = await openGoals(page, api);
  const documentIdentity = await captureDocumentIdentity(page);
  const reloadSpy = await installReloadSpy(page);

  await g.add('Laptop').click();
  await g.amount('Laptop').fill('600.01');
  const gate = g.control.hold('POST', '/api/finance/goals/1/contributions');
  await measureSubmitToPaint(page, () => g.save('Laptop').click(), {
    selector: '[data-scope="goal:1"]',
    text: 'Add contribution to Laptop: pending',
  }, 'submit');

  const rejected = page.waitForResponse(isPath('POST', '/api/finance/goals/1/contributions'));
  gate.release();
  const outcome = await measureResponseToPaint(page, rejected, g.form('Laptop').getByText('is outside the accepted range.'));
  expect(outcome.status).toBe(422);
  await expectResponseToPaintWithin(outcome, BUDGET_MS);
  await expect(g.form('Laptop')).toContainText('Enter an amount from ₹0.01 to ₹600.');
  await expect(g.amount('Laptop')).toHaveValue('600.01');
  await expect(g.amount('Laptop')).toHaveAttribute('aria-invalid', 'true');
  await expect(g.value('Laptop', 'Funding gap')).toHaveText('₹600');
  // A rejected value is not a failed change: nothing to retry, and the other goal is untouched.
  await expect(g.status('goal:1').getByRole('button', { name: /Retry/ })).toHaveCount(0);
  await expect(g.value('Phone', 'Funding gap')).toHaveText('₹500');
  expect(g.control.backend.find(1)?.savedMinor).toBe(40000);

  // The same draft, lowered to the gap, funds the goal.
  await g.amount('Laptop').fill('600');
  await g.save('Laptop').click();
  await expect(g.card('Laptop').locator('.clarity-value').filter({ has: page.getByText('Goal status', { exact: true }) })).toContainText('Funded');
  await expectSameDocument(page, documentIdentity);
  await reloadSpy.expectNoReloads();
});

test('a contribution of exactly the gap funds the goal, removes the form, and leaves focus on a control, not the page', async ({ page, api }) => {
  const g = await openGoals(page, api);
  const documentIdentity = await captureDocumentIdentity(page);
  const reloadSpy = await installReloadSpy(page);
  const gate = g.control.hold('POST', '/api/finance/goals/2/contributions');

  const add = g.add('Phone');
  await add.focus();
  await page.keyboard.press('Enter');
  await expect(g.amount('Phone')).toBeFocused();
  await page.keyboard.type('500');
  const pending = await measureSubmitToPaint(page, () => page.keyboard.press('Enter'), {
    selector: '[data-scope="goal:2"]',
    text: 'Add contribution to Phone: pending',
  }, 'submit');
  expectSubmitToPaintWithin(pending, BUDGET_MS);
  await expect(g.amount('Phone')).toBeFocused();
  await expect(g.amount('Phone')).toHaveAttribute('readonly', '');

  const responsePromise = page.waitForResponse(isPath('POST', '/api/finance/goals/2/contributions'));
  gate.release();
  const outcome = await measureResponseToPaint(page, responsePromise, g.card('Phone').locator('.clarity-value-amount', { hasText: 'Funded' }));
  await expectResponseToPaintWithin(outcome, BUDGET_MS);
  await expect(g.value('Phone', 'Funding gap')).toHaveText('₹0');
  await expect(g.value('Phone', 'Required monthly contribution')).toHaveText('₹0');
  await expect(g.card('Phone').getByRole('group', { name: 'Feasibility for Phone' })).toContainText('Fully funded.');
  await expect(g.status('goal:2')).toContainText('Add contribution to Phone: done');
  // Funding removes the Add control, so focus moves to the next control in the same goal.
  await expect(g.add('Phone')).toHaveCount(0);
  await expect(g.form('Phone')).toHaveCount(0);
  await expect(g.edit('Phone')).toBeFocused();
  // The other goal did not move.
  await expect(g.value('Laptop', 'Funding gap')).toHaveText('₹600');
  await expectSameDocument(page, documentIdentity);
  await reloadSpy.expectNoReloads();
});

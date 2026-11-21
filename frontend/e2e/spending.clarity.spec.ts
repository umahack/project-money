// Browser acceptance for logging, correcting, deleting, and reclassifying expenses on
// Spending with the financial clarity flag on.
//
// These tests assert, in a real browser:
//
// - pending feedback within 100 ms of submit, and outcome feedback within 100 ms of the
//   response, measured with the harness paint helpers,
// - one document for each flow, with no reload and no page-wide loading,
// - unrelated controls stay usable and focus stays on the control the user is using,
// - a failed change keeps the entered draft and the last confirmed values,
// - two changes in different scopes, answered in the opposite order from submission,
//   each report on their own and end in the server's state.
//
// The `clarity-*` projects in playwright.config.ts run this file against a dev server
// started with VITE_FINANCIAL_CLARITY_ENABLED=true. Every response comes from the
// in-memory FakeSpendingBackend; nothing leaves loopback. Unit-level concurrency, replay,
// and conflict behavior is covered by src/pages/Spending.behavior.test.tsx.
import {
  captureDocumentIdentity,
  emulateReducedMotion,
  expectNoOverflowOrClipping,
  expectReducedMotion,
  expectResponseToPaintWithin,
  expectSameDocument,
  expectSubmitToPaintWithin,
  installFocusTracker,
  installReloadSpy,
  measureResponseToPaint,
  measureSubmitToPaint,
  waitForQuietFrames,
} from './helpers/browser';
import { currentMonthInIndia, monthName } from './helpers/clarityApi';
import { installSpendingBackend } from './helpers/spendingApi';
import { expect, installAuthenticatedSession, test, type DeterministicApiFixtures } from './fixtures/test';
import type { FakeSpendingInit } from '../src/test/fakeSpendingBackend';
import type { Page, Response } from '@playwright/test';

// Screen recording and tracing halve headless Chromium's frame rate (17 to 33 ms per
// frame becomes a steady 33 ms), which would count against a 100 ms paint budget.
// Failures still keep a screenshot and the error context.
//
// The paint budgets measure application latency, not software-rendered decoration, so the
// paint tests switch off the background blob animation and backdrop blur with a test-only
// stylesheet (production CSS is unchanged). See neutralizeDecorativeRendering in
// helpers/browser.ts. The reduced-motion test below runs against the real stylesheet.
test.use({ video: 'off', trace: 'off', neutralizeDecorativeRendering: true });
// Paint timing depends on the host's frame rate, which stalls when the machine is busy.
// A real regression misses the 100 ms budget on every attempt; a busy host does not.
test.describe.configure({ retries: 2 });

const MONTH = currentMonthInIndia();
const MONTH_NAME = monthName(MONTH);
const BUDGET_MS = 100;
const CLARITY_READ = `/api/finance/clarity?month=${MONTH}`;
const EXPENSE_LIST = `/api/finance/expenses?month=${MONTH}`;

/** Food 700 and Transport 100 count as Needs; Shopping 500 as Wants. Spent 1,300 of 64,000. Rows list 4, 3, 2, 1. */
const BASE: NonNullable<FakeSpendingInit['expenses']> = [
  { category: 'Food', amount: 500 },
  { category: 'Shopping', amount: 500 },
  { category: 'Transport', amount: 100 },
  { category: 'Food', amount: 200, note: 'Dinner' },
];

async function openSpending(page: Page, api: DeterministicApiFixtures, init: FakeSpendingInit = { expenses: BASE }) {
  const control = installSpendingBackend(api, MONTH, init);
  await installAuthenticatedSession(page);
  await page.goto('/spending');
  const card = page.getByRole('article', { name: `Spending for ${MONTH_NAME}` });
  await expect(card).toBeVisible();
  await expect(page.locator('#expense-1')).toBeVisible();
  const log = page.getByRole('button', { name: '+ Log expense' });
  await expect(log).toBeVisible();
  await expect(page.locator('.spending-category[data-category="Food"]')).toBeVisible();
  // Start timing after load work and entrance animations, as a user interacting with a settled page would.
  await waitForQuietFrames(page);
  const value = (label: string) => card
    .locator('.clarity-value')
    .filter({ has: page.getByText(label, { exact: true }) })
    .locator('.clarity-value-amount');
  return {
    control,
    card,
    log,
    amount: page.getByRole('textbox', { name: 'Amount' }),
    note: page.getByRole('textbox', { name: 'Note (optional)' }),
    value,
    status: (scope: string) => page.locator(`[data-scope="${scope}"]`),
    row: (id: number) => page.locator(`#expense-${id}`),
    categoryTotal: (category: string) => page.locator(`.spending-category[data-category="${category}"] b.mono`),
    // Exact, because the success status offers "Dismiss Count Food as Wants message" beside the control.
    treatment: (category: string, to: 'Needs' | 'Wants') => page.getByRole('button', { name: `Count ${category} as ${to}`, exact: true }),
    notice: page.getByRole('region', { name: 'Latest change to your spending' }),
    entries: page.getByRole('heading', { name: `Recent entries for ${MONTH_NAME}` }),
  };
}

const isPath = (method: string, path: string) => (response: Response) => (
  new URL(response.url()).pathname === path && response.request().method() === method
);

test('logging an expense gives feedback within 100 ms, keeps one document, and leaves other controls and focus alone', async ({ page, api }, testInfo) => {
  const s = await openSpending(page, api);
  const initialReads = api.count('GET', CLARITY_READ);
  const initialListReads = api.count('GET', EXPENSE_LIST);
  const documentIdentity = await captureDocumentIdentity(page);
  const reloadSpy = await installReloadSpy(page);
  const focusTracker = await installFocusTracker(page);
  const gate = s.control.hold('POST', '/api/finance/expenses');

  // Submit: pending feedback beside the new entry within 100 ms.
  await s.amount.fill('170');
  await s.note.fill('Lunch');
  const pending = await measureSubmitToPaint(page, () => s.log.click(), {
    selector: '[data-pending-create]',
    text: 'Log expense: pending',
  });
  testInfo.annotations.push({ type: 'pending-to-paint-ms', description: pending.durationMs.toFixed(1) });
  testInfo.annotations.push({ type: 'pending-to-dom-ms', description: (pending.appearedAt - pending.eventAt).toFixed(1) });
  expectSubmitToPaintWithin(pending, BUDGET_MS);
  await expect(s.log).toBeFocused();
  await expect(page.locator('[data-pending-create]')).toContainText('Saving this expense…');
  await expect(s.card).toContainText('Refreshing…');
  // Calculated values keep their last confirmed numbers, and nothing is replaced by a loading state.
  await expect(s.value('Spent so far')).toHaveText('₹1,300');
  await expect(s.categoryTotal('Food')).toHaveText('₹700');
  await expect(page.getByText('Loading…', { exact: true })).toHaveCount(0);
  await expect(s.amount).toHaveValue('');

  // Another control works while the entry is pending, and becomes the active control.
  await s.note.fill('Second note');
  await expect(s.note).toBeFocused();
  const toWants = s.treatment('Transport', 'Wants');
  await expect(toWants).toBeEnabled();
  await expect(toWants).not.toHaveAttribute('aria-disabled', 'true');
  expect(api.count('POST', '/api/finance/expenses')).toBe(1);
  const focusEventsBeforeResponse = (await focusTracker.history()).length;

  // Response: the new totals, the done status, and the change notice within 100 ms.
  const responsePromise = page.waitForResponse(isPath('POST', '/api/finance/expenses'));
  gate.release();
  const outcome = await measureResponseToPaint(page, responsePromise, s.card.locator('.clarity-value-amount', { hasText: '₹1,470' }));
  testInfo.annotations.push({ type: 'response-to-paint-ms', description: outcome.durationMs.toFixed(1) });
  expect(outcome.status).toBe(200);
  await expectResponseToPaintWithin(outcome, BUDGET_MS);
  await expect(s.categoryTotal('Food')).toHaveText('₹870');
  await expect(s.value('Remaining spendable')).toHaveText('₹62,530');
  await expect(s.row(5)).toContainText('Log expense: done');
  await expect(s.row(5)).toContainText('Lunch');
  await expect(page.locator('[data-pending-create]')).toHaveCount(0);
  await expect(s.card).not.toContainText('Refreshing…');
  await expect(s.notice).toContainText('Added to Food');

  // Same document, no reload, no broad re-read, and focus where the user left it.
  await expectSameDocument(page, documentIdentity);
  await reloadSpy.expectNoReloads();
  expect(api.count('GET', CLARITY_READ)).toBe(initialReads);
  expect(api.count('GET', EXPENSE_LIST)).toBe(initialListReads);
  await expect(s.note).toHaveValue('Second note');
  await expect(s.note).toBeFocused();
  expect(await focusTracker.history()).toHaveLength(focusEventsBeforeResponse);
  expect((await focusTracker.active())?.tagName).toBe('input');
});

test('a failed correction keeps its draft and the confirmed values, and a retry confirms without a reload', async ({ page, api }, testInfo) => {
  const s = await openSpending(page, api);
  const documentIdentity = await captureDocumentIdentity(page);
  const reloadSpy = await installReloadSpy(page);
  s.control.backend.failNext('PATCH', '/finance/expenses/1', 500, 'SERVER_ERROR', 'The correction could not be saved.');
  const gate = s.control.hold('PATCH', '/api/finance/expenses/1');

  await page.getByRole('button', { name: 'Edit Food ₹500' }).click();
  const form = page.getByRole('form', { name: 'Correct Food ₹500' });
  await form.getByRole('textbox', { name: 'Amount' }).fill('650');
  await form.getByRole('textbox', { name: 'Note (optional)' }).fill('Lunch with team');
  const pending = await measureSubmitToPaint(page, () => form.getByRole('button', { name: 'Save changes' }).click(), {
    selector: '[data-scope="expense:1"]',
    text: 'Update Food expense: pending',
  });
  expectSubmitToPaintWithin(pending, BUDGET_MS);
  // Only this row shows the entered amount. Calculated values wait for the server.
  await expect(s.row(1)).toContainText('₹650');
  await expect(s.value('Spent so far')).toHaveText('₹1,300');
  await expect(page.getByRole('button', { name: 'Delete Transport ₹100' })).not.toHaveAttribute('aria-disabled', 'true');

  const failedResponse = page.waitForResponse(isPath('PATCH', '/api/finance/expenses/1'));
  gate.release();
  const failed = await measureResponseToPaint(page, failedResponse, s.status('expense:1').getByText('Update Food expense: failed.'));
  testInfo.annotations.push({ type: 'failure-response-to-paint-ms', description: failed.durationMs.toFixed(1) });
  expect(failed.status).toBe(500);
  await expectResponseToPaintWithin(failed, BUDGET_MS);
  await expect(s.status('expense:1')).toContainText('The correction could not be saved.');
  await expect(s.status('expense:1')).toContainText('Your last confirmed values are unchanged.');

  // The draft is back in the open form and the confirmed values are untouched.
  const reopened = page.getByRole('form', { name: 'Correct Food ₹500' });
  await expect(reopened.getByRole('textbox', { name: 'Amount' })).toHaveValue('650');
  await expect(reopened.getByRole('textbox', { name: 'Note (optional)' })).toHaveValue('Lunch with team');
  await expect(s.categoryTotal('Food')).toHaveText('₹700');
  await expect(s.value('Spent so far')).toHaveText('₹1,300');
  await expect(s.card).not.toContainText('Refreshing…');
  await expect(s.notice).toHaveCount(0);
  await expectSameDocument(page, documentIdentity);
  await reloadSpy.expectNoReloads();

  // Retry resends the same change and finishes it the way a first save finishes.
  const retry = s.status('expense:1').getByRole('button', { name: 'Retry Update Food expense' });
  const retriedPending = await measureSubmitToPaint(page, () => retry.click(), {
    selector: '[data-scope="expense:1"]',
    text: 'Update Food expense: pending',
  }, 'click');
  expectSubmitToPaintWithin(retriedPending, BUDGET_MS);
  await expect(s.status('expense:1')).toContainText('Update Food expense: done');
  await expect(s.categoryTotal('Food')).toHaveText('₹850');
  await expect(s.value('Spent so far')).toHaveText('₹1,450');
  await expect(page.getByRole('form', { name: /^Correct Food/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Edit Food ₹650' })).toBeFocused();
  expect(api.count('PATCH', '/api/finance/expenses/1')).toBe(2);
  await expectSameDocument(page, documentIdentity);
  await reloadSpy.expectNoReloads();
});

test('reclassifying a category moves spending between Needs and Wants within 100 ms and leaves the totals and focus alone', async ({ page, api }) => {
  const s = await openSpending(page, api);
  const documentIdentity = await captureDocumentIdentity(page);
  const reloadSpy = await installReloadSpy(page);
  const gate = s.control.hold('PUT', '/api/finance/category-treatments/Food');
  const toWants = s.treatment('Food', 'Wants');

  const pending = await measureSubmitToPaint(page, () => toWants.click(), {
    selector: '[data-scope="category-treatment:food"]',
    text: 'Count Food as Wants: pending',
  }, 'click');
  expectSubmitToPaintWithin(pending, BUDGET_MS);
  await expect(toWants).toBeFocused();
  await expect(toWants).toHaveAttribute('aria-pressed', 'true');
  // The buckets wait for the server. Another category stays usable.
  await expect(s.value('Needs spent of budget')).toHaveText('₹800 of ₹40,000');
  await expect(s.treatment('Shopping', 'Needs')).not.toHaveAttribute('aria-disabled', 'true');

  const responsePromise = page.waitForResponse(isPath('PUT', '/api/finance/category-treatments/Food'));
  gate.release();
  const outcome = await measureResponseToPaint(page, responsePromise, s.card.locator('.clarity-value-amount', { hasText: '₹100 of ₹40,000' }));
  await expectResponseToPaintWithin(outcome, BUDGET_MS);
  await expect(s.value('Wants spent of budget')).toHaveText('₹1,200 of ₹24,000');
  // Total spending, remaining, and projected savings do not move.
  await expect(s.value('Spent so far')).toHaveText('₹1,300');
  await expect(s.value('Remaining spendable')).toHaveText('₹62,700');
  await expect(s.value('Projected savings')).toHaveText('₹78,700');
  await expect(s.status('category-treatment:food')).toContainText('Count Food as Wants: done');
  await expect(page.locator('.spending-category[data-category="Food"]')).toContainText('Counted as Wants (your choice)');
  await expect(toWants).toBeFocused();
  await expectSameDocument(page, documentIdentity);
  await reloadSpy.expectNoReloads();
});

test('two changes answered in the opposite order report on their own and end in the server state', async ({ page, api }) => {
  const s = await openSpending(page, api);
  const documentIdentity = await captureDocumentIdentity(page);
  const reloadSpy = await installReloadSpy(page);
  const edit = s.control.hold('PATCH', '/api/finance/expenses/2');
  const remove = s.control.hold('DELETE', '/api/finance/expenses/3');

  await page.getByRole('button', { name: 'Edit Shopping ₹500' }).click();
  const form = page.getByRole('form', { name: 'Correct Shopping ₹500' });
  await form.getByRole('textbox', { name: 'Amount' }).fill('700');
  await measureSubmitToPaint(page, () => form.getByRole('button', { name: 'Save changes' }).click(), {
    selector: '[data-scope="expense:2"]',
    text: 'Update Shopping expense: pending',
  });
  const deletePending = await measureSubmitToPaint(page, () => page.getByRole('button', { name: 'Delete Transport ₹100' }).click(), {
    selector: '[data-scope="expense:3"]',
    text: 'Delete Transport expense: pending',
  }, 'click');
  expectSubmitToPaintWithin(deletePending, BUDGET_MS);
  // Each change has its own pending status, and the confirmed values have not moved.
  await expect(s.status('expense:2')).toContainText('Update Shopping expense: pending');
  await expect(s.status('expense:3')).toContainText('Delete Transport expense: pending');
  await expect(s.value('Spent so far')).toHaveText('₹1,300');

  // The delete was submitted second and is answered first.
  const deleteResponse = page.waitForResponse(isPath('DELETE', '/api/finance/expenses/3'));
  remove.release();
  const deleted = await measureResponseToPaint(page, deleteResponse, s.card.locator('.clarity-value-amount', { hasText: '₹1,200' }));
  await expectResponseToPaintWithin(deleted, BUDGET_MS);
  await expect(s.notice).toContainText('Removed from Transport');
  await expect(s.status('expense:2')).toContainText('Update Shopping expense: pending');
  await expect(s.row(3)).toHaveCount(0);

  const editResponse = page.waitForResponse(isPath('PATCH', '/api/finance/expenses/2'));
  edit.release();
  const edited = await measureResponseToPaint(page, editResponse, s.card.locator('.clarity-value-amount', { hasText: '₹1,400' }));
  await expectResponseToPaintWithin(edited, BUDGET_MS);
  await expect(s.status('expense:2')).toContainText('Update Shopping expense: done');
  // The deleted row, and the status on it, are gone for good.
  await expect(s.row(3)).toHaveCount(0);
  await expect(s.categoryTotal('Shopping')).toHaveText('₹700');
  await expect(s.value('Wants spent of budget')).toHaveText('₹700 of ₹24,000');
  await expect(s.value('Needs spent of budget')).toHaveText('₹700 of ₹40,000');
  await expect(s.card).not.toContainText('Refreshing…');
  await expectSameDocument(page, documentIdentity);
  await reloadSpy.expectNoReloads();
});

test('deleting a row from the keyboard shows pending within 100 ms and does not drop focus to the page', async ({ page, api }) => {
  const s = await openSpending(page, api);
  const documentIdentity = await captureDocumentIdentity(page);
  const reloadSpy = await installReloadSpy(page);
  const gate = s.control.hold('DELETE', '/api/finance/expenses/3');
  const remove = page.getByRole('button', { name: 'Delete Transport ₹100' });
  await remove.focus();

  const pending = await measureSubmitToPaint(page, () => page.keyboard.press('Enter'), {
    selector: '[data-scope="expense:3"]',
    text: 'Delete Transport expense: pending',
  }, 'click');
  expectSubmitToPaintWithin(pending, BUDGET_MS);
  await expect(remove).toBeFocused();
  await expect(remove).toHaveAttribute('aria-disabled', 'true');
  await expect(s.row(3)).toContainText('₹100');

  const responsePromise = page.waitForResponse(isPath('DELETE', '/api/finance/expenses/3'));
  gate.release();
  const outcome = await measureResponseToPaint(page, responsePromise, s.card.locator('.clarity-value-amount', { hasText: '₹1,200' }));
  await expectResponseToPaintWithin(outcome, BUDGET_MS);
  await expect(s.row(3)).toHaveCount(0);
  await expect(s.notice).toContainText('Removed from Transport');
  // The row that held focus is gone, so focus moves to the list heading instead of the page.
  await expect(s.entries).toBeFocused();
  await expectSameDocument(page, documentIdentity);
  await reloadSpy.expectNoReloads();
});

test('a retried new expense that replaces its failed row moves focus to the entries list, not the page', async ({ page, api }) => {
  const s = await openSpending(page, api);
  const documentIdentity = await captureDocumentIdentity(page);
  const reloadSpy = await installReloadSpy(page);
  s.control.backend.failNext('POST', '/finance/expenses', 500, 'SERVER_ERROR', 'The expense could not be saved.');

  await s.amount.fill('90');
  await s.log.click();
  const failedRow = page.locator('[data-pending-create]');
  await expect(failedRow).toContainText('Log expense: failed.');
  await expect(failedRow).toContainText('₹90');
  await expect(s.value('Spent so far')).toHaveText('₹1,300');
  await failedRow.getByRole('button', { name: 'Retry Log expense' }).focus();
  const gate = s.control.hold('POST', '/api/finance/expenses');
  await page.keyboard.press('Enter');
  await expect(failedRow).toContainText('Log expense: pending');
  // The Retry button became status text. Focus stays inside the row.
  expect(await failedRow.evaluate((row) => row.contains(document.activeElement))).toBe(true);

  const responsePromise = page.waitForResponse(isPath('POST', '/api/finance/expenses'));
  gate.release();
  const outcome = await measureResponseToPaint(page, responsePromise, s.card.locator('.clarity-value-amount', { hasText: '₹1,390' }));
  await expectResponseToPaintWithin(outcome, BUDGET_MS);
  await expect(s.row(5)).toContainText('₹90');
  await expect(failedRow).toHaveCount(0);
  await expect(s.entries).toBeFocused();
  await expectSameDocument(page, documentIdentity);
  await reloadSpy.expectNoReloads();
});

// Reduced motion is a statement about the real stylesheet, so this test runs without the
// paint-budget neutralization.
test.describe('against the real stylesheet', () => {
  test.use({ neutralizeDecorativeRendering: false });

  test('with reduced motion the spending regions change state without transitions, and nothing scrolls sideways', async ({ page, api }) => {
    const s = await openSpending(page, api);
    await emulateReducedMotion(page);
    await expectReducedMotion(page);
    const durations = await page.evaluate(() => {
      const read = (selector: string) => {
        const element = document.querySelector(selector);
        return element ? getComputedStyle(element).transitionDuration.split(',').map((value) => value.trim()) : [];
      };
      return { row: read('.spending-expense'), card: read('.clarity-outcome'), status: read('.clarity-mutation') };
    });
    for (const list of Object.values(durations)) {
      expect(list.length).toBeGreaterThan(0);
      // The global reduced-motion rule shortens every transition to a thousandth of a millisecond.
      for (const duration of list) expect(Number.parseFloat(duration) * (duration.endsWith('ms') ? 1 : 1000)).toBeLessThanOrEqual(0.01);
    }
    await s.treatment('Food', 'Wants').click();
    await expect(s.status('category-treatment:food')).toContainText('Count Food as Wants: done');
    await expect(s.value('Needs spent of budget')).toHaveText('₹100 of ₹40,000');
    await expectNoOverflowOrClipping(page);
  });
});

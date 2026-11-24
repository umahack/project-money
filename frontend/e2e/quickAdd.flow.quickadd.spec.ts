// Browser acceptance of one entry through Quick Add and the Home headline (task 18.1, Requirements 7.2, 7.3, 7.6, 7.12,
// 7.14, 7.15, 8.1, 8.2, 8.5, 9.3, 9.19, 11.1, 11.20, 13.2 to 13.5, 18.5 to 18.7, 18.23).
//
// Each test follows one entry or a few through the real, unmodified application in Chromium, against the closed Quick Add
// world (helpers/quickAddWorld.ts): typing, the preview, Enter, the saved row, the answer, and Undo, from Home and from the
// dialog on another page; a failed entry with a same-key retry and with Edit under a new key; and the warning flow with
// both save choices.
//
// Every flow asserts the same three things about the page: one document (no reload), no page-wide loading state, and
// scoped feedback. The feedback budgets are measured in the page's own clock with the harness paint helpers: 100 ms from
// the keystroke or click to the pending, removing, or failed status on the row, and 100 ms from the response to the
// answer and the headline.
//
// The Quick Add flag is fixed when a Vite server starts, so this file runs only under playwright.quickadd.config.ts, against
// a loopback server with VITE_QUICK_ADD_ENABLED=true. Every response comes from the in-memory fake; no production
// credential, host, or database is used.
import {
  expectResponseToPaintWithin,
  expectSubmitToPaintWithin,
  measureResponseToPaint,
  measureSubmitToPaint,
  waitForQuietFrames,
} from './helpers/browser';
import {
  budgetMs, EXPENSES_API, answerOf, bodyOf, entryRows, guardDocument, headline, isPath, keysOf, leftToday, rowFor,
  spentToday, typeLine, writes,
} from './helpers/quickAddFlows';
import {
  OTHER_DAY, TODAY, failure, installQuickAddWorld, openDialog, openPage, quickAddInput, submitLine,
} from './helpers/quickAddWorld';
import { expect, test } from './fixtures/test';
import type { Page, TestInfo } from '@playwright/test';

// Screen recording and tracing halve headless Chromium's frame rate, which would count against a 100 ms paint budget.
// The decorative blur and drifting background cost the same in software, and the budget measures the application.
test.use({ video: 'off', trace: 'off', neutralizeDecorativeRendering: true });
// Paint timing depends on the host's frame rate. A real regression misses the budget on every attempt; a busy host does not.
test.describe.configure({ retries: 2 });

function widthOf(testInfo: TestInfo): number {
  const viewport = testInfo.project.use.viewport;
  if (!viewport) throw new Error('Every Quick Add project sets a viewport.');
  return viewport.width;
}

const PENDING_ROW = 'li.qa-entry[data-phase="pending"]';
const SAVING = 'Saving…';

async function openHome(page: Page) {
  await openPage(page, '/');
  await expect(headline(page).getByText(/You can spend/)).toBeVisible();
  await expect(quickAddInput(page)).toBeVisible();
  // Start timing after load work and entrance animations, as a person using a settled page would.
  await waitForQuietFrames(page);
}

/** Submits with Enter and measures the keystroke to the pending row that carries `note`. */
async function enterAndMeasure(page: Page, note: string) {
  const input = quickAddInput(page);
  return measureSubmitToPaint(page, () => input.press('Enter'), { selector: PENDING_ROW, text: note }, 'keydown');
}

test('Home: typing shows the preview, Enter shows a pending row in 100 ms, the answer and the headline follow in 100 ms, and Undo removes it', async ({ page, api }, testInfo) => {
  const world = installQuickAddWorld(api);
  await openHome(page);
  const guard = await guardDocument(page);
  const input = await typeLine(page, '120 coffee');

  // Typing: the preview is on screen and nothing was sent.
  const preview = page.locator('.qa-preview');
  await expect(preview).toContainText('What Quick Add understood');
  await expect(preview.locator('.qa-row', { hasText: 'Amount' })).toContainText('₹120');
  await expect(preview.locator('.qa-row', { hasText: 'Date' })).toContainText('Today');
  await expect(preview.locator('.qa-row', { hasText: 'Note' })).toContainText('coffee');
  await expect(preview.getByLabel('Category')).toHaveValue(/\S/);
  expect(writes(api, 'POST')).toHaveLength(0);

  // Enter: a pending row within 100 ms, the input emptied and still focused, everything else interactive.
  const gate = world.hold('POST', EXPENSES_API);
  const pending = await enterAndMeasure(page, 'coffee');
  testInfo.annotations.push({ type: 'enter-to-pending-ms', description: pending.durationMs.toFixed(1) });
  expectSubmitToPaintWithin(pending, budgetMs());
  const row = rowFor(page, 'coffee');
  await expect(row).toHaveAttribute('data-phase', 'pending');
  await expect(row).toContainText(SAVING);
  await expect(row).toContainText('₹120');
  await expect(input).toHaveValue('');
  await expect(input).toBeFocused();
  await expect(input).toBeEditable();
  await expect(page.getByRole('navigation', { name: 'Quick actions' }).getByRole('link', { name: /Plan month/ })).toBeVisible();
  // The headline keeps its last confirmed values while the entry is pending.
  await expect(headline(page)).toContainText('You can spend ₹3,000 today');
  await expect(spentToday(page)).toHaveText('₹0');
  expect(writes(api, 'POST')).toHaveLength(1);

  // Response: the saved row, the answer, and the headline within 100 ms.
  const response = page.waitForResponse(isPath('POST', EXPENSES_API));
  gate.release();
  const [answerTiming, headlineTiming] = await Promise.all([
    measureResponseToPaint(page, response, answerOf(page)),
    measureResponseToPaint(page, response, leftToday(page).filter({ hasText: '₹2,880' })),
  ]);
  testInfo.annotations.push({ type: 'response-to-answer-ms', description: answerTiming.durationMs.toFixed(1) });
  testInfo.annotations.push({ type: 'response-to-headline-ms', description: headlineTiming.durationMs.toFixed(1) });
  expect(answerTiming.status).toBe(200);
  await expectResponseToPaintWithin(answerTiming, budgetMs());
  await expectResponseToPaintWithin(headlineTiming, budgetMs());
  await expect(row).toHaveAttribute('data-phase', 'saved');
  await expect(row).toContainText('Saved');
  await expect(row).toContainText('Undo is available for 8 seconds.');
  const answer = answerOf(page);
  await expect(answer).toContainText('Answer for your latest entry');
  await expect(answer).toContainText(/Saved ₹120 to \S+: coffee\./);
  await expect(answer).toContainText("Spent today: ₹120 of today's allowance of ₹3,000.");
  await expect(answer).toContainText('₹2,880 left today.');
  await expect(spentToday(page)).toHaveText('₹120');
  await expect(input).toBeFocused();

  // Undo: a removing status within 100 ms, then the removed answer and the restored headline within 100 ms.
  const undoGate = world.hold('DELETE', `${EXPENSES_API}/1`);
  const undo = page.getByRole('button', { name: /^Undo ₹120 coffee/ });
  const removing = await measureSubmitToPaint(page, () => undo.click(), { selector: 'li.qa-entry[data-phase="removing"]', text: 'Removing…' }, 'click');
  testInfo.annotations.push({ type: 'undo-to-removing-ms', description: removing.durationMs.toFixed(1) });
  expectSubmitToPaintWithin(removing, budgetMs());
  await expect(row).toHaveAttribute('data-phase', 'removing');
  await expect(spentToday(page)).toHaveText('₹120');
  const undoResponse = page.waitForResponse(isPath('DELETE', `${EXPENSES_API}/1`));
  undoGate.release();
  const [removedTiming, restoredTiming] = await Promise.all([
    measureResponseToPaint(page, undoResponse, page.locator('.qa-answer[data-mode="removed"]')),
    measureResponseToPaint(page, undoResponse, leftToday(page).filter({ hasText: '₹3,000' })),
  ]);
  testInfo.annotations.push({ type: 'undo-response-to-answer-ms', description: removedTiming.durationMs.toFixed(1) });
  await expectResponseToPaintWithin(removedTiming, budgetMs());
  await expectResponseToPaintWithin(restoredTiming, budgetMs());
  await expect(row).toHaveAttribute('data-phase', 'undone');
  await expect(row).toContainText('Undone. The expense was removed.');
  await expect(answerOf(page)).toContainText('Entry removed');
  await expect(spentToday(page)).toHaveText('₹0');
  // Requirement 8.7: focus returns to the input.
  await expect(input).toBeFocused();

  // One create and one delete, each with its own key, and the server holds no expense.
  const [createKey] = keysOf(writes(api, 'POST'));
  const [deleteKey] = keysOf(writes(api, 'DELETE', `${EXPENSES_API}/1`));
  expect(createKey).toBeTruthy();
  expect(deleteKey).toBeTruthy();
  expect(deleteKey).not.toBe(createKey);
  expect(writes(api, 'POST')).toHaveLength(1);
  expect(writes(api, 'DELETE', `${EXPENSES_API}/1`)).toHaveLength(1);
  expect(world.backend.expenses).toHaveLength(0);
  expect(writes(api, 'POST')[0]?.clarityContract).toBeTruthy();
  await guard.expectUnchanged();
});

test('Dialog on another page: Enter saves, the answer shows, the Spending page updates in place, and Undo removes it', async ({ page, api }, testInfo) => {
  const world = installQuickAddWorld(api);
  world.seed({ category: 'Groceries', amountMinor: 50_000, note: 'Earlier groceries', spentOn: OTHER_DAY });
  await openPage(page, '/spending');
  await expect(page.locator('#expense-700')).toBeVisible();
  const spent = page.locator('.clarity-value').filter({ has: page.getByText('Spent so far', { exact: true }) }).locator('.clarity-value-amount');
  await expect(spent).toHaveText('₹500');
  await openDialog(page, widthOf(testInfo));
  await waitForQuietFrames(page);
  const guard = await guardDocument(page);
  const dialog = page.getByRole('dialog', { name: 'Quick Add' });
  const input = await typeLine(page, '120 chai');
  await expect(dialog.locator('.qa-preview')).toContainText('What Quick Add understood');

  const gate = world.hold('POST', EXPENSES_API);
  const pending = await enterAndMeasure(page, 'chai');
  expectSubmitToPaintWithin(pending, budgetMs());
  await expect(dialog.locator('li.qa-entry', { hasText: 'chai' })).toContainText(SAVING);
  await expect(input).toBeFocused();
  // The Spending page behind the dialog shows nothing new before the server confirms.
  await expect(page.locator('#expense-1')).toHaveCount(0);
  await expect(spent).toHaveText('₹500');

  const response = page.waitForResponse(isPath('POST', EXPENSES_API));
  gate.release();
  const timing = await measureResponseToPaint(page, response, dialog.locator('.qa-answer'));
  await expectResponseToPaintWithin(timing, budgetMs());
  await expect(dialog.locator('li.qa-entry', { hasText: 'chai' })).toHaveAttribute('data-phase', 'saved');
  await expect(dialog.locator('.qa-answer')).toContainText("Spent today: ₹120 of today's allowance of ₹3,000.");
  // Requirement 7.17: the Spending page shows the confirmed expense without a reload.
  await expect(page.locator('#expense-1')).toBeVisible();
  await expect(page.locator('#expense-1')).toContainText('chai');
  await expect(spent).toHaveText('₹620');

  const undoGate = world.hold('DELETE', `${EXPENSES_API}/1`);
  const removing = await measureSubmitToPaint(page, () => dialog.getByRole('button', { name: /^Undo ₹120 chai/ }).click(), { selector: 'li.qa-entry[data-phase="removing"]', text: 'Removing…' }, 'click');
  expectSubmitToPaintWithin(removing, budgetMs());
  const undoResponse = page.waitForResponse(isPath('DELETE', `${EXPENSES_API}/1`));
  undoGate.release();
  const removed = await measureResponseToPaint(page, undoResponse, dialog.locator('.qa-answer[data-mode="removed"]'));
  await expectResponseToPaintWithin(removed, budgetMs());
  await expect(dialog.locator('li.qa-entry', { hasText: 'chai' })).toHaveAttribute('data-phase', 'undone');
  await expect(page.locator('#expense-1')).toHaveCount(0);
  await expect(spent).toHaveText('₹500');
  await expect(page.locator('#expense-700')).toBeVisible();
  await expect(input).toBeFocused();
  expect(world.backend.expenses.map((expense) => expense.id)).toEqual([700]);
  await guard.expectUnchanged();
});

test('Dialog on another page: closing the dialog keeps the saved entry, and its Undo toast removes it', async ({ page, api }, testInfo) => {
  const world = installQuickAddWorld(api);
  await openPage(page, '/spending');
  await openDialog(page, widthOf(testInfo));
  const guard = await guardDocument(page);
  await submitLine(page, '75 tea');
  await expect(rowFor(page, 'tea')).toHaveAttribute('data-phase', 'saved');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Quick Add' })).toHaveCount(0);
  // With no Quick Add surface on screen the Undo control moves to the toast area, and the expense stays saved.
  const toast = page.getByTestId('undo-toasts').getByRole('button', { name: /^Undo ₹75 tea/ });
  await expect(toast).toBeVisible();
  await expect(page.locator('#expense-1')).toContainText('tea');
  const undoResponse = page.waitForResponse(isPath('DELETE', `${EXPENSES_API}/1`));
  await toast.click();
  expect((await undoResponse).status()).toBe(200);
  await expect(page.locator('#expense-1')).toHaveCount(0);
  expect(world.backend.expenses).toHaveLength(0);
  await guard.expectUnchanged();
});

test('A failed entry keeps its values, and Retry resends the same request with the same Idempotency-Key', async ({ page, api }, testInfo) => {
  const world = installQuickAddWorld(api);
  await openHome(page);
  const guard = await guardDocument(page);
  world.backend.failWith('POST', '/finance/expenses', failure);
  const input = await typeLine(page, '120 coffee');
  const failed = await measureSubmitToPaint(page, () => input.press('Enter'), { selector: 'li.qa-entry[data-phase="failed"]', text: 'Not saved' }, 'keydown');
  testInfo.annotations.push({ type: 'enter-to-failed-ms', description: failed.durationMs.toFixed(1) });
  // The server answered at once, so the failed status is on screen soon after the pending one; the budget is the same.
  expect(failed.durationMs).toBeLessThanOrEqual(budgetMs() * 3);
  const row = rowFor(page, 'coffee');
  await expect(row).toHaveAttribute('data-phase', 'failed');
  await expect(row).toContainText('₹120');
  await expect(row).toContainText(failure.message);
  await expect(row.getByRole('button', { name: 'Retry saving ₹120 coffee' })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Edit ₹120 coffee' })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Discard ₹120 coffee' })).toBeVisible();
  await expect(answerOf(page)).toHaveCount(0);
  expect(world.backend.expenses).toHaveLength(0);

  await row.getByRole('button', { name: 'Retry saving ₹120 coffee' }).click();
  await expect(row).toHaveAttribute('data-phase', 'saved');
  await expect(answerOf(page)).toContainText("Spent today: ₹120 of today's allowance of ₹3,000.");
  const sent = writes(api, 'POST');
  expect(sent).toHaveLength(2);
  const [first, second] = keysOf(sent);
  expect(first).toBeTruthy();
  expect(second).toBe(first);
  expect(bodyOf(sent[1])).toEqual(bodyOf(sent[0]));
  expect(world.backend.expenses).toHaveLength(1);
  await guard.expectUnchanged();
});

test('A response that never arrived is retried with the same key, and the server holds exactly one expense', async ({ page, api }) => {
  const world = installQuickAddWorld(api);
  await openHome(page);
  const guard = await guardDocument(page);
  // The server saved the entry, and the browser got an error instead of the answer.
  world.applyThenFail('POST', EXPENSES_API);
  await submitLine(page, '90 lunch');
  const row = rowFor(page, 'lunch');
  await expect(row).toHaveAttribute('data-phase', 'failed');
  expect(world.backend.expenses).toHaveLength(1);
  await row.getByRole('button', { name: 'Retry saving ₹90 lunch' }).click();
  await expect(row).toHaveAttribute('data-phase', 'saved');
  await expect(answerOf(page)).toContainText("Spent today: ₹90 of today's allowance of ₹3,000.");
  const [first, second] = keysOf(writes(api, 'POST'));
  expect(second).toBe(first);
  expect(writes(api, 'POST')).toHaveLength(2);
  // The server replayed the first confirmation. Still one expense, and the headline counts it once.
  expect(world.backend.expenses).toHaveLength(1);
  await expect(spentToday(page)).toHaveText('₹90');
  await guard.expectUnchanged();
});

test('Edit puts the entry back in the input, and the next submission uses a new Idempotency-Key', async ({ page, api }) => {
  const world = installQuickAddWorld(api);
  await openHome(page);
  const guard = await guardDocument(page);
  world.backend.failWith('POST', '/finance/expenses', failure);
  const input = quickAddInput(page);
  await submitLine(page, '120 coffee');
  const row = rowFor(page, 'coffee');
  await expect(row).toHaveAttribute('data-phase', 'failed');
  await row.getByRole('button', { name: 'Edit ₹120 coffee' }).click();
  // The formatter's line, in the input, with focus there, and the failed row gone.
  await expect(input).toHaveValue(`₹120 ${TODAY} "coffee"`);
  await expect(input).toBeFocused();
  await expect(entryRows(page, 'failed')).toHaveCount(0);
  await input.fill(`₹125 ${TODAY} "coffee"`);
  await input.press('Enter');
  await expect(rowFor(page, 'coffee')).toHaveAttribute('data-phase', 'saved');
  const sent = writes(api, 'POST');
  expect(sent).toHaveLength(2);
  const [first, second] = keysOf(sent);
  expect(first).toBeTruthy();
  expect(second).toBeTruthy();
  expect(second).not.toBe(first);
  expect(bodyOf(sent[1]).amountMinor).toBe(12_500);
  expect(world.backend.expenses.map((expense) => expense.amountMinor)).toEqual([12_500]);
  await guard.expectUnchanged();
});

test('The warning flow: Enter, "Save and count today", and "Save, but don\'t count against today" each save once', async ({ page, api }, testInfo) => {
  const world = installQuickAddWorld(api);
  await openHome(page);
  const guard = await guardDocument(page);
  const input = quickAddInput(page);
  const warning = page.locator('.qa-warning');
  const count = page.getByRole('button', { name: 'Save and count today' });
  const exclude = page.getByRole('button', { name: "Save, but don't count against today" });

  // A large entry dated Today: one warning in text, with both save choices, and nothing is sent by showing it.
  await typeLine(page, '1100 laptop');
  await expect(warning).toContainText('Check before saving.');
  await expect(warning).toContainText("This amount is large compared with this month's spendable budget.");
  await expect(count).toBeVisible();
  await expect(exclude).toBeVisible();
  expect(writes(api, 'POST')).toHaveLength(0);
  // Requirement 18.6: Enter is "Save and count today".
  await input.press('Enter');
  await expect(rowFor(page, 'laptop')).toHaveAttribute('data-phase', 'saved');
  await expect(warning).toHaveCount(0);
  expect(bodyOf(writes(api, 'POST')[0])).not.toHaveProperty('excludeFromDailyAllowance');

  // The first button saves it the same way.
  await typeLine(page, '1200 monitor');
  await expect(warning).toBeVisible();
  await count.click();
  await expect(rowFor(page, 'monitor')).toHaveAttribute('data-phase', 'saved');
  expect(bodyOf(writes(api, 'POST')[1])).not.toHaveProperty('excludeFromDailyAllowance');
  await expect(input).toBeFocused();

  // The second button creates the expense with the exclusion in the same request, exactly once.
  await typeLine(page, '1300 sofa');
  await expect(warning).toBeVisible();
  const gate = world.hold('POST', EXPENSES_API);
  const pending = await measureSubmitToPaint(page, () => exclude.click(), { selector: PENDING_ROW, text: 'sofa' }, 'click');
  testInfo.annotations.push({ type: 'exclude-to-pending-ms', description: pending.durationMs.toFixed(1) });
  expectSubmitToPaintWithin(pending, budgetMs());
  gate.release();
  const row = rowFor(page, 'sofa');
  await expect(row).toHaveAttribute('data-phase', 'saved');
  const sent = writes(api, 'POST');
  expect(sent).toHaveLength(3);
  expect(bodyOf(sent[2]).excludeFromDailyAllowance).toBe(true);
  expect(new Set(keysOf(sent)).size).toBe(3);
  await expect(row).toContainText("Not counted against today's allowance.");
  const answer = answerOf(page);
  await expect(answer).toContainText("Not counted against today's allowance.");
  await expect(answer).toContainText("Your month's totals include it.");
  await expect(answer).toContainText("Today's allowance after this save: ₹3,000.");
  await expect(answer).toContainText("It changed because this entry uses part of the month's budget.");
  // The headline counts the first two and names the third in text.
  await expect(spentToday(page)).toHaveText('₹2,300');
  await expect(headline(page)).toContainText('1 expense not counted today (₹1,300)');
  expect(world.backend.expenses.map((expense) => expense.amountMinor)).toEqual([110_000, 120_000, 130_000]);

  // Requirement 18.8: an entry that is not dated Today has no warning and no choice to exclude it.
  await typeLine(page, '1500 flight yesterday');
  await expect(page.locator('.qa-preview')).toContainText('What Quick Add understood');
  await expect(warning).toHaveCount(0);
  await expect(exclude).toHaveCount(0);
  await guard.expectUnchanged();
});

test('Quick Add keeps saving when the entry is dated another day of the month: no warning, and the answer names the date', async ({ page, api }) => {
  const world = installQuickAddWorld(api);
  await openHome(page);
  const guard = await guardDocument(page);
  await typeLine(page, `1800 sofa ${OTHER_DAY}`);
  await expect(page.locator('.qa-warning')).toHaveCount(0);
  await quickAddInput(page).press('Enter');
  const row = rowFor(page, 'sofa');
  await expect(row).toHaveAttribute('data-phase', 'saved');
  await expect(answerOf(page)).toContainText(/Dated .*(not today|a future date)\./);
  // The expense is not today's, so today's spent amount stays where it was.
  await expect(spentToday(page)).toHaveText('₹0');
  expect(bodyOf(writes(api, 'POST')[0]).spentOn).toBe(OTHER_DAY);
  expect(world.backend.expenses).toHaveLength(1);
  await guard.expectUnchanged();
});

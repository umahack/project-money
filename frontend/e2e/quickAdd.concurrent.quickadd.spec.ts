// Browser acceptance of several entries at once (task 18.1, Requirements 7.12, 7.14, 7.15, 9.15, 9.16, 13.4, 13.5).
//
// Five entries are submitted in quick succession and stay pending together. Each has its own Idempotency-Key and its own
// status row, and the sixth is refused with the line kept (Requirement 7.12). The server applies each request when it
// arrives and holds only the response (`holdResponse`), so releasing the responses in order or out of order plays the two
// cases of Requirement 7.15: every entry is saved exactly once, a late older response never replaces a newer answer
// (Requirement 9.15), and a failed entry leaves the others as they were.
//
// The Quick Add flag is fixed when a Vite server starts, so this file runs only under playwright.quickadd.config.ts. Every
// response comes from the in-memory fake on loopback; no production credential or host is used.
import {
  expectSubmitToPaintWithin,
  measureSubmitToPaint,
  waitForQuietFrames,
} from './helpers/browser';
import {
  budgetMs, EXPENSES_API, answerOf, bodyOf, entryRows, guardDocument, headline, keysOf, leftToday, rowFor, spentToday,
  waitForWrites, writes,
} from './helpers/quickAddFlows';
import { failure, installQuickAddWorld, openPage, quickAddInput, type QuickAddWorld } from './helpers/quickAddWorld';
import { expect, test, type DeterministicApiFixtures } from './fixtures/test';
import type { Page } from '@playwright/test';

test.use({ video: 'off', trace: 'off', neutralizeDecorativeRendering: true });
test.describe.configure({ retries: 2 });

/** Five entries: amounts 10 to 50 rupees, each with a note that no other entry shares and no category keyword. */
const ENTRIES = [
  { amount: 10, note: 'alpha' },
  { amount: 20, note: 'bravo' },
  { amount: 30, note: 'charlie' },
  { amount: 40, note: 'delta' },
  { amount: 50, note: 'echo' },
] as const;
const PENDING_ROW = 'li.qa-entry[data-phase="pending"]';

async function openHome(page: Page) {
  await openPage(page, '/');
  await expect(headline(page).getByText(/You can spend/)).toBeVisible();
  await expect(quickAddInput(page)).toBeVisible();
  await waitForQuietFrames(page);
}

/**
 * Submits entry `index` and waits until the server has its request, so requests reach the server in submission order.
 * Returns the data version the server had after applying it, when the server applies on arrival.
 */
async function submitEntry(page: Page, api: DeterministicApiFixtures, world: QuickAddWorld, index: number): Promise<number> {
  const { amount, note } = ENTRIES[index] as (typeof ENTRIES)[number];
  const input = quickAddInput(page);
  await input.fill(`${amount} ${note}`);
  const timing = await measureSubmitToPaint(page, () => input.press('Enter'), { selector: PENDING_ROW, text: note }, 'keydown');
  expectSubmitToPaintWithin(timing, budgetMs());
  await waitForWrites(api, 'POST', index + 1);
  return world.backend.dataVersion;
}

/** Submits all five entries and returns the data version after each. */
async function submitAll(page: Page, api: DeterministicApiFixtures, world: QuickAddWorld): Promise<number[]> {
  const versions: number[] = [];
  for (let index = 0; index < ENTRIES.length; index += 1) {
    versions.push(await submitEntry(page, api, world, index));
    // The previous entries are still pending, and each has a row of its own.
    await expect(entryRows(page, 'pending')).toHaveCount(index + 1);
  }
  return versions;
}

test('Five entries pending together each have their own key and row, and the sixth is refused with its line kept', async ({ page, api }) => {
  const world = installQuickAddWorld(api);
  await openHome(page);
  const guard = await guardDocument(page);
  const gates = ENTRIES.map(() => world.hold('POST', EXPENSES_API));
  const input = quickAddInput(page);
  for (let index = 0; index < ENTRIES.length; index += 1) {
    const { amount, note } = ENTRIES[index] as (typeof ENTRIES)[number];
    await input.fill(`${amount} ${note}`);
    const timing = await measureSubmitToPaint(page, () => input.press('Enter'), { selector: PENDING_ROW, text: note }, 'keydown');
    expectSubmitToPaintWithin(timing, budgetMs());
    await waitForWrites(api, 'POST', index + 1);
    await expect(input).toBeFocused();
  }

  // Five rows, each pending on its own, with its own amount and note, and the page around them unchanged.
  await expect(entryRows(page, 'pending')).toHaveCount(5);
  for (const { amount, note } of ENTRIES) {
    await expect(rowFor(page, note)).toContainText(`₹${amount}`);
    await expect(rowFor(page, note)).toContainText('Saving…');
  }
  await expect(headline(page)).toContainText('You can spend ₹3,000 today');
  await expect(spentToday(page)).toHaveText('₹0');
  const keys = keysOf(writes(api, 'POST'));
  expect(keys).toHaveLength(5);
  expect(keys.every(Boolean)).toBe(true);
  expect(new Set(keys).size).toBe(5);

  // Requirement 7.12: a sixth line is kept, nothing is sent, and the text says earlier entries are still saving.
  await input.fill('60 foxtrot');
  await input.press('Enter');
  await expect(page.getByText('Earlier entries are still saving. Your line is kept. Press Enter again in a moment.')).toBeVisible();
  await expect(input).toHaveValue('60 foxtrot');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  expect(writes(api, 'POST')).toHaveLength(5);

  // Responses in the order of the requests: every row is saved once and the latest answer carries the total.
  for (const [index, gate] of gates.entries()) {
    gate.release();
    await expect(rowFor(page, (ENTRIES[index] as (typeof ENTRIES)[number]).note)).toHaveAttribute('data-phase', 'saved');
  }
  await expect(entryRows(page, 'saved')).toHaveCount(5);
  await expect(answerOf(page)).toContainText("Spent today: ₹150 of today's allowance of ₹3,000.");
  await expect(spentToday(page)).toHaveText('₹150');
  await expect(leftToday(page)).toHaveText('₹2,850');
  expect(world.backend.expenses.map((expense) => expense.amountMinor)).toEqual([1000, 2000, 3000, 4000, 5000]);

  // With room again, the kept line saves.
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  await input.press('Enter');
  await expect(rowFor(page, 'foxtrot')).toHaveAttribute('data-phase', 'saved');
  expect(world.backend.expenses).toHaveLength(6);
  expect(new Set(keysOf(writes(api, 'POST'))).size).toBe(6);
  await guard.expectUnchanged();
});

test('Five entries answered in another order are each saved exactly once, and an older answer never replaces a newer one', async ({ page, api }) => {
  const world = installQuickAddWorld(api);
  await openHome(page);
  const guard = await guardDocument(page);
  const gates = ENTRIES.map(() => world.holdResponse('POST', EXPENSES_API));
  const versions = await submitAll(page, api, world);
  expect(versions).toEqual([...versions].sort((a, b) => a - b));
  expect(new Set(versions).size).toBe(5);
  // The server has applied all five already. The browser still shows none of them.
  expect(world.backend.expenses).toHaveLength(5);
  await expect(entryRows(page, 'pending')).toHaveCount(5);
  await expect(spentToday(page)).toHaveText('₹0');
  await expect(answerOf(page)).toHaveCount(0);

  // The third answer arrives first, then the first, the fifth, the second, and the fourth (0-based: 2, 0, 4, 1, 3).
  const order = [2, 0, 4, 1, 3];
  /** The total of the entries the server had applied when it answered entry `index`: 10 + 20 + ... up to that entry. */
  const totalAt = (index: number) => ENTRIES.slice(0, index + 1).reduce((sum, entry) => sum + entry.amount, 0);
  let newest = -1;
  const released = new Set<number>();
  for (const index of order) {
    (gates[index] as { release(): void }).release();
    released.add(index);
    const { note } = ENTRIES[index] as (typeof ENTRIES)[number];
    await expect(rowFor(page, note)).toHaveAttribute('data-phase', 'saved');
    // Only the answered entries have left pending.
    await expect(entryRows(page, 'saved')).toHaveCount(released.size);
    await expect(entryRows(page, 'pending')).toHaveCount(ENTRIES.length - released.size);
    // The answer and the headline follow the newest server state seen so far and never go back to an older one.
    newest = Math.max(newest, index);
    await expect(answerOf(page)).toHaveAttribute('data-version', String(versions[newest]));
    await expect(answerOf(page)).toContainText(`Spent today: ₹${totalAt(newest)} of today's allowance of ₹3,000.`);
    await expect(spentToday(page)).toHaveText(`₹${totalAt(newest)}`);
  }

  // Requirement 7.15 and 7.14: five saves, five keys, five expenses, and the final totals.
  await expect(entryRows(page, 'saved')).toHaveCount(5);
  const keys = keysOf(writes(api, 'POST'));
  expect(keys).toHaveLength(5);
  expect(new Set(keys).size).toBe(5);
  expect(world.backend.expenses.map((expense) => expense.note)).toEqual(['alpha', 'bravo', 'charlie', 'delta', 'echo']);
  await expect(spentToday(page)).toHaveText('₹150');
  await expect(leftToday(page)).toHaveText('₹2,850');
  await expect(answerOf(page)).toContainText('₹2,850 left today.');
  // Requirement 9.16: the earlier saved rows keep a one-line status of their own.
  await expect(rowFor(page, 'alpha')).toContainText(/left today\./);
  await guard.expectUnchanged();
});

test('One failed entry leaves the other entries untouched, and its retry uses the same key', async ({ page, api }) => {
  const world = installQuickAddWorld(api);
  await openHome(page);
  const guard = await guardDocument(page);
  const gates = [0, 1, 2].map(() => world.holdResponse('POST', EXPENSES_API));
  const input = quickAddInput(page);

  await input.fill('10 alpha');
  await input.press('Enter');
  await waitForWrites(api, 'POST', 1);
  // The server refuses the second request. The first and the third are applied.
  world.backend.failWith('POST', '/finance/expenses', failure);
  await input.fill('20 bravo');
  await input.press('Enter');
  await waitForWrites(api, 'POST', 2);
  await input.fill('30 charlie');
  await input.press('Enter');
  await waitForWrites(api, 'POST', 3);
  await expect(entryRows(page, 'pending')).toHaveCount(3);

  // The failure arrives first. Only its own row changes.
  gates[1]?.release();
  const failedRow = rowFor(page, 'bravo');
  await expect(failedRow).toHaveAttribute('data-phase', 'failed');
  await expect(failedRow).toContainText(failure.message);
  await expect(rowFor(page, 'alpha')).toHaveAttribute('data-phase', 'pending');
  await expect(rowFor(page, 'charlie')).toHaveAttribute('data-phase', 'pending');
  await expect(answerOf(page)).toHaveCount(0);

  gates[0]?.release();
  gates[2]?.release();
  await expect(rowFor(page, 'alpha')).toHaveAttribute('data-phase', 'saved');
  await expect(rowFor(page, 'charlie')).toHaveAttribute('data-phase', 'saved');
  await expect(failedRow).toHaveAttribute('data-phase', 'failed');
  // Confirmed values are those of the two saved entries, and nothing of the failed one.
  await expect(spentToday(page)).toHaveText('₹40');
  await expect(answerOf(page)).toContainText("Spent today: ₹40 of today's allowance of ₹3,000.");
  expect(world.backend.expenses.map((expense) => expense.note)).toEqual(['alpha', 'charlie']);
  // The failed row keeps its values and offers the three actions.
  await expect(failedRow).toContainText('₹20');
  await expect(failedRow.getByRole('button', { name: 'Retry saving ₹20 bravo' })).toBeVisible();
  await expect(failedRow.getByRole('button', { name: 'Edit ₹20 bravo' })).toBeVisible();
  await expect(failedRow.getByRole('button', { name: 'Discard ₹20 bravo' })).toBeVisible();

  // Retry resends the same request with the same key and the three entries are saved once each.
  await failedRow.getByRole('button', { name: 'Retry saving ₹20 bravo' }).click();
  await expect(failedRow).toHaveAttribute('data-phase', 'saved');
  const sent = writes(api, 'POST');
  expect(sent).toHaveLength(4);
  const keys = keysOf(sent);
  expect(keys[3]).toBe(keys[1]);
  expect(bodyOf(sent[3])).toEqual(bodyOf(sent[1]));
  expect(new Set(keys).size).toBe(3);
  await expect(spentToday(page)).toHaveText('₹60');
  expect(world.backend.expenses.map((expense) => expense.note).sort()).toEqual(['alpha', 'bravo', 'charlie']);
  await guard.expectUnchanged();
});

test('Discarding a failed entry removes only its row and leaves every confirmed record', async ({ page, api }) => {
  const world = installQuickAddWorld(api);
  await openHome(page);
  const guard = await guardDocument(page);
  const input = quickAddInput(page);
  await input.fill('10 alpha');
  await input.press('Enter');
  await expect(rowFor(page, 'alpha')).toHaveAttribute('data-phase', 'saved');
  world.backend.failWith('POST', '/finance/expenses', failure);
  await input.fill('20 bravo');
  await input.press('Enter');
  await expect(rowFor(page, 'bravo')).toHaveAttribute('data-phase', 'failed');
  await rowFor(page, 'bravo').getByRole('button', { name: 'Discard ₹20 bravo' }).click();
  await expect(rowFor(page, 'bravo')).toHaveCount(0);
  await expect(rowFor(page, 'alpha')).toHaveAttribute('data-phase', 'saved');
  await expect(spentToday(page)).toHaveText('₹10');
  expect(world.backend.expenses.map((expense) => expense.note)).toEqual(['alpha']);
  expect(writes(api, 'POST')).toHaveLength(2);
  await guard.expectUnchanged();
});

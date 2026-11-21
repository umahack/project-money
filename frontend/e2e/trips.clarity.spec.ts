// Browser acceptance for adding trip expenses, recording settlement payments, and sharing a
// trip with the financial clarity flag on.
//
// These tests assert, in a real browser:
//
// - pending feedback within 100 ms of submit, and the new allocation, balances, or failure within
//   100 ms of the response, measured with the harness paint helpers,
// - one document for each flow, with no reload, no page-wide loading, and no re-read of the trip,
// - keyboard focus stays on the control the user moved to while a change is pending,
// - a failed expense keeps its draft and the last confirmed shares, and retries to one expense,
// - the share dialog traps Tab, closes on Escape without changing anything, and returns focus.
//
// The `clarity-*` projects in playwright.config.ts run this file against a dev server started
// with VITE_FINANCIAL_CLARITY_ENABLED=true. Every response comes from the in-memory
// FakeTripsBackend; nothing leaves loopback. Rounding, balances, settlement order, replays,
// response ordering, roles, Home integration, and the public projection are covered by
// src/pages/Trips.behavior.test.tsx and backend/test/api/tripPublicRevocation.integration.test.js.
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
import { installTripsBackend } from './helpers/tripsApi';
import { TEST_USER, expect, installAuthenticatedSession, test, type DeterministicApiFixtures } from './fixtures/test';
import type { FakeTripsInit } from '../src/test/fakeTripsBackend';
import type { Locator, Page, Response } from '@playwright/test';

const MONTH = currentMonthInIndia();
const BUDGET_MS = 100;
const CLARITY_READ = `/api/finance/clarity?month=${MONTH}`;

/** ₹1,000 shared three ways. Asha (the signed-in user) paid and is owed ₹666.66. */
const TRIPS: FakeTripsInit = {
  viewer: TEST_USER.email,
  trips: [{
    id: 3,
    name: 'Goa weekend',
    destination: 'Goa',
    budget: 5000,
    startDate: '2026-01-09',
    endDate: '2026-01-12',
    owner: TEST_USER.email,
    members: [
      { id: 101, name: 'Asha', email: TEST_USER.email },
      { id: 102, name: 'Ravi', email: 'ravi@example.invalid' },
      { id: 103, name: 'Meera' },
    ],
    expenses: [{ id: 11, payer: 'Asha', description: 'Beach dinner', amount: 1000, createdAt: `${MONTH}-02 12:00:00` }],
  }],
};

const dinnerShares = (page: Page) => page.getByRole('list', { name: 'Each member’s share of Beach dinner' });
const raviPayment = (page: Page) => page.getByRole('button', { name: 'Record payment: Ravi pays Asha ₹333.33', exact: true });
const createLink = (page: Page) => page.getByRole('button', { name: 'Create public link', exact: true });

const isPath = (method: string, path: string) => (response: Response) => (
  new URL(response.url()).pathname === path && response.request().method() === method
);

async function openTrip(page: Page, api: DeterministicApiFixtures, route: string, ready: (page: Page) => Locator) {
  const control = installTripsBackend(api, MONTH, TRIPS);
  await installAuthenticatedSession(page);
  await page.goto(route);
  await expect(ready(page)).toBeVisible();
  await expect(page.getByRole('tab', { name: /Balances/ })).toBeVisible();
  // Start timing after load work and entrance animations, as a user interacting with a settled page would.
  await waitForQuietFrames(page);
  return {
    control,
    whatFor: page.getByRole('textbox', { name: 'What for?' }),
    amount: page.getByRole('textbox', { name: 'Amount (₹)' }),
    add: page.getByRole('button', { name: 'Add & split' }),
    status: (scope: string) => page.locator(`[data-scope="${scope}"]`),
    shares: (expense: string) => page.getByRole('list', { name: `Each member’s share of ${expense}` }),
    pay: (from: string, to: string, amount: string) => page.getByRole('button', { name: `Record payment: ${from} pays ${to} ${amount}`, exact: true }),
    member: (id: number) => page.locator(`[data-member-id="${id}"]`),
  };
}

// Screen recording and tracing halve headless Chromium's frame rate (17 to 33 ms per frame becomes
// a steady 33 ms), which would count against a 100 ms paint budget. Failures still keep a screenshot.
test.use({ video: 'off', trace: 'off' });

test.describe('feedback timing', () => {
  // The budgets measure application latency, not software-rendered decoration, so only this describe switches
  // off the background blob animation and backdrop blur with a test-only stylesheet (production CSS is
  // unchanged). See neutralizeDecorativeRendering in helpers/browser.ts. The share dialog test below
  // checks focus and keyboard behavior with the production rendering.
  test.use({ neutralizeDecorativeRendering: true });
  // Paint timing depends on the host's frame rate, which stalls when the machine is busy.
  // A real regression misses the 100 ms budget on every attempt; a busy host does not.
  test.describe.configure({ retries: 2 });

  test('an expense gives feedback within 100 ms, shows its allocation within 100 ms of the response, and leaves focus and the document alone', async ({ page, api }, testInfo) => {
    const t = await openTrip(page, api, '/trips/3', dinnerShares);
    const initialReads = api.count('GET', CLARITY_READ);
    const initialTripReads = api.count('GET', '/api/trips/3');
    const documentIdentity = await captureDocumentIdentity(page);
    const reloadSpy = await installReloadSpy(page);
    const focusTracker = await installFocusTracker(page);
    const gate = t.control.hold('POST', '/api/trips/3/expenses');

    await t.whatFor.fill('Taxi');
    await t.amount.fill('300');
    const pending = await measureSubmitToPaint(page, () => t.add.click(), {
      selector: '[data-scope="new-trip-expense:3"]',
      text: 'Add expense: pending',
    }, 'submit');
    testInfo.annotations.push({ type: 'pending-to-paint-ms', description: pending.durationMs.toFixed(1) });
    expectSubmitToPaintWithin(pending, BUDGET_MS);
    // The confirmed shares stay, and nothing is replaced by a loading state.
    await expect(t.shares('Beach dinner')).toBeVisible();
    await expect(t.shares('Taxi')).toHaveCount(0);
    await expect(page.getByText('Loading…', { exact: true })).toHaveCount(0);
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);

    // The user moves on to another control while the expense is pending. It becomes the active control.
    const include = page.getByRole('button', { name: 'Include in my spending: Beach dinner' });
    await include.focus();
    await expect(include).toBeFocused();
    expect(api.count('POST', '/api/trips/3/expenses')).toBe(1);
    const focusEventsBeforeResponse = (await focusTracker.history()).length;

    // Response: the allocation for the new expense, the done status, and the cleared form within 100 ms.
    const responsePromise = page.waitForResponse(isPath('POST', '/api/trips/3/expenses'));
    gate.release();
    const outcome = await measureResponseToPaint(page, responsePromise, t.shares('Taxi'));
    testInfo.annotations.push({ type: 'response-to-paint-ms', description: outcome.durationMs.toFixed(1) });
    expect(outcome.status).toBe(200);
    await expectResponseToPaintWithin(outcome, BUDGET_MS);
    await expect(t.shares('Taxi').getByRole('listitem')).toHaveText([/Asha\s*₹100/, /Ravi\s*₹100/, /Meera\s*₹100/]);
    await expect(t.status('new-trip-expense:3')).toContainText('Add expense: done');
    await expect(t.whatFor).toHaveValue('');
    await expect(t.shares('Beach dinner')).toBeVisible();

    // Same document, no reload, no re-read of the trip, one more snapshot read, and focus where the user left it.
    await expectSameDocument(page, documentIdentity);
    await reloadSpy.expectNoReloads();
    expect(api.count('GET', '/api/trips/3')).toBe(initialTripReads);
    expect(api.count('GET', CLARITY_READ)).toBe(initialReads + 1);
    expect(t.control.backend.trip(3).expenses).toHaveLength(2);
    await expect(include).toBeFocused();
    expect(await focusTracker.history()).toHaveLength(focusEventsBeforeResponse);
    await expectNoOverflowOrClipping(page);
  });

  test('a settlement payment gives feedback within 100 ms and shows the new balances within 100 ms of the response, leaving other payments and focus alone', async ({ page, api }, testInfo) => {
    const t = await openTrip(page, api, '/trips/3?tab=balances', raviPayment);
    await expect(t.pay('Ravi', 'Asha', '₹333.33')).toBeVisible();
    const initialTripReads = api.count('GET', '/api/trips/3');
    const documentIdentity = await captureDocumentIdentity(page);
    const reloadSpy = await installReloadSpy(page);
    const gate = t.control.hold('POST', '/api/trips/3/expenses');
    const scope = 'trip-settlement:3:102>101';

    const pending = await measureSubmitToPaint(page, () => t.pay('Ravi', 'Asha', '₹333.33').click(), {
      selector: `[data-scope="${scope}"]`,
      text: 'Payment from Ravi to Asha: pending',
    }, 'click');
    testInfo.annotations.push({ type: 'pending-to-paint-ms', description: pending.durationMs.toFixed(1) });
    expectSubmitToPaintWithin(pending, BUDGET_MS);
    // The confirmed balances stay while it is pending, and the other payment stays usable.
    await expect(t.member(102)).toContainText('Owed ₹333.33');
    await expect(t.pay('Meera', 'Asha', '₹333.33')).toBeEnabled();
    await expect(page.getByText('Loading…', { exact: true })).toHaveCount(0);

    // The user moves on to the other payment. It becomes the active control.
    await t.pay('Meera', 'Asha', '₹333.33').focus();
    await expect(t.pay('Meera', 'Asha', '₹333.33')).toBeFocused();

    const responsePromise = page.waitForResponse(isPath('POST', '/api/trips/3/expenses'));
    gate.release();
    const outcome = await measureResponseToPaint(page, responsePromise, t.member(102).getByText('Settled'));
    testInfo.annotations.push({ type: 'response-to-paint-ms', description: outcome.durationMs.toFixed(1) });
    expect(outcome.status).toBe(200);
    await expectResponseToPaintWithin(outcome, BUDGET_MS);
    await expect(t.status(scope)).toContainText('Payment from Ravi to Asha: done');
    await expect(page.locator('.trip-own-balance')).toContainText('You are owed ₹333.33 (receivable).');
    await expect(t.member(101)).toContainText('Receivable ₹333.33');
    await expect(t.pay('Ravi', 'Asha', '₹333.33')).toHaveCount(0);
    await expect(t.pay('Meera', 'Asha', '₹333.33')).toBeFocused();
    await expectSameDocument(page, documentIdentity);
    await reloadSpy.expectNoReloads();
    expect(api.count('GET', '/api/trips/3')).toBe(initialTripReads);
    expect(t.control.backend.trip(3).expenses).toHaveLength(2);
  });

  test('a failed expense shows within 100 ms of the response, keeps its draft and the confirmed shares, and retries to one expense', async ({ page, api }, testInfo) => {
    const t = await openTrip(page, api, '/trips/3', dinnerShares);
    const documentIdentity = await captureDocumentIdentity(page);
    const reloadSpy = await installReloadSpy(page);
    t.control.backend.failNext('POST', '/trips/3/expenses', 500, 'TRIP_MUTATION_FAILED', 'Trip change could not be saved.');
    const gate = t.control.hold('POST', '/api/trips/3/expenses');

    await t.whatFor.fill('Taxi');
    await t.amount.fill('300');
    const pending = await measureSubmitToPaint(page, () => t.add.click(), {
      selector: '[data-scope="new-trip-expense:3"]',
      text: 'Add expense: pending',
    }, 'submit');
    expectSubmitToPaintWithin(pending, BUDGET_MS);

    const failedResponse = page.waitForResponse(isPath('POST', '/api/trips/3/expenses'));
    gate.release();
    const failed = await measureResponseToPaint(page, failedResponse, t.status('new-trip-expense:3').getByText('Add expense: failed.'));
    testInfo.annotations.push({ type: 'failure-response-to-paint-ms', description: failed.durationMs.toFixed(1) });
    expect(failed.status).toBe(500);
    await expectResponseToPaintWithin(failed, BUDGET_MS);
    await expect(t.status('new-trip-expense:3')).toContainText('Your last confirmed values are unchanged.');

    // The draft is still in the form, and the confirmed shares and the server's data are untouched.
    await expect(t.whatFor).toHaveValue('Taxi');
    await expect(t.amount).toHaveValue('300');
    await expect(t.shares('Beach dinner')).toBeVisible();
    await expect(t.shares('Taxi')).toHaveCount(0);
    expect(t.control.backend.trip(3).expenses).toHaveLength(1);
    await expectSameDocument(page, documentIdentity);
    await reloadSpy.expectNoReloads();

    // Retry resends the same change and finishes it the way a first save finishes.
    const retry = t.status('new-trip-expense:3').getByRole('button', { name: 'Retry Add expense' });
    const retriedPending = await measureSubmitToPaint(page, () => retry.click(), {
      selector: '[data-scope="new-trip-expense:3"]',
      text: 'Add expense: pending',
    }, 'click');
    expectSubmitToPaintWithin(retriedPending, BUDGET_MS);
    await expect(t.status('new-trip-expense:3')).toContainText('Add expense: done');
    await expect(t.shares('Taxi')).toBeVisible();
    await expect(t.whatFor).toHaveValue('');
    expect(api.count('POST', '/api/trips/3/expenses')).toBe(2);
    expect(t.control.backend.trip(3).expenses).toHaveLength(2);
    await expectSameDocument(page, documentIdentity);
    await reloadSpy.expectNoReloads();
  });
});

test.describe('share dialog', () => {
  test('opens with focus inside, keeps Tab in the dialog, closes on Escape without changing anything, and returns focus', async ({ page, api }) => {
    const t = await openTrip(page, api, '/trips/3?tab=share', createLink);
    const documentIdentity = await captureDocumentIdentity(page);
    const reloadSpy = await installReloadSpy(page);
    const trigger = page.getByRole('button', { name: 'Create public link' });
    await expect(page.getByText(/Sharing is off\./)).toBeVisible();
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Create a public link' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Trip name', { exact: true })).toBeVisible();
    await expect(page.locator('[role="dialog"]:focus-within')).toHaveCount(1);
    // Every public field is listed, and nothing has been sent.
    await expect(dialog.locator('[data-field]')).toHaveCount(16);
    expect(api.count('POST', '/api/trips/3/share')).toBe(0);

    // Tab and Shift+Tab cycle inside the dialog and never reach the page behind it.
    for (let step = 0; step < 6; step += 1) {
      await page.keyboard.press('Tab');
      await expect(page.locator('[role="dialog"]:focus-within')).toHaveCount(1);
    }
    for (let step = 0; step < 3; step += 1) {
      await page.keyboard.press('Shift+Tab');
      await expect(page.locator('[role="dialog"]:focus-within')).toHaveCount(1);
    }

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(api.count('POST', '/api/trips/3/share')).toBe(0);
    expect(t.control.backend.trip(3).share).toEqual({ enabled: false, token: null });
    await expect(page.getByText(/Sharing is off\./)).toBeVisible();

    // Confirming creates one link and moves focus to it.
    await trigger.click();
    await expect(dialog.getByText('Trip name', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Create public link' }).click();
    const link = page.getByRole('textbox', { name: /Public link/ });
    await expect(link).toBeVisible();
    await expect(link).toBeFocused();
    expect(api.count('POST', '/api/trips/3/share')).toBe(1);
    const first = t.control.backend.trip(3).share.token!;
    expect(first).toMatch(/^[a-f0-9]{32}$/);

    // Escape from the rotate dialog changes nothing; confirming rotates and ends the old link.
    await page.getByRole('button', { name: 'Rotate link' }).click();
    const rotate = page.getByRole('dialog', { name: 'Rotate the public link' });
    await expect(rotate.getByText('Trip name', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(rotate).toHaveCount(0);
    expect(t.control.backend.trip(3).share.token).toBe(first);
    await expect(page.getByRole('button', { name: 'Rotate link' })).toBeFocused();
    await page.getByRole('button', { name: 'Rotate link' }).click();
    await expect(rotate.getByText('Trip name', { exact: true })).toBeVisible();
    await rotate.getByRole('button', { name: 'Rotate link' }).click();
    await expect(rotate).toHaveCount(0);
    await expect.poll(() => t.control.backend.trip(3).share.token).not.toBe(first);
    expect(t.control.backend.handle({ method: 'GET', path: `/public/trips/${first}` })).toEqual({ status: 404, body: { error: 'Not found' } });

    // Revoking is one action: the link ends at once and focus lands on the section heading, not the page.
    await page.getByRole('button', { name: 'Revoke link' }).click();
    await expect(page.getByText(/Public link revoked\. Your trip data is unchanged\./)).toBeVisible();
    await expect(page.getByRole('heading', { name: /Public share link/ })).toBeFocused();
    expect(t.control.backend.trip(3).share).toEqual({ enabled: false, token: null });
    expect(t.control.backend.trip(3).expenses).toHaveLength(1);
    await expectSameDocument(page, documentIdentity);
    await reloadSpy.expectNoReloads();
  });
});

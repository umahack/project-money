// Browser acceptance for the first-session guided journey with the financial clarity
// flag on, from empty records to the first outcome and finish ("Plan the month").
//
// These tests assert, in a real browser:
//
// - one document for the whole journey: no reload and no page-wide loading,
// - focus moves to the step heading when the step opens, and to the reveal heading
//   ("Your first result is ready") when the server confirms the step, and then to the
//   finish and summary headings,
// - pending feedback within 100 ms of saving the step, and outcome feedback within
//   100 ms of the save response and of the journey confirmation,
// - the optional step comes after the first result, and skipping it saves nothing,
// - the whole journey can be completed with the keyboard, with no horizontal overflow.
//
// The `clarity-*` projects in playwright.config.ts run this file against a dev server
// started with VITE_FINANCIAL_CLARITY_ENABLED=true. Every response comes from in-memory
// fixtures (FakeJourneyServer and FakeClarityBackend); nothing leaves loopback. All four
// journeys, failures, pause and resume, and measurement are covered by
// src/pages/GuidedJourney.allJourneys.test.tsx and the backend integration test.
import {
  captureDocumentIdentity,
  expectNoOverflowOrClipping,
  expectResponseToPaintWithin,
  expectSameDocument,
  expectSubmitToPaintWithin,
  installReloadSpy,
  measureResponseToPaint,
  measureSubmitToPaint,
  neutralizeDecorativeRendering,
  waitForQuietFrames,
} from './helpers/browser';
import { currentMonthInIndia, monthName } from './helpers/clarityApi';
import { FIRST_JOURNEY_PATH, installJourneyApi } from './helpers/journeyApi';
import { expect, installAuthenticatedSession, test, type DeterministicApiFixtures } from './fixtures/test';
import type { Page, Response } from '@playwright/test';

const MONTH = currentMonthInIndia();
const MONTH_NAME = monthName(MONTH);
const SALARY_SCOPE = `[data-scope="salary:${MONTH}"]`;
const BUDGET_MS = 100;

const isSalaryPost = (response: Response) => (
  new URL(response.url()).pathname === '/api/finance/salary' && response.request().method() === 'POST'
);
const isJourneyPatch = (response: Response) => (
  new URL(response.url()).pathname === FIRST_JOURNEY_PATH && response.request().method() === 'PATCH'
);

async function openJourney(page: Page, api: DeterministicApiFixtures) {
  const control = installJourneyApi(api, MONTH);
  await installAuthenticatedSession(page);
  await page.goto('/start');
  await expect(page.getByRole('heading', { level: 1, name: 'Guided journey' })).toBeVisible();
  const choices = page.getByRole('list', { name: 'Desired outcomes' });
  await expect(choices.getByRole('button')).toHaveCount(4);
  // Start timing after load work and entrance animations, as a user interacting with a settled page would.
  await waitForQuietFrames(page);
  const heading = (name: string) => page.getByRole('heading', { level: 2, name });
  return {
    control,
    choices,
    heading,
    stepHeading: heading('Add your monthly pay'),
    readyHeading: heading('Your first result is ready'),
    pay: page.getByRole('textbox', { name: 'Monthly pay' }),
    save: page.getByRole('button', { name: `Save pay for ${MONTH_NAME}` }),
    status: page.locator(SALARY_SCOPE),
    live: page.locator('.journey-status'),
  };
}

const patchBodies = (api: DeterministicApiFixtures) => api.requests
  .filter((request) => request.method === 'PATCH' && request.path === FIRST_JOURNEY_PATH)
  .map((request) => request.body);

// Screen recording and tracing halve headless Chromium's frame rate (17 to 33 ms per
// frame becomes a steady 33 ms), which would count against the 100 ms paint budgets in
// the first test. Failures still keep a screenshot and the error context.
test.use({ video: 'off', trace: 'off' });

test.describe('timed journey', () => {
  // Paint timing depends on the host's frame rate, which stalls when the machine is busy.
  // A real regression misses the 100 ms budget on every attempt; a busy host does not.
  test.describe.configure({ retries: 2 });

  test('from empty records to the first result and finish, with no reload, moving focus, and 100 ms feedback', async ({ page, api }, testInfo) => {
    // The paint budgets measure application latency, not software-rendered decoration, so this
    // test switches off the background blob animation and backdrop blur with a test-only
    // stylesheet (production CSS is unchanged). The keyboard and overflow test below does not.
    await neutralizeDecorativeRendering(page);
    const journey = await openJourney(page, api);
    const documentIdentity = await captureDocumentIdentity(page);
    const reloadSpy = await installReloadSpy(page);

    // Choose the outcome: the first step opens, says why it is needed, and takes focus.
    await journey.choices.getByRole('button', { name: 'Plan the month' }).click();
    await expect(journey.stepHeading).toBeVisible();
    await expect(journey.stepHeading).toBeFocused();
    await expect(page.locator('.journey-progress-text')).toHaveText('Step 1 of 1; 1 required step remaining.');
    await expect(journey.live).toContainText('Started: Plan the month.');
    await expect(journey.pay).toBeVisible();
    await expect(journey.readyHeading).toHaveCount(0);
    // Nothing optional is asked before the first result.
    await expect(journey.heading('Add monthly bills')).toHaveCount(0);
    expect(journey.control.server.startsCreated).toBe(1);
    await waitForQuietFrames(page);

    const salaryGate = journey.control.hold('POST', '/api/finance/salary');
    const journeyGate = journey.control.holdJourneyPatch();

    // Save the pay: pending feedback within 100 ms, on the same page, without page-wide loading.
    await journey.pay.fill('80000');
    const pending = await measureSubmitToPaint(page, () => journey.save.click(), {
      selector: SALARY_SCOPE,
      text: 'Save pay: pending',
    });
    testInfo.annotations.push({ type: 'pending-to-paint-ms', description: pending.durationMs.toFixed(1) });
    expectSubmitToPaintWithin(pending, BUDGET_MS);
    await expect(journey.stepHeading).toBeVisible();
    await expect(page.getByText('Loading…', { exact: true })).toHaveCount(0);

    // The save response: the confirmed status within 100 ms. The journey has not moved yet.
    const salaryResponse = page.waitForResponse(isSalaryPost);
    salaryGate.release();
    const saved = await measureResponseToPaint(page, salaryResponse, journey.status.getByText(/Save pay: done/));
    testInfo.annotations.push({ type: 'save-response-to-paint-ms', description: saved.durationMs.toFixed(1) });
    expect(saved.status).toBe(200);
    await expectResponseToPaintWithin(saved, BUDGET_MS);
    await expect(journey.readyHeading).toHaveCount(0);

    // The server confirms the step: the first result appears within 100 ms, and focus moves to its heading.
    const confirmation = page.waitForResponse(isJourneyPatch);
    journeyGate.release();
    const revealed = await measureResponseToPaint(page, confirmation, journey.readyHeading);
    testInfo.annotations.push({ type: 'confirmation-to-paint-ms', description: revealed.durationMs.toFixed(1) });
    expect(revealed.status).toBe(200);
    await expectResponseToPaintWithin(revealed, BUDGET_MS);
    await expect(journey.readyHeading).toBeFocused();
    await expect(page.locator('.journey-progress-text')).toHaveText('All 1 required step done.');
    await expect(page.getByRole('article', { name: `Your plan for ${MONTH_NAME}` })).toContainText('80,000');
    await expect(journey.live).toContainText('Step done: Add your monthly pay.');

    // The optional step follows the first result, and skipping it saves nothing.
    const bills = journey.heading('Add monthly bills');
    await expect(bills).toBeVisible();
    const readyBox = await journey.readyHeading.boundingBox();
    const billsBox = await bills.boundingBox();
    expect(billsBox?.y ?? 0).toBeGreaterThan(readyBox?.y ?? Number.POSITIVE_INFINITY);
    const recordWrites = api.requests.filter((request) => request.method !== 'GET' && request.method !== 'PATCH'
      && !request.path.startsWith('/api/track') && !request.path.startsWith('/api/clarity'));
    expect(recordWrites.map((request) => `${request.method} ${request.path}`)).toEqual(['POST /api/finance/salary']);
    await page.getByRole('button', { name: 'Skip for now' }).click();
    const finishHeading = journey.heading('Finish your journey');
    await expect(finishHeading).toBeFocused();
    expect(api.count('POST', '/api/finance/emis')).toBe(0);
    expect(api.count('POST', '/api/finance/salary')).toBe(1);

    // The clarity question never blocks finishing, and sends nothing while Product Analytics is off.
    await page.getByRole('button', { name: 'Yes' }).click();
    await expect(page.getByText('Thanks. You answered: Yes.')).toBeVisible();
    await page.getByRole('button', { name: 'Finish journey' }).click();
    await expect(journey.heading('Journey finished')).toBeFocused();
    expect(api.count('POST', '/api/clarity/events')).toBe(0);

    expect(patchBodies(api)).toEqual([
      { action: 'complete_step', stepKey: 'salary', changeId: expect.any(Number) },
      { action: 'skip_step', stepKey: 'bills' },
      { action: 'complete' },
    ]);
    // One document for the whole journey, no reload, and no page-wide loading state at any point.
    await expectSameDocument(page, documentIdentity);
    await reloadSpy.expectNoReloads();
    await expect(page.getByText('Loading…', { exact: true })).toHaveCount(0);
    expect(api.count('POST', '/api/clarity/journeys')).toBe(1);
  });
});

test('the keyboard completes the journey, and no screen overflows horizontally', async ({ page, api }) => {
  const journey = await openJourney(page, api);
  const documentIdentity = await captureDocumentIdentity(page);
  const reloadSpy = await installReloadSpy(page);
  await expectNoOverflowOrClipping(page, ['html', 'body', 'main', '.journey-page']);

  // Choose with the keyboard.
  const choice = journey.choices.getByRole('button', { name: 'Plan the month' });
  await choice.focus();
  await page.keyboard.press('Enter');
  await expect(journey.stepHeading).toBeFocused();
  await expectNoOverflowOrClipping(page, ['html', 'body', 'main', '.journey-page']);

  // Type the pay and submit with Enter.
  await journey.pay.focus();
  await page.keyboard.type('80000');
  await page.keyboard.press('Enter');
  await expect(journey.readyHeading).toBeFocused();
  await expect(page.getByRole('article', { name: `Your plan for ${MONTH_NAME}` })).toBeVisible();
  await expectNoOverflowOrClipping(page, ['html', 'body', 'main', '.journey-page']);

  // Stop the optional steps and finish, still with the keyboard.
  await page.getByRole('button', { name: 'Stop optional steps and finish' }).focus();
  await page.keyboard.press('Enter');
  const finishHeading = journey.heading('Finish your journey');
  await expect(finishHeading).toBeFocused();
  await page.getByRole('button', { name: 'Skip question' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Question skipped. Nothing was sent.').first()).toBeVisible();
  await page.getByRole('button', { name: 'Finish journey' }).focus();
  await page.keyboard.press('Enter');
  await expect(journey.heading('Journey finished')).toBeFocused();
  await expectNoOverflowOrClipping(page, ['html', 'body', 'main', '.journey-page']);

  expect(api.count('POST', '/api/finance/salary')).toBe(1);
  await expectSameDocument(page, documentIdentity);
  await reloadSpy.expectNoReloads();
});

// Rollback acceptance for the financial clarity rollout (task 17.5), on the flag-OFF dev server (port 4173).
//
// One user has clarity data: an open guided journey, a category treatment, a trip share included in monthly
// spending, and the data-use acknowledgement. With the rollout flag off the same records are served by the
// legacy routes and shown by the legacy pages, with their documented legacy behaviour:
//
// - Home, Plan, Spending, Goals, and Trips render the legacy pages and read the legacy routes; the clarity
//   header is never sent and nothing under /api/clarity or /api/finance/clarity is requested,
// - the guided-journey route does not exist, and Home offers no link to it,
// - saving the pay on Plan still reloads the document, as it always did (the documented legacy behaviour),
// - legacy writes (pay, an expense, a goal contribution) change source rows only, and the feature data
//   (journey, treatments, personal links, measurement, data version) is exactly as it was,
// - flipping back to the flag-ON server (port 4174, a second browser context) shows every record intact,
//   including the legacy edits, the resumed journey, and the trip share counted in spending.
//
// The two origins share one in-memory world (helpers/worldApi.ts); only the legacy routes are answered on the
// first and only the clarity contract on the second. Nothing leaves loopback. The `chromium-*` projects run
// every non-clarity spec, so this one runs only at the two widths the task names.
import { captureDocumentIdentity, expectDocumentReplaced, expectNoOverflowOrClipping, installReloadSpy } from './helpers/browser';
import { currentMonthInIndia, monthName } from './helpers/clarityApi';
import { installLegacyWorld } from './helpers/legacyWorldApi';
import { FakeWorld, installWorldFor, type WorldInit } from './helpers/worldApi';
import { DeterministicApiFixtures, TEST_USER, expect, installAuthenticatedSession, test } from './fixtures/test';
import type { Page, Route } from '@playwright/test';

const MONTH = currentMonthInIndia();
const MONTH_NAME = monthName(MONTH);
const CLARITY_ORIGIN = 'http://127.0.0.1:4174';
const CATEGORIES = ['Food', 'Groceries', 'Transport', 'Shopping', 'Travel', 'Other'];
const WIDTHS_RUN = [390, 1440];

function monthAfter(month: string, offset: number): string {
  const [year, number] = month.split('-').map(Number) as [number, number];
  const date = new Date(year, number - 1 + offset, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}
const GOAL_DATE = `${monthAfter(MONTH, 4)}-10`;

/** Pay 80,000, a 30,000 bill, a 16,000 Shopping expense, a goal, and a trip with one shared expense. */
const INIT: WorldInit = {
  month: MONTH,
  viewer: TEST_USER.email,
  categories: CATEGORIES,
  plan: { salaryMinor: 8_000_000, bills: [{ label: 'Rent', amountMinor: 3_000_000 }] },
  spending: {
    expenses: [{ id: 1, category: 'Shopping', amount: 16000, day: 3, note: 'Shoes' }],
    treatments: [{ category: 'Shopping', treatment: 'wants', id: 60 }],
  },
  goals: { goals: [{ id: 1, name: 'Laptop', target: 50000, saved: 10000, date: GOAL_DATE }] },
  trips: {
    viewer: TEST_USER.email,
    categories: CATEGORIES,
    trips: [{
      id: 3,
      name: 'Goa weekend',
      destination: 'Goa',
      budget: 20000,
      owner: TEST_USER.email,
      members: [
        { id: 101, name: 'Asha', email: TEST_USER.email },
        { id: 102, name: 'Ravi', email: 'ravi@example.invalid' },
      ],
      expenses: [{ id: 1, payer: 'Asha', description: 'Hotel', amount: 3000, createdAt: `${MONTH}-02 12:00:00` }],
    }],
  },
};

/** A world as it is after a first session through the clarity UI. */
function seedWorld(): FakeWorld {
  const world = new FakeWorld(INIT);
  world.noticeAcknowledged = true;
  world.version = 7;
  // The user's 1,500 share of Hotel counts in monthly spending, as one expense row linked to the trip expense.
  world.trips.account().links.push({
    tripId: 3, expenseId: 1, category: 'Travel', spentOn: `${MONTH}-02`, amountMinor: 150_000, expenseLogId: 9000,
  });
  world.spending.expenses.push({
    id: 9000, month: MONTH, category: 'Travel', amountMinor: 150_000, note: 'Trip share', spentOn: `${MONTH}-02`, version: 1,
  });
  // An open journey whose pay and bill steps are satisfied by the records above.
  world.journey.open('plan_month');
  world.snapshot();
  return world;
}

/** Everything the clarity feature owns, as the world holds it. Rollback must not change any of it. */
function featureData(world: FakeWorld) {
  world.snapshot();
  return JSON.parse(JSON.stringify({
    version: world.version,
    noticeAcknowledged: world.noticeAcknowledged,
    analyticsEnabled: world.analyticsEnabled,
    journey: world.journey.view(),
    journeysStarted: world.journey.startsCreated,
    treatments: world.spending.treatments,
    personalLinks: world.trips.account().links,
    events: world.events,
  })) as unknown;
}

async function openSecondOrigin(page: Page, browser: import('@playwright/test').Browser) {
  const context = await browser.newContext({
    baseURL: CLARITY_ORIGIN,
    viewport: page.viewportSize() ?? { width: 390, height: 900 },
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
    colorScheme: 'light',
    reducedMotion: 'no-preference',
    serviceWorkers: 'block',
  });
  const second = await context.newPage();
  const api = new DeterministicApiFixtures(CLARITY_ORIGIN);
  const handler = (route: Route) => api.dispatch(route);
  await second.route('**/*', handler);
  return { context, second, api, handler };
}

test.use({ video: 'off', trace: 'off' });

test('flag off serves the legacy UI and read path from the same records, deletes no feature data, and flag on shows it all intact', async ({ page, api, browser }, testInfo) => {
  const width = testInfo.project.use.viewport?.width;
  test.skip(!WIDTHS_RUN.includes(width ?? 0), 'The rollback acceptance runs at chromium-390 and chromium-1440.');
  test.setTimeout(180_000);

  const world = seedWorld();
  installLegacyWorld(api, world);
  const before = featureData(world);
  await installAuthenticatedSession(page);

  // ---- Home: the legacy page, with no clarity summary and no path to the guided journey ----
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Hey Browser');
  await expect(page.locator('main')).toContainText('80,000');
  await expect(page.locator('.clarity-decision-header')).toHaveCount(0);
  await expect(page.getByTestId('monthly-clarity-summary')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Start or continue a guided journey' })).toHaveCount(0);
  await expect(page.locator('.clarity-promise, section.clarity-gate')).toHaveCount(0);
  await expectNoOverflowOrClipping(page);

  // ---- The guided-journey route is unreachable: the signed-in catch-all keeps the shell and shows no journey ----
  await page.goto('/start');
  await expect(page.locator('aside.sidebar, nav.bottom-tabs').first()).toBeAttached();
  await expect(page.getByRole('heading', { level: 1, name: 'Guided journey' })).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'Desired outcomes' })).toHaveCount(0);

  // ---- Plan: the legacy form, and the documented legacy reload when the pay is saved ----
  await page.goto('/plan');
  await expect(page.getByRole('heading', { name: 'Your month, line by line 🧾' })).toBeVisible();
  await expect(page.getByLabel('Monthly pay')).toHaveValue('80000');
  await expect(page.getByRole('article', { name: `Your plan for ${MONTH_NAME}` })).toHaveCount(0);
  const identity = await captureDocumentIdentity(page);
  const reloads = await installReloadSpy(page);
  await page.getByLabel('Monthly pay').fill('81000');
  const reloaded = page.waitForEvent('domcontentloaded');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await reloaded;
  expect(await reloads.count(), 'legacy Plan save reloads the document').toBe(1);
  await expectDocumentReplaced(page, identity);
  await expect(page.getByLabel('Monthly pay')).toHaveValue('81000');
  expect(world.plan.salary?.amountMinor).toBe(8_100_000);

  // ---- Spending: the legacy tracker logs an expense with the legacy body ----
  await page.goto('/spending');
  await expect(page.getByRole('heading', { name: /This month's spending/ })).toBeVisible();
  await expect(page.getByRole('article', { name: `Spending for ${MONTH_NAME}` })).toHaveCount(0);
  await expect(page.locator('main')).toContainText('Shopping');
  await page.getByRole('textbox', { name: 'Amount' }).fill('500');
  await page.getByLabel('Category').selectOption('Food');
  await page.getByRole('button', { name: '+ Log expense' }).click();
  await expect.poll(() => world.spending.expenses.filter((row) => row.category === 'Food').length).toBe(1);
  await expect(page.getByText('Logged ₹500 to Food').first()).toBeVisible();

  // ---- Goals: the legacy list adds to the saved amount with the legacy body ----
  await page.goto('/goals');
  await expect(page.getByRole('heading', { name: /Savings goals/ })).toBeVisible();
  await expect(page.getByRole('article', { name: 'Laptop', exact: true })).toHaveCount(0);
  await expect(page.locator('main')).toContainText('₹10,000 of ₹50,000');
  await page.getByRole('button', { name: '+ Add' }).click();
  await page.getByPlaceholder(/e\.g\. 500/).fill('2000');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('main')).toContainText('₹12,000 of ₹50,000');
  expect(world.goals.find(1)?.savedMinor).toBe(1_200_000);

  // ---- Trips: the legacy list and trip page ----
  await page.goto('/trips');
  await expect(page.getByRole('heading', { name: /Trips & splits/ })).toBeVisible();
  await expect(page.getByText('Goa weekend').first()).toBeVisible();
  await page.goto('/trips/3');
  await expect(page.getByText('Hotel').first()).toBeVisible();
  await expect(page.locator('.clarity-decision-header')).toHaveCount(0);
  await expectNoOverflowOrClipping(page);

  // ---- The legacy client sent no clarity header and read nothing from the clarity contract ----
  const clarityPaths = api.requests.filter((request) => request.path.startsWith('/api/clarity') || request.path.startsWith('/api/finance/clarity'));
  expect(clarityPaths.map((request) => `${request.method} ${request.path}`)).toEqual([]);
  expect(api.requests.filter((request) => request.clarityContract !== null && request.clarityContract !== undefined)).toEqual([]);
  expect(api.requests.some((request) => request.path === '/api/finance/plan')).toBe(true);
  const legacyWrites = api.requests
    .filter((request) => request.method !== 'GET' && request.path !== '/api/track')
    .map((request) => `${request.method} ${request.path}`);
  expect(legacyWrites).toEqual(['POST /api/finance/salary', 'POST /api/finance/expenses', 'PATCH /api/finance/goals/1']);
  for (const request of api.requests.filter((entry) => entry.method === 'POST' && entry.path === '/api/finance/salary')) {
    expect(request.body, 'legacy pay body').toEqual({ amount: 81000 });
  }

  // ---- Rollback deleted nothing: every feature row is as it was, and no data version moved ----
  expect(featureData(world)).toEqual(before);
  expect(world.spending.expenses.map((row) => row.id).sort((a, b) => a - b)).toEqual([1, 9000, 9001]);
  expect(world.events).toEqual([]);

  // ---- Flipping back to the flag-on server shows every record intact, including the legacy edits ----
  const flipped = await openSecondOrigin(page, browser);
  try {
    const clarity = installWorldFor(flipped.api, world);
    await installAuthenticatedSession(flipped.second, TEST_USER);
    await flipped.second.goto('/');
    const summary = flipped.second.getByTestId('monthly-clarity-summary');
    await expect(summary).toBeVisible();
    // 81,000 pay and a 30,000 bill leave 51,000: Needs 25,500 and Wants 15,300, so 40,800 to spend.
    // Spent 18,000 (Shopping 16,000, the Travel share 1,500, and the legacy Food 500).
    await expect(flipped.second.locator('[data-region="monthly-plan"]')).toContainText('₹22,800');
    await expect(flipped.second.locator('[data-region="goal"]')).toContainText('Laptop');
    await expect(flipped.second.locator('[data-region="goal"]')).toContainText('₹38,000');
    await expect(flipped.second.locator('[data-region="goal"]')).toContainText('₹7,600');
    await expect(flipped.second.locator('[data-region="trip"]')).toContainText('₹1,500');
    await expect(flipped.second.locator('.monthly-clarity-action-list > li')).not.toHaveCount(0);
    expect(await flipped.second.locator('.monthly-clarity-action-list > li').count()).toBeLessThanOrEqual(3);

    // The open journey resumes where it was; nothing is started again.
    await flipped.second.goto('/start');
    await expect(flipped.second.getByRole('heading', { level: 1, name: 'Guided journey' })).toBeVisible();
    await expect(flipped.second.getByRole('list', { name: 'Desired outcomes' })).toHaveCount(0);
    expect(world.journey.startsCreated).toBe(0);

    // The pay the legacy page saved, and the trip share counted once, with its category treatment.
    await flipped.second.goto('/plan');
    await expect(flipped.second.getByRole('textbox', { name: 'Monthly pay' })).toHaveValue('81000');
    await flipped.second.goto('/spending');
    await expect(flipped.second.getByRole('article', { name: `Spending for ${MONTH_NAME}` })).toContainText('₹18,000');
    await expect(flipped.second.locator('#expense-9000')).toContainText('Trip share');
    expect(flipped.api.requests.filter((request) => request.path.startsWith('/api/finance') || request.path.startsWith('/api/trips'))
      .every((request) => request.clarityContract === '1')).toBe(true);
    expect(featureData(world)).toEqual(before);
    expect(clarity.world).toBe(world);
    expect(flipped.api.unhandledRequests).toEqual([]);
    expect(flipped.api.blockedExternalRequests).toEqual([]);
  } finally {
    await flipped.second.unroute('**/*', flipped.handler);
    await flipped.context.close();
  }
});

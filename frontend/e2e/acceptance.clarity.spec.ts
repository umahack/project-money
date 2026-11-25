// Final cross-feature browser acceptance with the financial clarity flag on (task 17.5).
//
// One connected first-session story, played in one document through the real UI against one in-memory
// world (helpers/worldApi.ts, which composes the per-page fakes behind the full clarity contract):
//
//   register hand-off to /start -> redirected to /agreement (entries paused) -> agree -> back on /start ->
//   core promise and the compact data-use control ->
//   guided journey "Plan the month" (pay, then the optional bill) -> first outcome -> Home shows the
//   personalised summary before any generic content -> Plan: the pay is corrected while its calculation
//   explanation is open, and the explanation updates in place -> Spending: a Wants expense that exceeds its
//   budget -> Goals: create a goal, a contribution that fails and is retried -> Trips: a shared expense and the
//   user's personal share -> Home reflects every change (after the journey, the expense, the contribution, and
//   the trip).
//
// Throughout, for both tests: one document (identity marker, no reload, no navigation entry replaced), no
// page-wide loading state, no region blanked by a failure in another region, keyboard focus never falls to
// the page itself, no horizontal overflow, at most three Home actions, at most three required journey steps,
// and no Product Analytics sent while analytics is off. The story ends with axe-core in both themes.
//
// - "timed story" additionally asserts, for each financial change, pending feedback within 100 ms of submit
//   and the new outcome within 100 ms of the response. It uses `neutralizeDecorativeRendering`, so those
//   budgets measure application latency and not software-rendered blur; nothing else does.
// - "real-rendering story" replays the same steps against the unmodified production CSS and runs the layout
//   and accessibility audits there.
//
// Everything comes from in-memory fixtures; nothing leaves loopback. Per-feature depth (bounds, rounding,
// replays, interleavings, public projection) lives in the feature specs and the Vitest and backend suites.
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
  type DocumentIdentity,
  type FocusTracker,
  type ReloadSpy,
} from './helpers/browser';
import { expectFocusKept, runAxe, setTheme, THEMES, waitForSteadyColors } from './helpers/a11y';
import { currentMonthInIndia, monthName } from './helpers/clarityApi';
import { auditLayout, settleAnimations } from './helpers/layout';
import { installWorld, type WorldControl } from './helpers/worldApi';
import { TEST_USER, expect, test, type DeterministicApiFixtures } from './fixtures/test';
import type { Locator, Page, Response } from '@playwright/test';

const MONTH = currentMonthInIndia();
const MONTH_NAME = monthName(MONTH);
const BUDGET_MS = 100;
const CATEGORIES = ['Food', 'Groceries', 'Transport', 'Shopping', 'Travel', 'Other'];
const SALARY_SCOPE = `[data-scope="salary:${MONTH}"]`;

function monthAfter(month: string, offset: number): string {
  const [year, number] = month.split('-').map(Number) as [number, number];
  const date = new Date(year, number - 1 + offset, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/** Four months of contribution opportunities (this month and the three after) end in the fifth, at the 10th. */
const GOAL_DATE = `${monthAfter(MONTH, 4)}-10`;

/**
 * Pay 80,000, then a 30,000 bill: 50,000 to allocate, so Needs 25,000, Wants 15,000, saving 10,000, and 40,000
 * to spend. The pay is then corrected to 90,000 on Plan with the explanation open: 60,000 to allocate, Needs 30,000,
 * Wants 18,000, saving 12,000, 48,000 to spend. A 20,000 Shopping expense exceeds Wants by 2,000. A 40,000 goal gap
 * over five months needs 8,000 a month. Goa weekend already exists (the user joined it) with the user and Ravi.
 */
const WORLD = {
  month: MONTH,
  viewer: TEST_USER.email,
  categories: CATEGORIES,
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
    }],
  },
};

interface Story {
  page: Page;
  api: DeterministicApiFixtures;
  control: WorldControl;
  timed: boolean;
  identity: DocumentIdentity;
  reloads: ReloadSpy;
  focus: FocusTracker;
}

const isRequest = (method: string, path: string) => (response: Response) => (
  new URL(response.url()).pathname === path && response.request().method() === method
);

const comesBefore = (first: Locator, second: Locator) => first.evaluate(
  (a, selector) => {
    const b = document.querySelector(selector);
    return Boolean(b && a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  },
  // Locators cannot be passed into the page, so the second one is identified by a temporary attribute.
  '[data-story-marker="after"]',
);

async function expectOrder(first: Locator, second: Locator, what: string) {
  await second.evaluate((element) => element.setAttribute('data-story-marker', 'after'));
  try {
    expect(await comesBefore(first, second), what).toBe(true);
  } finally {
    await second.evaluate((element) => element.removeAttribute('data-story-marker'));
  }
}

/** The invariants that hold after every step of the story. */
async function expectStable(story: Story, { layout = false, focus = true }: { layout?: boolean; focus?: boolean } = {}) {
  const { page } = story;
  await expectSameDocument(page, story.identity);
  await story.reloads.expectNoReloads();
  await expect(page.getByText('Loading…', { exact: true }), 'no page-wide loading state').toHaveCount(0);
  if (focus) await expectFocusKept(page);
  if (layout) {
    // The page enters with a short JavaScript slide and fade, and a toast slides in from the right edge. Audit
    // them at rest, as a person reads them.
    await waitForSteadyColors(page);
    await settleAnimations(page);
    await page.evaluate(() => new Promise<void>((resolve) => {
      let previous = '';
      let steady = 0;
      const tick = () => {
        const now = Array.from(document.querySelectorAll('.toast'))
          .map((toast) => { const { left, right, top } = toast.getBoundingClientRect(); return `${left}|${right}|${top}`; })
          .join(';');
        steady = now === previous ? steady + 1 : 0;
        previous = now;
        if (steady >= 6) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }));
    await expectNoOverflowOrClipping(page, ['html', 'body', 'main']);
    // Only the real stylesheet is audited: the timed story removes decoration that has no layout effect,
    // but the layout audit should never see a modified page.
    if (!story.timed) expect(await auditLayout(page), 'layout audit').toEqual([]);
  }
}

interface Change {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** The `/api/...` path of the request this change sends. */
  path: string;
  trigger: () => Promise<void>;
  /** The scoped status that must show the change is pending. */
  pending: { selector: string; text: string; event?: 'submit' | 'click' };
  /** Something that is on screen only once the confirmed outcome has been painted. */
  painted: Locator;
}

/**
 * Sends one change with its response held. The timed story asserts the 100 ms budgets at both ends. The
 * other waits for the same states without a budget.
 */
async function performChange(story: Story, change: Change) {
  const { page } = story;
  const gate = story.control.hold(change.method, change.path);
  if (story.timed) await waitForQuietFrames(page);
  if (story.timed) {
    const pending = await measureSubmitToPaint(page, change.trigger, change.pending, change.pending.event ?? 'submit');
    expectSubmitToPaintWithin(pending, BUDGET_MS);
  } else {
    await change.trigger();
    await expect(page.locator(change.pending.selector).filter({ hasText: change.pending.text }).first()).toBeVisible();
  }
  await expect(page.getByText('Loading…', { exact: true }), 'pending feedback is scoped').toHaveCount(0);
  const response = page.waitForResponse(isRequest(change.method, change.path));
  gate.release();
  if (story.timed) {
    const painted = await measureResponseToPaint(page, response, change.painted);
    expect(painted.status).toBe(200);
    await expectResponseToPaintWithin(painted, BUDGET_MS);
  } else {
    expect((await response).status()).toBe(200);
    await expect(change.painted).toBeVisible();
  }
  await expectStable(story);
}

/** Opens a page through the signed-in navigation, as a user would, without a document load. */
async function goTo(story: Story, label: 'Home' | 'Spending' | 'Plan' | 'Goals' | 'Trips', ready: Locator) {
  const { page } = story;
  const link = page.locator('nav.primary-nav:visible, nav.bottom-tabs:visible').locator('a').filter({ hasText: label }).first();
  await link.click();
  await expect(ready).toBeVisible();
  await expectStable(story, { layout: true });
}

const heading = (page: Page, name: string, level = 2) => page.getByRole('heading', { level, name });
const homeSummary = (page: Page) => page.getByTestId('monthly-clarity-summary');
const region = (page: Page, name: string) => page.locator(`[data-region="${name}"]`);

/** Each text is somewhere in the region (an array passed to `toContainText` would mean one element per text). */
async function expectContains(locator: Locator, texts: string[]) {
  for (const text of texts) await expect(locator).toContainText(text);
}

/** What Home shows from the confirmed snapshot, before any generic content, with at most three actions. */
async function expectHome(story: Story, expected: { plan: string[]; savings?: string[]; goal?: string[]; trip?: string[]; actions: string[] }) {
  const { page } = story;
  await goTo(story, 'Home', homeSummary(page));
  await expectContains(region(page, 'monthly-plan'), expected.plan);
  if (expected.savings) await expectContains(region(page, 'spending'), expected.savings);
  if (expected.goal) await expectContains(region(page, 'goal'), expected.goal);
  if (expected.trip) await expectContains(region(page, 'trip'), expected.trip);
  const items = page.locator('.monthly-clarity-action-list > li');
  await expect(items).toHaveCount(expected.actions.length);
  expect(expected.actions.length).toBeLessThanOrEqual(3);
  for (const [index, text] of expected.actions.entries()) await expect(items.nth(index)).toContainText(text);
  // The core promise, then the personalised outcomes, then the guided-journey and shortcut content.
  await expectOrder(page.locator('.clarity-promise'), homeSummary(page), 'the core promise comes before the outcomes');
  await expectOrder(homeSummary(page), page.locator('#home-guided-journey'), 'personalised outcomes come before generic content');
  await expectStable(story, { layout: true });
}

async function playStory(page: Page, api: DeterministicApiFixtures, timed: boolean) {
  const control = installWorld(api, WORLD);
  const { world } = control;
  api.stub('POST', '/api/auth/register-start', { json: { ok: true } });
  api.stub('POST', '/api/auth/register-finish', { json: { token: 'playwright-register-token-not-valid-outside-tests', user: TEST_USER } });

  // ---- Register hand-off: the first screen after sign-up is the guided journey ----
  await page.goto('/register');
  await expect(page.locator('#pw')).toBeVisible();
  const story: Story = {
    page,
    api,
    control,
    timed,
    identity: await captureDocumentIdentity(page),
    reloads: await installReloadSpy(page),
    focus: await installFocusTracker(page),
  };
  await page.getByLabel('Your name').fill('Asha Rao');
  await page.getByLabel('Email', { exact: true }).fill(TEST_USER.email);
  await page.locator('#pw').fill('Secret#1234abc');
  await page.getByRole('button', { name: 'Send verification code' }).click();
  await page.getByLabel(/6-digit code/).fill('123456');
  await page.getByRole('button', { name: 'Create account' }).click();

  // ---- The account has to agree to the data-use notice first, so the hand-off lands on the Agreement page ----
  const agreementHeading = heading(page, 'Review how Project Money uses your data', 1);
  await expect(agreementHeading).toBeVisible();
  await expect(page).toHaveURL(/\/agreement$/);
  await expect(agreementHeading).toBeFocused();
  await expect(
    page.locator('nav.primary-nav, nav.bottom-tabs, .clarity-promise, section.clarity-gate'),
    'the Agreement page renders outside the shell',
  ).toHaveCount(0);
  expect(world.noticeAcknowledged).toBe(false);
  await expectStable(story, { layout: true, focus: false });
  // ---- Agreeing continues to the guided journey; the promise and the compact notice come before any entry ----
  await page.getByRole('button', { name: 'I agree and continue' }).click();
  await expect(heading(page, 'Guided journey', 1)).toBeVisible();
  await expect(page).toHaveURL(/\/start$/);
  const promise = heading(page, 'See what is safe to spend, what to save, and what to do next.');
  await expect(promise).toBeVisible();
  const gate = page.locator('section.clarity-gate');
  await expect(gate).toHaveAttribute('data-inputs-enabled', 'true');
  await expect(gate).toContainText('You acknowledged the data-use notice (version 1)');
  const choices = page.getByRole('list', { name: 'Desired outcomes' });
  await expect(choices.getByRole('button')).toHaveCount(4);
  await expectOrder(page.locator('.clarity-promise'), gate, 'the promise comes before the notice');
  await expectOrder(gate, choices, 'the notice comes before the first choice');
  expect(world.noticeAcknowledged).toBe(true);
  // The Agreement page that had focus is replaced by the journey, so there is no control to keep until the next step.
  await expectStable(story, { layout: true, focus: false });

  // ---- Guided journey: choose, pay (the one required step), first outcome, then the optional bill ----
  await choices.getByRole('button', { name: 'Plan the month' }).click();
  const payHeading = heading(page, 'Add your monthly pay');
  await expect(payHeading).toBeFocused();
  expect(world.journey.view()?.progress.requiredTotal, 'at most three required steps').toBeLessThanOrEqual(3);
  await expect(page.locator('.journey-progress-text')).toHaveText('Step 1 of 1; 1 required step remaining.');
  await expect(heading(page, 'Add monthly bills')).toHaveCount(0);

  const journeyGate = control.hold('PATCH', '/api/clarity/journeys/1');
  const savedPay = page.locator(SALARY_SCOPE).getByText(/Save pay: done/);
  await page.getByRole('textbox', { name: 'Monthly pay' }).fill('80000');
  await performChange(story, {
    method: 'POST',
    path: '/api/finance/salary',
    trigger: () => page.getByRole('button', { name: `Save pay for ${MONTH_NAME}` }).click(),
    pending: { selector: SALARY_SCOPE, text: 'Save pay: pending' },
    painted: savedPay,
  });
  const firstResult = heading(page, 'Your first result is ready');
  await expect(firstResult).toHaveCount(0);
  const confirmation = page.waitForResponse(isRequest('PATCH', '/api/clarity/journeys/1'));
  journeyGate.release();
  if (timed) {
    const revealed = await measureResponseToPaint(page, confirmation, firstResult);
    await expectResponseToPaintWithin(revealed, BUDGET_MS);
  } else {
    await confirmation;
    await expect(firstResult).toBeVisible();
  }
  await expect(firstResult).toBeFocused();
  await expect(page.getByRole('article', { name: `Your plan for ${MONTH_NAME}` })).toContainText('80,000');
  await expect(page.locator('.journey-progress-text')).toHaveText('All 1 required step done.');
  // The optional bill comes only after the first outcome.
  const billsHeading = heading(page, 'Add monthly bills');
  await expect(billsHeading).toBeVisible();
  await expectOrder(firstResult, billsHeading, 'the optional step follows the first outcome');
  await expectStable(story, { layout: true });

  await page.getByLabel('What is it?').fill('Rent');
  await page.getByLabel('₹ per month').fill('30000');
  await performChange(story, {
    method: 'POST',
    path: '/api/finance/emis',
    trigger: () => page.getByRole('button', { name: '+ Add bill' }).click(),
    pending: { selector: 'main', text: 'Add bill: pending' },
    painted: page.getByRole('article', { name: `Your plan for ${MONTH_NAME}` }).getByText('50,000').first(),
  });
  await expect(heading(page, 'Finish your journey')).toBeVisible();
  await page.getByRole('button', { name: 'Yes' }).click();
  await page.getByRole('button', { name: 'Finish journey' }).click();
  await expect(heading(page, 'Journey finished')).toBeFocused();
  expect(world.journey.journey?.status).toBe('completed');
  await expectStable(story, { layout: true });

  // ---- Home: the personalised summary, before generic content ----
  await expectHome(story, {
    plan: ['₹40,000'],
    savings: ['Projected savings', '₹50,000', 'Savings target', '₹10,000'],
    actions: [],
  });
  await expect(page.locator('.monthly-clarity-no-action, .monthly-clarity-action-list').first()).toBeVisible();

  // ---- Plan: correct the pay with the explanation open; the explanation updates in place, without closing ----
  const planCard = page.getByRole('article', { name: `Your plan for ${MONTH_NAME}` });
  await goTo(story, 'Plan', planCard);
  const explanationToggle = page.getByRole('button', { name: `How this was calculated for Your plan for ${MONTH_NAME}` });
  await explanationToggle.click();
  const explanation = page.getByRole('group', { name: `How Your plan for ${MONTH_NAME} was calculated` });
  await expect(explanation).toBeVisible();
  await expect(explanation).toContainText('₹80,000');
  await expect(explanation).toContainText(`Data version ${world.version}`);
  const versionBeforeCorrection = world.version;
  const payField = page.getByRole('textbox', { name: 'Monthly pay' });
  await expect(payField).toHaveValue('80000');
  await payField.fill('90000');
  await performChange(story, {
    method: 'POST',
    path: '/api/finance/salary',
    trigger: () => page.getByRole('button', { name: `Save pay for ${MONTH_NAME}` }).click(),
    pending: { selector: SALARY_SCOPE, text: 'Save pay: pending' },
    painted: planCard.getByText('60,000').first(),
  });
  expect(world.version).toBe(versionBeforeCorrection + 1);
  await expect(explanationToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(explanation).toBeVisible();
  await expect(explanation).toContainText(`Data version ${world.version}`);
  await expect(explanation).toContainText('₹90,000');
  await expect(explanation).not.toContainText('₹80,000');
  await expectStable(story, { layout: true });

  // ---- Spending: a Wants expense above the Wants budget (18,000) ----
  const spendingCard = page.getByRole('article', { name: `Spending for ${MONTH_NAME}` });
  await goTo(story, 'Spending', spendingCard);
  await page.getByRole('textbox', { name: 'Amount' }).fill('20000');
  await page.getByLabel('Category').selectOption('Shopping');
  await performChange(story, {
    method: 'POST',
    path: '/api/finance/expenses',
    trigger: () => page.getByRole('button', { name: '+ Log expense' }).click(),
    pending: { selector: '[data-pending-create]', text: 'Log expense: pending' },
    painted: page.getByRole('region', { name: 'Wants budget exceeded' }),
  });
  await expect(page.getByRole('region', { name: 'Wants budget exceeded' })).toContainText('Wants budget exceeded by ₹2,000.');
  await expect(spendingCard).toContainText('₹28,000');
  await expectStable(story, { layout: true });
  await expectHome(story, {
    plan: ['₹28,000'],
    actions: ['Review Wants spending'],
  });

  // ---- Goals: add a goal, then a contribution that fails once and is retried ----
  await goTo(story, 'Goals', page.getByRole('form', { name: 'Add a goal' }));
  await page.getByRole('form', { name: 'Add a goal' }).getByLabel('Goal name').fill('Laptop');
  await page.getByRole('form', { name: 'Add a goal' }).getByLabel('Target amount').fill('50000');
  await page.getByRole('form', { name: 'Add a goal' }).getByLabel(/Saved so far/).fill('10000');
  await page.getByRole('form', { name: 'Add a goal' }).getByLabel('Target date').fill(GOAL_DATE);
  await performChange(story, {
    method: 'POST',
    path: '/api/finance/goals',
    trigger: () => page.getByRole('form', { name: 'Add a goal' }).getByRole('button', { name: 'Add goal' }).click(),
    pending: { selector: 'main', text: 'Add goal: pending' },
    painted: page.getByRole('article', { name: 'Laptop', exact: true }),
  });
  const laptop = page.getByRole('article', { name: 'Laptop', exact: true });
  await expect(laptop).toContainText('₹40,000');
  await expect(laptop).toContainText('₹8,000');
  await page.getByRole('button', { name: 'Add contribution to Laptop', exact: true }).click();
  const contribution = page.getByRole('form', { name: 'Add a contribution to Laptop' });
  await contribution.getByRole('textbox', { name: 'Contribution amount' }).fill('5000');

  // The first save fails: the failure is scoped to this goal, the confirmed values and every other region stay.
  world.goals.failNext('POST', '/finance/goals/1/contributions', 500, 'SERVER_ERROR', 'The contribution could not be saved.');
  await contribution.getByRole('button', { name: 'Save contribution' }).click();
  const retry = page.getByRole('button', { name: /^Retry Add contribution to Laptop/ });
  await expect(retry).toBeVisible();
  await expect(page.locator('[data-scope="goal:1"]')).toContainText('Your last confirmed values are unchanged.');
  await expect(laptop).toContainText('₹40,000');
  await expect(contribution.getByRole('textbox', { name: 'Contribution amount' })).toHaveValue('5000');
  await expect(page.getByRole('form', { name: 'Add a goal' })).toBeVisible();
  await expect(page.locator('[data-scope="goal:1"]').getByText('Add contribution to Laptop: done')).toHaveCount(0);
  await expectStable(story, { layout: true });
  expect(world.goals.find(1)?.savedMinor).toBe(1_000_000);

  // Retrying resends the same change and confirms it once.
  const retried = performChange(story, {
    method: 'POST',
    path: '/api/finance/goals/1/contributions',
    trigger: () => retry.click(),
    pending: { selector: '[data-scope="goal:1"]', text: 'Add contribution to Laptop: pending', event: 'click' },
    painted: laptop.getByText('₹35,000').first(),
  });
  await retried;
  expect(world.goals.find(1)?.savedMinor).toBe(1_500_000);
  await expect(laptop).toContainText('₹7,000');
  await expectStable(story, { layout: true });
  await expectHome(story, {
    plan: ['₹28,000'],
    goal: ['Urgent goal: Laptop', '₹35,000', '₹7,000'],
    actions: ['Contribute to goal', 'Review Wants spending'],
  });

  // ---- Trips: a shared expense, then the user's personal share in monthly spending ----
  await goTo(story, 'Trips', page.getByText('Goa weekend').first());
  await page.getByRole('link', { name: /Goa weekend/ }).first().click();
  await expect(page.getByRole('tab', { name: /Balances/ })).toBeVisible();
  // The trip card link that had focus is replaced by the trip page, as the sign-up form was: no active control yet.
  await expectStable(story, { layout: true, focus: false });
  await page.getByRole('textbox', { name: 'What for?' }).fill('Hotel');
  await page.getByRole('textbox', { name: 'Amount (₹)' }).fill('3000');
  await performChange(story, {
    method: 'POST',
    path: '/api/trips/3/expenses',
    trigger: () => page.getByRole('button', { name: 'Add & split' }).click(),
    pending: { selector: '[data-scope="new-trip-expense:3"]', text: 'Add expense: pending' },
    painted: page.getByRole('list', { name: 'Each member’s share of Hotel' }),
  });
  await expect(page.getByRole('list', { name: 'Each member’s share of Hotel' }).getByRole('listitem')).toHaveText([/Asha\s*₹1,500/, /Ravi\s*₹1,500/]);

  await page.getByRole('button', { name: 'Include in my spending: Hotel' }).click();
  const confirmShare = page.getByRole('form', { name: 'Confirm including your share of Hotel' });
  await expect(confirmShare).toContainText('Add ₹1,500');
  await confirmShare.getByLabel('Category').selectOption('Travel');
  await performChange(story, {
    method: 'PUT',
    path: '/api/trips/3/expenses/1/personal-link',
    trigger: () => confirmShare.getByRole('button', { name: 'Confirm and include' }).click(),
    pending: { selector: '[data-scope="trip-personal-link:1"]', text: 'Include my share of Hotel: pending' },
    painted: page.getByRole('button', { name: 'Withdraw from my spending: Hotel' }),
  });
  expect(world.trips.account().links).toHaveLength(1);
  expect(world.spending.expenses.some((expense) => expense.category === 'Travel' && expense.amountMinor === 150_000)).toBe(true);
  await page.getByRole('tab', { name: /Balances/ }).click();
  await expect(page.locator('.trip-own-balance')).toContainText('You are owed ₹1,500');
  await expectStable(story, { layout: true });

  // ---- Home reflects every change, in place ----
  await expectHome(story, {
    // 48,000 to spend after the pay correction, less 20,000 on Shopping and the 1,500 Travel share counted as Wants.
    plan: ['₹26,500'],
    goal: ['Urgent goal: Laptop', '₹35,000', '₹7,000'],
    trip: ['Nearest trip settlement: Goa weekend', 'You are owed', '₹1,500'],
    actions: ['Contribute to goal', 'Review Wants spending', 'Settle trip balance'],
  });
  await expect(region(page, 'actions')).toContainText('₹3,500');

  // ---- The whole story used one document, sent no analytics, and kept every financial entry scoped ----
  await expectSameDocument(page, story.identity);
  await story.reloads.expectNoReloads();
  expect(world.analyticsEnabled).toBe(false);
  expect(world.events, 'Product Analytics is off, so no event is sent').toEqual([]);
  expect(api.count('POST', '/api/clarity/events')).toBe(0);
  const writes = world.log.filter((entry) => !entry.startsWith('GET '));
  // The journey's pay and the correction on Plan: two confirmed changes, never a duplicate.
  expect(writes.filter((entry) => entry === 'POST /finance/salary')).toHaveLength(2);
  expect(world.plan.salary?.amountMinor).toBe(9_000_000);
  expect(writes.filter((entry) => entry === 'POST /finance/goals/1/contributions')).toHaveLength(2);
  expect(world.goals.find(1)?.savedMinor, 'the retried contribution was applied once').toBe(1_500_000);
  expect(world.spending.expenses.filter((expense) => expense.category === 'Shopping')).toHaveLength(1);
  expect(world.trips.trip(3).expenses).toHaveLength(1);

  // ---- Accessibility of the final Home, in both themes (real stylesheet only) ----
  if (!timed) {
    for (const theme of THEMES) {
      await setTheme(page, theme);
      await settleAnimations(page);
      const { violations } = await runAxe(page);
      expect(violations, `axe violations in the ${theme} theme`).toEqual([]);
    }
    await setTheme(page, 'light');
  }
  await expectStable(story, { layout: !timed });
}

// Screen recording and tracing halve headless Chromium's frame rate (17 to 33 ms per frame becomes a steady
// 33 ms), which would count against a 100 ms paint budget. Failures still keep a screenshot and the error context.
test.use({ video: 'off', trace: 'off' });

test.describe('timed story', () => {
  // The budgets measure application latency, so the background blob animation and backdrop blur are switched
  // off with a test-only stylesheet here and only here (production CSS is unchanged).
  test.use({ neutralizeDecorativeRendering: true });
  // Paint timing depends on the host's frame rate. A real regression misses a budget on every attempt.
  test.describe.configure({ retries: 2 });

  test('a connected first session gives scoped feedback within 100 ms and never reloads or blanks the page', async ({ page, api }) => {
    test.setTimeout(180_000);
    await playStory(page, api, true);
  });
});

test.describe('real-rendering story', () => {
  test('the same session passes the layout and accessibility audits on the production stylesheet, in both themes', async ({ page, api }) => {
    test.setTimeout(180_000);
    await playStory(page, api, false);
  });
});

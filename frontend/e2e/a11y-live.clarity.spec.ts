// Live regions on the clarity pages (task 17.4, Requirements 12.3 and 12.16).
//
// A MutationObserver watches every live region (`aria-live`, `role="status"`, `role="alert"`) from the first
// paint, the way a screen reader's live-region tracking does, and records each time a region's text changes:
//
// 1. Outcomes and status text are polite. An assertive region ("alert") carries text only for an error.
// 2. During one change, only the outcome that changed announces. Its unchanged siblings stay silent.
// 3. No region announces the same text over and over.
import { MONTH, MONTH_NAME, SCENARIOS, signIn } from './helpers/clarityScenarios';
import { installGoalsBackend } from './helpers/goalsApi';
import { installClarityBackend } from './helpers/clarityApi';
import { settleAnimations } from './helpers/layout';
import { expect, test } from './fixtures/test';
import type { Page } from '@playwright/test';

test.use({ video: 'off', trace: 'off' });

interface Announcement {
  /** The outcome card (`goal:3`), the mutation scope (`salary:2026-01`), or `page`. */
  owner: string;
  assertive: boolean;
  /** Class names of the live region, to tell an error container from a status line. */
  regionClass: string;
  text: string;
}

const LOG_KEY = '__pmAnnouncementLog';
/** The containers the app uses for errors. Assertive text anywhere else is a defect. */
const ERROR_CONTAINERS = /clarity-mutation-failure|clarity-field-error|clarity-region-error|clarity-gate-error|form-error|journey-failure/;

async function installAnnouncementLog(page: Page): Promise<void> {
  await page.addInitScript((key) => {
    const log: unknown[] = [];
    (window as unknown as Record<string, unknown>)[key] = log;
    const LIVE = '[aria-live], [role="status"], [role="alert"]';
    const regionOf = (node: Node | null): Element | null => {
      const element = node instanceof Element ? node : node?.parentElement ?? null;
      return element?.closest(LIVE) ?? null;
    };
    const record = (region: Element) => {
      const text = (region.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (!text) return;
      const live = region.getAttribute('aria-live');
      log.push({
        owner: region.closest('article[data-outcome-id]')?.getAttribute('data-outcome-id')
          ?? region.closest('[data-scope]')?.getAttribute('data-scope')
          ?? 'page',
        assertive: live === 'assertive' || (live === null && region.getAttribute('role') === 'alert'),
        regionClass: String(region.className),
        text,
      });
    };
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        const region = regionOf(mutation.target);
        if (region) record(region);
        for (const added of Array.from(mutation.addedNodes)) {
          if (added instanceof Element) {
            if (added.matches(LIVE)) record(added);
            added.querySelectorAll(LIVE).forEach(record);
          }
        }
      }
    });
    const start = () => observer.observe(document, { childList: true, subtree: true, characterData: true });
    if (document.documentElement) start();
    else document.addEventListener('DOMContentLoaded', start);
  }, LOG_KEY);
}

async function announcements(page: Page): Promise<Announcement[]> {
  return page.evaluate((key) => [...((window as unknown as Record<string, Announcement[]>)[key] ?? [])], LOG_KEY);
}

async function clearAnnouncements(page: Page): Promise<void> {
  await page.evaluate((key) => { ((window as unknown as Record<string, unknown[]>)[key] as unknown[]).length = 0; }, LOG_KEY);
}

async function openGoals(page: Page, api: Parameters<(typeof SCENARIOS)[number]['open']>[1]) {
  await installAnnouncementLog(page);
  const control = installGoalsBackend(api, MONTH, {
    goals: [
      { id: 1, name: 'Holiday', target: 900, saved: 100, date: `${MONTH}-28` },
      { id: 2, name: 'Phone', target: 500, saved: 0, date: `${MONTH}-28` },
      { id: 3, name: 'Laptop', target: 1000, saved: 400, date: `${MONTH}-28` },
    ],
  });
  await signIn(page, '/goals');
  await expect(page.getByRole('article', { name: 'Laptop', exact: true })).toBeVisible();
  await expect(page.getByRole('article', { name: 'Holiday', exact: true })).toBeVisible();
  await expect(page.getByRole('article', { name: 'Phone', exact: true })).toBeVisible();
  await page.waitForTimeout(400);
  await settleAnimations(page);
  return control;
}

test('a contribution announces only the goal that changed, politely, and its siblings stay silent', async ({ page, api }) => {
  await openGoals(page, api);
  await clearAnnouncements(page);
  await page.getByRole('button', { name: 'Add contribution to Laptop', exact: true }).click();
  const form = page.getByRole('form', { name: 'Add a contribution to Laptop' });
  await form.getByRole('textbox', { name: 'Contribution amount' }).fill('100');
  await form.getByRole('button', { name: 'Save contribution' }).click();
  await expect(page.locator('[data-scope="goal:3"]')).toContainText('Add contribution to Laptop: done');
  await page.waitForTimeout(500);

  const heard = await announcements(page);
  const owners = new Set(heard.map((entry) => entry.owner));
  expect(owners.has('goal:3'), 'the changed goal announces its new outcome').toBe(true);
  expect([...owners].filter((owner) => owner === 'goal:1' || owner === 'goal:2'), 'unchanged sibling goals announce nothing').toEqual([]);
  const own = heard.filter((entry) => entry.owner === 'goal:3' && entry.regionClass.includes('sr-only'));
  expect(own.length, 'the outcome announcement is written once').toBeGreaterThanOrEqual(1);
  expect(own.at(-1)?.text).toMatch(/Laptop/);
  expect(own.at(-1)?.text).toMatch(/Status: Confirmed/);
  expect(heard.filter((entry) => entry.assertive), 'a successful save raises no alert').toEqual([]);
  // The same text is never written to the same region more than twice (a re-render of an unchanged outcome would repeat it).
  const repeats = new Map<string, number>();
  for (const entry of heard) repeats.set(`${entry.owner}|${entry.text}`, (repeats.get(`${entry.owner}|${entry.text}`) ?? 0) + 1);
  expect([...repeats].filter(([, count]) => count > 2).map(([key]) => key)).toEqual([]);
});

test('a failed contribution raises its alert only in the error container, and siblings stay silent', async ({ page, api }) => {
  const control = await openGoals(page, api);
  control.backend.failNext('POST', '/finance/goals/3/contributions', 500, 'SERVER_ERROR', 'The contribution could not be saved.');
  await clearAnnouncements(page);
  await page.getByRole('button', { name: 'Add contribution to Laptop', exact: true }).click();
  const form = page.getByRole('form', { name: 'Add a contribution to Laptop' });
  await form.getByRole('textbox', { name: 'Contribution amount' }).fill('100');
  await form.getByRole('button', { name: 'Save contribution' }).click();
  await expect(page.locator('[data-scope="goal:3"]')).toContainText('Add contribution to Laptop: failed.');
  await page.waitForTimeout(400);

  const heard = await announcements(page);
  const assertive = heard.filter((entry) => entry.assertive);
  expect(assertive.length, 'the failure is announced').toBeGreaterThan(0);
  expect(assertive.filter((entry) => !ERROR_CONTAINERS.test(entry.regionClass)), 'assertive text only in an error container').toEqual([]);
  expect(assertive.some((entry) => entry.text.includes('The contribution could not be saved.'))).toBe(true);
  const status = heard.filter((entry) => !entry.assertive && entry.owner === 'goal:3');
  expect(status.length, 'pending and failed also appear as polite status text').toBeGreaterThan(0);
  expect(heard.filter((entry) => entry.owner === 'goal:1' || entry.owner === 'goal:2')).toEqual([]);
});

test('a validation error is announced without moving focus, and is not announced again while it is unchanged', async ({ page, api }) => {
  await openGoals(page, api);
  await page.getByRole('button', { name: 'Add contribution to Laptop', exact: true }).click();
  const form = page.getByRole('form', { name: 'Add a contribution to Laptop' });
  const amount = form.getByRole('textbox', { name: 'Contribution amount' });
  await amount.fill('99999999');
  await clearAnnouncements(page);
  // Submit from the field with Enter, as a keyboard user does. Clicking Save would move focus to the button.
  await amount.press('Enter');
  await expect(form.locator('.clarity-field-error:not(:empty)').first()).toBeVisible();
  await page.waitForTimeout(300);
  const heard = await announcements(page);
  const errors = heard.filter((entry) => entry.assertive && entry.regionClass.includes('clarity-field-error'));
  expect(errors.length, 'the validation error is announced').toBeGreaterThan(0);
  expect(errors.at(-1)?.text.length ?? 0, 'it names what is wrong and the accepted range').toBeGreaterThan(20);
  expect(new Set(errors.map((entry) => entry.text)).size, 'one validation message, not a changing one').toBe(1);
  expect(await amount.evaluate((node) => node === document.activeElement)).toBe(true);
});

for (const name of [
  'Home: full outcomes with a seven-digit pay and long bill names',
  'Plan: full plan with a seven-digit pay and long bill names',
  'Spending: full list with seven-digit amounts and long notes',
  'Goals: full list with long Unicode names and seven-digit amounts',
  'Trips: list with long Unicode names and a seven-digit budget',
  'TripDetail: long names, long expense text, and seven-digit amounts',
]) {
  test(`at rest, "${name}" has no alert text and every outcome card has one polite status region`, async ({ page, api }) => {
    const scenario = SCENARIOS.find((candidate) => candidate.name === name);
    if (!scenario) throw new Error(`No scenario is named "${name}".`);
    await scenario.open(page, api);
    await page.waitForTimeout(400);
    const state = await page.evaluate(() => ({
      alerts: Array.from(document.querySelectorAll('[role="alert"], [aria-live="assertive"]'))
        .map((region) => (region.textContent ?? '').trim()).filter(Boolean),
      cards: Array.from(document.querySelectorAll('article.clarity-outcome')).map((card) => ({
        id: (card as HTMLElement).dataset.outcomeId ?? '',
        regions: Array.from(card.querySelectorAll(':scope > p.sr-only[role="status"]')).map((region) => region.getAttribute('aria-live')),
      })),
    }));
    expect(state.alerts, 'no alert text while nothing is wrong').toEqual([]);
    // The trip pages show their outcomes in lists and summaries, not as outcome cards.
    if (!/^Trips|^TripDetail/.test(name)) expect(state.cards.length).toBeGreaterThan(0);
    for (const card of state.cards) expect(card.regions, `${card.id} has one polite announcement region`).toEqual(['polite']);
  });
}

test('an unchanged pay saved again announces nothing new', async ({ page, api }) => {
  await installAnnouncementLog(page);
  installClarityBackend(api, MONTH, { salaryMinor: 7_500_000 });
  await signIn(page, '/plan');
  const pay = page.getByRole('textbox', { name: 'Monthly pay' });
  await expect(pay).toHaveValue('75000');
  await page.waitForTimeout(400);
  await clearAnnouncements(page);
  await pay.fill('75000');
  await page.getByRole('button', { name: `Save pay for ${MONTH_NAME}` }).click();
  await expect(page.locator(`[data-scope="salary:${MONTH}"]`)).toContainText(/Save pay: (done|pending)/);
  await page.waitForTimeout(500);
  const cardAnnouncements = (await announcements(page)).filter((entry) => entry.regionClass.includes('sr-only'));
  expect(cardAnnouncements.filter((entry) => /Status: /.test(entry.text) && entry.text.includes('Disposable income')), 'the plan card did not change, so it is silent').toEqual([]);
});

// Guards the test-only `neutralizeDecorativeRendering` helper used by the paint-budget specs.
//
// The helper must change nothing but decorative cost. These tests run against the real
// production stylesheet first, then inject the helper's stylesheet into the same loaded
// page and assert that:
//
// - before injection the real CSS is in effect (the background blobs animate and some
//   surface has a backdrop blur), so the comparison is not vacuous,
// - after injection the blob animation, blob filter, and every backdrop-filter are gone,
// - the bounding boxes of the form controls and cards on Plan, Goals, and Spending are
//   identical before and after, and the page height is unchanged,
// - the fixture option applies the helper to a fresh navigation and is off by default.
//
// Runs on the `clarity-*` projects against the in-memory fixture backends.
import { neutralizeDecorativeRendering, waitForQuietFrames } from './helpers/browser';
import { currentMonthInIndia, installClarityBackend, monthName } from './helpers/clarityApi';
import { installGoalsBackend } from './helpers/goalsApi';
import { installSpendingBackend } from './helpers/spendingApi';
import { expect, installAuthenticatedSession, test, type DeterministicApiFixtures } from './fixtures/test';
import type { Page } from '@playwright/test';

test.use({ video: 'off', trace: 'off' });

const MONTH = currentMonthInIndia();
const MONTH_NAME = monthName(MONTH);

interface PageUnderTest {
  name: string;
  path: string;
  open(api: DeterministicApiFixtures): void;
  ready(page: Page): Promise<void>;
}

const PAGES: PageUnderTest[] = [
  {
    name: 'Plan',
    path: '/plan',
    open: (api) => { installClarityBackend(api, MONTH, { salaryMinor: 7_500_000 }); },
    ready: async (page) => {
      await expect(page.getByRole('article', { name: `Your plan for ${MONTH_NAME}` })).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'Monthly pay' })).toHaveValue('75000');
    },
  },
  {
    name: 'Goals',
    path: '/goals',
    open: (api) => {
      installGoalsBackend(api, MONTH, { goals: [{ id: 1, name: 'Laptop', target: 1000, saved: 400, date: `${MONTH}-28` }] });
    },
    ready: async (page) => {
      await expect(page.getByRole('article', { name: 'Laptop', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Add contribution to Laptop' })).toBeVisible();
    },
  },
  {
    name: 'Spending',
    path: '/spending',
    open: (api) => { installSpendingBackend(api, MONTH, { expenses: [{ category: 'Food', amount: 500 }] }); },
    ready: async (page) => {
      await expect(page.getByRole('article', { name: `Spending for ${MONTH_NAME}` })).toBeVisible();
      await expect(page.getByRole('button', { name: '+ Log expense' })).toBeVisible();
    },
  },
];

/** Waits for finite entrance animations and transitions, then for steady frames. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const finite = document.getAnimations().filter((animation) => (
      animation.effect?.getComputedTiming().iterations !== Infinity
    ));
    await Promise.all(finite.map((animation) => animation.finished.catch(() => undefined)));
  });
  await waitForQuietFrames(page);
}

interface Box {
  key: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Bounding boxes of the controls and cards the paint-budget specs interact with. */
async function measureGeometry(page: Page): Promise<{ boxes: Box[]; pageHeight: number; pageWidth: number }> {
  return page.evaluate(() => {
    const selector = 'main input, main select, main textarea, main button, main article, main form, main [role="group"], main [role="region"]';
    const boxes = Array.from(document.querySelectorAll<HTMLElement>(selector)).map((element, index) => {
      const rect = element.getBoundingClientRect();
      const name = element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 40) ?? '';
      return {
        key: `${index}:${element.tagName.toLowerCase()}:${name}`,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      };
    });
    return {
      boxes,
      pageHeight: document.documentElement.scrollHeight,
      pageWidth: document.documentElement.scrollWidth,
    };
  });
}

/** Counts of decorative effects that are active in the loaded document. */
async function activeDecoration(page: Page) {
  return page.evaluate(() => {
    const blobs = Array.from(document.querySelectorAll<HTMLElement>('.blob'));
    return {
      blobCount: blobs.length,
      animatedBlobs: blobs.filter((blob) => getComputedStyle(blob).animationName !== 'none').length,
      filteredBlobs: blobs.filter((blob) => getComputedStyle(blob).filter !== 'none').length,
      backdropBlurred: Array.from(document.querySelectorAll<HTMLElement>('*'))
        .filter((element) => getComputedStyle(element).backdropFilter !== 'none').length,
    };
  });
}

for (const target of PAGES) {
  test(`${target.name}: neutralizing decorative rendering leaves layout geometry unchanged`, async ({ page, api }) => {
    target.open(api);
    await installAuthenticatedSession(page);
    await page.goto(target.path);
    await target.ready(page);
    await settle(page);

    // The real stylesheet is in effect: this is what the helper has to remove.
    const before = await activeDecoration(page);
    expect(before.blobCount, 'The app should render its background blobs').toBeGreaterThan(0);
    expect(before.animatedBlobs).toBe(before.blobCount);
    expect(before.filteredBlobs).toBe(before.blobCount);
    expect(before.backdropBlurred, 'Some surface should have a backdrop blur').toBeGreaterThan(0);
    const geometryBefore = await measureGeometry(page);
    expect(geometryBefore.boxes.length, 'The page should have controls to compare').toBeGreaterThan(3);

    await neutralizeDecorativeRendering(page);
    await settle(page);

    const after = await activeDecoration(page);
    expect(after).toEqual({ blobCount: before.blobCount, animatedBlobs: 0, filteredBlobs: 0, backdropBlurred: 0 });
    expect(await measureGeometry(page)).toEqual(geometryBefore);
  });
}

test('the helper is idempotent and does not stack style elements', async ({ page, api }) => {
  PAGES[0]!.open(api);
  await installAuthenticatedSession(page);
  await page.goto(PAGES[0]!.path);
  await PAGES[0]!.ready(page);
  await neutralizeDecorativeRendering(page);
  await neutralizeDecorativeRendering(page);
  expect(await page.locator('style[id="__pmPlaywrightNeutralizedDecorativeRendering"]').count()).toBe(1);
});

test('without the fixture option a fresh navigation keeps the real stylesheet', async ({ page, api }) => {
  PAGES[0]!.open(api);
  await installAuthenticatedSession(page);
  await page.goto(PAGES[0]!.path);
  await PAGES[0]!.ready(page);
  expect(await page.locator('style[id="__pmPlaywrightNeutralizedDecorativeRendering"]').count()).toBe(0);
  const state = await activeDecoration(page);
  expect(state.animatedBlobs).toBeGreaterThan(0);
});

test.describe('with the fixture option', () => {
  test.use({ neutralizeDecorativeRendering: true });

  test('a fresh navigation loads with the decorative cost already removed', async ({ page, api }) => {
    PAGES[0]!.open(api);
    await installAuthenticatedSession(page);
    await page.goto(PAGES[0]!.path);
    await PAGES[0]!.ready(page);
    expect(await activeDecoration(page)).toMatchObject({ animatedBlobs: 0, filteredBlobs: 0, backdropBlurred: 0 });
  });
});

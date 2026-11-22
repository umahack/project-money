// Responsive acceptance for the signed-in Shell navigation (task 17.3, Requirements 12.8 and 12.9).
//
// At every configured width, in both themes and for the user and admin variants, exactly one
// primary navigation is shown (the header navigation from 900 CSS pixels, the bottom navigation
// below), every destination is visible, fully readable, not covered by another element, and
// reachable by keyboard focus, and the top bar and page do not overflow, clip, or overlap. The
// width 820 to 899 transition is checked explicitly: it used to have no navigation at all. The
// widths from 900 to 1320, where the header wraps its links onto a second row, are checked too.
//
// This file runs on the `chromium-*` projects (legacy flag off) because the Shell is shared;
// the clarity pages add their own navigation checks in responsive.clarity.spec.ts and
// top-navigation.clarity.spec.ts.
import { auditLayout, contentHiddenByBottomNavigation, scaleText } from './helpers/layout';
import { TEST_USER, expect, installAuthenticatedSession, test, type DeterministicApiFixtures } from './fixtures/test';
import type { Page, TestInfo } from '@playwright/test';

const ADMIN_USER = { ...TEST_USER, id: 9002, is_admin: true, name: 'Browser Fixture Admin' };
const USER_LABELS = ['Home', 'Spending', 'Plan', 'Goals', 'Trips', 'Settings'];
const ADMIN_LABELS = ['Overview', 'Users', 'Feedback', 'Traffic', 'Broadcast', 'My account'];
/** The header navigation replaces the bottom navigation at this width (styles.css, "App shell and primary navigation"). */
const TOP_NAV_FROM = 900;

function widthOf(testInfo: TestInfo): number {
  const viewport = testInfo.project.use.viewport;
  if (!viewport) throw new Error('Every responsive project sets a viewport.');
  return viewport.width;
}

function stubShell(api: DeterministicApiFixtures): void {
  api.stub('GET', '/api/invites', { json: { invites: [] } });
  api.stub('GET', '/api/admin/feedback', { json: { feedback: [] } });
}

async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
}

/** The visible primary navigation and the labels it shows. */
async function visibleNavigation(page: Page) {
  const top = page.locator('header.topbar nav.primary-nav');
  const bottom = page.locator('nav.bottom-tabs');
  const topShown = await top.isVisible();
  const bottomShown = await bottom.isVisible();
  return { topShown, bottomShown, root: topShown ? top : bottom, linkSelector: topShown ? '.primary-link' : '.btab' };
}

/** Each link is readable in full, inside the viewport, and the topmost element at its center. */
async function expectLinksUsable(page: Page, labels: string[]): Promise<void> {
  const { root, linkSelector } = await visibleNavigation(page);
  const links = root.locator(linkSelector);
  for (const label of labels) {
    const link = links.filter({ hasText: label }).first();
    await expect(link, `${label} link is visible`).toBeVisible();
    await link.focus();
    const state = await link.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const probe = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      const text = element.querySelector<HTMLElement>('.primary-label, small') ?? element;
      return {
        focused: document.activeElement === element,
        inViewport: rect.left >= -1 && rect.right <= document.documentElement.clientWidth + 1 && rect.top >= -1 && rect.bottom <= window.innerHeight + 1,
        topmost: probe === element || element.contains(probe),
        labelFits: text.scrollWidth <= text.clientWidth + 1,
        labelWidth: Math.round(text.getBoundingClientRect().width),
      };
    });
    expect(state, `${label} link`).toMatchObject({ focused: true, inViewport: true, topmost: true, labelFits: true });
  }
}

for (const variant of [
  { name: 'user', user: TEST_USER, path: '/not-a-page', labels: USER_LABELS },
  { name: 'admin', user: ADMIN_USER, path: '/admin/feedback', labels: ADMIN_LABELS },
]) {
  test.describe(`${variant.name} navigation`, () => {
    for (const theme of ['light', 'dark'] as const) {
      test(`shows one usable primary navigation without overflow, clipping, or overlap (${theme})`, async ({ page, api }, testInfo) => {
        const width = widthOf(testInfo);
        stubShell(api);
        await installAuthenticatedSession(page, variant.user);
        await page.goto(variant.path);
        await expect(page.locator('main')).toBeVisible();
        await setTheme(page, theme);

        const nav = await visibleNavigation(page);
        expect(nav.topShown, 'header navigation shown from 900 px').toBe(width >= TOP_NAV_FROM);
        expect(nav.bottomShown, 'bottom navigation shown below 900 px').toBe(width < TOP_NAV_FROM);
        await expectLinksUsable(page, variant.labels);
        expect(await auditLayout(page, { touchTargets: width < TOP_NAV_FROM, measure: width >= 1440 })).toEqual([]);
        if (width < TOP_NAV_FROM) expect(await contentHiddenByBottomNavigation(page)).toEqual([]);
      });
    }
  });
}

test('an admin keeps the view switch and sign out reachable in the top bar', async ({ page, api }, testInfo) => {
  const width = widthOf(testInfo);
  stubShell(api);
  await installAuthenticatedSession(page, ADMIN_USER);
  await page.goto('/not-a-page');
  const bar = page.locator('header.topbar');
  for (const name of ['Switch to admin console', 'Toggle theme', 'Sign out']) {
    const control = bar.getByRole('button', { name });
    await expect(control).toBeVisible();
    await control.focus();
    const box = await control.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= width + 1, `${name} sits inside the viewport`).toBe(true);
  }
  expect(await auditLayout(page, { touchTargets: width < TOP_NAV_FROM })).toEqual([]);
});

test('the admin view marks its current page in the header navigation and keeps the user links out of it', async ({ page, api }, testInfo) => {
  test.skip(widthOf(testInfo) < TOP_NAV_FROM, 'The bottom navigation is checked by the other tests in this file.');
  stubShell(api);
  await installAuthenticatedSession(page, ADMIN_USER);
  await page.goto('/admin/feedback');
  const nav = page.locator('header.topbar nav.primary-nav');
  await expect(nav.getByRole('link')).toHaveText(ADMIN_LABELS.map((label) => new RegExp(label)));
  const current = nav.locator('a[aria-current="page"]');
  await expect(current).toHaveCount(1);
  await expect(current).toContainText('Feedback');
});

test('navigation survives text scaled to 200 percent', async ({ page, api }, testInfo) => {
  const width = widthOf(testInfo);
  test.skip(width > 390, 'Text scaling is checked on phone widths, where navigation is tightest.');
  stubShell(api);
  await installAuthenticatedSession(page);
  await page.goto('/not-a-page');
  await expect(page.locator('main')).toBeVisible();
  await scaleText(page, 200);
  await expectLinksUsable(page, USER_LABELS);
  // Only the shell is audited here. Page content at 200 percent is checked by the clarity page specs.
  expect(await auditLayout(page, { within: ['header.topbar', 'nav.bottom-tabs'] })).toEqual([]);
});

test('exactly one navigation is shown on each side of every breakpoint edge', async ({ page, api }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-768', 'Edge widths are resized inside one project.');
  stubShell(api);
  await installAuthenticatedSession(page);
  await page.goto('/not-a-page');
  await expect(page.locator('main')).toBeVisible();
  // 900 to 1319 is where the header wraps its links onto a second row; 1320 is where they share the first row.
  for (const width of [319, 320, 419, 420, 520, 521, 767, 768, 819, 820, 899, 900, 901, 999, 1000, 1099, 1100, 1199, 1200, 1319, 1320, 1321, 1439]) {
    await page.setViewportSize({ width, height: 900 });
    const nav = await visibleNavigation(page);
    expect(nav.topShown, `header navigation at ${width}`).toBe(width >= TOP_NAV_FROM);
    expect(nav.bottomShown, `bottom navigation at ${width}`).toBe(width < TOP_NAV_FROM);
    await expectLinksUsable(page, USER_LABELS);
    expect(await auditLayout(page), `layout at ${width}`).toEqual([]);
  }
});

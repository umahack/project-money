// Responsive layout acceptance for the financial clarity pages (task 17.3, Requirements 12.8 and 12.9).
//
// Every scenario below opens a clarity page in a given state with deterministic fixtures and
// audits the real, unmodified CSS (no decorative-rendering switch) at the width of the running
// project, from 320 to 3840 CSS pixels, in both themes:
//
// - no horizontal overflow of the page, of a region, or of a clipping ancestor, and no
//   ellipsis-truncated text,
// - no overlap between text blocks or controls,
// - at phone and tablet widths (below the 900 px header-navigation breakpoint), controls of at least
//   44 by 44 CSS pixels and content that can scroll clear of the bottom navigation,
// - at 1440 px and above, a readable measure: a capped main column, a top bar aligned with it,
//   and prose no wider than 1000 px,
// - at phone widths, the same page with text enlarged to 200 percent (reflow).
//
// States cover pending, failed, retrying, calculation_failed, refresh_failed, stale,
// missing_input, invalid_input, validation errors, empty lists, and full lists with long
// names, long Unicode names, long notes, and seven-digit rupee amounts. The scenarios live in
// helpers/clarityScenarios.ts so the accessibility specs audit the same screens.
//
// The `clarity-layout-*` projects in playwright.config.ts run this file at all ten widths
// against a dev server started with VITE_FINANCIAL_CLARITY_ENABLED=true. Keyboard, focus,
// contrast, status text, and reduced motion belong to task 17.4 (the `a11y-*` specs).
import { SPENDING_EXPENSES, SCENARIOS, MONTH, signIn } from './helpers/clarityScenarios';
import { auditLayout, contentHiddenByBottomNavigation, scaleText, settleAnimations } from './helpers/layout';
import { installSpendingBackend } from './helpers/spendingApi';
import { expect, test } from './fixtures/test';
import type { Page, TestInfo } from '@playwright/test';

// Layout checks need the screenshot of a failure, not a recording of every step.
test.use({ video: 'off', trace: 'off' });

/** The header navigation replaces the bottom navigation at this width (styles.css, "App shell and primary navigation"). */
const TOP_NAV_FROM = 900;
const ZOOM_UP_TO = 390;

// ---- Audit -------------------------------------------------------------------------------------------------

function widthOf(testInfo: TestInfo): number {
  const viewport = testInfo.project.use.viewport;
  if (!viewport) throw new Error('Every responsive project sets a viewport.');
  return viewport.width;
}

async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
}

/** Audits the open page in both themes and, on phone widths, with text enlarged to 200 percent. */
async function auditPage(page: Page, width: number): Promise<Record<string, string[]>> {
  const narrow = width < TOP_NAV_FROM;
  const report: Record<string, string[]> = {};
  await settleAnimations(page);
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    const issues = await auditLayout(page, { touchTargets: narrow, measure: width >= 1440 });
    if (narrow) issues.push(...(await contentHiddenByBottomNavigation(page)).map((item) => `covered by bottom navigation: ${item}`));
    if (issues.length > 0) report[theme] = issues;
  }
  if (width <= ZOOM_UP_TO) {
    await setTheme(page, 'light');
    await scaleText(page, 200);
    await settleAnimations(page);
    const issues = await auditLayout(page);
    issues.push(...(await contentHiddenByBottomNavigation(page)).map((item) => `covered by bottom navigation: ${item}`));
    if (issues.length > 0) report['text 200%'] = issues;
  }
  return report;
}

for (const scenario of SCENARIOS) {
  test(scenario.name, async ({ page, api }, testInfo) => {
    const width = widthOf(testInfo);
    await scenario.open(page, api);
    // The audit measures geometry, not timing, so it needs a committed layout (two frames, then
    // finite animations finished in auditPage), not a steady frame rate. A frame-rate wait fails
    // for the wrong reason at 3840: the full-viewport backdrop blur of an open dialog takes about
    // 67 ms a frame in headless software rendering (17-33 ms without it), which a GPU does not.
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    expect(await auditPage(page, width)).toEqual({});
  });
}

test('the layout holds on both sides of every breakpoint edge', async ({ page, api }, testInfo) => {
  test.skip(testInfo.project.name !== 'clarity-layout-768', 'Edge widths are resized inside one project.');
  installSpendingBackend(api, MONTH, { expenses: SPENDING_EXPENSES });
  await signIn(page, '/spending');
  await expect(page.locator('#expense-1')).toBeVisible();
  for (const width of [319, 320, 419, 420, 520, 521, 559, 560, 639, 640, 767, 768, 819, 820, 899, 900, 901, 999, 1000, 1099, 1100, 1231, 1232]) {
    await page.setViewportSize({ width, height: 900 });
    await settleAnimations(page);
    const issues = await auditLayout(page, { touchTargets: width < TOP_NAV_FROM });
    if (width < TOP_NAV_FROM) issues.push(...(await contentHiddenByBottomNavigation(page)).map((item) => `covered by bottom navigation: ${item}`));
    expect(issues, `layout at ${width}`).toEqual([]);
    const navigation = await page.evaluate(() => ({
      top: getComputedStyle(document.querySelector('header.topbar nav.primary-nav') as Element).display !== 'none',
      bottom: getComputedStyle(document.querySelector('nav.bottom-tabs') as Element).display !== 'none',
    }));
    expect(navigation, `navigation at ${width}`).toEqual({ top: width >= TOP_NAV_FROM, bottom: width < TOP_NAV_FROM });
  }
});

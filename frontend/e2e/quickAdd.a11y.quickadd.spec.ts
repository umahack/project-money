// Real-browser accessibility, contrast, reduced motion, and layout of Quick Add and the Home headline
// (task 16.2, Requirements 1.2, 1.3, 1.14, 11.5, 12.1 to 12.15).
//
// jsdom cannot compute colour or layout (quickAddAccessibility.test.tsx and the component tests cover structure, names, focus,
// and the stylesheet text). This spec runs the real, unmodified CSS in Chromium against the closed Quick Add world
// (helpers/quickAddWorld.ts) at the width of the running project: 320, 390, 768, 1024, 1440, and 3840 CSS pixels.
//
// 1. Every scenario below puts Quick Add and the headline on screen in one state (every surface at once, long values, over
//    today's allowance, an old server, the dialog, and the memory panel). In both themes: axe-core with colour-contrast
//    on and zero violations, the own contrast measurement of text, glyphs, and field edges, and the layout audit (no
//    horizontal scrolling, clipping, ellipsis, or overlap; 44 by 44 targets below 900 px; the readable measure from 1440 px).
//    At 320 and 390 px the same page is audited again with text at 200 percent.
// 2. Keyboard: Tab and Shift+Tab sweeps (indicator, reading order, no trap), the dialog containing focus and closing on
//    Escape with focus restored, and focus that stays on the active control while the page changes under it.
// 3. The floating action sits clear of the tab bar and the safe area at every phone width and is absent from 900 px.
// 4. Reduced motion: nothing slides or scales, the Undo window is static text, and a control run proves the sampler sees
//    the movement when motion is allowed.
//
// The Quick Add flag is fixed when a Vite server starts, so this file runs only under playwright.quickadd.config.ts, against a
// loopback server started with VITE_QUICK_ADD_ENABLED=true. The fixed servers of playwright.config.ts never run it.
import { THEMES, auditVerticalClipping, collectFocusStops, expectContrast, expectFocusKept, focusIndicatorProblems, readingOrderProblems, resetFocusToTop, runAxe, setTheme } from './helpers/a11y';
import { auditLayout, contentHiddenByBottomNavigation, scaleText, settleAnimations } from './helpers/layout';
import {
  LONG_NOTE, composeEverything, holdUndoWindow, installQuickAddWorld, openDialog, openPage, quickAddInput, shortcutKey, submitLine,
  type QuickAddWorld,
} from './helpers/quickAddWorld';
import { expect, test, type DeterministicApiFixtures } from './fixtures/test';
import type { Locator, Page, TestInfo } from '@playwright/test';

// Contrast and layout need the screenshot of a failure, not a recording of every step.
test.use({ video: 'off', trace: 'off' });

/** The header navigation replaces the bottom navigation at this width. */
const TOP_NAV_FROM = 900;
const ZOOM_UP_TO = 390;
const SWEEP_LIMIT = 80;

function widthOf(testInfo: TestInfo): number {
  const viewport = testInfo.project.use.viewport;
  if (!viewport) throw new Error('Every Quick Add project sets a viewport.');
  return viewport.width;
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await settleAnimations(page);
}

/** axe, contrast, and layout in both themes, then the same layout at 200 percent text on the narrow widths. */
async function auditPage(page: Page, width: number, label: string): Promise<void> {
  const narrow = width < TOP_NAV_FROM;
  await settle(page);
  for (const theme of THEMES) {
    await setTheme(page, theme);
    // The theme switch has its own short transitions; measure the settled colours.
    await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 350)));
    await settleAnimations(page);
    const axe = await runAxe(page);
    expect.soft(axe.violations, `${label}: axe violations (${theme})`).toEqual([]);
    await expectContrast(page, `${label} (${theme})`);
    const issues = await auditLayout(page, { touchTargets: narrow, measure: width >= 1440 });
    issues.push(...(await auditVerticalClipping(page)));
    if (narrow) issues.push(...(await contentHiddenByBottomNavigation(page)).map((item) => `covered by bottom navigation: ${item}`));
    expect.soft(issues, `${label}: layout (${theme})`).toEqual([]);
  }
  if (width <= ZOOM_UP_TO) {
    await setTheme(page, 'light');
    await scaleText(page, 200);
    await settle(page);
    const issues = await auditLayout(page);
    issues.push(...(await auditVerticalClipping(page)));
    issues.push(...(await contentHiddenByBottomNavigation(page)).map((item) => `covered by bottom navigation: ${item}`));
    expect.soft(issues, `${label}: layout with text at 200 percent`).toEqual([]);
  }
}

interface Scenario {
  name: string;
  open(page: Page, api: DeterministicApiFixtures, width: number): Promise<QuickAddWorld>;
}

const headline = (page: Page) => page.getByTestId('today-headline');

const SCENARIOS: Scenario[] = [
  {
    name: 'Home: headline, input, preview with a warning, a failed row, a saved row with Undo, and the answer',
    async open(page, api) {
      const world = installQuickAddWorld(api);
      await openPage(page, '/');
      await expect(headline(page).getByText(/You can spend/)).toBeVisible();
      await composeEverything(page, world);
      await holdUndoWindow(page);
      return world;
    },
  },
  {
    name: 'Home: seven-digit amount and a long unbreakable note in the preview, a saved row, and the answer',
    async open(page, api) {
      const world = installQuickAddWorld(api);
      await openPage(page, '/');
      await expect(headline(page).getByText(/You can spend/)).toBeVisible();
      await submitLine(page, `99,999.50 ${LONG_NOTE}`);
      await expect(page.locator('li.qa-entry[data-phase="saved"]')).toBeVisible();
      await expect(page.locator('.qa-answer')).toBeVisible();
      await quickAddInput(page).fill(`9,99,999 ${LONG_NOTE}`);
      await expect(page.getByRole('button', { name: "Save, but don't count against today" })).toBeVisible();
      await holdUndoWindow(page);
      return world;
    },
  },
  {
    name: 'Home: over today\'s allowance, in the headline and the answer, with a preview below',
    async open(page, api) {
      const world = installQuickAddWorld(api);
      await openPage(page, '/');
      await expect(headline(page).getByText(/You can spend/)).toBeVisible();
      await submitLine(page, '4000 flight');
      await expect(page.locator('li.qa-entry[data-phase="saved"]')).toBeVisible();
      await expect(headline(page).getByText(/over/i).first()).toBeVisible();
      await quickAddInput(page).fill('120 coffee');
      await holdUndoWindow(page);
      return world;
    },
  },
  {
    name: 'Home: a server without the Today fields shows the unavailable headline, and Quick Add still saves',
    async open(page, api) {
      const world = installQuickAddWorld(api, { withoutToday: true });
      await openPage(page, '/');
      await expect(headline(page).getByText('Temporarily unavailable.')).toBeVisible();
      await submitLine(page, '120 coffee');
      await expect(page.locator('li.qa-entry[data-phase="saved"]')).toBeVisible();
      await quickAddInput(page).fill('120 coffee 31/02');
      await holdUndoWindow(page);
      return world;
    },
  },
  {
    name: 'Dialog: a failed row, a saved row, the warning, and the answer over another page',
    async open(page, api, width) {
      const world = installQuickAddWorld(api);
      await openPage(page, '/spending');
      await openDialog(page, width);
      await composeEverything(page, world);
      await holdUndoWindow(page);
      return world;
    },
  },
  {
    name: 'Settings: the category memory panel with long notes and a long category name',
    async open(page, api) {
      const world = installQuickAddWorld(api);
      world.backend.seedMemory('coffee', 'Transport');
      world.backend.seedMemory('Pneumonoultramicroscopicsilicovolcanoconiosis0123456789', 'Pets and the long name of a custom category');
      world.backend.seedMemory('सपनोंकाघरखरीदना東京への長い旅行プラン', 'Groceries');
      await openPage(page, '/settings');
      await expect(page.locator('.memory-panel h2')).toBeVisible();
      await expect(page.getByRole('button', { name: /^Forget the remembered choice for coffee/ })).toBeVisible();
      return world;
    },
  },
];

for (const scenario of SCENARIOS) {
  test(scenario.name, async ({ page, api }, testInfo) => {
    const width = widthOf(testInfo);
    await scenario.open(page, api, width);
    await auditPage(page, width, scenario.name);
  });
}

/* ------------------------------- keyboard and focus ------------------------------- */

/**
 * Presses Tab until the control has focus. The control is looked up again before each press, so a row that React renders
 * again does not leave this holding a node that is no longer on the page.
 */
async function tabTo(page: Page, target: Locator, limit = 60): Promise<void> {
  for (let presses = 0; presses <= limit; presses += 1) {
    if (await target.first().evaluate((element) => element === document.activeElement).catch(() => false)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`tabTo: ${String(target)} was not reached with ${limit} Tab presses`);
}

test('keyboard sweep on Home: every stop has a visible indicator, the order follows the page, and Tab never traps', async ({ page, api }) => {
  const world = installQuickAddWorld(api);
  await openPage(page, '/');
  await expect(headline(page).getByText(/You can spend/)).toBeVisible();
  await composeEverything(page, world);
  await holdUndoWindow(page);
  await settle(page);
  for (const theme of THEMES) {
    await setTheme(page, theme);
    await resetFocusToTop(page);
    const forward = await collectFocusStops(page, SWEEP_LIMIT, 'forward');
    expect(forward.length, `there must be focus stops (${theme})`).toBeGreaterThanOrEqual(8);
    expect(forward.length, `Tab never ends: a keyboard trap (${theme})`).toBeLessThan(SWEEP_LIMIT);
    expect.soft(focusIndicatorProblems(forward), `focus indicators (${theme})`).toEqual([]);
    expect.soft(readingOrderProblems(forward), `reading order (${theme})`).toEqual([]);
    const backward = await collectFocusStops(page, SWEEP_LIMIT, 'backward');
    expect(backward.length, `Shift+Tab never ends: a keyboard trap (${theme})`).toBeLessThan(SWEEP_LIMIT);
    expect.soft(focusIndicatorProblems(backward), `focus indicators going backward (${theme})`).toEqual([]);
  }
});

test('keyboard in the dialog: focus is contained, indicators show, Escape closes, and focus returns to the opener', async ({ page, api }, testInfo) => {
  const width = widthOf(testInfo);
  const world = installQuickAddWorld(api);
  await openPage(page, '/spending');
  const opener = width < TOP_NAV_FROM ? page.getByRole('button', { name: 'Quick add expense' }) : page.locator('main h1').first();
  if (width >= TOP_NAV_FROM) await page.evaluate(() => {
    // The shortcut needs a focused element to return to; the page heading is made focusable for the check only.
    const heading = document.querySelector('main h1') as HTMLElement;
    heading.tabIndex = -1;
    heading.focus();
  });
  else await opener.focus();
  await openDialog(page, width);
  await composeEverything(page, world);
  await holdUndoWindow(page);
  await settle(page);
  const dialog = page.getByRole('dialog', { name: 'Quick Add' });
  for (const theme of THEMES) {
    await setTheme(page, theme);
    const stops = await collectFocusStops(page, SWEEP_LIMIT, 'forward');
    expect(stops.length, `there must be focus stops (${theme})`).toBeGreaterThanOrEqual(8);
    expect.soft(focusIndicatorProblems(stops), `focus indicators in the dialog (${theme})`).toEqual([]);
  }
  // Containment: more presses than the dialog has stops, in both directions, never leave it.
  await quickAddInput(page).focus();
  for (let press = 0; press < 30; press += 1) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((box) => box.contains(document.activeElement)), `Tab ${press + 1} stays in the dialog`).toBe(true);
  }
  for (let press = 0; press < 30; press += 1) {
    await page.keyboard.press('Shift+Tab');
    expect(await dialog.evaluate((box) => box.contains(document.activeElement)), `Shift+Tab ${press + 1} stays in the dialog`).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expectFocusKept(page, 'main, nav, header, .qa-fab');
  if (width < TOP_NAV_FROM) await expect(opener).toBeFocused();
  else await expect(page.locator('main h1').first()).toBeFocused();
});

test('keyboard only: type, choose a category, save, retry, edit, discard, Undo, and close, with focus never lost', async ({ page, api }, testInfo) => {
  const width = widthOf(testInfo);
  const world = installQuickAddWorld(api);
  await openPage(page, '/spending');
  await openDialog(page, width);
  // The Spending page behind the dialog lists the saved expenses with their own Edit buttons, so every control is looked up in the dialog.
  const box = page.getByRole('dialog', { name: 'Quick Add' });
  const input = quickAddInput(page);
  await input.pressSequentially('120 coffee');
  // The category control is a native select, so typing the start of a name picks it, with no pointer and no custom keys.
  const category = box.getByLabel('Category', { exact: true });
  await tabTo(page, category);
  await page.keyboard.type('Tr');
  await expect(category).toHaveValue('Transport');
  for (let presses = 0; presses < 12 && !(await input.evaluate((element) => element === document.activeElement)); presses += 1) {
    await page.keyboard.press('Shift+Tab');
  }
  await expect(input).toBeFocused();
  world.backend.failWith('POST', '/finance/expenses', { status: 500, code: 'INTERNAL_ERROR', message: 'The server had a problem.' });
  await page.keyboard.press('Enter');
  const failed = page.locator('li.qa-entry[data-phase="failed"]');
  await expect(failed).toBeVisible();
  await expectFocusKept(page, '[role="dialog"]');

  await tabTo(page, box.getByRole('button', { name: /^Retry saving/ }));
  await page.keyboard.press('Enter');
  await expect(page.locator('li.qa-entry[data-phase="saved"]')).toBeVisible();
  expect(world.backend.expenses).toHaveLength(1);
  await expectFocusKept(page, '[role="dialog"]');

  world.backend.failWith('POST', '/finance/expenses', { status: 500, code: 'INTERNAL_ERROR', message: 'The server had a problem.' });
  await submitLine(page, '50 tea');
  await expect(failed).toBeVisible();
  await tabTo(page, box.getByRole('button', { name: /^Edit/ }));
  await page.keyboard.press('Enter');
  await expect(input).toBeFocused();
  await expect(input).toHaveValue(/tea/);
  await page.keyboard.press('Enter');
  await expect(page.locator('li.qa-entry[data-phase="saved"]')).toHaveCount(2);

  world.backend.failWith('POST', '/finance/expenses', { status: 500, code: 'INTERNAL_ERROR', message: 'The server had a problem.' });
  await submitLine(page, '70 snack');
  await expect(failed).toBeVisible();
  await tabTo(page, box.getByRole('button', { name: /^Discard/ }));
  await page.keyboard.press('Enter');
  await expect(failed).toHaveCount(0);
  await expectFocusKept(page, '[role="dialog"]');

  await tabTo(page, box.getByRole('button', { name: /^Undo/ }).first());
  await page.keyboard.press('Enter');
  await expect(page.locator('li.qa-entry[data-phase="undone"]')).toBeVisible();
  expect(world.backend.expenses).toHaveLength(1);

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Quick Add' })).toBeHidden();
});

test('focus stays on the active control while an earlier entry confirms and the headline and answer change', async ({ page, api }) => {
  const world = installQuickAddWorld(api);
  await openPage(page, '/');
  await expect(headline(page).getByText(/You can spend/)).toBeVisible();
  const gate = world.hold('POST', '/api/finance/expenses');
  await submitLine(page, '100 coffee');
  await expect(page.locator('li.qa-entry[data-phase="pending"]')).toBeVisible();
  await quickAddInput(page).fill('200 lunch');
  const category = page.getByLabel('Category', { exact: true });
  await tabTo(page, category);
  const before = await headline(page).innerText();
  const handle = await category.elementHandle();
  gate.release();
  await expect(page.locator('li.qa-entry[data-phase="saved"]')).toBeVisible();
  await expect(page.locator('.qa-answer')).toBeVisible();
  await expect.poll(async () => headline(page).innerText()).not.toBe(before);
  expect(await handle!.evaluate((element) => element === document.activeElement), 'focus stays on the category control').toBe(true);
  await expect(quickAddInput(page)).toHaveValue('200 lunch');
});

/* --------------------------- the floating action's geometry --------------------------- */

test('the floating action is at least 48 by 48, clear of the tab bar, the safe area, and the page edge, and absent from 900 px', async ({ page, api }, testInfo) => {
  const width = widthOf(testInfo);
  installQuickAddWorld(api);
  await openPage(page, '/spending');
  const fab = page.getByRole('button', { name: 'Quick add expense' });
  if (width >= TOP_NAV_FROM) {
    await expect(fab).toHaveCount(0);
    return;
  }
  await expect(fab).toBeVisible();
  const geometry = await page.evaluate(() => {
    const action = document.querySelector('.qa-fab') as HTMLElement;
    const bar = document.querySelector('nav.bottom-tabs') as HTMLElement | null;
    const a = action.getBoundingClientRect();
    const b = bar?.getBoundingClientRect() ?? null;
    return {
      width: a.width, height: a.height, right: a.right, bottom: a.bottom, left: a.left,
      viewportWidth: document.documentElement.clientWidth,
      barTop: b?.top ?? null,
      overlapsBar: b ? !(a.bottom <= b.top || a.top >= b.bottom || a.right <= b.left || a.left >= b.right) : false,
      keyshortcuts: action.getAttribute('aria-keyshortcuts'),
    };
  });
  expect(geometry.width).toBeGreaterThanOrEqual(48);
  expect(geometry.height).toBeGreaterThanOrEqual(48);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth);
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.overlapsBar, 'the floating action overlaps the bottom tab bar').toBe(false);
  if (geometry.barTop !== null) expect(geometry.bottom).toBeLessThanOrEqual(geometry.barTop);
  expect(geometry.keyshortcuts).toBe(await shortcutKey(page));
  // It does not cover the toast area: the Undo toast stack sits above it.
  await submitLineThroughDialog(page, width);
  const toastClear = await page.evaluate(() => {
    const action = document.querySelector('.qa-fab')?.getBoundingClientRect();
    const toasts = document.querySelector('.qa-undo-toasts')?.getBoundingClientRect();
    if (!action || !toasts || toasts.height === 0) return true;
    return toasts.bottom <= action.top + 1 || toasts.top >= action.bottom - 1 || toasts.right <= action.left || toasts.left >= action.right;
  });
  expect(toastClear, 'the Undo toast overlaps the floating action').toBe(true);
});

async function submitLineThroughDialog(page: Page, width: number): Promise<void> {
  await openDialog(page, width);
  await submitLine(page, '120 coffee');
  await expect(page.locator('li.qa-entry[data-phase="saved"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Quick Add' })).toBeHidden();
}

/* ---------------------------------- reduced motion ---------------------------------- */

interface MotionSample { transforms: string[]; running: string[] }

/** Samples every frame for `ms`: the dialog's computed transform, and any running animation that moves something. */
async function sampleMotion(page: Page, ms: number): Promise<MotionSample> {
  return page.evaluate((duration) => new Promise<MotionSample>((resolve) => {
    const transforms = new Set<string>();
    const running = new Set<string>();
    const start = performance.now();
    // `offset`, `easing`, and `composite` of a keyframe are its timing, not a property it animates.
    const MOVING = /^(transform|translate|scale|rotate|top|left|right|bottom|width|height|margin|inset)/;
    const frame = () => {
      const box = document.querySelector('[role="dialog"]');
      if (box) transforms.add(getComputedStyle(box).transform);
      for (const animation of document.getAnimations()) {
        const timing = animation.effect?.getComputedTiming();
        if (!timing || animation.playState !== 'running') continue;
        const keyframes = (animation.effect as KeyframeEffect).getKeyframes();
        // It moves something only when a moving property takes different values across its keyframes.
        const moves = Object.keys(keyframes[0] ?? {}).some((key) => MOVING.test(key)
          && new Set(keyframes.map((keyframe) => String((keyframe as Record<string, unknown>)[key]))).size > 1);
        const target = (animation.effect as KeyframeEffect).target as Element | null;
        if (moves && Number(timing.duration) > 17) running.add(`${target?.tagName.toLowerCase()}.${String(target?.className).split(/\s+/)[0]} ${Number(timing.duration)}ms`);
      }
      if (performance.now() - start < duration) requestAnimationFrame(frame);
      else resolve({ transforms: [...transforms], running: [...running] });
    };
    requestAnimationFrame(frame);
  }), ms);
}

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('the dialog only fades, the Undo window is static text, and no animation moves anything', async ({ page, api }, testInfo) => {
    const width = widthOf(testInfo);
    const world = installQuickAddWorld(api);
    await openPage(page, '/spending');
    const sampling = sampleMotion(page, 700);
    await openDialog(page, width);
    const sample = await sampling;
    expect(sample.transforms.filter((value) => value !== 'none' && !/^matrix\(1, 0, 0, 1, 0, 0\)$/.test(value)), 'the dialog slid or scaled').toEqual([]);
    expect(sample.running, 'an animation moved something').toEqual([]);
    await submitLine(page, '120 coffee');
    const row = page.locator('li.qa-entry[data-phase="saved"]');
    await expect(row).toBeVisible();
    await expect(row.getByText('Undo is available for 8 seconds.')).toBeVisible();
    const bar = await row.locator('.qa-undo-bar').evaluate((element) => getComputedStyle(element).display);
    expect(bar, 'the shrinking bar is hidden').toBe('none');
    expect(await row.locator('.qa-undo-left').evaluate((element) => getComputedStyle(element).display), 'the countdown is hidden').toBe('none');
    expect(world.backend.expenses).toHaveLength(1);
  });

  test('the headline bar changes at once', async ({ page, api }) => {
    installQuickAddWorld(api);
    await openPage(page, '/');
    await expect(headline(page).getByText(/You can spend/)).toBeVisible();
    const fill = headline(page).locator('.today-headline-fill');
    await expect(fill).toBeAttached();
    const duration = await fill.evaluate((element) => getComputedStyle(element).transitionDuration);
    for (const part of duration.split(',')) expect(parseFloat(part) * (part.trim().endsWith('ms') ? 1 : 1000), `transition ${duration}`).toBeLessThanOrEqual(1);
  });
});

test.describe('motion allowed (the control run)', () => {
  test.use({ reducedMotion: 'no-preference' });

  test('the sampler sees the dialog scale and slide, and the Undo bar and countdown, so the reduced-motion checks are not empty', async ({ page, api }, testInfo) => {
    const width = widthOf(testInfo);
    installQuickAddWorld(api);
    await openPage(page, '/spending');
    const sampling = sampleMotion(page, 700);
    await openDialog(page, width);
    const sample = await sampling;
    expect(sample.transforms.some((value) => value !== 'none' && !/^matrix\(1, 0, 0, 1, 0, 0\)$/.test(value)), 'the dialog never moved').toBe(true);
    await submitLine(page, '120 coffee');
    const row = page.locator('li.qa-entry[data-phase="saved"]');
    await expect(row).toBeVisible();
    expect(await row.locator('.qa-undo-bar').evaluate((element) => getComputedStyle(element).display)).not.toBe('none');
    await expect(row.locator('.qa-undo-left')).toBeVisible();
    await expect(row.getByText('Undo is available for 8 seconds.')).toBeVisible();
  });
});

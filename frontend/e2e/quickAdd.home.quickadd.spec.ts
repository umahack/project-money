// Browser acceptance of Home, the floating action, and the views that follow a save (task 18.1, Requirements 1.1 to 1.5,
// 7.5, 7.17, 7.21, 9.19, 11.1, 11.20, 13.4, 18.23).
//
// 1. The Home order (headline, then the input, then the four quick actions, then the summary, then the journey and the
//    streak) and the floating action geometry at the width of the running project: at least 48 by 48 CSS pixels, clear of the
//    bottom tab bar, the safe area, and the toast area below 900 px, and absent from 900 px, where the shortcut is shown as
//    text. These tests run against the real, unmodified CSS.
// 2. A recurring expense dated Today that carries the Allowance_Exclusion: it is outside the headline's spent amount, named
//    in text as "not counted today", marked on the Spending page, and still part of the month's total.
// 3. The logging streak card and the Spending page follow a confirmed save and a confirmed Undo with no reload.
//
// The Quick Add flag is fixed when a Vite server starts, so this file runs only under playwright.quickadd.config.ts. Every
// response comes from the in-memory fake on loopback; no production credential or host is used.
import { settleAnimations } from './helpers/layout';
import {
  EXPENSES_API, answerOf, guardDocument, headline, isPath, leftToday, rowFor, spentToday, streakCard, typeLine, writes,
} from './helpers/quickAddFlows';
import {
  OTHER_DAY, installQuickAddWorld, openDialog, openPage, quickAddInput, shortcutKey, submitLine,
} from './helpers/quickAddWorld';
import { expect, test } from './fixtures/test';
import type { Page, TestInfo } from '@playwright/test';

test.use({ video: 'off', trace: 'off' });

/** The header navigation replaces the bottom tab bar at this width (Requirement 1.2). */
const TAB_BAR_BELOW = 900;
const FAB_MIN_PX = 48;
/** Rounding slack for sub-pixel layout. */
const EPSILON = 0.75;

function widthOf(testInfo: TestInfo): number {
  const viewport = testInfo.project.use.viewport;
  if (!viewport) throw new Error('Every Quick Add project sets a viewport.');
  return viewport.width;
}

interface Box { top: number; bottom: number; left: number; right: number }

/** The box of the first match, in document coordinates, so it does not depend on the scroll position. */
async function boxOf(page: Page, selector: string): Promise<Box> {
  const found = await page.locator(selector).first().evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { top: rect.top + window.scrollY, bottom: rect.bottom + window.scrollY, left: rect.left + window.scrollX, right: rect.right + window.scrollX };
  });
  return found;
}

/**
 * Two animation frames, then the end of every finite entrance animation, so a measurement sees the settled layout. It does not
 * wait for a steady frame cadence: these specs measure geometry and content, not paint time, and they run against the
 * real stylesheet, whose blur is slow to rasterize on a 3840 pixel software surface.
 */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await settleAnimations(page);
}
async function settledHome(page: Page): Promise<void> {
  await openPage(page, '/');
  await expect(headline(page).getByText(/You can spend/)).toBeVisible();
  await expect(page.locator('[data-region="summary"]')).toBeVisible();
  await expect(streakCard(page)).toBeVisible();
  await settle(page);
}

test('Home order: header, headline, Quick Add input, quick actions, summary, then the journey and the streak', async ({ page, api }) => {
  installQuickAddWorld(api);
  await settledHome(page);
  const header = await boxOf(page, 'main h1');
  const today = await boxOf(page, '[data-testid="today-headline"]');
  const quickAdd = await boxOf(page, 'section[aria-label="Quick add"]');
  const input = await boxOf(page, 'section[aria-label="Quick add"] input');
  const tiles = await boxOf(page, 'nav[aria-label="Quick actions"]');
  const summary = await boxOf(page, '[data-region="summary"]');
  const journey = await boxOf(page, '#home-guided-journey');

  // On the screen, each part starts at or below the end of the one before it.
  expect(today.top, 'the headline is after the page header').toBeGreaterThanOrEqual(header.bottom - EPSILON);
  expect(quickAdd.top, 'Quick Add is below the headline').toBeGreaterThanOrEqual(today.bottom - EPSILON);
  expect(input.top, 'the input is inside the Quick Add section').toBeGreaterThanOrEqual(quickAdd.top - EPSILON);
  expect(input.bottom).toBeLessThanOrEqual(quickAdd.bottom + EPSILON);
  expect(tiles.top, 'the quick actions are below the input').toBeGreaterThanOrEqual(quickAdd.bottom - EPSILON);
  expect(summary.top, 'the summary is below the quick actions').toBeGreaterThanOrEqual(tiles.bottom - EPSILON);
  expect(journey.top, 'the journey is below the summary').toBeGreaterThanOrEqual(summary.bottom - EPSILON);
  // Directly below: nothing sits between the headline and the input but spacing.
  expect(quickAdd.top - today.bottom, 'the input follows the headline directly').toBeLessThanOrEqual(80);

  // In the reading order of the document, the same sequence.
  const order = await page.evaluate(() => {
    const pick = (selector: string) => document.querySelector(selector);
    const nodes = [
      pick('main h1'),
      pick('[data-testid="today-headline"]'),
      pick('section[aria-label="Quick add"] input'),
      pick('nav[aria-label="Quick actions"]'),
      pick('[data-region="summary"]'),
      pick('#home-guided-journey'),
    ];
    if (nodes.some((node) => node === null)) return ['missing'];
    const problems: string[] = [];
    for (let index = 1; index < nodes.length; index += 1) {
      const previous = nodes[index - 1] as Element;
      const current = nodes[index] as Element;
      if (!(previous.compareDocumentPosition(current) & Node.DOCUMENT_POSITION_FOLLOWING)) problems.push(`part ${index} does not follow part ${index - 1}`);
    }
    return problems;
  });
  expect(order).toEqual([]);
  // The headline is the first outcome: no other outcome card sits between the header and it.
  const outcomesBefore = await page.evaluate(() => {
    const target = document.querySelector('[data-testid="today-headline"]');
    return Array.from(document.querySelectorAll('main .clarity-outcome'))
      .filter((card) => target !== null && !target.contains(card) && (card.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0)
      .length;
  });
  expect(outcomesBefore, 'no outcome card comes before the headline').toBe(0);
  // Nothing scrolls sideways.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('Floating action: 48 by 48 or larger and clear of the tab bar, the safe area, and the toast area below 900 px; absent from 900 px', async ({ page, api }, testInfo) => {
  installQuickAddWorld(api);
  const width = widthOf(testInfo);
  await settledHome(page);
  const fab = page.getByRole('button', { name: 'Quick add expense' });
  // Every signed-in page of the user view that the closed world serves.
  for (const path of ['/', '/spending', '/settings']) {
    if (path !== '/') {
      await page.goto(path);
      await expect(page.locator('main h1').first()).toBeVisible();
      await settle(page);
    }
    if (width >= TAB_BAR_BELOW) {
      await expect(fab, `no floating action on ${path} from ${TAB_BAR_BELOW} px`).toHaveCount(0);
      continue;
    }
    await expect(fab, `floating action on ${path}`).toBeVisible();
    const box = await fab.boundingBox();
    const tabBar = await page.locator('nav.bottom-tabs').boundingBox();
    if (!box || !tabBar) throw new Error(`The floating action or the tab bar has no box on ${path}.`);
    const viewport = page.viewportSize();
    if (!viewport) throw new Error('Every Quick Add project sets a viewport.');
    expect(box.width, `width on ${path}`).toBeGreaterThanOrEqual(FAB_MIN_PX - EPSILON);
    expect(box.height, `height on ${path}`).toBeGreaterThanOrEqual(FAB_MIN_PX - EPSILON);
    // Inside the viewport, with a margin from the right edge, and above the tab bar with a margin.
    expect(box.x, `left edge on ${path}`).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, `right edge on ${path}`).toBeLessThanOrEqual(viewport.width - 8);
    expect(box.y, `top edge on ${path}`).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height, `clear of the tab bar on ${path}`).toBeLessThanOrEqual(tabBar.y - 8 + EPSILON);
    // It publishes its height so the page padding and the toasts stay above it.
    const published = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--quick-add-fab-h')));
    expect(published, `published height on ${path}`).toBeGreaterThanOrEqual(FAB_MIN_PX);
    // The toast area sits above it: a probe toast with the page's own toast styles ends above the floating action.
    const toastBottom = await page.evaluate(() => {
      const stack = document.createElement('div');
      stack.className = 'toasts';
      const probe = document.createElement('div');
      probe.style.height = '20px';
      stack.append(probe);
      document.body.append(stack);
      const rect = probe.getBoundingClientRect();
      stack.remove();
      return rect.bottom;
    });
    expect(toastBottom, `toast area above the floating action on ${path}`).toBeLessThanOrEqual(box.y + EPSILON);
    // It names the shortcut for assistive technology.
    await expect(fab).toHaveAttribute('aria-keyshortcuts', /^(Control|Meta)\+K$/);
  }
});

test('Quick Add opens from the floating action or the shortcut: on Home it focuses the input, on another page it opens the dialog', async ({ page, api }, testInfo) => {
  installQuickAddWorld(api);
  const width = widthOf(testInfo);
  await settledHome(page);
  const guard = await guardDocument(page);
  const opener = async () => {
    if (width < TAB_BAR_BELOW) await page.getByRole('button', { name: 'Quick add expense' }).click();
    else await page.keyboard.press(await shortcutKey(page));
  };
  // Home: focus moves to the inline input and no dialog opens.
  await page.getByRole('navigation', { name: 'Quick actions' }).getByRole('link').first().focus();
  await opener();
  await expect(quickAddInput(page)).toBeFocused();
  await expect(page.getByRole('dialog', { name: 'Quick Add' })).toHaveCount(0);
  if (width >= TAB_BAR_BELOW) await expect(page.locator('.qa-shortcut-hint')).toContainText(/Ctrl K|⌘ K/);
  else await expect(page.locator('.qa-shortcut-hint')).toHaveCount(0);
  await guard.expectUnchanged();

  // Another page: the dialog opens over it and the address does not change.
  await page.goto('/spending');
  await expect(page.locator('main h1').first()).toBeVisible();
  await settle(page);
  await openDialog(page, width);
  expect(new URL(page.url()).pathname).toBe('/spending');
  await expect(quickAddInput(page)).toBeFocused();
});

test('A recurring expense dated Today is outside the headline\'s spent amount, named as not counted, and still in the month', async ({ page, api }) => {
  const world = installQuickAddWorld(api);
  // The auto-posted expense carries the mark in the same insert (Requirement 18.23).
  const recurringId = world.seed({ category: 'Bills', amountMinor: 64_900, note: 'Streaming plan (auto-posted)', excluded: true });
  world.seed({ category: 'Groceries', amountMinor: 20_000, note: 'Earlier groceries', spentOn: OTHER_DAY });
  await openPage(page, '/');
  await expect(headline(page).getByText(/You can spend/)).toBeVisible();
  const guard = await guardDocument(page);

  // The headline: nothing counted today, and the recurring expense named in text with its amount.
  await expect(spentToday(page)).toHaveText('₹0');
  await expect(headline(page)).toContainText('1 expense not counted today (₹649)');
  await expect(leftToday(page)).toHaveText('₹3,000');

  // A Quick Add entry counts, the recurring expense still does not, and it is still named.
  await submitLine(page, '120 coffee');
  await expect(rowFor(page, 'coffee')).toHaveAttribute('data-phase', 'saved');
  await expect(spentToday(page)).toHaveText('₹120');
  await expect(leftToday(page)).toHaveText('₹2,880');
  await expect(headline(page)).toContainText('1 expense not counted today (₹649)');
  await expect(answerOf(page)).toContainText("Spent today: ₹120 of today's allowance of ₹3,000.");
  await guard.expectUnchanged();

  // The Spending page marks it in text, leaves the new entry unmarked, and the month's total includes all three.
  await page.goto('/spending');
  await expect(page.locator(`#expense-${recurringId}`)).toBeVisible();
  await expect(page.locator(`#expense-${recurringId}`)).toContainText('Not counted in daily allowance');
  await expect(page.locator('#expense-1')).toContainText('coffee');
  await expect(page.locator('#expense-1')).not.toContainText('Not counted in daily allowance');
  const spent = page.locator('.clarity-value').filter({ has: page.getByText('Spent so far', { exact: true }) }).locator('.clarity-value-amount');
  await expect(spent).toHaveText('₹969');
  expect(writes(api, 'POST')).toHaveLength(1);
});

test('The streak card and the Spending page follow a save and an Undo without a reload', async ({ page, api }, testInfo) => {
  const world = installQuickAddWorld(api, { dynamicStreak: true });
  const width = widthOf(testInfo);
  await openPage(page, '/');
  await expect(headline(page).getByText(/You can spend/)).toBeVisible();
  const card = streakCard(page);
  await expect(card).toBeVisible();
  await expect(card.locator('.mono').first()).toHaveText('12');
  await expect(card).toContainText('12-day streak');
  await settle(page);
  const guard = await guardDocument(page);

  // While the entry is pending the card keeps its last confirmed value, and it is not replaced by a loading state.
  const gate = world.hold('POST', EXPENSES_API);
  await typeLine(page, '60 snack');
  await quickAddInput(page).press('Enter');
  await expect(rowFor(page, 'snack')).toHaveAttribute('data-phase', 'pending');
  await expect(card.locator('.mono').first()).toHaveText('12');
  const reads = api.count('GET', '/api/finance/streak');
  const response = page.waitForResponse(isPath('POST', EXPENSES_API));
  gate.release();
  await response;
  await expect(rowFor(page, 'snack')).toHaveAttribute('data-phase', 'saved');
  await expect(card.locator('.mono').first()).toHaveText('13');
  await expect(card).toContainText('13-day streak');
  expect(api.count('GET', '/api/finance/streak')).toBeGreaterThan(reads);

  // Undo takes the streak back to the confirmed server value.
  const readsAfterSave = api.count('GET', '/api/finance/streak');
  await page.getByRole('button', { name: /^Undo ₹60 snack/ }).click();
  await expect(rowFor(page, 'snack')).toHaveAttribute('data-phase', 'undone');
  await expect(card.locator('.mono').first()).toHaveText('12');
  expect(api.count('GET', '/api/finance/streak')).toBeGreaterThan(readsAfterSave);
  expect(world.backend.streak.current).toBe(12);
  await guard.expectUnchanged();

  // The Spending page, with the dialog opened over it, shows the same save and removal in place.
  await page.goto('/spending');
  await expect(page.locator('main h1').first()).toBeVisible();
  await settle(page);
  const spent = page.locator('.clarity-value').filter({ has: page.getByText('Spent so far', { exact: true }) }).locator('.clarity-value-amount');
  await expect(spent).toHaveText('₹0');
  await openDialog(page, width);
  const spendingGuard = await guardDocument(page);
  await submitLine(page, '45 vada');
  await expect(rowFor(page, 'vada')).toHaveAttribute('data-phase', 'saved');
  await expect(page.locator('#expense-2')).toContainText('vada');
  await expect(spent).toHaveText('₹45');
  await page.getByRole('button', { name: /^Undo ₹45 vada/ }).click();
  await expect(rowFor(page, 'vada')).toHaveAttribute('data-phase', 'undone');
  await expect(page.locator('#expense-2')).toHaveCount(0);
  await expect(spent).toHaveText('₹0');
  await spendingGuard.expectUnchanged();
});

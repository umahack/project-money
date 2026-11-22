// Layout acceptance for the header navigation, the full-width content, and the Home key-number row
// (approved UI layout redesign). Runs on the flag-on server at 1440 and 390 px. Widths are
// changed inside a test where the behaviour at a width is the point, so one project covers them.
//
// - From 900 px the primary navigation is in the sticky header with a clear active state and visible
//   keyboard focus; below 900 px the bottom bar is the only navigation.
// - From 1320 px the brand, links and actions share one row (with a one-digit hour in the header clock; a
//   two-digit hour is 8 px wider and needs about 1340 px). Below that the header wraps (the actions
//   drop to a second row) and nothing clips. The clock is frozen, so these tests do not depend on the time of day. At every width the header reads, and Tab moves, in the order
//   brand, links, actions: what is shown first is focused first (WCAG 1.3.2 and 2.4.3).
// - The content uses the page width (no sidebar column) up to a cap, centred.
// - Home's four key-number cards fill their row at 1024, 1440 and 3840 px, with no gap beside a card.
// - The promise is one line, and after the notice is acknowledged the data-use card is a small control.
import { installClarityBackend } from './helpers/clarityApi';
import { resetFocusToTop } from './helpers/a11y';
import { BILLS, MONTH, signIn } from './helpers/clarityScenarios';
import { auditLayout, settleAnimations } from './helpers/layout';
import { expect, test } from './fixtures/test';
import { buildSettings } from '../src/test/claritySettingsBuilder';
import type { Page, TestInfo } from '@playwright/test';

test.use({ video: 'off', trace: 'off' });

const TOP_NAV_FROM = 900;
const LABELS = ['Home', 'Spending', 'Plan', 'Goals', 'Trips', 'Settings'];

function stubHome(api: Parameters<typeof installClarityBackend>[0], month: string = MONTH): void {
  api.stub('GET', '/api/finance/streak', { json: { current: 12, longest: 31, days_logged: 120 } });
  installClarityBackend(api, month, { salaryMinor: 8_000_000 });
}

// The header clock is part of the header's width: "Sun · 22 Nov · 2:05 pm" is 8 px narrower than
// "Sun · 22 Nov · 11:48 am" (one digit fewer), and that is the margin by which the header fits one row at exactly
// 1320 px. So the width tests freeze the browser clock (Playwright `page.clock`, installed before the page loads)
// instead of reading the wall clock, and run once for each width of the time. The app reads the clock for the
// header and for the current month, so the month the API fixtures answer for is the frozen one (FROZEN_MONTH),
// not the month the test machine happens to be in. Both times are in Asia/Kolkata, the project's time zone.
const FROZEN_MONTH = '2026-11';
const HEADER_WIDTHS = [900, 960, 1024, 1100, 1200, 1319, 1320, 1366, 1440];
const CLOCKS = [
  // Measured: brand, links and actions share one row from 1320 px (the design width) ...
  { label: 'one-digit hour', time: '2026-11-22T14:05:00+05:30', shown: '2:05 pm', oneRow: [1320, 1366, 1440], twoRows: [900, 960, 1024, 1100, 1200] },
  // ... but with "11:48 am" the three parts need about 1340 px, so at 1319 and 1320 the actions drop to a second row.
  // 1319 is not asserted for the one-digit hour: it sits on the fit boundary and the design does not promise a row count there.
  { label: 'two-digit hour', time: '2026-11-22T11:48:00+05:30', shown: '11:48 am', oneRow: [1366, 1440], twoRows: [900, 960, 1024, 1100, 1200, 1319, 1320] },
] as const;

/** Freeze the browser clock at `time` before the app loads. Time still moves on from there, which is harmless here. */
async function freezeClock(page: Page, time: string): Promise<void> {
  await page.clock.install({ time: new Date(time) });
}

async function resize(page: Page, width: number, height = 900): Promise<void> {
  await page.setViewportSize({ width, height });
  await settleAnimations(page);
}

const topNav = (page: Page) => page.locator('header.topbar nav.primary-nav');
interface Box { left: number; right: number; top: number; bottom: number; height: number }
/** `later` is shown after `earlier`: on the same row and to its right, or on a lower row. */
function follows(earlier: Box, later: Box): boolean {
  const sharedHeight = Math.min(earlier.bottom, later.bottom) - Math.max(earlier.top, later.top);
  const sameRow = sharedHeight > Math.min(earlier.height, later.height) / 2;
  return sameRow ? later.left >= earlier.right - 1 : later.top + later.height / 2 > earlier.top + earlier.height / 2;
}

/** The geometry of the header and its parts, in page coordinates. */
async function headerGeometry(page: Page) {
  return page.evaluate(() => {
    const box = (element: Element | null) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
    };
    const bar = document.querySelector('header.topbar') as HTMLElement;
    return {
      viewport: document.documentElement.clientWidth,
      bar: box(bar),
      barScrollWidth: bar.scrollWidth,
      barClientWidth: bar.clientWidth,
      brand: box(bar.querySelector('.brand')),
      actions: box(bar.querySelector('.top-actions')),
      nav: box(bar.querySelector('nav.primary-nav')),
      links: Array.from(bar.querySelectorAll('nav.primary-nav a')).map((link) => ({ text: (link.textContent ?? '').trim(), ...box(link)! })),
    };
  });
}

test.describe('header navigation', () => {
  test('is shown from 900 px and replaced by the bottom bar below it', async ({ page, api }) => {
    stubHome(api);
    await signIn(page, '/');
    for (const width of [320, 390, 768, 899, 900, 901, 1024, 1319, 1320, 1440, 3840]) {
      await resize(page, width);
      const shown = await page.evaluate(() => ({
        top: getComputedStyle(document.querySelector('header.topbar nav.primary-nav') as Element).display !== 'none',
        bottom: getComputedStyle(document.querySelector('nav.bottom-tabs') as Element).display !== 'none',
      }));
      expect(shown, `navigation at ${width}`).toEqual({ top: width >= TOP_NAV_FROM, bottom: width < TOP_NAV_FROM });
    }
  });

  test('marks the current page with aria-current and an underline bar, not colour alone', async ({ page, api }) => {
    stubHome(api);
    await signIn(page, '/');
    await resize(page, 1440);

    const home = topNav(page).getByRole('link', { name: 'Home' });
    const plan = topNav(page).getByRole('link', { name: 'Plan' });
    await expect(home).toHaveAttribute('aria-current', 'page');
    await expect(plan).not.toHaveAttribute('aria-current', 'page');
    await expect(topNav(page).locator('a[aria-current="page"]')).toHaveCount(1);

    const cues = (link: typeof home) => link.evaluate((element) => {
      const style = getComputedStyle(element);
      return { barWidth: style.borderBottomWidth, barColor: style.borderBottomColor, fill: style.backgroundImage !== 'none' || style.backgroundColor !== 'rgba(0, 0, 0, 0)' };
    });
    const current = await cues(home);
    const other = await cues(plan);
    // The current link has a visible bar and a fill; the others have a transparent bar and no fill.
    expect(current.barWidth).toBe('3px');
    expect(current.barColor).not.toBe('rgba(0, 0, 0, 0)');
    expect(current.fill).toBe(true);
    expect(other.barColor).toBe('rgba(0, 0, 0, 0)');
    expect(other.fill).toBe(false);

    await plan.click();
    await expect(plan).toHaveAttribute('aria-current', 'page');
    await expect(home).not.toHaveAttribute('aria-current', 'page');
  });

  test('is operated by keyboard with a visible focus ring', async ({ page, api }) => {
    stubHome(api);
    await signIn(page, '/');
    await resize(page, 1440);

    const plan = topNav(page).getByRole('link', { name: 'Plan' });
    for (let stops = 0; stops < 12; stops += 1) {
      await page.keyboard.press('Tab');
      if (await plan.evaluate((element) => element === document.activeElement)) break;
    }
    await expect(plan).toBeFocused();
    const ring = await plan.evaluate((element) => {
      const style = getComputedStyle(element);
      return { style: style.outlineStyle, width: parseFloat(style.outlineWidth), matches: element.matches(':focus-visible') };
    });
    expect(ring).toEqual({ style: 'solid', width: 3, matches: true });

    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/plan$/);
    await expect(plan).toHaveAttribute('aria-current', 'page');
    await expect(plan).toBeFocused();
  });

  test('stays at the top of the window while the page scrolls', async ({ page, api }) => {
    stubHome(api);
    await signIn(page, '/');
    // A short window makes the page scroll even when it is not long.
    await resize(page, 1366, 420);
    const scrollable = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
    expect(scrollable, 'the page must be taller than the window for this check').toBeGreaterThan(200);

    for (const position of [150, scrollable]) {
      await page.evaluate((y) => window.scrollTo(0, y), position);
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const state = await page.evaluate(() => {
        const bar = document.querySelector('header.topbar') as HTMLElement;
        const link = bar.querySelector('nav.primary-nav a') as HTMLElement;
        const rect = link.getBoundingClientRect();
        const probe = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return { scrolled: window.scrollY, barTop: bar.getBoundingClientRect().top, linkVisible: rect.top >= 0 && rect.bottom <= window.innerHeight, linkOnTop: probe === link || link.contains(probe) };
      });
      expect(state.scrolled).toBeGreaterThan(100);
      expect(state, `header at scroll ${position}`).toMatchObject({ barTop: 0, linkVisible: true, linkOnTop: true });
    }
  });

  for (const clock of CLOCKS) {
  test(`holds every link between 900 and 1320 px without clipping, in one row from 1320 px, with a ${clock.label} (${clock.shown}) in the clock`, async ({ page, api }) => {
    await freezeClock(page, clock.time);
    stubHome(api, FROZEN_MONTH);
    await signIn(page, '/');
    await expect(page.locator('header.topbar .tc-time'), 'the frozen clock is shown').toHaveText(clock.shown);
    for (const width of HEADER_WIDTHS) {
      await resize(page, width);
      const geometry = await headerGeometry(page);
      expect(geometry.links.map((link) => link.text.replace(/^\P{L}+/u, '')), `links at ${width}`).toEqual(LABELS);
      expect(geometry.barScrollWidth, `header scrolls sideways at ${width}`).toBeLessThanOrEqual(geometry.barClientWidth + 1);
      for (const link of geometry.links) {
        expect(link.left, `${link.text} left at ${width}`).toBeGreaterThanOrEqual(0);
        expect(link.right, `${link.text} right at ${width}`).toBeLessThanOrEqual(geometry.viewport + 1);
      }
      // No link overlaps the brand, the actions, or another link.
      const parts = [geometry.brand!, geometry.actions!, ...geometry.links];
      for (let i = 0; i < parts.length; i += 1) {
        for (let j = i + 1; j < parts.length; j += 1) {
          const a = parts[i]!;
          const b = parts[j]!;
          const overlap = Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
          expect(overlap, `header parts ${i} and ${j} overlap at ${width}`).toBe(false);
        }
      }
      // Reading order: the brand, then each link, then the actions, each on a lower row or to the right of the one before.
      const inDocumentOrder = [{ text: 'brand', ...geometry.brand! }, ...geometry.links, { text: 'actions', ...geometry.actions! }];
      for (let i = 1; i < inDocumentOrder.length; i += 1) {
        expect(follows(inDocumentOrder[i - 1]!, inDocumentOrder[i]!), `"${inDocumentOrder[i]!.text}" is shown before "${inDocumentOrder[i - 1]!.text}" at ${width}`).toBe(true);
      }
      if ((clock.oneRow as readonly number[]).includes(width)) {
        // One row: the links sit between the brand and the actions, on the same line.
        expect(geometry.nav!.top, `links on the brand's row at ${width}`).toBeLessThan(geometry.brand!.bottom);
        expect(geometry.actions!.top, `actions on the brand's row at ${width}`).toBeLessThan(geometry.brand!.bottom);
        expect(geometry.nav!.left).toBeGreaterThanOrEqual(geometry.brand!.right - 1);
        expect(geometry.nav!.right).toBeLessThanOrEqual(geometry.actions!.left + 1);
      }
      if ((clock.twoRows as readonly number[]).includes(width)) {
        // Two rows: brand and links on the first, the actions alone on the second, still after the links, at the right edge.
        expect(geometry.nav!.top, `links on the brand's row at ${width}`).toBeLessThan(geometry.brand!.bottom);
        expect(geometry.actions!.top, `actions below the brand at ${width}`).toBeGreaterThanOrEqual(geometry.brand!.bottom - 1);
        expect(geometry.actions!.top, `actions below the links at ${width}`).toBeGreaterThanOrEqual(geometry.nav!.bottom - 1);
        expect(geometry.bar!.bottom, `the bar grows to hold the second row at ${width}`).toBeGreaterThanOrEqual(geometry.actions!.bottom);
        expect(geometry.actions!.right, `actions stay inside the bar at ${width}`).toBeLessThanOrEqual(geometry.viewport + 1);
        // The wrapped bar is exactly two rows tall: the second row is the actions, nothing is pushed to a third.
        expect(geometry.bar!.height, `two rows, not three, at ${width}`).toBeLessThan(geometry.brand!.height + geometry.actions!.height + 60);
      }
      // The markup order is the shown order, however the bar wraps: brand, then the links left to right, then the actions.
      expect(await page.evaluate(() => {
        const bar = document.querySelector('header.topbar') as HTMLElement;
        const sequence = [bar.querySelector('.brand'), ...Array.from(bar.querySelectorAll('nav.primary-nav a')), bar.querySelector('.top-actions')] as HTMLElement[];
        return sequence.every((element, index) => index === 0 || Boolean(sequence[index - 1]!.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING));
      }), `DOM order is brand, links, actions at ${width}`).toBe(true);
      expect(await auditLayout(page, { within: ['header.topbar'] }), `header layout at ${width}`).toEqual([]);
    }
  });
  }
  for (const clock of CLOCKS) test(`Tab moves through the header in the order it is shown, at every width from 900 px, with a ${clock.label} in the clock (WCAG 1.3.2, 2.4.3)`, async ({ page, api }) => {
    await freezeClock(page, clock.time);
    stubHome(api, FROZEN_MONTH);
    await signIn(page, '/');
    await expect(page.locator('header.topbar .tc-time'), 'the frozen clock is shown').toHaveText(clock.shown);
    const EXPECTED = [/^Project Money Beta/, /Home$/, /Spending$/, /Plan$/, /Goals$/, /Trips$/, /Settings$/, /^Toggle theme$/, /^Sign out$/];
    for (const width of [900, 1024, 1200, 1280, 1319, 1320, 1440]) {
      await resize(page, width);
      await resetFocusToTop(page);
      const stops: Array<{ name: string; left: number; right: number; top: number; bottom: number; height: number }> = [];
      for (let presses = 0; presses < 24; presses += 1) {
        await page.keyboard.press('Tab');
        const stop = await page.evaluate(() => {
          const element = document.activeElement as HTMLElement | null;
          if (!element || !element.closest('header.topbar')) return null;
          const rect = element.getBoundingClientRect();
          return { name: (element.getAttribute('aria-label') ?? element.textContent ?? '').trim(), left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, height: rect.height };
        });
        if (stop) stops.push(stop);
        else if (stops.length > 0) break;
      }
      expect(stops.map((stop) => stop.name), `Tab order in the header at ${width}`).toHaveLength(EXPECTED.length);
      EXPECTED.forEach((pattern, index) => expect(stops[index]!.name, `stop ${index} at ${width}`).toMatch(pattern));
      // And that order is the order on screen: each stop is on a lower row than the one before, or to its right.
      for (let i = 1; i < stops.length; i += 1) {
        expect(follows(stops[i - 1]!, stops[i]!), `"${stops[i]!.name}" is focused after "${stops[i - 1]!.name}" but is shown before it at ${width}`).toBe(true);
      }
    }
  });
});

test.describe('full-width content', () => {
  test('spans the page width with no side column, and is capped and centred on very wide screens', async ({ page, api }) => {
    stubHome(api);
    await signIn(page, '/');
    const measure = () => page.evaluate(() => {
      const main = document.querySelector('main') as HTMLElement;
      const rect = main.getBoundingClientRect();
      const viewport = document.documentElement.clientWidth;
      return { left: Math.round(rect.left), right: Math.round(viewport - rect.right), width: Math.round(rect.width), viewport };
    });

    for (const width of [1024, 1366, 1440]) {
      await resize(page, width);
      const box = await measure();
      // Only the page gutter (at most 2rem) is left on either side: no 232px sidebar column and no narrow centre column.
      expect(box.left, `left space at ${width}`).toBeLessThanOrEqual(40);
      expect(box.right, `right space at ${width}`).toBeLessThanOrEqual(40);
      expect(box.width, `main width at ${width}`).toBeGreaterThanOrEqual(width - 15 - 80);
    }
    await resize(page, 3840);
    const wide = await measure();
    expect(wide.width, 'main width at 3840 is capped').toBeLessThanOrEqual(1600);
    expect(wide.width, 'main width at 3840 is still wide').toBeGreaterThanOrEqual(1400);
    expect(Math.abs(wide.left - wide.right), 'main is centred at 3840').toBeLessThanOrEqual(2);
    // The header lines up with the content.
    const header = await headerGeometry(page);
    expect(Math.abs(header.brand!.left - (await page.evaluate(() => (document.querySelector('main') as HTMLElement).getBoundingClientRect().left))), 'brand aligns with the content edge').toBeLessThanOrEqual(2);
  });

  test('the announcement banner uses the same width as the content', async ({ page, api }) => {
    stubHome(api);
    api.stub('GET', '/api/public/announcement', { json: { announcement: { id: 7, kind: 'info', message: 'Beta notice: some pages may change this week.' } } });
    await signIn(page, '/');
    await expect(page.locator('.announce-banner')).toBeVisible();
    for (const width of [1100, 1366, 3840]) {
      await resize(page, width);
      const edges = await page.evaluate(() => {
        const banner = (document.querySelector('.announce-banner') as HTMLElement).getBoundingClientRect();
        const main = (document.querySelector('main') as HTMLElement).getBoundingClientRect();
        return { bannerLeft: banner.left, bannerRight: banner.right, mainLeft: main.left, mainRight: main.right };
      });
      expect(Math.abs(edges.bannerLeft - edges.mainLeft), `banner left edge at ${width}`).toBeLessThanOrEqual(2);
      expect(Math.abs(edges.bannerRight - edges.mainRight), `banner right edge at ${width}`).toBeLessThanOrEqual(2);
    }
  });
});

test.describe('Home key numbers', () => {
  /** The cards of the key-number row, grouped into visual rows. */
  async function rows(page: Page) {
    return page.evaluate(() => {
      const grid = document.querySelector('.monthly-clarity-grid') as HTMLElement;
      const gridBox = grid.getBoundingClientRect();
      const cells = Array.from(grid.children).map((cell) => {
        const rect = cell.getBoundingClientRect();
        return { region: (cell as HTMLElement).dataset.region ?? '', left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      });
      const groups: typeof cells[] = [];
      for (const cell of cells) {
        const group = groups.find((candidate) => Math.abs(candidate[0]!.top - cell.top) < 4);
        if (group) group.push(cell);
        else groups.push([cell]);
      }
      return { grid: { left: gridBox.left, right: gridBox.right }, groups: groups.map((group) => group.sort((a, b) => a.left - b.left)), count: grid.dataset.count };
    });
  }

  for (const [width, expectedRows] of [[1024, [2, 2]], [1440, [4]], [3840, [4]]] as const) {
    test(`fill their row with no gap beside a card at ${width} px`, async ({ page, api }) => {
      stubHome(api);
      await signIn(page, '/');
      await expect(page.getByRole('article', { name: 'Remaining to spend' })).toBeVisible();
      await resize(page, width);

      const { grid, groups, count } = await rows(page);
      expect(count).toBe('4');
      expect(groups.map((group) => group.length), `cards per row at ${width}`).toEqual(expectedRows);
      for (const group of groups) {
        // The row starts and ends at the edges of the grid: nothing is left over on the right.
        expect(Math.abs(group[0]!.left - grid.left), `row starts at the grid edge at ${width}`).toBeLessThanOrEqual(1);
        expect(Math.abs(group[group.length - 1]!.right - grid.right), `row ends at the grid edge at ${width}`).toBeLessThanOrEqual(1);
        // Equal widths and equal gaps between neighbours.
        const widths = group.map((cell) => cell.right - cell.left);
        expect(Math.max(...widths) - Math.min(...widths), `card widths in a row at ${width}`).toBeLessThanOrEqual(1);
        for (let i = 1; i < group.length; i += 1) {
          expect(Math.abs(group[i]!.left - group[i - 1]!.right - 16), `gap between cards at ${width}`).toBeLessThanOrEqual(1);
        }
        // Each card keeps at least 280 px (the outcome-card minimum).
        for (const width of widths) expect(width).toBeGreaterThanOrEqual(279);
      }
      // The next section starts below the row, so no card is stranded beside other content.
      expect(await auditLayout(page, { measure: width >= 1440 })).toEqual([]);
    });
  }

  // Changed from "key numbers, then quick actions" (approved earlier) to "quick actions, then key numbers": the
  // owner asked for every feature in front of the eyes, and the four quick actions were below the first screen.
  test('puts the four quick actions, then the key numbers, on the first screen at 1366x768', async ({ page, api }) => {
    stubHome(api);
    await signIn(page, '/');
    await resize(page, 1366, 768);
    await expect(page.getByRole('article', { name: 'Remaining to spend' })).toBeVisible();

    const inView = await page.evaluate(() => {
      const box = (element: Element) => { const rect = element.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right }; };
      return {
        tiles: Array.from(document.querySelectorAll('nav.quick-actions a')).map((tile) => ({ text: (tile.textContent ?? '').trim(), ...box(tile) })),
        header: box(document.querySelector('.clarity-decision-header') as Element),
        keyNumbersTop: Math.min(...Array.from(document.querySelectorAll('.monthly-clarity-grid article')).map((card) => card.getBoundingClientRect().top)),
        keyNumbersBottom: Math.max(...Array.from(document.querySelectorAll('.monthly-clarity-grid article')).map((card) => card.getBoundingClientRect().bottom)),
        nextActionsTop: box(document.querySelector('[data-region="actions"]') as Element).top,
        windowHeight: window.innerHeight,
        windowWidth: window.innerWidth,
        scrollY: window.scrollY,
      };
    });
    expect(inView.scrollY).toBe(0);
    expect(inView.windowHeight).toBe(768);
    // All four tiles are completely inside the first 768 px (and inside the width).
    expect(inView.tiles.map((tile) => tile.text.replace(/^\P{L}+/u, ''))).toEqual(['Add expense', 'Plan month', 'Savings goal', 'Trip split']);
    for (const tile of inView.tiles) {
      expect(tile.top, `${tile.text} top`).toBeGreaterThanOrEqual(0);
      expect(tile.bottom, `${tile.text} bottom is inside the first screen`).toBeLessThanOrEqual(768);
      expect(tile.left).toBeGreaterThanOrEqual(0);
      expect(tile.right).toBeLessThanOrEqual(inView.windowWidth);
    }
    // They sit directly under the greeting and next action, above the key numbers, in one row.
    expect(inView.tiles[0]!.top - inView.header.bottom, 'gap between the header and the quick actions').toBeLessThanOrEqual(24);
    expect(Math.max(...inView.tiles.map((tile) => tile.top)) - Math.min(...inView.tiles.map((tile) => tile.top)), 'one row').toBeLessThanOrEqual(1);
    expect(inView.keyNumbersTop, 'key numbers start below the quick actions').toBeGreaterThanOrEqual(inView.tiles[0]!.bottom);
    expect(inView.keyNumbersTop, 'key numbers start on the first screen').toBeLessThan(768);
    expect(inView.nextActionsTop).toBeGreaterThan(inView.keyNumbersBottom - 1);
  });

  test('on a phone the quick actions are a 2x2 grid of 44 px or larger tiles right after the greeting and next action', async ({ page, api }) => {
    stubHome(api);
    await signIn(page, '/');
    for (const [width, height] of [[390, 844], [360, 740], [320, 640]] as const) {
      await resize(page, width, height);
      await expect(page.getByRole('article', { name: 'Remaining to spend' })).toBeVisible();
      const geometry = await page.evaluate(() => {
        const box = (element: Element) => { const rect = element.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width, height: rect.height }; };
        return {
          tiles: Array.from(document.querySelectorAll('nav.quick-actions a')).map((tile) => box(tile)),
          header: box(document.querySelector('.clarity-decision-header') as Element),
          firstCard: box(document.querySelector('.monthly-clarity-grid article') as Element),
          viewport: document.documentElement.clientWidth,
        };
      });
      const rowsOfTiles = new Set(geometry.tiles.map((tile) => Math.round(tile.top)));
      const columnsOfTiles = new Set(geometry.tiles.map((tile) => Math.round(tile.left)));
      expect({ rows: rowsOfTiles.size, columns: columnsOfTiles.size }, `grid at ${width}`).toEqual({ rows: 2, columns: 2 });
      for (const tile of geometry.tiles) {
        expect(tile.height, `tile height at ${width}`).toBeGreaterThanOrEqual(44);
        expect(tile.width, `tile width at ${width}`).toBeGreaterThanOrEqual(44);
        expect(tile.left).toBeGreaterThanOrEqual(0);
        expect(tile.right).toBeLessThanOrEqual(geometry.viewport + 1);
      }
      expect(geometry.tiles[0]!.top - geometry.header.bottom, `gap after the header at ${width}`).toBeLessThanOrEqual(24);
      expect(geometry.firstCard.top, `key numbers follow the quick actions at ${width}`).toBeGreaterThanOrEqual(Math.max(...geometry.tiles.map((tile) => tile.bottom)) - 1);
    }
  });

  test('the DOM order of the greeting, quick actions, key numbers, next actions, journey and streak is their visual order, and Tab follows it', async ({ page, api }) => {
    stubHome(api);
    await signIn(page, '/');
    for (const [width, height] of [[1366, 768], [1024, 768], [390, 844]] as const) {
      await resize(page, width, height);
      await expect(page.getByRole('article', { name: 'Remaining to spend' })).toBeVisible();
      await expect(page.getByRole('heading', { name: /Logging streak/ })).toBeVisible();
      const sequence = await page.evaluate(() => {
        const selectors = [
          '.clarity-decision-header',
          'nav.quick-actions a:nth-of-type(1)', 'nav.quick-actions a:nth-of-type(2)', 'nav.quick-actions a:nth-of-type(3)', 'nav.quick-actions a:nth-of-type(4)',
          '[data-region="monthly-plan"]', '[data-region="spending"]', '[data-region="goal"]', '[data-region="trip"]',
          '[data-region="actions"]',
          '.home-secondary > .card:nth-child(1)', '.home-secondary > .card:nth-child(2)',
        ];
        const elements = selectors.map((selector) => document.querySelector(selector) as HTMLElement);
        const inDomOrder = elements.every((element, index) => index === 0 || Boolean(elements[index - 1]!.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING));
        const boxes = elements.map((element, index) => {
          const rect = element.getBoundingClientRect();
          return { text: selectors[index]!, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, height: rect.height };
        });
        return { inDomOrder, boxes };
      });
      expect(sequence.inDomOrder, `DOM order at ${width}`).toBe(true);
      for (let i = 1; i < sequence.boxes.length; i += 1) {
        expect(follows(sequence.boxes[i - 1]!, sequence.boxes[i]!), `"${sequence.boxes[i]!.text}" is shown before "${sequence.boxes[i - 1]!.text}" at ${width}`).toBe(true);
      }

      // Tab visits the four tiles in the order they are shown.
      await resetFocusToTop(page);
      const stops: Array<{ name: string } & Box> = [];
      for (let presses = 0; presses < 40 && stops.length < 4; presses += 1) {
        await page.keyboard.press('Tab');
        const stop = await page.evaluate(() => {
          const element = document.activeElement as HTMLElement | null;
          if (!element || !element.closest('nav.quick-actions')) return null;
          const rect = element.getBoundingClientRect();
          return { name: (element.textContent ?? '').trim().replace(/^\P{L}+/u, ''), left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, height: rect.height };
        });
        if (stop) stops.push(stop);
      }
      expect(stops.map((stop) => stop.name), `Tab order at ${width}`).toEqual(['Add expense', 'Plan month', 'Savings goal', 'Trip split']);
      for (let i = 1; i < stops.length; i += 1) {
        expect(follows(stops[i - 1]!, stops[i]!), `"${stops[i]!.name}" is focused after "${stops[i - 1]!.name}" but is shown before it at ${width}`).toBe(true);
      }
    }
  });

  /** The heights of the items matching `selector`, grouped into visual rows (items within 4 px of the same top). */
  async function rowHeights(page: Page, selector: string): Promise<Array<{ heights: number[]; bottoms: number[] }>> {
    return page.evaluate((sel) => {
      const items = Array.from(document.querySelectorAll(sel)).map((element) => {
        const rect = element.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, height: rect.height };
      });
      const groups: typeof items[] = [];
      for (const item of items) {
        const group = groups.find((candidate) => Math.abs(candidate[0]!.top - item.top) < 4);
        if (group) group.push(item);
        else groups.push([item]);
      }
      return groups.map((group) => ({ heights: group.map((item) => item.height), bottoms: group.map((item) => item.bottom) }));
    }, selector);
  }

  for (const width of [1024, 1366, 1440, 3840]) {
    test(`cards in each Home row have equal heights at ${width} px`, async ({ page, api }) => {
      stubHome(api);
      await signIn(page, '/');
      await expect(page.getByRole('article', { name: 'Remaining to spend' })).toBeVisible();
      await expect(page.getByRole('heading', { name: /Logging streak/ })).toBeVisible();
      await resize(page, width);

      const expectEqual = async (name: string, selector: string, expectedRows?: number[]) => {
        const rows = await rowHeights(page, selector);
        if (expectedRows) expect(rows.map((row) => row.heights.length), `${name}: cards per row at ${width}`).toEqual(expectedRows);
        for (const row of rows) {
          expect(Math.max(...row.heights) - Math.min(...row.heights), `${name}: heights ${row.heights.map(Math.round).join(', ')} at ${width}`).toBeLessThanOrEqual(1);
          expect(Math.max(...row.bottoms) - Math.min(...row.bottoms), `${name}: bottoms ${row.bottoms.map(Math.round).join(', ')} at ${width}`).toBeLessThanOrEqual(1);
        }
      };
      // The four key-number cards themselves (not only their grid cells): 2 + 2 at 1024, one row of four above.
      await expectEqual('key-number cards', '.monthly-clarity-grid article', width === 1024 ? [2, 2] : [4]);
      // Guided journey and the logging streak share one row.
      await expectEqual('journey and streak', '.home-secondary > .card', [2]);
      // Next actions items sit in 2 columns from 1100 px, one per row below it.
      await expectEqual('next actions', '.monthly-clarity-action-list > li', width >= 1100 ? [2] : [1, 1]);

      // The card fills its cell: nothing hangs below a card inside a key-number cell.
      const hanging = await page.evaluate(() => Array.from(document.querySelectorAll('.monthly-clarity-grid > [data-region]')).map((cell) => {
        const rect = cell.getBoundingClientRect();
        const cards = Array.from(cell.children).filter((child) => child.matches('.card')).map((card) => card.getBoundingClientRect().bottom);
        return rect.bottom - Math.max(...cards);
      }));
      for (const gap of hanging) expect(gap, `space left under a key-number card at ${width}`).toBeLessThanOrEqual(1);
      expect(await auditLayout(page, { measure: width >= 1440 })).toEqual([]);
    });
  }

  test('Next actions use 2 or 3 columns of at least 320 px from 1100 px', async ({ page, api }) => {
    stubHome(api);
    await signIn(page, '/');
    await expect(page.getByRole('article', { name: 'Remaining to spend' })).toBeVisible();
    for (const width of [1100, 1366, 3840]) {
      await resize(page, width);
      const items = await page.evaluate(() => Array.from(document.querySelectorAll('.monthly-clarity-action-list > li')).map((item) => {
        const rect = item.getBoundingClientRect();
        return { left: rect.left, right: rect.right, width: rect.width, top: rect.top };
      }));
      expect(items.length).toBeGreaterThanOrEqual(2);
      expect(new Set(items.map((item) => Math.round(item.top))).size, `one row of items at ${width}`).toBe(1);
      for (const item of items) expect(item.width, `item width at ${width}`).toBeGreaterThanOrEqual(319);
    }
    await resize(page, 1024);
    const stacked = await page.evaluate(() => new Set(Array.from(document.querySelectorAll('.monthly-clarity-action-list > li')).map((item) => Math.round(item.getBoundingClientRect().top))).size);
    expect(stacked, 'one column below 1100 px').toBeGreaterThanOrEqual(2);
  });
});

test.describe('less clutter above the page', () => {
  test('the promise is one line, and "How it works" opens the four parts', async ({ page, api }, testInfo: TestInfo) => {
    stubHome(api);
    await signIn(page, '/');
    await resize(page, 1366);
    const promise = page.getByRole('region', { name: /safe to spend/i });
    const heading = promise.getByRole('heading', { name: /safe to spend/i });
    await expect(heading).toBeVisible();
    const lineHeight = await heading.evaluate((element) => parseFloat(getComputedStyle(element).lineHeight));
    const box = await heading.boundingBox();
    expect(box!.height, 'the promise heading is a single line').toBeLessThanOrEqual(lineHeight + 2);
    await expect(promise.getByText('Plan:')).toBeHidden();

    await promise.getByRole('button', { name: 'How it works' }).click();
    for (const word of ['Plan', 'Spending', 'Saving', 'Trips']) await expect(promise.getByText(`${word}:`)).toBeVisible();
    expect(testInfo.project.name).toMatch(/^clarity-/);
  });

  test('after the notice is acknowledged the data-use card is a small "Your data" control that opens the notice', async ({ page, api }) => {
    stubHome(api);
    await signIn(page, '/');
    await resize(page, 1366);
    const control = page.getByRole('button', { name: 'Your data' });
    await expect(control).toBeVisible();
    await expect(control).toHaveAttribute('aria-expanded', 'false');
    const small = await control.boundingBox();
    expect(small!.height, 'the control is a single small button').toBeLessThanOrEqual(48);
    await expect(page.getByText('You acknowledged the data-use notice')).toBeHidden();
    await expect(page.getByRole('checkbox', { name: /Product Analytics/ })).toBeHidden();
    // It shares the row with the promise instead of taking one of its own.
    const sameRow = await page.evaluate(() => {
      const promise = (document.querySelector('.clarity-promise') as HTMLElement).getBoundingClientRect();
      const button = (document.querySelector('.clarity-gate-toggle') as HTMLElement).getBoundingClientRect();
      return Math.abs(promise.top - button.top) < promise.height;
    });
    expect(sameRow).toBe(true);

    await control.click();
    await expect(control).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByText(/You acknowledged the data-use notice/)).toBeVisible();
    await expect(page.getByRole('checkbox', { name: /Product Analytics/ })).toBeVisible();
    await page.getByRole('button', { name: /Review the data-use notice/ }).click();
    await expect(page.getByRole('link', { name: 'Export your data' })).toBeVisible();
    await control.click();
    await expect(page.getByRole('checkbox', { name: /Product Analytics/ })).toBeHidden();
  });

  test('before acknowledgement the full notice stays on screen and new entries are paused with the reason', async ({ page, api }) => {
    stubHome(api);
    api.stub('GET', '/api/clarity/settings', { json: buildSettings({ acknowledgedVersion: 0 }) });
    await signIn(page, '/');
    await resize(page, 1366);

    await expect(page.getByRole('button', { name: 'Your data' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Your data, your control' })).toBeVisible();
    await expect(page.getByText('New entries are paused.')).toBeVisible();
    await expect(page.getByRole('button', { name: /Acknowledge version/ })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: /Product Analytics/ })).toBeVisible();
  });
});

// The Plan page's pay and bills cards sit side by side from 820 px. The bills card (list and add form) is far taller
// than the pay card (explanations, then a short form). They once stretched to one height, which left about 500 px of
// blank space inside the pay card between its explanation panels and its form. Now each card keeps its own height.
// (Home and Trips cards hold similar amounts in a row and still share one height: see "cards in each Home row" above.)
test.describe('Plan pay and bills row', () => {
  for (const width of [1366, 1440]) {
    test(`the pay card keeps its own height, with no large blank space inside it, at ${width} px`, async ({ page, api }) => {
      installClarityBackend(api, MONTH, { salaryMinor: 7_500_000, bills: BILLS });
      await signIn(page, '/plan');
      await expect(page.getByRole('textbox', { name: 'Monthly pay' })).toBeVisible();
      await expect(page.getByRole('button', { name: '+ Add bill' })).toBeVisible();
      await resize(page, width);

      const row = await page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll('.plan-inputs-row > .card')) as HTMLElement[];
        const measure = (card: HTMLElement) => {
          const rect = card.getBoundingClientRect();
          const style = getComputedStyle(card);
          // The in-flow children, top to bottom: the explanation panels, then the form.
          const children = (Array.from(card.children) as HTMLElement[])
            .filter((child) => getComputedStyle(child).display !== 'none' && getComputedStyle(child).position !== 'absolute')
            .map((child) => child.getBoundingClientRect())
            .filter((box) => box.height > 0)
            .sort((a, b) => a.top - b.top);
          const gaps = children.slice(1).map((box, index) => box.top - children[index]!.bottom);
          return {
            top: rect.top,
            height: rect.height,
            // The height the card's own content needs (its parts and padding, without any stretch added by the row).
            contentHeight: children.reduce((sum, box) => sum + box.height, 0) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom),
            alignItems: getComputedStyle(card.parentElement as HTMLElement).alignItems,
            // Blank space under the last child, inside the card's padding box.
            bottomBlank: rect.bottom - parseFloat(style.paddingBottom) - children[children.length - 1]!.bottom,
            largestGap: Math.max(0, ...gaps),
            children: children.length,
          };
        };
        return { pay: measure(cards[0]!), bills: measure(cards[1]!), cards: cards.length };
      });

      expect(row.cards, 'pay and bills cards in the row').toBe(2);
      expect(row.pay.children, 'the pay card has explanation panels and a form').toBeGreaterThanOrEqual(3);
      // The premise: the bills card is much taller, so a stretch would add blank space to the pay card.
      expect(row.bills.height - row.pay.contentHeight, `bills card (${Math.round(row.bills.height)} px) is taller than the pay card's content (${Math.round(row.pay.contentHeight)} px)`).toBeGreaterThan(150);
      expect.soft(row.pay.alignItems, 'the row aligns its cards to the top').toBe('start');
      expect.soft(Math.abs(row.pay.top - row.bills.top), 'both cards start on the same line').toBeLessThanOrEqual(1);
      // No blank space under the pay card's content, and none between its explanations and its form.
      expect.soft(row.pay.bottomBlank, `blank space between the pay card's content and its bottom edge at ${width}`).toBeLessThanOrEqual(120);
      expect.soft(row.pay.largestGap, `largest gap between the pay card's panels and its form at ${width}`).toBeLessThanOrEqual(120);
    });
  }
});

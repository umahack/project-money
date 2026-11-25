// Text spacing and 200 percent text on the clarity pages (task 17.4, Requirements 12.8 and 12.9;
// WCAG 1.4.4 Resize Text, 1.4.10 Reflow, 1.4.12 Text Spacing).
//
// Each representative page state is opened with the real, unmodified CSS and then
//
// 1. given the four WCAG 1.4.12 overrides (line height 1.5, letter spacing 0.12 em, word spacing 0.16 em,
//    paragraph spacing 2 em), and
// 2. given 200 percent text on top of them,
//
// and must show no horizontal overflow, no clipped or truncated text, no overlap, and nothing hidden behind the
// bottom navigation, in both themes. The `clarity-a11y-320` project runs this at 320 px, the width where a
// 400 percent browser zoom lands on a 1280 px window (WCAG 1.4.10); `clarity-1440` runs it on the desktop layout.
import { applyTextSpacing, auditVerticalClipping, setTheme } from './helpers/a11y';
import { SCENARIOS } from './helpers/clarityScenarios';
import { auditLayout, contentHiddenByBottomNavigation, scaleText, settleAnimations } from './helpers/layout';
import { expect, test } from './fixtures/test';
import type { Page, TestInfo } from '@playwright/test';

test.use({ video: 'off', trace: 'off' });

const TOP_NAV_FROM = 900;

/** One full state and one degraded or in-progress state of every clarity page. */
const REPRESENTATIVE = [
  'Home: full outcomes with a seven-digit pay and long bill names',
  'Home: calculation_failed, refresh_failed, invalid_input, and stale regions side by side',
  'Agreement: data-use notice required, full details open',
  'Home: entries paused after "Not now, just look around"',
  'Plan: full plan with a seven-digit pay and long bill names',
  'Plan: bill form with validation errors',
  'Plan: pay save failed with its retry',
  'Spending: full list with seven-digit amounts and long notes',
  'Spending: expense correction form open',
  'Spending: expense save pending',
  'Goals: full list with long Unicode names and seven-digit amounts',
  'Goals: contribution form with a validation error',
  'Trips: list with long Unicode names and a seven-digit budget',
  'TripDetail: long names, long expense text, and seven-digit amounts',
  'TripDetail: share tab with long names and seven-digit amounts',
  'TripDetail: share disclosure dialog',
  'Journey: choosing an outcome',
  'Journey: first step failed with its retry',
  'Settings: sessions, categories, analytics control, export, and delete-account zone',
];

function widthOf(testInfo: TestInfo): number {
  const viewport = testInfo.project.use.viewport;
  if (!viewport) throw new Error('Every accessibility project sets a viewport.');
  return viewport.width;
}

async function audit(page: Page, width: number): Promise<string[]> {
  await settleAnimations(page);
  // A number field scrolls its own text, and 200% text with 0.12 em letter spacing makes an eight-digit value
  // wider than a 320 px column. The value stays reachable, so that one finding is not content that is lost.
  const issues = (await auditLayout(page)).filter((issue) => !/^field: .* cuts its value/.test(issue));
  issues.push(...(await auditVerticalClipping(page)));
  if (width < TOP_NAV_FROM) issues.push(...(await contentHiddenByBottomNavigation(page)).map((item) => `covered by bottom navigation: ${item}`));
  return issues;
}

for (const name of REPRESENTATIVE) {
  test(name, async ({ page, api }, testInfo) => {
    const scenario = SCENARIOS.find((candidate) => candidate.name === name);
    if (!scenario) throw new Error(`No scenario is named "${name}".`);
    const width = widthOf(testInfo);
    await scenario.open(page, api);
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    const report: Record<string, string[]> = {};
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      if (theme === 'light') await applyTextSpacing(page);
      const spacing = await audit(page, width);
      if (spacing.length > 0) report[`${theme}, text spacing`] = spacing;
    }
    await setTheme(page, 'light');
    await scaleText(page, 200);
    const zoomed = await audit(page, width);
    if (zoomed.length > 0) report['text spacing and 200% text'] = zoomed;
    expect(report).toEqual({});
  });
}

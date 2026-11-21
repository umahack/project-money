// Real-browser accessibility rules and colour contrast for the financial clarity pages
// (task 17.4, Requirements 12.2, 12.11, 12.12, 12.13).
//
// jsdom already runs axe on each component with colour-contrast off, because it cannot compute
// colour. Here every page scenario (the same screens the responsive spec audits: full, empty,
// pending, failed, calculation_failed, refresh_failed, stale, missing, and invalid states) runs
// in both themes, against the real, unmodified CSS, at the width of the running project:
//
// 1. axe-core, WCAG 2.x A/AA and best-practice rules, colour-contrast enabled, zero violations,
// 2. an own measurement of every text node (4.5:1, or 3:1 when large or bold), every status
//    glyph (3:1), and every text field boundary (3:1), with translucent layers composited and the
//    drifting dark-theme background taken at its worst point.
import { SCENARIOS } from './helpers/clarityScenarios';
import { THEMES, expectContrast, runAxe, setTheme } from './helpers/a11y';
import { settleAnimations } from './helpers/layout';
import { expect, test } from './fixtures/test';

// Contrast needs the screenshot of a failure, not a recording of every step.
test.use({ video: 'off', trace: 'off' });

test('the contrast audit measures chart fills, status glyphs, field edges, and placeholders, not only text', async ({ page, api }) => {
  await SCENARIOS.find((scenario) => scenario.name === 'Plan: full plan with a seven-digit pay and long bill names')!.open(page, api);
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await settleAnimations(page);
  for (const theme of THEMES) {
    await setTheme(page, theme);
    const report = await expectContrast(page, `plan ${theme}`);
    // The category bars on the Plan page are chart fills; the status glyphs and the ₹ prefix are decorative glyphs.
    expect(report.measured.glyph, 'chart fills and glyphs were measured').toBeGreaterThanOrEqual(4);
    expect(report.measured.field, 'text fields were measured').toBeGreaterThanOrEqual(2);
  }
});

for (const scenario of SCENARIOS) {
  test(scenario.name, async ({ page, api }) => {
    await scenario.open(page, api);
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    await settleAnimations(page);
    for (const theme of THEMES) {
      await setTheme(page, theme);
      // The theme switch has its own short transitions; measure the settled colours.
      await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 350)));
      await settleAnimations(page);
      const axe = await runAxe(page);
      // Soft, so one run lists every violation in both themes instead of stopping at the first.
      expect.soft(axe.violations, `axe violations (${theme})`).toEqual([]);
      await expectContrast(page, theme);
    }
  });
}

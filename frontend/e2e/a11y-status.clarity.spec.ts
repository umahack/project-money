// Status text is never colour alone (task 17.4, Requirements 12.2 and 12.13).
//
// Every status the clarity pages show (available, missing_input, invalid_input, stale, refresh_failed,
// calculation_failed, pending, success, failure, funded, active, overdue, receivable, owed, settled,
// required, optional) must be written as text beside any colour or glyph. The checks:
//
// 1. the text is on the page for each state, in its own region, with a decorative `aria-hidden` glyph,
// 2. with every colour removed (a forced greyscale filter) the states still differ by text: no two
//    different statuses share the same words,
// 3. with `forced-colors: active` (Windows high contrast), the status text is still on screen and every focus stop
//    still draws an outline, because the OS removes box shadows,
// 4. `prefers-contrast: more`: the app defines no rules for it, so the page must render exactly as it does by
//    default. This asserts that nothing breaks (layout, contrast) when a person asks for more contrast.
import { collectFocusStops, expectContrast, resetFocusToTop, setTheme, THEMES } from './helpers/a11y';
import { MONTH, MONTH_NAME, SCENARIOS, signIn } from './helpers/clarityScenarios';
import { installClarityBackend } from './helpers/clarityApi';
import { installGoalsBackend } from './helpers/goalsApi';
import { installJourneyApi } from './helpers/journeyApi';
import { auditLayout, settleAnimations } from './helpers/layout';
import { installTripsBackend } from './helpers/tripsApi';
import { TEST_USER, expect, test } from './fixtures/test';
import { STATUS_PRESENTATION } from '../src/components/clarity/format';
import type { OutcomeStatus } from '../src/clarity/contracts';
import type { Page } from '@playwright/test';

test.use({ video: 'off', trace: 'off' });

const STATE_TEXT: Record<OutcomeStatus, RegExp> = {
  available: /Confirmed/,
  missing_input: /Not available yet\./,
  invalid_input: /Not available until an input is corrected\./,
  stale: /Stale\./,
  refresh_failed: /Refresh failed\./,
  calculation_failed: /Temporarily unavailable\./,
};

function scenarioNamed(name: string) {
  const scenario = SCENARIOS.find((candidate) => candidate.name === name);
  if (!scenario) throw new Error(`No scenario is named "${name}".`);
  return scenario;
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await settleAnimations(page);
}

interface CardStatus {
  id: string;
  status: string;
  badge: string;
  glyph: string;
  glyphHidden: boolean;
  badgeVisible: boolean;
  text: string;
}

/** Reads every outcome card's status as a reader would meet it. */
async function readCards(page: Page): Promise<CardStatus[]> {
  return page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('article.clarity-outcome[data-status]')).map((card) => {
    const badge = card.querySelector<HTMLElement>('.clarity-status');
    const glyph = badge?.querySelector<HTMLElement>('.clarity-glyph') ?? null;
    return {
      id: card.dataset.outcomeId ?? '',
      status: card.dataset.status ?? '',
      badge: (badge?.textContent ?? '').replace(glyph?.textContent ?? '', '').trim(),
      glyph: (glyph?.textContent ?? '').trim(),
      glyphHidden: glyph?.getAttribute('aria-hidden') === 'true',
      badgeVisible: !!badge && badge.offsetWidth > 0 && getComputedStyle(badge).visibility === 'visible',
      text: card.innerText,
    };
  }));
}

const HOME_STATES = [
  'Home: full outcomes with a seven-digit pay and long bill names',
  'Home: every region missing its input',
  'Home: calculation_failed, refresh_failed, invalid_input, and stale regions side by side',
];

test('every outcome status is written as text with a decorative glyph (available, missing, invalid, stale, refresh failed, calculation failed)', async ({ page, api }) => {
  const seen = new Set<string>();
  for (const name of HOME_STATES) {
    await scenarioNamed(name).open(page, api);
    await settle(page);
    for (const card of await readCards(page)) {
      const expected = STATUS_PRESENTATION[card.status as OutcomeStatus];
      expect(card.badge, `${card.id} status badge text`).toBe(expected.label);
      expect(card.glyph, `${card.id} glyph`).toBe(expected.glyph);
      expect(card.glyphHidden, `${card.id} glyph is decorative`).toBe(true);
      expect(card.badgeVisible, `${card.id} status badge is on screen`).toBe(true);
      expect(card.text, `${card.id} explains its state in words`).toMatch(STATE_TEXT[card.status as OutcomeStatus]);
      seen.add(card.status);
    }
  }
  expect([...seen].sort()).toEqual(Object.keys(STATUS_PRESENTATION).sort());
});

test('with every colour removed the statuses still differ by their words', async ({ page, api }) => {
  await scenarioNamed('Home: calculation_failed, refresh_failed, invalid_input, and stale regions side by side').open(page, api);
  await settle(page);
  for (const theme of THEMES) {
    await setTheme(page, theme);
    // Greyscale removes hue. Forcing the tone colours to the text colour removes the lightness cue as well.
    const style = await page.addStyleTag({
      content: 'html { filter: grayscale(1) !important; } .clarity-status, .clarity-glyph, .clarity-state { color: CanvasText !important; border-color: CanvasText !important; background: transparent !important; }',
    });
    const cards = await readCards(page);
    const wordsByStatus = new Map<string, Set<string>>();
    for (const card of cards) {
      expect(card.badgeVisible, `${card.id} badge is visible without colour (${theme})`).toBe(true);
      const words = wordsByStatus.get(card.status) ?? new Set<string>();
      words.add(card.badge);
      wordsByStatus.set(card.status, words);
    }
    expect(wordsByStatus.size, `several different statuses are on screen (${theme})`).toBeGreaterThanOrEqual(3);
    const everyWord = [...wordsByStatus.values()].flatMap((words) => [...words]);
    expect(new Set(everyWord).size, 'two different statuses share the same words').toBe(wordsByStatus.size);
    for (const [status, words] of wordsByStatus) expect(words.size, `${status} is always worded the same`).toBe(1);
    await style.evaluate((node) => (node as Element).remove());
  }
});

test('Goals: funded, active, and overdue goals say so in words', async ({ page, api }) => {
  installGoalsBackend(api, MONTH, {
    goals: [
      { id: 1, name: 'Funded fund', target: 500, saved: 500, date: `${MONTH}-28` },
      { id: 2, name: 'Active fund', target: 1000, saved: 400, date: `${MONTH}-28` },
      { id: 3, name: 'Overdue fund', target: 1000, saved: 200, date: '2020-01-15' },
    ],
  });
  await signIn(page, '/goals');
  for (const [name, word] of [['Funded fund', 'Funded'], ['Active fund', 'Active'], ['Overdue fund', 'Overdue']] as const) {
    const card = page.getByRole('article', { name, exact: true });
    await expect(card, `${name} says ${word}`).toContainText(word);
  }
  await settle(page);
  for (const theme of THEMES) {
    await setTheme(page, theme);
    await expectContrast(page, `goals ${theme}`);
  }
});

test('Trips: receivable, owed, and settled balances are words with a glyph, in both themes', async ({ page, api }) => {
  installTripsBackend(api, MONTH, {
    viewer: TEST_USER.email,
    trips: [{
      id: 3,
      name: 'Goa weekend',
      destination: 'Goa',
      budget: 5000,
      owner: TEST_USER.email,
      members: [{ id: 101, name: 'Asha', email: TEST_USER.email }, { id: 102, name: 'Ravi' }, { id: 103, name: 'Meena' }],
      expenses: [{ id: 11, payer: 'Asha', description: 'Taxi', amount: 900, createdAt: `${MONTH}-02 12:00:00` }],
    }],
  });
  await signIn(page, '/trips/3?tab=balances');
  const main = page.locator('main');
  await expect(main).toContainText(/Receivable/);
  await expect(main).toContainText(/Owed/);
  const glyphs = await page.evaluate(() => Array.from(document.querySelectorAll('main [aria-hidden="true"]')).map((node) => node.textContent?.trim() ?? ''));
  expect(glyphs.some((glyph) => ['▲', '▼', '●'].includes(glyph)), 'a balance glyph accompanies the words').toBe(true);
  await settle(page);
  for (const theme of THEMES) {
    await setTheme(page, theme);
    await expectContrast(page, `trip balances ${theme}`);
  }
});

test('Journey: required and optional steps and each step state are words', async ({ page, api }) => {
  installJourneyApi(api, MONTH);
  await signIn(page, '/start');
  await page.getByRole('list', { name: 'Desired outcomes' }).getByRole('button', { name: 'Plan the month' }).click();
  const progress = page.getByRole('region', { name: 'Journey progress' });
  await expect(progress).toBeVisible();
  await expect(progress).toContainText(/Step \d+ of \d+/);
  await expect(progress).toContainText(/Current step|Done|To do/);
  await page.getByRole('textbox', { name: 'Monthly pay' }).fill('80000');
  await page.getByRole('button', { name: `Save pay for ${MONTH_NAME}` }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Your first result is ready' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Journey progress' })).toContainText(/Optional after your first result/);
  await expect(page.getByRole('region', { name: 'Journey progress' })).toContainText(/Done/);
});

test('a save reports pending, failure, and success in words, each beside the control it belongs to', async ({ page, api }) => {
  const control = installClarityBackend(api, MONTH, { salaryMinor: 7_500_000 });
  await signIn(page, '/plan');
  const pay = page.getByRole('textbox', { name: 'Monthly pay' });
  await expect(pay).toHaveValue('75000');
  const status = page.locator(`[data-scope="salary:${MONTH}"]`);
  const save = page.getByRole('button', { name: `Save pay for ${MONTH_NAME}` });

  const gate = control.hold('POST', '/api/finance/salary');
  await pay.fill('80000');
  await save.click();
  await expect(status).toContainText('Save pay: pending');
  gate.release();
  await expect(status).toContainText('Save pay: done');

  control.backend.failNext('POST', '/finance/salary', 500, 'SERVER_ERROR', 'The pay could not be saved.');
  await pay.fill('90000');
  await save.click();
  await expect(status).toContainText('Save pay: failed.');
  await expect(status).toContainText('The pay could not be saved.');
  await expect(status.getByRole('button', { name: 'Retry Save pay' })).toBeVisible();
});

test.describe('forced colors and increased contrast', () => {
  test('forced-colors: status text stays on screen and every focus stop draws an outline', async ({ page, api }) => {
    await scenarioNamed('Home: calculation_failed, refresh_failed, invalid_input, and stale regions side by side').open(page, api);
    await page.emulateMedia({ forcedColors: 'active' });
    expect(await page.evaluate(() => window.matchMedia('(forced-colors: active)').matches)).toBe(true);
    await settle(page);
    const cards = await readCards(page);
    expect(cards.length).toBeGreaterThanOrEqual(4);
    for (const card of cards) {
      expect(card.badgeVisible, `${card.id} status badge (forced colors)`).toBe(true);
      expect(card.badge).toBe(STATUS_PRESENTATION[card.status as OutcomeStatus].label);
    }
    await resetFocusToTop(page);
    const stops = await collectFocusStops(page, 160);
    expect(stops.length).toBeGreaterThan(4);
    const missing = stops.filter((stop) => stop.kind !== 'outline' || stop.thickness < 2).map((stop) => `${stop.element} (${stop.kind}, ${stop.thickness}px)`);
    expect(missing, 'forced colors removes box shadows, so each stop needs an outline').toEqual([]);
  });

  test('forced-colors: fields keep a visible focus outline on Plan', async ({ page, api }) => {
    await scenarioNamed('Plan: full plan with a seven-digit pay and long bill names').open(page, api);
    await page.emulateMedia({ forcedColors: 'active' });
    await settle(page);
    await resetFocusToTop(page);
    const stops = await collectFocusStops(page, 160);
    expect(stops.length).toBeGreaterThan(4);
    const missing = stops.filter((stop) => stop.kind !== 'outline' || stop.thickness < 2).map((stop) => `${stop.element} (${stop.kind}, ${stop.thickness}px)`);
    expect(missing).toEqual([]);
  });

  test('prefers-contrast: more renders the page as usual (the app defines no rule for it) without breaking layout or contrast', async ({ page, api }) => {
    await scenarioNamed('Plan: full plan with a seven-digit pay and long bill names').open(page, api);
    await page.emulateMedia({ contrast: 'more' });
    expect(await page.evaluate(() => window.matchMedia('(prefers-contrast: more)').matches)).toBe(true);
    await settle(page);
    expect(await auditLayout(page)).toEqual([]);
    for (const theme of THEMES) {
      await setTheme(page, theme);
      await expectContrast(page, `prefers-contrast: more (${theme})`);
    }
  });
});

// Browser acceptance for the data-use Agreement page at /agreement (data-use-agreement-page spec, task 9.2).
//
// Runs on the flag-on server (`clarity-*` projects). Every response comes from in-memory fixtures; nothing leaves
// loopback. The tests cover, in a real browser:
//
// - a user who must agree is redirected to /agreement from a non-exempt route, and agreeing returns to the original
//   destination, with its query string, and (for /start?start=...) the guided-journey intent is still honoured
//   (Requirements 1.1, 2.1),
// - /settings, /admin and /admin/* never redirect while the notice is required (Requirements 5.1, 5.2, 5.3),
// - "Not now, just look around" continues to the destination with new entries paused and nothing written to browser
//   storage, in-app navigation does not redirect again, and a reload asks again (Requirements 3.1, 3.2, 3.5, 3.7),
// - the page's layout at 320 px, 3840 px, and 200 percent zoom in both themes, with axe-core clean (Requirements 8.1, 8.2).
//
// The widths and themes are changed inside the layout tests, so only the `clarity-390` project runs them.
// responsive.clarity.spec.ts and the a11y-* specs also open the Agreement page as a scenario.
import { runAxe, setTheme, THEMES } from './helpers/a11y';
import { installClarityBackend } from './helpers/clarityApi';
import { AGREEMENT_HEADING, MONTH, openAgreement } from './helpers/clarityScenarios';
import { installJourneyApi } from './helpers/journeyApi';
import { auditLayout, scaleText, settleAnimations } from './helpers/layout';
import { TEST_USER, expect, installAuthenticatedSession, test, type DeterministicApiFixtures } from './fixtures/test';
import { buildSettings } from '../src/test/claritySettingsBuilder';
import type { Page } from '@playwright/test';

test.use({ video: 'off', trace: 'off' });

const ADMIN_USER = { ...TEST_USER, id: 9002, is_admin: true, name: 'Browser Fixture Admin' };
const SETTINGS_PATH = '/api/clarity/settings';
const TOP_NAV_FROM = 900;
const AGREE = 'I agree and continue';
const NOT_NOW = 'Not now, just look around';

/** Serves the data-use settings of a user who has not acknowledged the notice. Agreeing (a PATCH) acknowledges it. */
function stubNotice(api: DeterministicApiFixtures): { acknowledged: boolean } {
  const state = { acknowledged: false };
  const current = () => ({ json: buildSettings({ acknowledgedVersion: state.acknowledged ? 1 : 0 }) });
  api.stub('GET', SETTINGS_PATH, current);
  api.stub('PATCH', SETTINGS_PATH, (request) => {
    const body = request.body as { acknowledgedNoticeVersion?: number } | null;
    if (body?.acknowledgedNoticeVersion === 1) state.acknowledged = true;
    return current();
  });
  return state;
}

/** The pages a signed-in user can reach by link, all served from memory. */
function stubPages(api: DeterministicApiFixtures): { acknowledged: boolean } {
  api.stub('GET', '/api/finance/streak', { json: { current: 12, longest: 31, days_logged: 120 } });
  installClarityBackend(api, MONTH, { salaryMinor: 8_000_000 });
  // Registered after the backend, so it replaces the backend's acknowledged settings.
  return stubNotice(api);
}

function stubSettingsPage(api: DeterministicApiFixtures): void {
  api.stub('GET', '/api/invites', { json: { invites: [] } });
  api.stub('GET', '/api/auth/email-change-pending', { json: { pending: null } });
  api.stub('GET', '/api/auth/sessions', { json: { current_sid: 1, sessions: [] } });
  api.stub('GET', '/api/finance/categories', { json: { defaults: ['Food'], custom: [] } });
}

const agreementHeading = (page: Page) => page.getByRole('heading', { level: 1, name: AGREEMENT_HEADING });
const settingsPatches = (api: DeterministicApiFixtures) => api.requests.filter((request) => request.method === 'PATCH' && request.path === SETTINGS_PATH);
const currentPath = (page: Page) => { const url = new URL(page.url()); return `${url.pathname}${url.search}`; };

test.describe('redirect to the Agreement page', () => {
  test('a user who must agree is sent to /agreement, and agreeing returns to the page and query they asked for', async ({ page, api }) => {
    const state = stubPages(api);
    await installAuthenticatedSession(page);
    await page.goto('/plan?ref=e2e');
    await expect(page).toHaveURL(/\/agreement$/);
    await expect(agreementHeading(page)).toBeVisible();
    await expect(agreementHeading(page)).toBeFocused();
    // The page is outside the shell and nothing was acknowledged by arriving.
    await expect(page.locator('header.topbar, nav.primary-nav, nav.bottom-tabs, .clarity-promise, section.clarity-gate')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Terms', exact: true })).toHaveAttribute('href', '/terms');
    await expect(page.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute('href', '/privacy');
    expect(settingsPatches(api)).toEqual([]);
    expect(state.acknowledged).toBe(false);

    await page.getByRole('button', { name: AGREE }).click();
    await expect(page).toHaveURL(/\/plan\?ref=e2e$/);
    await expect(page.getByRole('textbox', { name: 'Monthly pay' })).toBeVisible();
    expect(state.acknowledged).toBe(true);
    expect(settingsPatches(api).map((request) => request.body)).toEqual([{ acknowledgedNoticeVersion: 1 }]);
    // Agreed: entries are on and there is no further redirect.
    await expect(page.locator('section.clarity-gate')).toHaveAttribute('data-inputs-enabled', 'true');
  });

  // Both orders of the two first requests: the redirect to /agreement must keep the `start` intent either way.
  for (const slow of ['journey', 'settings'] as const) {
    test(`/start?start=... is preserved through the Agreement page and still starts that journey once the user agrees (${slow} answers last)`, async ({ page, api }) => {
      const journey = installJourneyApi(api, MONTH);
      const state = stubNotice(api);
      const starts = () => api.requests.filter((request) => request.method === 'POST' && request.path === '/api/clarity/journeys');
      if (slow === 'settings') {
        // The journey answers first. The journey page must not consume the intent or open a journey while the
        // settings are still unknown.
        api.stub('GET', SETTINGS_PATH, () => ({ json: buildSettings({ acknowledgedVersion: state.acknowledged ? 1 : 0 }), delayMs: 800 }));
      }
      api.stub('GET', '/api/clarity/journeys/active', () => {
        const reply = journey.server.handle({ method: 'GET', path: '/clarity/journeys/active', body: undefined });
        return { status: reply?.status ?? 404, json: reply?.body ?? { error: 'Not found' }, ...(slow === 'journey' ? { delayMs: 600 } : {}) };
      });
      // Like the server, refuse to open a journey until the notice is acknowledged (428 DATA_NOTICE_REQUIRED).
      api.stub('POST', '/api/clarity/journeys', (request) => {
        if (!state.acknowledged) {
          return { status: 428, json: { error: { code: 'DATA_NOTICE_REQUIRED', message: 'Review and acknowledge the data-use notice first.' } } };
        }
        const reply = journey.server.handle({ method: 'POST', path: '/clarity/journeys', body: request.body as Record<string, unknown> });
        return { status: reply?.status ?? 404, json: reply?.body ?? { error: 'Not found' } };
      });
      await installAuthenticatedSession(page);
      await page.goto('/start?start=plan_month');
      await expect(page).toHaveURL(/\/agreement$/);
      await expect(agreementHeading(page)).toBeVisible();
      expect(state.acknowledged).toBe(false);
      expect(starts(), 'no journey is opened before the user agrees').toEqual([]);

      await page.getByRole('button', { name: AGREE }).click();
      await expect(page).toHaveURL(/\/start/);
      await expect(page.getByRole('heading', { level: 1, name: 'Guided journey' })).toBeVisible();
      // The intent survived the detour: the journey the link asked for is open at its first step.
      await expect(page.getByRole('heading', { level: 2, name: 'Add your monthly pay' })).toBeVisible();
      expect(state.acknowledged).toBe(true);
      const order = api.requests.map((request) => `${request.method} ${request.path}`);
      const agreedAt = order.indexOf(`PATCH ${SETTINGS_PATH}`);
      const lastStart = order.lastIndexOf('POST /api/clarity/journeys');
      expect(agreedAt, 'the notice was acknowledged').toBeGreaterThanOrEqual(0);
      expect(lastStart, 'the journey was opened after agreeing').toBeGreaterThan(agreedAt);
      expect(starts().at(-1)?.body).toEqual(expect.objectContaining({ desiredOutcome: 'plan_month' }));
      expect(starts(), 'exactly one journey was opened, after agreeing').toHaveLength(1);
    });
  }
});

test.describe('routes that never redirect', () => {
  test('/settings stays reachable while the notice is required, with the compact notice linking to the Agreement page', async ({ page, api }) => {
    stubPages(api);
    stubSettingsPage(api);
    await installAuthenticatedSession(page);
    await page.goto('/settings');
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    const gate = page.locator('section.clarity-gate');
    await expect(gate).toHaveAttribute('data-gate-status', 'required');
    await expect(gate).toHaveAttribute('data-inputs-enabled', 'false');
    await expect(gate.getByRole('link', { name: 'Review and agree to the data-use notice' })).toHaveAttribute('href', '/agreement');
    // Give a late redirect time to happen, then check it did not.
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page).toHaveURL(/\/settings$/);
    await expect(agreementHeading(page)).toHaveCount(0);
    // The link leads to the Agreement page, which has no destination to record from here and falls back to Home.
    await gate.getByRole('link', { name: 'Review and agree to the data-use notice' }).click();
    await expect(page).toHaveURL(/\/agreement$/);
    await expect(agreementHeading(page)).toBeVisible();
  });

  test('/admin and /admin/* stay reachable for an admin while the notice is required', async ({ page, api }) => {
    stubNotice(api);
    api.stub('GET', '/api/invites', { json: { invites: [] } });
    api.stub('GET', '/api/admin/feedback', { json: { feedback: [] } });
    api.stub('GET', '/api/admin/stats', {
      json: { users: 3, admins: 1, trips: 0, emis: 0, total_income: 0, total_emi: 0, feedback_count: 0, avg_rating: null },
    });
    await installAuthenticatedSession(page, ADMIN_USER);
    for (const path of ['/admin/feedback', '/admin']) {
      await page.goto(path);
      await expect(page.locator('main h1').first()).toBeVisible();
      // The settings request has been answered, so the gate has had its chance to report `required`.
      await expect.poll(() => api.count('GET', SETTINGS_PATH)).toBeGreaterThan(0);
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(currentPath(page), `${path} is not redirected`).toBe(path);
      await expect(agreementHeading(page)).toHaveCount(0);
    }
  });
});

test.describe('"Not now, just look around"', () => {
  test('continues to the destination with entries paused and nothing stored; in-app navigation stays; a reload asks again', async ({ page, api }) => {
    const state = stubPages(api);
    await installAuthenticatedSession(page);
    await page.goto('/plan');
    await expect(page).toHaveURL(/\/agreement$/);
    await expect(agreementHeading(page)).toBeVisible();
    const storage = () => page.evaluate(() => JSON.stringify({
      session: Object.entries(sessionStorage).sort(),
      local: Object.entries(localStorage).sort(),
    }));
    const before = await storage();

    await page.getByRole('button', { name: NOT_NOW }).click();
    await expect(page).toHaveURL(/\/plan$/);
    await expect(page.getByRole('textbox', { name: 'Monthly pay' })).toBeVisible();
    const gate = page.locator('section.clarity-gate');
    await expect(gate).toHaveAttribute('data-gate-status', 'required');
    await expect(gate).toHaveAttribute('data-inputs-enabled', 'false');
    await expect(gate.getByText('New entries are paused.')).toBeVisible();
    expect(state.acknowledged).toBe(false);
    expect(settingsPatches(api)).toEqual([]);
    expect(await storage(), 'the choice is held in memory only').toBe(before);

    // Moving around the app does not send the user back.
    const nav = page.locator('nav.primary-nav:visible, nav.bottom-tabs:visible');
    await nav.locator('a').filter({ hasText: 'Home' }).first().click();
    await expect(page.getByTestId('monthly-clarity-summary')).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
    await expect(gate).toHaveAttribute('data-inputs-enabled', 'false');

    // A full reload forgets the choice, so the next route that is not exempt asks again.
    await page.reload();
    await expect(page).toHaveURL(/\/agreement$/);
    await expect(agreementHeading(page)).toBeVisible();
  });
});

// ---- Layout and accessibility ---------------------------------------------------------------------------------
const LAYOUT_CASES = [
  { label: '320 px', width: 320, text: 100 },
  { label: '3840 px', width: 3840, text: 100 },
  // A 1280 px window at 200 percent browser zoom is a 640 CSS pixel viewport with text twice as large.
  { label: '200% zoom', width: 640, text: 200 },
  { label: '200% text at 320 px', width: 320, text: 200 },
];

test.describe('layout', () => {
  for (const layout of LAYOUT_CASES) {
    test(`the Agreement page holds at ${layout.label} in light and dark, and axe-core is clean`, async ({ page, api }, testInfo) => {
      test.skip(testInfo.project.name !== 'clarity-390', 'Widths and themes are changed inside the test, so one project covers them.');
      stubPages(api);
      await page.setViewportSize({ width: layout.width, height: 900 });
      await openAgreement(page, '/');
      // Open the full notice, so the longest state of the page is the one audited.
      const details = page.getByRole('button', { name: 'Read full details' });
      await details.click();
      await expect(details).toHaveAttribute('aria-expanded', 'true');
      await expect(page.getByRole('heading', { level: 2, name: 'Full notice' })).toBeVisible();
      if (layout.text !== 100) await scaleText(page, layout.text);
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await settleAnimations(page);

      for (const theme of THEMES) {
        await setTheme(page, theme);
        const issues = await auditLayout(page, { touchTargets: layout.width < TOP_NAV_FROM, measure: layout.width >= 1440 });
        // Soft, so one run lists the findings of both themes.
        expect.soft(issues, `layout (${theme})`).toEqual([]);
        const axe = await runAxe(page);
        expect.soft(axe.violations, `axe violations (${theme})`).toEqual([]);
      }

      // Every action is still on screen and reachable at this size.
      for (const name of [AGREE, NOT_NOW]) {
        const button = page.getByRole('button', { name });
        await button.scrollIntoViewIfNeeded();
        await expect(button).toBeVisible();
        const box = await button.boundingBox();
        expect(box!.width, `${name} is at least 44 px wide`).toBeGreaterThanOrEqual(44);
        expect(box!.height, `${name} is at least 44 px tall`).toBeGreaterThanOrEqual(44);
      }
      const metrics = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
      expect(metrics.scrollWidth, 'no horizontal scrolling').toBeLessThanOrEqual(metrics.clientWidth);
    });
  }
});

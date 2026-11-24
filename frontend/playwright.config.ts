import { defineConfig } from '@playwright/test';

const TEST_HOST = '127.0.0.1';
const TEST_PORT = 4173;
const TEST_ORIGIN = `http://${TEST_HOST}:${TEST_PORT}`;
// VITE_* flags are fixed when a Vite server starts, so the financial clarity
// flag cannot be switched per test. Specs named `*.clarity.spec.ts` run against
// a second loopback server started with the flag on; every other spec runs
// against the first one with the flag off (the legacy behavior).
const CLARITY_PORT = 4174;
const CLARITY_ORIGIN = `http://${TEST_HOST}:${CLARITY_PORT}`;
const CLARITY_SPEC = '**/*.clarity.spec.ts';
// Specs that need Quick Add on run only under playwright.quickadd.config.ts, against a server with that flag on.
const QUICK_ADD_SPEC = '**/*.quickadd.spec.ts';
const VIEWPORT_WIDTHS = [320, 360, 375, 390, 768, 820, 899, 1024, 1440, 3840] as const;
// A phone and a desktop width are enough for the flag-on flows.
const CLARITY_VIEWPORT_WIDTHS = [390, 1440] as const;
// The responsive layout acceptance spec runs on the flag-on server at every width. It has its
// own projects so the flow specs above still run only at the two widths they need.
const LAYOUT_SPEC = '**/responsive.clarity.spec.ts';
// Keyboard, focus, contrast, status text, reduced motion, and live regions (task 17.4) run at the same two widths as
// the flow specs. The keyboard sweep and the text-spacing/zoom reflow checks also run at 320, the narrowest width,
// where a 400 percent browser zoom of a 1280 px window lands (WCAG 1.4.10). Reflow is not repeated at 390: the
// layout spec already audits 200 percent text there.
const NARROW_A11Y_SPECS = ['**/a11y-keyboard.clarity.spec.ts', '**/a11y-reflow.clarity.spec.ts'];
const REFLOW_SPEC = '**/a11y-reflow.clarity.spec.ts';

const SERVER_ENV = {
  API_PROXY: 'http://127.0.0.1:1',
  VITE_API_BASE: '',
  TURSO_DATABASE_URL: '',
  TURSO_AUTH_TOKEN: '',
  JWT_SECRET: '',
};

function viteServer(port: number, clarity: boolean) {
  return {
    // Let Playwright own the actual Vite process. An npm wrapper can exit
    // without forwarding shutdown to its child, leaving the dev server alive.
    command: `node ./node_modules/vite/bin/vite.js --host ${TEST_HOST} --port ${port} --strictPort`,
    url: `http://${TEST_HOST}:${port}`,
    reuseExistingServer: false,
    timeout: 120_000,
    gracefulShutdown: { signal: 'SIGTERM' as const, timeout: 5_000 },
    env: { ...SERVER_ENV, VITE_FINANCIAL_CLARITY_ENABLED: clarity ? 'true' : 'false' },
  };
}

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results/playwright',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 2,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],
  use: {
    baseURL: TEST_ORIGIN,
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
    deviceScaleFactor: 1,
    serviceWorkers: 'block',
    colorScheme: 'light',
    reducedMotion: 'no-preference',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    ...VIEWPORT_WIDTHS.map((width) => ({
      name: `chromium-${width}`,
      testIgnore: [CLARITY_SPEC, QUICK_ADD_SPEC],
      use: {
        browserName: 'chromium' as const,
        viewport: { width, height: 900 },
      },
    })),
    ...CLARITY_VIEWPORT_WIDTHS.map((width) => ({
      name: `clarity-${width}`,
      testMatch: CLARITY_SPEC,
      testIgnore: width === 390 ? [LAYOUT_SPEC, REFLOW_SPEC] : LAYOUT_SPEC,
      use: {
        browserName: 'chromium' as const,
        baseURL: CLARITY_ORIGIN,
        viewport: { width, height: 900 },
      },
    })),
    {
      name: 'clarity-a11y-320',
      testMatch: NARROW_A11Y_SPECS,
      use: {
        browserName: 'chromium' as const,
        baseURL: CLARITY_ORIGIN,
        viewport: { width: 320, height: 900 },
      },
    },
    ...VIEWPORT_WIDTHS.map((width) => ({
      name: `clarity-layout-${width}`,
      testMatch: LAYOUT_SPEC,
      use: {
        browserName: 'chromium' as const,
        baseURL: CLARITY_ORIGIN,
        viewport: { width, height: 900 },
      },
    })),
  ],
  webServer: [viteServer(TEST_PORT, false), viteServer(CLARITY_PORT, true)],
});

import { defineConfig } from '@playwright/test';

// The permanent Quick Add end-to-end configuration. Browser specs named `*.quickadd.spec.ts` need Quick Add on. VITE_* flags
// are fixed when a Vite server starts, and the two fixed servers of playwright.config.ts have the Quick Add flag off (that
// config ignores these specs), so they run here against a third loopback server with both flags on:
//
//   npm run test:e2e:quickadd                      # all six widths
//   npm run test:e2e:quickadd -- --project=quickadd-390
//
// Every response comes from the in-memory fakes of e2e/helpers/quickAddWorld.ts. The dev server is given no reachable API
// target, no database, and no signing secret, so a request that escaped the fixtures could not reach production.
//
// The server is started here unless one is already listening on QUICK_ADD_E2E_PORT, which it then reuses. The port is a
// free loopback port: 4186 by default, outside the 4173 to 4185 range that other test runs use.
const TEST_HOST = '127.0.0.1';
const PORT = Number(process.env.QUICK_ADD_E2E_PORT ?? 4186);
const ORIGIN = `http://${TEST_HOST}:${PORT}`;
const QUICK_ADD_SPEC = '**/*.quickadd.spec.ts';
// The widths of Requirement 12.11, which Quick Add and the headline must hold from 320 through 3840 CSS pixels.
const WIDTHS = [320, 390, 768, 1024, 1440, 3840] as const;

export default defineConfig({
  testDir: './e2e',
  testMatch: QUICK_ADD_SPEC,
  outputDir: './test-results/playwright-quickadd',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  // One worker: the 100 ms response-to-paint budget is measured in the browser, and two parallel Chromium workers contend
  // for CPU enough to push a correct build past it (about 3 of 20 runs). Serial runs passed 20 of 20.
  workers: 1,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report-quickadd', open: 'never' }],
  ],
  use: {
    baseURL: ORIGIN,
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
  projects: WIDTHS.map((width) => ({
    name: `quickadd-${width}`,
    use: {
      browserName: 'chromium' as const,
      viewport: { width, height: 900 },
    },
  })),
  webServer: {
    command: `node ./node_modules/vite/bin/vite.js --host ${TEST_HOST} --port ${PORT} --strictPort`,
    url: ORIGIN,
    reuseExistingServer: true,
    timeout: 120_000,
    gracefulShutdown: { signal: 'SIGTERM' as const, timeout: 5_000 },
    env: {
      API_PROXY: 'http://127.0.0.1:1',
      VITE_API_BASE: '',
      TURSO_DATABASE_URL: '',
      TURSO_AUTH_TOKEN: '',
      JWT_SECRET: '',
      VITE_FINANCIAL_CLARITY_ENABLED: 'true',
      VITE_QUICK_ADD_ENABLED: 'true',
    },
  },
});

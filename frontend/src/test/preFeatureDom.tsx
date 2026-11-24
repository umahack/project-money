// Support for the pre-feature comparison of task 18.2.
//
// `renderPageDom` renders the whole App at one route against a transport-free fake that answers both generations of
// every read, waits until the page stops asking for data, and returns the markup of the page and of the navigation
// with React's generated ids and entrance-animation styles removed. It uses nothing that came with Quick Add, so the
// same file renders the application as it was before the feature. `src/test/fixtures/preFeatureDom.json` holds the
// markup that this file produced from the commit before the feature (Home, Spending, Settings, and the navigation,
// with the Rollout_Flag on and off, on a device clock that agrees with Asia/Kolkata and on one that does not).
// `App.quickAddRollout.test.tsx` compares today's markup, with Quick_Add_Enabled off, against that fixture.
import { screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { vi } from 'vitest';
import App from '../App';
import { FinancialClarityProvider } from '../clarity/FinancialClarityProvider';
import { MutationStatusProvider } from '../clarity/MutationStatusProvider';
import { currentMonth } from '../money';
import type { FinancialSnapshot } from '../clarity/contracts';
import type { ClaritySettings } from '../clarity/settings';
import { buildSettings } from './claritySettingsBuilder';
import { homeSnapshot } from './homeSummaryFixtures';
import { FakeJourneyServer, installJourneyFetch, type JourneyFetch } from './journeyBackend';
import { createTestUser, renderAuthenticated } from './test-utils';

export interface PreFeatureClock {
  /** The device's time zone. */
  zone: string;
  /** The instant, as an ISO string. */
  instant: string;
}

/** The device and Asia/Kolkata are in the same month. */
export const ALIGNED_CLOCK: PreFeatureClock = { zone: 'Asia/Kolkata', instant: '2026-01-15T06:30:00Z' };
/** New York reads 2025-12-31 22:00, and Asia/Kolkata reads 2026-01-01 08:30. */
export const MISALIGNED_CLOCK: PreFeatureClock = { zone: 'America/New_York', instant: '2026-01-01T03:00:00Z' };

export const PRE_FEATURE_ROUTES = ['/', '/spending', '/settings'] as const;
export type PreFeatureRoute = (typeof PRE_FEATURE_ROUTES)[number];

/** Runs `body` on a device clock fixed at `clock` (only `Date` is faked, so timers and promises still run). */
export async function withDeviceClock<T>(clock: PreFeatureClock, body: () => Promise<T>): Promise<T> {
  const hadZone = Object.prototype.hasOwnProperty.call(process.env, 'TZ');
  const previousZone = process.env.TZ;
  process.env.TZ = clock.zone;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.parse(clock.instant));
  try {
    return await body();
  } finally {
    vi.useRealTimers();
    if (hadZone) process.env.TZ = previousZone;
    else delete process.env.TZ;
  }
}

const TRIP = { id: 3, name: 'Goa weekend', destination: 'Goa', budget: 40000, start_date: null, end_date: null };
const GOAL = {
  id: 5,
  name: 'Laptop upgrade',
  target_amount: 60000,
  saved_amount: 1000,
  target_date: null,
  created_at: '2026-01-01 00:00:00',
  updated_at: '2026-01-01 00:00:00',
};

export interface PageRouteOptions {
  /** Changes the snapshot every clarity read returns (for instance to add fields a newer server sends). */
  snapshot?(snapshot: FinancialSnapshot): FinancialSnapshot;
  settings?: ClaritySettings;
}

/** Both generations of every read the pages make. The legacy and the clarity routes exist side by side. */
export function pageRoutes(month: string, options: PageRouteOptions = {}): Record<string, object> {
  const snapshot = homeSnapshot(month);
  return {
    'GET /clarity/settings': options.settings ?? buildSettings({ acknowledgedVersion: 1 }),
    'GET /finance/clarity': { schemaVersion: 1, snapshot: options.snapshot ? options.snapshot(snapshot) : snapshot },
    'GET /finance/plan': {
      income: 75000, emiTotal: 0, afterFixed: 75000,
      breakdown: { needs: 37500, wants: 22500, save: 15000 }, tips: [], month, spentThisMonth: 0,
    },
    'GET /finance/salary': { salary: { month, amount: 75000 } },
    'GET /finance/emis': { emis: [] },
    'GET /finance/expenses': { month, categories: ['Food', 'Other'], expenses: [] },
    'GET /finance/budgets': { budgets: { Food: 3000 } },
    'GET /finance/goals': { goals: [GOAL] },
    'GET /finance/streak': { current: 3, longest: 5, days_logged: 9 },
    'GET /finance/insights': { thisMonth: month, prevMonth: month, totals: { thisMonth: 0, prevMonth: 0 }, weekdayAvg: [], insights: [] },
    'GET /finance/history': { months: [] },
    'GET /trips': { trips: [TRIP] },
    'GET /invites': { invites: [] },
    'GET /public/announcement': { announcement: null },
    'GET /auth/sessions': { current_sid: 1, sessions: [] },
  };
}

/** React's generated ids and the entrance animation's inline opacity and offset differ between renders. */
export function normalizeMarkup(html: string): string {
  return html
    .replace(/:r[0-9a-z]+:/g, ':id:')
    .replace(/ style="(?:opacity|transform|will-change)[^"]*"/g, '')
    // The streak card's sparkle pulses with a continuous animation, so its scale differs between renders.
    .replace(/transform: scale\([-0-9.e]+\)/g, 'transform: scale(N)')
    // The projection's entrance animation moves and fades a block while the test is reading it.
    .replace(/opacity: [-0-9.e]+/g, 'opacity: N')
    .replace(/translateY\([-0-9.e]+px\)/g, 'translateY(Npx)')
    // The same block settles to `none` when the animation has finished.
    .replace(/transform: none/g, 'transform: translateY(Npx)');
}

export interface PageDom {
  page: string;
  /** Every `nav` element of the page, in document order. */
  navigation: string;
  fetches: JourneyFetch;
}

export interface RenderPageOptions extends PageRouteOptions {
  /** Wraps the App as `main.tsx` does. The pre-feature application had nothing to add. */
  wrap?(app: ReactElement): ReactElement;
  /** Routes that replace or add to the defaults, as `METHOD /path`. */
  extraRoutes?: Record<string, object>;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Renders `route` signed in and waits until its reads have finished and nothing is loading. */
export async function renderPageDom(route: string, options: RenderPageOptions = {}): Promise<PageDom & { unmount(): void }> {
  const fetches = installJourneyFetch(new FakeJourneyServer(), { ...pageRoutes(currentMonth(), options), ...options.extraRoutes });
  const app = (
    <FinancialClarityProvider>
      <MutationStatusProvider>
        <App />
      </MutationStatusProvider>
    </FinancialClarityProvider>
  );
  const view = renderAuthenticated(options.wrap ? options.wrap(app) : app, { route, user: createTestUser({ name: 'Test User' }) });
  await screen.findByRole('navigation', { name: 'Primary' });
  let previous = -1;
  let stable = 0;
  for (let attempt = 0; attempt < 100 && stable < 4; attempt += 1) {
    await pause(40);
    const count = fetches.calls.length;
    stable = count === previous && !document.querySelector('[aria-busy="true"]') && !screen.queryByText(/Loading/) ? stable + 1 : 0;
    previous = count;
  }
  return {
    page: normalizeMarkup(document.body.innerHTML),
    navigation: normalizeMarkup(Array.from(document.querySelectorAll('nav')).map((node) => node.outerHTML).join('\n')),
    fetches,
    unmount: view.unmount,
  };
}

export interface PreFeatureEntry {
  page: string;
  navigation: string;
}
export type PreFeatureFixture = Record<string, PreFeatureEntry>;

/** The key of one page under one rollout flag and one device clock. */
export function fixtureKey(clockName: 'aligned' | 'misaligned', rollout: boolean, route: string): string {
  return `${clockName}|rollout-${rollout ? 'on' : 'off'}|${route}`;
}

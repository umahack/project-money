import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import * as axeMatchers from 'vitest-axe/matchers';
import { resetFirstOutcomeReports } from '../components/journey/useFirstOutcomeReport';

expect.extend(axeMatchers);

beforeEach(() => {
  resetFirstOutcomeReports();
  sessionStorage.clear();
  localStorage.clear();

  // Tests must opt in to each response. An accidental request can never reach
  // the configured API host or use a developer's authenticated session.
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(() => Promise.reject(new Error('Unexpected network request in frontend test'))),
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  sessionStorage.clear();
  localStorage.clear();
});

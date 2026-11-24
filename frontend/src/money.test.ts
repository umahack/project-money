import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerTimeOffset, observeServerTime } from './clarity/quickAdd/kolkata';
import { withProcessTimeZone } from './test/kolkataReference';
import { currentMonth } from './money';

// 2025-03-31 20:00 UTC is 2025-04-01 01:30 in Asia/Kolkata and 2025-03-31 13:00 in Los Angeles.
const INSTANT = Date.parse('2025-03-31T20:00:00Z');

describe('currentMonth', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(INSTANT);
    resetServerTimeOffset();
  });
  afterEach(() => resetServerTimeOffset());

  it('returns the Kolkata month while the Rollout_Flag is on', () => {
    vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'true');
    withProcessTimeZone('America/Los_Angeles', () => {
      expect(currentMonth()).toBe('2025-04');
    });
  });

  it('keeps the device-clock month while the Rollout_Flag is off', () => {
    vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', '');
    withProcessTimeZone('America/Los_Angeles', () => {
      expect(currentMonth()).toBe('2025-03');
    });
    withProcessTimeZone('Asia/Kolkata', () => {
      expect(currentMonth()).toBe('2025-04');
    });
  });

  it('does not apply an observed server offset while the Rollout_Flag is off', () => {
    vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', '0');
    observeServerTime('2025-05-10T00:00:00Z');
    withProcessTimeZone('America/Los_Angeles', () => {
      expect(currentMonth()).toBe('2025-03');
    });
  });

  it('applies an observed server offset while the Rollout_Flag is on', () => {
    vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', '1');
    observeServerTime('2025-05-10T00:00:00Z');
    expect(currentMonth()).toBe('2025-05');
  });
});

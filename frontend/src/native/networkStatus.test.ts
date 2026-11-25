import { describe, expect, it, vi } from 'vitest';
import { ApiError, REQUEST_TIMEOUT_CODE } from '../api';
import {
  COLD_START_HINT_DELAY_MS,
  MESSAGE_GENERIC,
  MESSAGE_TIMEOUT,
  MESSAGE_UNREACHABLE,
  describeFetchFailure,
  getOnlineStatusSnapshot,
  shouldShowStaleDataNotice,
  subscribeOnlineStatus,
} from './networkStatus';

describe('networkStatus', () => {
  it('waits 5 seconds before the cold-start hint (Requirement 7.6)', () => {
    expect(COLD_START_HINT_DELAY_MS).toBe(5000);
  });

  it('notifies subscribers on online and offline events and stops after unsubscribe (Requirement 7.2)', () => {
    const callback = vi.fn();
    const unsubscribe = subscribeOnlineStatus(callback);
    window.dispatchEvent(new Event('offline'));
    window.dispatchEvent(new Event('online'));
    expect(callback).toHaveBeenCalledTimes(2);
    unsubscribe();
    window.dispatchEvent(new Event('offline'));
    window.dispatchEvent(new Event('online'));
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it('reads the current online state from navigator.onLine', () => {
    const onLine = vi.spyOn(window.navigator, 'onLine', 'get');
    onLine.mockReturnValue(false);
    expect(getOnlineStatusSnapshot()).toBe(false);
    onLine.mockReturnValue(true);
    expect(getOnlineStatusSnapshot()).toBe(true);
  });

  it('maps representative failures to the three fixed messages (Requirement 7.5)', () => {
    expect(describeFetchFailure(new ApiError(0, 'timed out', { code: REQUEST_TIMEOUT_CODE }))).toBe(MESSAGE_TIMEOUT);
    expect(describeFetchFailure(new TypeError('Failed to fetch'))).toBe(MESSAGE_UNREACHABLE);
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    expect(describeFetchFailure(abort)).toBe(MESSAGE_UNREACHABLE);
    for (const status of [502, 503, 504]) {
      expect(describeFetchFailure(new ApiError(status, 'Bad gateway'))).toBe(MESSAGE_UNREACHABLE);
    }
    expect(describeFetchFailure(new ApiError(500, 'boom'))).toBe(MESSAGE_GENERIC);
    expect(describeFetchFailure(new Error('boom'))).toBe(MESSAGE_GENERIC);
    expect(describeFetchFailure('boom')).toBe(MESSAGE_GENERIC);
  });

  it('flags old figures only when data is on screen and the device is offline or the refresh failed (Requirement 7.7)', () => {
    expect(shouldShowStaleDataNotice({ isOffline: true, lastFetchFailed: false, hasData: true })).toBe(true);
    expect(shouldShowStaleDataNotice({ isOffline: false, lastFetchFailed: true, hasData: true })).toBe(true);
    expect(shouldShowStaleDataNotice({ isOffline: false, lastFetchFailed: false, hasData: true })).toBe(false);
    expect(shouldShowStaleDataNotice({ isOffline: true, lastFetchFailed: true, hasData: false })).toBe(false);
  });
});

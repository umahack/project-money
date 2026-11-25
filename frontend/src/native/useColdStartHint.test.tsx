import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { COLD_START_HINT_DELAY_MS } from './networkStatus';
import { useColdStartHint } from './useColdStartHint';

describe('useColdStartHint', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('is false before 5000 ms and true at 5000 ms of continuous pending (Requirement 7.6)', () => {
    const { result } = renderHook(({ pending }) => useColdStartHint(pending), { initialProps: { pending: true } });
    expect(result.current).toBe(false);
    act(() => { vi.advanceTimersByTime(COLD_START_HINT_DELAY_MS - 1); });
    expect(result.current).toBe(false);
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current).toBe(true);
  });

  it('never shows while nothing is pending', () => {
    const { result } = renderHook(() => useColdStartHint(false));
    act(() => { vi.advanceTimersByTime(COLD_START_HINT_DELAY_MS * 3); });
    expect(result.current).toBe(false);
  });

  it('resets when pending ends and restarts the 5 second wait when it begins again', () => {
    const { result, rerender } = renderHook(({ pending }) => useColdStartHint(pending), {
      initialProps: { pending: true },
    });
    act(() => { vi.advanceTimersByTime(COLD_START_HINT_DELAY_MS); });
    expect(result.current).toBe(true);

    rerender({ pending: false });
    expect(result.current).toBe(false);

    rerender({ pending: true });
    expect(result.current).toBe(false);
    act(() => { vi.advanceTimersByTime(COLD_START_HINT_DELAY_MS - 1); });
    expect(result.current).toBe(false);
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current).toBe(true);
  });

  it('does not show when the request finishes before 5 seconds', () => {
    const { result, rerender } = renderHook(({ pending }) => useColdStartHint(pending), {
      initialProps: { pending: true },
    });
    act(() => { vi.advanceTimersByTime(COLD_START_HINT_DELAY_MS - 1000); });
    rerender({ pending: false });
    act(() => { vi.advanceTimersByTime(COLD_START_HINT_DELAY_MS * 2); });
    expect(result.current).toBe(false);
  });
});

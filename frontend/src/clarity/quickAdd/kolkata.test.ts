import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { kolkataDateOf, kolkataMonthOf, withProcessTimeZone } from '../../test/kolkataReference';
import {
  KOLKATA_REEVALUATE_MS,
  getServerTimeOffsetMs,
  kolkataMonth,
  kolkataNow,
  kolkataToday,
  observeResponseTime,
  observeServerTime,
  resetServerTimeOffset,
  useKolkataMonth,
  useKolkataToday,
} from './kolkata';

const at = (iso: string): number => Date.parse(iso);

beforeEach(() => resetServerTimeOffset());
afterEach(() => resetServerTimeOffset());

describe('kolkataToday and kolkataMonth', () => {
  it.each([
    ['2025-03-04T18:29:59.999Z', '2025-03-04'],
    ['2025-03-04T18:30:00.000Z', '2025-03-05'],
    ['2025-03-04T00:00:00.000Z', '2025-03-04'],
    ['2025-01-31T18:29:59.999Z', '2025-01-31'],
    ['2025-01-31T18:30:00.000Z', '2025-02-01'],
    ['2024-12-31T18:30:00.000Z', '2025-01-01'],
    ['2024-02-28T18:30:00.000Z', '2024-02-29'],
    ['2024-02-29T18:29:59.999Z', '2024-02-29'],
    ['2024-02-29T18:30:00.000Z', '2024-03-01'],
    ['2023-02-28T18:30:00.000Z', '2023-03-01'],
    ['2000-02-29T12:00:00.000Z', '2000-02-29'],
    ['2100-02-28T18:30:00.000Z', '2100-03-01'],
  ])('names %s as Kolkata date %s', (iso, date) => {
    expect(kolkataToday(at(iso))).toBe(date);
    expect(kolkataMonth(at(iso))).toBe(date.slice(0, 7));
  });

  it('agrees with Intl for Asia/Kolkata under several process time zones', () => {
    const instants = [
      '2025-03-04T18:29:59.999Z',
      '2025-03-04T18:30:00.000Z',
      '2024-02-29T18:30:00.000Z',
      '2025-12-31T18:30:00.000Z',
      '2025-06-15T12:00:00.000Z',
    ].map(at);
    for (const zone of ['UTC', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Asia/Kolkata']) {
      withProcessTimeZone(zone, () => {
        for (const instant of instants) {
          expect(kolkataToday(instant)).toBe(kolkataDateOf(instant));
          expect(kolkataMonth(instant)).toBe(kolkataMonthOf(instant));
        }
      });
    }
  });

  it('rejects an instant that is not a valid time', () => {
    expect(() => kolkataToday(Number.NaN)).toThrow(RangeError);
    expect(() => kolkataMonth(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('observeServerTime', () => {
  beforeEach(() => vi.useFakeTimers());

  it('uses the device clock until a server time is seen', () => {
    vi.setSystemTime(at('2025-03-04T18:00:00Z'));
    expect(getServerTimeOffsetMs()).toBe(0);
    expect(kolkataNow()).toBe(Date.now());
  });

  it('corrects a device clock that is behind the server and moves the day', () => {
    vi.setSystemTime(at('2025-03-04T15:00:00Z'));
    expect(kolkataToday()).toBe('2025-03-04');

    expect(observeServerTime('2025-03-04T18:45:00.000Z')).toBe(true);

    expect(getServerTimeOffsetMs()).toBe(3 * 3_600_000 + 45 * 60_000);
    expect(kolkataNow()).toBe(at('2025-03-04T18:45:00.000Z'));
    expect(kolkataToday()).toBe('2025-03-05');
    expect(kolkataMonth()).toBe('2025-03');
  });

  it('corrects a device clock that is ahead of the server and moves the month back', () => {
    vi.setSystemTime(at('2025-04-01T00:10:00Z'));
    expect(kolkataMonth()).toBe('2025-04');

    observeServerTime('2025-03-31T10:00:00.000Z');

    expect(kolkataMonth()).toBe('2025-03');
    expect(kolkataToday()).toBe('2025-03-31');
  });

  it('keeps the offset as the device clock advances', () => {
    vi.setSystemTime(at('2025-03-04T15:00:00Z'));
    observeServerTime('2025-03-04T18:00:00.000Z');
    vi.advanceTimersByTime(40 * 60_000);
    expect(kolkataToday()).toBe('2025-03-05');
  });

  it('accepts a server time given as a Date, epoch milliseconds, or HTTP date', () => {
    vi.setSystemTime(at('2025-03-04T00:00:00Z'));
    expect(observeServerTime(new Date('2025-03-04T01:00:00Z'))).toBe(true);
    expect(getServerTimeOffsetMs()).toBe(3_600_000);
    expect(observeServerTime(at('2025-03-04T02:00:00Z'))).toBe(true);
    expect(getServerTimeOffsetMs()).toBe(7_200_000);
    expect(observeServerTime('Tue, 04 Mar 2025 03:00:00 GMT')).toBe(true);
    expect(getServerTimeOffsetMs()).toBe(10_800_000);
  });

  it('uses the supplied receive time instead of the current device time', () => {
    vi.setSystemTime(at('2025-03-04T10:00:00Z'));
    observeServerTime('2025-03-04T10:00:05Z', at('2025-03-04T10:00:00Z'));
    expect(getServerTimeOffsetMs()).toBe(5_000);
  });

  it('ignores a value that is not a time and keeps the earlier offset', () => {
    vi.setSystemTime(at('2025-03-04T00:00:00Z'));
    observeServerTime('2025-03-04T01:00:00Z');
    for (const bad of [undefined, null, '', '   ', 'not a date', Number.NaN, new Date('x')]) {
      expect(observeServerTime(bad)).toBe(false);
    }
    expect(getServerTimeOffsetMs()).toBe(3_600_000);
  });

  it('reads generatedAt from a snapshot response before the Date header', () => {
    vi.setSystemTime(at('2025-03-04T00:00:00Z'));
    const body = { schemaVersion: 1, snapshot: { generatedAt: '2025-03-04T02:00:00.000Z' } };
    expect(observeResponseTime('Tue, 04 Mar 2025 05:00:00 GMT', body)).toBe(true);
    expect(getServerTimeOffsetMs()).toBe(7_200_000);
  });

  it('falls back to the Date header when the body has no generatedAt', () => {
    vi.setSystemTime(at('2025-03-04T00:00:00Z'));
    expect(observeResponseTime('Tue, 04 Mar 2025 01:00:00 GMT', { ok: true })).toBe(true);
    expect(getServerTimeOffsetMs()).toBe(3_600_000);
    expect(observeResponseTime(null, null)).toBe(false);
    expect(getServerTimeOffsetMs()).toBe(3_600_000);
  });

  it('resets to the device clock', () => {
    vi.setSystemTime(at('2025-03-04T00:00:00Z'));
    observeServerTime('2025-03-04T05:00:00Z');
    resetServerTimeOffset();
    expect(getServerTimeOffsetMs()).toBe(0);
  });
});

describe('Kolkata hooks', () => {
  beforeEach(() => vi.useFakeTimers());

  it('re-evaluates every 30 seconds and re-keys the date and month at midnight', () => {
    vi.setSystemTime(at('2025-01-31T18:29:50.000Z'));
    const today = renderHook(() => useKolkataToday());
    const month = renderHook(() => useKolkataMonth());
    expect(today.result.current).toBe('2025-01-31');
    expect(month.result.current).toBe('2025-01');

    act(() => { vi.advanceTimersByTime(KOLKATA_REEVALUATE_MS); });

    expect(today.result.current).toBe('2025-02-01');
    expect(month.result.current).toBe('2025-02');
  });

  it('does not re-render when the date has not changed', () => {
    vi.setSystemTime(at('2025-03-04T06:00:00.000Z'));
    let renders = 0;
    const { result } = renderHook(() => { renders += 1; return useKolkataToday(); });
    const before = renders;

    act(() => { vi.advanceTimersByTime(KOLKATA_REEVALUATE_MS * 3); });

    expect(result.current).toBe('2025-03-04');
    expect(renders).toBe(before);
  });

  it('re-evaluates when the page becomes visible', () => {
    vi.setSystemTime(at('2025-03-04T18:00:00.000Z'));
    const { result } = renderHook(() => useKolkataToday());
    expect(result.current).toBe('2025-03-04');

    // The device was asleep, so no timer ran. Only the visibility event can refresh the value.
    vi.setSystemTime(at('2025-03-04T19:00:00.000Z'));
    expect(result.current).toBe('2025-03-04');
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });

    expect(result.current).toBe('2025-03-05');
  });

  it('follows a newly observed server time without waiting for the timer', () => {
    vi.setSystemTime(at('2025-03-04T15:00:00.000Z'));
    const { result } = renderHook(() => useKolkataToday());
    expect(result.current).toBe('2025-03-04');

    act(() => { observeServerTime('2025-03-04T18:45:00.000Z'); });

    expect(result.current).toBe('2025-03-05');
  });

  it('stops its timer when the last hook unmounts', () => {
    const first = renderHook(() => useKolkataToday());
    const second = renderHook(() => useKolkataMonth());
    expect(vi.getTimerCount()).toBe(1);
    first.unmount();
    expect(vi.getTimerCount()).toBe(1);
    second.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { usePolling, usePollingTick, useLastRefresh } from './usePolling';
import { resetPollingClock } from '../lib/pollingClock';

describe('usePolling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-06T10:00:10Z'));
  });

  afterEach(() => {
    resetPollingClock();
    vi.useRealTimers();
  });

  test('runs now, then on the shared clock, and stops on unmount', () => {
    const fetch = vi.fn();
    const { unmount } = renderHook(() => usePolling(fetch, 30000));
    expect(fetch).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(20000)); // 10:00:30
    expect(fetch).toHaveBeenCalledTimes(2);
    unmount();
    act(() => vi.advanceTimersByTime(60000));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test('a new fetch function (changed dependencies) runs again immediately', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ fn }) => usePolling(fn, 30000), { initialProps: { fn: first } });
    rerender({ fn: second });
    expect(second).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(20000));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
  });

  test('disabled polling does nothing', () => {
    const fetch = vi.fn();
    renderHook(() => usePolling(fetch, 30000, false));
    act(() => vi.advanceTimersByTime(60000));
    expect(fetch).not.toHaveBeenCalled();
  });

  test('usePollingTick only runs on the clock and always calls the latest function', () => {
    const calls = [];
    const { rerender } = renderHook(({ label }) => usePollingTick(() => calls.push(label), 30000), {
      initialProps: { label: 'a' },
    });
    expect(calls).toEqual([]);
    rerender({ label: 'b' });
    act(() => vi.advanceTimersByTime(20000));
    expect(calls).toEqual(['b']);
  });

  test('usePollingTick does nothing while disabled (auto-refresh off)', () => {
    const fn = vi.fn();
    renderHook(() => usePollingTick(fn, 30000, false));
    act(() => vi.advanceTimersByTime(60000));
    expect(fn).not.toHaveBeenCalled();
  });

  test('useLastRefresh follows the clock', () => {
    const { result } = renderHook(() => {
      usePolling(vi.fn(), 30000);
      return useLastRefresh();
    });
    expect(result.current).toBe(Date.parse('2026-11-06T10:00:10Z'));
    act(() => vi.advanceTimersByTime(20000));
    expect(result.current).toBe(Date.parse('2026-11-06T10:00:30Z'));
  });
});

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { subscribe, markRefreshed, getLastRefresh, onRefresh, resetPollingClock } from './pollingClock';

function setVisibility(state) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('pollingClock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-06T10:00:10Z'));
    setVisibility('visible');
  });

  afterEach(() => {
    resetPollingClock();
    vi.useRealTimers();
  });

  test('fires on wall-clock-aligned boundaries, not immediately', () => {
    const fn = vi.fn();
    subscribe(30000, fn);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(19000); // 10:00:29
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000); // 10:00:30
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30000); // 10:01:00
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('subscribers with the same interval refresh on the same tick', () => {
    const a = vi.fn();
    subscribe(30000, a);
    vi.advanceTimersByTime(7000); // second subscriber joins mid-period
    const b = vi.fn();
    subscribe(30000, b);
    vi.advanceTimersByTime(13000); // 10:00:30
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  test('pauses while hidden and catches up once when visible again', () => {
    const fn = vi.fn();
    subscribe(30000, fn);
    setVisibility('hidden');
    vi.advanceTimersByTime(120000);
    expect(fn).not.toHaveBeenCalled();
    setVisibility('visible');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('unsubscribe stops calls', () => {
    const fn = vi.fn();
    const unsubscribe = subscribe(30000, fn);
    unsubscribe();
    vi.advanceTimersByTime(60000);
    expect(fn).not.toHaveBeenCalled();
  });

  test('one failing subscriber does not stop the others', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ok = vi.fn();
    subscribe(30000, () => {
      throw new Error('boom');
    });
    subscribe(30000, ok);
    vi.advanceTimersByTime(20000);
    expect(ok).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  test('records the last refresh and notifies listeners', () => {
    const listener = vi.fn();
    onRefresh(listener);
    expect(getLastRefresh()).toBeNull();
    markRefreshed(1234);
    expect(getLastRefresh()).toBe(1234);
    subscribe(30000, () => {});
    vi.advanceTimersByTime(20000);
    expect(getLastRefresh()).toBe(Date.parse('2026-11-06T10:00:30Z'));
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

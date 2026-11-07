import { describe, test, expect, vi, afterEach, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import axios from 'axios';
import { useTopologyHistory } from './useTopologyHistory';

vi.mock('axios', () => ({ default: { get: vi.fn() } }));

const httpError = (status, error) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data: error ? { error } : {} } });
const EVENTS = { history: { samples: 30, from: 1000, to: 4600, intervalSeconds: 120 }, events: [{ type: 'node-added', node: 'n2' }] };

function route({ events = EVENTS, snapshot } = {}) {
  axios.get.mockImplementation((url, opts) => {
    if (url.endsWith('/api/v1/topology/events')) return events instanceof Error ? Promise.reject(events) : Promise.resolve({ data: events });
    if (url.endsWith('/api/v1/topology/history')) {
      const r = typeof snapshot === 'function' ? snapshot(opts.params.at) : snapshot;
      return r instanceof Error ? Promise.reject(r) : Promise.resolve({ data: r });
    }
    return Promise.reject(new Error(`unexpected ${url}`));
  });
}

const params = () => Object.fromEntries(new URLSearchParams(window.location.search));

describe('useTopologyHistory', () => {
  beforeEach(() => window.history.replaceState(null, '', '/?tab=topology'));
  afterEach(() => vi.clearAllMocks());

  test('stays closed and fetches nothing on the live view', () => {
    route();
    const { result } = renderHook(() => useTopologyHistory());
    expect(result.current.open).toBe(false);
    expect(result.current.at).toBeNull();
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('opening loads the timeline once; replay fetches the snapshot for ?at=', async () => {
    route({ snapshot: (at) => ({ at: at - 30, nodes: [{ name: 'old' }] }) });
    const { result } = renderHook(() => useTopologyHistory());
    act(() => result.current.setOpen(true));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.range).toEqual(EVENTS.history);
    expect(result.current.events).toHaveLength(1);

    act(() => result.current.setAt(2000));
    expect(params().at).toBe('2000');
    expect(result.current.replay.loading).toBe(true);
    await waitFor(() => expect(result.current.replay.nodes).toEqual([{ name: 'old' }]));
    expect(result.current.replay.at).toBe(1970);
    expect(axios.get).toHaveBeenCalledTimes(2);

    // Switching to compare clears ?at= and loads the baseline instead.
    act(() => result.current.setCompare(3000));
    expect(params()).toEqual(expect.objectContaining({ compare: '3000' }));
    expect(params().at).toBeUndefined();
    await waitFor(() => expect(result.current.baseline.nodes).toEqual([{ name: 'old' }]));
    expect(result.current.replay.nodes).toBeNull();

    act(() => result.current.backToLive());
    expect(params().compare).toBeUndefined();
    act(() => result.current.close());
    expect(result.current.open).toBe(false);
  });

  test('a URL with ?compare= opens time travel; ?at= wins over ?compare=', async () => {
    window.history.replaceState(null, '', '/?compare=1500');
    route({ snapshot: { at: 1500, nodes: [] } });
    const { result } = renderHook(() => useTopologyHistory());
    expect(result.current.open).toBe(true);
    expect(result.current.compare).toBe(1500);
    await waitFor(() => expect(result.current.baseline.nodes).toEqual([]));

    window.history.replaceState(null, '', '/?at=1200&compare=1500');
    const second = renderHook(() => useTopologyHistory());
    expect(second.result.current.at).toBe(1200);
    expect(second.result.current.compare).toBeNull();
    await waitFor(() => expect(second.result.current.replay.nodes).toEqual([]));
  });

  test('older or disabled backends mark history unavailable; other errors are shown', async () => {
    for (const status of [404, 503]) {
      route({ events: httpError(status) });
      const { result } = renderHook(() => useTopologyHistory());
      act(() => result.current.setOpen(true));
      await waitFor(() => expect(result.current.loaded).toBe(true));
      expect(result.current.available).toBe(false);
      expect(result.current.error).toBeNull();
    }
    route({ events: httpError(500, 'boom') });
    const { result } = renderHook(() => useTopologyHistory());
    act(() => result.current.setOpen(true));
    await waitFor(() => expect(result.current.error).toBe('boom'));
    expect(result.current.available).toBe(true);
  });

  test('defaults missing fields; a failed snapshot reports its error', async () => {
    route({ events: {}, snapshot: httpError(404, 'no placement sample at or before that time') });
    window.history.replaceState(null, '', '/?at=5');
    const { result } = renderHook(() => useTopologyHistory());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.range).toBeNull();
    expect(result.current.events).toEqual([]);
    await waitFor(() => expect(result.current.replay.error).toBe('no placement sample at or before that time'));

    route({ snapshot: {} });
    act(() => result.current.setAt(6));
    await waitFor(() => expect(result.current.replay.nodes).toEqual([]));
    route({ snapshot: new Error('offline') });
    act(() => result.current.setAt(7));
    await waitFor(() => expect(result.current.replay.error).toBe('offline'));
    act(() => result.current.setAt(null));
    expect(result.current.replay).toEqual({ at: null, nodes: null, loading: false, error: null });
  });

  test('dragging sends one request, for the time the scrubber settled on', async () => {
    vi.useFakeTimers();
    try {
      route({ snapshot: (at) => ({ at, nodes: [{ name: `n${at}` }] }) });
      const { result } = renderHook(() => useTopologyHistory());
      act(() => result.current.setAt(2000));
      act(() => result.current.setAt(2100));
      act(() => result.current.setAt(2200));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      const historyCalls = axios.get.mock.calls.filter(([url]) => url.endsWith('/topology/history'));
      expect(historyCalls).toHaveLength(1);
      expect(historyCalls[0][1].params.at).toBe(2200);
      expect(result.current.replay.nodes).toEqual([{ name: 'n2200' }]);
    } finally {
      vi.useRealTimers();
    }
  });
});

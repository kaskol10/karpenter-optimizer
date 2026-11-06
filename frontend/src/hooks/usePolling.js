import { useEffect, useRef, useSyncExternalStore } from 'react';
import { getLastRefresh, markRefreshed, onRefresh, subscribe } from '../lib/pollingClock';

// usePolling runs fetchFn now and then on the shared polling clock every
// intervalMs. fetchFn must be stable (useCallback): when it changes (e.g. a
// window selector changed its dependencies), it runs again immediately.
export function usePolling(fetchFn, intervalMs, enabled = true) {
  useEffect(() => {
    if (!enabled) return undefined;
    markRefreshed();
    fetchFn();
    return subscribe(intervalMs, fetchFn);
  }, [fetchFn, intervalMs, enabled]);
}

// usePollingTick runs fn on the shared clock only (no immediate call), for
// panels that do their own initial load and offer an auto-refresh toggle.
// fn may change on every render; the latest one is always called.
export function usePollingTick(fn, intervalMs, enabled = true) {
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  });
  useEffect(() => {
    if (!enabled) return undefined;
    return subscribe(intervalMs, () => fnRef.current());
  }, [intervalMs, enabled]);
}

// useLastRefresh returns the epoch ms of the most recent refresh on the
// shared clock (null before the first), for the header's "Updated" label.
export function useLastRefresh() {
  // The app is client-rendered only; the server snapshot is the same getter.
  return useSyncExternalStore(onRefresh, getLastRefresh, getLastRefresh);
}

// One clock for every polling panel.
//
// Before this, each panel ran its own setInterval, started whenever it
// mounted, so the Serving pods, gateway and trends all showed slightly
// different moments. Subscribers here fire on wall-clock-aligned boundaries of
// their interval (every 30s subscriber on :00 and :30), so panels with the same
// interval refresh together. Polling pauses while the browser tab is hidden and
// catches up once, immediately, when it becomes visible again.

const TICK_MS = 1000;

const subscribers = new Set(); // { intervalMs, fn, nextAt }
const refreshListeners = new Set();
let timer = null;
let lastRefreshAt = null;
let visibilityBound = false;

function isHidden() {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

// nextBoundary returns the first multiple of intervalMs strictly after now.
function nextBoundary(now, intervalMs) {
  return (Math.floor(now / intervalMs) + 1) * intervalMs;
}

function setLastRefresh(at) {
  lastRefreshAt = at;
  refreshListeners.forEach((listener) => listener(at));
}

function runDue(now) {
  let fired = false;
  subscribers.forEach((sub) => {
    if (now >= sub.nextAt) {
      sub.nextAt = nextBoundary(now, sub.intervalMs);
      fired = true;
      try {
        sub.fn();
      } catch (err) {
        // A failing poller must not stop the others.
        // eslint-disable-next-line no-console
        console.error('[polling] subscriber failed:', err);
      }
    }
  });
  if (fired) setLastRefresh(now);
}

function tick() {
  if (isHidden()) return;
  runDue(Date.now());
}

function onVisibilityChange() {
  if (!isHidden()) runDue(Date.now());
}

function start() {
  if (timer === null) timer = setInterval(tick, TICK_MS);
  if (!visibilityBound && typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange);
    visibilityBound = true;
  }
}

function stop() {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  if (visibilityBound) {
    document.removeEventListener('visibilitychange', onVisibilityChange);
    visibilityBound = false;
  }
}

// subscribe calls fn on every aligned boundary of intervalMs (not immediately)
// and returns an unsubscribe function.
export function subscribe(intervalMs, fn) {
  const interval = Math.max(TICK_MS, Math.round(intervalMs));
  const sub = { intervalMs: interval, fn, nextAt: nextBoundary(Date.now(), interval) };
  subscribers.add(sub);
  start();
  return () => {
    subscribers.delete(sub);
    if (subscribers.size === 0) stop();
  };
}

// markRefreshed records an out-of-band refresh (a panel's initial load or a
// manual refresh) so the "Updated" time in the header reflects it.
export function markRefreshed(at = Date.now()) {
  setLastRefresh(at);
}

export function getLastRefresh() {
  return lastRefreshAt;
}

export function onRefresh(listener) {
  refreshListeners.add(listener);
  return () => refreshListeners.delete(listener);
}

// Test helper: drop all subscribers and state.
export function resetPollingClock() {
  subscribers.clear();
  refreshListeners.clear();
  lastRefreshAt = null;
  stop();
}

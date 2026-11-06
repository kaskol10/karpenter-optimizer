import { useCallback, useState } from 'react';

// readUrlParam returns the query param's value, or fallback when it is absent
// or (when allowed is given) not one of the allowed values.
export function readUrlParam(key, fallback, allowed) {
  const value = new URLSearchParams(window.location.search).get(key);
  if (value === null) return fallback;
  if (allowed && !allowed.includes(value)) return fallback;
  return value;
}

// writeUrlParam sets (or, when equal to fallback or empty, removes) one query
// param in place, keeping every other param and the current history state.
// It replaces the current entry instead of pushing, so typing in a filter
// does not fill the Back button with one entry per keystroke.
export function writeUrlParam(key, value, fallback) {
  const params = new URLSearchParams(window.location.search);
  if (value === fallback || value === '' || value === null || value === undefined) {
    params.delete(key);
  } else {
    params.set(key, String(value));
  }
  const search = params.toString();
  const url = `${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`;
  window.history.replaceState(window.history.state, '', url);
}

// useUrlParam is useState backed by a URL query param, so a view's filters
// survive a refresh and travel with a shared link. Values are strings. Pass
// `allowed` for a closed set (a select's options) so a hand-edited or stale
// URL falls back to the default instead of an invalid value.
export function useUrlParam(key, fallback = '', allowed = undefined) {
  const [value, setValue] = useState(() => readUrlParam(key, fallback, allowed));
  const update = useCallback(
    (next) => {
      setValue((prev) => {
        const resolved = typeof next === 'function' ? next(prev) : next;
        writeUrlParam(key, resolved, fallback);
        return resolved;
      });
    },
    [key, fallback],
  );
  return [value, update];
}

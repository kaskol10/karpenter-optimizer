import { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { API_URL } from '../lib/api';
import { parseAtParam } from '../lib/topologyHistory';
import { useUrlParam } from './useUrlParam';
import { usePollingTick } from './usePolling';

const DEBOUNCE_MS = 250;
// The timeline grows by one sample every couple of minutes; refresh it on
// the shared clock while time travel is open.
const TIMELINE_REFRESH_MS = 120000;

const errorText = (err) => err.response?.data?.error || err.message || 'Failed to load history';

// fetchSnapshot debounces /topology/history for one URL time so dragging the
// scrubber sends one request when it settles, and drops stale answers.
function useSnapshot(at) {
  const [state, setState] = useState({ at: null, nodes: null, loading: false, error: null });
  const seq = useRef(0);
  useEffect(() => {
    const id = ++seq.current;
    if (!at) {
      setState({ at: null, nodes: null, loading: false, error: null });
      return undefined;
    }
    setState((s) => ({ ...s, loading: true, error: null }));
    const timer = setTimeout(() => {
      axios
        .get(`${API_URL}/api/v1/topology/history`, { params: { at } })
        .then(({ data }) => {
          if (id === seq.current) setState({ at: data.at, nodes: data.nodes || [], loading: false, error: null });
        })
        .catch((err) => {
          if (id === seq.current) setState({ at: null, nodes: null, loading: false, error: errorText(err) });
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [at]);
  return state;
}

// useTopologyHistory drives Topology time travel. `?at=` (Unix seconds)
// replays the cluster at that moment; `?compare=` diffs the live view
// against that moment. The timeline (range + events) is fetched only once
// time travel is opened or a URL asks for it, so the live view costs no
// extra request. `available` is false when the backend has no history
// (older backend: 404, disabled: 503).
export function useTopologyHistory() {
  const [atParam, setAtParam] = useUrlParam('at');
  const [compareParam, setCompareParam] = useUrlParam('compare');
  const at = parseAtParam(atParam);
  const compare = at ? null : parseAtParam(compareParam);
  const [open, setOpen] = useState(Boolean(at || compare));
  const [timeline, setTimeline] = useState({ loaded: false, available: true, range: null, events: [], error: null });

  const loadTimeline = useCallback(async () => {
    try {
      const { data } = await axios.get(`${API_URL}/api/v1/topology/events`);
      setTimeline({ loaded: true, available: true, range: data.history || null, events: data.events || [], error: null });
    } catch (err) {
      const status = err.response?.status;
      setTimeline({
        loaded: true,
        available: !(status === 404 || status === 503),
        range: null,
        events: [],
        error: status === 404 || status === 503 ? null : errorText(err),
      });
    }
  }, []);

  useEffect(() => {
    if (open && !timeline.loaded) loadTimeline();
  }, [open, timeline.loaded, loadTimeline]);
  usePollingTick(loadTimeline, TIMELINE_REFRESH_MS, open && timeline.loaded && timeline.available);

  const replay = useSnapshot(at);
  const baseline = useSnapshot(compare);

  const setAt = useCallback(
    (t) => {
      setCompareParam('');
      setAtParam(t ? String(t) : '');
    },
    [setAtParam, setCompareParam],
  );
  const setCompare = useCallback(
    (t) => {
      setAtParam('');
      setCompareParam(t ? String(t) : '');
    },
    [setAtParam, setCompareParam],
  );
  const backToLive = useCallback(() => {
    setAtParam('');
    setCompareParam('');
  }, [setAtParam, setCompareParam]);
  const close = useCallback(() => {
    backToLive();
    setOpen(false);
  }, [backToLive]);

  return {
    open,
    setOpen,
    close,
    ...timeline,
    refreshTimeline: loadTimeline,
    at,
    compare,
    setAt,
    setCompare,
    backToLive,
    replay,
    baseline,
  };
}

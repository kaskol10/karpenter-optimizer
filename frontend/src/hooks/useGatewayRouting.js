import { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { API_URL } from '../lib/api';
import { usePollingTick } from './usePolling';

const REFRESH_MS = 60000;

// useGatewayRouting loads the LiteLLM routing config and the fallbacks
// taken over `range` (/serving/gateway/routing) now and again every minute
// on the shared clock, dropping answers for a range no longer selected.
// status: 'loading' | 'ready' | 'error' | 'unavailable' (no config named,
// or an older backend). On an error the last answer is kept.
export function useGatewayRouting(range = '7d') {
  const [state, setState] = useState({ status: 'loading', data: null, error: null });
  const seq = useRef(0);

  const load = useCallback(async () => {
    const id = ++seq.current;
    try {
      const { data } = await axios.get(`${API_URL}/api/v1/serving/gateway/routing`, { params: { range } });
      if (id === seq.current) setState({ status: 'ready', data, error: null });
    } catch (err) {
      if (id !== seq.current) return;
      const res = err.response;
      if ((res?.status === 503 && res.data?.code === 'litellm_config_not_configured') || (res?.status === 404 && !res.data?.code)) {
        setState({ status: 'unavailable', data: null, error: null });
      } else {
        setState((s) => ({ status: 'error', data: s.data, error: res?.data?.error || err.message }));
      }
    }
  }, [range]);

  useEffect(() => {
    setState((s) => ({ ...s, status: s.data ? s.status : 'loading' }));
    load();
  }, [load]);
  usePollingTick(load, REFRESH_MS, true);

  return { ...state, reload: load };
}

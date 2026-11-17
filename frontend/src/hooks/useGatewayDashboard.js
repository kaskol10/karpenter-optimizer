import { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { API_URL } from '../lib/api';
import { usePollingTick } from './usePolling';

const REFRESH_MS = 60000;

// useGatewayDashboard loads the team dashboard for a filter
// ({team, model, key, range}) now and again every minute on the shared
// clock, dropping answers for a filter that is no longer selected.
// status: 'loading' | 'ready' | 'error' | 'unavailable' (no Prometheus).
export function useGatewayDashboard({ team = '', model = '', key = '', range = 'month' }) {
  const [state, setState] = useState({ status: 'loading', data: null, error: null });
  const seq = useRef(0);

  const load = useCallback(async () => {
    const id = ++seq.current;
    const params = { range };
    if (team) params.team = team;
    if (model) params.model = model;
    if (key) params.key = key;
    try {
      const { data } = await axios.get(`${API_URL}/api/v1/serving/gateway/dashboard`, { params });
      if (id === seq.current) setState({ status: 'ready', data, error: null });
    } catch (err) {
      if (id !== seq.current) return;
      const res = err.response;
      if (res?.status === 503 && res.data?.code === 'prometheus_not_configured') {
        setState({ status: 'unavailable', data: null, error: res.data.error });
      } else if (res?.status === 404) {
        // An older backend without the endpoint: same as no Prometheus.
        setState({ status: 'unavailable', data: null, error: null });
      } else {
        setState((s) => ({ status: 'error', data: s.data, error: res?.data?.error || err.message }));
      }
    }
  }, [team, model, key, range]);

  useEffect(() => {
    setState((s) => ({ ...s, status: s.data ? s.status : 'loading' }));
    load();
  }, [load]);
  usePollingTick(load, REFRESH_MS, true);

  return { ...state, reload: load };
}

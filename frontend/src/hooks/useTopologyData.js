import { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { API_URL } from '../lib/api';

// A 404 means a backend older than this frontend. The chart ships both
// images from one release, so that pairing is not supported; say so.
const OLD_BACKEND =
  'This backend has no /api/v1/topology. Run the frontend and backend from the same release (the Helm chart does).';

const errorText = (err) =>
  err.response?.status === 404 ? OLD_BACKEND : err.response?.data?.error || err.message || 'Failed to load topology';

// useTopologyData loads /api/v1/topology and, only when asked, the serving pods and disruptions that some lenses
// and the GPU level need. A failed lens fetch leaves its data empty ("no
// data" tiles), never an error.
export function useTopologyData({ needServing = false, needDisruptions = false } = {}) {
  const [state, setState] = useState({
    nodes: [],
    currency: 'USD',
    usageMeta: null, // {source, window} or null
    gpuUsage: null, // UUID -> MiB in use (DCGM)
    loading: false,
    error: null,
  });
  const [servingPods, setServingPods] = useState(null);
  const [disruptions, setDisruptions] = useState(null);

  const refresh = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const { data } = await axios.get(`${API_URL}/api/v1/topology`);
      setState((s) => ({
        ...s,
        nodes: data.nodes || [],
        currency: data.currency || 'USD',
        usageMeta: data.usage || null,
        gpuUsage: data.gpuUsage || null,
        loading: false,
      }));
    } catch (err) {
      setState((s) => ({ ...s, loading: false, error: errorText(err) }));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!needServing || servingPods) return;
    axios
      .get(`${API_URL}/api/v1/serving`)
      .then((res) => setServingPods(res.data.pods || []))
      .catch(() => setServingPods([]));
  }, [needServing, servingPods]);

  useEffect(() => {
    if (!needDisruptions || disruptions) return;
    axios
      .get(`${API_URL}/api/v1/disruptions`, { params: { hours: 24 } })
      .then((res) => setDisruptions(res.data.disruptions || []))
      .catch(() => setDisruptions([]));
  }, [needDisruptions, disruptions]);

  return { ...state, servingPods, disruptions, refresh };
}

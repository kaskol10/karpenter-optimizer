import { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { API_URL } from '../lib/api';

// fallbackNodes turns /api/v1/nodes into topology-shaped nodes for backends
// older than /api/v1/topology: pods come from podNames with equal weights,
// since real requests need /topology.
function fallbackNodes(nodeItems) {
  return nodeItems.map((node) => ({
    ...node,
    pods: (node.podNames || []).map((qualifiedName) => {
      const slashIdx = qualifiedName.indexOf('/');
      const namespace = slashIdx > 0 ? qualifiedName.slice(0, slashIdx) : 'default';
      const name = slashIdx > 0 ? qualifiedName.slice(slashIdx + 1) : qualifiedName;
      return {
        name,
        namespace,
        nodeName: node.name,
        workloadName: '',
        workloadType: '',
        qosClass: '',
        requests: { cpuCores: 1, memoryGiB: 1, gpu: 0 },
      };
    }),
  }));
}

const errorText = (err) => err.response?.data?.error || err.message || 'Failed to load topology';

// useTopologyData loads /api/v1/topology (falling back to /nodes on a 404)
// and, only when asked, the serving pods and disruptions that some lenses
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
    fallbackMode: false,
  });
  const [servingPods, setServingPods] = useState(null);
  const [disruptions, setDisruptions] = useState(null);

  const refresh = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null, fallbackMode: false }));
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
      if (err.response?.status !== 404) {
        setState((s) => ({ ...s, loading: false, error: errorText(err) }));
        return;
      }
      try {
        const { data } = await axios.get(`${API_URL}/api/v1/nodes`);
        setState((s) => ({ ...s, nodes: fallbackNodes(data.nodes || []), fallbackMode: true, loading: false }));
      } catch (fallbackErr) {
        setState((s) => ({ ...s, loading: false, error: errorText(fallbackErr) }));
      }
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

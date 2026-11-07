import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import axios from 'axios';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Alert, AlertDescription, AlertTitle } from '../ui/alert';
import { Separator } from '../ui/separator';
import { SkeletonRows } from '../ui/skeleton';
import { EmptyState } from '../ui/empty-state';
import { RefreshCw, Loader2, Network } from 'lucide-react';
import { API_URL } from '../../lib/api';
import { useUrlParam } from '../../hooks/useUrlParam';
import { useCopyPodName } from './CopyablePodName';
import { FitCheck } from './FitCheck';
import { FocusBanner } from './FocusBanner';
import { NodeCard } from './NodeCard';
import { TopologyFilters } from './TopologyFilters';
import { isDaemonSetPod } from './podUtils';
import { parseSize } from '../../lib/gpuFit';

const TOPOLOGY_METRICS = ['cpu', 'memory'];

export default function TopologyView({ focus = null, onClearFocus, onBackToServing }) {
  const [nodes, setNodes] = useState([]);
  const nodeRefs = useRef({});
  const handledFocus = useRef(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [fallbackMode, setFallbackMode] = useState(false);
  // Filters live in the URL so a filtered view survives a refresh and can be
  // shared (?metric=memory&pool=gpu&ns=llm ...).
  const [metric, setMetric] = useUrlParam('metric', 'cpu', TOPOLOGY_METRICS);
  const [nodePoolFilter, setNodePoolFilter] = useUrlParam('pool');
  const [zoneFilter, setZoneFilter] = useUrlParam('zone');
  const [nodeNameFilter, setNodeNameFilter] = useUrlParam('nodeq');
  const [podNsFilter, setPodNsFilter] = useUrlParam('ns');
  const [podNameFilter, setPodNameFilter] = useUrlParam('podq');
  // "Will it fit?" size, as typed (?fit=40GiB), so a check can be shared.
  const [fitText, setFitText] = useUrlParam('fit');
  const fitMiB = parseSize(fitText);
  const [showAllPodsInOverview, setShowAllPodsInOverview] = useState(false);
  const [daemonSetsParam, setDaemonSetsParam] = useUrlParam('ds', 'show', ['show', 'hide']);
  const hideDaemonSets = daemonSetsParam === 'hide';
  const setHideDaemonSets = useCallback(
    (next) =>
      setDaemonSetsParam((prev) => {
        const hidden = typeof next === 'function' ? next(prev === 'hide') : next;
        return hidden ? 'hide' : 'show';
      }),
    [setDaemonSetsParam],
  );
  const [expandedNodeName, setExpandedNodeName] = useState(null);
  const [nodeDetailFilters, setNodeDetailFilters] = useState({});
  const { copy: copyPod, copiedKey } = useCopyPodName();

  const getNodeDetailFilters = useCallback(
    (nodeName) =>
      nodeDetailFilters[nodeName] || {
        daemonSetsOnly: false,
        search: '',
      },
    [nodeDetailFilters],
  );

  const setNodeDetailFilter = useCallback((nodeName, partial) => {
    setNodeDetailFilters((prev) => ({
      ...prev,
      [nodeName]: {
        daemonSetsOnly: false,
        search: '',
        ...(prev[nodeName] || {}),
        ...partial,
      },
    }));
  }, []);

  const mapNodesFallback = (nodeItems) =>
    nodeItems.map((node) => ({
      ...node,
      // Older backends don't provide /topology; synthesize minimal pod objects from podNames.
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
          // Equal weights in fallback mode; accurate requests require /topology support.
          requests: {
            cpuCores: 1,
            memoryGiB: 1,
            gpu: 0,
          },
        };
      }),
    }));

  const fetchTopology = useCallback(async () => {
    setLoading(true);
    setError(null);
    setFallbackMode(false);
    try {
      const response = await axios.get(`${API_URL}/api/v1/topology`);
      setNodes(response.data.nodes || []);
    } catch (err) {
      if (err.response?.status === 404) {
        try {
          const nodesResponse = await axios.get(`${API_URL}/api/v1/nodes`);
          setNodes(mapNodesFallback(nodesResponse.data.nodes || []));
          setFallbackMode(true);
          return;
        } catch (fallbackErr) {
          setError(
            fallbackErr.response?.data?.error ||
              fallbackErr.message ||
              'Failed to load topology',
          );
          return;
        }
      }
      setError(err.response?.data?.error || err.message || 'Failed to load topology');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTopology();
  }, [fetchTopology]);

  // Deep-link focus: once per focus target, clear any filter that could hide
  // the node or pod, then scroll the node card into view.
  const focusKey = focus ? `${focus.node}|${focus.pod}|${focus.gpu}` : null;
  useEffect(() => {
    if (!focusKey) {
      handledFocus.current = null;
      return;
    }
    if (handledFocus.current === focusKey || nodes.length === 0) return;
    handledFocus.current = focusKey;
    setNodePoolFilter('');
    setZoneFilter('');
    setNodeNameFilter('');
    setPodNsFilter('');
    setPodNameFilter('');
    setHideDaemonSets(false);
    // Let the filter reset render before scrolling.
    requestAnimationFrame(() => {
      const el = nodeRefs.current[focus.node];
      if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }, [
    focusKey,
    focus,
    nodes.length,
    setNodePoolFilter,
    setZoneFilter,
    setNodeNameFilter,
    setPodNsFilter,
    setPodNameFilter,
    setHideDaemonSets,
  ]);

  const nodePools = useMemo(() => {
    const s = new Set();
    nodes.forEach((n) => {
      if (n.nodePool) s.add(n.nodePool);
    });
    return Array.from(s).sort();
  }, [nodes]);

  const zones = useMemo(() => {
    const s = new Set();
    nodes.forEach((n) => {
      if (n.zone) s.add(n.zone);
    });
    return Array.from(s).sort();
  }, [nodes]);

  const filteredNodes = useMemo(() => {
    return nodes.filter((node) => {
      if (nodePoolFilter && node.nodePool !== nodePoolFilter) return false;
      if (zoneFilter && node.zone !== zoneFilter) return false;
      if (nodeNameFilter) {
        const q = nodeNameFilter.toLowerCase();
        if (!node.name.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [nodes, nodePoolFilter, zoneFilter, nodeNameFilter]);

  const grouped = useMemo(() => {
    const m = new Map();
    filteredNodes.forEach((n) => {
      const k = n.nodePool || '(unknown)';
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(n);
    });
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [filteredNodes]);

  const podNsMatch = (pod) => {
    if (!podNsFilter) return true;
    return pod.namespace.toLowerCase().includes(podNsFilter.toLowerCase());
  };
  const podNameMatch = (pod) => {
    if (!podNameFilter) return true;
    return pod.name.toLowerCase().includes(podNameFilter.toLowerCase());
  };
  const visiblePods = (node) =>
    (node.pods || []).filter(
      (p) => podNsMatch(p) && podNameMatch(p) && !(hideDaemonSets && isDaemonSetPod(p)),
    );

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Topology</h2>
          <p className="text-sm text-muted-foreground">
            Pods on nodes with segment sizes proportional to resource requests (Nomad-style overview).
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchTopology} disabled={loading}>
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <>
              <RefreshCw className="h-4 w-4 mr-2" />
              Refresh
            </>
          )}
        </Button>
      </div>

      <TopologyFilters
        metric={metric}
        setMetric={setMetric}
        showAllPodsInOverview={showAllPodsInOverview}
        setShowAllPodsInOverview={setShowAllPodsInOverview}
        hideDaemonSets={hideDaemonSets}
        setHideDaemonSets={setHideDaemonSets}
        nodePools={nodePools}
        nodePoolFilter={nodePoolFilter}
        setNodePoolFilter={setNodePoolFilter}
        zones={zones}
        zoneFilter={zoneFilter}
        setZoneFilter={setZoneFilter}
        nodeNameFilter={nodeNameFilter}
        setNodeNameFilter={setNodeNameFilter}
        podNsFilter={podNsFilter}
        setPodNsFilter={setPodNsFilter}
        podNameFilter={podNameFilter}
        setPodNameFilter={setPodNameFilter}
      />

      {nodes.some((n) => (n.gpuCapacity || 0) > 0) && (
        <FitCheck value={fitText} onChange={setFitText} nodes={filteredNodes} />
      )}

      {focus && (
        <FocusBanner
          focus={focus}
          nodes={nodes}
          loading={loading}
          onBack={onBackToServing}
          onClear={onClearFocus}
        />
      )}

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
          <Button variant="outline" size="sm" className="mt-2" onClick={fetchTopology}>
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
            Retry
          </Button>
        </Alert>
      )}
      {fallbackMode && (
        <Alert>
          <AlertTitle>Compatibility mode</AlertTitle>
          <AlertDescription>
            Backend endpoint <code>/api/v1/topology</code> is not available. Showing pod placement
            using <code>/api/v1/nodes</code> data with equal pod sizing. Upgrade backend image to a
            version that includes topology support for accurate request-based sizing.
          </AlertDescription>
        </Alert>
      )}

      {loading && nodes.length === 0 ? (
        <div className="flex flex-col items-center py-12">
          <Loader2 className="h-10 w-10 animate-spin text-muted-foreground mb-4" />
          <p className="text-sm text-muted-foreground mb-6">Loading topology...</p>
          <SkeletonRows className="w-full max-w-md" rows={4} />
        </div>
      ) : nodes.length === 0 ? (
        <EmptyState
          icon={Network}
          title="No nodes to show"
          hint="Topology renders once the cluster reports nodes. Check cluster connectivity, then refresh."
          onRetry={fetchTopology}
        />
      ) : (
        <div className="space-y-8">
          {grouped.map(([poolName, poolNodes], idx) => (
            <div key={poolName}>
              <div className="flex items-center gap-2 mb-3">
                <h3 className="text-base font-semibold">{poolName}</h3>
                <Badge variant="secondary">{poolNodes.length} nodes</Badge>
              </div>
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                {poolNodes.map((node) => (
                  <NodeCard
                    key={node.name}
                    node={node}
                    pods={visiblePods(node)}
                    metric={metric}
                    focus={focus}
                    expanded={expandedNodeName === node.name}
                    onToggleExpand={() =>
                      setExpandedNodeName((prev) => (prev === node.name ? null : node.name))
                    }
                    detailFilter={getNodeDetailFilters(node.name)}
                    onDetailFilterChange={(partial) => setNodeDetailFilter(node.name, partial)}
                    showAllPodsInList={showAllPodsInOverview}
                    copyPod={copyPod}
                    copiedKey={copiedKey}
                    fitMiB={fitMiB}
                    cardRef={(el) => {
                      nodeRefs.current[node.name] = el;
                    }}
                  />
                ))}
              </div>
              {idx < grouped.length - 1 && <Separator className="mt-8" />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

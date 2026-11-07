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
import { ClusterMap } from './ClusterMap';
import { FitCheck } from './FitCheck';
import { GpuDetail } from './GpuDetail';
import { LensBar } from './LensBar';
import { Minimap } from './Minimap';
import { PoolMap } from './PoolMap';
import { ZoomBreadcrumb } from './ZoomBreadcrumb';
import { FocusBanner } from './FocusBanner';
import { NodeCard } from './NodeCard';
import { TopologyFilters } from './TopologyFilters';
import { isDaemonSetPod } from './podUtils';
import { parseSize, shortLabelFor } from '../../lib/gpuFit';
import { LENSES, LENS_IDS, lensContext } from '../../lib/topologyLenses';
import { useTopologyZoom } from '../../hooks/useTopologyZoom';

const TOPOLOGY_METRICS = ['cpu', 'memory'];

export default function TopologyView({
  focus = null,
  onClearFocus,
  onBackToServing,
  onFocusDone,
  onOpenServing,
  onOpenLogs,
}) {
  const [nodes, setNodes] = useState([]);
  const [currency, setCurrency] = useState('USD');
  const [servingPods, setServingPods] = useState(null);
  const [disruptions, setDisruptions] = useState(null);
  // Semantic zoom (one history entry per level) and the tile colour lens.
  const [zoomLoc, goZoom] = useTopologyZoom();
  const [lens, setLens] = useUrlParam('lens', 'requests', LENS_IDS);
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
      setCurrency(response.data.currency || 'USD');
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

  // A deep link from Serving shows the node level until the user zooms
  // elsewhere (an explicit ?zoom= wins over the focus).
  const level = focus && !zoomLoc.explicit ? 'node' : zoomLoc.zoom;
  const lensNeeds = LENSES.find((l) => l.id === lens)?.needs;
  const needServing = lensNeeds === 'serving' || level === 'gpu';
  const needDisruptions = lensNeeds === 'disruptions';

  // Lens data is fetched only when a lens or level needs it; a failure just
  // leaves those tiles grey ("no data").
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

  const zoomTo = useCallback(
    (next) => {
      if (focus) onFocusDone?.();
      goZoom(next);
    },
    [focus, onFocusDone, goZoom],
  );
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

  const ctx = useMemo(
    () => lensContext(filteredNodes, { servingPods, disruptions, currency }),
    [filteredNodes, servingPods, disruptions, currency],
  );
  const zoomPoolNodes = useMemo(
    () => filteredNodes.filter((n) => (n.nodePool || '(no NodePool)') === zoomLoc.at),
    [filteredNodes, zoomLoc.at],
  );
  // Node level: one node when zoomed onto it, else every node in view.
  const atNode = level === 'node' || level === 'gpu' ? nodes.find((n) => n.name === zoomLoc.at) : null;
  const shownGroups = level === 'node' && atNode && !focus ? [[atNode.nodePool || '(unknown)', [atNode]]] : grouped;

  const breadcrumb = [{ label: 'Cluster', onClick: () => zoomTo({ zoom: 'cluster' }) }];
  const crumbPool = level === 'pool' ? zoomLoc.at : atNode ? atNode.nodePool || '(no NodePool)' : null;
  if (crumbPool) breadcrumb.push({ label: crumbPool, onClick: () => zoomTo({ zoom: 'pool', at: crumbPool }) });
  if (atNode && (level === 'node' || level === 'gpu')) {
    breadcrumb.push({ label: atNode.name, onClick: () => zoomTo({ zoom: 'node', at: atNode.name }) });
  } else if (level === 'node') {
    breadcrumb.push({ label: focus ? `${focus.node} (from Serving)` : 'All nodes' });
  }
  if (level === 'gpu') breadcrumb.push({ label: shortLabelFor(zoomLoc.card) });
  const selectNode = (name) => zoomTo({ zoom: 'node', at: name });

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

      {nodes.length > 0 && (
        <div className="flex flex-col gap-3 rounded-lg border px-3 py-2.5">
          <ZoomBreadcrumb steps={breadcrumb} />
          {(level === 'cluster' || level === 'pool') && <LensBar lens={lens} onChange={setLens} />}
        </div>
      )}

      {focus && level === 'node' && (
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
      ) : level === 'cluster' ? (
        <ClusterMap
          nodes={filteredNodes}
          lens={lens}
          ctx={ctx}
          onSelectNode={selectNode}
          onSelectPool={(pool) => zoomTo({ zoom: 'pool', at: pool })}
        />
      ) : level === 'pool' ? (
        zoomPoolNodes.length > 0 ? (
          <PoolMap nodes={zoomPoolNodes} lens={lens} ctx={ctx} onSelectNode={selectNode} />
        ) : (
          <EmptyState icon={Network} title={`No nodes in ${zoomLoc.at}`} hint="The NodePool has no nodes, or the filters hide them all." />
        )
      ) : level === 'gpu' ? (
        <GpuDetail
          node={atNode}
          cardKey={zoomLoc.card}
          servingPods={servingPods}
          copyPod={copyPod}
          copiedKey={copiedKey}
          onOpenServing={onOpenServing}
          onOpenLogs={onOpenLogs}
          onZoomOut={() => zoomTo(atNode ? { zoom: 'node', at: atNode.name } : { zoom: 'cluster' })}
        />
      ) : zoomLoc.at && !atNode && !focus ? (
        <EmptyState
          icon={Network}
          title={`${zoomLoc.at} is no longer in the cluster`}
          hint="Karpenter may have removed it. Zoom out to see the nodes that are here now."
          onRetry={() => zoomTo({ zoom: 'cluster' })}
        />
      ) : (
        <div className="space-y-8">
          {shownGroups.map(([poolName, poolNodes], idx) => (
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
                    onSelectGpu={(card) => zoomTo({ zoom: 'gpu', at: node.name, card })}
                    cardRef={(el) => {
                      nodeRefs.current[node.name] = el;
                    }}
                  />
                ))}
              </div>
              {idx < shownGroups.length - 1 && <Separator className="mt-8" />}
            </div>
          ))}
        </div>
      )}

      {level !== 'cluster' && nodes.length > 0 && (
        <Minimap
          nodes={filteredNodes}
          lens={lens}
          ctx={ctx}
          current={new Set(atNode ? [atNode.name] : level === 'pool' ? zoomPoolNodes.map((n) => n.name) : focus ? [focus.node] : [])}
          onSelectNode={selectNode}
          onZoomOut={() => zoomTo({ zoom: 'cluster' })}
        />
      )}
    </div>
  );
}

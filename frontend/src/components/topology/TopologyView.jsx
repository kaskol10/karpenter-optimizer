import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Button } from '../ui/button';
import { Alert, AlertDescription, AlertTitle } from '../ui/alert';
import { SkeletonRows } from '../ui/skeleton';
import { EmptyState } from '../ui/empty-state';
import { RefreshCw, Loader2, Network, History } from 'lucide-react';
import { useUrlParam } from '../../hooks/useUrlParam';
import { useCopyPodName } from './CopyablePodName';
import { ClusterMap } from './ClusterMap';
import { FitCheck } from './FitCheck';
import { GpuDetail } from './GpuDetail';
import { LensBar } from './LensBar';
import { Minimap } from './Minimap';
import { PoolMap } from './PoolMap';
import { ZoomBreadcrumb } from './ZoomBreadcrumb';
import { BlastRadiusSummary } from './BlastRadius';
import { DrainPanel } from './DrainPanel';
import { FocusBanner } from './FocusBanner';
import { NodeList } from './NodeList';
import { TopologyFilters } from './TopologyFilters';
import { TimeScrubber } from './TimeScrubber';
import { ChangesPanel } from './ChangesPanel';
import { isDaemonSetPod } from './podUtils';
import { shortLabelFor } from '../../lib/gpuFit';
import { LENSES, LENS_IDS, lensContext } from '../../lib/topologyLenses';
import { useTopologyZoom } from '../../hooks/useTopologyZoom';
import { useTopologyData } from '../../hooks/useTopologyData';
import { useDrainPlan } from '../../hooks/useDrainPlan';
import { useTopologyHistory } from '../../hooks/useTopologyHistory';
import { diffTopology, formatClock, withChanges } from '../../lib/topologyHistory';
import { risksOnNode, workloadSpread } from '../../lib/blastRadius';

const TOPOLOGY_METRICS = ['cpu', 'memory'];

export default function TopologyView({
  focus = null,
  onClearFocus,
  onBackToServing,
  onFocusDone,
  onOpenServing,
  onOpenLogs,
  onOpenDisruptions,
}) {
  // Semantic zoom (one history entry per level) and the tile colour lens.
  const [zoomLoc, goZoom] = useTopologyZoom();
  const [lens, setLens] = useUrlParam('lens', 'requests', LENS_IDS);
  const nodeRefs = useRef({});
  const handledFocus = useRef(null);
  // Filters live in the URL so a filtered view survives a refresh and can be
  // shared (?metric=memory&pool=gpu&ns=llm ...).
  const [metric, setMetric] = useUrlParam('metric', 'cpu', TOPOLOGY_METRICS);
  const [nodePoolFilter, setNodePoolFilter] = useUrlParam('pool');
  const [zoneFilter, setZoneFilter] = useUrlParam('zone');
  const [nodeNameFilter, setNodeNameFilter] = useUrlParam('nodeq');
  const [podNsFilter, setPodNsFilter] = useUrlParam('ns');
  const [podNameFilter, setPodNameFilter] = useUrlParam('podq');
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
  const { copy: copyPod, copiedKey } = useCopyPodName();

  // A deep link from Serving shows the node level until the user zooms
  // elsewhere (an explicit ?zoom= wins over the focus).
  const level = focus && !zoomLoc.explicit ? 'node' : zoomLoc.zoom;
  // Lens data (serving pods, disruptions) is fetched only when a lens or
  // level needs it. The Usage lens needs a usage source; without one it
  // falls back to Requests, so its own "needs" never triggers a fetch.
  const lensNeeds = LENSES.find((l) => l.id === lens)?.needs;
  const {
    nodes: liveNodes,
    currency,
    usageMeta: liveUsageMeta,
    gpuUsage: liveGpuUsage,
    servingPods,
    disruptions,
    loading: liveLoading,
    error: liveError,
    refresh: fetchTopology,
  } = useTopologyData({
    needServing: lensNeeds === 'serving' || level === 'gpu',
    needDisruptions: lensNeeds === 'disruptions',
  });
  // Time travel: ?time= replays a past snapshot everywhere below (no usage
  // then, it is "now" data); ?compare= keeps the live view and diffs it.
  const history = useTopologyHistory();
  const replaying = Boolean(history.at);
  const nodes = useMemo(
    () => (replaying ? history.replay.nodes || [] : liveNodes),
    [replaying, history.replay.nodes, liveNodes],
  );
  const usageMeta = replaying ? null : liveUsageMeta;
  const gpuUsage = replaying ? null : liveGpuUsage;
  const loading = replaying ? history.replay.loading : liveLoading;
  const error = replaying ? history.replay.error : liveError;
  const diff = useMemo(
    () => (history.compare && history.baseline.nodes ? diffTopology(history.baseline.nodes, liveNodes) : null),
    [history.compare, history.baseline.nodes, liveNodes],
  );
  const activeLens = lens === 'usage' && !usageMeta ? 'requests' : lens;
  const {
    fitText,
    setFitText,
    fitMiB,
    replicasText,
    setReplicasText,
    plan,
    plannedByNode,
    drainSet,
    drainResult,
    toggleDrain,
    clearDrain,
  } = useDrainPlan(nodes, currency);

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

  const matchesNodeFilters = useCallback(
    (node) => {
      if (nodePoolFilter && node.nodePool !== nodePoolFilter) return false;
      if (zoneFilter && node.zone !== zoneFilter) return false;
      if (nodeNameFilter && !node.name.toLowerCase().includes(nodeNameFilter.toLowerCase())) return false;
      return true;
    },
    [nodePoolFilter, zoneFilter, nodeNameFilter],
  );
  const filteredNodes = useMemo(() => nodes.filter(matchesNodeFilters), [nodes, matchesNodeFilters]);
  // Compare mode: removed nodes come back as ghosts on the Cluster map, under
  // the same filters as the live ones.
  const mapNodes = useMemo(
    () =>
      diff
        ? withChanges(filteredNodes, { ...diff, removedNodes: diff.removedNodes.filter(matchesNodeFilters) })
        : filteredNodes,
    [diff, filteredNodes, matchesNodeFilters],
  );

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
  // Spread is judged over every node, not just those in view: a filter that
  // hides a replica's node must not make the workload look concentrated.
  const risks = useMemo(() => workloadSpread(nodes), [nodes]);
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
        <div className="flex items-center gap-2">
          {!history.open && (
            <Button variant="outline" size="sm" onClick={() => history.setOpen(true)}>
              <History className="h-4 w-4 mr-2" />
              History
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={fetchTopology} disabled={liveLoading}>
            {liveLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <>
                <RefreshCw className="h-4 w-4 mr-2" />
                Refresh
              </>
            )}
          </Button>
        </div>
      </div>

      {history.open && <TimeScrubber history={history} />}
      {replaying && history.replay.at && (
        <p className="text-[11px] text-muted-foreground">
          Replaying the cluster at {formatClock(history.replay.at)}: placement and requests as recorded, cost at
          today&apos;s prices, no usage. Node actions copy commands for nodes that may be gone.
        </p>
      )}
      {diff && (
        <ChangesPanel
          diff={diff}
          events={history.events}
          since={formatClock(history.baseline.at || history.compare)}
          onSelectNode={(name) => zoomTo({ zoom: 'node', at: name })}
        />
      )}

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
        <FitCheck
          value={fitText}
          onChange={setFitText}
          nodes={filteredNodes}
          replicas={replicasText}
          onReplicasChange={setReplicasText}
          plan={plan}
        />
      )}

      {nodes.length > 0 && (
        <div className="flex flex-col gap-3 rounded-lg border px-3 py-2.5">
          <ZoomBreadcrumb steps={breadcrumb} />
          {(level === 'cluster' || level === 'pool') && (
            <LensBar lens={activeLens} onChange={setLens} usageAvailable={!!usageMeta} />
          )}
          <p className="text-[11px] text-muted-foreground">
            {usageMeta
              ? `Usage: ${usageMeta.window} from ${usageMeta.source === 'prometheus' ? 'Prometheus' : 'metrics-server'}; requested but unused capacity is hatched.`
              : 'Usage: no metrics-server or Prometheus found, so bars show requests only.'}
          </p>
        </div>
      )}

      {drainResult && drainResult.drained.length > 0 && (
        <DrainPanel result={drainResult} onRemove={toggleDrain} onClear={clearDrain} onSelectNode={selectNode} />
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
        <div className="space-y-4">
          <BlastRadiusSummary risks={risks} onSelectNode={selectNode} />
          <ClusterMap
            nodes={mapNodes}
            lens={activeLens}
            ctx={ctx}
            onSelectNode={selectNode}
            onSelectPool={(pool) => zoomTo({ zoom: 'pool', at: pool })}
            drained={drainSet}
          />
        </div>
      ) : level === 'pool' ? (
        zoomPoolNodes.length > 0 ? (
          <PoolMap nodes={zoomPoolNodes} lens={activeLens} ctx={ctx} onSelectNode={selectNode} drained={drainSet} />
        ) : (
          <EmptyState icon={Network} title={`No nodes in ${zoomLoc.at}`} hint="The NodePool has no nodes, or the filters hide them all." />
        )
      ) : level === 'gpu' ? (
        <GpuDetail
          node={atNode}
          cardKey={zoomLoc.card}
          servingPods={servingPods}
          gpuUsage={gpuUsage}
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
        <NodeList
          groups={shownGroups}
          cardProps={(node) => ({
            pods: visiblePods(node),
            metric,
            focus,
            showAllPodsInList: showAllPodsInOverview,
            copyPod,
            copiedKey,
            fitMiB,
            onSelectGpu: (card) => zoomTo({ zoom: 'gpu', at: node.name, card }),
            gpuUsage,
            risks: risksOnNode(risks, node.name),
            onOpenLogs,
            onOpenDisruptions,
            onToggleDrain: toggleDrain,
            drained: drainSet.has(node.name),
            planned: plannedByNode.get(node.name),
            cardRef: (el) => {
              nodeRefs.current[node.name] = el;
            },
          })}
        />
      )}

      {level !== 'cluster' && nodes.length > 0 && (
        <Minimap
          nodes={filteredNodes}
          lens={activeLens}
          ctx={ctx}
          current={new Set(atNode ? [atNode.name] : level === 'pool' ? zoomPoolNodes.map((n) => n.name) : focus ? [focus.node] : [])}
          onSelectNode={selectNode}
          onZoomOut={() => zoomTo({ zoom: 'cluster' })}
        />
      )}
    </div>
  );
}

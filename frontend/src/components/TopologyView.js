import React, { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { Input } from './ui/input';
import { Separator } from './ui/separator';
import { Loader2, RefreshCw } from 'lucide-react';
import { cn } from '../lib/utils';

const API_URL =
  window.ENV && Object.prototype.hasOwnProperty.call(window.ENV, 'REACT_APP_API_URL')
    ? window.ENV.REACT_APP_API_URL
    : process.env.REACT_APP_API_URL || '';

function getPodKey(pod) {
  return `${pod.namespace}/${pod.name}`;
}

function hashToHue(str) {
  let h = 0;
  for (let i = 0; i < str.length; i += 1) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % 360;
}

function getMetricFields(metric) {
  if (metric === 'memory') {
    return {
      weight: (pod) => pod.requests?.memoryGiB || 0,
      format: (v) => `${v.toFixed(2)} GiB`,
      label: 'Memory',
    };
  }
  return {
    weight: (pod) => pod.requests?.cpuCores || 0,
    format: (v) => `${v.toFixed(3)} cores`,
    label: 'CPU',
  };
}

function PodBarSegment({ pod, metric, grow, showLabel, isActive, onHoverPod }) {
  const { format, label } = getMetricFields(metric);
  const weight = metric === 'cpu' ? pod.requests?.cpuCores || 0 : pod.requests?.memoryGiB || 0;
  const hue = hashToHue(getPodKey(pod));

  const titleLines = [
    `${pod.namespace}/${pod.name}`,
    pod.workloadType
      ? `Workload: ${pod.workloadType}${pod.workloadName ? `/${pod.workloadName}` : ''}`
      : null,
    `${label} req: ${format(weight)}`,
    pod.qosClass ? `QoS: ${pod.qosClass}` : null,
  ].filter(Boolean);

  return (
    <div
      className="flex items-center justify-center border-r border-foreground/10 bg-card/80 hover:bg-accent transition-colors overflow-hidden"
      style={{
        flexGrow: grow,
        flexShrink: 0,
        flexBasis: 0,
        minWidth: 0,
        background: `hsl(${hue} 70% 50% / 0.18)`,
        outline: isActive ? '2px solid hsl(190 90% 60% / 0.6)' : undefined,
        outlineOffset: isActive ? '-2px' : undefined,
      }}
      title={titleLines.join('\n')}
      onMouseEnter={() => onHoverPod?.(pod)}
      onMouseLeave={() => onHoverPod?.(null)}
    >
      {showLabel && (
        <span className="px-1 text-[10px] font-mono truncate max-w-full">{pod.name}</span>
      )}
    </div>
  );
}

function NodePodBar({ node, pods, metric }) {
  const { weight: weightFn, format, label } = getMetricFields(metric);
  const [hoveredPod, setHoveredPod] = useState(null);

  const allocatable =
    metric === 'cpu'
      ? node.cpuUsage?.allocatable ?? 0
      : node.memoryUsage?.allocatable ?? 0;

  const totalRequested = useMemo(() => {
    const { weight } = getMetricFields(metric);
    return pods.reduce((sum, p) => sum + weight(p), 0);
  }, [pods, metric]);

  const remainder = Math.max(0, allocatable - totalRequested);

  const podsSorted = [...pods].sort((a, b) => weightFn(b) - weightFn(a));
  const showLabelThreshold = 0.001;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>
          {label} allocatable: <span className="font-mono text-foreground">{format(allocatable)}</span>
        </span>
        <span>
          Pods sum (requests):{' '}
          <span className="font-mono text-foreground">{format(totalRequested)}</span>
        </span>
      </div>

      <div className="flex h-10 w-full rounded-md border border-foreground/15 overflow-hidden bg-muted/40">
        {podsSorted.map((pod) => {
          const w = weightFn(pod);
          const grow = Math.max(w, 0);
          const showLabel = allocatable > 0 ? w / allocatable >= showLabelThreshold : false;
          const isActive = hoveredPod ? getPodKey(hoveredPod) === getPodKey(pod) : false;
          return (
            <PodBarSegment
              key={getPodKey(pod)}
              pod={pod}
              metric={metric}
              grow={grow}
              showLabel={showLabel}
              isActive={isActive}
              onHoverPod={setHoveredPod}
            />
          );
        })}
        {remainder > 1e-6 && (
          <div
            className="flex items-center justify-center bg-muted text-muted-foreground text-[10px] px-1"
            style={{
              flexGrow: remainder,
              flexShrink: 0,
              flexBasis: 0,
              minWidth: 0,
            }}
            title={`Unrequested ${label.toLowerCase()} (vs allocatable)`}
          >
            <span className="truncate">free</span>
          </div>
        )}
      </div>

      {hoveredPod && (
        <div className="text-xs border rounded-md bg-card/60 px-3 py-2">
          <div className="flex items-center gap-2 min-w-0 flex-wrap">
            <span className="font-mono truncate">{hoveredPod.namespace}/{hoveredPod.name}</span>
            <span className="text-muted-foreground">·</span>
            <span className="font-mono text-muted-foreground">
              {label} req: {format(weightFn(hoveredPod))}
            </span>
          </div>
        </div>
      )}

      {pods.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-semibold">Pods (top by {label} request)</p>
          <div className="flex flex-col gap-1">
            {podsSorted.slice(0, 8).map((pod) => {
              const w = weightFn(pod);
              return (
                <div
                  key={getPodKey(pod)}
                  className="flex items-center gap-2 text-xs rounded-md border bg-card/60 px-2 py-1 min-w-0"
                  title={`${pod.namespace}/${pod.name}`}
                >
                  <span
                    className="inline-block w-2 h-2 rounded-full border border-foreground/10 shrink-0"
                    style={{
                      background: `hsl(${hashToHue(getPodKey(pod))} 70% 50% / 0.55)`,
                    }}
                  />
                  <span className="font-mono truncate">{pod.namespace}/{pod.name}</span>
                  <span className="ml-auto text-muted-foreground font-mono shrink-0">{format(w)}</span>
                </div>
              );
            })}
            {podsSorted.length > 8 && (
              <p className="text-xs text-muted-foreground italic">+{podsSorted.length - 8} more</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function TopologyView() {
  const [nodes, setNodes] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [metric, setMetric] = useState('cpu');
  const [nodePoolFilter, setNodePoolFilter] = useState('');
  const [zoneFilter, setZoneFilter] = useState('');
  const [nodeNameFilter, setNodeNameFilter] = useState('');
  const [podNsFilter, setPodNsFilter] = useState('');
  const [podNameFilter, setPodNameFilter] = useState('');

  const fetchTopology = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await axios.get(`${API_URL}/api/v1/topology`);
      setNodes(response.data.nodes || []);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to load topology');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTopology();
  }, [fetchTopology]);

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

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Filters</CardTitle>
          <CardDescription>Group by NodePool; narrow nodes and pods.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2 items-center">
            <span className="text-sm text-muted-foreground">Metric:</span>
            <Button
              size="sm"
              variant={metric === 'cpu' ? 'default' : 'outline'}
              onClick={() => setMetric('cpu')}
            >
              CPU
            </Button>
            <Button
              size="sm"
              variant={metric === 'memory' ? 'default' : 'outline'}
              onClick={() => setMetric('memory')}
            >
              Memory
            </Button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
            <div>
              <label className="text-xs text-muted-foreground">NodePool</label>
              <select
                className={cn(
                  'mt-1 flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm',
                )}
                value={nodePoolFilter}
                onChange={(e) => setNodePoolFilter(e.target.value)}
              >
                <option value="">All</option>
                {nodePools.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Zone</label>
              <select
                className={cn(
                  'mt-1 flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm',
                )}
                value={zoneFilter}
                onChange={(e) => setZoneFilter(e.target.value)}
              >
                <option value="">All</option>
                {zones.map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Node name contains</label>
              <Input
                className="mt-1"
                value={nodeNameFilter}
                onChange={(e) => setNodeNameFilter(e.target.value)}
                placeholder="filter"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Pod namespace contains</label>
              <Input
                className="mt-1"
                value={podNsFilter}
                onChange={(e) => setPodNsFilter(e.target.value)}
                placeholder="e.g. prod"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Pod name contains</label>
              <Input
                className="mt-1"
                value={podNameFilter}
                onChange={(e) => setPodNameFilter(e.target.value)}
                placeholder="filter"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {loading && nodes.length === 0 ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-10 w-10 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="space-y-8">
          {grouped.map(([poolName, poolNodes], idx) => (
            <div key={poolName}>
              <div className="flex items-center gap-2 mb-3">
                <h3 className="text-base font-semibold">{poolName}</h3>
                <Badge variant="secondary">{poolNodes.length} nodes</Badge>
              </div>
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                {poolNodes.map((node) => {
                  const pods = (node.pods || []).filter(
                    (p) => podNsMatch(p) && podNameMatch(p),
                  );
                  return (
                    <Card key={node.name}>
                      <CardHeader className="pb-2">
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <CardTitle className="text-sm font-mono">{node.name}</CardTitle>
                          <div className="flex flex-wrap gap-1">
                            {node.instanceType && (
                              <Badge variant="outline">{node.instanceType}</Badge>
                            )}
                            {node.capacityType && (
                              <Badge variant="outline">{node.capacityType}</Badge>
                            )}
                            {node.zone && <Badge variant="secondary">{node.zone}</Badge>}
                          </div>
                        </div>
                      </CardHeader>
                      <CardContent>
                        <NodePodBar node={node} pods={pods} metric={metric} />
                        {pods.length === 0 && (
                          <p className="text-xs text-muted-foreground mt-2">No pods match filters.</p>
                        )}
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
              {idx < grouped.length - 1 && <Separator className="mt-8" />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { ChevronDown, Filter, Loader2 } from 'lucide-react';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Separator } from './ui/separator';
import { cn } from '../lib/utils';

const API_URL =
  window.ENV && window.ENV.hasOwnProperty('REACT_APP_API_URL')
    ? window.ENV.REACT_APP_API_URL
    : process.env.REACT_APP_API_URL || '';

function formatCores(value) {
  if (value === undefined || value === null) return '—';
  if (value < 1) return `${Math.round(value * 1000)}m`;
  return `${value.toFixed(2)}c`;
}

function formatGiB(value) {
  if (value === undefined || value === null) return '—';
  if (value < 1) return `${(value * 1024).toFixed(0)}MiB`;
  return `${value.toFixed(2)}GiB`;
}

function getPodKey(pod) {
  return `${pod.namespace}/${pod.name}`;
}

function getMetricFields(metric) {
  if (metric === 'cpu') {
    return { weight: (pod) => pod.requests?.cpuCores || 0, format: formatCores, label: 'CPU' };
  }

  return {
    weight: (pod) => pod.requests?.memoryGiB || 0,
    format: formatGiB,
    label: 'Memory',
  };
}

function hashToHue(input) {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash % 360;
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
    metric === 'cpu' ? node.cpuUsage?.allocatable || 0 : node.memoryUsage?.allocatable || 0;

  const totalRequested = pods.reduce((sum, pod) => sum + weightFn(pod), 0);
  const remaining = Math.max(allocatable - totalRequested, 0);

  const barBase = allocatable > 0 ? allocatable : totalRequested > 0 ? totalRequested : 1;
  const requestedPercent = barBase > 0 ? (totalRequested / barBase) * 100 : 0;

  const podsSorted = [...pods].sort((a, b) => weightFn(b) - weightFn(a));

  const showLabelThreshold = 0.001; // fraction of node allocatable

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold">
          Pod requests: {format(totalRequested)} / {format(allocatable)}
          {allocatable > 0 && <> ({requestedPercent.toFixed(0)}%)</>}
        </p>
        <Badge variant="secondary" className="text-xs">
          {pods.length} pod{pods.length !== 1 ? 's' : ''}
        </Badge>
      </div>

      <div
        className="flex w-full h-10 rounded-md border bg-muted/30 overflow-hidden"
        style={{ minHeight: 40 }}
        aria-label={`${label} pod bar`}
      >
        {pods.length === 0 ? (
          <div className="flex items-center justify-center w-full text-xs text-muted-foreground italic">
            No pods match current filters
          </div>
        ) : (
          <>
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
            {remaining > 0 && (
              <div
                className="flex items-center justify-center border-r border-foreground/10 bg-muted/20"
                style={{ flexGrow: remaining, minWidth: 0 }}
                title="Unused allocatable (no pod requests or pods filtered out)"
              />
            )}
          </>
        )}
      </div>

      {hoveredPod && (
        <div className="text-xs border rounded-md bg-card/60 px-3 py-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-mono truncate">
              {hoveredPod.namespace}/{hoveredPod.name}
            </span>
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
                    className="inline-block w-2 h-2 rounded-full border border-foreground/10"
                    style={{
                      background: `hsl(${hashToHue(getPodKey(pod))} 70% 50% / 0.55)`,
                    }}
                  />
                  <span className="font-mono truncate">
                    {pod.namespace}/{pod.name}
                  </span>
                  <span className="ml-auto text-muted-foreground font-mono">{format(w)}</span>
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

function NodeCard({ node, metric, podNamespaceFilter, podNameFilter }) {
  const pods = useMemo(() => {
    const all = node.pods || [];
    return all.filter((p) => {
      if (
        podNamespaceFilter &&
        !p.namespace.toLowerCase().includes(podNamespaceFilter.toLowerCase())
      ) {
        return false;
      }
      if (podNameFilter && !p.name.toLowerCase().includes(podNameFilter.toLowerCase())) {
        return false;
      }
      return true;
    });
  }, [node.pods, podNamespaceFilter, podNameFilter]);

  return (
    <Card>
      <CardHeader className="pb-3 border-b">
        <div className="flex justify-between items-start gap-3">
          <div className="min-w-0">
            <code className="text-sm font-semibold block truncate">{node.name}</code>
            <div className="flex flex-wrap gap-2 mt-2">
              {node.nodePool && <Badge variant="outline">📦 {node.nodePool}</Badge>}
              {node.instanceType && (
                <Badge variant="secondary" className="font-mono text-xs">
                  {node.instanceType}
                </Badge>
              )}
              {node.zone && (
                <Badge variant="outline" className="border-blue-500 text-blue-700">
                  🌍 {node.zone}
                </Badge>
              )}
              {node.capacityType && (
                <Badge variant={node.capacityType === 'spot' ? 'default' : 'secondary'}>
                  {node.capacityType}
                </Badge>
              )}
              {node.architecture && (
                <Badge
                  variant="outline"
                  className={
                    node.architecture === 'arm64'
                      ? 'border-green-500 text-green-700'
                      : 'border-indigo-500 text-indigo-700'
                  }
                >
                  {node.architecture.toUpperCase()}
                </Badge>
              )}
              {node.podCount !== undefined && (
                <Badge variant="outline" className="font-mono text-xs">
                  {node.podCount} pods
                </Badge>
              )}
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-4 space-y-3">
        <NodePodBar node={node} pods={pods} metric={metric} />
      </CardContent>
    </Card>
  );
}

export default function TopologyView() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [nodes, setNodes] = useState([]);

  const [metric, setMetric] = useState('cpu'); // cpu | memory

  const [nodePoolFilter, setNodePoolFilter] = useState('all');
  const [zoneFilter, setZoneFilter] = useState('all');
  const [nodeNameFilter, setNodeNameFilter] = useState('');
  const [podNamespaceFilter, setPodNamespaceFilter] = useState('');
  const [podNameFilter, setPodNameFilter] = useState('');
  const [showFilters, setShowFilters] = useState(false);

  useEffect(() => {
    const fetchTopology = async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await axios.get(`${API_URL}/api/v1/topology`, {
          params: { maxPodsPerNode: 200 },
        });
        setNodes(response.data.nodes || []);
      } catch (err) {
        setError(err.response?.data?.error || err.message || 'Failed to fetch topology');
      } finally {
        setLoading(false);
      }
    };
    fetchTopology();
  }, []);

  const nodePools = useMemo(() => {
    const values = new Set();
    nodes.forEach((n) => {
      if (n.nodePool) values.add(n.nodePool);
    });
    return Array.from(values).sort();
  }, [nodes]);

  const zones = useMemo(() => {
    const values = new Set();
    nodes.forEach((n) => {
      if (n.zone) values.add(n.zone);
    });
    return Array.from(values).sort();
  }, [nodes]);

  const filteredNodes = useMemo(() => {
    return nodes.filter((n) => {
      if (nodePoolFilter !== 'all' && n.nodePool !== nodePoolFilter) return false;
      if (zoneFilter !== 'all' && n.zone !== zoneFilter) return false;
      if (nodeNameFilter && !n.name.toLowerCase().includes(nodeNameFilter.toLowerCase())) {
        return false;
      }
      return true;
    });
  }, [nodes, nodePoolFilter, zoneFilter, nodeNameFilter]);

  const nodesByNodePool = useMemo(() => {
    const groups = new Map();
    filteredNodes.forEach((n) => {
      const key = n.nodePool || '(no nodePool)';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(n);
    });
    const sorted = Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    sorted.forEach(([, list]) => list.sort((a, b) => a.name.localeCompare(b.name)));
    return sorted;
  }, [filteredNodes]);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0">
            <CardTitle>Topology</CardTitle>
            <p className="text-sm text-muted-foreground">
              Bird’s-eye view of pods scheduled on nodes (relative sizes by requests).
            </p>
          </div>

          <div className="flex flex-wrap gap-2 items-center">
            <Select value={metric} onValueChange={setMetric}>
              <SelectTrigger className="w-[220px]">
                <SelectValue placeholder="Sizing metric" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="cpu">Size by CPU requests</SelectItem>
                <SelectItem value="memory">Size by memory requests</SelectItem>
              </SelectContent>
            </Select>

            <Button variant="outline" size="sm" onClick={() => setShowFilters((v) => !v)}>
              <Filter className="h-4 w-4 mr-2" />
              Filters
              <ChevronDown
                className={cn('h-4 w-4 ml-2 transition-transform', showFilters && 'rotate-180')}
              />
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {showFilters && (
          <div className="rounded-md border p-4 bg-muted/20 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>NodePool</Label>
                <Select value={nodePoolFilter} onValueChange={setNodePoolFilter}>
                  <SelectTrigger>
                    <SelectValue placeholder="All NodePools" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All</SelectItem>
                    {nodePools.map((np) => (
                      <SelectItem key={np} value={np}>
                        {np}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Zone</Label>
                <Select value={zoneFilter} onValueChange={setZoneFilter}>
                  <SelectTrigger>
                    <SelectValue placeholder="All zones" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All</SelectItem>
                    {zones.map((z) => (
                      <SelectItem key={z} value={z}>
                        {z}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Node name</Label>
                <Input
                  value={nodeNameFilter}
                  onChange={(e) => setNodeNameFilter(e.target.value)}
                  placeholder="contains…"
                />
              </div>
            </div>

            <Separator />

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Pod namespace</Label>
                <Input
                  value={podNamespaceFilter}
                  onChange={(e) => setPodNamespaceFilter(e.target.value)}
                  placeholder="contains…"
                />
              </div>
              <div className="space-y-2">
                <Label>Pod name</Label>
                <Input
                  value={podNameFilter}
                  onChange={(e) => setPodNameFilter(e.target.value)}
                  placeholder="contains…"
                />
              </div>
            </div>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <div className="rounded-md border p-4">
            <p className="text-sm font-semibold text-red-600">Failed to load topology</p>
            <p className="text-sm text-muted-foreground mt-1">{error}</p>
          </div>
        ) : (
          <div className="space-y-8">
            {nodesByNodePool.map(([nodePoolName, list]) => (
              <div key={nodePoolName} className="space-y-3">
                <div className="flex items-center gap-2">
                  <Badge variant="outline">📦 {nodePoolName}</Badge>
                  <Badge variant="secondary">
                    {list.length} node{list.length !== 1 ? 's' : ''}
                  </Badge>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                  {list.map((node) => (
                    <NodeCard
                      key={node.name}
                      node={node}
                      metric={metric}
                      podNamespaceFilter={podNamespaceFilter}
                      podNameFilter={podNameFilter}
                    />
                  ))}
                </div>
              </div>
            ))}

            {nodesByNodePool.length === 0 && (
              <p className="text-sm text-muted-foreground italic">
                No nodes match current filters.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { Input } from './ui/input';
import { Separator } from './ui/separator';
import { Check, Loader2, RefreshCw } from 'lucide-react';
import { cn, formatGPUMem } from '../lib/utils';

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

function getMetricFields(metric, node) {
  if (metric === 'memory') {
    return {
      weight: (pod) => pod.requests?.memoryGiB || 0,
      format: (v) => `${v.toFixed(2)} GiB`,
      label: 'Memory',
    };
  }
  if (metric === 'gpu' && node) {
    const memKnown = (node.gpuMemTotalMiB || 0) > 0;
    const perGpuMiB =
      memKnown && (node.gpuCapacity || 0) > 0 ? node.gpuMemTotalMiB / node.gpuCapacity : 0;
    return {
      // Memory-based (HAMi) when node GPU memory is known; count-based otherwise.
      // Whole-GPU pods without an explicit gpumem value are estimated from the
      // node's per-GPU memory so they stay visible in memory-based mode.
      weight: (pod) => {
        if (!memKnown) return pod.requests?.gpu || 0;
        if ((pod.requests?.gpuMemMiB || 0) > 0) return pod.requests.gpuMemMiB;
        return (pod.requests?.gpu || 0) * perGpuMiB;
      },
      format: (v) => (memKnown ? `${(v / 1024).toFixed(1)} GiB` : `${v} GPU`),
      label: 'GPU',
    };
  }
  return {
    weight: (pod) => pod.requests?.cpuCores || 0,
    format: (v) => `${v.toFixed(3)} cores`,
    label: 'CPU',
  };
}

function isDaemonSetPod(pod) {
  return (pod.workloadType || '').toLowerCase() === 'daemonset';
}

// hasDevicePlacement reports whether the node should render per-physical-GPU
// lanes: HAMi-detected, per-GPU memory known, multi-GPU node, and at least one
// of the given pods carries a hami.io/vgpu-devices-allocated annotation.
function hasDevicePlacement(node, pods) {
  return (
    !!node.hamiDetected &&
    (node.gpuMemTotalMiB || 0) > 0 &&
    (node.gpuCapacity || 0) > 1 &&
    pods.some((p) => (p.gpuDevices || []).length > 0)
  );
}

// shortGpuUuid shortens a HAMi device UUID to a compact label, e.g.
// "GPU-83026582-9368-..." -> "83026582". Returns '' when the uuid is empty.
// HAMi's allocated-index is unreliable (two cards can both report index 0),
// so the UUID is the only stable identifier of a physical GPU.
function shortGpuUuid(uuid) {
  if (!uuid) return '';
  return String(uuid).replace(/^GPU-/, '').replace(/-/g, '').slice(0, 8);
}

// useCopyPodName copies a pod's namespace/name to the clipboard and tracks
// which pod key was just copied (for brief "Copied" feedback).
function useCopyPodName() {
  const [copiedKey, setCopiedKey] = useState(null);
  const timeoutRef = useRef(null);

  useEffect(() => () => clearTimeout(timeoutRef.current), []);

  const copy = useCallback((pod) => {
    const key = getPodKey(pod);
    const done = () => {
      setCopiedKey(key);
      clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setCopiedKey(null), 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(key).then(done).catch(done);
    } else {
      const ta = document.createElement('textarea');
      ta.value = key;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      done();
    }
  }, []);

  return { copy, copiedKey };
}

// CopyablePodName renders a pod's namespace/name; clicking copies the full
// name (for pasting into the CLI).
function CopyablePodName({ pod, onCopy, copiedKey, className }) {
  const isCopied = copiedKey === getPodKey(pod);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onCopy(pod);
      }}
      title={`${getPodKey(pod)} — click to copy`}
      className={cn(
        'inline-flex items-center gap-1 font-mono max-w-full cursor-pointer truncate text-left',
        isCopied && 'text-emerald-600',
        className,
      )}
    >
      {isCopied ? (
        <>
          <Check className="w-3 h-3 shrink-0" aria-hidden="true" />
          <span className="truncate">Copied</span>
        </>
      ) : (
        <span className="truncate">
          {pod.namespace}/{pod.name}
        </span>
      )}
    </button>
  );
}

function PodBarSegment({ pod, node, metric, grow, showLabel, isActive, onHoverPod, copyPod, copiedKey }) {
  const { format, label, weight } = getMetricFields(metric, node);
  const w = weight(pod);
  const hue = hashToHue(getPodKey(pod));

  const titleLines = [
    `${pod.namespace}/${pod.name}`,
    pod.workloadType
      ? `Workload: ${pod.workloadType}${pod.workloadName ? `/${pod.workloadName}` : ''}`
      : null,
    `${label} req: ${format(w)}`,
    metric !== 'gpu' && (pod.requests?.gpu || 0) > 0
      ? `GPU req: ${pod.requests.gpu}${pod.requests.gpuMemMiB > 0 ? ` / ${formatGPUMem(pod.requests.gpuMemMiB)}` : ''}`
      : null,
    (pod.gpuDevices || []).length > 0
      ? `Placed: ${pod.gpuDevices.map((d) => shortGpuUuid(d.uuid) || `GPU ${d.index}`).join(', ')}`
      : null,
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
        <CopyablePodName
          pod={pod}
          onCopy={copyPod}
          copiedKey={copiedKey}
          className="px-1 text-[10px]"
        />
      )}
    </div>
  );
}

// GPULaneBar renders one lane per physical GPU, keyed by the HAMi device UUID
// (the annotation's index field is unreliable — two cards can both report
// index 0), plus an "Unassigned" lane for GPU pods without placement info.
// Segment width is the pod's memory on that device (MiB), against the node's
// per-GPU memory.
function GPULaneBar({ node, pods, copyPod, copiedKey }) {
  const gpuCount = Math.max(Math.round(node.gpuCapacity || 0), 1);
  const perGpuMiB = (node.gpuMemTotalMiB || 0) / gpuCount;

  // lanes: Map<key, { label, uuid, sortIndex, segments: [{ pod, device, memMiB }] }>
  const laneMap = new Map();
  const unassigned = [];

  pods.forEach((pod) => {
    const devices = pod.gpuDevices || [];
    if (devices.length === 0) {
      // No placement yet (e.g. whole-GPU claim before hami placed it).
      const mem =
        (pod.requests?.gpuMemMiB || 0) > 0
          ? pod.requests.gpuMemMiB
          : (pod.requests?.gpu || 0) * perGpuMiB;
      unassigned.push({ pod, memMiB: mem });
      return;
    }
    devices.forEach((device) => {
      const key = device.uuid || `idx-${device.index}`;
      if (!laneMap.has(key)) {
        laneMap.set(key, {
          label: shortGpuUuid(device.uuid) || `GPU ${device.index}`,
          uuid: device.uuid || '',
          sortIndex: device.index || 0,
          segments: [],
        });
      }
      laneMap.get(key).segments.push({ pod, device, memMiB: device.memoryMiB || 0 });
    });
  });

  const lanes = [...laneMap.values()].sort(
    (a, b) => a.sortIndex - b.sortIndex || a.label.localeCompare(b.label),
  );

  const renderSegment = ({ pod, device, memMiB }) => {
    const hue = hashToHue(getPodKey(pod));
    const titleLines = device
      ? [
          `${pod.namespace}/${pod.name}`,
          `GPU ${device.index}${device.uuid ? ` (${device.uuid})` : ''}`,
          `${memMiB} MiB requested`,
        ]
      : [
          `${pod.namespace}/${pod.name}`,
          'No device placement (unassigned)',
          `${memMiB} MiB requested`,
        ];
    return (
      <div
        key={`${getPodKey(pod)}-${device ? device.uuid || device.index : 'unassigned'}`}
        className="flex items-center justify-center border-r border-foreground/10 bg-card/80 hover:bg-accent transition-colors overflow-hidden"
        style={{
          flexGrow: Math.max(memMiB, 0),
          flexShrink: 0,
          flexBasis: 0,
          minWidth: 0,
          background: `hsl(${hue} 70% 50% / 0.18)`,
        }}
        title={titleLines.join('\n')}
      >
        <CopyablePodName
          pod={pod}
          onCopy={copyPod}
          copiedKey={copiedKey}
          className="px-1 text-[10px]"
        />
      </div>
    );
  };

  const laneRow = (label, segments, usedMiB, labelTitle) => {
    const freeMiB = Math.max(perGpuMiB - usedMiB, 0);
    return (
    <div className="flex items-center gap-2">
      <span
        className="text-[10px] font-mono text-muted-foreground w-16 shrink-0 truncate"
        title={labelTitle || undefined}
      >
        {label}
      </span>
      <div className="flex h-7 flex-1 rounded border border-foreground/15 overflow-hidden bg-muted/40">
        {segments.map(renderSegment)}
        {perGpuMiB > 0 && freeMiB > 0 && (
          <div
            className="flex items-center justify-center bg-muted text-muted-foreground text-[10px] px-1"
            style={{
              flexGrow: freeMiB,
              flexShrink: 0,
              flexBasis: 0,
              minWidth: 0,
            }}
            title={`Free GPU memory: ${Math.round(freeMiB)} MiB (${Math.round(perGpuMiB)} MiB total)`}
          >
            <span className="truncate">free · {formatGPUMem(freeMiB)}</span>
          </div>
        )}
      </div>
      <span className="text-[10px] font-mono text-muted-foreground w-24 shrink-0 text-right">
        {usedMiB > 0 ? `${(usedMiB / 1024).toFixed(1)}/${(perGpuMiB / 1024).toFixed(1)} GiB` : `0/${(perGpuMiB / 1024).toFixed(1)} GiB`}
      </span>
    </div>
    );
  };

  // GPUs referenced by no pod: keep the lane totals equal to node GPU memory.
  const otherGpusMiB = Math.max(gpuCount - lanes.length, 0) * perGpuMiB;

  return (
    <div className="space-y-1">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        GPU requests (per device)
      </p>
      {lanes.map((lane) => {
        const usedMiB = lane.segments.reduce((sum, s) => sum + s.memMiB, 0);
        return laneRow(lane.label, lane.segments, usedMiB, lane.uuid);
      })}
      {otherGpusMiB > 0 && (
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono text-muted-foreground w-16 shrink-0 truncate">
            Other GPUs
          </span>
          <div
            className="flex h-7 flex-1 items-center justify-center rounded border border-foreground/15 bg-muted/60 text-[10px] text-muted-foreground"
            title="GPUs with no pod placement annotation"
          >
            <span className="truncate">no placement annotation</span>
          </div>
          <span className="text-[10px] font-mono text-muted-foreground w-24 shrink-0 text-right">
            0/{(otherGpusMiB / 1024).toFixed(1)} GiB
          </span>
        </div>
      )}
      {unassigned.length > 0 &&
        laneRow('Unassigned', unassigned, unassigned.reduce((sum, s) => sum + s.memMiB, 0))}
    </div>
  );
}

function NodePodBar({ node, pods, metric, showAllPodsInList, title, hideBar, copyPod, copiedKey }) {
  const { weight: weightFn, format, label } = getMetricFields(metric, node);
  const [hoveredPod, setHoveredPod] = useState(null);

  const allocatable =
    metric === 'cpu'
      ? node.cpuUsage?.allocatable ?? 0
      : metric === 'gpu'
        ? (node.gpuMemTotalMiB || 0) > 0
          ? node.gpuMemTotalMiB
          : node.gpuCapacity ?? 0
        : node.memoryUsage?.allocatable ?? 0;

  const totalRequested = useMemo(() => {
    const { weight } = getMetricFields(metric, node);
    return pods.reduce((sum, p) => sum + weight(p), 0);
  }, [pods, metric, node]);

  const remainder = Math.max(0, allocatable - totalRequested);

  const podsSorted = [...pods].sort((a, b) => weightFn(b) - weightFn(a));
  const showLabelThreshold = 0.001;

  return (
    <div className="space-y-3">
      {title && <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>}
      {!hideBar && (
        <>
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
                  node={node}
                  metric={metric}
                  grow={grow}
                  showLabel={showLabel}
                  isActive={isActive}
                  onHoverPod={setHoveredPod}
                  copyPod={copyPod}
                  copiedKey={copiedKey}
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
                <span className="truncate">
                  {metric === 'gpu' && (node.gpuMemTotalMiB || 0) > 0
                    ? `free · ${formatGPUMem(remainder)}`
                    : 'free'}
                </span>
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
        </>
      )}

      {pods.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-semibold">Pods (top by {label} request)</p>
          <div className="flex flex-col gap-1">
            {(showAllPodsInList ? podsSorted : podsSorted.slice(0, 8)).map((pod) => {
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
                  <CopyablePodName pod={pod} onCopy={copyPod} copiedKey={copiedKey} className="text-xs" />
                  {(pod.requests?.gpu || 0) > 0 && (
                    <Badge
                      variant="outline"
                      className="text-[10px] border-purple-500 text-purple-700 shrink-0"
                    >
                      {pod.requests.gpu} GPU{pod.requests.gpuMemMiB > 0 ? ` / ${formatGPUMem(pod.requests.gpuMemMiB)}` : ''}
                    </Badge>
                  )}
                  {(pod.gpuDevices || []).map((d) => (
                    <Badge
                      key={`dev-${d.uuid || d.index}`}
                      variant="outline"
                      className="text-[10px] border-indigo-500 text-indigo-700 shrink-0"
                      title={d.uuid || undefined}
                    >
                      {shortGpuUuid(d.uuid) || `GPU ${d.index}`}
                      {d.memoryMiB > 0 && node.gpuMemTotalMiB > 0 ? ` · ${formatGPUMem(d.memoryMiB)}` : ''}
                    </Badge>
                  ))}
                  <span className="ml-auto text-muted-foreground font-mono shrink-0">{format(w)}</span>
                </div>
              );
            })}
            {!showAllPodsInList && podsSorted.length > 8 && (
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
  const [fallbackMode, setFallbackMode] = useState(false);
  const [metric, setMetric] = useState('cpu');
  const [nodePoolFilter, setNodePoolFilter] = useState('');
  const [zoneFilter, setZoneFilter] = useState('');
  const [nodeNameFilter, setNodeNameFilter] = useState('');
  const [podNsFilter, setPodNsFilter] = useState('');
  const [podNameFilter, setPodNameFilter] = useState('');
  const [showAllPodsInOverview, setShowAllPodsInOverview] = useState(false);
  const [hideDaemonSets, setHideDaemonSets] = useState(false);
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
            <Button
              size="sm"
              variant={showAllPodsInOverview ? 'default' : 'outline'}
              onClick={() => setShowAllPodsInOverview((prev) => !prev)}
            >
              {showAllPodsInOverview ? 'Overview: all pods' : 'Overview: top 8 pods'}
            </Button>
            <Button
              size="sm"
              variant={hideDaemonSets ? 'default' : 'outline'}
              onClick={() => setHideDaemonSets((prev) => !prev)}
            >
              {hideDaemonSets ? 'DaemonSets hidden' : 'Hide daemonsets'}
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
                  const nodePods = node.pods || [];
                  const pods = nodePods.filter((p) => {
                    if (!podNsMatch(p) || !podNameMatch(p)) return false;
                    if (hideDaemonSets && isDaemonSetPod(p)) return false;
                    return true;
                  });
                  const showDrilldown = expandedNodeName === node.name;

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
                            {(node.gpuCapacity > 0 || node.gpuAllocated > 0) && (
                              <Badge
                                variant="outline"
                                className="border-purple-500 text-purple-700"
                                title={node.gpuModel || 'GPU'}
                              >
                                {(() => {
                                  const memKnown = (node.gpuMemTotalMiB || 0) > 0;
                                  const hami = !!node.hamiDetected;
                                  if (hami && memKnown) {
                                    const pct = Math.min(Math.round((node.gpuMemAllocatedMiB / node.gpuMemTotalMiB) * 100), 100);
                                    return (
                                      <>
                                        🎮 {node.gpuCapacity || 0}x{node.gpuModel ? ` ${node.gpuModel}` : ' GPU'} · {pct}% GPU mem · {node.gpuPods || 0} GPU pods
                                      </>
                                    );
                                  }
                                  return (
                                    <>
                                      🎮 {node.gpuCapacity || 0}x{node.gpuModel ? ` ${node.gpuModel}` : ' GPU'} ({node.gpuAllocated ?? 0}/{node.gpuCapacity ?? 0})
                                      {memKnown && (
                                        <span className="ml-1">
                                          · {(node.gpuMemAllocatedMiB / 1024).toFixed(0)}/{(node.gpuMemTotalMiB / 1024).toFixed(0)} GiB
                                        </span>
                                      )}
                                    </>
                                  );
                                })()}
                              </Badge>
                            )}
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              setExpandedNodeName((prev) => (prev === node.name ? null : node.name))
                            }
                          >
                            {showDrilldown ? 'Hide node details' : 'Drill into node'}
                          </Button>
                          <span className="text-xs text-muted-foreground">
                            Full node pods: {nodePods.length}
                          </span>
                        </div>
                      </CardHeader>
                      <CardContent>
                        <NodePodBar
                          node={node}
                          pods={pods}
                          metric={metric}
                          showAllPodsInList={showAllPodsInOverview}
                          copyPod={copyPod}
                          copiedKey={copiedKey}
                        />
                        {(() => {
                          const gpuPods = pods.filter(
                            (p) => (p.requests?.gpu || 0) > 0 || (p.requests?.gpuMemMiB || 0) > 0,
                          );
                          if ((node.gpuCapacity || 0) === 0 && (node.gpuPods || 0) === 0) return null;
                          const laneMode = hasDevicePlacement(node, gpuPods);
                          return (
                            <div className="mt-4 space-y-3 border-t pt-3">
                              {laneMode ? (
                                <GPULaneBar node={node} pods={gpuPods} copyPod={copyPod} copiedKey={copiedKey} />
                              ) : (
                                <NodePodBar
                                  node={node}
                                  pods={gpuPods}
                                  metric="gpu"
                                  title="GPU requests"
                                  showAllPodsInList={showAllPodsInOverview}
                                  copyPod={copyPod}
                                  copiedKey={copiedKey}
                                />
                              )}
                              {laneMode && (
                                <NodePodBar
                                  node={node}
                                  pods={gpuPods}
                                  metric="gpu"
                                  hideBar
                                  showAllPodsInList={showAllPodsInOverview}
                                  copyPod={copyPod}
                                  copiedKey={copiedKey}
                                />
                              )}
                            </div>
                          );
                        })()}
                        {pods.length === 0 && (
                          <p className="text-xs text-muted-foreground mt-2">No pods match filters.</p>
                        )}
                        {showDrilldown && (
                          <div className="mt-4 space-y-2 border-t pt-3">
                            {(() => {
                              const detail = getNodeDetailFilters(node.name);
                              return (
                                <>
                                  <div className="flex items-center justify-between">
                                    <p className="text-xs font-semibold">
                                      Node detail pods (includes daemonsets)
                                    </p>
                                    <Badge variant="outline">{nodePods.length} pods</Badge>
                                  </div>
                                  <div className="flex flex-wrap gap-2 items-center">
                                    <Button
                                      size="sm"
                                      variant={detail.daemonSetsOnly ? 'default' : 'outline'}
                                      onClick={() =>
                                        setNodeDetailFilter(node.name, {
                                          daemonSetsOnly: !detail.daemonSetsOnly,
                                        })
                                      }
                                    >
                                      {detail.daemonSetsOnly ? 'DaemonSets only' : 'All pod types'}
                                    </Button>
                                    <Input
                                      value={detail.search}
                                      onChange={(e) =>
                                        setNodeDetailFilter(node.name, { search: e.target.value })
                                      }
                                      placeholder="Search in selected node"
                                      className="h-8 max-w-xs"
                                    />
                                  </div>
                                  <div className="max-h-72 overflow-y-auto space-y-1 pr-1">
                                    {nodePods
                                      .filter((pod) => {
                                        if (detail.daemonSetsOnly && !isDaemonSetPod(pod)) return false;
                                        if (!detail.search) return true;
                                        const q = detail.search.toLowerCase();
                                        return (
                                          pod.name.toLowerCase().includes(q) ||
                                          pod.namespace.toLowerCase().includes(q) ||
                                          (pod.workloadType || '').toLowerCase().includes(q)
                                        );
                                      })
                                      .map((pod) => (
                                        <div
                                          key={`detail-${getPodKey(pod)}`}
                                          className="flex items-center gap-2 text-xs rounded-md border bg-card/60 px-2 py-1 min-w-0"
                                          title={`${pod.namespace}/${pod.name}`}
                                        >
                                          <span
                                            className="inline-block w-2 h-2 rounded-full border border-foreground/10 shrink-0"
                                            style={{
                                              background: `hsl(${hashToHue(getPodKey(pod))} 70% 50% / 0.55)`,
                                            }}
                                          />
                                          <CopyablePodName
                                            pod={pod}
                                            onCopy={copyPod}
                                            copiedKey={copiedKey}
                                            className="text-xs"
                                          />
                                          {pod.workloadType && (
                                            <Badge variant="secondary" className="text-[10px]">
                                              {pod.workloadType}
                                            </Badge>
                                          )}
                                          <span className="ml-auto font-mono text-muted-foreground shrink-0">
                                            CPU {(pod.requests?.cpuCores || 0).toFixed(3)}
                                          </span>
                                          <span className="font-mono text-muted-foreground shrink-0">
                                            MEM {(pod.requests?.memoryGiB || 0).toFixed(2)}Gi
                                          </span>
                                          {(pod.requests?.gpu || 0) > 0 && (
                                            <Badge
                                              variant="outline"
                                              className="text-[10px] border-purple-500 text-purple-700 shrink-0"
                                            >
                                              {pod.requests.gpu} GPU{pod.requests.gpuMemMiB > 0 ? ` / ${formatGPUMem(pod.requests.gpuMemMiB)}` : ''}
                                            </Badge>
                                          )}
                                        </div>
                                      ))}
                                  </div>
                                </>
                              );
                            })()}
                          </div>
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

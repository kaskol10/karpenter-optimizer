import React, { useState, useMemo } from 'react';
import { Badge } from '../ui/badge';
import { cn, shortGpuUuid, formatGPUMem } from '../../lib/utils';
import { CopyablePodName } from './CopyablePodName';
import { getPodKey, hashToHue, getMetricFields } from './podUtils';

// HATCH is the "requested but not used" pattern drawn over the idle part of
// a pod's request.
export const HATCH = 'repeating-linear-gradient(135deg, hsl(var(--foreground) / 0.18) 0 2px, transparent 2px 6px)';

// podUsedShare is the pod's use as a share of its request for the bar's
// metric (cpu or memory), or null when there is no usage data.
export function podUsedShare(pod, metric) {
  if (!pod.usage) return null;
  const pairs = { cpu: ['cpuCores', 'cpuCores'], memory: ['memoryGiB', 'memoryGiB'] };
  const pair = pairs[metric];
  if (!pair) return null;
  const req = pod.requests?.[pair[0]] || 0;
  if (!(req > 0)) return null;
  return (pod.usage[pair[1]] || 0) / req;
}

function PodBarSegment({ pod, node, metric, grow, showLabel, isActive, isFocused, onHoverPod, copyPod, copiedKey }) {
  const { format, label, weight } = getMetricFields(metric, node);
  const w = weight(pod);
  const hue = hashToHue(getPodKey(pod));
  const used = podUsedShare(pod, metric);

  const titleLines = [
    `${pod.namespace}/${pod.name}`,
    pod.workloadType
      ? `Workload: ${pod.workloadType}${pod.workloadName ? `/${pod.workloadName}` : ''}`
      : null,
    `${label} req: ${format(w)}`,
    used != null
      ? `${label} used: ${format(w * used)} (${Math.round(used * 100)}% of request${used > 1 ? ', over its request' : ''})`
      : null,
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
      className="relative flex items-center justify-center border-r border-foreground/10 bg-card/80 hover:bg-accent transition-colors overflow-hidden"
      data-used={used != null ? Math.round(used * 100) : undefined}
      style={{
        flexGrow: grow,
        flexShrink: 0,
        flexBasis: 0,
        minWidth: 0,
        background: `hsl(${hue} 70% 50% / 0.18)`,
        outline: isFocused
          ? '2px solid hsl(var(--primary))'
          : isActive
            ? '2px solid hsl(190 90% 60% / 0.6)'
            : undefined,
        outlineOffset: isFocused || isActive ? '-2px' : undefined,
      }}
      title={titleLines.join('\n')}
      onMouseEnter={() => onHoverPod?.(pod)}
      onMouseLeave={() => onHoverPod?.(null)}
    >
      {used != null && used < 1 && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 right-0"
          style={{ left: `${Math.max(used, 0) * 100}%`, backgroundImage: HATCH }}
        />
      )}
      {used != null && used > 1 && (
        <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-1 bg-red-500/80" />
      )}
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

export function NodePodBar({ node, pods, metric, showAllPodsInList, title, hideBar, copyPod, copiedKey, focusPodKey }) {
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
                  isFocused={focusPodKey === getPodKey(pod)}
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
            {(showAllPodsInList
              ? podsSorted
              : podsSorted.filter((p, i) => i < 8 || getPodKey(p) === focusPodKey)
            ).map((pod) => {
              const w = weightFn(pod);
              return (
                <div
                  key={getPodKey(pod)}
                  className={cn(
                    'flex items-center gap-2 text-xs rounded-md border bg-card/60 px-2 py-1 min-w-0',
                    focusPodKey === getPodKey(pod) && 'border-primary ring-1 ring-primary/40',
                  )}
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

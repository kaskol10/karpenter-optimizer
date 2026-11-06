import React from 'react';
import { cn, shortGpuUuid, formatGPUMem } from '../../lib/utils';
import { CopyablePodName } from './CopyablePodName';
import { getPodKey, hashToHue } from './podUtils';

// GPULaneBar renders one lane per physical GPU, keyed by the HAMi device UUID
// (the annotation's index field is unreliable — two cards can both report
// index 0), plus an "Unassigned" lane for GPU pods without placement info.
// Segment width is the pod's memory on that device (MiB), against the node's
// per-GPU memory.
export function GPULaneBar({ node, pods, copyPod, copiedKey, focusPodKey, focusGpu }) {
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
          key,
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

  // Lanes (physical GPUs) holding the focused pod, plus the GPU named in the
  // deep link (it may no longer hold the pod after a reschedule).
  const focusedLaneKeys = new Set(
    lanes
      .filter(
        (lane) =>
          (focusGpu && lane.key === focusGpu) ||
          (focusPodKey && lane.segments.some((seg) => getPodKey(seg.pod) === focusPodKey)),
      )
      .map((lane) => lane.key),
  );

  const renderSegment = ({ pod, device, memMiB }) => {
    const hue = hashToHue(getPodKey(pod));
    // Focused pod: solid primary. Other pods on a focused GPU (its
    // neighbours): dashed amber, so "who shares this GPU" reads at a glance.
    const isFocusPod = !!focusPodKey && focusPodKey === getPodKey(pod);
    const isNeighbour =
      !isFocusPod && !!device && focusedLaneKeys.has(device.uuid || `idx-${device.index}`);
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
          outline: isFocusPod
            ? '2px solid hsl(var(--primary))'
            : isNeighbour
              ? '2px dashed hsl(38 92% 50%)'
              : undefined,
          outlineOffset: isFocusPod || isNeighbour ? '-2px' : undefined,
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

  // rowKey identifies the physical GPU (or 'unassigned') for React.
  const laneRow = (rowKey, label, segments, usedMiB, labelTitle, focused = false) => {
    const freeMiB = Math.max(perGpuMiB - usedMiB, 0);
    return (
    <div key={rowKey} className={cn('flex items-center gap-2', focused && 'rounded bg-primary/5 ring-1 ring-primary/40 -mx-1 px-1')}>
      <span
        className={cn(
          'text-[10px] font-mono w-16 shrink-0 truncate',
          focused ? 'text-primary font-semibold' : 'text-muted-foreground',
        )}
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
        return laneRow(lane.key, lane.label, lane.segments, usedMiB, lane.uuid, focusedLaneKeys.has(lane.key));
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
        laneRow('unassigned', 'Unassigned', unassigned, unassigned.reduce((sum, s) => sum + s.memMiB, 0))}
    </div>
  );
}

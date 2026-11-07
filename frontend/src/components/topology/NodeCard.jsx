import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Input } from '../ui/input';
import { cn, formatGPUMem } from '../../lib/utils';
import { CopyablePodName } from './CopyablePodName';
import { GPUTanks } from './GPUTanks';
import { NodePodBar } from './NodePodBar';
import { GpuSummaryBadge, MetaLine } from '../NodeBits';
import { getPodKey, formatNodeAge, hashToHue, isDaemonSetPod } from './podUtils';
import { nodeGpus } from '../../lib/gpuFit';

// NodeCard renders one node: its badges, request bars, GPU lanes and the
// optional drill-down list of every pod on the node. `pods` is the node's pods
// after the view's filters; the drill-down always lists them all.
export function NodeCard({
  node,
  pods,
  metric,
  focus,
  expanded,
  onToggleExpand,
  detailFilter,
  onDetailFilterChange,
  showAllPodsInList,
  copyPod,
  copiedKey,
  cardRef,
  fitMiB = null,
  onSelectGpu,
}) {
  const nodePods = node.pods || [];
  const isFocusNode = !!focus && focus.node === node.name;
  const focusPodKey = isFocusNode ? focus.pod : null;

  return (
    <Card ref={cardRef} className={cn(isFocusNode && 'ring-2 ring-primary shadow-lg')}>
      <CardHeader className="pb-2 space-y-1">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <CardTitle className="text-sm font-mono">{node.name}</CardTitle>
          <GpuSummaryBadge node={node} />
        </div>
        <MetaLine
          items={[
            node.instanceType,
            node.capacityType,
            node.zone,
            formatNodeAge(node.creationTime),
            `${nodePods.length} pods`,
          ]}
        />
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button size="sm" variant="outline" onClick={onToggleExpand}>
            {expanded ? 'Hide node details' : 'Drill into node'}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <NodePodBar
          node={node}
          pods={pods}
          metric={metric}
          showAllPodsInList={showAllPodsInList}
          copyPod={copyPod}
          copiedKey={copiedKey}
          focusPodKey={focusPodKey}
        />
        {(() => {
          const gpuPods = pods.filter(
            (p) => (p.requests?.gpu || 0) > 0 || (p.requests?.gpuMemMiB || 0) > 0,
          );
          if ((node.gpuCapacity || 0) === 0 && (node.gpuPods || 0) === 0) return null;
          // Tanks whenever the node's GPU memory is known: they need a per-card
          // size. Otherwise the count-based bar.
          const layout = nodeGpus(node);
          return (
            <div className="mt-4 space-y-3 border-t pt-3">
              {layout ? (
                <GPUTanks
                  layout={layout}
                  visibleKeys={new Set(gpuPods.map(getPodKey))}
                  fitMiB={fitMiB}
                  copyPod={copyPod}
                  copiedKey={copiedKey}
                  focusPodKey={focusPodKey}
                  focusGpu={isFocusNode ? focus.gpu || null : null}
                  onSelectGpu={onSelectGpu}
                />
              ) : (
                <NodePodBar
                  node={node}
                  pods={gpuPods}
                  metric="gpu"
                  title="GPU requests"
                  showAllPodsInList={showAllPodsInList}
                  copyPod={copyPod}
                  copiedKey={copiedKey}
                  focusPodKey={focusPodKey}
                />
              )}
              {layout && (
                <NodePodBar
                  node={node}
                  pods={gpuPods}
                  metric="gpu"
                  hideBar
                  showAllPodsInList={showAllPodsInList}
                  copyPod={copyPod}
                  copiedKey={copiedKey}
                  focusPodKey={focusPodKey}
                />
              )}
            </div>
          );
        })()}
        {pods.length === 0 && (
          <p className="text-xs text-muted-foreground mt-2">No pods match filters.</p>
        )}
        {expanded && (
          <div className="mt-4 space-y-2 border-t pt-3">
            {(() => {
              const detail = detailFilter;
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
                        onDetailFilterChange({
                          daemonSetsOnly: !detail.daemonSetsOnly,
                        })
                      }
                    >
                      {detail.daemonSetsOnly ? 'DaemonSets only' : 'All pod types'}
                    </Button>
                    <Input
                      value={detail.search}
                      onChange={(e) =>
                        onDetailFilterChange({ search: e.target.value })
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
}

import React from 'react';
import { ArrowRight, FileText } from 'lucide-react';
import { Badge } from '../ui/badge';
import { cn } from '../../lib/utils';
import { formatMiB, nodeGpus } from '../../lib/gpuFit';
import { getServingStatus } from '../../lib/servingStatus';
import { STATUS_TONE_CLASSES } from '../serving/shared';
import { GPUTanks } from './GPUTanks';
import { getPodKey } from './podUtils';

// GpuDetail is the GPU zoom level: one card as a large tank, then every slice
// on it named, with its share of the card and, for serving pods, its health
// and a link to its Serving card.
export function GpuDetail({ node, cardKey, servingPods, copyPod, copiedKey, onOpenServing, onOpenLogs, onZoomOut }) {
  const layout = node ? nodeGpus(node) : null;
  const gpu = layout?.gpus.find((g) => g.key === cardKey);
  if (!gpu) {
    return (
      <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
        {node ? `This GPU is no longer on ${node.name}.` : 'This node is no longer in the cluster.'}{' '}
        <button type="button" onClick={onZoomOut} className="font-medium text-foreground underline-offset-2 hover:underline">
          Zoom out
        </button>
      </div>
    );
  }

  const serving = new Map((servingPods || []).map((p) => [`${p.namespace}/${p.name}`, p]));
  return (
    <div className="grid gap-6 md:grid-cols-[14rem_1fr]">
      <div className="max-w-[14rem]">
        <GPUTanks layout={{ ...layout, gpus: [gpu], unplaced: [] }} copyPod={copyPod} copiedKey={copiedKey} />
        <p className="mt-2 break-all font-mono text-[10px] text-muted-foreground">{gpu.uuid || 'UUID unknown (no placement annotation)'}</p>
      </div>
      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {gpu.segments.length} slice{gpu.segments.length === 1 ? '' : 's'} on this card
        </p>
        {gpu.segments.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing is placed on this card.</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {gpu.segments
              .slice()
              .sort((a, b) => b.memMiB - a.memMiB)
              .map((seg) => {
                const key = getPodKey(seg.pod);
                const sp = serving.get(key);
                const status = sp ? getServingStatus(sp, servingPods) : null;
                return (
                  <li key={key} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs">
                    <button
                      type="button"
                      onClick={() => copyPod(seg.pod)}
                      title="Click to copy"
                      className={cn('font-mono font-medium hover:underline', copiedKey === key && 'text-emerald-600')}
                    >
                      {copiedKey === key ? 'Copied' : key}
                    </button>
                    <span className="tabular-nums text-muted-foreground">
                      {formatMiB(seg.memMiB)} · {Math.round((seg.memMiB / gpu.totalMiB) * 100)}% of the card
                      {seg.placed ? '' : ' · card not certain'}
                    </span>
                    {status && (
                      <Badge variant="outline" className={cn('text-[10px] font-semibold', STATUS_TONE_CLASSES[status.tone])}>
                        {status.label}
                      </Badge>
                    )}
                    <span className="ml-auto flex items-center gap-1">
                      {sp && onOpenServing && (
                        <button
                          type="button"
                          onClick={() => onOpenServing(sp)}
                          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-muted"
                          aria-label={`Open ${key} in Serving`}
                        >
                          Serving <ArrowRight className="h-3 w-3" aria-hidden="true" />
                        </button>
                      )}
                      {onOpenLogs && (
                        <button
                          type="button"
                          onClick={() => onOpenLogs(seg.pod)}
                          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-muted"
                          aria-label={`Open logs for ${key}`}
                        >
                          <FileText className="h-3.5 w-3.5" aria-hidden="true" /> Logs
                        </button>
                      )}
                    </span>
                  </li>
                );
              })}
          </ul>
        )}
      </div>
    </div>
  );
}

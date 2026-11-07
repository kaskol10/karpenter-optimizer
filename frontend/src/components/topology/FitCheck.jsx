import React from 'react';
import { Gpu } from 'lucide-react';
import { Input } from '../ui/input';
import { cn } from '../../lib/utils';
import { clusterFit, formatMiB, parseSize } from '../../lib/gpuFit';

// FitCheck is the "Will it fit?" box: type a GPU memory size and every card
// with that much free on one GPU lights up in the node cards below. The
// summary counts the nodes currently in view.
export function FitCheck({ value, onChange, nodes }) {
  const requestMiB = parseSize(value);
  const invalid = value.trim() !== '' && requestMiB == null;
  const fit = requestMiB ? clusterFit(nodes, requestMiB) : null;
  const gpuNodes = nodes.filter((n) => (n.gpuCapacity || 0) > 0 && (n.gpuMemTotalMiB || 0) > 0).length;

  let summary = 'Type a size to see which GPUs have that much free memory on one card.';
  let tone = 'text-muted-foreground';
  if (invalid) {
    summary = 'Use a size such as 40, 40 GiB or 24000 MiB.';
    tone = 'text-destructive';
  } else if (fit && gpuNodes === 0) {
    summary = 'No node in view reports its GPU memory.';
  } else if (fit && fit.gpus > 0) {
    summary = `${formatMiB(requestMiB)} fits on ${fit.gpus} GPU${fit.gpus === 1 ? '' : 's'} across ${fit.nodes} node${fit.nodes === 1 ? '' : 's'}.`;
    tone = 'text-green-700 dark:text-green-400';
  } else if (fit) {
    summary = `${formatMiB(requestMiB)} fits on no GPU in view. Largest free space on one card: ${formatMiB(fit.largestGapMiB)}.`;
    tone = 'text-amber-700 dark:text-amber-400';
  }
  if (fit && fit.maybeGpus > 0) {
    summary += ` ${fit.maybeGpus} more may fit (a pod without HAMi placement could be on them).`;
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2">
      <label htmlFor="gpu-fit-size" className="flex items-center gap-1.5 text-sm font-medium">
        <Gpu className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        Will it fit?
      </label>
      <Input
        id="gpu-fit-size"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="e.g. 40 GiB"
        aria-invalid={invalid}
        aria-describedby="gpu-fit-summary"
        className="h-8 w-32"
      />
      <p id="gpu-fit-summary" className={cn('text-xs', tone)} aria-live="polite">
        {summary}
        <span className="text-muted-foreground"> Memory only: HAMi also limits cores and tasks per card.</span>
      </p>
    </div>
  );
}

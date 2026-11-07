import React from 'react';
import { cn } from '../../lib/utils';
import { formatMiB, fragmentation, gpuFits } from '../../lib/gpuFit';
import { CopyablePodName } from './CopyablePodName';
import { getPodKey, hashToHue } from './podUtils';

// A segment shows its pod's name when it is at least this share of the tank.
const LABEL_MIN_SHARE = 0.14;

const FIT_RING = {
  yes: 'ring-2 ring-green-500 ring-offset-1 ring-offset-background',
  maybe: 'outline outline-2 outline-dashed outline-amber-400 outline-offset-2',
};

// GPUTanks draws each physical GPU of a node as a vertical tank, its pods'
// memory stacked from the bottom and free memory on top, with one line of
// fragmentation below ("66 GiB free, largest single gap 38 GiB").
//
// The layout (lib/gpuFit.js nodeGpus) uses every GPU pod on the node, so free
// memory is real even when filters hide some pods; hidden pods are drawn
// faded and unnamed. With a "Will it fit?" size, cards with room are ringed
// green ("maybe", amber dashed, when an unplaced pod could be on that card)
// and the rest fade.
export function GPUTanks({ layout, visibleKeys, fitMiB, copyPod, copiedKey, focusPodKey, focusGpu }) {
  const frag = fragmentation(layout);
  const focusedKeys = new Set(
    layout.gpus
      .filter(
        (g) =>
          (focusGpu && g.key === focusGpu) ||
          (focusPodKey && g.segments.some((s) => getPodKey(s.pod) === focusPodKey)),
      )
      .map((g) => g.key),
  );
  const fitCount = fitMiB ? layout.gpus.filter((g) => gpuFits(g, fitMiB) === 'yes').length : 0;

  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">GPU memory (per card)</p>
      <div className="flex gap-2 overflow-x-auto p-1" role="list" aria-label="GPUs">
        {layout.gpus.map((gpu) => {
          const fit = fitMiB ? gpuFits(gpu, fitMiB) : null;
          const focused = focusedKeys.has(gpu.key);
          const usedShare = gpu.totalMiB > 0 ? gpu.usedMiB / gpu.totalMiB : 0;
          const title = [
            gpu.uuid || 'GPU with no placement annotation (UUID unknown)',
            `${formatMiB(gpu.usedMiB)} of ${formatMiB(gpu.totalMiB)} requested, ${formatMiB(gpu.freeMiB)} free`,
            gpu.uncertain ? 'Includes a pod without HAMi placement: it may be on another card.' : null,
          ]
            .filter(Boolean)
            .join('\n');
          return (
            <div
              key={gpu.key}
              role="listitem"
              aria-label={`GPU ${gpu.label}: ${formatMiB(gpu.freeMiB)} free${fit === 'yes' ? ', fits' : fit === 'maybe' ? ', may fit' : ''}`}
              className={cn('flex min-w-[56px] sm:min-w-[76px] max-w-[160px] flex-1 flex-col items-stretch gap-1 transition-opacity', fit === 'no' && 'opacity-40')}
            >
              <div
                className={cn(
                  'relative flex h-40 flex-col-reverse overflow-hidden rounded-md border-2 bg-muted/40',
                  gpu.uncertain ? 'border-dashed border-foreground/30' : 'border-foreground/20',
                  focused && 'border-primary',
                  fit && FIT_RING[fit],
                )}
                title={title}
              >
                {gpu.segments.map((seg) => {
                  const key = getPodKey(seg.pod);
                  const share = gpu.totalMiB > 0 ? Math.min(seg.memMiB / gpu.totalMiB, 1) : 0;
                  const visible = !visibleKeys || visibleKeys.has(key);
                  const isFocusPod = !!focusPodKey && focusPodKey === key;
                  const isNeighbour = !isFocusPod && focused;
                  return (
                    <div
                      key={key}
                      className={cn(
                        'flex shrink-0 items-center justify-center overflow-hidden border-t border-background/70',
                        !visible && 'opacity-30',
                      )}
                      style={{
                        height: `${share * 100}%`,
                        background: `hsl(${hashToHue(key)} 65% 50% / ${seg.placed ? 0.35 : 0.2})`,
                        outline: isFocusPod
                          ? '2px solid hsl(var(--primary))'
                          : isNeighbour
                            ? '2px dashed hsl(38 92% 50%)'
                            : undefined,
                        outlineOffset: '-2px',
                      }}
                      title={`${key}\n${formatMiB(seg.memMiB)}${seg.placed ? '' : ' (card not known)'}`}
                    >
                      {visible && share >= LABEL_MIN_SHARE && (
                        <CopyablePodName pod={seg.pod} onCopy={copyPod} copiedKey={copiedKey} className="px-1 text-[10px]" />
                      )}
                    </div>
                  );
                })}
                {usedShare < 0.85 && (
                  <span className="absolute inset-x-0 top-1 text-center text-[10px] text-muted-foreground">
                    {formatMiB(gpu.freeMiB)} free
                  </span>
                )}
              </div>
              <span
                className={cn('truncate text-center font-mono text-[10px]', focused ? 'font-semibold text-primary' : 'text-muted-foreground')}
                title={gpu.uuid || undefined}
              >
                {gpu.label}
              </span>
            </div>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{formatMiB(frag.freeMiB)} free</span>
        {frag.freeMiB > 0 && <>, largest single gap {formatMiB(frag.largestGapMiB)}</>}
        {fitMiB ? (
          <span className={cn('ml-1', fitCount > 0 ? 'text-green-700 dark:text-green-400' : 'text-muted-foreground')}>
            · {formatMiB(fitMiB)} fits on {fitCount} card{fitCount === 1 ? '' : 's'} here
          </span>
        ) : null}
      </p>
      {layout.unplaced.length > 0 && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          {layout.unplaced.length} GPU pod{layout.unplaced.length > 1 ? 's' : ''} with no card that could hold{' '}
          {layout.unplaced.length > 1 ? 'them' : 'it'} ({formatMiB(layout.unplaced.reduce((s, u) => s + u.memMiB, 0))}):{' '}
          {layout.unplaced.map((u) => getPodKey(u.pod)).join(', ')}
        </p>
      )}
    </div>
  );
}

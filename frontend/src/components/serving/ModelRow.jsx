import React from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '../../lib/utils';
import { formatSeconds } from '../../lib/servingLatency';
import { STATUS_TONE_CLASSES } from './shared';

// Replica dots use the badge tone colours, solid, so a row reads at a glance:
// three green dots and one orange one.
const DOT_CLASSES = {
  green: 'bg-green-500',
  amber: 'bg-amber-500',
  orange: 'bg-orange-500',
  red: 'bg-red-500',
};

const fmtRate = (v, unit) => (v == null ? '–' : `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${unit}`);

function Stat({ label, value, title }) {
  return (
    <span className="flex flex-col leading-tight" title={title}>
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="tabular-nums font-medium">{value}</span>
    </span>
  );
}

// ModelRow is one model in the Serving tab: a header that answers "is this
// model healthy, and how loaded is it?" across all its replicas, expanding
// into the replica cards. Each replica dot is a button that opens the row
// and jumps to that replica's card.
export function ModelRow({ group, expanded, onToggle, onSelectReplica, children }) {
  const worst = [...group.statuses.values()].reduce((a, b) => (b.severity < a.severity ? b : a));
  const panelId = `model-row-${group.model.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  return (
    <section className={cn('rounded-lg border', worst.tone !== 'green' && 'border-l-4', worst.tone === 'red' && 'border-l-red-500', worst.tone === 'orange' && 'border-l-orange-500', worst.tone === 'amber' && 'border-l-amber-500')}>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-3 py-2.5">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={panelId}
          className="flex min-w-0 flex-1 basis-56 items-center gap-2 text-left"
        >
          <ChevronRight
            className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')}
            aria-hidden="true"
          />
          <span className="truncate font-mono text-sm font-semibold" title={group.model}>
            {group.model}
          </span>
          {worst.tone !== 'green' && (
            <span className={cn('shrink-0 rounded border px-1.5 text-[10px] font-semibold', STATUS_TONE_CLASSES[worst.tone])}>
              {worst.label}
            </span>
          )}
        </button>
        <span className="flex items-center gap-1" aria-label="Replicas">
          {group.replicas.map((pod) => {
            const status = group.statuses.get(pod);
            return (
              <button
                key={`${pod.namespace}/${pod.name}`}
                type="button"
                onClick={() => onSelectReplica(pod)}
                aria-label={`${pod.namespace}/${pod.name}: ${status.label}`}
                title={`${pod.namespace}/${pod.name}: ${status.label}`}
                className={cn(
                  'h-3 w-3 rounded-full ring-offset-background hover:ring-2 hover:ring-ring hover:ring-offset-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  DOT_CLASSES[status.tone],
                  !pod.online && 'opacity-60',
                )}
              />
            );
          })}
        </span>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs">
          <Stat label="Online" value={`${group.online}/${group.replicas.length}`} />
          <Stat label="Throughput" value={fmtRate(group.tokensPerSec, 'tok/s')} title="Generated tokens per second, all replicas" />
          <Stat label="Requests" value={fmtRate(group.requestsPerSec, 'req/s')} title="Completed requests per second, all replicas" />
          <Stat label="TTFT p95" value={group.ttftP95 == null ? '–' : formatSeconds(group.ttftP95)} title="Worst replica's p95 time to first token" />
          <Stat label="E2E p95" value={group.e2eP95 == null ? '–' : formatSeconds(group.e2eP95)} title="Worst replica's p95 end-to-end latency" />
          <Stat label="KV max" value={group.kvMax == null ? '–' : `${group.kvMax.toFixed(0)}%`} title="Fullest replica's KV cache" />
          <Stat label="Queue" value={`${group.running} / ${group.waiting}`} title="Running / waiting requests, all replicas" />
        </div>
      </div>
      {expanded && (
        <div id={panelId} className="border-t bg-muted/20 p-3">
          {children}
        </div>
      )}
    </section>
  );
}

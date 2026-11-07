import React, { useState } from 'react';
import { Badge } from '../ui/badge';
import { AlertTriangle, ArrowRight, FileText, Terminal, Check } from 'lucide-react';
import { cn } from '../../lib/utils';
import { formatDuration, kubectlCommands } from '../../lib/servingTriage';
import { topologyFocusFor } from '../../lib/servingPlacement';
import { STATUS_TONE_CLASSES, copyText } from './shared';

// KubectlMenu: a small disclosure with copy-ready commands. A native
// <details> keeps it keyboard-accessible without a portal.
function KubectlMenu({ pod }) {
  const [copied, setCopied] = useState(null);
  const copy = (command) =>
    copyText(command, () => {
      setCopied(command);
      setTimeout(() => setCopied(null), 1200);
    });
  return (
    <details className="relative">
      <summary
        className="list-none cursor-pointer inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-muted [&::-webkit-details-marker]:hidden"
        aria-label={`kubectl commands for ${pod.namespace}/${pod.name}`}
      >
        <Terminal className="h-3.5 w-3.5" aria-hidden="true" />
        kubectl
      </summary>
      <div className="absolute right-0 z-20 mt-1 w-max max-w-[min(32rem,80vw)] rounded-md border bg-popover p-1 shadow-md">
        {kubectlCommands(pod).map(({ label, command }) => (
          <button
            key={command}
            type="button"
            onClick={() => copy(command)}
            title="Click to copy"
            className="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-muted"
          >
            <span className="w-24 shrink-0 text-muted-foreground">{copied === command ? 'Copied' : label}</span>
            <code className="truncate font-mono text-[11px]">{command}</code>
            {copied === command && <Check className="h-3 w-3 shrink-0 text-green-600" aria-hidden="true" />}
          </button>
        ))}
      </div>
    </details>
  );
}

// TriageList is the top of the Serving tab when something is wrong: one line
// per replica that needs a human, worst first, with how long it has been
// going on and the three places an on-call engineer goes next. Renders
// nothing when every replica is OK.
export function TriageList({ items, onOpenTopology, onOpenLogs, onFocusCard }) {
  if (!items || items.length === 0) return null;
  return (
    <section
      aria-label="Needs attention"
      className="rounded-lg border border-amber-300 bg-amber-50/60 dark:border-amber-500/40 dark:bg-amber-500/5"
    >
      <h3 className="flex items-center gap-2 px-3 pt-2.5 pb-1.5 text-sm font-semibold">
        <AlertTriangle className="h-4 w-4 text-amber-600" aria-hidden="true" />
        Needs attention
        <span className="text-xs font-normal text-muted-foreground">
          {items.length} replica{items.length > 1 ? 's' : ''}
        </span>
      </h3>
      <ul className="divide-y divide-amber-200/70 dark:divide-amber-500/20">
        {items.map(({ key, pod, placement, status, since }) => {
          const focus = topologyFocusFor(pod, placement);
          // getServingStatus already folds the neighbour sentence into the
          // reasons when the GPU is shared, so the reasons are the whole story.
          const reason = status.reasons.join(' · ');
          return (
            <li key={key} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs">
              <Badge
                variant="outline"
                className={cn('shrink-0 text-[10px] font-semibold', STATUS_TONE_CLASSES[status.tone])}
              >
                {status.label}
              </Badge>
              <button
                type="button"
                onClick={() => onFocusCard?.(pod)}
                className="font-mono font-medium hover:underline"
                title="Jump to this replica's card"
              >
                {key}
              </button>
              {pod.model && <span className="text-muted-foreground truncate max-w-[16rem]">{pod.model}</span>}
              <span className="min-w-0 flex-1 basis-64 truncate" title={reason}>
                {reason}
              </span>
              {since && (
                <span className="shrink-0 tabular-nums text-muted-foreground" title={new Date(since * 1000).toLocaleString()}>
                  for {formatDuration(Date.now() / 1000 - since)}
                </span>
              )}
              <span className="flex shrink-0 items-center gap-1">
                {focus && onOpenTopology && (
                  <button
                    type="button"
                    onClick={() => onOpenTopology(focus)}
                    className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-muted"
                    aria-label={`Show ${key} in topology`}
                  >
                    Topology <ArrowRight className="h-3 w-3" aria-hidden="true" />
                  </button>
                )}
                {onOpenLogs && (
                  <button
                    type="button"
                    onClick={() => onOpenLogs(pod)}
                    className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-muted"
                    aria-label={`Open logs for ${key}`}
                  >
                    <FileText className="h-3.5 w-3.5" aria-hidden="true" /> Logs
                  </button>
                )}
                <KubectlMenu pod={pod} />
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

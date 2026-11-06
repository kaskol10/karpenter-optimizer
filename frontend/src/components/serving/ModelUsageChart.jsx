import React, { useMemo } from 'react';
import { BarChart3 } from 'lucide-react';
import { cn } from '../../lib/utils';

// ModelUsageChart ranks the serving pods by throughput (tok/s) to show which
// models are the most used, with a small queue (running+waiting) indicator.
export function ModelUsageChart({ pods }) {
  const rows = useMemo(() => {
    const withUsage = pods.filter(
      (p) => p.online && p.tokensPerSec !== null && p.tokensPerSec !== undefined,
    );
    const max = Math.max(1, ...withUsage.map((p) => p.tokensPerSec));
    return withUsage
      .slice()
      .sort((a, b) => b.tokensPerSec - a.tokensPerSec)
      .map((p, i) => ({ pod: p, rank: i + 1, pct: (p.tokensPerSec / max) * 100 }));
  }, [pods]);

  if (rows.length === 0) {
    return null;
  }

  return (
    <div className="mb-4 rounded-md border bg-card/40 p-3">
      <p className="text-xs font-semibold flex items-center gap-1.5 mb-2 text-muted-foreground">
        <BarChart3 className="h-3.5 w-3.5" />
        Model usage (throughput)
      </p>
      <div className="space-y-1.5">
        {rows.map(({ pod, rank, pct }) => {
          const queue = (pod.running || 0) + (pod.waiting || 0);
          return (
            <div key={`${pod.namespace}/${pod.name}`} className="flex items-center gap-2">
              <span className="w-4 text-right text-[10px] font-mono text-muted-foreground shrink-0">
                {rank}
              </span>
              <span className="w-32 truncate text-xs shrink-0" title={`${pod.namespace}/${pod.name} — ${pod.model || 'unknown model'}`}>
                {pod.model || `${pod.namespace}/${pod.name}`}
              </span>
              <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full bg-purple-500"
                  style={{ width: `${Math.max(pct, 1.5)}%` }}
                />
              </div>
              <span className="w-20 text-right text-[10px] font-mono shrink-0">
                {pod.tokensPerSec.toFixed(1)} tok/s
              </span>
              <span
                className={cn(
                  'w-20 text-right text-[10px] shrink-0 font-mono',
                  (pod.waiting || 0) > 0 ? 'text-yellow-600 font-semibold' : 'text-muted-foreground',
                )}
                title={`running: ${pod.running ?? 0}, waiting: ${pod.waiting ?? 0}`}
              >
                {queue} in-flight
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

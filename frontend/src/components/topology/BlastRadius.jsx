import React from 'react';
import { AlertTriangle } from 'lucide-react';

// BlastRadiusSummary is the Cluster-level count of workloads whose replicas
// all share one node or one zone, expandable to name them. Renders nothing
// when every multi-replica workload is spread out.
export function BlastRadiusSummary({ risks, onSelectNode }) {
  if (risks.length === 0) return null;
  const onNode = risks.filter((r) => r.risk === 'node').length;
  const onZone = risks.length - onNode;
  const parts = [
    onNode > 0 && `${onNode} on a single node`,
    onZone > 0 && `${onZone} in a single zone`,
  ].filter(Boolean);
  return (
    <details className="rounded-lg border border-amber-300 bg-amber-50/60 px-3 py-2 text-sm dark:border-amber-500/40 dark:bg-amber-500/5">
      <summary className="cursor-pointer select-none">
        <AlertTriangle className="mr-1.5 inline h-4 w-4 text-amber-600" aria-hidden="true" />
        <span className="font-medium">
          {risks.length} workload{risks.length === 1 ? ' has' : 's have'} every replica in one place
        </span>
        <span className="text-muted-foreground">: {parts.join(', ')}</span>
      </summary>
      <ul className="mt-2 space-y-1 text-xs">
        {risks.map((r) => (
          <li key={r.key} className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-mono font-medium">
              {r.namespace}/{r.name}
            </span>
            <span className="text-muted-foreground">
              {r.type} · {r.replicas} replicas ·{' '}
              {r.risk === 'node' ? (
                <>
                  all on{' '}
                  <button type="button" onClick={() => onSelectNode(r.nodes[0])} className="font-mono underline-offset-2 hover:underline">
                    {r.nodes[0]}
                  </button>
                </>
              ) : (
                <>all in {r.zones[0]} ({r.nodes.length} nodes)</>
              )}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

// BlastRadiusNote names, on a node card, the workloads whose replicas are all
// on that node.
export function BlastRadiusNote({ risks }) {
  if (risks.length === 0) return null;
  return (
    <p className="flex items-start gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
      <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>
        Every replica of {risks.map((r) => `${r.namespace}/${r.name} (${r.replicas})`).join(', ')} runs on this node: draining or losing
        it takes {risks.length === 1 ? 'that workload' : 'those workloads'} down.
      </span>
    </p>
  );
}

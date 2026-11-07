import React from 'react';
import { formatMiB } from '../../lib/gpuFit';
import { diffSummary } from '../../lib/topologyHistory';

const LIST_LIMIT = 8;

function NodeLinks({ names, onSelectNode }) {
  return (
    <span className="inline-flex flex-wrap gap-x-2">
      {names.slice(0, LIST_LIMIT).map((name) => (
        <button key={name} type="button" className="font-mono hover:underline" onClick={() => onSelectNode(name)}>
          {name}
        </button>
      ))}
      {names.length > LIST_LIMIT && <span className="text-muted-foreground">+{names.length - LIST_LIMIT} more</span>}
    </span>
  );
}

// reasonCounts groups removed nodes by their last Karpenter disruption reason.
function reasonCounts(removed, events) {
  const reasonOf = new Map(events.filter((e) => e.type === 'node-removed').map((e) => [e.node, e.reason || 'reason unknown']));
  const counts = new Map();
  removed.forEach((n) => {
    const r = reasonOf.get(n.name) || 'reason unknown';
    counts.set(r, (counts.get(r) || 0) + 1);
  });
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
}

// ChangesPanel lists what changed between the compare moment and now: new
// and removed nodes (with Karpenter's reason when it was seen), pods that
// moved, and GPUs whose largest free slice shrank.
export function ChangesPanel({ diff, events = [], since, onSelectNode }) {
  const reasons = reasonCounts(diff.removedNodes, events);
  return (
    <section className="space-y-1.5 rounded-lg border border-dashed px-3 py-2.5 text-xs" aria-label="Changes since">
      <p className="font-medium">
        Since {since}: <span className="font-normal">{diffSummary(diff)}</span>
      </p>
      {diff.addedNodes.length > 0 && (
        <p>
          <span className="mr-1.5 inline-block h-2 w-2 rounded-sm bg-emerald-500" aria-hidden="true" />
          Launched: <NodeLinks names={diff.addedNodes} onSelectNode={onSelectNode} />
        </p>
      )}
      {diff.removedNodes.length > 0 && (
        <p>
          <span className="mr-1.5 inline-block h-2 w-2 rounded-sm border border-dashed border-red-500" aria-hidden="true" />
          Removed ({reasons.map(([r, n]) => `${r} ×${n}`).join(', ')}):{' '}
          <span className="font-mono">
            {diff.removedNodes
              .slice(0, LIST_LIMIT)
              .map((n) => n.name)
              .join(', ')}
            {diff.removedNodes.length > LIST_LIMIT ? ` +${diff.removedNodes.length - LIST_LIMIT} more` : ''}
          </span>
        </p>
      )}
      {diff.movedPods.length > 0 && (
        <details>
          <summary className="cursor-pointer">
            {diff.movedPods.length} pod{diff.movedPods.length === 1 ? '' : 's'} moved
          </summary>
          <ul className="mt-1 space-y-0.5 font-mono">
            {diff.movedPods.slice(0, 50).map((m) => (
              <li key={m.pod}>
                {m.pod}: {m.from} → {m.to}
              </li>
            ))}
          </ul>
        </details>
      )}
      {diff.gpuShrunk.length > 0 && (
        <p>
          Largest free GPU slice shrank on{' '}
          {diff.gpuShrunk.slice(0, LIST_LIMIT).map((g, i) => (
            <React.Fragment key={g.node}>
              {i > 0 && ', '}
              <button type="button" className="font-mono hover:underline" onClick={() => onSelectNode(g.node)}>
                {g.node}
              </button>{' '}
              ({formatMiB(g.beforeMiB)} → {formatMiB(g.afterMiB)})
            </React.Fragment>
          ))}
        </p>
      )}
    </section>
  );
}

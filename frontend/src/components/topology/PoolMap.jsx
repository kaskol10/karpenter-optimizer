import React from 'react';
import { groupNodes, lensColor, nodeFullness } from '../../lib/topologyLenses';

function MiniBar({ label, value }) {
  if (value == null) return null;
  return (
    <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
      <span className="w-7 shrink-0">{label}</span>
      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <span className="block h-full rounded-full bg-foreground/50" style={{ width: `${Math.round(value * 100)}%` }} />
      </span>
      <span className="w-8 shrink-0 text-right tabular-nums">{Math.round(value * 100)}%</span>
    </div>
  );
}

// PoolMap is the NodePool zoom level: the pool's nodes as larger tiles with
// their name, instance type, the lens value and request bars.
export function PoolMap({ nodes, lens, ctx, onSelectNode }) {
  const [group] = groupNodes(nodes);
  if (!group) return null;
  return (
    <div className="space-y-4">
      {group.zones.map((zone) => (
        <section key={zone.zone} aria-label={zone.zone}>
          <p className="mb-2 text-xs font-medium text-muted-foreground">{zone.zone}</p>
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-2">
            {zone.nodes.map((node) => {
              const c = lensColor(lens, node, ctx);
              const f = nodeFullness(node);
              return (
                <li key={node.name}>
                  <button
                    type="button"
                    onClick={() => onSelectNode(node.name)}
                    aria-label={`${node.name}: ${c.value}`}
                    title={c.title}
                    className="w-full rounded-md border border-l-[6px] bg-card p-2 text-left hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    style={{ borderLeftColor: c.fill }}
                  >
                    <span className="block truncate font-mono text-xs font-medium">{node.name}</span>
                    <span className="flex justify-between text-[10px] text-muted-foreground">
                      <span className="truncate">
                        {node.instanceType}
                        {node.capacityType ? ` · ${node.capacityType}` : ''}
                      </span>
                      <span className="ml-2 shrink-0 font-medium text-foreground">{c.value}</span>
                    </span>
                    <span className="mt-1.5 block space-y-0.5">
                      <MiniBar label="CPU" value={f.cpu} />
                      <MiniBar label="Mem" value={f.memory} />
                      <MiniBar label="GPU" value={f.gpu} />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

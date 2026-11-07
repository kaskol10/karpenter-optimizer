import React from 'react';
import { cn } from '../../lib/utils';
import { lensColor } from '../../lib/topologyLenses';

// Minimap keeps the whole cluster in the corner below the Cluster level: one
// dot per node in the lens colour, the current one outlined. Clicking a dot
// jumps to that node; the title zooms back out.
export function Minimap({ nodes, lens, ctx, current, onSelectNode, onZoomOut }) {
  if (nodes.length === 0) return null;
  return (
    <aside
      aria-label="Cluster minimap"
      className="fixed bottom-4 right-4 z-30 hidden w-44 rounded-lg border bg-card/95 p-2 shadow-lg backdrop-blur md:block"
    >
      <button type="button" onClick={onZoomOut} className="mb-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground hover:underline">
        Cluster · {nodes.length} nodes
      </button>
      <ul className="flex max-h-32 flex-wrap gap-0.5 overflow-y-auto">
        {nodes.map((node) => {
          const c = lensColor(lens, node, ctx);
          return (
            <li key={node.name}>
              <button
                type="button"
                onClick={() => onSelectNode(node.name)}
                aria-label={`Go to ${node.name}`}
                aria-current={current.has(node.name) || undefined}
                title={`${node.name}: ${c.value}`}
                className={cn('block h-2.5 w-2.5 rounded-[2px]', current.has(node.name) && 'ring-2 ring-primary ring-offset-1 ring-offset-card')}
                style={{ background: c.fill }}
              />
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

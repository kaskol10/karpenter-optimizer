import React, { useMemo } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '../../lib/utils';
import { groupNodes, lensColor, tileSize } from '../../lib/topologyLenses';

// tileRange is the smallest and largest tile side (px) for a cluster size.
export function tileRange(count) {
  if (count > 300) return [10, 22];
  if (count > 100) return [12, 30];
  return [22, 56];
}

// PoolCount says how many nodes a NodePool has; in compare mode the ghosts
// of removed nodes are counted apart ("14 nodes, 4 removed").
function PoolCount({ group }) {
  const removed = group.zones.reduce((sum, z) => sum + z.nodes.filter((n) => n.change === 'removed').length, 0);
  const count = group.count - removed;
  return (
    <span className="text-xs font-normal text-muted-foreground">
      {count} node{count === 1 ? '' : 's'}
      {removed > 0 && `, ${removed} removed`}
    </span>
  );
}

const CHANGE_LABEL = { added: ' (launched since then)' };

// ClusterMap is the Cluster zoom level: every node as a small tile, grouped
// by NodePool and zone, sized by allocatable CPU and coloured by the lens.
// Plain DOM tiles: a 1,000-node cluster is 1,000 small buttons, which the
// browser lays out in a few milliseconds. In compare mode nodes carry a
// `change`: launched nodes get a green ring, removed ones come back as
// dashed red ghosts.
export function ClusterMap({ nodes, lens, ctx, onSelectNode, onSelectPool, drained = new Set() }) {
  const groups = useMemo(() => groupNodes(nodes), [nodes]);
  const maxCpu = useMemo(() => Math.max(0, ...nodes.map((n) => n.cpuUsage?.allocatable || 0)), [nodes]);
  // Smaller tiles as the cluster grows, so a few hundred nodes fit on one screen.
  const [minPx, maxPx] = tileRange(nodes.length);

  return (
    <div className="grid gap-x-8 gap-y-5 lg:grid-cols-2">
      {groups.map((group) => (
        <section key={group.pool} aria-label={`NodePool ${group.pool}`}>
          <button
            type="button"
            onClick={() => onSelectPool(group.pool)}
            className="mb-2 flex items-center gap-1.5 text-sm font-semibold hover:underline"
          >
            {group.pool}
            <PoolCount group={group} />
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
          </button>
          <div className="space-y-2">
            {group.zones.map((zone) => (
              <div key={zone.zone} className="flex items-start gap-3">
                <span className="w-20 shrink-0 pt-0.5 text-[11px] text-muted-foreground">{zone.zone}</span>
                <ul className="flex flex-wrap items-end gap-1" aria-label={`${group.pool} in ${zone.zone}`}>
                  {zone.nodes.map((node) => {
                    const c = lensColor(lens, node, ctx);
                    const size = tileSize(node, maxCpu, minPx, maxPx);
                    const ghost = node.change === 'removed';
                    return (
                      <li key={node.name}>
                        <button
                          type="button"
                          onClick={() => onSelectNode(node.name)}
                          aria-label={`${node.name}: ${ghost ? 'removed since then' : c.value}${CHANGE_LABEL[node.change] || ''}${drained.has(node.name) ? ' (simulated drain)' : ''}`}
                          title={`${node.name}\n${node.instanceType || ''}\n${c.title}`}
                          className={cn(
                            'block rounded-sm ring-offset-background transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
                            drained.has(node.name) && 'opacity-30 outline outline-2 outline-dashed outline-sky-500',
                            node.change === 'added' && 'ring-2 ring-emerald-500 ring-offset-2',
                            ghost && 'border-2 border-dashed border-red-500',
                          )}
                          style={{ width: size, height: size, background: ghost ? 'transparent' : c.fill }}
                        />
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

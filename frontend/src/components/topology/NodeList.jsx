import React, { useCallback, useState } from 'react';
import { Badge } from '../ui/badge';
import { Separator } from '../ui/separator';
import { NodeCard } from './NodeCard';

const DEFAULT_DETAIL = { daemonSetsOnly: false, search: '' };

// NodeList is the Node zoom level: node cards grouped by NodePool. It owns
// the per-card drill-down state (which card is expanded, each card's detail
// filters); everything else comes from TopologyView. `cardProps(node)`
// returns the props that differ per node.
export function NodeList({ groups, cardProps }) {
  const [expandedNodeName, setExpandedNodeName] = useState(null);
  const [detailFilters, setDetailFilters] = useState({});

  const setDetailFilter = useCallback((nodeName, partial) => {
    setDetailFilters((prev) => ({
      ...prev,
      [nodeName]: { ...DEFAULT_DETAIL, ...(prev[nodeName] || {}), ...partial },
    }));
  }, []);

  return (
    <div className="space-y-8">
      {groups.map(([poolName, poolNodes], idx) => (
        <div key={poolName}>
          <div className="mb-3 flex items-center gap-2">
            <h3 className="text-base font-semibold">{poolName}</h3>
            <Badge variant="secondary">
              {poolNodes.length} node{poolNodes.length === 1 ? '' : 's'}
            </Badge>
          </div>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            {poolNodes.map((node) => (
              <NodeCard
                key={node.name}
                node={node}
                expanded={expandedNodeName === node.name}
                onToggleExpand={() => setExpandedNodeName((prev) => (prev === node.name ? null : node.name))}
                detailFilter={detailFilters[node.name] || DEFAULT_DETAIL}
                onDetailFilterChange={(partial) => setDetailFilter(node.name, partial)}
                {...cardProps(node)}
              />
            ))}
          </div>
          {idx < groups.length - 1 && <Separator className="mt-8" />}
        </div>
      ))}
    </div>
  );
}

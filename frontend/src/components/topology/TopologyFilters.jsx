import React from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { cn } from '../../lib/utils';

// TopologyFilters is the Filters card: metric, overview toggles, and the
// NodePool / zone / node / pod filters (all URL-backed in TopologyView).
export function TopologyFilters({
  metric,
  setMetric,
  showAllPodsInOverview,
  setShowAllPodsInOverview,
  hideDaemonSets,
  setHideDaemonSets,
  nodePools,
  nodePoolFilter,
  setNodePoolFilter,
  zones,
  zoneFilter,
  setZoneFilter,
  nodeNameFilter,
  setNodeNameFilter,
  podNsFilter,
  setPodNsFilter,
  podNameFilter,
  setPodNameFilter,
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Filters</CardTitle>
        <CardDescription>Group by NodePool; narrow nodes and pods.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2 items-center">
          <span className="text-sm text-muted-foreground">Metric:</span>
          <Button
            size="sm"
            variant={metric === 'cpu' ? 'default' : 'outline'}
            onClick={() => setMetric('cpu')}
          >
            CPU
          </Button>
          <Button
            size="sm"
            variant={metric === 'memory' ? 'default' : 'outline'}
            onClick={() => setMetric('memory')}
          >
            Memory
          </Button>
          <Button
            size="sm"
            variant={showAllPodsInOverview ? 'default' : 'outline'}
            onClick={() => setShowAllPodsInOverview((prev) => !prev)}
          >
            {showAllPodsInOverview ? 'Overview: all pods' : 'Overview: top 8 pods'}
          </Button>
          <Button
            size="sm"
            variant={hideDaemonSets ? 'default' : 'outline'}
            onClick={() => setHideDaemonSets((prev) => !prev)}
          >
            {hideDaemonSets ? 'DaemonSets hidden' : 'Hide daemonsets'}
          </Button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          <div>
            <label className="text-xs text-muted-foreground">NodePool</label>
            <select
              className={cn(
                'mt-1 flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm',
              )}
              value={nodePoolFilter}
              onChange={(e) => setNodePoolFilter(e.target.value)}
            >
              <option value="">All</option>
              {nodePools.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Zone</label>
            <select
              className={cn(
                'mt-1 flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm',
              )}
              value={zoneFilter}
              onChange={(e) => setZoneFilter(e.target.value)}
            >
              <option value="">All</option>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Node name contains</label>
            <Input
              className="mt-1"
              value={nodeNameFilter}
              onChange={(e) => setNodeNameFilter(e.target.value)}
              placeholder="filter"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Pod namespace contains</label>
            <Input
              className="mt-1"
              value={podNsFilter}
              onChange={(e) => setPodNsFilter(e.target.value)}
              placeholder="e.g. prod"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Pod name contains</label>
            <Input
              className="mt-1"
              value={podNameFilter}
              onChange={(e) => setPodNameFilter(e.target.value)}
              placeholder="filter"
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

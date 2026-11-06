import React from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { SimpleSelect } from '../ui/simple-select';

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
            <SimpleSelect
              className="mt-1 h-9"
              ariaLabel="NodePool"
              value={nodePoolFilter}
              onValueChange={setNodePoolFilter}
              options={[{ value: '', label: 'All' }, ...nodePools.map((p) => ({ value: p, label: p }))]}
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Zone</label>
            <SimpleSelect
              className="mt-1 h-9"
              ariaLabel="Zone"
              value={zoneFilter}
              onValueChange={setZoneFilter}
              options={[{ value: '', label: 'All' }, ...zones.map((z) => ({ value: z, label: z }))]}
            />
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

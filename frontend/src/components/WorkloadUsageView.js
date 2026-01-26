import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from './ui/card';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Switch } from './ui/switch';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { RefreshCw, Loader2, Search, X, ChevronLeft, ChevronRight, Columns, Eye, EyeOff } from 'lucide-react';
import { cn } from '../lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { Checkbox } from './ui/checkbox';

const API_URL = (window.ENV && window.ENV.hasOwnProperty('REACT_APP_API_URL')) 
  ? window.ENV.REACT_APP_API_URL 
  : (process.env.REACT_APP_API_URL || '');

const ITEMS_PER_PAGE = 50; // Increased from 20 to reduce pagination

// Column definitions
const COLUMNS = {
  name: { key: 'name', label: 'Name', defaultVisible: true, essential: true },
  namespace: { key: 'namespace', label: 'Namespace', defaultVisible: true, essential: true },
  type: { key: 'type', label: 'Type', defaultVisible: true, essential: true },
  replicas: { key: 'replicas', label: 'Replicas', defaultVisible: true, essential: false },
  runningPods: { key: 'runningPods', label: 'Running Pods', defaultVisible: true, essential: true },
  cpuUsed: { key: 'cpuUsed', label: 'CPU Used', defaultVisible: true, essential: true },
  memoryUsed: { key: 'memoryUsed', label: 'Memory Used', defaultVisible: true, essential: true },
  cpuRequest: { key: 'cpuRequest', label: 'CPU Request', defaultVisible: false, essential: false },
  memoryRequest: { key: 'memoryRequest', label: 'Memory Request', defaultVisible: false, essential: false },
  cpuLimit: { key: 'cpuLimit', label: 'CPU Limit', defaultVisible: false, essential: false },
  memoryLimit: { key: 'memoryLimit', label: 'Memory Limit', defaultVisible: false, essential: false },
  gpu: { key: 'gpu', label: 'GPU', defaultVisible: false, essential: false },
};

function WorkloadUsageView() {
  const [workloads, setWorkloads] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshInterval, setRefreshInterval] = useState(60);
  const [sortBy, setSortBy] = useState('name');
  const [sortOrder, setSortOrder] = useState('asc');
  const [typeFilter, setTypeFilter] = useState('all');
  const [namespaceFilter, setNamespaceFilter] = useState('');
  const [nameFilter, setNameFilter] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [visibleColumns, setVisibleColumns] = useState(() => {
    // Initialize with default visible columns
    const defaults = {};
    Object.keys(COLUMNS).forEach(key => {
      defaults[key] = COLUMNS[key].defaultVisible;
    });
    return defaults;
  });

  useEffect(() => {
    fetchWorkloads();
  }, []);

  useEffect(() => {
    let interval;
    if (autoRefresh) {
      interval = setInterval(() => {
        fetchWorkloads();
      }, refreshInterval * 1000);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [autoRefresh, refreshInterval]);

  useEffect(() => {
    setCurrentPage(1); // Reset to first page when filters change
  }, [typeFilter, namespaceFilter, nameFilter]);

  const fetchWorkloads = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await axios.get(`${API_URL}/api/v1/workloads/all`);
      const workloadsData = response.data.workloads || [];
      setWorkloads(workloadsData);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to fetch workloads');
      console.error('Workloads error:', err);
    } finally {
      setLoading(false);
    }
  };

  const formatResource = (value) => {
    if (!value) return 'N/A';
    return value;
  };

  const parseResource = (value) => {
    if (!value) return 0;
    // Simple parsing for common formats
    if (value.endsWith('m')) {
      return parseFloat(value) / 1000; // millicores to cores
    }
    if (value.endsWith('Mi')) {
      return parseFloat(value) / 1024; // MiB to GiB
    }
    if (value.endsWith('Gi')) {
      return parseFloat(value);
    }
    return parseFloat(value) || 0;
  };

  const sortWorkloads = (workloadList) => {
    const sorted = [...workloadList];
    sorted.sort((a, b) => {
      let aValue, bValue;
      
      switch (sortBy) {
        case 'name':
          aValue = a.name || '';
          bValue = b.name || '';
          break;
        case 'namespace':
          aValue = a.namespace || '';
          bValue = b.namespace || '';
          break;
        case 'type':
          aValue = a.type || '';
          bValue = b.type || '';
          break;
        case 'replicas':
          aValue = a.replicas || 0;
          bValue = b.replicas || 0;
          break;
        case 'cpu':
          // Sort by CPU usage if available, otherwise by CPU request
          aValue = a.cpuUsed ?? parseResource(a.cpuRequest);
          bValue = b.cpuUsed ?? parseResource(b.cpuRequest);
          break;
        case 'memory':
          // Sort by Memory usage if available, otherwise by Memory request
          aValue = a.memoryUsed ?? parseResource(a.memoryRequest);
          bValue = b.memoryUsed ?? parseResource(b.memoryRequest);
          break;
        default:
          return 0;
      }
      
      if (typeof aValue === 'string') {
        return sortOrder === 'asc' 
          ? aValue.localeCompare(bValue)
          : bValue.localeCompare(aValue);
      }
      
      return sortOrder === 'asc' ? aValue - bValue : bValue - aValue;
    });
    return sorted;
  };

  const filterWorkloads = (workloadList) => {
    return workloadList.filter(workload => {
      // Filter by type
      if (typeFilter !== 'all' && workload.type !== typeFilter) {
        return false;
      }

      // Filter by namespace
      if (namespaceFilter && !workload.namespace?.toLowerCase().includes(namespaceFilter.toLowerCase())) {
        return false;
      }

      // Filter by name
      if (nameFilter && !workload.name?.toLowerCase().includes(nameFilter.toLowerCase())) {
        return false;
      }

      return true;
    });
  };

  const filteredAndSorted = () => {
    const filtered = filterWorkloads(workloads);
    return sortWorkloads(filtered);
  };

  const paginatedWorkloads = () => {
    const all = filteredAndSorted();
    const start = (currentPage - 1) * ITEMS_PER_PAGE;
    const end = start + ITEMS_PER_PAGE;
    return {
      items: all.slice(start, end),
      total: all.length,
      totalPages: Math.ceil(all.length / ITEMS_PER_PAGE),
    };
  };

  const getTypeColor = (type) => {
    switch (type) {
      case 'deployment':
        return 'bg-blue-100 text-blue-800 border-blue-300';
      case 'statefulset':
        return 'bg-purple-100 text-purple-800 border-purple-300';
      case 'daemonset':
        return 'bg-green-100 text-green-800 border-green-300';
      case 'job':
        return 'bg-orange-100 text-orange-800 border-orange-300';
      default:
        return 'bg-gray-100 text-gray-800 border-gray-300';
    }
  };

  const uniqueNamespaces = [...new Set(workloads.map(w => w.namespace).filter(Boolean))].sort();
  const uniqueTypes = [...new Set(workloads.map(w => w.type).filter(Boolean))].sort();

  const { items, total, totalPages } = paginatedWorkloads();

  // Calculate summary statistics
  const summary = items.reduce((acc, w) => {
    acc.totalCPUUsed += w.cpuUsed ?? 0;
    acc.totalMemoryUsed += w.memoryUsed ?? 0;
    acc.totalRunningPods += w.runningPods ?? 0;
    acc.totalReplicas += w.replicas ?? 0;
    return acc;
  }, { totalCPUUsed: 0, totalMemoryUsed: 0, totalRunningPods: 0, totalReplicas: 0 });

  const toggleColumn = (columnKey) => {
    setVisibleColumns(prev => ({
      ...prev,
      [columnKey]: !prev[columnKey]
    }));
  };

  const showEssentialColumns = () => {
    const essential = {};
    Object.keys(COLUMNS).forEach(key => {
      essential[key] = COLUMNS[key].essential;
    });
    setVisibleColumns(essential);
  };

  const showAllColumns = () => {
    const all = {};
    Object.keys(COLUMNS).forEach(key => {
      all[key] = true;
    });
    setVisibleColumns(all);
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex justify-between items-start">
          <div>
            <CardTitle>Workload Overview</CardTitle>
            <CardDescription>
              Deployments, StatefulSets, DaemonSets, and Jobs across all namespaces. Usage is calculated from resource requests of running pods.
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2 items-center">
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger className="w-[140px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Types</SelectItem>
                {uniqueTypes.map(type => (
                  <SelectItem key={type} value={type}>{type}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={sortBy} onValueChange={setSortBy}>
              <SelectTrigger className="w-[140px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="name">Sort by Name</SelectItem>
                <SelectItem value="namespace">Sort by Namespace</SelectItem>
                <SelectItem value="type">Sort by Type</SelectItem>
                <SelectItem value="replicas">Sort by Replicas</SelectItem>
                <SelectItem value="cpu">Sort by CPU</SelectItem>
                <SelectItem value="memory">Sort by Memory</SelectItem>
              </SelectContent>
            </Select>
            <Select value={sortOrder} onValueChange={setSortOrder}>
              <SelectTrigger className="w-[120px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="asc">Ascending</SelectItem>
                <SelectItem value="desc">Descending</SelectItem>
              </SelectContent>
            </Select>
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm">
                  <Columns className="h-4 w-4 mr-2" />
                  Columns
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-64" align="end">
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <Label className="font-semibold">Visible Columns</Label>
                    <div className="flex gap-1">
                      <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={showEssentialColumns}>
                        Essential
                      </Button>
                      <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={showAllColumns}>
                        All
                      </Button>
                    </div>
                  </div>
                  <div className="space-y-2 max-h-64 overflow-y-auto">
                    {Object.entries(COLUMNS).map(([key, col]) => (
                      <div key={key} className="flex items-center space-x-2">
                        <Checkbox
                          id={`col-${key}`}
                          checked={visibleColumns[key]}
                          onCheckedChange={() => toggleColumn(key)}
                        />
                        <Label
                          htmlFor={`col-${key}`}
                          className={cn(
                            "text-sm cursor-pointer flex-1",
                            col.essential && "font-semibold"
                          )}
                        >
                          {col.label}
                        </Label>
                        {col.essential && (
                          <Badge variant="outline" className="text-xs">Essential</Badge>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </PopoverContent>
            </Popover>
            <Button onClick={fetchWorkloads} disabled={loading} size="sm" variant="outline">
              <RefreshCw className={cn("h-4 w-4 mr-2", loading && "animate-spin")} />
              Refresh
            </Button>
            <div className="flex items-center gap-2">
              <span className="text-sm">Auto-refresh</span>
              <Switch checked={autoRefresh} onCheckedChange={setAutoRefresh} />
            </div>
            {autoRefresh && (
              <Select value={String(refreshInterval)} onValueChange={(v) => setRefreshInterval(Number(v))}>
                <SelectTrigger className="w-[120px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="30">Every 30s</SelectItem>
                  <SelectItem value="60">Every 1m</SelectItem>
                  <SelectItem value="120">Every 2m</SelectItem>
                  <SelectItem value="300">Every 5m</SelectItem>
                </SelectContent>
              </Select>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {error && (
          <Alert variant="destructive" className="mb-4">
            <AlertTitle>Error</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {/* Filters */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
          <div className="space-y-2">
            <Label htmlFor="namespace-filter">Namespace</Label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id="namespace-filter"
                placeholder="Filter by namespace..."
                value={namespaceFilter}
                onChange={(e) => setNamespaceFilter(e.target.value)}
                className="pl-9"
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="name-filter">Name</Label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id="name-filter"
                placeholder="Filter by name..."
                value={nameFilter}
                onChange={(e) => setNameFilter(e.target.value)}
                className="pl-9"
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Results</Label>
            <div className="flex items-center gap-2 pt-2">
              <span className="text-sm text-muted-foreground">
                Showing {items.length > 0 ? (currentPage - 1) * ITEMS_PER_PAGE + 1 : 0} - {Math.min(currentPage * ITEMS_PER_PAGE, total)} of {total}
              </span>
            </div>
          </div>
        </div>

        {loading && workloads.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground mb-2" />
            <p className="text-sm text-muted-foreground">Loading workloads...</p>
          </div>
        ) : workloads.length === 0 ? (
          <p className="text-center text-muted-foreground py-8">No workloads found</p>
        ) : total === 0 ? (
          <div className="text-center py-8">
            <p className="text-muted-foreground mb-2">No workloads match the current filters</p>
            <Button variant="outline" size="sm" onClick={() => {
              setTypeFilter('all');
              setNamespaceFilter('');
              setNameFilter('');
            }}>
              <X className="h-4 w-4 mr-2" />
              Clear Filters
            </Button>
          </div>
        ) : (
          <>
            {/* Summary Statistics */}
            {items.length > 0 && (
              <div className="mb-4 p-3 bg-muted/50 rounded-lg border">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                  <div>
                    <span className="text-muted-foreground">Total CPU Used:</span>
                    <span className="ml-2 font-semibold text-blue-600">{summary.totalCPUUsed.toFixed(2)} cores</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Total Memory Used:</span>
                    <span className="ml-2 font-semibold text-blue-600">{summary.totalMemoryUsed.toFixed(2)} GiB</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Running Pods:</span>
                    <span className="ml-2 font-semibold">{summary.totalRunningPods}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Total Replicas:</span>
                    <span className="ml-2 font-semibold">{summary.totalReplicas}</span>
                  </div>
                </div>
              </div>
            )}

            {/* Compact Table View */}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-background z-10">
                  <tr className="border-b">
                    {visibleColumns.name && <th className="text-left p-2 font-semibold sticky left-0 bg-background z-20 border-r">Name</th>}
                    {visibleColumns.namespace && <th className="text-left p-2 font-semibold">Namespace</th>}
                    {visibleColumns.type && <th className="text-left p-2 font-semibold">Type</th>}
                    {visibleColumns.replicas && <th className="text-right p-2 font-semibold">Replicas</th>}
                    {visibleColumns.runningPods && <th className="text-right p-2 font-semibold">Running Pods</th>}
                    {visibleColumns.cpuUsed && <th className="text-right p-2 font-semibold">CPU Used</th>}
                    {visibleColumns.memoryUsed && <th className="text-right p-2 font-semibold">Memory Used</th>}
                    {visibleColumns.cpuRequest && <th className="text-right p-2 font-semibold">CPU Request</th>}
                    {visibleColumns.memoryRequest && <th className="text-right p-2 font-semibold">Memory Request</th>}
                    {visibleColumns.cpuLimit && <th className="text-right p-2 font-semibold">CPU Limit</th>}
                    {visibleColumns.memoryLimit && <th className="text-right p-2 font-semibold">Memory Limit</th>}
                    {visibleColumns.gpu && <th className="text-right p-2 font-semibold">GPU</th>}
                  </tr>
                </thead>
                <tbody>
                  {items.map((workload, idx) => {
                    const cpuUsed = workload.cpuUsed ?? 0;
                    const memoryUsed = workload.memoryUsed ?? 0;
                    const runningPods = workload.runningPods ?? 0;
                    
                    return (
                      <tr key={`${workload.namespace}-${workload.name}-${idx}`} className="border-b hover:bg-muted/50">
                        {visibleColumns.name && (
                          <td className="p-2 sticky left-0 bg-background z-10 border-r">
                            <code className="text-xs font-semibold">{workload.name}</code>
                          </td>
                        )}
                        {visibleColumns.namespace && (
                          <td className="p-2">
                            <Badge variant="outline" className="text-xs">
                              {workload.namespace}
                            </Badge>
                          </td>
                        )}
                        {visibleColumns.type && (
                          <td className="p-2">
                            <Badge variant="outline" className={cn("text-xs font-semibold", getTypeColor(workload.type))}>
                              {workload.type}
                            </Badge>
                          </td>
                        )}
                        {visibleColumns.replicas && (
                          <td className="p-2 text-right">
                            {workload.replicas || 0}
                          </td>
                        )}
                        {visibleColumns.runningPods && (
                          <td className="p-2 text-right">
                            {runningPods > 0 ? (
                              <Badge variant="secondary" className="text-xs">
                                {runningPods}
                              </Badge>
                            ) : (
                              <span className="text-muted-foreground">-</span>
                            )}
                          </td>
                        )}
                        {visibleColumns.cpuUsed && (
                          <td className="p-2 text-right">
                            {cpuUsed > 0 ? (
                              <span className="font-semibold text-blue-600">
                                {cpuUsed.toFixed(2)} cores
                              </span>
                            ) : (
                              <span className="text-muted-foreground">-</span>
                            )}
                          </td>
                        )}
                        {visibleColumns.memoryUsed && (
                          <td className="p-2 text-right">
                            {memoryUsed > 0 ? (
                              <span className="font-semibold text-blue-600">
                                {memoryUsed.toFixed(2)} GiB
                              </span>
                            ) : (
                              <span className="text-muted-foreground">-</span>
                            )}
                          </td>
                        )}
                        {visibleColumns.cpuRequest && (
                          <td className="p-2 text-right text-muted-foreground text-xs">
                            {formatResource(workload.cpuRequest)}
                          </td>
                        )}
                        {visibleColumns.memoryRequest && (
                          <td className="p-2 text-right text-muted-foreground text-xs">
                            {formatResource(workload.memoryRequest)}
                          </td>
                        )}
                        {visibleColumns.cpuLimit && (
                          <td className="p-2 text-right text-muted-foreground text-xs">
                            {formatResource(workload.cpuLimit)}
                          </td>
                        )}
                        {visibleColumns.memoryLimit && (
                          <td className="p-2 text-right text-muted-foreground text-xs">
                            {formatResource(workload.memoryLimit)}
                          </td>
                        )}
                        {visibleColumns.gpu && (
                          <td className="p-2 text-right">
                            {workload.gpu > 0 ? (
                              <Badge variant="secondary" className="text-xs">
                                {workload.gpu}
                              </Badge>
                            ) : (
                              <span className="text-muted-foreground">-</span>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-4 pt-4 border-t">
                <div className="text-sm text-muted-foreground">
                  Page {currentPage} of {totalPages}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                    disabled={currentPage === 1}
                  >
                    <ChevronLeft className="h-4 w-4" />
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                    disabled={currentPage === totalPages}
                  >
                    Next
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default WorkloadUsageView;


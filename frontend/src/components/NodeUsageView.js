import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from './ui/card';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { Progress } from './ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Switch } from './ui/switch';
import { Separator } from './ui/separator';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { ChevronDown, RefreshCw, Loader2, Package, Search, X, Regex } from 'lucide-react';
import { cn } from '../lib/utils';
import { Input } from './ui/input';
import { Label } from './ui/label';

// Use runtime configuration from window.ENV (set via config.js) or build-time env var
const API_URL = (window.ENV && window.ENV.hasOwnProperty('REACT_APP_API_URL')) 
  ? window.ENV.REACT_APP_API_URL 
  : (process.env.REACT_APP_API_URL || '');

function NodeUsageView() {
  const [nodes, setNodes] = useState([]);
  const [nodePools, setNodePools] = useState([]); // Store NodePools with taints
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshInterval, setRefreshInterval] = useState(60);
  const [groupBy, setGroupBy] = useState('nodepool');
  const [sortBy, setSortBy] = useState('cpu');
  const [sortOrder, setSortOrder] = useState('desc');
  const [podsFilter, setPodsFilter] = useState('all');
  const [nodeNameFilter, setNodeNameFilter] = useState('');
  const [podNameFilter, setPodNameFilter] = useState('');
  const [useRegex, setUseRegex] = useState(false);
  const [showFilters, setShowFilters] = useState(false);

  useEffect(() => {
    fetchNodes();
    fetchNodePools();
  }, []);

  useEffect(() => {
    let interval;
    if (autoRefresh) {
      interval = setInterval(() => {
        fetchNodes();
      }, refreshInterval * 1000);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [autoRefresh, refreshInterval]);

  const fetchNodes = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await axios.get(`${API_URL}/api/v1/nodes`);
      const nodesData = response.data.nodes || [];
      setNodes(nodesData);
      // Debug: Log pod names
      nodesData.forEach(node => {
        if (node.podNames && node.podNames.length > 0) {
          console.log(`[NodeUsageView] Node ${node.name} has ${node.podNames.length} pods:`, node.podNames);
        }
      });
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to fetch nodes');
      console.error('Nodes error:', err);
    } finally {
      setLoading(false);
    }
  };

  const fetchNodePools = async () => {
    try {
      const response = await axios.get(`${API_URL}/api/v1/nodepools`);
      const nodePoolsData = response.data.nodepools || [];
      setNodePools(nodePoolsData);
    } catch (err) {
      console.error('Failed to fetch NodePools:', err);
      // Don't set error state, just log it - NodePools are optional
    }
  };

  const formatResource = (value, type) => {
    if (type === 'cpu') {
      return `${value.toFixed(2)} cores`;
    } else {
      return `${value.toFixed(2)} GiB`;
    }
  };


  const getNodeAge = (creationTime) => {
    if (!creationTime) return 'N/A';
    const now = new Date();
    const created = new Date(creationTime);
    const diffMs = now - created;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    
    if (diffDays > 0) return `${diffDays}d`;
    if (diffHours > 0) return `${diffHours}h`;
    return `${diffMins}m`;
  };

  const sortNodes = (nodeList) => {
    const sorted = [...nodeList];
    sorted.sort((a, b) => {
      let aValue, bValue;
      
      switch (sortBy) {
        case 'cpu':
          aValue = a.cpuUsage?.percent || 0;
          bValue = b.cpuUsage?.percent || 0;
          break;
        case 'memory':
          aValue = a.memoryUsage?.percent || 0;
          bValue = b.memoryUsage?.percent || 0;
          break;
        case 'pods':
          aValue = a.podCount || 0;
          bValue = b.podCount || 0;
          break;
        case 'creation':
          aValue = a.creationTime ? new Date(a.creationTime).getTime() : 0;
          bValue = b.creationTime ? new Date(b.creationTime).getTime() : 0;
          break;
        default:
          return 0;
      }
      
      if (sortOrder === 'desc') {
        return bValue - aValue;
      } else {
        return aValue - bValue;
      }
    });
    return sorted;
  };

  const calculateNodePoolSummary = (nodeList) => {
    let totalCPUUsed = 0;
    let totalCPUAllocatable = 0;
    let totalMemoryUsed = 0;
    let totalMemoryAllocatable = 0;
    let totalPods = 0;

    nodeList.forEach(node => {
      if (node.cpuUsage) {
        totalCPUUsed += node.cpuUsage.used;
        totalCPUAllocatable += node.cpuUsage.allocatable;
      }
      if (node.memoryUsage) {
        totalMemoryUsed += node.memoryUsage.used;
        totalMemoryAllocatable += node.memoryUsage.allocatable;
      }
      totalPods += node.podCount || 0;
    });

    const cpuPercent = totalCPUAllocatable > 0 ? (totalCPUUsed / totalCPUAllocatable) * 100 : 0;
    const memoryPercent = totalMemoryAllocatable > 0 ? (totalMemoryUsed / totalMemoryAllocatable) * 100 : 0;

    return {
      cpuUsed: totalCPUUsed,
      cpuAllocatable: totalCPUAllocatable,
      cpuPercent: Math.min(cpuPercent, 100),
      memoryUsed: totalMemoryUsed,
      memoryAllocatable: totalMemoryAllocatable,
      memoryPercent: Math.min(memoryPercent, 100),
      totalPods: totalPods,
      nodeCount: nodeList.length
    };
  };

  const filterNodesByPods = (nodeList) => {
    if (podsFilter === 'all') {
      return nodeList;
    }
    return nodeList.filter(node => {
      const podCount = node.podCount || 0;
      switch (podsFilter) {
        case '0':
          return podCount === 0;
        case '1-10':
          return podCount >= 1 && podCount <= 10;
        case '11-50':
          return podCount >= 11 && podCount <= 50;
        case '50+':
          return podCount > 50;
        default:
          return true;
      }
    });
  };

  const matchesFilter = (text, filter) => {
    if (!filter) return true;
    
    if (useRegex) {
      try {
        const regex = new RegExp(filter, 'i');
        return regex.test(text);
      } catch (e) {
        // Invalid regex, fall back to simple contains
        return text.toLowerCase().includes(filter.toLowerCase());
      }
    } else {
      return text.toLowerCase().includes(filter.toLowerCase());
    }
  };

  const filterNodesByNameAndPod = (nodeList) => {
    return nodeList.filter(node => {
      // Filter by node name
      if (nodeNameFilter && !matchesFilter(node.name || '', nodeNameFilter)) {
        return false;
      }

      // Filter by pod name (check if any pod matches)
      if (podNameFilter) {
        const podNames = node.podNames || [];
        const matchesPod = podNames.some(podName => matchesFilter(podName, podNameFilter));
        if (!matchesPod) {
          return false;
        }
      }

      return true;
    });
  };

  const groupedNodes = () => {
    const sortedNodes = sortNodes(nodes);
    const filteredByPods = filterNodesByPods(sortedNodes);
    const filteredNodes = filterNodesByNameAndPod(filteredByPods);
    if (groupBy === 'nodepool') {
      const grouped = {};
      filteredNodes.forEach(node => {
        const key = node.nodePool || 'No NodePool';
        if (!grouped[key]) {
          grouped[key] = [];
        }
        grouped[key].push(node);
      });
      return grouped;
    }
    return { 'All Nodes': filteredNodes };
  };

  const getFilteredNodeCount = () => {
    const sortedNodes = sortNodes(nodes);
    const filteredByPods = filterNodesByPods(sortedNodes);
    const filteredNodes = filterNodesByNameAndPod(filteredByPods);
    return filteredNodes.length;
  };

  const clearFilters = () => {
    setNodeNameFilter('');
    setPodNameFilter('');
    setPodsFilter('all');
  };

  const hasActiveFilters = () => {
    return nodeNameFilter || podNameFilter || podsFilter !== 'all';
  };

  const BarGauge = ({ label, used, capacity, allocatable, percent, type }) => {
    return (
      <div className="space-y-2">
        <div className="flex justify-between items-center text-xs">
          <span className="font-semibold">{label}</span>
          <span className={cn("font-semibold", percent >= 90 ? "text-red-600" : percent >= 70 ? "text-yellow-600" : "text-green-600")}>
            {percent.toFixed(1)}% ({formatResource(used, type)} / {formatResource(allocatable, type)})
          </span>
        </div>
        <Progress value={Math.min(percent, 100)} className="h-2" />
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>Capacity: {formatResource(capacity, type)}</span>
          <span>Allocatable: {formatResource(allocatable, type)}</span>
        </div>
      </div>
    );
  };

  const grouped = groupedNodes();

  return (
    <Card>
      <CardHeader>
        <div className="flex justify-between items-start">
          <div>
            <CardTitle>Node Resource Usage</CardTitle>
            <CardDescription>
              Real-time CPU and memory usage per node (based on pod resource requests)
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2 items-center">
            <Button
              variant={showFilters ? "default" : "outline"}
              size="sm"
              onClick={() => setShowFilters(!showFilters)}
            >
              <Search className="h-4 w-4 mr-2" />
              Filters
              {hasActiveFilters() && (
                <Badge variant="secondary" className="ml-2 bg-primary text-primary-foreground">
                  {getFilteredNodeCount()}/{nodes.length}
                </Badge>
              )}
            </Button>
            <Select value={groupBy} onValueChange={setGroupBy}>
              <SelectTrigger className="w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="nodepool">Group by NodePool</SelectItem>
                <SelectItem value="none">All Nodes</SelectItem>
              </SelectContent>
            </Select>
            <Select value={sortBy} onValueChange={setSortBy}>
              <SelectTrigger className="w-[140px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="cpu">Sort by CPU</SelectItem>
                <SelectItem value="memory">Sort by Memory</SelectItem>
                <SelectItem value="pods">Sort by Pods</SelectItem>
                <SelectItem value="creation">Sort by Creation</SelectItem>
              </SelectContent>
            </Select>
            <Select value={sortOrder} onValueChange={setSortOrder}>
              <SelectTrigger className="w-[120px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="desc">Descending</SelectItem>
                <SelectItem value="asc">Ascending</SelectItem>
              </SelectContent>
            </Select>
            <Select value={podsFilter} onValueChange={setPodsFilter}>
              <SelectTrigger className="w-[140px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Pods</SelectItem>
                <SelectItem value="0">0 pods</SelectItem>
                <SelectItem value="1-10">1-10 pods</SelectItem>
                <SelectItem value="11-50">11-50 pods</SelectItem>
                <SelectItem value="50+">50+ pods</SelectItem>
              </SelectContent>
            </Select>
            <Button onClick={fetchNodes} disabled={loading} size="sm" variant="outline">
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
                  <SelectItem value="10">Every 10s</SelectItem>
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

        {/* Advanced Filters Panel */}
        {showFilters && (
          <Card className="mb-4 border-2">
            <CardHeader className="pb-3">
              <div className="flex justify-between items-center">
                <CardTitle className="text-lg">Search & Filter</CardTitle>
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={useRegex}
                      onCheckedChange={setUseRegex}
                      id="regex-mode"
                    />
                    <Label htmlFor="regex-mode" className="text-sm flex items-center gap-1 cursor-pointer">
                      <Regex className="h-3 w-3" />
                      Regex
                    </Label>
                  </div>
                  {hasActiveFilters() && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={clearFilters}
                      className="h-8"
                    >
                      <X className="h-4 w-4 mr-1" />
                      Clear
                    </Button>
                  )}
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="node-name-filter">Node Name</Label>
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      id="node-name-filter"
                      placeholder={useRegex ? "e.g., ip-.*-compute" : "e.g., ip-10-207-46-118"}
                      value={nodeNameFilter}
                      onChange={(e) => setNodeNameFilter(e.target.value)}
                      className="pl-9"
                    />
                  </div>
                  {nodeNameFilter && (
                    <p className="text-xs text-muted-foreground">
                      {useRegex ? "Regex pattern" : "Simple text search"}
                    </p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="pod-name-filter">Pod Name</Label>
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      id="pod-name-filter"
                      placeholder={useRegex ? "e.g., .*-deployment-.*" : "e.g., my-app"}
                      value={podNameFilter}
                      onChange={(e) => setPodNameFilter(e.target.value)}
                      className="pl-9"
                    />
                  </div>
                  {podNameFilter && (
                    <p className="text-xs text-muted-foreground">
                      {useRegex ? "Regex pattern" : "Simple text search"}
                    </p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label>Pod Count</Label>
                  <Select value={podsFilter} onValueChange={setPodsFilter}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Pods</SelectItem>
                      <SelectItem value="0">0 pods</SelectItem>
                      <SelectItem value="1-10">1-10 pods</SelectItem>
                      <SelectItem value="11-50">11-50 pods</SelectItem>
                      <SelectItem value="50+">50+ pods</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {useRegex && (
                <Alert className="mt-4">
                  <AlertTitle className="text-sm">Regex Mode Enabled</AlertTitle>
                  <AlertDescription className="text-xs">
                    Use regex patterns for advanced matching. Examples:
                    <code className="block mt-1 p-1 bg-muted rounded">ip-.*-compute</code>
                    <code className="block mt-1 p-1 bg-muted rounded">.*-deployment-.*</code>
                  </AlertDescription>
                </Alert>
              )}
              {hasActiveFilters() && (
                <div className="mt-4 pt-4 border-t">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="text-muted-foreground">Showing</span>
                    <Badge variant="secondary">{getFilteredNodeCount()}</Badge>
                    <span className="text-muted-foreground">of</span>
                    <Badge variant="outline">{nodes.length}</Badge>
                    <span className="text-muted-foreground">nodes</span>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {loading && nodes.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground mb-2" />
            <p className="text-sm text-muted-foreground">Loading nodes...</p>
          </div>
        ) : nodes.length === 0 ? (
          <p className="text-center text-muted-foreground py-8">No nodes found</p>
        ) : getFilteredNodeCount() === 0 ? (
          <div className="text-center py-8">
            <p className="text-muted-foreground mb-2">No nodes match the current filters</p>
            <Button variant="outline" size="sm" onClick={clearFilters}>
              <X className="h-4 w-4 mr-2" />
              Clear Filters
            </Button>
          </div>
        ) : (
          <div className="space-y-6">
            {Object.entries(grouped).map(([groupName, groupNodes]) => {
              const summary = groupBy === 'nodepool' ? calculateNodePoolSummary(groupNodes) : null;
              
              return (
                <div key={groupName}>
                  <h3 className="text-lg font-semibold mb-4">
                    {groupName} ({groupNodes.length} node{groupNodes.length !== 1 ? 's' : ''})
                  </h3>
                  
                  {summary && summary.cpuAllocatable > 0 && (() => {
                    // Find NodePool info to get taints and cost
                    const nodePoolInfo = nodePools.find(np => np.name === groupName);
                    const taints = nodePoolInfo?.taints || [];
                    const estimatedCost = nodePoolInfo?.estimatedCost || 0;
                    
                    return (
                      <Card className="mb-4 bg-gradient-to-br from-purple-500 to-purple-700 border-0">
                        <CardHeader>
                          <div className="flex justify-between items-center">
                            <CardTitle className="text-white text-sm uppercase tracking-wide">
                              📊 NodePool Overall Usage
                            </CardTitle>
                            <div className="flex items-center gap-2">
                              {estimatedCost > 0 && (
                                <Badge 
                                  variant="secondary" 
                                  className={cn(
                                    "font-semibold",
                                    nodePoolInfo?.pricingSource === "aws-pricing-api" 
                                      ? "bg-green-500/80 text-white" 
                                      : "bg-yellow-500/80 text-white"
                                  )}
                                  title={nodePoolInfo?.pricingSource === "aws-pricing-api" 
                                    ? "Using AWS Pricing API" 
                                    : `Using ${nodePoolInfo?.pricingSource || "estimated"} pricing`}
                                >
                                  ${estimatedCost.toFixed(2)}/hr
                                  {nodePoolInfo?.pricingSource === "aws-pricing-api" && " ✓"}
                                </Badge>
                              )}
                              <Badge variant="secondary" className="bg-white/25 text-white">
                                {summary.totalPods} pod{summary.totalPods !== 1 ? 's' : ''} • {summary.nodeCount} node{summary.nodeCount !== 1 ? 's' : ''}
                              </Badge>
                            </div>
                          </div>
                        </CardHeader>
                        <CardContent>
                          <div className={cn("grid gap-4 mb-4", estimatedCost > 0 ? "grid-cols-3" : "grid-cols-2")}>
                            <Card className="bg-white/95">
                              <CardContent className="pt-6">
                                <BarGauge
                                  label="Total CPU"
                                  used={summary.cpuUsed}
                                  capacity={summary.cpuAllocatable}
                                  allocatable={summary.cpuAllocatable}
                                  percent={summary.cpuPercent}
                                  type="cpu"
                                />
                              </CardContent>
                            </Card>
                            <Card className="bg-white/95">
                              <CardContent className="pt-6">
                                <BarGauge
                                  label="Total Memory"
                                  used={summary.memoryUsed}
                                  capacity={summary.memoryAllocatable}
                                  allocatable={summary.memoryAllocatable}
                                  percent={summary.memoryPercent}
                                  type="memory"
                                />
                              </CardContent>
                            </Card>
                            {estimatedCost > 0 && (
                              <Card className="bg-white/95">
                                <CardContent className="pt-6">
                                  <p className="text-sm text-muted-foreground mb-2">Estimated Cost</p>
                                  <p className="text-2xl font-bold text-green-600">
                                    ${estimatedCost.toFixed(2)}/hr
                                  </p>
                                  <p className="text-xs text-muted-foreground mt-1">
                                    ${(estimatedCost * 24).toFixed(2)}/day
                                  </p>
                                  {nodePoolInfo?.pricingSource && (
                                    <p className="text-xs mt-1">
                                      <span className={cn(
                                        "font-semibold",
                                        nodePoolInfo.pricingSource === "aws-pricing-api" ? "text-green-700" : "text-yellow-700"
                                      )}>
                                        {nodePoolInfo.pricingSource === "aws-pricing-api" ? "✓ AWS Pricing API" :
                                         nodePoolInfo.pricingSource === "hardcoded" ? "⚠ Estimated (hardcoded)" :
                                         nodePoolInfo.pricingSource === "family-estimate" ? "⚠ Estimated (family-based)" :
                                         nodePoolInfo.pricingSource === "ollama-cache" ? "⚠ Estimated (cached)" :
                                         nodePoolInfo.pricingSource === "ollama" ? "⚠ Estimated (LLM)" :
                                         "⚠ Estimated"}
                                      </span>
                                    </p>
                                  )}
                                </CardContent>
                              </Card>
                            )}
                          </div>
                          
                          {/* Taints Section */}
                          {taints.length > 0 && (
                            <div className="mt-4 pt-4 border-t border-white/20">
                              <div className="flex items-center gap-2 mb-2">
                                <span className="text-white text-xs font-semibold">Taints:</span>
                                <Badge variant="secondary" className="bg-white/25 text-white text-xs">
                                  {taints.length} configured
                                </Badge>
                              </div>
                              <div className="flex flex-wrap gap-2">
                                {taints.map((taint, idx) => {
                                  const taintKey = taint?.key || taint?.Key || '';
                                  const taintValue = taint?.value || taint?.Value || '';
                                  const taintEffect = taint?.effect || taint?.Effect || '';
                                  const taintString = `${taintKey}${taintValue ? `=${taintValue}` : ''}:${taintEffect}`;
                                  return (
                                    <Badge
                                      key={idx}
                                      variant="outline"
                                      className="font-mono text-xs border-yellow-300 text-yellow-100 bg-yellow-500/20"
                                    >
                                      {taintString}
                                    </Badge>
                                  );
                                })}
                              </div>
                            </div>
                          )}
                        </CardContent>
                      </Card>
                    );
                  })()}
                  
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {groupNodes.map((node) => (
                      <Card key={node.name}>
                        <CardHeader className="pb-3 border-b">
                          <div className="flex justify-between items-center">
                            <code className="text-sm font-semibold">{node.name}</code>
                            {node.podCount !== undefined && (
                              <Popover>
                                <PopoverTrigger asChild>
                                  <Badge variant="secondary" className="cursor-pointer hover:bg-secondary/80 transition-colors">
                                    <Package className="h-3 w-3 mr-1" />
                                    {node.podCount} pod{node.podCount !== 1 ? 's' : ''}
                                    <ChevronDown className="ml-1 h-3 w-3" />
                                  </Badge>
                                </PopoverTrigger>
                                <PopoverContent className="w-[400px] max-h-[500px] overflow-y-auto" align="end">
                                  <div className="space-y-3">
                                    <div className="flex items-center gap-2">
                                      <Package className="h-4 w-4 text-primary" />
                                      <h4 className="font-semibold text-sm">Pods on {node.name}</h4>
                                      <Badge variant="secondary" className="ml-auto text-xs">
                                        {node.podCount} total
                                      </Badge>
                                    </div>
                                    <Separator />
                                    {node.podNames && node.podNames.length > 0 ? (
                                      <div className="space-y-2">
                                        {node.podNames.map((podName, idx) => {
                                          const [namespace, name] = podName.split('/');
                                          return (
                                            <div
                                              key={idx}
                                              className="flex items-center gap-2 p-2 rounded-md border bg-card hover:bg-accent transition-colors"
                                            >
                                              <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-2">
                                                  <code className="text-xs font-semibold truncate">{name}</code>
                                                  <Badge variant="outline" className="text-xs shrink-0">
                                                    {namespace}
                                                  </Badge>
                                                </div>
                                              </div>
                                            </div>
                                          );
                                        })}
                                      </div>
                                    ) : (
                                      <p className="text-sm text-muted-foreground text-center py-4">
                                        No pods found on this node
                                      </p>
                                    )}
                                  </div>
                                </PopoverContent>
                              </Popover>
                            )}
                          </div>
                          <div className="flex flex-wrap gap-2 mt-2">
                            {node.nodePool && (
                              <Badge variant="outline">📦 {node.nodePool}</Badge>
                            )}
                            {node.instanceType && (
                              <Badge variant="secondary" className="font-mono text-xs">
                                {node.instanceType}
                              </Badge>
                            )}
                            {node.zone && (
                              <Badge variant="outline" className="border-blue-500 text-blue-700">
                                🌍 {node.zone}
                              </Badge>
                            )}
                            {node.capacityType && (
                              <Badge variant={node.capacityType === 'spot' ? 'default' : 'secondary'}>
                                {node.capacityType}
                              </Badge>
                            )}
                            {node.architecture && (
                              <Badge variant="outline" className={node.architecture === 'arm64' ? 'border-green-500 text-green-700' : 'border-indigo-500 text-indigo-700'}>
                                {node.architecture.toUpperCase()}
                              </Badge>
                            )}
                            {node.creationTime && (
                              <Badge variant="outline">Age: {getNodeAge(node.creationTime)}</Badge>
                            )}
                          </div>
                        </CardHeader>
                        <CardContent className="pt-4 space-y-4">
                          {node.cpuUsage && (
                            <BarGauge
                              label="CPU"
                              used={node.cpuUsage.used}
                              capacity={node.cpuUsage.capacity}
                              allocatable={node.cpuUsage.allocatable}
                              percent={node.cpuUsage.percent}
                              type="cpu"
                            />
                          )}

                          {node.memoryUsage && (
                            <BarGauge
                              label="Memory"
                              used={node.memoryUsage.used}
                              capacity={node.memoryUsage.capacity}
                              allocatable={node.memoryUsage.allocatable}
                              percent={node.memoryUsage.percent}
                              type="memory"
                            />
                          )}

                          {(!node.cpuUsage && !node.memoryUsage) && (
                            <p className="text-xs text-muted-foreground italic">
                              No usage data available
                            </p>
                          )}
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                  <Separator className="my-6" />
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default NodeUsageView;

import React, { useState } from 'react';
import axios from 'axios';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from './ui/card';
import { Button } from './ui/button';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { Badge } from './ui/badge';
import { Checkbox } from './ui/checkbox';
import { RefreshCw, AlertTriangle, AlertCircle, Loader2 } from 'lucide-react';
import { cn } from '../lib/utils';

// Use runtime configuration from window.ENV (set via config.js) or build-time env var
const API_URL = (window.ENV && window.ENV.hasOwnProperty('REACT_APP_API_URL')) 
  ? window.ENV.REACT_APP_API_URL 
  : (process.env.REACT_APP_API_URL || '');

function DisruptionTracker() {
  const [disruptions, setDisruptions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedTypes, setSelectedTypes] = useState(new Set());
  const [showOnlyBlocked, setShowOnlyBlocked] = useState(false);

  const fetchDisruptions = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await axios.get(`${API_URL}/api/v1/disruptions`, {
        params: { hours: 24 }
      });
      setDisruptions(response.data.disruptions || []);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to fetch disruptions');
      console.error('Disruptions error:', err);
    } finally {
      setLoading(false);
    }
  };

  const formatTime = (timeStr) => {
    if (!timeStr) return 'N/A';
    try {
      const date = new Date(timeStr);
      const now = new Date();
      const diffMs = now - date;
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMs / 3600000);
      const diffDays = Math.floor(diffMs / 86400000);

      if (diffMins < 1) return 'Just now';
      if (diffMins < 60) return `${diffMins}m ago`;
      if (diffHours < 24) return `${diffHours}h ago`;
      return `${diffDays}d ago`;
    } catch {
      return timeStr;
    }
  };

  const getReasonColor = (reason) => {
    const reasonLower = reason?.toLowerCase() || '';
    if (reasonLower.includes('consolidat')) {
      return { className: 'bg-blue-500', label: 'Consolidation' };
    }
    if (reasonLower.includes('expir') || reasonLower.includes('drift')) {
      return { className: 'bg-orange-500', label: 'Expiration/Drift' };
    }
    if (reasonLower.includes('terminat') || reasonLower.includes('delet')) {
      return { className: 'bg-red-500', label: 'Termination' };
    }
    return { className: 'bg-gray-500', label: reason || 'Unknown' };
  };

  const groupByReason = (disruptions) => {
    const grouped = {};
    disruptions.forEach(d => {
      const reason = d.reason || 'Unknown';
      if (!grouped[reason]) {
        grouped[reason] = [];
      }
      grouped[reason].push(d);
    });
    return grouped;
  };

  const getReasonType = (reason) => {
    const reasonLower = reason?.toLowerCase() || '';
    if (reasonLower.includes('consolidat')) {
      return 'consolidation';
    }
    if (reasonLower.includes('expir') || reasonLower.includes('drift')) {
      return 'expiration';
    }
    if (reasonLower.includes('terminat') || reasonLower.includes('delet')) {
      return 'termination';
    }
    return 'other';
  };

  const toggleTypeFilter = (type) => {
    const newSelected = new Set(selectedTypes);
    if (newSelected.has(type)) {
      newSelected.delete(type);
    } else {
      newSelected.add(type);
    }
    setSelectedTypes(newSelected);
  };

  const selectAllTypes = () => {
    setSelectedTypes(new Set());
  };

  const getAvailableTypes = (disruptions) => {
    const types = new Set();
    disruptions.forEach(d => {
      types.add(getReasonType(d.reason));
    });
    return Array.from(types).sort();
  };

  const filteredDisruptions = disruptions.filter(d => {
    if (showOnlyBlocked && !d.isBlocked) {
      return false;
    }
    if (selectedTypes.size === 0) {
      return true;
    }
    const type = getReasonType(d.reason);
    return selectedTypes.has(type);
  });

  const blockedDisruptions = disruptions.filter(d => d.isBlocked);
  const groupedDisruptions = groupByReason(filteredDisruptions);
  const availableTypes = getAvailableTypes(disruptions);

  return (
    <Card>
      <CardHeader>
        <div className="flex justify-between items-start">
          <div>
            <CardTitle>Node Disruptions</CardTitle>
            <CardDescription>Live node disruptions based on current node state</CardDescription>
          </div>
          <Button onClick={fetchDisruptions} disabled={loading} variant="outline" size="sm">
            <RefreshCw className={cn("h-4 w-4 mr-2", loading && "animate-spin")} />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {error && (
          <Alert variant="destructive" className="mb-4">
            <AlertTitle>{error}</AlertTitle>
          </Alert>
        )}

        {loading && disruptions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground mb-2" />
            <p className="text-sm text-muted-foreground">Loading disruptions...</p>
          </div>
        ) : disruptions.length === 0 ? (
          <p className="text-center text-muted-foreground py-8">No active disruptions found</p>
        ) : (
          <div className="space-y-4">
            {/* Blocked Disruptions Focus Section */}
            {blockedDisruptions.length > 0 && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle className="flex items-center gap-2">
                  <span>{blockedDisruptions.length} Node(s) Blocked from Deletion</span>
                </AlertTitle>
                <AlertDescription>
                  <div className="space-y-2 mt-2">
                    <p className="text-sm">
                      These nodes cannot be removed due to Pod Disruption Budgets or pod eviction constraints
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {blockedDisruptions.filter(d => d.blockingPDBs && d.blockingPDBs.length > 0).length > 0 && (
                        <span className="text-sm">
                          <strong>{blockedDisruptions.filter(d => d.blockingPDBs && d.blockingPDBs.length > 0).length}</strong> blocked by PDBs
                        </span>
                      )}
                      {blockedDisruptions.reduce((sum, d) => sum + (d.affectedPods?.length || 0), 0) > 0 && (
                        <span className="text-sm">
                          <strong>{blockedDisruptions.reduce((sum, d) => sum + (d.affectedPods?.length || 0), 0)}</strong> pods affected
                        </span>
                      )}
                      {new Set(blockedDisruptions.map(d => d.nodePool).filter(Boolean)).size > 0 && (
                        <span className="text-sm">
                          Across <strong>{new Set(blockedDisruptions.map(d => d.nodePool).filter(Boolean)).size}</strong> NodePool(s)
                        </span>
                      )}
                    </div>
                    <Button
                      variant={showOnlyBlocked ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => setShowOnlyBlocked(!showOnlyBlocked)}
                      className="mt-2"
                    >
                      {showOnlyBlocked ? 'Show All' : 'Focus on Blocked'}
                    </Button>
                  </div>
                </AlertDescription>
              </Alert>
            )}

            {/* Type Filter Section */}
            {availableTypes.length > 0 && (
              <Card>
                <CardContent className="pt-6">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold">Filter:</span>
                    <Button
                      variant={selectedTypes.size === 0 ? 'default' : 'outline'}
                      size="sm"
                      onClick={selectAllTypes}
                    >
                      All
                    </Button>
                    {availableTypes.map(type => {
                      const isSelected = selectedTypes.size === 0 || selectedTypes.has(type);
                      const count = disruptions.filter(d => getReasonType(d.reason) === type).length;
                      
                      return (
                        <div key={type} className="flex items-center gap-2">
                          <Checkbox
                            checked={isSelected}
                            onCheckedChange={() => toggleTypeFilter(type)}
                            id={`filter-${type}`}
                          />
                          <label htmlFor={`filter-${type}`} className="text-sm cursor-pointer flex items-center gap-1">
                            <span className="capitalize">
                              {type === 'consolidation' ? 'Consolidation' :
                               type === 'expiration' ? 'Expiration/Drift' :
                               type === 'termination' ? 'Termination' : 'Other'}
                            </span>
                            <Badge variant="secondary" className="text-xs">{count}</Badge>
                          </label>
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Summary Stats */}
            <div className="flex flex-wrap gap-2">
              {Object.entries(groupedDisruptions).map(([reason, items]) => {
                const color = getReasonColor(reason);
                return (
                  <Badge key={reason} className={color.className}>
                    {color.label}: {items.length}
                  </Badge>
                );
              })}
              {filteredDisruptions.length === 0 && disruptions.length > 0 && (
                <Badge variant="destructive">No disruptions match selected filters</Badge>
              )}
            </div>

            {/* Disruptions List */}
            <div className="space-y-4">
              {filteredDisruptions.sort((a, b) => {
                if (a.isBlocked && !b.isBlocked) return -1;
                if (!a.isBlocked && b.isBlocked) return 1;
                if (a.isBlocked && b.isBlocked) {
                  const aPDBs = (a.blockingPDBs?.length || 0);
                  const bPDBs = (b.blockingPDBs?.length || 0);
                  if (aPDBs !== bPDBs) return bPDBs - aPDBs;
                }
                return 0;
              }).map((disruption) => {
                const color = getReasonColor(disruption.reason);
                const isBlocked = disruption.isBlocked || false;
                const pods = disruption.affectedPods || [];
                
                return (
                  <Card
                    key={disruption.nodeName}
                    className={cn(
                      isBlocked && "bg-red-50 border-2 border-red-500"
                    )}
                  >
                    <CardContent className="pt-6">
                      <div className="space-y-4">
                        <div className="flex justify-between items-start">
                          <div className="flex gap-2">
                            <Badge className={color.className}>{color.label}</Badge>
                            {isBlocked && (
                              <Badge variant="destructive">BLOCKED</Badge>
                            )}
                          </div>
                          <div className="flex flex-wrap gap-2 items-center">
                            <code className="text-sm font-semibold">{disruption.nodeName}</code>
                            {disruption.nodePool && (
                              <Badge variant="outline">📦 {disruption.nodePool}</Badge>
                            )}
                            {disruption.instanceType && (
                              <Badge variant="secondary" className="font-mono text-xs">
                                {disruption.instanceType}
                              </Badge>
                            )}
                            {pods.length > 0 && (
                              <Badge variant="secondary" className="text-xs">
                                {pods.length} pod{pods.length !== 1 ? 's' : ''}
                              </Badge>
                            )}
                            <span className="text-xs text-muted-foreground">
                              {formatTime(disruption.lastSeen)}
                            </span>
                          </div>
                        </div>

                        {/* Pods Running on Node */}
                        {pods.length > 0 && (
                          <div className="space-y-2">
                            <p className="text-sm font-semibold">
                              📦 Pods Running ({pods.length}):
                            </p>
                            <div className="flex flex-wrap gap-2">
                              {pods.map((pod, podIndex) => {
                                const podName = pod.name || pod.workloadName || `pod-${podIndex}`;
                                const namespace = pod.namespace || 'default';
                                
                                return (
                                  <Badge
                                    key={podIndex}
                                    variant="outline"
                                    className="font-mono text-xs"
                                    title={`Pod: ${pod.name || podName} | Namespace: ${namespace} | Workload: ${pod.workloadName || 'N/A'} | Type: ${pod.workloadType || 'pod'}`}
                                  >
                                    {pod.workloadType ? pod.workloadType.charAt(0).toUpperCase() : 'P'} {namespace}/{podName}
                                    {pod.workloadName && pod.workloadName !== podName && (
                                      <span className="text-xs text-muted-foreground ml-1">
                                        ({pod.workloadName})
                                      </span>
                                    )}
                                  </Badge>
                                );
                              })}
                            </div>
                          </div>
                        )}
                        {pods.length === 0 && disruption.nodeStillExists && (
                          <p className="text-xs text-muted-foreground italic">
                            No pods found on this node
                          </p>
                        )}
                        
                        {/* Blocking info */}
                        {isBlocked && (
                          <Alert variant="destructive">
                            <AlertTriangle className="h-4 w-4" />
                            <AlertTitle className="text-sm">
                              ⚠️ Blocked: {disruption.blockingReason || 'Cannot evict pods'}
                            </AlertTitle>
                            <AlertDescription>
                              <div className="space-y-2 mt-2">
                                {disruption.blockingPDBs && disruption.blockingPDBs.length > 0 && (
                                  <div>
                                    <p className="text-sm font-semibold">PDBs:</p>
                                    <div className="flex flex-wrap gap-2 mt-1">
                                      {disruption.blockingPDBs.map((pdb, idx) => (
                                        <Badge key={idx} variant="outline" className="font-mono text-xs">
                                          {pdb}
                                        </Badge>
                                      ))}
                                    </div>
                                  </div>
                                )}
                                {disruption.blockingPods && disruption.blockingPods.length > 0 && (
                                  <div>
                                    <p className="text-sm font-semibold">Blocking Pods:</p>
                                    <div className="flex flex-wrap gap-2 mt-1">
                                      {disruption.blockingPods.slice(0, 3).map((pod, idx) => (
                                        <Badge key={idx} variant="outline" className="font-mono text-xs">
                                          {pod}
                                        </Badge>
                                      ))}
                                      {disruption.blockingPods.length > 3 && (
                                        <span className="text-xs text-muted-foreground">
                                          +{disruption.blockingPods.length - 3} more
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                )}
                                <p className="text-xs text-muted-foreground italic mt-2">
                                  💡 Tip: Review PDB minAvailable/maxUnavailable settings or pod eviction policies
                                </p>
                              </div>
                            </AlertDescription>
                          </Alert>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default DisruptionTracker;

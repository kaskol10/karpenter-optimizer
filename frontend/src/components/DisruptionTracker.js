import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import axios from 'axios';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from './ui/card';
import { Button } from './ui/button';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { Badge } from './ui/badge';
import { Checkbox } from './ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Switch } from './ui/switch';
import { RefreshCw, AlertTriangle, AlertCircle, Loader2, Check, Package, Lightbulb, Clock } from 'lucide-react';
import { cn } from '../lib/utils';

// Use runtime configuration from window.ENV (set via config.js) or build-time env var
const API_URL = (window.ENV && window.ENV.hasOwnProperty('REACT_APP_API_URL'))
  ? window.ENV.REACT_APP_API_URL
  : (process.env.REACT_APP_API_URL || '');

// useCopyText copies a value to the clipboard and tracks the last-copied key
// for brief "Copied" feedback.
function useCopyText() {
  const [copiedKey, setCopiedKey] = useState(null);
  const timeoutRef = useRef(null);

  useEffect(() => () => clearTimeout(timeoutRef.current), []);

  const copy = useCallback((key, value) => {
    const done = () => {
      setCopiedKey(key);
      clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setCopiedKey(null), 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(done).catch(done);
    } else {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      done();
    }
  }, []);

  return { copy, copiedKey };
}

// CopyableName renders text; clicking copies `value` (for pasting into CLI).
function CopyableName({ value, label, className, variant = 'outline', title }) {
  const { copy, copiedKey } = useCopyText();
  const isCopied = copiedKey === value;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        copy(value, value);
      }}
      title={title || `${value} — click to copy`}
      className={cn(
        'inline-flex items-center gap-1 font-mono max-w-full cursor-pointer truncate text-left',
        isCopied && 'text-emerald-600',
        className,
      )}
    >
      {isCopied ? (
        <>
          <Check className="w-3 h-3 shrink-0" aria-hidden="true" />
          <span className="truncate">Copied</span>
        </>
      ) : (
        <Badge variant={variant}>
          <span className="truncate">{label || value}</span>
        </Badge>
      )}
    </button>
  );
}

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

const formatCost = (value) => `$${value.toFixed(2)}`;

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

// countBlockingPods totals the pods that block eviction across disruptions,
// preferring the detailed PDB breakdown when present.
const countBlockingPods = (items) =>
  items.reduce((sum, d) => {
    if (d.blockingPDBDetails && d.blockingPDBDetails.length > 0) {
      return sum + d.blockingPDBDetails.reduce((s, pdb) => s + (pdb.blockingPods?.length || 0), 0);
    }
    return sum + (d.blockingPods?.length || 0);
  }, 0);

// DisruptionCard renders a single node's disruption state.
function DisruptionCard({ disruption }) {
  const color = getReasonColor(disruption.reason);
  const isBlocked = disruption.isBlocked || false;
  const pods = disruption.affectedPods || [];

  return (
    <Card
      key={disruption.nodeName}
      className={cn(isBlocked && 'bg-red-50 border-2 border-red-500')}
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
              <CopyableName
                value={disruption.nodeName}
                label={disruption.nodeName}
                variant="outline"
                className="text-sm font-semibold"
              />
              {disruption.nodePool && (
                <Badge variant="outline">
                  <Package className="w-3 h-3 mr-1" />
                  {disruption.nodePool}
                </Badge>
              )}
              {disruption.instanceType && (
                <Badge variant="secondary" className="font-mono text-xs">
                  {disruption.instanceType}
                </Badge>
              )}
              {disruption.capacityType && (
                <Badge variant={disruption.capacityType === 'spot' ? 'secondary' : 'outline'} className="text-[10px]">
                  {disruption.capacityType}
                </Badge>
              )}
              {disruption.costPerHour != null && (
                <span className="text-xs font-semibold text-amber-600" title="Estimated cost while this node still exists">
                  {formatCost(disruption.costPerHour)}/hr
                </span>
              )}
              {pods.length > 0 && (
                <Badge variant="secondary" className="text-xs">
                  {pods.length} pod{pods.length !== 1 ? 's' : ''}
                </Badge>
              )}
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <Clock className="w-3 h-3" />
                {formatTime(disruption.lastSeen)}
              </span>
            </div>
          </div>

          {/* Pods Running on Node */}
          {pods.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm font-semibold flex items-center gap-1">
                <Package className="w-3.5 h-3.5" />
                Pods Running ({pods.length}):
              </p>
              <div className="flex flex-wrap gap-2">
                {pods.map((pod, podIndex) => {
                  const podName = pod.name || pod.workloadName || `pod-${podIndex}`;
                  const namespace = pod.namespace || 'default';
                  const copyValue = `${namespace}/${podName}`;
                  const title = `Pod: ${podName} | Namespace: ${namespace} | Workload: ${pod.workloadName || 'N/A'} | Type: ${pod.workloadType || 'pod'}`;
                  return <CopyableName key={podIndex} value={copyValue} title={title} />;
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
                Blocked: {disruption.blockingReason || 'Cannot evict pods'}
              </AlertTitle>
              <AlertDescription>
                <div className="space-y-3 mt-2">
                  {/* Enhanced PDB Details */}
                  {disruption.blockingPDBDetails && disruption.blockingPDBDetails.length > 0 ? (
                    <div className="space-y-3">
                      <p className="text-sm font-semibold">Pod Disruption Budgets Blocking Eviction:</p>
                      {disruption.blockingPDBDetails.map((pdbDetail, pdbIdx) => (
                        <div key={pdbIdx} className="border-l-2 border-red-400 pl-3 space-y-2">
                          <div className="flex items-center gap-2 flex-wrap">
                            <CopyableName value={pdbDetail.pdbName} />
                            <span className="text-xs text-muted-foreground">
                              {pdbDetail.currentHealthy}/{pdbDetail.desiredHealthy} healthy
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {pdbDetail.disruptionsAllowed === 0 ? (
                                <span className="text-red-600 font-semibold">0 disruptions allowed</span>
                              ) : (
                                <span>{pdbDetail.disruptionsAllowed} disruptions allowed</span>
                              )}
                            </span>
                          </div>
                          {(pdbDetail.minAvailable || pdbDetail.maxUnavailable) && (
                            <div className="text-xs text-muted-foreground">
                              {pdbDetail.minAvailable && (
                                <span>minAvailable: <strong>{pdbDetail.minAvailable}</strong></span>
                              )}
                              {pdbDetail.minAvailable && pdbDetail.maxUnavailable && ' | '}
                              {pdbDetail.maxUnavailable && (
                                <span>maxUnavailable: <strong>{pdbDetail.maxUnavailable}</strong></span>
                              )}
                            </div>
                          )}
                          {pdbDetail.blockingPods && pdbDetail.blockingPods.length > 0 && (
                            <div>
                              <p className="text-xs font-semibold text-muted-foreground mb-1">
                                Blocking {pdbDetail.blockingPods.length} pod{pdbDetail.blockingPods.length !== 1 ? 's' : ''}:
                              </p>
                              <div className="flex flex-wrap gap-1.5">
                                {pdbDetail.blockingPods.map((pod, podIdx) => (
                                  <CopyableName
                                    key={podIdx}
                                    value={pod}
                                    variant="outline"
                                    className="bg-red-50 border-red-300"
                                  />
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    /* Fallback to old format if blockingPDBDetails not available */
                    <>
                      {disruption.blockingPDBs && disruption.blockingPDBs.length > 0 && (
                        <div>
                          <p className="text-sm font-semibold">PDBs:</p>
                          <div className="flex flex-wrap gap-2 mt-1">
                            {disruption.blockingPDBs.map((pdb, idx) => (
                              <CopyableName key={idx} value={pdb} />
                            ))}
                          </div>
                        </div>
                      )}
                      {disruption.blockingPods && disruption.blockingPods.length > 0 && (
                        <div>
                          <p className="text-sm font-semibold">Blocking Pods:</p>
                          <div className="flex flex-wrap gap-2">
                            {disruption.blockingPods.slice(0, 3).map((pod, podIdx) => (
                              <CopyableName key={podIdx} value={pod} />
                            ))}
                            {disruption.blockingPods.length > 3 && (
                              <span className="text-xs text-muted-foreground">
                                +{disruption.blockingPods.length - 3} more
                              </span>
                            )}
                          </div>
                        </div>
                      )}
                    </>
                  )}
                  <p className="text-xs text-muted-foreground italic mt-2 pt-2 border-t flex items-center gap-1">
                    <Lightbulb className="w-3 h-3" />
                    Tip: Review PDB minAvailable/maxUnavailable settings or pod eviction policies to allow node disruption
                  </p>
                </div>
              </AlertDescription>
            </Alert>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

const WINDOW_OPTIONS = [
  { value: '1', label: 'Last 1h' },
  { value: '6', label: 'Last 6h' },
  { value: '24', label: 'Last 24h' },
  { value: '168', label: 'Last 7d' },
];

function DisruptionTracker() {
  const [disruptions, setDisruptions] = useState([]);
  const [summary, setSummary] = useState(null);
  const [recentDeletions, setRecentDeletions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  // null = config not loaded yet (avoids a wrong empty-state flash)
  const [karpenterDetected, setKarpenterDetected] = useState(null);
  const [selectedTypes, setSelectedTypes] = useState(new Set());
  const [showOnlyBlocked, setShowOnlyBlocked] = useState(false);
  const [windowHours, setWindowHours] = useState('24');
  const [autoRefresh, setAutoRefresh] = useState(true);

  // Read Karpenter availability from config to distinguish "no disruptions"
  // from "no disruption tracking without Karpenter".
  useEffect(() => {
    axios.get(`${API_URL}/api/v1/config`)
      .then(res => setKarpenterDetected(res?.data?.karpenter?.detected ?? false))
      .catch(() => {});
  }, []);

  const fetchDisruptions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await axios.get(`${API_URL}/api/v1/disruptions`, {
        params: { hours: Number(windowHours) }
      });
      setDisruptions(response.data.disruptions || []);
      setSummary(response.data.summary || null);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to fetch disruptions');
      console.error('Disruptions error:', err);
    } finally {
      setLoading(false);
    }
  }, [windowHours]);

  const fetchRecentDeletions = useCallback(async () => {
    try {
      const response = await axios.get(`${API_URL}/api/v1/disruptions/recent`, {
        params: { hours: Number(windowHours) }
      });
      setRecentDeletions(response.data.deletions || []);
    } catch (err) {
      // Non-fatal: the recent list is a nicety, not the main view.
      setRecentDeletions([]);
    }
  }, [windowHours]);

  useEffect(() => {
    fetchDisruptions();
    fetchRecentDeletions();
  }, [fetchDisruptions, fetchRecentDeletions]);

  useEffect(() => {
    if (!autoRefresh) return undefined;
    const interval = setInterval(() => {
      fetchDisruptions();
      fetchRecentDeletions();
    }, 60000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchDisruptions, fetchRecentDeletions]);

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

  const blockedDisruptions = useMemo(() => disruptions.filter(d => d.isBlocked), [disruptions]);
  const groupedDisruptions = useMemo(() => {
    const grouped = {};
    filteredDisruptions.forEach(d => {
      const reason = d.reason || 'Unknown';
      if (!grouped[reason]) {
        grouped[reason] = [];
      }
      grouped[reason].push(d);
    });
    return grouped;
  }, [filteredDisruptions]);
  const availableTypes = getAvailableTypes(disruptions);

  // Single pass over blocked disruptions for the focus banner numbers.
  const blockedStats = useMemo(() => ({
    blockedByPdb: blockedDisruptions.filter(
      d => (d.blockingPDBDetails && d.blockingPDBDetails.length > 0) || (d.blockingPDBs && d.blockingPDBs.length > 0),
    ).length,
    blockingPods: countBlockingPods(blockedDisruptions),
    affectedPods: blockedDisruptions.reduce((sum, d) => sum + (d.affectedPods?.length || 0), 0),
    nodePools: new Set(blockedDisruptions.map(d => d.nodePool).filter(Boolean)).size,
  }), [blockedDisruptions]);

  const sortedDisruptions = useMemo(() => filteredDisruptions
    .slice()
    .sort((a, b) => {
      if (a.isBlocked && !b.isBlocked) return -1;
      if (!a.isBlocked && b.isBlocked) return 1;
      if (a.isBlocked && b.isBlocked) {
        const aPDBs = (a.blockingPDBs?.length || 0);
        const bPDBs = (b.blockingPDBs?.length || 0);
        if (aPDBs !== bPDBs) return bPDBs - aPDBs;
      }
      return 0;
    }), [filteredDisruptions]);

  return (
    <Card>
      <CardHeader>
        <div className="flex justify-between items-start">
          <div>
            <CardTitle>Node Disruptions</CardTitle>
            <CardDescription>Live node disruptions based on current node state</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Select value={windowHours} onValueChange={setWindowHours}>
              <SelectTrigger className="w-[110px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WINDOW_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button onClick={fetchDisruptions} disabled={loading} variant="outline" size="sm">
              <RefreshCw className={cn("h-4 w-4 mr-2", loading && "animate-spin")} />
              Refresh
            </Button>
            <div className="flex items-center gap-2">
              <span className="text-sm">Auto-refresh</span>
              <Switch checked={autoRefresh} onCheckedChange={setAutoRefresh} />
            </div>
          </div>
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
          <p className="text-center text-muted-foreground py-8">
            {karpenterDetected === null
              ? 'Loading...'
              : karpenterDetected
                ? 'No active disruptions found'
                : 'No disruption tracking without Karpenter'}
          </p>
        ) : (
          <div className="space-y-4">
            {/* Cost still being incurred */}
            {summary && summary.totalCostPerHour > 0 && (
              <div className="flex items-center gap-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-3">
                <AlertCircle className="h-5 w-5 text-amber-600 shrink-0" />
                <div className="text-sm">
                  <span className="font-semibold text-amber-800">
                    {formatCost(summary.totalCostPerHour)}/hr ({formatCost(summary.totalCostPerDay)}/day)
                  </span>{' '}
                  <span className="text-amber-800/80">
                    still billed across {disruptions.length} disrupted node{disruptions.length !== 1 ? 's' : ''}
                    {summary.blockedCount > 0 && ` (${summary.blockedCount} blocked)`}
                  </span>
                </div>
              </div>
            )}

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
                      {blockedStats.blockedByPdb > 0 && (
                        <span className="text-sm">
                          <strong>{blockedStats.blockedByPdb}</strong> blocked by PDBs
                        </span>
                      )}
                      {blockedStats.blockingPods > 0 && (
                        <span className="text-sm">
                          <strong>{blockedStats.blockingPods}</strong> blocking pod{blockedStats.blockingPods !== 1 ? 's' : ''}
                        </span>
                      )}
                      {blockedStats.affectedPods > 0 && (
                        <span className="text-sm">
                          <strong>{blockedStats.affectedPods}</strong> total pods affected
                        </span>
                      )}
                      {blockedStats.nodePools > 0 && (
                        <span className="text-sm">
                          Across <strong>{blockedStats.nodePools}</strong> NodePool(s)
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
              {sortedDisruptions.map((disruption) => (
                <DisruptionCard key={disruption.nodeName} disruption={disruption} />
              ))}
            </div>

            {/* Recent deletions (nodes that were disrupted and already left) */}
            {recentDeletions.length > 0 && (
              <div className="space-y-2 pt-2 border-t">
                <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  Recently Terminated ({recentDeletions.length})
                </h3>
                <div className="rounded-md border divide-y">
                  {recentDeletions.map((d) => {
                    const color = getReasonColor(d.reason);
                    return (
                      <div key={d.nodeName} className="flex items-center gap-3 px-3 py-2">
                        <Badge className={color.className}>
                          {color.label}
                        </Badge>
                        <CopyableName
                          value={d.nodeName}
                          variant="outline"
                          className="text-xs"
                        />
                        {d.nodePool && (
                          <Badge variant="outline" className="text-xs">{d.nodePool}</Badge>
                        )}
                        {d.instanceType && (
                          <Badge variant="secondary" className="font-mono text-xs">{d.instanceType}</Badge>
                        )}
                        <span className="ml-auto text-xs text-muted-foreground flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {formatTime(d.lastSeen)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default DisruptionTracker;

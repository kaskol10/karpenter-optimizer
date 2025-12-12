import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from './ui/card';
import { Button } from './ui/button';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { Progress } from './ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Switch } from './ui/switch';
import { RefreshCw, Zap, Loader2 } from 'lucide-react';
import { cn } from '../lib/utils';

// Use runtime configuration from window.ENV (set via config.js) or build-time env var
const API_URL = (window.ENV && window.ENV.hasOwnProperty('REACT_APP_API_URL')) 
  ? window.ENV.REACT_APP_API_URL 
  : (process.env.REACT_APP_API_URL || '');

function GlobalClusterSummary({ onRecommendationsGenerated, onClusterCostUpdate }) {
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshInterval, setRefreshInterval] = useState(60);
  const [generatingRecommendations, setGeneratingRecommendations] = useState(false);
  const [clusterCost, setClusterCost] = useState(null);
  const [progressMessage, setProgressMessage] = useState('');
  const [progressPercent, setProgressPercent] = useState(0);

  useEffect(() => {
    fetchSummary();
  }, []);

  useEffect(() => {
    let interval;
    if (autoRefresh) {
      interval = setInterval(() => {
        fetchSummary();
      }, refreshInterval * 1000);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [autoRefresh, refreshInterval]);

  const fetchSummary = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await axios.get(`${API_URL}/api/v1/cluster/summary`);
      setSummary(response.data.summary);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to fetch cluster summary');
      console.error('Cluster summary error:', err);
    } finally {
      setLoading(false);
    }
  };

  const formatResource = (value, type) => {
    if (type === 'cpu') {
      return `${value.toFixed(2)} cores`;
    } else {
      return `${value.toFixed(2)} GiB`;
    }
  };

  const handleGenerateRecommendations = async () => {
    if (!summary) {
      setError('Please wait for cluster summary to load');
      return;
    }

    setGeneratingRecommendations(true);
    setError(null);
    setProgressMessage('Starting...');
    setProgressPercent(0);

    try {
      const eventSource = new EventSource(`${API_URL}/api/v1/recommendations/cluster-summary/stream`);

      eventSource.addEventListener('progress', (event) => {
        try {
          const data = JSON.parse(event.data);
          const message = data.message || 'Processing...';
          const progress = Math.max(0, Math.min(100, data.progress || 0));
          console.log(`[Progress] ${progress.toFixed(1)}%: ${message}`);
          setProgressMessage(message);
          setProgressPercent(progress);
        } catch (err) {
          console.error('Error parsing progress event:', err, 'Raw data:', event.data);
        }
      });

      eventSource.addEventListener('complete', (event) => {
        try {
          console.log('[SSE] Received complete event');
          const data = JSON.parse(event.data);
          if (onRecommendationsGenerated) {
            onRecommendationsGenerated(data.recommendations || []);
          }
          if (data.clusterCost) {
            const costData = {
              ...data.clusterCost,
              clusterNodes: data.clusterNodes,
              totalNodePools: data.totalNodePools,
              recommendedCount: data.count
            };
            setClusterCost(costData);
            if (onClusterCostUpdate) {
              onClusterCostUpdate(costData);
            }
          }
          setProgressMessage('Complete!');
          setProgressPercent(100);
          eventSource.close();
          setTimeout(() => {
            setGeneratingRecommendations(false);
            setProgressMessage('');
            setProgressPercent(0);
          }, 1000);
        } catch (err) {
          console.error('Error parsing complete event:', err, 'Raw data:', event.data);
          eventSource.close();
          setGeneratingRecommendations(false);
          setProgressMessage('');
          setProgressPercent(0);
        }
      });

      eventSource.addEventListener('error', (event) => {
        try {
          console.error('[SSE] Received error event:', event.data);
          const data = JSON.parse(event.data);
          setError(data.error || 'Failed to generate recommendations');
        } catch (err) {
          console.error('[SSE] Error parsing error event:', err, 'Raw data:', event.data);
          setError('Failed to generate recommendations');
        }
        eventSource.close();
        setGeneratingRecommendations(false);
        setProgressMessage('');
        setProgressPercent(0);
      });

      eventSource.onerror = (err) => {
        console.error('EventSource connection error:', err);
        if (eventSource.readyState === EventSource.CLOSED || (progressPercent < 100 && eventSource.readyState !== EventSource.OPEN)) {
          setError('Connection error. Please try again.');
          eventSource.close();
          setGeneratingRecommendations(false);
          setProgressMessage('');
          setProgressPercent(0);
        }
      };

    } catch (err) {
      setError(err.message || 'Failed to generate recommendations');
      console.error('Recommendations error:', err);
      setGeneratingRecommendations(false);
      setProgressMessage('');
      setProgressPercent(0);
    }
  };

  const getUsageColor = (percent) => {
    if (percent >= 90) return 'text-red-600';
    if (percent >= 70) return 'text-yellow-600';
    return 'text-green-600';
  };

  if (error && !summary) {
    return (
      <Card>
        <CardContent className="pt-6">
          <Alert variant="destructive">
            <AlertTitle>Error</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  if (!summary) {
    return (
      <Card>
        <CardContent className="pt-6">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground mb-2" />
              <p className="text-sm text-muted-foreground">Loading cluster summary...</p>
            </div>
          ) : (
            <p className="text-center text-muted-foreground py-8">No cluster data available</p>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex justify-between items-start">
          <div>
            <CardTitle>Cluster Overview</CardTitle>
            <CardDescription>Global cluster statistics</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={fetchSummary} disabled={loading} size="sm" variant="outline">
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
        <div className="space-y-4">
          {/* Generate Recommendations Button */}
          <div className="flex justify-center p-4 bg-gradient-to-br from-purple-500 to-purple-700 rounded-lg">
            <Button
              onClick={handleGenerateRecommendations}
              disabled={!summary || generatingRecommendations}
              size="lg"
              className="bg-white text-purple-600 hover:bg-white/90 font-bold min-w-[250px]"
            >
              <Zap className="h-5 w-5 mr-2" />
              Generate Recommendations
            </Button>
          </div>

          {generatingRecommendations && progressMessage && (
            <Alert>
              <AlertTitle className="flex items-center justify-between">
                <span>{progressMessage}</span>
                <span className="font-bold">{Math.round(progressPercent)}%</span>
              </AlertTitle>
              <Progress value={progressPercent} className="mt-2" />
            </Alert>
          )}

          {error && (
            <Alert variant="destructive">
              <AlertTitle>Error</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {/* Cluster Cost Summary */}
          {clusterCost && (
            <Card className="bg-gradient-to-br from-purple-500 to-purple-700 border-0">
              <CardHeader>
                <CardTitle className="text-white text-sm">Cluster Cost Summary</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div>
                    <p className="text-white/80 text-xs mb-1">Current Cost</p>
                    <p className="text-white text-2xl font-bold">
                      ${clusterCost.current.toFixed(2)}/hr
                    </p>
                  </div>
                  <div>
                    <p className="text-white/80 text-xs mb-1">Recommended Cost</p>
                    <p className="text-white text-2xl font-bold">
                      ${clusterCost.recommended.toFixed(2)}/hr
                    </p>
                  </div>
                  <div>
                    <p className="text-white/80 text-xs mb-1">Potential Savings</p>
                    <p className={cn("text-2xl font-bold", clusterCost.savings > 0 ? "text-green-300" : "text-yellow-300")}>
                      {clusterCost.savings > 0 ? '-' : '+'}${Math.abs(clusterCost.savings).toFixed(2)}/hr
                    </p>
                    {clusterCost.current > 0 && (
                      <p className="text-white/80 text-xs mt-1">
                        {((clusterCost.savings / clusterCost.current) * 100).toFixed(1)}% {clusterCost.savings > 0 ? 'reduction' : 'increase'}
                      </p>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Statistics Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            <Card>
              <CardContent className="pt-6">
                <p className="text-sm text-muted-foreground">Total Nodes</p>
                <p className="text-2xl font-bold">{summary.totalNodes}</p>
              </CardContent>
            </Card>

            <Card className="bg-yellow-50 border-yellow-200">
              <CardContent className="pt-6">
                <p className="text-sm text-muted-foreground">Spot Instances</p>
                <p className="text-2xl font-bold text-yellow-600">{summary.spotNodes}</p>
                {summary.totalNodes > 0 && (
                  <p className="text-xs text-muted-foreground mt-1">
                    ({((summary.spotNodes / summary.totalNodes) * 100).toFixed(1)}%)
                  </p>
                )}
              </CardContent>
            </Card>

            <Card className="bg-blue-50 border-blue-200">
              <CardContent className="pt-6">
                <p className="text-sm text-muted-foreground">On-Demand Instances</p>
                <p className="text-2xl font-bold text-blue-600">{summary.onDemandNodes}</p>
                {summary.totalNodes > 0 && (
                  <p className="text-xs text-muted-foreground mt-1">
                    ({((summary.onDemandNodes / summary.totalNodes) * 100).toFixed(1)}%)
                  </p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-6">
                <p className="text-sm text-muted-foreground">Total Pods</p>
                <p className="text-2xl font-bold">{summary.totalPods}</p>
                {summary.totalNodes > 0 && (
                  <p className="text-xs text-muted-foreground mt-1">
                    ({(summary.totalPods / summary.totalNodes).toFixed(1)} per node)
                  </p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-6">
                <p className="text-sm text-muted-foreground">CPU Usage</p>
                <p className={cn("text-2xl font-bold", getUsageColor(summary.cpuPercent))}>
                  {summary.cpuPercent.toFixed(1)}%
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {formatResource(summary.cpuUsed, 'cpu')} / {formatResource(summary.cpuAllocatable, 'cpu')}
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-6">
                <p className="text-sm text-muted-foreground">Memory Usage</p>
                <p className={cn("text-2xl font-bold", getUsageColor(summary.memoryPercent))}>
                  {summary.memoryPercent.toFixed(1)}%
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {formatResource(summary.memoryUsed, 'memory')} / {formatResource(summary.memoryAllocatable, 'memory')}
                </p>
              </CardContent>
            </Card>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default GlobalClusterSummary;

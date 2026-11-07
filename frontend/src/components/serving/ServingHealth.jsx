import React, { useState, useCallback, useMemo } from 'react';
import axios from 'axios';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Button } from '../ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Alert, AlertTitle } from '../ui/alert';
import { SkeletonRows } from '../ui/skeleton';
import { EmptyState } from '../ui/empty-state';
import { RefreshCw, Loader2, Server, AlertTriangle } from 'lucide-react';
import { cn } from '../../lib/utils';
import { findGpuNeighbours } from '../../lib/servingPlacement';
import { sortByAttention } from '../../lib/servingStatus';
import { API_URL } from '../../lib/api';
import { usePolling } from '../../hooks/usePolling';
import { useUrlParam } from '../../hooks/useUrlParam';
import { GatewayCard } from './GatewayCard';
import { ModelUsageChart } from './ModelUsageChart';
import { ServingCard } from './ServingCard';

const SERVING_SORTS = ['attention', 'throughput', 'requests', 'queue', 'name'];

const TREND_WINDOWS = ['1h', '6h', '24h', '7d'];

// ServingHealth lists LLM serving pods (vLLM/sglang) and their inference health.
function ServingHealth({ onOpenTopology }) {
  const [pods, setPods] = useState(null);
  const [topologyNodes, setTopologyNodes] = useState(null); // for GPU co-location
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  // Default: worst first, so a struggling replica is never at the bottom of
  // the grid. ?sort=throughput etc. still selects the other orders.
  const [sortBy, setSortBy] = useUrlParam('sort', 'attention', SERVING_SORTS);
  const [trendWindow, setTrendWindow] = useUrlParam('trend', '6h', TREND_WINDOWS);
  const [servingHistory, setServingHistory] = useState({}); // key: ns/name -> {points, lastIssue}
  const [gateway, setGateway] = useState(null);
  const [gatewayView, setGatewayView] = useState('apps'); // 'apps' | 'models'
  const [gatewaySplit, setGatewaySplit] = useState('app'); // 'app' | 'apikey' | 'team'

  const fetchServing = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await axios.get(`${API_URL}/api/v1/serving`);
      setPods(response.data.pods || []);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to fetch serving health');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchServingHistory = useCallback(async () => {
    try {
      const response = await axios.get(`${API_URL}/api/v1/serving/history`, {
        params: { window: trendWindow },
      });
      const byKey = {};
      (response.data.pods || []).forEach((p) => {
        byKey[`${p.namespace}/${p.name}`] = { points: p.points || [], lastIssue: p.lastIssue || 0 };
      });
      setServingHistory(byKey);
    } catch (err) {
      // Non-fatal: trends are an enhancement, never block the health view.
      setServingHistory({});
    }
  }, [trendWindow]);

  // Gateway health is a separate concern (LiteLLM proxy /metrics), fetched on
  // its own so a gateway failure never blocks the pod health view. null when
  // no LiteLLM proxy is detected (the card then hides itself).
  const fetchGateway = useCallback(async () => {
    try {
      const response = await axios.get(`${API_URL}/api/v1/serving/gateway`);
      setGateway(response.data.gateway || null);
    } catch (err) {
      setGateway(null);
    }
  }, []);

  // Topology tells us who else sits on each serving pod's GPU (noisy
  // neighbours). Non-fatal and slower-paced: placement changes rarely.
  const fetchTopology = useCallback(async () => {
    try {
      const response = await axios.get(`${API_URL}/api/v1/topology`);
      setTopologyNodes(response.data.nodes || []);
    } catch (err) {
      setTopologyNodes(null);
    }
  }, []);

  usePolling(fetchTopology, 60000);

  const placements = useMemo(() => {
    const byKey = {};
    if (!pods || !topologyNodes) return byKey;
    pods.forEach((p) => {
      byKey[`${p.namespace}/${p.name}`] = findGpuNeighbours(p, topologyNodes);
    });
    return byKey;
  }, [pods, topologyNodes]);

  usePolling(fetchServing, 30000);

  usePolling(fetchGateway, 30000);

  // Trend history is sampled server-side on the 60s cluster interval, so a
  // slower refresh (60s) keeps sparklines current without hammering the API.
  usePolling(fetchServingHistory, 60000);

  const sortedPods = useMemo(() => {
    if (!pods) return pods;
    if (sortBy === 'attention') return sortByAttention(pods);
    const byThroughput = (p) => (p.tokensPerSec ?? -1);
    const byRequests = (p) => (p.requestsPerSec ?? -1);
    const byQueue = (p) => (p.running || 0) + (p.waiting || 0);
    return pods.slice().sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1; // online first
      switch (sortBy) {
        case 'queue':
          return byQueue(b) - byQueue(a);
        case 'name':
          return `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`);
        case 'requests':
          return byRequests(b) - byRequests(a);
        case 'throughput':
        default:
          return byThroughput(b) - byThroughput(a);
      }
    });
  }, [pods, sortBy]);

  return (
    <Card>
      <CardHeader>
        <div className="flex justify-between items-start">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Server className="h-5 w-5 text-purple-600" />
              LLM Serving Health
            </CardTitle>
            <CardDescription>
              Inference health for vLLM/sglang pods detected in the cluster
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Select value={trendWindow} onValueChange={setTrendWindow}>
              <SelectTrigger className="w-[130px]" title="Trend history window" aria-label="Trend history window">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1h">Trends: 1h</SelectItem>
                <SelectItem value="6h">Trends: 6h</SelectItem>
                <SelectItem value="24h">Trends: 24h</SelectItem>
                <SelectItem value="7d">Trends: 7d</SelectItem>
              </SelectContent>
            </Select>
            <Select value={sortBy} onValueChange={setSortBy}>
              <SelectTrigger className="w-[210px]" aria-label="Sort servers">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="attention">Sort: Needs attention</SelectItem>
                <SelectItem value="throughput">Sort: Throughput</SelectItem>
                <SelectItem value="requests">Sort: Requests/s</SelectItem>
                <SelectItem value="queue">Sort: Active load</SelectItem>
                <SelectItem value="name">Sort: Name</SelectItem>
              </SelectContent>
            </Select>
            <button
              type="button"
              onClick={fetchServing}
              disabled={loading}
              className="rounded-md border p-1.5 hover:bg-muted"
              aria-label="Refresh"
            >
              <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
            </button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {error ? (
          <Alert variant="destructive">
            <AlertTitle>
              <AlertTriangle className="h-4 w-4" /> {error}
            </AlertTitle>
            <Button variant="outline" size="sm" className="mt-2" onClick={fetchServing}>
              <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
              Retry
            </Button>
          </Alert>
        ) : (
          <div className="space-y-4">
            <GatewayCard gateway={gateway} view={gatewayView} onViewChange={setGatewayView} split={gatewaySplit} onSplitChange={setGatewaySplit} />
            {pods === null ? (
              <div className="flex flex-col items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground mb-2" />
                <p className="text-sm text-muted-foreground">Probing LLM servers...</p>
                <SkeletonRows className="mt-6 w-full max-w-md" rows={3} />
              </div>
            ) : pods.length === 0 ? (
              <EmptyState
                icon={Server}
                title="No LLM serving pods detected"
                hint="Serving health is shown for pods running vLLM or sglang (detected from container images and commands). Deploy a serving workload to see inference metrics here."
              />
            ) : (
              <>
                <ModelUsageChart pods={pods} />
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {sortedPods.map((pod) => (
                    <ServingCard
                      key={`${pod.namespace}/${pod.name}`}
                      pod={pod}
                      peers={pods}
                      history={servingHistory[`${pod.namespace}/${pod.name}`]}
                      placement={placements[`${pod.namespace}/${pod.name}`]}
                      onOpenTopology={onOpenTopology}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default ServingHealth;

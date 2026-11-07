import React, { useState, useCallback, useMemo, useEffect } from 'react';
import axios from 'axios';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Button } from '../ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Alert, AlertTitle } from '../ui/alert';
import { SkeletonRows } from '../ui/skeleton';
import { EmptyState } from '../ui/empty-state';
import { RefreshCw, Loader2, Server, AlertTriangle, Rows3, LayoutGrid } from 'lucide-react';
import { cn } from '../../lib/utils';
import { placementFromServing } from '../../lib/servingPlacement';
import { sortByAttention } from '../../lib/servingStatus';
import { groupByModel, hasProblem, sortModels } from '../../lib/servingModels';
import { buildTriage } from '../../lib/servingTriage';
import { modelCost } from '../../lib/servingCost';
import { modelHeadroom } from '../../lib/servingHeadroom';
import { API_URL } from '../../lib/api';
import { usePolling } from '../../hooks/usePolling';
import { useUrlParam } from '../../hooks/useUrlParam';
import { GatewayCard } from './GatewayCard';
import { ModelRow } from './ModelRow';
import { ServingCard, servingCardId } from './ServingCard';
import { TriageList } from './TriageList';

const SERVING_SORTS = ['attention', 'throughput', 'requests', 'queue', 'name'];

const TREND_WINDOWS = ['1h', '6h', '24h', '7d'];

const SERVING_VIEWS = ['model', 'replicas'];

const podKeyOf = (p) => `${p.namespace}/${p.name}`;

// ServingHealth lists LLM serving pods (vLLM/sglang) and their inference
// health: a triage list of what needs a human, then one row per model
// (expanding into its replica cards), or the flat replica grid (?view=replicas).
function ServingHealth({ onOpenTopology, onOpenLogs }) {
  const [pods, setPods] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  // Default: worst first, so a struggling replica is never at the bottom of
  // the grid. ?sort=throughput etc. still selects the other orders.
  const [sortBy, setSortBy] = useUrlParam('sort', 'attention', SERVING_SORTS);
  const [trendWindow, setTrendWindow] = useUrlParam('trend', '6h', TREND_WINDOWS);
  const [view, setView] = useUrlParam('view', 'model', SERVING_VIEWS);
  // Rows with a problem start expanded; a click on the chevron overrides that
  // per model until the page is reloaded.
  const [expandedOverrides, setExpandedOverrides] = useState({});
  const [highlightKey, setHighlightKey] = useState(null);
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

  // GPU neighbours come with /api/v1/serving (computed server-side), so the
  // tab no longer downloads the whole topology to find them.
  const placements = useMemo(() => {
    const byKey = {};
    (pods || []).forEach((p) => {
      byKey[`${p.namespace}/${p.name}`] = placementFromServing(p);
    });
    return byKey;
  }, [pods]);

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

  const modelGroups = useMemo(
    () => (pods ? sortModels(groupByModel(pods, placements), sortBy) : []),
    [pods, placements, sortBy],
  );

  const triage = useMemo(
    () => (pods ? buildTriage(pods, placements, servingHistory) : []),
    [pods, placements, servingHistory],
  );

  const isExpanded = (group) => expandedOverrides[group.model] ?? hasProblem(group);
  const toggleModel = (group) =>
    setExpandedOverrides((prev) => ({ ...prev, [group.model]: !isExpanded(group) }));

  // focusCard opens the replica's model row (in model view), then scrolls to
  // and briefly rings its card once it has rendered.
  const focusCard = useCallback(
    (pod) => {
      const group = modelGroups.find((g) => g.replicas.includes(pod));
      if (group) setExpandedOverrides((prev) => ({ ...prev, [group.model]: true }));
      setHighlightKey(podKeyOf(pod));
    },
    [modelGroups],
  );

  useEffect(() => {
    if (!highlightKey) return undefined;
    const [namespace, name] = highlightKey.split('/');
    const el = document.getElementById(servingCardId({ namespace, name }));
    el?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    const t = setTimeout(() => setHighlightKey(null), 2400);
    return () => clearTimeout(t);
  }, [highlightKey]);

  const renderCard = (pod) => (
    <ServingCard
      key={podKeyOf(pod)}
      pod={pod}
      peers={pods}
      history={servingHistory[podKeyOf(pod)]}
      placement={placements[podKeyOf(pod)]}
      onOpenTopology={onOpenTopology}
      highlighted={highlightKey === podKeyOf(pod)}
    />
  );

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap justify-between items-start gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Server className="h-5 w-5 text-purple-600" />
              LLM Serving Health
            </CardTitle>
            <CardDescription>
              Inference health for vLLM/sglang pods detected in the cluster
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-md border p-0.5" role="group" aria-label="Group servers">
              {[
                { value: 'model', label: 'By model', Icon: Rows3 },
                { value: 'replicas', label: 'All replicas', Icon: LayoutGrid },
              ].map(({ value, label, Icon }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setView(value)}
                  aria-pressed={view === value}
                  title={label}
                  className={cn(
                    'inline-flex items-center gap-1 rounded px-2 py-1 text-xs',
                    view === value ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/50',
                  )}
                >
                  <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                  {label}
                </button>
              ))}
            </div>
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
                <TriageList
                  items={triage}
                  onOpenTopology={onOpenTopology}
                  onOpenLogs={onOpenLogs}
                  onFocusCard={focusCard}
                />
                {view === 'model' ? (
                  <div className="space-y-3">
                    {modelGroups.map((group) => (
                      <ModelRow
                        key={group.model}
                        group={group}
                        cost={modelCost(group.replicas)}
                        headroom={modelHeadroom(group.replicas, servingHistory)}
                        expanded={isExpanded(group)}
                        onToggle={() => toggleModel(group)}
                        onSelectReplica={focusCard}
                      >
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                          {sortedPods.filter((p) => group.replicas.includes(p)).map(renderCard)}
                        </div>
                      </ModelRow>
                    ))}
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {sortedPods.map(renderCard)}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default ServingHealth;

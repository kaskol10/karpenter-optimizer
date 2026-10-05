import React, { useState, useEffect, useCallback, useMemo } from 'react';
import axios from 'axios';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from './ui/card';
import { Badge } from './ui/badge';
import { Progress } from './ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { RefreshCw, Loader2, Server, Cpu, Clock, AlertTriangle, BarChart3 } from 'lucide-react';
import { cn } from '../lib/utils';

const API_URL = (window.ENV && window.ENV.hasOwnProperty('REACT_APP_API_URL'))
  ? window.ENV.REACT_APP_API_URL
  : (process.env.REACT_APP_API_URL || '');

// ServingCard renders inference health for a single LLM serving pod.
function ServingCard({ pod }) {
  const kv = pod.kvCachePercent;

  return (
    <Card className={cn(!pod.online && 'border-dashed border-red-300')}>
      <CardHeader className="pb-2">
        <div className="flex justify-between items-start gap-2">
          <div className="min-w-0">
            <CardTitle className="text-sm font-mono truncate">
              {pod.namespace}/{pod.name}
            </CardTitle>
            <CardDescription className="truncate">
              {pod.model || 'unknown model'}
            </CardDescription>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <Badge variant="outline" className="text-[10px]">{pod.backend}</Badge>
            <Badge variant={pod.online ? 'default' : 'destructive'} className="text-[10px]">
              {pod.online ? 'online' : 'offline'}
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {!pod.online ? (
          <div className="space-y-1">
            <AlertTriangle className="h-4 w-4 text-red-500" />
            <p className="text-xs text-red-600">{pod.error || 'unreachable'}</p>
          </div>
        ) : (
          <div className="space-y-3">
            {/* KV cache usage */}
            {kv !== undefined && kv !== null ? (
              <div>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-muted-foreground">KV cache</span>
                  <span className="font-mono font-semibold">{kv.toFixed(1)}%</span>
                </div>
                <Progress value={kv} className="h-2" />
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">KV cache: n/a</p>
            )}

            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-md bg-card/60 py-2">
                <p className="text-xs text-muted-foreground flex items-center justify-center gap-1">
                  <Cpu className="h-3 w-3" /> Running
                </p>
                <p className="text-lg font-bold">{pod.running ?? 0}</p>
              </div>
              <div className="rounded-md bg-card/60 py-2">
                <p className="text-xs text-muted-foreground">Waiting</p>
                <p className={cn("text-lg font-bold", (pod.waiting ?? 0) > 0 && "text-yellow-600")}>
                  {pod.waiting ?? 0}
                </p>
              </div>
              <div className="rounded-md bg-card/60 py-2">
                <p className="text-xs text-muted-foreground flex items-center justify-center gap-1">
                  <Clock className="h-3 w-3" /> Preempt
                </p>
                <p className="text-lg font-bold">{pod.preemptions ?? 0}</p>
              </div>
            </div>

            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
              {pod.ttftSeconds !== undefined && pod.ttftSeconds !== null && (
                <span className="text-muted-foreground">
                  TTFT <span className="font-mono text-foreground">{pod.ttftSeconds.toFixed(3)}s</span>
                  {pod.ttftP95Seconds !== undefined && pod.ttftP95Seconds !== null && (
                    <span className="ml-1">
                      (p95 {pod.ttftP95Seconds.toFixed(3)}s)
                    </span>
                  )}
                </span>
              )}
              {pod.tokensPerSec !== undefined && pod.tokensPerSec !== null && (
                <span className="text-muted-foreground">
                  Throughput <span className="font-mono text-foreground">{pod.tokensPerSec.toFixed(1)} tok/s</span>
                </span>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ModelUsageChart ranks the serving pods by throughput (tok/s) to show which
// models are the most used, with a small queue (running+waiting) indicator.
function ModelUsageChart({ pods }) {
  const rows = useMemo(() => {
    const withUsage = pods.filter(
      (p) => p.online && p.tokensPerSec !== null && p.tokensPerSec !== undefined,
    );
    const max = Math.max(1, ...withUsage.map((p) => p.tokensPerSec));
    return withUsage
      .slice()
      .sort((a, b) => b.tokensPerSec - a.tokensPerSec)
      .map((p, i) => ({ pod: p, rank: i + 1, pct: (p.tokensPerSec / max) * 100 }));
  }, [pods]);

  if (rows.length === 0) {
    return null;
  }

  return (
    <div className="mb-4 rounded-md border bg-card/40 p-3">
      <p className="text-xs font-semibold flex items-center gap-1.5 mb-2 text-muted-foreground">
        <BarChart3 className="h-3.5 w-3.5" />
        Model usage (throughput)
      </p>
      <div className="space-y-1.5">
        {rows.map(({ pod, rank, pct }) => {
          const queue = (pod.running || 0) + (pod.waiting || 0);
          return (
            <div key={`${pod.namespace}/${pod.name}`} className="flex items-center gap-2">
              <span className="w-4 text-right text-[10px] font-mono text-muted-foreground shrink-0">
                {rank}
              </span>
              <span className="w-32 truncate text-xs shrink-0" title={`${pod.namespace}/${pod.name} — ${pod.model || 'unknown model'}`}>
                {pod.model || `${pod.namespace}/${pod.name}`}
              </span>
              <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full bg-purple-500"
                  style={{ width: `${Math.max(pct, 1.5)}%` }}
                />
              </div>
              <span className="w-20 text-right text-[10px] font-mono shrink-0">
                {pod.tokensPerSec.toFixed(1)} tok/s
              </span>
              <span
                className={cn(
                  'w-16 text-right text-[10px] shrink-0 font-mono',
                  (pod.waiting || 0) > 0 ? 'text-yellow-600 font-semibold' : 'text-muted-foreground',
                )}
                title={`running: ${pod.running ?? 0}, waiting: ${pod.waiting ?? 0}`}
              >
                {queue} req
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ServingHealth lists LLM serving pods (vLLM/sglang) and their inference health.
function ServingHealth() {
  const [pods, setPods] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [sortBy, setSortBy] = useState('throughput');

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

  useEffect(() => {
    fetchServing();
    const interval = setInterval(fetchServing, 30000);
    return () => clearInterval(interval);
  }, [fetchServing]);

  const sortedPods = useMemo(() => {
    if (!pods) return pods;
    const byThroughput = (p) => (p.tokensPerSec ?? -1);
    const byQueue = (p) => (p.running || 0) + (p.waiting || 0);
    return pods.slice().sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1; // online first
      switch (sortBy) {
        case 'queue':
          return byQueue(b) - byQueue(a);
        case 'name':
          return `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`);
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
            <Select value={sortBy} onValueChange={setSortBy}>
              <SelectTrigger className="w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="throughput">Sort: Throughput</SelectItem>
                <SelectItem value="queue">Sort: Active load</SelectItem>
                <SelectItem value="name">Sort: Name</SelectItem>
              </SelectContent>
            </Select>
            <button
              type="button"
              onClick={fetchServing}
              disabled={loading}
              className="rounded-md border p-1.5 hover:bg-gray-100"
              aria-label="Refresh"
            >
              <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
            </button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {error ? (
          <p className="text-sm text-red-600 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" /> {error}
          </p>
        ) : pods === null ? (
          <div className="flex flex-col items-center justify-center py-8">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground mb-2" />
            <p className="text-sm text-muted-foreground">Probing LLM servers...</p>
          </div>
        ) : pods.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            No LLM serving pods detected (looking for vLLM/sglang images or commands).
          </p>
        ) : (
          <div className="space-y-4">
            <ModelUsageChart pods={pods} />
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {sortedPods.map((pod) => (
                <ServingCard key={`${pod.namespace}/${pod.name}`} pod={pod} />
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default ServingHealth;

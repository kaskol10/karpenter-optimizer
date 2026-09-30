import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from './ui/card';
import { Badge } from './ui/badge';
import { Progress } from './ui/progress';
import { RefreshCw, Loader2, Server, Cpu, Clock, AlertTriangle } from 'lucide-react';
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

// ServingHealth lists LLM serving pods (vLLM/sglang) and their inference health.
function ServingHealth() {
  const [pods, setPods] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

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
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {pods.map((pod) => (
              <ServingCard key={`${pod.namespace}/${pod.name}`} pod={pod} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default ServingHealth;

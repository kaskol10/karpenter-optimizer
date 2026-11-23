import React from 'react';
import { GitFork, RefreshCw } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { SkeletonRows } from '../ui/skeleton';
import { cn } from '../../lib/utils';
import { useUrlParam } from '../../hooks/useUrlParam';
import { useGatewayRouting } from '../../hooks/useGatewayRouting';
import { FallbackMap } from './FallbackMap';

const RANGES = ['24h', '7d', '30d'];

// FallbackCard is the Gateway page's "Routing and fallbacks" card: the
// LiteLLM fallback configuration (read from the proxy's ConfigMap) over the
// fallbacks taken in ?fallbacks=24h|7d|30d. Hidden when no config is named
// and the backend is older; a hint says how to turn it on otherwise.
export function FallbackCard() {
  const [range, setRange] = useUrlParam('fallbacks', '7d', RANGES);
  const { status, data, error, reload } = useGatewayRouting(range);
  const source = data?.source;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <GitFork className="h-5 w-5 text-primary" aria-hidden="true" />
          Routing and fallbacks
        </CardTitle>
        <CardDescription>
          What LiteLLM does when a model fails: the fallback it is configured to try, how often it took it, and why.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {status === 'unavailable' ? (
          <p className="text-sm text-muted-foreground">
            Name the ConfigMap that holds the LiteLLM <code>config.yaml</code> to see this: chart values <code>litellmConfig.namespace</code> and{' '}
            <code>litellmConfig.configMapName</code> (or <code>LITELLM_CONFIGMAP_NAMESPACE</code> and <code>LITELLM_CONFIGMAP_NAME</code>). Only the
            routing is read; API keys stay in the ConfigMap.
          </p>
        ) : !data && status === 'loading' ? (
          <SkeletonRows rows={5} />
        ) : (
          <div className="space-y-3">
            {error && (
              <div className="flex items-start justify-between gap-3 rounded-lg border border-red-300 px-3 py-2 text-sm dark:border-red-800" role="alert">
                <span>
                  {data?.config ? 'Could not refresh: ' : ''}
                  {error}
                </span>
                <button type="button" className="inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-0.5 text-xs" onClick={reload}>
                  <RefreshCw className="h-3 w-3" aria-hidden="true" /> Retry
                </button>
              </div>
            )}
            {data?.config && (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>
                    From ConfigMap{' '}
                    <span className="font-mono">
                      {source?.namespace}/{source?.configMap}
                    </span>
                    {data.observed
                      ? ''
                      : data.observedError
                        ? ` · fallbacks taken are not shown: ${data.observedError}`
                        : ' · set PROMETHEUS_URL to also see the fallbacks taken'}
                  </span>
                  {data.observed && (
                    <div role="group" aria-label="Fallbacks taken in" className="inline-flex rounded-md border p-0.5">
                      {RANGES.map((r) => (
                        <button
                          key={r}
                          type="button"
                          aria-pressed={range === r}
                          className={cn('rounded px-2 py-0.5', range === r ? 'bg-muted text-foreground' : 'hover:text-foreground')}
                          onClick={() => setRange(r)}
                        >
                          {r}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <FallbackMap routing={data} />
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

import React, { useState, Fragment } from 'react';
import { Badge } from '../ui/badge';
import { Server, AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '../../lib/utils';
import { GatewayCostHistory } from './GatewayCostHistory';
import { formatTokens } from './shared';

// GatewayCard renders aggregated LiteLLM AI-gateway health: a row of stat
// tiles (in-flight, admission queue, 503 rejections, error rate, E2E p95,
// gateway overhead p95, requests/s) and a breakdown table. The breakdown can be
// grouped by App / API key / Team and shown per-model or per-app. When the
// gateway's /metrics requires auth it shows an actionable 401 hint instead of
// the numbers.
// splitDimMaps: UI key -> { top: GatewayHealth field, model: ModelStat field, label }
export const SPLIT_DIMS = [
  { key: 'app', top: 'apps', model: 'apps', label: 'App' },
  { key: 'apikey', top: 'apiKeys', model: 'apiKeys', label: 'API key' },
  { key: 'team', top: 'teams', model: 'teams', label: 'Team' },
];

const splitDimFor = (key) => SPLIT_DIMS.find((d) => d.key === key) || SPLIT_DIMS[0];

export function GatewayCard({ gateway, view = 'apps', onViewChange, split = 'app', onSplitChange }) {
  const [expandedModels, setExpandedModels] = useState(() => ({}));
  const toggleModel = (model) =>
    setExpandedModels((prev) => ({ ...prev, [model]: !prev[model] }));
  if (!gateway) return null;

  // Offline (no reachable replica / auth failure): a single slim banner.
  if (!gateway.online) {
    const msg = gateway.authError || gateway.error;
    if (!msg) return null;
    const isAuth = Boolean(gateway.authError);
    return (
      <div
        className={cn(
          'mb-4 rounded-md border px-3 py-2 text-xs flex items-start gap-2',
          isAuth ? 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-300' : 'border-red-200 bg-red-50 text-red-700 dark:border-red-500/40 dark:bg-red-950/40 dark:text-red-300'
        )}
      >
        <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
        <span>
          <span className="font-semibold">LiteLLM gateway: </span>
          {msg}
        </span>
      </div>
    );
  }

  const tiles = [
    { label: 'In-flight', tip: 'Requests currently being processed by the gateway across all replicas.', value: gateway.inFlightRequests, num: true },
    { label: 'Queued', tip: 'Requests held in the gateway admission queue, waiting to be forwarded to a backend. Consistently > 0 means backends can\'t keep up.', value: gateway.admissionQueued, num: true, warn: (gateway.admissionQueued ?? 0) > 0 },
    { label: '503 rejections', tip: 'Requests rejected with HTTP 503 by the gateway admission control (rate/limit exceeded).', value: gateway.admissionRejected, num: true, warn: (gateway.admissionRejected ?? 0) > 0 },
    { label: 'Error rate', tip: 'Share of total requests that failed, across all models.', value: gateway.errorRatePct !== null && gateway.errorRatePct !== undefined ? `${gateway.errorRatePct.toFixed(1)}%` : 'n/a', warn: (gateway.errorRatePct ?? 0) >= 5 },
    { label: 'E2E p95', tip: '95th-percentile end-to-end request latency (model inference + gateway). Worst case across replicas.', value: gateway.e2eP95Seconds != null ? `${gateway.e2eP95Seconds.toFixed(2)}s` : 'n/a' },
    { label: 'Overhead p95', tip: '95th-percentile time the gateway itself spent processing a request (routing/auth/billing), excluding model inference. High values point at the gateway, not the model.', value: gateway.overheadP95Seconds != null ? `${gateway.overheadP95Seconds.toFixed(3)}s` : 'n/a' },
    { label: 'Requests/s', tip: 'Gateway-wide request rate, derived from counter diffs between probes.', value: gateway.requestsPerSec != null ? gateway.requestsPerSec.toFixed(1) : 'n/a' },
  ];

  const hasBreakdown =
    (gateway.apps || []).length > 0 ||
    (gateway.apiKeys || []).length > 0 ||
    (gateway.teams || []).length > 0 ||
    (gateway.models || []).length > 0;

  const dim = splitDimFor(split);
  const topRows = gateway[dim.top] || [];
  const colLabel = dim.label;

  return (
    <div className="mb-4 rounded-md border border-purple-500/30 bg-purple-500/10 p-3">
      <div className="mb-2 flex items-center gap-2">
        <Server className="h-4 w-4 text-purple-600" />
        <span className="text-sm font-semibold text-purple-800">LiteLLM Gateway</span>
        <Badge variant="outline" className="text-[10px]">{gateway.pods} replica{gateway.pods === 1 ? '' : 's'}</Badge>
        {gateway.spend != null && (
          <Badge variant="secondary" className="text-[10px]" title="Cumulative spend attributed by the gateway (USD)">
            ${gateway.spend.toFixed(2)}
          </Badge>
        )}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2 mb-3">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-md bg-muted/40 border border-purple-500/20 py-2 text-center">
            <p className="text-[11px] text-muted-foreground flex items-center justify-center gap-1">
              <span className="cursor-help border-b border-dotted border-muted-foreground/40" title={t.tip}>{t.label}</span>
            </p>
            <p className={cn('text-base font-bold font-mono', t.warn && 'text-amber-600')}>{t.value ?? 0}</p>
          </div>
        ))}
      </div>

      {hasBreakdown && (
        <>
          <div className="mb-2 flex items-center gap-3">
            <div className="flex items-center gap-1">
              {(['apps', 'models']).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => onViewChange?.(v)}
                  className={cn(
                    'rounded px-2 py-0.5 text-[11px] font-medium capitalize transition-colors',
                    view === v
                      ? 'bg-purple-600 text-white'
                      : 'bg-muted/40 text-muted-foreground hover:bg-accent'
                  )}
                >
                  {v}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1">
              <span className="text-[11px] text-muted-foreground">Split by</span>
              {SPLIT_DIMS.map((d) => (
                <button
                  key={d.key}
                  type="button"
                  onClick={() => onSplitChange?.(d.key)}
                  className={cn(
                    'rounded px-2 py-0.5 text-[11px] font-medium transition-colors',
                    split === d.key
                      ? 'bg-purple-600 text-white'
                      : 'bg-muted/40 text-muted-foreground hover:bg-accent'
                  )}
                >
                  {d.label}
                </button>
              ))}
            </div>
          </div>

          {view === 'models' ? (
            (gateway.models || []).length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-muted-foreground border-b border-purple-500/30">
                      <th className="py-1 pr-1 w-4" aria-label="expand" />
                      <th className="py-1 pr-2">Model</th>
                      <th className="py-1 pr-2 text-right">Req/s</th>
                      <th className="py-1 pr-2 text-right">Req total</th>
                      <th className="py-1 pr-2 text-right" title="Failed requests as a share of total">Err %</th>
                      <th className="py-1 pr-2 text-right" title="p95 end-to-end latency (model + gateway)">E2E p95</th>
                      <th className="py-1 pr-2 text-right" title="p95 time to first token">TTFT p95</th>
                      <th className="py-1 pr-2 text-right">Tokens/s</th>
                      <th className="py-1 text-right" title="Cumulative spend (USD)">Spend</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {gateway.models.map((m) => {
                      const detailRows = m[dim.model] || [];
                      const expanded = Boolean(expandedModels[m.model]);
                      return (
                        <Fragment key={m.model}>
                          <tr
                            className="border-b border-purple-500/20 last:border-0 hover:bg-purple-500/10"
                          >
                            <td className="py-1 pr-1">
                              {detailRows.length > 0 ? (
                                <button
                                  type="button"
                                  onClick={() => toggleModel(m.model)}
                                  aria-label={expanded ? `Collapse per-${colLabel.toLowerCase()} breakdown` : `Expand per-${colLabel.toLowerCase()} breakdown`}
                                  className="inline-flex items-center justify-center rounded p-0.5 text-muted-foreground hover:text-purple-500 hover:bg-purple-500/10"
                                >
                                  {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                                </button>
                              ) : (
                                <span className="block w-3.5" />
                              )}
                            </td>
                            <td className="py-1 pr-2 font-sans font-medium">{m.model}</td>
                            <td className="py-1 pr-2 text-right">{m.requestsPerSec != null ? m.requestsPerSec.toFixed(2) : '—'}</td>
                            <td className="py-1 pr-2 text-right">{m.requestsTotal}</td>
                            <td className={cn('py-1 pr-2 text-right', (m.errorRatePct ?? 0) >= 5 && 'text-amber-600 font-semibold')}>
                              {m.errorRatePct != null ? `${m.errorRatePct.toFixed(1)}%` : '—'}
                            </td>
                            <td className="py-1 pr-2 text-right">{m.e2eP95Seconds != null ? `${m.e2eP95Seconds.toFixed(2)}s` : '—'}</td>
                            <td className="py-1 pr-2 text-right">{m.ttftP95Seconds != null ? `${m.ttftP95Seconds.toFixed(2)}s` : '—'}</td>
                            <td className="py-1 pr-2 text-right">{m.tokensPerSec != null ? m.tokensPerSec.toFixed(1) : '—'}</td>
                            <td className="py-1 text-right">{m.spend != null ? `$${m.spend.toFixed(2)}` : '—'}</td>
                          </tr>
                          {expanded && detailRows.length > 0 && (
                            <tr className="border-b border-purple-500/20 last:border-0 bg-purple-500/10">
                              <td />
                              <td colSpan={8} className="px-2 py-2">
                                <p className="mb-1 font-sans text-[11px] font-medium text-muted-foreground">
                                  {colLabel}s using {m.model}
                                </p>
                                <table className="w-full text-xs">
                                  <thead>
                                    <tr className="text-left text-muted-foreground border-b border-purple-500/30">
                                      <th className="py-0.5 pr-2" title={`Grouped by ${colLabel.toLowerCase()}`}>{colLabel}</th>
                                      <th className="py-0.5 pr-2 text-right" title="Cumulative total tokens">Tokens</th>
                                      <th className="py-0.5 pr-2 text-right" title="Cumulative input (prompt) tokens">In</th>
                                      <th className="py-0.5 pr-2 text-right" title="Cumulative output (completion) tokens">Out</th>
                                      <th className="py-0.5 text-right" title="Cumulative spend (USD)">Spend</th>
                                    </tr>
                                  </thead>
                                  <tbody className="font-mono">
                                    {detailRows.map((a) => (
                                      <tr key={a.name} className="border-b border-purple-500/20 last:border-0">
                                        <td className="py-0.5 pr-2 font-sans font-medium" title={a.name}>{a.name}</td>
                                        <td className="py-0.5 pr-2 text-right" title={String(a.tokensTotal ?? '')}>{formatTokens(a.tokensTotal)}</td>
                                        <td className="py-0.5 pr-2 text-right" title={String(a.tokensInput ?? '')}>{formatTokens(a.tokensInput)}</td>
                                        <td className="py-0.5 pr-2 text-right" title={String(a.tokensOutput ?? '')}>{formatTokens(a.tokensOutput)}</td>
                                        <td className="py-0.5 text-right">{a.spend != null ? `$${a.spend.toFixed(2)}` : '—'}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )
          ) : (
            topRows.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-muted-foreground border-b border-purple-500/30">
                      <th className="py-1 pr-2" title={`Grouped by ${colLabel.toLowerCase()}; values without one are grouped as (unattributed)`}>{colLabel}</th>
                      <th className="py-1 pr-2 text-right">Req total</th>
                      <th className="py-1 pr-2 text-right" title="Token throughput, derived from counter diffs">Tokens/s</th>
                      <th className="py-1 pr-2 text-right" title="Cumulative total tokens">Tokens</th>
                      <th className="py-1 pr-2 text-right" title="Cumulative input (prompt) tokens">In</th>
                      <th className="py-1 pr-2 text-right" title="Cumulative output (completion) tokens">Out</th>
                      <th className="py-1 text-right" title="Cumulative spend (USD)">Spend</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {topRows.map((a) => (
                      <tr key={a.name} className="border-b border-purple-500/20 last:border-0">
                        <td className="py-1 pr-2 font-sans font-medium" title={a.name}>{a.name}</td>
                        <td className="py-1 pr-2 text-right">{a.requestsTotal}</td>
                        <td className="py-1 pr-2 text-right">{a.tokensPerSec != null ? a.tokensPerSec.toFixed(1) : '—'}</td>
                        <td className="py-1 pr-2 text-right" title={String(a.tokensTotal ?? '')}>{formatTokens(a.tokensTotal)}</td>
                        <td className="py-1 pr-2 text-right" title={String(a.tokensInput ?? '')}>{formatTokens(a.tokensInput)}</td>
                        <td className="py-1 pr-2 text-right" title={String(a.tokensOutput ?? '')}>{formatTokens(a.tokensOutput)}</td>
                        <td className="py-1 text-right">{a.spend != null ? `$${a.spend.toFixed(2)}` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          )}
        </>
      )}

      {/* Per-day cost & token history, grouped by the selected Split-by dim. */}
      <GatewayCostHistory split={split} />
    </div>
  );
}

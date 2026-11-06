import React, { useState, useCallback, useMemo, Fragment } from 'react';
import axios from 'axios';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from './ui/card';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Progress } from './ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from './ui/accordion';
import { Alert, AlertTitle } from './ui/alert';
import { SkeletonRows } from './ui/skeleton';
import { EmptyState } from './ui/empty-state';
import { RefreshCw, Loader2, Server, Cpu, Clock, AlertTriangle, BarChart3, HelpCircle, History, ChevronDown, ChevronRight, Network, ArrowRight } from 'lucide-react';
import { Area, Bar, Line, ComposedChart, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { cn, shortGpuUuid, formatGPUMem } from '../lib/utils';
import Sparkline from './Sparkline';
import { getServingStatus } from '../lib/servingStatus';
import { findGpuNeighbours, neighbourPods } from '../lib/servingPlacement';
import { API_URL } from '../lib/api';
import { usePolling } from '../hooks/usePolling';
import { useUrlParam } from '../hooks/useUrlParam';

const SERVING_SORTS = ['throughput', 'requests', 'queue', 'name'];
const TREND_WINDOWS = ['1h', '6h', '24h', '7d'];

// MetricTip is a metric label with a hover tooltip explaining it in
// plain English (for end users unfamiliar with LLM serving metrics).
function MetricTip({ label, tip, children }) {
  return (
    <span className="inline-flex items-center gap-1" title={tip}>
      <span className="cursor-help border-b border-dotted border-muted-foreground/40">{label}</span>
      {children}
    </span>
  );
}

// --- Per-server health verdict ---
//
// Overload signals (waiting, KV cache %, preemptions) are objective and
// workload-independent, so they use absolute thresholds. "Slow" is
// workload-dependent (a 2s first token is fine for batch, bad for chat), so
// it's judged *relative to the other servers in the fleet*, with a loose
// TTFT fallback when no peer comparison is possible. The logic lives in
// lib/servingStatus.js (pure, unit-tested).

const STATUS_TONE_CLASSES = {
  green: 'bg-green-100 text-green-800 border-green-300 dark:bg-green-500/20 dark:text-green-300 dark:border-green-500/40',
  amber: 'bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-500/20 dark:text-amber-300 dark:border-amber-500/40',
  orange: 'bg-orange-100 text-orange-800 border-orange-300 dark:bg-orange-500/20 dark:text-orange-300 dark:border-orange-500/40',
  red: 'bg-red-100 text-red-800 border-red-300 dark:bg-red-500/20 dark:text-red-300 dark:border-red-500/40',
};

// --- Historical trends (sparklines + "last issue seen") ---
//
// The backend samples each serving pod's health on the cluster history
// interval (default 60s) into an in-memory ring buffer. /api/v1/serving/history
// returns per-pod series for the requested window plus the last time the pod
// was observed "unhealthy" (offline, queued requests, preemptions, or KV
// cache pressure). We pick the metrics that diagnose the failure modes the
// status badge cares about.
const TREND_DEFS = [
  { label: 'TTFT p95', key: 'ttft', get: (p) => p.ttftP95Seconds ?? p.ttftSeconds, stroke: '#f97316', fmt: (v) => `${v.toFixed(2)}s` },
  { label: 'E2E p95', key: 'e2e', get: (p) => p.e2eP95Seconds ?? p.e2eSeconds, stroke: '#3b82f6', fmt: (v) => `${v.toFixed(2)}s` },
  { label: 'KV cache %', key: 'kv', get: (p) => p.kvCachePercent, stroke: '#8b5cf6', fmt: (v) => `${v.toFixed(1)}%` },
  { label: 'Throughput', key: 'tok', get: (p) => p.tokensPerSec, stroke: '#22c55e', fmt: (v) => `${v.toFixed(1)} tok/s` },
  { label: 'Requests/s', key: 'req', get: (p) => p.requestsPerSec, stroke: '#eab308', fmt: (v) => `${v.toFixed(2)} req/s` },
];

// trendSeries maps raw history points to [{t, value}] for each trend that has
// at least one non-null value. Returns [] when there is nothing to chart.
function trendSeries(points) {
  if (!Array.isArray(points) || points.length === 0) return [];
  return TREND_DEFS.map((def) => {
    const series = points
      .filter((p) => def.get(p) !== null && def.get(p) !== undefined)
      .map((p) => ({ t: p.t, value: def.get(p) }));
    return series.length ? { ...def, points: series } : null;
  }).filter(Boolean);
}

// formatRelativeTime renders a Unix-seconds timestamp as "5m ago" / "3h ago".
function formatRelativeTime(unix) {
  if (!unix) return '';
  const secs = Math.max(0, Math.floor(Date.now() / 1000 - unix));
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// CopyableNode renders a node name; clicking copies it (for pasting into the
// CLI). `copyValue` optionally overrides what gets copied (e.g. display the
// hostname but copy the actual node name used by kubectl).
function CopyableNode({ name, copyValue }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    const value = copyValue || name;
    const done = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(done).catch(done);
    } else {
      const ta = document.createElement('textarea');
      ta.value = value;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      done();
    }
  };
  return (
    <button
      type="button"
      onClick={copy}
      title={`${copyValue || name} — click to copy`}
      className="inline-flex items-center gap-1 font-mono text-[11px] max-w-full cursor-pointer truncate text-left hover:underline"
    >
      <Server className="h-3 w-3 shrink-0 text-muted-foreground" />
      <span className="truncate">{copied ? 'Copied' : name}</span>
    </button>
  );
}

// ServingTrends renders per-card trend sparklines for the metrics that
// diagnose the failure modes the status badge cares about (latency, memory
// pressure, demand), plus a "last issue seen" marker. Collapsible so a card
// stays at-a-glance: by default it shows a compact summary line (current KV
// cache % + throughput + last issue) and the full 5 sparklines expand on
// click. Hidden when there are no historical samples yet. `history` is the
// per-pod entry from /api/v1/serving/history: { points: Point[], lastIssue: unix }.
function ServingTrends({ history }) {
  const [open, setOpen] = useState(false);
  const series = useMemo(() => trendSeries(history?.points), [history?.points]);
  const lastIssue = history?.lastIssue;

  // Compact "now" figures for the collapsed summary line, from the last
  // sample of the KV-cache and throughput series (both may be absent).
  const last = (key) => {
    const s = series.find((x) => x.key === key);
    return s ? s.points[s.points.length - 1].value : null;
  };
  const lastKV = last('kv');
  const lastTok = last('tok');

  if (series.length === 0 && !lastIssue) {
    return null;
  }

  return (
    <div className="rounded-md border bg-card/40">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full flex items-center gap-1.5 px-2 py-1.5 hover:bg-muted/40 text-left"
      >
        <History className="h-3 w-3 shrink-0 text-muted-foreground" />
        <span className="text-[11px] font-semibold text-muted-foreground">Trends</span>
        <span className="ml-auto flex items-center gap-1.5 min-w-0">
          {lastKV != null && (
            <span className="text-[10px] font-mono text-muted-foreground">
              KV {lastKV.toFixed(1)}%
            </span>
          )}
          {lastTok != null && (
            <span className="text-[10px] font-mono text-muted-foreground">
              {lastTok.toFixed(1)} tok/s
            </span>
          )}
          {lastIssue ? (
            <span className="text-[10px] text-amber-700 flex items-center gap-0.5" title="Last time this pod was offline, had queued requests, preemptions, or KV cache pressure.">
              <AlertTriangle className="h-3 w-3" />
              {formatRelativeTime(lastIssue)}
            </span>
          ) : (
            <span className="text-[10px] text-green-700" title="No offline/queue/preemption/KV-pressure events in the window.">
              ok
            </span>
          )}
          {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
        </span>
      </button>
      {open && (
        <div className="px-2 pb-2">
          {series.length > 0 && (
            <div className="space-y-2">
              {series.map((s) => (
                <div key={s.key}>
                  <div className="flex justify-between text-[10px] mb-0.5">
                    <span className="text-muted-foreground">{s.label}</span>
                    <span className="font-mono font-semibold">{s.fmt(s.points[s.points.length - 1].value)}</span>
                  </div>
                  <Sparkline points={s.points} stroke={s.stroke} height={28} formatValue={s.fmt} />
                </div>
              ))}
            </div>
          )}
          {lastIssue ? (
            <p className="mt-1.5 text-[10px] text-amber-700 flex items-center gap-1" title="Last time this pod was offline, had queued requests, preemptions, or KV cache pressure.">
              <AlertTriangle className="h-3 w-3" />
              Last issue seen {formatRelativeTime(lastIssue)}
            </p>
          ) : (
            <p className="mt-1.5 text-[10px] text-green-700 flex items-center gap-1" title="No offline/queue/preemption/KV-pressure events in the window.">
              No issues in the window
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ServingCard renders inference health for a single LLM serving pod.
// DiagnosisPanel puts the status verdict on the card instead of hiding it in
// a hover tooltip: what's wrong, why, the first thing to try, and a jump to
// the pod's GPU on the Topology tab.
const DIAGNOSIS_TONE_CLASSES = {
  amber: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200',
  orange: 'border-orange-300 bg-orange-50 text-orange-900 dark:border-orange-500/40 dark:bg-orange-500/10 dark:text-orange-200',
  red: 'border-red-300 bg-red-50 text-red-900 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-200',
};

function DiagnosisPanel({ status, onShowInTopology }) {
  if (status.tone === 'green') return null;
  const [firstFix, ...otherFixes] = status.fixes;
  return (
    <div className={cn('rounded-md border px-3 py-2 text-xs space-y-1.5', DIAGNOSIS_TONE_CLASSES[status.tone])}>
      <ul className="space-y-0.5">
        {status.reasons.map((r) => (
          <li key={r} className="flex gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-px" aria-hidden="true" />
            <span>{r}</span>
          </li>
        ))}
      </ul>
      {firstFix && (
        <p>
          <span className="font-semibold">Try first: </span>
          {firstFix}
        </p>
      )}
      {otherFixes.length > 0 && (
        <details>
          <summary className="cursor-pointer select-none opacity-80">
            {otherFixes.length} more thing{otherFixes.length > 1 ? 's' : ''} to try
          </summary>
          <ol className="mt-1 ml-4 list-decimal space-y-0.5" start={2}>
            {otherFixes.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ol>
        </details>
      )}
      {onShowInTopology && (
        <button
          type="button"
          onClick={onShowInTopology}
          className="inline-flex items-center gap-1 font-semibold underline-offset-2 hover:underline"
        >
          {status.neighbours ? 'See who shares this GPU' : 'Show placement in topology'}
          <ArrowRight className="h-3 w-3" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

function ServingCard({ pod, peers, history, placement, onOpenTopology }) {
  const kv = pod.kvCachePercent;
  const status = useMemo(
    () => getServingStatus(pod, peers || [pod], placement),
    [pod, peers, placement],
  );
  const neighbourCount = useMemo(() => neighbourPods(placement).length, [placement]);
  const showInTopology =
    pod.node && onOpenTopology
      ? () =>
          onOpenTopology({
            node: pod.node,
            pod: `${pod.namespace}/${pod.name}`,
            gpu: placement?.shared?.[0]?.gpu?.key || (pod.gpuDevices?.[0]?.uuid ?? ''),
          })
      : null;
  // Multi-line tooltip: what triggered it, what the state means, and what to do.
  const statusTitle = useMemo(() => {
    const lines = [`${status.label} — ${status.meaning}`];
    if (status.reasons.length > 0) {
      lines.push(`Because: ${status.reasons.join(' · ')}`);
    }
    if (status.fixes.length > 0) {
      lines.push('To fix:');
      status.fixes.forEach((f, i) => lines.push(`  ${i + 1}. ${f}`));
    } else {
      lines.push('Nothing to do — keep an eye on it if load grows.');
    }
    return lines.join('\n');
  }, [status]);

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
            {(pod.node || (pod.gpuDevices && pod.gpuDevices.length > 0)) && (
              <div className="mt-1 flex items-center gap-1.5 min-w-0">
                {pod.node && (
                  <div className="min-w-0 flex-1">
                    {/* Prefer the node's kubernetes.io/hostname (e.g. "empathy1")
                        over the raw node name (e.g. "k3s" on a k3s node).
                        Clicking still copies the real node name for kubectl. */}
                    <CopyableNode name={pod.nodeHostname || pod.node} copyValue={pod.node} />
                  </div>
                )}
                {showInTopology && (
                  <button
                    type="button"
                    onClick={showInTopology}
                    className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-muted"
                    title="Show this pod's node and GPU in Topology"
                    aria-label="Show in topology"
                  >
                    <Network className="h-3.5 w-3.5" />
                  </button>
                )}
                {pod.nodeInstanceType && (
                  <Badge variant="secondary" className="font-mono text-[10px] shrink-0">
                    {pod.nodeInstanceType}
                  </Badge>
                )}
                {pod.gpuModel && (
                  <Badge variant="outline" className="text-[10px] border-purple-500 text-purple-700 shrink-0">
                    {pod.gpuModel}{pod.gpuCapacity ? ` x${pod.gpuCapacity}` : ''}
                  </Badge>
                )}
                {(pod.gpuDevices || []).map((d) => {
                  const label = shortGpuUuid(d.uuid) || `GPU ${d.index}`;
                  const mem = d.memoryMiB > 0 ? ` · ${formatGPUMem(d.memoryMiB)}` : '';
                  return (
                    <Badge
                      key={`gpu-${d.uuid || d.index}`}
                      variant="outline"
                      className="text-[10px] font-mono border-indigo-500 text-indigo-700 shrink-0"
                      title={d.uuid || undefined}
                    >
                      {label}{mem}
                    </Badge>
                  );
                })}
              </div>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <Badge variant="outline" className="text-[10px]">{pod.backend}</Badge>
            <Badge variant={pod.online ? 'default' : 'destructive'} className="text-[10px]">
              {pod.online ? 'online' : 'offline'}
            </Badge>
            {pod.online && (
              <Badge
                variant="outline"
                className={cn('text-[10px] font-semibold', STATUS_TONE_CLASSES[status.tone])}
                title={statusTitle}
              >
                {status.label}
              </Badge>
            )}
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
            <DiagnosisPanel status={status} onShowInTopology={showInTopology} />
            {status.tone === 'green' && neighbourCount > 0 && (
              <button
                type="button"
                onClick={showInTopology || undefined}
                className="inline-flex items-center gap-1 rounded-md border border-indigo-300 px-2 py-0.5 text-[11px] text-indigo-700 hover:bg-indigo-50 dark:border-indigo-500/40 dark:text-indigo-300 dark:hover:bg-indigo-500/10"
                title="Sharing a GPU is fine while this server is healthy; it is the first suspect if it slows down."
              >
                Shares {placement.shared.map((s) => s.gpu.label).join(', ')} with {neighbourCount} pod{neighbourCount > 1 ? 's' : ''}
                {showInTopology && <ArrowRight className="h-3 w-3" aria-hidden="true" />}
              </button>
            )}
            {/* KV cache usage */}
            {kv !== undefined && kv !== null ? (
              <div>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-muted-foreground">
                    <MetricTip label="KV cache" tip="How full the server's working memory (GPU VRAM) is for active requests. Near 100% means new requests must wait and long ones may be preempted." />
                  </span>
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
                  <MetricTip label="Running" tip="Requests currently being processed by the server."><Cpu className="h-3 w-3" /></MetricTip>
                </p>
                <p className="text-lg font-bold">{pod.running ?? 0}</p>
              </div>
              <div className="rounded-md bg-card/60 py-2">
                <p className="text-xs text-muted-foreground">
                  <MetricTip label="Waiting" tip="Requests queued, waiting for a free slot. Consistently > 0 means the server is overloaded." />
                </p>
                <p className={cn("text-lg font-bold", (pod.waiting ?? 0) > 0 && "text-yellow-600")}>
                  {pod.waiting ?? 0}
                </p>
              </div>
              <div className="rounded-md bg-card/60 py-2">
                <p className="text-xs text-muted-foreground flex items-center justify-center gap-1">
                  <MetricTip label="Preempt" tip="Requests evicted from memory and re-run because the KV cache ran out. Rising preemptions = the server is under memory pressure."><Clock className="h-3 w-3" /></MetricTip>
                </p>
                <p className="text-lg font-bold">{pod.preemptions ?? 0}</p>
              </div>
            </div>

            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
              {pod.ttftSeconds !== undefined && pod.ttftSeconds !== null && (
                <span className="text-muted-foreground">
                  <MetricTip label="TTFT" tip="Time to first token — how long until the first word appears. What a user feels when a response starts streaming; high TTFT feels slow even if the rest is fast.">
                    <span className="font-mono text-foreground">{pod.ttftSeconds.toFixed(3)}s</span>
                    {pod.ttftP95Seconds !== undefined && pod.ttftP95Seconds !== null && (
                      <span className="ml-1">
                        (p95 {pod.ttftP95Seconds.toFixed(3)}s)
                      </span>
                    )}
                  </MetricTip>
                </span>
              )}
              {pod.e2eSeconds !== undefined && pod.e2eSeconds !== null && (
                <span className="text-muted-foreground">
                  <MetricTip label="E2E" tip="End-to-end latency — total time for the whole response to finish. What a non-streaming caller actually waits for; high with low TTFT means long outputs or a busy server.">
                    <span className="font-mono text-foreground">{pod.e2eSeconds.toFixed(2)}s</span>
                    {pod.e2eP95Seconds !== undefined && pod.e2eP95Seconds !== null && (
                      <span className="ml-1">
                        (p95 {pod.e2eP95Seconds.toFixed(2)}s)
                      </span>
                    )}
                  </MetricTip>
                </span>
              )}
              {pod.tokensPerSec !== undefined && pod.tokensPerSec !== null && (
                <span className="text-muted-foreground">
                  <MetricTip label="Throughput" tip="Tokens generated per second across all requests — how much work this server is doing. Drives the 'Model usage' ranking.">
                    <span className="font-mono text-foreground">{pod.tokensPerSec.toFixed(1)} tok/s</span>
                  </MetricTip>
                </span>
              )}
              {pod.requestsPerSec !== undefined && pod.requestsPerSec !== null && (
                <span className="text-muted-foreground">
                  <MetricTip label="Load" tip="Requests per second served. The most direct 'how used is this model' number (throughput conflates request size with usage).">
                    <span className="font-mono text-foreground">{pod.requestsPerSec.toFixed(2)} req/s</span>
                  </MetricTip>
                </span>
              )}
            </div>

            <ServingTrends history={history} />
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
                  'w-20 text-right text-[10px] shrink-0 font-mono',
                  (pod.waiting || 0) > 0 ? 'text-yellow-600 font-semibold' : 'text-muted-foreground',
                )}
                title={`running: ${pod.running ?? 0}, waiting: ${pod.waiting ?? 0}`}
              >
                {queue} in-flight
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// MetricExplainer is a default-collapsed accordion that explains, in plain
// English, what the serving metrics mean and what to do when they look bad.
// Targeted at end users who may not know what TTFT or E2E latency are.
const METRIC_EXPLAINERS = [
  {
    term: 'Status badge (OK / Busy / Slow / Under pressure)',
    what: 'A one-glance verdict computed from all the metrics on the card. Hover the badge for the specific reasons and what to do about them.',
    why: [
      'Under pressure (red) — the GPU memory for active requests is nearly full; work is being interrupted and re-run. Fix: add GPU capacity, give vLLM more KV cache (raise --gpu-memory-utilization or lower --max-num-seqs / --max-model-len), or take load off this server.',
      'Busy (amber) — more requests are arriving than this server can handle, so they queue and users wait. Fix: add replicas of the model, raise concurrency (--max-num-seqs) if memory allows, or find the bursty/long-context traffic.',
      'Slow (orange) — this server is far slower than the others running the same model. Fix: check placement (slow or contended node, GPU sharing), compare request mix, or reschedule the pod.',
      'OK (green) — nothing detected: no queue, no preemptions, memory headroom, latency in line with peers.',
    ].join(' '),
  },
  {
    term: 'TTFT (Time To First Token)',
    what: 'How long until the first word of the response appears.',
    why: 'What a user feels the moment they ask a question. A high TTFT feels slow even if the rest of the answer streams quickly. p95 shows the worst-case 5% of requests.',
  },
  {
    term: 'E2E latency (End-to-End)',
    what: 'The total time until the entire response is finished.',
    why: 'What a non-streaming caller actually waits for. High E2E with a low TTFT usually means long answers or a busy server; high with a high TTFT points at queuing.',
  },
  {
    term: 'KV cache %',
    what: 'How full the GPU working memory is for in-flight requests.',
    why: 'Near 100% the server can\'t accept much more work: new requests wait and long ones may be preempted. A consistently full cache means the model is at capacity.',
  },
  {
    term: 'Running / Waiting',
    what: 'Requests currently being processed vs. queued for a slot.',
    why: 'Waiting > 0 for a sustained period means the server is overloaded — consider adding replicas or raising the max-num-seqs limit.',
  },
  {
    term: 'Preemptions',
    what: 'Requests kicked out of memory and re-run because the KV cache ran out.',
    why: 'A counter that should stay near 0. A rising number means the model is under memory pressure and is silently re-doing work, which adds latency.',
  },
  {
    term: 'Throughput & Load',
    what: 'Tokens per second generated (Throughput) and requests per second served (Load).',
    why: 'These are the "most used" signals that drive the ranking chart. Load is the cleaner measure of demand; Throughput also reflects how long the answers are.',
  },
  {
    term: 'Trends (sparklines + last issue seen)',
    what: 'Each card shows a small history of TTFT p95, E2E p95, KV cache %, throughput and requests/s over a selectable window (1h/6h/24h), plus when the last issue was detected.',
    why: 'Current metrics are a single snapshot. Trends reveal how a model behaved at a specific time (e.g. was it slow or under pressure an hour ago?) and let you correlate an incident with a change. "Last issue seen" marks the last moment the pod was offline, had queued requests, preemptions, or KV cache near capacity. Data is sampled every 60s and kept in memory only — it resets when the app restarts, and starts filling from the first sample after launch.',
  },
];

function MetricExplainer() {
  return (
    <Accordion type="single" collapsible className="mb-4 rounded-md border bg-card/40 px-3">
      <AccordionItem value="explain">
        <AccordionTrigger className="text-sm">
          <span className="flex items-center gap-1.5">
            <HelpCircle className="h-3.5 w-3.5" />
            What do these metrics mean?
          </span>
        </AccordionTrigger>
        <AccordionContent>
          <div className="space-y-3 text-xs">
            {METRIC_EXPLAINERS.map((m) => (
              <div key={m.term}>
                <p className="font-semibold">{m.term}</p>
                <p className="text-muted-foreground">{m.what}</p>
                <p className="text-muted-foreground italic">{m.why}</p>
              </div>
            ))}
          </div>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}

// formatTokens renders a token count compactly (e.g. 12345 -> "12.3k") so the
// per-app table stays readable when callers consume millions of tokens.
function formatTokens(n) {
  if (n == null) return '—';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}

// GatewayCard renders aggregated LiteLLM AI-gateway health: a row of stat
// tiles (in-flight, admission queue, 503 rejections, error rate, E2E p95,
// gateway overhead p95, requests/s) and a breakdown table. The breakdown can be
// grouped by App / API key / Team and shown per-model or per-app. When the
// gateway's /metrics requires auth it shows an actionable 401 hint instead of
// the numbers.
// splitDimMaps: UI key -> { top: GatewayHealth field, model: ModelStat field, label }
const SPLIT_DIMS = [
  { key: 'app', top: 'apps', model: 'apps', label: 'App' },
  { key: 'apikey', top: 'apiKeys', model: 'apiKeys', label: 'API key' },
  { key: 'team', top: 'teams', model: 'teams', label: 'Team' },
];
const splitDimFor = (key) => SPLIT_DIMS.find((d) => d.key === key) || SPLIT_DIMS[0];

function GatewayCard({ gateway, view = 'apps', onViewChange, split = 'app', onSplitChange }) {
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

// GATEWAY_HIST_COLORS is a minimal monochrome violet ramp for the daily
// usage chart: one hue, ranked by usage across the window (index 0 =
// biggest consumer = darkest). Keeping a single hue keeps the chart calm no
// matter how many split values exist, and lets bar shade encode dominance
// without a legend.
const GATEWAY_HIST_COLORS = [
  '#4c1d95', '#6d28d9', '#7c3aed', '#8b5cf6', '#9f67f7',
  '#a78bfa', '#b4a0fb', '#c4b5fd', '#d4c6fe', '#e3dcff',
];

// Clamp a 0..1 t onto the violet ramp.
function rampColor(t) {
  const c = GATEWAY_HIST_COLORS;
  const x = Math.min(0.9999, Math.max(0, t)) * (c.length - 1);
  const i = Math.floor(x);
  return c[i];
}

// Custom tooltip for the per-day usage chart: a card with the day header, the
// hovered split value's contribution (value, % of day, % of window) and the
// day total. Richer than the default tooltip without adding visual noise.
function GatewayHistoryTooltip({ active, payload, label, focus, colorOf, fmtValue, windowSum }) {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0].payload;
  if (!row) return null;
  const isToday = label === new Date().toISOString().slice(0, 10);
  // Rows in the payload are in reverse render order; surface the focused
  // series first, then the rest by size.
  const items = payload
    .filter((p) => p.value > 0)
    .sort((a, b) => (b.value - a.value) || (a.dataKey < b.dataKey ? -1 : 1));
  const first = focus || items[0];
  const share = first && row.total > 0 ? (first.value / row.total) * 100 : null;
  const windowShare = first && windowSum > 0 ? (first.value / windowSum) * 100 : null;
  return (
    <div className="rounded-lg border border-purple-500/30 bg-card px-3 py-2 text-[11px] shadow-lg backdrop-blur">
      <div className="mb-1 flex items-baseline gap-2 font-semibold text-foreground">
        <span className="font-mono">{label}</span>
        {isToday && (
          <span className="rounded bg-purple-100 px-1 text-[10px] font-medium text-purple-700 dark:bg-purple-500/25 dark:text-purple-300">today, so far</span>
        )}
      </div>
      {first && first.value > 0 && (
        <div className="mb-1 flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: colorOf(first.dataKey) }} />
          <span className="max-w-[160px] truncate font-medium" style={{ color: colorOf(first.dataKey) }}>{first.dataKey}</span>
          <span className="ml-auto font-mono font-semibold text-foreground">{fmtValue(first.value)}</span>
        </div>
      )}
      {share != null && (
        <div className="mb-1 font-mono text-[10px] text-muted-foreground">
          {share.toFixed(1)}% of day{windowShare != null && windowShare > 0 ? ` · ${windowShare.toFixed(1)}% of window` : ''}
        </div>
      )}
      <div className="flex items-center justify-between border-t border-purple-500/20 pt-1 text-[10px] text-muted-foreground">
        <span>day total</span>
        <span className="font-mono font-medium text-foreground/80">{fmtValue(row.total)}</span>
      </div>
    </div>
  );
}

// GatewayCostHistory renders the LiteLLM gateway's per-day spend and token
// usage (UTC days, 00:00–23:59) as a historical dashboard: a stacked bar chart
// (one bar per day, split by the active Split-by dimension) with an optional
// fleet-total line, plus a per-day table (day / spend / tokens / top consumer).
// It is self-contained: it fetches
// /api/v1/serving/gateway/history?split=...&window=... and refreshes every
// 60s (the backend samples the gateway's cumulative counters on the 60s
// interval and folds deltas into per-day totals in its store, so closed days
// are read only from the store and today updates live).
function GatewayCostHistory({ split = 'app' }) {
  const [windowDays, setWindowDays] = useState('14');
  const [metric, setMetric] = useState('spend'); // 'spend' | 'tokens'
  const [showTotal, setShowTotal] = useState(true);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [focus, setFocus] = useState(null); // series hovered (chart bar or legend)
  const [pinned, setPinned] = useState(null); // series click-pinned in the legend

  const fetchHistory = useCallback(async () => {
    try {
      const res = await axios.get(`${API_URL}/api/v1/serving/gateway/history`, {
        params: { split, window: `${windowDays}d` },
      });
      setData(res.data);
      setError(null);
    } catch (err) {
      // Non-fatal: the history is an enhancement, never block the card.
      setData(null);
      setError(err.response?.data?.error || err.message || 'Failed to load cost history');
    }
  }, [split, windowDays]);

  usePolling(fetchHistory, 60000);

  // Per-day rollup: one row per UTC day (00:00–23:59). `cell` holds both
  // spend and tokens per split value (so the table can show both columns while
  // the chart shows the selected metric). `names` is the union of values
  // across ALL days in the window, so a value may be absent from any given
  // day's cell — every cell access is guarded. The fleet total is value ""
  // (label "Fleet") and only present for split=total.
  const byDay = useMemo(() => {
    try {
      if (!data || !Array.isArray(data.days)) return { rows: [], names: [] };
      const perDay = {};
      const byVal = {};
      data.days.forEach((d) => {
        const v = d.value || 'Fleet';
        if (!perDay[d.day]) perDay[d.day] = {};
        if (!perDay[d.day][v]) perDay[d.day][v] = { spend: 0, tokens: 0 };
        perDay[d.day][v].spend += d.spend;
        perDay[d.day][v].tokens += d.tokens;
        byVal[v] = true;
      });
      const names = Object.keys(byVal).sort();
      const hasSplitValues = names.some((n) => n !== 'Fleet');
      const rows = Object.keys(perDay).sort().map((day) => {
        const cell = perDay[day];
        let top = '—';
        if (hasSplitValues && names.filter((n) => n !== 'Fleet').length > 1) {
          // Only values that actually have activity on THIS day are candidates.
          top =
            names
              .filter((n) => n !== 'Fleet')
              .filter((n) => cell[n])
              .sort((a, b) => cell[b][metric] - cell[a][metric])[0] || '—';
        }
        const row = { day, top, today: day === new Date().toISOString().slice(0, 10) };
        let sumSpend = 0;
        let sumTokens = 0;
        let sumMetric = 0;
        names.forEach((n) => {
          const c = cell[n];
          row[n] = c ? c[metric] : 0;
          if (n !== 'Fleet' && c) {
            sumSpend += c.spend;
            sumTokens += c.tokens;
            sumMetric += row[n];
          }
        });
        const fleet = cell['Fleet'];
        row.spend = hasSplitValues ? sumSpend : fleet ? fleet.spend : 0;
        row.tokens = hasSplitValues ? sumTokens : fleet ? fleet.tokens : 0;
        row.total = hasSplitValues ? sumMetric : fleet ? fleet[metric] : 0;
        return row;
      });
      return { rows, names };
    } catch (e) {
      // A malformed history payload must degrade to "no chart", never crash
      // the whole Serving tab.
      console.error('gateway cost history: failed to build per-day rollup', e);
      return { rows: [], names: [] };
    }
  }, [data, metric]);

  const fmtValue = (v) =>
    metric === 'spend' ? `$${v != null ? v.toFixed(2) : '0'}` : formatTokens(v);
  const fmtAxis = (v) =>
    metric === 'spend' ? (v >= 100 ? `$${Math.round(v)}` : `$${v.toFixed(0)}`) : formatTokens(v);

  const colLabel = (SPLIT_DIMS.find((d) => d.key === split) || SPLIT_DIMS[0]).label;
  const stackSeries = byDay.names;
  const hasData = byDay.rows.length > 0;

  // Series are colored on a single-hue ramp ranked by their window total
  // (biggest consumer = darkest). The ranking is computed per active metric
  // so the shading always matches what the bars show.
  const seriesStats = useMemo(() => {
    const per = {};
    byDay.rows.forEach((r) => {
      byDay.names.forEach((n) => {
        const c = (per[n] || (per[n] = { sum: 0, days: 0 }));
        const v = r[n];
        if (v) {
          c.sum += v;
          c.days += 1;
        }
      });
    });
    const totals = byDay.names.map((n) => per[n] ? per[n].sum : 0);
    const max = Math.max(1, ...totals);
    const order = byDay.names
      .slice()
      .sort((a, b) => (per[b] ? per[b].sum : 0) - (per[a] ? per[a].sum : 0));
    return { per, max, order, total: totals.reduce((a, b) => a + b, 0) };
  }, [byDay]);

  const colorOf = (n) => {
    const rank = seriesStats.order.indexOf(n);
    if (rank < 0) return GATEWAY_HIST_COLORS[0];
    return rampColor(rank / Math.max(1, seriesStats.order.length - 1));
  };

  // Active highlight series: hover wins, pinned series is the fallback.
  const focusSeries = focus || pinned;
  const dimOthers = Boolean(focusSeries);

  // Window-level stats for the highlighted series (stat strip + tooltip).
  const focusStats = useMemo(() => {
    if (!focusSeries) return null;
    const per = seriesStats.per[focusSeries];
    if (!per || per.sum <= 0) return null;
    const days = byDay.rows.length || 1;
    let today = 0;
    const last = byDay.rows[byDay.rows.length - 1];
    if (last) today = last[focusSeries] || 0;
    return {
      sum: per.sum,
      days: per.days,
      avg: per.sum / Math.max(1, per.days),
      share: seriesStats.total > 0 ? (per.sum / seriesStats.total) * 100 : 0,
      todayDelta: today - per.sum / days,
    };
  }, [focusSeries, byDay, seriesStats]);

  return (
    <div className="mt-3 rounded-md border border-purple-500/20 bg-card p-2">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold text-purple-700">
          Usage by day <span className="font-normal text-muted-foreground">(UTC, 00:00–23:59)</span>
        </span>
        <div className="ml-auto flex items-center gap-1">
          {(['spend', 'tokens'].map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMetric(m)}
              className={cn(
                'rounded px-2 py-0.5 text-[11px] font-medium capitalize transition-colors',
                metric === m ? 'bg-purple-600 text-white' : 'bg-muted/40 text-muted-foreground hover:bg-accent'
              )}
            >
              {m}
            </button>
          )))}
          <button
            type="button"
            onClick={() => setShowTotal((s) => !s)}
            className={cn(
              'rounded px-2 py-0.5 text-[11px] font-medium transition-colors',
              showTotal ? 'bg-purple-600 text-white' : 'bg-muted/40 text-muted-foreground hover:bg-accent'
            )}
            title="Overlay the daily total as a line"
          >
            Total
          </button>
          <select
            value={windowDays}
            onChange={(e) => setWindowDays(e.target.value)}
            className="rounded border border-purple-500/30 bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground"
            title="History window"
          >
            {['7', '14', '30'].map((w) => (
              <option key={w} value={w}>{w}d</option>
            ))}
          </select>
        </div>
      </div>

      {error && (
        <p className="text-[11px] text-amber-600">history unavailable: {error}</p>
      )}

      {hasData ? (
        <>
          <div className="h-[180px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                data={byDay.rows}
                margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
              >
                <XAxis
                  dataKey="day"
                  tick={{ fontSize: 10 }}
                  tickFormatter={(d) => d.slice(5)} // MM-DD
                  stroke="#a78bfa"
                />
                <YAxis tick={{ fontSize: 10 }} tickFormatter={fmtAxis} width={56} stroke="#a78bfa" />
                <Tooltip
                  content={<GatewayHistoryTooltip
                    focus={focusSeries}
                    colorOf={colorOf}
                    fmtValue={fmtValue}
                    windowSum={seriesStats.total}
                  />}
                  cursor={{ fill: 'rgba(124,58,237,0.06)' }}
                />
                <defs>
                  {focusSeries && (
                    <linearGradient id="gwFocusFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={colorOf(focusSeries)} stopOpacity={0.35} />
                      <stop offset="100%" stopColor={colorOf(focusSeries)} stopOpacity={0.02} />
                    </linearGradient>
                  )}
                </defs>
                {stackSeries.map((n) => (
                  <Bar
                    key={n}
                    dataKey={n}
                    name={n}
                    stackId="day"
                    fill={colorOf(n)}
                    fillOpacity={dimOthers && n !== focusSeries ? 0.18 : 1}
                    isAnimationActive={false}
                    mouseEnter={() => setFocus(n)}
                    mouseLeave={() => setFocus(null)}
                  />
                ))}
                {/* Evolution curve for the highlighted series (all days). */}
                {focusSeries && (
                  <>
                    <Area
                      type="monotone"
                      dataKey={focusSeries}
                      stroke="none"
                      fill="url(#gwFocusFill)"
                      isAnimationActive={false}
                      legendType="none"
                      activeDot={false}
                    />
                    <Line
                      type="monotone"
                      dataKey={focusSeries}
                      name={`${focusSeries} trend`}
                      stroke={colorOf(focusSeries)}
                      strokeWidth={2}
                      dot={{ r: 2.5, strokeWidth: 0, fill: colorOf(focusSeries) }}
                      activeDot={{ r: 4 }}
                      isAnimationActive={false}
                      legendType="none"
                    />
                  </>
                )}
                {showTotal && (
                  <Line
                    type="monotone"
                    dataKey="total"
                    name="Total"
                    stroke="#1f2937"
                    strokeWidth={1.5}
                    dot={false}
                    isAnimationActive={false}
                  />
                )}
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          {/* Pill legend: click to pin, hover to preview; shade = usage rank. */}
          {stackSeries.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {stackSeries.map((n) => {
                const st = seriesStats.per[n];
                const share = st && seriesStats.total > 0 ? (st.sum / seriesStats.total) * 100 : 0;
                const active = focusSeries === n;
                return (
                  <button
                    key={n}
                    type="button"
                    onMouseEnter={() => setFocus(n)}
                    onMouseLeave={() => setFocus(null)}
                    onClick={() => {
                      setFocus(null);
                      setPinned((prev) => (prev === n ? null : n));
                    }}
                    title={`${n} — ${fmtValue(st ? st.sum : 0)} over the window${pinned === n ? ' (pinned — click to release)' : ' (click to pin)'}`}
                    className={cn(
                      'flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium transition-all',
                      active
                        ? 'border-transparent shadow-sm ring-2 ring-purple-300'
                        : 'border-purple-500/20 bg-muted/40 hover:border-purple-500/50 hover:bg-accent',
                      dimOthers && !active && 'opacity-50'
                    )}
                    style={active ? { backgroundColor: colorOf(n) + '14' } : undefined}
                  >
                    <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: colorOf(n) }} />
                    <span className={active ? 'text-foreground' : 'text-muted-foreground'}>{n}</span>
                    <span className="font-mono text-[9px] text-muted-foreground">{share.toFixed(0)}%</span>
                    {pinned === n && (
                      <span className="text-[9px] font-semibold text-purple-600">●</span>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {/* Live stat strip for the highlighted series. */}
          {focusSeries && focusStats && (
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-0.5 rounded-md border border-purple-500/20 bg-purple-500/10 px-2.5 py-1.5 text-[11px]">
              <span className="flex items-center gap-1.5 font-semibold" style={{ color: colorOf(focusSeries) }}>
                <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: colorOf(focusSeries) }} />
                {focusSeries}
              </span>
              <span className="text-muted-foreground">
                <span className="font-mono font-semibold text-foreground">{fmtValue(focusStats.sum)}</span> over the window
              </span>
              <span className="text-muted-foreground">
                <span className="font-mono font-semibold text-foreground">{focusStats.share.toFixed(1)}%</span> share
              </span>
              <span className="text-muted-foreground">
                <span className="font-mono font-semibold text-foreground">{fmtValue(focusStats.avg)}/day</span> avg
              </span>
              <span className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground">
                <span
                  className={cn(
                    'font-mono font-semibold',
                    focusStats.todayDelta >= 0 ? 'text-emerald-600' : 'text-amber-600'
                  )}
                >
                  {focusStats.todayDelta >= 0 ? '▲' : '▼'} {fmtValue(Math.abs(focusStats.todayDelta))}
                </span>
                today vs avg
              </span>
            </div>
          )}
          {!focusSeries && (
            <p className="mt-1.5 text-[10px] text-muted-foreground/70">
              Hover or click a chip to follow one {colLabel.toLowerCase()} across all days
            </p>
          )}

          <div className="max-h-[160px] overflow-y-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted-foreground border-b border-purple-500/30">
                  <th className="py-1 pr-2">Day (UTC)</th>
                  <th className="py-1 pr-2 text-right">Spend</th>
                  <th className="py-1 pr-2 text-right">Tokens</th>
                  <th className="py-1 text-right">Top {colLabel}</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {byDay.rows.slice().reverse().map((r) => (
                  <tr key={r.day} className="border-b border-purple-500/20 last:border-0">
                    <td className="py-1 pr-2">
                      {r.day}
                      {r.today && (
                        <span className="ml-1 rounded bg-purple-500/15 px-1 text-[10px] text-purple-500">
                          today
                        </span>
                      )}
                    </td>
                    <td className="py-1 pr-2 text-right">${r.spend.toFixed(2)}</td>
                    <td className="py-1 pr-2 text-right" title={String(r.tokens)}>{formatTokens(r.tokens)}</td>
                    <td className="py-1 text-right font-sans" title={r.top === '—' ? `single ${colLabel.toLowerCase()} or no split data` : `Highest ${metric} on ${r.day}`}>{r.top}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <p className="py-6 text-center text-[11px] text-muted-foreground">
          {data && data.store === 'memory'
            ? 'no history yet — sampled every 60s; the in-memory store starts empty and resets on restart'
            : 'no history yet'}
        </p>
      )}
    </div>
  );
}

// ServingHealth lists LLM serving pods (vLLM/sglang) and their inference health.
function ServingHealth({ onOpenTopology }) {
  const [pods, setPods] = useState(null);
  const [topologyNodes, setTopologyNodes] = useState(null); // for GPU co-location
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [sortBy, setSortBy] = useUrlParam('sort', 'throughput', SERVING_SORTS);
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
              <SelectTrigger className="w-[130px]" title="Trend history window">
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
              <SelectTrigger className="w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
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
            <MetricExplainer />
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

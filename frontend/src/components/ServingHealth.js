import React, { useState, useEffect, useCallback, useMemo } from 'react';
import axios from 'axios';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from './ui/card';
import { Badge } from './ui/badge';
import { Progress } from './ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from './ui/accordion';
import { RefreshCw, Loader2, Server, Cpu, Clock, AlertTriangle, BarChart3, HelpCircle, History, ChevronDown, ChevronRight } from 'lucide-react';
import { cn, shortGpuUuid, formatGPUMem } from '../lib/utils';
import Sparkline from './Sparkline';

const API_URL = (window.ENV && window.ENV.hasOwnProperty('REACT_APP_API_URL'))
  ? window.ENV.REACT_APP_API_URL
  : (process.env.REACT_APP_API_URL || '');

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
// TTFT fallback when no peer comparison is possible.
const KV_PRESSURE_PCT = 85;
const SLOW_PEER_RATIO = 2; // my p95 E2E > 2x the fastest peer
const SLOW_PEER_FLOOR_SEC = 1; // ...and actually takes more than 1s
const SLOW_TTFT_FLOOR_SEC = 3; // no-peer fallback: first token > 3s

// getServingStatus derives { label, tone, reasons, meaning, fixes } for one
// serving pod. `peers` is the full pod list; only online pods are comparable.
// `meaning` is a plain-English "what does this state mean", and `fixes` is a
// short list of concrete things to try.
const STATUS_FIXES = {
  pressure: [
    'Add GPU capacity (more/bigger nodes for this model)',
    'Give vLLM more KV cache: raise --gpu-memory-utilization, or lower --max-num-seqs / --max-model-len',
    'Reduce the load this server takes (scale out replicas or cap queue depth)',
  ],
  busy: [
    'Add more replicas of this model',
    'Raise concurrency (--max-num-seqs) if GPU memory has headroom',
    'Check for unusually long inputs/outputs or bursty traffic',
  ],
  slow: [
    'Compare placement: this pod may sit on a slower or contended node (check GPU sharing / co-located pods)',
    'Check for long inputs/outputs on this server vs its peers',
    'If one server is a clear outlier, delete the pod to force a reschedule — a cheap first step',
  ],
  ok: [],
};

function getServingStatus(pod, peers) {
  if (!pod.online) {
    return {
      label: 'offline',
      tone: 'red',
      reasons: [pod.error || 'unreachable'],
      meaning: 'The server did not answer its /v1/models or /metrics endpoint.',
      fixes: ['Check the pod is running and the serving port is exposed', 'Verify the app can reach pod IPs (in-cluster network access)'],
    };
  }

  const reasons = [];
  let limited = false;
  let pressure = false;
  let busy = false;

  // Objective pressure signals
  if (pod.preemptions > 0) {
    pressure = true;
    reasons.push(`${pod.preemptions} preemption(s) — requests re-run due to KV cache pressure`);
  }
  if (pod.kvCachePercent != null) {
    if (pod.kvCachePercent >= KV_PRESSURE_PCT) {
      pressure = true;
      reasons.push(`KV cache ${pod.kvCachePercent.toFixed(0)}% — near memory capacity`);
    }
  }

  // Objective overload signal
  if (pod.waiting > 0) {
    busy = true;
    reasons.push(`${pod.waiting} request(s) queued`);
  }

  // Peer-relative "slow" signal (p95 E2E preferred, mean fallback). Peers are
  // the *other* servers serving the same model — comparing across models is
  // apples-to-oranges (a 7B and a 70B have very different latency profiles).
  const myE2E = pod.e2eP95Seconds ?? pod.e2eSeconds;
  if (myE2E != null && pod.model) {
    const me = `${pod.namespace}/${pod.name}`;
    const peerE2E = peers
      .filter((p) => p.online && p.model === pod.model && `${p.namespace}/${p.name}` !== me)
      .map((p) => p.e2eP95Seconds ?? p.e2eSeconds)
      .filter((v) => v != null);
    if (peerE2E.length > 0) {
      const best = Math.min(...peerE2E);
      if (myE2E > SLOW_PEER_RATIO * best && myE2E > SLOW_PEER_FLOOR_SEC) {
        reasons.push(
          `p95 E2E ${myE2E.toFixed(1)}s is >${SLOW_PEER_RATIO}x the fastest server (${best.toFixed(1)}s)`,
        );
      }
    } else if (pod.ttftP95Seconds != null && pod.ttftP95Seconds > SLOW_TTFT_FLOOR_SEC) {
      // No peers to compare against: loose absolute fallback on first token.
      reasons.push(`first token takes ${pod.ttftP95Seconds.toFixed(1)}s (p95) — high for interactive use`);
    }
  } else if (pod.ttftSeconds == null) {
    limited = true; // no latency data at all yet
  }

  if (pressure) {
    return {
      label: 'Under pressure',
      tone: 'red',
      reasons,
      limited,
      meaning: 'The GPU memory for in-flight requests is nearly full: requests are being re-run (preemptions) and new work will queue or be interrupted.',
      fixes: STATUS_FIXES.pressure,
    };
  }
  if (busy) {
    return {
      label: 'Busy',
      tone: 'amber',
      reasons,
      limited,
      meaning: 'More requests are arriving than this server can run right now — they are waiting in the queue, so users feel extra latency.',
      fixes: STATUS_FIXES.busy,
    };
  }
  if (reasons.length > 0) {
    return {
      label: 'Slow',
      tone: 'orange',
      reasons,
      limited,
      meaning: 'This server is responding much more slowly than the others serving the same model (or slower than expected when it runs alone).',
      fixes: STATUS_FIXES.slow,
    };
  }
  return {
    label: 'OK',
    tone: 'green',
    reasons: limited ? ['limited data (first sample)'] : [],
    limited,
    meaning: limited
      ? 'No problems detected yet, but only one sample has been collected — rates and latency compare against previous probes.'
      : 'No problems detected from the current metrics: no queue, no preemptions, headroom in GPU memory, and latency in line with its peers.',
    fixes: STATUS_FIXES.ok,
  };
}

const STATUS_TONE_CLASSES = {
  green: 'bg-green-100 text-green-800 border-green-300',
  amber: 'bg-amber-100 text-amber-800 border-amber-300',
  orange: 'bg-orange-100 text-orange-800 border-orange-300',
  red: 'bg-red-100 text-red-800 border-red-300',
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
  { label: 'KV cache %', key: 'kv', get: (p) => p.kvCachePercent, stroke: '#8b5cf6', fmt: (v) => `${v.toFixed(0)}%` },
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

// CopyableNode renders a node name; clicking copies it (for pasting into the CLI).
function CopyableNode({ name }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    const done = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(name).then(done).catch(done);
    } else {
      const ta = document.createElement('textarea');
      ta.value = name;
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
      title={`${name} — click to copy`}
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
              KV {lastKV.toFixed(0)}%
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
function ServingCard({ pod, peers, history }) {
  const kv = pod.kvCachePercent;
  const status = useMemo(() => getServingStatus(pod, peers || [pod]), [pod, peers]);
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
              <div className="mt-1 flex items-center gap-1.5 min-w-0 flex-wrap">
                {pod.node && <CopyableNode name={pod.node} />}
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

// ServingHealth lists LLM serving pods (vLLM/sglang) and their inference health.
function ServingHealth() {
  const [pods, setPods] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [sortBy, setSortBy] = useState('throughput');
  const [trendWindow, setTrendWindow] = useState('6h');
  const [servingHistory, setServingHistory] = useState({}); // key: ns/name -> {points, lastIssue}

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

  useEffect(() => {
    fetchServing();
    const interval = setInterval(fetchServing, 30000);
    return () => clearInterval(interval);
  }, [fetchServing]);

  // Trend history is sampled server-side on the 60s cluster interval, so a
  // slower refresh (60s) keeps sparklines current without hammering the API.
  useEffect(() => {
    fetchServingHistory();
    const interval = setInterval(fetchServingHistory, 60000);
    return () => clearInterval(interval);
  }, [fetchServingHistory]);

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
        ) : (
          <div className="space-y-4">
            <MetricExplainer />
            {pods === null ? (
              <div className="flex flex-col items-center justify-center py-8">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground mb-2" />
                <p className="text-sm text-muted-foreground">Probing LLM servers...</p>
              </div>
            ) : pods.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">
                No LLM serving pods detected (looking for vLLM/sglang images or commands).
              </p>
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

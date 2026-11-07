import React, { useState, useMemo } from 'react';
import { AlertTriangle, History, ChevronDown, ChevronRight } from 'lucide-react';
import Sparkline from '../Sparkline';
import { formatRelativeTime } from './shared';

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

// ServingTrends renders per-card trend sparklines for the metrics that
// diagnose the failure modes the status badge cares about (latency, memory
// pressure, demand), plus a "last issue seen" marker. Collapsible so a card
// stays at-a-glance: by default it shows a compact summary line (current KV
// cache % + throughput + last issue) and the full 5 sparklines expand on
// click. Hidden when there are no historical samples yet. `history` is the
// per-pod entry from /api/v1/serving/history: { points: Point[], lastIssue: unix }.
export function ServingTrends({ history }) {
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
          <p className="mt-1 text-[10px] text-muted-foreground">
            Sampled every 60s. An issue is offline, queued requests, preemptions or KV cache at 85%+.
            History is kept in memory unless durable serving history is configured.
          </p>
        </div>
      )}
    </div>
  );
}

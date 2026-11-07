import React, { useMemo } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Badge } from '../ui/badge';
import { Progress } from '../ui/progress';
import { Cpu, Clock, AlertTriangle, Network, ArrowRight } from 'lucide-react';
import { cn, shortGpuUuid, formatGPUMem } from '../../lib/utils';
import { getServingStatus } from '../../lib/servingStatus';
import { neighbourPods, topologyFocusFor } from '../../lib/servingPlacement';
import { latencySplit, formatSeconds } from '../../lib/servingLatency';
import { ServingTrends } from './ServingTrends';
import { MetricTip, STATUS_TONE_CLASSES, CopyableNode } from './shared';
import { MetaLine } from '../NodeBits';

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

// LatencySplit shows where a replica's mean response time goes: waiting for
// the first token (prefill) vs generating the rest (decode), on a scale shared
// with the other replicas of the same model so a slow one sticks out.
const LATENCY_SPLIT_TIP =
  'Mean time to first token (prefill: queueing and reading the prompt) and mean time spent generating the rest (decode). ' +
  'The bar shares its scale with the other replicas of this model, so a slow replica sticks out. ' +
  'A long first token points at queueing or long prompts; long generation points at GPU contention or long answers.';

function LatencySplit({ pod, peers }) {
  const split = latencySplit(pod, peers);
  if (!split) return null;
  const first = formatSeconds(split.ttft);
  const gen = formatSeconds(split.decode);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <MetricTip label="Latency split" tip={LATENCY_SPLIT_TIP} />
        <span className="font-mono">{formatSeconds(split.total)} mean</span>
      </div>
      <div
        className="flex h-2 w-full overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={`First token ${first}, generation ${gen}`}
      >
        <div className="bg-sky-500" style={{ width: `${split.ttftPct}%` }} />
        <div className="bg-violet-500" style={{ width: `${split.decodePct}%` }} />
      </div>
      <div className="flex gap-3 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <span className="h-2 w-2 rounded-sm bg-sky-500" aria-hidden="true" />
          first token {first}
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-2 w-2 rounded-sm bg-violet-500" aria-hidden="true" />
          generation {gen}
        </span>
      </div>
    </div>
  );
}

// ServingCard renders inference health for a single LLM serving pod. The
// header carries one status badge; secondary facts (backend, instance type,
// GPU model) sit in a quiet metadata line.
// servingCardId is the DOM id of a replica's card, so the model rows and the
// triage list can scroll to it.
export function servingCardId(pod) {
  return `serving-card-${pod.namespace}-${pod.name}`;
}

export function ServingCard({ pod, peers, history, placement, onOpenTopology, highlighted = false }) {
  const kv = pod.kvCachePercent;
  const status = useMemo(
    () => getServingStatus(pod, peers || [pod], placement),
    [pod, peers, placement],
  );
  const neighbourCount = useMemo(() => neighbourPods(placement).length, [placement]);
  const showInTopology =
    pod.node && onOpenTopology ? () => onOpenTopology(topologyFocusFor(pod, placement)) : null;
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
    <Card
      id={servingCardId(pod)}
      className={cn(
        'scroll-mt-24 transition-shadow',
        !pod.online && 'border-dashed border-red-300',
        highlighted && 'ring-2 ring-primary ring-offset-2 ring-offset-background',
      )}
    >
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
            <MetaLine
              className="mt-1"
              items={[
                pod.backend,
                pod.nodeInstanceType,
                pod.gpuModel && `${pod.gpuModel}${pod.gpuCapacity ? ` x${pod.gpuCapacity}` : ''}`,
              ]}
            />
          </div>
          <Badge
            variant="outline"
            className={cn('shrink-0 text-[10px] font-semibold', STATUS_TONE_CLASSES[status.tone])}
            title={statusTitle}
          >
            {status.label}
          </Badge>
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
                  <MetricTip label="Running" tip="Requests being processed right now. Compare with Waiting, the requests queued for a free slot."><Cpu className="h-3 w-3" /></MetricTip>
                </p>
                <p className="text-lg font-bold">{pod.running ?? 0}</p>
              </div>
              <div className="rounded-md bg-card/60 py-2">
                <p className="text-xs text-muted-foreground">
                  <MetricTip label="Waiting" tip="Requests queued for a free slot. Above 0 for a sustained period means the server is overloaded: add replicas, or raise --max-num-seqs if GPU memory allows." />
                </p>
                <p className={cn("text-lg font-bold", (pod.waiting ?? 0) > 0 && "text-yellow-600")}>
                  {pod.waiting ?? 0}
                </p>
              </div>
              <div className="rounded-md bg-card/60 py-2">
                <p className="text-xs text-muted-foreground flex items-center justify-center gap-1">
                  <MetricTip label="Preempt" tip="Requests evicted from GPU memory and re-run because the KV cache ran out, in the last 5 minutes (the total since the server started is below). Should stay at 0; preemptions now mean memory pressure and silently repeated work, which adds latency."><Clock className="h-3 w-3" /></MetricTip>
                </p>
                <p className={cn('text-lg font-bold', pod.preemptionsRecent > 0 && 'text-red-600')}>
                  {pod.preemptionsRecent ?? '–'}
                </p>
                <p className="text-[10px] text-muted-foreground">{pod.preemptions ?? 0} total</p>
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

            <LatencySplit pod={pod} peers={peers || [pod]} />

            <ServingTrends history={history} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

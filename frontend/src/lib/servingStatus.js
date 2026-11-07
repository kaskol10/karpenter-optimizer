// Serving status diagnosis, kept free of React so it can be unit-tested.
//
// getServingStatus derives { label, tone, reasons, meaning, fixes } for one
// serving pod from its own metrics, its peers serving the same model, and
// (optionally) its GPU placement — who else shares its physical GPU.

import { describeNeighbours } from './servingPlacement';

export const KV_PRESSURE_PCT = 85;
export const SLOW_PEER_RATIO = 2; // my p95 E2E > 2x the fastest peer
export const SLOW_PEER_FLOOR_SEC = 1; // ...and actually takes more than 1s
export const SLOW_TTFT_FLOOR_SEC = 3; // no-peer fallback: first token > 3s

// getServingStatus derives { label, tone, reasons, meaning, fixes } for one
// serving pod. `peers` is the full pod list; only online pods are comparable.
// `placement` (optional, from findGpuNeighbours) lets a troubled server name
// the pods it shares a physical GPU with.
// `meaning` is a plain-English "what does this state mean", and `fixes` is a
// short list of concrete things to try.
// SEVERITY orders statuses from most to least urgent (lower = worse), for
// the needs-attention sort and anything else that ranks servers by health.
export const SEVERITY = { offline: 0, pressure: 1, busy: 2, slow: 3, ok: 4 };

export const STATUS_FIXES = {
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

export function getServingStatus(pod, peers, placement) {
  if (!pod.online) {
    return {
      label: 'offline',
      severity: SEVERITY.offline,
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

  // Objective pressure signals. `preemptions` is vLLM's lifetime counter, so
  // it only says pressure happened at some point; `preemptionsRecent` (its
  // increase over the last 5 minutes, computed by the prober) says it is
  // happening now. Unknown until the second probe, and then not a signal.
  if (pod.preemptionsRecent > 0) {
    pressure = true;
    reasons.push(
      `${pod.preemptionsRecent} preemption(s) in the last 5 min — requests re-run due to KV cache pressure`,
    );
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

  // Noisy neighbour: a server that is already struggling *and* shares its
  // physical GPU with other pods gets that called out by name, because moving
  // the neighbour is usually the cheapest fix. Healthy co-located servers are
  // left alone — sharing a GPU is not a problem by itself.
  const troubled = pressure || busy || reasons.length > 0;
  const neighbours = troubled ? describeNeighbours(placement) : null;
  const neighbourFixes = [];
  if (neighbours) {
    reasons.push(neighbours.text);
    neighbourFixes.push(
      `Move the co-located pod${neighbours.count > 1 ? 's' : ''} off ${neighbours.gpuText}, or give this model a dedicated GPU`,
    );
  }

  if (pressure) {
    return {
      label: 'Under pressure',
      severity: SEVERITY.pressure,
      tone: 'red',
      reasons,
      limited,
      meaning: 'The GPU memory for in-flight requests is nearly full: requests are being re-run (preemptions) and new work will queue or be interrupted.',
      fixes: [...neighbourFixes, ...STATUS_FIXES.pressure],
      neighbours,
    };
  }
  if (busy) {
    return {
      label: 'Busy',
      severity: SEVERITY.busy,
      tone: 'amber',
      reasons,
      limited,
      meaning: 'More requests are arriving than this server can run right now — they are waiting in the queue, so users feel extra latency.',
      fixes: [...neighbourFixes, ...STATUS_FIXES.busy],
      neighbours,
    };
  }
  if (reasons.length > 0) {
    return {
      label: 'Slow',
      severity: SEVERITY.slow,
      tone: 'orange',
      reasons,
      limited,
      meaning: 'This server is responding much more slowly than the others serving the same model (or slower than expected when it runs alone).',
      fixes: [...neighbourFixes, ...STATUS_FIXES.slow],
      neighbours,
    };
  }
  return {
    label: 'OK',
    severity: SEVERITY.ok,
    tone: 'green',
    reasons: limited ? ['limited data (first sample)'] : [],
    limited,
    meaning: limited
      ? 'No problems detected yet, but only one sample has been collected — rates and latency compare against previous probes.'
      : 'No problems detected from the current metrics: no queue, no preemptions, headroom in GPU memory, and latency in line with its peers.',
    fixes: STATUS_FIXES.ok,
  };
}

// sortByAttention orders serving pods worst-first (offline, under pressure,
// busy, slow, then healthy), so the pod that needs a human is at the top.
// Ties go to the busier server (tokens/s), then to the name for stability.
// Status is judged against the whole fleet, exactly as the cards judge it.
export function sortByAttention(pods) {
  const severity = new Map(pods.map((p) => [p, getServingStatus(p, pods).severity]));
  const name = (p) => `${p.namespace}/${p.name}`;
  return pods.slice().sort(
    (a, b) =>
      severity.get(a) - severity.get(b) ||
      (b.tokensPerSec ?? -1) - (a.tokensPerSec ?? -1) ||
      name(a).localeCompare(name(b)),
  );
}

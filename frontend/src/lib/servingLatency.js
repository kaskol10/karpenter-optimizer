// Latency split for one serving replica: how much of a response is spent
// before the first token (prefill: queueing plus reading the prompt) and how
// much generating the rest (decode). A slow replica is usually slow in one of
// the two, and they point at different fixes: a long prefill means queueing
// or long prompts, a long decode means GPU contention or long answers.
//
// Means, not p95s: means add up (mean E2E = mean TTFT + mean decode), while
// p95s of the parts do not sum to the p95 of the whole.

// latencySplit returns { ttft, decode, total, scale, ttftPct, decodePct } in
// seconds and percent of `scale`, or null when the pod has no mean TTFT and
// E2E yet. `scale` is the slowest mean E2E among online replicas of the same
// model (including this one), so replicas of a model share one axis and a
// slow one visibly sticks out.
export function latencySplit(pod, peers = []) {
  const ttft = pod?.ttftSeconds;
  const total = pod?.e2eSeconds;
  if (ttft == null || total == null || total <= 0) return null;

  const clampedTtft = Math.min(Math.max(ttft, 0), total);
  const decode = total - clampedTtft;
  const sameModel = peers.filter(
    (p) => p.online && p.model && p.model === pod.model && p.e2eSeconds != null,
  );
  const scale = Math.max(total, ...sameModel.map((p) => p.e2eSeconds));

  return {
    ttft: clampedTtft,
    decode,
    total,
    scale,
    ttftPct: (clampedTtft / scale) * 100,
    decodePct: (decode / scale) * 100,
  };
}

// formatSeconds renders a latency compactly: 0.21s, 1.9s, 12s.
export function formatSeconds(s) {
  if (s == null) return '';
  if (s < 1) return `${s.toFixed(2)}s`;
  if (s < 10) return `${s.toFixed(1)}s`;
  return `${Math.round(s)}s`;
}

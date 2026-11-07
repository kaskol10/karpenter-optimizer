// The Serving triage list: one line per replica that needs a human, worst
// first, saying what is wrong, for how long, and where to look next.

import { getServingStatus, KV_PRESSURE_PCT, SEVERITY } from './servingStatus';

// isIssuePoint mirrors the backend's servinghistory.LastIssueIn: offline,
// queued requests, KV cache at or above the threshold, or new preemptions
// since the previous online sample (the counter is lifetime, so only an
// increase counts). prevOnline is that previous online sample, or null.
export function isIssuePoint(point, prevOnline) {
  if (!point.online || (point.waiting || 0) > 0) return true;
  if (point.kvCachePercent != null && point.kvCachePercent >= KV_PRESSURE_PCT) return true;
  return !!prevOnline && (point.preemptions || 0) > (prevOnline.preemptions || 0);
}

// issueSince returns the Unix time the current run of issue samples began,
// or null when the newest sample is healthy (or there is no history). It
// answers "how long has this been going on?" for offline, busy and pressure;
// "slow" is judged against peers at probe time, so history cannot date it.
export function issueSince(points) {
  if (!points || points.length === 0) return null;
  const flags = [];
  let prevOnline = null;
  points.forEach((p) => {
    flags.push(isIssuePoint(p, prevOnline));
    if (p.online) prevOnline = p;
  });
  if (!flags.at(-1)) return null;
  let i = flags.length - 1;
  while (i > 0 && flags[i - 1]) i -= 1;
  return points[i].unix || null;
}

// formatDuration renders seconds as "45s", "12m", "3h 5m", "2d 4h".
export function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

// buildTriage returns the replicas that are not OK, worst first:
//   { key, pod, placement, status, since (unix or null) }
// A shared GPU is already one of status.reasons when it matters.
// placements and history are keyed by "namespace/name".
export function buildTriage(pods, placements = {}, history = {}) {
  return pods
    .map((pod) => {
      const key = `${pod.namespace}/${pod.name}`;
      const placement = placements[key] || undefined;
      const status = getServingStatus(pod, pods, placement);
      return {
        key,
        pod,
        placement,
        status,
        since: issueSince(history[key]?.points),
      };
    })
    .filter((item) => item.status.severity < SEVERITY.ok)
    .sort((a, b) => a.status.severity - b.status.severity || a.key.localeCompare(b.key));
}

// kubectlCommands returns copy-ready commands for a serving replica.
export function kubectlCommands(pod) {
  const commands = [
    { label: 'Describe pod', command: `kubectl -n ${pod.namespace} describe pod ${pod.name}` },
    { label: 'Tail logs', command: `kubectl -n ${pod.namespace} logs ${pod.name} --tail=200` },
  ];
  if (pod.node) commands.push({ label: 'Describe node', command: `kubectl describe node ${pod.node}` });
  return commands;
}

// Group serving replicas by model, the way on-call engineers think about
// them ("is llama-70b healthy?"), with one aggregate row per model.
//
// Aggregates are chosen for triage: throughput and load are summed across
// replicas; latency and KV cache take the worst replica, because one bad
// replica is what users of that model feel.

import { getServingStatus, SEVERITY } from './servingStatus';

export const UNKNOWN_MODEL = '(unknown model)';

const maxOf = (values) => {
  const known = values.filter((v) => v != null);
  return known.length > 0 ? Math.max(...known) : null;
};
const sumOf = (values) => {
  const known = values.filter((v) => v != null);
  return known.length > 0 ? known.reduce((a, b) => a + b, 0) : null;
};

// groupByModel returns one entry per model:
//   { model, replicas, statuses (Map pod -> status), worstSeverity, online,
//     tokensPerSec, requestsPerSec, ttftP95, e2eP95, kvMax, running, waiting }
// Status is judged against the whole fleet with each pod's GPU placement
// (placements keyed by "namespace/name"), exactly as the cards judge it.
// Offline pods usually cannot report their model; they group under
// UNKNOWN_MODEL rather than disappearing.
export function groupByModel(pods, placements = {}) {
  const byModel = new Map();
  pods.forEach((pod) => {
    const model = pod.model || UNKNOWN_MODEL;
    if (!byModel.has(model)) byModel.set(model, []);
    byModel.get(model).push(pod);
  });

  return [...byModel.entries()].map(([model, replicas]) => {
    const statuses = new Map(
      replicas.map((p) => [p, getServingStatus(p, pods, placements[`${p.namespace}/${p.name}`])]),
    );
    const online = replicas.filter((p) => p.online);
    return {
      model,
      replicas,
      statuses,
      worstSeverity: Math.min(...replicas.map((p) => statuses.get(p).severity)),
      online: online.length,
      tokensPerSec: sumOf(online.map((p) => p.tokensPerSec)),
      requestsPerSec: sumOf(online.map((p) => p.requestsPerSec)),
      ttftP95: maxOf(online.map((p) => p.ttftP95Seconds)),
      e2eP95: maxOf(online.map((p) => p.e2eP95Seconds)),
      kvMax: maxOf(online.map((p) => p.kvCachePercent)),
      running: sumOf(online.map((p) => p.running)) ?? 0,
      waiting: sumOf(online.map((p) => p.waiting)) ?? 0,
    };
  });
}

// hasProblem: at least one replica is not OK.
export function hasProblem(group) {
  return group.worstSeverity < SEVERITY.ok;
}

// sortModels orders model rows for a sort key shared with the replica view:
// 'attention' (worst replica first, then busiest), 'throughput', 'requests',
// 'queue' (running + waiting) or 'name'.
export function sortModels(groups, sortBy = 'attention') {
  const byName = (a, b) => a.model.localeCompare(b.model);
  const desc = (key) => (a, b) => (b[key] ?? -1) - (a[key] ?? -1) || byName(a, b);
  const compare = {
    attention: (a, b) => a.worstSeverity - b.worstSeverity || desc('tokensPerSec')(a, b),
    throughput: desc('tokensPerSec'),
    requests: desc('requestsPerSec'),
    queue: (a, b) => b.running + b.waiting - (a.running + a.waiting) || byName(a, b),
    name: byName,
  }[sortBy] || ((a, b) => a.worstSeverity - b.worstSeverity || desc('tokensPerSec')(a, b));
  return groups.slice().sort(compare);
}

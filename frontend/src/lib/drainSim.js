// Drain simulator: "what happens if I drain these nodes?", answered in the
// browser from the topology the app already has. Read-only and approximate:
// it never touches the cluster.
//
// Model: every pod on a drained node except DaemonSet pods (they go with
// the node) is re-placed with first-fit decreasing (largest first) on the
// remaining nodes, preferring the pod's own NodePool:
//   - CPU and memory requests must fit under allocatable;
//   - a fractional GPU pod (nvidia.com/gpumem) needs that much free memory on
//     one card; a whole-GPU pod needs that many completely free cards (or, on
//     nodes without GPU memory data, that many unallocated GPUs).
// Not modelled (and listed in the result): taints and tolerations, node
// selectors and affinities, topology spread, PodDisruptionBudgets, and
// Karpenter launching new nodes.

import { nodeGpus } from './gpuFit';

export const NOT_MODELLED = [
  'taints and tolerations',
  'node selectors and affinity',
  'topology spread constraints',
  'PodDisruptionBudgets',
  'Karpenter launching new nodes',
];

export const HOURS_PER_MONTH = 730;

const podKey = (p) => `${p.namespace}/${p.name}`;
const isDaemonSet = (p) => (p.workloadType || '').toLowerCase() === 'daemonset';
const req = (p, k) => p.requests?.[k] || 0;

// capacityOf builds a node's mutable free capacity: CPU, memory, and free
// MiB per GPU card (or a free GPU count without memory data).
function capacityOf(node) {
  const pods = node.pods || [];
  const layout = nodeGpus(node);
  return {
    node,
    cpu: (node.cpuUsage?.allocatable || 0) - pods.reduce((s, p) => s + req(p, 'cpuCores'), 0),
    memory: (node.memoryUsage?.allocatable || 0) - pods.reduce((s, p) => s + req(p, 'memoryGiB'), 0),
    perGpuMiB: layout?.perGpuMiB || 0,
    cards: layout
      ? layout.gpus.map((g) => ({ key: g.key, label: g.label, free: g.uncertain ? 0 : g.freeMiB, total: g.totalMiB }))
      : [],
    freeGpus: layout ? 0 : Math.max((node.gpuCapacity || 0) - (node.gpuAllocated || 0), 0),
  };
}

const EPS = 1e-9;

// placeOn tries to put a pod on a capacity; on success it updates the
// capacity and returns the GPU cards used (labels), else null.
function placeOn(cap, pod) {
  if (req(pod, 'cpuCores') > cap.cpu + EPS || req(pod, 'memoryGiB') > cap.memory + EPS) return null;
  const gpus = Math.round(req(pod, 'gpu'));
  const gpuMem = req(pod, 'gpuMemMiB');
  let used = [];
  if (gpuMem > 0 && cap.cards.length > 0) {
    // Fractional (HAMi): memory on one card per GPU asked for, best fit.
    const n = Math.max(gpus, 1);
    const perCard = gpuMem / n;
    const cands = cap.cards.filter((c) => c.free + EPS >= perCard).sort((a, b) => a.free - b.free);
    if (cands.length < n) return null;
    used = cands.slice(0, n);
    used.forEach((c) => {
      c.free -= perCard;
    });
  } else if (gpus > 0 && cap.cards.length > 0) {
    const empty = cap.cards.filter((c) => c.free + EPS >= c.total);
    if (empty.length < gpus) return null;
    used = empty.slice(0, gpus);
    used.forEach((c) => {
      c.free = 0;
    });
  } else if (gpus > 0 || gpuMem > 0) {
    // No per-card data: count whole GPUs.
    const need = Math.max(gpus, 1);
    if (cap.freeGpus < need) return null;
    cap.freeGpus -= need;
  }
  cap.cpu -= req(pod, 'cpuCores');
  cap.memory -= req(pod, 'memoryGiB');
  return used.map((c) => c.label);
}

// size orders pods for first-fit decreasing: GPU pods first, then by CPU,
// then memory.
const size = (p) => [req(p, 'gpu') + req(p, 'gpuMemMiB') / 1e6, req(p, 'cpuCores'), req(p, 'memoryGiB')];
function bySizeDesc(a, b) {
  const sa = size(a);
  const sb = size(b);
  for (let i = 0; i < sa.length; i += 1) if (sa[i] !== sb[i]) return sb[i] - sa[i];
  return podKey(a).localeCompare(podKey(b));
}

// simulateDrain returns:
//   { drained: [names], moves: [{ pod, from, to, gpus: [labels], samePool }],
//     unplaced: [{ pod, from, reason }], goesWithNode: [pod keys],
//     savingsPerHour (null when a drained node has no price),
//     savingsPerMonth, currency }
export function simulateDrain(nodes, drainNames, { currency = 'USD' } = {}) {
  const drainSet = new Set(drainNames);
  const drained = nodes.filter((n) => drainSet.has(n.name));
  const targets = nodes.filter((n) => !drainSet.has(n.name)).map(capacityOf);

  const toMove = [];
  const goesWithNode = [];
  drained.forEach((n) => {
    (n.pods || []).forEach((p) => {
      if (isDaemonSet(p)) goesWithNode.push(podKey(p));
      else toMove.push({ pod: p, from: n });
    });
  });
  toMove.sort((a, b) => bySizeDesc(a.pod, b.pod));

  const moves = [];
  const unplaced = [];
  toMove.forEach(({ pod, from }) => {
    // Same NodePool first (Karpenter would usually keep it there), then any.
    const ordered = [
      ...targets.filter((t) => t.node.nodePool === from.nodePool),
      ...targets.filter((t) => t.node.nodePool !== from.nodePool),
    ];
    for (const cap of ordered) {
      const gpus = placeOn(cap, pod);
      if (gpus) {
        moves.push({ pod, from: from.name, to: cap.node.name, gpus, samePool: cap.node.nodePool === from.nodePool });
        return;
      }
    }
    const needsGpu = req(pod, 'gpu') > 0 || req(pod, 'gpuMemMiB') > 0;
    unplaced.push({
      pod,
      from: from.name,
      reason: targets.length === 0 ? 'no other node' : needsGpu ? 'no GPU with enough free memory' : 'not enough free CPU or memory',
    });
  });

  const prices = drained.map((n) => n.costPerHour);
  const savingsPerHour = drained.length > 0 && prices.every((c) => c != null) ? prices.reduce((a, b) => a + b, 0) : null;
  return {
    drained: drained.map((n) => n.name),
    moves,
    unplaced,
    goesWithNode,
    savingsPerHour,
    savingsPerMonth: savingsPerHour == null ? null : savingsPerHour * HOURS_PER_MONTH,
    currency,
  };
}

// parseDrainParam reads "?drain=a,b" into a list of node names.
export function parseDrainParam(value) {
  return (value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

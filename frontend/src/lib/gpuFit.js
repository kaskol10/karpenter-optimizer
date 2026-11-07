// GPU memory per physical card, fragmentation, and the "Will it fit?" check
// for the Topology tab. Pure functions over /api/v1/topology nodes.
//
// A node's cards come from HAMi placement (pod.gpuDevices, keyed by UUID:
// HAMi's index can be wrong). Cards no pod references are listed too, since
// they are where unplaced pods sit:
//   - a whole-GPU pod without placement (no HAMi, or not yet placed) takes a
//     whole card: GPUs are exclusive without a sharing layer;
//   - a fractional pod without placement (nvidia.com/gpumem but no
//     annotation) is put on the emptiest unlabelled card, which is then
//     "uncertain": we know the memory is used, not on which card.
// The fit check only counts cards it is sure about, and reports uncertain
// ones as "maybe". It checks memory only; HAMi also limits cores and tasks
// per card.

const GiB = 1024;

// parseSize reads a GPU memory size typed by a person into MiB: "40" and
// "40G"/"40GB"/"40Gi"/"40 GiB" are GiB, "40000M"/"MiB" are MiB, "1T" is TiB.
// null when it is not a positive size.
export function parseSize(text) {
  const m = String(text ?? '')
    .trim()
    .toLowerCase()
    .match(/^(\d+(?:\.\d+)?)\s*(t|ti|tb|tib|g|gi|gb|gib|m|mi|mb|mib)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!(n > 0)) return null;
  const unit = (m[2] || 'g')[0];
  const factor = { t: GiB * GiB, g: GiB, m: 1 }[unit];
  return Math.round(n * factor);
}

// formatMiB renders MiB as GiB with one decimal ("38.0 GiB"), or MiB below 1 GiB.
export function formatMiB(mib) {
  if (mib < GiB) return `${Math.round(mib)} MiB`;
  return `${(mib / GiB).toFixed(1)} GiB`;
}

const isGpuPod = (pod) => (pod.requests?.gpu || 0) > 0 || (pod.requests?.gpuMemMiB || 0) > 0;
const shortUuid = (uuid) => (uuid || '').replace(/^GPU-/, '').slice(0, 8);

// shortLabelFor names a card key the way the tanks label it: the first 8
// characters of a HAMi UUID, "GPU <n>" for an index-only key, "GPU" otherwise.
export function shortLabelFor(key) {
  if (!key) return 'GPU';
  if (key.startsWith('idx-')) return `GPU ${key.slice(4)}`;
  if (key.startsWith('unknown-')) return 'GPU (no uuid)';
  return shortUuid(key);
}

// nodeGpus lays a node's GPU pods out on its cards:
//   { perGpuMiB, gpus: [{ key, label, uuid, index, totalMiB, usedMiB, freeMiB,
//                          segments: [{ pod, memMiB, placed }], known, uncertain }],
//     unplaced: [{ pod, memMiB }] }
// null when the node has no GPUs or its GPU memory is unknown.
export function nodeGpus(node) {
  const count = Math.round(node.gpuCapacity || 0);
  if (count <= 0 || !((node.gpuMemTotalMiB || 0) > 0)) return null;
  const perGpuMiB = node.gpuMemTotalMiB / count;
  const gpuPods = (node.pods || []).filter(isGpuPod);

  const byKey = new Map();
  const unplacedPods = [];
  gpuPods.forEach((pod) => {
    const devices = pod.gpuDevices || [];
    if (devices.length === 0) {
      unplacedPods.push(pod);
      return;
    }
    devices.forEach((d) => {
      const key = d.uuid || `idx-${d.index}`;
      if (!byKey.has(key)) {
        byKey.set(key, {
          key,
          label: shortUuid(d.uuid) || `GPU ${d.index}`,
          uuid: d.uuid || '',
          index: d.index || 0,
          known: true,
          uncertain: false,
          segments: [],
        });
      }
      byKey.get(key).segments.push({ pod, memMiB: d.memoryMiB || 0, placed: true });
    });
  });

  const gpus = [...byKey.values()].sort((a, b) => a.index - b.index || a.label.localeCompare(b.label));
  for (let i = gpus.length; i < count; i += 1) {
    gpus.push({ key: `unknown-${i}`, label: 'no uuid', uuid: '', index: i, known: false, uncertain: false, segments: [] });
  }

  const used = (g) => g.segments.reduce((s, x) => s + x.memMiB, 0);
  const unlabelled = gpus.filter((g) => !g.known);
  const unplaced = [];
  // Whole-GPU pods first (they need empty cards), largest first.
  const ordered = unplacedPods
    .map((pod) => {
      const fractional = (pod.requests?.gpuMemMiB || 0) > 0;
      const cards = Math.max(Math.round(pod.requests?.gpu || 0), 1);
      return { pod, fractional, cards, memMiB: fractional ? pod.requests.gpuMemMiB : perGpuMiB };
    })
    .sort((a, b) => Number(a.fractional) - Number(b.fractional) || b.memMiB - a.memMiB);

  ordered.forEach(({ pod, fractional, cards, memMiB }) => {
    if (!fractional) {
      const empty = unlabelled.filter((g) => used(g) === 0).slice(0, cards);
      if (empty.length < cards) {
        unplaced.push({ pod, memMiB: memMiB * cards });
        return;
      }
      empty.forEach((g) => g.segments.push({ pod, memMiB: perGpuMiB, placed: false }));
      return;
    }
    const target = unlabelled
      .filter((g) => perGpuMiB - used(g) >= memMiB)
      .sort((a, b) => used(a) - used(b))[0];
    if (!target) {
      unplaced.push({ pod, memMiB });
      return;
    }
    target.segments.push({ pod, memMiB, placed: false });
    target.uncertain = true;
  });

  gpus.forEach((g) => {
    g.totalMiB = perGpuMiB;
    g.usedMiB = used(g);
    g.freeMiB = Math.max(perGpuMiB - g.usedMiB, 0);
  });
  return { perGpuMiB, gpus, unplaced };
}

// fragmentation sums a node's free GPU memory and finds the largest free
// space on one card (what one pod can actually get).
export function fragmentation(layout) {
  if (!layout) return null;
  const free = layout.gpus.map((g) => g.freeMiB);
  return {
    freeMiB: free.reduce((a, b) => a + b, 0),
    largestGapMiB: free.length ? Math.max(...free) : 0,
    totalMiB: layout.perGpuMiB * layout.gpus.length,
  };
}

// gpuFits says whether a request fits on one card: 'yes', 'maybe' (enough
// room, but an unplaced pod might be on this card) or 'no'.
export function gpuFits(gpu, requestMiB) {
  if (!(requestMiB > 0) || gpu.freeMiB < requestMiB) return 'no';
  return gpu.uncertain ? 'maybe' : 'yes';
}

// clusterFit counts the cards (and nodes) where a request fits:
//   { gpus, nodes, maybeGpus, largestGapMiB }
export function clusterFit(nodes, requestMiB) {
  const result = { gpus: 0, nodes: 0, maybeGpus: 0, largestGapMiB: 0 };
  nodes.forEach((node) => {
    const layout = nodeGpus(node);
    if (!layout) return;
    let fitsHere = 0;
    layout.gpus.forEach((g) => {
      const fit = gpuFits(g, requestMiB);
      if (fit === 'yes') fitsHere += 1;
      if (fit === 'maybe') result.maybeGpus += 1;
      result.largestGapMiB = Math.max(result.largestGapMiB, g.uncertain ? 0 : g.freeMiB);
    });
    result.gpus += fitsHere;
    if (fitsHere > 0) result.nodes += 1;
  });
  return result;
}

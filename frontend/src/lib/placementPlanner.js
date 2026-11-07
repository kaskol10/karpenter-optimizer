// Placement planner: "I want to deploy a 40 GiB model with 2 replicas, where
// can it go?" Grows out of the Will it fit? box (lib/gpuFit.js).
//
// It ranks the GPUs that can take one replica by contiguous free memory,
// then places replicas one at a time, preferring a zone not used yet, then a
// node not used yet, then the tightest card that fits (best fit, to keep big
// gaps for big models). Memory only, like the fit check; uncertain cards
// (an unplaced pod might be on them) are not used.

import { formatMiB, nodeGpus } from './gpuFit';

// candidateGpus lists every card with at least memMiB free:
//   [{ node, zone, nodePool, key, label, freeMiB }] by free memory, largest first.
export function candidateGpus(nodes, memMiB) {
  const out = [];
  nodes.forEach((node) => {
    const layout = nodeGpus(node);
    if (!layout) return;
    layout.gpus.forEach((g) => {
      if (!g.uncertain && g.freeMiB >= memMiB) {
        out.push({ node: node.name, zone: node.zone || '', nodePool: node.nodePool || '', key: g.key, label: g.label, freeMiB: g.freeMiB });
      }
    });
  });
  return out.sort((a, b) => b.freeMiB - a.freeMiB || a.node.localeCompare(b.node) || a.label.localeCompare(b.label));
}

// planPlacement returns:
//   { replicas, placed: [{ replica, node, zone, key, label }],
//     candidates, spread: { nodes, zones }, complete, message }
export function planPlacement(nodes, memMiB, replicas = 1) {
  const candidates = candidateGpus(nodes, memMiB);
  // Free memory per card as replicas land (a card may take two if it can).
  const free = new Map(candidates.map((c) => [`${c.node}|${c.key}`, c.freeMiB]));
  const usedZones = new Set();
  const usedNodes = new Set();
  const placed = [];

  for (let r = 1; r <= replicas; r += 1) {
    const fits = candidates.filter((c) => free.get(`${c.node}|${c.key}`) >= memMiB);
    if (fits.length === 0) break;
    const score = (c) => [usedZones.has(c.zone) ? 1 : 0, usedNodes.has(c.node) ? 1 : 0, free.get(`${c.node}|${c.key}`)];
    const best = fits.slice().sort((a, b) => {
      const sa = score(a);
      const sb = score(b);
      return sa[0] - sb[0] || sa[1] - sb[1] || sa[2] - sb[2] || a.node.localeCompare(b.node) || a.label.localeCompare(b.label);
    })[0];
    const k = `${best.node}|${best.key}`;
    free.set(k, free.get(k) - memMiB);
    usedZones.add(best.zone);
    usedNodes.add(best.node);
    placed.push({ replica: r, node: best.node, zone: best.zone, key: best.key, label: best.label });
  }

  const complete = placed.length === replicas;
  const spread = { nodes: usedNodes.size, zones: usedZones.size };
  let message;
  if (placed.length === 0) {
    const largest = Math.max(0, ...nodes.map((n) => nodeGpus(n)).filter(Boolean).flatMap((l) => l.gpus.filter((g) => !g.uncertain).map((g) => g.freeMiB)));
    message = `Nothing fits ${formatMiB(memMiB)} on one card (largest free space ${formatMiB(largest)}): the pool must grow.`;
  } else if (!complete) {
    message = `Only ${placed.length} of ${replicas} replicas fit: the pool must grow for the rest.`;
  } else if (replicas > 1 && spread.nodes === 1) {
    message = `All ${replicas} replicas fit, but only on one node: losing it takes the model down.`;
  } else if (replicas > 1 && spread.zones === 1) {
    message = `All ${replicas} replicas fit across ${spread.nodes} nodes, all in one zone.`;
  } else {
    message = `${replicas === 1 ? 'Fits' : `All ${replicas} replicas fit`} across ${spread.nodes} node${spread.nodes === 1 ? '' : 's'} in ${spread.zones} zone${spread.zones === 1 ? '' : 's'}.`;
  }
  return { replicas, placed, candidates, spread, complete, message };
}

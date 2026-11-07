// Topology lenses: one-click colour modes for the node tiles of the Cluster
// and NodePool zoom levels. Each lens maps a node to a colour, a short value
// and a sentence for its tooltip, plus a legend that is always on screen.
//
// Colours are fixed HSL values that read on light and dark backgrounds:
// ordered data uses one ramp (light to dark, or green to red for "how
// full"), categories use distinct hues, and grey always means "no data".

import { getServingStatus } from './servingStatus';

export const NO_DATA = 'hsl(220 9% 62%)';
const FULLNESS = ['hsl(142 55% 42%)', 'hsl(84 55% 42%)', 'hsl(45 90% 48%)', 'hsl(25 90% 52%)', 'hsl(0 72% 52%)'];
const VIOLET = ['hsl(262 70% 86%)', 'hsl(262 62% 72%)', 'hsl(262 55% 58%)', 'hsl(262 55% 45%)', 'hsl(262 60% 32%)'];
const AGE = ['hsl(199 89% 48%)', 'hsl(199 70% 62%)', 'hsl(199 45% 75%)', 'hsl(215 16% 80%)'];
const TONE_FILL = {
  green: 'hsl(142 55% 42%)',
  amber: 'hsl(45 90% 48%)',
  orange: 'hsl(25 90% 52%)',
  red: 'hsl(0 72% 52%)',
};

export const LENSES = [
  { id: 'requests', label: 'Requests', needs: null },
  { id: 'capacity', label: 'Capacity type', needs: null },
  { id: 'age', label: 'Age', needs: null },
  { id: 'cost', label: 'Cost', needs: null },
  { id: 'serving', label: 'Serving health', needs: 'serving' },
  { id: 'disruption', label: 'Disruption', needs: 'disruptions' },
  // Shown only when /topology reports a usage source (metrics-server or
  // Prometheus).
  { id: 'usage', label: 'Usage', needs: 'usage' },
];
export const LENS_IDS = LENSES.map((l) => l.id);

const pct = (v) => `${Math.round(v * 100)}%`;
const sumPods = (node, key) => (node.pods || []).reduce((s, p) => s + (p.requests?.[key] || 0), 0);

// nodeFullness is requested / allocatable for CPU, memory and GPU (memory
// when known, else count); `max` is the tightest of the three. Values are
// null when the node does not report the allocatable side.
export function nodeFullness(node) {
  const ratio = (used, total) => (total > 0 ? Math.min(used / total, 1) : null);
  const cpu = ratio(sumPods(node, 'cpuCores'), node.cpuUsage?.allocatable || 0);
  const memory = ratio(sumPods(node, 'memoryGiB'), node.memoryUsage?.allocatable || 0);
  let gpu = null;
  if ((node.gpuMemTotalMiB || 0) > 0) gpu = ratio(node.gpuMemAllocatedMiB || 0, node.gpuMemTotalMiB);
  else if ((node.gpuCapacity || 0) > 0) gpu = ratio(node.gpuAllocated || 0, node.gpuCapacity);
  const known = [cpu, memory, gpu].filter((v) => v != null);
  return { cpu, memory, gpu, max: known.length ? Math.max(...known) : null };
}

// nodeAgeHours is the node's age in hours, or null when unknown.
export function nodeAgeHours(node, now = Date.now()) {
  const created = node.creationTime ? new Date(node.creationTime).getTime() : NaN;
  if (Number.isNaN(created)) return null;
  return Math.max(0, (now - created) / 3600000);
}

// servingByNode maps node name → the worst serving status among the serving
// pods on it ({ label, tone, severity, pods }), judged as the Serving tab
// judges them.
export function servingByNode(servingPods = []) {
  const out = new Map();
  servingPods.forEach((pod) => {
    if (!pod.node) return;
    const status = getServingStatus(pod, servingPods);
    const prev = out.get(pod.node);
    const pods = [...(prev?.pods || []), `${pod.namespace}/${pod.name}`];
    if (!prev || status.severity < prev.severity) {
      out.set(pod.node, { label: status.label, tone: status.tone, severity: status.severity, pods });
    } else {
      prev.pods = pods;
    }
  });
  return out;
}

// disruptionsByNode maps node name → its disruption ({ blocked, reason }).
export function disruptionsByNode(disruptions = []) {
  const out = new Map();
  disruptions.forEach((d) => {
    if (!d.nodeName) return;
    const prev = out.get(d.nodeName);
    out.set(d.nodeName, {
      blocked: !!d.isBlocked || !!prev?.blocked,
      reason: d.reason || prev?.reason || 'disruption',
      blockingReason: d.blockingReason || prev?.blockingReason || '',
    });
  });
  return out;
}

const bucket = (value, steps) => steps.findIndex((limit) => value < limit);

// nodeUsageRatio is used / requested for CPU and memory over the node's pods
// that report usage; `min` is the lower of the two (how much of what was
// asked for sits idle). null without usage data.
export function nodeUsageRatio(node) {
  const withUsage = (node.pods || []).filter((p) => p.usage);
  if (withUsage.length === 0) return null;
  const sum = (fn) => withUsage.reduce((s, p) => s + fn(p), 0);
  const ratio = (used, req) => (req > 0 ? used / req : null);
  const cpu = ratio(sum((p) => p.usage.cpuCores || 0), sum((p) => p.requests?.cpuCores || 0));
  const memory = ratio(sum((p) => p.usage.memoryGiB || 0), sum((p) => p.requests?.memoryGiB || 0));
  const known = [cpu, memory].filter((v) => v != null);
  if (known.length === 0) return null;
  return { cpu, memory, min: Math.min(...known), max: Math.max(...known) };
}

// Used / requested: violet = asked for far more than it uses (rightsizing
// candidates), green = close to its request, red = using more than requested.
const USAGE = ['hsl(262 55% 45%)', 'hsl(262 45% 65%)', 'hsl(84 55% 42%)', 'hsl(142 55% 42%)', 'hsl(0 72% 52%)'];

// lensContext precomputes what the lenses need for a set of nodes.
export function lensContext(nodes, { servingPods, disruptions, now = Date.now(), currency = 'USD' } = {}) {
  const costs = nodes.map((n) => n.costPerHour).filter((c) => c != null);
  return {
    now,
    currency,
    maxCost: costs.length ? Math.max(...costs) : 0,
    serving: servingPods ? servingByNode(servingPods) : null,
    disruptions: disruptions ? disruptionsByNode(disruptions) : null,
  };
}

const money = (v, currency) => `${currency === 'CNY' ? 'CN¥' : '$'}${v.toFixed(2)}`;

// lensColor returns { fill, value, title } for a node under a lens.
export function lensColor(lensId, node, ctx) {
  switch (lensId) {
    case 'capacity': {
      if (node.capacityType === 'spot') return { fill: 'hsl(174 62% 38%)', value: 'spot', title: 'Spot capacity' };
      if (node.capacityType === 'on-demand') return { fill: 'hsl(262 52% 55%)', value: 'on-demand', title: 'On-demand capacity' };
      return { fill: NO_DATA, value: 'unknown', title: 'Capacity type unknown' };
    }
    case 'age': {
      const h = nodeAgeHours(node, ctx.now);
      if (h == null) return { fill: NO_DATA, value: '?', title: 'Age unknown' };
      const i = bucket(h, [1, 24, 24 * 7, Infinity]);
      const value = h < 1 ? `${Math.round(h * 60)}m` : h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`;
      return { fill: AGE[i], value, title: `Created ${value} ago` };
    }
    case 'cost': {
      if (node.costPerHour == null) return { fill: NO_DATA, value: '?', title: 'No price for this node' };
      const share = ctx.maxCost > 0 ? node.costPerHour / ctx.maxCost : 0;
      const i = Math.min(Math.floor(share * VIOLET.length), VIOLET.length - 1);
      const spot = node.pricedAs === 'spot' ? ' (spot, estimated)' : '';
      return {
        fill: VIOLET[i],
        value: `${money(node.costPerHour, ctx.currency)}/h`,
        title: `${money(node.costPerHour, ctx.currency)}/h${spot}`,
      };
    }
    case 'serving': {
      const s = ctx.serving?.get(node.name);
      if (!s) return { fill: NO_DATA, value: '–', title: 'No serving pods on this node' };
      return { fill: TONE_FILL[s.tone] || NO_DATA, value: s.label, title: `Serving: ${s.label} (${s.pods.join(', ')})` };
    }
    case 'disruption': {
      const d = ctx.disruptions?.get(node.name);
      if (!d) return { fill: FULLNESS[0], value: 'none', title: 'No disruption in progress' };
      if (d.blocked) {
        return { fill: TONE_FILL.red, value: 'blocked', title: `Disruption blocked (${d.reason}${d.blockingReason ? `: ${d.blockingReason}` : ''})` };
      }
      return { fill: TONE_FILL.amber, value: d.reason, title: `Being disrupted: ${d.reason}` };
    }
    case 'usage': {
      const r = nodeUsageRatio(node);
      if (!r) return { fill: NO_DATA, value: '?', title: 'No usage data for this node' };
      // Over-use (any resource above its request) matters most; otherwise the
      // most idle resource decides.
      const v = r.max > 1 ? r.max : r.min;
      const i = r.max > 1 ? 4 : bucket(v, [0.25, 0.5, 0.75, Infinity]);
      const parts = [r.cpu != null && `CPU ${pct(r.cpu)}`, r.memory != null && `memory ${pct(r.memory)}`].filter(Boolean);
      return { fill: USAGE[i], value: pct(v), title: `Used of requested: ${parts.join(', ')}` };
    }
    case 'requests':
    default: {
      const f = nodeFullness(node);
      if (f.max == null) return { fill: NO_DATA, value: '?', title: 'Allocatable capacity unknown' };
      const i = bucket(f.max, [0.5, 0.7, 0.85, 0.95, Infinity]);
      const parts = [
        f.cpu != null && `CPU ${pct(f.cpu)}`,
        f.memory != null && `memory ${pct(f.memory)}`,
        f.gpu != null && `GPU ${pct(f.gpu)}`,
      ].filter(Boolean);
      return { fill: FULLNESS[i], value: pct(f.max), title: `Requested: ${parts.join(', ')}` };
    }
  }
}

// lensLegend lists a lens's colours and what they mean.
export function lensLegend(lensId) {
  switch (lensId) {
    case 'capacity':
      return [
        { fill: 'hsl(174 62% 38%)', label: 'spot' },
        { fill: 'hsl(262 52% 55%)', label: 'on-demand' },
        { fill: NO_DATA, label: 'unknown' },
      ];
    case 'age':
      return [
        { fill: AGE[0], label: '< 1h' },
        { fill: AGE[1], label: '< 1 day' },
        { fill: AGE[2], label: '< 1 week' },
        { fill: AGE[3], label: 'older' },
      ];
    case 'cost':
      return [
        { fill: VIOLET[0], label: 'cheapest' },
        { fill: VIOLET[2], label: '' },
        { fill: VIOLET[4], label: 'most expensive (per hour)' },
        { fill: NO_DATA, label: 'no price' },
      ];
    case 'serving':
      return [
        { fill: TONE_FILL.green, label: 'OK' },
        { fill: TONE_FILL.amber, label: 'busy' },
        { fill: TONE_FILL.orange, label: 'slow' },
        { fill: TONE_FILL.red, label: 'pressure / offline' },
        { fill: NO_DATA, label: 'no serving pods' },
      ];
    case 'disruption':
      return [
        { fill: FULLNESS[0], label: 'none' },
        { fill: TONE_FILL.amber, label: 'being disrupted' },
        { fill: TONE_FILL.red, label: 'blocked' },
      ];
    case 'usage':
      return [
        { fill: USAGE[0], label: '< 25% used of requested' },
        { fill: USAGE[1], label: '< 50%' },
        { fill: USAGE[2], label: '< 75%' },
        { fill: USAGE[3], label: '≤ 100%' },
        { fill: USAGE[4], label: 'over request' },
        { fill: NO_DATA, label: 'no data' },
      ];
    case 'requests':
    default:
      return [
        { fill: FULLNESS[0], label: '< 50%' },
        { fill: FULLNESS[1], label: '< 70%' },
        { fill: FULLNESS[2], label: '< 85%' },
        { fill: FULLNESS[3], label: '< 95%' },
        { fill: FULLNESS[4], label: '≥ 95% requested' },
        { fill: NO_DATA, label: 'unknown' },
      ];
  }
}

// tileSize scales a node tile with its allocatable CPU (area ∝ capacity),
// between min and max pixels per side.
export function tileSize(node, maxCpu, min = 22, max = 56) {
  const cpu = node.cpuUsage?.allocatable || 0;
  if (!(maxCpu > 0) || !(cpu > 0)) return min;
  return Math.round(min + (max - min) * Math.sqrt(Math.min(cpu / maxCpu, 1)));
}

// groupNodes groups nodes by NodePool, then zone, both sorted by name:
//   [{ pool, zones: [{ zone, nodes }], count }]
export function groupNodes(nodes) {
  const pools = new Map();
  nodes.forEach((n) => {
    const pool = n.nodePool || '(no NodePool)';
    const zone = n.zone || '(no zone)';
    if (!pools.has(pool)) pools.set(pool, new Map());
    const zones = pools.get(pool);
    if (!zones.has(zone)) zones.set(zone, []);
    zones.get(zone).push(n);
  });
  return [...pools.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([pool, zones]) => {
      const zoneList = [...zones.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([zone, list]) => ({ zone, nodes: list.slice().sort((a, b) => a.name.localeCompare(b.name)) }));
      return { pool, zones: zoneList, count: zoneList.reduce((s, z) => s + z.nodes.length, 0) };
    });
}

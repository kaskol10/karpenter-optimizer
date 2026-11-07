// Topology time travel: what changed between two moments, and where the
// changes sit on the timeline. Data comes from /api/v1/topology/history
// (a past snapshot, same shape as /topology) and /api/v1/topology/events.
import { fragmentation, nodeGpus } from './gpuFit';

// parseAtParam reads a ?time= / ?compare= value (Unix seconds), or null.
export function parseAtParam(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const pad = (n) => String(n).padStart(2, '0');

// formatClock prints a Unix time as local HH:MM, with the day when it is not
// today ("Fri 23:40").
export function formatClock(at, now = Date.now()) {
  const d = new Date(at * 1000);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === new Date(now).toDateString()) return hm;
  return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${hm}`;
}

// formatAgo prints how long ago a Unix time was ("just now", "14 min ago",
// "3 h 5 min ago").
export function formatAgo(at, now = Date.now()) {
  const mins = Math.max(0, Math.round((now / 1000 - at) / 60));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} h ${m} min ago` : `${h} h ago`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// eventText is one line for an event, for marker tooltips and lists.
export function eventText(e) {
  const kind = [e.instanceType, e.capacityType].filter(Boolean).join(', ');
  const where = e.nodePool ? ` in ${e.nodePool}` : '';
  if (e.type === 'node-added') return `${e.node} launched${kind ? ` (${kind})` : ''}${where}`;
  if (e.type === 'node-removed') {
    const why = e.reason ? `: ${e.reason}` : '';
    return `${e.node} removed${why}${e.pods ? ` · ${plural(e.pods, 'pod')}` : ''}${where}`;
  }
  if (e.type === 'pod-moved') return `${e.pod} moved ${e.from} → ${e.to}`;
  return e.type;
}

// eventMarkers buckets events along the timeline so a day of churn stays
// readable: [{pos (0..1), at, added, removed, moved, events}], one per
// non-empty bucket, oldest first.
export function eventMarkers(events, from, to, buckets = 96) {
  if (!events?.length || !(to > from)) return [];
  const span = to - from;
  const byBucket = new Map();
  events.forEach((e) => {
    const at = typeof e.at === 'number' ? e.at : Date.parse(e.at) / 1000;
    if (!(at >= from && at <= to)) return;
    const b = Math.min(buckets - 1, Math.floor(((at - from) / span) * buckets));
    if (!byBucket.has(b)) byBucket.set(b, { pos: (b + 0.5) / buckets, at, added: 0, removed: 0, moved: 0, events: [] });
    const m = byBucket.get(b);
    m.at = Math.max(m.at, at);
    if (e.type === 'node-added') m.added += 1;
    else if (e.type === 'node-removed') m.removed += 1;
    else m.moved += 1;
    m.events.push(e);
  });
  return Array.from(byBucket.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, m]) => m);
}

// markerTone is the marker colour class: terminations win, then launches.
export function markerTone(m) {
  if (m.removed) return 'bg-red-500';
  if (m.added) return 'bg-emerald-500';
  return 'bg-amber-500';
}

const podKey = (p) => `${p.namespace}/${p.name}`;

function podIndex(nodes) {
  const m = new Map();
  nodes.forEach((n) => (n.pods || []).forEach((p) => m.set(podKey(p), n.name)));
  return m;
}

// diffTopology compares a past topology (before) with a later one (after):
//   addedNodes: names only in after
//   removedNodes: node objects only in before (kept whole so they can be drawn as ghosts)
//   movedPods: [{pod, from, to}] same pod name on another node
//   podsAdded / podsRemoved: counts by name
//   gpuShrunk: [{node, beforeMiB, afterMiB}] nodes on both sides whose
//     largest free GPU slice got smaller (fragmentation or new tenants)
export function diffTopology(before = [], after = []) {
  const beforeByName = new Map(before.map((n) => [n.name, n]));
  const afterNames = new Set(after.map((n) => n.name));
  const addedNodes = after.filter((n) => !beforeByName.has(n.name)).map((n) => n.name);
  const removedNodes = before.filter((n) => !afterNames.has(n.name));

  const was = podIndex(before);
  const now = podIndex(after);
  const movedPods = [];
  let podsAdded = 0;
  now.forEach((node, key) => {
    if (!was.has(key)) podsAdded += 1;
    else if (was.get(key) !== node) movedPods.push({ pod: key, from: was.get(key), to: node });
  });
  let podsRemoved = 0;
  was.forEach((_, key) => {
    if (!now.has(key)) podsRemoved += 1;
  });

  const gpuShrunk = [];
  after.forEach((n) => {
    const prev = beforeByName.get(n.name);
    if (!prev || !(n.gpuMemTotalMiB > 0)) return;
    const a = fragmentation(nodeGpus(prev));
    const b = fragmentation(nodeGpus(n));
    if (a && b && b.largestGapMiB < a.largestGapMiB) {
      gpuShrunk.push({ node: n.name, beforeMiB: a.largestGapMiB, afterMiB: b.largestGapMiB });
    }
  });
  movedPods.sort((x, y) => x.pod.localeCompare(y.pod));
  return { addedNodes, removedNodes, movedPods, podsAdded, podsRemoved, gpuShrunk };
}

// withChanges marks nodes for the Cluster map in compare mode: added nodes
// get change 'added', and removed nodes come back as ghosts (change
// 'removed', no pods) so the gap they left is visible.
export function withChanges(nodes, diff) {
  if (!diff) return nodes;
  const added = new Set(diff.addedNodes);
  const marked = nodes.map((n) => (added.has(n.name) ? { ...n, change: 'added' } : n));
  return marked.concat(diff.removedNodes.map((n) => ({ ...n, pods: [], change: 'removed' })));
}

// diffSummary is the one-line headline for a diff.
export function diffSummary(diff) {
  const parts = [];
  if (diff.addedNodes.length) parts.push(`+${plural(diff.addedNodes.length, 'node')}`);
  if (diff.removedNodes.length) parts.push(`−${plural(diff.removedNodes.length, 'node')}`);
  if (diff.movedPods.length) parts.push(`${plural(diff.movedPods.length, 'pod')} moved`);
  if (diff.podsAdded) parts.push(`${diff.podsAdded} new`);
  if (diff.podsRemoved) parts.push(`${diff.podsRemoved} gone`);
  return parts.length ? parts.join(' · ') : 'No placement changes';
}

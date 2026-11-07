// Blast-radius warnings: workloads whose replicas all sit on one node or in
// one zone, so a single node drain, spot interruption or zone outage takes
// the whole workload down. Built from the workload name on each pod.

const IGNORED = new Set(['daemonset', 'job', 'cronjob', '']);

// workloadSpread groups every pod in view by workload and returns those at
// risk, worst first:
//   [{ key, namespace, name, type, replicas, nodes: [..], zones: [..],
//      risk: 'node' | 'zone' }]
// DaemonSets (one per node by design), Jobs and single-replica workloads
// are skipped: one replica is a single point of failure wherever it runs.
export function workloadSpread(nodes) {
  const groups = new Map();
  nodes.forEach((node) => {
    (node.pods || []).forEach((pod) => {
      const type = (pod.workloadType || '').toLowerCase();
      if (IGNORED.has(type) || !pod.workloadName) return;
      const key = `${pod.namespace}/${pod.workloadType}/${pod.workloadName}`;
      if (!groups.has(key)) {
        groups.set(key, { key, namespace: pod.namespace, name: pod.workloadName, type: pod.workloadType, replicas: 0, nodes: new Set(), zones: new Set() });
      }
      const g = groups.get(key);
      g.replicas += 1;
      g.nodes.add(node.name);
      g.zones.add(node.zone || '(no zone)');
    });
  });
  const out = [];
  groups.forEach((g) => {
    if (g.replicas < 2) return;
    let risk = null;
    if (g.nodes.size === 1) risk = 'node';
    else if (g.zones.size === 1) risk = 'zone';
    if (risk) out.push({ ...g, nodes: [...g.nodes].sort(), zones: [...g.zones].sort(), risk });
  });
  return out.sort((a, b) => (a.risk === b.risk ? a.key.localeCompare(b.key) : a.risk === 'node' ? -1 : 1));
}

// risksOnNode returns the at-risk workloads that have every replica on node.
export function risksOnNode(risks, nodeName) {
  return risks.filter((r) => r.risk === 'node' && r.nodes[0] === nodeName);
}

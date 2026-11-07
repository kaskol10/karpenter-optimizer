// Copy-ready kubectl commands for a node. Read-only or dry-run only: the app
// never changes the cluster, it hands the operator the command.
export function nodeKubectlCommands(nodeName) {
  return [
    { label: 'Describe node', command: `kubectl describe node ${nodeName}` },
    { label: 'Pods on node', command: `kubectl get pods -A -o wide --field-selector spec.nodeName=${nodeName}` },
    {
      label: 'Drain (dry run)',
      command: `kubectl drain ${nodeName} --ignore-daemonsets --delete-emptydir-data --dry-run=client`,
    },
  ];
}

// logTargets orders a node's pods for the "Open logs" submenu: workloads
// first (DaemonSet agents last), then by name, at most `limit`.
export function logTargets(pods = [], limit = 12) {
  const isDs = (p) => (p.workloadType || '').toLowerCase() === 'daemonset';
  return pods
    .slice()
    .sort((a, b) => Number(isDs(a)) - Number(isDs(b)) || `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`))
    .slice(0, limit);
}

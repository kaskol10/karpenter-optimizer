import { test, expect } from 'vitest';
import { nodeKubectlCommands, logTargets } from './nodeActions';

test('kubectl commands are read-only or dry-run', () => {
  const cmds = nodeKubectlCommands('ip-1');
  expect(cmds.map((c) => c.command)).toEqual([
    'kubectl describe node ip-1',
    'kubectl get pods -A -o wide --field-selector spec.nodeName=ip-1',
    'kubectl drain ip-1 --ignore-daemonsets --delete-emptydir-data --dry-run=client',
  ]);
  cmds.filter((c) => c.command.includes('drain')).forEach((c) => expect(c.command).toContain('--dry-run=client'));
});

test('logTargets: workloads before DaemonSet agents, by name, capped', () => {
  const pods = [
    { namespace: 'kube-system', name: 'agent', workloadType: 'DaemonSet' },
    { namespace: 'prod', name: 'b' },
    { namespace: 'prod', name: 'a' },
  ];
  expect(logTargets(pods).map((p) => p.name)).toEqual(['a', 'b', 'agent']);
  expect(logTargets(pods, 1)).toHaveLength(1);
  expect(logTargets()).toEqual([]);
});

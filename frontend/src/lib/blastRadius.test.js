import { describe, test, expect } from 'vitest';
import { workloadSpread, risksOnNode } from './blastRadius';

const pod = (namespace, name, workloadName, workloadType = 'Deployment') => ({ namespace, name, workloadName, workloadType });
const node = (name, zone, pods) => ({ name, zone, pods });

describe('workloadSpread', () => {
  const nodes = [
    node('a', 'z1', [
      pod('prod', 'api-1', 'api'),
      pod('prod', 'api-2', 'api'),
      pod('prod', 'web-1', 'web'),
      pod('kube-system', 'agent-a', 'agent', 'DaemonSet'),
      pod('prod', 'once-1', 'once', 'Job'),
      pod('prod', 'solo-1', 'solo'),
      pod('prod', 'bare', ''),
    ]),
    node('b', 'z1', [pod('prod', 'web-2', 'web'), pod('prod', 'db-0', 'db', 'StatefulSet'), pod('kube-system', 'agent-b', 'agent', 'DaemonSet')]),
    node('c', 'z2', [pod('prod', 'db-1', 'db', 'StatefulSet')]),
    node('d', undefined, [pod('ops', 'x-1', 'x'), pod('ops', 'x-2', 'x')]),
  ];
  const risks = workloadSpread(nodes);

  test('flags workloads on one node first, then one zone; spread ones are fine', () => {
    expect(risks.map((r) => [r.key, r.risk])).toEqual([
      ['ops/Deployment/x', 'node'],
      ['prod/Deployment/api', 'node'],
      ['prod/Deployment/web', 'zone'],
    ]);
    expect(risks[1]).toEqual(expect.objectContaining({ replicas: 2, nodes: ['a'], zones: ['z1'] }));
    expect(risks[2]).toEqual(expect.objectContaining({ nodes: ['a', 'b'], zones: ['z1'] }));
  });

  test('skips DaemonSets, Jobs, single replicas and pods without a workload', () => {
    const keys = risks.map((r) => r.key).join(' ');
    expect(keys).not.toMatch(/agent|once|solo|db/);
  });

  test('risksOnNode keeps the single-node risks for that node', () => {
    expect(risksOnNode(risks, 'a').map((r) => r.name)).toEqual(['api']);
    expect(risksOnNode(risks, 'b')).toEqual([]);
  });

  test('nodes without pods', () => {
    expect(workloadSpread([{ name: 'empty' }])).toEqual([]);
  });
});

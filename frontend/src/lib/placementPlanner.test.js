import { describe, test, expect } from 'vitest';
import { candidateGpus, planPlacement } from './placementPlanner';
import { topologyNodes } from '../test/fixtures';

const GiB = 1024;
const gpuNode = (name, zone, frees, extra = {}) => ({
  name,
  zone,
  nodePool: 'gpu',
  gpuCapacity: frees.length,
  gpuMemTotalMiB: frees.length * 40 * GiB,
  pods: frees.map((free, i) => ({
    namespace: 'ns',
    name: `${name}-p${i}`,
    requests: { gpu: 1, gpuMemMiB: 40 * GiB - free },
    gpuDevices: [{ uuid: `GPU-${name}${i}`, index: i, memoryMiB: 40 * GiB - free }],
  })),
  ...extra,
});

describe('candidateGpus', () => {
  test('cards with room, largest free first', () => {
    const c = candidateGpus(topologyNodes, 17 * GiB);
    expect(c.map((x) => [x.node, x.label, x.freeMiB])).toEqual([
      ['ip-10-0-4-12', 'no uuid', 46000],
      ['ip-10-0-4-12', 'no uuid', 46000],
      ['ip-10-0-7-88', 'no uuid', 46000],
      ['ip-10-0-7-88', 'no uuid', 46000],
      ['ip-10-0-7-88', 'd4d4d4d4', 18000],
    ]);
    expect(candidateGpus([{ gpuCapacity: 0 }], 1)).toEqual([]);
  });
});

describe('planPlacement', () => {
  test('spreads replicas across zones, then nodes, best fit within', () => {
    const nodes = [gpuNode('a1', 'za', [30 * GiB, 20 * GiB]), gpuNode('a2', 'za', [25 * GiB]), gpuNode('b1', 'zb', [35 * GiB])];
    const plan = planPlacement(nodes, 20 * GiB, 3);
    expect(plan.placed.map((p) => [p.replica, p.node, p.label])).toEqual([
      [1, 'a1', 'a11'], // best fit: 20 GiB free on a1
      [2, 'b1', 'b10'], // a new zone
      [3, 'a2', 'a20'], // a new node
    ]);
    expect(plan.complete).toBe(true);
    expect(plan.spread).toEqual({ nodes: 3, zones: 2 });
    expect(plan.message).toBe('All 3 replicas fit across 3 nodes in 2 zones.');
  });

  test('a card can take two replicas when nothing else fits', () => {
    const plan = planPlacement([gpuNode('a', 'z', [40 * GiB])], 10 * GiB, 2);
    expect(plan.placed.map((p) => p.label)).toEqual(['a0', 'a0']);
    expect(plan.message).toBe('All 2 replicas fit, but only on one node: losing it takes the model down.');
  });

  test('one zone, partial fit, nothing fits, single replica', () => {
    const oneZone = planPlacement([gpuNode('a', 'z', [20 * GiB]), gpuNode('b', 'z', [20 * GiB])], 20 * GiB, 2);
    expect(oneZone.message).toBe('All 2 replicas fit across 2 nodes, all in one zone.');

    const partial = planPlacement([gpuNode('a', 'z', [20 * GiB])], 20 * GiB, 3);
    expect(partial.placed).toHaveLength(1);
    expect(partial.complete).toBe(false);
    expect(partial.message).toBe('Only 1 of 3 replicas fit: the pool must grow for the rest.');

    const none = planPlacement([gpuNode('a', 'z', [10 * GiB])], 20 * GiB, 1);
    expect(none.placed).toEqual([]);
    expect(none.message).toBe('Nothing fits 20.0 GiB on one card (largest free space 10.0 GiB): the pool must grow.');
    expect(planPlacement([], 20 * GiB).message).toMatch(/largest free space 0 MiB/);

    const single = planPlacement([gpuNode('a', 'z', [30 * GiB])], 20 * GiB);
    expect(single.message).toBe('Fits across 1 node in 1 zone.');
  });

  test('ties break by node then card name; nodes without a zone', () => {
    const nodes = [gpuNode('b', undefined, [20 * GiB]), gpuNode('a', undefined, [20 * GiB, 20 * GiB])];
    expect(planPlacement(nodes, 20 * GiB, 1).placed[0]).toEqual(expect.objectContaining({ node: 'a', label: 'a0', zone: '' }));
  });
});

import { describe, test, expect } from 'vitest';
import { parseSize, formatMiB, nodeGpus, fragmentation, gpuFits, clusterFit } from './gpuFit';
import { topologyNodes, GPU } from '../test/fixtures';

const [node412, node788] = topologyNodes;
const pod = (name, requests, gpuDevices = []) => ({ namespace: 'ns', name, requests, gpuDevices });
const node = (pods, extra = {}) => ({ name: 'n', gpuCapacity: 2, gpuMemTotalMiB: 2 * 24576, pods, ...extra });

describe('parseSize', () => {
  test.each([
    ['40', 40960],
    ['40G', 40960],
    ['40 GiB', 40960],
    ['40gb', 40960],
    ['40Gi', 40960],
    ['24000 MiB', 24000],
    ['24000m', 24000],
    ['0.5', 512],
    ['1T', 1048576],
    ['  12 g  ', 12288],
  ])('%s → %s MiB', (text, mib) => expect(parseSize(text)).toBe(mib));

  test.each(['', 'abc', '-4', '0', '40 GHz', null, undefined])('%s → null', (text) => expect(parseSize(text)).toBeNull());
});

test('formatMiB', () => {
  expect(formatMiB(512)).toBe('512 MiB');
  expect(formatMiB(38912)).toBe('38.0 GiB');
});

describe('nodeGpus', () => {
  test('HAMi cards keyed by UUID, plus the cards no pod references', () => {
    const layout = nodeGpus(node788);
    expect(layout.perGpuMiB).toBe(46000);
    expect(layout.gpus.map((g) => g.label)).toEqual(['c3c3c3c3', 'd4d4d4d4', 'no uuid', 'no uuid']);
    const c = layout.gpus[0];
    expect(c.segments.map((s) => s.pod.name)).toEqual(['llama-70b-r2', 'embed-worker-7f9c']);
    expect(c.usedMiB).toBe(44000);
    expect(c.freeMiB).toBe(2000);
    expect(layout.gpus[2]).toEqual(expect.objectContaining({ known: false, usedMiB: 0, freeMiB: 46000 }));
    expect(layout.unplaced).toEqual([]);
  });

  test('null without GPUs or GPU memory', () => {
    expect(nodeGpus({ gpuCapacity: 0, gpuMemTotalMiB: 0 })).toBeNull();
    expect(nodeGpus({ gpuCapacity: 4, gpuMemTotalMiB: 0, pods: [] })).toBeNull();
  });

  test('a card referenced by index only, and a node without a pods list', () => {
    const layout = nodeGpus(node([pod('a', { gpuMemMiB: 1000 }, [{ index: 1, memoryMiB: 1000 }])]));
    expect(layout.gpus[0]).toEqual(expect.objectContaining({ key: 'idx-1', label: 'GPU 1', uuid: '' }));
    expect(nodeGpus({ gpuCapacity: 1, gpuMemTotalMiB: 100 }).gpus).toHaveLength(1);
  });

  test('cards sort by index, then label', () => {
    const d = (uuid, index) => [{ uuid, index, memoryMiB: 10 }];
    const layout = nodeGpus(
      node([pod('a', { gpu: 1 }, d('GPU-bbbb', 0)), pod('b', { gpu: 1 }, d('GPU-aaaa', 0)), pod('c', { gpu: 1 }, d('GPU-cccc', 1))], { gpuCapacity: 3, gpuMemTotalMiB: 300 }),
    );
    expect(layout.gpus.map((g) => g.label)).toEqual(['aaaa', 'bbbb', 'cccc']);
  });

  test('whole-GPU pods without placement take whole free cards, certainly', () => {
    const layout = nodeGpus(node([pod('trainer', { gpu: 1 })]));
    expect(layout.gpus[0].segments[0]).toEqual(expect.objectContaining({ memMiB: 24576, placed: false }));
    expect(layout.gpus[0].freeMiB).toBe(0);
    expect(layout.gpus[0].uncertain).toBe(false);
    expect(layout.gpus[1].freeMiB).toBe(24576);
  });

  test('fractional pods without placement go on the emptiest card, which becomes uncertain', () => {
    const layout = nodeGpus(node([pod('a', { gpu: 1, gpuMemMiB: 8000 }), pod('b', { gpu: 1, gpuMemMiB: 6000 })]));
    expect(layout.gpus[0].segments.map((s) => s.pod.name)).toEqual(['a']);
    expect(layout.gpus[1].segments.map((s) => s.pod.name)).toEqual(['b']);
    expect(layout.gpus.every((g) => g.uncertain)).toBe(true);
  });

  test('pods that fit nowhere are listed as unplaced', () => {
    const layout = nodeGpus(
      node([pod('big', { gpu: 3 }), pod('huge', { gpuMemMiB: 99999 }), pod('w1', { gpu: 1 }), pod('w2', { gpu: 1 }), pod('w3', { gpu: 1 })]),
    );
    expect(layout.unplaced.map((u) => u.pod.name).sort()).toEqual(['big', 'huge', 'w3']);
    expect(layout.unplaced.find((u) => u.pod.name === 'big').memMiB).toBe(3 * 24576);
  });

  test('non-GPU pods are ignored; device memory defaults to 0', () => {
    const layout = nodeGpus(node([pod('cpu', { cpuCores: 1 }), pod('x', { gpu: 1 }, [{ uuid: 'GPU-1', index: 0 }])]));
    expect(layout.gpus[0].segments).toHaveLength(1);
    expect(layout.gpus[0].usedMiB).toBe(0);
  });
});

describe('fragmentation', () => {
  test('total free and the largest free space on one card', () => {
    expect(fragmentation(nodeGpus(node788))).toEqual({ freeMiB: 2000 + 18000 + 46000 + 46000, largestGapMiB: 46000, totalMiB: 184000 });
    expect(fragmentation(null)).toBeNull();
    expect(fragmentation({ perGpuMiB: 0, gpus: [] }).largestGapMiB).toBe(0);
  });
});

describe('gpuFits and clusterFit', () => {
  test('yes / maybe / no', () => {
    expect(gpuFits({ freeMiB: 5000, uncertain: false }, 4000)).toBe('yes');
    expect(gpuFits({ freeMiB: 5000, uncertain: true }, 4000)).toBe('maybe');
    expect(gpuFits({ freeMiB: 3000, uncertain: false }, 4000)).toBe('no');
    expect(gpuFits({ freeMiB: 3000, uncertain: false }, null)).toBe('no');
  });

  test('counts cards and nodes across the cluster', () => {
    // 40 GiB: the two empty cards on each node.
    expect(clusterFit(topologyNodes, 40960)).toEqual({ gpus: 4, nodes: 2, maybeGpus: 0, largestGapMiB: 46000 });
    // 17 GiB also fits on d4d4d4d4 (18000 MiB free).
    expect(clusterFit([node788], 17408).gpus).toBe(3);
    expect(clusterFit(topologyNodes, 50000)).toEqual({ gpus: 0, nodes: 0, maybeGpus: 0, largestGapMiB: 46000 });
  });

  test('uncertain cards are maybes and do not count as a sure gap; nodes without memory are skipped', () => {
    const uncertain = node([pod('a', { gpu: 1, gpuMemMiB: 4000 }), pod('b', { gpu: 1, gpuMemMiB: 4000 })]);
    expect(clusterFit([uncertain, { gpuCapacity: 0 }], 10000)).toEqual({ gpus: 0, nodes: 0, maybeGpus: 2, largestGapMiB: 0 });
  });

  test('fixture sanity: node 412 has two full cards', () => {
    const g = nodeGpus(node412).gpus;
    expect(g.filter((x) => x.freeMiB === 0).map((x) => x.uuid)).toEqual([GPU.a.uuid, GPU.b.uuid]);
  });
});

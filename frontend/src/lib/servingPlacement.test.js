import { describe, test, expect } from 'vitest';
import { findGpuNeighbours, describeNeighbours, neighbourPods, gpuKey } from './servingPlacement';

const gpuA = { uuid: 'GPU-aaaaaaaa-1111-2222-3333-444444444444', index: 0, memoryMiB: 20000 };
const gpuB = { uuid: 'GPU-bbbbbbbb-1111-2222-3333-444444444444', index: 0, memoryMiB: 20000 };

const pod = (namespace, name, extra = {}) => ({ namespace, name, requests: {}, ...extra });

const topology = [
  {
    name: 'node-1',
    gpuCapacity: 2,
    pods: [
      pod('llm', 'llama-0', { requests: { gpu: 1, gpuMemMiB: 20000 }, gpuDevices: [gpuA] }),
      pod('batch', 'embed-0', { requests: { gpu: 1, gpuMemMiB: 8000 }, gpuDevices: [{ ...gpuA, memoryMiB: 8000 }] }),
      pod('llm', 'small-0', { requests: { gpu: 1 }, gpuDevices: [gpuB] }),
      pod('kube-system', 'node-exporter'),
    ],
  },
  {
    name: 'single-gpu',
    gpuCapacity: 1,
    pods: [pod('llm', 'qwen-0', { requests: { gpu: 1 } }), pod('ml', 'trainer', { requests: { gpu: 1 } })],
  },
  {
    name: 'multi-gpu-no-hami',
    gpuCapacity: 4,
    pods: [pod('llm', 'mistral-0', { requests: { gpu: 1 } }), pod('ml', 'other', { requests: { gpu: 1 } })],
  },
];

describe('gpuKey', () => {
  test('prefers the UUID and falls back to the index', () => {
    expect(gpuKey(gpuA)).toBe(gpuA.uuid);
    expect(gpuKey({ index: 3 })).toBe('idx-3');
  });
});

describe('findGpuNeighbours', () => {
  test('returns null when the pod or node is unknown', () => {
    expect(findGpuNeighbours(null, topology)).toBeNull();
    expect(findGpuNeighbours(pod('llm', 'x'), topology)).toBeNull();
    expect(findGpuNeighbours(pod('llm', 'x', { node: 'nope' }), topology)).toBeNull();
  });

  test('finds pods on the same physical GPU by UUID, ignoring other GPUs and non-GPU pods', () => {
    const p = findGpuNeighbours(pod('llm', 'llama-0', { node: 'node-1', gpuDevices: [gpuA] }), topology);
    expect(p.precise).toBe(true);
    expect(p.shared).toHaveLength(1);
    expect(p.shared[0].gpu.label).toBe('aaaaaaaa');
    expect(p.shared[0].neighbours.map((n) => n.pod.name)).toEqual(['embed-0']);
    expect(p.shared[0].neighbours[0].memMiB).toBe(8000);
  });

  test('uses topology placement when the serving payload has no devices', () => {
    const p = findGpuNeighbours(pod('llm', 'llama-0', { node: 'node-1' }), topology);
    expect(neighbourPods(p).map((x) => x.name)).toEqual(['embed-0']);
  });

  test('a pod alone on its GPU has no neighbours', () => {
    const p = findGpuNeighbours(pod('llm', 'small-0', { node: 'node-1' }), topology);
    expect(p.shared).toEqual([]);
    expect(describeNeighbours(p)).toBeNull();
  });

  test('single-GPU node without placement: other GPU pods must time-slice the card', () => {
    const p = findGpuNeighbours(pod('llm', 'qwen-0', { node: 'single-gpu' }), topology);
    expect(p.precise).toBe(false);
    expect(neighbourPods(p).map((x) => x.name)).toEqual(['trainer']);
  });

  test('multi-GPU node without placement: GPUs assumed exclusive, others reported as unplaced', () => {
    const p = findGpuNeighbours(pod('llm', 'mistral-0', { node: 'multi-gpu-no-hami' }), topology);
    expect(p.shared).toEqual([]);
    expect(p.unplaced.map((x) => x.name)).toEqual(['other']);
  });
});

describe('describeNeighbours', () => {
  test('names neighbours and truncates long lists', () => {
    const placement = {
      shared: [
        {
          gpu: { label: 'aaaaaaaa' },
          neighbours: ['a', 'b', 'c'].map((n) => ({ pod: pod('ns', n) })),
        },
      ],
    };
    expect(describeNeighbours(placement)).toEqual({
      text: 'shares aaaaaaaa with ns/a, ns/b (+1 more)',
      gpuText: 'aaaaaaaa',
      count: 3,
    });
  });
});

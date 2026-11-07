import { describe, test, expect } from 'vitest';
import { simulateDrain, parseDrainParam, NOT_MODELLED, HOURS_PER_MONTH } from './drainSim';
import { topologyNodes } from '../test/fixtures';

const pod = (name, requests, extra = {}) => ({ namespace: 'ns', name, requests, gpuDevices: [], ...extra });
const node = (name, pods, extra = {}) => ({
  name,
  nodePool: 'general',
  zone: 'z1',
  cpuUsage: { allocatable: 8 },
  memoryUsage: { allocatable: 32 },
  pods,
  ...extra,
});

describe('simulateDrain', () => {
  test('moves pods first-fit decreasing, DaemonSets go with the node, savings from the price', () => {
    const nodes = [
      node('a', [pod('big', { cpuCores: 5, memoryGiB: 4 }), pod('small', { cpuCores: 1, memoryGiB: 1 }), pod('agent', { cpuCores: 0.1 }, { workloadType: 'DaemonSet' })], { costPerHour: 0.4 }),
      node('b', [pod('x', { cpuCores: 2, memoryGiB: 8 })]),
      node('c', []),
    ];
    const r = simulateDrain(nodes, ['a']);
    expect(r.drained).toEqual(['a']);
    expect(r.goesWithNode).toEqual(['ns/agent']);
    // big (5 cores) is placed first, on b (6 free); small then fits on b too.
    expect(r.moves.map((m) => [m.pod.name, m.to])).toEqual([['big', 'b'], ['small', 'b']]);
    expect(r.moves[0]).toEqual(expect.objectContaining({ from: 'a', samePool: true, gpus: [] }));
    expect(r.unplaced).toEqual([]);
    expect(r.savingsPerHour).toBe(0.4);
    expect(r.savingsPerMonth).toBeCloseTo(0.4 * HOURS_PER_MONTH);
    expect(r.currency).toBe('USD');
  });

  test('prefers the same NodePool, then any; lists what does not fit with a reason', () => {
    const nodes = [
      node('a', [pod('web', { cpuCores: 2, memoryGiB: 2 }), pod('huge', { cpuCores: 20, memoryGiB: 1 })]),
      node('other-pool', [], { nodePool: 'batch' }),
      node('same-pool-full', [pod('f', { cpuCores: 7.5, memoryGiB: 1 })]),
    ];
    const r = simulateDrain(nodes, ['a'], { currency: 'CNY' });
    expect(r.moves).toEqual([expect.objectContaining({ to: 'other-pool', samePool: false })]);
    expect(r.unplaced).toEqual([expect.objectContaining({ from: 'a', reason: 'not enough free CPU or memory' })]);
    expect(r.unplaced[0].pod.name).toBe('huge');
    expect(r.savingsPerHour).toBeNull();
    expect(r.currency).toBe('CNY');
  });

  test('draining every node: nothing can move', () => {
    const r = simulateDrain([node('a', [pod('p', { cpuCores: 1 })])], ['a']);
    expect(r.unplaced[0].reason).toBe('no other node');
    expect(simulateDrain([node('a', [])], []).savingsPerHour).toBeNull();
  });

  test('GPU pods: memory on one card (HAMi), whole free cards, or a free GPU count', () => {
    const [n412, n788] = topologyNodes;
    // Drain 7-88: r2 (30000 MiB) and qwen (16000) fit on 4-12's two empty
    // cards; embed-worker (14000) and reranker (12000) share the remaining room.
    const r = simulateDrain(topologyNodes, [n788.name]);
    expect(r.unplaced).toEqual([]);
    expect(r.moves.every((m) => m.to === n412.name)).toBe(true);
    const r2 = r.moves.find((m) => m.pod.name === 'llama-70b-r2');
    expect(r2.gpus).toEqual(['no uuid']);
    expect(r.goesWithNode).toEqual(['kube-system/node-exporter-x2']);

    // Whole-GPU pod needs completely free cards.
    const whole = pod('trainer', { gpu: 2, cpuCores: 1 });
    const target = { ...n412, pods: [...n412.pods] };
    expect(simulateDrain([node('src', [whole]), target], ['src']).moves[0].gpus).toEqual(['no uuid', 'no uuid']);
    const three = pod('trainer3', { gpu: 3, cpuCores: 1 });
    expect(simulateDrain([node('src', [three]), target], ['src']).unplaced[0].reason).toBe('no GPU with enough free memory');

    // Fractional across two GPUs.
    const split = pod('split', { gpu: 2, gpuMemMiB: 60000, cpuCores: 1 });
    expect(simulateDrain([node('src', [split]), target], ['src']).moves[0].gpus).toHaveLength(2);
    const tooBig = pod('big', { gpu: 1, gpuMemMiB: 50000, cpuCores: 1 });
    expect(simulateDrain([node('src', [tooBig]), target], ['src']).unplaced).toHaveLength(1);

    // No GPU memory data: count free GPUs.
    const countNode = node('count', [], { gpuCapacity: 2, gpuAllocated: 1 });
    expect(simulateDrain([node('src', [pod('g', { gpu: 1 })]), countNode], ['src']).moves).toHaveLength(1);
    expect(simulateDrain([node('src', [pod('g', { gpu: 2 })]), countNode], ['src']).unplaced).toHaveLength(1);
    expect(simulateDrain([node('src', [pod('m', { gpuMemMiB: 100 })]), countNode], ['src']).moves).toHaveLength(1);
  });

  test('order is stable on ties; nodes without pods or allocatable', () => {
    const nodes = [node('a', [pod('b', { cpuCores: 1 }), pod('a', { cpuCores: 1 })]), node('t', [])];
    expect(simulateDrain(nodes, ['a']).moves.map((m) => m.pod.name)).toEqual(['a', 'b']);
    const bare = { name: 'bare' };
    expect(simulateDrain([bare, node('t', [])], ['bare']).moves).toEqual([]);
    expect(simulateDrain([node('src', [pod('p', { cpuCores: 1 })]), bare], ['src']).unplaced).toHaveLength(1);
  });
});

test('parseDrainParam and the not-modelled list', () => {
  expect(parseDrainParam('a, b,,c ')).toEqual(['a', 'b', 'c']);
  expect(parseDrainParam('')).toEqual([]);
  expect(parseDrainParam(null)).toEqual([]);
  expect(NOT_MODELLED).toContain('PodDisruptionBudgets');
});

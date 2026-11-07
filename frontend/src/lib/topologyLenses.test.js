import { describe, test, expect } from 'vitest';
import {
  LENSES,
  LENS_IDS,
  NO_DATA,
  nodeFullness,
  nodeAgeHours,
  servingByNode,
  disruptionsByNode,
  lensContext,
  lensColor,
  lensLegend,
  tileSize,
  groupNodes,
} from './topologyLenses';
import { topologyNodes, allServingPods, servingPods } from '../test/fixtures';

const [n412, n788] = topologyNodes;
const NOW = new Date('2026-11-07T10:00:00Z').getTime();

describe('nodeFullness', () => {
  test('requests over allocatable for CPU, memory and GPU memory', () => {
    const f = nodeFullness(n412);
    expect(f.cpu).toBeCloseTo(16.1 / 47);
    expect(f.memory).toBeCloseTo(128.2 / 370);
    expect(f.gpu).toBeCloseTo(92000 / 184000);
    expect(f.max).toBeCloseTo(0.5);
  });

  test('GPU count when memory is unknown; nulls when allocatable is unknown; capped at 1', () => {
    expect(nodeFullness({ gpuCapacity: 4, gpuAllocated: 3, pods: [] }).gpu).toBe(0.75);
    expect(nodeFullness({ pods: [] })).toEqual({ cpu: null, memory: null, gpu: null, max: null });
    expect(nodeFullness({ cpuUsage: { allocatable: 1 }, pods: [{ requests: { cpuCores: 3 } }] }).cpu).toBe(1);
  });
});

test('nodeAgeHours', () => {
  expect(nodeAgeHours(n412, NOW)).toBeCloseTo(4 * 24);
  expect(nodeAgeHours({}, NOW)).toBeNull();
  expect(nodeAgeHours({ creationTime: 'nope' }, NOW)).toBeNull();
  expect(nodeAgeHours({ creationTime: '2026-11-08T00:00:00Z' }, NOW)).toBe(0);
  expect(typeof nodeAgeHours(n412)).toBe('number');
});

describe('servingByNode and disruptionsByNode', () => {
  test('the worst serving status per node, with every serving pod listed', () => {
    const m = servingByNode(allServingPods);
    expect(m.get('ip-10-0-7-88')).toEqual(expect.objectContaining({ label: 'Slow', tone: 'orange' }));
    expect(m.get('ip-10-0-7-88').pods).toEqual(['llm/llama-70b-r2', 'llm/qwen3-8b-0']);
    expect(m.get('ip-10-0-4-12').label).toBe('OK');
    const withOffline = servingByNode([...allServingPods, servingPods.offline, { ...servingPods.r1, node: '' }]);
    expect(withOffline.get('ip-10-0-4-12').label).toBe('offline');
    expect(servingByNode().size).toBe(0);
  });

  test('disruptions by node: blocked wins, reasons carry over', () => {
    const m = disruptionsByNode([
      { nodeName: 'a', reason: 'drift' },
      { nodeName: 'a', isBlocked: true, blockingReason: 'PDB' },
      { nodeName: 'b' },
      { reason: 'orphan' },
    ]);
    expect(m.get('a')).toEqual({ blocked: true, reason: 'drift', blockingReason: 'PDB' });
    expect(m.get('b')).toEqual({ blocked: false, reason: 'disruption', blockingReason: '' });
    expect(m.size).toBe(2);
    expect(disruptionsByNode().size).toBe(0);
  });
});

describe('lensColor', () => {
  const ctx = lensContext(
    [{ ...n412, costPerHour: 2.5, pricedAs: 'spot' }, { ...n788, costPerHour: 10 }],
    { servingPods: allServingPods, disruptions: [{ nodeName: 'ip-10-0-7-88', reason: 'drift' }], now: NOW },
  );

  test('requests: the tightest resource sets the colour', () => {
    const c = lensColor('requests', n412, ctx);
    expect(c.value).toBe('50%');
    expect(c.title).toBe('Requested: CPU 34%, memory 35%, GPU 50%');
    expect(lensColor('requests', { pods: [] }, ctx).fill).toBe(NO_DATA);
    expect(lensColor('unknown-lens', n412, ctx).value).toBe('50%');
  });

  test('capacity type', () => {
    expect(lensColor('capacity', n412, ctx).value).toBe('spot');
    expect(lensColor('capacity', n788, ctx).value).toBe('on-demand');
    expect(lensColor('capacity', {}, ctx).fill).toBe(NO_DATA);
  });

  test('age buckets', () => {
    expect(lensColor('age', n412, ctx).value).toBe('4d');
    expect(lensColor('age', { creationTime: '2026-11-07T09:30:00Z' }, ctx).value).toBe('30m');
    expect(lensColor('age', { creationTime: '2026-11-06T20:00:00Z' }, ctx).value).toBe('14h');
    expect(lensColor('age', {}, ctx).fill).toBe(NO_DATA);
  });

  test('cost, relative to the most expensive node in view', () => {
    const cheap = lensColor('cost', { costPerHour: 2.5, pricedAs: 'spot' }, ctx);
    const dear = lensColor('cost', { costPerHour: 10 }, ctx);
    expect(cheap.value).toBe('$2.50/h');
    expect(cheap.title).toContain('spot, estimated');
    expect(cheap.fill).not.toBe(dear.fill);
    expect(lensColor('cost', {}, ctx).fill).toBe(NO_DATA);
    const cny = lensContext([{ costPerHour: 3 }], { currency: 'CNY' });
    expect(lensColor('cost', { costPerHour: 3 }, cny).value).toBe('CN¥3.00/h');
    expect(lensColor('cost', { costPerHour: 0 }, lensContext([{ costPerHour: 0 }])).value).toBe('$0.00/h');
  });

  test('serving health and disruption', () => {
    expect(lensColor('serving', n788, ctx).value).toBe('Slow');
    expect(lensColor('serving', { name: 'x' }, ctx).fill).toBe(NO_DATA);
    expect(lensColor('serving', n788, lensContext([])).fill).toBe(NO_DATA);
    expect(lensColor('disruption', n788, ctx)).toEqual(expect.objectContaining({ value: 'drift' }));
    expect(lensColor('disruption', n412, ctx).value).toBe('none');
    const blocked = lensContext([], { disruptions: [{ nodeName: 'n', isBlocked: true, reason: 'drift', blockingReason: 'PDB' }] });
    expect(lensColor('disruption', { name: 'n' }, blocked).title).toBe('Disruption blocked (drift: PDB)');
    const blockedNoReason = lensContext([], { disruptions: [{ nodeName: 'n', isBlocked: true }] });
    expect(lensColor('disruption', { name: 'n' }, blockedNoReason).title).toBe('Disruption blocked (disruption)');
  });
});

test('every lens has a legend', () => {
  expect(LENS_IDS).toEqual(LENSES.map((l) => l.id));
  [...LENS_IDS, 'other'].forEach((id) => expect(lensLegend(id).length).toBeGreaterThan(1));
});

test('tileSize scales area with CPU', () => {
  expect(tileSize({ cpuUsage: { allocatable: 48 } }, 48)).toBe(56);
  expect(tileSize({ cpuUsage: { allocatable: 12 } }, 48)).toBe(39);
  expect(tileSize({}, 48)).toBe(22);
  expect(tileSize({ cpuUsage: { allocatable: 4 } }, 0)).toBe(22);
});

test('groupNodes: NodePool, then zone, sorted', () => {
  const g = groupNodes([
    { name: 'b', nodePool: 'p', zone: 'z2' },
    { name: 'a', nodePool: 'p', zone: 'z1' },
    { name: 'c', nodePool: 'p', zone: 'z1' },
    { name: 'd' },
  ]);
  expect(g.map((x) => x.pool)).toEqual(['(no NodePool)', 'p']);
  expect(g[1].zones.map((z) => [z.zone, z.nodes.map((n) => n.name)])).toEqual([
    ['z1', ['a', 'c']],
    ['z2', ['b']],
  ]);
  expect(g[1].count).toBe(3);
  expect(g[0].zones[0].zone).toBe('(no zone)');
});

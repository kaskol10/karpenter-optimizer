import { describe, test, expect } from 'vitest';
import {
  diffSummary,
  diffTopology,
  eventMarkers,
  eventText,
  formatAgo,
  formatClock,
  markerTone,
  parseAtParam,
  withChanges,
} from './topologyHistory';
import { topologyNodes } from '../test/fixtures';

const T = 1762484400; // a Unix time; tests pass "now" explicitly

describe('parseAtParam', () => {
  test.each([
    ['1762484400', 1762484400],
    ['', null],
    [null, null],
    [undefined, null],
    ['abc', null],
    ['-5', null],
    ['1.5', null],
  ])('%s → %s', (value, want) => expect(parseAtParam(value)).toBe(want));
});

describe('time labels', () => {
  test('formatClock shows HH:MM today and the weekday otherwise', () => {
    const d = new Date(2026, 10, 7, 3, 5);
    const at = d.getTime() / 1000;
    expect(formatClock(at, d.getTime() + 3600e3)).toBe('03:05');
    expect(formatClock(at, d.getTime() + 2 * 86400e3)).toMatch(/^\S+ 03:05$/);
  });

  test.each([
    [10, 'just now'],
    [14 * 60, '14 min ago'],
    [120 * 60, '2 h ago'],
    [185 * 60, '3 h 5 min ago'],
    [-30, 'just now'],
  ])('formatAgo %ss back → %s', (secs, want) => expect(formatAgo(T - secs, T * 1000)).toBe(want));
});

describe('eventText', () => {
  test('launches, terminations with reason and pods, and moves', () => {
    expect(eventText({ type: 'node-added', node: 'n1', instanceType: 'g6e.xlarge', capacityType: 'spot', nodePool: 'gpu' })).toBe(
      'n1 launched (g6e.xlarge, spot) in gpu',
    );
    expect(eventText({ type: 'node-added', node: 'n1' })).toBe('n1 launched');
    expect(eventText({ type: 'node-removed', node: 'n2', reason: 'Underutilized', pods: 3 })).toBe('n2 removed: Underutilized · 3 pods');
    expect(eventText({ type: 'node-removed', node: 'n2', pods: 1, nodePool: 'cpu' })).toBe('n2 removed · 1 pod in cpu');
    expect(eventText({ type: 'pod-moved', pod: 'llm/a-0', from: 'n1', to: 'n2' })).toBe('llm/a-0 moved n1 → n2');
    expect(eventText({ type: 'other' })).toBe('other');
  });
});

describe('eventMarkers', () => {
  const iso = (secs) => new Date(secs * 1000).toISOString();
  test('buckets events along the range, counting each kind', () => {
    const events = [
      { type: 'node-added', at: iso(T + 10) },
      { type: 'node-removed', at: iso(T + 20) },
      { type: 'pod-moved', at: T + 3590 },
      { type: 'node-added', at: iso(T - 100) }, // outside
    ];
    const markers = eventMarkers(events, T, T + 3600, 10);
    expect(markers).toHaveLength(2);
    expect(markers[0]).toEqual(expect.objectContaining({ pos: 0.05, at: T + 20, added: 1, removed: 1, moved: 0 }));
    expect(markers[1]).toEqual(expect.objectContaining({ pos: 0.95, moved: 1 }));
    expect(markerTone(markers[0])).toBe('bg-red-500');
    expect(markerTone(markers[1])).toBe('bg-amber-500');
    expect(markerTone({ added: 1, removed: 0 })).toBe('bg-emerald-500');
  });

  test('empty input or range gives no markers', () => {
    expect(eventMarkers([], T, T + 1)).toEqual([]);
    expect(eventMarkers(undefined, T, T + 1)).toEqual([]);
    expect(eventMarkers([{ type: 'node-added', at: T }], T, T)).toEqual([]);
  });

  test('an event at the end of the range lands in the last bucket', () => {
    expect(eventMarkers([{ type: 'node-added', at: T + 100 }], T, T + 100, 4)[0].pos).toBe(0.875);
  });
});

describe('diffTopology', () => {
  const [a, b] = topologyNodes;
  const pod = (name, extra = {}) => ({ namespace: 'x', name, requests: {}, ...extra });

  test('finds added and removed nodes, moved, new and gone pods', () => {
    const before = [
      { name: 'n1', pods: [pod('stay'), pod('move'), pod('gone')] },
      { name: 'n2', pods: [] },
    ];
    const after = [
      { name: 'n1', pods: [pod('stay')] },
      { name: 'n3', pods: [pod('move'), pod('new')] },
    ];
    const diff = diffTopology(before, after);
    expect(diff.addedNodes).toEqual(['n3']);
    expect(diff.removedNodes.map((n) => n.name)).toEqual(['n2']);
    expect(diff.movedPods).toEqual([{ pod: 'x/move', from: 'n1', to: 'n3' }]);
    expect(diff.podsAdded).toBe(1);
    expect(diff.podsRemoved).toBe(1);
    expect(diffSummary(diff)).toBe('+1 node · −1 node · 1 pod moved · 1 new · 1 gone');
  });

  test('sorts moves and reports GPUs whose largest free slice shrank', () => {
    const tighter = {
      ...b,
      // Two new tenants on the node's two empty cards.
      pods: [
        ...b.pods,
        ...['e', 'f'].map((id, i) => ({
          namespace: 'batch',
          name: `squeeze-${id}`,
          requests: { gpu: 1, gpuMemMiB: 16000 },
          gpuDevices: [{ uuid: `GPU-${id}`, index: 2 + i, memoryMiB: 16000 }],
        })),
      ],
    };
    const diff = diffTopology([a, b], [a, tighter]);
    expect(diff.gpuShrunk).toEqual([{ node: b.name, beforeMiB: 46000, afterMiB: 30000 }]);
    const moved = diffTopology(
      [{ name: 'n1', pods: [pod('b'), pod('a')] }],
      [{ name: 'n2', pods: [pod('b'), pod('a')] }],
    ).movedPods.map((m) => m.pod);
    expect(moved).toEqual(['x/a', 'x/b']);
  });

  test('defaults and no changes', () => {
    const diff = diffTopology();
    expect(diffSummary(diff)).toBe('No placement changes');
    expect(diffTopology([{ name: 'n' }], [{ name: 'n' }]).movedPods).toEqual([]);
  });
});

describe('withChanges', () => {
  test('marks launched nodes and appends removed ones as podless ghosts', () => {
    const nodes = [{ name: 'n1', pods: [] }, { name: 'n3', pods: [] }];
    const diff = { addedNodes: ['n3'], removedNodes: [{ name: 'n2', pods: [{ name: 'p' }] }] };
    expect(withChanges(nodes, diff)).toEqual([
      { name: 'n1', pods: [] },
      { name: 'n3', pods: [], change: 'added' },
      { name: 'n2', pods: [], change: 'removed' },
    ]);
    expect(withChanges(nodes, null)).toBe(nodes);
  });
});

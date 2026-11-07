import { describe, test, expect } from 'vitest';
import { isIssuePoint, issueSince, formatDuration, buildTriage, kubectlCommands } from './servingTriage';
import { placementFromServing } from './servingPlacement';
import { allServingPods, servingPods } from '../test/fixtures';

const ok = (unix, extra = {}) => ({ unix, online: true, waiting: 0, kvCachePercent: 40, preemptions: 10, ...extra });

describe('isIssuePoint', () => {
  test('offline, queued and KV pressure are issues', () => {
    expect(isIssuePoint({ online: false }, null)).toBe(true);
    expect(isIssuePoint(ok(1, { waiting: 2 }), null)).toBe(true);
    expect(isIssuePoint(ok(1, { kvCachePercent: 85 }), null)).toBe(true);
    expect(isIssuePoint(ok(1, { kvCachePercent: null }), null)).toBe(false);
  });

  test('only an increase in the lifetime preemption counter counts', () => {
    expect(isIssuePoint(ok(2, { preemptions: 10 }), ok(1))).toBe(false);
    expect(isIssuePoint(ok(2, { preemptions: 12 }), ok(1))).toBe(true);
    expect(isIssuePoint(ok(2, { preemptions: 12 }), null)).toBe(false);
  });
});

describe('issueSince', () => {
  test('null without history or when the latest sample is healthy', () => {
    expect(issueSince(undefined)).toBeNull();
    expect(issueSince([])).toBeNull();
    expect(issueSince([ok(1, { waiting: 1 }), ok(2)])).toBeNull();
  });

  test('start of the current run of issue samples', () => {
    const points = [ok(100, { waiting: 1 }), ok(160), ok(220, { kvCachePercent: 90 }), { unix: 280, online: false }, ok(340, { preemptions: 15 })];
    expect(issueSince(points)).toBe(220);
  });

  test('preemptions compare with the last online sample, across offline gaps', () => {
    const points = [ok(100), { unix: 160, online: false }, ok(220, { preemptions: 10 })];
    expect(issueSince(points)).toBeNull();
  });

  test('a run back to the first sample', () => {
    expect(issueSince([ok(100, { waiting: 1 }), ok(160, { waiting: 2 })])).toBe(100);
  });
});

describe('formatDuration', () => {
  test.each([
    [-5, '0s'],
    [45, '45s'],
    [720, '12m'],
    [3600, '1h'],
    [3600 + 300, '1h 5m'],
    [86400 * 2, '2d'],
    [86400 * 2 + 3600 * 4, '2d 4h'],
  ])('%s → %s', (secs, text) => expect(formatDuration(secs)).toBe(text));
});

describe('buildTriage', () => {
  const placements = Object.fromEntries(allServingPods.map((p) => [`${p.namespace}/${p.name}`, placementFromServing(p)]));

  test('only replicas that are not OK, worst first, with how long', () => {
    const items = buildTriage([...allServingPods, servingPods.offline], placements, {
      'llm/llama-70b-r2': { points: [ok(1000, { waiting: 1 })] },
    });
    expect(items.map((i) => i.key)).toEqual(['llm/mistral-0', 'llm/llama-70b-r2']);
    expect(items[1].since).toBe(1000);
    expect(items[1].placement).toBe(placements['llm/llama-70b-r2']);
    expect(items[0].since).toBeNull();
  });

  test('empty when everything is fine; defaults for placements and history', () => {
    expect(buildTriage([servingPods.qwen])).toEqual([]);
  });

  test('equal severity sorts by key', () => {
    const a = { ...servingPods.offline, name: 'z' };
    const b = { ...servingPods.offline, name: 'a' };
    expect(buildTriage([a, b]).map((i) => i.key)).toEqual(['llm/a', 'llm/z']);
  });
});

describe('kubectlCommands', () => {
  test('describe and logs, plus the node when scheduled', () => {
    expect(kubectlCommands(servingPods.r2).map((c) => c.command)).toEqual([
      'kubectl -n llm describe pod llama-70b-r2',
      'kubectl -n llm logs llama-70b-r2 --tail=200',
      `kubectl describe node ${servingPods.r2.node}`,
    ]);
    expect(kubectlCommands({ namespace: 'a', name: 'b' })).toHaveLength(2);
  });
});

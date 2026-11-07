import { describe, test, expect } from 'vitest';
import { groupByModel, hasProblem, sortModels, UNKNOWN_MODEL } from './servingModels';
import { placementFromServing } from './servingPlacement';
import { allServingPods, servingPods } from '../test/fixtures';

const placementsFor = (pods) =>
  Object.fromEntries(pods.map((p) => [`${p.namespace}/${p.name}`, placementFromServing(p)]));

describe('groupByModel', () => {
  const groups = groupByModel(allServingPods, placementsFor(allServingPods));
  const llama = groups.find((g) => g.model === servingPods.r1.model);
  const qwen = groups.find((g) => g.model === 'Qwen/Qwen3-8B');

  test('one entry per model with its replicas', () => {
    expect(groups).toHaveLength(2);
    expect(llama.replicas.map((p) => p.name)).toEqual(['llama-70b-r1', 'llama-70b-r2', 'llama-70b-r3']);
    expect(llama.online).toBe(3);
  });

  test('throughput and load add up; latency and KV take the worst replica', () => {
    const online = llama.replicas;
    expect(llama.tokensPerSec).toBeCloseTo(online.reduce((a, p) => a + p.tokensPerSec, 0));
    expect(llama.e2eP95).toBe(Math.max(...online.map((p) => p.e2eP95Seconds)));
    expect(llama.kvMax).toBe(Math.max(...online.map((p) => p.kvCachePercent)));
    expect(llama.running).toBe(online.reduce((a, p) => a + (p.running || 0), 0));
  });

  test('statuses match the cards, neighbours included', () => {
    expect(llama.statuses.get(servingPods.r2).label).toBe('Slow');
    expect(llama.statuses.get(servingPods.r2).reasons.join(' ')).toMatch(/embed-worker-7f9c/);
    expect(hasProblem(llama)).toBe(true);
    expect(hasProblem(qwen)).toBe(false);
  });

  test('pods without a model (offline) group as unknown, with empty metrics', () => {
    const [g] = groupByModel([{ ...servingPods.offline, model: '' }]);
    expect(g.model).toBe(UNKNOWN_MODEL);
    expect(g.online).toBe(0);
    expect(g.tokensPerSec).toBeNull();
    expect(g.e2eP95).toBeNull();
    expect(g.running).toBe(0);
  });
});

describe('sortModels', () => {
  const groups = groupByModel(allServingPods, placementsFor(allServingPods));
  const names = (sortBy) => sortModels(groups, sortBy).map((g) => g.model);

  test('attention puts the troubled model first (and is the default)', () => {
    expect(names('attention')[0]).toBe(servingPods.r1.model);
    expect(names()).toEqual(names('attention'));
    expect(names('bogus')).toEqual(names('attention'));
  });

  test('throughput, requests, queue and name', () => {
    expect(names('throughput')[0]).toBe('Qwen/Qwen3-8B');
    expect(names('name')).toEqual(['meta-llama/Llama-3.3-70B', 'Qwen/Qwen3-8B'].sort((a, b) => a.localeCompare(b)));
    expect(names('requests')).toHaveLength(2);
    expect(names('queue')).toHaveLength(2);
  });

  test('ties fall back to name', () => {
    const a = { model: 'b', worstSeverity: 4, tokensPerSec: null, requestsPerSec: null, running: 0, waiting: 0 };
    const b = { ...a, model: 'a' };
    expect(sortModels([a, b], 'queue').map((g) => g.model)).toEqual(['a', 'b']);
    expect(sortModels([a, b], 'throughput').map((g) => g.model)).toEqual(['a', 'b']);
  });
});

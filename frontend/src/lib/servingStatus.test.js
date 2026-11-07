import { describe, test, expect } from 'vitest';
import { getServingStatus, sortByAttention, SEVERITY } from './servingStatus';
import { allServingPods, servingPods } from '../test/fixtures';

const base = { namespace: 'llm', name: 'r1', model: 'llama', online: true, waiting: 0, preemptions: 0 };
const noisy = {
  node: 'n1',
  precise: true,
  shared: [{ gpu: { label: 'aaaaaaaa' }, neighbours: [{ pod: { namespace: 'batch', name: 'embed-0' } }] }],
  unplaced: [],
};

describe('getServingStatus', () => {
  test('offline pods are red regardless of placement', () => {
    expect(getServingStatus({ ...base, online: false }, [], noisy).label).toBe('offline');
  });

  test('queued requests mark the server busy', () => {
    const s = getServingStatus({ ...base, waiting: 3, e2eP95Seconds: 1 }, []);
    expect(s.label).toBe('Busy');
    expect(s.neighbours).toBeNull();
  });

  test('KV cache over threshold is pressure', () => {
    expect(getServingStatus({ ...base, kvCachePercent: 92, e2eP95Seconds: 1 }, []).label).toBe('Under pressure');
  });

  test('slow relative to a peer serving the same model', () => {
    const me = { ...base, e2eP95Seconds: 6 };
    const peer = { ...base, name: 'r2', e2eP95Seconds: 2 };
    const other = { ...base, name: 'x', model: 'other', e2eP95Seconds: 0.1 };
    expect(getServingStatus(me, [me, peer, other]).label).toBe('Slow');
    expect(getServingStatus({ ...me, e2eP95Seconds: 3 }, [me, peer]).label).toBe('OK');
  });

  test('a troubled server names its GPU neighbours and leads with moving them', () => {
    const me = { ...base, e2eP95Seconds: 6 };
    const peer = { ...base, name: 'r2', e2eP95Seconds: 2 };
    const s = getServingStatus(me, [me, peer], noisy);
    expect(s.label).toBe('Slow');
    expect(s.reasons).toContain('shares aaaaaaaa with batch/embed-0');
    expect(s.fixes[0]).toMatch(/Move the co-located pod off aaaaaaaa/);
    expect(s.neighbours.count).toBe(1);
  });

  test('recent preemptions alone mean pressure, even with KV cache below the threshold', () => {
    const s = getServingStatus({ ...base, preemptions: 90, preemptionsRecent: 2, kvCachePercent: 40, e2eP95Seconds: 1 }, []);
    expect(s.label).toBe('Under pressure');
    expect(s.reasons[0]).toMatch(/2 preemption\(s\) in the last 5 min/);
  });

  test('a lifetime preemption count with none recently is not pressure', () => {
    expect(getServingStatus({ ...base, preemptions: 90, preemptionsRecent: 0, e2eP95Seconds: 1 }, []).label).toBe('OK');
  });

  test('a lifetime count with the recent rate still unknown (first probe) is not pressure', () => {
    expect(getServingStatus({ ...base, preemptions: 90, e2eP95Seconds: 1 }, []).label).toBe('OK');
  });

  test('with no peers, a slow first token is the fallback signal', () => {
    const alone = { ...base, e2eP95Seconds: 9, ttftP95Seconds: 4.2 };
    const s = getServingStatus(alone, [alone]);
    expect(s.label).toBe('Slow');
    expect(s.reasons[0]).toMatch(/first token takes 4\.2s/);
    expect(getServingStatus({ ...alone, ttftP95Seconds: 1 }, [alone]).label).toBe('OK');
  });

  test('a server with no latency data yet is OK with limited data', () => {
    const s = getServingStatus({ ...base }, []);
    expect(s.label).toBe('OK');
    expect(s.limited).toBe(true);
    expect(s.reasons).toEqual(['limited data (first sample)']);
  });

  test('a healthy server sharing a GPU is not flagged', () => {
    const s = getServingStatus({ ...base, e2eP95Seconds: 1 }, [], noisy);
    expect(s.label).toBe('OK');
    expect(s.reasons).toEqual([]);
  });
});

describe('sortByAttention', () => {
  test('puts the worst server first: offline, pressure, busy, slow, then healthy', () => {
    const pressured = { ...servingPods.r3, name: 'llama-70b-r4', kvCachePercent: 95 };
    const busy = { ...servingPods.r3, name: 'llama-70b-r5', waiting: 4 };
    const pods = [...allServingPods, servingPods.offline, pressured, busy];
    expect(sortByAttention(pods).map((p) => p.name)).toEqual([
      'mistral-0',
      'llama-70b-r4',
      'llama-70b-r5',
      'llama-70b-r2',
      'qwen3-8b-0',
      'llama-70b-r1',
      'llama-70b-r3',
    ]);
  });

  test('healthy servers are ordered by throughput, then name', () => {
    const a = { ...servingPods.r1, name: 'b' };
    const b = { ...servingPods.r1, name: 'a' };
    expect(sortByAttention([a, b]).map((p) => p.name)).toEqual(['a', 'b']);
  });

  test('does not mutate its input', () => {
    const pods = [servingPods.r1, servingPods.r2];
    sortByAttention(pods);
    expect(pods.map((p) => p.name)).toEqual(['llama-70b-r1', 'llama-70b-r2']);
  });

  test('every status carries its severity', () => {
    expect(getServingStatus(servingPods.offline, []).severity).toBe(SEVERITY.offline);
    expect(getServingStatus(servingPods.r1, allServingPods).severity).toBe(SEVERITY.ok);
    expect(getServingStatus(servingPods.r2, allServingPods).severity).toBe(SEVERITY.slow);
  });
});

import { getServingStatus } from './servingStatus';

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

  test('a healthy server sharing a GPU is not flagged', () => {
    const s = getServingStatus({ ...base, e2eP95Seconds: 1 }, [], noisy);
    expect(s.label).toBe('OK');
    expect(s.reasons).toEqual([]);
  });
});

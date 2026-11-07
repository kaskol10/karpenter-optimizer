import { describe, test, expect } from 'vitest';
import { buildItems, commandResults, paletteResults, parseCommand, search } from './commandPalette';
import { topologyNodes } from '../test/fixtures';

const servingPods = [
  { namespace: 'llm', name: 'llama-70b-0', model: 'meta-llama/Llama-3.1-70B', backend: 'vllm' },
  { namespace: 'llm', name: 'llama-70b-1', model: 'meta-llama/Llama-3.1-70B', backend: 'vllm' },
  { namespace: 'llm', name: 'mystery-0' },
];
const items = buildItems({ nodes: topologyNodes, servingPods });
const byId = (id) => items.find((i) => i.id === id);
const labels = (list) => list.map((i) => i.label);

describe('buildItems', () => {
  test('pages, actions, nodes, pods, GPUs (once per card) and models', () => {
    expect(byId('page:topology')).toEqual(expect.objectContaining({ hint: 'Cluster', run: { type: 'navigate', page: 'topology' } }));
    expect(byId('action:theme').run).toEqual({ type: 'theme' });
    expect(byId('action:logs').run).toEqual({ type: 'logs', pod: '' });

    const [a] = topologyNodes;
    expect(byId(`node:${a.name}`)).toEqual(
      expect.objectContaining({ kind: 'node', run: { type: 'navigate', page: 'topology', params: { zoom: 'node', at: a.name } } }),
    );
    expect(byId(`node:${a.name}`).hint).toContain(a.nodePool);

    const pod = a.pods.find((p) => p.gpuDevices?.length);
    const key = `${pod.namespace}/${pod.name}`;
    expect(byId(`pod:${key}`)).toEqual(
      expect.objectContaining({ hint: `on ${a.name}`, run: { type: 'navigate', page: 'topology', focus: { node: a.name, pod: key } } }),
    );

    const uuid = pod.gpuDevices[0].uuid;
    const gpus = items.filter((i) => i.kind === 'gpu');
    expect(gpus.filter((g) => g.keywords === uuid)).toHaveLength(1);
    expect(byId(`gpu:${uuid}`).run).toEqual({ type: 'navigate', page: 'topology', params: { zoom: 'gpu', at: a.name, card: uuid } });
    expect(byId(`gpu:${uuid}`).hint).toMatch(/GiB/);

    expect(byId('model:meta-llama/Llama-3.1-70B')).toEqual(
      expect.objectContaining({ hint: '2 replicas · vllm', run: { type: 'navigate', page: 'serving', focus: { pod: 'llm/llama-70b-0' } } }),
    );
    expect(byId('model:mystery-0').hint).toBe('1 replica · serving');
  });

  test('copes with nothing loaded and nodes without pods or GPU memory', () => {
    const bare = buildItems();
    expect(bare.every((i) => i.kind === 'page' || i.kind === 'action')).toBe(true);
    const odd = buildItems({ nodes: [{ name: 'n', pods: [{ namespace: 'a', name: 'b', gpuDevices: [{ uuid: 'GPU-1' }, { index: 1 }] }] }, { name: 'm' }] });
    expect(odd.find((i) => i.kind === 'gpu')).toEqual(expect.objectContaining({ label: 'GPU GPU-1', hint: 'n' }));
    expect(odd.find((i) => i.id === 'node:m').hint).toBe('');
  });
});

describe('search', () => {
  test('empty query lists pages and actions', () => {
    const r = search(items, '  ');
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((i) => i.kind === 'page' || i.kind === 'action')).toBe(true);
  });

  test('prefix beats word prefix beats substring; every word must match', () => {
    expect(labels(search(items, 'topo'))[0]).toBe('Topology');
    expect(labels(search(items, 'llama 70b'))[0]).toBe('meta-llama/Llama-3.1-70B');
    expect(search(items, 'llama zzz')).toEqual([]);
    // Hints count at half weight: "cluster" finds the Cluster pages.
    expect(search(items, 'cluster').map((i) => i.id)).toEqual(expect.arrayContaining(['page:overview', 'page:topology']));
  });

  test('subsequence matches names, but only from three characters', () => {
    const [a] = topologyNodes;
    const compact = a.name.replace(/[^a-z0-9]/gi, '');
    expect(search(items, compact).map((i) => i.id)).toContain(`node:${a.name}`);
    expect(search([{ id: 'x', kind: 'node', label: 'a-b' }], 'ab')).toEqual([]);
  });

  test('ties go to pages and actions, then by name; results are capped', () => {
    const tie = [
      { id: '2', kind: 'pod', label: 'web' },
      { id: '1', kind: 'page', label: 'web' },
      { id: '3', kind: 'pod', label: 'web' },
    ];
    expect(search(tie, 'web').map((i) => i.id)).toEqual(['1', '2', '3']);
    const many = Array.from({ length: 50 }, (_, i) => ({ id: String(i), kind: 'pod', label: `p${i}` }));
    expect(search(many, 'p', 30)).toHaveLength(30);
  });

  test('a UUID found through keywords', () => {
    const gpu = items.find((i) => i.kind === 'gpu');
    expect(search(items, gpu.keywords.slice(-6)).map((i) => i.id)).toContain(gpu.id);
  });
});

describe('commands', () => {
  test('parseCommand only knows its verbs', () => {
    expect(parseCommand('drain ip-1')).toEqual({ verb: 'drain', rest: 'ip-1' });
    expect(parseCommand('LOGS')).toEqual({ verb: 'logs', rest: '' });
    expect(parseCommand('draining')).toBeNull();
    expect(parseCommand('   ')).toBeNull();
  });

  test('drain lists nodes as drain simulations', () => {
    const [a, b] = topologyNodes;
    const all = commandResults(items, 'drain ');
    expect(all.map((i) => i.id)).toEqual([`drain:${a.name}`, `drain:${b.name}`]);
    const one = commandResults(items, `drain ${b.name}`);
    expect(one[0]).toEqual(
      expect.objectContaining({ label: `Simulate draining ${b.name}`, run: { type: 'navigate', page: 'topology', params: { drain: b.name } } }),
    );
  });

  test('logs lists pods as log openers', () => {
    const r = commandResults(items, 'logs llama-70b-r1');
    expect(r[0]).toEqual(expect.objectContaining({ label: 'Logs for llm/llama-70b-r1', run: { type: 'logs', pod: 'llm/llama-70b-r1' } }));
  });

  test('fit sizes the placement planner, with optional replicas', () => {
    expect(commandResults(items, 'fit 40GiB')[0]).toEqual(
      expect.objectContaining({ label: 'Where would 40.0 GiB fit?', run: { type: 'navigate', page: 'topology', params: { fit: '40GiB' } } }),
    );
    expect(commandResults(items, 'fit 24g 3')[0].run.params).toEqual({ fit: '24g', replicas: '3' });
    expect(commandResults(items, 'fit 24g 99')[0].run.params.replicas).toBe('16');
    const hint = commandResults(items, 'fit lots');
    expect(hint).toEqual([expect.objectContaining({ kind: 'hint', run: null })]);
  });

  test('paletteResults uses commands when there is a verb, search otherwise', () => {
    expect(paletteResults(items, 'drain ')[0].kind).toBe('action');
    expect(paletteResults(items, 'Topology')[0].id).toBe('page:topology');
    expect(commandResults(items, 'topology')).toBeNull();
  });
});

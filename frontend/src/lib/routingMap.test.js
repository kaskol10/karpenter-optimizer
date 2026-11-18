import { describe, test, expect } from 'vitest';
import { MAX_PER_COLUMN, breakdown, buildRoutingMap, highlight, hostOf, isNoTeam, layout, sharedPrefix } from './routingMap';

const route = (over) => ({
  team: 'Backend',
  key: 'questions',
  alias: 'empathyai/Qwen/Qwen3.5-9B',
  modelGroup: 'empathyai/Qwen/Qwen3.5-9B',
  deployment: 'Qwen/Qwen3.5-9B',
  apiBase: 'https://vllm.office-prod.empathy.ai/v1',
  provider: 'hosted_vllm',
  requests: 100,
  failures: 0,
  ...over,
});

const group = { model: 'Qwen/Qwen3.5-2B', online: 1, replicas: [{}, {}], kvMax: 91, waiting: 3 };

const data = {
  routes: [
    route({}),
    route({ modelGroup: 'together/Qwen3.5-9B', deployment: 'together_ai/Qwen3.5-9B', apiBase: 'https://api.together.xyz/v1', provider: 'together_ai', requests: 14 }),
    route({ team: 'Search', key: 'search-api', alias: 'empathyai/Qwen/Qwen3.5-2B', modelGroup: 'empathyai/Qwen/Qwen3.5-2B', deployment: 'Qwen/Qwen3.5-2B', apiBase: 'http://qwen-2b.llm:8000/v1', requests: 40, failures: 4 }),
    route({ team: 'None', key: '', alias: 'empathyai/Qwen/Qwen3.5-2B', modelGroup: 'empathyai/Qwen/Qwen3.5-2B', deployment: 'Qwen/Qwen3.5-2B', apiBase: 'http://qwen-2b.llm:8000/v1', requests: 5 }),
    route({ deployment: 'Qwen/Qwen3.5-9B', apiBase: 'https://vllm.office-prod.empathy.ai/v1/chat/completions', requests: 50 }),
  ],
  deployments: [
    { model: 'Qwen/Qwen3.5-9B', apiBase: 'https://vllm.office-prod.empathy.ai/v1', provider: 'hosted_vllm', state: 2 },
    { model: 'Qwen/Qwen3.5-2B', apiBase: 'http://qwen-2b.llm:8000/v1', provider: 'hosted_vllm', state: 1 },
    { model: 'openai/gpt-4o', apiBase: '', provider: 'openai', state: 0 },
  ],
  teams: [
    { team: 'Backend', throttled: 31, budgetRemaining: 10, budgetMax: 100 },
    { team: 'Search', throttled: null, budgetRemaining: 0, budgetMax: 50 },
  ],
  groups: [group],
};

const byId = (map) => new Map(map.columns.flat().map((n) => [n.id, n]));

describe('helpers', () => {
  test('hostOf, isNoTeam, sharedPrefix', () => {
    expect(hostOf('https://vllm.office-prod.empathy.ai/v1')).toBe('vllm.office-prod.empathy.ai');
    expect(hostOf('qwen:8000/v1')).toBe('qwen:8000');
    expect(hostOf('')).toBe('');
    expect(isNoTeam('None')).toBe(true);
    expect(isNoTeam(undefined)).toBe(true);
    expect(isNoTeam('Backend')).toBe(false);
    expect(sharedPrefix(['empathyai/a', 'empathyai/b'])).toBe('empathyai/');
    expect(sharedPrefix(['empathyai/a', 'other/b'])).toBe('');
    expect(sharedPrefix(['a', 'b'])).toBe('');
    expect(sharedPrefix(['empathyai/a'])).toBe('');
    expect(sharedPrefix(['empathyai/', 'empathyai/b'])).toBe('');
  });
});

describe('buildRoutingMap', () => {
  const map = buildRoutingMap(data);
  const n = byId(map);

  test('four columns, the dimmed alias prefix, runs-on kinds', () => {
    expect(map.columns.map((c) => c.length)).toEqual([3, 2, 4, 3]);
    expect(map.prefix).toBe('empathyai/');
    expect(n.get('a:empathyai/Qwen/Qwen3.5-9B')).toEqual(expect.objectContaining({ label: 'Qwen/Qwen3.5-9B', prefix: 'empathyai/' }));
    expect(n.get('c:None').label).toBe('No team');
    const cluster = n.get('r:s:Qwen/Qwen3.5-2B');
    expect(cluster).toEqual(expect.objectContaining({ kind: 'cluster', label: '1/2 vLLM pods', sub: 'KV 91% · 3 waiting' }));
    expect(cluster.flags[0].text).toBe('Replica offline');
    expect(n.get('r:h:api.together.xyz')).toEqual(expect.objectContaining({ kind: 'external', sub: 'external API' }));
    expect(n.get('r:h:vllm.office-prod.empathy.ai')).toEqual(expect.objectContaining({ kind: 'outside', sub: 'outside this cluster' }));
  });

  test('caller flags: throttled, budget, high errors', () => {
    expect(n.get('c:Backend').flags.map((f) => f.text)).toEqual(['31 throttled', 'Budget 90% used']);
    expect(n.get('c:Search').flags).toEqual([
      { text: 'High errors', tone: 'bad' },
      { text: 'Budget 100% used', tone: 'bad' },
    ]);
    expect(n.get('c:Search').fact).toBe('44 req · 9.1% err');
    expect(n.get('c:Search').tone).toBe('bad');
  });

  test('alias flags: split across backends, fallbacks', () => {
    const nine = n.get('a:empathyai/Qwen/Qwen3.5-9B');
    expect(nine.flags.map((f) => f.text)).toEqual(['Split across 2 backends', '9% fallbacks']);
    expect(nine.fact).toBe('164 req');
  });

  test('deployment flags: outage with traffic, partial, fallback only, duplicate', () => {
    const office = n.get('d:Qwen/Qwen3.5-9B|https://vllm.office-prod.empathy.ai/v1');
    expect(office.flags.map((f) => f.text)).toEqual(['Outage, still receiving traffic', 'Duplicate: same model and host']);
    expect(office.state).toBe(2);
    expect(n.get('d:Qwen/Qwen3.5-2B|http://qwen-2b.llm:8000/v1').flags[0]).toEqual({ text: 'Partial outage', tone: 'warn' });
    expect(n.get('d:together_ai/Qwen3.5-9B|https://api.together.xyz/v1').flags).toEqual([{ text: 'Fallback only', tone: '' }]);
  });

  test('links sum per pair; fallback links are their own', () => {
    const fb = map.links.filter((l) => l.fallback);
    expect(fb).toHaveLength(1);
    expect(fb[0]).toEqual(expect.objectContaining({ col: 1, requests: 14 }));
    const callerAlias = map.links.find((l) => l.source === 'c:Backend' && l.target === 'a:empathyai/Qwen/Qwen3.5-9B');
    expect(callerAlias.requests).toBe(164);
  });

  test('by key, idle deployments, outage without traffic', () => {
    const m = buildRoutingMap({ ...data, deployments: [...data.deployments, { model: 'idle/m', apiBase: 'http://x', state: 2 }] }, { byKey: true, idle: true });
    const k = byId(m);
    expect(k.get('c:Backend/questions')).toEqual(expect.objectContaining({ kind: 'key', label: 'questions', sub: 'Backend' }));
    expect(k.get('c:None/').label).toBe('No key');
    expect(k.get('c:None/').sub).toBe('No team');
    expect(k.get('c:Backend/questions').flags).toEqual([]);
    expect(k.get('d:idle/m|http://x')).toEqual(expect.objectContaining({ idle: true, fact: 'No traffic in range' }));
    expect(k.get('d:idle/m|http://x').flags).toEqual([{ text: 'Outage', tone: 'bad' }]);
    expect(k.get('d:openai/gpt-4o|')).toBeTruthy();
  });

  test('a crowded column folds into "N more"', () => {
    const many = Array.from({ length: MAX_PER_COLUMN + 3 }, (_, i) => route({ team: `t${i}`, requests: 100 - i }));
    const m = buildRoutingMap({ routes: many });
    expect(m.columns[0]).toHaveLength(MAX_PER_COLUMN);
    const other = m.columns[0].at(-1);
    expect(other).toEqual(expect.objectContaining({ id: 'o:0', kind: 'other', label: '4 more' }));
    expect(other.requests).toBe(89 + 88 + 87 + 86);
    expect(m.routes.at(-1).path[0]).toBe('o:0');
  });

  test('empty input and big numbers', () => {
    expect(buildRoutingMap({}).columns.flat()).toEqual([]);
    const big = buildRoutingMap({ routes: [route({ requests: 2.5e6 }), route({ team: 'b', requests: 1500 })] });
    expect(byId(big).get('c:Backend').fact).toBe('2.5M req');
    expect(byId(big).get('c:b').fact).toBe('1.5k req');
    const warn = buildRoutingMap({ routes: [route({ requests: 98, failures: 2 })] });
    expect(byId(warn).get('c:Backend').tone).toBe('warn');
  });

  test('provider fallbacks for hosts', () => {
    const m = buildRoutingMap({
      routes: [
        route({ deployment: 'gpt-4o', apiBase: '', provider: 'openai' }),
        route({ team: 'x', deployment: 'local', apiBase: '', provider: 'hosted_vllm' }),
        route({ team: 'y', deployment: 'claude', apiBase: 'https://api.anthropic.com', provider: 'anthropic' }),
      ],
    });
    const k = byId(m);
    expect(k.get('r:h:openai').kind).toBe('external');
    expect(k.get('r:h:hosted_vllm').kind).toBe('outside');
    expect(k.get('r:h:api.anthropic.com').kind).toBe('external');
  });
});

describe('highlight and breakdown', () => {
  const map = buildRoutingMap(data);

  test('highlight lights every path through a node', () => {
    expect(highlight(map, null)).toBeNull();
    const h = highlight(map, 'c:Search');
    expect([...h.nodes].sort()).toEqual(['a:empathyai/Qwen/Qwen3.5-2B', 'c:Search', 'd:Qwen/Qwen3.5-2B|http://qwen-2b.llm:8000/v1', 'r:s:Qwen/Qwen3.5-2B']);
    expect(h.links.size).toBe(3);
    const fb = highlight(map, 'd:together_ai/Qwen3.5-9B|https://api.together.xyz/v1');
    expect([...fb.links].some((k) => k.endsWith('~'))).toBe(true);
  });

  test('breakdown shares by another column', () => {
    const rows = breakdown(map, 'a:empathyai/Qwen/Qwen3.5-9B', 2);
    expect(rows.map((r) => [r.node.label, Math.round(r.share), r.fallback])).toEqual([
      ['Qwen/Qwen3.5-9B', 61, 0],
      ['Qwen/Qwen3.5-9B', 30, 0],
      ['together_ai/Qwen3.5-9B', 9, 14],
    ]);
    expect(breakdown(map, 'nope', 0)).toEqual([]);
  });
});

describe('layout', () => {
  test('boxes per column, centred, and a path per link', () => {
    const map = buildRoutingMap(data);
    const l = layout(map, { width: 1000, nodeW: 200, nodeH: 60, gap: 10, top: 20 });
    expect(l.colX).toEqual([0, 267, 533, 800]);
    expect(l.height).toBe(20 + 4 * 70);
    const alias = l.box.get('a:empathyai/Qwen/Qwen3.5-9B');
    expect(alias).toEqual({ x: 267, y: 20 + 70, w: 200, h: 60 });
    expect(l.links).toHaveLength(map.links.length);
    l.links.forEach((k) => {
      expect(k.d).toMatch(/^M[\d.]+,[\d.]+ C/);
      expect(k.width).toBeGreaterThanOrEqual(1.5);
      expect(k.width).toBeLessThanOrEqual(16);
    });
    expect(layout(buildRoutingMap({})).height).toBe(28 + 86);
  });
});
